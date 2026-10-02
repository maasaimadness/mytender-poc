import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileWorkspaceStore, TenderToolService, type Workspace } from "../../src/agent/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createService(): Promise<{ service: TenderToolService; store: FileWorkspaceStore; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "mytender-workspace-"));
  temporaryRoots.push(root);
  const store = new FileWorkspaceStore(root);
  const workspace: Workspace = {
    id: "sanitized-workspace",
    question: "Describe our secure customer outcomes.",
    sourceDocuments: [
      { id: "facts", role: "bidder_fact", title: "Sanitized bidder facts" },
      { id: "buyer", role: "buyer_requirement", title: "Sanitized buyer requirements" },
    ],
    sourceBlocks: [
      { id: "fact-alpha", documentId: "facts", locator: "1", text: "Customers reduced handoff time by twenty percent." },
      { id: "fact-beta", documentId: "facts", locator: "2", text: "Secure onboarding improved completion accuracy." },
      { id: "fact-gamma", documentId: "facts", locator: "3", text: "Secure reporting improved customer visibility." },
      { id: "buyer-alpha", documentId: "buyer", locator: "1", text: "The buyer requires secure onboarding." },
    ],
    requirements: [
      { id: "outcome", text: "Describe an outcome", mandatory: true },
      { id: "security", text: "Describe security", mandatory: true },
    ],
    warnings: [],
    missingEvidence: [],
    claims: [],
    retrievedBlockIds: [],
    events: [],
    conflictingEvidenceGroups: [],
  };
  await store.save(workspace);
  return { service: new TenderToolService(store), store, workspace };
}

