/* Color Wars — chain-reaction dot battle for 2-4 players.
   Opening move drops 3 dots on an empty square; then you tap your own squares
   to add a dot. At 4 a square explodes into its 4 neighbors, converting them
   to your color (chains cascade). Last color standing wins. */
'use strict';

const PLAYERS = [
  { name: 'Red',    main: '#e8384f', light: '#ff8a99', dark: '#b02338', tint: '#ffe1e6' },
  { name: 'Blue',   main: '#4d9be8', light: '#8cc3ff', dark: '#2f6fb5', tint: '#ddedff' },
  { name: 'Green',  main: '#3fb85c', light: '#7fd894', dark: '#2b8a43', tint: '#def5e2' },
  { name: 'Yellow', main: '#f2b711', light: '#ffd75e', dark: '#c49208', tint: '#fbf0cf' },
];
const GRID_FOR = { 2: 5, 3: 6, 4: 7 }; // more players, slightly larger board
const FLIGHT_MS = 220;
const MORPH_MS = 150;   // dots sliding into their new arrangement when one is added

// ---------------- State ----------------
let playersN = 0;             // 0 = mode not chosen yet
let cpu = false;              // Blue is the CPU (2-player mode only)
let N = 5;
let owner, count;             // per-cell: -1 empty / player index, dot count
let turn = 0;
let opened = [];              // has each player made their opening drop?
let over = false;
let animating = false;
let flights = [];             // dots in transit {x0,y0,x1,y1,t,color,target}
const morphs = new Map();     // cell -> {t, dots:[{fx,fy,tx,ty}]} in layout coords

// animate a cell's dots from the n0-layout to the n1-layout; the extra dot
// splits off the nearest existing dot (or the center when the cell was empty)
function addMorph(i, n0, n1) {
  n0 = Math.min(4, n0); n1 = Math.min(4, n1);
  if (n1 <= n0) return;
  const from = DOT_LAYOUTS[n0], to = DOT_LAYOUTS[n1];
  const dots = [];
  for (let j = 0; j < to.length; j++) {
    let src = [0, 0];
    if (j < n0) src = from[j];
    else if (from.length) {
      let bd = Infinity;
      for (const f of from) {
        const d = (f[0] - to[j][0]) ** 2 + (f[1] - to[j][1]) ** 2;
        if (d < bd) { bd = d; src = f; }
      }
    }
    dots.push({ fx: src[0], fy: src[1], tx: to[j][0], ty: to[j][1] });
  }
  morphs.set(i, { t: 0, dots });
}

// ---------------- Canvas ----------------
const wrap = document.getElementById('warsWrap');
const canvas = document.getElementById('warsCanvas');
const ctx = canvas.getContext('2d');
let dpr = 1;
let B = null; // {w,h,size,ox,oy,cell}

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = wrap.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const size = Math.min(r.width, r.height) - 56;
  B = { w: r.width, h: r.height, size, ox: (r.width - size) / 2, oy: (r.height - size) / 2, cell: size / N };
}

function cellCenter(i) {
  const x = i % N, y = (i / N) | 0;
  return [B.ox + (x + 0.5) * B.cell, B.oy + (y + 0.5) * B.cell];
}

// ---------------- Match setup ----------------
function startMatch(n, vsCpu) {
  playersN = n;
  cpu = vsCpu;
  N = GRID_FOR[n];
  layout();
  document.getElementById('modeOverlay').classList.remove('active');
  newMatch();
}

function newMatch() {
  owner = new Int8Array(N * N).fill(-1);
  count = new Uint8Array(N * N);
  turn = 0;
  opened = new Array(playersN).fill(false);
  over = false;
  animating = false;
  flights = [];
  morphs.clear();
  document.getElementById('winOverlay').classList.remove('active');
  buildChips();
  updateHud();
}

function buildChips() {
  const box = document.getElementById('warsChips');
  box.innerHTML = '';
  for (let p = 0; p < playersN; p++) {
    const el = document.createElement('div');
    el.className = 'wars-side';
    el.id = 'chip' + p;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `radial-gradient(circle at 35% 30%, ${PLAYERS[p].light}, ${PLAYERS[p].main})`;
    el.appendChild(dot);
    const b = document.createElement('b');
    b.id = 'chipCount' + p;
    b.textContent = '0';
    el.appendChild(b);
    box.appendChild(el);
  }
}

document.getElementById('modeCpu').onclick = () => startMatch(2, true);
document.getElementById('mode2p').onclick = () => startMatch(2, false);
document.getElementById('mode3p').onclick = () => startMatch(3, false);
document.getElementById('mode4p').onclick = () => startMatch(4, false);
document.getElementById('againBtn').onclick = () => newMatch();
document.getElementById('changeModeBtn').onclick = () => {
  document.getElementById('winOverlay').classList.remove('active');
  document.getElementById('modeOverlay').classList.add('active');
};

