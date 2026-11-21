import { describe, expect, it } from "vitest";
import {
  activeAreaFromAspect,
  clusterBars,
  isUsableArea,
  narrowestRepeatedShape,
  type ActiveAreaCluster,
  defaultTolerance,
  detectActiveArea,
  absorbOneOffs,
  FrameSampleError,
  pictureBox,
  roundAspect,
  sampleTimestamps,
  type FrameSampler,
} from "../../src/video/activeArea.js";

/** A sampler stub that answers with a picture box chosen per timestamp. */
function stubRunner(
  pick: (timestampMs: number) => { w: number; h: number; x: number; y: number } | null,
): FrameSampler {
  return async (_file, timestampMs) => {
    const crop = pick(timestampMs);
    return crop
      ? { top: crop.y, bottom: crop.y + crop.h, left: crop.x, right: crop.x + crop.w }
      : null;
  };
}

describe("activeAreaFromAspect (PRD §8)", () => {
  it("computes the 1920x1080 2.39:1 case from the PRD", () => {
    const a = activeAreaFromAspect(1920, 1080, 2.39);
    expect(a).toMatchObject({
      top: 138,
      bottom: 941,
      left: 0,
      right: 1920,
      source: "manual",
      classification: "CONSTANT",
    });
    expect(a.bottom - a.top).toBe(803);
    expect(a.aspect).toBe(2.39);
  });

  it("computes the 3840x2160 2.39:1 case", () => {
    const a = activeAreaFromAspect(3840, 2160, 2.39);
    expect(a.bottom - a.top).toBe(1607);
    expect(a.top).toBe(276);
  });

  it("returns the full frame when the aspect matches the frame", () => {
    const a = activeAreaFromAspect(1920, 1080, 16 / 9);
    expect(a.top).toBe(0);
    expect(a.bottom).toBe(1080);
    expect(a.notes).toHaveLength(0);
  });

  it("returns the full frame and notes it when the aspect is narrower", () => {
    const a = activeAreaFromAspect(1920, 1080, 1.33);
    expect(a.top).toBe(0);
    expect(a.bottom).toBe(1080);
    expect(a.notes.join(" ")).toMatch(/wider than the frame/);
  });

  it("rejects nonsense input", () => {
    expect(() => activeAreaFromAspect(0, 1080, 2.39)).toThrow(RangeError);
    expect(() => activeAreaFromAspect(1920, 1080, 0)).toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("rounds the aspect to two decimals", () => {
    expect(roundAspect(1920, 804)).toBe(2.39);
    expect(roundAspect(1920, 1080)).toBe(1.78);
  });

  it("spreads samples between 5% and 95% of the duration", () => {
    const ts = sampleTimestamps(100000, 5);
    expect(ts[0]).toBe(5000);
    expect(ts.at(-1)).toBe(95000);
    expect(ts).toHaveLength(5);
    expect(sampleTimestamps(100000, 1)).toEqual([50000]);
  });

  it("scales the default tolerance with frame height", () => {
    expect(defaultTolerance(1080)).toBe(4);
    expect(defaultTolerance(2160)).toBe(8);
  });

  it("clusters within tolerance and keeps the largest active area", () => {
    const clusters = clusterBars(
      [
        { top: 138, bottom: 942, left: 0, right: 1920, timestampMs: 1 },
        { top: 140, bottom: 940, left: 0, right: 1920, timestampMs: 2 },
        { top: 0, bottom: 1080, left: 0, right: 1920, timestampMs: 3 },
      ],
      4,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ top: 138, bottom: 942, count: 2 });
    expect(clusters[1]).toMatchObject({ top: 0, bottom: 1080, count: 1 });
  });
});

describe("detectActiveArea", () => {
  const base = { durationMs: 120000, frameW: 1920, frameH: 1080, samples: 10 };

  it("stops sampling once its signal is aborted", async () => {
    const controller = new AbortController();
    const inner = stubRunner(() => ({ w: 1920, h: 804, x: 0, y: 138 }));
    let runs = 0;
    await expect(
      detectActiveArea("x.mkv", {
        ...base,
        concurrency: 1,
        signal: controller.signal,
        sampler: async (f, t) => {
          if (++runs === 3) controller.abort();
          return inner(f, t);
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(runs).toBe(3);

    await expect(
      detectActiveArea("x.mkv", { ...base, signal: AbortSignal.abort(), sampler: inner }),
    ).rejects.toThrow("cancelled");
  });

  it("classifies a stable letterbox as CONSTANT", async () => {
    const a = await detectActiveArea("x.mkv", {
      ...base,
      sampler: stubRunner(() => ({ w: 1920, h: 804, x: 0, y: 138 })),
    });
    expect(a.classification).toBe("CONSTANT");
    expect(a.source).toBe("auto");
    expect(a.top).toBe(138);
    expect(a.bottom).toBe(942);
    expect(a.aspect).toBe(2.39);
    expect(a.samples?.every((s) => s.used)).toBe(true);
  });

  it("tolerates a minority of outliers", async () => {
    let n = 0;
    const a = await detectActiveArea("x.mkv", {
      ...base,
      sampler: stubRunner(() =>
        n++ === 0 ? { w: 1920, h: 1080, x: 0, y: 0 } : { w: 1920, h: 804, x: 0, y: 138 },
      ),
    });
    expect(a.classification).toBe("CONSTANT");
    expect(a.top).toBe(138);
  });

  it("takes the largest picture two samples agree on, not the modal one", async () => {
    // A 2.35:1 film (y=131..949) whose scenes are mostly dark at the edges, so
    // the measurement trims ~9 rows off each: 8 samples say 140..940, 2 bright ones
    // say 131..949. The bright pair is the truth.
    let n = 0;
    const a = await detectActiveArea("x.mkv", {
      ...base,
      sampler: stubRunner(() =>
        n++ < 2 ? { w: 1920, h: 818, x: 0, y: 131 } : { w: 1920, h: 800, x: 0, y: 140 },
      ),
    });
    expect(a.classification).toBe("CONSTANT");
    expect(a.top).toBe(131);
    expect(a.bottom).toBe(949);
    expect(a.aspect).toBe(2.35);
    // The diagnostics show both numbers.
    expect(a.estimate?.modal).toEqual({ top: 140, bottom: 940 });
    expect(a.estimate?.chosen).toEqual({ top: 131, bottom: 949 });
    expect(a.estimate?.tops).toEqual([
      { value: 131, count: 2 },
      { value: 140, count: 8 },
    ]);
    expect(a.estimate?.bottoms).toEqual([
      { value: 949, count: 2 },
      { value: 940, count: 8 },
    ]);
    expect(a.notes.join(" ")).toMatch(/widest repeated samples/);
  });

  it("ignores a lone outlier that no other sample repeats", async () => {
    // One frame with a garbage line at the very top; every other sample agrees
    // on 140..940, so the one-off is not believed.
    let n = 0;
    const a = await detectActiveArea("x.mkv", {
      ...base,
      sampler: stubRunner(() =>
        n++ === 0 ? { w: 1920, h: 900, x: 0, y: 90 } : { w: 1920, h: 800, x: 0, y: 140 },
      ),
    });
    expect(a.classification).toBe("CONSTANT");
    expect(a.top).toBe(140);
    expect(a.bottom).toBe(940);
    expect(a.estimate?.modal).toEqual({ top: 140, bottom: 940 });
    expect(a.estimate?.chosen).toEqual({ top: 140, bottom: 940 });
    // The diagnostics list the edges the choice was made among: those near
    // the modal shape. The one-off is another shape's, and not among them.
    // (Ten samples, and nine more once a second shape was in sight.)
    expect(a.estimate?.tops).toEqual([{ value: 140, count: 18 }]);
    expect(a.notes.join(" ")).not.toMatch(/widest repeated samples/);
  });

  it("falls back to the modal cluster when no value repeats", async () => {
    // Every sample differs by more than the tolerance: nothing to believe
    // twice, so the modal cluster's own smallest bars stand, as before.
    let n = 0;
    const a = await detectActiveArea("x.mkv", {
      ...base,
      samples: 3,
      tolerancePx: 1,
      sampler: stubRunner(() => {
        const y = 140 + n++ * 10;
        return { w: 1920, h: 1080 - 2 * y, x: 0, y };
      }),
    });
    expect(a.estimate?.chosen).toEqual(a.estimate?.modal);
  });

  it("judges a title that alternates between two repeated shapes by the narrowest", async () => {
    // Scope for two thirds of the film, full frame for the rest.
    const a = await detectActiveArea("x.mkv", {
      ...base,
      samples: 24,
      sampler: stubRunner((t) =>
        t < 80000 ? { w: 1920, h: 804, x: 0, y: 138 } : { w: 1920, h: 1080, x: 0, y: 0 },
      ),
    });
    expect(a.classification).toBe("MIXED_NARROWEST");
    expect(isUsableArea(a)).toBe(true);
    expect({ top: a.top, bottom: a.bottom }).toEqual({ top: 138, bottom: 942 });
    expect(a.clusters).toHaveLength(2);
    expect(a.notes.some((n) => n.startsWith("aspect ratio varies between scenes"))).toBe(true);
    // The timestamps each cluster was seen at are reported.
    expect(a.clusters![0]!.timestampsMs.length).toBeGreaterThan(0);
  });

  it("classifies an active area that changes without a pattern as MIXED_ASPECT_RATIO", async () => {
    // Full frame, then a bar at the bottom only, then one at the top only,
    // each for a third of the film: repeated shapes, none a letterbox.
    const a = await detectActiveArea("x.mkv", {
      ...base,
      samples: 24,
      sampler: stubRunner((t) =>
        t < 40000
          ? { w: 1920, h: 1080, x: 0, y: 0 }
          : t < 80000
            ? { w: 1920, h: 700, x: 0, y: 100 }
            : { w: 1920, h: 700, x: 0, y: 280 },
      ),
    });
    expect(a.classification).toBe("MIXED_ASPECT_RATIO");
    expect(isUsableArea(a)).toBe(false);
    expect({ top: a.top, bottom: a.bottom }).toEqual({ top: 0, bottom: 1080 });
    expect(a.notes.join(" ")).toMatch(/active area changes/);
  });

  it("discards all-black frames", async () => {
    const a = await detectActiveArea("x.mkv", {
      ...base,
      sampler: stubRunner((t) =>
        t < 30000 ? { w: 100, h: 20, x: 0, y: 530 } : { w: 1920, h: 804, x: 0, y: 138 },
      ),
    });
    expect(a.classification).toBe("CONSTANT");
    const discarded = a.samples!.filter((s) => !s.used);
    expect(discarded.length).toBeGreaterThan(0);
    expect(discarded[0]!.reason).toMatch(/all black/);
  });

  it("is UNKNOWN when samples disagree and there are too few of them", async () => {
    let n = 0;
    const a = await detectActiveArea("x.mkv", {
      ...base,
      // Three, and two more between them: five in all, under the minimum.
      samples: 3,
      sampler: stubRunner(() =>
        n++ % 2 === 0 ? { w: 1920, h: 804, x: 0, y: 138 } : { w: 1920, h: 1080, x: 0, y: 0 },
      ),
    });
    expect(a.classification).toBe("UNKNOWN");
    expect(a.notes.join(" ")).toMatch(/undetermined/);
  });

  it("is UNKNOWN when nothing can be sampled", async () => {
    const a = await detectActiveArea("x.mkv", {
      ...base,
      sampler: stubRunner(() => null),
    });
    expect(a.classification).toBe("UNKNOWN");
    expect(a.notes.join(" ")).toMatch(/no usable picture samples/);
  });

  it("is UNKNOWN without a duration", async () => {
    const a = await detectActiveArea("x.mkv", {
      ...base,
      durationMs: 0,
      sampler: stubRunner(() => ({ w: 1920, h: 804, x: 0, y: 138 })),
    });
    expect(a.classification).toBe("UNKNOWN");
  });

  it("reports pillarbox but keeps the active area full-width", async () => {
    const a = await detectActiveArea("x.mkv", {
      ...base,
      sampler: stubRunner(() => ({ w: 1440, h: 1080, x: 240, y: 0 })),
    });
    expect(a.left).toBe(0);
    expect(a.right).toBe(1920);
    expect(a.pillarbox).toMatchObject({ left: 240, right: 1680 });
    expect(a.notes.join(" ")).toMatch(/pillarbox detected/);
  });

  it("samples once per timestamp, and once more between them only when shapes differ", async () => {
    let calls = 0;
    const scope = { top: 138, bottom: 942, left: 0, right: 1920 };
    await detectActiveArea("x.mkv", {
      ...base,
      samples: 7,
      sampler: async () => {
        calls++;
        return scope;
      },
    });
    expect(calls).toBe(7);

    calls = 0;
    const a = await detectActiveArea("x.mkv", {
      ...base,
      samples: 7,
      sampler: async (_f, t) => {
        calls++;
        return t > 100000 ? { top: 0, bottom: 1080, left: 0, right: 1920 } : scope;
      },
    });
    // Seven, then the six midpoints between them.
    expect(calls).toBe(13);
    expect(a.samples).toHaveLength(13);
    expect(a.notes.join(" ")).toMatch(/sampled 6 more frames/);
  });
});

describe("detectActiveArea when frames cannot be had", () => {
  const opts = { durationMs: 120000, frameW: 1920, frameH: 1080, samples: 10 };
  const scope = { top: 138, bottom: 942, left: 0, right: 1920 };

  it("throws when not one frame could be sampled: that is not a verdict", async () => {
    await expect(
      detectActiveArea("x.mkv", {
        ...opts,
        sampler: async () => {
          throw new FrameSampleError("ffmpeg gave no frame at 6 s: Connection reset");
        },
      }),
    ).rejects.toThrow(/could not be sampled: ffmpeg gave no frame at 6 s/);
  });

  it("goes on with the frames it has, and says how many it could not get", async () => {
    let n = 0;
    const a = await detectActiveArea("x.mkv", {
      ...opts,
      sampler: async () => {
        if (n++ % 5 === 0) throw new FrameSampleError("no frame");
        return scope;
      },
    });
    expect(a.classification).toBe("CONSTANT");
    expect(a.samples!.filter((s) => !s.used)).toHaveLength(2);
    expect(a.notes.join(" ")).toMatch(/2 of 10 frames could not be sampled/);
  });

  it("lets any other error through, and hands the sampler its signal", async () => {
    const controller = new AbortController();
    let got: AbortSignal | undefined;
    await detectActiveArea("x.mkv", {
      ...opts,
      signal: controller.signal,
      sampler: async (_f, _t, signal) => {
        got = signal;
        return scope;
      },
    });
    expect(got).toBe(controller.signal);
    await expect(
      detectActiveArea("x.mkv", {
        ...opts,
        sampler: async () => {
          throw new Error("ffmpeg is not installed");
        },
      }),
    ).rejects.toThrow("ffmpeg is not installed");
  });
});

describe("pictureBox: the picture in one frame, from its pixels", () => {
  /** A 16-bit grey frame: `bar` everywhere, `level(x, y)` inside the rows given. */
  const frame = (
    w: number,
    h: number,
    top: number,
    bottom: number,
    level: (x: number, y: number) => number,
    bar = 0.01,
  ): Uint8Array => {
    const out = new Uint8Array(w * h * 2);
    const view = new DataView(out.buffer);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = y >= top && y < bottom ? level(x, y) : bar;
        view.setUint16((y * w + x) * 2, Math.round(v * 65535), true);
      }
    }
    return out;
  };

  it("finds the rows of a bright letterboxed picture", () => {
    expect(pictureBox(frame(192, 108, 14, 94, () => 0.5), 192, 108)).toEqual({ top: 14, bottom: 94, left: 0, right: 192 });
  });

  it("finds them in a dark scene too: grain in a few pixels of a row is enough", () => {
    // Nearly black picture, average far below any bar threshold, with one
    // pixel in twenty a little above black.
    const dark = frame(192, 108, 14, 94, (x, y) => ((x + y * 7) % 20 === 0 ? 0.09 : 0.02));
    expect(pictureBox(dark, 192, 108)).toEqual({ top: 14, bottom: 94, left: 0, right: 192 });
  });

  it("takes bars with compression noise for bars, and one stray pixel for nothing", () => {
    // Bars at 4% of full scale, as the worst measured on a Blu-ray.
    expect(pictureBox(frame(192, 108, 14, 94, () => 0.5, 0.04), 192, 108)).toMatchObject({ top: 14, bottom: 94 });
    const stray = frame(192, 108, 14, 94, () => 0.5);
    new DataView(stray.buffer).setUint16((3 * 192 + 50) * 2, 65535, true);
    expect(pictureBox(stray, 192, 108)).toMatchObject({ top: 14, bottom: 94 });
  });

  it("steps over something bright in a bar: a caption, a logo, a line of garbage at the edge", () => {
    // Full size, so the real thresholds apply: 4 pixels of a 1920 row.
    const W = 1920;
    const H = 1080;
    const base = (): Uint8Array => frame(W, H, 140, 940, () => 0.5);
    const paint = (f: Uint8Array, y0: number, y1: number, x0: number, x1: number, v = 0.9): Uint8Array => {
      const view = new DataView(f.buffer);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) view.setUint16((y * W + x) * 2, Math.round(v * 65535), true);
      return f;
    };
    expect(pictureBox(base(), W, H)).toEqual({ top: 140, bottom: 940, left: 0, right: W });
    // A burned-in caption in the lower bar, 20 rows below the picture.
    expect(pictureBox(paint(base(), 960, 1010, 700, 1220), W, H)).toMatchObject({ top: 140, bottom: 940 });
    // A garbage line on the first row, and a logo in the upper bar.
    expect(pictureBox(paint(paint(base(), 0, 1, 0, W), 40, 90, 1700, 1850), W, H)).toMatchObject({ top: 140, bottom: 940 });
    // Three bright pixels in a bar row are nothing; the picture's own first row is its edge.
    expect(pictureBox(paint(base(), 100, 101, 10, 13), W, H)).toMatchObject({ top: 140, bottom: 940 });
    // Picture all the way, with a black band deep inside it: not an island.
    const banded = paint(frame(W, H, 0, H, () => 0.5), 500, 560, 0, W, 0);
    expect(pictureBox(banded, W, H)).toMatchObject({ top: 0, bottom: H });
  });

  it("reads a UHD frame every second pixel and still finds the same rows", () => {
    // Dark picture: one pixel in fifty above black, on every row.
    const f = frame(3840, 2160, 280, 1880, (x) => (x % 50 === 0 ? 0.2 : 0.01));
    expect(pictureBox(f, 3840, 2160)).toMatchObject({ top: 280, bottom: 1880 });
  });

  it("reports pillarbox columns, and nothing for a black frame or a short buffer", () => {
    const pillar = frame(192, 108, 0, 108, (x) => (x >= 24 && x < 168 ? 0.4 : 0.01));
    expect(pictureBox(pillar, 192, 108)).toEqual({ top: 0, bottom: 108, left: 24, right: 168 });
    expect(pictureBox(frame(192, 108, 0, 0, () => 0.5), 192, 108)).toBeNull();
    expect(pictureBox(new Uint8Array(10), 192, 108)).toBeNull();
  });
});

describe("absorbOneOffs: a dark scene is evidence for the shape it lies inside", () => {
  const c = (top: number, bottom: number, count: number): ActiveAreaCluster => ({
    top, bottom, left: 0, right: 1920, count, timestampsMs: Array.from({ length: count }, (_, i) => top * 1000 + bottom + i),
  });

  it("counts a one-off towards the smallest repeated shape that contains it", () => {
    // A scope film with a little IMAX footage and dark scenes, measured coarsely.
    const seen = [c(140, 940, 9), c(0, 1080, 2), c(0, 632, 1), c(0, 814, 1), c(140, 820, 1), c(140, 762, 1), c(164, 878, 1), c(376, 920, 1)];
    const out = absorbOneOffs(seen, 4);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ top: 140, bottom: 940, count: 13, absorbed: 4 });
    expect(out[1]).toMatchObject({ top: 0, bottom: 1080, count: 4, absorbed: 2 });
    expect(out[0]!.timestampsMs).toHaveLength(13);
    // The input is not changed.
    expect(seen[0]!.count).toBe(9);
  });

  it("leaves a one-off that fits inside no repeated shape, and a repeated shape with bars on both sides", () => {
    const out = absorbOneOffs([c(138, 942, 13), c(274, 1080, 1), c(150, 900, 2)], 4);
    expect(out.map((x) => [x.top, x.bottom, x.count])).toEqual([[138, 942, 13], [150, 900, 2], [274, 1080, 1]]);
    expect(absorbOneOffs([c(0, 1080, 1), c(140, 940, 1)], 4)).toHaveLength(2);
    // Scope inside IMAX is the very thing to tell apart: never absorbed.
    expect(absorbOneOffs([c(0, 1080, 13), c(140, 940, 11)], 4)).toHaveLength(2);
  });

  it("counts a repeated shape cut short on one side only towards the shape it is cut from", () => {
    // Scope seen twice with a dark lower edge: the same top, a shorter bottom.
    const out = absorbOneOffs([c(138, 942, 13), c(138, 799, 2), c(0, 1080, 3)], 4);
    expect(out.map((x) => [x.top, x.bottom, x.count])).toEqual([[138, 942, 15], [0, 1080, 3]]);
    // Not when it is seen as often as the taller one: nothing says which is cut.
    expect(absorbOneOffs([c(0, 1080, 6), c(0, 804, 6)], 4)).toHaveLength(2);
  });
});