describe("filesystem workspace tender tools", () => {
  it("persists mutations and reloads validated workspace state", async () => {
    const { service, store } = await createService();
    await service.writePlan("sanitized-workspace", {
      sections: [{ id: "outcomes", heading: "Outcomes", requirementIds: ["outcome"] }],
    });

    const reloaded = await store.load("sanitized-workspace");
    expect(reloaded.plan?.sections).toEqual([{ id: "outcomes", heading: "Outcomes", requirementIds: ["outcome"] }]);
    expect(reloaded.events.at(-1)).toEqual({ type: "plan_written", message: "Saved 1 plan section(s)." });
  });

  it("rejects traversal-like workspace IDs", async () => {
    const { store } = await createService();
    await expect(store.load("../outside")).rejects.toThrow("Workspace IDs");
    await expect(store.load("safe/other")).rejects.toThrow("Workspace IDs");
  });

  it("filters evidence by bidder_fact role and ranks ties by stable block ID", async () => {
    const { service } = await createService();
    const results = await service.searchEvidence("sanitized-workspace", "secure onboarding", { role: "bidder_fact", limit: 2 });

    expect(results.map(({ block }) => block.id)).toEqual(["fact-beta", "fact-gamma"]);
    expect((await service.inspectWorkspace("sanitized-workspace")).retrievedBlockIds).toEqual(["fact-beta", "fact-gamma"]);
  });

  it("ranks equal-overlap evidence deterministically", async () => {
    const { service } = await createService();
    const results = await service.searchEvidence("sanitized-workspace", "secure", { role: "bidder_fact" });

    expect(results.map(({ block }) => block.id)).toEqual(["fact-beta", "fact-gamma"]);
  });

  it("fails explicitly when a requested source block is unknown", async () => {
    const { service } = await createService();
    await expect(service.readSourceBlocks("sanitized-workspace", ["missing-block"])).rejects.toThrow("Unknown source block ID: missing-block");
  });

  it("rejects plans with duplicate sections or unknown requirements", async () => {
    const { service } = await createService();
    await expect(service.writePlan("sanitized-workspace", {
      sections: [
        { id: "same", heading: "First", requirementIds: ["outcome"] },
        { id: "same", heading: "Second", requirementIds: ["security"] },
      ],
    })).rejects.toThrow("Plan section IDs must be unique");
    await expect(service.writePlan("sanitized-workspace", {
      sections: [{ id: "unknown", heading: "Unknown", requirementIds: ["not-a-requirement"] }],
    })).rejects.toThrow("Unknown requirement ID: not-a-requirement");
  });

  it("updates only the targeted draft section", async () => {
    const { service } = await createService();
    await service.writePlan("sanitized-workspace", {
      sections: [
        { id: "outcomes", heading: "Outcomes", requirementIds: ["outcome"] },
        { id: "security", heading: "Security", requirementIds: ["security"] },
      ],
    });
    await service.writeSection("sanitized-workspace", {
      id: "outcomes", heading: "Outcomes", content: "Original outcome.", requirementIds: ["outcome"], citations: [{ sourceBlockId: "fact-alpha" }],
    });
    await service.writeSection("sanitized-workspace", {
      id: "security", heading: "Security", content: "Secure onboarding.", requirementIds: ["security"], citations: [{ sourceBlockId: "fact-beta" }],
    });
    const updated = await service.writeSection("sanitized-workspace", {
      id: "outcomes", heading: "Outcomes", content: "Updated outcome.", requirementIds: ["outcome"], citations: [{ sourceBlockId: "fact-alpha" }],
    });

    expect(updated.draft?.sections).toEqual([
      { id: "outcomes", heading: "Outcomes", content: "Updated outcome.", requirementIds: ["outcome"], citations: [{ sourceBlockId: "fact-alpha" }] },
      { id: "security", heading: "Security", content: "Secure onboarding.", requirementIds: ["security"], citations: [{ sourceBlockId: "fact-beta" }] },
    ]);
  });

  it("requires planned sections supported by bidder facts", async () => {
    const { service } = await createService();
    const section = {
      id: "outcomes", heading: "Outcomes", content: "Customer outcome.", requirementIds: ["outcome"], citations: [{ sourceBlockId: "fact-alpha" }],
    };

    await expect(service.writeSection("sanitized-workspace", section)).rejects.toThrow("response plan");
    await service.writePlan("sanitized-workspace", {
      sections: [{ id: "security", heading: "Security", requirementIds: ["security"] }],
    });
    await expect(service.writeSection("sanitized-workspace", section)).rejects.toThrow("not in the response plan: outcomes");
    await expect(service.writeSection("sanitized-workspace", {
      ...section,
      id: "security",
      heading: "Security",
      requirementIds: ["security"],
      citations: [{ sourceBlockId: "buyer-alpha" }],
    })).rejects.toThrow("bidder_fact evidence: buyer-alpha");
  });

  it("downgrades unsafe supported claims and derives deduplicated gaps and warnings", async () => {
    const { service } = await createService();
    const updated = await service.recordEvidenceAssessment("sanitized-workspace", {
      claims: [{ id: "unsafe", text: "Unsupported", sourceBlockIds: [], status: "supported" }],
      missingEvidence: [
        { requirementId: "outcome", reason: "Caller outcome gap." },
        { requirementId: "outcome", reason: "Latest caller outcome gap." },
      ],
    });

    expect(updated.claims).toEqual([{ id: "unsafe", text: "Unsupported", sourceBlockIds: [], status: "unverified" }]);
    expect(updated.missingEvidence).toEqual([
      { requirementId: "outcome", reason: "Latest caller outcome gap." },
      { requirementId: "security", reason: "No draft section addresses this requirement." },
    ]);
    expect(updated.warnings.map((warning) => warning.code)).toEqual(["INSUFFICIENT_EVIDENCE"]);
    expect(updated.events.at(-1)?.type).toBe("evidence_assessment_recorded");
  });

  it("records a known conflict only when every group block is cited", async () => {
    const { service, store, workspace } = await createService();
    await store.save({ ...workspace, conflictingEvidenceGroups: [["fact-alpha", "fact-beta"]] });

    await expect(service.recordEvidenceAssessment("sanitized-workspace", {
      claims: [{ id: "partial", text: "Partial conflict", sourceBlockIds: ["fact-alpha"], status: "conflicting" }],
    })).rejects.toThrow("every block in a known conflict group");
    const updated = await service.recordEvidenceAssessment("sanitized-workspace", {
      claims: [{ id: "complete", text: "Complete conflict", sourceBlockIds: ["fact-alpha", "fact-beta"], status: "supported" }],
    });
    expect(updated.claims[0]?.status).toBe("conflicting");
  });

  it("reviews a clean supported assessment as submit-ready without mutating state", async () => {
    const { service, store } = await createService();
    await service.writePlan("sanitized-workspace", {
      sections: [
        { id: "outcomes", heading: "Outcomes", requirementIds: ["outcome"] },
        { id: "security", heading: "Security", requirementIds: ["security"] },
      ],
    });
    await service.writeSection("sanitized-workspace", {
      id: "outcomes", heading: "Outcomes", content: "Outcome.", requirementIds: ["outcome"], citations: [{ sourceBlockId: "fact-alpha" }],
    });
    await service.writeSection("sanitized-workspace", {
      id: "security", heading: "Security", content: "Security.", requirementIds: ["security"], citations: [{ sourceBlockId: "fact-beta" }],
    });
    await service.readSourceBlocks("sanitized-workspace", ["fact-alpha", "fact-beta"]);
    await service.recordEvidenceAssessment("sanitized-workspace", {
      claims: [{ id: "outcome-claim", text: "Outcome", sourceBlockIds: ["fact-alpha"], status: "supported" }],
    });
    const before = await store.load("sanitized-workspace");
    const review = await service.reviewWorkspace("sanitized-workspace");
    const after = await store.load("sanitized-workspace");

    expect(review).toEqual({
      missingRequirementIds: [], citationIssues: [], claimIssues: [], unresolvedConflictGroups: [], warningCodes: [],
      readiness: { canSubmit: true, reasons: [] },
    });
    expect(after).toEqual(before);
  });

  it("accepts draft content under a workspace word limit", async () => {
    const { service, store, workspace } = await createService();
    await store.save({
      ...workspace,
      maximumWords: 2,
      draft: { id: "draft-sanitized-workspace", sections: [{
        id: "complete", heading: "Ignored heading words", content: "One two", requirementIds: ["outcome", "security"], citations: [],
      }] },
    });

    expect((await service.reviewWorkspace("sanitized-workspace")).readiness).toEqual({ canSubmit: true, reasons: [] });
  });

  it("reports an exceeded workspace word limit without mutating state", async () => {
    const { service, store, workspace } = await createService();
    await store.save({
      ...workspace,
      maximumWords: 1,
      draft: { id: "draft-sanitized-workspace", sections: [{
        id: "complete", heading: "Ignored heading words", content: "One two", requirementIds: ["outcome", "security"], citations: [],
      }] },
    });
    const before = await store.load("sanitized-workspace");
    const review = await service.reviewWorkspace("sanitized-workspace");
    const after = await store.load("sanitized-workspace");

    expect(review.readiness).toEqual({ canSubmit: false, reasons: ["WORD_LIMIT_EXCEEDED"] });
    expect(after).toEqual(before);
  });

  it("does not apply a word limit when the workspace has none", async () => {
    const { service, store, workspace } = await createService();
    await store.save({
      ...workspace,
      draft: { id: "draft-sanitized-workspace", sections: [{
        id: "complete", heading: "Ignored heading words", content: "One two", requirementIds: ["outcome", "security"], citations: [],
      }] },
    });

    expect((await service.reviewWorkspace("sanitized-workspace")).readiness).toEqual({ canSubmit: true, reasons: [] });
  });
});
