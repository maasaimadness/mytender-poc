import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AgentTraceBase {
  schemaVersion: "v1";
  runId: string;
  workspaceId: string;
  seq: number;
  timestamp: string;
}

export interface AgentRunStartedTraceEvent extends AgentTraceBase {
  type: "run_started";
}

export interface AgentStepCompletedTraceEvent extends AgentTraceBase {
  type: "step_completed";
  stepNumber: number;
  providerId: string;
  modelId: string;
  finishReason: string;
  toolNames: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  stepTimeMs?: number;
  responseTimeMs?: number;
}

export interface AgentRunCompletedTraceEvent extends AgentTraceBase {
  type: "run_completed";
  durationMs?: number;
}

export interface AgentRunFailedTraceEvent extends AgentTraceBase {
  type: "run_failed";
  failureCode: "agent_run_failed";
  durationMs?: number;
}

export type AgentTraceEvent =
  | AgentRunStartedTraceEvent
  | AgentStepCompletedTraceEvent
  | AgentRunCompletedTraceEvent
  | AgentRunFailedTraceEvent;

export type AgentTraceEventInput =
  | Omit<AgentRunStartedTraceEvent, keyof AgentTraceBase>
  | Omit<AgentStepCompletedTraceEvent, keyof AgentTraceBase>
  | Omit<AgentRunCompletedTraceEvent, keyof AgentTraceBase>
  | Omit<AgentRunFailedTraceEvent, keyof AgentTraceBase>;

export interface AgentTraceSink {
  write(event: AgentTraceEvent): Promise<void>;
}

/** Appends strictly validated, redacted trace events as one JSON object per line. */
export class JsonlAgentTraceSink implements AgentTraceSink {
  public constructor(private readonly filePath: string) {}

  async write(event: AgentTraceEvent): Promise<void> {
    validateTraceEvent(event);
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function validateTraceEvent(event: AgentTraceEvent): void {
  const baseKeys = ["schemaVersion", "runId", "workspaceId", "seq", "timestamp", "type"];
  const typeKeys: Record<AgentTraceEvent["type"], string[]> = {
    run_started: [],
    step_completed: ["stepNumber", "providerId", "modelId", "finishReason", "toolNames", "inputTokens", "outputTokens", "totalTokens", "stepTimeMs", "responseTimeMs"],
    run_completed: ["durationMs"],
    run_failed: ["failureCode", "durationMs"],
  };
  const allowedKeys = new Set([...baseKeys, ...typeKeys[event.type]]);

  if (!isPlainObject(event) || Object.keys(event).some((key) => !allowedKeys.has(key))) {
    throw new Error("Invalid agent trace event.");
  }
  if (event.schemaVersion !== "v1" || !isNonEmptyString(event.runId) || !isNonEmptyString(event.workspaceId)
    || !Number.isInteger(event.seq) || event.seq < 0 || !isIsoTimestamp(event.timestamp)) {
    throw new Error("Invalid agent trace event.");
  }

  switch (event.type) {
    case "run_started":
      return;
    case "step_completed":
      if (!Number.isInteger(event.stepNumber) || event.stepNumber < 0 || !isNonEmptyString(event.providerId)
        || !isNonEmptyString(event.modelId) || !isNonEmptyString(event.finishReason)
        || !Array.isArray(event.toolNames) || event.toolNames.some((name) => !isNonEmptyString(name))
        || new Set(event.toolNames).size !== event.toolNames.length
        || !isFiniteNumberOrNull(event.inputTokens) || !isFiniteNumberOrNull(event.outputTokens)
        || !isFiniteNumberOrNull(event.totalTokens) || !isOptionalFiniteNumber(event.stepTimeMs)
        || !isOptionalFiniteNumber(event.responseTimeMs)) {
        throw new Error("Invalid agent trace event.");
      }
      return;
    case "run_completed":
      if (!isOptionalFiniteNumber(event.durationMs)) throw new Error("Invalid agent trace event.");
      return;
    case "run_failed":
      if (event.failureCode !== "agent_run_failed" || !isOptionalFiniteNumber(event.durationMs)) {
        throw new Error("Invalid agent trace event.");
      }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
