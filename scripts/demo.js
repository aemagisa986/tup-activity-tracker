"use strict";
/*
 * Add or remove the demo accounts and sample projects.
 *   node scripts/demo.js            add them (skipped if already there)
 *   node scripts/demo.js --remove   remove every demo record
 * Uses DATABASE_URL when set, otherwise data/db.json. Stop the server first (or restart it after).
 */
const path = require("path");
const { openStore } = require("../storage");
const { DEMO_ACCOUNTS, seedDemo, removeDemo } = require("../demo");

(async () => {
  const store = openStore({ databaseUrl: (process.env.DATABASE_URL || "").trim(), dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data")) });
  try {
    const state = await store.load();
    ["projects","activities","accomplishments","targets","budgetLines","expenses","revisions","joinRequests","threads","posts","announcements"].forEach(c => { state.data[c] = state.data[c] || {}; });
    const changed = [];
    const touch = (c, i) => changed.push([c, i]);
    if (process.argv.includes("--remove")) {
      const n = removeDemo(state, touch);
      await store.save(state, changed);
      console.log(n ? `Removed ${n} demo records from ${store.describe()}.` : "There was no demo data to remove.");
    } else if (seedDemo(state, touch)) {
      await store.save(state, changed);
      console.log(`Added demo data to ${store.describe()}. Sign in with:`);
      DEMO_ACCOUNTS.forEach(a => console.log(`  ${a.role === "admin" ? "Administrator " : "Project owner "} ${a.email.padEnd(24)} ${a.password}   (${a.fullName})`));
    } else console.log("Demo data is already there.");
    console.log("Restart the server if it's running so it picks up the change.");
  } finally { await store.close(); }
})().catch(e => { console.error("Failed:", e.message); process.exit(1); });
