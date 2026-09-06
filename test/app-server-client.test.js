import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { delimiter, dirname } from "node:path";
import test from "node:test";

import { AppServerError, CodexAppServerClient } from "../src/app-server-client.js";
import { CodexControlPlane } from "../src/control-plane.js";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  return child;
}

function captureRequests(child, handler) {
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line) handler(JSON.parse(line));
    }
  });
}

test("writer handoff waits for actual process exit", async () => {
  const child = fakeProcess();
  const client = new CodexAppServerClient();
  client.process = child;
  let closed = false;
  const closing = client.close({ waitForExit: true }).then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await closing;
  assert.equal(closed, true);
  assert.equal(client.process, null);
});

test("connect performs handshake and listAgents maps threads", async () => {
  const child = fakeProcess();
  let spawnOptions;
  let initializeParams;
  captureRequests(child, (message) => {
    if (message.method === "initialize") {
      initializeParams = message.params;
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "test" } })}\n`);
    }
    if (message.method === "thread/list") {
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        result: { data: [{ id: "thr_1", cwd: "/repo", status: { type: "idle" } }], nextCursor: null },
      })}\n`);
    }
  });

  const client = new CodexAppServerClient({ spawnProcess: (_command, _args, options) => { spawnOptions = options; return child; } });
  const control = new CodexControlPlane(client);
  await control.connect();
  const result = await control.listAgents();
  assert.equal(result.agents[0].id, "thr_1");
  assert.equal(result.agents[0].provider, "codex");
  assert.equal(result.agents[0].status, "idle");
  assert.equal(spawnOptions.env.CODEX_DATA_PLANE_NODE, process.execPath);
  assert.equal(spawnOptions.env.PATH.split(delimiter)[0], dirname(process.execPath));
  assert.equal(initializeParams.capabilities.experimentalApi, true);
  assert.equal(client.experimentalApiEnabled, true);
  await client.close();
});

test("connect falls back to the stable API when an older App Server rejects experimental capabilities", async () => {
  const child = fakeProcess();
  const initializeParams = [];
  captureRequests(child, (message) => {
    if (message.method !== "initialize") return;
    initializeParams.push(message.params);
    if (initializeParams.length === 1) {
      child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32602, message: "unknown field capabilities" } })}\n`);
    } else {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "legacy" } })}\n`);
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.connect();
  assert.equal(initializeParams.length, 2);
  assert.equal(initializeParams[0].capabilities.experimentalApi, true);
  assert.equal(initializeParams[1].capabilities, undefined);
  assert.equal(client.experimentalApiEnabled, false);
  await client.close();
});

test("agent archive and unarchive use distinct App Server lifecycle methods", async () => {
  const child = fakeProcess();
  const methods = [];
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (["thread/archive", "thread/unarchive"].includes(message.method)) {
      methods.push(message.method);
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thr_archive" } } })}\n`);
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  assert.equal((await control.archiveAgent("thr_archive")).id, "thr_archive");
  assert.equal((await control.unarchiveAgent("thr_archive")).id, "thr_archive");
  assert.deepEqual(methods, ["thread/archive", "thread/unarchive"]);
  await client.close();
});

test("runTask collects streamed output until the matching turn completes", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "turn/start") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_1" } } })}\n`);
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thr_1", delta: "hello" } })}\n`);
        child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thr_1", turnId: "turn_1", item: { id: "cmd_1", type: "commandExecution", command: "node --test", exitCode: 0 } } })}\n`);
        child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } })}\n`);
      });
    }
  });

  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const result = await control.runTask("thr_1", "say hello", { timeoutMs: 1_000, evidenceHydrationTimeoutMs: 5 });
  assert.equal(result.output, "hello");
  assert.equal(result.turn.status, "completed");
  assert.equal(result.executionItems[0].exitCode, 0);
  await client.close();
});

test("runTask hydrates the terminal Turn so a missed failed command cannot become success", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "turn/start") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_missed_failure" } } })}\n`);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_missed_failure", status: "completed" } } })}\n`));
    }
    if (message.method === "thread/read") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { turns: [{
        id: "turn_missed_failure", status: "completed", output: "done",
        items: [{ id: "cmd_failed", type: "commandExecution", command: "node --test", exitCode: 1, status: "completed" }],
      }] } } })}\n`);
    }
  });

  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const result = await control.runTask("thr_1", "run tests", { timeoutMs: 1_000 });
  assert.equal(result.evidenceComplete, true);
  assert.equal(result.executionItems[0].exitCode, 1);
  assert.equal(result.completionMethod, "turn/completed+thread/read");
  await client.close();
});

test("concurrent turns on one thread collect only their turn-scoped deltas", async () => {
  const child = fakeProcess();
  let starts = 0;
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method !== "turn/start") return;
    starts += 1;
    const turnId = `turn_${starts}`;
    child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: turnId } } })}\n`);
    if (starts === 2) {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thr_shared", turnId: "turn_2", delta: "second" } })}\n`);
        child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thr_shared", turnId: "turn_1", delta: "first" } })}\n`);
        child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thr_shared", turn: { id: "turn_2", status: "completed" } } })}\n`);
        child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thr_shared", turn: { id: "turn_1", status: "completed" } } })}\n`);
      });
    }
  });

  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const [first, second] = await Promise.all([
    control.runTask("thr_shared", "first", { timeoutMs: 1_000, evidenceHydrationTimeoutMs: 5 }),
    control.runTask("thr_shared", "second", { timeoutMs: 1_000, evidenceHydrationTimeoutMs: 5 }),
  ]);
  assert.equal(first.output, "first");
  assert.equal(second.output, "second");
  await client.close();
});

