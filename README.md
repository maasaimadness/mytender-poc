# mytender coding exercise

A small, grounded tender-writing agent. It plans a response, retrieves approved
bidder evidence, and persists cited draft sections one at a time.

## Current state

The repository contains a bounded AI SDK tool loop, filesystem-backed workspace,
deterministic tender tools, OpenRouter model configuration, and an evaluation
runner. There is no interface yet.

## How it works

1. A validated JSON workspace holds requirements, source blocks, plan, draft,
   retrieval history, warnings, and claims.
2. Deterministic tools inspect that state, search and read evidence, write a plan,
   and replace one draft section.
3. A bounded model loop chooses those tools. The workspace—not the final chat
   message—is the output.
4. The same agent is a candidate in the evaluation runner; a separate model
   judges only the semantic rubric after deterministic checks pass.

Every tool is closed over one trusted workspace ID. The model cannot select a
different workspace or use buyer requirements and marketing copy as evidence
for bidder facts.

## Setup and checks

```bash
npm ci
npm test
npm run typecheck
npm run eval:smoke
```

Use Node.js 22 or newer. The original tender pack stays outside Git; tests use
sanitized fixtures and temporary workspaces.

`eval:smoke` runs three sanitized scenarios through the same schemas, preflight checks, runner, and report writer used by live evaluations:

- a grounded customer-outcomes answer;
- a partial answer with a missing third case study;
- a safe refusal when security evidence conflicts.

Generated reports are written to `eval-results/` and are not committed.

## Evaluation boundary

Deterministic code checks facts that do not need model judgement:

- source roles and allowed evidence;
- citation resolution;
- conflicting or unsupported claims;
- requirement coverage and missing evidence;
- word limits;
- report integrity.

A semantic judge scores only qualities such as groundedness, tailoring, scoreability, and writing quality.

The candidate and judge are separate adapters. The candidate never receives fixture answer keys. The judge runs only after deterministic checks pass.

## Live evaluation

Set credentials in the environment, never in the repository:

```bash
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=provider/model
npm run eval:live
```

The live runner uses separate candidate and judge adapters and defaults to three
runs per fixture. For a fast first baseline, use
`EVAL_REPEATS=1 npm run eval:live`.

The current agent should handle the clean grounded-answer case. The missing case
study and contradictory-security scenarios are intentionally the next red bar:
the workspace models warnings, gaps, and conflicting claims, but the model does
not yet have a tool that can persist them. Deterministic preflight should stop
those outputs before the semantic judge.

## Data safety

The supplied tender pack is excluded from Git because it contains confidential and personal information. Committed fixtures contain small, sanitized examples only.

## Project shape

```text
src/domain/          Tender evidence and draft policies
src/agent/           Persistent workspace, tools, model loop, provider config
src/evals/           Evaluation schemas, checks, runner, and fixtures
tests/agent/         Tool, loop, and provider tests
tests/domain/        Domain policy tests
tests/evals/         Evaluation harness tests
```

## With more time

The next block would add one deterministic tool for recording evidence gaps,
conflicts, and claim status, then use the red live fixtures to drive it green.
After that: a minimal question/document interface with section-level feedback,
real document ingestion, and resumable runs for long bids.
