/* Pixel Color by Number */
'use strict';

// ---------------- Storage ----------------
const STORE_KEY = 'pixel.works.v1';

function loadWorks() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function saveWorks(works) {
  localStorage.setItem(STORE_KEY, JSON.stringify(works));
}

// bytes <-> base64 (chunked to avoid call-stack limits)
function bytesToB64(arr) {
  let s = '';
  for (let i = 0; i < arr.length; i += 8192) {
    s += String.fromCharCode.apply(null, arr.subarray ? arr.subarray(i, i + 8192) : arr.slice(i, i + 8192));
  }
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------- Screens ----------------
const screens = {
  gallery: document.getElementById('galleryScreen'),
  setup: document.getElementById('setupScreen'),
  play: document.getElementById('playScreen'),
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  if (name === 'play') requestAnimationFrame(() => { resizeBoard(); fitView(); drawBoard(); });
}

// ---------------- Gallery ----------------
const galleryGrid = document.getElementById('galleryGrid');

// bundled starter pictures
const STARTERS = [
  { name: 'Singing Puffin', src: 'defaults/puffin.jpg' },
  { name: 'Angry Cat', src: 'defaults/angry-cat.jpg' },
  { name: 'Tomato Duck', src: 'defaults/tomato-duck.jpg' },
  { name: 'Giraffe', src: 'defaults/giraffe.jpg' },
  { name: 'Bread Battle', src: 'defaults/bread-battle.jpg' },
];

function renderGallery() {
  const works = loadWorks();
  galleryGrid.innerHTML = '';

  const newTile = document.createElement('div');
  newTile.className = 'new-tile';
  newTile.innerHTML = '<div class="inner"><div class="plus">+</div><div>New picture</div></div>';
  newTile.onclick = () => document.getElementById('sourceOverlay').classList.add('active');
  galleryGrid.appendChild(newTile);

  const inProgress = [], finished = [];
  for (const w of works) (progressPct(w) >= 100 ? finished : inProgress).push(w);

  for (const w of inProgress) galleryGrid.appendChild(makeWorkTile(w, false));

  if (finished.length) {
    const fhead = document.createElement('div');
    fhead.className = 'section-head';
    fhead.textContent = 'Finished — tap to admire';
    galleryGrid.appendChild(fhead);
    for (const w of finished) galleryGrid.appendChild(makeWorkTile(w, true));
  }

  const head = document.createElement('div');
  head.className = 'section-head';
  head.textContent = 'Starters — tap to color one';
  galleryGrid.appendChild(head);

  for (const st of STARTERS) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const img = document.createElement('img');
    img.src = st.src;
    img.alt = st.name;
    tile.appendChild(img);
    const badge = document.createElement('div');
    badge.className = 'pct';
    badge.textContent = st.name;
    tile.appendChild(badge);
    tile.onclick = () => useImageSrc(st.src);
    galleryGrid.appendChild(tile);
  }
}

function makeWorkTile(work, finished) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  const cv = document.createElement('canvas');
  drawThumb(cv, work);
  tile.appendChild(cv);

  const pct = document.createElement('div');
  pct.className = 'pct';
  pct.textContent = finished ? '✓ Done' : progressPct(work) + '%';
  tile.appendChild(pct);

  const del = document.createElement('div');
  del.className = 'del';
  del.textContent = '🗑';
  del.onclick = (e) => {
    e.stopPropagation();
    if (confirm('Delete this picture?')) {
      saveWorks(loadWorks().filter(w => w.id !== work.id));
      renderGallery();
    }
  };
  tile.appendChild(del);

  // finished pictures open the fullscreen viewer; unfinished ones resume coloring
  tile.onclick = () => finished ? openViewer(work) : openWork(work.id);
  return tile;
}

function openViewer(work) {
  const cv = document.getElementById('viewerCanvas');
  drawThumb(cv, work);
  const scale = Math.min((window.innerWidth - 28) / work.w, (window.innerHeight - 28) / work.h);
  cv.style.width = Math.round(work.w * scale) + 'px';
  cv.style.height = Math.round(work.h * scale) + 'px';
  document.getElementById('viewerOverlay').classList.add('active');
}
document.getElementById('viewerOverlay').onclick = () =>
  document.getElementById('viewerOverlay').classList.remove('active');

