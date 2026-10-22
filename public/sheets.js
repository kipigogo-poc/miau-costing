// MIAU staff app — Google Sheets two-way sync screen (view "sheets").
// Talks to the Google Sheets API from the browser with the signed-in staff member's own Google permission.
// Uses the app's globals: S, save, remove, render, go, esc, $, view, ORD (from index.html).
import * as E from "./sync-engine.js";

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
// Make the spreadsheet's tabs match: write these tabs (values only, formatting kept), delete these tabs.
async function writeTabs(id, write, del, existingIds) {
  const reqs = [], fresh = [];
  for (const t of Object.keys(write)) if (!(t in existingIds)) { reqs.push({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: isListTab(t) ? 1 : 7, frozenColumnCount: isListTab(t) ? 2 : 3 } } } }); fresh.push(t); }
  if (reqs.length) {
    const r = await call("POST", `${API}/${id}:batchUpdate`, { requests: reqs });
    r.replies.forEach((rep, i) => { existingIds[fresh[i]] = rep.addSheet.properties.sheetId; });
    await call("POST", `${API}/${id}:batchUpdate`, { requests: fresh.flatMap(t => styleTab(existingIds[t], t)) });
  }
  const titles = Object.keys(write);
  if (titles.length) {
    await call("POST", `${API}/${id}/values:batchClear`, { ranges: titles.map(q) });
    await call("POST", `${API}/${id}/values:batchUpdate`, { valueInputOption: "RAW", data: titles.map(t => ({ range: q(t) + "!A1", values: write[t].map(r => r.map(x => x ?? "")) })) });
  }
  const dels = del.filter(t => t in existingIds);
  if (dels.length) {
    // a spreadsheet must keep at least one tab
    if (Object.keys(existingIds).length - dels.length < 1) await call("POST", `${API}/${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title: "_How to use" } } }] });
    await call("POST", `${API}/${id}:batchUpdate`, { requests: dels.map(t => ({ deleteSheet: { sheetId: existingIds[t] } })) });
    for (const t of dels) delete existingIds[t];
  }
}
const isListTab = t => t === E.ING_TAB || t === E.PREP_TAB || t.startsWith("_");
// Drop-downs: Ingredient names from the masterlist, units, categories. Re-applied on every sync (cheap, one request).
async function applyDropdowns(id, specs, ids) {
  const reqs = [];
  for (const [t, list] of Object.entries(specs)) { const sheetId = ids[t]; if (sheetId == null) continue;
    for (const d of list) reqs.push({ setDataValidation: { range: { sheetId, startRowIndex: d.row, endRowIndex: 1000, startColumnIndex: d.col, endColumnIndex: d.col + 1 },
      rule: { condition: d.range ? { type: "ONE_OF_RANGE", values: [{ userEnteredValue: d.range }] } : { type: "ONE_OF_LIST", values: d.list.map(v => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false } } }); }
  if (reqs.length) await call("POST", `${API}/${id}:batchUpdate`, { requests: reqs });
}
function styleTab(sheetId, title) {
  const isList = isListTab(title), head = isList ? 0 : 6;
  return [
    { repeatCell: { range: { sheetId, startRowIndex: head, endRowIndex: head + 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: .953, green: .906, blue: .839 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
    ...(isList ? [] : [{ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } },
      { repeatCell: { range: { sheetId, startRowIndex: 4, endRowIndex: 5 }, cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: .6, green: .55, blue: .5 }, italic: true } } }, fields: "userEnteredFormat.textFormat" } }]),
    { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: isList ? 16 : 12 } } }
  ];
}
const HOWTO = [["How to use these sheets"], [""], ["• Edit prices, amounts and recipes here or in the MIAU staff app. Then press Sync in the app (Account → Google Sheets)."], ["• Pick ingredients from the drop-down in the Ingredient column. The Code fills in by itself on the next sync."],
  ["• Ingredients: one row per item. The Code (e.g. ING-001) links everything. Don't reuse a code."], ["• Menu: one tab per drink, one column per size. Leave a cell blank if a size doesn't use that ingredient. Type ? if the amount is still unknown."],
  ["• New drink: duplicate a tab and rename it. New size: add a column like \"828 ml\" before \"Same in every size\"."], ["• The App ID row is filled in by the app. Don't edit it."], ["• Tabs whose name starts with _ (like this one) are ignored."]];

// One spreadsheet holds everything: _How to use, Ingredients, House-made recipes, then one tab per drink.
async function createSheet() {
  const items = S.items, codes = E.assignCodes(items);
  for (const [id, c] of Object.entries(codes)) { items[id].code = c; save("items", id, true); }
  const model = E.appToModel(items, S.drinks), tabs = E.modelToTabs(model, { single: true }), shop = (ORD.settings && ORD.settings.shopName) || "MIAU";
  const dd = E.dropdowns(tabs, { single: true });
  const r = await call("POST", API, { properties: { title: `${shop} · Costing` }, sheets: [{ properties: { title: "_How to use" } }] });
  const id = r.spreadsheetId, ids = { "_How to use": r.sheets[0].properties.sheetId };
  await call("POST", `${API}/${id}/values:batchUpdate`, { valueInputOption: "RAW", data: [{ range: "'_How to use'!A1", values: HOWTO }] });
  await writeTabs(id, Object.assign({}, tabs.ingredients, tabs.menu), [], ids);
  await applyDropdowns(id, Object.assign({}, dd.ingredients, dd.menu), ids);
  await saveCfg({ sheetId: id, base: model, at: Date.now(), by: window.miauUserEmail() });
}
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
  const c = ST.cfg, codes = E.assignCodes(S.items);
  for (const [id, code] of Object.entries(codes)) { S.items[id].code = code; save("items", id, true); }
  let ing, menu;
  if (single(c)) { const all = await readAll(c.sheetId), sp = E.splitTabs(all.tabs); ing = { tabs: sp.ingredients, ids: all.ids }; menu = { tabs: sp.menu, ids: all.ids }; }
  else [ing, menu] = await Promise.all([readAll(c.ingId), readAll(c.menuId)]);
  const A = E.appToModel(S.items, S.drinks), base = c.base || {};
  const read = E.tabsToModel(ing.tabs, menu.tabs, A, base);
  ST.preview = { ing, menu, A, read, base };
  ST.resolve = {}; recompute();
}
function recompute() {
  const p = ST.preview; if (!p) return;
  p.m = E.merge(p.base, p.A, p.read.model, p.read.bad, ST.resolve);
  p.problems = E.problems(p.m.result, p.A);
}
async function apply() {
  const p = ST.preview, w = E.modelToApp(p.m.result, p.A, S.items, S.drinks);
  for (const [id, d] of Object.entries(w.items)) if (d === null) remove("items", id); else { S.items[id] = d; save("items", id, true); }
  for (const [id, d] of Object.entries(w.drinks)) if (d === null) remove("drinks", id); else { S.drinks[id] = d; save("drinks", id, true); }
  const F = E.appToModel(S.items, S.drinks);
  const one = single(ST.cfg), opts = { single: one };
  const plan = E.planWrites(F, { ingredients: p.ing.tabs, menu: p.menu.tabs }, p.read.skipped, opts);
  const dd = E.dropdowns(E.modelToTabs(F, opts), opts), ddMenu = Object.fromEntries(Object.entries(dd.menu).filter(([t]) => !p.read.skipped.has(t)));
  if (one) {
    const write = Object.assign({}, plan.ingredients, plan.menuWrite);
    if (Object.keys(write).length || plan.menuDelete.length) await writeTabs(ST.cfg.sheetId, write, plan.menuDelete, p.ing.ids);
    await applyDropdowns(ST.cfg.sheetId, Object.assign({}, dd.ingredients, ddMenu), p.ing.ids);
  } else {
    if (Object.keys(plan.ingredients).length) await writeTabs(ST.cfg.ingId, plan.ingredients, [], p.ing.ids);
    if (Object.keys(plan.menuWrite).length || plan.menuDelete.length) await writeTabs(ST.cfg.menuId, plan.menuWrite, plan.menuDelete, p.menu.ids);
    await applyDropdowns(ST.cfg.ingId, dd.ingredients, p.ing.ids); await applyDropdowns(ST.cfg.menuId, ddMenu, p.menu.ids);
  }
  await saveCfg(Object.assign({}, ST.cfg, { base: E.nextBase(F, p.base, p.read.skipped), at: Date.now(), by: window.miauUserEmail() }));
  const toApp = p.m.changes.filter(c => c.from === "sheet").length, toSheet = Object.keys(plan.ingredients).length + Object.keys(plan.menuWrite).length + plan.menuDelete.length;
  ST.done = !toApp && !p.m.changes.length && !p.read.errors.length ? "Everything is in sync." : `Synced. ${toApp} change${toApp === 1 ? "" : "s"} brought into the app, ${toSheet} sheet tab${toSheet === 1 ? "" : "s"} updated.` + (p.read.errors.length ? " Some rows had errors and were skipped (see below)." : "");
  ST.lastErrors = p.read.errors; ST.preview = null;
  if (ST.combinePending && !p.read.errors.length) { ST.combinePending = false; await createSheet(); ST.done = "Synced, then moved everything into one file. Your old Ingredients and Menu files are no longer used; you can delete them in Google Drive."; }
}

// Move from the old two-file setup to one file: sync first, then build the single file from the app's data.
async function combine() {
  await check(); const p = ST.preview;
  if (p.m.conflicts.length || p.problems.length || p.m.changes.length || p.read.errors.length) {
    ST.combinePending = true; return;     // show the preview; after Apply, combine runs
  }
  ST.preview = null; await createSheet();
  ST.done = "Done. Everything is now in one file. Your old Ingredients and Menu files are no longer used; you can delete them in Google Drive.";
}

// ---------- UI ----------
const ago = t => { if (!t) return "never"; const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : new Date(t).toLocaleDateString(); };
async function run(label, fn) { ST.busy = label; ST.err = ""; ST.done = ""; draw(); try { await fn(); } catch (e) { ST.err = e && e.code === "auth/popup-closed-by-user" ? "Google permission window was closed." : (e && e.message) || "Something went wrong."; } ST.busy = ""; draw(); }

function groupChanges(changes, model) {
  const g = {};
  for (const c of changes) { if (c.key.endsWith(":_")) continue; const d = E.describe(c.key, model); const k = c.from + "|" + d.entity; (g[k] = g[k] || { from: c.from, entity: d.entity, kind: d.kind, items: [] }).items.push(c.key.endsWith(":lines") ? { field: d.field, diff: E.lineDiff(c.before, c.after, model) } : { field: d.field, before: E.show(c.before), after: E.show(c.after), added: c.before === undefined, removed: c.after === undefined }); }
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
      <p>Keep your ingredients, house-made recipes and every drink in one Google Sheet, and edit them there or here. <b>Sync</b> brings changes both ways and asks you when the same thing was changed in both places.</p>
      <div class="sx-row"><button class="btn primary" id="sx-create" ${busy ? "disabled" : ""}>Create the sheet from my data</button></div>
      <details class="sx-adv"><summary>Already have the sheet? Connect it</summary>
        <label class="fld"><span>Sheet link</span><input class="in" id="sx-one" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
        <button class="btn" id="sx-link" ${busy ? "disabled" : ""}>Connect</button></details>
      <p class="faint" style="font-size:13px">Google will ask once for permission to use Google Sheets with your account.</p></div></div>`;
    return;
  }
  const links = single(c) ? `<div class="sx-row"><a class="btn" href="${sheetUrl(c.sheetId)}" target="_blank" rel="noopener">Open the Google Sheet ↗</a></div>`
    : `<div class="sx-row"><a class="btn" href="${sheetUrl(c.ingId)}" target="_blank" rel="noopener">Open Ingredients sheet ↗</a><a class="btn" href="${sheetUrl(c.menuId)}" target="_blank" rel="noopener">Open Menu sheet ↗</a></div>
      <div class="sx-err" style="background:var(--accent-soft);color:var(--text)"><b>New: keep everything in one file.</b> This syncs first (so no edits in your sheets are lost), then makes one sheet with Ingredients, House-made recipes and a tab per drink.
      <div class="sx-row" style="margin-top:8px"><button class="btn primary sm" id="sx-combine" ${busy ? "disabled" : ""}>Combine into one file</button></div></div>`;
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
    ${ST.combinePending ? `<div class="card sx-msg">First, sync these changes. After you tap Apply, everything moves into one file.</div>` : ""}
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
  if (t.id === "sx-combine") return run("Syncing, then combining into one file", combine);
  if (t.id === "sx-link") { const a = idFrom($("#sx-one").value);
    if (!a) { ST.err = "Paste the sheet link."; return draw(); }
    return run("Connecting", async () => { await readAll(a); await saveCfg({ sheetId: a, base: {}, at: 0, by: "" }); await check(); }); }
  if (t.id === "sx-check") return run("Reading the sheet", check);
  if (t.id === "sx-cancel") { ST.preview = null; ST.combinePending = false; return draw(); }
  if (t.id === "sx-apply") return run("Applying changes", apply);
  if (t.id === "sx-unlink") { await saveCfg({ sheetId: null, ingId: null, menuId: null, base: {}, at: 0, by: "" }); ST.done = "Disconnected."; return draw(); }
  if (t.dataset.sxPick) { ST.resolve[t.dataset.k] = t.dataset.sxPick; recompute(); return draw(); }
  if (t.dataset.sxAll) { for (const k of ST.preview.m.conflicts) ST.resolve[k.key] = t.dataset.sxAll; recompute(); return draw(); }
});
