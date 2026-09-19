import { watch as watchFile } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const { version } = JSON.parse(await readFile("package.json", "utf8"));

async function copyHtml() {
  await mkdir("dist", { recursive: true });
  await Promise.all(
    ["index.html", "privacy.html"].map(async (name) => {
      const html = (await readFile(name, "utf8"))
        .replace("{{VERSION}}", version)
        .replace("{{STYLES_CSS}}", "styles.css")
        .replace("{{THEME_JS}}", "theme.js")
        .replace("{{APP_JS}}", "app.js");
      await writeFile(`dist/${name}`, html);
    }),
  );
  await writeFile(
    "dist/random-frame.desktop",
    `[Desktop Entry]\nCategories=\nComment=Random public images, one frame at a time\nExec=random-frame\nStartupWMClass=random-frame\nIcon=random-frame\nName=Random Frame\nTerminal=false\nType=Application\nX-AppImage-Version=${version}\n`,
  );
  await cp("assets", "dist/assets", { recursive: true });
}

await rm("dist", { recursive: true, force: true });
await copyHtml();

const options = {
  bundle: true,
  entryNames: "[name]",
  entryPoints: {
    app: "src/client/app.ts",
    styles: "styles.css",
    theme: "src/client/theme.ts",
  },
  external: ["/assets/*"],
  format: "esm",
  minify: !watch,
  outdir: "dist",
  platform: "browser",
  sourcemap: watch,
};

if (watch) {
  const builder = await context(options);
  await builder.watch();
  const htmlWatcher = watchFile(".", (_, name) => {
    if (name === "index.html" || name === "privacy.html") void copyHtml();
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      htmlWatcher.close();
      await builder.dispose();
      process.exit();
    });
  }
} else {
  await build(options);
}
