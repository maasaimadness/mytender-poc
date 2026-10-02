import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";

import { FileWorkspaceStore, runTenderAgent, TenderToolService, type AgentSkillCatalog, type AgentTraceSink, type RunMemoryStore, type Workspace } from "../agent/index.js";
import type { CandidateAdapter } from "./adapters.js";
import type { EvaluationInput } from "./schemas.js";

/** Runs the persisted tender-writing agent as an evaluation candidate. */
export class TenderAgentCandidateAdapter implements CandidateAdapter {
  readonly id = "tender-agent-v1";
  private static readonly workspaceId = "evaluation-workspace";

  public constructor(
    private readonly model: LanguageModel,
    private readonly skillCatalog: AgentSkillCatalog,
    private readonly traceSink?: AgentTraceSink,
    private readonly memoryStore?: RunMemoryStore,
  ) {}

  async generate(input: EvaluationInput): Promise<unknown> {
    const root = await mkdtemp(join(tmpdir(), "mytender-eval-"));
    try {
      const store = new FileWorkspaceStore(root);
      const workspace: Workspace = {
        id: TenderAgentCandidateAdapter.workspaceId,
        question: input.question,
        sourceDocuments: input.sourceDocuments,
        sourceBlocks: input.evidenceBlocks,
        requirements: input.requirements,
        warnings: [],
        missingEvidence: [],
        claims: [],
        retrievedBlockIds: [],
        events: [],
        conflictingEvidenceGroups: [],
      };
      await store.save(workspace);

      const service = new TenderToolService(store);
      const result = await runTenderAgent({
        model: this.model,
        service,
        workspaceId: workspace.id,
        skillCatalog: this.skillCatalog,
        prompt: "Draft a concise response addressing every workspace requirement using cited bidder evidence.",
        ...(this.traceSink === undefined ? {} : { traceSink: this.traceSink }),
        ...(this.memoryStore === undefined ? {} : { memoryStore: this.memoryStore }),
      });

      return {
        ...(result.workspace.draft === undefined ? {} : { draft: result.workspace.draft }),
        warnings: result.workspace.warnings,
        missingEvidence: result.workspace.missingEvidence,
        retrievedBlockIds: result.workspace.retrievedBlockIds,
        claims: result.workspace.claims,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
