import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionsFromRollout, readParentPermissions, inheritPermissions, permissionRunOptions } from '../src/parent-permissions.js';
import { compileAndValidateExecutionContract } from '../src/execution-contracts.js';
import { McpControlServer } from '../src/mcp-server.js';
import { ControlRegistry } from '../src/registry.js';
const origin = { threadId: 'parent', turnId: 'current' };
const rollout = (sandbox = 'danger-full-access', approval = 'never') => [
 { type: 'session_meta', payload: { id: 'parent' } },
 { type: 'turn_context', payload: { turn_id: 'old', sandbox_policy: { type: 'read-only' }, approval_policy: 'on-request' } },
 { type: 'turn_context', payload: { turn_id: 'current', sandbox_policy: { type: sandbox }, approval_policy: approval } },
].map(JSON.stringify).join('\n');

test('native request turn selects current permissions and rejects mismatched identities', () => {
 const p = permissionsFromRollout(rollout(), origin);
 assert.equal(p.sandbox, 'danger-full-access'); assert.equal(p.networkAccess, true);
 assert.equal(permissionsFromRollout(rollout(), { threadId: 'parent' }).turnId, 'current');
 for (const bad of [{ threadId: 'foreign' }, { ...origin, turnId: 'missing' }]) assert.throws(() => permissionsFromRollout(rollout(), bad), /matching native/);
 assert.throws(() => permissionsFromRollout(rollout('external-sandbox'), origin), /unsupported sandbox/);
});

test('parent runtime authority applies to reviews and writes without changing task side effects', () => {
 const p = permissionsFromRollout(rollout(), origin);
 for (const taskKind of ['analysis', 'implementation', 'test']) {
  const c = compileAndValidateExecutionContract(inheritPermissions({ taskKind, sandbox: 'read-only', networkAccess: false }, p));
  assert.equal(c.sandbox, 'danger-full-access'); assert.equal(c.networkAccess, true);
  assert.equal(c.mutatesWorkspace, taskKind === 'implementation');
  assert.deepEqual(permissionRunOptions(c, '/repo').sandboxPolicy, { type: 'dangerFullAccess' });
 }
 const limited = permissionsFromRollout(rollout('read-only', 'on-request'), origin);
 assert.throws(() => compileAndValidateExecutionContract(inheritPermissions({ taskKind: 'implementation', sandbox: 'danger-full-access' }, limited)), /requires workspace-write/);
 assert.equal(inheritPermissions({ sandbox: 'danger-full-access' }, limited).approvalPolicy, 'on-request');
});

