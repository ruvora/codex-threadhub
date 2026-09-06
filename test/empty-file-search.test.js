import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isEmptyFileSearch, commandSucceeded } from '../src/command-evidence.js';
import { assessTaskResult } from '../src/failure-classifier.js';
import { evaluateTaskCompletion } from '../src/completion-evaluator.js';

const receipt = (command, extra = {}) => ({type:'commandExecution', command,
  status:'failed', exitCode:1, aggregatedOutput:null, ...extra});
const command = `/bin/zsh -lc "rg --files --hidden -g AGENTS.md -g '"'!node_modules'"' -g '"'!.git'"'"`;

test('actual serialized AGENTS search does not reject passing tests', () => {
  const item = receipt(command);
  assert.equal(isEmptyFileSearch(item), true);
  assert.equal(commandSucceeded(item), false); // no-match is not test success
  const result = {evidenceComplete:true, output:'검증 완료', turn:{status:'completed',items:[item,
    receipt('node --test test/work-conversation.test.js', {exitCode:0,status:'completed'})]}};
  assert.equal(assessTaskResult(result), null);
  assert.equal(evaluateTaskCompletion({result,contract:{taskKind:'test'},phase:'execution'}).decision, 'accept');
});

test('only a literal diagnostic-free file enumeration can be no-match', () => {
  for (const cmd of ['rg --files -g AGENTS.md', "sh -c 'rg --files -g AGENTS.md'"]) {
    assert.equal(isEmptyFileSearch(receipt(cmd)), true, cmd);
  }
  for (const cmd of ['rg missing README.md', 'grep missing README.md', 'node --test',
    'rg --files; false', 'rg --files | false', 'rg --files && false',
    'sh -c "rg --files; false"', 'sh -c "rg --files $(false)"',
    'rg -- --files', 'rg -g --files', 'rg --files /tmp/*', 'rg --files ~/project', 'rg --files --quiet', 'rg --files --no-messages',
    'python -c "rg --files"', 'rg --files > /tmp/output', 'rg --files -g']) {
    assert.equal(isEmptyFileSearch(receipt(cmd)), false, cmd);
  }
  for (const extra of [{exitCode:2}, {status:'running'}, {stderr:'Permission denied'},
    {aggregatedOutput:'rg: invalid option'}, {result:{stderr:'error'}}, {exitCode:null}]) {
    assert.equal(isEmptyFileSearch(receipt('rg --files', extra)), false);
  }
});

test('native rg no-match and actual errors stay distinct', () => {
  const noMatch = spawnSync('rg', ['--files','-g','__threadhub_nonexistent_6c1f54__'], {encoding:'utf8'});
  assert.ifError(noMatch.error);
  assert.equal(noMatch.status, 1);
  assert.equal(isEmptyFileSearch(receipt('rg --files -g __threadhub_nonexistent_6c1f54__',
    {exitCode:noMatch.status,stdout:noMatch.stdout,stderr:noMatch.stderr})), true);
  const invalid = spawnSync('rg', ['--files','--invalid-threadhub-option'], {encoding:'utf8'});
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 2);
  assert.equal(isEmptyFileSearch(receipt('rg --files --invalid-threadhub-option',
    {exitCode:invalid.status,stderr:invalid.stderr})), false);
});

test('a later failed test is never hidden by a benign search', () => {
  const result = {turn:{status:'completed',items:[receipt(command),receipt('node --test')]}};
  assert.equal(assessTaskResult(result).type, 'test');
  assert.equal(evaluateTaskCompletion({result:{evidenceComplete:true,turn:{status:'completed',items:[receipt(command)]}},
    contract:{taskKind:'test'},phase:'execution'}).decision, 'attention');
});

 test('ThreadFold multi-root literal search is no-match but path errors remain failures', () => {
  const cmd = "/bin/zsh -lc 'rg --files -g AGENTS.md /Users/example/project /Users/example/Desktop /tmp/plugin-creator'";
  assert.equal(isEmptyFileSearch(receipt(cmd)), true);
  assert.equal(isEmptyFileSearch(receipt(cmd, {exitCode:2, stderr:'No such file or directory'})), false);
  assert.equal(isEmptyFileSearch(receipt('rg --files -- -literal-path')), true);
});
