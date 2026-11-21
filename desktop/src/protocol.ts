/**
 * The engine protocol's message shapes, as this app uses them.
 *
 * A hand-kept mirror of `../../src/serve/protocol.ts` (the engine is a Node
 * program and this is a browser one, so the file is not imported). When the
 * engine's views change, change these; `PROTOCOL_VERSION` is checked at start.
 */
export const PROTOCOL_VERSION = 3;

export interface Hello {
  name: string;
  version: string;
  protocol: number;
  methods?: string[];
}

export interface ToolCheck {
  tool: string;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
  /** Where it was found: `env` is the user's own choice, `path`/`extra` the search. */
  origin?: string;
}

export interface DoctorProblem {
  what: string;
  message: string;
  fix: string;
  /** Which tool the user could point at by hand to get past this. */
  locate?: ToolKind;
}

/** The two things a user can locate: MKVToolNix is a folder, FFmpeg a file. */
export type ToolKind = "mkvtoolnix" | "ffmpeg";

/** Where the tools are, when the user chose by hand. Absent means "search for it". */
export interface ToolChoices {
  mkvtoolnixDir?: string;
  ffmpeg?: string;
}

export interface DoctorResult {
  ok: boolean;
  /** The choices the engine is using; engines before `configure` leave it out. */
  chosen?: ToolChoices;
  report: {
    tool: { name: string; version: string };
    node: { version: string; ok: boolean };
    tools: ToolCheck[];
    frames: { ok: boolean; detail: string };
    tempDir: { path: string; writable: boolean; freeBytes?: number };
  };
  problems: DoctorProblem[];
}

export interface TrackView {
  id: number;
  language: string;
  name?: string;
  forced: boolean;
  eventCount?: number;
  eventsOutside: number;
  status: string;
  action: "fix" | "skip";
  reason?: string;
}

export interface FileView {
  input: string;
  relative: string;
  title: string;
  size: number;
  status: string;
  action: "fix" | "skip";
  /** `remux`: the file is rebuilt rather than copied with a few bytes changed. */
  method: "patch" | "remux";
  reason?: string;
  video: { w: number; h: number } | null;
  activeArea: { top: number; bottom: number; aspect: number; classification: string } | null;
  eventsOutside: number;
  eventsToMove: number;
  tracksToFix: number;
  bytesChanged: number;
  tracks: TrackView[];
  notes: string[];
  /** `inPlace`: the fixed file is the original itself; there is no untouched original. */
  fixed?: { output: string; time: string; inPlace?: true };
  /** A write to this movie file began and never finished. It may be half changed. */
  interrupted?: { doing: "fix" | "undo"; time: string };
}

export interface PlanResult {
  planDir: string;
  cancelled: boolean;
  analyzed: number;
  reused: number;
  missingPaths: string[];
  /** Titles that could not be read this time; older engines leave it out. */
  unreadable?: string[];
  /** How many movie files this folder's undo records are the only way back for. */
  undoRecords?: number;
  summary: { files: number; fix: number; skip: number; byStatus: Record<string, number> };
  files: FileView[];
}

/** Why a title was skipped. Only `already-done` is good news. */
export type SkipKind =
  | "already-done"
  | "no-space"
  | "input-missing"
  | "input-changed"
  | "needs-copy"
  | "other";

/** How a fix is done: a fixed copy elsewhere, or the original file itself changed. */
export type FixMode = "copy" | "in-place";

export interface ApplyFileView {
  input: string;
  relative: string;
  output: string;
  status: "applied" | "would-apply" | "skipped" | "failed" | "conflict";
  reason?: string;
  /** Set on a `skipped` title by engines that say why; older ones leave it out. */
  skipKind?: SkipKind;
  /** This was an in-place fix: the original itself was changed. */
  inPlace?: true;
  /** In place: this finished a write that an earlier run was interrupted in. */
  resumed?: "half-written" | "unverified";
  verified: boolean;
  bytesWritten: number;
  sha256?: string;
  checks: string[];
  elapsedMs: number;
  /** Asked to keep file dates: why this file's date could not be kept. The fix still counts. */
  dateNotKept?: string;
}

export interface RevertFileView {
  input: string;
  relative: string;
  status: "reverted" | "would-revert" | "skipped" | "failed";
  reason?: string;
  bytesChanged: number;
  checks: string[];
  elapsedMs: number;
  /** Asked to keep file dates: why this file's date could not be kept. The undo still counts. */
  dateNotKept?: string;
}

export interface RevertResult {
  planDir: string;
  dryRun: boolean;
  cancelled: boolean;
  summary: { asked: number; reverted: number; skipped: number; failed: number };
  files: RevertFileView[];
}

export interface ApplyResult {
  planDir: string;
  mode?: FixMode;
  outputRoot: string;
  dryRun: boolean;
  cancelled: boolean;
  summary: {
    planned: number;
    applied: number;
    verified: number;
    skipped: number;
    failed: number;
    conflicts: number;
    bytesWritten: number;
  };
  files: ApplyFileView[];
}

export interface EngineEvent {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}
