/**
 * The engine: the `scope-sub-engine` sidecar, spoken to in JSON lines.
 *
 * The process belongs to the shell (`src-tauri/src/engine.rs`), which starts
 * it, hands this window what it writes as `engine` events, and stops it
 * properly when the app quits. This file is the protocol client on top:
 * `request` resolves with the result or rejects with an `EngineError`; the
 * events a request produces on the way go to the `onEvent` callback given with
 * it. If the process dies, everything pending is rejected and the next request
 * starts a new one.
 *
 * Each start has a generation number, and every event carries the one it came
 * from. A child the window has given up on can still have events in flight;
 * they are told apart by that number and ignored, so an old engine can never
 * fail a new one's requests.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PROTOCOL_VERSION, type EngineEvent, type Hello, type ToolChoices } from "./protocol";

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onEvent?: (event: EngineEvent) => void;
}

interface Running {
  generation: number;
  hello: Hello;
}

/** What the shell emits: one line the engine wrote, or word that it has gone. */
interface Wire {
  generation: number;
  kind: "stdout" | "stderr" | "error" | "exit";
  line?: string;
  code?: number;
}

export interface Job<T> {
  id: number;
  result: Promise<T>;
  cancel: () => Promise<void>;
}

/** One run of the sidecar: its own buffer, its own stderr, its own start-up promise. */
interface Child {
  generation: number;
  buffer: string;
  /** The last few lines the engine wrote to stderr, for an error message. */
  stderr: string[];
  ready: (hello: Hello) => void;
  failed: (err: Error) => void;
  dead: boolean;
}

export class Engine {
  private starting: Promise<Running> | undefined;
  private child: Child | undefined;
  private listening: Promise<unknown> | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starts = 0;
  /** Tools the user chose by hand; sent to every engine as it starts. */
  private tools: ToolChoices = {};

  /**
   * Tell the engine where the tools are (or, with nothing chosen, to search).
   * It is remembered here and sent again to any engine started later, so a
   * restarted engine never quietly goes back to the search.
   */
  async setTools(tools: ToolChoices): Promise<void> {
    this.tools = { ...tools };
    if (this.starting === undefined) return; // The next start sends it.
    const { generation } = await this.ensure();
    await (await this.send<unknown>(generation, "configure", { tools: this.wire() })).result;
  }

  /** The choice as `configure` takes it: every key present, null for "search". */
  private wire(): { mkvtoolnixDir: string | null; ffmpeg: string | null } {
    return { mkvtoolnixDir: this.tools.mkvtoolnixDir ?? null, ffmpeg: this.tools.ffmpeg ?? null };
  }

  /** Start the sidecar if it is not running; resolves with what it said it is. */
  async hello(): Promise<Hello> {
    return (await this.ensure()).hello;
  }

