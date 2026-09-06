import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpControlServer } from "../src/mcp-server.js";
import { ControlRegistry } from "../src/registry.js";
import { ContextResolver } from "../src/context-resolver.js";
import { compileExecutionContract, contractFingerprint } from "../src/execution-contracts.js";

function fakeServer(control, options = {}) {
  return new McpControlServer({
    controlFactory: () => ({ client: { close: async () => {} }, control }),
    registry: new ControlRegistry({ path: ":memory:" }),
    recoverInterruptedTasks: false,
    ...options,
  });
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

test("MCP initialize advertises tools and safety instructions", async () => {
  const server = fakeServer({ connect: async () => {} });
  const initialized = await server.handleRequest({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const listed = await server.handleRequest({ method: "tools/list" });
  assert.equal(initialized.serverInfo.name, "codex-control-plane");
  assert.match(initialized.instructions, /single Codex thread writer/);
  assert.match(initialized.instructions, /Default to get_work_status/);
  assert.match(initialized.instructions, /dashboards only on explicit request/);
  assert.match(initialized.instructions, /never appends terminal results/);
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "list_agents",
    "archive_agent",
    "unarchive_agent",
    "list_thread_lifecycles",
    "get_thread_budget",
    "upsert_thread_budget",
    "inspect_agent",
    "register_agent_profile",
    "upsert_project_memory",
    "list_project_memories",
    "get_project_context",
    "import_threadgraph_context_pack",
    "delete_project_memory",
    "route_agent",
    "spawn_agent",
    "fork_agent",
    "run_agent_task",
    "dispatch_agent_task",
    "prepare_agent_run",
    "dispatch_control_request",
    "get_run_graph",
    "list_runs",
    "prepare_global_run",
    "list_global_runs",
    "get_global_run",
    "refresh_global_run",
    "cancel_global_run",
    "archive_run",
    "unarchive_run",
    "cancel_run",
    "list_tasks",
    "cancel_task",
    "repair_task_contract",
    "list_worktree_leases",
    "acquire_worktree_lease",
    "release_worktree_lease",
    "list_events",
    "plan_agent_run",
    "revise_agent_plan",
    "list_plans",
    "get_plan",
    "synthesize_run",
    "list_managed_worktrees",
    "cleanup_worktree",
    "recover_managed_worktree",
    "list_role_templates",
    "upsert_role_template",
    "get_desktop_handoff",
    "open_desktop_thread",
    "get_task",
    "get_work_status",
    "get_dashboard_state",
    "get_dashboard_detail",
    "show_work_progress",
    "show_agent_dashboard",
  ]);
});

test("thread budget tools expose immutable revisions and lifecycle counters", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-thread-budget-"));
  const cwd = join(directory, "project");
  mkdirSync(cwd);
  const server = fakeServer({ connect: async () => {} });
  try {
    server.registry.upsertAgent({ id: "budget_agent", cwd, status: "idle" }, { role: "reviewer" });
    const revised = await server.handleRequest({ method: "tools/call", params: { name: "upsert_thread_budget", arguments: {
      cwd, role: "reviewer", policy: { maxProjectThreads: 1, maxRoleThreads: 1, maxLineageForks: 0 },
    } } });
    assert.equal(revised.structuredContent.version, 1);
    const state = await server.handleRequest({ method: "tools/call", params: { name: "get_thread_budget", arguments: { cwd, role: "reviewer", sourceThreadId: "budget_agent" } } });
    assert.equal(state.structuredContent.projectCount, 1);
    assert.equal(state.structuredContent.canCreateRole, false);
    const lifecycle = await server.handleRequest({ method: "tools/call", params: { name: "list_thread_lifecycles", arguments: { role: "reviewer" } } });
    assert.equal(lifecycle.structuredContent.threads[0].threadId, "budget_agent");
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic routing archives an ephemeral one-off worker after its terminal task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-ephemeral-worker-"));
  const cwd = join(directory, "project");
  mkdirSync(cwd);
  const archiveCalls = [];
  let spawnOptions;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async (options) => { spawnOptions = options; return { id: "ephemeral_analysis", cwd, status: "idle", provider: "codex", ephemeral: true }; },
    runTask: async (_id, _prompt, options) => {
      options.onStarted?.({ turnId: "turn_ephemeral" });
      return { output: "analysis complete", turnId: "turn_ephemeral", turn: { status: "completed" } };
    },
    archiveAgent: async (threadId) => { archiveCalls.push(threadId); },
  };
  const server = fakeServer(control);
  try {
    server.registry.upsertThreadBudget({ cwd, role: "analyst", policy: { maxProjectThreads: 0, maxRoleThreads: 0, maxLineageForks: 0 } });
    const response = await server.handleRequest({ method: "tools/call", params: { name: "run_agent_task", arguments: {
      prompt: "inspect the current contract failures", cwd, role: "analyst", taskKind: "analysis", mutatesWorkspace: false,
    } } });
    assert.notEqual(response.isError, true);
    assert.equal(response.structuredContent.mode, "ephemeral_spawned");
    assert.equal(spawnOptions.ephemeral, true);
    assert.deepEqual(archiveCalls, ["ephemeral_analysis"]);
    assert.ok(server.registry.getAgent("ephemeral_analysis").archivedAt);
    assert.equal(server.registry.getThreadLifecycle("ephemeral_analysis").status, "archived");
    assert.equal(response.structuredContent.record.status, "completed");
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare_global_run atomically exposes root and dependent Project Runs through MCP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-global-run-"));
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const interrupts = [];
  const server = fakeServer({
    connect: async () => {},
    interruptTask: async (threadId, turnId) => { interrupts.push({ threadId, turnId }); },
  }, { schedulerConcurrency: 0 });
  try {
    const context = new ContextResolver(server.registry).resolve({ objective: "Coordinate two projects" });
    const response = await server.handleRequest({ method: "tools/call", params: { name: "prepare_global_run", arguments: {
      globalRunId: "mcp_global", requestKey: "mcp-global-request", objective: "Coordinate two projects",
      contextSnapshotId: context.id, contextSnapshotFingerprint: context.fingerprint,
      projectRuns: [
        { id: "mcp_run_a", cwd: projectA, tasks: [{ id: "mcp_task_a", prompt: "Analyze A" }] },
        { id: "mcp_run_b", cwd: projectB, tasks: [{ id: "mcp_task_b", prompt: "Analyze B" }] },
      ],
      authorizationManifests: [projectA, projectB].map((root, index) => ({
        runId: index === 0 ? "mcp_run_a" : "mcp_run_b", allowedRoots: [root], taskKinds: ["analysis"],
        mutatesWorkspace: false, sideEffectPolicies: ["none"], sandboxCeiling: "read-only",
        networkAccess: false, workspaceModes: ["shared"],
      })),
      dependencies: [{ id: "mcp_a_to_b", producerRunId: "mcp_run_a", consumerRunId: "mcp_run_b", condition: "all_success", requiredOutputs: ["report"] }],
    } } });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.globalRun.status, "running");
    assert.equal(response.structuredContent.revision.status, "validated");
    assert.equal(server.registry.getTask("mcp_task_a").status, "queued");
    assert.equal(server.registry.getTask("mcp_task_b").status, "staged");
    const detail = await server.handleRequest({ method: "tools/call", params: { name: "get_global_run", arguments: { globalRunId: "mcp_global" } } });
    assert.equal(detail.structuredContent.dependencies[0].status, "pending");
    assert.equal(detail.structuredContent.memberships.length, 2);
    const activeDispatch = server.registry.createTurnDispatch({
      subjectType: "task", subjectId: "mcp_task_a", purpose: "execution", revision: 1,
      parentRunId: "mcp_run_a", parentTaskId: "mcp_task_a", status: "turn_running",
      promptFingerprint: "prompt-fingerprint", submissionKey: "submission-key",
      threadId: "thread_a", turnId: "turn_a",
    });
    const cancelled = await server.handleRequest({ method: "tools/call", params: { name: "cancel_global_run", arguments: { globalRunId: "mcp_global" } } });
    assert.equal(cancelled.structuredContent.globalRun.status, "cancelled");
    assert.deepEqual(interrupts, [{ threadId: "thread_a", turnId: "turn_a" }]);
    assert.equal(server.registry.getTurnDispatch(activeDispatch.id).status, "cancelling");
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Global Run consumers receive only validated durable cross-project handoff evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-global-handoff-"));
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const prompts = [];
  let nextAgent = 0;
  const control = {
    connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: `global_agent_${++nextAgent}`, status: "idle", provider: "codex" }),
    forkAgent: async (id) => ({ id: `${id}_fork`, status: "idle", provider: "codex", forkedFromId: id }),
    resumeAgent: async (id) => ({ id, status: "idle", provider: "codex" }), nameAgent: async () => {}, pinAgent: async () => {},
    runTask: async (_id, prompt, options = {}) => {
      prompts.push({ prompt, context: options.additionalContext });
      options.onStarted?.({ turnId: `global_turn_${prompts.length}` });
      return { output: prompt.includes("Produce global report") ? "GLOBAL_REPORT" : "consumed", turnId: `global_turn_${prompts.length}`, turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control, { schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  try {
    const context = new ContextResolver(server.registry).resolve({ objective: "Pass a report between projects" });
    server.startBackground();
    await server.handleRequest({ method: "tools/call", params: { name: "prepare_global_run", arguments: {
      globalRunId: "handoff_global", objective: "Pass a report between projects",
      contextSnapshotId: context.id, contextSnapshotFingerprint: context.fingerprint,
      projectRuns: [
        { id: "handoff_run_a", cwd: projectA, tasks: [{ id: "handoff_task_a", prompt: "Produce global report", outputs: ["report"] }] },
        { id: "handoff_run_b", cwd: projectB, tasks: [{ id: "handoff_task_b", prompt: "Consume global report" }] },
      ],
      authorizationManifests: [
        { runId: "handoff_run_a", allowedRoots: [projectA], taskKinds: ["analysis"], mutatesWorkspace: false, sideEffectPolicies: ["none"], sandboxCeiling: "read-only", networkAccess: false, workspaceModes: ["shared"] },
        { runId: "handoff_run_b", allowedRoots: [projectB], taskKinds: ["analysis"], mutatesWorkspace: false, sideEffectPolicies: ["none"], sandboxCeiling: "read-only", networkAccess: false, workspaceModes: ["shared"] },
      ],
      dependencies: [{ id: "durable_report", producerRunId: "handoff_run_a", consumerRunId: "handoff_run_b", requiredOutputs: ["report"], acceptanceCriteria: ["report evidence is attached"] }],
    } } });
    await waitUntil(() => server.registry.getGlobalRun("handoff_global")?.status === "completed");
    const consumer = prompts.find(({ prompt }) => prompt === "Consume global report");
    assert.ok(consumer);
    assert.match(consumer.context.threadhub_handoffs.value, /GLOBAL_REPORT/);
    assert.match(consumer.context.threadhub_handoffs.value, /durable_report/);
    const handoff = server.registry.getCrossProjectHandoff("durable_report");
    assert.equal(handoff.status, "received");
    assert.ok(handoff.receiptHash);
    assert.equal(JSON.stringify(handoff.payload).includes(projectA), false);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repair_task_contract preserves failure history and requeues with a new explicit contract", async () => {
  const server = fakeServer({ connect: async () => {} }, { schedulerConcurrency: 0 });
  const previous = compileExecutionContract({
    key: "repairable",
    taskKind: "implementation",
    mutatesWorkspace: true,
    sandbox: "workspace-write",
    workspaceMode: "shared",
    integrationStrategy: "none",
  });
  server.registry.createTask({
    id: "repairable",
    prompt: "update a file",
    cwd: "/repo",
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    error: "shared workspace is unavailable",
    metadata: {
      executionContract: previous,
      execution: { executionContract: previous },
      failure: { type: "configuration", cause: "shared workspace is unavailable", nextAction: "repair_contract" },
    },
  });

  const response = await server.handleRequest({ method: "tools/call", params: { name: "repair_task_contract", arguments: {
    taskId: "repairable",
    sandbox: "workspace-write",
    workspaceMode: "worktree",
    integrationStrategy: "patch",
  } } });
  const task = response.structuredContent.task;
  assert.equal(response.isError, undefined);
  assert.equal(task.status, "queued");
  assert.equal(task.error, null);
  assert.equal(task.maxAttempts, 2);
  assert.equal(task.metadata.executionContract.workspaceMode, "worktree");
  assert.equal(task.metadata.executionContract.integrationStrategy, "patch");
  assert.notEqual(task.metadata.executionContract.fingerprint, previous.fingerprint);
  assert.equal(task.metadata.contractRevision, 2);
  assert.equal(task.metadata.contractHistory[0].fingerprint, previous.fingerprint);
  assert.equal(task.metadata.priorFailures.length, 1);
  assert.equal(task.metadata.failure, null);
  await server.close();
});

test("invalid persisted contracts fail before claim without consuming an attempt", async () => {
  let controlConnections = 0;
  const server = fakeServer({ connect: async () => { controlConnections += 1; } }, { schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  const contract = compileExecutionContract({ key: "invalid_preclaim", taskKind: "analysis", mutatesWorkspace: false });
  server.registry.createRun({ id: "invalid_run", cwd: "/repo", status: "running" });
  server.registry.createTask({
    id: "invalid_preclaim",
    prompt: "inspect",
    cwd: "/repo",
    metadata: {
      runId: "invalid_run",
      executionContract: { ...contract, fingerprint: "00000000000000000000" },
      execution: { executionContract: { ...contract, fingerprint: "00000000000000000000" } },
    },
  });

  server.startBackground();
  const task = await waitUntil(() => {
    const current = server.registry.getTask("invalid_preclaim");
    return current.status === "failed" ? current : null;
  });
  assert.equal(task.attempt, 0);
  assert.equal(task.workerId, null);
  assert.equal(task.claimToken, null);
  assert.equal(task.metadata.failure.stage, "contract_preflight");
  assert.equal(task.metadata.failure.category, "configuration");
  assert.equal(task.metadata.failure.nextAction, "repair_contract");
  assert.equal(task.metadata.failure.repairable, true);
  assert.equal(task.metadata.failure.executionFingerprint, "00000000000000000000");
  assert.equal(server.registry.getRun("invalid_run").status, "failed");
  assert.equal(controlConnections, 0);
  await server.close();
});

test("persisted unsupported loopback contract is blocked before attempt or connection", async () => {
  let connections = 0;
  const server = fakeServer({ connect: async () => { connections++; } }, { schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  const contract = compileExecutionContract({ key: 'loopback', taskKind: 'test', mutatesWorkspace: false });
  contract.executionCapabilities.push('localhost-listen');
  contract.fingerprint = contractFingerprint(contract);
  try {
    server.registry.createTask({ id: 'loopback', prompt: 'test', cwd: '/repo', metadata: { executionContract: contract, execution: { executionContract: contract } } });
    server.startBackground();
    const task = await waitUntil(() => {
      const current = server.registry.getTask('loopback');
      return current.status === 'failed' ? current : null;
    });
    assert.equal(task.attempt, 0);
    assert.equal(task.claimToken, null);
    assert.equal(task.agentId, null);
    assert.equal(connections, 0);
    assert.equal(task.metadata.failure.code, 'EXECUTION_CONTRACT_UNSUPPORTED_LOCALHOST_SANDBOX');
    assert.equal(task.metadata.failure.retryable, false);
    assert.equal(task.metadata.failure.nextAction, 'repair_contract');
  } finally { await server.close(); }
});

test("external persisted contracts are blocked as non-repairable policy before claim", async () => {
  const server = fakeServer({ connect: async () => { throw new Error("control must not start"); } }, { schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  const valid = compileExecutionContract({ key: "external_preclaim", taskKind: "analysis", mutatesWorkspace: false });
  const external = { ...valid, sideEffectPolicy: "external" };
  external.fingerprint = contractFingerprint(external);
  server.registry.createTask({
    id: "external_preclaim",
    prompt: "change a remote service",
    cwd: "/repo",
    metadata: { executionContract: external, execution: { executionContract: external } },
  });

  server.startBackground();
  const task = await waitUntil(() => {
    const current = server.registry.getTask("external_preclaim");
    return current.status === "blocked_by_policy" ? current : null;
  });
  assert.equal(task.attempt, 0);
  assert.equal(task.metadata.failure.category, "policy");
  assert.equal(task.metadata.failure.nextAction, "manual_authorization");
  assert.equal(task.metadata.failure.repairable, false);
  await server.close();
});

test("post-claim contract validation failure safely terminalizes the claim", async () => {
  let controlConnections = 0;
  const server = fakeServer({ connect: async () => { controlConnections += 1; } }, { schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  const contract = compileExecutionContract({ key: "invalid_after_claim", taskKind: "analysis", mutatesWorkspace: false });
  server.registry.createTask({
    id: "invalid_after_claim",
    prompt: "inspect",
    cwd: "/repo",
    metadata: { executionContract: contract, execution: { executionContract: contract } },
  });
  const claimTask = server.registry.claimTask.bind(server.registry);
  server.registry.claimTask = (...args) => {
    const claimed = claimTask(...args);
    if (!claimed) return claimed;
    return {
      ...claimed,
      metadata: {
        ...claimed.metadata,
        execution: { ...claimed.metadata.execution, executionContract: { ...contract, fingerprint: "00000000000000000000" } },
      },
    };
  };

  server.startBackground();
  const task = await waitUntil(() => {
    const current = server.registry.getTask("invalid_after_claim");
    return current.status === "failed" ? current : null;
  });
  assert.equal(task.attempt, 1);
  assert.equal(task.workerId, null);
  assert.equal(task.claimToken, null);
  assert.equal(task.metadata.failure.stage, "contract_validation");
  assert.equal(controlConnections, 0);
  await server.close();
});

test("agent profiles persist and influence automatic routing", async () => {
  const agents = [
    { id: "backend_1", name: "Backend", cwd: "/repo", status: "notLoaded", provider: "codex" },
    { id: "ui_1", name: "UI", cwd: "/repo", status: "notLoaded", provider: "codex" },
  ];
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents, nextCursor: null }),
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  server.registry.upsertAgent(agents[0]);
  await server.handleRequest({
    method: "tools/call",
    params: {
      name: "register_agent_profile",
      arguments: { threadId: "backend_1", role: "backend", capabilities: ["api", "database"] },
    },
  });
  const routed = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "route_agent",
      arguments: { prompt: "API 데이터베이스를 검토해줘", cwd: "/repo", role: "backend", capabilities: ["api"] },
    },
  });
  assert.equal(routed.structuredContent.decision, "fork");
  assert.equal(routed.structuredContent.selectedAgent.id, "backend_1");
  assert.ok(routed.structuredContent.scoreBreakdown.role > 0);
  assert.equal(routed.structuredContent.confidence.level, "high");
  assert.equal(routed.structuredContent.selectedRequirementMatrix.capabilities.allSatisfied, true);
  assert.equal(routed.structuredContent.provenance.candidateSource, "durable_registry");
});

test("listing agents is registry-only and never wakes App Server", async () => {
  const agents = [
    { id: "existing_1", name: "Existing", cwd: "/repo", status: "notLoaded", provider: "codex" },
    { id: "specialized_1", name: "Specialized", cwd: "/repo", status: "notLoaded", provider: "codex" },
  ];
  let calls = 0;
  const server = fakeServer({
    connect: async () => {},
    listAgents: async () => { calls += 1; return { agents, nextCursor: null }; },
  });
  server.registry.upsertAgent(agents[1], { role: "reviewer", capabilities: ["review"] });

  const listed = await server.handleRequest({
    method: "tools/call",
    params: { name: "list_agents", arguments: { cwd: "/repo" } },
  });

  assert.equal(calls, 0);
  assert.deepEqual(listed.structuredContent.agents.map((agent) => agent.id), ["specialized_1"]);
  assert.equal(listed.structuredContent.source, "registry");
});

test("archive tools filter terminal runs and idle agents without touching active identities", async () => {
  const calls = [];
  const control = {
    connect: async () => {},
    archiveAgent: async (id) => { calls.push(["archive", id]); },
    unarchiveAgent: async (id) => { calls.push(["unarchive", id]); },
  };
  const server = fakeServer(control);
  server.registry.upsertAgent({ id: "idle_archive", cwd: "/repo", status: "idle" });
  server.registry.upsertAgent({ id: "busy_archive", cwd: "/repo", status: "running" });
  server.registry.createRun({ id: "done_archive", cwd: "/repo", status: "completed" });
  server.registry.createRun({ id: "live_archive", cwd: "/repo", status: "running" });
  const archivedAgent = await server.handleRequest({ method: "tools/call", params: { name: "archive_agent", arguments: { threadId: "idle_archive" } } });
  assert.ok(archivedAgent.structuredContent.archivedAt);
  const rejectedAgent = await server.handleRequest({ method: "tools/call", params: { name: "archive_agent", arguments: { threadId: "busy_archive" } } });
  assert.equal(rejectedAgent.isError, true);
  assert.equal(rejectedAgent.structuredContent.code, "ARCHIVE_ACTIVE_AGENT");
  await server.handleRequest({ method: "tools/call", params: { name: "archive_run", arguments: { runId: "done_archive" } } });
  const rejectedRun = await server.handleRequest({ method: "tools/call", params: { name: "archive_run", arguments: { runId: "live_archive" } } });
  assert.equal(rejectedRun.structuredContent.code, "ARCHIVE_ACTIVE_RUN");
  const archived = await server.handleRequest({ method: "tools/call", params: { name: "list_agents", arguments: { cwd: "/repo", scope: "archived" } } });
  const archivedRuns = await server.handleRequest({ method: "tools/call", params: { name: "list_runs", arguments: { cwd: "/repo", scope: "archived" } } });
  assert.deepEqual(archived.structuredContent.agents.map((agent) => agent.id), ["idle_archive"]);
  assert.deepEqual(archivedRuns.structuredContent.runs.map((run) => run.id), ["done_archive"]);
  await server.handleRequest({ method: "tools/call", params: { name: "unarchive_agent", arguments: { threadId: "idle_archive" } } });
  await server.handleRequest({ method: "tools/call", params: { name: "unarchive_run", arguments: { runId: "done_archive" } } });
  assert.deepEqual(calls, [["archive", "idle_archive"], ["unarchive", "idle_archive"]]);
  await server.close();
});

test("task routing provenance and capability/tool matrix persist with scheduler identity", async () => {
  const source = { id: "route_source", name: "Backend", cwd: "/repo", status: "idle", provider: "codex" };
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [source], nextCursor: null }),
    forkAgent: async () => ({ id: "route_worker", cwd: "/repo", status: "idle", provider: "codex", forkedFromId: source.id }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (_id, _prompt, options = {}) => {
      options.onStarted?.({ turnId: "turn_route" });
      return { output: "done", turnId: "turn_route", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control, { instanceId: "daemon_scheduler_1" });
  server.registry.upsertAgent(source, { role: "backend", capabilities: ["api"], metadata: { tools: ["node"] } });
  const result = await server.handleRequest({ method: "tools/call", params: { name: "run_agent_task", arguments: {
    prompt: "implement api", cwd: "/repo", role: "backend", capabilities: ["api"], tools: ["node"], routingMode: "auto",
  } } });
  const task = server.registry.getTask(result.structuredContent.taskId);
  assert.equal(task.routing.provenance.decisionSource, "agent_router");
  assert.equal(task.routing.provenance.taskId, task.id);
  assert.equal(task.routing.selectedRequirementMatrix.capabilities.allSatisfied, true);
  assert.equal(task.routing.assignmentRequirementMatrix.tools.allSatisfied, true);
  assert.deepEqual(task.routing.schedulerIdentity, { type: "daemon_scheduler", instanceId: "daemon_scheduler_1" });
  assert.equal(task.routing.orchestratorSessionIdentity, null);
  const routingDecision = server.registry.listRoutingDecisions({ taskId: task.id })[0];
  assert.equal(task.routing.decisionId, routingDecision.id);
  assert.equal(routingDecision.decision, "fork");
  assert.equal(routingDecision.selectedAgentId, "route_worker");
  assert.ok(routingDecision.evidence.length > 0);
  assert.deepEqual(server.registry.listThreadLineage({ threadId: "route_worker" }).map((entry) => entry.parentThreadId), ["route_source"]);
  await server.close();
});

test("plugin initialization performs no App Server synchronization", async () => {
  let connected = 0;
  const server = fakeServer({
    connect: async () => { connected += 1; },
    listAgents: async () => { throw new Error("must not list"); },
  });
  await server.handleRequest({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(connected, 0);
  assert.deepEqual(server.registry.listAgents(), []);
});

test("a standalone MCP server refuses to become a second Codex thread writer", async () => {
  const server = new McpControlServer({
    registry: new ControlRegistry({ path: ":memory:" }),
    sessionWriter: false,
    recoverInterruptedTasks: false,
  });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "spawn_agent", arguments: { cwd: "/repo" } },
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.code, "DAEMON_SESSION_WRITER_REQUIRED");
  await server.close();
});

test("project memory tools build an auditable context pack", async () => {
  const server = fakeServer({ connect: async () => {} });
  const stored = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "upsert_project_memory",
      arguments: { cwd: "/repo", kind: "decision", title: "API", content: "REST API는 v2 경로를 사용한다", tags: ["api"] },
    },
  });
  const context = await server.handleRequest({
    method: "tools/call",
    params: { name: "get_project_context", arguments: { cwd: "/repo", prompt: "API 경로를 구현해줘", role: "backend" } },
  });
  assert.equal(context.structuredContent.memories[0].id, stored.structuredContent.id);
  assert.ok(context.structuredContent.memories[0].selectionReasons.length > 0);
  assert.equal(server.registry.getMemory(stored.structuredContent.id).lastUsedAt, null);
});

test("ThreadGraph MCP import creates only a project-scoped candidate with provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-threadgraph-pack-"));
  const cwd = join(directory, "project");
  mkdirSync(cwd);
  const pack = JSON.parse(readFileSync(new URL("./fixtures/threadgraph-context-pack-v1-alpha.json", import.meta.url), "utf8"));
  const server = fakeServer({ connect: async () => {} }, {
    threadGraphContextPackValidationOptions: { currentTime: "2026-09-04T02:00:00.000Z" },
  });
  try {
    const rejected = await server.handleRequest({
      method: "tools/call",
      params: { name: "import_threadgraph_context_pack", arguments: { cwd, expectedScopeId: "project:other", pack } },
    });
    assert.equal(rejected.structuredContent.code, "CONTEXT_PACK_SCOPE_MISMATCH");
    assert.equal(server.registry.listContextClaims().length, 0);

    const imported = await server.handleRequest({
      method: "tools/call",
      params: { name: "import_threadgraph_context_pack", arguments: { cwd, expectedScopeId: "project:alpha", pack } },
    });
    assert.equal(imported.structuredContent.decision, "allow");
    assert.equal(imported.structuredContent.claimStatus, "candidate");
    assert.equal(imported.structuredContent.executionAuthority, false);
    const claim = server.registry.getContextClaim(imported.structuredContent.claimId);
    assert.equal(claim.status, "candidate");
    assert.equal(claim.projectId, server.registry.resolveProject(cwd).id);
    assert.equal(server.registry.listContextSnapshots().length, 0);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("run_agent_task forks an existing agent by default", async () => {
  const calls = [];
  const control = {
    connect: async () => calls.push(["connect"]),
    forkAgent: async (id, options) => {
      calls.push(["fork", id, options]);
      return { id: "forked_1" };
    },
    runTask: async (id, prompt) => {
      calls.push(["run", id, prompt]);
      return { output: "done" };
    },
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { threadId: "source_1", prompt: "review" } },
  });
  assert.equal(response.structuredContent.mode, "forked");
  assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "fork", "run"]);
  assert.equal(calls[1][2].sandbox, "read-only");
});

