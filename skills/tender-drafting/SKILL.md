---
name: tender-drafting
description: Draft evidence-backed tender sections from the trusted workspace.
---

# Tender drafting

Use this skill to create or revise the persisted tender response. The workspace is
the artifact: do not treat a chat summary as a substitute for saved plan, draft,
assessment, or review state.

## Inputs and source roles

Start with `inspectWorkspace`. Use its `question`, `requirements`, current
`plan`, `draft`, `missingEvidence`, and source inventory to decide the next
action. Treat `buyer_requirement` as the buyer's requested outcome and
`exercise_contract` as tender context. Use `bidder_fact` source blocks as the
only evidence for factual bidder claims and section citations. Do not use
`bidder_positioning` or `quality_reference` to establish a bidder fact; they may
help frame a response only when the underlying factual claims are separately
supported by `bidder_fact` evidence.

## Workflow

1. Call `inspectWorkspace` before planning or drafting. Load this skill before
   substantive work.
2. Use `searchEvidence` with focused requirement or topic terms. Restrict the
   search to `role: "bidder_fact"` when finding support for bidder claims.
   `searchEvidence` records retrieval, but search results are not enough to
   support a claim: call `readSourceBlocks` for the specific blocks you use.
3. Write a complete `plan` with `writePlan` before any section. Each planned
   section has a stable `id`, clear `heading`, and the applicable
   `requirementIds`. Cover all mandatory requirements with the plan shape that
   best serves the question; do not invent requirement IDs.
4. Draft one planned section at a time with `writeSection`. Supply its planned
   `id`, heading, content, the addressed `requirementIds`, and `citations` using
   `sourceBlockId` values read from trusted bidder-fact evidence. A later write
   to the same section ID replaces that persisted section, so use it for precise
   revision rather than duplicating sections.
5. After drafting or revising, inspect the workspace again. Then complete the
   evidence assessment and deterministic review before claiming the work is
   finished.

## Sections and citations

Write directly to the buyer's requirements. Separate commitments, capabilities,
and outcomes when that makes coverage clear. Every factual statement about the
bidder must be grounded in the cited bidder-fact blocks for that section. Keep
claims narrower than the evidence: do not infer delivery history, capacity,
certifications, scope, quantities, or outcomes that the block does not state.

Citations are block IDs, not document titles or prose references. Cite the
relevant `sourceBlockId` on the section; citations must refer to existing source
blocks whose document role is `bidder_fact`. A citation supports the content it
is attached to, not unrelated sections. Do not draft a factual assertion merely
because its block appeared in the source inventory or a search result.

## Missing or conflicting evidence

When the workspace lacks support for a required factual response, do not invent
or soften it into an unsupported certainty. Write only what the evidence allows,
record the gap through the complete assessment, and leave readiness to
`reviewWorkspace`. If evidence conflicts, read every relevant block and do not
choose a preferred version without representing the conflict in the assessment.

## Review and completion

Call `reviewWorkspace` after the final persisted assessment. Resolve its missing
requirements, citation issues, unsupported claims, unresolved conflict groups,
and warnings where evidence permits. Completion means the plan and intended
sections are persisted, every factual bidder claim has valid cited evidence, the
complete evidence assessment is recorded, and `reviewWorkspace` reports
`readiness.canSubmit: true`. Otherwise state the blocking gaps briefly and do
not say the submission is ready.
