import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  FileAgentSkillCatalog,
  FileWorkspaceStore,
  JsonlAgentTraceSink,
  JsonlRunMemoryStore,
  TenderToolService,
  runTenderAgent,
  type AgentSkillCatalog,
  type Workspace,
  type WorkspaceReview,
} from "../agent/index.js";
import type { LanguageModel } from "ai";

export const DEFAULT_QUESTION = "Describe two measurable customer outcomes.";
export const DEFAULT_MAXIMUM_WORDS = 120;

export interface DemoOptions {
  question: string;
  maximumWords: number;
}

export type ParsedDemoArgs = { help: true } | { help: false; options: DemoOptions };

/** Parses the intentionally small public CLI surface without exposing raw argv in errors. */
export function parseDemoArgs(args: readonly string[]): ParsedDemoArgs {
  let question = DEFAULT_QUESTION;
  let maximumWords = DEFAULT_MAXIMUM_WORDS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      if (args.length !== 1) throw new Error("Use --help by itself.");
      return { help: true };
    }
    if (arg === "--question" || arg === "--max-words") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      if (arg === "--question") {
        if (value.trim().length === 0) throw new Error("Question must not be blank.");
        question = value.trim();
      } else {
        if (!/^\d+$/u.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
          throw new Error("--max-words must be a positive whole number.");
        }
        maximumWords = Number(value);
      }
      continue;
    }
    throw new Error("Unknown argument. Use --help for supported options.");
  }
  return { help: false, options: { question, maximumWords } };
}

export const demoUsage = (): string => [
  "Usage: npm run demo -- [--question <text>] [--max-words <positive-int>]",
  "Runs only against SANITIZED / FICTIONAL bidder evidence.",
].join("\n");

export interface DemoRunResult {
  artifactDirectory: string;
  workspace: Workspace;
  review: WorkspaceReview;
  modelLabel: string;
}

export interface RunDemoOptions extends DemoOptions {
  model: LanguageModel;
  modelLabel: string;
  artifactRoot?: string;
  skillRoot?: string;
}

/** Builds a new isolated workspace for a safe, fictional demonstration. */
export async function runDemo(options: RunDemoOptions): Promise<DemoRunResult> {
  const artifactRoot = resolve(options.artifactRoot ?? "tmp/demo");
  const workspaceId = `demo-${Date.now()}-${randomUUID()}`;
  const artifactDirectory = resolve(artifactRoot, workspaceId);
  await mkdir(artifactDirectory, { recursive: true });

  const store = new FileWorkspaceStore(artifactDirectory);
  const workspace = demoWorkspace(workspaceId, options);
  await store.save(workspace);
  const service = new TenderToolService(store);
  const skillCatalog: AgentSkillCatalog = new FileAgentSkillCatalog(resolve(options.skillRoot ?? "skills"));
  const result = await runTenderAgent({
    model: options.model,
    service,
    workspaceId,
    skillCatalog,
    prompt: `Create a grounded tender response to this question: ${options.question}`,
    traceSink: new JsonlAgentTraceSink(resolve(artifactDirectory, "trace.jsonl")),
    memoryStore: new JsonlRunMemoryStore(resolve(artifactDirectory, "memory.jsonl")),
  });
  return { artifactDirectory, workspace: result.workspace, review: await service.reviewWorkspace(workspaceId), modelLabel: options.modelLabel };
}

function demoWorkspace(id: string, options: DemoOptions): Workspace {
  return {
    id,
    question: options.question,
    maximumWords: options.maximumWords,
    sourceDocuments: [{ id: "sanitized-demo-evidence", role: "bidder_fact", title: "SANITIZED / FICTIONAL bidder evidence" }],
    sourceBlocks: [
      { id: "outcomes-01", documentId: "sanitized-demo-evidence", locator: "outcomes", text: "SANITIZED DEMO: Fictional customers reduced case handoff time by 24% and achieved 18% faster first-response times within six months." },
      { id: "implementation-01", documentId: "sanitized-demo-evidence", locator: "implementation", text: "SANITIZED DEMO: A fictional implementation team uses a two-week discovery, configured pilot, and named adoption lead for onboarding." },
      { id: "security-01", documentId: "sanitized-demo-evidence", locator: "security", text: "SANITIZED DEMO: The fictional service uses role-based access, encryption in transit and at rest, and quarterly access reviews." },
      { id: "support-01", documentId: "sanitized-demo-evidence", locator: "support", text: "SANITIZED DEMO: Fictional support provides a named service manager, weekday response coverage, and monthly service reviews." },
    ],
    requirements: [{ id: "entered-question", text: options.question, mandatory: true }],
    warnings: [],
    missingEvidence: [],
    claims: [],
    retrievedBlockIds: [],
    events: [{ type: "demo_workspace_created", message: "Created SANITIZED / FICTIONAL demo workspace." }],
    conflictingEvidenceGroups: [],
  };
}

/** Renders persisted workspace state only; model chat text is intentionally excluded. */
export function renderDemoResult(result: DemoRunResult): string {
  const blocks = new Map(result.workspace.sourceBlocks.map((block) => [block.id, block]));
  const draftWords = (result.workspace.draft?.sections ?? [])
    .flatMap((section) => section.content.trim().split(/\s+/u).filter(Boolean)).length;
  const lines = [
    "SANITIZED / FICTIONAL evidence demo",
    `Question: ${result.workspace.question}`,
    `Model: ${result.modelLabel}`,
    `Draft words: ${draftWords}/${result.workspace.maximumWords ?? "unlimited"}`,
    "",
    "Draft:",
  ];
  if (!result.workspace.draft?.sections.length) lines.push("(no persisted draft sections)");
  for (const section of result.workspace.draft?.sections ?? []) {
    lines.push(`\n${section.heading}`, section.content || "(empty)");
    for (const citation of section.citations) {
      const block = blocks.get(citation.sourceBlockId);
      if (block) lines.push(`Citation ${block.id} (${block.locator}): ${shortExcerpt(block.text)}`);
      else lines.push(`Citation ${citation.sourceBlockId}: unavailable`);
    }
  }
  lines.push("", `Missing evidence: ${result.workspace.missingEvidence.map((gap) => `${gap.requirementId} (${gap.reason})`).join("; ") || "none"}`);
  lines.push(`Warnings: ${result.review.warningCodes.join(", ") || "none"}`);
  lines.push(`Readiness: ${result.review.readiness.canSubmit ? "READY" : "BLOCKED"} (${result.review.readiness.reasons.join(", ") || "none"})`);
  lines.push(`Artifacts: ${result.artifactDirectory}`);
  return lines.join("\n");
}

function shortExcerpt(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}
