/* Ricochet — aim a bouncing ball down a field of pegs and clear every orange one.
   Levels are generated from a seed (never transcribed), so level N is the same board
   every time without shipping a hand-authored level list. */
'use strict';

const STATE_KEY = 'ricochet.state.v1';
const SCORE_KEY = 'ricochet.scores.v1';

const START_BALLS = 10;
const ORANGE_TARGET = 18;      // oranges per level (fewer if the layout is small)
const GREEN_COUNT = 2;         // power pegs
const FREE_BALL_EVERY = 25000; // score threshold for a bonus ball
const SHOT_TIMEOUT = 10000;    // backstop; the decay above should end shots well before this
const FADE_MS = 260;           // cleared-peg shrink
const POPUP_MS = 850;

// Physics/layout tuning — these three interact, so they were picked by sweeping the
// grid and measuring full levels rather than by eye. The ball must be small enough
// relative to peg spacing to get *into* the field, but the field dense enough that it
// keeps bouncing once inside; too sparse and it drops straight through, too dense and
// it skitters across the top. At these values a random-aim bot clears ~14 of ~16
// oranges with the stock 10 balls, so deliberate aiming wins without it being a
// formality. Changing one means re-running the sweep.
let BALL_R_F = 0.85;    // ball radius as a fraction of peg radius
let PEG_GAP_F = 3.0;    // minimum peg centre distance, in peg radii
let PEG_E = 0.80;       // restitution off a peg

const COLORS = {
  blue:   { base: '#4dd4ff', lit: '#eaffff', glow: '#4dd4ff' },
  orange: { base: '#ff8c42', lit: '#ffe0c2', glow: '#ff8c42' },
  green:  { base: '#7cf29c', lit: '#e6ffee', glow: '#7cf29c' },
  purple: { base: '#c98cff', lit: '#f3e6ff', glow: '#c98cff' },
};
const VALUES = { blue: 10, orange: 100, green: 50, purple: 500 };

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

// ---------------- Seeded RNG (levels are reproducible from their number) ----------------
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
let balls = START_BALLS;
let pegs = [];
let shots = [];          // live balls
let bucket = null;
let phase = 'aim';       // 'aim' | 'shot' | 'won' | 'over'
let aimAng = Math.PI / 2;
let aiming = false;
let popups = [];
let sparks = [];
let shotT = 0;
let timeScale = 1;
let slowT = 0;           // slow-motion on the last orange peg
let guideShots = 0;      // shots remaining with the long guide
let bombNext = 0;        // pegs remaining that explode on contact
let nextFreeBall = FREE_BALL_EVERY;
let runRecords = new Set();
let pulse = 0;

// ---------------- Layout ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, G = null;   // {w, h, pegR, ballR, topY, botY, cannonY}

let safeProbe = null;
function safeBottom() {
  if (!safeProbe) {
    safeProbe = document.createElement('div');
    safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:var(--safe-bottom);pointer-events:none;visibility:hidden;';
    document.body.appendChild(safeProbe);
  }
  return safeProbe.getBoundingClientRect().height;
}

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const w = r.width, h = r.height;
  const floor = h - Math.max(safeBottom(), h * 0.005);
  // The playfield is a fixed aspect centred in the canvas (gutters on wide windows),
  // like Balls. Without this the peg lattice stretches with the window and a desktop
  // browser and a phone get boards with different gap-to-ball ratios.
  const pw = Math.min(w, h * 0.78);
  const pegR = Math.max(3.5, pw * 0.0175);
  G = {
    w, h, floor, pegR, pw,
    ox: (w - pw) / 2,
    ballR: pegR * BALL_R_F,
    cannonY: h * 0.055,
    topY: h * 0.2,                 // first peg row
    botY: floor - h * 0.14,        // last peg row, above the bucket
    bucketH: h * 0.055,
  };
  if (bucket) {
    bucket.w = pw * 0.17;
    bucket.x = Math.min(Math.max(bucket.x, G.ox + bucket.w / 2), G.ox + pw - bucket.w / 2);
  }
  relayout();
}

