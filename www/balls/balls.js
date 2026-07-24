/* Balls — aim a volley of balls at numbered blocks; survive as many rounds as you can.
   Rings give +1 ball, coins buy ball skins & trails in the store. Double-tap to fast-forward. */
'use strict';

const COLS = 7;
const STATE_KEY = 'balls.state.v1';
const SCORE_KEY = 'balls.scores.v1';
const STORE_KEY = 'balls.store.v1';
// one-time migration from the game's original "ballz" name
for (const [oldK, newK] of [['ballz.state.v1', STATE_KEY], ['ballz.scores.v1', SCORE_KEY], ['ballz.store.v1', STORE_KEY]]) {
  const v = localStorage.getItem(oldK);
  if (v != null && localStorage.getItem(newK) == null) localStorage.setItem(newK, v);
  localStorage.removeItem(oldK);
}
const FIRE_GAP = 75;        // ms between balls leaving the launcher
const POPUP_MS = 850;       // floating text
const DESTROY_MS = 260;     // block shrink animation
const FAST_SCALE = 3.2;     // double-tap fast-forward multiplier
const DOUBLE_TAP_MS = 300;
const COIN_VALUE = 3;       // coins per coin pickup

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

// ---------------- Store (coins + cosmetics) ----------------
const BALL_SKINS = [
  { id: 'classic', name: 'Classic', price: 0 },
  { id: 'sunset', name: 'Sunset', price: 30 },
  { id: 'mint', name: 'Mint', price: 30 },
  { id: 'neon', name: 'Neon', price: 60 },
  { id: 'beach', name: 'Beach', price: 90 },
  { id: 'glass', name: 'Glass', price: 120 },
  { id: 'smiley', name: 'Smiley', price: 160 },
  { id: 'eyeball', name: 'Eyeball', price: 220 },
];
const TRAILS = [
  { id: 'none', name: 'None', price: 0 },
  { id: 'streak', name: 'Streak', price: 40 },
  { id: 'rainbow', name: 'Rainbow', price: 80 },
  { id: 'fire', name: 'Fire', price: 120 },
  { id: 'bubbles', name: 'Bubbles', price: 160 },
  { id: 'sparkle', name: 'Sparkle', price: 220 },
];
function loadStoreState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { s = {}; }
  if (typeof s.coins !== 'number' || s.coins < 0) s.coins = 0;
  if (!Array.isArray(s.owned)) s.owned = [];
  for (const id of ['classic', 'none']) if (!s.owned.includes(id)) s.owned.push(id);
  if (!BALL_SKINS.some(b => b.id === s.ball) || !s.owned.includes(s.ball)) s.ball = 'classic';
  if (!TRAILS.some(t => t.id === s.trail) || !s.owned.includes(s.trail)) s.trail = 'none';
  return s;
}
let shop = loadStoreState();
function saveStore() { localStorage.setItem(STORE_KEY, JSON.stringify(shop)); }

// ---------------- Game state ----------------
let round = 1;
let ballCount = 1;
let launchX = 0.5;          // launcher position, fraction of playfield width
let blocks = [];            // {c, r, hp, flash}
let pickups = [];           // {c, r, kind: 'ball' | 'coin'}
let phase = 'aim';          // 'aim' | 'volley' | 'over'
let runCoins = 0;           // coins earned this run (for the game-over dialog)
let runRecords = new Set();
let popups = [];            // {x, y, txt, color, t}
let destroys = [];          // {c, r, color, t}

// volley
let aimDir = null;
let toFire = 0, fireT = 0;
let flight = [];            // {x, y, vx, vy, hist, dead}
let volleyBalls = 0;        // +1 pickups collected this volley
let coinsThisVolley = 0;
let returnedX = null;       // where the first ball landed → next launch point
let fast = false;

