---
name: project-agent-orchestrator
description: Start delegated Codex work, always show its representative task link, and immediately show a compact progress panel in the requesting conversation. Keep detailed diagnostics opt-in; do not use to modify this plugin.
---

# Thread-first orchestration

## Present every new work conversation

After dispatch, use `get_work_status` to obtain the actual representative task.
Always include its `presentation.workUrl` as a Markdown “작업 열기” link in
the reply, alongside the work name and concise progress. If that field is absent,
use `codex://threads/<master.threadId>` only with the returned valid UUID.
Never make the user ask for the link again on subsequent status replies.

Immediately after a new dispatch is accepted, call `show_work_progress` with its runId
and execute the returned `open_in_codex` host action once, BEFORE waiting for a
representative. This applies to single and complex work. The host action omits
threadId so the panel stays beside the current requesting conversation. This
compact read-only dashboard is the default for newly accepted work, not the
detailed diagnostic dashboard. It shows task descriptions, progress, dependency
structure and task links. For older runtimes, a recorded orchestrator identity
or multiple planned tasks can establish orchestration; never infer it from the
work title or from a still-zero task count during planning.

Opening the compact panel beside the current requesting conversation is authorized by this
workflow; switching away from the requesting conversation is not. Report a
queued panel as queued. Respect “link only”,
“no dashboard”, and user-closed panels. Do not reopen it on routine status reads.
If no representative exists after the bounded wait below, state that the link and pin are pending; the panel can already show preparation. At the next user interaction, complete any pending link and initial pin once the task exists. Never promise an automatic
post-turn UI update: this skill cannot run after the responding turn ends.

## Native navigation

Existing local tasks can use `codex://threads/<threadId>` links with an actual
UUID returned by the registry or host. Chat-link navigation was user-verified;
embedded/web surfaces still need their own click verification. Never invent an
ID or treat link rendering as proof of opening. `master.navigation` is a host-tool
handoff. For “결과 보기/열어줘” or an explicit work selection,
call the available `navigate_to_codex_page` host tool with that exact threadId.
Confirm opening only when it returns `navigated: true`. A status-only request
does not authorize switching the current page: report status with the real task
link, without claiming that displaying the link opened the task.
Dashboard links must not send follow-up messages, start or retry work.
If host navigation is unavailable, explain the limitation instead of claiming
success. Message delivery or OS URL acceptance is not navigation confirmation.

## Sidebar pin handoff

For newly delegated work, request `pin: true` unless the user opts out. The daemon
does not own sidebar pins. After opening the panel, if dispatch returns no representative thread, call
`get_work_status` once with that runId and `waitForThreadMs: 30000`. Do not loop or
start a model turn to wait longer. If still preparing, say pinning is pending;
it can be handled at the next authorized interaction, not autonomously after this turn.

When `pinning.hostAction` is available for that newly requested work (or the user
explicitly asks to pin), use the native app tool `list_threads` to check the exact
thread in `pinnedThreads`. If absent, invoke native `move_thread_to_sidebar_section`
with the returned threadId and `sectionId: "pinned"`, then verify with `list_threads`.
Only an observed matching pinned entry confirms success. Do not call these tools
through the plugin/widget, use App Server metadata, or send a worker message.
Missing tools, errors and unconfirmed results do not block work. Do not repeatedly
attempt a failed handoff, re-pin a user-unpinned task on status reads, or pin child tasks.
The response's `confirmed: false` means the daemon has no host receipt, not that
the app is unpinned. Routine status queries alone do not authorize sidebar changes.
An idempotent already-accepted response is not a new request to re-pin that work.

## User language

For newly accepted work, or when the user requests a compact progress panel,
call `show_work_progress` for the known work, then invoke the available native
`open_in_codex` tool with the returned hostAction arguments unchanged. This is a
read-only side panel beside the requesting conversation, not content inserted into
its chat body. Never substitute a representative or caller-provided origin ID. The returned URL alone does not mean it opened; report queued
placement honestly. Do not open the detailed dashboard instead. The panel
refreshes without model turns; never prompt workers to update it. After daemon
restart or link expiry, obtain a fresh panel URL. Its Open work links hide raw
identifiers and request native navigation without sending a model message.

