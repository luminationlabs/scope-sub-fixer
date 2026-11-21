/**
 * The engine protocol: what `scope-sub serve --stdio` speaks.
 *
 * JSON lines both ways. A client (the desktop app) writes one request per line
 * on stdin and reads one message per line from stdout; nothing else is ever
 * written to stdout in this mode. `docs/engine-protocol.md` is the prose
 * version of this file, and the two are meant to be read together.
 *
 *   → {"id": 1, "method": "plan", "params": {...}}
 *   ← {"id": 1, "event": "plan.file-start", "data": {...}}     (any number)
 *   ← {"id": 1, "result": {...}}            or  {"id": 1, "error": {...}}
 *
 * Everything in here is a *view*: the shapes are built for a UI and are
 * deliberately not the plan file's schema, so that schema can keep changing
 * without the app noticing.
 */
import { basename, extname } from "node:path";
import type { ApplyFileResult, ApplyRunResult } from "../batch/apply.js";
import type { ApplyLogEvent } from "../batch/log.js";
import type { PlanFileEntry } from "../batch/planFile.js";
import type { PlanRunResult } from "../batch/plan.js";
import type { RevertFileResult } from "../batch/revert.js";
import type { DoctorReport } from "../cli/doctor.js";
import { choiceProblems, type ToolChoices } from "./tools.js";

/** Bumped when a message changes shape incompatibly. */
export const PROTOCOL_VERSION = 3;

export const METHODS = ["hello", "configure", "doctor", "plan", "apply", "revert", "cancel", "shutdown"] as const;
export type Method = (typeof METHODS)[number];

export type RequestId = number | string;

export interface Request {
  id: RequestId;
  method: string;
  params?: unknown;
}

export type ErrorCode =
  /** The line was not a request, or its params were wrong. */
  | "bad-request"
  | "unknown-method"
  /** A plan or apply is already running; the engine runs one at a time. */
  | "busy"
  /** mkvmerge / mkvextract / ffmpeg could not be started. */
  | "dependency-missing"
  /** The plan directory cannot be used as asked (see the message). */
  | "plan-file"
  /**
   * The output folder would put repaired files into the library itself, or the
   * plan directory is inside the folder being scanned.
   */
  | "unsafe-output"
  /** The fix will not fit on the output volume, or in the temporary folder. */
  | "no-space"
  /** An in-place fix or undo was asked for on files that cannot be written. */
  | "not-writable"
  /**
   * The plan directory holds the undo records of files fixed in place and may
   * not be rebuilt (`reanalyze`) through the protocol.
   */
  | "undo-records"
  | "failed";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
}

export type Message =
  | { id: RequestId; result: unknown }
  | { id: RequestId | null; error: ErrorBody }
  | { id?: RequestId; event: string; data: unknown };

// --- hello ----------------------------------------------------------------

export interface HelloResult {
  name: string;
  version: string;
  protocol: number;
  methods: readonly string[];
}

// --- doctor ---------------------------------------------------------------

/** One thing that is wrong, phrased for someone who has never used a terminal. */
export interface DoctorProblem {
  /** What is affected: a tool name, "frames", "temp" or "runtime". */
  what: string;
  message: string;
  /** What to do about it. */
  fix: string;
  /**
   * Set when choosing the tool by hand (`configure`) is a way out: which
   * choice a UI should offer beside the problem.
   */
  locate?: "mkvtoolnix" | "ffmpeg";
}

export interface DoctorResult {
  /** False as well when a tool the user chose is not the one in use, or does not work. */
  ok: boolean;
  report: DoctorReport;
  problems: DoctorProblem[];
  /** The tools chosen by hand (`configure`), as they were chosen. */
  chosen: ToolChoices;
}

// --- configure --------------------------------------------------------------

export interface ConfigureParams {
  /**
   * Where the tools are, chosen by hand. Each call replaces the whole choice:
   * a key left out (or null) goes back to the automatic search.
   */
  tools: { mkvtoolnixDir?: string | null; ffmpeg?: string | null };
}

export interface ConfigureResult {
  tools: ToolChoices;
}

