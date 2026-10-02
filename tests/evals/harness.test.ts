import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { CandidateAdapter, JudgeInput, SemanticJudgeAdapter } from "../../src/evals/adapters.js";
import { OfflineFixtureCandidateAdapter, OfflineSemanticJudgeAdapter } from "../../src/evals/adapters.js";
import { loadFixtures } from "../../src/evals/fixtures.js";
import { preflight } from "../../src/evals/preflight.js";
import { writeReport } from "../../src/evals/report.js";
import { aggregate, reportPasses, runEvaluation } from "../../src/evals/runner.js";
import {
  candidateOutputSchema,
  evaluationReportSchema,
  evaluationRunSchema,
  semanticRubricSchema,
  type CandidateOutput,
  type EvaluationFixture,
} from "../../src/evals/schemas.js";

const candidate: CandidateAdapter = new OfflineFixtureCandidateAdapter();
const judge: SemanticJudgeAdapter = new OfflineSemanticJudgeAdapter();

async function fixture(id: string): Promise<EvaluationFixture> {
  const found = (await loadFixtures()).find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing fixture ${id}`);
  return found;
}

async function candidateOutput(input: EvaluationFixture): Promise<CandidateOutput> {
  return candidateOutputSchema.parse(await candidate.generate(input.input));
}

function failedCheckNames(fixture: EvaluationFixture, output: CandidateOutput): string[] {
  return preflight(fixture, output).filter((check) => !check.passed).map((check) => check.name);
}

function cloneFixture(input: EvaluationFixture): EvaluationFixture {
  return JSON.parse(JSON.stringify(input)) as EvaluationFixture;
}

describe("evaluation harness", () => {
  it("loads all three sanitized versioned fixtures", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.map((entry) => entry.id)).toEqual(["customer-outcomes", "security-conflict", "three-case-studies-gap"]);
    for (const entry of fixtures) {
      expect(entry.input.sourceDocuments.length).toBeGreaterThan(0);
      const text = await readFile(resolve("src/evals/fixtures", `${entry.id}.${entry.version}.json`), "utf8");
      expect(text).not.toMatch(/reference\/|\/Users\/|\.docx|\.pdf/i);
    }
  });

  it("isolates candidate and judge inputs from fixture oracles", async () => {
    const input = await fixture("three-case-studies-gap");
    let candidateInput: unknown;
    let capturedJudgeInput: JudgeInput | undefined;
    const wrappedCandidate: CandidateAdapter = { id: "candidate", async generate(value) { candidateInput = value; return candidate.generate(value); } };
    const wrappedJudge: SemanticJudgeAdapter = { id: "judge", async judge(value) { capturedJudgeInput = value; return judge.judge(value); } };
    await runEvaluation(input, wrappedCandidate, wrappedJudge, { repeats: 1 });
    expect(candidateInput).not.toHaveProperty("allowedEvidenceBlockIds");
    expect(candidateInput).not.toHaveProperty("forbiddenClaims");
    expect(candidateInput).not.toHaveProperty("expectedWarningCodes");
    expect(candidateInput).not.toHaveProperty("semanticRubric");
    expect(capturedJudgeInput).not.toHaveProperty("expectedWarningCodes");
    expect(capturedJudgeInput).not.toHaveProperty("forbiddenClaims");
  });

  it("fails invalid candidate and judge outputs at their schemas", async () => {
    const input = await fixture("customer-outcomes");
    const invalidCandidate: CandidateAdapter = { id: "bad-candidate", async generate() { return {}; } };
    const invalidJudge: SemanticJudgeAdapter = { id: "bad-judge", async judge() { return {}; } };
    expect((await runEvaluation(input, invalidCandidate, judge, { repeats: 1 })).runs[0]?.failureCode).toBe("candidate_schema_invalid");
    expect((await runEvaluation(input, candidate, invalidJudge, { repeats: 1 })).runs[0]?.failureCode).toBe("judge_schema_invalid");
  });

  it("hard-fails preflight before invoking the judge", async () => {
    const input = await fixture("customer-outcomes");
    let judgeCalls = 0;
    const unsafeCandidate: CandidateAdapter = {
      id: "unsafe",
      async generate() {
        return {
          draft: { id: "unsafe", sections: [{ id: "s", heading: "Outcome", content: "guaranteed savings", requirementIds: ["outcomes"], citations: [{ sourceBlockId: "outcome-a" }] }] },
          warnings: [],
          missingEvidence: [],
          retrievedBlockIds: ["outcome-a"],
          claims: [{ id: "unsafe-claim", text: "guaranteed savings", sourceBlockIds: ["outcome-a"], status: "supported" }],
        };
      },
    };
    const countingJudge: SemanticJudgeAdapter = { id: "counting", async judge() { judgeCalls += 1; return { scores: [] }; } };
    const report = await runEvaluation(input, unsafeCandidate, countingJudge, { repeats: 1 });
    expect(report.runs[0]?.status).toBe("skipped");
    expect(report.runs[0]?.failureCode).toBe("preflight_failed");
    expect(judgeCalls).toBe(0);
  });

  it("requires exact one-to-one judge coverage of requested rubric criteria", async () => {
    const input = cloneFixture(await fixture("customer-outcomes"));
    input.semanticRubric.criteria = ["groundedness"];
    const extraJudge: SemanticJudgeAdapter = {
      id: "extra",
      async judge() {
        return {
          scores: [
            { criterion: "groundedness", score: 4, reason: "ok" },
            { criterion: "writing_quality", score: 4, reason: "extra" },
          ],
        };
      },
    };
    const missingJudge: SemanticJudgeAdapter = {
      id: "missing",
      async judge() {
        return { scores: [{ criterion: "writing_quality", score: 4, reason: "wrong" }] };
      },
    };
    expect((await runEvaluation(input, candidate, extraJudge, { repeats: 1 })).runs[0]?.failureCode).toBe("judge_schema_invalid");
    expect((await runEvaluation(input, candidate, missingJudge, { repeats: 1 })).runs[0]?.failureCode).toBe("judge_schema_invalid");
    expect(() => semanticRubricSchema.parse({ criteria: ["groundedness", "groundedness"] })).toThrow();
  });

  it("preflights deterministic citation, requirement, retrieval, claim, and word-count rules", async () => {
    const cleanFixture = await fixture("customer-outcomes");
    const cleanOutput = await candidateOutput(cleanFixture);
    expect(failedCheckNames(cleanFixture, cleanOutput)).toEqual([]);

    const roleFixture = cloneFixture(cleanFixture);
    roleFixture.input.sourceDocuments.push({ id: "buyer", role: "buyer_requirement", title: "Sanitized buyer requirement" });
    roleFixture.input.evidenceBlocks.push({ id: "buyer-block", documentId: "buyer", locator: "derived:buyer", text: "Buyer asks for guaranteed savings." });
    roleFixture.allowedEvidenceBlockIds.push("buyer-block");
    const buyerCited: CandidateOutput = {
      ...cleanOutput,
      draft: {
        ...cleanOutput.draft,
        sections: [{ ...cleanOutput.draft.sections[0]!, citations: [{ sourceBlockId: "buyer-block" }] }],
      },
      retrievedBlockIds: ["buyer-block"],
      claims: [{ id: "buyer-claim", text: "Guaranteed savings are available.", sourceBlockIds: ["buyer-block"], status: "supported" }],
    };
    expect(failedCheckNames(roleFixture, buyerCited)).toEqual(expect.arrayContaining([
      "citations_use_bidder_fact_sources",
      "supported_claims_are_supported",
    ]));

    const duplicateCitation: CandidateOutput = {
      ...cleanOutput,
      draft: {
        ...cleanOutput.draft,
        sections: [{ ...cleanOutput.draft.sections[0]!, citations: [{ sourceBlockId: "outcome-a" }, { sourceBlockId: "outcome-a" }] }],
      },
    };
    expect(failedCheckNames(cleanFixture, duplicateCitation)).toContain("citations_not_duplicated");

    const unknownRequirement: CandidateOutput = {
      ...cleanOutput,
      draft: {
        ...cleanOutput.draft,
        sections: [{ ...cleanOutput.draft.sections[0]!, requirementIds: ["unknown"] }],
      },
    };
    expect(failedCheckNames(cleanFixture, unknownRequirement)).toEqual(expect.arrayContaining([
      "requirement_ids_known",
      "missing_requirements_match_draft",
    ]));

    const gapFixture = await fixture("three-case-studies-gap");
    const gapOutput = await candidateOutput(gapFixture);
    expect(failedCheckNames(gapFixture, { ...gapOutput, missingEvidence: [] })).toEqual(expect.arrayContaining([
      "missing_requirements_match_draft",
      "expected_missing_requirements_visible",
    ]));

    expect(failedCheckNames(cleanFixture, { ...cleanOutput, retrievedBlockIds: ["missing-block"] })).toContain("retrieved_blocks_known");
    expect(failedCheckNames(cleanFixture, { ...cleanOutput, retrievedBlockIds: [], warnings: [] })).toContain("empty_retrieval_warns");

    const wordLimitFixture = cloneFixture(cleanFixture);
    wordLimitFixture.input.maximumWords = 1;
    expect(failedCheckNames(wordLimitFixture, cleanOutput)).toContain("word_count_within_limit");
    const conflictFixture = await fixture("security-conflict");
    const conflictOutput = await candidateOutput(conflictFixture);
    expect(failedCheckNames(conflictFixture, { ...conflictOutput, claims: [] })).toContain("conflicting_evidence_is_flagged");
    expect(failedCheckNames(conflictFixture, { ...conflictOutput, claims: [{ id: "iso", text: "The service is ISO 27001 certified.", sourceBlockIds: ["iso-positive"], status: "supported" }] })).toEqual(expect.arrayContaining([
      "supported_claims_are_supported",
      "conflicting_evidence_is_flagged",
    ]));
  });

  it("rejects incoherent run states and report aggregates", async () => {
    expect(() => evaluationRunSchema.parse({ run: 1, status: "judged", failureCode: "judge_error", preflight: [], scores: [{ criterion: "groundedness", score: 5, reason: "ok" }], latencyMs: 1 })).toThrow();
    expect(() => evaluationRunSchema.parse({ run: 1, status: "failed", preflight: [], scores: [{ criterion: "groundedness", score: 5, reason: "ok" }], latencyMs: 1 })).toThrow();
    expect(() => evaluationRunSchema.parse({ run: 1, status: "skipped", failureCode: "judge_error", preflight: [], scores: [], latencyMs: 1 })).toThrow();

    const report = await runEvaluation(await fixture("customer-outcomes"), candidate, judge, { repeats: 1 });
    expect(() => evaluationReportSchema.parse({ ...report, aggregate: { ...report.aggregate, semanticMean: 1 } })).toThrow();
    expect(() => evaluationReportSchema.parse({ ...report, aggregate: { ...report.aggregate, semanticWorst: 1 } })).toThrow();
    expect(() => evaluationReportSchema.parse({ ...report, aggregate: { ...report.aggregate, judgedRuns: 0 } })).toThrow();
  });

  it("aggregates mean and worst only across judged scores", () => {
    const runs = [
      evaluationRunSchema.parse({ run: 1, status: "judged", preflight: [], scores: [{ criterion: "groundedness", score: 5, reason: "ok" }], latencyMs: 1 }),
      evaluationRunSchema.parse({ run: 2, status: "judged", preflight: [], scores: [{ criterion: "groundedness", score: 3, reason: "ok" }], latencyMs: 1 }),
      evaluationRunSchema.parse({ run: 3, status: "skipped", failureCode: "preflight_failed", preflight: [], scores: [], latencyMs: 1 }),
    ];
    expect(aggregate(runs)).toMatchObject({ totalRuns: 3, judgedRuns: 2, skippedRuns: 1, failedRuns: 0, semanticMean: 4, semanticWorst: 3 });
    const passingReport = evaluationReportSchema.parse({
      schemaVersion: "v1",
      fixtureId: "fixture",
      fixtureVersion: "v1",
      candidateId: "candidate",
      judgeId: "judge",
      runs: [runs[0]],
      aggregate: aggregate([runs[0]!]),
    });
    const skippedReport = evaluationReportSchema.parse({
      ...passingReport,
      runs,
      aggregate: aggregate(runs),
    });
    expect(reportPasses(passingReport)).toBe(true);
    expect(reportPasses(skippedReport)).toBe(false);
  });

  it("writes only schema-validated report fields", async () => {
    const report = await runEvaluation(await fixture("security-conflict"), candidate, judge, { repeats: 1 });
    const root = await mkdtemp(join(tmpdir(), "mytender-report-"));
    try {
      const path = join(root, "harness-test-report.json");
      await writeReport(path, report);
      await writeReport(path, { ...report, rawResponse: "discarded", evidenceBlocks: [] } as never);
      expect(await readFile(path, "utf8")).not.toMatch(/rawResponse|evidenceBlocks/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

  });
});
