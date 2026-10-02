import { z } from "zod";

import {
  claimSchema,
  draftSchema,
  requirementSchema,
  sourceDocumentSchema,
  sourceBlockSchema,
  warningSchema,
} from "../domain/index.js";

export { claimSchema, draftSchema, requirementSchema, sourceDocumentSchema, sourceBlockSchema, warningSchema };

function addDuplicateIssues(values: readonly string[], context: z.RefinementCtx, path: (string | number)[], label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  for (const duplicate of duplicates) {
    context.addIssue({ code: "custom", path, message: `${label} must be unique: ${duplicate}` });
  }
}

export const missingEvidenceSchema = z.object({
  requirementId: z.string().min(1),
  reason: z.string().min(1),
});

export const evaluationInputSchema = z.object({
  fixtureId: z.string().min(1),
  question: z.string().min(1),
  requirements: z.array(requirementSchema).min(1),
  sourceDocuments: z.array(sourceDocumentSchema).min(1),
  evidenceBlocks: z.array(sourceBlockSchema),
  maximumWords: z.number().int().positive().optional(),
}).superRefine((input, context) => {
  addDuplicateIssues(input.requirements.map((requirement) => requirement.id), context, ["requirements"], "Requirement IDs");
  addDuplicateIssues(input.sourceDocuments.map((document) => document.id), context, ["sourceDocuments"], "Source document IDs");
  addDuplicateIssues(input.evidenceBlocks.map((block) => block.id), context, ["evidenceBlocks"], "Evidence block IDs");
  const documentIds = new Set(input.sourceDocuments.map((document) => document.id));
  for (const [index, block] of input.evidenceBlocks.entries()) {
    if (!documentIds.has(block.documentId)) {
      context.addIssue({ code: "custom", path: ["evidenceBlocks", index, "documentId"], message: `Unknown source document: ${block.documentId}` });
    }
  }
});
export type EvaluationInput = z.infer<typeof evaluationInputSchema>;

export const candidateOutputSchema = z.object({
  draft: draftSchema,
  warnings: z.array(warningSchema),
  missingEvidence: z.array(missingEvidenceSchema),
  retrievedBlockIds: z.array(z.string().min(1)),
  claims: z.array(claimSchema),
});
export type CandidateOutput = z.infer<typeof candidateOutputSchema>;

export const semanticScoreSchema = z.object({
  criterion: z.enum([
    "requirement_coverage",
    "groundedness",
    "evidence_relevance",
    "buyer_tailoring",
    "scoreability",
    "writing_quality",
  ]),
  score: z.number().int().min(1).max(5),
  reason: z.string().min(1).max(500),
});
export type SemanticScore = z.infer<typeof semanticScoreSchema>;

export const semanticJudgeOutputSchema = z.object({
  scores: z.array(semanticScoreSchema).min(1),
}).superRefine((output, context) => {
  addDuplicateIssues(output.scores.map((score) => score.criterion), context, ["scores"], "Judge score criteria");
});
export type SemanticJudgeOutput = z.infer<typeof semanticJudgeOutputSchema>;

export const semanticRubricSchema = z.object({
  criteria: z.array(semanticScoreSchema.shape.criterion).min(1),
}).superRefine((rubric, context) => {
  addDuplicateIssues(rubric.criteria, context, ["criteria"], "Rubric criteria");
});

export const evaluationFixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^v\d+$/),
  title: z.string().min(1),
  scenario: z.enum(["clean_generation", "partial_draft", "conflict_safe_failure"]),
  input: evaluationInputSchema,
  allowedEvidenceBlockIds: z.array(z.string().min(1)),
  conflictingEvidenceGroups: z.array(z.array(z.string().min(1)).min(2)).default([]),
  forbiddenClaims: z.array(z.string().min(1)),
  expectedWarningCodes: z.array(warningSchema.shape.code),
  expectedMissingRequirementIds: z.array(z.string().min(1)),
  semanticRubric: semanticRubricSchema,
}).superRefine((fixture, context) => {
  if (fixture.input.fixtureId !== fixture.id) {
    context.addIssue({ code: "custom", path: ["input", "fixtureId"], message: "fixtureId must match fixture id." });
  }
  const blockIds = new Set(fixture.input.evidenceBlocks.map((block) => block.id));
  for (const id of fixture.allowedEvidenceBlockIds) {
    if (!blockIds.has(id)) context.addIssue({ code: "custom", path: ["allowedEvidenceBlockIds"], message: `Unknown evidence block: ${id}` });
  }
  for (const [index, group] of fixture.conflictingEvidenceGroups.entries()) {
    addDuplicateIssues(group, context, ["conflictingEvidenceGroups", index], "Conflicting evidence block IDs");
    for (const id of group) {
      if (!blockIds.has(id)) context.addIssue({ code: "custom", path: ["conflictingEvidenceGroups", index], message: `Unknown evidence block: ${id}` });
    }
  }
  addDuplicateIssues(fixture.allowedEvidenceBlockIds, context, ["allowedEvidenceBlockIds"], "Allowed evidence block IDs");
  addDuplicateIssues(fixture.expectedWarningCodes, context, ["expectedWarningCodes"], "Expected warning codes");
  addDuplicateIssues(fixture.expectedMissingRequirementIds, context, ["expectedMissingRequirementIds"], "Expected missing requirement IDs");
  const requirementIds = new Set(fixture.input.requirements.map((requirement) => requirement.id));
  for (const id of fixture.expectedMissingRequirementIds) {
    if (!requirementIds.has(id)) context.addIssue({ code: "custom", path: ["expectedMissingRequirementIds"], message: `Unknown requirement: ${id}` });
  }
});
export type EvaluationFixture = z.infer<typeof evaluationFixtureSchema>;

