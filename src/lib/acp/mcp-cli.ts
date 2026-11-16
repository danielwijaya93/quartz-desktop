import type { GlobalMcpServerInfo } from "@/lib/acp/types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Parses `agy mcp list` tabular CLI output into structured entries. */
export function parseAgyMcpListOutput(stdout: string): GlobalMcpServerInfo[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];
  const rows: GlobalMcpServerInfo[] = [];

  for (const line of lines) {
    if (/^NAME\s+TYPE\s+STATUS/i.test(line) || /^No MCP servers/i.test(line)) {
      continue;
    }
    const match = /^(\S+)\s+(\S+)\s+(enabled|disabled)\s+(.+)$/i.exec(line);
    if (!match) continue;
    rows.push({
      name: match[1]!,
      type: match[2]!,
      status: match[3]!.toLowerCase(),
      target: match[4]!.trim(),
    });
  }

  return rows;
}

export async function listGlobalMcpServers(): Promise<GlobalMcpServerInfo[]> {
  const { stdout } = await execFileAsync("agy", ["mcp", "list"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return parseAgyMcpListOutput(stdout);
}

export async function addGlobalMcpServer(input: {
  name: string;
  type: "stdio" | "http";
  commandOrUrl: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  headers?: Array<{ name: string; value: string }>;
}): Promise<void> {
  const name = input.name.trim();
  if (!name || /\s/.test(name)) {
    throw new Error("MCP server name must be non-empty and contain no whitespace.");
  }

  const cliArgs: string[] = ["mcp", "add", "--type", input.type];
  for (const entry of input.env ?? []) {
    if (entry.name.trim()) {
      cliArgs.push("--env", `${entry.name.trim()}=${entry.value ?? ""}`);
    }
  }
  for (const header of input.headers ?? []) {
    if (header.name.trim()) {
      cliArgs.push("--header", `${header.name.trim()}: ${header.value ?? ""}`);
    }
  }

  cliArgs.push(name);
  if (input.type === "stdio") {
    cliArgs.push("--", input.commandOrUrl.trim(), ...(input.args ?? []));
  } else {
    cliArgs.push(input.commandOrUrl.trim());
  }

  await execFileAsync("agy", cliArgs, { timeout: 10_000 });
}

export async function toggleGlobalMcpServer(name: string, enabled: boolean): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Server name is required.");
  await execFileAsync("agy", ["mcp", enabled ? "enable" : "disable", trimmed], {
    timeout: 10_000,
  });
}

export async function removeGlobalMcpServer(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Server name is required.");
  await execFileAsync("agy", ["mcp", "remove", trimmed], { timeout: 10_000 });
}
