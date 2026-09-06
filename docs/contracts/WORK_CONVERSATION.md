# Work conversation

The user-facing work thread is an execution record, not a protocol console.

## Input boundary

- Explicit `dispatch_control_request(mode="direct")` records a deterministic one-task planning phase before preparation; it does not invoke the AI planner or bypass the Run state machine.
- Direct execution intent is `taskKind` (default `analysis`, no workspace edits). Callers requesting direct implementation must specify `taskKind: "implementation"`; unspecified natural-language work can use the default auto planning route. Titles and negated constraints such as “do not modify files” must not infer direct mutation or workspace-change output requirements.

- The native user message contains the assigned work request. Preserve explicit user constraints; never sanitize arbitrary user text with keyword removal.
- Planner-generated requests use the user's language and describe the goal, scope and deliverables. Acceptance criteria remain structured separately.
- App Server `turn/start.additionalContext` carries application policy, runtime information and project constraints outside the user message. Reference memories, dependency results and review feedback are explicitly untrusted data.
- Historical task-result memories and reusable-agent summaries are not injected into execution context. Current dependencies are supplied from the durable graph, not from a general memory search. This does not erase existing thread history.
- The assigned acceptance criteria are supplied to the worker as application context, not hidden until validation. A rework turn receives its own earlier revision reports and must return a complete corrected report, not an addendum alone. Feedback cannot authorize checks forbidden by the original scope.
- Dependency handoffs preserve task identity, durable state, completion timestamp, complete revision reports and task-scoped native command evidence. Validators receive the same upstream snapshot stored at submission. A rejected test report can contain passing commands; report acceptance and command success are separate facts. Never substitute a synthesis task's tests for its upstream test task.
- The dispatch stores the complete additional context and its fingerprint. Changing context cannot reuse the same explicit dispatch revision. Context-bearing submissions use `clientUserMessageId` for uncertain-submission recovery; matching the same visible prose alone is insufficient.
- Context transport errors remain execution errors. Never retry without the policy or silently append it to the user message. Compatibility was checked against the installed App Server; older versions require their own compatibility gate.

## Output boundary

- Ordinary `report` and workspace outputs use a natural-language final answer: outcome, files, actual verification and remaining limitations. They do not require a JSON `outputs` envelope.
- Native commands, exit codes, workspace artifacts, acceptance validation and integration receipts retain their existing completion gates. Fluent prose alone is not proof that tests ran or files changed.
- Compatibility exception: custom named outputs still require their existing structured JSON response for downstream consumers. A separate structured-report transport is not implemented in this change. The planner should prefer `report` unless a named interface is actually needed.
- Complex work starts with the actual objective and a concise plan explanation. Aggregation inputs travel as reference context, and the final answer is readable prose consistent with durable status.
- Existing conversations are not rewritten. Per-turn context does not guarantee that every host conceals context in all diagnostic views. Native UI display must be tested separately from transport shape.

## Progress projection

Every newly available representative work is presented as a real task link in
the requesting conversation. Status replies retain that link. `presentation`
reports the structural kind, UUID-validated `workUrl`, and an initial compact
panel handoff for every accepted work, including preparation. It never opens UI or records a host receipt.
The orchestration skill opens this panel beside the requesting conversation
immediately after acceptance, before waiting for a representative, unless the user opts out;
detailed diagnostics remain opt-in. Hidden-task placement may be queued and must
not be described as visible. Routine reads must not reopen user-closed panels.
If the representative is not ready within the bounded wait, its chat link and pin
remain pending. The open panel refreshes its real link without model turns, but
this does not post a later message in the requesting chat.

Dispatch acknowledgements and status tool text render a compact summary directly:
work name, state, separate success/active/rejected/failed counts, actual work link
and a short attention reason. Machine fields remain in structuredContent. Accepted
work without a representative explicitly says the link is not available yet;
it must not claim creation, pinning, or live automatic updates. Failed work with
validation rejection is labeled distinctly from execution failure, without changing
the durable failed state or counting rejection as success.

Sidebar pinning belongs to the native app, not App Server `thread/metadata/update`.
New `dispatch_control_request` work persists `pin` intent (default true, false opts
out). `get_work_status.works[].pinning` supplies a representative-only native
`move_thread_to_sidebar_section` handoff once a valid local thread exists. The
calling conversation checks `list_threads.pinnedThreads` before and after the
mutation. Intent/returned arguments never confirm pinning; no worker turn is sent.
Status reads never mutate the sidebar, and existing user-unpinned work must not be
automatically re-pinned. A bounded `waitForThreadMs` read can await preparation for
up to 30 seconds. If it expires, pinning stays pending until an authorized host
interaction; the daemon cannot complete that app action after the chat turn ends.
Missing or failed host pinning never changes execution status or triggers retry.

`get_work_status.progress.succeeded` counts only completed and completed-with-warnings tasks. `warnings` is a subset of succeeded. `finished` is retained for compatibility and counts all terminal tasks, including rejection, failure, cancellation and skips; never label it successful completion. Rejected, failed, cancelled, skipped, attention, active, waiting and unknown counts remain separate. `needsAttention` can be true while the durable Run is still running.

`observedAt` records when the snapshot was read, not worker liveness. `lastUpdatedAt` is the latest stored Run/Task update, not proof that a command is making progress. Transport freshness and execution health must not be conflated.

This projection does not insert or refresh content inside an existing work conversation. The currently integrated MCP UI is associated with the calling tool result; an automatic cross-conversation inline surface has not been verified. Do not describe status projection alone as a live embedded work monitor, and do not start extra model turns merely to refresh a counter.

