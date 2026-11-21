/**
 * Autopilot: the UI driving itself, for end-to-end runs of the built app.
 *
 * Started only when the app is launched with `SCOPE_SUB_AUTOPILOT` set to a
 * JSON script (see `Script`). It calls the same functions the buttons call —
 * the one thing it replaces is the native folder picker, which nothing outside
 * the app can click. `docs/screenshots/` is made with it
 * (`scripts/screenshots.sh`).
 */
export interface Script {
  /**
   * Point the app at these tools first, as "Locate…" does once a
   * folder or file has been picked: `{"mkvtoolnix": <folder>, "ffmpeg": <file>}`.
   * An empty string goes back to the automatic search. With no `library` the
   * run ends there.
   */
  tools?: { mkvtoolnix?: string; ffmpeg?: string };
  /**
   * Turn "Fix original files in place (no copies)" on first, through its warning:
   * select the setting, select "I understand…", press the button. `false` turns it
   * off. Left out, the setting stays as the app remembered it (off, on a new
   * machine). FIXTURES ONLY: with this on, the run changes the files in `library`.
   */
  inPlace?: boolean;
  /** After the fix, put the first title fixed in place back, through its question. */
  undoFirst?: boolean;
  /** Folder to scan. */
  library?: string;
  /** Folder for the fixed copies; without it the run stops at the results. */
  output?: string;
  /** Pause between steps, so each state is on screen long enough to capture. */
  pauseMs?: number;
  /** Cancel the scan once this many titles are done, then scan again. */
  cancelScanAfter?: number;
  /** Open the row of the first fixed title at the end. */
  expandFirst?: boolean;
  /** Open the row of the title whose path contains this, at the end. */
  expandTitle?: string;
  /** Press Cancel when any title being fixed reaches this stage (e.g. "rebuild"). */
  cancelFixAt?: string;
  /**
   * Quit the app when any title being fixed reaches this stage, the way the
   * Quit menu item does — to see what a quit in the middle of a fix leaves.
   */
  quitFixAt?: string;
  /** Show the tool details on the first screen. */
  showTools?: boolean;
}

