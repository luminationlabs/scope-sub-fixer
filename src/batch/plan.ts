/**
 * `scope-sub plan` — analyze a library and write a reviewable plan (PRD §17).
 *
 * The analysis is the very same `analyzeFile` pipeline `scan` and `fix` run, so
 * a plan can never propose a move the scanner would not have reported. What
 * `plan` adds is the decision — fix or skip, and why — plus, for the patch
 * method, the exact bytes the repair will change, so `apply` can replay a
 * reviewed plan without analyzing anything again.
 *
 * Everything uncertain skips (PRD §26). The plan optimizes for preserving
 * originals, not for maximizing the number of files processed.
 */
import { access, open, stat } from "node:fs/promises";
import { basename, join, relative as relativePath, resolve } from "node:path";
import { applyPlanToDisplaySets, type DeltaApplication } from "../fix/patchPlan.js";
import { blockCoveringOffset, countChangedBytes } from "../fix/fixFile.js";
import type { FixMethod } from "../fix/types.js";
import { BLOCK_HEADER_SIZE, type BytePatch } from "../pgs/patch.js";
import {
  analyzeFile,
  refusedOffendingCount,
  type FileAnalysis,
  type ScanDeps,
  type ScanOptions,
  type TrackAnalysis,
} from "../scan/analyze.js";
import { defaultMargin } from "../geometry/classify.js";
import { silentLogger } from "../scan/log.js";
import { isUsableArea } from "../video/activeArea.js";
import { collectMkvFiles, isMkvPath } from "../scan/scanPaths.js";
import type { FileStatus } from "../scan/types.js";
import { inspectMkv, type MkvInfo } from "../mkv/inspect.js";
import { scanPatchState } from "./revert.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import { fingerprintTrack, objectsOutsideWindow } from "../verify/pgs.js";
import {
  appendApplyLog,
  completedByInput,
  lastWriteToInput,
  readApplyLog,
  type ApplyLogEvent,
} from "./log.js";
import {
  ACTIVE_AREA_RULES,
  PLACEMENT_RULES,
  PLAN_RULES_VERSION,
  PLAN_SCHEMA_VERSION,
  PlanFileError,
  decodePatch,
  decodePatches,
  encodePatches,
  nextPatchFileName,
  planPaths,
  planRulesOf,
  readPatchFile,
  readPlan,
  sameMtime,
  writePatchFile,
  storedRelative,
  writePlan,
  type PatchFile,
  type PatchFileTrack,
  type PlanAction,
  type PlanFile,
  type PlanFileEntry,
  type PlanMove,
  type PlanTrackEntry,
} from "./planFile.js";

// --- target collection ----------------------------------------------------

export interface PlanTarget {
  file: string;
  /** The directory this file was found under, when a directory was given. */
  root?: string;
  /** Output path relative to `--output-root`. */
  relative: string;
}

/**
 * Resolve the command-line paths to MKVs, remembering where each came from.
 *
 * A file given by name maps to its basename under `--output-root`; a file found
 * under a directory scanned with `--recursive` keeps its subdirectories, so the
 * output tree mirrors the library.
 */
export async function collectPlanTargets(
  paths: readonly string[],
  recursive: boolean,
): Promise<{ targets: PlanTarget[]; missing: string[] }> {
  const targets = new Map<string, PlanTarget>();
  const missing: string[] = [];

  for (const path of paths) {
    const full = resolve(path);
    let info;
    try {
      info = await stat(full);
    } catch {
      missing.push(path);
      continue;
    }
    if (info.isDirectory()) {
      const { files } = await collectMkvFiles([full], recursive);
      for (const file of files) {
        if (targets.has(file)) continue;
        targets.set(file, {
          file,
          root: full,
          relative: recursive ? storedRelative(relativePath(full, file)) : basename(file),
        });
      }
    } else if (isMkvPath(full)) {
      if (!targets.has(full)) targets.set(full, { file: full, relative: basename(full) });
    }
    // A non-.mkv file given explicitly is skipped, as in `scan`.
  }

  return {
    targets: [...targets.values()].sort((a, b) => (a.file < b.file ? -1 : 1)),
    missing,
  };
}

// --- the decision ---------------------------------------------------------

export interface TrackDecision {
  analysis: TrackAnalysis;
  action: PlanAction;
  reason: string | undefined;
  /** The edits this track would receive. Null when it is skipped. */
  application: DeltaApplication | null;
}

export interface FileDecision {
  action: PlanAction;
  reason: string | undefined;
  tracks: TrackDecision[];
  notes: string[];
}

function skipTrack(
  analysis: TrackAnalysis,
  reason: string,
  application: DeltaApplication | null = null,
): TrackDecision {
  return { analysis, action: "skip", reason, application };
}

/** Decide what, if anything, may be done to one PGS track. */
export function decideTrack(t: TrackAnalysis, method: FixMethod): TrackDecision {
  if (t.status === "ERROR") {
    return skipTrack(t, t.error ?? "the track could not be read");
  }
  if ((t.plan?.entries.length ?? 0) === 0) {
    if (t.status === "NEEDS_FIX") {
      return skipTrack(
        t,
        `${t.offendingEventCount} offending event(s), but the move policy refused every one` +
          (t.plan?.skipped[0] ? `: ${t.plan.skipped[0].reason}` : ""),
      );
    }
    if (t.status === "AMBIGUOUS") {
      return skipTrack(t, t.notes[0] ?? "the track could not be classified");
    }
    return skipTrack(t, "no events outside the active area");
  }

  if (method === "patch") {
    if (t.compressed) {
      return skipTrack(
        t,
        "Matroska content compression: the PGS segments are not byte-addressable (use --method remux)",
      );
    }
    if (t.blocks.length === 0) {
      return skipTrack(
        t,
        "the track was not read with the direct block reader, so its offsets do not address file bytes",
      );
    }
  }

  const application = applyPlanToDisplaySets(
    t.displaySets,
    t.epochByDisplaySet,
    t.plan!,
    BLOCK_HEADER_SIZE,
  );
  if (application.patches.length === 0) {
    return skipTrack(t, "the move plan produced no edits", application);
  }

  if (method === "patch") {
    for (const p of application.patches) {
      const block = blockCoveringOffset(t.blocks, p.offset);
      if (!block) {
        return skipTrack(
          t,
          `an edit at offset ${p.offset} falls outside every known PGS block`,
          application,
        );
      }
      if (block.clusterHasCrc) {
        return skipTrack(
          t,
          `the cluster at offset ${block.clusterOffset} carries a CRC-32 element, ` +
            "which an in-place patch would invalidate (use --method remux)",
          application,
        );
      }
    }
  }

  return { analysis: t, action: "fix", reason: undefined, application };
}

function ambiguousReason(analysis: FileAnalysis): string {
  const notes = analysis.tracks
    .filter((t) => t.status === "AMBIGUOUS" || t.status === "ERROR")
    .flatMap((t) => (t.error ? [t.error] : t.notes))
    .filter((n) => n.length > 0);
  return notes[0] ?? "the analysis was ambiguous";
}

/**
 * Decide what happens to one file (PRD §26): "fix" only for a NEEDS_FIX file
 * with a constant active area and at least one track that can be repaired by
 * the chosen method. Everything else skips, with the reason recorded.
 */
export function decideAction(analysis: FileAnalysis, method: FixMethod): FileDecision {
  const tracks = analysis.tracks.map((t) => decideTrack(t, method));
  const notes = [...analysis.notes];
  // The area's own note is the only place that says which shape was used.
  if (analysis.activeArea?.classification === "MIXED_NARROWEST") {
    notes.push(...analysis.activeArea.notes.filter((n) => n.startsWith(MIXED_NARROWEST_NOTE)));
  }

  const skipFile = (reason: string): FileDecision => ({
    action: "skip",
    reason,
    // Nothing is written, so no track carries an action of its own.
    tracks: tracks.map((t) => ({
      ...t,
      action: "skip" as const,
      reason: t.reason ?? reason,
      application: null,
    })),
    notes,
  });

  switch (analysis.status) {
    case "ERROR":
      return skipFile(analysis.error ?? ambiguousReason(analysis));
    case "NO_PGS":
      return skipFile(analysis.notes[0] ?? "no PGS subtitle tracks");
    case "MIXED_ASPECT_RATIO":
      return skipFile("variable aspect ratio: no single picture area applies");
    default:
      break;
  }

  const active = analysis.activeArea;
  if (!active) {
    return skipFile("the active picture area could not be determined");
  }
  if (!isUsableArea(active)) {
    return skipFile(`the active picture area is ${active.classification}`);
  }

  if (analysis.status === "OK") {
    // The no-letterbox fast path left a note saying the tracks were not read;
    // it is the honest reason, so prefer it over the one that implies they were.
    const notRead = analysis.notes.find((n) => n.startsWith("no letterbox bars"));
    return skipFile(notRead ?? "no subtitle events outside the active area");
  }
  if (analysis.status === "AMBIGUOUS") {
    return skipFile(ambiguousReason(analysis));
  }

  const fixable = tracks.filter((t) => t.action === "fix");
  if (fixable.length === 0) {
    const blocked =
      tracks.find((t) => t.analysis.status === "NEEDS_FIX" && t.reason !== undefined) ??
      tracks.find((t) => t.reason !== undefined);
    return skipFile(blocked?.reason ?? "no track could be fixed");
  }

  for (const t of tracks) {
    if (t.action === "skip" && t.analysis.status !== "OK") {
      notes.push(`track ${t.analysis.track.id} skipped: ${t.reason ?? "unknown reason"}`);
    }
  }

  return { action: "fix", reason: undefined, tracks, notes };
}

