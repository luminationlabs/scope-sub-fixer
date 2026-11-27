/**
 * `scope-sub serve --stdio` — the engine as a long-lived process for a GUI.
 *
 * JSON-lines requests on stdin, JSON-lines responses and progress events on
 * stdout (`src/serve/protocol.ts`, `docs/engine-protocol.md`). Exits when stdin
 * closes, so an app that dies never leaves an engine running behind it.
 *
 * The engine keeps its scratch files in a folder of its own,
 * `<temp>/scope-sub-engine-<pid>`, by pointing `TMPDIR` (on Windows `TEMP` and
 * `TMP`) at it for the life of
 * the process: every temp directory the fix and verify code makes, and every
 * child it starts, lands inside. A clean exit removes it. An engine that was
 * killed cannot, so each start sweeps the folders of engines that are no longer
 * running — the name says whose it was, and a dead pid says it is finished.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { serve } from "../serve/server.js";
import { EXIT } from "./scan.js";

export const ENGINE_TEMP_PREFIX = "scope-sub-engine-";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and is someone else's. Only "no such process" is dead.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove the scratch folders of engines that are gone. Only a directory named
 * `scope-sub-engine-<pid>` whose pid is not a running process is touched.
 * Returns what was removed.
 */
export async function sweepStaleEngineTemp(
  base: string,
  running: (pid: number) => boolean = isRunning,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = /^scope-sub-engine-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || running(pid)) continue;
    const path = join(base, name);
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Someone else's permissions, or it went away meanwhile: leave it.
    }
  }
  return removed;
}

/**
 * The variables that name the temp directory, for `os.tmpdir()` and for the
 * children the engine starts: `TMPDIR` on POSIX; `TEMP` and `TMP` on Windows,
 * where `os.tmpdir()` and the Windows API (what mkvmerge and ffmpeg use)
 * read those and ignore `TMPDIR`.
 */
export function tempEnvVars(platform: string = process.platform): string[] {
  return platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"];
}

function setTempEnv(dir: string): void {
  for (const name of tempEnvVars()) process.env[name] = dir;
}

/** Give this process a scratch folder of its own under `base`, and make it the temp directory. */
export async function claimEngineTemp(base: string): Promise<string | undefined> {
  const own = join(base, `${ENGINE_TEMP_PREFIX}${process.pid}`);
  try {
    // A folder with our pid from a dead process that had it before us.
    await rm(own, { recursive: true, force: true });
    await mkdir(own, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  setTempEnv(own);
  return own;
}

export async function runServe(raw: { stdio?: boolean }): Promise<number> {
  if (raw.stdio !== true) {
    process.stderr.write("serve requires --stdio (the only supported transport)\n");
    return EXIT.BAD_ARGS;
  }
  const base = tmpdir();
  const saved = tempEnvVars().map((name) => [name, process.env[name]] as const);
  await sweepStaleEngineTemp(base);
  const own = await claimEngineTemp(base);

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // The client's end of stdout can close before ours of stdin is seen to
  // (an app that crashed). Writing then fails with EPIPE, which unhandled
  // would kill the engine in the middle of cleaning up. Stop writing instead,
  // and treat it as the client having gone: end the input, which aborts the job.
  let broken = false;
  process.stdout.on("error", () => {
    broken = true;
    lines.close();
  });
  try {
    await serve({
      input: lines,
      write: (line) => {
        if (broken) return;
        try {
          process.stdout.write(`${line}\n`);
        } catch {
          broken = true;
          lines.close();
        }
      },
    });
  } finally {
    lines.close();
    if (own !== undefined) {
      if (process.platform === "win32") {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      } else {
        process.env["TMPDIR"] = base;
      }
      await rm(own, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return EXIT.OK;
}

/** Attach the `serve` subcommand to a commander program. */
export function registerServeCommand(program: Command): Command {
  return program
    .command("serve")
    .description("run as an engine for a GUI: JSON-lines requests on stdin, events on stdout")
    .option("--stdio", "speak the protocol over stdin/stdout", false)
    .action(async (options: { stdio?: boolean }) => {
      process.exitCode = await runServe(options);
    });
}
