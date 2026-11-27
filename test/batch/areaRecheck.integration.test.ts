/**
 * The hook a future `ACTIVE_AREA_RULES` bump uses: an unchanged title whose
 * skip verdict a rule in `AREA_RECHECKS` picks out is analyzed again, once.
 * No such rule exists yet, so the test supplies one.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AREA_RECHECKS, runPlan, type AreaRecheck } from "../../src/batch/plan.js";
import { ACTIVE_AREA_RULES, type PlanFile } from "../../src/batch/planFile.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSup,
} from "../helpers/scanFixture.js";
import { SCOPE_SPEC } from "./support.js";

const tools =
  (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

describe.skipIf(!tools)("re-checking verdicts from an older generation", () => {
  let dir: string;
  let library: string;
  let plan: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    library = join(dir, "lib");
    plan = join(dir, "plan");
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), { activeHeight: 804, seconds: 8 });
    const sup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    await mkdir(library, { recursive: true });
    await makeMkv(join(library, "Scope (2020).mkv"), video, sup, { trackName: "English" });
  }, 300000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("re-analyzes an unchanged title a rule picks out, and only once", async () => {
    const first = await runPlan([library], plan, { aspect: "auto", method: "patch" });
    expect(first.plan.files[0]!).toMatchObject({ status: "NEEDS_FIX", action: "fix", area_rules: ACTIVE_AREA_RULES });

    // The entry as an older generation might have left it: left alone as
    // mixed, nothing planned.
    const path = join(plan, "plan.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as PlanFile;
    const entry = raw.files[0]!;
    entry.status = "MIXED_ASPECT_RATIO";
    entry.action = "skip";
    entry.reason = "variable aspect ratio: no single picture area applies";
    delete entry.patchFile;
    delete entry.patch_summary;
    entry.area_rules = ACTIVE_AREA_RULES - 1;
    await writeFile(path, JSON.stringify(raw));

    // No rule: the verdict stands.
    const kept = await runPlan([library], plan, { aspect: "auto", method: "patch" });
    expect(kept.analyzed).toBe(0);
    expect(kept.plan.files[0]!.status).toBe("MIXED_ASPECT_RATIO");

    const rule: AreaRecheck = (e) =>
      e.status === "MIXED_ASPECT_RATIO" ? "picture detection has improved since" : undefined;
    AREA_RECHECKS.push(rule);
    try {
      const again = await runPlan([library], plan, { aspect: "auto", method: "patch" });
      expect(again.analyzed).toBe(1);
      expect(again.reused).toBe(0);
      expect(again.plan.files[0]!).toMatchObject({ status: "NEEDS_FIX", action: "fix", area_rules: ACTIVE_AREA_RULES });

      const after = await runPlan([library], plan, { aspect: "auto", method: "patch" });
      expect(after.analyzed).toBe(0);
      expect(after.reused).toBe(1);
    } finally {
      AREA_RECHECKS.splice(AREA_RECHECKS.indexOf(rule), 1);
    }
  }, 300000);
});
