import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexControlPlane, mergeTurnItems } from '../src/control-plane.js';

test('missing hydrated output does not erase live output or hide a later failure', () => {
  const [item] = mergeTurnItems([{id:'x',aggregatedOutput:'tests 5',exitCode:0}],
    [{id:'x',aggregatedOutput:null,exitCode:1}]);
  assert.equal(item.aggregatedOutput,'tests 5');
  assert.equal(item.exitCode,1);
  assert.equal(mergeTurnItems([{id:'x',aggregatedOutput:'old'}],[{id:'x',aggregatedOutput:''}])[0].aggregatedOutput,'');
});

for (const recovery of [false,true]) test(`native empty receipt reaches ${recovery ? 'recovered' : 'normal'} persisted completion`, async () => {
  const dir=mkdtempSync(join(tmpdir(),'threadhub-native-'));
  const path=join(dir,'rollout.jsonl');
  writeFileSync(path,[{type:'session_meta',payload:{id:'thread'}},
    {type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:'t',item:{type:'CommandExecution',id:'cmd',command:['/bin/zsh','-lc','rg --files'],exit_code:1,stdout:'',stderr:'',aggregated_output:''}}}
  ].map(JSON.stringify).join('\n'));
  const client=new EventEmitter();
  const turn={id:'t',status:'completed',items:[{id:'cmd',type:'commandExecution',command:"/bin/zsh -lc 'rg --files'",exitCode:1,aggregatedOutput:null}]};
  client.request=async method=>method==='turn/start'?{turn:{id:'t'}}:{thread:{id:'thread',path,turns:[turn]}};
  client.waitForNotification=async()=>{
    if(recovery)throw Error('Timed out waiting for app-server notification');
    return {method:'turn/completed',params:{threadId:'thread',turn}};
  };
  try {
    const result=await new CodexControlPlane(client).runTask('thread','search',{timeoutMs:1000});
    assert.equal(result.executionItems[0].aggregatedOutput,'');
    assert.equal(result.executionItems[0].exitCode,1);
    assert.equal(result.nativeEvidence.status,'read');
    assert.equal(turn.items[0].aggregatedOutput,null);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

for (const recovery of [false,true]) test(`output survives ${recovery ? 'missed terminal recovery' : 'normal hydration'}`, async () => {
  const client = new EventEmitter();
  const item={id:'cmd',type:'commandExecution',command:'node --test',exitCode:0,aggregatedOutput:null};
  const turn={id:'t',status:'completed',items:[item]};
  client.request=async method => {
    if(method==='turn/start') {
      client.emit('item/commandExecution/outputDelta',{threadId:'thread',turnId:'other',itemId:'cmd',delta:'WRONG'});
      client.emit('item/commandExecution/outputDelta',{threadId:'thread',turnId:'t',itemId:'cmd',delta:'tests 5\n'});
      client.emit('item/completed',{threadId:'thread',turnId:'t',item:{...item,aggregatedOutput:'tests 5\n'}});
      return {turn:{id:'t'}};
    }
    return {thread:{turns:[turn]}};
  };
  client.waitForNotification=async()=>{
    if(recovery) throw new Error('Timed out waiting for app-server notification');
    return {method:'turn/completed',params:{threadId:'thread',turn}};
  };
  const result=await new CodexControlPlane(client).runTask('thread','test',{timeoutMs:1000});
  assert.equal(result.executionItems[0].aggregatedOutput,'tests 5\n');
  assert.equal(result.executionItems[0].streamedOutput,'tests 5\n');
  assert.equal(result.executionItems[0].streamedOutputCompleteness,'not_guaranteed');
  assert.deepEqual(result.turn.items,result.executionItems);
  assert.equal(client.listenerCount('item/commandExecution/outputDelta'),0);
});