// ---------------- Rules ----------------
function totals() {
  const t = new Array(playersN).fill(0);
  for (let i = 0; i < N * N; i++) if (owner[i] >= 0) t[owner[i]] += count[i];
  return t;
}
function allOpened() { return opened.every(Boolean); }
// a player is out of the match once they opened and lost every dot
function alive(p, t) { return !opened[p] || t[p] > 0; }

canvas.addEventListener('pointerdown', (e) => {
  if (!playersN || over || animating) return;
  if (cpu && turn === 1) return;
  const r = wrap.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left - B.ox) / B.cell);
  const y = Math.floor((e.clientY - r.top - B.oy) / B.cell);
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  playAt(y * N + x);
});

function playAt(i) {
  if (!opened[turn]) {
    if (owner[i] !== -1) return;          // opening drop needs an empty square
    addMorph(i, 0, 3);                    // the 3 dots split out of the center
    owner[i] = turn; count[i] = 3;
    opened[turn] = true;
    updateHud();
    endTurn();
  } else {
    if (owner[i] !== turn) return;        // may only add to your own squares
    addMorph(i, count[i], count[i] + 1);
    count[i]++;
    updateHud();
    resolveChains();
  }
}

function resolveChains() {
  // win check first: a chain stops as soon as one color remains
  if (allOpened()) {
    const t = totals();
    const standing = [];
    for (let p = 0; p < playersN; p++) if (t[p] > 0) standing.push(p);
    if (standing.length === 1) { endGame(standing[0]); return; }
  }
  const wave = [];
  for (let i = 0; i < N * N; i++) if (count[i] >= 4) wave.push(i);
  if (!wave.length) { endTurn(); return; }

  animating = true;
  const mover = turn;
  const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const i of wave) {
    const [cx, cy] = cellCenter(i);
    const x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of deltas) {
      const nx = x + dx, ny = y + dy;
      let tx, ty, target = -1;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N) {
        target = ny * N + nx;
        [tx, ty] = cellCenter(target);
      } else { // flies off the board and is lost
        tx = cx + dx * B.cell; ty = cy + dy * B.cell;
      }
      flights.push({ x0: cx, y0: cy, x1: tx, y1: ty, t: 0, color: PLAYERS[mover].main, target });
    }
    count[i] -= 4;
    if (count[i] === 0) owner[i] = -1;
    morphs.delete(i); // this cell's dots fly out instead
  }
  setTimeout(() => {
    for (const f of flights) {
      if (f.target >= 0) {
        addMorph(f.target, count[f.target], count[f.target] + 1);
        owner[f.target] = mover; count[f.target]++;
      }
    }
    flights = [];
    updateHud();
    resolveChains(); // next wave (or finish)
  }, FLIGHT_MS);
}

function endTurn() {
  animating = false;
  const t = totals();
  let guard = 0;
  do {
    turn = (turn + 1) % playersN;
  } while (!alive(turn, t) && ++guard < 8);
  updateHud();
  if (cpu && turn === 1 && !over) setTimeout(cpuMove, 700);
}

function endGame(winner) {
  over = true;
  animating = false;
  flights = [];
  updateHud();
  const title = cpu
    ? (winner === 0 ? 'You win! 🎉' : 'CPU wins! 🤖')
    : `${PLAYERS[winner].name} wins! 🎉`;
  document.getElementById('winTitle').textContent = title;
  setTimeout(() => document.getElementById('winOverlay').classList.add('active'), 500);
}

// ---------------- CPU (Blue, 2-player mode) ----------------
function cpuMove() {
  if (over || !playersN) return;
  const ME = 1;
  if (!opened[ME]) {
    // opening: prefer center-ish squares that aren't hugging the opponent
    let best = -1, bestScore = -Infinity;
    const mid = (N - 1) / 2;
    for (let i = 0; i < N * N; i++) {
      if (owner[i] !== -1) continue;
      const x = i % N, y = (i / N) | 0;
      let s = -Math.abs(x - mid) - Math.abs(y - mid) + Math.random();
      for (let j = 0; j < N * N; j++) {
        if (owner[j] >= 0 && owner[j] !== ME) {
          const d = Math.abs(x - j % N) + Math.abs(y - ((j / N) | 0));
          if (d <= 1) s -= 6; else if (d === 2) s -= 2;
        }
      }
      if (s > bestScore) { bestScore = s; best = i; }
    }
    playAt(best);
    return;
  }
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < N * N; i++) {
    if (owner[i] !== ME) continue;
    const s = simulate(i, ME) + Math.random() * 0.4;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best < 0) return; // no dots means the game already ended
  playAt(best);
}

