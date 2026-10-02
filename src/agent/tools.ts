import { z } from "zod";

import { draftSectionSchema, sourceRoleSchema, type DraftSection, type SourceBlock, type SourceRole } from "../domain/index.js";
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
    validateRequirementIds(workspace, validatedSection.requirementIds);
    const blocksById = new Set(workspace.sourceBlocks.map((block) => block.id));
    for (const citation of validatedSection.citations) {
      if (!blocksById.has(citation.sourceBlockId)) throw new Error(`Unknown source block ID: ${citation.sourceBlockId}`);
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
}

export { planSectionSchema };
