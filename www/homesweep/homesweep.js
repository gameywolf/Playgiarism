/* Home Sweep Home — Homescapes-style match-3 (puzzle only, no decorating).
   Swap adjacent pieces to match 3+. Special shapes make boosters:
     4 in a line  -> rocket (clears the perpendicular line)
     2x2 square   -> paper plane (clears a cross, flies to a useful target)
     L / T shape  -> bomb (round blast)
     5 in a line  -> disco ball (clears a whole colour)
   Boosters combine when swapped into each other. Obstacles: donuts (one
   adjacent match), crates (two hits), bubbles (trap a piece), grass (spreads
   through matches made on it). Levels are seeded so level N is always the
   same puzzle; only refill pieces are random. */
'use strict';

const COLS = 9, ROWS = 9;
const STATE_KEY = 'homesweep.state.v1';

const SWAP_MS = 150;
const POP_MS = 200;
const CHAIN_MS = 120;     // delay before a booster hit by a blast fires
const ROCKET_STEP = 24;   // ms per cell along a rocket's line
const BOMB_STEP = 36;     // ms per ring of a bomb blast
const DISCO_STEP = 40;    // ms between pieces in a colour clear
const FALL_STEP = 64;     // ms per cell of falling
const PLANE_MS = 520;

const PALETTE = [
  { main: '#e8384f', dark: '#a81f33', light: '#ff97a5' }, // red
  { main: '#ffc93d', dark: '#c28f12', light: '#ffe9a8' }, // yellow
  { main: '#43bd63', dark: '#25813e', light: '#a4e8b4' }, // green
  { main: '#4d9be8', dark: '#2a68ab', light: '#a9d1ff' }, // blue
  { main: '#a05ff0', dark: '#6c35b3', light: '#d4b3ff' }, // purple
];
const OBJ_ICON = { donut: '🍩', crate: '📦', bubble: '🫧', grass: '🌿' };

// deterministic RNG so a level is always the same puzzle
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- State ----------------
let level = 1;
let mask = [];        // true = playable cell
let topCell = [];     // per column: topmost playable cell index (spawn point), -1 if none
let grid = [];        // per cell: {piece, block, bubble, grass} or null outside mask
let numColors = 5;
let moves = 0;
let objectives = [];  // {type:'color'|'donut'|'crate'|'bubble'|'grass', color?, need, got}
let grassCount = 0;

let phase = 'idle';   // idle | swap | wave | fall | shuffle | end
let swapAnim = null;  // {a, b, t, back}
let wave = null;      // {t, last, tasks:[{time,fn,done}], planes:[], damaged:Set, claimed:Set}
let falling = null;   // {tracks:[[piece, path]], t}
let shuffleT = -1;
let sel = -1;
let drag = null;
let effects = [];
let confetti = [];

const idx = (r, c) => r * COLS + c;
const rowOf = i => Math.floor(i / COLS);
const colOf = i => i % COLS;
const inBoard = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const cellAtRC = (r, c) => (inBoard(r, c) && mask[idx(r, c)]) ? grid[idx(r, c)] : null;
const isBooster = p => p && p.t !== 'c';

function orthNeighbors(i) {
  const r = rowOf(i), c = colOf(i), out = [];
  if (inBoard(r - 1, c) && mask[idx(r - 1, c)]) out.push(idx(r - 1, c));
  if (inBoard(r + 1, c) && mask[idx(r + 1, c)]) out.push(idx(r + 1, c));
  if (inBoard(r, c - 1) && mask[idx(r, c - 1)]) out.push(idx(r, c - 1));
  if (inBoard(r, c + 1) && mask[idx(r, c + 1)]) out.push(idx(r, c + 1));
  return out;
}

// ---------------- Persistence ----------------
function save() { localStorage.setItem(STATE_KEY, JSON.stringify({ level })); }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (s && s.level >= 1) level = Math.floor(s.level);
  } catch { }
}

// ---------------- Level generation ----------------
function buildMask(lvl, rnd) {
  const m = new Array(ROWS * COLS).fill(true);
  const cut = (r, c) => { if (inBoard(r, c)) m[idx(r, c)] = false; };
  const fam = lvl <= 2 ? 0 : Math.floor(rnd() * 5);
  if (fam === 1) {              // clipped corners
    const k = 1 + Math.floor(rnd() * 2);
    for (let d = 0; d < k; d++) for (let e = 0; e + d < k; e++) {
      cut(d, e); cut(d, COLS - 1 - e); cut(ROWS - 1 - d, e); cut(ROWS - 1 - d, COLS - 1 - e);
    }
  } else if (fam === 2) {       // diamond
    const k = 3;
    for (let d = 0; d < k; d++) for (let e = 0; e + d < k; e++) {
      cut(d, e); cut(d, COLS - 1 - e); cut(ROWS - 1 - d, e); cut(ROWS - 1 - d, COLS - 1 - e);
    }
  } else if (fam === 3) {       // side notches
    for (const r of [3, 4, 5]) { cut(r, 0); cut(r, COLS - 1); }
  } else if (fam === 4) {       // top + bottom notches
    for (const c of [3, 4, 5]) { cut(0, c); cut(ROWS - 1, c); }
  }
  return m;
}

