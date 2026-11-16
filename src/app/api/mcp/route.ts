import {
  addGlobalMcpServer,
  listGlobalMcpServers,
  removeGlobalMcpServer,
  toggleGlobalMcpServer,
} from "@/lib/acp/mcp-cli";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const servers = await listGlobalMcpServers();
    return NextResponse.json({ servers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list MCP servers.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: "add" | "remove" | "enable" | "disable";
    name?: string;
    type?: "stdio" | "http";
    commandOrUrl?: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    headers?: Array<{ name: string; value: string }>;
  };

  try {
    switch (body.action) {
      case "add": {
        if (!body.name || !body.commandOrUrl) {
          return NextResponse.json(
            { error: "name and commandOrUrl are required" },
            { status: 400 },
          );
        }
        await addGlobalMcpServer({
          name: body.name,
          type: body.type === "http" ? "http" : "stdio",
          commandOrUrl: body.commandOrUrl,
          args: body.args,
          env: body.env,
          headers: body.headers,
        });
        break;
      }
      case "enable": {
        if (!body.name) {
          return NextResponse.json({ error: "name is required" }, { status: 400 });
        }
        await toggleGlobalMcpServer(body.name, true);
        break;
      }
      case "disable": {
        if (!body.name) {
          return NextResponse.json({ error: "name is required" }, { status: 400 });
        }
        await toggleGlobalMcpServer(body.name, false);
        break;
      }
      case "remove": {
        if (!body.name) {
          return NextResponse.json({ error: "name is required" }, { status: 400 });
        }
        await removeGlobalMcpServer(body.name);
        break;
      }
      default:
        return NextResponse.json({ error: "Unsupported MCP action" }, { status: 400 });
    }

    const servers = await listGlobalMcpServers();
    return NextResponse.json({ servers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP command failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
