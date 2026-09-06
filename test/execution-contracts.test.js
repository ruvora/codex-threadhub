import assert from "node:assert/strict";
import test from "node:test";

import { assertExecutionContract, compileExecutionContract } from "../src/execution-contracts.js";

test("execution authority follows explicit task intent rather than role names", () => {
  const writer = compileExecutionContract({ key: "docs", taskKind: "implementation", mutatesWorkspace: true, role: "korean-technical-writer" });
  assert.equal(writer.sandbox, "workspace-write");
  assert.equal(writer.workspaceMode, "worktree");
  assert.equal(writer.integrationStrategy, "patch");
  assert.equal(writer.authorizationScope, "parent_run");

  const misleading = compileExecutionContract({ key: "audit", taskKind: "review", mutatesWorkspace: false, role: "e2e-super-reviewer" });
  assert.equal(misleading.sandbox, "read-only");
  assert.equal(misleading.networkAccess, false);
});

test("preflight rejects contradictory and external automatic contracts", () => {
  assert.throws(() => compileExecutionContract({ key: "bad", taskKind: "implementation", sandbox: "read-only" }), /requires workspace-write/);
  assert.throws(() => compileExecutionContract({ key: "publish", taskKind: "release", sideEffectPolicy: "external" }), /separate user-authorized/);
});

test("local runtime lifecycle is distinct from external system mutation", () => {
  const observation = compileExecutionContract({ key: "health", taskKind: "test", mutatesWorkspace: false, sideEffectPolicy: "none" });
  const daemonStart = compileExecutionContract({ key: "daemon", taskKind: "test", mutatesWorkspace: false, sideEffectPolicy: "local-runtime" });
  assert.equal(observation.sandbox, "workspace-write");
  assert.equal(observation.mutatesWorkspace, false);
  assert.deepEqual(observation.executionCapabilities, ["process-execution", "temporary-filesystem-write"]);
  assert.equal(daemonStart.sideEffectPolicy, "local-runtime");
  assert.throws(() => compileExecutionContract({ key: "invalid", sideEffectPolicy: "local_process" }), /Unsupported side-effect policy/);
});

test("runtime capabilities are independent from project mutation and drive sandbox preflight", () => {
  assert.throws(() => compileExecutionContract({
    key: "server-test",
    taskKind: "test",
    mutatesWorkspace: false,
    executionCapabilities: ["process-execution", "temporary-filesystem-write", "localhost-listen"],
  }), { code: 'EXECUTION_CONTRACT_UNSUPPORTED_LOCALHOST_SANDBOX' });
  assert.throws(() => compileExecutionContract({
    key: "inferred-server",
    taskKind: "review",
    mutatesWorkspace: false,
    acceptanceCriteria: ["Start a local server and verify its 127.0.0.1 listener."],
  }), { code: 'EXECUTION_CONTRACT_UNSUPPORTED_LOCALHOST_SANDBOX' });
  assert.throws(() => compileExecutionContract({
    key: "blocked-server-test",
    taskKind: "test",
    mutatesWorkspace: false,
    sandbox: "read-only",
    executionCapabilities: ["process-execution", "temporary-filesystem-write", "localhost-listen"],
  }), /requires workspace-write/);
});

test("browser acceptance requires an explicit browser-capable tool", () => {
  assert.throws(() => compileExecutionContract({
    key: "visual",
    taskKind: "review",
    tools: ["shell"],
    executionCapabilities: ["process-execution", "browser-inspection"],
  }), /browser-capable tool/);
  const visual = compileExecutionContract({
    key: "visual",
    taskKind: "review",
    tools: ["browser"],
    executionCapabilities: ["browser-inspection"],
  });
  assert.ok(visual.executionCapabilities.includes("browser-inspection"));
  assert.throws(() => compileExecutionContract({
    key: "responsive-acceptance",
    taskKind: "review",
    tools: ["shell"],
    acceptanceCriteria: ["Verify the responsive layout in an actual browser viewport."],
    executionCapabilities: ["process-execution"],
  }), /browser-capable tool/);
});

test("task execution contracts only inherit the parent Run authorization", () => {
  assert.equal(compileExecutionContract({ key: "inherited", authorizationScope: "parent_run" }).authorizationScope, "parent_run");
  assert.throws(
    () => compileExecutionContract({ key: "second-start", authorizationScope: "task_start" }),
    /Unsupported Run authorization scope/,
  );
});

test("execution contracts reject unsupported enum values and malformed collections", () => {
  assert.throws(() => compileExecutionContract({ key: "workspace", workspaceMode: "spaceship" }), /Unsupported workspace mode/);
  assert.throws(() => compileExecutionContract({ key: "integration", integrationStrategy: "magic" }), /Unsupported integration strategy/);
  assert.throws(() => compileExecutionContract({ key: "approval", approvalPolicy: "always" }), /Unsupported approval policy/);
  assert.throws(
    () => compileExecutionContract({ key: "required", requiredSandbox: "root", sandbox: "danger-full-access" }),
    /Unsupported required sandbox/,
  );
  assert.throws(() => compileExecutionContract({ key: "outputs", outputs: "report" }), /outputs must be an array/);
  assert.throws(() => compileExecutionContract({ key: "tools", tools: "node" }), /tools must be an array/);
});

test("execution contracts reject contradictory authority and workspace intent", () => {
  assert.throws(
    () => compileExecutionContract({ key: "read-only-implementation", taskKind: "implementation", mutatesWorkspace: false }),
    /implementation tasks must mutate the workspace/i,
  );
  assert.throws(
    () => compileExecutionContract({ key: "mutating-review", taskKind: "review", mutatesWorkspace: true }),
    /review tasks cannot mutate the workspace/i,
  );
  assert.throws(
    () => compileExecutionContract({ key: "hidden-write", mutatesWorkspace: true, sideEffectPolicy: "none" }),
    /mutating tasks require workspace side effects/i,
  );
  assert.throws(
    () => compileExecutionContract({ key: "phantom-write", mutatesWorkspace: false, sideEffectPolicy: "workspace" }),
    /workspace side effects require a mutating task/i,
  );
  assert.throws(
    () => compileExecutionContract({ key: "shared-patch", workspaceMode: "shared", integrationStrategy: "patch" }),
    /shared workspace tasks cannot request artifact integration/i,
  );
});

test("persisted execution contracts verify version and fingerprint integrity", () => {
  const valid = compileExecutionContract({ key: "audit" });
  assert.equal(assertExecutionContract(valid), valid);
  assert.throws(() => assertExecutionContract({ ...valid, version: 999 }), /Unsupported execution contract version/);
  assert.throws(() => assertExecutionContract({ ...valid, sandbox: "danger-full-access" }), /fingerprint mismatch/);
  assert.throws(() => assertExecutionContract({ ...valid, undocumentedField: true }), /Unsupported execution contract field/);
});
