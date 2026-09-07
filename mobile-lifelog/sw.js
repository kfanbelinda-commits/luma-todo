self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("luma-lifelog-v1").then((cache) => cache.addAll(["./", "./index.html", "./manifest.webmanifest"])));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
