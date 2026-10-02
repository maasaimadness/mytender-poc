import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlAgentTraceSink, type AgentTraceEvent } from "../../src/agent/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JSONL agent tracing", () => {
  it("creates parent directories and appends parseable one-line events", async () => {
    const root = await mkdtemp(join(tmpdir(), "mytender-tracing-"));
    temporaryRoots.push(root);
    const path = join(root, "nested", "live-trace.jsonl");
    const sink = new JsonlAgentTraceSink(path);
    const event = baseEvent({ type: "run_started" });

    await sink.write(event);
    await sink.write({ ...baseEvent({ type: "run_completed" }), seq: 1, durationMs: 4 });

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([event, { ...baseEvent({ type: "run_completed" }), seq: 1, durationMs: 4 }]);
  });

  it("rejects trace events outside the allow-listed schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "mytender-tracing-"));
    temporaryRoots.push(root);
    const sink = new JsonlAgentTraceSink(join(root, "trace.jsonl"));

    await expect(sink.write({ ...baseEvent({ type: "run_started" }), prompt: "PROMPT_SECRET" } as AgentTraceEvent)).rejects.toThrow("Invalid agent trace event.");
  });
});

function baseEvent<T extends Pick<AgentTraceEvent, "type">>(event: T): AgentTraceEvent & T {
  return {
    schemaVersion: "v1",
    runId: "run-1",
    workspaceId: "workspace-1",
    seq: 0,
    timestamp: "2026-10-02T00:00:00.000Z",
    ...event,
  } as AgentTraceEvent & T;
}
