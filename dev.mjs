import { spawn } from "node:child_process";
import { context } from "esbuild";

const builds = await Promise.all([
  context({
    entryPoints: ["src/*.ts", "src/sources/*.ts"],
    platform: "node",
    format: "esm",
    sourcemap: true,
    outbase: "src",
    outdir: "dist",
  }),
  context({
    entryPoints: ["src/client/*.ts"],
    platform: "browser",
    format: "esm",
    sourcemap: true,
    outdir: "dist/client",
  }),
]);

await Promise.all(builds.map((build) => build.rebuild()));
await Promise.all(builds.map((build) => build.watch()));
const server = spawn(process.execPath, ["--watch", "--enable-source-maps", "dist/server.js"], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.kill();
    await Promise.all(builds.map((build) => build.dispose()));
    process.exit();
  });
}
