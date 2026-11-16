import {
  addTrustedWorkspace,
  inspectDirectory,
  normalizeDirectoryPath,
  readTrustedWorkspaces,
} from "@/lib/acp/folders";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-folders-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("folders helper", () => {
  it("expands tilde and normalizes trailing slashes", () => {
    expect(normalizeDirectoryPath("~/projects/demo/", "/home/tester")).toBe(
      "/home/tester/projects/demo",
    );
    expect(normalizeDirectoryPath("~/", "/home/tester")).toBe("/home/tester");
  });

  it("inspects existing vs missing paths and checks trustedWorkspaces", () => {
    const root = createTempDir();
    const projA = join(root, "proj-a");
    const projB = join(root, "proj-b");
    mkdirSync(projA);
    mkdirSync(projB);

    const settingsPath = join(root, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ allowNonWorkspaceAccess: true, trustedWorkspaces: [projA] }),
    );

    expect(inspectDirectory(projA, { settingsPath, homeDir: root })).toMatchObject({
      valid: true,
      inTrustedWorkspaces: true,
      defaultName: "proj-a",
    });

    expect(inspectDirectory(projB, { settingsPath, homeDir: root })).toMatchObject({
      valid: true,
      inTrustedWorkspaces: false,
      defaultName: "proj-b",
    });

    expect(inspectDirectory(join(root, "does-not-exist"), { settingsPath, homeDir: root })).toMatchObject({
      valid: false,
      exists: false,
    });
  });

  it("adds trustedWorkspaces atomically while preserving existing settings keys", () => {
    const root = createTempDir();
    const proj = join(root, "new-workspace");
    mkdirSync(proj);

    const settingsPath = join(root, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ allowNonWorkspaceAccess: true, model: "Gemini 4 Argon", trustedWorkspaces: [] }),
    );

    const first = addTrustedWorkspace(proj, { settingsPath, homeDir: root });
    expect(first.added).toBe(true);
    expect(first.trustedWorkspaces).toEqual([proj]);

    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(raw.allowNonWorkspaceAccess).toBe(true);
    expect(raw.model).toBe("Gemini 4 Argon");
    expect(readTrustedWorkspaces(settingsPath)).toEqual([proj]);

    // Adding duplicate path is a no-op
    const second = addTrustedWorkspace(proj, { settingsPath, homeDir: root });
    expect(second.added).toBe(false);
  });
});