test("run_agent_task injects project context and records its result", async () => {
  let deliveredPrompt = "";
  let deliveredContext;
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "agent_context", cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (id, prompt, options) => {
      deliveredPrompt = prompt;
      deliveredContext = options.additionalContext;
      options.onStarted?.({ turnId: "turn_context" });
      return { output: "v2 구현 완료", turnId: "turn_context", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control);
  server.registry.upsertMemory({ id: "api_decision", cwd: "/repo", kind: "decision", title: "API", content: "v2 API를 사용한다", source: "user" });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { prompt: "API 구현", cwd: "/repo", role: "backend", routingMode: "new" } },
  });
  assert.equal(deliveredPrompt, "API 구현");
  assert.match(deliveredContext.threadhub_project.value, /Authoritative project context/);
  assert.match(deliveredContext.threadhub_project.value, /v2 API를 사용한다/);
  assert.equal(response.structuredContent.contextPack.memories[0].id, "api_decision");
  assert.equal(response.structuredContent.resultMemory.kind, "task_result");
  assert.match(server.registry.getAgent("agent_context").summary, /v2 구현 완료/);
});

test("explicit test execution contracts receive workspace-write with requested network access", async () => {
  let spawnOptions;
  let runOptions;
  const control = {
    connect: async () => {},
    spawnAgent: async (options) => {
      spawnOptions = options;
      return { id: "agent_e2e_network", cwd: "/repo", status: "idle", provider: "codex" };
    },
    runTask: async (_id, _prompt, options) => {
      runOptions = options;
      options.onStarted?.({ turnId: "turn_e2e_network" });
      return { output: "109 tests passed", turnId: "turn_e2e_network", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control);
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { prompt: "run all integration tests", taskKind: "test", mutatesWorkspace: true, networkAccess: true, cwd: "/repo", role: "e2e-regression-tester", routingMode: "new" } },
  });

  assert.notEqual(response.isError, true);
  assert.equal(spawnOptions.sandbox, "workspace-write");
  assert.deepEqual(runOptions.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/repo"],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  await server.close();
});