function saveState() {
  if (phase === 'over') return;
  localStorage.setItem(STATE_KEY, JSON.stringify({
    round,
    balls: ballCount + volleyBalls,   // mid-volley close: keep collected +1s, replay the volley
    launchX,
    blocks: blocks.map(b => ({ c: b.c, r: b.r, hp: b.hp })),
    pickups,
    runCoins,
    runRecords: [...runRecords],
  }));
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (s && s.round >= 1 && s.balls >= 1 && Array.isArray(s.blocks) && Array.isArray(s.pickups) &&
        s.blocks.every(b => b.c >= 0 && b.c < COLS && b.r >= 0 && b.hp > 0) &&
        s.pickups.every(p => p.c >= 0 && p.c < COLS && (p.kind === 'ball' || p.kind === 'coin'))) {
      round = s.round;
      ballCount = s.balls;
      launchX = Math.min(Math.max(s.launchX || 0.5, 0.03), 0.97);
      blocks = s.blocks.map(b => ({ c: b.c, r: b.r, hp: b.hp, flash: 0 }));
      pickups = s.pickups;
      runCoins = s.runCoins || 0;
      runRecords = new Set(s.runRecords || []);
      return true;
    }
  } catch { }
  return false;
}
// bank in-flight coins before the snapshot so nothing is lost or double-counted
function flushSave() {
  if (coinsThisVolley) {
    shop.coins += coinsThisVolley;
    runCoins += coinsThisVolley;
    coinsThisVolley = 0;
    saveStore();
  }
  saveState();
}

function newGame() {
  round = 1;
  ballCount = 1;
  launchX = 0.5;
  blocks = [];
  pickups = [];
  popups = [];
  destroys = [];
  flight = [];
  runCoins = 0;
  runRecords = new Set();
  coinsThisVolley = 0;
  fast = false;
  phase = 'aim';
  spawnRow();
  reportScore(1);
  updateHud();
  updateBestsHud();
  saveState();
  document.getElementById('overOverlay').classList.remove('active');
}

function spawnRow() {
  const cols = [...Array(COLS).keys()];
  for (let i = cols.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [cols[i], cols[j]] = [cols[j], cols[i]];
  }
  pickups.push({ c: cols[0], r: 0, kind: 'ball' });   // every row has a +1 ball ring
  let used = 1;
  if (Math.random() < 0.4) { pickups.push({ c: cols[1], r: 0, kind: 'coin' }); used = 2; }
  const nBlocks = Math.min(2 + ((Math.random() * 4) | 0), COLS - used);
  for (let k = 0; k < nBlocks; k++) {
    blocks.push({ c: cols[used + k], r: 0, hp: Math.random() < 0.22 ? round * 2 : round, flash: 0 });
  }
}

function advanceRound() {
  for (const bl of blocks) bl.r++;
  for (const p of pickups) p.r++;
  // pickups reaching the danger row are collected automatically
  for (const p of pickups) {
    if (p.r < G.rows - 1) continue;
    const [px, py] = pickupCenter(p);
    if (p.kind === 'ball') { ballCount++; popups.push({ x: px, y: py, txt: '+1', color: '#7cf29c', t: 0 }); }
    else {
      shop.coins += COIN_VALUE;
      runCoins += COIN_VALUE;
      saveStore();
      popups.push({ x: px, y: py, txt: '+' + COIN_VALUE + ' 🪙', color: '#ffd166', t: 0 });
    }
  }
  pickups = pickups.filter(p => p.r < G.rows - 1);
  if (blocks.some(bl => bl.r >= G.rows - 1)) { endGame(); return; }
  round++;
  for (const rec of reportScore(round)) runRecords.add(rec);
  spawnRow();
  phase = 'aim';
  updateHud();
  updateBestsHud();
  saveState();
}

