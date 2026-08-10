/* Fun Park — Theme Park (Bullfrog) style tycoon.
   Lay paths from the gate, place rides/shops/decor, set the entry fee and shop
   prices, and keep guests happy. Rides break down (mechanics fix them), guests
   drop litter (janitors sweep), unhappy guests vandalise (security calms them).
   Staff salaries are renegotiated every New Year — lowball them and they quit.
   More rides/shops/decor unlock as lifetime visitors climb the park level.
   Sandbox with one persistent park under funpark.state.v1. */
'use strict';

const COLS = 20, ROWS = 18;      // whole world; you start owning the middle
const STATE_KEY = 'funpark.state.v1';
const MONTH_S = 40;              // real seconds per game month
const MAX_GUESTS = 80;

// Purchasable land plots surrounding the starting area (rows 4-17, cols 4-15,
// same size as the original pre-expansion park so v1 saves drop in unchanged).
const PLOTS = [
  { r: 0, c: 4, w: 4, h: 4 }, { r: 0, c: 8, w: 4, h: 4 }, { r: 0, c: 12, w: 4, h: 4 },
  { r: 0, c: 0, w: 4, h: 6 }, { r: 6, c: 0, w: 4, h: 6 }, { r: 12, c: 0, w: 4, h: 6 },
  { r: 0, c: 16, w: 4, h: 6 }, { r: 6, c: 16, w: 4, h: 6 }, { r: 12, c: 16, w: 4, h: 6 },
];
const plotPrice = () => 3000 + 1500 * landBought.length;
const LEVELS = [0, 20, 50, 100, 170, 260, 400]; // lifetime guests → park level 1..7

// ---------------- Catalog ----------------
const RIDES = {
  teacup:   { name: 'Tea Spinner',   icon: '☕', cost: 900,   excite: 2, cap: 6,  dur: 7,  rel: 0.62, tier: 1, base: '#e8a0b8' },
  bounce:   { name: 'Bouncy Castle', icon: '🏰', cost: 700,   excite: 1, cap: 8,  dur: 6,  rel: 0.72, tier: 1, base: '#f2c14e' },
  carousel: { name: 'Carousel',      icon: '🎠', cost: 1600,  excite: 3, cap: 8,  dur: 8,  rel: 0.78, tier: 2, base: '#b8a0e8' },
  ghost:    { name: 'Spook House',   icon: '👻', cost: 2800,  excite: 4, cap: 6,  dur: 10, rel: 0.70, tier: 3, base: '#8f9bb3' },
  swing:    { name: 'Pirate Swing',  icon: '⚓', cost: 4200,  excite: 5, cap: 8,  dur: 9,  rel: 0.74, tier: 4, base: '#7fb8d8' },
  flume:    { name: 'Log Flume',     icon: '🛶', cost: 5600,  excite: 6, cap: 8,  dur: 11, rel: 0.76, tier: 5, base: '#8fcf9f' },
  wheel:    { name: 'Big Wheel',     icon: '🎡', cost: 7200,  excite: 6, cap: 12, dur: 14, rel: 0.9,  tier: 5, base: '#f2a65e' },
  coaster:  { name: 'Rattler',       icon: '🎢', cost: 12500, excite: 9, cap: 10, dur: 9,  rel: 0.6,  tier: 6, base: '#e86868' },
  bumper:   { name: 'Bumper Cars',   icon: '🚗', cost: 2200,  excite: 3, cap: 8,  dur: 8,  rel: 0.8,  tier: 2, base: '#8fd4e8' },
  gokart:   { name: 'Go-Karts',      icon: '🏎️', cost: 3400,  excite: 4, cap: 6,  dur: 9,  rel: 0.7,  tier: 3, base: '#c9d86e' },
  drop:     { name: 'Drop Tower',    icon: '🗼', cost: 6200,  excite: 7, cap: 10, dur: 8,  rel: 0.68, tier: 5, base: '#d8b06e' },
  rocket:   { name: 'Star Loop',     icon: '🚀', cost: 16000, excite: 10, cap: 12, dur: 10, rel: 0.58, tier: 7, base: '#9a8fe8' },
};
const SHOPS = {
  fries:   { name: 'Fry Shack',  icon: '🍟', cost: 450, need: 'hunger', fair: 4, tier: 1, base: '#f2c14e' },
  drink:   { name: 'Fizz Stand', icon: '🥤', cost: 380, need: 'thirst', fair: 3, tier: 1, base: '#7fb8d8' },
  icecream:{ name: 'Ice Cream',  icon: '🍦', cost: 650, need: 'hunger', fair: 3, tier: 2, base: '#f0d8e8' },
  balloon: { name: 'Balloons',   icon: '🎈', cost: 550, need: 'joy',    fair: 5, tier: 3, base: '#e8a0b8' },
  gift:    { name: 'Gift Hut',   icon: '🎁', cost: 950, need: 'joy',    fair: 8, tier: 4, base: '#b8a0e8' },
  candy:   { name: 'Candy Floss', icon: '🍭', cost: 500, need: 'hunger', fair: 3, tier: 2, base: '#f0b8d8' },
  pizza:   { name: 'Pizza Stand', icon: '🍕', cost: 800, need: 'hunger', fair: 6, tier: 4, base: '#e8c07f' },
  boba:    { name: 'Bubble Tea',  icon: '🧋', cost: 700, need: 'thirst', fair: 5, tier: 5, base: '#c8a878' },
};
const DECOR = {
  tree:     { name: 'Tree',      icon: '🌳', cost: 120,  pts: 1, tier: 1 },
  flowers:  { name: 'Flowers',   icon: '🌷', cost: 160,  pts: 1, tier: 2 },
  fountain: { name: 'Fountain',  icon: '⛲', cost: 650,  pts: 3, tier: 3 },
  statue:   { name: 'Statue',    icon: '🗿', cost: 1300, pts: 4, tier: 5 },
  pond:     { name: 'Duck Pond', icon: '🦆', cost: 900,  pts: 3, tier: 4 },
};
// Sized so a starter park's two staff run ~30% of achievable revenue, like a
// real park's labor share — the old asks (80/50/65) were ~140% and bankrupted
// every new park.
const STAFF = {
  mech: { name: 'Mechanic', icon: '🔧', ask: 45, uni: '#4d6ad8' },
  jan:  { name: 'Janitor',  icon: '🧹', ask: 30, uni: '#43a06a' },
  sec:  { name: 'Guard',    icon: '👮', ask: 35, uni: '#3a3a55' },
};
const PATH_COST = 20;

