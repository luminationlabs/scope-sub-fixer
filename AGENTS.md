# scope-sub

CLI that finds and fixes Blu-ray PGS subtitles authored inside the letterbox
bars of scope-format MKVs. See `docs/PRD.md` for the full product spec and
`README.md` for the user-facing guide.

## Hard rule

**Never write to a real media library.** A source media library is read-only for
every tool and every agent working here. Scanning must not touch source files at
all; repairs always go to a separate output path. The two code paths that can
write to a library — `apply --replace-original` and `apply --dangerously-in-place`
— exist for the operator to run deliberately; never run either against the
library from here, and test them only on fixtures.

## Layout

```
src/pgs/        PGS (.sup) parser, serializer, RLE codec, patcher, fixtures
src/mkv/        MKVToolNix wrappers and the direct Matroska PGS block reader
                (default strategy streams the file: fastest on every transport
                measured; adaptive/minimal move ~3% of the bytes, but slower)
src/video/      Active-area geometry and the sampled-frame picture measurement
src/geometry/   Overflow classification and relocation policy
src/scan/       analyzeFile(), the shared pipeline, plus scanFile / scanPaths
src/fix/        Byte patching, the streaming copy-with-patches, remux, fix
src/verify/     Container / payload / PGS comparison of two files
src/batch/      Plan directory schema, planning, the apply engine, its log
                and `revert`, the inverse-patch undo
src/report/     Human-readable and JSON scan reports
src/cli/        Command-line entry points (bin: scope-sub -> dist/cli/main.js)
src/serve/      The engine protocol for a GUI: `serve --stdio`, JSON lines
src/tools/      locate.ts: the one place that decides which external binary runs
test/           Mirrors src/
scripts/        Deployment and one-off measurement scripts (only scope-subs.* ship)
docs/           The CLI reference, the product spec (PRD.md), known-bad titles,
                the engine protocol
desktop/        The Tauri desktop app; runs the engine as a sidecar (its own README)
```

`src/scan/analyze.ts` owns the one pipeline every command runs — inspect,
resolve the active area, read the PGS tracks, resolve events, classify, plan
moves. The active area is resolved *before* the tracks are read, which buys the
one shortcut in the pipeline: `coversFullFrame` (a CONSTANT area that is the
whole coded frame) means nothing can be outside it, so the tracks are not read
at all. Those tracks come back with `eventsRead: false` and every count
meaningless rather than zero, which is why `eventCount` and the plan's
`event_count` are optional and the reports say "not read". `--full` / `plan
--no-fast-path` force the read. `scan` renders its result as a report and `fix` turns the very same
`MovePlan` into edits, which is what guarantees the fixer can never move
something the scanner would not have flagged.

`src/batch/` is that same pipeline again, for a library. `plan.ts` turns one
`FileAnalysis` into a plan entry (`decideAction` is the whole fix/skip decision
table and is pure), `planFile.ts` owns the on-disk schema and the hex encoding
of `BytePatch`, `log.ts` is the append-only transaction log plus the resume
rule, `apply.ts` executes a plan and `revert.ts` undoes one. Both `fix --method patch` and `apply`
write through `src/fix/copyPatch.ts` — one pass that patches the bytes as it
copies them, hashes what it wrote and deletes the partial on any failure, so a
refused repair never leaves a full-size half-patched file. `apply` never re-analyzes for the patch method: the plan carries every
byte edit and a positionless per-track fingerprint (`fingerprintTrack` in
`src/verify/pgs.ts`, shared with `verify`), which is what the finished output is
checked against.

`revert.ts` is that in reverse, and the reason the plan directory is worth
keeping: `invertPatches` swaps `before` and `after`, `decideRevert` is the pure
refusal table (wrong size, bytes that are neither state, already original), and
the write is either the same `copyWithPatches` or — the point of the command —
a few thousand small `r+` writes followed by a re-read of those same ranges.
A `reverted` record with no `revertedTo` is what tells `completedByInput` the
file is no longer applied, which is how `apply` knows it may do it again.

## Commands

