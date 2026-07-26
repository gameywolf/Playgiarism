/* Jet Rush — endless jetpack runner. Hold anywhere to thrust, release to drop.
   Dodge zappers, laser gates and missiles; grab coins. Score is distance flown. */
'use strict';

const SCORE_KEY = 'jetrush.scores.v1';
const COIN_KEY = 'jetrush.coins.v1';   // lifetime coin tally (no store; just a keepsake)

// Timings (ms)
const LASER_WARN = 900;
const LASER_FIRE = 700;
const MISSILE_WARN = 1000;
const DEATH_MS = 1200;
const POPUP_MS = 700;

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
function reportScore(score) {
  const s = loadScores();
  const records = [];
  if (score > s.daily.score) { s.daily.score = score; records.push('daily'); }
  if (score > s.weekly.score) { s.weekly.score = score; records.push('weekly'); }
  if (score > s.allTime) { s.allTime = score; records.push('all-time'); }
  localStorage.setItem(SCORE_KEY, JSON.stringify(s));
  return records;
}
function updateBestsHud() {
  const s = loadScores();
  document.getElementById('hudBests').textContent = `${s.daily.score}/${s.weekly.score}/${s.allTime}`;
}
function lifetimeCoins() {
  const n = parseInt(localStorage.getItem(COIN_KEY), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------- Game state ----------------
let phase = 'ready';     // 'ready' | 'run' | 'dying' | 'over'
let scrolled = 0;        // px travelled, converted to metres for the score
let dist = 0;            // metres
let coins = 0;           // coins this run
let thrusting = false;
let hazards = [];        // zappers: {kind:'zapper', x, y, len, ang, spin, bobAmp, bobPh, bobSpd}
let beams = [];          // {kind:'laser', y, t}
let rockets = [];        // {kind:'missile', y, x, t, flying}
let pickups = [];        // {x, y, spin, gone}
let sparks = [];         // {x, y, vx, vy, t, life, col, size}
let puffs = [];          // jetpack exhaust {x, y, vx, vy, t, life, r}
let popups = [];         // {x, y, txt, col, t}
let player = { y: 0, vy: 0, spin: 0 };
let deathT = 0;
let spawnT = 0, eventT = 0, coinT = 0;
let runRecords = new Set();
let pulse = 0;

// ---------------- Layout ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, G = null;   // {w, h, groundY, px, pr, unit}

// the webview draws under the gesture nav bar (edge-to-edge); measure the inset
// so the ground sits above it
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
  const h = r.height;
  const groundY = h - Math.max(safeBottom(), h * 0.005) - h * 0.055;
  const prev = G;
  G = {
    w: r.width, h,
    groundY,
    unit: h,                       // everything scales off height so difficulty is resolution-independent
    px: r.width * 0.2,             // player's fixed screen x
    pr: h * 0.042,                 // player collision radius
  };
  // keep the flier in bounds when the area changes size mid-run
  if (!prev) player.y = groundY * 0.55;
  else player.y = Math.min(Math.max(player.y, G.pr), groundY - G.pr);
}

// playfield the hazards occupy
const topY = () => G.h * 0.02;
const botY = () => G.groundY;
const laneY = f => topY() + (botY() - topY()) * f;
const PX_PER_M = () => G.w * 0.08;

// ---------------- Difficulty ----------------
// The real difficulty dial is *time*, not pixels: reactT is how long a hazard is on
// screen before it reaches you. Deriving the scroll speed from it keeps the game
// identically fair on a tall phone and a wide desktop window — obstacles scale with
// height, but the runway you can see is the width, so speed has to follow the width.
const runway = () => G.w - G.px;
const reactT = () => 2.2 - Math.min(1.05, dist / 1200 * 1.05);
const speed = () => runway() / reactT();
const spawnGap = () => 1.7 - Math.min(0.85, dist / 1500 * 0.85);
const eventGap = () => 7.0 - Math.min(3.4, dist / 1500 * 3.4);

function newGame() {
  phase = 'ready';
  scrolled = 0;
  dist = 0;
  coins = 0;
  thrusting = false;
  hazards = [];
  beams = [];
  rockets = [];
  pickups = [];
  sparks = [];
  puffs = [];
  popups = [];
  player = { y: G.groundY - G.pr, vy: 0, spin: 0 };
  deathT = 0;
  spawnT = 1.8;    // a beat to get airborne before the first hazard arrives
  eventT = 8;
  coinT = 1.4;
  runRecords = new Set();
  updateHud();
  updateBestsHud();
  document.getElementById('overOverlay').classList.remove('active');
}

function updateHud() {
  document.getElementById('hudDist').textContent = dist + ' m';
  document.getElementById('hudCoins').textContent = '🪙 ' + coins;
}

function die() {
  if (phase !== 'run') return;
  phase = 'dying';
  deathT = 0;
  player.vy = -G.unit * 0.5;
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, s = G.unit * (0.15 + Math.random() * 0.55);
    sparks.push({
      x: G.px, y: player.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      t: 0, life: 400 + Math.random() * 500,
      col: ['#ffd166', '#ff8c42', '#ff5e7e', '#fff1c9'][(Math.random() * 4) | 0],
      size: G.unit * (0.006 + Math.random() * 0.012),
    });
  }
  if (navigator.vibrate) navigator.vibrate([40, 40, 60]);
}

