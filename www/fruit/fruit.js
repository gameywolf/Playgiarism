/* Fruit Merge — suika-style merging in a square tank */
'use strict';

const { Engine, World, Bodies, Body, Events, Composite } = Matter;

// ---------------- Fruit definitions ----------------
// radius as a fraction of tank interior size
const FRUITS = [
  { name: 'blueberry',  rf: 0.034, color: '#4d5bd4', dark: '#333f9e' },
  { name: 'strawberry', rf: 0.047, color: '#e8384f', dark: '#b02338' },
  { name: 'raspberry',  rf: 0.061, color: '#d44d7c', dark: '#a3325b' },
  { name: 'peach',      rf: 0.076, color: '#ffb07a', dark: '#e08a52' },
  { name: 'lemon',      rf: 0.093, color: '#ffd93b', dark: '#d9b021' },
  { name: 'plum',       rf: 0.112, color: '#7d4a9e', dark: '#5c327a' },
  { name: 'orange',     rf: 0.133, color: '#ff9f2e', dark: '#d97e14' },
  { name: 'apple',      rf: 0.156, color: '#e0342c', dark: '#ad1f19' },
  { name: 'pineapple',  rf: 0.182, color: '#f2c545', dark: '#c79a26' },
  { name: 'cantaloupe', rf: 0.21,  color: '#e8b98a', dark: '#c29465' },
  { name: 'watermelon', rf: 0.245, color: '#3f9e4d', dark: '#2c7a38' },
];
const MAX_DROP_LEVEL = 4; // droppable fruit: first five (blueberry..lemon)
const MERGE_POINTS = FRUITS.map((_, i) => ((i + 1) * (i + 2)) / 2); // points for creating level i
const WATERMELON_VANISH_POINTS = 200;

// ---------------- High scores ----------------
const SCORE_KEY = 'fruit.scores.v1';
function dayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function weekKey(d = new Date()) {
  // ISO week
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
function saveScores(s) { localStorage.setItem(SCORE_KEY, JSON.stringify(s)); }
function reportScore(score) {
  const s = loadScores();
  const records = [];
  if (score > s.daily.score) { s.daily.score = score; records.push('daily'); }
  if (score > s.weekly.score) { s.weekly.score = score; records.push('weekly'); }
  if (score > s.allTime) { s.allTime = score; records.push('all-time'); }
  saveScores(s);
  return records;
}
function updateBestsHud() {
  const s = loadScores();
  document.getElementById('hudBests').textContent =
    `${s.daily.score} / ${s.weekly.score} / ${s.allTime}`;
}

// ---------------- Layout ----------------
const wrap = document.getElementById('fruitCanvasWrap');
const canvas = document.getElementById('fruitCanvas');
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio || 1;

// geometry (css px)
let G = null; // {W,H,S,wall,left,right,top,bottom,dropY,lineY}

function computeLayout() {
  const r = wrap.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  const wall = 8;
  const dropZone = Math.min(96, r.height * 0.14);
  const S = r.width - 2 * wall - 8;                              // interior width
  const T = Math.min(S * 1.6, r.height - dropZone - wall - 4);   // interior height (taller than wide)
  const left = (r.width - S) / 2;
  const top = r.height - wall - T;
  G = {
    W: r.width, H: r.height, S, T, wall,
    left, right: left + S,
    top, bottom: top + T,
    dropY: top - Math.min(56, dropZone * 0.6),
    lineY: top + 10,
  };
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
}

// ---------------- Sprites ----------------
const spriteCache = new Map(); // level -> canvas (rendered at generous resolution)
const SPRITE_R = 96; // fruit radius inside the sprite canvas
const SPRITE_PAD = 4; // padding so strokes/antialiasing aren't clipped

function getSprite(level) {
  if (spriteCache.has(level)) return spriteCache.get(level);
  const f = FRUITS[level];
  const R = SPRITE_R;
  const cv = document.createElement('canvas');
  cv.width = cv.height = (R + SPRITE_PAD) * 2;
  const c = cv.getContext('2d');
  const cx = R + SPRITE_PAD, cy = R + SPRITE_PAD;

  // base ball with radial gradient
  const g = c.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.15, cx, cy, R);
  g.addColorStop(0, lighten(f.color, 0.35));
  g.addColorStop(0.75, f.color);
  g.addColorStop(1, f.dark);
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();

  c.save();
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
  drawDetail(c, f.name, cx, cy, R);
  c.restore();

  drawFace(c, cx, cy, R);

  // rim
  c.strokeStyle = 'rgba(0,0,0,0.25)';
  c.lineWidth = 3;
  c.beginPath(); c.arc(cx, cy, R - 1.5, 0, Math.PI * 2); c.stroke();

  // gloss highlight
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.beginPath();
  c.ellipse(cx - R * 0.38, cy - R * 0.45, R * 0.22, R * 0.13, -0.6, 0, Math.PI * 2);
  c.fill();

  spriteCache.set(level, cv);
  return cv;
}

