"use strict";
/*
 * Storage backends.
 *   FileStore  – one JSON file (data/db.json). For your own computer, a VPS, or cPanel.
 *   PgStore    – PostgreSQL (Neon, Render, Supabase…). Used whenever DATABASE_URL is set.
 *
 * The server keeps everything in memory and tells the store which records changed.
 * Records are addressed as (collection, id); "_users" and "_sessions" hold accounts and logins.
 */
const fs = require("fs");
const path = require("path");

const emptyState = () => ({ users: {}, sessions: {}, data: {} });

function getRecord(state, col, id) {
  if (col === "_users") return state.users[id];
  if (col === "_sessions") return state.sessions[id];
  return state.data[col] ? state.data[col][id] : undefined;
}
function setRecord(state, col, id, doc) {
  if (col === "_users") state.users[id] = doc;
  else if (col === "_sessions") state.sessions[id] = doc;
  else (state.data[col] = state.data[col] || {})[id] = doc;
}
function* allRecords(state) {
  for (const [id, d] of Object.entries(state.users || {})) yield ["_users", id, d];
  for (const [id, d] of Object.entries(state.sessions || {})) yield ["_sessions", id, d];
  for (const [col, docs] of Object.entries(state.data || {}))
    for (const [id, d] of Object.entries(docs || {})) yield [col, id, d];
}

class FileStore {
  constructor(dir) { this.kind = "file"; this.dir = dir; this.file = path.join(dir, "db.json"); }
  describe() { return "file " + this.file; }
  async load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) return emptyState();
    const state = Object.assign(emptyState(), JSON.parse(fs.readFileSync(this.file, "utf8")));
    const bdir = path.join(this.dir, "backups");
    fs.mkdirSync(bdir, { recursive: true });
    const daily = path.join(bdir, "db-" + new Date().toISOString().slice(0, 10) + ".json");
    if (!fs.existsSync(daily)) fs.copyFileSync(this.file, daily);
    return state;
  }
  async save(state) {
    const json = JSON.stringify(state);
    const tmp = this.file + ".tmp";
    try { fs.writeFileSync(tmp, json); fs.renameSync(tmp, this.file); }
    catch (e) { fs.writeFileSync(this.file, json); }
  }
  async replaceAll(state) { return this.save(state); }
  async count() { return fs.existsSync(this.file) ? [...allRecords(await this.load())].length : 0; }
  async close() {}
}

class PgStore {
  constructor(url) {
    let Pool;
    try { ({ Pool } = require("pg")); }
    catch (e) { throw new Error('DATABASE_URL is set but the "pg" package is missing. Run "npm install" in the app folder first.'); }
    this.kind = "postgres";
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    const hasSslMode = /[?&]sslmode=/.test(url);
    this.host = (url.match(/@([^/:?]+)/) || [])[1] || "database";
    this.pool = new Pool({
      connectionString: url,
      ssl: !local && !hasSslMode ? { rejectUnauthorized: false } : undefined,
      max: 3,
      idleTimeoutMillis: 20000,        // let serverless databases (Neon) scale to zero
      connectionTimeoutMillis: 20000   // a sleeping Neon database takes a few seconds to wake
    });
    this.pool.on("error", e => console.error("Database connection error:", e.message));
  }
  describe() { return "PostgreSQL at " + this.host; }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS uat_records (
      col text NOT NULL, id text NOT NULL, doc jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (col, id))`);
  }
  async load() {
    await this.init();
    const state = emptyState();
    const r = await this.pool.query("SELECT col, id, doc FROM uat_records");
    for (const row of r.rows) setRecord(state, row.col, row.id, row.doc);
    return state;
  }
  async save(state, changed) {
    if (!changed || !changed.length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [col, id] of changed) {
        const doc = getRecord(state, col, id);
        if (doc) await client.query(
          `INSERT INTO uat_records (col, id, doc, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (col, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`, [col, id, JSON.stringify(doc)]);
        else await client.query("DELETE FROM uat_records WHERE col = $1 AND id = $2", [col, id]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
  }
  async replaceAll(state) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM uat_records");
      for (const [col, id, doc] of allRecords(state))
        await client.query("INSERT INTO uat_records (col, id, doc) VALUES ($1, $2, $3)", [col, id, JSON.stringify(doc)]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
  }
  async count() { await this.init(); return Number((await this.pool.query("SELECT count(*) AS n FROM uat_records")).rows[0].n); }
  async close() { await this.pool.end(); }
}

/* Accepts the connection string the way people tend to paste it: Neon shows it inside a
   psql command (psql 'postgresql://…'), and copies often carry quotes or a trailing space. */
function cleanDatabaseUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/postgres(?:ql)?:\/\/[^\s'"]+/i);
  if (!m) throw new Error("DATABASE_URL doesn't look like a PostgreSQL connection string. It should start with postgresql:// — in Neon, click Connect and copy only the connection string, not the psql command.");
  s = m[0];
  if (!/@[^/]+\//.test(s)) throw new Error("DATABASE_URL is missing the host or database name. Copy the full connection string from Neon's Connect dialog again.");
  return s;
}

function openStore({ databaseUrl, dataDir }) {
  const url = cleanDatabaseUrl(databaseUrl);
  return url ? new PgStore(url) : new FileStore(dataDir);
}

module.exports = { openStore, cleanDatabaseUrl, emptyState, getRecord, allRecords };
