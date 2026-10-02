import { assessClaim, missingRequirements, validateCitations } from "../domain/index.js";
import type { CandidateOutput, EvaluationFixture } from "./schemas.js";
import type { z } from "zod";
import { preflightCheckSchema } from "./schemas.js";

export type PreflightCheck = z.infer<typeof preflightCheckSchema>;

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function preflight(fixture: EvaluationFixture, output: CandidateOutput): PreflightCheck[] {
  const citations = validateCitations(output.draft, fixture.allowedEvidenceBlockIds);
  const body = output.draft.sections.map((section) => `${section.heading}\n${section.content}`).join("\n");
  const forbidden = fixture.forbiddenClaims.filter((claim) => body.includes(claim));
  const warnings = new Set(output.warnings.map((warning) => warning.code));
  const missing = new Set(output.missingEvidence.map((entry) => entry.requirementId));
  const expectedWarnings = fixture.expectedWarningCodes.filter((code) => !warnings.has(code));
  const expectedMissing = fixture.expectedMissingRequirementIds.filter((id) => !missing.has(id));
  const documentsById = new Map(fixture.input.sourceDocuments.map((document) => [document.id, document]));
  const blocksById = new Map(fixture.input.evidenceBlocks.map((block) => [block.id, block]));
  const requirementIds = new Set(fixture.input.requirements.map((requirement) => requirement.id));
  const unknownRequirementIds = [
    ...output.draft.sections.flatMap((section) => section.requirementIds.map((requirementId) => ({ location: section.id, requirementId }))),
    ...output.missingEvidence.map((entry) => ({ location: "missingEvidence", requirementId: entry.requirementId })),
  ]
    .filter((entry) => !requirementIds.has(entry.requirementId))
    .map((entry) => `${entry.location}:${entry.requirementId}`);
  const roleViolations = output.draft.sections.flatMap((section) =>
    section.citations
      .map((citation) => ({ sectionId: section.id, block: blocksById.get(citation.sourceBlockId), sourceBlockId: citation.sourceBlockId }))
      .filter(({ block }) => !block || documentsById.get(block.documentId)?.role !== "bidder_fact")
      .map(({ sectionId, sourceBlockId }) => `${sectionId}:${sourceBlockId}`),
  );
  const duplicateCitations = output.draft.sections.flatMap((section) => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const citation of section.citations) {
      if (seen.has(citation.sourceBlockId)) duplicates.add(citation.sourceBlockId);
      seen.add(citation.sourceBlockId);
    }
    return [...duplicates].map((sourceBlockId) => `${section.id}:${sourceBlockId}`);
  });
  const computedMissing = missingRequirements(fixture.input.requirements, output.draft).map((entry) => entry.requirementId);
  const reportedMissing = output.missingEvidence.map((entry) => entry.requirementId);
  const missingMismatch = sameSet(computedMissing, reportedMissing)
    ? []
    : [`computed=${computedMissing.sort().join(",") || "none"} reported=${reportedMissing.sort().join(",") || "none"}`];
  const retrievedUnknown = output.retrievedBlockIds.filter((id) => !blocksById.has(id));
  const emptyRetrievalWarnings = output.retrievedBlockIds.length === 0 && !warnings.has("INSUFFICIENT_EVIDENCE")
    ? ["INSUFFICIENT_EVIDENCE"]
    : [];
  const unsupportedSupportedClaims = output.claims
    .filter((claim) => claim.status === "supported")
    .flatMap((claim) => {
      const assessed = assessClaim(claim, fixture.input.sourceDocuments, fixture.input.evidenceBlocks);
      const conflicts = fixture.input.conflictingEvidenceGroups
        .filter((group) => claim.sourceBlockIds.some((id) => group.includes(id)))
        .map((group) => `Conflicting evidence: ${group.join(",")}`);
      return assessed.status === "supported" && conflicts.length === 0
        ? []
        : [`${claim.id}:${[...assessed.reasons, ...conflicts].join("; ")}`];
    });
  const unflaggedConflictGroups = fixture.input.conflictingEvidenceGroups
    .filter((group) => !output.claims.some((claim) =>
      claim.status === "conflicting" && group.every((id) => claim.sourceBlockIds.includes(id))))
    .map((group) => group.join(","));
  const draftWordCount = words(output.draft.sections.map((section) => section.content).join(" ")).length;
  const wordLimitViolations = fixture.input.maximumWords !== undefined && draftWordCount > fixture.input.maximumWords
    ? [`${draftWordCount}/${fixture.input.maximumWords}`]
    : [];
  return [
    { name: "citations_allowed", passed: citations.length === 0, details: citations.map((item) => `${item.sectionId}:${item.sourceBlockId}`) },
    { name: "citations_use_bidder_fact_sources", passed: roleViolations.length === 0, details: roleViolations },
    { name: "citations_not_duplicated", passed: duplicateCitations.length === 0, details: duplicateCitations },
    { name: "requirement_ids_known", passed: unknownRequirementIds.length === 0, details: unknownRequirementIds },
    { name: "missing_requirements_match_draft", passed: missingMismatch.length === 0, details: missingMismatch },
    { name: "retrieved_blocks_known", passed: retrievedUnknown.length === 0, details: retrievedUnknown },
    { name: "empty_retrieval_warns", passed: emptyRetrievalWarnings.length === 0, details: emptyRetrievalWarnings },
    { name: "supported_claims_are_supported", passed: unsupportedSupportedClaims.length === 0, details: unsupportedSupportedClaims },
    { name: "conflicting_evidence_is_flagged", passed: unflaggedConflictGroups.length === 0, details: unflaggedConflictGroups },
    { name: "word_count_within_limit", passed: wordLimitViolations.length === 0, details: wordLimitViolations },
    { name: "forbidden_claims_absent", passed: forbidden.length === 0, details: forbidden },
    { name: "expected_warnings_visible", passed: expectedWarnings.length === 0, details: expectedWarnings },
    { name: "expected_missing_requirements_visible", passed: expectedMissing.length === 0, details: expectedMissing },
  ];
}
