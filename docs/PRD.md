# PRD: Scope Subtitle Fixer for MKV / PGS

**Status:** Draft  
**Target platform:** macOS first, with portable CLI design where practical  
**Primary use case:** Blu-ray / UHD Blu-ray MKV rips containing PGS (`S_HDMV/PGS`) subtitle tracks  
**Primary playback environment:** a Kodi-based player feeding a scope-screen home theater  
**Last updated:** 2026-09-02

> This is the original product spec, kept as written. Its wording predates the
> release: it says "repair" where the tool and its documentation now say "fix",
> and parts of it describe plans that changed along the way. The
> [CLI reference](cli.md) and the [changelog](../CHANGELOG.md) describe the tool
> as it is.

---

## 1. Summary

Build a safe, testable toolchain that identifies and optionally fixes Blu-ray PGS subtitles that are authored partly or fully inside the black letterbox bars of scope-format movies.

The core idea is to solve subtitle placement **at the source file level**, before playback, rather than using real-time HDMI-image analysis and inpainting.

For scope movies (typically about 2.35:1–2.40:1 encoded inside a 16:9 1920×1080 or 3840×2160 frame), some PGS subtitles are authored below or above the active movie image. On a constant-image-height scope screen, those subtitles may be clipped or invisible.

The desired repair is to **move only the PGS subtitle overlay coordinates** so the visible subtitle bitmap falls inside the active movie area. The underlying video, audio, subtitle bitmap graphics, timestamps, chapters, attachments, HDR/Dolby Vision data, and other streams should remain unchanged.

Development will proceed in deliberately conservative stages:

1. **Read-only analyzer:** scan MKV files and identify titles / subtitle events that would require relocation.
2. **Single-movie repair prototype:** fix one test MKV at a time and produce a separate output file.
3. **Validation phase:** confirm playback, subtitle placement, metadata preservation, and bitstream integrity.
4. **Batch tool:** only after the workflow is proven reliable, support directory-scale processing.

The initial implementation should reuse existing mature tools where they are strong, especially **MKVToolNix** for MKV inspection/extraction/remuxing and possibly **BDSup2Sub++** for PGS relocation. Custom code should be used where it provides materially better control, safety, observability, or performance.

---

## 2. Problem Statement

Blu-ray and UHD Blu-ray subtitles are commonly stored as PGS bitmap overlays. A PGS subtitle includes:

- presentation timestamps;
- bitmap objects;
- palette data;
- screen dimensions;
- composition information;
- object placement coordinates.

Because these subtitles are separate from the encoded video, they can theoretically be repositioned without re-encoding or modifying the movie image.

However, many discs place subtitles relative to the full 16:9 raster instead of the actual scope image. For example, a 1920×1080 encode containing a ~2.39:1 movie may have roughly 138 pixels of black bar above and below the active image. A lower subtitle may be positioned partially or entirely inside the bottom black bar.

On a scope screen using constant image height, the black bars are outside the visible screen area. Such subtitles can therefore be cropped off.

A video processor can solve this after the fact by detecting subtitle text in the final raster, removing it from the black bar, reconstructing the background, and compositing it elsewhere. That is universal but unnecessarily destructive when the source subtitle is already available as a separate PGS stream.

The preferred solution is therefore:

> Parse the separate PGS overlay, determine whether each subtitle event intersects the non-visible letterbox area, and move the PGS composition coordinates so the original bitmap is rendered completely inside the active picture.

---

## 3. Goals

### 3.1 Primary goals

The system must:

1. Detect MKV files containing PGS subtitles.
2. Determine whether each PGS subtitle event falls fully inside the active movie image.
3. Report files and subtitle events that require relocation.
4. Provide useful evidence for manual verification, including:
   - subtitle track;
   - language;
   - timestamp;
   - duration if available;
   - original bounding rectangle;
   - active image rectangle;
   - amount outside the active image;
   - proposed new position.
5. Perform all scanning in a **strictly read-only** manner.
6. Repair a single movie by relocating affected PGS subtitles.
7. Avoid modifying video or audio bitstreams.
8. Preserve MKV metadata and track characteristics as faithfully as possible.
9. Never overwrite the source MKV during the prototype stages.
10. Make the repair deterministic and reproducible.
11. Support both 1080p Blu-ray and 2160p UHD Blu-ray sources.
12. Eventually support safe batch processing of a directory tree.

### 3.2 Secondary goals

The system should:

