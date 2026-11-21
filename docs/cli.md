# scope-sub: command-line reference

Some Blu-ray discs place their PGS (image-based) subtitles below the picture,
in the black letterbox bar of a 2.35–2.40:1 scope film. On a 16:9 TV the bar
is on the screen, so the subtitles can be seen. On a constant-image-height
projection setup the scope picture fills the screen and the bars fall into the
masking, so the subtitles cannot be seen. `scope-sub` finds those subtitles in
MKV files and moves them up into the picture.

It changes nothing else about the file: no re-encoding, no re-timing and no
resizing of subtitle images. By default it does not rebuild the container
either. The rule it follows comes from [`PRD.md`](PRD.md) §5 and §26: prefer
stream-level changes, and when anything is uncertain, do not change the file.
A file the tool is not sure about is skipped and reported.

Each PGS composition object and window has an `x`/`y` position. A fix rewrites
only those position fields. Timing, palettes and subtitle images stay
byte-identical, so the result can be verified against the original.

This document covers the command-line tool. The desktop app
([`desktop/README.md`](../desktop/README.md)) uses the same engine through
`scope-sub serve --stdio` ([`engine-protocol.md`](engine-protocol.md)).

## Requirements

- **Node 22.12** or newer. Development uses Node 24 (see `.nvmrc`).
- **MKVToolNix**: `mkvmerge` and `mkvextract`.
- **FFmpeg**: `ffmpeg`, to measure the picture area from sampled frames
  (`--aspect auto`, the default) and to build the test fixtures.
- **pnpm**, to build from source.

The tool looks for the three programs on `PATH` first. It then looks in
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/local/bin`,
`/snap/bin` and `/Applications/MKVToolNix.app/Contents/MacOS`. Two environment
variables are tried before the search: `SCOPE_SUB_MKVTOOLNIX_DIR` (the folder
that holds `mkvmerge` and `mkvextract`) and `SCOPE_SUB_FFMPEG` (the `ffmpeg`
program, or the folder that holds it).

On Windows the search reads `Path` and honours `PATHEXT`. Only `.exe` and
`.com` files count, because a `.cmd` shim cannot be started without a shell.
It then looks in `%ProgramFiles%\MKVToolNix`, `%ProgramFiles(x86)%\MKVToolNix`,
`%LOCALAPPDATA%\Programs\MKVToolNix`, `%ProgramFiles%\ffmpeg\bin` and the
WinGet, Chocolatey and Scoop shim folders. The two environment variables take
Windows paths, quoted or not, and `SCOPE_SUB_FFMPEG` works with or without
`.exe`.

Platforms: the test suite passes on macOS and on Windows 11 ARM64. Windows on
x64 has not been tested. The suite is being checked on Linux.

```bash
pnpm install
pnpm build          # compiles to dist/; the scope-sub command is dist/cli/main.js
node dist/cli/main.js doctor
```

During development, `pnpm dev scan …` runs the tool from source. The examples
below use `scope-sub`. If you have not installed the command, use
`node dist/cli/main.js` instead.

## Recommended workflow

Follow these steps in order. Each step tells you whether the next one is worth
doing, and nothing before step 9 changes your library.

```bash
# 1. Scan. Nothing is written.
scope-sub scan "/Movies/Ocean's Thirteen (2007).mkv" --show-events

# 2. Fix one film into a new file.
scope-sub fix "/Movies/Ocean's Thirteen (2007).mkv" \
  --output /scratch/oceans13.fixed.mkv

# 3. Verify that the new file differs from the original only where it should.
scope-sub verify "/Movies/Ocean's Thirteen (2007).mkv" /scratch/oceans13.fixed.mkv

# 4. Watch it. Check a few of the timestamps that scan reported, with the
#    projector in its scope mode. No tool can do this step for you.

# 5. Analyze the library and write a plan.
scope-sub plan /Movies --recursive --plan /scratch/plan1

# 6. Read the plan: every decision, and the reason for every skip.
scope-sub plan-show /scratch/plan1
scope-sub plan-show /scratch/plan1 --file "Ocean"

# 7. Dry run. This is the default, and it writes nothing.
scope-sub apply /scratch/plan1 --output-root /scratch/fixed

# 8. Write the fixed copies. Each one is verified before it counts.
scope-sub apply /scratch/plan1 --output-root /scratch/fixed --execute

# 9. Optional: put the fixed files in place of the originals, keeping each
#    original beside it. The swap is two renames, so the output root must be on
#    the same filesystem as the library.
scope-sub apply /scratch/plan1 --output-root /Movies/.scopefix \
  --execute --replace-original --backup-suffix .pre-scopefix
```

```bash
# 10. Undo. The plan folder is the undo data.
scope-sub revert /scratch/plan1 --in-place --execute
```

As titles are added later, `scope-sub review` repeats the process against the
same plan folder: it scans for new titles and asks yes or no for each one
that needs a fix. See [`review`](#review-paths---plan-dir--fix-new-titles-with-a-yesno-each).

Keep the plan folder from step 5. Step 10 needs it. See [Undo](#undo).

## Commands

| Command | What it does | Changes original files |
| --- | --- | --- |
| [`scan`](#scan-paths--scan-files) | Reports subtitles outside the picture | No |
| [`fix`](#fix-input---output-path--fix-one-film) | Writes a fixed copy of one film | No |
| [`verify`](#verify-original-fixed--compare-a-fix-with-its-original) | Compares a fixed file with its original | No |
| [`plan`](#plan-paths---plan-dir--analyze-a-library) | Analyzes a library into a plan folder | No |
| [`plan-show`](#plan-show-dir--read-a-plan) | Prints a plan | No |
| [`apply`](#apply-dir--carry-out-a-plan) | Carries out a plan | Only with `--replace-original` or `--dangerously-in-place` |
| [`revert`](#revert-dir--undo-a-fix) | Undoes a fix | Only with `--in-place` |
| [`review`](#review-paths---plan-dir--fix-new-titles-with-a-yesno-each) | Scans for new titles and fixes them in place, asking for each | Yes |
| [`remargin`](#remargin-paths---plan-dir--redo-fixes-made-in-place) | Redoes in-place fixes with the current margin and rules | With `--execute` |
| [`restore-dates`](#restore-dates-dir--restore-modification-dates) | Restores the dates of files fixed in place | With `--execute` (dates only) |
| [`doctor`](#doctor--check-the-tools) | Checks that the required tools work | No |
| [`serve`](#serve---stdio--run-the-engine-for-the-app) | Runs the engine for the desktop app | Only as the app asks |

Every command takes `-h, --help`. `scope-sub --version` prints the version.

### Options shared by several commands

| Option | What it does |
| --- | --- |
| `--aspect <ratio\|auto>` | The picture's aspect ratio (`2.39`, `2.39:1`, `16:9`), or `auto` to measure it from sampled frames. Default `auto`. |
| `--samples <n>` | Frames sampled to measure the picture with `--aspect auto`. Default 24. |
| `--tolerance <px>` | Clustering tolerance for the sampled frames (`--aspect auto` only). |
| `--margin <px>` | Distance kept between a moved subtitle and the picture edge. Default 24 px at 1080 lines. See [The margin](#the-margin). |
| `-r, --recursive` | Look in subfolders. |
| `--jobs <n>` | Files processed in parallel. |
| `--format <human\|json>` | Report format. Default `human`. |
| `--log-level <level>` | One of `error`, `warn`, `info`, `debug`, `trace`. Default `info`. |
| `--temp-dir <path>` | Scratch folder for extracted files, instead of the system temp folder. |

### `scan <paths...>` — scan files

Inspects each MKV, measures the picture area, reads the PGS tracks and checks
every subtitle event against the picture. It only reads.

| Option | What it does |
| --- | --- |
| `--aspect`, `--samples`, `--tolerance`, `--margin` | As above. |
| `-r, --recursive` | Look in subfolders. |
| `--jobs <n>` | Files scanned in parallel. Default 2. |
| `--show-events`, `--max-events <n>` | List the subtitle events outside the picture, with timestamps. Default 10 per track. |
| `--source <direct\|mkvextract>` | `direct` (the default) reads the subtitle blocks from the file itself. `mkvextract` extracts each track to a temporary `.sup` file. |
| `--read-strategy <…>` | How the direct reader reads the file. See [Read strategies](#read-strategies). |
| `--temp-dir <path>`, `--keep-temp` | Where extracted `.sup` files go, and whether to keep them. |
| `--full` | Read the PGS tracks even when the title has no letterbox bars. |
| `--format <human\|json>` | Report format. |
| `--log-level <level>` | Log detail. |
| `--fail-if-needed` | Exit 1 when something needs a fix. |

**Titles with no bars are not read.** When the picture fills the whole frame,
as in a 16:9 film, no subtitle can be outside it. `scan` then reports `OK`
without reading the PGS tracks, and adds a note:
`no letterbox bars detected (1.78:1); PGS tracks not read (pass --full to read them anyway)`.
This saves reading the whole file. Only a picture that fills the frame
exactly is treated this way. A 1.85:1 film has bars of about 20 px, which is
enough to hide a subtitle, so it is still read. Pass `--full` to read the
tracks of every title.

### `fix <input> --output <path>` — fix one film

Writes a fixed copy of one film. The input is never changed.

| Option | What it does |
| --- | --- |
| `-o, --output <path>` | The fixed file. Required unless `--dry-run` is given. |
| `--method <patch\|remux>` | How the fix is made. Default `patch`. See [Patch and remux](#patch-and-remux). |
| `--track <id...>` | Fix only these mkvmerge track IDs. Default: every PGS track. |
| `--dry-run` | Report what would change and write nothing. |
| `--keep-original-subtitle` | A/B mode: keep the original tracks and add corrected copies named `[scope-fixed]` (remux only). |
| `--overwrite-output` | Replace an existing output file. |
| `--aspect`, `--samples`, `--tolerance`, `--margin` | As above. |
| `--temp-dir <path>`, `--keep-temp` | Scratch folder for the remux method, and whether to keep the corrected `.sup` files. |
| `--format`, `--log-level` | As above. |

### `verify <original> <fixed>` — compare a fix with its original

Compares container metadata, track flags, chapters, attachments and tags. It
then compares the PGS streams display set by display set with the positions
left out, so any change other than a position shows up. It also checks that
the fixed file has no more subtitles outside their own window than the
original had.

When the two files are the same size, it compares every byte, and every
difference must be inside a PGS position field. When the sizes differ, it
extracts each stream and compares SHA-256 hashes. It exits 0 on PASS and 7 on
FAIL.

`verify` reads both files several times (analysis, comparison and stream
hashing), so it takes a while on large files.

| Option | What it does |
| --- | --- |
| `--aspect`, `--samples`, `--tolerance`, `--margin` | As above. Use the values the fix was made with. |
| `--hash-streams` | Extract and hash every unchanged stream. This is the default when the file sizes differ. |
| `--no-hash-streams` | Never extract and hash streams. |
| `--expect-tracks <ids>` | mkvmerge track IDs in the fixed file that must have moved, for example `4,5`. |
| `--temp-dir <path>` | Scratch folder for extracted streams. |
| `--format`, `--log-level` | As above. |

### `plan <paths...> --plan <dir>` — analyze a library

Runs the same analysis as `scan` and writes a plan folder:

```
<dir>/plan.json          one entry per MKV: status, picture area, tracks, action, reason
<dir>/patches/<n>.json   for each file to be fixed: every byte that will change,
                         the moves per track, and a fingerprint of the subtitles
                         without their positions
<dir>/apply.log.jsonl    written later, by apply
```

`plan.json` says what will happen to each file and why. The patch files list
every changed byte.

| Option | What it does |
| --- | --- |
| `--plan <dir>` | The plan folder to create or update. Required. |
| `--aspect`, `--samples`, `--tolerance`, `--margin` | As above. |
| `-r, --recursive` | Look in subfolders. `apply` then copies the folder structure. |
| `--method <patch\|remux>` | The fix method the plan is built for. Default `patch`. |
| `--jobs <n>` | Files analyzed in parallel. Default 1. |
| `--reanalyze` | Ignore existing entries and analyze every file again. Entries for files this plan fixed are kept. |
| `--no-fast-path` | Read the PGS tracks even when the title has no letterbox bars. |
| `--source`, `--read-strategy` | As for `scan`. |
| `--temp-dir <path>` | Scratch folder for extracted `.sup` files. |
| `--format`, `--log-level` | As above. |

A file is planned as **fix** only when all of these hold:

- its status is `NEEDS_FIX`;
- its picture area is `CONSTANT` or `MIXED_NARROWEST`. `MIXED_NARROWEST` is a
  film whose picture switches between clear, repeated shapes, such as a scope
  film with IMAX scenes. It is judged by the narrowest shape, which must also
  be the one seen most often, so its subtitles end up inside every shape the
  film uses. A picture that changes without such a pattern is skipped as
  variable aspect ratio;
- at least one track has a subtitle that can be moved;
- for `--method patch`: the track is not compressed, and its clusters have no
  CRC-32.

Everything else is **skip**, with the reason recorded. A track that cannot be
fixed inside an otherwise fixable file is skipped on its own and noted. The
rest of the file is still fixed.

A title with no letterbox bars is skipped without its PGS tracks being read,
as in `scan`, and its entry says so. `--no-fast-path` reads them anyway. A plan
built with `--no-fast-path` and one built without it cannot share a plan
folder.

#### Running `plan` again

A plan folder can be used for one library for as long as you keep it.

- **Unchanged files are reused.** An entry whose file has the same size and
  modification time is not analyzed again. `plan.json` is saved after every
  file, so a run that is stopped loses at most one file's work.
- **Settings must match.** A plan built under different analysis rules (by a
  version whose rules have since changed, or one that does not record its
  rules), or with a different `--aspect`, `--margin`, `--method` or fast-path
  setting, is refused. Pass `--reanalyze` to replace it, or use another
  `--plan` folder. A new release does not by itself make a plan unusable.
  Adding `--recursive` to a plan built without it keeps every entry and
  analyzes only the newly found files.
- **Times are compared to the millisecond**, so plans written on different
  runtimes (Node and the app's engine) can be shared.
- **Files missing from a run are kept.** An entry for a file the run does not
  find (deleted, moved, outside the paths given, or on a share that is not
  mounted) is kept as it was and counted in the summary. Planning one file into
  a library's plan, or planning while the share is down, changes only that
  file's entry.
- **A file that cannot be read keeps its result.** If a title that already has
  a result cannot be read this run (for example, the share dropped), its old
  result is kept and it is reported as unreadable.

**Files this plan has written are not analyzed again.** A file that the plan's
own `apply` or `revert` wrote (fixed in place, swapped in with
`--replace-original`, reverted in place, or an in-place write that did not
finish) is never analyzed again. Its entry and patch file are its undo data,
and a new analysis of the fixed file would replace them. The log records each
file's size and time right after the write. An unchanged file is reused. A
file that something else changed since is kept, with a warning that its undo
data may no longer match. `--reanalyze` analyzes everything else again but
still keeps the entries this plan fixed.

There are exceptions:

- **A different size means a different file.** A fix never changes a file's
  size. A fixed file that now has another size (a new rip, for example) is
  analyzed again under a new patch file name. The old patch file stays on disk.
  The new entry's notes name it, and a `superseded` record is added to the log.
- **A fixed file put back from a backup is noticed.** On each run, `plan` reads
  one changed position from every fixed file. If every changed range holds the
  original bytes again, the title is recorded as reverted and can be fixed
  again. This works even when the restored file has the original's date.
- **Header edits are not a new file.** `mkvpropedit` can add an attachment or a
  tag without moving any subtitle data, and some tools then restore the
  modification time. Before treating a changed file as new, `plan` checks for
  this. For a title that was never fixed: the time must match the recorded one
  (within a second, since a share may round it), the file must still have the
  recorded video size and PGS tracks and, if recorded, the same Segment UID;
  and every range in its patch file must hold either the original or the fixed
  bytes. For a fixed title only the byte check counts, so changing a track's
  flags, name or language in a header editor does not lose its undo data. When
  the check passes, the entry is kept with its result and undo data, and only
  its recorded size and time are updated. It is listed as `adopted` (also in
  `plan --format json`) and noted on the entry. A fixed title whose bytes no
  longer match is kept and warned about on every run, or treated as a
  different file if its size changed. A title that was never fixed and whose
  time changed is analyzed again.

### `plan-show <dir>` — read a plan

Prints a table of file, status, action, tracks, events, position fields, bytes
and reason, with totals. It only reads.

| Option | What it does |
| --- | --- |
| `--only <fix\|skip\|all>` | List only files with this action. Default `all`. |
| `--file <substring>` | Show full per-track detail for matching files, including the first moves. |
| `--max-moves <n>` | Moves listed per track in that detail. Default 5. |
| `--format <human\|json>` | `json` prints the entries as JSON. |

### `apply <dir>` — carry out a plan

**`apply` is a dry run by default.** It prints what it would do and exits 0.
Only `--execute` writes anything.

| Option | What it does |
| --- | --- |
| `--output-root <dir>` | Folder the fixed copies are written to. Required unless `--dangerously-in-place` is given. |
| `--execute` | Carry out the plan. |
| `--jobs <n>` | Files in parallel. Default 1. Each file is a full copy, and more parallel copies usually make a NAS slower. |
| `--overwrite-output` | Replace files already under `--output-root`. |
| `--replace-original` | After verification, rename the original aside and put the fixed file in its place. Requires `--execute` and an `--output-root` on the same filesystem as the inputs. |
| `--backup-suffix <suffix>` | Suffix for the kept original. It must start with a dot. Default `.pre-scopefix`. |
| `--dangerously-in-place` | Write the fix into each original file. No copy, no backup, no `--output-root`. See [In place](#in-place---dangerously-in-place). |
| `--skip-verify` | With `--dangerously-in-place` only: skip the subtitle check after writing, which reads each whole file. |
| `--preserve-dates` | With `--dangerously-in-place` only: restore each file's modification date after writing. See [File dates](#file-dates). |
| `--stop-on-error` | Stop at the first failure instead of continuing. |
| `--format`, `--log-level` | As above. |

Each output keeps the input's file name, so a swapped-in file still matches
your media server's library. A plan built from single files or from a folder
without `--recursive` writes all copies directly into `--output-root`. A plan
built with `--recursive` copies the folder structure.

For `--replace-original`, use a staging folder on the same filesystem as the
library, such as `/Movies/.scopefix`, because the swap is two renames. If
`--output-root` is the library itself, so that the output path would be the
input, `apply` writes the copy under `<output-root>/.scopefix-staging/`
instead, and the dry run says so.

For each file, in order:

1. **Check.** The input must still exist and have the size and modification
   time recorded in the plan. Otherwise it is skipped with "the file was
   modified after the plan was built". The output path must be free, no two
   planned files may share an output path, and the volume must have room. A
   failed check skips that file. The run continues.
2. **Copy.** The input is copied to `<output>.scope-sub-partial` in 8 MiB
   chunks, with the planned changes made as the bytes pass. Every changed range
   must hold exactly the bytes the plan recorded. If one does not, the file is
   refused and the partial copy is deleted.
3. **Read back.** The written file is read again and hashed. The hash must
   match the hash of what was written. The partial file is then renamed to its
   final name.
4. **Verify.** The output's PGS tracks are read again and compared with the
   fingerprint recorded in the plan: display set count, timestamps,
   composition structure, palettes and images, everything except positions.
   Every fixed track must have no events left outside the picture. The input
   is not read again. Remuxed files are checked with the full `verify`
   instead, including stream hashes.
5. **Replace** (only with `--replace-original`). The original is renamed to
   `<name><backup-suffix>`, a `backed-up` record is logged, and the fixed file
   is renamed onto the original path. Both renames happen within one
   filesystem. If `--output-root` is on another volume, `apply` refuses before
   starting. A run stopped between the two renames is finished on the next run.
   Backups are never deleted. Delete them yourself once you are satisfied.

Every step is added to `<dir>/apply.log.jsonl` (`started`, `skipped`,
`failed`, `verified`, `backed-up`, `replaced`, and `patched` for in-place
fixes) with times, paths, hashes and durations. Running `apply` again skips
any file the log records as `verified` (with its output still present at the
recorded size), `replaced` or `patched`. An interrupted run can therefore be
run again safely.

A file that fails verification has its output deleted. To investigate, run
`fix` on that title.

#### In place (`--dangerously-in-place`)

```bash
scope-sub apply /scratch/plan1 --dangerously-in-place             # dry run: reads, writes nothing
scope-sub apply /scratch/plan1 --dangerously-in-place --execute   # write into the original files
```

A normal `apply` reads and writes every film in full, and `--replace-original`
also leaves a second full-size copy. The fix itself is a few kilobytes.
`--dangerously-in-place` writes only those bytes, directly into each original
file. It needs a plan built for the patch method (remux entries are skipped).
It does not take `--output-root`, and cannot be combined with
`--replace-original` or `--overwrite-output`.

**No copy and no backup are kept.** Once a film is fixed, the plan folder is
the only way back to its original bytes. Keep the plan folder, ideally in two
places, before you run this.

For each file, in order:

1. **Check.** The same size and time check as for a copy.
2. **Scan.** Every range the plan changes is read from the input, and each one
   must hold the bytes the plan recorded. If any range does not, the file is
   refused (exit 7) and nothing is written. The dry run stops here, so it
   already confirms that every file matches the plan.
3. **Write.** A `started` record is logged. The new bytes are written and
   synced, and every written range is read back and compared.
4. **Verify.** As for a copy: the PGS tracks are read again from the fixed
   file and checked against the plan's fingerprint, with no events left
   outside the picture. If this fails, the original bytes are written back and
   the file is reported as failed. `--skip-verify` leaves this step out. It
   reads each whole file, which can take minutes over a network share. The
   written ranges have already been read back, but this is the only check that
   the moved subtitles are inside the picture.
5. **Log.** A `patched` record is logged. `revert <plan> --in-place` can then
   restore the file byte for byte.

A fixed file's modification time no longer matches the plan. For files this
tool last wrote in place, the size must still match, and the byte check
decides the rest. This lets a stopped run be finished: if some ranges are
fixed, the rest are original, and the log has a `started` record with nothing
after it, running the same command again writes them all. A range that
already holds the fixed bytes is not changed. The same half-fixed state
without that record means something else changed the file, and it is refused.
This also lets a film that was reverted in place be fixed again.

### `revert [dir]` — undo a fix

**`revert` is a dry run by default.** `--execute` carries it out.

The plan folder records every byte a fix changed, as `offset`, `before` and
`after`. A revert writes the `before` bytes back, so the result is exactly the
original file.

```bash
# Restore the fixed files in place. Only the changed bytes are written.
scope-sub revert /scratch/plan1 --in-place --execute

# Or write reverted copies elsewhere, leaving the fixed files as they are.
scope-sub revert /scratch/plan1 --output-root /scratch/undo --execute

# One file, from its patch file, without a plan folder.
scope-sub revert --patch-file /scratch/plan1/patches/3.json \
  --target /scratch/fixed/oceans13.mkv --in-place --execute
```

| Option | What it does |
| --- | --- |
| `--in-place` | Write the original bytes into the fixed file itself. |
| `--preserve-dates` | With `--in-place`: restore each file's modification date after writing. |
| `--output-root <dir>` | Write reverted copies under this folder instead. The copy is made, hashed and read back as in `apply`. |
| `--file <substring>` | Only files whose path contains this text. |
| `--patch-file <path>`, `--target <path>` | Revert one file from a `patches/<n>.json` file, without a plan folder. |
| `--output <path>` | With `--patch-file`: write the reverted copy here instead of using `--in-place`. |
| `--execute` | Write changes. |
| `--overwrite-output` | Replace an existing reverted copy. |
| `--format`, `--log-level` | As above. |

`revert` finds each fixed file from `apply.log.jsonl`: the output path named
by a `verified` record, or the original's own path for a `replaced` or
`patched` record. It then refuses unless the file is exactly the one the plan
describes: the size must match and every changed range must still hold the
fixed bytes. A range that holds something else means another program changed
the file. It is refused with the offset (exit 7). A file that already holds
the original bytes everywhere is reported as already original and skipped.

`--in-place` writes only the changed bytes, usually a few tens of kilobytes,
so no full copy is needed. It then reads those ranges back and checks them. A
file on a read-only mount fails when it is opened, and the error names the
file.

An in-place revert logs a `started` record before it writes. If it is stopped
part way, some ranges are restored and some are not. The next
`revert <plan> --in-place` finds that file from the record and finishes it, or
`apply --dangerously-in-place` can finish the fix instead. The same half-done
state with no record is refused. So is any half-done state with
`--patch-file`, which has no log.

Each revert adds a `reverted` record to `apply.log.jsonl`. After an in-place
revert the file counts as not fixed, so a later `apply --execute` fixes it
again without needing `--overwrite-output`. A revert that only wrote a copy
elsewhere does not change the status of the fixed file.

### `review <paths...> --plan <dir>` — fix new titles with a yes/no each

Once a library has been planned and fixed, `review` keeps it fixed as titles
are added. It uses the same plan folder:

```bash
scope-sub review /Movies --recursive --plan /Movies/.scope-sub-plan
```

1. It runs `plan` on the library into `<dir>`. Unchanged titles and titles
   this plan fixed are reused, so only new or changed titles are scanned. A
   scope title is read in full, which takes minutes over a network share. A
   16:9 title takes seconds.
2. It reports what each of those titles turned out to be: no changes needed,
   needs a fix, or cannot be fixed (and why).
3. It does a dry run of `apply --dangerously-in-place`, which checks every
   range of every candidate against the plan. It then asks
   `Fix "<title>" in place? [y/n]` for each title that needs a fix: new titles,
   and titles you declined before.
4. It fixes the titles you approved, in place, and verifies them. Nothing else
   in the plan is touched.

Answers must be `y`, `yes`, `n` or `no`. Anything else, including an empty
line, is asked again, so Enter presses typed during a long scan cannot decline
a title. At a terminal, anything typed before a question appears is discarded
(and reported), so a stray `y` cannot approve a title you have not seen. Piped
answers work: one line per question, and the end of input answers no.

A file left half fixed by an interrupted run gets its own question:
`Finish fixing "<title>"?`. So does a file whose changes were all written but
whose check was interrupted. Declining either is reported as a warning
(exit 6).

The plan folder is then both the record of what has been checked and the undo
data for everything `review` has fixed. The in-place rules apply: no backups
are made, and the plan folder is the only way back. Keep a copy of it
somewhere else.

| Option | What it does |
| --- | --- |
| `--plan <dir>` | The plan folder for this library. Required. |
| `--aspect <ratio\|auto>` | Must match the plan. Default `auto`. |
| `-r, --recursive` | Look in subfolders. |
| `--jobs <n>` | Files analyzed in parallel. Default 1. |
| `--preserve-dates` | Restore each file's modification date after writing. |
| `--log-level <level>` | Log detail. |

If the library holds no titles but the plan lists some, `review` stops
(exit 2) and says to check that the library is mounted. If any title could
not be scanned, it warns and exits 4, unless a failed fix gives a higher code.

#### The Scope Subs script (macOS)

`scripts/scope-subs.sh` runs `review` in a Terminal window, for use as a
double-click app. The plan is the only undo data, so the script is built so
that it never makes any copy of the plan worse. It:

- runs one copy at a time. A lock in `$TMPDIR` ensures this. A stale lock is
  taken over, and only one of several simultaneous starts gets it;
- checks first that the tool can run (`node`, `scope-sub --version`), and says
  so if it cannot. A broken install is not a damaged plan, and nothing needs
  restoring;
- refuses to start unless the library is a mount point mounted read-write (an
  unmounted share looks like an empty local folder), and unless the plan folder
  exists in a folder of its own. A missing plan would mean hours of analysis
  into a plan with no record of earlier fixes;
- refuses when the plan is not sound: `plan-show` must read it, every patch
  file it names must exist and be valid JSON, and it must not be smaller than
  its newest snapshot or the mirror's copy (fewer titles, a missing patch file,
  a missing or shorter `apply.log.jsonl`). It says what is missing and where
  the good copies are, and copies nothing;
- before each check that follows a change, keeps a snapshot of the whole plan
  (`plan.json`, the log and `patches/`) in `logs/before-check-<UTC time>/`
  beside it. It keeps the last 10, and does not run a check without one;
- runs `review`, checks the plan again, and copies it and the snapshots to the
  mirror: `<mirror>/<plan's name>/` and `<mirror>/logs/`. The copy only adds
  and updates. Nothing is deleted from the mirror except snapshots beyond the
  last 10, and a plan that fails the check is not copied. The mirror must be a
  folder of its own on a mounted filesystem other than the plan's. The root of
  a share is refused;