// draw so the sprite's fruit circle exactly covers physics radius r
function drawSprite(ctx, level, r) {
  const h = (SPRITE_R + SPRITE_PAD) * (r / SPRITE_R);
  ctx.drawImage(getSprite(level), -h, -h, h * 2, h * 2);
}

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (n >> 16) + 255 * amt);
  const g = Math.min(255, ((n >> 8) & 255) + 255 * amt);
  const b = Math.min(255, (n & 255) + 255 * amt);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function drawDetail(c, name, cx, cy, R) {
  c.lineCap = 'round';
  switch (name) {
    case 'blueberry': { // star crown
      c.strokeStyle = 'rgba(20,25,80,0.55)';
      c.lineWidth = R * 0.06;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * R * 0.12, cy - R * 0.55 + Math.sin(a) * R * 0.12);
        c.lineTo(cx + Math.cos(a) * R * 0.3, cy - R * 0.55 + Math.sin(a) * R * 0.3);
        c.stroke();
      }
      break;
    }
    case 'strawberry': { // pale seeds
      c.fillStyle = 'rgba(255,240,200,0.8)';
      for (let i = 0; i < 14; i++) {
        const a = (i * 2.399);
        const rr = R * (0.25 + 0.55 * ((i * 37) % 10) / 10);
        c.beginPath();
        c.ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * 0.045, R * 0.07, a, 0, Math.PI * 2);
        c.fill();
      }
      break;
    }
    case 'raspberry': { // drupelet bumps
      c.strokeStyle = 'rgba(120,20,60,0.4)';
      c.lineWidth = R * 0.04;
      for (let ring = 0; ring < 3; ring++) {
        const rr = R * (0.25 + ring * 0.28);
        const n = 5 + ring * 4;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + ring;
          c.beginPath();
          c.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * 0.14, 0, Math.PI * 2);
          c.stroke();
        }
      }
      break;
    }
    case 'peach': { // crease + leaf
      c.strokeStyle = 'rgba(180,90,40,0.5)';
      c.lineWidth = R * 0.05;
      c.beginPath();
      c.moveTo(cx, cy - R * 0.9);
      c.quadraticCurveTo(cx + R * 0.25, cy, cx, cy + R * 0.9);
      c.stroke();
      leaf(c, cx, cy - R * 0.78, R * 0.28);
      break;
    }
    case 'lemon': { // dimples
      dimples(c, cx, cy, R, 'rgba(200,150,0,0.25)');
      break;
    }
    case 'plum': { // crease
      c.strokeStyle = 'rgba(30,10,50,0.45)';
      c.lineWidth = R * 0.05;
      c.beginPath();
      c.moveTo(cx - R * 0.1, cy - R * 0.9);
      c.quadraticCurveTo(cx - R * 0.35, cy, cx - R * 0.1, cy + R * 0.9);
      c.stroke();
      break;
    }
    case 'orange': { // dimples + leaf
      dimples(c, cx, cy, R, 'rgba(160,80,0,0.3)');
      leaf(c, cx + R * 0.1, cy - R * 0.8, R * 0.3);
      break;
    }
    case 'apple': { // stem
      c.strokeStyle = '#5a3a1a';
      c.lineWidth = R * 0.08;
      c.beginPath();
      c.moveTo(cx, cy - R * 0.62);
      c.quadraticCurveTo(cx + R * 0.12, cy - R * 0.85, cx + R * 0.08, cy - R * 1.0);
      c.stroke();
      leaf(c, cx + R * 0.28, cy - R * 0.75, R * 0.3);
      break;
    }
    case 'pineapple': { // crosshatch
      c.strokeStyle = 'rgba(150,100,20,0.4)';
      c.lineWidth = R * 0.045;
      for (let i = -4; i <= 4; i++) {
        c.beginPath();
        c.moveTo(cx + i * R * 0.3 - R, cy - R);
        c.lineTo(cx + i * R * 0.3 + R, cy + R);
        c.stroke();
        c.beginPath();
        c.moveTo(cx + i * R * 0.3 + R, cy - R);
        c.lineTo(cx + i * R * 0.3 - R, cy + R);
        c.stroke();
      }
      // little crown
      c.fillStyle = '#3f9e4d';
      for (let i = -2; i <= 2; i++) {
        c.beginPath();
        c.moveTo(cx + i * R * 0.14, cy - R * 0.55);
        c.lineTo(cx + i * R * 0.14 - R * 0.07, cy - R * 0.95);
        c.lineTo(cx + i * R * 0.14 + R * 0.07, cy - R * 0.95);
        c.closePath();
        c.fill();
      }
      break;
    }
    case 'cantaloupe': { // netting
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.lineWidth = R * 0.03;
      for (let i = 0; i < 40; i++) {
        const a1 = i * 2.399, a2 = a1 + 1.1;
        const r1 = R * ((i * 53 % 90) / 100 + 0.05), r2 = Math.min(R, r1 + R * 0.3);
        c.beginPath();
        c.moveTo(cx + Math.cos(a1) * r1, cy + Math.sin(a1) * r1);
        c.lineTo(cx + Math.cos(a2) * r2, cy + Math.sin(a2) * r2);
        c.stroke();
      }
      break;
    }
    case 'watermelon': { // dark stripes
      c.strokeStyle = 'rgba(20,80,30,0.75)';
      c.lineWidth = R * 0.16;
      for (let i = -2; i <= 2; i++) {
        c.beginPath();
        c.moveTo(cx + i * R * 0.42, cy - R * 1.05);
        c.quadraticCurveTo(cx + i * R * 0.6, cy, cx + i * R * 0.42, cy + R * 1.05);
        c.stroke();
      }
      break;
    }
  }
}
function drawFace(c, cx, cy, R) {
  const ink = '#2d2016';
  // eyes
  for (const s of [-1, 1]) {
    c.fillStyle = ink;
    c.beginPath();
    c.ellipse(cx + s * R * 0.26, cy - R * 0.02, R * 0.085, R * 0.115, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.beginPath();
    c.arc(cx + s * R * 0.26 - R * 0.028, cy - R * 0.055, R * 0.032, 0, Math.PI * 2);
    c.fill();
  }
  // smile
  c.strokeStyle = ink;
  c.lineWidth = R * 0.05;
  c.lineCap = 'round';
  c.beginPath();
  c.arc(cx, cy + R * 0.1, R * 0.17, Math.PI * 0.2, Math.PI * 0.8);
  c.stroke();
  // blush
  c.fillStyle = 'rgba(255,120,140,0.35)';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(cx + s * R * 0.46, cy + R * 0.16, R * 0.11, R * 0.075, 0, 0, Math.PI * 2);
    c.fill();
  }
}

