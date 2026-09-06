import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSynthesisConsistency, evaluateTaskCompletion } from "../src/completion-evaluator.js";

const analysisContract = {
  taskKind: "analysis", mutatesWorkspace: false, workspaceMode: "shared",
  integrationStrategy: "none", outputs: ["report"], fingerprint: "analysis-fingerprint",
};

const implementationContract = {
  taskKind: "implementation", mutatesWorkspace: true, workspaceMode: "worktree",
  integrationStrategy: "patch", outputs: ["workspace-change"], fingerprint: "implementation-fingerprint",
};

test("completion rejects a failed command even when Agent prose claims success", () => {
  const verdict = evaluateTaskCompletion({
    contract: analysisContract,
    result: {
      evidenceComplete: true, output: "Everything succeeded.", turn: { status: "completed" },
      executionItems: [{ id: "cmd", type: "commandExecution", command: "node --test", exitCode: 1 }],
    },
  });
  assert.equal(verdict.decision, "reject");
  assert.equal(verdict.category, "product");
  assert.equal(verdict.cause.type, "test");
});

test("completion never assumes success when terminal Turn evidence is incomplete", () => {
  const verdict = evaluateTaskCompletion({
    contract: analysisContract,
    result: { evidenceComplete: false, output: "done", turn: { status: "completed" } },
  });
  assert.equal(verdict.decision, "attention");
  assert.deepEqual(verdict.missingEvidence, ["complete-turn"]);
  assert.equal(verdict.nextAction, "reconcile_dispatch");
});

test("incomplete evidence for a mutating Task is never replayed automatically", () => {
  const verdict = evaluateTaskCompletion({
    contract: implementationContract,
    result: { evidenceComplete: false, output: "done", turn: { status: "completed" } },
  });
  assert.equal(verdict.decision, "attention");
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.nextAction, "inspect_side_effects");
});

test("mutating completion rejects an empty worktree artifact", () => {
  const verdict = evaluateTaskCompletion({
    contract: implementationContract,
    acceptanceCriteria: ["change is implemented"],
    validation: { decision: "accept", evidence: ["reviewed"] },
    result: { evidenceComplete: true, output: "done", turn: { status: "completed" } },
    artifact: { changed: false },
    integration: { status: "integrated", artifact: { changed: false } },
  });
  assert.equal(verdict.decision, "reject");
  assert.ok(verdict.missingEvidence.includes("output:workspace-change"));
});

test("completion requires validation when acceptance criteria exist", () => {
  const verdict = evaluateTaskCompletion({
    contract: analysisContract,
    acceptanceCriteria: ["report contains evidence"],
    result: { evidenceComplete: true, output: "report", turn: { status: "completed" } },
  });
  assert.equal(verdict.decision, "reject");
  assert.ok(verdict.missingEvidence.includes("validation"));
});

test("structured test intent requires an actual test command, not an arbitrary command", () => {
  const verdict = evaluateTaskCompletion({
    contract: { ...analysisContract, taskKind: "test" },
    acceptanceCriteria: ["tests pass"],
    validation: { decision: "accept", evidence: ["claimed"] },
    result: {
      evidenceComplete: true, output: "report", turn: { status: "completed" },
      executionItems: [{ id: "cmd_echo", type: "commandExecution", command: "echo success", exitCode: 0 }],
    },
  });
  assert.equal(verdict.decision, "attention");
  assert.ok(verdict.missingEvidence.includes("required-test-command"));
});

test("destination postcondition failure overrides validation and integration success", () => {
  const verdict = evaluateTaskCompletion({
    contract: implementationContract,
    acceptanceCriteria: ["tests pass"],
    validation: { decision: "accept", evidence: ["worktree tests passed"] },
    result: { evidenceComplete: true, output: "done", turn: { status: "completed" } },
    artifact: { changed: true, commit: "abc" },
    integration: { status: "integrated", artifact: { changed: true, commit: "abc" } },
    postconditionEvidence: { required: true, passed: false, summary: "destination tests failed" },
  });
  assert.equal(verdict.decision, "reject");
  assert.ok(verdict.conflictingEvidence.includes("destination-postcondition"));
});

test("a complete non-mutating report produces a fingerprinted accept verdict", () => {
  const verdict = evaluateTaskCompletion({
    contract: analysisContract,
    result: { evidenceComplete: true, output: "structured report", turn: { status: "completed" } },
  });
  assert.equal(verdict.decision, "accept");
  assert.match(verdict.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(verdict.satisfiedEvidence.includes("output:report"));
});

test("Master synthesis cannot describe a failed Run as an overall success", () => {
  const result = evaluateSynthesisConsistency("failed", "Overall verdict: success. Every task completed.");
  assert.equal(result.consistent, false);
  assert.equal(result.runStatus, "failed");
});

test('nonzero diagnostics require exact independent review and retain warnings', () => {
  const result = { evidenceComplete:true, output:'G0 is unverified, local implementation delivered',
    turn:{status:'completed',items:[{id:'diagnostic',type:'commandExecution',command:'node scripts/g0-harness.mjs',status:'completed',exitCode:3}]}};
  const options = {result,contract:analysisContract,acceptanceCriteria:['local core works; native integration may remain unverified']};
  assert.equal(evaluateTaskCompletion({...options,phase:'execution'}).decision,'accept');
  for (const commandAssessments of [[], [{itemId:'wrong',exitCode:3,disposition:'expected_nonzero',evidence:['source']}],
    [{itemId:'diagnostic',exitCode:0,disposition:'expected_nonzero',evidence:['source']}],
    [{itemId:'diagnostic',exitCode:3,disposition:'expected_nonzero',evidence:[]}],
    [{itemId:'diagnostic',exitCode:3,disposition:'unresolved',evidence:['source']}]] ) {
    const verdict=evaluateTaskCompletion({...options,validation:{decision:'accept',commandAssessments}});
    assert.equal(verdict.decision,'attention');assert.equal(verdict.retryable,false);
  }
  const validation={decision:'accept',commandAssessments:[{itemId:'diagnostic',exitCode:3,disposition:'optional_unavailable',evidence:['inspected source: exit 3 means NOT VERIFIED; criterion permits blocked mode']} ]};
  assert.equal(evaluateTaskCompletion({...options,validation}).decision,'accept_with_warnings');
  assert.equal(evaluateTaskCompletion({...options,validation:{...validation,decision:'reject'}}).decision,'reject');
  assert.equal(evaluateTaskCompletion({...options,acceptanceCriteria:[]}).decision,'reject');
  const failedTest={...result,turn:{status:'completed',items:[{...result.turn.items[0],command:'node --test',exitCode:1}]}};
  assert.equal(evaluateTaskCompletion({...options,result:failedTest,phase:'execution'}).decision,'reject');
});
