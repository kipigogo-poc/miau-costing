// MIAU two-way sync engine: app data ⇄ two Google Sheets. Pure functions, no network, no DOM.
//
// Both sides are turned into the same flat "model": { key: value-as-JSON-string }.
// A three-way merge against the model saved at the last sync ("base") decides, key by key:
//   changed only in Sheets → app takes it · changed only in app → sheet takes it · changed in both, differently → conflict.
//
// Sheet layout
//   Ingredients spreadsheet
//     tab "Ingredients": one row per item (ingredients, packaging, house-made), keyed by Code.
//     tab "House-made recipes": one row per recipe line, keyed by the recipe's Code.
//   Menu spreadsheet: one tab per drink (tab name = drink name); one column per size; one row per ingredient.
//     Tabs whose name starts with "_" are ignored.

export const ING_TAB = "Ingredients", PREP_TAB = "House-made recipes";
export const NUT = [["kcal", "kcal"], ["fat", "Fat (g)"], ["sat", "Sat. fat (g)"], ["carb", "Carbs (g)"], ["sugar", "Sugars (g)"], ["protein", "Protein (g)"], ["sodium", "Sodium (mg)"]];
export const ING_HEAD = ["Code", "Name", "Category", "Unit", "Pack size", "Pack price (₱)", "Usable %", "Density (g per ml)", ...NUT.map(n => n[1] + " per 100"), "Note"];
export const PREP_HEAD = ["Code", "Recipe", "Makes", "Batch ×", "Ingredient code", "Ingredient", "Amount", "Unit", "Note"];
const CATS = ["Ingredient", "Packaging", "House-made"], UNITS = ["g", "ml", "pc"];
const ROW = { size: "Size (ml)", price: "Price (₱)", target: "Target cost %", base: "Recipe written for (ml)", id: "App ID (don't edit)" };
const SAME = "Same in every size", NOTE = "Note";

// ---------- small helpers ----------
const J = v => JSON.stringify(v === undefined ? null : v);
const num = v => { if (v === null || v === undefined || v === "") return null; const n = typeof v === "number" ? v : +String(v).replace(/[₱,\s%]/g, ""); return isFinite(n) ? n : NaN; };
const r6 = v => v == null ? null : Math.round(v * 1e6) / 1e6;
const str = v => (v === null || v === undefined) ? "" : String(v).trim();
const isPrep = it => it && it.category === "House-made";
const truthy = v => v === true || /^(y|yes|true|1|✓|x)$/i.test(str(v));
export const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "item";
const sizeOf = d => +d.targetVol || +d.baseVol || 0;

// ---------- codes: every item needs a Code (the join key with the sheet) ----------
export function assignCodes(items) {
  const used = new Set(Object.values(items).map(i => str(i.code)).filter(Boolean)), out = {};
  const pre = it => it.category === "Packaging" ? "PKG" : isPrep(it) ? "HM" : "ING";
  for (const [id, it] of Object.entries(items)) {
    if (str(it.code)) continue;
    let n = 1, c; do { c = `${pre(it)}-${String(n++).padStart(3, "0")}`; } while (used.has(c));
    used.add(c); out[id] = c;
  }
  return out; // { itemId: newCode }
}

// ---------- drink tab: align each size's lines into shared rows ----------
function alignRows(cols) {   // cols: [{ lines: [{code, qty, unit, fixed, note}] }]
  const rows = [];
  cols.forEach((c, ci) => {
    const seen = {};
    let at = -1;
    for (const l of c.lines) {
      const k = `${l.code}|${l.unit}|${l.fixed ? 1 : 0}`; seen[k] = (seen[k] || 0) + 1;
      let ri = rows.findIndex(r => r.k === k && r.n === seen[k]);
      if (ri < 0) { rows.splice(at + 1, 0, { k, n: seen[k], code: l.code, unit: l.unit, fixed: !!l.fixed, notes: [], q: {} }); ri = at + 1; }
      const r = rows[ri]; r.q[ci] = l.qty; if (l.note && !r.notes.includes(l.note)) r.notes.push(l.note); at = ri;
    }
  });
  return rows.map(r => ({ code: r.code, unit: r.unit, fixed: r.fixed, note: r.notes.join(" / "), q: r.q }));
}
// canonical per-size lines after a round trip through rows (so app and sheet compare equal)
function canonLines(cols) {
  const rows = alignRows(cols);
  return cols.map((c, ci) => rows.filter(r => ci in r.q).map(r => [r.code, r.q[ci] == null ? null : r6(r.q[ci]), r.unit, r.fixed, r.note]));
}