test('native permission lookup is observation-only and rejects a wrong host path identity', async () => {
 const root = mkdtempSync(join(tmpdir(), 'hub-parent-'));
 try {
  const path = join(root, 'native.jsonl'); writeFileSync(path, rollout());
  const control = { inspectAgent: async id => ({ thread: { id, path } }) };
  assert.equal((await readParentPermissions(control, origin)).sandbox, 'danger-full-access');
  await assert.rejects(readParentPermissions(control, { threadId: 'foreign' }), /matching native/);
  assert.equal(await readParentPermissions(control, null), null);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prepared graph inherits parent authority durably and sends full access at worker execution', async () => {
 const root = mkdtempSync(join(tmpdir(), 'hub-inherit-'));
 const path = join(root, 'native.jsonl'); writeFileSync(path, rollout());
 const calls = [];
 const control = {
  connect: async () => {}, inspectAgent: async id => ({ thread: { id, path } }),
  spawnAgent: async options => { calls.push(['spawn', options]); return { id: 'child', cwd: root, status: 'idle' }; },
  nameAgent: async () => {},
  runTask: async (id, prompt, options) => { calls.push(['turn', options]); options.onStarted?.({ turnId: 'child-turn' }); return { output: 'Done', turnId: 'child-turn', turn: { status: 'completed' } }; },
 };
 const server = new McpControlServer({ controlFactory: () => ({ control, client: { close: async () => {} } }), registry: new ControlRegistry({ path: ':memory:' }), recoverInterruptedTasks: false,
  dashboardServer: { start: async () => {}, url: () => 'http://dashboard', close: async () => {} } });
 try {
  const result = await server.handleRequest({ method: 'tools/call', params: { name: 'prepare_agent_run', _meta: { 'codex/origin': origin }, arguments: { cwd: root, requestKey: 'inherit-once', tasks: [{ key: 'report', prompt: 'Read files and report', taskKind: 'analysis', sandbox: 'read-only' }] } } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const run = server.registry.getRun(result.structuredContent.runId);
  assert.equal(run.metadata.parentPermissions.threadId, 'parent');
  const task = server.registry.listTasks({ runId: run.id })[0];
  assert.equal(task.metadata.executionContract.sandbox, 'danger-full-access');
  const deadline = Date.now() + 3000;
  while (!calls.some(c => c[0] === 'turn') && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.find(c => c[0] === 'spawn')[1].sandbox, 'danger-full-access');
  assert.deepEqual(calls.find(c => c[0] === 'turn')[1].sandboxPolicy, { type: 'dangerFullAccess' });
 } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('planner, validator and synthesizer inherit full access while keeping their role instructions', async () => {
 const { PlannerEngine } = await import('../src/planner-engine.js');
 const { ResultValidator } = await import('../src/result-validator.js');
 const { ContextManager } = await import('../src/context-manager.js');
 const { RoleTemplateManager } = await import('../src/role-templates.js');
 const registry = new ControlRegistry({ path: ':memory:' });
 const roles = new RoleTemplateManager(registry); roles.seedBuiltins();
 const p = permissionsFromRollout(rollout(), origin), calls = [];
 let index = 0;
 const control = {
  spawnAgent: async options => { calls.push(['spawn', options]); return { id: 'role-' + ++index, cwd: '/repo' }; },
  resumeAgent: async (id, options) => { calls.push(['resume', options]); return { id, cwd: '/repo' }; },
  runTask: async (_id, _prompt, options) => {
   calls.push(['turn', options]); options.onStarted?.({ turnId: 'turn-' + index });
   const properties = options.outputSchema.properties;
   const output = properties.tasks ? { summary: 'Review', risks: [], tasks: [{ key: 'review', prompt: 'Read', taskKind: 'analysis' }] }
    : properties.decision ? { decision: 'accept', failureKind: 'none', summary: 'Checked', evidence: ['source'], unmetCriteria: [], commandAssessments: [] }
    : { status: 'completed', summary: 'Done', evidence: [], unresolvedRisks: [], followUps: [] };
   return { output: JSON.stringify(output), turnId: 'turn-' + index, turn: { status: 'completed' } };
  },
 };
 try {
  const planner = new PlannerEngine({ registry, contextManager: new ContextManager(registry), roleTemplates: roles, getControl: async () => control, decorateAgent: async () => {} });
  const plan = await planner.plan({ objective: 'Read', cwd: '/repo', parentPermissions: p });
  await planner.synthesize(plan.id, []);
  registry.createTask({ id: 'validate', status: 'validating', prompt: 'Read', metadata: { parentPermissions: p } });
  const validator = new ResultValidator({ registry, roleTemplates: roles, getControl: async () => control, decorateAgent: async () => {} });
  await validator.validate({ taskId: 'validate', cwd: '/repo', prompt: 'Read', output: 'Done', acceptanceCriteria: ['Report findings'] });
  assert.equal(calls.filter(c => c[0] === 'spawn').length, 3);
  for (const [kind, options] of calls) {
   assert.equal(options.approvalPolicy, 'never');
   if (kind === 'turn') assert.deepEqual(options.sandboxPolicy, { type: 'dangerFullAccess' });
   else assert.equal(options.sandbox, 'danger-full-access');
  }
  assert.match(calls.filter(c => c[0] === 'spawn').at(-1)[1].developerInstructions, /Never implement fixes/);
 } finally { registry.close(); }
});

test('known parent lookup failure blocks dispatch before creating any work', async () => {
 const server = new McpControlServer({ controlFactory: () => ({ control: { connect: async () => {}, inspectAgent: async () => { throw new Error('unavailable'); } }, client: { close: async () => {} } }), registry: new ControlRegistry({ path: ':memory:' }), recoverInterruptedTasks: false });
 try {
  const response = await server.handleRequest({ method: 'tools/call', params: { name: 'dispatch_control_request', _meta: { 'codex/origin': origin }, arguments: { objective: 'Do work', cwd: '/repo' } } });
  assert.equal(response.isError, true);
  assert.equal(server.registry.listRuns().length, 0);
  assert.equal(server.registry.listTasks().length, 0);
  assert.equal(server.registry.listAgents().length, 0);
 } finally { await server.close(); }
});
