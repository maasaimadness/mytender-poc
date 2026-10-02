import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { FileAgentSkillCatalog, FileWorkspaceStore, runTenderAgent, TenderToolService, type AgentTraceEvent, type Workspace } from "../../src/agent/index.js";

const temporaryRoots: string[] = [];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createService(question = "Summarise the delivery outcome."): Promise<{ service: TenderToolService; workspaceId: string; skillCatalog: FileAgentSkillCatalog }> {
  const root = await mkdtemp(join(tmpdir(), "mytender-agent-loop-"));
  temporaryRoots.push(root);
  const store = new FileWorkspaceStore(root);
  const workspace: Workspace = {
    id: "trusted-workspace",
    question,
    sourceDocuments: [],
    sourceBlocks: [],
    requirements: [{ id: "outcome", text: "Describe the outcome", mandatory: true }],
    warnings: [],
    missingEvidence: [],
    claims: [],
    retrievedBlockIds: [],
    events: [],
    conflictingEvidenceGroups: [],
  };
  await store.save(workspace);
  const skillRoot = await mkdtemp(join(tmpdir(), "mytender-agent-skills-"));
  temporaryRoots.push(skillRoot);
  await writeFile(join(skillRoot, "tender-drafting.md"), "Draft the tender.\n");
  await writeFile(join(skillRoot, "evidence-assessment.md"), "Assess the evidence.\n");
  return { service: new TenderToolService(store), workspaceId: workspace.id, skillCatalog: new FileAgentSkillCatalog(skillRoot) };
}

describe("tender tool loop", () => {
  it("persists a tool-called plan and returns the persisted workspace", async () => {
    const { service, workspaceId, skillCatalog } = await createService();
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "writePlan",
            input: JSON.stringify({
              plan: { sections: [{ id: "outcome", heading: "Delivery outcome", requirementIds: ["outcome"] }] },
              workspaceId: "untrusted-workspace",
            }),
          }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Plan saved." }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });

    const result = await runTenderAgent({ model, service, workspaceId, skillCatalog, prompt: "Create the response plan." });

    expect(result.text).toBe("Plan saved.");
    expect(result.workspace.plan?.sections).toEqual([
      { id: "outcome", heading: "Delivery outcome", requirementIds: ["outcome"] },
    ]);
    expect(result.workspace.events.at(-1)).toEqual({ type: "plan_written", message: "Saved 1 plan section(s)." });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("loads approved skill content and rejects non-skill IDs", async () => {
    const { service, workspaceId, skillCatalog } = await createService();
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "load", toolName: "loadSkill", input: JSON.stringify({ id: "tender-drafting" }) }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        { content: [{ type: "text", text: "Skill loaded." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
      ],
    });

    const result = await runTenderAgent({ model, service, workspaceId, skillCatalog, prompt: "Draft a response." });

    expect(result.text).toBe("Skill loaded.");
    expect(JSON.stringify(model.doGenerateCalls[1])).toContain("Draft the tender.");
    await expect(skillCatalog.load(workspaceId)).rejects.toThrow();
    await expect(skillCatalog.load("../../tender-drafting")).rejects.toThrow();
  });

  it("writes redacted start, step, and completion metadata in sequence", async () => {
    const { service, workspaceId, skillCatalog } = await createService("SOURCE_SECRET");
    const events: AgentTraceEvent[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "writePlan",
            input: JSON.stringify({ plan: { sections: [{ id: "outcome", heading: "DRAFT_SECRET", requirementIds: ["outcome"] }] } }),
          }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        { content: [{ type: "text", text: "MODEL_SECRET" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
      ],
    });

    const result = await runTenderAgent({
      model,
      service,
      workspaceId,
      skillCatalog,
      prompt: "PROMPT_SECRET",
      traceSink: { write: async (event) => { events.push(event); } },
    });

    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.map(({ type }) => type)).toEqual(["run_started", "step_completed", "step_completed", "run_completed"]);
    expect(events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
    expect(events.filter((event) => event.type === "step_completed").map((event) => event.toolNames)).toEqual([["writePlan"], []]);
    const serialized = JSON.stringify(events);
    for (const secret of ["PROMPT_SECRET", "SOURCE_SECRET", "DRAFT_SECRET", "MODEL_SECRET"]) expect(serialized).not.toContain(secret);
    expect(allKeys(events)).not.toEqual(expect.arrayContaining(["prompt", "content", "input", "output", "result", "body", "headers", "errorMessage"]));
  });

  it("records a fixed failure code without serializing an agent error", async () => {
    const { service, workspaceId, skillCatalog } = await createService();
    const events: AgentTraceEvent[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async () => { throw new Error("ERROR_SECRET"); },
    });

    await expect(runTenderAgent({
      model,
      service,
      workspaceId,
      skillCatalog,
      prompt: "PROMPT_SECRET",
      traceSink: { write: async (event) => { events.push(event); } },
    })).rejects.toThrow("ERROR_SECRET");

    expect(events.map(({ type }) => type)).toEqual(["run_started", "run_failed"]);
    expect(events.at(-1)).toMatchObject({ type: "run_failed", failureCode: "agent_run_failed" });
    expect(JSON.stringify(events)).not.toContain("ERROR_SECRET");
  });
});

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allKeys(nested)]);
}