function leaf(c, x, y, size) {
  c.fillStyle = '#4caf50';
  c.beginPath();
  c.ellipse(x + size * 0.5, y, size, size * 0.45, -0.5, 0, Math.PI * 2);
  c.fill();
}
function dimples(c, cx, cy, R, color) {
  c.fillStyle = color;
  for (let i = 0; i < 26; i++) {
    const a = i * 2.399;
    const rr = R * ((i * 41 % 95) / 100);
    c.beginPath();
    c.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * 0.035, 0, Math.PI * 2);
    c.fill();
  }
}

// ---------------- Game state ----------------
let engine, world;
let fruits = [];          // matter bodies with .plugin.level
let score = 0;
let currentLevel = 0;     // fruit waiting to drop
let nextLevel = 0;
let aimX = 0;
let canDrop = true;
let gameOver = false;
let overflowMs = 0;
let lastSnapshot = null;  // state before the most recent drop
let powerups = { clear: { uses: 3, cdUntil: 0 }, undo: { uses: 3 } };
const CLEAR_COOLDOWN_MS = 30000;
const MERGE_LOCKOUT_MS = 150;   // a just-merged fruit can't merge again for a beat
let mergeQueue = [];
let rngPick = () => Math.floor(Math.random() * (MAX_DROP_LEVEL + 1));

