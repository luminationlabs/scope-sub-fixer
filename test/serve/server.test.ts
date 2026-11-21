import { describe, expect, it } from "vitest";
import type { PlanFileEntry } from "../../src/batch/planFile.js";
import type { PlanRunResult } from "../../src/batch/plan.js";
import type { DoctorReport } from "../../src/cli/doctor.js";
import { TOOL_VERSION } from "../../src/report/version.js";
import {
  doctorProblems,
  fileView,
  planResult,
  PROTOCOL_VERSION,
} from "../../src/serve/protocol.js";
import {
  parseApplyParams,
  parsePlanParams,
  RequestError,
  unsafeOutputReason,
  type EngineDeps,
} from "../../src/serve/server.js";
import { startClient } from "./harness.js";

function entry(overrides: Partial<PlanFileEntry> = {}): PlanFileEntry {
  return {
    input: "/lib/Scope (2024).mkv",
    root: "/lib",
    relative: "Scope (2024).mkv",
    size: 1000,
    mtimeMs: 1,
    status: "NEEDS_FIX",
    video: { w: 1920, h: 1080 },
    active_area: {
      top: 138,
      bottom: 942,
      left: 0,
      right: 1920,
      aspect: 2.39,
      source: "auto",
      classification: "CONSTANT",
    },
    tracks: [
      {
        mkvmerge_id: 1,
        matroska_number: 2,
        language: "eng",
        name: "English",
        forced: false,
        default: true,
        event_count: 4,
        offending_event_count: 3,
        status: "NEEDS_FIX",
        action: "fix",
      },
      {
        mkvmerge_id: 2,
        matroska_number: 3,
        language: "fre",
        forced: true,
        default: false,
        event_count: 2,
        offending_event_count: 1,
        status: "NEEDS_FIX",
        action: "fix",
      },
    ],
    action: "fix",
    patchFile: "patches/1.json",
    patch_summary: {
      tracks: 2,
      events_moved: 4,
      display_sets: 8,
      position_fields: 16,
      bytes_changed: 20,
    },
    method: "patch",
    analyzed: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function doctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  const tool = (name: "mkvmerge" | "mkvextract" | "ffmpeg") => ({
    tool: name,
    found: true,
    path: `/opt/homebrew/bin/${name}`,
    origin: "path" as const,
    version: `${name} 1`,
    error: undefined,
  });
  return {
    tool: { name: "scope-sub", version: TOOL_VERSION },
    ok: true,
    node: { version: "v24.0.0", major: 24, requiredMajor: 22, required: "22.12", ok: true },
    tools: [tool("mkvmerge"), tool("mkvextract"), tool("ffmpeg")],
    frames: { ok: true, detail: "decodes a frame for measuring" },
    tempDir: { path: "/tmp", writable: true, freeBytes: 1, totalBytes: 2, error: undefined },
    ...overrides,
  };
}

function planRun(files: PlanFileEntry[], extra: Partial<PlanRunResult> = {}): PlanRunResult {
  return {
    dir: "/plans/a",
    plan: {
      schema: 1,
      tool: { name: "scope-sub", version: TOOL_VERSION },
      created: "",
      updated: "",
      options: { aspect: "auto", method: "patch", recursive: true },
      paths: ["/lib"],
      files,
    },
    analyzed: files.length,
    analyzedFiles: files.map((f) => f.input),
    reused: 0,
    keptChanged: [],
    notFound: [],
    superseded: [],
    adopted: [],
    unreadable: [],
    restored: [],
    unfinished: [],
    remargined: [],
    remarginBlocked: [],
    remarginKept: [],
    missingPaths: [],
    summary: {
      files: files.length,
      fix: 0,
      skip: 0,
      tracks: 0,
      eventsMoved: 0,
      positionFields: 0,
      bytesChanged: 0,
      byStatus: {},
    },
    elapsedMs: 1,
    ...extra,
  };
}

const never = (): never => {
  throw new Error("not expected to be called");
};

function fakeEngine(overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    runDoctor: async () => doctorReport(),
    runPlan: never as unknown as EngineDeps["runPlan"],
    applyPlan: never as unknown as EngineDeps["applyPlan"],
    ...overrides,
  };
}

