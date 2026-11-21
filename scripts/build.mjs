#!/usr/bin/env node
// `pnpm build` / `prepack`: empty dist/, compile with the local tsc, mark the
// CLI executable. Node rather than `rm -rf … && tsc && chmod +x …` so the same
// command works under cmd.exe and PowerShell. chmod is a no-op there.
import { spawnSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });

// Run tsc's own JS entry through this Node: no `.cmd` shim, no shell.
const tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

if (process.platform !== "win32") chmodSync(join(dist, "cli", "main.js"), 0o755);
