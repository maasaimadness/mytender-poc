import { z } from "zod";

import {
  assessClaim,
  claimSchema,
  draftSectionSchema,
  missingRequirements,
  sourceRoleSchema,
  type Claim,
  type DraftSection,
  type MissingEvidence,
  type SourceBlock,
  type SourceRole,
  type Warning,
} from "../domain/index.js";
import {
  planSectionSchema,
  responsePlanSchema,
  type FileWorkspaceStore,
  type ResponsePlan,
  type Workspace,
} from "./workspace.js";

const MAX_SEARCH_RESULTS = 20;

const searchOptionsSchema = z.object({
  role: sourceRoleSchema.optional(),
  limit: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(),
}).optional();

const missingEvidenceSchema = z.object({
  requirementId: z.string().min(1),
  reason: z.string().min(1),
});

export const evidenceAssessmentSchema = z.object({
  claims: z.array(claimSchema),
  missingEvidence: z.array(missingEvidenceSchema).optional(),
});
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;

export interface WorkspaceReview {
  missingRequirementIds: string[];
  citationIssues: Array<{ sectionId: string; sourceBlockId: string; code: "UNKNOWN_SOURCE_BLOCK" | "NON_BIDDER_FACT_CITATION" }>;
  claimIssues: Array<{ claimId: string; code: "UNSUPPORTED_CLAIM" | "UNRESOLVED_CONFLICT" }>;
  unresolvedConflictGroups: string[];
  warningCodes: string[];
  readiness: { canSubmit: boolean; reasons: string[] };
}

const words = (value: string): number => value.trim().split(/\s+/u).filter(Boolean).length;

const tokenise = (value: string): Set<string> =>
  new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));

const appendEvent = (workspace: Workspace, type: string, message: string): Workspace => ({
  ...workspace,
  events: [...workspace.events, { type, message }],
});

const validateRequirementIds = (workspace: Workspace, requirementIds: readonly string[]): void => {
  const known = new Set(workspace.requirements.map((requirement) => requirement.id));
  for (const id of requirementIds) {
    if (!known.has(id)) throw new Error(`Unknown requirement ID: ${id}`);
  }
};

const validatePlan = (workspace: Workspace, plan: ResponsePlan): ResponsePlan => {
  const validated = responsePlanSchema.parse(plan);
  const ids = validated.sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) throw new Error("Plan section IDs must be unique.");
  validated.sections.forEach((section) => validateRequirementIds(workspace, section.requirementIds));
  return validated;
};

const conflictGroupId = (index: number): string => `conflict-group-${index + 1}`;

const citesEveryBlock = (claim: Claim, group: readonly string[]): boolean => {
  const cited = new Set(claim.sourceBlockIds);
  return group.every((blockId) => cited.has(blockId));
};

const conflictGroupForClaim = (workspace: Workspace, claim: Claim): number | undefined => {
  const index = workspace.conflictingEvidenceGroups.findIndex((group) => citesEveryBlock(claim, group));
  return index === -1 ? undefined : index;
};

const hasAnyConflictCitation = (workspace: Workspace, claim: Claim): boolean => {
  const cited = new Set(claim.sourceBlockIds);
  return workspace.conflictingEvidenceGroups.some((group) => group.some((blockId) => cited.has(blockId)));
};

const assessmentWarning = (): Warning => ({
  code: "INSUFFICIENT_EVIDENCE",
  message: "Evidence assessment found insufficient evidence.",
});

const draftForAssessment = (workspace: Workspace) => workspace.draft ?? { id: `draft-${workspace.id}`, sections: [] };

