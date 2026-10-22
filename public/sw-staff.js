// MIAU Staff app — lets it install and open as an app. Pages and code: network first, cached copy only when offline.
// Never touches the customer pages (/order…, they have their own worker), Firebase sign-in (/__/) or any Google/Firebase traffic.
const V = "miau-staff-v1";
const SHELL = ["/index.html", "/auth.js", "/config.js", "/firebase.js", "/manifest-staff.webmanifest",
  "/brand/miau-wordmark.png", "/brand/miau-wordmark@2x.png", "/brand/miau-wordmark-light.png", "/brand/cat-solaire.webp", "/brand/staff-192.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("miau-staff-") && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/__/") || u.pathname.startsWith("/order") || u.pathname === "/sw.js") return;
  const key = r.mode === "navigate" ? "/index.html" : r;
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key, { ignoreSearch: true })));
});
