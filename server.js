"use strict";
/*
 * University Activity Tracker — server
 * Runs on Node.js 18 or newer.
 *
 *   node server.js        → http://localhost:3000, data saved in ./data/db.json
 *
 * Settings (environment variables):
 *   DATABASE_URL           PostgreSQL connection string. When set, data is kept in the database
 *                          instead of a file (needed on hosts whose disk resets, e.g. Render free).
 *   ADMIN_EMAIL            This email becomes the administrator when it registers. If unset, the
 *                          first account registered becomes the administrator.
 *   ALLOWED_EMAIL_DOMAINS  Comma-separated list, e.g. "tup.edu.ph". Only these may register.
 *   PORT, HOST, DATA_DIR   Network port, bind address, folder for the data file.
 *   TRUST_PROXY            "1" when running behind a reverse proxy (set automatically on Render).
 *   SEED_DEMO              "1" adds demo accounts and sample projects at startup; "remove" deletes them.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { openStore } = require("./storage");
const { seedDemo, removeDemo } = require("./demo");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "") || !!process.env.RENDER;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || "").split(",").map(s => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_MS = 14 * 24 * 3600 * 1000;
const COOKIE = "uat_sid";

const COLLECTIONS = ["projects", "activities", "accomplishments", "targets", "budgetLines", "expenses",
  "revisions", "joinRequests", "threads", "posts", "announcements", "settings"];
const CHILDREN = ["activities", "accomplishments", "targets", "budgetLines", "expenses", "revisions", "joinRequests", "threads", "posts"];

/* ---------------- state & persistence ----------------
 * Everything lives in memory; each request marks the records it changed (touch) and
 * waits for commit(), which writes those records to the store before replying.
 */
let state = null, store = null, rev = 0;
const dirty = new Map();
const touch = (col, id) => dirty.set(col + "\u0000" + id, [col, id]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let saving = Promise.resolve();

function commit(notify = true) {
  if (notify) { rev++; broadcast(); }
  const batch = [...dirty.values()];
  dirty.clear();
  if (!batch.length) return saving;
  const run = saving.catch(() => {}).then(() => persist(batch));
  saving = run;
  return run;
}
async function persist(batch) {
  for (let attempt = 1; ; attempt++) {
    try { await store.save(state, batch); return; }
    catch (e) {
      console.error(`Saving failed (attempt ${attempt}):`, e.message);
      if (attempt >= 3) {
        batch.forEach(([c, i]) => touch(c, i)); // retried by the timer below
        throw new HttpError(503, "Your change is showing but couldn't be saved to the database yet. It will retry automatically. If this keeps happening, tell the administrator.");
      }
      await sleep(600 * attempt);
    }
  }
}
setInterval(() => { if (dirty.size) commit(false).catch(() => {}); }, 30000).unref();

function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(state.sessions)) if (!s || s.exp < now) { delete state.sessions[k]; touch("_sessions", k); }
}
setInterval(() => { if (state) { pruneSessions(); commit(false).catch(() => {}); } }, 3600 * 1000).unref();

