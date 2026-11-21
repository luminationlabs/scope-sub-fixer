/**
 * The engine's verdicts in plain words.
 *
 * The engine says `NEEDS_FIX`, `MIXED_ASPECT_RATIO`, "Matroska content
 * compression: the PGS segments are not byte-addressable". The person using
 * this app has a projector and a folder of movies. Everything they read about
 * a title comes through here; the engine's own wording stays available in the
 * expanded row.
 */
import type {
  ApplyFileView,
  DoctorResult,
  FileView,
  FixMode,
  RevertFileView,
  SkipKind,
  ToolChoices,
  ToolKind,
} from "./protocol.js";

export type Tone = "good" | "warn" | "bad" | "muted" | "accent";

/** What a remux is, to someone deciding whether to tick the box. */
export const REBUILD_NOTE = "Rebuild required (slower)";

/** The longer version, for the opened row. */
export const REBUILD_EXPLANATION =
  "This title's subtitle track cannot be edited directly, so the file is rebuilt. This takes longer. " +
  "The rebuilt copy's video and audio are verified against the original.";

export type FixPhase =
  | "waiting"
  | "copy"
  | "read-back"
  | "verify"
  | "analyze"
  | "extract"
  | "rebuild"
  /** An in-place fix: written, read back and checked in one step that is never cut short. */
  | "in-place";

/** What a title being fixed is doing right now. */
export function describePhase(phase: FixPhase, fraction: number, method: "patch" | "remux"): string {
  switch (phase) {
    case "waiting":
      return "Waiting…";
    case "copy":
      return `Copying… ${Math.round(fraction * 100)}%`;
    case "read-back":
      return "Verifying copy…";
    case "analyze":
      return "Analyzing…";
    case "extract":
      return "Extracting subtitles…";
    case "rebuild":
      return "Rebuilding…";
    case "verify":
      return method === "remux" ? "Verifying against original…" : "Verifying subtitles…";
    case "in-place":
      return "Modifying and verifying…";
  }
}

/**
 * Roughly how far through its fix a title is, for the overall bar. A copy
 * reports bytes; the other stages only say that they have begun.
 */
export function phaseFraction(phase: FixPhase, fraction: number): number {
  switch (phase) {
    case "waiting":
      return 0;
    case "copy":
      return fraction * 0.5;
    case "read-back":
      return 0.6;
    case "analyze":
      return 0.05;
    case "extract":
      return 0.2;
    case "rebuild":
      return 0.35;
    case "verify":
      return 0.75;
    case "in-place":
      return 0.5;
  }
}

// --- tools chosen by hand ----------------------------------------------------

/** What each locatable tool is called, and what the user is asked to pick. */
export const TOOL_WORDS: Record<ToolKind, { name: string; pick: string; dialog: string }> = {
  mkvtoolnix: {
    name: "MKVToolNix",
    pick: "Choose folder…",
    dialog: "Select the MKVToolNix folder",
  },
  ffmpeg: {
    name: "FFmpeg",
    pick: "Choose file…",
    dialog: "Select the FFmpeg executable",
  },
};

/** The choice for one tool, if there is one. */
export function chosenFor(kind: ToolKind, tools: ToolChoices): string | undefined {
  return kind === "mkvtoolnix" ? tools.mkvtoolnixDir : tools.ffmpeg;
}

/** `tools` with one choice made, or (with `undefined`) given back to the search. */
export function withChoice(tools: ToolChoices, kind: ToolKind, path: string | undefined): ToolChoices {
  const next: ToolChoices = { ...tools };
  const key = kind === "mkvtoolnix" ? "mkvtoolnixDir" : "ffmpeg";
  if (path === undefined || path.trim() === "") delete next[key];
  else next[key] = path;
  return next;
}

/** Which locatable tool a row of the tools table belongs to. */
export function kindOfTool(tool: string): ToolKind | undefined {
  if (tool === "mkvmerge" || tool === "mkvextract") return "mkvtoolnix";
  if (tool === "ffmpeg") return "ffmpeg";
  return undefined;
}

