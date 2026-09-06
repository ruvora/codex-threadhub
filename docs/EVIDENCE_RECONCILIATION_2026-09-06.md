# Continuation evidence reconciliation — 2026-09-06

This review reads existing receipts. It does not rerun product implementation,
rewrite historical Run verdicts, or treat unverified native integrations as passed.

## Reproduced causes and fixes

1. **Port false identity conflict.** In Turn `01a074fd-6768-7640-9588-32c3e8944b5a`,
   command item `exec-2281ed7e-188e-4577-a235-7cf6df801565` is a classified `search`
   action. Its structured command, cwd, process ID (`35904`) and exit (`0`) match
   the exact native rollout item. Shell quoting changes its display string.
   Reconciliation previously accepted structured identity only for `unknown`
   actions, incorrectly reporting a conflict. It now compares the exact structured
   command independently of its presentation category, retaining all other checks.
   Read-only replay of the 29 stored execution items and 14 worker receipts changes
   one conflict to zero. The stored failed result remains intact.
2. **Fold false approval failure.** Item
   `exec-6f7a070e-ce9f-4e45-9ac8-b16fac081bd4` searched for API names including
   `approvalReceipt` and exited 1. The classifier matched that search term as an
   approval error. Classification now uses the exit and actual diagnostic output;
   the complete command is retained in the reported evidence. The no-match search
   goes to acceptance review, not automatic success. Actual permission diagnostics
   still block. No approval was requested or rejected by this command.
3. **Redirected test identity.** Fold's failed `node --test` wrote `node-test.log`;
   its successful rerun wrote `node-test-final.log`. A literal trailing output-file
   redirection and optional `2>&1` now preserve test recognition. Only the same
   later invocation in the same cwd supersedes the earlier failure; pipelines,
   compound commands and changed test selections do not. The failed receipt is
   retained. Replay leaves only Fold's no-match search for acceptance review.
4. **Workspace validation transport overflow.** Its worker completed at
   `2026-09-06T05:02:32.353Z`, but validation submission exceeded the 1,048,576
   character input limit. Read-only reconstruction measured 1,164,023 characters:
   logs and revision evidence were repeated in the inline validation prompt.
   Prompts above 200,000 characters now retain the complete original in a private
   read-only file, record its path/hash/length on the task, and send a bounded
   inspection instruction with task/criteria previews. Actual reconstruction
   produces 3,585 transport characters. Oversized criteria previews are explicitly
   marked; the validator must inspect complete criteria and required evidence, or
   reject uncertainty. No source evidence is truncated or promoted to success.
   See `WORKSPACE_VALIDATION_SIZE_2026-09-06.json`. This capture made zero model
   calls and zero registry writes; it is not an acceptance verdict.

## App display discrepancy

The app reported `interrupted` for ongoing daemon-owned Turns without a completion
time, while those exact Turns continued to append command receipts. Fold's native
`task_complete` is at `2026-09-06T04:45:36.808Z`; a subsequent app read also reports
that Turn as completed. Workspace's inspected rollout had `task_started` and later
items but no `turn_aborted` or `task_complete` at the observation cutoff. Its
`notLoaded` thread projection is not proof of execution interruption.

This establishes a mismatch between the app's projection and the owner/native
receipt while work is active. The app's internal projection implementation and
root cause are not established here and were not patched. Do not stop or replay a
worker from that display alone; use exact Turn and command receipts. Scheduler
heartbeats alone are not evidence of model progress.

## Validation and delivery

Regression coverage includes classified search/read/list commands, wrong cwd,
process, command, exit and output; misleading error words in command arguments;
real permission diagnostics; redirected test recovery and unrelated later tests.
The first complete suite after the Port fix passed 370 tests. The final complete
suite passed **372/372**, exit 0, with no failures, cancellations, skips or TODOs
(31,468.707458 ms). The raw output is retained at
`/tmp/ruvora-evidence-fix-final-tests.log`. Source runtime staging and plugin
structure validation passed; no registry verdicts were mutated.

Port's bounded changes were additionally inspected in this requesting thread:
regular-file/nonblocking/inode checks prevent the reproduced FIFO hang; current
root binding and immutable plan/digest checks protect the reviewed approval and
reconciliation paths. Its four new regression receipts pass, and its affected
existing test command passes. These checks support the limited local fixes, not
native G0/G3 or host loading. No product tests were replayed by this review.

Native product G0/G3 remain unverified. The first replacement
`0.6.0+codex.20260906045753`, build `0.14.0+41aab95021a3`, started successfully
after Workspace finished, with zero active work and identical installed sources.
The subsequent Workspace overflow correction requires the final release below.

### Final installed release

- Full suite after all four corrections: **373 tests passed**, exit 0, zero
  failures/cancellations/skips/TODOs; 31,440.239375 ms. Raw output:
  `/tmp/ruvora-evidence-bounded-final-tests.log`.
- Plugin structure validation and source/installed runtime parity passed.
- Installed `0.6.0+codex.20260906050605`; healthy runtime
  `0.14.0+172588febcab`, protocol 2, started `2026-09-06T05:06:19.134Z`.
- Handover occurred only after all product execution ended, with zero active
  work and zero cache proxies. Product workers were not restarted and no new
  product tasks were dispatched during this incident repair.
- Historical product Runs still retain failed verdicts. Corrected receipt and
  prompt construction replay is not a new final acceptance decision. Product
  acceptance/release checks remain separate; G0/G3 are not established here.
