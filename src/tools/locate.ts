/**
 * The one place that decides which `mkvmerge`, `mkvextract` or `ffmpeg` binary
 * a spawn actually uses.
 *
 * The tool is meant to be dropped onto a NAS-adjacent box where MKVToolNix may
 * well be installed somewhere a login shell knows about but a service manager's
 * `PATH` does not, so the search does not stop at `PATH`: it also looks in the
 * handful of places these two are actually installed, and honours two
 * environment overrides for everything else.
 *
 * Search order, first hit wins:
 *   1. `SCOPE_SUB_MKVTOOLNIX_DIR` (a directory) for mkvmerge/mkvextract,
 *      `SCOPE_SUB_FFMPEG` (a full path to the binary) for ffmpeg;
 *   2. every entry of `PATH`, in order;
 *   3. `EXTRA_TOOL_DIRS` below (`windowsToolDirs` on Windows).
 *
 * `toolPath()` falls back to the bare name when nothing is found, so a lookup
 * failure degrades to exactly the pre-existing behaviour: `spawn` tries `PATH`
 * itself and `spawnCapture` maps the ENOENT onto `DependencyMissingError`.
 */
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** The external programs this tool shells out to. */
export const TOOL_NAMES = ["mkvmerge", "mkvextract", "ffmpeg"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** Places MKVToolNix and ffmpeg land that a non-login `PATH` often misses. */
export const EXTRA_TOOL_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/opt/local/bin",
  "/snap/bin",
  "/Applications/MKVToolNix.app/Contents/MacOS",
];

/**
 * The same list for Windows, built from the environment because every one of
 * them hangs off a per-machine or per-user folder: the MKVToolNix installer
 * (all users, 32-bit, per user), a hand-unpacked FFmpeg, and the shims WinGet,
 * Chocolatey and Scoop put on their own `PATH` entry. A variable that is not
 * set contributes nothing.
 */
export function windowsToolDirs(env: ToolEnv): string[] {
  const under = (name: string, ...rest: string[]): string[] => {
    const base = envValue(env, name, "win32");
    return base ? [win32.join(base, ...rest)] : [];
  };
  return [
    ...under("ProgramFiles", "MKVToolNix"),
    ...under("ProgramFiles(x86)", "MKVToolNix"),
    ...under("LOCALAPPDATA", "Programs", "MKVToolNix"),
    ...under("ProgramFiles", "ffmpeg", "bin"),
    ...under("LOCALAPPDATA", "Microsoft", "WinGet", "Links"),
    ...under("ProgramData", "chocolatey", "bin"),
    ...under("USERPROFILE", "scoop", "shims"),
  ];
}

/** The extra directories searched after `PATH` on a platform. */
export function extraToolDirs(env: ToolEnv, platform: string = process.platform): readonly string[] {
  return platform === "win32" ? windowsToolDirs(env) : EXTRA_TOOL_DIRS;
}

/** Environment override consulted for each tool. */
export const TOOL_ENV_VARS = {
  mkvmerge: "SCOPE_SUB_MKVTOOLNIX_DIR",
  mkvextract: "SCOPE_SUB_MKVTOOLNIX_DIR",
  ffmpeg: "SCOPE_SUB_FFMPEG",
} as const satisfies Record<ToolName, string>;

/** Where a resolved binary was found. */
export type ToolOrigin = "env" | "path" | "extra";

export interface LocatedTool {
  tool: ToolName;
  path: string;
  origin: ToolOrigin;
}

export type ToolEnv = Record<string, string | undefined>;

/**
 * One variable. Windows names are case-insensitive (`Path`, `PATH`), and
 * `process.env` there honours that, but a plain copy of it does not — so on
 * win32 the first key that matches without regard to case is taken.
 */
