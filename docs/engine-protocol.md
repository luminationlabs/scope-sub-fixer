# The engine protocol

`scope-sub serve --stdio` runs the engine as one long-lived process for a GUI.
The desktop app in `desktop/` is its only client. The message types are
defined in `src/serve/protocol.ts`. This document describes them in prose.

## Transport

JSON lines, UTF-8, one message per line, in both directions.

- The client writes **requests** to the engine's stdin.
- The engine writes **responses** and **events** to stdout. Nothing else is
  written to stdout in this mode.
- When stdin closes, the engine stops any running job and exits, so an engine
  is never left working after its client has gone. The same happens when the
  client's end of stdout closes: the engine stops writing, stops the job and
  exits.

```
→ {"id": 1, "method": "plan", "params": {"paths": ["/movies"], "planDir": "/plans/a"}}
← {"id": 1, "event": "plan.targets", "data": {"total": 212, "files": [...]}}
← {"id": 1, "event": "plan.file-start", "data": {"index": 0, ...}}
← ...
← {"id": 1, "result": {...}}
```

| Message | Shape |
|---|---|
| request | `{"id": <number or string>, "method": "...", "params": {...}}` |
| result | `{"id": ..., "result": {...}}` |
| error | `{"id": ..., "error": {"code": "...", "message": "..."}}` (`id` is `null` when the line could not be read as a request) |
| event | `{"id": ..., "event": "...", "data": {...}}`. It carries the id of the request it belongs to. `ready` has no id. |

Every request gets exactly one result or error. A request's events arrive
before its result or error.

On start the engine sends `{"event": "ready", "data": {name, version, protocol, methods}}`,
the same data `hello` returns. `protocol` is `3`. It is increased when a message changes incompatibly:

- 1 → 2: `apply` no longer takes `overwriteOutput`, and gained `skipKind`,
  `no-space` and the real-path output check.
- 2 → 3: `doctor`'s `report.cropdetect` became `report.frames`, and its
  problem `what: "cropdetect"` became `"frames"`.

Error codes: `bad-request`, `unknown-method`, `busy`, `dependency-missing`,
`plan-file`, `unsafe-output`, `no-space`, `not-writable`, `undo-records`,
`failed`.

## Temporary files

While it runs, the engine keeps every temporary file, its own and those of the
programs it starts, in its own folder, `<system temp>/scope-sub-engine-<pid>`.
It does this by setting `TMPDIR` (on Windows, `TEMP` and `TMP`) to that folder.
A clean exit removes the folder. An engine that was killed cannot remove it, so
each start removes the folders of engines that are no longer running, judged
by the process ID in the name. `doctor`'s `tempDir.path` is this folder.

## Methods

### `hello`

Returns `{name, version, protocol, methods}`.

### `configure`

Tells the engine where MKVToolNix and FFmpeg are, when the user chose them by
hand. A GUI app does not inherit a shell's environment, so this replaces the
`SCOPE_SUB_MKVTOOLNIX_DIR` and `SCOPE_SUB_FFMPEG` variables of the command
line. The engine sets those variables from the choice, so every later
`doctor`, `plan` and `apply` uses the chosen tools.

Params: `{"tools": {"mkvtoolnixDir"?: <path> | null, "ffmpeg"?: <path> | null}}`.

- **Each call replaces the whole choice.** A key that is left out or `null`
  puts that tool back on the automatic search. `{"tools": {}}` clears
  everything.
- `mkvtoolnixDir` is the folder that holds `mkvmerge` and `mkvextract`. A path
  to one of those programs, or to a macOS `MKVToolNix….app`, is taken to mean
  the folder they are in. `ffmpeg` is the program itself; a folder that holds
  it is also accepted. On Windows the programs are looked for as
  `mkvmerge.exe`, `mkvextract.exe` and `ffmpeg.exe`.
- Only the shape of the request is checked here. A path that does not hold a
  working tool is accepted and then **reported by `doctor`**.
