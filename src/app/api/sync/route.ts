import {
  getSyncedMessages,
  getSyncedState,
  mergeSyncedState,
  saveSyncedMessages,
  updateSyncedWorkspaceState,
  upsertSyncedThread,
  type SyncedThread,
} from "@/lib/acp/sync-store";
import type { AcpAppDataDir, WorkspaceFolder } from "@/lib/acp/types";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const threadId = searchParams.get("threadId")?.trim();

  if (threadId) {
    try {
      const messages = getSyncedMessages(threadId);
      return NextResponse.json({ threadId, messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid threadId.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  return NextResponse.json({ state: getSyncedState() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    clientId?: string;
    threadId?: string;
    thread?: SyncedThread;
    messages?: unknown[];
    patch?: {
      folders?: WorkspaceFolder[];
      activeFolderId?: string | null;
      threadFolders?: Record<string, string>;
      hiddenThreadIds?: string[];
      acpSessionIds?: Record<string, string>;
      appDataDirs?: Record<string, AcpAppDataDir>;
    };
    incoming?: {
      threads?: SyncedThread[];
      folders?: WorkspaceFolder[];
      activeFolderId?: string | null;
      threadFolders?: Record<string, string>;
      hiddenThreadIds?: string[];
      acpSessionIds?: Record<string, string>;
      appDataDirs?: Record<string, AcpAppDataDir>;
      messagesByThread?: Record<string, unknown[]>;
    };
  };

  const clientId = body.clientId;

  try {
    switch (body.action) {
      case "merge": {
        const state = await mergeSyncedState(body.incoming ?? {}, { clientId });
        return NextResponse.json({ state });
      }
      case "upsertThread": {
        if (!body.thread?.id) {
          return NextResponse.json({ error: "thread.id is required." }, { status: 400 });
        }
        const state = await upsertSyncedThread(body.thread, { clientId });
        return NextResponse.json({ state });
      }
      case "saveMessages": {
        if (!body.threadId || !Array.isArray(body.messages)) {
          return NextResponse.json(
            { error: "threadId and messages array are required." },
            { status: 400 },
          );
        }
        const state = await saveSyncedMessages(body.threadId, body.messages, { clientId });
        return NextResponse.json({ state });
      }
      case "updateWorkspaceState": {
        const state = await updateSyncedWorkspaceState(body.patch ?? {}, { clientId });
        return NextResponse.json({ state });
      }
      default:
        return NextResponse.json({ error: `Unknown sync action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync operation failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
