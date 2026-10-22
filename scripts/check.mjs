// Pre-deploy checks. Run locally with: node scripts/check.mjs
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const problems = [];
const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// 1. Setup values filled in
const config = read("public/config.js");
if (/PASTE_|your-project/.test(config)) problems.push("public/config.js still has placeholder values. Paste your Firebase web config.");
const rc = JSON.parse(read(".firebaserc"));
if (!rc.projects?.default || rc.projects.default === "your-project") problems.push(".firebaserc: set \"default\" to your Firebase project ID.");
const rules = read("firestore.rules");
if (rules.includes("your.email@gmail.com")) problems.push("firestore.rules: replace your.email@gmail.com with your Google email.");
const emails = [...(rules.match(/in \[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map(m => m[1]);
if (!emails.length) problems.push("firestore.rules: the staff email list is empty.");
for (const e of emails) if (e !== e.toLowerCase() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) problems.push(`firestore.rules: "${e}" should be a lowercase email address.`);

// 2. Scripts parse
const html = read("public/index.html");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
inline.forEach((code, i) => { try { new vm.Script(code, { filename: `index.html inline script ${i + 1}` }); } catch (e) { problems.push(`index.html script ${i + 1}: ${e.message}`); } });
for (const f of ["public/auth.js", "public/order.js", "public/config.js", "public/pwa.js", "public/sw.js"]) {
  const r = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: read(f), encoding: "utf8" });
  if (r.status !== 0) problems.push(`${f}: ${(r.stderr || "").split("\n").find(l => /Error/.test(l)) || "syntax error"}`);
}
for (const f of ["public/firebase.js", "public/firebase-public.js", "public/order.html"])
  if (!existsSync(new URL("../" + f, import.meta.url))) problems.push(`${f} is missing.`);

// 3. No private data or keys committed
// 3. Install-as-app manifest: valid JSON, icons exist
try {
  const m = JSON.parse(read("public/manifest.webmanifest"));
  for (const i of m.icons || []) if (!existsSync(new URL("../public" + i.src, import.meta.url))) problems.push(`manifest icon missing: ${i.src}`);
  if (!(m.icons || []).some(i => i.sizes === "512x512")) problems.push("manifest needs a 512x512 icon.");
} catch (e) { problems.push(`public/manifest.webmanifest: ${e.message}`); }
for (const f of ["drink-costing-backup.json", "service-account.json"])
  if (existsSync(new URL("../" + f, import.meta.url))) problems.push(`${f} must not be in the repository.`);

if (problems.length) { console.error("✗ Not ready to deploy:\n  - " + problems.join("\n  - ")); process.exit(1); }
console.log(`✓ Ready: config set, ${emails.length} staff email(s), ${inline.length + 5} scripts parse, app manifest OK.`);
