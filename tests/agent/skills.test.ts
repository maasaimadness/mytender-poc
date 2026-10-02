import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentSkillCatalog } from "../../src/agent/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSkillRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mytender-skills-"));
  temporaryRoots.push(root);
  await writeSkill(root, "tender-drafting", "Draft with cited bidder facts.\n");
  await writeSkill(root, "evidence-assessment", "Record all gaps and conflicts.\n");
  return root;
}

async function writeSkill(root: string, id: "tender-drafting" | "evidence-assessment", body: string, frontmatter = `name: ${id}\ndescription: Test skill.`): Promise<void> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
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

    await expect(catalog.load("unknown")).rejects.toThrow("Unknown agent skill ID.");
    await expect(catalog.load("../../tender-drafting")).rejects.toThrow("Unknown agent skill ID.");
    await expect(inaccessibleCatalog.load("unknown")).rejects.toThrow("Unknown agent skill ID.");
    await expect(inaccessibleCatalog.load("../../tender-drafting")).rejects.toThrow("Unknown agent skill ID.");
  });

  it("returns only the Markdown body after validated metadata", async () => {
    const root = await createSkillRoot();
    await writeSkill(root, "tender-drafting", "# Draft\n\nCite bidder facts.\n", "name: tender-drafting\ndescription: Draft with evidence.");

    await expect(new FileAgentSkillCatalog(root).load("tender-drafting")).resolves.toEqual({
      id: "tender-drafting",
      instructions: "# Draft\n\nCite bidder facts.\n",
    });
  });

  it.each([
    ["missing opening delimiter", "name: tender-drafting\ndescription: Test skill.\n---\nBody\n", "invalid frontmatter"],
    ["missing closing delimiter", "---\nname: tender-drafting\ndescription: Test skill.\nBody\n", "invalid frontmatter"],
    ["malformed metadata", "---\nname tender-drafting\ndescription: Test skill.\n---\nBody\n", "invalid frontmatter"],
    ["duplicate name", "---\nname: tender-drafting\nname: tender-drafting\ndescription: Test skill.\n---\nBody\n", "duplicate name metadata"],
    ["duplicate description", "---\nname: tender-drafting\ndescription: First.\ndescription: Second.\n---\nBody\n", "duplicate description metadata"],
    ["missing name", "---\ndescription: Test skill.\n---\nBody\n", "incomplete frontmatter"],
    ["missing description", "---\nname: tender-drafting\n---\nBody\n", "incomplete frontmatter"],
    ["blank description", "---\nname: tender-drafting\ndescription:  \n---\nBody\n", "incomplete frontmatter"],
    ["mismatched name", "---\nname: evidence-assessment\ndescription: Test skill.\n---\nBody\n", "mismatched name metadata"],
    ["blank body", "---\nname: tender-drafting\ndescription: Test skill.\n---\n \n", "must not have a blank body"],
  ])("rejects %s", async (_caseName, file, message) => {
    const root = await createSkillRoot();
    await writeFile(join(root, "tender-drafting", "SKILL.md"), file);

    await expect(new FileAgentSkillCatalog(root).load("tender-drafting")).rejects.toThrow(message);
  });

  it("rejects blank bodies and oversized full files", async () => {
    const root = await createSkillRoot();
    const catalog = new FileAgentSkillCatalog(root);
    await writeSkill(root, "tender-drafting", " \n\t");
    await expect(catalog.load("tender-drafting")).rejects.toThrow("must not have a blank body");

    await writeSkill(root, "evidence-assessment", "x".repeat(8 * 1024 + 1));
    await expect(catalog.load("evidence-assessment")).rejects.toThrow("exceeds the 8192-byte limit");
  });
});
