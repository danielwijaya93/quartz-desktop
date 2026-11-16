import { resolveAcpPermission } from "@/lib/acp/session-manager";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    requestId?: string;
    optionId?: string | null;
    cancel?: boolean;
  };

  if (!body.requestId) {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }

  const resolved = resolveAcpPermission(
    body.requestId,
    body.cancel ? null : (body.optionId ?? null),
  );
  if (!resolved) {
    return NextResponse.json(
      { error: "Permission request not found or already resolved." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
