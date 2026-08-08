/* Lawn Defense — a lane defender. Sprouts hold the garden; shamblers march across it.
   Lanes run side-on: shamblers walk in from the right, plants shoot right, and the
   mowers wait along the left edge in front of the house.

   Internally a shambler still *advances* along a single "depth" coordinate that counts
   up from 0 at the spawn edge to DEPTH at the house, so all the movement, chewing and
   mower logic is one-dimensional and direction-agnostic. Only the projection to pixels
   knows which way round the lawn is: depth is drawn right-to-left (see dx/cellCX), so
   depth 0 is the right-hand column and depth DEPTH-1 is the column the mowers defend.

   Levels come from a seeded wave generator (see buildWaves) rather than a hand-authored
   list, so level N is the same fight every time without shipping level data. */
'use strict';

const STATE_KEY = 'lawn.state.v1';
const SCORE_KEY = 'lawn.scores.v1';

const LANES = 5, DEPTH = 8;

const START_SUN = 125;       // level 1; see startSun() for the per-level ramp
const SUN_VALUE = 25;
const SKY_EVERY = 7000;      // ms between suns falling from the sky
const SUN_LIFE = 9000;       // how long a sun sits before fading
const BLOOM_FIRST = 7000;    // Sunbloom's first payout
const BLOOM_EVERY = 14000;
const BREATHER_MS = 8000;    // gap between waves
const BANNER_MS = 2200;
const MOWER_SPEED = 9;       // rows/sec
const BASE_BUDGET = 2;       // wave-one spawn budget at level 1

/* Plants. `hp` is in the same units as zombie damage-per-second, so a 300 hp plant is
   three seconds of chewing for a standard shambler. Unlocks stagger the tray so level 1
   is two packets rather than six. */
const PLANTS = {
  sun:   { name: 'Sunbloom',   cost: 50,  cd: 5000,  hp: 300,  unlock: 1 },
  pea:   { name: 'Pea Pod',    cost: 100, cd: 5000,  hp: 300,  unlock: 1, rate: 1400, dmg: 20 },
  nut:   { name: 'Barknut',    cost: 50,  cd: 20000, hp: 4000, unlock: 2 },
  boom:  { name: 'Boom Berry', cost: 150, cd: 30000, hp: 1,    unlock: 3, fuse: 1200, blast: 1800 },
  frost: { name: 'Frost Pod',  cost: 175, cd: 5000,  hp: 300,  unlock: 4, rate: 1400, dmg: 20 },
  twin:  { name: 'Twin Pod',   cost: 200, cd: 8000,  hp: 300,  unlock: 5, rate: 1400, dmg: 20 },
};
const TRAY_ORDER = ['sun', 'pea', 'nut', 'boom', 'frost', 'twin'];

/* Shamblers. `speed` is rows per second, and it is the number that decides whether a
   lane is defensible: a standard shambler crossing the eight rows in ~36s is just longer
   than one Pea Pod (14 dps) needs to chew through its 200 hp, so a single shooter holds a
   lane against a trickle and nothing more. Speeding them up past ~0.3 makes one shooter
   per lane useless and the early levels unwinnable — check that ratio before touching it. */
const ZOMBIES = {
  shambler: { name: 'Shambler', hp: 200,  armor: 0,   speed: 0.22, dps: 100, cost: 1, points: 10, weight: 6, unlock: 1 },
  shield:   { name: 'Shielded', hp: 200,  armor: 300, speed: 0.20, dps: 100, cost: 3, points: 30, weight: 3, unlock: 2 },
  runner:   { name: 'Runner',   hp: 130,  armor: 0,   speed: 0.52, dps: 100, cost: 2, points: 20, weight: 3, unlock: 3, scale: 0.92 },
  brute:    { name: 'Brute',    hp: 1400, armor: 0,   speed: 0.12, dps: 180, cost: 8, points: 80, weight: 1.5, unlock: 5, scale: 1.3 },
};

// ---------------- High scores (daily / weekly / all-time, same as 2048) ----------------
function dayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function weekKey(d = new Date()) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - day + 3);
  const firstThu = new Date(t.getFullYear(), 0, 4);
  const fday = (firstThu.getDay() + 6) % 7;
  firstThu.setDate(firstThu.getDate() - fday + 3);
  const week = 1 + Math.round((t - firstThu) / (7 * 24 * 3600 * 1000));
  return t.getFullYear() + '-W' + String(week).padStart(2, '0');
}
function loadScores() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SCORE_KEY)) || {}; } catch { s = {}; }
  if (!s.daily || s.daily.key !== dayKey()) s.daily = { key: dayKey(), score: 0 };
  if (!s.weekly || s.weekly.key !== weekKey()) s.weekly = { key: weekKey(), score: 0 };
  if (typeof s.allTime !== 'number') s.allTime = 0;
  return s;
}
function reportScore(sc) {
  const s = loadScores();
  const records = [];
  if (sc > s.daily.score) { s.daily.score = sc; records.push('daily'); }
  if (sc > s.weekly.score) { s.weekly.score = sc; records.push('weekly'); }
  if (sc > s.allTime) { s.allTime = sc; records.push('all-time'); }
  localStorage.setItem(SCORE_KEY, JSON.stringify(s));
  return records;
}
function bestsRow() {
  const s = loadScores();
  return `<span>Day <b>${s.daily.score}</b></span><span>Week <b>${s.weekly.score}</b></span><span>All time <b>${s.allTime}</b></span>`;
}

// ---------------- Seeded RNG (a level's waves are reproducible from its number) ----------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- Game state ----------------
let level = 1;
let score = 0;
let checkpoint = 0;         // score banked when the current level started — a retry rolls
                            // back to it, so a failed level can't be farmed for points
let sun = START_SUN;        // replaced by startSun() at every startLevel()
let grid = [];              // DEPTH*LANES, plant object or null
let zombies = [];
let peas = [];
let suns = [];
let blasts = [];
let popups = [];
let mowers = [];            // one per lane, null once used
let waves = [];
let waveIdx = -1;           // -1 = the prep window before wave 1
let waveT = 0;              // ms into the current wave
let spawnIdx = 0;
let breatherT = 0;
let phase = 'play';         // 'play' | 'won' | 'over'
let selected = null;        // tray packet id, 'shovel', or null
let cooldowns = {};
let skyT = SKY_EVERY;
let banner = null;
let runRecords = new Set();
let now = 0;
let zid = 0;

/* ---------------- Orientation ----------------
   Side-on lanes want a wide screen, but the app's activity is pinned to portrait in
   AndroidManifest.xml for every other game. setRequestedOrientation at runtime overrides
   the manifest for the live activity, so this page asks for landscape on the way in and
   puts portrait back on the way out — the whole app shares one WebView, so leaving
   without restoring would strand the menu and every other game sideways.

   unlock() is deliberately not used on exit: it maps to SCREEN_ORIENTATION_UNSPECIFIED,
   which lets the device rotate freely rather than returning to the manifest's portrait. */
const screenOrientation = () =>
  window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenOrientation;

async function lockLandscape() {
  const so = screenOrientation();
  if (so) { try { await so.lock({ orientation: 'landscape' }); return; } catch { /* fall through */ } }
  // Browsers only allow this in fullscreen, so it usually rejects — the rotate nudge in
  // draw() covers the case where we end up portrait anyway.
  try { await screen.orientation.lock('landscape'); } catch { /* not supported */ }
}
async function restorePortrait() {
  const so = screenOrientation();
  if (so) { try { await so.lock({ orientation: 'portrait' }); } catch { /* ignore */ } }
  try { screen.orientation.unlock(); } catch { /* ignore */ }
}

