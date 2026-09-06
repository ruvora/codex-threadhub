# Product continuation failures — 2026-09-06

## Evidence and causes

- Workspace continuation reused its persistent Planner thread as an implementation worker. The model correctly reported its higher-priority `Do not implement tasks` instruction. Automatic routing already excludes control-plane agents; explicit thread IDs bypassed that filter. Changing a task prompt or sandbox cannot replace persistent role instructions. The operator's reuse choice was also incorrect.
- Fold's literal `rg --files -g AGENTS.md` included three path operands. The narrow no-match parser accepted flags but rejected every path, causing exit 1 to override delivered artifacts. Literal paths now work; diagnostics, unknown flags, shell compounds and exit 2 remain failures.
- Port's G0 harness intentionally returned 3 for NOT VERIFIED. Both projects also recorded missing PyYAML while separately running local Node package checks. Previously any nonzero command stopped completion before the acceptance validator could distinguish optional diagnostics from required failures. For non-integrating tasks with acceptance criteria, ordinary command failures now reach an independent read-only review. Exact item ID/exit, disposition and supporting source/output evidence are mandatory; unreviewed outcomes require attention, never automatic replay. Accepted limitations force warnings. Actual test failures, permission failures, native evidence conflicts and incomplete receipts remain blocking. No keyword or JSON assertion alone grants success; G0/G3 remain unverified.
- Host read_thread projected Fold/Port as interrupted while later command receipts continued to appear. The stored native execution records ultimately report completed at 04:14:13 and 04:13:25 UTC respectively. Scheduler heartbeats alone were insufficient to claim progress. The external app projection's internal cause is not established or modified by this repository; the orchestration guidance now requires exact Turn evidence when sources disagree.

## Boundaries

The old three continuation Runs remain failed. Their commands have not been replayed, their verdicts have not been rewritten, and no replacement product tasks are created by this fix. Read-only replay of Fold/Port's original execution results now permits acceptance review; that is not validator acceptance or product release success. Production Hub mutation, native Port transfers and Workspace implementation are still outstanding product work.

Role mismatches are rejected before writer acquisition, resume/fork, or model execution. The same check applies to explicit prepared worker IDs. Shared-workspace permission and source evidence remain separate from role eligibility. A new compatible execution context is necessary when a project has only planning threads; retained project files and source context can still be reused.

## Verification and installation

- Final full suite: `/Users/sin-yebin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test`: exit 0; 369 tests, 369 pass, 0 fail/cancel/skip/todo (31,685.874375 ms).
- Coverage includes literal multi-root searches and real rg errors, exact diagnostic-review identity/exit matching, missing/duplicate review rejection, mandatory warnings, true test failures, explicit Planner reuse/fork prevention with zero writer calls, and an end-to-end injected worker/validator test proving one worker execution and `completed_with_warnings` persistence.
- MCP test fixtures now close their servers after each test; the earlier focused run's open server handles were a test cleanup issue, not a product-worker failure. An initial new mock omitted the onStarted callback and correctly triggered leased→validating rejection; the fixture was corrected without relaxing the state machine.
- Official plugin-creator validation: ThreadHub source, ThreadFold and ThreadPort all exit 0 using `/tmp/ruvora-plugin-validation/bin/python`. This isolated venv contains PyYAML 6.0.3. Default worker Python is unchanged; future official checks must provision/use a dependency-complete validation environment. Structural validation does not prove native-host loading or live integration.
- Updated skill passes official quick_validate; git diff whitespace check passes.
- Installed plugin: `0.6.0+codex.20260906042607`; active runtime build `0.14.0+2688c2008d72`, healthy, zero active tasks after startup. Source/installed runtime comparison reports no missing, extra or changed files. Reinstallation preflight found zero active tasks and zero live cache proxies.
- All six historical product Runs retain their original failed verdicts. No product worker was restarted by these checks. New conversations pick up the new tool/skill catalog; existing model contexts keep their previous instructions.
