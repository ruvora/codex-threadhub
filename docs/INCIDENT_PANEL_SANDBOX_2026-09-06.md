# Progress panel and loopback test failure

Run: `run_5628d10e-cab2-46d7-a23b-34a934e5100a`.

## Evidence and cause

The worker ran `node --test test/work-panel.test.js`. Its native execution receipt records four tests, two passing and two failing. The HTTP token test failed with `listen EPERM: operation not permitted 127.0.0.1`. The handoff test only asserted `isError !== true`, hiding the underlying error. Its original precise cause is therefore not proven; an injected listener-permission failure reproduces that handoff error path.

The execution contract declared `localhost-listen`, but selected `workspace-write` with `networkAccess=false`. A declaration did not grant a loopback permission. The current adapter cannot express a separate loopback-only grant. The same HTTP tests pass on the authorized local host. There is no evidence of CPU or memory exhaustion in this failure.

## Changes

- Reject unsupported loopback sandbox contracts centrally, including persisted contracts before claim. Do not automatically widen network or sandbox authority. Regression asserts zero attempts, no connection, and no claim or agent.
- Keep socket-free panel rendering tests in `test/work-panel.test.js`; move real HTTP/token/handoff integration tests to `test/work-panel-http.test.js`. Both remain in the complete test suite. Running only the former does not satisfy the integration release gate.
- Include the actual handoff response in failed assertions rather than masking it with a boolean mismatch.
- The requesting-conversation panel and its read-only API expose task links and status, not raw errors, diagnostic sections, or routine timestamps. Subtasks are visible immediately; failure records remain accessible in work records and detailed diagnostics.

## Scope and remaining validation

For a narrow panel regression, use a direct local unit/integration check rather than another four-task review/validation/synthesis run. Multi-agent orchestration is useful for independent substantial work, not required for every test command.

The new gate is conservative and applies to declared or inferred listener requirements. It does not statically discover every socket operation in arbitrary commands. Other host restrictions may still deny explicitly authorized network access. This change does not establish full native-app E2E success; reopening and clicking the installed panel remain separate checks. Historical failed runs are not retried or relabeled successful.
