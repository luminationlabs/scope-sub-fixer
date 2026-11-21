/**
 * `scope-sub fix` — repair one MKV into a new file (PRD §12).
 *
 * Both methods are driven by the exact same `MovePlan` the scanner reports, so
 * the fixer can never move something `scan` would not have flagged.
 *
 *   patch  byte-copy the input and rewrite the PCS/WDS position fields in
 *          place. The output differs from the input only in those u16 fields.
 *   remux  mkvextract the track, rewrite it, mkvmerge it back in. Needed when
 *          the track is Matroska-compressed, and the route to the A/B mode of
 *          PRD §31.
 */
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { PgsParseError } from "../pgs/errors.js";
import { parseSupSegments } from "../pgs/parse.js";
import { serializeSup } from "../pgs/serialize.js";
import { buildDisplaySets, buildEpochs } from "../pgs/compose.js";
import { BLOCK_HEADER_SIZE, SUP_HEADER_SIZE, type BytePatch } from "../pgs/patch.js";
import { DependencyMissingError, SpawnAbortedError, type MkvTrackSummary } from "../mkv/inspect.js";
import { toolPath } from "../tools/locate.js";
import type { PgsBlockRecord } from "../mkv/pgsBlocks.js";
import { analyzeFile, type FileAnalysis, type ScanDeps, type ScanOptions, type TrackAnalysis } from "../scan/analyze.js";
import { silentLogger, type Logger } from "../scan/log.js";
import { applyPlanToDisplaySets, rewriteSegments } from "./patchPlan.js";
import { copyWithPatches } from "./copyPatch.js";
import { verifyPatchBytes } from "./patchFile.js";
import {
  buildRemuxArgs,
  extractTrackToFile,
  makeTempDir,
  removeTempDir,
  runMkvmerge,
  writeSupFile,
  type CorrectedTrackSpec,
  type SourceTrackRef,
} from "./remux.js";
import type { FixMethod, FixResult, FixTrackResult } from "./types.js";

/** Exit codes from PRD §20 that `fix` can produce. */
export const FIX_EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  DEPENDENCY_MISSING: 3,
  UNSUPPORTED_MEDIA: 4,
  PGS_PARSE_ERROR: 5,
  REMUX_FAILURE: 6,
  VALIDATION_FAILURE: 7,
  OUTPUT_CONFLICT: 8,
} as const;

export type FixErrorKind =
  | "BAD_ARGS"
  | "DEPENDENCY_MISSING"
  | "UNSUPPORTED_MEDIA"
  | "PGS_PARSE_ERROR"
  | "REMUX_FAILURE"
  | "VALIDATION_FAILURE"
  | "OUTPUT_CONFLICT";

/** A refusal or failure with the PRD §20 exit code already attached. */
export class FixError extends Error {
  readonly kind: FixErrorKind;
  readonly exitCode: number;
  readonly detail: string | undefined;

  constructor(kind: FixErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "FixError";
    this.kind = kind;
    this.exitCode = FIX_EXIT[kind];
    this.detail = detail;
  }
}

export interface FixOptions extends ScanOptions {
  output: string;
  method?: FixMethod;
  keepOriginalSubtitle?: boolean;
  dryRun?: boolean;
  overwriteOutput?: boolean;
}

/** The stages of a remux, in order; `analyze` is the fresh read of the input. */
export type FixPhase = "analyze" | "extract" | "rebuild";

export interface FixDeps extends ScanDeps {
  log?: Logger;
  mkvmergePath?: string;
  mkvextractPath?: string;
  /** Called as each stage of a remux begins. */
  onPhase?: (phase: FixPhase) => void;
  // `signal` (from ScanDeps) also stops a remux: the running mkvextract or
  // mkvmerge is terminated, the temp directory removed, and the half-written
  // output deleted.
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function emptyTrackResult(a: TrackAnalysis): FixTrackResult {
  return {
    trackId: a.track.id,
    trackNumber: a.track.number,
    language: a.track.language,
    name: a.track.name,
    status: a.status,
    eventCount: a.events.length,
    offendingEventCount: a.offendingEventCount,
    eventsMoved: 0,
    displaySetsPatched: 0,
    positionFieldsChanged: 0,
    bytesChanged: 0,
    fixed: false,
    compressed: a.compressed,
    skipped: [...new Set((a.plan?.skipped ?? []).map((s) => s.reason))],
    notes: a.notes,
    error: a.error,
  };
}

/** Blocks whose bytes a patch would rewrite, for the cluster-CRC check. */
export function blockCoveringOffset(
  blocks: readonly PgsBlockRecord[],
  offset: number,
): PgsBlockRecord | undefined {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid]!;
    if (offset < b.fileOffset) hi = mid - 1;
    else if (offset >= b.fileOffset + b.fileLength) lo = mid + 1;
    else return b;
  }
  return undefined;
}