describe("protocol views", () => {
  it("sums the events outside the picture across tracks", () => {
    const view = fileView(entry());
    expect(view.title).toBe("Scope (2024)");
    expect(view.eventsOutside).toBe(4);
    expect(view.eventsToMove).toBe(4);
    expect(view.tracksToFix).toBe(2);
    expect(view.tracks.map((t) => t.id)).toEqual([1, 2]);
    expect(view.tracks[1]!.name).toBeUndefined();
    expect(view.activeArea).toEqual({ top: 138, bottom: 942, aspect: 2.39, classification: "CONSTANT" });
    expect(view.fixed).toBeUndefined();
  });

  it("marks a file the log records as already fixed", () => {
    const view = fileView(entry(), {
      time: "2026-02-02T00:00:00.000Z",
      event: "verified",
      input: "/lib/Scope (2024).mkv",
      output: "/out/Scope (2024).mkv",
    });
    expect(view.fixed).toEqual({ output: "/out/Scope (2024).mkv", time: "2026-02-02T00:00:00.000Z" });
  });

  it("leaves a skip's counts at zero and keeps the unread track's count absent", () => {
    const skip = entry({
      status: "OK",
      action: "skip",
      reason: "no letterbox bars",
      tracks: [
        {
          mkvmerge_id: 1,
          matroska_number: 2,
          language: "eng",
          forced: false,
          default: true,
          offending_event_count: 0,
          status: "OK",
          action: "skip",
        },
      ],
    });
    delete skip.patchFile;
    delete skip.patch_summary;
    const view = fileView(skip);
    expect(view.eventsToMove).toBe(0);
    expect(view.tracks[0]!.eventCount).toBeUndefined();
    expect("eventCount" in view.tracks[0]!).toBe(false);
  });

  it("names the titles a run could not read, so their old verdicts are not shown as new", () => {
    const a = entry();
    const b = entry({ input: "/lib/b.mkv", relative: "b.mkv" });
    const gone = entry({ input: "/lib/gone.mkv", relative: "gone.mkv" });
    const result = planResult(
      planRun([a, b, gone], { unreadable: [b.input, gone.input], notFound: [gone.input] }),
      new Map(),
    );
    expect(result.unreadable).toEqual([b.input]);
    expect(result.files.map((f) => f.input)).toEqual([a.input, b.input]);
  });

  it("reports only the files a run found, with counts to match", () => {
    const a = entry();
    const gone = entry({ input: "/lib/Gone.mkv", relative: "Gone.mkv" });
    const safe = entry({ input: "/lib/Safe.mkv", relative: "Safe.mkv", status: "OK", action: "skip" });
    const result = planResult(planRun([a, gone, safe], { notFound: ["/lib/Gone.mkv"] }), new Map());
    expect(result.files.map((f) => f.relative)).toEqual(["Scope (2024).mkv", "Safe.mkv"]);
    expect(result.summary).toEqual({ files: 2, fix: 1, skip: 1, byStatus: { NEEDS_FIX: 1, OK: 1 } });
    expect(result.cancelled).toBe(false);
  });
});

describe("doctorProblems", () => {
  it("is empty when everything is present", () => {
    expect(doctorProblems(doctorReport())).toEqual([]);
  });

  it("reports MKVToolNix once for both of its tools, with how to install it", () => {
    const report = doctorReport({ ok: false });
    for (const t of report.tools) {
      if (t.tool !== "ffmpeg") {
        t.found = false;
        t.path = undefined;
        t.error = "not found";
      }
    }
    const problems = doctorProblems(report);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.what).toBe("mkvmerge, mkvextract");
    expect(problems[0]!.fix).toMatch(/mkvtoolnix\.download/);
  });

  it("reports a missing ffmpeg, and one that cannot read frames separately", () => {
    const missing = doctorReport({ ok: false });
    missing.tools[2]!.found = false;
    expect(doctorProblems(missing).map((p) => p.what)).toEqual(["ffmpeg"]);

    const noFrames = doctorReport({ ok: false, frames: { ok: false, detail: "no lavfi" } });
    expect(doctorProblems(noFrames).map((p) => p.what)).toEqual(["frames"]);
    expect(doctorProblems(noFrames)[0]!.message).toBe("This FFmpeg installation cannot decode video (no lavfi).");
  });

  it("reports an unwritable temp folder", () => {
    const report = doctorReport({
      ok: false,
      tempDir: { path: "/tmp", writable: false, freeBytes: 0, totalBytes: 0, error: "EACCES" },
    });
    expect(doctorProblems(report)[0]!.message).toMatch(/EACCES/);
  });
});