const MKVTOOLNIX_FIX =
  "Install MKVToolNix: download it from https://mkvtoolnix.download/downloads.html, " +
  "or with Homebrew run `brew install mkvtoolnix`. Then check again.";
const FFMPEG_FIX =
  "Install FFmpeg: with Homebrew run `brew install ffmpeg`, or download a build from " +
  "https://ffmpeg.org/download.html and put `ffmpeg` in /usr/local/bin. Then check again.";

/** Turn the doctor report into the short list of things the user must fix. */
export function doctorProblems(report: DoctorReport, chosen: ToolChoices = {}): DoctorProblem[] {
  const problems: DoctorProblem[] = [];
  // A choice that did not work out is the whole story for its tool: say that,
  // not "was not found" beside a folder the user has just pointed at.
  const wrong = choiceProblems(report, chosen);
  const wrongMkv = wrong.some((p) => p.locate === "mkvtoolnix");
  const wrongFfmpeg = wrong.some((p) => p.locate === "ffmpeg");
  if (!report.node.ok) {
    problems.push({
      what: "runtime",
      message: `The bundled runtime is out of date (${report.node.version}).`,
      fix: "Reinstall Scope Sub Fixer.",
    });
  }
  const missingMkv = report.tools.filter(
    (t) => t.tool !== "ffmpeg" && !(t.found && t.error === undefined),
  );
  if (missingMkv.length > 0 && !wrongMkv) {
    const first = missingMkv[0]!;
    problems.push({
      locate: "mkvtoolnix",
      what: missingMkv.map((t) => t.tool).join(", "),
      message: first.found
        ? `MKVToolNix was found but could not be run (${first.error ?? "unknown error"}).`
        : "MKVToolNix was not found. It is required to read MKV files.",
      fix: MKVTOOLNIX_FIX,
    });
  }
  const ffmpeg = report.tools.find((t) => t.tool === "ffmpeg");
  if (wrongFfmpeg) {
    // Said below, in the user's own terms.
  } else if (ffmpeg !== undefined && !(ffmpeg.found && ffmpeg.error === undefined)) {
    problems.push({
      locate: "ffmpeg",
      what: "ffmpeg",
      message: ffmpeg.found
        ? `FFmpeg was found but could not be run (${ffmpeg.error ?? "unknown error"}).`
        : "FFmpeg was not found. It is required to detect the picture area.",
      fix: FFMPEG_FIX,
    });
  } else if (!report.frames.ok) {
    problems.push({
      locate: "ffmpeg",
      what: "frames",
      message: `This FFmpeg installation cannot decode video (${report.frames.detail}).`,
      fix: FFMPEG_FIX,
    });
  }
  problems.push(...wrong);
  if (!report.tempDir.writable) {
    problems.push({
      what: "temp",
      message: `The temporary folder ${report.tempDir.path} is not writable (${report.tempDir.error ?? "unknown error"}).`,
      fix: "Free up disk space or check the folder's permissions, then check again.",
    });
  }
  return problems;
}

export function doctorResult(report: DoctorReport, chosen: ToolChoices = {}): DoctorResult {
  const problems = doctorProblems(report, chosen);
  // The report alone can be fine while a choice is not: the search fell back
  // to another copy of the tool. That is still something to put right.
  return { ok: report.ok && problems.length === 0, report, problems, chosen: { ...chosen } };
}

// --- plan -----------------------------------------------------------------

export interface PlanParams {
  /** Files or folders to look in. */
  paths: string[];
  /** The plan directory: the record of this library, and what `apply` reads. */
  planDir: string;
  /** Look inside subfolders. Default true. */
  recursive?: boolean;
  /** Picture aspect ratio, or "auto" (the default) to measure each title. */
  aspect?: number | "auto";
  jobs?: number;
  /** Throw away an existing plan's verdicts and read everything again. */
  reanalyze?: boolean;
  /**
   * Plan a title for the slower remux when the byte patch cannot repair it
   * (compressed subtitle tracks, mostly). Default false. It is part of what a
   * plan directory was built with: changing it needs `reanalyze`.
   */
  remuxFallback?: boolean;
}