Users make ordinary requests; never ask them to choose an execution mode or learn
the internal hierarchy. In normal replies, do not expose master, slave, node,
Run, Orchestrator, Control Plane, Data Plane, daemon, role names or raw status codes.
Use the user's language: “작업을 시작했습니다”, “진행 중 · 4개 중 3개 완료”,
“완료했습니다”. Label links “작업 열기” or “결과 보기”, never “마스터 작업 열기”.
Technical response keys such as `master` are implementation details, not copy to
repeat to users. A preparing request has been received, not already executed.
Do not claim completion until the stored status proves it. Failures need a plain
explanation and a concrete next action; never conceal a failed or blocked result.
In requested detail views use “전체 작업” and “하위 작업”. Explain technical
components only on an explicit technical diagnostics or architecture request.

1. For a request to begin delegated work, call `dispatch_control_request` once with the objective and project cwd. The daemon plans and starts automatically; never create READY placeholders or ask for another Start.
2. Acknowledge the work name and status with its real link. For every new request, present the compact progress panel using the initial-presentation workflow above. A null master means preparation, not failure; never fabricate a thread link.
3. For progress, completion, results, or current work, use `get_work_status`. Show work name, status and `progress.succeeded` as successful completion, with nonzero rejected/failed/attention/cancelled/skipped counts separately. `finished` counts all terminal tasks, including unsuccessful ones: never label it completed or successful. Warnings are a subset of succeeded. Keep `needsAttention` visible even while other work is running. `observedAt` is a snapshot timestamp, not proof that execution is alive. Use real host navigation on request, not a fabricated link. Do not add a conversation polling loop.
4. Simple work opens its actual worker; complex work opens its actual master Orchestrator. Use the returned real thread ID with host navigation tools when the user asks to open it. Navigation never sends a prompt, retries work, or creates a turn.
5. Handle requested representative-task pins through the Sidebar pin handoff above. Keep work links visible even if pinning is unavailable.
6. Only when explicitly asked for a dashboard, dependency graph, or detailed diagnostics, call `show_agent_dashboard` once, scoped to the selected Run when known. Prefer embedded presentation; use web only as a requested or necessary fallback.

The daemon is the sole writer of managed sessions. Active sessions are observation-only while leased. Do not introduce a second App Server writer. Worker results are aggregated durably and synthesized in the master, not appended automatically to the origin conversation.

Inspect/status requests do not authorize new Runs. Do not use this plugin to modify itself. The compact status and detailed dashboard are projections of the same registry; neither can start work or change its outcome. Failure, cancellation, recovery and integration attention must never be represented as success. Retained worktree artifacts must not be discarded automatically.

## Resume without duplicating work

Inspect existing Runs, native execution receipts and retained files before dispatch.
An explicit worker thread ID must be an eligible execution thread: never reuse or
fork a Planner, Validator, Synthesizer or Orchestrator as an implementation worker.
Their persistent developer instructions survive resume; a user prompt cannot
replace them. Reuse artifacts independently of thread identity. If no compatible
worker exists, report that limitation rather than promising reuse of a planning
thread or creating duplicate work. Use stable request keys for authorized remaining
work, and keep historical failed verdicts intact.

Scope edit restrictions to exact projects or paths. When the target product is
also a plugin, never forward an unqualified "do not modify the plugin" instruction.
Name the orchestration plugin path that is excluded, and explicitly permit the
authorized target product fixes. Preserve historical logs and published records
without accidentally prohibiting changes to current implementation files.

The host app's interrupted/notLoaded projection is not a native Turn completion
receipt. A scheduler heartbeat establishes lease renewal, not model progress.
When sources disagree, compare exact thread/Turn IDs and command or terminal
receipts; do not interrupt, retry or claim healthy execution from either display
alone. Report the discrepancy and known evidence. Nonzero diagnostic exits and
optional unavailable checks need evidence-backed acceptance review; neither is
a passed release gate.

## Inherited request permissions

The runtime reads the host-origin thread's native turn context and passes its
sandbox, network and approval policy to all threads created for that request.
Full Access requests remain Full Access through planning, execution, validation
and synthesis. Do not infer permissions from prose, a supplied thread ID, or a
role name; the native parent context is the source. Do not use narrower task
sandbox defaults to replace inherited authority. Role-specific non-editing
instructions and the user's task scope still apply. If the native parent context
is unavailable, report the failure; do not retry without host origin to bypass it.
