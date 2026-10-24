// Two-way sync, layout 2 (one sheet: Masterlist, House-made, a tab per drink). Plain node: node tests/sync.test.mjs
import * as E from "../public/sync-engine.js";
import { readFileSync } from "node:fs";

const shop = JSON.parse(readFileSync(new URL("./fixtures/shop.json", import.meta.url), "utf8"));
const clone = x => JSON.parse(JSON.stringify(x));
const R = []; const t = (name, ok, detail = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
let nextTabId = 1000;

// One full sync, exactly as the app does it (see public/sheets.js apply()).
function sync(st, resolve = {}) {
  for (const [id, c] of Object.entries(E.assignCodes(st.items))) st.items[id].code = c;
  const A = E.appToModel(st.items, st.drinks);
  const read = E.tabsToModel(st.book.tabs, st.book.ids, A, st.base);
  const m = E.merge(st.base, A, read.model, read.bad, resolve);
  const probs = E.problems(m.result, A);
  if (m.conflicts.length || probs.length) return { ...m, errors: read.errors, problems: probs, applied: false };
  const w = E.modelToApp(m.result, A, st.items, st.drinks);
  for (const [id, d] of Object.entries(w.items)) if (d === null) delete st.items[id]; else st.items[id] = d;
  for (const [id, d] of Object.entries(w.drinks)) if (d === null) delete st.drinks[id]; else st.drinks[id] = d;
  const F = E.appToModel(st.items, st.drinks), plan = E.planWrites(F, st.book.tabs, read.skipped);
  for (const [k, v] of Object.entries(plan.write)) { if (!(k in st.book.ids)) st.book.ids[k] = nextTabId++; st.book.tabs[k] = v; }
  for (const k of plan.del) { delete st.book.tabs[k]; delete st.book.ids[k]; }
  st.book.tabs[E.LINKS] = E.linksRows(F, st.book.ids);
  st.base = E.nextBase(F, st.base, read.skipped);
  return { ...m, errors: read.errors, problems: probs, applied: true, appWrites: w, plan, skipped: read.skipped };
}
function connect() {   // "Create the sheet from my data"
  const st = { items: clone(shop.items), drinks: clone(shop.drinks), base: {} };
  for (const [id, c] of Object.entries(E.assignCodes(st.items))) st.items[id].code = c;
  const model = E.appToModel(st.items, st.drinks), tabs = E.modelToTabs(model), ids = {};
  for (const k of Object.keys(tabs)) ids[k] = nextTabId++;
  tabs[E.TEMPLATE] = E.templateTab({ milk: "Fresh or full cream milk", ice: "Ice" }); ids[E.TEMPLATE] = nextTabId++;
  tabs[E.LINKS] = E.linksRows(model, ids); ids[E.LINKS] = nextTabId++;
  st.book = { tabs, ids }; st.base = model; return st;
}
const quiet = r => r.applied && !r.changes.length && !r.conflicts.length && !r.errors.length;
const tab = (st, n) => st.book.tabs[n];
const rowOf = (rows, label) => rows.find(r => r[0] === label);
const M = st => tab(st, E.MASTER), MH = st => M(st)[0], mcol = (st, h) => MH(st).indexOf(h);
const mrow = (st, name) => M(st).find(r => r[0] === name);
const ingRow = (rows, name) => rows.find(r => r[0] === name);
const sizeCols = rows => { const h = rows.find(r => r[0] === "Ingredient"); return h.map((x, i) => /ml$/.test(String(x)) ? i : -1).filter(i => i >= 0); };

// 1. round trip is lossless; layout is what was asked for
{ const st = connect(); const A = E.appToModel(st.items, st.drinks), back = E.tabsToModel(st.book.tabs, st.book.ids, A, st.base);
  const diff = Object.keys({ ...A, ...back.model }).filter(k => A[k] !== back.model[k]);
  t("Round trip app → sheet → app loses nothing", !back.errors.length && !diff.length, `${Object.keys(A).length} values, ${diff.length} differ ${diff.slice(0, 3)} ${JSON.stringify(back.errors.slice(0, 2))}`);
  t("Masterlist: Item, Category, Unit, Pack size, Pack price… and Code last", JSON.stringify(MH(st).slice(0, 7)) === JSON.stringify(["Item", "Category", "Unit", "Pack size", "Pack price (₱)", "Usable %", "Supplier / note"]) && MH(st).at(-1) === "Code");
  t("No house-made items on the Masterlist", !M(st).some(r => r[1] === "House-made"));
  const H = tab(st, E.HOUSE); t("House-made: recipe blocks (name on the first row, ingredients below)", H[0][0] === "Recipe" && H.some(r => r[0] === "Sea salt cream") && H.some(r => r[0] === "" && r[4]), H.slice(1, 4).map(r => r.slice(0, 6).join("|")).join(" / "));
  const sl = tab(st, "Spanish Latte");
  t("Drink tab: sizes in ml, ingredient names (no codes), How it changes", JSON.stringify(rowOf(sl, "Size (ml)").slice(2)) === "[355,473,651]" && rowOf(sl, "Ingredient").includes("355 ml") && rowOf(sl, "Ingredient").includes("How it changes") && sl.some(r => r[0] === "Fresh or full cream milk"));
  t("No App IDs on drink tabs (they live in the hidden _Links tab)", !sl.some(r => String(r[0]).includes("App ID")) && tab(st, E.LINKS).length > 30);
  t("Sync right after creating changes nothing", quiet(sync(st))); }

// 2. price edited on the Masterlist
{ const st = connect(); mrow(st, "Fresh or full cream milk")[mcol(st, "Pack price (₱)")] = 98;
  const r = sync(st); t("Masterlist price edit reaches the app", st.items.milk.packPrice === 98 && r.changes.length === 1); t("…next sync quiet", quiet(sync(st))); }

// 3. new Masterlist row with no code, including a Supplies item
{ const st = connect(); const h = MH(st), row = h.map(() => ""); row[0] = "Oat milk"; row[1] = "Ingredient"; row[2] = "ml"; row[3] = 1000; row[4] = "₱185"; M(st).push(row);
  const r2 = h.map(() => ""); r2[0] = "Dishwashing liquid"; r2[1] = "Supplies"; r2[2] = "ml"; r2[3] = 1000; r2[4] = 120; M(st).push(r2);
  const r = sync(st); const oat = Object.values(st.items).find(i => i.name === "Oat milk"), dish = Object.values(st.items).find(i => i.name === "Dishwashing liquid");
  t("New row without a code is added (₱ text OK)", r.applied && oat && oat.packPrice === 185 && /^ING-\d{3}$/.test(oat.code), oat && oat.code);
  t("Supplies category works", dish && dish.category === "Supplies" && /^SUP-/.test(dish.code), dish && dish.code);
  t("…the sheet gets the codes filled in, next sync quiet", mrow(st, "Oat milk").at(-1) === oat.code && quiet(sync(st))); }

// 4. house-made recipe added in the sheet and used in a drink by name
{ const st = connect(); const H = tab(st, E.HOUSE);
  H.push([], ["Espresso", 30, "ml", "", "Coffee beans", 30, "g", "", ""], ["", "", "", "", "Brewing water", 30, "g", "", ""]);
  ingRow(tab(st, "Iced Americano"), "Cold brew coffee")[0] = "Espresso";
  const r = sync(st); const esp = Object.entries(st.items).find(([, i]) => i.name === "Espresso");
  t("New house-made recipe block is created", r.applied && esp && esp[1].category === "House-made" && esp[1].lines.length === 2 && esp[1].yieldQty === 30, esp && esp[1].code);
  t("…and a drink can use it by picking its name", st.drinks["iced-americano-12"].lines.some(l => l.itemId === esp[0]));
  t("…next sync quiet", quiet(sync(st))); }

// 5. renaming a drink tab renames the drink (tab id kept)
{ const st = connect(); st.book.tabs["Iced Spanish Latte"] = st.book.tabs["Spanish Latte"]; st.book.ids["Iced Spanish Latte"] = st.book.ids["Spanish Latte"]; delete st.book.tabs["Spanish Latte"]; delete st.book.ids["Spanish Latte"];
  const r = sync(st); t("Renaming a tab renames the drink, nothing deleted", r.applied && st.drinks["spanish-latte-12"].name === "Iced Spanish Latte" && !Object.values(r.appWrites.drinks).includes(null)); }

// 6. duplicating a tab makes a new drink
{ const st = connect(); st.book.tabs["Hazelnut Latte"] = clone(tab(st, "Vanilla Latte")); st.book.ids["Hazelnut Latte"] = nextTabId++;
  rowOf(tab(st, "Hazelnut Latte"), "Price (₱)")[2] = 165;
  const r = sync(st); const hz = Object.values(st.drinks).filter(d => d.name === "Hazelnut Latte");
  t("Duplicated tab becomes a new drink (all sizes); original untouched", r.applied && hz.length === 3 && hz.some(d => d.price === 165) && Object.values(st.drinks).filter(d => d.name === "Vanilla Latte").length === 3);
  t("…next sync quiet", quiet(sync(st))); }

// 7. Same strength set in the sheet
{ const st = connect(); const sl = tab(st, "Spanish Latte"); rowOf(sl, "Sizes")[1] = "Same strength";
  const r = sync(st); const d = st.drinks;
  t("'Sizes: Same strength' turns on standard sizes", r.applied && d["spanish-latte-12"].std && d["spanish-latte-16"].std && d["spanish-latte-22"].std);
  t("…bigger sizes keep only their own ice/cups (the rest is calculated)", d["spanish-latte-16"].lines.every(l => l.t === "ice" || l.t === "size"), d["spanish-latte-16"].lines.map(l => l.itemId + ":" + l.t).join(", "));
  const sl2 = tab(st, "Spanish Latte"), cols = sizeCols(sl2), milk = ingRow(sl2, "Fresh or full cream milk");
  const base = shop.drinks["spanish-latte-12"], ice = id => (shop.drinks[id].lines.find(l => l.itemId === "ice") || {}).qty || 0;
  const want = Math.round(base.lines.find(l => l.itemId === "milk").qty * (473 - ice("spanish-latte-16") * 1.09) / (355 - ice("spanish-latte-12") * 1.09));
  t("…the sheet shows the calculated amounts (ice-aware)", milk[cols[1]] === want, `473 ml milk ${milk[cols[1]]} (expected ${want})`);
  milk[cols[2]] = 999;   // someone types over a calculated cell
  const r2 = sync(st); t("Typing over a calculated cell is ignored and put back", quiet(r2) || (r2.applied && !r2.changes.some(c => c.from === "sheet")), `cell now ${ingRow(tab(st, "Spanish Latte"), "Fresh or full cream milk")[cols[2]]}`);
  milk[cols[0]] = 90; ingRow(tab(st, "Spanish Latte"), "Fresh or full cream milk")[cols[0]] = 90;
  const r3 = sync(st); const m3 = ingRow(tab(st, "Spanish Latte"), "Fresh or full cream milk");
  t("Changing the first size updates the app, and the other sizes are recalculated in the sheet", r3.applied && st.drinks["spanish-latte-12"].lines.find(l => l.itemId === "milk").qty === 90 && m3[cols[1]] === Math.round(90 * (473 - ice("spanish-latte-16") * 1.09) / (355 - ice("spanish-latte-12") * 1.09)), `473 ml now ${m3[cols[1]]}`);
  t("…next sync quiet", quiet(sync(st))); }

// 8. size edited in the header keeps the same drink
{ const st = connect(); const sl = tab(st, "Mocha Latte"), c = sizeCols(sl); rowOf(sl, "Size (ml)")[c[0]] = 330; rowOf(sl, "Ingredient")[c[0]] = "330 ml";
  const r = sync(st); t("Changing 355 → 330 ml keeps the same drink (no delete/new)", r.applied && st.drinks["mocha-latte-12"] && st.drinks["mocha-latte-12"].targetVol === 330 && !Object.keys(r.appWrites.drinks).some(k => !shop.drinks[k])); }

// 9. template, helper tabs, drop-downs
{ const st = connect(); const r = sync(st); const dd = E.dropdowns(st.book.tabs);
  t("Latte template is ignored when syncing", quiet(r) && !Object.values(st.drinks).some(d => /template/i.test(d.name)));
  t("Template is ready to copy: 330/450/650 ml, same strength, first size filled", (() => { const tp = tab(st, E.TEMPLATE); return JSON.stringify(rowOf(tp, "Size (ml)").slice(2)) === "[330,450,650]" && rowOf(tp, "Sizes")[1] === "Same strength"; })());
  t("Drop-downs: drink Ingredient column lists the Masterlist + House-made names", dd["Spanish Latte"][0].range === "='_Lists'!A2:A" && tab(st, E.LISTS).some(r => r[0] === "Sea salt cream") && tab(st, E.LISTS).some(r => r[0] === "Fresh or full cream milk")); }
{ const st = connect(); const tp = clone(E.templateTab({ milk: "Fresh or full cream milk", ice: "Ice", espresso: "Brewing water" })); tp.splice(9); st.book.tabs["Latte"] = tp; st.book.ids["Latte"] = nextTabId++;
  const r = sync(st); const lat = Object.values(st.drinks).filter(d => d.name === "Latte");
  t("A copy of the template becomes a 3-size standard drink", r.applied && lat.length === 3 && lat.every(d => d.std) && lat.map(d => d.targetVol).join() === "330,450,650", r.errors.map(e => e.msg).join(" | ")); }

// 10. typo on the Masterlist: that tab is left alone, the rest syncs; after fixing, both go through
{ const st = connect(); mrow(st, "Fresh or full cream milk")[mcol(st, "Pack price (₱)")] = "abc"; st.drinks["oreo-latte-12"].price = 140; st.items.ice.packPrice = 5;
  const before = JSON.stringify(M(st)); const r = sync(st);
  t("Typo reported, Masterlist not overwritten, drink change still synced", r.errors.some(e => /isn't a number/.test(e.msg)) && JSON.stringify(M(st)) === before && rowOf(tab(st, "Oreo Coffee Latte"), "Price (₱)")[2] === 140);
  mrow(st, "Fresh or full cream milk")[mcol(st, "Pack price (₱)")] = 99; const r2 = sync(st);
  t("After fixing it, both pending changes go through", r2.applied && st.items.milk.packPrice === 99 && mrow(st, "Ice")[mcol(st, "Pack price (₱)")] === 5); }

// 11. broken drink tab → not deleted, not overwritten
{ const st = connect(); const tb = tab(st, "Dirty Matcha"), hr = tb.findIndex(r => r[0] === "Ingredient"); tb[hr][0] = "Ingrediant"; st.drinks["dirty-matcha-12"].price = 170;
  const r = sync(st); t("Broken drink tab: drink kept, tab left as is", r.applied && Object.values(st.drinks).filter(d => d.name === "Dirty Matcha").length === 3 && tab(st, "Dirty Matcha")[hr][0] === "Ingrediant");
  tab(st, "Dirty Matcha")[hr][0] = "Ingredient"; const r2 = sync(st); t("…after fixing, the app's change reaches it", r2.applied && rowOf(tab(st, "Dirty Matcha"), "Price (₱)")[2] === 170); }

// 12. unknown ingredient name
{ const st = connect(); tab(st, "Mocha Latte").push(["Unicorn dust", "g", 1, 1, 1, "Scales", ""]);
  const r = sync(st); t("Ingredient not on the Masterlist is reported, drink unchanged", r.errors.some(e => /Unicorn dust/.test(e.msg)) && st.drinks["mocha-latte-12"].lines.length === shop.drinks["mocha-latte-12"].lines.length); }

// 13. deleting a drink tab / an ingredient still in use
{ const st = connect(); delete st.book.tabs["Milo Dino"]; delete st.book.ids["Milo Dino"]; const r = sync(st);
  t("Deleting a drink tab removes that drink", r.applied && !Object.values(st.drinks).some(d => d.name === "Milo Dino")); }
{ const st = connect(); st.book.tabs[E.MASTER] = M(st).filter(r => r[0] !== "Ice"); const r = sync(st);
  t("Deleting an ingredient that drinks still use is blocked", !r.applied && r.problems.length > 0 && /Ice/.test(r.problems[0]), r.problems[0]); }

// 14. changes in the app reach the sheet
{ const st = connect(); st.drinks["vanilla-latte-16"].price = 175; st.items["sugar-syrup"].packPrice = 77;
  st.items["new-x"] = { name: "Brown sugar", category: "Ingredient", unit: "g", packSize: 1000, packPrice: 90, yield: 1, density: null };
  const r = sync(st); t("App edits (price, new item) reach the sheet", r.applied && rowOf(tab(st, "Vanilla Latte"), "Price (₱)")[3] === 175 && mrow(st, "Sugar syrup")[mcol(st, "Pack price (₱)")] === 77 && !!mrow(st, "Brown sugar"));
  t("…only the changed tabs are rewritten", JSON.stringify(Object.keys(r.plan.write).sort()) === JSON.stringify([E.LISTS, E.MASTER, "Vanilla Latte"].sort()), JSON.stringify(Object.keys(r.plan.write))); }

// 15. conflict
{ const st = connect(); st.drinks["iced-americano-12"].price = 125; rowOf(tab(st, "Iced Americano"), "Price (₱)")[2] = 130;
  const r = sync(st); t("Same price changed in both places → you choose", !r.applied && r.conflicts.length === 1);
  const r2 = sync(st, { [r.conflicts[0].key]: "sheet" }); t("…choosing Sheets applies it everywhere", r2.applied && st.drinks["iced-americano-12"].price === 130); }

// 16. the math matches the formula from the chat (330 vs 650 ml Iced Latte)
{ const base = [["E", 30, "ml", "scale", ""], ["M", 169, "ml", "scale", ""], ["I", 120, "g", "ice", ""]];
  const q = E.standardQty(base, 330, [["I", 200, "g", "ice", ""]], 650);
  t("330 → 650 ml with 120 g → 200 g ice: espresso 30 → 65 ml, milk 169 → 367 ml", q[0][1] === 65 && q[1][1] === 367, JSON.stringify(q.map(x => x[1]))); }

console.log(`\n${R.filter(Boolean).length}/${R.length} sync checks passed`);
process.exit(R.every(Boolean) ? 0 : 1);