function finishRun() {
  phase = 'over';
  for (const rec of reportScore(dist)) runRecords.add(rec);
  if (coins) localStorage.setItem(COIN_KEY, String(lifetimeCoins() + coins));
  updateBestsHud();
  document.getElementById('finalDist').textContent = dist;
  document.getElementById('coinNote').textContent =
    coins ? `🪙 ${coins} coins  ·  lifetime ${lifetimeCoins()}` : '';
  document.getElementById('recordNote').textContent =
    runRecords.size ? `🏆 New ${[...runRecords].join(', ')} record!` : '';
  const s = loadScores();
  document.getElementById('finalBests').innerHTML =
    `<span>Day <b>${s.daily.score}</b></span><span>Week <b>${s.weekly.score}</b></span><span>All time <b>${s.allTime}</b></span>`;
  document.getElementById('overOverlay').classList.add('active');
}

document.getElementById('restartBtn').onclick = () => newGame();

// ---------------- Spawning ----------------
// The pattern pool opens up as you go: short single bars to learn on, then gates and
// diagonals, then movers. Reversing vertical momentum costs ~0.35s, so gaps stay wide
// enough that a late commitment still gets through.
function spawnHazards() {
  const x = G.w * 1.06;
  const span = botY() - topY();
  const stage = dist < 120 ? 0 : dist < 400 ? 1 : 2;
  const roll = Math.random();

  if (stage === 0) {
    // warm-up: one short bar at a time, always leaving most of the screen open
    if (Math.random() < 0.5) {
      const len = span * (0.2 + Math.random() * 0.12);
      hazards.push(bar(x, Math.random() < 0.5 ? topY() + len / 2 : botY() - len / 2, len, Math.PI / 2));
    } else {
      hazards.push(bar(x, laneY(0.25 + Math.random() * 0.5), G.unit * (0.22 + Math.random() * 0.14), 0));
    }
    return;
  }

  if (roll < 0.32) {
    // single long bar, leaving room above or below
    if (Math.random() < 0.45) {
      const len = span * (0.28 + Math.random() * 0.2);
      hazards.push(bar(x, Math.random() < 0.5 ? topY() + len / 2 : botY() - len / 2, len, Math.PI / 2));
    } else {
      hazards.push(bar(x, laneY(0.2 + Math.random() * 0.6), G.unit * (0.3 + Math.random() * 0.22), 0));
    }
  } else if (roll < 0.54) {
    // gate: two bars with a gap to fly through
    const gapF = 0.36 + Math.random() * 0.14;
    const gapC = 0.3 + Math.random() * 0.4;
    const upLen = Math.max(span * 0.06, (gapC - gapF / 2) * span);
    const dnLen = Math.max(span * 0.06, (1 - gapC - gapF / 2) * span);
    hazards.push(bar(x, topY() + upLen / 2, upLen, Math.PI / 2));
    hazards.push(bar(x, botY() - dnLen / 2, dnLen, Math.PI / 2));
  } else if (roll < 0.74) {
    // diagonal
    const len = span * (0.3 + Math.random() * 0.24);
    const ang = (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.5);
    hazards.push(bar(x, laneY(0.25 + Math.random() * 0.5), len, ang));
  } else if (roll < 0.88 && stage === 2) {
    // spinner
    const b = bar(x, laneY(0.3 + Math.random() * 0.4), span * (0.28 + Math.random() * 0.16), Math.random() * Math.PI);
    b.spin = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7);
    hazards.push(b);
  } else if (stage === 2) {
    // bobbing bar
    const b = bar(x, laneY(0.5), G.unit * (0.22 + Math.random() * 0.2), Math.random() < 0.5 ? 0 : Math.PI / 2);
    b.bobAmp = span * (0.12 + Math.random() * 0.16);
    b.bobSpd = 1.2 + Math.random() * 1.1;
    b.bobPh = Math.random() * Math.PI * 2;
    hazards.push(b);
  } else {
    hazards.push(bar(x, laneY(0.2 + Math.random() * 0.6), G.unit * (0.26 + Math.random() * 0.18), 0));
  }

  // a second, offset bar deep into a run
  if (dist > 600 && Math.random() < 0.3) {
    const len = G.unit * (0.2 + Math.random() * 0.16);
    hazards.push(bar(x + G.w * (0.4 + Math.random() * 0.3), laneY(Math.random() < 0.5 ? 0.16 : 0.84), len, 0));
  }
}

function bar(x, y, len, ang) {
  return { kind: 'zapper', x, y, y0: y, len, ang, spin: 0, bobAmp: 0, bobSpd: 0, bobPh: 0 };
}

function spawnEvent() {
  if (Math.random() < 0.55) {
    // laser gate: 1-2 beams from five lanes, always leaving a way through
    const lanes = [0.12, 0.31, 0.5, 0.69, 0.88];
    const n = dist > 700 && Math.random() < 0.5 ? 2 : 1;
    const picked = [];
    for (let tries = 0; tries < 30 && picked.length < n; tries++) {
      const f = lanes[(Math.random() * lanes.length) | 0];
      // keep beams apart so the gap between them stays flyable
      if (!picked.some(p => Math.abs(p - f) < 0.34)) picked.push(f);
    }
    for (const f of picked) beams.push({ kind: 'laser', y: laneY(f), t: 0 });
  } else {
    rockets.push({ kind: 'missile', y: player.y, x: G.w * 1.04, t: 0, flying: false });
  }
}

function spawnCoins() {
  const shape = ['line', 'arc', 'zig'][(Math.random() * 3) | 0];
  const n = 4 + ((Math.random() * 4) | 0);
  const step = G.unit * 0.062;
  const base = laneY(0.2 + Math.random() * 0.6);
  const x0 = G.w * 1.04;
  const dir = Math.random() < 0.5 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    let y = base;
    if (shape === 'arc') y = base + dir * Math.sin(i / (n - 1) * Math.PI) * G.unit * 0.16;
    else if (shape === 'zig') y = base + dir * (i % 2 ? step : -step);
    y = Math.min(Math.max(y, topY() + step), botY() - step);
    const c = { x: x0 + i * step, y, spin: Math.random() * 6, gone: false };
    // never park a coin inside a hazard
    if (!hazards.some(h => segDist(c.x, c.y, ...ends(h)) < G.unit * 0.05)) pickups.push(c);
  }
}