/**
 * Where a tool in the table came from, in words: the user's own choice, or
 * the search. A choice that is not the one in use says so — it is the reason
 * the setup screen is showing.
 */
export function toolSource(
  check: { tool: string; path?: string; origin?: string },
  tools: ToolChoices,
): string {
  const kind = kindOfTool(check.tool);
  const chosen = kind === undefined ? undefined : chosenFor(kind, tools);
  if (chosen !== undefined) {
    return check.origin === "env" && check.path !== undefined
      ? `Custom location: ${check.path}`
      : `Custom location (not usable): ${chosen}`;
  }
  return check.path ?? "";
}

/** The line under the tools table for one locatable tool. */
export function choiceLine(kind: ToolKind, tools: ToolChoices): string {
  const chosen = chosenFor(kind, tools);
  return chosen === undefined
    ? `${TOOL_WORDS[kind].name}: detected automatically`
    : `${TOOL_WORDS[kind].name}: custom location: ${chosen}`;
}

/** The sentence over the setup screen's list of problems. */
export function setupLead(
  d: Pick<DoctorResult, "problems"> & { report?: { tools: readonly { tool: string; found: boolean }[] } },
  tools: ToolChoices,
): string {
  const base = "Scope Sub Fixer requires MKVToolNix and FFmpeg.";
  const aboutChoice = d.problems.some((p) => p.locate !== undefined && chosenFor(p.locate, tools) !== undefined);
  if (aboutChoice) return `${base} The selected location cannot be used.`;
  // Per tool: not installed (not found at all), or installed but not usable
  // (found but would not run, or an FFmpeg that cannot decode video).
  const found = (name: string) => d.report?.tools.some((t) => t.tool === name && t.found) ?? false;
  const isMissing = (p: DoctorResult["problems"][number]) =>
    p.what !== "frames" && !p.what.split(/,\s*/).some(found);
  const kinds = new Map<ToolKind, boolean>();
  for (const p of d.problems) {
    if (p.locate === undefined) continue;
    kinds.set(p.locate, (kinds.get(p.locate) ?? false) || isMissing(p));
  }
  if (kinds.size === 0) return `${base} A requirement is not met.`;
  const missing = [...kinds.values()].filter(Boolean).length;
  const unusable = kinds.size - missing;
  if (unusable === 0) return `${base} ${missing === 1 ? "One is not installed" : "Neither is installed"}.`;
  if (missing === 0) {
    return `${base} ${unusable === 1 ? "One is installed but cannot be used" : "Both are installed but cannot be used"}.`;
  }
  return `${base} One is not installed, and the other cannot be used.`;
}

/** Why a scan or a fix will not start while the tools are not right. */
export const TOOLS_NOT_READY =
  "Setup is incomplete. Resolve the issues under Setup, then try again.";

