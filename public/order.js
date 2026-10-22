// MIAU customer ordering page. No login. Reads the public menu, creates an order, shows the GCash QR, accepts a reference number.
import { initializeApp, initializeFirestore, persistentLocalCache, doc, setDoc, updateDoc, onSnapshot, collection, serverTimestamp, getDoc, getDocFromCache } from "./firebase-public.js";
import { firebaseConfig, SHOP_ID, INSTAGRAM } from "./config.js";

const $ = s => document.querySelector(s);
// ---- Untrusted data guards: everything from the database is cleaned before it reaches the page ----
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const safeImg = v => (typeof v === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null);
const safeId = v => String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "");
const ORDER_STATUSES = ["awaiting_payment", "payment_submitted", "confirmed", "preparing", "ready", "done", "cancelled"];
const cleanMenu = m => ({ name: String(m.name ?? "Drink").slice(0, 80), group: safeId(m.group) || "drink", cup: num(m.cup), price: num(m.price),
  kcal: num(m.kcal), available: m.available !== false, sort: num(m.sort) ?? 0, ingredients: Array.isArray(m.ingredients) ? m.ingredients.map(x => String(x).slice(0, 200)).slice(0, 40) : [] });
const cleanOrder = o => ({ ...o, code: String(o.code ?? "").slice(0, 8), status: ORDER_STATUSES.includes(o.status) ? o.status : "awaiting_payment",
  total: num(o.total) ?? 0, items: Array.isArray(o.items) ? o.items.slice(0, 30).map(l => ({ name: String(l?.name ?? "").slice(0, 80), cup: num(l?.cup), price: num(l?.price) ?? 0, qty: num(l?.qty) ?? 0 })) : [] });
const cleanSettings = x => ({ ...x, qr: safeImg(x.qr) });
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const peso = v => "₱" + (+v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pesoShort = v => "₱" + ((+v || 0) % 1 ? (+v).toFixed(2) : (+v).toLocaleString("en-PH"));
const app = initializeApp(firebaseConfig);
let db; try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); } catch { db = initializeFirestore(app, {}); }
const P = (...p) => ["shops", SHOP_ID, ...p];

const S = { menu: {}, photos: {}, settings: null, cart: {}, pick: {}, filter: "all", order: null, orderId: null, loaded: 0, err: "" };
try { S.cart = JSON.parse(localStorage.getItem("cart") || "{}"); } catch {}
const saveCart = () => { try { localStorage.setItem("cart", JSON.stringify(S.cart)); } catch {} };
const myOrders = () => { try { return JSON.parse(localStorage.getItem("myOrders") || "[]"); } catch { return []; } };
const STATUS = {
  awaiting_payment: ["Pay to confirm", "Send the exact amount, then enter your reference number."],
  payment_submitted: ["Checking your payment", "We'll confirm in a moment."],
  paid: ["Payment confirmed", "Your order is in the queue."], preparing: ["Preparing", "Your drinks are being made."],
  ready: ["Ready for pickup!", "Show this screen at the counter."], done: ["Picked up", "Thank you! See you again."], cancelled: ["Cancelled", "Please contact the shop if you've already paid."]
};
const STEPS = ["awaiting_payment", "payment_submitted", "paid", "preparing", "ready", "done"];

/* ---------- data ---------- */
onSnapshot(doc(db, ...P("settings", "public")), d => { S.settings = d.exists() ? cleanSettings(d.data()) : { open: false }; S.loaded |= 1; render(); }, () => { S.err = "Can't load the menu right now."; render(); });
onSnapshot(collection(db, ...P("menu")), s => { S.menu = {}; s.forEach(d => { const id = safeId(d.id); if (id) S.menu[id] = cleanMenu(d.data()); }); S.loaded |= 2; syncPhotos();
  for (const id of Object.keys(S.cart)) if (!S.menu[id] || !S.menu[id].available) delete S.cart[id]; saveCart(); render(); }, () => { S.err = "Can't load the menu right now."; render(); });
