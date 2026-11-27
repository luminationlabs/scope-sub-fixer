/** Walk the requested paths and scan every MKV found, with bounded parallelism. */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scanFile, type ScanDeps, type ScanOptions } from "./scanFile.js";
import { silentLogger } from "./log.js";
import type { FileScanResult, ScanRunResult, ScanSummary } from "./types.js";

export function isMkvPath(path: string): boolean {
  return path.toLowerCase().endsWith(".mkv");
}

async function collectFromDirectory(
  dir: string,
  recursive: boolean,
  out: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await collectFromDirectory(full, recursive, out);
    } else if (entry.isFile() && isMkvPath(entry.name)) {
      out.push(full);
    }
  }
}

/** Resolve inputs (files or directories) to a sorted, de-duplicated MKV list. */
export async function collectMkvFiles(
  paths: readonly string[],
  recursive = false,
): Promise<{ files: string[]; missing: string[] }> {
  const files: string[] = [];
  const missing: string[] = [];
  for (const path of paths) {
    const full = resolve(path);
    let info;
    try {
      info = await stat(full);
    } catch {
      missing.push(path);
      continue;
    }
    if (info.isDirectory()) {
      await collectFromDirectory(full, recursive, files);
    } else if (isMkvPath(full)) {
      files.push(full);
    }
    // A non-.mkv file given explicitly is skipped, per PRD §11.8.2.
  }
  return { files: [...new Set(files)].sort(), missing };
}

export function summarize(files: readonly FileScanResult[]): ScanSummary {
  const summary: ScanSummary = {
    scanned: files.length,
    withPgs: 0,
    needFix: 0,
    safe: 0,
    mixedOrAmbiguous: 0,
    errors: 0,
  };
  for (const f of files) {
    if (f.tracks.length > 0) summary.withPgs++;
    switch (f.status) {
      case "NEEDS_FIX":
        summary.needFix++;
        break;
      case "OK":
      case "NO_PGS":
        summary.safe++;
        break;
      case "MIXED_ASPECT_RATIO":
      case "AMBIGUOUS":
        summary.mixedOrAmbiguous++;
        break;
      case "ERROR":
        summary.errors++;
        break;
    }
  }
  return summary;
}

/** Scan every MKV under `paths`. Individual failures never abort the run. */
export async function scanPaths(
  paths: readonly string[],
  options: ScanOptions,
  deps: ScanDeps = {},
): Promise<ScanRunResult> {
  const log = deps.log ?? silentLogger;
  const { files: targets, missing } = await collectMkvFiles(
    paths,
    options.recursive ?? false,
  );
  for (const m of missing) log.error(`path not found: ${m}`);
  log.info(`scanning ${targets.length} file(s)`);

  const jobs = Math.max(1, Math.floor(options.jobs ?? 2));
  const results = new Array<FileScanResult>(targets.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(jobs, targets.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= targets.length) return;
        results[i] = await scanFile(targets[i]!, options, deps);
      }
    },
  );
  await Promise.all(workers);

  const files = results.filter((r): r is FileScanResult => r !== undefined);
  return { files, summary: summarize(files), missingPaths: missing };
}
