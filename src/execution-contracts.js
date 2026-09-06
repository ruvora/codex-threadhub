import { createHash, timingSafeEqual } from "node:crypto";

export const RUN_AUTHORIZATION = "[RUN AUTHORIZATION] The user's Control Plane request already authorizes this Run. Execute this delegated work immediately. Do not request another Start confirmation: authorization applies once at the Run boundary, not once per task, dependency, validation, or retry.";

export const TASK_KINDS = ["analysis", "implementation", "test", "review", "integration", "release"];
export const SIDE_EFFECT_POLICIES = ["none", "local-runtime", "workspace", "external", "destructive"];
export const RUN_AUTHORIZATION_SCOPES = ["parent_run"];
export const EXECUTION_CONTRACT_VERSION = 2;
export const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
export const APPROVAL_POLICIES = ["never", "on-request", "on-failure", "untrusted"];
export const WORKSPACE_MODES = ["shared", "worktree"];
export const INTEGRATION_STRATEGIES = ["none", "patch", "commit"];
export const EXECUTION_CAPABILITIES = Object.freeze([
  "process-execution",
  "temporary-filesystem-write",
  "localhost-connect",
  "localhost-listen",
  "external-network",
  "browser-inspection",
  "workspace-write",
  "git-integration",
]);
// Running tests may write temporary runtime files, not necessarily project files.
// Test-writing tasks must explicitly request mutatesWorkspace=true.
export const MUTATING_TASK_KINDS = new Set(["implementation", "integration", "release"]);
const SANDBOX_LEVEL = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
const CONTRACT_FIELDS = new Set([
  "version", "taskKind", "mutatesWorkspace", "requiredSandbox", "sandbox", "networkAccess",
  "approvalPolicy", "authorizationScope", "sideEffectPolicy", "idempotencyKey", "workspaceMode",
  "baseRef", "integrationStrategy", "outputs", "tools", "roleTemplate", "fingerprint",
  "executionCapabilities",
]);
const ALWAYS_MUTATING_TASK_KINDS = new Set(["implementation", "integration", "release"]);
const NEVER_MUTATING_TASK_KINDS = new Set(["analysis", "review"]);

function contractError(message, code = "EXECUTION_CONTRACT_INVALID") {
  return Object.assign(new Error(message), { code });
}

function assertOptionalBoolean(value, name) {
  if (value !== undefined && typeof value !== "boolean") throw contractError(`${name} must be a boolean`);
}

function assertStringArray(value, name) {
  if (!Array.isArray(value)) throw contractError(`${name} must be an array`);
  if (value.some((entry) => typeof entry !== "string" || !entry.trim())) throw contractError(`${name} must contain non-empty strings`);
  return value;
}

function assertUniqueStringArray(value, name) {
  const entries = assertStringArray(value, name);
  if (new Set(entries).size !== entries.length) throw contractError(`${name} must not contain duplicates`);
  return entries;
}

function assertSupported(value, supported, label, code = "EXECUTION_CONTRACT_INVALID") {
  if (!supported.includes(value)) throw contractError(`Unsupported ${label}: ${value}`, code);
}

