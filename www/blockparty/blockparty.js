/* Block Party — drag 3 pieces onto an 8×8 grid, clear rows & columns */
'use strict';

const N = 8;
const STATE_KEY = 'blockparty.state.v1';
const SCORE_KEY = 'blockparty.scores.v1';
// one-time migration from the game's original "blockblast" name
for (const [oldK, newK] of [['blockblast.state.v1', STATE_KEY], ['blockblast.scores.v1', SCORE_KEY]]) {
  const v = localStorage.getItem(oldK);
  if (v != null && localStorage.getItem(newK) == null) localStorage.setItem(newK, v);
  localStorage.removeItem(oldK);
}
const CLEAR_MS = 240;   // cell shrink animation on line clear
const POPUP_MS = 850;   // floating score text
const LIFT = 70;        // dragged piece floats above the finger

// simultaneous-line bonus, multiplied by the combo streak
const LINE_BONUS = [0, 10, 20, 60, 120, 200, 300];
const ALL_CLEAR_BONUS = 360;

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
  document.getElementById('hudBests').textContent = `${s.daily.score} / ${s.weekly.score} / ${s.allTime}`;
}

// ---------------- Pieces ----------------
// '#' = cell, rows separated by '/'. No rotation in play — orientations are separate shapes.
const SHAPE_DEFS = [
  ['#', 1],
  ['##', 3], ['#/#', 3],
  ['###', 3], ['#/#/#', 3],
  ['####', 2], ['#/#/#/#', 2],
  ['#####', 1], ['#/#/#/#/#', 1],
  ['##/##', 3],
  ['###/###', 2], ['##/##/##', 2],
  ['###/###/###', 1],
  // corner trominoes
  ['##/#.', 2], ['##/.#', 2], ['#./##', 2], ['.#/##', 2],
  // tetromino T
  ['###/.#.', 1], ['.#./###', 1], ['#./##/#.', 1], ['.#/##/.#', 1],
  // tetromino S / Z
  ['.##/##.', 1], ['##./.##', 1], ['#./##/.#', 1], ['.#/##/#.', 1],
  // tetromino L / J
  ['#./#./##', 1], ['.#/.#/##', 1], ['##/#./#.', 1], ['##/.#/.#', 1],
  ['###/#..', 1], ['###/..#', 1], ['#../###', 1], ['..#/###', 1],
  // big 3×3 corners
  ['#../#../###', 1], ['..#/..#/###', 1], ['###/#../#..', 1], ['###/..#/..#', 1],
];
const SHAPES = SHAPE_DEFS.map(([str, weight]) => {
  const rows = str.split('/');
  const cells = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') cells.push([x, y]); }));
  return { cells, w: Math.max(...rows.map(r => r.length)), h: rows.length, weight };
});
const TOTAL_WEIGHT = SHAPES.reduce((a, s) => a + s.weight, 0);
const COLORS = ['#ef476f', '#f78c1e', '#ffd166', '#06d6a0', '#4cc9f0', '#9b5de5'];

function randomPiece() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const s of SHAPES) {
    r -= s.weight;
    if (r <= 0) return { cells: s.cells, w: s.w, h: s.h, color: Math.floor(Math.random() * COLORS.length) };
  }
  return { ...SHAPES[0], color: 0 };
}

// ---------------- State ----------------
let board = new Array(N * N).fill(0);   // 0 empty, else color index + 1
let tray = [null, null, null];
let score = 0;
let combo = 0;
let over = false;
let clears = [];   // {x, y, color, t} shrink animation
let popups = [];   // {x, y, txt, color, t} floating text

function saveState() {
  if (over) return;
  localStorage.setItem(STATE_KEY, JSON.stringify({ board, tray, score, combo }));
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (s && Array.isArray(s.board) && s.board.length === N * N && Array.isArray(s.tray) &&
        s.tray.some(p => p) && s.tray.every(p => !p || (Array.isArray(p.cells) && p.cells.length))) {
      board = s.board.map(Number);
      tray = s.tray;
      score = s.score || 0;
      combo = s.combo || 0;
      return true;
    }
  } catch { }
  return false;
}

function newGame() {
  board.fill(0);
  tray = [randomPiece(), randomPiece(), randomPiece()];
  score = 0;
  combo = 0;
  over = false;
  clears = [];
  popups = [];
  updateFits();
  updateHud();
  saveState();
  document.getElementById('overOverlay').classList.remove('active');
}

// ---------------- Placement ----------------
function canPlaceAt(piece, gx, gy) {
  for (const [dx, dy] of piece.cells) {
    const x = gx + dx, y = gy + dy;
    if (x < 0 || x >= N || y < 0 || y >= N || board[y * N + x]) return false;
  }
  return true;
}
function anyFit(piece) {
  for (let y = 0; y <= N - piece.h; y++)
    for (let x = 0; x <= N - piece.w; x++)
      if (canPlaceAt(piece, x, y)) return true;
  return false;
}
// unplayable tray pieces render grey; recheck whenever the board or tray changes
function updateFits() {
  for (const p of tray) if (p) p.stuck = !anyFit(p);
}

