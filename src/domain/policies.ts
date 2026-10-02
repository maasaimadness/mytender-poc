import type {
  Claim,
  ClaimStatus,
  Draft,
  DraftSection,
  MissingEvidence,
  QuestionSourceVariant,
  Requirement,
  SourceBlock,
  SourceDocument,
  Warning,
} from "./types.js";

const documentById = (documents: readonly SourceDocument[]): Map<string, SourceDocument> =>
  new Map(documents.map((document) => [document.id, document]));

/** Returns only blocks that are permitted to substantiate bidder capability. */
export function capabilityEvidence(
  documents: readonly SourceDocument[],
  blocks: readonly SourceBlock[],
): SourceBlock[] {
  const documentsById = documentById(documents);
  return blocks.filter((block) => documentsById.get(block.documentId)?.role === "bidder_fact");
}

export interface CitationViolation {
  sectionId: string;
  sourceBlockId: string;
}

export function validateCitations(
  draft: Draft,
  allowedEvidenceBlockIds: readonly string[],
): CitationViolation[] {
  const allowed = new Set(allowedEvidenceBlockIds);
  return draft.sections.flatMap((section) =>
    section.citations
      .filter((citation) => !allowed.has(citation.sourceBlockId))
      .map((citation) => ({ sectionId: section.id, sourceBlockId: citation.sourceBlockId })),
  );
}

export interface ClaimAssessment {
  status: ClaimStatus;
  reasons: string[];
}

/** Determines whether a claim may be treated as supported by the supplied evidence. */
export function assessClaim(
  claim: Omit<Claim, "status">,
  documents: readonly SourceDocument[],
  blocks: readonly SourceBlock[],
  options: { conflicting?: boolean; rejected?: boolean } = {},
): ClaimAssessment {
  if (options.rejected) return { status: "rejected", reasons: ["Claim was rejected by policy."] };
  if (options.conflicting) return { status: "conflicting", reasons: ["Evidence conflicts."] };

  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const documentsById = documentById(documents);
  const reasons: string[] = [];

  if (claim.sourceBlockIds.length === 0) reasons.push("Claim has no cited evidence.");
  for (const sourceBlockId of claim.sourceBlockIds) {
    const block = blocksById.get(sourceBlockId);
    if (!block) {
      reasons.push(`Evidence block ${sourceBlockId} does not exist.`);
    } else if (documentsById.get(block.documentId)?.role !== "bidder_fact") {
      reasons.push(`Evidence block ${sourceBlockId} is not bidder fact evidence.`);
    }
  }
  return reasons.length === 0 ? { status: "supported", reasons } : { status: "unverified", reasons };
}

/** Keeps variants as separate source records, ordered only by their source order. */
export function preserveQuestionVariants(
  variants: readonly QuestionSourceVariant[],
): QuestionSourceVariant[] {
  return [...variants].sort((left, right) => left.sourceOrder - right.sourceOrder);
}

export function warningsForRetrieval(retrievedBlocks: readonly SourceBlock[]): Warning[] {
  return retrievedBlocks.length === 0
    ? [{ code: "INSUFFICIENT_EVIDENCE", message: "No evidence blocks were retrieved." }]
    : [];
}

export function missingRequirements(
  requirements: readonly Requirement[],
  draft: Draft,
): MissingEvidence[] {
  const covered = new Set(draft.sections.flatMap((section) => section.requirementIds));
  return requirements
    .filter((requirement) => !covered.has(requirement.id))
    .map((requirement) => ({
      requirementId: requirement.id,
      reason: "No draft section addresses this requirement.",
    }));
}

export type SectionRevision = Pick<DraftSection, "content" | "citations" | "requirementIds">;

/** Returns a new draft, replacing only the expressly targeted section. */
export function reviseSection(draft: Draft, sectionId: string, revision: SectionRevision): Draft {
  if (!draft.sections.some((section) => section.id === sectionId)) {
    throw new Error(`Draft section ${sectionId} does not exist.`);
  }
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.id === sectionId ? { ...section, ...revision } : section,
    ),
  };
}
