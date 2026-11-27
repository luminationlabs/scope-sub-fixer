import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  envValue,
  executableNames,
  EXTRA_TOOL_DIRS,
  extraToolDirs,
  isToolName,
  locateTool,
  TOOL_ENV_VARS,
  TOOL_NAMES,
  toolPath,
  windowsToolDirs,
  type ToolEnv,
  type ToolName,
  type ToolProbe,
} from "../../src/tools/locate.js";

/** A directory holding executable stubs with the given names. */
async function stubDir(names: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scope-sub-locate-"));
  for (const name of names) {
    const file = join(dir, name);
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    await chmod(file, 0o755);
  }
  return dir;
}

/** An env with nothing on PATH unless a directory is given. */
function env(pathDirs: string[] = [], extra: ToolEnv = {}): ToolEnv {
  return { PATH: pathDirs.join(delimiter), ...extra };
}

// These stub real files named the POSIX way and rely on the execute bit, which
// Windows does not have; the Windows search is covered with a fake file system below.
describe.skipIf(process.platform === "win32")("locateTool", () => {
  it("finds a tool on PATH and reports where it came from", async () => {
    const dir = await stubDir(["mkvmerge"]);
    const found = locateTool("mkvmerge", env([dir]));
    expect(found).toEqual({ tool: "mkvmerge", path: join(dir, "mkvmerge"), origin: "path" });
  });

  it("returns undefined when the tool is in none of the searched places", () => {
    expect(locateTool("mkvmerge", env(["/nonexistent-scope-sub"]), [])).toBeUndefined();
  });

  it("takes the first PATH entry that has the tool", async () => {
    const first = await stubDir(["ffmpeg"]);
    const second = await stubDir(["ffmpeg"]);
    expect(locateTool("ffmpeg", env([first, second]))?.path).toBe(join(first, "ffmpeg"));
  });

  it("skips a PATH entry whose file is not executable", async () => {
    const notExec = await mkdtemp(join(tmpdir(), "scope-sub-locate-"));
    await writeFile(join(notExec, "mkvextract"), "not executable");
    const good = await stubDir(["mkvextract"]);
    expect(locateTool("mkvextract", env([notExec, good]))?.path).toBe(
      join(good, "mkvextract"),
    );
  });

  it("skips a directory that shadows the tool name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-sub-locate-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "ffmpeg"));
    const good = await stubDir(["ffmpeg"]);
    expect(locateTool("ffmpeg", env([dir, good]))?.path).toBe(join(good, "ffmpeg"));
  });

  it("prefers SCOPE_SUB_MKVTOOLNIX_DIR over PATH", async () => {
    const onPath = await stubDir(["mkvmerge", "mkvextract"]);
    const override = await stubDir(["mkvmerge", "mkvextract"]);
    for (const tool of ["mkvmerge", "mkvextract"] as const) {
      const found = locateTool(
        tool,
        env([onPath], { [TOOL_ENV_VARS[tool]]: override }),
      );
      expect(found).toEqual({ tool, path: join(override, tool), origin: "env" });
    }
  });

  it("takes SCOPE_SUB_FFMPEG as a full path, or as a directory", async () => {
    const dir = await stubDir(["ffmpeg"]);
    const asFile = locateTool("ffmpeg", env([], { SCOPE_SUB_FFMPEG: join(dir, "ffmpeg") }));
    expect(asFile).toEqual({ tool: "ffmpeg", path: join(dir, "ffmpeg"), origin: "env" });
    const asDir = locateTool("ffmpeg", env([], { SCOPE_SUB_FFMPEG: dir }));
    expect(asDir?.path).toBe(join(dir, "ffmpeg"));
  });

  it("ignores an override that points at nothing and falls back to PATH", async () => {
    const onPath = await stubDir(["mkvmerge"]);
    const found = locateTool(
      "mkvmerge",
      env([onPath], { SCOPE_SUB_MKVTOOLNIX_DIR: "/nonexistent-scope-sub" }),
    );
    expect(found?.path).toBe(join(onPath, "mkvmerge"));
  });

  it("searches the extra directories when PATH misses", async () => {
    const extra = await stubDir(["mkvmerge"]);
    const found = locateTool("mkvmerge", env(["/nonexistent-scope-sub"]), [extra]);
    expect(found).toEqual({ tool: "mkvmerge", path: join(extra, "mkvmerge"), origin: "extra" });
  });

  it("prefers PATH over the extra directories", async () => {
    const onPath = await stubDir(["ffmpeg"]);
    const extra = await stubDir(["ffmpeg"]);
    expect(locateTool("ffmpeg", env([onPath]), [extra])?.origin).toBe("path");
  });

  it("lists the documented extra directories", () => {
    expect(EXTRA_TOOL_DIRS).toContain("/opt/homebrew/bin");
    expect(EXTRA_TOOL_DIRS).toContain("/usr/local/bin");
    expect(EXTRA_TOOL_DIRS).toContain("/usr/bin");
    expect(EXTRA_TOOL_DIRS).toContain("/Applications/MKVToolNix.app/Contents/MacOS");
  });
});