- support multiple PGS tracks per MKV;
- support forced subtitle tracks;
- handle top-positioned as well as bottom-positioned subtitles;
- retain intentional horizontal placement;
- distinguish between subtitles already safely inside the image and those that actually need moving;
- generate machine-readable reports suitable for later batch decisions;
- avoid changing subtitle graphics unless absolutely necessary;
- support dry-run behavior at every stage.

---

## 4. Non-Goals

The initial versions will **not** attempt to:

- OCR PGS subtitles into SRT/ASS;
- modify burned-in subtitles;
- move text subtitle formats such as SRT/ASS unless added later;
- re-encode video;
- crop the video frame;
- automatically alter projector or Kodi settings;
- dynamically reposition subtitles during playback;
- solve mixed-aspect-ratio movies perfectly in the first version;
- infer artistic intent beyond keeping subtitles visible;
- permanently overwrite originals;
- modify files in-place (later relaxed at the owner's request for one explicit,
  opt-in mode, `apply --dangerously-in-place`, which writes a reviewed plan's
  byte patches into the inputs with no backup; see the README).

Mixed-AR / IMAX titles were out of scope for automated modification in the first version. Since 0.5.0 one case is handled: a film that alternates between clear, repeated, nested shapes, the narrowest seen more often than any other, is judged by that narrowest shape (`MIXED_NARROWEST`; see `docs/cli.md` and `narrowestRepeatedShape`). Every other changing picture is still never modified.

---

## 5. Guiding Principles

### 5.1 Safety first

No prototype command should overwrite a source MKV.

The analyzer must never invoke a command capable of mutating the media library.

The repair tool must write to a separate output path.

### 5.2 Prefer stream-level changes

The preferred repair is coordinate-only modification of PGS composition information.

Bitmap rescaling, OCR, image reconstruction, or video processing should not occur unless proven necessary.

### 5.3 Reuse mature container tooling

MKV container manipulation is complicated and easy to get subtly wrong. MKVToolNix should be preferred for:

- track discovery;
- extraction;
- remuxing;
- chapter handling;
- tags;
- attachments;
- track metadata;
- container reconstruction.

### 5.4 Custom code for observability

The analyzer should expose exactly what is happening at the PGS-event level. This favors a small custom PGS parser or a well-understood open-source parsing library over treating BDSup2Sub++ as an opaque transformation.

### 5.5 Progressive rollout

Do not build batch modification first.

The implementation order is deliberately:

**inspect → understand → repair one → verify → batch**

---

## 6. Relevant Existing Tools

### 6.1 MKVToolNix

Use MKVToolNix as the default MKV container interface.

Relevant commands include:

- `mkvmerge -J` / JSON identification;
- `mkvextract`;
- `mkvmerge`;
- possibly `mkvinfo` for debugging.

Current MKVToolNix documentation publishes a versioned JSON identification schema, making machine-readable track inspection a reasonable dependency.

Reference:

- https://mkvtoolnix.download/doc/
- https://mkvtoolnix.download/doc/mkvmerge.html
- https://mkvtoolnix.download/doc/mkvextract.html

### 6.2 BDSup2Sub / BDSup2Sub++

BDSup2Sub was specifically designed for image-based subtitle streams and supports global caption movement.

Its documented capabilities include:

- editing position of captions;
- command-line operation;
- moving captions inside or outside a defined picture area;
- Blu-ray SUP input/output.

The “move inside” behavior was explicitly designed for cases such as using a 21:9 screen without losing subtitles.

BDSup2Sub++ exposes CLI options including:

- `--move-in-ratio`
- `--move-out-ratio`
- `--move-y-origin`
- `--move-y-offset`
- `--move-x`

References:

- https://github.com/amichaelt/BDSup2SubPlusPlus
- https://github.com/amichaelt/BDSup2SubPlusPlus/blob/master/src/help.htm
- https://forum.doom9.org/showthread.php?t=167051

### 6.3 PGS parser libraries / references

A custom analyzer does not necessarily need to implement the entire PGS format from zero.

Potential references or starting points include:

- `pgs-parser` — TypeScript/JavaScript PGS parser:
  - https://github.com/killergerbah/pgs-parser
- OxideAV Blu-ray PGS parser:
  - https://github.com/OxideAV/oxideav-bluray

The PGS format contains presentation composition segments, window definitions, palettes, object definitions, and timestamps. The analyzer primarily needs enough information to reconstruct each displayed subtitle object's effective bounding rectangle and timing.

---

## 7. Product Architecture

The project should initially be split into three logical components.

### 7.1 MKV Inspector

Responsibilities:

