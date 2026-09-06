import assert from "node:assert/strict";
import test from "node:test";

import { assessTaskResult, classifyFailure } from "../src/failure-classifier.js";

test('search terms and filenames are not authority or runtime failure diagnostics', () => {
  for (const term of ['approvalReceipt', 'permission', 'lease', 'timeout', 'socket', 'read-only']) {
    const item = {id:'search',type:'commandExecution',command:`rg -n '${term}' src`,cwd:'/repo',exitCode:1,aggregatedOutput:''};
    const result = {turn:{status:'completed'},executionItems:[item]};
    assert.equal(assessTaskResult(result).type,'command');
    const commandReviews = [];
    assert.equal(assessTaskResult(result,{commandReviews}),null);
    assert.equal(commandReviews.length,1);
    assert.equal(commandReviews[0].command,item.command);
    assert.equal(commandReviews[0].exitCode,1);
    assert.equal(assessTaskResult({...result,executionItems:[{...item,exitCode:2,aggregatedOutput:'rg: src: Permission denied (os error 13)'}]},{commandReviews:[]}).type,'approval');
  }
});

test('redirected tests remain blocking and only the same later test invocation supersedes them', () => {
  const failed = {id:'before',type:'commandExecution',command:"/bin/zsh -lc 'node --test > docs/before.log 2>&1'",cwd:'/repo',exitCode:1};
  const passed = {...failed,id:'after',command:"/bin/zsh -lc 'node --test > docs/after.log 2>&1'",exitCode:0};
  const result = items => ({turn:{status:'completed'},executionItems:items});
  const commandReviews = [];
  assert.equal(assessTaskResult(result([failed]),{commandReviews}).type,'test');
  assert.equal(commandReviews.length,0);
  assert.equal(assessTaskResult(result([failed,passed])),null);
  for (const change of [{cwd:'/different'}, {command:"node --test focused.test.js > docs/after.log 2>&1"},
    {command:"node --test > docs/after.log 2>&1; true"}, {command:"node --test | cat"}]) {
    assert.equal(assessTaskResult(result([failed,{...passed,...change}])).type,'test');
  }
});

test("failure classification separates infrastructure, coordination, validation, and worker errors", () => {
  assert.deepEqual(classifyFailure(Object.assign(new Error("app-server exited"), { code: "ECONNRESET" })).type, "infrastructure");
  assert.equal(classifyFailure(new Error("thread already has an active writer")).type, "coordination");
  assert.equal(classifyFailure(new Error("criteria missed"), "validation").type, "validation");
  assert.equal(classifyFailure(new Error("implementation crashed")).type, "worker");
});

test("product context reference failures are canonical non-retryable configuration failures", () => {
  const failure = classifyFailure(Object.assign(new Error("Superseded context claim was not found"), {
    code: "CONTEXT_SUPERSEDE_TARGET_MISSING",
  }), "control_dispatch");
  assert.equal(failure.type, "configuration");
  assert.equal(failure.category, "configuration");
  assert.equal(failure.retryable, false);
  assert.equal(failure.nextAction, "repair_contract");
});

test("Codex response 404 and exhausted reconnects are stable retryable environment failures", () => {
  const notFound = classifyFailure(new Error("unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses"), "orchestrator_kickoff");
  assert.equal(notFound.code, "APP_SERVER_UPSTREAM_404");
  assert.equal(notFound.type, "infrastructure");
  assert.equal(notFound.category, "environment");
  assert.equal(notFound.retryable, true);

  const reconnect = classifyFailure(new Error("Reconnecting... 2/5"), "validation");
  assert.equal(reconnect.code, "APP_SERVER_RECONNECT_INTERRUPTED");
  assert.equal(reconnect.type, "infrastructure");
  assert.equal(reconnect.category, "environment");
  assert.equal(reconnect.retryable, true);
});

test("result assessment rejects completed turns with real command or test failures", () => {
  const commandFailure = assessTaskResult({
    turn: { status: "completed" },
    output: "done",
    executionItems: [{ id: "cmd_1", type: "commandExecution", command: "node --test", status: "completed", exitCode: 7 }],
  });
  assert.equal(commandFailure.type, "test");
  assert.equal(commandFailure.exitCode, 7);
  assert.equal(commandFailure.retryable, true);

  const explicitFailure = assessTaskResult({ turn: { status: "completed" }, output: '{"status":"failed","reason":"lint failed"}' });
  assert.equal(explicitFailure.type, "worker");
  assert.equal(assessTaskResult({ turn: { status: "completed" }, output: "tests: 12 passed" }), null);
});

test("sandbox EPERM in test output is classified as environment instead of product", () => {
  const failure = assessTaskResult({
    turn: { status: "completed" },
    executionItems: [{
      id: "cmd_eperm",
      type: "commandExecution",
      command: "node --test",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "Error: EPERM: operation not permitted, mkdtemp '/tmp/control-plane-test-'",
    }],
  });
  assert.equal(failure.type, "environment");
  assert.equal(failure.category, "environment");
  assert.equal(failure.retryable, false);
  assert.equal(failure.nextAction, "manual_intervention");
});

test("successful test execution is not overturned by identifiers in narrative output", () => {
  const result = assessTaskResult({
    turn: { status: "completed" },
    output: "42/42 tests passed with exit 0. failed_static_inspection remains a result field name.",
    executionItems: [{ id: "cmd_ok", type: "commandExecution", command: "node --test", status: "completed", exitCode: 0 }],
  });
  assert.equal(result, null);
});

test("standalone machine-shaped failed test summaries remain failures", () => {
  const result = assessTaskResult({ turn: { status: "completed" }, output: "42 tests failed\n" });
  assert.equal(result.type, "test");
  assert.match(result.message, /42 tests failed/);
});
