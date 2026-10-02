import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { parseDemoArgs, renderDemoResult, runDemo, type DemoRunResult } from "../../src/demo/demo.js";
import { formatJsonlChunk, formatMemoryRecord, formatTraceEvent } from "../../src/demo/watch.js";

const temporaryRoots: string[] = [];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("demo CLI helpers", () => {
  it("uses defaults and validates the supported flags", () => {
    expect(parseDemoArgs([])).toEqual({ help: false, options: { question: "Describe two measurable customer outcomes.", maximumWords: 120 } });
    expect(parseDemoArgs(["--question", "Describe support.", "--max-words", "42"])).toEqual({ help: false, options: { question: "Describe support.", maximumWords: 42 } });
    expect(parseDemoArgs(["--help"])).toEqual({ help: true });
    for (const args of [["--question"], ["--max-words", "0"], ["--max-words", "two"], ["--unknown"]]) {
      expect(() => parseDemoArgs(args)).toThrow();
    }
  });

  it("runs the real workspace, tools, skills, and redacted sidecars with a mocked model", async () => {
    const root = await mkdtemp(join(tmpdir(), "mytender-demo-"));
    temporaryRoots.push(root);
    const model = new MockLanguageModelV4({ doGenerate: [
      toolCall("drafting-skill", "loadSkill", { id: "tender-drafting" }),
      toolCall("assessment-skill", "loadSkill", { id: "evidence-assessment" }),
      toolCall("read", "readSourceBlocks", { blockIds: ["outcomes-01"] }),
      toolCall("plan", "writePlan", { plan: { sections: [{ id: "answer", heading: "Customer outcomes", requirementIds: ["entered-question"] }] } }),
      toolCall("draft", "writeSection", { section: { id: "answer", heading: "Customer outcomes", content: "Fictional customers reduced handoff time by 24%.", requirementIds: ["entered-question"], citations: [{ sourceBlockId: "outcomes-01" }] } }),
      toolCall("assess", "recordEvidenceAssessment", { assessment: { claims: [{ id: "outcome", text: "24% handoff-time reduction", sourceBlockIds: ["outcomes-01"], status: "supported" }] } }),
      { content: [{ type: "text", text: "MODEL_SENTINEL" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
    ] });
    const result = await runDemo({
      question: "PROMPT_SENTINEL", maximumWords: 120, model, modelLabel: "safe-model", artifactRoot: root,
      skillRoot: join(process.cwd(), "skills"),
    });

    expect(result.workspace.draft?.sections).toHaveLength(1);
    expect(result.workspace.draft?.sections[0]?.citations).toEqual([{ sourceBlockId: "outcomes-01" }]);
    expect(result.review.readiness).toEqual({ canSubmit: true, reasons: [] });
    const workspaceFile = join(result.artifactDirectory, result.workspace.id, "workspace.json");
    await expect(readFile(workspaceFile, "utf8")).resolves.toContain("Customer outcomes");
    const sidecars = await Promise.all(["trace.jsonl", "memory.jsonl"].map((name) => readFile(join(result.artifactDirectory, name), "utf8")));
    const serialized = sidecars.join("\n");
    for (const secret of ["PROMPT_SENTINEL", "MODEL_SENTINEL", "ERROR_SENTINEL", "Fictional customers reduced handoff time"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("run_completed");
    expect(serialized).toContain("completed");
  });

  it("renders source citations and both readiness states from persisted state", async () => {
    const ready = sampleResult(true);
    expect(renderDemoResult(ready)).toContain("Citation fact-01 (p1): SANITIZED DEMO evidence.");
    expect(renderDemoResult(ready)).toContain("Draft words: 2/unlimited");
    expect(renderDemoResult(ready)).toContain("Readiness: READY (none)");
    const blocked = sampleResult(false);
    expect(renderDemoResult(blocked)).toContain("Readiness: BLOCKED (MISSING_REQUIREMENTS)");
    expect(renderDemoResult(blocked)).toContain("Missing evidence: requirement (No matching evidence)");
  });

  it("formats only allow-listed sidecar metadata and retains partial lines", () => {
    const trace = formatTraceEvent({
      type: "step_completed", runId: "run-1", stepNumber: 2, providerId: "provider", modelId: "model", finishReason: "tool-calls",
      toolNames: ["readSourceBlocks"], inputTokens: 3, outputTokens: 4, totalTokens: 7, prompt: "PROMPT_SENTINEL", content: "EVIDENCE_SENTINEL",
    });
    expect(trace).toContain("trace step_completed run=run-1");
    expect(trace).not.toContain("PROMPT_SENTINEL");
    expect(trace).not.toContain("EVIDENCE_SENTINEL");
    const memory = formatMemoryRecord({
      source: "agent-run", outcome: "blocked", nextActionCode: "add_evidence", failedChecks: ["MISSING_REQUIREMENTS"], warningCodes: [], missingRequirementIds: ["requirement"],
      claimStatuses: [{ id: "claim-1", status: "supported", text: "DRAFT_SENTINEL" }], retrievedBlockIds: ["fact-01"], raw: "ERROR_SENTINEL",
    });
    expect(memory).toContain("memory source=agent-run outcome=blocked");
    expect(memory).not.toContain("DRAFT_SENTINEL");
    expect(memory).not.toContain("ERROR_SENTINEL");
    const encoded = Buffer.from('{"type":"run_started","runId":"run-1"}\n{"type":"run_started"');
    const first = formatJsonlChunk("trace", Buffer.alloc(0), encoded);
    expect(first.lines).toEqual(["trace run_started run=run-1"]);
    expect(first.remainder.toString()).toBe('{"type":"run_started"');
    const second = formatJsonlChunk("trace", first.remainder, Buffer.from(',"runId":"run-2"}\nnot json\n'));
    expect(second.lines).toEqual(["trace run_started run=run-2", "Warning: ignored malformed sidecar event."]);
  });
});

function toolCall(toolCallId: string, toolName: string, input: unknown) {
  return { content: [{ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] };
}

function sampleResult(ready: boolean): DemoRunResult {
  return {
    artifactDirectory: "/tmp/demo-artifacts",
    modelLabel: "safe-model",
    workspace: {
      id: "demo-workspace", question: "Question", sourceDocuments: [{ id: "facts", role: "bidder_fact", title: "SANITIZED / FICTIONAL bidder evidence" }],
      sourceBlocks: [{ id: "fact-01", documentId: "facts", locator: "p1", text: "SANITIZED DEMO evidence." }], requirements: [{ id: "requirement", text: "Question", mandatory: true }],
      ...(ready ? { draft: { id: "draft", sections: [{ id: "section", heading: "Answer", content: "Grounded answer.", requirementIds: ["requirement"], citations: [{ sourceBlockId: "fact-01" }] }] } } : {}),
      warnings: [], missingEvidence: ready ? [] : [{ requirementId: "requirement", reason: "No matching evidence" }], claims: [], retrievedBlockIds: [], events: [], conflictingEvidenceGroups: [],
    },
    review: { missingRequirementIds: ready ? [] : ["requirement"], citationIssues: [], claimIssues: [], unresolvedConflictGroups: [], warningCodes: [], readiness: { canSubmit: ready, reasons: ready ? [] : ["MISSING_REQUIREMENTS"] } },
  };
}
