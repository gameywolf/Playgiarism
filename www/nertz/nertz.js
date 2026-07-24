/* Nertz — real-time solitaire race. One human (player 0) vs three CPUs.
   Each player owns a 52-card deck laid out as a 13-card Nertz pile, 4 work
   piles (build down, alternating colour), and a stock flipped 3 at a time to a
   stream. The centre holds shared foundations built up by suit from the Ace —
   anyone may play to them at any time (no turns). Empty your Nertz pile to end
   the round. Score +1 per card you sent to the centre, -2 per card left in your
   Nertz pile; first to 100 across rounds wins. Difficulty scales CPU speed and
   skill. State persists under nertz.state.v1. */
'use strict';

const SAVE_KEY = 'nertz.state.v1';
const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const isRed = (c) => c.s === 1 || c.s === 2;
const TARGET = 100;

const DIFF = {
  easy:   { tickMin: 4800, tickMax: 7600, skill: 0.50, smart: false, label: 'Easy' },
  medium: { tickMin: 3000, tickMax: 5000, skill: 0.65, smart: true,  label: 'Medium' },
  hard:   { tickMin: 1600, tickMax: 2800, skill: 0.85, smart: true,  label: 'Hard' },
};

const META = [
  { color: '#6c8cff', light: '#a9bcff' },
  { color: '#e8384f', light: '#ff8a99' },
  { color: '#3fb85c', light: '#7fd894' },
  { color: '#f2b711', light: '#ffd75e' },
];
const NAME_BANK = [
  'Otto', 'Vera', 'Milo', 'Iris', 'Faye', 'Rex', 'Juno', 'Ezra', 'Lola', 'Kai',
  'Nina', 'Theo', 'Sage', 'Remy', 'Bea', 'Gus', 'Ivy', 'Mack', 'Posy', 'Zeke',
  'Wren', 'Hal', 'Dot', 'Ash', 'Nell', 'Finn', 'Suki', 'Bram', 'Elke', 'Rudy',
];
let names = ['You', 'Otto', 'Vera', 'Milo'];
function pickNames() {
  const pool = NAME_BANK.slice();
  shuffle(pool);
  names = ['You', pool[0], pool[1], pool[2]];
}

// ---------------- State ----------------
let diffKey = 'medium';
let players = [];          // per-player {nertz, stock, stream, work:[[],[],[],[]], nextAt, flash}
let foundations = [];      // {s, top, cards:[...]}
let totals = [0, 0, 0, 0];
let roundNo = 1;
let roundOver = true;      // true until a round is dealt
let started = false;
let flights = [];          // cosmetic flying cards {card,x0,y0,x1,y1,t,dur}
let lastRound = null;      // {scores, caller}
let banner = null;         // {text, until}
let groupSuits = false;    // display option: cluster the centre piles by suit
let lastPlayAt = 0;        // when any card last hit the centre (drives the stall button)
const STALL_MS = 12000;    // no centre play for this long -> offer a deck shift