// ---------------- Geometry ----------------
function ends(h) {
  const dx = Math.cos(h.ang) * h.len / 2, dy = Math.sin(h.ang) * h.len / 2;
  return [h.x - dx, h.y - dy, h.x + dx, h.y + dy];
}
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ---------------- Update ----------------
function update(dtms) {
  const dt = dtms / 1000;
  pulse += dtms;

  // exhaust + sparks live on through the death animation
  for (const p of puffs) { p.t += dtms; p.x += p.vx * dt; p.y += p.vy * dt; }
  puffs = puffs.filter(p => p.t < p.life);
  for (const s of sparks) {
    s.t += dtms;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += G.unit * 1.6 * dt;
  }
  sparks = sparks.filter(s => s.t < s.life);
  for (const p of popups) p.t += dtms;
  popups = popups.filter(p => p.t < POPUP_MS);

  if (phase === 'dying') {
    deathT += dtms;
    player.vy += G.unit * 2.2 * dt;
    player.y += player.vy * dt;
    player.spin += dt * 5;
    if (player.y > G.groundY - G.pr) { player.y = G.groundY - G.pr; player.vy = 0; }
    // the world coasts to a stop
    const coast = Math.max(0, 1 - deathT / 700);
    scrolled += speed() * coast * dt;
    moveWorld(speed() * coast * dt);
    if (deathT >= DEATH_MS) finishRun();
    return;
  }

  if (phase !== 'run') {
    // idle on the ground until the first touch
    player.y = G.groundY - G.pr;
    return;
  }

  // ---- flight ----
  // tuned so a full-height dodge (~1.0s) fits inside reactT at top speed
  player.vy += G.unit * (thrusting ? -2.9 : 2.6) * dt;
  player.vy = Math.min(Math.max(player.vy, -G.unit * 1.15), G.unit * 1.35);
  player.y += player.vy * dt;
  if (player.y < G.pr) { player.y = G.pr; player.vy = Math.max(player.vy, 0); }
  if (player.y > G.groundY - G.pr) { player.y = G.groundY - G.pr; player.vy = Math.min(player.vy, 0); }

  if (thrusting) {
    for (let i = 0; i < 2; i++) {
      puffs.push({
        x: G.px - G.pr * 0.5 + (Math.random() - 0.5) * G.pr * 0.4,
        y: player.y + G.pr * 0.75,
        // drifts back at roughly world speed so the exhaust streams behind
        vx: -speed() * (0.8 + Math.random() * 0.3), vy: G.unit * (0.2 + Math.random() * 0.3),
        t: 0, life: 200 + Math.random() * 160, r: G.pr * (0.16 + Math.random() * 0.2),
      });
    }
  }

  const adv = speed() * dt;
  scrolled += adv;
  const m = Math.floor(scrolled / PX_PER_M());
  if (m !== dist) { dist = m; updateHud(); }
  moveWorld(adv);

  // ---- spawn scheduling ----
  spawnT -= dt;
  if (spawnT <= 0) {
    // hold zapper spawns while a laser is charging so the two can't box you in
    if (beams.length || rockets.some(r => !r.flying)) spawnT = 0.35;
    else { spawnHazards(); spawnT = spawnGap(); }
  }
  eventT -= dt;
  if (eventT <= 0) {
    if (dist < 250) eventT = 1.5;
    else { spawnEvent(); eventT = eventGap(); }
  }
  coinT -= dt;
  if (coinT <= 0) { spawnCoins(); coinT = 1.5 + Math.random() * 1.6; }

  // ---- hazards ----
  for (const h of hazards) {
    if (h.spin) h.ang += h.spin * dt;
    if (h.bobAmp) h.y = h.y0 + Math.sin(pulse / 1000 * h.bobSpd + h.bobPh) * h.bobAmp;
    if (segDist(G.px, player.y, ...ends(h)) < G.pr + G.unit * 0.012) return die();
  }

  // ---- lasers ----
  for (const b of beams) {
    b.t += dtms;
    if (b.t > LASER_WARN && b.t < LASER_WARN + LASER_FIRE &&
        Math.abs(player.y - b.y) < G.pr + G.unit * 0.016) return die();
  }
  beams = beams.filter(b => b.t < LASER_WARN + LASER_FIRE + 260);

  // ---- missiles ----
  for (const r of rockets) {
    r.t += dtms;
    if (!r.flying) {
      // tracks you while the warning flashes, then locks in
      r.y += (player.y - r.y) * Math.min(1, dt * 3.5);
      if (r.t >= MISSILE_WARN) r.flying = true;
    } else {
      r.x -= (speed() * 1.5 + G.unit * 0.55) * dt;
      for (let i = 0; i < 2; i++) {
        puffs.push({
          x: r.x + G.unit * 0.05, y: r.y + (Math.random() - 0.5) * G.unit * 0.012,
          vx: -speed() * 0.85, vy: (Math.random() - 0.5) * G.unit * 0.05,
          t: 0, life: 200 + Math.random() * 180, r: G.unit * (0.008 + Math.random() * 0.012),
        });
      }
      if (Math.abs(r.x - G.px) < G.pr + G.unit * 0.045 && Math.abs(r.y - player.y) < G.pr + G.unit * 0.018) return die();
    }
  }
  rockets = rockets.filter(r => r.x > -G.w * 0.12);

  // ---- coins ----
  for (const c of pickups) {
    c.spin += dt * 4;
    if (!c.gone && Math.hypot(c.x - G.px, c.y - player.y) < G.pr + G.unit * 0.028) {
      c.gone = true;
      coins++;
      updateHud();
      popups.push({ x: c.x, y: c.y, txt: '+1', col: '#ffd166', t: 0 });
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * Math.PI * 2;
        sparks.push({
          x: c.x, y: c.y, vx: Math.cos(a) * G.unit * 0.12, vy: Math.sin(a) * G.unit * 0.12,
          t: 0, life: 260, col: '#ffe08a', size: G.unit * 0.005,
        });
      }
    }
  }
  pickups = pickups.filter(c => !c.gone && c.x > -G.w * 0.08);
}