// pegs are stored in normalised (0..1) coordinates so a resize just re-projects them
function relayout() {
  if (!G) return;
  for (const p of pegs) {
    p.x = G.ox + p.nx * G.pw;
    p.y = G.topY + p.ny * (G.botY - G.topY);
    p.r = G.pegR;
  }
}

// ---------------- Level generation ----------------
// Five layout families; which one a level uses (and its parameters) come from the seed,
// so every level is reproducible without a stored level list.
function buildLevel(n) {
  const rnd = mulberry32(n * 2654435761 % 2147483647);
  const family = n % 5;
  const pts = [];
  const push = (nx, ny) => {
    if (nx > 0.045 && nx < 0.955 && ny > -0.02 && ny < 1.02) pts.push({ nx, ny: Math.min(1, Math.max(0, ny)) });
  };

  if (family === 0) {
    // offset grid
    const cols = 9 + ((rnd() * 3) | 0), rows = 7 + ((rnd() * 3) | 0);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const off = r % 2 ? 0.5 / cols : 0;
        if (rnd() < 0.12) continue;
        push(0.08 + (c / cols) * 0.84 + off, r / (rows - 1));
      }
    }
  } else if (family === 1) {
    // nested arches
    const arcs = 4 + ((rnd() * 3) | 0);
    for (let a = 0; a < arcs; a++) {
      const rad = 0.12 + a * 0.1, cnt = 8 + a * 4;
      for (let i = 0; i <= cnt; i++) {
        const t = Math.PI * (i / cnt);
        push(0.5 + Math.cos(t) * rad * 1.5, 0.72 - Math.sin(t) * rad * 1.7 + 0.18);
      }
    }
  } else if (family === 2) {
    // diamond lattice
    const size = 7 + ((rnd() * 3) | 0);
    for (let r = -size; r <= size; r++) {
      const span = size - Math.abs(r);
      for (let c = -span; c <= span; c++) {
        push(0.5 + c * 0.072, 0.5 + r * 0.062);
      }
    }
  } else if (family === 3) {
    // sine waves
    const rows = 6 + ((rnd() * 3) | 0), amp = 0.05 + rnd() * 0.05;
    for (let r = 0; r < rows; r++) {
      const ph = rnd() * Math.PI * 2, cols = 12 + ((rnd() * 4) | 0);
      for (let c = 0; c < cols; c++) {
        const t = c / (cols - 1);
        push(0.07 + t * 0.86, r / (rows - 1) + Math.sin(t * Math.PI * 3 + ph) * amp);
      }
    }
  } else {
    // pillars with gaps to funnel through
    const cols = 6 + ((rnd() * 3) | 0);
    for (let c = 0; c < cols; c++) {
      const cx = 0.1 + (c / (cols - 1)) * 0.8;
      const hgt = 0.45 + rnd() * 0.5, top = rnd() * (1 - hgt);
      const cnt = Math.max(3, Math.round(hgt / 0.055));
      for (let i = 0; i < cnt; i++) push(cx, top + (i / (cnt - 1)) * hgt);
    }
  }

  // Thin out neighbours in *pixel* space, not normalised space — the two axes have
  // different scales, so a normalised threshold leaves overlaps on one axis.
  const projX = nx => G.ox + nx * G.pw;
  const projY = ny => G.topY + ny * (G.botY - G.topY);
  const minD = G.pegR * PEG_GAP_F;
  const out = [];
  for (const p of pts) {
    const px = projX(p.nx), py = projY(p.ny);
    if (out.some(q => Math.hypot(projX(q.nx) - px, projY(q.ny) - py) < minD)) continue;
    out.push(p);
  }

  pegs = out.map(p => ({
    nx: p.nx, ny: p.ny, x: 0, y: 0, r: 0,
    kind: 'blue', hit: false, dead: false, deadT: 0, flash: 0,
  }));

  // orange targets spread across the board rather than clumped, so a level can't be
  // won by parking the ball in one corner
  const idx = pegs.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const nOrange = Math.min(ORANGE_TARGET, Math.max(6, Math.floor(pegs.length * 0.32)));
  const chosen = [];
  for (const i of idx) {
    if (chosen.length >= nOrange) break;
    const p = pegs[i];
    // keep oranges apart where possible
    if (chosen.some(c => Math.hypot(c.nx - p.nx, c.ny - p.ny) < 0.075) && chosen.length < nOrange * 0.8) continue;
    p.kind = 'orange';
    chosen.push(p);
  }
  for (const i of idx) {          // top up if the spacing rule was too strict
    if (chosen.length >= nOrange) break;
    if (pegs[i].kind === 'blue') { pegs[i].kind = 'orange'; chosen.push(pegs[i]); }
  }
  let greens = 0;
  for (const i of idx) {
    if (greens >= GREEN_COUNT) break;
    if (pegs[i].kind === 'blue') { pegs[i].kind = 'green'; greens++; }
  }
  relayout();
  rollPurple();
}

