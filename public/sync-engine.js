// MIAU two-way sync with ONE Google Sheet (layout 2). Pure functions: no network, no DOM.
//
// Tabs
//   Masterlist   one row per thing you buy: ingredients, packaging, supplies.
//   House-made   one block per recipe (Espresso, Cold foam…): recipe row, then its ingredients below.
//   <drink>      one tab per drink, sizes side by side in ml. "Same strength": you fill the first size,
//                the other sizes are calculated (ice-aware). "Each size separate": you fill every size.
//   _Template · Latte   example to duplicate (ignored).   _Lists / _Links   hidden helpers (written by the app).
//   Any tab whose name starts with "_" is ignored when reading.
//
// Both sides become the same flat model { key: JSON }, then a three-way merge with the last-synced model decides
// key by key: changed only in Sheets → app; only in app → sheet; both, differently → you choose.

export const MASTER = "Masterlist", HOUSE = "House-made", LISTS = "_Lists", LINKS = "_Links", TEMPLATE = "_Template · Latte", HOWTO_TAB = "_How to use";
export const NUT = [["kcal", "kcal"], ["fat", "Fat (g)"], ["sat", "Sat. fat (g)"], ["carb", "Carbs (g)"], ["sugar", "Sugars (g)"], ["protein", "Protein (g)"], ["sodium", "Sodium (mg)"]];
export const MASTER_HEAD = ["Item", "Category", "Unit", "Pack size", "Pack price (₱)", "Usable %", "Supplier / note", "", ...NUT.map(n => n[1] + " per 100"), "Weight of 1 ml (g)", "Code"];
export const HOUSE_HEAD = ["Recipe", "Makes", "Unit", "Usable %", "Ingredient", "Amount", "Unit", "Note", "Code"];
export const CATS_BUY = ["Ingredient", "Packaging", "Supplies"], UNITS = ["g", "ml", "pc"];
export const TYPES = [["scale", "Scales"], ["same", "Same all sizes"], ["size", "This size only"], ["ice", "Ice"]];
export const MODES = ["Same strength", "Each size separate"];
const R = { size: "Size (ml)", price: "Price (₱)", target: "Max cost %", mode: "Sizes" }, HOW = "How it changes", NOTE = "Note";
export const ICE_ML_PER_G = 1.09;

// ---------- helpers ----------
const J = v => JSON.stringify(v === undefined ? null : v);
const P = v => (v === undefined ? undefined : JSON.parse(v));
const num = v => { if (v === null || v === undefined || v === "") return null; const n = typeof v === "number" ? v : +String(v).replace(/[₱,\s%]/g, ""); return isFinite(n) ? n : NaN; };
const r6 = v => v == null ? null : Math.round(v * 1e6) / 1e6;
const str = v => (v === null || v === undefined) ? "" : String(v).trim();
const lc = v => str(v).toLowerCase();
const isPrep = it => it && it.category === "House-made";
const sizeOf = d => +d.targetVol || +d.baseVol || 0;
export const roundQty = q => Math.abs(q) < 10 ? Math.round(q * 10) / 10 : Math.round(q);
export const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "item";
const typeLabel = t => (TYPES.find(x => x[0] === t) || TYPES[0])[1];
const typeFromLabel = s => { const x = TYPES.find(([k, l]) => lc(l) === lc(s) || k === lc(s)); return x ? x[0] : null; };
export function splitKey(k) { const a = k.indexOf(":"), b = k.lastIndexOf(":"); return [k.slice(0, a), k.slice(a + 1, b), k.slice(b + 1)]; }
// default "how it changes" for a line, same rules as the app
function defaultType(it) { if (it && it.category === "Packaging") return "size"; if (it && /\bice\b/i.test(it.name || "")) return "ice"; return "scale"; }
function lineTypeApp(l, items) { if (l.t) return l.t; if (l.fixed) return "same"; return defaultType(items[l.itemId]); }

// ---------- codes ----------
export function assignCodes(items) {
  const used = new Set(Object.values(items).map(i => str(i.code)).filter(Boolean)), out = {};
  const pre = it => it.category === "Packaging" ? "PKG" : it.category === "Supplies" ? "SUP" : isPrep(it) ? "HM" : "ING";
  for (const [id, it] of Object.entries(items)) {
    if (str(it.code)) continue;
    let n = 1, c; do { c = `${pre(it)}-${String(n++).padStart(3, "0")}`; } while (used.has(c));
    used.add(c); out[id] = c;
  }
  return out;
}

// ---------- same-strength math (identical to the app's) ----------
// lines: [code, qty, unit, type, note]
const iceMl = lines => lines.reduce((s, l) => s + (l[3] === "ice" && +l[1] > 0 ? (l[2] === "ml" ? 1 : ICE_ML_PER_G) * (+l[1]) : 0), 0);
export function standardQty(baseLines, baseSize, sibLines, sibSize) {
  const Lb = baseSize - iceMl(baseLines), Ls = sibSize - iceMl(sibLines);
  const r = (Lb > 0 && Ls > 0) ? Ls / Lb : (baseSize > 0 && sibSize > 0 ? sibSize / baseSize : 1);
  return baseLines.filter(l => l[3] === "scale" || l[3] === "same").map(l => [l[0], l[1] == null ? null : (l[3] === "same" ? l[1] : roundQty(l[1] * r)), l[2], l[3], l[4]]);
}

// ---------- align several sizes' lines into shared rows ----------
function alignRows(cols) {   // cols: [lines[]] → rows [{code,unit,type,note,q:{ci:qty}}]
  const rows = [];
  cols.forEach((lines, ci) => {
    const seen = {}; let at = -1;
    for (const l of lines) {
      const k = `${l[0]}|${l[2]}|${l[3]}`; seen[k] = (seen[k] || 0) + 1;
      let ri = rows.findIndex(r => r.k === k && r.n === seen[k]);
      if (ri < 0) { rows.splice(at + 1, 0, { k, n: seen[k], code: l[0], unit: l[2], type: l[3], notes: [], q: {} }); ri = at + 1; }
      const r = rows[ri]; r.q[ci] = l[1]; if (l[4] && !r.notes.includes(l[4])) r.notes.push(l[4]); at = ri;
    }
  });
  return rows.map(r => ({ code: r.code, unit: r.unit, type: r.type, note: r.notes.join(" / "), q: r.q }));
}
const canon = cols => { const rows = alignRows(cols); return cols.map((_, ci) => rows.filter(r => ci in r.q).map(r => [r.code, r.q[ci] == null ? null : r6(r.q[ci]), r.unit, r.type, r.note])); };

// ---------- APP → model ----------
export function appToModel(items, drinks) {
  const m = {}, codeOf = id => (items[id] && str(items[id].code)) || ("?" + id);
  for (const it of Object.values(items)) {
    const c = str(it.code); if (!c) continue;
    const p = `i:${c}:`; m[p + "_"] = "1";
    m[p + "name"] = J(str(it.name)); m[p + "unit"] = J(it.unit || "g");
    m[p + "yield"] = J(it.yield == null || it.yield === "" ? null : r6(+it.yield * 100));
    if (isPrep(it)) {
      m[p + "category"] = J("House-made");
      m[p + "makes"] = J(it.yieldQty == null || it.yieldQty === "" ? null : r6(+it.yieldQty));
      m[p + "lines"] = J((it.lines || []).filter(l => l.itemId).map(l => [codeOf(l.itemId), l.qty == null || l.qty === "" ? null : r6(+l.qty), l.unit || (items[l.itemId] || {}).unit || "g", str(l.note)]));
    } else {
      m[p + "category"] = J(CATS_BUY.includes(it.category) ? it.category : "Ingredient");
      m[p + "packSize"] = J(it.packSize == null || it.packSize === "" ? null : r6(+it.packSize));
      m[p + "packPrice"] = J(it.packPrice == null || it.packPrice === "" ? null : r6(+it.packPrice));
      m[p + "density"] = J(it.density == null || it.density === "" ? null : r6(+it.density));
      m[p + "note"] = J(str(it.note));
      for (const [k] of NUT) m[p + "n_" + k] = J(it.nutr && it.nutr[k] != null && it.nutr[k] !== "" ? r6(+it.nutr[k]) : null);
    }
  }
  const groups = {};
  for (const [id, d] of Object.entries(drinks)) { const n = str(d.name) || "Untitled"; (groups[n] = groups[n] || []).push([id, d]); }
  for (const [name, arr] of Object.entries(groups)) {
    arr.sort((a, b) => sizeOf(a[1]) - sizeOf(b[1]));
    const std = arr.some(([, d]) => d.std), baseId = std ? (arr.find(([, d]) => d.std) || arr[0])[0] : null;
    const toL = d => (d.lines || []).filter(l => l.itemId && !l.auto).map(l => ({ code: codeOf(l.itemId), qty: l.qty == null || l.qty === "" ? null : +l.qty, unit: l.unit || (items[l.itemId] || {}).unit || "g", type: lineTypeApp(l, items), note: str(l.note) }));
    let cols;
    if (std) cols = arr.map(([id, d]) => toL(d).filter(l => id === baseId || l.type === "size" || l.type === "ice").map(l => [l.code, l.qty, l.unit, l.type, l.note]));
    else cols = arr.map(([, d]) => toL(d).map(l => [l.code, l.qty, l.unit, l.type, l.note]));
    const lines = std ? stdCanon(cols, arr.findIndex(([id]) => id === baseId)) : canon(cols);
    arr.forEach(([id, d], ci) => {
      const p = `d:${id}:`; m[p + "_"] = "1";
      m[p + "name"] = J(name); m[p + "size"] = J(sizeOf(d) || null);
      m[p + "price"] = J(+d.price > 0 ? r6(+d.price) : null);
      m[p + "target"] = J(+d.target > 0 ? r6(+d.target * 100) : null);
      m[p + "std"] = J(!!std);
      m[p + "lines"] = J(lines[ci]);
    });
  }
  return m;
}
// standard drinks: base keeps its scale/same lines in order; the per-size (ice/cup) lines of all sizes are aligned together
function stdCanon(cols, bi) {
  const baseMain = (cols[bi] || []).filter(l => l[3] === "scale" || l[3] === "same").map(l => [l[0], l[1] == null ? null : r6(l[1]), l[2], l[3], l[4]]);
  const own = canon(cols.map(ls => ls.filter(l => l[3] === "size" || l[3] === "ice")));
  return cols.map((_, ci) => (ci === bi ? baseMain : []).concat(own[ci]));
}

// ---------- model → SHEET ----------
function byEntity(m) {
  const items = {}, drinks = {};
  for (const [k, v] of Object.entries(m)) { const [t, id, f] = splitKey(k); if (t === "i") (items[id] = items[id] || {})[f] = P(v); else if (t === "d") (drinks[id] = drinks[id] || {})[f] = P(v); }
  return { items, drinks };
}
export function modelToTabs(m) {
  const { items, drinks } = byEntity(m), nameOf = c => (items[c] && items[c].name) || "";
  const buy = Object.keys(items).filter(c => items[c].category !== "House-made"), house = Object.keys(items).filter(c => items[c].category === "House-made");
  const ord = { Ingredient: 0, Packaging: 1, Supplies: 2 };
  buy.sort((a, b) => (ord[items[a].category] ?? 3) - (ord[items[b].category] ?? 3) || String(items[a].name).localeCompare(String(items[b].name)));
  house.sort((a, b) => String(items[a].name).localeCompare(String(items[b].name)));
  const tabs = {};
  tabs[MASTER] = [MASTER_HEAD, ...buy.map(c => { const it = items[c];
    return [it.name, it.category, it.unit, it.packSize ?? "", it.packPrice ?? "", it.yield ?? "", it.note || "", "", ...NUT.map(([k]) => it["n_" + k] ?? ""), it.density ?? "", c]; })];
  const H = [HOUSE_HEAD];
  house.forEach((c, i) => { const it = items[c], ls = it.lines || [];
    if (i) H.push([]);
    if (!ls.length) H.push([it.name, it.makes ?? "", it.unit, it.yield ?? "", "", "", "", "", c]);
    ls.forEach((l, j) => H.push(j ? ["", "", "", "", nameOf(l[0]), l[1] ?? "?", l[2], l[3] || "", ""] : [it.name, it.makes ?? "", it.unit, it.yield ?? "", nameOf(l[0]), l[1] ?? "?", l[2], l[3] || "", c]));
  });
  tabs[HOUSE] = H;
  // drinks: one tab per name
  const byName = {};
  for (const [id, d] of Object.entries(drinks)) (byName[d.name] = byName[d.name] || []).push([id, d]);
  for (const [name, arr] of Object.entries(byName)) { arr.sort((a, b) => (a[1].size || 0) - (b[1].size || 0)); tabs[name] = drinkTab(arr, nameOf); }
  tabs[LISTS] = [["Ingredient", "Unit"], ...[...buy, ...house].map(c => [items[c].name, items[c].unit]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))];
  return tabs;
}
function drinkTab(arr, nameOf) {
  const std = arr.some(([, d]) => d.std), n = arr.length, pad = a => a;
  const head = [
    [R.size, "", ...arr.map(([, d]) => d.size ?? "")],
    [R.price, "", ...arr.map(([, d]) => d.price ?? "")],
    [R.target, "", ...arr.map(([, d]) => d.target ?? "")],
    [R.mode, std ? MODES[0] : MODES[1]],
    [],
    ["Ingredient", "Unit", ...arr.map(([, d]) => (d.size ? d.size + " ml" : "No size")), HOW, NOTE]];
  const rows = [];
  if (std) {
    const base = arr[0][1], main = (base.lines || []).filter(l => l[3] === "scale" || l[3] === "same");
    const calc = arr.map(([, d], ci) => ci === 0 ? main : standardQty(base.lines || [], base.size || 0, d.lines || [], d.size || 0));
    main.forEach((l, i) => rows.push([nameOf(l[0]), l[2], ...calc.map(c => c[i] ? (c[i][1] ?? "?") : ""), typeLabel(l[3]), l[4] || ""]));
    const own = alignRows(arr.map(([, d]) => (d.lines || []).filter(l => l[3] === "size" || l[3] === "ice")));
    own.forEach(r => rows.push([nameOf(r.code), r.unit, ...arr.map((_, ci) => ci in r.q ? (r.q[ci] ?? "?") : ""), typeLabel(r.type), r.note]));
  } else {
    alignRows(arr.map(([, d]) => d.lines || [])).forEach(r => rows.push([nameOf(r.code), r.unit, ...arr.map((_, ci) => ci in r.q ? (r.q[ci] ?? "?") : ""), typeLabel(r.type), r.note]));
  }
  void pad; void n;
  return head.concat(rows);
}
// hidden _Links tab: which app drink each size column of each tab is (tab id survives renaming)
export function linksRows(finalModel, tabIds) {
  const { drinks } = byEntity(finalModel), out = [["Tab ID", "Size (ml)", "App ID"]];
  for (const [id, d] of Object.entries(drinks)) if (tabIds[d.name] != null && !id.startsWith("new:")) out.push([tabIds[d.name], d.size ?? "", id]);
  return out;
}

// Drop-downs: [{ row, col, list?, range? }]
export function dropdowns(tabs) {
  const out = {};
  out[MASTER] = [{ row: 1, col: 1, list: CATS_BUY }, { row: 1, col: 2, list: UNITS }];
  out[HOUSE] = [{ row: 1, col: 2, list: UNITS }, { row: 1, col: 4, range: `='${LISTS}'!A2:A` }, { row: 1, col: 6, list: UNITS }];
  for (const [t, rows] of Object.entries(tabs)) {
    if (t.startsWith("_") && t !== TEMPLATE) continue; if (t === MASTER || t === HOUSE) continue;
    const hr = rows.findIndex(r => r && r[0] === "Ingredient"); if (hr < 0) continue;
    const how = rows[hr].indexOf(HOW), mr = rows.findIndex(r => r && r[0] === R.mode);
    out[t] = [{ row: hr + 1, col: 0, range: `='${LISTS}'!A2:A` }, { row: hr + 1, col: 1, list: UNITS },
      ...(how > 0 ? [{ row: hr + 1, col: how, list: TYPES.map(x => x[1]) }] : []), ...(mr >= 0 ? [{ row: mr, rowEnd: mr + 1, col: 1, list: MODES }] : [])];
  }
  return out;
}

// ---------- SHEET → model ----------
// tabs: { title: rows }, tabIds: { title: sheetId }. Returns { model, errors, bad, skipped }.
export function tabsToModel(tabs, tabIds = {}, appModel = {}, baseModel = {}) {
  const m = {}, errors = [], bad = new Set(), skipped = new Set();
  const err = (where, msg, prefix) => { errors.push({ where, msg }); if (prefix) bad.add(prefix); };
  // existing items by name (to keep codes when the Code column is blank)
  const known = {};
  for (const mm of [baseModel, appModel]) for (const [k, v] of Object.entries(mm)) if (k.startsWith("i:") && k.endsWith(":name")) known[lc(P(v)) + "|" + (P(mm[k.replace(/:name$/, ":category")]) === "House-made" ? "h" : "b")] = k.slice(2, -5);
  const nameIdx = {}, unitOf = {}, catOf = {}, nameOfCode = {};
  const addName = (name, code) => { const k = lc(name); (nameIdx[k] = nameIdx[k] || []).push(code); nameOfCode[code] = name; };
  // Masterlist
  const ms = tabs[MASTER];
  if (!ms) { err(MASTER, `Tab "${MASTER}" is missing.`, "i:"); skipped.add(MASTER); }
  else {
    const h = (ms[0] || []).map(str), C = n => h.indexOf(n), seen = new Set();
    if (C("Item") < 0) { err(MASTER, `Row 1 needs the heading "Item".`, "i:"); skipped.add(MASTER); }
    else ms.slice(1).forEach((row, i) => {
      const g = n => C(n) >= 0 ? row[C(n)] : "", name = str(g("Item")), at = `${MASTER} row ${i + 2}`;
      if (!name) return;
      let code = str(g("Code")) || known[lc(name) + "|b"] || ("new:" + slug(name));
      if (seen.has(lc(name))) { err(at, `"${name}" is listed twice.`); skipped.add(MASTER); return; }
      seen.add(lc(name));
      const p = `i:${code}:`, cat = CATS_BUY.find(c => lc(c) === lc(g("Category"))) || (str(g("Category")) ? null : "Ingredient"), unit = lc(g("Unit")) || "g";
      if (!cat) { err(at, `Category must be Ingredient, Packaging or Supplies.`, p); skipped.add(MASTER); return; }
      if (!UNITS.includes(unit)) { err(at, `Unit must be g, ml or pc.`, p); skipped.add(MASTER); return; }
      const nums = {}; let ok = true;
      for (const [f, n] of [["packSize", "Pack size"], ["packPrice", "Pack price (₱)"], ["yield", "Usable %"], ["density", "Weight of 1 ml (g)"], ...NUT.map(([k, l]) => ["n_" + k, l + " per 100"])]) {
        const v = num(g(n)); if (Number.isNaN(v)) { err(at, `${n} "${str(g(n))}" isn't a number.`, p); ok = false; } nums[f] = v == null ? null : r6(v); }
      if (!ok) { skipped.add(MASTER); return; }
      if (nums.yield != null && (nums.yield <= 0 || nums.yield > 100)) { err(at, `Usable % must be between 1 and 100.`, p); skipped.add(MASTER); return; }
      m[p + "_"] = "1"; m[p + "name"] = J(name); m[p + "category"] = J(cat); m[p + "unit"] = J(unit);
      for (const f of ["packSize", "packPrice", "yield", "density"]) m[p + f] = J(nums[f]);
      for (const [k] of NUT) m[p + "n_" + k] = J(nums["n_" + k]);
      m[p + "note"] = J(str(g("Supplier / note")));
      addName(name, code); unitOf[code] = unit; catOf[code] = cat;
    });
  }
  // House-made: blocks
  const hs = tabs[HOUSE], recipes = [];
  if (hs) {
    const h = (hs[0] || []).map(str), ix = n => h.indexOf(n), U2 = h.lastIndexOf("Unit");
    let cur = null;
    hs.slice(1).forEach((row, i) => {
      const at = `${HOUSE} row ${i + 2}`, rec = str(row[ix("Recipe")]), ing = str(row[ix("Ingredient")]);
      if (rec) { cur = { name: rec, code: str(row[ix("Code")]), makes: num(row[ix("Makes")]), unit: lc(row[ix("Unit")]) || "g", yield: num(row[ix("Usable %")]), lines: [], at, errs: [] }; recipes.push(cur); }
      if (!ing) return;
      if (!cur) return err(at, `"${ing}" has no recipe above it. Put the recipe name in the Recipe column first.`);
      const raw = str(row[ix("Amount")]), q = raw === "?" || raw === "" ? null : num(raw);
      if (Number.isNaN(q)) return cur.errs.push([at, `Amount "${raw}" isn't a number.`]);
      cur.lines.push({ ing, q, unit: lc(row[U2]), note: str(row[ix("Note")]), at });
    });
    const seen = new Set();
    for (const r of recipes) { const code = r.code || known[lc(r.name) + "|h"] || ("new:" + slug(r.name)); r.code = code;
      if (seen.has(lc(r.name))) { err(r.at, `Recipe "${r.name}" is listed twice.`); skipped.add(HOUSE); continue; }
      seen.add(lc(r.name)); addName(r.name, code); unitOf[code] = r.unit; catOf[code] = "House-made"; }
  }
  // name → code (picked from the drop-down)
  const pick = name => { const hit = nameIdx[lc(name)] || [];
    if (hit.length === 1) return { code: hit[0] };
    if (hit.length > 1) return { err: `Two items are named "${name}". Rename one.` };
    return { err: `"${name}" isn't on the Masterlist or House-made tab. Add it there, or pick from the drop-down.` }; };
  for (const r of recipes) {
    if (!UNITS.includes(r.unit)) r.errs.push([r.at, `Unit must be g, ml or pc.`]);
    if ([r.makes, r.yield].some(Number.isNaN)) r.errs.push([r.at, `Makes and Usable % must be numbers.`]);
    const lines = [];
    for (const l of r.lines) { const pk = pick(l.ing); if (pk.err) { r.errs.push([l.at, pk.err]); continue; }
      if (pk.code === r.code) { r.errs.push([l.at, `"${r.name}" can't contain itself.`]); continue; }
      const u = l.unit || unitOf[pk.code] || "g"; if (!UNITS.includes(u)) { r.errs.push([l.at, `Unit must be g, ml or pc.`]); continue; }
      lines.push([pk.code, l.q == null ? null : r6(l.q), u, l.note]); }
    const p = `i:${r.code}:`;
    if (r.errs.length) { r.errs.forEach(([w, msg]) => err(w, msg)); bad.add(p); skipped.add(HOUSE); continue; }
    m[p + "_"] = "1"; m[p + "name"] = J(r.name); m[p + "category"] = J("House-made"); m[p + "unit"] = J(r.unit);
    m[p + "makes"] = J(r.makes == null ? null : r6(r.makes)); m[p + "yield"] = J(r.yield == null ? null : r6(r.yield)); m[p + "lines"] = J(lines);
  }
  // Drinks: links
  const links = {}, linkRows = (tabs[LINKS] || []).slice(1);
  for (const r of linkRows) { const tid = str(r[0]), size = num(r[1]), id = str(r[2]); if (tid && id) (links[tid] = links[tid] || []).push({ size, id }); }
  const byNameIds = {};
  for (const mm of [appModel, baseModel]) for (const [k, v] of Object.entries(mm)) if (k.startsWith("d:") && k.endsWith(":name")) { const n = lc(P(v)); (byNameIds[n] = byNameIds[n] || new Set()).add(k.slice(2, -5)); }
  const badTab = (title, ids) => { skipped.add(title); for (const id of byNameIds[lc(title)] || []) bad.add(`d:${id}:`); for (const id of ids || []) bad.add(`d:${id}:`); };
  const usedIds = new Set();
  for (const [title, rows] of Object.entries(tabs)) {
    if (title.startsWith("_") || title === MASTER || title === HOUSE) continue;
    const name = str(title), lab = r => str((r || [])[0]), find = l => rows.findIndex(r => lab(r) === l);
    const tid = tabIds[title] != null ? String(tabIds[title]) : null, myLinks = (tid && links[tid]) || [];
    const hr = find("Ingredient");
    if (hr < 0) { err(`Drink tab "${title}"`, `Can't find the "Ingredient" heading row.`); badTab(title, myLinks.map(x => x.id)); continue; }
    const H = rows[hr].map(str), howC = H.indexOf(HOW), noteC = H.indexOf(NOTE), end = howC > 0 ? howC : H.length;
    const sizeCols = []; for (let c = 2; c < end; c++) if (H[c]) sizeCols.push(c);
    const rowOf = l => { const i = find(l); return i >= 0 ? rows[i] : []; };
    const RS = rowOf(R.size), RP = rowOf(R.price), RT = rowOf(R.target), modeRaw = str(rowOf(R.mode)[1]);
    const std = modeRaw ? lc(modeRaw).startsWith("same") : false;
    const tabErr = [], cols = [];
    for (const c of sizeCols) {
      const hs2 = H[c].match(/^(\d+(?:\.\d+)?)\s*ml$/i), size = num(RS[c] ?? "") ?? (hs2 ? +hs2[1] : null), price = num(RP[c] ?? ""), target = num(RT[c] ?? "");
      if ([size, price, target].some(Number.isNaN)) { tabErr.push(`Size, price and max cost in column ${colName(c)} must be numbers.`); continue; }
      cols.push({ c, size, price, target, lines: [] });
    }
    // link columns to app drinks: by size, then pair leftovers in order (a size that was edited)
    const free = myLinks.filter(x => !usedIds.has(x.id));
    for (const col of cols) { const i = free.findIndex(x => x.size === col.size); if (i >= 0) { col.id = free[i].id; free.splice(i, 1); } }
    const unl = cols.filter(c => !c.id); if (unl.length && unl.length === free.length) unl.forEach((c, i) => { c.id = free[i].id; });
    cols.forEach(c => { if (!c.id) c.id = `new:${slug(name)}:${c.size || colName(c.c)}`; usedIds.add(c.id); });
    rows.slice(hr + 1).forEach((r, i) => {
      const ingName = str(r[0]); if (!ingName) return;
      const pk = pick(ingName); if (pk.err) return tabErr.push(`Row ${hr + i + 2}: ${pk.err}`);
      const code = pk.code, unit = lc(r[1]) || unitOf[code] || "g";
      if (!UNITS.includes(unit)) return tabErr.push(`Row ${hr + i + 2}: unit must be g, ml or pc.`);
      const tRaw = howC > 0 ? str(r[howC]) : "", type = tRaw ? typeFromLabel(tRaw) : defaultType({ category: catOf[code], name: nameOfCode[code] });
      if (!type) return tabErr.push(`Row ${hr + i + 2}: "${tRaw}" should be Scales, Same all sizes, This size only or Ice.`);
      const note = noteC > 0 ? str(r[noteC]) : "";
      cols.forEach((col, ci) => {
        if (std && ci > 0 && (type === "scale" || type === "same")) return;   // calculated from the first size
        const raw = str(r[col.c]); if (raw === "") return;
        const q = raw === "?" ? null : num(raw);
        if (Number.isNaN(q)) { tabErr.push(`Row ${hr + i + 2}, column ${colName(col.c)}: "${raw}" isn't a number.`); return; }
        col.lines.push([code, q == null ? null : r6(q), unit, type, note]);
      });
    });
    if (tabErr.length) { tabErr.forEach(e => err(`Drink tab "${title}"`, e)); badTab(title, cols.map(c => c.id).concat(myLinks.map(x => x.id))); continue; }
    cols.sort((a, b) => (a.size || 0) - (b.size || 0));
    const lines = std ? stdCanon(cols.map(c => c.lines), 0) : canon(cols.map(c => c.lines));
    cols.forEach((col, ci) => {
      const p = `d:${col.id}:`; m[p + "_"] = "1"; m[p + "name"] = J(name); m[p + "size"] = J(col.size == null ? null : r6(col.size));
      m[p + "price"] = J(col.price > 0 ? r6(col.price) : null); m[p + "target"] = J(col.target > 0 ? r6(col.target) : null);
      m[p + "std"] = J(std); m[p + "lines"] = J(lines[ci]);
    });
  }
  return { model: m, errors, bad, skipped };
}
const colName = c => { let s = "", n = c + 1; while (n) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };

// ---------- three-way merge ----------
export function merge(base, app, sheet, bad = new Set(), resolve = {}) {
  const keys = new Set([...Object.keys(base), ...Object.keys(app), ...Object.keys(sheet)]);
  const isBad = k => { for (const p of bad) if (k.startsWith(p)) return true; return false; };
  const ent = k => k.slice(0, k.lastIndexOf(":") + 1), result = {}, changes = [], conflicts = [];
  for (const k of keys) {
    const b = base[k], a = app[k], s = isBad(k) ? b : sheet[k];
    let v;
    if (a === s) v = a;
    else if (a === b) { v = s; changes.push({ key: k, from: "sheet", before: a, after: s }); }
    else if (s === b) { v = a; changes.push({ key: k, from: "app", before: s, after: a }); }
    else { const pick = resolve[k] || resolve[ent(k)];
      if (pick === "app") { v = a; changes.push({ key: k, from: "app", before: s, after: a }); }
      else if (pick === "sheet") { v = s; changes.push({ key: k, from: "sheet", before: a, after: s }); }
      else { conflicts.push({ key: k, base: b, app: a, sheet: s }); v = a; } }
    if (v !== undefined) result[k] = v;
  }
  for (const k of Object.keys(result)) { const e = ent(k); if (!(e + "_" in result)) delete result[k]; }
  return { result, changes, conflicts };
}

// ---------- model → APP documents (only entities that changed; null = delete) ----------
export function modelToApp(result, appModel, items, drinks) {
  const ent = {}; for (const [k, v] of Object.entries(result)) { const [t, id, f] = splitKey(k); ((ent[t + ":" + id] = ent[t + ":" + id] || {})[f] = P(v)); }
  const old = {}; for (const k of Object.keys(appModel)) { const [t, id] = splitKey(k); old[t + ":" + id] = true; }
  const changed = e => { const p = e + ":"; for (const k of new Set([...Object.keys(result), ...Object.keys(appModel)])) if (k.startsWith(p) && result[k] !== appModel[k]) return true; return false; };
  const idByCode = {}; for (const [id, it] of Object.entries(items)) if (str(it.code)) idByCode[str(it.code)] = id;
  const outI = {}, outD = {}, taken = new Set(Object.keys(items)), used = new Set(Object.values(items).map(i => str(i.code)).filter(Boolean)), realCode = {};
  // new items: give them an id and a real code first, so recipes can point at them
  for (const e of Object.keys(ent)) if (e.startsWith("i:")) { const code = e.slice(2);
    if (!idByCode[code]) { const nm = ent[e].name || code; let id = slug(nm), n = 2; while (taken.has(id)) id = slug(nm) + "-" + n++; taken.add(id); idByCode[code] = id; }
    if (code.startsWith("new:")) { const cat = ent[e].category, pre = cat === "Packaging" ? "PKG" : cat === "Supplies" ? "SUP" : cat === "House-made" ? "HM" : "ING";
      let n = 1, c; do { c = `${pre}-${String(n++).padStart(3, "0")}`; } while (used.has(c)); used.add(c); realCode[code] = c; } }
  const L = ls => (ls || []).map(l => { const o = { itemId: idByCode[l[0]] || "", qty: l[1], unit: l[2] }; if (l.length > 4) { if (l[3]) o.t = l[3]; if (l[3] === "same") o.fixed = true; if (l[4]) o.note = l[4]; } else if (l[3]) o.note = l[3]; return o; });
  for (const e of new Set([...Object.keys(ent), ...Object.keys(old)])) {
    if (!changed(e)) continue;
    const t = e.slice(0, 1), id = e.slice(2), v = ent[e];
    if (t === "i") {
      const iid = idByCode[id] || id;
      if (!v) { outI[iid] = null; continue; }
      const it = Object.assign({}, items[iid] || {});
      Object.assign(it, { code: realCode[id] || id, name: v.name, category: v.category, unit: v.unit });
      if (v.yield == null) delete it.yield; else it.yield = r6(v.yield / 100);
      if (v.category === "House-made") {
        it.yieldQty = v.makes; if (!(it.batchMult > 0)) it.batchMult = 1; it.lines = L(v.lines);
        delete it.packSize; delete it.packPrice;
      } else {
        it.packSize = v.packSize; it.packPrice = v.packPrice; it.density = v.density;
        if (v.note) it.note = v.note; else delete it.note;
        const nutr = {}; let any = false; for (const [k] of NUT) { nutr[k] = v["n_" + k]; if (nutr[k] != null) any = true; }
        if (any) it.nutr = nutr; else delete it.nutr;
        delete it.lines; delete it.yieldQty; delete it.batchMult; delete it.nutrManual;
      }
      outI[iid] = it;
    } else if (t === "d") {
      if (!v) { outD[id] = null; continue; }
      let did = id; if (id.startsWith("new:")) { did = slug(v.name) + "-" + (v.size || "x"); let n = 2; while (drinks[did] || outD[did]) did = slug(v.name) + "-" + (v.size || "x") + "-" + n++; }
      const d = Object.assign({ vat: 0.12 }, drinks[did] || {});
      d.name = v.name; d.targetVol = v.size; d.baseVol = v.size; d.price = v.price; d.target = v.target == null ? null : r6(v.target / 100);
      if (v.std) d.std = true; else delete d.std;
      d.lines = L(v.lines); if (!d.lines.length) d.lines = [{ itemId: "", qty: null }];
      outD[did] = d;
    }
  }
  return { items: outI, drinks: outD };
}

// ---------- after merge: things that would break costing ----------
export function problems(result, appModel = {}) {
  const out = [], has = c => (`i:${c}:_`) in result, nm = (t, id) => { const v = result[`${t}:${id}:name`] || appModel[`${t}:${id}:name`]; return v ? P(v) : id; };
  for (const [k, v] of Object.entries(result)) {
    if (!k.endsWith(":lines")) continue; const [t, id] = splitKey(k);
    for (const l of P(v) || []) if (!has(l[0]) && !String(l[0]).startsWith("?"))
      out.push(`${t === "d" ? "Drink" : "Recipe"} "${nm(t, id)}${t === "d" && result[`d:${id}:size`] ? " " + P(result[`d:${id}:size`]) + " ml" : ""}" uses ${nm("i", l[0])}, which would be deleted.`);
  }
  return [...new Set(out)];
}

// which tab a model key lives on
export function tabOf(key, model) {
  const [t, id] = splitKey(key);
  if (t === "i") return P(model[`i:${id}:category`]) === "House-made" ? HOUSE : MASTER;
  const n = model[`d:${id}:name`]; return n ? P(n) : null;
}
const normRows = rows => JSON.stringify((rows || []).map(r => { const a = (r || []).map(x => x === null || x === undefined ? "" : x); while (a.length && a[a.length - 1] === "") a.pop(); return a; })
  .filter((r, i, arr) => r.length || arr.slice(i).some(x => x.length)));
// What to write so the sheet matches the final model. Tabs with errors are left alone.
export function planWrites(finalModel, current, skipped) {
  const want = modelToTabs(finalModel), write = {}, del = [];
  for (const [t, rows] of Object.entries(want)) if (!skipped.has(t) && normRows(rows) !== normRows(current[t])) write[t] = rows;
  for (const t of Object.keys(current)) if (!t.startsWith("_") && t !== MASTER && t !== HOUSE && !(t in want) && !skipped.has(t)) del.push(t);
  return { write, del, want };
}
// base for next time: keys on skipped tabs keep their old base
export function nextBase(finalModel, oldBase, skipped) {
  const out = {}, keep = (k, m) => { const t = tabOf(k, m); return t != null && skipped.has(t); };
  for (const [k, v] of Object.entries(finalModel)) if (!keep(k, finalModel)) out[k] = v;
  for (const [k, v] of Object.entries(oldBase)) if (keep(k, oldBase) || keep(k, finalModel)) out[k] = v;
  return out;
}

// ---------- describing changes in words ----------
const FIELD = { name: "name", category: "category", unit: "unit", packSize: "pack size", packPrice: "pack price", yield: "usable %", density: "weight of 1 ml", note: "note",
  makes: "makes", lines: "recipe", size: "size", price: "price", target: "max cost %", std: "sizes", _: "" };
export function describe(key, model) {
  const [t, id, f] = splitKey(key), nm = model[`${t}:${id}:name`] ? P(model[`${t}:${id}:name`]) : id;
  const size = t === "d" && model[`d:${id}:size`] ? " " + P(model[`d:${id}:size`]) + " ml" : "";
  return { entity: t === "i" ? nm : `${nm}${size}`, field: f.startsWith("n_") ? f.slice(2) + " per 100" : FIELD[f] ?? f, kind: t === "i" ? "Item" : "Drink" };
}
export const show = v => { if (v === undefined) return "—"; const x = P(v); if (x === true) return "same strength"; if (x === false) return "each size separate";
  if (x === null || x === "") return "blank"; if (Array.isArray(x)) return x.length + " ingredient line" + (x.length === 1 ? "" : "s"); return String(x); };
export function lineDiff(before, after, model) {
  const Lp = v => (v ? P(v) : []) || [], nm = c => { const v = model[`i:${c}:name`]; return v ? P(v) : c; };
  const a = Lp(before), b = Lp(after), out = [], usedI = new Set();
  for (const x of b) { const i = a.findIndex((y, k) => !usedI.has(k) && y[0] === x[0]); if (i < 0) { out.push("+ " + nm(x[0]) + (x[1] != null ? ` ${x[1]} ${x[2]}` : "")); continue; }
    usedI.add(i); const y = a[i]; if (y[1] !== x[1] || y[2] !== x[2]) out.push(`${nm(x[0])} ${y[1] ?? "?"} → ${x[1] ?? "?"} ${x[2]}`); }
  a.forEach((y, k) => { if (!usedI.has(k)) out.push("− " + nm(y[0])); });
  return out.length ? out.join(", ") : "order, type or notes changed";
}

// ---------- the new sheet: how-to text, examples and the Latte template ----------
export const HOWTO = [["How to use this sheet"], [""],
  ["• Masterlist: everything you buy (ingredients, packaging, supplies). One row each. Prices are per pack."],
  ["• House-made: one block per recipe. Write the recipe name, what it makes, then its ingredients on the rows below (pick from the drop-down). Leave a blank row before the next recipe."],
  ["• Drinks: one tab per drink. To add a drink, duplicate \"_Template · Latte\" and rename the copy. Sizes are in ml."],
  ["• Sizes = \"Same strength\": fill in only the first size. The other sizes are calculated so they taste equally strong, allowing for ice. Fill in each size's ice and cup yourself."],
  ["• How it changes: Scales (keeps the strength), Same all sizes, This size only (cups, lids), Ice."],
  ["• Then press Sync in the MIAU staff app (Account → Google Sheets). Tabs starting with _ are ignored."]];
// examples added to the app only if missing (by name)
export const EXAMPLES = {
  buy: [{ name: "Ground coffee", category: "Ingredient", unit: "g", packSize: 1000, packPrice: null, yield: 1, density: null },
        { name: "Water", category: "Ingredient", unit: "ml", packSize: 19000, packPrice: null, yield: 1, density: 1, note: "19 L jug", nutr: { kcal: 0, fat: 0, sat: 0, carb: 0, sugar: 0, protein: 0, sodium: 0 } },
        { name: "Cream cheese powder", category: "Ingredient", unit: "g", packSize: 500, packPrice: null, yield: 1, density: null }],
  house: [{ name: "Espresso", unit: "ml", yieldQty: 30, lines: [["Ground coffee", 30, "g"], ["Water", 30, "ml"]],
            nutrManual: true, nutr: { kcal: 9, fat: 0.18, sat: 0.09, carb: 1.67, sugar: 0, protein: 0.12, sodium: 14 }, note: "Example from your recipe. A typical double shot is about 18 g coffee for 36 g espresso." },
          { name: "Cold foam", unit: "g", yieldQty: 130, lines: [["Cream cheese powder", 30, "g"], ["Water", 100, "ml"]], note: "Example amounts. Change to your recipe." }]
};
// Latte template: 330 / 450 / 650 ml, same strength, calculated with the same math as the app
export function templateTab(names) {
  const milk = names.milk || "Fresh milk", ice = names.ice || "Ice", esp = names.espresso || "Espresso";
  const base = [["E", 30, "ml", "scale", ""], ["M", 180, "ml", "scale", ""], ["I", 120, "g", "ice", ""]];
  const sizes = [330, 450, 650], ices = [120, 160, 200];
  const calc = sizes.map((s, i) => standardQty(base, 330, [["I", ices[i], "g", "ice", ""]], s));
  return [[R.size, "", ...sizes], [R.price, "", 140, 160, 180], [R.target, "", 30, 30, 30], [R.mode, MODES[0]], [],
    ["Ingredient", "Unit", ...sizes.map(s => s + " ml"), HOW, NOTE],
    [esp, "ml", ...calc.map(c => c[0][1]), "Scales", "fill in the first size only"],
    [milk, "ml", ...calc.map(c => c[1][1]), "Scales", ""],
    [ice, "g", ...ices, "Ice", "each size's own ice"],
    ["", "pc", 1, "", "", "This size only", "← pick your 330 ml cup"],
    ["", "pc", "", 1, "", "This size only", "← pick your 450 ml cup"],
    ["", "pc", "", "", 1, "This size only", "← pick your 650 ml cup"]];
}
