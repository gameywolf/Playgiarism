# Playgiarism

Ad-free clones of mobile games, packaged as a single Android app.

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
- Photos come from the `@capacitor/camera` plugin when running natively, with an
  `<input type=file>` fallback so the games also work in a desktop browser for testing.

## Build

Toolchain (already installed on this machine):
- JDK: `C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot` (set as JAVA_HOME for gradle)
- Android SDK: `C:\Users\Kronk\android-sdk` (referenced by `android/local.properties`)

```powershell
npx cap sync android          # copy www/ into the android project (run after any www/ change)
cd android; .\gradlew.bat assembleDebug   # APK at android\app\build\outputs\apk\debug\app-debug.apk
```

Sideload the debug APK directly; it is signed with the debug keystore.

## Testing in a browser

Open `www/index.html` via a local static server (file:// breaks localStorage/canvas on some
browsers). Mouse works for all gestures except pinch-zoom in the pixel game.
