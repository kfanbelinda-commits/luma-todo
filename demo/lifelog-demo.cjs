/* Demo-only lifelog seed. Never touches real userData. */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WEATHER = ["sunny", "cloudy", "rainy", "windy", "snowy", "storm"];
const MOODS = ["great", "good", "okay", "calm", "low", "awful"];
const NOTES = [
  "今天节奏刚好，把想做的事都推进了一点。",
  "天气不错，出门走了一圈，脑子清爽很多。",
  "有点忙，但晚上还是给自己留了空白。",
  "喝了杯热的，写了几句胡思乱想。",
  "小确幸：午饭很好吃。",
  "开会有点久，回来靠窗发呆五分钟。",
  "和朋友聊了近况，感觉被接住了。",
  "没做成大事，但把桌面收拾干净了。",
  "夜里看了会书，睡眠应该会好一点。",
  "灵感冒了一下，先记下来免得跑掉。",
];

const COVER_FILES = [
  "01-morning-window.jpg",
  "02-soft-flowers.jpg",
  "03-tea-table.jpg",
  "04-notebook.jpg",
  "05-green-leaves.jpg",
  "06-quiet-cafe.jpg",
  "07-soft-sky.jpg",
  "08-linen-bed.jpg",
  "09-walk-path.jpg",
  "10-fruit-bowl.jpg",
  "11-cat-sun.jpg",
  "12-bike-lane.jpg",
  "13-soft-bakery.jpg",
  "14-plant-desk.jpg",
  "15-seaside-soft.jpg",
  "16-evening-lamp.jpg"
];

function pad(n) { return String(n).padStart(2, "0"); }
function keyFor(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function coverPath(name) {
  return path.join(__dirname, "lifelog-covers", name);
}

function listCovers() {
  return COVER_FILES.filter((name) => {
    try {
      return fs.existsSync(coverPath(name)) && fs.statSync(coverPath(name)).size > 2048;
    } catch {
      return false;
    }
  });
}

function tryRestoreCovers() {
  if (listCovers().length) return;
  const repoRoot = path.join(__dirname, "..");
  fs.mkdirSync(path.join(__dirname, "lifelog-covers"), { recursive: true });
  spawnSync("git", ["checkout", "HEAD", "--", "demo/lifelog-covers"], {
    cwd: repoRoot,
    stdio: "ignore",
    windowsHide: true,
    timeout: 15000,
  });
  if (listCovers().length) return;
  spawnSync(process.execPath, [path.join(repoRoot, "scripts", "download-lifelog-covers.cjs")], {
    cwd: repoRoot,
    stdio: "ignore",
    windowsHide: true,
    timeout: 90000,
  });
}

/** Full-month showcase wall for demo mode. */
function buildDemoLifelog(now = new Date()) {
  tryRestoreCovers();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const entries = {};
  const media = [];
  const available = listCovers();

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d, 12, 0, 0, 0);
    const seed = (d * 17 + month * 3) % 10;
    if (seed === 1) continue;

    const key = keyFor(date);
    const weather = WEATHER[(d + month) % WEATHER.length];
    const mood = MOODS[(d * 3 + month) % MOODS.length];
    const note = NOTES[(d + month) % NOTES.length];
    const photos = [];

    if (available.length && (seed >= 3 || d % 2 === 0)) {
      const srcName = available[(d - 1) % available.length];
      const file = key + "-cover.jpg";
      media.push({ relativePath: file, fromFile: coverPath(srcName) });
      photos.push({ id: "demo-" + key + "-1", path: file, addedAt: date.getTime() });
    }

    entries[key] = {
      weather,
      mood,
      note,
      photos,
      coverPhotoId: photos[0] ? photos[0].id : null,
      updatedAt: date.getTime(),
    };
  }

  return { version: 1, entries, media };
}

module.exports = { buildDemoLifelog, WEATHER, MOODS };
