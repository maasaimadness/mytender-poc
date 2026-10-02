import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { evaluationFixtureSchema, type EvaluationFixture } from "./schemas.js";

const fixturesDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Loads only checked-in, versioned JSON fixtures and validates their public shape. */
export async function loadFixtures(directory = fixturesDirectory): Promise<EvaluationFixture[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const fixtures = await Promise.all(names.map(async (name) => {
    const raw = JSON.parse(await readFile(`${directory}/${name}`, "utf8")) as unknown;
    return evaluationFixtureSchema.parse(raw);
  }));
  if (fixtures.length === 0) throw new Error("No evaluation fixtures found.");
  const ids = new Set(fixtures.map((fixture) => fixture.id));
  if (ids.size !== fixtures.length) throw new Error("Evaluation fixture IDs must be unique.");
  return fixtures;
}