// score a CPU move by resolving it on a copy of the board
function simulate(move, me) {
  const o = Int8Array.from(owner);
  const c = Uint8Array.from(count);
  c[move]++;
  let guard = 0;
  while (guard++ < 300) {
    let enemy = 0;
    for (let i = 0; i < N * N; i++) if (o[i] >= 0 && o[i] !== me) enemy += c[i];
    if (enemy === 0) return 1000; // winning move
    const wave = [];
    for (let i = 0; i < N * N; i++) if (c[i] >= 4) wave.push(i);
    if (!wave.length) break;
    for (const i of wave) {
      c[i] -= 4;
      if (c[i] === 0) o[i] = -1;
      const x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
        const j = ny * N + nx;
        o[j] = me; c[j]++;
      }
    }
  }
  let mine = 0, theirs = 0, exposed = 0;
  for (let i = 0; i < N * N; i++) {
    if (o[i] === me) mine += c[i];
    else if (o[i] >= 0) theirs += c[i];
  }
  // don't park 3-dot squares next to an enemy square that's ready to pop
  for (let i = 0; i < N * N; i++) {
    if (o[i] !== me || c[i] !== 3) continue;
    const x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
      const j = ny * N + nx;
      if (o[j] >= 0 && o[j] !== me && c[j] === 3) exposed++;
    }
  }
  return mine - theirs - exposed * 1.5;
}

// ---------------- HUD ----------------
function updateHud() {
  if (!playersN) return;
  const t = totals();
  for (let p = 0; p < playersN; p++) {
    const chip = document.getElementById('chip' + p);
    if (!chip) continue;
    document.getElementById('chipCount' + p).textContent = t[p];
    chip.style.borderColor = (!over && turn === p) ? PLAYERS[p].main : 'transparent';
    chip.classList.toggle('out', allOpened() && t[p] === 0);
  }
  const label = document.getElementById('turnLabel');
  if (over) label.textContent = 'Game over';
  else if (!opened[turn]) label.textContent = `${PLAYERS[turn].name}: drop 3 dots on an empty square`;
  else if (cpu && turn === 1) label.textContent = 'CPU is thinking…';
  else label.textContent = `${PLAYERS[turn].name}'s turn — tap one of your squares`;
}

// ---------------- Render ----------------
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

const DOT_LAYOUTS = [
  [],
  [[0, 0]],
  [[-1, -1], [1, 1]],
  [[-1, -1], [1, -1], [0, 1]],
  [[-1, -1], [1, -1], [-1, 1], [1, 1]],
];

function drawDot(x, y, r, p) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
  g.addColorStop(0, p.light);
  g.addColorStop(0.8, p.main);
  g.addColorStop(1, p.dark);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, B.w, B.h);
  if (!owner) return;

  // board frame
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, B.ox - 10, B.oy - 10, B.size + 20, B.size + 20, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.07)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const pad = Math.max(3, B.cell * 0.05);
  const dotR = B.cell * 0.13;
  const off = B.cell * 0.2;

  for (let i = 0; i < N * N; i++) {
    const x = i % N, y = (i / N) | 0;
    const cx = B.ox + x * B.cell, cy = B.oy + y * B.cell;
    const o = owner[i];
    roundRect(ctx, cx + pad, cy + pad, B.cell - 2 * pad, B.cell - 2 * pad, B.cell * 0.14);
    ctx.fillStyle = o < 0 ? '#eef1fa' : PLAYERS[o].tint;
    ctx.fill();

    if (o >= 0 && count[i] > 0) {
      const [ccx, ccy] = cellCenter(i);
      const m = morphs.get(i);
      if (m) {
        const k = Math.min(1, m.t / MORPH_MS);
        const e = 1 - Math.pow(1 - k, 3);
        for (const d of m.dots) {
          drawDot(ccx + (d.fx + (d.tx - d.fx) * e) * off, ccy + (d.fy + (d.ty - d.fy) * e) * off, dotR, PLAYERS[o]);
        }
      } else {
        for (const [kx, ky] of DOT_LAYOUTS[Math.min(4, count[i])]) {
          drawDot(ccx + kx * off, ccy + ky * off, dotR, PLAYERS[o]);
        }
      }
    }
  }

  // dots in flight
  for (const f of flights) {
    const k = Math.min(1, f.t / FLIGHT_MS);
    const e = 1 - Math.pow(1 - k, 2); // ease-out
    const x = f.x0 + (f.x1 - f.x0) * e;
    const y = f.y0 + (f.y1 - f.y0) * e;
    ctx.globalAlpha = f.target < 0 ? 1 - k : 1; // lost dots fade off the edge
    ctx.fillStyle = f.color;
    ctx.beginPath(); ctx.arc(x, y, dotR, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (document.hidden) return;
  for (const f of flights) f.t += dt;
  for (const [i, m] of morphs) {
    m.t += dt;
    if (m.t >= MORPH_MS) morphs.delete(i);
  }
  draw();
}

layout();
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
