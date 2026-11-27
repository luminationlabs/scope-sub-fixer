/**
 * The app's safety policy, as checks on real paths.
 *
 * `serve`'s `apply` writes copies into a folder the user chose, and nothing
 * else. Whether a folder is safe cannot be read off its spelling: a symlink, a
 * differently-cased name on a case-insensitive volume, or a parent of the
 * library with a same-named folder inside it all spell an "outside" path that
 * lands inside. So everything here compares what the paths *are* — the
 * `realpath` of the nearest folder that exists, and the device and inode of
 * every folder on the way up — never how they were typed.
 */
import { realpath, stat, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** `path` with every symlink that exists on the way resolved; the rest kept as spelled. */
export async function realPathOf(path: string): Promise<string> {
  let at = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(at);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(path);
      rest.push(basename(at));
      at = up;
    }
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

async function identityOf(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Remembers what it looked up: one request asks about the same few folders
 * for every title.
 */
class Lookups {
  private real = new Map<string, Promise<string>>();
  private ids = new Map<string, Promise<string | undefined>>();
  realPath(path: string): Promise<string> {
    const key = resolve(path);
    let found = this.real.get(key);
    if (!found) this.real.set(key, (found = realPathOf(key)));
    return found;
  }
  identity(path: string): Promise<string | undefined> {
    const key = resolve(path);
    let found = this.ids.get(key);
    if (!found) this.ids.set(key, (found = identityOf(key)));
    return found;
  }
  /** A file's real path, by its folder's: the file itself may not exist yet. */
  async realFile(path: string): Promise<string> {
    const full = resolve(path);
    return join(await this.realPath(dirname(full)), basename(full));
  }
  /** Whether `path`, or any folder above it that exists, is one of `folders` (by device and inode). */
  async isUnder(path: string, folders: ReadonlySet<string>): Promise<boolean> {
    if (folders.size === 0) return false;
    let at = resolve(path);
    for (;;) {
      const id = await this.identity(at);
      if (id !== undefined && folders.has(id)) return true;
      const up = dirname(at);
      if (up === at) return false;
      at = up;
    }
  }
}

export interface SafetyEntry {
  input: string;
  root?: string;
  relative: string;
}

/**
 * Why `outputRoot` must not be used for the `chosen` plan entries, or null.
 *
 * A copy must never land in the library: not on top of any title (its own or
 * another's), and not anywhere under a folder that was scanned, where the next
 * scan would find the copy and take it for another title. `all` is every entry
 * of the plan — a copy of one title must not land on, or beside, another.
 */
export async function unsafeOutputReason(
  outputRoot: string,
  chosen: readonly SafetyEntry[],
  all: readonly SafetyEntry[] = chosen,
): Promise<string | null> {
  const look = new Lookups();
  const shownRoot = resolve(outputRoot);

  const roots = [...new Set(all.map((e) => e.root).filter((r): r is string => r !== undefined))];
  const realRoots: { root: string; real: string }[] = [];
  const rootIds = new Set<string>();
  for (const root of roots) {
    realRoots.push({ root, real: await look.realPath(root) });
    const id = await look.identity(root);
    if (id !== undefined) rootIds.add(id);
  }
  const realInputs = new Map<string, string>();
  for (const entry of all) realInputs.set(await look.realFile(entry.input), entry.input);

  const insideLibrary = (root: string): string =>
    `the output folder ${shownRoot} is inside the library folder ${root}; ` +
    "choose a folder outside your library";

  // The folder itself first: it is the answer for almost every refusal, and
  // the message can then name the folder rather than one title.
  const realOutputRoot = await look.realPath(shownRoot);
  for (const { root, real } of realRoots) {
    if (within(realOutputRoot, real)) return insideLibrary(root);
  }
  if (await look.isUnder(shownRoot, rootIds)) return insideLibrary(roots[0] ?? shownRoot);

  for (const entry of chosen) {
    const output = join(shownRoot, entry.relative);
    const realOutput = await look.realPath(output);
    const onInput = realInputs.get(realOutput);
    if (onInput !== undefined) {
      return (
        `the output folder ${shownRoot} would write ${entry.relative} over ` +
        `the original ${onInput}; choose a different folder`
      );
    }
    for (const { root, real } of realRoots) {
      if (within(realOutput, real)) {
        return (
          `the output folder ${shownRoot} would put ${entry.relative} inside the library ` +
          `folder ${root}; choose a folder outside your library`
        );
      }
    }
    if (await look.isUnder(dirname(output), rootIds)) {
      return (
        `the output folder ${shownRoot} would put ${entry.relative} inside the library; ` +
        "choose a folder outside your library"
      );
    }
    // Something is already there. `apply` would refuse it as a conflict; when
    // it is one of the originals under another name, say so instead.
    const existing = await look.identity(output);
    if (existing !== undefined) {
      for (const other of all) {
        if ((await look.identity(other.input)) === existing) {
          return (
            `the output folder ${shownRoot} would write ${entry.relative} over ` +
            `the original ${other.input}; choose a different folder`
          );
        }
      }
    }
  }
  return null;
}

/** Whether `dir` is, or is inside, one of the folders in `folders` — by real path and by identity. */
export async function insideAny(dir: string, folders: readonly string[]): Promise<string | null> {
  const look = new Lookups();
  const real = await look.realPath(dir);
  for (const folder of folders) {
    let isDirectory = false;
    try {
      isDirectory = (await stat(folder)).isDirectory();
    } catch {
      // A path that is not there holds nothing.
    }
    if (!isDirectory) continue;
    if (within(real, await look.realPath(folder))) return folder;
    const id = await look.identity(folder);
    if (id !== undefined && (await look.isUnder(dir, new Set([id])))) return folder;
  }
  return null;
}

// --- space ----------------------------------------------------------------

/** Free bytes on the volume `path` is (or will be) on, walking up to a folder that exists. */
export async function freeBytesAt(path: string): Promise<number | undefined> {
  let at = resolve(path);
  for (;;) {
    try {
      const fs = await statfs(at);
      return Number(fs.bsize) * Number(fs.bavail);
    } catch {
      const up = dirname(at);
      if (up === at) return undefined;
      at = up;
    }
  }
}

/** The device `path` is (or will be) on. */
export async function deviceAt(path: string): Promise<string | undefined> {
  let at = resolve(path);
  for (;;) {
    try {
      return String((await stat(at, { bigint: true })).dev);
    } catch {
      const up = dirname(at);
      if (up === at) return undefined;
      at = up;
    }
  }
}

export interface SpaceNeed {
  /** Bytes the copies will take in the output folder. */
  output: number;
  /** Bytes of working room a rebuilt title needs in the temporary folder while it is checked. */
  temp: number;
}

/** A little more than the files themselves: the same margin `apply` asks for per file. */
const HEADROOM = 1.02;

/**
 * What a fix of these titles needs. Every copy is the size of its original
 * (a rebuilt one within a hair of it). Checking a rebuilt title extracts its
 * streams, one file at a time, into the temporary folder: room for the largest
 * such title.
 */
export function spaceNeeded(entries: readonly { size: number; method?: string }[]): SpaceNeed {
  let output = 0;
  let temp = 0;
  for (const e of entries) {
    output += e.size;
    if (e.method === "remux") temp = Math.max(temp, e.size);
  }
  return { output: Math.ceil(output * HEADROOM), temp: Math.ceil(temp * HEADROOM) };
}

function gb(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export interface SpaceFacts {
  outputRoot: string;
  tempDir: string;
  /** Undefined when it could not be measured; then it is not judged. */
  freeOutput: number | undefined;
  freeTemp: number | undefined;
  /** The output folder and the temporary folder are on one volume. */
  sameVolume: boolean;
}

/** Why the fix will not fit, in words for the person at the screen; null when it will. */
export function spaceShortfall(need: SpaceNeed, facts: SpaceFacts): string | null {
  if (facts.sameVolume && need.temp > 0 && facts.freeOutput !== undefined) {
    const total = need.output + need.temp;
    if (facts.freeOutput < total) {
      return (
        `There is not enough free space. The fixed copies need ${gb(need.output)} in ` +
        `${facts.outputRoot}, and rebuilding needs another ${gb(need.temp)} of temporary space in ` +
        `${facts.tempDir} on the same disk: ${gb(total)} in all, and ${gb(facts.freeOutput)} is free. ` +
        "Free up space, choose another folder, or fix fewer titles at a time."
      );
    }
    return null;
  }
  if (facts.freeOutput !== undefined && facts.freeOutput < need.output) {
    return (
      `There is not enough free space in ${facts.outputRoot}: the fixed copies need ` +
      `${gb(need.output)} and ${gb(facts.freeOutput)} is free. ` +
      "Free up space, choose another folder, or fix fewer titles at a time."
    );
  }
  if (need.temp > 0 && facts.freeTemp !== undefined && facts.freeTemp < need.temp) {
    return (
      `There is not enough temporary space to rebuild a title. Rebuilding needs ${gb(need.temp)} ` +
      `free in the temporary folder ${facts.tempDir} while the copy is verified, and ` +
      `${gb(facts.freeTemp)} is free. Free up space on that disk, or leave the titles marked ` +
      '"Rebuild required" unselected.'
    );
  }
  return null;
}