describe("params", () => {
  it("accepts a minimal plan request", () => {
    expect(parsePlanParams({ paths: ["/lib"], planDir: "/p" })).toEqual({ paths: ["/lib"], planDir: "/p" });
  });

  it.each([
    [undefined],
    [{ paths: [], planDir: "/p" }],
    [{ paths: ["/lib"] }],
    [{ paths: ["/lib"], planDir: "/p", aspect: "wide" }],
    [{ paths: ["/lib"], planDir: "/p", aspect: -1 }],
    [{ paths: ["/lib"], planDir: "/p", jobs: 0 }],
    [{ paths: ["/lib"], planDir: "/p", recursive: "yes" }],
  ])("refuses a bad plan request %j", (raw) => {
    expect(() => parsePlanParams(raw)).toThrow(RequestError);
  });

  it("requires only, and refuses every mode that writes into the library", () => {
    const ok = { planDir: "/p", outputRoot: "/out", only: ["/lib/a.mkv"] };
    expect(parseApplyParams(ok)).toEqual(ok);
    expect(() => parseApplyParams({ planDir: "/p", outputRoot: "/out" })).toThrow(/only/);
    expect(() => parseApplyParams({ ...ok, only: [] })).toThrow(/only/);
    expect(() => parseApplyParams({ planDir: "/p", only: ["/lib/a.mkv"] })).toThrow(/outputRoot/);
    for (const key of ["inPlace", "replaceOriginal", "dangerouslyInPlace", "skipVerify", "overwriteOutput"]) {
      expect(() => parseApplyParams({ ...ok, [key]: true })).toThrow(/only writes copies/);
      expect(() => parseApplyParams({ ...ok, [key]: false })).toThrow(/only writes copies/);
    }
  });
});

describe("unsafeOutputReason, by spelling alone", () => {
  // Paths that do not exist: only the lexical half of the check can answer.
  // The real-path half is in safety.test.ts.
  const e = { input: "/nonexistent-lib/sub/a.mkv", root: "/nonexistent-lib", relative: "sub/a.mkv" };
  it("refuses the library folder and anything inside it", async () => {
    expect(await unsafeOutputReason("/nonexistent-lib", [e])).toMatch(/inside the library/);
    expect(await unsafeOutputReason("/nonexistent-lib/", [e])).toMatch(/inside the library/);
    expect(await unsafeOutputReason("/nonexistent-lib/fixed", [e])).toMatch(/inside the library/);
    expect(await unsafeOutputReason("/nonexistent-lib/../nonexistent-lib/x", [e])).toMatch(/inside the library/);
  });
  it("refuses a folder that maps a rootless file onto itself", async () => {
    expect(
      await unsafeOutputReason("/nonexistent-lib", [{ input: "/nonexistent-lib/a.mkv", relative: "a.mkv" }]),
    ).toMatch(/over the original/);
  });
  it("allows a sibling, even one whose name starts the same", async () => {
    expect(await unsafeOutputReason("/nonexistent-lib-fixed", [e])).toBeNull();
    expect(await unsafeOutputReason("/nonexistent-out", [e])).toBeNull();
  });
});