function endGame() {
  phase = 'over';
  localStorage.removeItem(STATE_KEY);
  updateBestsHud();
  document.getElementById('finalScore').textContent = round;
  document.getElementById('recordNote').textContent =
    runRecords.size ? `🏆 New ${[...runRecords].join(', ')} record!` : '';
  document.getElementById('coinNote').textContent = runCoins ? `🪙 +${runCoins} coins earned` : '';
  const s = loadScores();
  document.getElementById('finalBests').innerHTML =
    `<span>Day <b>${s.daily.score}</b></span><span>Week <b>${s.weekly.score}</b></span><span>All time <b>${s.allTime}</b></span>`;
  if (navigator.vibrate) navigator.vibrate([40, 40, 60]);
  setTimeout(() => document.getElementById('overOverlay').classList.add('active'), 500);
}

function updateHud() {
  document.getElementById('hudRound').textContent = round;
  document.getElementById('hudCoins').textContent = '🪙 ' + shop.coins;
}

document.getElementById('newBtn').onclick = () => newGame();
document.getElementById('restartBtn').onclick = () => newGame();

// ---------------- Layout ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, G = null; // {w, h, ox, pw, cell, top, floorY, rows}

// the webview draws under the gesture nav bar (edge-to-edge); measure the inset
// so the launcher sits above it
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
  // fills the full width on phones; on wide windows the field is centered with gutters
  const pw = Math.min(r.width, r.height * 0.72);
  const cell = pw / COLS;
  const top = 0;
  // bottom gap: the reported safe-area inset when the platform provides one,
  // else a small fraction of the screen so it scales with any resolution
  const floorY = r.height - Math.max(safeBottom(), r.height * 0.005);
  G = {
    w: r.width, h: r.height, pw, cell, top, floorY,
    ox: (r.width - pw) / 2,
    rows: Math.max(5, Math.floor((floorY - top - cell * 0.55) / cell)),
  };
}
const br = () => G.cell * 0.15;                    // ball radius
const spd = () => Math.max(600, G.cell * 16);      // ball speed px/s
const launchPx = () => G.ox + launchX * G.pw;
function pickupCenter(p) {
  return [G.ox + (p.c + 0.5) * G.cell, G.top + (p.r + 0.5) * G.cell];
}

// ---------------- Volley physics ----------------
function fireVolley(dir) {
  aimDir = dir;
  phase = 'volley';
  toFire = ballCount;
  fireT = FIRE_GAP;
  flight = [];
  volleyBalls = 0;
  coinsThisVolley = 0;
  returnedX = null;
  fast = false;
}

function updateVolley(dt) {
  if (toFire > 0) {
    fireT += dt;
    while (fireT >= FIRE_GAP && toFire > 0) {
      fireT -= FIRE_GAP;
      flight.push({ x: launchPx(), y: G.floorY - br(), vx: aimDir.x * spd(), vy: aimDir.y * spd(), hist: [], dead: false });
      toFire--;
    }
  }
  const r = br();
  for (const b of flight) {
    b.hist.push({ x: b.x, y: b.y });
    if (b.hist.length > 15) b.hist.shift();
    const dist = spd() * dt / 1000;
    const n = Math.max(1, Math.ceil(dist / (r * 0.5)));
    const sdt = dt / 1000 / n;
    for (let i = 0; i < n && !b.dead; i++) {
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;
      if (b.x < G.ox + r) { b.x = G.ox + r; b.vx = Math.abs(b.vx); }
      else if (b.x > G.ox + G.pw - r) { b.x = G.ox + G.pw - r; b.vx = -Math.abs(b.vx); }
      if (b.y < G.top + r) { b.y = G.top + r; b.vy = Math.abs(b.vy); }
      if (b.y > G.floorY - r && b.vy > 0) {
        b.dead = true;
        if (returnedX == null) returnedX = Math.min(Math.max(b.x, G.ox + r), G.ox + G.pw - r);
        break;
      }
      collideBlocks(b, r);
      collectPickups(b, r);
    }
  }
  flight = flight.filter(b => !b.dead);
  if (toFire === 0 && flight.length === 0) endVolley();
}