// ---------------- Sound (synthesized, no assets) ----------------
let audioCtx = null;
function unlockAudio() {
  if (!audioCtx && typeof AudioContext !== 'undefined') {
    try { audioCtx = new AudioContext(); } catch (e) { /* no audio */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function playSound(kind) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  o.type = 'triangle';
  if (kind === 'centre') {          // any player sends a card to the foundations
    o.frequency.setValueAtTime(620 + Math.random() * 120, t0);
    o.frequency.exponentialRampToValueAtTime(920, t0 + 0.07);
    g.gain.setValueAtTime(0.1, t0);
  } else {                          // your own pile moves / stock flips: soft tick
    o.frequency.setValueAtTime(440, t0);
    g.gain.setValueAtTime(0.05, t0);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
  o.start(t0); o.stop(t0 + 0.14);
}

// ---------------- Deck / deal ----------------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freshPlayer(p) {
  const deck = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) deck.push({ r, s, o: p });
  shuffle(deck);
  const nertz = deck.splice(0, 13);
  const work = [[deck.pop()], [deck.pop()], [deck.pop()], [deck.pop()]];
  return { nertz, stock: deck, stream: [], work, nextAt: 0, flash: 0 };
}

function dealRound() {
  players = [freshPlayer(0), freshPlayer(1), freshPlayer(2), freshPlayer(3)];
  foundations = [];
  flights = [];
  roundOver = false;
  started = true;
  banner = null;
  const now = performance.now();
  lastPlayAt = now;
  for (let p = 1; p < 4; p++) players[p].nextAt = now + 600 + Math.random() * 700;
  layout();
  hideOverlays();
  updateHud();
  save();
}

// ---------------- Rules ----------------
function foundationTargetFor(card) {
  if (card.r === 1) return { kind: 'new' };
  const idx = foundations.findIndex((f) => f.s === card.s && f.top === card.r - 1);
  return idx >= 0 ? { kind: 'add', idx } : null;
}
function canFoundation(card) { return !!foundationTargetFor(card); }

// may card sit on the top card of a work pile (build down, alternating colour)?
function canStack(card, onto) {
  if (!onto) return true;              // empty work pile accepts anything
  return card.r === onto.r - 1 && isRed(card) !== isRed(onto);
}

// longest movable run starting at index i of a work pile (descending, alt colour)
function runOk(pile, i) {
  for (let k = i; k < pile.length - 1; k++) {
    if (!canStack(pile[k + 1], pile[k])) return false;
  }
  return true;
}

function pileOf(p, kind, wi) {
  const P = players[p];
  return kind === 'nertz' ? P.nertz : kind === 'stream' ? P.stream : P.work[wi];
}

// ---------------- Moves ----------------
function applyFoundation(card, p, srcPt) {
  const ft = foundationTargetFor(card);
  let idx;
  if (ft.kind === 'new') {
    foundations.push({ s: card.s, top: 1, cards: [card] });
    idx = foundations.length - 1;
    layoutFoundations();
  } else {
    const f = foundations[ft.idx];
    f.top = card.r;
    f.cards.push(card);
    idx = ft.idx;
  }
  foundations[idx].hitAt = performance.now();   // decaying "just played" glow
  foundations[idx].hitBy = p;
  const dst = foundRects[idx];
  if (srcPt && dst) flights.push({ card, x0: srcPt.x, y0: srcPt.y, x1: dst.x, y1: dst.y, t: 0, dur: 260 });
  players[p].flash = performance.now();
  lastPlayAt = performance.now();
  playSound('centre');
}

function playTopToFoundation(p, kind, wi, srcPt) {
  const arr = pileOf(p, kind, wi);
  if (!arr.length) return false;
  const card = arr[arr.length - 1];
  if (!canFoundation(card)) return false;
  arr.pop();
  applyFoundation(card, p, srcPt || pileTopPoint(p, kind, wi));
  afterMove(p);
  return true;
}

function moveRun(p, kind, wi, ci, destWi) {
  const src = pileOf(p, kind, wi);
  const start = kind === 'work' ? ci : src.length - 1;
  const run = src.slice(start);
  if (!run.length) return false;
  const dest = players[p].work[destWi];
  if (!canStack(run[0], dest[dest.length - 1])) return false;
  src.splice(start);
  dest.push(...run);
  if (p === 0) playSound('tick');
  afterMove(p);
  return true;
}

function flipStock(p) {
  const P = players[p];
  if (P.stock.length === 0) {
    if (P.stream.length === 0) return false;
    P.stream.reverse();
    P.stock = P.stream;
    P.stream = [];
  }
  const n = Math.min(3, P.stock.length);
  for (let i = 0; i < n; i++) P.stream.push(P.stock.pop());
  if (p === 0) { playSound('tick'); save(); }
  return true;
}

// everyone's draw cycle shifts by one card, so the 3-at-a-time flips land on
// fresh cards — the classic way to break a stalled Nertz round
function shiftDecks() {
  for (let p = 0; p < 4; p++) {
    const P = players[p];
    if (P.stock.length > 1) P.stock.push(P.stock.shift());
    else if (P.stream.length > 1) P.stream.unshift(P.stream.pop());
  }
  lastPlayAt = performance.now();
  banner = { text: '🔄 Decks shifted', until: performance.now() + 1000 };
  playSound('tick');
  save();
}

function afterMove(p) {
  updateHud();
  if (players[p].nertz.length === 0 && !roundOver) {
    endRound(p);
  } else {
    save();
  }
}

// ---------------- CPU ----------------
function cpuAct(p) {
  const d = DIFF[diffKey];
  if (Math.random() > d.skill) return;      // slower reflexes miss this tick
  const P = players[p];

  // 1. Nertz top -> foundation (best: progresses the goal)
  if (P.nertz.length && canFoundation(P.nertz[P.nertz.length - 1])) {
    playTopToFoundation(p, 'nertz'); return;
  }
  // 2. Nertz top -> a work pile (frees the Nertz pile)
  if (P.nertz.length) {
    const top = P.nertz[P.nertz.length - 1];
    let dest = -1;
    for (let w = 0; w < 4; w++) { if (P.work[w].length === 0) { dest = w; break; } }
    if (dest < 0) for (let w = 0; w < 4; w++) { if (canStack(top, P.work[w][P.work[w].length - 1])) { dest = w; break; } }
    if (dest >= 0) { moveRun(p, 'nertz', 0, 0, dest); return; }
  }
  // 3. work / stream top -> foundation
  for (let w = 0; w < 4; w++) {
    if (P.work[w].length && canFoundation(P.work[w][P.work[w].length - 1])) { playTopToFoundation(p, 'work', w); return; }
  }
  if (P.stream.length && canFoundation(P.stream[P.stream.length - 1])) { playTopToFoundation(p, 'stream'); return; }

  // 4. (smart) work->work move that empties a pile or exposes a foundation card
  if (d.smart) {
    for (let w = 0; w < 4; w++) {
      const pile = P.work[w];
      if (!pile.length) continue;
      for (let ci = 0; ci < pile.length; ci++) {
        if (!runOk(pile, ci)) continue;
        const head = pile[ci];
        for (let w2 = 0; w2 < 4; w2++) {
          if (w2 === w) continue;
          const dest = P.work[w2];
          if (dest.length === 0 && ci === 0) continue;         // don't shuffle a whole pile into an empty one
          if (!canStack(head, dest[dest.length - 1])) continue;
          const emptiesPile = ci === 0;
          const exposed = ci > 0 ? pile[ci - 1] : null;
          if (emptiesPile || (exposed && canFoundation(exposed))) { moveRun(p, 'work', w, ci, w2); return; }
        }
      }
    }
    // 5. stream top -> work pile
    if (P.stream.length) {
      const top = P.stream[P.stream.length - 1];
      for (let w = 0; w < 4; w++) {
        if (P.work[w].length && canStack(top, P.work[w][P.work[w].length - 1])) { moveRun(p, 'stream', 0, 0, w); return; }
      }
    }
  }
  // 6. nothing productive — dig through the stock
  flipStock(p);
}

// ---------------- Round / match ----------------
function foundationCount(p) {
  let n = 0;
  for (const f of foundations) for (const c of f.cards) if (c.o === p) n++;
  return n;
}

function endRound(caller) {
  roundOver = true;
  const scores = [];
  for (let p = 0; p < 4; p++) {
    scores[p] = foundationCount(p) - 2 * players[p].nertz.length;
    totals[p] += scores[p];
  }
  lastRound = { scores, caller };
  const matchDone = totals.some((t) => t >= TARGET);
  save();
  const who = caller < 0 ? 'Round called' : (caller === 0 ? 'You went Nertz!' : names[caller] + ' went Nertz!');
  banner = { text: caller === 0 ? '🎉 NERTZ!' : who, until: performance.now() + 1400 };
  setTimeout(() => { matchDone ? showMatch() : showRound(who); }, 1200);
}

function showRound(who) {
  document.getElementById('roundTitle').textContent = who;
  document.getElementById('roundTable').innerHTML = scoreRows();
  document.getElementById('roundOverlay').classList.add('active');
}

function showMatch() {
  let win = 0;
  for (let p = 1; p < 4; p++) if (totals[p] > totals[win]) win = p;
  document.getElementById('matchTitle').textContent = win === 0 ? '🏆 You win the match!' : `${names[win]} wins the match`;
  document.getElementById('matchTable').innerHTML = scoreRows();
  document.getElementById('matchOverlay').classList.add('active');
}

function scoreRows() {
  let rows = '<tr><th></th><th>Round</th><th>Total</th></tr>';
  for (let p = 0; p < 4; p++) {
    const rd = lastRound ? lastRound.scores[p] : 0;
    rows += `<tr><td><span class="sw" style="background:${META[p].color}"></span>${names[p]}</td>` +
            `<td>${rd >= 0 ? '+' + rd : rd}</td><td><b>${totals[p]}</b></td></tr>`;
  }
  return rows;
}

function newMatch() {
  totals = [0, 0, 0, 0];
  roundNo = 1;
  lastRound = null;
  pickNames();
  dealRound();
}

// ---------------- Persistence ----------------
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      diffKey, totals, roundNo, roundOver, started, groupSuits, names,
      players: players.map((P) => ({ nertz: P.nertz, stock: P.stock, stream: P.stream, work: P.work })),
      foundations,
    }));
  } catch (e) { /* storage full / disabled — non-fatal */ }
}

