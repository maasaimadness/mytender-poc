import { randomUUID } from "node:crypto";
import { ToolLoopAgent, isStepCount, tool, type GenerateTextStepEndEvent, type LanguageModel } from "ai";
import { z } from "zod";

import { draftSectionSchema, sourceRoleSchema } from "../domain/index.js";
import { agentSkillIdSchema, type AgentSkillCatalog } from "./skills.js";
import type { RunMemoryRecord, RunMemoryStore } from "./memory.js";
import type { AgentTraceEvent, AgentTraceEventInput, AgentTraceSink } from "./tracing.js";
import { evidenceAssessmentSchema, TenderToolService } from "./tools.js";
import { responsePlanSchema, type Workspace } from "./workspace.js";

/** A small bound keeps one tender-writing turn finite while allowing skill loading and tender work. */
const MAX_AGENT_STEPS = 10;

const workspaceSummary = (workspace: Workspace) => ({
  id: workspace.id,
  question: workspace.question,
  requirements: workspace.requirements,
  sourceDocuments: workspace.sourceDocuments,
  sourceBlocks: workspace.sourceBlocks.map(({ id, documentId, locator }) => ({ id, documentId, locator })),
  plan: workspace.plan,
  draft: workspace.draft,
  missingEvidence: workspace.missingEvidence,
  retrievedBlockIds: workspace.retrievedBlockIds,
});

const planInputSchema = z.object({ plan: responsePlanSchema });
const sectionInputSchema = z.object({ section: draftSectionSchema });
const assessmentInputSchema = z.object({ assessment: evidenceAssessmentSchema });

export interface CreateTenderAgentOptions {
  model: LanguageModel;
  service: TenderToolService;
  workspaceId: string;
  skillCatalog: AgentSkillCatalog;
}

/**
 * Creates a tool loop whose tools are permanently scoped to one trusted workspace.
 * Workspace IDs are intentionally absent from all model-visible tool inputs.
 */
export function createTenderAgent({ model, service, workspaceId, skillCatalog }: CreateTenderAgentOptions) {
  return new ToolLoopAgent({
    model,
    instructions: [
      "Work only from the provided tender workspace tools.",
      "Before task work, load the relevant approved skill.",
      "The persisted workspace is the final artifact; keep any final response brief.",
    ].join(" "),
    stopWhen: isStepCount(MAX_AGENT_STEPS),
    tools: {
      loadSkill: tool({
        description: "Load instructions for an approved repository skill by ID.",
        inputSchema: z.object({ id: agentSkillIdSchema }),
        execute: async ({ id }) => skillCatalog.load(id),
      }),
      inspectWorkspace: tool({
        description: "Inspect the current workspace state before planning or drafting.",
        inputSchema: z.object({}),
        execute: async () => workspaceSummary(await service.inspectWorkspace(workspaceId)),
      }),
      searchEvidence: tool({
        description: "Search evidence blocks, optionally restricted to a source document role.",
        inputSchema: z.object({
          query: z.string().min(1),
          role: sourceRoleSchema.optional(),
          limit: z.number().int().positive().max(20).optional(),
        }),
        execute: async ({ query, role, limit }) => (await service.searchEvidence(workspaceId, query, {
          ...(role === undefined ? {} : { role }),
          ...(limit === undefined ? {} : { limit }),
        }))
          .map(({ block, score }) => ({ id: block.id, documentId: block.documentId, locator: block.locator, text: block.text, score })),
      }),
      readSourceBlocks: tool({
        description: "Read specified evidence source blocks before making factual claims.",
        inputSchema: z.object({ blockIds: z.array(z.string().min(1)).min(1).max(20) }),
        execute: async ({ blockIds }) => (await service.readSourceBlocks(workspaceId, blockIds))
          .map(({ id, documentId, locator, text }) => ({ id, documentId, locator, text })),
      }),
      writePlan: tool({
        description: "Persist the response plan before drafting sections.",
        inputSchema: planInputSchema,
        execute: async ({ plan }) => {
          const workspace = await service.writePlan(workspaceId, plan);
          return { plan: workspace.plan };
        },
      }),
      writeSection: tool({
        description: "Persist one separately drafted section with source block citations.",
        inputSchema: sectionInputSchema,
        execute: async ({ section }) => {
          const workspace = await service.writeSection(workspaceId, section);
          return { draft: workspace.draft };
        },
      }),
      recordEvidenceAssessment: tool({
        description: "Replace the complete claim and missing-evidence assessment after drafting.",
        inputSchema: assessmentInputSchema,
        execute: async ({ assessment }) => {
          const workspace = await service.recordEvidenceAssessment(workspaceId, assessment);
          return { claims: workspace.claims, missingEvidence: workspace.missingEvidence, warnings: workspace.warnings };
        },
      }),
      reviewWorkspace: tool({
        description: "Review deterministic submission readiness without changing the workspace.",
        inputSchema: z.object({}),
        execute: async () => service.reviewWorkspace(workspaceId),
      }),
    },
  });
}