describe("serve", () => {
  it("announces itself, then answers hello", async () => {
    const c = startClient(fakeEngine());
    const ready = await c.waitFor((m) => m.event === "ready");
    expect(ready.data).toMatchObject({ name: "scope-sub", version: TOOL_VERSION, protocol: PROTOCOL_VERSION });
    const hello = await c.request("hello");
    expect(hello.result.methods).toContain("plan");
    await c.close();
  });

  it("answers doctor with the report and its problems", async () => {
    const report = doctorReport({ ok: false });
    report.tools[2]!.found = false;
    const c = startClient(fakeEngine({ runDoctor: async () => report }));
    const r = await c.request("doctor");
    expect(r.result.ok).toBe(false);
    expect(r.result.report.tools).toHaveLength(3);
    expect(r.result.problems.map((p: { what: string }) => p.what)).toEqual(["ffmpeg"]);
    await c.close();
  });

  it("survives junk, and names what was wrong", async () => {
    const c = startClient(fakeEngine());
    c.raw("this is not json");
    c.raw("");
    c.raw(JSON.stringify({ method: "hello" }));
    c.raw(JSON.stringify([1, 2]));
    const unknown = await c.request("frobnicate");
    expect(unknown.error!.code).toBe("unknown-method");
    const bad = c.messages.filter((m) => m.id === null);
    expect(bad).toHaveLength(3);
    expect(bad.every((m) => m.error!.code === "bad-request")).toBe(true);
    expect((await c.request("plan", { paths: [] })).error!.code).toBe("bad-request");
    expect((await c.request("hello")).result.name).toBe("scope-sub");
    await c.close();
  });

  it("forwards plan progress as events and returns the view", async () => {
    const a = entry();
    let seenOptions: unknown;
    const c = startClient(
      fakeEngine({
        runPlan: async (paths, dir, options, deps = {}) => {
          seenOptions = { paths, dir, options };
          deps.onProgress?.({ type: "targets", targets: [{ file: a.input, relative: a.relative }] });
          deps.onProgress?.({ type: "file-start", index: 0, file: a.input, relative: a.relative });
          deps.onProgress?.({ type: "file-progress", index: 0, file: a.input, position: 5, fileSize: 10 });
          deps.log?.info("hello from the engine");
          deps.log?.debug("not forwarded");
          deps.onProgress?.({ type: "file-done", index: 0, file: a.input, relative: a.relative, entry: a, analyzed: true });
          return planRun([a], { dir: "/nonexistent-plan-dir-for-test" });
        },
      }),
    );
    const id = c.post("plan", { paths: ["/lib"], planDir: "/nonexistent-plan-dir-for-test" });
    const done = await c.waitFor((m) => m.id === id && m.result !== undefined);
    expect(seenOptions).toEqual({
      paths: ["/lib"],
      dir: "/nonexistent-plan-dir-for-test",
      options: { aspect: "auto", recursive: true },
    });
    expect(c.eventsOf(id).map((m) => m.event)).toEqual([
      "plan.targets",
      "plan.file-start",
      "plan.file-progress",
      "log",
      "plan.file-done",
    ]);
    expect(c.eventsOf(id, "plan.targets")[0]!.data.total).toBe(1);
    expect(c.eventsOf(id, "plan.file-progress")[0]!.data).toEqual({ index: 0, file: a.input, done: 5, total: 10 });
    expect(c.eventsOf(id, "plan.file-done")[0]!.data.file.eventsOutside).toBe(4);
    expect(done.result.files).toHaveLength(1);
    expect(done.result.summary.fix).toBe(1);
    await c.close();
  });

  it("cancels the running job, refuses a second one meanwhile, and runs the next", async () => {
    let calls = 0;
    const c = startClient(
      fakeEngine({
        runPlan: async (_paths, _dir, _options, deps = {}) => {
          calls++;
          if (calls === 1) {
            // The cancel may land while the request is still being checked.
            if (!deps.signal!.aborted) {
              await new Promise<void>((resolve) => deps.signal!.addEventListener("abort", () => resolve()));
            }
            return planRun([], { dir: "/nonexistent-plan-dir-for-test", cancelled: true });
          }
          return planRun([], { dir: "/nonexistent-plan-dir-for-test" });
        },
      }),
    );
    const params = { paths: ["/lib"], planDir: "/nonexistent-plan-dir-for-test" };
    const first = c.post("plan", params);
    const busy = await c.request("plan", params);
    expect(busy.error!.code).toBe("busy");

    expect((await c.request("cancel", { id: 999 })).result).toEqual({ cancelled: false });
    expect((await c.request("cancel", { id: first })).result).toEqual({ cancelled: true });
    const ended = await c.waitFor((m) => m.id === first && m.result !== undefined);
    expect(ended.result.cancelled).toBe(true);

    const again = await c.request("plan", params);
    expect(again.result.cancelled).toBe(false);
    expect((await c.request("cancel", {})).error!.code).toBe("bad-request");
    await c.close();
  });

  it("aborts a running job when the input closes", async () => {
    let aborted = false;
    // Resolved when the scan is really running: a fixed pause lost that race
    // on a loaded machine, and the input then closed before there was a job.
    let entered: () => void = () => undefined;
    const running = new Promise<void>((r) => (entered = r));
    const c = startClient(
      fakeEngine({
        runPlan: async (_p, _d, _o, deps = {}) => {
          entered();
          await new Promise<void>((resolve) => deps.signal!.addEventListener("abort", () => resolve()));
          aborted = true;
          return planRun([], { dir: "/nonexistent-plan-dir-for-test", cancelled: true });
        },
      }),
    );
    const id = c.post("plan", { paths: ["/lib"], planDir: "/nonexistent-plan-dir-for-test" });
    await c.waitFor((m) => m.event === "ready");
    await running;
    await c.close();
    expect(aborted).toBe(true);
    expect(c.messages.some((m) => m.id === id && m.result !== undefined)).toBe(true);
  });

  it("stops at shutdown", async () => {
    const c = startClient(fakeEngine());
    const r = await c.request("shutdown");
    expect(r.result).toEqual({});
    await c.done;
  });

  it("maps engine errors onto codes", async () => {
    const { PlanFileError } = await import("../../src/batch/planFile.js");
    const { DependencyMissingError } = await import("../../src/mkv/inspect.js");
    let n = 0;
    const c = startClient(
      fakeEngine({
        runPlan: async () => {
          n++;
          if (n === 1) throw new PlanFileError("built by another version");
          if (n === 2) throw new DependencyMissingError("mkvmerge");
          throw new Error("boom");
        },
      }),
    );
    const params = { paths: ["/lib"], planDir: "/p" };
    expect((await c.request("plan", params)).error).toEqual({ code: "plan-file", message: "built by another version" });
    expect((await c.request("plan", params)).error!.code).toBe("dependency-missing");
    expect((await c.request("plan", params)).error).toEqual({ code: "failed", message: "boom" });
    await c.close();
  });
});
