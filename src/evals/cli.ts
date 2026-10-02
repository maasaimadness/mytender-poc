import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { OfflineFixtureCandidateAdapter, OfflineSemanticJudgeAdapter } from "./adapters.js";
import { loadFixtures } from "./fixtures.js";
import { writeReport } from "./report.js";
import { reportPasses, runEvaluation } from "./runner.js";

const candidate = new OfflineFixtureCandidateAdapter();
const judge = new OfflineSemanticJudgeAdapter();
const outputDirectory = resolve("eval-results");
await mkdir(outputDirectory, { recursive: true });
let releasePassed = true;
for (const fixture of await loadFixtures()) {
  const report = await runEvaluation(fixture, candidate, judge, { repeats: 1 });
  await writeReport(resolve(outputDirectory, `${fixture.id}.${fixture.version}.smoke.json`), report);
  releasePassed = reportPasses(report) && releasePassed;
  console.log(`${fixture.id}: ${report.aggregate.judgedRuns} judged, ${report.aggregate.skippedRuns} skipped, ${report.aggregate.failedRuns} failed`);
}
if (!releasePassed) process.exitCode = 1;
