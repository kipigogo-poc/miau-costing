// MIAU staff app — Google Sheets two-way sync screen (view "sheets").
// Talks to the Google Sheets API from the browser with the signed-in staff member's own Google permission.
// Uses the app's globals: S, save, remove, render, go, esc, $, view, ORD (from index.html).
import * as E from "./sync-engine.js";          // layout 2: one simple sheet (Masterlist, House-made, a tab per drink)
import * as E1 from "./sync-engine-v1.js";      // old layout: only used once, to sync before moving to layout 2

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const ST = { cfg: null, loaded: false, busy: "", err: "", preview: null, resolve: {}, done: "" };
const q = t => "'" + String(t).replace(/'/g, "''") + "'";

async function call(method, url, body) {
  let tok = await window.miauSheetsToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { method, headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && attempt === 0) { tok = await window.miauSheetsToken(true); continue; }
    if (!r.ok) {
      let m = ""; try { m = (await r.json()).error.message; } catch {}
      if (r.status === 403 && /insufficient.*scope/i.test(m)) { if (window.miauSheetsForget) window.miauSheetsForget(); throw new Error("Google Sheets permission wasn't given. Tap the button again and, on Google's screen, tick the box for Google Sheets."); }
      if (r.status === 403 && /has not been used|disabled/i.test(m)) throw new Error("The Google Sheets API isn't turned on for this project yet (Google Cloud → APIs & Services → Library → Google Sheets API → Enable).");
      if (r.status === 403 || r.status === 404) throw new Error("Can't open that sheet with your Google account. Ask the owner to share it with you (Editor).");
      throw new Error(m || "Google Sheets error " + r.status);
    }
    return r.status === 204 ? null : r.json();
  }
}
const idFrom = s => { const m = String(s || "").match(/\/d\/([a-zA-Z0-9_-]{20,})/) || String(s || "").match(/^([a-zA-Z0-9_-]{20,})$/); return m ? m[1] : null; };
const sheetUrl = id => `https://docs.google.com/spreadsheets/d/${id}/edit`;