test("an arbitrary unregistered implementation role executes with the explicit write contract", async () => {
  let spawnOptions;
  const control = {
    connect: async () => {},
    spawnAgent: async (options) => { spawnOptions = options; return { id: "agent_arbitrary_writer", cwd: "/repo", status: "idle", provider: "codex" }; },
    runTask: async (_id, _prompt, options) => {
      options.onStarted?.({ turnId: "turn_arbitrary_writer" });
      return { output: "updated dashboard", turnId: "turn_arbitrary_writer", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control);
  const response = await server.handleRequest({ method: "tools/call", params: { name: "run_agent_task", arguments: {
    prompt: "대시보드 파일 수정", cwd: "/repo", role: "dashboard-frontend-engineer", taskKind: "implementation",
    mutatesWorkspace: true, sandbox: "workspace-write", workspaceMode: "shared", integrationStrategy: "none", routingMode: "new",
  } } });
  assert.notEqual(response.isError, true);
  assert.equal(spawnOptions.sandbox, "workspace-write");
  assert.equal(response.structuredContent.record.metadata.executionContract.taskKind, "implementation");
  await server.close();
});

test("a real mutating Task cannot complete when Agent prose reports success but no workspace change exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-empty-mutation-"));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  writeFileSync(join(root, "source.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "base"]);
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "worker_empty_mutation", cwd: root, status: "idle", provider: "codex" }),
    runTask: async (_id, _prompt, options = {}) => {
      options.onStarted?.({ turnId: "turn_empty_mutation" });
      return { evidenceComplete: true, output: "Implementation completed", turnId: "turn_empty_mutation", turn: { status: "completed", items: [] }, executionItems: [] };
    },
  };
  const server = fakeServer(control);
  try {
    const response = await server.handleRequest({ method: "tools/call", params: { name: "run_agent_task", arguments: {
      prompt: "change source", cwd: root, taskKind: "implementation", mutatesWorkspace: true,
      sandbox: "workspace-write", workspaceMode: "shared", integrationStrategy: "none", routingMode: "new",
    } } });
    assert.equal(response.structuredContent.record.status, "failed");
    assert.ok(response.structuredContent.record.metadata.completionVerdict.missingEvidence.includes("output:workspace-change"));
    assert.equal(response.structuredContent.resultMemory, null);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance criteria keep a task validating until the validator accepts", async () => {
  const transitions = [];
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "worker_validated", cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (_id, _prompt, options) => {
      options.onStarted?.({ turnId: "turn_validated" });
      return { output: "tests: 12 passed", turnId: "turn_validated", turn: { status: "completed" } };
    },
  };
  const resultValidator = {
    validate: async () => {
      transitions.push("validator-called");
      return { decision: "accept", summary: "All tests passed", evidence: ["12 passed"], unmetCriteria: [] };
    },
  };
  const server = fakeServer(control, { resultValidator });
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { prompt: "구현", cwd: "/repo", routingMode: "new", acceptanceCriteria: ["테스트 통과"] } },
  });
  assert.deepEqual(transitions, ["validator-called"]);
  assert.equal(response.structuredContent.record.status, "completed");
  assert.equal(response.structuredContent.record.metadata.validation.decision, "accept");
  assert.equal(response.structuredContent.validation.summary, "All tests passed");
});