// Photos: a tiny index (photos/_index) lists each photo's version. A photo is downloaded only when it's new or changed;
// otherwise it comes from this phone's saved copy. Keeps the free database quota for orders, not repeat image downloads.
S.photoIndex = null; S.photoV = {};
const PHOTO_IDX = "_index", QR_ID = "gcash-qr";
async function loadPhoto(id, v) {
  if (S.photoV[id] === v) return; S.photoV[id] = v;
  const ref = doc(db, ...P("photos", id));
  let d = null;
  try { const c = await getDocFromCache(ref); if (c.exists() && c.data().updatedAt === v) d = c.data(); } catch {}
  if (!d) { try { const r = await getDoc(ref); d = r.exists() ? r.data() : null; } catch { S.photoV[id] = null; return; } }
  const img = d && safeImg(d.data); if (img) S.photos[id] = img; else delete S.photos[id];
  render();
}
function syncPhotos() {
  const idx = S.photoIndex; if (!idx) return;
  const want = new Set(Object.values(S.menu).map(m => m.group));
  if (S.order && S.order.status === "awaiting_payment") want.add(QR_ID);
  for (const id of want) { const v = idx[id]; if (typeof v === "number") loadPhoto(id, v); else if (S.photos[id]) { delete S.photos[id]; delete S.photoV[id]; } }
}
let legacyPhotos = null;   // shop that hasn't opened the updated staff app yet: read photos the old way
onSnapshot(doc(db, ...P("photos", PHOTO_IDX)), d => {
  const v = d.exists() ? d.data().v : null;
  if (v && typeof v === "object") { if (legacyPhotos) { legacyPhotos(); legacyPhotos = null; } S.photoIndex = v; syncPhotos(); }
  else if (!legacyPhotos) legacyPhotos = onSnapshot(collection(db, ...P("photos")), s => { S.photos = {}; s.forEach(x => { const img = safeImg(x.data().data); if (img) S.photos[safeId(x.id)] = img; }); render(); }, () => {});
}, () => {});

let unsubOrder = null;
function watchOrder(id) {
  if (unsubOrder) unsubOrder(); S.orderId = id; S.order = null;
  unsubOrder = onSnapshot(doc(db, ...P("orders", id)), d => { S.order = d.exists() ? cleanOrder(d.data()) : false; syncPhotos(); render(); }, () => { S.order = false; render(); });
}
const q = new URLSearchParams(location.search).get("o"); if (q) watchOrder(q);

