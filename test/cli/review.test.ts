import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanFileEntry } from "../../src/batch/planFile.js";
import { createAsk, describeEntry, discardTypeahead } from "../../src/cli/review.js";

function sink() {
  const out = new PassThrough();
  const text: string[] = [];
  out.on("data", (chunk: Buffer) => text.push(chunk.toString()));
  return { out, text: () => text.join("") };
}

describe("createAsk", () => {
  it("answers one question per piped line, without losing lines between questions", async () => {
    const s = sink();
    const { ask, close } = createAsk(Readable.from(["y\nn\n", "yes\n"]), s.out);
    expect(await ask("one? ")).toBe("y");
    expect(await ask("two? ")).toBe("n");
    expect(await ask("three? ")).toBe("yes");
    // Input has ended: every further question gets null (no), never "".
    expect(await ask("four? ")).toBeNull();
    close();
    expect(s.text()).toContain("one? two? three? four? ");
  });

  it("waits for a line that has not arrived yet", async () => {
    const input = new PassThrough();
    const { ask, close } = createAsk(input, sink().out);
    const pending = ask("ready? ");
    input.write("y\n");
    expect(await pending).toBe("y");
    close();
  });
});

describe("createAsk at a terminal (interactive)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("drops answers typed in a burst: a line counts only after its question", async () => {
    const input = new PassThrough();
    const drains: string[] = [];
    const s = sink();
    const { ask, close } = createAsk(input, s.out, {
      interactive: true,
      drain: () => drains.push(s.text()),
    });
    // Typed before anything was asked: never an answer.
    input.write("y\n");
    await tick();
    const one = ask("one? ");
    await tick();
    // Two answers in one burst while the first question waits.
    input.write("y\ny\n");
    expect(await one).toBe("y");
    await tick();
    const two = ask("two? ");
    let settled = false;
    void two.then(() => (settled = true));
    await tick();
    // The second "y" was typed before "two?" was on screen: it did not answer it.
    expect(settled).toBe(false);
    input.write("n\n");
    expect(await two).toBe("n");
    // The terminal's own buffer was emptied before each question was printed.
    expect(drains).toEqual(["", "one? "]);
    close();
  });

  it("leaves piped answers alone: every line is an answer, in order", async () => {
    const input = new PassThrough();
    const { ask, close } = createAsk(input, sink().out);
    input.write("y\nn\n");
    await tick();
    expect(await ask("one? ")).toBe("y");
    expect(await ask("two? ")).toBe("n");
    close();
  });

  it("answers null once the terminal has gone", async () => {
    const input = new PassThrough();
    const { ask, close } = createAsk(input, sink().out, { interactive: true });
    const one = ask("one? ");
    input.end();
    expect(await one).toBeNull();
    expect(await ask("two? ")).toBeNull();
    close();
  });
});

// The drain is POSIX-only (`/dev/tty`, O_NONBLOCK); on Windows it is skipped by design.
describe.skipIf(process.platform === "win32")("discardTypeahead", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scope-sub-tty-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeStdin(isTTY: boolean) {
    const modes: boolean[] = [];
    return { modes, stdin: { isTTY, setRawMode: (mode: boolean) => modes.push(mode) } };
  }

  it("does nothing to a pipe", async () => {
    const pending = join(dir, "pipe");
    await writeFile(pending, "y\n");
    const f = fakeStdin(false);
    expect(discardTypeahead(f.stdin, pending)).toBe(0);
    expect(f.modes).toEqual([]);
  });

  it("reads everything waiting, in raw mode, and always leaves raw mode again", async () => {
    const pending = join(dir, "typed");
    // An unfinished line too: no newline after the last "y".
    await writeFile(pending, "y\ny");
    const f = fakeStdin(true);
    expect(discardTypeahead(f.stdin, pending)).toBe(3);
    expect(f.modes).toEqual([true, false]);
  });

  it("restores the terminal when the read fails", () => {
    // A directory opens and then refuses to be read.
    const f = fakeStdin(true);
    expect(discardTypeahead(f.stdin, dir)).toBe(0);
    expect(f.modes).toEqual([true, false]);
  });

  it("restores the terminal when switching to raw mode itself throws part-way", () => {
    const modes: boolean[] = [];
    const stdin = {
      isTTY: true,
      setRawMode: (mode: boolean) => {
        modes.push(mode);
        if (mode) throw new Error("EIO");
      },
    };
    expect(discardTypeahead(stdin, dir)).toBe(0);
    // Raw mode was never entered, so there is nothing to leave.
    expect(modes).toEqual([true]);
  });

  it("does nothing when there is no terminal to open", () => {
    const f = fakeStdin(true);
    expect(discardTypeahead(f.stdin, join(dir, "missing"))).toBe(0);
    expect(f.modes).toEqual([]);
  });

  it("does nothing on Windows, even at a terminal with typeahead waiting", async () => {
    const pending = join(dir, "typed-win");
    await writeFile(pending, "y\ny");
    const f = fakeStdin(true);
    expect(discardTypeahead(f.stdin, pending, "win32")).toBe(0);
    expect(f.modes).toEqual([]);
  });
});

describe("describeEntry", () => {
  const base: PlanFileEntry = {
    input: "/r/a.mkv",
    relative: "a.mkv",
    size: 1,
    mtimeMs: 1,
    status: "OK",
    video: null,
    active_area: null,
    tracks: [],
    action: "skip",
    method: "patch",
    analyzed: "",
  };

  it("says what the plan concluded, in plain words", () => {
    expect(
      describeEntry({
        ...base,
        status: "NEEDS_FIX",
        action: "fix",
        patch_summary: {
          tracks: 2,
          events_moved: 1204,
          display_sets: 0,
          position_fields: 0,
          bytes_changed: 0,
        },
      }),
    ).toBe("needs fixing: 2 tracks, 1,204 subtitles outside the picture");
    // A film judged by its narrowest repeated shape says so, and which rows.
    expect(
      describeEntry({
        ...base,
        status: "NEEDS_FIX",
        action: "fix",
        video: { w: 3840, h: 2160 },
        active_area: {
          top: 280, bottom: 1880, left: 0, right: 3840, aspect: 2.4, source: "auto", classification: "MIXED_NARROWEST",
        },
        patch_summary: { tracks: 1, events_moved: 12, display_sets: 0, position_fields: 0, bytes_changed: 0 },
      }),
    ).toBe(
      "needs fixing: 1 track, 12 subtitles outside the narrowest picture area " +
        "(rows 280–1879 of 2160; aspect ratio varies)",
    );
    expect(describeEntry({ ...base, reason: "no letterbox bars detected (1.78:1)" })).toBe(
      "no changes needed (no letterbox bars detected (1.78:1))",
    );
    expect(describeEntry({ ...base, status: "NO_PGS" })).toBe("no changes needed (no PGS subtitles)");
    expect(
      describeEntry({ ...base, status: "NEEDS_FIX", reason: "track uses zlib compression" }),
    ).toBe("cannot be fixed: track uses zlib compression");
  });
});