test("a completed turn with a non-zero real test command is persisted as failed", async () => {
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "worker_bad_test", cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (_id, _prompt, options) => {
      options.onStarted?.({ turnId: "turn_bad_test" });
      return {
        output: "test run finished",
        turnId: "turn_bad_test",
        turn: { status: "completed" },
        executionItems: [{ id: "cmd_test", type: "commandExecution", command: "node --test", exitCode: 2, status: "completed" }],
      };
    },
  };
  const server = fakeServer(control);
  const response = await server.handleRequest({
    method: "tools/call",
    params: { name: "run_agent_task", arguments: { prompt: "run tests", cwd: "/repo", routingMode: "new" } },
  });
  assert.equal(response.structuredContent.record.status, "failed");
  assert.equal(response.structuredContent.record.metadata.failure.type, "test");
  assert.equal(response.structuredContent.record.metadata.failure.cause, "node --test exited with code 2");
  assert.equal(response.structuredContent.record.metadata.failure.retryable, true);
  assert.equal(response.structuredContent.record.metadata.failure.exhausted, true);
  assert.deepEqual(response.structuredContent.record.metadata.failure.attemptBudget, { used: 1, max: 1, remaining: 0 });
  await server.close();
});

test("missing test exit is persisted as attention with no retry and a released claim", async () => {
  const server=fakeServer({connect:async()=>{},spawnAgent:async()=>({id:'missing-exit-worker',cwd:'/repo',status:'idle',provider:'codex'}),
    runTask:async(_id,_prompt,options)=>{options.onStarted?.({turnId:'missing-exit-turn'});return {turnId:'missing-exit-turn',output:'done',evidenceComplete:true,turn:{status:'completed'},executionItems:[{type:'commandExecution',command:'node --test'}]};}});
  try {
    const response=await server.handleRequest({method:'tools/call',params:{name:'run_agent_task',arguments:{prompt:'run tests',cwd:'/repo',routingMode:'new',taskKind:'test',mutatesWorkspace:false}}});
    assert.notEqual(response.isError,true,response.structuredContent?.error);
    const task=response.structuredContent.record;
    assert.equal(task.status,'recovery_attention');assert.equal(task.claimToken,null);
    assert.equal(task.metadata.failure.retryable,false);assert.equal(task.metadata.failure.nextAction,'inspect_execution_evidence');
  } finally {await server.close();}
});

test("read-only tools are marked read-only", async () => {
  const server = fakeServer({ connect: async () => {} });
  const listed = await server.handleRequest({ method: "tools/list" });
  assert.equal(listed.tools.find((tool) => tool.name === "list_agents").annotations.readOnlyHint, true);
  assert.equal(listed.tools.find((tool) => tool.name === "run_agent_task").annotations.readOnlyHint, false);
});

test("dashboard resource uses the MCP Apps MIME type", async () => {
  const server = fakeServer({ connect: async () => {} });
  const resources = await server.handleRequest({ method: "resources/list" });
  const result = await server.handleRequest({
    method: "resources/read",
    params: { uri: resources.resources[0].uri },
  });
  assert.equal(result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(result.contents[0].text, /작업 목록/);
  assert.match(result.contents[0].text, /data-tab="graph"/);
  assert.match(result.contents[0].text, /Codex 스레드는 플러그인을 실행할 때 자동으로 등록/);
  assert.match(result.contents[0].text, /href="codex:\/\/threads\//);
  assert.match(result.contents[0].text, /graph-board/);
  assert.match(result.contents[0].text, /실행 구조/);
  assert.match(result.contents[0].text, /전체 작업/);
  assert.match(result.contents[0].text, /하위 작업/);
  assert.doesNotMatch(result.contents[0].text, /CONTROL PLANE|DAEMON SCHEDULER|ORCHESTRATOR CODEX THREAD/);
  assert.doesNotMatch(result.contents[0].text, /DATA PLANE/);
  assert.match(result.contents[0].text, /plane-map/);
  assert.match(result.contents[0].text, />작업함</);
  assert.doesNotMatch(result.contents[0].text, /필요할 때만/);
});

test("authorized dashboards can open an existing Codex Desktop task without sending a prompt", async () => {
  const opened = [];
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer({ connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) }, {
    dashboardServer,
    openDesktopThread: async (threadId) => { opened.push(threadId); return { navigated: true }; },
  });
  const shown = await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  const threadId = "01a0534d-7717-7151-bfd7-2d9cb59e8662";
  const result = await server.handleRequest({ method: "tools/call", params: { name: "open_desktop_thread", arguments: {
    dashboardLeaseToken: shown.structuredContent.dashboardLeaseToken,
    threadId,
  } } });
  assert.equal(result.structuredContent.opened, true);
  assert.deepEqual(opened, [threadId]);
  assert.equal(result.structuredContent.url, undefined);
  server.openDesktopThread = async () => undefined;
  const unconfirmed = await server.handleRequest({ method: "tools/call", params: { name: "open_desktop_thread", arguments: {
    dashboardLeaseToken: shown.structuredContent.dashboardLeaseToken, threadId,
  } } });
  assert.equal(unconfirmed.structuredContent.opened, false);

  const rejected = await server.handleRequest({ method: "tools/call", params: { name: "open_desktop_thread", arguments: {
    dashboardLeaseToken: shown.structuredContent.dashboardLeaseToken,
    threadId: "not-a-thread-id",
  } } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.structuredContent.error, /Invalid Codex thread ID/);
  await server.close();
});

test("show_agent_dashboard returns agents and task state", async () => {
  const calls = [];
  let dashboardStarts = 0;
  const control = {
    connect: async () => {},
    listAgents: async (options) => {
      calls.push(options);
      return { agents: [
        { id: "agent_1", cwd: "/repo", status: "idle" },
        { id: "agent_other", cwd: "/another-project", status: "idle" },
      ], nextCursor: null };
    },
  };
  const dashboardServer = { start: async () => { dashboardStarts += 1; }, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  const result = await server.handleRequest({
    method: "tools/call",
    params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } },
  });
  assert.equal(result.structuredContent.agents[0].id, "agent_1");
  assert.equal(result.structuredContent.agents.length, 1);
  assert.equal(calls[0].cwd, "/repo");
  assert.equal(server.registry.getAgent("agent_other").role, "general");
  assert.deepEqual(result.structuredContent.tasks, []);
  assert.equal(result.structuredContent.cwd, "/repo");
  assert.equal(result.structuredContent.dashboardPresentation, "embedded");
  assert.equal(result.structuredContent.dashboardUrl, undefined);
  assert.equal(dashboardStarts, 0, "embedded presentation must not start the local web dashboard");
  assert.equal(result.content.some((item) => item.type === "resource_link"), false);
  assert.equal(result._meta.ui.resourceUri, "ui://codex-control-plane/work-navigator-v10.html");
  assert.equal(result._meta["openai/outputTemplate"], "ui://codex-control-plane/work-navigator-v10.html");
  assert.equal(result._meta["openai/widgetAccessible"], true);

  const web = await server.handleRequest({
    method: "tools/call",
    params: { name: "show_agent_dashboard", arguments: { cwd: "/repo", presentation: "web" } },
  });
  assert.equal(web.structuredContent.dashboardPresentation, "web");
  assert.equal(web.structuredContent.dashboardUrl, "http://127.0.0.1/dashboard");
  assert.equal(dashboardStarts, 1);
  assert.equal(web.content.some((item) => item.type === "resource_link"), true);
  assert.equal(calls.length, 1, "project reconciliation is cached for five minutes");
  await server.close();
});

test("only show_agent_dashboard advertises or returns the output template", async () => {
  const control = {
    connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: "worker_template", cwd: "/repo", status: "idle" }),
    nameAgent: async () => {}, pinAgent: async () => {},
    runTask: async () => ({ output: "READY", turn: { status: "completed" } }),
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  const listed = await server.handleRequest({ method: "tools/list" });
  assert.deepEqual(listed.tools.filter((tool) => tool._meta?.["openai/outputTemplate"]).map((tool) => tool.name), ["show_agent_dashboard"]);
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "dispatch_agent_task", arguments: { prompt: "later", cwd: "/repo", routingMode: "new" } },
  });
  assert.equal(prepared._meta, undefined);
  await server.close();
});

test("dashboard snapshots are lightweight and details load on demand behind a view lease", async () => {
  const control = { connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  server.registry.createRun({ id: "run_light", cwd: "/repo", status: "awaiting_user_start" });
  server.registry.createTask({ id: "task_light", prompt: "a very detailed private prompt", cwd: "/repo", status: "staged", metadata: { runId: "run_light", title: "Summary" } });
  const shown = await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  assert.equal(shown.structuredContent.tasks[0].prompt, undefined);
  assert.equal(shown.structuredContent.graph.nodes[0].prompt, undefined);
  assert.equal(typeof shown.structuredContent.revision, "number");
  const detail = await server.handleRequest({ method: "tools/call", params: { name: "get_dashboard_detail", arguments: {
    dashboardLeaseToken: shown.structuredContent.dashboardLeaseToken, entityType: "task", entityId: "task_light",
  } } });
  assert.equal(detail.structuredContent.detail.prompt, "a very detailed private prompt");
  assert.equal(detail._meta, undefined);
  const revision = shown.structuredContent.revision;
  server.registry.updateTask("task_light", { status: "queued" });
  const delta = await server.handleRequest({ method: "tools/call", params: { name: "get_dashboard_state", arguments: {
    dashboardLeaseToken: shown.structuredContent.dashboardLeaseToken, cwd: "/repo", sinceRevision: revision,
  } } });
  assert.equal(delta.structuredContent.kind, "delta");
  assert.equal(delta.structuredContent.tasks[0].status, "queued");
  assert.equal(delta.structuredContent.agents, undefined);
  await server.close();
});

test("Data Plane and Orchestrator threads cannot open the dashboard", async () => {
  const control = { connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) };
  const server = fakeServer(control);
  server.registry.upsertAgent({ id: "worker_1", cwd: "/repo", status: "idle", metadata: { executionPlane: "data" } });
  const result = await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo", requesterThreadId: "worker_1" } } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, -32003);
  await server.close();
});