// ---------------- State ----------------
let money = 20000;
let month = 3, year = 1, monthT = 0;   // opens in March, why not
let entryFee = 8;
let shopPrice = {};                    // per shop type
let asking = {}, offer = {};           // per staff type, monthly salary
let grid = [];                         // ROWS*COLS: null | {t:'path'} | building ref
let landBought = [];                   // indices into PLOTS
let owned = null;                      // Uint8Array per cell
let buildings = [];                    // {kind:'ride'|'shop'|'decor', type, r, c, size, ...}
let litter = [];                       // {i, n} n = bits of litter on cell
let guests = [], staff = [];
let lifetime = 0, level = 1;
let rating = 0, monthSales = 0, brokeMonths = 0;
let reputation = -1;   // slow EMA of rating — this is what draws the crowds
const REP_TAU = 90;    // seconds (~2 game months) to absorb a rating change
let tool = null, placeType = null;     // toolbar state
let toastQ = [];
let over = false;

const GATE = (ROWS - 1) * COLS + Math.floor(COLS / 2); // permanent path cell
const idx = (r, c) => r * COLS + c;
const rowOf = i => Math.floor(i / COLS);
const colOf = i => i % COLS;
const inGrid = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const isPath = i => { const g = grid[i]; return g && g.t === 'path'; };
const fmt = n => '$' + Math.round(n).toLocaleString('en-US');
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function defOf(b) { return b.kind === 'ride' ? RIDES[b.type] : b.kind === 'shop' ? SHOPS[b.type] : DECOR[b.type]; }

// ---------------- Persistence ----------------
let wiped = false; // set when starting over — blocks pagehide/autosave re-saving the dead park
function save() {
  if (wiped) return;
  const s = {
    v: 2, money, month, year, entryFee, shopPrice, asking, offer, lifetime, brokeMonths,
    rep: reputation,
    land: landBought,
    staff: staff.map(st => st.type),
    buildings: buildings.map(b => ({ kind: b.kind, type: b.type, r: b.r, c: b.c })),
    paths: grid.map((g, i) => (g && g.t === 'path' && i !== GATE) ? i : -1).filter(i => i >= 0),
  };
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (!s) return;
    // v1 saves used a 12×14 grid that maps onto the starting area at +4,+4
    const old = !s.v;
    const remap = i => old ? idx(Math.floor(i / 12) + 4, (i % 12) + 4) : i;
    money = s.money; month = s.month; year = s.year; entryFee = s.entryFee;
    shopPrice = s.shopPrice || {}; lifetime = s.lifetime || 0; brokeMonths = s.brokeMonths || 0;
    landBought = s.land || []; rebuildOwned();
    if (typeof s.rep === 'number') reputation = s.rep;
    for (const k in STAFF) {
      // clamp to the current pay scale — old saves carry pre-rebalance salaries
      const cap = Math.round(STAFF[k].ask * Math.pow(1.15, Math.max(0, (s.year || 1) - 1)));
      if (s.asking && s.asking[k]) asking[k] = Math.min(s.asking[k], cap);
      if (s.offer && s.offer[k]) offer[k] = Math.min(s.offer[k], asking[k]);
    }
    for (const i of s.paths || []) grid[remap(i)] = { t: 'path' };
    for (const b of s.buildings || [])
      placeBuilding(b.kind, b.type, old ? b.r + 4 : b.r, old ? b.c + 4 : b.c, true);
    for (const t of s.staff || []) spawnStaff(t);
  } catch { }
}

// ---------------- Grid / placement ----------------
function initGrid() {
  grid = new Array(ROWS * COLS).fill(null);
  grid[GATE] = { t: 'path' };
  rebuildOwned();
}
function rebuildOwned() {
  owned = new Uint8Array(ROWS * COLS);
  for (let r = 4; r <= 17; r++) for (let c = 4; c <= 15; c++) owned[idx(r, c)] = 1;
  for (const k of landBought) {
    const p = PLOTS[k];
    for (let r = p.r; r < p.r + p.h; r++) for (let c = p.c; c < p.c + p.w; c++) owned[idx(r, c)] = 1;
  }
}

function footprint(kind) { return kind === 'ride' ? 2 : 1; }

function cellsOf(b) {
  const out = [];
  for (let dr = 0; dr < b.size; dr++) for (let dc = 0; dc < b.size; dc++) out.push(idx(b.r + dr, b.c + dc));
  return out;
}
function adjPathCells(b) {
  const set = new Set(), out = [];
  for (let dr = 0; dr < b.size; dr++) for (let dc = 0; dc < b.size; dc++) {
    for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const r = b.r + dr + ar, c = b.c + dc + ac;
      if (!inGrid(r, c)) continue;
      const i = idx(r, c);
      if (isPath(i) && !set.has(i)) { set.add(i); out.push(i); }
    }
  }
  return out;
}

function canPlace(kind, r, c) {
  const size = footprint(kind);
  for (let dr = 0; dr < size; dr++) for (let dc = 0; dc < size; dc++) {
    if (!inGrid(r + dr, c + dc)) return false;
    if (!owned[idx(r + dr, c + dc)] || grid[idx(r + dr, c + dc)]) return false;
  }
  return true;
}

function placeBuilding(kind, type, r, c, silent) {
  const b = { kind, type, r, c, size: footprint(kind) };
  if (kind === 'ride') Object.assign(b, { state: 'idle', timer: 0, queue: [], riders: [], claimed: false });
  if (kind === 'shop') b.busy = 0;
  buildings.push(b);
  for (const i of cellsOf(b)) grid[i] = b;
  if (kind === 'shop' && !(type in shopPrice)) shopPrice[type] = SHOPS[type].fair;
  if (!silent) save();
  return b;
}

function removeAt(i) {
  const g = grid[i];
  if (!g || i === GATE) return;
  if (g.t === 'path') {
    grid[i] = null;
    money += PATH_COST / 2;
  } else {
    const def = defOf(g);
    for (const c of cellsOf(g)) grid[c] = null;
    buildings.splice(buildings.indexOf(g), 1);
    if (g.kind === 'ride') {
      for (const q of g.queue) { q.state = 'walk'; q.hap -= 5; }
      for (const rg of g.riders) despawnGuest(rg); // riders vanish with the ride, sorry
    }
    money += def.cost / 2;
    toast('Sold for ' + fmt(def.cost / 2));
  }
  save();
}

// BFS over path cells from start; goal(i) predicate. Returns route (excl. start) or null.
function bfs(start, goal) {
  if (goal(start)) return [];
  const prev = new Map([[start, -1]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    const r = rowOf(cur), c = colOf(cur);
    for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (!inGrid(r + ar, c + ac)) continue;
      const n = idx(r + ar, c + ac);
      if (prev.has(n) || !isPath(n)) continue;
      prev.set(n, cur);
      if (goal(n)) {
        const route = [n];
        let p = cur;
        while (p !== start) { route.unshift(p); p = prev.get(p); }
        return route;
      }
      q.push(n);
    }
  }
  return null;
}
function neighbors(i) {
  const r = rowOf(i), c = colOf(i), out = [];
  for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1]])
    if (inGrid(r + ar, c + ac) && isPath(idx(r + ar, c + ac))) out.push(idx(r + ar, c + ac));
  return out;
}

// ---------------- Rating / progression ----------------
// Kiddie-park gate is ~$10 with a couple of rides; a big lineup supports $50+.
// Landscaping justifies a slightly higher ticket too.
function fairEntry() {
  let e = 5, decorPts = 0;
  for (const b of buildings) {
    if (b.kind === 'ride') e += RIDES[b.type].excite * 1.5;
    if (b.kind === 'decor') decorPts += DECOR[b.type].pts;
  }
  return Math.round(e + Math.min(6, decorPts * 0.4));
}
let ratingParts = { rides: 0, decor: 0, litter: 0, broken: 0, guests: 0 };
function computeRating() {
  let rides = 0, decorPts = 0, broken = 0, litterN = 0, hapSum = 0;
  for (const b of buildings) {
    if (b.kind === 'ride') { rides += RIDES[b.type].excite * 3; if (b.state === 'broken') broken++; }
    if (b.kind === 'decor') decorPts += DECOR[b.type].pts;
  }
  for (const l of litter) litterN += l.n;
  ratingParts = {
    rides,
    decor: Math.min(25, decorPts * 1.5),
    litter: -Math.min(15, litterN * 0.5),
    broken: -broken * 6,
    guests: 0,
  };
  for (const g of guests) hapSum += g.hap;
  if (guests.length) ratingParts.guests = (hapSum / guests.length - 55) * 0.35;
  const r = 8 + ratingParts.rides + ratingParts.decor + ratingParts.litter + ratingParts.broken + ratingParts.guests;
  rating = clamp(Math.round(r), 0, 100);
}
function checkLevel() {
  let lv = 1;
  for (let i = 1; i < LEVELS.length; i++) if (lifetime >= LEVELS[i]) lv = i + 1;
  if (lv > level) {
    level = lv;
    toast('🎉 Park level ' + level + '! New attractions unlocked');
    if (tool === 'rides' || tool === 'shops' || tool === 'decor') openSheet(tool);
  }
}

// ---------------- Guests ----------------
function spawnGuest() {
  if (!isPath(GATE)) return;
  money += entryFee; monthSales += entryFee;
  lifetime++; checkLevel();
  guests.push({
    i: GATE, fx: colOf(GATE) + 0.5, fy: rowOf(GATE) + 0.5, route: [],
    state: 'walk', timer: 0, prev: -1,
    money: Math.max(5, rnd(30, 70) - entryFee * 0.3),
    hunger: rnd(0, 30), thirst: rnd(0, 30), joy: rnd(40, 70), hap: rnd(55, 75),
    angry: false, angryT: 0, litterT: 0, hitT: 0, decorT: 0, stay: rnd(150, 280),
    shirt: `hsl(${Math.floor(rnd(0, 360))},55%,55%)`, leaving: false, ride: null,
  });
}
function despawnGuest(g) {
  const k = guests.indexOf(g);
  if (k >= 0) guests.splice(k, 1);
}

function guestDecide(g) {
  // priorities: leave, drink, eat, ride, wander
  if (g.leaving || g.hap < 12 || g.money < 2 || g.timer > g.stay) {
    g.leaving = true;
    const route = bfs(g.i, i => i === GATE);
    if (!route || !route.length) { despawnGuest(g); return; } // unreachable or already at the gate
    g.route = route; g.goal = { kind: 'gate' };
    return;
  }
  const wants = [];
  if (g.thirst > 60) wants.push('thirst');
  if (g.hunger > 60) wants.push('hunger');
  if (g.joy < 45) wants.push('ride');
  for (const w of wants) {
    if (w === 'ride') {
      const open = buildings.filter(b => b.kind === 'ride' && b.state !== 'broken' && b.queue.length < 8);
      if (!open.length) continue;
      // weight by excitement
      let tot = 0; for (const b of open) tot += RIDES[b.type].excite;
      let pick = rnd(0, tot);
      let ride = open[0];
      for (const b of open) { pick -= RIDES[b.type].excite; if (pick <= 0) { ride = b; break; } }
      const spots = new Set(adjPathCells(ride));
      if (!spots.size) continue;
      const route = bfs(g.i, i => spots.has(i));
      if (!route) continue;
      g.route = route; g.goal = { kind: 'ride', b: ride };
      if (!route.length) guestArrive(g); // already standing next to it
      return;
    } else {
      const shops = buildings.filter(b => b.kind === 'shop' && SHOPS[b.type].need === w);
      let best = null;
      for (const s of shops) {
        const spots = new Set(adjPathCells(s));
        if (!spots.size) continue;
        const route = bfs(g.i, i => spots.has(i));
        if (route && (!best || route.length < best.route.length)) best = { route, s };
      }
      if (!best) continue;
      g.route = best.route; g.goal = { kind: 'shop', b: best.s };
      if (!best.route.length) guestArrive(g); // already standing next to it
      return;
    }
  }
  // wander
  const ns = neighbors(g.i);
  if (!ns.length) return;
  const fwd = ns.filter(n => n !== g.prev);
  const next = (fwd.length ? fwd : ns)[Math.floor(rnd(0, (fwd.length ? fwd : ns).length))];
  g.route = [next]; g.goal = null;
}

function guestArrive(g) {
  if (g.route.length) return;
  const goal = g.goal; g.goal = null;
  if (!goal) return;
  if (goal.kind === 'gate' && g.i === GATE) { despawnGuest(g); return; }
  if (goal.kind === 'shop') {
    const b = goal.b, def = SHOPS[b.type];
    if (buildings.indexOf(b) < 0) return;
    const price = shopPrice[b.type];
    const accept = clamp(1.8 - price / def.fair, 0.05, 1);
    if (price > g.money || Math.random() > accept) {
      g.hap -= 6; // too pricey — grumble, crave something else for a while
      if (def.need === 'joy') g.joy = Math.min(100, g.joy + 15);
      else g[def.need] = 40;
      return;
    }
    g.money -= price; money += price; monthSales += price;
    b.busy = 1.2; g.state = 'buy'; g.pause = 1.2;
    if (def.need === 'joy') { g.joy = Math.min(100, g.joy + 30); g.hap += 6; }
    else { g[def.need] = 0; g.hap += 4; if (Math.random() < 0.55) g.litterT = rnd(6, 18); }
  } else if (goal.kind === 'ride') {
    const b = goal.b;
    if (buildings.indexOf(b) < 0 || b.state === 'broken') { g.hap -= 4; return; }
    if (b.queue.length >= 8) { g.hap -= 3; return; }
    b.queue.push(g); g.state = 'queue';
  }
}

