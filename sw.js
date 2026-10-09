/* Read & Learn service worker.
   BUILD_ID is replaced with a timestamp on every deploy (see cf_deploy.py),
   so each deploy gets a fresh cache and old caches are wiped.
   Strategy: network-first for HTML (UI always fresh), cache-first for static assets. */
const CACHE = "readlearn-__BUILD__";
const ASSETS = ["./manifest.json", "./design-system.css",
  "./icons/icon-english-192.png", "./icons/icon-english-512.png",
  "./icons/icon-english-maskable-512.png"];
self.addEventListener("install", e => {
  // Do NOT call skipWaiting() here - let the new SW wait until user confirms update
  // (big tech pattern: user controls when to update)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener("message", e => {
  // When user clicks "Update" in the banner, activate the waiting SW
  if(e.data && e.data.type === "SKIP_WAITING"){
    self.skipWaiting();
  }
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // never cache API
  const isPage = e.request.mode === "navigate"
    || url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname.endsWith("sw.js");
  if (isPage) {
    // Don't intercept HTML: let browser handle with Cache-Control: no-cache from server
    return;
  }
  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});
