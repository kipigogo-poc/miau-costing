// MIAU ordering app — offline support.
// Pages and code: network first (always fresh when online), cached copy when offline.
// Brand images: cache first. Firebase/Google requests are never touched, so menu, orders and payments are always live.
const V = "miau-v1";
const SHELL = ["/order.html", "/order.js", "/config.js", "/firebase-public.js", "/manifest.webmanifest",
  "/brand/miau-wordmark.png", "/brand/miau-wordmark@2x.png", "/brand/miau-cats-800.webp",
  "/brand/cat-muzan.webp", "/brand/cat-riri.webp", "/brand/cat-lucy.webp", "/brand/cat-solaire.webp", "/brand/app-192.png"];

self.addEventListener("install", e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/__/")) return;
  if (u.pathname.startsWith("/brand/")) {
    e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok) caches.open(V).then(c => c.put(r, res.clone())); return res; })));
    return;
  }
  const key = r.mode === "navigate" ? "/order.html" : r;   // any app launch URL (?o=…, ?source=app) uses the same page
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key, { ignoreSearch: true })));
});