/* ---------------- passwords & sessions ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
function checkPassword(pw, user) {
  const h = crypto.scryptSync(pw, user.salt, 64);
  const stored = Buffer.from(user.hash, "hex");
  return stored.length === h.length && crypto.timingSafeEqual(stored, h);
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const isHttps = req => !!req.socket.encrypted || (TRUST_PROXY && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
function setCookie(req, res, value, maxAgeSec) {
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${isHttps(req) ? "; Secure" : ""}`);
}
function newSession(req, res, uid) {
  const token = crypto.randomBytes(32).toString("hex");
  const key = sha(token);
  state.sessions[key] = { uid, exp: Date.now() + SESSION_MS };
  touch("_sessions", key);
  setCookie(req, res, token, SESSION_MS / 1000);
}
function dropSessions(uid, exceptKey) {
  for (const [k, s] of Object.entries(state.sessions)) if (s.uid === uid && k !== exceptKey) { delete state.sessions[k]; touch("_sessions", k); }
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function currentUser(req) {
  const t = getCookie(req, COOKIE); if (!t) return null;
  const s = state.sessions[sha(t)];
  if (!s || s.exp < Date.now()) return null;
  return state.users[s.uid] || null;
}
const clientIp = req => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "";

const failures = new Map();
function tooManyFailures(ip) { const f = failures.get(ip); return f && f.n >= 10 && f.until > Date.now(); }
function noteFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  if (f.until < Date.now()) f.n = 0;
  f.n++; f.until = Date.now() + 15 * 60 * 1000; failures.set(ip, f);
}
setInterval(() => { const now = Date.now(); for (const [k, f] of failures) if (f.until < now) failures.delete(k); }, 600000).unref();

/* ---------------- helpers ---------------- */
const isAdmin = u => u && u.role === "admin";
const P = id => state.data.projects[id];
const isLeader = (p, u) => !!p && p.leaderId === u.id;
const isMember = (p, u) => !!p && Array.isArray(p.memberIds) && p.memberIds.includes(u.id);
const canManage = (p, u) => !!p && (isAdmin(u) || isLeader(p, u));
const canUpdate = (p, u) => !!p && (canManage(p, u) || isMember(p, u));
const only = (b, keys) => Object.keys(b).every(k => keys.includes(k));
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && a.every(x => b.includes(x));
const str = (v, max = 500) => String(v == null ? "" : v).trim().slice(0, max);
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const domainAllowed = e => !ALLOWED_DOMAINS.length || ALLOWED_DOMAINS.some(d => e.endsWith("@" + d) || e.endsWith("." + d));

