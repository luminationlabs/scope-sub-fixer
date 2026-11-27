#!/usr/bin/env node
/**
 * The real engine, except that `doctor` reports MKVToolNix and FFmpeg as not
 * installed. For looking at the app's "setup needed" screen on a machine that
 * has them: swap it in for the sidecar inside a *copy* of the built app
 * (see README, "Screenshots"). Needs `pnpm build` in the repo root.
 */
import { createInterface } from "node:readline";
import { runDoctor } from "../../dist/cli/doctor.js";
import { runPlan } from "../../dist/batch/plan.js";
import { applyPlan } from "../../dist/batch/apply.js";
import { serve } from "../../dist/serve/server.js";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
await serve(
  { input: lines, write: (line) => process.stdout.write(`${line}\n`) },
  {
    runPlan,
    applyPlan,
    runDoctor: async (options) => {
      const report = await runDoctor(options);
      for (const t of report.tools) {
        t.found = false;
        t.path = undefined;
        t.origin = undefined;
        t.version = undefined;
        t.error = "not found on PATH or in any of the extra search directories";
      }
      report.frames = { ok: false, detail: "ffmpeg not available" };
      report.ok = false;
      return report;
    },
  },
);
lines.close();