// one blue peg per shot is worth a bonus, re-rolled each time
function rollPurple() {
  for (const p of pegs) if (p.kind === 'purple') p.kind = 'blue';
  const cands = pegs.filter(p => !p.dead && p.kind === 'blue');
  if (cands.length) cands[(Math.random() * cands.length) | 0].kind = 'purple';
}

const orangeLeft = () => pegs.filter(p => p.kind === 'orange' && !p.dead && !p.hit).length;
const orangeCleared = () => pegs.filter(p => p.kind === 'orange' && (p.dead || p.hit)).length;
// the multiplier climbs as the board empties, like the original's ramp
function multiplier() {
  const c = orangeCleared();
  return c >= 22 ? 10 : c >= 18 ? 5 : c >= 12 ? 3 : c >= 6 ? 2 : 1;
}

// ---------------- Persistence ----------------
function saveState() {
  if (phase === 'over') return;
  localStorage.setItem(STATE_KEY, JSON.stringify({
    level, score, balls, nextFreeBall,
    cleared: pegs.map((p, i) => (p.dead ? i : -1)).filter(i => i >= 0),
    guideShots, bombNext,
    records: [...runRecords],
  }));
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (!s || !(s.level >= 1) || !(s.balls >= 0) || !(s.score >= 0) || !Array.isArray(s.cleared)) return false;
    level = s.level;
    score = s.score;
    balls = s.balls;
    nextFreeBall = s.nextFreeBall || FREE_BALL_EVERY;
    guideShots = s.guideShots || 0;
    bombNext = s.bombNext || 0;
    runRecords = new Set(s.records || []);
    buildLevel(level);
    for (const i of s.cleared) if (pegs[i]) { pegs[i].dead = true; pegs[i].deadT = FADE_MS; }
    rollPurple();
    // a finished or unwinnable snapshot is not worth restoring
    if (orangeLeft() === 0 || balls <= 0) return false;
    return true;
  } catch { }
  return false;
}

// ---------------- Setup ----------------
function newGame() {
  level = 1;
  score = 0;
  balls = START_BALLS;
  nextFreeBall = FREE_BALL_EVERY;
  guideShots = 0;
  bombNext = 0;
  runRecords = new Set();
  startLevel();
}

function startLevel() {
  buildLevel(level);
  shots = [];
  popups = [];
  sparks = [];
  phase = 'aim';
  timeScale = 1;
  slowT = 0;
  bucket = { x: G.ox + G.pw * 0.5, vx: G.pw * 0.22, w: G.pw * 0.17 };
  hideOverlays();
  updateHud();
  saveState();
}

function retryLevel() {
  balls = START_BALLS;
  guideShots = 0;
  bombNext = 0;
  startLevel();
}

function hideOverlays() {
  document.getElementById('winOverlay').classList.remove('active');
  document.getElementById('overOverlay').classList.remove('active');
}

function updateHud() {
  document.getElementById('hudLevel').textContent = level;
  document.getElementById('hudScore').textContent = score;
  document.getElementById('hudOrange').textContent = orangeLeft();
  document.getElementById('hudBalls').textContent = balls;
}

