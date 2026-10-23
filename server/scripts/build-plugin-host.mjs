// Bundles the plugin host into todo/plugin_host.mjs, one file with the QuickJS
// wasm inlined, so the CLI can run plugins with nothing but Node.
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outfile = path.resolve(root, "../todo/plugin_host.mjs");

await build({
  entryPoints: [path.join(root, "lib/plugins/cli-entry.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  // Bundled CommonJS dependencies still call require for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "info",
});