/** Reviews persisted workspace state without modifying the workspace or its audit history. */
export function reviewWorkspaceState(workspace: Workspace): WorkspaceReview {
  const blocksById = new Map(workspace.sourceBlocks.map((block) => [block.id, block]));
  const documentsById = new Map(workspace.sourceDocuments.map((document) => [document.id, document]));
  const missingRequirementIds = missingRequirements(workspace.requirements, draftForAssessment(workspace))
    .map((entry) => entry.requirementId);
  const citationIssues: WorkspaceReview["citationIssues"] = (workspace.draft?.sections ?? []).flatMap((section) => section.citations.flatMap((citation): WorkspaceReview["citationIssues"] => {
    const block = blocksById.get(citation.sourceBlockId);
    if (!block) return [{ sectionId: section.id, sourceBlockId: citation.sourceBlockId, code: "UNKNOWN_SOURCE_BLOCK" as const }];
    return documentsById.get(block.documentId)?.role === "bidder_fact"
      ? []
      : [{ sectionId: section.id, sourceBlockId: citation.sourceBlockId, code: "NON_BIDDER_FACT_CITATION" as const }];
  }));
  const unresolvedConflictGroups = workspace.conflictingEvidenceGroups
    .map((group, index) => ({ group, id: conflictGroupId(index) }))
    .filter(({ group }) => !workspace.claims.some((claim) => claim.status === "conflicting" && citesEveryBlock(claim, group)))
    .map(({ id }) => id);
  const claimIssues: WorkspaceReview["claimIssues"] = workspace.claims.flatMap((claim): WorkspaceReview["claimIssues"] => {
    if (claim.status !== "supported") return [{ claimId: claim.id, code: "UNSUPPORTED_CLAIM" as const }];
    return hasAnyConflictCitation(workspace, claim)
      ? [{ claimId: claim.id, code: "UNRESOLVED_CONFLICT" as const }]
      : [];
  });
  const citedContentExists = (workspace.draft?.sections ?? []).some((section) => section.citations.length > 0);
  const draftWordCount = words((workspace.draft?.sections ?? []).map((section) => section.content).join(" "));
  const reasons = [
    ...(workspace.draft?.sections.length ? [] : ["NO_DRAFT"]),
    ...(missingRequirementIds.length ? ["MISSING_REQUIREMENTS"] : []),
    ...(citationIssues.length ? ["INVALID_CITATIONS"] : []),
    ...(citedContentExists && workspace.claims.length === 0 ? ["MISSING_CLAIM_ASSESSMENT"] : []),
    ...(workspace.claims.some((claim) => claim.status !== "supported") ? ["NON_SUPPORTED_CLAIMS"] : []),
    ...(unresolvedConflictGroups.length ? ["UNRESOLVED_CONFLICTS"] : []),
    ...(workspace.warnings.length ? ["WARNINGS_PRESENT"] : []),
    ...(workspace.maximumWords !== undefined && draftWordCount > workspace.maximumWords ? ["WORD_LIMIT_EXCEEDED"] : []),
  ];
  return {
    missingRequirementIds,
    citationIssues,
    claimIssues,
    unresolvedConflictGroups,
    warningCodes: workspace.warnings.map((warning) => warning.code),
    readiness: { canSubmit: reasons.length === 0, reasons },
  };
}

export interface EvidenceSearchResult {
  block: SourceBlock;
  score: number;
}

/** Deterministic stateful operations intended for a bounded agent tool loop. */
export class TenderToolService {
  public constructor(private readonly store: FileWorkspaceStore) {}

  public inspectWorkspace(workspaceId: string): Promise<Workspace> {
    return this.store.load(workspaceId);
  }

  public async searchEvidence(
    workspaceId: string,
    query: string,
    options?: { role?: SourceRole; limit?: number },
  ): Promise<EvidenceSearchResult[]> {
    const validatedOptions = searchOptionsSchema.parse(options);
    const workspace = await this.store.load(workspaceId);
    const queryTokens = tokenise(query);
    const documentsById = new Map(workspace.sourceDocuments.map((document) => [document.id, document]));
    const results = workspace.sourceBlocks
      .filter((block) => !validatedOptions?.role || documentsById.get(block.documentId)?.role === validatedOptions.role)
      .map((block) => ({
        block,
        score: [...tokenise(block.text)].filter((token) => queryTokens.has(token)).length,
      }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id))
      .slice(0, validatedOptions?.limit ?? 5);

    const retrievedBlockIds = [...new Set([...workspace.retrievedBlockIds, ...results.map((result) => result.block.id)])];
    await this.store.save(appendEvent({ ...workspace, retrievedBlockIds }, "evidence_searched", `Retrieved ${results.length} evidence block(s).`));
    return results;
  }

  public async readSourceBlocks(workspaceId: string, blockIds: readonly string[]): Promise<SourceBlock[]> {
    const workspace = await this.store.load(workspaceId);
    const blocksById = new Map(workspace.sourceBlocks.map((block) => [block.id, block]));
    const blocks = blockIds.map((id) => {
      const block = blocksById.get(id);
      if (!block) throw new Error(`Unknown source block ID: ${id}`);
      return block;
    });
    const retrievedBlockIds = [...new Set([...workspace.retrievedBlockIds, ...blockIds])];
    await this.store.save(appendEvent({ ...workspace, retrievedBlockIds }, "source_blocks_read", `Read ${blocks.length} source block(s).`));
    return blocks;
  }

  public async writePlan(workspaceId: string, plan: ResponsePlan): Promise<Workspace> {
    const workspace = await this.store.load(workspaceId);
    const validatedPlan = validatePlan(workspace, plan);
    const updated = appendEvent({ ...workspace, plan: validatedPlan }, "plan_written", `Saved ${validatedPlan.sections.length} plan section(s).`);
    await this.store.save(updated);
    return updated;
  }

