import type { NextConfig } from 'next';

/**
 * The app is the same package as the pipeline, on purpose: the query catalogue in
 * src/queries is the one thing every lane shares, and a monorepo boundary between
 * "the app" and "the benchmark" would immediately need a build step to cross.
 */
const nextConfig: NextConfig = {
  // Next.js writes its own AGENTS.md/CLAUDE.md at the repo root otherwise, which
  // would sit next to this project's documentation claiming to describe it.
  agentRules: false,

  // Native bindings cannot be bundled. @duckdb/node-api loads a .node binary and pg
  // resolves optional native modules at runtime; both have to stay external.
  serverExternalPackages: ['@duckdb/node-api', '@duckdb/node-bindings', 'pg'],

  async headers() {
    return [
      {
        // DuckDB-WASM uses SharedArrayBuffer for its threaded bundle, which browsers
        // only expose to cross-origin isolated pages. Without these two headers it
        // silently falls back to the single-threaded build.
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
    ];
  },
};

export default nextConfig;