For newly accepted work by default, even before any task exists, `show_work_progress` prepares a compact read-only panel and returns an `open_in_codex` host action omitting threadId to target the requesting conversation's right panel. URL creation is not UI-opening confirmation; a queued host action remains queued until the task is shown. The panel refreshes every five seconds while visible, pauses when hidden, and marks stale data explicitly on connection failure. Display refresh time and stored work-update time are separate.

The panel token is limited to one Run, expires after 24 hours, and cannot access detailed snapshots or mutation routes. Daemon restart requires reopening with a fresh URL. No worker turn, retry, or execution is triggered by panel reads. Open work anchors use codex://threads/<UUID> for existing local tasks. They expose no raw identifier in visible text and send no worker/model message. Link rendering is not an opening receipt: chat-link navigation was user-verified, while embedded and web host behavior must be tested separately. The detailed dashboard remains explicit opt-in.

## Verification gates

Native evidence reconciliation reads only the exact rollout path returned by the
host for the selected thread. It checks the session, turn and existing command
item identity before restoring missing projected output from raw command events.
An explicit empty buffer remains empty; null alone never becomes empty. Exit and
output conflicts are retained, not overwritten. Missing/inaccessible/oversized
rollouts remain unavailable rather than guessed. The adapter currently supports
the observed local JSONL format; remote or changed formats need separate support.

Same-turn worker-visible tool responses are retained separately with the
`tool_chunk` namespace and tool call ID. These IDs are not `command_item` IDs,
and absence of an alias mapping is not proof of fabrication. Tool responses prove
what was presented to the worker, not which command ran or whether it passed.
Validators receive both views and provenance. A missing projected field is lack
of corroboration, not contradiction of an observed native receipt. Real evidence
conflicts and missing required execution proof must still be surfaced.

Command evidence merges native live completion items, terminal notification items,
and persisted terminal reads by item identity. A null persisted output must not
erase a captured live output. Missed-terminal recovery uses the same merge.
Native command output deltas are retained separately as `streamedOutput`, scoped
to thread, turn and item, capped at one million characters per item and explicitly
marked as not guaranteed complete. They never synthesize an exit code or prove
that no output was missed. Validation must distinguish unavailable logs from
empty logs and must not infer test counts from exit code zero or historical prose.

A diagnostic-free `rg --files` enumeration with exit code 1 is classified as
no matches by command semantics, not a failed test or positive test-success receipt.
It does not prove an empty output buffer was observed. Native null/omitted logs
remain unavailable; only explicit complete empty buffers are observed empty.
Workers and validators share this interpretation policy. Revision handoffs and
validation input carry derived command observations separately from unchanged
native receipts. Unsupported observations or test counts still require correction;
this policy does not waive acceptance criteria. This narrow
classification supports literal single commands and their shell transport only;
content searches, compound commands, unknown options, explicit path operands,
diagnostic output, and exit code 2 remain failures. Original command receipts
and historical failure records are preserved. Changing the classifier does not
automatically retry or rewrite previously failed Tasks/Runs.

### Execution ownership and opening completed work

Registry claim release and App Server writer release are separate operations.
The daemon uses a persistent observer plus a dedicated App Server process per
acquired work thread. Creation, naming, resume and execution stay on that owning
connection, including before the first turn has a persisted rollout. A matching
terminal turn is hydrated before its process is closed; process exit is awaited
before returning execution completion. Other work threads are not disconnected.
Unknown execution outcomes retain their owner for observation and interruption;
a subsequent terminal observation can release it without replaying the task.

`thread/unsubscribe` is not an immediate ownership-transfer receipt: App Server
can retain an unsubscribed thread during its inactivity grace period. Do not
archive/delete user work or start a dummy turn to make it openable.

The public-entry E2E must keep the daemon alive while a second independent App
Server resumes each completed work thread and reads its actual terminal answer.
This verifies cross-process ownership handoff, not native screen rendering.
Opening an actively executing thread remains host-dependent: a link or pin does
not prove that the app supports concurrent read-only viewing of another writer.

The compact panel includes a representative work/result link, short task descriptions and named dependency arrows. A finalized failed or cancelled Run also exposes its final result; result availability does not imply success. Action guidance is visible, while raw diagnostics are collapsed. Refreshes update existing task nodes instead of replacing focused links or open diagnostic sections. Reconnection instructions request a fresh panel in the current conversation; a read-only token cannot silently renew itself or acquire broader permissions.

An uncertain dispatch can record a matching terminal receipt from `thread/read` through an evidence-checked recovery transition. The previous failure is retained in evidence. Background recovery probes are bounded to ten attention probes, at least one minute apart. They never resubmit execution or automatically reopen terminal Tasks/Runs: late execution completion is not acceptance validation or integration approval. Exhausted or unresolved observations remain explicitly attention-required.

Re-executing an existing active dispatch observes it without resubmission or a failure transition. `TURN_DISPATCH_ACTIVE` means `observe_existing_turn`, not a retryable failure. The task remains available to stale-task reconciliation. This does not prove all restart/lease races safe; live recovery remains a release gate.

Regression tests cover natural reports versus strict named outputs, preserved execution evidence, upstream and rework transport, context fingerprints and native request separation. The App Server release E2E asserts the actual persisted user message, a non-envelope final answer, a real code fix, passing tests, acceptance validation and integration.

Run `npm run test:work-conversation-e2e` to exercise the scheduled worker path rather than only foreground execution. It creates an isolated fixture, never modifies the product repository, and retains failed fixtures for diagnosis.