function publicUser(u, viewer) {
  const out = { id: u.id, fullName: u.fullName, office: u.office, position: u.position, phone: u.phone,
    role: u.role, active: u.active !== false, registeredAt: u.registeredAt };
  if (isAdmin(viewer) || viewer.id === u.id) out.email = u.email;
  return out;
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const deny = msg => { throw new HttpError(403, msg || "You don't have permission to change this."); };

/* ---------------- permission rules per collection ----------------
 * create(u, body): throw to refuse; may set server-owned fields on body
 * update(u, doc, patch): return true to allow (patch may be trimmed)
 * remove(u, doc): return true to allow
 */
function checkExpense(b, projectId, partial) {
  if (!partial || "amount" in b) {
    const a = Number(b.amount);
    if (!isFinite(a) || a <= 0) throw new HttpError(400, "Enter an amount above zero.");
    b.amount = Math.round(a * 100) / 100;
  }
  if (!partial || "lineId" in b) {
    const l = state.data.budgetLines[b.lineId];
    if (!l || l.projectId !== projectId) throw new HttpError(400, "Choose one of this project's line items.");
  }
}
function projectOf(b) { const p = P(b.projectId); if (!p) throw new HttpError(400, "That project no longer exists."); return p; }
const RULES = {
  projects: {
    create(u, b) {
      b.createdBy = u.id; b.createdAt = Date.now(); b.memberIds = [];
      b.leaderId = isAdmin(u) && b.leaderId && state.users[b.leaderId] ? b.leaderId : u.id;
    },
    update(u, p, b) {
      delete b.createdBy; delete b.createdAt;
      if (canManage(p, u)) {
        if ("leaderId" in b) {
          if (!isAdmin(u)) delete b.leaderId;
          else if (b.leaderId && !state.users[b.leaderId]) throw new HttpError(400, "Choose a registered user as leader.");
        }
        if ("memberIds" in b) {
          if (!Array.isArray(b.memberIds)) throw new HttpError(400, "Invalid member list.");
          b.memberIds = [...new Set(b.memberIds.filter(id => state.users[id]))];
        }
        return true;
      }
      if (isMember(p, u)) {
        if (only(b, ["status"])) return true;
        if (only(b, ["memberIds"]) && sameSet(b.memberIds, p.memberIds.filter(x => x !== u.id))) return true; // leaving
      }
      return false;
    },
    remove: (u, p) => canManage(p, u)
  },
  activities: {
    create(u, b) { if (!canManage(projectOf(b), u)) deny(); b.createdAt = Date.now(); },
    update(u, d, b) { delete b.projectId; const p = P(d.projectId); return canManage(p, u) || (canUpdate(p, u) && only(b, ["progress"])); },
    remove: (u, d) => canManage(P(d.projectId), u)
  },
  accomplishments: {
    create(u, b) { if (!canUpdate(projectOf(b), u)) deny(); b.by = u.id; b.createdAt = Date.now(); },
    update(u, d, b) { delete b.projectId; delete b.by; const p = P(d.projectId); return canManage(p, u) || (canUpdate(p, u) && d.by === u.id); },
    remove: (u, d) => { const p = P(d.projectId); return canManage(p, u) || (canUpdate(p, u) && d.by === u.id); }
  },
  targets: {
    create(u, b) { if (!canManage(projectOf(b), u)) deny(); b.createdAt = Date.now(); },
    update(u, d, b) { delete b.projectId; const p = P(d.projectId); return canManage(p, u) || (canUpdate(p, u) && only(b, ["a"])); },
    remove: (u, d) => canManage(P(d.projectId), u)
  },
  budgetLines: {
    create(u, b) { if (!canManage(projectOf(b), u)) deny(); b.createdAt = Date.now(); },
    update(u, d, b) { delete b.projectId; return canManage(P(d.projectId), u); },
    remove: (u, d) => canManage(P(d.projectId), u)
  },
  expenses: {
    create(u, b) { if (!canUpdate(projectOf(b), u)) deny(); checkExpense(b, b.projectId); b.by = u.id; b.createdAt = Date.now(); },
    update(u, d, b) { delete b.projectId; delete b.by; const p = P(d.projectId); checkExpense(b, d.projectId, true); return canManage(p, u) || (canUpdate(p, u) && d.by === u.id); },
    remove: (u, d) => { const p = P(d.projectId); return canManage(p, u) || (canUpdate(p, u) && d.by === u.id); }
  },
  revisions: {
    create(u, b) { if (!canManage(projectOf(b), u)) deny(); b.by = u.id; b.at = Date.now(); },
    update: (u) => isAdmin(u),
    remove: (u) => isAdmin(u)
  },
  joinRequests: {
    create(u, b) {
      const p = projectOf(b);
      if (isLeader(p, u) || isMember(p, u)) throw new HttpError(400, "You're already on this project.");
      const dup = Object.values(state.data.joinRequests).some(r => r.projectId === p.id && r.uid === u.id && r.status === "pending");
      if (dup) throw new HttpError(400, "You already asked to join this project.");
      b.uid = u.id; b.status = "pending"; b.at = Date.now(); b.note = str(b.note, 1000);
    },
    update: (u, d, b) => canManage(P(d.projectId), u) && only(b, ["status", "decidedAt"]) && ["approved", "declined"].includes(b.status),
    remove: (u, d) => isAdmin(u) || d.uid === u.id
  },
  threads: {
    create(u, b) {
      const p = projectOf(b);
      if (b.kind === "concern") { if (!canUpdate(p, u)) deny(); }
      else if (!["query", "message"].includes(b.kind) || !isAdmin(u)) deny("Only administrators can send queries and messages.");
      b.createdBy = u.id; b.byAdmin = isAdmin(u); b.createdAt = b.lastAt = Date.now(); b.closed = false;
      b.awaiting = b.kind === "query" ? "user" : b.kind === "concern" ? "admin" : null;
    },
    update(u, d, b) {
      delete b.projectId; delete b.createdBy; delete b.kind;
      if (isAdmin(u)) return true;
      const p = P(d.projectId);
      if (canUpdate(p, u) && only(b, ["lastAt", "awaiting"]) && b.awaiting === "admin") return true;
      if (d.createdBy === u.id && only(b, ["closed", "awaiting"])) return true;
      return false;
    },
    remove: (u) => isAdmin(u)
  },
  posts: {
    create(u, b) {
      const t = state.data.threads[b.threadId];
      if (!t) throw new HttpError(400, "That conversation no longer exists.");
      if (t.closed) throw new HttpError(400, "This conversation is resolved. Reopen it to reply.");
      if (!isAdmin(u) && !canUpdate(P(t.projectId), u)) deny();
      b.projectId = t.projectId; b.from = u.id; b.asAdmin = isAdmin(u); b.at = Date.now(); b.text = str(b.text, 10000);
    },
    update: () => false,
    remove: (u) => isAdmin(u)
  },
  settings: {
    create(u, b) { if (!isAdmin(u)) deny("Only administrators can change report settings."); b.updatedBy = u.id; b.updatedAt = Date.now(); },
    update: (u, d, b) => { if (!isAdmin(u)) return false; b.updatedBy = u.id; b.updatedAt = Date.now(); return true; },
    remove: (u) => isAdmin(u)
  },
  announcements: {
    create(u, b) { if (!isAdmin(u)) deny(); b.by = u.id; b.createdAt = Date.now(); b.text = str(b.text, 2000); },
    update: (u) => isAdmin(u),
    remove: (u) => isAdmin(u)
  }
};

/* ---------------- live updates (Server-Sent Events) ---------------- */
const clients = new Set();
function broadcast() { for (const res of clients) res.write(`event: change\ndata: ${rev}\n\n`); }
setInterval(() => { for (const res of clients) res.write(`: ping\n\n`); }, 25000).unref();

/* ---------------- http plumbing ---------------- */
function send(res, status, obj, extraHeaders) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, "That's too much data in one request.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {}); }
      catch (e) { reject(new HttpError(400, "The request wasn't valid JSON.")); }
    });
    req.on("error", reject);
  });
}
function clean(b) {
  const out = {};
  for (const [k, v] of Object.entries(b)) if (k !== "id" && !k.startsWith("_") && !k.startsWith("$")) out[k] = v;
  return out;
}
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'"
};
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".webp": "image/webp", ".jpg": "image/jpeg" };

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)); } catch (e) { res.writeHead(400); return res.end(); }
  const file = path.join(PUBLIC_DIR, rel);
  const ok = file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
  if (!ok) {
    if (!path.extname(rel)) { res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" }); return fs.createReadStream(path.join(PUBLIC_DIR, "index.html")).pipe(res); }
    res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found");
  }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------------- routes ---------------- */
async function api(req, res, pathname) {
  const method = req.method;
  const ip = clientIp(req);
  if (method !== "GET" && req.headers["x-requested-with"] !== "uat") throw new HttpError(403, "Request blocked.");

  // ----- auth -----
  if (pathname === "/api/auth/status" && method === "GET")
    return send(res, 200, { hasUsers: Object.keys(state.users).length > 0, adminReserved: !!ADMIN_EMAIL, domains: ALLOWED_DOMAINS });
  if (pathname === "/api/auth/register" && method === "POST") {
    if (tooManyFailures(ip)) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.");
    const b = await readBody(req);
    const email = str(b.email, 200).toLowerCase(), password = String(b.password || "");
    if (!isEmail(email)) throw new HttpError(400, "Enter a valid email address.");
    if (!domainAllowed(email)) throw new HttpError(400, "Register with your university email (" + ALLOWED_DOMAINS.map(d => "@" + d).join(" or ") + ").");
    if (password.length < 8) throw new HttpError(400, "Use a password of at least 8 characters.");
    if (!str(b.fullName)) throw new HttpError(400, "Enter your full name.");
    if (!str(b.office)) throw new HttpError(400, "Enter your college or office.");
    if (Object.values(state.users).some(u => u.email === email)) { noteFailure(ip); throw new HttpError(409, "An account with this email already exists. Sign in instead."); }
    const makeAdmin = ADMIN_EMAIL ? email === ADMIN_EMAIL : Object.keys(state.users).length === 0;
    const id = crypto.randomUUID();
    state.users[id] = { id, email, ...hashPassword(password), role: makeAdmin ? "admin" : "user", active: true,
      fullName: str(b.fullName, 200), office: str(b.office, 200), position: str(b.position, 200), phone: str(b.phone, 50), registeredAt: Date.now() };
    touch("_users", id);
    newSession(req, res, id);
    await commit();
    return send(res, 201, { me: publicUser(state.users[id], state.users[id]) });
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    if (tooManyFailures(ip)) throw new HttpError(429, "Too many failed sign-ins. Wait 15 minutes and try again.");
    const b = await readBody(req);
    const email = str(b.email, 200).toLowerCase();
    const u = Object.values(state.users).find(x => x.email === email);
    if (!u || !checkPassword(String(b.password || ""), u)) { noteFailure(ip); throw new HttpError(401, "That email and password don't match an account."); }
    failures.delete(ip);
    newSession(req, res, u.id);
    await commit(false);
    return send(res, 200, { me: publicUser(u, u) });
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    const t = getCookie(req, COOKIE);
    if (t && state.sessions[sha(t)]) { delete state.sessions[sha(t)]; touch("_sessions", sha(t)); await commit(false); }
    setCookie(req, res, "", 0);
    return send(res, 200, { ok: true });
  }

  const u = currentUser(req);
  if (!u) throw new HttpError(401, "Please sign in.");
  if (pathname === "/api/me" && method === "GET") return send(res, 200, { me: publicUser(u, u) });
  if (u.active === false) throw new HttpError(403, "Your account is deactivated.");

  if (pathname === "/api/me" && method === "PATCH") {
    const b = await readBody(req);
    if (!str(b.fullName)) throw new HttpError(400, "Enter your full name.");
    Object.assign(u, { fullName: str(b.fullName, 200), office: str(b.office, 200), position: str(b.position, 200), phone: str(b.phone, 50) });
    touch("_users", u.id); await commit();
    return send(res, 200, { me: publicUser(u, u) });
  }
  if (pathname === "/api/me/password" && method === "POST") {
    const b = await readBody(req);
    if (!checkPassword(String(b.current || ""), u)) throw new HttpError(400, "Your current password is incorrect.");
    if (String(b.next || "").length < 8) throw new HttpError(400, "Use a new password of at least 8 characters.");
    Object.assign(u, hashPassword(String(b.next)));
    touch("_users", u.id);
    dropSessions(u.id, sha(getCookie(req, COOKIE)));
    await commit(false);
    return send(res, 200, { ok: true });
  }

  if (pathname === "/api/data" && method === "GET") {
    const data = {};
    COLLECTIONS.forEach(c => { data[c] = Object.values(state.data[c]); });
    return send(res, 200, { rev, me: publicUser(u, u), members: Object.values(state.users).map(x => publicUser(x, u)), data });
  }
  if (pathname === "/api/events" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 3000\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // ----- administration -----
  if (pathname === "/api/admin/backup" && method === "GET") {
    if (!isAdmin(u)) deny("Only administrators can download backups.");
    const day = new Date().toISOString().slice(0, 10);
    return send(res, 200, { format: "uat-backup", version: 1, exportedAt: new Date().toISOString(), users: state.users, data: state.data },
      { "Content-Disposition": `attachment; filename="tracker-backup-${day}.json"` });
  }
  let m = pathname.match(/^\/api\/users\/([\w-]+)(\/password)?$/);
  if (m) {
    if (!isAdmin(u)) deny("Only administrators can manage accounts.");
    const target = state.users[m[1]]; if (!target) throw new HttpError(404, "That account doesn't exist.");
    const b = await readBody(req);
    if (m[2] && method === "POST") {
      if (String(b.password || "").length < 8) throw new HttpError(400, "Use a password of at least 8 characters.");
      Object.assign(target, hashPassword(String(b.password)));
      touch("_users", target.id); dropSessions(target.id);
      await commit(false);
      return send(res, 200, { ok: true });
    }
    if (!m[2] && method === "PATCH") {
      if (target.id === u.id) throw new HttpError(400, "You can't change your own access. Ask another administrator.");
      if ("active" in b) target.active = !!b.active;
      if ("role" in b) target.role = b.role === "admin" ? "admin" : "user";
      touch("_users", target.id);
      if (target.active === false) dropSessions(target.id);
      await commit();
      return send(res, 200, { member: publicUser(target, u) });
    }
  }

  // ----- collections -----
  m = pathname.match(/^\/api\/c\/(\w+)(?:\/([\w-]+))?$/);
  if (m && COLLECTIONS.includes(m[1])) {
    const col = m[1], id = m[2], rule = RULES[col], docs = state.data[col];
    if (method === "POST" && !id) {
      const b = clean(await readBody(req));
      rule.create(u, b);
      const nid = crypto.randomUUID();
      docs[nid] = { ...b, id: nid };
      touch(col, nid); await commit();
      return send(res, 201, { id: nid, doc: docs[nid] });
    }
    const doc = id && docs[id];
    if (!doc) throw new HttpError(404, "That record no longer exists.");
    if (method === "PATCH") {
      const b = clean(await readBody(req));
      if (!rule.update(u, doc, b)) deny();
      Object.assign(doc, b);
      touch(col, id); await commit();
      return send(res, 200, { doc });
    }
    if (method === "DELETE") {
      if (!rule.remove(u, doc)) deny();
      delete docs[id]; touch(col, id);
      if (col === "projects") CHILDREN.forEach(c => { for (const [k, d] of Object.entries(state.data[c])) if (d.projectId === id) { delete state.data[c][k]; touch(c, k); } });
      if (col === "threads") for (const [k, d] of Object.entries(state.data.posts)) if (d.threadId === id) { delete state.data.posts[k]; touch("posts", k); }
      await commit();
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, "Unknown request.");
}

const server = http.createServer(async (req, res) => {
  Object.entries(SEC_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname === "/healthz") { res.writeHead(state ? 200 : 503, { "Content-Type": "text/plain" }); return res.end(state ? "ok" : "starting"); }
    if (!state) throw new HttpError(503, "The tracker is still starting. Try again in a few seconds.");
    if (pathname.startsWith("/api/")) await api(req, res, pathname);
    else if (req.method === "GET" || req.method === "HEAD") serveStatic(req, res, pathname);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: "Something went wrong on the server. Check the server log for details." });
  }
});

