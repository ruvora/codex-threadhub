# Test-only request incorrectly required a workspace change

Run `run_6c33a996-cd4b-43f6-b246-2652da27a07e` executed the requested tests successfully, but completion recorded `missingEvidence=["output:workspace-change"]` and no conflicting evidence.

Direct dispatch correctly selected `taskKind=test` but omitted `mutatesWorkspace`. The central compiler included test in its default mutating kinds, producing `mutatesWorkspace=true`, `sideEffectPolicy=workspace`, and `outputs=[workspace-change]`. The user explicitly asked for no file edits. Completion enforced the wrong contract; this was not a missing test-output transport issue.

Test execution now defaults to a report without project mutation. Temporary runtime writes still receive a writable sandbox. Explicit test-writing tasks can request mutation and still require materialized changes. Direct test work selects the QA role instead of the implementation role. Existing persisted contracts and historical failures are not rewritten.

Regression coverage includes the compiled contract, successful strict completion without workspace changes, explicit mutating tests, and the public deterministic direct-dispatch path. Native-app execution after reinstall remains a separate verification; local regressions do not relabel the failed production run.