describe("detectActiveArea on the shapes real films showed", () => {
  const opts = { durationMs: 7200000, frameW: 1920, frameH: 1080 };
  const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 1920 });
  /** A sampler that answers from a list, in sample order, then repeats the last. */
  const film = (...shapes: [number, number, number][]) => {
    const list = shapes.flatMap(([top, bottom, n]) => Array.from({ length: n }, () => box(top, bottom)));
    // Spread them so each shape is met throughout the film, not in one block.
    const order = list.map((b, i) => ({ b, k: (i * 7) % list.length })).sort((x, y) => x.k - y.k).map((x) => x.b);
    let i = 0;
    return async () => order[i++ % order.length]!;
  };

  it("judges a scope film with a little IMAX footage by its scope shape, never as 'no bars'", async () => {
    // 20 scope, 4 full frame: over 80% agree, and the full-frame edge repeats.
    const a = await detectActiveArea("x.mkv", { ...opts, sampler: film([140, 940, 20], [0, 1080, 4]) });
    expect(a.classification).toBe("MIXED_NARROWEST");
    expect({ top: a.top, bottom: a.bottom }).toEqual({ top: 140, bottom: 940 });
  });

  it("is plain scope when the taller scenes are seen once, and dark scenes are not other shapes", async () => {
    // First Man: scope, one frame of the moon sequence, scope seen partly.
    const a = await detectActiveArea("x.mkv", {
      ...opts,
      sampler: film([138, 942, 40], [0, 1080, 1], [138, 799, 2], [138, 915, 2], [256, 1080, 1]),
    });
    expect(a.classification).toBe("CONSTANT");
    expect({ top: a.top, bottom: a.bottom }).toEqual({ top: 138, bottom: 942 });
  });

  it("is plain 'no bars' for a full-frame film with dark scenes", async () => {
    // Clue: full frame, and two frames dark at the edges.
    const a = await detectActiveArea("x.mkv", { ...opts, sampler: film([0, 1080, 44], [154, 914, 1], [20, 1080, 1]) });
    expect(a.classification).toBe("CONSTANT");
    expect({ top: a.top, bottom: a.bottom }).toEqual({ top: 0, bottom: 1080 });
  });

  it("still takes the widest repeated edge of one shape seen with dark edges", async () => {
    // (500) Days of Summer: really 131..948, most samples a few rows in.
    const a = await detectActiveArea("x.mkv", { ...opts, sampler: film([140, 940, 21], [131, 948, 3]) });
    expect(a.classification).toBe("CONSTANT");
    expect({ top: a.top, bottom: a.bottom }).toEqual({ top: 131, bottom: 948 });
  });

  it("leaves a taller film with scope scenes alone", async () => {
    // Dunkirk: full frame in the majority.
    const a = await detectActiveArea("x.mkv", { ...opts, sampler: film([0, 1080, 28], [104, 978, 19]) });
    expect(a.classification).toBe("MIXED_ASPECT_RATIO");
    expect({ top: a.top, bottom: a.bottom }).toEqual({ top: 0, bottom: 1080 });
  });
});