function buildLevel(lvl) {
  const rnd = mulberry32(lvl * 48271 + 11);
  numColors = lvl < 4 ? 4 : 5;
  mask = buildMask(lvl, rnd);
  topCell = [];
  for (let c = 0; c < COLS; c++) {
    let t = -1;
    for (let r = 0; r < ROWS; r++) if (mask[idx(r, c)]) { t = idx(r, c); break; }
    topCell.push(t);
  }
  grid = mask.map(m => m ? { piece: null, block: null, bubble: false, grass: false } : null);
  objectives = [];
  grassCount = 0;

  const openCells = () => {
    const out = [];
    for (let i = 0; i < ROWS * COLS; i++)
      if (mask[i] && !grid[i].block && !grid[i].bubble && !grid[i].grass) out.push(i);
    return out;
  };
  const pickCells = (n, minRow) => {
    const pool = openCells().filter(i => rowOf(i) >= minRow);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  };

  // pick up to two unlocked obstacle types for this level
  const unlocked = [];
  if (lvl >= 2) unlocked.push('donut');
  if (lvl >= 4) unlocked.push('grass');
  if (lvl >= 6) unlocked.push('crate');
  if (lvl >= 8) unlocked.push('bubble');
  const types = [];
  if (unlocked.length) {
    const shuffled = unlocked.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    types.push(shuffled[0]);
    if (lvl >= 7 && shuffled.length > 1 && rnd() < 0.6) types.push(shuffled[1]);
  }

  for (const t of types) {
    if (t === 'donut') {
      const n = Math.min(4 + Math.floor(lvl / 2), 12);
      for (const i of pickCells(n, 2)) grid[i].block = { kind: 'donut', hp: 1 };
      objectives.push({ type: 'donut', need: n, got: 0 });
    } else if (t === 'crate') {
      const n = Math.min(3 + Math.floor(lvl / 3), 9);
      for (const i of pickCells(n, 2)) grid[i].block = { kind: 'crate', hp: 2 };
      objectives.push({ type: 'crate', need: n, got: 0 });
    } else if (t === 'bubble') {
      const n = Math.min(4 + Math.floor(lvl / 3), 10);
      for (const i of pickCells(n, 1)) grid[i].bubble = true;
      objectives.push({ type: 'bubble', need: n, got: 0 });
    } else if (t === 'grass') {
      const seeds = pickCells(3, 2);
      for (const i of seeds) { grid[i].grass = true; grassCount++; }
      const maskCount = mask.filter(Boolean).length;
      const need = Math.min(Math.floor(maskCount * 0.5), 16 + lvl, 36);
      objectives.push({ type: 'grass', need, got: grassCount });
    }
  }

  // colour-collect objectives
  const nColorObjs = objectives.length ? 1 : (lvl < 3 ? 1 : 2);
  const cols = [];
  while (cols.length < nColorObjs) {
    const c = Math.floor(rnd() * numColors);
    if (!cols.includes(c)) cols.push(c);
  }
  for (const c of cols)
    objectives.push({ type: 'color', color: c, need: 12 + Math.min(24, lvl), got: 0 });

  // move budget follows the objective load (rough per-item move costs + a buffer)
  let load = 4;
  for (const o of objectives) {
    if (o.type === 'color') load += o.need / 2.2;
    else if (o.type === 'donut') load += o.need * 0.9;
    else if (o.type === 'crate') load += o.need * 1.5;
    else if (o.type === 'bubble') load += o.need * 0.9;
    else if (o.type === 'grass') load += (o.need - o.got) * 0.5;
  }
  moves = Math.max(lvl < 6 ? 24 : 20, Math.min(42, Math.round(load)));

  // initial fill, seeded, no ready-made matches, at least one move available
  for (let attempt = 0; attempt < 40; attempt++) {
    fillInitial(rnd);
    if (anyMoveExists()) break;
  }
}

function fillInitial(rnd) {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = idx(r, c);
    if (!mask[i] || grid[i].block) continue;
    let color;
    for (let tries = 0; tries < 20; tries++) {
      color = Math.floor(rnd() * numColors);
      const same = (rr, cc) => {
        const cell = cellAtRC(rr, cc);
        return cell && cell.piece && cell.piece.t === 'c' && cell.piece.color === color;
      };
      if (same(r, c - 1) && same(r, c - 2)) continue;
      if (same(r - 1, c) && same(r - 2, c)) continue;
      if (same(r, c - 1) && same(r - 1, c) && same(r - 1, c - 1)) continue;
      break;
    }
    grid[i].piece = { t: 'c', color };
  }
}

function randomPiece() {
  return { t: 'c', color: Math.floor(Math.random() * numColors) };
}

// ---------------- Match finding ----------------
function colorAt(i) {
  if (i == null || !mask[i]) return -1;
  const g = grid[i];
  return (g.piece && g.piece.t === 'c' && !g.bubble && !g.block) ? g.piece.color : -1;
}

// groups: {cells:[i...], color, maxRun, maxRunDir, hasIntersect, hasSquare}
function findMatches() {
  const units = []; // {cells, kind:'h'|'v'|'sq', len}
  for (let r = 0; r < ROWS; r++) {
    let c = 0;
    while (c < COLS) {
      const col = colorAt(idx(r, c));
      if (col < 0) { c++; continue; }
      let e = c;
      while (e < COLS && colorAt(idx(r, e)) === col) e++;
      if (e - c >= 3) units.push({ cells: Array.from({ length: e - c }, (_, k) => idx(r, c + k)), kind: 'h', len: e - c });
      c = e;
    }
  }
  for (let c = 0; c < COLS; c++) {
    let r = 0;
    while (r < ROWS) {
      const col = colorAt(idx(r, c));
      if (col < 0) { r++; continue; }
      let e = r;
      while (e < ROWS && colorAt(idx(e, c)) === col) e++;
      if (e - r >= 3) units.push({ cells: Array.from({ length: e - r }, (_, k) => idx(r + k, c)), kind: 'v', len: e - r });
      r = e;
    }
  }
  for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS - 1; c++) {
    const col = colorAt(idx(r, c));
    if (col < 0) continue;
    if (colorAt(idx(r, c + 1)) === col && colorAt(idx(r + 1, c)) === col && colorAt(idx(r + 1, c + 1)) === col)
      units.push({ cells: [idx(r, c), idx(r, c + 1), idx(r + 1, c), idx(r + 1, c + 1)], kind: 'sq', len: 4 });
  }
  if (!units.length) return [];

  // union overlapping units into groups
  const groupOf = new Map(); // cell -> group
  const groups = [];
  for (const u of units) {
    let g = null;
    for (const cell of u.cells) if (groupOf.has(cell)) { g = groupOf.get(cell); break; }
    if (!g) { g = { cells: new Set(), units: [] }; groups.push(g); }
    // merge any other group this unit touches
    for (const cell of u.cells) {
      const other = groupOf.get(cell);
      if (other && other !== g) {
        for (const oc of other.cells) { g.cells.add(oc); groupOf.set(oc, g); }
        g.units.push(...other.units);
        other.dead = true;
      }
    }
    for (const cell of u.cells) { g.cells.add(cell); groupOf.set(cell, g); }
    g.units.push(u);
  }
  return groups.filter(g => !g.dead).map(g => {
    let maxRun = 0, maxRunDir = 'h', maxRunCells = null, hasSquare = false;
    const inH = new Set(), inV = new Set();
    for (const u of g.units) {
      if (u.kind === 'sq') hasSquare = true;
      else {
        for (const cell of u.cells) (u.kind === 'h' ? inH : inV).add(cell);
        if (u.len > maxRun) { maxRun = u.len; maxRunDir = u.kind; maxRunCells = u.cells; }
      }
    }
    let hasIntersect = false;
    for (const cell of inH) if (inV.has(cell)) { hasIntersect = true; break; }
    return {
      cells: [...g.cells], color: colorAt(g.units[0].cells[0]),
      maxRun, maxRunDir, maxRunCells, hasIntersect, hasSquare, inH, inV,
    };
  });
}

function boosterForGroup(g) {
  if (g.maxRun >= 5) return { t: 'ds' };
  if (g.hasIntersect) return { t: 'bm' };
  if (g.hasSquare) return { t: 'pl' };
  if (g.maxRun === 4) return { t: 'rk', dir: g.maxRunDir === 'h' ? 'v' : 'h' };
  return null;
}

function spawnCellForGroup(g, prefer) {
  for (const p of prefer) if (p >= 0 && g.cells.includes(p)) return p;
  if (g.hasIntersect) for (const cell of g.inH) if (g.inV.has(cell)) return cell;
  if (g.maxRunCells) return g.maxRunCells[Math.floor(g.maxRunCells.length / 2)];
  return g.cells[0];
}

// ---------------- Wave (clear/booster resolution) ----------------
function startWave() {
  if (!wave) {
    wave = { t: 0, last: 0, tasks: [], planes: [], damaged: new Set(), claimed: new Set() };
    phase = 'wave';
  }
  return wave;
}
function at(time, fn) {
  wave.tasks.push({ time, fn, done: false });
  if (time > wave.last) wave.last = time;
}

function notePieceCleared(piece) {
  if (!piece || piece.t !== 'c') return;
  for (const o of objectives)
    if (o.type === 'color' && o.color === piece.color && o.got < o.need) { o.got++; renderObjs(); }
}
function noteObstacle(type) {
  for (const o of objectives)
    if (o.type === type && o.got < o.need) { o.got++; renderObjs(); }
}

function popPiece(i) {
  const cell = grid[i];
  if (!cell || !cell.piece) return;
  fxPop(i, cell.piece);
  notePieceCleared(cell.piece);
  cell.piece = null;
}
function popBubble(i) {
  const cell = grid[i];
  if (!cell || !cell.bubble) return;
  cell.bubble = false;
  fxBubble(i);
  noteObstacle('bubble');
}
function damageBlock(i) {
  const cell = grid[i];
  if (!cell || !cell.block) return;
  cell.block.hp--;
  fxBlock(i, cell.block.kind);
  if (cell.block.hp <= 0) {
    noteObstacle(cell.block.kind);
    cell.block = null;
  }
}
function addGrass(i) {
  const cell = grid[i];
  if (!cell || cell.grass) return;
  cell.grass = true;
  grassCount++;
  for (const o of objectives) if (o.type === 'grass') { o.got = grassCount; renderObjs(); }
  fxGrass(i);
}

// Route a hit at cell i, scheduled at `time` into the current wave.
function clearCell(i, time) {
  if (i == null || !mask[i]) return;
  const cell = grid[i];
  if (cell.block) {
    if (!wave.damaged.has(i)) { wave.damaged.add(i); at(time, () => damageBlock(i)); }
    return;
  }
  if (cell.bubble) {
    if (!wave.claimed.has(i)) { wave.claimed.add(i); at(time, () => popBubble(i)); }
    return;
  }
  if (!cell.piece || wave.claimed.has(i)) return;
  wave.claimed.add(i);
  if (cell.piece.t === 'c') at(time, () => popPiece(i));
  else activateBooster(i, time + CHAIN_MS);
}

// caller must have claimed i already
function activateBooster(i, time) {
  const p = grid[i].piece;
  if (!p) return;
  at(time, () => { if (grid[i].piece === p) { grid[i].piece = null; fxPop(i, p); } });
  if (p.t === 'rk') fireRocket(i, p.dir, time);
  else if (p.t === 'bm') explodeBomb(i, time, 2);
  else if (p.t === 'pl') launchPlane(i, time, null);
  else if (p.t === 'ds') at(time, () => discoClear(i, mostCommonColor(), null));
}

function fireRocket(i, dir, time) {
  const r = rowOf(i), c = colOf(i);
  at(time, () => effects.push({ type: 'streak', r, c, dir, t: 0 }));
  if (dir === 'h') {
    for (let cc = 0; cc < COLS; cc++) if (cc !== c) clearCell(idx(r, cc), time + Math.abs(cc - c) * ROCKET_STEP);
  } else {
    for (let rr = 0; rr < ROWS; rr++) if (rr !== r) clearCell(idx(rr, c), time + Math.abs(rr - r) * ROCKET_STEP);
  }
}

function explodeBomb(i, time, radius) {
  const r = rowOf(i), c = colOf(i);
  const r2 = radius === 2 ? 5 : 11;   // 5x5 / 7x7 minus corners
  at(time, () => effects.push({ type: 'ring', r, c, radius, t: 0 }));
  for (let dr = -radius - 1; dr <= radius + 1; dr++) for (let dc = -radius - 1; dc <= radius + 1; dc++) {
    if (dr === 0 && dc === 0) continue;
    if (dr * dr + dc * dc > r2) continue;
    if (!inBoard(r + dr, c + dc)) continue;
    clearCell(idx(r + dr, c + dc), time + Math.sqrt(dr * dr + dc * dc) * BOMB_STEP);
  }
}

function pickPlaneTarget() {
  const blocks = [], grassy = [], wanted = [], any = [];
  const wantColors = objectives.filter(o => o.type === 'color' && o.got < o.need).map(o => o.color);
  const wantGrass = objectives.some(o => o.type === 'grass' && o.got < o.need);
  for (let i = 0; i < ROWS * COLS; i++) {
    if (!mask[i] || wave.claimed.has(i)) continue;
    const cell = grid[i];
    if (cell.block && !wave.damaged.has(i)) { blocks.push(i); continue; }
    if (cell.bubble) { blocks.push(i); continue; }
    if (!cell.piece) continue;
    any.push(i);
    if (wantGrass && !cell.grass) grassy.push(i);
    if (cell.piece.t === 'c' && wantColors.includes(cell.piece.color)) wanted.push(i);
  }
  const pool = blocks.length ? blocks : (wanted.length ? wanted : (grassy.length ? grassy : any));
  if (!pool.length) return -1;
  return pool[Math.floor(Math.random() * pool.length)];
}

function launchPlane(i, time, carried) {
  at(time, () => {
    for (const n of orthNeighbors(i)) clearCell(n, wave.t);
    const target = pickPlaneTarget();
    if (target < 0) return;
    const a = cellCenter(i), b = cellCenter(target);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    wave.planes.push({ x0: a.x, y0: a.y, target, t0: wave.t, dur: PLANE_MS + dist * 0.4, carried });
  });
}

function planeLand(pl) {
  const i = pl.target;
  const p = cellCenter(i);
  effects.push({ type: 'poof', x: p.x, y: p.y, t: 0 });
  if (pl.carried) {
    if (pl.carried.t === 'rk') { clearCell(i, wave.t); fireRocket(i, Math.random() < 0.5 ? 'h' : 'v', wave.t); }
    else if (pl.carried.t === 'bm') explodeBomb(i, wave.t, 2);
    else clearCell(i, wave.t);
  } else clearCell(i, wave.t);
}

function mostCommonColor() {
  const counts = new Array(numColors).fill(0);
  for (let i = 0; i < ROWS * COLS; i++) {
    const col = colorAt(i);
    if (col >= 0 && !wave.claimed.has(i)) counts[col]++;
  }
  let best = -1, n = 0;
  for (let c = 0; c < numColors; c++) if (counts[c] > n) { n = counts[c]; best = c; }
  return best;
}

// clear (or transform+fire) every plain piece of a colour; runs from wave.t
function discoClear(from, color, transformTo) {
  if (color < 0) return;
  const f = cellCenter(from);
  const cells = [];
  for (let i = 0; i < ROWS * COLS; i++)
    if (colorAt(i) === color && !wave.claimed.has(i)) cells.push(i);
  cells.sort(() => Math.random() - 0.5);
  effects.push({ type: 'discoflash', x: f.x, y: f.y, t: 0 });
  cells.forEach((i, k) => {
    const time = wave.t + 80 + k * DISCO_STEP;
    if (transformTo) {
      wave.claimed.add(i);
      at(time, () => {
        const cell = grid[i];
        if (!cell.piece || cell.piece.t !== 'c') return;
        cell.piece = transformTo.t === 'rk'
          ? { t: 'rk', dir: Math.random() < 0.5 ? 'h' : 'v' }
          : { ...transformTo };
        activateBooster(i, wave.t + 140);
      });
    } else clearCell(i, time);
  });
}

// match groups -> scheduled clears, booster spawns, grass spread, splash damage
function processGroups(groups, prefer) {
  startWave();
  const t0 = wave.t;
  for (const g of groups) {
    const spawn = boosterForGroup(g);
    const sCell = spawn ? spawnCellForGroup(g, prefer) : -1;
    if (g.cells.some(i => grid[i].grass))
      at(t0 + POP_MS, () => { for (const i of g.cells) addGrass(i); });
    for (const i of g.cells) {
      if (i === sCell) {
        wave.claimed.add(i);
        at(t0 + POP_MS * 0.5, () => {
          notePieceCleared(grid[i].piece);
          grid[i].piece = { ...spawn };
          fxSpawn(i);
        });
      } else clearCell(i, t0);
    }
    const hit = new Set();
    for (const i of g.cells) for (const n of orthNeighbors(i)) {
      if (hit.has(n) || g.cells.includes(n)) continue;
      const cell = grid[n];
      if (cell && (cell.block || cell.bubble)) { hit.add(n); clearCell(n, t0); }
    }
  }
}

// ---------------- Booster combos ----------------
function runCombo(a, b) {
  const pa = grid[a].piece, pb = grid[b].piece;
  startWave();
  wave.claimed.add(a); wave.claimed.add(b);
  const kinds = [pa.t, pb.t].sort().join('+');
  const consume = () => {
    if (grid[a].piece === pa) { grid[a].piece = null; fxPop(a, pa); }
    if (grid[b].piece === pb) { grid[b].piece = null; fxPop(b, pb); }
  };
  if (kinds === 'ds+ds') {
    at(0, () => {
      consume();
      const o = cellCenter(b);
      effects.push({ type: 'discoflash', x: o.x, y: o.y, t: 0 });
      for (let i = 0; i < ROWS * COLS; i++) {
        if (!mask[i]) continue;
        const d = Math.hypot(rowOf(i) - rowOf(b), colOf(i) - colOf(b));
        clearCell(i, wave.t + d * 45);
      }
    });
  } else if (pa.t === 'ds' || pb.t === 'ds') {
    const other = pa.t === 'ds' ? pb : pa;
    at(0, () => { consume(); discoClear(b, mostCommonColor(), { ...other }); });
  } else if (kinds === 'pl+pl') {
    at(0, () => { consume(); });
    launchPlane(b, 40, null); launchPlane(b, 120, null); launchPlane(b, 200, null);
  } else if (pa.t === 'pl' || pb.t === 'pl') {
    const other = pa.t === 'pl' ? pb : pa;
    at(0, () => { consume(); });
    launchPlane(b, 40, { ...other });
  } else if (kinds === 'rk+rk') {
    at(0, consume);
    fireRocket(b, 'h', 20); fireRocket(b, 'v', 20);
  } else if (kinds === 'bm+rk') {
    at(0, consume);
    const r = rowOf(b), c = colOf(b);
    for (let d = -1; d <= 1; d++) {
      if (r + d >= 0 && r + d < ROWS) fireRocket(idx(r + d, c), 'h', 20 + Math.abs(d) * 60);
      if (c + d >= 0 && c + d < COLS) fireRocket(idx(r, c + d), 'v', 20 + Math.abs(d) * 60);
    }
    clearCell(b, 20);
  } else { // bm+bm
    at(0, consume);
    explodeBomb(b, 20, 3);
  }
}

// ---------------- Gravity ----------------
function runGravity() {
  const tracked = new Map();  // piece -> path of {r,c}, path[k] = pos after step k
  const posOf = new Map();
  const ensure = (piece, r, c, step) => {
    if (!tracked.has(piece)) {
      const path = [];
      for (let k = 0; k <= step; k++) path.push({ r, c });
      tracked.set(piece, path);
    }
    posOf.set(piece, { r, c });
  };
  const isStatic = (r, c) => {
    if (!inBoard(r, c) || !mask[idx(r, c)]) return true;
    const cell = grid[idx(r, c)];
    return !!(cell.block || cell.bubble);
  };

  for (let s = 0; s < 64; s++) {
    let moved = false;
    const movedSet = new Set();
    // straight down (bottom-up so a whole column shifts together)
    for (let c = 0; c < COLS; c++) for (let r = ROWS - 2; r >= 0; r--) {
      const i = idx(r, c), j = idx(r + 1, c);
      if (!mask[i] || !mask[j]) continue;
      const cell = grid[i];
      if (!cell.piece || cell.block || cell.bubble || movedSet.has(cell.piece)) continue;
      const below = grid[j];
      if (below.piece || below.block || below.bubble) continue;
      ensure(cell.piece, r, c, s);
      below.piece = cell.piece; cell.piece = null;
      posOf.set(below.piece, { r: r + 1, c });
      movedSet.add(below.piece); moved = true;
    }
    // diagonal slide around blockers/holes
    for (let c = 0; c < COLS; c++) for (let r = ROWS - 2; r >= 0; r--) {
      const i = idx(r, c);
      if (!mask[i]) continue;
      const cell = grid[i];
      if (!cell.piece || cell.block || cell.bubble || movedSet.has(cell.piece)) continue;
      // can't fall straight (below is occupied, static, or off-board)…
      const br = r + 1;
      const belowFree = inBoard(br, c) && mask[idx(br, c)] && !grid[idx(br, c)].piece
        && !grid[idx(br, c)].block && !grid[idx(br, c)].bubble;
      if (belowFree || br >= ROWS) continue;
      const order = (r + c) % 2 ? [1, -1] : [-1, 1];
      for (const dc of order) {
        const tc = c + dc;
        if (!inBoard(r + 1, tc) || !mask[idx(r + 1, tc)]) continue;
        const t = idx(r + 1, tc);
        if (grid[t].piece || grid[t].block || grid[t].bubble) continue;
        if (!isStatic(r, tc)) continue;                      // target can be fed from above: let it
        ensure(cell.piece, r, c, s);
        grid[t].piece = cell.piece; cell.piece = null;
        posOf.set(grid[t].piece, { r: r + 1, c: tc });
        movedSet.add(grid[t].piece); moved = true;
        break;
      }
    }
    // refill from the top of each column
    for (let c = 0; c < COLS; c++) {
      const top = topCell[c];
      if (top < 0) continue;
      const cell = grid[top];
      if (cell.piece || cell.block || cell.bubble) continue;
      const piece = randomPiece();
      ensure(piece, rowOf(top) - 1, c, s);
      cell.piece = piece;
      posOf.set(piece, { r: rowOf(top), c });
      movedSet.add(piece); moved = true;
    }
    if (!moved) break;
    for (const [piece, path] of tracked) path.push({ ...posOf.get(piece) });
  }
  return tracked;
}