describe("on Windows", () => {
  // Run here with a fake file system: Windows paths are only strings to this test.
  function fakeFs(files: string[], dirs: string[] = []): ToolProbe {
    const lower = (p: string) => p.toLowerCase();
    const f = new Set(files.map(lower));
    const d = new Set(dirs.map(lower));
    return {
      isExecutableFile: (p) => f.has(lower(p)),
      isDirectory: (p) => d.has(lower(p)),
    };
  }
  const winEnv: ToolEnv = {
    Path: "C:\\Windows\\system32;C:\\Windows",
    PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\Ann Lee\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    USERPROFILE: "C:\\Users\\Ann Lee",
  };
  const locate = (tool: ToolName, env: ToolEnv, probe: ToolProbe) =>
    locateTool(tool, env, undefined, "win32", probe);

  it("knows the tools by the names Node can spawn there", () => {
    expect(executableNames("ffmpeg", "win32")).toEqual(["ffmpeg.exe"]);
    expect(executableNames("ffmpeg", "win32", { PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toEqual([
      "ffmpeg.com",
      "ffmpeg.exe",
    ]);
    // A .cmd shim cannot be spawned without a shell, so it is never a candidate.
    expect(executableNames("ffmpeg", "win32", { PATHEXT: ".BAT;.CMD" })).toEqual(["ffmpeg.exe"]);
    expect(executableNames("ffmpeg", "darwin")).toEqual(["ffmpeg"]);
    expect(executableNames("mkvmerge", "linux")).toEqual(["mkvmerge"]);
  });

  it("reads Path whatever its case, split on semicolons", () => {
    const fs = fakeFs(["D:\\Tools\\bin\\mkvmerge.exe"]);
    const env = { ...winEnv, Path: 'C:\\Windows;"D:\\Tools\\bin"' };
    expect(locate("mkvmerge", env, fs)).toEqual({
      tool: "mkvmerge",
      path: "D:\\Tools\\bin\\mkvmerge.exe",
      origin: "path",
    });
    expect(envValue({ pAtH: "x" }, "PATH", "win32")).toBe("x");
    expect(envValue({ pAtH: "x" }, "PATH", "darwin")).toBeUndefined();
  });

  it("searches the MKVToolNix installer's folders", () => {
    for (const dir of [
      "C:\\Program Files\\MKVToolNix",
      "C:\\Program Files (x86)\\MKVToolNix",
      "C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\MKVToolNix",
    ]) {
      const found = locate("mkvextract", winEnv, fakeFs([`${dir}\\mkvextract.exe`]));
      expect(found).toEqual({ tool: "mkvextract", path: `${dir}\\mkvextract.exe`, origin: "extra" });
    }
  });

  it("searches where FFmpeg is usually put or shimmed", () => {
    for (const dir of [
      "C:\\Program Files\\ffmpeg\\bin",
      "C:\\Users\\Ann Lee\\AppData\\Local\\Microsoft\\WinGet\\Links",
      "C:\\ProgramData\\chocolatey\\bin",
      "C:\\Users\\Ann Lee\\scoop\\shims",
    ]) {
      expect(locate("ffmpeg", winEnv, fakeFs([`${dir}\\ffmpeg.exe`]))?.path).toBe(`${dir}\\ffmpeg.exe`);
    }
    // The extension-less file Scoop writes beside its shim is a shell script.
    expect(locate("ffmpeg", winEnv, fakeFs(["C:\\Users\\Ann Lee\\scoop\\shims\\ffmpeg"]))).toBeUndefined();
  });

  it("builds the extra folders from the environment, skipping what is unset", () => {
    expect(windowsToolDirs({ programfiles: "E:\\Apps" })).toEqual([
      "E:\\Apps\\MKVToolNix",
      "E:\\Apps\\ffmpeg\\bin",
    ]);
    expect(extraToolDirs({}, "darwin")).toBe(EXTRA_TOOL_DIRS);
  });

  it("does not search an extra folder twice when PATH already has it in another case", () => {
    let probes = 0;
    const probe: ToolProbe = {
      isExecutableFile: () => {
        probes += 1;
        return false;
      },
      isDirectory: () => false,
    };
    locateTool("mkvmerge", { Path: "c:\\program files\\mkvtoolnix\\" }, ["C:\\Program Files\\MKVToolNix"], "win32", probe);
    expect(probes).toBe(1);
  });

  it("takes SCOPE_SUB_MKVTOOLNIX_DIR with backslashes, spaces and quotes", () => {
    const dir = "C:\\My Tools\\MKVToolNix";
    const fs = fakeFs([`${dir}\\mkvmerge.exe`, "C:\\Program Files\\MKVToolNix\\mkvmerge.exe"]);
    for (const value of [dir, `${dir}\\`, `"${dir}"`]) {
      expect(locate("mkvmerge", { ...winEnv, SCOPE_SUB_MKVTOOLNIX_DIR: value }, fs)).toEqual({
        tool: "mkvmerge",
        path: `${dir}\\mkvmerge.exe`,
        origin: "env",
      });
    }
  });

  it("takes SCOPE_SUB_FFMPEG as the .exe, without .exe, or as its folder", () => {
    const dir = "C:\\Program Files\\FFmpeg Build\\bin";
    const exe = `${dir}\\ffmpeg.exe`;
    const fs = fakeFs([exe], [dir]);
    for (const value of [exe, `${dir}\\ffmpeg`, dir, `"${exe}"`]) {
      expect(locate("ffmpeg", { ...winEnv, SCOPE_SUB_FFMPEG: value }, fs)).toEqual({
        tool: "ffmpeg",
        path: exe,
        origin: "env",
      });
    }
    // An override that holds nothing falls back to the search, as elsewhere.
    expect(locate("ffmpeg", { ...winEnv, SCOPE_SUB_FFMPEG: "C:\\nowhere\\ffmpeg.exe" }, fs)).toBeUndefined();
  });
});

describe("toolPath", () => {
  it.skipIf(process.platform === "win32")("gives an absolute path when the tool is found", async () => {
    const dir = await stubDir(["mkvmerge"]);
    expect(toolPath("mkvmerge", env([dir]))).toBe(join(dir, "mkvmerge"));
  });

  it("falls back to the bare name so spawn still reports ENOENT", () => {
    expect(toolPath("mkvmerge", { PATH: "/nonexistent-scope-sub" })).toMatch(
      /(^|\/)mkvmerge$/,
    );
  });
});

describe("isToolName", () => {
  it("accepts exactly the three tools", () => {
    for (const name of TOOL_NAMES) expect(isToolName(name)).toBe(true);
    expect(isToolName("ffprobe")).toBe(false);
  });
});
