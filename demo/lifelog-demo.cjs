/* Demo-only lifelog seed. Never touches real userData. */
"use strict";

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
const COVER_COLORS = ["#7b8dbf", "#6fa8a8", "#c4a574", "#8b6ef5", "#4aa6a1", "#f58a3d", "#5d8de0", "#a878ad"];

function pad(n) { return String(n).padStart(2, "0"); }
function keyFor(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

/** Full-month showcase wall for demo mode. */
function buildDemoLifelog(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const entries = {};
  const media = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d, 12, 0, 0, 0);
    const seed = (d * 17 + month * 3) % 10;
    if (seed === 1) continue;

    const key = keyFor(date);
    const weather = WEATHER[(d + month) % WEATHER.length];
    const mood = MOODS[(d * 3 + month) % MOODS.length];
    const note = NOTES[(d + month) % NOTES.length];
    const photos = [];

    if (seed >= 3 || d % 2 === 0) {
      const file = key + "-cover.svg";
      const color = COVER_COLORS[d % COVER_COLORS.length];
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="' + color + '"/><stop offset="100%" stop-color="#1c222c"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><circle cx="520" cy="120" r="160" fill="rgba(255,255,255,.12)"/><circle cx="120" cy="520" r="220" fill="rgba(0,0,0,.18)"/><rect x="0" y="0" width="640" height="160" fill="rgba(0,0,0,.18)"/></svg>';
      media.push({ relativePath: file, svg });
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