- enumerate MKV tracks;
- find video track;
- find PGS subtitle tracks;
- read track language/name/default/forced metadata;
- determine encoded frame dimensions;
- extract PGS streams to temporary storage when deeper inspection is required.

Recommended implementation:

- call `mkvmerge -J <file>`;
- parse JSON;
- call `mkvextract` only when a PGS stream must be inspected.

### 7.2 PGS Analyzer / Transformer

Responsibilities:

- parse SUP/PGS segments;
- reconstruct presentation events;
- identify visible bitmap bounds;
- determine original X/Y placement;
- calculate whether the subtitle is inside the active image rectangle;
- calculate a corrected position;
- optionally rewrite placement coordinates.

For Phase 1, only parsing is required.

For Phase 2, two implementation paths should be tested:

#### Option A — BDSup2Sub++ transformation

Pipeline:

1. extract PGS track;
2. invoke BDSup2Sub++ with `--move-in-ratio`;
3. create corrected SUP;
4. remux corrected subtitle track into a new MKV.

Advantages:

- proven feature;
- minimal custom binary-format writing;
- fast prototype;
- behavior explicitly intended for 21:9 screens.

Risks:

- old codebase;
- possible differences between 1080p and UHD PGS behavior;
- may reserialize/re-encode PGS objects rather than only changing composition coordinates;
- less exact control over deciding *which* events should move;
- behavior needs empirical verification.

#### Option B — custom PGS coordinate rewriting

Pipeline:

1. extract PGS track;
2. parse PGS display sets;
3. identify composition objects outside the active rectangle;
4. update only composition object X/Y positions where required;
5. preserve bitmap object payloads and palette data where possible;
6. write corrected SUP;
7. remux with MKVToolNix.

Advantages:

- exact control;
- event-by-event decisions;
- can leave already-correct subtitles untouched;
- easier to implement sophisticated policies;
- potentially minimal byte changes.

Risks:

- higher implementation effort;
- PGS composition/window semantics must be handled correctly;
- multiple objects and windows can be non-trivial;
- malformed/unusual PGS streams must fail safely.

### 7.3 MKV Rebuilder

Responsibilities:

- build a new MKV containing all original streams;
- substitute corrected PGS stream(s);
- preserve metadata;
- write to separate destination;
- validate output.

Recommended implementation:

- MKVToolNix rather than custom Matroska writing.

---

## 8. Determining the Active Movie Area

This is the most important analysis input.

For a constant-scope title, the active movie area can be represented as:

```text
frame_width
frame_height
active_top
active_bottom
active_left
active_right
```

For the common case of a horizontally centered scope image inside a 16:9 frame:

```text
active_left  = 0
active_right = frame_width
active_height = round(frame_width / movie_aspect_ratio)
active_top    = floor((frame_height - active_height) / 2)
active_bottom = active_top + active_height
```

Example for 1920×1080 at 2.39:1:

```text
active_height ≈ 803
top bar ≈ 138 px
bottom bar ≈ 139 px
```

### 8.1 Phase 1 active-area strategy

The initial analyzer should support a manually specified target aspect ratio:

```bash
scope-sub scan /Movies/Test \
  --aspect 2.39
```

This is deterministic and avoids premature video-image analysis.

### 8.2 Automatic aspect detection

A later enhancement may use:

- container/video metadata when reliable;
- FFmpeg crop detection against sampled frames;
- custom luminance/border analysis;
- Dolby Vision active-area metadata where available.

However, automatic detection must not be required to validate the PGS workflow.

### 8.3 Mixed-aspect titles

If sampled video analysis indicates materially changing active boundaries, classify the movie as:

```text
MIXED_ASPECT_RATIO
```

Do not automatically modify it in early versions. (Since 0.5.0: unless it alternates between clear, repeated, nested shapes with the narrowest seen most, in which case it is classified `MIXED_NARROWEST` and judged by that shape; see `docs/cli.md`.)

---

## 9. Subtitle Geometry

For each displayed PGS event, derive an effective visible rectangle:

```text
subtitle_left
subtitle_top
subtitle_right
subtitle_bottom
```

The rectangle should ideally represent the actual visible bitmap pixels, not merely a large transparent canvas.

Where the object bitmap includes transparent margins, the parser may need to calculate an alpha-aware visible-pixel bounding box.

An event requires fixing if:

```text
subtitle_top < active_top
OR
subtitle_bottom > active_bottom
OR
subtitle_left < active_left
OR
subtitle_right > active_right
```

For the initial scope use case, vertical overflow is the primary concern.

### 9.1 Severity

Report:

```text
outside_top_px
outside_bottom_px
outside_left_px
outside_right_px
outside_area_percent
```

