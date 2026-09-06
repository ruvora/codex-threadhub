#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAppServerClient } from "../src/app-server-client.js";
import { CodexControlPlane } from "../src/control-plane.js";
import { OwnedThreadControl } from "../src/owned-thread-control.js";
import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";

const codexPath = process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const root = mkdtempSync(join(tmpdir(), "ruvora-complex-app-server-e2e-"));
const stateRoot = mkdtempSync(join(tmpdir(), "ruvora-complex-app-server-state-"));
const registryPath = join(stateRoot, "registry.sqlite");
const terminalRuns = new Set(["completed", "failed", "cancelled"]);
let server;
let passed = false;

function git(...args) {
  return execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function waitFor(predicate, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

try {
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(root, "requirements.md"), [
    "# Text toolkit",
    "",
    "Implement two independent modules:",
    "- `slug.js`: export `slugify(value)` using lowercase ASCII words joined by hyphens.",
    "- `words.js`: export `countWords(value)` counting whitespace-separated non-empty words.",
    "- Each module needs focused Node tests.",
    "",
  ].join("\n"));
  git("init", "-b", "main");
  git("config", "user.email", "release-e2e@ruvora.local");
  git("config", "user.name", "Ruvora Release E2E");
  git("add", ".");
  git("commit", "-m", "fixture: text toolkit requirements");

  server = new McpControlServer({
    registryPath,
    sessionWriter: true,
    schedulerConcurrency: 2,
    schedulerIntervalMs: 250,
    logger: (message) => process.stderr.write(`[ruvora-complex-e2e] ${message}\n`),
    controlFactory: () => {
      const client = new CodexAppServerClient({ codexPath, cwd: root, turnTimeoutMs: 15 * 60_000 });
      return { client, control: new OwnedThreadControl(client, () => {
        const worker = new CodexAppServerClient({ codexPath, cwd: root, turnTimeoutMs: 15 * 60_000 });
        return { client: worker, control: new CodexControlPlane(worker) };
      }) };
    },
  });
  server.startBackground();

  const prepared = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "prepare_agent_run",
      arguments: {
        name: "Complex text toolkit E2E",
        cwd: root,
        requestKey: `complex-release-e2e-${Date.now()}`,
        dispatchPath: "orchestrated",
        tasks: [
          {
            key: "slug",
            title: "Implement slug module",
            prompt: "Read requirements.md. Implement only slug.js and slug.test.js. Run the focused test and report concrete evidence.",
            role: "slug-implementer",
            taskKind: "implementation",
            mutatesWorkspace: true,
            sandbox: "workspace-write",
            workspaceMode: "worktree",
            integrationStrategy: "patch",
            routingMode: "new",
            acceptanceCriteria: ["slug.js exports slugify", "focused slug tests pass"],
          },
          {
            key: "words",
            title: "Implement word-count module",
            prompt: "Read requirements.md. Implement only words.js and words.test.js. Run the focused test and report concrete evidence.",
            role: "word-count-implementer",
            taskKind: "implementation",
            mutatesWorkspace: true,
            sandbox: "workspace-write",
            workspaceMode: "worktree",
            integrationStrategy: "patch",
            routingMode: "new",
            acceptanceCriteria: ["words.js exports countWords", "focused word-count tests pass"],
          },
          {
            key: "integration",
            title: "Verify integrated toolkit",
            prompt: "Verify the integrated repository against requirements.md. Run the complete Node test suite as one standalone command using the provided absolute Node path; do not wrap it in shell status variables or combine it with other commands. Do not modify files. Report each module and exact test results.",
            role: "integration-verifier",
            taskKind: "test",
            mutatesWorkspace: false,
            sandbox: "workspace-write",
            workspaceMode: "shared",
            integrationStrategy: "none",
            routingMode: "new",
            dependsOn: ["slug", "words"],
            acceptanceCriteria: ["the complete Node test suite passes", "both required exports are present"],
          },
        ],
      },
    },
  });

  assert.notEqual(prepared.isError, true, prepared.structuredContent?.error);
  assert.equal(prepared.structuredContent.dispatchPath, "orchestrated");
  assert.ok(prepared.structuredContent.orchestrator?.id);
  const runId = prepared.structuredContent.runId;

  await waitFor(() => terminalRuns.has(server.registry.getRun(runId)?.status));
  await waitFor(() => ["completed", "consistency_failed", "failed"].includes(server.registry.getRun(runId)?.metadata?.orchestratorFinalized));

  const run = server.registry.getRun(runId);
  const tasks = server.registry.listTasks({ runId, limit: 20 });
  const byKey = new Map(tasks.map((task) => [task.metadata.key, task]));
  const result = server.registry.getRunResult(runId);
  const events = server.registry.listEvents({ limit: 500 });
  const orchestrationDispatches = server.registry.listTurnDispatches({
    subjectType: "run", subjectId: runId, purpose: "orchestration", limit: 10,
  });

  assert.equal(run.status, "completed");
  assert.equal(run.metadata.orchestratorFinalized, "completed");
  assert.equal(tasks.length, 3);
  for (const task of tasks) {
    assert.equal(task.status, "completed", `${task.metadata.key}: ${task.error ?? task.status}`);
    assert.equal(task.attempt, 1, task.metadata.key);
    assert.equal(task.workerId, null, task.metadata.key);
    assert.equal(task.claimToken, null, task.metadata.key);
  }
  assert.notEqual(byKey.get("slug").agentId, byKey.get("words").agentId);
  assert.ok(byKey.get("integration").dependencies.some((entry) => entry.taskId === byKey.get("slug").id));
  assert.ok(byKey.get("integration").dependencies.some((entry) => entry.taskId === byKey.get("words").id));
  assert.ok(events.some((event) => event.eventType === "task.a2a_handoff_received" && event.entityId === byKey.get("integration").id));
  assert.equal(result.synthesisStatus, "completed");
  assert.equal(result.synthesis.source, "orchestrator");
  assert.match(result.synthesis.text, /slug|word/i);
  assert.deepEqual(orchestrationDispatches.map((dispatch) => dispatch.revision).sort(), [1, 2]);
  assert.ok(orchestrationDispatches.every((dispatch) => dispatch.status === "completed"));
  assert.ok(orchestrationDispatches.every((dispatch) => dispatch.threadId === run.metadata.orchestratorAgentId));
  assert.equal(readFileSync(join(root, "slug.js"), "utf8").includes("slugify"), true);
  assert.equal(readFileSync(join(root, "words.js"), "utf8").includes("countWords"), true);
  execFileSync(process.execPath, ["--test"], { cwd: root, stdio: "pipe" });

  const identities = {
    orchestratorThreadId: run.metadata.orchestratorAgentId,
    orchestratorTurnId: result.synthesis.turnId,
    workers: Object.fromEntries([...byKey].map(([key, task]) => [key, { threadId: task.agentId, turnId: task.turnId }])),
  };

  // Production ownership topology, with the daemon still alive. A shutdown
  // before this check would hide leaked writers on workers or the orchestrator.
  const viewer = new CodexAppServerClient({ codexPath, cwd: root });
  try {
    await viewer.connect();
    for (const threadId of new Set([identities.orchestratorThreadId, ...tasks.map(t => t.agentId)])) {
      const resumed = await viewer.request("thread/resume", { threadId });
      assert.equal(resumed.thread.id, threadId);
      const read = await viewer.request("thread/read", { threadId, includeTurns: true });
      assert.ok(read.thread.turns.some(turn => turn.status === "completed" && turn.items.some(item => item.type === "agentMessage" && item.text?.trim())));
    }
    console.log(JSON.stringify({ ownershipHandoff: "pass", workers: tasks.length, orchestrator: true }));
  } finally { await viewer.close({ waitForExit: true }); }
  await server.close();
  server = null;
  const reopened = new ControlRegistry({ path: registryPath });
  assert.equal(reopened.getRun(runId).status, "completed");
  assert.equal(reopened.getRunResult(runId).synthesisStatus, "completed");
  for (const task of reopened.listTasks({ runId, limit: 20 })) {
    assert.equal(task.workerId, null);
    assert.equal(task.claimToken, null);
    assert.equal(task.heartbeatAt, null);
  }
  reopened.close();

  passed = true;
  process.stdout.write(JSON.stringify({
    result: "pass",
    runId,
    status: run.status,
    dispatchPath: run.metadata.dispatchPath,
    taskCount: tasks.length,
    allAttempts: tasks.map((task) => task.attempt),
    a2aHandoff: true,
    integration: [byKey.get("slug"), byKey.get("words")].map((task) => task.metadata.integration.status),
    synthesis: result.synthesisStatus,
    orchestrationRevisions: orchestrationDispatches.map((dispatch) => dispatch.revision).sort(),
    restartPersistence: true,
    ...identities,
  }, null, 2) + "\n");
} finally {
  await server?.close().catch(() => {});
  if (passed) {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Complex E2E fixture retained for diagnosis: ${root}\n`);
    process.stderr.write(`Complex E2E Registry retained for diagnosis: ${stateRoot}\n`);
  }
}