function place(slot, gx, gy) {
  const piece = tray[slot];
  for (const [dx, dy] of piece.cells) board[(gy + dy) * N + (gx + dx)] = piece.color + 1;
  tray[slot] = null;
  score += piece.cells.length;

  // full rows / columns clear together
  const fullRows = [], fullCols = [];
  for (let y = 0; y < N; y++) if (board.slice(y * N, y * N + N).every(v => v)) fullRows.push(y);
  for (let x = 0; x < N; x++) {
    let full = true;
    for (let y = 0; y < N; y++) if (!board[y * N + x]) { full = false; break; }
    if (full) fullCols.push(x);
  }
  const lines = fullRows.length + fullCols.length;

  if (lines > 0) {
    combo++;
    const gained = LINE_BONUS[Math.min(lines, 6)] * combo;
    score += gained;
    const cleared = new Set();
    for (const y of fullRows) for (let x = 0; x < N; x++) cleared.add(y * N + x);
    for (const x of fullCols) for (let y = 0; y < N; y++) cleared.add(y * N + x);
    for (const i of cleared) {
      clears.push({ x: i % N, y: (i / N) | 0, color: board[i] - 1, t: 0 });
      board[i] = 0;
    }
    const cx = B.ox + ((fullCols.length ? fullCols.reduce((a, b) => a + b, 0) / fullCols.length + 0.5 : N / 2)) * B.cell;
    const cy = B.oy + ((fullRows.length ? fullRows.reduce((a, b) => a + b, 0) / fullRows.length + 0.5 : N / 2)) * B.cell;
    popups.push({ x: cx, y: cy, txt: '+' + gained, color: '#fff', t: 0 });
    if (combo > 1) popups.push({ x: cx, y: cy + 26, txt: 'Combo ×' + combo, color: '#ffd166', t: 0 });
    if (board.every(v => !v)) {
      score += ALL_CLEAR_BONUS;
      popups.push({ x: B.ox + N * B.cell / 2, y: B.oy + N * B.cell / 2, txt: '✨ ALL CLEAR +' + ALL_CLEAR_BONUS, color: '#4cc9f0', t: 0 });
    }
    if (navigator.vibrate) navigator.vibrate(lines > 1 ? [30, 30, 40] : 25);
  } else {
    combo = 0;
  }

  if (tray.every(p => !p)) tray = [randomPiece(), randomPiece(), randomPiece()];
  updateFits();
  updateHud();
  reportScore(score);
  updateBestsHud();
  if (!tray.some(p => p && anyFit(p))) endGame();
  else saveState();
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
  setTimeout(() => document.getElementById('overOverlay').classList.add('active'), 500);
}

function updateHud() {
  document.getElementById('hudScore').textContent = score;
}

document.getElementById('newBtn').onclick = () => newGame();
document.getElementById('restartBtn').onclick = () => newGame();

// ---------------- Layout & render ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, B = null; // {ox, oy, cell, size, trayY, trayH, w, h}

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const size = Math.min(r.width - 16, (r.height - 20) / 1.34);
  const cell = size / N;
  B = {
    w: r.width, h: r.height, size, cell,
    ox: (r.width - size) / 2,
    oy: 8,
    trayY: 8 + size + 6,
    trayH: size * 0.34 - 6,
  };
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawBlock(px, py, s, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  roundRect(ctx, px + s * 0.05, py + s * 0.05, s * 0.9, s * 0.9, s * 0.18);
  ctx.fillStyle = color;
  ctx.fill();
  // glossy top edge
  roundRect(ctx, px + s * 0.12, py + s * 0.1, s * 0.76, s * 0.3, s * 0.12);
  ctx.fillStyle = '#ffffff38';
  ctx.fill();
  ctx.globalAlpha = 1;
}

function trayCenter(i) {
  return [B.ox + B.size * (i + 0.5) / 3, B.trayY + B.trayH / 2];
}