/* ---------- helpers ---------- */
const view = $("#view");
const cartCount = () => Object.values(S.cart).reduce((a, b) => a + b, 0);
const cartTotal = () => Object.entries(S.cart).reduce((a, [id, n]) => a + (S.menu[id] ? S.menu[id].price * n : 0), 0);
function groups() {
  const g = {};
  Object.entries(S.menu).sort((a, b) => (a[1].sort ?? 0) - (b[1].sort ?? 0)).forEach(([id, m]) => {
    (g[m.group] = g[m.group] || { name: m.name, ingredients: m.ingredients, rows: [] }).rows.push([id, m]);
  });
  return Object.entries(g);
}
function picked(g, rows) {
  const cur = S.pick[g];
  if (cur && rows.some(([id, m]) => id === cur && m.available)) return cur;
  const first = rows.find(([, m]) => m.available) || rows[0];
  return first && first[0];
}
const CATS = ["muzan", "riri", "lucy", "solaire"];
const catFor = g => CATS[[...String(g)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % CATS.length];
const thumb = (g, name, i) => S.photos[g] ? `<img src="${S.photos[g]}" alt="${esc(name)}" loading="lazy">`
  : `<img class="cat" src="brand/cat-${i == null ? catFor(g) : CATS[i % CATS.length]}.webp" alt="" loading="lazy">`;
// Shown while no drinks are published yet. Mascots, not products.
const CREW = [
  { cat: "muzan", name: "Muzan", breed: "Siberian Forest Cat", kcal: 420,
    desc: "A thick, cold-brewed fluffuccino straight from the Siberian woods. Triple-coated in foam and so majestic it's basically royal-tea.",
    inside: "Forest-roast espresso, extra floof, a dash of drama" },
  { cat: "riri", name: "Riri", breed: "Munchkin", kcal: 99,
    desc: "Short pour, big purr-sonality. A fun-sized latte whose legs don't reach the floor but whose attitude reaches the ceiling.",
    inside: "Mini espresso, oat cloud, maximum cute" },
  { cat: "lucy", name: "Lucy", breed: "Himalayan", kcal: 280,
    desc: "A latte with altitude. Silky, flat-faced and fabulously smooth: the creamiest climb this side of Meow-nt Everest.",
    inside: "Peak-roast beans, pink sea-salt cream, one smug little smile" },
  { cat: "solaire", name: "Solaire", breed: "Sphynx", kcal: 9,
    desc: "No fluff, just the good stuff. A bare, bold, sun-kissed americano that answers every riddle in one sip. Praise the sun.",
    inside: "Naked espresso, pure sunshine, zero fur (guaranteed)" }
];
const crewHTML = () => `<div class="grid">${CREW.map((c, i) => `
  <article class="item crew">
    <div class="tile t${i % 3}"><img class="cat" src="brand/cat-${c.cat}.webp" alt="${c.name}, a ${c.breed} in sunglasses" loading="lazy">
      <span class="tag">Meet the crew</span><span class="kcalchip">${c.kcal} kcal*</span></div>
    <div class="ib">
      <h2>${c.name}</h2><p class="breed">${c.breed}</p>
      <p class="desc">${c.desc}</p>
      <p class="ing"><b>Inside</b>${c.inside}</p>
      <div class="buy"><span class="price free">FREE</span><button class="add" data-adopt="${c.cat}">Adopt ${c.name}</button></div>
    </div>
  </article>`).join("")}</div>
  <p class="crewnote">*Mascot calories. Highly scientific. Adoption is free, the purrs are priceless. Real drinks are brewing, check back soon!</p>`;
// Free "adoption": a cute confirmation, then off to our Instagram post. No order is created.
const igOk = u => typeof u === "string" && /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_./?=&%-]+$/.test(u);
const igFor = cat => igOk((INSTAGRAM || {})[cat]) ? INSTAGRAM[cat] : igOk((INSTAGRAM || {}).default) ? INSTAGRAM.default : "";
let adoptTimer = null;
function adopt(catId) {
  const c = CREW.find(x => x.cat === catId); if (!c) return; const IG = igFor(c.cat);
  closeAdopt();
  const d = document.createElement("div"); d.className = "adopt"; d.id = "adopt"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", `${c.name} adopted`);
  d.innerHTML = `<div class="adopt-card">
      <button class="adopt-x" id="adopt-x" aria-label="Close">×</button>
      <img src="brand/cat-${c.cat}.webp" alt="" width="560" height="560">
      <h2>${c.name} is yours! 🐾</h2>
      <p>Adopted for <b>₱0.00</b>. ${c.name} says thanks with ${c.kcal} imaginary calories of love.</p>
      ${IG ? `<p class="adopt-go" id="adopt-go">Taking you to our Instagram…</p>
      <a class="add adopt-ig" href="${IG}" rel="noopener">Open Instagram</a>` : `<p class="adopt-go">Follow us on Instagram for the real menu drop.</p>`}
    </div>`;
  document.body.append(d); document.body.classList.add("adopting");
  d.addEventListener("click", e => { if (e.target === d || e.target.id === "adopt-x") closeAdopt(); });
  if (IG) adoptTimer = setTimeout(() => { location.href = IG; }, 2600);
}
function closeAdopt() { clearTimeout(adoptTimer); adoptTimer = null; const d = document.getElementById("adopt"); if (d) d.remove(); document.body.classList.remove("adopting"); }
addEventListener("keydown", e => { if (e.key === "Escape") closeAdopt(); });
addEventListener("pageshow", e => { if (e.persisted) closeAdopt(); });
function updateBag() {
  const n = cartCount(), open = S.settings && S.settings.open;
  $("#bagn").textContent = n;
  $("#bar").hidden = !(n && open) || !!S.orderId;
  $("#bar-t").textContent = `${n} item${n === 1 ? "" : "s"} · ${peso(cartTotal())}`;
}