document.getElementById('newBtn').onclick = () => newGame();
document.getElementById('nextBtn').onclick = () => { level++; startLevel(); };
document.getElementById('retryBtn').onclick = () => retryLevel();
document.getElementById('restartBtn').onclick = () => newGame();

// ---------------- Physics ----------------
const GRAV = () => G.h * 1.15;
// (PEG_E, BALL_R_F and PEG_GAP_F are declared with the tuning block at the top)
const WALL_E = 0.86;
const SHOT_SPEED = () => G.h * 0.62;

function fire() {
  if (phase !== 'aim' || balls <= 0) return;
  balls--;
  shots = [{
    x: G.w / 2, y: G.cannonY + G.ballR * 1.4,
    vx: Math.cos(aimAng) * SHOT_SPEED(), vy: Math.sin(aimAng) * SHOT_SPEED(),
    r: G.ballR, slow: 0,
  }];
  phase = 'shot';
  shotT = 0;
  updateHud();
}

// A shot that has run long gets progressively heavier and loses sideways energy, so it
// always drains instead of pinballing forever. Normal shots finish in ~3s and never see
// this; without it roughly 2% of shots ran into the timeout and stalled the game.
function shotDecay() {
  return Math.min(1, Math.max(0, (shotT - 3500) / 5000));
}

function stepBall(b, dt) {
  const decay = shotDecay();
  b.vy += GRAV() * (1 + decay * 2.5) * dt;
  if (decay > 0) {
    const k = Math.max(0, 1 - 1.6 * decay * dt);
    b.vx *= k;
  }
  const dist = Math.hypot(b.vx, b.vy) * dt;
  const n = Math.max(1, Math.ceil(dist / (b.r * 0.5)));
  const sdt = dt / n;
  const left = G.ox, right = G.ox + G.pw;
  for (let i = 0; i < n; i++) {
    b.x += b.vx * sdt;
    b.y += b.vy * sdt;
    if (b.x < left + b.r) { b.x = left + b.r; b.vx = Math.abs(b.vx) * WALL_E; }
    else if (b.x > right - b.r) { b.x = right - b.r; b.vx = -Math.abs(b.vx) * WALL_E; }
    if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * WALL_E; }

    for (const p of pegs) {
      if (p.dead) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      const rr = b.r + p.r;
      if (dx * dx + dy * dy >= rr * rr) continue;
      const d = Math.hypot(dx, dy) || 0.0001;
      const nx = dx / d, ny = dy / d;
      b.x = p.x + nx * rr;
      b.y = p.y + ny * rr;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= (1 + PEG_E) * vn * nx;
        b.vy -= (1 + PEG_E) * vn * ny;
      }
      hitPeg(p);
    }
  }
}

function hitPeg(p) {
  if (p.flash > 0.35) return;    // don't re-score the same peg on consecutive substeps
  p.flash = 1;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2, s = G.h * (0.05 + Math.random() * 0.12);
    sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, life: 320, col: COLORS[p.kind].base, size: p.r * 0.22 });
  }
  if (p.hit) return;             // already banked this shot
  p.hit = true;

  const m = multiplier();
  const gained = VALUES[p.kind] * m;
  score += gained;
  popups.push({ x: p.x, y: p.y, txt: '+' + gained, col: COLORS[p.kind].base, t: 0 });

  if (p.kind === 'orange' && orangeLeft() === 0) {
    slowT = 1400;                // the last orange drops into slow motion
    popups.push({ x: G.w / 2, y: G.h * 0.42, txt: 'BOARD CLEAR!', col: '#ff8c42', t: 0, big: true });
  }
  if (p.kind === 'green') grantPower();
  if (bombNext > 0) { bombNext--; detonate(p); }

  while (score >= nextFreeBall) {
    nextFreeBall += FREE_BALL_EVERY;
    balls++;
    popups.push({ x: G.w / 2, y: G.h * 0.3, txt: 'FREE BALL!', col: '#7cf29c', t: 0, big: true });
  }
  updateHud();
  if (navigator.vibrate) navigator.vibrate(8);
}

// green pegs grant one of three powers
function grantPower() {
  const roll = Math.random();
  if (roll < 0.34) {
    guideShots = 3;
    popups.push({ x: G.w / 2, y: G.h * 0.36, txt: 'LONG GUIDE', col: '#7cf29c', t: 0, big: true });
  } else if (roll < 0.67) {
    bombNext = 5;
    popups.push({ x: G.w / 2, y: G.h * 0.36, txt: 'BLASTER', col: '#7cf29c', t: 0, big: true });
  } else {
    // multiball: two extra balls fan out from the peg that granted it
    const src = shots[0];
    if (src) {
      for (const sgn of [-1, 1]) {
        const sp = Math.hypot(src.vx, src.vy) || SHOT_SPEED();
        const a = Math.atan2(src.vy, src.vx) + sgn * 0.5;
        shots.push({ x: src.x, y: src.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: G.ballR, slow: 0 });
      }
    }
    popups.push({ x: G.w / 2, y: G.h * 0.36, txt: 'MULTIBALL', col: '#7cf29c', t: 0, big: true });
  }
}

// blaster: clear everything close to the struck peg
function detonate(p) {
  const rad = G.pegR * 5;
  for (const q of pegs) {
    if (q.dead || q === p) continue;
    if (Math.hypot(q.x - p.x, q.y - p.y) > rad) continue;
    if (!q.hit) {
      q.hit = true;
      const gained = VALUES[q.kind] * multiplier();
      score += gained;
      popups.push({ x: q.x, y: q.y, txt: '+' + gained, col: COLORS[q.kind].base, t: 0 });
    }
    q.flash = 1;
  }
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, s = G.h * (0.1 + Math.random() * 0.25);
    sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, life: 460, col: '#ffd166', size: p.r * 0.3 });
  }
  updateHud();
}

// ---------------- Shot resolution ----------------
function endShot(caught) {
  for (const p of pegs) {
    if (p.hit && !p.dead) { p.dead = true; p.deadT = 0; }
    p.hit = false;
  }
  if (caught) {
    balls++;
    popups.push({ x: bucket.x, y: G.floor - G.bucketH, txt: 'FREE BALL!', col: '#7cf29c', t: 0, big: true });
  }
  if (guideShots > 0) guideShots--;
  rollPurple();
  updateHud();

  if (orangeLeft() === 0) {
    phase = 'won';
    // leftover balls are worth something, so finishing early still pays
    const bonus = balls * 1000;
    score += bonus;
    document.getElementById('winNote').textContent = `${balls} balls left · +${bonus} bonus`;
    document.getElementById('winScore').textContent = score;
    document.getElementById('winBests').innerHTML = bestsRow();
    for (const rec of reportScore(score)) runRecords.add(rec);
    saveState();
    setTimeout(() => document.getElementById('winOverlay').classList.add('active'), 650);
    return;
  }
  if (balls <= 0) {
    phase = 'over';
    for (const rec of reportScore(score)) runRecords.add(rec);
    localStorage.removeItem(STATE_KEY);
    document.getElementById('overNote').textContent = `${orangeLeft()} orange pegs left on level ${level}`;
    document.getElementById('finalScore').textContent = score;
    document.getElementById('recordNote').textContent =
      runRecords.size ? `🏆 New ${[...runRecords].join(', ')} record!` : '';
    document.getElementById('finalBests').innerHTML = bestsRow();
    if (navigator.vibrate) navigator.vibrate([40, 40, 60]);
    setTimeout(() => document.getElementById('overOverlay').classList.add('active'), 500);
    return;
  }
  phase = 'aim';
  saveState();
}

