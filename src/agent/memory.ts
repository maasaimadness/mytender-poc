import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const identifierSchema = z.string().min(1);
const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, {
  message: "Expected an ISO timestamp.",
});

export const runMemoryFailureCodeSchema = z.enum([
  "agent_run_failed",
  "candidate_schema_invalid",
  "judge_schema_invalid",
  "candidate_error",
  "judge_error",
  "preflight_failed",
]);

export const runMemoryRecordSchema = z.object({
  schemaVersion: z.literal("v1"),
  id: identifierSchema,
  recordedAt: isoTimestampSchema,
  source: z.enum(["agent-run", "evaluation"]),
  runId: identifierSchema.optional(),
  workspaceId: identifierSchema.optional(),
  fixtureId: identifierSchema.optional(),
  outcome: z.enum(["completed", "blocked", "failed"]),
  failureCode: runMemoryFailureCodeSchema.optional(),
  failedChecks: z.array(identifierSchema),
  warningCodes: z.array(identifierSchema),
  missingRequirementIds: z.array(identifierSchema),
  claimStatuses: z.array(z.object({ id: identifierSchema, status: z.enum(["supported", "unverified", "conflicting", "rejected"]) }).strict()),
  retrievedBlockIds: z.array(identifierSchema),
  nextActionCode: z.enum(["none", "add_evidence", "resolve_conflict", "fix_schema", "improve_tool_use"]),
}).strict();
export type RunMemoryRecord = z.infer<typeof runMemoryRecordSchema>;

export interface RunMemoryStore {
  record(record: RunMemoryRecord): Promise<void>;
}

/** Appends strictly validated, redacted run summaries as one JSON object per line. */
export class JsonlRunMemoryStore implements RunMemoryStore {
  public constructor(private readonly filePath: string) {}

  async record(record: RunMemoryRecord): Promise<void> {
    const parsed = runMemoryRecordSchema.parse(record);
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export interface EvaluationRunMemoryInput {
  status: "failed" | "judged" | "skipped";
  failureCode?: z.infer<typeof runMemoryFailureCodeSchema> | undefined;
  preflight: Array<{ name: string; passed: boolean }>;
}

/** Converts only deterministic evaluation metadata; never copies check details or judge prose. */
export function evaluationRunMemoryRecord(fixtureId: string, run: EvaluationRunMemoryInput, id: string, recordedAt: string): RunMemoryRecord | undefined {
  if (run.status === "judged") return undefined;
  const failedChecks = run.preflight.filter((check) => !check.passed).map((check) => check.name);
  return runMemoryRecordSchema.parse({
    schemaVersion: "v1",
    id,
    recordedAt,
    source: "evaluation",
    fixtureId,
    outcome: "failed",
    ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
    failedChecks,
    warningCodes: [],
    missingRequirementIds: [],
    claimStatuses: [],
    retrievedBlockIds: [],
    nextActionCode: evaluationNextActionCode(run.failureCode, failedChecks),
  });
}

function evaluationNextActionCode(
  failureCode: EvaluationRunMemoryInput["failureCode"],
  failedChecks: readonly string[],
): RunMemoryRecord["nextActionCode"] {
  if (failureCode === "candidate_schema_invalid" || failureCode === "judge_schema_invalid") return "fix_schema";
  if (failedChecks.includes("conflicting_evidence_is_flagged")) return "resolve_conflict";
  if (failedChecks.some((name) => name.includes("citation") || name.includes("supported_claims") || name.includes("retrieved_blocks"))) return "add_evidence";
  if (failedChecks.some((name) => name.includes("requirement") || name.includes("missing") || name.includes("warning"))) return "add_evidence";
  return "improve_tool_use";
}
