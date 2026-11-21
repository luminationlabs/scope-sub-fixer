#!/usr/bin/env node
/**
 * Drive an engine binary through the protocol: doctor → plan → apply.
 *
 *   node desktop/scripts/engine-smoke.mjs <library> <work-dir> [engine command...]
 *
 * The engine defaults to the compiled sidecar; pass e.g. `node dist/cli/main.js`
 * to run the same thing against the plain Node build and compare. The plan
 * goes to <work-dir>/plan and the copies to <work-dir>/fixed. Exits non-zero
 * if any step does not end the way a healthy engine ends it.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [library, work, ...engine] = process.argv.slice(2);
if (!library || !work) {
  console.error("usage: engine-smoke.mjs <library> <work-dir> [engine command...]");
  process.exit(2);
}
let command = engine;
if (command.length === 0) {
  const dir = join(here, "..", "src-tauri", "binaries");
  const found = existsSync(dir) && readdirSync(dir).find((n) => n.startsWith("scope-sub-engine-"));
  if (!found) {
    console.error(`no sidecar in ${dir}; run \`pnpm sidecar\` in desktop/ first`);
    process.exit(2);
  }
  command = [join(dir, found)];
}

const child = spawn(command[0], [...command.slice(1), "serve", "--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
const events = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.event !== undefined) {
    if (m.id !== undefined) events.get(m.id)?.push(m);
    return;
  }
  pending.get(m.id)?.(m);
});
const request = (method, params) =>
  new Promise((done) => {
    const id = nextId++;
    events.set(id, []);
    pending.set(id, (m) => done({ ...m, events: events.get(id) }));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const fail = (why) => {
  console.error(`FAIL: ${why}`);
  child.kill();
  process.exit(1);
};
const count = (r, name) => r.events.filter((e) => e.event === name).length;

const hello = await request("hello");
console.log(`engine: ${hello.result.name} ${hello.result.version}, protocol ${hello.result.protocol}`);

const doctor = await request("doctor");
console.log(`doctor: ${doctor.result.ok ? "ok" : "NOT ok"} (runtime ${doctor.result.report.node.version})`);
for (const p of doctor.result.problems) console.log(`  - ${p.message}\n    ${p.fix}`);
if (!doctor.result.ok) fail("doctor");

const planDir = resolve(work, "plan");
const plan = await request("plan", { paths: [resolve(library)], planDir, remuxFallback: true });
if (plan.error) fail(`plan: ${plan.error.message}`);
console.log(
  `plan: ${plan.result.summary.files} file(s), ${plan.result.summary.fix} to fix; ` +
    `${plan.result.analyzed} read, ${plan.result.reused} reused; ` +
    `${count(plan, "plan.file-start")} start / ${count(plan, "plan.file-progress")} progress / ` +
    `${count(plan, "plan.file-done")} done event(s)`,
);
for (const f of plan.result.files) {
  console.log(
    `  ${(f.action === "fix" ? f.method : "skip").padEnd(5)} ${f.status.padEnd(10)} ${String(f.eventsOutside).padStart(4)} outside  ${f.title}` +
      (f.fixed ? "  [already fixed]" : ""),
  );
}
if (count(plan, "plan.file-done") !== plan.result.summary.files) fail("a file-done event is missing");

const only = plan.result.files.filter((f) => f.action === "fix").map((f) => f.input);
if (only.length === 0) {
  console.log("nothing to fix");
} else {
  const refused = await request("apply", { planDir, outputRoot: resolve(library), only });
  if (refused.error?.code !== "unsafe-output") fail("the library was accepted as an output folder");
  console.log("apply into the library itself: refused, as it must be");

  const apply = await request("apply", { planDir, outputRoot: resolve(work, "fixed"), only });
  if (apply.error) fail(`apply: ${apply.error.message}`);
  const s = apply.result.summary;
  console.log(
    `apply: ${s.applied} applied, ${s.verified} verified, ${s.skipped} skipped, ${s.failed} failed, ` +
      `${s.conflicts} conflict(s); ${count(apply, "apply.file-progress")} progress event(s)`,
  );
  for (const f of apply.result.files) {
    const phases = [...new Set(apply.events.filter((e) => e.event === "apply.file-progress" && e.data.input === f.input).map((e) => e.data.phase))];
    console.log(`  ${f.status.padEnd(8)} ${f.verified ? "verified" : "        "}  ${f.relative}  [${phases.join(" → ")}]${f.reason ? `  (${f.reason})` : ""}`);
  }
  if (s.failed > 0 || s.conflicts > 0) fail("apply");
}

await request("shutdown");
child.stdin.end();
