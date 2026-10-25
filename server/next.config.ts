import type { NextConfig } from "next";

const basePath = process.env.NEXT_BASE_PATH || "";

const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Code plugins run in a worker loaded from lib/plugins/code-worker.mjs on disk, so it and the
  // QuickJS packages it imports ship as files beside the bundle rather than inside it.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "quickjs-emscripten-core", "@jitl/quickjs-singlefile-mjs-release-asyncify"],
  outputFileTracingIncludes: {
    "/**": ["./lib/plugins/code-worker.mjs", "./lib/plugins/sandbox.mjs", "./node_modules/quickjs-emscripten-core/**",
            "./node_modules/@jitl/**"],
  },
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // The CLI's sync API stays at the root, whatever path the dashboard is under:
  // Next only rewrites outside the basePath to a full URL, so it proxies to itself.
  rewrites: async () => basePath
    ? [{ source: "/api/:path*", destination: `http://127.0.0.1:${process.env.PORT || 3000}${basePath}/api/:path*`, basePath: false }]
    : [],
};

export default config;