function startFall() {
  const tracked = runGravity();
  if (!tracked.size) { afterSettle(); return; }
  falling = { tracks: [...tracked.entries()], t: 0 };
  phase = 'fall';
}

function afterSettle() {
  falling = null;
  const groups = findMatches();
  if (groups.length) { processGroups(groups, [-1]); return; }
  renderHud();
  if (objectives.every(o => o.got >= o.need)) { winLevel(); return; }
  if (moves <= 0) { loseLevel(); return; }
  if (!anyMoveExists()) { shuffleT = 0; phase = 'shuffle'; return; }
  phase = 'idle';
}

// ---------------- Moves / shuffle ----------------
function swappable(i) {
  if (i < 0 || !mask[i]) return false;
  const cell = grid[i];
  return cell.piece && !cell.bubble && !cell.block;
}

function anyMoveExists() {
  for (let i = 0; i < ROWS * COLS; i++)
    if (mask[i] && grid[i].piece && isBooster(grid[i].piece)) return true;
  const pairs = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (c + 1 < COLS) pairs.push([idx(r, c), idx(r, c + 1)]);
    if (r + 1 < ROWS) pairs.push([idx(r, c), idx(r + 1, c)]);
  }
  for (const [a, b] of pairs) {
    if (!swappable(a) || !swappable(b)) continue;
    const A = grid[a].piece, B = grid[b].piece;
    if (A.color === B.color) continue;
    grid[a].piece = B; grid[b].piece = A;
    const hit = findMatches().length > 0;
    grid[a].piece = A; grid[b].piece = B;
    if (hit) return true;
  }
  return false;
}

function doShuffleScramble() {
  const cells = [];
  for (let i = 0; i < ROWS * COLS; i++)
    if (mask[i] && grid[i].piece && grid[i].piece.t === 'c' && !grid[i].bubble) cells.push(i);
  for (let attempt = 0; attempt < 30; attempt++) {
    const colors = cells.map(i => grid[i].piece.color);
    for (let k = colors.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [colors[k], colors[j]] = [colors[j], colors[k]];
    }
    cells.forEach((i, k) => grid[i].piece.color = colors[k]);
    if (!findMatches().length && anyMoveExists()) return;
  }
}

// ---------------- Input ----------------
function attemptSwap(a, b) {
  if (!swappable(a) || !swappable(b)) return;
  sel = -1;
  swapAnim = { a, b, t: 0, back: false };
  phase = 'swap';
}

function resolveSwap(a, b) {
  const pa = grid[a].piece, pb = grid[b].piece;
  const doSwap = () => { grid[a].piece = pb; grid[b].piece = pa; };
  if (isBooster(pa) && isBooster(pb)) {
    doSwap();
    useMove();
    runCombo(a, b);
    return;
  }
  const ds = pa.t === 'ds' ? a : (pb.t === 'ds' ? b : -1);
  if (ds >= 0) {
    const colorPiece = pa.t === 'ds' ? pb : pa;
    doSwap();
    useMove();
    startWave();
    const dsNow = ds === a ? b : a;   // where the disco ended up
    wave.claimed.add(dsNow);
    at(0, () => {
      const cell = grid[dsNow];
      if (cell.piece && cell.piece.t === 'ds') { cell.piece = null; fxPop(dsNow, { t: 'ds' }); }
      discoClear(dsNow, colorPiece.color, null);
    });
    return;
  }
  doSwap();
  const groups = findMatches();
  if (groups.length) {
    useMove();
    processGroups(groups, [b, a]);
  } else {
    grid[a].piece = pa; grid[b].piece = pb;
    swapAnim = { a, b, t: 0, back: true };
    phase = 'swap';
  }
}

function useMove() {
  moves = Math.max(0, moves - 1);
  renderHud();
}

function tapBooster(i) {
  useMove();
  startWave();
  wave.claimed.add(i);
  activateBooster(i, 0);
}

function cellAtPoint(x, y) {
  const c = Math.floor((x - G.ox) / G.cs), r = Math.floor((y - G.oy) / G.cs);
  if (!inBoard(r, c) || !mask[idx(r, c)]) return -1;
  return idx(r, c);
}

// ---------------- Level flow ----------------
function startLevel() {
  buildLevel(level);
  phase = 'idle';
  swapAnim = null; wave = null; falling = null;
  sel = -1; drag = null;
  effects = []; confetti = [];
  document.getElementById('winOverlay').classList.remove('active');
  document.getElementById('loseOverlay').classList.remove('active');
  renderHud();
  renderObjs();
}

function winLevel() {
  phase = 'end';
  burstConfetti();
  level++;
  save();
  document.getElementById('winTitle').textContent = `🎉 Level ${level - 1} Complete!`;
  setTimeout(() => document.getElementById('winOverlay').classList.add('active'), 900);
}

function loseLevel() {
  phase = 'end';
  document.getElementById('loseTitle').textContent = `Out of Moves`;
  setTimeout(() => document.getElementById('loseOverlay').classList.add('active'), 500);
}

function renderHud() {
  document.getElementById('hudLevel').textContent = level;
  document.getElementById('hudMoves').textContent = moves;
}
function renderObjs() {
  const el = document.getElementById('objs');
  el.innerHTML = objectives.map(o => {
    const done = o.got >= o.need;
    const icon = o.type === 'color'
      ? `<i class="dot" style="background:${PALETTE[o.color].main}"></i>`
      : OBJ_ICON[o.type];
    return `<span class="chip${done ? ' done' : ''}">${icon} ${done ? '✓' : (o.need - o.got)}</span>`;
  }).join('');
}