function collideBlocks(b, r) {
  const inset = G.cell * 0.04;
  // a seam hit touches two blocks at once, and bouncing off the first can leave
  // the ball inside its neighbor — resolve a few contacts per substep
  for (let pass = 0; pass < 3; pass++) {
    let best = null, bd2 = Infinity, bcx = 0, bcy = 0;
    for (const bl of blocks) {
      const x0 = G.ox + bl.c * G.cell + inset, y0 = G.top + bl.r * G.cell + inset;
      const cx = Math.max(x0, Math.min(b.x, x0 + G.cell - inset * 2));
      const cy = Math.max(y0, Math.min(b.y, y0 + G.cell - inset * 2));
      const dx = b.x - cx, dy = b.y - cy;
      const d2 = dx * dx + dy * dy;
      // deepest contact wins: array order can pick the far block at a seam
      if (d2 <= r * r && d2 < bd2) { best = bl; bd2 = d2; bcx = cx; bcy = cy; }
    }
    if (!best) return;
    const dx = b.x - bcx, dy = b.y - bcy;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    // a face shared with a live neighbor is interior — reflecting off it shoves
    // the ball into the neighbor and it can ping-pong down through the seam
    const xOpen = dx !== 0 && !blocks.some(o => o.r === best.r && o.c === best.c + Math.sign(dx));
    const yOpen = dy !== 0 && !blocks.some(o => o.c === best.c && o.r === best.r + Math.sign(dy));
    if (dx === 0 && dy === 0) {                        // dead center — punt upward
      b.vy = -Math.abs(b.vy);
      b.y = G.top + best.r * G.cell + inset - r;
    } else if (xOpen && (ax > ay * 1.4 || !yOpen)) {   // side face
      b.vx = dx > 0 ? Math.abs(b.vx) : -Math.abs(b.vx);
      b.x = bcx + Math.sign(dx) * r;
    } else if (yOpen && (ay > ax * 1.4 || !xOpen)) {   // top/bottom face
      b.vy = dy > 0 ? Math.abs(b.vy) : -Math.abs(b.vy);
      b.y = bcy + Math.sign(dy) * r;
    } else if (xOpen && yOpen) {                       // corner hit reflects both axes
      b.vx = dx > 0 ? Math.abs(b.vx) : -Math.abs(b.vx);
      b.vy = dy > 0 ? Math.abs(b.vy) : -Math.abs(b.vy);
      const dl = Math.sqrt(bd2) || 1;
      b.x = bcx + dx / dl * r;
      b.y = bcy + dy / dl * r;
    } else {                                           // boxed in — send it back the way it came
      b.vx = -b.vx;
      b.vy = -b.vy;
    }
    best.hp--;
    best.flash = 1;
    if (best.hp <= 0) {
      blocks.splice(blocks.indexOf(best), 1);
      destroys.push({ c: best.c, r: best.r, color: hpColor(1), t: 0 });
      if (navigator.vibrate) navigator.vibrate(12);
    }
  }
}

function collectPickups(b, r) {
  if (!pickups.length) return;
  const pr = G.cell * 0.24;
  pickups = pickups.filter(p => {
    const [px, py] = pickupCenter(p);
    const dx = b.x - px, dy = b.y - py;
    if (dx * dx + dy * dy > (r + pr) * (r + pr)) return true;
    if (p.kind === 'ball') { volleyBalls++; popups.push({ x: px, y: py, txt: '+1', color: '#7cf29c', t: 0 }); }
    else { coinsThisVolley += COIN_VALUE; popups.push({ x: px, y: py, txt: '+' + COIN_VALUE + ' 🪙', color: '#ffd166', t: 0 }); }
    if (navigator.vibrate) navigator.vibrate(8);
    return false;
  });
}

function endVolley() {
  if (returnedX != null) launchX = (returnedX - G.ox) / G.pw;
  ballCount += volleyBalls;
  volleyBalls = 0;
  if (coinsThisVolley) {
    shop.coins += coinsThisVolley;
    runCoins += coinsThisVolley;
    coinsThisVolley = 0;
    saveStore();
  }
  fast = false;
  updateHud();
  advanceRound();
}

