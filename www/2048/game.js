/* 2048 — swipe-merge puzzle */
'use strict';

const SIZE = 4;
const STATE_KEY = '2048.state.v1';
const SCORE_KEY = '2048.scores.v1';
const SLIDE_MS = 130;
const POP_MS = 120;

// ---------------- High scores (daily / weekly / all-time) ----------------
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
  document.getElementById('hudBests').textContent = `${s.daily.score} / ${s.weekly.score} / ${s.allTime}`;
}

// ---------------- State ----------------
let grid = new Array(SIZE * SIZE).fill(0);
let score = 0;
let won = false;        // reached 2048 (win overlay shown once)
let over = false;
let prev = null;        // one-step undo snapshot
let animating = false;
let slides = [];        // {val, fx, fy, tx, ty, merge}
let pops = [];          // {i, t} scale-in tiles (new spawns + merge results)

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify({ grid: [...grid], score, won }));
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (s && Array.isArray(s.grid) && s.grid.length === SIZE * SIZE && s.grid.some(v => v > 0) && !isStuck(s.grid)) {
      grid = s.grid.map(Number);
      score = s.score || 0;
      won = !!s.won;
      return true;
    }
  } catch { }
  return false;
}

function newGame() {
  grid.fill(0);
  score = 0;
  won = false;
  over = false;
  prev = null;
  slides = [];
  pops = [];
  spawn(); spawn();
  updateHud();
  saveState();
  document.getElementById('overOverlay').classList.remove('active');
  document.getElementById('winOverlay').classList.remove('active');
}

function spawn() {
  const empty = [];
  for (let i = 0; i < grid.length; i++) if (!grid[i]) empty.push(i);
  if (!empty.length) return;
  const i = empty[Math.floor(Math.random() * empty.length)];
  grid[i] = Math.random() < 0.9 ? 2 : 4;
  pops.push({ i, t: 0 });
}

// ---------------- Moves ----------------
// line index arrays per direction, ordered from the edge tiles slide toward
function lines(dir) {
  const out = [];
  for (let a = 0; a < SIZE; a++) {
    const line = [];
    for (let b = 0; b < SIZE; b++) {
      switch (dir) {
        case 'left': line.push(a * SIZE + b); break;
        case 'right': line.push(a * SIZE + (SIZE - 1 - b)); break;
        case 'up': line.push(b * SIZE + a); break;
        case 'down': line.push((SIZE - 1 - b) * SIZE + a); break;
      }
    }
    out.push(line);
  }
  return out;
}

function move(dir) {
  if (animating || over) return;
  const newGrid = new Array(SIZE * SIZE).fill(0);
  const moves = [];
  let changed = false;
  let gained = 0;

  for (const line of lines(dir)) {
    let target = 0;
    let lastVal = 0, lastSlot = -1;
    for (let k = 0; k < SIZE; k++) {
      const v = grid[line[k]];
      if (!v) continue;
      if (v === lastVal) {
        newGrid[line[lastSlot]] = v * 2;
        gained += v * 2;
        moves.push({ from: line[k], to: line[lastSlot], val: v, merge: true });
        lastVal = 0;
      } else {
        newGrid[line[target]] = v;
        moves.push({ from: line[k], to: line[target], val: v });
        lastVal = v;
        lastSlot = target;
        target++;
      }
    }
  }
  for (const m of moves) if (m.from !== m.to || m.merge) { changed = true; break; }
  if (!changed) return;

  prev = { grid: [...grid], score };
  score += gained;

  // start slide animation from the old layout
  slides = moves.map(m => ({
    val: m.val,
    fx: m.from % SIZE, fy: (m.from / SIZE) | 0,
    tx: m.to % SIZE, ty: (m.to / SIZE) | 0,
    merge: !!m.merge,
    to: m.to,
    t: 0,
  }));
  animating = true;
  const mergedTargets = moves.filter(m => m.merge).map(m => m.to);

  setTimeout(() => {
    grid = newGrid;
    for (const i of mergedTargets) pops.push({ i, t: 0 });
    slides = [];
    spawn();
    animating = false;
    updateHud();
    reportScore(score);
    updateBestsHud();
    saveState();
    if (!won && grid.includes(2048)) {
      won = true;
      saveState();
      document.getElementById('winOverlay').classList.add('active');
    }
    if (isStuck(grid)) endGame();
  }, SLIDE_MS);
}

function isStuck(g) {
  for (let i = 0; i < g.length; i++) if (!g[i]) return false;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = g[y * SIZE + x];
      if (x + 1 < SIZE && g[y * SIZE + x + 1] === v) return false;
      if (y + 1 < SIZE && g[(y + 1) * SIZE + x] === v) return false;
    }
  }
  return true;
}

