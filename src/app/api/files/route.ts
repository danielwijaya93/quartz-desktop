import { resolveWorkspaceDir, searchWorkspaceFiles } from "@/lib/acp/workspace";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const cwd = resolveWorkspaceDir(searchParams.get("cwd"));
  const q = searchParams.get("q") ?? "";
  const dirsParam = searchParams.get("dirs");
  const additionalDirectories = dirsParam
    ? dirsParam
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
    : [];

  try {
    const files = await searchWorkspaceFiles({
      cwd,
      additionalDirectories,
      query: q,
      limit: 40,
    });
    return NextResponse.json({ cwd, files });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list files.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
