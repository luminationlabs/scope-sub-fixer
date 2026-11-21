/**
 * The app's safety policy against a real filesystem: symlinks, a parent of the
 * library, another spelling of the same folder, a full disk, and what an
 * interrupted run leaves behind. No media: the files are a few bytes.
 */
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preflightDecision, type ApplyRunResult } from "../../src/batch/apply.js";
import { appendApplyLog, shouldSkipForResume } from "../../src/batch/log.js";
import {
  PLAN_RULES_VERSION,
  PLAN_SCHEMA_VERSION,
  writePlan,
  type PlanFile,
  type PlanFileEntry,
} from "../../src/batch/planFile.js";
import { claimEngineTemp, sweepStaleEngineTemp, tempEnvVars } from "../../src/cli/serve.js";
import { TOOL_VERSION } from "../../src/report/version.js";
import { applyFileView, skipKindOf } from "../../src/serve/protocol.js";
import {
  insideAny,
  spaceNeeded,
  spaceShortfall,
  unsafeOutputReason,
} from "../../src/serve/safety.js";
import { partialPathFor } from "../../src/fix/copyPatch.js";
import { stalePartials, type EngineDeps } from "../../src/serve/server.js";
import { startClient } from "./harness.js";

let dir: string;
let library: string;
let a: string;
let nested: string;
let caseInsensitive = false;