test("dashboard falls back to the registered Control Plane owner when the host omits requester identity", async () => {
  const control = { connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer });
  server.registry.upsertAgent({ id: "control_owner", cwd: "/repo", status: "idle", role: "control-plane", metadata: { executionPlane: "control" } });
  server.registry.setSetting("control_plane_owner:/repo", "control_owner");
  const shown = await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  assert.equal(shown.isError, undefined);
  assert.equal(typeof shown.structuredContent.dashboardLeaseToken, "string");
  const lease = server.dashboardViewLeases.get(shown.structuredContent.dashboardLeaseToken);
  assert.equal(lease.requesterThreadId, "control_owner");
  await server.close();
});

test("an authenticated host thread replaces a stale dashboard fallback owner", async () => {
  const control = { connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) };
  const server = fakeServer(control);
  server.registry.upsertAgent({ id: "stale_owner", cwd: "/repo", status: "idle", role: "control-plane", metadata: { executionPlane: "control" } });
  server.registry.upsertAgent({ id: "current_host", cwd: "/repo", status: "idle" });
  server.registry.setSetting("control_plane_owner:/repo", "stale_owner");

  const shown = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "show_agent_dashboard",
      arguments: { cwd: "/repo" },
      _meta: { "codex/origin": { threadId: "current_host", turnId: "current_turn", source: "host_environment" } },
    },
  });

  assert.equal(shown.isError, undefined);
  assert.equal(shown.structuredContent.dashboardPresentation, "embedded");
  assert.equal(server.registry.getSetting("control_plane_owner:/repo"), "current_host");
  assert.equal(server.registry.getAgent("current_host").role, "control-plane");
  assert.equal(server.registry.getAgent("current_host").metadata.executionPlane, "control");
  const lease = server.dashboardViewLeases.get(shown.structuredContent.dashboardLeaseToken);
  assert.equal(lease.requesterThreadId, "current_host");
  const transfer = server.registry.listEvents({ entityType: "agent", entityId: "current_host", limit: 20 })
    .find((event) => event.eventType === "control_plane.owner_transferred");
  assert.equal(transfer.payload.previousOwnerThreadId, "stale_owner");
  assert.equal(transfer.payload.identitySource, "host");
  await server.close();
});

test("legacy caller identity cannot replace an existing dashboard fallback owner", async () => {
  const control = { connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) };
  const server = fakeServer(control);
  server.registry.setSetting("control_plane_owner:/repo", "control_owner");
  const shown = await server.handleRequest({
    method: "tools/call",
    params: { name: "show_agent_dashboard", arguments: { cwd: "/repo", requesterThreadId: "untrusted_caller" } },
  });
  assert.equal(shown.isError, true);
  assert.equal(shown.structuredContent.code, -32003);
  assert.equal(server.registry.getSetting("control_plane_owner:/repo"), "control_owner");
  await server.close();
});

test("project reconciliation is five-minute TTL single-flight", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const control = {
    connect: async () => {},
    listAgents: async () => { calls += 1; await pending; return { agents: [{ id: "once", cwd: "/repo", status: "idle" }], nextCursor: null }; },
  };
  const dashboardServer = { start: async () => {}, url: () => "http://127.0.0.1/dashboard", close: async () => {} };
  const server = fakeServer(control, { dashboardServer, reconciliationTtlMs: 300_000 });
  const first = server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  const second = server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await server.handleRequest({ method: "tools/call", params: { name: "show_agent_dashboard", arguments: { cwd: "/repo" } } });
  assert.equal(calls, 1);
  await server.close();
});

test("prepare_agent_run atomically starts and binds a leased session per task", async () => {
  const calls = [];
  const dashboardServer = {
    start: async () => {},
    url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`,
    close: async () => {},
  };
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "agent_prepared", cwd: "/repo", status: "idle", ephemeral: false }),
    nameAgent: async (id, name) => calls.push(["name", id, name]),
    pinAgent: async (id) => calls.push(["pin", id]),
    runTask: async (id, prompt) => {
      calls.push(["initialize", id, prompt]);
      return { output: "READY", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "prepare_agent_run",
      arguments: {
        name: "검증 작업",
        cwd: "/repo",
        tasks: [{ key: "review", title: "API 검토", prompt: "review", role: "Backend", routingMode: "new" }],
      },
    },
  });
  assert.equal(prepared.structuredContent.status, "running");
  assert.deepEqual(prepared.structuredContent.agents, []);
  assert.equal(server.registry.getRun(prepared.structuredContent.runId).status, "running");
  const completed = await waitUntil(() => server.registry.listTasks({ runId: prepared.structuredContent.runId, limit: 10 })[0]?.status === "completed");
  assert.equal(completed, true);
  const task = server.registry.listTasks({ runId: prepared.structuredContent.runId, limit: 10 })[0];
  assert.equal(task.agentId, "agent_prepared");
  assert.ok(server.registry.getRun(prepared.structuredContent.runId).metadata.orchestrationLog.some((entry) => entry.type === "task_assigned" && entry.taskId === task.id));
  assert.deepEqual(calls.map((entry) => entry[0]), ["name", "initialize"]);
  await server.close();
});

test("complex runs automatically provision an Orchestrator before workers", async () => {
  let sequence = 0;
  const turns = [];
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: `agent_${++sequence}`, cwd: "/repo", status: "idle", ephemeral: false }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (threadId, prompt, options) => {
      turns.push({ threadId, prompt, context: options.additionalContext });
      return { output: "Run accepted; waiting for Data Plane results.", turnId: "turn_kickoff", turn: { id: "turn_kickoff", status: "completed" } };
    },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 0 });
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: {
      name: "복합 기능",
      cwd: "/repo",
      tasks: [
        { key: "build", title: "구현", prompt: "build", role: "implementer", routingMode: "new" },
        { key: "review", title: "검토", prompt: "review", role: "reviewer", dependsOn: ["build"], routingMode: "new" },
      ],
    } },
  });
  assert.equal(prepared.structuredContent.dispatchPath, "orchestrated");
  assert.deepEqual(prepared.structuredContent.orchestrator, { id: "agent_1", type: "codex_session" });
  assert.deepEqual(prepared.structuredContent.agents, []);
  assert.equal(sequence, 1);
  const graph = server.runController.graph(prepared.structuredContent.runId);
  assert.equal(graph.run.orchestrator.id, "agent_1");
  assert.equal(graph.run.complexity.taskCount, 2);
  assert.deepEqual(graph.run.orchestratorSession, { type: "codex_session", agentId: "agent_1" });
  assert.equal(sequence, 1, "automatic start creates only the Orchestrator before workers are scheduled");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].threadId, "agent_1");
  assert.equal(turns[0].prompt, "복합 기능");
  assert.match(turns[0].context.threadhub_policy.value, /results will be collected here/);
  assert.equal(server.registry.getRun(prepared.structuredContent.runId).metadata.orchestratorKickoff.turnId, "turn_kickoff");
  const kickoffDispatch = server.registry.listTurnDispatches({
    subjectType: "run", subjectId: prepared.structuredContent.runId, purpose: "orchestration", limit: 10,
  });
  assert.equal(kickoffDispatch.length, 1);
  assert.equal(kickoffDispatch[0].revision, 1);
  assert.equal(kickoffDispatch[0].status, "completed");
  await server.close();
});

test("daemon never probes unsupported App Server sidebar pin metadata", async () => {
  let sequence = 0;
  let pinCalls = 0;
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: `pin_agent_${++sequence}`, cwd: "/repo", status: "idle", ephemeral: false }),
    nameAgent: async () => {},
    pinAgent: async () => {
      pinCalls += 1;
      throw new Error("thread metadata update must include at least one field");
    },
    runTask: async () => ({ output: "waiting", turnId: `pin_turn_${sequence}`, turn: { id: `pin_turn_${sequence}`, status: "completed" } }),
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 0, logger: () => {} });
  for (const suffix of ["one", "two"]) {
    const response = await server.handleRequest({ method: "tools/call", params: { name: "prepare_agent_run", arguments: {
      name: `pin ${suffix}`,
      cwd: "/repo",
      requestKey: `pin-${suffix}`,
      dispatchPath: "orchestrated",
      tasks: [
        { key: `build-${suffix}`, prompt: "build", role: "implementer", routingMode: "new" },
        { key: `review-${suffix}`, prompt: "review", role: "reviewer", dependsOn: [`build-${suffix}`], routingMode: "new" },
      ],
    } } });
    assert.equal(response.structuredContent.status, "running");
  }
  assert.equal(pinCalls, 0);
  assert.equal(server.registry.listEvents({ limit: 100 }).filter((event) => event.eventType === "agent.pin_unsupported").length, 0);
  await server.close();
});

test("orchestrator kickoff failure terminalizes the prepared graph without consuming task attempts", async () => {
  const upstream = Object.assign(new Error("unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses"), {
    retryable: true,
  });
  const control = {
    connect: async () => {},
    spawnAgent: async () => ({ id: "orchestrator_404", cwd: "/repo", status: "idle", ephemeral: false }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async () => { throw upstream; },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 0 });

  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: {
      name: "kickoff failure",
      cwd: "/repo",
      tasks: [
        { key: "build", prompt: "build", role: "implementer", routingMode: "new" },
        { key: "review", prompt: "review", role: "reviewer", dependsOn: ["build"], routingMode: "new" },
      ],
    } },
  });

  assert.equal(prepared.isError, undefined);
  assert.equal(prepared.structuredContent.status, "failed");
  const run = server.registry.getRun(prepared.structuredContent.runId);
  assert.equal(run.status, "failed");
  assert.equal(run.metadata.failure.stage, "orchestrator_kickoff");
  assert.equal(run.metadata.failure.code, "APP_SERVER_UPSTREAM_404");
  assert.equal(run.metadata.failure.category, "environment");
  assert.equal(run.metadata.failure.nextAction, "retry_run");
  const tasks = server.registry.listTasks({ runId: run.id, limit: 10 });
  assert.deepEqual(tasks.map((task) => task.status), ["failed", "failed"]);
  assert.deepEqual(tasks.map((task) => task.attempt), [0, 0]);
  assert.ok(tasks.every((task) => task.agentId === null && task.workerId === null && task.claimToken === null));
  assert.ok(tasks.every((task) => task.metadata.failure.code === "APP_SERVER_UPSTREAM_404"));
  const dispatch = server.registry.listTurnDispatches({ parentRunId: run.id, purpose: "orchestration", limit: 10 })[0];
  assert.equal(dispatch.status, "failed");
  await server.close();
});

test("daemon recovery terminalizes a legacy preparing Run whose kickoff dispatch already failed", async () => {
  const server = fakeServer({ connect: async () => { throw new Error("control must not be opened for a terminal kickoff"); } }, {
    schedulerConcurrency: 0,
    schedulerIntervalMs: 5,
  });
  const contract = compileExecutionContract({ key: "legacy", taskKind: "analysis", mutatesWorkspace: false });
  server.registry.createTaskGraph({
    id: "legacy_preparing_run",
    name: "legacy preparing run",
    cwd: "/repo",
    status: "preparing",
    metadata: {
      dispatchPath: "orchestrated",
      orchestratorAgentId: "legacy_orchestrator",
      orchestratorSessionIdentity: { type: "codex_session", agentId: "legacy_orchestrator" },
    },
  }, [{
    id: "legacy_staged_task",
    status: "staged",
    prompt: "inspect",
    cwd: "/repo",
    metadata: { executionContract: contract, execution: { executionContract: contract } },
  }]);
  server.registry.upsertAgent({ id: "legacy_orchestrator", cwd: "/repo", status: "idle" }, { role: "orchestrator" });
  server.registry.createTurnDispatch({
    id: "legacy_failed_kickoff",
    subjectType: "run",
    subjectId: "legacy_preparing_run",
    parentRunId: "legacy_preparing_run",
    purpose: "orchestration",
    promptFingerprint: "legacy_prompt",
    submissionKey: "legacy_submission",
    status: "failed",
    failure: {
      category: "environment",
      code: "APP_SERVER_UPSTREAM_404",
      message: "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses",
      retryable: true,
    },
  });

  server.startBackground();
  const run = await waitUntil(() => {
    const current = server.registry.getRun("legacy_preparing_run");
    return current.status === "failed" ? current : null;
  });
  const task = server.registry.getTask("legacy_staged_task");
  assert.equal(run.metadata.failure.code, "APP_SERVER_UPSTREAM_404");
  assert.equal(run.metadata.failure.nextAction, "retry_run");
  assert.equal(task.status, "failed");
  assert.equal(task.attempt, 0);
  assert.equal(task.workerId, null);
  assert.equal(task.claimToken, null);
  await server.close();
});

test("prepared run records an actual Orchestrator thread separately from the Daemon Scheduler", async () => {
  const control = { connect: async () => {} };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 0, instanceId: "daemon_identity" });
  server.registry.upsertAgent({ id: "orchestrator_identity", cwd: "/repo", status: "idle" }, { role: "orchestrator" });
  const prepared = await server.handleRequest({ method: "tools/call", params: { name: "prepare_agent_run", arguments: {
    cwd: "/repo", orchestratorThreadId: "orchestrator_identity", tasks: [{ key: "work", prompt: "work", routingMode: "new" }],
  } } });
  const graph = server.runController.graph(prepared.structuredContent.runId);
  assert.deepEqual(graph.run.scheduler, { type: "daemon_scheduler", instanceId: "daemon_identity" });
  assert.deepEqual(graph.run.orchestratorSession, { type: "codex_session", agentId: "orchestrator_identity" });
  assert.equal(graph.run.orchestrator.id, "orchestrator_identity");
  assert.notEqual(graph.run.scheduler.instanceId, graph.run.orchestrator.id);
  assert.deepEqual(prepared.structuredContent.orchestrator, { id: "orchestrator_identity", type: "codex_session" });
  await server.close();
});

test("control dispatch persists one canonical product-contract failure before creating work", async () => {
  const error = Object.assign(new Error("Superseded context claim was not found"), {
    code: "CONTEXT_SUPERSEDE_TARGET_MISSING",
  });
  const server = fakeServer({ connect: async () => {}, listAgents: async () => ({ agents: [], nextCursor: null }) }, {
    contextResolver: { resolve: () => { throw error; } },
  });
  const accepted = await server.handleRequest({
    method: "tools/call",
    params: { name: "dispatch_control_request", arguments: { objective: "verify contracts", cwd: "/repo", mode: "orchestrated" } },
  });
  const run = await waitUntil(() => {
    const current = server.registry.getRun(accepted.structuredContent.runId);
    return current.status === "failed" ? current : null;
  });
  assert.equal(run.metadata.failure.type, "configuration");
  assert.equal(run.metadata.failure.category, "configuration");
  assert.equal(run.metadata.failure.nextAction, "repair_contract");
  assert.equal(run.metadata.failure.retryable, false);
  assert.equal(run.metadata.failure.repairable, true);
  assert.equal(server.registry.listTasks({ runId: run.id, limit: 100 }).length, 0);
  assert.equal(server.registry.listAgents({ cwd: "/repo", limit: 100 }).length, 0);

  const dashboard = await server.handleRequest({
    method: "tools/call",
    params: { name: "show_agent_dashboard", arguments: { cwd: "/repo", runId: run.id } },
  });
  assert.deepEqual(dashboard.structuredContent.run.failure, dashboard.structuredContent.graph.run.failure);
  await server.close();
});

for (const taskKind of ['analysis', 'test']) test(`direct ${taskKind} request crosses planning and executes exactly once without requiring edits`, async () => {
  let executions=0;
  const id='01a070b9-4fce-7402-9299-bd5f88ebc539';
  const server=fakeServer({connect:async()=>{},listAgents:async()=>({agents:[],nextCursor:null}),
    spawnAgent:async()=>({id,cwd:'/repo',status:'idle',provider:'codex'}),nameAgent:async()=>{},
    runTask:async(_id,_prompt,options={})=>{executions++;options.onStarted?.({turnId:'direct-turn'});return {output:'검토 완료',turnId:'direct-turn',turn:{status:'completed'}};}},
    {planner:{plan:async()=>{throw new Error('Direct work must not invoke planner');}},schedulerConcurrency:1,schedulerIntervalMs:5});
  try {
    const request={objective: taskKind === 'test' ? 'Run node --test test/work-panel.test.js once. 파일 수정 금지.' : '읽기 전용 검토. Do not modify files or run tests. 파일 수정 금지.',taskKind,cwd:'/repo',mode:'direct',pin:true,requestKey:'direct-entry'};
    const response=await server.handleRequest({method:'tools/call',params:{name:'dispatch_control_request',arguments:request}});
    const runId=response.structuredContent.runId;
    assert.equal(response.structuredContent.status,'accepted');
    assert.match(response.content[0].text,/접수됨 · 작업 준비 중/);
    assert.match(response.content[0].text,/아직 이동 링크가 없습니다/);
    const run=await waitUntil(()=>{const r=server.registry.getRun(runId);return ['completed','failed'].includes(r.status)&&r;});
    assert.equal(run.status,'completed',run.metadata.failure?.cause);
    assert.equal(run.metadata.planningMethod,'deterministic_direct');
    const tasks=server.registry.listTasks({runId});
    assert.equal(tasks.length,1);assert.equal(tasks[0].attempt,1);assert.equal(tasks[0].claimToken,null);
    assert.equal(tasks[0].metadata.executionContract.taskKind,taskKind);
    assert.equal(tasks[0].metadata.executionContract.mutatesWorkspace,false);
    assert.deepEqual(tasks[0].metadata.executionContract.outputs,['report']);
    assert.equal(executions,1);
    const status=await server.handleRequest({method:'tools/call',params:{name:'get_work_status',arguments:{runId}}});
    assert.equal(status.structuredContent.works[0].pinning.hostAction.arguments.threadId,id);
    assert.ok(status.content[0].text.includes(`codex://threads/${id}`));
    assert.match(status.content[0].text,/성공 1\/1/);
    assert.doesNotMatch(status.content[0].text,/runId|hostAction|master/);
    const duplicate=await server.handleRequest({method:'tools/call',params:{name:'dispatch_control_request',arguments:request}});
    assert.equal(duplicate.structuredContent.runId,runId);assert.equal(executions,1);
    assert.ok(duplicate.content[0].text.includes(`codex://threads/${id}`));
  } finally {await server.close();}
});