/* ---------- menu ---------- */
function render() {
  const s = S.settings || {};
  document.title = "MIAU · " + (S.orderId ? "Your order" : "Order");
  $("#announce").textContent = (s.notice || "Order ahead · Pick up · Pay with GCash").toUpperCase();
  updateBag();
  if ($("#sheet").classList.contains("on") && !S.orderId) renderBag();
  if (S.orderId) return renderOrder();
  if (S.err) { view.innerHTML = `<div class="empty">${esc(S.err)}</div>`; return; }
  if ((S.loaded & 3) !== 3) { view.innerHTML = '<div class="empty">Loading menu…</div>'; return; }
  const all = groups(), mine = myOrders().slice(-3).reverse();
  const shown = all.filter(([g]) => S.filter === "all" || S.filter === g);
  view.innerHTML = `
    <section class="hero">
      <div class="hero-art"><img src="brand/miau-cats-800.webp" srcset="brand/miau-cats-800.webp 800w, brand/miau-cats-1600.webp 1600w" sizes="(min-width:1240px) 1208px, 100vw" alt="Four cool cats in sunglasses lounging on the MIAU letters" width="1600" height="800"></div>
      <div class="hero-copy">
        <div><h1>${all.length ? "Shop all" : "Meet the crew"}</h1><p>${all.length ? "Handcrafted coffee and treats. Order ahead, pay with GCash, skip the line." : "Our menu is still brewing. Until then, say hi to the four cool cats behind MIAU."}</p></div>
        ${all.length ? `<span class="status ${s.open ? "" : "closed"}"><i></i>${s.open ? "Open for orders" : "Closed for online orders"}</span>` : `<span class="status soon"><i></i>Menu coming soon</span>`}
      </div>
      ${mine.length ? `<div class="mine">${mine.map(o => `<a href="?o=${encodeURIComponent(o.id)}">Your order #${esc(o.code)} ›</a>`).join("")}</div>` : ""}
    </section>
    ${all.length > 1 ? `<nav class="filters" aria-label="Filter drinks">${[["all", "All"], ...all.map(([g, grp]) => [g, grp.name])].map(([k, l]) => `<button class="pill" data-filter="${esc(k)}" aria-pressed="${S.filter === k}">${esc(l)}</button>`).join("")}</nav>` : ""}
    <div class="grid">${shown.map(([g, grp], i) => {
      const id = picked(g, grp.rows), m = S.menu[id] || {}, n = S.cart[id] || 0, anyAvail = grp.rows.some(([, x]) => x.available);
      return `<article class="item">
        <div class="tile t${i % 3}">${thumb(g, grp.name, i)}
          ${!anyAvail ? `<span class="tag">Sold out</span>` : ""}
          ${m.kcal != null ? `<span class="kcalchip"><span class="kcal">${m.kcal} kcal</span></span>` : ""}
        </div>
        <div class="ib">
          <h2>${esc(grp.name)}</h2>
          ${grp.ingredients && grp.ingredients.length ? `<p class="ing"><b>Inside</b>${esc(grp.ingredients.join(", "))}</p>` : ""}
          ${grp.rows.length > 1 || grp.rows[0][1].cup ? `<div class="sizes" role="group" aria-label="Size">${grp.rows.map(([rid, r]) =>
            `<button class="sz" data-pick="${esc(g)}" data-id="${rid}" aria-pressed="${rid === id}" ${r.available ? "" : "disabled"}><b>${r.cup ? r.cup + " ml" : "Regular"}</b><span>${pesoShort(r.price)}</span>${r.kcal != null ? `<span>${r.kcal} kcal</span>` : ""}</button>`).join("")}</div>` : ""}
          <div class="buy"><span class="price">${peso(m.price)}</span>
            ${!s.open || !m.available ? `<button class="add" disabled>${!m.available ? "Sold out" : "Closed"}</button>` :
              n ? `<div class="qty"><button data-dec="${id}" aria-label="Remove one">−</button><b>${n}</b><button data-inc="${id}" aria-label="Add one">+</button></div>`
                : `<button class="add" data-inc="${id}" aria-label="Add ${esc(grp.name)} ${m.cup ? m.cup + " ml" : ""} to bag">Add to bag</button>`}
          </div>
        </div>
      </article>`; }).join("")}</div>${all.length ? "" : crewHTML()}`;
}

