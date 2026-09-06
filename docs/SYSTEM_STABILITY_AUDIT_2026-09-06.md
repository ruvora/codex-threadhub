# System stability audit — 2026-09-06

## Finding

Repeated failures crossed boundaries that isolated passing tests did not cover:
persisted contract vs dispatch, native execution vs stored evidence, task completion
vs writer ownership, worker report vs validator input, and installation vs active
runtime. A passing unit suite is not a release verdict. This audit is not proof
that every possible failure has been eliminated.

## Confirmed corrections

| Priority | Boundary | Finding | Correction / evidence |
| --- | --- | --- | --- |
| P1 | Shutdown → acquisition | Only resume flights were awaited; pending spawn/fork could finish after shutdown and retain a writer | Track every acquisition, reject new acquisition during shutdown, drain before closing; deterministic delayed-spawn test |
| P1 | Terminal → ownership release | Concurrent cleanup could send repeated process close operations | Coalesce release promises; concurrent cleanup regression |
| P1 | Native command → test verdict | Help/version/collection commands could satisfy a test-intent check without executing tests | Reject informational flags; completion-gate regression |
| P1 | E2E → production | Complex E2E injected the older shared-writer topology, then closed the daemon before checking persisted results | Use isolated production writer topology; resume workers and orchestrator from a separate client before daemon shutdown |

Earlier fixes retained: pre-claim contract validation; no same-contract configuration
retry; null-preserving command-output merge and missed-terminal recovery; native
stream evidence with explicit completeness limits; empty file enumeration separated
from failed tests; representative task link and compact panel handoff.

## Evidence and limits

- Automated suite: 346 tests passed before the complex E2E harness-only update.
- Actual direct-entry E2E: passed, including acceptance and a separate client's
  resume/read while the daemon remained alive. Evidence:
  `/tmp/threadhub-system-audit-live.log`.
- Complex worktree/implementation/integration/synthesis E2E: passed. Three tasks
  each executed once; both artifacts integrated; dependency handoff and final
  synthesis completed; all three workers and the orchestrator resumed/read from
  an independent client while the daemon remained alive; database reopen passed.
  Evidence: `/tmp/threadhub-system-audit-complex.log`, run
  `run_b7d9dbd3-bb45-4d01-ba7e-7a4738def180`. Database reopen is not a forced-crash test.
- Contract, retry, journal recovery, delivery and runtime tests are included in
  the automated suite. They do not prove real daemon crash recovery at every
  native execution phase or every external delivery host behavior.
- Native screen rendering, concurrent viewing of an active writer, and a fresh
  conversation's updated plugin connection require separate host verification.
- A skill cannot publish a late-created work link after its response has ended.
  That UX gap needs an explicit follow-up mechanism, not stronger prompt wording.
- Missing original live evidence cannot be reconstructed from worker prose or
  historical test counts. Do not rewrite old failed runs as successful.

## Required release gates

1. Clean diff / explicit revision and complete automated test results.
2. Actual direct request: one execution, validated completion, readable native history.
3. Actual complex request: independent workers, dependency handoff, validation,
   integration, final synthesis, and every result readable while the daemon lives.
4. Installed source/build/path equality and zero active tasks before handover.
5. Fresh-host conversation: link, pin, compact panel placement, result navigation.
6. Crash/fault matrix and missing-output cases must be reported individually;
   never replace a missing gate with a larger unit-test count.

Retain failures and fixtures, stop automatic replay on ambiguous effects, and do
not announce overall stability until every required gate has its own receipt.
