# Parent permission inheritance — 2026-09-06

Hub now snapshots the requesting host thread's native turn context and inherits
its sandbox mode, network access and approval policy across worker, planner,
validator and orchestrator creation and subsequent execution. Worker role scope
and task side-effect declarations remain independent of runtime authority.

## Implementation

- The MCP proxy replaces caller-supplied origin metadata with host environment
  identity. Native permissions are read through observation-only `thread/read`
  and its exact returned rollout path, with session and optional Turn matching.
  No parent resume, model prompt or tool argument grants authority.
- Known-parent read failure or unsupported sandbox fails before child creation.
  Legacy clients without host origin retain explicit execution contracts.
- Request/task/plan metadata persists the permission snapshot through scheduling,
  restart and validation. Multi-project authorization manifests remain additional
  constraints. Existing running work is not upgraded retroactively.
- Full Access workers no longer receive a workspace-write Turn override simply
  because network access is enabled. Read-only role instructions remain present
  for planners, validators and orchestration even when their runtime is Full Access.

## Verification

- Full suite: 381 tests passed, exit 0, failures/cancellations/skips/TODOs 0,
  duration 31,487.170541 ms. Raw log: `PARENT_PERMISSION_TESTS_2026-09-06.log`.
- Regression coverage includes current/exact parent Turn selection, mismatched
  session and missing permissions, narrower parents, read-only task intent under
  Full Access, forged proxy origin, durable graph inheritance, and worker,
  planner, validator and synthesizer creation/Turn options.
- Installed-native smoke Run completed with an accepted independent validation.
  It read an isolated facts file and reported 17 + 25 = 42. Exact native worker
  and validator Turn contexts both record `danger-full-access`, `never`, and
  network access. Evidence: `PARENT_PERMISSION_NATIVE_2026-09-06.json`.
- Planner/synthesizer/orchestrator propagation is covered by code and regression
  tests; this live smoke used the direct worker plus validator path.
- Plugin structure and skill validation passed. Source/installed runtime parity
  reported no missing, extra or changed files.

An initial local smoke launcher used the source client path against the installed
runtime; the runtime-identity check rejected it before dispatch. The corrected
launcher used the installed client. Only one native smoke Run was created.

## Installed build

Plugin `0.6.0+codex.20260906130206`, runtime `0.14.0+b83f379f9806`, protocol 2.
Reinstallation preflight observed zero active work and zero live cache proxies.
The installed daemon started healthy at 2026-09-06T13:02:22.004Z. A new Codex
conversation picks up the updated skill/proxy catalog. Historical Runs, failures
and retained artifacts were preserved.

Native API reference: https://learn.chatgpt.com/docs/app-server
