/* テック相関図 service worker (view-only PWA)
 * - data/graph.json: network-first, falls back to cache (offline)
 * - static assets: cache-first
 * VERSION is rewritten by scripts/build_pwa.py on every data build.
 */
const VERSION = "tnm-20261008-081657";
const CACHE = "tnm-pwa-" + VERSION;
const DATA_URL = "data/graph.json";
const ASSETS = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "vendor/vis-network.min.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  DATA_URL,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("tnm-pwa-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname;

  if (rel === DATA_URL) {
    // network-first
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(DATA_URL, copy));
          }
          return res;
        })
        .catch(() => caches.match(DATA_URL, { ignoreSearch: true }))
    );
    return;
  }

  // cache-first (navigation falls back to cached index.html)
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === "navigate" ? caches.match("index.html") : Response.error()));
    })
  );
});
