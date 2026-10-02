import type {
  CandidateOutput,
  EvaluationInput,
  SemanticJudgeOutput,
  SemanticScore,
} from "./schemas.js";

export interface CandidateAdapter {
  readonly id: string;
  generate(input: EvaluationInput): Promise<unknown>;
}

export interface JudgeInput {
  fixtureId: string;
  question: string;
  requirements: EvaluationInput["requirements"];
  evidenceBlocks: EvaluationInput["evidenceBlocks"];
  draft: CandidateOutput["draft"];
  warnings: CandidateOutput["warnings"];
  missingEvidence: CandidateOutput["missingEvidence"];
  rubric: readonly SemanticScore["criterion"][];
}

export interface SemanticJudgeAdapter {
  readonly id: string;
  judge(input: JudgeInput): Promise<unknown>;
}

export class OfflineFixtureCandidateAdapter implements CandidateAdapter {
  readonly id = "offline-fixture-candidate-v1";

  async generate(input: EvaluationInput): Promise<unknown> {
    const section = (id: string, heading: string, content: string, requirementIds: string[], citationIds: string[]) => ({
      id, heading, content, requirementIds, citations: citationIds.map((sourceBlockId) => ({ sourceBlockId })),
    });
    if (input.fixtureId === "customer-outcomes") {
      return {
        draft: { id: "customer-outcomes-draft", sections: [section("outcomes", "Customer outcomes", "Customers reduced handoff time by 20% and improved completion accuracy to 98%.", ["outcomes"], ["outcome-a", "outcome-b"])] },
        warnings: [],
        missingEvidence: [],
        retrievedBlockIds: ["outcome-a", "outcome-b"],
        claims: [
          { id: "outcome-a-claim", text: "Customers reduced handoff time by 20%.", sourceBlockIds: ["outcome-a"], status: "supported" },
          { id: "outcome-b-claim", text: "Customers improved completion accuracy to 98%.", sourceBlockIds: ["outcome-b"], status: "supported" },
        ],
      };
    }
    if (input.fixtureId === "three-case-studies-gap") {
      return {
        draft: { id: "case-gap-draft", sections: [section("case-one", "Case study one", "Case A cut response time by 15%.", ["case-one"], ["case-a"]), section("case-two", "Case study two", "Case B increased adoption by 12%.", ["case-two"], ["case-b"])] },
        warnings: [{ code: "INSUFFICIENT_EVIDENCE", message: "Only two supported case studies are available." }],
        missingEvidence: [{ requirementId: "case-three", reason: "No third supported case study is available." }],
        retrievedBlockIds: ["case-a", "case-b"],
        claims: [
          { id: "case-a-claim", text: "Case A cut response time by 15%.", sourceBlockIds: ["case-a"], status: "supported" },
          { id: "case-b-claim", text: "Case B increased adoption by 12%.", sourceBlockIds: ["case-b"], status: "supported" },
        ],
      };
    }
    return {
      draft: { id: "security-safe-failure", sections: [] },
      warnings: [{ code: "INSUFFICIENT_EVIDENCE", message: "Security evidence is incomplete or conflicting." }],
      missingEvidence: input.requirements.map((requirement) => ({ requirementId: requirement.id, reason: "Evidence requires confirmation." })),
      retrievedBlockIds: ["iso-positive", "iso-negative", "tenancy-positive", "tenancy-negative"],
      claims: [
        { id: "iso-status", text: "ISO 27001 status conflicts.", sourceBlockIds: ["iso-positive", "iso-negative"], status: "conflicting" },
        { id: "tenancy-status", text: "Tenancy status conflicts.", sourceBlockIds: ["tenancy-positive", "tenancy-negative"], status: "conflicting" },
      ],
    };
  }
}

export class OfflineSemanticJudgeAdapter implements SemanticJudgeAdapter {
  readonly id = "offline-semantic-judge-v1";

  async judge(input: JudgeInput): Promise<unknown> {
    return {
      scores: input.rubric.map((criterion) => ({ criterion, score: 4, reason: "Offline smoke score from sanitized fixture output." })),
    };
  }
}