// ---------------- Layout ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, G = null;

let safeProbe = null;
function safeBottom() {
  if (!safeProbe) {
    safeProbe = document.createElement('div');
    safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:var(--safe-bottom);pointer-events:none;visibility:hidden;';
    document.body.appendChild(safeProbe);
  }
  return safeProbe.getBoundingClientRect().height;
}

/* Everything in play is stored in grid units — a shambler's position is a float depth in
   a fixed lane, a pea's likewise — so a resize or rotate just re-derives pixels and
   nothing teleports. */
function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const w = r.width, h = r.height;
  const bottom = Math.max(safeBottom(), 4);
  /* The seed tray sits along whichever edge we can afford to spend. In landscape height
     is the scarce axis (five lanes have to fit under the topbar and HUD) while width is
     plentiful, so the tray becomes a column on the left and gives its 54px back to the
     lawn; in portrait it stays the usual bar across the top. Without this, forcing
     landscape barely moved the cell size — the lawn just became height-bound instead. */
  const sideways = w > h;
  const trayW = sideways ? Math.min(Math.max(w * 0.1, 62), 96) : 0;
  const trayH = sideways ? 0 : Math.min(Math.max(h * 0.13, 54), 88);
  const availW = w - trayW;
  const availH = h - trayH - bottom;
  // DEPTH columns of lawn, plus a column on the right the shamblers walk in along (they
  // spawn inside it rather than off-screen) and 0.62 on the left for the mowers and house.
  const cell = Math.min(availW / (DEPTH + 1.62), availH * 0.98 / LANES);
  const gw = cell * DEPTH, gh = cell * LANES;
  const ox = trayW + cell * 0.62 + Math.max(0, availW - cell * (DEPTH + 1.62)) * 0.5;
  const oy = trayH + Math.max(0, availH - gh) * 0.5;
  G = { w, h, trayH, trayW, cell, gw, gh, ox, oy, slots: traySlots(w, h, trayW, trayH) };
}

// Tray slot rects, recomputed on layout and whenever the unlock set changes.
// trayW > 0 means the column-on-the-left form; otherwise the bar across the top.
function traySlots(w, h, trayW, trayH) {
  const ids = unlockedPlants().concat('shovel');
  const n = ids.length;
  if (trayW > 0) {
    const gap = Math.min(8, h * 0.014);
    const sh = Math.min((h - 12 - gap * (n - 1)) / n, trayW * 1.05);
    const sw = Math.min(trayW - 10, sh * 0.92);
    const total = sh * n + gap * (n - 1);
    const y0 = Math.max(6, (h - total) / 2);
    return ids.map((id, i) => ({ id, x: (trayW - sw) / 2, y: y0 + i * (sh + gap), w: sw, h: sh }));
  }
  const gap = Math.min(8, w * 0.016);
  const sw = Math.min((w - 12 - gap * (n - 1)) / n, (trayH - 12) * 0.86);
  const total = sw * n + gap * (n - 1);
  const x0 = (w - total) / 2;
  return ids.map((id, i) => ({ id, x: x0 + i * (sw + gap), y: 6, w: sw, h: trayH - 12 }));
}
function unlockedPlants() {
  return TRAY_ORDER.filter(id => level >= PLANTS[id].unlock);
}

/* Grid -> pixels. Depth is drawn right-to-left, so a shambler advancing (depth going up)
   walks leftward toward the house, and a mower running back down the depth axis drives
   rightward. Everything else in the file works in depth/lane units and never needs to
   know that. */
const dx = d => G.ox + (DEPTH - d) * G.cell;      // continuous depth coord -> x
const ly = l => G.oy + l * G.cell;                // continuous lane coord -> y
const cellX = d => dx(d + 0.5);                   // cell centre x for depth index d
const cellY = l => ly(l + 0.5);                   // cell centre y for lane index l

// ---------------- Level / wave generation ----------------
/* A wave is a list of {t, type, lane} spawns. Budget grows with both the wave number and
   the level, and the final wave of every level is worth double — that's the one the
   mowers usually get spent on. */
function buildWaves(lv) {
  const rnd = mulberry32(lv * 7919 + 13);
  // Waves grow every third level; every second was a cliff (level 5 doubled level 4).
  const count = 3 + Math.min(3, Math.floor((lv - 1) / 3));
  const pool = Object.keys(ZOMBIES).filter(k => lv >= ZOMBIES[k].unlock);
  const out = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    let budget = Math.round(BASE_BUDGET * (1 + 0.45 * i) * (1 + 0.18 * (lv - 1)) * (last ? 1.8 : 1));
    const picks = [];
    let guard = 0;
    while (budget > 0 && guard++ < 300) {
      const can = pool.filter(k => ZOMBIES[k].cost <= budget);
      if (!can.length) break;
      const total = can.reduce((a, k) => a + ZOMBIES[k].weight, 0);
      let roll = rnd() * total, k = can[0];
      for (const c of can) { roll -= ZOMBIES[c].weight; if (roll <= 0) { k = c; break; } }
      picks.push(k);
      budget -= ZOMBIES[k].cost;
    }
    // Spread the spawns over a window, tighter on the final wave so it actually crowds.
    const window = 4000 + picks.length * (last ? 850 : 1600);
    const times = picks.map(() => rnd() * window).sort((a, b) => a - b);
    const laneUse = new Array(LANES).fill(0);
    const spawns = picks.map((type, j) => {
      // Prefer the least-used lanes so a wave never piles into one column.
      const min = Math.min(...laneUse);
      const open = [];
      for (let c = 0; c < LANES; c++) if (laneUse[c] === min) open.push(c);
      const lane = open[Math.floor(rnd() * open.length)];
      laneUse[lane]++;
      return { t: Math.max(0, times[j] + j * 120), type, lane };
    });
    out.push({ spawns, last });
  }
  return out;
}

/* Every level starts from bare lawn, but the waves arrive sooner and thicker as levels
   go up — so without these two ramps the window for building an economy shrinks every
   level and the run stalls out around level 4 no matter how well it's played. Starting
   sun and prep time stand in for the garden you'd otherwise have carried over. */
function startSun() { return START_SUN + Math.min(150, (level - 1) * 35); }
function prepMs() { return level === 1 ? 20000 : 14000 + Math.min(6000, (level - 1) * 1200); }

// ---------------- Setup ----------------
function startLevel(keepScore) {
  if (!keepScore) checkpoint = 0;
  score = checkpoint;
  grid = new Array(DEPTH * LANES).fill(null);
  zombies = []; peas = []; suns = []; blasts = []; popups = [];
  mowers = new Array(LANES).fill(null).map(() => ({ row: DEPTH + 0.35, running: false }));
  waves = buildWaves(level);
  waveIdx = -1;
  waveT = 0;
  spawnIdx = 0;
  breatherT = prepMs();
  sun = startSun();
  cooldowns = {};
  selected = null;
  skyT = SKY_EVERY * 0.6;
  phase = 'play';
  banner = { txt: 'Level ' + level, sub: 'Plant while you can', t: 0 };
  if (G) G.slots = traySlots(G.w, G.h, G.trayW, G.trayH);
  hideOverlays();
  updateHud();
  saveState();
}
function newGame() {
  level = 1;
  checkpoint = 0;
  runRecords = new Set();
  startLevel(false);
}

