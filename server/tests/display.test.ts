import { beforeEach, describe, expect, it } from "vitest";
import { addProject } from "@/lib/auth";
import { addDisplay, displayAllowed, removeDisplay } from "@/lib/display";
import { world, type World } from "./helpers";

const { GET: enroll } = await import("@/app/display/[key]/enroll/route");

let w: World;
beforeEach(async () => {
  w = await world();
  await addProject(w.d, "q");
});

const enrollWith = (project: string, key: string, proto = "https") =>
  enroll(new Request(`http://127.0.0.1/display/${project}/enroll?key=${key}`, { headers: { "x-forwarded-proto": proto } }),
         { params: Promise.resolve({ key: project }) });

describe("display keys", () => {
  it("open only their own project's display", async () => {
    const key = await addDisplay(w.d, "p", "tablet");
    expect(await displayAllowed(w.d, "p", key)).toBe(true);
    expect(await displayAllowed(w.d, "q", key)).toBe(false);
  });

  it("don't accept a user's sign-in token", async () => {
    expect(await displayAllowed(w.d, "p", w.tokens.alice)).toBe(false);
  });

  it("stop working when replaced or removed", async () => {
    const old = await addDisplay(w.d, "p", "tablet");
    const key = await addDisplay(w.d, "p", "tablet");
    expect(await displayAllowed(w.d, "p", old)).toBe(false);
    expect(await removeDisplay(w.d, "p", "tablet")).toBe(true);
    expect(await displayAllowed(w.d, "p", key)).toBe(false);
  });

  it("enroll sets a display-scoped cookie and drops the key from the URL", async () => {
    const key = await addDisplay(w.d, "p", "tablet");
    const res = await enrollWith("p", key);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/display/p");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^todo_display=${key}; Path=/display/; Max-Age=\\d+; HttpOnly; SameSite=Lax; Secure$`));
    expect((await enrollWith("p", key, "http")).headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("enroll refuses a key for another project", async () => {
    const key = await addDisplay(w.d, "q", "tablet");
    const res = await enrollWith("p", key);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