Optional classification:

- `SAFE`
- `TOUCHING_BOUNDARY`
- `PARTIALLY_OUTSIDE`
- `FULLY_OUTSIDE`
- `AMBIGUOUS`

---

## 10. Relocation Policy

The repair should preserve the subtitle's intended placement as much as possible.

### 10.1 Bottom subtitle

If:

```text
subtitle_bottom > active_bottom
```

move vertically upward by the minimum amount necessary to place the visible subtitle fully inside the active image, plus an optional safe margin.

```text
new_bottom = active_bottom - margin
new_y = original_y - (subtitle_bottom - new_bottom)
```

### 10.2 Top subtitle

If:

```text
subtitle_top < active_top
```

move downward by the minimum amount necessary.

### 10.3 Subtitles already inside

Do not move them.

This is a preferred behavior over blindly relocating all lower subtitles to one fixed baseline.

### 10.4 Margin

Default:

```text
margin = 0
```

Optional later configuration:

```bash
--safe-margin-px 16
```

or resolution-normalized behavior.

### 10.5 Horizontal coordinates

Preserve original X position unless the object is actually outside the active horizontal bounds.

This matters for intentional positioning of:

- signs;
- speaker labels;
- off-center dialog;
- multiple simultaneous subtitle objects.

---

# 11. Phase 1 — Read-Only Analyzer

## 11.1 Objective

Build a tool that recursively or non-recursively examines a directory of MKVs and identifies which files contain PGS subtitle events that would fall outside the configured scope viewing area.

This phase must be **completely read-only**.

## 11.2 Safety requirement

The analyzer MUST NOT:

- call `mkvmerge` in output/remux mode;
- call `mkvpropedit`;
- rename media files;
- delete files;
- write adjacent metadata files unless explicitly requested;
- update timestamps on source MKVs.

Temporary PGS extraction is permitted only to an OS temp directory or explicitly supplied scratch path.

Source MKVs must be opened read-only.

## 11.3 Example CLI

```bash
scope-sub scan /Movies/Test --aspect 2.39
```

Single file:

```bash
scope-sub scan "/Movies/Test/Movie.mkv" --aspect 2.39
```

JSON output:

```bash
scope-sub scan /Movies/Test \
  --aspect 2.39 \
  --format json
```

Verbose event reporting:

```bash
scope-sub scan /Movies/Test \
  --aspect 2.39 \
  --show-events
```

## 11.4 Human-readable output

Example:

```text
Movie Name (2024).mkv
  Video: 3840x2160
  Target active area: y=277..1883 (2.39:1)

  PGS #4  eng  "English"
    Status: NEEDS_FIX
    17 offending events of 1,204

    00:12:44.382
      original: x=1022 y=1888 w=1795 h=156
      visible bottom: 2044
      active bottom: 1883
      overflow: 161 px
      proposed y: 1727

    01:03:17.091
      original: x=1134 y=1842 w=1560 h=131
      overflow: 90 px
      proposed y: 1752

  PGS #5  eng  "English forced"
    Status: OK
```

## 11.5 Summary output

```text
Scanned:           57 MKVs
With PGS:          53
Need repair:       19
Already safe:      34
Mixed/ambiguous:    2
Errors:             0
```

## 11.6 Machine-readable report

Schema concept:

```json
{
  "file": "/Movies/Movie.mkv",
  "video": {
    "width": 3840,
    "height": 2160,
    "target_aspect_ratio": 2.39,
    "active_rect": {
      "x": 0,
      "y": 277,
      "width": 3840,
      "height": 1606
    }
  },
  "subtitle_tracks": [
    {
      "track_id": 4,
      "codec": "S_HDMV/PGS",
      "language": "eng",
      "name": "English",
      "event_count": 1204,
      "offending_event_count": 17,
      "events": [
        {
          "timestamp": "00:12:44.382",
          "pts_ms": 764382,
          "original_rect": {
            "x": 1022,
            "y": 1888,
            "width": 1795,
            "height": 156
          },
          "overflow": {
            "top": 0,
            "bottom": 161,
            "left": 0,
            "right": 0
          },
          "proposed_offset": {
            "x": 0,
            "y": -161
          }
        }
      ]
    }
  ]
}
```

## 11.7 Timestamp / pointer requirement

Every reported problem should include at minimum:

- `HH:MM:SS.mmm`;
- PGS track ID;
- event index or composition number if available.

Optional:

```text
--export-preview
```

could later generate PNG previews of the PGS overlay or a diagnostic composite, but this is not required for the initial analyzer.

The timestamp alone should make it easy to jump to the event in Kodi, mpv, VLC, or another test player.

## 11.8 Acceptance criteria

Phase 1 is complete when:

1. A folder can be scanned without modifying any source.
2. Non-PGS MKVs are skipped cleanly.
3. PGS tracks are correctly identified.
4. At least one known scope title with subtitles in the black bar is detected.
5. At least one known-safe title produces zero false positives.
6. The tool reports precise timestamps for offending events.
7. 1080p and 2160p test files both work.
8. Scan results are deterministic between runs.

---

# 12. Phase 2 — Single-Movie Repair Prototype

## 12.1 Objective

Given one known test movie, produce a second MKV whose affected PGS subtitles are moved into the active scope image.

No batch support is required.

## 12.2 Example CLI

```bash
scope-sub fix \
  "/Movies/Test/Movie.mkv" \
  --aspect 2.39 \
  --output "/Movies/Test/Movie.scopefix.mkv"
```

Dry-run:

```bash
scope-sub fix \
  "/Movies/Test/Movie.mkv" \
  --aspect 2.39 \
  --dry-run
```

Specific track:

```bash
scope-sub fix \
  "/Movies/Test/Movie.mkv" \
  --aspect 2.39 \
  --track 4 \
  --output "/Movies/Test/Movie.scopefix.mkv"
```

## 12.3 Prototype implementation strategy

Start with the lowest-risk implementation:

### Prototype A

Use:

- MKVToolNix for inspection/extraction/remux;
- BDSup2Sub++ for PGS movement.

Process:

```text
mkvmerge -J
      |
      v
identify PGS track(s)
      |
      v
mkvextract PGS -> temp .sup
      |
      v
BDSup2Sub++ --move-in-ratio ...
      |
      v
corrected .sup
      |
      v
mkvmerge -> new MKV
```

This prototype answers the most important product question:

> Does remuxing relocated PGS subtitles produce exactly the playback behavior desired on Kodi and the scope screen?

## 12.4 Important prototype caveat

BDSup2Sub++'s “move inside” algorithm may move more subtitles than strictly necessary.

If it produces undesirable movement of subtitles that were intentionally located within the movie image, proceed to Prototype B.

### Prototype B

Replace BDSup2Sub++ transformation with custom event-level coordinate modification based on the exact logic used by the analyzer.

MKVToolNix remains responsible for extraction/remuxing.

## 12.5 Output rules

The prototype must:

- refuse to use input path as output path;
- fail if output already exists unless `--overwrite-output` is explicitly supplied;
- never delete the source;
- write temp files outside the source directory by default;
- clean temp files only after successful output validation;
- retain temp files on failure when `--keep-temp` is enabled.

---

# 13. Metadata and Stream Preservation

A corrected MKV should preserve as much source structure as possible.

At minimum verify:

- video codec;
- video bitstream;
- HDR metadata;
- Dolby Vision enhancement / metadata handling;
- audio tracks;
- audio codecs;
- subtitle tracks;
- subtitle language;
- subtitle name;
- default flag;
- forced flag;
- hearing-impaired flag where present;
- chapters;
- attachments;
- fonts;
- tags;
- track ordering;
- title;
- timestamps;
- duration.

Where MKVToolNix changes container-level implementation details such as muxing application metadata, those changes are acceptable.

Underlying untouched elementary stream payloads should remain identical where possible.

---

# 14. Validation Plan

## 14.1 Analyzer validation

Create a small test corpus containing:

1. 1080p 2.39 movie with lower PGS in black bar.
2. 1080p 2.39 movie with subtitles already inside.
3. 2160p 2.39 movie with lower PGS in black bar.
4. title containing top subtitles.
5. title containing forced PGS.
6. title containing multiple PGS languages.
7. 1.78:1 title.
8. 1.85:1 title.
9. non-PGS subtitle-only MKV.
10. mixed-aspect-ratio movie if available.

For each known offending subtitle, manually record at least one timestamp.

The analyzer should identify the same event.

## 14.2 Repair validation

For the initial repaired movie:

### A. Visual validation

Play original and repaired files at the reported timestamps.

Confirm:

- original subtitle is clipped / outside scope area;
- repaired subtitle is visible;
- glyphs look identical;
- subtitle timing is unchanged;
- no graphical corruption occurs;
- subtitle remains horizontally positioned as intended.

### B. Video integrity

Extract or hash the video elementary stream from both original and repaired MKVs.

Expected:

```text
original video elementary stream hash
==
repaired video elementary stream hash
```

### C. Audio integrity