// ---------------- Input ----------------
let aim = null;  // {sx, sy, dir}
let lastTap = 0;

function calcAim(x, y) {
  // slingshot: drag down pulls the shot up, like the original
  const dx = aim.sx - x, dy = aim.sy - y;
  const len = Math.hypot(dx, dy);
  if (len < 14) return null;
  const d = { x: dx / len, y: dy / len };
  return d.y < -0.1 ? d : null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (phase === 'volley') {
    const now = performance.now();
    if (now - lastTap < DOUBLE_TAP_MS) fast = true;
    lastTap = now;
    return;
  }
  if (phase !== 'aim') return;
  const r = canvas.getBoundingClientRect();
  aim = { sx: e.clientX - r.left, sy: e.clientY - r.top, dir: null };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!aim) return;
  const r = canvas.getBoundingClientRect();
  aim.dir = calcAim(e.clientX - r.left, e.clientY - r.top);
});
canvas.addEventListener('pointerup', () => {
  if (aim && aim.dir) fireVolley(aim.dir);
  aim = null;
});
canvas.addEventListener('pointercancel', () => { aim = null; });

// ---------------- Rendering ----------------
function roundRect(c, x, y, w, h, rad) {
  c.beginPath();
  c.moveTo(x + rad, y);
  c.arcTo(x + w, y, x + w, y + h, rad);
  c.arcTo(x + w, y + h, x, y + h, rad);
  c.arcTo(x, y + h, x, y, rad);
  c.arcTo(x, y, x + w, y, rad);
  c.closePath();
}

function hpColor(hp) {
  return `hsl(${(hp * 23 + 8) % 360}, 68%, 55%)`;
}

function drawBlockCell(px, py, s, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  roundRect(ctx, px + s * 0.05, py + s * 0.05, s * 0.9, s * 0.9, s * 0.16);
  ctx.fillStyle = color;
  ctx.fill();
  roundRect(ctx, px + s * 0.12, py + s * 0.1, s * 0.76, s * 0.3, s * 0.12);
  ctx.fillStyle = '#ffffff30';
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawBallSkin(c, x, y, r, id) {
  c.save();
  let grad;
  switch (id) {
    case 'sunset':
      grad = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.15, x, y, r);
      grad.addColorStop(0, '#ffe08a');
      grad.addColorStop(1, '#ef476f');
      c.fillStyle = grad;
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      break;
    case 'mint':
      grad = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.15, x, y, r);
      grad.addColorStop(0, '#e8fff4');
      grad.addColorStop(1, '#06d6a0');
      c.fillStyle = grad;
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      break;
    case 'neon':
      c.shadowColor = '#22e0ff';
      c.shadowBlur = r * 1.6;
      c.fillStyle = '#5ff0ff';
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      c.shadowBlur = 0;
      break;
    case 'beach': {
      c.beginPath(); c.arc(x, y, r, 0, 7); c.clip();
      const stripes = ['#ef476f', '#fff', '#4cc9f0'];
      for (let i = 0; i < 3; i++) {
        c.fillStyle = stripes[i];
        c.fillRect(x - r + i * (2 * r / 3), y - r, 2 * r / 3 + 1, 2 * r);
      }
      c.strokeStyle = '#00000022';
      c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, r - 1, 0, 7); c.stroke();
      break;
    }
    case 'glass':
      c.fillStyle = '#ffffff3d';
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      c.strokeStyle = '#ffffffcc';
      c.lineWidth = Math.max(1, r * 0.14);
      c.beginPath(); c.arc(x, y, r - c.lineWidth / 2, 0, 7); c.stroke();
      break;
    case 'smiley':
      c.fillStyle = '#ffd166';
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      c.fillStyle = '#3a3a55';
      c.beginPath(); c.arc(x - r * 0.35, y - r * 0.25, r * 0.13, 0, 7); c.fill();
      c.beginPath(); c.arc(x + r * 0.35, y - r * 0.25, r * 0.13, 0, 7); c.fill();
      c.strokeStyle = '#3a3a55';
      c.lineWidth = Math.max(1, r * 0.14);
      c.beginPath(); c.arc(x, y + r * 0.1, r * 0.5, 0.3, Math.PI - 0.3); c.stroke();
      break;
    case 'eyeball':
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      c.fillStyle = '#4d9be8';
      c.beginPath(); c.arc(x, y, r * 0.52, 0, 7); c.fill();
      c.fillStyle = '#20223a';
      c.beginPath(); c.arc(x, y, r * 0.26, 0, 7); c.fill();
      c.fillStyle = '#ffffffcc';
      c.beginPath(); c.arc(x - r * 0.18, y - r * 0.2, r * 0.1, 0, 7); c.fill();
      break;
    default: // classic
      grad = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.15, x, y, r);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, '#c9d4ec');
      c.fillStyle = grad;
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  }
  if (id !== 'glass' && id !== 'smiley' && id !== 'eyeball' && id !== 'neon') {
    c.fillStyle = '#ffffffb0';
    c.beginPath(); c.arc(x - r * 0.35, y - r * 0.4, r * 0.18, 0, 7); c.fill();
  }
  c.restore();
}

