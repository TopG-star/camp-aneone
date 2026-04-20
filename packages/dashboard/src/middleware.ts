export { auth as middleware } from "@/lib/auth";

export const config = {
  matcher: [
    // Protect all routes except auth endpoints, static files, and _next
    "/((?!api/auth|auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
