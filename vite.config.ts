/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import { appendFileSync, writeFileSync } from "node:fs";

// Dev-only perf sink: the running game POSTs its per-second benchmark line to /__perf and we append it to
// perf.log at the repo root — so performance can be READ from the file, no console/screen inspection needed.
// Truncated on each dev-server start so the file holds only the current session.
function perfLogSink(): Plugin {
  const file = resolve(__dirname, "perf.log");
  return {
    name: "perf-log-sink",
    configureServer(server) {
      try { writeFileSync(file, `# perf.log — session ${new Date().toISOString()}\n`); } catch { /* ignore */ }
      server.middlewares.use("/__perf", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          try { appendFileSync(file, body.endsWith("\n") ? body : body + "\n"); } catch { /* ignore */ }
          res.statusCode = 204; res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [perfLogSink()],
  server: { port: 5173, open: true },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        gpuDemo: resolve(__dirname, "gpu-demo.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
