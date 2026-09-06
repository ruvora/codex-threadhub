import test from 'node:test';
import assert from 'node:assert/strict';
import { workStatus, workSummary } from '../src/work-status.js';

const id = '01a070b9-4fce-7402-9299-bd5f88ebc539';
function status(tasks, metadata = {}, agentId = id) {
  return workStatus({ listTasks: () => tasks, getAgent: () => ({ id: agentId }) },
    { id: 'run', name: 'Work', status: 'running', metadata });
}
test('single work offers its real link without a default dashboard', () => {
  const r = status([{ agentId: id, status: 'running' }]);
  assert.equal(r.presentation.kind, 'single');
  assert.equal(r.presentation.workUrl, `codex://threads/${id}`);
  assert.equal(r.presentation.initialPanel, null);
});
test('orchestrated work offers a run-scoped compact panel handoff', () => {
  const r = status([{ status: 'running' }, { status: 'blocked' }], { orchestratorAgentId: id });
  assert.equal(r.presentation.kind, 'orchestrated');
  assert.deepEqual(r.presentation.initialPanel, { tool: 'show_work_progress', arguments: { runId: 'run' } });
  assert.equal(r.presentation.workUrl, `codex://threads/${id}`);
  assert.equal(r.presentation.opened, undefined);
});
test('preparation and missing or invalid representative never fabricate a link', () => {
  assert.deepEqual(status([]).presentation, {kind:'preparing',workUrl:null,initialPanel:null});
  assert.equal(status([{}, {}]).presentation.initialPanel, null);
  assert.equal(status([{}, {}], {orchestratorAgentId:id}, 'invalid').presentation.workUrl, null);
});

test('compact text includes the actual link and does not call terminal count success', () => {
  const work = status([{status:'completed'}, {status:'rejected',error:'보고서 확인 필요'}], {orchestratorAgentId:id});
  work.status='failed';
  const summary=workSummary(work);
  assert.match(summary,/실패 · 결과 검증 거절/);
  assert.match(summary,/성공 1\/2/);
  assert.match(summary,/검증 거절 1/);
  assert.match(summary,/보고서 확인 필요/);
  assert.ok(summary.includes(`codex://threads/${id}`));
  assert.doesNotMatch(summary,/master|slave|runId|host_action/);
});

test('preparing work acknowledges missing link without claiming a created task', () => {
  const work=status([]);
  work.status='accepted';
  assert.match(workSummary(work),/접수됨 · 작업 준비 중/);
  assert.match(workSummary(work),/아직 이동 링크가 없습니다/);
  assert.doesNotMatch(workSummary(work),/codex:\/\//);
  work.status='failed';
  assert.match(workSummary(work),/이동할 작업 대화가 없습니다/);
  assert.doesNotMatch(workSummary(work),/준비 중/);
});
