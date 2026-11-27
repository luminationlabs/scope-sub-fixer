import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_READ_STRATEGY,
  EbmlError,
  EbmlReader,
  READ_STRATEGIES,
  isNetworkPath,
  isReadStrategyName,
  isWindowsNetworkPath,
  mountTableKnown,
  parseDriveTypes,
  setDriveQuery,
  resolveReadStrategy,
  decodeId,
  decodeSignedVint,
  decodeVint,
  elementEnd,
  formatId,
  iterateElements,
  readUintBE,
  vintLength,
} from "../../src/mkv/ebml.js";
import { concat, element, vint } from "./support.js";

describe("read strategies", () => {
  it("names every strategy and keeps probe <= chunk", () => {
    for (const [name, strategy] of Object.entries(READ_STRATEGIES)) {
      expect(strategy.name).toBe(name);
      expect(strategy.probeSize).toBeLessThanOrEqual(strategy.maxChunkSize);
      expect(isReadStrategyName(name)).toBe(true);
    }
    expect(isReadStrategyName("nonsense")).toBe(false);
  });

  it("reads the whole file by default, which is what the docs promise", () => {
    // Every mention of the default in the README, the CLI help and the module
    // docstrings says "streams the file sequentially, fastest on every
    // transport measured". This is that claim, in code.
    expect(DEFAULT_READ_STRATEGY).toBe("sequential");
    const resolved = resolveReadStrategy();
    expect(resolved.name).toBe("sequential");
    expect(resolved.readThroughBytes).toBe(Number.POSITIVE_INFINITY);
    // "auto" on the command line means no strategy at all, i.e. this one.
    expect(resolveReadStrategy({}).name).toBe(resolved.name);
    // The byte-frugal ones really are byte-frugal, and are not the default.
    for (const name of ["adaptive", "minimal"] as const) {
      expect(READ_STRATEGIES[name].readThroughBytes).toBe(0);
      expect(name).not.toBe(DEFAULT_READ_STRATEGY);
    }
  });

  it("defaults to the named strategy and honours overrides", () => {
    expect(resolveReadStrategy().maxChunkSize).toBe(
      READ_STRATEGIES[DEFAULT_READ_STRATEGY].maxChunkSize,
    );
    expect(resolveReadStrategy({ strategy: "minimal" }).readThroughBytes).toBe(0);
    const custom = resolveReadStrategy({ strategy: "minimal", maxChunkSize: 4096 });
    expect(custom.maxChunkSize).toBe(4096);
    expect(custom.probeSize).toBeLessThanOrEqual(4096);
  });

  it("recognises local storage", () => {
    // The repository is on local storage in every environment this runs in.
    expect(isNetworkPath(process.cwd())).toBe(false);
    // A path that cannot be resolved must not throw.
    expect(() => isNetworkPath(join(tmpdir(), "definitely", "not", "here"))).not.toThrow();
  });
});

describe("network paths on Windows", () => {
  // What `Get-CimInstance Win32_LogicalDisk` prints through the drive query:
  // C: local disk, D: optical, Q: mapped share, plus PowerShell's CRLFs.
  const SAMPLE = "C: 3\r\nD: 5\r\nQ: 4\r\n\r\n";
  afterEach(() => setDriveQuery(undefined));

  it("parses the drive query defensively", () => {
    expect(parseDriveTypes(SAMPLE)).toEqual(
      new Map([
        ["C", 3],
        ["D", 5],
        ["Q", 4],
      ]),
    );
    // A banner, a warning or a lower-case letter does not spoil the rest.
    expect(parseDriveTypes("WARNING: something\ny: 4\n  E:   2  \n")).toEqual(
      new Map([
        ["Y", 4],
        ["E", 2],
      ]),
    );
    // Nothing recognisable is a query that did not work, never "no drives".
    expect(parseDriveTypes("")).toBeUndefined();
    expect(parseDriveTypes("Get-CimInstance : Access denied")).toBeUndefined();
  });

  it("knows UNC paths and mapped drives", () => {
    const drives = parseDriveTypes(SAMPLE);
    expect(isWindowsNetworkPath(String.raw`\\nas\media\Film.mkv`, undefined)).toBe(true);
    expect(isWindowsNetworkPath(String.raw`\\?\UNC\nas\media\Film.mkv`, undefined)).toBe(true);
    expect(isWindowsNetworkPath(String.raw`Q:\Films\Film.mkv`, drives)).toBe(true);
    expect(isWindowsNetworkPath("q:/Films/Film.mkv", drives)).toBe(true);
    expect(isWindowsNetworkPath(String.raw`\\?\Q:\Films\Film.mkv`, drives)).toBe(true);
    expect(isWindowsNetworkPath(String.raw`C:\Films\Film.mkv`, drives)).toBe(false);
    expect(isWindowsNetworkPath(String.raw`\\?\C:\Films\Film.mkv`, drives)).toBe(false);
    expect(isWindowsNetworkPath(String.raw`\\.\C:\Films\Film.mkv`, drives)).toBe(false);
    // Without the table a drive letter is not known to be a share.
    expect(isWindowsNetworkPath(String.raw`Q:\Films\Film.mkv`, undefined)).toBe(false);
  });

  it("asks once, and says the table is known only when the query worked", () => {
    let calls = 0;
    setDriveQuery(() => {
      calls += 1;
      return SAMPLE;
    });
    expect(isNetworkPath(String.raw`Q:\Films\a.mkv`, "win32")).toBe(true);
    expect(isNetworkPath(String.raw`C:\Films\a.mkv`, "win32")).toBe(false);
    expect(mountTableKnown("win32")).toBe(true);
    expect(calls).toBe(1);

    setDriveQuery(() => {
      throw new Error("powershell.exe not found");
    });
    expect(mountTableKnown("win32")).toBe(false);
    expect(isNetworkPath(String.raw`Q:\Films\a.mkv`, "win32")).toBe(false);
    // A UNC path needs no table.
    expect(isNetworkPath(String.raw`\\nas\media\a.mkv`, "win32")).toBe(true);
  });
});

