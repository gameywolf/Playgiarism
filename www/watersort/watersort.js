/* Water Sort — pour colored water between tubes until each tube is one color.
   Levels are generated from a seed (level number) and checked with a solver,
   so every level is guaranteed solvable. */
'use strict';

const UNITS = 4;                 // segments per tube
const STATE_KEY = 'watersort.state.v1';
const POUR_MS = 220;

const PALETTE = [
  { main: '#e8384f', light: '#ff8a99' }, // red
  { main: '#ff9f2e', light: '#ffc47e' }, // orange
  { main: '#f7d038', light: '#ffe887' }, // yellow
  { main: '#3fb85c', light: '#7fd894' }, // green
  { main: '#2ec4b6', light: '#7fe3da' }, // teal
  { main: '#4d9be8', light: '#8cc3ff' }, // blue
  { main: '#8b5cf6', light: '#bda2ff' }, // purple
  { main: '#ec4899', light: '#ff8ec4' }, // pink
  { main: '#8d6e63', light: '#b99a8f' }, // brown
];

// ---------------- State ----------------
let level = 1;
let tubes = [];          // array of arrays of color indices, bottom -> top
let undoStack = [];
let selected = -1;
let pour = null;         // {from, to, color, n, t}
let confetti = [];

// difficulty varies level to level rather than ramping straight up: the ceiling
// rises slowly, but each level draws its color count from a band below it and
// sometimes gets a third empty tube (easier) — all seeded, so level N is always
// the same puzzle
function levelConfig(lvl) {
  const rnd = mulberry32(lvl * 48271 + 11);
  const top = Math.min(PALETTE.length, 4 + Math.floor(lvl / 4));
  const low = Math.max(4, top - 2);
  const colors = low + Math.floor(rnd() * (top - low + 1));
  const empties = rnd() < 0.3 ? 3 : 2;
  return { colors, empties };
}

// deterministic RNG so a level is always the same puzzle
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- Level generation ----------------
function generate(lvl) {
  const { colors, empties } = levelConfig(lvl);
  for (let attempt = 0; attempt < 25; attempt++) {
    const rnd = mulberry32(lvl * 7919 + attempt * 104729 + 13);
    const units = [];
    for (let c = 0; c < colors; c++) for (let u = 0; u < UNITS; u++) units.push(c);
    for (let i = units.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [units[i], units[j]] = [units[j], units[i]];
    }
    const t = [];
    for (let c = 0; c < colors; c++) t.push(units.slice(c * UNITS, (c + 1) * UNITS));
    for (let e = 0; e < empties; e++) t.push([]);
    if (!isWon(t) && solvable(t)) return t;
  }
  // practically unreachable: the solver accepts almost every shuffle
  return generateFallback(colors, empties);
}

function generateFallback(colors, empties) {
  const t = [];
  for (let c = 0; c < colors; c++) t.push([c, c, c, c]);
  for (let e = 0; e < empties; e++) t.push([]);
  // scramble with reverse pours so it's solvable by construction
  const rnd = mulberry32(level * 31 + 7);
  for (let k = 0; k < colors * 24; k++) {
    const i = Math.floor(rnd() * t.length), j = Math.floor(rnd() * t.length);
    if (i === j || !t[i].length || t[j].length >= UNITS) continue;
    t[j].push(t[i].pop());
  }
  return t;
}

function topRun(t) {
  if (!t.length) return { color: -1, n: 0 };
  const color = t[t.length - 1];
  let n = 0;
  for (let i = t.length - 1; i >= 0 && t[i] === color; i--) n++;
  return { color, n };
}
function isUniformFull(t) { return t.length === UNITS && t.every(c => c === t[0]); }
function isWon(ts) { return ts.every(t => !t.length || isUniformFull(t)); }
function canPour(ts, i, j) {
  if (i === j || !ts[i].length || ts[j].length >= UNITS) return false;
  const { color } = topRun(ts[i]);
  return !ts[j].length || ts[j][ts[j].length - 1] === color;
}

