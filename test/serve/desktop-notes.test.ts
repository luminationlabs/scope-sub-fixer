/**
 * The app hides the engine's bookkeeping notes from a title's opened row. It
 * cannot import engine code, so `desktop/src/words.ts` mirrors the prefixes;
 * this keeps the mirror honest against `src/batch/plan.ts`.
 */
import { describe, expect, it } from "vitest";
import { BOOKKEEPING_NOTES, notesShown } from "../../desktop/src/words.js";
import { ADOPTED_NOTE, KEPT_PATCH_NOTE, REMARGIN_NOTE, SUPERSEDED_NOTE } from "../../src/batch/plan.js";

describe("the engine's bookkeeping notes", () => {
  it("are mirrored exactly in the app", () => {
    expect(BOOKKEEPING_NOTES).toEqual({ KEPT_PATCH_NOTE, ADOPTED_NOTE, SUPERSEDED_NOTE, REMARGIN_NOTE });
  });

  it("are left out of the opened row; other notes stay", () => {
    const rebuild = "Matroska content compression: the PGS segments are not byte-addressable (use --method remux)";
    const notes = [
      "an earlier patch file for this path is kept: patches/1.json (the apply log has records for this path, so it may hold undo data)",
      "header edits only, media unchanged (same size, seen 2026-01-01T00:00:00.000Z); entry kept",
      "replaces a different file at this path that this plan fixed; its undo data is patches/2.json",
      "fix redone for the margin: reverted to the original and reanalyzed; to be fixed in place",
      rebuild,
    ];
    expect(notesShown(notes)).toEqual([rebuild]);
    expect(notesShown([])).toEqual([]);
  });
});
