import {
  buildSessionSnapshot,
  cancelAcpTurn,
  getExistingAcpSession,
  getOrCreateAcpSession,
  listHistoricalAcpSessions,
  loadHistoricalAcpSession,
  resetAcpSession,
  setAcpConfigOption,
} from "@/lib/acp/session-manager";
import type { AcpAgentId, AcpAppDataDir, AcpSessionMcpServer } from "@/lib/acp/types";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "list") {
    try {
      const cwd = searchParams.get("cwd") ?? undefined;
      const sessions = await listHistoricalAcpSessions(cwd);
      return NextResponse.json({ sessions });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list ACP sessions.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const threadId = searchParams.get("threadId")?.trim();
  if (!threadId) {
    return NextResponse.json({ error: "Missing threadId" }, { status: 400 });
  }
  const existing = getExistingAcpSession(threadId);
  if (!existing) {
    return NextResponse.json({ snapshot: null });
  }
  return NextResponse.json({ snapshot: buildSessionSnapshot(existing) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    threadId?: string;
    agent?: AcpAgentId;
    openuiEnabled?: boolean;
    acpSessionId?: string;
    appDataDir?: AcpAppDataDir;
    cwd?: string;
    additionalDirectories?: string[];
    mcpServers?: AcpSessionMcpServer[];
    mode?: string;
    model?: string;
    thoughtLevel?: string;
    configId?: string;
    value?: string;
  };

  const threadId = body.threadId?.trim();
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "init": {
        const entry = await getOrCreateAcpSession({
          threadId,
          agent: body.agent,
          openuiEnabled: body.openuiEnabled,
          acpSessionId: body.acpSessionId,
          appDataDir: body.appDataDir,
          cwd: body.cwd,
          additionalDirectories: body.additionalDirectories,
          mcpServers: body.mcpServers,
          mode: body.mode ?? "auto",
          model: body.model,
          thoughtLevel: body.thoughtLevel,
        });
        return NextResponse.json({ snapshot: buildSessionSnapshot(entry) });
      }

      case "setConfig": {
        if (!body.configId || body.value === undefined) {
          return NextResponse.json(
            { error: "configId and value are required" },
            { status: 400 },
          );
        }
        const snapshot = await setAcpConfigOption(threadId, body.configId, body.value);
        return NextResponse.json({ snapshot });
      }

      case "updateWorkspace":
      case "switchAgent": {
        const entry = await resetAcpSession({
          threadId,
          agent: body.agent,
          cwd: body.cwd,
          additionalDirectories: body.additionalDirectories,
          mcpServers: body.mcpServers,
          mode: body.mode ?? "auto",
          model: body.model,
          thoughtLevel: body.thoughtLevel,
        });
        return NextResponse.json({ snapshot: buildSessionSnapshot(entry) });
      }

      case "loadSession": {
        if (!body.acpSessionId) {
          return NextResponse.json({ error: "acpSessionId is required" }, { status: 400 });
        }
        const result = await loadHistoricalAcpSession({
          threadId,
          acpSessionId: body.acpSessionId,
          appDataDir: body.appDataDir,
          cwd: body.cwd,
          additionalDirectories: body.additionalDirectories,
          mcpServers: body.mcpServers,
        });
        return NextResponse.json(result);
      }

      case "cancel": {
        await cancelAcpTurn(threadId);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "ACP session operation failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
