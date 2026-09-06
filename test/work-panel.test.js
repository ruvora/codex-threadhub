import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { DashboardServer } from "../src/dashboard-server.js";
import { ControlRegistry } from "../src/registry.js";
import { McpControlServer } from "../src/mcp-server.js";

test("panel refresh preserves stale evidence, pauses hidden views, and prevents overlapping requests", async () => {
  const html = readFileSync(new URL("../ui/work-progress.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const element = () => ({ dataset: {}, children: [], setAttribute(name,value) {this[name]=value;}, removeAttribute(name) {delete this[name];}, append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; } });
  const elements = new Map();
  let visibility, resolveFetch, calls = 0;
  const timers = new Map(); let nextTimer = 0;
  const document = { hidden: false, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, addEventListener(_, callback) { visibility = callback; } };
  runInNewContext(script, { document, location: { href: "http://localhost/progress?viewToken=read" }, navigator: {}, URL, AbortController, Date,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch() { calls++; return new Promise(resolve => { resolveFetch = resolve; }); } });
  const refresh = elements.get("refresh").onclick;
  await refresh();
  assert.equal(calls, 1);
  const threadId = "01a07084-279e-7fa0-96a7-9937bfb80cc4";
  const snapshot = { work: { name: "<img onerror=bad>", status: "running", master:{threadId,label:'작업 열기'},progress: { total: 2, succeeded: 0, active: 1 } }, tasks: [{id:'test',name:"테스트",status:"running",threadId,dependsOn:['prepare']}, {id:'prepare',name:"준비",threadId:"javascript:bad"}] };
  resolveFetch({ ok: true, json: async () => snapshot });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("name").textContent, "<img onerror=bad>");
  const article = elements.get("tasks").children[0];
  assert.equal(article.children[4].href, `codex://threads/${threadId}`);
  assert.equal(article.children[4].textContent, "작업 열기");
  assert.equal(article.children[4].onclick, undefined);
  assert.equal(article.children[2].textContent,'준비 → 테스트');
  assert.equal(elements.get('primary').href,`codex://threads/${threadId}`);
  assert.equal(elements.get("tasks").children[1].children[4].hidden, true);
  assert.equal(elements.get("connection").dataset.error, "false");
  assert.ok([...timers.values()].some(timer => timer.delay === 5000));
  document.hidden = true; visibility(); await refresh();
  assert.equal(calls, 1);
  assert.equal(timers.size, 0);
  document.hidden = false; visibility();
  assert.equal(calls, 2);
  const link=article.children[4];
  article.children[5].open=true;
  snapshot.tasks[0].status='recovery_attention';snapshot.tasks[0].nextAction='inspect_execution_evidence';snapshot.tasks[0].issue='INTERNAL_ERROR';
  snapshot.work.status='failed';snapshot.work.progress.rejected=1;snapshot.work.needsAttention=true;
  snapshot.work.attention={cause:'검색 출력 관측을 확인해야 합니다.'};
  resolveFetch({ok:true,json:async()=>snapshot});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('tasks').children[0],article);
  assert.equal(article.children[4],link);
  assert.equal(article.children[5].open,true);
  assert.match(article.children[3].textContent,/종료 결과/);
  assert.equal(article.children[5].children[1].textContent,'INTERNAL_ERROR');
  assert.equal(elements.get('overall').textContent,'실패 · 결과 검증 거절');
  assert.equal(elements.get('attention').textContent,'검색 출력 관측을 확인해야 합니다.');
  void refresh();
  resolveFetch({ ok: false, status: 403 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("connection").dataset.error, "true");
  assert.match(elements.get("connection").textContent, /갱신 끊김.*연결 만료.*최신 상태가 아닐 수/);
  assert.equal(elements.get("name").textContent, "<img onerror=bad>");
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
    registry.updateTask("t", { status: "rejected", error: "보고 확인 필요" });
    const after = await fetch(api).then(r => r.json());
    assert.equal(after.work.progress.rejected, 1);
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

test("panel handoff targets the representative task without invoking execution or claiming UI opened", async () => {
  const registry = new ControlRegistry({ path: ":memory:" });
  const server = new McpControlServer({ registry, recoverInterruptedTasks: false,
    controlFactory: () => { throw new Error("Must not connect to App Server"); } });
  try {
    registry.upsertAgent({ id:"representative",name:"현재 작업",status:"idle" });
    registry.createRun({ id:"r",status:"running",metadata:{orchestratorAgentId:"representative"} });
    const result=await server.handleRequest({method:"tools/call",params:{name:"show_work_progress",arguments:{runId:"r"}}});
    assert.notEqual(result.isError,true);
    assert.equal(result.structuredContent.opened,false);
    assert.equal(result.structuredContent.hostAction.arguments.threadId,"representative");
    assert.equal(result.structuredContent.hostAction.arguments.placement,"right");
    assert.equal(result.structuredContent.hostAction.tool,"open_in_codex");
    assert.equal(registry.listTasks({runId:"r"}).length,0);
    const invalid=await server.handleRequest({method:"tools/call",params:{name:"show_work_progress",arguments:{runId:"missing"}}});
    assert.equal(invalid.isError,true);
  } finally { await server.close(); }
});
