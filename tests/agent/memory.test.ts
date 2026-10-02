import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlRunMemoryStore, evaluationRunMemoryRecord } from "../../src/agent/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("run memory", () => {
  it("writes one strict, private JSONL record without sensitive fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "mytender-memory-"));
    roots.push(root);
    const path = join(root, "nested", "memory.jsonl");
    const store = new JsonlRunMemoryStore(path);
    await store.record({
      schemaVersion: "v1", id: "run-1", recordedAt: "2026-01-01T00:00:00.000Z", source: "agent-run", runId: "run-1", workspaceId: "workspace-1", outcome: "blocked",
      failedChecks: ["MISSING_REQUIREMENTS"], warningCodes: ["INSUFFICIENT_EVIDENCE"], missingRequirementIds: ["requirement-1"],
      claimStatuses: [{ id: "claim-1", status: "unverified" }], retrievedBlockIds: ["block-1"], nextActionCode: "add_evidence",
    });
    await expect(store.record({ schemaVersion: "v1", id: "bad", recordedAt: "2026-01-01T00:00:00.000Z", source: "agent-run", outcome: "failed", failedChecks: [], warningCodes: [], missingRequirementIds: [], claimStatuses: [], retrievedBlockIds: [], nextActionCode: "improve_tool_use", prompt: "PROMPT_SENTINEL" } as never)).rejects.toThrow();
    const serialized = await readFile(path, "utf8");
    expect(serialized.trim().split("\n").map((line) => JSON.parse(line))).toHaveLength(1);
    for (const secret of ["PROMPT_SENTINEL", "EVIDENCE_SENTINEL", "DRAFT_SENTINEL", "ERROR_SENTINEL"]) expect(serialized).not.toContain(secret);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("creates redacted evaluation failure records from names only", () => {
    const record = evaluationRunMemoryRecord("fixture-1", {
      status: "skipped", failureCode: "preflight_failed",
      preflight: [{ name: "conflicting_evidence_is_flagged", passed: false }, { name: "citations_allowed", passed: true }],
    }, "fixture-1-1", "2026-01-01T00:00:00.000Z");
    expect(record).toMatchObject({ source: "evaluation", outcome: "failed", failedChecks: ["conflicting_evidence_is_flagged"], nextActionCode: "resolve_conflict" });
    expect(JSON.stringify(record)).not.toContain("EVIDENCE_SENTINEL");
    expect(evaluationRunMemoryRecord("fixture-1", {
      status: "failed", failureCode: "candidate_schema_invalid", preflight: [],
    }, "fixture-1-2", "2026-01-01T00:00:00.000Z")).toMatchObject({ nextActionCode: "fix_schema" });
    expect(evaluationRunMemoryRecord("fixture-1", { status: "judged", preflight: [] }, "fixture-1-2", "2026-01-01T00:00:00.000Z")).toBeUndefined();
  });
});