const SIZE_SCALE = 1.38; // all pieces 38% bigger
function fruitRadius(level) { return FRUITS[level].rf * SIZE_SCALE * G.S; }

function makeFruit(level, x, y) {
  const r = fruitRadius(level);
  const b = Bodies.circle(x, y, r, {
    restitution: 0.25,
    friction: 0.015,
    frictionStatic: 0.03,
    frictionAir: 0.001,
    density: 0.0006,
    label: 'fruit',
  });
  b.plugin.level = level;
  b.plugin.born = performance.now();
  fruits.push(b);
  World.add(world, b);
  return b;
}

function buildWorld() {
  if (engine) Engine.clear(engine);
  engine = Engine.create();
  engine.gravity.y = 1.15;
  world = engine.world;
  fruits = [];
  mergeQueue = [];

  const t = 200; // wall thickness (thick so nothing tunnels)
  const opts = { isStatic: true, friction: 0.02, restitution: 0.1 };
  World.add(world, [
    Bodies.rectangle((G.left + G.right) / 2, G.bottom + t / 2, G.S + t * 2, t, opts),
    Bodies.rectangle(G.left - t / 2, G.H / 2 - 200, t, G.H + 1200, opts),
    Bodies.rectangle(G.right + t / 2, G.H / 2 - 200, t, G.H + 1200, opts),
  ]);

  // collisionActive is needed too: a fruit inside its merge lockout may already be
  // touching its twin when the lockout ends, and collisionStart won't fire again.
  const tryMerge = (ev) => {
    const now = performance.now();
    for (const pair of ev.pairs) {
      const a = pair.bodyA, b = pair.bodyB;
      if (a.label === 'fruit' && b.label === 'fruit' &&
          a.plugin.level === b.plugin.level &&
          !a.plugin.dead && !b.plugin.dead &&
          now - a.plugin.born >= MERGE_LOCKOUT_MS &&
          now - b.plugin.born >= MERGE_LOCKOUT_MS) {
        a.plugin.dead = b.plugin.dead = true;
        mergeQueue.push([a, b]);
      }
    }
  };
  Events.on(engine, 'collisionStart', tryMerge);
  Events.on(engine, 'collisionActive', tryMerge);
}

function newGame() {
  buildWorld();
  score = 0;
  gameOver = false;
  overflowMs = 0;
  lastSnapshot = null;
  powerups = { clear: { uses: 3, cdUntil: 0 }, undo: { uses: 3 } };
  currentLevel = rngPick();
  nextLevel = rngPick();
  aimX = (G.left + G.right) / 2;
  canDrop = true;

  updateHud();
  updateBestsHud();
  updatePowerupUi();
  drawNextPreview();
  document.getElementById('gameOverOverlay').classList.remove('active');
}

function processMerges() {
  while (mergeQueue.length) {
    const [a, b] = mergeQueue.shift();
    const level = a.plugin.level;
    const mx = (a.position.x + b.position.x) / 2;
    const my = (a.position.y + b.position.y) / 2;
    removeFruit(a); removeFruit(b);

    if (level === FRUITS.length - 1) {
      // two watermelons vanish
      score += WATERMELON_VANISH_POINTS;
      addPop(mx, my, fruitRadius(level), '#3f9e4d');
    } else {
      const nb = makeFruit(level + 1, mx, my);
      Body.setVelocity(nb, { x: 0, y: -1 });
      score += MERGE_POINTS[level + 1];
      addPop(mx, my, fruitRadius(level + 1), FRUITS[level + 1].color);
    }
  }
  updateHud();
}

function removeFruit(b) {
  World.remove(world, b);
  const i = fruits.indexOf(b);
  if (i >= 0) fruits.splice(i, 1);
}

// little pop animation records
let pops = [];
function addPop(x, y, r, color) {
  pops.push({ x, y, r, color, t: 0 });
}

// ---------------- Drop / input ----------------
function clampAim(x, level) {
  const r = fruitRadius(level);
  return Math.min(G.right - r - 2, Math.max(G.left + r + 2, x));
}

