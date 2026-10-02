import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { OpenRouterSemanticJudgeAdapter } from "../../src/evals/openrouter-judge.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

describe("OpenRouterSemanticJudgeAdapter", () => {
  it("uses structured output to score each requested criterion", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify({ scores: [{ criterion: "groundedness", score: 5, reason: "Citations support the stated outcome." }] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    });
    const judge = new OpenRouterSemanticJudgeAdapter(model);

    const output = await judge.judge({
      fixtureId: "customer-outcomes",
      question: "Describe two customer outcomes.",
      requirements: [{ id: "outcomes", text: "Describe two outcomes", mandatory: true }],
      evidenceBlocks: [{ id: "outcome-a", documentId: "facts", locator: "derived:1", text: "Customers reduced handoff time by 20%." }],
      draft: {
        id: "draft",
        sections: [{
          id: "outcomes",
          heading: "Customer outcomes",
          content: "Customers reduced handoff time by 20%.",
          requirementIds: ["outcomes"],
          citations: [{ sourceBlockId: "outcome-a" }],
        }],
      },
      warnings: [],
      missingEvidence: [],
      rubric: ["groundedness"],
    });

    expect(judge.id).toBe("openrouter-semantic-judge-v1");
    expect(output).toEqual({ scores: [{ criterion: "groundedness", score: 5, reason: "Citations support the stated outcome." }] });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("customer-outcomes");
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("groundedness");
  });
});
