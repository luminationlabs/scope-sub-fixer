/**
 * `scope-sub plan-show` — read a plan directory back (PRD §17.2).
 *
 * Purely a reader: it opens `plan.json` (and, with `--file`, the patch files)
 * and prints them. Nothing is analyzed and nothing is written, so reviewing a
 * plan is always cheap and always safe.
 */
import { Command } from "commander";
import { basename } from "node:path";
import { summarizePlan, PLAN_STATUS_ORDER } from "../batch/plan.js";
import {
  PlanFileError,
  readPatchFile,
  requirePlan,
  type PlanFile,
  type PlanFileEntry,
} from "../batch/planFile.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import { ArgumentError, EXIT, type CliIo } from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export type PlanShowFilter = "fix" | "skip" | "all";

export interface RawPlanShowOptions {
  format?: string;
  only?: string;
  file?: string;
  /** Moves listed per track in the per-file view. */
  maxMoves?: string;
}

export function parseOnly(value: string | undefined): PlanShowFilter {
  const v = (value ?? "all").trim().toLowerCase();
  if (v === "fix" || v === "skip" || v === "all") return v;
  throw new ArgumentError(`invalid --only "${value}" (expected fix, skip or all)`);
}

export function selectEntries(
  plan: PlanFile,
  only: PlanShowFilter,
  fileSubstring: string | undefined,
): PlanFileEntry[] {
  const needle = fileSubstring?.toLowerCase();
  return plan.files.filter((entry) => {
    if (only !== "all" && entry.action !== only) return false;
    if (needle !== undefined && !entry.input.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** The one-line-per-file table. */
export function formatPlanTable(entries: readonly PlanFileEntry[]): string[] {
  if (entries.length === 0) return ["(no matching entries)"];
  const header = ["FILE", "STATUS", "ACTION", "TRK", "EVENTS", "FIELDS", "BYTES", "REASON"];
  const rows = entries.map((e) => [
    basename(e.input),
    e.status,
    e.action,
    String(e.patch_summary?.tracks ?? 0),
    String(e.patch_summary?.events_moved ?? 0),
    String(e.patch_summary?.position_fields ?? 0),
    String(e.patch_summary?.bytes_changed ?? 0),
    e.reason ?? "",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  // The trailing reason column is free-form; do not pad it.
  const line = (cells: string[]): string =>
    cells
      .map((c, i) =>
        i >= 3 && i <= 6 ? padLeft(c, widths[i]!) : i === cells.length - 1 ? c : pad(c, widths[i]!),
      )
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

function formatTrackLines(entry: PlanFileEntry): string[] {
  const lines: string[] = [];
  for (const t of entry.tracks) {
    lines.push(
      `    track ${t.mkvmerge_id} (matroska ${t.matroska_number}, ${t.language}` +
        `${t.name ? `, "${t.name}"` : ""}${t.forced ? ", forced" : ""}): ${t.status} → ${t.action}` +
        (t.event_count === undefined
          ? ` — events not read${t.reason ? `; ${t.reason}` : " (no letterbox bars)"}`
          : ` — ${t.offending_event_count} offending of ${t.event_count} event(s)` +
            (t.reason ? `; ${t.reason}` : "")),
    );
  }
  return lines;
}

export interface PlanShowDetailOptions {
  maxMoves?: number;
}

/** The per-file view, including the first few planned moves per track. */
export async function formatPlanDetail(
  dir: string,
  entry: PlanFileEntry,
  options: PlanShowDetailOptions = {},
): Promise<string[]> {
  const maxMoves = options.maxMoves ?? 5;
  const lines: string[] = [];
  lines.push(entry.input);
  lines.push(`  status: ${entry.status} → ${entry.action}${entry.reason ? ` (${entry.reason})` : ""}`);
  lines.push(
    `  size: ${entry.size} bytes, mtime ${new Date(entry.mtimeMs).toISOString()}`,
  );
  lines.push(`  output name: ${entry.relative}`);
  if (entry.video) lines.push(`  video: ${entry.video.w}x${entry.video.h}`);
  if (entry.active_area) {
    const a = entry.active_area;
    lines.push(
      `  active area: y=${a.top}..${a.bottom} (${a.aspect}:1, ${a.source}, ${a.classification})`,
    );
  }
  if (entry.compressed) lines.push("  note: a PGS track is Matroska-compressed");
  for (const note of entry.notes ?? []) lines.push(`  note: ${note}`);
  lines.push("  tracks:");
  lines.push(...formatTrackLines(entry));

  if (entry.patchFile !== undefined) {
    const patch = await readPatchFile(dir, entry.patchFile);
    lines.push(`  patch file: ${entry.patchFile} (${patch.patches.length} byte edit(s))`);
    for (const t of patch.tracks) {
      lines.push(
        `    track ${t.mkvmerge_id}: ${t.events_moved} event(s) across ` +
          `${t.display_sets_patched} display set(s), ${t.position_fields} position field(s), ` +
          `${t.bytes_changed} byte(s) changed`,
      );
      lines.push(
        `      canvas ${t.canvas.width}x${t.canvas.height}, active y=` +
          `${t.active_on_canvas.top}..${t.active_on_canvas.bottom}, margin ${t.margin} px` +
          (t.expected_offending_after > 0
            ? `, ${t.expected_offending_after} event(s) will remain outside`
            : ""),
      );
      for (const move of t.moves.slice(0, maxMoves)) {
        lines.push(
          `      ${move.pts_ms} ms  object ${move.object_id} (window ${move.window_id})` +
            `  dx=${move.dx} dy=${move.dy}${move.for_consistency ? " (with its window)" : ""}`,
        );
      }
      if (t.moves.length > maxMoves) {
        lines.push(`      ... and ${t.moves.length - maxMoves} more move(s)`);
      }
      for (const skip of t.skipped ?? []) lines.push(`      policy skip: ${skip}`);
    }
  }
  return lines;
}

export async function runPlanShow(
  dir: string,
  raw: RawPlanShowOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let only: PlanShowFilter;
  let format: "human" | "json";
  let maxMoves: number;
  try {
    only = parseOnly(raw.only);
    format = (raw.format ?? "human") as "human" | "json";
    if (format !== "human" && format !== "json") {
      throw new ArgumentError(`invalid --format "${raw.format}" (expected human or json)`);
    }
    maxMoves = raw.maxMoves === undefined ? 5 : Number(raw.maxMoves);
    if (!Number.isInteger(maxMoves) || maxMoves < 0) {
      throw new ArgumentError(`invalid --max-moves "${raw.maxMoves}"`);
    }
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.BAD_ARGS;
  }

  let plan: PlanFile;
  try {
    plan = await requirePlan(dir);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.BAD_ARGS;
  }

  const entries = selectEntries(plan, only, raw.file);
  const summary = summarizePlan(entries);

  if (format === "json") {
    io.stdout(
      `${JSON.stringify(
        {
          tool: TOOL_NAME,
          version: TOOL_VERSION,
          command: "plan-show",
          dir,
          options: plan.options,
          created: plan.created,
          updated: plan.updated,
          summary,
          files: entries,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  const lines: string[] = [];
  lines.push(
    `plan ${dir} (${plan.tool.name} ${plan.tool.version}, created ${plan.created}, updated ${plan.updated})`,
  );
  lines.push(
    `options: aspect ${String(plan.options.aspect)}, method ${plan.options.method}` +
      (plan.options.margin === undefined ? "" : `, margin ${plan.options.margin} px`) +
      (plan.options.recursive ? ", recursive" : ""),
  );
  lines.push("");

  try {
    if (raw.file !== undefined) {
      for (const entry of entries) {
        lines.push(...(await formatPlanDetail(dir, entry, { maxMoves })));
        lines.push("");
      }
      if (entries.length === 0) lines.push(`no plan entry matches "${raw.file}"`);
    } else {
      lines.push(...formatPlanTable(entries));
    }
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof PlanFileError ? EXIT.BAD_ARGS : EXIT.UNSUPPORTED_MEDIA;
  }

  lines.push("");
  lines.push(`files: ${summary.files}  to fix: ${summary.fix}  skipped: ${summary.skip}`);
  for (const status of PLAN_STATUS_ORDER) {
    const n = summary.byStatus[status] ?? 0;
    if (n > 0) lines.push(`  ${status}: ${n}`);
  }
  lines.push(
    `planned fixes: ${summary.fix} file(s), ${summary.tracks} track(s), ` +
      `${summary.eventsMoved} event(s), ${summary.positionFields} position field(s), ` +
      `${summary.bytesChanged} byte(s)`,
  );

  io.stdout(`${lines.join("\n")}\n`);
  return EXIT.OK;
}

/** Attach the `plan-show` subcommand to a commander program. */
export function registerPlanShowCommand(
  program: Command,
  io: CliIo = defaultIo,
): Command {
  return program
    .command("plan-show")
    .description("print a plan directory: what would be fixed, what would be skipped, and why")
    .argument("<dir>", "the plan directory written by `plan`")
    .option("--only <fix|skip|all>", "list only files with this action", "all")
    .option("--file <substring>", "show full per-track detail for matching files")
    .option("--max-moves <n>", "moves listed per track in the per-file view", "5")
    .option("--format <human|json>", "report format", "human")
    .action(async (dir: string, options: RawPlanShowOptions) => {
      process.exitCode = await runPlanShow(dir, options, io);
    });
}