canvas.addEventListener('pointerdown', (e) => {
  if (gameOver) return;
  canvas.setPointerCapture(e.pointerId);
  aimX = clampAim(e.clientX - wrap.getBoundingClientRect().left, currentLevel);
});
canvas.addEventListener('pointermove', (e) => {
  if (gameOver) return;
  if (e.buttons || e.pointerType === 'touch') {
    aimX = clampAim(e.clientX - wrap.getBoundingClientRect().left, currentLevel);
  }
});
canvas.addEventListener('pointerup', () => {
  if (gameOver || !canDrop) return;
  dropFruit();
});

function snapshot() {
  return {
    score,
    currentLevel,
    nextLevel,
    fruits: fruits.map(f => ({ x: f.position.x, y: f.position.y, level: f.plugin.level })),
  };
}
function restoreSnapshot(s) {
  for (const f of [...fruits]) removeFruit(f);
  mergeQueue = [];
  for (const fs of s.fruits) {
    const b = makeFruit(fs.level, fs.x, fs.y);
    Body.setVelocity(b, { x: 0, y: 0 });
  }
  score = s.score;
  currentLevel = s.currentLevel;
  nextLevel = s.nextLevel;
  overflowMs = 0;
  aimX = clampAim(aimX, currentLevel);
  updateHud();
  drawNextPreview();
}

function dropFruit() {
  lastSnapshot = snapshot();
  const b = makeFruit(currentLevel, clampAim(aimX, currentLevel), G.dropY);
  Body.setVelocity(b, { x: 0, y: 2 });
  currentLevel = nextLevel;
  nextLevel = rngPick();
  aimX = clampAim(aimX, currentLevel);
  drawNextPreview();
  canDrop = false;
  setTimeout(() => { canDrop = true; }, 450);
  updatePowerupUi();
}

// ---------------- Powerups ----------------
document.getElementById('clearBtn').onclick = () => {
  if (gameOver) return;
  const p = powerups.clear;
  if (p.uses <= 0 || performance.now() < p.cdUntil) return;
  const doomed = fruits.filter(f => f.plugin.level < 4); // below lemon
  if (!doomed.length) return;
  lastSnapshot = snapshot();
  for (const f of doomed) {
    addPop(f.position.x, f.position.y, f.circleRadius, FRUITS[f.plugin.level].color);
    removeFruit(f);
  }
  p.uses--;
  p.cdUntil = performance.now() + CLEAR_COOLDOWN_MS;
  updatePowerupUi();
};

document.getElementById('undoBtn').onclick = () => {
  if (gameOver) return;
  const p = powerups.undo;
  if (p.uses <= 0 || !lastSnapshot) return;
  restoreSnapshot(lastSnapshot);
  lastSnapshot = null;
  p.uses--;
  updatePowerupUi();
};

function updatePowerupUi() {
  document.getElementById('clearUses').textContent = `×${powerups.clear.uses}`;
  document.getElementById('undoUses').textContent = `×${powerups.undo.uses}`;
  document.getElementById('clearBtn').disabled = powerups.clear.uses <= 0;
  document.getElementById('undoBtn').disabled = powerups.undo.uses <= 0 || !lastSnapshot;
}

function tickCooldowns() {
  const mask = document.getElementById('clearCd');
  const remaining = powerups.clear.cdUntil - performance.now();
  if (remaining > 0 && powerups.clear.uses > 0) {
    mask.classList.add('active');
    mask.textContent = Math.ceil(remaining / 1000) + 's';
  } else {
    mask.classList.remove('active');
  }
  // undo availability can change as drops happen
  document.getElementById('undoBtn').disabled = powerups.undo.uses <= 0 || !lastSnapshot || gameOver;
}

// ---------------- HUD ----------------
function updateHud() {
  document.getElementById('hudScore').textContent = score;
}
function drawNextPreview() {
  const cv = document.getElementById('nextCanvas');
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  const sp = getSprite(nextLevel);
  const d = 24;
  c.drawImage(sp, cv.width / 2 - d / 2, cv.height / 2 - d / 2, d, d);
}

