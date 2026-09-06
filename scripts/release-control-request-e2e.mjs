#!/usr/bin/env node
// Real public-entry-point gate: natural-language planning, populated registry,
// worker execution, dependency handoff, completion, and reopen. Not a mock.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/app-server-client.js";
import { CodexControlPlane } from "../src/control-plane.js";
import { OwnedThreadControl } from "../src/owned-thread-control.js";
import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";
import { TERMINAL_RUN_STATUSES } from "../src/domain-states.js";

const root = mkdtempSync(join(tmpdir(), "ruvora-natural-e2e-"));
const direct = process.argv.includes("--direct");
const state = mkdtempSync(join(tmpdir(), "ruvora-natural-state-"));
const registryPath = join(state, "registry.sqlite");
const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
writeFileSync(join(root, "facts.txt"), "alpha=7\nbeta=11\n");
writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test facts.test.js" } }));
writeFileSync(join(root, "facts.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('sum',()=>assert.equal(7+11,18));\n");
git("init", "-b", "main"); git("add", ".");
git("-c", "user.name=Ruvora E2E", "-c", "user.email=e2e@ruvora.local", "commit", "-m", "fixture");
const server = new McpControlServer({ registryPath, sessionWriter: true, schedulerConcurrency: 3, schedulerIntervalMs: 500,
  logger: message => process.stderr.write(`${message}\n`),
  controlFactory: () => {
    const client = new CodexAppServerClient({ codexPath: process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex", cwd: root, turnTimeoutMs: 5 * 60_000 });
    return { client, control: new OwnedThreadControl(client, () => {
      const worker = new CodexAppServerClient({ codexPath: process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex", cwd: root, turnTimeoutMs: 5 * 60_000 });
      return { client: worker, control: new CodexControlPlane(worker) };
    }) };
  },
});
let runId;
try {
  for (let i = 0; i < 120; i++) server.registry.upsertAgent({ id: `imported_${i}`, cwd: root, status: "idle" }, { metadata: { autoRegistered: true } });
  for (let i = 0; i < 95; i++) {
    server.registry.upsertAgent({ id: `historical_${i}`, cwd: root, status: "idle" });
    server.registry.createTask({ id: `historical_task_${i}`, prompt: "Past execution", status: "failed", agentId: `historical_${i}` });
  }
  server.startBackground();
  const accepted = await server.handleRequest({ method: "tools/call", params: { name: "dispatch_control_request", arguments: {
    cwd: root, mode: direct ? "direct" : "orchestrated", role: direct ? "reviewer" : undefined, pin: true, requestKey: `public-entry-${Date.now()}`, name: "Natural request release gate",
    objective: direct ? "Read facts.txt and report alpha, beta, and their sum in Korean. Do not modify files, run tests, or create additional tasks." : "Create exactly four tasks: three independent tasks read alpha from facts.txt, read beta from facts.txt, and run node --test facts.test.js. A fourth review task consumes their daemon-supplied dependency outputs and reports the sum and test verdict. Return substantive evidence in each declared report output. Keep this verification minimal.",
    constraints: ["No project edits, no installations, no external network, no additional Runs. Shared workspace; mutatesWorkspace=false. Test task uses local-runtime with process-execution and temporary-filesystem-write. Other tasks use none. Use shell and filesystem tools. Do not implement fixes, request another Start, or create follow-up tasks."],
    acceptanceCriteria: [direct ? "Report alpha=7, beta=11, sum=18 from facts.txt without editing files." : "All four tasks complete with actual command and upstream evidence; sum is 18 and test passes."],
  } } });
  runId = accepted.structuredContent?.runId;
  assert.ok(runId, JSON.stringify(accepted));
  console.log(JSON.stringify({ runId, root, registryPath }));
  const deadline = Date.now() + 15 * 60_000;
  let run;
  while (Date.now() < deadline) {
    run = server.registry.getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const tasks = server.registry.listTasks({ runId, limit: 20 });
  console.log(JSON.stringify({ status: run.status, failure: run.metadata?.failure, tasks: tasks.map(t => ({ id: t.id, status: t.status, failure: t.metadata?.failure, verdict: t.metadata?.completionVerdict })) }));
  assert.equal(run.status, "completed");
  assert.equal(tasks.length, direct ? 1 : 4);
  assert.ok(tasks.every(t => ["completed", "completed_with_warnings"].includes(t.status) && t.agentId && t.turnId));
  assert.equal(git("status", "--porcelain"), "");
  if (direct) {
    assert.equal(run.metadata.planningMethod, "deterministic_direct");
    assert.equal(tasks[0].attempt, 1);
    assert.equal(tasks[0].claimToken, null);
    const status = await server.handleRequest({ method: "tools/call", params: { name: "get_work_status", arguments: { runId } } });
    assert.equal(status.structuredContent.works[0].pinning.hostAction.arguments.threadId, tasks[0].agentId);
  } else assert.ok(tasks.some(t => t.dependencies.length === 3));
  // Keep the daemon and observer alive: closing them first masks writer leaks.
  const desktop = new CodexAppServerClient({ cwd: root });
  try {
    await desktop.connect();
    for (const task of tasks) {
      const loaded = await desktop.request("thread/resume", { threadId: task.agentId });
      assert.equal(loaded.thread.id, task.agentId);
      const read = await desktop.request("thread/read", { threadId: task.agentId, includeTurns: true });
      const turn = read.thread.turns.find(turn => turn.id === task.turnId);
      assert.equal(turn?.status, "completed");
      assert.ok(turn.items.some(item => item.type === "agentMessage" && item.text?.trim()));
    }
    console.log(JSON.stringify({ desktopHandoff: "pass", threads: tasks.length }));
  } finally { await desktop.close({ waitForExit: true }); }
  await server.close();
  const reopened = new ControlRegistry({ path: registryPath });
  assert.equal(reopened.getRun(runId).status, "completed");
  reopened.close();
  console.log(JSON.stringify({ result: "pass", runId, registryPath, root }));
} finally {
  await server.close().catch(() => {});
  console.log(`Evidence retained at ${state}; fixture ${root}`);
}
