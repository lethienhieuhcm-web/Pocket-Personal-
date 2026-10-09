/* Stocks PWA service worker (scope: /chess/).
   BUILD_ID is replaced with a timestamp on every deploy (see cf_deploy.py).
   Strategy: network-first for pages, cache-first for static assets. */
const CACHE = "chess-__BUILD__";
const ASSETS = ["./manifest.json"];
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
  const isPage = e.request.mode === "navigate" || url.pathname.endsWith(".html");
  if (isPage) {
    // Don't intercept HTML: let browser handle with Cache-Control: no-cache from server
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});