export interface RunTenderAgentOptions extends CreateTenderAgentOptions {
  prompt: string;
  traceSink?: AgentTraceSink;
  memoryStore?: RunMemoryStore;
}

export async function runTenderAgent({ model, service, workspaceId, skillCatalog, prompt, traceSink, memoryStore }: RunTenderAgentOptions): Promise<{
  workspace: Workspace;
  text: string;
  runId: string;
}> {
  const runId = randomUUID();
  const startedAt = Date.now();
  let seq = 0;
  const writeTrace = async (event: AgentTraceEventInput) => {
    if (traceSink === undefined) return;
    await traceSink.write({ ...event, schemaVersion: "v1", runId, workspaceId, seq: seq++, timestamp: new Date().toISOString() } as AgentTraceEvent);
  };

  await writeTrace({ type: "run_started" });
  let result;
  try {
    result = await createTenderAgent({ model, service, workspaceId, skillCatalog }).generate({
      prompt,
      onStepEnd: async (step) => writeTrace(stepTraceEvent(step)),
    });
  } catch (error) {
    if (memoryStore !== undefined) {
      try {
        await memoryStore.record(failedMemoryRecord(runId, workspaceId));
      } catch {
        // Preserve the original agent error when memory persistence also fails.
      }
    }
    try {
      await writeTrace({ type: "run_failed", failureCode: "agent_run_failed", durationMs: elapsedMs(startedAt) });
    } catch {
      // Preserve the agent failure when trace persistence also fails.
    }
    throw error;
  }
  await writeTrace({ type: "run_completed", durationMs: elapsedMs(startedAt) });
  const workspace = await service.inspectWorkspace(workspaceId);
  if (memoryStore !== undefined) await memoryStore.record(completedMemoryRecord(runId, workspace, await service.reviewWorkspace(workspaceId)));
  return { workspace, text: result.text, runId };
}

function completedMemoryRecord(runId: string, workspace: Workspace, review: Awaited<ReturnType<TenderToolService["reviewWorkspace"]>>): RunMemoryRecord {
  return {
    schemaVersion: "v1",
    id: runId,
    recordedAt: new Date().toISOString(),
    source: "agent-run",
    runId,
    workspaceId: workspace.id,
    outcome: review.readiness.canSubmit ? "completed" : "blocked",
    failedChecks: [...new Set([
      ...review.readiness.reasons,
      ...review.citationIssues.map((issue) => issue.code),
      ...review.claimIssues.map((issue) => issue.code),
      ...review.unresolvedConflictGroups,
    ])],
    warningCodes: [...new Set(review.warningCodes)],
    missingRequirementIds: [...new Set(review.missingRequirementIds)],
    claimStatuses: workspace.claims.map((claim) => ({ id: claim.id, status: claim.status })),
    retrievedBlockIds: [...new Set(workspace.retrievedBlockIds)],
    nextActionCode: review.readiness.canSubmit
      ? "none"
      : review.unresolvedConflictGroups.length > 0 || workspace.claims.some((claim) => claim.status === "conflicting")
        ? "resolve_conflict"
        : review.missingRequirementIds.length > 0 || review.citationIssues.length > 0 || workspace.claims.some((claim) => claim.status !== "supported")
          ? "add_evidence"
          : "improve_tool_use",
  };
}

function failedMemoryRecord(runId: string, workspaceId: string): RunMemoryRecord {
  return {
    schemaVersion: "v1",
    id: runId,
    recordedAt: new Date().toISOString(),
    source: "agent-run",
    runId,
    workspaceId,
    outcome: "failed",
    failureCode: "agent_run_failed",
    failedChecks: [],
    warningCodes: [],
    missingRequirementIds: [],
    claimStatuses: [],
    retrievedBlockIds: [],
    nextActionCode: "improve_tool_use",
  };
}

function stepTraceEvent(step: GenerateTextStepEndEvent): AgentTraceEventInput {
  const stepTimeMs = finiteOrUndefined(step.performance.stepTimeMs);
  const responseTimeMs = finiteOrUndefined(step.performance.responseTimeMs);
  return {
    type: "step_completed",
    stepNumber: step.stepNumber,
    providerId: step.model.provider,
    modelId: step.model.modelId,
    finishReason: step.finishReason,
    toolNames: [...new Set(step.toolCalls.map(({ toolName }) => toolName))],
    inputTokens: finiteOrNull(step.usage.inputTokens),
    outputTokens: finiteOrNull(step.usage.outputTokens),
    totalTokens: finiteOrNull(step.usage.totalTokens),
    ...(stepTimeMs === undefined ? {} : { stepTimeMs }),
    ...(responseTimeMs === undefined ? {} : { responseTimeMs }),
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
