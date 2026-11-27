/**
 * The engine server behind `scope-sub serve --stdio`.
 *
 * It is a thin dispatcher: each method validates its params, calls the same
 * `runDoctor` / `runPlan` / `applyPlan` the CLI commands call, forwards their
 * progress hooks as events and maps what they return through the views in
 * `protocol.ts`. Nothing here decides anything about a repair.
 *
 * What it does add is the app's safety policy. `apply` writes copies into an
 * output folder unless it is asked for `mode: "in-place"` by name; the CLI's
 * own spellings of the in-place and replace-original modes are refused,
 * `only` is required, and an output folder inside (or equal to) the folder a
 * title came from is refused.
 *
 * `plan` and `apply` are jobs: one runs at a time (they share the plan
 * directory), and `cancel` aborts the one named. A cancelled job still ends
 * with a normal `result`, with `cancelled: true` and whatever it finished.
 */
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { applyPlan, ApplyError, type ApplyProgress } from "../batch/apply.js";
import {
  completedByInput,
  pendingReplacements,
  readApplyLog,
  unfinishedInPlace,
  type ApplyLogEvent,
} from "../batch/log.js";
import { revertPlan, RevertError } from "../batch/revert.js";
import { DateWatch } from "../batch/dates.js";
import { runPlan } from "../batch/plan.js";
import { partialPathFor } from "../fix/copyPatch.js";
import {
  outputPathFor,
  PlanFileError,
  planPaths,
  requirePlan,
  type PlanFileEntry,
} from "../batch/planFile.js";
import { runDoctor } from "../cli/doctor.js";
import { DependencyMissingError } from "../mkv/inspect.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import { clearToolCache, type ToolEnv } from "../tools/locate.js";
import type { Logger } from "../scan/log.js";
import {
  applyFileView,
  applyResult,
  doctorResult,
  fileView,
  METHODS,
  planResult,
  PROTOCOL_VERSION,
  NEEDS_COPY_REASON,
  revertFileView,
  type ApplyFileView,
  type ApplyParams,
  type ApplyResult,
  type ConfigureResult,
  type RevertFileView,
  type RevertParams,
  type RevertResult,
  type ErrorBody,
  type ErrorCode,
  type HelloResult,
  type Message,
  type PlanParams,
  type RequestId,
} from "./protocol.js";
import {
  deviceAt,
  freeBytesAt,
  insideAny,
  spaceNeeded,
  spaceShortfall,
  unsafeOutputReason,
} from "./safety.js";
import { applyChoices, type ToolChoices } from "./tools.js";
import {
  exactRevertFilter,
  notWritable,
  notWritableMessage,
  revertAim,
  undoRecordInputs,
} from "./inPlace.js";

export { unsafeOutputReason };

/** The engine functions the server calls; injectable so tests need no media. */
export interface EngineDeps {
  runDoctor: typeof runDoctor;
  runPlan: typeof runPlan;
  applyPlan: typeof applyPlan;
  /** Optional so engines built for tests need not supply it; the real one is the default. */
  revertPlan?: typeof revertPlan;
  /** Free bytes on the volume a path is on; injectable so a full disk can be tested. */
  freeBytes?: (path: string) => Promise<number | undefined>;
  /**
   * The environment `configure` writes the tool overrides into. The real one
   * by default, which is what `locate.ts` reads; a test passes its own.
   */
  env?: ToolEnv;
  /**
   * How the watch over kept file dates (`keepDates`) is run. By default each
   * file's window is chosen by its filesystem (none on a local disk); a test
   * passes a short window to see the wait without a share.
   */
  dateWatchOptions?: { windowMs?: number; pollMs?: number };
}

const defaultEngine: EngineDeps = { runDoctor, runPlan, applyPlan, revertPlan };

export interface ServeIo {
  /** Request lines. The server stops when this ends. */
  input: AsyncIterable<string>;
  /** Called with one serialized message, without the trailing newline. */
  write: (line: string) => void;
}

/** A request failed in a way the client is told about by code. */
export class RequestError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(message: string): never {
  throw new RequestError("bad-request", message);
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const v = params[name];
  if (typeof v !== "string" || v.trim() === "") bad(`"${name}" must be a non-empty string`);
  return v as string;
}

function stringListParam(params: Record<string, unknown>, name: string): string[] {
  const v = params[name];
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || x === "")) {
    bad(`"${name}" must be a non-empty array of strings`);
  }
  return v as string[];
}