describe("vintLength", () => {
  it("derives the length from the leading 1 bit", () => {
    expect(vintLength(0x80)).toBe(1);
    expect(vintLength(0xff)).toBe(1);
    expect(vintLength(0x40)).toBe(2);
    expect(vintLength(0x20)).toBe(3);
    expect(vintLength(0x10)).toBe(4);
    expect(vintLength(0x08)).toBe(5);
    expect(vintLength(0x01)).toBe(8);
  });

  it("rejects the all-zero first byte", () => {
    expect(vintLength(0x00)).toBe(0);
  });
});

describe("decodeId", () => {
  it("keeps the marker bits, as Matroska IDs are written", () => {
    expect(decodeId(Uint8Array.of(0xa3))).toEqual({ id: 0xa3, length: 1 });
    expect(decodeId(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75))).toEqual({
      id: 0x1f43b675,
      length: 4,
    });
    expect(decodeId(Uint8Array.of(0x18, 0x53, 0x80, 0x67))).toEqual({
      id: 0x18538067,
      length: 4,
    });
    expect(decodeId(Uint8Array.of(0x2a, 0xd7, 0xb1))).toEqual({
      id: 0x2ad7b1,
      length: 3,
    });
  });

  it("reads at an offset", () => {
    const bytes = Uint8Array.of(0x00, 0x00, 0x86, 0x11);
    expect(decodeId(bytes, 2)).toEqual({ id: 0x86, length: 1 });
  });

  it("rejects IDs longer than four bytes and truncated input", () => {
    expect(() => decodeId(Uint8Array.of(0x08, 1, 2, 3, 4))).toThrow(EbmlError);
    expect(() => decodeId(Uint8Array.of(0x1f, 0x43))).toThrow(/truncated/);
    expect(() => decodeId(new Uint8Array(0))).toThrow(EbmlError);
  });

  it("formats ids the way the spec writes them", () => {
    expect(formatId(0x1f43b675)).toBe("0x1F43B675");
  });
});

