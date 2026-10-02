import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { FileAgentSkillCatalog, FileWorkspaceStore, runTenderAgent, TenderToolService, type AgentTraceEvent, type RunMemoryRecord, type Workspace } from "../../src/agent/index.js";

const temporaryRoots: string[] = [];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createService(question = "Summarise the delivery outcome.", ready = false): Promise<{ service: TenderToolService; workspaceId: string; skillCatalog: FileAgentSkillCatalog }> {
  const root = await mkdtemp(join(tmpdir(), "mytender-agent-loop-"));
  temporaryRoots.push(root);
  const store = new FileWorkspaceStore(root);
  const workspace: Workspace = {
    id: "trusted-workspace",
    question,
    sourceDocuments: ready ? [{ id: "bidder-doc", role: "bidder_fact", title: "Bidder evidence" }] : [],
    sourceBlocks: ready ? [{ id: "block-1", documentId: "bidder-doc", locator: "p1", text: "Evidence." }] : [],
    requirements: [{ id: "outcome", text: "Describe the outcome", mandatory: true }],
    ...(ready ? {
      plan: { sections: [{ id: "outcome", heading: "Outcome", requirementIds: ["outcome"] }] },
      draft: { id: "draft-trusted-workspace", sections: [{ id: "outcome", heading: "Outcome", content: "Evidence-backed outcome.", requirementIds: ["outcome"], citations: [{ sourceBlockId: "block-1" }] }] },
    } : {}),
    warnings: [],
    missingEvidence: [],
    claims: ready ? [{ id: "claim-1", text: "Outcome", sourceBlockIds: ["block-1"], status: "supported" }] : [],
    retrievedBlockIds: ready ? ["block-1"] : [],
    events: [],
    conflictingEvidenceGroups: [],
  };
  await store.save(workspace);
  const skillRoot = await mkdtemp(join(tmpdir(), "mytender-agent-skills-"));
  temporaryRoots.push(skillRoot);
  await mkdir(join(skillRoot, "tender-drafting"), { recursive: true });
  await mkdir(join(skillRoot, "evidence-assessment"), { recursive: true });
  await writeFile(join(skillRoot, "tender-drafting", "SKILL.md"), "---\nname: tender-drafting\ndescription: Draft the tender.\n---\nDraft the tender.\n");
  await writeFile(join(skillRoot, "evidence-assessment", "SKILL.md"), "---\nname: evidence-assessment\ndescription: Assess the evidence.\n---\nAssess the evidence.\n");
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

  it("records blocked and failed redacted run memory", async () => {
    const { service, workspaceId, skillCatalog } = await createService("EVIDENCE_SENTINEL");
    const records: RunMemoryRecord[] = [];
    const blockedModel = new MockLanguageModelV4({ doGenerate: [{ content: [{ type: "text", text: "DRAFT_SENTINEL" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }] });
    await runTenderAgent({ model: blockedModel, service, workspaceId, skillCatalog, prompt: "PROMPT_SENTINEL", memoryStore: { record: async (record) => { records.push(record); } } });
    expect(records[0]).toMatchObject({ outcome: "blocked", nextActionCode: "add_evidence", missingRequirementIds: ["outcome"] });
    const failedModel = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("ERROR_SENTINEL"); } });
    await expect(runTenderAgent({ model: failedModel, service, workspaceId, skillCatalog, prompt: "PROMPT_SENTINEL", memoryStore: { record: async (record) => { records.push(record); } } })).rejects.toThrow("ERROR_SENTINEL");
    expect(records.at(-1)).toMatchObject({ outcome: "failed", failureCode: "agent_run_failed" });
    expect(JSON.stringify(records)).not.toContain("PROMPT_SENTINEL");
    expect(JSON.stringify(records)).not.toContain("EVIDENCE_SENTINEL");
    expect(JSON.stringify(records)).not.toContain("DRAFT_SENTINEL");
    expect(JSON.stringify(records)).not.toContain("ERROR_SENTINEL");
  });

  it("records completed memory when deterministic review permits submission", async () => {
    const { service, workspaceId, skillCatalog } = await createService(undefined, true);
    const records: RunMemoryRecord[] = [];
    const model = new MockLanguageModelV4({ doGenerate: [{ content: [{ type: "text", text: "Saved." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }] });
    await runTenderAgent({ model, service, workspaceId, skillCatalog, prompt: "PROMPT_SENTINEL", memoryStore: { record: async (record) => { records.push(record); } } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "completed", nextActionCode: "none", claimStatuses: [{ id: "claim-1", status: "supported" }] });
  });

  it("surfaces successful-run memory persistence failures", async () => {
    const { service, workspaceId, skillCatalog } = await createService();
    const model = new MockLanguageModelV4({ doGenerate: [{ content: [{ type: "text", text: "Saved." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }] });
    await expect(runTenderAgent({
      model,
      service,
      workspaceId,
      skillCatalog,
      prompt: "Prompt.",
      memoryStore: { record: async () => { throw new Error("MEMORY_PERSISTENCE_ERROR"); } },
    })).rejects.toThrow("MEMORY_PERSISTENCE_ERROR");
  });
});

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allKeys(nested)]);
}
