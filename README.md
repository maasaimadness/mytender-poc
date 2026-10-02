# mytender coding exercise

A small, grounded tender-writing agent.

The agent will plan a response, retrieve approved evidence, draft one section at a time, and stop when evidence is missing or contradictory.

## Current state

This repository currently contains the test and evaluation foundation. The product agent and interface are the next stage.

## Agent build plan

The agent will be added in four small blocks:

1. Add persistent workspace state and deterministic tender tools.
2. Add a bounded AI SDK tool loop with a mocked-model integration test.
3. Add OpenRouter configuration and credential-safe failure handling.
4. Connect the agent to the evaluation runner and record the first live results.

After each block, run:

```bash
npm test
npm run typecheck
npm run eval:smoke
```

The original tender pack stays outside Git. Tests use sanitized fixtures and temporary workspaces. Each block is a separate commit and can be reverted independently.

## Run the checks

```bash
npm ci
npm test
npm run typecheck
npm run eval:smoke
```

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

## Stochastic evaluation

The runner accepts separate candidate and judge adapters and defaults to three runs per fixture. The application agent will become the candidate adapter when it exists. A live CLI would be premature before that integration.

## Data safety

The supplied tender pack is excluded from Git because it contains confidential and personal information. Committed fixtures contain small, sanitized examples only.

## Project shape

```text
src/domain/          Tender evidence and draft policies
src/evals/           Evaluation schemas, checks, runner, and fixtures
tests/domain/        Domain policy tests
tests/evals/         Evaluation harness tests
```