function optionalBoolean(params: Record<string, unknown>, name: string): boolean | undefined {
  const v = params[name];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") bad(`"${name}" must be true or false`);
  return v as boolean;
}

export function parsePlanParams(raw: unknown): PlanParams {
  if (!isRecord(raw)) bad("plan needs params");
  const params = raw as Record<string, unknown>;
  const aspect = params["aspect"];
  if (
    aspect !== undefined &&
    aspect !== "auto" &&
    !(typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0)
  ) {
    bad('"aspect" must be a positive number or "auto"');
  }
  const jobs = params["jobs"];
  if (jobs !== undefined && !(typeof jobs === "number" && Number.isInteger(jobs) && jobs >= 1)) {
    bad('"jobs" must be a whole number of at least 1');
  }
  const recursive = optionalBoolean(params, "recursive");
  const reanalyze = optionalBoolean(params, "reanalyze");
  const remuxFallback = optionalBoolean(params, "remuxFallback");
  return {
    paths: stringListParam(params, "paths"),
    planDir: stringParam(params, "planDir"),
    ...(recursive === undefined ? {} : { recursive }),
    ...(aspect === undefined ? {} : { aspect: aspect as number | "auto" }),
    ...(jobs === undefined ? {} : { jobs: jobs as number }),
    ...(reanalyze === undefined ? {} : { reanalyze }),
    ...(remuxFallback === undefined ? {} : { remuxFallback }),
  };
}

/** `configure`'s params as choices: a string is a choice, null or absent is none. */
export function parseConfigureParams(raw: unknown): ToolChoices {
  if (!isRecord(raw) || !isRecord(raw["tools"])) {
    bad('configure needs params: {"tools": {"mkvtoolnixDir"?: <folder>, "ffmpeg"?: <file>}}');
  }
  const tools = (raw as Record<string, unknown>)["tools"] as Record<string, unknown>;
  const choices: ToolChoices = {};
  for (const key of ["mkvtoolnixDir", "ffmpeg"] as const) {
    const v = tools[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.trim() === "") bad(`"tools.${key}" must be a path, or null to clear it`);
    choices[key] = v as string;
  }
  return choices;
}

export function parseRevertParams(raw: unknown): RevertParams {
  if (!isRecord(raw)) bad("revert needs params");
  const params = raw as Record<string, unknown>;
  // The undo the protocol offers is one thing: the original bytes back into
  // the original file. The command line's other forms are not reachable.
  for (const forbidden of ["outputRoot", "output", "overwriteOutput", "file", "patchFile", "target"]) {
    if (params[forbidden] !== undefined) {
      bad(`"${forbidden}" is not available through the engine protocol: revert puts the original bytes back in place`);
    }
  }
  const dryRun = optionalBoolean(params, "dryRun");
  const keepDates = optionalBoolean(params, "keepDates");
  return {
    planDir: stringParam(params, "planDir"),
    only: stringListParam(params, "only"),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(keepDates === undefined ? {} : { keepDates }),
  };
}

export const FORBIDDEN_APPLY_PARAMS = [
  "inPlace",
  "replaceOriginal",
  "dangerouslyInPlace",
  "skipVerify",
  "overwriteOutput",
] as const;

export function parseApplyParams(raw: unknown): ApplyParams {
  if (!isRecord(raw)) bad("apply needs params");
  const params = raw as Record<string, unknown>;
  // The modes that write into a library, or over a file that is already
  // there, are not part of this protocol. Refuse them by name rather than
  // ignoring them, so a client cannot believe it asked for one and got it.
  for (const forbidden of FORBIDDEN_APPLY_PARAMS) {
    if (params[forbidden] !== undefined) {
      bad(
        `"${forbidden}" is not available through the engine protocol: it only writes copies, ` +
          "and never over a file that is already there",
      );
    }
  }
  const dryRun = optionalBoolean(params, "dryRun");
  // In-place fixing is asked for by exactly one spelling. A request without
  // it is a copy, as every request was before the mode existed.
  const mode = params["mode"];
  if (mode !== undefined && mode !== "copy" && mode !== "in-place") {
    bad('"mode" must be "copy" or "in-place"');
  }
  if (mode === "in-place") {
    if (params["outputRoot"] !== undefined) {
      bad('"outputRoot" has no meaning with mode "in-place": the original files are modified');
    }
    const keepDates = optionalBoolean(params, "keepDates");
    return {
      planDir: stringParam(params, "planDir"),
      mode: "in-place",
      only: stringListParam(params, "only"),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(keepDates === undefined ? {} : { keepDates }),
    };
  }
  if (params["keepDates"] !== undefined) {
    bad('"keepDates" has no meaning with mode "copy": a copy never changes the original\'s date');
  }
  return {
    planDir: stringParam(params, "planDir"),
    ...(mode === undefined ? {} : { mode: "copy" as const }),
    outputRoot: stringParam(params, "outputRoot"),
    only: stringListParam(params, "only"),
    ...(dryRun === undefined ? {} : { dryRun }),
  };
}

