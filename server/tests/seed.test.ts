import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const seed = (dir: string) =>
  execFileSync("npx", ["tsx", "scripts/seed-demo.ts"], { env: { ...process.env, TODO_PGLITE: dir }, encoding: "utf8", stdio: "pipe" });

describe("seed:demo", () => {
  it("fills a fresh database with a team's worth of work and refuses to run twice", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seed-"));
    try {
      const out = JSON.parse(seed(dir).trim().split("\n").pop()!);
      expect(out.items).toBeGreaterThanOrEqual(60);
      expect(out.users).toBe(12);
      expect(() => seed(dir)).toThrow(/already has items/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
