# Playgiarism

Ad-free clones of popular mobile games, bundled into one Android app. No ads, no
tracking, no in-app purchases — just the games.

## 📲 Download

**[⬇ Download the latest APK](https://github.com/gameywolf/Playgiarism/releases/latest/download/playgiarism.apk)**

To install: open the downloaded file on your Android phone and confirm. The first
time, Android will ask you to allow installs from your browser — enable it, then
go back and tap the file again. The app is signed with a debug key and never touches
the network.

## 🎮 Games

| Game | Clone of |
| --- | --- |
| Pixel Color by Number | photo → paint-by-number grid (uses your own photos) |
| Fruit Merge | Suika Game / Watermelon Game |
| Color Wars | chain-reaction dot battle, 2–4 players or vs CPU |
| Water Sort | water sort puzzle |
| 2048 | 2048 |
| Minesweeper | Minesweeper |
| Block Party | Block Blast |
| Balls | Ballz |
| Nertz | Nertz / Pounce (public-domain card game) |
| Jet Rush | Jetpack Joyride |
| Rock Bottom | Radical Rappelling |

## Building from source

The games are plain HTML5/canvas/vanilla JS in `www/`, wrapped with
[Capacitor](https://capacitorjs.com/) 7. You need Node, a JDK (21), and an Android
SDK (platform 35).

```sh
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
# APK lands in android/app/build/outputs/apk/debug/app-debug.apk
```

For quick testing in a desktop browser, serve `www/` with any static file server
and open `index.html` (file:// breaks localStorage on some browsers).
