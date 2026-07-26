# Playgiarism

Ad-free clones of mobile games, packaged as a single Android app.

## Cloning guidelines

Every game here is a reimplementation of something that already exists. These are the
working rules for how that's done. They're practical guardrails, not legal advice — if a
game ever gets distributed beyond sideloading to friends, get a real opinion first.

**Fine to take:**

- Rules and mechanics. How pieces merge, how a chain reaction propagates, how scoring
  works — game rules aren't copyrightable expression. Reimplement them from observed
  play.
- Genre conventions. Grid sizes, swipe gestures, three-pieces-in-a-tray, next-piece
  previews. These are shared vocabulary across dozens of games.
- The general look of a *category* — a 4×4 tile grid, a set of coloured tubes, a
  hex-packed pile of fruit.

**Not fine to take:**

- Titles and trademarks. Use a distinct name. That's why the folders are `blockparty`,
  `balls`, and `fruit` rather than the originals' names. Exceptions are titles that are
  generic or long out of any single owner's hands (2048, Minesweeper).
- Any asset from the original: sprites, icons, fonts, sound effects, music, backgrounds.
  Draw or generate everything, or use assets that are clearly licensed for it. Nothing
  gets extracted from an APK, ripped from a site, or screenshotted and traced.
- Exact copies of an original's distinctive art: its specific character designs, its
  logo, its colour palette lifted swatch-for-swatch, its UI chrome recreated
  pixel-for-pixel.
- Hand-authored level content. Puzzle games here use seeded generators
  (`watersort`, `balls`) rather than transcribing someone's level list.
- Decompiled, deobfuscated, or otherwise reverse-engineered code. All game logic in
  `www/` is written from scratch in vanilla JS.
- Anything that implies endorsement or origin — "official", the original studio's name,
  store-listing copy.

**Attribution:** the README's "Clone of" table names what each game is derived from.
Keep it honest and keep it current when games are added. Naming the inspiration is
better than pretending there isn't one; it also makes clear these are clones rather
than the real thing.

**Scope:** this project exists because the originals are buried in ads, trackers, and
IAP. It stays free, offline, and non-commercial. No monetisation, no store listing, no
scraping the originals' servers or APIs.

## Architecture

- Games are plain HTML5/canvas/vanilla-JS in `www/` (no bundler, no framework).
- Wrapped into a native Android APK with Capacitor 7 (`android/` is generated; edits to
  `AndroidManifest.xml`, `res/`, and `MainActivity.java` are manual and preserved —
  MainActivity enables immersive sticky mode so the system bars stay hidden during play).
- `www/index.html` is the home menu. Each game lives in its own folder:
  - `www/pixel/` — Pixel Color by Number (photo → k-means quantized grid; localStorage gallery under `pixel.works.v1`; finished works move to a "Finished" gallery section whose tiles open a fullscreen viewer)
  - `www/fruit/` — Fruit Merge, suika-style (matter-js physics, vendored at `www/vendor/matter.min.js`; high scores under `fruit.scores.v1`)
  - `www/colorwars/` — Color Wars (chain-reaction dot battle; 2-4 players pass-and-play or vs CPU; grid grows with player count; no persistence)
  - `www/watersort/` — Water Sort (seeded solvable level generator; progress under `watersort.state.v1`)
  - `www/2048/` — 2048 (swipe-merge; board resumes + daily/weekly/all-time bests under `2048.state.v1` / `2048.scores.v1`)
  - `www/minesweeper/` — Minesweeper (3 difficulties; tap digs, long-press or 🚩-mode flags, chording; safe first tap; best times under `minesweeper.best.v1`)
  - `www/blockparty/` — Block Party (Block Blast clone: drag 3 pieces onto 8×8, clear rows/cols; combo-multiplied line bonuses + all-clear bonus; unplayable tray pieces grey out; board resumes + daily/weekly/all-time bests under `blockparty.state.v1` / `blockparty.scores.v1`)
  - `www/balls/` — Balls (Ballz clone: slingshot-aim a volley of bouncing balls at numbered blocks, white-dot sightline; launcher moves to where the first ball lands; double-tap fast-forwards; +1 ball rings grow the volley, coin pickups buy ball skins/trails in a store under `balls.store.v1`; score = rounds survived; run resumes + daily/weekly/all-time bests under `balls.state.v1` / `balls.scores.v1`)
  - `www/jetrush/` — Jet Rush (endless jetpack runner: hold anywhere to thrust, release to
    drop, dodge zappers/laser gates/homing missiles and collect coins over a parallax dusk
    city; all art is procedural canvas drawing, no sprites. Difficulty is driven by
    `reactT` — how long a hazard is on screen before it reaches you — and the scroll speed
    is *derived* from it (`speed = runway / reactT`), because obstacles scale with height
    while the visible runway is the width; tying speed to height made a tall phone
    unplayable. Pattern pool opens up in stages (<120 m warm-up, <400 m gates/diagonals,
    then spinners/bobbers); score = metres, best D/W/all under `jetrush.scores.v1`,
    lifetime coins under `jetrush.coins.v1`. No mid-run resume — a runner can't be paused
    meaningfully)
  - `www/nertz/` — Nertz (real-time solitaire race: you + 3 CPUs, each with a 13-card Nertz pile, 4 work piles, and a 3-at-a-time stock, all racing simultaneously onto shared centre foundations built up by suit from the Ace; no turns — CPUs act on difficulty-scaled timers (Easy/Medium/Hard = speed + skill); tap a card to send it to the centre, drag to move onto your piles; empty your Nertz pile to end the round; +1 per card sent to centre, -2 per card left in Nertz pile; match to 100; state under `nertz.state.v1`)
- Photos come from the `@capacitor/camera` plugin when running natively, with an
  `<input type=file>` fallback so the games also work in a desktop browser for testing.

## Build

Toolchain (installed on this machine):
- JDK: `C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot` (set as JAVA_HOME for
  gradle). 21 is mandatory — Capacitor 7's `capacitor-android` compiles with
  `source release 21`, and JDK 17 fails with `error: invalid source release: 21`.
  Reinstall with `winget install EclipseAdoptium.Temurin.21.JDK` if it goes missing.
- Android SDK: `C:\Users\benwa\AppData\Local\Android\Sdk` (platforms 34/35/36,
  build-tools 34.0.0/35.0.0). `android/local.properties` is gitignored, so a fresh
  checkout needs it recreated: `sdk.dir=C\:\\Users\\benwa\\AppData\\Local\\Android\\Sdk`
- Gradle 8.11.1 / AGP 8.7.2 (via the wrapper).
- Gotcha: spawned processes here can inherit `C:\development` as their working directory
  even after `cd`/`Set-Location`, so pass gradle an explicit `-p <android dir>` or it
  reports "Directory 'C:\development' does not contain a Gradle build".

```powershell
npx cap sync android          # copy www/ into the android project (run after any www/ change)
cd android; .\gradlew.bat assembleDebug   # APK at android\app\build\outputs\apk\debug\app-debug.apk
```

Sideload the debug APK directly; it is signed with the debug keystore.

## Testing in a browser

Open `www/index.html` via a local static server (file:// breaks localStorage/canvas on some
browsers). Mouse works for all gestures except pinch-zoom in the pixel game.
