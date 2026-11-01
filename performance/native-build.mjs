// Build a disposable instrumented release app. Never edits production sources in this checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, transform } from "esbuild";

const root = process.cwd();
const destination = resolve(process.argv[2]);
const ref = process.argv.find((arg) => arg.startsWith("--ref="))?.slice(6);
const trace = process.argv.includes("--trace");
if (!destination.startsWith("/tmp/") || destination === "/tmp") throw Error("Use a fresh /tmp/ destination");
await mkdir(destination, { recursive: false });
execFileSync("bash", ["-c", 'git archive "$1" | tar -x -C "$2"', "native-build", ref ?? "HEAD", destination]);
if (!ref) {
  for (const directory of ["src", "src-tauri/src"])
    await cp(directory, `${destination}/${directory}`, { recursive: true });
  for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) await cp(file, `${destination}/${file}`);
}
const productionPatch = ref
  ? ""
  : execFileSync("git", ["diff", "HEAD", "--", "src", "src-tauri"], { encoding: "utf8" });
await writeFile(`${destination}/production.patch`, productionPatch);
await cp("performance", `${destination}/performance`, { recursive: true });
await symlink(`${root}/node_modules`, `${destination}/node_modules`);
// Reuse dependency artifacts; build the variants sequentially, then copy each executable.
await symlink(`${root}/src-tauri/target`, `${destination}/src-tauri/target`);
let rust = await readFile(`${destination}/src-tauri/src/lib.rs`, "utf8");
rust = rust.replace(
  "get_platform_capabilities,",
  "performance_config, performance_report,\n            get_platform_capabilities,",
);
rust += `\n#[tauri::command]\nfn performance_report(payload: serde_json::Value, app: tauri::AppHandle) -> Result<(), String> {
    std::fs::write(std::env::var("RF_RESULT").map_err(|e| e.to_string())?, serde_json::to_vec(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    app.exit(0); Ok(())
}\n`;
rust += `\n#[tauri::command]\nfn performance_config() -> serde_json::Value {
    serde_json::json!({"launch": std::env::var("RF_LAUNCH_MS").unwrap(), "longMs": std::env::var("RF_LONG_MS").unwrap_or_else(|_| "0".into()), "samples": std::env::var("RF_SAMPLES").unwrap_or_else(|_| "20".into())})
}\n`;
await writeFile(`${destination}/src-tauri/src/lib.rs`, rust);
const sourcePath = `${destination}/src-tauri/src/sources/prntsc.rs`;
let source = await readFile(sourcePath, "utf8");
source = source.replace(
  "let page_url = source_page_url.clone();",
  'let page_url = format!("{}/page/{id}", std::env::var("RF_FIXTURE_URL").expect("fixture URL"));',
);
source = source.replace(
  "let asset_url = item.media_url.clone();",
  'let asset_url = format!("{}/asset/{}", std::env::var("RF_FIXTURE_URL").expect("fixture URL"), item.id);',
);
await writeFile(sourcePath, source);
execFileSync("node", ["build.mjs"], { cwd: destination, stdio: "inherit" });
await writeFile(
  `${destination}/performance/native-entry.mjs`,
  'import "../src/client/app.ts";\nimport "./native-driver.mjs";',
);
await build({
  absWorkingDir: destination,
  entryPoints: ["performance/native-entry.mjs"],
  bundle: true,
  format: "esm",
  minify: true,
  loader: { ".md": "text" },
  outfile: `${destination}/dist/app.js`,
  sourcemap: true,
  plugins: [
    {
      name: "ipc-spans",
      setup(builder) {
        builder.onLoad({ filter: /\/node_modules\/@tauri-apps\/api\/core\.js$/ }, async ({ path }) => ({
          contents: (await readFile(path, "utf8")).replace(
            "return window.__TAURI_INTERNALS__.invoke(cmd, args, options);",
            "const start = performance.now(); try { return await window.__TAURI_INTERNALS__.invoke(cmd, args, options); } finally { globalThis.__rf.ipc.push({name:cmd,start,duration:performance.now()-start,phase:globalThis.__rf.phase}); }",
          ),
          loader: "js",
        }));
      },
    },
    ...(trace
      ? [
          {
            name: "profile-functions",
            setup(builder) {
              builder.onLoad({ filter: /\/src\/client\/.*\.ts$/ }, async ({ path }) => {
                const { code } = await transform(await readFile(path, "utf8"), { loader: "ts", format: "esm" });
                // esbuild emits top-level function closing braces in column zero. Only profile those
                // declarations; this is not a source parser. Async durations include waiting.
                const contents = code.replace(
                  /^((?:async )?function (\w+)\([^\n]*\) \{)\n([\s\S]*?)^\}/gm,
                  (_match, header, name, body) =>
                    /^(uncollectedItems|filteredSavedItems|navigationView|renderHistoryPage|gridEntries|renderSavedFilter|syncControls|applySavedLibrary|refreshPersistedView|persistThumbnails|trimThumbnails|decodedUrl|showFrame|setLightboxZoom|openHistory|goTo|loadTile|resolveCell|setState)$/.test(
                      name,
                    )
                      ? `${header}\nconst __rfStart=performance.now();try{\n${body}}finally{globalThis.__rfSpan(${JSON.stringify(`${path.split("/").at(-1)}:${name}`)},__rfStart);}\n}`
                      : _match,
                );
                return { contents, loader: "js" };
              });
            },
          },
        ]
      : []),
  ],
});
let html = await readFile(`${destination}/dist/index.html`, "utf8");
html = html.replace(
  '<script type="module" src="app.js"></script>',
  '<script src="native-probe.js"></script><script type="module" src="app.js"></script>',
);
if (!html.includes("native-probe.js")) throw Error("App script insertion failed");
await writeFile(`${destination}/dist/index.html`, html);
await cp("performance/native-probe.js", `${destination}/dist/native-probe.js`);
// Prevent unrelated update traffic in both variants; all app persistence/Sync capabilities remain.
const configPath = `${destination}/src-tauri/tauri.conf.json`;
const config = JSON.parse(await readFile(configPath, "utf8"));
config.plugins.updater.endpoints = ["http://127.0.0.1:9/disabled"];
config.plugins.updater.dangerousInsecureTransportProtocol = true;
await writeFile(configPath, JSON.stringify(config));
execFileSync("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml"], {
  cwd: destination,
  stdio: "inherit",
});
await cp(`${destination}/src-tauri/target/release/random-frame`, `${destination}/random-frame`);
const hash = execFileSync("git", ["rev-parse", ref ?? "HEAD"], { encoding: "utf8" }).trim();
await writeFile(
  `${destination}/build-info.json`,
  JSON.stringify(
    {
      baseline: hash,
      workingTree: !ref,
      trace,
      productionPatchSHA256: createHash("sha256").update(productionPatch).digest("hex"),
      sourceFiles: await readdir(`${destination}/dist`),
    },
    null,
    2,
  ),
);
process.stdout.write(`${destination}\n`);
