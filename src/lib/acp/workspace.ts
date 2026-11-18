import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "out",
  ".worktrees",
  ".venv",
  "__pycache__",
]);

export interface WorkspaceFileEntry {
  path: string;
  label: string;
  root: string;
}

/** Validates and resolves a workspace directory, falling back to `process.cwd()`. */
export function resolveWorkspaceDir(requested?: string | null): string {
  const candidate = requested?.trim() ? resolve(requested.trim()) : process.cwd();
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return candidate;
  }
  return process.cwd();
}

/** Validates a list of additional workspace directories, keeping existing directories only. */
export function resolveAdditionalDirs(dirs?: string[] | null): string[] {
  if (!Array.isArray(dirs)) return [];
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const abs = resolve(dir.trim());
    if (!seen.has(abs) && existsSync(abs) && statSync(abs).isDirectory()) {
      seen.add(abs);
      resolved.push(abs);
    }
  }
  return resolved;
}

/**
 * Resolves additional directories for `agy acp` sessions, automatically including
 * `~/.pi/agent/prompts` when present so the `prompt-template` skill can read saved templates.
 */
export function resolveAcpAdditionalDirs(
  dirs?: string[] | null,
  homeDir = homedir(),
): string[] {
  const base = resolveAdditionalDirs(dirs);
  const promptsDir = join(homeDir, ".pi", "agent", "prompts");
  if (!base.includes(promptsDir) && existsSync(promptsDir) && statSync(promptsDir).isDirectory()) {
    return [...base, promptsDir];
  }
  return base;
}

async function listDirFilesGit(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function listDirFilesWalk(root: string, maxFiles = 1500): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          queue.push(join(current, entry.name));
        }
      } else if (entry.isFile()) {
        results.push(relative(root, join(current, entry.name)));
      }
    }
  }

  return results;
}

/** Searches files across the primary `cwd` and optional `additionalDirectories`. */
export async function searchWorkspaceFiles(params: {
  cwd: string;
  additionalDirectories?: string[];
  query?: string;
  limit?: number;
}): Promise<WorkspaceFileEntry[]> {
  const primary = resolveWorkspaceDir(params.cwd);
  const extras = resolveAdditionalDirs(params.additionalDirectories).filter((d) => d !== primary);
  const roots = [primary, ...extras];
  const q = (params.query ?? "").trim().toLowerCase();
  const limit = params.limit ?? 40;

  const entries: WorkspaceFileEntry[] = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!;
    const relFiles = (await listDirFilesGit(root)) ?? (await listDirFilesWalk(root));
    for (const relPath of relFiles) {
      const label = i === 0 ? relPath : join(root, relPath);
      if (!q || label.toLowerCase().includes(q) || relPath.toLowerCase().includes(q)) {
        entries.push({
          path: join(root, relPath),
          label,
          root,
        });
        if (entries.length >= limit) return entries;
      }
    }
  }

  return entries;
}

/** Runs a direct `!command` shell command inside the workspace `cwd`. */
export async function executeWorkspaceShell(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ output: string; exitCode: number; durationMs: number }> {
  const startedAt = Date.now();
  const resolvedCwd = resolveWorkspaceDir(cwd);

  return new Promise((resolvePromise) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: resolvedCwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: string[] = [];
    let totalBytes = 0;
    const MAX_BYTES = 128 * 1024;
    let timedOut = false;

    const append = (buf: Buffer) => {
      if (totalBytes >= MAX_BYTES) return;
      const slice = buf.subarray(0, MAX_BYTES - totalBytes);
      totalBytes += slice.length;
      chunks.push(slice.toString("utf-8"));
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already exited
          }
        }, 1000);
      } else {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const output = chunks.join("") + (timedOut ? `\n[Timed out after ${timeoutMs}ms]` : "");
      resolvePromise({
        output,
        exitCode: code ?? (timedOut ? 124 : 1),
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        output: err.message,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
