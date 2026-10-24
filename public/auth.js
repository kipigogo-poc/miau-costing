// Google sign-in gate + Firestore storage adapter for the costing app.
// The app talks to window.claude.use("db"); this file supplies that, backed by Firestore.
import {
  initializeApp, getAuth, GoogleAuthProvider, signInWithPopup, reauthenticateWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, setPersistence, browserLocalPersistence,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, getDocs,
  getDoc, getDocFromCache, query, where, orderBy, limit
} from "./firebase.js";
import { firebaseConfig, SHOP_ID, SHOP_NAME } from "./config.js";

const $ = s => document.querySelector(s);
const gate = $("#gate"), gateMsg = $("#gate-msg"), gateBtn = $("#gate-btn");
$("#gate-shop").textContent = (SHOP_NAME ? SHOP_NAME + " · " : "") + "Staff";
try { const m = sessionStorage.getItem("gateMsg"); if (m) { gateMsg.innerHTML = m; gateBtn.textContent = "Use another Google account"; sessionStorage.removeItem("gateMsg"); } } catch {}

let app, auth, db;
try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch { db = initializeFirestore(app, {}); }            // e.g. private browsing without IndexedDB
  setPersistence(auth, browserLocalPersistence).catch(() => {});
} catch (e) {
  gateMsg.textContent = "Setup needed: paste your Firebase config into config.js.";
  gateBtn.disabled = true;
  throw e;
}

/* ---------- storage adapter (same shape the app already uses) ---------- */
const mapErr = e => { const c = e && e.code; throw { code: c === "permission-denied" ? "invalid_argument" : c === "resource-exhausted" ? "quota_exceeded" : "unavailable", message: e && e.message }; };
const QC = { where, orderBy, limit };
const snapOut = s => ({ metadata: { hasPendingWrites: s.metadata.hasPendingWrites, fromCache: s.metadata.fromCache },
  docs: s.docs.map(d => ({ id: d.id, exists: true, data: () => d.data() })) });
function makeDb() {
  return {
    collection(name) {
      const ref = collection(db, "shops", SHOP_ID, name);
      return {
        // constraints: [["where", field, op, value], ["orderBy", field, "desc"], ["limit", n]]
        query(cons) {
          const q = query(ref, ...cons.map(([k, ...a]) => QC[k](...a)));
          return {
            onSnapshot: (next, err) => onSnapshot(q, s => next(snapOut(s)), e => { if (e.code === "permission-denied") noAccess(); err && err(e); }),
            get: () => getDocs(q).then(snapOut).catch(mapErr)
          };
        },
        getAll: () => getDocs(ref).then(snapOut).catch(mapErr),
        onSnapshot(next, err) {
          return onSnapshot(ref, { includeMetadataChanges: true },
            s => next({ metadata: { hasPendingWrites: s.metadata.hasPendingWrites, fromCache: s.metadata.fromCache },
                        docs: s.docs.map(d => ({ id: d.id, exists: true, data: () => d.data() })) }),
            e => { if (e.code === "permission-denied") noAccess(); err && err({ code: e.code === "permission-denied" ? "revoked" : "unavailable", message: e.message }); });
        },
        doc(id) {
          const r = doc(ref, id);
          return { set: (b, o) => (o ? setDoc(r, b, o) : setDoc(r, b)).catch(mapErr), update: b => updateDoc(r, b).catch(mapErr), delete: () => deleteDoc(r).catch(mapErr),
            onSnapshot: (next, err) => onSnapshot(r, d => next({ id: d.id, exists: d.exists(), data: () => d.data() }), e => err && err(e)),
            // Saved copy if it matches version v (photo updatedAt), otherwise one download.
            async getVersion(v) {
              try { const c = await getDocFromCache(r); if (c.exists() && c.data().updatedAt === v) return c.data(); } catch {}
              const d = await getDoc(r); return d.exists() ? d.data() : null;
            } };
        }
      };
    }
  };
}