// dragged piece top-left in canvas coords (centered under the lifted point)
function dragTopLeft() {
  return [drag.x - drag.piece.w * B.cell / 2, drag.y - LIFT - drag.piece.h * B.cell / 2];
}
function dragGrid() {
  const [px, py] = dragTopLeft();
  return [Math.round((px - B.ox) / B.cell), Math.round((py - B.oy) / B.cell)];
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, B.w, B.h);
  const c = B.cell;

  // board panel
  roundRect(ctx, B.ox - 6, B.oy - 6, B.size + 12, B.size + 12, 16);
  ctx.fillStyle = '#27356b';
  ctx.fill();

  // ghost preview: cells this drop would occupy + lines it would finish
  let ghost = null, ghostLines = null;
  if (drag) {
    const [gx, gy] = dragGrid();
    if (canPlaceAt(drag.piece, gx, gy)) {
      ghost = new Set(drag.piece.cells.map(([dx, dy]) => (gy + dy) * N + (gx + dx)));
      ghostLines = new Set();
      for (let y = 0; y < N; y++) {
        let full = true;
        for (let x = 0; x < N; x++) if (!board[y * N + x] && !ghost.has(y * N + x)) { full = false; break; }
        if (full) for (let x = 0; x < N; x++) ghostLines.add(y * N + x);
      }
      for (let x = 0; x < N; x++) {
        let full = true;
        for (let y = 0; y < N; y++) if (!board[y * N + x] && !ghost.has(y * N + x)) { full = false; break; }
        if (full) for (let y = 0; y < N; y++) ghostLines.add(y * N + x);
      }
    }
  }

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const px = B.ox + x * c, py = B.oy + y * c;
      if (board[i]) {
        drawBlock(px, py, c, COLORS[board[i] - 1]);
        if (ghostLines && ghostLines.has(i)) {
          roundRect(ctx, px + c * 0.05, py + c * 0.05, c * 0.9, c * 0.9, c * 0.18);
          ctx.fillStyle = '#ffffff55';
          ctx.fill();
        }
      } else {
        roundRect(ctx, px + c * 0.06, py + c * 0.06, c * 0.88, c * 0.88, c * 0.15);
        ctx.fillStyle = ghost && ghost.has(i) ? COLORS[drag.piece.color] + '88' : '#33427f';
        ctx.fill();
      }
    }
  }

  // clearing cells shrink away
  for (const cl of clears) {
    const k = 1 - cl.t / CLEAR_MS;
    if (k <= 0) continue;
    const s = c * k;
    drawBlock(B.ox + cl.x * c + (c - s) / 2, B.oy + cl.y * c + (c - s) / 2, s, COLORS[cl.color], k);
  }

  // tray
  for (let i = 0; i < 3; i++) {
    const piece = tray[i];
    if (!piece || (drag && drag.slot === i)) continue;
    const ps = c * 0.55;
    const [tcx, tcy] = trayCenter(i);
    const px0 = tcx - piece.w * ps / 2, py0 = tcy - piece.h * ps / 2;
    const color = piece.stuck ? '#5c6584' : COLORS[piece.color];
    for (const [dx, dy] of piece.cells) drawBlock(px0 + dx * ps, py0 + dy * ps, ps, color, piece.stuck ? 0.8 : 1);
  }

  // dragged piece at full size
  if (drag) {
    const [px0, py0] = dragTopLeft();
    for (const [dx, dy] of drag.piece.cells) drawBlock(px0 + dx * c, py0 + dy * c, c, COLORS[drag.piece.color], 0.92);
  }

  // floating score text
  for (const p of popups) {
    const k = p.t / POPUP_MS;
    ctx.globalAlpha = 1 - k * k;
    ctx.fillStyle = p.color;
    ctx.font = `800 ${Math.max(18, c * 0.5)}px 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#0007';
    ctx.lineWidth = 4;
    ctx.strokeText(p.txt, p.x, p.y - k * 40);
    ctx.fillText(p.txt, p.x, p.y - k * 40);
    ctx.globalAlpha = 1;
  }
}

// ---------------- Input ----------------
let drag = null; // {slot, piece, x, y}

canvas.addEventListener('pointerdown', (e) => {
  if (over || drag) return;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (y < B.trayY - 10) return;
  for (let i = 0; i < 3; i++) {
    if (!tray[i]) continue;
    const [tcx] = trayCenter(i);
    if (Math.abs(x - tcx) < B.size / 6) {
      drag = { slot: i, piece: tray[i], x, y };
      canvas.setPointerCapture(e.pointerId);
      break;
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = canvas.getBoundingClientRect();
  drag.x = e.clientX - r.left;
  drag.y = e.clientY - r.top;
});
canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  const [gx, gy] = dragGrid();
  const d = drag;
  drag = null;
  if (canPlaceAt(d.piece, gx, gy)) place(d.slot, gx, gy);
});
canvas.addEventListener('pointercancel', () => { drag = null; });

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (document.hidden) return;
  for (const cl of clears) cl.t += dt;
  clears = clears.filter(cl => cl.t < CLEAR_MS);
  for (const p of popups) p.t += dt;
  popups = popups.filter(p => p.t < POPUP_MS);
  draw();
}

// ---------------- Boot ----------------
layout();
if (!loadState()) newGame();
else {
  updateFits();
  if (!tray.some(p => p && !p.stuck)) endGame(); // resumed into a dead position
}
updateHud();
updateBestsHud();
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });
