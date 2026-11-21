import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DIST_MAIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

/**
 * `npm install -g` links `bin/scope-sub` at `dist/cli/main.js`. Node resolves
 * the main module to its real path but leaves `process.argv[1]` as the symlink,
 * so a naive entry-point check makes the installed CLI exit 0 in silence.
 * Needs `pnpm build`; skipped when dist/ is not there.
 */
describe.skipIf(!existsSync(DIST_MAIN))("the built CLI, run through a bin symlink", () => {
  it("runs instead of exiting silently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-sub-bin-"));
    const link = join(dir, "scope-sub");
    await symlink(DIST_MAIN, link);

    const { stdout } = await execFileAsync(process.execPath, [link, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("still runs when invoked by its real path", async () => {
    const { stdout } = await execFileAsync(process.execPath, [DIST_MAIN, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
