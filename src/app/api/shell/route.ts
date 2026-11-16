import { executeWorkspaceShell, resolveWorkspaceDir } from "@/lib/acp/workspace";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    command?: string;
    cwd?: string;
  };
  const command = body.command?.trim();
  if (!command) {
    return NextResponse.json({ error: "command is required" }, { status: 400 });
  }
  const cwd = resolveWorkspaceDir(body.cwd);
  const result = await executeWorkspaceShell(command, cwd);
  return NextResponse.json({ ...result, cwd });
}