async function readAll(id) {
  const meta = await call("GET", `${API}/${id}?fields=properties.title,sheets.properties(title,sheetId)`);
  const titles = meta.sheets.map(s => s.properties.title), out = {};
  if (titles.length) {
    const qs = titles.map(t => "ranges=" + encodeURIComponent(q(t))).join("&");
    const v = await call("GET", `${API}/${id}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`);
    v.valueRanges.forEach((vr, i) => { out[titles[i]] = vr.values || []; });
  }
  return { title: meta.properties.title, tabs: out, ids: Object.fromEntries(meta.sheets.map(s => [s.properties.title, s.properties.sheetId])) };
}
// tab kinds (layout 2 and the old layout)
const isListTab = t => t === E.MASTER || t === E.HOUSE || t === E1.ING_TAB || t === E1.PREP_TAB || t.startsWith("_");
const isHidden = t => t === E.LISTS || t === E.LINKS || t === E1.LIST_TAB;
const isNewDrink = t => !isListTab(t) || t === E.TEMPLATE;
// Make the spreadsheet's tabs match: write these tabs (values only, formatting kept), delete these tabs.
async function writeTabs(id, write, del, existingIds) {
  const reqs = [], fresh = [];
  for (const t of Object.keys(write)) if (!(t in existingIds)) {
    reqs.push({ addSheet: { properties: { title: t, hidden: isHidden(t), gridProperties: isNewDrink(t) ? { frozenRowCount: 6, frozenColumnCount: 1 } : { frozenRowCount: 1, frozenColumnCount: 1 } } } }); fresh.push(t); }
  if (reqs.length) {
    const r = await call("POST", `${API}/${id}:batchUpdate`, { requests: reqs });
    r.replies.forEach((rep, i) => { existingIds[fresh[i]] = rep.addSheet.properties.sheetId; });
    const st = fresh.filter(t => !isHidden(t)).flatMap(t => styleTab(existingIds[t], t)); if (st.length) await call("POST", `${API}/${id}:batchUpdate`, { requests: st });
  }
  const titles = Object.keys(write);
  if (titles.length) {
    await call("POST", `${API}/${id}/values:batchClear`, { ranges: titles.map(q) });
    await call("POST", `${API}/${id}/values:batchUpdate`, { valueInputOption: "RAW", data: titles.map(t => ({ range: q(t) + "!A1", values: write[t].map(r => r.map(x => x ?? "")) })) });
  }
  const dels = del.filter(t => t in existingIds);
  if (dels.length) {
    if (Object.keys(existingIds).length - dels.length < 1) await call("POST", `${API}/${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title: E.HOWTO_TAB } } }] });
    await call("POST", `${API}/${id}:batchUpdate`, { requests: dels.map(t => ({ deleteSheet: { sheetId: existingIds[t] } })) });
    for (const t of dels) delete existingIds[t];
  }
}
// Drop-downs: ingredient names, units, categories, "how it changes". Re-applied on every sync (one request).
async function applyDropdowns(id, specs, ids) {
  const reqs = [];
  for (const [t, list] of Object.entries(specs)) { const sheetId = ids[t]; if (sheetId == null) continue;
    for (const d of list) reqs.push({ setDataValidation: { range: { sheetId, startRowIndex: d.row, endRowIndex: d.rowEnd || 1000, startColumnIndex: d.col, endColumnIndex: d.col + 1 },
      rule: { condition: d.range ? { type: "ONE_OF_RANGE", values: [{ userEnteredValue: d.range }] } : { type: "ONE_OF_LIST", values: d.list.map(v => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false } } }); }
  if (reqs.length) await call("POST", `${API}/${id}:batchUpdate`, { requests: reqs });
}
function styleTab(sheetId, title) {
  const drink = isNewDrink(title), head = drink ? 5 : 0, cream = { red: .953, green: .906, blue: .839 };
  const out = [{ repeatCell: { range: { sheetId, startRowIndex: head, endRowIndex: head + 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: cream } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } }];
  if (drink) out.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } });
  if (title === E.MASTER) out.push({ repeatCell: { range: { sheetId, startColumnIndex: E.MASTER_HEAD.length - 1, endColumnIndex: E.MASTER_HEAD.length }, cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: .65, green: .6, blue: .55 }, italic: true } } }, fields: "userEnteredFormat.textFormat" } });
  if (title === E.HOUSE) out.push({ repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } },
    { repeatCell: { range: { sheetId, startColumnIndex: E.HOUSE_HEAD.length - 1, endColumnIndex: E.HOUSE_HEAD.length }, cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: .65, green: .6, blue: .55 }, italic: true } } }, fields: "userEnteredFormat.textFormat" } });
  out.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: title === E.MASTER ? E.MASTER_HEAD.length : 10 } } });
  return out;
}

// Add the example items (Ground coffee, Water, Cream cheese powder, Espresso, Cold foam) if they aren't there yet.
function addExamples() {
  const byName = n => Object.entries(S.items).find(([, it]) => (it.name || "").trim().toLowerCase() === n.toLowerCase());
  for (const x of E.EXAMPLES.buy) if (!byName(x.name)) { const id = E.slug(x.name); S.items[S.items[id] ? id + "-ex" : id] = Object.assign({}, x); }
  for (const x of E.EXAMPLES.house) if (!byName(x.name)) { const id = E.slug(x.name);
    S.items[S.items[id] ? id + "-ex" : id] = { name: x.name, category: "House-made", unit: x.unit, yieldQty: x.yieldQty, batchMult: 1, note: x.note,
      lines: x.lines.map(([n, q2, u]) => ({ itemId: (byName(n) || [""])[0], qty: q2, unit: u })) }; }
  for (const [id, c] of Object.entries(E.assignCodes(S.items))) S.items[id].code = c;
  for (const id of Object.keys(S.items)) save("items", id, true);
}
// One spreadsheet: _How to use, Masterlist, House-made, the Latte template, a tab per drink (+ hidden helpers).
async function createSheet() {
  addExamples();
  const model = E.appToModel(S.items, S.drinks), tabs = E.modelToTabs(model), shop = (ORD.settings && ORD.settings.shopName) || "MIAU";
  const nm = re => (Object.values(S.items).find(it => re.test(it.name || "")) || {}).name;
  const tpl = E.templateTab({ milk: nm(/^(fresh|full).*milk|^milk$/i), ice: nm(/^ice$/i), espresso: nm(/^espresso$/i) });
  const write = {}; write[E.MASTER] = tabs[E.MASTER]; write[E.HOUSE] = tabs[E.HOUSE]; write[E.TEMPLATE] = tpl;
  for (const t of Object.keys(tabs).filter(t => !t.startsWith("_") && t !== E.MASTER && t !== E.HOUSE).sort()) write[t] = tabs[t];
  write[E.LISTS] = tabs[E.LISTS];
  const r = await call("POST", API, { properties: { title: `${shop} · Costing` }, sheets: [{ properties: { title: E.HOWTO_TAB } }] });
  const id = r.spreadsheetId, ids = { [E.HOWTO_TAB]: r.sheets[0].properties.sheetId };
  await call("POST", `${API}/${id}/values:batchUpdate`, { valueInputOption: "RAW", data: [{ range: q(E.HOWTO_TAB) + "!A1", values: E.HOWTO }] });
  await writeTabs(id, write, [], ids);
  await writeTabs(id, { [E.LINKS]: E.linksRows(model, ids) }, [], ids);
  await applyDropdowns(id, E.dropdowns(Object.assign({}, tabs, { [E.TEMPLATE]: tpl })), ids);
  await saveCfg({ sheetId: id, layout: 2, base: model, at: Date.now(), by: window.miauUserEmail() });
}
const v2 = c => !!(c && c.layout === 2 && c.sheetId);
const single = c => !!(c && c.sheetId);
const connected = c => !!(c && (c.sheetId || (c.ingId && c.menuId)));

// ---------- config (shop settings doc "sync", staff only) ----------
let cfgSub = null;
function loadCfg() {
  if (cfgSub || !S.db) return;
  cfgSub = S.db.collection("settings").doc("sync").onSnapshot(d => { ST.cfg = d.exists ? d.data() : null; ST.loaded = true; if (S.view === "sheets") draw(); }, () => { ST.loaded = true; draw(); });
}
async function saveCfg(c) { ST.cfg = c; await S.db.collection("settings").doc("sync").set(JSON.parse(JSON.stringify(c))); }

// ---------- sync ----------
async function check() {
  const c = ST.cfg, X = v2(c) ? E : E1;
  for (const [id, code] of Object.entries(X.assignCodes(S.items))) { S.items[id].code = code; save("items", id, true); }
  const A = X.appToModel(S.items, S.drinks), base = c.base || {};
  if (v2(c)) { const all = await readAll(c.sheetId); ST.preview = { v: 2, all, A, base, read: E.tabsToModel(all.tabs, all.ids, A, base) }; }
  else {
    let ing, menu;
    if (single(c)) { const all = await readAll(c.sheetId), sp = E1.splitTabs(all.tabs); ing = { tabs: sp.ingredients, ids: all.ids }; menu = { tabs: sp.menu, ids: all.ids }; }
    else [ing, menu] = await Promise.all([readAll(c.ingId), readAll(c.menuId)]);
    ST.preview = { v: 1, ing, menu, A, base, read: E1.tabsToModel(ing.tabs, menu.tabs, A, base) };
  }
  ST.resolve = {}; recompute();
}
const XP = () => (ST.preview && ST.preview.v === 2 ? E : E1);
function recompute() {
  const p = ST.preview; if (!p) return; const X = XP();
  p.m = X.merge(p.base, p.A, p.read.model, p.read.bad, ST.resolve);
  p.problems = X.problems(p.m.result, p.A);
}
async function apply() {
  const p = ST.preview, X = XP(), w = X.modelToApp(p.m.result, p.A, S.items, S.drinks);
  for (const [id, d] of Object.entries(w.items)) if (d === null) remove("items", id); else { S.items[id] = d; save("items", id, true); }
  for (const [id, d] of Object.entries(w.drinks)) if (d === null) remove("drinks", id); else { S.drinks[id] = d; save("drinks", id, true); }
  const F = X.appToModel(S.items, S.drinks);
  let tabsTouched = 0;
  if (p.v === 2) {
    const sid = ST.cfg.sheetId, plan = E.planWrites(F, p.all.tabs, p.read.skipped);
    if (Object.keys(plan.write).length || plan.del.length) await writeTabs(sid, plan.write, plan.del, p.all.ids);
    tabsTouched = Object.keys(plan.write).filter(t => !t.startsWith("_")).length + plan.del.length;
    const links = E.linksRows(F, p.all.ids);
    if (JSON.stringify(links) !== JSON.stringify(p.all.tabs[E.LINKS] || [])) await writeTabs(sid, { [E.LINKS]: links }, [], p.all.ids);
    const dd = E.dropdowns(plan.want); for (const t of p.read.skipped) delete dd[t];
    await applyDropdowns(sid, dd, p.all.ids);
  } else {
    const one = single(ST.cfg), opts = { single: one };
    const plan = E1.planWrites(F, { ingredients: p.ing.tabs, menu: p.menu.tabs }, p.read.skipped, opts);
    if (one) { const write = Object.assign({}, plan.ingredients, plan.menuWrite); if (Object.keys(write).length || plan.menuDelete.length) await writeTabs(ST.cfg.sheetId, write, plan.menuDelete, p.ing.ids); }
    else { if (Object.keys(plan.ingredients).length) await writeTabs(ST.cfg.ingId, plan.ingredients, [], p.ing.ids);
      if (Object.keys(plan.menuWrite).length || plan.menuDelete.length) await writeTabs(ST.cfg.menuId, plan.menuWrite, plan.menuDelete, p.menu.ids); }
    tabsTouched = Object.keys(plan.ingredients).length + Object.keys(plan.menuWrite).length + plan.menuDelete.length;
  }
  await saveCfg(Object.assign({}, ST.cfg, { base: X.nextBase(F, p.base, p.read.skipped), at: Date.now(), by: window.miauUserEmail() }));
  const toApp = p.m.changes.filter(c => c.from === "sheet").length;
  ST.done = !p.m.changes.length && !p.read.errors.length ? "Everything is in sync." : `Synced. ${toApp} change${toApp === 1 ? "" : "s"} brought into the app, ${tabsTouched} sheet tab${tabsTouched === 1 ? "" : "s"} updated.` + (p.read.errors.length ? " Some rows had errors and were skipped (see below)." : "");
  ST.lastErrors = p.read.errors; ST.preview = null;
  if (ST.upgradePending && !p.read.errors.length) { ST.upgradePending = false; await createSheet(); ST.done = UPGRADED; }
}
const UPGRADED = "Done. Your new sheet is ready with Masterlist, House-made and a tab per drink. Your old sheet files are no longer used; you can delete them in Google Drive.";

// Move to the new simpler layout: sync the old sheet(s) first so no edits are lost, then build the new sheet from the app.
async function upgrade() {
  await check(); const p = ST.preview;
  if (p.m.conflicts.length || p.problems.length || p.m.changes.length || p.read.errors.length) { ST.upgradePending = true; return; }
  ST.preview = null; await createSheet(); ST.done = UPGRADED;
}

// ---------- UI ----------
const ago = t => { if (!t) return "never"; const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : new Date(t).toLocaleDateString(); };
async function run(label, fn) { ST.busy = label; ST.err = ""; ST.done = ""; draw(); try { await fn(); } catch (e) { const code = e && e.code;
    ST.err = code === "auth/popup-closed-by-user" ? "The Google window was closed before you allowed access. Tap again and choose Continue."
      : code === "auth/popup-blocked" ? "Your browser blocked the Google window. Allow pop-ups for miauxeveryday.web.app, then tap again."
      : code === "auth/cancelled-popup-request" ? "The Google window was interrupted. Tap again."
      : code === "auth/user-mismatch" ? "Pick the same Google account you're signed in with."
      : (e && e.message) || "Something went wrong."; } ST.busy = ""; draw(); }

// a bigger size of a "same strength" drink: its recipe is calculated, so say that instead of listing removed lines
function followsFirst(key, model) {
  const [t, id] = E.splitKey(key); if (t !== "d" || model[`d:${id}:std`] !== "true") return null;
  const name = model[`d:${id}:name`], sizes = Object.keys(model).filter(k => k.endsWith(":name") && k.startsWith("d:") && model[k] === name).map(k => JSON.parse(model[k.replace(/:name$/, ":size")] || "0"));
  const mine = JSON.parse(model[`d:${id}:size`] || "0"), first = Math.min(...sizes);
  return mine > first ? first : null;
}
function groupChanges(changes, model) {
  const g = {};
  for (const c of changes) { if (c.key.endsWith(":_")) continue; const d = E.describe(c.key, model); const k = c.from + "|" + d.entity; (g[k] = g[k] || { from: c.from, entity: d.entity, kind: d.kind, items: [] }).items.push(c.key.endsWith(":lines") ? { field: d.field, diff: followsFirst(c.key, model) ? `calculated from the ${followsFirst(c.key, model)} ml size (same strength)` : E.lineDiff(c.before, c.after, model) } : { field: d.field, before: E.show(c.before), after: E.show(c.after), added: c.before === undefined, removed: c.after === undefined }); }
  // existence-only changes (added/removed entities)
  for (const c of changes) if (c.key.endsWith(":_")) { const d = E.describe(c.key, model), k = c.from + "|" + d.entity; (g[k] = g[k] || { from: c.from, entity: d.entity, kind: d.kind, items: [] }).status = c.after === undefined ? "removed" : "added"; }
  return Object.values(g);
}
function changeList(groups, from) {
  const gs = groups.filter(x => x.from === from); if (!gs.length) return `<p class="muted" style="margin:0">Nothing.</p>`;
  return `<ul class="sx-list">${gs.map(x => `<li><b>${esc(x.entity)}</b> ${x.status === "added" ? '<span class="badge ok">new</span>' : x.status === "removed" ? '<span class="badge bad">removed</span>' : ""}
    ${x.status ? "" : `<span class="muted">${x.items.map(i => i.diff ? `${esc(i.field)}: <b>${esc(i.diff)}</b>` : `${esc(i.field)}: ${esc(i.before)} → <b>${esc(i.after)}</b>`).join(" · ")}</span>`}</li>`).join("")}</ul>`;
}

function draw() {
  if (S.view !== "sheets") return;
  loadCfg();
  const c = ST.cfg, p = ST.preview, busy = ST.busy;
  const head = `<div class="ph"><div><h1>Google Sheets</h1></div></div>`;
  const msg = (ST.err ? `<div class="card sx-msg bad">${esc(ST.err)}</div>` : "") + (ST.done ? `<div class="card sx-msg ok">${esc(ST.done)}</div>` : "") + (busy ? `<div class="card sx-msg">${esc(busy)}…</div>` : "");
  if (!ST.loaded) { view.innerHTML = head + `<div class="empty">Loading…</div>`; return; }
  if (!connected(c)) {
    view.innerHTML = head + msg + `<div class="card"><div class="card-b sx">
      <p>Keep everything you buy, your house-made recipes and every drink in one Google Sheet, and edit them there or here. <b>Sync</b> brings changes both ways and asks you when the same thing was changed in both places.</p>
      <div class="sx-row"><button class="btn primary" id="sx-create" ${busy ? "disabled" : ""}>Create the sheet from my data</button></div>
      <details class="sx-adv"><summary>Already have the sheet? Connect it</summary>
        <label class="fld"><span>Sheet link</span><input class="in" id="sx-one" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
        <button class="btn" id="sx-link" ${busy ? "disabled" : ""}>Connect</button></details>
      <p class="faint" style="font-size:13px">Google will ask once for permission to use Google Sheets with your account.</p></div></div>`;
    return;
  }
  const open = single(c) ? `<a class="btn" href="${sheetUrl(c.sheetId)}" target="_blank" rel="noopener">Open the Google Sheet ↗</a>`
    : `<a class="btn" href="${sheetUrl(c.ingId)}" target="_blank" rel="noopener">Open Ingredients sheet ↗</a><a class="btn" href="${sheetUrl(c.menuId)}" target="_blank" rel="noopener">Open Menu sheet ↗</a>`;
  const links = `<div class="sx-row">${open}</div>` + (v2(c) ? "" : `
      <div class="sx-err" style="background:var(--accent-soft);color:var(--text)"><b>New, simpler sheet.</b> One file with a <b>Masterlist</b> of everything you buy, a <b>House-made</b> tab (Espresso, Cold foam…), and a tab per drink in ml, with a Latte template you can copy. Sizes can follow your first size at the same strength.
      This syncs your current sheet first, so no edits are lost.
      <div class="sx-row" style="margin-top:8px"><button class="btn primary sm" id="sx-upgrade" ${busy ? "disabled" : ""}>Move to the new sheet</button></div></div>`);
  const status = `<p class="muted" style="margin:0">Last synced ${ago(c.at)}${c.by ? " by " + esc(c.by) : ""}.</p>`;
  if (!p) {
    view.innerHTML = head + msg + `<div class="card"><div class="card-b sx">${status}${links}
      <div class="sx-row"><button class="btn primary" id="sx-check" ${busy ? "disabled" : ""}>Sync now</button></div>
      ${ST.lastErrors && ST.lastErrors.length ? `<div class="sx-err"><b>Rows skipped in Sheets. Fix them, then sync again:</b><ul>${ST.lastErrors.map(e => `<li>${esc(e.where)}: ${esc(e.msg)}</li>`).join("")}</ul></div>` : ""}
      <details class="sx-adv"><summary>Disconnect</summary><p class="faint" style="font-size:13px">The sheets and your app data stay as they are; they just stop syncing.</p><button class="btn danger" id="sx-unlink">Disconnect sheets</button></details>
      </div></div>`;
    return;
  }
  const groups = groupChanges(p.m.changes, Object.assign({}, p.read.model, p.A, p.m.result));
  const nIn = groups.filter(x => x.from === "sheet").length, nOut = groups.filter(x => x.from === "app").length;
  const unresolved = p.m.conflicts.length, blocked = unresolved || p.problems.length;
  const confl = p.m.conflicts.length ? `<div class="card"><div class="card-h"><h2>Changed in both places · pick one</h2></div><div class="card-b"><ul class="sx-list">${p.m.conflicts.map(k => { const d = E.describe(k.key, Object.assign({}, p.read.model, p.A));
      return `<li><b>${esc(d.entity)}</b> <span class="muted">${esc(d.field || (k.app === undefined ? "deleted in app" : k.sheet === undefined ? "deleted in Sheets" : ""))}</span>
      <div class="sx-row"><button class="btn sm" data-sx-pick="app" data-k="${esc(k.key)}">Keep app: ${esc(E.show(k.app))}</button><button class="btn sm" data-sx-pick="sheet" data-k="${esc(k.key)}">Use Sheets: ${esc(E.show(k.sheet))}</button></div></li>`; }).join("")}</ul>
      <div class="sx-row"><button class="btn ghost sm" data-sx-all="app">Keep app for all</button><button class="btn ghost sm" data-sx-all="sheet">Use Sheets for all</button></div></div></div>` : "";
  view.innerHTML = head + msg + `
    ${ST.upgradePending ? `<div class="card sx-msg">First, sync these changes from your current sheet. After you tap Apply, the new sheet is created.</div>` : ""}
    ${p.read.errors.length ? `<div class="card sx-err"><b>${p.read.errors.length} problem${p.read.errors.length > 1 ? "s" : ""} in Sheets. These rows/tabs are skipped and left untouched until fixed:</b><ul>${p.read.errors.map(e => `<li>${esc(e.where)}: ${esc(e.msg)}</li>`).join("")}</ul></div>` : ""}
    ${p.problems.length ? `<div class="card sx-err"><b>Can't sync yet:</b><ul>${p.problems.map(x => `<li>${esc(x)}</li>`).join("")}</ul><p class="faint" style="margin:6px 0 0;font-size:13px">Remove it from those recipes first, or put the ingredient back in the sheet.</p></div>` : ""}
    ${confl}
    <div class="card"><div class="card-h"><h2>From Sheets → app · ${nIn}</h2></div><div class="card-b">${changeList(groups, "sheet")}</div></div>
    <div class="card"><div class="card-h"><h2>From app → Sheets · ${nOut}</h2></div><div class="card-b">${changeList(groups, "app")}</div></div>
    <div class="sx-row" style="margin-top:14px"><button class="btn primary" id="sx-apply" ${blocked || busy ? "disabled" : ""}>${nIn + nOut || unresolved ? "Apply changes" : "Nothing to change · Done"}</button><button class="btn ghost" id="sx-cancel">Cancel</button>
      ${unresolved ? `<span class="muted">Pick a side for ${unresolved} change${unresolved > 1 ? "s" : ""} first.</span>` : ""}</div>`;
}
window.renderSheets = draw;

document.addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t || S.view !== "sheets") return;
  if (t.id === "sx-create") return run("Creating your sheet", createSheet);
  if (t.id === "sx-upgrade") return run("Syncing, then building your new sheet", upgrade);
  if (t.id === "sx-link") { const a = idFrom($("#sx-one").value);
    if (!a) { ST.err = "Paste the sheet link."; return draw(); }
    return run("Connecting", async () => { const all = await readAll(a); await saveCfg({ sheetId: a, layout: all.tabs[E.MASTER] ? 2 : 1, base: {}, at: 0, by: "" }); await check(); }); }
  if (t.id === "sx-check") return run("Reading the sheet", check);
  if (t.id === "sx-cancel") { ST.preview = null; ST.upgradePending = false; return draw(); }
  if (t.id === "sx-apply") return run("Applying changes", apply);
  if (t.id === "sx-unlink") { await saveCfg({ sheetId: null, ingId: null, menuId: null, base: {}, at: 0, by: "" }); ST.done = "Disconnected."; return draw(); }
  if (t.dataset.sxPick) { ST.resolve[t.dataset.k] = t.dataset.sxPick; recompute(); return draw(); }
  if (t.dataset.sxAll) { for (const k of ST.preview.m.conflicts) ST.resolve[k.key] = t.dataset.sxAll; recompute(); return draw(); }
});