// ---------------- Update ----------------
function update(dtms) {
  pulse += dtms;
  // slow motion for the last orange peg
  if (slowT > 0) { slowT -= dtms; timeScale += (0.32 - timeScale) * 0.12; }
  else timeScale += (1 - timeScale) * 0.08;
  const dtms2 = dtms * timeScale;
  const dt = dtms2 / 1000;

  for (const p of pegs) {
    if (p.flash > 0) p.flash = Math.max(0, p.flash - dtms2 / 260);
    if (p.dead && p.deadT < FADE_MS) p.deadT += dtms2;
  }
  for (const s of sparks) { s.t += dtms2; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += G.h * 0.9 * dt; }
  sparks = sparks.filter(s => s.t < s.life);
  for (const p of popups) p.t += dtms2;
  popups = popups.filter(p => p.t < POPUP_MS);

  // the bucket slides even while aiming, so catching it is a timing decision
  if (bucket) {
    bucket.x += bucket.vx * dt;
    const half = bucket.w / 2;
    if (bucket.x < G.ox + half) { bucket.x = G.ox + half; bucket.vx = Math.abs(bucket.vx); }
    if (bucket.x > G.ox + G.pw - half) { bucket.x = G.ox + G.pw - half; bucket.vx = -Math.abs(bucket.vx); }
  }

  if (phase !== 'shot') return;
  shotT += dtms;

  let caught = false;
  for (const b of shots) {
    stepBall(b, dt);
    // A ball wedged between two pegs would otherwise jitter until the shot timeout.
    // Once it has been crawling for a while, nudge it loose downhill.
    if (Math.hypot(b.vx, b.vy) < G.h * 0.11) {
      b.slow += dtms2;
      b.slowTotal = (b.slowTotal || 0) + dtms2;
      if (b.slow > 350) {
        b.slow = 0;
        b.vx += (Math.random() - 0.5) * G.h * 0.18;
        b.vy = Math.abs(b.vy) + G.h * 0.22;
      }
      // genuinely wedged between two pegs: the push-out just re-wedges it, so retire
      // the ball rather than make the player watch it sit there
      if (b.slowTotal > 2000) b.gone = true;
    } else b.slow = 0;
    const bTop = G.floor - G.bucketH;
    if (b.y + b.r >= bTop && b.vy > 0 && Math.abs(b.x - bucket.x) < bucket.w / 2) {
      caught = true;
      b.gone = true;
    } else if (b.y - b.r > G.floor) {
      b.gone = true;
    }
  }
  shots = shots.filter(b => !b.gone);

  // a ball that never drains (wedged between pegs) shouldn't hang the game
  if (shots.length && shotT > SHOT_TIMEOUT) shots = [];
  if (shots.length === 0) endShot(caught);
}

// ---------------- Aim preview ----------------
// Runs the same integrator on a ghost ball. Normally it stops at the first peg;
// the LONG GUIDE power lets it keep going for a few bounces.
function previewPath() {
  const pts = [];
  const b = {
    x: G.w / 2, y: G.cannonY + G.ballR * 1.4,
    vx: Math.cos(aimAng) * SHOT_SPEED(), vy: Math.sin(aimAng) * SHOT_SPEED(), r: G.ballR,
  };
  let bounces = 0;
  const maxBounces = guideShots > 0 ? 4 : 0;
  const dt = 1 / 240;
  for (let i = 0; i < 2600; i++) {
    b.vy += GRAV() * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < G.ox + b.r) { b.x = G.ox + b.r; b.vx = Math.abs(b.vx) * WALL_E; }
    else if (b.x > G.ox + G.pw - b.r) { b.x = G.ox + G.pw - b.r; b.vx = -Math.abs(b.vx) * WALL_E; }
    if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * WALL_E; }
    if (i % 3 === 0) pts.push({ x: b.x, y: b.y });
    if (b.y - b.r > G.floor) break;

    let hit = null;
    for (const p of pegs) {
      if (p.dead) continue;
      const dx = b.x - p.x, dy = b.y - p.y, rr = b.r + p.r;
      if (dx * dx + dy * dy < rr * rr) { hit = p; break; }
    }
    if (!hit) continue;
    if (bounces >= maxBounces) { pts.push({ x: b.x, y: b.y, end: true }); break; }
    bounces++;
    const dx = b.x - hit.x, dy = b.y - hit.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    const nx = dx / d, ny = dy / d, rr = b.r + hit.r;
    b.x = hit.x + nx * rr;
    b.y = hit.y + ny * rr;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) { b.vx -= (1 + PEG_E) * vn * nx; b.vy -= (1 + PEG_E) * vn * ny; }
  }
  return pts;
}

