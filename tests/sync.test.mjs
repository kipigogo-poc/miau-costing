// Two-way sync engine tests. Runs with plain node (no installs): node tests/sync.test.mjs
// Uses a realistic shop (fixture below, generated from the app's own seed data) and simulates both sides.
import * as E from "../public/sync-engine.js";
import { readFileSync, existsSync } from "node:fs";

const FIX = new URL("./fixtures/shop.json", import.meta.url);
const shop = JSON.parse(readFileSync(FIX, "utf8"));
const clone = x => JSON.parse(JSON.stringify(x));
const R = []; const t = (name, ok, detail = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// One full sync, exactly as the app does it. resolve = conflict choices.
function sync(st, resolve = {}) {
  const codes = E.assignCodes(st.items); for (const [id, c] of Object.entries(codes)) st.items[id].code = c;
  const A = E.appToModel(st.items, st.drinks);
  const read = E.tabsToModel(st.sheet.ingredients, st.sheet.menu, A, st.base);
  const m = E.merge(st.base, A, read.model, read.bad, resolve);
  const probs = E.problems(m.result, A);
  if (m.conflicts.length || probs.length) return { ...m, errors: read.errors, problems: probs, applied: false };
  const w = E.modelToApp(m.result, A, st.items, st.drinks);
  for (const [id, d] of Object.entries(w.items)) if (d === null) delete st.items[id]; else st.items[id] = d;
  for (const [id, d] of Object.entries(w.drinks)) if (d === null) delete st.drinks[id]; else st.drinks[id] = d;
  const F = E.appToModel(st.items, st.drinks);
  const plan = E.planWrites(F, st.sheet, read.skipped);
  Object.assign(st.sheet.ingredients, plan.ingredients);
  for (const [k, v] of Object.entries(plan.menuWrite)) st.sheet.menu[k] = v;
  for (const k of plan.menuDelete) delete st.sheet.menu[k];
  st.base = E.nextBase(F, st.base, read.skipped);
  return { ...m, errors: read.errors, problems: probs, applied: true, appWrites: w, plan, skipped: read.skipped };
}
function connect() { // "Create sheets from app data"
  const st = { items: clone(shop.items), drinks: clone(shop.drinks), base: {}, sheet: { ingredients: {}, menu: {} } };
  const codes = E.assignCodes(st.items); for (const [id, c] of Object.entries(codes)) st.items[id].code = c;
  const tabs = E.modelToTabs(E.appToModel(st.items, st.drinks)); st.sheet = { ingredients: tabs.ingredients, menu: tabs.menu };
  st.base = E.appToModel(st.items, st.drinks); return st;
}
const tab = (st, name) => st.sheet.menu[name];
const rowOf = (rows, label) => rows.find(r => r[0] === label);
const ingRow = (st, code) => st.sheet.ingredients[E.ING_TAB].find(r => r[0] === code);
const H = st => st.sheet.ingredients[E.ING_TAB][0];
const col = (st, h) => H(st).indexOf(h);
const quiet = r => r.applied && !r.changes.length && !r.conflicts.length;

// 1. round trip is lossless
{ const st = connect(); const A = E.appToModel(st.items, st.drinks); const back = E.tabsToModel(st.sheet.ingredients, st.sheet.menu);
  const diff = Object.keys({ ...A, ...back.model }).filter(k => A[k] !== back.model[k]);
  t("Round trip app → sheets → app loses nothing", back.errors.length === 0 && diff.length === 0, `${Object.keys(A).length} values, ${diff.length} differ ${diff.slice(0, 3).join(", ")}${back.errors.length ? "; errors: " + JSON.stringify(back.errors.slice(0, 2)) : ""}`);
  t("Menu sheet has one tab per drink", Object.keys(st.sheet.menu).length === new Set(Object.values(st.drinks).map(d => d.name || "Untitled")).size, Object.keys(st.sheet.menu).slice(0, 4).join(", ") + "…");
  const sl = tab(st, "Spanish Latte"); t("Spanish Latte tab has 3 sizes side by side", JSON.stringify(rowOf(sl, "Size (ml)").slice(3)) === "[355,473,651]", JSON.stringify(rowOf(sl, "Size (ml)").slice(3)));
  t("Sync right after connecting changes nothing", quiet(sync(st))); }

// 2. price changed in Sheets → app
{ const st = connect(); const r0 = ingRow(st, "ING-002"); r0[col(st, "Pack price (₱)")] = 98; r0[col(st, "Pack size")] = 1000;
  const r = sync(st); const milk = Object.values(st.items).find(i => i.code === "ING-002");
  t("Price edited in Sheets reaches the app", milk.packPrice === 98 && milk.packSize === 1000 && r.changes.every(c => c.from === "sheet"), `milk ₱${milk.packPrice}/${milk.packSize}, ${r.changes.length} changes`);
  t("…and only that ingredient is rewritten in the app", Object.keys(r.appWrites.items).length === 1 && !Object.keys(r.appWrites.drinks).length, JSON.stringify(Object.keys(r.appWrites.items)));
  t("…and the next sync is quiet", quiet(sync(st))); }

// 3. drink price changed in app → sheet (only that tab is written)
{ const st = connect(); st.drinks["spanish-latte-16"].price = 175;
  const r = sync(st); const p = rowOf(tab(st, "Spanish Latte"), "Price (₱)");
  t("Price edited in the app reaches the sheet", p[4] === 175 && r.changes.every(c => c.from === "app"), `sheet 473 ml price = ${p[4]}`);
  t("…only the Spanish Latte tab is rewritten", JSON.stringify(Object.keys(r.plan.menuWrite)) === '["Spanish Latte"]' && !Object.keys(r.plan.ingredients).length, JSON.stringify(Object.keys(r.plan.menuWrite)));
  t("…next sync is quiet", quiet(sync(st))); }

// 4. both sides changed the same value → conflict, nothing applied until chosen
{ const st = connect(); st.drinks["iced-americano-12"].price = 125; rowOf(tab(st, "Iced Americano"), "Price (₱)")[3] = 130;
  const r = sync(st); t("Same price changed on both sides → conflict, nothing applied", !r.applied && r.conflicts.length === 1 && st.drinks["iced-americano-12"].price === 125, r.conflicts.map(c => `${c.key}: app ${c.app} / sheet ${c.sheet}`).join());
  const r2 = sync(st, { [r.conflicts[0].key]: "sheet" });
  t("Choosing 'Sheets' applies 130 everywhere", r2.applied && st.drinks["iced-americano-12"].price === 130 && rowOf(tab(st, "Iced Americano"), "Price (₱)")[3] === 130);
  const st2 = connect(); st2.drinks["iced-americano-12"].price = 125; rowOf(tab(st2, "Iced Americano"), "Price (₱)")[3] = 130;
  sync(st2, { "d:iced-americano-12:price": "app" });
  t("Choosing 'App' applies 125 everywhere", st2.drinks["iced-americano-12"].price === 125 && rowOf(tab(st2, "Iced Americano"), "Price (₱)")[3] === 125); }

// 5. different fields edited on each side → both kept, no conflict
{ const st = connect(); st.drinks["mocha-latte-12"].price = 160; const row = tab(st, "Mocha Latte").find(r => r[0] === "ING-017"); row[3] = 28;
  const r = sync(st); const choc = st.drinks["mocha-latte-12"].lines.find(l => st.items[l.itemId]?.code === "ING-017");
  t("App changes price while Sheets changes an amount → both kept", r.applied && !r.conflicts.length && st.drinks["mocha-latte-12"].price === 160 && choc.qty === 28 && rowOf(tab(st, "Mocha Latte"), "Price (₱)")[3] === 160, `price ${st.drinks["mocha-latte-12"].price}, chocolate ${choc.qty} g`); }

// 6. new drink made in Sheets by duplicating a tab
{ const st = connect(); const copy = clone(tab(st, "Vanilla Latte")); st.sheet.menu["Hazelnut Latte"] = copy; copy.find(r => r[0] === "ING-016")[0] = "ING-016";
  rowOf(copy, "Price (₱)")[3] = 165;
  const r = sync(st); const hz = Object.entries(st.drinks).filter(([, d]) => d.name === "Hazelnut Latte");
  t("Duplicated tab becomes a new drink (all sizes)", r.applied && hz.length === 3 && hz.some(([, d]) => d.price === 165), hz.map(([id, d]) => `${id} ₱${d.price}`).join(", "));
  t("…the original Vanilla Latte is untouched", Object.values(st.drinks).filter(d => d.name === "Vanilla Latte").length === 3);
  t("…the new tab gets its App IDs filled in", rowOf(tab(st, "Hazelnut Latte"), "App ID (don't edit)").slice(3).every(x => x && !String(x).startsWith("new:")), JSON.stringify(rowOf(tab(st, "Hazelnut Latte"), "App ID (don't edit)").slice(3)));
  t("…next sync is quiet", quiet(sync(st))); }

// 7. new ingredient row in Sheets, used by a drink
{ const st = connect(); const h = H(st), row = h.map(() => ""); row[0] = "ING-099"; row[1] = "Hazelnut syrup"; row[2] = "Ingredient"; row[3] = "ml"; row[4] = 750; row[5] = "₱420"; row[6] = "100";
  st.sheet.ingredients[E.ING_TAB].push(row); tab(st, "Vanilla Latte").push(["ING-099", "", "ml", 10, 12, 15, "", "new"]);
  const r = sync(st); const hz = Object.entries(st.items).find(([, i]) => i.code === "ING-099");
  t("New ingredient row (with ₱ and text numbers) is created", r.applied && hz && hz[1].packPrice === 420 && hz[1].packSize === 750 && hz[1].yield === 1, hz ? `${hz[0]}: ${hz[1].packSize} ml for ₱${hz[1].packPrice}` : JSON.stringify(r.errors));
  t("…and the drink uses it", st.drinks["vanilla-latte-16"].lines.some(l => l.itemId === hz?.[0] && l.qty === 12)); }

// 8. drink tab deleted in Sheets → drinks removed in app
{ const st = connect(); delete st.sheet.menu["Milo Dino"]; const r = sync(st);
  t("Deleting a drink tab removes that drink in the app", r.applied && !Object.values(st.drinks).some(d => d.name === "Milo Dino") && Object.values(r.appWrites.drinks).filter(x => x === null).length === 3); }

// 9. ingredient deleted in Sheets but still used → blocked with a clear message
{ const st = connect(); st.sheet.ingredients[E.ING_TAB] = st.sheet.ingredients[E.ING_TAB].filter(r => r[0] !== "ING-004");
  const r = sync(st); t("Deleting an ingredient still used by drinks is blocked", !r.applied && r.problems.length > 0 && Object.values(st.items).some(i => i.code === "ING-004"), r.problems[0]); }

// 10. typo in the Ingredients tab → that tab is left alone; the rest still syncs
{ const st = connect(); ingRow(st, "ING-002")[col(st, "Pack price (₱)")] = "abc"; st.drinks["oreo-latte-12"].price = 140; st.items["ice"].packPrice = 5;
  const before = JSON.stringify(st.sheet.ingredients[E.ING_TAB]);
  const r = sync(st); const milk = Object.values(st.items).find(i => i.code === "ING-002");
  t("Typo in Sheets is reported, not applied", r.errors.some(e => /isn't a number/.test(e.msg)) && milk.packPrice === shop.items.milk.packPrice, r.errors[0] && `${r.errors[0].where}: ${r.errors[0].msg}`);
  t("…the Ingredients tab isn't overwritten (typo kept for fixing)", JSON.stringify(st.sheet.ingredients[E.ING_TAB]) === before);
  t("…drink changes still sync", rowOf(tab(st, "Oreo Coffee Latte"), "Price (₱)")[3] === 140);
  ingRow(st, "ING-002")[col(st, "Pack price (₱)")] = 99; const r2 = sync(st);
  t("After the typo is fixed, both pending changes go through", r2.applied && Object.values(st.items).find(i => i.code === "ING-002").packPrice === 99 && ingRow(st, "ING-004")[col(st, "Pack price (₱)")] === 5,
    `milk ₱${Object.values(st.items).find(i => i.code === "ING-002").packPrice}, ice in sheet ₱${ingRow(st, "ING-004")[col(st, "Pack price (₱)")]}`); }

// 11. broken drink tab → drink NOT deleted, tab NOT overwritten
{ const st = connect(); const tb = tab(st, "Dirty Matcha"); const hr = tb.findIndex(r => r[0] === "Code"); tb[hr][0] = "Kode";
  st.drinks["dirty-matcha-12"].price = 170;
  const r = sync(st);
  t("Broken drink tab doesn't delete the drink", r.applied && Object.values(st.drinks).filter(d => d.name === "Dirty Matcha").length === 3 && r.errors.length === 1, r.errors[0]?.msg);
  t("…and isn't overwritten", tab(st, "Dirty Matcha")[hr][0] === "Kode");
  tab(st, "Dirty Matcha")[hr][0] = "Code"; const r2 = sync(st);
  t("…after fixing it, the app's price change reaches it", r2.applied && rowOf(tab(st, "Dirty Matcha"), "Price (₱)")[3] === 170); }

// 12. unknown ingredient code in a drink → that drink skipped with a message
{ const st = connect(); tab(st, "Strawberry Coffee").push(["ING-777", "", "g", 5, "", "", "", ""]);
  const r = sync(st); t("Unknown code in a drink tab is reported, drink unchanged", r.errors.some(e => /ING-777/.test(e.msg)) && st.drinks["strawberry-coffee-12"].lines.length === shop.drinks["strawberry-coffee-12"].lines.length); }

// 13. tab renamed in Sheets → drink renamed (same ids, nothing deleted)
{ const st = connect(); st.sheet.menu["Iced Spanish Latte"] = st.sheet.menu["Spanish Latte"]; delete st.sheet.menu["Spanish Latte"];
  const r = sync(st); t("Renaming a tab renames the drink (no delete)", r.applied && st.drinks["spanish-latte-12"]?.name === "Iced Spanish Latte" && !Object.values(r.appWrites.drinks).includes(null)); }

// 14. new item made in the app gets a code and lands in the sheet
{ const st = connect(); st.items["i-new1"] = { name: "Oat milk", category: "Ingredient", unit: "ml", packSize: 1000, packPrice: 180, yield: 1, density: null };
  const r = sync(st); const row = st.sheet.ingredients[E.ING_TAB].find(x => x[1] === "Oat milk");
  t("Ingredient added in the app gets a code and appears in the sheet", r.applied && row && /^ING-\d{3}$/.test(row[0]) && st.items["i-new1"].code === row[0], row && row[0]); }

// 15. house-made recipe edited in Sheets
{ const st = connect(); const rows = st.sheet.ingredients[E.PREP_TAB]; const ln = rows.find(r => r[0] === "HM-001" && r[4] === "ING-010"); ln[6] = 2;
  const r = sync(st); const ss = Object.values(st.items).find(i => i.code === "HM-001"); const salt = ss.lines.find(l => st.items[l.itemId]?.code === "ING-010");
  t("House-made recipe amount edited in Sheets reaches the app", r.applied && salt.qty === 2, `sea salt ${salt.qty} g`); }

// 16. a value that looks like a formula is stored as text (sheet is written RAW)
{ const st = connect(); st.items["salt"].note = "=IMPORTXML(\"http://x\")"; sync(st);
  t("Formula-looking text is written as plain text", ingRow(st, st.items["salt"].code)[col(st, "Note")] === "=IMPORTXML(\"http://x\")"); }

// 17. tabs starting with _ are ignored
{ const st = connect(); st.sheet.menu["_How to use"] = [["Read me"]]; const r = sync(st); t("Tabs starting with _ are ignored", quiet(r) && st.sheet.menu["_How to use"]); }

// 18. ingredient deleted in app (unused) disappears from sheet; drink deleted in app removes its tab
{ const st = connect(); delete st.items["salt"]; for (const id of Object.keys(st.drinks)) if (st.drinks[id].name === "Milo Dino") { for (const l of st.drinks[id].lines) if (l.itemId === "salt") l.itemId = ""; }
  for (const id of Object.keys(st.drinks)) if (st.drinks[id].name === "White Mocha Latte") delete st.drinks[id];
  const r = sync(st); t("Deleting in the app removes the row and the drink tab", r.applied && !st.sheet.ingredients[E.ING_TAB].some(x => x[1] === "Salt") && !tab(st, "White Mocha Latte") && r.plan.menuDelete.includes("White Mocha Latte")); }

// 19. a drink with no name/size yet (just created in the app) survives the round trip
{ const st = connect(); st.drinks["d-new"] = { name: "", baseVol: null, targetVol: null, price: null, vat: 0.12, target: 0.3, lines: [{ itemId: "", qty: null }] };
  const r = sync(st); const r2 = sync(st);
  t("A new, still-empty drink syncs without errors", r.applied && !r.errors.length && quiet(r2) && !!tab(st, "Untitled"), JSON.stringify(r.errors.concat(r2.errors)).slice(0, 160)); }

console.log(`\n${R.filter(Boolean).length}/${R.length} sync checks passed`);
process.exit(R.every(Boolean) ? 0 : 1);
