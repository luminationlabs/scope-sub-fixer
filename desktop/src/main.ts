/**
 * The whole UI: one state object, one render function.
 *
 * No framework. There are four screens and a list; state changes call
 * `update()`, which re-renders on the next animation frame, and clicks are
 * dispatched by `data-action` from one listener on the root.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { runAutopilot, type AutopilotHooks } from "./autopilot";
import { Engine, EngineError, type Job } from "./engine";
import type {
  ApplyFileView,
  ApplyResult,
  DoctorResult,
  EngineEvent,
  FileView,
  Hello,
  FixMode,
  PlanResult,
  RevertFileView,
  RevertResult,
  ToolChoices,
  ToolKind,
} from "./protocol";
import {
  describeArea,
  describeFile,
  describeFix,
  describePhase,
  canFixInPlace,
  canTick,
  choiceLine,
  chosenFor,
  confirmFinish,
  confirmInPlaceRun,
  confirmUndo,
  defaultSelection,
  describeUndo,
  narrowestShapeNote,
  fixButtonLabel,
  IN_PLACE,
  KEEP_DATES,
  DROP,
  datesWaiting,
  decideDrop,
  inPlaceEstimate,
  inPlaceWarning,
  undoRecordsKept,
  type ConfirmWords,
  describeSpace,
  explainError,
  formatBytes,
  phaseFraction,
  REBUILD_EXPLANATION,
  setupLead,
  TOOL_WORDS,
  TOOLS_NOT_READY,
  toolSource,
  withChoice,
  summarizeFix,
  UNREADABLE,
  unreadableNote,
  tempFolderShown,
  homeShortened,
  notesShown,
  revealLabel,
  pathNames,
  type FixPhase,
  type Tone,
} from "./words";

type Phase = "starting" | "home" | "scanning" | "results" | "fixing";

interface FixProgress {
  phase: FixPhase;
  fraction: number;
}

/** A question the user has to answer before something that changes movie files. */
type Modal =
  | { kind: "enable-in-place"; understood: boolean }
  | { kind: "run-in-place"; only: string[] }
  | { kind: "undo"; input: string }
  | { kind: "finish"; input: string };

interface State {
  phase: Phase;
  /**
   * The setting "Fix the original files (no copies)". Off unless the user
   * turned it on and confirmed the warning; remembered between launches.
   */
  inPlace: boolean;
  /**
   * The setting "Keep each movie file's date": in-place fixes and undos give
   * the file back the date it had. Shown beside the in-place setting; sent
   * with every write to an original, an undo or a "finish fixing" made while
   * that setting is off included. Off unless the user turned it on;
   * remembered between launches.
   */
  keepDates: boolean;
  /** Set while the engine waits for a network share to date the files it changed: up to this many seconds. */
  datesWait: number | undefined;
  /** True while something is being dragged across the window. */
  dropping: boolean;
  modal: Modal | undefined;
  /** Where this app keeps every folder's saved scan and undo records. */
  plansRoot: string | undefined;
  /** What became of each "put the original back", by title. */
  undone: Map<string, RevertFileView>;
  /** The title whose original is being put back right now. */
  undoing: string | undefined;
  hello: Hello | undefined;
  doctor: DoctorResult | undefined;
  /** Where the user said the tools are; remembered between launches. */
  tools: ToolChoices;
  /** The engine could not be started at all. */
  engineError: string | undefined;
  checking: boolean;
  showTools: boolean;
  /** A problem with the last thing asked for, shown until the next action. */
  error: string | undefined;
  notice: string | undefined;
  library: string | undefined;
  planDir: string | undefined;
  scan: {
    total: number;
    done: number;
    current: { relative: string; fraction: number } | undefined;
    cancelling: boolean;
    cancelled: boolean;
    reused: number;
  };
  files: FileView[];
  /** Titles the last scan could not read; their rows show an earlier scan's verdict. */
  unreadable: Set<string>;
  selected: Set<string>;
  expanded: Set<string>;
  outputRoot: string | undefined;
  fix: {
    active: boolean;
    cancelling: boolean;
    cancelled: boolean;
    /** The engine could not finish the run; what it had done by then is kept. */
    interrupted: boolean;
    /** How this run fixes: copies elsewhere, or the movie files themselves. */
    mode: FixMode;
    queue: string[];
    progress: Map<string, FixProgress>;
    results: Map<string, ApplyFileView>;
    finished: boolean;
  };
}

const state: State = {
  phase: "starting",
  inPlace: false,
  keepDates: false,
  datesWait: undefined,
  dropping: false,
  modal: undefined,
  plansRoot: undefined,
  undone: new Map(),
  undoing: undefined,
  hello: undefined,
  doctor: undefined,
  tools: {},
  engineError: undefined,
  checking: false,
  showTools: false,
  error: undefined,
  notice: undefined,
  library: undefined,
  planDir: undefined,
  scan: { total: 0, done: 0, current: undefined, cancelling: false, cancelled: false, reused: 0 },
  files: [],
  unreadable: new Set(),
  selected: new Set(),
  expanded: new Set(),
  outputRoot: undefined,
  fix: {
    active: false,
    cancelling: false,
    cancelled: false,
    interrupted: false,
    mode: "copy",
    queue: [],
    progress: new Map(),
    results: new Map(),
    finished: false,
  },
};

const engine = new Engine();
let job: Job<unknown> | undefined;
const root = document.getElementById("app")!;

// --- rendering --------------------------------------------------------------

let scheduled = false;
function update(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const list = root.querySelector<HTMLElement>(".list");
    const scroll = list?.scrollTop ?? 0;
    root.innerHTML = render();
    const next = root.querySelector<HTMLElement>(".list");
    if (next) next.scrollTop = scroll;
  });
}

