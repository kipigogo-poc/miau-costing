// Customer ordering page. No login. Reads the public menu, creates an order, shows the GCash QR, accepts a reference number.
import { initializeApp, initializeFirestore, persistentLocalCache, doc, setDoc, updateDoc, onSnapshot, collection, serverTimestamp } from "./firebase-public.js";
import { firebaseConfig, SHOP_ID } from "./config.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const peso = v => "₱" + (+v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const app = initializeApp(firebaseConfig);
let db; try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); } catch { db = initializeFirestore(app, {}); }
const P = (...p) => ["shops", SHOP_ID, ...p];

const S = { menu: {}, photos: {}, settings: null, cart: {}, order: null, orderId: null, loaded: 0, err: "" };
try { S.cart = JSON.parse(localStorage.getItem("cart") || "{}"); } catch {}
const saveCart = () => { try { localStorage.setItem("cart", JSON.stringify(S.cart)); } catch {} };
const myOrders = () => { try { return JSON.parse(localStorage.getItem("myOrders") || "[]"); } catch { return []; } };
const STATUS = {
  awaiting_payment: ["Pay to confirm", "Send the exact amount, then enter your reference number."],
  payment_submitted: ["Checking your payment", "We'll confirm in a moment."],
  paid: ["Payment confirmed", "Your order is in the queue."], preparing: ["Preparing", "Your drinks are being made."],
  ready: ["Ready for pickup", "Show this screen at the counter."], done: ["Picked up", "Thank you!"], cancelled: ["Cancelled", "Please contact the shop if you've already paid."]
};
const STEPS = ["awaiting_payment", "payment_submitted", "paid", "preparing", "ready", "done"];

/* ---------- data ---------- */
onSnapshot(doc(db, ...P("settings", "public")), d => { S.settings = d.exists() ? d.data() : { open: false }; S.loaded |= 1; render(); }, () => { S.err = "Can't load the menu right now."; render(); });
onSnapshot(collection(db, ...P("menu")), s => { S.menu = {}; s.forEach(d => { S.menu[d.id] = d.data(); }); S.loaded |= 2;
  for (const id of Object.keys(S.cart)) if (!S.menu[id] || !S.menu[id].available) delete S.cart[id]; saveCart(); render(); }, () => { S.err = "Can't load the menu right now."; render(); });
onSnapshot(collection(db, ...P("photos")), s => { S.photos = {}; s.forEach(d => { S.photos[d.id] = d.data().data; }); render(); }, () => {});

let unsubOrder = null;
function watchOrder(id) {
  if (unsubOrder) unsubOrder(); S.orderId = id; S.order = null;
  unsubOrder = onSnapshot(doc(db, ...P("orders", id)), d => { S.order = d.exists() ? d.data() : false; render(); }, () => { S.order = false; render(); });
}
const q = new URLSearchParams(location.search).get("o"); if (q) watchOrder(q);

/* ---------- render ---------- */
const view = $("#view");
function cartCount() { return Object.values(S.cart).reduce((a, b) => a + b, 0); }
function cartTotal() { return Object.entries(S.cart).reduce((a, [id, n]) => a + (S.menu[id] ? S.menu[id].price * n : 0), 0); }
function render() {
  const s = S.settings || {};
  $("#shop").textContent = s.shopName || "Order";
  document.title = (s.shopName ? s.shopName + " · " : "") + "Order";
  if (S.orderId) return renderOrder();
  if (S.err) { view.innerHTML = `<div class="empty">${esc(S.err)}</div>`; return; }
  if ((S.loaded & 3) !== 3) { view.innerHTML = '<div class="empty">Loading menu…</div>'; return; }
  const groups = {};
  Object.entries(S.menu).sort((a, b) => (a[1].sort ?? 0) - (b[1].sort ?? 0)).forEach(([id, m]) => { (groups[m.group] = groups[m.group] || { name: m.name, ingredients: m.ingredients, rows: [] }).rows.push([id, m]); });
  const mine = myOrders().slice(-3).reverse();
  view.innerHTML = `
    ${!s.open ? `<div class="banner bad">We're closed for online orders right now.</div>` : ""}
    ${s.notice ? `<div class="banner">${esc(s.notice)}</div>` : ""}
    ${mine.length ? `<div class="mine">${mine.map(o => `<a href="?o=${encodeURIComponent(o.id)}" class="chip">Order #${esc(o.code)} ›</a>`).join("")}</div>` : ""}
    <div class="grid">${Object.entries(groups).map(([g, grp]) => `
      <article class="item">
        <div class="ph">${S.photos[g] ? `<img src="${S.photos[g]}" alt="${esc(grp.name)}" loading="lazy">` : `<span>${esc((grp.name[0] || "?").toUpperCase())}</span>`}</div>
        <div class="ib">
          <h2>${esc(grp.name)}</h2>
          ${grp.ingredients && grp.ingredients.length ? `<p class="ing">${esc(grp.ingredients.join(", "))}</p>` : ""}
          <div class="sizes">${grp.rows.map(([id, m]) => {
            const n = S.cart[id] || 0;
            return `<div class="sz ${m.available ? "" : "off"}">
              <div><b>${m.cup ? m.cup + " ml" : "Regular"}</b><span class="kcal">${m.kcal != null ? m.kcal + " kcal" : ""}</span></div>
              <div class="pr">${peso(m.price)}</div>
              ${!m.available ? `<span class="so">Sold out</span>` : !s.open ? "" :
                n ? `<div class="qty"><button data-dec="${id}" aria-label="Remove one">−</button><b>${n}</b><button data-inc="${id}" aria-label="Add one">+</button></div>`
                  : `<button class="add" data-inc="${id}" aria-label="Add ${esc(grp.name)} ${m.cup || ""} ml">Add</button>`}
            </div>`; }).join("")}</div>
        </div>
      </article>`).join("") || `<div class="empty">The menu isn't online yet.</div>`}</div>
    <p class="foot">Calories are estimates from ingredient labels.</p>`;
  const n = cartCount();
  $("#bar").hidden = !(n && s.open);
  $("#bar-t").textContent = `${n} item${n > 1 ? "s" : ""} · ${peso(cartTotal())}`;
}
function renderCheckout() {
  const lines = Object.entries(S.cart).filter(([id]) => S.menu[id]);
  $("#sheet").innerHTML = `
    <div class="sh-h"><h3>Your order</h3><button class="x" id="close" aria-label="Close">✕</button></div>
    <div class="sh-b">
      <ul class="lines">${lines.map(([id, n]) => { const m = S.menu[id]; return `<li><span><b>${n}×</b> ${esc(m.name)} <i>${m.cup ? m.cup + " ml" : ""}</i></span><span>${peso(m.price * n)}</span></li>`; }).join("")}</ul>
      <div class="tot"><span>Total</span><b>${peso(cartTotal())}</b></div>
      <label class="f"><span>Your name</span><input id="c-name" autocomplete="given-name" maxlength="60" required></label>
      <label class="f"><span>Mobile (optional)</span><input id="c-phone" inputmode="tel" autocomplete="tel" maxlength="20"></label>
      <label class="f"><span>Pickup</span><select id="c-pick"><option>ASAP</option><option>In 15 minutes</option><option>In 30 minutes</option><option>In 45 minutes</option><option>In 1 hour</option></select></label>
      <label class="f"><span>Note (optional)</span><input id="c-note" maxlength="200" placeholder="Less ice, no sugar…"></label>
      <div class="err" id="c-err" role="alert"></div>
    </div>
    <div class="sh-f"><button class="primary" id="place">Place order · ${peso(cartTotal())}</button></div>`;
  $("#sheet").classList.add("on"); $("#shade").classList.add("on"); setTimeout(() => $("#c-name").focus(), 200);
}
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
    S.cart = {}; saveCart(); closeSheet(); history.pushState({}, "", "?o=" + id); watchOrder(id);
  } catch (e) { btn.disabled = false; btn.textContent = "Place order"; $("#c-err").textContent = S.settings && !S.settings.open ? "The shop just closed for orders." : "Couldn't place your order. Check your connection and try again."; }
}
function renderOrder() {
  $("#bar").hidden = true;
  const o = S.order, s = S.settings || {};
  if (o === null) { view.innerHTML = '<div class="empty">Loading your order…</div>'; return; }
  if (o === false) { view.innerHTML = `<div class="empty">Order not found. <a href="./order.html">Back to menu</a></div>`; return; }
  const [t, sub] = STATUS[o.status] || [o.status, ""], step = STEPS.indexOf(o.status);
  view.innerHTML = `
    <div class="ord">
      <a href="./order.html" class="back">‹ Menu</a>
      <div class="code">Order <b>#${esc(o.code)}</b></div>
      <h2 class="st ${o.status}">${t}</h2><p class="muted">${sub}</p>
      ${o.status !== "cancelled" ? `<div class="steps">${["Pay", "Confirmed", "Preparing", "Ready"].map((l, i) => `<span class="${step >= [0, 2, 3, 4][i] ? "on" : ""}">${l}</span>`).join("")}</div>` : ""}
      ${o.status === "awaiting_payment" ? `
        <div class="pay">
          <div class="amt">Pay exactly <b>${peso(o.total)}</b></div>
          ${s.qr ? `<img src="${s.qr}" alt="GCash QR code" class="qr"><a class="ghost" href="${s.qr}" download="gcash-qr.png">Save QR image</a>
            <p class="hint">On this phone? Save the QR, then upload it in your GCash app's QR scanner.</p>` : ""}
          ${s.gcashNumber ? `<div class="gnum">GCash <b>${esc(s.gcashNumber)}</b>${s.gcashName ? ` · ${esc(s.gcashName)}` : ""} <button class="ghost sm" id="copy-num">Copy</button></div>` : ""}
          <label class="f"><span>GCash reference number</span><input id="ref" inputmode="numeric" autocomplete="off" maxlength="30" placeholder="From your GCash receipt"></label>
          <div class="err" id="ref-err" role="alert"></div>
          <button class="primary" id="paid">I've paid</button>
        </div>` : ""}
      ${o.paymentRef ? `<p class="muted">Reference: <b>${esc(o.paymentRef)}</b></p>` : ""}
      <ul class="lines">${(o.items || []).map(l => `<li><span><b>${l.qty}×</b> ${esc(l.name)} <i>${l.cup ? l.cup + " ml" : ""}</i></span><span>${peso(l.price * l.qty)}</span></li>`).join("")}</ul>
      <div class="tot"><span>Total</span><b>${peso(o.total)}</b></div>
      <p class="muted" style="font-size:13px">${esc(o.name)} · Pickup ${esc(o.pickup || "ASAP")}${o.note ? ` · “${esc(o.note)}”` : ""}</p>
      <p class="hint">Keep this page. It updates by itself.</p>
    </div>`;
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.inc) { S.cart[t.dataset.inc] = Math.min(20, (S.cart[t.dataset.inc] || 0) + 1); saveCart(); render(); }
  else if (t.dataset.dec) { const n = (S.cart[t.dataset.dec] || 0) - 1; if (n > 0) S.cart[t.dataset.dec] = n; else delete S.cart[t.dataset.dec]; saveCart(); render(); }
  else if (t.id === "checkout") renderCheckout();
  else if (t.id === "close") closeSheet();
  else if (t.id === "place") place(t);
  else if (t.id === "copy-num") { try { await navigator.clipboard.writeText((S.settings.gcashNumber || "").replace(/\s/g, "")); t.textContent = "Copied"; } catch {} }
  else if (t.id === "paid") {
    const ref = $("#ref").value.replace(/\s/g, "");
    if (ref.length < 6) { $("#ref-err").textContent = "Enter the reference number from your GCash receipt."; $("#ref").focus(); return; }
    t.disabled = true; t.textContent = "Sending…";
    try { await updateDoc(doc(db, ...P("orders", S.orderId)), { status: "payment_submitted", paymentRef: ref }); }
    catch { t.disabled = false; t.textContent = "I've paid"; $("#ref-err").textContent = "Couldn't send. Check your connection and try again."; }
  }
});
$("#shade").addEventListener("click", closeSheet);
window.addEventListener("popstate", () => { const id = new URLSearchParams(location.search).get("o"); if (id) watchOrder(id); else { S.orderId = null; if (unsubOrder) unsubOrder(); render(); } });
render();
