import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { evaluationReportSchema, type EvaluationReport } from "./schemas.js";

export async function writeReport(path: string, report: EvaluationReport): Promise<void> {
  const parsed = evaluationReportSchema.parse(report);
  const serialized = JSON.stringify(parsed, null, 2);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${serialized}\n`, { encoding: "utf8", flag: "w" });
}
