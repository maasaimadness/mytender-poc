import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  claimSchema,
  draftSchema,
  requirementSchema,
  sourceBlockSchema,
  sourceDocumentSchema,
  warningSchema,
} from "../domain/index.js";

export const workspaceIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
  message: "Workspace IDs may contain only lowercase letters, digits, and single hyphens.",
});

export const workspaceEventSchema = z.object({
  type: z.string().min(1),
  message: z.string().min(1),
});
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

export const planSectionSchema = z.object({
  id: z.string().min(1),
  heading: z.string().min(1),
  requirementIds: z.array(z.string().min(1)),
});
export type PlanSection = z.infer<typeof planSectionSchema>;

export const responsePlanSchema = z.object({
  sections: z.array(planSectionSchema),
});
export type ResponsePlan = z.infer<typeof responsePlanSchema>;

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  question: z.string().min(1),
  maximumWords: z.number().int().positive().optional(),
  sourceDocuments: z.array(sourceDocumentSchema),
  sourceBlocks: z.array(sourceBlockSchema),
  requirements: z.array(requirementSchema),
  plan: responsePlanSchema.optional(),
  draft: draftSchema.optional(),
  warnings: z.array(warningSchema),
  missingEvidence: z.array(z.object({
    requirementId: z.string().min(1),
    reason: z.string().min(1),
  })),
  claims: z.array(claimSchema),
  retrievedBlockIds: z.array(z.string().min(1)),
  events: z.array(workspaceEventSchema),
  conflictingEvidenceGroups: z.array(z.array(z.string().min(1)).min(2)),
}).superRefine((workspace, context) => {
  const duplicate = (values: readonly string[]) => values.find((value, index) => values.indexOf(value) !== index);
  const documentIds = new Set(workspace.sourceDocuments.map((document) => document.id));
  const blockIds = new Set(workspace.sourceBlocks.map((block) => block.id));
  const requirementIds = new Set(workspace.requirements.map((requirement) => requirement.id));

  for (const [path, values] of [
    ["sourceDocuments", workspace.sourceDocuments.map((document) => document.id)],
    ["sourceBlocks", workspace.sourceBlocks.map((block) => block.id)],
    ["requirements", workspace.requirements.map((requirement) => requirement.id)],
  ] as const) {
    const duplicateId = duplicate(values);
    if (duplicateId) context.addIssue({ code: "custom", path: [...path], message: `Duplicate ID: ${duplicateId}` });
  }

  workspace.sourceBlocks.forEach((block, index) => {
    if (!documentIds.has(block.documentId)) {
      context.addIssue({ code: "custom", path: ["sourceBlocks", index, "documentId"], message: "Unknown source document." });
    }
  });
  workspace.retrievedBlockIds.forEach((id, index) => {
    if (!blockIds.has(id)) context.addIssue({ code: "custom", path: ["retrievedBlockIds", index], message: "Unknown source block." });
  });
  workspace.plan?.sections.forEach((section, index) => {
    if (duplicate(workspace.plan!.sections.map((item) => item.id)) && index === 0) {
      context.addIssue({ code: "custom", path: ["plan", "sections"], message: "Plan section IDs must be unique." });
    }
    section.requirementIds.forEach((id, requirementIndex) => {
      if (!requirementIds.has(id)) context.addIssue({ code: "custom", path: ["plan", "sections", index, "requirementIds", requirementIndex], message: "Unknown requirement." });
    });
  });
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** Filesystem-backed workspace state with validated IDs and atomic replacement writes. */
export class FileWorkspaceStore {
  public constructor(private readonly root: string) {}

  public async load(id: string): Promise<Workspace> {
    const workspaceId = workspaceIdSchema.parse(id);
    const contents = await readFile(this.workspacePath(workspaceId), "utf8");
    const workspace = workspaceSchema.parse(JSON.parse(contents));
    if (workspace.id !== workspaceId) throw new Error("Workspace file ID does not match its directory.");
    return workspace;
  }

  public async save(workspace: Workspace): Promise<void> {
    const validated = workspaceSchema.parse(workspace);
    const target = this.workspacePath(validated.id);
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.workspace-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(validated, null, 2), "utf8");
    await rename(temporary, target);
  }

  private workspacePath(id: string): string {
    return join(this.root, workspaceIdSchema.parse(id), "workspace.json");
  }
}
