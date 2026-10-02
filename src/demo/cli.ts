import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";

import { createOpenRouterModel, readOpenRouterConfig } from "../agent/index.js";
import { demoUsage, parseDemoArgs, renderDemoResult, runDemo, type DemoRunResult } from "./demo.js";
import type { AgentTraceEvent } from "../agent/index.js";

async function main(): Promise<void> {
  try {
    const parsed = parseDemoArgs(process.argv.slice(2));
    if (parsed.help) {
      output.write(`${demoUsage()}\n`);
      return;
    }
    const options = await promptForMissingOptions(parsed.options, process.argv.slice(2).length === 0);
    const config = readOpenRouterConfig(process.env);
    output.write("Running agent... Use `npm run demo:watch` in another terminal for redacted live traces.\n");
    const result = await runDemo({
      ...options,
      model: createOpenRouterModel(config),
      modelLabel: config.model,
      onProgress: (event) => {
        output.write(`${formatDemoProgress(event)}\n`);
      },
    });
    output.write(`${renderDemoResult(result)}\n`);
  } catch (error) {
    output.write(`${formatDemoError(error)}\n`);
    process.exitCode = 1;
  }
}

async function promptForMissingOptions(defaults: { question: string; maximumWords: number }, interactive: boolean) {
  if (!interactive) return defaults;
  const readline = createInterface({ input, output });
  try {
    const question = (await readline.question(`Tender question [${defaults.question}] `)).trim() || defaults.question;
    const suppliedMaximumWords = (await readline.question(`Maximum words [${defaults.maximumWords}] `)).trim();
    if (!suppliedMaximumWords) return { question, maximumWords: defaults.maximumWords };
    const parsed = parseDemoArgs(["--question", question, "--max-words", suppliedMaximumWords]);
    if (parsed.help) return defaults;
    return parsed.options;
  } finally {
    readline.close();
  }
}

export function formatDemoProgress(event: AgentTraceEvent): string {
  if (event.type === "run_started") return "Demo run started.";
  if (event.type === "run_completed") return "Demo run completed.";
  if (event.type === "run_failed") return "Demo run failed.";
  return event.toolNames.length > 0
    ? `Step ${event.stepNumber}: ${event.toolNames.join(", ")}.`
    : `Step ${event.stepNumber}: final response.`;
}

/** Keeps CLI errors actionable without exposing provider bodies or runtime details. */
export function formatDemoError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (isArgumentError(message)) return `Demo argument error: ${message}`;
  if (message === "Missing OPENROUTER_API_KEY" || message === "Missing OPENROUTER_MODEL") {
    return `Demo configuration error: ${message}. Update ignored .env and try again.`;
  }
  return "Demo could not run. Check the provider/runtime configuration and try again.";
}

function isArgumentError(message: string): boolean {
  return message.includes("argument") || message.includes("value") || message.includes("Question") || message.includes("--max-words") || message.includes("--help");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
