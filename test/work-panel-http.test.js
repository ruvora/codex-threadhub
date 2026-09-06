import assert from "node:assert/strict";
import test from "node:test";
import { DashboardServer } from "../src/dashboard-server.js";
import { ControlRegistry } from "../src/registry.js";
import { McpControlServer } from "../src/mcp-server.js";

// Requires loopback listeners. Never silently skip this release gate.
test('handoff exposes a server permission failure instead of claiming a panel opened', async () => {
  const registry = new ControlRegistry({ path: ':memory:' });
  const server = new McpControlServer({ registry, recoverInterruptedTasks: false,
    dashboardServer: { async start() { throw Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1'), { code: 'EPERM' }); } } });
  try {
    registry.createRun({ id: 'r', status: 'accepted' });
    const result = await server.handleRequest({ method: 'tools/call', params: { name: 'show_work_progress', arguments: { runId: 'r' } } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /listen EPERM/);
    assert.equal(registry.listTasks({ runId: 'r' }).length, 0);
  } finally { await server.close(); }
});

test("progress token is scoped to one run and cannot read details or mutate work", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  registry.createRun({ id: "r", name: "현재 작업", status: "running" });
  registry.createRun({ id: "secret", name: "OTHER_PRIVATE_WORK", status: "running" });
  registry.createTask({ id: "parent", prompt: "PRIVATE_PROMPT", status: "completed", metadata: { runId: "r", title: "선행 검토" } });
  registry.createTask({ id: "t", prompt: "PRIVATE_PROMPT", status: "running", dependsOn: ['parent'], metadata: { runId: "r", title: "내용 확인" } });
  let mutations = 0;
  const server = new DashboardServer({ registry, html: "DETAIL_DASHBOARD", onCancel: () => mutations++ });
  try {
    await server.start();
    const panel = new URL(server.progressUrl("r"));
    assert.equal(panel.searchParams.has("token"), false);
    assert.equal((await fetch(panel)).status, 200);
    const api = new URL("/api/progress", panel); api.search = panel.search;
    api.searchParams.set("runId", "secret");
    const before = registry.getTask("t");
    const snapshot = await fetch(api).then(r => r.json());
    assert.equal(snapshot.work.runId, "r");
    assert.equal(snapshot.tasks[0].name, "내용 확인");
    assert.deepEqual(snapshot.tasks[0].dependsOn,['parent']);
    assert.equal(snapshot.work.progress.active, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_PROMPT|OTHER_PRIVATE_WORK/);
    assert.deepEqual(registry.getTask("t"), before);
    registry.updateTask("t", { status: "rejected", error: "PRIVATE_FAILURE_LOG" });
    const after = await fetch(api).then(r => r.json());
    assert.equal(after.work.progress.rejected, 1);
    assert.doesNotMatch(JSON.stringify(after), /PRIVATE_FAILURE_LOG|PRIVATE_PROMPT/);
    assert.equal(after.work.progress.succeeded, 1);
    for (const [path,method] of [["/api/snapshot","GET"],["/api/details/task/t","GET"],["/api/runs/r/cancel","POST"],["/api/tasks/t/repair","POST"]]) {
      const url = new URL(path, panel);url.search=panel.search;
      assert.equal((await fetch(url,{method})).status,403);
    }
    assert.equal((await fetch(api,{method:"POST"})).status,405);
    assert.equal(mutations,0);
    server.progressViews.get(panel.searchParams.get("viewToken")).expiresAt=0;
    assert.equal((await fetch(api)).status,403);
  } finally { await server.close(); registry.close(); }
});

test("panel handoff targets the requesting conversation without invoking execution or claiming UI opened", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const server = new McpControlServer({ registry, recoverInterruptedTasks: false,
    controlFactory: () => { throw new Error("Must not connect to App Server"); } });
  try {
    registry.upsertAgent({ id:"representative",name:"현재 작업",status:"idle" });
    registry.createRun({ id:"r",status:"running",metadata:{orchestratorAgentId:"representative"} });
    const result=await server.handleRequest({method:"tools/call",params:{name:"show_work_progress",arguments:{runId:"r"}}});
    assert.notEqual(result.isError,true, JSON.stringify(result));
    assert.equal(result.structuredContent.opened,false);
    assert.equal(result.structuredContent.hostAction.arguments.threadId,undefined);
    assert.equal(result.structuredContent.hostAction.arguments.placement,"right");
    assert.equal(result.structuredContent.hostAction.tool,"open_in_codex");
    assert.equal(registry.listTasks({runId:"r"}).length,0);
    registry.createRun({id:'preparing',status:'accepted'});
    const early=await server.handleRequest({method:'tools/call',params:{name:'show_work_progress',arguments:{runId:'preparing'}}});
    assert.notEqual(early.isError,true, JSON.stringify(early));
    assert.equal(early.structuredContent.work.master,null);
    assert.equal(early.structuredContent.hostAction.arguments.threadId,undefined);
    const url=new URL('/api/progress',early.structuredContent.panelUrl);
    url.search=new URL(early.structuredContent.panelUrl).search;
    const before=await fetch(url).then(r=>r.json());
    assert.equal(before.work.master,null);
    registry.upsertAgent({id:'01a07084-279e-7fa0-96a7-9937bfb80cc4',status:'idle'});
    registry.createTask({id:'late',prompt:'work',status:'running',agentId:'01a07084-279e-7fa0-96a7-9937bfb80cc4',metadata:{runId:'preparing'}});
    const after=await fetch(url).then(r=>r.json());
    assert.equal(after.work.master.threadId,'01a07084-279e-7fa0-96a7-9937bfb80cc4');
    const invalid=await server.handleRequest({method:"tools/call",params:{name:"show_work_progress",arguments:{runId:"missing"}}});
    assert.equal(invalid.isError,true);
  } finally { await server.close(); }
});