export interface TrackView {
  id: number;
  language: string;
  name?: string;
  forced: boolean;
  /** Absent when the track was not read (no black bars at all). */
  eventCount?: number;
  eventsOutside: number;
  status: string;
  action: "fix" | "skip";
  reason?: string;
}

export interface FileView {
  /** Absolute path; the key `apply`'s `only` takes. */
  input: string;
  /** Path relative to the scanned folder; where the copy lands under the output folder. */
  relative: string;
  /** The file name without its extension. */
  title: string;
  size: number;
  status: string;
  action: "fix" | "skip";
  /**
   * How a fix is done. `patch`: the copy is the original with a few bytes
   * changed. `remux`: the file is rebuilt with mkvmerge — slower, and the copy
   * is a different size.
   */
  method: "patch" | "remux";
  reason?: string;
  video: { w: number; h: number } | null;
  activeArea: { top: number; bottom: number; aspect: number; classification: string } | null;
  /** Subtitle events found outside the picture, across every PGS track. */
  eventsOutside: number;
  /** Events the fix would move (0 for a skip). */
  eventsToMove: number;
  tracksToFix: number;
  bytesChanged: number;
  tracks: TrackView[];
  notes: string[];
  /**
   * Set when the plan's log says this title is fixed and the fixed file is
   * still there. `inPlace` means the fixed file is the original itself
   * (`output` is then `input`): there is no untouched original any more, and
   * the plan directory is the only way back (`revert`).
   */
  fixed?: { output: string; time: string; inPlace?: true };
  /**
   * An in-place write to this file began and never finished (the app or the
   * machine went down part-way). The file may be half changed. `doing` says
   * which way it was going; either `apply` in in-place mode ("finish fixing")
   * or `revert` ("put it back") completes it. Never show such a title as fine.
   */
  interrupted?: { doing: "fix" | "undo"; time: string };
}

/** What the log knows about one input beyond its plan entry. */
export interface FileHistory {
  completed?: ApplyLogEvent;
  unfinished?: ApplyLogEvent;
}

function isHistory(value: ApplyLogEvent | FileHistory | undefined): value is FileHistory {
  return value !== undefined && !("event" in value);
}

export function fileView(entry: PlanFileEntry, history?: ApplyLogEvent | FileHistory): FileView {
  const completed = isHistory(history) ? history.completed : history;
  const unfinished = isHistory(history) ? history.unfinished : undefined;
  const inPlace = completed !== undefined && (completed.event === "patched" || completed.event === "replaced");
  const tracks: TrackView[] = entry.tracks.map((t) => ({
    id: t.mkvmerge_id,
    language: t.language,
    ...(t.name === undefined ? {} : { name: t.name }),
    forced: t.forced,
    ...(t.event_count === undefined ? {} : { eventCount: t.event_count }),
    eventsOutside: t.offending_event_count,
    status: t.status,
    action: t.action,
    ...(t.reason === undefined ? {} : { reason: t.reason }),
  }));
  const name = basename(entry.input);
  return {
    input: entry.input,
    relative: entry.relative,
    title: name.slice(0, name.length - extname(name).length),
    size: entry.size,
    status: entry.status,
    action: entry.action,
    method: entry.method,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    video: entry.video,
    activeArea:
      entry.active_area === null
        ? null
        : {
            top: entry.active_area.top,
            bottom: entry.active_area.bottom,
            aspect: entry.active_area.aspect,
            classification: entry.active_area.classification,
          },
    eventsOutside: tracks.reduce((n, t) => n + t.eventsOutside, 0),
    eventsToMove: entry.patch_summary?.events_moved ?? 0,
    tracksToFix: entry.patch_summary?.tracks ?? 0,
    bytesChanged: entry.patch_summary?.bytes_changed ?? 0,
    tracks,
    notes: entry.notes ?? [],
    ...(completed?.output === undefined && !inPlace
      ? {}
      : {
          fixed: {
            output: completed!.output ?? entry.input,
            time: completed!.time,
            ...(inPlace ? { inPlace: true as const } : {}),
          },
        }),
    ...(unfinished === undefined
      ? {}
      : {
          interrupted: {
            doing: unfinished.reason === "revert" ? ("undo" as const) : ("fix" as const),
            time: unfinished.time,
          },
        }),
  };
}

