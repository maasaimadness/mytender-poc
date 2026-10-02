import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { demoUsage, nextAction, parseDemoArgs, renderDemoResult, runDemo, type DemoRunResult } from "../../src/demo/demo.js";
import { formatDemoError, formatDemoProgress } from "../../src/demo/cli.js";
import { formatJsonlChunk, formatMemoryRecord, formatTraceEvent, parseWatchArgs, selectRunDirectory } from "../../src/demo/watch.js";

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
    expect(demoUsage()).toContain("OPENROUTER_API_KEY");
    expect(formatDemoError(new Error("Missing OPENROUTER_API_KEY"))).toBe("Demo configuration error: Missing OPENROUTER_API_KEY. Update ignored .env and try again.");
    expect(formatDemoError(new Error("provider body SECRET"))).toBe("Demo could not run. Check the provider/runtime configuration and try again.");
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
    const progress: string[] = [];
    const result = await runDemo({
      question: "PROMPT_SENTINEL", maximumWords: 120, model, modelLabel: "safe-model", artifactRoot: root,
      skillRoot: join(process.cwd(), "skills"), onProgress: (event) => {
        progress.push(formatDemoProgress(event));
      },
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
    expect(progress[0]).toBe("Demo run started.");
    expect(progress.some((line) => line.includes("recordEvidenceAssessment"))).toBe(true);
    expect(progress.at(-1)).toBe("Demo run completed.");
  });

  it("renders source citations and both readiness states from persisted state", async () => {
    const ready = sampleResult(true);
    expect(renderDemoResult(ready)).toContain("Citation fact-01 (p1): SANITIZED DEMO evidence.");
    expect(renderDemoResult(ready)).toContain("Draft words: 2/unlimited");
    expect(renderDemoResult(ready)).toContain("Readiness: READY (none)");
    expect(renderDemoResult(ready)).not.toContain("Next action:");
    expect(renderDemoResult(ready)).toContain("[SUPPORTED] 24% handoff-time reduction -> fact-01");
    const blocked = sampleResult(false);
    expect(renderDemoResult(blocked)).toContain("Readiness: BLOCKED (MISSING_REQUIREMENTS)");
    expect(renderDemoResult(blocked)).toContain("Missing evidence: requirement (No matching evidence)");
    expect(renderDemoResult(blocked)).toContain("Next action: Add bidder evidence for the missing requirements.");
    expect(nextAction({ ...blocked.review, readiness: { canSubmit: false, reasons: ["WORD_LIMIT_EXCEEDED"] } })).toBe("Reduce the draft to the word limit.");
  });

  it("waits for a new run by default and supports --latest", () => {
    const runs = [{ path: "/demo/old", modified: 1 }, { path: "/demo/new", modified: 2 }];
    expect(selectRunDirectory(runs, new Set(["/demo/old"]), false)).toBe("/demo/new");
    expect(selectRunDirectory(runs, new Set(["/demo/old", "/demo/new"]), false)).toBeUndefined();
    expect(selectRunDirectory(runs, new Set(["/demo/old", "/demo/new"]), true)).toBe("/demo/new");
    expect(parseWatchArgs([])).toEqual({ latest: false, help: false });
    expect(parseWatchArgs(["--latest"])).toEqual({ latest: true, help: false });
    expect(() => parseWatchArgs(["--old"])).toThrow("Unknown watcher argument. Use --help for supported options.");
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
      warnings: [], missingEvidence: ready ? [] : [{ requirementId: "requirement", reason: "No matching evidence" }], claims: ready ? [{ id: "claim", text: "24% handoff-time reduction", sourceBlockIds: ["fact-01"], status: "supported" }] : [], retrievedBlockIds: [], events: [], conflictingEvidenceGroups: [],
    },
    review: { missingRequirementIds: ready ? [] : ["requirement"], citationIssues: [], claimIssues: [], unresolvedConflictGroups: [], warningCodes: [], readiness: { canSubmit: ready, reasons: ready ? [] : ["MISSING_REQUIREMENTS"] } },
  };
}
