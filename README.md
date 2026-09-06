# RUVORA Codex ThreadHub

> A local-first hub for orchestrating complex work across Codex threads and projects.

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](./package.json)
[![Version](https://img.shields.io/badge/version-0.14.0-2563eb)](./package.json)
[![E2E](https://img.shields.io/badge/G7_E2E-passing-16a34a)](./docs/G7_E2E_EVIDENCE.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Long-running Codex use creates more threads while decisions and constraints become scattered across conversations and projects. RUVORA is not a tool for creating even more threads. It is a central control layer that records **which context was selected and why, then coordinates work under validated execution contracts**.

## At a glance

| Problem | RUVORA's approach |
|---|---|
| It is hard to tell which thread best understands the current goal | Index provenance-backed Context Claims and rank them by relevance, freshness, authority, and conflict. |
| Context is split across multiple threads | Freeze selected evidence and unresolved conflicts in an immutable Context Snapshot before planning. |
| One command cannot coordinate several projects | Decompose a Global Run into Project Runs and Task DAGs connected by validated durable handoffs. |
| Permanent threads accumulate as work grows | Apply lifecycle and creation budgets to choose `reuse`, `fork`, `spawn`, `ephemeral`, or `wait`. |
| Contract errors cause repeated execution failures | Reject them before execution with strict contracts, a pre-claim gate, and fingerprint-based retry and repair rules. |
| Daemon exits or integration conflicts can lose state | Recover through the SQLite Registry, fenced claims, leases, an integration journal, and durable delivery. |
| An Agent can report success despite failed commands or missing changes | The Completion Gate evaluates the full Turn, commands, outputs, workspace changes, validation, and integration evidence. |

## Using RUVORA

### Ask from Codex Desktop

When this repository's runtime is deployed as the RUVORA plugin, the normal interface is natural language. You do not need to call individual tools by name.

1. After the first installation or a runtime update, open a new Codex Desktop conversation.
2. Open `/mcp` in the target project and confirm that `codex_control_plane` is connected.
3. Describe the goal, scope, and completion criteria in natural language.
4. Your work proceeds in the background. Use **Open work** to see progress or **View result** when ready. Complex work is split automatically; request details to explore its subtasks.

Request acceptance is not execution: work starts automatically only after the complete graph is validated and persisted, then dependencies and workspace leases permit dispatch. No second Start confirmation is needed. Completion is recorded locally; the final answer is written in the representative work conversation, not automatically posted into the requesting conversation. For simple work this is the worker itself; for complex work it is the synthesis conversation. Opening it requires a confirmed native host navigation action. Stored notifications are not a promise of an unsolicited chat message.

Ordinary reports are readable prose. Only explicitly named output interfaces require structured JSON. Diagnostic data travels separately from the user request, but its visibility depends on the host and is not guaranteed to be hidden in every diagnostic view.

| Goal | Example | Internal execution |
|---|---|---|
| Read-only analysis | `Analyze this project's authentication flow and prioritize the risks.` | One Project Run with non-mutating task instructions and inherited parent permissions |
| Code change | `Fix the failing tests and verify the fix with the full test suite.` | Write contract, Validator, and a managed worktree when needed |
| Reuse context | `Use the API design review thread's decisions to produce an implementation plan.` | Requested-thread indexing and a frozen Context Snapshot |
| Multi-project change | `Update the backend response contract and align the frontend types and UI.` | Global Run, project DAGs, and validated handoffs |
| Inspect progress | `Show the dashboard for currently running work.` | Read-only embedded dashboard |

Complex requests are easier to plan when completion criteria are explicit:

```text
Update the user profile contract across the backend and frontend projects.

Completion criteria:
- The backend API and schema agree.
- The frontend types and UI consume the new response.
- Each project's tests pass.
- Report the cross-project handoff evidence and final change list.
```

`dispatch_control_request` records the Run first and immediately returns its ID. A single task may execute directly; complex work is decomposed by the Planner into a Task DAG.

### Open the work navigator

Say **Open the result** to open the existing work using the host's navigation
action. Status responses do not generate unverified `codex://` hyperlinks.
Dashboard buttons request that same host action; a sent request is not yet proof
that navigation succeeded. Hosts without navigation support show a limitation.

```text
Show the agent dashboard for this project.
```

The default experience is **work name, status, progress, and Open work / View result**, provided by `get_work_status`. Keep making ordinary requests: there is no execution mode or hierarchy to learn. During preparation, the link is absent rather than a placeholder. Pinning is optional and host-dependent; opening ongoing work lets you observe its record.

Request acknowledgements and status responses include a compact readable summary,
not a raw diagnostic object. It distinguishes work still preparing, execution
failure, and result-validation rejection. Success counts exclude rejected work;
once the representative conversation exists, its link is included in the response.
The text reply is a snapshot, not an automatically updating chat card; the separate panel refreshes while visible. A missing link during
preparation does not mean the request failed; it means the conversation is not yet
available. Detailed machine data remains available separately.

New requests open a small progress panel beside the requesting conversation, even while preparing, to show task links and concise status without opening the detailed dashboard. `show_work_progress` prepares a read-only panel; the native host attaches it beside the current requesting conversation. It refreshes while visible without model turns and warns when disconnected. This is a side panel, not an insertion into the chat body. Open work links target existing local task conversations without copying identifiers or sending messages. Chat-link navigation has been user-verified; each panel host still requires click verification. Reopen the panel after a daemon restart or link expiry.

The compact panel keeps the representative work/result link at the top and shows every subtask link and status immediately, with named dependency arrows. Raw errors, command output, diagnostic sections, and routine timestamps are omitted, including from its read-only API. Open the work conversation or explicitly request the detailed dashboard for diagnosis. Refreshes preserve existing links. A final result may describe failure or cancellation—it is not a success badge.

API callers using explicit `mode: "direct"` get a deterministic single-task plan. Its default intent is read-only analysis; use `taskKind: "implementation"` for an explicitly authorized direct code change. Ordinary natural-language requests should keep the default automatic planning mode.

New delegated work requests a sidebar pin by default (`pin: false` opts out). The calling conversation uses the native app's sidebar tool and verifies its pinned list; the background worker does not pin itself. Only the representative work is pinned, never every subtask. Preparation can be awaited for up to 30 seconds; if the thread or app tool is unavailable, pinning remains pending without blocking execution. Routine status reads do not re-pin work you have unpinned.

New work opens a compact panel beside the requesting conversation immediately, including during preparation. Its task link appears once a real conversation exists. Say “link only” to opt out.

The detailed embedded dashboard opens only when requested. Ask `Open the web dashboard` for the standalone local page. The detailed view shows:

- Global Run and Project Run progress
- Task dependencies and current runnable state
- Assigned Agent threads and routing rationale
- Validator, retry, integration, failure, and next-action state
- Context Snapshot and execution-contract diagnostics
- Work grouped by request, with links to its execution record
- Subtask progress and dependencies, with links to each work record

Opening, refreshing, or closing the navigator never starts or completes work.

## Architecture

Work threads show the assigned request, real execution history and a readable final answer. Runtime instructions and dependency reports travel separately from the visible request. Ordinary reports no longer require JSON; custom named output contracts remain structured for compatibility. See [Work conversation](./docs/contracts/WORK_CONVERSATION.md).

![RUVORA architecture: a user goal moves through the MCP proxy and one daemon into Codex Agent threads and project workspaces, then returns as a validated result](./docs/assets/architecture-overview.svg)

| Plane | Responsibility | Explicit non-responsibility |
|---|---|---|
| **Control Plane** | Accept goals, resolve context, enforce policy, plan, and project final results | Does not perform long implementation tasks directly |
| **Orchestration Plane** | Own DAGs, routing, contracts, claims, leases, retry, recovery, and integration | Does not interpret Planner prose as authority |
| **Data Plane** | Execute one Task in an assigned Codex thread and produce evidence | Does not mutate sibling Tasks or the overall Run |

The MCP process is a thin host-facing transport proxy. One daemon owns the Registry, scheduler, and App Server writer so multiple Codex conversations can safely share durable state.

## Request lifecycle

![Request flow from context resolution and contract validation through distributed execution and result navigation](./docs/assets/request-flow.svg)

1. Record the user goal and request provenance as a durable Run.
2. Resolve relevant Context Claims and freeze an immutable Context Snapshot. Unresolved equal-authority conflicts stop here.
3. Build a Global Run → Project Run → Task DAG and persist the entire graph atomically.
4. Compile and validate every Task execution contract, then run policy and workspace preflight checks.
5. Claim only validated Tasks. The Router chooses thread reuse, fork, spawn, ephemeral execution, or waiting.
6. Collect complete Worker Turn commands, tests, outputs, and workspace evidence; the Validator checks acceptance criteria.
7. Integrate required artifacts, verify destination postconditions, and let the Completion Gate determine terminal state.
8. Preserve one durable result and provide links to the work and its subtasks.

## Core domain model

| Model | Meaning |
|---|---|
| **Context Claim** | A fact, decision, constraint, or evidence item with source thread, Turn, artifact, and observation time |
| **Context Snapshot** | Immutable input that freezes selected claims and conflict decisions for one goal |
| **Global Run** | Boundary for a user goal spanning one or more projects and its aggregate result |
| **Project Run** | Per-project authority, workspace, integration, and failure boundary |
| **Task** | Smallest execution unit with dependencies and acceptance criteria |
| **Execution Contract** | Versioned authority contract covering sandbox, network, side effects, workspace, outputs, and fingerprint |
| **Agent / Thread** | Codex execution identity that performs a Task with durable provenance |
| **Artifact / Handoff** | In-project change evidence and validated cross-project transfer |
| **Completion Evidence / Gate** | Central success decision combining commands, outputs, changes, validation, and integration |

## Safety invariants

- **Snapshot before planning:** complex goals freeze context first; planning cannot silently broaden scope or authority.
- **Plan is not permission:** role names and Planner prose never grant filesystem, network, or side-effect authority.
- **Graph before workers:** no implementation worker, managed worktree, or task attempt starts before the graph and contracts are validated and persisted. Planning may precede graph creation.
- **Fenced completion:** only the current matching `worker_id + claim_token` can complete a Task.
- **No identical configuration retry:** a configuration failure cannot automatically retry with the same contract fingerprint.
- **Artifact preservation:** unintegrated or conflicting worktrees and artifacts are retained or quarantined.
- **Global goal, local authority:** a Global Run cannot bypass project sandbox or authorization boundaries.
- **One result authority:** work lists, graph state, summaries, and responsible threads use the same durable Result projection.
- **Evidence before success:** commands, tests, artifacts, and integration evidence outrank an Agent's prose completion claim.
- **No origin append:** terminal results are not automatically injected into the requesting thread.
- **Dashboard independence:** opening or closing the dashboard is not an execution gate.

See [Architecture](./docs/ARCHITECTURE.md) and the [Execution Contract](./docs/contracts/EXECUTION_CONTRACT.md) for the detailed source of truth.

## Capabilities

- Provenance-aware context indexing, conflict resolution, immutable snapshots, and explainable thread routing
- Central state machines, strict contracts, atomic claims, leases, transient-only retries, and contract revisions
- Managed worktrees, serialized integration, crash-safe journals, quarantine, and restart recovery
- Canonical Project identity, Global Runs, Project Runs, and validated cross-project handoffs
- Work lists and subtask navigation into native Codex threads
- SQLite-backed state and an MCP Apps work navigator with local HTTP/SSE fallback

## Run from source

Requirements: Node.js 22 or later and an authenticated Codex CLI. Development checks also require ripgrep (`rg`); the pnpm commands below use pnpm 10. There are no external npm runtime dependencies.

```bash
git clone https://github.com/ruvora/codex-threadhub.git
cd codex-threadhub
node --test
```

Link the CLI after testing. Every command talks to the same local daemon and prints JSON.

```bash
PROJECT_ROOT=/absolute/path/to/project
pnpm link --global

ruvora list --cwd "$PROJECT_ROOT"
ruvora ask --cwd "$PROJECT_ROOT" --prompt "Analyze this project's structure and major risks"
ruvora ask --cwd "$PROJECT_ROOT" --sandbox workspace-write --prompt "Fix the failing tests and run them again"
```

Resume, fork, or create threads:

```bash
ruvora resume THREAD_ID
ruvora run THREAD_ID --prompt "Continue the analysis and propose a test strategy"
ruvora fork THREAD_ID
ruvora start --cwd "$PROJECT_ROOT"
ruvora start --cwd "$PROJECT_ROOT" --ephemeral
```

The legacy commands `codex-control`, `codex-control-mcp`, and `codex-control-daemon`, plus the `codex_control_plane` MCP service name, remain compatible throughout `0.14.x`. New installations and documentation use RUVORA names.

Plugin deployment must first check active work and runtime generation. Follow [Runtime Lifecycle](./docs/operations/RUNTIME_LIFECYCLE.md); after reinstalling, open a new conversation to load the new MCP generation.

## Requesting thread permissions

Hub reads the requesting thread's native turn context before accepting a new
host-originated dispatch. Its sandbox mode, network access and approval policy
are saved with the work and inherited by worker, planner, validator and
orchestrator threads, including their subsequent Turns. Full Access therefore
remains Full Access at execution time. Role instructions still define what each
thread should do; runtime permissions do not turn a review into an edit request.

A known parent whose native permissions cannot be read is rejected before child
creation. Tool arguments and prompt text cannot supply a parent permission grant.
Calls without a host origin (for example, standalone CLI clients) retain their
explicit execution contracts. Existing work retains its recorded permissions;
changing the parent's setting does not retroactively alter running work. Explicit
multi-project authorization manifests remain additional limits.

## Implementation status

| Area | Status |
|---|---|
| Package | `0.14.0` |
| Persistence | SQLite schema v8 |
| Global Run request API | v1 |
| Cross-project handoff schema | v1 |
| Implementation gates | G0–G7 complete |
| v0.14.0 release E2E | 12 scenarios passing in the recorded release check |
| Full test suite | 381/381 passing in the 2026-09-06 permission-inheritance check |
| Runtime | Node.js ≥22, no external npm dependencies |

```bash
pnpm run check
pnpm run test:g7
git diff --check
```

See [G7 E2E Evidence](./docs/G7_E2E_EVIDENCE.md) for terminal-state and next-action evidence.
The v0.14.0 clean-clone release check is recorded in [Release Candidate E2E Evidence](./docs/RELEASE_E2E_EVIDENCE.md).

The [2026-09-06 parent-permission verification](./docs/PARENT_PERMISSIONS_2026-09-06.md) records the subsequent full-suite run and native worker/validator checks. These are dated results, not a claim that every future checkout or host has been verified.

## Repository layout

```text
src/      daemon, registry, state machines, contracts, routing, MCP/CLI
ui/       embedded dashboard
test/     unit, contract, recovery, integration, and E2E tests
docs/     architecture, ADRs, contracts, operations, and verification gates
scripts/  runtime parity, deployment, and reinstall preflight
```

## Documentation map

| Question | Document |
|---|---|
| Why does this project exist? | [Product Direction](./docs/PRODUCT_DIRECTION.md) |
| What are the system boundaries? | [Architecture](./docs/ARCHITECTURE.md) |
| Where is the complete design index? | [Documentation Index](./docs/README.md) |
| What terminology is canonical? | [Terminology](./docs/TERMINOLOGY.md) |
| How are context and conflicts resolved? | [Context Resolution](./docs/contracts/CONTEXT_RESOLUTION.md) |
| Which state transitions are legal? | [State Machines](./docs/contracts/STATE_MACHINES.md) |
| How are authority, sandbox, and fingerprints enforced? | [Execution Contract](./docs/contracts/EXECUTION_CONTRACT.md) |
| How do Global Runs and handoffs work? | [Global Runs](./docs/contracts/GLOBAL_RUNS.md) |
| How are schema and migrations managed? | [Persistence](./docs/contracts/PERSISTENCE.md) |
| How do retry, recovery, and integration work? | [Failure Recovery](./docs/operations/FAILURE_RECOVERY.md) |
| How are deployment and daemon handover managed? | [Runtime Lifecycle](./docs/operations/RUNTIME_LIFECYCLE.md) |
| What is planned next? | [Roadmap](./ROADMAP.md) |
| How is a release verified and published? | [Release Process](./RELEASING.md) |

## Product boundaries

- RUVORA coordinates a local Codex App Server and project workspaces; it is not a cloud orchestration service.
- Global Runs and repair surfaces never auto-authorize external mutations or destructive actions.
- The Desktop sidebar hierarchy belongs to the host. RUVORA supplies thread names, pin attempts, and native thread-ID handoffs.
- The work navigator exposes state, results, and thread navigation; it is not execution authority or a manual Start gate.

## Reference

- [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
- [Contributing](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md) · [Security](./SECURITY.md) · [License](./LICENSE)

## Author

Created and maintained by [ShinYEB](https://github.com/ShinYEB).