// Only the checkpoint is persisted — points earned during a level that was never
// finished don't survive a reload, same as they don't survive a retry.
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ level, score: checkpoint })); } catch { /* full or blocked */ }
}
function loadState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STATE_KEY)); } catch { return false; }
  if (!s || typeof s.level !== 'number' || s.level < 1) return false;
  level = Math.min(999, Math.floor(s.level));
  checkpoint = score = Math.max(0, Math.floor(s.score) || 0);
  return true;
}

// ---------------- Actions ----------------
// Pixel coords: popups are short-lived and come from several different frames of
// reference (a grid cell, a shambler mid-lane, a sun anywhere on screen), so they're
// projected once at creation rather than carrying a coordinate system around.
function popup(px, py, txt, col, big) {
  popups.push({ px, py, txt, col: col || '#fff', big: !!big, t: 0 });
}

/* A Sunbloom's payout lobs a full cell clear of the plant before settling. Dropping it
   on top of the flower buried it: same yellow, same size, sitting over the petals, and
   easy to miss entirely. It hops toward the next lane, or back the other way when the
   bloom is in the last one, so it always ends up on open grass. */
function addBloomSun(depth, lane) {
  // tossed out to the right (the emptier side — players build up from the left) and then
  // settling a lane over, so it ends up roughly a cell clear of the bloom in both axes
  const gx0 = DEPTH - depth - 0.5;
  const gx = Math.min(DEPTH - 0.35, Math.max(0.35, gx0 + 0.58 + (Math.random() - 0.5) * 0.2));
  const gy = lane + 0.5;
  const dir = lane >= LANES - 1.5 ? -1 : 1;
  const ty = Math.min(LANES - 0.3, Math.max(0.3, gy + dir * 0.66));
  suns.push({ gx, gy, ty, value: SUN_VALUE, t: 0, landed: false, vy: 1.7 });
}
function spawnSkySun() {
  const gx = 0.55 + Math.random() * (DEPTH - 1.1);
  suns.push({ gx, gy: -1.2, ty: 0.5 + Math.random() * (LANES - 1.0), value: SUN_VALUE, t: 0, landed: false, vy: 1.4 });
}

function canAfford(id) { return sun >= PLANTS[id].cost && !(cooldowns[id] > 0); }

function tryPlant(c, r) {
  if (!selected || selected === 'shovel') return false;
  if (c < 0 || c >= LANES || r < 0 || r >= DEPTH) return false;
  if (grid[r * LANES + c]) return false;
  const def = PLANTS[selected];
  if (!canAfford(selected)) return false;
  sun -= def.cost;
  cooldowns[selected] = def.cd;
  const p = { type: selected, c, r, hp: def.hp, maxHp: def.hp, t: 0, shootT: 400, prodT: BLOOM_FIRST, fuse: def.fuse || 0, burst: 0, burstT: 0, recoil: 0 };
  grid[r * LANES + c] = p;
  selected = null;
  updateHud();
  return true;
}
function shovel(c, r) {
  const p = grid[r * LANES + c];
  if (!p) return false;
  grid[r * LANES + c] = null;
  popup(cellX(r), cellY(c), '✕', '#ffd9d9');
  selected = null;
  return true;
}

function fire(p) {
  const def = PLANTS[p.type];
  peas.push({ lane: p.c, row: p.r + 0.1, dmg: def.dmg, frost: p.type === 'frost' });
  p.recoil = 1;
}

function explode(c, r, dmg) {
  blasts.push({ c, r, t: 0 });
  for (const z of zombies) {
    if (Math.abs(z.lane - c) <= 1 && Math.abs(z.row + 0.5 - (r + 0.5)) <= 1.35) hurt(z, dmg, false);
  }
  for (let rr = r - 1; rr <= r + 1; rr++) {
    for (let cc = c - 1; cc <= c + 1; cc++) {
      if (rr < 0 || rr >= DEPTH || cc < 0 || cc >= LANES) continue;
      const q = grid[rr * LANES + cc];
      if (q && q.type === 'boom' && !(cc === c && rr === r)) q.fuse = Math.min(q.fuse, 120);
    }
  }
}

function hurt(z, dmg, chill) {
  if (z.dead) return;
  if (z.armor > 0) {
    const a = Math.min(z.armor, dmg);
    z.armor -= a;
    dmg -= a;
  }
  z.hp -= dmg;
  z.flash = 90;
  if (chill) z.chill = 4000;
  if (z.hp <= 0) {
    z.dead = true;
    score += ZOMBIES[z.type].points;
    popup(dx(z.row + 0.5), cellY(z.lane) - G.cell * 0.22, '+' + ZOMBIES[z.type].points, '#e9ffd9');
    updateHud();
  }
}

function spawnZombie(type, lane) {
  const d = ZOMBIES[type];
  zombies.push({
    id: ++zid, type, lane, row: -0.92 - Math.random() * 0.2,
    hp: d.hp, armor: d.armor, chill: 0, eating: false, wob: Math.random() * 6.28,
    flash: 0, dead: false,
  });
}

// ---------------- Update ----------------
function update(dt) {
  now += dt;
  for (const id in cooldowns) if (cooldowns[id] > 0) cooldowns[id] = Math.max(0, cooldowns[id] - dt);
  if (banner) { banner.t += dt; if (banner.t > BANNER_MS) banner = null; }

  for (const b of blasts) b.t += dt;
  blasts = blasts.filter(b => b.t < 520);
  for (const p of popups) p.t += dt;
  popups = popups.filter(p => p.t < 900);

  if (phase !== 'play') { updateMowers(dt); return; }

  updateSun(dt);
  updateWaves(dt);
  updatePlants(dt);
  updatePeas(dt);
  updateZombies(dt);
  updateMowers(dt);

  zombies = zombies.filter(z => !z.dead);

  if (phase === 'play' && waveIdx >= waves.length - 1 && waveIdx >= 0 &&
      spawnIdx >= waves[waveIdx].spawns.length && zombies.length === 0) {
    winLevel();
  }
}

function updateSun(dt) {
  skyT -= dt;
  if (skyT <= 0) { spawnSkySun(); skyT = SKY_EVERY; }
  for (const s of suns) {
    if (!s.landed) {
      // moves toward ty from either side — sky suns fall in, bloom suns can hop up
      const step = s.vy * dt / 1000;
      s.gy += s.gy < s.ty ? Math.min(step, s.ty - s.gy) : -Math.min(step, s.gy - s.ty);
      if (Math.abs(s.gy - s.ty) < 1e-3) { s.gy = s.ty; s.landed = true; }
    } else s.t += dt;
  }
  suns = suns.filter(s => s.t < SUN_LIFE);
}

function updateWaves(dt) {
  if (breatherT > 0) {
    breatherT -= dt;
    if (breatherT <= 0) {
      waveIdx++;
      waveT = 0;
      spawnIdx = 0;
      const w = waves[waveIdx];
      banner = w.last
        ? { txt: 'Final Wave!', sub: 'Hold the line', t: 0 }
        : { txt: 'Wave ' + (waveIdx + 1) + ' of ' + waves.length, sub: '', t: 0 };
      updateHud();
    }
    return;
  }
  if (waveIdx < 0 || waveIdx >= waves.length) return;
  const w = waves[waveIdx];
  waveT += dt;
  while (spawnIdx < w.spawns.length && waveT >= w.spawns[spawnIdx].t) {
    const s = w.spawns[spawnIdx++];
    spawnZombie(s.type, s.lane);
  }
  // The wave is done once its shamblers are gone. The timeout is a backstop for one
  // stuck on a Barknut — otherwise a single stalled chewer freezes the level.
  if (spawnIdx >= w.spawns.length && !w.last) {
    const lastT = w.spawns.length ? w.spawns[w.spawns.length - 1].t : 0;
    if (zombies.length === 0 || waveT > lastT + 30000) breatherT = BREATHER_MS;
  }
}