test("dispatch_control_request returns before planning and automatically starts after atomic preparation", async () => {
  let releasePlan;
  const planning = new Promise((resolve) => { releasePlan = resolve; });
  const planner = { plan: async () => planning };
  let nextAgent = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: `agent_async_${++nextAgent}`, cwd: "/repo", status: "idle", provider: "codex" }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (_id, _prompt, options = {}) => {
      options.onStarted?.({ turnId: `turn_${nextAgent}` });
      return { output: "READY", turnId: `turn_${nextAgent}`, turn: { status: "completed" } };
    },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { planner, dashboardServer, schedulerConcurrency: 0 });

  const accepted = await server.handleRequest({
    method: "tools/call",
    params: { name: "dispatch_control_request", arguments: { objective: "두 작업을 병렬 검증", cwd: "/repo" } },
  });
  assert.equal(accepted.structuredContent.status, "accepted");
  assert.equal(accepted.structuredContent.controlPlaneStatus, "available");
  assert.match(accepted.structuredContent.message, /continue automatically/);
  assert.equal(accepted.structuredContent.detailsAvailable, true);
  assert.equal(accepted.structuredContent.dashboardPresentation, undefined);
  assert.equal(server.registry.listTasks({ runId: accepted.structuredContent.runId, limit: 10 }).length, 0);

  releasePlan({
    id: "plan_async",
    version: 1,
    plan: {
      summary: "병렬 검증",
      tasks: [
        { key: "one", title: "첫 작업", prompt: "첫 작업", role: "qa", dependsOn: [], acceptanceCriteria: [] },
        { key: "two", title: "둘째 작업", prompt: "둘째 작업", role: "reviewer", dependsOn: [], acceptanceCriteria: [] },
      ],
    },
  });
  const running = await waitUntil(() => {
    const run = server.registry.getRun(accepted.structuredContent.runId);
    return run?.status === "running" ? run : null;
  });
  assert.equal(running.metadata.dispatchPath, "orchestrated");
  assert.equal(server.registry.listTasks({ runId: running.id, limit: 10 }).length, 2);
  assert.equal(running.metadata.orchestratorAgentId, "agent_async_1");
  assert.equal(nextAgent, 1, "automatic start creates only the Orchestrator before workers are scheduled");
});

test("dispatch_control_request has no advanced manual mode and starts automatically", async () => {
  const planner = { plan: async () => ({ id: "manual_plan", version: 1, plan: { summary: "manual", tasks: [{ key: "work", prompt: "work", role: "qa", dependsOn: [] }] } }) };
  const dashboardServer = { start: async () => {}, url: () => "http://dashboard", close: async () => {} };
  const server = fakeServer({ connect: async () => {} }, { planner, dashboardServer, schedulerConcurrency: 0 });
  const accepted = await server.handleRequest({ method: "tools/call", params: { name: "dispatch_control_request", arguments: { objective: "automatic", cwd: "/repo" } } });
  const running = await waitUntil(() => server.registry.getRun(accepted.structuredContent.runId)?.status === "running");
  assert.equal(running, true);
  assert.equal("requiresExplicitStart" in accepted.structuredContent, false);
  assert.notEqual(server.registry.listTasks({ runId: accepted.structuredContent.runId, limit: 10 })[0].status, "staged");
  await server.close();
});

