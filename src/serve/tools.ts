/**
 * Tools the user pointed at by hand.
 *
 * A GUI app does not inherit a shell's environment, so someone whose
 * MKVToolNix or FFmpeg is somewhere the search in `src/tools/locate.ts` does
 * not look has no way to say so. The app lets them choose — a folder for
 * MKVToolNix, a file for FFmpeg — remembers it, and sends it with `configure`.
 * Here that choice becomes the two environment overrides `locate.ts` already
 * honours, so every later `doctor`, `plan` and `apply` resolves the tools
 * through the one place that has always decided which binary runs.
 *
 * `locate.ts` quietly falls back to its search when an override points at
 * nothing, which is right for a command line and wrong for someone who just
 * chose a folder: `choiceProblems` is what makes a choice that does not hold a
 * working tool something `doctor` says in plain words.
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DoctorReport } from "../cli/doctor.js";
import { executableNames, TOOL_ENV_VARS, type ToolEnv } from "../tools/locate.js";

export interface ToolChoices {
  /** The folder holding mkvmerge and mkvextract, as the user chose it. */
  mkvtoolnixDir?: string;
  /** The ffmpeg program, as the user chose it. */
  ffmpeg?: string;
}

function kindOf(path: string): "file" | "dir" | "missing" {
  try {
    const info = statSync(path);
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : "missing";
  } catch {
    return "missing";
  }
}

function holdsTool(dir: string, platform: string): boolean {
  return executableNames("mkvmerge", platform).some((name) => kindOf(join(dir, name)) === "file");
}

/**
 * The directory to search for a chosen MKVToolNix. People choose what they can
 * see: the folder itself, the program inside it, or — on a Mac — the
 * MKVToolNix app, whose programs are in `Contents/MacOS`. All three mean the
 * same folder. Anything else is returned as it is, and found wanting later.
 */
export function mkvtoolnixSearchDir(chosen: string, platform: string = process.platform): string {
  const kind = kindOf(chosen);
  if (kind === "file") return dirname(chosen);
  if (kind === "dir" && !holdsTool(chosen, platform)) {
    const inBundle = join(chosen, "Contents", "MacOS");
    if (holdsTool(inBundle, platform)) return inBundle;
  }
  return chosen;
}

/** Put the choices into the environment `locate.ts` reads; a missing choice clears its override. */
export function applyChoices(env: ToolEnv, choices: ToolChoices, platform: string = process.platform): void {
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) delete env[name];
    else env[name] = value;
  };
  set(
    TOOL_ENV_VARS.mkvmerge,
    choices.mkvtoolnixDir === undefined ? undefined : mkvtoolnixSearchDir(choices.mkvtoolnixDir, platform),
  );
  set(TOOL_ENV_VARS.ffmpeg, choices.ffmpeg);
}

export interface ChoiceProblem {
  /** Which choice is wrong. */
  locate: "mkvtoolnix" | "ffmpeg";
  /** The tool name(s) affected, as `DoctorProblem.what`. */
  what: string;
  message: string;
  fix: string;
}

const CHOOSE_AGAIN_MKV =
  "Select the folder that contains both mkvmerge and mkvextract, or detect it automatically.";
const CHOOSE_AGAIN_FFMPEG =
  "Select the FFmpeg executable (ffmpeg, or ffmpeg.exe on Windows), or detect it automatically.";

/**
 * What is wrong with the choices, given what `doctor` then found. A tool that
 * was chosen must be the one in use (`origin: "env"`) and must run; one that
 * the search found somewhere else instead means the choice was passed over.
 */
export function choiceProblems(report: DoctorReport, choices: ToolChoices): ChoiceProblem[] {
  const problems: ChoiceProblem[] = [];
  const check = (name: string) => report.tools.find((t) => t.tool === name);

  if (choices.mkvtoolnixDir !== undefined) {
    const tools = [check("mkvmerge"), check("mkvextract")].filter((t) => t !== undefined);
    const absent = tools.filter((t) => t.origin !== "env");
    const broken = tools.filter((t) => t.origin === "env" && !(t.found && t.error === undefined));
    if (absent.length > 0) {
      problems.push({
        locate: "mkvtoolnix",
        what: absent.map((t) => t.tool).join(", "),
        message:
          `The selected MKVToolNix folder (${choices.mkvtoolnixDir}) does not contain ` +
          `${absent.map((t) => t.tool).join(" or ")}.`,
        fix: CHOOSE_AGAIN_MKV,
      });
    } else if (broken.length > 0) {
      const first = broken[0]!;
      problems.push({
        locate: "mkvtoolnix",
        what: broken.map((t) => t.tool).join(", "),
        message:
          `The ${first.tool} in the selected MKVToolNix folder (${choices.mkvtoolnixDir}) ` +
          `could not be run (${first.error ?? "unknown error"}).`,
        fix: CHOOSE_AGAIN_MKV,
      });
    }
  }

  if (choices.ffmpeg !== undefined) {
    const ffmpeg = check("ffmpeg");
    if (ffmpeg !== undefined && ffmpeg.origin !== "env") {
      problems.push({
        locate: "ffmpeg",
        what: "ffmpeg",
        message:
          `The selected FFmpeg (${choices.ffmpeg}) was not found or is not an executable.`,
        fix: CHOOSE_AGAIN_FFMPEG,
      });
    } else if (ffmpeg !== undefined && !(ffmpeg.found && ffmpeg.error === undefined)) {
      problems.push({
        locate: "ffmpeg",
        what: "ffmpeg",
        message: `The selected FFmpeg (${choices.ffmpeg}) could not be run (${ffmpeg.error ?? "unknown error"}).`,
        fix: CHOOSE_AGAIN_FFMPEG,
      });
    } else if (ffmpeg !== undefined && !report.frames.ok) {
      problems.push({
        locate: "ffmpeg",
        what: "frames",
        message:
          `The selected FFmpeg (${choices.ffmpeg}) cannot decode video ` +
          `(${report.frames.detail}).`,
        fix: "Choose a full build of FFmpeg, or detect it automatically.",
      });
    }
  }
  return problems;
}
