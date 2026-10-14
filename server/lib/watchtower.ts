/** Watchtower's address for links. */
export const WATCHTOWER_URL = (process.env.WATCHTOWER_URL ?? "https://leaf-rain.shrew-goblin.ts.net/watchtower/latest").replace(/\/+$/, "");

/** Watchtower's own port on this machine, which the sign-in gate in front of WATCHTOWER_URL doesn't guard. */
const WATCHTOWER_API_URL = (process.env.WATCHTOWER_API_URL ?? (process.env.WATCHTOWER_URL ? WATCHTOWER_URL : "http://127.0.0.1:10010/latest")).replace(/\/+$/, "");

/** Where this server calls an Action's Watchtower. */
export const apiBase = (base: string) => (base === WATCHTOWER_URL ? WATCHTOWER_API_URL : base);

/** The link that opens a session. */
export const sessionUrl = (base: string, id: string) => `${base}/?session=${encodeURIComponent(id)}`;
