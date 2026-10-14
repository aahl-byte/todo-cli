/** The path the app is served under ("" at the root), for URLs that Next's
 * Link, redirect and router don't prefix on their own. */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const withBase = (path: string) => BASE + path;

/** The installed app's name: the base path tells apart deployments that share
 * one origin. */
export const APP_NAME = BASE ? BASE.slice(1) : "todo";