function load() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return false; }
  if (!s || !s.players) return false;
  diffKey = s.diffKey in DIFF ? s.diffKey : 'medium';
  groupSuits = !!s.groupSuits;
  if (Array.isArray(s.names) && s.names.length === 4) names = s.names;
  totals = s.totals || [0, 0, 0, 0];
  roundNo = s.roundNo || 1;
  foundations = s.foundations || [];
  for (const f of foundations) { delete f.hitAt; delete f.hitBy; } // stale glow stamps from an old session
  players = s.players.map((P) => ({ nertz: P.nertz, stock: P.stock, stream: P.stream, work: P.work, nextAt: 0, flash: 0 }));
  roundOver = !!s.roundOver;
  started = !!s.started;
  return started && !roundOver && players.length === 4;
}

// ---------------- Canvas / layout ----------------
const wrap = document.getElementById('nertzWrap');
const canvas = document.getElementById('nertzCanvas');
const ctx = canvas.getContext('2d');
let dpr = 1;
let L = null;               // layout rects
let foundRects = [];        // one {x,y,w,h} per foundation

function layout() {
  dpr = window.devicePixelRatio || 1;
  const r = wrap.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  const W = r.width, H = r.height, M = 8, G = 8;

  // your work-pile card width drives everything
  let cw = (W - 2 * M - 3 * G) / 4;
  cw = Math.min(cw, 96);
  let ch = cw * 1.4;

  const cpuH = Math.min(H * 0.16, ch * 0.7);
  const foundH = Math.min(H * 0.24, ch * 1.05);
  const mineTop = cpuH + foundH + 10;
  let mineH = H - mineTop - 6;
  // shrink cards if the mine area can't hold a header row + a little fan
  const needMine = ch + 30 + ch * 0.9;
  if (mineH < needMine) {
    const k = mineH / needMine;
    cw *= k; ch = cw * 1.4;
  }

  const cpu = [];
  const cwCpu = (W - 4 * G) / 3;
  for (let i = 0; i < 3; i++) cpu.push({ x: G + i * (cwCpu + G), y: 6, w: cwCpu, h: cpuH - 8 });

  // your header row: nertz (left), stream + stock (right)
  const y0 = mineTop;
  const nertzRect = { x: M, y: y0, w: cw, h: ch };
  const stockRect = { x: W - M - cw, y: y0, w: cw, h: ch };
  const streamRect = { x: W - M - cw * 2 - 18, y: y0, w: cw, h: ch }; // top card; older fan behind to the left

  // work piles across the bottom
  const yWork = y0 + ch + 14;
  const fanH = H - yWork - 8;
  const workX = [];
  const totalW = 4 * cw + 3 * G;
  const startX = (W - totalW) / 2;
  for (let i = 0; i < 4; i++) workX.push(startX + i * (cw + G));

  L = { W, H, M, cw, ch, cpuH, foundH, cpu, nertzRect, stockRect, streamRect, yWork, fanH, workX,
        found: { y: cpuH + 6, h: foundH - 10 } };
  layoutFoundations();
}

