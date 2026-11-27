#!/usr/bin/env node
/**
 * scope-sub entry point.
 *
 * The subcommands: `scan` (read-only analysis), `fix` (repair into a new file)
 * and `verify` (compare an original against a fix) work on one file at a time;
 * `plan`, `plan-show`, `apply` and `revert` are the same steps for a library,
 * with a reviewable plan directory in between that doubles as the undo record
 * (PRD §17); `doctor` checks that this machine can run any of them at all; `serve` is the
 * same engine as a long-lived process for a GUI (`src/serve/`).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import { EXIT, registerScanCommand } from "./scan.js";
import { registerFixCommand } from "./fix.js";
import { registerVerifyCommand } from "./verify.js";
import { registerPlanCommand } from "./plan.js";
import { registerPlanShowCommand } from "./planShow.js";
import { registerApplyCommand } from "./apply.js";
import { registerRevertCommand } from "./revert.js";
import { registerRemarginCommand } from "./remargin.js";
import { registerRestoreDatesCommand } from "./restoreDates.js";
import { registerReviewCommand } from "./review.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerServeCommand } from "./serve.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(TOOL_NAME)
    .description(
      "Find and fix Blu-ray PGS subtitles authored inside the letterbox bars of scope MKVs.",
    )
    .version(TOOL_VERSION)
    .showHelpAfterError();

  registerScanCommand(program);
  registerFixCommand(program);
  registerVerifyCommand(program);
  registerPlanCommand(program);
  registerPlanShowCommand(program);
  registerApplyCommand(program);
  registerRevertCommand(program);
  registerReviewCommand(program);
  registerRemarginCommand(program);
  registerRestoreDatesCommand(program);
  registerDoctorCommand(program);
  registerServeCommand(program);

  return program;
}

/** commander's `exitOverride` is per-command, so apply it to the whole tree. */
function exitOverrideDeep(command: Command): Command {
  command.exitOverride();
  for (const child of command.commands) exitOverrideDeep(child);
  return command;
}

export async function main(argv: readonly string[]): Promise<number> {
  const program = exitOverrideDeep(buildProgram());
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version print successfully and are not failures.
      if (
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.help" ||
        err.code === "commander.version"
      ) {
        return EXIT.OK;
      }
      return EXIT.BAD_ARGS;
    }
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : EXIT.OK;
}

/**
 * True when this module is what was executed, rather than imported by a test.
 *
 * `npm install -g` puts a symlink in `bin/` pointing at this file, and Node
 * resolves the main module to its real path while leaving `argv[1]` as the
 * symlink, so comparing the two directly makes an installed `scope-sub` exit 0
 * without doing anything. Both sides are resolved before comparing.
 */
function isMainModule(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isEntryPoint = isMainModule();

if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
