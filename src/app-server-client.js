import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { dataPlaneRuntime } from "./runtime-environment.js";

export class AppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AppServerError";
    this.code = details.code;
    this.data = details.data;
    this.method = details.method;
  }
}

function isExperimentalCapabilityNegotiationError(error) {
  return error?.method === "initialize"
    && [-32600, -32602].includes(Number(error.code))
    && /experimental|capabilit|unknown (?:field|parameter)|invalid params/i.test(String(error.message ?? ""));
}

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexPath = options.codexPath ?? process.env.CODEX_BIN ?? "codex";
    this.cwd = options.cwd ?? process.cwd();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60_000;
    this.approvalDecision = options.approvalDecision ?? "decline";
    this.approvalHandler = options.approvalHandler ?? null;
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.runtime = options.runtime ?? dataPlaneRuntime({ env: options.env, codexPath: this.codexPath });
    this.process = null;
    this.lines = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notificationBacklog = [];
    this.waiters = new Set();
    this.stderr = [];
    this.initialized = false;
    this.requestExperimentalApi = options.experimentalApi ?? true;
    this.experimentalApiEnabled = false;
  }

  async connect() {
    if (this.process) return;

    const child = this.spawnProcess(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.runtime.env,
    });
    this.process = child;
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.#handleLine(line));
    child.stderr?.on("data", (chunk) => {
      const message = chunk.toString();
      this.stderr.push(message);
      this.emit("stderr", message);
    });
    child.once("error", (error) => this.#handleExit(error));
    child.once("exit", (code, signal) => {
      const suffix = this.stderr.join("").trim();
      const message = `Codex app-server exited (code=${code}, signal=${signal})${suffix ? `: ${suffix}` : ""}`;
      this.#handleExit(new AppServerError(message));
    });

    const initializeParams = {
      clientInfo: {
        name: "codex_control_plane",
        title: "Codex Control Plane",
        version: "0.1.0",
      },
    };
    if (this.requestExperimentalApi) {
      try {
        await this.request("initialize", { ...initializeParams, capabilities: { experimentalApi: true } });
        this.experimentalApiEnabled = true;
      } catch (error) {
        if (!isExperimentalCapabilityNegotiationError(error)) throw error;
        await this.request("initialize", initializeParams);
      }
    } else {
      await this.request("initialize", initializeParams);
    }
    this.notify("initialized", {});
    this.initialized = true;
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new AppServerError("Codex app-server is not connected", { method }));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`Timed out waiting for ${method}`, { method }));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.#send({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  respondError(id, code, message, data) {
    this.#send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  waitForNotification(predicate, timeoutMs = this.turnTimeoutMs) {
    const index = this.notificationBacklog.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.notificationBacklog.splice(index, 1);
      return Promise.resolve(message);
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new AppServerError("Timed out waiting for app-server notification"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async close({ waitForExit = false } = {}) {
    if (!this.process) return;
    const child = this.process;
    let exit;
    if (waitForExit && child.exitCode === null && child.signalCode === null) {
      exit = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new AppServerError("App Server writer did not exit", { code: "THREAD_WRITER_RELEASE_TIMEOUT" })), 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!waitForExit) this.process = null;
    this.lines?.close();
    if (child.stdin?.writable) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exit;
    if (this.process === child) this.process = null;
  }

  #send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("protocolError", new AppServerError(`Invalid JSONL from app-server: ${line}`, { data: error }));
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new AppServerError(message.error.message ?? `Request failed: ${pending.method}`, {
          code: message.error.code,
          data: message.error.data,
          method: pending.method,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      void this.#handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      if (message.method === "error") this.emit("serverError", message.params);
      else this.emit(message.method, message.params);
      this.#resolveNotificationWaiter(message);
    }
  }

  async #handleServerRequest(message) {
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      try {
        const decision = this.approvalHandler
          ? await this.approvalHandler(message)
          : this.approvalDecision;
        this.respond(message.id, { decision: decision ?? "decline" });
      } catch (error) {
        this.respond(message.id, { decision: "decline" });
        this.emit("approvalError", error);
      }
      return;
    }

    this.respondError(message.id, -32601, `Unsupported server request: ${message.method}`);
  }

  #resolveNotificationWaiter(message) {
    for (const waiter of this.waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }

    this.notificationBacklog.push(message);
    if (this.notificationBacklog.length > 1_000) this.notificationBacklog.shift();
  }

  #handleExit(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    this.emit("closed", error);
  }
}