```bash
scope-sub scan <paths...> [--aspect X|auto] [--recursive] [--full] [--format human|json]

scope-sub fix <input.mkv> --output <out.mkv> [--aspect X|auto] [--track <id>...]
              [--method patch|remux] [--keep-original-subtitle] [--dry-run]
              [--overwrite-output] [--margin px] [--temp-dir path] [--keep-temp]

scope-sub verify <original.mkv> <fixed.mkv> [--aspect X|auto] [--hash-streams]
                 [--expect-tracks 4,5] [--format human|json]

scope-sub plan <paths...> --plan <dir> [--aspect X|auto] [--recursive] [--margin px]
               [--method patch|remux] [--jobs N] [--reanalyze] [--no-fast-path]
               [--format human|json]

scope-sub plan-show <dir> [--only fix|skip|all] [--file <substr>] [--max-moves N]
                    [--format human|json]

scope-sub apply <dir> --output-root <root> [--execute] [--jobs N] [--overwrite-output]
                [--replace-original --backup-suffix .pre-scopefix] [--stop-on-error]
                [--format human|json]
scope-sub apply <dir> --dangerously-in-place [--execute] [--skip-verify] [--preserve-dates]
                [--jobs N] [--stop-on-error] [--format human|json]

scope-sub revert <dir> [--file <substr>] [--in-place [--preserve-dates] | --output-root <dir>]
                 [--execute] [--overwrite-output] [--format human|json]
scope-sub revert --patch-file <patches.json> --target <fixed.mkv>
                 [--in-place | --output <out.mkv>] [--execute]

scope-sub review <library...> --plan <dir> [--aspect X|auto] [--recursive] [--jobs N]
                 [--preserve-dates] [--log-level level]

scope-sub remargin <library...> --plan <dir> [--aspect X|auto] [--recursive] [--margin px]
                   [--jobs N] [--execute] [--preserve-dates]

scope-sub restore-dates <dir> [--file <substr>] [--execute]

scope-sub doctor [--format human|json] [--temp-dir path]

scope-sub serve --stdio
```