function esc(text: string | number): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bar(fraction: number, busy = false): string {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  return `<div class="bar${busy ? " busy" : ""}"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
}

function badge(label: string, tone: Tone): string {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

function shortPath(path: string): string {
  return homeShortened(path);
}

function renderHeader(): string {
  const d = state.doctor;
  let pill = `<span class="pill muted">Starting…</span>`;
  if (state.engineError) pill = `<span class="pill bad">Engine stopped</span>`;
  else if (state.checking) pill = `<span class="pill muted">Checking…</span>`;
  else if (d) {
    pill = d.ok
      ? `<button class="pill good" data-action="toggle-tools" title="Show details">Ready</button>`
      : `<span class="pill bad">Setup required</span>`;
  }
  const version = state.hello ? `<span class="version">engine ${esc(state.hello.version)}</span>` : "";
  return `
    <header>
      <div class="brand">
        <div class="mark"><i></i></div>
        <div>
          <h1>Scope Sub Fixer</h1>
          <p>Moves Blu-ray subtitles out of the letterbox bars</p>
        </div>
      </div>
      <div class="header-right">${version}${pill}</div>
    </header>`;
}

function renderTools(d: DoctorResult): string {
  const rows = d.report.tools
    .map((t) => {
      const ok = t.found && !t.error;
      return `<tr>
        <td>${badge(ok ? "Found" : "Missing", ok ? "good" : "bad")}</td>
        <td class="mono">${esc(t.tool)}</td>
        <td>${esc(ok ? (t.version ?? "") : (t.error ?? "not found"))}</td>
        <td class="mono dim">${esc(shortPath(toolSource(t, state.tools)))}</td>
      </tr>`;
    })
    .join("");
  // Where each tool comes from, and the way to change it: also for tools that
  // were found, so that someone can switch to another build.
  const choices = (["mkvtoolnix", "ffmpeg"] as const)
    .map((kind) => {
      const chosen = chosenFor(kind, state.tools) !== undefined;
      return `<div class="row tool-choice">
        <span class="${chosen ? "" : "dim"}">${esc(shortPath(choiceLine(kind, state.tools)))}</span>
        <button class="link" data-action="locate" data-kind="${kind}" ${state.checking ? "disabled" : ""}>${esc(TOOL_WORDS[kind].pick)}</button>
        ${
          chosen
            ? `<button class="link" data-action="unlocate" data-kind="${kind}" ${state.checking ? "disabled" : ""}>Detect automatically</button>`
            : ""
        }
      </div>`;
    })
    .join("");
  const temp = d.report.tempDir;
  return `
    <table class="tools">
      ${rows}
      <tr>
        <td>${badge(d.report.frames.ok ? "OK" : "Problem", d.report.frames.ok ? "good" : "bad")}</td>
        <td class="mono">video frames</td>
        <td colspan="2">${esc(d.report.frames.detail)}</td>
      </tr>
      <tr>
        <td>${badge(temp.writable ? "OK" : "Problem", temp.writable ? "good" : "bad")}</td>
        <td class="mono">temp folder</td>
        <td>${temp.freeBytes === undefined ? "" : `${esc(formatBytes(temp.freeBytes))} free`}</td>
        <td class="mono dim">${esc(temp.path)}</td>
      </tr>
    </table>
    <div class="tool-choices">${choices}</div>`;
}

function renderSetup(d: DoctorResult): string {
  const problems = d.problems
    .map(
      (p) => `
      <li>
        <strong>${esc(p.message)}</strong>
        <p>${linkify(p.fix)}</p>
        ${
          p.locate
            ? `<div class="row locate">
                <button data-action="locate" data-kind="${p.locate}" ${state.checking ? "disabled" : ""}>Locate…</button>
                ${
                  chosenFor(p.locate, state.tools) !== undefined
                    ? `<button class="link" data-action="unlocate" data-kind="${p.locate}" ${state.checking ? "disabled" : ""}>Detect automatically</button>`
                    : ""
                }
              </div>`
            : ""
        }
      </li>`,
    )
    .join("");
  return `
    <section class="card setup">
      <h2>Setup required</h2>
      <p class="lead">${esc(setupLead(d, state.tools))}</p>
      <ul class="problems">${problems}</ul>
      <div class="row">
        <button class="primary" data-action="recheck" ${state.checking ? "disabled" : ""}>
          ${state.checking ? "Checking…" : "Check again"}
        </button>
        <button class="link" data-action="toggle-tools">${state.showTools ? "Hide details" : "Show details"}</button>
      </div>
      ${state.showTools ? renderTools(d) : ""}
    </section>`;
}

/** Escape, then turn `backticked` commands and bare URLs into something readable. */
function linkify(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code class="copyable">$1</code>')
    .replace(/(https?:\/\/[^\s,]+)/g, '<span class="url">$1</span>');
}

function renderHome(): string {
  const d = state.doctor;
  if (state.engineError) {
    return `
      <section class="card setup">
        <h2>The engine failed to start</h2>
        <p class="lead">${esc(state.engineError)}</p>
        <div class="row"><button class="primary" data-action="recheck">Try again</button></div>
      </section>`;
  }
  if (!d) return `<section class="card center"><p class="lead">Checking setup…</p></section>`;
  if (!d.ok) return renderSetup(d);
  return `
    <section class="card hero">
      <div class="diagram" aria-hidden="true">
        <div class="frame"><div class="picture"></div><div class="sub in-bar"></div></div>
        <div class="arrow">→</div>
        <div class="frame"><div class="picture"><div class="sub in-picture"></div></div></div>
      </div>
      <h2>Find subtitles outside the picture</h2>
      <p class="lead">Choose your movie folder, or drop it here. Scope Sub Fixer scans every MKV and lists
      the titles with subtitles outside the picture. Scanning does not modify any files.</p>
      <div class="row center">
        <button class="primary big" data-action="choose-library">Choose folder…</button>
      </div>
      ${state.inPlace ? renderInPlaceBanner() : renderInPlaceSetting()}
      ${state.showTools ? renderTools(d) : ""}
    </section>`;
}

/** Whether the engine in use can fix in place and put a fix back. */
function inPlaceAvailable(): boolean {
  return state.hello?.methods?.includes("revert") === true;
}

/** The setting while it is off: one quiet line. Copy mode otherwise looks as it always did. */
function renderInPlaceSetting(): string {
  if (!inPlaceAvailable()) return "";
  const busy = state.phase === "fixing" || state.phase === "scanning";
  return `
    <div class="setting">
      <label><input type="checkbox" data-action="toggle-in-place" ${busy ? "disabled" : ""} /> ${esc(IN_PLACE.setting)}</label>
      <button class="link" data-action="show-undo">${esc(IN_PLACE.showUndo)}</button>
    </div>`;
}

/** The setting while it is on: a warning that stays on screen. */
function renderInPlaceBanner(): string {
  const busy = state.phase === "fixing" || state.phase === "scanning";
  return `
    <section class="inplace-banner" role="alert">
      <div class="inplace-text">
        <strong>${esc(IN_PLACE.banner)}</strong>
        <p>${esc(IN_PLACE.bannerDetail)}</p>
        <div class="setting keep-dates">
          <label><input type="checkbox" data-action="toggle-keep-dates" ${state.keepDates ? "checked" : ""} ${
            busy ? "disabled" : ""
          } /> ${esc(KEEP_DATES.setting)}</label>
          <span>${esc(KEEP_DATES.hint)}</span>
        </div>
      </div>
      <div class="row">
        <button class="link" data-action="show-undo">${esc(IN_PLACE.showUndo)}</button>
        <button data-action="toggle-in-place" ${busy ? "disabled" : ""}>${esc(IN_PLACE.turnOff)}</button>
      </div>
    </section>`;
}

function renderConfirm(words: ConfirmWords, danger: boolean): string {
  return `
    <div class="modal-backdrop">
      <div class="modal ${danger ? "danger" : ""}" role="dialog" aria-modal="true">
        <h2>${esc(words.title)}</h2>
        ${words.body.map((line) => `<p>${esc(line)}</p>`).join("")}
        <div class="row end">
          <button data-action="modal-cancel">${esc(words.cancel)}</button>
          <button class="${danger ? "danger" : "primary"}" data-action="modal-confirm">${esc(words.confirm)}</button>
        </div>
      </div>
    </div>`;
}

function renderModal(): string {
  const m = state.modal;
  if (!m) return "";
  const titleFor = (input: string): string => state.files.find((f) => f.input === input)?.title ?? input;
  switch (m.kind) {
    case "enable-in-place":
      return `
        <div class="modal-backdrop">
          <div class="modal danger" role="dialog" aria-modal="true">
            <h2>${esc(IN_PLACE.modal.title)}</h2>
            <p>${esc(IN_PLACE.modal.lead)}</p>
            <ul class="warning-points">
              ${inPlaceWarning(shortPath(state.plansRoot ?? "this app's own data folder"))
                .map((point) => `<li>${esc(point)}</li>`)
                .join("")}
            </ul>
            <label class="acknowledge">
              <input type="checkbox" data-action="modal-acknowledge" ${m.understood ? "checked" : ""} />
              ${esc(IN_PLACE.modal.acknowledge)}
            </label>
            <div class="row end">
              <button class="link" data-action="show-undo">${esc(IN_PLACE.showUndo)}</button>
              <button data-action="modal-cancel">${esc(IN_PLACE.modal.cancel)}</button>
              <button class="danger" data-action="modal-confirm" ${m.understood ? "" : "disabled"}>${esc(IN_PLACE.modal.confirm)}</button>
            </div>
          </div>
        </div>`;
    case "run-in-place":
      return renderConfirm(confirmInPlaceRun(m.only.length), true);
    case "undo": {
      const f = state.files.find((x) => x.input === m.input);
      return renderConfirm(confirmUndo(titleFor(m.input), f?.interrupted !== undefined), true);
    }
    case "finish": {
      const f = state.files.find((x) => x.input === m.input);
      return renderConfirm(confirmFinish(titleFor(m.input), f?.interrupted?.doing ?? "fix"), true);
    }
  }
}

/** The mode the list and the footer are showing: the run's while one is on screen, else the setting. */
function shownMode(): FixMode {
  return state.phase === "fixing" || state.fix.finished ? state.fix.mode : state.inPlace ? "in-place" : "copy";
}

function renderRow(f: FileView): string {
  const mode = shownMode();
  const info = describeFile(f, mode);
  const fixable = canTick(f, mode);
  const undone = state.undone.get(f.input);
  const result = state.fix.results.get(f.input);
  const progress = state.fix.progress.get(f.input);
  const busy = state.phase === "fixing" || state.phase === "scanning";
  const expanded = state.expanded.has(f.input);

  let status = badge(info.label, info.tone);
  let action = `<span class="${info.tone === "warn" ? "" : "dim"}">${esc(info.action)}</span>`;
  if (state.unreadable.has(f.input) && !result && !progress) {
    // Not checked this time: say so, rather than show an old verdict as today's.
    status = badge(UNREADABLE.label, "bad");
    action = `<span>${esc(UNREADABLE.action)}</span>`;
  }
  if (f.interrupted && !result && !progress) {
    // Both ways out, right on the row: this title must not wait to be noticed.
    action = `<div class="row-actions"><span>${esc(info.action)}</span>
      <button data-action="finish" data-input="${esc(f.input)}" ${busy ? "disabled" : ""}>${esc(IN_PLACE.finish)}</button>
      <button data-action="undo" data-input="${esc(f.input)}" ${busy ? "disabled" : ""}>${esc(IN_PLACE.putBack)}</button></div>`;
  }
  if (state.undoing === f.input) {
    const doing = state.datesWait === undefined ? "Restoring and verifying…" : datesWaiting(state.datesWait);
    action = `<div class="inline-progress"><span>${esc(doing)}</span>${bar(0, true)}</div>`;
  } else if (undone && !result && !progress) {
    const u = describeUndo(undone);
    status = badge(u.label, u.tone);
    action = `<span>${esc(u.detail)}</span>`;
  }
  if (result) {
    const r = describeFix(result, f.method);
    status = badge(r.label, r.tone);
    action = `<span>${esc(r.detail)}</span>`;
  } else if (progress) {
    const label = describePhase(progress.phase, progress.fraction, f.method);
    // Only a copy can say how far along it is; the rest just show they are busy.
    action = `<div class="inline-progress"><span>${esc(label)}</span>${
      progress.phase === "waiting"
        ? bar(0)
        : progress.phase === "copy"
          ? bar(progress.fraction)
          : bar(0, true)
    }</div>`;
  }

  // A box to tick only while there is something to decide: not during a scan,
  // and not on a title this run has already fixed.
  const tickable = fixable && state.phase !== "scanning" && result?.status !== "applied";
  const checkbox = tickable
    ? `<input type="checkbox" data-action="toggle" data-input="${esc(f.input)}" ${
        state.selected.has(f.input) ? "checked" : ""
      } ${busy ? "disabled" : ""} aria-label="Fix ${esc(f.title)}" />`
    : "";
  const outside =
    f.tracks.length > 0 && f.tracks.every((t) => t.eventCount === undefined)
      ? `<span class="dim" title="No letterbox bars; subtitles not scanned">–</span>`
      : f.eventsOutside > 0
        ? `<strong>${f.eventsOutside}</strong>`
        : `<span class="dim">0</span>`;

  let details = "";
  if (expanded) {
    const tracks = f.tracks
      .map(
        (t) => `<tr>
          <td class="mono">#${t.id}</td>
          <td>${esc(t.name ?? t.language)}${t.forced ? " (forced)" : ""} <span class="dim">${esc(t.language)}</span></td>
          <td>${t.eventCount === undefined ? "not scanned" : `${t.eventCount} subtitles`}</td>
          <td>${t.eventsOutside > 0 ? `<strong>${t.eventsOutside} outside</strong>` : "0 outside"}</td>
          <td class="dim">${esc(t.reason ?? "")}</td>
        </tr>`,
      )
      .join("");
    const area = describeArea(f);
    const shapeNote = narrowestShapeNote(f);
    const checks = result
      ? `<ul class="checks">${result.checks.map((c) => `<li>${esc(c)}</li>`).join("")}${
          result.reason ? `<li class="bad-text">${esc(result.reason)}</li>` : ""
        }${dateNotKeptLines(result.dateNotKept)}</ul>
        ${
          result.status === "applied"
            ? `<p class="mono dim">${esc(shortPath(result.output))}
               <button class="link" data-action="reveal" data-path="${esc(result.output)}">${esc(revealLabel())}</button></p>`
            : ""
        }`
      : "";
    details = `
      <div class="details">
        <p class="dim">${esc(shortPath(f.input))} · ${esc(formatBytes(f.size))}${area ? ` · ${esc(area)}` : ""}</p>
        ${f.reason ? `<p>${esc(f.reason)}</p>` : ""}
        ${shapeNote ? `<p>${esc(shapeNote)}</p>` : ""}
        ${f.action === "fix" && f.method === "remux" ? `<p>${esc(REBUILD_EXPLANATION)}</p>` : ""}
        ${notesShown(f.notes).map((n) => `<p class="dim">${esc(n.replace(/ \(use --method remux\)/, ""))}</p>`).join("")}
        ${tracks ? `<table class="tracks">${tracks}</table>` : ""}
        ${f.fixed && !f.fixed.inPlace && !result ? `<p class="dim">Fixed copy: ${esc(shortPath(f.fixed.output))}</p>` : ""}
        ${
          f.fixed?.inPlace
            ? `<p>This file was fixed in place. Undo data is stored by Scope Sub Fixer.
               <button data-action="undo" data-input="${esc(f.input)}" ${busy || state.undoing ? "disabled" : ""}>${esc(IN_PLACE.undo)}</button></p>`
            : ""
        }
        ${
          f.interrupted
            ? `<p class="bad-text">${esc(info.action)}. The file may be partially modified. Finish the fix or restore the original.</p>`
            : ""
        }
        ${
          undone
            ? `<ul class="checks">${undone.checks.map((c) => `<li>${esc(c)}</li>`).join("")}${
                undone.reason && undone.status !== "reverted" ? `<li class="bad-text">${esc(undone.reason)}</li>` : ""
              }${dateNotKeptLines(undone.dateNotKept)}</ul>`
            : ""
        }
        ${checks}
      </div>`;
  }

  return `
    <div class="item ${expanded ? "open" : ""}">
      <div class="line" data-action="expand" data-input="${esc(f.input)}">
        <div class="cell check">${checkbox}</div>
        <div class="cell title" title="${esc(f.relative)}">${esc(f.title)}</div>
        <div class="cell status">${status}</div>
        <div class="cell count">${outside}</div>
        <div class="cell action">${action}</div>
        <div class="cell chevron">${expanded ? "▾" : "▸"}</div>
      </div>
      ${details}
    </div>`;
}

/** A date that could not be kept, in the list of a title's notes. In plain words: the engine's reason is for a log. */
function dateNotKeptLines(problem: string | undefined): string {
  if (problem === undefined) return "";
  return `<li class="warn-text">${esc(KEEP_DATES.notKept)}</li>`;
}

function renderList(): string {
  const scanningRow =
    state.phase === "scanning" && state.scan.current
      ? `<div class="item scanning">
          <div class="line">
            <div class="cell check"></div>
            <div class="cell title">${esc(titleOf(state.scan.current.relative))}</div>
            <div class="cell status">${badge("Reading…", "accent")}</div>
            <div class="cell count"></div>
            <div class="cell action">${bar(state.scan.current.fraction, state.scan.current.fraction === 0)}</div>
            <div class="cell chevron"></div>
          </div>
        </div>`
      : "";
  return `
    <div class="table">
      <div class="line head">
        <div class="cell check"></div>
        <div class="cell title">Title</div>
        <div class="cell status">Status</div>
        <div class="cell count" title="Subtitles outside the picture">Outside</div>
        <div class="cell action">${state.fix.results.size > 0 || state.phase === "fixing" ? "Result" : "Action"}</div>
        <div class="cell chevron"></div>
      </div>
      <div class="list">
        ${state.files.map(renderRow).join("")}
        ${scanningRow}
      </div>
    </div>`;
}

function titleOf(relative: string): string {
  const name = pathNames(relative).pop() ?? relative;
  return name.replace(/\.[^.]+$/, "");
}

function renderScanBanner(): string {
  const s = state.scan;
  const fraction = s.total === 0 ? 0 : (s.done + (s.current?.fraction ?? 0)) / s.total;
  return `
    <section class="banner">
      <div class="banner-text">
        <h2>${s.total === 0 ? "Finding movies…" : `Scanning ${Math.min(s.done + 1, s.total)} of ${s.total}`}</h2>
        <p class="dim">${esc(shortPath(state.library ?? ""))} · no files are modified</p>
        ${bar(fraction)}
      </div>
      <button data-action="cancel" ${s.cancelling ? "disabled" : ""}>${s.cancelling ? "Stopping…" : "Cancel"}</button>
    </section>`;
}

function renderResultsBanner(): string {
  const fixable = state.files.filter((f) => f.action === "fix");
  const needsButCant = state.files.filter((f) => f.status === "NEEDS_FIX" && f.action !== "fix").length;
  const fine = state.files.filter((f) => f.status === "OK" || f.status === "NO_PGS").length;
  const other = state.files.length - fixable.length - needsButCant - fine;
  const parts: string[] = [];
  if (fine > 0) parts.push(`${fine} ${fine === 1 ? "needs" : "need"} no changes`);
  if (needsButCant > 0) parts.push(`${needsButCant} cannot be fixed`);
  if (other > 0) parts.push(`${other} skipped`);
  const unread = state.files.filter((f) => state.unreadable.has(f.input)).length;
  const headline =
    state.files.length === 0
      ? "No MKV files found"
      : fixable.length === 0
        ? "No subtitles outside the picture"
        : `${fixable.length} ${fixable.length === 1 ? "title has" : "titles have"} subtitles outside the picture`;
  const cancelled =
    (state.scan.cancelled
      ? `<p class="warn-text">Scan stopped: ${state.scan.done} of ${state.scan.total} scanned. Scan again to continue; completed results are saved.</p>`
      : "") + (unread > 0 ? `<p class="warn-text">${esc(unreadableNote(unread))}</p>` : "");
  return `
    <section class="banner">
      <div class="banner-text">
        <h2>${esc(headline)}</h2>
        <p class="dim">${esc(shortPath(state.library ?? ""))} · ${state.files.length} scanned${
          parts.length ? ` · ${esc(parts.join(" · "))}` : ""
        }</p>
        ${cancelled}
      </div>
      <div class="row">
        <button data-action="rescan">Scan again</button>
        <button data-action="choose-library">Choose another folder…</button>
      </div>
    </section>`;
}

function renderFixBanner(): string {
  const f = state.fix;
  const total = f.queue.length;
  const done = f.results.size;
  let within = 0;
  for (const input of f.queue) {
    const p = f.progress.get(input);
    if (p && !f.results.has(input)) within = Math.max(within, phaseFraction(p.phase, p.fraction));
  }
  return `
    <section class="banner">
      <div class="banner-text">
        <h2>Fixing ${Math.min(done + 1, total)} of ${total}</h2>
        <p class="dim">${
          f.mode === "in-place"
            ? esc(IN_PLACE.running)
            : `Writing fixed copies to ${esc(shortPath(state.outputRoot ?? ""))} · originals are not modified`
        }</p>
        ${f.mode === "in-place" && f.cancelling && state.datesWait === undefined ? `<p class="warn-text">${esc(IN_PLACE.stopping)}</p>` : ""}
        ${state.datesWait === undefined ? "" : `<p>${esc(datesWaiting(state.datesWait))}</p>`}
        ${bar(total === 0 ? 0 : (done + within) / total)}
      </div>
      <button data-action="cancel" ${f.cancelling ? "disabled" : ""}>${f.cancelling ? "Stopping…" : "Cancel"}</button>
    </section>`;
}

function renderDoneBanner(): string {
  const sum = summarizeFix([...state.fix.results.values()], state.fix.queue.length, {
    cancelled: state.fix.cancelled,
    interrupted: state.fix.interrupted,
  }, state.fix.mode);
  const inPlace = state.fix.mode === "in-place";
  return `
    <section class="banner done ${sum.tone}">
      <div class="banner-text">
        <h2>${esc(sum.headline)}</h2>
        <p class="dim">${
          inPlace ? esc(IN_PLACE.finished) : `Saved to ${esc(shortPath(state.outputRoot ?? ""))} · originals unchanged`
        }${sum.parts.length ? ` · ${esc(sum.parts.join(" · "))}` : ""}</p>
      </div>
      <div class="row">
        ${sum.fixed > 0 && !inPlace ? `<button class="primary" data-action="reveal-output">${esc(revealLabel())}</button>` : ""}
        ${inPlace ? `<button data-action="show-undo">${esc(IN_PLACE.showUndo)}</button>` : ""}
        <button data-action="rescan">Scan again</button>
        <button data-action="choose-library">Choose another folder…</button>
      </div>
    </section>`;
}

function renderFooter(): string {
  if (state.phase !== "results" || state.fix.finished) return "";
  const fixable = state.files.filter((f) => f.action === "fix");
  if (fixable.length === 0) return "";
  if (state.inPlace) {
    // In-place mode: no output folder, a count of movie files, and a button
    // that says what it is about to do, in the colour of a warning.
    const tickable = state.files.filter((f) => canTick(f, "in-place"));
    const n = tickable.filter((f) => state.selected.has(f.input)).length;
    const needCopy = fixable.filter((f) => !canFixInPlace(f) && !f.fixed && !f.interrupted).length;
    return `
      <footer class="in-place">
        <div class="output">
          <span class="label">Original files will be modified</span>
          <span class="dim">${esc(IN_PLACE.footerNote)}</span>
        </div>
        <div class="row">
          <span class="dim estimate">${n === 0 ? "Select titles to fix" : esc(inPlaceEstimate(n, needCopy))}</span>
          <button class="danger" data-action="fix" ${n === 0 ? "disabled" : ""}>${esc(fixButtonLabel(n, "in-place"))}</button>
        </div>
      </footer>`;
  }
  const n = [...state.selected].filter((i) => fixable.some((f) => f.input === i)).length;
  const chosen = fixable.filter((f) => state.selected.has(f.input));
  const estimate = describeSpace(chosen, tempFolderShown(state.doctor?.report.tempDir.path));
  return `
    <footer>
      <div class="output">
        <span class="label">Save fixed copies to</span>
        <span class="mono ${state.outputRoot ? "" : "dim"}">${esc(
          state.outputRoot ? shortPath(state.outputRoot) : "No folder selected",
        )}</span>
        <button data-action="choose-output">${state.outputRoot ? "Change…" : "Choose folder…"}</button>
      </div>
      <div class="row">
        <span class="dim estimate">${n === 0 ? "Select titles to fix" : esc(estimate)}</span>
        <button class="primary" data-action="fix" ${n === 0 || !state.outputRoot ? "disabled" : ""}>
          Fix ${n === 0 ? "" : n} ${n === 1 ? "title" : "titles"}
        </button>
      </div>
      ${renderInPlaceSetting()}
    </footer>`;
}

function render(): string {
  const messages =
    (state.error ? `<div class="message bad"><span>${esc(state.error)}</span><button class="link" data-action="dismiss">Dismiss</button></div>` : "") +
    (state.notice ? `<div class="message">${esc(state.notice)}</div>` : "");
  let body: string;
  switch (state.phase) {
    case "starting":
    case "home":
      body = `<main class="centered">${messages}${renderHome()}</main>`;
      break;
    case "scanning":
      body = `<main>${messages}${state.inPlace ? renderInPlaceBanner() : ""}${renderScanBanner()}${renderList()}</main>`;
      break;
    case "fixing":
      body = `<main>${messages}${state.inPlace ? renderInPlaceBanner() : ""}${renderFixBanner()}${renderList()}</main>`;
      break;
    case "results":
      body = `<main>${messages}${state.inPlace ? renderInPlaceBanner() : ""}${state.fix.finished ? renderDoneBanner() : renderResultsBanner()}${
        state.doctor && state.showTools ? `<section class="card">${renderTools(state.doctor)}</section>` : ""
      }${renderList()}</main>${renderFooter()}`;
      break;
  }
  const drop = state.dropping
    ? `<div class="drop-overlay" aria-hidden="true"><div class="drop-hint">${esc(DROP.hint)}</div></div>`
    : "";
  return renderHeader() + body + renderModal() + drop;
}

// --- actions ----------------------------------------------------------------

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An error in words for the person at the screen, not the engine's or the system's. */
function explain(err: unknown, doing: "scan" | "fix", folder: string | undefined): string {
  const code = err instanceof EngineError ? err.code : "failed";
  return explainError(code, messageOf(err), doing, folder === undefined ? undefined : shortPath(folder));
}

async function checkSetup(): Promise<void> {
  state.checking = true;
  state.engineError = undefined;
  update();
  try {
    state.hello = await engine.hello();
    state.doctor = await engine.request<DoctorResult>("doctor");
    // Past the first screen there is no setup card to show a problem on.
    if (!state.doctor.ok && state.phase === "results") {
      const first = state.doctor.problems[0];
      state.error = first ? `${first.message} ${first.fix}` : TOOLS_NOT_READY;
      state.showTools = true;
    }
  } catch (err) {
    state.engineError = messageOf(err);
  }
  state.checking = false;
  if (state.phase === "starting") state.phase = "home";
  update();
  if (iconFolderWaiting) void openFromIcon();
}

/** Where this library's plan lives: app data, keyed by the folder's path. */
async function planDirFor(library: string): Promise<string> {
  const bytes = new TextEncoder().encode(library);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const name = (pathNames(library).pop() ?? "library")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return join(await appDataDir(), "plans", `${name || "library"}-${hash}`);
}

function resetFix(): void {
  state.fix = {
    active: false,
    cancelling: false,
    cancelled: false,
    interrupted: false,
    mode: "copy",
    queue: [],
    progress: new Map(),
    results: new Map(),
    finished: false,
  };
}

/**
 * True from the moment a scan or a fix is asked for until it has ended. It is
 * set before anything is awaited, so a second click that arrives before the
 * screen has redrawn cannot start a second job — or, by failing as "busy",
 * take the screen away from the first.
 */
let working = false;

/**
 * Point the engine at a tool the user chose (or, with no path, back at its own
 * search), remember it for the next launch, and check again. The choice is
 * saved and sent before the check, so what the check reports is the choice.
 */
async function chooseTool(kind: ToolKind, path: string | undefined): Promise<void> {
  if (working) return;
  const next = withChoice(state.tools, kind, path);
  state.error = undefined;
  await engine.setTools(next);
  state.tools = next;
  await invoke("tools_save", { tools: next }).catch((err: unknown) => {
    state.error = `The location is in use for this session but could not be saved: ${messageOf(err)}`;
  });
  await checkSetup();
}

async function locateTool(kind: ToolKind): Promise<void> {
  if (working) return;
  const picked = await open({ directory: kind === "mkvtoolnix", multiple: false, title: TOOL_WORDS[kind].dialog });
  if (typeof picked === "string") await chooseTool(kind, picked);
}

/**
 * A folder that arrived without the picker: dropped on the window, or on the
 * app's icon. It is treated as "Choose folder…" would treat it — one folder,
 * nothing else running — and anything else is said in a line.
 */
async function openDropped(paths: readonly string[]): Promise<void> {
  const items = await Promise.all(
    paths.map(async (path) => ({
      path,
      isFolder: await invoke<boolean>("path_is_folder", { path }).catch(() => false),
    })),
  );
  const busy =
    working ||
    state.checking ||
    state.modal !== undefined ||
    state.undoing !== undefined ||
    state.phase === "starting" ||
    state.phase === "scanning" ||
    state.phase === "fixing";
  const what = decideDrop(items, busy);
  if ("message" in what) {
    state.error = what.message;
    update();
    return;
  }
  state.error = undefined;
  await scan(what.scan);
}

/**
 * A folder dropped on the app's icon (macOS), which the shell keeps until it is asked for.
 * Asking takes it, so it is not asked for while the setup check runs (a cold
 * start's drop arrives then): the folder stays with the shell, and the check
 * asks again when it finishes.
 */
let iconFolderWaiting = false;
async function openFromIcon(): Promise<void> {
  if (state.phase === "starting" || state.checking) {
    iconFolderWaiting = true;
    return;
  }
  iconFolderWaiting = false;
  const folder = await invoke<string | null>("opened_folder").catch(() => null);
  if (folder) await openDropped([folder]);
}

/** A scan or a fix must not run on tools the setup check has refused. */
function toolsReady(): boolean {
  if (state.doctor?.ok !== false) return true;
  state.error = TOOLS_NOT_READY;
  state.showTools = true;
  update();
  return false;
}

async function scan(library: string): Promise<void> {
  if (working || !toolsReady()) return;
  working = true;
  try {
    await runScan(library, false);
  } finally {
    working = false;
  }
}

async function runScan(library: string, reanalyze: boolean): Promise<void> {
  state.library = library;
  state.phase = "scanning";
  state.error = undefined;
  if (!reanalyze) state.notice = undefined;
  state.files = [];
  state.undone = new Map();
  state.unreadable = new Set();
  state.selected = new Set();
  state.expanded = new Set();
  state.scan = { total: 0, done: 0, current: undefined, cancelling: false, cancelled: false, reused: 0 };
  resetFix();
  update();

  try {
    const planDir = await planDirFor(library);
    state.planDir = planDir;
    const onEvent = (e: EngineEvent): void => {
      switch (e.event) {
        case "plan.targets":
          state.scan.total = e.data.total;
          break;
        case "plan.file-start":
          state.scan.current = { relative: e.data.relative, fraction: 0 };
          break;
        case "plan.file-progress":
          if (state.scan.current && e.data.total > 0) {
            state.scan.current.fraction = e.data.done / e.data.total;
          }
          break;
        case "plan.file-done":
          state.scan.done++;
          state.scan.current = undefined;
          state.files.push(e.data.file as FileView);
          break;
        default:
          return;
      }
      update();
    };
    const running = await engine.job<PlanResult>(
      "plan",
      // remuxFallback: titles the byte patch cannot repair (compressed subtitle
      // tracks, mostly) are planned for a rebuild instead of being left out.
      { paths: [library], planDir, recursive: true, remuxFallback: true, ...(reanalyze ? { reanalyze: true } : {}) },
      onEvent,
    );
    job = running;
    const result = await running.result;
    job = undefined;

    state.files = result.files;
    state.unreadable = new Set(result.unreadable ?? []);
    state.scan.cancelled = result.cancelled;
    state.scan.reused = result.reused;
    state.scan.current = undefined;
    // Tick what can be fixed and has not been already.
    // A title that could not be read just now is not ticked: fixing it would only fail.
    state.selected = new Set(defaultSelection(result.files, state.inPlace ? "in-place" : "copy", state.unreadable));
    // A movie file that may be half changed is opened, not left to be found.
    for (const f of result.files) if (f.interrupted) state.expanded.add(f.input);
    if (result.missingPaths.length > 0) state.error = `Folder not found: ${result.missingPaths.join(", ")}`;
    state.phase = "results";
  } catch (err) {
    job = undefined;
    // A saved scan from another version of the engine cannot be mixed with
    // new results. Nothing has been written to the library, so start it over.
    if (err instanceof EngineError && err.code === "plan-file" && !reanalyze) {
      state.notice = "This folder was scanned by a different version of Scope Sub Fixer. All titles are being rescanned.";
      return runScan(library, true);
    }
    // …unless that saved scan holds the undo records of files fixed in place.
    // Then it is the only way back for them, and the engine has refused to
    // rebuild it. Say so; do not try anything else.
    state.error =
      err instanceof EngineError && err.code === "undo-records"
        ? undoRecordsKept(shortPath(state.planDir ?? ""))
        : explain(err, "scan", library);
    state.notice = undefined;
    state.phase = state.files.length > 0 ? "results" : "home";
  }
  update();
}

/** How one run fixes: a copy under a folder, or the movie files themselves. */
type FixTarget = { mode: "copy"; outputRoot: string } | { mode: "in-place" };

async function fix(): Promise<void> {
  if (working || state.modal || state.phase !== "results" || !toolsReady()) return;
  if (!state.planDir) return;
  const mode: FixMode = state.inPlace ? "in-place" : "copy";
  const only = state.files.filter((f) => canTick(f, mode) && state.selected.has(f.input)).map((f) => f.input);
  if (only.length === 0) return;
  if (mode === "in-place") {
    // Every run that changes movie files is asked about, every time.
    state.modal = { kind: "run-in-place", only };
    update();
    return;
  }
  if (!state.outputRoot) return;
  await startFix(state.planDir, { mode: "copy", outputRoot: state.outputRoot }, only);
}

async function startFix(planDir: string, target: FixTarget, only: string[]): Promise<void> {
  if (working) return;
  working = true;
  try {
    await runFix(planDir, target, only);
  } finally {
    working = false;
  }
}

/** Put one title's original subtitles back: the engine's `revert`, in place, for exactly that title. */
async function runUndo(input: string): Promise<void> {
  if (working || !state.planDir) return;
  working = true;
  state.undoing = input;
  state.error = undefined;
  state.fix.results.delete(input);
  update();
  try {
    const running = await engine.job<RevertResult>(
      "revert",
      { planDir: state.planDir, only: [input], ...(keepDatesNow() ? { keepDates: true } : {}) },
      (e: EngineEvent) => {
        if (e.event !== "revert.dates") return;
        state.datesWait = Number(e.data.seconds);
        update();
      },
    );
    const result = await running.result;
    const file = result.files.find((f) => f.input === input);
    if (file) {
      state.undone.set(input, file);
      state.expanded.add(input);
      const view = state.files.find((f) => f.input === input);
      if (view && file.status === "reverted") {
        // The movie file is the original again: no longer fixed, no longer half done.
        delete view.fixed;
        delete view.interrupted;
      }
    }
  } catch (err) {
    state.error = explain(err, "fix", undefined);
  } finally {
    state.undoing = undefined;
    state.datesWait = undefined;
    working = false;
  }
  update();
}

/** Answer the question on screen with its "go ahead" button. */
async function confirmModal(): Promise<void> {
  const m = state.modal;
  if (!m) return;
  switch (m.kind) {
    case "enable-in-place":
      if (!m.understood) return;
      state.modal = undefined;
      await setInPlace(true);
      break;
    case "run-in-place":
      state.modal = undefined;
      if (state.planDir) await startFix(state.planDir, { mode: "in-place" }, m.only);
      break;
    case "undo":
      state.modal = undefined;
      await runUndo(m.input);
      break;
    case "finish":
      state.modal = undefined;
      // Finishing an interrupted fix is an in-place fix of that one title,
      // whatever the setting says now: the file is already part-changed.
      if (state.planDir) await startFix(state.planDir, { mode: "in-place" }, [m.input]);
      break;
  }
}

/** Switch the mode, remember it, and tick what that mode can fix. */
async function setInPlace(on: boolean): Promise<void> {
  state.inPlace = on;
  state.selected = new Set(defaultSelection(state.files, on ? "in-place" : "copy", state.unreadable));
  update();
  await savePrefs();
}

/** Switch "keep each movie file's date" and remember it. No question: it changes no more than a fix does. */
async function setKeepDates(on: boolean): Promise<void> {
  state.keepDates = on;
  update();
  await savePrefs();
}

async function savePrefs(): Promise<void> {
  await invoke("prefs_save", { prefs: { inPlace: state.inPlace, keepDates: state.keepDates } }).catch((err: unknown) => {
    state.error = `The setting is on for this session but could not be saved: ${messageOf(err)}`;
  });
}

/**
 * Whether a run that changes movie files asks for their dates to be kept.
 * The remembered setting alone decides: putting a fix back or finishing an
 * interrupted one is offered with in-place fixing off too, and someone who
 * asked for dates to be kept means those files as well.
 */
function keepDatesNow(): boolean {
  return state.keepDates;
}

/** Reveal where this folder's undo records are (or, before any scan, where they all are). */
async function showUndoRecords(): Promise<void> {
  const candidates = [state.planDir, state.plansRoot].filter((p): p is string => p !== undefined);
  for (const path of candidates) {
    try {
      await revealItemInDir(path);
      return;
    } catch {
      // Not made yet; try the folder above.
    }
  }
  state.error = IN_PLACE.noUndoRecords;
}

/** The autopilot's ear on a fix (see `AutopilotHooks.onFixPhase`). */
let fixPhaseListener: ((phase: string) => void) | undefined;

async function runFix(planDir: string, target: FixTarget, only: string[]): Promise<void> {
  const outputRoot = target.mode === "copy" ? target.outputRoot : undefined;
  resetFix();
  state.fix.mode = target.mode;
  state.fix.active = true;
  state.fix.queue = only;
  for (const input of only) state.fix.progress.set(input, { phase: "waiting", fraction: 0 });
  state.phase = "fixing";
  state.error = undefined;
  state.notice = undefined;
  update();

  const settle = (file: ApplyFileView): void => {
    state.fix.results.set(file.input, file);
    state.fix.progress.delete(file.input);
    state.undone.delete(file.input);
    if (file.status === "applied") state.selected.delete(file.input);
    if (file.status === "applied" && file.inPlace) {
      // The movie file itself is fixed now: the row offers the way back.
      const view = state.files.find((f) => f.input === file.input);
      if (view) {
        view.fixed = { output: file.input, time: new Date().toISOString(), inPlace: true };
        delete view.interrupted;
      }
    }
  };
  try {
    const onEvent = (e: EngineEvent): void => {
      switch (e.event) {
        case "apply.file-start":
          state.fix.progress.set(e.data.input, { phase: target.mode === "in-place" ? "in-place" : "copy", fraction: 0 });
          break;
        case "apply.file-progress":
          fixPhaseListener?.(String(e.data.phase));
          state.fix.progress.set(e.data.input, {
            phase: e.data.phase,
            fraction: e.data.total ? e.data.done / e.data.total : 1,
          });
          break;
        case "apply.file-done": {
          const file = e.data.file as ApplyFileView;
          settle(file);
          if (file.status !== "applied") state.expanded.add(file.input);
          break;
        }
        case "apply.dates":
          state.datesWait = Number(e.data.seconds);
          break;
        default:
          return;
      }
      update();
    };
    const running = await engine.job<ApplyResult>(
      "apply",
      target.mode === "in-place"
        ? { planDir, mode: "in-place", only, ...(keepDatesNow() ? { keepDates: true } : {}) }
        : { planDir, outputRoot, only },
      onEvent,
    );
    job = running;
    const result = await running.result;
    job = undefined;
    for (const file of result.files) {
      settle(file);
      // Only the answer knows which dates could not be kept; open those rows.
      if (file.dateNotKept !== undefined) state.expanded.add(file.input);
    }
    state.fix.cancelled = result.cancelled;
    state.fix.progress.clear();
    state.fix.finished = true;
  } catch (err) {
    job = undefined;
    state.error = explain(err, "fix", outputRoot);
    state.fix.progress.clear();
    if (state.fix.results.size > 0) {
      // The run broke off part-way. What it finished is real — the copies are
      // on disk and checked — so it stays on screen, under the reason it stopped.
      state.fix.interrupted = true;
      state.fix.finished = true;
    } else {
      // Refused before it began (no room, an unsafe folder): back to choosing.
      resetFix();
    }
  }
  state.fix.active = false;
  state.fix.cancelling = false;
  state.datesWait = undefined;
  state.phase = "results";
  update();
}

async function cancel(): Promise<void> {
  if (!job) return;
  if (state.phase === "scanning") state.scan.cancelling = true;
  if (state.phase === "fixing") state.fix.cancelling = true;
  update();
  await job.cancel();
}

async function chooseFolder(title: string): Promise<string | undefined> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : undefined;
}

/**
 * For the autopilot: what a click on one of the app's own controls does, for
 * the controls that open a question rather than a native picker.
 */
function clickAction(action: "toggle-in-place" | "fix" | "undo" | "finish" | "modal-acknowledge", input?: string): Promise<void> {
  switch (action) {
    case "toggle-in-place":
      if (state.inPlace) return setInPlace(false);
      state.modal = { kind: "enable-in-place", understood: false };
      break;
    case "modal-acknowledge":
      if (state.modal?.kind === "enable-in-place") state.modal.understood = true;
      break;
    case "fix":
      return fix();
    case "undo":
      if (input && !working) state.modal = { kind: "undo", input };
      break;
    case "finish":
      if (input && !working) state.modal = { kind: "finish", input };
      break;
  }
  update();
  return Promise.resolve();
}

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset["action"]!;
  const input = target.dataset["input"];
  const run = async (): Promise<void> => {
    switch (action) {
      case "recheck":
        await checkSetup();
        break;
      case "locate":
        await locateTool(target.dataset["kind"] === "ffmpeg" ? "ffmpeg" : "mkvtoolnix");
        break;
      case "unlocate":
        await chooseTool(target.dataset["kind"] === "ffmpeg" ? "ffmpeg" : "mkvtoolnix", undefined);
        break;
      case "toggle-tools":
        state.showTools = !state.showTools;
        break;
      case "dismiss":
        state.error = undefined;
        break;
      case "choose-library": {
        const folder = await chooseFolder("Select your movie folder");
        if (folder) await scan(folder);
        break;
      }
      case "rescan":
        if (state.library) await scan(state.library);
        break;
      case "choose-output": {
        const folder = await chooseFolder("Select a folder for the fixed copies");
        if (folder) {
          state.outputRoot = folder;
          state.error = undefined;
        }
        break;
      }
      case "toggle":
        // The checkbox has already changed; mirror it, and do not expand the row.
        if (input) {
          if ((target as HTMLInputElement).checked) state.selected.add(input);
          else state.selected.delete(input);
        }
        break;
      case "expand":
        if (input && (event.target as HTMLElement).tagName !== "BUTTON") {
          if (state.expanded.has(input)) state.expanded.delete(input);
          else state.expanded.add(input);
        }
        break;
      case "fix":
        await fix();
        break;
      case "toggle-keep-dates":
        if (working) break;
        await setKeepDates((target as HTMLInputElement).checked);
        break;
      case "toggle-in-place":
        if (working) break;
        // Off is immediate. On is a question first: the checkbox does not
        // change until it has been answered.
        if (state.inPlace) await setInPlace(false);
        else state.modal = { kind: "enable-in-place", understood: false };
        break;
      case "modal-acknowledge":
        if (state.modal?.kind === "enable-in-place") {
          state.modal.understood = (target as HTMLInputElement).checked;
        }
        break;
      case "modal-cancel":
        state.modal = undefined;
        break;
      case "modal-confirm":
        await confirmModal();
        break;
      case "undo":
        if (input && !working) state.modal = { kind: "undo", input };
        break;
      case "finish":
        if (input && !working) state.modal = { kind: "finish", input };
        break;
      case "show-undo":
        await showUndoRecords();
        break;
      case "cancel":
        await cancel();
        break;
      case "reveal":
        if (target.dataset["path"]) await revealItemInDir(target.dataset["path"]);
        break;
      case "reveal-output": {
        const first = [...state.fix.results.values()].find((r) => r.status === "applied");
        if (first) await revealItemInDir(first.output);
        break;
      }
    }
    update();
  };
  if (action === "toggle") event.stopPropagation();
  run().catch((err: unknown) => {
    state.error = messageOf(err);
    update();
  });
});

// --- start ------------------------------------------------------------------

const hooks: AutopilotHooks = {
  state: () => state,
  scan: (library) => scan(library),
  fix: () => fix(),
  cancel: () => cancel(),
  chooseTool: (kind, path) => chooseTool(kind, path),
  click: (action, input) => clickAction(action, input),
  confirm: () => confirmModal(),
  quit: () => invoke("autopilot_quit"),
  onFixPhase: (listener) => {
    fixPhaseListener = listener;
  },
  log: (message) => void invoke("autopilot_log", { message }).catch(() => undefined),
  setOutput: (folder) => {
    state.outputRoot = folder;
    update();
  },
  toggleTools: () => {
    state.showTools = !state.showTools;
    update();
  },
  expand: (input) => {
    state.expanded.add(input);
    update();
  },
};

update();
/** What was chosen on an earlier launch, sent to the engine before it is asked anything. */
async function restoreTools(): Promise<void> {
  try {
    state.plansRoot = await join(await appDataDir(), "plans");
    const prefs = await invoke<{ inPlace?: boolean; keepDates?: boolean }>("prefs_load");
    state.inPlace = prefs.inPlace === true;
    state.keepDates = prefs.keepDates === true;
  } catch {
    // Nothing remembered: copies, as always.
    state.inPlace = false;
    state.keepDates = false;
  }
  try {
    state.tools = await invoke<ToolChoices>("tools_load");
    await engine.setTools(state.tools);
  } catch {
    // Nothing remembered, or nothing readable: the engine searches.
  }
}

// A folder dragged over the window shows where it will land; dropped, it is opened.
void getCurrentWebview()
  .onDragDropEvent((event) => {
    const type = event.payload.type;
    const dropping = type === "enter" || type === "over";
    if (dropping !== state.dropping) {
      state.dropping = dropping;
      update();
    }
    if (event.payload.type === "drop") void openDropped(event.payload.paths);
  })
  .catch(() => undefined);
// A folder dropped on the app's icon while the app is running.
void listen("open-folder", () => void openFromIcon()).catch(() => undefined);

void restoreTools()
  .then(() => checkSetup())
  // A folder the app was started with: dropped on its icon while it was not running.
  .then(() => openFromIcon())
  .then(async () => {
  const script = await invoke<string | null>("autopilot").catch(() => null);
  if (script) {
    if (state.engineError) hooks.log(`the engine did not start: ${state.engineError}`);
    await runAutopilot(script, hooks);
  }
});