function progressPct(work) {
  const filled = b64ToBytes(work.filled);
  let n = 0;
  for (let i = 0; i < filled.length; i++) n += filled[i];
  return Math.floor((n / filled.length) * 100);
}

function drawThumb(cv, work) {
  const { w, h } = work;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const cells = b64ToBytes(work.cells);
  const filled = b64ToBytes(work.filled);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < cells.length; i++) {
    const c = work.palette[cells[i]];
    const o = i * 4;
    if (filled[i]) {
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
    } else {
      // ghost of the target color so the thumb hints at the picture
      img.data[o] = 200 + c[0] * 0.2; img.data[o + 1] = 200 + c[1] * 0.2; img.data[o + 2] = 200 + c[2] * 0.2;
    }
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------- Image acquisition ----------------
const filePick = document.getElementById('filePick');
const fileCapture = document.getElementById('fileCapture');
let sourceImage = null; // HTMLImageElement of the chosen photo

document.getElementById('srcCancel').onclick = () =>
  document.getElementById('sourceOverlay').classList.remove('active');

async function capacitorPhoto(sourceType) {
  const Camera = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
  if (!Camera) return false;
  try {
    const photo = await Camera.getPhoto({
      resultType: 'dataUrl',
      source: sourceType,          // 'CAMERA' | 'PHOTOS'
      quality: 90,
      width: 1200,
      correctOrientation: true,
    });
    await useImageSrc(photo.dataUrl);
    return true;
  } catch (e) {
    return true; // user cancelled inside native UI; don't fall through to file input
  }
}

document.getElementById('srcCamera').onclick = async () => {
  document.getElementById('sourceOverlay').classList.remove('active');
  if (!(await capacitorPhoto('CAMERA'))) fileCapture.click();
};
document.getElementById('srcGallery').onclick = async () => {
  document.getElementById('sourceOverlay').classList.remove('active');
  if (!(await capacitorPhoto('PHOTOS'))) filePick.click();
};

for (const input of [filePick, fileCapture]) {
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => useImageSrc(reader.result);
    reader.readAsDataURL(f);
  });
}

function useImageSrc(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      showScreen('setup');
      schedulePreview();
      resolve();
    };
    img.src = dataUrl;
  });
}

// ---------------- Setup / quantization ----------------
const gridSizeInput = document.getElementById('gridSizeInput');
const colorCountInput = document.getElementById('colorCountInput');
const previewCanvas = document.getElementById('previewCanvas');
let pendingQuant = null; // {w,h,palette,cells} for current preview

gridSizeInput.oninput = () => { document.getElementById('gridSizeVal').textContent = gridSizeInput.value; schedulePreview(); };
colorCountInput.oninput = () => { document.getElementById('colorCountVal').textContent = colorCountInput.value; schedulePreview(); };
document.getElementById('setupBack').onclick = () => showScreen('gallery');

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(buildPreview, 150);
}