function dbHint(msg) {
  if (/password authentication failed/i.test(msg)) return "The database password in DATABASE_URL is wrong. In Neon, click Connect, copy the connection string again (with the password shown), and paste it into DATABASE_URL.";
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return "The database host in DATABASE_URL can't be found. Copy the connection string from Neon's Connect dialog again.";
  if (/does not exist/i.test(msg)) return "The database name in DATABASE_URL doesn't exist. Copy the connection string from Neon's Connect dialog again.";
  if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg)) return "The database didn't answer. Check that the Neon project is active and DATABASE_URL is complete.";
  if (/SSL|certificate/i.test(msg)) return "The secure connection to the database failed. Make sure DATABASE_URL ends with ?sslmode=require.";
  return "Check DATABASE_URL (or the data folder) and restart.";
}

async function start() {
  try { store = openStore({ databaseUrl: DATABASE_URL, dataDir: DATA_DIR }); }
  catch (e) { console.error("Can't start: " + e.message); process.exit(1); }
  for (let attempt = 1; ; attempt++) {
    try { state = await store.load(); break; }
    catch (e) {
      console.error(`Couldn't open ${store.describe()} (attempt ${attempt}): ${e.message}`);
      if (attempt >= 5) { console.error("Giving up. " + dbHint(e.message)); process.exit(1); }
      await sleep(3000 * attempt);
    }
  }
  COLLECTIONS.forEach(c => { state.data[c] = state.data[c] || {}; });
  pruneSessions();
  const seed = (process.env.SEED_DEMO || "").trim().toLowerCase();
  if (seed === "remove") { const n = removeDemo(state, touch); if (n) console.log(`Removed ${n} demo records.`); }
  else if (/^(1|true|yes)$/.test(seed) && seedDemo(state, touch)) console.log("Added demo accounts and sample projects (see README).");
  await commit(false).catch(e => console.error("Couldn't save at startup:", e.message));

  server.listen(PORT, HOST, () => {
    console.log("\nUniversity Activity Tracker is running.");
    if (process.env.RENDER_EXTERNAL_URL) console.log(`  Public address:     ${process.env.RENDER_EXTERNAL_URL}`);
    else {
      const nets = require("os").networkInterfaces();
      const lan = Object.values(nets).flat().filter(n => n && n.family === "IPv4" && !n.internal).map(n => n.address);
      console.log(`  On this computer:   http://localhost:${PORT}`);
      lan.forEach(a => console.log(`  On your network:    http://${a}:${PORT}`));
    }
    console.log(`  Data is saved in:   ${store.describe()}`);
    if (ALLOWED_DOMAINS.length) console.log(`  Registration open to: ${ALLOWED_DOMAINS.map(d => "@" + d).join(", ")}`);
    if (!Object.keys(state.users).length)
      console.log(ADMIN_EMAIL ? `\n  No accounts yet. ${ADMIN_EMAIL} becomes the administrator when it registers.` : "\n  No accounts yet. The first person to register becomes the administrator.");
    console.log("");
  });
}

async function shutdown() {
  server.close();
  for (const res of clients) res.end();
  try { await commit(false); await saving; } catch (e) { console.error("Some changes may not have been saved:", e.message); }
  await store.close().catch(() => {});
  process.exit(0);
}
["SIGINT", "SIGTERM"].forEach(sig => process.on(sig, shutdown));

start();