function tickGuest(g, dt) {
  g.timer += dt;
  if (g.state === 'riding') return;
  g.hunger = Math.min(100, g.hunger + dt * 1.1);
  g.thirst = Math.min(100, g.thirst + dt * 1.4);
  g.joy = Math.max(0, g.joy - dt * 1.2);
  if (g.hunger > 85 || g.thirst > 85) g.hap -= dt * 0.5;
  if (g.joy < 15) g.hap -= dt * 0.4;
  g.hap = clamp(g.hap, 0, 100);
  if (g.hitT > 0) g.hitT -= dt;

  // litter drop after eating
  if (g.litterT > 0) {
    g.litterT -= dt;
    if (g.litterT <= 0 && isPath(g.i)) addLitter(g.i);
  }
  // anger / vandalism
  if (!g.angry && g.hap < 22) { g.angry = true; g.angryT = 3; }
  if (g.angry) {
    if (g.hap > 38) g.angry = false;
    else {
      g.angryT -= dt;
      if (g.angryT <= 0) {
        g.angryT = 4;
        if (guardNear(g.i)) { g.hap = 42; g.angry = false; toast('👮 A guard calmed an angry guest'); }
        else vandalise(g);
      }
    }
  }

  if (g.state === 'buy') {
    g.pause -= dt;
    if (g.pause <= 0) g.state = 'walk';
    return;
  }
  if (g.state === 'queue') {
    g.hap -= dt * 0.3; // queueing is dull
    return;
  }
  // movement
  if (!g.route.length) { guestDecide(g); if (!g.route.length) return; }
  const next = g.route[0];
  if (!isPath(next)) { g.route = []; g.goal = null; return; }
  if (g.decorT > 0) g.decorT -= dt;
  moveToward(g, next, 1.45 * dt, () => {
    g.prev = g.i; g.i = next; g.route.shift();
    if (litterAt(g.i) && g.hitT <= 0) { g.hap -= 1; g.hitT = 4; }
    // strolling past landscaping lifts the mood
    if (g.decorT <= 0) {
      const r = rowOf(g.i), c = colOf(g.i);
      for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (!inGrid(r + ar, c + ac)) continue;
        const t = grid[idx(r + ar, c + ac)];
        if (t && t.kind === 'decor') { g.hap = Math.min(100, g.hap + 2); g.decorT = 6; break; }
      }
    }
    guestArrive(g);
  });
}

function moveToward(e, cell, step, onArrive) {
  const tx = colOf(cell) + 0.5, ty = rowOf(cell) + 0.5;
  const dx = tx - e.fx, dy = ty - e.fy;
  const d = Math.hypot(dx, dy);
  if (d <= step) { e.fx = tx; e.fy = ty; onArrive(); }
  else { e.fx += dx / d * step; e.fy += dy / d * step; }
}

function vandalise(g) {
  // smash adjacent decor, else drop litter
  const r = rowOf(g.i), c = colOf(g.i);
  for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    if (!inGrid(r + ar, c + ac)) continue;
    const t = grid[idx(r + ar, c + ac)];
    if (t && t.kind === 'decor') {
      toast('💢 A vandal smashed your ' + DECOR[t.type].name.toLowerCase() + '!');
      for (const cc of cellsOf(t)) grid[cc] = null;
      buildings.splice(buildings.indexOf(t), 1);
      save();
      return;
    }
  }
  if (isPath(g.i)) addLitter(g.i);
}
function guardNear(i) {
  const r = rowOf(i), c = colOf(i);
  return staff.some(s => s.type === 'sec' && Math.hypot(rowOf(s.i) - r, colOf(s.i) - c) <= 3);
}

// ---------------- Litter ----------------
function litterAt(i) { return litter.find(l => l.i === i); }
function addLitter(i) {
  const l = litterAt(i);
  if (l) l.n = Math.min(3, l.n + 1); else litter.push({ i, n: 1, claimed: false });
}

// ---------------- Rides ----------------
function tickRide(b, dt) {
  if (b.state === 'running') {
    b.timer -= dt;
    if (b.timer <= 0) {
      const def = RIDES[b.type];
      const exits = adjPathCells(b);
      for (const g of b.riders) {
        g.state = 'walk'; g.joy = Math.min(100, g.joy + 45 + def.excite * 4);
        g.hap = clamp(g.hap + def.excite * 2, 0, 100);
        const out = exits.length ? exits[Math.floor(rnd(0, exits.length))] : g.i;
        g.i = out; g.prev = -1; g.fx = colOf(out) + 0.5; g.fy = rowOf(out) + 0.5;
        g.route = []; g.goal = null; g.ride = null;
      }
      b.riders = [];
      if (Math.random() < (1 - def.rel) * 0.35) {
        b.state = 'broken'; b.claimed = false;
        toast('⚠️ ' + def.name + ' broke down!');
        for (const q of b.queue) { q.state = 'walk'; q.hap -= 8; }
        b.queue = [];
      } else b.state = 'idle';
    }
  } else if (b.state === 'idle' && b.queue.length) {
    const def = RIDES[b.type];
    b.riders = b.queue.splice(0, def.cap);
    for (const g of b.riders) { g.state = 'riding'; g.ride = b; }
    b.state = 'running'; b.timer = def.dur;
  }
  if (b.busy > 0) b.busy -= dt;
}

// ---------------- Staff ----------------
function spawnStaff(type) {
  staff.push({
    type, i: GATE, fx: colOf(GATE) + 0.5, fy: rowOf(GATE) + 0.5,
    route: [], prev: -1, job: null, work: 0, station: -1,
  });
}

// Breadth-first distance over the path network from a set of source cells.
function bfsDist(sources) {
  const dist = new Array(grid.length).fill(Infinity);
  const q = [];
  for (const i of sources) if (isPath(i)) { dist[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const n of neighbors(cur)) if (dist[n] === Infinity) { dist[n] = dist[cur] + 1; q.push(n); }
  }
  return dist;
}

/* Idle mechanics take up k-center standby posts: rides are partitioned among
   idle mechs (farthest-point seeding, then nearest-seed assignment) and each
   mech stands at the path cell minimizing the worst-case walk to any ride in
   their cluster. A ride already being fixed is excluded, so a free mech
   naturally repositions to cover the rest of the park while a colleague works. */