export function countChangedBytes(patches: readonly BytePatch[]): number {
  let n = 0;
  for (const p of patches) {
    for (let i = 0; i < p.length; i++) if (p.before[i] !== p.after[i]) n++;
  }
  return n;
}

function analysisFailure(analysis: FileAnalysis): FixError | null {
  if (analysis.status !== "ERROR") return null;
  const kind: FixErrorKind =
    analysis.errorKind === "DEPENDENCY_MISSING"
      ? "DEPENDENCY_MISSING"
      : analysis.errorKind === "PGS_PARSE"
        ? "PGS_PARSE_ERROR"
        : "UNSUPPORTED_MEDIA";
  const detail =
    analysis.error ?? analysis.tracks.map((t) => t.error).filter(Boolean).join("; ");
  return new FixError(kind, `${analysis.file} could not be analyzed`, detail);
}

/** Tracks with at least one planned move, in track order. */
function tracksNeedingFix(analysis: FileAnalysis): TrackAnalysis[] {
  return analysis.tracks.filter((t) => (t.plan?.entries.length ?? 0) > 0);
}

async function fixByPatch(
  input: string,
  output: string,
  targets: readonly TrackAnalysis[],
  results: Map<number, FixTrackResult>,
  dryRun: boolean,
  log: Logger,
): Promise<{ wrote: boolean; patches: BytePatch[] }> {
  const all: BytePatch[] = [];

  for (const t of targets) {
    if (t.compressed) {
      throw new FixError(
        "UNSUPPORTED_MEDIA",
        `track ${t.track.id} uses Matroska content compression, so its PGS segments are not byte-addressable in the file`,
        "re-run with --method remux",
      );
    }
    if (t.blocks.length === 0) {
      throw new FixError(
        "UNSUPPORTED_MEDIA",
        `track ${t.track.id} was not read with the direct block reader, so its segment offsets do not address file bytes`,
        "re-run with --source direct, or with --method remux",
      );
    }

    const application = applyPlanToDisplaySets(
      t.displaySets,
      t.epochByDisplaySet,
      t.plan!,
      BLOCK_HEADER_SIZE,
    );

    for (const p of application.patches) {
      const block = blockCoveringOffset(t.blocks, p.offset);
      if (!block) {
        throw new FixError(
          "UNSUPPORTED_MEDIA",
          `patch at offset ${p.offset} on track ${t.track.id} falls outside every known PGS block`,
        );
      }
      if (block.clusterHasCrc) {
        throw new FixError(
          "UNSUPPORTED_MEDIA",
          `the cluster at offset ${block.clusterOffset} carries a CRC-32 element, which an in-place patch would invalidate`,
          "re-run with --method remux",
        );
      }
    }

    const r = results.get(t.track.id)!;
    r.eventsMoved = application.eventsMoved;
    r.displaySetsPatched = application.displaySetsTouched;
    r.positionFieldsChanged = application.patches.length;
    r.bytesChanged = countChangedBytes(application.patches);
    r.fixed = true;
    all.push(...application.patches);
    log.info(
      `track ${t.track.id}: ${application.eventsMoved} event(s) moved across ` +
        `${application.displaySetsTouched} display set(s), ${application.patches.length} position field(s)`,
    );
  }

  all.sort((a, b) => a.offset - b.offset);

  // Prove the offsets address what we think they address before anything is
  // written. A mismatch here means the reader and the file disagree.
  log.info(`checking ${all.length} patch site(s) against the input`);
  await verifyPatchBytes(input, all, "before");

  if (dryRun) return { wrote: false, patches: all };

  // One pass: the bytes are patched as they are copied, and a `before` mismatch
  // part-way through deletes the partial output rather than leaving a full-size
  // half-patched file behind.
  const copy = await copyWithPatches(input, output, all);
  log.info(
    `copied ${copy.bytesWritten} bytes to ${output}, applied ${copy.patchesApplied} ` +
      `patch(es), ${copy.bytesChanged} byte(s) changed`,
  );

  // Read the patched ranges back out of the finished file.
  log.info(`verifying ${all.length} patched range(s) in the output`);
  await verifyPatchBytes(output, all, "after");
  return { wrote: true, patches: all };
}

/** Fill in a track result without touching the filesystem (dry runs). */
function countPlannedMoves(t: TrackAnalysis, r: FixTrackResult): void {
  const application = applyPlanToDisplaySets(
    t.displaySets,
    t.epochByDisplaySet,
    t.plan!,
    BLOCK_HEADER_SIZE,
  );
  r.eventsMoved = application.eventsMoved;
  r.displaySetsPatched = application.displaySetsTouched;
  r.positionFieldsChanged = application.patches.length;
  r.bytesChanged = countChangedBytes(application.patches);
}

