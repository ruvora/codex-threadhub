import { randomUUID } from "node:crypto";
import { agentDisplayName } from "./agent-names.js";
import { ContextResolver } from "./context-resolver.js";
import { ThreadKnowledgeIndexer } from "./thread-knowledge-indexer.js";
import { compileAndValidateExecutionContract, EXECUTION_CAPABILITIES, RUN_AUTHORIZATION_SCOPES, SIDE_EFFECT_POLICIES } from "./execution-contracts.js";
import { TurnDispatcher } from "./turn-dispatcher.js";

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "risks", "tasks"],
  properties: {
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "prompt", "role", "capabilities", "tools", "dependsOn", "dependencyPolicy", "workspaceMode", "acceptanceCriteria", "taskKind", "mutatesWorkspace", "networkAccess", "sideEffectPolicy", "authorizationScope", "executionCapabilities", "outputs", "integrationStrategy"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string" },
          role: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string", enum: ["shell", "filesystem"] } },
          dependsOn: { type: "array", items: { type: "string" } },
          dependencyPolicy: { type: "string", enum: ["all_success", "all_terminal", "on_failure"] },
          workspaceMode: { type: "string", enum: ["shared", "worktree"] },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          taskKind: { type: "string", enum: ["analysis", "implementation", "test", "review", "integration", "release"] },
          mutatesWorkspace: { type: "boolean" },
          networkAccess: { type: "boolean" },
          sideEffectPolicy: { type: "string", enum: SIDE_EFFECT_POLICIES },
          authorizationScope: { type: "string", enum: RUN_AUTHORIZATION_SCOPES },
          executionCapabilities: { type: "array", items: { type: "string", enum: EXECUTION_CAPABILITIES } },
          outputs: { type: "array", items: { type: "string" } },
          integrationStrategy: { type: "string", enum: ["none", "patch", "commit"] },
        },
      },
    },
  },
};

