#!/usr/bin/env node
/**
 * Put the engine where Tauri looks for its sidecar:
 * `src-tauri/binaries/scope-sub-engine-<target triple>`.
 *
 *   node scripts/sidecar.mjs          compile the engine into one self-contained
 *                                     executable with `bun build --compile`
 *   node scripts/sidecar.mjs --dev    write a shell shim that runs the engine's
 *                                     Node build (../dist/cli/main.js) instead
 *
 * The shim exists so `tauri dev` needs neither bun nor a 58 MB rebuild after
 * every engine change: `pnpm build` in the repo root is enough. It holds an
 * absolute path to this checkout and must never be shipped; `tauri build`
 * always goes through the compile. Windows cannot run a shell shim as the
 * sidecar (Tauri starts `scope-sub-engine-<triple>.exe`), so there `--dev`
 * compiles as well.
 *
 * The target is the Rust host triple (`rustc -vV`, which is what Tauri names
 * the sidecar after), or `--target=<triple>`; without rustc it is derived from
 * Node's platform and architecture.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "..");
const devAsked = process.argv.includes("--dev");
// A shell shim is not an executable Windows will start: compile instead.
const dev = devAsked && process.platform !== "win32";
if (devAsked && !dev) console.log("--dev: Windows cannot run a shim as the sidecar; compiling the engine instead");

/** Rust target triple → what `bun build --target` calls it. */
const BUN_TARGETS = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  // Listed in bun's executables docs; needs a bun recent enough to have it.
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
};

/** Node's platform/arch → the Rust triple Tauri expects, for when rustc is absent. */
const NODE_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

function hostTriple() {
  let out;
  try {
    out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  } catch {
    const key = `${process.platform}-${process.arch}`;
    const triple = NODE_TRIPLES[key];
    if (!triple) throw new Error(`rustc is not available and no target triple is known for ${key}; pass --target=<triple>`);
    return triple;
  }
  const m = /^host:\s*(\S+)$/m.exec(out);
  if (!m) throw new Error("could not read the host triple from `rustc -vV`");
  return m[1];
}

const tripleArg = process.argv.find((a) => a.startsWith("--target="));
const triple = tripleArg ? tripleArg.slice("--target=".length) : hostTriple();
const outDir = join(desktop, "src-tauri", "binaries");
const ext = triple.includes("windows") ? ".exe" : "";
const out = join(outDir, `scope-sub-engine-${triple}${ext}`);
mkdirSync(outDir, { recursive: true });

if (dev) {
  const main = join(repo, "dist", "cli", "main.js");
  if (!existsSync(main)) {
    console.error(`${main} is missing: run \`pnpm build\` in ${repo} first`);
    process.exit(1);
  }
  // The node that is running this script, by absolute path: a GUI process has
  // a minimal PATH, and a version manager's node is not on it.
  writeFileSync(
    out,
    `#!/bin/sh\n# Development shim written by scripts/sidecar.mjs --dev. Never ship this.\n` +
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`,
  );
  chmodSync(out, 0o755);
  console.log(`dev shim → ${out}\n  runs: ${process.execPath} ${main}`);
} else {
  const target = BUN_TARGETS[triple];
  if (!target) {
    console.error(
      `no bun target known for ${triple}; bun can compile for: ${Object.keys(BUN_TARGETS).join(", ")}`,
    );
    process.exit(1);
  }
  execFileSync(
    "bun",
    ["build", "--compile", "--minify", `--target=${target}`, join(desktop, "sidecar", "entry.ts"), "--outfile", out],
    // bun stages the executable as `.<hash>.bun-build` in the working directory
    // and can leave it behind; keep that out of the repo root.
    { stdio: "inherit", cwd: outDir },
  );
  for (const name of readdirSync(outDir)) {
    if (name.endsWith(".bun-build")) rmSync(join(outDir, name), { force: true });
  }
  const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`compiled engine → ${out} (${mb} MB, ${target})`);
}
