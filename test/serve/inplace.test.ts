/**
 * The in-place mode's protocol surface, without media: which requests are
 * in-place requests at all, what is refused before the engine is called, and
 * how an undo is aimed. The fix and the undo themselves are in
 * inplace.integration.test.ts.
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DateWatch } from "../../src/batch/dates.js";
import { appendApplyLog, type ApplyLogEvent } from "../../src/batch/log.js";
import {
  PLAN_RULES_VERSION,
  PLAN_SCHEMA_VERSION,
  writePlan,
  type PlanFileEntry,
} from "../../src/batch/planFile.js";
import { TOOL_VERSION } from "../../src/report/version.js";
import {
  exactRevertFilter,
  notWritable,
  notWritableMessage,
  revertAim,
  undoRecordInputs,
} from "../../src/serve/inPlace.js";
import { fileView, METHODS, NEEDS_COPY_REASON, skipKindOf } from "../../src/serve/protocol.js";
import {
  parseApplyParams,
  parseRevertParams,
  RequestError,
  type EngineDeps,
} from "../../src/serve/server.js";
import { startClient } from "./harness.js";

let dir: string;
let library: string;

function fix(name: string, extra: Partial<PlanFileEntry> = {}): PlanFileEntry {
  return {
    input: join(library, name),
    root: library,
    relative: name,
    size: 14,
    mtimeMs: 1,
    status: "NEEDS_FIX",
    video: { w: 1920, h: 1080 },
    active_area: null,
    tracks: [],
    action: "fix",
    patchFile: "patches/1.json",
    method: "patch",
    analyzed: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

async function planOf(planDir: string, files: PlanFileEntry[], events: ApplyLogEvent[] = []): Promise<void> {
  await writePlan(planDir, {
    schema: PLAN_SCHEMA_VERSION,
    tool: { name: "scope-sub", version: TOOL_VERSION, rules: PLAN_RULES_VERSION },
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    options: { aspect: "auto", method: "patch", recursive: true, remuxFallback: true },
    paths: [library],
    files,
  });
  for (const e of events) await appendApplyLog(join(planDir, "apply.log.jsonl"), e);
}

const rec = (event: ApplyLogEvent["event"], input: string, extra: Partial<ApplyLogEvent> = {}): ApplyLogEvent => ({
  time: "2026-02-02T00:00:00.000Z",
  event,
  input,
  output: input,
  ...extra,
});

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "scope-sub-inplace-")));
  library = join(dir, "library");
  await mkdir(library, { recursive: true });
  for (const name of ["A.mkv", "B.mkv", "Rebuilt.mkv"]) await writeFile(join(library, name), "the original " + name[0]);
});

afterAll(async () => {
  if (dir) {
    await chmod(join(library, "B.mkv"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

describe("apply params: which requests are in-place requests", () => {
  const copy = { planDir: "/p", outputRoot: "/out", only: ["/lib/a.mkv"] };
  const inPlace = { planDir: "/p", mode: "in-place", only: ["/lib/a.mkv"] };

  it("is a copy unless the mode says in-place, in so many words", () => {
    expect(parseApplyParams(copy)).toEqual(copy);
    expect(parseApplyParams({ ...copy, mode: "copy" })).toEqual({ ...copy, mode: "copy" });
    expect(parseApplyParams(inPlace)).toEqual(inPlace);
    expect(parseApplyParams({ ...inPlace, dryRun: true })).toEqual({ ...inPlace, dryRun: true });
    for (const mode of ["inplace", "in_place", "IN-PLACE", true, 1, ""]) {
      expect(() => parseApplyParams({ ...copy, mode })).toThrow(/"mode" must be/);
    }
  });

  it("never reads a request without a mode as in-place: no output folder is an error, not a hint", () => {
    expect(() => parseApplyParams({ planDir: "/p", only: ["/lib/a.mkv"] })).toThrow(/outputRoot/);
    expect(() => parseApplyParams({ planDir: "/p", mode: "copy", only: ["/lib/a.mkv"] })).toThrow(/outputRoot/);
  });

  it("refuses an output folder in in-place mode, and still requires only", () => {
    expect(() => parseApplyParams({ ...inPlace, outputRoot: "/out" })).toThrow(/no meaning with mode "in-place"/);
    expect(() => parseApplyParams({ planDir: "/p", mode: "in-place" })).toThrow(/only/);
    expect(() => parseApplyParams({ ...inPlace, only: [] })).toThrow(/only/);
  });

  it("still refuses the command line's own spellings and shortcuts by name, in either mode", () => {
    for (const base of [copy, inPlace]) {
      for (const key of ["inPlace", "replaceOriginal", "dangerouslyInPlace", "skipVerify", "overwriteOutput"]) {
        expect(() => parseApplyParams({ ...base, [key]: true })).toThrow(RequestError);
      }
    }
  });
});

describe("keepDates", () => {
  const copy = { planDir: "/p", outputRoot: "/out", only: ["/lib/a.mkv"] };
  const inPlace = { planDir: "/p", mode: "in-place", only: ["/lib/a.mkv"] };

  it("is taken by an in-place fix and by an undo, as a boolean only", () => {
    expect(parseApplyParams({ ...inPlace, keepDates: true })).toEqual({ ...inPlace, keepDates: true });
    expect(parseApplyParams({ ...inPlace, keepDates: false })).toEqual({ ...inPlace, keepDates: false });
    const undo = { planDir: "/p", only: ["/lib/a.mkv"] };
    expect(parseRevertParams({ ...undo, keepDates: true })).toEqual({ ...undo, keepDates: true });
    for (const keepDates of ["yes", 1, null, {}]) {
      expect(() => parseApplyParams({ ...inPlace, keepDates })).toThrow(/"keepDates" must be true or false/);
      expect(() => parseRevertParams({ ...undo, keepDates })).toThrow(/"keepDates" must be true or false/);
    }
  });

  it("is refused by name with a copy, which never touches the original's date", () => {
    for (const keepDates of [true, false]) {
      expect(() => parseApplyParams({ ...copy, keepDates })).toThrow(/"keepDates" has no meaning with mode "copy"/);
      expect(() => parseApplyParams({ ...copy, mode: "copy", keepDates })).toThrow(RequestError);
    }
  });
});

describe("revert params", () => {
  it("takes a plan and a list, and nothing that would aim it elsewhere", () => {
    const ok = { planDir: "/p", only: ["/lib/a.mkv"] };
    expect(parseRevertParams(ok)).toEqual(ok);
    expect(parseRevertParams({ ...ok, dryRun: true })).toEqual({ ...ok, dryRun: true });
    expect(() => parseRevertParams({ planDir: "/p" })).toThrow(/only/);
    expect(() => parseRevertParams({ ...ok, only: [] })).toThrow(/only/);
    for (const key of ["outputRoot", "output", "overwriteOutput", "file", "patchFile", "target"]) {
      expect(() => parseRevertParams({ ...ok, [key]: "x" })).toThrow(/puts the original bytes back in place/);
    }
    expect(METHODS).toContain("revert");
  });
});

describe("aiming an undo", () => {
  it("selects exactly one title, or refuses", () => {
    const a = fix("A.mkv");
    const b = fix("B.mkv");
    // `<library>/x<library>/A.mkv` contains a's whole path.
    const shadow = fix("shadow", { input: `${library}/x${a.input}`, relative: `x${a.input}` });
    const skipped = fix("C.mkv", { action: "skip" });
    expect(exactRevertFilter(a, [a, b, skipped])).toBe(a.input);
    expect(exactRevertFilter(a, [a, b, shadow])).toBeNull();
    expect(exactRevertFilter(shadow, [a, b, shadow])).toBe(shadow.input);
    // A skip entry that happens to contain the path is not something revert would touch.
    expect(exactRevertFilter(a, [a, { ...shadow, action: "skip" }])).toBe(a.input);
  });

  it("only at an original this plan wrote: not at a copy, not at a title never fixed", () => {
    const a = fix("A.mkv");
    expect(revertAim(a, [])).toMatchObject({ ok: false, status: "skipped", reason: expect.stringMatching(/not been fixed in place/) });
    expect(revertAim(a, [rec("verified", a.input, { output: "/out/A.mkv" })])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/fixed as a copy \(\/out\/A\.mkv\); the original was not modified/),
    });
    expect(revertAim(a, [rec("started", a.input, { inPlace: true }), rec("patched", a.input, { inPlace: true })])).toEqual({ ok: true });
    // Interrupted: no completion, but the write was this plan's.
    expect(revertAim(a, [rec("started", a.input, { inPlace: true })])).toEqual({ ok: true });
    // Put back already: nothing left to aim at.
    expect(
      revertAim(a, [rec("started", a.input, { inPlace: true }), rec("patched", a.input, { inPlace: true }), rec("reverted", a.input)]),
    ).toMatchObject({ ok: false });
  });

  it("counts the inputs a plan directory holds the undo record of", () => {
    const a = join(library, "A.mkv");
    const b = join(library, "B.mkv");
    expect(undoRecordInputs([])).toEqual([]);
    expect(undoRecordInputs([rec("started", a, { output: "/out/A.mkv" }), rec("verified", a, { output: "/out/A.mkv" })])).toEqual([]);
    expect(undoRecordInputs([rec("started", a, { inPlace: true }), rec("patched", a, { inPlace: true })])).toEqual([a]);
    // Put back is still a record worth keeping: the file was written twice.
    expect(
      undoRecordInputs([rec("started", a, { inPlace: true }), rec("patched", a, { inPlace: true }), rec("reverted", a), rec("started", b, { inPlace: true })]),
    ).toEqual([a, b]);
  });
});

// chmod 0o444 is the "cannot be written" fixture. Windows maps it onto the
// read-only attribute, but which error access(W_OK) then gives is unverified.
describe.skipIf(process.platform === "win32")("files that cannot be written", () => {
  it("are found before anything starts, and said plainly", async () => {
    const a = join(library, "A.mkv");
    const b = join(library, "B.mkv");
    await chmod(b, 0o444);
    // Root can write anything; the check is then vacuous and so is this test.
    const refused = await notWritable([a, b, join(library, "gone.mkv")]);
    if (process.getuid?.() === 0) return;
    expect(refused).toEqual([{ input: b, why: "permission denied" }]);
    const one = notWritableMessage(refused, 1, "fix");
    expect(one).toMatch(/^This file cannot be modified, so it cannot be fixed in place: permission denied/);
    expect(notWritableMessage([...refused, ...refused], 2, "fix")).toMatch(/^None of these 2 files can be modified, so they cannot be fixed in place/);
    expect(notWritableMessage(refused, 3, "fix")).toMatch(/^1 of these 3 files cannot be modified, so nothing was started: /);
    expect(notWritableMessage(refused, 3, "fix")).toMatch(/turn off in-place fixing to create fixed copies instead/);
    expect(notWritableMessage(refused, 1, "undo")).toMatch(/cannot be restored/);
    expect(notWritableMessage(refused, 1, "undo")).not.toMatch(/fixed copies/);
  });
});

describe("views", () => {
  it("tell a title fixed in place from one fixed as a copy, and an interrupted one from both", () => {
    const a = fix("A.mkv");
    const copy = fileView(a, { completed: rec("verified", a.input, { output: "/out/A.mkv" }) });
    expect(copy.fixed).toEqual({ output: "/out/A.mkv", time: "2026-02-02T00:00:00.000Z" });
    expect(copy.interrupted).toBeUndefined();
    const inPlace = fileView(a, { completed: rec("patched", a.input, { inPlace: true }) });
    expect(inPlace.fixed).toEqual({ output: a.input, time: "2026-02-02T00:00:00.000Z", inPlace: true });
    const cut = fileView(a, { unfinished: rec("started", a.input, { inPlace: true }) });
    expect(cut.fixed).toBeUndefined();
    expect(cut.interrupted).toEqual({ doing: "fix", time: "2026-02-02T00:00:00.000Z" });
    expect(fileView(a, { unfinished: rec("started", a.input, { inPlace: true, reason: "revert" }) }).interrupted!.doing).toBe("undo");
    // The older call shape still works.
    expect(fileView(a, rec("verified", a.input, { output: "/out/A.mkv" })).fixed!.output).toBe("/out/A.mkv");
    expect(fileView(a).fixed).toBeUndefined();
  });

  it("class a title that must be rebuilt as needing a copy, by either wording", () => {
    expect(skipKindOf(NEEDS_COPY_REASON)).toBe("needs-copy");
    expect(
      skipKindOf("--dangerously-in-place needs a patch-method entry with a patch file; this one was planned for remux"),
    ).toBe("needs-copy");
  });
});

describe("serve, in-place mode with a plan on disk", () => {
  const never = (): never => {
    throw new Error("not expected to be called");
  };
  const engine = (overrides: Partial<EngineDeps> = {}): EngineDeps => ({
    runDoctor: never as unknown as EngineDeps["runDoctor"],
    runPlan: never as unknown as EngineDeps["runPlan"],
    applyPlan: never as unknown as EngineDeps["applyPlan"],
    revertPlan: never as unknown as NonNullable<EngineDeps["revertPlan"]>,
    ...overrides,
  });
  const applied = (input: string) => ({
    input,
    output: input,
    relative: "A.mkv",
    status: "applied",
    reason: undefined,
    inPlace: true,
    resuming: false,
    awaitingVerification: false,
    verified: true,
    bytesWritten: 6,
    sha256: undefined,
    checks: ["wrote and read back 6 range(s) in place"],
    elapsedMs: 1,
  });

  it("asks the engine for an in-place run of exactly the patch titles, and refuses the rebuilt one by name", async () => {
    const planDir = join(dir, "plan-mixed");
    const a = fix("A.mkv");
    const rebuilt = fix("Rebuilt.mkv", { method: "remux" });
    await planOf(planDir, [a, rebuilt, fix("B.mkv")]);
    let seen: { dir: string; options: unknown } | undefined;
    const c = startClient(
      engine({
        applyPlan: (async (d: string, options: unknown, deps: { onProgress?: (p: unknown) => void } = {}) => {
          seen = { dir: d, options };
          deps.onProgress?.({ type: "file-start", index: 0, total: 1, input: a.input, relative: a.relative });
          deps.onProgress?.({ type: "file-done", index: 0, total: 1, result: applied(a.input) });
          return {
            dir: d,
            outputRoot: undefined,
            execute: true,
            inPlace: true,
            files: [applied(a.input)],
            summary: { planned: 1, applied: 1, verified: 1, skipped: 0, failed: 0, conflicts: 0, bytesWritten: 6 },
          };
        }) as unknown as EngineDeps["applyPlan"],
      }),
    );
    const id = c.post("apply", { planDir, mode: "in-place", only: [a.input, rebuilt.input] });
    const done = await c.waitFor((m) => m.id === id && (m.result ?? m.error) !== undefined);
    expect(done.error).toBeUndefined();
    expect(seen!.options).toEqual({ inPlace: true, execute: true, only: [a.input], jobs: 1 });
    expect(done.result.mode).toBe("in-place");
    expect(done.result.outputRoot).toBe("");
    expect(done.result.summary).toMatchObject({ planned: 2, applied: 1, skipped: 1 });
    const [refused, fixed] = done.result.files;
    expect(refused).toMatchObject({ input: rebuilt.input, status: "skipped", skipKind: "needs-copy", reason: NEEDS_COPY_REASON, verified: false });
    expect(fixed).toMatchObject({ input: a.input, status: "applied", inPlace: true, verified: true, output: a.input });
    // Both titles are accounted for in the events, in one numbering.
    expect(c.eventsOf(id, "apply.file-done").map((m) => [m.data.index, m.data.total, m.data.file.status])).toEqual([
      [0, 2, "skipped"],
      [1, 2, "applied"],
    ]);
    // And the one being changed says so while it is.
    expect(c.eventsOf(id, "apply.file-progress").map((m) => m.data)).toEqual([{ input: a.input, phase: "in-place" }]);
    await c.close();
  });

  it("answers for rebuilt titles alone without calling the engine at all", async () => {
    const planDir = join(dir, "plan-rebuilt-only");
    const rebuilt = fix("Rebuilt.mkv", { method: "remux" });
    await planOf(planDir, [rebuilt]);
    const c = startClient(engine());
    const r = await c.request("apply", { planDir, mode: "in-place", only: [rebuilt.input] });
    expect(r.result.summary).toMatchObject({ planned: 1, applied: 0, skipped: 1 });
    expect(r.result.files[0].skipKind).toBe("needs-copy");
    await c.close();
  });

  it.skipIf(process.platform === "win32")("refuses the whole run when a chosen file cannot be written — but rehearses it", async () => {
    if (process.getuid?.() === 0) return;
    const planDir = join(dir, "plan-readonly");
    const b = fix("B.mkv");
    await planOf(planDir, [fix("A.mkv"), b]);
    await chmod(b.input, 0o444);
    const c = startClient(
      engine({
        applyPlan: (async (d: string) => ({ dir: d, execute: false, inPlace: true, files: [], summary: {} })) as unknown as EngineDeps["applyPlan"],
      }),
    );
    const r = await c.request("apply", { planDir, mode: "in-place", only: [join(library, "A.mkv"), b.input] });
    expect(r.error!.code).toBe("not-writable");
    expect(r.error!.message).toMatch(/1 of these 2 files cannot be modified, so nothing was started/);
    const dry = await c.request("apply", { planDir, mode: "in-place", only: [b.input], dryRun: true });
    expect(dry.error).toBeUndefined();
    await c.close();
  });

  it("refuses to rebuild a plan directory that holds undo records, and says how many", async () => {
    const planDir = join(dir, "plan-precious");
    const a = fix("A.mkv");
    await planOf(planDir, [a], [rec("started", a.input, { inPlace: true }), rec("patched", a.input, { inPlace: true })]);
    const c = startClient(engine());
    const r = await c.request("plan", { paths: [library], planDir, reanalyze: true });
    expect(r.error!.code).toBe("undo-records");
    expect(r.error!.message).toMatch(/holds undo data for 1 file\(s\) that were fixed in place/);
    await c.close();
  });

  it("allows a rebuild of a plan that has only ever made copies", async () => {
    const planDir = join(dir, "plan-copies");
    const a = fix("A.mkv");
    await planOf(planDir, [a], [rec("started", a.input, { output: "/out/A.mkv" }), rec("verified", a.input, { output: "/out/A.mkv" })]);
    let called = false;
    const c = startClient(
      engine({
        runPlan: (async () => {
          called = true;
          return { dir: planDir, plan: { files: [] }, notFound: [], missingPaths: [], unreadable: [], analyzed: 0, reused: 0 };
        }) as unknown as EngineDeps["runPlan"],
      }),
    );
    const r = await c.request("plan", { paths: [library], planDir, reanalyze: true });
    expect(r.error).toBeUndefined();
    expect(called).toBe(true);
    expect(r.result.undoRecords).toBe(0);
    await c.close();
  });

  it("puts back only what it can aim at, one engine call per title, and answers for the rest", async () => {
    const planDir = join(dir, "plan-revert");
    const a = fix("A.mkv");
    const copied = fix("B.mkv");
    const never_fixed = fix("Rebuilt.mkv");
    await planOf(
      planDir,
      [a, copied, never_fixed],
      [
        rec("started", a.input, { inPlace: true }),
        rec("patched", a.input, { inPlace: true }),
        rec("verified", copied.input, { output: "/out/B.mkv" }),
      ],
    );
    const calls: unknown[] = [];
    const c = startClient(
      engine({
        revertPlan: (async (d: string, options: { file: string }) => {
          calls.push(options);
          return {
            dir: d,
            files: [
              {
                input: options.file,
                target: options.file,
                output: options.file,
                relative: "A.mkv",
                inPlace: true,
                status: "reverted",
                reason: undefined,
                validation: false,
                patches: 6,
                bytesChanged: 6,
                bytesWritten: 6,
                sha256: undefined,
                checks: ["wrote 6 range(s) back and re-read them"],
                elapsedMs: 2,
              },
            ],
          };
        }) as unknown as NonNullable<EngineDeps["revertPlan"]>,
      }),
    );
    await chmod(copied.input, 0o644);
    const id = c.post("revert", { planDir, only: [a.input, copied.input, never_fixed.input] });
    const done = await c.waitFor((m) => m.id === id && (m.result ?? m.error) !== undefined);
    expect(done.error).toBeUndefined();
    expect(calls).toEqual([{ file: a.input, inPlace: true, execute: true }]);
    expect(done.result.summary).toEqual({ asked: 3, reverted: 1, skipped: 2, failed: 0 });
    const byInput = new Map(done.result.files.map((f: { input: string }) => [f.input, f]));
    expect(byInput.get(a.input)).toMatchObject({ status: "reverted", bytesChanged: 6 });
    expect(byInput.get(copied.input)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/fixed as a copy/) });
    expect(byInput.get(never_fixed.input)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/not been fixed in place/) });
    expect(c.eventsOf(id, "revert.file-done")).toHaveLength(3);

    expect((await c.request("revert", { planDir, only: [join(library, "nope.mkv")] })).error!.code).toBe("bad-request");
    expect((await c.request("revert", { planDir, only: [a.input], outputRoot: "/x" })).error!.code).toBe("bad-request");
    await c.close();
  });

  /** A `revertPlan` that answers for the title its filter names, and keeps its date through the request's watch. */
  const revertKeeping = (calls: { options: unknown; watch: DateWatch | undefined }[]) =>
    (async (d: string, options: { file: string }, deps: { dateWatch?: DateWatch } = {}) => {
      calls.push({ options, watch: deps.dateWatch });
      deps.dateWatch?.add(options.file, Date.parse("2020-01-01T00:00:00Z"));
      return {
        dir: d,
        files: [
          {
            input: options.file,
            target: options.file,
            output: options.file,
            relative: options.file.slice(library.length + 1),
            inPlace: true,
            status: "reverted",
            reason: undefined,
            validation: false,
            patches: 6,
            bytesChanged: 6,
            bytesWritten: 6,
            sha256: undefined,
            checks: [],
            elapsedMs: 2,
          },
        ],
      };
    }) as unknown as NonNullable<EngineDeps["revertPlan"]>;

  async function twoFixedInPlace(name: string): Promise<{ planDir: string; a: PlanFileEntry; b: PlanFileEntry }> {
    const planDir = join(dir, name);
    const a = fix("A.mkv");
    const b = fix("B.mkv");
    await planOf(planDir, [a, b], [
      rec("started", a.input, { inPlace: true }),
      rec("patched", a.input, { inPlace: true }),
      rec("started", b.input, { inPlace: true }),
      rec("patched", b.input, { inPlace: true }),
    ]);
    await chmod(b.input, 0o644);
    return { planDir, a, b };
  }

  it("keeps dates through one watch for a whole undo, waited for once, and says so once", async () => {
    const { planDir, a, b } = await twoFixedInPlace("plan-revert-dates");
    const calls: { options: unknown; watch: DateWatch | undefined }[] = [];
    const settle = vi.spyOn(DateWatch.prototype, "settle");
    try {
      const c = startClient(
        engine({ revertPlan: revertKeeping(calls), dateWatchOptions: { windowMs: 300, pollMs: 20 } }),
      );
      const id = c.post("revert", { planDir, only: [a.input, b.input], keepDates: true });
      const done = await c.waitFor((m) => m.id === id && (m.result ?? m.error) !== undefined);
      expect(done.error).toBeUndefined();
      expect(calls.map((x) => x.options)).toEqual([
        { file: a.input, inPlace: true, execute: true, preserveDates: true },
        { file: b.input, inPlace: true, execute: true, preserveDates: true },
      ]);
      // The same watch for both titles, and the request waited for it once.
      expect(calls[0]!.watch).toBeInstanceOf(DateWatch);
      expect(calls[1]!.watch).toBe(calls[0]!.watch);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(calls[0]!.watch!.remaining()).toEqual({ files: 0, waitMs: 0 });
      const dates = c.eventsOf(id, "revert.dates");
      expect(dates).toHaveLength(1);
      expect(dates[0]!.data).toEqual({ files: 2, seconds: 1 });
      // After every title, before the answer.
      const order = c.messages.filter((m) => m.id === id && m.event !== "log").map((m) => m.event ?? "result");
      expect(order.slice(-2)).toEqual(["revert.dates", "result"]);
      expect(order.lastIndexOf("revert.file-done")).toBeLessThan(order.indexOf("revert.dates"));
      expect(done.result.summary).toMatchObject({ reverted: 2, failed: 0 });
      for (const f of done.result.files) expect(f.dateNotKept).toBeUndefined();
      await c.close();
    } finally {
      settle.mockRestore();
    }
  });

  it("says on the title when a kept date was cut short, and still counts the undo", async () => {
    const { planDir, a } = await twoFixedInPlace("plan-revert-dates-stopped");
    const c = startClient(
      engine({ revertPlan: revertKeeping([]), dateWatchOptions: { windowMs: 60_000, pollMs: 20 } }),
    );
    const id = c.post("revert", { planDir, only: [a.input], keepDates: true });
    await c.waitFor((m) => m.id === id && m.event === "revert.dates");
    await c.request("cancel", { id });
    const done = await c.waitFor((m) => m.id === id && (m.result ?? m.error) !== undefined);
    expect(done.result.files[0]).toMatchObject({ status: "reverted", dateNotKept: expect.stringMatching(/cancelled/) });
    expect(done.result.summary).toMatchObject({ reverted: 1, failed: 0 });
    await c.close();
  });

  it("without keepDates: no watch, no wait, no event — as before", async () => {
    const { planDir, a, b } = await twoFixedInPlace("plan-revert-no-dates");
    const calls: { options: unknown; watch: DateWatch | undefined }[] = [];
    const c = startClient(engine({ revertPlan: revertKeeping(calls), dateWatchOptions: { windowMs: 300 } }));
    const id = c.post("revert", { planDir, only: [a.input, b.input] });
    await c.waitFor((m) => m.id === id && (m.result ?? m.error) !== undefined);
    expect(calls.map((x) => x.options)).toEqual([
      { file: a.input, inPlace: true, execute: true },
      { file: b.input, inPlace: true, execute: true },
    ]);
    expect(calls.every((x) => x.watch === undefined)).toBe(true);
    expect(c.eventsOf(id, "revert.dates")).toEqual([]);
    await c.close();
  });

  it("passes keepDates to an in-place fix with the request's own watch, and waits for it once", async () => {
    const planDir = join(dir, "plan-apply-dates");
    const a = fix("A.mkv");
    await planOf(planDir, [a]);
    const seen: { options: unknown; watch: DateWatch | undefined }[] = [];
    const settle = vi.spyOn(DateWatch.prototype, "settle");
    try {
      const c = startClient(
        engine({
          applyPlan: (async (d: string, options: unknown, deps: { dateWatch?: DateWatch } = {}) => {
            seen.push({ options, watch: deps.dateWatch });
            deps.dateWatch?.add(a.input, Date.parse("2020-01-01T00:00:00Z"));
            return {
              dir: d,
              outputRoot: undefined,
              execute: true,
              inPlace: true,
              files: [applied(a.input)],
              summary: { planned: 1, applied: 1, verified: 1, skipped: 0, failed: 0, conflicts: 0, bytesWritten: 6 },
            };
          }) as unknown as EngineDeps["applyPlan"],
          dateWatchOptions: { windowMs: 300, pollMs: 20 },
        }),
      );
      const id = c.post("apply", { planDir, mode: "in-place", only: [a.input], keepDates: true });
      const done = await c.waitFor((m) => m.id === id && (m.result ?? m.error) !== undefined);
      expect(done.error).toBeUndefined();
      expect(seen[0]!.options).toEqual({ inPlace: true, execute: true, only: [a.input], jobs: 1, preserveDates: true });
      expect(seen[0]!.watch).toBeInstanceOf(DateWatch);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(c.eventsOf(id, "apply.dates").map((m) => m.data)).toEqual([{ files: 1, seconds: 1 }]);
      expect(done.result.files[0]).toMatchObject({ status: "applied", verified: true });
      expect(done.result.files[0].dateNotKept).toBeUndefined();

      const copyId = c.post("apply", { planDir, outputRoot: join(dir, "out"), only: [a.input], keepDates: true });
      const refused = await c.waitFor((m) => m.id === copyId && (m.result ?? m.error) !== undefined);
      expect(refused.error).toMatchObject({ code: "bad-request", message: expect.stringMatching(/"keepDates" has no meaning/) });
      await c.close();
    } finally {
      settle.mockRestore();
    }
  });

  it("is one job at a time, like a fix", async () => {
    const planDir = join(dir, "plan-busy");
    const a = fix("A.mkv");
    await planOf(planDir, [a], [rec("started", a.input, { inPlace: true }), rec("patched", a.input, { inPlace: true })]);
    let release: () => void = () => undefined;
    const c = startClient(
      engine({
        revertPlan: (async (d: string) => {
          await new Promise<void>((r) => (release = r));
          return { dir: d, files: [] };
        }) as unknown as NonNullable<EngineDeps["revertPlan"]>,
      }),
    );
    const first = c.post("revert", { planDir, only: [a.input] });
    await new Promise((r) => setTimeout(r, 40));
    expect((await c.request("apply", { planDir, mode: "in-place", only: [a.input] })).error!.code).toBe("busy");
    release();
    const done = await c.waitFor((m) => m.id === first && (m.result ?? m.error) !== undefined);
    // The engine answered for no title: said as a failure, never as a success.
    expect(done.result.files[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/did not answer for exactly this title/) });
    await c.close();
  });
});
