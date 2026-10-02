import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { FileWorkspaceStore, runTenderAgent, TenderToolService, type Workspace } from "../../src/agent/index.js";

const temporaryRoots: string[] = [];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createService(): Promise<{ service: TenderToolService; workspaceId: string }> {
  const root = await mkdtemp(join(tmpdir(), "mytender-agent-loop-"));
  temporaryRoots.push(root);
  const store = new FileWorkspaceStore(root);
  const workspace: Workspace = {
    id: "trusted-workspace",
    question: "Summarise the delivery outcome.",
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
  return { service: new TenderToolService(store), workspaceId: workspace.id };
}

describe("tender tool loop", () => {
  it("persists a tool-called plan and returns the persisted workspace", async () => {
    const { service, workspaceId } = await createService();
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

    const result = await runTenderAgent({ model, service, workspaceId, prompt: "Create the response plan." });

    expect(result.text).toBe("Plan saved.");
    expect(result.workspace.plan?.sections).toEqual([
      { id: "outcome", heading: "Delivery outcome", requirementIds: ["outcome"] },
    ]);
    expect(result.workspace.events.at(-1)).toEqual({ type: "plan_written", message: "Saved 1 plan section(s)." });
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});