// ---------------- Effects ----------------
function fxPop(i, piece) {
  const p = cellCenter(i);
  const color = piece && piece.t === 'c' ? PALETTE[piece.color].main : '#ffe9a8';
  for (let k = 0; k < 7; k++) {
    const a = Math.random() * Math.PI * 2, v = 1.5 + Math.random() * 2.5;
    effects.push({ type: 'part', x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1, color, t: 0, ttl: 380 });
  }
  effects.push({ type: 'shrink', piece, i, t: 0 });
}
function fxBubble(i) {
  const p = cellCenter(i);
  for (let k = 0; k < 6; k++) {
    const a = Math.random() * Math.PI * 2;
    effects.push({ type: 'part', x: p.x, y: p.y, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2, color: '#cfeaff', t: 0, ttl: 300 });
  }
}
function fxBlock(i, kind) {
  const p = cellCenter(i);
  const color = kind === 'donut' ? '#d78bd2' : '#b07a45';
  for (let k = 0; k < 8; k++) {
    const a = Math.random() * Math.PI * 2, v = 1 + Math.random() * 3;
    effects.push({ type: 'part', x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, color, t: 0, ttl: 420 });
  }
}
function fxGrass(i) {
  const p = cellCenter(i);
  effects.push({ type: 'part', x: p.x, y: p.y, vx: 0, vy: -1.5, color: '#66cf6e', t: 0, ttl: 300 });
}
function fxSpawn(i) {
  const p = cellCenter(i);
  effects.push({ type: 'sparkle', x: p.x, y: p.y, t: 0 });
}

function burstConfetti() {
  for (let i = 0; i < 90; i++) {
    confetti.push({
      x: Math.random() * G.w, y: -10 - Math.random() * G.h * 0.2,
      vx: (Math.random() - 0.5) * 2.2, vy: 2 + Math.random() * 3,
      w: 5 + Math.random() * 5, h: 3 + Math.random() * 4,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      color: PALETTE[i % PALETTE.length].main, t: 0, ttl: 1500 + Math.random() * 600,
    });
  }
}

// ---------------- Layout / render ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, G = { w: 0, h: 0, cs: 40, ox: 0, oy: 0 };

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const cs = Math.min((r.width - 12) / COLS, (r.height - 12) / ROWS);
  G = { w: r.width, h: r.height, cs, ox: (r.width - cs * COLS) / 2, oy: (r.height - cs * ROWS) / 2 };
}
function cellCenter(i) {
  return { x: G.ox + (colOf(i) + 0.5) * G.cs, y: G.oy + (rowOf(i) + 0.5) * G.cs };
}
const rcCenter = (r, c) => ({ x: G.ox + (c + 0.5) * G.cs, y: G.oy + (r + 0.5) * G.cs });