function moveWorld(d) {
  for (const h of hazards) h.x -= d;
  hazards = hazards.filter(h => h.x + h.len > -G.w * 0.08);
  for (const c of pickups) c.x -= d;
  for (const p of popups) p.x -= d;
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

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, G.h);
  g.addColorStop(0, '#2b2a63');
  g.addColorStop(0.45, '#5b4a8a');
  g.addColorStop(0.8, '#c96f8a');
  g.addColorStop(1, '#f2a56b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, G.w, G.h);

  // low sun
  const sx = G.w * 0.78, sy = G.groundY - G.h * 0.1;
  const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, G.h * 0.32);
  sg.addColorStop(0, '#ffd9a066');
  sg.addColorStop(1, '#ffd9a000');
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, G.w, G.h);
}

// deterministic pseudo-random so the parallax city doesn't flicker between frames
function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

function drawCity(offset, step, hMin, hMax, col, winCol) {
  const start = Math.floor(offset / step);
  ctx.fillStyle = col;
  for (let i = start; i < start + Math.ceil(G.w / step) + 2; i++) {
    const r1 = hash(i * 1.7), r2 = hash(i * 3.3);
    const bw = step * (0.62 + r1 * 0.3);
    const bh = G.h * (hMin + r2 * (hMax - hMin));
    const x = i * step - offset;
    const y = G.groundY - bh;
    ctx.fillRect(x, y, bw, bh);
    if (r1 > 0.75) ctx.fillRect(x + bw * 0.35, y - bh * 0.12, bw * 0.14, bh * 0.12); // aerial
    if (!winCol) continue;
    ctx.fillStyle = winCol;
    const cols = Math.max(1, Math.floor(bw / (G.h * 0.028)));
    const rows = Math.max(1, Math.floor(bh / (G.h * 0.05)));
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        if (hash(i * 31 + cx * 7 + cy * 13) < 0.45) continue;
        ctx.fillRect(x + bw * 0.14 + cx * (bw / cols), y + bh * 0.08 + cy * (bh / rows), bw / cols * 0.42, bh / rows * 0.34);
      }
    }
    ctx.fillStyle = col;
  }
}

function drawBackground() {
  drawSky();
  // clouds — three overlapping puffs each, so they read soft rather than as lozenges
  ctx.fillStyle = '#ffffff14';
  const cs = scrolled * 0.06;
  for (let i = 0; i < 7; i++) {
    const cx = ((i * G.w * 0.47 - cs) % (G.w * 1.6) + G.w * 1.6) % (G.w * 1.6) - G.w * 0.3;
    const cy = G.h * (0.08 + hash(i * 5.5) * 0.4);
    const cw = G.h * (0.13 + hash(i * 9.1) * 0.14);
    ctx.beginPath();
    for (let k = -1; k <= 1; k++) {
      const kw = cw * (1 - Math.abs(k) * 0.34);
      ctx.ellipse(cx + k * cw * 0.72, cy + Math.abs(k) * cw * 0.06, kw, kw * 0.34, 0, 0, 7);
    }
    ctx.fill();
  }
  drawCity(scrolled * 0.12, G.h * 0.19, 0.16, 0.40, '#3b2f5e', null);
  drawCity(scrolled * 0.28, G.h * 0.15, 0.10, 0.26, '#2a2145', '#ffd48a5c');
}

function drawGround() {
  const gh = G.h - G.groundY;
  const g = ctx.createLinearGradient(0, G.groundY, 0, G.h);
  g.addColorStop(0, '#4a3d63');
  g.addColorStop(1, '#221a35');
  ctx.fillStyle = g;
  ctx.fillRect(0, G.groundY, G.w, gh);
  ctx.fillStyle = '#ffb37a55';
  ctx.fillRect(0, G.groundY, G.w, Math.max(1, G.h * 0.004));
  // hazard stripes sliding past
  const step = G.h * 0.07;
  const off = scrolled % step;
  ctx.fillStyle = '#ffffff12';
  for (let x = -off; x < G.w; x += step) ctx.fillRect(x, G.groundY + gh * 0.42, step * 0.45, gh * 0.22);
}