describe("narrowestRepeatedShape: which films with a changing picture have a shape to judge by", () => {
  const shapes = (...rows: [number, number, number][]): ActiveAreaCluster[] =>
    rows.map(([top, bottom, count]) => ({ top, bottom, left: 0, right: 3840, count, timestampsMs: [] }));
  // The tolerances a real run uses: 4 px at 1080 rows, 8 px at 2160.
  const uhd = (c: ActiveAreaCluster[], n = 24) => narrowestRepeatedShape(c, n, 2160, 8);
  const hd = (c: ActiveAreaCluster[], n = 24) => narrowestRepeatedShape(c, n, 1080, 4);

  // Shapes measured on real discs, 24 samples each.
  it("finds the scope shape of films with IMAX scenes", () => {
    expect(uhd(shapes([280, 1880, 13], [0, 2160, 11]))).toEqual({ top: 280, bottom: 1880 }); // Interstellar
    expect(uhd(shapes([276, 1884, 13], [68, 2092, 11]))).toEqual({ top: 276, bottom: 1884 }); // Top Gun: Maverick
    expect(uhd(shapes([208, 1952, 17], [0, 2160, 7]))).toEqual({ top: 208, bottom: 1952 }); // Oppenheimer
    // Three nested shapes give the narrowest.
    expect(hd(shapes([138, 942, 10], [60, 1020, 8], [0, 1080, 6]))).toEqual({ top: 138, bottom: 942 });
  });

  it("finds none in a film that is one shape plus odd samples", () => {
    const clue = shapes(
      [0, 1080, 16], [0, 1036, 1], [0, 962, 1], [0, 972, 1], [0, 990, 1],
      [26, 938, 1], [160, 910, 1], [222, 1002, 1], [266, 906, 1],
    );
    expect(hd(clue)).toBeUndefined();
    const commandments = shapes(
      [0, 1080, 18], [0, 944, 1], [0, 1038, 1], [0, 990, 1], [0, 1062, 1], [0, 632, 1], [124, 1080, 1],
    );
    expect(hd(commandments)).toBeUndefined();
  });

  it("refuses a taller film in which the narrow shape is the lesser one", () => {
    // A 16:9 documentary with letterboxed inserts; a 1.85 film with a scope
    // section; a 16:9 film whose dark scenes trim to the same rows; Clue with
    // six dark samples that happen to agree; a film in three ratios.
    expect(uhd(shapes([0, 2160, 16], [280, 1880, 8]))).toBeUndefined();
    expect(uhd(shapes([42, 2118, 16], [280, 1880, 8]))).toBeUndefined();
    expect(uhd(shapes([0, 2160, 17], [40, 2120, 7]))).toBeUndefined();
    expect(hd(shapes([0, 1080, 16], [30, 1050, 6], [0, 990, 1], [26, 938, 1]))).toBeUndefined();
    expect(hd(shapes([0, 1080, 12], [140, 940, 8], [22, 1058, 4]))).toBeUndefined();
    // Seen often enough to repeat, far too seldom to be the film's shape.
    expect(hd(shapes([0, 1080, 20], [138, 942, 4]))).toBeUndefined();
    // Half and half: nothing says the scope shape is the film's own.
    expect(hd(shapes([0, 1080, 12], [138, 942, 12]))).toBeUndefined();
    expect(hd(shapes([22, 1058, 12], [138, 942, 12]))).toBeUndefined();
  });

  it("refuses one shape seen with dark edges: nothing says which rows are the picture's", () => {
    expect(uhd(shapes([280, 1880, 10], [292, 1868, 14]))).toBeUndefined();
    expect(hd(shapes([131, 948, 7], [140, 940, 17]))).toBeUndefined();
    // Oppenheimer with its scope scenes split by a dark edge: left alone.
    expect(uhd(shapes([208, 1952, 11], [224, 1936, 6], [0, 2160, 7]))).toBeUndefined();
    // A taller shape, but by less than a real step on one side.
    expect(hd(shapes([138, 942, 14], [100, 1080, 10]))).toBeUndefined();
  });

  it("refuses shapes that are off-centre, without bars, too noisy, or from too few samples", () => {
    // Bars at the bottom only: not a letterbox.
    expect(hd(shapes([0, 804, 12], [0, 1080, 12]))).toBeUndefined();
    // Repeated shapes are under four fifths of the samples.
    expect(
      hd(shapes([138, 942, 9], [0, 1080, 9], [10, 500, 1], [20, 600, 1], [30, 700, 1], [40, 800, 1], [50, 900, 1], [60, 950, 1])),
    ).toBeUndefined();
    // Most of the film too dark to sample: 3 and 3 of 6 is not evidence.
    expect(hd(shapes([138, 942, 3], [0, 1080, 3]), 6)).toBeUndefined();
    expect(hd(shapes([138, 942, 6], [0, 1080, 5]), 11)).toBeUndefined();
    expect(hd(shapes([138, 942, 7], [0, 1080, 5]), 12)).toEqual({ top: 138, bottom: 942 });
  });
});