// ---------------- Game over ----------------
function checkOverflow(dtMs) {
  let over = false;
  const now = performance.now();
  for (const f of fruits) {
    if (now - f.plugin.born < 1200) continue; // freshly dropped fruit gets a grace period
    if (f.position.y - f.circleRadius < G.lineY && Math.abs(f.velocity.y) < 2) {
      over = true;
      break;
    }
  }
  overflowMs = over ? overflowMs + dtMs : 0;
  if (overflowMs > 2500 && !gameOver) endGame();
}

function endGame() {
  gameOver = true;
  const records = reportScore(score);
  updateBestsHud();
  document.getElementById('finalScore').textContent = score;
  document.getElementById('recordNote').textContent =
    records.length ? `🏆 New ${records.join(', ')} record!` : '';
  const s = loadScores();
  document.getElementById('finalBests').innerHTML =
    `<span>Day <b>${s.daily.score}</b></span><span>Week <b>${s.weekly.score}</b></span><span>All time <b>${s.allTime}</b></span>`;
  document.getElementById('gameOverOverlay').classList.add('active');
}
document.getElementById('restartBtn').onclick = () => newGame();

// ---------------- Render ----------------
function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, G.W, G.H);

  // tank
  ctx.fillStyle = '#f2b56b';
  roundRect(ctx, G.left - G.wall, G.top - G.wall * 0.5, G.S + G.wall * 2, G.T + G.wall * 1.5, 10);
  ctx.fill();
  ctx.fillStyle = '#fff8ec';
  ctx.fillRect(G.left, G.top, G.S, G.T);

  // danger line
  const danger = overflowMs > 0;
  ctx.strokeStyle = danger ? 'rgba(232,56,79,0.9)' : 'rgba(0,0,0,0.15)';
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = danger ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(G.left, G.lineY);
  ctx.lineTo(G.right, G.lineY);
  ctx.stroke();
  ctx.setLineDash([]);

  // aim guide + waiting fruit
  if (!gameOver) {
    const r = fruitRadius(currentLevel);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 10]);
    ctx.beginPath();
    ctx.moveTo(aimX, G.dropY + r);
    ctx.lineTo(aimX, G.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    if (canDrop) {
      ctx.save();
      ctx.translate(aimX, G.dropY);
      drawSprite(ctx, currentLevel, r);
      ctx.restore();
    }
  }

  // fruits
  for (const f of fruits) {
    const r = f.circleRadius;
    ctx.save();
    ctx.translate(f.position.x, f.position.y);
    ctx.rotate(f.angle);
    drawSprite(ctx, f.plugin.level, r);
    ctx.restore();
  }

  // pops
  for (const p of pops) {
    const k = p.t / 300;
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (1 + k * 0.8), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  pops = pops.filter(p => p.t < 300);
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

// ---------------- Main loop ----------------
let lastT = performance.now();
let acc = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (document.hidden) return;

  acc += dt;
  const step = 1000 / 60;
  while (acc >= step) {
    Engine.update(engine, step);
    processMerges();
    if (!gameOver) checkOverflow(step);
    acc -= step;
  }
  for (const p of pops) p.t += dt;
  tickCooldowns();
  draw();
}

// don't lose a record if the app is closed mid-game
window.addEventListener('pagehide', () => { if (!gameOver && score > 0) { reportScore(score); } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !gameOver && score > 0) { reportScore(score); updateBestsHud(); }
});

// ---------------- Boot ----------------
computeLayout();
newGame();
requestAnimationFrame(loop);

window.addEventListener('resize', () => {
  const old = { ...G };
  computeLayout();
  if (Math.abs(old.S - G.S) < 4 && Math.abs(old.T - G.T) < 4) return;
  // rebuild the physics world at the new size but carry every fruit across —
  // a rotation or window resize must never reset the game
  const rel = fruits.map(f => ({
    level: f.plugin.level,
    x: (f.position.x - old.left) / old.S,
    y: (old.bottom - f.position.y) / old.S,
  }));
  buildWorld();
  for (const fr of rel) {
    const b = makeFruit(fr.level, G.left + fr.x * G.S, G.bottom - fr.y * G.S);
    Body.setVelocity(b, { x: 0, y: 0 });
  }
  lastSnapshot = null; // coordinates from the old layout are stale
  overflowMs = 0;
  aimX = clampAim((G.left + G.right) / 2, currentLevel);
  updatePowerupUi();
});
