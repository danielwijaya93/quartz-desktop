import { resolveWorkspaceDir } from "@/lib/acp/workspace";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const TITLE_PROMPT_PREFIX = /^Generate a concise 3 to [56] word title/i;

export function isSyntheticTitleSession(title?: string | null): boolean {
  return Boolean(title && TITLE_PROMPT_PREFIX.test(title.trim()));
}

/** Extracts concise human-readable text for title generation while stripping OpenUI boilerplate. */
export function summarizeForTitlePrompt(raw: string, maxLength = 350): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^(?:root|[A-Za-z_]\w*)\s*=\s*[A-Z][A-Za-z0-9_]*\([\s\S]*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trimEnd()}...`;
}

/** Normalizes an LLM-generated title candidate into a crisp sidebar label. */
export function sanitizeThreadTitle(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;

  let cleaned = firstLine
    .replace(/^(?:title|chat title|summary)\s*:\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?:;]+$/, "")
    .trim();

  if (cleaned.length < 2) return null;
  if (cleaned.length > 60) {
    const truncated = cleaned.slice(0, 60);
    const lastSpace = truncated.lastIndexOf(" ");
    cleaned = (lastSpace > 24 ? truncated.slice(0, lastSpace) : truncated).trim();
  }
  return cleaned || null;
}

export function buildThreadTitlePrompt(userMessage: string, assistantPreview?: string): string {
  const userSummary = summarizeForTitlePrompt(userMessage, 400);
  const assistantSummary = assistantPreview ? summarizeForTitlePrompt(assistantPreview, 350) : "";

  return [
    "Generate a concise 3 to 6 word title for this chat thread.",
    "Reply with ONLY the title in plain text (no quotes, markdown, or trailing punctuation).",
    "",
    `User: ${userSummary || "General question"}`,
    ...(assistantSummary ? [`Assistant summary: ${assistantSummary}`] : []),
  ].join("\n");
}

/**
 * Generates a short title via `agy acp` using an isolated `--app-data-dir` store so
 * title requests never clutter the user's CLI or App conversation history.
 */
export async function generateThreadTitleViaAgy(params: {
  userMessage: string;
  assistantPreview?: string;
  cwd?: string;
}): Promise<string | null> {
  const userMessage = params.userMessage.trim();
  if (!userMessage) return null;

  const cwd = resolveWorkspaceDir(params.cwd);
  const prompt = buildThreadTitlePrompt(userMessage, params.assistantPreview);

  const child = spawn(
    "agy",
    ["acp", "--disable-telemetry", "--app-data-dir", "antigravity-gen-ui-titles"],
    {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let text = "";
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const connection = acp
    .client({ name: "antigravity-gen-ui-title" })
    .onRequest(acp.CLIENT_METHODS.session_request_permission, async () => ({
      outcome: { outcome: "cancelled" },
    }))
    .onRequest(acp.CLIENT_METHODS.elicitation_create, async () => ({
      action: "cancel",
    }))
    .onNotification(acp.CLIENT_METHODS.session_update, async ({ params: notif }) => {
      const u = notif.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
        text += u.content.text;
      }
    })
    .connect(stream);

  try {
    const run = async () => {
      await connection.agent.request(acp.AGENT_METHODS.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "antigravity-gen-ui-title", version: "0.1.0" },
      });
      const session = await connection.agent.request(acp.AGENT_METHODS.session_new, {
        cwd,
        mcpServers: [],
      });
      await connection.agent
        .request(acp.AGENT_METHODS.session_set_config_option, {
          sessionId: session.sessionId,
          configId: "model",
          value: "gemini-3.8-flash",
        })
        .catch(() => {});
      await connection.agent.request(acp.AGENT_METHODS.session_prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      return sanitizeThreadTitle(text);
    };

    const timed = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), 18_000);
    });

    return await Promise.race([run(), timed]);
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      connection.close();
    } catch {
      // ignore
    }
    try {
      if (!child.killed) child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

/**
 * Generates a short title via headless `quartz -p` (model/config from the
 * Quartz config). Used for Quartz-provider threads.
 */
export async function generateThreadTitleViaQuartz(params: {
  userMessage: string;
  assistantPreview?: string;
  cwd?: string;
}): Promise<string | null> {
  const userMessage = params.userMessage.trim();
  if (!userMessage) return null;
  const cwd = resolveWorkspaceDir(params.cwd);
  const prompt = buildThreadTitlePrompt(userMessage, params.assistantPreview);
  try {
    const { stdout } = await execFileAsync("quartz", ["-p", prompt, "--cwd", cwd], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return sanitizeThreadTitle(stdout);
  } catch {
    return null;
  }
}

/** Generates a thread title via the selected provider's backend. */
export async function generateThreadTitle(params: {
  provider?: string | null;
  userMessage: string;
  assistantPreview?: string;
  cwd?: string;
}): Promise<string | null> {
  if (params.provider === "quartz") {
    return generateThreadTitleViaQuartz(params);
  }
  return generateThreadTitleViaAgy(params);
}
