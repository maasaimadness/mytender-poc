import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createOpenRouterModel, FileAgentSkillCatalog, JsonlAgentTraceSink, JsonlRunMemoryStore, readOpenRouterConfig, evaluationRunMemoryRecord } from "../agent/index.js";
import { TenderAgentCandidateAdapter } from "./agent-adapter.js";
import { loadFixtures } from "./fixtures.js";
import { OpenRouterSemanticJudgeAdapter } from "./openrouter-judge.js";
import { writeReport } from "./report.js";
import { reportPasses, runEvaluation } from "./runner.js";

const config = readOpenRouterConfig(process.env);
const model = createOpenRouterModel(config);
const judge = new OpenRouterSemanticJudgeAdapter(model);
const repeats = process.env.EVAL_REPEATS === undefined ? undefined : Number(process.env.EVAL_REPEATS);
const outputDirectory = resolve("eval-results");

await mkdir(outputDirectory, { recursive: true });
const memoryStore = new JsonlRunMemoryStore(resolve(outputDirectory, "live-memory.jsonl"));
const candidate = new TenderAgentCandidateAdapter(
  model,
  new FileAgentSkillCatalog(resolve("skills")),
  new JsonlAgentTraceSink(resolve(outputDirectory, "live-trace.jsonl")),
  memoryStore,
);
let releasePassed = true;
for (const fixture of await loadFixtures()) {
  const report = repeats === undefined
    ? await runEvaluation(fixture, candidate, judge)
    : await runEvaluation(fixture, candidate, judge, { repeats });
  await writeReport(resolve(outputDirectory, `${fixture.id}.${fixture.version}.live.json`), report);
  for (const run of report.runs) {
    const record = evaluationRunMemoryRecord(fixture.id, run, `${fixture.id}-${run.run}`, new Date().toISOString());
    if (record !== undefined) await memoryStore.record(record);
  }
  releasePassed = reportPasses(report) && releasePassed;
  console.log(`${fixture.id}: ${report.aggregate.judgedRuns} judged, ${report.aggregate.skippedRuns} skipped, ${report.aggregate.failedRuns} failed`);
}
if (!releasePassed) process.exitCode = 1;