export interface PlanResult {
  planDir: string;
  cancelled: boolean;
  /** Files read by this run; the rest were unchanged since the last one. */
  analyzed: number;
  reused: number;
  /** Paths from the request that do not exist. */
  missingPaths: string[];
  /**
   * Inputs (as `FileView.input`) that could not be read this run — a share
   * that dropped, a file that went away — and so are shown with the verdict an
   * earlier scan gave them. They were not checked: a UI must not present them
   * as freshly looked at.
   */
  unreadable: string[];
  /**
   * How many titles this plan directory holds the undo record of: files it
   * fixed in place (or was interrupted fixing). While this is not 0 the
   * directory must be kept — it is the only way back for those files.
   */
  undoRecords: number;
  summary: { files: number; fix: number; skip: number; byStatus: Record<string, number> };
  /** Every file this run found, in plan order. Entries for files not found are left out. */
  files: FileView[];
}

export function planResult(
  run: PlanRunResult,
  completed: ReadonlyMap<string, ApplyLogEvent>,
  unfinished: ReadonlyMap<string, ApplyLogEvent> = new Map(),
  undoRecords = 0,
): PlanResult {
  const gone = new Set(run.notFound);
  const files = run.plan.files
    .filter((f) => !gone.has(f.input))
    .map((f) => {
      const c = completed.get(f.input);
      const u = unfinished.get(f.input);
      return fileView(f, { ...(c === undefined ? {} : { completed: c }), ...(u === undefined ? {} : { unfinished: u }) });
    });
  const byStatus: Record<string, number> = {};
  for (const f of files) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  return {
    planDir: run.dir,
    cancelled: run.cancelled === true,
    analyzed: run.analyzed,
    reused: run.reused,
    missingPaths: run.missingPaths,
    unreadable: (run.unreadable ?? []).filter((input) => !gone.has(input)),
    undoRecords,
    summary: {
      files: files.length,
      fix: files.filter((f) => f.action === "fix").length,
      skip: files.filter((f) => f.action === "skip").length,
      byStatus,
    },
    files,
  };
}

// --- apply ----------------------------------------------------------------

/**
 * `copy` (the default): a repaired copy of each title under `outputRoot`; the
 * originals are never written. `in-place`: the originals themselves are
 * changed and no copy is kept — the plan directory becomes the only undo
 * record. It has to be asked for by name; nothing else selects it.
 */
export type ApplyMode = "copy" | "in-place";

export interface ApplyParams {
  planDir: string;
  /** Default `copy`. */
  mode?: ApplyMode;
  /**
   * `copy` mode: the folder the repaired copies are written into, never the
   * library itself. Required there; refused in `in-place` mode, which has none.
   */
  outputRoot?: string;
  /** Inputs to fix (absolute paths, as `FileView.input`). Required: nothing is implied. */
  only: string[];
  /** Check everything and write nothing. Default false. */
  dryRun?: boolean;
  /**
   * `in-place` mode only (refused with `copy`, which never touches an
   * original): put each changed file's modification date back after the
   * write. Default false.
   */
  keepDates?: boolean;
}

export interface ApplyFileView {
  input: string;
  relative: string;
  output: string;
  /** applied | would-apply | skipped | failed | conflict */
  status: string;
  reason?: string;
  /** Why a `skipped` title was skipped; absent for every other status. */
  skipKind?: SkipKind;
  /** True when this was an in-place fix: `output` is the original itself. */
  inPlace?: true;
  /**
   * In place only: this finished a write an earlier run was interrupted in —
   * `half-written` (some of the changes were there) or `unverified` (all of
   * them were, and only the check was left).
   */
  resumed?: "half-written" | "unverified";
  /** True when the written copy was read back and its subtitles checked against the plan. */
  verified: boolean;
  bytesWritten: number;
  sha256?: string;
  /** One line per verification step. */
  checks: string[];
  elapsedMs: number;
  /**
   * `keepDates` only: why this file's date could not be kept. The fix itself
   * still stands; this never makes a fixed title a failure.
   */
  dateNotKept?: string;
}

