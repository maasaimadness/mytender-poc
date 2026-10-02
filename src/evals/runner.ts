import type { CandidateAdapter, JudgeInput, SemanticJudgeAdapter } from "./adapters.js";
import { preflight } from "./preflight.js";
import {
  candidateOutputSchema,
  evaluationReportSchema,
  semanticScoreCoverageErrors,
  semanticJudgeOutputSchema,
  type CandidateOutput,
  type EvaluationFixture,
  type EvaluationReport,
  type EvaluationRun,
} from "./schemas.js";

export interface RunnerOptions { repeats?: number; }

const failure = (run: number, failureCode: Exclude<EvaluationRun["failureCode"], "preflight_failed" | undefined>, latencyMs: number, preflightChecks: EvaluationRun["preflight"] = []): EvaluationRun => ({ run, status: "failed", failureCode, preflight: preflightChecks, scores: [], latencyMs });

function judgeInput(fixture: EvaluationFixture, output: CandidateOutput): JudgeInput {
  return {
    fixtureId: fixture.id, question: fixture.input.question, requirements: fixture.input.requirements,
    evidenceBlocks: fixture.input.evidenceBlocks, draft: output.draft, warnings: output.warnings,
    missingEvidence: output.missingEvidence, rubric: fixture.semanticRubric.criteria,
  };
}

export function aggregate(runs: readonly EvaluationRun[]) {
  const judgedScores = runs.filter((run) => run.status === "judged").flatMap((run) => run.scores.map((score) => score.score));
  return {
    totalRuns: runs.length,
    failedRuns: runs.filter((run) => run.status === "failed").length,
    judgedRuns: runs.filter((run) => run.status === "judged").length,
    skippedRuns: runs.filter((run) => run.status === "skipped").length,
    semanticMean: judgedScores.length ? judgedScores.reduce((sum, score) => sum + score, 0) / judgedScores.length : null,
    semanticWorst: judgedScores.length ? Math.min(...judgedScores) : null,
  };
}

export function reportPasses(report: EvaluationReport): boolean {
  return report.aggregate.totalRuns > 0
    && report.aggregate.judgedRuns === report.aggregate.totalRuns
    && report.aggregate.failedRuns === 0
    && report.aggregate.skippedRuns === 0;
}

export async function runEvaluation(fixture: EvaluationFixture, candidate: CandidateAdapter, judge: SemanticJudgeAdapter, options: RunnerOptions = {}): Promise<EvaluationReport> {
  const repeats = options.repeats ?? 3;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer.");
  const runs: EvaluationRun[] = [];
  for (let run = 1; run <= repeats; run += 1) {
    const started = performance.now();
    let rawCandidate: unknown;
    try { rawCandidate = await candidate.generate(fixture.input); } catch { runs.push(failure(run, "candidate_error", performance.now() - started)); continue; }
    const candidateParsed = candidateOutputSchema.safeParse(rawCandidate);
    if (!candidateParsed.success) { runs.push(failure(run, "candidate_schema_invalid", performance.now() - started)); continue; }
    const checks = preflight(fixture, candidateParsed.data);
    if (checks.some((check) => !check.passed)) {
      runs.push({ run, status: "skipped", failureCode: "preflight_failed", preflight: checks, scores: [], latencyMs: performance.now() - started });
      continue;
    }
    let rawJudge: unknown;
    try { rawJudge = await judge.judge(judgeInput(fixture, candidateParsed.data)); } catch { runs.push(failure(run, "judge_error", performance.now() - started, checks)); continue; }
    const judgeParsed = semanticJudgeOutputSchema.safeParse(rawJudge);
    if (!judgeParsed.success) { runs.push(failure(run, "judge_schema_invalid", performance.now() - started, checks)); continue; }
    if (semanticScoreCoverageErrors(judgeParsed.data.scores, fixture.semanticRubric.criteria).length > 0) {
      runs.push(failure(run, "judge_schema_invalid", performance.now() - started, checks));
      continue;
    }
    runs.push({ run, status: "judged", preflight: checks, scores: judgeParsed.data.scores, latencyMs: performance.now() - started });
  }
  return evaluationReportSchema.parse({ schemaVersion: "v1", fixtureId: fixture.id, fixtureVersion: fixture.version, candidateId: candidate.id, judgeId: judge.id, runs, aggregate: aggregate(runs) });
}
