import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type SidecarKind = "trace" | "memory";

export interface WatchArgs {
  latest: boolean;
  help: boolean;
}

export interface RunDirectory {
  path: string;
  modified: number;
}

interface TailState {
  offset: number;
  remainder: Buffer;
  identity?: string;
}

const emptyTail = (): TailState => ({ offset: 0, remainder: Buffer.alloc(0) });

export function parseWatchArgs(args: readonly string[]): WatchArgs {
  if (args.length === 0) return { latest: false, help: false };
  if (args.length === 1 && args[0] === "--latest") return { latest: true, help: false };
  if (args.length === 1 && args[0] === "--help") return { latest: false, help: true };
  throw new Error("Unknown watcher argument. Use --help for supported options.");
}

export const watchUsage = (): string => "Usage: npm run demo:watch -- [--latest]";

/** Chooses newest eligible directory; normal mode excludes the startup snapshot. */
export function selectRunDirectory(runs: readonly RunDirectory[], startupPaths: ReadonlySet<string>, latest: boolean): string | undefined {
  const eligible = latest ? runs : runs.filter((run) => !startupPaths.has(run.path));
  return [...eligible].sort((left, right) => right.modified - left.modified || right.path.localeCompare(left.path))[0]?.path;
}

/** Formats only allow-listed trace metadata; source text and unknown fields never reach the terminal. */
export function formatTraceEvent(value: unknown): string | undefined {
  if (!isRecord(value) || !safeToken(value.type) || !safeToken(value.runId)) return undefined;
  const common = `trace ${value.type} run=${display(value.runId)}`;
  if (value.type === "run_started") return common;
  if (value.type === "run_completed") return `${common}${optionalNumber(" durationMs", value.durationMs)}`;
  if (value.type === "run_failed" && value.failureCode === "agent_run_failed") {
    return `${common} failure=${value.failureCode}${optionalNumber(" durationMs", value.durationMs)}`;
  }
  if (value.type !== "step_completed" || !integer(value.stepNumber) || !safeToken(value.providerId) || !safeToken(value.modelId)
    || !safeToken(value.finishReason) || !stringArray(value.toolNames)) return undefined;
  return [
    `${common} step=${value.stepNumber} model=${display(value.providerId)}/${display(value.modelId)} finish=${display(value.finishReason)}`,
    `tools=${value.toolNames.map(display).join(",") || "none"}`,
    `tokens=${numberOrDash(value.inputTokens)}/${numberOrDash(value.outputTokens)}/${numberOrDash(value.totalTokens)}`,
    optionalNumber(" stepMs", value.stepTimeMs).trim(),
    optionalNumber(" responseMs", value.responseTimeMs).trim(),
  ].filter(Boolean).join(" ");
}

/** Formats only the strict run-memory allow-list. */
export function formatMemoryRecord(value: unknown): string | undefined {
  if (!isRecord(value) || !safeToken(value.source) || !safeToken(value.outcome) || !safeToken(value.nextActionCode)
    || !stringArray(value.failedChecks) || !stringArray(value.warningCodes) || !stringArray(value.missingRequirementIds)
    || !stringArray(value.retrievedBlockIds) || !Array.isArray(value.claimStatuses)) return undefined;
  const claims = value.claimStatuses.map((claim) => isRecord(claim) && safeToken(claim.id) && safeToken(claim.status)
    ? `${display(claim.id)}:${display(claim.status)}` : undefined);
  if (claims.some((claim) => claim === undefined)) return undefined;
  const failure = value.failureCode === undefined ? "" : safeToken(value.failureCode) ? ` failure=${display(value.failureCode)}` : "";
  return [
    `memory source=${display(value.source)} outcome=${display(value.outcome)}${failure}`,
    `checks=${value.failedChecks.map(display).join(",") || "none"}`,
    `warnings=${value.warningCodes.map(display).join(",") || "none"}`,
    `missing=${value.missingRequirementIds.map(display).join(",") || "none"}`,
    `claims=${claims.join(",") || "none"}`,
    `retrieved=${value.retrievedBlockIds.map(display).join(",") || "none"}`,
    `next=${display(value.nextActionCode)}`,
  ].join(" ");
}

