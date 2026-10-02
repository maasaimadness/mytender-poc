import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { FileAgentSkillCatalog } from "../../src/agent/index.js";
import { TenderAgentCandidateAdapter } from "../../src/evals/agent-adapter.js";
import { OfflineSemanticJudgeAdapter } from "../../src/evals/adapters.js";
import { loadFixtures } from "../../src/evals/fixtures.js";
import { reportPasses, runEvaluation } from "../../src/evals/runner.js";
import { candidateOutputSchema } from "../../src/evals/schemas.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

describe("tender agent candidate adapter", () => {
  it("runs the persisted agent through the real evaluation runner", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall("inspect", "inspectWorkspace", {}),
        toolCall("search", "searchEvidence", { query: "customer outcomes", role: "bidder_fact" }),
        toolCall("read", "readSourceBlocks", { blockIds: ["outcome-a", "outcome-b"] }),
        toolCall("plan", "writePlan", {
          plan: { sections: [{ id: "outcomes", heading: "Customer outcomes", requirementIds: ["outcomes"] }] },
        }),
        toolCall("section", "writeSection", {
          section: {
            id: "outcomes",
            heading: "Customer outcomes",
            content: "Customers reduced handoff time by 20% and improved completion accuracy to 98%.",
            requirementIds: ["outcomes"],
            citations: [{ sourceBlockId: "outcome-a" }, { sourceBlockId: "outcome-b" }],
          },
        }),
        { content: [{ type: "text", text: "Saved grounded response." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
      ],
    });
    const fixture = (await loadFixtures()).find((entry) => entry.id === "customer-outcomes");
    if (!fixture) throw new Error("Missing customer-outcomes fixture.");

    const report = await runEvaluation(
      fixture,
      new TenderAgentCandidateAdapter(model, new FileAgentSkillCatalog("skills")),
      new OfflineSemanticJudgeAdapter(),
      { repeats: 1 },
    );

    expect(report.candidateId).toBe("tender-agent-v1");
    expect(report.runs[0]?.status).toBe("judged");
    expect(report.runs[0]?.preflight.every((check) => check.passed)).toBe(true);
    expect(reportPasses(report)).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(6);
  });

  it("returns a schema-valid empty draft when the agent makes no draft", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [{ content: [{ type: "text", text: "Unable to draft." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }],
    });
    const fixture = (await loadFixtures()).find((entry) => entry.id === "customer-outcomes");
    if (!fixture) throw new Error("Missing customer-outcomes fixture.");

    const output = candidateOutputSchema.parse(await new TenderAgentCandidateAdapter(
      model,
      new FileAgentSkillCatalog("skills"),
    ).generate(fixture.input));

    expect(output.draft).toEqual({ id: "draft-evaluation-workspace", sections: [] });
  });

  it("preserves a full conflicting-evidence assessment from the persisted agent", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall("assess", "recordEvidenceAssessment", {
          assessment: {
            claims: [
              { id: "iso", text: "ISO 27001 status conflicts.", sourceBlockIds: ["iso-positive", "iso-negative"], status: "conflicting" },
              { id: "tenancy", text: "Dedicated tenancy status conflicts.", sourceBlockIds: ["tenancy-positive", "tenancy-negative"], status: "conflicting" },
            ],
            missingEvidence: [
              { requirementId: "iso", reason: "Conflicting source evidence." },
              { requirementId: "tenancy", reason: "Conflicting source evidence." },
            ],
          },
        }),
        { content: [{ type: "text", text: "Recorded the conflicts." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
      ],
    });
    const fixture = (await loadFixtures()).find((entry) => entry.id === "security-conflict");
    if (!fixture) throw new Error("Missing security-conflict fixture.");

    const output = candidateOutputSchema.parse(await new TenderAgentCandidateAdapter(
      model,
      new FileAgentSkillCatalog("skills"),
    ).generate(fixture.input));

    expect(output.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "iso", status: "conflicting", sourceBlockIds: ["iso-positive", "iso-negative"] }),
      expect.objectContaining({ id: "tenancy", status: "conflicting", sourceBlockIds: ["tenancy-positive", "tenancy-negative"] }),
    ]));
  });
});

function toolCall(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: [],
  };
}
