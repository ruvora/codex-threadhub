# Output observation and compact status correction

## Subsequent raw-record finding and fix

The next run (`run_17253436-7549-4cda-a832-50e3646649d6`) reproduced the rejection.
Unlike the initial diagnosis based only on projected records, direct inspection
of that worker's native rollout confirmed explicit empty stdout/stderr/output and
the four chunk IDs quoted in its report. The projected command record had null
output and a different identifier namespace. The worker report was delivered
unchanged. These two rejection reasons were false positives, not worker fabrication.

The correction now reconciles exact-session/turn/item native events before normal
completion and recovery, restores only missing output with provenance, and carries
worker-visible chunk receipts separately. Conflicting native fields cause validation
uncertainty deterministically; models cannot approve that conflict. Missing native
files do not justify inferring an empty log. No chunk-to-command mapping is guessed.

An isolated actual validator replay of the original unchanged report with restored
evidence returned `accept`, with no unmet criteria. The original production database
was read-only, and its failed status was not changed. This establishes correction
of this incident, not a fresh end-to-end orchestration pass. Initial policy-only
changes below were insufficient and should not be mistaken for the final cause.

## Confirmed incident

Run `run_192ab0cc-fb32-4e1d-8507-3162a48266be` finished failed, with three
successful tasks and one validation rejection. The rejected test report claimed
an observed empty AGENTS search output. The persisted search receipt had exit 1
and `aggregatedOutput: null`. The three Node test receipts separately supported
5 + 2 + 2 passing tests. Their success does not approve the inaccurate report.

## Root cause and boundary

The execution classifier already treated narrowly recognized `rg --files` exit 1
as no matches. Documentation called this an *observed empty file list*, while the
validator correctly treated null logs as unavailable. Workers did not receive
that same explicit observation policy. Semantic outcome and captured output were
conflated across these layers. The source of this particular native null value
cannot be determined from the persisted record; it must not be silently converted
to an empty string or described as proven output loss.

## Correction

- Share one evidence interpretation policy between workers and validators.
- Supply derived command outcome and output-observation fields in validation and
  revision handoffs, retaining the original receipts unchanged.
- Say no matches **inferred from exit code**, not empty output **observed**, when
  logs are unavailable. Unsupported counts/observations still require correction.
- Render compact status text at the MCP response boundary, including actual links,
  separate success/rejection counts and attention reason. Preserve structured data.
- Acknowledge accepted work immediately without inventing an early thread link.
  The compact panel also distinguishes result rejection and exposes its reason.

No old failed work is retried or rewritten. No extra model turns are used to
refresh progress. Automatic insertion/updating of a card after the requesting
turn ends is not implemented. Host navigation and future model compliance still
require a fresh live verification; regression tests alone do not establish them.
