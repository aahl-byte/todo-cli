import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { workerFile, workerPath } from "@/lib/plugins/code-runner";

describe("the code worker's file", () => {
  it("is handed to Worker as a path, whatever URL class built its address", () => {
    class OtherUrl { constructor(private readonly href: string) {} toString() { return this.href; } }
    expect(workerPath(new OtherUrl("file:///srv/app/server/assets/code-worker.mjs") as unknown as URL)).toBe("/srv/app/server/assets/code-worker.mjs");
    expect(workerPath(new URL("file:///srv/a%20b/w.mjs"))).toBe("/srv/a b/w.mjs");
  });

  it("is the one beside the module when it's there, else the server's lib/plugins, as in a bundled server", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worker-"));
    const beside = path.join(root, "chunks"), plugins = path.join(root, "lib", "plugins");
    mkdirSync(beside, { recursive: true });
    mkdirSync(plugins, { recursive: true });
    writeFileSync(path.join(plugins, "code-worker.bundle.mjs"), "");
    expect(workerFile(pathToFileURL(path.join(beside, "code-worker.bundle.mjs")).href, root)).toBe(path.join(plugins, "code-worker.bundle.mjs"));
    expect(workerFile("/_next/static/media/code-worker.bundle.mjs", root)).toBe(path.join(plugins, "code-worker.bundle.mjs"));
    expect(workerFile("", root)).toBe(path.join(plugins, "code-worker.bundle.mjs"));
    writeFileSync(path.join(beside, "code-worker.bundle.mjs"), "");
    expect(workerFile(pathToFileURL(path.join(beside, "code-worker.bundle.mjs")).href, root)).toBe(path.join(beside, "code-worker.bundle.mjs"));
  });
});