function layoutFoundations() {
  foundRects = [];
  if (!L) return;
  const fcw = Math.min(L.cw * 0.88, (L.foundH - 12) / 1.4);
  const fch = fcw * 1.4;
  const n = Math.max(foundations.length + 1, 5); // include one empty "aces here" slot
  const perRow = Math.max(1, Math.floor((L.W - 12) / (fcw + 6)));
  const rows = Math.ceil(n / perRow);
  const gy = rows > 1 ? Math.min(6, (L.foundH - rows * fch) / (rows - 1)) : 6;
  // display order: creation order, or clustered by suit when the option is on
  const order = foundations.map((_, i) => i);
  if (groupSuits) order.sort((a, b) => foundations[a].s - foundations[b].s || a - b);
  foundRects = new Array(foundations.length);
  for (let k = 0; k < order.length; k++) {
    const row = Math.floor(k / perRow), col = k % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    const rowW = inRow * fcw + (inRow - 1) * 6;
    const x = (L.W - rowW) / 2 + col * (fcw + 6);
    const y = L.found.y + row * (fch + gy);
    foundRects[order[k]] = { x: x + fcw / 2, y: y + fch / 2, w: fcw, h: fch, x0: x, y0: y };
  }
  L.fcw = fcw; L.fch = fch;
  // remember the "next slot" spot for the empty ace hint
  const i = foundations.length;
  const row = Math.floor(i / perRow), col = i % perRow;
  const inRow = Math.min(perRow, n - row * perRow);
  const rowW = inRow * fcw + (inRow - 1) * 6;
  L.aceSlot = { x: (L.W - rowW) / 2 + col * (fcw + 6), y: L.found.y + row * (fch + gy), w: fcw, h: fch };
}

function pileTopPoint(p, kind, wi) {
  if (p !== 0 || !L) { const c = L ? L.cpu[Math.max(0, p - 1)] : null; return c ? { x: c.x + c.w / 2, y: c.y + c.h / 2 } : { x: 0, y: 0 }; }
  if (kind === 'nertz') return { x: L.nertzRect.x + L.cw / 2, y: L.nertzRect.y + L.ch / 2 };
  if (kind === 'stream') return { x: L.streamRect.x + L.cw / 2, y: L.streamRect.y + L.ch / 2 };
  const pile = players[0].work[wi];
  const step = workStep(pile.length);
  return { x: L.workX[wi] + L.cw / 2, y: L.yWork + Math.max(0, pile.length - 1) * step + L.ch / 2 };
}

function workStep(len) {
  const base = L.ch * 0.28;
  if (len <= 1) return base;
  return Math.min(base, (L.fanH - L.ch) / (len - 1));
}

// ---------------- Input (human = player 0) ----------------
let drag = null; // {kind, wi, ci, cards:[...], x, y, moved, stockTap}

function localPoint(e) {
  const r = wrap.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function inRect(px, py, x, y, w, h) { return px >= x && py >= y && px <= x + w && py <= y + h; }

function hitMine(px, py) {
  const P = players[0];
  // work piles first (they extend downward and may overlap the header visually)
  for (let w = 0; w < 4; w++) {
    const pile = P.work[w];
    const x = L.workX[w];
    if (px < x || px > x + L.cw) continue;
    const step = workStep(pile.length);
    const bottom = L.yWork + Math.max(0, pile.length - 1) * step + L.ch;
    if (py < L.yWork || py > bottom) continue;
    // which card index? topmost (last) whose region contains py
    let ci = pile.length - 1;
    for (let k = 0; k < pile.length; k++) {
      const cy = L.yWork + k * step;
      if (py >= cy) ci = k;
    }
    if (pile.length === 0) return { kind: 'work', wi: w, ci: 0, empty: true };
    // only grabbable if it starts a valid run down to the bottom
    if (ci === pile.length - 1 || runOk(pile, ci)) return { kind: 'work', wi: w, ci };
    return { kind: 'work', wi: w, ci: pile.length - 1 };
  }
  if (inRect(px, py, L.nertzRect.x, L.nertzRect.y, L.cw, L.ch) && P.nertz.length) return { kind: 'nertz', wi: 0, ci: P.nertz.length - 1 };
  if (inRect(px, py, L.streamRect.x, L.streamRect.y, L.cw, L.ch) && P.stream.length) return { kind: 'stream', wi: 0, ci: P.stream.length - 1 };
  if (inRect(px, py, L.stockRect.x, L.stockRect.y, L.cw, L.ch)) return { kind: 'stock' };
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!started || roundOver || overlayUp()) return;
  const { x, y } = localPoint(e);
  const hit = hitMine(x, y);
  if (!hit) return;
  if (hit.kind === 'stock') { drag = { kind: 'stock', x, y, moved: false }; return; }
  const pile = pileOf(0, hit.kind, hit.wi);
  if (!pile.length) return;
  const cards = hit.kind === 'work' ? pile.slice(hit.ci) : [pile[pile.length - 1]];
  drag = { kind: hit.kind, wi: hit.wi, ci: hit.kind === 'work' ? hit.ci : pile.length - 1, cards, x, y, sx: x, sy: y, moved: false };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const { x, y } = localPoint(e);
  drag.x = x; drag.y = y;
  if (!drag.moved && (Math.abs(x - drag.sx) > 7 || Math.abs(y - drag.sy) > 7)) drag.moved = true;
});

canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === 'stock') { flipStock(0); return; }

  if (!d.moved) {
    // tap: auto-send the single top card to the centre if legal
    if (d.cards.length === 1) playTopToFoundation(0, d.kind, d.wi);
    return;
  }
  // drag drop
  const { x, y } = localPoint(e);
  // onto the centre band?
  if (y < L.cpuH + L.foundH + 6 && y > L.cpuH && d.cards.length === 1 && canFoundation(d.cards[0])) {
    playTopToFoundation(0, d.kind, d.wi);
    return;
  }
  // onto a work pile?
  for (let w = 0; w < 4; w++) {
    const x0 = L.workX[w];
    if (x < x0 - 4 || x > x0 + L.cw + 4) continue;
    if (d.kind === 'work' && d.wi === w) return; // dropped on itself
    const dest = players[0].work[w];
    if (canStack(d.cards[0], dest[dest.length - 1])) { moveRun(0, d.kind, d.wi, d.ci, w); return; }
  }
});

// ---------------- HUD / overlays ----------------
function updateHud() {
  const box = document.getElementById('nertzHud');
  if (!box) return;
  let h = '';
  for (let p = 0; p < 4; p++) {
    const nz = players[p] ? players[p].nertz.length : 0;
    h += `<div class="nchip"><span class="sw" style="background:${META[p].color}"></span>` +
         `<span class="nm">${names[p]}</span><b>${totals[p]}</b><i>N${nz}</i></div>`;
  }
  box.innerHTML = h;
}

function overlayUp() { return document.querySelector('.overlay.active') !== null; }
function hideOverlays() { document.querySelectorAll('.overlay').forEach((o) => o.classList.remove('active')); }
function isPaused() { return roundOver || overlayUp() || document.hidden; }

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

function drawCard(x, y, w, h, card, opt) {
  opt = opt || {};
  const r = Math.max(4, w * 0.12);
  roundRect(ctx, x, y, w, h, r);
  if (opt.faceDown) {
    ctx.fillStyle = '#4759a6'; ctx.fill();
    ctx.strokeStyle = '#33438a'; ctx.lineWidth = 1; ctx.stroke();
    roundRect(ctx, x + w * 0.16, y + h * 0.12, w * 0.68, h * 0.76, r * 0.6);
    ctx.strokeStyle = '#6f80c9'; ctx.stroke();
    return;
  }
  ctx.fillStyle = opt.dim ? '#eef0f6' : '#ffffff'; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1; ctx.stroke();
  if (opt.hint) { roundRect(ctx, x + 1, y + 1, w - 2, h - 2, r); ctx.strokeStyle = '#f5b301'; ctx.lineWidth = 2.5; ctx.stroke(); }
  if (!card) return;
  ctx.fillStyle = isRed(card) ? '#d8324a' : '#26304d';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = `700 ${Math.round(h * 0.2)}px system-ui, sans-serif`;
  ctx.fillText(RANKS[card.r], x + w * 0.09, y + h * 0.06);
  // small corner pips so suit shows on overlapped cards:
  // top-right for vertical stacks, under the rank for horizontal fans
  ctx.font = `${Math.round(h * 0.17)}px system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText(SUITS[card.s], x + w * 0.93, y + h * 0.07);
  ctx.textAlign = 'left';
  ctx.fillText(SUITS[card.s], x + w * 0.09, y + h * 0.28);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(h * 0.4)}px system-ui, sans-serif`;
  ctx.fillText(SUITS[card.s], x + w * 0.5, y + h * 0.62);
}

