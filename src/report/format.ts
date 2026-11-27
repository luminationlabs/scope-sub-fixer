/** Small formatting helpers shared by the human and JSON reports. */
import type { Rect } from "../geometry/rect.js";

/** `HH:MM:SS.mmm`, the form PRD §11.7 requires for jumping to an event. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const millis = total % 1000;
  const seconds = Math.floor(total / 1000) % 60;
  const minutes = Math.floor(total / 60000) % 60;
  const hours = Math.floor(total / 3600000);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(hours)}:${p(minutes)}:${p(seconds)}.${p(millis, 3)}`;
}

/** Locale-independent thousands separators, so reports stay reproducible. */
export function formatCount(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatRect(r: Rect): string {
  return `x=${r.x} y=${r.y} w=${r.width} h=${r.height}`;
}

export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** IEC byte sizes: `1.50 GiB`. Used by every command that writes a file. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}