/**
 * Every track of the source in container order. mkvmerge assigns its track ids
 * in that order, so the list drives `--track-order` directly. A type mkvmerge
 * does not mux (buttons, or anything it reports that is not one of the three)
 * is kept in the list but typed "other", so `buildRemuxArgs` can leave it out
 * of the order.
 */
function sourceTrackRefs(tracks: readonly MkvTrackSummary[]): SourceTrackRef[] {
  return [...tracks]
    .sort((a, b) => a.id - b.id)
    .map((t) => ({
      id: t.id,
      type:
        t.type === "video" || t.type === "audio" || t.type === "subtitles"
          ? t.type
          : ("other" as const),
    }));
}

async function fixByRemux(
  input: string,
  output: string,
  analysis: FileAnalysis,
  targets: readonly TrackAnalysis[],
  results: Map<number, FixTrackResult>,
  options: FixOptions,
  deps: FixDeps,
  log: Logger,
): Promise<boolean> {
  const all = analysis.info?.tracks;
  if (!all || all.length === 0) {
    throw new FixError(
      "UNSUPPORTED_MEDIA",
      `${input}: mkvmerge reported no tracks, so --track-order cannot be rebuilt`,
    );
  }
  const sourceTracks = sourceTrackRefs(all);

  if (options.dryRun === true) {
    for (const t of targets) {
      countPlannedMoves(t, results.get(t.track.id)!);
      results.get(t.track.id)!.fixed = true;
    }
    const args = buildRemuxArgs({
      input,
      output,
      sourceTracks,
      corrected: targets.map((t) => ({
        sourceTrackId: t.track.id,
        supPath: `<temp>/track-${t.track.id}.fixed.sup`,
        language: t.track.language,
        name: t.track.name,
        default: t.track.default,
        forced: t.track.forced,
        hearingImpaired: t.track.hearingImpaired,
      })),
      keepOriginal: options.keepOriginalSubtitle === true,
    });
    log.info(`would run: mkvmerge ${args.join(" ")}`);
    return false;
  }

  if (options.tempDir !== undefined) {
    const wanted = resolve(options.tempDir);
    const sourceDir = resolve(dirname(input));
    if (wanted === sourceDir || wanted.startsWith(`${sourceDir}${sep}`)) {
      throw new FixError(
        "BAD_ARGS",
        `--temp-dir ${options.tempDir} is inside the source directory`,
      );
    }
  }

  const tempDir = await makeTempDir(options.tempDir);
  let merging = false;
  try {
    const corrected: CorrectedTrackSpec[] = [];
    deps.onPhase?.("extract");
    for (const t of targets) {
      const supPath = join(tempDir, `track-${t.track.id}.sup`);
      log.info(`extracting track ${t.track.id} to ${supPath}`);
      await extractTrackToFile(
        input,
        t.track.id,
        supPath,
        deps.mkvextractPath ?? toolPath("mkvextract"),
        deps.signal,
      );
      const original = parseSupSegments(await readFile(supPath));
      const displaySets = buildDisplaySets(original);
      if (displaySets.length !== t.displaySets.length) {
        throw new FixError(
          "VALIDATION_FAILURE",
          `track ${t.track.id}: mkvextract produced ${displaySets.length} display sets but the analyzer saw ${t.displaySets.length}`,
        );
      }
      const epochByDisplaySet = new Map<number, number>();
      for (const epoch of buildEpochs(displaySets)) {
        for (const ds of epoch.displaySets) epochByDisplaySet.set(ds.index, epoch.index);
      }
      const application = applyPlanToDisplaySets(
        displaySets,
        epochByDisplaySet,
        t.plan!,
        SUP_HEADER_SIZE,
      );
      const fixedPath = join(tempDir, `track-${t.track.id}.fixed.sup`);
      await writeSupFile(fixedPath, serializeSup(rewriteSegments(original, application)));

      const r = results.get(t.track.id)!;
      r.eventsMoved = application.eventsMoved;
      r.displaySetsPatched = application.displaySetsTouched;
      r.positionFieldsChanged = application.patches.length;
      r.bytesChanged = countChangedBytes(application.patches);
      r.fixed = true;
      log.info(
        `track ${t.track.id}: ${application.eventsMoved} event(s) moved across ` +
          `${application.displaySetsTouched} display set(s)`,
      );

      corrected.push({
        sourceTrackId: t.track.id,
        supPath: fixedPath,
        language: t.track.language,
        name: t.track.name,
        default: t.track.default,
        forced: t.track.forced,
        hearingImpaired: t.track.hearingImpaired,
      });
    }

    const args = buildRemuxArgs({
      input,
      output,
      sourceTracks,
      corrected,
      keepOriginal: options.keepOriginalSubtitle === true,
    });
    log.debug(`mkvmerge ${args.join(" ")}`);
    log.info("remuxing with mkvmerge");
    deps.onPhase?.("rebuild");
    merging = true;
    await runMkvmerge(args, deps.mkvmergePath ?? toolPath("mkvmerge"), deps.signal);
    merging = false;
    return true;
  } catch (err) {
    // A cancelled mkvmerge leaves a truncated file where the result belongs.
    if (merging && err instanceof SpawnAbortedError) await rm(output, { force: true });
    throw err;
  } finally {
    // PRD §12.5: temp files are cleaned up unless --keep-temp asked otherwise.
    if (options.keepTemp) log.info(`temp files kept at ${tempDir}`);
    else await removeTempDir(tempDir);
  }
}