function rrect(x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawPiece(piece, x, y, s, scale = 1) {
  const R = s * 0.37 * scale;
  if (R <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  if (piece.t === 'c') {
    const p = PALETTE[piece.color];
    ctx.lineWidth = Math.max(1.5, s * 0.05);
    ctx.strokeStyle = p.dark;
    ctx.fillStyle = p.main;
    ctx.beginPath();
    if (piece.color === 0) {            // red button
      ctx.arc(0, 0, R, 0, Math.PI * 2);
    } else if (piece.color === 1) {     // yellow star
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + k * Math.PI / 5;
        const rad = k % 2 ? R * 0.5 : R * 1.12;
        ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
    } else if (piece.color === 2) {     // green rounded triangle
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(3, s * 0.14);
      ctx.moveTo(0, -R * 0.95);
      ctx.lineTo(R * 0.88, R * 0.62);
      ctx.lineTo(-R * 0.88, R * 0.62);
      ctx.closePath();
    } else if (piece.color === 3) {     // blue rounded square
      rrect(-R * 0.92, -R * 0.92, R * 1.84, R * 1.84, R * 0.42);
    } else {                            // purple gem
      ctx.moveTo(0, -R * 1.08);
      ctx.lineTo(R * 0.95, 0);
      ctx.lineTo(0, R * 1.08);
      ctx.lineTo(-R * 0.95, 0);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    // gloss
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.ellipse(-R * 0.28, -R * 0.38, R * 0.32, R * 0.2, -0.6, 0, Math.PI * 2);
    ctx.fill();
  } else if (piece.t === 'rk') {
    if (piece.dir === 'v') ctx.rotate(Math.PI / 2);
    // body
    ctx.fillStyle = '#eef2f8';
    ctx.strokeStyle = '#8a93a8';
    ctx.lineWidth = Math.max(1.2, s * 0.04);
    rrect(-R, -R * 0.42, R * 1.5, R * 0.84, R * 0.4);
    ctx.fill(); ctx.stroke();
    // nose
    ctx.fillStyle = '#e8384f';
    ctx.beginPath();
    ctx.moveTo(R * 0.5, -R * 0.42);
    ctx.quadraticCurveTo(R * 1.25, 0, R * 0.5, R * 0.42);
    ctx.closePath(); ctx.fill();
    // fins + window
    ctx.fillStyle = '#e8384f';
    ctx.beginPath(); ctx.moveTo(-R, -R * 0.4); ctx.lineTo(-R * 1.3, -R * 0.75); ctx.lineTo(-R * 0.6, -R * 0.4); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-R, R * 0.4); ctx.lineTo(-R * 1.3, R * 0.75); ctx.lineTo(-R * 0.6, R * 0.4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#4d9be8';
    ctx.beginPath(); ctx.arc(-R * 0.1, 0, R * 0.22, 0, Math.PI * 2); ctx.fill();
  } else if (piece.t === 'bm') {
    ctx.fillStyle = '#3a3f4d';
    ctx.beginPath(); ctx.arc(0, R * 0.1, R * 0.95, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.ellipse(-R * 0.3, -R * 0.2, R * 0.3, R * 0.18, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = Math.max(1.5, s * 0.05);
    ctx.beginPath(); ctx.moveTo(R * 0.1, -R * 0.8); ctx.quadraticCurveTo(R * 0.5, -R * 1.3, R * 0.8, -R * 1.05); ctx.stroke();
    ctx.fillStyle = '#ffc93d';
    ctx.beginPath(); ctx.arc(R * 0.84, -R * 1.05, R * 0.16, 0, Math.PI * 2); ctx.fill();
  } else if (piece.t === 'pl') {
    ctx.rotate(-0.35);
    ctx.fillStyle = '#f4f7ff';
    ctx.strokeStyle = '#8a93a8';
    ctx.lineWidth = Math.max(1.2, s * 0.04);
    ctx.beginPath();
    ctx.moveTo(R * 1.15, 0);
    ctx.lineTo(-R * 0.9, -R * 0.75);
    ctx.lineTo(-R * 0.35, 0);
    ctx.lineTo(-R * 0.9, R * 0.75);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(R * 1.15, 0); ctx.lineTo(-R * 0.35, 0); ctx.stroke();
  } else if (piece.t === 'ds') {
    const g = ctx.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.1, 0, 0, R);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, '#c8d2e8');
    g.addColorStop(1, '#8e9ab8');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(90,100,130,0.6)';
    ctx.lineWidth = 1;
    for (let k = -2; k <= 2; k++) {
      ctx.beginPath(); ctx.ellipse(0, 0, Math.abs(Math.cos(k * 0.5)) * R, R, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, R, R * Math.abs(Math.cos(k * 0.5)), 0, 0, Math.PI * 2); ctx.stroke();
    }
    const tw = (performance.now() / 300) % (Math.PI * 2);
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = PALETTE[k % PALETTE.length].light;
      const a = tw + k * Math.PI / 2;
      ctx.beginPath(); ctx.arc(Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55, R * 0.12, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function drawBlock(cell, x, y, s) {
  const R = s * 0.38;
  ctx.save();
  ctx.translate(x, y);
  if (cell.block.kind === 'donut') {
    ctx.fillStyle = '#d99a55';
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.arc(0, 0, R * 0.38, 0, Math.PI * 2, true); ctx.fill();
    ctx.fillStyle = '#e87ec2';
    ctx.beginPath(); ctx.arc(0, -R * 0.08, R * 0.94, 0, Math.PI * 2); ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2, true); ctx.fill();
    // sprinkles
    const cols = ['#fff6b8', '#a4e8b4', '#a9d1ff', '#ffd2dd'];
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4 + 0.4;
      ctx.save();
      ctx.translate(Math.cos(a) * R * 0.67, Math.sin(a) * R * 0.67 - R * 0.06);
      ctx.rotate(a + 0.8);
      ctx.fillStyle = cols[k % 4];
      ctx.fillRect(-R * 0.12, -R * 0.04, R * 0.24, R * 0.09);
      ctx.restore();
    }
  } else {
    ctx.fillStyle = cell.block.hp > 1 ? '#b07a45' : '#9a6636';
    rrect(-R, -R, R * 2, R * 2, R * 0.18);
    ctx.fill();
    ctx.strokeStyle = '#7a4d24';
    ctx.lineWidth = Math.max(1.5, s * 0.05);
    rrect(-R, -R, R * 2, R * 2, R * 0.18);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-R, -R * 0.33); ctx.lineTo(R, -R * 0.33);
    ctx.moveTo(-R, R * 0.33); ctx.lineTo(R, R * 0.33);
    ctx.stroke();
    if (cell.block.hp === 1) {   // cracks
      ctx.strokeStyle = '#4a2d12';
      ctx.lineWidth = Math.max(1, s * 0.03);
      ctx.beginPath();
      ctx.moveTo(-R * 0.5, -R); ctx.lineTo(-R * 0.15, -R * 0.2); ctx.lineTo(-R * 0.5, R * 0.5);
      ctx.moveTo(R * 0.6, -R * 0.6); ctx.lineTo(R * 0.2, R * 0.1) ; ctx.lineTo(R * 0.65, R * 0.8);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function draw(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // background
  const bg = ctx.createLinearGradient(0, 0, 0, G.h);
  bg.addColorStop(0, '#3d3554');
  bg.addColorStop(1, '#241f36');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, G.w, G.h);

  // cells
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = idx(r, c);
    if (!mask[i]) continue;
    const x = G.ox + c * G.cs, y = G.oy + r * G.cs;
    ctx.fillStyle = (r + c) % 2 ? '#57506f' : '#605a7c';
    rrect(x + 1, y + 1, G.cs - 2, G.cs - 2, G.cs * 0.16);
    ctx.fill();
    if (grid[i].grass) {
      ctx.fillStyle = '#4da85c';
      rrect(x + 1, y + 1, G.cs - 2, G.cs - 2, G.cs * 0.16);
      ctx.fill();
      ctx.fillStyle = '#66cf6e';
      for (let k = 0; k < 3; k++) {
        const bx = x + G.cs * (0.22 + k * 0.28);
        ctx.beginPath();
        ctx.moveTo(bx - G.cs * 0.05, y + G.cs * 0.92);
        ctx.quadraticCurveTo(bx, y + G.cs * 0.62, bx + G.cs * 0.02, y + G.cs * 0.92);
        ctx.fill();
      }
    }
  }

  // selection ring
  if (sel >= 0) {
    const p = cellCenter(sel);
    const pulse = 1 + Math.sin(now / 180) * 0.05;
    ctx.strokeStyle = '#ffe9a8';
    ctx.lineWidth = 3;
    rrect(p.x - G.cs * 0.46 * pulse, p.y - G.cs * 0.46 * pulse, G.cs * 0.92 * pulse, G.cs * 0.92 * pulse, G.cs * 0.2);
    ctx.stroke();
  }

  // moving pieces are drawn separately from their grid cells
  const hidden = new Set();
  if (swapAnim) { hidden.add(swapAnim.a); hidden.add(swapAnim.b); }
  const fallingPieces = new Map();
  if (falling) {
    const stepF = falling.t / FALL_STEP;
    for (const [piece, path] of falling.tracks) {
      const k = Math.min(path.length - 1, Math.floor(stepF));
      const k2 = Math.min(path.length - 1, k + 1);
      const f = Math.min(1, stepF - k);
      const r = path[k].r + (path[k2].r - path[k].r) * f;
      const c = path[k].c + (path[k2].c - path[k].c) * f;
      fallingPieces.set(piece, rcCenter(r, c));
    }
  }

  // board contents
  for (let i = 0; i < ROWS * COLS; i++) {
    if (!mask[i]) continue;
    const cell = grid[i];
    const p = cellCenter(i);
    if (cell.block) { drawBlock(cell, p.x, p.y, G.cs); continue; }
    if (!cell.piece) continue;
    if (hidden.has(i)) continue;
    let pos = p, scale = 1;
    if (fallingPieces.has(cell.piece)) pos = fallingPieces.get(cell.piece);
    if (phase === 'shuffle') scale = Math.abs(1 - (shuffleT / 400) * 2) * 0.7 + 0.3;
    drawPiece(cell.piece, pos.x, pos.y, G.cs, scale);
    if (cell.bubble) {
      ctx.fillStyle = 'rgba(190,225,255,0.28)';
      ctx.strokeStyle = 'rgba(220,240,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, G.cs * 0.44, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(pos.x, pos.y, G.cs * 0.34, -1.8, -0.9); ctx.stroke();
    }
  }

  // swap animation
  if (swapAnim) {
    const k = Math.min(1, swapAnim.t / SWAP_MS);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const pa = cellCenter(swapAnim.a), pb = cellCenter(swapAnim.b);
    const f = swapAnim.back ? 1 - e : e;
    const A = grid[swapAnim.a], B = grid[swapAnim.b];
    if (A.piece) drawPiece(A.piece, pa.x + (pb.x - pa.x) * f, pa.y + (pb.y - pa.y) * f, G.cs);
    if (B.piece) drawPiece(B.piece, pb.x + (pa.x - pb.x) * f, pb.y + (pa.y - pb.y) * f, G.cs);
  }

  // flying planes
  if (wave) for (const pl of wave.planes) {
    const k = Math.min(1, (wave.t - pl.t0) / pl.dur);
    const tgt = cellCenter(pl.target);
    const mx = (pl.x0 + tgt.x) / 2 - (tgt.y - pl.y0) * 0.25;
    const my = (pl.y0 + tgt.y) / 2 + (tgt.x - pl.x0) * 0.25;
    const x = (1 - k) * (1 - k) * pl.x0 + 2 * (1 - k) * k * mx + k * k * tgt.x;
    const y = (1 - k) * (1 - k) * pl.y0 + 2 * (1 - k) * k * my + k * k * tgt.y;
    const dx = 2 * (1 - k) * (mx - pl.x0) + 2 * k * (tgt.x - mx);
    const dy = 2 * (1 - k) * (my - pl.y0) + 2 * k * (tgt.y - my);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx) + 0.35);
    drawPiece({ t: 'pl' }, 0, 0, G.cs * 1.1);
    ctx.restore();
    if (pl.carried) drawPiece(pl.carried, x, y - G.cs * 0.5, G.cs * 0.6);
  }

  // effects
  for (const e of effects) {
    if (e.type === 'part') {
      ctx.globalAlpha = Math.max(0, 1 - e.t / e.ttl);
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.arc(e.x, e.y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    } else if (e.type === 'shrink') {
      const k = Math.min(1, e.t / POP_MS);
      if (k < 1) drawPiece(e.piece, cellCenter(e.i).x, cellCenter(e.i).y, G.cs, 1 - k);
    } else if (e.type === 'streak') {
      const k = Math.min(1, e.t / 260);
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = '#ffe9a8';
      const p = rcCenter(e.r, e.c);
      if (e.dir === 'h') ctx.fillRect(G.ox, p.y - G.cs * 0.12, G.cs * COLS, G.cs * 0.24);
      else ctx.fillRect(p.x - G.cs * 0.12, G.oy, G.cs * 0.24, G.cs * ROWS);
      ctx.globalAlpha = 1;
    } else if (e.type === 'ring') {
      const k = Math.min(1, e.t / 340);
      const p = rcCenter(e.r, e.c);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = '#ffb347';
      ctx.lineWidth = G.cs * 0.28 * (1 - k) + 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, k * G.cs * (e.radius + 1), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'discoflash') {
      const k = Math.min(1, e.t / 400);
      ctx.globalAlpha = (1 - k) * 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, G.w, G.h);
      ctx.globalAlpha = 1;
    } else if (e.type === 'poof' || e.type === 'sparkle') {
      const k = Math.min(1, e.t / 300);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = e.type === 'poof' ? '#ffffff' : '#ffe9a8';
      ctx.lineWidth = 2;
      for (let s = 0; s < 6; s++) {
        const a = s * Math.PI / 3 + k;
        ctx.beginPath();
        ctx.moveTo(e.x + Math.cos(a) * G.cs * 0.2, e.y + Math.sin(a) * G.cs * 0.2);
        ctx.lineTo(e.x + Math.cos(a) * G.cs * (0.2 + k * 0.4), e.y + Math.sin(a) * G.cs * (0.2 + k * 0.4));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // confetti
  for (const p of confetti) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.ttl);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, now - lastT);
  lastT = now;
  if (document.hidden) return;

  if (phase === 'swap' && swapAnim) {
    swapAnim.t += dt;
    if (swapAnim.t >= SWAP_MS) {
      const { a, b, back } = swapAnim;
      swapAnim = null;
      if (back) phase = 'idle';
      else { phase = 'idle'; resolveSwap(a, b); }
    }
  } else if (phase === 'wave' && wave) {
    wave.t += dt;
    let ran = true;
    while (ran) {
      ran = false;
      for (const task of wave.tasks) {
        if (!task.done && task.time <= wave.t) { task.done = true; task.fn(); ran = true; }
      }
    }
    wave.tasks = wave.tasks.filter(t => !t.done);
    for (const pl of wave.planes) {
      if (!pl.done && wave.t - pl.t0 >= pl.dur) { pl.done = true; planeLand(pl); }
    }
    wave.planes = wave.planes.filter(p => !p.done);
    if (!wave.tasks.length && !wave.planes.length && wave.t > wave.last + POP_MS) {
      wave = null;
      startFall();
    }
  } else if (phase === 'fall' && falling) {
    falling.t += dt;
    const maxSteps = Math.max(...falling.tracks.map(([, path]) => path.length - 1));
    if (falling.t >= maxSteps * FALL_STEP) afterSettle();
  } else if (phase === 'shuffle') {
    const was = shuffleT;
    shuffleT += dt;
    if (was < 400 / 2 && shuffleT >= 400 / 2) doShuffleScramble();
    if (shuffleT >= 400) { shuffleT = -1; phase = 'idle'; }
  }

  for (const e of effects) {
    e.t += dt;
    if (e.type === 'part') {
      e.x += e.vx * dt / 16;
      e.y += e.vy * dt / 16;
      e.vy += 0.12 * dt / 16;
    }
  }
  effects = effects.filter(e => e.t < (e.ttl || 450));
  for (const p of confetti) {
    p.t += dt;
    p.x += p.vx * dt / 16;
    p.y += p.vy * dt / 16;
    p.rot += p.vr * dt / 16;
  }
  confetti = confetti.filter(p => p.t < p.ttl);

  draw(now);
}

// ---------------- Input wiring ----------------
canvas.addEventListener('pointerdown', (e) => {
  if (phase !== 'idle') return;
  const r = area.getBoundingClientRect();
  const i = cellAtPoint(e.clientX - r.left, e.clientY - r.top);
  if (i < 0 || !swappable(i)) { sel = -1; return; }
  drag = { i, x: e.clientX, y: e.clientY, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || phase !== 'idle') return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) < G.cs * 0.35) return;
  const r0 = rowOf(drag.i), c0 = colOf(drag.i);
  const j = Math.abs(dx) > Math.abs(dy)
    ? (inBoard(r0, c0 + Math.sign(dx)) ? idx(r0, c0 + Math.sign(dx)) : -1)
    : (inBoard(r0 + Math.sign(dy), c0) ? idx(r0 + Math.sign(dy), c0) : -1);
  const from = drag.i;
  drag = null;
  if (j >= 0 && mask[j]) attemptSwap(from, j);
});
canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  const i = drag.i;
  drag = null;
  if (phase !== 'idle') return;
  const cell = grid[i];
  if (isBooster(cell.piece)) { sel = -1; tapBooster(i); return; }
  if (sel >= 0 && sel !== i) {
    const dr = Math.abs(rowOf(sel) - rowOf(i)), dc = Math.abs(colOf(sel) - colOf(i));
    if (dr + dc === 1) { attemptSwap(sel, i); return; }
  }
  sel = (sel === i) ? -1 : i;
});
canvas.addEventListener('pointercancel', () => { drag = null; });

document.getElementById('retryLevelBtn').onclick = () => startLevel();
document.getElementById('nextBtn').onclick = () => startLevel();
document.getElementById('restartBtn').onclick = () => {
  if (phase === 'idle' || phase === 'end') startLevel();
};

// ---------------- Boot ----------------
load();
save();
layout();
startLevel();
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