Likewise verify audio streams remain unchanged.

### D. Subtitle comparison

For repaired tracks:

- timestamps should be identical;
- bitmap content should ideally be identical;
- position changes should match the intended offsets.

If BDSup2Sub++ re-encodes bitmap objects, visually and semantically verify that the resulting graphics remain lossless enough. This finding will influence whether custom coordinate rewriting is required.

### E. Kodi playback

Test specifically on:

- the Kodi-based player in use;
- normal SDR/HDR titles;
- Dolby Vision title if applicable.

Confirm seeking and subtitle switching remain normal.

---

# 15. Verification Commands

The eventual implementation should expose a verification mode:

```bash
scope-sub verify \
  original.mkv \
  fixed.mkv
```

It should compare:

```text
Container:
  duration
  chapters
  attachments
  tags

Tracks:
  type
  codec
  language
  flags
  names

Payload:
  video hashes
  audio hashes

PGS:
  event timestamps
  event count
  bitmap/object consistency
  intended coordinate differences
```

Output:

```text
PASS
  video payload unchanged
  8 audio payloads unchanged
  2 untouched subtitle tracks unchanged
  PGS track 4: 17 position changes
  PGS track 5: unchanged
  chapters preserved
  attachments preserved
```

---

# 16. Phase 3 — Decide on Final PGS Engine

After testing Prototype A, explicitly decide whether to retain BDSup2Sub++.

## 16.1 Keep BDSup2Sub++ if

- 1080p works;
- UHD works;
- Kodi accepts the generated PGS cleanly;
- bitmap quality is unchanged;
- forced flags survive correctly;
- timestamps survive correctly;
- only acceptable subtitles are moved;
- CLI behavior is deterministic;
- licensing/distribution constraints are acceptable.

## 16.2 Replace with custom code if

- it relocates subtitles that should remain untouched;
- it resizes or alters bitmap graphics unexpectedly;
- UHD behavior is unreliable;
- metadata/forced-event behavior is incorrect;
- its placement logic is insufficient;
- it becomes difficult to package on macOS;
- exact event-level control is desired.

## 16.3 Preferred custom behavior

A custom engine should perform a minimal transformation:

```text
PGS input
  |
parse display sets
  |
determine effective visible bounds
  |
for offending event:
  calculate delta X/Y
  update composition placement
  |
serialize valid PGS
```

Avoid decoding/re-encoding bitmap RLE unless required by the format semantics.

---

# 17. Phase 4 — Batch / Directory Tool

Do not start this phase until single-file repair has been proven.

## 17.1 Objective

Safely process a media directory containing hundreds or thousands of MKVs.

## 17.2 CLI concept

Scan:

```bash
scope-sub scan /Movies \
  --recursive \
  --aspect 2.39
```

Build a plan:

```bash
scope-sub plan /Movies \
  --recursive \
  --aspect 2.39 \
  --output plan.json
```

Review:

```bash
scope-sub plan-show plan.json
```

Execute:

```bash
scope-sub apply plan.json \
  --output-root /Movies-ScopeFixed
```

This two-step model is preferable to a one-command recursive mutation.

## 17.3 Batch safety

Batch mode must:

- default to dry-run;
- never replace originals by default;
- generate a persistent transaction/report log;
- continue past individual failures unless configured otherwise;
- support resume;
- verify each output before marking success;
- preserve failed inputs untouched;
- provide a clear final summary.

## 17.4 Optional eventual replace workflow

Only after extensive confidence:

```bash
scope-sub apply plan.json \
  --replace-original \
  --backup-suffix .pre-scopefix
```

Even then, replacement should be atomic where the filesystem supports it.

---

# 18. Performance Expectations

Scanning a large library should avoid reading video payloads unnecessarily.

Ideal scanner flow:

1. inspect MKV metadata;
2. extract only PGS tracks;
3. parse PGS;
4. discard temp extraction.

For a 60 GB movie with a 20 MB PGS track, analysis should read only enough of the MKV to locate/extract the relevant subtitle stream, not decode the full video.

The batch scanner should permit controlled parallelism:

```bash
--jobs 4
```

Default should remain conservative to avoid saturating NAS disks.

---

# 19. Logging

Support levels:

```text
error
warn
info
debug
trace
```

Normal output should emphasize decisions rather than implementation chatter.

Example:

```text
[INFO] Movie.mkv
[INFO] Video: 3840x2160
[INFO] PGS track 4: 1204 events
[WARN] 17 events extend below active area
[INFO] Earliest offending event: 00:12:44.382
```

---

# 20. Exit Codes