/* ---------- sign-in ---------- */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
// Google doesn't allow sign-in inside Messenger/Facebook/Instagram etc. Say so up front.
const UA = navigator.userAgent, IN_APP = /FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\/|TikTok|Twitter/i.test(UA), IOS = /iPhone|iPad|iPod/.test(UA);
const BLOCKED_MSG = IN_APP
  ? `Google sign-in doesn't work inside this app. Tap <b>${IOS ? "⋯" : "⋮"}</b> → <b>Open in ${IOS ? "Safari" : "Chrome"}</b>, then sign in there.`
  : `Your browser blocked the sign-in step. Open this page in <b>${IOS ? "Safari" : "Chrome"}</b> (not a private window) and try again.`;
if (IN_APP) gateMsg.innerHTML = BLOCKED_MSG;
gateBtn.addEventListener("click", async () => {
  gateMsg.textContent = "";
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") { await signInWithRedirect(auth, provider); return; }
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") gateMsg.textContent = "Sign-in failed. Try again.";
  }
});
getRedirectResult(auth).catch(e => { gateMsg.innerHTML = /missing-initial-state|web-storage-unsupported|initial state/i.test((e && (e.code + " " + e.message)) || "") ? BLOCKED_MSG : "Sign-in failed. Try again."; });

// Google Sheets permission (asked only when someone uses Sheets sync). Token lives in memory for ~55 minutes.
let sheetsTok = null;
let sheetsAsking = null;     // one Google window at a time: everyone waiting shares it
window.miauSheetsToken = async (force) => {
  if (!force && sheetsTok && sheetsTok.exp > Date.now()) return sheetsTok.t;
  if (sheetsAsking) return sheetsAsking;
  sheetsAsking = askSheets().finally(() => { sheetsAsking = null; });
  return sheetsAsking;
};
async function askSheets() {
  const u = auth.currentUser; if (!u) throw new Error("Sign in first.");
  const p = new GoogleAuthProvider(); p.addScope("https://www.googleapis.com/auth/spreadsheets");
  p.setCustomParameters({ login_hint: u.email || "" });
  const r = await reauthenticateWithPopup(u, p), c = GoogleAuthProvider.credentialFromResult(r);
  if (!c || !c.accessToken) throw new Error("Google didn't give permission to use Sheets.");
  sheetsTok = { t: c.accessToken, exp: Date.now() + 55 * 60 * 1000 }; return sheetsTok.t;
}
window.miauSheetsForget = () => { sheetsTok = null; };
window.miauUserEmail = () => (auth.currentUser && auth.currentUser.email) || "";

