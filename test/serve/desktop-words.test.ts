/**
 * The desktop app's wording and its verdict on a finished fix
 * (`desktop/src/words.ts`). It lives here because this is where the tests run;
 * the module is pure and imports nothing from the browser or from Tauri.
 */
import { describe, expect, it } from "vitest";
import type { ApplyFileView, FileView } from "../../desktop/src/protocol.js";
import {
  choiceLine,
  chosenFor,
  decideDrop,
  DROP,
  kindOfTool,
  setupLead,
  TOOL_WORDS,
  toolSource,
  withChoice,
  describeArea,
  describeFile,
  describeFix,
  describeSpace,
  narrowestShapeNote,
  explainError,
  skipKindOf,
  summarizeFix,
  tempFolderShown,
  homeShortened,
  revealLabel,
  pathNames,
} from "../../desktop/src/words.js";
import { skipKindOf as engineSkipKindOf } from "../../src/serve/protocol.js";

function result(over: Partial<ApplyFileView>): ApplyFileView {
  return {
    input: "/lib/a.mkv",
    relative: "a.mkv",
    output: "/out/a.mkv",
    status: "applied",
    verified: true,
    bytesWritten: 1000,
    checks: [],
    elapsedMs: 1,
    ...over,
  };
}
const applied = result({});
const done = result({ status: "skipped", reason: "already applied and verified by an earlier run", skipKind: "already-done" });
const noSpace = result({
  status: "skipped",
  reason: "not enough free space on the output volume: 51.0 GiB needed, 2.0 GiB available",
  skipKind: "no-space",
});
const gone = result({ status: "skipped", reason: "the original file no longer exists", skipKind: "input-missing" });
const stopped = result({ status: "failed", verified: false, reason: "cancelled" });
const how = { cancelled: false, interrupted: false };

describe("skips", () => {
  it("reads an older engine's skip by its wording, the same way the engine does", () => {
    for (const r of [done, noSpace, gone]) {
      const { skipKind, ...old } = r;
      expect(skipKindOf(old)).toBe(skipKind);
      expect(skipKindOf(old)).toBe(engineSkipKindOf(old.reason));
    }
    expect(skipKindOf({ reason: "the file was modified after the plan was built (…); re-run plan" })).toBe("input-changed");
    expect(skipKindOf({ reason: "something new" })).toBe("other");
  });

  it("shows only an already-fixed title as good", () => {
    expect(describeFix(done)).toMatchObject({ label: "Already fixed", tone: "good" });
    expect(describeFix(done).detail).toBe("A verified copy already exists");
    expect(describeFix(noSpace)).toEqual({
      label: "Not enough space",
      tone: "bad",
      detail: "Not fixed: insufficient space in the output folder",
    });
    expect(describeFix(gone)).toEqual({
      label: "File not found",
      tone: "bad",
      detail: "Not fixed: the original file is missing. Check that the disk is connected.",
    });
    expect(describeFix(result({ status: "skipped", reason: "the file was modified after the plan was built" }))).toEqual({
      label: "File changed",
      tone: "bad",
      detail: "Not fixed: the file was modified after the scan. Scan again.",
    });
    expect(describeFix(result({ status: "skipped" })).detail).toBe("Skipped");
    expect(describeFix(result({ status: "conflict", verified: false }))).toEqual({
      label: "File exists",
      tone: "warn",
      detail: "A file with this name already exists in the output folder",
    });
    expect(describeFix(stopped)).toEqual({ label: "Cancelled", tone: "muted", detail: "No partial files were left" });
    expect(describeFix(result({ status: "failed", verified: false })).detail).toBe("An unknown error occurred");
    expect(describeFix(result({ verified: false }))).toEqual({
      label: "Not verified",
      tone: "warn",
      detail: "The copy was written but could not be verified",
    });
    expect(describeFix(result({ status: "skipped", reason: "odd" }))).toMatchObject({ tone: "bad", detail: "odd" });
  });
});