function updatePlants(dt) {
  for (let i = 0; i < grid.length; i++) {
    const p = grid[i];
    if (!p) continue;
    p.t += dt;
    if (p.recoil > 0) p.recoil = Math.max(0, p.recoil - dt / 160);
    if (p.hp <= 0) { grid[i] = null; continue; }

    if (p.type === 'sun') {
      p.prodT -= dt;
      if (p.prodT <= 0) {
        p.prodT = BLOOM_EVERY;
        p.pop = 1;
        addBloomSun(p.r, p.c);
      }
      if (p.pop > 0) p.pop = Math.max(0, p.pop - dt / 400);
    } else if (p.type === 'boom') {
      p.fuse -= dt;
      if (p.fuse <= 0) {
        explode(p.c, p.r, PLANTS.boom.blast);
        grid[i] = null;
      }
    } else if (p.type === 'pea' || p.type === 'frost' || p.type === 'twin') {
      if (p.burst > 0) {
        p.burstT -= dt;
        if (p.burstT <= 0) { fire(p); p.burst--; p.burstT = 140; }
      } else if (laneTarget(p.c, p.r)) {
        p.shootT -= dt;
        if (p.shootT <= 0) {
          p.shootT = PLANTS[p.type].rate;
          fire(p);
          if (p.type === 'twin') { p.burst = 1; p.burstT = 140; }
        }
      }
    }
  }
}

// Is there anything worth shooting further up this lane?
function laneTarget(c, r) {
  for (const z of zombies) {
    if (z.lane === c && !z.dead && z.row < r + 0.55 && z.row > -1.3) return true;
  }
  return false;
}

function updatePeas(dt) {
  for (const q of peas) {
    q.row -= 6.5 * dt / 1000;
    for (const z of zombies) {
      if (z.dead || z.lane !== q.lane) continue;
      if (q.row > z.row + 0.12 && q.row < z.row + 0.9) {
        hurt(z, q.dmg, q.frost);
        q.hit = true;
        break;
      }
    }
  }
  peas = peas.filter(q => !q.hit && q.row > -1.6);
}

function updateZombies(dt) {
  for (const z of zombies) {
    if (z.dead) continue;
    const d = ZOMBIES[z.type];
    if (z.chill > 0) z.chill -= dt;
    if (z.flash > 0) z.flash -= dt;
    // The cell under a shambler's hands is the one it chews on.
    const cr = Math.floor(z.row + 0.62);
    const target = cr >= 0 && cr < DEPTH ? grid[cr * LANES + z.lane] : null;
    z.eating = !!target;
    if (target) {
      target.hp -= d.dps * dt / 1000;
      target.bite = 1;
    } else {
      const sp = d.speed * (z.chill > 0 ? 0.5 : 1);
      z.row += sp * dt / 1000;
      z.wob += dt / 1000 * (2.4 + sp * 2);
    }
  }
}

function updateMowers(dt) {
  for (let c = 0; c < LANES; c++) {
    const m = mowers[c];
    if (!m) continue;
    if (m.running) {
      // Sweep in small steps rather than jumping the whole frame at once. At MOWER_SPEED
      // a single 50ms frame (the dt clamp in loop(), i.e. one dropped frame) moves the
      // mower 0.45 rows — further than its own hit window — so testing only the
      // post-move position let it tunnel straight past the shambler it was launched at.
      // That wasted the mower *and* ended the run on a breach that should be survivable.
      let move = MOWER_SPEED * dt / 1000;
      while (move > 0) {
        const step = Math.min(move, 0.3);
        m.row -= step;
        move -= step;
        for (const z of zombies) {
          if (!z.dead && z.lane === c && Math.abs(z.row + 0.5 - m.row) < 0.7) hurt(z, 99999, false);
        }
      }
      if (m.row < -1.6) mowers[c] = null;
    }
  }
  if (phase !== 'play') return;
  for (const z of zombies) {
    if (z.dead || z.row < DEPTH + 0.15) continue;
    const m = mowers[z.lane];
    if (m && !m.running) {
      m.running = true;
      popup(dx(DEPTH - 0.4), cellY(z.lane), 'MOWED!', '#ffe9a8', true);
    } else if (!m) {
      loseLevel();
      return;
    } else if (z.row > DEPTH + 1.5) {
      // A mower mid-sweep starts below every shambler in its lane and clears the whole
      // lane in under a second, so it catches anything that crosses while it runs — two
      // arriving on the same tick is survivable. This is the backstop for the state that
      // shouldn't happen: something walked off the bottom alive, which would leave the
      // wave waiting forever on a shambler that can never die.
      loseLevel();
      return;
    }
  }
}

// ---------------- Win / lose ----------------
function winLevel() {
  phase = 'won';
  score += 100 * level;
  checkpoint = score;
  for (const r of reportScore(score)) runRecords.add(r);
  document.getElementById('winNote').textContent =
    `Level ${level} cleared — ${waves.length} waves turned back.`;
  document.getElementById('winScore').textContent = score;
  document.getElementById('winBests').innerHTML = bestsRow();
  document.getElementById('winOverlay').classList.add('active');
  level++;
  saveState();
  updateHud();
}
function loseLevel() {
  phase = 'over';
  const recs = reportScore(score);
  for (const r of recs) runRecords.add(r);
  document.getElementById('overNote').textContent =
    `They got through on level ${level}${waveIdx >= 0 ? ` during wave ${waveIdx + 1}` : ''}.`;
  document.getElementById('finalScore').textContent = score;
  document.getElementById('recordNote').textContent =
    runRecords.size ? 'New ' + [...runRecords].join(' + ') + ' best!' : '';
  document.getElementById('finalBests').innerHTML = bestsRow();
  document.getElementById('overOverlay').classList.add('active');
  saveState();
}
function hideOverlays() {
  document.getElementById('winOverlay').classList.remove('active');
  document.getElementById('overOverlay').classList.remove('active');
}

function updateHud() {
  document.getElementById('hudSun').textContent = Math.floor(sun);
  document.getElementById('hudLevel').textContent = level;
  document.getElementById('hudScore').textContent = score;
  document.getElementById('hudWave').textContent =
    waveIdx < 0 ? '–' : (waveIdx + 1) + '/' + waves.length;
}