describe("decodeVint", () => {
  it("strips the marker bit", () => {
    expect(decodeVint(Uint8Array.of(0x81))).toEqual({
      value: 1,
      length: 1,
      unknown: false,
    });
    expect(decodeVint(Uint8Array.of(0xbf))).toEqual({
      value: 0x3f,
      length: 1,
      unknown: false,
    });
    expect(decodeVint(Uint8Array.of(0x40, 0x7f))).toEqual({
      value: 127,
      length: 2,
      unknown: false,
    });
    expect(decodeVint(Uint8Array.of(0x20, 0x00, 0x80))).toEqual({
      value: 128,
      length: 3,
      unknown: false,
    });
  });

  it("round-trips values through the test encoder", () => {
    for (const value of [0, 1, 126, 127, 128, 16383, 16384, 1_000_000, 2 ** 40]) {
      const encoded = vint(value);
      const decoded = decodeVint(encoded);
      expect(decoded.unknown).toBe(false);
      expect(decoded.value).toBe(value);
      expect(decoded.length).toBe(encoded.length);
    }
  });

  it("recognises every unknown-size encoding", () => {
    expect(decodeVint(Uint8Array.of(0xff))).toEqual({
      value: 0,
      length: 1,
      unknown: true,
    });
    expect(decodeVint(Uint8Array.of(0x7f, 0xff))).toEqual({
      value: 0,
      length: 2,
      unknown: true,
    });
    // The 8-byte form mkvmerge writes for live/streamed Segments and Clusters.
    expect(
      decodeVint(
        Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
      ),
    ).toEqual({ value: 0, length: 8, unknown: true });
  });

  it("does not mistake a nearly-full value for unknown", () => {
    const almost = decodeVint(
      Uint8Array.of(0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe),
    );
    expect(almost.unknown).toBe(false);
    expect(almost.value).toBe(2 ** 48 - 2);
  });

  it("refuses values that JavaScript cannot represent exactly", () => {
    expect(() =>
      decodeVint(Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe)),
    ).toThrow(/MAX_SAFE_INTEGER/);
  });

  it("rejects invalid and truncated vints", () => {
    expect(() => decodeVint(Uint8Array.of(0x00, 0, 0, 0, 0, 0, 0, 0, 1))).toThrow(
      EbmlError,
    );
    expect(() => decodeVint(Uint8Array.of(0x40))).toThrow(/truncated/);
  });
});

describe("decodeSignedVint", () => {
  it("applies the EBML lacing bias", () => {
    // 1-byte signed vints span -63..64 with a bias of 2^6 - 1.
    expect(decodeSignedVint(Uint8Array.of(0x80)).value).toBe(-63);
    expect(decodeSignedVint(Uint8Array.of(0xbf)).value).toBe(0);
    expect(decodeSignedVint(Uint8Array.of(0xc0)).value).toBe(1);
    // 2-byte: bias 2^13 - 1.
    expect(decodeSignedVint(Uint8Array.of(0x5f, 0xff)).value).toBe(0);
  });
});

describe("readUintBE", () => {
  it("reads big-endian integers wider than 32 bits", () => {
    expect(readUintBE(Uint8Array.of(0x0f, 0x42, 0x40), 0, 3)).toBe(1_000_000);
    expect(readUintBE(Uint8Array.of(0x01, 0x00, 0x00, 0x00, 0x00), 0, 5)).toBe(
      2 ** 32,
    );
  });
});

describe("iterateElements", () => {
  it("walks a master element and reports absolute offsets", () => {
    const payload = concat([
      element(0xd7, Uint8Array.of(3)),
      element(0x86, Uint8Array.from(Buffer.from("S_HDMV/PGS", "ascii"))),
    ]);
    const seen = [...iterateElements(payload, 1000)];
    expect(seen.map((s) => s.element.id)).toEqual([0xd7, 0x86]);
    expect(seen[0]!.element.headerOffset).toBe(1000);
    expect(seen[0]!.element.dataOffset).toBe(1002);
    expect(elementEnd(seen[0]!.element)).toBe(1003);
    expect(Buffer.from(seen[1]!.data).toString("ascii")).toBe("S_HDMV/PGS");
  });

  it("rejects a child that overruns its parent", () => {
    const bad = Uint8Array.of(0xd7, 0x8a, 1, 2);
    expect(() => [...iterateElements(bad)]).toThrow(/overruns/);
  });
});

