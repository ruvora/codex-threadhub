# Output observation and compact status correction

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
