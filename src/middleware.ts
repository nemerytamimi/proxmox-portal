import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Coarse gate only: bounce anonymous requests away from the app shell so they
 * land on /login instead of a flash of empty page. Real authorization —
 * ownership of a guest, admin-only actions — is enforced in the server actions
 * and route handlers, which is where it has to be anyway.
 */

const PUBLIC_PATHS = ["/login", "/register"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Auth.js v5 sets one of these depending on whether the origin is https.
  const hasSession =
    req.cookies.has("authjs.session-token") ||
    req.cookies.has("__Secure-authjs.session-token");

  if (!hasSession) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals, the auth endpoints and static files.
    "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