function validateExecutionContract(contract, options = {}) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw contractError("Execution contract must be an object");
  for (const field of Object.keys(contract)) {
    if (!CONTRACT_FIELDS.has(field)) throw contractError(`Unsupported execution contract field: ${field}`, "EXECUTION_CONTRACT_FIELD_UNSUPPORTED");
  }
  if (contract.version !== EXECUTION_CONTRACT_VERSION) {
    throw contractError(`Unsupported execution contract version: ${contract.version}`, "EXECUTION_CONTRACT_VERSION_UNSUPPORTED");
  }
  assertSupported(contract.taskKind, TASK_KINDS, "task kind");
  if (typeof contract.mutatesWorkspace !== "boolean") throw contractError("mutatesWorkspace must be a boolean");
  if (ALWAYS_MUTATING_TASK_KINDS.has(contract.taskKind) && !contract.mutatesWorkspace) {
    throw contractError(`${contract.taskKind} tasks must mutate the workspace`, "EXECUTION_CONTRACT_TASK_KIND_MISMATCH");
  }
  if (NEVER_MUTATING_TASK_KINDS.has(contract.taskKind) && contract.mutatesWorkspace) {
    throw contractError(`${contract.taskKind} tasks cannot mutate the workspace`, "EXECUTION_CONTRACT_TASK_KIND_MISMATCH");
  }
  assertSupported(contract.requiredSandbox, SANDBOXES, "required sandbox");
  assertSupported(contract.sandbox, SANDBOXES, "sandbox");
  if (SANDBOX_LEVEL[contract.sandbox] < SANDBOX_LEVEL[contract.requiredSandbox]) {
    throw contractError(`Execution contract requires ${contract.requiredSandbox} but resolved ${contract.sandbox}`, "EXECUTION_CONTRACT_INSUFFICIENT_SANDBOX");
  }
  if (contract.mutatesWorkspace && (contract.requiredSandbox === "read-only" || contract.sandbox === "read-only")) {
    throw contractError("Workspace mutation requires a writable sandbox", "EXECUTION_CONTRACT_INSUFFICIENT_SANDBOX");
  }
  if (typeof contract.networkAccess !== "boolean") throw contractError("networkAccess must be a boolean");
  assertSupported(contract.approvalPolicy, APPROVAL_POLICIES, "approval policy");
  assertSupported(contract.authorizationScope, RUN_AUTHORIZATION_SCOPES, "Run authorization scope", "EXECUTION_CONTRACT_AUTHORIZATION_SCOPE");
  assertSupported(contract.sideEffectPolicy, SIDE_EFFECT_POLICIES, "side-effect policy");
  assertSupported(contract.workspaceMode, WORKSPACE_MODES, "workspace mode");
  assertSupported(contract.integrationStrategy, INTEGRATION_STRATEGIES, "integration strategy");
  assertStringArray(contract.outputs, "outputs");
  assertStringArray(contract.tools, "tools");
  const executionCapabilities = assertUniqueStringArray(contract.executionCapabilities, "executionCapabilities");
  for (const capability of executionCapabilities) assertSupported(capability, EXECUTION_CAPABILITIES, "execution capability");
  const capabilitySet = new Set(executionCapabilities);
  if (contract.baseRef !== null && typeof contract.baseRef !== "string") throw contractError("baseRef must be a string or null");
  if (contract.idempotencyKey !== null && typeof contract.idempotencyKey !== "string") throw contractError("idempotencyKey must be a string or null");
  if (contract.roleTemplate !== null && typeof contract.roleTemplate !== "string") throw contractError("roleTemplate must be a string or null");
  if (contract.networkAccess && contract.sandbox === "read-only") {
    throw contractError("Execution contract requests network access in a read-only sandbox", "EXECUTION_CONTRACT_NETWORK_SANDBOX");
  }
  if (contract.networkAccess !== capabilitySet.has("external-network")) {
    throw contractError("networkAccess must match the external-network execution capability", "EXECUTION_CONTRACT_CAPABILITY_MISMATCH");
  }
  if (contract.mutatesWorkspace !== capabilitySet.has("workspace-write")) {
    throw contractError("mutatesWorkspace must match the workspace-write execution capability", "EXECUTION_CONTRACT_CAPABILITY_MISMATCH");
  }
  if (contract.integrationStrategy !== "none" && !capabilitySet.has("git-integration")) {
    throw contractError("Artifact integration requires the git-integration execution capability", "EXECUTION_CONTRACT_CAPABILITY_MISMATCH");
  }
  if (contract.integrationStrategy === "none" && capabilitySet.has("git-integration")) {
    throw contractError("git-integration requires an artifact integration strategy", "EXECUTION_CONTRACT_CAPABILITY_MISMATCH");
  }
  if (capabilitySet.has("localhost-listen") && !capabilitySet.has("process-execution")) {
    throw contractError("localhost-listen requires process-execution", "EXECUTION_CONTRACT_CAPABILITY_MISMATCH");
  }
  const needsWritableRuntime = ["temporary-filesystem-write", "localhost-listen"].some((capability) => capabilitySet.has(capability));
  if (needsWritableRuntime && contract.sandbox === "read-only") {
    throw contractError("Temporary filesystem writes and localhost listeners require a writable runtime sandbox", "EXECUTION_CONTRACT_INSUFFICIENT_RUNTIME_SANDBOX");
  }
  // A capability declaration does not grant sandbox permissions. This runtime
  // cannot express loopback-only access; do not silently enable external access.
  if (capabilitySet.has("localhost-listen") && contract.sandbox === "workspace-write" && !contract.networkAccess) {
    throw contractError("This runtime cannot grant localhost-listen with networkAccess=false; run socket integration tests on an authorized host, or use socket-free tests. Network permissions will not be widened automatically.", "EXECUTION_CONTRACT_UNSUPPORTED_LOCALHOST_SANDBOX");
  }
  if (capabilitySet.has("browser-inspection") && !contract.tools.some((tool) => ["browser", "computer-use", "chrome"].includes(tool))) {
    throw contractError("browser-inspection requires a browser-capable tool", "EXECUTION_CONTRACT_MISSING_TOOL");
  }
  if (["external", "destructive"].includes(contract.sideEffectPolicy)) {
    throw contractError("Execution contract requires a separate user-authorized external action", "EXECUTION_CONTRACT_EXTERNAL_ACTION");
  }
  if (contract.mutatesWorkspace && contract.sideEffectPolicy !== "workspace") {
    throw contractError("Mutating tasks require workspace side effects", "EXECUTION_CONTRACT_SIDE_EFFECT_MISMATCH");
  }
  if (!contract.mutatesWorkspace && contract.sideEffectPolicy === "workspace") {
    throw contractError("Workspace side effects require a mutating task", "EXECUTION_CONTRACT_SIDE_EFFECT_MISMATCH");
  }
  if (contract.workspaceMode === "shared" && contract.integrationStrategy !== "none") {
    throw contractError("Shared workspace tasks cannot request artifact integration", "EXECUTION_CONTRACT_INTEGRATION_MISMATCH");
  }
  if (contract.workspaceMode === "worktree" && contract.mutatesWorkspace && contract.integrationStrategy === "none") {
    throw contractError("Mutating worktree tasks require an integration strategy", "EXECUTION_CONTRACT_INTEGRATION_MISSING");
  }
  if (!contract.mutatesWorkspace && contract.integrationStrategy !== "none") {
    throw contractError("Non-mutating tasks cannot request artifact integration", "EXECUTION_CONTRACT_INTEGRATION_MISMATCH");
  }
  if (options.requireFingerprint && (typeof contract.fingerprint !== "string" || !/^[a-f0-9]{20}$/.test(contract.fingerprint))) {
    throw contractError("Compiled execution contract fingerprint is required", "EXECUTION_CONTRACT_MISSING");
  }
  return contract;
}