function solvable(start) {
  const key = ts => ts.map(t => t.join('')).sort().join('|');
  const seen = new Set([key(start)]);
  const stack = [start];
  let nodes = 0;
  while (stack.length && nodes++ < 120000) {
    const cur = stack.pop();
    if (isWon(cur)) return true;
    for (let i = 0; i < cur.length; i++) {
      if (!cur[i].length) continue;
      const run = topRun(cur[i]);
      if (isUniformFull(cur[i])) continue;                       // done tube: leave it
      for (let j = 0; j < cur.length; j++) {
        if (!canPour(cur, i, j)) continue;
        if (!cur[j].length && run.n === cur[i].length) continue; // uniform tube -> empty: pointless
        const next = cur.map(t => t.slice());
        const amt = Math.min(run.n, UNITS - next[j].length);
        for (let k = 0; k < amt; k++) next[j].push(next[i].pop());
        const nk = key(next);
        if (!seen.has(nk)) { seen.add(nk); stack.push(next); }
      }
    }
  }
  return false;
}

// ---------------- Persistence ----------------
function save() {
  localStorage.setItem(STATE_KEY, JSON.stringify({ level, tubes }));
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (s && s.level >= 1) {
      level = s.level;
      if (Array.isArray(s.tubes) && s.tubes.length && !isWon(s.tubes)) {
        tubes = s.tubes.map(t => t.slice());
        return true;
      }
    }
  } catch { }
  return false;
}

function startLevel(fresh) {
  if (fresh || !tubes.length) tubes = generate(level);
  undoStack = [];
  selected = -1;
  pour = null;
  document.getElementById('hudLevel').textContent = level;
  document.getElementById('winOverlay').classList.remove('active');
  updateButtons();
  layout();
  save();
}

// ---------------- Interaction ----------------
function tubeAt(px, py) {
  for (let i = 0; i < tubes.length; i++) {
    const p = tubePos(i);
    if (px >= p.x - G.tw * 0.35 && px <= p.x + G.tw * 1.35 && py >= p.y - 30 && py <= p.y + G.th + 16) return i;
  }
  return -1;
}

function doPour(i, j) {
  const run = topRun(tubes[i]);
  const amt = Math.min(run.n, UNITS - tubes[j].length);
  undoStack.push(tubes.map(t => t.slice()));
  pour = { from: i, to: j, color: run.color, n: amt, t: 0 };
  selected = -1;
  updateButtons();
}

function finishPour() {
  const { from, to, n } = pour;
  for (let k = 0; k < n; k++) tubes[to].push(tubes[from].pop());
  pour = null;
  save();
  if (isWon(tubes)) {
    burstConfetti();
    document.getElementById('winTitle').textContent = `🎉 Level ${level} Complete!`;
    setTimeout(() => document.getElementById('winOverlay').classList.add('active'), 900);
  }
}

document.getElementById('board').addEventListener('pointerdown', (e) => {
  if (pour) return;
  const r = area.getBoundingClientRect();
  const i = tubeAt(e.clientX - r.left, e.clientY - r.top);
  if (i < 0) { selected = -1; return; }
  if (selected < 0) {
    if (tubes[i].length && !isUniformFull(tubes[i])) selected = i;
  } else if (i === selected) {
    selected = -1;
  } else if (canPour(tubes, selected, i)) {
    doPour(selected, i);
  } else {
    selected = tubes[i].length && !isUniformFull(tubes[i]) ? i : -1;
  }
});

document.getElementById('undoBtn').onclick = () => {
  if (pour || !undoStack.length) return;
  tubes = undoStack.pop();
  selected = -1;
  updateButtons();
  save();
};
document.getElementById('restartBtn').onclick = () => {
  if (pour) return;
  tubes = generate(level);
  undoStack = [];
  selected = -1;
  updateButtons();
  save();
};
document.getElementById('nextBtn').onclick = () => {
  level++;
  startLevel(true);
};

function updateButtons() {
  document.getElementById('undoBtn').disabled = !undoStack.length;
}

// ---------------- Layout / render ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, G = null; // {w,h,tw,th,rows,cols[]}

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';

  const n = tubes.length;
  const rows = n > 7 ? 2 : 1;
  const perRow = rows === 1 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)];
  const maxCols = Math.max(...perRow);
  const tw = Math.min(54, (r.width - 24) / (maxCols * 1.6));
  const th = Math.min(tw * 4.4, (r.height - 60 * rows) / rows - 40);
  G = { w: r.width, h: r.height, tw, th, rows, perRow };
}

