/** Drive `serve()` in-process: push request lines in, read messages out. */
import { serve, type EngineDeps } from "../../src/serve/server.js";

export interface Msg {
  id?: number | string | null;
  result?: any;
  error?: { code: string; message: string };
  event?: string;
  data?: any;
}

export interface Client {
  messages: Msg[];
  /** Send a request; resolves with its result/error message. */
  request: (method: string, params?: unknown) => Promise<Msg>;
  /** Send without waiting; returns the id. */
  post: (method: string, params?: unknown) => number;
  raw: (line: string) => void;
  /** Resolves with the first message (past or future) matching. */
  waitFor: (match: (m: Msg) => boolean) => Promise<Msg>;
  eventsOf: (id: number, event?: string) => Msg[];
  /** Close the input and wait for the server to wind down. */
  close: () => Promise<void>;
  done: Promise<void>;
}

export function startClient(engine?: EngineDeps): Client {
  const messages: Msg[] = [];
  const waiters: { match: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let nextId = 1;

  const input: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          for (;;) {
            const line = queue.shift();
            if (line !== undefined) return { value: line, done: false };
            if (closed) return { value: undefined, done: true };
            await new Promise<void>((r) => (wake = r));
          }
        },
      };
    },
  };
  const push = (line: string): void => {
    queue.push(line);
    wake?.();
  };

  const io = {
    input,
    write: (line: string): void => {
      const m = JSON.parse(line) as Msg;
      messages.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.match(m)) waiters.splice(i, 1)[0]!.resolve(m);
      }
    },
  };
  const done = engine === undefined ? serve(io) : serve(io, engine);

  const waitFor = (match: (m: Msg) => boolean): Promise<Msg> => {
    const seen = messages.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const post = (method: string, params?: unknown): number => {
    const id = nextId++;
    push(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    return id;
  };

  return {
    messages,
    post,
    raw: push,
    waitFor,
    request: (method, params) => {
      const id = post(method, params);
      return waitFor((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
    },
    eventsOf: (id, event) =>
      messages.filter((m) => m.id === id && m.event !== undefined && (event === undefined || m.event === event)),
    close: async () => {
      closed = true;
      wake?.();
      await done;
    },
    done,
  };
}