describe("EbmlReader", () => {
  let dir: string;
  let path: string;
  const bigPayload = new Uint8Array(1_000_000).fill(0xab);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scope-sub-ebml-"));
    path = join(dir, "synthetic.ebml");
    writeFileSync(
      path,
      concat([
        element(0x1a45dfa3, Uint8Array.of(1, 2, 3, 4)),
        // A big element to be skipped, then a small one to be read.
        element(0xa3, bigPayload),
        element(0xd7, Uint8Array.of(0x2a)),
        element(0xa3, bigPayload),
        element(0x86, Uint8Array.from(Buffer.from("tail", "ascii"))),
      ]),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads element headers, skips payloads, and stays cheap", async () => {
    const reader = await EbmlReader.open(path, { strategy: "adaptive" });
    try {
      const ids: number[] = [];
      let tail = "";
      let smallValue = -1;
      while (!reader.eof) {
        const el = await reader.readElement();
        if (!el) break;
        ids.push(el.id);
        if (el.id === 0xd7) smallValue = await reader.readUint(el.size);
        else if (el.id === 0x86) tail = await reader.readString(el.size);
        else await reader.skip(el.size);
      }
      expect(ids).toEqual([0x1a45dfa3, 0xa3, 0xd7, 0xa3, 0x86]);
      expect(smallValue).toBe(0x2a);
      expect(tail).toBe("tail");
      // Two million bytes of payload were never transferred.
      expect(reader.stats.bytesSkipped).toBeGreaterThan(1_900_000);
      expect(reader.stats.bytesRead).toBeLessThan(100_000);
      expect(reader.stats.readRatio).toBeLessThan(0.05);
      expect(reader.stats.fileSize).toBe(reader.fileSize);
    } finally {
      await reader.close();
    }
  });

  it("serves sequential small reads out of one buffered chunk", async () => {
    const reader = await EbmlReader.open(path, { strategy: "adaptive" });
    try {
      const first = await reader.readBytes(4);
      const callsAfterFirst = reader.stats.readCalls;
      for (let i = 0; i < 100; i++) await reader.readBytes(4);
      expect(first.length).toBe(4);
      expect(reader.stats.readCalls).toBe(callsAfterFirst);
    } finally {
      await reader.close();
    }
  });

  it("seeks backwards and forwards", async () => {
    const reader = await EbmlReader.open(path);
    try {
      const head = await reader.readBytes(4);
      reader.seek(0);
      expect([...(await reader.readBytes(4))]).toEqual([...head]);
      reader.seek(reader.fileSize - 4);
      expect(Buffer.from(await reader.readBytes(4)).toString("ascii")).toBe("tail");
      expect(reader.eof).toBe(true);
    } finally {
      await reader.close();
    }
  });

  it("refuses to read past the end of the file", async () => {
    const reader = await EbmlReader.open(path);
    try {
      reader.seek(reader.fileSize - 2);
      await expect(reader.readBytes(10)).rejects.toThrow(/end of file/);
    } finally {
      await reader.close();
    }
  });

  it("reads oversized elements in one exact read, bypassing the buffer", async () => {
    const reader = await EbmlReader.open(path, { maxChunkSize: 4096, probeSize: 1024 });
    try {
      const el = await reader.readElement();
      await reader.skip(el!.size);
      const big = await reader.readElement();
      const bytes = await reader.readBytes(big!.size);
      expect(bytes.length).toBe(bigPayload.length);
      expect(bytes[0]).toBe(0xab);
      expect(bytes[bytes.length - 1]).toBe(0xab);
    } finally {
      await reader.close();
    }
  });

  it("trades transferred bytes for read() calls between strategies", async () => {
    const frugal = await EbmlReader.open(path, { strategy: "adaptive" });
    const streaming = await EbmlReader.open(path, { strategy: "sequential" });
    try {
      for (const reader of [frugal, streaming]) {
        while (!reader.eof) {
          const el = await reader.readElement();
          if (!el) break;
          await reader.skip(el.size);
        }
      }
      // The frugal reader never transfers the two big payloads...
      expect(frugal.stats.readRatio).toBeLessThan(0.05);
      expect(frugal.stats.seeks).toBeGreaterThan(0);
      // ...the streaming one pulls most of the file in, in a handful of reads
      // and with no seeks at all.
      expect(streaming.stats.readRatio).toBeGreaterThan(0.4);
      expect(streaming.stats.bytesRead).toBeGreaterThan(frugal.stats.bytesRead * 5);
      expect(streaming.stats.seeks).toBe(0);
      expect(streaming.stats.readCalls).toBeLessThan(frugal.stats.readCalls);
      expect(streaming.stats.strategy).toBe("sequential");
    } finally {
      await frugal.close();
      await streaming.close();
    }
  });

  it("reads through skips that land just past the buffer", async () => {
    // readThroughBytes covers the 1 MB elements, so nothing counts as a seek.
    const reader = await EbmlReader.open(path, {
      strategy: "adaptive",
      readThroughBytes: 2_000_000,
    });
    try {
      while (!reader.eof) {
        const el = await reader.readElement();
        if (!el) break;
        await reader.skip(el.size);
      }
      expect(reader.stats.seeks).toBe(0);
      // Reading through only means "keep the chunk size up"; the skipped bytes
      // themselves are still never transferred.
      expect(reader.stats.bytesSkipped).toBeGreaterThan(1_500_000);
      expect(reader.stats.readRatio).toBeLessThan(0.5);
    } finally {
      await reader.close();
    }
  });
});
