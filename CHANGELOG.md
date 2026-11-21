# Changelog

All notable changes to `scope-sub`. Dates are ISO; versions follow
[semantic versioning](https://semver.org/).

## Unreleased

## 0.9.0 — 2026-11-26

### Handling for plans made by development versions is removed

This is the version the first public release is made from. Up to here the
tool had one plan folder to look after, and it carried rules for entries and
fixes written by each of its earlier versions. That plan has been brought up
to date, and those rules are gone:

- The two rule counters recorded in a plan start again at 1: the one on each
  entry (`area_rules`) and the one on each fix (`placement_rules`). The
  mechanism stays. When a later version changes a rule, it can check again
  only the titles that change affects, once.
- A plan that does not record which rules made it (`tool.rules`) is refused
  with a message that says so. Before, a plan from 0.2.0 was accepted.
- A half-written copy under the name older versions used
  (`<output>.partial`) is no longer removed. The tool removes only files
  under its own name (`<output>.scope-sub-partial`).
- `scripts/rebuild-plan-from-patches.mjs` is removed.
- The Scope Subs script no longer reads the single snapshot and the lock
  folder that 0.2.0 made.
- The app has the same version number as the engine.
- A `Release` workflow builds the macOS app, the Windows installer and the
  command-line package for a version tag and drafts a GitHub release. The
  macOS app is signed and notarized when the signing secrets are set. The app
  now carries the two entitlements its engine needs under the hardened
  runtime; without them a notarized build would not start its engine.

Earlier entries below describe the tool as it was at the time, including
things this version removed.

## 0.8.1 — 2026-11-26

### Follow-ups to 0.8.0, from its review

A subtitle drawn in two windows, moved in one and refused in the other, was
counted as fixed when it is not; a fix of such a title would then have
failed its own check. It is counted as left outside.

A title one of whose tracks was refused outright because its window could not
move — beside a track that was fixed — is one `remargin` will try again. And
when neither arrangement works, the refusal now gives both reasons.

Patch files record how their count of subtitles left outside was made
(`leftover_rules`). `remargin` no longer keeps an older fix because a fresh
analysis counts more left outside than the older, possibly too low, count
said. And a title whose earlier fix `remargin` kept is reported as kept, not
as fixed again.

## 0.8.0 — 2026-11-26

### Subtitles in a full-screen window can be moved

Every subtitle on a disc is drawn inside a declared window, and a fix has
always moved the window along with its subtitle. Some discs declare one
window the size of the whole screen for everything; that window cannot move
anywhere, so every subtitle in it was refused ("would put it off the
canvas") and the title was left with its subtitles in the bars. When the
window cannot move, the subtitle is now moved inside it and the window is
left where it is — allowed only when the subtitle still lies wholly inside
the window afterwards. A window that can move still does, so fixes already
made are unchanged.

A title recorded as needing a fix that nothing could make is analyzed again,
once, on the next run. A title fixed in part is one `remargin` will try
again only when what was left outside — some subtitles of a fixed track, or
a whole track beside one — was refused for this reason; any other leftover
would come out the same.

Every fix is now also checked for the one thing this arrangement could get
wrong: a finished file may have no more subtitles lying outside their own
window than the original had (`verify`, and `apply`'s own check for plans
made from this version on).

## 0.7.4 — 2026-11-26

### The reader treats a file's index as a hint, and refuses what it cannot time

Three hardenings of 0.7.3's reader change. An index entry that points at
nothing readable no longer stops a file that is otherwise in order. A file
whose timing information turns up only after its subtitle data, with a scale
other than the one already used, is refused: before, its subtitle times were
reported wrongly without a word (positions were never affected). And a header
that claims an impossible size is refused before any memory is set aside for
it.

## 0.7.3 — 2026-11-26

### Files that keep their track list after the video can be read

Some muxers write a Matroska file's track list after its video and audio data
and leave a pointer to it in the index at the start; MakeMKV 1.9 did. The
tool's reader expected the list first and refused such a file ("cluster
reached before the Tracks element"), so its subtitles were never checked. The
reader now follows the index — to a second index when the first only points
at one, and for the file's timing information as well — and reads the file as
any other. A file whose index does not say where the list is gets a refusal
that says so.

## 0.7.2 — 2026-11-24

### A fixed film put back from a backup is noticed whatever its date

Restoring the unfixed file over a fixed one usually brings its original date
with it (Finder, Time Machine, `rsync -t` and Windows all copy that way), and
then nothing about the file's size or date said it had changed: it stayed
listed as fixed, with its subtitles back in the bars. `plan` and `review` now
read one changed position from each fixed file on every run, which is enough
to tell, and offer such a title for fixing again.

### Windows

The test suite passes on Windows 11, and the desktop app builds to an
installer and has been used there. A network path is recognised as one before
it is resolved (Windows could wait many seconds for a server that was not
there), and `rebuild-plan-from-patches` finds MKVToolNix and maps Windows
paths.

## 0.7.1 — 2026-11-23

### Groundwork for Windows

Nothing here has run on Windows yet; it is what could be prepared and tested
without a Windows machine, and macOS and Linux behave exactly as before.

- `pnpm build` and `pnpm pack` run a Node script (`scripts/build.mjs`) instead
  of `rm -rf … && tsc && chmod +x …`, so they work under cmd.exe and PowerShell.
- The tool search knows Windows: `mkvmerge.exe` and friends, `Path` and
  `PATHEXT`, the MKVToolNix installer's folders, a hand-unpacked FFmpeg and the
  WinGet, Chocolatey and Scoop shims. `SCOPE_SUB_MKVTOOLNIX_DIR` and
  `SCOPE_SUB_FFMPEG` accept Windows paths, quoted or not, and `ffmpeg` without
  `.exe`.
- A UNC path or a mapped network drive counts as a share (one PowerShell query,
  kept for five minutes), so a kept file date is watched there and not on a
  local disk.
- The engine's own temp folder is set through `TEMP` and `TMP` on Windows,
  where `TMPDIR` is ignored. Child programs start without a console window.
- `plan.json` is saved with a few retries when Windows refuses the rename (an
  antivirus or the indexer holding the new file), and a title whose file is in
  use by another program fails with that said, not as a bare EPERM.
- The relative paths a plan stores (`relative`, `patches/<n>.json`) are written
  with `/` on every platform.
- `review` skips its terminal typeahead drain on Windows, which has no
  `/dev/tty`.

### The app

- A folder dropped on the app's icon while it is starting is now opened once
  the setup check finishes; it could be lost before.
- The setup screen now says whether a tool is not installed or is installed but
  cannot be used (found but would not run, or an FFmpeg that cannot decode
  video), instead of always "not installed".
- A title's opened row no longer shows the engine's bookkeeping notes (kept
  patch files, adopted header edits, replaced fixes, redone margins).
- Windows groundwork: the sidecar build follows the host (`.exe` and the
  Windows target triple), a Windows build would make an NSIS installer
  (`tauri.windows.conf.json`; the macOS build is unchanged), and the reveal
  button and home-folder shortening follow the platform ("Show in Explorer",
  "Show in folder"). No Windows build has been made yet.

## 0.7.0 — 2026-11-23

### The command line's wording was revised

Everything the commands and the Scope Subs script print was gone over the
way the app's wording was: titles are *scanned* (in `plan` and `remargin`,
*analyzed*), a fix is *verified*, a fix is *reverted* and a date *restored*, a
title the tool passes over is *skipped*, and the files it writes to are *the
original files*. "Repair" is "fix" throughout, as in the command's name.
Questions became statements ("Check that the library is mounted."), dry runs
all end "Dry run: … Pass --execute to …", and an option that several commands
share is described the same way in each. `review` no longer says subtitles
"move up": some move down.

The reasons and notes the tool stores in a plan directory follow the same
wording: a title left alone for a changing picture is now "variable aspect
ratio: no single picture area applies", and the notes `plan` and `remargin`
recognise on later runs changed with it ("fix redone for the margin", "header
edits only, media unchanged"). **A plan directory written by an earlier
version is not converted automatically.** Its entries keep their old wording
until the files change, and two things read that wording: a `remargin` run
stopped half way under the earlier version is no longer recognised as half
done (run it to the end before upgrading), and the note naming the undo data
of a file that was since re-ripped is not carried to its next entry (the
patch file itself stays on disk).

## 0.6.3 — 2026-11-23

### The app's wording was revised

Every message, label and button in the desktop app was rewritten in a plainer,
more conventional style, with one word for each thing: titles are *selected*
and *scanned*, a fix is *verified*, an original is *restored*, and what the app
keeps to make that possible is its *undo data*. Statuses are short ("Subtitles
outside picture", "No changes needed", "Variable aspect ratio"). The warnings
about fixing original files in place say the same things as before. The
messages the engine sends about missing or unusable tools changed to match.

### A folder can be dropped on the app

Dropping a folder anywhere on the app's window scans it, exactly as choosing
it with "Choose folder…" does; the window shows "Drop folder to scan" while
one is dragged over it. On macOS a folder can also be dropped on the app's
icon in the Dock or in Finder. Anything but one folder is refused with a line
saying so, and nothing is opened while a scan or a fix is running.

## 0.6.2 — 2026-11-23

### Setup checks what the tool needs now, and the app names the shape it judges by

- `doctor` no longer checks for ffmpeg's `cropdetect` filter, which nothing
  has used since 0.6.0. Its `frames` line has ffmpeg decode one generated test
  frame to 16-bit grey exactly as `--aspect auto` decodes a film's frames, and
  fails, saying why, when it cannot. The engine protocol is now `3`:
  `doctor`'s `report.cropdetect` is `report.frames`, and its problem
  `what: "cropdetect"` is `"frames"`.
- The desktop app says when a title is judged by the narrowest picture shape
  it keeps returning to (a film with IMAX scenes), on its row and when opened.
- The documentation now says plainly which commands change original files
  (`review`, `remargin --execute`, `revert --in-place` and
  `restore-dates --execute` as well as the two `apply` options).
- pnpm is pinned (`packageManager`), and `.gitignore` covers the tool's own
  partial and backup files.

## 0.6.1 — 2026-11-23

### A verdict nothing ever measured is checked once

A plan rebuilt from its patch files (`rebuild-plan-from-patches
--infer-skips`) records every title the lost plan had not repaired as "fine",
whatever the lost plan's reason was — including titles it had left alone
because the picture seemed to change shape. Such an entry has no picture area
on record, and an unchanged file is never analyzed again, so it kept that
verdict for good. `plan` and `review` now analyze each of them again, once.
On a large library that first run is long: a title with black bars has its
subtitles read in full.

## 0.6.0 — 2026-11-22

### The picture is measured pixel by pixel, so dark scenes no longer confuse it

To find a film's picture area the tool samples frames and measures the black
bars in each. It used ffmpeg's `cropdetect` for that, which judges a row by
its average brightness: a dark scene, or a bright one with dark edges, came
back as a smaller picture. A film with many dark scenes showed a dozen
different "shapes" and was left alone as having a changing picture. That
included films with IMAX scenes (The Dark Knight, First Man) and films that
do not change shape at all (Clue, Chicken Run, The Irishman).

Each sampled frame is now measured by the tool itself, every pixel on its
own: a row is picture when a few of its pixels are clearly above black, and
even a very dark scene has film grain that is. With that:

- a dark frame that still comes out smaller counts towards the shape it lies
  inside, instead of as a shape of its own;
- a film that shows more than one shape is sampled twice as densely before it
  is judged, so a short run of taller scenes is seen more than once;
- a scope film with only a little IMAX footage is judged by its scope shape;
  before, it could be taken for a film with no bars at all;
- measuring is much faster: a few seconds per film, not minutes.

`plan` and `review` analyze each title recorded as "mixed aspect ratio" again,
once. Titles already judged as one constant shape are not looked at again;
on the library this was developed against, all 167 of them measure the same
as before to within two rows.

## 0.5.0 — 2026-11-22

### Films with IMAX scenes are no longer left alone

A film whose picture changes shape was always skipped. One that alternates
between clear, repeated shapes — scope for most scenes, taller for the IMAX
ones — is now judged by the narrowest of them: a subtitle outside that shape
is moved inside it (when it can be moved at all), so it no longer sits in the
black bars during the scope scenes. During the taller scenes a moved subtitle
simply sits a little further in. The rule is deliberately narrow: the scope
shape must be seen more often than any other, the taller shape clearly taller on both
sides, and at least 12 samples usable. A film that is one shape plus the odd
different sample, a taller film with scope inserts, or one shape seen with
dark edges is left alone as before.

`plan` and `review` analyze each title recorded as "mixed aspect ratio" again,
once, and `review` says which shape a fix is judged by when it asks.

`verify` now fails when the fixed file's own picture area cannot be
determined though the original's could, instead of passing with nothing
checked.

## 0.4.4 — 2026-11-22

### A title an older version could not repair is looked at once more

A title recorded as having subtitles outside the picture, none of which could
be moved, kept that verdict for good: an unchanged file is never analyzed
again. Since 0.3.0 a near-transparent fill no longer counts as part of a
subtitle, and some of those titles need no repair at all. `plan` and `review`
now analyze such an entry again, once, when it was judged by an older version
and nothing was ever written for it.

### The desktop app can keep each movie file's date

Fixing a movie file in place, or putting a fix back, moves the file's date,
so a media server may show the film as newly added. With in-place fixing on,
the app now offers a second setting, "Keep each movie file's date" (off by
default, remembered between launches). With it, a fixed or put-back file gets
the date it had. On a network share that takes a little waiting: the share
dates a change some time after it is made, so the app says "Checking file
dates… up to N seconds" at the end of a run, once; Cancel ends the wait after
a fix (putting a fix back has no Cancel and waits it out).
A date that could not be kept is noted on that title; the fix itself still
counts.

For engine clients: in-place `apply` and `revert` take `keepDates`, send one
`apply.dates` / `revert.dates` event before such a wait, and report
`dateNotKept` on a file whose date could not be kept
(`docs/engine-protocol.md`).

## 0.4.3 — 2026-11-22

### `--preserve-dates` now holds on a network share

A share does not date a write when it is made. macOS closes a file on an SMB
server lazily and the server stamps the write when that close arrives,
measured at 40 to 95 seconds later. A date put back before then was silently
replaced by the time of the write, while the client went on reporting the
date it had been asked for. `revert --in-place`, which sets the date straight
after writing, lost it every time; so did `remargin`, which starts with one.

The tool now watches for that:

- Every file whose date it put back is watched in the background, while the
  run goes on, until 150 seconds after the tool last touched it, and the date
  is set again if the share replaces it. A run ends by waiting for the files
  it wrote last, so it waits once, up to 150 seconds, not once per file;
  `remargin` waits once for all its titles. The wait is announced.
- A date that could not be kept, or a watch cut short, is a warning and a
  line on that file's result (in `remargin`, its summary), never a failed
  repair.
- The finishing record of a write notes the date that was kept. A later write
  to a file that carries the earlier write's own stamp puts the kept date
  back, not the stamp, so `remargin` no longer loses the date between its
  undo and its repair.
- `restore-dates` accepts a file whose date is the stamp of this tool's last
  write, so a date that did not hold can still be put back.
- Local disks are not watched. When the mount table cannot be read the file
  is watched anyway, and `mount` is now looked for in `/sbin` as well as on
  `PATH`.

## 0.4.2 — 2026-11-22

### A tall subtitle no longer has to leave the margin on both sides

A subtitle outside the picture was refused when it was taller than the
picture minus the margin top and bottom. At the 24 px default that turned
away things that had fitted at 8: pop-up picture tracks and vertical columns
of Japanese text, a little under the height of the picture. Because one
refused subtitle makes a track's repair worse than the one it has, `remargin`
then kept the whole title at its old margin.

The margin now gives way. A subtitle too tall to keep it on both sides is
centred in the picture, which is the most margin there is room for. Only one
taller than the picture itself is refused. Subtitles that fit are placed
exactly as before.

- `verify <original> <copy>` judges a copy by the current rule, so a copy an
  earlier version made while refusing such a subtitle now reports it as still
  outside. Repair the title again to clear it.
- `remargin` now also redoes, once, a repair that left subtitles outside under
  the earlier rule, whatever its margin: the new rule may be able to move
  them. Patch files record the generation of the rule (`placement_rules`).
- A title `remargin` analyzed again and kept as it was is no longer put back,
  read and repaired again on every later run. The plan entry records what was
  tried (`redo_tried`), and the title is tried again only for another margin
  or a newer rule.

## 0.4.1 — 2026-11-22

### File dates

A repair written into a file moves its modification date to the time of the
write, as any edit does. A media server that sorts "recently added" by that
date then lists every repaired title as new.

- `--preserve-dates` on `apply --dangerously-in-place`, `revert --in-place`,
  `review` and `remargin` puts each file's date back once the write is done
  and verified. It is off by default. The date is logged before the first
  byte is written, so a run that is killed and finished later still puts the
  right one back.
- `scope-sub restore-dates <plan-dir>` puts back the dates of files already
  repaired without it, to the date the plan recorded before its first write
  to each. A dry run unless `--execute` is given. Only dates change. A file
  whose date is no longer the one this tool's last write left is skipped.
- Scope Subs: `SCOPE_SUBS_PRESERVE_DATES=1` in the config turns the option on,
  and `scope-subs.sh --restore-dates` runs the restore under the usual lock,
  snapshot and mirror.

With `--preserve-dates` a repaired file has the same size and date as the
original, so `plan` cannot tell from those alone that an original was put
back from a backup. `revert --in-place --execute` still notices and records
it.

## 0.4.0 — 2026-11-21

### Moved subtitles land higher, and existing repairs can be redone to match

- The default margin is 24 px on a 1080-high canvas (was 8), scaled with the
  canvas as before. At 8 the descenders of a moved line sat almost on the edge
  of the picture. `--margin` still overrides it.
- `scope-sub remargin <library> --plan <dir>` redoes the repairs a plan made
  with another margin, one title at a time: the title is put back to its
  original bytes from the undo record, analyzed again and repaired again in
  place, using the same verified steps as `revert --in-place`, `plan` and
  `apply --dangerously-in-place`. A dry run unless `--execute` is given.
  - Everything that could stop the run is checked before a file is touched:
    that the plan can be extended with these options, that each title is found
    under the given paths, that the tools work.
  - It never trades a repair for something worse. If the new analysis would
    not repair the title, or would move fewer subtitles or leave more outside,
    the plan keeps the entry it has and the title is repaired as before; the
    run says which titles and why.
  - A stopped run can be run again at any point, and at most one title is
    without its repair while it runs. An in-place write that never finished
    is finished first.
  - Exit 0 only when every title is at the new margin; 1 when some were kept
    as they were; 4 when a title was left with a problem.
  - Titles planned but never repaired are planned again; a repair that lives
    in a copy elsewhere is left alone and listed. Old patch files stay on disk.
- `scope-subs.sh --remargin` runs it under the Scope Subs lock, with the
  snapshot before and the copy to the mirror after, and asks before changing
  anything.
- A plan made with the old default still extends: its margin was recorded as
  "the default", and each patch file records the margin its repair actually
  used. Without `remargin`, earlier repairs stay as they are and only new
  titles get the new margin.
- `runPlan` takes `remargin`, and `revertPlan` takes `only` (exact paths).

## 0.3.1 — 2026-11-21

### 10-bit video never showed its black bars

- `--aspect auto` asked ffmpeg's `cropdetect` for `limit=24`, which it takes as
  a raw sample value whatever the bit depth. Black in 10-bit video is 64, so
  every UHD title read as full-frame: "no letterbox bars", subtitles not read,
  verdict OK. The limit is now a fraction of full scale (24/255) and scales
  with the bit depth.
- **A plan looks at those titles again, once.** Entries now record the
  detector generation that produced them (`area_rules`). An unchanged title
  larger than 1920x1080 whose verdict is a plain OK from the old detector
  (full-frame, or inferred with no active area) is re-analyzed on the next
  `plan` or `review` run and said so in the log; everything else is reused as
  before. Expect that run to read every such scope title in full.

### Pointing the app at MKVToolNix and FFmpeg by hand

- Desktop: "Locate it myself…" lets you point the app at MKVToolNix (a folder)
  and FFmpeg (a file). The choice is remembered, shown as "chosen by you", and
  can be given back to the automatic search. It is also available from the
  "Ready" details.
- Engine protocol: new `configure` method; `doctor` returns `chosen` and marks
  problems with `locate`. A chosen tool that is missing or does not work is
  reported even when another copy was found.
- The tool search finds `mkvmerge.exe`, `mkvextract.exe` and `ffmpeg.exe` on
  Windows.

### Fixing the original files from the app

- Desktop: an opt-in "Fix the original files (no copies)" mode, off by
  default, behind a warning that must be ticked and confirmed. While it is on
  there is a persistent red banner, a red "Fix N originals in place" button,
  and a question before every run.
- Desktop: "Put the original subtitles back" for any title fixed in place,
  with a confirmation and a verified result. A fix interrupted mid-write is
  shown after the next scan with "Finish fixing" and "Put it back".
- Desktop: "Show the undo records"; the app never rebuilds a saved scan that
  holds in-place undo records.
- Engine protocol: `apply` accepts `mode: "in-place"`; new `revert` method;
  new error codes `not-writable` and `undo-records`; new skip kind
  `needs-copy` for titles that have to be rebuilt. Protocol version unchanged.
- Fixed: an error message quoting a capitalised movie title could be mistaken
  for a system error.

## 0.3.0 — 2026-11-21

### Hardening after a review of everything that can cost an undo record

Plans, patch files and the apply log are unchanged in format; a plan written by
0.2.0 is extended as it is.

- `plan` no longer reuses a patch file's name for a title the apply log
  mentions. An interrupted run after a re-rip, or a re-rip of a title whose
  repair is a copy elsewhere, could overwrite an undo record. The old file is
  kept and named in the new entry's notes.
- A title that cannot be read during a check keeps the verdict it had
  (`unreadable` in `plan`'s output) instead of becoming an ERROR entry. A share
  dropping mid-run used to cost every remaining verdict. `review` exits
  non-zero when any title could not be checked.
- A `plan.json` that cannot be written stops the run cleanly, with one error
  and no workers left running.
- A repaired title whose unrepaired file was restored from a backup at the
  same size is recognised (`restored`) and can be fixed again.
  `revert --in-place --execute` records the same thing.
- A title adopted after a header edit can be patched in place even when its
  earlier repair is a copy elsewhere. Both still revert.
- `apply`: a verified record counts only for the output path it names; a
  failed attempt elsewhere no longer forgets a verified copy; an output folder
  that cannot be created fails that title only; a failed `--replace-original`
  swap undoes itself; copies are written to `<output>.scope-sub-partial`, and
  an unrelated `<output>.partial` is never deleted; a cancel during read-back
  or verification stops at once and removes the output.
- The `started` record of an in-place write is fsynced before the first byte
  is written. `plan` reports in-place writes that never finished
  (`unfinished`).
- `review` at a terminal: an answer counts only if typed after its question,
  including a stray "y" typed without Enter.
- `rebuild-plan-from-patches` accepts patch files by rules generation, not
  tool version.
- `doctor` and `engines.node` require Node 22.12, which is what commander 15
  needs.

### Scope Subs and `deploy.sh`

- Scope Subs never deletes from a copy of the plan. `rsync` runs without
  `--delete`, snapshots are dated (`logs/before-check-<UTC>/`, the newest ten
  kept), and the mirror only gains files. An old `logs/before-last-check` is
  left in place and still read.
- Before a snapshot is taken, and again before the mirror is written, the plan
  must pass an integrity check: every patch file it names exists and parses,
  and it has no fewer titles, patch files or log bytes than the newest snapshot
  or the mirror. There is no override; a copy that is the odd one is moved
  aside by hand.
- A tool that cannot start is reported as an installation problem, not as a
  damaged plan. A second Ctrl-C no longer skips the mirror. Two runs started
  together can no longer both take the lock. Paths are compared by their
  physical location, and a plan directly in `$HOME` or `/` is refused.
- Scope Subs has no built-in paths any more. `SCOPE_SUBS_LIBRARY` and
  `SCOPE_SUBS_PLAN` are required and `SCOPE_SUBS_MIRROR` is optional; all three
  can be set in `~/.config/scope-subs/config`. Without them it says what to put
  there and checks nothing. **An existing install needs that file written once.**
- `deploy.sh` refuses while Scope Subs is running on the remote, and fails
  unless the installed tool reports the version just packed under the PATH the
  app uses.

### `serve` and the desktop app

- The app's `apply` can no longer be pointed into the library by a symlink,
  another spelling of the folder, or a parent folder; output folders are judged
  by real path and device/inode.
- `overwriteOutput` is removed from the engine protocol (now version 2); the
  protocol never overwrites an existing file.
- Quitting the app mid-fix stops the engine cleanly: no orphaned mkvmerge or
  mkvextract, no unfinished copy, no temp files. The engine keeps scratch files
  in its own `scope-sub-engine-<pid>` temp folder and sweeps those of dead
  engines.
- A fix that will not fit (output volume, or temp space for rebuilt titles) is
  refused up front with a plain message (`no-space`).
- Skipped titles carry `skipKind`; a run refused for space or missing
  originals is no longer shown as a success. A fix that fails part-way keeps
  and shows the titles already done.
- Titles a scan could not read are marked as not checked.
- `plan` refuses a plan directory inside a scanned folder; `apply` refuses a
  plan with an unfinished `--replace-original` swap.
- The autopilot test hook is compiled out of release builds, and the window
  has no shell permissions.
- The app is named Scope Sub Fixer.

### `serve`: the engine for a desktop app

- `scope-sub serve --stdio` runs the engine as one long-lived process: JSON-lines
  requests on stdin, responses and live progress events on stdout. Methods are
  `hello`, `doctor`, `plan`, `apply`, `cancel` and `shutdown`
  (`docs/engine-protocol.md`). Its `apply` only ever writes copies into an
  output folder outside the library.
- `runPlan` and `applyPlan` take an optional `onProgress` hook and an
  `AbortSignal`. The existing commands pass neither and behave as before.
- `runPlan` takes `remuxFallback`: in a patch plan, a title patching cannot
  repair in full (compressed subtitle tracks, a cluster CRC-32) is planned for
  remux on its own, the rest stay patches. Off unless asked for, recorded in
  the plan's options, and part of what decides whether a plan can be extended.
  `apply` reports a remux's phases and can cancel one cleanly.

### `review`: keep a library fixed as titles are added

- `scope-sub review <library> --plan <dir>` re-plans the library into a plan
  directory kept for good (only new or changed titles are analyzed), says what
  each new title is, asks `Fix "<title>" in place? [y/n]` for every title that
  needs fixing — new ones and ones declined before — and repairs exactly the
  approved ones with `apply --dangerously-in-place`. Piped answers work: one line
  per question, end of input is no. Answers must be an explicit y or n — Enter
  presses typed during a long check re-ask rather than decline — a half-patched
  file is asked about as one to finish, refusals count in the exit code, and a
  library that turns out empty (not mounted?) stops the run.
- `apply` takes `only` (programmatic): the planned inputs to include, the rest of
  the plan left out of the run.
- `scripts/scope-subs.sh` and `scripts/scope-subs.applescript` make that a
  double-click Desktop app on a Mac: one run at a time; refuse unless the
  library is a mount point, mounted read-write, and the plan exists; keep the
  plan and log from before each check; run `review`; mirror the plan's folder
  only onto another mounted filesystem, never onto a share's root. Both ship in
  the package.

### A plan outlives releases, renames and runtimes

- `plan` refused to extend a plan written by any other version of the tool, so
  the next release would have locked every kept plan behind `--reanalyze`. It
  now compares a rules generation (`tool.rules` in `plan.json`,
  `PLAN_RULES_VERSION`), bumped only when old and new verdicts must not be
  mixed; 0.2.0's plans count as the current generation.
- File stamps within a millisecond of each other are equal: a plan written by the Node
  build and one written by the desktop app's bun build each saw every file of
  the other's as changed.

### A near-transparent fill no longer counts as drawn

- Avatar (2009)'s forced Na'vi translations are full-frame objects whose every
  pixel outside the text is near-black at alpha ~1: invisible, but counted, so
  each was "1080 px tall", outside a 2 px top bar, and the title came out
  `NEEDS_FIX` with all 82 events refused. A pixel now counts as drawn from
  alpha 16 (`MIN_VISIBLE_ALPHA`), and the title scans OK. Existing plan entries
  keep their old verdict until re-analyzed; one like Avatar's was a skip, so
  nothing was ever written on the strength of it.

### Scope Subs: an interrupt, a damaged plan and typed-ahead answers

- `scripts/scope-subs.sh` ended with the tool on Ctrl-C, skipping the mirror
  without a word: titles fixed before the interrupt had their undo record on
  one machine only. It now carries on to the mirror (and says "Interrupted").
- It copied `plan.json` over the `before-last-check` copy before knowing it was
  readable, then mirrored with `--delete` whatever the check's outcome: one run
  on a damaged plan replaced both good copies. It now refuses to start on a plan
  `plan-show` cannot read, snapshots the whole plan directory (`patches/` too,
  which a check can now rewrite) and stops if that fails, and does not mirror a
  plan that cannot be read after the run.
- `review`: a fix whose bytes were all written before the run died — during the
  verification, the long part — was offered as `Fix "…" (declined before)`, and
  declining left it patched, unrecorded and unmentioned. It is now asked as
  `Finish fixing "…"?` (`awaitingVerification` on the apply result), and
  declining warns and exits 6, like a half-patched file.
- `review` discards what was typed at the terminal before its first question
  (`discardTypeahead`) and says so: a `y` entered during an hours-long check
  approved the first title unseen. Piped answers are untouched.

### `plan` recognises a header edit and does not read the file again

- A library whose MKVs had an attachment and tags added with `mkvpropedit`, the
  mtime put back afterwards, had every one of those titles re-read in full, over SMB, on
  the next check, and the repaired ones among them would have been
  `superseded` — their undo records cut loose — because another size meant
  another file. `plan` now checks first whether only the headers changed: same
  mtime (within a second), same video size and PGS tracks, same Segment UID once
  one is on record, and for an entry with byte patches every patched range still
  holding the original or the repaired bytes where the plan recorded them. Such
  an entry is kept and only its recorded size updated, in the entry and in its
  patch file (`adopted` in the result and in `plan --format json`; `review` says
  how many). A repaired title needs the byte check alone — not the mtime, nor
  an unchanged track list — so a flag, name or language set in a header editor
  no longer warns "changed since this plan last wrote it" on every later run
  (same size) or cuts the undo record loose (another size).
- Entries now record the Matroska `segment_uid` (optional; older entries gain it
  when next analyzed or adopted). The plan schema and tool version are unchanged,
  so an existing plan is extended, not refused.

### `plan` no longer re-analyzes the files its own apply wrote

- Re-planning a library after a repair re-analyzed every repaired title (its
  mtime had changed), and the fresh entry reused the old entry's patch file name
  — overwriting the only record of the bytes that were changed, so `revert`
  could no longer put them back. `plan` now carries the entry of any file its own
  `apply` or `revert` wrote (in place, by `--replace-original`, or an in-place
  run that never finished), untouched. `patched`, `replaced` and in-place
  `reverted` records log the file's size and mtime after the write, so an
  unchanged file is reused quietly and one something else has changed since is
  kept with a warning (`keptChanged` in the result and in `plan --format json`).
- `plan`'s per-file "unchanged" lines are now debug-level: on a large
  library they were a line of noise per title on every run. The summary
  still counts them, and the result lists what was analyzed (`analyzedFiles`).
- A repaired file that has since become another size is another file (a patch
  never changes one) — a re-rip. It was kept as "repaired" forever and never
  checked; now it is `superseded`: analyzed afresh under a new patch file name,
  with the old undo record left on disk and named in the log and the entry.
- `--reanalyze` still keeps the entries this plan repaired, and a transient
  failure (a share that dropped for a moment) no longer replaces one with an
  ERROR entry.

### `plan` never forgets an entry

- `plan` wrote only the entries for the files it found on that run. Planning a
  single file into a library's plan, planning a subset, or planning while the
  share was not mounted — an unmounted share is an empty local folder — dropped
  every other entry at the first save, undo records included. Entries for files
  a run does not find are now carried as they were and counted (`notFound`).

### Interrupted in-place writes can always be finished

- A `revert --in-place` killed part way left a half-reverted file that `revert`
  refused (half-and-half) and `apply` skipped (still logged as patched). It now
  logs `started` before writing; `revert <plan> --in-place` finds such a file and
  finishes it, or `apply --dangerously-in-place` finishes it the other way.
- `apply --dangerously-in-place` no longer skips a title because an earlier
  copy-mode run wrote a repaired copy elsewhere; checks the input is writable
  before logging that a write started; and copy mode accepts a file the tool
  rewrote in place (then reverted) despite its moved mtime — the copy checks
  every patched range's bytes anyway.

### `apply --dangerously-in-place`: repair the films themselves, without a copy

- `apply` could only repair into a copy, and `--replace-original` then kept the
  original beside it — a full read, a full write and a second full-size file per
  title, for a repair of a few kilobytes. `--dangerously-in-place` writes the
  planned bytes into each input itself through the small `r+` writes
  `revert --in-place` already used: no copy, no backup, no `--output-root`.
  The plan directory becomes the only undo record, and the flag's name says so.
- It keeps every other rule. A dry run unless `--execute`; the same pre-flight;
  every changing range read and checked against the plan's `before` bytes before
  the first write (one wrong range refuses the file untouched, exit 7); every
  written range read back; the PGS re-read and verified against the plan's
  fingerprint as a copy is, with the original bytes written straight back when
  it does not verify. `--skip-verify` drops that last, whole-file read.
- The log gains a `patched` record, which resume and `revert` treat like
  `replaced`: a rerun skips the file, and `revert <plan> --in-place` puts it
  back. A run killed mid-write leaves some ranges repaired and a `started`
  record with nothing after it; the next run recognises its own half-done file
  (`lastInPlaceWrite`), lets the byte scan stand in for the now-changed mtime,
  and finishes it. The same state with no such record is refused.
- `APPLY_EXIT` moved to `src/batch/exitCodes.ts` (still exported from
  `apply.ts`), so `apply` can use revert's in-place writer without an import
  cycle.

### Adding `--recursive` no longer throws a plan away

- `plan` counted `--recursive` as one of the options that must match for an
  existing plan's entries to be reused, so a library planned flat and then
  rerun with `-r` was analyzed again from scratch. The flag only changes which
  files are found and where their output lands, never what the analysis of a
  file says, and the reuse path already recomputes the output paths. It is no
  longer part of the check: a rerun with `-r` analyzes only the files it newly
  finds, and the plan records the new setting.

### A killed plan run no longer drops the entries it had not reached

- `plan` wrote `plan.json` with no entries before its first file and put each
  reusable entry back only when the worker reached it, so a run killed during
  file *k* lost every old entry after *k* — during the first file, the whole
  plan. Every reusable entry is now carried from the first save on, under the
  target's current root and output path, and confirmed or replaced in turn.
  A kill at any point leaves each file with this run's verdict or the old one.

### A plan that cannot be reused is refused, not overwritten

- When the existing plan did not match — another tool version, or a different
  `--aspect`, `--margin`, `--method` or fast-path setting — `plan` warned and
  went on, and its first save rewrote `plan.json` with no entries. A run
  interrupted after that had thrown the old plan away, whether or not it had
  been applied and was somebody's undo record. `plan` now refuses with the
  differences spelled out (`the plan at <dir> was built with aspect 2.39 (this
  run: auto) and its 981 entr(ies) cannot be reused; pass --reanalyze to replace
  it, or choose another --plan directory`) and exits 2. `--reanalyze` is the
  explicit way to replace it, as before.
- `scripts/rebuild-plan-from-patches.mjs` recovers from a plan that was emptied
  this way: every `patches/<n>.json` still names its input and carries all that
  `apply` executes, so the fix entries are rebuilt from them (track flags from
  `mkvmerge -J`, video and active area from the patch file). `--map old=new`
  moves the inputs to another path of the same files, such as a read-only
  mount of the share. The skip entries are not in the patch files, but when the
  run that wrote them finished and the library has not changed since,
  `--infer-skips` recovers them the other way round: every MKV directly under
  `--root` with no entry was a skip, NO_PGS or OK by its container header. A
  file with a compressed PGS track, or whose patch file was refused, is left
  for `plan` to analyze, and a file modified after the run is refused. A
  following `plan` run reuses every rebuilt or inferred entry and analyzes
  only the rest.

## 0.2.0 — 2026-09-02

### The ODS fragment flags were inverted

- `SEQUENCE_FLAG.FIRST` and `.LAST` were swapped: **0x80 is the first fragment**
  (the one carrying `object_data_length`, width and height) and **0x40 the
  last**, as in the Blu-ray spec and ffmpeg's `pgssubdec.c`. A single-fragment
  object is 0xC0 — both bits — which is why the bug was invisible on every title
  whose bitmaps fit in one segment.
- The symptom was an object over ~64 KB of RLE: its real first fragment was read
  as a continuation with no geometry, so the display set was refused with
  `ODS continuation fragment for object N has no first fragment` and every event
  in it skipped. On *(500) Days of Summer* that was six of the largest subtitles.
- `src/pgs/types.ts` holds the constants and everything derives from them, so
  the parser, the serializer, the fixture fragment emitter and the reassembler
  were all corrected by the one change.

### The margin no longer moves subtitles that are already inside

- **`TOUCHING_BOUNDARY` is informational.** An event needs a fix only when at
  least one pixel of its visible rectangle falls *outside* the active area
  (PRD §10.3). A subtitle sitting inside but within `--margin` px of an edge is
  counted and reported, and then left exactly where the author put it.
- The margin is now used for one thing only: where an overflowing subtitle lands
  (`active.bottom - margin` / `active.top + margin`), per PRD §10.1-§10.4.
  Raising it changes how far a repair travels, never how many there are.
- Scan reports gained a separate `touching_boundary_event_count` (JSON) and a
  matching human line; `offending_event_count` now means overflow alone.
  `plan`'s `expected_offending_after`, `apply`'s output check and `verify`'s
  `stillOutside` all read the same `needsFix`, so all three moved together.
- On *(500) Days of Summer* this alone removed 91 spurious 7 px nudges of top
  subtitles that were never outside the picture.

### The active-area estimator no longer under-reads dark scenes

- `detectActiveArea` took the smallest bars *within the modal cluster*. On a
  film that is mostly dim at the frame edges, cropdetect trims a few rows off
  almost every sample, so the modal cluster is itself too small: *(500) Days of
  Summer* is a 2.35:1 transfer (y=131..948) that reported as 2.40 (y=140..940).
- cropdetect never includes a bar row — the bars are pure black and it only ever
  trims — so the largest picture any sample shows is the true one. The CONSTANT
  estimate now takes the minimum top bar and the minimum bottom bar over every
  valid sample, requiring each value to be seen at least twice (within
  tolerance) so a single frame's dirt or garbage line cannot widen the picture.
  With no value repeating at all, the modal cluster's value stands, as before.
- `MIXED_ASPECT_RATIO` / `UNKNOWN` classification is unchanged — it is about
  consistency, not the estimate — but is computed on the same data.
- The new `estimate` block in the JSON report shows the modal values, the chosen
  values, and every distinct edge with the number of samples that agreed, so a
  reader can see exactly what happened. A note says so when the two differ.

### Plan reuse is invalidated by the tool version

- `plan` reused an entry whenever size, mtime and options matched. The tool
  version now counts as one of those options: a plan built by an older build was
  produced by different geometry code, so its verdicts and byte patches are not
  this build's. Such a plan is re-analyzed with
  `reanalyzing: built by scope-sub 0.1.0`.

Also shipping in 0.2.0, previously listed as unreleased:

### `scope-sub revert` — the plan directory is the undo record

- **New command.** `patches/<n>.json` records every byte a repair changed as
  `offset`, `before` and `after`, so the undo is the same list run backwards
  rather than a second guess at the geometry (`src/batch/revert.ts`).

  ```
  scope-sub revert <plan-dir> [--file <substr>] [--in-place | --output-root <dir>]
                   [--execute] [--format human|json]
  scope-sub revert --patch-file <patches.json> --target <fixed.mkv>
                   [--in-place | --output <out.mkv>] [--execute]
  ```

- It locates each repaired file from `apply.log.jsonl` and refuses unless the
  file is exactly the one the plan describes: the size must match and every
  patched range must still hold the `after` bytes. Anything else is refused with
  the offset (exit 7); a file that already holds the `before` bytes everywhere is
  reported *already original* and skipped. Dry run until `--execute`.
- **`--in-place` writes only the changed bytes** — a few thousand two-byte writes
  and a re-read of those same ranges, rather than a whole-file copy. On a 17 GB
  title: 1.7 s against the 31 s the repair itself took. `--output-root` instead
  produces a verified copy through the same `copyWithPatches` `apply` uses.
- A `reverted` record is appended to `apply.log.jsonl`. An in-place revert makes
  that file count as not applied, so `apply --execute` repairs it again, over the
  file it reverted, without `--overwrite-output`.

### A title with no letterbox bars is no longer read

- `scan` and `plan` resolve the active area before opening the PGS tracks, so
  when it turns out to cover the whole coded frame — a 16:9 transfer — the tracks
  are not read at all: nothing can be outside an area that is the whole frame.
  That is a full sequential pass over tens of gigabytes skipped per title.
- Only that exact geometry qualifies. A 1.85:1 title has ~20 px bars, which is
  ample room to hide a subtitle in, and is still read; so are `UNKNOWN` and
  `MIXED_ASPECT_RATIO` detections, which report the full frame but mean "we do
  not know".
- Such a file reports `OK` with the note `no letterbox bars detected (1.78:1);
  PGS tracks not read`, and `plan` records it as `skip` with that reason. The
  per-track event count is *unknown* rather than zero: `event_count` is now
  omitted from the plan entry, `null` in the JSON report, and "not read" in the
  human one.
- `scan --full` and `plan --no-fast-path` force the read. A plan built one way is
  not reused by a run of the other.

## 0.1.0 — 2026-09-02

First release: the four milestones of `PRD.md`, plus everything needed to run
the result somewhere other than the machine it was written on.

### Milestone 1 — read the format

- PGS (`.sup`) parser, serializer and RLE codec, with display-set and epoch
  composition (`src/pgs/`). Segment sizes are preserved exactly, so a repair is
  a byte-minimal edit rather than a re-encode.
- MKV inspection through `mkvmerge -J`, plus a direct Matroska block reader
  that walks the container itself to find the PGS blocks and their absolute
  byte offsets, with no subprocess and no temp file (`src/mkv/`). It defaults
  to streaming the file, which measured fastest on every transport;
  `--read-strategy adaptive` transfers ~3% of the bytes instead, more slowly.
- Synthetic fixtures (`src/pgs/fixtures.ts`): no disc material is committed.

### Milestone 2 — decide what is wrong

- Active-area geometry from a declared aspect ratio or from sampled `ffmpeg`
  `cropdetect` (`--aspect auto`), with clustering tolerance (`src/video/`).
- Overflow classification and the relocation policy, including the safe margin
  (`src/geometry/`), and the single analysis pipeline every command runs
  (`src/scan/analyze.ts`).
- `scope-sub scan`: read-only analysis, human or JSON report.

### Milestone 3 — fix one film

- `scope-sub fix` with two methods: `patch` rewrites only the PCS object and
  WDS window `x`/`y` fields in place, and `remux` extracts, rewrites and
  rebuilds through `mkvextract`/`mkvmerge` (`src/fix/`). `patch` refuses
  compressed tracks and CRC-32 clusters and says to use `remux`.
- `scope-sub verify`: container comparison, a parallel byte diff for
  equal-sized files, per-stream SHA-256 otherwise, and a positionless PGS
  fingerprint comparison (`src/verify/`).

### Milestone 4 — fix a library

- `scope-sub plan` / `plan-show` / `apply` (`src/batch/`): a reviewable plan
  directory carrying every byte edit and a per-track fingerprint, an
  append-only transaction log with a resume rule, and an `apply` that is a dry
  run until `--execute`, verifies every output before it counts, and can swap
  originals aside under `--replace-original`.

### Deployment

- **`scope-sub doctor`**: checks the Node version against `engines`, locates
  `mkvmerge`, `mkvextract` and `ffmpeg` and prints their versions, confirms
  this `ffmpeg` build has `cropdetect`, and probes the scratch directory for
  writability and free space. Exits 3 when anything required is missing.
- **One place decides which binary runs** (`src/tools/locate.ts`): the
  environment overrides `SCOPE_SUB_MKVTOOLNIX_DIR` and `SCOPE_SUB_FFMPEG`, then
  `PATH`, then a short list of common install directories. Every spawn site
  goes through it, so `doctor` reports the binary a real run would use.
- **`engines.node` is now `>=22`** (was `>=24`); the full test suite and the
  built CLI are verified on Node 22.
- **Packaging**: `files`, a `prepack` build that also sets the executable bit
  on `dist/cli/main.js`, and a tarball that installs with `npm install -g`.
- **Docker**: a multi-stage `Dockerfile` on `node:22-slim` with `mkvtoolnix`
  and `ffmpeg` from the distro, a `.dockerignore`, and a `docker-compose.yml`
  that mounts the library read-only.
- **`scripts/deploy.sh`**: pack, `scp`, `npm install -g` on the remote (into a
  user prefix when not root) and a remote `doctor`, with `--dry-run`.
