// Security tests for firestore.rules — every case is an attempt by a customer, a stranger or a staff member.
// Runs against Google's real Firestore emulator:  cd tests && npm i && npx firebase-tools emulators:exec --only firestore --project demo-miau "node rules.test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp } from "firebase/firestore";
import { readFileSync, appendFileSync } from "node:fs";

const env = await initializeTestEnvironment({ projectId: "demo-miau", firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
const SHOP = "shops/main";
const anon = env.unauthenticatedContext().firestore();
const stranger = env.authenticatedContext("u-stranger", { email: "someone@gmail.com", email_verified: true }).firestore();
const staff = env.authenticatedContext("u-staff", { email: "pop.rim.25@gmail.com", email_verified: true }).firestore();
const staffCaps = env.authenticatedContext("u-staff2", { email: "POP.RIM.25@GMAIL.COM", email_verified: true }).firestore();
const staff2 = env.authenticatedContext("u-staff4", { email: "Dionisioarevalo@gmail.com", email_verified: true }).firestore();
const staffUnverified = env.authenticatedContext("u-staff3", { email: "pop.rim.25@gmail.com", email_verified: false }).firestore();

const ID = "abcdefghijkmnpqrstuv23", ID2 = "zyxwvutsrqpnmkjihgfe99";
const order = (o = {}) => ({ code: "KMW4", name: "Ana", phone: "0917 000 0000", pickup: "ASAP", note: null,
  items: [{ menuId: "sl12", name: "Spanish Latte", cup: 355, price: 150, qty: 2 }], total: 300, status: "awaiting_payment", paymentRef: null, createdAt: serverTimestamp(), ...o });
const omit = (o, k) => { const c = { ...o }; delete c[k]; return c; };

async function seed(open = true) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await setDoc(doc(db, SHOP, "settings", "public"), { open, shopName: "miauxeveryday", gcashNumber: "0917 123 4567" });
    await setDoc(doc(db, SHOP, "settings", "private"), { secret: true });
    await setDoc(doc(db, SHOP, "items", "milk"), { name: "Milk", packPrice: 95 });
    await setDoc(doc(db, SHOP, "drinks", "sl12"), { name: "Spanish Latte", price: 150 });
    await setDoc(doc(db, SHOP, "menu", "sl12"), { name: "Spanish Latte", price: 150 });
    await setDoc(doc(db, SHOP, "orders", ID2), { ...order(), createdAt: new Date() });
    await setDoc(doc(db, SHOP, "orders", "ready00000000000000000"), { ...order({ status: "ready" }), createdAt: new Date() });
  });
}

