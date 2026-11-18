import { NextResponse, type NextRequest } from "next/server";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Protects `/api/*` routes against cross-site request forgery (CSRF) and optional
 * bearer-token auth (`GENUI_API_TOKEN`) without breaking localhost, LAN, or Tailscale access.
 */
export function proxy(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return NextResponse.json({ error: "Cross-site API requests are forbidden." }, { status: 403 });
  }

  if (MUTATING_METHODS.has(request.method)) {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return NextResponse.json({ error: "Origin mismatch." }, { status: 403 });
        }
      } catch {
        return NextResponse.json({ error: "Invalid Origin header." }, { status: 403 });
      }
    }
  }

  const requiredToken = process.env.GENUI_API_TOKEN?.trim();
  if (requiredToken) {
    const authHeader = request.headers.get("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const headerToken = request.headers.get("x-genui-token")?.trim();
    if (bearer !== requiredToken && headerToken !== requiredToken) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
