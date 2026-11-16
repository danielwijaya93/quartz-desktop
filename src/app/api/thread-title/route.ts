import { generateThreadTitleViaAgy } from "@/lib/acp/thread-title";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    userMessage?: string;
    assistantPreview?: string;
    cwd?: string;
  };

  const userMessage = body.userMessage?.trim();
  if (!userMessage) {
    return NextResponse.json({ title: null }, { status: 400 });
  }

  const title = await generateThreadTitleViaAgy({
    userMessage,
    assistantPreview: body.assistantPreview,
    cwd: body.cwd,
  });

  return NextResponse.json({ title });
}
