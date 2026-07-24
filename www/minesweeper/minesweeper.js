/* Minesweeper — tap to dig, hold to flag */
'use strict';

const BEST_KEY = 'minesweeper.best.v1';
const POP_MS = 160;        // reveal pop animation
const FLOOD_STAGGER = 26;  // ms per ring when a zero floods open
const HOLD_MS = 350;       // long-press to flag

const DIFFS = {
  easy:   { label: 'Easy',   cols: 8,  rows: 10, mines: 10 },
  medium: { label: 'Medium', cols: 10, rows: 14, mines: 24 },
  hard:   { label: 'Hard',   cols: 12, rows: 17, mines: 40 },
};

// ---------------- Best times ----------------
function loadBests() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY)) || {}; } catch { return {}; }
}
function reportTime(diffKey, secs) {
  const b = loadBests();
  if (b[diffKey] == null || secs < b[diffKey]) {
    b[diffKey] = secs;
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
    return true;
  }
  return false;
}
function fmtTime(secs) {
  if (secs >= 60) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
  return secs + 's';
}
function updateDiffButtons() {
  const b = loadBests();
  for (const [key, id] of [['easy', 'bestEasy'], ['medium', 'bestMedium'], ['hard', 'bestHard']]) {
    const d = DIFFS[key];
    document.getElementById(id).textContent =
      `${d.cols}×${d.rows}, ${d.mines} mines` + (b[key] != null ? ` — best ${fmtTime(b[key])}` : '');
  }
}

// ---------------- State ----------------
let diffKey = 'easy';
let D = DIFFS.easy;
let mine = [];     // true if cell has a mine
let adj = [];      // adjacent mine count
let cell = [];     // 0 hidden, 1 revealed, 2 flagged
let started = false;   // mines placed (first tap happened)
let over = false;
let win = false;
let boomAt = -1;       // the mine that was tapped
let flagMode = false;
let flags = 0;
let revealed = 0;
let timeMs = 0;
let pops = new Map();  // index -> t (negative = flood stagger delay)

function neighbors(i) {
  const x = i % D.cols, y = (i / D.cols) | 0;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < D.cols && ny >= 0 && ny < D.rows) out.push(ny * D.cols + nx);
    }
  }
  return out;
}

function newGame(key) {
  if (key) { diffKey = key; D = DIFFS[key]; }
  const n = D.cols * D.rows;
  mine = new Array(n).fill(false);
  adj = new Array(n).fill(0);
  cell = new Array(n).fill(0);
  started = false;
  over = false;
  win = false;
  boomAt = -1;
  flags = 0;
  revealed = 0;
  timeMs = 0;
  pops = new Map();
  document.getElementById('endOverlay').classList.remove('active');
  layout();
  updateHud();
}

// first tap and its whole 3×3 neighborhood are always safe, so every game opens with a clearing
function placeMines(safe) {
  const banned = new Set([safe, ...neighbors(safe)]);
  const spots = [];
  for (let i = 0; i < mine.length; i++) if (!banned.has(i)) spots.push(i);
  for (let m = 0; m < D.mines; m++) {
    const k = m + Math.floor(Math.random() * (spots.length - m));
    [spots[m], spots[k]] = [spots[k], spots[m]];
    mine[spots[m]] = true;
  }
  for (let i = 0; i < mine.length; i++) {
    if (!mine[i]) for (const nb of neighbors(i)) if (mine[nb]) adj[i]++;
  }
  started = true;
}

// ---------------- Actions ----------------
function reveal(i) {
  if (over || cell[i] === 2) return;
  if (!started) placeMines(i);
  if (cell[i] === 1) return;
  if (mine[i]) return explode(i);

  // BFS flood: zeros open their neighbors, staggered by ring for a ripple effect
  const queue = [[i, 0]];
  while (queue.length) {
    const [c, depth] = queue.shift();
    if (cell[c] !== 0) continue;
    cell[c] = 1;
    revealed++;
    pops.set(c, -depth * FLOOD_STAGGER);
    if (adj[c] === 0) for (const nb of neighbors(c)) queue.push([nb, depth + 1]);
  }
  updateHud();
  if (revealed === mine.length - D.mines) finish(true);
}

function toggleFlag(i) {
  if (over || cell[i] === 1) return;
  if (cell[i] === 2) { cell[i] = 0; flags--; }
  else { cell[i] = 2; flags++; }
  if (navigator.vibrate) navigator.vibrate(25);
  updateHud();
}

// tap a satisfied number to open its remaining neighbors
function chord(i) {
  let f = 0;
  for (const nb of neighbors(i)) if (cell[nb] === 2) f++;
  if (f !== adj[i]) return;
  for (const nb of neighbors(i)) {
    if (cell[nb] === 0) { reveal(nb); if (over) return; }
  }
}

function tap(i) {
  if (over) return;
  if (cell[i] === 1) { if (adj[i] > 0) chord(i); return; }
  if (flagMode) toggleFlag(i);
  else reveal(i);
}

function explode(i) {
  boomAt = i;
  cell[i] = 1;
  if (navigator.vibrate) navigator.vibrate([60, 40, 80]);
  finish(false);
}

function finish(didWin) {
  over = true;
  win = didWin;
  const secs = Math.floor(timeMs / 1000);
  if (didWin) {
    for (let i = 0; i < mine.length; i++) if (mine[i]) cell[i] = 2; // auto-flag the rest
    flags = D.mines;
    updateHud();
    const record = reportTime(diffKey, secs);
    document.getElementById('endTitle').textContent = '🎉 You win!';
    document.getElementById('endText').textContent =
      `${DIFFS[diffKey].label} cleared in ${fmtTime(secs)}`;
    document.getElementById('recordNote').textContent = record ? '🏆 New best time!' : '';
    updateDiffButtons();
  } else {
    document.getElementById('endTitle').textContent = '💥 Boom!';
    document.getElementById('endText').textContent = 'You hit a mine. Better luck next time!';
    document.getElementById('recordNote').textContent = '';
  }
  setTimeout(() => document.getElementById('endOverlay').classList.add('active'), didWin ? 500 : 1100);
}

function updateHud() {
  document.getElementById('hudMines').textContent = Math.max(0, D.mines - flags);
  document.getElementById('hudTime').textContent = Math.min(999, Math.floor(timeMs / 1000));
}

// ---------------- Buttons ----------------
document.getElementById('newBtn').onclick = () => newGame();
document.getElementById('againBtn').onclick = () => newGame();
document.getElementById('changeDiffBtn').onclick = () => {
  document.getElementById('endOverlay').classList.remove('active');
  updateDiffButtons();
  document.getElementById('diffOverlay').classList.add('active');
};
document.getElementById('flagBtn').onclick = () => {
  flagMode = !flagMode;
  document.getElementById('flagBtn').classList.toggle('toggled', flagMode);
};
for (const btn of document.querySelectorAll('#diffOverlay [data-diff]')) {
  btn.onclick = () => {
    document.getElementById('diffOverlay').classList.remove('active');
    newGame(btn.dataset.diff);
  };
}

// ---------------- Input ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
let press = null; // {x, y, i, timer, fired}

function cellAt(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left - B.ox) / B.cell);
  const y = Math.floor((e.clientY - r.top - B.oy) / B.cell);
  if (x < 0 || x >= D.cols || y < 0 || y >= D.rows) return -1;
  return y * D.cols + x;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // right-click flags via contextmenu only
  const i = cellAt(e);
  if (i < 0) return;
  press = { x: e.clientX, y: e.clientY, i, fired: false };
  press.timer = setTimeout(() => {
    if (!press) return;
    press.fired = true;
    if (cell[press.i] !== 1) toggleFlag(press.i);
  }, HOLD_MS);
});
canvas.addEventListener('pointermove', (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) {
    clearTimeout(press.timer);
    press = null;
  }
});
function endPress(e, doTap) {
  if (!press) return;
  clearTimeout(press.timer);
  if (doTap && !press.fired) tap(press.i);
  press = null;
}
canvas.addEventListener('pointerup', (e) => endPress(e, true));
canvas.addEventListener('pointercancel', (e) => endPress(e, false));
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault(); // desktop testing: right-click flags
  if (press && press.fired) return; // Android long-press already flagged via the hold timer
  const i = cellAt(e);
  if (i >= 0 && cell[i] !== 1) toggleFlag(i);
});