export interface FileWords {
  label: string;
  tone: Tone;
  /** The "what will happen" column. */
  action: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether the engine judged this title by the narrowest of the picture shapes
 * it keeps returning to (a scope film with IMAX scenes, say).
 */
export function judgedByNarrowestShape(f: Pick<FileView, "activeArea">): boolean {
  return f.activeArea?.classification === "MIXED_NARROWEST";
}

/** For the opened row of such a title: what that means, in a sentence or two. */
export function narrowestShapeNote(f: Pick<FileView, "activeArea" | "action">): string | undefined {
  if (!judgedByNarrowestShape(f)) return undefined;
  const lead = "This title's aspect ratio varies (for example, IMAX scenes).";
  return f.action === "fix"
    ? `${lead} Subtitles are moved into the narrowest recurring picture area so they remain visible throughout.`
    : `${lead} Subtitles were checked against the narrowest recurring picture area and are all inside it.`;
}

/** The picture's place in the frame, for the opened row. */
export function describeArea(f: Pick<FileView, "activeArea" | "video">): string {
  const a = f.activeArea;
  if (!a) return "";
  const what = judgedByNarrowestShape(f) ? "Narrowest picture area" : "Picture area";
  return `${what}: ${a.aspect}:1, rows ${a.top}–${a.bottom} of ${f.video?.h ?? "?"}`;
}

export function describeFile(f: FileView, mode: FixMode = "copy"): FileWords {
  // Before anything else: a movie file that may be half changed is never "fine",
  // never "fixed", and never just another title to tick.
  if (f.interrupted) {
    return f.interrupted.doing === "undo"
      ? {
          label: "Restore interrupted",
          tone: "bad",
          action: "The restore did not complete",
        }
      : { label: "Fix interrupted", tone: "bad", action: "The fix did not complete" };
  }
  if (f.action === "fix") {
    const across = f.tracksToFix > 1 ? ` in ${f.tracksToFix} subtitle tracks` : "";
    if (f.fixed?.inPlace) {
      return { label: "Fixed in place", tone: "good", action: "Original file modified" };
    }
    if (f.fixed) {
      return { label: "Fixed (copy)", tone: "good", action: "Fixed copy exists" };
    }
    if (mode === "in-place" && f.method === "remux") {
      return {
        label: "Subtitles outside picture",
        tone: "warn",
        action: "Requires a copy: cannot be fixed in place",
      };
    }
    const narrowest = judgedByNarrowestShape(f);
    return {
      label: "Subtitles outside picture",
      tone: "warn",
      // The slower kind says so first: it is what the column would cut off last.
      action:
        f.method === "remux"
          ? `${REBUILD_NOTE} · move ${plural(f.eventsToMove, "subtitle")}${across}` +
            (narrowest ? " into the narrowest picture area" : "")
          : narrowest
            ? `Move ${plural(f.eventsToMove, "subtitle")}${across} into the narrowest picture area (aspect ratio varies)`
            : `Move ${plural(f.eventsToMove, "subtitle")} into the picture${across}`,
    };
  }
  switch (f.status) {
    case "NEEDS_FIX":
      return {
        label: "Cannot be fixed",
        tone: "bad",
        action: /compress/i.test(f.reason ?? "")
          ? "Skipped: compressed subtitle track"
          : "Skipped: expand for details",
      };
    case "OK":
      return {
        label: "No changes needed",
        tone: "good",
        action: /no letterbox bars/i.test(f.reason ?? "")
          ? "No letterbox bars"
          : "All subtitles inside the picture",
      };
    case "NO_PGS":
      return { label: "No Blu-ray subtitles", tone: "muted", action: "Nothing to fix" };
    case "MIXED_ASPECT_RATIO":
      return {
        label: "Variable aspect ratio",
        tone: "muted",
        action: "Skipped: no single picture area applies",
      };
    case "AMBIGUOUS":
      return { label: "Undetermined", tone: "muted", action: "Skipped: expand for details" };
    case "ERROR":
      return { label: "Read error", tone: "bad", action: "Skipped: expand for details" };
    default:
      return { label: f.status, tone: "muted", action: f.reason ?? "" };
  }
}

/** A title the last scan could not read: its row shows what an earlier scan found. */
export const UNREADABLE = {
  label: "Read error",
  action: "Not scanned: showing previous result",
};

export function unreadableNote(n: number): string {
  return (
    `${n} ${n === 1 ? "title" : "titles"} could not be read and ` +
    `${n === 1 ? "was" : "were"} not scanned. Check that the disk or network share is connected, ` +
    "then scan again."
  );
}

export interface FixWords {
  label: string;
  tone: Tone;
  detail: string;
}

export function describeFix(r: ApplyFileView, method: "patch" | "remux" = "patch"): FixWords {
  switch (r.status) {
    case "applied":
      if (r.inPlace) {
        return r.verified
          ? {
              label: "Fixed in place",
              tone: "good",
              detail: r.resumed
                ? "Interrupted fix completed and verified"
                : "Subtitle positions updated and verified",
            }
          : { label: "Not verified", tone: "warn", detail: "The file was modified but could not be verified" };
      }
      return r.verified
        ? {
            label: "Fixed",
            tone: "good",
            detail:
              method === "remux"
                ? `Rebuilt and verified against original (${formatBytes(r.bytesWritten)})`
                : `Copy written and verified (${formatBytes(r.bytesWritten)})`,
          }
        : { label: "Not verified", tone: "warn", detail: "The copy was written but could not be verified" };
    case "skipped":
      // Only one skip is good news. Every other one is a title that was asked
      // for and not fixed, and has to look like it.
      switch (skipKindOf(r)) {
        case "already-done":
          return { label: "Already fixed", tone: "good", detail: "A verified copy already exists" };
        case "no-space":
          return {
            label: "Not enough space",
            tone: "bad",
            detail: "Not fixed: insufficient space in the output folder",
          };
        case "input-missing":
          return {
            label: "File not found",
            tone: "bad",
            detail: "Not fixed: the original file is missing. Check that the disk is connected.",
          };
        case "input-changed":
          return {
            label: "File changed",
            tone: "bad",
            detail: "Not fixed: the file was modified after the scan. Scan again.",
          };
        case "needs-copy":
          return {
            label: "Requires a copy",
            tone: "bad",
            detail:
              "Not fixed: this title cannot be fixed in place. " +
              "Turn off in-place fixing to create a fixed copy.",
          };
        default:
          return { label: "Not fixed", tone: "bad", detail: r.reason ?? "Skipped" };
      }
    case "conflict":
      return { label: "File exists", tone: "warn", detail: "A file with this name already exists in the output folder" };
    case "failed":
      return r.reason === "cancelled"
        ? { label: "Cancelled", tone: "muted", detail: "No partial files were left" }
        : { label: "Not fixed", tone: "bad", detail: r.reason ?? "An unknown error occurred" };
    default:
      return { label: r.status, tone: "muted", detail: r.reason ?? "" };
  }
}

/**
 * Why a skipped title was skipped. The engine says so (`skipKind`). A result
 * without one is read by its wording — the current wording only: no earlier
 * spelling of these sentences is recognised.
 */
export function skipKindOf(r: Pick<ApplyFileView, "skipKind" | "reason">): SkipKind {
  if (r.skipKind !== undefined) return r.skipKind;
  const text = r.reason ?? "";
  if (/^already (applied|patched)/.test(text)) return "already-done";
  if (/^not enough free space/.test(text)) return "no-space";
  if (/^the original file no longer exists/.test(text)) return "input-missing";
  if (/^the file was modified after the plan was built/.test(text)) return "input-changed";
  if (/planned for remux|has to be rebuilt/.test(text)) return "needs-copy";
  return "other";
}

export interface FixSummary {
  /** Copies written and checked by this run. */
  fixed: number;
  /** Titles that already had a checked copy in place. */
  alreadyDone: number;
  /** Titles the user stopped. */
  stopped: number;
  /** Titles that were asked for and are not fixed, for any other reason. */
  problems: number;
  /** Titles the run never got to. */
  notReached: number;
  tone: Tone;
  headline: string;
  /** Short facts for the line under the headline. */
  parts: string[];
}

/**
 * What a finished (or cut short) fix amounts to. A run is only shown as a
 * success when nothing that was asked for went unfixed: a title skipped for
 * lack of space, or because its file has gone, is a problem, not a skip.
 *
 * `interrupted` is a run the engine could not finish (it reported an error, or
 * stopped): whatever it had done by then still counts and is still shown.
 */
export function summarizeFix(
  results: readonly ApplyFileView[],
  asked: number,
  how: { cancelled: boolean; interrupted: boolean },
  mode: FixMode = "copy",
): FixSummary {
  let fixed = 0;
  let alreadyDone = 0;
  let stopped = 0;
  let problems = 0;
  for (const r of results) {
    if (r.status === "applied" && r.verified) fixed++;
    else if (r.status === "skipped" && skipKindOf(r) === "already-done") alreadyDone++;
    else if (r.status === "failed" && r.reason === "cancelled") stopped++;
    else problems++;
  }
  const notReached = Math.max(0, asked - results.length);
  const cutShort = how.cancelled || how.interrupted;
  const tone: Tone = problems > 0 || how.interrupted ? "bad" : how.cancelled ? "warn" : "good";
  const headline =
    mode === "in-place"
      ? fixed > 0
        ? `${fixed} ${fixed === 1 ? "file" : "files"} fixed in place and verified`
        : how.cancelled
          ? "Cancelled before any files were modified"
          : alreadyDone > 0 && problems === 0 && !how.interrupted
            ? "No new titles to fix"
            : "No files were modified"
      : fixed > 0
        ? `${fixed} fixed ${fixed === 1 ? "copy" : "copies"} written and verified`
        : how.cancelled
          ? "Cancelled before any files were written"
          : alreadyDone > 0 && problems === 0 && !how.interrupted
            ? "No new titles to fix"
            : "No files were written";
  const parts: string[] = [];
  if (alreadyDone > 0) parts.push(`${alreadyDone} already fixed`);
  if (problems > 0) parts.push(`${problems} not fixed (expand for details)`);
  if (cutShort) {
    const left = stopped + notReached;
    const word = how.interrupted && !how.cancelled ? "stopped by an error" : "cancelled";
    parts.push(left > 0 ? `${word}, ${left} remaining` : word);
  }
  return { fixed, alreadyDone, stopped, problems, notReached, tone, headline, parts };
}

/**
 * An error from the engine, for someone who has never seen an errno. The
 * engine's own refusals (`unsafe-output`, `no-space`, …) are already
 * sentences; what needs translating is a raw system error that escaped.
 */
export function explainError(
  code: string,
  message: string,
  doing: "scan" | "fix",
  folder?: string,
): string {
  const where = folder ? ` (${folder})` : "";
  const what = doing === "fix" ? "The fix" : "The scan";
  if (code === "engine-exit" || code === "engine-start") {
    return `${what} stopped because the engine quit unexpectedly. Try again. If the problem continues, restart Scope Sub Fixer.`;
  }
  if (code === "busy") return "Another operation is in progress. Wait for it to finish or cancel it, then try again.";
  // Every other code is one of the engine's own refusals, already a sentence —
  // and one that may well quote a movie called "ELVIS".
  if (code !== "failed") return message;
  // A system error as Node words it: "EACCES: permission denied, …".
  const errno = /\b(E[A-Z0-9]{3,}): /.exec(message)?.[1];
  if (errno === undefined) return message;
  const target = doing === "fix" ? `the output folder${where}` : `the movie folder${where}`;
  switch (errno) {
    case "ENOSPC":
      return `${what} stopped because the disk is full. Free up space in ${target} and try again.`;
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return `${what} stopped because Scope Sub Fixer does not have permission to write to ${target}.`;
    case "ENOENT":
    case "ENOTDIR":
    case "EIO":
    case "ENXIO":
    case "ENODEV":
    case "ESTALE":
    case "ETIMEDOUT":
    case "EHOSTDOWN":
    case "ENOTCONN":
      return `${what} stopped because ${target} is unavailable. Check that the disk or network share is connected.`;
    case "EEXIST":
      return `${what} stopped because a file in ${target} has the same name as a required folder.`;
    default:
      return `${what} stopped because of an error with ${target}. (${message})`;
  }
}

/** The line in the footer: how much room the ticked titles need, and where. */
export function describeSpace(
  chosen: readonly Pick<FileView, "size" | "method">[],
  tempFolder: string | undefined,
): string {
  const bytes = chosen.reduce((sum, f) => sum + f.size, 0);
  const rebuilt = chosen.filter((f) => f.method === "remux");
  const base = `${chosen.length} selected · ${formatBytes(bytes)} required in the output folder`;
  if (rebuilt.length === 0) return base;
  // A rebuilt title is compared with its original stream by stream, which
  // takes working room about the size of the title while it is being checked.
  const scratch = rebuilt.reduce((max, f) => Math.max(max, f.size), 0);
  const where = tempFolder ? ` (${tempFolder})` : "";
  return (
    `${base} · ${rebuilt.length} ${rebuilt.length === 1 ? "requires" : "require"} a rebuild (slower) ` +
    `and up to ${formatBytes(scratch)} of temporary space${where}`
  );
}

/** The engine keeps its scratch in a folder of its own; show the one it is in. */
export function tempFolderShown(path: string | undefined, platform: Platform = hostPlatform()): string | undefined {
  if (path === undefined) return undefined;
  return homeShortened(path.replace(/[\\/]scope-sub-engine-\d+[\\/]?$/, ""), platform);
}

/** The three desktop platforms the app is built for, as the words need to know them. */
export type Platform = "macos" | "windows" | "linux";

/** The platform this window runs on, from what the webview says about itself. */
export function hostPlatform(): Platform {
  const nav = (globalThis as { navigator?: { userAgent?: string; platform?: string } }).navigator;
  const ua = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  if (/Win/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}

/**
 * A home-directory path, shortened for display: `~` for the home folder on
 * macOS (`/Users/<name>`) and Linux (`/home/<name>`), and on Windows
 * `C:\Users\<name>` (either slash, any drive letter) shown as `~` as well.
 */
export function homeShortened(path: string, platform: Platform = hostPlatform()): string {
  switch (platform) {
    case "macos":
      return path.replace(/^\/Users\/[^/]+/, "~");
    case "linux":
      return path.replace(/^\/home\/[^/]+/, "~");
    case "windows":
      return path.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, "~");
  }
}

/**
 * The path split into its names. Windows accepts both slashes; elsewhere a
 * backslash is an ordinary character of a name and does not split it.
 */
export function pathNames(path: string, platform: Platform = hostPlatform()): string[] {
  return path.split(platform === "windows" ? /[\\/]/ : "/").filter((n) => n.length > 0);
}

/** The button that shows a file or folder in the system's file manager. */
export function revealLabel(platform: Platform = hostPlatform()): string {
  switch (platform) {
    case "macos":
      return "Show in Finder";
    case "windows":
      return "Show in Explorer";
    case "linux":
      return "Show in folder";
  }
}

/**
 * How the engine's own bookkeeping notes begin: which patch file is kept, an
 * adopted header-only change, a replaced earlier fix, a redone margin. They
 * are for the plan's log, not for someone choosing what to fix, so the opened
 * row leaves them out. A mirror of the constants in `src/batch/plan.ts`
 * (`KEPT_PATCH_NOTE`, `ADOPTED_NOTE`, `SUPERSEDED_NOTE`, `REMARGIN_NOTE`);
 * `test/serve/desktop-notes.test.ts` checks the two agree.
 */
export const BOOKKEEPING_NOTES = {
  KEPT_PATCH_NOTE: "an earlier patch file for this path is kept",
  ADOPTED_NOTE: "header edits only, media unchanged",
  SUPERSEDED_NOTE: "replaces a different file at this path that this plan fixed",
  REMARGIN_NOTE: "fix redone for the margin",
} as const;

/** The notes of a title worth showing in its opened row. */
export function notesShown(notes: readonly string[]): string[] {
  const prefixes = Object.values(BOOKKEEPING_NOTES);
  return notes.filter((n) => !prefixes.some((p) => n.startsWith(p)));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

// --- a folder dropped on the app ----------------------------------------------

/** What the app says about a folder dragged onto its window or its icon. */
export const DROP = {
  /** Over the window while something is being dragged across it. */
  hint: "Drop folder to scan",
  /** Anything but exactly one folder was dropped. */
  single: "Drop a single folder.",
  /** A scan or a fix is running, or a question is on screen. */
  busy: "Another operation is in progress. Wait for it to finish or cancel it, then try again.",
} as const;

/**
 * What to do with what was dropped: scan the one folder, or say why not.
 * Exactly what "Choose folder…" would do with it, so never while something
 * is running.
 */
export function decideDrop(
  items: readonly { path: string; isFolder: boolean }[],
  busy: boolean,
): { scan: string } | { message: string } {
  if (busy) return { message: DROP.busy };
  const only = items.length === 1 ? items[0] : undefined;
  if (only === undefined || !only.isFolder) return { message: DROP.single };
  return { scan: only.path };
}

// --- fixing the originals in place ------------------------------------------

/**
 * Everything the app says about in-place fixing. It is the one mode in which
 * a movie file is changed, so the words are kept together, reviewed together
 * and tested: nothing here should be softened in passing.
 */
export const IN_PLACE = {
  /** The setting's label. */
  setting: "Fix original files in place (no copies)",
  /** Under the setting while it is off. */
  settingOff: "Off: fixed copies are saved to a folder you choose. Original files are never modified.",
  showUndo: "Show undo data",
  /** The banner that stays on screen while the mode is on. */
  banner: "In-place fixing is on. Original files are modified and no copies are made.",
  bannerDetail:
    "Changes can only be reversed using the undo data Scope Sub Fixer stores for each file. Titles that require a rebuild are skipped.",
  turnOff: "Turn off",
  /** The dialog shown when the setting is switched on. */
  modal: {
    title: "Fix original files in place?",
    lead: "When this is on, Scope Sub Fixer modifies your original files and does not create copies.",
    acknowledge: "I understand that my original files will be modified and no copies will be kept",
    confirm: "Turn on",
    cancel: "Cancel",
  },
  /** While a run is being stopped. */
  stopping:
    "Stopping after the current title. A file being modified is always completed and verified first.",
  /** In the footer, beside "Original files will be modified". The banner above has the undo data link. */
  footerNote: "No copies are made",
  /** Under the fix banner while a run is going. */
  running: "Modifying original files · no copies are made",
  /** Under the finished banner. */
  finished: "Original files were modified · undo data saved",
  undo: "Restore original",
  finish: "Finish fixing",
  putBack: "Restore original",
  /** No scan has made any yet. */
  noUndoRecords: "No undo data. No titles have been fixed in place.",
} as const;

/**
 * The setting beside in-place fixing that gives each changed movie file back
 * the date it had. It only means something while in-place fixing is on.
 */
export const KEEP_DATES = {
  /** The checkbox's label. */
  setting: "Preserve file dates",
  /** Beside the checkbox. */
  hint: "Fixed and restored files keep their original modification date, so media servers do not list them as new.",
  /** On a title whose date could not be kept; the fix itself still counts. */
  notKept: "The file's date could not be preserved. Media servers may list it as recently added.",
} as const;

/** Shown while the app waits for a network share to finish dating the files it changed. */
export function datesWaiting(seconds: number): string {
  return (
    `Verifying file dates… up to ${seconds} ${seconds === 1 ? "second" : "seconds"}. ` +
    "Network shares can update a file's date shortly after a change."
  );
}

/**
 * What the dialog tells someone before the mode is switched on, one point per
 * line. `undoFolder` is where this app keeps the undo records.
 */
export function inPlaceWarning(undoFolder: string): string[] {
  return [
    "Original files are modified. No copy of the original is kept.",
    `Changes can only be reversed using the undo data stored in ${undoFolder}. ` +
      "Do not delete that folder. Back up any files you cannot replace.",
    "Only subtitle positions change. Video, audio and all other data are not modified.",
    "Each file is verified after it is fixed. If verification fails, the original is restored automatically.",
    "Titles that require a rebuild cannot be fixed in place and are skipped. Turn this setting off to fix them as copies.",
    "You can restore a file's original subtitle positions later from its row in the list.",
  ];
}

/** Whether this title can be fixed in place at all. */
export function canFixInPlace(f: Pick<FileView, "action" | "method">): boolean {
  return f.action === "fix" && f.method === "patch";
}

/**
 * Whether a title gets a box to tick. A title whose file may be half changed
 * never does, in either mode: it has to be finished or put back first.
 */
export function canTick(f: Pick<FileView, "action" | "method" | "interrupted">, mode: FixMode): boolean {
  if (f.interrupted) return false;
  return mode === "in-place" ? canFixInPlace(f) : f.action === "fix";
}

/** The titles ticked to begin with: what can be fixed in this mode and has not been. */
export function defaultSelection(
  files: readonly FileView[],
  mode: FixMode,
  unreadable: ReadonlySet<string> = new Set(),
): string[] {
  return files.filter((f) => canTick(f, mode) && !f.fixed && !unreadable.has(f.input)).map((f) => f.input);
}

/** The words on the button that starts a fix. */
export function fixButtonLabel(n: number, mode: FixMode): string {
  if (mode === "in-place") {
    return n === 0 ? "Fix titles in place" : `Fix ${n} ${n === 1 ? "title" : "titles"} in place`;
  }
  return n === 0 ? "Fix titles" : `Fix ${n} ${n === 1 ? "title" : "titles"}`;
}

/** The line beside the button in in-place mode, where copy mode shows the space needed. */
export function inPlaceEstimate(n: number, needCopy: number): string {
  const base = `${n} selected · no additional space required`;
  return needCopy === 0
    ? base
    : `${base} · ${needCopy} ${needCopy === 1 ? "title requires" : "titles require"} a copy and cannot be selected`;
}

export interface ConfirmWords {
  title: string;
  body: string[];
  confirm: string;
  cancel: string;
}

/** Asked every time a run is about to change movie files. */
export function confirmInPlaceRun(n: number): ConfirmWords {
  const files = `${n} ${n === 1 ? "file" : "files"}`;
  return {
    title: `Fix ${files} in place?`,
    body: [
      `${n} original ${n === 1 ? "file" : "files"} will be modified. No copies are made.`,
      "Each file is verified afterwards and restored if verification fails.",
    ],
    confirm: `Fix ${files}`,
    cancel: "Cancel",
  };
}

/** Asked before a title's original subtitles are put back. */
export function confirmUndo(title: string, interrupted = false): ConfirmWords {
  return {
    title: `Restore the original subtitles in "${title}"?`,
    body: [
      interrupted
        ? "A change to this file did not complete. The file will be returned to its exact state before the fix."
        : "The file will be returned to its exact state before the fix. Its subtitles will be outside the picture again.",
      "The file is verified afterwards.",
    ],
    confirm: "Restore",
    cancel: "Cancel",
  };
}

/** Asked before an interrupted fix is finished. */
export function confirmFinish(title: string, doing: "fix" | "undo"): ConfirmWords {
  return {
    title: `Finish fixing "${title}"?`,
    body: [
      doing === "undo"
        ? "The restore did not complete and the file may be partially modified. The fix will be reapplied in place and verified."
        : "The fix did not complete and the file may be partially modified. The fix will be completed in place and verified.",
      "If verification fails, the original is restored.",
    ],
    confirm: "Finish fixing",
    cancel: "Cancel",
  };
}

/** What became of an undo, for the row. */
export function describeUndo(r: RevertFileView): FixWords {
  switch (r.status) {
    case "reverted":
      return {
        label: "Restored",
        tone: "good",
        detail: "Original subtitle positions restored and verified",
      };
    case "would-revert":
      return { label: "Can be restored", tone: "muted", detail: "No files were modified" };
    case "skipped":
      return { label: "Nothing to restore", tone: "muted", detail: r.reason ?? "This file is already in its original state" };
    default:
      return { label: "Not restored", tone: "bad", detail: r.reason ?? "An unknown error occurred" };
  }
}

/**
 * Shown instead of rescanning from scratch when a folder's saved scan cannot
 * be used by this version but holds undo records: the app must not rebuild it.
 */
export function undoRecordsKept(planDir: string): string {
  return (
    "This folder was scanned by a different version of Scope Sub Fixer and has undo data for files fixed in place. " +
    `To protect that data, this version will not rescan the folder. The undo data in ${planDir} has not been changed.`
  );
}
