/**
 * Everything the desktop app says and decides about fixing the originals in
 * place (`desktop/src/words.ts`). The wording is pinned on purpose: it is the
 * warning someone reads before the app is allowed to change their movie files.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApplyFileView, FileView, RevertFileView } from "../../desktop/src/protocol.js";
import {
  canFixInPlace,
  canTick,
  confirmFinish,
  confirmInPlaceRun,
  confirmUndo,
  datesWaiting,
  defaultSelection,
  describeFile,
  describeFix,
  describePhase,
  describeUndo,
  fixButtonLabel,
  IN_PLACE,
  KEEP_DATES,
  inPlaceEstimate,
  inPlaceWarning,
  phaseFraction,
  skipKindOf,
  summarizeFix,
  undoRecordsKept,
} from "../../desktop/src/words.js";

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
    activeArea: null,
    eventsOutside: 3,
    eventsToMove: 3,
    tracksToFix: 1,
    bytesChanged: 6,
    tracks: [],
    notes: [],
    ...over,
  };
}
/** A result as copy mode gives it: a file elsewhere, and no `inPlace`. */
function copied(over: Partial<ApplyFileView> = {}): ApplyFileView {
  const { inPlace: _inPlace, ...rest } = result();
  return { ...rest, output: "/out/a.mkv", ...over };
}

function result(over: Partial<ApplyFileView> = {}): ApplyFileView {
  return {
    input: "/lib/a.mkv",
    relative: "a.mkv",
    output: "/lib/a.mkv",
    status: "applied",
    verified: true,
    inPlace: true,
    bytesWritten: 6,
    checks: [],
    elapsedMs: 1,
    ...over,
  };
}

describe("the warning before the mode is turned on", () => {
  const points = inPlaceWarning("~/Library/Application Support/com.example/plans");
  const all = [IN_PLACE.modal.lead, ...points].join("\n");

  it("says the original files are modified and no copy is kept", () => {
    expect(IN_PLACE.modal.title).toBe("Fix original files in place?");
    expect(IN_PLACE.modal.lead).toBe(
      "When this is on, Scope Sub Fixer modifies your original files and does not create copies.",
    );
    expect(points[0]).toBe("Original files are modified. No copy of the original is kept.");
  });

  it("says the undo data is the only way back, where it is, not to delete it, and to back up", () => {
    expect(points[1]).toBe(
      "Changes can only be reversed using the undo data stored in " +
        "~/Library/Application Support/com.example/plans. Do not delete that folder. " +
        "Back up any files you cannot replace.",
    );
  });

  it("says what a fix changes, that it is verified, and that a failed verification restores the original", () => {
    expect(all).toMatch(/Only subtitle positions change\. Video, audio and all other data are not modified\./);
    expect(all).toMatch(/Each file is verified after it is fixed\. If verification fails, the original is restored automatically\./);
  });

  it("says rebuilt titles are skipped, and that a fix can be undone from the list", () => {
    expect(all).toMatch(/Titles that require a rebuild cannot be fixed in place and are skipped\. Turn this setting off to fix them as copies\./);
    expect(all).toMatch(/You can restore a file's original subtitle positions later from its row in the list\./);
  });

  it("needs an active yes: a statement to select, and a plain pair of buttons", () => {
    expect(IN_PLACE.modal.acknowledge).toBe(
      "I understand that my original files will be modified and no copies will be kept",
    );
    expect(IN_PLACE.modal.confirm).toBe("Turn on");
    expect(IN_PLACE.modal.cancel).toBe("Cancel");
    expect(IN_PLACE.setting).toBe("Fix original files in place (no copies)");
  });
});

describe("what stays on screen while the mode is on", () => {
  it("is a banner that says files are changed and no copies are made", () => {
    expect(IN_PLACE.banner).toBe(
      "In-place fixing is on. Original files are modified and no copies are made.",
    );
    expect(IN_PLACE.bannerDetail).toBe(
      "Changes can only be reversed using the undo data Scope Sub Fixer stores for each file. " +
        "Titles that require a rebuild are skipped.",
    );
  });

  it("is a button that says in place, and how many", () => {
    expect(fixButtonLabel(5, "in-place")).toBe("Fix 5 titles in place");
    expect(fixButtonLabel(1, "in-place")).toBe("Fix 1 title in place");
    expect(fixButtonLabel(0, "in-place")).toBe("Fix titles in place");
    // Copy mode's button is what it always was.
    expect(fixButtonLabel(5, "copy")).toBe("Fix 5 titles");
    expect(fixButtonLabel(1, "copy")).toBe("Fix 1 title");
  });

  it("asks once more before every run, with the number of files", () => {
    const q = confirmInPlaceRun(5);
    expect(q.title).toBe("Fix 5 files in place?");
    expect(q.body[0]).toBe("5 original files will be modified. No copies are made.");
    expect(q.body[1]).toBe("Each file is verified afterwards and restored if verification fails.");
    expect(q.confirm).toBe("Fix 5 files");
    expect(confirmInPlaceRun(1).title).toBe("Fix 1 file in place?");
    expect(confirmInPlaceRun(1).body[0]).toBe("1 original file will be modified. No copies are made.");
    expect(confirmInPlaceRun(1).confirm).toBe("Fix 1 file");
  });

  it("says, beside the button, that no space is needed and which titles are left out", () => {
    expect(inPlaceEstimate(4, 0)).toBe("4 selected · no additional space required");
    expect(inPlaceEstimate(4, 2)).toMatch(/2 titles require a copy and cannot be selected/);
    expect(inPlaceEstimate(4, 1)).toMatch(/1 title requires a copy and cannot be selected/);
  });

  it("explains a stop that is not instant", () => {
    expect(IN_PLACE.stopping).toBe(
      "Stopping after the current title. A file being modified is always completed and verified first.",
    );
    expect(describePhase("in-place", 1, "patch")).toBe("Modifying and verifying…");
    expect(phaseFraction("in-place", 1)).toBeGreaterThan(0);
  });
});

describe("which titles can be ticked", () => {
  const patch = file();
  const rebuilt = file({ input: "/lib/r.mkv", method: "remux" });
  const skip = file({ input: "/lib/s.mkv", action: "skip", status: "OK" });
  const cut = file({ input: "/lib/c.mkv", interrupted: { doing: "fix", time: "t" } });
  const done = file({ input: "/lib/d.mkv", fixed: { output: "/lib/d.mkv", time: "t", inPlace: true } });

  it("in copy mode: everything that can be fixed, as before", () => {
    expect([patch, rebuilt, skip, done].map((f) => canTick(f, "copy"))).toEqual([true, true, false, true]);
    expect(defaultSelection([patch, rebuilt, skip, done], "copy")).toEqual([patch.input, rebuilt.input]);
  });

  it("in in-place mode: only what a byte patch can fix", () => {
    expect(canFixInPlace(patch)).toBe(true);
    expect(canFixInPlace(rebuilt)).toBe(false);
    expect([patch, rebuilt, skip].map((f) => canTick(f, "in-place"))).toEqual([true, false, false]);
    expect(defaultSelection([patch, rebuilt, skip, done], "in-place")).toEqual([patch.input]);
  });

  it("never a title whose movie file may be half changed, in either mode", () => {
    expect(canTick(cut, "copy")).toBe(false);
    expect(canTick(cut, "in-place")).toBe(false);
    expect(defaultSelection([cut, patch], "in-place")).toEqual([patch.input]);
    expect(defaultSelection([patch], "in-place", new Set([patch.input]))).toEqual([]);
  });
});

describe("rows", () => {
  it("never show an interrupted title as fine, whatever else is known about it", () => {
    const cut = file({ interrupted: { doing: "fix", time: "t" } });
    expect(describeFile(cut)).toEqual({
      label: "Fix interrupted",
      tone: "bad",
      action: "The fix did not complete",
    });
    // Not even when its status is OK, or the log once said fixed.
    for (const over of [{ status: "OK", action: "skip" as const }, { fixed: { output: "/x", time: "t", inPlace: true as const } }]) {
      expect(describeFile(file({ ...over, interrupted: { doing: "fix", time: "t" } })).tone).toBe("bad");
    }
    expect(describeFile(file({ interrupted: { doing: "undo", time: "t" } }))).toMatchObject({
      label: "Restore interrupted",
      tone: "bad",
      action: "The restore did not complete",
    });
  });

  it("tell a title fixed in place from one fixed as a copy", () => {
    expect(describeFile(file({ fixed: { output: "/lib/a.mkv", time: "t", inPlace: true } }))).toEqual({
      label: "Fixed in place",
      tone: "good",
      action: "Original file modified",
    });
    expect(describeFile(file({ fixed: { output: "/out/a.mkv", time: "t" } }))).toMatchObject({
      label: "Fixed (copy)",
      action: "Fixed copy exists",
    });
  });

  it("say a rebuilt title needs a copy while the mode is on, and nothing new while it is off", () => {
    const rebuilt = file({ method: "remux" });
    expect(describeFile(rebuilt, "in-place").action).toBe(
      "Requires a copy: cannot be fixed in place",
    );
    expect(describeFile(rebuilt, "copy").action).toMatch(/^Rebuild required \(slower\) · move 3 subtitles/);
    expect(describeFile(rebuilt).action).toBe(describeFile(rebuilt, "copy").action);
    expect(describeFile(file(), "in-place")).toEqual(describeFile(file(), "copy"));
  });
});

describe("results", () => {
  it("word an in-place fix as an update to the file, verified", () => {
    expect(describeFix(result())).toEqual({
      label: "Fixed in place",
      tone: "good",
      detail: "Subtitle positions updated and verified",
    });
    expect(describeFix(result({ resumed: "half-written" })).detail).toBe("Interrupted fix completed and verified");
    expect(describeFix(result({ verified: false }))).toEqual({
      label: "Not verified",
      tone: "warn",
      detail: "The file was modified but could not be verified",
    });
    // A copy is worded as a copy.
    expect(describeFix(copied({ bytesWritten: 2e9 }))).toEqual({
      label: "Fixed",
      tone: "good",
      detail: "Copy written and verified (2.0 GB)",
    });
    expect(describeFix(copied({ bytesWritten: 2e9 }), "remux").detail).toBe("Rebuilt and verified against original (2.0 GB)");
  });

  it("show a title refused for needing a copy as not fixed, never as a quiet skip", () => {
    const refused = result({
      status: "skipped",
      verified: false,
      skipKind: "needs-copy",
      reason: "this title has to be rebuilt to be fixed, and a rebuilt file cannot be written over the original; fix it into a copy instead",
    });
    expect(describeFix(refused)).toMatchObject({ label: "Requires a copy", tone: "bad" });
    expect(describeFix(refused).detail).toBe(
      "Not fixed: this title cannot be fixed in place. Turn off in-place fixing to create a fixed copy.",
    );
    // An engine that only gives the reason is read the same way.
    const { skipKind: _dropped, ...old } = refused;
    expect(skipKindOf(old)).toBe("needs-copy");
    expect(skipKindOf({ reason: "--dangerously-in-place needs a patch-method entry with a patch file; this one was planned for remux" })).toBe("needs-copy");
    const sum = summarizeFix([result(), refused], 2, { cancelled: false, interrupted: false }, "in-place");
    expect(sum).toMatchObject({ fixed: 1, problems: 1, tone: "bad" });
  });

  it("sum up an in-place run in its own words, and a copy run in the old ones", () => {
    const how = { cancelled: false, interrupted: false };
    expect(summarizeFix([result(), result()], 2, how, "in-place").headline).toBe("2 files fixed in place and verified");
    expect(summarizeFix([result()], 1, how, "in-place").headline).toBe("1 file fixed in place and verified");
    expect(summarizeFix([], 2, { cancelled: true, interrupted: false }, "in-place").headline).toBe(
      "Cancelled before any files were modified",
    );
    expect(summarizeFix([result({ status: "failed", verified: false, reason: "x" })], 1, how, "in-place").headline).toBe(
      "No files were modified",
    );
    const copy = copied();
    expect(summarizeFix([copy], 1, how).headline).toBe("1 fixed copy written and verified");
    expect(summarizeFix([copy], 1, how, "copy")).toEqual(summarizeFix([copy], 1, how));
    expect(IN_PLACE.finished).toBe("Original files were modified · undo data saved");
    expect(IN_PLACE.running).toBe("Modifying original files · no copies are made");
  });
});

describe("undo, and finishing an interrupted fix", () => {
  const revert = (over: Partial<RevertFileView>): RevertFileView => ({
    input: "/lib/a.mkv",
    relative: "a.mkv",
    status: "reverted",
    bytesChanged: 6,
    checks: [],
    elapsedMs: 1,
    ...over,
  });

  it("asks before restoring a title, and says what that does", () => {
    const q = confirmUndo("Dune (2021)");
    expect(q.title).toBe('Restore the original subtitles in "Dune (2021)"?');
    expect(q.body[0]).toBe(
      "The file will be returned to its exact state before the fix. Its subtitles will be outside the picture again.",
    );
    expect(q.body[1]).toBe("The file is verified afterwards.");
    expect(q.confirm).toBe("Restore");
    expect(confirmUndo("Dune (2021)", true).body[0]).toBe(
      "A change to this file did not complete. The file will be returned to its exact state before the fix.",
    );
    expect(IN_PLACE.undo).toBe("Restore original");
  });

  it("asks before finishing an interrupted fix, whichever way it was going", () => {
    const q = confirmFinish("Dune (2021)", "fix");
    expect(q.title).toBe('Finish fixing "Dune (2021)"?');
    expect(q.body[0]).toBe(
      "The fix did not complete and the file may be partially modified. The fix will be completed in place and verified.",
    );
    expect(q.body[1]).toBe("If verification fails, the original is restored.");
    expect(confirmFinish("Dune (2021)", "undo").body[0]).toBe(
      "The restore did not complete and the file may be partially modified. The fix will be reapplied in place and verified.",
    );
    expect(IN_PLACE.finish).toBe("Finish fixing");
    expect(IN_PLACE.putBack).toBe("Restore original");
  });

  it("reports an undo as verified only when it was", () => {
    expect(describeUndo(revert({}))).toEqual({
      label: "Restored",
      tone: "good",
      detail: "Original subtitle positions restored and verified",
    });
    expect(describeUndo(revert({ status: "failed", reason: "the file has been changed by something else" }))).toEqual({
      label: "Not restored",
      tone: "bad",
      detail: "the file has been changed by something else",
    });
    expect(describeUndo(revert({ status: "skipped", reason: "nothing to restore" })).tone).toBe("muted");
  });

  it("explains a saved scan that will not be rebuilt because it holds undo data", () => {
    const text = undoRecordsKept("~/Library/Application Support/x/plans/movies-abc");
    expect(text).toBe(
      "This folder was scanned by a different version of Scope Sub Fixer and has undo data for files fixed in place. " +
        "To protect that data, this version will not rescan the folder. " +
        "The undo data in ~/Library/Application Support/x/plans/movies-abc has not been changed.",
    );
    expect(IN_PLACE.showUndo).toBe("Show undo data");
    expect(IN_PLACE.noUndoRecords).toBe("No undo data. No titles have been fixed in place.");
    expect(describeUndo(revert({ status: "would-revert" }))).toEqual({
      label: "Can be restored",
      tone: "muted",
      detail: "No files were modified",
    });
    expect(describeUndo(revert({ status: "skipped" }))).toEqual({
      label: "Nothing to restore",
      tone: "muted",
      detail: "This file is already in its original state",
    });
  });
});

describe("preserving file dates", () => {
  it("is a plain setting that says what it keeps, and why", () => {
    expect(KEEP_DATES.setting).toBe("Preserve file dates");
    expect(KEEP_DATES.hint).toBe(
      "Fixed and restored files keep their original modification date, so media servers do not list them as new.",
    );
  });

  it("says why the app is waiting, for how long at most, in seconds", () => {
    expect(datesWaiting(150)).toBe(
      "Verifying file dates… up to 150 seconds. Network shares can update a file's date shortly after a change.",
    );
    expect(datesWaiting(1)).toMatch(/^Verifying file dates… up to 1 second\. /);
  });

  it("says on a title when its date could not be kept, without calling the fix a failure", () => {
    expect(KEEP_DATES.notKept).toBe(
      "The file's date could not be preserved. Media servers may list it as recently added.",
    );
    expect(describeFix(result({ dateNotKept: "the share replaced it" }))).toEqual(describeFix(result()));
    expect(describeUndo({ ...revertView(), dateNotKept: "x" })).toEqual(describeUndo(revertView()));
  });

  it("never says mtime, or any other word for a date that is not 'date'", () => {
    const all = [KEEP_DATES.setting, KEEP_DATES.hint, KEEP_DATES.notKept, datesWaiting(150)].join("\n");
    expect(all).not.toMatch(/mtime|timestamp|modification time/i);
  });
});

function revertView(): RevertFileView {
  return { input: "/lib/a.mkv", relative: "a.mkv", status: "reverted", bytesChanged: 6, checks: [], elapsedMs: 1 };
}

describe("the app's vocabulary", () => {
  /** A source file's text without its comments: what is left is code and the words on screen. */
  const words = (file: string): string =>
    readFileSync(fileURLToPath(new URL(`../../desktop/src/${file}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/ .*$/gm, "");

  it("says select, scanned, restore and original file — never tick, looked at, put back or themselves", () => {
    for (const file of ["words.ts", "main.ts"]) {
      const text = words(file);
      // The words are still in what is searched: only comments were taken out.
      expect(text).toContain(file === "main.ts" ? "Select titles to fix" : "Restore original");
      // `canTick` and `tickable` are names in the code, not words on screen.
      expect(text.match(/\btick(ed)?\b|put back|put-back|put (it|them) back|looked at|themselves/gi) ?? [], file).toEqual([]);
      expect(text.match(/black bars|movie files? (itself|themselves)|undo records?\b(?!Kept)/gi) ?? [], file).toEqual([]);
    }
  });
});