function planMechStations() {
  const idle = staff.filter(s => s.type === 'mech' && !s.job);
  for (const s of idle) s.station = -1;
  if (!idle.length) return;
  const targets = buildings.filter(b =>
    b.kind === 'ride' && !(b.state === 'broken' && b.claimed) && adjPathCells(b).length);
  if (!targets.length) return;
  const dmaps = targets.map(b => bfsDist(adjPathCells(b)));
  const tdist = (i, j) => {
    let d = Infinity;
    for (const c of adjPathCells(targets[j])) d = Math.min(d, dmaps[i][c]);
    return d;
  };
  const k = Math.min(idle.length, targets.length);
  const seeds = [0];
  while (seeds.length < k) {
    let best = -1, bd = -1;
    for (let t = 0; t < targets.length; t++) {
      if (seeds.includes(t)) continue;
      let d = Infinity;
      for (const sd of seeds) d = Math.min(d, tdist(sd, t));
      if (d > bd && d < Infinity) { bd = d; best = t; }
    }
    if (best < 0) break;
    seeds.push(best);
  }
  const groups = seeds.map(() => []);
  for (let t = 0; t < targets.length; t++) {
    let gi = 0, bd = Infinity;
    for (let s = 0; s < seeds.length; s++) {
      const d = tdist(seeds[s], t);
      if (d < bd) { bd = d; gi = s; }
    }
    groups[gi].push(t);
  }
  const stations = [];
  for (const g of groups) {
    let best = -1, bestMax = Infinity, bestSum = Infinity;
    for (let i = 0; i < grid.length; i++) {
      if (!isPath(i)) continue;
      let mx = 0, sum = 0;
      for (const t of g) { const d = dmaps[t][i]; if (d > mx) mx = d; sum += d; }
      if (mx < bestMax || (mx === bestMax && sum < bestSum)) { bestMax = mx; bestSum = sum; best = i; }
    }
    if (best >= 0) stations.push(best);
  }
  const free = [...idle];
  for (const st of stations) {
    if (!free.length) break;
    let bi = 0, bd = Infinity;
    for (let m = 0; m < free.length; m++) {
      const d = Math.abs(rowOf(free[m].i) - rowOf(st)) + Math.abs(colOf(free[m].i) - colOf(st));
      if (d < bd) { bd = d; bi = m; }
    }
    free.splice(bi, 1)[0].station = st;
  }
}
function morale(type) { return clamp(offer[type] / asking[type], 0.4, 1.3); }

function tickStaff(s, dt) {
  const speed = (0.9 + morale(s.type) * 0.5) * dt;
  // pick a job
  if (!s.job) {
    if (s.type === 'mech') {
      const b = buildings.find(b => b.kind === 'ride' && b.state === 'broken' && !b.claimed);
      if (b) {
        const spots = new Set(adjPathCells(b));
        const route = spots.size ? bfs(s.i, i => spots.has(i)) : null;
        if (route) { b.claimed = true; s.job = { kind: 'fix', b }; s.route = route; s.work = 0; }
      }
    } else if (s.type === 'jan') {
      let best = null;
      for (const l of litter) {
        if (l.claimed) continue;
        const route = bfs(s.i, i => i === l.i);
        if (route && (!best || route.length < best.route.length)) best = { route, l };
      }
      if (best) { best.l.claimed = true; s.job = { kind: 'sweep', l: best.l }; s.route = best.route; s.work = 0; }
    }
  }
  // move / work
  if (s.route.length) {
    const next = s.route[0];
    if (!isPath(next)) { dropJob(s); return; }
    moveToward(s, next, speed * 1.1, () => { s.prev = s.i; s.i = next; s.route.shift(); });
    return;
  }
  if (s.job) {
    if (s.job.kind === 'fix') {
      const b = s.job.b;
      if (buildings.indexOf(b) < 0 || b.state !== 'broken') { dropJob(s); return; }
      s.work += dt * morale(s.type);
      if (s.work >= 6) {
        b.state = 'idle'; b.claimed = false; s.job = null;
        toast('🔧 ' + RIDES[b.type].name + ' fixed');
      }
      return;
    }
    if (s.job.kind === 'sweep') {
      const l = s.job.l;
      if (litter.indexOf(l) < 0) { dropJob(s); return; }
      s.work += dt * morale(s.type);
      if (s.work >= 2) {           // one sweep clears the whole pile
        litter.splice(litter.indexOf(l), 1);
        s.job = null; s.work = 0;
      }
      return;
    }
  }
  // mechanics hold their standby post instead of wandering
  if (s.type === 'mech' && s.station >= 0) {
    if (s.i !== s.station) {
      const route = bfs(s.i, i => i === s.station);
      if (route && route.length) { s.route = route; }
    }
    return;
  }
  // wander
  const ns = neighbors(s.i);
  if (!ns.length) return;
  const fwd = ns.filter(n => n !== s.prev);
  const next = (fwd.length ? fwd : ns)[Math.floor(rnd(0, (fwd.length ? fwd : ns).length))];
  s.route = [next];
}
function dropJob(s) {
  if (s.job && s.job.kind === 'fix') s.job.b.claimed = false;
  if (s.job && s.job.kind === 'sweep') s.job.l.claimed = false;
  s.job = null; s.route = [];
}

// ---------------- Time / economy ----------------
let spawnT = 4, mechT = 0;
function tickWorld(dt) {
  monthT += dt;
  mechT -= dt;
  if (mechT <= 0) { mechT = 3; planMechStations(); }
  // reputation drifts toward today's rating — brief breakdowns barely dent it,
  // chronically broken rides drag it (and attendance) down over months
  reputation += (rating - reputation) * Math.min(1, dt / REP_TAU);
  if (monthT >= MONTH_S) { monthT -= MONTH_S; endMonth(); }

  // guest arrivals
  spawnT -= dt;
  if (spawnT <= 0) {
    const p = spawnPeriod();
    if (p > 100) spawnT = 8; // priced out — nobody comes, but re-check soon
    else {
      spawnT = p;
      const hasRide = buildings.some(b => b.kind === 'ride');
      if (hasRide && guests.length < MAX_GUESTS && reputation > 4 && !over) spawnGuest();
    }
  }

  for (const b of buildings) {
    if (b.kind === 'ride') tickRide(b, dt);
    else if (b.kind === 'shop' && b.busy > 0) b.busy -= dt;
  }
  for (let k = guests.length - 1; k >= 0; k--) tickGuest(guests[k], dt);
  for (const s of staff) tickStaff(s, dt);
}
function spawnPeriod() {
  const fair = fairEntry();
  if (entryFee > fair * 2.5 + 2) return 999;        // daylight robbery, nobody comes
  let p = 8 - reputation * 0.08;                    // reputation 80 → ~1.6s
  if (entryFee > fair) p *= 1 + 1.5 * (entryFee - fair) / Math.max(1, fair);
  return clamp(p, 2.5, 45);
}
function endMonth() {
  let wages = 0;
  for (const s of staff) wages += offer[s.type];
  money -= wages;
  toast('📒 ' + MONTHS[month - 1] + ' Yr ' + year + ' — sales ' + fmt(monthSales) + ', wages ' + fmt(wages));
  brokeMonths = money < 0 ? brokeMonths + 1 : 0;
  monthSales = 0;
  month++;
  if (month > 12) { month = 1; year++; newYear(); }
  if (brokeMonths >= 2) bust();
  save(); updateHud();
}
function newYear() {
  for (const k in STAFF) asking[k] = Math.round(asking[k] * 1.15);
  toast('🎆 Happy New Year — staff demand higher pay!');
  // underpaid staff walk out
  for (let k = staff.length - 1; k >= 0; k--) {
    const t = staff[k].type;
    if (offer[t] < asking[t] * 0.8 && Math.random() < 0.5) {
      staff.splice(k, 1);
      toast('😤 A ' + STAFF[t].name.toLowerCase() + ' quit over pay!');
    }
  }
  if (tool === 'staff') openSheet('staff');
}
function bust() {
  over = true;
  document.getElementById('bustOverlay').classList.add('active');
}

// ---------------- Camera / rendering ----------------
const canvas = document.getElementById('park');
const ctx = canvas.getContext('2d');
let cs = 32, camX = 0, camY = 0, vw = 0, vh = 0, dpr = 1;

function minZoom() { return Math.min(vw / COLS, vh / ROWS) * 0.95; }
function clampCam() {
  cs = clamp(cs, minZoom(), 72);
  const spanX = vw / cs, spanY = vh / cs;
  camX = spanX >= COLS ? (COLS - spanX) / 2 : clamp(camX, -0.5, COLS - spanX + 0.5);
  camY = spanY >= ROWS ? (ROWS - spanY) / 2 : clamp(camY, -0.5, ROWS - spanY + 0.5);
}
function fitOwnedView() {
  // frame the owned land with a little margin
  let r0 = ROWS, r1 = 0, c0 = COLS, c1 = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++)
    if (owned[idx(r, c)]) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
  const bw = c1 - c0 + 2, bh = r1 - r0 + 2;
  cs = clamp(Math.min(vw / bw, vh / bh), minZoom(), 72);
  camX = c0 + (c1 - c0 + 1) / 2 - vw / cs / 2;
  camY = r0 + (r1 - r0 + 1) / 2 - vh / cs / 2;
  clampCam();
}
function resize() {
  const area = document.querySelector('.game-area');
  dpr = window.devicePixelRatio || 1;
  vw = area.clientWidth; vh = area.clientHeight;
  canvas.width = vw * dpr; canvas.height = vh * dpr;
  canvas.style.width = vw + 'px'; canvas.style.height = vh + 'px';
  clampCam();
}
window.addEventListener('resize', resize);

const px = c => (c - camX) * cs, py = r => (r - camY) * cs;
const ownedAt = (r, c) => inGrid(r, c) && owned[idx(r, c)];

function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#5d8f4a';                  // outside the world
  ctx.fillRect(0, 0, vw, vh);
  // land: bright when owned, dull scrub when for sale
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (owned[idx(r, c)]) ctx.fillStyle = (r + c) % 2 ? '#8fca6e' : '#97d276';
    else ctx.fillStyle = (r + c) % 2 ? '#6da653' : '#72ab58';
    ctx.fillRect(px(c), py(r), cs + 1, cs + 1);
  }
  // wild trees on unowned land (deterministic scatter)
  ctx.font = `${cs * 0.55}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = idx(r, c);
    if (!owned[i] && (i * 2654435761 >>> 0) % 5 === 0)
      ctx.fillText('🌲', px(c) + cs / 2, py(r) + cs / 2);
  }
  // plot boundaries + prices
  if (pendingPlot >= 0 && now - pendingT > 4000) pendingPlot = -1;
  for (let k = 0; k < PLOTS.length; k++) {
    if (landBought.includes(k)) continue;
    const p = PLOTS[k];
    ctx.strokeStyle = k === pendingPlot ? '#ffd93b' : '#ffffff55';
    ctx.lineWidth = k === pendingPlot ? 3 : 1.5;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(px(p.c) + 2, py(p.r) + 2, p.w * cs - 4, p.h * cs - 4);
    ctx.setLineDash([]);
    const label = k === pendingPlot ? 'Tap to buy!' : fmt(plotPrice());
    ctx.font = `bold ${Math.max(10, cs * 0.32)}px sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = '#00000088';
    ctx.strokeText(label, px(p.c) + p.w * cs / 2, py(p.r) + p.h * cs / 2);
    ctx.fillStyle = k === pendingPlot ? '#ffd93b' : '#fff';
    ctx.fillText(label, px(p.c) + p.w * cs / 2, py(p.r) + p.h * cs / 2);
  }
  // fence around owned land (skip the gate's outer edge)
  ctx.strokeStyle = '#7a5a3a'; ctx.lineWidth = 3;
  ctx.beginPath();
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!owned[idx(r, c)]) continue;
    const x = px(c), y = py(r), gate = idx(r, c) === GATE;
    if (!ownedAt(r - 1, c)) { ctx.moveTo(x, y); ctx.lineTo(x + cs, y); }
    if (!ownedAt(r + 1, c) && !gate) { ctx.moveTo(x, y + cs); ctx.lineTo(x + cs, y + cs); }
    if (!ownedAt(r, c - 1)) { ctx.moveTo(x, y); ctx.lineTo(x, y + cs); }
    if (!ownedAt(r, c + 1)) { ctx.moveTo(x + cs, y); ctx.lineTo(x + cs, y + cs); }
  }
  ctx.stroke();

  // paths
  for (let i = 0; i < grid.length; i++) {
    if (!isPath(i)) continue;
    const r = rowOf(i), c = colOf(i);
    ctx.fillStyle = '#d8cdb8';
    rrect(px(c) + 1, py(r) + 1, cs - 2, cs - 2, 4); ctx.fill();
  }
  // gate arch
  ctx.font = `${cs * 0.9}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🎪', px(colOf(GATE)) + cs / 2, py(ROWS - 1) + cs * 0.45);

  // litter
  ctx.fillStyle = '#8a6f4d';
  for (const l of litter) {
    const r = rowOf(l.i), c = colOf(l.i);
    for (let k = 0; k < l.n * 2 + 1; k++) {
      const a = (l.i * 7 + k * 53) % 100 / 100, b2 = (l.i * 13 + k * 29) % 100 / 100;
      ctx.beginPath();
      ctx.arc(px(c) + cs * (0.2 + a * 0.6), py(r) + cs * (0.2 + b2 * 0.6), cs * 0.05, 0, 7);
      ctx.fill();
    }
  }

  // buildings
  for (const b of buildings) {
    const def = defOf(b);
    const x = px(b.c), y = py(b.r), s = cs * b.size;
    if (b.kind !== 'decor') {
      // soft ground shadow, platform, darker lip for a little depth
      ctx.fillStyle = '#00000018';
      rrect(x + 3, y + 5, s - 4, s - 4, 6); ctx.fill();
      ctx.fillStyle = (b.kind === 'ride' && b.state === 'broken') ? '#9a9a9a' : def.base;
      rrect(x + 2, y + 2, s - 4, s - 4, 6); ctx.fill();
      ctx.fillStyle = '#00000022';
      rrect(x + 2, y + s - 4 - s * 0.12, s - 4, s * 0.12 + 2, 5); ctx.fill();
      ctx.strokeStyle = '#00000022'; ctx.lineWidth = 2;
      rrect(x + 2, y + 2, s - 4, s - 4, 6); ctx.stroke();
    }
    if (b.kind === 'shop') {
      // striped awning across the top
      const n = 5, aw = (s - 8) / n, ah = s * 0.2;
      for (let k = 0; k < n; k++) {
        ctx.fillStyle = k % 2 ? '#ffffffdd' : '#00000030';
        ctx.fillRect(x + 4 + k * aw, y + 3, aw, ah);
      }
    }
    let bob = 0;
    if (b.kind === 'ride' && b.state === 'running') bob = Math.sin(now / 130 + b.r) * cs * 0.06;
    ctx.save();
    ctx.shadowColor = '#00000055'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 2;
    ctx.font = `${s * (b.kind === 'decor' ? 0.8 : 0.58)}px serif`;
    ctx.fillText(def.icon, x + s / 2, y + s / 2 + bob + (b.kind === 'shop' ? s * 0.08 : 0));
    ctx.restore();
    if (b.kind === 'ride') {
      if (b.state === 'broken' && Math.floor(now / 400) % 2) {
        ctx.font = `${s * 0.4}px serif`;
        ctx.fillText('⚠️', x + s / 2, y + s * 0.22);
      }
      if (b.queue.length) {
        ctx.fillStyle = '#3a3a55'; ctx.font = `bold ${cs * 0.38}px sans-serif`;
        ctx.fillText(b.queue.length, x + s - cs * 0.25, y + cs * 0.28);
      }
    }
  }

  // ghost placement preview
  if (placeType && hoverCell >= 0) {
    const kind = tool === 'rides' ? 'ride' : tool === 'shops' ? 'shop' : 'decor';
    const size = footprint(kind);
    const r = rowOf(hoverCell), c = colOf(hoverCell);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = canPlace(kind, r, c) ? '#4dff88' : '#ff4d4d';
    ctx.fillRect(px(c), py(r), cs * size, cs * size);
    ctx.globalAlpha = 1;
  }

  // guests
  for (const g of guests) {
    if (g.state === 'riding') continue;
    const x = px(0) + g.fx * cs, y = py(0) + g.fy * cs;
    ctx.fillStyle = '#00000015';
    ctx.beginPath(); ctx.ellipse(x, y + cs * 0.22, cs * 0.15, cs * 0.06, 0, 0, 7); ctx.fill();
    ctx.fillStyle = g.shirt;
    ctx.beginPath(); ctx.arc(x, y + cs * 0.05, cs * 0.16, 0, 7); ctx.fill();
    ctx.fillStyle = '#f2c9a0';
    ctx.beginPath(); ctx.arc(x, y - cs * 0.14, cs * 0.11, 0, 7); ctx.fill();
    if (g.angry) {
      ctx.strokeStyle = '#e33'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, cs * 0.24, 0, 7); ctx.stroke();
    }
  }
  // staff
  for (const s of staff) {
    const def = STAFF[s.type];
    const x = px(0) + s.fx * cs, y = py(0) + s.fy * cs;
    ctx.fillStyle = def.uni;
    ctx.beginPath(); ctx.arc(x, y + cs * 0.05, cs * 0.17, 0, 7); ctx.fill();
    ctx.fillStyle = '#f2c9a0';
    ctx.beginPath(); ctx.arc(x, y - cs * 0.14, cs * 0.11, 0, 7); ctx.fill();
    ctx.font = `${cs * 0.35}px serif`;
    ctx.fillText(def.icon, x + cs * 0.18, y - cs * 0.22);
  }
}

// ---------------- HUD / toasts ----------------
function updateHud() {
  document.getElementById('hudMoney').textContent = fmt(money);
  document.getElementById('hudGuests').textContent = guests.length;
  document.getElementById('hudRating').textContent =
    Math.round(reputation) + (Math.round(reputation) < rating ? '↗' : Math.round(reputation) > rating ? '↘' : '');
  document.getElementById('hudDate').textContent = MONTHS[month - 1] + ' Y' + year;
  document.getElementById('hudMoney').classList.toggle('fp-red', money < 0);
  // park level rises with lifetime visitors; show progress to the next unlock
  document.getElementById('hudLvlLabel').textContent = 'Level ' + level;
  document.getElementById('hudLvl').textContent =
    level >= LEVELS.length ? 'MAX' : lifetime + '/' + LEVELS[level] + ' 👥';
}
document.getElementById('ratingBox').addEventListener('click', () => {
  const p = ratingParts, f = n => (n >= 0 ? '+' : '') + Math.round(n);
  toast(`⭐ Reputation ${Math.round(reputation)} (draws the crowds) — today ${rating} = base +8 · rides ${f(p.rides)} · decor ${f(p.decor)} · litter ${f(p.litter)} · breakdowns ${f(p.broken)} · guest mood ${f(p.guests)}`);
});
function toast(msg) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'fp-toast'; el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 3200);
}

// ---------------- Toolbar / sheets ----------------
const sheet = document.getElementById('sheet');
function setTool(t) {
  if (tool === t) { tool = null; placeType = null; sheet.classList.remove('open'); }
  else { tool = t; placeType = null; openSheet(t); }
  document.querySelectorAll('.fp-toolbar button').forEach(b =>
    b.classList.toggle('toggled', b.dataset.tool === tool));
}

function catFor(t) { return t === 'rides' ? RIDES : t === 'shops' ? SHOPS : DECOR; }

function openSheet(t) {
  if (t === 'path' || t === 'delete') { sheet.classList.remove('open'); return; }
  let html = '';
  if (t === 'rides' || t === 'shops' || t === 'decor') {
    html = '<div class="fp-cards">';
    for (const [key, d] of Object.entries(catFor(t))) {
      const locked = d.tier > level;
      html += `<button class="fp-card${locked ? ' locked' : ''}${placeType === key ? ' sel' : ''}" data-item="${key}" ${locked ? 'disabled' : ''}>
        <span class="ic">${locked ? '🔒' : d.icon}</span><span class="nm">${d.name}</span>
        <span class="pr">${locked ? 'Level ' + d.tier : fmt(d.cost)}</span></button>`;
    }
    html += '</div>';
  } else if (t === 'staff') {
    html = '<div class="fp-rows">';
    for (const [key, d] of Object.entries(STAFF)) {
      const n = staff.filter(s => s.type === key).length;
      const mood = offer[key] >= asking[key] ? '😊' : offer[key] >= asking[key] * 0.8 ? '😐' : '😠';
      const effort = Math.round(morale(key) * 100);
      html += `<div class="fp-row">
        <span class="ic">${d.icon}</span>
        <span class="nm">${d.name}<small>×${n} · wants ${fmt(asking[key])}/mo ${mood} · effort ${effort}%</small></span>
        <span class="fp-step"><button data-sal="${key}" data-d="-5">−</button><b>${fmt(offer[key])}</b><button data-sal="${key}" data-d="5">+</button></span>
        <button class="fp-mini" data-fire="${key}" ${n ? '' : 'disabled'}>−1</button>
        <button class="fp-mini primary" data-hire="${key}">Hire</button>
      </div>`;
    }
    html += '</div>';
  } else if (t === 'prices') {
    html = '<div class="fp-rows">';
    html += `<div class="fp-row"><span class="ic">🎟️</span>
      <span class="nm">Entry fee<small>guests expect ~${fmt(fairEntry())}</small></span>
      <span class="fp-step"><button data-price="entry" data-d="-1">−</button><b>${fmt(entryFee)}</b><button data-price="entry" data-d="1">+</button></span></div>`;
    for (const [key, d] of Object.entries(SHOPS)) {
      if (d.tier > level || !(key in shopPrice)) continue;
      html += `<div class="fp-row"><span class="ic">${d.icon}</span>
        <span class="nm">${d.name}<small>fair price ${fmt(d.fair)}</small></span>
        <span class="fp-step"><button data-price="${key}" data-d="-1">−</button><b>${fmt(shopPrice[key])}</b><button data-price="${key}" data-d="1">+</button></span></div>`;
    }
    html += '</div>';
  }
  sheet.innerHTML = html;
  sheet.classList.add('open');
}

sheet.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.item) {
    placeType = placeType === btn.dataset.item ? null : btn.dataset.item;
    openSheet(tool);
  } else if (btn.dataset.sal) {
    const k = btn.dataset.sal;
    offer[k] = Math.max(5, offer[k] + Number(btn.dataset.d));
    save(); openSheet('staff');
  } else if (btn.dataset.hire) {
    const k = btn.dataset.hire;
    if (money < offer[k]) { toast('Not enough cash'); return; }
    money -= offer[k];       // first month up front
    spawnStaff(k); save(); openSheet('staff'); updateHud();
  } else if (btn.dataset.fire) {
    const k = btn.dataset.fire;
    const j = staff.findIndex(s => s.type === k);
    if (j >= 0) { dropJob(staff[j]); staff.splice(j, 1); save(); openSheet('staff'); }
  } else if (btn.dataset.price) {
    const k = btn.dataset.price, d = Number(btn.dataset.d);
    if (k === 'entry') entryFee = clamp(entryFee + d, 0, 60);
    else shopPrice[k] = clamp(shopPrice[k] + d, 1, 25);
    save(); openSheet('prices');
  }
});

document.querySelectorAll('.fp-toolbar button').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));

// ---------------- Canvas input ----------------
// One finger: tap to build/buy, drag to pan (or paint with path/sell tools).
// Two fingers: pinch to zoom, drag to pan.
let hoverCell = -1, pendingPlot = -1, pendingT = 0;
const pointers = new Map();
let painting = false, panning = false, tapStart = null, lastPair = null;

function cellFromXY(x, y) {
  const rect = canvas.getBoundingClientRect();
  const c = Math.floor(camX + (x - rect.left) / cs);
  const r = Math.floor(camY + (y - rect.top) / cs);
  return inGrid(r, c) ? idx(r, c) : -1;
}
function tryBuild(i) {
  if (i < 0 || over) return;
  const r = rowOf(i), c = colOf(i);
  if (!owned[i]) { if (!painting) landTap(i); return; }
  if (tool === 'path') {
    if (grid[i]) return;
    if (money < PATH_COST) { toast('Not enough cash'); return; }
    money -= PATH_COST; grid[i] = { t: 'path' }; save(); updateHud();
  } else if (tool === 'delete') {
    removeAt(i); updateHud();
  } else if (placeType) {
    const kind = tool === 'rides' ? 'ride' : tool === 'shops' ? 'shop' : 'decor';
    const def = catFor(tool)[placeType];
    if (!canPlace(kind, r, c)) return;
    if (money < def.cost) { toast('Not enough cash'); return; }
    const b = placeBuilding(kind, placeType, r, c);
    if (kind !== 'decor' && !adjPathCells(b).length)
      toast('⚠️ ' + def.name + ' needs a path next to it');
    money -= def.cost; save(); updateHud();
  }
}
function landTap(i) {
  const r = rowOf(i), c = colOf(i);
  const k = PLOTS.findIndex(p => r >= p.r && r < p.r + p.h && c >= p.c && c < p.c + p.w);
  if (k < 0 || landBought.includes(k) || over) return;
  const price = plotPrice();
  if (pendingPlot === k) {
    if (money < price) { toast('Not enough cash'); pendingPlot = -1; return; }
    money -= price; landBought.push(k); rebuildOwned(); pendingPlot = -1;
    toast('🏞️ New land purchased!');
    save(); updateHud();
  } else {
    pendingPlot = k; pendingT = performance.now();
    toast('Tap again to buy this plot for ' + fmt(price));
  }
}
function pairState() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    tapStart = { x: e.clientX, y: e.clientY };
    panning = false;
    painting = tool === 'path' || tool === 'delete';
    hoverCell = cellFromXY(e.clientX, e.clientY);
    if (painting) tryBuild(hoverCell);
  } else {
    painting = false; panning = false; tapStart = null; lastPair = pointers.size === 2 ? pairState() : null;
  }
});
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p) { hoverCell = cellFromXY(e.clientX, e.clientY); return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const s = pairState();
    if (lastPair && lastPair.d > 0) {
      const wx = camX + s.mx / cs, wy = camY + s.my / cs;
      cs = clamp(cs * s.d / lastPair.d, minZoom(), 72);
      camX = wx - s.mx / cs + (lastPair.mx - s.mx) / cs;
      camY = wy - s.my / cs + (lastPair.my - s.my) / cs;
      clampCam();
    }
    lastPair = s;
    return;
  }
  hoverCell = cellFromXY(e.clientX, e.clientY);
  if (painting) { if (hoverCell >= 0) tryBuild(hoverCell); return; }
  if (!panning && tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8) panning = true;
  if (panning) { camX -= dx / cs; camY -= dy / cs; clampCam(); }
});
function pointerEnd(e) {
  const wasTap = tapStart && !panning && !painting && pointers.size === 1;
  pointers.delete(e.pointerId);
  if (wasTap) tryBuild(cellFromXY(e.clientX, e.clientY));
  if (pointers.size < 2) lastPair = null;
  if (pointers.size === 0) { painting = false; panning = false; tapStart = null; }
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

function wipeAndReload() {
  wiped = true;
  localStorage.removeItem(STATE_KEY);
  location.reload();
}
document.getElementById('bustRestart').addEventListener('click', wipeAndReload);
document.getElementById('resetBtn').addEventListener('click', () =>
  document.getElementById('resetOverlay').classList.add('active'));
document.getElementById('resetYes').addEventListener('click', wipeAndReload);
document.getElementById('resetNo').addEventListener('click', () =>
  document.getElementById('resetOverlay').classList.remove('active'));

// ---------------- Boot / loop ----------------
for (const k in STAFF) { asking[k] = STAFF[k].ask; offer[k] = STAFF[k].ask; }
initGrid();
load();
resize();
fitOwnedView();
computeRating();
if (reputation < 0) reputation = rating;   // fresh park starts at today's rating
updateHud();

let last = performance.now(), ratingT = 0, saveT = 0, hudT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!over) tickWorld(dt);
  ratingT += dt; hudT += dt; saveT += dt;
  if (ratingT > 2) { ratingT = 0; computeRating(); }
  if (hudT > 0.5) { hudT = 0; updateHud(); }
  if (saveT > 10) { saveT = 0; save(); }
  draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener('pagehide', save);
