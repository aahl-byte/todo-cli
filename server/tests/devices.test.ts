import { beforeEach, describe, expect, it } from "vitest";
import { GET as meGET } from "@/app/api/me/route";
import { POST as startPOST } from "@/app/api/login/start/route";
import { POST as pollPOST } from "@/app/api/login/poll/route";
import { apiTokens, approveLogin, denyLogin, MAX_PENDING_LOGINS, pendingLogin, revokeApiToken } from "@/lib/devices";
import { world, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await world();
});

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const start = async (label = "cli on laptop") => (await startPOST(post("/api/login/start", { label }))).json();
const poll = async (device_code: string) => {
  await w.d.query("update device_logins set last_poll = null");
  return (await pollPOST(post("/api/login/poll", { device_code }))).json();
};
const whoami = async (token: string) =>
  meGET(new Request("http://x/api/me", { headers: { authorization: `Bearer ${token}` } }));

describe("browser login for the CLI", () => {
  it("waits for approval, then hands the approver's token over once", async () => {
    const { device_code, user_code } = await start();
    expect(user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await poll(device_code)).toEqual({ status: "pending" });

    expect(await approveLogin(w.d, user_code, "alice")).toBe(true);
    const done = await poll(device_code);
    expect(done).toMatchObject({ status: "approved", handle: "alice" });
    expect(await (await whoami(done.token)).json()).toEqual({ handle: "alice", name: null });

    expect(await poll(device_code)).toEqual({ status: "expired" });
  });

  it("does not store the token it hands over", async () => {
    const { device_code, user_code } = await start();
    await approveLogin(w.d, user_code, "alice");
    const { token } = await poll(device_code);
    const stored = JSON.stringify(await w.d.query("select * from api_tokens"))
      + JSON.stringify(await w.d.query("select * from device_logins"));
    expect(stored).not.toContain(token);
  });

  it("gives each approval its own token and leaves the user's own token working", async () => {
    const a = await start("laptop"), b = await start("desktop");
    await approveLogin(w.d, a.user_code, "alice");
    await approveLogin(w.d, b.user_code, "alice");
    const [ta, tb] = [(await poll(a.device_code)).token, (await poll(b.device_code)).token];
    expect(ta).not.toBe(tb);
    expect((await whoami(ta)).status).toBe(200);
    expect((await whoami(w.tokens.alice)).status).toBe(200);
    expect((await apiTokens(w.d, "alice")).map((t) => t.label).sort()).toEqual(["desktop", "laptop"]);
  });

  it("signs out a revoked device and only for its owner", async () => {
    const { device_code, user_code } = await start();
    await approveLogin(w.d, user_code, "alice");
    const { token } = await poll(device_code);
    const [{ id }] = await apiTokens(w.d, "alice");
    expect(await revokeApiToken(w.d, "bob", id)).toBe(false);
    expect((await whoami(token)).status).toBe(200);
    expect(await revokeApiToken(w.d, "alice", id)).toBe(true);
    expect((await whoami(token)).status).toBe(401);
  });

  it("refuses a code twice, an unknown code, and a denied or expired request", async () => {
    const a = await start();
    expect(await approveLogin(w.d, a.user_code, "alice")).toBe(true);
    expect(await approveLogin(w.d, a.user_code, "bob")).toBe(false);
    expect(await approveLogin(w.d, "ZZZZ-ZZZZ", "alice")).toBe(false);

    const b = await start();
    await denyLogin(w.d, b.user_code);
    expect(await poll(b.device_code)).toEqual({ status: "expired" });

    const c = await start();
    await w.d.query("update device_logins set expires = now() - interval '1 second' where user_code = $1", [c.user_code]);
    expect(await approveLogin(w.d, c.user_code, "alice")).toBe(false);
    expect(await pendingLogin(w.d, c.user_code)).toBeNull();
    expect(await poll(c.device_code)).toEqual({ status: "expired" });
  });

  it("matches a code however it is typed", async () => {
    const { user_code } = await start();
    expect(await pendingLogin(w.d, user_code.toLowerCase().replace("-", " "))).toMatchObject({ user_code });
  });

  it("tells a CLI polling too fast to slow down", async () => {
    const { device_code } = await start();
    expect(await poll(device_code)).toEqual({ status: "pending" });
    const again = await (await pollPOST(post("/api/login/poll", { device_code }))).json();
    expect(again).toEqual({ status: "slow_down" });
  });

  it("caps the requests waiting at once", async () => {
    for (let i = 0; i < MAX_PENDING_LOGINS; i++) expect((await startPOST(post("/api/login/start", {}))).status).toBe(200);
    expect((await startPOST(post("/api/login/start", {}))).status).toBe(429);
  });

  it("cleans the label a CLI sends", async () => {
    const { user_code } = await start("evil\nhost " + "x".repeat(200));
    const row = await pendingLogin(w.d, user_code);
    expect(row!.label).not.toMatch(/\n/);
    expect(row!.label.length).toBeLessThanOrEqual(80);
  });
});