// ---------------- Render ----------------
const ctx = canvas.getContext('2d');
let dpr = 1, B = null; // {ox, oy, cell, w, h}

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const c = Math.floor(Math.min((r.width - 16) / D.cols, (r.height - 16) / D.rows));
  B = {
    w: r.width, h: r.height, cell: c,
    ox: (r.width - c * D.cols) / 2,
    oy: (r.height - c * D.rows) / 2,
  };
}

const HIDDEN = ['#8fd14f', '#7fc93e'];   // grass checkerboard
const OPEN = ['#f0e3c0', '#e7d7ae'];     // dirt checkerboard
const NUM_COLORS = [null, '#3b6fd4', '#3d8f43', '#d63b3b', '#7c3aad', '#c96a1e', '#2a9d9f', '#3a3a55', '#8b90a8'];

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, B.w, B.h);
  const c = B.cell;

  ctx.save();
  roundRect(ctx, B.ox, B.oy, c * D.cols, c * D.rows, c * 0.25);
  ctx.clip();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let y = 0; y < D.rows; y++) {
    for (let x = 0; x < D.cols; x++) {
      const i = y * D.cols + x;
      const px = B.ox + x * c, py = B.oy + y * c;
      const check = (x + y) % 2;
      const pt = pops.get(i);
      const stillHidden = cell[i] !== 1 || (pt !== undefined && pt < 0);

      if (stillHidden) {
        ctx.fillStyle = HIDDEN[check];
        ctx.fillRect(px, py, c, c);
        if (cell[i] === 2) {
          ctx.font = `${c * 0.62}px serif`;
          ctx.fillText('🚩', px + c / 2, py + c * 0.56);
          // after a loss, cross out flags that were wrong
          if (over && !win && !mine[i]) {
            ctx.strokeStyle = '#d63b3b';
            ctx.lineWidth = c * 0.09;
            ctx.beginPath();
            ctx.moveTo(px + c * 0.2, py + c * 0.2); ctx.lineTo(px + c * 0.8, py + c * 0.8);
            ctx.moveTo(px + c * 0.8, py + c * 0.2); ctx.lineTo(px + c * 0.2, py + c * 0.8);
            ctx.stroke();
          }
        } else if (over && !win && mine[i]) {
          ctx.font = `${c * 0.58}px serif`;
          ctx.fillText('💣', px + c / 2, py + c * 0.55);
        }
      } else {
        ctx.fillStyle = OPEN[check];
        ctx.fillRect(px, py, c, c);
        let scale = 1;
        if (pt !== undefined && pt < POP_MS) {
          const k = pt / POP_MS;
          scale = 0.4 + 0.7 * k - 0.1 * Math.sin(k * Math.PI);
        }
        if (mine[i]) {
          if (i === boomAt) {
            ctx.fillStyle = '#ff6b5c';
            ctx.fillRect(px, py, c, c);
          }
          ctx.font = `${c * 0.58 * scale}px serif`;
          ctx.fillText('💣', px + c / 2, py + c * 0.55);
        } else if (adj[i] > 0) {
          ctx.fillStyle = NUM_COLORS[adj[i]];
          ctx.font = `800 ${c * 0.52 * scale}px 'Segoe UI', sans-serif`;
          ctx.fillText(adj[i], px + c / 2, py + c * 0.54);
        }
      }
    }
  }
  ctx.restore();
}

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (document.hidden) return;
  if (started && !over) { timeMs += dt; updateHud(); }
  for (const [i, pt] of pops) {
    if (pt >= POP_MS) pops.delete(i);
    else pops.set(i, pt + dt);
  }
  draw();
}

// ---------------- Boot ----------------
newGame('easy');
updateDiffButtons();
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