// ---------------- Drawing ----------------
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawPeg(p) {
  if (p.dead) {
    const k = 1 - Math.min(1, p.deadT / FADE_MS);
    if (k <= 0) return;
    ctx.globalAlpha = k;
    ctx.fillStyle = COLORS[p.kind].lit;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + (1 - k) * 1.4), 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  const c = COLORS[p.kind];
  if (p.flash > 0 || p.hit) {
    ctx.fillStyle = c.glow + '55';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.9 + p.flash * 0.8), 0, 7); ctx.fill();
  }
  const g = ctx.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.4, p.r * 0.1, p.x, p.y, p.r);
  const top = p.hit ? c.lit : c.base;
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, top);
  g.addColorStop(1, p.hit ? c.base : shade(c.base));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
  if (p.kind === 'green') {
    ctx.fillStyle = '#1c5c33';
    ctx.font = `700 ${p.r * 1.1}px 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('★', p.x, p.y + p.r * 0.08);
  }
}
function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * 0.55), g2 = Math.round(((n >> 8) & 255) * 0.55), b = Math.round((n & 255) * 0.55);
  return `rgb(${r},${g2},${b})`;
}

function drawCannon() {
  const cx = G.w / 2, cy = G.cannonY;
  const len = G.h * 0.045, wdt = G.h * 0.028;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(aimAng - Math.PI / 2);
  ctx.fillStyle = '#5c6480';
  roundRect(ctx, -wdt / 2, 0, wdt, len, wdt * 0.3);
  ctx.fill();
  ctx.fillStyle = '#8b90a8';
  roundRect(ctx, -wdt * 0.25, len * 0.2, wdt * 0.5, len * 0.7, wdt * 0.15);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#3b3355';
  ctx.beginPath(); ctx.arc(cx, cy, G.h * 0.022, 0, 7); ctx.fill();
  ctx.fillStyle = balls > 0 ? '#ffd166' : '#8b90a8';
  ctx.beginPath(); ctx.arc(cx, cy, G.h * 0.013, 0, 7); ctx.fill();
}

function drawBucket() {
  const bx = bucket.x, top = G.floor - G.bucketH, w = bucket.w, h = G.bucketH;
  ctx.fillStyle = '#3b3355';
  roundRect(ctx, bx - w / 2, top, w, h, h * 0.22);
  ctx.fill();
  const g = ctx.createLinearGradient(0, top, 0, top + h);
  g.addColorStop(0, '#7cf29c');
  g.addColorStop(1, '#2f9e5c');
  ctx.fillStyle = g;
  roundRect(ctx, bx - w / 2 + w * 0.06, top + h * 0.16, w * 0.88, h * 0.7, h * 0.2);
  ctx.fill();
  ctx.fillStyle = '#ffffff33';
  roundRect(ctx, bx - w / 2 + w * 0.06, top + h * 0.16, w * 0.88, h * 0.22, h * 0.16);
  ctx.fill();
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, G.h);
  g.addColorStop(0, '#1b2140');
  g.addColorStop(0.6, '#2b2a63');
  g.addColorStop(1, '#3b2f5e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, G.w, G.h);
  if (G.ox > 0) {
    ctx.fillStyle = '#12162e';
    ctx.fillRect(0, 0, G.ox, G.h);
    ctx.fillRect(G.ox + G.pw, 0, G.w - G.ox - G.pw, G.h);
    ctx.fillStyle = '#ffffff14';
    ctx.fillRect(G.ox - 2, 0, 2, G.h);
    ctx.fillRect(G.ox + G.pw, 0, 2, G.h);
  }

  // aim preview
  if (phase === 'aim' && balls > 0) {
    const pts = previewPath();
    ctx.fillStyle = guideShots > 0 ? '#7cf29ccc' : '#ffffffaa';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const r = p.end ? G.ballR * 0.7 : Math.max(1.4, G.ballR * 0.22);
      ctx.globalAlpha = p.end ? 0.9 : Math.max(0.15, 1 - i / pts.length);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (const p of pegs) drawPeg(p);
  drawBucket();
  drawCannon();

  // balls in flight
  // steel ball — dark rim and a hard highlight so it never reads as a lit peg
  for (const b of shots) {
    ctx.fillStyle = '#ffd16633';
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 2.1, 0, 7); ctx.fill();
    const bg = ctx.createRadialGradient(b.x - b.r * 0.45, b.y - b.r * 0.5, b.r * 0.05, b.x, b.y, b.r * 1.1);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(0.5, '#dfe6f5');
    bg.addColorStop(1, '#8b95b5');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
    ctx.strokeStyle = '#1b2140';
    ctx.lineWidth = Math.max(1, b.r * 0.22);
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.stroke();
    ctx.fillStyle = '#ffffffcc';
    ctx.beginPath(); ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.38, b.r * 0.26, 0, 7); ctx.fill();
  }

  for (const s of sparks) {
    const k = s.t / s.life;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = s.col;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.size * (1 - k * 0.4), 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // multiplier + active powers
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff66';
  ctx.font = `800 ${G.h * 0.03}px 'Segoe UI', sans-serif`;
  ctx.fillText('×' + multiplier(), G.w * 0.03, G.h * 0.035);
  if (guideShots > 0 || bombNext > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#7cf29ccc';
    ctx.font = `700 ${G.h * 0.022}px 'Segoe UI', sans-serif`;
    ctx.fillText(guideShots > 0 ? `GUIDE ×${guideShots}` : `BLASTER ×${bombNext}`, G.w * 0.97, G.h * 0.035);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of popups) {
    const k = p.t / POPUP_MS;
    ctx.globalAlpha = 1 - k * k;
    ctx.fillStyle = p.col;
    ctx.font = `800 ${p.big ? G.h * 0.045 : G.h * 0.024}px 'Segoe UI', sans-serif`;
    ctx.strokeStyle = '#0008';
    ctx.lineWidth = 4;
    ctx.strokeText(p.txt, p.x, p.y - k * G.h * 0.05);
    ctx.fillText(p.txt, p.x, p.y - k * G.h * 0.05);
  }
  ctx.globalAlpha = 1;

  if (phase === 'aim' && level === 1 && balls === START_BALLS) {
    ctx.fillStyle = '#ffffff88';
    ctx.font = `600 ${G.h * 0.022}px 'Segoe UI', sans-serif`;
    ctx.fillText('Drag to aim, release to fire', G.w / 2, G.h * 0.13);
    ctx.fillText('Clear every orange peg', G.w / 2, G.h * 0.13 + G.h * 0.032);
  }
}

// ---------------- Input ----------------
function aimAt(cx, cy) {
  const dx = cx - G.w / 2, dy = cy - G.cannonY;
  let a = Math.atan2(dy, dx);
  // keep the barrel pointing into the field rather than back up at the ceiling
  const lim = 0.16;
  if (a < lim && a > -Math.PI / 2) a = lim;
  if (a > Math.PI - lim || a < -Math.PI / 2) a = Math.PI - lim;
  aimAng = a;
}
function localPt(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (phase !== 'aim') return;
  aiming = true;
  canvas.setPointerCapture?.(e.pointerId);
  aimAt(...localPt(e));
});
canvas.addEventListener('pointermove', e => {
  if (!aiming) return;
  aimAt(...localPt(e));
});
canvas.addEventListener('pointerup', e => {
  if (!aiming) return;
  aiming = false;
  aimAt(...localPt(e));
  fire();
});
canvas.addEventListener('pointercancel', () => { aiming = false; });

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
layout();
if (loadState()) {
  shots = [];
  phase = 'aim';
  bucket = { x: G.ox + G.pw * 0.5, vx: G.pw * 0.22, w: G.pw * 0.17 };
  hideOverlays();
  updateHud();
} else {
  newGame();
}
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
if (window.ResizeObserver) new ResizeObserver(layout).observe(area);
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });
