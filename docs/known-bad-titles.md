# Known-bad titles: PGS subtitles authored inside the letterbox bars

**Purpose:** identify real discs that are likely to exhibit the problem described in
[PRD.md §2](PRD.md), so the analyzer and the repair can be validated against genuine
offending material rather than synthetic fixtures.

**Last updated:** 2026-09-02

---

## 1. Honest summary of the evidence

The web evidence is **usable but narrow**, and it is worth being precise about how narrow.

There is essentially **one** curated public list of discs with subtitles in the letterbox
bars: the AVS Forum *"CIH subtitle master thread"*, maintained roughly 2009–2015, with two
columns (`SUBTITLES IN PICTURE` / `SUBTITLES NOT IN PICTURE`) built from member reports
including two working Blu-ray reviewers. Everything else found — other AVS threads,
blu-ray.com, Doom9, AVForums, Home Theater Forum — is scattered single reports, many of
which trace back to that same lineage. So this is **one list with one lineage, not
independent corroboration**.

Three further caveats that materially affect how the shortlist should be read:

- The list is **Blu-ray / DVD / HD DVD era**. There are effectively **no title-level reports
  for UHD discs** anywhere.
- Its own scope note excludes SDH: *"This list is only for ENGLISH language subs… This list
  WILL NOT cover SDH subs."*
- Placement is **per-release and per-territory**, not per-studio. The list itself documents
  same-film reversals: *Black Book* (US/Dutch in bars, **UK safe**), *Assembly* (UK in bars,
  **HK safe**). A studio lookup table will be unreliable.

**Access note:** `avsforum.com` does not serve automated fetches (it redirects them to
`tollbit.avsforum.com`, which answers HTTP 402 Payment Required). The AVS content below
was taken from Wayback snapshots and has not been checked against the live threads.
Treat AVS quotes as **second-hand transcription** and re-check in a browser before
relying on any single one.

Confidence labels used below:

| Label | Meaning |
|---|---|
| **A** | Named in a first-hand report, specific about placement, with a URL |
| **B** | Named in the master list without placement detail, or covered by a well-sourced studio rule that the title matches |
| **C** | Plausible inference only; no direct evidence |

---

## 2. Why source-level repair is the right fix

Two independent facts, both well sourced.

### 2.1 Kodi cannot reposition PGS subtitles at all

This is not a configuration gap — it is structural. The Kodi wiki states outright that
*"Image based subtitles, such as those from DVD (VobSub) or Bluray (pgs), are **not
affected by these settings**."* Bitmap overlays exit `OverlayRenderer.cpp` before any
position logic runs. So **"Position on screen", vertical margin, "Override subtitle
styles", `SubtitleShiftUp`/`SubtitleShiftDown`, and the Video Calibration subtitle bar are
all text-subtitle-only.** Team Kodi confirmations: *"A sup subtitle is image based and
cannot be moved"*; *"Kodi can not manipulate image based subtitles such as PGS and SUB."*

