# mytender coding exercise

A small, grounded tender-writing agent. It plans a response, retrieves approved
bidder evidence, and persists cited draft sections one at a time.

## Current state

The repository contains a bounded AI SDK tool loop, filesystem-backed workspace,
deterministic tender tools, repository-owned skills, redacted observability,
OpenRouter model configuration, and an evaluation runner. There is no interface
yet.

## How it works

1. A validated JSON workspace holds requirements, source blocks, plan, draft,
   retrieval history, warnings, and claims.
2. Deterministic tools inspect that state, search and read evidence, write a plan,
   replace one draft section, persist an evidence assessment, and calculate
   submission readiness.
3. The agent loads two allow-listed Markdown skills on demand; the stable system
   prompt contains only the core safety policy.
4. A bounded model loop chooses those tools. The workspace—not the final chat
   message—is the output.
5. The same agent is a candidate in the evaluation runner; a separate judge
   adapter invocation evaluates only the semantic rubric after deterministic
   checks pass.

Every tool is closed over one trusted workspace ID. The model cannot select a
different workspace or use buyer requirements and marketing copy as evidence
for bidder facts.

Repository skills use the native `skills/<skill-id>/SKILL.md` shape. Each file
has YAML frontmatter with a matching `name` and a concise `description`, followed
by the domain workflow, safety invariants, and completion criteria. The loader
accepts only known skill IDs, validates the metadata and size, and returns the
instruction body to the model.

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
- declared claim/source relationships, including bidder-fact citation roles;
- requirement coverage and missing evidence;
- word limits;
- report integrity.

A semantic judge scores semantic groundedness, tailoring, scoreability, and writing quality.

The candidate and judge are separate adapters backed by the same configured model instance. The candidate never receives fixture answer keys. The judge runs only after deterministic checks pass. Deterministic validation checks declared claim/source relationships; semantic groundedness remains judge-scored.

## Live evaluation

Copy `.env.example` to the ignored `.env` file and add a fresh key, or export the
same values in your shell. Never commit credentials:

```bash
cp .env.example .env
npm run eval:live
```

The live runner uses separate candidate and judge adapters and defaults to three
runs per fixture. For a fast first baseline, use
`EVAL_REPEATS=1 npm run eval:live`.

The agent can persist evidence gaps and conflicting claims. Live evaluation asks
whether the model reliably chooses those tools in clean, incomplete, and
contradictory scenarios. Deterministic preflight stops unsafe outputs before the
semantic judge even if model behavior varies.

Live runs append two local, ignored sidecars under `eval-results/`:

- `live-trace.jsonl` contains run/step metadata such as tool names, token counts,
  timings, and fixed outcome codes;
- `live-memory.jsonl` contains structured completed, blocked, and failed outcomes
  plus stable next-action codes.

Both writers validate strict allow-listed schemas. They exclude prompts, source
text, drafts, tool inputs and outputs, provider bodies, raw errors, credentials,
and chain-of-thought.

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

Add a minimal question/document interface with section-level feedback, real
document ingestion, and resumable runs for long bids. Then use repeated live
evaluations to tune tool-selection reliability without weakening deterministic
submission gates.

## Observability boundaries

Four small mechanisms cover the production concerns without introducing a
framework:

1. Persist a complete evidence assessment and compute submission readiness.
2. Load allow-listed repository skills instead of expanding the system prompt.
3. Append redacted run and step metadata to JSONL traces.
4. Append structured `completed`, `blocked`, or `failed` run memory.

Workspace events remain the product audit history. Traces contain operational
metadata only. Run memory contains distilled outcomes and next-action codes.
None of these files may contain prompts, evidence text, drafts, tool arguments,
tool results, provider bodies, credentials, or chain-of-thought.

The JSON workspace is product state; workspace events are its mutation history.
Trace and memory files are operational sidecars, not inputs automatically replayed
into future prompts. Live evaluation requires a fresh OpenRouter key.
