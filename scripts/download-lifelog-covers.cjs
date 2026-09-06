const https = require("https");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "demo", "lifelog-covers");
fs.mkdirSync(dir, { recursive: true });

const covers = [
  ["01-kitchen-morning.jpg", "https://images.unsplash.com/photo-1556911220-bff31c8750ea?auto=format&fit=crop&w=800&h=800&q=70"],
  ["02-messy-desk.jpg", "https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=800&h=800&q=70"],
  ["03-commute-window.jpg", "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?auto=format&fit=crop&w=800&h=800&q=65"],
  ["04-home-sofa.jpg", "https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?auto=format&fit=crop&w=800&h=800&q=68"],
  ["05-laundry-day.jpg", "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=800&h=800&q=70"],
  ["06-night-desk-lamp.jpg", "https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=800&h=800&q=68"],
  ["07-rain-street.jpg", "https://images.unsplash.com/photo-1428908728789-d2de25dbd4e2?auto=format&fit=crop&w=800&h=800&q=65"],
  ["08-simple-lunch.jpg", "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&h=800&q=65"],
  ["09-hands-coffee.jpg", "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=800&h=800&q=62"],
  ["10-bedroom-corner.jpg", "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=800&h=800&q=65"],
  ["11-supermarket-bag.jpg", "https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=800&h=800&q=65"],
  ["12-evening-walk.jpg", "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=800&h=800&q=55"],
  ["13-phone-notes.jpg", "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=800&h=800&q=65"],
  ["14-bus-seat.jpg", "https://images.unsplash.com/photo-1544620341-fac388f98a7e?auto=format&fit=crop&w=800&h=800&q=65"],
  ["15-plant-window.jpg", "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=800&h=800&q=60"],
  ["16-late-snack.jpg", "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&h=800&q=55"]
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