function buildPreview() {
  if (!sourceImage) return;
  const gridMax = +gridSizeInput.value;
  const k = +colorCountInput.value;
  pendingQuant = quantizeImage(sourceImage, gridMax, k);
  const { w, h, palette, cells } = pendingQuant;
  previewCanvas.width = w; previewCanvas.height = h;
  const ctx = previewCanvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < cells.length; i++) {
    const c = palette[cells[i]];
    const o = i * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function quantizeImage(img, gridMax, k) {
  // Downsample to grid resolution (longest side = gridMax)
  const ar = img.width / img.height;
  let w, h;
  if (ar >= 1) { w = gridMax; h = Math.max(2, Math.round(gridMax / ar)); }
  else { h = gridMax; w = Math.max(2, Math.round(gridMax * ar)); }

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // two-step downscale for better averaging on big photos
  const mid = document.createElement('canvas');
  mid.width = Math.max(w * 4, 1); mid.height = Math.max(h * 4, 1);
  const mctx = mid.getContext('2d');
  mctx.imageSmoothingEnabled = true; mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(img, 0, 0, mid.width, mid.height);
  ctx.drawImage(mid, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h).data;
  const px = new Array(w * h);
  for (let i = 0; i < w * h; i++) px[i] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];

  // train on a sample so big grids stay responsive; assignment below still covers every cell
  let train = px;
  if (px.length > 16384) {
    const stride = Math.ceil(px.length / 16384);
    train = [];
    for (let i = 0; i < px.length; i += stride) train.push(px[i]);
  }
  const palette = kmeans(train, k);
  // sort light -> dark so numbering feels natural
  palette.sort((a, b) => (b[0] * 0.299 + b[1] * 0.587 + b[2] * 0.114) - (a[0] * 0.299 + a[1] * 0.587 + a[2] * 0.114));

  const cells = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) cells[i] = nearestIdx(px[i], palette);
  return { w, h, palette, cells };
}

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}
function nearestIdx(p, centers) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < centers.length; j++) {
    const d = dist2(p, centers[j]);
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}

function kmeans(px, k) {
  k = Math.min(k, px.length);
  // deterministic k-means++ style seeding (farthest-point)
  const centers = [px[0].slice()];
  const minD = new Float64Array(px.length).fill(Infinity);
  while (centers.length < k) {
    let far = 0, fd = -1;
    const c = centers[centers.length - 1];
    for (let i = 0; i < px.length; i++) {
      const d = dist2(px[i], c);
      if (d < minD[i]) minD[i] = d;
      if (minD[i] > fd) { fd = minD[i]; far = i; }
    }
    centers.push(px[far].slice());
  }
  const assign = new Uint8Array(px.length);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (let i = 0; i < px.length; i++) {
      const a = nearestIdx(px[i], centers);
      if (a !== assign[i]) { assign[i] = a; changed = true; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      const s = sums[assign[i]];
      s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
    }
    for (let j = 0; j < centers.length; j++) {
      if (sums[j][3] > 0) {
        centers[j] = [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]];
      }
    }
    if (!changed) break;
  }
  // drop empty clusters
  const used = new Set(assign);
  const kept = centers.filter((_, j) => used.has(j));
  return kept.map(c => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]);
}

document.getElementById('createBtn').onclick = () => {
  if (!pendingQuant) return;
  const { w, h, palette, cells } = pendingQuant;
  const work = {
    id: 'w' + Date.now(),
    createdAt: Date.now(),
    w, h, palette,
    cells: bytesToB64(cells),
    filled: bytesToB64(new Uint8Array(w * h)),
  };
  const works = loadWorks();
  works.unshift(work);
  saveWorks(works);
  openWork(work.id);
};

// ---------------- Play ----------------
const boardCanvas = document.getElementById('boardCanvas');
const bctx = boardCanvas.getContext('2d');
const paletteEl = document.getElementById('palette');

let cur = null;      // {work, cells:Uint8Array, filled:Uint8Array, counts, remaining}
let selected = 0;    // selected palette index
let view = { scale: 20, ox: 0, oy: 0 }; // cell size in css px, offset in css px
let dpr = 1;

function openWork(id) {
  const work = loadWorks().find(w => w.id === id);
  if (!work) return;
  const cells = b64ToBytes(work.cells);
  const filled = b64ToBytes(work.filled);
  const counts = new Array(work.palette.length).fill(0);
  const remaining = new Array(work.palette.length).fill(0);
  for (let i = 0; i < cells.length; i++) {
    counts[cells[i]]++;
    if (!filled[i]) remaining[cells[i]]++;
  }
  // palette display: biggest colors first, and numbering follows that order
  const order = counts.map((_, i) => i).sort((a, b) => counts[b] - counts[a] || a - b);
  const dispNum = new Array(order.length);
  order.forEach((idx, pos) => { dispNum[idx] = pos + 1; });
  cur = { work, cells, filled, counts, remaining, order, dispNum };
  selected = order.find(i => remaining[i] > 0) ?? order[0];
  rebuildStateCanvas();
  buildPalette();
  updatePct();
  document.getElementById('toolTray').classList.remove('open');
  showScreen('play');
}

document.getElementById('playBack').onclick = () => {
  persistProgress();
  renderGallery();
  showScreen('gallery');
};
document.getElementById('doneBtn').onclick = () => {
  document.getElementById('doneOverlay').classList.remove('active');
  renderGallery();
  showScreen('gallery');
};

let saveTimer = null;
function persistProgress() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!cur) return;
  const works = loadWorks();
  const w = works.find(x => x.id === cur.work.id);
  if (w) { w.filled = bytesToB64(cur.filled); saveWorks(works); }
}
function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; persistProgress(); }, 1500);
}

let lastSwatchTap = { i: -1, t: 0 };

let swatchEls = []; // palette index -> swatch element (display order is sorted, so DOM position ≠ index)

function buildPalette() {
  paletteEl.innerHTML = '';
  swatchEls = [];
  for (const i of cur.order) {
    const c = cur.work.palette[i];
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    const lum = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    sw.style.color = lum > 140 ? '#222' : '#fff';
    sw.textContent = cur.dispNum[i];
    if (i === selected) sw.classList.add('selected');
    if (cur.remaining[i] === 0) sw.classList.add('done');
    sw.onclick = () => {
      const now = performance.now();
      const isDouble = lastSwatchTap.i === i && now - lastSwatchTap.t < 350;
      lastSwatchTap = { i, t: now };
      selected = i;
      swatchEls.forEach((el, j) => el.classList.toggle('selected', j === selected));
      rebuildStateCanvas();
      // double tap on an unfinished color: zoom to its remaining cells
      if (isDouble && cur.remaining[i] > 0) focusColor(i);
      else drawBoard();
    };
    swatchEls[i] = sw;
    paletteEl.appendChild(sw);
  }
}

// zoom to ~10x10 squares with unfilled cells of the color dead center
let viewAnimId = null;
function focusColor(idx) {
  const { w, h } = cur.work;
  // centroid of the remaining cells of this color
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < cur.cells.length; i++) {
    if (cur.cells[i] === idx && !cur.filled[i]) {
      sx += i % w; sy += (i / w) | 0; n++;
    }
  }
  if (!n) return;
  const mx = sx / n, my = sy / n;
  // center on the remaining cell nearest the centroid, so real work sits mid-screen
  let cx = 0, cy = 0, bd = Infinity;
  for (let i = 0; i < cur.cells.length; i++) {
    if (cur.cells[i] === idx && !cur.filled[i]) {
      const x = i % w, y = (i / w) | 0;
      const d = (x - mx) * (x - mx) + (y - my) * (y - my);
      if (d < bd) { bd = d; cx = x; cy = y; }
    }
  }
  const r = boardCanvas.parentElement.getBoundingClientRect();
  const target = Math.min(10, Math.max(w, h)); // ~10 squares across (or the whole picture if smaller)
  const s = Math.min(90, Math.min(r.width, r.height) / target);
  animateViewTo(s, r.width / 2 - (cx + 0.5) * s, r.height / 2 - (cy + 0.5) * s);
}

function animateViewTo(scale, ox, oy) {
  cancelAnimationFrame(viewAnimId);
  const from = { ...view };
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 300);
    const e = 1 - Math.pow(1 - k, 3); // ease-out
    view.scale = from.scale + (scale - from.scale) * e;
    view.ox = from.ox + (ox - from.ox) * e;
    view.oy = from.oy + (oy - from.oy) * e;
    drawBoard();
    if (k < 1) viewAnimId = requestAnimationFrame(step);
  };
  viewAnimId = requestAnimationFrame(step);
}

// ---------------- Confetti ----------------
const confettiCanvas = document.getElementById('confettiCanvas');
const cfx = confettiCanvas.getContext('2d');
let confetti = [];
let confettiRunning = false;

function burstConfetti(rgb) {
  const r = confettiCanvas.parentElement.getBoundingClientRect();
  confettiCanvas.width = r.width; confettiCanvas.height = r.height;
  const colors = [`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, '#ffd93b', '#6c8cff', '#ec4899', '#4caf50', '#ff9f2e'];
  for (let i = 0; i < 90; i++) {
    confetti.push({
      x: Math.random() * r.width,
      y: -12 - Math.random() * r.height * 0.25,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 2 + Math.random() * 3.5,
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length],
      t: 0,
      ttl: 1300 + Math.random() * 700,
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      cfx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
      for (const p of confetti) {
        p.t += dt;
        p.x += p.vx * dt / 16 + Math.sin(p.t / 200 + p.rot) * 0.6;
        p.y += p.vy * dt / 16;
        p.rot += p.vr * dt / 16;
        cfx.save();
        cfx.translate(p.x, p.y);
        cfx.rotate(p.rot);
        cfx.globalAlpha = Math.max(0, 1 - p.t / p.ttl);
        cfx.fillStyle = p.color;
        cfx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        cfx.restore();
      }
      confetti = confetti.filter(p => p.t < p.ttl && p.y < confettiCanvas.height + 20);
      if (confetti.length) requestAnimationFrame(tick);
      else {
        confettiRunning = false;
        cfx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
      }
    };
    requestAnimationFrame(tick);
  }
}

function updatePct() {
  let n = 0;
  for (let i = 0; i < cur.filled.length; i++) n += cur.filled[i];
  document.getElementById('playPct').textContent = Math.floor((n / cur.filled.length) * 100) + '%';
}

function resizeBoard() {
  dpr = window.devicePixelRatio || 1;
  const r = boardCanvas.parentElement.getBoundingClientRect();
  boardCanvas.width = Math.round(r.width * dpr);
  boardCanvas.height = Math.round(r.height * dpr);
}

function fitView() {
  if (!cur) return;
  const r = boardCanvas.parentElement.getBoundingClientRect();
  const s = Math.min(r.width / cur.work.w, r.height / cur.work.h) * 0.95;
  view.scale = s;
  view.ox = (r.width - cur.work.w * s) / 2;
  view.oy = (r.height - cur.work.h * s) / 2;
}

// low-res mirror of the board state, blitted when zoomed far out (fast path for big grids)
let stateCv = null, stateCtx = null;
function rebuildStateCanvas() {
  if (!cur) return;
  const { w, h, palette } = cur.work;
  if (!stateCv) stateCv = document.createElement('canvas');
  stateCv.width = w; stateCv.height = h;
  stateCtx = stateCv.getContext('2d');
  const img = stateCtx.createImageData(w, h);
  for (let i = 0; i < cur.cells.length; i++) {
    const o = i * 4;
    if (cur.filled[i]) {
      const c = palette[cur.cells[i]];
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
    } else if (cur.cells[i] === selected) {
      img.data[o] = 184; img.data[o + 1] = 184; img.data[o + 2] = 189;
    } else {
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
    }
    img.data[o + 3] = 255;
  }
  stateCtx.putImageData(img, 0, 0);
}
function stateCanvasFill(i) {
  if (!stateCtx) return;
  const c = cur.work.palette[cur.cells[i]];
  stateCtx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  stateCtx.fillRect(i % cur.work.w, Math.floor(i / cur.work.w), 1, 1);
}

function drawBoard() {
  if (!cur) return;
  const { w, h, palette } = cur.work;
  const r = boardCanvas.parentElement.getBoundingClientRect();
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.fillStyle = '#e3e7f2';
  bctx.fillRect(0, 0, r.width, r.height);

  const s = view.scale;

  // zoomed far out: blit the state mirror instead of drawing 10k+ rects
  if (s < 8 && stateCv) {
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(stateCv, view.ox, view.oy, w * s, h * s);
    return;
  }
  const x0 = Math.max(0, Math.floor((-view.ox) / s));
  const y0 = Math.max(0, Math.floor((-view.oy) / s));
  const x1 = Math.min(w - 1, Math.ceil((r.width - view.ox) / s));
  const y1 = Math.min(h - 1, Math.ceil((r.height - view.oy) / s));

  const showNums = s >= 13;
  if (showNums) {
    bctx.font = `${Math.max(8, s * 0.45)}px sans-serif`;
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
  }

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const cx = view.ox + x * s, cy = view.oy + y * s;
      const idx = cur.cells[i];
      if (cur.filled[i]) {
        const c = palette[idx];
        bctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        bctx.fillRect(cx, cy, s + 0.5, s + 0.5);
      } else {
        bctx.fillStyle = idx === selected ? '#b8b8bd' : '#ffffff';
        bctx.fillRect(cx, cy, s + 0.5, s + 0.5);
        if (showNums) {
          bctx.fillStyle = idx === selected ? '#444' : '#999';
          bctx.fillText(String(cur.dispNum[idx]), cx + s / 2, cy + s / 2 + 1);
        }
      }
    }
  }

  // grid lines when zoomed in
  if (s >= 8) {
    bctx.strokeStyle = 'rgba(0,0,0,0.08)';
    bctx.lineWidth = 1;
    bctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) {
      bctx.moveTo(view.ox + x * s, view.oy + y0 * s);
      bctx.lineTo(view.ox + x * s, view.oy + (y1 + 1) * s);
    }
    for (let y = y0; y <= y1 + 1; y++) {
      bctx.moveTo(view.ox + x0 * s, view.oy + y * s);
      bctx.lineTo(view.ox + (x1 + 1) * s, view.oy + y * s);
    }
    bctx.stroke();
  }
}

// ---------------- Tools ----------------
let tool = 'brush'; // 'brush' | 'bucket'
const toolFab = document.getElementById('toolFab');
const toolTray = document.getElementById('toolTray');
const toolBtns = { brush: document.getElementById('toolBrush'), bucket: document.getElementById('toolBucket') };

toolFab.onclick = () => toolTray.classList.toggle('open');
toolBtns.brush.onclick = () => setTool('brush');
toolBtns.bucket.onclick = () => setTool('bucket');

function setTool(t) {
  tool = t;
  toolFab.textContent = t === 'brush' ? '🖌️' : '🪣';
  toolBtns.brush.classList.toggle('active', t === 'brush');
  toolBtns.bucket.classList.toggle('active', t === 'bucket');
  toolTray.classList.remove('open');
}

// all connected colorable cells (4-neighbors, no diagonals) starting at `start`
function regionAt(start) {
  const { w } = cur.work;
  const n = cur.cells.length;
  const out = [];
  const stack = [start];
  const seen = new Uint8Array(n);
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop();
    out.push(i);
    const x = i % w;
    const nbrs = [i - w, i + w];
    if (x > 0) nbrs.push(i - 1);
    if (x < w - 1) nbrs.push(i + 1);
    for (const j of nbrs) {
      if (j >= 0 && j < n && !seen[j] && colorable(j)) { seen[j] = 1; stack.push(j); }
    }
  }
  return out;
}

// ---------------- Pan / zoom / paint ----------------
const pointers = new Map();
let panStart = null;      // {ox, oy, px, py}
let pinchStart = null;    // {dist, scale, mx, my, ox, oy}
let painting = false;     // drag started on a colorable cell -> paint instead of pan
let lastPaint = null;     // last client coords while painting

function cellAt(clientX, clientY) {
  const rect = boardCanvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left - view.ox) / view.scale);
  const y = Math.floor((clientY - rect.top - view.oy) / view.scale);
  if (x < 0 || y < 0 || x >= cur.work.w || y >= cur.work.h) return -1;
  return y * cur.work.w + x;
}
function colorable(i) {
  return i >= 0 && !cur.filled[i] && cur.cells[i] === selected;
}

// fill a colorable cell; returns false when painting should stop (color finished)
function fillCell(i) {
  cur.filled[i] = 1;
  cur.remaining[selected]--;
  stateCanvasFill(i);
  scheduleSave();
  if (cur.remaining[selected] === 0) {
    swatchEls[selected].classList.add('done');
    burstConfetti(cur.work.palette[selected]);
    // advance to the lowest-numbered unfinished color (display order, not palette index)
    const next = cur.order.find(i => cur.remaining[i] > 0);
    if (next !== undefined) {
      selected = next;
      swatchEls.forEach((el, j) => el.classList.toggle('selected', j === selected));
      rebuildStateCanvas();
    } else {
      persistProgress();
      showDone();
    }
    return false;
  }
  return true;
}

function paintAlong(x0, y0, x1, y1) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (view.scale / 2)));
  let any = false;
  for (let s = 0; s <= steps; s++) {
    const i = cellAt(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
    if (colorable(i)) {
      any = true;
      if (!fillCell(i)) { painting = false; break; }
    }
  }
  if (any) { drawBoard(); updatePct(); }
}

boardCanvas.addEventListener('pointerdown', (e) => {
  boardCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  toolTray.classList.remove('open');
  if (pointers.size === 1) {
    pinchStart = null;
    const i = cellAt(e.clientX, e.clientY);
    if (colorable(i)) {
      if (tool === 'bucket') {
        // fill the whole connected block in one tap
        painting = false;
        panStart = null;
        for (const c of regionAt(i)) if (!fillCell(c)) break;
        drawBoard();
        updatePct();
        return;
      }
      painting = true;
      lastPaint = { x: e.clientX, y: e.clientY };
      panStart = null;
      const cont = fillCell(i);
      drawBoard();
      updatePct();
      if (!cont) painting = false;
    } else {
      painting = false;
      panStart = { ox: view.ox, oy: view.oy, px: e.clientX, py: e.clientY };
    }
  } else if (pointers.size === 2) {
    painting = false;
    const [a, b] = [...pointers.values()];
    pinchStart = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      scale: view.scale,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      ox: view.ox, oy: view.oy,
    };
    panStart = null;
  }
});

boardCanvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1 && painting) {
    paintAlong(lastPaint.x, lastPaint.y, e.clientX, e.clientY);
    lastPaint = { x: e.clientX, y: e.clientY };
  } else if (pointers.size === 1 && panStart) {
    view.ox = panStart.ox + (e.clientX - panStart.px);
    view.oy = panStart.oy + (e.clientY - panStart.py);
    drawBoard();
  } else if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const rect = boardCanvas.parentElement.getBoundingClientRect();
    const fit = Math.min(rect.width / cur.work.w, rect.height / cur.work.h) * 0.95;
    let ns = pinchStart.scale * (dist / Math.max(1, pinchStart.dist));
    ns = Math.min(90, Math.max(fit * 0.4, ns));
    // keep the board point under the pinch midpoint fixed
    const k = ns / pinchStart.scale;
    view.scale = ns;
    view.ox = mx - (pinchStart.mx - pinchStart.ox) * k;
    view.oy = my - (pinchStart.my - pinchStart.oy) * k;
    drawBoard();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);

  if (pointers.size === 1) {
    const [p] = [...pointers.values()];
    painting = false;
    panStart = { ox: view.ox, oy: view.oy, px: p.x, py: p.y };
    pinchStart = null;
  } else if (pointers.size === 0) {
    painting = false;
    panStart = null;
    pinchStart = null;
  }
}
boardCanvas.addEventListener('pointerup', endPointer);
boardCanvas.addEventListener('pointercancel', endPointer);

function showDone() {
  const cv = document.getElementById('doneCanvas');
  drawThumb(cv, { ...cur.work, cells: cur.work.cells, filled: bytesToB64(cur.filled) });
  document.getElementById('doneOverlay').classList.add('active');
}

window.addEventListener('resize', () => {
  if (screens.play.classList.contains('active')) { resizeBoard(); drawBoard(); }
});
window.addEventListener('pagehide', persistProgress);
document.addEventListener('visibilitychange', () => { if (document.hidden) persistProgress(); });

renderGallery();
