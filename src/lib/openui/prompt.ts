import {
  generateSystemPrompt,
  type LibrarySpec,
  type SystemPromptOptions,
} from "@openuidev/lang-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let cachedPrompt: string | null = null;

/**
 * Generates and caches the full OpenUI Lang system prompt from the compiled
 * `src/generated/spec.json` produced by `npm run generate`.
 */
export function getOpenUISystemPrompt(): string {
  if (cachedPrompt) return cachedPrompt;

  const specPath = join(process.cwd(), "src/generated/spec.json");
  const raw = JSON.parse(readFileSync(specPath, "utf-8")) as LibrarySpec & {
    promptOptions?: SystemPromptOptions;
  };

  const { promptOptions, ...library } = raw;
  cachedPrompt = generateSystemPrompt({
    library,
    promptOptions,
  });

  return cachedPrompt;
}