// ---------------- Drawing helpers ----------------
function rr(x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
function eyes(x, y, s, look) {
  ctx.fillStyle = '#fff';
  circle(x - s * 0.16, y, s * 0.1);
  circle(x + s * 0.16, y, s * 0.1);
  ctx.fillStyle = '#2b2b3d';
  circle(x - s * 0.16 + (look || 0) * s * 0.03, y + s * 0.01, s * 0.055);
  circle(x + s * 0.16 + (look || 0) * s * 0.03, y + s * 0.01, s * 0.055);
}

// ---------------- Plant art (all procedural — no sprites anywhere in this project) ----
function drawPlant(type, x, y, s, p) {
  const t = p ? p.t : 0;
  const bob = p ? Math.sin(t / 520 + x) * s * 0.018 : 0;
  const bite = p && p.bite > 0 ? Math.sin(now / 60) * s * 0.03 : 0;
  ctx.save();
  ctx.translate(x + bite, y + bob);
  const rec = p ? p.recoil : 0;
  if (rec) ctx.translate(-rec * s * 0.07, 0);   // kick back left, against the shot

  // shadow
  ctx.fillStyle = '#00000018';
  ctx.beginPath(); ctx.ellipse(0, s * 0.34, s * 0.26, s * 0.09, 0, 0, 7); ctx.fill();

  if (type === 'sun') {
    stem(s);
    const petals = 10;
    ctx.fillStyle = '#ffd24a';
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + t / 2600;
      ctx.save();
      ctx.translate(Math.cos(a) * s * 0.2, Math.sin(a) * s * 0.2 - s * 0.06);
      ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.115, s * 0.075, 0, 0, 7); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#8a5a1c';
    circle(0, -s * 0.06, s * 0.155);
    ctx.fillStyle = '#c98b2e';
    circle(0, -s * 0.06, s * 0.135);
    eyes(0, -s * 0.09, s * 0.9);
    ctx.strokeStyle = '#7a4a12';
    ctx.lineWidth = s * 0.022;
    ctx.beginPath(); ctx.arc(0, -s * 0.05, s * 0.06, 0.5, Math.PI - 0.5); ctx.stroke();
    if (p && p.pop > 0) {
      ctx.globalAlpha = p.pop;
      ctx.strokeStyle = '#ffe999';
      ctx.lineWidth = s * 0.03;
      ctx.beginPath(); ctx.arc(0, -s * 0.06, s * 0.2 + (1 - p.pop) * s * 0.2, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  } else if (type === 'pea' || type === 'frost' || type === 'twin') {
    const cool = type === 'frost';
    const body = cool ? '#bfe9ff' : '#5cc25a';
    const dark = cool ? '#8ec9e8' : '#3d9b3d';
    stem(s, cool ? '#7fbf9c' : '#3d9b3d');
    // barrel(s), pointing right down the lane
    ctx.fillStyle = dark;
    const by = type === 'twin' ? [-s * 0.105, s * 0.075] : [-s * 0.015];
    for (const o of by) { rr(s * 0.14, o - s * 0.055, s * 0.26, s * 0.11, s * 0.04); ctx.fill(); }
    ctx.fillStyle = body;
    if (type === 'twin') {
      // two heads stacked, so it reads differently from the single Pea Pod
      circle(0, -s * 0.22, s * 0.145);
      circle(0, -s * 0.04, s * 0.145);
    }
    circle(0, -s * 0.13, s * 0.175);
    ctx.fillStyle = dark;
    ctx.globalAlpha = 0.35;
    circle(s * 0.06, -s * 0.08, s * 0.11);
    ctx.globalAlpha = 1;
    eyes(s * 0.03, -s * 0.16, s * 0.95, 0.5);
    if (cool) {
      ctx.strokeStyle = '#ffffffcc';
      ctx.lineWidth = s * 0.018;
      for (let i = 0; i < 3; i++) {
        const a = t / 900 + i * 2.1;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * s * 0.24, Math.sin(a) * s * 0.24 - s * 0.13);
        ctx.lineTo(Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3 - s * 0.13);
        ctx.stroke();
      }
    }
  } else if (type === 'nut') {
    const hurtK = p ? 1 - p.hp / p.maxHp : 0;
    ctx.fillStyle = '#a9773f';
    rr(-s * 0.24, -s * 0.32, s * 0.48, s * 0.66, s * 0.22); ctx.fill();
    ctx.fillStyle = '#c2924f';
    rr(-s * 0.19, -s * 0.28, s * 0.38, s * 0.56, s * 0.18); ctx.fill();
    ctx.strokeStyle = '#8a5f30';
    ctx.lineWidth = s * 0.016;
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.arc(0, s * 0.05 + i * s * 0.1, s * 0.16, 0.3, Math.PI - 0.3);
      ctx.stroke();
    }
    eyes(0, -s * 0.09, s);
    ctx.strokeStyle = '#6b4520';
    ctx.lineWidth = s * 0.022;
    ctx.beginPath();
    if (hurtK > 0.55) ctx.arc(0, s * 0.06, s * 0.07, Math.PI + 0.4, -0.4);
    else ctx.arc(0, s * 0.02, s * 0.07, 0.4, Math.PI - 0.4);
    ctx.stroke();
    // cracks widen as it gets chewed
    if (hurtK > 0.33) {
      ctx.strokeStyle = '#6b4520';
      ctx.lineWidth = s * 0.02;
      ctx.beginPath();
      ctx.moveTo(-s * 0.16, -s * 0.22); ctx.lineTo(-s * 0.06, -s * 0.1); ctx.lineTo(-s * 0.13, s * 0.0);
      ctx.stroke();
    }
    if (hurtK > 0.66) {
      ctx.beginPath();
      ctx.moveTo(s * 0.17, -s * 0.14); ctx.lineTo(s * 0.07, -s * 0.02); ctx.lineTo(s * 0.15, s * 0.12);
      ctx.stroke();
    }
  } else if (type === 'boom') {
    const k = p ? 1 - Math.max(0, p.fuse) / PLANTS.boom.fuse : 0;
    const pulse = 1 + Math.sin(now / (90 - k * 60)) * 0.06 * (0.3 + k);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = '#d63b46';
    circle(0, -s * 0.02, s * 0.23);
    ctx.fillStyle = '#ef5a63';
    circle(-s * 0.06, -s * 0.09, s * 0.16);
    ctx.fillStyle = '#a62630';
    circle(s * 0.08, s * 0.06, s * 0.05);
    circle(-s * 0.1, s * 0.08, s * 0.035);
    eyes(0, -s * 0.05, s * 0.95);
    ctx.fillStyle = '#4d9b3d';
    rr(-s * 0.03, -s * 0.34, s * 0.06, s * 0.12, s * 0.03); ctx.fill();
    ctx.fillStyle = k > 0.5 ? '#fff3b0' : '#ffb347';
    circle(0, -s * 0.36, s * 0.05 * (1 + Math.sin(now / 70) * 0.3));
  }
  ctx.restore();
  if (p) p.bite = 0;
}
function stem(s, col) {
  ctx.fillStyle = col || '#3d9b3d';
  rr(-s * 0.035, -s * 0.08, s * 0.07, s * 0.36, s * 0.03); ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-s * 0.15, s * 0.2, s * 0.12, s * 0.055, -0.4, 0, 7); ctx.fill();
  ctx.beginPath();
  ctx.ellipse(s * 0.15, s * 0.2, s * 0.12, s * 0.055, 0.4, 0, 7); ctx.fill();
}

