import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { OwnedThreadControl } from "../src/owned-thread-control.js";

function fixture() {
  const sessions = [];
  const parent = new EventEmitter();
  const control = new OwnedThreadControl(parent, () => {
    const id = `thread-${sessions.length}`;
    const client = new EventEmitter();
    const session = { client, closed: false, control: {
      connect: async () => {}, spawnAgent: async () => ({ id }),
      resumeAgent: async id => ({ id }), forkAgent: async () => ({ id }),
      runTask: async () => ({ turn: { status: "completed" } }),
      interruptTask: async () => "interrupted",
    } };
    client.close = async () => { session.closed = true; };
    sessions.push(session);
    return session;
  });
  return { control, sessions, parent };
}

test("shutdown drains pending spawn before closing and rejects new acquisition", async () => {
  let finish;
  let closed = 0;
  const control = new OwnedThreadControl(new EventEmitter(), () => ({
    client: { close: async () => { closed++; } },
    control: { connect: async () => {}, spawnAgent: () => new Promise(resolve => { finish = resolve; }) },
  }));
  const spawning = control.spawnAgent();
  await new Promise(resolve => setImmediate(resolve));
  const shutdown = control.close();
  await assert.rejects(control.spawnAgent(), { code: 'THREAD_CONTROL_CLOSING' });
  finish({ id: 'late' });
  await spawning;
  await shutdown;
  assert.equal(closed, 1);
  assert.equal(control.sessions.size, 0);
});

test("concurrent terminal cleanup waits on one process exit", async () => {
  const {control, sessions} = fixture();
  const a = await control.spawnAgent();
  let finish, calls = 0;
  sessions[0].client.close = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = control.releaseSession(a.id, sessions[0]);
  const second = control.releaseSession(a.id, sessions[0]);
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(control.sessions.size, 0);
});

test("terminal task releases only its own writer before returning", async () => {
  const { control, sessions } = fixture();
  const a = await control.spawnAgent();
  const b = await control.spawnAgent();
  await control.runTask(a.id, "work");
  assert.equal(sessions[0].closed, true);
  assert.equal(sessions[1].closed, false);
  assert.equal(await control.interruptTask(b.id, "turn"), "interrupted");
  assert.equal(control.sessions.has(a.id), false);
  await control.close();
});

test("uncertain execution retains writer for observation and interrupt", async () => {
  const { control, sessions } = fixture();
  const a = await control.spawnAgent();
  sessions[0].control.runTask = async () => { throw new Error("timeout"); };
  await assert.rejects(control.runTask(a.id, "work"), /timeout/);
  assert.equal(sessions[0].closed, false);
  assert.equal(await control.interruptTask(a.id, "turn"), "interrupted");
  await control.close();
  assert.equal(sessions[0].closed, true);
});

test("acquisition failure closes isolated process and concurrent resume is deduplicated", async () => {
  const { control, sessions } = fixture();
  await Promise.all([control.resumeAgent("existing"), control.resumeAgent("existing")]);
  assert.equal(sessions.length, 1);
  await control.close();
  const broken = new OwnedThreadControl(new EventEmitter(), () => ({
    client: { close: async () => { sessions.push("closed"); } },
    control: { connect: async () => { throw new Error("connect failed"); } },
  }));
  await assert.rejects(broken.spawnAgent(), /connect failed/);
  assert.equal(sessions.at(-1), "closed");
});

test("failed and interrupted terminal turns release ownership without replay", async () => {
  for (const status of ["failed", "interrupted"]) {
    const { control, sessions } = fixture();
    const a = await control.spawnAgent();
    sessions[0].control.runTask = async () => ({ turn: { status } });
    assert.equal((await control.runTask(a.id, "work")).turn.status, status);
    assert.equal(sessions[0].closed, true);
  }
});

test("fresh thread naming stays on its owner before a rollout exists", async () => {
  const { control, sessions } = fixture();
  const a = await control.spawnAgent();
  sessions[0].control.nameAgent = async (id, name) => ({ id, name });
  assert.deepEqual(await control.nameAgent(a.id, "Work"), { id: a.id, name: "Work" });
  await control.close();
});

test("terminal reconciliation releases an uncertain owner but active observation does not", async () => {
  const { control, sessions } = fixture();
  const a = await control.spawnAgent();
  const worker = sessions[0].control;
  worker.activeTaskStreams = new Map([[a.id, new Set()]]);
  worker.inspectAgent = async () => ({ thread: { turns: [{ status: "completed" }] } });
  await control.inspectAgent(a.id, { includeTurns: true });
  assert.equal(sessions[0].closed, false);
  worker.activeTaskStreams.clear();
  await control.inspectAgent(a.id, { includeTurns: true });
  assert.equal(sessions[0].closed, true);
});