/**
 * The partial outputs an interrupted run of this plan left in `outputRoot`.
 *
 * Only what the plan's own log proves is the tool's: a title whose last record
 * is a copy's `started` (the run was killed before it could say `verified` or
 * `failed`), at exactly the path `partialPathFor` gives for the output that record
 * names. The engine runs one job at a time, so nothing is writing them now.
 */
export async function stalePartials(planDir: string, outputRoot: string): Promise<string[]> {
  const events = await readApplyLog(planPaths(planDir).applyLog);
  const last = new Map<string, ApplyLogEvent>();
  for (const event of events) last.set(event.input, event);
  const root = resolve(outputRoot);
  const found: string[] = [];
  for (const event of last.values()) {
    if (event.event !== "started" || event.inPlace === true || event.output === undefined) continue;
    const output = resolve(event.output);
    if (!output.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
    // The engine's own name for an unfinished copy, and nothing else.
    const partial = partialPathFor(output);
    try {
      if ((await stat(partial)).isFile()) found.push(partial);
    } catch {
      // Not there: nothing to sweep.
    }
  }
  return found;
}

/**
 * The plan's completed repairs whose copy is still on disk. The log remembers
 * a copy for good, but a copy can be moved or deleted, and a title shown as
 * "already fixed" with nothing to show for it is one the user would never fix
 * again. `apply` makes the same check (`shouldSkipForResume`) before it skips
 * a title as done.
 */
export async function copiesStillThere(
  planDir: string,
  events?: readonly ApplyLogEvent[],
): Promise<Map<string, ApplyLogEvent>> {
  const completed = completedByInput(events ?? (await readApplyLog(planPaths(planDir).applyLog)));
  const present = new Map<string, ApplyLogEvent>();
  for (const [input, event] of completed) {
    // Fixed in place: the fixed file is the original, and it is "still there"
    // for as long as the title is. Its size may have moved on since (a header
    // edit, which `plan` adopts); the record still stands.
    const inPlace = event.event === "patched" || event.event === "replaced";
    const output = event.output ?? (inPlace ? input : undefined);
    if (output === undefined) continue;
    try {
      const info = await stat(output);
      if (info.isFile() && (inPlace || event.bytes === undefined || info.size === event.bytes)) {
        present.set(input, event);
      }
    } catch {
      // Gone: not fixed, as far as anyone can see.
    }
  }
  return present;
}

function errorBody(err: unknown): ErrorBody {
  if (err instanceof RequestError) return { code: err.code, message: err.message };
  if (err instanceof DependencyMissingError) {
    return { code: "dependency-missing", message: err.message };
  }
  if (err instanceof PlanFileError) return { code: "plan-file", message: err.message };
  if (err instanceof ApplyError) return { code: "bad-request", message: err.message };
  if (err instanceof RevertError) return { code: "bad-request", message: err.message };
  return { code: "failed", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Serve requests until the input ends or `shutdown` is received. Resolves once
 * every running job has wound down (the input ending aborts them).
 */
export async function serve(io: ServeIo, engine: EngineDeps = defaultEngine): Promise<void> {
  const send = (message: Message): void => io.write(JSON.stringify(message));
  const jobs = new Map<RequestId, AbortController>();
  /** The tools chosen by hand, as the client last sent them. */
  let chosen: ToolChoices = {};
  const env = engine.env ?? process.env;
  const running = new Set<Promise<void>>();
  /** The `doctor` checks in flight: each reads the tools it began with. */
  const checks = new Set<Promise<void>>();

  const eventLogger = (id: RequestId): Logger => {
    const emit = (level: string) => (message: string) =>
      send({ id, event: "log", data: { level, message } });
    return {
      error: emit("error"),
      warn: emit("warn"),
      info: emit("info"),
      debug: () => undefined,
      trace: () => undefined,
    };
  };

  /** One watch over the dates a whole request keeps, or none when it keeps none. */
  const dateWatchFor = (id: RequestId, keepDates: boolean | undefined): DateWatch | undefined =>
    keepDates === true ? new DateWatch({ ...engine.dateWatchOptions, log: eventLogger(id) }) : undefined;

  /**
   * Wait once for the request's watch, after its last batch call and before
   * its answer, and say so first when there is time to wait: on a share that
   * can be 150 s, which looks like a hang otherwise. The cancel ends the wait
   * at once. Returns why each date that could not be kept was not, by input.
   */
  const settleDates = async (
    id: RequestId,
    watch: DateWatch,
    event: "apply.dates" | "revert.dates",
    signal: AbortSignal,
  ): Promise<Map<string, string>> => {
    const left = watch.remaining();
    if (left.files > 0 && left.waitMs > 0 && !signal.aborted) {
      send({ id, event, data: { files: left.files, seconds: Math.ceil(left.waitMs / 1000) } });
    }
    const problems = await watch.settle(signal);
    return new Map(problems.map(({ path, problem }) => [resolve(path), problem]));
  };

  /** `files` with each date that could not be kept said on its own view. */
  const withDateProblems = <T extends { input: string }>(
    files: T[],
    problems: ReadonlyMap<string, string>,
  ): (T & { dateNotKept?: string })[] =>
    files.map((f) => {
      const problem = problems.get(resolve(f.input));
      return problem === undefined ? f : { ...f, dateNotKept: problem };
    });

  const hello = (): HelloResult => ({
    name: TOOL_NAME,
    version: TOOL_VERSION,
    protocol: PROTOCOL_VERSION,
    methods: METHODS,
  });

  const plan = async (id: RequestId, raw: unknown, signal: AbortSignal): Promise<unknown> => {
    const params = parsePlanParams(raw);
    // The plan directory is written to on every file; it must not be something
    // a scan of the library would walk into, or sit among the titles.
    const holder = await insideAny(params.planDir, params.paths);
    if (holder !== null) {
      throw new RequestError(
        "unsafe-output",
        `the plan directory ${resolve(params.planDir)} is inside the folder being scanned ` +
          `(${holder}); keep it outside the library`,
      );
    }
    // `reanalyze` rebuilds a plan directory. One that holds the undo records
    // of files fixed in place is the only way back for those files: it is not
    // rebuilt on a client's say-so, whatever the engine underneath would keep.
    if (params.reanalyze === true) {
      const logged = await readApplyLog(planPaths(resolve(params.planDir)).applyLog);
      const kept = undoRecordInputs(logged);
      if (kept.length > 0) {
        throw new RequestError(
          "undo-records",
          `the plan directory ${resolve(params.planDir)} holds undo data for ` +
            `${kept.length} file(s) that were fixed in place, so it is not rebuilt automatically. ` +
            "Nothing in it was changed.",
        );
      }
    }
    const run = await engine.runPlan(
      params.paths,
      params.planDir,
      {
        aspect: params.aspect ?? "auto",
        recursive: params.recursive ?? true,
        ...(params.jobs === undefined ? {} : { jobs: params.jobs }),
        ...(params.reanalyze === undefined ? {} : { reanalyze: params.reanalyze }),
        ...(params.remuxFallback === true ? { remuxFallback: true } : {}),
      },
      {
        log: eventLogger(id),
        signal,
        onProgress: (p) => {
          switch (p.type) {
            case "targets":
              send({ id, event: "plan.targets", data: { total: p.targets.length, files: p.targets } });
              break;
            case "file-start":
              send({ id, event: "plan.file-start", data: { index: p.index, file: p.file, relative: p.relative } });
              break;
            case "file-progress":
              send({
                id,
                event: "plan.file-progress",
                data: { index: p.index, file: p.file, done: p.position, total: p.fileSize },
              });
              break;
            case "file-done":
              send({
                id,
                event: "plan.file-done",
                data: { index: p.index, analyzed: p.analyzed, file: fileView(p.entry) },
              });
              break;
          }
        },
      },
    );
    const logged = await readApplyLog(planPaths(run.dir).applyLog);
    return planResult(
      run,
      await copiesStillThere(run.dir, logged),
      unfinishedInPlace(logged),
      undoRecordInputs(logged).length,
    );
  };

  /** Refuse a fix that will not fit, before any of it is written. */
  const requireSpace = async (
    outputRoot: string,
    chosen: readonly PlanFileEntry[],
    logged: readonly ApplyLogEvent[],
  ): Promise<void> => {
    // Titles that will not be written — a copy is already there — need nothing.
    const done = completedByInput(logged);
    const toWrite: PlanFileEntry[] = [];
    for (const entry of chosen) {
      const output = outputPathFor(entry, resolve(outputRoot));
      const record = done.get(entry.input);
      const there = await stat(output).then(
        () => true,
        () => false,
      );
      if (there && (record?.event === "verified" || record === undefined)) continue;
      if (record?.event === "replaced" || record?.event === "patched") continue;
      toWrite.push(entry);
    }
    if (toWrite.length === 0) return;
    const free = engine.freeBytes ?? freeBytesAt;
    const tempDir = tmpdir();
    const [freeOutput, freeTemp, outputDevice, tempDevice] = await Promise.all([
      free(outputRoot),
      free(tempDir),
      deviceAt(outputRoot),
      deviceAt(tempDir),
    ]);
    const shortfall = spaceShortfall(spaceNeeded(toWrite), {
      outputRoot: resolve(outputRoot),
      tempDir,
      freeOutput,
      freeTemp,
      sameVolume: outputDevice !== undefined && outputDevice === tempDevice,
    });
    if (shortfall !== null) throw new RequestError("no-space", shortfall);
  };

  /** `applyPlan`'s progress as protocol events; `shift`/`total` make room for titles refused up front. */
  const forwardApply =
    (id: RequestId, shift = 0, total?: number, inPlace = false) =>
    (p: ApplyProgress): void => {
      switch (p.type) {
        case "file-start":
          send({
            id,
            event: "apply.file-start",
            data: { index: p.index + shift, total: total ?? p.total, input: p.input, relative: p.relative },
          });
          // An in-place fix has no stages to report and cannot be stopped
          // part-way; say what is happening rather than nothing.
          if (inPlace) send({ id, event: "apply.file-progress", data: { input: p.input, phase: "in-place" } });
          break;
        case "file-progress":
          send({
            id,
            event: "apply.file-progress",
            data: {
              input: p.input,
              phase: p.phase,
              ...(p.done === undefined ? {} : { done: p.done }),
              ...(p.total === undefined ? {} : { total: p.total }),
            },
          });
          break;
        case "file-done":
          send({
            id,
            event: "apply.file-done",
            data: { index: p.index + shift, total: total ?? p.total, file: applyFileView(p.result) },
          });
          break;
      }
    };

  /**
   * `apply` with `mode: "in-place"`: the chosen originals are changed where
   * they are, by `applyPlan({ inPlace: true })` and nothing else. A title that
   * has to be rebuilt cannot be done this way and is answered as refused —
   * never passed over, never fixed into a copy nobody asked for.
   */
  const applyInPlace = async (
    id: RequestId,
    params: ApplyParams,
    chosen: readonly PlanFileEntry[],
    signal: AbortSignal,
  ): Promise<ApplyResult> => {
    const planDir = resolve(params.planDir);
    const execute = params.dryRun !== true;
    const patchable = chosen.filter((f) => (f.method ?? "patch") === "patch" && f.patchFile !== undefined);
    const needCopy = chosen.filter((f) => !patchable.includes(f));

    const logged = await readApplyLog(planPaths(planDir).applyLog);
    const pending = pendingReplacements(logged);
    const halfSwapped = chosen.find((f) => pending.has(f.input));
    if (halfSwapped !== undefined) {
      throw new RequestError(
        "plan-file",
        `this plan has an unfinished --replace-original swap for ${halfSwapped.input}; ` +
          "finish it with `scope-sub apply --replace-original` on the command line first",
      );
    }
    if (execute) {
      const refused = await notWritable(patchable.map((f) => f.input));
      if (refused.length > 0) {
        throw new RequestError("not-writable", notWritableMessage(refused, patchable.length, "fix"));
      }
    }

    const total = chosen.length;
    const refusedViews: ApplyFileView[] = needCopy.map((f) => ({
      input: f.input,
      relative: f.relative,
      output: f.input,
      status: "skipped",
      reason: NEEDS_COPY_REASON,
      skipKind: "needs-copy",
      inPlace: true,
      verified: false,
      bytesWritten: 0,
      checks: [],
      elapsedMs: 0,
    }));
    refusedViews.forEach((file, index) => {
      send({ id, event: "apply.file-start", data: { index, total, input: file.input, relative: file.relative } });
      send({ id, event: "apply.file-done", data: { index, total, file } });
    });

    if (patchable.length === 0) {
      return {
        planDir,
        mode: "in-place",
        outputRoot: "",
        dryRun: !execute,
        cancelled: signal.aborted,
        summary: { planned: total, applied: 0, verified: 0, skipped: total, failed: 0, conflicts: 0, bytesWritten: 0 },
        files: refusedViews,
      };
    }
    // One watch for the request: `applyPlan` adds to it and does not wait;
    // the wait is here, once, after the last title.
    const watch = dateWatchFor(id, params.keepDates);
    let run;
    try {
      run = await engine.applyPlan(
        planDir,
        {
          inPlace: true,
          execute,
          only: patchable.map((f) => f.input),
          jobs: 1,
          ...(watch === undefined ? {} : { preserveDates: true }),
        },
        {
          log: eventLogger(id),
          signal,
          onProgress: forwardApply(id, needCopy.length, total, true),
          ...(watch === undefined ? {} : { dateWatch: watch }),
        },
      );
    } catch (err) {
      // Still waited for, and still said: a silent wait looks like a hang.
      if (watch !== undefined) await settleDates(id, watch, "apply.dates", signal);
      throw err;
    }
    const notKept = watch === undefined ? new Map<string, string>() : await settleDates(id, watch, "apply.dates", signal);
    const result = applyResult(run);
    return {
      ...result,
      mode: "in-place",
      summary: {
        ...result.summary,
        planned: result.summary.planned + needCopy.length,
        skipped: result.summary.skipped + needCopy.length,
      },
      files: [...refusedViews, ...withDateProblems(result.files, notKept)],
    };
  };

  /**
   * `revert`: the original bytes back into the original file, for titles this
   * plan fixed in place (or was interrupted fixing). One `revertPlan` call per
   * title, each aimed by a filter proven to select that title alone.
   */
  const revert = async (id: RequestId, raw: unknown, signal: AbortSignal): Promise<RevertResult> => {
    const params = parseRevertParams(raw);
    const planDir = resolve(params.planDir);
    const execute = params.dryRun !== true;
    const planFile = await requirePlan(planDir);
    const only = new Set(params.only.map((p) => resolve(p)));
    const chosen = planFile.files.filter((f) => f.action === "fix" && only.has(resolve(f.input)));
    if (chosen.length === 0) {
      throw new RequestError("bad-request", "none of the files in \"only\" is a title this plan could have fixed");
    }
    const logged = await readApplyLog(planPaths(planDir).applyLog);
    const refusal = (f: PlanFileEntry, status: string, reason: string): RevertFileView => ({
      input: f.input,
      relative: f.relative,
      status,
      reason,
      bytesChanged: 0,
      checks: [],
      elapsedMs: 0,
    });

    // Sort the chosen titles into those `revertPlan` may be called for and
    // those answered here, before anything is written.
    const aimed: { entry: PlanFileEntry; filter: string }[] = [];
    const answered = new Map<string, RevertFileView>();
    for (const entry of chosen) {
      const aim = revertAim(entry, logged);
      if (!aim.ok) {
        answered.set(entry.input, refusal(entry, aim.status, aim.reason));
        continue;
      }
      const filter = exactRevertFilter(entry, planFile.files);
      if (filter === null) {
        answered.set(
          entry.input,
          refusal(
            entry,
            "failed",
            "this title's path is part of another title's path, so it cannot be singled out here; " +
              "nothing was written. Put it back from the command line: scope-sub revert --patch-file",
          ),
        );
        continue;
      }
      aimed.push({ entry, filter });
    }
    if (execute && aimed.length > 0) {
      const refused = await notWritable(aimed.map((a) => a.entry.input));
      if (refused.length > 0) {
        throw new RequestError("not-writable", notWritableMessage(refused, aimed.length, "undo"));
      }
    }

    const run = engine.revertPlan ?? revertPlan;
    // One watch for every title: each `revertPlan` call adds to it and does
    // not wait, so the request waits once, after the last title.
    const watch = dateWatchFor(id, params.keepDates);
    let files: RevertFileView[] = [];
    const total = chosen.length;
    try {
      for (const [index, entry] of chosen.entries()) {
        const early = answered.get(entry.input);
        const target = aimed.find((a) => a.entry === entry);
        if (early === undefined && signal.aborted) break;
        send({ id, event: "revert.file-start", data: { index, total, input: entry.input, relative: entry.relative } });
        let file: RevertFileView;
        if (early !== undefined || target === undefined) {
          file = early ?? refusal(entry, "failed", "not examined");
        } else {
          try {
            const result = await run(
              planDir,
              { file: target.filter, inPlace: true, execute, ...(watch === undefined ? {} : { preserveDates: true }) },
              { log: eventLogger(id), ...(watch === undefined ? {} : { dateWatch: watch }) },
            );
            const own = result.files.find((r) => r.input === entry.input);
            // The filter was proven exact; anything else coming back is a bug
            // to say out loud, not a result to show as this title's.
            file =
              own === undefined || result.files.length !== 1
                ? refusal(entry, "failed", "the engine did not answer for exactly this title; check the file before relying on it")
                : revertFileView(own);
          } catch (err) {
            file = refusal(entry, "failed", err instanceof Error ? err.message : String(err));
          }
        }
        files.push(file);
        send({ id, event: "revert.file-done", data: { index, total, file } });
      }
    } catch (err) {
      if (watch !== undefined) await settleDates(id, watch, "revert.dates", signal);
      throw err;
    }
    // A cancel during the wait for dates stops the wait, not the undo.
    const cancelled = signal.aborted;
    if (watch !== undefined) files = withDateProblems(files, await settleDates(id, watch, "revert.dates", signal));
    return {
      planDir,
      dryRun: !execute,
      cancelled,
      summary: {
        asked: total,
        reverted: files.filter((f) => f.status === "reverted").length,
        skipped: files.filter((f) => f.status === "skipped").length,
        failed: files.filter((f) => f.status === "failed").length,
      },
      files,
    };
  };

  const apply = async (id: RequestId, raw: unknown, signal: AbortSignal): Promise<unknown> => {
    const params = parseApplyParams(raw);
    const planFile = await requirePlan(resolve(params.planDir));
    const only = new Set(params.only.map((p) => resolve(p)));
    const chosen = planFile.files.filter((f) => f.action === "fix" && only.has(resolve(f.input)));
    if (chosen.length === 0) {
      throw new RequestError("bad-request", "none of the files in \"only\" is a planned fix");
    }
    if (params.mode === "in-place") return applyInPlace(id, params, chosen, signal);
    // `parseApplyParams` requires it for a copy.
    const outputRoot = params.outputRoot as string;
    const unsafe = await unsafeOutputReason(outputRoot, chosen, planFile.files);
    if (unsafe !== null) throw new RequestError("unsafe-output", unsafe);
    // Belt and braces: what `applyPlan` itself will compute for each file.
    for (const entry of chosen) {
      if (resolve(outputPathFor(entry, resolve(outputRoot))) === resolve(entry.input)) {
        throw new RequestError("unsafe-output", `${entry.relative} would be written over the original`);
      }
    }

    // A plan the command line used with `--replace-original`, killed between
    // its two renames, has a title moved aside and nothing in its place.
    // `applyPlan` would finish that swap — a rename into the library. Not here.
    const logged = await readApplyLog(planPaths(resolve(params.planDir)).applyLog);
    const pending = pendingReplacements(logged);
    const halfSwapped = chosen.find((f) => pending.has(f.input));
    if (halfSwapped !== undefined) {
      throw new RequestError(
        "plan-file",
        `this plan has an unfinished --replace-original swap for ${halfSwapped.input}; ` +
          "finish it with `scope-sub apply --replace-original` on the command line first",
      );
    }

    if (params.dryRun !== true) {
      // What a killed run left half-written here is this plan's own; clear it
      // before the space it takes is counted against the next copy.
      for (const partial of await stalePartials(resolve(params.planDir), outputRoot)) {
        await rm(partial, { force: true });
        send({
          id,
          event: "log",
          data: { level: "info", message: `removed an unfinished copy left by an interrupted run: ${partial}` },
        });
      }
      await requireSpace(outputRoot, chosen, logged);
    }

    const run = await engine.applyPlan(
      params.planDir,
      {
        outputRoot,
        execute: params.dryRun !== true,
        only: params.only,
        // Never: a file already at an output path is a conflict, always.
        overwriteOutput: false,
        jobs: 1,
      },
      {
        log: eventLogger(id),
        signal,
        onProgress: forwardApply(id),
      },
    );
    return applyResult(run);
  };

  /** Start a job; its result or error is sent when it settles. */
  const startJob = (
    id: RequestId,
    work: (signal: AbortSignal) => Promise<unknown>,
  ): void => {
    if (jobs.size > 0) {
      send({ id, error: { code: "busy", message: "another scan or fix is still running" } });
      return;
    }
    const controller = new AbortController();
    jobs.set(id, controller);
    // The slot is freed before the reply is written, so a client that sends
    // its next job the moment it reads this one's answer is never told "busy".
    const promise = work(controller.signal)
      .then(
        (result) => {
          jobs.delete(id);
          send({ id, result });
        },
        (err: unknown) => {
          jobs.delete(id);
          send({ id, error: errorBody(err) });
        },
      )
      .finally(() => running.delete(promise));
    running.add(promise);
  };

  send({ event: "ready", data: hello() });

  for await (const rawLine of io.input) {
    const line = rawLine.trim();
    if (line === "") continue;

    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: "bad-request", message: "the line is not valid JSON" } });
      continue;
    }
    if (
      !isRecord(request) ||
      (typeof request["id"] !== "number" && typeof request["id"] !== "string") ||
      typeof request["method"] !== "string"
    ) {
      send({
        id: null,
        error: { code: "bad-request", message: 'a request needs an "id" and a "method"' },
      });
      continue;
    }
    const id = request["id"] as RequestId;
    const method = request["method"];
    const params = request["params"];

    try {
      switch (method) {
        case "hello":
          send({ id, result: hello() });
          break;
        case "doctor": {
          // Not a job: it is quick, and the app asks while nothing else runs.
          // The answer is about the choice this check began with.
          const asked = { ...chosen };
          const promise = engine
            .runDoctor(engine.env === undefined ? {} : { env: engine.env })
            .then(
              (report) => send({ id, result: doctorResult(report, asked) }),
              (err: unknown) => send({ id, error: errorBody(err) }),
            )
            .finally(() => {
              running.delete(promise);
              checks.delete(promise);
            });
          running.add(promise);
          checks.add(promise);
          break;
        }
        case "configure": {
          // A job in hand resolved its tools when it began; changing them
          // under it would have half a title read by one build and half by another.
          if (jobs.size > 0) {
            send({ id, error: { code: "busy", message: "a scan or fix is running; change the tools when it has finished" } });
            break;
          }
          const next = parseConfigureParams(params);
          // A check already under way finishes on the tools it started with,
          // rather than find them changed half-way through.
          await Promise.allSettled([...checks]);
          chosen = next;
          applyChoices(env, chosen);
          // The search is remembered per process; what it found no longer holds.
          clearToolCache();
          const result: ConfigureResult = { tools: { ...chosen } };
          send({ id, result });
          break;
        }
        case "plan":
          startJob(id, (signal) => plan(id, params, signal));
          break;
        case "apply":
          startJob(id, (signal) => apply(id, params, signal));
          break;
        case "revert":
          startJob(id, (signal) => revert(id, params, signal));
          break;
        case "cancel": {
          if (!isRecord(params) || (typeof params["id"] !== "number" && typeof params["id"] !== "string")) {
            bad('cancel needs params: {"id": <the request to cancel>}');
          }
          const target = jobs.get((params as Record<string, unknown>)["id"] as RequestId);
          target?.abort();
          send({ id, result: { cancelled: target !== undefined } });
          break;
        }
        case "shutdown":
          for (const controller of jobs.values()) controller.abort();
          await Promise.allSettled([...running]);
          send({ id, result: {} });
          return;
        default:
          send({ id, error: { code: "unknown-method", message: `unknown method "${method}"` } });
      }
    } catch (err) {
      send({ id, error: errorBody(err) });
    }
  }

  // The client went away: stop what is running rather than finish it unseen.
  for (const controller of jobs.values()) controller.abort();
  await Promise.allSettled([...running]);
}
