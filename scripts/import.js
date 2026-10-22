"use strict";
/*
 * Copy tracker data into the database named by DATABASE_URL.
 *
 *   node scripts/import.js <file.json> [--replace]
 *
 * <file.json> is either data/db.json from a local installation, or a backup downloaded
 * from Admin → Download backup. People keep their accounts and passwords; they just
 * sign in again. Without --replace, the import stops if the database already has data.
 */
const fs = require("fs");
const path = require("path");
const { openStore, allRecords } = require("../storage");

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  const replace = args.includes("--replace");
  if (!file) { console.log("Usage: node scripts/import.js <db.json or backup.json> [--replace]"); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL to your database's connection string first."); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (!raw || typeof raw !== "object" || !raw.users || !raw.data) { console.error("That file isn't a tracker data file or backup."); process.exit(1); }
  const state = { users: raw.users, sessions: {}, data: raw.data };
  const n = [...allRecords(state)].length;
  const people = Object.keys(state.users).length;
  const projects = Object.keys(state.data.projects || {}).length;

  const store = openStore({ databaseUrl: process.env.DATABASE_URL });
  try {
    const existing = await store.count();
    if (existing && !replace) {
      console.error(`The database already holds ${existing} records. Run again with --replace to overwrite them with this file.`);
      process.exitCode = 1; return;
    }
    await store.replaceAll(state);
    console.log(`Imported ${people} accounts, ${projects} projects (${n} records in all) into ${store.describe()}.`);
    console.log("Restart the web service so it loads the imported data.");
  } finally { await store.close(); }
}
main().catch(e => { console.error("Import failed:", e.message); process.exit(1); });