/* ---------- bag ---------- */
function renderBag() {
  const lines = Object.entries(S.cart).filter(([id]) => S.menu[id]);
  if (!lines.length) {
    $("#sheet").innerHTML = `
      <div class="sh-h"><h3>Your bag</h3><button class="x" id="close" aria-label="Close">✕</button></div>
      <div class="sh-b"><div class="bag-empty"><img src="brand/miau-cats-800.webp" alt=""><p>Looks like your bag is empty.<br>Let's fix that.</p><button class="primary" id="close2" style="width:auto;padding:14px 26px">Start shopping</button></div></div>`;
    return;
  }
  const keep = {}; ["c-name", "c-phone", "c-pick", "c-note"].forEach(k => { const el = document.getElementById(k); if (el) keep[k] = el.value; });
  $("#sheet").innerHTML = `
    <div class="sh-h"><h3>Your bag</h3><button class="x" id="close" aria-label="Close">✕</button></div>
    <div class="sh-b">
      ${lines.map(([id, n]) => { const m = S.menu[id]; return `<div class="bl">
        <div class="th" style="background:var(--sand)">${thumb(m.group, m.name)}</div>
        <div><h4>${esc(m.name)}</h4><small>${m.cup ? m.cup + " ml · " : ""}${peso(m.price)}</small></div>
        <div class="qty"><button data-dec="${id}" aria-label="Remove one">−</button><b>${n}</b><button data-inc="${id}" aria-label="Add one">+</button></div>
      </div>`; }).join("")}
      <div class="sum"><span>Total</span><b>${peso(cartTotal())}</b></div>
      <label class="f"><span>Your name</span><input id="c-name" autocomplete="given-name" maxlength="60" required></label>
      <label class="f"><span>Mobile (optional)</span><input id="c-phone" inputmode="tel" autocomplete="tel" maxlength="20"></label>
      <label class="f"><span>Pickup</span><select id="c-pick"><option>ASAP</option><option>In 15 minutes</option><option>In 30 minutes</option><option>In 45 minutes</option><option>In 1 hour</option></select></label>
      <label class="f"><span>Note (optional)</span><input id="c-note" maxlength="200" placeholder="Less ice, no sugar…"></label>
    </div>
    <div class="sh-f"><div class="err" id="c-err" role="alert"></div><button class="primary" id="place">Place order · ${peso(cartTotal())}</button></div>`;
  Object.entries(keep).forEach(([k, v]) => { const el = document.getElementById(k); if (el) el.value = v; });
}
function openBag() { renderBag(); $("#sheet").classList.add("on"); $("#shade").classList.add("on"); setTimeout(() => { const n = $("#c-name"); if (n && !n.value) n.focus(); }, 260); }
const closeSheet = () => { $("#sheet").classList.remove("on"); $("#shade").classList.remove("on"); };
const randId = n => { const a = new Uint8Array(n), c = "abcdefghijkmnpqrstuvwxyz23456789"; crypto.getRandomValues(a); return [...a].map(x => c[x % c.length]).join(""); };
const randCode = () => { const a = new Uint8Array(4), c = "ACDEFHJKMNPRTUVWXY34679"; crypto.getRandomValues(a); return [...a].map(x => c[x % c.length]).join(""); };