export function envValue(env: ToolEnv, name: string, platform: string = process.platform): string | undefined {
  if (platform !== "win32" || env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/** What the lookup asks of the file system. Injectable so other platforms can be tested here. */
export interface ToolProbe {
  /** A regular file this process may execute. */
  isExecutableFile(candidate: string): boolean;
  isDirectory(candidate: string): boolean;
}

/**
 * `X_OK` is honoured on POSIX; on Windows Node treats it as `F_OK`, so there
 * this is "a regular file exists", which is what the `.exe` name stands for.
 */
export const fsProbe: ToolProbe = {
  isExecutableFile(candidate) {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory(candidate) {
    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * The extensions a spawned program may have on Windows, in `PATHEXT` order.
 * Only `.com` and `.exe`: Node refuses to spawn a `.bat` or `.cmd` without a
 * shell (EINVAL), and every spawn here is shell-free. `.exe` when `PATHEXT`
 * names neither.
 */
function windowsExtensions(env: ToolEnv): string[] {
  const listed = (envValue(env, "PATHEXT", "win32") ?? "")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e === ".exe" || e === ".com");
  return listed.length > 0 ? [...new Set(listed)] : [".exe"];
}

/**
 * The file names a tool goes by in a directory: on Windows only the names with
 * an extension Node can spawn (`mkvmerge.exe`; the extension-less file Scoop
 * puts beside its shim is a shell script, not a program).
 */
export function executableNames(
  tool: ToolName,
  platform: string = process.platform,
  env: ToolEnv = {},
): string[] {
  return platform === "win32" ? windowsExtensions(env).map((ext) => `${tool}${ext}`) : [tool];
}

function pathFor(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Windows users paste paths in quotes; the quotes are not part of the name. */
function unquote(value: string, platform: string): string {
  return platform === "win32" && value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).trim()
    : value;
}

/**
 * `SCOPE_SUB_MKVTOOLNIX_DIR` names a directory; `SCOPE_SUB_FFMPEG` a binary.
 * The candidates the override stands for, in the order to try them.
 */
function fromEnvOverride(tool: ToolName, env: ToolEnv, platform: string, probe: ToolProbe): string[] {
  const value = envValue(env, TOOL_ENV_VARS[tool], platform)?.trim();
  if (!value) return [];
  const raw = unquote(value, platform);
  if (!raw) return [];
  const path = pathFor(platform);
  const inDir = executableNames(tool, platform, env).map((name) => path.join(raw, name));
  if (tool === "ffmpeg") {
    // A directory here is a common enough mistake to just accept.
    if (probe.isDirectory(raw)) return inDir;
    // `C:\ffmpeg\bin\ffmpeg` means `ffmpeg.exe` to anyone used to a shell.
    if (platform === "win32" && path.extname(raw) === "") {
      return [raw, ...windowsExtensions(env).map((ext) => `${raw}${ext}`)];
    }
    return [raw];
  }
  return inDir;
}

/**
 * Find one tool. Returns `undefined` when no executable file turns up, which
 * callers treat as "let `spawn` try `PATH` and report the ENOENT".
 *
 * A pure function of `env` and `platform` apart from `probe`, so the Windows
 * search can be tested on any machine with a fake file system.
 */
export function locateTool(
  tool: ToolName,
  env: ToolEnv = process.env,
  extraDirs?: readonly string[],
  platform: string = process.platform,
  probe: ToolProbe = fsProbe,
): LocatedTool | undefined {
  for (const override of fromEnvOverride(tool, env, platform, probe)) {
    if (probe.isExecutableFile(override)) return { tool, path: override, origin: "env" };
  }

  const path = pathFor(platform);
  const names = executableNames(tool, platform, env);
  const delimiter = platform === "win32" ? ";" : ":";
  const pathDirs = (envValue(env, "PATH", platform) ?? "")
    .split(delimiter)
    .map((d) => unquote(d, platform))
    .filter((d) => d.length > 0);
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (probe.isExecutableFile(candidate)) {
        return { tool, path: candidate, origin: "path" };
      }
    }
  }

  // Windows folder names are case-insensitive, and a trailing separator is common there.
  const key = (dir: string): string =>
    platform === "win32" ? win32.normalize(dir).replace(/\\+$/, "").toLowerCase() : dir;
  const searched = new Set(pathDirs.map(key));
  for (const dir of extraDirs ?? extraToolDirs(env, platform)) {
    if (searched.has(key(dir))) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (probe.isExecutableFile(candidate)) {
        return { tool, path: candidate, origin: "extra" };
      }
    }
  }

  return undefined;
}

/**
 * Cached per process, since a single `plan`/`apply` run spawns these hundreds
 * of times and the answer cannot change underneath it. Only lookups against
 * the real environment are cached; tests pass their own `env` and bypass it.
 */
const cache = new Map<ToolName, LocatedTool | undefined>();

/** Drop the cache. Only tests need this. */
export function clearToolCache(): void {
  cache.clear();
}

/** `locateTool`, memoized when run against `process.env`. */
export function locateToolCached(
  tool: ToolName,
  env: ToolEnv = process.env,
): LocatedTool | undefined {
  if (env !== process.env) return locateTool(tool, env);
  if (cache.has(tool)) return cache.get(tool);
  const found = locateTool(tool, env);
  cache.set(tool, found);
  return found;
}

/**
 * The executable to hand `spawn`: an absolute path when one was found, else
 * the bare tool name so `PATH` resolution (and its ENOENT) still happens.
 */
export function toolPath(tool: ToolName, env: ToolEnv = process.env): string {
  return locateToolCached(tool, env)?.path ?? tool;
}


/**
 * Windows PowerShell, which every Windows 10 and 11 ships in the same place.
 * Used for one system query (`src/mkv/ebml.ts`, which drive letters are mapped
 * network drives), never to run anything of the user's. The full path, so a
 * `powershell.exe` earlier on `PATH` is not the one that runs.
 */
export function windowsPowerShellPath(env: ToolEnv = process.env): string {
  const root = envValue(env, "SystemRoot", "win32") ?? envValue(env, "windir", "win32");
  return root
    ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}