export const preflightCheckSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  details: z.array(z.string().min(1)),
});

export const evaluationRunSchema = z.object({
  run: z.number().int().positive(),
  status: z.enum(["failed", "judged", "skipped"]),
  failureCode: z.enum([
    "candidate_schema_invalid", "judge_schema_invalid", "candidate_error", "judge_error",
    "preflight_failed",
  ]).optional(),
  preflight: z.array(preflightCheckSchema),
  scores: z.array(semanticScoreSchema),
  latencyMs: z.number().nonnegative(),
}).superRefine((run, context) => {
  if (run.status === "judged") {
    if (run.failureCode !== undefined) {
      context.addIssue({ code: "custom", path: ["failureCode"], message: "Judged runs must not have a failureCode." });
    }
    if (run.scores.length === 0) {
      context.addIssue({ code: "custom", path: ["scores"], message: "Judged runs must include scores." });
    }
  }
  if (run.status === "failed") {
    if (run.failureCode === undefined) {
      context.addIssue({ code: "custom", path: ["failureCode"], message: "Failed runs must include a failureCode." });
    }
    if (run.failureCode === "preflight_failed") {
      context.addIssue({ code: "custom", path: ["failureCode"], message: "Preflight failures must use skipped status." });
    }
    if (run.scores.length !== 0) {
      context.addIssue({ code: "custom", path: ["scores"], message: "Failed runs must not include scores." });
    }
  }
  if (run.status === "skipped") {
    if (run.failureCode !== "preflight_failed") {
      context.addIssue({ code: "custom", path: ["failureCode"], message: "Skipped runs must be preflight_failed." });
    }
    if (run.scores.length !== 0) {
      context.addIssue({ code: "custom", path: ["scores"], message: "Skipped runs must not include scores." });
    }
  }
});
export type EvaluationRun = z.infer<typeof evaluationRunSchema>;

export const evaluationAggregateSchema = z.object({
  totalRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  judgedRuns: z.number().int().nonnegative(),
  skippedRuns: z.number().int().nonnegative(),
  semanticMean: z.number().nullable(),
  semanticWorst: z.number().nullable(),
});

export const evaluationReportSchema = z.object({
  schemaVersion: z.literal("v1"),
  fixtureId: z.string().min(1),
  fixtureVersion: z.string().min(1),
  candidateId: z.string().min(1),
  judgeId: z.string().min(1),
  runs: z.array(evaluationRunSchema),
  aggregate: evaluationAggregateSchema,
}).superRefine((report, context) => {
  const scores = report.runs.filter((run) => run.status === "judged").flatMap((run) => run.scores.map((score) => score.score));
  const expected = {
    totalRuns: report.runs.length,
    failedRuns: report.runs.filter((run) => run.status === "failed").length,
    judgedRuns: report.runs.filter((run) => run.status === "judged").length,
    skippedRuns: report.runs.filter((run) => run.status === "skipped").length,
    semanticMean: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    semanticWorst: scores.length ? Math.min(...scores) : null,
  };
  for (const [key, value] of Object.entries(expected) as Array<[keyof typeof expected, number | null]>) {
    if (report.aggregate[key] !== value) {
      context.addIssue({ code: "custom", path: ["aggregate", key], message: `Aggregate ${key} must match runs.` });
    }
  }
});
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;

export function semanticScoreCoverageErrors(
  scores: readonly SemanticScore[],
  criteria: readonly SemanticScore["criterion"][],
): string[] {
  const requested = new Set(criteria);
  const seen = new Set<SemanticScore["criterion"]>();
  const duplicates = new Set<SemanticScore["criterion"]>();
  const extras = new Set<SemanticScore["criterion"]>();
  for (const score of scores) {
    if (!requested.has(score.criterion)) extras.add(score.criterion);
    if (seen.has(score.criterion)) duplicates.add(score.criterion);
    seen.add(score.criterion);
  }
  const missing = criteria.filter((criterion) => !seen.has(criterion));
  return [
    ...missing.map((criterion) => `missing:${criterion}`),
    ...[...extras].map((criterion) => `extra:${criterion}`),
    ...[...duplicates].map((criterion) => `duplicate:${criterion}`),
  ];
}