// ---------- APP → model ----------
export function appToModel(items, drinks) {
  const m = {}, codeOf = id => (items[id] && str(items[id].code)) || ("?" + id);
  for (const it of Object.values(items)) {
    const c = str(it.code); if (!c) continue;
    const p = `i:${c}:`; m[p + "_"] = "1";
    m[p + "name"] = J(str(it.name)); m[p + "category"] = J(CATS.includes(it.category) ? it.category : "Ingredient"); m[p + "unit"] = J(it.unit || "g");
    m[p + "yield"] = J(it.yield == null || it.yield === "" ? null : r6(+it.yield * 100));
    m[p + "density"] = J(it.density == null || it.density === "" ? null : r6(+it.density));
    m[p + "note"] = J(str(it.note));
    const manual = !isPrep(it) || it.nutrManual;
    for (const [k] of NUT) m[p + "n_" + k] = J(manual && it.nutr && it.nutr[k] != null && it.nutr[k] !== "" ? r6(+it.nutr[k]) : null);
    if (isPrep(it)) {
      m[p + "makes"] = J(it.yieldQty == null || it.yieldQty === "" ? null : r6(+it.yieldQty));
      m[p + "batch"] = J(+it.batchMult > 0 ? r6(+it.batchMult) : 1);
      m[p + "lines"] = J((it.lines || []).filter(l => l.itemId).map(l => [codeOf(l.itemId), l.qty == null || l.qty === "" ? null : r6(+l.qty), l.unit || (items[l.itemId] || {}).unit || "g", str(l.note)]));
    } else {
      m[p + "packSize"] = J(it.packSize == null || it.packSize === "" ? null : r6(+it.packSize));
      m[p + "packPrice"] = J(it.packPrice == null || it.packPrice === "" ? null : r6(+it.packPrice));
    }
  }
  // drinks grouped by name → one tab
  const groups = {};
  for (const [id, d] of Object.entries(drinks)) { const n = str(d.name) || "Untitled"; (groups[n] = groups[n] || []).push([id, d]); }
  for (const [name, arr] of Object.entries(groups)) {
    arr.sort((a, b) => sizeOf(a[1]) - sizeOf(b[1]));
    const cols = arr.map(([, d]) => ({ lines: (d.lines || []).filter(l => l.itemId).map(l => ({ code: codeOf(l.itemId), qty: l.qty == null || l.qty === "" ? null : +l.qty, unit: l.unit || (items[l.itemId] || {}).unit || "g", fixed: !!l.fixed, note: str(l.note) })) }));
    const lines = canonLines(cols);
    arr.forEach(([id, d], ci) => {
      const p = `d:${id}:`; m[p + "_"] = "1";
      m[p + "name"] = J(name); m[p + "size"] = J(sizeOf(d) || null);
      m[p + "price"] = J(+d.price > 0 ? r6(+d.price) : null);
      m[p + "target"] = J(+d.target > 0 ? r6(+d.target * 100) : null);
      m[p + "base"] = J(+d.baseVol > 0 && +d.baseVol !== sizeOf(d) ? r6(+d.baseVol) : null);
      m[p + "lines"] = J(lines[ci]);
    });
  }
  return m;
}