/** Marks an entry's note that explains why it is a remux in a patch plan. */
export const REMUX_FALLBACK_NOTE = "planned for remux";

/**
 * `decideAction`, with the per-title fallback: under the patch method, a title
 * that remux could repair more tracks of than patching can is decided as a
 * remux. Pure, like the table it wraps.
 */
export function decideWithFallback(
  analysis: FileAnalysis,
  method: FixMethod,
  remuxFallback: boolean,
): { decision: FileDecision; method: FixMethod } {
  const decision = decideAction(analysis, method);
  if (!remuxFallback || method !== "patch") return { decision, method };
  const viaRemux = decideAction(analysis, "remux");
  const count = (d: FileDecision): number => d.tracks.filter((t) => t.action === "fix").length;
  if (viaRemux.action !== "fix" || count(viaRemux) <= count(decision)) {
    return { decision, method };
  }
  // Why patching was not enough: the refusal of a track only remux can fix.
  const fixedByPatch = new Set(
    decision.tracks.filter((t) => t.action === "fix").map((t) => t.analysis.track.id),
  );
  const why = decision.tracks.find(
    (t) => !fixedByPatch.has(t.analysis.track.id) && t.analysis.status === "NEEDS_FIX",
  )?.reason;
  return {
    decision: {
      ...viaRemux,
      notes: [...viaRemux.notes, `${REMUX_FALLBACK_NOTE}: ${why ?? decision.reason ?? "the patch method cannot fix it"}`],
    },
    method: "remux",
  };
}

// --- plan entries ---------------------------------------------------------

function trackEntry(decision: TrackDecision): PlanTrackEntry {
  const t = decision.analysis.track;
  return {
    mkvmerge_id: t.id,
    matroska_number: t.number,
    language: t.language,
    ...(t.name === undefined ? {} : { name: t.name }),
    forced: t.forced,
    default: t.default,
    ...(decision.analysis.eventsRead
      ? { event_count: decision.analysis.events.length }
      : {}),
    offending_event_count: decision.analysis.offendingEventCount,
    status: decision.analysis.status,
    action: decision.action,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  };
}

function movesOf(t: TrackAnalysis): PlanMove[] {
  const moves: PlanMove[] = [];
  for (const entry of t.plan?.entries ?? []) {
    const event = t.events[entry.eventIndex];
    for (const object of entry.objects) {
      moves.push({
        event_index: entry.eventIndex,
        pts_ms: event?.ptsMs ?? 0,
        object_id: object.objectId,
        window_id: object.windowId,
        dx: object.delta.dx,
        dy: object.delta.dy,
        ...(object.movedForConsistency ? { for_consistency: true } : {}),
      });
    }
  }
  return moves;
}

function patchFileTrack(decision: TrackDecision): PatchFileTrack {
  const t = decision.analysis;
  const application = decision.application!;
  const bounds = t.bounds ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const skipped = [...new Set((t.plan?.skipped ?? []).map((s) => s.reason))];
  return {
    mkvmerge_id: t.track.id,
    matroska_number: t.track.number,
    language: t.track.language,
    ...(t.track.name === undefined ? {} : { name: t.track.name }),
    event_count: t.events.length,
    offending_event_count: t.offendingEventCount,
    events_moved: application.eventsMoved,
    display_sets_patched: application.displaySetsTouched,
    position_fields: application.patches.length,
    bytes_changed: countChangedBytes(application.patches),
    canvas: { width: t.canvasWidth ?? 0, height: t.canvasHeight ?? 0 },
    active_on_canvas: {
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
    },
    margin: t.margin,
    expected_offending_after: refusedOffendingCount(t),
    outside_window: objectsOutsideWindow(t.events),
    ...(skipped.length === 0 ? {} : { skipped }),
    moves: movesOf(t),
    fingerprint: fingerprintTrack(t.displaySets),
  };
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** The complete byte-level description of one file's repair. */
export function buildPatchFile(
  analysis: FileAnalysis,
  decision: FileDecision,
  stamp: FileStamp,
  method: FixMethod,
): PatchFile {
  const fixTracks = decision.tracks.filter((t) => t.action === "fix");
  const patches: BytePatch[] = [];
  if (method === "patch") {
    for (const t of fixTracks) patches.push(...(t.application?.patches ?? []));
  }
  return {
    schema: PLAN_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION, rules: PLAN_RULES_VERSION },
    placement_rules: PLACEMENT_RULES,
    created: new Date().toISOString(),
    input: analysis.file,
    size: stamp.size,
    mtimeMs: stamp.mtimeMs,
    method,
    tracks: fixTracks.map(patchFileTrack),
    patches: encodePatches(patches),
  };
}

export interface BuildEntryOptions {
  target: PlanTarget;
  stamp: FileStamp;
  method: FixMethod;
  /** Relative path of the patch file, when one was written. */
  patchFile?: string;
  analysisMs?: number;
}

export function buildPlanEntry(
  analysis: FileAnalysis,
  decision: FileDecision,
  options: BuildEntryOptions,
): PlanFileEntry {
  const fixTracks = decision.tracks.filter((t) => t.action === "fix");
  const active = analysis.activeArea;
  const compressed = analysis.tracks.some((t) => t.compressed);
  const summary = {
    tracks: fixTracks.length,
    events_moved: fixTracks.reduce((n, t) => n + (t.application?.eventsMoved ?? 0), 0),
    display_sets: fixTracks.reduce(
      (n, t) => n + (t.application?.displaySetsTouched ?? 0),
      0,
    ),
    position_fields: fixTracks.reduce((n, t) => n + (t.application?.patches.length ?? 0), 0),
    bytes_changed: fixTracks.reduce(
      (n, t) => n + countChangedBytes(t.application?.patches ?? []),
      0,
    ),
  };

  return {
    input: analysis.file,
    ...(options.target.root === undefined ? {} : { root: options.target.root }),
    relative: options.target.relative,
    size: options.stamp.size,
    mtimeMs: options.stamp.mtimeMs,
    ...(analysis.info?.segmentUid === undefined ? {} : { segment_uid: analysis.info.segmentUid }),
    status: analysis.status,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    video: analysis.video ? { w: analysis.video.width, h: analysis.video.height } : null,
    active_area: active
      ? {
          top: active.top,
          bottom: active.bottom,
          left: active.left,
          right: active.right,
          aspect: active.aspect,
          source: active.source,
          classification: active.classification,
        }
      : null,
    tracks: decision.tracks.map(trackEntry),
    action: decision.action,
    ...(options.patchFile === undefined ? {} : { patchFile: options.patchFile }),
    ...(decision.action === "fix" ? { patch_summary: summary } : {}),
    ...(compressed ? { compressed: true } : {}),
    method: options.method,
    ...(decision.notes.length === 0 ? {} : { notes: decision.notes }),
    analyzed: new Date().toISOString(),
    ...(options.analysisMs === undefined ? {} : { analysis_ms: options.analysisMs }),
    area_rules: ACTIVE_AREA_RULES,
  };
}

/** How the note on a title judged by its narrowest repeated shape begins. */
export const MIXED_NARROWEST_NOTE = "aspect ratio varies between scenes";

/**
 * One rule for `areaRecheckReason`: given an entry from an older
 * `ACTIVE_AREA_RULES` generation (`rules`), the reason its verdict must be
 * made again, or undefined when the change does not affect it.
 */
