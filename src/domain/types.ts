import { z } from "zod";

export const sourceRoleSchema = z.enum([
  "exercise_contract",
  "buyer_requirement",
  "bidder_fact",
  "bidder_positioning",
  "quality_reference",
]);
export type SourceRole = z.infer<typeof sourceRoleSchema>;

export const sourceDocumentSchema = z.object({
  id: z.string().min(1),
  role: sourceRoleSchema,
  title: z.string().min(1),
});
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const sourceBlockSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  locator: z.string().min(1),
  text: z.string().min(1),
});
export type SourceBlock = z.infer<typeof sourceBlockSchema>;

export const claimStatusSchema = z.enum([
  "supported",
  "unverified",
  "conflicting",
  "rejected",
]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const claimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  sourceBlockIds: z.array(z.string().min(1)),
  status: claimStatusSchema,
});
export type Claim = z.infer<typeof claimSchema>;

export const questionSourceVariantSchema = z.object({
  sourceDocumentId: z.string().min(1),
  sourceOrder: z.number().int().nonnegative(),
  sourceValue: z.string().min(1),
  weight: z.number().nonnegative().optional(),
  wordLimit: z.number().int().positive().optional(),
});
export type QuestionSourceVariant = z.infer<typeof questionSourceVariantSchema>;

export const requirementSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  mandatory: z.boolean(),
});
export type Requirement = z.infer<typeof requirementSchema>;

export const citationSchema = z.object({
  sourceBlockId: z.string().min(1),
});
export type Citation = z.infer<typeof citationSchema>;

export const draftSectionSchema = z.object({
  id: z.string().min(1),
  heading: z.string().min(1),
  content: z.string(),
  requirementIds: z.array(z.string().min(1)),
  citations: z.array(citationSchema),
});
export type DraftSection = z.infer<typeof draftSectionSchema>;

export const draftSchema = z.object({
  id: z.string().min(1),
  sections: z.array(draftSectionSchema),
});
export type Draft = z.infer<typeof draftSchema>;

export const warningSchema = z.object({
  code: z.enum(["INSUFFICIENT_EVIDENCE"]),
  message: z.string().min(1),
});
export type Warning = z.infer<typeof warningSchema>;

export interface MissingEvidence {
  requirementId: string;
  reason: string;
}
