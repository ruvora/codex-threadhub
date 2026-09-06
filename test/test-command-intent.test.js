import test from 'node:test';
import assert from 'node:assert/strict';
import {isTestCommand} from '../src/command-evidence.js';
import {evaluateTaskCompletion} from '../src/completion-evaluator.js';

test('help, version and collection cannot satisfy a test execution gate', () => {
  for (const command of ['node --test --help','node --test --version','pytest --collect-only','jest --listTests',"/bin/zsh -lc 'node --test --help'"]) {
    assert.equal(isTestCommand(command), false, command);
    const result={evidenceComplete:true,turn:{status:'completed',items:[{type:'commandExecution',command,exitCode:0,status:'completed'}]}};
    assert.equal(evaluateTaskCompletion({result,contract:{taskKind:'test'},phase:'execution'}).decision,'attention');
  }
  assert.equal(isTestCommand('node --test test/navigation.test.js'), true);
});