function drawCoin(c, x, y, r) {
  const grad = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.15, x, y, r);
  grad.addColorStop(0, '#ffe27a');
  grad.addColorStop(1, '#f0a500');
  c.fillStyle = grad;
  c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  c.strokeStyle = '#c47f00';
  c.lineWidth = Math.max(1, r * 0.16);
  c.beginPath(); c.arc(x, y, r * 0.62, 0, 7); c.stroke();
}

function drawTrail(c, hist, id, r, tg) {
  if (id === 'none') return;
  const n = hist.length;
  for (let i = 0; i < n; i++) {
    const p = hist[i];
    const k = (i + 1) / n;   // 0 = oldest, 1 = newest
    switch (id) {
      case 'streak':
        c.globalAlpha = k * 0.35;
        c.fillStyle = '#fff';
        c.beginPath(); c.arc(p.x, p.y, r * k * 0.8, 0, 7); c.fill();
        break;
      case 'rainbow':
        c.globalAlpha = k * 0.55;
        c.fillStyle = `hsl(${(i * 30 + tg * 0.15) % 360}, 90%, 60%)`;
        c.beginPath(); c.arc(p.x, p.y, r * k * 0.85, 0, 7); c.fill();
        break;
      case 'fire':
        c.globalAlpha = k * 0.6;
        c.fillStyle = k > 0.6 ? '#ffd166' : k > 0.3 ? '#f78c1e' : '#ef476f';
        c.beginPath(); c.arc(p.x, p.y, r * (0.35 + k * 0.6), 0, 7); c.fill();
        break;
      case 'bubbles':
        if (i % 3 === 0) {
          c.globalAlpha = k * 0.55;
          c.strokeStyle = '#bfe6ff';
          c.lineWidth = 1.5;
          c.beginPath(); c.arc(p.x, p.y, r * (0.45 + 0.35 * Math.abs(Math.sin(tg * 0.004 + i))), 0, 7); c.stroke();
        }
        break;
      case 'sparkle':
        if (i % 2 === 0) {
          c.globalAlpha = k * 0.7;
          c.strokeStyle = '#fff3b0';
          c.lineWidth = 1.5;
          const s = r * 0.9 * k;
          c.beginPath();
          c.moveTo(p.x - s, p.y); c.lineTo(p.x + s, p.y);
          c.moveTo(p.x, p.y - s); c.lineTo(p.x, p.y + s);
          c.stroke();
        }
        break;
    }
  }
  c.globalAlpha = 1;
}

let pulse = 0;

