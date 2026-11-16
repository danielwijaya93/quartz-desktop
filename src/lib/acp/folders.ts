import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface DirectoryInspection {
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  resolvedPath: string;
  defaultName: string;
  inTrustedWorkspaces: boolean;
  error?: string;
}

export function getAgySettingsPath(homeDir = homedir()): string {
  return join(homeDir, ".gemini", "antigravity-cli", "settings.json");
}

export function normalizeDirectoryPath(rawPath: string, homeDir = homedir()): string {
  const trimmed = rawPath.trim();
  const expanded =
    trimmed === "~"
      ? homeDir
      : trimmed.startsWith("~/")
        ? join(homeDir, trimmed.slice(2))
        : trimmed;
  if (!expanded) return "";
  const abs = resolve(expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
}

/** Reads ONLY the `trustedWorkspaces` array from Antigravity CLI settings. */
export function readTrustedWorkspaces(settingsPath = getAgySettingsPath()): string[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { trustedWorkspaces?: unknown };
    if (!Array.isArray(parsed.trustedWorkspaces)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of parsed.trustedWorkspaces) {
      if (typeof item !== "string" || !item.trim()) continue;
      const normalized = normalizeDirectoryPath(item);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** Validates an existing directory path without creating or deleting anything on disk. */
export function inspectDirectory(
  rawPath: string,
  options?: { settingsPath?: string; homeDir?: string },
): DirectoryInspection {
  const homeDir = options?.homeDir ?? homedir();
  const settingsPath = options?.settingsPath ?? getAgySettingsPath(homeDir);
  const resolvedPath = normalizeDirectoryPath(rawPath, homeDir);

  if (!resolvedPath) {
    return {
      valid: false,
      exists: false,
      isDirectory: false,
      resolvedPath: "",
      defaultName: "",
      inTrustedWorkspaces: false,
      error: "Please enter a directory path.",
    };
  }

  let exists = false;
  let isDirectory = false;
  try {
    exists = existsSync(resolvedPath);
    isDirectory = exists ? statSync(resolvedPath).isDirectory() : false;
  } catch {
    exists = false;
    isDirectory = false;
  }

  const trusted = readTrustedWorkspaces(settingsPath);
  const inTrustedWorkspaces = trusted.includes(resolvedPath);

  if (!exists) {
    return {
      valid: false,
      exists: false,
      isDirectory: false,
      resolvedPath,
      defaultName: basename(resolvedPath) || resolvedPath,
      inTrustedWorkspaces,
      error: `Directory not found: ${resolvedPath}`,
    };
  }

  if (!isDirectory) {
    return {
      valid: false,
      exists: true,
      isDirectory: false,
      resolvedPath,
      defaultName: basename(resolvedPath) || resolvedPath,
      inTrustedWorkspaces,
      error: `Path is not a directory: ${resolvedPath}`,
    };
  }

  return {
    valid: true,
    exists: true,
    isDirectory: true,
    resolvedPath,
    defaultName: basename(resolvedPath) || resolvedPath,
    inTrustedWorkspaces,
  };
}

/** Atomically appends a validated directory to Antigravity CLI `trustedWorkspaces`. */
export function addTrustedWorkspace(
  rawPath: string,
  options?: { settingsPath?: string; homeDir?: string },
): { resolvedPath: string; trustedWorkspaces: string[]; added: boolean } {
  const homeDir = options?.homeDir ?? homedir();
  const settingsPath = options?.settingsPath ?? getAgySettingsPath(homeDir);
  const check = inspectDirectory(rawPath, { settingsPath, homeDir });

  if (!check.valid) {
    throw new Error(check.error ?? "Invalid directory path.");
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Unexpected Antigravity CLI settings.json format.");
    }
    settings = parsed as Record<string, unknown>;
  }

  const existing = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];

  const normalizedSet = new Set(existing.map((d) => normalizeDirectoryPath(d, homeDir)));
  const alreadyTrusted = normalizedSet.has(check.resolvedPath);
  const nextTrusted = alreadyTrusted ? existing : [...existing, check.resolvedPath];

  if (!alreadyTrusted) {
    const nextSettings = {
      ...settings,
      trustedWorkspaces: nextTrusted,
    };
    const parent = dirname(settingsPath);
    mkdirSync(parent, { recursive: true });
    const tmpPath = join(parent, `.settings.json.tmp-${process.pid}-${Date.now()}`);
    writeFileSync(tmpPath, `${JSON.stringify(nextSettings, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tmpPath, settingsPath);
  }

  return {
    resolvedPath: check.resolvedPath,
    trustedWorkspaces: readTrustedWorkspaces(settingsPath),
    added: !alreadyTrusted,
  };
}