The geometry Kodi *does* apply is decided by comparing the PGS canvas aspect ratio to the
video aspect ratio (introduced in PR #21162, v20 Nexus):

| Encode shape | Path | Behaviour under a CIH scope zoom |
|---|---|---|
| Bars encoded in (1920×1080 holding a 2.40 image) | `ALIGN_VIDEO` | Follows zoom and vertical shift — the zoom pushes bar subs off-screen |
| Bars cropped out (1920×816, 3840×1608) | `ALIGN_SCREEN_AR` | **Ignores zoom and shift entirely**; lands in the display's bar region, unrecoverable by any setting |

Either way the subtitles are lost on a scope zoom. A matching user report confirms the
second path: *"After some more testing, this only happens for files where the black bars are
cropped out of the video."*

A fix is in flight but not shipped: **[xbmc/xbmc PR #29060](https://github.com/xbmc/xbmc/pull/29060)**,
*"[Subtitles] Let bitmap subtitles be resized and repositioned"*, open against milestone
v23, adding `subtitles.bitmapzoom` and `subtitles.bitmapposition`.

- <https://forum.kodi.tv/showthread.php?tid=329185> — feature request: move PGS subtitle position
- <https://forum.kodi.tv/showthread.php?tid=337326> — subtitle position & stretching with wide videos and graphic subs
- <https://forum.kodi.tv/showthread.php?tid=372174> — "PGS Subtitles don't move with video"
- <https://forum.kodi.tv/showthread.php?tid=377103> — Kodi 21 cannot display subtitles on the black bar
- <https://github.com/xbmc/xbmc/issues/23210> — "Bottom of Screen" does not work for bitmap subs

### 2.2 Two measurements from that PR that should shape the analyzer

The PR author surveyed **64,654 PGS display sets across 57 remuxes**. Two results are
directly load-bearing here:

1. **UHD Blu-ray PGS is authored on the same 1920×1080 canvas as Blu-ray PGS** — all 29 of
   the 2160p titles surveyed. So the analyzer must scale PGS coordinates against the PGS
   canvas declared in the stream, *not* against the video raster, and a 4K title's subtitle
   geometry is not a separate case.
2. **99.59% of display sets have their content centre in the lower third; 0% straddle the
   frame middle.** A bottom-bar-only heuristic covers essentially everything, and a "top
   subtitle" case (PRD §14.1 case 4) is genuinely rare — worth handling, not worth
   optimising for.

### 2.3 Placement is purely an authoring choice

From the master thread: *"BD titles are going to be the same regardless of player as this is
an authoring issue and players are not capable of relocating subs."* Nothing in the format
requires subs to sit in the bar, which is why it varies by studio, era and territory — and
why rewriting the PGS composition coordinates is a legitimate, lossless repair rather than a
workaround.

---

## 3. How madVR Envy actually behaves

madVR Labs publishes primary documentation that is unusually explicit. One correction to the
common framing first:

> **Subtitles in the bars do not change the Envy's detected aspect ratio.** The IP control
> API exposes two distinct values: `AspectRatio` (*"the active video area of the content"*)
> and `MaskingRatio` (*"suggests a suitable position for your physical masking system,
> taking subtitles and custom zoom settings + NLS into account"*). Subtitle accommodation is
> a separate zoom/masking layer applied on top of AR detection, not a corruption of it.
> (Contrast Lumagen, whose image-based auto-aspect genuinely can be fooled by bar subtitles,
> and which has no automatic subtitle detection at all — only a manual 3%/6% shift.)

### 3.1 The detection rule

From the [DSO Setup Guide](https://madvrenvy.com/wp-content/uploads/Dynamic-Subtitle-Overlay-Setup-Guide.pdf) —
the cleanest statement of the trigger condition anywhere:

> "DSO activates only when **at least a portion** of a subtitle appears in the black bar area
> outside the active image. If the media player places all subtitles entirely within the
> active image, DSO will not activate."

and for scope screens specifically:

> "if subtitles are positioned by the media player at least partially within the black bar
> area, DSO automatically moves them into the visible screen area, so they are not cut off"

**Implication for this tool:** the trigger is *any* overlap between the subtitle bitmap's
bounding box and the letterbox region — presence-based, not depth-based, with **no published
pixel tolerance**. Even descenders poking a few pixels into the bar are enough. If the fixer
guarantees zero overlap, the Envy neither zooms nor engages DSO, and the image stays at full
scope size for the whole movie. That is the acceptance criterion worth testing on a real
title.

### 3.2 Verified settings

All under the Envy's **Black Bar Configuration** menu.

| Setting | Documented values / behaviour |
|---|---|
| **Subtitle Handling** | **Zoom Image** (the feature called *Subtitle Management*) or **Dynamic Subtitle Overlay**; also "Show Subtitles +1% Padding" |
| Black Bar Detection Speed | e.g. "Ludicrous" |
| Small / Large Black Bar Reduction | e.g. 100% / None |
| If Black Bars Change… / …Quickly Back & Forth | "Adjust At Once" |
| **Top Zoom Stickiness** | none / 5 s / 15 s / 45 s / 3 m / 10 m / 30 m / 90 m / "Until The End Of The Movie" (whitepaper suggests 45 s) |
| **Bottom Zoom Stickiness** | same list, configured **independently** of the top |
| DSO: Background Brightness | 0–90% opacity of the box behind repositioned text |
| DSO: Brightness Limiter | adapts subtitle brightness to scene APL |
| DSO: Text Color | default **Adaptive** (harmonises with scene palette) |
| DSO: Text Size | reduce by 5%–50% |
| DSO: Placement | **Screen Border** or **Movie Image**, each with 1%–5% padding |

DSO requires **Firmware Configuration → BuildType = Experimental**, build 2.1+, on Envy
Pro/Extreme or a Core with the Core Premium Package.

Terms that could **not** be verified in any official document and should be treated as
non-existent: "letterbox detection", "auto zoom", "zoom out for subtitles", "AR detection
tolerance/sensitivity", "SDR/HDR bar threshold". There is no published luminance value for
"black", no frame count, no percentage-of-bar-area threshold. AR detection uses roughly a
5–6 frame analysis buffer; `SetAspectRatioMode Hold` freezes AR for a movie.

### 3.3 Behaviour and limitations worth mirroring

From the [Subtitle Management whitepaper (rev 1.06)](https://madvrenvy.com/wp-content/uploads/Managing-Subtitles-on-Scope-Screens.pdf):

- Top and bottom bars are managed **separately and concurrently**.
- Envy grows the bar to fit **multi-line** subtitles — a 2- or 3-line event forces a larger
  zoom-out than a 1-line event, held for the Stickiness duration.
- madVR Labs' own criticism of the zoom mode: *"the constant shrinking and expanding can
  distract viewers, pulling them out of the story."* That is precisely the failure mode
  source-level repair eliminates.

DSO adjusts placement **vertically only** — horizontal position is preserved deliberately,
since it can encode who is speaking. **The repair tool should do the same.**

Documented DSO failure modes (its own §6 "Known Limitations"), useful as an argument for
fixing upstream: image detail misread as letters producing *"random 'alien symbols'"*; real
letters excluded as image, causing *"missing letters or… entire missing words"*; player OSD
elements ("PAUSE", time remaining) treated as subtitles; unreliable during opening/closing
credits; and — relevant to PRD §14.1 case 10 — *"Variable aspect ratio (e.g., IMAX) movies
may also exhibit alternating DSO and non-DSO subtitle styling as the image transitions
between scope and IMAX scenes."*

---

## 4. The Sony split-line rule — the most useful single finding

From the blu-ray.com poll on subtitle positioning in 2.20+ films
(<https://forum.blu-ray.com/showthread.php?t=104430>), describing Sony Pictures' stated
practice:

> Sony places **one subtitle line inside the active picture and the second line below it**,
> for films wider than about 2.30:1, because it cannot fit both lines outside the picture
> area.

Illustrated there with *The 400 Blows* (both lines inside) versus *Che* (top line inside,
bottom line outside). The poll ran 1,340 voters: **59.03%** wanted all subtitles inside the
picture always; 28.06% accepted Sony's mixed approach. Independently corroborated by
first-hand reports on *Talladega Nights* (*"first line of dialog is in the picture area and
the second line in the black letterbox area"*), *Kung Fu Hustle* (*"1st row on the picture
itself, 2nd row on the black bars"*) and *Angels and Demons* (*"half in half out of the
active picture"*).

**This dictates the analyzer's test.** On these discs the failure is **per-event and
partial**: one-line subtitles are fine, two-line subtitles have their *second* line in the
bar. An analyzer that samples a handful of events, or that only checks whether the *whole*
composition sits below the active area, will report a false "clean". The correct test is
**bounding-box intersection per composition object, over every event**, reporting the
fraction affected and whether the intersection is the whole bitmap or only the lower line.

Related: [Home Theater Forum — Sony poll about subtitle placement](https://www.hometheaterforum.com/community/threads/sony-poll-about-subtitle-placement.283960/),
[blu-ray.com news #3004](https://www.blu-ray.com/news/?id=3004).

---

## 5. Studio- and era-level heuristics

| Claim | Evidence | Strength |
|---|---|---|
| **Warner Bros.: subs in the bar on "pretty much any movie"** | Josh Zyber (working home-theater reviewer): *"Subtitles will be in the black bar on pretty much any movie from Warner Bros."* | **Moderate.** One credible individual, asserted flatly, no dataset. Master list corroborates only weakly (Gran Torino, Letters from Iwo Jima, Ocean's 13 are WB). |
| **Sony: bar → in-picture → silently reverted** | Zyber: *"They started by always putting subtitles in the letterbox bar, then I personally badgered them into changing their policy… over time they appear to have silently slipped back."* | **Strong for the 2009 episode** — the poll is primary evidence. **Weak for the reversion** — assertion only. |
| **Sony's foreign-language catalogue puts subs in the bottom bar** | *"Pretty much any foreign film from Sony Pictures Home Entertainment puts the subtitles in the bottom letterbox bar of the 2.40:1 frame (Crouching Tiger, Hidden Dragon, Kung Fu Hustle, 2046)"* | **Moderate** — pattern backed by named titles. |
| **Universal generally keeps subs in the picture** | Zyber: *"Universal generally keeps subtitles in the picture"*; another member: *"Death Race… Has subtitles IN the picture (as do most all Universal titles)"*. The IN-PICTURE column is heavy with Universal (Mummy trilogy, Bourne trilogy, Hulk, Fearless, Death Race). | **Moderate-good** — two independent statements plus consistent list data. Useful for choosing negative controls. |
| Fox / Paramount / DreamWorks / Lucasfilm "good" | A single unsourced member opinion. Contradicted for Lucasfilm by the Star Wars DVDs sitting in the bad column. | **Weak — do not rely on.** |
| **StudioCanal often runs subs into the bars** | One first-hand collector: *"many SC discs… often have subtitles that extend to the black widescreen bars if you're watching a film in the 2.35:1 aspect ratio."* No titles named. | **Weak-moderate.** |
| Criterion keeps subs in-picture | *The 400 Blows* cited as the good exemplar — but Criterion's *Hidden Fortress* DVD is in the bad column. | **Weak / mixed — not a rule.** |
| Region B / European discs are worse | **Refuted as a blanket rule.** The list has Region B titles in *both* columns (Australia, Goonies, Slumdog Millionaire in-picture; Rock N Rolla, Dances with Wolves DE in bars). | **Refuted.** |
| Anime labels | **No evidence found at all.** | **None — do not claim.** |

**Era heuristic (C):** early Blu-ray / HD DVD catalogue titles (2006–2010) are heavily
over-represented in the complaints, consistent with early authoring conventions and with
Sony's pre-poll practice. Suggestive, not evidence.

**The one rule that holds up:** placement is a per-release, per-territory authoring decision.
Detect per disc; do not look up by studio.

---

## 6. The master list

Source: **AVS Forum, "CIH subtitle master thread"** —
<https://www.avsforum.com/threads/cih-subtitle-master-thread.1102888/>
(retrieved via `web.archive.org/web/20220625074331/…`).

### 6.1 `SUBTITLES NOT IN PICTURE`

*30 Days of Night* (BD; alien-language subs in lower bar, *"sometimes subtitles are stacked -
and half of the subtitle is readable in the picture area"*) · *36 Quai des Orfèvres* (BD, FR
import) · **Angels and Demons** (BD; *"half in half out of the active picture"*) · *Assembly*
(BD **UK**; HK version safe) · *Black Book / Zwartboek* (BD; **UK version safe**) · *Blood:
The Last Vampire* · *CJ7* (*"subtitles are in the black bars"*) · *Curse of the Golden
Flower* · **Crouching Tiger, Hidden Dragon** · **Dances with Wolves** (BD, **German Region B
Kinowelt import**; *"half in half out"*) · *Day Watch* · *Dragon Wars* · *District B13* (BD &
DVD) · *Flash Point* (BD, HK) · *Four Flies on Grey Velvet* (SD DVD) · *Godzilla* (BD [A]) ·
**Gran Torino** · *Hancock* (*"subs are absolutely not important… very short scene at the
beginning"*) · *The Hidden Fortress* (**Criterion** DVD) · *House of Flying Daggers* · *The
International* · *Jean de Florette / Manon des Sources* (DVD) · *Jodhaa Akbar* · *Kung Fu
Hustle* · *La Femme Nikita* (*"subtitles fall within both the picture and black bars"*) ·
*Letters from Iwo Jima* · *Mad Detective* (BD, UK) · *Max Manus: Man of War* (UK import) ·
*MR73* (BD, FR) · *The Myth* · **Ocean's 13** (*"has the subs in the black bars very
annoying"*) · *Oldboy* · *OSS 117: Cairo, Nest of Spies* (BD, FR) · **Patton** · *Pineapple
Express* (*"subtitles for the Asian characters were inside the bottom black bar"* —
forced-only) · *The Professionals* · *Red Cliff* (BD, HK) · *Revolver* · *Rock N Rolla* (BD,
Region B) · *Saawariya* (BD, Sony) · *Seven Pounds* · **Star Wars** ANH / ROTJ / TPM / AOTC
(SE) and ANH / ESB / ROTJ (originals) — **DVD entries**, Greedo/Jabba subs · *Tell No One* ·
*Vantage Point* · *Warriors of Heaven and Earth* · *Youth Without Youth*

Flagged as partial: **Kill Bill Vol. 1** (BD) is listed *in picture* but *"2 lines of dialog
drop into lower bar, but it is not missed."*

### 6.2 Additional named titles from other threads

| Title | Report | Source |
|---|---|---|
| **Talladega Nights** | *"first line of dialog is in the picture area and the second line in the black letterbox area"* | [AVS "Subtitles on 2.35 screen"](https://www.avsforum.com/threads/subtitles-on-2-35-screen.782735/) |
| **The Da Vinci Code** (Sony) | *"I noticed this on DaVinci Code the other day and with my masking in place you can not see the titles"* | same |
| *2046* (Sony) | named in the Sony foreign-film pattern quote | [AVS "Subtitles in Letterbox"](https://www.avsforum.com/threads/subtitles-in-letterbox.1104342/) |
| *Kung Fu Hustle* | *"1st row on the picture itself, 2nd row on the black bars"* | [AVForums](https://www.avforums.com/threads/subtitles-in-foreign-scope-films.1150235/) |
| *Stigmata* (Region A BD) | *"The forced subtitles fall outside the visible frame and are burned in"* — with screenshot | [AVS "Subtitles with 2.4:1 screen?"](https://www.avsforum.com/threads/subtitles-with-2-4-1-screen.3207415/) |
| *Che – The Argentine* | the split-line exemplar | [blu-ray.com news #3004](https://www.blu-ray.com/news/?id=3004) |
| *Shinobi* | held back from purchase over the subtitle issue | AVS 1104342 |
| *Gran Torino*, *Vantage Point* | the two BDSup2Sub repositioning demo cases | [Doom9 t-154457](https://forum.doom9.org/archive/index.php/t-154457.html) |

Reported **correctly placed** (negative controls): *The 400 Blows* (Criterion), *The
Orphanage* (*"the rare BD title that does have the entire subs within the image area"*),
*Om Shanti Om*, *Heyy Babyy*, *Eight Below*, *Dark Water*, *The Descent*, *Shooter*, *First
Blood*, *Déjà Vu*, *Flightplan*, **The Italian Job**, *Four Brothers*, *The Rock*, *Basic
Instinct*, *Mission: Impossible*, plus most Universal catalogue (Mummy, Bourne, Hulk,
Fearless, Death Race).

### 6.3 Explicitly *not* this problem

Worth recording so they are not mistaken for hits: *The 13th Warrior*, *The Four Feathers*,
*The Sheltering Sky* (Amazon.fr BDs) and *The Wicker Man*, *Vice Squad*, *Near Dark*
(StudioCanal) are reported for **forced, non-defeatable foreign subtitles** — a different
defect. *Lord of the Rings* appears on Doom9 only as a case where *hard-coded* Elvish subs
sit in-picture, forcing translations elsewhere.

---

## 7. What still needs verifying, and how

Nothing above establishes actual pixel coordinates — every entry is a prediction. The cheap
confirmation step, once a candidate is copied locally:

1. `mkvextract tracks <file> <id>:out.sup` for the English and forced tracks.
2. Parse PCS/ODS composition objects and record each object's `(x, y, w, h)`, **against the
   PGS canvas declared in the stream** (1920×1080 even for UHD — see §2.2).
3. Compare `y + h` against the active-picture bottom edge. For 1080p 2.39:1 the bars are
   ~138 px, so the active image runs roughly y=138…942; anything with `y + h > 942`
   intersects the bottom bar.
4. Report the **fraction** of events that intersect, and whether the intersection is the
   whole bitmap or only the second line — the Sony signature from §4.

`BDSup2Sub` / `BDSup2Sub++` already implements the relocation half and is worth benchmarking
against: it exposes `--move-in-ratio` and `--move-out-ratio` to move captions relative to a
given screen ratio, and writes back to SUP/BD without transcoding. Reported gotcha: "Reset
crop offset" must be used before saving to freeze positions.
(<https://www.videohelp.com/software/BDSup2Sub->,
[Doom9 BDSup2Sub++ thread](https://forum.doom9.org/archive/index.php/t-165416.html))

---

## 8. Sources

**Primary (vendor documentation)**
- madVR Labs — [*Subtitle Management with Scope Screens* whitepaper, rev 1.06](https://madvrenvy.com/wp-content/uploads/Managing-Subtitles-on-Scope-Screens.pdf)
- madVR Labs — [*Dynamic Subtitle Overlay Setup Guide*](https://madvrenvy.com/wp-content/uploads/Dynamic-Subtitle-Overlay-Setup-Guide.pdf)
- madVR Labs — [Scope Screen Setup Guide](https://madvrenvy.com/wp-content/uploads/Scope-Screen-Setup-Guide.pdf)
- madVR Labs — [Envy IP Control reference](https://madvrenvy.com/wp-content/uploads/EnvyIpControl.pdf)
- [ProjectorCentral — madVR Envy Extreme MK2 review](https://www.projectorcentral.com/madVR-Envy-Extreme-MK2-Video-Processor-Review.htm)

**Kodi**
- [xbmc/xbmc PR #29060 — let bitmap subtitles be resized and repositioned](https://github.com/xbmc/xbmc/pull/29060)
- [xbmc/xbmc issue #23210](https://github.com/xbmc/xbmc/issues/23210)
- Kodi forum — [tid=329185](https://forum.kodi.tv/showthread.php?tid=329185) · [tid=337326](https://forum.kodi.tv/showthread.php?tid=337326) · [tid=372174](https://forum.kodi.tv/showthread.php?tid=372174) · [tid=377103](https://forum.kodi.tv/showthread.php?tid=377103)

**Title reports**
- AVS Forum — [CIH subtitle master thread](https://www.avsforum.com/threads/cih-subtitle-master-thread.1102888/) *(the master list; via Wayback)*
- AVS Forum — [Subtitles in Letterbox](https://www.avsforum.com/threads/subtitles-in-letterbox.1104342/)
- AVS Forum — [Subtitles on 2.35 screen](https://www.avsforum.com/threads/subtitles-on-2-35-screen.782735/)
- AVS Forum — [Is there a list of content with subtitles in the black bars? (2018)](https://www.avsforum.com/threads/is-there-a-list-of-content-with-subtitles-in-the-black-bars.2962492/)
- AVS Forum — [List of scope HD DVD/Blu-Ray films with subtitles in black bars? (2007)](https://www.avsforum.com/threads/list-of-scope-hd-dvd-blu-ray-fims-with-subtitles-in-black-bars.908791/)
- AVS Forum — [question about subtitles in the black bars](https://www.avsforum.com/threads/question-about-subtitles-in-the-black-bars.1525919/)
- AVS Forum — [Subtitles with 2.4:1 screen?](https://www.avsforum.com/threads/subtitles-with-2-4-1-screen.3207415/)
- AVS Forum — [Uh oh…subtitles](https://www.avsforum.com/threads/uh-oh-subtitles.1060290/)
- AVForums — [Subtitles in foreign scope films](https://www.avforums.com/threads/subtitles-in-foreign-scope-films.1150235/)
- blu-ray.com — [Poll: Subtitle positioning in wider ratio (2.20+) movies on Sony](https://forum.blu-ray.com/showthread.php?t=104430) · [news #3004](https://www.blu-ray.com/news/?id=3004) · [Subtitle Positioning/Method for Blu-ray](https://forum.blu-ray.com/showthread.php?t=104567) · [StudioCanal thread](https://forum.blu-ray.com/showthread.php?t=320420)
- Home Theater Forum — [Sony poll about subtitle placement](https://www.hometheaterforum.com/community/threads/sony-poll-about-subtitle-placement.283960/)
- Doom9 — [Subtitles in black bar area](https://forum.doom9.org/archive/index.php/t-154457.html) · [Subtitles in Blu Ray a-top of black bars](http://forum.doom9.org/showthread.php?t=173081) · [BDSup2Sub++](https://forum.doom9.org/archive/index.php/t-165416.html)
- AV NIRVANA — [madVR Envy's Dynamic Subtitle Overlay arrives](https://www.avnirvana.com/threads/madvr-envy%E2%80%99s-dynamic-subtitle-overlay-arrives-and-the-timing-couldn%E2%80%99t-be-better.17175/)
- VideoHelp — [BDSup2Sub / BDSup2Sub++](https://www.videohelp.com/software/BDSup2Sub-)

**Not consulted:** the live `avsforum.com` threads (see the access note above),
`reddit.com` (so nothing from r/hometheater, r/projectors or r/4kbluray), and
`hometheaterforum.com`. None of them serves automated fetches.
