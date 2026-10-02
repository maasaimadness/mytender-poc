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
  "tender-drafting": "tender-drafting.md",
  "evidence-assessment": "evidence-assessment.md",
};

const MAX_SKILL_BYTES = 8 * 1024;

/** Reads an allow-listed repository skill from the injected skills directory. */
export class FileAgentSkillCatalog implements AgentSkillCatalog {
  public constructor(private readonly root: string) {}

  async load(candidateId: string): Promise<{ id: AgentSkillId; instructions: string }> {
    const id = agentSkillIdSchema.parse(candidateId);
    const instructions = await readFile(join(this.root, skillFiles[id]), "utf8");
    const byteLength = Buffer.byteLength(instructions, "utf8");

    if (byteLength > MAX_SKILL_BYTES) {
      throw new Error(`Skill ${id} exceeds the ${MAX_SKILL_BYTES}-byte limit.`);
    }
    if (instructions.trim().length === 0) {
      throw new Error(`Skill ${id} must not be blank.`);
    }

    return { id, instructions };
  }
}
