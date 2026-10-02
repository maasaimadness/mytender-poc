import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { FileAgentSkillCatalog } from "../../src/agent/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSkillRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mytender-skills-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "tender-drafting.md"), "Draft with cited bidder facts.\n");
  await writeFile(join(root, "evidence-assessment.md"), "Record all gaps and conflicts.\n");
  return root;
}

describe("file agent skill catalog", () => {
  it("loads the two allow-listed skills", async () => {
    const catalog = new FileAgentSkillCatalog(await createSkillRoot());

    await expect(catalog.load("tender-drafting")).resolves.toEqual({
      id: "tender-drafting",
      instructions: "Draft with cited bidder facts.\n",
    });
    await expect(catalog.load("evidence-assessment")).resolves.toEqual({
      id: "evidence-assessment",
      instructions: "Record all gaps and conflicts.\n",
    });
  });

  it("rejects unknown and traversal-like IDs before file access", async () => {
    const root = await createSkillRoot();
    const catalog = new FileAgentSkillCatalog(root);
    const inaccessibleCatalog = new FileAgentSkillCatalog(join(root, "missing"));

    await expect(catalog.load("unknown")).rejects.toThrow();
    await expect(catalog.load("../../tender-drafting")).rejects.toThrow();
    await expect(inaccessibleCatalog.load("unknown")).rejects.toBeInstanceOf(ZodError);
    await expect(inaccessibleCatalog.load("../../tender-drafting")).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects blank and oversized skills", async () => {
    const root = await createSkillRoot();
    const catalog = new FileAgentSkillCatalog(root);
    await writeFile(join(root, "tender-drafting.md"), " \n\t");
    await expect(catalog.load("tender-drafting")).rejects.toThrow("must not be blank");

    await writeFile(join(root, "evidence-assessment.md"), "x".repeat(8 * 1024 + 1));
    await expect(catalog.load("evidence-assessment")).rejects.toThrow("exceeds the 8192-byte limit");
  });
});
