/* Generate launcher icons: the game's watermelon (face and all) on every mipmap density. */
'use strict';
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const BG = '#fdf7ef';

// ---- watermelon sprite, ported from www/fruit/fruit.js ----
function drawWatermelon(c, cx, cy, R) {
  const color = '#3f9e4d', dark = '#2c7a38';

  const g = c.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.15, cx, cy, R);
  g.addColorStop(0, 'rgb(152,216,138)');
  g.addColorStop(0.75, color);
  g.addColorStop(1, dark);
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();

  c.save();
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
  c.strokeStyle = 'rgba(20,80,30,0.75)';
  c.lineCap = 'round';
  c.lineWidth = R * 0.16;
  for (let i = -2; i <= 2; i++) {
    c.beginPath();
    c.moveTo(cx + i * R * 0.42, cy - R * 1.05);
    c.quadraticCurveTo(cx + i * R * 0.6, cy, cx + i * R * 0.42, cy + R * 1.05);
    c.stroke();
  }
  c.restore();

  // face
  const ink = '#2d2016';
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
  c.strokeStyle = ink;
  c.lineWidth = R * 0.05;
  c.lineCap = 'round';
  c.beginPath();
  c.arc(cx, cy + R * 0.1, R * 0.17, Math.PI * 0.2, Math.PI * 0.8);
  c.stroke();
  c.fillStyle = 'rgba(255,120,140,0.35)';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(cx + s * R * 0.46, cy + R * 0.16, R * 0.11, R * 0.075, 0, 0, Math.PI * 2);
    c.fill();
  }

  // rim + gloss
  c.strokeStyle = 'rgba(0,0,0,0.25)';
  c.lineWidth = Math.max(1, R * 0.03);
  c.beginPath(); c.arc(cx, cy, R * 0.985, 0, Math.PI * 2); c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.beginPath();
  c.ellipse(cx - R * 0.38, cy - R * 0.45, R * 0.22, R * 0.13, -0.6, 0, Math.PI * 2);
  c.fill();
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function save(canvas, dir, name) {
  fs.writeFileSync(path.join(RES, dir, name), canvas.toBuffer('image/png'));
  console.log(`${dir}/${name}`);
}

// legacy square icon (slightly rounded corners) and round icon
function legacy(size, round) {
  const cv = createCanvas(size, size);
  const c = cv.getContext('2d');
  if (round) {
    c.beginPath(); c.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); c.clip();
  } else {
    roundRectPath(c, 0, 0, size, size, size * 0.12);
    c.clip();
  }
  c.fillStyle = BG;
  c.fillRect(0, 0, size, size);
  drawWatermelon(c, size / 2, size / 2, size * 0.37);
  return cv;
}

// adaptive foreground: transparent, melon inside the 66% safe zone
function foreground(size) {
  const cv = createCanvas(size, size);
  const c = cv.getContext('2d');
  drawWatermelon(c, size / 2, size / 2, size * 0.26);
  return cv;
}

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, size] of Object.entries(densities)) {
  const dir = `mipmap-${d}`;
  save(legacy(size, false), dir, 'ic_launcher.png');
  save(legacy(size, true), dir, 'ic_launcher_round.png');
  save(foreground(Math.round(size * 108 / 48)), dir, 'ic_launcher_foreground.png');
}
console.log('done');