describe("summarizeFix", () => {
  it("is a success when everything asked for is fixed or was already", () => {
    const s = summarizeFix([applied, done], 2, how);
    expect(s).toMatchObject({ fixed: 1, alreadyDone: 1, problems: 0, tone: "good" });
    expect(s.headline).toBe("1 fixed copy written and verified");
    expect(s.parts).toEqual(["1 already fixed"]);
  });

  it("is not a success when titles were refused for lack of space", () => {
    const s = summarizeFix([noSpace, noSpace, noSpace], 3, how);
    expect(s).toMatchObject({ fixed: 0, alreadyDone: 0, problems: 3, tone: "bad" });
    expect(s.headline).toBe("No files were written");
    expect(s.parts[0]).toBe("3 not fixed (expand for details)");
  });

  it("is not a success when an original has gone, even beside ones that worked", () => {
    const s = summarizeFix([applied, gone], 2, how);
    expect(s).toMatchObject({ fixed: 1, problems: 1, tone: "bad" });
  });

  it("counts a conflict and a failure as problems, a cancelled title as stopped", () => {
    const conflict = result({ status: "conflict", verified: false });
    const failed = result({ status: "failed", verified: false, reason: "PGS verification failed" });
    const s = summarizeFix([conflict, failed, stopped], 5, { cancelled: true, interrupted: false });
    expect(s).toMatchObject({ problems: 2, stopped: 1, notReached: 2, tone: "bad" });
    expect(s.parts).toContain("cancelled, 3 remaining");
  });

  it("warns, without blame, about a run the user stopped", () => {
    const s = summarizeFix([applied, stopped], 3, { cancelled: true, interrupted: false });
    expect(s.tone).toBe("warn");
    expect(s.parts).toEqual(["cancelled, 2 remaining"]);
    expect(summarizeFix([stopped], 1, { cancelled: true, interrupted: false }).headline).toBe(
      "Cancelled before any files were written",
    );
  });

  it("keeps what a run finished before it broke off, and says it broke off", () => {
    const s = summarizeFix([applied, applied], 5, { cancelled: false, interrupted: true });
    expect(s).toMatchObject({ fixed: 2, notReached: 3, tone: "bad" });
    expect(s.headline).toBe("2 fixed copies written and verified");
    expect(s.parts).toEqual(["stopped by an error, 3 remaining"]);
  });

  it("says nothing new was written when every title was already done", () => {
    expect(summarizeFix([done, done], 2, how)).toMatchObject({ headline: "No new titles to fix", tone: "good" });
  });
});

