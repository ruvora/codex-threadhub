#!/usr/bin/env node

import readline from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlaneDaemonClient } from "./daemon-client.js";

export class McpDaemonProxy {
  constructor(options = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.client = options.client ?? new ControlPlaneDaemonClient(options);
    this.requesterThreadId = options.requesterThreadId ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID ?? null;
    this.requesterTurnId = options.requesterTurnId ?? process.env.CODEX_TURN_ID ?? null;
    this.lines = null;
  }

  start() {
    this.lines = readline.createInterface({ input: this.input });
    this.lines.on("line", (line) => void this.#handleLine(line));
  }

  close() {
    this.lines?.close();
  }

  async #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (message.id === undefined) return;
    try {
      const params = structuredClone(message.params ?? {});
      if (message.method === "tools/call" && params._meta) delete params._meta["codex/origin"];
      if (message.method === "tools/call" && this.requesterThreadId) {
        params._meta = {
          ...(params._meta ?? {}),
          "codex/origin": { threadId: this.requesterThreadId, turnId: this.requesterTurnId ?? null, source: "host_environment" },
        };
      }
      const result = await this.client.call(message.method, params);
      this.#write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.#write({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  }

  #write(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const proxy = new McpDaemonProxy();
  proxy.start();
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
}