function drawZapper(h) {
  const [x1, y1, x2, y2] = ends(h);
  const w = G.unit * 0.01;
  // glow
  ctx.strokeStyle = '#7be9ff33';
  ctx.lineWidth = w * 5;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  // crackling core: a jittered polyline between the two ends
  ctx.strokeStyle = '#eaffff';
  ctx.lineWidth = w;
  ctx.beginPath();
  const segs = 9;
  const nx = -(y2 - y1) / (h.len || 1), ny = (x2 - x1) / (h.len || 1);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const j = i === 0 || i === segs ? 0 : (hash(i * 3.1 + Math.floor(pulse / 55)) - 0.5) * G.unit * 0.02;
    const px = x1 + (x2 - x1) * t + nx * j;
    const py = y1 + (y2 - y1) * t + ny * j;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
  // emitter pucks
  for (const [ex, ey] of [[x1, y1], [x2, y2]]) {
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(h.ang);
    ctx.fillStyle = '#ffd166';
    roundRect(ctx, -G.unit * 0.014, -G.unit * 0.026, G.unit * 0.028, G.unit * 0.052, G.unit * 0.008);
    ctx.fill();
    ctx.fillStyle = '#00000044';
    roundRect(ctx, -G.unit * 0.014, -G.unit * 0.008, G.unit * 0.028, G.unit * 0.016, G.unit * 0.004);
    ctx.fill();
    ctx.restore();
  }
}

function drawLaser(b) {
  const half = G.unit * 0.016;
  const emW = G.unit * 0.03, emH = G.unit * 0.07;
  if (b.t < LASER_WARN) {
    const k = b.t / LASER_WARN;
    ctx.strokeStyle = `rgba(255,94,126,${0.35 + 0.45 * Math.abs(Math.sin(b.t / 90))})`;
    ctx.lineWidth = Math.max(1, G.unit * 0.004);
    ctx.setLineDash([G.unit * 0.02, G.unit * 0.02]);
    ctx.beginPath(); ctx.moveTo(0, b.y); ctx.lineTo(G.w, b.y); ctx.stroke();
    ctx.setLineDash([]);
    // charge-up dot
    ctx.fillStyle = '#ff5e7e';
    ctx.beginPath(); ctx.arc(G.w - emW, b.y, half * (0.3 + k * 0.9), 0, 7); ctx.fill();
  } else if (b.t < LASER_WARN + LASER_FIRE) {
    const k = (b.t - LASER_WARN) / LASER_FIRE;
    const t = Math.min(1, (1 - Math.abs(k - 0.5) * 2) * 4);   // snap on, fade out
    const g = ctx.createLinearGradient(0, b.y - half * 3, 0, b.y + half * 3);
    g.addColorStop(0, '#ff5e7e00');
    g.addColorStop(0.5, `rgba(255,120,150,${0.5 * t})`);
    g.addColorStop(1, '#ff5e7e00');
    ctx.fillStyle = g;
    ctx.fillRect(0, b.y - half * 3, G.w, half * 6);
    ctx.fillStyle = `rgba(255,255,255,${t})`;
    ctx.fillRect(0, b.y - half * t, G.w, half * 2 * t);
    ctx.fillStyle = `rgba(255,94,126,${t})`;
    ctx.fillRect(0, b.y - half * 1.7 * t, G.w, half * 3.4 * t);
    ctx.fillStyle = `rgba(255,255,255,${t})`;
    ctx.fillRect(0, b.y - half * 0.5 * t, G.w, half * t);
  }
  // emitters on both edges
  ctx.fillStyle = '#3b3355';
  roundRect(ctx, -emW * 0.3, b.y - emH / 2, emW, emH, emW * 0.25); ctx.fill();
  roundRect(ctx, G.w - emW * 0.7, b.y - emH / 2, emW, emH, emW * 0.25); ctx.fill();
  ctx.fillStyle = '#ff5e7e';
  ctx.fillRect(0, b.y - emH * 0.12, emW * 0.5, emH * 0.24);
  ctx.fillRect(G.w - emW * 0.5, b.y - emH * 0.12, emW * 0.5, emH * 0.24);
}

