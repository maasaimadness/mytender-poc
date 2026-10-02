---
name: evidence-assessment
description: Assess tender claims, evidence gaps, conflicts, and submission readiness.
---

# Evidence assessment

Use this skill after drafting or whenever evidence changes. Persist one complete
assessment with `recordEvidenceAssessment`; it replaces the workspace's claims,
missing evidence, and derived warnings rather than appending a partial update.
The saved assessment and `reviewWorkspace` result, not a narrative conclusion,
determine readiness.

## Claim statuses

Use `supported` only when the claim is directly supported by valid source blocks
from `bidder_fact` documents. Use `unverified` when the available blocks do not
establish the claim. Use `conflicting` when a known conflict group contains
evidence that cannot be reconciled for the claim. Use `rejected` for a claim
that should not be relied on. Do not label a claim `supported` merely because it
has a citation: source role, source block existence, and the block's actual
content all matter.

## Assess the full workspace

Begin with `inspectWorkspace`; compare the current `draft`, `requirements`,
`sourceDocuments`, `sourceBlocks`, `retrievedBlockIds`, `missingEvidence`, and
`conflictingEvidenceGroups`. Search with `searchEvidence` and read relevant
blocks with `readSourceBlocks` before assessing factual claims. Evidence searches
and reads should be specific to the drafted statements and requirements rather
than broad exploratory retrieval.

Submit `recordEvidenceAssessment` with every current claim in `claims` and every
genuine evidence gap in `missingEvidence`. This must include each mandatory
requirement absent from persisted draft coverage. Each claim needs a unique
`id`, its exact `text`, `sourceBlockIds`, and a valid status. Include only known
source block IDs. Every `missingEvidence` entry needs a known `requirementId` and
a concrete `reason`. A placeholder section is not safe failure: omit it rather
than writing it (there is no delete tool).

## Source, block, and requirement validation

Check that each cited source block exists in the workspace, is tied to the claim
being assessed, and comes from a `bidder_fact` document when it supports a
bidder fact. Claims with unsupported, irrelevant, absent, or non-bidder-fact
evidence are not supported. Confirm that required draft coverage maps to real
requirement IDs; do not create a gap under an invented requirement. Review every
mandatory requirement that has no adequate persisted draft section and record
the reason evidence or coverage is missing.

## Known conflict groups

For a `conflicting` claim, cite every source block in one complete known entry of
`conflictingEvidenceGroups`. Citing only part of a group does not represent its
conflict. A claim that cites any conflict-group block cannot remain `supported`:
the recorded result will be downgraded unless it cites a complete group and is
therefore `conflicting`. Do not conceal a conflict by selecting one block or by
marking an uncertain claim as `unverified` when the full known group is present.

## Warnings, readiness, and completion

`recordEvidenceAssessment` derives `INSUFFICIENT_EVIDENCE` when gaps remain, no
blocks were retrieved, or a claim is not `supported`. Call `reviewWorkspace`
after recording the complete replacement. Its `readiness.canSubmit` is true only
when there is a draft, all requirements are covered, citations are valid, claims
are supported, conflicts are resolved, and warnings are absent.

Complete the assessment only after persisting every claim and gap, then report
the deterministic readiness result. If it is false, identify the concrete
missing evidence, invalid citation, requirement, claim, conflict group, or
warning that prevents submission; do not declare readiness.
