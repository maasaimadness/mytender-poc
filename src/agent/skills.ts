import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** The only repository-owned skills the tender agent may load. */
export const agentSkillIdSchema = z.enum(["tender-drafting", "evidence-assessment"]);
export type AgentSkillId = z.infer<typeof agentSkillIdSchema>;

export interface AgentSkillCatalog {
  load(id: string): Promise<{ id: AgentSkillId; instructions: string }>;
}

const skillFiles: Record<AgentSkillId, string> = {
  "tender-drafting": "tender-drafting/SKILL.md",
  "evidence-assessment": "evidence-assessment/SKILL.md",
};

const MAX_SKILL_BYTES = 8 * 1024;

/** Reads an allow-listed repository skill from the injected skills directory. */
export class FileAgentSkillCatalog implements AgentSkillCatalog {
  public constructor(private readonly root: string) {}

  async load(candidateId: string): Promise<{ id: AgentSkillId; instructions: string }> {
    const parsedId = agentSkillIdSchema.safeParse(candidateId);
    if (!parsedId.success) throw new Error("Unknown agent skill ID.");
    const id = parsedId.data;
    const file = await readFile(join(this.root, skillFiles[id]), "utf8");
    const byteLength = Buffer.byteLength(file, "utf8");

    if (byteLength > MAX_SKILL_BYTES) {
      throw new Error(`Skill ${id} exceeds the ${MAX_SKILL_BYTES}-byte limit.`);
    }

    return { id, instructions: parseSkillInstructions(id, file) };
  }
}

const frontmatterField = /^([a-z][a-z0-9_-]*):[ \t]*(.*)$/u;

function parseSkillInstructions(id: AgentSkillId, file: string): string {
  const lines = file.split(/\r?\n/u);
  if (lines[0] !== "---") throw new Error(`Skill ${id} has invalid frontmatter.`);

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) throw new Error(`Skill ${id} has invalid frontmatter.`);

  const metadata = new Map<string, string>();
  for (const line of lines.slice(1, closingIndex)) {
    const field = frontmatterField.exec(line);
    if (field === null) throw new Error(`Skill ${id} has invalid frontmatter.`);
    const key = field[1];
    const value = field[2];
    if (key === undefined || value === undefined) throw new Error(`Skill ${id} has invalid frontmatter.`);
    if (metadata.has(key)) throw new Error(`Skill ${id} has duplicate ${key} metadata.`);
    metadata.set(key, value);
  }

  const name = metadata.get("name");
  const description = metadata.get("description");
  if (name === undefined || description === undefined || description.trim().length === 0) {
    throw new Error(`Skill ${id} has incomplete frontmatter.`);
  }
  if (name !== id) throw new Error(`Skill ${id} has mismatched name metadata.`);

  const instructions = lines.slice(closingIndex + 1).join("\n");
  if (instructions.trim().length === 0) throw new Error(`Skill ${id} must not have a blank body.`);
  return instructions;
}