test("runTask forwards an explicit workspace-write network policy", async () => {
  const child = fakeProcess();
  let turnStartParams;
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "turn/start") {
      turnStartParams = message.params;
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_network" } } })}\n`);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thr_network", turn: { id: "turn_network", status: "completed" } } })}\n`));
    }
  });

  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const sandboxPolicy = {
    type: "workspaceWrite",
    writableRoots: ["/repo"],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  const additionalContext = { policy: { kind: "application", value: "Internal execution instructions" } };
  await control.runTask("thr_network", "run integration tests", { sandboxPolicy, additionalContext, timeoutMs: 1_000, evidenceHydrationTimeoutMs: 5 });
  assert.deepEqual(turnStartParams.sandboxPolicy, sandboxPolicy);
  assert.deepEqual(turnStartParams.input, [{ type: "text", text: "run integration tests" }]);
  assert.deepEqual(turnStartParams.additionalContext, additionalContext);
  await client.close();
});

test("approval requests are declined by default", async () => {
  const child = fakeProcess();
  const responses = [];
  captureRequests(child, (message) => {
    responses.push(message);
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
  });

  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.connect();
  child.stdout.write(`${JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses.at(-1), { id: 99, result: { decision: "decline" } });
  await client.close();
});

test("app-server error notifications do not crash the daemon EventEmitter", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  let observed;
  client.on("serverError", (value) => { observed = value; });
  await client.connect();
  child.stdout.write(`${JSON.stringify({ method: "error", params: { error: { message: "invalid schema" }, willRetry: false } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.error.message, "invalid schema");
  await client.close();
});

test("approval handler can pause and accept an app-server request", async () => {
  const child = fakeProcess();
  const responses = [];
  let release;
  captureRequests(child, (message) => {
    responses.push(message);
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });
  const client = new CodexAppServerClient({
    spawnProcess: () => child,
    approvalHandler: () => new Promise((resolve) => { release = resolve; }),
  });
  await client.connect();
  child.stdout.write(`${JSON.stringify({ id: 101, method: "item/fileChange/requestApproval", params: { threadId: "thr_1" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.some((message) => message.id === 101 && message.result), false);
  release("accept");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses.at(-1), { id: 101, result: { decision: "accept" } });
  await client.close();
});

test("runTask returns promptly when a turn is interrupted", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "turn/start") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_stop" } } })}\n`);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ method: "turn/interrupted", params: { threadId: "thr_1", turn: { id: "turn_stop", status: "interrupted" } } })}\n`));
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const result = await control.runTask("thr_1", "stop", { timeoutMs: 1_000, evidenceHydrationTimeoutMs: 5 });
  assert.equal(result.turn.status, "interrupted");
  await client.close();
});

test("runTask derives terminal status from the App Server notification method", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "turn/start") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_failed" } } })}\n`);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ method: "turn/failed", params: { threadId: "thr_1", turn: { id: "turn_failed" }, error: { message: "boom" } } })}\n`));
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const result = await control.runTask("thr_1", "fail", { timeoutMs: 1_000, evidenceHydrationTimeoutMs: 5 });
  assert.equal(result.turn.status, "failed");
  assert.equal(result.turn.error.message, "boom");
  assert.equal(result.completionMethod, "turn/failed");
  await client.close();
});

