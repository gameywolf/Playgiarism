/* Awesome Falling — endless rappelling race. You swing off a cliff wall on a rope;
   hold to rappel down, release to stop. Dodge the crystals, outrun the lava,
   and rack up tricks (hoops, bullseyes, hop chains) to charge a Frenzy burst.
   Score is metres descended. */
'use strict';

const SCORE_KEY = 'awesomefalling.scores.v1';
const COIN_KEY = 'awesomefalling.coins.v1';   // lifetime coin tally (no store; just a keepsake)

const DEATH_MS = 1200;
const POPUP_MS = 900;
const FRENZY_MS = 4200;

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
let climberY = 0;        // world px descended (world y grows downward)
let prevY = 0;
let bonus = 0;           // trick metres
let dist = 0;            // metres (depth + trick bonus)
let coins = 0;
let held = false;
let vy = 0;              // descent speed
let px = 0, vx = 0;      // swing: distance from the wall face and outward velocity
let lavaY = 0;           // world y of the lava front
let feats = [];          // spikes / targets / pads / rings
let coinsW = [];         // {wy, cpx, spin, gone}
let boulders = [];       // {wy, cpx, r, rot}
let warns = [];          // boulder warnings {t, ms, cpx}
let sparks = [];         // {x, wy, vx, vy, t, life, col, size}
let popups = [];         // {x, wy, txt, col, t}
let genY = 0;            // spawn frontier (world y)
let charge = 0, frenzyT = 0;
let ride = null;         // rainbow ride: bezier through (px, worldY) space
let lastRide = null;     // finished ride kept around while its arc fades
let rocketT = 0, magnetT = 0;
let boulderT = 0;
let deathT = 0, deathCause = 'spike';
let death = { x: 0, y: 0, vx: 0, vy: 0, spin: 0 };
let runRecords = new Set();
let pulse = 0;

// ---------------- Layout ----------------
const area = document.querySelector('.game-area');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = 1, G = null;   // {w, h, unit, wallX, A, kickV, gPull, bodyR, py}

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = area.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const prev = G;
  const wallX = r.width * 0.16;   // cliff face on the left, swing out to the right
  // the swing is a bounce–glide cycle: kick off the wall, decelerate, drift back.
  // kickV/gPull are derived from amplitude + period so tuning stays in one place.
  const A = (r.width - wallX) * 0.62, T = 1.05;
  G = {
    w: r.width, h: r.height,
    unit: r.height,
    wallX, A,
    kickV: 4 * A / T,
    gPull: 8 * A / (T * T),
    bodyR: r.height * 0.035,
    py: r.height * 0.30,       // climber's fixed screen y
  };
  if (prev) {                   // keep the swing phase through a resize
    px = px / prev.A * A;
    vx = vx / prev.kickV * G.kickV;
  }
}

const PXPM = () => G.unit * 0.085;
const camY = () => climberY - G.py;

// ---------------- Difficulty ----------------
const maxVy = () => G.unit * (1.05 + Math.min(0.35, dist / 800 * 0.35));
const lavaSpd = () => G.unit * (0.22 + Math.min(0.5, dist / 900 * 0.5));
const gapMin = () => G.unit * (0.50 - Math.min(0.27, dist / 1000 * 0.27));
const gapMax = () => G.unit * (0.85 - Math.min(0.40, dist / 1000 * 0.40));

function newGame() {
  phase = 'ready';
  climberY = 0; prevY = 0;
  bonus = 0; dist = 0; coins = 0;
  held = false; vy = 0;
  px = G.A * 0.3; vx = G.kickV * 0.5;
  lavaY = -G.unit * 1.7;
  feats = []; coinsW = []; boulders = []; warns = [];
  sparks = []; popups = [];
  genY = G.unit * 0.9;   // breathing room before the first feature arrives
  charge = 0; frenzyT = 0;
  ride = null; lastRide = null;
  rocketT = 0; magnetT = 0;
  boulderT = 6;
  deathT = 0;
  runRecords = new Set();
  while (genY < climberY + G.h * 2.2) spawnFeature();   // pre-fill the visible cliff
  updateHud();
  updateBestsHud();
  document.getElementById('overOverlay').classList.remove('active');
}

function updateHud() {
  document.getElementById('hudDist').textContent = dist + ' m';
  document.getElementById('hudCoins').textContent = '🪙 ' + coins;
}

// ---------------- Spawning ----------------
// deterministic pseudo-random for textures that must not flicker between frames
function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