Suggested:

```text
0  success / no offending subtitles
1  success / offending subtitles found
2  invalid arguments
3  dependency missing
4  unsupported media structure
5  PGS parse error
6  remux failure
7  validation failure
8  output conflict
```

For shell scripting, `scan` may optionally offer:

```bash
--fail-if-needed
```

instead of using non-zero status by default for detected problems.

---

# 21. Configuration

Optional config file:

```yaml
default_aspect_ratio: 2.39
safe_margin_px: 0
jobs: 2
output_suffix: ".scopefix"
```

CLI flags override config.

Do not require configuration for initial use.

---

# 22. Dependencies

Initial prototype:

- MKVToolNix
- BDSup2Sub++ if Prototype A is used
- project runtime

Possible implementation language:

### TypeScript / Node.js

Advantages:

- strong fit for CLI orchestration;
- existing `pgs-parser` TypeScript project can provide reference code;
- good JSON/reporting ergonomics;
- easy subprocess control around MKVToolNix.

### Python

Also viable and particularly convenient for media scripting.

The architecture should not depend heavily on language-specific behavior.

---

# 23. Recommended Implementation Choice

For the first useful prototype:

## Analyzer

**Custom PGS parser / analyzer + MKVToolNix**

Reason:

BDSup2Sub++ can transform PGS, but the analyzer needs precise read-only event-level geometry and timestamps.

## Single-file fixer

Start with:

**MKVToolNix + BDSup2Sub++**

Reason:

This is the fastest way to validate the central thesis that offline PGS relocation behaves correctly in the real theater.

If BDSup2Sub++ moves more subtitles than desired or alters the PGS in undesirable ways, replace only the transformation component with custom PGS coordinate rewriting.

## Batch tool

Only after a custom or BDSup2Sub-based single-file workflow passes integrity tests.

---

# 24. Test-Driven Development Plan

Before implementing the full scanner, create isolated PGS fixtures.

## 24.1 Parser tests

Given a known `.sup` file:

- parses screen dimensions;
- parses PTS;
- reconstructs display sets;
- identifies object position;
- identifies bitmap dimensions;
- calculates bounding rectangle.

## 24.2 Geometry tests

Synthetic cases:

```text
active area: y=138..941
```

Cases:

- subtitle `y=800..900` → safe;
- subtitle `y=900..1000` → 59 px overflow;
- subtitle `y=950..1050` → 109 px overflow;
- subtitle `y=20..100` → top overflow;
- subtitle exactly touching boundary → safe.

## 24.3 Movement tests

Given:

```text
original bottom = 1000
active bottom = 941
```

expected delta:

```text
-59 px
```

The resulting visible rectangle must lie fully inside the active area.

## 24.4 Round-trip tests

For custom PGS writing:

```text
parse -> serialize -> parse
```

with no requested modifications should produce semantically identical:

- event count;
- timestamps;
- screen dimensions;
- bitmap/object data;
- placements.

Where byte-identical output is practical, test it.

---

# 25. Edge Cases

The implementation must detect or safely handle:

### PGS-specific

- multiple objects in one composition;
- multiple subtitle windows;
- cropped composition objects;
- reused ODS bitmap objects;
- palette updates;
- epoch changes;
- top-positioned text;
- signs or captions positioned off-center;
- simultaneous dialog + sign subtitles;
- forced-only events;
- unusually large transparent bitmap canvases.

### MKV-specific

- multiple video tracks;
- multiple editions;
- ordered chapters;
- attachments;
- dozens of subtitle tracks;
- unusual language tags;
- missing track names;
- default/forced flag combinations.

### Video-specific

- 1920×1080;
- 3840×2160;
- 1.78;
- 1.85;
- 2.35;
- 2.37;
- 2.39;
- 2.40;
- non-centered letterboxing;
- mixed aspect ratio.

Unsupported or ambiguous cases should be reported, not guessed.

---

# 26. Failure Philosophy

The correct behavior when uncertain is:

```text
DO NOT MODIFY
```

Examples:

```text
Unsupported PGS composition -> SKIP
Mixed aspect ratio -> SKIP (MIXED_NARROWEST, since 0.5.0, is treated as a constant area)
Cannot determine frame geometry -> SKIP
mkvmerge metadata mismatch -> FAIL
Output validation mismatch -> FAIL
```

The batch system should optimize for preserving originals, not maximizing the number of files processed.

---

# 27. User Experience

A successful workflow should eventually look like this.

### Step 1

```bash
scope-sub scan /Movies/Sample --aspect 2.39
```

Result:

