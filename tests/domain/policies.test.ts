import { describe, expect, it } from "vitest";

import {
  assessClaim,
  capabilityEvidence,
  missingRequirements,
  preserveQuestionVariants,
  reviseSection,
  validateCitations,
  warningsForRetrieval,
  type Draft,
  type SourceBlock,
  type SourceDocument,
} from "../../src/domain/index.js";

const documents: SourceDocument[] = [
  { id: "contract", role: "exercise_contract", title: "Exercise contract" },
  { id: "buyer", role: "buyer_requirement", title: "Buyer requirement" },
  { id: "fact", role: "bidder_fact", title: "Bidder fact" },
  { id: "positioning", role: "bidder_positioning", title: "Positioning" },
  { id: "quality", role: "quality_reference", title: "Quality reference" },
];

const blocks: SourceBlock[] = documents.map((document) => ({
  id: `${document.id}-block`,
  documentId: document.id,
  locator: "section 1",
  text: `Sanitized ${document.role} text`,
}));

const draft: Draft = {
  id: "draft-1",
  sections: [
    {
      id: "approach",
      heading: "Approach",
      content: "Supported approach.",
      requirementIds: ["r1"],
      citations: [{ sourceBlockId: "fact-block" }],
    },
    {
      id: "governance",
      heading: "Governance",
      content: "Unrelated content.",
      requirementIds: [],
      citations: [],
    },
  ],
};

describe("deterministic domain policies", () => {
  it("allows capability evidence only from bidder facts", () => {
    expect(capabilityEvidence(documents, blocks).map((block) => block.id)).toEqual(["fact-block"]);
  });

  it("finds citations that do not resolve to an allowed stable block id", () => {
    const citedDraft: Draft = {
      ...draft,
      sections: [{ ...draft.sections[0]!, citations: [{ sourceBlockId: "fact-block" }, { sourceBlockId: "unknown" }] }],
    };
    expect(validateCitations(citedDraft, ["fact-block"])).toEqual([
      { sectionId: "approach", sourceBlockId: "unknown" },
    ]);
  });

  it("does not support claims with missing, non-fact, conflicting, or rejected evidence", () => {
    const claim = { id: "claim-1", text: "We have capability.", sourceBlockIds: ["fact-block"] };
    expect(assessClaim(claim, documents, blocks).status).toBe("supported");
    expect(assessClaim({ ...claim, sourceBlockIds: [] }, documents, blocks).status).toBe("unverified");
    expect(assessClaim({ ...claim, sourceBlockIds: ["buyer-block"] }, documents, blocks).status).toBe("unverified");
    expect(assessClaim(claim, documents, blocks, { conflicting: true }).status).toBe("conflicting");
    expect(assessClaim(claim, documents, blocks, { rejected: true }).status).toBe("rejected");
  });

  it("creates an insufficient-evidence warning for empty retrieval", () => {
    expect(warningsForRetrieval([])).toEqual([
      { code: "INSUFFICIENT_EVIDENCE", message: "No evidence blocks were retrieved." },
    ]);
    expect(warningsForRetrieval(blocks)).toEqual([]);
  });

  it("preserves each question variant and its source-specific fields", () => {
    const variants = preserveQuestionVariants([
      { sourceDocumentId: "question-b", sourceOrder: 2, sourceValue: "Second", weight: 25, wordLimit: 500 },
      { sourceDocumentId: "question-a", sourceOrder: 1, sourceValue: "First", weight: 75, wordLimit: 250 },
    ]);
    expect(variants).toEqual([
      { sourceDocumentId: "question-a", sourceOrder: 1, sourceValue: "First", weight: 75, wordLimit: 250 },
      { sourceDocumentId: "question-b", sourceOrder: 2, sourceValue: "Second", weight: 25, wordLimit: 500 },
    ]);
  });

  it("leaves unsatisfied requirements visible in a partial draft", () => {
    expect(missingRequirements([
      { id: "r1", text: "First", mandatory: true },
      { id: "r2", text: "Second", mandatory: true },
    ], draft)).toEqual([{ requirementId: "r2", reason: "No draft section addresses this requirement." }]);
  });

  it("revises only the targeted section without mutating the original draft", () => {
    const revised = reviseSection(draft, "approach", {
      content: "Revised supported approach.",
      requirementIds: ["r1"],
      citations: [{ sourceBlockId: "fact-block" }],
    });
    expect(revised.sections[0]!.content).toBe("Revised supported approach.");
    expect(revised.sections[1]).toEqual(draft.sections[1]);
    expect(draft.sections[0]!.content).toBe("Supported approach.");
  });
});