export interface AutopilotHooks {
  state: () => {
    phase: string;
    doctor: { ok: boolean } | undefined;
    scan: { done: number };
    inPlace: boolean;
    modal: { kind: string } | undefined;
    files: { input: string; action: string; title?: string; fixed?: { inPlace?: true }; interrupted?: unknown }[];
    undone: Map<string, { status: string; reason?: string }>;
    fix: {
      finished: boolean;
      mode: string;
      progress: Map<string, { phase: string }>;
      results: Map<string, { status: string; verified: boolean; inPlace?: true; reason?: string }>;
    };
  };
  scan: (library: string) => Promise<void>;
  fix: () => Promise<void>;
  cancel: () => Promise<void>;
  /** What a click on one of the app's own controls does (not a native picker). */
  click: (action: "toggle-in-place" | "fix" | "undo" | "finish" | "modal-acknowledge", input?: string) => Promise<void>;
  /** Press the "go ahead" button of the question on screen; resolves when what it started has ended. */
  confirm: () => Promise<void>;
  /** Choose a tool by hand, or (with no path) give it back to the search. */
  chooseTool: (kind: "mkvtoolnix" | "ffmpeg", path: string | undefined) => Promise<void>;
  /** Quit the app (hooked builds only). */
  quit: () => Promise<void>;
  /**
   * Called with each stage a title being fixed enters, as the engine reports
   * it — not on a timer, which a window that is not in front runs too slowly
   * to catch a stage that lasts a second.
   */
  onFixPhase: (listener: (phase: string) => void) => void;
  /** A line on the terminal the run was started from (hooked builds only). */
  log: (message: string) => void;
  setOutput: (folder: string) => void;
  toggleTools: () => void;
  expand: (input: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runAutopilot(json: string, hooks: AutopilotHooks): Promise<void> {
  let script: Script;
  try {
    script = JSON.parse(json) as Script;
  } catch {
    console.warn("SCOPE_SUB_AUTOPILOT is not JSON; ignoring it");
    return;
  }
  const pause = script.pauseMs ?? 1500;
  if (script.tools !== undefined) {
    for (const kind of ["mkvtoolnix", "ffmpeg"] as const) {
      const path = script.tools[kind];
      if (path === undefined) continue;
      await hooks.chooseTool(kind, path === "" ? undefined : path);
      hooks.log(`chose ${kind}: ${path === "" ? "(automatic search)" : path}; setup ${hooks.state().doctor?.ok === true ? "ok" : "NOT ok"}`);
    }
  }
  hooks.log(`in-place setting at start: ${hooks.state().inPlace ? "ON" : "off"}`);
  if (script.inPlace !== undefined && script.inPlace !== hooks.state().inPlace) {
    await hooks.click("toggle-in-place");
    if (script.inPlace) {
      hooks.log(`asked: ${hooks.state().modal?.kind ?? "nothing"}`);
      // Without the tick the button does nothing: check that before ticking.
      await hooks.confirm();
      hooks.log(`confirm without the tick: setting ${hooks.state().inPlace ? "ON" : "still off"}`);
      await sleep(pause);
      await hooks.click("modal-acknowledge");
      await sleep(pause);
      await hooks.confirm();
    }
    hooks.log(`in-place setting now: ${hooks.state().inPlace ? "ON" : "off"}`);
    await sleep(pause);
  }
  if (script.library === undefined) return;
  const library = script.library;
  if (hooks.state().doctor?.ok !== true) {
    hooks.log("stopping: the setup check did not pass");
    return;
  }
  hooks.log("setup ok; scanning");
  if (script.showTools) hooks.toggleTools();
  await sleep(pause);
  if (script.showTools) hooks.toggleTools();

  if (script.cancelScanAfter !== undefined) {
    const scanning = hooks.scan(library);
    while (hooks.state().phase === "scanning" && hooks.state().scan.done < script.cancelScanAfter) {
      await sleep(20);
    }
    await hooks.cancel();
    await scanning;
    await sleep(pause);
  }

  await hooks.scan(library);
  hooks.log(`scanned: ${hooks.state().files.length} title(s), phase ${hooks.state().phase}`);
  await sleep(pause);
  for (const f of hooks.state().files) {
    if (f.interrupted) hooks.log(`interrupted: ${f.title ?? f.input}`);
    if (f.fixed?.inPlace) hooks.log(`already fixed in place: ${f.title ?? f.input}`);
  }
  if (script.output === undefined && !hooks.state().inPlace) return;

  if (script.output !== undefined) hooks.setOutput(script.output);
  await sleep(pause);
  if (script.quitFixAt !== undefined) {
    let quitting = false;
    hooks.onFixPhase((phase) => {
      if (quitting || phase !== script.quitFixAt) return;
      quitting = true;
      hooks.log(`quitting at ${phase}`);
      void hooks.quit();
    });
  }
  let fixing = hooks.fix();
  if (hooks.state().inPlace) {
    // In-place mode asks before every run; the answer is what starts it.
    await fixing;
    hooks.log(`asked: ${hooks.state().modal?.kind ?? "nothing"}`);
    await sleep(pause);
    fixing = hooks.confirm();
  }
  if (script.cancelFixAt !== undefined) {
    const reached = (): boolean =>
      [...hooks.state().fix.progress.values()].some((p) => p.phase === script.cancelFixAt);
    while (hooks.state().phase !== "results" && !reached()) await sleep(10);
    if (reached()) {
      // Long enough to be seen (and captured) before it is stopped.
      await sleep(600);
      await hooks.cancel();
    }
  }
  await fixing;
  hooks.log(
    `fix finished (${hooks.state().fix.mode}): ` +
      [...hooks.state().fix.results.values()]
        .map((r) => `${r.status}${r.inPlace ? "/in-place" : ""}${r.verified ? "/verified" : ""}${r.reason ? ` (${r.reason})` : ""}`)
        .join(", "),
  );
  if (script.undoFirst) {
    const fixed = hooks.state().files.find((f) => f.fixed?.inPlace);
    if (fixed) {
      await sleep(pause);
      await hooks.click("undo", fixed.input);
      hooks.log(`asked: ${hooks.state().modal?.kind ?? "nothing"}`);
      await sleep(pause);
      await hooks.confirm();
      const u = hooks.state().undone.get(fixed.input);
      hooks.log(`undo of ${fixed.title ?? fixed.input}: ${u?.status ?? "no result"}${u?.reason ? ` (${u.reason})` : ""}`);
    } else {
      hooks.log("undo: no title is fixed in place");
    }
  }
  const wanted = script.expandTitle;
  const row = hooks
    .state()
    .files.find((f) =>
      wanted === undefined ? script.expandFirst === true && f.action === "fix" : f.input.includes(wanted),
    );
  if (row) hooks.expand(row.input);
}