const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "evidence", "unresolvedRisks", "followUps"],
  properties: {
    status: { type: "string", enum: ["completed", "partial", "failed"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    unresolvedRisks: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
  },
};

function parseJsonOutput(output) {
  const value = String(output ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!value) throw new Error("Planner returned no structured output");
  return JSON.parse(value);
}

const ADDITIONAL_START_PATTERNS = [
  /\b(?:wait(?:s|ing)?\s+for|request(?:s|ing)?|ask(?:s|ing)?\s+for|require(?:s|d|ing)?|need(?:s|ed|ing)?|confirm(?:s|ed|ing)?|approve(?:s|d|ing)?)\b.{0,64}\b(?:another|additional|separate|second)\b.{0,32}\bstart\b/i,
  /\b(?:another|additional|separate|second)\b.{0,32}\bstart\b.{0,40}\b(?:is\s+)?(?:required|needed|confirmed|approved|must\s+happen)\b/i,
  /(?:별도|추가|다시|두\s*번째).{0,40}(?:Start|시작\s*승인|작업\s*시작).{0,48}(?:필요(?:하다|함|한|합니다)?|요구(?:하다|함|한|합니다)?|확인(?:하다|함|한|합니다)?|승인(?:을|이)?\s*받|받은\s*후|해야\s*(?:한다|함|합니다)?|기다(?:린|려|립니다))/i,
  /(?:반드시|필수로).{0,64}(?:별도|추가|다시|두\s*번째).{0,40}(?:Start|시작\s*승인|작업\s*시작)/i,
];
const NEGATED_ADDITIONAL_START_PATTERN = /(?:\bnever\b|\bmust\s+not\b|\bdo(?:es)?\s+not\b|\bwithout\b|\bnot\s+(?:required|needed|allowed)\b|\bno\b.{0,40}\b(?:another|additional|separate|second)\b|(?:요구|요청|호출|확인|승인|기다리|필요)하지\s*않|하지\s*(?:않|말)|(?:추가|별도).{0,24}없이|불필요|금지)/i;

function statementRequestsAdditionalStart(statement) {
  if (/\b(?:instead of|rather than)\b/i.test(statement)) return false;
  if (NEGATED_ADDITIONAL_START_PATTERN.test(statement)) return false;
  return ADDITIONAL_START_PATTERNS.some((pattern) => pattern.test(statement));
}

// Prose is advisory only: punctuation and negation cannot grant or revoke authority.
function diagnoseSingleRunStart(plan) {
  return (plan?.tasks ?? []).flatMap((task) => {
    const statements = [task.prompt, ...(task.acceptanceCriteria ?? [])]
      .filter(Boolean)
      .flatMap((value) => String(value).split(/[.!?。\n;；]+/));
    return statements.filter(statementRequestsAdditionalStart).map((statement) => ({
      code: "PLAN_START_PROSE_WARNING", taskKey: task.key, statement: statement.trim(),
      severity: "warning", blocking: false,
    }));
  });
}

function assertSingleRunStart(plan) {
  // Omitted scope follows the existing execution-contract compiler default.
  const violations = (plan?.tasks ?? []).filter((task) =>
    task.authorizationScope !== undefined && task.authorizationScope !== "parent_run");
  if (!violations.length) return;
  const error = new Error(`Invalid Run authorization scope in tasks: ${violations.map((task) => task.key).join(", ")}`);
  error.code = "EXECUTION_CONTRACT_AUTHORIZATION_SCOPE";
  throw error;
}

function assertPlanExecutionContracts(plan, roleTemplates) {
  for (const task of plan?.tasks ?? []) {
    const roleTemplate = roleTemplates.resolve(task.role);
    compileAndValidateExecutionContract(task, {}, roleTemplate);
  }
}

export class PlannerEngine {
  constructor(options) {
    this.registry = options.registry;
    this.contextManager = options.contextManager;
    this.contextResolver = options.contextResolver ?? new ContextResolver(options.registry);
    this.threadKnowledgeIndexer = options.threadKnowledgeIndexer ?? new ThreadKnowledgeIndexer(options.registry);
    this.roleTemplates = options.roleTemplates;
    this.getControl = options.getControl;
    this.decorateAgent = options.decorateAgent;
    this.turnDispatcher = options.turnDispatcher ?? new TurnDispatcher({ registry: this.registry, instanceId: options.instanceId });
  }

  async plan(options) {
    const id = options.planId ?? `plan_${randomUUID()}`;
    const existing = options.requestKey ? this.registry.listPlans({ limit: 200 }).find((plan) => plan.requestKey === options.requestKey) : null;
    if (existing?.status === "planned" && existing.plan?.tasks?.length) return existing;
    const targetId = existing?.id ?? id;
    if (!existing) this.registry.createPlan({ id: targetId, requestKey: options.requestKey, objective: options.objective, cwd: options.cwd, metadata: { constraints: options.constraints ?? [], requestedThreadIds: options.requestedThreadIds ?? [], requiredContextSubjects: options.requiredContextSubjects ?? [] } });
    else this.registry.updatePlan(targetId, { status: "planning", metadata: { resumedAt: new Date().toISOString() } });
    try {
      const snapshot = options.contextSnapshot
        ? this.contextResolver.assertSnapshot(options.contextSnapshot)
        : await this.#resolveContext({
          objective: options.objective, cwd: options.cwd, requiredSubjects: options.requiredContextSubjects,
          requestedThreadIds: options.requestedThreadIds, maxContextBudget: options.maxContextBudget,
        });
      this.registry.updatePlan(targetId, { metadata: { contextSnapshotId: snapshot.id, contextSnapshotFingerprint: snapshot.fingerprint } });
      return await this.#invoke(targetId, null, snapshot, options.runId ?? null);
    } catch (error) {
      this.registry.updatePlan(targetId, { status: "failed", metadata: { error: error.message } });
      throw error;
    }
  }

  async revise(planId, feedback, options = {}) {
    const plan = this.registry.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    this.registry.updatePlan(planId, { status: "revising", feedback });
    try {
      const snapshot = await this.#resolveContext({
        objective: plan.objective, cwd: plan.cwd, objectiveRevision: plan.version + 1,
        requiredSubjects: plan.metadata?.requiredContextSubjects,
        requestedThreadIds: plan.metadata?.requestedThreadIds,
      });
      this.registry.updatePlan(planId, { metadata: { contextSnapshotId: snapshot.id, contextSnapshotFingerprint: snapshot.fingerprint } });
      return await this.#invoke(planId, feedback, snapshot, options.runId ?? null);
    } catch (error) {
      this.registry.updatePlan(planId, { status: "failed", metadata: { error: error.message } });
      throw error;
    }
  }

  async synthesize(planId, tasks) {
    const plan = this.registry.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    const run = plan.metadata?.runId ? this.registry.getRun(plan.metadata.runId) : null;
    const expectedStatus = run?.status === "completed" ? "completed" : run ? "failed" : null;
    const control = await this.getControl();
    const prompt = [
      "Synthesize this completed control-plane run. Return only JSON matching the supplied schema.",
      expectedStatus ? `The durable Run verdict is ${expectedStatus}. Your status must match it and cannot be changed by prose.` : null,
      `Objective: ${plan.objective}`,
      `Plan: ${JSON.stringify(plan.plan)}`,
      `Task results: ${JSON.stringify(tasks.map((task) => ({
        id: task.id,
        status: task.status,
        title: task.metadata?.title ?? task.title ?? null,
        output: task.output ?? task.result ?? null,
        error: task.error ?? null,
        validation: task.metadata?.validation ?? null,
        completionVerdict: task.metadata?.completionVerdict ?? null,
      })))}`,
    ].filter(Boolean).join("\n\n");
    const result = await this.turnDispatcher.execute({
      subjectType: "plan", subjectId: planId, purpose: "synthesis", planId,
      parentRunId: plan.metadata?.runId ?? null, prompt, control, allowTerminalParent: true,
      acquireThread: async (threadId) => (await this.#ensureAgent(plan.cwd, "synthesizer", threadId, control)).agent,
      runOptions: { cwd: plan.cwd, outputSchema: SYNTHESIS_SCHEMA, approvalPolicy: "never" },
    });
    const reported = parseJsonOutput(result.output);
    const synthesis = expectedStatus && reported.status !== expectedStatus
      ? {
        status: expectedStatus,
        summary: `Run ${run.status}: Synthesizer output contradicted the durable Run verdict.`,
        evidence: tasks.map((task) => `${task.id}:${task.status}`),
        unresolvedRisks: [...new Set([...(reported.unresolvedRisks ?? []), "synthesis_status_mismatch"])],
        followUps: [],
        consistency: { consistent: false, expectedStatus, reportedStatus: reported.status, reported },
      }
      : { ...reported, consistency: { consistent: true, expectedStatus, reportedStatus: reported.status } };
    return this.registry.updatePlan(planId, { status: "synthesized", synthesis, completedAt: new Date().toISOString() });
  }

  async #invoke(planId, feedback, contextSnapshot, runId = null) {
    const plan = this.registry.getPlan(planId);
    const validatedSnapshot = this.contextResolver.assertSnapshot(contextSnapshot ?? plan.metadata?.contextSnapshotId);
    const context = this.contextManager.build({ cwd: plan.cwd, prompt: plan.objective, role: "planner", touch: true });
    const control = await this.getControl();
    const basePrompt = [
      "Create or revise an executable control-plane task graph. Return only JSON matching the supplied schema.",
      `Objective: ${plan.objective}`,
      feedback ? `Revision feedback: ${feedback}` : null,
      plan.plan ? `Previous plan: ${JSON.stringify(plan.plan)}` : null,
      `Validated context snapshot (${validatedSnapshot.id}, fingerprint=${validatedSnapshot.fingerprint}):\n${this.contextResolver.format(validatedSnapshot)}`,
      `Project context:\n${this.contextManager.format(context)}`,
      "Use worktree workspace mode for concurrent file-writing tasks. Follow-up work must never start automatically.",
      "The user Start gate applies exactly once to the parent Run. Every dependency task, validator, retry, and rework must execute under that existing authorization and must never request another, additional, separate, or second Start.",
      "Set authorizationScope to parent_run for every task. This structured field is the authoritative authorization contract; task prose must not contradict it.",
      "Declare taskKind, mutatesWorkspace, networkAccess, sideEffectPolicy, executionCapabilities, outputs, integrationStrategy, and dependencyPolicy explicitly. executionCapabilities separates process-execution, temporary-filesystem-write, localhost-connect, localhost-listen, external-network, browser-inspection, workspace-write, and git-integration. A test that does not modify project files may still require temporary-filesystem-write or localhost-listen and therefore a writable runtime sandbox. This runtime cannot grant localhost-listen inside workspace-write with networkAccess=false. Never increase networkAccess or sandbox authority to work around this. Prefer socket-free unit tests where appropriate and report socket integration tests as requiring an authorized host, not as passed. Browser acceptance criteria require browser-inspection and a browser-capable tool. sideEffectPolicy=none means observation or computation only; local-runtime means lifecycle changes limited to this product's local daemon/process/socket; workspace means project file changes; external means changing remote services or other external systems; destructive means difficult-to-recover deletion or overwrite. Reading local process, socket, MCP, or health state is none. Normal automatic startup of this product's local daemon is local-runtime, never external. External and destructive tasks are outside automatic Run dispatch.",
      "Use all_terminal for always-run cleanup/reporting and on_failure for fallback work. Role names describe specialization and never grant permissions.",
      "Task prompts are visible user messages. Write concise, natural work requests in the user's language: goal, relevant scope and deliverables. Put verification requirements in acceptanceCriteria. Do not copy authorization boilerplate, internal role names, runtime instructions, past reports, JSON output instructions or daemon protocols into task prompts. Prefer outputs=[report] for ordinary readable reports; use custom named fields only when a consumer genuinely requires that structured interface.",
      "Worker tools use canonical identifiers shell and filesystem only. Do not put API names, prose, or A2A discovery instructions into tools. The daemon supplies dependency outputs; workers do not call the Control Plane plugin. Use report or descriptive report field names for outputs. Only taskKind=test requires actual test commands, not review or synthesis.",
    ].filter(Boolean).join("\n\n");
    let materialized;
    let contractError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = [
        basePrompt,
        contractError ? `Your previous graph violated the Run authorization contract: ${contractError.message}. Correct every affected task and return the complete JSON graph again.` : null,
      ].filter(Boolean).join("\n\n");
      let activeAgent;
      const result = await this.turnDispatcher.execute({
        subjectType: "plan", subjectId: planId, purpose: "planning", planId, parentRunId: runId,
        prompt, contextSnapshotId: validatedSnapshot.id, control,
        acquireThread: async (threadId) => {
          activeAgent = (await this.#ensureAgent(plan.cwd, "planner", threadId ?? plan.plannerAgentId, control)).agent;
          return activeAgent;
        },
        onThread: ({ agent: boundAgent, dispatch }) => {
          activeAgent = boundAgent;
          this.registry.updatePlan(planId, {
            plannerAgentId: boundAgent.id,
            metadata: { activeTurnDispatchId: dispatch.id, runId: runId ?? plan.metadata?.runId ?? null },
          });
        },
        runOptions: { cwd: plan.cwd, outputSchema: PLAN_SCHEMA, approvalPolicy: "never" },
      });
      materialized = parseJsonOutput(result.output);
      if (!materialized || !Array.isArray(materialized.tasks) || materialized.tasks.length === 0) {
        throw new Error("Planner returned an invalid graph without tasks");
      }
      try {
        assertSingleRunStart(materialized);
        assertPlanExecutionContracts(materialized, this.roleTemplates);
        contractError = null;
        break;
      } catch (error) {
        contractError = error;
      }
    }
    if (contractError) throw contractError;
    return this.registry.updatePlan(planId, {
      status: "planned",
      version: plan.version + (feedback ? 1 : 0),
      plannerAgentId: this.registry.getPlan(planId).plannerAgentId,
      plan: materialized,
      feedback: feedback ?? plan.feedback,
      metadata: {
        contextMemoryIds: context.memories.map((item) => item.id),
        startPolicyDiagnostics: diagnoseSingleRunStart(materialized),
        contextSnapshotId: validatedSnapshot.id,
        contextSnapshotFingerprint: validatedSnapshot.fingerprint,
      },
    });
  }

  async #ensureAgent(cwd, role, preferredId = null, suppliedControl = null) {
    const control = suppliedControl ?? await this.getControl();
    const template = this.roleTemplates.resolve(role);
    let agent;
    if (preferredId) {
      try {
        agent = await control.resumeAgent(preferredId, { cwd, sandbox: template.sandbox, approvalPolicy: template.approvalPolicy, model: template.model });
      } catch {
        agent = null;
      }
    }
    if (!agent) {
      agent = await control.spawnAgent({ cwd, sandbox: template.sandbox, approvalPolicy: template.approvalPolicy, model: template.model, developerInstructions: template.developerInstructions });
      await this.decorateAgent(control, agent, agentDisplayName(role, String(cwd ?? "workspace").split("/").pop()), false);
    }
    this.registry.upsertAgent({ ...agent, status: "idle" }, { role, capabilities: template.capabilities, metadata: { tools: template.tools, controlPlane: true } });
    return { control, agent };
  }

  async #resolveContext(options) {
    if (options.requestedThreadIds?.length) {
      const control = await this.getControl();
      await this.threadKnowledgeIndexer.indexMany(control, { threadIds: options.requestedThreadIds, cwd: options.cwd });
    }
    return this.contextResolver.resolve(options);
  }
}

export { PLAN_SCHEMA, SYNTHESIS_SCHEMA, parseJsonOutput, assertSingleRunStart, diagnoseSingleRunStart };