function fix(input: string, relative: string, extra: Partial<PlanFileEntry> = {}): PlanFileEntry {
  return {
    input,
    root: library,
    relative,
    size: 1000,
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

async function planOf(planDir: string, files: PlanFileEntry[]): Promise<void> {
  const plan: PlanFile = {
    schema: PLAN_SCHEMA_VERSION,
    tool: { name: "scope-sub", version: TOOL_VERSION, rules: PLAN_RULES_VERSION },
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    options: { aspect: "auto", method: "patch", recursive: true },
    paths: [library],
    files,
  };
  await writePlan(planDir, plan);
}

beforeAll(async () => {
  // The real path: the checks answer in real paths, and macOS's temp is a symlink.
  dir = await realpath(await mkdtemp(join(tmpdir(), "scope-sub-safety-")));
  library = join(dir, "Scope");
  await mkdir(join(library, "Scope"), { recursive: true });
  await mkdir(join(library, "Extras"), { recursive: true });
  a = join(library, "A.mkv");
  nested = join(library, "Scope", "A.mkv");
  await writeFile(a, "the original A");
  await writeFile(nested, "the original nested A");
  caseInsensitive = await stat(join(dir, "SCOPE")).then(
    () => true,
    () => false,
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("unsafeOutputReason, on real paths", () => {
  const entries = (): PlanFileEntry[] => [fix(a, "A.mkv"), fix(nested, join("Scope", "A.mkv"))];

  it("allows a folder outside the library, existing or not", async () => {
    await mkdir(join(dir, "fixed"), { recursive: true });
    expect(await unsafeOutputReason(join(dir, "fixed"), entries())).toBeNull();
    expect(await unsafeOutputReason(join(dir, "not", "made", "yet"), entries())).toBeNull();
  });

  it("refuses a symlink to the library", async () => {
    const linked = join(dir, "link-to-library");
    await symlink(library, linked);
    expect(await unsafeOutputReason(linked, entries())).toMatch(/inside the library/);
    // And a folder that does not exist yet beneath it.
    expect(await unsafeOutputReason(join(linked, "new"), entries())).toMatch(/inside the library/);
  });

  it("refuses a symlink to a folder inside the library", async () => {
    const linked = join(dir, "link-to-extras");
    await symlink(join(library, "Extras"), linked);
    expect(await unsafeOutputReason(linked, entries())).toMatch(/inside the library/);
  });

  it("refuses a parent of the library when a title would land on, or beside, another", async () => {
    // <dir>/Scope/Scope/A.mkv → <dir> + "Scope/A.mkv" = the other title.
    const reason = await unsafeOutputReason(dir, [entries()[1]!], entries());
    expect(reason).toMatch(/over the original/);
    expect(reason).toContain(a);
    // A title that would only land beside the others is refused too.
    const beside = fix(join(library, "Scope", "B.mkv"), join("Scope", "B.mkv"));
    expect(await unsafeOutputReason(dir, [beside], [...entries(), beside])).toMatch(/inside the library/);
  });

  it("allows a parent of the library when nothing lands inside it", async () => {
    expect(await unsafeOutputReason(dir, [entries()[0]!], entries())).toBeNull();
  });

  it("refuses a title folder in the output that is a symlink back into the library", async () => {
    const out = join(dir, "out-with-link");
    await mkdir(out, { recursive: true });
    await symlink(join(library, "Scope"), join(out, "Scope"));
    expect(await unsafeOutputReason(out, [entries()[1]!], entries())).toMatch(/over the original|inside the library/);
  });

  it("refuses an output path that is an original under another name (a hard link)", async () => {
    const out = join(dir, "out-with-hardlink");
    await mkdir(out, { recursive: true });
    await link(a, join(out, "A.mkv"));
    expect(await unsafeOutputReason(out, [entries()[0]!], entries())).toMatch(/over the original/);
  });

  it("refuses another spelling of the library on a case-insensitive volume", async (ctx) => {
    if (!caseInsensitive) return ctx.skip();
    expect(await unsafeOutputReason(join(dir, "SCOPE", "fixed"), entries())).toMatch(/inside the library/);
    expect(await unsafeOutputReason(join(dir, "scope"), entries())).toMatch(/inside the library/);
  });
});

describe("insideAny", () => {
  it("finds a folder inside a scanned one, however it is spelled", async () => {
    expect(await insideAny(join(library, "plan"), [library])).toBe(library);
    const linked = join(dir, "link-for-plan");
    await symlink(library, linked);
    expect(await insideAny(join(linked, "plan"), [library])).toBe(library);
    expect(await insideAny(join(dir, "plans", "x"), [library])).toBeNull();
    // A file given by name is not a folder that holds anything.
    expect(await insideAny(join(dir, "plans"), [a])).toBeNull();
  });
});

describe("space", () => {
  const GB = 1e9;
  it("needs the copies, plus room for the largest rebuilt title", () => {
    const need = spaceNeeded([
      { size: 10 * GB, method: "patch" },
      { size: 30 * GB, method: "remux" },
      { size: 20 * GB, method: "remux" },
    ]);
    expect(need.output).toBe(Math.ceil(60 * GB * 1.02));
    expect(need.temp).toBe(Math.ceil(30 * GB * 1.02));
    expect(spaceNeeded([{ size: GB, method: "patch" }]).temp).toBe(0);
  });

  const facts = { outputRoot: "/out", tempDir: "/tmp/x", sameVolume: false };
  it("fits when both places have room", () => {
    expect(
      spaceShortfall({ output: 10 * GB, temp: 5 * GB }, { ...facts, freeOutput: 11 * GB, freeTemp: 6 * GB }),
    ).toBeNull();
  });
  it("names the output folder when the copies will not fit", () => {
    const why = spaceShortfall({ output: 10 * GB, temp: 0 }, { ...facts, freeOutput: 9 * GB, freeTemp: GB });
    expect(why).toMatch(/not enough free space in \/out/);
    expect(why).toMatch(/10\.0 GB/);
    expect(why).toMatch(/9\.0 GB is free/);
  });
  it("names the temporary folder when a rebuild will not fit there", () => {
    const why = spaceShortfall({ output: GB, temp: 5 * GB }, { ...facts, freeOutput: 100 * GB, freeTemp: GB });
    expect(why).toMatch(/temporary folder \/tmp\/x/);
  });
  it("adds the two together when they share a disk", () => {
    const shared = { ...facts, sameVolume: true };
    expect(spaceShortfall({ output: 10 * GB, temp: 5 * GB }, { ...shared, freeOutput: 14 * GB, freeTemp: 14 * GB })).toMatch(
      /15\.0 GB in all/,
    );
    expect(
      spaceShortfall({ output: 10 * GB, temp: 5 * GB }, { ...shared, freeOutput: 16 * GB, freeTemp: 16 * GB }),
    ).toBeNull();
  });
  it("does not judge what it could not measure", () => {
    expect(
      spaceShortfall({ output: 10 * GB, temp: 5 * GB }, { ...facts, freeOutput: undefined, freeTemp: undefined }),
    ).toBeNull();
  });
});

describe("skip kinds", () => {
  // The engine's own wording, from the functions that produce it: if either
  // changes, this fails rather than a full disk quietly reading as "other".
  const e = fix("/lib/a.mkv", "a.mkv");
  const there = { exists: true, size: 1000, mtimeMs: 1 };
  it("reads the engine's refusals", () => {
    const gone = preflightDecision(e, { exists: false, size: 0, mtimeMs: 0 }, null);
    const changed = preflightDecision(e, { ...there, size: 999 }, null);
    const full = preflightDecision(e, there, null, { freeBytes: 10 });
    for (const [outcome, kind] of [
      [gone, "input-missing"],
      [changed, "input-changed"],
      [full, "no-space"],
    ] as const) {
      expect(outcome.ok).toBe(false);
      expect(skipKindOf(outcome.ok ? undefined : outcome.reason)).toBe(kind);
    }
  });
  it("reads the three ways a title is already done", () => {
    const base = { time: "", input: "/lib/a.mkv", output: "/out/a.mkv", bytes: 1000 };
    for (const event of ["verified", "replaced", "patched"] as const) {
      const r = shouldSkipForResume({ ...base, event }, { exists: true, size: 1000 });
      expect(r.skip).toBe(true);
      expect(skipKindOf(r.reason)).toBe("already-done");
    }
  });
  it("calls anything else other, and only labels skips", () => {
    expect(skipKindOf("no patch file")).toBe("other");
    expect(skipKindOf(undefined)).toBe("other");
    const result = {
      input: "/lib/a.mkv",
      output: "/out/a.mkv",
      relative: "a.mkv",
      status: "skipped",
      reason: "the original file no longer exists",
      verified: false,
      bytesWritten: 0,
      sha256: undefined,
      checks: [],
      elapsedMs: 0,
    } as unknown as ApplyRunResult["files"][number];
    expect(applyFileView(result).skipKind).toBe("input-missing");
    expect(applyFileView({ ...result, status: "applied", reason: undefined }).skipKind).toBeUndefined();
  });
});

describe("what an interrupted run left", () => {
  it("finds only the partials this plan's log proves are its own", async () => {
    const planDir = join(dir, "plan-partials");
    const out = join(dir, "out-partials");
    await mkdir(join(out, "t"), { recursive: true });
    await planOf(planDir, [fix(a, "A.mkv")]);
    const log = join(planDir, "apply.log.jsonl");
    const rec = (event: "started" | "verified" | "failed", input: string, output: string) =>
      appendApplyLog(log, { time: "t", event, input, output });

    // Killed mid-copy: `started` is the last word.
    await rec("started", "/lib/killed.mkv", join(out, "t", "killed.mkv"));
    await writeFile(partialPathFor(join(out, "t", "killed.mkv")), "half");
    // A file with a generic name is not provably the tool's: left alone.
    await writeFile(join(out, "t", "killed.mkv.partial"), "someone else's download");
    // Finished after an earlier start: not stale, even with a same-named file beside it.
    await rec("started", "/lib/done.mkv", join(out, "done.mkv"));
    await rec("verified", "/lib/done.mkv", join(out, "done.mkv"));
    await writeFile(partialPathFor(join(out, "done.mkv")), "someone else's");
    // Never in the log at all.
    await writeFile(partialPathFor(join(out, "stranger.mkv")), "someone else's");
    // Started into another folder: not this output folder's business.
    await rec("started", "/lib/elsewhere.mkv", join(dir, "out-other", "elsewhere.mkv"));

    expect(await stalePartials(planDir, out)).toEqual([partialPathFor(join(out, "t", "killed.mkv"))]);
  });

  it("sweeps the scratch folders of engines that are gone, and nothing else", async () => {
    const base = join(dir, "temp-base");
    await mkdir(join(base, "scope-sub-engine-111", "scope-sub-fix-abc"), { recursive: true });
    await mkdir(join(base, "scope-sub-engine-222"), { recursive: true });
    await mkdir(join(base, `scope-sub-engine-${process.pid}`), { recursive: true });
    await mkdir(join(base, "scope-sub-engine-notapid"), { recursive: true });
    await mkdir(join(base, "scope-sub-fix-someone"), { recursive: true });
    await writeFile(join(base, "scope-sub-engine-111", "scope-sub-fix-abc", "t0.bin"), "x");
    const removed = await sweepStaleEngineTemp(base, (pid) => pid === 222);
    expect(removed).toEqual([join(base, "scope-sub-engine-111")]);
    const left = async (name: string): Promise<boolean> =>
      stat(join(base, name)).then(
        () => true,
        () => false,
      );
    expect(await left("scope-sub-engine-111")).toBe(false);
    expect(await left("scope-sub-engine-222")).toBe(true);
    expect(await left(`scope-sub-engine-${process.pid}`)).toBe(true);
    expect(await left("scope-sub-engine-notapid")).toBe(true);
    expect(await left("scope-sub-fix-someone")).toBe(true);
  });

  it("claims a scratch folder of its own and makes it the temp directory", async () => {
    const base = join(dir, "temp-claim");
    await mkdir(base, { recursive: true });
    const before = tempEnvVars().map((name) => [name, process.env[name]] as const);
    try {
      const own = await claimEngineTemp(base);
      expect(own).toBe(join(base, `scope-sub-engine-${process.pid}`));
      expect(tmpdir()).toBe(own);
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("names the temp directory the way each platform reads it", () => {
    expect(tempEnvVars("darwin")).toEqual(["TMPDIR"]);
    expect(tempEnvVars("linux")).toEqual(["TMPDIR"]);
    // os.tmpdir() and the Windows API ignore TMPDIR there.
    expect(tempEnvVars("win32")).toEqual(["TEMP", "TMP"]);
  });
});

describe("serve, the refusals that need a plan on disk", () => {
  const never = (): never => {
    throw new Error("not expected to be called");
  };
  const engine = (overrides: Partial<EngineDeps> = {}): EngineDeps => ({
    runDoctor: never as unknown as EngineDeps["runDoctor"],
    runPlan: never as unknown as EngineDeps["runPlan"],
    applyPlan: never as unknown as EngineDeps["applyPlan"],
    ...overrides,
  });

  it("refuses a plan directory inside the folder being scanned", async () => {
    const c = startClient(engine());
    const r = await c.request("plan", { paths: [library], planDir: join(library, ".plan") });
    expect(r.error!.code).toBe("unsafe-output");
    expect(r.error!.message).toMatch(/inside the folder being scanned/);
    await c.close();
  });

  it("refuses overwriteOutput by name, and a symlinked output folder by what it is", async () => {
    const planDir = join(dir, "plan-refusals");
    await planOf(planDir, [fix(a, "A.mkv")]);
    const linked = join(dir, "link-serve");
    await symlink(library, linked);
    const before = await readFile(a, "utf8");
    const c = startClient(engine());
    const over = await c.request("apply", { planDir, outputRoot: join(dir, "o"), only: [a], overwriteOutput: true });
    expect(over.error!.code).toBe("bad-request");
    expect(over.error!.message).toMatch(/overwriteOutput/);
    const sym = await c.request("apply", { planDir, outputRoot: linked, only: [a] });
    expect(sym.error!.code).toBe("unsafe-output");
    expect(await readFile(a, "utf8")).toBe(before);
    await c.close();
  });

  it("never asks the engine to overwrite, and passes a safe request through", async () => {
    const planDir = join(dir, "plan-pass");
    await planOf(planDir, [fix(a, "A.mkv")]);
    let seen: unknown;
    const c = startClient(
      engine({
        freeBytes: async () => 1e12,
        applyPlan: (async (_dir: string, options: unknown) => {
          seen = options;
          return { dir: planDir, outputRoot: join(dir, "o"), execute: true, files: [], summary: {} };
        }) as unknown as EngineDeps["applyPlan"],
      }),
    );
    const r = await c.request("apply", { planDir, outputRoot: join(dir, "o"), only: [a] });
    expect(r.error).toBeUndefined();
    expect(seen).toMatchObject({ overwriteOutput: false, execute: true, only: [a] });
    await c.close();
  });

  it("refuses to finish a --replace-original swap the command line left half done", async () => {
    const planDir = join(dir, "plan-swap");
    await planOf(planDir, [fix(a, "A.mkv")]);
    await appendApplyLog(join(planDir, "apply.log.jsonl"), {
      time: "t",
      event: "backed-up",
      input: a,
      output: join(dir, "staged", "A.mkv"),
      backup: `${a}.pre-scopefix`,
    });
    const c = startClient(engine({ freeBytes: async () => 1e12 }));
    const r = await c.request("apply", { planDir, outputRoot: join(dir, "o2"), only: [a] });
    expect(r.error!.code).toBe("plan-file");
    expect(r.error!.message).toMatch(/unfinished --replace-original swap/);
    await c.close();
  });

  it("refuses a fix that will not fit, before anything is written", async () => {
    const planDir = join(dir, "plan-space");
    await planOf(planDir, [fix(a, "A.mkv", { size: 50e9 })]);
    const c = startClient(engine({ freeBytes: async () => 20e9 }));
    const out = join(dir, "o3");
    const r = await c.request("apply", { planDir, outputRoot: out, only: [a] });
    expect(r.error!.code).toBe("no-space");
    expect(r.error!.message).toMatch(/not enough free space/i);
    expect(r.error!.message).toMatch(/20\.0 GB is free/);
    // A rehearsal is not refused: it writes nothing.
    const c2 = startClient(
      engine({
        freeBytes: async () => 20e9,
        applyPlan: (async () => ({ dir: planDir, outputRoot: out, execute: false, files: [], summary: {} })) as unknown as EngineDeps["applyPlan"],
      }),
    );
    expect((await c2.request("apply", { planDir, outputRoot: out, only: [a], dryRun: true })).error).toBeUndefined();
    await c.close();
    await c2.close();
  });

  it("is never busy for a job sent right behind one that failed", async () => {
    const c = startClient(
      engine({
        runPlan: (async () => ({ dir: "/nonexistent-plan-dir-for-test", plan: { files: [] }, notFound: [], missingPaths: [], analyzed: 0, reused: 0 })) as unknown as EngineDeps["runPlan"],
      }),
    );
    // Both lines are in the pipe before the first is read.
    const first = c.post("plan", { paths: [] });
    const second = c.post("plan", { paths: ["/nonexistent-lib"], planDir: "/nonexistent-plan-dir-for-test" });
    const a1 = await c.waitFor((m) => m.id === first && m.error !== undefined);
    const a2 = await c.waitFor((m) => m.id === second && (m.result ?? m.error) !== undefined);
    expect(a1.error!.code).toBe("bad-request");
    expect(a2.error).toBeUndefined();
    await c.close();
  });
});
