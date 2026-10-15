/* Talk PWA service worker (scope: /talk/).
   BUILD_ID is replaced with a timestamp on every deploy (see cf_deploy.py).
   8b.4: install KHÔNG gọi skipWaiting() — SW mới chờ ở trạng thái waiting
   cho đến khi user bấm "Cập nhật" trên banner. Không tự reload (user đang
   nhập liệu/chat sẽ mất trạng thái).
   Strategy: không intercept HTML và /api/ (chat luôn đi network). */
const CACHE = "talk-__BUILD__";
const ASSETS = ["./manifest.json"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener("message", e => {
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
  if (url.pathname.startsWith("/api/")) return; // API luôn đi network
  const isPage = e.request.mode === "navigate" || url.pathname.endsWith(".html");
  if (isPage) return; // HTML do server trả với Cache-Control: no-store
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => hit))
  );
});