let denied = false;
function noAccess() {
  if (denied) return; denied = true;
  gate.hidden = false; document.body.classList.add("locked");
  gateMsg.innerHTML = `<b>${esc(auth.currentUser?.email || "This account")}</b> doesn't have access.`;
  gateBtn.textContent = "Use another Google account";
  try { sessionStorage.setItem("gateMsg", gateMsg.innerHTML); } catch {}
  signOut(auth).catch(() => {});
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let resolved = false;
onAuthStateChanged(auth, user => {
  if (user) {
    gate.hidden = true; document.body.classList.remove("locked");
    renderAccount(user);
    if (!resolved) { resolved = true; window.__resolveDb(makeDb()); }
  } else {
    gate.hidden = false; document.body.classList.add("locked");
    if (resolved) location.reload();                 // signed out: drop in-memory data
  }
});

/* ---------- account menu: backup, restore, sign out ---------- */
function renderAccount(user) {
  const initial = (user.displayName || user.email || "?").trim()[0].toUpperCase();
  const btn = `<span class="avatar">${esc(initial)}</span>`;
  $("#acct-side").innerHTML = `<button class="nav" id="acct-open" style="margin-top:8px">${btn}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user.email)}</span></button>`;
  $("#acct-tab").innerHTML = `${btn}<span>Account</span>`;
}
const sheet = $("#acct-sheet"), shade = $("#acct-shade");
function openSheet() {
  const u = auth.currentUser; if (!u) return;
  sheet.innerHTML = `
    <div class="dh"><h3>Account</h3><button class="icon-btn" id="acct-close" aria-label="Close">✕</button></div>
    <div class="db">
      <div><div style="font-weight:600">${esc(u.displayName || "")}</div><div class="muted">${esc(u.email)}</div></div>
      <div class="fld"><span>Backup</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="acct-export">Download backup</button>
          <label class="btn" for="acct-file" style="cursor:pointer">Restore from file</label>
          <input type="file" id="acct-file" accept="application/json,.json" hidden>
        </div>
        <div class="faint" id="acct-msg" style="font-size:12px;min-height:16px"></div>
      </div>
      <div class="fld"><span>Google Sheets</span><div><button class="btn" id="acct-sheets">Ingredients &amp; menu in Google Sheets</button></div></div>
      ${window.miauStandalone ? "" : `<div class="fld"><span>App</span>
        <div><button class="btn primary" id="acct-install">Install MIAU Staff app</button></div>
        <div class="faint" id="acct-install-msg" style="font-size:13px;line-height:1.5"></div></div>`}
    </div>
    <div class="df"><span></span><button class="btn danger" id="acct-signout">Sign out</button></div>`;
  sheet.classList.add("on"); shade.classList.add("on");
}
function closeSheet() { sheet.classList.remove("on"); shade.classList.remove("on"); }
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.id === "acct-open" || t.id === "acct-tab") openSheet();
  else if (t.id === "acct-close") closeSheet();
  else if (t.id === "acct-signout") signOut(auth);
  else if (t.id === "acct-export") exportBackup();
  else if (t.id === "acct-import-go") importNow();
  else if (t.id === "acct-sheets") { closeSheet(); if (typeof go === "function") go("sheets"); }
  else if (t.id === "acct-install" && window.miauInstall) window.miauInstall().then(r => {
    const m = $("#acct-install-msg"); if (!m) return;
    if (r === "installed") { m.textContent = "Installed. Open MIAU Staff from your home screen or apps."; t.hidden = true; }
    else if (r !== "dismissed") m.innerHTML = r;   // fixed text from staff-pwa.js, no user data
  });
});
shade.addEventListener("click", closeSheet);

async function exportBackup() {
  const out = { app: "drink-costing", version: 2, shop: SHOP_ID, exportedAt: new Date().toISOString(), items: {}, drinks: {}, photos: {}, settings: {}, orders: {} };
  for (const c of BACKUP) (await getDocs(collection(db, "shops", SHOP_ID, c))).forEach(d => { out[c][d.id] = d.data(); });
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `drink-costing-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  $("#acct-msg").textContent = `Downloaded ${Object.keys(out.items).length} items, ${Object.keys(out.drinks).length} drinks, ${Object.keys(out.photos).length} photos, ${Object.keys(out.orders).length} orders.`;
}
const BACKUP = ["items", "drinks", "photos", "settings", "orders"];
let pendingImport = null;
document.addEventListener("change", async e => {
  if (e.target.id !== "acct-file") return;
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || typeof data.items !== "object" || typeof data.drinks !== "object") throw 0;
    pendingImport = data;
    $("#acct-msg").innerHTML = `${Object.keys(data.items).length} items, ${Object.keys(data.drinks).length} drinks. Items with the same id will be replaced. <button class="btn sm primary" id="acct-import-go">Restore</button>`;
  } catch { $("#acct-msg").textContent = "That file isn't a Drink Costing backup."; }
});
async function importNow() {
  if (!pendingImport) return;
  const ops = [];
  for (const c of BACKUP) for (const [id, body] of Object.entries(pendingImport[c] || {})) ops.push([c, id, body]);
  try {
    for (let i = 0; i < ops.length; i += 100) {
      const b = writeBatch(db);
      ops.slice(i, i + 100).forEach(([c, id, body]) => b.set(doc(db, "shops", SHOP_ID, c, id), body));
      await b.commit();
    }
    $("#acct-msg").textContent = `Restored ${ops.length} records.`; pendingImport = null;
  } catch (e) { $("#acct-msg").textContent = e.code === "permission-denied" ? "No permission to write." : "Restore failed. Check your connection and try again."; }
}
