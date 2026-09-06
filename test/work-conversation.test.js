import assert from "node:assert/strict";
import test from "node:test";
import { workContext, resultInstructions } from "../src/work-conversation.js";
import { ContextManager } from "../src/context-manager.js";
import { ControlRegistry } from "../src/registry.js";
import { dataPlaneRuntime } from "../src/runtime-environment.js";
import { evaluateTaskCompletion } from "../src/completion-evaluator.js";
import { TurnDispatcher } from "../src/turn-dispatcher.js";
import { dependencyEvidence } from "../src/task-evidence.js";

test("handoffs retain full revision reports and command provenance after an addendum", () => {
  const original = "original finding ".repeat(1000);
  const registry = {
    getTask: id => ({ id, status: "completed", prompt: "review", output: "Git addendum", metadata: {} }),
    listTurnDispatches: () => [2, 1].map(revision => ({ id: `d${revision}`, revision, status: "completed", turnId: `turn${revision}`,
      evidence: { result: { output: revision === 1 ? original : "Git addendum", executionItems: [{ type: "commandExecution", command: "node --test requested.js", exitCode: 0 }, { type: "userMessage", text: "exclude prompt" }] } } })),
  };
  const [handoff] = dependencyEvidence(registry, { dependencies: [{ taskId: "review" }] });
  assert.equal(handoff.taskId, "review");
  assert.equal(handoff.status, "completed");
  assert.deepEqual(handoff.reports.map(report => report.revision), [1, 2]);
  assert.equal(handoff.reports[0].output, original);
  assert.equal(handoff.reports[0].executionItems[0].exitCode, 0);
  assert.doesNotMatch(JSON.stringify(handoff), /exclude prompt/);
});

test("ordinary work answers use prose without weakening named-output or execution evidence", () => {
  assert.match(resultInstructions({ outputs: ["report", "workspace-change"] }), /readable final answer, not a JSON/);
  assert.match(resultInstructions({ outputs: ["audit_report"] }), /exact named report fields/);
  const result = { output: "검토 결과입니다.", evidenceComplete: true, turn: { status: "completed" } };
  assert.equal(evaluateTaskCompletion({ result, contract: { outputs: ["report"] } }).decision, "accept");
  assert.equal(evaluateTaskCompletion({ result, contract: { outputs: ["audit_report"] } }).decision, "reject");
  assert.equal(evaluateTaskCompletion({ result, contract: { taskKind: "test", outputs: ["report"] } }).decision, "attention");
});

test("execution context excludes historical reports but retains explicitly supplied dependencies", () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    registry.upsertMemory({ id: "rule", cwd: "/repo", kind: "constraint", content: "Preserve unrelated changes", source: "user" });
    registry.upsertMemory({ id: "old", cwd: "/repo", kind: "task_result", content: "OLD_REPORT", source: "agent" });
    const manager = new ContextManager(registry);
    const pack = manager.build({ cwd: "/repo", prompt: "현재 파일을 검토해주세요.", excludeTaskResults: true });
    assert.equal(pack.memories.some(m => m.id === "old"), false);
    const context = workContext({ contextManager: manager, contextPack: pack, runtime: dataPlaneRuntime(),
      contract: { outputs: ["report"] }, handoffs: [{ taskId: "current", status: "rejected", output: "CURRENT_DEPENDENCY" }], rework: { feedback: "Check missing evidence" },
      acceptanceCriteria: ["Record HEAD before and after"], previousReports: [{ output: "Initial finding" }] });
    assert.doesNotMatch(JSON.stringify(context), /OLD_REPORT|현재 파일을 검토해주세요/);
    assert.match(context.threadhub_project.value, /Preserve unrelated changes/);
    assert.match(context.threadhub_handoffs.value, /CURRENT_DEPENDENCY/);
    assert.equal(context.threadhub_handoffs.kind, "untrusted");
    assert.equal(context.threadhub_rework.kind, "untrusted");
    assert.match(context.threadhub_policy.value, /Do not request another Start/);
    assert.match(context.threadhub_policy.value, /no matches inferred from exit code 1; output not available/);
    assert.match(context.threadhub_acceptance.value, /Record HEAD before and after/);
    assert.match(context.threadhub_previous_reports.value, /Initial finding/);
    assert.match(context.threadhub_review_policy.value, /complete corrected report/);
    assert.equal(context.threadhub_dependency_receipt.kind, "application");
    assert.deepEqual(JSON.parse(context.threadhub_dependency_receipt.value).dependencies[0], {
      taskId: "current", status: "rejected", completedAt: null, reportRevisions: [],
    });
  } finally { registry.close(); }
});

test("dispatch preserves private context and rejects changed context before execution", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const dispatcher = new TurnDispatcher({ registry });
    const options = { subjectType: "task", subjectId: "context-task", purpose: "execution", revision: 1,
      prompt: "파일을 검토해주세요.", additionalContext: { rule: { kind: "application", value: "Read only" } } };
    const prepared = dispatcher.prepare(options);
    assert.deepEqual(prepared.evidence.additionalContext, options.additionalContext);
    const changed = dispatcher.prepare({ ...options, revision: undefined, additionalContext: { rule: { kind: "application", value: "New revision" } } });
    assert.equal(changed.revision, 2);
    await assert.rejects(dispatcher.execute({ ...options, additionalContext: { rule: { kind: "application", value: "Changed" } } }), { code: "TURN_DISPATCH_CONTEXT_MISMATCH" });
    let seen;
    await dispatcher.execute({ ...options, acquireThread: async () => ({ id: "context-thread" }), control: {
      runTask: async (id, prompt, runOptions) => {
        assert.equal(runOptions.clientUserMessageId, prepared.id);
        seen = { prompt, context: runOptions.additionalContext };
        return { output: "검토했습니다.", turnId: "context-turn", turn: { status: "completed" } };
      },
    } });
    assert.deepEqual(seen, { prompt: options.prompt, context: options.additionalContext });
  } finally { registry.close(); }
});

test("uncertain submission recovery never binds identical prose from another context", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  try {
    const dispatcher = new TurnDispatcher({ registry });
    const dispatch = dispatcher.beginThreadAcquisition({ subjectType: "task", subjectId: "uncertain", purpose: "execution",
      prompt: "Review this", additionalContext: { policy: { kind: "application", value: "Current context" } } });
    await dispatcher.acquireThread(dispatch.id, async () => ({ id: "review-thread" }));
    registry.transitionTurnDispatch(dispatch.id, "turn_submitting", {}, { ownerToken: dispatch.ownerToken });
    const turn = { id: "old-turn", status: "completed", items: [{ id: "native-id", clientId: "other-submission", type: "userMessage", content: [{ type: "text", text: "Review this" }] }] };
    const control = { inspectAgent: async () => ({ thread: { turns: [turn] } }) };
    assert.equal((await dispatcher.reconcile(dispatch.id, control)).result, null);
    turn.items[0].clientId = dispatch.id;
    assert.equal((await dispatcher.reconcile(dispatch.id, control)).result.turnId, "old-turn");
  } finally { registry.close(); }
});
