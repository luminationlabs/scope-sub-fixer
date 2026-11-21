/**
 * Container-level facts straight out of `mkvmerge -J`.
 *
 * `inspectMkv` models only what the analyzer needs; verification also has to
 * account for chapters, attachments and tags (PRD §13, §15), so this module
 * reads the raw JSON once and normalizes the parts that must survive a repair.
 */
import { MkvInspectError, spawnCapture } from "../mkv/inspect.js";
import { toolPath } from "../tools/locate.js";

export interface ContainerAttachment {
  id: number;
  fileName: string;
  size: number;
  contentType: string;
  description: string | undefined;
}

export interface ContainerTrack {
  id: number;
  number: number;
  type: string;
  codecId: string;
  language: string;
  name: string | undefined;
  default: boolean;
  forced: boolean;
  enabled: boolean;
  hearingImpaired: boolean;
  visualImpaired: boolean;
  commentary: boolean;
  original: boolean;
}

export interface ContainerFacts {
  file: string;
  /** Container duration in nanoseconds, as mkvmerge reports it. */
  durationNs: number | undefined;
  title: string | undefined;
  /** One entry per chapter edition, holding its entry count. */
  chapterEditions: number[];
  attachments: ContainerAttachment[];
  globalTagCount: number;
  trackTagCounts: { trackId: number; entries: number }[];
  tracks: ContainerTrack[];
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function flag(value: unknown): boolean {
  return value === true || value === 1;
}

export function parseContainerFacts(file: string, json: unknown): ContainerFacts {
  const root = rec(json);
  const container = rec(root["container"]);
  const props = rec(container["properties"]);

  const chapterEditions: number[] = [];
  for (const c of Array.isArray(root["chapters"]) ? root["chapters"] : []) {
    chapterEditions.push(num(rec(c)["num_entries"]) ?? 0);
  }

  const attachments: ContainerAttachment[] = [];
  for (const a of Array.isArray(root["attachments"]) ? root["attachments"] : []) {
    const r = rec(a);
    attachments.push({
      id: num(r["id"]) ?? -1,
      fileName: str(r["file_name"]) ?? "",
      size: num(r["size"]) ?? 0,
      contentType: str(r["content_type"]) ?? "",
      description: str(r["description"]),
    });
  }

  let globalTagCount = 0;
  const trackTagCounts: { trackId: number; entries: number }[] = [];
  for (const t of Array.isArray(root["global_tags"]) ? root["global_tags"] : []) {
    globalTagCount += num(rec(t)["num_entries"]) ?? 0;
  }
  for (const t of Array.isArray(root["track_tags"]) ? root["track_tags"] : []) {
    const r = rec(t);
    trackTagCounts.push({
      trackId: num(r["track_id"]) ?? -1,
      entries: num(r["num_entries"]) ?? 0,
    });
  }

  const tracks: ContainerTrack[] = [];
  for (const t of Array.isArray(root["tracks"]) ? root["tracks"] : []) {
    const r = rec(t);
    const p = rec(r["properties"]);
    const id = num(r["id"]);
    if (id === undefined) continue;
    tracks.push({
      id,
      number: num(p["number"]) ?? id + 1,
      type: str(r["type"]) ?? "unknown",
      codecId: str(p["codec_id"]) ?? "",
      language: str(p["language"]) ?? str(p["language_ietf"]) ?? "und",
      name: str(p["track_name"]),
      default: flag(p["default_track"]),
      forced: flag(p["forced_track"]),
      enabled: p["enabled_track"] === undefined ? true : flag(p["enabled_track"]),
      hearingImpaired: flag(p["flag_hearing_impaired"]),
      visualImpaired: flag(p["flag_visual_impaired"]),
      commentary: flag(p["flag_commentary"]),
      original: flag(p["flag_original"]),
    });
  }

  return {
    file,
    durationNs: num(props["duration"]),
    title: str(props["title"]),
    chapterEditions,
    attachments,
    globalTagCount,
    trackTagCounts,
    tracks,
  };
}

export async function readContainerFacts(
  file: string,
  mkvmergePath = toolPath("mkvmerge"),
): Promise<ContainerFacts> {
  const r = await spawnCapture(mkvmergePath, ["-J", file]);
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new MkvInspectError(
      `mkvmerge produced no usable JSON for ${file}`,
      file,
      r.stderr.trim() || r.stdout.slice(0, 500),
    );
  }
  if (r.code >= 2) {
    throw new MkvInspectError(`mkvmerge failed to identify ${file}`, file, r.stderr.trim());
  }
  return parseContainerFacts(file, json);
}

/** Human-readable one-liner for a track, used when reporting a mismatch. */
export function describeTrack(t: ContainerTrack): string {
  const flags = [
    t.default ? "default" : "",
    t.forced ? "forced" : "",
    t.hearingImpaired ? "hearing-impaired" : "",
    t.visualImpaired ? "visual-impaired" : "",
    t.commentary ? "commentary" : "",
    t.original ? "original" : "",
    t.enabled ? "" : "disabled",
  ]
    .filter(Boolean)
    .join("+");
  return `#${t.id} ${t.type} ${t.codecId} ${t.language}${
    t.name ? ` "${t.name}"` : ""
  }${flags ? ` [${flags}]` : ""}`;
}