function spawnFeature() {
  const u = G.unit;
  const dm = genY / PXPM();
  const stage = dm < 80 ? 0 : dm < 260 ? 1 : 2;
  const roll = Math.random();
  let used = u * 0.08;

  if (roll < 0.30) {
    // crystal on the wall — longer ones force a descent at the apex of the swing.
    // the first stretch keeps them stubby so the swing rhythm can sink in first
    const maxFrac = dm < 60 ? 0.34 : 0.45 + Math.min(0.4, dm / 700 * 0.4);
    feats.push(spike(genY, G.A * (0.2 + Math.random() * (maxFrac - 0.2))));
  } else if (roll < 0.44 && stage >= 1) {
    // cluster: stacked crystals with one safe parking gap between groups
    const n = stage === 2 && Math.random() < 0.5 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      feats.push(spike(genY + i * u * 0.14, G.A * (0.2 + Math.random() * 0.45)));
    }
    used = u * 0.14 * (n - 1) + u * 0.08;
  } else if (roll < 0.54) {
    // hoop floating off the wall — fall through it for charge
    feats.push({
      kind: 'ring', y: genY + u * 0.07,
      cx: G.A * (0.4 + Math.random() * 0.45), hw: u * 0.075, got: false,
    });
    used = u * 0.15;
  } else if (roll < 0.62) {
    // bullseye painted on the wall — touch down inside it
    feats.push({ kind: 'target', y: genY + u * 0.05, h: u * 0.1, used: false });
    used = u * 0.11;
  } else if (roll < 0.72 && stage >= 1) {
    // hop chain: three numbered pads that bounce you like the wall does
    const set = { n: 0 };
    for (let i = 0; i < 3; i++) {
      feats.push({
        kind: 'pad', y: genY + u * (0.05 + i * 0.2), h: u * 0.05,
        prot: G.A * (0.3 + Math.random() * 0.25), idx: i, set, hit: false, hitT: 0,
      });
    }
    used = u * 0.5;
  } else if (roll < 0.80) {
    // cloud — brush it to ride a rainbow down the wall
    feats.push({
      kind: 'cloud', y: genY + u * 0.08,
      cx: G.A * (0.45 + Math.random() * 0.4), r: u * 0.05, got: false,
    });
    used = u * 0.16;
  } else if (roll < 0.85 && stage >= 1) {
    // rocket boost pickup: short invulnerable burst of speed
    feats.push({ kind: 'rocket', y: genY + u * 0.06, cx: G.A * (0.35 + Math.random() * 0.45), got: false });
    used = u * 0.12;
  } else if (roll < 0.89 && stage >= 1) {
    // magnet pickup: coins fly to you for a while
    feats.push({ kind: 'magnet', y: genY + u * 0.06, cx: G.A * (0.35 + Math.random() * 0.45), got: false });
    used = u * 0.12;
  } else {
    // coin trail drifting with the swing
    const n = 4 + ((Math.random() * 4) | 0);
    const base = G.A * (0.3 + Math.random() * 0.5);
    const wig = Math.random() < 0.5 ? 0 : G.A * 0.18;
    for (let i = 0; i < n; i++) {
      coinsW.push({
        wy: genY + i * u * 0.07,
        cpx: Math.max(G.A * 0.12, base + Math.sin(i / (n - 1) * Math.PI) * wig),
        spin: Math.random() * 6, gone: false,
      });
    }
    used = n * u * 0.07;
  }
  genY += used + gapMin() + Math.random() * (gapMax() - gapMin());
}

function spike(y, len) {
  return { kind: 'spike', y, len, h: G.unit * 0.06 + len * 0.08 };
}

// ---------------- Tricks ----------------
function addCharge(v) {
  if (frenzyT > 0) return;
  charge = Math.min(1, charge + v);
  if (charge >= 1) {
    frenzyT = FRENZY_MS;
    popups.push({ x: G.wallX + px, wy: climberY - G.unit * 0.06, txt: 'FRENZY!', col: '#ff5e7e', t: 0 });
    if (navigator.vibrate) navigator.vibrate(30);
  }
}

function trick(txt, metres, chg, x, wy) {
  bonus += metres;
  addCharge(chg);
  popups.push({ x, wy, txt: `${txt} +${metres}m`, col: '#ffd166', t: 0 });
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({
      x, wy, vx: Math.cos(a) * G.unit * 0.18, vy: Math.sin(a) * G.unit * 0.18,
      t: 0, life: 350, col: '#ffe08a', size: G.unit * 0.006,
    });
  }
}

function onWallContact() {
  for (let i = 0; i < 4; i++) {
    sparks.push({
      x: G.wallX + Math.random() * G.unit * 0.01, wy: climberY + (Math.random() - 0.5) * G.bodyR,
      vx: G.unit * (0.05 + Math.random() * 0.12), vy: (Math.random() - 0.5) * G.unit * 0.1,
      t: 0, life: 300, col: '#d9c4a8', size: G.unit * 0.004,
    });
  }
  for (const f of feats) {
    if (f.kind === 'target' && !f.used && Math.abs(climberY - f.y) < f.h / 2) {
      f.used = true;
      trick('Bullseye!', 8, 0.22, G.wallX + G.unit * 0.02, f.y);
    }
  }
}

function padHit(pad) {
  pad.hit = true;
  pad.hitT = 1;
  pad.set.n++;
  if (pad.set.n === 3) trick('Hop Chain!', 10, 0.26, G.wallX + pad.prot, pad.y);
  else trick(`${pad.idx + 1}!`, 2, 0.08, G.wallX + pad.prot, pad.y);
}