  public async writeSection(workspaceId: string, section: DraftSection): Promise<Workspace> {
    const workspace = await this.store.load(workspaceId);
    const validatedSection = draftSectionSchema.parse(section);
    if (!workspace.plan) throw new Error("A response plan must be written before drafting sections.");
    if (!workspace.plan.sections.some((planSection) => planSection.id === validatedSection.id)) {
      throw new Error(`Section is not in the response plan: ${validatedSection.id}`);
    }
    validateRequirementIds(workspace, validatedSection.requirementIds);
    const blocksById = new Map(workspace.sourceBlocks.map((block) => [block.id, block]));
    const documentsById = new Map(workspace.sourceDocuments.map((document) => [document.id, document]));
    for (const citation of validatedSection.citations) {
      const block = blocksById.get(citation.sourceBlockId);
      if (!block) throw new Error(`Unknown source block ID: ${citation.sourceBlockId}`);
      if (documentsById.get(block.documentId)?.role !== "bidder_fact") {
        throw new Error(`Citation source block must be bidder_fact evidence: ${citation.sourceBlockId}`);
      }
    }
    const currentSections = workspace.draft?.sections ?? [];
    const exists = currentSections.some((current) => current.id === validatedSection.id);
    const sections = exists
      ? currentSections.map((current) => current.id === validatedSection.id ? validatedSection : current)
      : [...currentSections, validatedSection];
    const updated = appendEvent({
      ...workspace,
      draft: { id: workspace.draft?.id ?? `draft-${workspace.id}`, sections },
    }, "section_written", `${exists ? "Updated" : "Created"} section ${validatedSection.id}.`);
    await this.store.save(updated);
    return updated;
  }

  /** Replaces the complete evidence assessment in one validated, atomic workspace write. */
  public async recordEvidenceAssessment(workspaceId: string, assessment: EvidenceAssessment): Promise<Workspace> {
    const validatedAssessment = evidenceAssessmentSchema.parse(assessment);
    const workspace = await this.store.load(workspaceId);
    validateRequirementIds(workspace, (validatedAssessment.missingEvidence ?? []).map((entry) => entry.requirementId));
    const claimIds = validatedAssessment.claims.map((claim) => claim.id);
    if (new Set(claimIds).size !== claimIds.length) throw new Error("Claim IDs must be unique.");
    const blocksById = new Set(workspace.sourceBlocks.map((block) => block.id));
    for (const claim of validatedAssessment.claims) {
      for (const sourceBlockId of claim.sourceBlockIds) {
        if (!blocksById.has(sourceBlockId)) throw new Error(`Unknown source block ID: ${sourceBlockId}`);
      }
      if (claim.status === "conflicting" && conflictGroupForClaim(workspace, claim) === undefined) {
        throw new Error(`Conflicting claim must cite every block in a known conflict group: ${claim.id}`);
      }
    }
    const claims = validatedAssessment.claims.map((claim): Claim => {
      if (claim.status === "supported") {
        const assessed = assessClaim(claim, workspace.sourceDocuments, workspace.sourceBlocks);
        if (assessed.status !== "supported") return { ...claim, status: assessed.status };
        if (hasAnyConflictCitation(workspace, claim)) {
          return { ...claim, status: conflictGroupForClaim(workspace, claim) === undefined ? "unverified" : "conflicting" };
        }
      }
      return claim;
    });
    const callerGaps = new Map<string, MissingEvidence>();
    for (const gap of validatedAssessment.missingEvidence ?? []) callerGaps.set(gap.requirementId, gap);
    const computedGaps = missingRequirements(workspace.requirements, draftForAssessment(workspace));
    const missingEvidence = new Map(computedGaps.map((gap) => [gap.requirementId, gap]));
    for (const [requirementId, gap] of callerGaps) missingEvidence.set(requirementId, gap);
    const gaps = [...missingEvidence.values()];
    const warnings = gaps.length > 0 || workspace.retrievedBlockIds.length === 0 || claims.some((claim) => claim.status !== "supported")
      ? [assessmentWarning()]
      : [];
    const updated = appendEvent({
      ...workspace,
      claims,
      missingEvidence: gaps,
      warnings,
    }, "evidence_assessment_recorded", `Recorded ${claims.length} claim(s) and ${gaps.length} evidence gap(s).`);
    await this.store.save(updated);
    return updated;
  }

  public async reviewWorkspace(workspaceId: string): Promise<WorkspaceReview> {
    return reviewWorkspaceState(await this.store.load(workspaceId));
  }
}

export { planSectionSchema };