test("host origin identity is provenance only and results stay in the work navigator", async () => {
  const planner = { plan: async () => ({ id: "origin_plan", version: 1, plan: { summary: "origin", tasks: [{ key: "work", prompt: "work", role: "qa", dependsOn: [] }] } }) };
  const dashboardServer = { start: async () => {}, url: () => "http://dashboard", close: async () => {} };
  const server = fakeServer({ connect: async () => {} }, { planner, dashboardServer, schedulerConcurrency: 0 });
  const accepted = await server.handleRequest({
    method: "tools/call",
    params: {
      name: "dispatch_control_request",
      arguments: { objective: "origin", cwd: "/repo", originThreadId: "spoofed", originTurnId: "spoofed_turn" },
      _meta: { "codex/origin": { threadId: "host_thread", turnId: "host_turn", source: "host_environment" } },
    },
  });
  const run = server.registry.getRun(accepted.structuredContent.runId);
  assert.deepEqual(run.metadata.origin, { threadId: "host_thread", turnId: "host_turn", deliveryPolicy: "dashboard_navigation", source: "host" });
  assert.deepEqual(run.metadata.controlRequest.callerOriginInput, { threadId: "spoofed", turnId: "spoofed_turn" });
  assert.equal(run.metadata.controlRequest.resultAccess, "master_thread_navigation");
  assert.deepEqual(accepted.structuredContent.resultAccess, { mode: "master_thread_navigation" });
  await server.close();
});

test("terminal Control Plane runs finalize for dashboard navigation without appending to the origin thread", async () => {
  const calls = [];
  const control = {
    connect: async () => {},
    resumeAgent: async (threadId) => { calls.push(["resume", threadId]); return { id: threadId, cwd: "/repo", status: "idle" }; },
    runTask: async (threadId, prompt) => {
      calls.push(["result", threadId, prompt]);
      return { output: "user-facing result", turnId: "turn_delivered", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control, { schedulerConcurrency: 0, schedulerIntervalMs: 60_000 });
  server.registry.createRun({
    id: "run_origin_delivery",
    name: "background work",
    cwd: "/repo",
    status: "completed",
    completedAt: new Date().toISOString(),
    metadata: {
      controlRequest: { objective: "work", cwd: "/repo", originThreadId: "control_origin" },
      origin: { threadId: "control_origin", turnId: "turn_request", deliveryPolicy: "dashboard_navigation" },
    },
  });
  server.startBackground();
  const finalized = await waitUntil(() => server.registry.getRun("run_origin_delivery")?.metadata?.controlResultFinalizedAt);
  assert.equal(Boolean(finalized), true);
  assert.deepEqual(server.registry.listControlDeliveries({ runId: "run_origin_delivery" }), []);
  assert.equal(server.registry.listNotifications({ runId: "run_origin_delivery" })[0].kind, "completed");
  assert.deepEqual(calls, []);
  await server.close();
});

test("attention notifications remain visible in the dashboard without writing to the origin thread", async () => {
  const prompts = [];
  const control = {
    connect: async () => {},
    resumeAgent: async (threadId) => ({ id: threadId, cwd: "/repo", status: "idle" }),
    runTask: async (_threadId, prompt) => {
      prompts.push(prompt);
      return { output: "attention delivered", turnId: "turn_attention", turn: { status: "completed" } };
    },
  };
  const server = fakeServer(control, { schedulerConcurrency: 0, schedulerIntervalMs: 60_000 });
  server.registry.createRun({
    id: "run_attention", cwd: "/repo", status: "running",
    metadata: { origin: { threadId: "control_origin", turnId: "turn_request" } },
  });
  server.registry.createNotification({
    projectKey: "/repo", runId: "run_attention", kind: "attention_required",
    title: "판단 필요", body: "작업의 부작용 여부를 선택하세요.", dedupeKey: "run_attention:decision",
  });
  server.startBackground();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(server.registry.listControlDeliveries({ runId: "run_attention" }), []);
  assert.deepEqual(prompts, []);
  assert.equal(server.registry.listNotifications({ runId: "run_attention" })[0].readAt, null);
  await server.close();
});

test("daemon observes an uncertain terminal receipt without replaying or reopening its failed task", async () => {
  const registry = new ControlRegistry({path:':memory:'});
  registry.createTask({id:'uncertain-task',prompt:'work',status:'recovery_attention'});
  const dispatch=registry.createTurnDispatch({subjectType:'task',subjectId:'uncertain-task',parentTaskId:'uncertain-task',purpose:'execution',revision:1,
    promptFingerprint:'fingerprint',submissionKey:'uncertain-receipt',threadId:'thread',turnId:'turn',status:'recovery_attention'});
  let submissions=0;
  const server=fakeServer({connect:async()=>{},inspectAgent:async()=>({thread:{turns:[{id:'turn',status:'completed',items:[]}]}}),runTask:async()=>{submissions++;}},
    {registry,recoverInterruptedTasks:true,schedulerConcurrency:0});
  try {
    server.startBackground();
    assert.equal(await waitUntil(()=>registry.getTurnDispatch(dispatch.id).status==='completed'),true);
    assert.equal(submissions,0);
    assert.equal(registry.getTask('uncertain-task').status,'recovery_attention');
  } finally {await server.close();}
});

test("daemon restart finalizes an integration_pending task from a recorded journal", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const contract = compileExecutionContract({ key: "recover_integration", taskKind: "implementation", mutatesWorkspace: true, workspaceMode: "worktree", integrationStrategy: "patch" });
  registry.createRun({ id: "run_integration_recovery", cwd: "/repo", status: "running" });
  registry.createTask({
    id: "recover_integration", prompt: "integrate", cwd: "/repo",
    metadata: { runId: "run_integration_recovery", executionContract: contract, managedWorktreeId: "worktree_recover_integration" },
  });
  const claim = registry.claimTask("recover_integration", "old_daemon");
  registry.markClaimIntegrationPending("recover_integration", "old_daemon", claim.claimToken, { strategy: "patch" });
  registry.upsertManagedWorktree({ id: "worktree_recover_integration", repoRoot: "/repo", path: "/managed/recover", status: "integrated", ownerTaskId: "recover_integration" });
  const journal = registry.prepareIntegrationJournal({ worktreeId: "worktree_recover_integration", taskId: "recover_integration", repoRoot: "/repo", strategy: "patch", artifact: { changed: true, patchPath: "/artifact.patch", commit: "abc" } });
  registry.transitionIntegrationJournal(journal.id, "applying");
  registry.transitionIntegrationJournal(journal.id, "applied");
  registry.transitionIntegrationJournal(journal.id, "recorded");

  const worktreeManager = {
    recoverPendingIntegrations: async () => [],
    verifyIntegration: async () => ({ required: true, passed: true, summary: "recorded artifact verified" }),
  };
  const server = fakeServer({ connect: async () => {} }, { registry, worktreeManager, recoverInterruptedTasks: true, schedulerConcurrency: 0 });
  server.startBackground();
  const completed = await waitUntil(() => registry.getTask("recover_integration").status === "completed");
  assert.equal(completed, true);
  assert.equal(registry.getTask("recover_integration").workerId, null);
  assert.equal(registry.getRun("run_integration_recovery").status, "completed");
  await server.close();
});

test("revising a plan never rewrites an already running Run", async () => {
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer({ connect: async () => {} }, { dashboardServer, schedulerConcurrency: 0 });
  server.registry.createPlan({ id: "plan_rematerialize", requestKey: "plan-rematerialize", objective: "verify", cwd: "/repo" });
  server.registry.updatePlan("plan_rematerialize", {
    status: "planned",
    plan: { summary: "v1", risks: [], tasks: [{ key: "old", title: "Old", prompt: "old prompt", role: "reviewer", capabilities: [], tools: [], dependsOn: [], workspaceMode: "shared", acceptanceCriteria: [] }] },
  });
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: { cwd: "/repo", requestKey: "run-rematerialize", planId: "plan_rematerialize", tasks: [{ key: "old", prompt: "old prompt", role: "reviewer" }] } },
  });
  const runId = prepared.structuredContent.runId;
  const oldTaskId = server.registry.listTasks({ runId, limit: 10 })[0].id;
  server.planner = {
    revise: async () => server.registry.updatePlan("plan_rematerialize", {
      status: "planned",
      version: 2,
      plan: { summary: "v2", risks: [], tasks: [
        { key: "inspect", title: "Inspect", prompt: "inspect revised", role: "reviewer", capabilities: [], tools: [], dependsOn: [], workspaceMode: "shared", acceptanceCriteria: [] },
        { key: "test", title: "Test", prompt: "test revised", role: "e2e-regression-tester", capabilities: [], tools: ["node"], dependsOn: ["inspect"], workspaceMode: "shared", acceptanceCriteria: [] },
      ] },
    }),
  };

  const revised = await server.handleRequest({ method: "tools/call", params: { name: "revise_agent_plan", arguments: { planId: "plan_rematerialize", feedback: "add tests" } } });
  const tasks = server.registry.listTasks({ runId, limit: 10 });

  assert.deepEqual(revised.structuredContent.rematerializedRuns, []);
  assert.equal(server.registry.getRun(runId).status, "running");
  assert.ok(server.registry.getTask(oldTaskId));
  assert.deepEqual(tasks.map((task) => task.metadata.key), ["old"]);
  await server.close();
});

test("registry task preserves failed and interrupted App Server turn status", async () => {
  for (const turnStatus of ["failed", "interrupted"]) {
    const control = {
      connect: async () => {},
      spawnAgent: async () => ({ id: `agent_${turnStatus}`, cwd: "/repo", status: "idle", provider: "codex" }),
      nameAgent: async () => {},
      pinAgent: async () => {},
      runTask: async (_id, _prompt, options = {}) => {
        options.onStarted?.({ turnId: `turn_${turnStatus}` });
        return { output: "partial", turnId: `turn_${turnStatus}`, turn: { status: turnStatus } };
      },
    };
    const server = fakeServer(control);
    const response = await server.handleRequest({
      method: "tools/call",
      params: { name: "run_agent_task", arguments: { prompt: "work", cwd: "/repo", routingMode: "new" } },
    });
    assert.equal(response.structuredContent.record.status, turnStatus);
    assert.equal(server.registry.getTask(response.structuredContent.taskId).status, turnStatus);
    await server.close();
  }
});

test("dependent data-plane tasks receive upstream results as A2A handoff", async () => {
  const prompts = [];
  let nextAgent = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: `agent_handoff_${++nextAgent}`, cwd: "/repo", status: "idle", provider: "codex" }),
    forkAgent: async (id) => ({ id: `${id}_fork`, cwd: "/repo", status: "idle", provider: "codex", forkedFromId: id }),
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle", provider: "codex" }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (id, prompt, options = {}) => {
      prompts.push({ id, prompt, context: options.additionalContext });
      options.onStarted?.({ turnId: `turn_${prompts.length}` });
      return { output: prompt.includes("첫 결과를 생성") ? "UPSTREAM_RESULT" : "done", turnId: `turn_${prompts.length}`, turn: { status: "completed" } };
    },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { dashboardServer, schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  server.startBackground();
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: { cwd: "/repo", tasks: [
      { key: "first", title: "첫 작업", prompt: "첫 결과를 생성", role: "implementer" },
      { key: "second", title: "후속 작업", prompt: "첫 결과를 검토", role: "reviewer", dependsOn: ["first"] },
    ] } },
  });
  await waitUntil(() => server.registry.getRun(prepared.structuredContent.runId)?.status === "completed");
  const downstream = prompts.find((entry) => entry.prompt === "첫 결과를 검토");
  assert.ok(downstream);
  assert.match(downstream.context.threadhub_handoffs.value, /UPSTREAM_RESULT/);
  assert.ok(server.registry.listEvents({ limit: 100 }).some((event) => event.eventType === "task.a2a_handoff_received"));
  await server.close();
});