- It is refused with `busy` while a job runs, because the job chose its tools
  when it started.
- The choice lasts as long as the engine process. A client that restarts the
  engine sends it again before anything else. The engine stores nothing.

Returns `{"tools": {…the choice as given…}}`. An engine that does not list
`configure` in `hello`'s `methods` answers `unknown-method`. The protocol
number did not change when it was added.

### `doctor`

Runs the same checks as `scope-sub doctor`. Returns:

```
{ "ok": false,
  "report": { ...the DoctorReport of `doctor --format json`... },
  "problems": [ {"what": "ffmpeg", "message": "FFmpeg was not found. ...", "fix": "Install FFmpeg: ...",
                 "locate": "ffmpeg"} ],
  "chosen": { "mkvtoolnixDir": "/Applications/MKVToolNix-97.0.app" } }
```

`problems` restates the report for a person: one entry for each thing they
must fix (MKVToolNix counts once for both of its programs), with what to do.
`what` is the tool name (or names), `"frames"`, `"temp"` or `"runtime"`.
`problems` is empty exactly when `ok` is true. A problem that choosing the tool
by hand could solve has `locate`: `"mkvtoolnix"` or `"ffmpeg"`.

`chosen` is what `configure` last set. A tool in `report.tools` with
`origin: "env"` is the chosen one. `"path"` and `"extra"` mean the automatic
search found it.