function words(value) {
  return String(value ?? "").toLowerCase();
}

export function acceptanceCapabilityRequirements(task = {}) {
  const criteria = assertStringArray(task.acceptanceCriteria ?? [], "acceptanceCriteria").join("\n").toLowerCase();
  const required = new Set();
  if (/\b(browser|viewport|render(?:ing)?|screenshot|visual regression|responsive)\b|브라우저|뷰포트|렌더링|스크린샷|시각\s*회귀|반응형/.test(criteria)) {
    required.add("browser-inspection");
  }
  if (/\b(localhost|127\.0\.0\.1|listen(?:er|ing)?|local server|unix socket)\b|로컬\s*(?:서버|소켓)|리스너/.test(criteria)) {
    required.add("process-execution");
    required.add("localhost-listen");
  }
  if (/\b(temp(?:orary)? (?:file|directory)|mkdtemp|tmpdir)\b|임시\s*(?:파일|디렉터리)/.test(criteria)) {
    required.add("temporary-filesystem-write");
  }
  return [...required].sort();
}

/** Compatibility inference for callers that have not migrated to taskKind yet. */
export function inferTaskKind(task = {}) {
  if (task.taskKind !== undefined) {
    assertSupported(task.taskKind, TASK_KINDS, "task kind");
    return task.taskKind;
  }
  if (task.mutatesWorkspace === true) return "implementation";
  const text = words(`${task.title ?? ""} ${task.prompt ?? ""} ${(task.capabilities ?? []).join(" ")} ${(task.tools ?? []).join(" ")}`);
  if (/\b(release|publish|deploy|package)\w*\b/.test(text)) return "release";
  if (/\b(integrat\w*|merge|cherry-pick|apply patch)\b/.test(text)) return "integration";
  if (/\b(tests?|testing|qa|e2e|regression|verification)\b/.test(text)) return "test";
  if (/\b(implement|modify|edit|write|fix|refactor|create|update)\b/.test(text) || /수정|구현|작성|개선|변경/.test(text)) return "implementation";
  if (/\b(review|audit|inspect|analy[sz]e)\b/.test(text) || /검토|감사|분석|점검/.test(text)) return "review";
  return "analysis";
}

