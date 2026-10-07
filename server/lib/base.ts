/** The path the app is served under ("" at the root), for URLs that Next's
 * Link, redirect and router don't prefix on their own. */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const withBase = (path: string) => BASE + path;
