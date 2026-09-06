const https = require("https");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "demo", "lifelog-covers");
fs.mkdirSync(dir, { recursive: true });

const covers = [
  ["01-night-city.jpg", "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=800&h=800&q=70"],
  ["02-travel-street.jpg", "https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=800&h=800&q=70"],
  ["03-cafe.jpg", "https://images.unsplash.com/photo-1554118811-1e0d58224f24?auto=format&fit=crop&w=800&h=800&q=70"],
  ["04-food.jpg", "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&h=800&q=70"],
  ["05-park-walk.jpg", "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=800&h=800&q=70"],
  ["06-sunset.jpg", "https://images.unsplash.com/photo-1495610813249-ce8720c5c0d4?auto=format&fit=crop&w=800&h=800&q=70"],
  ["07-rainy-window.jpg", "https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?auto=format&fit=crop&w=800&h=800&q=70"],
  ["08-desk-life.jpg", "https://images.unsplash.com/photo-1497215728101-536d6f1e9af0?auto=format&fit=crop&w=800&h=800&q=70"],
  ["09-subway.jpg", "https://images.unsplash.com/photo-1520006403909-838d6b92c22e?auto=format&fit=crop&w=800&h=800&q=70"],
  ["10-beach.jpg", "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=800&h=800&q=70"],
  ["11-mountain.jpg", "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=800&h=800&q=70"],
  ["12-friends-silhouette.jpg", "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?auto=format&fit=crop&w=800&h=800&q=70"],
  ["13-neon-night.jpg", "https://images.unsplash.com/photo-1563089145-599997674d42?auto=format&fit=crop&w=800&h=800&q=70"],
  ["14-morning-coffee.jpg", "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=800&h=800&q=70"],
  ["15-city-skyline.jpg", "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=800&h=800&q=70"],
  ["16-road-trip.jpg", "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=800&h=800&q=70"]
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