// ---------------- Shambler art ----------------
function drawZombie(z, x, y, s) {
  const d = ZOMBIES[z.type];
  const sc = d.scale || 1;
  const w = s * 0.44 * sc, h = s * 0.68 * sc;
  const step = Math.sin(z.wob);
  const chew = z.eating ? Math.sin(now / 90) * 0.5 + 0.5 : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#00000022';
  ctx.beginPath(); ctx.ellipse(0, h * 0.46, w * 0.6, w * 0.22, 0, 0, 7); ctx.fill();
  ctx.rotate(step * 0.05 + (z.type === 'runner' ? 0.1 : 0));

  const skin = z.chill > 0 ? '#a9d8e0' : '#9ec6a1';
  const skinDark = z.chill > 0 ? '#7fb3c4' : '#7da683';
  const cloth = z.type === 'brute' ? '#4b3f5c' : z.type === 'runner' ? '#7a5b4b' : '#5f6b7a';

  // legs
  ctx.fillStyle = '#3f4657';
  rr(-w * 0.34, h * 0.12, w * 0.26, h * 0.34 + step * h * 0.05, w * 0.1); ctx.fill();
  rr(w * 0.08, h * 0.12, w * 0.26, h * 0.34 - step * h * 0.05, w * 0.1); ctx.fill();

  // arms reaching left along the lane, the way it's walking
  ctx.fillStyle = skinDark;
  rr(-w * 0.95, -h * 0.06, w * 0.62, h * 0.16, w * 0.08); ctx.fill();
  rr(-w * 0.88, h * 0.12, w * 0.58, h * 0.15, w * 0.07); ctx.fill();

  // torso
  ctx.fillStyle = cloth;
  rr(-w * 0.4, -h * 0.14, w * 0.8, h * 0.42, w * 0.16); ctx.fill();
  ctx.fillStyle = '#00000022';
  rr(-w * 0.4, h * 0.12, w * 0.8, h * 0.16, w * 0.08); ctx.fill();
  // tatters
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(-w * 0.16, h * 0.26); ctx.lineTo(-w * 0.04, h * 0.14); ctx.lineTo(w * 0.06, h * 0.27);
  ctx.closePath(); ctx.fill();

  // head
  ctx.save();
  ctx.translate(0, -h * 0.34 + chew * h * 0.05);
  ctx.fillStyle = skin;
  circle(0, 0, w * 0.34);
  ctx.fillStyle = skinDark;
  circle(w * 0.14, w * 0.1, w * 0.16);
  // hair tuft
  ctx.fillStyle = '#3c3348';
  ctx.beginPath();
  ctx.arc(0, -w * 0.06, w * 0.34, Math.PI * 1.08, Math.PI * 1.92);
  ctx.fill();
  ctx.fillStyle = '#fff';
  circle(-w * 0.13, -w * 0.02, w * 0.1);
  circle(w * 0.12, -w * 0.02, w * 0.1);
  ctx.fillStyle = '#a52c3a';
  circle(-w * 0.13, w * 0.01, w * 0.05);
  circle(w * 0.12, w * 0.01, w * 0.05);
  // mouth
  ctx.fillStyle = '#3a2430';
  rr(-w * 0.14, w * 0.14, w * 0.28, w * (0.07 + chew * 0.12), w * 0.04); ctx.fill();
  if (z.type === 'runner') {
    ctx.fillStyle = '#ff8c42';
    rr(-w * 0.36, -w * 0.12, w * 0.72, w * 0.12, w * 0.05); ctx.fill();
  }
  ctx.restore();

  // shield plate, cracking as it takes hits
  if (z.type === 'shield') {
    const k = z.armor / ZOMBIES.shield.armor;
    if (k > 0) {
      ctx.fillStyle = '#8a929e';
      rr(-w * 0.46, h * 0.06, w * 0.92, h * 0.34, w * 0.09); ctx.fill();
      ctx.fillStyle = '#a7b0bc';
      rr(-w * 0.4, h * 0.1, w * 0.8, h * 0.13, w * 0.06); ctx.fill();
      ctx.strokeStyle = '#5c636e';
      ctx.lineWidth = w * 0.05;
      if (k < 0.66) {
        ctx.beginPath();
        ctx.moveTo(-w * 0.2, h * 0.06); ctx.lineTo(-w * 0.05, h * 0.22); ctx.lineTo(-w * 0.18, h * 0.4);
        ctx.stroke();
      }
      if (k < 0.33) {
        ctx.beginPath();
        ctx.moveTo(w * 0.28, h * 0.06); ctx.lineTo(w * 0.12, h * 0.24); ctx.lineTo(w * 0.3, h * 0.4);
        ctx.stroke();
      }
    }
  }
  if (z.type === 'brute') {
    ctx.fillStyle = '#2f2740';
    rr(-w * 0.5, -h * 0.18, w * 1.0, h * 0.12, w * 0.06); ctx.fill();
  }

  if (z.flash > 0) {
    ctx.globalAlpha = Math.min(0.3, z.flash / 90 * 0.3);
    ctx.fillStyle = '#fff';
    rr(-w * 0.55, -h * 0.62, w * 1.1, h * 1.1, w * 0.2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // health bar once it has actually been hurt
  const maxTotal = d.hp + d.armor;
  const cur = Math.max(0, z.hp) + Math.max(0, z.armor);
  if (cur < maxTotal) {
    const bw = s * 0.44, bh = Math.max(2, s * 0.035);
    const bx = x - bw / 2, by = y - h * 0.62 - bh * 2.2;
    ctx.fillStyle = '#00000055';
    rr(bx, by, bw, bh, bh / 2); ctx.fill();
    ctx.fillStyle = z.armor > 0 ? '#b9c4d2' : '#e05a5a';
    rr(bx, by, bw * (cur / maxTotal), bh, bh / 2); ctx.fill();
  }
}

// ---------------- Frame ----------------
function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { w, h, cell, ox, oy, gw, gh } = G;

  // sky / background
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#a8d8f0');
  sky.addColorStop(0.35, '#cfe9c9');
  sky.addColorStop(1, '#9fd08b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  drawSpawnStrip();
  drawLawn();

  // plants
  for (let r = 0; r < DEPTH; r++) {
    for (let c = 0; c < LANES; c++) {
      const p = grid[r * LANES + c];
      if (p) drawPlant(p.type, cellX(r), cellY(c), cell, p);
    }
  }

  // ghost of the plant being placed
  if (selected && selected !== 'shovel' && hoverCell) {
    const [hc, hr] = hoverCell;
    if (!grid[hr * LANES + hc]) {
      ctx.globalAlpha = 0.45;
      drawPlant(selected, cellX(hr), cellY(hc), cell, null);
      ctx.globalAlpha = 1;
    }
  }

  // peas
  // peas need a dark rim — a plain green dot vanishes against the lawn
  for (const q of peas) {
    const x = dx(q.row), y = cellY(q.lane);
    ctx.fillStyle = q.frost ? '#2b5a72' : '#2f6b25';
    circle(x, y, cell * 0.105);
    ctx.fillStyle = q.frost ? '#cdeeff' : '#a7ee6a';
    circle(x, y, cell * 0.08);
    ctx.fillStyle = '#ffffffcc';
    circle(x - cell * 0.025, y - cell * 0.03, cell * 0.028);
  }

  // shamblers, back to front so nearer ones overlap
  const order = zombies.slice().sort((a, b) => a.row - b.row);
  for (const z of order) drawZombie(z, dx(z.row + 0.5), cellY(z.lane), cell);

  drawMowers();

  // Suns go over the plants, not under them. Drawn behind, one that came to rest on a
  // Sunbloom was half-hidden by the petals it matches in colour — which is most of why
  // they were easy to miss.
  for (const s of suns) drawSun(s);

  // blasts
  for (const b of blasts) {
    const k = b.t / 520;
    ctx.globalAlpha = 1 - k;
    const rad = cell * (0.5 + k * 1.5);
    const g = ctx.createRadialGradient(cellX(b.r), cellY(b.c), rad * 0.2, cellX(b.r), cellY(b.c), rad);
    g.addColorStop(0, '#fff6c9');
    g.addColorStop(0.5, '#ff9d3c');
    g.addColorStop(1, '#ff5a2e00');
    ctx.fillStyle = g;
    circle(cellX(b.r), cellY(b.c), rad);
    ctx.globalAlpha = 1;
  }

  drawTray();

  // popups
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of popups) {
    if (!p.txt) continue;
    const k = p.t / 900;
    ctx.globalAlpha = 1 - k * k;
    ctx.fillStyle = p.col;
    ctx.font = `800 ${(p.big ? cell * 0.34 : cell * 0.2)}px 'Segoe UI', sans-serif`;
    ctx.strokeStyle = '#0007';
    ctx.lineWidth = 4;
    const px = p.px, py = p.py - k * cell * 0.6;
    ctx.strokeText(p.txt, px, py);
    ctx.fillText(p.txt, px, py);
  }
  ctx.globalAlpha = 1;

  if (banner) {
    const k = banner.t / BANNER_MS;
    ctx.globalAlpha = k < 0.15 ? k / 0.15 : (k > 0.75 ? (1 - k) / 0.25 : 1);
    ctx.fillStyle = '#00000055';
    ctx.fillRect(ox, oy + gh * 0.32, gw, cell * 1.5);
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${cell * 0.42}px 'Segoe UI', sans-serif`;
    ctx.fillText(banner.txt, ox + gw / 2, oy + gh * 0.32 + cell * 0.55);
    if (banner.sub) {
      ctx.font = `600 ${cell * 0.2}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = '#ffffffcc';
      ctx.fillText(banner.sub, ox + gw / 2, oy + gh * 0.32 + cell * 1.05);
    }
    ctx.globalAlpha = 1;
  }

  // Landscape is requested on load, but a browser can refuse it (the lock needs
  // fullscreen). Say so rather than leaving a squashed lawn unexplained.
  if (h > w) {
    const bh = cell * 0.5;
    ctx.fillStyle = '#00000066';
    ctx.fillRect(0, oy + gh + cell * 0.7, w, bh);
    ctx.fillStyle = '#ffffffdd';
    ctx.font = `700 ${Math.min(cell * 0.24, 15)}px 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↻ Turn sideways for the full lawn', w / 2, oy + gh + cell * 0.7 + bh / 2);
  }

  // First-run hint, over the lawn rather than over the mowers, and gone the moment the
  // first seed goes in the ground.
  if (level === 1 && waveIdx < 0 && !selected && !grid.some(Boolean)) {
    ctx.fillStyle = '#f4fff0dd';
    ctx.strokeStyle = '#2f4a2f88';
    ctx.lineWidth = 3;
    ctx.font = `700 ${cell * 0.21}px 'Segoe UI', sans-serif`;
    const y0 = oy + gh * 0.66;
    for (const [i, line] of ['Tap a seed packet, then tap the lawn', 'Tap suns to collect them'].entries()) {
      ctx.strokeText(line, ox + gw / 2, y0 + i * cell * 0.34);
      ctx.fillText(line, ox + gw / 2, y0 + i * cell * 0.34);
    }
  }
}

// The path the shamblers come in along — a column down the right-hand side, spanning the
// lanes rather than the canvas height.
function drawSpawnStrip() {
  const { cell, oy, gh } = G;
  const x = dx(0);
  const y = oy - cell * 0.06, h = gh + cell * 0.12;
  ctx.fillStyle = '#8b8474';
  ctx.fillRect(x, y, cell, h);
  ctx.fillStyle = '#9a9382';
  ctx.fillRect(x + cell * 0.88, y, cell * 0.12, h);
  ctx.strokeStyle = '#7a746688';
  ctx.lineWidth = 1;
  for (let l = 1; l < LANES; l++) {
    ctx.beginPath();
    ctx.moveTo(x, ly(l));
    ctx.lineTo(x + cell * 0.86, ly(l));
    ctx.stroke();
  }
}

function drawLawn() {
  const { cell, ox, oy, gw, gh } = G;
  for (let d = 0; d < DEPTH; d++) {
    for (let l = 0; l < LANES; l++) {
      ctx.fillStyle = (d + l) % 2 ? '#67ad4f' : '#74bb59';
      ctx.fillRect(dx(d + 1), ly(l), cell + 0.5, cell + 0.5);
    }
  }
  // mow stripes run along the lanes now, so they read as the direction of travel
  ctx.fillStyle = '#ffffff10';
  for (let l = 0; l < LANES; l += 2) ctx.fillRect(ox, ly(l), gw, cell);
  ctx.strokeStyle = '#00000018';
  ctx.lineWidth = 1;
  for (let d = 0; d <= DEPTH; d++) {
    ctx.beginPath(); ctx.moveTo(dx(d), oy); ctx.lineTo(dx(d), oy + gh); ctx.stroke();
  }
  for (let l = 0; l <= LANES; l++) {
    ctx.beginPath(); ctx.moveTo(ox, ly(l)); ctx.lineTo(ox + gw, ly(l)); ctx.stroke();
  }
  // the house edge the mowers defend, now the left-hand wall
  ctx.fillStyle = '#c9a27a';
  ctx.fillRect(ox - cell * 0.62, oy - cell * 0.06, cell * 0.62, gh + cell * 0.12);
  ctx.fillStyle = '#b18a63';
  ctx.fillRect(ox - cell * 0.1, oy - cell * 0.06, cell * 0.1, gh + cell * 0.12);
}

function drawMowers() {
  const { cell } = G;
  for (let c = 0; c < LANES; c++) {
    const m = mowers[c];
    if (!m) continue;
    const x = dx(m.row), y = cellY(c);
    const s = cell * 0.72;
    ctx.save();
    ctx.translate(x, y);
    // side-on: wheels underneath, blade housing out front (to the right, the way it runs)
    ctx.fillStyle = '#00000022';
    ctx.beginPath(); ctx.ellipse(0, s * 0.3, s * 0.36, s * 0.09, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#3f4657';
    circle(-s * 0.2, s * 0.2, s * 0.13);
    circle(s * 0.18, s * 0.2, s * 0.11);
    ctx.fillStyle = '#d1443f';
    rr(-s * 0.32, -s * 0.14, s * 0.6, s * 0.34, s * 0.1); ctx.fill();
    ctx.fillStyle = '#ec6a5c';
    rr(-s * 0.26, -s * 0.1, s * 0.34, s * 0.11, s * 0.05); ctx.fill();
    // handle swept back over the body
    ctx.strokeStyle = '#8d9099';
    ctx.lineWidth = s * 0.07;
    ctx.beginPath();
    ctx.moveTo(-s * 0.3, -s * 0.34); ctx.lineTo(-s * 0.02, -s * 0.12);
    ctx.stroke();
    // blade housing
    ctx.fillStyle = '#8d9099';
    rr(s * 0.24, -s * 0.04, s * 0.16, s * 0.26, s * 0.05); ctx.fill();
    if (m.running) {
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = s * 0.06;
      const a = now / 40;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(s * 0.32, s * 0.09, s * 0.2, a + i * 2.1, a + i * 2.1 + 0.9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function drawSun(s) {
  const { cell, ox, oy } = G;
  const x = ox + s.gx * cell, y = oy + s.gy * cell;
  const fade = s.landed ? Math.min(1, (SUN_LIFE - s.t) / 1500) : 1;
  const rad = cell * 0.2;
  ctx.save();
  ctx.globalAlpha = Math.max(0, fade);
  ctx.translate(x, y);
  ctx.rotate(now / 1400);
  ctx.fillStyle = '#ffe066';
  for (let i = 0; i < 8; i++) {
    ctx.rotate(Math.PI / 4);
    ctx.beginPath(); ctx.ellipse(0, -rad * 1.25, rad * 0.16, rad * 0.42, 0, 0, 7); ctx.fill();
  }
  ctx.rotate(-now / 1400);
  const g = ctx.createRadialGradient(-rad * 0.3, -rad * 0.35, rad * 0.1, 0, 0, rad);
  g.addColorStop(0, '#fff6c0');
  g.addColorStop(1, '#f7b733');
  ctx.fillStyle = g;
  circle(0, 0, rad);
  // warm rim: the sun and a Sunbloom are the same yellow, so without an edge the two
  // merge whenever they overlap
  ctx.strokeStyle = '#b9700f';
  ctx.lineWidth = Math.max(1, rad * 0.11);
  ctx.beginPath(); ctx.arc(0, 0, rad * 0.96, 0, 7); ctx.stroke();
  ctx.restore();
}

function drawTray() {
  const { w, h, trayW, trayH, slots } = G;
  const vert = trayW > 0;
  ctx.fillStyle = '#ffffffd8';
  ctx.fillRect(0, 0, vert ? trayW : w, vert ? h : trayH);
  ctx.strokeStyle = '#00000018';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (vert) { ctx.moveTo(trayW, 0); ctx.lineTo(trayW, h); } else { ctx.moveTo(0, trayH); ctx.lineTo(w, trayH); }
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const sl of slots) {
    const on = selected === sl.id;
    if (sl.id === 'shovel') {
      ctx.fillStyle = on ? '#ffe3b0' : '#eef1fa';
      rr(sl.x, sl.y, sl.w, sl.h, sl.w * 0.18); ctx.fill();
      ctx.strokeStyle = on ? '#e0913a' : '#00000018';
      ctx.lineWidth = on ? 3 : 1;
      rr(sl.x, sl.y, sl.w, sl.h, sl.w * 0.18); ctx.stroke();
      drawShovel(sl.x + sl.w / 2, sl.y + sl.h * 0.46, sl.w * 0.62);
      continue;
    }
    const def = PLANTS[sl.id];
    const cd = cooldowns[sl.id] || 0;
    const ok = sun >= def.cost && cd <= 0;
    ctx.globalAlpha = ok ? 1 : 0.5;
    ctx.fillStyle = '#f4e6c8';
    rr(sl.x, sl.y, sl.w, sl.h, sl.w * 0.16); ctx.fill();
    ctx.fillStyle = '#e8d3aa';
    rr(sl.x + sl.w * 0.08, sl.y + sl.h * 0.08, sl.w * 0.84, sl.h * 0.56, sl.w * 0.1); ctx.fill();
    drawPlant(sl.id, sl.x + sl.w / 2, sl.y + sl.h * 0.36, sl.w * 0.95, null);
    ctx.fillStyle = '#5b4a2e';
    ctx.font = `700 ${Math.max(9, sl.w * 0.26)}px 'Segoe UI', sans-serif`;
    ctx.fillText(def.cost, sl.x + sl.w / 2, sl.y + sl.h * 0.82);
    ctx.globalAlpha = 1;
    if (cd > 0) {
      ctx.fillStyle = '#2b2b3d99';
      const k = cd / def.cd;
      rr(sl.x, sl.y, sl.w, sl.h * k, sl.w * 0.16); ctx.fill();
    }
    ctx.strokeStyle = on ? '#6c8cff' : '#00000018';
    ctx.lineWidth = on ? 3 : 1;
    rr(sl.x, sl.y, sl.w, sl.h, sl.w * 0.16); ctx.stroke();
  }
  // wave progress along the bottom edge of the tray
  const progress = (k, col) => {
    ctx.fillStyle = '#00000012';
    if (vert) ctx.fillRect(trayW - 3, 0, 3, h); else ctx.fillRect(0, trayH - 3, w, 3);
    ctx.fillStyle = col;
    if (vert) ctx.fillRect(trayW - 3, 0, 3, h * k); else ctx.fillRect(0, trayH - 3, w * k, 3);
  };
  if (waveIdx >= 0 && waveIdx < waves.length) {
    const wv = waves[waveIdx];
    progress(wv.spawns.length ? spawnIdx / wv.spawns.length : 1, wv.last ? '#d1443f' : '#6c8cff');
  } else if (breatherT > 0 && waveIdx < 0) {
    progress(1 - breatherT / prepMs(), '#7cc65a');
  }
}

function drawShovel(x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.3);
  ctx.fillStyle = '#8a5f30';
  rr(-s * 0.06, -s * 0.42, s * 0.12, s * 0.5, s * 0.05); ctx.fill();
  ctx.fillStyle = '#b9c2cf';
  ctx.beginPath();
  ctx.moveTo(-s * 0.22, s * 0.04);
  ctx.lineTo(s * 0.22, s * 0.04);
  ctx.lineTo(s * 0.14, s * 0.4);
  ctx.lineTo(-s * 0.14, s * 0.4);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ---------------- Input ----------------
let hoverCell = null;

function localPt(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
// x is the depth axis (running right-to-left), y is the lane axis. Returns [lane, depth]
// to match the [c, r] order the planting helpers take.
function cellAt(x, y) {
  const c = Math.floor((y - G.oy) / G.cell);
  const r = DEPTH - 1 - Math.floor((x - G.ox) / G.cell);
  if (c < 0 || c >= LANES || r < 0 || r >= DEPTH) return null;
  return [c, r];
}

canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  const [x, y] = localPt(e);

  // suns are grabbed wherever they are, even over the tray
  for (let i = suns.length - 1; i >= 0; i--) {
    const s = suns[i];
    const sx = G.ox + s.gx * G.cell, sy = G.oy + s.gy * G.cell;
    if (Math.hypot(x - sx, y - sy) < G.cell * 0.34) {
      sun += s.value;
      popup(sx, sy, '+' + s.value, '#fff3b0');
      suns.splice(i, 1);
      updateHud();
      return;
    }
  }
  if (phase !== 'play') return;

  if (G.trayW > 0 ? x < G.trayW : y < G.trayH) {
    for (const sl of G.slots) {
      if (x >= sl.x && x <= sl.x + sl.w && y >= sl.y && y <= sl.y + sl.h) {
        if (selected === sl.id) { selected = null; return; }
        if (sl.id === 'shovel' || canAfford(sl.id)) selected = sl.id;
        return;
      }
    }
    return;
  }

  const cellHit = cellAt(x, y);
  if (!cellHit) { selected = null; return; }
  const [c, r] = cellHit;
  if (selected === 'shovel') shovel(c, r);
  else if (selected) tryPlant(c, r);
  hoverCell = null;
});

canvas.addEventListener('pointermove', e => {
  if (!selected || selected === 'shovel') { hoverCell = null; return; }
  const [x, y] = localPt(e);
  hoverCell = (G.trayW > 0 ? x < G.trayW : y < G.trayH) ? null : cellAt(x, y);
});
canvas.addEventListener('pointerleave', () => { hoverCell = null; });

document.getElementById('newBtn').addEventListener('click', newGame);
document.getElementById('nextBtn').addEventListener('click', () => startLevel(true));
document.getElementById('retryBtn').addEventListener('click', () => startLevel(true));
document.getElementById('restartBtn').addEventListener('click', newGame);

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(50, t - lastT);
  lastT = t;
  if (document.hidden) return;
  update(dt);
  draw();
}

// ---------------- Boot ----------------
lockLandscape();
layout();
loadState();
startLevel(true);
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
if (window.ResizeObserver) new ResizeObserver(layout).observe(area);
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });

// Put portrait back before handing control to the menu. pagehide alone can lose the race
// with the navigation, so the back button restores first and then leaves.
const backBtn = document.querySelector('.topbar .back');
if (backBtn) {
  backBtn.onclick = async () => {
    saveState();
    await restorePortrait();
    location.href = '../index.html';
  };
}
window.addEventListener('pagehide', restorePortrait);