function drawMissile(r) {
  if (!r.flying) {
    // flashing warning at the edge
    const on = Math.floor(r.t / 130) % 2 === 0;
    const s = G.unit * 0.058;
    ctx.globalAlpha = on ? 1 : 0.55;   // stays legible on the dim half of the flash
    ctx.fillStyle = '#ff5e7e';
    ctx.beginPath();
    ctx.moveTo(G.w - s * 0.4, r.y - s);
    ctx.lineTo(G.w - s * 0.4, r.y + s);
    ctx.lineTo(G.w - s * 1.7, r.y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${s * 0.9}px 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', G.w - s * 0.75, r.y);
    ctx.globalAlpha = 1;
    return;
  }
  const L = G.unit * 0.09, H = G.unit * 0.032;
  ctx.save();
  ctx.translate(r.x, r.y);
  // fins
  ctx.fillStyle = '#8b90a8';
  ctx.beginPath();
  ctx.moveTo(L * 0.45, -H * 0.5); ctx.lineTo(L * 0.65, -H * 1.15); ctx.lineTo(L * 0.7, -H * 0.4);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(L * 0.45, H * 0.5); ctx.lineTo(L * 0.65, H * 1.15); ctx.lineTo(L * 0.7, H * 0.4);
  ctx.closePath(); ctx.fill();
  // body
  ctx.fillStyle = '#d8dbe8';
  roundRect(ctx, -L * 0.5, -H / 2, L, H, H * 0.35);
  ctx.fill();
  // nose
  ctx.fillStyle = '#ff5e7e';
  ctx.beginPath();
  ctx.moveTo(-L * 0.5, -H / 2); ctx.lineTo(-L * 0.85, 0); ctx.lineTo(-L * 0.5, H / 2);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#00000022';
  ctx.fillRect(-L * 0.1, -H / 2, L * 0.12, H);
  ctx.restore();
}

function drawCoin(x, y, r, spin) {
  const sq = Math.abs(Math.cos(spin));       // spin about the vertical axis
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(Math.max(0.18, sq), 1);
  ctx.fillStyle = '#f0a92e';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
  ctx.fillStyle = '#ffd166';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.78, 0, 7); ctx.fill();
  ctx.fillStyle = '#f0a92e';
  ctx.font = `800 ${r * 1.1}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', 0, r * 0.06);
  ctx.restore();
}

function drawFlier() {
  const r = G.pr;
  ctx.save();
  ctx.translate(G.px, player.y);
  if (phase === 'dying') ctx.rotate(player.spin);
  else ctx.rotate(Math.max(-0.35, Math.min(0.35, player.vy / (G.unit * 1.4))));

  // jetpack
  ctx.fillStyle = '#5c6480';
  roundRect(ctx, -r * 1.15, -r * 0.55, r * 0.7, r * 1.4, r * 0.22);
  ctx.fill();
  ctx.fillStyle = '#8b90a8';
  roundRect(ctx, -r * 1.05, -r * 0.4, r * 0.2, r * 1.0, r * 0.1);
  ctx.fill();
  // nozzle
  ctx.fillStyle = '#3b3355';
  roundRect(ctx, -r * 1.0, r * 0.8, r * 0.42, r * 0.3, r * 0.08);
  ctx.fill();

  // flame
  if (thrusting && phase === 'run') {
    const f = r * (1.1 + Math.random() * 0.55);
    const fx = -r * 0.79;
    const g = ctx.createLinearGradient(fx, r * 1.0, fx, r * 1.0 + f);
    g.addColorStop(0, '#fff6d5');
    g.addColorStop(0.4, '#ffc14d');
    g.addColorStop(1, '#ff5e7e00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(fx - r * 0.26, r * 1.0);
    ctx.lineTo(fx + r * 0.26, r * 1.0);
    ctx.lineTo(fx + (Math.random() - 0.5) * r * 0.2, r * 1.0 + f);
    ctx.closePath();
    ctx.fill();
  }

  // body
  ctx.fillStyle = '#4dd4ff';
  roundRect(ctx, -r * 0.55, -r * 0.45, r * 1.05, r * 1.25, r * 0.3);
  ctx.fill();
  // legs
  ctx.fillStyle = '#2a2145';
  roundRect(ctx, -r * 0.35, r * 0.62, r * 0.34, r * 0.55, r * 0.14); ctx.fill();
  roundRect(ctx, r * 0.08, r * 0.62, r * 0.34, r * 0.55, r * 0.14); ctx.fill();
  // scarf trailing behind
  ctx.fillStyle = '#ff5e7e';
  ctx.beginPath();
  ctx.moveTo(-r * 0.5, -r * 0.35);
  ctx.quadraticCurveTo(-r * 1.5, -r * 0.5 + Math.sin(pulse / 90) * r * 0.3, -r * 2.1, -r * 0.1 + Math.sin(pulse / 70) * r * 0.35);
  ctx.quadraticCurveTo(-r * 1.4, r * 0.05, -r * 0.5, r * 0.05);
  ctx.closePath();
  ctx.fill();
  // head
  ctx.fillStyle = '#ffd9b3';
  ctx.beginPath(); ctx.arc(r * 0.05, -r * 0.72, r * 0.46, 0, 7); ctx.fill();
  // helmet + goggles
  ctx.fillStyle = '#ef476f';
  ctx.beginPath(); ctx.arc(r * 0.05, -r * 0.78, r * 0.48, Math.PI, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2a2145';
  roundRect(ctx, -r * 0.2, -r * 0.85, r * 0.62, r * 0.26, r * 0.1);
  ctx.fill();
  ctx.fillStyle = '#7be9ff';
  roundRect(ctx, r * 0.06, -r * 0.81, r * 0.22, r * 0.16, r * 0.06);
  ctx.fill();
  ctx.restore();
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground();

  // exhaust behind everything else in the foreground
  for (const p of puffs) {
    const k = p.t / p.life;
    ctx.globalAlpha = (1 - k) * 0.5;
    ctx.fillStyle = '#e9e4f5';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + k * 1.6), 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawGround();
  for (const c of pickups) drawCoin(c.x, c.y, G.unit * 0.026, c.spin);
  for (const h of hazards) drawZapper(h);
  for (const r of rockets) drawMissile(r);
  for (const b of beams) drawLaser(b);
  drawFlier();

  for (const s of sparks) {
    const k = s.t / s.life;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = s.col;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.size * (1 - k * 0.5), 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of popups) {
    const k = p.t / POPUP_MS;
    ctx.globalAlpha = 1 - k * k;
    ctx.fillStyle = p.col;
    ctx.font = `800 ${G.unit * 0.034}px 'Segoe UI', sans-serif`;
    ctx.strokeStyle = '#0007';
    ctx.lineWidth = 3;
    ctx.strokeText(p.txt, p.x, p.y - k * G.unit * 0.06);
    ctx.fillText(p.txt, p.x, p.y - k * G.unit * 0.06);
  }
  ctx.globalAlpha = 1;

  // big distance readout, so you can watch it without looking away from the flier
  if (phase === 'run' || phase === 'dying') {
    ctx.fillStyle = '#ffffff30';
    ctx.font = `800 ${G.unit * 0.11}px 'Segoe UI', sans-serif`;
    ctx.fillText(dist + ' m', G.w / 2, G.h * 0.12);
  }

  if (phase === 'ready') {
    const bob = Math.sin(pulse / 260) * G.unit * 0.008;
    ctx.fillStyle = '#ffffffee';
    ctx.font = `800 ${G.unit * 0.05}px 'Segoe UI', sans-serif`;
    ctx.strokeStyle = '#0006';
    ctx.lineWidth = 4;
    ctx.strokeText('Hold to fly', G.w / 2, G.h * 0.36 + bob);
    ctx.fillText('Hold to fly', G.w / 2, G.h * 0.36 + bob);
    ctx.fillStyle = '#ffffffaa';
    ctx.font = `600 ${G.unit * 0.026}px 'Segoe UI', sans-serif`;
    ctx.fillText('Dodge the zappers, lasers and missiles', G.w / 2, G.h * 0.36 + G.unit * 0.055 + bob);
  }
}

// ---------------- Input ----------------
function press() {
  if (phase === 'over') return;
  if (phase === 'ready') { phase = 'run'; player.vy = -G.unit * 0.2; }
  if (phase === 'run') thrusting = true;
}
function release() { thrusting = false; }

canvas.addEventListener('pointerdown', e => { e.preventDefault(); press(); });
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', release);
window.addEventListener('blur', release);
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' && e.code !== 'ArrowUp') return;
  e.preventDefault();
  press();
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' || e.code === 'ArrowUp') release();
});

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
newGame();
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
// the canvas must track the game area itself, not just the window — the HUD can
// grow (e.g. best-score text wrapping) and shrink the area without a window resize
if (window.ResizeObserver) new ResizeObserver(layout).observe(area);
// leaving mid-flight ends the run rather than losing the distance silently
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