// ---------- model → SHEET values ----------
export function modelToTabs(m) {
  const items = {}, drinks = {};
  for (const [k, v] of Object.entries(m)) {
    const [t, id, f] = splitKey(k); const val = JSON.parse(v);
    if (t === "i") (items[id] = items[id] || {})[f] = val; else if (t === "d") (drinks[id] = drinks[id] || {})[f] = val;
  }
  const order = { Ingredient: 0, "House-made": 1, Packaging: 2 };
  const codes = Object.keys(items).sort((a, b) => (order[items[a].category] ?? 3) - (order[items[b].category] ?? 3) || String(items[a].name).localeCompare(String(items[b].name)));
  const nameOf = c => (items[c] && items[c].name) || "";
  const ing = [ING_HEAD, ...codes.map(c => { const it = items[c];
    return [c, it.name, it.category, it.unit, it.packSize ?? "", it.packPrice ?? "", it.yield ?? "", it.density ?? "", ...NUT.map(([k]) => it["n_" + k] ?? ""), it.note || ""]; })];
  const prep = [PREP_HEAD];
  for (const c of codes) { const it = items[c]; if (it.category !== "House-made") continue;
    const ls = it.lines || []; if (!ls.length) prep.push([c, it.name, it.makes ?? "", it.batch ?? 1, "", "", "", "", ""]);
    ls.forEach((l, i) => prep.push([c, i ? "" : it.name, i ? "" : (it.makes ?? ""), i ? "" : (it.batch ?? 1), l[0], nameOf(l[0]), l[1] ?? "?", l[2], l[3] || ""])); }
  const tabs = { [ING_TAB]: ing, [PREP_TAB]: prep }, menu = {};
  const byName = {};
  for (const [id, d] of Object.entries(drinks)) (byName[d.name] = byName[d.name] || []).push([id, d]);
  for (const [name, arr] of Object.entries(byName)) {
    arr.sort((a, b) => (a[1].size || 0) - (b[1].size || 0));
    const cols = arr.map(([, d]) => ({ lines: (d.lines || []).map(l => ({ code: l[0], qty: l[1], unit: l[2], fixed: l[3], note: l[4] })) }));
    const rows = alignRows(cols), n = arr.length, pad = a => a.concat(Array(Math.max(0, n - a.length)).fill(""));
    const out = [
      [ROW.size, "", "", ...pad(arr.map(([, d]) => d.size ?? ""))],
      [ROW.price, "", "", ...pad(arr.map(([, d]) => d.price ?? ""))],
      [ROW.target, "", "", ...pad(arr.map(([, d]) => d.target ?? ""))],
      [ROW.base, "", "", ...pad(arr.map(([, d]) => d.base ?? ""))],
      [ROW.id, "", "", ...pad(arr.map(([id]) => id.startsWith("new:") ? "" : id))],
      [],
      ["Code", "Ingredient", "Unit", ...arr.map(([, d]) => (d.size ? d.size + " ml" : "No size")), SAME, NOTE],
      ...rows.map(r => [r.code, nameOf(r.code), r.unit, ...arr.map((_, ci) => ci in r.q ? (r.q[ci] ?? "?") : ""), r.fixed ? "Yes" : "", r.note])
    ];
    menu[name] = out;
  }
  return { ingredients: tabs, menu };
}
function splitKey(k) { const a = k.indexOf(":"), b = k.lastIndexOf(":"); return [k.slice(0, a), k.slice(a + 1, b), k.slice(b + 1)]; }

// ---------- SHEET values → model (+ errors) ----------
// ingTabs: { tabTitle: rows[][] } of the Ingredients spreadsheet; menuTabs: same for Menu. Returns { model, errors, bad }.
// bad: set of model key prefixes whose sheet values couldn't be read; the merge treats them as unchanged.
export function tabsToModel(ingTabs, menuTabs, appModel = {}, baseModel = {}) {
  const m = {}, errors = [], bad = new Set(), codes = new Set();
  const err = (where, msg, prefix) => { errors.push({ where, msg }); if (prefix) bad.add(prefix); };
  const ing = ingTabs[ING_TAB];
  if (!ing) err(ING_TAB, `Tab "${ING_TAB}" is missing.`, "i:");
  else {
    const h = (ing[0] || []).map(str), col = name => h.indexOf(name);
    const C = Object.fromEntries(ING_HEAD.map(n => [n, col(n)]));
    if (C.Code < 0 || C.Name < 0) err(ING_TAB, `Row 1 must have the headings ${ING_HEAD.slice(0, 2).join(", ")}….`, "i:");
    else ing.slice(1).forEach((row, i) => {
      const g = n => C[n] >= 0 ? row[C[n]] : "", code = str(g("Code")), name = str(g("Name")), at = `${ING_TAB} row ${i + 2}`;
      if (!code && !name) return;
      if (!code) return err(at, `"${name}" has no Code. Add one (e.g. ING-030).`);
      if (codes.has(code)) return err(at, `Code ${code} is used twice.`, `i:${code}:`);
      codes.add(code);
      const p = `i:${code}:`, cat = CATS.find(c => c.toLowerCase() === str(g("Category")).toLowerCase()) || (str(g("Category")) ? null : "Ingredient");
      const unit = str(g("Unit")).toLowerCase() || "g";
      if (!cat) return err(at, `Category must be Ingredient, Packaging or House-made.`, p);
      if (!UNITS.includes(unit)) return err(at, `Unit must be g, ml or pc.`, p);
      const nums = {}; let ok = true;
      for (const [f, n] of [["packSize", "Pack size"], ["packPrice", "Pack price (₱)"], ["yield", "Usable %"], ["density", "Density (g per ml)"], ...NUT.map(([k, l]) => ["n_" + k, l + " per 100"])]) {
        const v = num(g(n)); if (Number.isNaN(v)) { err(at, `${n} "${str(g(n))}" isn't a number.`, p); ok = false; } nums[f] = v == null ? null : r6(v); }
      if (!ok) return;
      if (nums.yield != null && (nums.yield <= 0 || nums.yield > 100)) return err(at, `Usable % must be between 1 and 100.`, p);
      m[p + "_"] = "1"; m[p + "name"] = J(name); m[p + "category"] = J(cat); m[p + "unit"] = J(unit);
      m[p + "yield"] = J(nums.yield); m[p + "density"] = J(nums.density); m[p + "note"] = J(str(g("Note")));
      for (const [k] of NUT) m[p + "n_" + k] = J(nums["n_" + k]);
      if (cat !== "House-made") { m[p + "packSize"] = J(nums.packSize); m[p + "packPrice"] = J(nums.packPrice); }
    });
  }
  // house-made recipes
  const prep = ingTabs[PREP_TAB], recipes = {};
  if (prep) {
    const h = (prep[0] || []).map(str), C = Object.fromEntries(PREP_HEAD.map(n => [n, h.indexOf(n)]));
    prep.slice(1).forEach((row, i) => {
      const g = n => C[n] >= 0 ? row[C[n]] : "", code = str(g("Code")); if (!code) return;
      const r = recipes[code] = recipes[code] || { makes: null, batch: null, lines: [], errs: [] }, at = `${PREP_TAB} row ${i + 2}`;
      const mk = num(g("Makes")), bt = num(g("Batch ×"));
      if (Number.isNaN(mk) || Number.isNaN(bt)) r.errs.push([at, "Makes and Batch × must be numbers."]);
      if (mk != null && !Number.isNaN(mk) && r.makes == null) r.makes = mk;
      if (bt != null && !Number.isNaN(bt) && r.batch == null) r.batch = bt;
      const ic = str(g("Ingredient code")); if (!ic) return;
      const raw = str(g("Amount")), q = raw === "?" || raw === "" ? null : num(raw);
      if (Number.isNaN(q)) return r.errs.push([at, `Amount "${raw}" isn't a number.`]);
      const u = str(g("Unit")).toLowerCase() || "g"; if (!UNITS.includes(u)) return r.errs.push([at, "Unit must be g, ml or pc."]);
      r.lines.push([ic, q == null ? null : r6(q), u, str(g("Note"))]);
    });
  }
  for (const code of codes) {
    const p = `i:${code}:`; if (bad.has(p) || JSON.parse(m[p + "category"] || "null") !== "House-made") continue;
    const r = recipes[code] || { makes: null, batch: null, lines: [], errs: [] };
    for (const l of r.lines) if (!codes.has(l[0])) r.errs.push([`${PREP_TAB} (${code})`, `Ingredient code ${l[0]} isn't on the Ingredients tab.`]);
    if (r.errs.length) { r.errs.forEach(([w, msg]) => err(w, msg)); bad.add(p + "lines"); bad.add(p + "makes"); bad.add(p + "batch"); continue; }
    m[p + "makes"] = J(r.makes == null ? null : r6(r.makes)); m[p + "batch"] = J(r.batch > 0 ? r6(r.batch) : 1); m[p + "lines"] = J(r.lines);
  }
  for (const code of Object.keys(recipes)) if (!codes.has(code)) err(PREP_TAB, `Recipe code ${code} isn't on the Ingredients tab.`);
  // menu: one tab per drink
  const seenIds = new Set(), skipped = new Set(), byName = {};
  for (const mm of [appModel, baseModel]) for (const [k, v] of Object.entries(mm)) if (k.startsWith("d:") && k.endsWith(":name")) { const n = JSON.parse(v); (byName[n] = byName[n] || new Set()).add(k.slice(2, -5)); }
  const badTab = title => { skipped.add(title); for (const id of byName[str(title)] || []) bad.add(`d:${id}:`); };
  if (errors.some(e => e.where.startsWith(ING_TAB))) skipped.add("ing:" + ING_TAB);
  if (errors.some(e => e.where.startsWith(PREP_TAB))) skipped.add("ing:" + PREP_TAB);
  for (const [title, rows] of Object.entries(menuTabs)) {
    if (title.startsWith("_")) continue;
    const name = str(title), lab = r => str((r || [])[0]);
    const find = l => rows.findIndex(r => lab(r) === l), hr = rows.findIndex(r => lab(r) === "Code");
    if (hr < 0) { err(`Menu tab "${title}"`, `Can't find the "Code" heading row.`); badTab(title); continue; }
    const H = rows[hr].map(str), sameC = H.indexOf(SAME), noteC = H.indexOf(NOTE), end = sameC > 0 ? sameC : H.length;
    const sizeCols = []; for (let c = 3; c < end; c++) if (H[c]) sizeCols.push(c);
    const rowOf = l => { const i = find(l); return i >= 0 ? rows[i] : []; };
    const R = { size: rowOf(ROW.size), price: rowOf(ROW.price), target: rowOf(ROW.target), base: rowOf(ROW.base), id: rowOf(ROW.id) };
    const cols = [], tabErr = [];
    for (const c of sizeCols) {
      const hs = H[c].match(/^(\d+(?:\.\d+)?)\s*ml$/i), size = num(R.size[c] ?? "") ?? (hs ? +hs[1] : null), price = num(R.price[c] ?? ""), target = num(R.target[c] ?? ""), base = num(R.base[c] ?? "");
      if ([size, price, target, base].some(Number.isNaN)) { tabErr.push(`Size, price, target and recipe size in column ${colName(c)} must be numbers.`); continue; }
      let id = str(R.id[c]); if (id && seenIds.has(id)) id = ""; // duplicated tab → treat as a new drink
      if (id) seenIds.add(id);
      cols.push({ c, id: id || `new:${name}:${colName(c)}`, size, price, target, base, lines: [] });
    }
    rows.slice(hr + 1).forEach((r, i) => {
      const code = str(r[0]); if (!code) return;
      if (!codes.has(code)) return tabErr.push(`Row ${hr + i + 2}: ingredient code ${code} isn't on the Ingredients tab.`);
      const unit = str(r[2]).toLowerCase() || "g"; if (!UNITS.includes(unit)) return tabErr.push(`Row ${hr + i + 2}: unit must be g, ml or pc.`);
      const fixed = sameC > 0 && truthy(r[sameC]), note = noteC > 0 ? str(r[noteC]) : "";
      for (const col of cols) { const raw = str(r[col.c]); if (raw === "") continue;
        const q = raw === "?" ? null : num(raw);
        if (Number.isNaN(q)) { tabErr.push(`Row ${hr + i + 2}, column ${colName(col.c)}: "${raw}" isn't a number.`); continue; }
        col.lines.push({ code, qty: q, unit, fixed, note }); }
    });
    if (tabErr.length) { tabErr.forEach(e => err(`Menu tab "${title}"`, e)); cols.forEach(c => bad.add(`d:${c.id}:`)); badTab(title); continue; }
    const lines = canonLines(cols);
    cols.forEach((col, ci) => {
      const p = `d:${col.id}:`; m[p + "_"] = "1"; m[p + "name"] = J(name); m[p + "size"] = J(col.size == null ? null : r6(col.size));
      m[p + "price"] = J(col.price > 0 ? r6(col.price) : null); m[p + "target"] = J(col.target > 0 ? r6(col.target) : null);
      m[p + "base"] = J(col.base > 0 && col.base !== col.size ? r6(col.base) : null); m[p + "lines"] = J(lines[ci]);
    });
  }
  return { model: m, errors, bad, skipped };
}
const colName = c => String.fromCharCode(65 + c);

// ---------- three-way merge ----------
// Returns { result, changes: [{key, from: "sheet"|"app", before, after}], conflicts: [{key, base, app, sheet}] }.
// resolve: { key: "app" | "sheet" } picks a side for conflicts.
export function merge(base, app, sheet, bad = new Set(), resolve = {}) {
  const keys = new Set([...Object.keys(base), ...Object.keys(app), ...Object.keys(sheet)]);
  const isBad = k => [...bad].some(p => k.startsWith(p));
  const result = {}, changes = [], conflicts = [];
  // whole-entity existence first, so a deleted item/drink isn't half-merged
  const ent = k => k.slice(0, k.lastIndexOf(":") + 1);
  for (const k of keys) {
    const b = base[k], a = app[k], s0 = sheet[k], s = isBad(k) ? b : s0;
    let v;
    if (a === s) v = a;
    else if (a === b) { v = s; changes.push({ key: k, from: "sheet", before: a, after: s }); }
    else if (s === b) { v = a; changes.push({ key: k, from: "app", before: s, after: a }); }
    else {
      const pick = resolve[k] || resolve[ent(k)];
      if (pick === "app") { v = a; changes.push({ key: k, from: "app", before: s, after: a }); }
      else if (pick === "sheet") { v = s; changes.push({ key: k, from: "sheet", before: a, after: s }); }
      else { conflicts.push({ key: k, base: b, app: a, sheet: s }); v = a; }
    }
    if (v !== undefined) result[k] = v;
  }
  // an entity whose existence marker is gone is gone entirely
  for (const k of Object.keys(result)) { const e = ent(k); if (!(e + "_" in result)) delete result[k]; }
  return { result, changes, conflicts };
}

// ---------- model → APP documents ----------
// Returns { items: {id: doc|null}, drinks: {id: doc|null} } — only entities that differ from the current app model; null = delete.
export function modelToApp(result, appModel, items, drinks) {
  const ent = {}; for (const [k, v] of Object.entries(result)) { const [t, id, f] = splitKey(k); ((ent[t + ":" + id] = ent[t + ":" + id] || {})[f] = JSON.parse(v)); }
  const old = {}; for (const k of Object.keys(appModel)) { const [t, id] = splitKey(k); old[t + ":" + id] = true; }
  const changed = e => { const p = e + ":"; const ks = new Set([...Object.keys(result), ...Object.keys(appModel)].filter(k => k.startsWith(p))); for (const k of ks) if (result[k] !== appModel[k]) return true; return false; };
  const idByCode = {}; for (const [id, it] of Object.entries(items)) if (str(it.code)) idByCode[str(it.code)] = id;
  const outI = {}, outD = {}, taken = new Set(Object.keys(items));
  // items (create ids for new codes first so lines can point at them)
  for (const e of Object.keys(ent)) if (e.startsWith("i:")) { const code = e.slice(2); if (!idByCode[code]) { let id = slug(ent[e].name || code), n = 2; while (taken.has(id)) id = slug(ent[e].name || code) + "-" + n++; taken.add(id); idByCode[code] = id; } }
  const lineOut = (ls, withFixed) => (ls || []).map(l => { const o = { itemId: idByCode[l[0]] || "", qty: l[1], unit: l[2] }; if (withFixed) { if (l[3]) o.fixed = true; if (l[4]) o.note = l[4]; } else if (l[3]) o.note = l[3]; return o; });
  for (const e of new Set([...Object.keys(ent), ...Object.keys(old)])) {
    if (!changed(e)) continue;
    const [t, id] = [e.slice(0, 1), e.slice(2)], v = ent[e];
    if (t === "i") {
      const iid = idByCode[id] || id;
      if (!v) { outI[iid] = null; continue; }
      const it = Object.assign({}, items[iid] || {});
      Object.assign(it, { code: id, name: v.name, category: v.category, unit: v.unit, density: v.density, note: v.note || undefined });
      it.yield = v.yield == null ? undefined : r6(v.yield / 100);
      const nutr = {}; let any = false; for (const [k] of NUT) { nutr[k] = v["n_" + k]; if (nutr[k] != null) any = true; }
      if (v.category === "House-made") {
        it.yieldQty = v.makes; it.batchMult = v.batch || 1; it.lines = lineOut(v.lines, false); delete it.packSize; delete it.packPrice;
        if (any) { it.nutrManual = true; it.nutr = nutr; } else { delete it.nutrManual; if (it.nutr) delete it.nutr; }
      } else { it.packSize = v.packSize; it.packPrice = v.packPrice; if (any) it.nutr = nutr; else delete it.nutr; delete it.lines; delete it.yieldQty; delete it.batchMult; delete it.nutrManual; }
      for (const k of Object.keys(it)) if (it[k] === undefined) delete it[k];
      outI[iid] = it;
    } else if (t === "d") {
      if (!v) { outD[id] = null; continue; }
      let did = id; if (id.startsWith("new:")) { did = slug(v.name) + "-" + (v.size || "x"); let n = 2; while (drinks[did] || outD[did]) did = slug(v.name) + "-" + (v.size || "x") + "-" + n++; }
      const d = Object.assign({ vat: 0.12 }, drinks[did] || {});
      d.name = v.name; d.targetVol = v.size; d.baseVol = v.base || v.size; d.price = v.price; d.target = v.target == null ? null : r6(v.target / 100);
      d.lines = lineOut(v.lines, true); if (!d.lines.length) d.lines = [{ itemId: "", qty: null }];
      outD[did] = d;
    }
  }
  return { items: outI, drinks: outD };
}

// ---------- human-readable summary of a merge, per entity ----------
const FIELD = { name: "name", category: "category", unit: "unit", packSize: "pack size", packPrice: "pack price", yield: "usable %", density: "density", note: "note",
  makes: "makes", batch: "batch ×", lines: "recipe", size: "size", price: "price", target: "target cost %", base: "recipe size", _: "" };
export function describe(key, model) {
  const [t, id, f] = splitKey(key), nm = model[`${t}:${id}:name`] ? JSON.parse(model[`${t}:${id}:name`]) : id;
  const size = t === "d" && model[`d:${id}:size`] ? " " + JSON.parse(model[`d:${id}:size`]) + " ml" : "";
  const field = f.startsWith("n_") ? f.slice(2) + " per 100" : FIELD[f] ?? f;
  return { entity: (t === "i" ? `${nm}${id && !id.startsWith("?") ? " (" + id + ")" : ""}` : `${nm}${size}`), field, kind: t === "i" ? "Ingredient" : "Drink" };
}
export const show = v => { if (v === undefined) return "—"; const x = JSON.parse(v); if (x === null || x === "") return "blank"; if (Array.isArray(x)) return x.length + " ingredient line" + (x.length === 1 ? "" : "s"); return String(x); };

// ---------- after merge: things that would break costing ----------
export function problems(result, appModel = {}) {
  const out = [], has = c => (`i:${c}:_`) in result, nm = (t, id) => { const v = result[`${t}:${id}:name`] || appModel[`${t}:${id}:name`]; return v ? JSON.parse(v) : id; };
  for (const [k, v] of Object.entries(result)) {
    if (!k.endsWith(":lines")) continue; const [t, id] = splitKey(k);
    for (const l of JSON.parse(v) || []) if (!has(l[0]) && !String(l[0]).startsWith("?"))
      out.push(`${t === "d" ? "Drink" : "Recipe"} "${nm(t, id)}${t === "d" && result[`d:${id}:size`] ? " " + JSON.parse(result[`d:${id}:size`]) + " ml" : ""}" uses ${l[0]} (${nm("i", l[0])}), which would be deleted.`);
  }
  return [...new Set(out)];
}

// which tab a model key lives on, for a given model (drinks by name)
export function tabOf(key, model) {
  const [t, id, f] = splitKey(key);
  if (t === "i") return "ing:" + (["lines", "makes", "batch"].includes(f) ? PREP_TAB : ING_TAB);
  const n = model[`d:${id}:name`]; return n ? JSON.parse(n) : null;
}

// What to write to each spreadsheet so it matches the final model. Tabs with errors (skipped) are left alone.
// current: { ingredients: {title: rows}, menu: {title: rows} } as read at the start of the sync.
export function planWrites(finalModel, current, skipped) {
  const want = modelToTabs(finalModel), norm = rows => JSON.stringify((rows || []).map(r => { const a = (r || []).map(x => x === null || x === undefined ? "" : x); while (a.length && a[a.length - 1] === "") a.pop(); return a; }).filter((r, i, arr) => r.length || arr.slice(i).some(x => x.length)));
  const ing = {}, menuWrite = {}, menuDelete = [];
  for (const [t, rows] of Object.entries(want.ingredients)) if (!skipped.has("ing:" + t) && norm(rows) !== norm(current.ingredients[t])) ing[t] = rows;
  for (const [t, rows] of Object.entries(want.menu)) if (!skipped.has(t) && norm(rows) !== norm(current.menu[t])) menuWrite[t] = rows;
  for (const t of Object.keys(current.menu)) if (!t.startsWith("_") && !(t in want.menu) && !skipped.has(t)) menuDelete.push(t);
  return { ingredients: ing, menuWrite, menuDelete };
}

// The base saved for next time: the final model, except keys on tabs that weren't written keep their old base
// (so a change still waiting to reach that tab is still seen as a change next sync).
export function nextBase(finalModel, oldBase, skipped) {
  const out = {};
  const keep = (k, m) => { const t = tabOf(k, m); return t != null && skipped.has(t); };
  for (const [k, v] of Object.entries(finalModel)) if (!keep(k, finalModel)) out[k] = v;
  for (const [k, v] of Object.entries(oldBase)) if (keep(k, oldBase) || keep(k, finalModel)) out[k] = v;
  return out;
}