function endGame() {
  over = true;
  const records = reportScore(score);
  updateBestsHud();
  document.getElementById('finalScore').textContent = score;
  document.getElementById('recordNote').textContent =
    records.length ? `🏆 New ${records.join(', ')} record!` : '';
  const s = loadScores();
  document.getElementById('finalBests').innerHTML =
    `<span>Day <b>${s.daily.score}</b></span><span>Week <b>${s.weekly.score}</b></span><span>All time <b>${s.allTime}</b></span>`;
  localStorage.removeItem(STATE_KEY);
  setTimeout(() => document.getElementById('overOverlay').classList.add('active'), 400);
}

// ---------------- Buttons ----------------
document.getElementById('newBtn').onclick = () => { if (!animating) newGame(); };
document.getElementById('restartBtn').onclick = () => newGame();
document.getElementById('winNewBtn').onclick = () => newGame();
document.getElementById('keepBtn').onclick = () => document.getElementById('winOverlay').classList.remove('active');
document.getElementById('undoBtn').onclick = () => {
  if (animating || over || !prev) return;
  grid = [...prev.grid];
  score = prev.score;
  prev = null;
  pops = [];
  updateHud();
  saveState();
};

function updateHud() {
  document.getElementById('hudScore').textContent = score;
  document.getElementById('undoBtn').disabled = !prev;
}

// ---------------- Input ----------------
const area = document.querySelector('.game-area');
let swipe = null;
area.addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; });
area.addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
  else move(dy > 0 ? 'down' : 'up');
});
window.addEventListener('keydown', (e) => {
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (map[e.key]) { e.preventDefault(); move(map[e.key]); }
});

// ---------------- Render ----------------
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, B = null; // {ox,oy,size,cell,gap}

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const size = Math.min(r.width, r.height) - 24;
  B = { w: r.width, h: r.height, size, ox: (r.width - size) / 2, oy: (r.height - size) / 2, gap: size * 0.03 };
  B.cell = (size - B.gap * (SIZE + 1)) / SIZE;
}

const TILE_STYLE = {
  2: ['#f8ecd9', '#6d5f52'], 4: ['#f3e0b9', '#6d5f52'],
  8: ['#ffb26b', '#ffffff'], 16: ['#ff9350', '#ffffff'],
  32: ['#ff7a5c', '#ffffff'], 64: ['#ff5c42', '#ffffff'],
  128: ['#ffd93b', '#7a5c00'], 256: ['#ffcd1e', '#7a5c00'],
  512: ['#f7c000', '#ffffff'], 1024: ['#f2b711', '#ffffff'],
  2048: ['#efa900', '#ffffff'],
};
function tileStyle(v) { return TILE_STYLE[v] || ['#8b5cf6', '#ffffff']; }

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function cellXY(x, y) {
  return [B.ox + B.gap + x * (B.cell + B.gap), B.oy + B.gap + y * (B.cell + B.gap)];
}

function drawTile(px, py, v, scale = 1) {
  const [bg, fg] = tileStyle(v);
  const s = B.cell * scale;
  const off = (B.cell - s) / 2;
  roundRect(ctx, px + off, py + off, s, s, s * 0.12);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  const digits = String(v).length;
  ctx.font = `700 ${s * (digits <= 2 ? 0.45 : digits === 3 ? 0.38 : 0.3)}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(v, px + B.cell / 2, py + B.cell / 2 + s * 0.02);
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, B.w, B.h);

  // frame + empty cells
  ctx.fillStyle = '#cfc0ae';
  roundRect(ctx, B.ox, B.oy, B.size, B.size, B.size * 0.03);
  ctx.fill();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [px, py] = cellXY(x, y);
      roundRect(ctx, px, py, B.cell, B.cell, B.cell * 0.12);
      ctx.fillStyle = '#e2d5c1';
      ctx.fill();
    }
  }

  if (animating) {
    for (const s of slides) {
      const k = Math.min(1, s.t / SLIDE_MS);
      const e = 1 - Math.pow(1 - k, 3);
      const [fx, fy] = cellXY(s.fx, s.fy);
      const [tx, ty] = cellXY(s.tx, s.ty);
      drawTile(fx + (tx - fx) * e, fy + (ty - fy) * e, s.val);
    }
  } else {
    const popping = new Map(pops.map(p => [p.i, p.t]));
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i]) continue;
      const [px, py] = cellXY(i % SIZE, (i / SIZE) | 0);
      const pt = popping.get(i);
      let scale = 1;
      if (pt !== undefined) {
        const k = Math.min(1, pt / POP_MS);
        scale = 0.35 + 0.75 * k - 0.1 * Math.sin(k * Math.PI); // grow with a little overshoot
      }
      drawTile(px, py, grid[i], scale);
    }
  }
}

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (document.hidden) return;
  for (const s of slides) s.t += dt;
  for (const p of pops) p.t += dt;
  pops = pops.filter(p => p.t < POP_MS);
  draw();
}

// ---------------- Boot ----------------
layout();
if (!loadState()) newGame();
updateHud();
updateBestsHud();
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });
