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
  - `www/ricochet/` — Ricochet (Peggle-style: drop a ball from a top cannon into a peg
    field and clear every orange peg within 10 balls (the rack refills every level; only
    score carries); blue pegs score, green ★ pegs grant Long Guide / Blaster / Spooky
    Ball (drains wrap back in from the top) / Multiball, one purple bonus peg is
    re-rolled each shot, and a sliding bucket catches the ball for a free one. The
    scoring economy is Peggle's at 1/5 scale (same peg values but 18 oranges, not 25):
    a meter fills with each shot's score and pays a free ball at 5k/15k/25k (their
    25k/75k/125k); style bonuses feed the same meter (Long Shot 5k — consecutive
    non-blue pegs ≥45% of the field apart; Off the Wall 2k; Free Ball Skills 1k — one
    peg then bucket); the last orange triggers a fever finish where the bucket is
    replaced by five floor slots (2k/10k/20k/10k/2k) and spare balls convert at 2k
    each. Score multiplier climbs as oranges clear (fractional steps so ×10 is
    reachable); the last orange drops into slow motion. Difficulty ramps because
    everything else here got more generous: `orangeTarget()` grows the orange count
    from 12 by one every second level to Peggle's 25, seeded peg movers (sliding
    band or orbiting cluster) appear from level 4, and seeded brick arcs (capsule
    pegs via `pegCore()`, eligible to be orange) from level 6 — bricks never move.
    Balance was verified with a headless bot (vm + stubbed DOM): a ghost-sim
    aiming bot clears levels 1-6 reliably and dies around level 7; the first-cut
    ramp of +1 orange per level made even that bot die at median level 2. Levels come from a seeded generator
    (five layout families) so level N is reproducible without shipping a level list.
    The playfield is a fixed aspect with gutters (like Balls) — otherwise the peg lattice
    stretches with the window and the gap-to-ball ratio, which decides whether shots
    cascade, differs between phone and desktop. `BALL_R_F`/`PEG_GAP_F`/`PEG_E` at the top
    are a coupled set picked by sweeping them against full-level outcomes; change one and
    re-run the sweep. Progress under `ricochet.state.v1`, bests under `ricochet.scores.v1`)
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
  - `www/awesomefalling/` — Awesome Falling (Radical Rappelling clone: endless rappel down
    a cliff wall on the left edge (Ben wants the mountain on the left);
    the climber auto-bounces off the wall on a swing cycle derived
    from amplitude + period (`kickV`/`gPull` in `layout()`), hold to descend, release to
    stop; time descents at the swing apex to clear purple crystals of varying protrusion.
    Lava chases from above with rubber-banding (speeds up when >1.35 screens behind,
    clamped to 2.2 so stalling is always punished). Tricks — upright hoops the swing
    carries you through (park at their height; the crossing happens on its own),
    bullseyes hit on wall contact, 1-2-3 bounce-pad hop chains (pay out ONLY when all
    three are hit — partial hits show "n of 3…" and are worth nothing; Ben's call), and
    rainbow-ride clouds (brush one to be carried down a bezier rainbow arc) — grant
    bonus metres and charge a Frenzy meter (invulnerable fast descent). Pickups:
    rocket (1.5 s invulnerable 1.8× descent) and magnet (8 s coin attraction).
    No falling boulders — they were built and Ben had them removed (vertical-only
    control made them feel undodgeable); don't reintroduce them. Worlds cycle every
    300 m (Sunny Cliffs → Deep Jungle → Frozen Falls → Magma Core → Crystal Depths),
    palettes blended over each band's last 40 m; the rope's free end hangs below the
    climber like a real rappel line. Score = metres descended incl. trick bonuses, best
    D/W/all under `awesomefalling.scores.v1`, lifetime coins under
    `awesomefalling.coins.v1`. No mid-run resume)
  - `www/lawn/` — Lawn Defense (Plants vs. Zombies clone: five lanes, seed packets with
    sun costs and per-packet cooldowns, shamblers that stop to chew whatever is in front
    of them, one single-use mower per lane as the last line, second breach in a lane ends
    the run. Lanes run side-on: shamblers walk in from the right, plants shoot right, and
    the mowers wait along the left in front of the house. Internally a shambler still
    advances along one "depth" coordinate counting up from 0 at the spawn edge to DEPTH at
    the house, so the movement, chewing and mower logic stays one-dimensional and
    direction-agnostic — only `dx()`/`ly()` know the lawn is drawn right-to-left, which is
    what made the rotation a projection change rather than a rewrite.
    **This is the one game that runs landscape.** `AndroidManifest.xml` pins the activity
    to `portrait` for everything else, so the page calls `@capacitor/screen-orientation` at
    load to request landscape and explicitly re-locks portrait on the way out (back button
    first, `pagehide` as backup) — the whole app shares one WebView, so leaving without
    restoring strands the menu sideways. `unlock()` is deliberately not used: it maps to
    SCREEN_ORIENTATION_UNSPECIFIED, which frees rotation rather than returning to the
    manifest value. In a browser the lock needs fullscreen and usually fails, so `draw()`
    shows a "turn sideways" nudge whenever the canvas ends up portrait.
    Landscape alone barely helped (42px → 44px cells) because height then became the
    binding axis, so the seed tray moves to whichever edge is affordable: a column on the
    left in landscape, the usual bar on top in portrait, and `body.lawn` gets a media query
    compacting the shared topbar/HUD on short screens (117px → 77px). Together those take a
    720×400 phone to ~63px cells. Six plants unlock by level (Sunbloom/Pea Pod → Barknut → Boom Berry
    → Frost Pod → Twin Pod), four shambler types unlock the same way.
    `ZOMBIES[].speed` is the balance-critical number: it's in rows per second, and a
    standard shambler crossing the eight rows in ~36s is just longer than one Pea Pod
    (14 dps) needs to chew through its 200 hp. Push it past ~0.3 and one shooter per lane
    stops holding a lane, which makes the early levels unwinnable — an early cut used 0.30
    and a scripted bot couldn't clear level 2. Every level starts from bare lawn while the
    waves get thicker, so `startSun()` and `prepMs()` ramp with level to stand in for the
    garden you'd otherwise carry over; without them a run stalls at level 4 however well
    it's played. Waves come from a seeded generator (`buildWaves`) so level N is the same
    fight every time; wave *count* grows every third level because every second was a
    cliff. Score carries across levels
    within a run but rolls back to `checkpoint` on a retry, so a failed level can't be
    farmed. Progress under `lawn.state.v1`, bests D/W/all under `lawn.scores.v1`)
  - `www/nertz/` — Nertz (real-time solitaire race: you + 3 CPUs, each with a 13-card Nertz pile, 4 work piles, and a 3-at-a-time stock, all racing simultaneously onto shared centre foundations built up by suit from the Ace; no turns — CPUs act on difficulty-scaled timers (Easy/Medium/Hard = speed + skill); tap a card to send it to the centre, drag to move onto your piles; empty your Nertz pile to end the round; +1 per card sent to centre, -2 per card left in Nertz pile; match to 100; state under `nertz.state.v1`)
  - `www/homesweep/` — Home Sweep Home (Homescapes clone, match-3 half only, no
    decorating metagame: 9×9 masked boards, swap/tap; 4-line → rocket (perpendicular),
    2×2 → paper plane (cross blast + flies to the most useful target), L/T → bomb,
    5-line → disco ball, all pairwise combos implemented. Obstacles: donuts (1 adjacent
    match), crates (2 hits), bubbles (trap a piece until hit), grass (a match touching
    grass grasses the whole match — spreads only via matches, so grass levels get extra
    moves). Levels are seeded (`buildLevel`): mask family, obstacle mix (unlocks at
    levels 2/4/6/8), colour-collect objectives and move counts all derive from the level
    number; only refill pieces are random. Gravity fills diagonally around blockers and
    holes so masked/blocked columns never starve. Progress under `homesweep.state.v1` —
    level number only, no mid-level resume)
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