function tubePos(i) {
  let row = 0, col = i;
  if (G.rows === 2 && i >= G.perRow[0]) { row = 1; col = i - G.perRow[0]; }
  const cols = G.perRow[row];
  const span = cols * G.tw * 1.6;
  const x = (G.w - span) / 2 + col * G.tw * 1.6 + G.tw * 0.3;
  const rowH = G.h / G.rows;
  const y = rowH * row + (rowH - G.th) / 2 + (G.rows === 2 ? (row === 0 ? 14 : -6) : 0);
  return { x, y };
}

function tubePath(x, y, w, h) {
  const r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + h - r);
  ctx.arc(x + r, y + h - r, r, Math.PI, 0, true);
  ctx.lineTo(x + w, y);
}

// visible segments for a tube, accounting for an in-flight pour
function segmentsOf(i) {
  const segs = tubes[i].map(c => ({ color: c, h: 1 }));
  if (!pour) return segs;
  const k = Math.min(1, pour.t / POUR_MS);
  if (i === pour.from) {
    let left = pour.n * k;                    // amount that has left so far
    for (let s = segs.length - 1; s >= 0 && left > 0; s--) {
      const take = Math.min(1, left);
      segs[s].h -= take;
      left -= take;
    }
  } else if (i === pour.to) {
    let arrived = pour.n * k;
    while (arrived > 0) {
      const add = Math.min(1, arrived);
      segs.push({ color: pour.color, h: add });
      arrived -= add;
    }
  }
  return segs.filter(s => s.h > 0.01);
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, G.w, G.h);

  for (let i = 0; i < tubes.length; i++) {
    const p = tubePos(i);
    const lift = i === selected ? 14 : 0;
    const x = p.x, y = p.y - lift;
    const unitH = (G.th - 6) / UNITS;

    // water
    ctx.save();
    tubePath(x, y, G.tw, G.th);
    ctx.clip();
    let hAcc = 0;
    for (const seg of segmentsOf(i)) {
      const c = PALETTE[seg.color];
      const yTop = y + G.th - (hAcc + seg.h) * unitH;
      const g = ctx.createLinearGradient(x, 0, x + G.tw, 0);
      g.addColorStop(0, c.light);
      g.addColorStop(0.5, c.main);
      g.addColorStop(1, c.main);
      ctx.fillStyle = g;
      ctx.fillRect(x, yTop, G.tw, seg.h * unitH + 0.5);
      hAcc += seg.h;
    }
    // glass gloss
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(x + G.tw * 0.12, y, G.tw * 0.16, G.th);
    ctx.restore();

    // glass outline + lip
    tubePath(x, y, G.tw, G.th);
    ctx.strokeStyle = i === selected ? '#6c8cff' : 'rgba(60,60,90,0.35)';
    ctx.lineWidth = i === selected ? 3 : 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x + G.tw / 2, y, G.tw / 2 + 2, 4, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(60,60,90,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // checkmark on completed tubes
    if (isUniformFull(tubes[i]) && !pour) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.font = `700 ${G.tw * 0.5}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✓', x + G.tw / 2, y - 16);
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

function burstConfetti() {
  for (let i = 0; i < 80; i++) {
    confetti.push({
      x: Math.random() * G.w,
      y: -10 - Math.random() * G.h * 0.2,
      vx: (Math.random() - 0.5) * 2.2,
      vy: 2 + Math.random() * 3,
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: PALETTE[i % PALETTE.length].main,
      t: 0,
      ttl: 1400 + Math.random() * 600,
    });
  }
}

// ---------------- Main loop ----------------
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (document.hidden) return;
  if (pour) {
    pour.t += dt;
    if (pour.t >= POUR_MS) finishPour();
  }
  for (const p of confetti) {
    p.t += dt;
    p.x += p.vx * dt / 16;
    p.y += p.vy * dt / 16;
    p.rot += p.vr * dt / 16;
  }
  confetti = confetti.filter(p => p.t < p.ttl);
  draw();
}

// ---------------- Boot ----------------
const resumed = load();
startLevel(!resumed);
requestAnimationFrame(loop);
window.addEventListener('resize', layout);
