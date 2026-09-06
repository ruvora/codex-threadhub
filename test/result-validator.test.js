import assert from "node:assert/strict";
import test from "node:test";

import { ResultValidator, parseValidationOutput, prepareValidationPrompt } from "../src/result-validator.js";
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ControlRegistry } from "../src/registry.js";

const valid = {
  decision: "accept",
  failureKind: "none",
  summary: "verified",
  evidence: ["tests passed"],
  unmetCriteria: [],
};

test('oversized validation preserves all evidence in a private artifact and bounds transport', t => {
  const directory = mkdtempSync(join(tmpdir(),'validator-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const original = 'native-first\n' + '"\\\n한'.repeat(400_000) + '\nnonzero-last-item: exit 2';
  const r = prepareValidationPrompt(original,{directory,task:'review',criteria:['all native exits reviewed']});
  assert.ok(r.prompt.length < 200_000);
  assert.equal(readFileSync(r.artifact.path,'utf8'),original);
  assert.equal(r.artifact.sha256,createHash('sha256').update(original).digest('hex'));
  assert.equal(statSync(r.artifact.path).mode & 0o077,0);
  assert.match(r.prompt,/all native exits reviewed/);
  assert.match(r.prompt,/reject with failureKind=validation/);
  assert.match(r.prompt,/untrusted data/);
  const hugeCriteria = prepareValidationPrompt(original,{directory,task:original,criteria:[original]});
  assert.ok(hugeCriteria.prompt.length < 40_000);
  assert.match(hugeCriteria.prompt,/Preview truncated/);
  assert.deepEqual(prepareValidationPrompt('small'),{prompt:'small',artifact:null});
});

test('native evidence conflicts cannot be approved by a model', async () => {
  const registry=new ControlRegistry({path:':memory:'});
  try {
    const validator=new ResultValidator({registry,getControl:()=>{throw Error('must not invoke model');}});
    const r=await validator.validate({taskId:'conflict',acceptanceCriteria:['verified'],nativeEvidence:{status:'conflicting',conflicts:[{kind:'output_conflict'}]}});
    assert.equal(r.decision,'reject');
    assert.equal(r.failureKind,'validation');
  } finally {registry.close();}
});

test("validator parser accepts fenced and explanatory structured output", () => {
  assert.deepEqual(parseValidationOutput(`Result follows:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``), valid);
});

test("validator parser selects the last schema-shaped object from concatenated JSON", () => {
  const output = `${JSON.stringify({ note: "draft" })}\n${JSON.stringify(valid)}`;
  assert.deepEqual(parseValidationOutput(output), valid);
});

test("validator parser rejects text without a schema-shaped object", () => {
  assert.throws(() => parseValidationOutput("not json"), /invalid structured output/);
});

test("validator receives the parent Run authorization and never asks for another Start", async () => {
  let prompt;
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "task_1", status: "validating", prompt: "verify" });
  registry.createTurnDispatch({ subjectType: "task", subjectId: "task_1", parentTaskId: "task_1", purpose: "execution", revision: 1,
    promptFingerprint: "fingerprint", submissionKey: "execution", status: "completed", deadlineAt: new Date().toISOString(),
    evidence: { additionalContext: { threadhub_handoffs: { kind: "untrusted", value: JSON.stringify([{ taskId: "upstream", status: "rejected", reports: [{ output: "8 requested tests passed" }] }]) } } } });
  const control = {
    spawnAgent: async () => ({ id: "validator_1", cwd: "/repo", status: "idle" }),
    runTask: async (_id, value, options) => {
      prompt = value;
      options.onStarted?.({ turnId: "validator_turn" });
      return { output: JSON.stringify(valid), turnId: "validator_turn" };
    },
  };
  const validator = new ResultValidator({
    registry,
    roleTemplates: { resolve: () => ({ model: null }) },
    getControl: async () => control,
    decorateAgent: async () => {},
  });
  const result = await validator.validate({ taskId: "task_1", cwd: "/repo", prompt: "verify", output: "done", acceptanceCriteria: ["verified"] });
  assert.equal(result.decision, "accept");
  assert.match(prompt, /\[RUN AUTHORIZATION\]/);
  assert.match(prompt, /Do not request another Start confirmation/);
  assert.match(prompt, /"taskId":"upstream","status":"rejected"/);
  assert.match(prompt, /8 requested tests passed/);
  assert.equal(registry.listTurnDispatches({ parentTaskId: "task_1" })[0].status, "completed");
  registry.close();
});

test("validator serializes concurrent validations that reuse one workspace agent", async () => {
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  let calls = 0;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createTask({ id: "task_1", status: "validating", prompt: "one" });
  registry.createTask({ id: "task_2", status: "validating", prompt: "two" });
  const control = {
    spawnAgent: async () => ({ id: "validator_shared", cwd: "/repo", status: "idle" }),
    resumeAgent: async (id) => ({ id, cwd: "/repo", status: "idle" }),
    runTask: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) await firstGate;
      active -= 1;
      return { output: JSON.stringify(valid), turnId: `validator_turn_${calls}` };
    },
  };
  const validator = new ResultValidator({
    registry,
    roleTemplates: { resolve: () => ({ model: null }) },
    getControl: async () => control,
    decorateAgent: async () => {},
  });
  const first = validator.validate({ taskId: "task_1", cwd: "/repo", prompt: "one", output: "done", acceptanceCriteria: ["verified"] });
  const second = validator.validate({ taskId: "task_2", cwd: "/repo", prompt: "two", output: "done", acceptanceCriteria: ["verified"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  registry.close();
});