export type AreaRecheck = (entry: PlanFileEntry, rules: number) => string | undefined;

/**
 * The rules `areaRecheckReason` applies, one per class of verdicts that a
 * bump of `ACTIVE_AREA_RULES` made wrong. A rule goes here together with the
 * bump, and is phrased for the line `plan` logs, for example
 *
 *   (entry, rules) =>
 *     rules < 2 && entry.status === "MIXED_ASPECT_RATIO"
 *       ? "previously skipped for a variable aspect ratio; picture detection has improved since"
 *       : undefined,
 *
 * A rule tests `rules` against the generation that fixed its fault, as the
 * example does, or it would fire again at every later bump. Nothing in the
 * tool changes this list at run time; it is exported so that a test can add
 * a rule and see `runPlan` act on it.
 */
export const AREA_RECHECKS: AreaRecheck[] = [];

/**
 * Why an entry's verdict came from rules that could not have got it right, so
 * the file must be looked at again though nothing about it changed; undefined
 * for an entry that stands. Only an entry nothing was ever written for, from
 * an older `ACTIVE_AREA_RULES` generation, can qualify, and only through one
 * of `AREA_RECHECKS`. A fresh analysis records the current generation, so
 * each title is analyzed again once.
 */
export function areaRecheckReason(entry: PlanFileEntry): string | undefined {
  const rules = entry.area_rules ?? 1;
  if (rules >= ACTIVE_AREA_RULES) return undefined;
  if (entry.action !== "skip" || entry.patchFile !== undefined) return undefined;
  for (const recheck of AREA_RECHECKS) {
    const reason = recheck(entry, rules);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/** Whether `areaRecheckReason` has one. */
export function needsAreaRecheck(entry: PlanFileEntry): boolean {
  return areaRecheckReason(entry) !== undefined;
}

/** "1 entry", "3 entries". */
function entriesText(n: number): string {
  return `${n} ${n === 1 ? "entry" : "entries"}`;
}

// --- summary --------------------------------------------------------------

export interface PlanSummary {
  files: number;
  fix: number;
  skip: number;
  tracks: number;
  eventsMoved: number;
  positionFields: number;
  bytesChanged: number;
  byStatus: Record<string, number>;
}

export function summarizePlan(entries: readonly PlanFileEntry[]): PlanSummary {
  const summary: PlanSummary = {
    files: entries.length,
    fix: 0,
    skip: 0,
    tracks: 0,
    eventsMoved: 0,
    positionFields: 0,
    bytesChanged: 0,
    byStatus: {},
  };
  for (const e of entries) {
    summary.byStatus[e.status] = (summary.byStatus[e.status] ?? 0) + 1;
    if (e.action === "fix") {
      summary.fix++;
      summary.tracks += e.patch_summary?.tracks ?? 0;
      summary.eventsMoved += e.patch_summary?.events_moved ?? 0;
      summary.positionFields += e.patch_summary?.position_fields ?? 0;
      summary.bytesChanged += e.patch_summary?.bytes_changed ?? 0;
    } else {
      summary.skip++;
    }
  }
  return summary;
}

// --- the run --------------------------------------------------------------

export interface PlanOptions extends ScanOptions {
  method?: FixMethod;
  /**
   * With the patch method: plan a title for remux instead when that repairs
   * tracks patching has to refuse (Matroska compression, a cluster CRC-32).
   * Decided per title; everything patching can do in full stays a patch.
   */
  remuxFallback?: boolean;
  /** Ignore any existing plan entries and analyze everything again. */
  reanalyze?: boolean;
  /**
   * Analyze again the titles whose planned repair was made with another margin
   * than this run's (`staleMargin`), so their subtitles land where this run
   * would put them. Only a file that is in its original state can be: one
   * never repaired, or one whose repair was put back in place (`reverted`). A
   * title that is still repaired is left as it is and listed in
   * `remarginBlocked`. `scope-sub remargin` is the whole operation.
   */
  remargin?: boolean;
  /**
   * Look only at these files (exact paths) among those the paths hold; every
   * other entry of the plan is kept as it is, without being visited. For a
   * caller that works through a library one title at a time (`remargin`).
   */
  only?: readonly string[];
}

/**
 * Whether the repair a patch file records is one `remargin` should redo: a
 * track was moved with another margin than `margin` (unset: the default for
 * its canvas), or the repair left subtitles outside under an older generation
 * of the placement rules (`PLACEMENT_RULES`), which the current one may be
 * able to move.
 */
export function repairIsStale(patchFile: PatchFile, margin: number | undefined): boolean {
  const rules = patchFile.placement_rules ?? 1;
  return patchFile.tracks.some((t) => {
    if (t.margin !== (margin ?? defaultMargin(t.canvas.height))) return true;
    return rules < PLACEMENT_RULES && (t.expected_offending_after ?? 0) > 0;
  });
}

/**
 * Whether `remargin` should redo an entry's repair: it is stale
 * (`repairIsStale`) and the same redo — this margin, these placement rules —
 * has not already been tried and found worse (`redo_tried`). Without the
 * second half a title the plan keeps would be put back, read and repaired
 * again on every run, to the same result.
 */
export function redoIsDue(
  entry: PlanFileEntry,
  patchFile: PatchFile,
  margin: number | undefined,
): boolean {
  if (!repairIsStale(patchFile, margin)) return false;
  const tried = entry.redo_tried;
  return !(tried !== undefined && tried.rules === PLACEMENT_RULES && tried.margin === (margin ?? null));
}

/**
 * What a run is doing, for a caller that wants to show it (the desktop app's
 * engine protocol). `index` is the position in `targets`, which is announced
 * once, before the first file.
 */
export type PlanProgress =
  | { type: "targets"; targets: { file: string; relative: string }[] }
  | { type: "file-start"; index: number; file: string; relative: string }
  | {
      /** The direct reader's position while the PGS tracks are read. */
      type: "file-progress";
      index: number;
      file: string;
      position: number;
      fileSize: number;
    }
  | {
      type: "file-done";
      index: number;
      file: string;
      relative: string;
      /** The entry the plan now holds for the file. */
      entry: PlanFileEntry;
      /** False when the existing entry was reused without reading the file. */
      analyzed: boolean;
    };

export interface PlanDeps extends ScanDeps {
  onProgress?: (progress: PlanProgress) => void;
  /**
   * Stops the run: no further file is started, and the one in hand is
   * abandoned (between two picture samples, or at the next block of the read). The file that was interrupted keeps whatever entry the plan
   * already had for it (or none), so the next run simply picks it up again —
   * the same state a killed run leaves.
   */
  signal?: AbortSignal;
}

export interface PlanRunResult {
  dir: string;
  plan: PlanFile;
  analyzed: number;
  /** The inputs this run analyzed (new, changed, or failed), in no set order. */
  analyzedFiles: string[];
  reused: number;
  /**
   * Inputs this plan has written that have changed since, by something else:
   * their entries were kept as the undo record rather than re-analyzed.
   */
  keptChanged: string[];
  /**
   * Entries for files this run did not find (moved, deleted, or a share that
   * is not mounted): carried as they were, never dropped.
   */
  notFound: string[];
  /**
   * Inputs whose file was replaced by a different one (another size) after
   * this plan repaired it: analyzed afresh, the old undo record kept on disk.
   */
  superseded: string[];
  /**
   * Inputs whose size changed while the media did not (a header edit, such as
   * an attachment or tag added by `mkvpropedit`): their entries were kept and
   * only the recorded size brought up to date.
   */
  adopted: string[];
  /**
   * Inputs that could not be read or analyzed this run (a share that dropped,
   * a file gone since the listing, an analysis that failed) and already had a
   * verdict: their entries were kept exactly as they were, never traded for an
   * ERROR one. An input with no earlier verdict gets an ERROR entry instead and
   * is in `analyzedFiles`.
   */
  unreadable: string[];
  /**
   * Inputs the log recorded as repaired that hold the original bytes again at
   * the same size (the unrepaired file put back from a backup): the log now
   * says so (a `reverted` record), so `apply` will repair them again.
   */
  restored: string[];
  /**
   * Inputs with an in-place write the log shows was started and never
   * finished: possibly half patched. `apply --dangerously-in-place` or
   * `revert --in-place` finishes one.
   */
  unfinished: string[];
  /** With `remargin`: inputs analyzed again because their repair used another margin. */
  remargined: string[];
  /** With `remargin`: inputs whose repair uses another margin but is still in the file. */
  remarginBlocked: string[];
  /**
   * With `remargin`: inputs analyzed again whose new result would have been
   * worse than the repair the plan already has (no repair at all, another
   * method, fewer events moved, more left outside). Their entry was kept.
   */
  remarginKept: { input: string; reason: string }[];
  missingPaths: string[];
  summary: PlanSummary;
  elapsedMs: number;
  /** Present (and true) only when `PlanDeps.signal` stopped the run early. */
  cancelled?: true;
}

/**
 * Whether an existing plan may be reused entry-by-entry.
 *
 * Only the options that shape an entry's verdict or byte patches count.
 * `--recursive` is deliberately not one of them: it changes which files are
 * found and where their output lands (`root` / `relative`), never what the
 * analysis of a given file says, and the reuse path recomputes those two fields
 * from the current run. So a plan built flat can be extended with `-r` and keep
 * every entry it already has.
 *
 * The rules generation counts as well (`PLAN_RULES_VERSION`), and the tool
 * version does not. A plan without a recorded generation is refused.
 *
 * Returns why an existing plan cannot be reused by this run, or null when it
 * can, phrased for the refusal message: "by scope-sub 1.0.0 (this is
 * scope-sub 2.0.0)" or "with aspect 2.39 (this run: auto)".
 */
export function planMismatch(
  plan: PlanFile,
  options: PlanOptions,
  method: FixMethod,
): string | null {
  // The rules generation, not the tool version: see PLAN_RULES_VERSION.
  const rules = planRulesOf(plan);
  if (rules === 0) {
    return `by ${plan.tool.name} ${plan.tool.version}, which did not record which rules it used`;
  }
  if (rules !== PLAN_RULES_VERSION) {
    return `by ${plan.tool.name} ${plan.tool.version} (this is ${TOOL_NAME} ${TOOL_VERSION})`;
  }
  const differences: string[] = [];
  const show = (v: unknown): string => (v === undefined || v === null ? "unset" : String(v));
  if (plan.options.aspect !== options.aspect) {
    differences.push(`aspect ${show(plan.options.aspect)} (this run: ${show(options.aspect)})`);
  }
  if ((plan.options.margin ?? null) !== (options.margin ?? null)) {
    differences.push(`margin ${show(plan.options.margin)} (this run: ${show(options.margin)})`);
  }
  if (plan.options.method !== method) {
    differences.push(`method ${plan.options.method} (this run: ${method})`);
  }
  if ((plan.options.remuxFallback ?? false) !== (options.remuxFallback === true)) {
    differences.push(
      plan.options.remuxFallback === true
        ? "with the remux fallback (this run: without)"
        : "without the remux fallback (this run: with)",
    );
  }
  if ((plan.options.fastPath ?? true) !== (options.full !== true)) {
    differences.push(
      plan.options.fastPath === false
        ? "--no-fast-path (this run: with the fast path)"
        : "with the fast path (this run: --no-fast-path)",
    );
  }
  return differences.length === 0 ? null : `with ${differences.join(", ")}`;
}

/**
 * How far an mtime may sit from the recorded one and still count as put back.
 * A tool that restores an mtime over SMB cannot always land it exactly: the
 * server may round it (observed: to the millisecond). An ordinary write moves
 * it by far more than this.
 */
export const MTIME_RESTORE_TOLERANCE_MS = 1000;

/** Leads the note of an entry analyzed over a different file this plan had repaired. */
export const SUPERSEDED_NOTE = "replaces a different file at this path that this plan fixed";

/** Leads the note naming an earlier patch file that was left on disk, not reused. */
export const KEPT_PATCH_NOTE = "an earlier patch file for this path is kept";

/** The notes of `previous` that name patch files still on disk: a new entry keeps them. */
function patchFileNotes(previous: PlanFileEntry | undefined): string[] {
  return (previous?.notes ?? []).filter(
    (n) => n.startsWith(SUPERSEDED_NOTE) || n.startsWith(KEPT_PATCH_NOTE),
  );
}

/** Leads the note of an entry `remargin` analyzed again after its repair was put back. */
export const REMARGIN_NOTE = "fix redone for the margin";

/** Leads the note an adopted entry carries; a later adoption replaces it. */
export const ADOPTED_NOTE = "header edits only, media unchanged";

/**
 * Why `info` cannot be the file `previous` was planned from, or null when
 * everything the entry recorded about the container still holds.
 *
 * Pure, and deliberately only half of the adoption test: it compares identity
 * (the Segment UID, when the entry has one) and the facts the verdict was drawn
 * from (video size, the PGS tracks). `runPlan` adds the stamp and, for an entry
 * with byte patches, the bytes themselves.
 *
 * An entry normally lists every PGS track, and the file must have exactly
 * those. `listedTracksOnly` asks only that the tracks the entry lists are still
 * there: an entry may list only some of the file's tracks (the ones it fixes),
 * and for an entry with byte patches the byte scan is what vouches for the
 * file.
 */
export function mediaMismatch(
  previous: PlanFileEntry,
  info: MkvInfo,
  options: { listedTracksOnly?: boolean } = {},
): string | null {
  if (
    previous.segment_uid !== undefined &&
    info.segmentUid !== undefined &&
    previous.segment_uid.toLowerCase() !== info.segmentUid.toLowerCase()
  ) {
    return "another Segment UID (a different mux)";
  }
  const video = info.video ? { w: info.video.width, h: info.video.height } : null;
  if ((previous.video === null) !== (video === null)) return "the video track differs";
  if (previous.video && video && (previous.video.w !== video.w || previous.video.h !== video.h)) {
    return `the video is ${video.w}x${video.h}, not ${previous.video.w}x${previous.video.h}`;
  }
  const pgs = info.subtitleTracks.filter((t) => t.isPgs);
  if (options.listedTracksOnly !== true && pgs.length !== previous.tracks.length) {
    return `${pgs.length} PGS track(s), not ${previous.tracks.length}`;
  }
  for (const was of previous.tracks) {
    const now = pgs.find((t) => t.id === was.mkvmerge_id);
    if (
      now === undefined ||
      now.number !== was.matroska_number ||
      now.language !== was.language
    ) {
      return `PGS track ${was.mkvmerge_id} differs`;
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** An old plan's entry, under the target's current root and output path. */
function carried(previous: PlanFileEntry, target: PlanTarget): PlanFileEntry {
  const { root: _root, ...rest } = previous;
  return {
    ...rest,
    ...(target.root === undefined ? {} : { root: target.root }),
    relative: target.relative,
  };
}

/**
 * Whether a file this plan fixed still holds the fix, by one patched range
 * (`PlanFileEntry.probe`, taken from the entry's patch file the first time and
 * kept on the entry — a patch file is megabytes of JSON, the probe a line).
 *
 * "unknown" whenever that cannot be asked: no byte patches (a remux), a patch
 * file or a movie file that cannot be read just now. Unknown changes nothing.
 */
export async function probeFixedFile(
  planDir: string,
  entry: PlanFileEntry,
  file: string,
): Promise<"fixed" | "not-fixed" | "unknown"> {
  if (entry.patchFile === undefined) return "unknown";
  try {
    if (entry.probe === undefined || entry.probe.patchFile !== entry.patchFile) {
      // A range the fix really changes: one whose bytes are the same before
      // and after would read as "fixed" in the original too.
      const first = (await readPatchFile(planDir, entry.patchFile)).patches.find(
        (p) => p.before !== p.after,
      );
      if (first === undefined) return "unknown";
      entry.probe = {
        patchFile: entry.patchFile,
        offset: first.offset,
        before: first.before,
        after: first.after,
      };
    }
    const want = decodePatch({
      offset: entry.probe.offset,
      length: entry.probe.after.length / 2,
      before: entry.probe.before,
      after: entry.probe.after,
    });
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(want.length);
      const { bytesRead } = await handle.read(buffer, 0, want.length, want.offset);
      if (bytesRead !== want.length) return "not-fixed";
      return buffer.equals(Buffer.from(want.after)) ? "fixed" : "not-fixed";
    } finally {
      await handle.close();
    }
  } catch {
    return "unknown";
  }
}

/** A plan entry for a file that threw while it was being planned. */
function errorEntry(
  target: PlanTarget,
  method: FixMethod,
  reason: string,
  notes: readonly string[] = [],
): PlanFileEntry {
  return {
    input: target.file,
    ...(target.root === undefined ? {} : { root: target.root }),
    relative: target.relative,
    size: 0,
    mtimeMs: 0,
    status: "ERROR",
    reason,
    video: null,
    active_area: null,
    tracks: [],
    action: "skip",
    method,
    ...(notes.length === 0 ? {} : { notes: [...notes] }),
    analyzed: new Date().toISOString(),
  };
}

/**
 * Analyze every requested MKV and write the plan directory.
 *
 * Resumable by design: an entry whose size and mtime still match is reused,
 * every reusable entry is in `plan.json` from the first save, and the file is
 * rewritten (atomically) after every file, so a killed run loses at most the
 * file it was working on.
 *
 * A plan this run cannot reuse — built under another rules generation, or with options that
 * change the verdicts — is never silently replaced: `plan.json` would be
 * rewritten empty at the first save, and a run killed after that has thrown the
 * old plan away, applied or not. The operator must say `--reanalyze` (or name
 * another directory).
 *
 * Nor is an entry for a file this plan's own `apply` or `revert` wrote
 * (`lastWriteToInput`): its stamp changed because of that write, and a fresh
 * analysis would reuse its patch file's name, overwriting the only record of
 * the bytes that were changed. Such an entry is carried as it is — quietly when
 * the file still has the stamp the log recorded after the write, with a warning
 * (`keptChanged`) when something else has changed it since.
 *
 * A size that changed is not always another file. `mkvpropedit` adds an
 * attachment or a tag without touching a cluster, and a tool that then puts the
 * mtime back leaves a file whose media is byte-for-byte where it was. Reading
 * it all again costs the whole file over the network and, for a repaired title,
 * the undo record. So before a changed size is believed (`sameMedia`): the
 * container must still say what the entry recorded (`mediaMismatch`), an
 * unwritten entry must still have its mtime (`MTIME_RESTORE_TOLERANCE_MS`), and an entry with byte patches
 * must hold, at every recorded offset, either the original or the repaired
 * bytes. Then the entry is kept (`adopted`) and only its size — and its patch
 * file's — is brought up to date.
 */
export async function runPlan(
  paths: readonly string[],
  dir: string,
  options: PlanOptions,
  deps: PlanDeps = {},
): Promise<PlanRunResult> {
  const started = Date.now();
  const log = deps.log ?? silentLogger;
  const { onProgress, signal, ...scanDeps } = deps;
  const aborted = (): boolean => signal?.aborted === true;
  // What actually stops the workers: the caller's signal, or `halt` — a
  // `plan.json` that could not be written. Nothing more may be decided once
  // the plan can no longer record it.
  const halt = new AbortController();
  const runSignal =
    signal === undefined ? halt.signal : AbortSignal.any([signal, halt.signal]);
  const halted = (): boolean => runSignal.aborted;
  const method: FixMethod = options.method ?? "patch";
  const planDir = resolve(dir);

  const collected = await collectPlanTargets(paths, options.recursive ?? false);
  const missing = collected.missing;
  for (const m of missing) log.error(`path not found: ${m}`);
  // `only`: the run is about these files; every other entry is carried as it
  // is, exactly as an entry for a file this run did not find.
  const onlyFiles = options.only === undefined ? undefined : new Set(options.only.map((p) => resolve(p)));
  const targets =
    onlyFiles === undefined ? collected.targets : collected.targets.filter((t) => onlyFiles.has(resolve(t.file)));

  // The plan is read even for --reanalyze: the entries of files this plan
  // wrote are undo records, and no option may throw those away.
  const existing = await readPlan(planDir);
  const reanalyze = options.reanalyze === true;
  const logged = existing ? await readApplyLog(planPaths(planDir).applyLog) : [];
  const written: Map<string, ApplyLogEvent> = lastWriteToInput(logged);
  // Every input the log says anything about. A patch file of such an input may
  // be the record of bytes written somewhere — into the input, into a copy
  // elsewhere, into a file since replaced — so its name is never handed to a
  // fresh analysis (`planOne`).
  const loggedInputs = new Set(logged.map((e) => e.input));
  // Inputs whose repair lives in a copy elsewhere (`verified`, not swapped in):
  // their patch file describes that copy as much as the input.
  const copiedElsewhere = new Set(
    [...completedByInput(logged).values()]
      .filter((e) => e.event === "verified" && e.output !== undefined && resolve(e.output) !== resolve(e.input))
      .map((e) => e.input),
  );
  const reusable = new Map<string, PlanFileEntry>();
  if (existing) {
    const mismatch = planMismatch(existing, options, method);
    if (mismatch !== null && !reanalyze) {
      throw new PlanFileError(
        `the plan at ${planDir} was built ${mismatch} and its ` +
          `${entriesText(existing.files.length)} cannot be reused; pass --reanalyze to ` +
          `replace it, or choose another --plan directory`,
      );
    }
    for (const entry of existing.files) {
      if (!reanalyze || written.has(entry.input)) reusable.set(entry.input, entry);
    }
    log.info(
      reanalyze
        ? `reanalyzing; keeping the ${entriesText(reusable.size)} this plan fixed (undo data)`
        : `found an existing plan with ${entriesText(existing.files.length)}`,
    );
  }

  const plan: PlanFile = {
    schema: PLAN_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION, rules: PLAN_RULES_VERSION },
    created: existing?.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
    options: {
      aspect: options.aspect,
      ...(options.margin === undefined ? {} : { margin: options.margin }),
      method,
      recursive: options.recursive ?? false,
      ...(options.full === true ? { fastPath: false } : {}),
      ...(options.remuxFallback === true ? { remuxFallback: true } : {}),
    },
    paths: [...paths],
    files: [],
  };

  // Every entry the old plan has for a target is carried from the first save
  // on, under the target's current root and output path. It is confirmed
  // (stamp and patch file still match) or replaced when its turn comes, so a
  // run killed at any point leaves plan.json holding, for every file, either
  // this run's verdict or the old plan's — never nothing. Without this a kill
  // during the first file emptied the plan, since entries were written back
  // only as the worker reached them.
  const entries = new Array<PlanFileEntry | undefined>(targets.length);
  targets.forEach((target, i) => {
    const previous = reusable.get(target.file);
    if (previous) entries[i] = carried(previous, target);
  });
  // A plan never forgets. Entries for files this run did not find — moved,
  // deleted, outside the paths given, or on a share that is not mounted, which
  // looks like an empty directory — are carried exactly as they were. Dropping
  // them once emptied a whole library's plan, undo records and all.
  const found = new Set(targets.map((t) => t.file));
  const untouched = [...reusable.values()].filter((e) => !found.has(e.input));
  const notFound = untouched.map((e) => e.input);
  if (notFound.length > 0 && onlyFiles === undefined) {
    log.warn(
      `${entriesText(notFound.length)} ${notFound.length === 1 ? "is" : "are"} for files not found; kept unchanged`,
    );
  }
  let analyzed = 0;
  let reused = 0;
  const analyzedFiles: string[] = [];
  const keptChanged: string[] = [];
  const superseded: string[] = [];
  const adopted: string[] = [];
  const unreadable: string[] = [];
  const restored: string[] = [];
  const unfinished: string[] = [];
  const remargined: string[] = [];
  const remarginBlocked: string[] = [];
  const remarginKept: { input: string; reason: string }[] = [];

  /**
   * Why a fresh analysis must not replace `previous`'s planned repair under
   * `remargin`, or null when it is at least as good.
   */
  const worseThanPlanned = async (
    previous: PlanFileEntry,
    analysis: FileAnalysis,
    decision: FileDecision,
    entryMethod: FixMethod,
    stamp: FileStamp,
  ): Promise<string | null> => {
    if (decision.action !== "fix") {
      return `reanalyzed as ${analysis.status}, not a fix` +
        (decision.reason === undefined ? "" : ` (${decision.reason})`);
    }
    if (entryMethod !== previous.method) {
      return `reanalysis would fix it by ${entryMethod}, not ${previous.method}`;
    }
    let old: PatchFile;
    try {
      old = await readPatchFile(planDir, previous.patchFile!);
    } catch (err) {
      return `its patch file cannot be read to compare (${err instanceof Error ? err.message : String(err)})`;
    }
    const fresh = buildPatchFile(analysis, decision, stamp, entryMethod);
    for (const was of old.tracks) {
      const now = fresh.tracks.find((t) => t.matroska_number === was.matroska_number);
      if (now === undefined) return `track ${was.matroska_number} would no longer be fixed`;
      if (now.events_moved < was.events_moved) {
        return (
          `with this margin only ${now.events_moved} of track ${was.matroska_number}'s ` +
          `${was.events_moved} subtitle(s) could be moved`
        );
      }
      if (now.expected_offending_after > was.expected_offending_after) {
        return (
          `with this margin ${now.expected_offending_after} subtitle(s) of track ` +
          `${was.matroska_number} would stay outside the picture (now ${was.expected_offending_after})`
        );
      }
    }
    return null;
  };

  /**
   * Whether `entry`'s planned repair was computed with another margin than
   * this run would use. Read from the patch file, which records the margin of
   * every track it moves; an entry without one has nothing to redo.
   */
  const staleMargin = async (entry: PlanFileEntry): Promise<boolean> => {
    if (options.remargin !== true || entry.action !== "fix" || entry.patchFile === undefined) return false;
    let patchFile: PatchFile;
    try {
      patchFile = await readPatchFile(planDir, entry.patchFile);
    } catch {
      // No readable record of what the repair was: nothing to compare.
      return false;
    }
    return redoIsDue(entry, patchFile, options.margin);
  };

  /**
   * Whether the file at `target` is the one `previous` describes with only its
   * headers edited; the reason it is not, otherwise. Reads the container
   * headers and, for a patch-method fix entry, the patched ranges — never the
   * whole file.
   *
   * `isWritten` is an entry this plan's apply wrote, and there the patched
   * bytes alone decide: they are required (nothing else can vouch for the undo
   * record), and neither the mtime nor what the headers now say about the
   * tracks is — a flag, a name or a language edited in a header editor moves
   * the mtime and changes none of the bytes the undo record is about. For such
   * an entry a failure to look (the share dropped) throws rather than answers
   * "no": the caller would otherwise cut a good undo record loose.
   */
  const sameMedia = async (
    target: PlanTarget,
    previous: PlanFileEntry,
    stamp: FileStamp,
    own: ApplyLogEvent | undefined,
  ): Promise<
    | { same: true; info: MkvInfo; patchFile?: PatchFile }
    // `original`: the log says repaired, and every range holds the original bytes.
    | { same: false; why: string; original?: true }
  > => {
    const isWritten = own !== undefined;
    if (previous.status === "ERROR") return { same: false, why: "its entry is an error" };
    if (!isWritten && Math.abs(stamp.mtimeMs - previous.mtimeMs) >= MTIME_RESTORE_TOLERANCE_MS) {
      return { same: false, why: "its mtime changed" };
    }
    let info: MkvInfo;
    try {
      info = await (deps.inspect ?? inspectMkv)(target.file);
    } catch (err) {
      if (isWritten) throw err;
      return { same: false, why: err instanceof Error ? err.message : String(err) };
    }
    const patched = previous.method === "patch" && previous.patchFile !== undefined;
    let patchFile: PatchFile | undefined;
    let patches: BytePatch[] = [];
    if (patched) {
      try {
        patchFile = await readPatchFile(planDir, previous.patchFile!);
        patches = decodePatches(patchFile.patches);
      } catch (err) {
        if (isWritten) throw err;
        return { same: false, why: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!isWritten) {
      // Only bytes to scan can stand in for a full track list.
      const mismatch = mediaMismatch(previous, info, { listedTracksOnly: patches.length > 0 });
      if (mismatch !== null) return { same: false, why: mismatch };
    }
    // A range the repair leaves as it was says nothing about which state the
    // file is in, so only the changing ones are read.
    const changing = patches.filter((x) => !x.before.every((b, n) => b === x.after[n]));
    if (changing.length === 0) {
      if (isWritten) return { same: false, why: "it was fixed without byte patches to verify" };
      return patchFile === undefined ? { same: true, info } : { same: true, info, patchFile };
    }
    const scan = await scanPatchState(target.file, changing);
    if (scan.mismatch > 0) {
      return {
        same: false,
        why:
          `${scan.mismatch} of ${scan.total} patched range(s) hold neither the original ` +
          `nor the fixed bytes (first at offset ${scan.firstMismatch})`,
      };
    }
    // The bytes must also be in the state the log left them in. A repaired
    // title that reads as original is the unrepaired file put back (a restored
    // backup): keeping its entry would have `apply` skip it as done for good.
    if (own !== undefined) {
      const repaired = own.event === "patched" || own.event === "replaced";
      if (repaired && scan.original > 0) {
        return {
          same: false,
          why: `the log says ${own.event}, but ${scan.original} of ${scan.total} range(s) hold the original bytes`,
          ...(scan.fixed === 0 ? { original: true as const } : {}),
        };
      }
      if (own.event === "reverted" && scan.fixed > 0) {
        return {
          same: false,
          why: `the log says reverted, but ${scan.fixed} of ${scan.total} range(s) hold the fixed bytes`,
        };
      }
    }
    return patchFile === undefined ? { same: true, info } : { same: true, info, patchFile };
  };

  /** Keep `previous` for a file whose headers alone changed: new stamp, same entry. */
  const adopt = async (
    i: number,
    target: PlanTarget,
    previous: PlanFileEntry,
    stamp: FileStamp,
    found: { info: MkvInfo; patchFile?: PatchFile },
  ): Promise<void> => {
    // The patch file first: a run killed between the two writes finds the same
    // changed size next time and adopts again.
    // Not when the repair is a copy elsewhere: `revert` holds that copy, which
    // has not changed, to the patch file's size.
    if (
      found.patchFile !== undefined &&
      previous.patchFile !== undefined &&
      found.patchFile.size !== stamp.size &&
      !copiedElsewhere.has(target.file)
    ) {
      await writePatchFile(planDir, previous.patchFile, {
        ...found.patchFile,
        size: stamp.size,
        // Its mtime is the input's as planned; a written file's is the log's to say.
        ...(written.has(target.file) ? {} : { mtimeMs: stamp.mtimeMs }),
      });
    }
    const delta = stamp.size - previous.size;
    const uid = found.info.segmentUid ?? previous.segment_uid;
    entries[i] = {
      ...carried(previous, target),
      size: stamp.size,
      // The stamp the file has now: what `apply` pre-flights an unwritten entry
      // against, and what makes the next run find a written one unchanged.
      mtimeMs: stamp.mtimeMs,
      ...(uid === undefined ? {} : { segment_uid: uid }),
      notes: [
        ...(previous.notes ?? []).filter((n) => !n.startsWith(ADOPTED_NOTE)),
        `${ADOPTED_NOTE} (${delta === 0 ? "same size" : `${previous.size} → ${stamp.size} bytes`}, ` +
          `seen ${new Date().toISOString()}); entry kept`,
      ],
    };
    // Later in this run the entry is looked up again (the error path).
    reusable.set(target.file, entries[i]!);
    adopted.push(target.file);
    reused++;
    log.info(
      `${target.relative}: ${delta === 0 ? "same size" : `${delta > 0 ? "+" : ""}${delta} bytes`}, ` +
        `media unchanged (headers edited) — kept as ${previous.status} → ${previous.action}`,
    );
    await save();
  };

  // One writer at a time: `plan.json` is rewritten after every file.
  //
  // `save` never rejects. A write that fails is remembered and halts the run:
  // every worker stops at its next step, `runPlan` waits for all of them and
  // then throws that one error. A rejected promise here would poison the chain
  // (every later save failing unwritten) and leave the other workers analyzing,
  // writing patch files and log records after the caller had its error.
  let writing: Promise<void> = Promise.resolve();
  let saveFailure: { error: unknown } | undefined;
  const save = (): Promise<void> => {
    writing = writing.then(async () => {
      if (saveFailure !== undefined) return;
      plan.files = [
        ...entries.filter((e): e is PlanFileEntry => e !== undefined),
        ...untouched,
      ];
      plan.updated = new Date().toISOString();
      try {
        await writePlan(planDir, plan);
      } catch (error) {
        saveFailure = { error };
        halt.abort();
      }
    });
    return writing;
  };
  const throwIfSaveFailed = (): void => {
    if (saveFailure !== undefined) throw saveFailure.error;
  };

  const usedPatchFiles = (): string[] =>
    [...entries.filter((e): e is PlanFileEntry => e !== undefined), ...untouched]
      .map((e) => e.patchFile)
      .filter((p): p is string => p !== undefined);

  // Names are handed out one at a time, so two workers cannot claim the same
  // patches/<n>.json before either has been recorded in an entry.
  const reserved = new Set<string>();
  let allocating: Promise<void> = Promise.resolve();
  const allocatePatchFile = async (previous: string | undefined): Promise<string> => {
    if (previous !== undefined) {
      reserved.add(previous);
      return previous;
    }
    let name = "";
    allocating = allocating.then(async () => {
      name = await nextPatchFileName(planDir, [...reserved, ...usedPatchFiles()]);
      reserved.add(name);
    });
    await allocating;
    return name;
  };

  log.info(`planning ${targets.length} file(s) into ${planDir}`);
  await save();
  throwIfSaveFailed();
  onProgress?.({
    type: "targets",
    targets: targets.map((t) => ({ file: t.file, relative: t.relative })),
  });

  /** Plan one target. Throws on anything the caller should record as an error. */
  const planOne = async (i: number, target: PlanTarget): Promise<void> => {
    const info = await stat(target.file);
    const stamp: FileStamp = { size: info.size, mtimeMs: info.mtimeMs };
    const previous = reusable.get(target.file);
    const sameAs = (s: { size: number; mtimeMs: number } | undefined): boolean =>
      s !== undefined && s.size === stamp.size && sameMtime(s.mtimeMs, stamp.mtimeMs);
    // `remargin`: a repair this plan put back in place, planned with another
    // margin, is the one case a written file is analyzed again. The file must
    // be the original: by the record of the revert and an unchanged stamp, or
    // — when something has touched the file since (a header edit that restored
    // the mtime, a share that rounds it) — by every patched range holding the
    // original bytes.
    const redoForMargin = async (entry: PlanFileEntry, last: ApplyLogEvent): Promise<boolean> => {
      if (last.event !== "reverted" || last.revertedTo !== undefined) return false;
      if (!(await staleMargin(entry))) return false;
      if (last.stamp !== undefined && sameAs(last.stamp)) return true;
      try {
        const patches = decodePatches((await readPatchFile(planDir, entry.patchFile!)).patches);
        const changing = patches.filter((x) => !x.before.every((v, n) => v === x.after[n]));
        if (changing.length === 0) return false;
        const scan = await scanPatchState(target.file, changing);
        return scan.original === scan.total;
      } catch {
        return false;
      }
    };

    // A file this plan wrote: its entry is the undo record, never re-analyzed —
    // unless a different file has taken its path. A patch never changes a
    // file's size, so another size is another file (a re-rip, say): its old
    // undo record cannot apply to it, and it has never been checked. That path
    // starts afresh, under a new patch file name; the old patch file stays on
    // disk, named in the log and in the new entry's notes.
    let supersedes: PlanFileEntry | undefined;
    const own = previous === undefined ? undefined : written.get(target.file);
    // Another size is another file — unless only the headers were edited.
    const sizeChanged = previous !== undefined && stamp.size !== previous.size;
    // The size the file had after this plan's last write: the stamp says so, or
    // — for a record without one (a `backed-up` swap, a file that could not
    // be stat'ed after the write), patch method only — the plan's own.
    const sizeAfterWrite =
      own?.stamp?.size ?? ((previous?.method ?? method) === "patch" ? previous?.size : undefined);
    const redo = previous !== undefined && own !== undefined && (await redoForMargin(previous, own));
    if (
      !redo &&
      previous &&
      own &&
      sizeAfterWrite !== undefined &&
      stamp.size !== sizeAfterWrite &&
      stamp.size !== previous.size
    ) {
      const found = await sameMedia(target, previous, stamp, own);
      if (found.same) {
        await adopt(i, target, previous, stamp, found);
        return;
      }
      log.debug(`${target.relative}: not a header edit — ${found.why}`);
      if (halted()) throw new PlanCancelled();
      supersedes = previous;
      superseded.push(target.file);
      written.delete(target.file);
      // From this record on the old entry's patch file name is spoken for: a
      // run killed during the analysis below leaves that entry in plan.json,
      // and the next run — which no longer sees the input as written — must
      // not hand the name to its own analysis. `loggedInputs` is that rule.
      loggedInputs.add(target.file);
      await appendApplyLog(planPaths(planDir).applyLog, {
        time: new Date().toISOString(),
        event: "superseded",
        input: target.file,
        reason:
          `the file is ${stamp.size} bytes, not the ${previous.size} this plan fixed; ` +
          (previous.patchFile === undefined
            ? "reanalyzing"
            : `its undo data stays in ${previous.patchFile}`),
        stamp,
      });
      log.warn(
        `${target.relative}: a different file (${stamp.size} bytes, not ${previous.size}) ` +
          "has replaced the one this plan fixed; reanalyzing" +
          (previous.patchFile === undefined ? "" : ` (previous undo data: ${previous.patchFile})`),
      );
    } else if (previous && own && redo) {
      // Falls through to the analysis below: the file is the original again,
      // and the repair planned for it used another margin.
      remargined.push(target.file);
      log.info(`${target.relative}: reverted to the original; reanalyzing for the new margin`);
    } else if (previous && own) {
      let unchanged = own.stamp === undefined || sameAs(own.stamp) || sameAs(previous);
      // The size and the date say "as this plan left it" — and so they do for
      // the unrepaired file put back from a backup that kept its date. One
      // patched range read from the file settles it; anything but the fixed
      // bytes goes on to the full comparison below.
      if (unchanged && (own.event === "patched" || own.event === "replaced")) {
        if ((await probeFixedFile(planDir, previous, target.file)) === "not-fixed") {
          unchanged = false;
          log.debug(`${target.relative}: its size and date are unchanged, but it no longer holds the fix`);
        }
      }
      if (!unchanged) {
        // Something else has touched it since. If every patched range is still
        // one state or the other it was a header edit (a flag, a track name):
        // the undo record still fits, so take the new stamp and say no more.
        const found = await sameMedia(target, previous, stamp, own);
        if (found.same) {
          await adopt(i, target, previous, stamp, found);
          return;
        }
        log.debug(`${target.relative}: not a header edit — ${found.why}`);
        if (found.original === true) {
          // The size the plan repaired, every range the original bytes: the
          // unrepaired file is back (a restored backup). Kept as it is, the
          // entry would have `apply` skip the title as done for good, so the
          // log is told what the file now is — the record an in-place revert
          // writes. It clears the completion, and (being an in-place record
          // with this stamp) lets `apply` patch the file again and the next
          // `plan` find it unchanged.
          if (halted()) throw new PlanCancelled();
          const event: ApplyLogEvent = {
            time: new Date().toISOString(),
            event: "reverted",
            input: target.file,
            output: target.file,
            method: previous.method,
            patches: 0,
            bytesChanged: 0,
            reason:
              `found holding the original bytes (possibly restored from a backup); the log said ${own.event}`,
            stamp,
          };
          await appendApplyLog(planPaths(planDir).applyLog, event);
          written.set(target.file, event);
          entries[i] = carried(previous, target);
          reused++;
          restored.push(target.file);
          log.warn(
            `${target.relative}: recorded as fixed (${own.event}, ${own.time}) but contains ` +
              "the original bytes again; recorded in the log, and apply will offer it again",
          );
          await save();
          return;
        }
      }
      entries[i] = carried(previous, target);
      reused++;
      if (own.event !== "reverted" && (await staleMargin(previous))) {
        remarginBlocked.push(target.file);
      }
      if (own.event === "started") {
        // The last thing the log says about the file is a write that began.
        unfinished.push(target.file);
        log.warn(
          `${target.relative}: an in-place write did not complete; entry kept — ` +
            "run apply --dangerously-in-place (or revert --in-place) to finish it",
        );
      } else if (unchanged) {
        // A record without a stamp (a `backed-up` swap, a file that could not
        // be stat'ed after the write) has nothing to compare, and a warning on
        // every run would be noise.
        log.debug(`unchanged since this plan wrote it: ${target.relative}`);
      } else {
        keptChanged.push(target.file);
        log.warn(
          `${target.relative}: modified since this plan last wrote it (${own.event}, ` +
            `${own.time}); entry kept as undo data, not reanalyzed, and ` +
            "may no longer match the file",
        );
      }
      await save();
      return;
    }

    // A repair planned and never made, with another margin: nothing in the
    // file to undo, so it is simply planned again.
    const replan =
      previous !== undefined &&
      !own &&
      // A repair that lives in a copy elsewhere is described by this entry's
      // patch file; planning the original again would orphan the copy's undo.
      !copiedElsewhere.has(target.file) &&
      !remargined.includes(target.file) &&
      (await staleMargin(previous));
    if (replan) {
      remargined.push(target.file);
      log.info(`${target.relative}: planned with another margin and not yet fixed; reanalyzing`);
    }

    if (
      previous &&
      supersedes === undefined &&
      !reanalyze &&
      !remargined.includes(target.file) &&
      sameAs(previous) &&
      !needsAreaRecheck(previous) &&
      (previous.patchFile === undefined ||
        (await fileExists(join(planDir, previous.patchFile))))
    ) {
      entries[i] = carried(previous, target);
      reused++;
      log.debug(`unchanged: ${target.relative} (${previous.status} → ${previous.action})`);
      await save();
      return;
    }

    if (previous && !own && supersedes === undefined && !reanalyze && sizeChanged && !remargined.includes(target.file)) {
      const found = await sameMedia(target, previous, stamp, undefined);
      if (found.same) {
        await adopt(i, target, previous, stamp, found);
        return;
      }
      log.debug(`${target.relative}: not a header edit — ${found.why}`);
    }

    if (previous && supersedes === undefined && !reanalyze && sameAs(previous) && needsAreaRecheck(previous)) {
      log.info(`${target.relative}: reanalyzing — ${areaRecheckReason(previous)}`);
    }

    const fileStarted = Date.now();
    let lastPercent = -1;
    const analysis = await analyzeFile(target.file, options, {
      ...scanDeps,
      log,
      signal: runSignal,
      onReadProgress: (position: number, fileSize: number): void => {
        if (halted()) throw new PlanCancelled();
        scanDeps.onReadProgress?.(position, fileSize);
        if (onProgress === undefined) return;
        const percent = fileSize > 0 ? Math.floor((position / fileSize) * 100) : 0;
        if (percent === lastPercent) return;
        lastPercent = percent;
        onProgress({ type: "file-progress", index: i, file: target.file, position, fileSize });
      },
    });
    // An abandoned read comes back as an analysis error; it is not a verdict.
    if (halted()) throw new PlanCancelled();
    // Nor is a failed one, for a title that already has a verdict: the worker
    // keeps that entry (`unreadable`) rather than trade it for an error.
    if (analysis.status === "ERROR" && previous !== undefined && previous.status !== "ERROR") {
      throw new Error(analysis.error ?? "the file could not be analyzed");
    }
    const { decision, method: entryMethod } = decideWithFallback(
      analysis,
      method,
      options.remuxFallback === true,
    );

    // `remargin` never trades a repair for something worse. The analysis was
    // made afresh (another sampling of the picture, a larger margin with less room), and
    // if it no longer repairs what the plan's own repair does — no fix at all,
    // another method, fewer events moved, more left outside — the entry the
    // plan has is kept, with its patch file, and the caller is told.
    if (previous !== undefined && remargined.includes(target.file)) {
      const worse = await worseThanPlanned(previous, analysis, decision, entryMethod, stamp);
      if (worse !== null) {
        remargined.splice(remargined.indexOf(target.file), 1);
        remarginKept.push({ input: target.file, reason: worse });
        entries[i] = {
          ...carried(previous, target),
          redo_tried: {
            margin: options.margin ?? null,
            rules: PLACEMENT_RULES,
            at: new Date().toISOString(),
          },
        };
        reused++;
        log.warn(`${target.relative}: keeping the existing fix — ${worse}`);
        await save();
        return;
      }
    }

    // The old entry's patch file name is reused only for an input the apply log
    // has never mentioned. Any record at all — a copy verified elsewhere, an
    // in-place write, a `superseded` (from this run or one that was killed
    // right after writing it) — means the file may be the only record of bytes
    // that were written: it stays on disk, and the new entry's notes name it.
    const reuseName = loggedInputs.has(target.file) ? undefined : previous?.patchFile;
    let patchFile: string | undefined;
    if (decision.action === "fix") {
      patchFile = await allocatePatchFile(reuseName);
      if (halted()) throw new PlanCancelled();
      await writePatchFile(
        planDir,
        patchFile,
        buildPatchFile(analysis, decision, stamp, entryMethod),
      );
    }

    entries[i] = buildPlanEntry(analysis, decision, {
      target,
      stamp,
      method: entryMethod,
      ...(patchFile === undefined ? {} : { patchFile }),
      analysisMs: Date.now() - fileStarted,
    });
    {
      const kept = patchFileNotes(previous);
      if (supersedes !== undefined) {
        kept.push(
          SUPERSEDED_NOTE +
            (supersedes.patchFile === undefined ? "" : `; its undo data is ${supersedes.patchFile}`),
        );
      } else if (previous?.patchFile !== undefined && reuseName === undefined) {
        kept.push(
          `${KEPT_PATCH_NOTE}: ${previous.patchFile} (the apply log has records for this path, ` +
            "so it may hold undo data)",
        );
      }
      if (remargined.includes(target.file) && own !== undefined) {
        // What `remargin` goes by to finish a run stopped before the repair.
        kept.push(`${REMARGIN_NOTE}: reverted to the original and reanalyzed; to be fixed in place`);
      }
      if (kept.length > 0) {
        const at = entries[i]!;
        at.notes = [...new Set([...(at.notes ?? []), ...kept])];
      }
    }
    analyzed++;
    analyzedFiles.push(target.file);

    const entry = entries[i]!;
    log.info(
      `${target.relative}: ${entry.status} → ${entry.action}` +
        (entry.action === "fix"
          ? ` (${entry.patch_summary?.tracks ?? 0} track(s), ` +
            `${entry.patch_summary?.events_moved ?? 0} event(s), ` +
            `${entry.patch_summary?.position_fields ?? 0} field(s))`
          : ` — ${entry.reason ?? ""}`),
    );
    await save();
  };

  const jobs = Math.max(1, Math.floor(options.jobs ?? 1));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted()) return;
      const i = next++;
      if (i >= targets.length) return;
      const target = targets[i]!;
      onProgress?.({ type: "file-start", index: i, file: target.file, relative: target.relative });
      const done = (): void => {
        const entry = entries[i];
        if (entry === undefined) return;
        onProgress?.({
          type: "file-done",
          index: i,
          file: target.file,
          relative: target.relative,
          entry,
          analyzed: analyzedFiles.includes(target.file),
        });
      };
      try {
        await planOne(i, target);
      } catch (err) {
        // Cancelled (or halted) mid-file: the entry stays as it was before this run.
        if (halted()) return;
        // One file must never cost the run: the file went away mid-plan, the
        // patch file could not be written, a computed coordinate was rejected.
        const message = err instanceof Error ? err.message : String(err);
        const previous = reusable.get(target.file);
        if (previous && previous.status !== "ERROR") {
          // Never trade a verdict — least of all an undo record — for an error
          // entry. A share that drops for a moment fails every file after it,
          // and would otherwise cost the whole plan: each verdict a re-read of
          // the title, each repaired title its way back.
          entries[i] = carried(previous, target);
          unreadable.push(target.file);
          log.warn(
            `${target.relative}: could not be analyzed — ${message}; entry kept unchanged`,
          );
          await save();
          done();
          continue;
        }
        // No verdict to keep: record it as a skip with the reason and carry on.
        entries[i] = errorEntry(target, method, message, patchFileNotes(previous));
        if (!analyzedFiles.includes(target.file)) analyzedFiles.push(target.file);
        log.warn(`${target.relative}: ERROR → skip — ${message}`);
        await save();
      }
      done();
    }
  };

  // No worker rejects on a failed save (`save` does not), so this waits for
  // every one of them to stop before the failure is thrown, once.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs, targets.length)) }, worker),
  );
  await save();
  throwIfSaveFailed();

  return {
    dir: planDir,
    plan,
    analyzed,
    analyzedFiles,
    reused,
    keptChanged,
    notFound,
    superseded,
    adopted,
    unreadable,
    restored,
    unfinished,
    remargined,
    remarginBlocked,
    remarginKept,
    missingPaths: missing,
    summary: summarizePlan(plan.files),
    elapsedMs: Date.now() - started,
    ...(aborted() ? { cancelled: true as const } : {}),
  };
}

/** Thrown inside one file's analysis when the run's signal fires. */
class PlanCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "PlanCancelled";
  }
}

/** Status counts in the order PRD §11.5 prints them. */
export const PLAN_STATUS_ORDER: FileStatus[] = [
  "NEEDS_FIX",
  "OK",
  "NO_PGS",
  "MIXED_ASPECT_RATIO",
  "AMBIGUOUS",
  "ERROR",
];

export { planPaths };