/**
 * `already-done` is the only skip that is good news: a verified copy from an
 * earlier run is still in place. Every other one means a title the user asked
 * for was not fixed, and a UI must not show it as a success.
 */
export type SkipKind =
  | "already-done"
  | "no-space"
  | "input-missing"
  | "input-changed"
  /** In-place mode: the title has to be rebuilt, which only a copy can be. */
  | "needs-copy"
  | "other";

/** What a title that must be rebuilt is told when an in-place fix is asked for. */
export const NEEDS_COPY_REASON =
  "this title has to be rebuilt to be fixed, and a rebuilt file cannot be written over the " +
  "original; fix it into a copy instead";

/**
 * Sort a skip by its reason. The engine reports skips as text only, so this
 * reads the wording of `preflightDecision` and `shouldSkipForResume`; a test
 * holds the two together.
 */
export function skipKindOf(reason: string | undefined): SkipKind {
  const text = reason ?? "";
  if (/^already (applied|patched)/.test(text)) return "already-done";
  if (/^not enough free space/.test(text)) return "no-space";
  if (/^the original file no longer exists/.test(text)) return "input-missing";
  if (/^the file was modified after the plan was built/.test(text)) return "input-changed";
  if (text === NEEDS_COPY_REASON || /planned for remux/.test(text)) return "needs-copy";
  return "other";
}

export function applyFileView(r: ApplyFileResult): ApplyFileView {
  return {
    input: r.input,
    relative: r.relative,
    output: r.output,
    status: r.status,
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    ...(r.status === "skipped" ? { skipKind: skipKindOf(r.reason) } : {}),
    ...(r.inPlace ? { inPlace: true as const } : {}),
    ...(r.resuming ? { resumed: "half-written" as const } : r.awaitingVerification ? { resumed: "unverified" as const } : {}),
    verified: r.verified,
    bytesWritten: r.bytesWritten,
    ...(r.sha256 === undefined ? {} : { sha256: r.sha256 }),
    checks: r.checks,
    elapsedMs: r.elapsedMs,
  };
}

export interface ApplyResult {
  planDir: string;
  mode: ApplyMode;
  /** Empty in `in-place` mode. */
  outputRoot: string;
  dryRun: boolean;
  cancelled: boolean;
  summary: ApplyRunResult["summary"];
  files: ApplyFileView[];
}

export function applyResult(run: ApplyRunResult): ApplyResult {
  return {
    planDir: run.dir,
    mode: run.inPlace ? "in-place" : "copy",
    outputRoot: run.outputRoot ?? "",
    dryRun: !run.execute,
    cancelled: run.cancelled === true,
    summary: run.summary,
    files: run.files.map(applyFileView),
  };
}

// --- revert ---------------------------------------------------------------

export interface RevertParams {
  planDir: string;
  /** Inputs to put back (absolute paths, as `FileView.input`). Required. */
  only: string[];
  /** Check everything and write nothing. Default false. */
  dryRun?: boolean;
  /** Put each file's modification date back after the write. Default false. */
  keepDates?: boolean;
}

export interface RevertFileView {
  input: string;
  relative: string;
  /** reverted | would-revert | skipped | failed */
  status: string;
  reason?: string;
  /** Bytes put back (the same few position fields the fix changed). */
  bytesChanged: number;
  /** One line per step; a `reverted` file was re-read and matched the original bytes. */
  checks: string[];
  elapsedMs: number;
  /** `keepDates` only: why this file's date could not be kept. The undo still stands. */
  dateNotKept?: string;
}

export function revertFileView(r: RevertFileResult): RevertFileView {
  return {
    input: r.input,
    relative: r.relative,
    status: r.status,
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    bytesChanged: r.bytesChanged,
    checks: r.checks,
    elapsedMs: r.elapsedMs,
  };
}

export interface RevertResult {
  planDir: string;
  dryRun: boolean;
  cancelled: boolean;
  summary: { asked: number; reverted: number; skipped: number; failed: number };
  files: RevertFileView[];
}