function pointInBlock(x, y) {
  const gx = Math.floor((x - G.ox) / G.cell), gy = Math.floor((y - G.top) / G.cell);
  return blocks.some(bl => bl.c === gx && bl.r === gy);
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, G.w, G.h);
  ctx.fillStyle = '#27356b';
  ctx.fillRect(0, 0, G.w, G.h);
  if (G.ox > 0) {
    ctx.fillStyle = '#1b2140';
    ctx.fillRect(0, 0, G.ox, G.h);
    ctx.fillRect(G.ox + G.pw, 0, G.w - G.ox - G.pw, G.h);
  }
  const cell = G.cell, r = br();

  // danger line
  const dangerY = G.top + (G.rows - 1) * cell;
  ctx.strokeStyle = '#ff5e7e55';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(G.ox + 4, dangerY);
  ctx.lineTo(G.ox + G.pw - 4, dangerY);
  ctx.stroke();
  ctx.setLineDash([]);

  // blocks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const bl of blocks) {
    const px = G.ox + bl.c * cell, py = G.top + bl.r * cell;
    drawBlockCell(px, py, cell, hpColor(bl.hp));
    if (bl.flash > 0) {
      roundRect(ctx, px + cell * 0.05, py + cell * 0.05, cell * 0.9, cell * 0.9, cell * 0.16);
      ctx.fillStyle = `rgba(255,255,255,${bl.flash * 0.55})`;
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${cell * 0.36}px 'Segoe UI', sans-serif`;
    ctx.fillText(bl.hp, px + cell / 2, py + cell * 0.56);
  }

  // destroyed blocks shrink away
  for (const d of destroys) {
    const k = 1 - d.t / DESTROY_MS;
    if (k <= 0) continue;
    const s = cell * k;
    drawBlockCell(G.ox + d.c * cell + (cell - s) / 2, G.top + d.r * cell + (cell - s) / 2, s, d.color, k);
  }

  // pickups
  for (const p of pickups) {
    const [px, py] = pickupCenter(p);
    const wob = 1 + 0.08 * Math.sin(pulse * 0.005 + p.c);
    if (p.kind === 'ball') {
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, cell * 0.24 * wob, 0, 7); ctx.stroke();
      drawBallSkin(ctx, px, py, cell * 0.11, shop.ball);
    } else {
      drawCoin(ctx, px, py, cell * 0.18 * wob);
    }
  }

  // sightline: a bunch of white dots up to the first obstacle
  if (phase === 'aim' && aim && aim.dir) {
    let x = launchPx(), y = G.floorY - r;
    const spacing = cell * 0.38;
    let acc = 0;
    ctx.fillStyle = '#ffffffd9';
    for (let d = 0; d < (G.floorY - G.top) * 1.5; d += 4) {
      x += aim.dir.x * 4;
      y += aim.dir.y * 4;
      if (x < G.ox + 3 || x > G.ox + G.pw - 3 || y < G.top + 3 || pointInBlock(x, y)) break;
      acc += 4;
      if (acc >= spacing) {
        acc = 0;
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
      }
    }
  }

  // balls in flight (trails first, then balls on top)
  const now = performance.now();
  for (const b of flight) drawTrail(ctx, b.hist, shop.trail, r, now);
  for (const b of flight) drawBallSkin(ctx, b.x, b.y, r, shop.ball);

  // launcher + remaining count
  const remaining = phase === 'volley' ? toFire : ballCount;
  if (phase === 'aim' || toFire > 0) {
    drawBallSkin(ctx, launchPx(), G.floorY - r, r, shop.ball);
    ctx.fillStyle = '#fff';
    ctx.font = `700 14px 'Segoe UI', sans-serif`;
    ctx.fillText('×' + remaining, launchPx(), G.floorY - r * 2 - 12);
  }
  // where the next volley will launch from
  if (phase === 'volley' && returnedX != null) drawBallSkin(ctx, returnedX, G.floorY - r, r, shop.ball);

  // first-round hint
  if (phase === 'aim' && !aim && round === 1) {
    ctx.fillStyle = '#ffffff77';
    ctx.font = `600 14px 'Segoe UI', sans-serif`;
    ctx.fillText('Drag anywhere to aim, release to fire', G.w / 2, G.floorY - cell * 1.6);
    ctx.fillText('Double-tap to fast-forward', G.w / 2, G.floorY - cell * 1.6 + 20);
  }

  // fast-forward indicator
  if (fast) {
    ctx.fillStyle = '#ffffffcc';
    ctx.font = `700 20px 'Segoe UI', sans-serif`;
    ctx.fillText('⏩', G.ox + G.pw - 20, G.top + 18);
  }

  // floating text
  for (const p of popups) {
    const k = p.t / POPUP_MS;
    ctx.globalAlpha = 1 - k * k;
    ctx.fillStyle = p.color;
    ctx.font = `800 ${Math.max(16, cell * 0.38)}px 'Segoe UI', sans-serif`;
    ctx.strokeStyle = '#0007';
    ctx.lineWidth = 4;
    ctx.strokeText(p.txt, p.x, p.y - k * 40);
    ctx.fillText(p.txt, p.x, p.y - k * 40);
    ctx.globalAlpha = 1;
  }
}

// ---------------- Store UI ----------------
const storeOverlay = document.getElementById('storeOverlay');
document.getElementById('storeBtn').onclick = () => { renderStore(); storeOverlay.classList.add('active'); };
document.getElementById('storeClose').onclick = () => storeOverlay.classList.remove('active');

function renderStore() {
  document.getElementById('storeCoins').textContent = '🪙 ' + shop.coins;
  renderGrid('ballGrid', BALL_SKINS, 'ball');
  renderGrid('trailGrid', TRAILS, 'trail');
}
function renderGrid(elId, items, slot) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  for (const it of items) {
    const owned = shop.owned.includes(it.id);
    const equipped = shop[slot] === it.id;
    const btn = document.createElement('button');
    btn.className = 'store-item' + (equipped ? ' equipped' : '') + (!owned && shop.coins < it.price ? ' cant' : '');
    const cv = document.createElement('canvas');
    cv.width = 88; cv.height = 88;
    btn.appendChild(cv);
    const nm = document.createElement('div');
    nm.textContent = it.name;
    btn.appendChild(nm);
    const pr = document.createElement('div');
    pr.className = 'price';
    pr.textContent = equipped ? '✓ on' : owned ? 'owned' : '🪙' + it.price;
    btn.appendChild(pr);
    const c2 = cv.getContext('2d');
    c2.scale(2, 2);
    if (slot === 'ball') {
      drawBallSkin(c2, 22, 22, 13, it.id);
    } else {
      const hist = [...Array(10)].map((_, i) => ({ x: 7 + i * 3.2, y: 37 - i * 3.2 }));
      drawTrail(c2, hist, it.id, 6, 400);
      drawBallSkin(c2, 7 + 9 * 3.2 + 3, 37 - 9 * 3.2 - 3, 6, shop.ball);
    }
    btn.onclick = () => {
      if (!owned) {
        if (shop.coins < it.price) return;
        shop.coins -= it.price;
        shop.owned.push(it.id);
      }
      shop[slot] = it.id;
      saveStore();
      renderStore();
      updateHud();
    };
    el.appendChild(btn);
  }
}

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(50, t - lastT);
  lastT = t;
  if (document.hidden) return;
  pulse += dt;
  if (phase === 'volley') updateVolley(dt * (fast ? FAST_SCALE : 1));
  for (const d of destroys) d.t += dt;
  destroys = destroys.filter(d => d.t < DESTROY_MS);
  for (const p of popups) p.t += dt;
  popups = popups.filter(p => p.t < POPUP_MS);
  for (const bl of blocks) if (bl.flash > 0) bl.flash = Math.max(0, bl.flash - dt / 160);
  draw();
}

// ---------------- Boot ----------------
layout();
if (!loadState()) newGame();
updateHud();
updateBestsHud();
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
// the canvas must track the game area itself, not just the window — the HUD can
// grow (e.g. best-score text wrapping) and shrink the area without a window resize
if (window.ResizeObserver) new ResizeObserver(layout).observe(area);
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
