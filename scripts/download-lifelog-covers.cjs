const https = require("https");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "demo", "lifelog-covers");
fs.mkdirSync(dir, { recursive: true });

const covers = [
  ["01-morning-window.jpg", "https://images.unsplash.com/photo-1519710164239-da123dc03ef4?auto=format&fit=crop&w=900&h=900&q=60"],
  ["02-soft-flowers.jpg", "https://images.unsplash.com/photo-1490750967868-88aa4486c946?auto=format&fit=crop&w=900&h=900&q=45"],
  ["03-tea-table.jpg", "https://images.unsplash.com/photo-1571934811356-5cc061b6821f?auto=format&fit=crop&w=900&h=900&q=55"],
  ["04-notebook.jpg", "https://images.unsplash.com/photo-1517842645767-c639042777db?auto=format&fit=crop&w=900&h=900&q=55"],
  ["05-green-leaves.jpg", "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=900&h=900&q=50"],
  ["06-quiet-cafe.jpg", "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=900&h=900&q=50"],
  ["07-soft-sky.jpg", "https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=900&h=900&q=50"],
  ["08-linen-bed.jpg", "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&h=900&q=55"],
  ["09-walk-path.jpg", "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=900&h=900&q=50"],
  ["10-fruit-bowl.jpg", "https://images.unsplash.com/photo-1560806887-1e4cd0b6cbd6?auto=format&fit=crop&w=900&h=900&q=50"],
  ["11-cat-sun.jpg", "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=900&h=900&q=50"],
  ["12-bike-lane.jpg", "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=900&h=900&q=50"],
  ["13-soft-bakery.jpg", "https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=900&h=900&q=45"],
  ["14-plant-desk.jpg", "https://images.unsplash.com/photo-1485955900006-10f4d324d411?auto=format&fit=crop&w=900&h=900&q=55"],
  ["15-seaside-soft.jpg", "https://images.unsplash.com/photo-1505142468610-359e7d316be0?auto=format&fit=crop&w=900&h=900&q=50"],
  ["16-evening-lamp.jpg", "https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=900&h=900&q=50"]
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 luma-todo-demo", Accept: "image/*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " for " + url));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

(async () => {
  for (const [name, url] of covers) {
    const out = path.join(dir, name);
    if (fs.existsSync(out) && fs.statSync(out).size > 2048) {
      console.log("skip", name);
      continue;
    }
    try {
      const buf = await fetch(url);
      fs.writeFileSync(out, buf);
      console.log("OK", name, Math.round(buf.length / 1024) + "KB");
    } catch (e) {
      console.error("FAIL", name, e.message);
      process.exitCode = 1;
    }
  }
})();