async function place(btn) {
  const name = $("#c-name").value.trim(); if (!name) { $("#c-err").textContent = "Please enter your name."; $("#c-name").focus(); return; }
  const items = Object.entries(S.cart).filter(([id]) => S.menu[id]).map(([id, n]) => ({ menuId: id, name: S.menu[id].name, cup: S.menu[id].cup ?? null, price: S.menu[id].price, qty: n }));
  if (!items.length) return;
  const id = randId(24), code = randCode();
  const order = { code, name, phone: $("#c-phone").value.trim() || null, pickup: $("#c-pick").value, note: $("#c-note").value.trim() || null,
    items, total: Math.round(items.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100, status: "awaiting_payment", paymentRef: null, createdAt: serverTimestamp() };
  btn.disabled = true; btn.textContent = "Placing order…";
  try {
    await setDoc(doc(db, ...P("orders", id)), order);
    const mine = myOrders(); mine.push({ id, code }); localStorage.setItem("myOrders", JSON.stringify(mine.slice(-10)));
    S.cart = {}; saveCart(); closeSheet(); history.pushState({}, "", "?o=" + id); watchOrder(id); window.scrollTo(0, 0);
  } catch (e) { btn.disabled = false; btn.textContent = "Place order"; $("#c-err").textContent = S.settings && !S.settings.open ? "The shop just closed for orders." : "Couldn't place your order. Check your connection and try again."; }
}

/* ---------- order status ---------- */
function renderOrder() {
  $("#bar").hidden = true;
  const o = S.order, s = S.settings || {}, qr = S.photos[QR_ID] || s.qr;
  if (o === null) { view.innerHTML = '<div class="empty">Loading your order…</div>'; return; }
  if (o === false) { view.innerHTML = `<div class="empty">Order not found. <a href="./order.html">Back to menu</a></div>`; return; }
  const [t, sub] = STATUS[o.status] || [o.status, ""], step = STEPS.indexOf(o.status);
  view.innerHTML = `
    <div class="ord">
      <a href="./order.html" class="back">‹ Back to menu</a>
      <div class="ocard">
        <div class="code">Order <b>#${esc(o.code)}</b></div>
        <h2 class="st ${o.status}">${esc(t)}</h2><p class="muted">${esc(sub)}</p>
        ${o.status !== "cancelled" ? `<div class="steps">${["Pay", "Confirmed", "Preparing", "Ready"].map((l, i) => `<span class="${step >= [0, 2, 3, 4][i] ? "on" : ""}">${l}</span>`).join("")}</div>` : ""}
        ${o.status === "ready" || o.status === "done" ? `<div class="ready-art"><img src="brand/miau-cats-800.webp" alt="" width="800" height="400"></div>` : ""}
        ${o.status === "awaiting_payment" ? `
          <div class="pay">
            <div class="amt">Pay exactly <b>${peso(o.total)}</b></div>
            ${qr ? `<img src="${qr}" alt="GCash QR code" class="qr"><a class="ghost" href="${qr}" download="miau-gcash-qr.png">Save QR image</a>
              <p class="hint">On this phone? Save the QR, then upload it in your GCash app's QR scanner.</p>` : ""}
            ${s.gcashNumber ? `<div class="gnum">GCash <b>${esc(s.gcashNumber)}</b>${s.gcashName ? ` · ${esc(s.gcashName)}` : ""} <button class="ghost sm" id="copy-num">Copy</button></div>` : ""}
            <label class="f"><span>GCash reference number</span><input id="ref" inputmode="numeric" autocomplete="off" maxlength="30" placeholder="From your GCash receipt"></label>
            <div class="err" id="ref-err" role="alert"></div>
            <button class="primary" id="paid">I've paid</button>
          </div>` : ""}
        ${o.paymentRef ? `<p class="muted">Reference: <b>${esc(o.paymentRef)}</b></p>` : ""}
        <ul class="lines">${(o.items || []).map(l => `<li><span><b>${+l.qty || 0}×</b> ${esc(l.name)} <i>${l.cup ? Math.round(l.cup) + " ml" : ""}</i></span><span>${peso(l.price * l.qty)}</span></li>`).join("")}</ul>
        <div class="sum"><span>Total</span><b>${peso(o.total)}</b></div>
        <p class="muted" style="font-size:14px">${esc(o.name)} · Pickup ${esc(o.pickup || "ASAP")}${o.note ? ` · “${esc(o.note)}”` : ""}</p>
      </div>
      <p class="hint">Keep this page open. It updates by itself.</p>
    </div>`;
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  { const a = e.target.closest("[data-adopt]"); if (a) { adopt(a.dataset.adopt); return; } }
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.filter) { S.filter = t.dataset.filter; render(); }
  else if (t.dataset.pick) { S.pick[t.dataset.pick] = t.dataset.id; render(); }
  else if (t.dataset.inc) { S.cart[t.dataset.inc] = Math.min(20, (S.cart[t.dataset.inc] || 0) + 1); saveCart(); render(); }
  else if (t.dataset.dec) { const n = (S.cart[t.dataset.dec] || 0) - 1; if (n > 0) S.cart[t.dataset.dec] = n; else delete S.cart[t.dataset.dec]; saveCart(); render(); }
  else if (t.id === "checkout" || t.id === "bagbtn") openBag();
  else if (t.id === "close" || t.id === "close2") closeSheet();
  else if (t.id === "place") place(t);
  else if (t.id === "copy-num") { try { await navigator.clipboard.writeText((S.settings.gcashNumber || "").replace(/\s/g, "")); t.textContent = "Copied"; } catch {} }
  else if (t.id === "paid") {
    const ref = $("#ref").value.replace(/[^A-Za-z0-9]/g, "");
    if (ref.length < 6) { $("#ref-err").textContent = "Enter the reference number from your GCash receipt."; $("#ref").focus(); return; }
    t.disabled = true; t.textContent = "Sending…";
    try { await updateDoc(doc(db, ...P("orders", S.orderId)), { status: "payment_submitted", paymentRef: ref }); }
    catch { t.disabled = false; t.textContent = "I've paid"; $("#ref-err").textContent = "Couldn't send. Check your connection and try again."; }
  }
});
$("#shade").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
window.addEventListener("scroll", () => $("#hdr").classList.toggle("scrolled", scrollY > 8), { passive: true });
window.addEventListener("popstate", () => { const id = new URLSearchParams(location.search).get("o"); if (id) watchOrder(id); else { S.orderId = null; if (unsubOrder) unsubOrder(); render(); } });
render();