**A chosen tool that does not work is a problem even when the search found
another copy.** If a chosen folder does not hold `mkvmerge` and `mkvextract`,
or a chosen file is missing, is not a program, will not run, or is an FFmpeg
that cannot decode a frame the way the picture is measured (`report.frames`),
there is a problem that says so in plain terms ("The selected MKVToolNix
folder (…) does not contain mkvextract.") and `ok` is false. So `ok` can be
false while `report.ok` is true. A client should not start a `plan` or `apply`
then, because it would use tools other than the ones the user chose.

### `plan` (a job)

Scans files and folders and writes the plan folder, as `scope-sub plan` does.
It only reads the media files.

Params: `paths` (required), `planDir` (required), `recursive` (default
**true**), `aspect` (a positive number or `"auto"`, default `"auto"`), `jobs`
(a whole number, at least 1), `reanalyze` (default false), `remuxFallback`
(default false).

A `planDir` that is, or is inside, a folder being scanned is refused with
`unsafe-output`, because the plan folder is written after every file and must
not be among the titles. As with the output folder below, this is judged by
what the path is on disk, not how it is spelled.

`remuxFallback` is decided **per title**. A title that the byte patch cannot
fully fix (its subtitle track is compressed, or its clusters have a CRC-32) is
planned for the slower remux instead, and its `FileView.method` says so. Every
other title stays a patch. The setting is part of how a plan folder was built:
asking for it on a plan built without it (or the reverse) is refused with
`plan-file`. Send `reanalyze: true` to rebuild the plan.

A plan built under other analysis rules, or with another aspect setting, is
also refused with `plan-file` rather than mixed with new results. Send
`reanalyze: true` to replace it.

**`reanalyze: true` is refused with `undo-records`** when the plan folder holds
undo data for files fixed in place, even though the engine underneath would
keep those entries. A client must not rebuild such a folder on its own, and
must tell the user rather than retry.

Events, in order:

| Event | Data |
|---|---|
| `plan.targets` | `{total, files: [{file, relative}]}`. Sent once, before the first file. |
| `plan.file-start` | `{index, file, relative}` |
| `plan.file-progress` | `{index, file, done, total}`: bytes read while the subtitle tracks are read, at most one event per percent. Not sent for a title whose tracks are not read. |
| `plan.file-done` | `{index, analyzed, file: FileView}`. `analyzed` is false when the result was reused from the existing plan. This `FileView` has no `fixed` or `interrupted`; the final result's `FileView`s do. |
| `log` | `{level: "error"\|"warn"\|"info", message}`: the engine's own log lines. |

Result: `{planDir, cancelled, analyzed, reused, missingPaths, unreadable,
undoRecords, summary: {files, fix, skip, byStatus}, files: FileView[]}`.

- `analyzed` and `reused` count the files read this run and the files whose
  earlier result was reused.
- `missingPaths` lists the requested paths that do not exist.
- `unreadable` lists inputs that could not be read this run (a share that
  dropped, a file that went away) and already had a result. That earlier
  result is kept, so their `FileView`s come from an earlier scan. They were not
  checked this time, and a UI must say so.
- `undoRecords` is the number of files this plan folder holds undo data for:
  files it wrote in place (fixed, restored, or interrupted). While it is not 0,
  the folder is the only way back for those files.
- `files` lists every file this run found, in plan order. Entries for files
  the run did not find are left out.

A `FileView` is one title, shaped for a UI:

```
{ "input": "/movies/A (2020)/A (2020).mkv",     // the key `apply` takes
  "relative": "A (2020)/A (2020).mkv",           // where its copy goes under the output folder
  "title": "A (2020)",
  "size": 31234567890,
  "status": "NEEDS_FIX",        // NO_PGS | OK | NEEDS_FIX | MIXED_ASPECT_RATIO | AMBIGUOUS | ERROR
  "action": "fix",              // fix | skip
  "method": "patch",            // patch: the copy is the original with a few bytes changed.
                                // remux: the file is rebuilt with mkvmerge (slower, a different size)
  "reason": "...",              // why it is skipped, when it is
  "video": {"w": 1920, "h": 1080},
  "activeArea": {"top": 138, "bottom": 942, "aspect": 2.39, "classification": "CONSTANT"},
  "eventsOutside": 412,         // subtitle events outside the picture, all PGS tracks
  "eventsToMove": 412,          // what the fix would move
  "tracksToFix": 3,
  "bytesChanged": 3296,
  "tracks": [ {"id": 3, "language": "eng", "name": "English", "forced": false,
               "eventCount": 1502, "eventsOutside": 204, "status": "NEEDS_FIX", "action": "fix"} ],
  "notes": [],
  "fixed": {"output": "/fixed/A (2020)/A (2020).mkv", "time": "..."},  // only when the plan's log records
                                                                        // a verified copy that is still there;
                                                                        // with "inPlace": true the fixed file is
                                                                        // the original itself (output == input)
  "interrupted": {"doing": "fix", "time": "..."}  // an in-place write to this file started and did not
}                                                 // finish ("fix" or "undo"): it may be half changed
```

`activeArea.classification` is `CONSTANT` or `MIXED_NARROWEST` for a picture
area the engine can fix by. A track's `eventCount` is absent when the track was
not read (a title with no letterbox bars), and a track may have a `reason`.
A title with `interrupted` must never be shown as fine. Either an in-place
`apply` ("finish fixing") or `revert` completes it.

### `apply` (a job)

`apply` has two modes. `copy` is the default. `in-place` must be asked for by
name.

**`mode: "copy"`** (or no `mode`) writes a fixed **copy** of each chosen title
under `outputRoot` and verifies it, as `scope-sub apply --output-root …
--execute` does. The original files are never written.

- `only` is required. Nothing is fixed unless it is listed.
- `inPlace`, `replaceOriginal`, `dangerouslyInPlace`, `skipVerify` and
  `overwriteOutput` are refused by name (`bad-request`). The protocol cannot
  write over an existing file: a file already at an output path is always a
  `conflict` for that title.
- `keepDates` is refused (`bad-request`): a copy never changes the original's
  date.
- If none of the files in `only` is planned as a fix, the request is refused
  with `bad-request`.
- The output folder is checked before anything is written. It is refused with
  `unsafe-output` when any chosen title's copy would be written
  - inside any folder the plan scanned (not only that title's own), or
  - onto any title of the plan, either by path or because the file already at
    the output path *is* one of the originals (same device and inode).

  The check uses real paths. Symbolic links are resolved (for the part of the
  path that exists), and every folder from the output path upwards is compared
  with the scanned folders by device and inode. A symbolic link into the
  library, another spelling of it on a case-insensitive volume, and a parent of
  the library that holds a folder of the same name are all refused, like the
  library itself. A parent of the library is allowed when no copy would be
  written inside the library.
- If the plan's log holds an unfinished `--replace-original` swap for a chosen
  title (the command line was stopped between its two renames), the request is
  refused with `plan-file`. Finishing that swap is a rename into the library,
  which the protocol never does.
- Before the first title, the whole request is checked for space (`no-space`,
  with a message for the user). The output volume needs the copies' sizes plus
  2%. For titles planned as `remux`, the engine's temp folder needs the size
  of the largest one, because a rebuilt copy's streams are extracted there to
  be compared with the original's. When both are on one volume, the amounts
  are added. Titles that will not be written (a copy is already at the output
  path) are not counted, and a volume whose free space cannot be read is not
  checked. A dry run is not checked.
- Before the first title, an unfinished copy that this plan's log shows was
  being written into this output folder when an earlier run was killed is
  removed, and a `log` event says so. Only a file with the engine's own
  partial-file name, at the path given by the log's `started` record, is ever
  removed.

Params: `planDir`, `outputRoot`, `only` (all required), `mode` (`"copy"`, the
default), `dryRun` (default false: check everything, write nothing).

**`mode: "in-place"`** changes the chosen original files, as `scope-sub apply
--dangerously-in-place --execute` does, and keeps no copy. From then on the
plan folder is the only undo data for those files (see `revert`).

- It is selected by `"mode": "in-place"` and nothing else. A request without
  `mode` is a copy request and needs `outputRoot`. Leaving `outputRoot` out is
  an error. `inPlace` and `dangerouslyInPlace` stay refused by name, as do
  `replaceOriginal`, `skipVerify` and `overwriteOutput`, in both modes. A
  client written before this mode existed therefore cannot reach it.
- `outputRoot` is refused (`bad-request`). `only` is still required, and a
  request in which no file is planned as a fix is refused as for a copy.
- Only the plan's own inputs are written, at the offsets recorded in the plan's
  patch files. The protocol adds no other way to write a file.
- **A title planned for `remux` is refused, per title**, because a rebuilt file
  cannot be written over its original. Its `ApplyFileView` is `skipped` with
  `skipKind: "needs-copy"` and a reason. It is never fixed into a copy instead,
  and a client must not show it as done.
- Before anything is written (not for a dry run), every chosen file is checked
  for write access. If any cannot be written (a read-only share, a file this
  user may not change), the whole request is refused with `not-writable` and a
  message for the user, and nothing is started.
- For each file: every range the plan changes is read and must hold exactly the
  original bytes. For a write that an earlier run did not finish, each range
  may hold the original or the fixed bytes, and `resumed` says which case it
  was. A `started` record is synced to the log. The bytes are written and read
  back, and the subtitle tracks are read again and verified against the plan.
  **If that verification fails, the original bytes are written back** and the
  title is `failed`. `verified: true` means the changed file passed.
- A file whose size or modification time changed since the scan is `skipped`
  (`input-changed`) and not written.
- **`keepDates: true`** restores each changed file's modification date after
  its write and check, as `--preserve-dates` does. Without it the date changes,
  as with any edit. It must be a boolean. See [Kept dates](#kept-dates).

In place, `apply.file-progress` is sent once per title, with
`phase: "in-place"` and no byte counts. An in-place fix is a few thousand
small writes and a check, with no stages to report. Refused titles also get a
`file-start` and a `file-done`, numbered with the rest.

**Cancelling an in-place run:** the title in progress is always finished and
verified, because a write to an original file is never deliberately left half
done. No further title is started. The run then ends with `cancelled: true`. A
client should show that it is finishing the current title, so it does not look
stuck. If the engine is killed instead, the `started` record lets the next
in-place `apply` or `revert` finish the file, and `plan` reports it
(`FileView.interrupted`).

An in-place `ApplyFileView` has `inPlace: true` and `output` equal to `input`.
It has `resumed` (`"half-written"` or `"unverified"`) when it finished an
interrupted write, and `dateNotKept` (a sentence) when `keepDates` was asked
for and that file's date could not be kept.

Events:

| Event | Data |
|---|---|
| `apply.file-start` | `{index, total, input, relative}` |
| `apply.file-progress` | `{input, phase, done?, total?}`. For a patch title, `phase` is `copy` (with byte counts), then `read-back` and `verify` once each as they begin. For a remux title it is `analyze`, `extract`, `rebuild` and `verify`, once each, without byte counts. In place it is `in-place`, once. |
| `apply.file-done` | `{index, total, file: ApplyFileView}` |
| `apply.dates` | `{files, seconds}`. In place with `keepDates` only: at most once, after the last `file-done`, while kept dates are still being watched (see [Kept dates](#kept-dates)). |
| `log` | As for `plan`. |

Result: `{planDir, mode, outputRoot, dryRun, cancelled, summary: {planned,
applied, verified, skipped, failed, conflicts, bytesWritten}, files:
ApplyFileView[]}`. `mode` is `"copy"` or `"in-place"`. `outputRoot` is empty in
place.

An `ApplyFileView` is `{input, relative, output, status, reason?, skipKind?,
inPlace?, resumed?, verified, bytesWritten, sha256?, checks: string[],
elapsedMs, dateNotKept?}`. `status` is `applied`, `would-apply` (a dry run),
`skipped`, `conflict` (something is already at the output path) or `failed`.
`checks` has one line per verification step.

A `skipped` title has a `skipKind`. Only `already-done` is good news. A UI must
not show the others as a success:

| `skipKind` | Meaning |
|---|---|
| `already-done` | A verified copy from an earlier run is still at this output path. |
| `no-space` | The copy would not fit on the output volume. |
| `input-missing` | The original is no longer there (a disk or share that went away). |
| `input-changed` | The original's size or time changed since the scan. Scan again. |
| `needs-copy` | In place: the title must be rebuilt, which only a copy can be. |
| `other` | Anything else. `reason` says what. |

For a copy, `verified` is true only after the copy was read back, its hash
matched what was written, and its subtitles matched the plan's fingerprint
with the planned events inside the picture.

### Kept dates

`keepDates` is accepted by an in-place `apply` and by `revert`. On a network
share a date cannot be set only once. The share dates a write when the file is
closed, which on macOS can be a minute or more after the last byte, and this
replaces a date set in between. So each kept date is watched for up to 150
seconds after its file's write, and set again whenever it is replaced. On a
local disk there is nothing to watch.

The engine keeps **one watch per request**. Every title adds to it while the
run continues, and the engine waits for it **once**, after the last title and
before the result. A `revert` of many titles therefore waits once, not once per
title. If there is still time to wait, it first sends one event, `apply.dates`
or `revert.dates`, with `{files, seconds}`: how many files are still watched
and the longest the wait can take. A client should show that it is waiting, so
it does not look stuck. `cancel` ends the wait at once (after setting each date
one last time), and every file cut short gets a `dateNotKept`. A date that
could not be kept never changes a title's status: the fix or undo still
counts. Without `keepDates` there is no watch and no event.

### `revert` (a job)

Restores the original bytes of a file this plan fixed **in place** (or was
interrupted while fixing), from the plan folder's records. It is the undo for
`apply`'s in-place mode, and the reason that mode's plan folder must be kept.

Params: `planDir`, `only` (both required; `only` as for `apply`), `dryRun`
(default false), `keepDates` (default false; see [Kept dates](#kept-dates)).
`outputRoot`, `output`, `overwriteOutput`, `file`, `patchFile` and `target`,
the command line's other ways of choosing what to revert, are refused by name.

- If none of the files in `only` is a title this plan could have fixed, the
  request is refused with `bad-request`.
- Only an original that this plan wrote is restored. A title fixed as a copy
  is `skipped`, because its original was never changed. A title that was never
  fixed is also `skipped`.
- Each title is reverted on its own. A title whose full path is contained in
  another title's path cannot be singled out. It is `failed`, nothing is
  written, and the reason says to use `scope-sub revert --patch-file` instead.
- The checks are the same as for a fix, in reverse. Every range must hold
  exactly the fixed bytes (or, for an interrupted write, the fixed or the
  original bytes). The bytes are written and read back, and the file is then
  the original again, byte for byte. A file that something else has changed is
  refused.
- Before anything is written (not for a dry run), files that cannot be written
  refuse the whole request with `not-writable`.

Events: `revert.file-start` `{index, total, input, relative}`,
`revert.file-done` `{index, total, file: RevertFileView}`, and, with
`keepDates`, `revert.dates` `{files, seconds}` at most once after the last
`file-done`.

Result: `{planDir, dryRun, cancelled, summary: {asked, reverted, skipped,
failed}, files: RevertFileView[]}`. A `RevertFileView` is `{input, relative,
status, reason?, bytesChanged, checks: string[], elapsedMs, dateNotKept?}`.
`status` is `reverted`, `would-revert` (a dry run), `skipped` or `failed`. A
`reverted` file was read back and matched the original bytes.

`cancel` stops between titles. The title in progress is finished. `cancel`
also ends the wait for kept dates at once.

### `cancel`

Params: `{"id": <the plan, apply or revert request to stop>}`. Returns
`{cancelled: true}` at once when that job was running, and `false` otherwise.
The job then ends with its normal **result**, with `cancelled: true` and
whatever it finished.

- A cancelled `plan` abandons the file in progress and starts no other. It
  stops between two picture samples (an ffmpeg run that has started is left to
  finish, normally well under a second) or at the next block of the subtitle
  read. Every finished result is already in the plan folder. The interrupted
  file has none, so the next `plan` reads it again and reuses the rest.
- A cancelled copy `apply` stops the title in progress, at whatever stage it
  is in, and starts no other. That title reports `failed` with reason
  `cancelled`, and nothing of it is left: the unfinished copy is removed, a
  running mkvextract or mkvmerge is stopped, and its temporary files are
  removed. A patch title can be stopped during its copy, its read-back or its
  subtitle check. A remux title can be stopped during its analysis,
  extraction, rebuild or comparison. Only a title whose copy had already been
  checked and recorded before the cancel arrived is `applied`. The apply log
  gets a `failed` record for the stopped title, so the plan can be resumed as
  before.
- A cancelled in-place `apply` or `revert` finishes the title in progress
  first (see above).

A client should not depend on which of these a title reports in its last
moments, `applied` or `failed`/`cancelled`. It can rely on this: `applied` with
`verified: true` means a checked copy is at `output`, and anything else means
no copy is there.

### `shutdown`

Stops any job, waits for it to finish stopping, answers `{}` and stops reading.
Closing stdin does the same without the answer. A client should end the engine
in one of these two ways. Killing the engine leaves its unfinished copy, its
temp folder and any program it had started. Those leftovers are removed later
(the temp folder at the next engine start, the unfinished copy at the next
`apply` into the same output folder), but a clean stop leaves nothing behind.

## Jobs

`plan`, `apply` and `revert` share the plan folder, so the engine runs one job
at a time. A second job is refused with `busy`, and so is `configure`.
`hello`, `doctor`, `cancel` and `shutdown` are answered while a job runs. A
job's slot is free by the time its result or error is written, so the next job
can be sent as soon as that answer is read.

## Trying it by hand

```sh
printf '%s\n' '{"id":1,"method":"doctor"}' | node dist/cli/main.js serve --stdio
```
