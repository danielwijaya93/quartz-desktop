import {
  addTrustedWorkspace,
  inspectDirectory,
  readTrustedWorkspaces,
} from "@/lib/acp/folders";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const requestedPath = searchParams.get("path");
  const trustedWorkspaces = readTrustedWorkspaces();

  if (requestedPath !== null) {
    const inspection = inspectDirectory(requestedPath);
    return NextResponse.json({
      trustedWorkspaces,
      defaultCwd: process.cwd(),
      inspection,
    });
  }

  return NextResponse.json({
    trustedWorkspaces,
    defaultCwd: process.cwd(),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    path?: string;
    trustInCli?: boolean;
  };

  const rawPath = body.path ?? "";

  try {
    if (body.action === "inspect") {
      const inspection = inspectDirectory(rawPath);
      return NextResponse.json({ inspection });
    }

    if (body.action === "add") {
      const inspection = inspectDirectory(rawPath);
      if (!inspection.valid) {
        return NextResponse.json(
          { error: inspection.error ?? "Invalid folder path.", inspection },
          { status: 400 },
        );
      }

      let inTrustedWorkspaces = inspection.inTrustedWorkspaces;
      let trustedWorkspaces = readTrustedWorkspaces();
      if (body.trustInCli && !inTrustedWorkspaces) {
        const updated = addTrustedWorkspace(inspection.resolvedPath);
        inTrustedWorkspaces = true;
        trustedWorkspaces = updated.trustedWorkspaces;
      }

      return NextResponse.json({
        folder: {
          cwd: inspection.resolvedPath,
          name: inspection.defaultName,
        },
        inTrustedWorkspaces,
        trustedWorkspaces,
      });
    }

    return NextResponse.json({ error: `Unsupported action: ${body.action ?? ""}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to inspect or add folder.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
