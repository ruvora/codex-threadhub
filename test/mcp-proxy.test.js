import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { McpDaemonProxy } from "../src/mcp-proxy.js";

test("MCP proxy attaches the native requester thread to dashboard opens", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let observed;
  const client = { call: async (method, params) => {
    observed = { method, params };
    return { ok: true };
  } };
  const proxy = new McpDaemonProxy({ input, output, client, requesterThreadId: "control_thread" });
  const response = new Promise((resolve) => output.once("data", (chunk) => resolve(JSON.parse(chunk.toString()))));
  proxy.start();
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } })}\n`);
  assert.deepEqual(await response, { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(observed.params._meta["codex/origin"].threadId, "control_thread");
  proxy.close();
});

test("MCP proxy keeps caller identity input separate from authoritative host origin", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let observed;
  const proxy = new McpDaemonProxy({
    input,
    output,
    requesterThreadId: "ambient_thread",
    client: { call: async (_method, params) => { observed = params; return {}; } },
  });
  const response = new Promise((resolve) => output.once("data", resolve));
  proxy.start();
  input.write(`${JSON.stringify({ id: 2, method: "tools/call", params: { name: "show_agent_dashboard", arguments: { requesterThreadId: "explicit_thread" } } })}\n`);
  await response;
  assert.equal(observed.arguments.requesterThreadId, "explicit_thread");
  assert.equal(observed._meta["codex/origin"].threadId, "ambient_thread");
  proxy.close();
});

test("MCP proxy attaches Control Plane origin identity to dispatch and work navigation reads", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const observed = [];
  const proxy = new McpDaemonProxy({
    input,
    output,
    requesterThreadId: "control_origin",
    requesterTurnId: "turn_origin",
    client: { call: async (_method, params) => { observed.push(params); return {}; } },
  });
  proxy.start();
  const first = new Promise((resolve) => output.once("data", resolve));
  input.write(`${JSON.stringify({ id: 3, method: "tools/call", params: { name: "dispatch_control_request", arguments: { objective: "work", cwd: "/repo" } } })}\n`);
  await first;
  const second = new Promise((resolve) => output.once("data", resolve));
  input.write(`${JSON.stringify({ id: 4, method: "tools/call", params: { name: "list_runs", arguments: { cwd: "/repo" } } })}\n`);
  await second;
  assert.equal(observed[0]._meta["codex/origin"].threadId, "control_origin");
  assert.equal(observed[0]._meta["codex/origin"].turnId, "turn_origin");
  assert.equal(observed[1]._meta["codex/origin"].threadId, "control_origin");
  proxy.close();
});

test('proxy overwrites caller-supplied permission origin with native identity', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let observed;
  const proxy = new McpDaemonProxy({ input, output, requesterThreadId: 'real-parent', requesterTurnId: 'real-turn',
    client: { call: async (_m, params) => { observed = params; return {}; } } });
  proxy.start();
  const response = new Promise(resolve => output.once('data', resolve));
  input.write(JSON.stringify({ id: 5, method: 'tools/call', params: { name: 'prepare_agent_run', _meta: { 'codex/origin': { threadId: 'other-full-access', permissions: { sandbox: 'danger-full-access' } } } } }) + '\n');
  await response;
  assert.deepEqual(observed._meta['codex/origin'], { threadId: 'real-parent', turnId: 'real-turn', source: 'host_environment' });
  proxy.close();
});
