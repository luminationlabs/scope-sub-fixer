/** Human-readable scan report, in the shape of PRD §11.4 / §11.5. */
import type { Overflow } from "../geometry/rect.js";
import type {
  FileScanResult,
  ScanEventReport,
  ScanRunResult,
  ScanSummary,
  TrackScanResult,
} from "../scan/types.js";
import { formatCount, formatRect, formatTimestamp, padLeft } from "./format.js";

export interface HumanReportOptions {
  /** Print individual offending events. */
  showEvents?: boolean;
  /** How many events to print per track when `showEvents`. Default 10. */
  maxEvents?: number;
}

function overflowText(o: Overflow): string {
  const parts: string[] = [];
  if (o.top > 0) parts.push(`top ${o.top} px`);
  if (o.bottom > 0) parts.push(`bottom ${o.bottom} px`);
  if (o.left > 0) parts.push(`left ${o.left} px`);
  if (o.right > 0) parts.push(`right ${o.right} px`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function trackLabel(track: TrackScanResult): string {
  const bits = [
    `PGS track ${track.trackId} (matroska track number ${track.trackNumber})`,
    track.language,
  ];
  if (track.name) bits.push(`"${track.name}"`);
  const flags: string[] = [];
  if (track.default) flags.push("default");
  if (track.forced) flags.push("forced");
  if (track.hearingImpaired) flags.push("hearing-impaired");
  if (flags.length > 0) bits.push(`[${flags.join(", ")}]`);
  return bits.join("  ");
}

function formatEvent(event: ScanEventReport, indent: string): string[] {
  const lines: string[] = [];
  lines.push(
    `${indent}${formatTimestamp(event.ptsMs)}  composition ${event.compositionNumber}` +
      (event.forced ? "  [forced]" : ""),
  );
  for (const o of event.objects) {
    const head = event.objects.length > 1 ? `object ${o.objectId}: ` : "";
    lines.push(`${indent}  ${head}original: ${formatRect(o.objectRect)}`);
    if (o.visibleRect) {
      lines.push(`${indent}  ${head.replace(/./g, " ")}visible:  ${formatRect(o.visibleRect)}`);
    } else {
      lines.push(`${indent}  ${head.replace(/./g, " ")}visible:  none (fully transparent)`);
    }
    lines.push(`${indent}  ${head.replace(/./g, " ")}overflow: ${overflowText(o.overflow)}`);
    if (o.proposedDelta) {
      const suffix = o.movedForConsistency ? " (window consistency)" : "";
      lines.push(
        `${indent}  ${head.replace(/./g, " ")}proposed: dx=${o.proposedDelta.dx} dy=${o.proposedDelta.dy}` +
          ` (y ${o.objectRect.y} -> ${o.objectRect.y + o.proposedDelta.dy})${suffix}`,
      );
    }
    for (const note of o.notes) {
      lines.push(`${indent}  ${head.replace(/./g, " ")}note: ${note}`);
    }
  }
  if (!event.proposedDelta) {
    for (const reason of event.reasons) lines.push(`${indent}  not moved: ${reason}`);
  }
  for (const note of event.notes) lines.push(`${indent}  note: ${note}`);
  return lines;
}

export function formatTrack(
  track: TrackScanResult,
  options: HumanReportOptions,
): string[] {
  const lines: string[] = [];
  lines.push(`  ${trackLabel(track)}`);
  lines.push(`    Status: ${track.status}`);
  if (track.error) {
    lines.push(`    Error: ${track.error}`);
    return lines;
  }
  if (track.eventCount === undefined) {
    lines.push("    events: not read (nothing can be outside a full-frame active area)");
  } else if (track.offendingEventCount > 0) {
    lines.push(
      `    ${formatCount(track.offendingEventCount)} offending events of ${formatCount(track.eventCount)}`,
    );
  } else {
    lines.push(`    ${formatCount(track.eventCount)} events`);
  }
  if (track.ambiguousEventCount > 0) {
    lines.push(`    ${formatCount(track.ambiguousEventCount)} ambiguous events`);
  }
  if (track.touchingBoundaryEventCount > 0) {
    lines.push(
      `    ${formatCount(track.touchingBoundaryEventCount)} events inside the active area but within ${track.margin} px of an edge (not an error; not moved)`,
    );
  }
  for (const note of track.notes) lines.push(`    note: ${note}`);

  if (options.showEvents) {
    const max = options.maxEvents ?? 10;
    const shown = track.events.slice(0, max);
    for (const event of shown) {
      lines.push("");
      lines.push(...formatEvent(event, "    "));
    }
    if (track.events.length > shown.length) {
      lines.push("");
      lines.push(
        `    ... ${formatCount(track.events.length - shown.length)} more (use --max-events)`,
      );
    }
  }
  return lines;
}

export function formatFile(
  file: FileScanResult,
  options: HumanReportOptions = {},
): string[] {
  const lines: string[] = [file.file];
  if (file.video) {
    lines.push(`  Video: ${file.video.width}x${file.video.height}`);
  } else {
    lines.push("  Video: unknown");
  }
  const active = file.activeArea;
  if (active) {
    const how =
      active.source === "manual"
        ? "manual aspect"
        : `auto, ${active.samples?.filter((s) => s.used).length ?? 0}/${active.samples?.length ?? 0} usable samples`;
    lines.push(
      `  Active area: y=${active.top}..${active.bottom} (${active.aspect}:1, ${how}, ${active.classification})`,
    );
    for (const note of active.notes) lines.push(`    note: ${note}`);
  }
  lines.push(`  Status: ${file.status}`);
  if (file.error) lines.push(`  Error: ${file.error}`);
  for (const note of file.notes) lines.push(`  note: ${note}`);
  for (const track of file.tracks) {
    lines.push("");
    lines.push(...formatTrack(track, options));
  }
  return lines;
}

export function formatSummary(summary: ScanSummary): string[] {
  const rows: [string, number][] = [
    ["Scanned:", summary.scanned],
    ["With PGS:", summary.withPgs],
    ["Need fixing:", summary.needFix],
    ["No changes needed:", summary.safe],
    ["Mixed/ambiguous:", summary.mixedOrAmbiguous],
    ["Errors:", summary.errors],
  ];
  const labelWidth = Math.max(...rows.map((r) => r[0].length));
  const valueWidth = Math.max(...rows.map((r) => formatCount(r[1]).length));
  return rows.map(
    ([label, value]) =>
      `${label.padEnd(labelWidth)} ${padLeft(formatCount(value), valueWidth + 2)}`,
  );
}

export function formatHumanReport(
  run: ScanRunResult,
  options: HumanReportOptions = {},
): string {
  const lines: string[] = [];
  for (const path of run.missingPaths) lines.push(`path not found: ${path}`);
  for (const file of run.files) {
    if (lines.length > 0) lines.push("");
    lines.push(...formatFile(file, options));
  }
  if (run.files.length === 0 && run.missingPaths.length === 0) {
    lines.push("No .mkv files found.");
  }
  lines.push("");
  lines.push(...formatSummary(run.summary));
  return lines.join("\n") + "\n";
}