```text
3 movies scanned
1 needs fixing

Dune Part Two (2024).mkv
  English PGS
  12 affected events
  first: 00:04:17.833
  max overflow: 143 px
```

### Step 2

```bash
scope-sub fix \
  "Dune Part Two (2024).mkv" \
  --aspect 2.39 \
  --output "Dune Part Two (2024).scopefix.mkv"
```

### Step 3

```bash
scope-sub verify \
  "Dune Part Two (2024).mkv" \
  "Dune Part Two (2024).scopefix.mkv"
```

Result:

```text
PASS

Video streams unchanged
Audio streams unchanged
Chapters preserved
Attachments preserved

English PGS:
  12 events moved
  timestamps unchanged
  bitmap payloads unchanged
```

Then manually inspect several reported timestamps in Kodi.

Only after this succeeds on a representative sample should directory-scale processing be implemented.

---

# 28. Phase Gates

## Gate A — Analyzer trust

Proceed when:

- known bad subtitles are detected;
- known safe subtitles are not flagged;
- timestamps are correct.

## Gate B — Repair feasibility

Proceed when:

- a single repaired MKV plays correctly in Kodi;
- subtitles appear inside the scope image;
- video and audio streams are unchanged.

## Gate C — Transformation quality

Proceed when:

- UHD works;
- forced tracks work;
- top/bottom captions work;
- multiple objects work;
- no significant subtitle rendering changes are introduced.

## Gate D — Batch readiness

Proceed when at least 10–20 diverse movies have been repaired and verified without unexplained regressions.

---

# 29. Deliverables by Milestone

## Milestone 1

```text
scope-sub scan
```

Deliverables:

- CLI;
- MKV inspection;
- PGS parser;
- geometry analyzer;
- human-readable report;
- JSON report;
- timestamp reporting;
- unit tests.

## Milestone 2

```text
scope-sub fix
```

Deliverables:

- single-input only;
- BDSup2Sub++ prototype or custom transform;
- MKVToolNix remux;
- separate output file;
- dry run.

## Milestone 3

```text
scope-sub verify
```

Deliverables:

- track metadata comparison;
- payload hashing;
- PGS event comparison;
- clear PASS/FAIL.

## Milestone 4

```text
scope-sub plan
scope-sub apply
```

Deliverables:

- recursive directory scan;
- plan file;
- batch execution;
- resume;
- structured logs;
- safe output-root handling.

---

# 30. Open Questions to Resolve During Prototype

1. Does BDSup2Sub++ handle UHD 3840×2160 PGS reliably?
2. Does it preserve bitmap payloads, or does it decode and re-encode them?
3. Does its `--move-in-ratio` behavior move only captions outside the scope area, or reposition all upper/lower captions?
4. How does it handle multi-object PGS display sets?
5. How does it preserve forced flags?
6. Can PGS positions be changed safely by editing PCS object coordinates alone, or do WDS window coordinates also need adjustment in some streams?
7. What is the best visible-bitmap bounding-box method when an ODS object contains transparent margins?
8. Is explicit aspect ratio input sufficient for the final product, or is automatic active-area detection worth adding?
9. How should mixed-AR movies be represented in scan results?
10. How much safe margin inside the screen should be used, if any?
11. Should the tool move a subtitle by the minimum amount necessary or normalize lower subtitles to a common baseline?
12. Should corrected subtitles replace their original track in the output, or optionally be added as a second track for A/B comparison during testing?

---

# 31. Optional A/B Test Mode

For early validation, consider adding:

```bash
--keep-original-subtitle
```

Instead of replacing the original PGS track, the fixer could include both:

```text
English [original]
English [scope-fixed]
```

This would make comparison in Kodi extremely easy.

The scope-fixed track would copy:

- language;
- forced/default semantics where practical;
- descriptive title with a suffix.

This mode is particularly useful before trusting replacement behavior.

It should not be the default final batch behavior.

---

# 32. Success Definition

The project is successful when a scope-format MKV containing PGS subtitles in its encoded black bars can be transformed into a second MKV such that:

1. Kodi renders the subtitles entirely inside the visible scope image.
2. The subtitle graphics remain visually identical.
3. Subtitle timing remains identical.
4. Video is untouched.
5. Audio is untouched.
6. HDR / Dolby Vision behavior is untouched.
7. Chapters and metadata remain functionally intact.
8. The process can identify affected titles before modification.
9. The process can identify exact timestamps for manual inspection.
10. The process is safe enough to later apply to a large media library.

The key architectural principle is:

> **Modify the subtitle overlay, not the movie image.**