describe("explainError", () => {
  it("passes the engine's own sentences through", () => {
    const refusal = "There is not enough free space in /out: the fixed copies need 51.0 GB and 2.0 GB is free.";
    expect(explainError("no-space", refusal, "fix", "/out")).toBe(refusal);
    expect(explainError("unsafe-output", "the output folder /a is inside the library folder /a", "fix")).toMatch(
      /inside the library/,
    );
  });

  it("puts a raw system error into words, with the folder it was about", () => {
    const eacces = explainError("failed", "EACCES: permission denied, mkdir '/Volumes/Ext'", "fix", "/Volumes/Ext/Fixed");
    expect(eacces).toBe(
      "The fix stopped because Scope Sub Fixer does not have permission to write to the output folder (/Volumes/Ext/Fixed).",
    );
    expect(eacces).not.toMatch(/EACCES|mkdir/);
    expect(explainError("failed", "ENOSPC: no space left on device, write", "fix", "/o")).toBe(
      "The fix stopped because the disk is full. Free up space in the output folder (/o) and try again.",
    );
    expect(explainError("failed", "ENOENT: no such file or directory, scandir '/Volumes/Movies'", "scan", "/Volumes/Movies")).toBe(
      "The scan stopped because the movie folder (/Volumes/Movies) is unavailable. " +
        "Check that the disk or network share is connected.",
    );
    expect(explainError("failed", "EEXIST: file already exists, mkdir '/o/Dune (2021)'", "fix", "/o")).toBe(
      "The fix stopped because a file in the output folder (/o) has the same name as a required folder.",
    );
    expect(explainError("failed", "EWEIRD: something", "fix", "/o")).toMatch(/^The fix stopped because of an error with the output folder \(\/o\)\. \(EWEIRD/);
  });

  it("does not take a capitalised movie title for a system error", () => {
    const refusal = "This file cannot be modified, so it cannot be fixed in place: the disk or share is read-only (/Volumes/Films/ELVIS (2022)/ELVIS (2022).mkv).";
    expect(explainError("not-writable", refusal, "fix")).toBe(refusal);
    expect(explainError("failed", "could not read /lib/EPIC (2013).mkv", "scan", "/lib")).toBe(
      "could not read /lib/EPIC (2013).mkv",
    );
  });

  it("explains an engine that quit, and one that is busy", () => {
    expect(explainError("engine-exit", "the engine stopped unexpectedly (exit 1)", "fix")).toBe(
      "The fix stopped because the engine quit unexpectedly. Try again. If the problem continues, restart Scope Sub Fixer.",
    );
    expect(explainError("busy", "another scan or fix is still running", "scan")).toBe(
      "Another operation is in progress. Wait for it to finish or cancel it, then try again.",
    );
  });
});

describe("the footer's estimate", () => {
  const GB = 1e9;
  it("says where the room is needed", () => {
    expect(describeSpace([{ size: 30 * GB, method: "patch" }], "/tmp")).toBe(
      "1 selected · 30.0 GB required in the output folder",
    );
    const mixed = describeSpace(
      [
        { size: 30 * GB, method: "patch" },
        { size: 40 * GB, method: "remux" },
        { size: 20 * GB, method: "remux" },
      ],
      "/var/folders/x/T",
    );
    expect(mixed).toBe(
      "3 selected · 90.0 GB required in the output folder · 2 require a rebuild (slower) " +
        "and up to 40.0 GB of temporary space (/var/folders/x/T)",
    );
    expect(describeSpace([{ size: 40 * GB, method: "remux" }], undefined)).toBe(
      "1 selected · 40.0 GB required in the output folder · 1 requires a rebuild (slower) " +
        "and up to 40.0 GB of temporary space",
    );
  });
  it("shows the temp folder the engine's scratch folder is in", () => {
    expect(tempFolderShown("/var/folders/x/T/scope-sub-engine-4242", "macos")).toBe("/var/folders/x/T");
    expect(tempFolderShown("/Users/someone/tmp/scope-sub-engine-1/", "macos")).toBe("~/tmp");
    expect(tempFolderShown(undefined)).toBeUndefined();
    expect(tempFolderShown("C:\\Users\\Some One\\AppData\\Local\\Temp\\scope-sub-engine-77", "windows")).toBe(
      "~\\AppData\\Local\\Temp",
    );
    expect(tempFolderShown("/tmp/scope-sub-engine-3", "linux")).toBe("/tmp");
  });

  it("shortens the home folder the way each platform spells it", () => {
    expect(homeShortened("/Users/someone/Movies", "macos")).toBe("~/Movies");
    expect(homeShortened("/home/someone/Movies", "macos")).toBe("/home/someone/Movies");
    expect(homeShortened("/home/someone/Movies", "linux")).toBe("~/Movies");
    expect(homeShortened("/Users/someone/Movies", "linux")).toBe("/Users/someone/Movies");
    expect(homeShortened("C:\\Users\\Some One\\Videos", "windows")).toBe("~\\Videos");
    expect(homeShortened("d:/users/someone/Videos", "windows")).toBe("~/Videos");
    expect(homeShortened("\\\\nas\\Users\\x", "windows")).toBe("\\\\nas\\Users\\x");
    expect(homeShortened("/Users/someone", "windows")).toBe("/Users/someone");
  });

  it("splits a path into names with the platform's separators", () => {
    expect(pathNames("/Volumes/Movies/A Film/", "macos")).toEqual(["Volumes", "Movies", "A Film"]);
    expect(pathNames("odd\\name/b.mkv", "linux")).toEqual(["odd\\name", "b.mkv"]);
    expect(pathNames("\\\\nas\\Movies\\A Film", "windows")).toEqual(["nas", "Movies", "A Film"]);
    expect(pathNames("D:\\Movies/sub\\b.mkv", "windows")).toEqual(["D:", "Movies", "sub", "b.mkv"]);
  });

  it("names the file manager of each platform", () => {
    expect(revealLabel("macos")).toBe("Show in Finder");
    expect(revealLabel("windows")).toBe("Show in Explorer");
    expect(revealLabel("linux")).toBe("Show in folder");
  });
});

describe("tools chosen by hand", () => {
  const found = { tool: "mkvmerge", path: "/opt/homebrew/bin/mkvmerge", origin: "extra" };
  it("adds, replaces and clears one choice without touching the other", () => {
    const one = withChoice({}, "mkvtoolnix", "/Apps/MKVToolNix");
    expect(one).toEqual({ mkvtoolnixDir: "/Apps/MKVToolNix" });
    const two = withChoice(one, "ffmpeg", "C:\\tools\\ffmpeg.exe");
    expect(two).toEqual({ mkvtoolnixDir: "/Apps/MKVToolNix", ffmpeg: "C:\\tools\\ffmpeg.exe" });
    expect(withChoice(two, "mkvtoolnix", undefined)).toEqual({ ffmpeg: "C:\\tools\\ffmpeg.exe" });
    expect(withChoice(two, "ffmpeg", "  ")).toEqual({ mkvtoolnixDir: "/Apps/MKVToolNix" });
    expect(chosenFor("ffmpeg", two)).toBe("C:\\tools\\ffmpeg.exe");
    expect(chosenFor("mkvtoolnix", {})).toBeUndefined();
  });

  it("says where each tool in the table came from", () => {
    expect(toolSource(found, {})).toBe("/opt/homebrew/bin/mkvmerge");
    const chosen = { mkvtoolnixDir: "/Apps/MKVToolNix" };
    expect(toolSource({ tool: "mkvextract", path: "/Apps/MKVToolNix/mkvextract", origin: "env" }, chosen)).toBe(
      "Custom location: /Apps/MKVToolNix/mkvextract",
    );
    // The search fell back to another copy: the choice is not what is in use.
    expect(toolSource(found, chosen)).toBe("Custom location (not usable): /Apps/MKVToolNix");
    expect(toolSource({ tool: "ffmpeg" }, chosen)).toBe("");
    expect(kindOfTool("mkvextract")).toBe("mkvtoolnix");
    expect(kindOfTool("frames")).toBeUndefined();
  });

  it("words the line under the table and the picker, for any platform", () => {
    expect(choiceLine("ffmpeg", {})).toBe("FFmpeg: detected automatically");
    expect(choiceLine("mkvtoolnix", { mkvtoolnixDir: "D:\\MKVToolNix" })).toBe(
      "MKVToolNix: custom location: D:\\MKVToolNix",
    );
    expect(TOOL_WORDS.ffmpeg).toEqual({ name: "FFmpeg", pick: "Choose file…", dialog: "Select the FFmpeg executable" });
    expect(TOOL_WORDS.mkvtoolnix).toEqual({
      name: "MKVToolNix",
      pick: "Choose folder…",
      dialog: "Select the MKVToolNix folder",
    });
  });

  it("leads the setup screen with what is actually wrong", () => {
    const missing = { what: "ffmpeg", message: "FFmpeg was not found.", fix: "Install it.", locate: "ffmpeg" as const };
    expect(setupLead({ problems: [missing] }, {})).toBe(
      "Scope Sub Fixer requires MKVToolNix and FFmpeg. One is not installed.",
    );
    expect(setupLead({ problems: [missing, { ...missing, locate: "mkvtoolnix" as const }] }, {})).toBe(
      "Scope Sub Fixer requires MKVToolNix and FFmpeg. Neither is installed.",
    );
    expect(setupLead({ problems: [missing] }, { ffmpeg: "/x/ffmpeg" })).toBe(
      "Scope Sub Fixer requires MKVToolNix and FFmpeg. The selected location cannot be used.",
    );
    expect(setupLead({ problems: [{ what: "temp", message: "m", fix: "f" }] }, {})).toBe(
      "Scope Sub Fixer requires MKVToolNix and FFmpeg. A requirement is not met.",
    );
  });

  it("tells a tool that is not installed from one that cannot be used", () => {
    const lead = "Scope Sub Fixer requires MKVToolNix and FFmpeg.";
    const mkv = { what: "mkvmerge, mkvextract", message: "m", fix: "f", locate: "mkvtoolnix" as const };
    const ffmpeg = { what: "ffmpeg", message: "m", fix: "f", locate: "ffmpeg" as const };
    const frames = { what: "frames", message: "m", fix: "f", locate: "ffmpeg" as const };
    const report = (found: Record<string, boolean>) => ({
      tools: ["mkvmerge", "mkvextract", "ffmpeg"].map((tool) => ({ tool, found: found[tool] ?? false })),
    });
    const allFound = report({ mkvmerge: true, mkvextract: true, ffmpeg: true });
    // Found but would not run.
    expect(setupLead({ problems: [ffmpeg], report: allFound }, {})).toBe(`${lead} One is installed but cannot be used.`);
    expect(setupLead({ problems: [mkv, ffmpeg], report: allFound }, {})).toBe(
      `${lead} Both are installed but cannot be used.`,
    );
    // An FFmpeg that cannot decode video is installed, not missing.
    expect(setupLead({ problems: [frames], report: allFound }, {})).toBe(`${lead} One is installed but cannot be used.`);
    expect(setupLead({ problems: [mkv, frames], report: report({ ffmpeg: true }) }, {})).toBe(
      `${lead} One is not installed, and the other cannot be used.`,
    );
    // One of the pair found is still an MKVToolNix that is there.
    expect(setupLead({ problems: [mkv], report: report({ mkvmerge: true, ffmpeg: true }) }, {})).toBe(
      `${lead} One is installed but cannot be used.`,
    );
    expect(setupLead({ problems: [mkv, ffmpeg], report: report({}) }, {})).toBe(`${lead} Neither is installed.`);
    expect(setupLead({ problems: [ffmpeg], report: report({ mkvmerge: true, mkvextract: true }) }, {})).toBe(
      `${lead} One is not installed.`,
    );
  });
});

describe("a film whose aspect ratio varies", () => {
  const scope = { top: 140, bottom: 940, aspect: 2.4, classification: "CONSTANT" };
  const narrowest = { ...scope, classification: "MIXED_NARROWEST" };
  function file(over: Partial<FileView> = {}): FileView {
    return {
      input: "/lib/a.mkv",
      relative: "a.mkv",
      title: "a",
      size: 1000,
      status: "NEEDS_FIX",
      action: "fix",
      method: "patch",
      video: { w: 1920, h: 1080 },
      activeArea: scope,
      eventsOutside: 3,
      eventsToMove: 3,
      tracksToFix: 1,
      bytesChanged: 6,
      tracks: [],
      notes: [],
      ...over,
    };
  }

  it("says the subtitles go into its narrowest picture area, on the row and when opened", () => {
    const f = file({ activeArea: narrowest });
    expect(describeFile(f).action).toBe(
      "Move 3 subtitles into the narrowest picture area (aspect ratio varies)",
    );
    expect(describeFile({ ...f, tracksToFix: 2 }).action).toBe(
      "Move 3 subtitles in 2 subtitle tracks into the narrowest picture area (aspect ratio varies)",
    );
    expect(describeFile({ ...f, method: "remux" }).action).toBe(
      "Rebuild required (slower) · move 3 subtitles into the narrowest picture area",
    );
    expect(narrowestShapeNote(f)).toBe(
      "This title's aspect ratio varies (for example, IMAX scenes). Subtitles are moved into the narrowest " +
        "recurring picture area so they remain visible throughout.",
    );
    expect(narrowestShapeNote({ ...f, action: "skip" })).toBe(
      "This title's aspect ratio varies (for example, IMAX scenes). Subtitles were checked against the narrowest " +
        "recurring picture area and are all inside it.",
    );
    expect(describeArea(f)).toBe("Narrowest picture area: 2.4:1, rows 140–940 of 1080");
  });

  it("says nothing of the kind for a film of one shape", () => {
    const f = file();
    expect(describeFile(f).action).toBe("Move 3 subtitles into the picture");
    expect(narrowestShapeNote(f)).toBeUndefined();
    expect(narrowestShapeNote(file({ activeArea: null }))).toBeUndefined();
    expect(describeArea(f)).toBe("Picture area: 2.4:1, rows 140–940 of 1080");
    expect(describeArea(file({ activeArea: null }))).toBe("");
  });

  it("says why a film skipped for its varying aspect ratio was skipped", () => {
    const f = file({ status: "MIXED_ASPECT_RATIO", action: "skip", activeArea: null });
    expect(describeFile(f)).toEqual({
      label: "Variable aspect ratio",
      tone: "muted",
      action: "Skipped: no single picture area applies",
    });
  });

  it("names every other verdict in a word or two", () => {
    const skip = (over: Partial<FileView>) => describeFile(file({ action: "skip", activeArea: null, ...over }));
    expect(describeFile(file())).toMatchObject({ label: "Subtitles outside picture", tone: "warn" });
    expect(skip({ status: "NEEDS_FIX" })).toEqual({ label: "Cannot be fixed", tone: "bad", action: "Skipped: expand for details" });
    expect(skip({ status: "NEEDS_FIX", reason: "Matroska content compression" }).action).toBe(
      "Skipped: compressed subtitle track",
    );
    expect(skip({ status: "OK" })).toEqual({ label: "No changes needed", tone: "good", action: "All subtitles inside the picture" });
    expect(skip({ status: "OK", reason: "no letterbox bars detected (1.78:1)" }).action).toBe("No letterbox bars");
    expect(skip({ status: "NO_PGS" })).toEqual({ label: "No Blu-ray subtitles", tone: "muted", action: "Nothing to fix" });
    expect(skip({ status: "AMBIGUOUS" })).toEqual({ label: "Undetermined", tone: "muted", action: "Skipped: expand for details" });
    expect(skip({ status: "ERROR" })).toEqual({ label: "Read error", tone: "bad", action: "Skipped: expand for details" });
  });
});

describe("a folder dropped on the app", () => {
  const folder = { path: "/Volumes/Movies", isFolder: true };
  const file = { path: "/Volumes/Movies/Dune (2021).mkv", isFolder: false };

  it("scans exactly one folder, as choosing it would", () => {
    expect(decideDrop([folder], false)).toEqual({ scan: "/Volumes/Movies" });
  });

  it("says in a line why anything else is not opened", () => {
    expect(decideDrop([file], false)).toEqual({ message: "Drop a single folder." });
    expect(decideDrop([folder, { ...folder, path: "/Volumes/More" }], false)).toEqual({ message: DROP.single });
    expect(decideDrop([folder, file], false)).toEqual({ message: DROP.single });
    expect(decideDrop([], false)).toEqual({ message: DROP.single });
  });

  it("never starts a scan while something is running, whatever was dropped", () => {
    expect(decideDrop([folder], true)).toEqual({
      message: "Another operation is in progress. Wait for it to finish or cancel it, then try again.",
    });
    expect(decideDrop([file], true)).toEqual({ message: DROP.busy });
  });

  it("names the place to drop in three words", () => {
    expect(DROP.hint).toBe("Drop folder to scan");
  });
});