test("runTask recovers a missed terminal notification with thread/read", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "turn/start") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_recovered" } } })}\n`);
    }
    if (message.method === "thread/read") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thr_1", turns: [{ id: "turn_recovered", status: "completed", output: "recovered output" }] } } })}\n`);
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const result = await control.runTask("thr_1", "recover", { timeoutMs: 5 });
  assert.equal(result.turn.status, "completed");
  assert.equal(result.output, "recovered output");
  assert.equal(result.completionMethod, "thread/read-recovery");
  assert.equal(result.recoveredFromRead, true);
  await client.close();
});

test("runTask probes thread/read before the full turn timeout expires", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "turn/start") child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_probe" } } })}\n`);
    if (message.method === "thread/read") child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { turns: [{ id: "turn_probe", status: "completed", output: "probe recovered" }] } } })}\n`);
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  const started = Date.now();
  const result = await control.runTask("thr_1", "probe", { timeoutMs: 5_000, recoveryProbeMs: 5 });
  assert.equal(result.output, "probe recovered");
  assert.ok(Date.now() - started < 1_000);
  await client.close();
});

test("runTask converts an app-server error notification into a scoped turn failure", async () => {
  const child = fakeProcess();
  captureRequests(child, (message) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "turn/start") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_error" } } })}\n`);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ method: "error", params: { threadId: "thr_1", turnId: "turn_error", error: { message: "invalid output schema" } } })}\n`));
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  const control = new CodexControlPlane(client);
  await control.connect();
  await assert.rejects(() => control.runTask("thr_1", "fail safely", { timeoutMs: 1_000 }), /invalid output schema/);
  await client.close();
});

test("resumeAgent coalesces ownership-safe retries for a Desktop-owned idle thread", async () => {
  let attempts = 0;
  let releaseRetry;
  const client = {
    request: async (method, params) => {
      assert.equal(method, "thread/resume");
      assert.equal(params.excludeTurns, true);
      attempts += 1;
      if (attempts === 1) throw new AppServerError("thread native_1 already has an active writer", { code: -32600, method });
      return { thread: { id: "native_1", cwd: "/repo", status: { type: "idle" } } };
    },
  };
  const control = new CodexControlPlane(client, {
    resumeRetryDelaysMs: [1],
    delay: () => new Promise((resolve) => { releaseRetry = resolve; }),
  });
  const first = control.resumeAgent("native_1", { cwd: "/repo" });
  const second = control.resumeAgent("native_1", { cwd: "/repo" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  releaseRetry();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(attempts, 2);
  assert.equal(one.id, "native_1");
  assert.deepEqual(one, two);
});

test("resumeAgent surfaces an active-writer ownership error without stealing or forking", async () => {
  let attempts = 0;
  const client = { request: async (method) => {
    attempts += 1;
    throw new AppServerError("This task is active elsewhere: already has an active writer", { code: -32600, method });
  } };
  const control = new CodexControlPlane(client, { resumeRetryDelaysMs: [0, 0], delay: async () => {} });
  await assert.rejects(control.resumeAgent("native_locked"), (error) => error.code === "THREAD_ACTIVE_WRITER" && error.retryable === true);
  assert.equal(attempts, 3);
});

test("resumeAgent omits experimental fields after stable initialize fallback", async () => {
  let observed;
  const client = {
    experimentalApiEnabled: false,
    request: async (method, params) => {
      assert.equal(method, "thread/resume");
      observed = params;
      return { thread: { id: "legacy_thread", cwd: "/repo", status: { type: "idle" } } };
    },
  };
  const control = new CodexControlPlane(client);
  await control.resumeAgent("legacy_thread", { cwd: "/repo" });
  assert.equal("excludeTurns" in observed, false);
});

test("managed Data Plane threads disable the Control Plane plugin on start, resume, and fork", async () => {
  const requests = [];
  const client = { request: async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: params.threadId ?? `thread_${requests.length}`, cwd: params.cwd ?? "/repo", status: { type: "idle" } } };
  } };
  const control = new CodexControlPlane(client);
  await control.spawnAgent({ cwd: "/repo" });
  await control.resumeAgent("thread_resume", { cwd: "/repo" });
  await control.forkAgent("thread_source", { cwd: "/repo" });
  for (const request of requests) {
    assert.deepEqual(request.params.config.plugins["codex-agent-control-plane@personal"], { enabled: false });
  }
  assert.deepEqual(requests.map((entry) => entry.method), ["thread/start", "thread/resume", "thread/fork"]);
});
