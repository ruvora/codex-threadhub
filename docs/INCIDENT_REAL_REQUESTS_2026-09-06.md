# Real product requests: planning and evidence regressions

Observed requests: ThreadFold, ThreadPort, and RUVORA Workspace.

## Causes

- Fold constraints were saved in plan metadata but omitted from the planner prompt. Despite requesting sequential shared-workspace writes, the generated graph introduced worktrees and an integration task combining `shared` with `patch`. The compiler correctly rejected it. Constraints now reach planning and synthesis; planning instructions clarify that integrationStrategy publishes the current task's artifact, not its dependencies. Rejected drafts and task-specific errors are retained for bounded correction and audit. Invalid graphs remain blocked, not silently rewritten.
- Workspace acceptance text explicitly excluded browser/socket execution, yet keyword inference treated `rendering` and `without browser or listening sockets` as runtime requirements. Capability inference now distinguishes the reproduced static/negative clauses from affirmative live checks. Explicit capability declarations still apply even when prose negates them. This is bounded heuristic compatibility inference, not general natural-language authorization parsing.
- Port was displayed as interrupted by the app while native execution continued. The same native turn later completed at 03:38:52 UTC. The actual durable rejection was native command evidence conflict, not an execution interruption. Four shell-escaped display strings differed from raw argv. The matching structured host command actions, cwd, process identity, item identity and exit codes resolve the discrepancy without evaluating shell text. Replaying the original persisted execution items against the original rollout read-only changed four conflicts to zero.

## Verification boundaries

Regression tests cover constraints reaching planning, shared/patch rejection with task-specific feedback and retained draft, static/no-browser acceptance, explicit capability enforcement, structured shell identity, and genuine cwd/process/command/exit disagreement.

No production Run was reopened, worker command replayed, or historical verdict edited. The offline evidence replay is not validator acceptance or full product completion. App observation alone must not cause replay or interruption of another writer. The three real product workflows still require controlled verification after installation; these fixes do not establish their end-to-end completion.