- still makes that copy when the check is interrupted (Ctrl-C, or the window
  closed), because the fixes made before the interrupt have their undo data in
  the plan. Once `review` has returned, Ctrl-C is ignored until the copy is
  done. Ctrl-\ stops a copy that hangs.

If the check refuses a plan you know is right (for example, you restored an
older plan on purpose), move the copy it names aside and run it again.

The script reads its settings from the environment or from
`~/.config/scope-subs/config` (a shell file; the environment takes
precedence). `SCOPE_SUBS_LIBRARY` and `SCOPE_SUBS_PLAN` are required.
`SCOPE_SUBS_MIRROR` is optional; without it the plan is not copied anywhere.
`SCOPE_SUBS_PRESERVE_DATES=1` keeps each fixed file's modification date (see
[File dates](#file-dates)). It is off unless set.

```sh
SCOPE_SUBS_LIBRARY="/Volumes/Movies"
SCOPE_SUBS_PLAN="$HOME/scope-sub/library"
SCOPE_SUBS_MIRROR="/Volumes/Backup/scope-sub"
```

`scripts/scope-subs.applescript` is the app. It opens Terminal and runs the
script from the folder where `scripts/deploy.sh` installs it. Both files ship
in the package, so a deploy to the default folder updates the script and the
app keeps working. Build the app once on the target machine:

```bash
osacompile -o ~/Desktop/"Scope Subs.app" \
  ~/Scripts/scope-sub/npm-global/lib/node_modules/scope-sub/scripts/scope-subs.applescript
```

The first launch asks for permission to control Terminal.

### `remargin <paths...> --plan <dir>` — redo fixes made in place

Redoes in-place fixes that were made with a different margin, or that an older
version left partly unfixed under rules that have since improved. It is a dry
run without `--execute`.

```bash
scope-sub remargin /Movies --recursive --plan /Movies/.scope-sub-plan            # dry run
scope-sub remargin /Movies --recursive --plan /Movies/.scope-sub-plan --execute
```

For each such title it restores the original bytes from the undo data,
analyzes the title again (one full read) and fixes it again. Each step is
verified as `revert`, `plan` and `apply` verify it. Titles are redone one at a
time, so at most one is unfixed at any moment. A title whose new analysis is
not at least as good as its current fix keeps its current fix. The run can be
stopped and started again. The old patch files are kept.

| Option | What it does |
| --- | --- |
| `--plan <dir>` | The plan folder kept for this library. Required. |
| `--aspect <ratio\|auto>` | Must match the plan. Default `auto`. |
| `-r, --recursive` | Look in subfolders. |
| `--margin <px>` | The margin to fix with. Default 24 px at 1080 lines. |
| `--jobs <n>` | Files analyzed in parallel. Default 1. |
| `--execute` | Write changes. |
| `--preserve-dates` | Restore each file's modification date after writing. |
| `--log-level <level>` | Log detail. |

It exits 0 when every title was redone, 1 when some kept their current fix,
and 4 when a title had a problem or could not be reached.

### `restore-dates <dir>` — restore modification dates

Sets the modification date of each file the plan fixed in place back to its
date before the first fix. Only dates change. It is a dry run without
`--execute`. See [File dates](#file-dates).

| Option | What it does |
| --- | --- |
| `--file <substring>` | Only files whose path contains this text. |
| `--execute` | Change the dates. |
| `--log-level <level>` | Log detail. Default `warn`. |

### `doctor` — check the tools

```bash
scope-sub doctor
scope-sub doctor --format json --temp-dir /volume1/scratch
```

```
scope-sub 0.9.0 — environment check

ok    node        v24.16.0 (requires >= 22.12)
ok    mkvmerge    mkvmerge v97.0 ('You Don't Have A Clue') 64-bit
                  /opt/homebrew/bin/mkvmerge
ok    mkvextract  mkvextract v97.0 ('You Don't Have A Clue') 64-bit
                  /opt/homebrew/bin/mkvextract
ok    ffmpeg      ffmpeg version 8.1.1
                  /opt/homebrew/bin/ffmpeg
ok    frames      decodes a frame for measuring
ok    temp dir    /tmp — 283.4 GiB free of 1858.2 GiB

All checks passed.
```

`doctor` checks:

- the Node version against the required minimum;
- which `mkvmerge`, `mkvextract` and `ffmpeg` each command would run, and
  their versions;
- that `ffmpeg` can decode a generated test frame the same way `--aspect auto`
  decodes a film's frames (the `frames` line). A build that cannot, such as
  one without the `lavfi` test source, fails this line;
- that the scratch folder is writable and has room, by writing a test file.

| Option | What it does |
| --- | --- |
| `--format <human\|json>` | Report format. |
| `--temp-dir <path>` | Scratch folder to check instead of the system temp folder. |

It exits 0 when every check passes and 3 when anything required is missing.
Run it first on a new machine. It also works as a health check.

### `serve --stdio` — run the engine for the app

Runs the tool as a long-lived engine that reads JSON requests on stdin and
writes responses and progress events on stdout. The desktop app uses it.
`--stdio` is required. The protocol is described in
[`engine-protocol.md`](engine-protocol.md).

## Patch and remux

**`patch`** (the default) copies the input byte for byte and rewrites only the
PCS object and WDS window `x`/`y` fields, at the file offsets where the reader
found them. The output is the input with a few thousand bytes changed. The
container, video, audio and everything else are the same bytes. Use this
method when it is available.

It is refused, per file or per track, when:

- the PGS track uses **Matroska content compression** (zlib). The subtitle
  data in the file is compressed, so its positions cannot be changed in place.
  Rips made with MakeMKV are not compressed. **`mkvmerge` compresses PGS tracks
  with zlib by default** whenever it writes a file, so a title you have remuxed
  (to trim it, or to change track flags in MKVToolNix GUI) is refused. To fix
  it with the patch method, remux it again with
  `--compression <track id>:none` for each subtitle track (in the GUI:
  *Compression: none*). Changing only flags with `mkvpropedit` edits the
  headers in place and does not compress the tracks. `mkvmerge -J` shows
  `content_encoding_algorithms` on a compressed track;
- a cluster that holds the track has a **CRC-32** element, which an in-place
  edit would make invalid. mkvmerge and MakeMKV do not write cluster CRCs, so
  this is rare.

**`remux`** extracts each track with `mkvextract`, rewrites the `.sup` file and
lets `mkvmerge` rebuild the file. It handles both cases above, and it is the
only way to use A/B mode (`fix --keep-original-subtitle`). It is slower and it
rebuilds the container, so `verify` compares stream hashes instead of every
byte. Pass `--method remux` to `fix`, or to `plan` to build the whole plan for
remux.

## Read strategies

`scan` and `plan` read the PGS blocks directly from the MKV. The reader walks
through the file and steps over every block that does not belong to a
subtitle track. It must still read each block's header to find the next one.
`--read-strategy` sets how much it reads ahead at each step.

| Strategy | What it does |
| --- | --- |
| `auto` | The default. Currently the same as `sequential`. |
| `sequential` | Reads the whole file in order. This is the fastest on every kind of storage tested, local and network. |
| `balanced` | Between `sequential` and `adaptive`. |
| `adaptive`, `minimal` | Transfer about 3% of the file, but take longer. Use them only when the amount of data transferred matters more than time, such as on a busy share or a metered link. |

## The margin

`--margin <px>` sets where a moved subtitle lands. A subtitle outside the
picture is moved to `margin` pixels inside the picture edge, not onto the edge
itself, because the edge of the measured picture is in practice the edge of
the masking. The default is 24 px on a 1080-line canvas (about 3% of a scope
picture), scaled with the canvas height.

**The margin never moves a subtitle that is already inside the picture** (PRD
§10.3). A subtitle whose visible pixels are within the margin of an edge is
reported as `TOUCHING_BOUNDARY`. This is counted separately from the subtitles
outside, and the subtitle is left where it is. Only a subtitle at least one
pixel outside the picture needs a fix. Changing the margin therefore changes
how far subtitles move, not how many are moved.

The same value is used by `scan`, `fix`, `plan` and `verify`, so a plan is
verified with the margin it was built with.

Each patch file records the margin its fix used. When a release changes the
default, a plan that uses the default still works: new titles get the new
default, and earlier fixes stay where they are. To bring earlier in-place
fixes to the current margin, run
[`remargin`](#remargin-paths---plan-dir--redo-fixes-made-in-place).

## File dates

Writing a fix into a file changes its modification date to the time of the
write, as any edit does. Media servers may use that date for a "recently
added" list. To keep each file's date, pass `--preserve-dates` to
`apply --dangerously-in-place`, `revert --in-place`, `review` or `remargin`.
The date is restored after the write is done and verified.

On a network share, the server can set a file's date again up to a minute or
two after the write. The tool therefore watches each restored date for up to
150 seconds and sets it again if it changes. A run waits once for this, at the
end. On a local disk there is no wait. A date that cannot be restored is
reported as a warning. The fix still counts.

For files already fixed without `--preserve-dates`:

```bash
scope-sub restore-dates /Movies/.scope-sub-plan            # dry run: lists each date
scope-sub restore-dates /Movies/.scope-sub-plan --execute
```

This sets each fixed file's date to the one the plan recorded before its first
write. Only dates change. A file whose date is not the one the tool's last
write left is skipped, because something else has changed it since.

## Exit codes

Per [`PRD.md`](PRD.md) §20:

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | `scan --fail-if-needed`: something needs a fix. `remargin`: some titles kept their current fix. `restore-dates`: a date could not be set. |
| 2 | Invalid arguments, including a path that does not exist or a plan that cannot be read. `review`: the library holds no titles but the plan lists some. |
| 3 | A required tool is missing (`mkvmerge`, `mkvextract`, `ffmpeg`). |
| 4 | Unsupported media structure. `plan`: every file failed. `review`: a title could not be scanned. `remargin`: a title had a problem. |
| 5 | PGS parse error. |
| 6 | A fix failed (`fix` or `apply` could not produce an output; `review`: a half-fixed file was left unfinished). |
| 7 | Verification failed (`verify` FAIL; an `apply` output that did not verify; a file that does not match the plan). |
| 8 | Output conflict (the output exists, or two planned files share one path). |

`apply` reports the most serious code across the whole run, in the order
7, 6, 8.

## Safety

- **Inputs are opened read-only** by every command except these, which change
  the original files: `apply --replace-original`, `apply --dangerously-in-place`,
  `review` (an in-place apply, asked title by title), `remargin --execute`,
  `revert --in-place` and `restore-dates --execute` (which changes only a
  file's date).
- `apply --replace-original` runs only after that file's output has been
  verified, and keeps the original as `<name>.pre-scopefix`.
- `apply --dangerously-in-place` writes the fix into the original file and
  keeps no copy. It writes only after every changed range has been checked
  against the plan, and writes the original bytes back if the result does not
  verify.
- **`scan`, `plan` and `plan-show` never write to your library.** The only
  programs they start are `mkvmerge -J`, `mkvextract … tracks` and
  `ffmpeg … -frames:v 1 -f rawvideo -` (one decoded frame per sample, sent to
  the tool). None of these can change their input.
- **`apply` is a dry run until you pass `--execute`,** in every mode. So are
  `revert`, `remargin` and `restore-dates`.
- **Nothing is fixed that `scan` would not report.** `scan`, `fix`, `plan` and
  `apply` share one analysis and one set of moves.
- **When in doubt, the file is skipped.** A variable aspect ratio, canvases
  that cannot be matched to the video, unclear geometry, and compressed tracks
  under `--method patch` are all skipped, with the reason in the plan.
- **Every output is verified before it counts:** a hash of what was written, a
  hash of what was read back, and a comparison of the subtitles without their
  positions, which catches any change to timing, structure, palettes or
  images.
- **Temporary files never go in the source folder,** and partial outputs are
  removed on any failure.

### Undo

**Keep the plan folder. It is the undo data.** Every byte a fix changes is in
`patches/<n>.json` as `offset`, `before` and `after`, and `apply.log.jsonl`
records which files were written and where. `scope-sub revert` uses these to
restore any fixed file, byte for byte, at any later time. The folder is small:
about 5 MB for a film with 10,000 subtitle events across 13 tracks, and
nothing for titles that needed no fix.

Copy it next to the library and keep it there:

```bash
cp -R /scratch/plan1 /Movies/.scope-sub-plan-2026-09
```

The `.pre-scopefix` backups that `--replace-original` leaves are a second way
back: a full copy of each fixed film. They take as much disk space as the
films. You can delete them once you have the plan folder and have watched the
results. Keep the plan folder.

After `apply --dangerously-in-place` there are no backups, and the plan folder
is the only undo data. Copy it somewhere else before the run.

Keep any backups until you have watched the results. The tool checks what it
can, but only you can see the screen.

## Installing on another machine

There are three ways. In each case, `scope-sub doctor` confirms that the
install works.

### 1. A package file and `npm install -g`

```bash
pnpm pack                                   # -> scope-sub-<version>.tgz (runs the build)
scp scope-sub-<version>.tgz nas:~/
ssh nas 'npm install -g ~/scope-sub-<version>.tgz && scope-sub doctor'
```

The other machine needs Node 22.12 or newer, npm, MKVToolNix and FFmpeg. If
you are not root there, install into your own folder and add it to `PATH`:

```bash
npm install -g --prefix ~/scope-sub/npm-global ~/scope-sub-<version>.tgz
export PATH="$HOME/scope-sub/npm-global/bin:$PATH"
```

`scripts/deploy.sh` does all of this and runs `doctor` on the other machine at
the end:

```bash
scripts/deploy.sh user@nas --dry-run                    # print the steps
scripts/deploy.sh user@nas                              # install to ~/Scripts/scope-sub
scripts/deploy.sh user@nas --dir /volume1/scope-sub     # or elsewhere
```

It installs into a user folder when the remote account is not root, and
prints the `PATH` line to add. It refuses (exit 4, nothing installed) while the
Scope Subs app is running on the target. It fails (exit 5) unless the
installed `scope-sub --version` is the version it has packed. On a Mac, that
check and `doctor` run with the `PATH` the Scope Subs app uses, so they fail
when the app would not find `node` or would run another install.
`SCOPE_SUB_SSH_OPTS` passes extra options (`-p 2222`, an identity file) to both
`ssh` and `scp`.

### 2. Docker

Use this when the machine has no suitable Node or MKVToolNix. The image
includes MKVToolNix and FFmpeg, so the machine needs only Docker.

```bash
docker build -t scope-sub .
docker run --rm scope-sub doctor
docker run --rm -v /srv/media:/media:ro -v "$PWD/work":/work scope-sub \
    scan /media --recursive
```

`docker-compose.yml` is an example setup: the library mounted **read-only** at
`/media`, a read-write `/work` for plans and outputs, and the `plan`,
`plan-show` and `apply` commands in its comments. Because the library is
read-only, `apply --replace-original` and `--dangerously-in-place` cannot be
used in the container. Fixed copies are written to `/work/fixed`. Swap them in
from the host after you have watched them.

### 3. From source

```bash
git clone https://github.com/luminationlabs/scope-sub-fixer.git
cd scope-sub-fixer
pnpm install && pnpm build
node dist/cli/main.js doctor
```

### Environment variables

| Variable | Meaning |
| --- | --- |
| `SCOPE_SUB_MKVTOOLNIX_DIR` | Folder that holds `mkvmerge` and `mkvextract`. Tried before `PATH`. |
| `SCOPE_SUB_FFMPEG` | The `ffmpeg` program, or the folder that holds it. Tried before `PATH`. |
| `TMPDIR` | Scratch space for extracted `.sup` files and remuxes. A remux needs room for a whole output file. `--temp-dir` overrides it for one command. On Windows the system temp folder (`TEMP`) is used. |

## Further reading

- [`PRD.md`](PRD.md): the product specification. It covers the problem, the
  geometry, how subtitles are moved, the validation plan and the development
  phases.
- [`known-bad-titles.md`](known-bad-titles.md): discs known or suspected to
  place subtitles in the letterbox bars, and how strong that evidence is.
- [`AGENTS.md`](../AGENTS.md): the code layout, toolchain and a PGS format
  summary, for anyone working on the code.
- [`CHANGELOG.md`](../CHANGELOG.md): the changes in each release.