function emptySlot(x, y, w, h, label) {
  const r = Math.max(4, w * 0.12);
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.setLineDash([]);
  if (label) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(h * 0.2)}px system-ui`; ctx.fillText(label, x + w / 2, y + h / 2);
  }
}

function draw(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, L.W, L.H);
  if (!players.length) return;

  drawCpus(now);
  drawFoundations(now);
  drawMine();

  // flights
  for (const f of flights) {
    const k = Math.min(1, f.t / f.dur);
    const e = 1 - Math.pow(1 - k, 2);
    drawCard((f.x0 + (f.x1 - f.x0) * e) - L.fcw / 2, (f.y0 + (f.y1 - f.y0) * e) - L.fch / 2, L.fcw, L.fch, f.card, {});
  }

  // drag ghost
  if (drag && drag.cards && drag.cards.length) {
    const step = L.ch * 0.28;
    for (let i = 0; i < drag.cards.length; i++) {
      drawCard(drag.x - L.cw / 2, drag.y - L.ch / 2 + i * step, L.cw, L.ch, drag.cards[i], {});
    }
  }

  // banner
  if (banner && now < banner.until) {
    ctx.fillStyle = 'rgba(40,38,64,0.82)';
    const bw = Math.min(L.W - 40, 300), bh = 64;
    roundRect(ctx, (L.W - bw) / 2, L.H / 2 - bh / 2, bw, bh, 16); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 26px system-ui'; ctx.fillText(banner.text, L.W / 2, L.H / 2);
  }
}

function drawCpus(now) {
  for (let p = 1; p <= 3; p++) {
    const c = L.cpu[p - 1];
    const flashing = now - players[p].flash < 260;
    roundRect(ctx, c.x, c.y, c.w, c.h, 12);
    ctx.fillStyle = flashing ? META[p].light : '#ffffff'; ctx.fill();
    ctx.strokeStyle = META[p].color; ctx.lineWidth = flashing ? 3 : 1.5; ctx.stroke();
    // name
    ctx.fillStyle = META[p].color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = '700 13px system-ui';
    ctx.fillText(names[p], c.x + 8, c.y + 6);
    // sent count
    ctx.fillStyle = '#8b90a8'; ctx.textAlign = 'right'; ctx.font = '11px system-ui';
    ctx.fillText('sent ' + foundationCount(p), c.x + c.w - 8, c.y + 7);
    // big Nertz-remaining
    ctx.fillStyle = '#26304d'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = '700 26px system-ui';
    ctx.fillText(players[p].nertz.length, c.x + 8, c.y + c.h - 10);
    ctx.fillStyle = '#8b90a8'; ctx.font = '11px system-ui';
    ctx.fillText('in Nertz pile', c.x + 8 + ctx.measureText(players[p].nertz.length).width + 44, c.y + c.h - 12);
  }
}

const GLOW_MS = 3000;
function drawFoundations(now) {
  // hint slot for aces
  if (L.aceSlot) emptySlot(L.aceSlot.x, L.aceSlot.y, L.aceSlot.w, L.aceSlot.h, 'A');
  for (let i = 0; i < foundations.length; i++) {
    const f = foundations[i], rct = foundRects[i];
    if (!rct) continue;
    drawCard(rct.x0, rct.y0, L.fcw, L.fch, { r: f.top, s: f.s, o: 0 }, {});
    // decaying glow in the colour of whoever just played here
    const el = now - (f.hitAt || -1e9);
    if (el >= 0 && el < GLOW_MS && f.hitBy != null) {
      const k = el / GLOW_MS;
      const grow = 2 + k * 5;                 // ring drifts outward as it fades
      ctx.globalAlpha = (1 - k) * (1 - k);    // ease-out fade
      ctx.strokeStyle = META[f.hitBy].color;
      ctx.lineWidth = 3.5;
      roundRect(ctx, rct.x0 - grow, rct.y0 - grow, L.fcw + 2 * grow, L.fch + 2 * grow, Math.max(5, L.fcw * 0.14));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function drawMine() {
  const P = players[0];
  // Nertz pile — stacked with a count badge; top face up
  const nz = P.nertz;
  if (nz.length) {
    const back = Math.min(3, nz.length - 1);
    for (let i = 0; i < back; i++) drawCard(L.nertzRect.x - i * 2, L.nertzRect.y - i * 2, L.cw, L.ch, null, { faceDown: true });
    drawCard(L.nertzRect.x - back * 2, L.nertzRect.y - back * 2, L.cw, L.ch, nz[nz.length - 1], { hint: canFoundation(nz[nz.length - 1]) });
    badge(L.nertzRect.x, L.nertzRect.y - back * 2, nz.length);
  } else {
    emptySlot(L.nertzRect.x, L.nertzRect.y, L.cw, L.ch, '✓');
  }
  ctx.fillStyle = '#8b90a8'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.font = '10px system-ui';
  ctx.fillText('NERTZ', L.nertzRect.x + L.cw / 2, L.nertzRect.y + L.ch + 2);

  // Stock
  if (P.stock.length) {
    drawCard(L.stockRect.x, L.stockRect.y, L.cw, L.ch, null, { faceDown: true });
    badge(L.stockRect.x, L.stockRect.y, P.stock.length);
  } else {
    emptySlot(L.stockRect.x, L.stockRect.y, L.cw, L.ch, '♻');
  }
  ctx.fillStyle = '#8b90a8'; ctx.textAlign = 'center'; ctx.font = '10px system-ui';
  ctx.fillText('DRAW', L.stockRect.x + L.cw / 2, L.stockRect.y + L.ch + 2);

  // Stream — last up-to-3 fanned to the left; top playable
  const st = P.stream;
  if (st.length) {
    const show = Math.min(3, st.length);
    const fanX = L.cw * 0.3;
    for (let i = 0; i < show; i++) {
      const card = st[st.length - show + i];
      const x = L.streamRect.x - (show - 1 - i) * fanX;
      const top = i === show - 1;
      drawCard(x, L.streamRect.y, L.cw, L.ch, card, { hint: top && canFoundation(card) });
    }
  } else {
    emptySlot(L.streamRect.x, L.streamRect.y, L.cw, L.ch, '');
  }

  // Work piles
  for (let w = 0; w < 4; w++) {
    const pile = P.work[w];
    const x = L.workX[w];
    if (!pile.length) { emptySlot(x, L.yWork, L.cw, L.ch, ''); continue; }
    const step = workStep(pile.length);
    for (let k = 0; k < pile.length; k++) {
      if (drag && drag.kind === 'work' && drag.wi === w && k >= drag.ci) break; // lifted cards
      const top = k === pile.length - 1;
      drawCard(x, L.yWork + k * step, L.cw, L.ch, pile[k], { hint: top && canFoundation(pile[k]) });
    }
  }
}

function badge(x, y, n) {
  const r = 11;
  ctx.beginPath(); ctx.arc(x + L.cw - 6, y + 6, r, 0, Math.PI * 2);
  ctx.fillStyle = '#26304d'; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '700 11px system-ui';
  ctx.fillText(n, x + L.cw - 6, y + 6);
}

// ---------------- Loop ----------------
let lastT = performance.now();
const shiftBtn = document.getElementById('shiftBtn');
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(60, t - lastT);
  lastT = t;
  if (!L) return;
  if (started && !isPaused()) {
    for (let p = 1; p <= 3; p++) {
      if (t >= players[p].nextAt) {
        cpuAct(p);
        const d = DIFF[diffKey];
        players[p].nextAt = t + d.tickMin + Math.random() * (d.tickMax - d.tickMin);
      }
    }
    shiftBtn.hidden = t - lastPlayAt < STALL_MS;
  } else {
    for (let p = 1; p <= 3; p++) if (players[p]) players[p].nextAt = Math.max(players[p].nextAt, t + 250);
    lastPlayAt = Math.max(lastPlayAt, t); // don't count paused time toward a stall
    shiftBtn.hidden = true;
  }
  for (const f of flights) f.t += dt;
  flights = flights.filter((f) => f.t < f.dur);
  if (!document.hidden) draw(t);
}

// ---------------- Wiring ----------------
function startWith(key) { diffKey = key; hideOverlays(); newMatch(); }
document.getElementById('diffEasy').onclick = () => startWith('easy');
document.getElementById('diffMedium').onclick = () => startWith('medium');
document.getElementById('diffHard').onclick = () => startWith('hard');
document.getElementById('nextRoundBtn').onclick = () => { roundNo++; dealRound(); };
document.getElementById('newMatchBtn').onclick = () => { hideOverlays(); document.getElementById('diffOverlay').classList.add('active'); };
document.getElementById('endRoundBtn').onclick = () => { if (started && !roundOver && !overlayUp()) endRound(-1); };
shiftBtn.onclick = () => {
  // only honour the click while the stall is still live — a centre play hides it
  if (started && !roundOver && !overlayUp() && !shiftBtn.hidden) { shiftBtn.hidden = true; shiftDecks(); }
};
document.addEventListener('pointerdown', unlockAudio, { capture: true });

function syncGroupBtn() {
  document.getElementById('groupSuitsBtn').textContent = 'Group center piles by suit: ' + (groupSuits ? 'On' : 'Off');
}
document.getElementById('groupSuitsBtn').onclick = () => {
  groupSuits = !groupSuits;
  syncGroupBtn();
  layoutFoundations();
  save();
};
document.getElementById('menuBtn').onclick = () => { if (started) document.getElementById('menuOverlay').classList.add('active'); };
document.getElementById('resumeBtn').onclick = () => document.getElementById('menuOverlay').classList.remove('active');
document.getElementById('restartBtn').onclick = () => { document.getElementById('menuOverlay').classList.remove('active'); newMatch(); };
document.getElementById('changeDiffBtn').onclick = () => { hideOverlays(); document.getElementById('diffOverlay').classList.add('active'); };

window.addEventListener('resize', () => { if (L) { layout(); } });

// boot
if (load()) {
  hideOverlays();
  layout();
  const now = performance.now();
  for (let p = 1; p < 4; p++) players[p].nextAt = now + 400 + Math.random() * 600;
  updateHud();
} else {
  layout();
  document.getElementById('diffOverlay').classList.add('active');
}
syncGroupBtn();
requestAnimationFrame(loop);