const results = [];
async function t(name, expect, fn) {
  let ok, why = "";
  try { await (expect === "allow" ? assertSucceeds(fn()) : assertFails(fn())); ok = true; } catch (e) { ok = false; why = (e.message || "").split("\n")[0]; }
  results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${expect}] ${name}${why ? "  — " + why : ""}`);
}

await seed(true);
// --- Strangers and customers: private costing data
await t("Anyone: read ingredient prices", "deny", () => getDoc(doc(anon, SHOP, "items", "milk")));
await t("Anyone: list all ingredients", "deny", () => getDocs(collection(anon, SHOP, "items")));
await t("Anyone: read recipes/costs", "deny", () => getDoc(doc(anon, SHOP, "drinks", "sl12")));
await t("Signed-in non-staff: read ingredient prices", "deny", () => getDoc(doc(stranger, SHOP, "items", "milk")));
await t("Signed-in non-staff: change a recipe", "deny", () => setDoc(doc(stranger, SHOP, "drinks", "sl12"), { name: "x", price: 1 }));
await t("Staff with unverified email: read costs", "deny", () => getDoc(doc(staffUnverified, SHOP, "items", "milk")));
// --- Public menu
await t("Anyone: read public menu", "allow", () => getDoc(doc(anon, SHOP, "menu", "sl12")));
await t("Anyone: change a menu price", "deny", () => setDoc(doc(anon, SHOP, "menu", "sl12"), { name: "Spanish Latte", price: 1 }));
await t("Signed-in non-staff: change a menu price", "deny", () => updateDoc(doc(stranger, SHOP, "menu", "sl12"), { price: 1 }));
await t("Anyone: replace a menu photo", "deny", () => setDoc(doc(anon, SHOP, "photos", "spanish-latte"), { data: "data:image/png;base64,AAAA" }));
await t("Anyone: read photo index", "allow", () => getDoc(doc(anon, SHOP, "photos", "_index")));
await t("Anyone: tamper with photo index", "deny", () => setDoc(doc(anon, SHOP, "photos", "_index"), { v: { "spanish-latte": 1 } }));
await t("Staff: update photo index", "allow", () => setDoc(doc(staff, SHOP, "photos", "_index"), { v: { "spanish-latte": 2 } }, { merge: true }));
await t("Anyone: read shop settings (public)", "allow", () => getDoc(doc(anon, SHOP, "settings", "public")));
await t("Anyone: read private settings", "deny", () => getDoc(doc(anon, SHOP, "settings", "private")));
await t("Anyone: list settings", "deny", () => getDocs(collection(anon, SHOP, "settings")));
await t("Anyone: open/close the shop or change GCash number", "deny", () => updateDoc(doc(anon, SHOP, "settings", "public"), { gcashNumber: "0999 999 9999" }));
// --- Orders: privacy
await t("Anyone: list all orders (names, phones)", "deny", () => getDocs(collection(anon, SHOP, "orders")));
await t("Signed-in non-staff: list all orders", "deny", () => getDocs(collection(stranger, SHOP, "orders")));
await t("Customer: open own order by its secret id", "allow", () => getDoc(doc(anon, SHOP, "orders", ID2)));
// --- Orders: creating
await t("Customer: place a valid order", "allow", () => setDoc(doc(anon, SHOP, "orders", ID), order()));
await t("Customer: overwrite an existing order", "deny", () => setDoc(doc(anon, SHOP, "orders", ID2), order({ name: "Hacker" })));
await t("Customer: order already marked 'ready'", "deny", () => setDoc(doc(anon, SHOP, "orders", "a" + ID), order({ status: "ready" })));
await t("Customer: order already marked paid", "deny", () => setDoc(doc(anon, SHOP, "orders", "b" + ID), order({ status: "payment_submitted", paymentRef: "1234567890" })));
await t("Customer: extra hidden field", "deny", () => setDoc(doc(anon, SHOP, "orders", "c" + ID), order({ discount: 100 })));
await t("Customer: zero total", "deny", () => setDoc(doc(anon, SHOP, "orders", "d" + ID), order({ total: 0 })));
await t("Customer: negative total", "deny", () => setDoc(doc(anon, SHOP, "orders", "e" + ID), order({ total: -50 })));
await t("Customer: total as text", "deny", () => setDoc(doc(anon, SHOP, "orders", "f" + ID), order({ total: "300" })));
await t("Customer: no items", "deny", () => setDoc(doc(anon, SHOP, "orders", "g" + ID), order({ items: [] })));
await t("Customer: 31 items (spam)", "deny", () => setDoc(doc(anon, SHOP, "orders", "h" + ID), order({ items: Array(31).fill(order().items[0]) })));
await t("Customer: missing name", "deny", () => setDoc(doc(anon, SHOP, "orders", "i" + ID), omit(order(), "name")));
await t("Customer: 500-character name", "deny", () => setDoc(doc(anon, SHOP, "orders", "j" + ID), order({ name: "x".repeat(500) })));
await t("Customer: 5,000-character note", "deny", () => setDoc(doc(anon, SHOP, "orders", "k" + ID), order({ note: "x".repeat(5000) })));
await t("Customer: script in order code", "deny", () => setDoc(doc(anon, SHOP, "orders", "m" + ID), order({ code: "<b>x</b>" })));
await t("Customer: back-dated order time", "deny", () => setDoc(doc(anon, SHOP, "orders", "n" + ID), order({ createdAt: new Date("2020-01-01") })));
await t("Customer: short guessable order id", "deny", () => setDoc(doc(anon, SHOP, "orders", "abc"), order()));
await t("Customer: order id with script characters", "deny", () => setDoc(doc(anon, SHOP, "orders", `x" onmouseover="alert(1)" aaaaaaaaaa`), order()));
// --- Orders: paying
await t("Customer: send GCash reference", "allow", () => updateDoc(doc(anon, SHOP, "orders", ID2), { status: "payment_submitted", paymentRef: "5012345678901" }));
await t("Customer: change reference after sending", "deny", () => updateDoc(doc(anon, SHOP, "orders", ID2), { paymentRef: "9999999999" }));
await t("Customer: lower the total", "deny", () => updateDoc(doc(anon, SHOP, "orders", ID), { total: 1 }));
await t("Customer: mark own order ready", "deny", () => updateDoc(doc(anon, SHOP, "orders", ID), { status: "ready" }));
await t("Customer: add items while paying", "deny", () => updateDoc(doc(anon, SHOP, "orders", ID), { status: "payment_submitted", paymentRef: "5012345678901", total: 1 }));
await t("Customer: script in payment reference", "deny", () => updateDoc(doc(anon, SHOP, "orders", ID), { status: "payment_submitted", paymentRef: "<img src=x onerror=alert(1)>" }));
await t("Customer: too-short payment reference", "deny", () => updateDoc(doc(anon, SHOP, "orders", ID), { status: "payment_submitted", paymentRef: "123" }));
await t("Customer: pay an order that is already ready", "deny", () => updateDoc(doc(anon, SHOP, "orders", "ready00000000000000000"), { status: "payment_submitted", paymentRef: "5012345678901" }));
await t("Customer: delete an order", "deny", () => deleteDoc(doc(anon, SHOP, "orders", ID)));
await t("Signed-in non-staff: cancel someone's order", "deny", () => updateDoc(doc(stranger, SHOP, "orders", ID), { status: "cancelled" }));
// --- Everything else closed
await t("Anyone: write outside the shop", "deny", () => setDoc(doc(anon, "users", "x"), { a: 1 }));
await t("Signed-in non-staff: create another shop", "deny", () => setDoc(doc(stranger, "shops", "evil", "menu", "x"), { name: "x" }));
// --- Staff can do their job
await t("Staff: read and edit costs", "allow", () => setDoc(doc(staff, SHOP, "items", "milk"), { name: "Milk", packPrice: 99 }));
await t("Staff (email typed in capitals): read costs", "allow", () => getDoc(doc(staffCaps, SHOP, "items", "milk")));
await t("Staff: list orders", "allow", () => getDocs(collection(staff, SHOP, "orders")));
await t("Staff: move order to preparing", "allow", () => updateDoc(doc(staff, SHOP, "orders", ID), { status: "preparing" }));
await t("Staff: publish menu", "allow", () => setDoc(doc(staff, SHOP, "menu", "ia12"), { name: "Iced Americano", price: 120 }));
await t("Staff: open/close shop", "allow", () => updateDoc(doc(staff, SHOP, "settings", "public"), { open: false }));
await t("Second staff (Dionisio): list orders and edit costs", "allow", () => getDocs(collection(staff2, SHOP, "orders")).then(() => setDoc(doc(staff2, SHOP, "items", "milk"), { name: "Milk", packPrice: 98 })));
// --- Shop closed
await t("Customer: order while shop is closed", "deny", () => setDoc(doc(anon, SHOP, "orders", "p" + ID), order()));

const pass = results.filter(r => r.ok).length, fail = results.length - pass;
console.log(`\n${pass}/${results.length} security checks passed`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `### Database security: ${pass}/${results.length} passed\n\n| | Check |\n|---|---|\n` + results.map(r => `| ${r.ok ? "✅" : "❌"} | ${r.name} |`).join("\n") + "\n");
if (process.env.GITHUB_ACTIONS) { console.log(`::notice title=Database security::${pass}/${results.length} checks passed`); results.filter(r => !r.ok).forEach(r => console.log(`::error title=Security check failed::${r.name}`)); }
await env.cleanup();
process.exit(fail ? 1 : 0);
