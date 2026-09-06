import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileNativeEvidence } from '../src/native-evidence.js';
import { readFileSync } from 'node:fs';
test('incident multi-action displays decode entire argv and preserve identity', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/native-multi-action.json', import.meta.url)));
  for (const {projected, native} of fixtures) {
    const rows = [{type:'session_meta',payload:{id:'thread'}}, {type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:'turn',item:{...native,aggregated_output:'original'}}}];
    const read = value => reconcileNativeEvidence(rows.map(JSON.stringify).join('\n'), {threadId:'thread',turnId:'turn',items:[value]});
    assert.equal(read(projected).nativeEvidence.status, 'read');
    assert.equal(read(projected).items[0].aggregatedOutput, 'original');
    for (const change of [{cwd:'/wrong'}, {processId:'wrong'}, {exitCode:2},
      {command:projected.command.replace(';', '&&')}, {command:projected.command + ' ; echo extra'},
      {command:projected.command.replace('-lc', '-c')}, {aggregatedOutput:'changed'}]) {
      assert.equal(read({...projected,...change}).nativeEvidence.status, 'conflicting');
    }
  }
});
const item = {id:'exec-one',type:'commandExecution',command:"/bin/zsh -lc 'rg --files --hidden -g AGENTS.md'",exitCode:1,aggregatedOutput:null};
test('shell display escaping is not a conflict when structured identity matches',()=>{
  const command="node <<'NODE'\nconsole.log('quoted ! text');\nNODE";
  const rows=[{type:'session_meta',payload:{id:'thread'}},{type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:'turn',item:{type:'CommandExecution',id:'exec-one',command:['/bin/zsh','-lc',command],cwd:'file:///repo',process_id:'12',exit_code:0,aggregated_output:'ok'}}}];
  const projected={...item,command:'escaped host display',cwd:'/repo',processId:'12',exitCode:0,commandActions:[{type:'unknown',command}]};
  const read = value => reconcileNativeEvidence(rows.map(JSON.stringify).join('\n'),{threadId:'thread',turnId:'turn',items:[value]});
  assert.equal(read(projected).nativeEvidence.status,'read');
  assert.equal(read(projected).items[0].aggregatedOutput,'ok');
  for(const change of [{cwd:'/other'},{processId:'13'},{exitCode:1},{commandActions:[{type:'unknown',command:'different'}]}]) assert.equal(read({...projected,...change}).nativeEvidence.status,'conflicting');
});
test('classified search/read/list actions retain exact command identity despite display quoting',()=>{
  const command = "rg -n 'PyYAML|yaml|공식.*검증' README.md docs --glob '!evidence/**'";
  for (const type of ['search', 'read', 'listFiles']) {
    const raw = {type:'CommandExecution',id:'exec-one',command:['/bin/zsh','-lc',command],cwd:'file:///repo',process_id:'35904',exit_code:0,aggregated_output:'matching evidence'};
    const rows = [{type:'session_meta',payload:{id:'thread'}},{type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:'turn',item:raw}}];
    const projected = {...item, command:'host shell-escaped display',cwd:'/repo',processId:'35904',exitCode:0,commandActions:[{type,command}]};
    const read = value => reconcileNativeEvidence(rows.map(JSON.stringify).join('\n'),{threadId:'thread',turnId:'turn',items:[value]});
    assert.equal(read(projected).nativeEvidence.status,'read');
    assert.equal(read(projected).items[0].aggregatedOutput,'matching evidence');
    for (const change of [{cwd:'/elsewhere'},{processId:'other'},{exitCode:1},
      {commandActions:[{type,command:'different'}]}, {commandActions:[{type,command},{type,command}]},
      {aggregatedOutput:'contradictory output'}]) {
      assert.equal(read({...projected,...change}).nativeEvidence.status,'conflicting');
    }
  }
});
function fixture({thread='thread',turn='turn',output='',exit=1}={}) {
  return [
    {type:'session_meta',payload:{id:thread}},
    {type:'event_msg',payload:{type:'item_completed',thread_id:thread,turn_id:turn,item:{type:'CommandExecution',id:'exec-one',command:['/bin/zsh','-lc','rg --files --hidden -g AGENTS.md'],stdout:output,stderr:'',aggregated_output:output,exit_code:exit}}},
    {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call-one',internal_chat_message_metadata_passthrough:{turn_id:turn},output:[{text:JSON.stringify({chunk_id:'8462ac',exit_code:1,output:''})}]}},
  ].map(JSON.stringify).join('\n');
}
test('incident: native empty output survives projection; chunk ID is a different namespace',()=>{
  const r=reconcileNativeEvidence(fixture(),{threadId:'thread',turnId:'turn',items:[item]});
  assert.equal(r.items[0].aggregatedOutput,'');
  assert.equal(item.aggregatedOutput,null);
  assert.equal(r.workerToolReceipts[0].namespace,'tool_chunk');
  assert.equal(r.workerToolReceipts[0].chunkId,'8462ac');
  assert.equal(r.items[0].id,'exec-one');
  assert.equal(r.nativeEvidence.status,'read');
});
test('different sessions and turns cannot supply evidence',()=>{
  for(const options of [{thread:'other'},{turn:'other'}]) {
    const r=reconcileNativeEvidence(fixture(options),{threadId:'thread',turnId:'turn',items:[item]});
    assert.equal(r.items[0].aggregatedOutput,null);
    assert.equal(r.workerToolReceipts.length,0);
  }
});
test('exit or explicit output conflicts remain conflicts rather than successful corrections',()=>{
  const r=reconcileNativeEvidence(fixture({exit:2}),{threadId:'thread',turnId:'turn',items:[item]});
  assert.equal(r.items[0].aggregatedOutput,null);
  assert.equal(r.nativeEvidence.status,'conflicting');
  const c=reconcileNativeEvidence(fixture(),{threadId:'thread',turnId:'turn',items:[{...item,aggregatedOutput:'error'}]});
  assert.equal(c.items[0].aggregatedOutput,'error');
  assert.equal(c.nativeEvidence.status,'conflicting');
});