export function contractFingerprint(contract) {
  const { fingerprint: _fingerprint, ...payload } = contract ?? {};
  const stable = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(stable).digest("hex").slice(0, 20);
}

export function compileExecutionContract(task = {}, defaults = {}, roleTemplate = {}) {
  const requestedTools = assertStringArray(task.tools ?? [], "tools");
  assertStringArray(task.capabilities ?? [], "capabilities");
  const taskKind = inferTaskKind(task);
  assertOptionalBoolean(task.mutatesWorkspace, "mutatesWorkspace");
  const mutatesWorkspace = task.mutatesWorkspace ?? MUTATING_TASK_KINDS.has(taskKind);
  const requestedExecutionCapabilities = task.executionCapabilities === undefined
    ? null
    : assertUniqueStringArray(task.executionCapabilities, "executionCapabilities");
  const inferredCapabilities = new Set(requestedExecutionCapabilities ?? []);
  for (const capability of acceptanceCapabilityRequirements(task)) inferredCapabilities.add(capability);
  if (mutatesWorkspace) inferredCapabilities.add("workspace-write");
  if (task.networkAccess ?? defaults.networkAccess ?? false) inferredCapabilities.add("external-network");
  if (taskKind === "test") {
    inferredCapabilities.add("process-execution");
    inferredCapabilities.add("temporary-filesystem-write");
  }
  if (requestedTools.some((tool) => ["shell", "node", "npm", "pnpm", "yarn"].includes(tool))) inferredCapabilities.add("process-execution");
  if (requestedTools.some((tool) => ["browser", "computer-use", "chrome"].includes(tool))) inferredCapabilities.add("browser-inspection");
  if ((task.integrationStrategy ?? "none") !== "none") inferredCapabilities.add("git-integration");
  for (const capability of inferredCapabilities) assertSupported(capability, EXECUTION_CAPABILITIES, "execution capability");
  const runtimeNeedsWrite = ["temporary-filesystem-write", "localhost-listen"].some((capability) => inferredCapabilities.has(capability));
  const requiredSandbox = task.requiredSandbox ?? (mutatesWorkspace || runtimeNeedsWrite ? "workspace-write" : "read-only");
  assertSupported(requiredSandbox, SANDBOXES, "required sandbox");
  const sandbox = task.sandbox ?? defaults.sandbox ?? requiredSandbox;
  assertSupported(sandbox, SANDBOXES, "sandbox");
  if (SANDBOX_LEVEL[sandbox] < SANDBOX_LEVEL[requiredSandbox]) {
    throw contractError(`Task ${task.key ?? task.title ?? "unknown"} requires ${requiredSandbox} but resolved ${sandbox}`, "EXECUTION_CONTRACT_INSUFFICIENT_SANDBOX");
  }
  const tools = [...new Set(requestedTools)];
  assertOptionalBoolean(task.networkAccess, "networkAccess");
  assertOptionalBoolean(defaults.networkAccess, "networkAccess");
  const networkAccess = Boolean(task.networkAccess ?? defaults.networkAccess ?? false);
  if (networkAccess && sandbox === "read-only") {
    throw contractError(`Task ${task.key ?? task.title ?? "unknown"} requests network access in a read-only sandbox`, "EXECUTION_CONTRACT_NETWORK_SANDBOX");
  }
  const workspaceMode = task.workspaceMode ?? defaults.workspaceMode ?? (mutatesWorkspace ? "worktree" : "shared");
  assertSupported(workspaceMode, WORKSPACE_MODES, "workspace mode");
  const integrationStrategy = task.integrationStrategy ?? (workspaceMode === "worktree" && mutatesWorkspace ? "patch" : "none");
  assertSupported(integrationStrategy, INTEGRATION_STRATEGIES, "integration strategy");
  const sideEffectPolicy = task.sideEffectPolicy ?? (mutatesWorkspace ? "workspace" : "none");
  assertSupported(sideEffectPolicy, SIDE_EFFECT_POLICIES, "side-effect policy");
  const authorizationScope = task.authorizationScope ?? defaults.authorizationScope ?? "parent_run";
  assertSupported(authorizationScope, RUN_AUTHORIZATION_SCOPES, "Run authorization scope", "EXECUTION_CONTRACT_AUTHORIZATION_SCOPE");
  const approvalPolicy = task.approvalPolicy ?? defaults.approvalPolicy ?? "never";
  assertSupported(approvalPolicy, APPROVAL_POLICIES, "approval policy");
  const outputs = [...assertStringArray(task.outputs ?? (mutatesWorkspace ? ["workspace-change"] : ["report"]), "outputs")];
  if (integrationStrategy !== "none") inferredCapabilities.add("git-integration");
  const contract = {
    version: EXECUTION_CONTRACT_VERSION,
    taskKind,
    mutatesWorkspace,
    requiredSandbox,
    sandbox,
    networkAccess,
    approvalPolicy,
    authorizationScope,
    sideEffectPolicy,
    idempotencyKey: task.idempotencyKey ?? task.key ?? null,
    workspaceMode,
    baseRef: task.baseRef ?? defaults.baseRef ?? null,
    integrationStrategy,
    outputs,
    tools,
    executionCapabilities: [...inferredCapabilities].sort(),
    roleTemplate: roleTemplate.name ?? null,
  };
  validateExecutionContract(contract);
  return { ...contract, fingerprint: contractFingerprint(contract) };
}

export function compileAndValidateExecutionContract(task = {}, defaults = {}, roleTemplate = {}) {
  return assertExecutionContract(compileExecutionContract(task, defaults, roleTemplate));
}

export function assertExecutionContract(contract) {
  validateExecutionContract(contract, { requireFingerprint: true });
  const expected = contractFingerprint(contract);
  const actualBuffer = Buffer.from(contract.fingerprint);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw contractError("Execution contract fingerprint mismatch", "EXECUTION_CONTRACT_FINGERPRINT_MISMATCH");
  }
  return contract;
}

export function executionContractFailure(error, options = {}) {
  const policy = error?.code === "EXECUTION_CONTRACT_EXTERNAL_ACTION";
  const cause = String(error?.message ?? error ?? "Invalid execution contract");
  return {
    type: policy ? "policy" : "configuration",
    category: policy ? "policy" : "configuration",
    stage: options.stage ?? "contract_validation",
    cause,
    message: cause,
    code: error?.code ?? "EXECUTION_CONTRACT_INVALID",
    retryable: false,
    nextAction: policy ? "manual_authorization" : "repair_contract",
    repairable: !policy,
    executionFingerprint: options.fingerprint ?? null,
    at: new Date().toISOString(),
  };
}
