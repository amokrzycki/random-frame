import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { build } from "esbuild";

// npm run build first; serve dist/ and open /performance.html?autorun.
const ref = process.argv.find((arg) => arg.startsWith("--ref="))?.slice(6);
await build({
  entryPoints: ["performance/browser.mjs"],
  bundle: true,
  format: "esm",
  outfile: "dist/performance.js",
  plugins: ref
    ? [
        {
          name: "baseline",
          setup(builder) {
            builder.onLoad({ filter: /\/src\/client\/.*\.ts$/ }, ({ path }) => ({
              contents: execFileSync("git", ["show", `${ref}:${relative(process.cwd(), path)}`], { encoding: "utf8" }),
              loader: "ts",
            }));
          },
        },
      ]
    : [],
});
const html = (await readFile("dist/index.html", "utf8")).replace('src="app.js"', 'src="performance.js"');
await writeFile("dist/performance.html", html);