test("validator feedback drives bounded rework after automatic Start", async () => {
  const prompts = [];
  let nextAgent = 0;
  let validations = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: `agent_rework_${++nextAgent}`, cwd: "/repo", status: "idle", provider: "codex" }),
    forkAgent: async (id) => ({ id: `${id}_fork`, cwd: "/repo", status: "idle", provider: "codex", forkedFromId: id }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle", provider: "codex" }),
    runTask: async (_id, prompt, options = {}) => {
      prompts.push({ prompt, context: options.additionalContext });
      options.onStarted?.({ turnId: `turn_rework_${prompts.length}` });
      return { output: `attempt ${prompts.length}`, turnId: `turn_rework_${prompts.length}`, turn: { status: "completed" } };
    },
  };
  const resultValidator = {
    validate: async () => {
      validations += 1;
      return validations === 1
        ? { decision: "reject", summary: "Add retry regression evidence", evidence: [], unmetCriteria: ["retry test passes"] }
        : { decision: "accept", summary: "Retry regression passes", evidence: ["1 passed"], unmetCriteria: [] };
    },
  };
  const dashboardServer = { start: async () => {}, url: ({ runId }) => `http://127.0.0.1/dashboard?runId=${runId}`, close: async () => {} };
  const server = fakeServer(control, { resultValidator, dashboardServer, schedulerConcurrency: 1, schedulerIntervalMs: 5 });
  server.startBackground();
  const prepared = await server.handleRequest({
    method: "tools/call",
    params: { name: "prepare_agent_run", arguments: { cwd: "/repo", tasks: [{
      key: "implementation", prompt: "implement retry", acceptanceCriteria: ["retry test passes"], maxAttempts: 3, retryDelayMs: 0,
    }] } },
  });
  await waitUntil(() => server.registry.getRun(prepared.structuredContent.runId)?.status === "completed");
  const task = server.registry.listTasks({ runId: prepared.structuredContent.runId, limit: 10 })[0];
  assert.equal(task.status, "completed");
  assert.equal(task.attempt, 2);
  assert.equal(task.metadata.failureHistory.length, 1);
  assert.match(prompts[1].context.threadhub_rework.value, /Add retry regression evidence/);
  for (const { prompt, context } of prompts) {
    assert.equal(prompt, "implement retry");
    assert.match(context.threadhub_policy.value, /Do not request another Start confirmation/);
  }
  await server.close();
});

test("periodic reconciliation completes a stale task from thread/read", async () => {
  const control = {
    connect: async () => {},
    inspectAgent: async (threadId, options) => {
      assert.equal(threadId, "agent_stale");
      assert.equal(options.includeTurns, true);
      return { thread: { turns: [{ id: "turn_stale", status: "completed", output: "recovered result" }] } };
    },
  };
  const server = fakeServer(control, { schedulerConcurrency: 0, staleTaskMs: 0 });
  server.registry.upsertAgent({ id: "agent_stale", cwd: "/repo", status: "running" });
  server.registry.createTask({ id: "task_stale", prompt: "recover", cwd: "/repo" });
  const claim = server.registry.claimTask("task_stale", "old_worker");
  server.registry.updateTask("task_stale", { agentId: "agent_stale", turnId: "turn_stale", heartbeatAt: new Date(0).toISOString() });
  const result = await server.reconcileStaleTasks();
  assert.equal(result.reconciled, 1);
  assert.equal(server.registry.getTask("task_stale").status, "completed");
  assert.equal(server.registry.getTask("task_stale").output, "recovered result");
  assert.equal(server.registry.getAgent("agent_stale").status, "idle");
  assert.ok(claim.claimToken);
  await server.close();
});

test("restart reconciliation continues a completed worker into validation", async () => {
  let validations = 0;
  const control = {
    connect: async () => {},
    inspectAgent: async () => ({ thread: { turns: [{ id: "turn_worker_done", status: "completed", output: "worker result", items: [] }] } }),
  };
  const resultValidator = {
    validate: async () => {
      validations += 1;
      return { decision: "accept", failureKind: "none", summary: "verified", evidence: ["checked"], unmetCriteria: [] };
    },
  };
  const server = fakeServer(control, { resultValidator, schedulerConcurrency: 0, staleTaskMs: 0 });
  server.registry.upsertAgent({ id: "worker_restart", cwd: "/repo", status: "running" });
  server.registry.createTask({ id: "task_restart_worker", prompt: "work", cwd: "/repo", metadata: { acceptanceCriteria: ["verified"] } });
  const claim = server.registry.claimTask("task_restart_worker", "old_daemon");
  server.registry.updateTask("task_restart_worker", { agentId: "worker_restart", turnId: "turn_worker_done", heartbeatAt: new Date(0).toISOString() });

  const result = await server.reconcileStaleTasks();
  assert.equal(result.reconciled, 1);
  assert.equal(validations, 1);
  assert.equal(server.registry.getTask("task_restart_worker").status, "completed");
  assert.equal(server.registry.getTask("task_restart_worker").metadata.completionVerdict.decision, "accept");
  assert.ok(claim.claimToken);
  await server.close();
});

test("restart reconciliation never completes accepted validation before worktree integration", async () => {
  const calls = [];
  const contract = compileExecutionContract({ key: "restart_integrate", taskKind: "implementation", mutatesWorkspace: true, workspaceMode: "worktree", integrationStrategy: "patch" });
  const control = {
    connect: async () => {},
    inspectAgent: async () => ({ thread: { turns: [{
      id: "turn_validator_accept", status: "completed",
      output: JSON.stringify({ decision: "accept", failureKind: "none", summary: "verified", evidence: ["checked"], unmetCriteria: [] }),
    }] } }),
  };
  const worktreeManager = {
    finalize: async (id) => { calls.push(["finalize", id]); return { changed: true, commit: "abc" }; },
    integrate: async (id, options) => { calls.push(["integrate", id, options.strategy]); return { status: "integrated", artifact: { changed: true, commit: "abc" } }; },
  };
  const server = fakeServer(control, { worktreeManager, schedulerConcurrency: 0, staleTaskMs: 0 });
  server.registry.createTask({
    id: "task_restart_integrate", prompt: "implement", cwd: "/repo",
    metadata: { acceptanceCriteria: ["verified"], executionContract: contract, managedWorktreeId: "worktree_restart" },
  });
  const claim = server.registry.claimTask("task_restart_integrate", "old_daemon");
  server.registry.markClaimAgentDone("task_restart_integrate", "old_daemon", claim.claimToken, { output: "worker output", turnId: "turn_worker" });
  server.registry.markClaimValidating("task_restart_integrate", "old_daemon", claim.claimToken);
  server.registry.updateTask("task_restart_integrate", { heartbeatAt: new Date(0).toISOString(), metadata: { validationInProgress: { agentId: "validator_restart_accept", turnId: "turn_validator_accept" } } });

  const result = await server.reconcileStaleTasks();
  assert.equal(result.reconciled, 1);
  assert.deepEqual(calls, [["finalize", "worktree_restart"], ["integrate", "worktree_restart", "patch"]]);
  assert.equal(server.registry.getTask("task_restart_integrate").status, "completed");
  assert.equal(server.registry.getTask("task_restart_integrate").metadata.completionVerdict.decision, "accept");
  await server.close();
});

test("restart reconciliation consumes validator feedback once without duplicate rework", async () => {
  const feedback = { decision: "reject", summary: "Missing restart regression", evidence: [], unmetCriteria: ["restart test"] };
  let inspections = 0;
  const control = {
    connect: async () => {},
    inspectAgent: async (threadId) => {
      inspections += 1;
      assert.equal(threadId, "validator_restart");
      return { thread: { turns: [{ id: "turn_validator_restart", status: "completed", output: JSON.stringify(feedback) }] } };
    },
  };
  const server = fakeServer(control, { schedulerConcurrency: 0, staleTaskMs: 0 });
  server.registry.createTask({ id: "task_restart_validation", prompt: "work", cwd: "/repo", maxAttempts: 3, retryDelayMs: 0, metadata: { acceptanceCriteria: ["restart test"] } });
  const claim = server.registry.claimTask("task_restart_validation", "old_daemon");
  server.registry.markClaimAgentDone("task_restart_validation", "old_daemon", claim.claimToken, { output: "worker result", turnId: "turn_worker" });
  server.registry.markClaimValidating("task_restart_validation", "old_daemon", claim.claimToken);
  server.registry.updateTask("task_restart_validation", { heartbeatAt: new Date(0).toISOString(), metadata: { validationInProgress: { agentId: "validator_restart", turnId: "turn_validator_restart" } } });

  const first = await server.reconcileStaleTasks();
  const second = await server.reconcileStaleTasks();
  const task = server.registry.getTask("task_restart_validation");
  assert.equal(first.reconciled, 1);
  assert.equal(second.checked, 0);
  assert.equal(inspections, 1);
  assert.equal(task.status, "retry_waiting");
  assert.equal(task.metadata.failureHistory.length, 1);
  assert.equal(task.metadata.rework.feedbackHashes.length, 1);
  await server.close();
});

test("close drains then interrupts an active Data Plane turn", async () => {
  let releaseTurn;
  let interrupted = 0;
  const control = {
    connect: async () => {},
    listAgents: async () => ({ agents: [], nextCursor: null }),
    spawnAgent: async () => ({ id: "agent_shutdown", cwd: "/repo", status: "idle", provider: "codex" }),
    nameAgent: async () => {},
    pinAgent: async () => {},
    runTask: async (_id, _prompt, options = {}) => {
      options.onStarted?.({ turnId: "turn_shutdown" });
      return new Promise((resolve) => { releaseTurn = () => resolve({ output: "", turnId: "turn_shutdown", turn: { status: "interrupted" } }); });
    },
    interruptTask: async () => { interrupted += 1; releaseTurn(); },
  };
  const server = fakeServer(control, { schedulerConcurrency: 1, schedulerIntervalMs: 5, shutdownDrainMs: 5 });
  const executionContract = compileExecutionContract({ key: "task_shutdown", taskKind: "analysis", mutatesWorkspace: false });
  server.registry.createTask({
    id: "task_shutdown",
    prompt: "long work",
    cwd: "/repo",
    metadata: { executionContract, execution: { executionContract } },
  });
  server.startBackground();
  await waitUntil(() => server.registry.getTask("task_shutdown")?.turnId === "turn_shutdown");
  await server.close();
  assert.equal(interrupted, 1);
  assert.equal(server.registry.getTask("task_shutdown").status, "interrupted");
});
