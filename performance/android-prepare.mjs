import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd(),
  dest = resolve(process.argv[2] ?? ""),
  baseline = process.argv.includes("--baseline");
if (!dest.startsWith("/tmp/rf-native-android/")) throw Error("Use a fresh /tmp/rf-native-android/ destination");
await mkdir(dest, { recursive: false });
execFileSync(
  "bash",
  ["-c", 'git archive "$1" | tar -x -C "$2"', "prepare", "42091246d6a5d36b4a9b66d1bc22b04134c2e007", dest],
  { cwd: root },
);
if (!baseline) {
  for (const p of ["src", "src-tauri/src", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"])
    await cp(`${root}/${p}`, `${dest}/${p}`, { recursive: true });
}
await symlink(`${root}/node_modules`, `${dest}/node_modules`);
await cp(`${root}/performance`, `${dest}/performance`, { recursive: true });
let build = await readFile(`${root}/performance/native-build.mjs`, "utf8");
// Reuse the reviewed benchmark's frontend IPC span wrapper and workload. No Linux build.
const frontendStart = build.indexOf('execFileSync("node", ["build.mjs"]');
const frontendEnd = build.indexOf('execFileSync("cargo"');
if (frontendStart < 0 || frontendEnd <= frontendStart) throw Error("Native frontend build section changed");
build = build.slice(frontendStart, frontendEnd);
build = build.replaceAll(
  'await cp("performance/native-probe.js"',
  `await cp(${JSON.stringify(`${root}/performance/native-probe.js`)}`,
);
await writeFile(
  `${dest}/prepare-frontend.mjs`,
  `import {execFileSync} from 'node:child_process';import {readFile,writeFile,cp} from 'node:fs/promises';import {build,transform} from 'esbuild';const destination=${JSON.stringify(dest)},root=${JSON.stringify(root)},trace=false;\n${build}`,
);
let rust = await readFile(`${dest}/src-tauri/src/lib.rs`, "utf8");
rust = rust.replace(
  "get_platform_capabilities,",
  "performance_config, performance_report,\n            get_platform_capabilities,",
);
rust += `\n#[tauri::command]\nfn performance_report(payload: serde_json::Value, app: tauri::AppHandle) -> Result<(), String> { use tauri::Manager; std::fs::write(app.path().app_data_dir().map_err(|e|e.to_string())?.join("performance-result.json"),serde_json::to_vec(&payload).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?; Ok(()) }\n#[tauri::command]\nfn performance_config() -> serde_json::Value { serde_json::json!({"launch":"0","longMs":"0","samples":"8"}) }\n`;
await writeFile(`${dest}/src-tauri/src/lib.rs`, rust);
let path = `${dest}/src-tauri/src/sources/prntsc.rs`,
  source = await readFile(path, "utf8");
source = source
  .replace("let page_url = source_page_url.clone();", 'let page_url = format!("http://127.0.0.1:18787/page/{id}");')
  .replace(
    "let asset_url = item.media_url.clone();",
    'let asset_url = format!("http://127.0.0.1:18787/asset/{}", item.id);',
  );
await writeFile(path, source);
const config = JSON.parse(await readFile(`${dest}/src-tauri/tauri.conf.json`, "utf8"));
config.build.beforeBuildCommand = "";
await writeFile(`${dest}/src-tauri/tauri.conf.json`, JSON.stringify(config));
const patch = execFileSync("git", ["diff", "HEAD", "--", "src", "src-tauri"], { cwd: root, encoding: "utf8" });
await writeFile(
  `${dest}/build-info.json`,
  JSON.stringify(
    {
      baseline: "42091246d6a5d36b4a9b66d1bc22b04134c2e007",
      workingTree: !baseline,
      productionPatchSHA256: baseline ? null : createHash("sha256").update(patch).digest("hex"),
      instrumentation:
        "native driver IPC spans, constant config/report command, loopback prntsc fixture, updater disabled",
    },
    null,
    2,
  ),
);
execFileSync("node", ["prepare-frontend.mjs"], {
  cwd: dest,
  stdio: "inherit",
  env: { ...process.env, TAURI_ENV_PLATFORM: "android" },
});