  private ensure(): Promise<Running> {
    this.starting ??= this.start().catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private async start(): Promise<Running> {
    this.listening ??= listen<Wire>("engine", (event) => this.onWire(event.payload));
    await this.listening;

    // Unique across reloads of the window, not only within this one.
    const generation = Date.now() * 1000 + (this.starts++ % 1000);
    let ready: (hello: Hello) => void = () => undefined;
    let failed: (err: Error) => void = () => undefined;
    const announced = new Promise<Hello>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const child: Child = { generation, buffer: "", stderr: [], ready, failed, dead: false };
    this.child = child;

    try {
      await invoke("engine_start", { generation });
    } catch (err) {
      child.dead = true;
      if (this.child === child) this.child = undefined;
      throw new EngineError("engine-start", `the engine could not be run: ${messageOf(err)}`);
    }
    const hello = await announced;
    if (hello.protocol !== PROTOCOL_VERSION) {
      child.dead = true;
      if (this.child === child) this.child = undefined;
      await invoke("engine_stop", { generation }).catch(() => undefined);
      throw new EngineError(
        "engine-protocol",
        `the engine speaks protocol ${hello.protocol}, this app speaks ${PROTOCOL_VERSION}`,
      );
    }
    // Before anything else is asked of it: a scan must never run on tools the
    // user has replaced. An engine too old to know `configure` cannot be told.
    if (this.tools.mkvtoolnixDir !== undefined || this.tools.ffmpeg !== undefined) {
      if (hello.methods?.includes("configure") === false) {
        console.warn("this engine cannot be told where the tools are; it will search for them");
      } else {
        await (await this.send<unknown>(generation, "configure", { tools: this.wire() })).result;
      }
    }
    return { generation, hello };
  }

  private onWire(wire: Wire): void {
    const child = this.child;
    // From a child this window no longer talks to: nothing it says matters.
    if (!child || child.dead || wire.generation !== child.generation) return;
    switch (wire.kind) {
      case "stdout":
        this.onStdout(child, wire.line ?? "");
        break;
      case "stderr":
        child.stderr.push((wire.line ?? "").trimEnd());
        if (child.stderr.length > 20) child.stderr.shift();
        break;
      case "error":
        // The shell could not read a line the engine wrote. The engine itself
        // is still there; losing one line is not losing the process.
        console.warn("the engine's output could not be read:", wire.line);
        break;
      case "exit":
        this.died(child, `the engine stopped unexpectedly (exit ${wire.code ?? "unknown"})`);
        break;
    }
  }

  private died(child: Child, why: string): void {
    if (child.dead) return;
    child.dead = true;
    const tail = child.stderr.filter((l) => l !== "").slice(-3);
    const error = new EngineError("engine-exit", `${why}${tail.length === 0 ? "" : `: ${tail.join(" / ")}`}`);
    child.failed(error);
    if (this.child !== child) return;
    this.child = undefined;
    this.starting = undefined;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  /** The shell delivers stdout a line at a time, but do not rely on it. */
  private onStdout(child: Child, chunk: string): void {
    child.buffer += chunk.endsWith("\n") || chunk.endsWith("\r") ? chunk : `${chunk}\n`;
    let at: number;
    while ((at = child.buffer.search(/[\r\n]/)) >= 0) {
      const line = child.buffer.slice(0, at).trim();
      child.buffer = child.buffer.slice(at + 1);
      if (line === "") continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        console.warn("engine wrote something that is not JSON:", line.slice(0, 200));
        continue;
      }
      this.onMessage(child, message);
    }
  }

  private onMessage(child: Child, message: Record<string, unknown>): void {
    if (typeof message["event"] === "string") {
      if (message["event"] === "ready") {
        child.ready(message["data"] as Hello);
        return;
      }
      const id = message["id"];
      if (typeof id === "number") {
        this.pending.get(id)?.onEvent?.({ event: message["event"], data: message["data"] });
      }
      return;
    }
    const id = message["id"];
    if (typeof id !== "number") {
      console.warn("engine reported an error outside any request:", message);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = message["error"] as { code?: string; message?: string } | undefined;
    if (error) pending.reject(new EngineError(error.code ?? "failed", error.message ?? "the engine failed"));
    else pending.resolve(message["result"]);
  }

  /** Send a request and get a handle that can cancel it. */
  async job<T>(
    method: string,
    params?: unknown,
    onEvent?: (event: EngineEvent) => void,
  ): Promise<Job<T>> {
    const { generation } = await this.ensure();
    return this.send<T>(generation, method, params, onEvent);
  }

  /** Write one request to the engine of `generation`, without starting one. */
  private async send<T>(
    generation: number,
    method: string,
    params?: unknown,
    onEvent?: (event: EngineEvent) => void,
  ): Promise<Job<T>> {
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onEvent === undefined ? {} : { onEvent }),
      });
    });
    try {
      await invoke("engine_write", {
        generation,
        line: JSON.stringify(params === undefined ? { id, method } : { id, method, params }),
      });
    } catch (err) {
      this.pending.delete(id);
      // Nobody is waiting on `result` yet; do not let it reject unheard.
      result.catch(() => undefined);
      throw new EngineError("engine-exit", `the engine is not running: ${messageOf(err)}`);
    }
    return {
      id,
      result,
      cancel: async () => {
        await this.request("cancel", { id }).catch(() => undefined);
      },
    };
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    return (await this.job<T>(method, params)).result;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