`serve` (`src/serve/`) is the engine for the desktop app in `desktop/`:
JSON-lines requests on stdin, responses and progress events on stdout
(`docs/engine-protocol.md`; `protocol.ts` holds the message shapes and the UI
views, `server.ts` the dispatcher). It calls `runDoctor`, `runPlan` and
`applyPlan` directly and decides nothing about a repair. Its copy-mode `apply`
never writes over an existing file: `inPlace`, `replaceOriginal`,
`dangerouslyInPlace`, `skipVerify` and `overwriteOutput` are refused by name,
`only` is required, and `unsafeOutputReason` (`src/serve/safety.ts`) refuses
any output folder from which a copy would land inside a scanned root or on an
original — judged by `realpath` and device/inode, not spelling. `apply` also
refuses a plan with an unfinished `--replace-original` swap, pre-flights space
(`no-space`), and removes this plan's own unfinished copies (`stalePartials`).
`plan` refuses a plan directory inside a scanned folder. `runServe` gives the
engine its own temp folder (`scope-sub-engine-<pid>`, via `TMPDIR`) and sweeps
those of dead engines. The desktop shell owns the engine process
(`desktop/src-tauri/src/engine.rs`) and ends it with `shutdown` on quit. Copies
are the default; `apply` changes originals only when asked for
`mode: "in-place"` by name. Then it calls `applyPlan({ inPlace: true })` for
the chosen patch-method titles only, answers remux titles as
`skipped`/`needs-copy`, and refuses up front when a chosen file is not
writable (`not-writable`); the spellings `inPlace`/`dangerouslyInPlace` stay
refused in both modes. `revert` (`src/serve/inPlace.ts` holds its checks) puts
the original bytes back in place, one `revertPlan` call per title aimed by a
filter proven to select that title alone, and only for originals this plan
wrote. `plan` reports `FileView.interrupted` and `undoRecords` from the log,
and refuses `reanalyze` (`undo-records`) for a plan directory with in-place
records. `keepDates` (in-place `apply` — refused by name with a copy — and
`revert`) passes `preserveDates` and gives every batch call of the request one
server-made `DateWatch` (`deps.dateWatch`), which the server settles once, with
the cancel signal, after the last call: first `apply.dates`/`revert.dates`
(`DateWatch.remaining()`), then `dateNotKept` on the file views; tests shorten
the window through `EngineDeps.dateWatchOptions`. The app keeps the mode behind
a persisted, confirmed setting (plus an unconfirmed `keepDates` one, shown only
while in-place is on and sent with every write to an original) and a per-run question; its wording lives in `desktop/src/words.ts` and is pinned by
`test/serve/desktop-inplace-words.test.ts`. The
live progress and the cancel come from two optional hooks
the batch functions take in their `deps` — `onProgress` and an `AbortSignal` —
which the CLI commands never pass; a cancelled run returns `cancelled: true`
and is exactly as resumable as a killed one (`runPlan` leaves the interrupted
file's entry as it was, `applyPlan` abandons a copy through `copyWithPatches`,
which removes its partial). The cancel is honoured in every phase of a copy —
the read-back (`hashFileChunked` takes the signal) and the PGS check
(`verifyPatchedOutput` throws from the reader's progress hook) included — and
whatever was written is removed; only an in-place write is finished and
verified regardless.

The app fixes compressed titles too, through `PlanOptions.remuxFallback`
(protocol: `plan`'s `remuxFallback`; no CLI flag). It is decided per title by
the pure `decideWithFallback` in `plan.ts`: under the patch method, a title of
which remux can repair more tracks than patching can (Matroska compression, a
cluster CRC-32) gets `method: "remux"` in its own entry and a note saying why;
everything else stays a patch. An entry carries its own `method`, which
`applyOne` reads; the plan's `options.remuxFallback` (optional, omitted when
off) is part of `planMismatch`, so verdicts made with and without it are never
mixed. A remux entry reports `analyze`,
`extract`, `rebuild` and `verify` phases and is cancellable throughout:
`spawnCapture` takes a signal and terminates the child (`SpawnAbortedError`),
`fixByRemux` removes its temp directory and mkvmerge's truncated output, and
`hashStreams` removes what a stopped mkvextract wrote. Its verification is
`verifyFile` on the stream-hash path, which extracts every track of both files
into the temp directory — scratch space about the size of the title.

`fix` has two methods:

- **`patch`** (default) copies the input byte-for-byte and rewrites only the
  PCS object and WDS window `x`/`y` fields in place, using the absolute offsets
  the direct block reader reports. The output is the input plus a few thousand
  changed bytes. It refuses a Matroska-compressed track and refuses any cluster
  carrying a CRC-32, since both break the offset contract; both say to use
  `--method remux`.
- **`remux`** extracts each track with `mkvextract`, rewrites the .sup and lets
  `mkvmerge` rebuild the file. Slower and it rewrites the container, but it
  works on compressed tracks and is the only way to get the A/B mode of
  PRD §31 (`--keep-original-subtitle` appends `<name> [scope-fixed]` tracks
  with the default flag off).

`plan` writes a directory: `plan.json` (one entry per MKV, rewritten atomically
after every file, so a killed run resumes), `patches/<n>.json` (every byte edit,
the per-track moves and the fingerprint) and, once `apply` runs,
`apply.log.jsonl`. `planMismatch` in `plan.ts` decides whether an existing plan
can be extended: `--recursive` is not part of it (it only changes which files
are found and their output paths), and a plan that does not match is refused,
never overwritten, unless `--reanalyze` is given — the first save would empty
it. Those three files are also the complete undo record, which is
what `revert` reads; `docs/cli.md` says to keep a copy beside the library. `apply` is a dry run unless `--execute` is given; it
pre-flights (input unchanged since the plan, output free, space available),
copies with the patches applied in 8 MiB chunks, hashes the written stream,
re-reads and re-hashes the output, then verifies the PGS against the plan's
fingerprint. `--replace-original` renames the original aside and the output into
its place, both within one filesystem, and refuses up front otherwise; when
`--output-root` maps a file onto its own path (the swap-in workflow) the copy is
staged under `<output-root>/.scopefix-staging/` rather than refused. The two
renames have a `backed-up` record between them, so a run killed there is
recognised on the next one — backup present, input missing — and finished. A
swap that *fails* undoes itself instead (original back in place, verified copy
removed, `failed` logged), so no verified copy is left behind with its
completion cleared; only when neither rename can be made is it left as a killed
run leaves it, without a `failed` record, for the next run to finish. A
rerun skips whatever the log already records as `verified`, `replaced` or
`patched` — a `verified` record only for the very output path it names
(`shouldSkipForResume`'s `outputPath`): a same-sized file at the same relative
path in another folder is a conflict, not a finished copy. Likewise a `failed`
record clears a completion only when it is about that completion's output
(`completedByInput`), so a refused in-place attempt does not forget a copy
verified elsewhere.

A copy is written to `partialPathFor(output)` (`<output>.scope-sub-partial`,
in `copyPatch.ts`; `apply` and `revert` both use it) and renamed when it has
been read back. The name is the tool's own, so a leftover one is removed
without asking and nobody else's file can be. Making the output
folder, removing a leftover and logging `started` all happen inside
`applyOne`'s `try`, so a folder that cannot be made fails that title and the
run goes on.

`--dangerously-in-place` (`applyInPlaceOne`) skips the copy: it scans every
changing range with revert's `scanPatchState`, decides with the pure
`decideInPlace` table, logs `started` (`inPlace: true`; fsynced, as is
`revert --in-place`'s — `appendApplyLog`'s `sync` — because that record is all
that lets a half-written file be finished and must not sit in a cache while the
file on the share is already changing), writes through revert's
`writePatchesInPlace`, verifies the PGS exactly as a copy is verified and, if
that fails, writes `invertPatches` straight back. Success is a `patched` record,
which `completedByInput` and revert's `repairedPathFor` treat like `replaced`.
A patched file's mtime is no longer the plan's, so `lastInPlaceWrite` (in
`log.ts`) names the inputs this tool last wrote in place; for those alone the
pre-flight ignores the mtime (`ignoreMtime`) and the byte scan decides, which
is how a killed run is finished and a reverted file re-patched. `APPLY_EXIT`
lives in `exitCodes.ts` so `apply.ts` can import from `revert.ts` without a
cycle.

A plan directory can serve one library for good because of these `runPlan`
rules. **It never forgets**: entries for files a run does not find (`notFound`)
are carried as they were, because an unmounted share looks exactly like an
empty directory. **It never trades a
verdict for an error**: a title that cannot be stat'ed, read or analyzed this
run (a share that drops mid-run fails every file after it) keeps the non-ERROR
entry it had, exactly as it was, and is listed in `unreadable`; only a title
with no verdict yet gets an ERROR entry. `plan` reports both, and `review`
exits non-zero (4, unless a repair failure outranks it) when any title could
not be checked. **It never re-analyzes a
file its own `apply`/`revert` wrote** (`lastWriteToInput` in `log.ts`: in-place
writes of the input's own path, `backed-up`/`replaced`), not under `--reanalyze`
either. **It never reuses a patch file name for an input the apply log
mentions at all** (`loggedInputs`: a copy verified elsewhere, an in-place
write, a `superseded` — also one written by a run that was then killed
mid-analysis, which leaves the old entry in `plan.json`): the fresh analysis
gets a new name, the old file stays on disk and the new entry's notes name it.
Only an input the log has never heard of has its patch file rewritten in
place. **A `plan.json` that cannot be written halts the run**: `save` never
rejects; it records the failure and aborts an internal signal, every worker
stops at its next step, and `runPlan` throws that one error after all of them
have returned — no worker is left writing patch files or log records behind
the caller's back.

`apply`'s and `revert`'s writes to an input's own path log a `stamp` (size + mtime right after), so an unchanged
file is reused quietly and one changed since is reported in `keptChanged`, still
not re-analyzed; a record without a stamp (`backed-up`, or a file that could
not be stat'ed after the write) is reused quietly.
**Another size is another file**: a patch never changes a size, so a repaired
file whose size is neither the plan's nor the stamp's (a re-rip) is
`superseded` — `runPlan` appends that record to the apply log (every log map
forgets the input's history at it), analyzes the file afresh under a new patch
file name, and leaves the old patch file on disk, named in the entry's notes.
`analyzedFiles` lists what a run did analyze. An input whose last log record
is an in-place `started` (a write that never finished) is listed in
`unfinished` and warned about on every run.

**A repaired file that holds the original bytes again** at the same size — the
unrepaired file put back from a backup — would otherwise be stuck: `apply`
skips it as done, `revert` finds nothing to undo. When `sameMedia` finds every
patched range original under a `patched`/`replaced` record, `runPlan` appends
the record an in-place revert would have written (`reverted`, own path, the
file's stamp; listed in `restored`). That one record clears the completion,
marks the input as last written in place (so `apply` ignores the mtime and
scans the bytes) and gives the next `plan` a stamp to find unchanged.
`revert --in-place --execute` writes the same record when it meets such a file
("already original" under a completion that vouches for it).

**Unless only the headers changed.** `mkvpropedit` adds an attachment or tag
without moving a cluster, and a tool that restores the mtime afterwards
(a metadata sync job, for instance) leaves another
size and the same media. `sameMedia` in `runPlan` tests for that before either
a re-analysis or a `superseded`: mtime within `MTIME_RESTORE_TOLERANCE_MS` for
an unwritten entry (SMB rounds a restored mtime), the pure `mediaMismatch`
(Segment UID when the entry has one, video size, PGS tracks — only the listed
ones for an entry with byte patches, since an entry may list only the tracks
it fixes), and `scanPatchState` finding no range that is
neither state. A written entry requires the byte scan and nothing else — not
the mtime, not `mediaMismatch` (a header editor changes flags, names and
languages) — and is tested both where it would be `superseded` and where it
would land in `keptChanged`; there a failure to inspect or to read the patch
file throws, so the worker's catch keeps the entry, instead of answering "not
the same". `adopt` then keeps the entry, rewrites the patch file's `size` before the
entry's size and mtime, and lists the input in `adopted`. Which size counts
where: the in-place apply and a plan-driven `revert` of the input's own path
hold the file to the *entry's* size, which `adopt` always brings up to date; a
`revert` of a copy elsewhere, and `revert --patch-file`, hold their target to
the *patch file's*, which `adopt` leaves alone while the repair is a copy
elsewhere (`copiedElsewhere`) — so an adopted title with a copy can still be
patched in place, and both files still revert; taking the mtime is what makes the next run find
the file unchanged.

**The margin a fix used is in its patch file** (`PatchFileTrack.margin`),
not in the plan's options: a plan whose `options.margin` is unset means "the
default" (`DEFAULT_MARGIN_AT_1080`), so when a release changes the default
such a plan still extends and its earlier fixes stay where they are.
`remargin` (`src/cli/remargin.ts`) is how they are redone — those, and
(`repairIsStale`) any fix that left subtitles outside under an older
`PLACEMENT_RULES` generation, which patch files record as `placement_rules`
(absent: 1). Bump `PLACEMENT_RULES` when a change may let the current rules
move subtitles an earlier fix had to leave outside. The current rules
(`findBoundsViolation` in `geometry/policy.ts`) centre an offending object
taller than the picture minus the margin on both sides (`landingMargin`),
refuse only one taller than the picture, and leave a window where it is and
move its objects inside it when the window cannot move with them
(`windowMoves`: tried only after the usual arrangement is refused, and only
when every moved object stays inside the window as declared).
`objectsOutsideWindow` (`verify/pgs.ts`) is the independent check after the
write: `comparePgsTracks` against the original's count, `verifyPatchedOutput`
against the patch file's `outside_window` (absent: not checked). A title
analyzed again and kept (`remarginKept`) gets `redo_tried` on its entry, and
`redoIsDue` leaves it alone until the margin or the generation changes. They
are redone one title at a time so that at most one is ever unrepaired:
`revertPlan({ inPlace, only })`, `runPlan({ remargin: true })`,
`applyPlan({ inPlace, only })`. It checks `planMismatch`, the targets and
`doctor` before the first revert, because a title put back and then not
analyzed is a title left unrepaired; and the last step always runs, on the
new entry or on the one the plan kept. `runPlan` keeps the entry it has
(`remarginKept`, via `worseThanPlanned`) whenever the fresh analysis is not a
fix by the same method that moves at least as many events and leaves no more
outside — never replace a logged fix entry with a worse one. `runPlan`'s
`remargin` is the second exception to "a file this plan wrote is never
re-analyzed": only when the last record is an in-place `reverted` and the
file is the original — its stamp unchanged, or every patched range holding
the original bytes (`redoForMargin`) — and the patch file's margin differs
(`staleMargin`). The fresh analysis gets a new patch file name, as any logged
input does; the old one stays on disk. A title still repaired is carried and
listed in `remarginBlocked`; one planned and never repaired is planned again.
`surveyRemargin` also counts a title put back and not yet repaired again as
one to repair — including one already analyzed again, which its entry's
`REMARGIN_NOTE` says — which is what makes a stopped run resumable.
`scope-subs.sh --remargin` wraps it in the lock, snapshot and mirror.

One exception to "an unchanged file is reused": `needsAreaRecheck`. Entries
carry `area_rules` (`ACTIVE_AREA_RULES` in `planFile.ts`; absent: 1), the
generation of the active-area detector and the other rules that made the
verdict. An unwritten skip entry from an older generation that one of
`AREA_RECHECKS` (in `plan.ts`) picks out is analyzed again, once;
`areaRecheckReason` gives the sentence `plan` logs. The list is empty until
a bump needs a rule. Bump `ACTIVE_AREA_RULES`, and add the rule, when a fault
makes a known class of recorded skip verdicts wrong; that refuses nothing,
unlike a `PLAN_RULES_VERSION` bump.

**The active area** (`src/video/activeArea.ts`). `createFrameSampler` has
ffmpeg decode one frame per sample to 16-bit full-range grey and `pictureBox`
tests every pixel: a row is picture when 0.2% of its pixels are above 7% of
full scale (`PICTURE_LEVEL`). Measured on real discs, bars peak at 4% of full
scale (1080p) or 2% (UHD HDR) while dark picture still has grain above 7%,
and any threshold between found the same edges. The sampler forces `-color_range tv` (a
"full range" container tag would leave black at 6% and a letterboxed film
would read as having no bars) and `-noautorotate`; `pictureBox` steps over a
bright island in a bar (a burned-in caption, a logo, a garbage line: black
rows lie between it and the picture), erring towards the smaller box; and a
frame that cannot be had — ffmpeg failing, a stalled share (120 s), a frame
of another size than the file says — is a `FrameSampleError`, never "a frame
with no picture": when not one frame can be had `detectActiveArea` throws,
so `runPlan` keeps the verdict it has. In `detectActiveArea`,
`absorbOneOffs` counts a shape seen once, or cut short on one side only,
towards the repeated shape it lies inside (a measurement only ever comes out
smaller than the picture); a title showing a second shape is sampled again
between its first samples (24, then 23 more) before it is judged; and
whenever a second *repeated* shape a real step away exists, the only
question asked is `narrowestRepeatedShape` — the CONSTANT branch and its
`pickEdge` see only edges within a step of the modal shape, so a scope film
with a little IMAX footage does not read as "no bars".
`narrowestRepeatedShape` looks for a scope film with IMAX scenes — at least
12 usable samples, shapes seen more than once covering 80% of them, the
narrowest of those seen more often than any other, centred, with bars, and
every other repeated shape taller by 4% of the frame on both sides
(`SHAPE_STEP`) — and the area (`MIXED_NARROWEST`) is that narrowest shape.
Subtitles are then inside every shape the film returns to, a little further
in during the taller ones (a shape seen once is not considered). The rule
errs towards refusing, because a wrong yes moves a whole film's subtitles: a
taller film with scope scenes stays `MIXED_ASPECT_RATIO` (full frame, leave
alone) — Dunkirk, whose full-frame scenes outnumber its scope ones, is the
case to keep in mind. `verifyFile` fails when the original has a usable area and the fixed
file's own detection has none, and `review` names the shape when it asks.
`isUsableArea` is the test for "an area to judge and move by" (`CONSTANT` or
`MIXED_NARROWEST`), and the area's note reaches the plan entry's notes
(`MIXED_NARROWEST_NOTE`). `doctor` checks the same path: ffmpeg must decode a
`lavfi` test frame with the sampler's options to exactly 64x36x2 bytes
(`TEST_FRAME_ARGS`; report `frames`).

`planMismatch` does not look at the tool version or name: it compares
`PLAN_RULES_VERSION` (`planFile.ts`; written as `tool.rules` and read by
`planRulesOf`, which reads a plan without it as no known generation, so such
a plan is refused). A release or a rename therefore keeps every plan
extending; bump the rules version only when old and new verdicts must not
share a plan, because a bump makes every existing plan refuse to extend.
Stamps are compared with `sameMtime` (within 1 ms is equal): Node reports a
fractional `mtimeMs` and bun a whole one, and a plan written by either must
read as unchanged to the other.

**File dates** (`src/batch/dates.ts`). An in-place write moves the file's
mtime, and that stays the default. `preserveDates` (`ApplyOptions`,
`RevertOptions`; `--preserve-dates` on `apply --dangerously-in-place`,
`revert --in-place`, `review`, `remargin`) puts the mtime back with `keepDate`
after the write and its verification, *before* the record that carries the
`stamp` — so the stamp is the kept date and `plan` finds the file unchanged
exactly as before. The date is logged on the in-place `started` record
(`keepMtimeMs`) because the file's own is gone from the first byte on:
`dateToKeep` takes it from an unfinished `started` when a later run finishes
the write — only while the file's date is from that write or later, so a
`started` that never touched the file promises nothing. A date that cannot be put back is a warning and a check line, never
a failed repair. **On a share the date has to be watched** (`DATE_SETTLE_MS`):
macOS closes an SMB file lazily and the server stamps the write when the close
arrives, 40 to 95 s later, replacing a date set in between while the client
may still report the one it set. So `keepDate` only sets the date, and its
caller hands the file to the run's `DateWatch`, which works in the background while the run
goes on: it polls each file until 150 s after `keepDate` — after the
verification, not the write, since nothing says a read does not hold the
share's handle open too — sets the date again when it changes, and sets it
once more when the window ends. `applyPlan` / `revertPlan` wait for what is
left of the watch (`settle`) after every record is logged, so a run waits once,
for the files it wrote last, up to 150 s. A caller making several runs passes
its own watch in `deps.dateWatch` and settles it itself: `remargin` does, so
it waits once for all its titles, and a file written twice is watched for the
later date only. A watch cut short (the cancel signal) or one that cannot set
a date is a warning and a check line on the file's result (`remargin`: a
list in its summary), and an own watch is settled even when the run throws.
`serve` does the same per request (`keepDates`; settled once per `revert`, not
per title, with the cancel signal, and its problems become `dateNotKept`). No watch on a local
disk (`settleWindowFor`, `isNetworkPath`); a full one when the mount table
cannot be read (`mountTableKnown`). A run killed inside a window leaves the
share's date on that file and the kept date in the log: `plan` then adopts the
file (`sameMedia`), and `restore-dates` puts the date back. The
finishing records (`patched`, `reverted`) carry `keepMtimeMs` too, and
`dateToKeep` puts that date back when a file's date is the earlier write's own
stamp (`isStampOfWrite`, anything within ten minutes of that write): the next
write of such a file — `remargin`'s repair after its revert, or a later run —
still keeps the right date. `restoreDates` accepts such a stamp as well as the logged one.
A fixed file's size and date cannot say whether it still holds the fix: with
dates kept the stamp *is* the original's, and a file put back from a backup
usually comes with the original's date whatever was kept (Finder, Time
Machine, `rsync -t`, Windows' copy). So `runPlan` asks the file: for an input
whose last record is `patched` or `replaced` and whose stamp is unchanged,
`probeFixedFile` reads one patched range (`PlanFileEntry.probe`, taken from
the patch file once and kept on the entry) and anything but the fixed bytes
sends the file on to `sameMedia`, where an all-original file is recorded as
`reverted` and listed in `restored`. No probe (a remux, an unreadable file)
changes nothing. `restoreDates`
(`scope-sub restore-dates`) is the after-the-fact version: for each input in
`lastWriteToInput` it takes the `mtimeMs` of the last patch file made for
that input before the plan's first own-path write (and after the last
`superseded`) — a patch file carries the stamp of the file it was analyzed
from — and sets it only when the file's date is still the last write's
`stamp` (a record without one: a date within a day before the record). It
then sets the entry's `mtimeMs` to match, which is what `sameAs(previous)` in
`runPlan` needs to reuse the entry without a byte scan. Patch files are not
touched.

`revert --in-place` logs `started` (`reason: "revert"`) before writing, and
`unfinishedInPlace` finds any in-place write without its finishing record, so a
half-reverted file is found by `revertPlan` and finished (`decideRevert`'s
`resumable`), or finished the other way by `apply`. An in-place `started` over
the file a completion vouches for clears that completion (`completedByInput`). `review` (`src/cli/review.ts`) is
that loop as one command: `runPlan`, describe `analyzedFiles`, rehearse
`applyPlan({ inPlace: true })`, ask per `would-apply` file through an injectable
`Ask` (`createAsk` reads one line per question, so piped answers work; `null` is
end of input), then `applyPlan({ inPlace: true, execute: true, only })`. Answers
must be an explicit y/n (an empty line re-asks: buffered Enter presses). At a
terminal an answer counts only if it was typed after its question was printed
(`createAsk`'s `interactive`): stdin is read only while a question waits, lines
that arrived early are dropped, and before *every* question `discardTypeahead`
empties the terminal's own buffer through a non-blocking `/dev/tty` — in raw
mode, switched on only for that synchronous read and always off again in a
`finally`, so a "y" typed without Enter goes too and no buffered answer can
approve a title not yet on screen. Piped answers are untouched. The pty behaviour has no automated test — the sandboxed
suite cannot allocate one; check it by hand after touching this. A
`resuming` file (half patched) and an `awaitingVerification` one (all written,
killed before its `patched` record) each get their own "finish fixing"
question, and refusals from the rehearsal count in the exit code. `scripts/scope-subs.sh` and
`scripts/scope-subs.applescript` wrap it as a Desktop app for one machine; they
ship in the package (`files`) so a deploy updates them.

`verify` picks its payload method from the file sizes: equal sizes get a
parallel byte diff that must land entirely inside PGS position fields; differing
sizes get `mkvextract` + SHA-256 per elementary stream (`--hash-streams`, on by
default in that case). Exit 0 on PASS, 7 on FAIL.

Exit codes follow PRD §20: 2 bad arguments, 3 missing dependency,
4 unsupported media, 5 PGS parse error, 6 remux failure, 7 validation failure,
8 output conflict. `apply` ranks them 7 > 6 > 8 across a whole run.

## Toolchain

ESM, TypeScript strict, pnpm. One runtime dependency: commander. The supported
floor is `engines.node` `>=22.12` (what commander 15 needs) — the suite and the built CLI are verified there,
and that is the number `doctor`, the README and the Dockerfile use. `.nvmrc` /
`.node-version` pin **24**: that is the development default, not the
requirement, and the two are meant to differ.

The commands shell out to mkvmerge, mkvextract and ffmpeg; the integration tests
skip themselves when those are not installed. **Every spawn site resolves its
executable through `src/tools/locate.ts`** — env override, then `PATH`, then a
short list of common install directories — so `doctor` reports the same binary a
real run would use. Add a new external tool there, never as a bare string at the
call site.

**Platforms.** macOS is where it is used; on Linux the suite passes (Ubuntu
24.04 in a container, ARM64 and x64, 2026-11-26) and the CLI builds and runs. On Windows the suite
passes (850 passed, 59 skipped as Unix-only, on Windows 11 ARM64 with Node 22,
2026-11-23), and the desktop app builds to an NSIS installer that was
installed and used by hand there (folder drop, a cancelled scan, copy and
in-place fixes, restores). An interactive `review` at a console, a file held
open by another program, and an x64 build have not been tried. What Windows needed: `locate.ts` takes the
platform, the environment and a `ToolProbe` (Windows names, `Path`/`PATHEXT`,
`windowsToolDirs`); `isNetworkPath`/`mountTableKnown` treat UNC paths as
network and ask PowerShell (`Win32_LogicalDisk` DriveType 4, cached five
minutes, `setDriveQuery` in tests) which drive letters are mapped — a failed
query means "unknown", so dates get the full watch; the engine's temp folder
is set through `TEMP`/`TMP` there (`tempEnvVars`); `discardTypeahead` does
nothing on Windows; `plan.json` saves retry a refused rename (`writePlan`,
`renameRetrying`, Windows only) and a file another program holds fails its
title with `inUseHint`. **Stored relative paths are `/`-separated on every
platform** (`storedRelative`: the plan's `relative`, `patches/<n>.json`); a
no-op on POSIX, and Windows `join` reads either separator. Tests that need
POSIX (execute-bit stubs, `chmod` read-only fixtures, shell-script tools)
are `skipIf(process.platform === "win32")` with the reason
beside them. The build is `scripts/build.mjs` (no `rm`/`chmod` in
`package.json`), so it runs under cmd.exe and PowerShell.

```bash
pnpm install
pnpm test        # vitest run
pnpm typecheck   # tsc, includes tests
pnpm build       # scripts/build.mjs: empty dist/, tsc, chmod +x dist/cli/main.js
pnpm dev         # tsx src/cli/main.ts
pnpm pack        # prepack builds; produces scope-sub-<version>.tgz
```

## Deployment

- `Dockerfile` — multi-stage, `node:22-slim`, distro `mkvtoolnix` + `ffmpeg`,
  entrypoint `scope-sub`. `docker-compose.yml` is the worked example: library
  read-only at `/media`, read-write `/work`.
- `scripts/deploy.sh <user@host> [--dir …] [--dry-run]` — pack, scp,
  `npm install -g` (user prefix when not root), remote `doctor`. It refuses
  while Scope Subs is running on the remote (exit 4), and fails (exit 5) unless
  the installed tool reports the version just packed, checked under the PATH
  the Scope Subs app uses (`scope-subs.sh --print-path`). POSIX sh.
- `scripts/bench-reader.mjs` — measures the direct MKV reader's strategies
  against a real file; needs `pnpm build` first.
- `scripts/scope-subs.sh` / `scripts/scope-subs.applescript` — the "Scope Subs"
  Desktop app: Terminal runs `review` against the kept plan, then copies the
  plan and its snapshots to a mirror. Nothing it does may make a copy of the
  plan worse: rsync runs without `--delete`, snapshots are dated folders
  (`logs/before-check-<UTC>/`, the newest ten kept), and both the snapshot and
  the mirror step are gated on `check_plan` — `plan-show` reads the plan, every
  patch file it names exists and parses, and it lists no fewer titles, patch
  files or log bytes than the newest snapshot or the mirror. There is no
  override; a copy that is the odd one has to be moved aside by hand. A tool
  that cannot start is reported as that, never as a damaged plan. It traps
  INT/TERM/HUP around `review` with a handler (not "ignore", which the tool
  would inherit) and ignores them afterwards, so an interrupt still reaches
  the mirror step. It has no automated test: exercise it with a stub
  `scope-sub` under a fake `$HOME` and a mounted disk image as the library (it
  insists on a mount point). Built on the target with `osacompile` (README,
  `review`). Shipped in the package, unlike the other scripts.
- `CHANGELOG.md` — one entry per release. A release bumps one number in five
  places: `package.json`, `src/report/version.ts`, and the app's
  `desktop/package.json`, `desktop/src-tauri/tauri.conf.json` and
  `desktop/src-tauri/Cargo.toml` (+ its entry in `Cargo.lock`). The app has no
  version of its own.

Fixtures are synthetic: `src/pgs/fixtures.ts` builds valid .sup bytes from a
declarative spec, so no real disc material is committed. `test/batch/support.ts`
fabricates a `FileAnalysis` from one, so the batch decision table is testable
without touching a filesystem. `samples/` (scratch
data), `*.sup` and `*.mkv` are gitignored.

## PGS format cheat sheet

1. A `.sup` file is a flat list of segments. Header: `"PG"` | PTS u32be (90 kHz)
   | DTS u32be | type u8 | size u16be, then `size` payload bytes.
2. Inside MKV the same segments appear in block payloads with **no** 13-byte
   header: just type u8 | size u16be | payload; the block timestamp is the PTS.
3. `0x16` PCS: canvas size, composition number/state, palette id, then N
   composition objects (object id, window id, flags, x, y, optional crop rect).
4. `0x17` WDS: window rectangles. `0x14` PDS: palette id/version plus
   (entry, Y, Cr, Cb, alpha) entries. A PDS **replaces** the palette it names —
   ffmpeg's `pgssubdec`, what Kodi decodes with, clears it first — so an entry
   the PDS does not list is fully transparent whatever an earlier PDS in the
   epoch said. `paletteUpdate` does not change that.
5. `0x15` ODS: object id/version, fragment flag (**0x80 first, 0x40 last**,
   0xC0 both — that way round, as in the spec and ffmpeg's `pgssubdec.c`).
   The first fragment carries data length u24, width u16, height u16.
6. Objects over ~64 KB of RLE are always fragmented; concatenate every fragment
   before decoding. `0x80` END terminates a display set.
7. Bitmap RLE, per line: `C != 0` = one pixel of index C; `C == 0` then `L`:
   `L == 0` end of line, else `L & 0xC0` selects short/long zero run or
   short/long coloured run.
8. Display set = PCS, then WDS/PDS/ODS in any order, then END. Epoch = from an
   epoch-start PCS until the next one; objects, palettes and windows persist
   across display sets within an epoch.
9. An event (a displayed subtitle) is a display set whose PCS has >0 objects;
   a PCS with 0 objects clears the screen. Its end time is the next display
   set's PTS.
10. Repairs must change only PCS object x/y and WDS window x/y. Never re-encode
    bitmaps; segment sizes must stay identical so the patch is byte-minimal.
