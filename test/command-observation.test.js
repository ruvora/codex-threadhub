import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_EVIDENCE_POLICY, commandObservation } from '../src/command-evidence.js';
import { executionReports } from '../src/task-evidence.js';

const item = {type:'commandExecution',command:'rg --files --hidden -g AGENTS.md',
  status:'failed',exitCode:1,aggregatedOutput:null};

test('incident receipt preserves unavailable output separately from no-match semantics', () => {
  assert.deepEqual(commandObservation(item), {command:item.command,exitCode:1,
    outputObservation:'unavailable',outcome:'no_matches_by_exit_code'});
  assert.equal(item.aggregatedOutput,null);
  assert.equal(commandObservation({...item,aggregatedOutput:''}).outputObservation,'observed_empty');
  assert.equal(commandObservation({...item,stdout:''}).outputObservation,'partial');
  assert.equal(commandObservation({...item,stdout:'',stderr:''}).outputObservation,'observed_empty');
  assert.equal(commandObservation({...item,streamedOutput:'some chunk'}).outputObservation,'partial');
  assert.equal(commandObservation({...item,stderr:'Permission denied'}).outcome,'not_succeeded');
  assert.equal(commandObservation({...item,exitCode:2}).outcome,'not_succeeded');
  assert.equal(commandObservation({...item,command:'node --test',exitCode:0,status:'completed'}).outputObservation,'unavailable');
});

test('revision handoff carries derived observations without rewriting native receipts', () => {
  const registry = {listTurnDispatches:()=>[{revision:1,evidence:{result:{executionItems:[item]}}}]};
  const [report] = executionReports(registry,'task');
  assert.deepEqual(report.commandObservations,[commandObservation(item)]);
  assert.deepEqual(report.executionItems,[item]);
});

test('worker and validator share the same observation policy', () => {
  for (const file of ['work-conversation.js','result-validator.js']) {
    assert.match(readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8'),/COMMAND_EVIDENCE_POLICY,/);
  }
  assert.match(COMMAND_EVIDENCE_POLICY,/never 'observed empty output'/);
  assert.match(COMMAND_EVIDENCE_POLICY,/unsupported observation claims still require correction/);
});
