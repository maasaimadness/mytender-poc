import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createOpenRouterModel, readOpenRouterConfig } from "../agent/index.js";
import { demoUsage, parseDemoArgs, renderDemoResult, runDemo } from "./demo.js";

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
    const result = await runDemo({ ...options, model: createOpenRouterModel(config), modelLabel: config.model });
    output.write(`${renderDemoResult(result)}\n`);
  } catch (error) {
    if (error instanceof Error && isArgumentError(error.message)) output.write(`Demo argument error: ${error.message}\n`);
    else output.write("Demo could not run. Check local configuration and try again.\n");
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

function isArgumentError(message: string): boolean {
  return message.includes("argument") || message.includes("value") || message.includes("Question") || message.includes("--max-words") || message.includes("--help");
}

void main();
