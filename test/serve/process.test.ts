/**
 * The engine as a process: `scope-sub serve --stdio` started the way the app
 * starts it, for the things only a real pipe shows.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempEnvVars } from "../../src/cli/serve.js";

const main = resolve(__dirname, "..", "..", "src", "cli", "main.ts");

let base: string;
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "scope-sub-proc-")));
});
afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

/** The engines' scratch folders under the base (tsx keeps a cache there too). */
async function engineDirs(): Promise<string[]> {
  return (await readdir(base)).filter((n) => n.startsWith("scope-sub-engine-"));
}

function start() {
  // The runtime the suite is running on: bun runs TypeScript as it is, Node
  // needs tsx to load it (and tsx's loader does not work under bun).
  const loader = process.versions["bun"] === undefined ? ["--import", "tsx"] : [];
  const child = spawn(process.execPath, [...loader, main, "serve", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...Object.fromEntries(tempEnvVars().map((name) => [name, base])) },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  child.stdin.on("error", () => undefined);
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  const saw = async (text: string): Promise<void> => {
    const until = Date.now() + 20000;
    while (!out.includes(text)) {
      if (Date.now() > until) throw new Error(`never saw ${text}; stderr: ${err}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { child, exited, saw, stderr: () => err };
}

describe("the engine process", () => {
  it("keeps its scratch in a folder of its own and removes it on the way out", async () => {
    const e = start();
    await e.saw('"event":"ready"');
    expect(await engineDirs()).toEqual([`scope-sub-engine-${e.child.pid}`]);
    e.child.stdin.end();
    expect(await e.exited).toBe(0);
    expect(await engineDirs()).toEqual([]);
  }, 30000);

  it("does not crash when the client's end of stdout has gone", async () => {
    const e = start();
    await e.saw('"event":"ready"');
    e.child.stdout.destroy();
    // Each of these is answered into a closed pipe.
    for (let i = 1; i <= 20; i++) e.child.stdin.write(`${JSON.stringify({ id: i, method: "hello" })}\n`);
    await new Promise((r) => setTimeout(r, 300));
    e.child.stdin.end();
    expect(await e.exited).toBe(0);
    expect(e.stderr()).not.toMatch(/EPIPE/);
    expect(await engineDirs()).toEqual([]);
  }, 30000);
});