/** Consumes complete UTF-8 JSONL records while retaining an unfinished final line. */
export function formatJsonlChunk(kind: SidecarKind, remainder: Buffer, chunk: Buffer): { lines: string[]; remainder: Buffer } {
  const combined = Buffer.concat([remainder, chunk]);
  const finalNewline = combined.lastIndexOf(0x0a);
  if (finalNewline === -1) return { lines: [], remainder: combined };
  const complete = combined.subarray(0, finalNewline).toString("utf8");
  const lines: string[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      const formatted = kind === "trace" ? formatTraceEvent(JSON.parse(line)) : formatMemoryRecord(JSON.parse(line));
      lines.push(formatted ?? "Warning: ignored malformed sidecar event.");
    } catch {
      lines.push("Warning: ignored malformed sidecar event.");
    }
  }
  return { lines, remainder: combined.subarray(finalNewline + 1) };
}

async function runDirectories(root: string, warned: Set<string>): Promise<RunDirectory[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates: RunDirectory[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      try {
        candidates.push({ path, modified: (await stat(path)).mtimeMs });
      } catch (error) {
        warnUnreadable(error, `${path}:stat`, warned);
      }
    }
    return candidates;
  } catch (error) {
    warnUnreadable(error, `${root}:readdir`, warned);
    return [];
  }
}

async function tailSidecar(path: string, kind: SidecarKind, state: TailState, warned: Set<string>): Promise<{ state: TailState; lines: string[] }> {
  try {
    const info = await stat(path);
    const identity = `${info.ino}:${info.birthtimeMs}`;
    const reset = state.identity !== undefined && (state.identity !== identity || info.size < state.offset);
    const contents = await readFile(path);
    const offset = reset ? 0 : state.offset;
    const formatted = formatJsonlChunk(kind, reset ? Buffer.alloc(0) : state.remainder, contents.subarray(offset));
    return { state: { offset: contents.length, remainder: formatted.remainder, identity }, lines: formatted.lines };
  } catch (error) {
    warnUnreadable(error, `${path}:state`, warned);
    return { state, lines: [] };
  }
}

function warnUnreadable(error: unknown, key: string, warned: Set<string>): void {
  if (isNotFound(error) || warned.has(key)) return;
  warned.add(key);
  process.stdout.write("Warning: unable to read demo sidecar state.\n");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function main(): Promise<void> {
  let args: WatchArgs;
  try {
    args = parseWatchArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`Demo watch argument error: ${error instanceof Error ? error.message : "Unknown watcher argument."}\n${watchUsage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    process.stdout.write(`${watchUsage()}\n`);
    return;
  }
  const root = resolve("tmp/demo");
  const warned = new Set<string>();
  const startupPaths = new Set((await runDirectories(root, warned)).map((run) => run.path));
  let current: string | undefined;
  let trace = emptyTail();
  let memory = emptyTail();
  let stopped = false;
  process.once("SIGINT", () => { stopped = true; });
  let announcedWaiting = false;
  while (!stopped) {
    const newest = selectRunDirectory(await runDirectories(root, warned), startupPaths, args.latest);
    if (!newest) {
      if (!announcedWaiting) process.stdout.write("Waiting for a demo run...\n");
      announcedWaiting = true;
    } else {
      announcedWaiting = false;
      if (newest !== current) {
        current = newest;
        trace = emptyTail();
        memory = emptyTail();
        process.stdout.write(`Watching demo run: ${newest}\n`);
      }
      const traced = await tailSidecar(join(newest, "trace.jsonl"), "trace", trace, warned);
      trace = traced.state;
      const remembered = await tailSidecar(join(newest, "memory.jsonl"), "memory", memory, warned);
      memory = remembered.state;
      for (const line of [...traced.lines, ...remembered.lines]) process.stdout.write(`${line}\n`);
    }
    await new Promise<void>((done) => setTimeout(done, 300));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,100}$/u.test(value);
}

function display(value: string): string {
  return safeToken(value) ? value : "redacted";
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function numberOrDash(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : value === null ? "-" : "-";
}

function optionalNumber(name: string, value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${name}=${Math.round(value)}` : "";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(safeToken);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