// ---------------- Death / finish ----------------
function die(cause) {
  if (phase !== 'run') return;
  phase = 'dying';
  deathCause = cause;
  deathT = 0;
  death = {
    x: G.wallX + px, y: G.py,
    vx: G.unit * (0.25 + Math.random() * 0.15), vy: -G.unit * 0.45, spin: 0,
  };
  const cols = cause === 'lava' ? ['#ff8c42', '#ffd166', '#ff5e7e'] : ['#b985f4', '#ffd166', '#fff1c9'];
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, s = G.unit * (0.15 + Math.random() * 0.5);
    sparks.push({
      x: death.x, wy: climberY, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      t: 0, life: 400 + Math.random() * 500,
      col: cols[(Math.random() * cols.length) | 0],
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
  document.getElementById('overTitle').textContent =
    { spike: 'Spiked!', lava: 'Toasted!', boulder: 'Squashed!' }[deathCause] || 'Wiped out!';
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

// ---------------- Update ----------------
function update(dtms) {
  const dt = dtms / 1000;
  pulse += dtms;
  const u = G.unit;

  for (const s of sparks) {
    s.t += dtms;
    s.x += s.vx * dt;
    s.wy += s.vy * dt;
    s.vy += u * 1.2 * dt;
  }
  sparks = sparks.filter(s => s.t < s.life);
  for (const p of popups) p.t += dtms;
  popups = popups.filter(p => p.t < POPUP_MS);

  if (phase === 'dying') {
    deathT += dtms;
    death.vy += u * 2.4 * dt;
    death.x += death.vx * dt;
    death.y += death.vy * dt;
    death.spin += dt * 6;
    if (deathT >= DEATH_MS) finishRun();
    return;
  }
  if (phase === 'over') return;

  // ---- swing (runs in 'ready' too, so the climber dangles invitingly) ----
  if (!ride) {
    vx -= G.gPull * dt;
    px += vx * dt;
    if (phase === 'run' && vx < 0) {
      for (const f of feats) {
        if (f.kind === 'pad' && !f.hit && px <= f.prot &&
            Math.abs(climberY - f.y) < f.h / 2 + G.bodyR * 0.5) {
          px = f.prot;
          vx = G.kickV;
          padHit(f);
          break;
        }
      }
    }
    if (px <= 0 && vx < 0) {
      px = 0;
      vx = G.kickV;
      if (phase === 'run') onWallContact();
    }
  }
  for (const f of feats) if (f.hitT > 0) f.hitT = Math.max(0, f.hitT - dt * 3);
  if (lastRide) { lastRide.fade += dtms; if (lastRide.fade > 500) lastRide = null; }

  if (phase !== 'run') return;

  // ---- descent ----
  const frenzy = frenzyT > 0;
  if (frenzy) frenzyT -= dtms;
  if (frenzy && frenzyT <= 0) charge = 0;
  if (rocketT > 0) rocketT -= dtms;
  if (magnetT > 0) magnetT -= dtms;
  const shielded = frenzy || rocketT > 0 || !!ride;
  prevY = climberY;
  if (ride) {
    // carried along the rainbow: swing physics is suspended for the arc
    ride.t += dtms;
    const k = Math.min(1, ride.t / ride.dur);
    const bez = (a, b, c) => (1 - k) * (1 - k) * a + 2 * (1 - k) * k * b + k * k * c;
    px = bez(ride.p0x, ride.cxp, ride.p1x);
    climberY = bez(ride.p0y, ride.cyp, ride.p1y);
    vy = maxVy();
    if (k >= 1) {
      lastRide = ride;
      lastRide.fade = 0;
      ride = null;
      vx = G.kickV * 0.7;
      rocketT = Math.max(rocketT, 350);   // grace so the drop-off can't dump you on a crystal
    }
  } else {
    const wantV = rocketT > 0 ? maxVy() * 1.8 : frenzy ? maxVy() * 1.4 : held ? maxVy() : 0;
    vy += (wantV - vy) * Math.min(1, dt * 7);
    climberY += vy * dt;
  }
  const m = Math.floor(Math.max(0, climberY) / PXPM()) + bonus;
  if (m !== dist) { dist = m; updateHud(); }

  // ---- lava ----
  let sp = lavaSpd();
  if (climberY - lavaY > u * 1.35) sp *= 1.7;   // rubber-band so it always looms
  lavaY += sp * dt;
  if (climberY - lavaY > u * 2.2) lavaY = climberY - u * 2.2;
  if (shielded) lavaY = Math.min(lavaY, climberY - u * 0.3);
  else if (lavaY >= climberY - G.bodyR) return die('lava');

  // ---- spawn ----
  while (genY < climberY + G.h * 2.2) spawnFeature();
  if (dist > 120) {
    boulderT -= dt;
    if (boulderT <= 0) {
      // lanes hug the wall so a full swing-out always clears them
      warns.push({ t: 0, ms: 850, cpx: G.A * (0.05 + Math.random() * 0.17) });
      boulderT = Math.max(3.5, 8 - dist / 300) * (0.7 + Math.random() * 0.6);
    }
  }
  for (const w of warns) {
    w.t += dtms;
    if (w.t >= w.ms) {
      // spawned a full swing-period's worth of approach above the climber, so
      // modulating descent speed can always shift the pass into a safe phase
      boulders.push({ wy: climberY - u * 1.15, cpx: w.cpx, r: u * 0.05, rot: 0 });
    }
  }
  warns = warns.filter(w => w.t < w.ms);

  // ---- hazards ----
  if (!shielded) {
    for (const f of feats) {
      if (f.kind === 'spike' &&
          Math.abs(climberY - f.y) < f.h * 0.4 + G.bodyR * 0.6 &&
          px < f.len) return die('spike');
    }
  }
  for (const b of boulders) {
    b.wy += u * 2.1 * dt;
    b.rot += dt * 4;
    if (!shielded &&
        Math.abs(b.wy - climberY) < b.r + G.bodyR * 0.8 &&
        Math.abs(px - b.cpx) < b.r + G.bodyR * 0.7) return die('boulder');
  }
  boulders = boulders.filter(b => b.wy < camY() + G.h + u * 0.2);

  // ---- rings, clouds and pickups ----
  for (const f of feats) {
    if (f.got) continue;
    if (f.kind === 'ring' &&
        prevY <= f.y && climberY > f.y && Math.abs(px - f.cx) < f.hw) {
      f.got = true;
      trick('Hoop!', 5, 0.2, G.wallX + f.cx, f.y);
    } else if (f.kind === 'cloud' && !ride &&
        Math.abs(px - f.cx) < f.r + G.bodyR && Math.abs(climberY - f.y) < f.r + G.bodyR) {
      f.got = true;
      ride = {
        t: 0, dur: 800, fade: 0,
        p0x: px, p0y: climberY,
        cxp: px + G.A * 0.25, cyp: climberY + u * 0.5,
        p1x: G.A * 0.35, p1y: climberY + u * 0.95,
      };
      trick('Rainbow!', 6, 0.18, G.wallX + px, climberY);
    } else if (f.kind === 'rocket' &&
        Math.abs(px - f.cx) < G.bodyR + u * 0.03 && Math.abs(climberY - f.y) < G.bodyR + u * 0.03) {
      f.got = true;
      rocketT = 1500;
      trick('Rocket!', 4, 0.1, G.wallX + f.cx, f.y);
    } else if (f.kind === 'magnet' &&
        Math.abs(px - f.cx) < G.bodyR + u * 0.03 && Math.abs(climberY - f.y) < G.bodyR + u * 0.03) {
      f.got = true;
      magnetT = 8000;
      popups.push({ x: G.wallX + f.cx, wy: f.y, txt: 'Magnet!', col: '#7be9ff', t: 0 });
    }
  }
  feats = feats.filter(f => f.y > camY() - u * 0.3 && !f.got);

  // ---- coins ----
  for (const c of coinsW) {
    c.spin += dt * 4;
    if (magnetT > 0 && !c.gone) {
      const dxp = px - c.cpx, dyp = climberY - c.wy;
      if (Math.hypot(dxp, dyp) < u * 0.32) {
        c.cpx += dxp * Math.min(1, dt * 8);
        c.wy += dyp * Math.min(1, dt * 8);
      }
    }
    if (!c.gone && Math.hypot(c.cpx - px, c.wy - climberY) < G.bodyR + u * 0.028) {
      c.gone = true;
      const v = frenzy ? 2 : 1;
      coins += v;
      updateHud();
      popups.push({ x: G.wallX + c.cpx, wy: c.wy, txt: '+' + v, col: '#ffd166', t: 0 });
    }
  }
  coinsW = coinsW.filter(c => !c.gone && c.wy > camY() - u * 0.1);

  // frenzy / rainbow / rocket trail
  if (frenzy || ride || rocketT > 0) {
    sparks.push({
      x: G.wallX + px + (Math.random() - 0.5) * G.bodyR, wy: climberY - G.bodyR,
      vx: (Math.random() - 0.5) * u * 0.1, vy: -u * (0.1 + Math.random() * 0.2),
      t: 0, life: 400,
      col: rocketT > 0 && !ride ? '#ff8c42' : `hsl(${(pulse / 3) % 360},90%,65%)`,
      size: u * 0.007,
    });
  }
}

// ---------------- Drawing ----------------
function lerpCol(a, b, k) {
  const pa = [1, 3, 5].map(i => parseInt(a.substr(i, 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.substr(i, 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('');
}

function drawSky() {
  const k = Math.min(1, dist / 1200);   // deeper = duskier
  const g = ctx.createLinearGradient(0, 0, 0, G.h);
  g.addColorStop(0, lerpCol('#8fd0ff', '#31215e', k));
  g.addColorStop(0.55, lerpCol('#b9e2ff', '#6d4a86', k));
  g.addColorStop(1, lerpCol('#e6f4ff', '#c96f8a', k));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, G.w, G.h);

  // clouds drift up as you drop
  ctx.fillStyle = '#ffffff2e';
  const cs = climberY * 0.12;
  for (let i = 0; i < 6; i++) {
    const cy = ((i * G.h * 0.43 + cs) % (G.h * 1.6) + G.h * 1.6) % (G.h * 1.6) - G.h * 0.3;
    const cx = G.wallX + (G.w - G.wallX) * (0.1 + hash(i * 5.5) * 0.7);
    const cw = G.h * (0.09 + hash(i * 9.1) * 0.1);
    ctx.beginPath();
    for (let k2 = -1; k2 <= 1; k2++) {
      const kw = cw * (1 - Math.abs(k2) * 0.34);
      ctx.ellipse(cx + k2 * cw * 0.72, cy + Math.abs(k2) * cw * 0.06, kw, kw * 0.34, 0, 0, 7);
    }
    ctx.fill();
  }
}

// jagged vertical edge as a chunked polyline; chunk offsets are hashed on world
// position so the rock face stays put while the camera slides down it
function edgePoints(baseX, sign, chunk, para, jag) {
  const cy = camY() * para;
  const i0 = Math.floor(cy / chunk) - 1;
  const pts = [];
  for (let i = i0; i < i0 + Math.ceil(G.h / chunk) + 2; i++) {
    pts.push([baseX + sign * hash(i * 2.31) * jag, i * chunk - cy]);
  }
  return pts;
}

function drawFarCliff() {
  const pts = edgePoints(G.w * 0.92, -1, G.unit * 0.14, 0.35, G.w * 0.03);
  ctx.fillStyle = '#a2bdd8';
  ctx.beginPath();
  ctx.moveTo(G.w, -10);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(G.w, G.h + 10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8aa8c6';
  const cy = camY() * 0.35;
  for (let i = Math.floor(cy / (G.unit * 0.3)); i * G.unit * 0.3 < cy + G.h; i++) {
    if (hash(i * 7.7) < 0.5) continue;
    const len = G.w * (0.03 + hash(i * 3.3) * 0.04);
    ctx.fillRect(G.w - len, i * G.unit * 0.3 - cy, len, Math.max(2, G.unit * 0.006));
  }
}

function drawWall() {
  const pts = edgePoints(G.wallX, 1, G.unit * 0.09, 1, G.w * 0.025);
  const g = ctx.createLinearGradient(G.wallX + G.w * 0.03, 0, 0, 0);
  g.addColorStop(0, '#96704f');
  g.addColorStop(0.4, '#83593d');
  g.addColorStop(1, '#6d4a35');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-10, -10);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(-10, G.h + 10);
  ctx.closePath();
  ctx.fill();
  // sun-catch on the rim
  ctx.strokeStyle = '#f5d9a955';
  ctx.lineWidth = Math.max(1.5, G.unit * 0.004);
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pts[i][0], pts[i][1]);
  ctx.stroke();
  // strata + pebbles
  const step = G.unit * 0.22;
  for (let i = Math.floor(camY() / step); i * step < camY() + G.h; i++) {
    const y = i * step - camY();
    ctx.fillStyle = '#00000016';
    ctx.fillRect(0, y, G.wallX + G.w * 0.01, Math.max(2, G.unit * (0.006 + hash(i * 4.1) * 0.012)));
    if (hash(i * 9.3) > 0.4) {
      ctx.fillStyle = '#ffffff10';
      ctx.beginPath();
      ctx.arc(G.wallX - G.w * (0.03 + hash(i * 6.2) * 0.1), y + step * 0.5, G.unit * 0.008, 0, 7);
      ctx.fill();
    }
  }
}

function drawSpike(f) {
  const y = f.y - camY();
  const tip = G.wallX + f.len;
  ctx.fillStyle = '#b985f4';
  ctx.beginPath();
  ctx.moveTo(G.wallX - 2, y - f.h / 2);
  ctx.lineTo(tip, y);
  ctx.lineTo(G.wallX - 2, y + f.h / 2);
  ctx.closePath();
  ctx.fill();
  // lit facet
  ctx.fillStyle = '#d9b8ff';
  ctx.beginPath();
  ctx.moveTo(G.wallX - 2, y - f.h / 2);
  ctx.lineTo(tip, y);
  ctx.lineTo(G.wallX - 2, y - f.h * 0.1);
  ctx.closePath();
  ctx.fill();
  // little sister crystal
  ctx.fillStyle = '#a06fe0';
  ctx.beginPath();
  ctx.moveTo(G.wallX - 2, y + f.h * 0.2);
  ctx.lineTo(G.wallX + f.len * 0.4, y + f.h * 0.42);
  ctx.lineTo(G.wallX - 2, y + f.h * 0.62);
  ctx.closePath();
  ctx.fill();
  // glint
  ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.3 * Math.sin(pulse / 300 + f.y)})`;
  ctx.beginPath();
  ctx.arc(tip - f.len * 0.18, y - f.h * 0.08, G.unit * 0.005, 0, 7);
  ctx.fill();
}

function drawTarget(f) {
  const y = f.y - camY();
  const cx = G.wallX - G.w * 0.055, r = f.h * 0.42;
  const cols = f.used ? ['#c9beb0', '#e8e2d8', '#c9beb0'] : ['#ff7043', '#ffefd4', '#ff7043'];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = cols[i];
    ctx.beginPath();
    ctx.arc(cx, y, r * (1 - i * 0.33), 0, 7);
    ctx.fill();
  }
  if (f.used) {
    ctx.strokeStyle = '#4a8a4a';
    ctx.lineWidth = Math.max(2, G.unit * 0.006);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.4, y);
    ctx.lineTo(cx - r * 0.1, y + r * 0.35);
    ctx.lineTo(cx + r * 0.5, y - r * 0.4);
    ctx.stroke();
  }
}

function drawPad(f) {
  const y = f.y - camY();
  const len = f.prot * (1 + f.hitT * 0.12);
  const x = G.wallX + len;
  const h = f.h;
  ctx.fillStyle = f.hit ? '#8adf9c' : '#59c96f';
  ctx.beginPath();
  ctx.moveTo(G.wallX - 2, y - h * 0.3);
  ctx.lineTo(x - h * 0.5, y - h * 0.5);
  ctx.quadraticCurveTo(x + h * 0.4, y, x - h * 0.5, y + h * 0.5);
  ctx.lineTo(G.wallX - 2, y + h * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#3da354';
  ctx.fillRect(G.wallX, y + h * 0.18, len - h * 0.5, h * 0.32);
  // number disc at the tip
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x - h * 0.15, y, h * 0.42, 0, 7);
  ctx.fill();
  ctx.fillStyle = '#2f7a40';
  ctx.font = `800 ${h * 0.62}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(f.idx + 1), x - h * 0.15, y + h * 0.04);
}

function drawRing(f) {
  const y = f.y - camY();
  const x = G.wallX + f.cx;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#f0a92e';
  ctx.lineWidth = Math.max(3, G.unit * 0.012);
  ctx.beginPath();
  ctx.ellipse(0, 0, f.hw, f.hw * 0.32, 0, 0, 7);
  ctx.stroke();
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = Math.max(1.5, G.unit * 0.005);
  ctx.beginPath();
  ctx.ellipse(0, -G.unit * 0.003, f.hw * 0.92, f.hw * 0.27, 0, Math.PI, Math.PI * 2);
  ctx.stroke();
  const a = pulse / 260 + f.y;
  ctx.fillStyle = '#fff7d9';
  ctx.beginPath();
  ctx.arc(Math.cos(a) * f.hw, Math.sin(a) * f.hw * 0.32, G.unit * 0.005, 0, 7);
  ctx.fill();
  ctx.restore();
}

function drawCoin(c) {
  const y = c.wy - camY();
  const x = G.wallX + c.cpx;
  const r = G.unit * 0.026;
  const sq = Math.abs(Math.cos(c.spin));
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

function drawBoulder(b) {
  const y = b.wy - camY();
  const x = G.wallX + b.cpx;
  if (y < -b.r) {   // still above the screen — keep flashing where it will fall
    drawWarnMarker(x, pulse);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(b.rot);
  ctx.fillStyle = '#8a6a4d';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    const rr = b.r * (0.85 + hash(i * 3.7) * 0.3);
    (i ? ctx.lineTo : ctx.moveTo).call(ctx, Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#00000030';
  ctx.lineWidth = Math.max(1.5, G.unit * 0.004);
  ctx.beginPath();
  ctx.moveTo(-b.r * 0.4, -b.r * 0.2);
  ctx.lineTo(0, b.r * 0.15);
  ctx.lineTo(b.r * 0.35, -b.r * 0.1);
  ctx.stroke();
  ctx.restore();
}

function drawCloud(f) {
  const y = f.y - camY() + Math.sin(pulse / 400 + f.y) * G.unit * 0.008;
  const x = G.wallX + f.cx;
  const r = f.r;
  ctx.fillStyle = '#ffffffdd';
  ctx.beginPath();
  for (let k = -1; k <= 1; k++) {
    const kw = r * (1 - Math.abs(k) * 0.3);
    ctx.ellipse(x + k * r * 0.8, y + Math.abs(k) * r * 0.12, kw, kw * 0.62, 0, 0, 7);
  }
  ctx.fill();
  // rainbow hint peeking out of the cloud
  const cols = ['#ff5e5e', '#ffe14d', '#4dc0ff'];
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = cols[i];
    ctx.lineWidth = Math.max(1.5, G.unit * 0.004);
    ctx.beginPath();
    ctx.arc(x, y + r * 0.3, r * (0.85 - i * 0.16), Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
}

function drawRocketItem(f) {
  const y = f.y - camY();
  const x = G.wallX + f.cx;
  const s = G.unit * 0.028;
  ctx.fillStyle = `rgba(255,209,102,${0.2 + 0.15 * Math.sin(pulse / 200)})`;
  ctx.beginPath(); ctx.arc(x, y, s * 2.1, 0, 7); ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  // pointing down — it wants to take you that way
  ctx.fillStyle = '#d8dbe8';
  ctx.beginPath();
  ctx.roundRect(-s * 0.4, -s * 0.9, s * 0.8, s * 1.4, s * 0.35);
  ctx.fill();
  ctx.fillStyle = '#ff5e7e';
  ctx.beginPath();
  ctx.moveTo(-s * 0.4, s * 0.5); ctx.lineTo(0, s * 1.2); ctx.lineTo(s * 0.4, s * 0.5);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#8b90a8';
  ctx.beginPath();
  ctx.moveTo(-s * 0.4, -s * 0.5); ctx.lineTo(-s * 0.95, -s * 1.05); ctx.lineTo(-s * 0.4, -s * 0.15);
  ctx.moveTo(s * 0.4, -s * 0.5); ctx.lineTo(s * 0.95, -s * 1.05); ctx.lineTo(s * 0.4, -s * 0.15);
  ctx.fill();
  ctx.fillStyle = '#7be9ff';
  ctx.beginPath(); ctx.arc(0, -s * 0.25, s * 0.24, 0, 7); ctx.fill();
  ctx.restore();
}

function drawMagnetItem(f) {
  const y = f.y - camY();
  const x = G.wallX + f.cx;
  const s = G.unit * 0.026;
  ctx.fillStyle = `rgba(123,233,255,${0.2 + 0.15 * Math.sin(pulse / 200)})`;
  ctx.beginPath(); ctx.arc(x, y, s * 2.1, 0, 7); ctx.fill();
  ctx.strokeStyle = '#ff5e5e';
  ctx.lineWidth = s * 0.7;
  ctx.beginPath();
  ctx.arc(x, y - s * 0.25, s * 0.85, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ff5e5e';
  ctx.fillRect(x - s * 1.2, y - s * 0.3, s * 0.7, s * 0.8);
  ctx.fillRect(x + s * 0.5, y - s * 0.3, s * 0.7, s * 0.8);
  ctx.fillStyle = '#f4f7ff';
  ctx.fillRect(x - s * 1.2, y + s * 0.2, s * 0.7, s * 0.45);
  ctx.fillRect(x + s * 0.5, y + s * 0.2, s * 0.7, s * 0.45);
}

function drawRideArc(r, fadeK) {
  const lw = Math.max(2, G.unit * 0.008);
  const cols = ['#ff5e5e', '#ffb14d', '#ffe14d', '#67d97c', '#4dc0ff', '#b985f4'];
  ctx.globalAlpha = 0.85 * (1 - fadeK);
  for (let i = 0; i < cols.length; i++) {
    ctx.strokeStyle = cols[i];
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(G.wallX + r.p0x, r.p0y - camY() + i * lw);
    ctx.quadraticCurveTo(
      G.wallX + r.cxp, r.cyp - camY() + i * lw,
      G.wallX + r.p1x, r.p1y - camY() + i * lw);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawWarn(w) { drawWarnMarker(G.wallX + w.cpx, w.t); }

function drawWarnMarker(x, t) {
  const on = Math.floor(t / 130) % 2 === 0;
  const s = G.unit * 0.05;
  ctx.globalAlpha = on ? 1 : 0.55;
  ctx.fillStyle = '#ff5e7e';
  ctx.beginPath();
  ctx.moveTo(x - s, G.h * 0.02);
  ctx.lineTo(x + s, G.h * 0.02);
  ctx.lineTo(x, G.h * 0.02 + s * 1.4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${s}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', x, G.h * 0.02 + s * 0.5);
  ctx.globalAlpha = 1;
}

function drawClimber() {
  const dying = phase === 'dying';
  const x = dying ? death.x : G.wallX + px;
  const y = dying ? death.y : G.py;
  const r = G.bodyR;

  if (!dying) {
    // rope from the rim above, bowing with the swing
    const ax = G.wallX + px * 0.1;
    ctx.strokeStyle = '#e8d0a0';
    ctx.lineWidth = Math.max(2, G.unit * 0.005);
    ctx.beginPath();
    ctx.moveTo(ax, -G.h * 0.03);
    ctx.quadraticCurveTo((ax + x) / 2 - px * 0.14, y * 0.45, x, y - r * 1.1);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);   // the sprite is authored wall-on-the-right; mirror it
  if (dying) ctx.rotate(death.spin);
  else ctx.rotate(Math.max(-0.45, Math.min(0.45, -vx / G.kickV * 0.35 + vy / (G.unit * 1.4) * 0.2)));

  if (frenzyT > 0 && !dying) {
    ctx.fillStyle = `hsla(${(pulse / 3) % 360},90%,65%,0.3)`;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.9, 0, 7); ctx.fill();
  }

  // raised rope arm
  ctx.strokeStyle = '#3aa86b';
  ctx.lineWidth = r * 0.3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r * 0.1, -r * 0.35);
  ctx.lineTo(r * 0.05, -r * 1.15);
  ctx.stroke();
  // legs braced toward the wall
  ctx.strokeStyle = '#2a2145';
  ctx.lineWidth = r * 0.34;
  ctx.beginPath();
  ctx.moveTo(r * 0.1, r * 0.55);
  ctx.lineTo(r * 0.85, r * 0.8 + Math.sin(pulse / 140) * r * 0.06);
  ctx.moveTo(-r * 0.15, r * 0.6);
  ctx.lineTo(r * 0.6, r * 1.05);
  ctx.stroke();
  // body
  ctx.fillStyle = '#5ede8f';
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.62, r * 0.78, 0, 0, 7);
  ctx.fill();
  // harness
  ctx.fillStyle = '#ff9f4d';
  ctx.fillRect(-r * 0.62, r * 0.18, r * 1.24, r * 0.22);
  // head
  ctx.fillStyle = '#ffd9b3';
  ctx.beginPath(); ctx.arc(-r * 0.05, -r * 0.95, r * 0.42, 0, 7); ctx.fill();
  // helmet
  ctx.fillStyle = '#ff9f4d';
  ctx.beginPath(); ctx.arc(-r * 0.05, -r * 1.02, r * 0.44, Math.PI * 0.95, Math.PI * 2.05); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(-r * 0.5, -r * 1.14, r * 0.16, r * 0.3);
  // goggles looking down-and-out
  ctx.fillStyle = '#2a2145';
  ctx.beginPath(); ctx.arc(-r * 0.28, -r * 0.9, r * 0.13, 0, 7); ctx.fill();
  ctx.restore();
}

function drawLava() {
  const u = G.unit;
  const edgeY = lavaY - camY();
  if (edgeY < -u * 0.6) {
    // looming but off-screen: pulse a warning strip
    if (phase === 'run' && climberY - lavaY < u * 1.6) {
      const a = 0.25 + 0.2 * Math.abs(Math.sin(pulse / 220));
      const g = ctx.createLinearGradient(0, 0, 0, G.h * 0.05);
      g.addColorStop(0, `rgba(255,90,40,${a})`);
      g.addColorStop(1, 'rgba(255,90,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, G.w, G.h * 0.05);
      ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.4 * Math.abs(Math.sin(pulse / 220))})`;
      ctx.font = `800 ${u * 0.022}px 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('▲ LAVA ▲', G.w / 2, u * 0.008);
    }
    return;
  }
  // molten curtain with a bubbling edge
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(0, edgeY);
  const n = 26;
  for (let i = 0; i <= n; i++) {
    const xx = i / n * G.w;
    const yy = edgeY +
      Math.sin(i * 1.7 + pulse / 260) * u * 0.012 +
      Math.sin(i * 0.6 - pulse / 410) * u * 0.01 +
      hash(i * 3.1) * u * 0.014;
    ctx.lineTo(xx, yy);
  }
  ctx.lineTo(G.w, -10);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, Math.min(0, edgeY - u * 0.5), 0, edgeY + u * 0.03);
  g.addColorStop(0, '#c22a1e');
  g.addColorStop(0.7, '#ff5a2e');
  g.addColorStop(1, '#ffd166');
  ctx.fillStyle = g;
  ctx.fill();
  // under-glow
  const gl = ctx.createLinearGradient(0, edgeY, 0, edgeY + u * 0.1);
  gl.addColorStop(0, '#ff8c4266');
  gl.addColorStop(1, '#ff8c4200');
  ctx.fillStyle = gl;
  ctx.fillRect(0, edgeY, G.w, u * 0.1);
  // simmering bubbles
  for (let i = 0; i < 9; i++) {
    const bx = ((hash(i * 5.3) + pulse / 9000) % 1) * G.w;
    const by = edgeY - hash(i * 8.7) * u * 0.05;
    ctx.fillStyle = `rgba(255,230,140,${0.3 + 0.4 * Math.abs(Math.sin(pulse / 300 + i))})`;
    ctx.beginPath();
    ctx.arc(bx, by, u * (0.004 + hash(i * 2.9) * 0.006), 0, 7);
    ctx.fill();
  }
}

function drawMeter() {
  const u = G.unit;
  const w = u * 0.014, x = G.w - u * 0.018 - w;
  const top = G.h * 0.32, hh = G.h * 0.36;
  ctx.fillStyle = '#ffffff2a';
  ctx.beginPath();
  ctx.roundRect(x, top, w, hh, w / 2);
  ctx.fill();
  const k = frenzyT > 0 ? frenzyT / FRENZY_MS : charge;
  if (k > 0) {
    ctx.fillStyle = frenzyT > 0 ? `hsl(${(pulse / 3) % 360},90%,60%)` : '#ffd166';
    ctx.beginPath();
    ctx.roundRect(x, top + hh * (1 - k), w, hh * k, w / 2);
    ctx.fill();
  }
  ctx.font = `${u * 0.028}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('⚡', x + w / 2, top + hh + u * 0.008);
  if (magnetT > 0) {
    // blink when it's about to run out
    ctx.globalAlpha = magnetT < 1600 ? 0.4 + 0.6 * Math.abs(Math.sin(pulse / 140)) : 1;
    ctx.fillText('🧲', x + w / 2, top - u * 0.042);
    ctx.globalAlpha = 1;
  }
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSky();
  drawFarCliff();
  drawWall();

  for (const f of feats) {
    if (f.kind === 'target') drawTarget(f);
    else if (f.kind === 'pad') drawPad(f);
  }
  for (const f of feats) if (f.kind === 'spike') drawSpike(f);
  for (const f of feats) {
    if (f.kind === 'ring') drawRing(f);
    else if (f.kind === 'cloud') drawCloud(f);
    else if (f.kind === 'rocket') drawRocketItem(f);
    else if (f.kind === 'magnet') drawMagnetItem(f);
  }
  for (const c of coinsW) drawCoin(c);
  for (const b of boulders) drawBoulder(b);
  if (ride) drawRideArc(ride, 0);
  else if (lastRide) drawRideArc(lastRide, lastRide.fade / 500);
  drawClimber();
  drawLava();
  for (const w of warns) drawWarn(w);

  for (const s of sparks) {
    const k = s.t / s.life;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = s.col;
    ctx.beginPath(); ctx.arc(s.x, s.wy - camY(), s.size * (1 - k * 0.5), 0, 7); ctx.fill();
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
    const sy = p.wy - camY() - k * G.unit * 0.06;
    ctx.strokeText(p.txt, p.x, sy);
    ctx.fillText(p.txt, p.x, sy);
  }
  ctx.globalAlpha = 1;

  drawMeter();

  // big depth readout, so you can watch it without looking away from the climber
  if (phase === 'run' || phase === 'dying') {
    ctx.fillStyle = '#ffffff40';
    ctx.font = `800 ${G.unit * 0.1}px 'Segoe UI', sans-serif`;
    ctx.fillText(dist + ' m', G.w * 0.56, G.h * 0.1);
  }

  if (phase === 'ready') {
    const bob = Math.sin(pulse / 260) * G.unit * 0.008;
    ctx.fillStyle = '#ffffffee';
    ctx.font = `800 ${G.unit * 0.05}px 'Segoe UI', sans-serif`;
    ctx.strokeStyle = '#0006';
    ctx.lineWidth = 4;
    ctx.strokeText('Hold to rappel', G.w * 0.56, G.h * 0.5 + bob);
    ctx.fillText('Hold to rappel', G.w * 0.56, G.h * 0.5 + bob);
    ctx.fillStyle = '#ffffffcc';
    ctx.font = `600 ${G.unit * 0.024}px 'Segoe UI', sans-serif`;
    ctx.fillText('Release to stop · dodge the crystals', G.w * 0.56, G.h * 0.5 + G.unit * 0.05 + bob);
    ctx.fillText('Tricks charge your Frenzy ⚡', G.w * 0.56, G.h * 0.5 + G.unit * 0.085 + bob);
  }
}

// roundRect polyfill for older webviews
if (!ctx.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}

// ---------------- Input ----------------
function press() {
  if (phase === 'over') return;
  if (phase === 'ready') phase = 'run';
  if (phase === 'run') held = true;
}
function release() { held = false; }

canvas.addEventListener('pointerdown', e => { e.preventDefault(); press(); });
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', release);
window.addEventListener('blur', release);
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' && e.code !== 'ArrowDown') return;
  e.preventDefault();
  press();
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' || e.code === 'ArrowDown') release();
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
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
