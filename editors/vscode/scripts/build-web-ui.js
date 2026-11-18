// Builds the Omnigent web app into dist/web-ui. A Databricks workspace serves
// only the Omnigent API, so the proxy serves this copy (src/proxy/localApp.ts).
// VITE_DATABRICKS_WORKSPACE makes it address host traffic to the replica that
// holds the host, as a workspace needs (isDatabricksWorkspace, web/src/lib/host.ts).
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const webDir = path.resolve(__dirname, "../../../web");
// Its own directory: --emptyOutDir must never clear dist/extension.js.
const outDir = path.resolve(__dirname, "../dist/web-ui");
const windows = process.platform === "win32";
const vite = path.join(webDir, "node_modules", ".bin", windows ? "vite.cmd" : "vite");

const env = { ...process.env, VITE_DATABRICKS_WORKSPACE: "true" };
// web/vite.config.ts reads these for its dev proxy and would look up a token.
delete env.OMNIGENT_URL;
delete env.OMNIGENT_AUTH_TOKEN;

const result = spawnSync(vite, ["build", "--outDir", outDir, "--emptyOutDir"], {
  cwd: webDir,
  env,
  stdio: "inherit",
  shell: windows,
});
if (result.error) {
  console.error(`[build-web-ui] couldn't run ${vite}: ${result.error.message}`);
  console.error("[build-web-ui] install the web app's dependencies: pnpm install --filter web");
  process.exit(1);
}
process.exit(result.status ?? 1);