/** Repair one MKV. Throws `FixError` for anything the operator must decide about. */
export async function fixFile(
  input: string,
  options: FixOptions,
  deps: FixDeps = {},
): Promise<FixResult> {
  const started = Date.now();
  const log = deps.log ?? silentLogger;
  const method: FixMethod = options.method ?? "patch";
  const inputPath = resolve(input);
  const outputPath = resolve(options.output);

  if (inputPath === outputPath) {
    throw new FixError("OUTPUT_CONFLICT", "the output path is the input path");
  }
  if (!(await exists(inputPath))) {
    throw new FixError("BAD_ARGS", `${input} does not exist`);
  }
  if (!options.dryRun && (await exists(outputPath))) {
    if (options.overwriteOutput !== true) {
      throw new FixError(
        "OUTPUT_CONFLICT",
        `${options.output} already exists`,
        "pass --overwrite-output to replace it",
      );
    }
    log.warn(`overwriting ${options.output}`);
  }

  let analysis: FileAnalysis;
  try {
    if (method === "remux") deps.onPhase?.("analyze");
    const signal = deps.signal;
    analysis = await analyzeFile(inputPath, options, {
      ...deps,
      log,
      ...(signal === undefined
        ? {}
        : {
            // Throwing here is how a read is abandoned (see ScanDeps).
            onReadProgress: (position: number, fileSize: number): void => {
              if (signal.aborted) throw new Error("cancelled");
              deps.onReadProgress?.(position, fileSize);
            },
          }),
    });
    // An abandoned analysis comes back as an error result; it is not a verdict.
    if (signal?.aborted === true) throw new Error("cancelled");
  } catch (err) {
    if (err instanceof DependencyMissingError) {
      throw new FixError("DEPENDENCY_MISSING", err.message);
    }
    if (err instanceof PgsParseError) {
      throw new FixError("PGS_PARSE_ERROR", err.message);
    }
    throw err;
  }
  const failure = analysisFailure(analysis);
  if (failure) throw failure;

  const results = new Map<number, FixTrackResult>();
  for (const t of analysis.tracks) results.set(t.track.id, emptyTrackResult(t));

  const targets = tracksNeedingFix(analysis);
  const notes: string[] = [...analysis.notes];
  let wrote = false;

  if (targets.length === 0) {
    notes.push("no PGS events need moving; no output was written");
    log.info("nothing to fix");
  } else if (method === "patch") {
    ({ wrote } = await fixByPatch(
      inputPath,
      outputPath,
      targets,
      results,
      options.dryRun === true,
      log,
    ));
  } else {
    wrote = await fixByRemux(
      inputPath,
      outputPath,
      analysis,
      targets,
      results,
      options,
      deps,
      log,
    );
  }

  const tracks = [...results.values()];
  const inputBytes = (await stat(inputPath)).size;
  const outputBytes = wrote ? (await stat(outputPath)).size : undefined;

  return {
    input: inputPath,
    output: outputPath,
    method,
    dryRun: options.dryRun === true,
    wrote,
    keepOriginalSubtitle: options.keepOriginalSubtitle === true,
    aspect: options.aspect,
    activeArea: analysis.activeArea,
    inputBytes,
    outputBytes,
    tracks,
    totals: {
      tracksFixed: tracks.filter((t) => t.fixed).length,
      eventsMoved: tracks.reduce((n, t) => n + t.eventsMoved, 0),
      displaySetsPatched: tracks.reduce((n, t) => n + t.displaySetsPatched, 0),
      positionFieldsChanged: tracks.reduce((n, t) => n + t.positionFieldsChanged, 0),
      bytesChanged: tracks.reduce((n, t) => n + t.bytesChanged, 0),
    },
    notes,
    elapsedMs: Date.now() - started,
  };
}
