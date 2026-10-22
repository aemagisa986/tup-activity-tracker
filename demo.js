"use strict";
/*
 * Demo accounts and sample projects, for trying the tracker out.
 * Every record created here carries demo: true so it can be removed again.
 *
 * Added when the server starts with SEED_DEMO=1, or with: node scripts/demo.js [--remove]
 */
const crypto = require("crypto");

const DEMO_ACCOUNTS = [
  { key: "admin",  email: "admin@demo.tup.edu.ph",  password: "Admin@2026",  role: "admin", fullName: "Dr. Ana Reyes",       office: "Planning and Development Office", position: "Director" },
  { key: "leader", email: "leader@demo.tup.edu.ph", password: "Leader@2026", role: "user",  fullName: "Prof. Ben Cruz",      office: "College of Industrial Education", position: "Associate Professor II" },
  { key: "member", email: "member@demo.tup.edu.ph", password: "Member@2026", role: "user",  fullName: "Engr. Carla Santos",  office: "College of Engineering",          position: "Assistant Professor IV" },
  { key: "user",   email: "user@demo.tup.edu.ph",   password: "User@2026",   role: "user",  fullName: "Mr. Dan Villanueva",  office: "College of Science",              position: "Instructor I" }
];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
const hasDemo = state => Object.values(state.users).some(u => u.email === DEMO_ACCOUNTS[0].email);

/* Adds the demo records. touch(col, id) is called for each one written. Returns false if already present. */
function seedDemo(state, touch) {
  if (hasDemo(state)) return false;
  const Y = new Date().getFullYear();
  const d = (m, day) => `${Y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const now = Date.now(), DAYMS = 86400000;
  const ids = {};
  const put = (col, doc) => {
    const id = crypto.randomUUID();
    const rec = { ...doc, id, demo: true };
    if (col === "_users") state.users[id] = rec; else (state.data[col] = state.data[col] || {})[id] = rec;
    touch(col, id);
    return id;
  };

  for (const a of DEMO_ACCOUNTS)
    ids[a.key] = put("_users", { email: a.email, ...hashPassword(a.password), role: a.role, active: true,
      fullName: a.fullName, office: a.office, position: a.position, phone: "", registeredAt: now - 40 * DAYMS });
  const { admin, leader, member, user } = ids;

  const project = (p) => put("projects", { createdAt: now - 30 * DAYMS, createdBy: p.leaderId, baseStart: p.start, baseEnd: p.end, ...p });
  const target = (pid, indicator, unit, q, a) => put("targets", { projectId: pid, indicator, unit, year: Y, q, a, createdAt: now });
  const line = (pid, cls, item, allocated) => put("budgetLines", { projectId: pid, cls, item, allocated, createdAt: now });
  const expense = (pid, lineId, date, particulars, ref, amount, by) => put("expenses", { projectId: pid, lineId, date, particulars, ref, amount, by, createdAt: now });
  const activity = (pid, name, start, end, progress, extra = {}) => put("activities", { projectId: pid, name, start, end, progress, baseStart: start, baseEnd: end, assignee: "", createdAt: now, ...extra });
  const update = (pid, date, text, by, extra = {}) => put("accomplishments", { projectId: pid, date, text, by, createdAt: now, ...extra });

  // 1. Community Extension — behind schedule, with a revision, a catch-up activity and an open query
  const p1 = project({ title: "(Demo) Barangay Literacy Program", category: "extension", unit: "College of Industrial Education", fundSource: "GAA " + Y,
    leaderId: leader, memberIds: [member], status: "ongoing", start: d(1, 15), end: d(12, 15),
    description: "Weekly reading sessions for Grade 1–3 learners in two partner barangays, with take-home modules for parents." });
  target(p1, "Learners reached", "learners", [30, 30, 40, 40], [28, 33, 25, 0]);
  target(p1, "Reading sessions held", "sessions", [12, 12, 12, 12], [12, 10, 8, 0]);
  const l1 = line(p1, "MOOE", "Learning materials and printing", 85000);
  const l2 = line(p1, "MOOE", "Snacks for learners", 40000);
  expense(p1, l1, d(3, 2), "Printing of 150 reading modules", "DV " + Y + "-03-114", 23450.5, leader);
  expense(p1, l2, d(6, 20), "Snacks, sessions 1–24", "OR 004521", 9800, member);
  const a1 = activity(p1, "Module development", d(1, 15), d(6, 15), 100, { baseEnd: d(4, 30), assignee: "Prof. Ben Cruz" });
  activity(p1, "Weekly reading sessions", d(2, 1), d(11, 30), 60, { assignee: "Engr. Carla Santos" });
  activity(p1, "Make-up sessions after flooding", d(10, 5), d(11, 15), 20, { catchUp: true });
  put("revisions", { projectId: p1, activityId: a1, kind: "revise", oldStart: d(1, 15), oldEnd: d(4, 30), newStart: d(1, 15), newEnd: d(6, 15), reason: "Module validation by the DepEd division office was delayed.", by: leader, at: now - 20 * DAYMS });
  put("revisions", { projectId: p1, activityId: null, kind: "catchup", newStart: d(10, 5), newEnd: d(11, 15), reason: "Recovers 4 sessions cancelled due to flooding in August.", by: leader, at: now - 10 * DAYMS });
  update(p1, d(7, 10), "Completed and printed all modules; 33 learners attended Q2 sessions.", leader, { progress: 100, activityId: a1 });
  const t1 = put("threads", { projectId: p1, subject: "Q3 learners below target", kind: "query", createdBy: admin, byAdmin: true, createdAt: now - 3 * DAYMS, lastAt: now - 3 * DAYMS, awaiting: "user", closed: false });
  put("posts", { threadId: t1, projectId: p1, from: admin, asAdmin: true, text: "Q3 shows 25 learners against a target of 40. Please explain the shortfall and the catch-up plan.", at: now - 3 * DAYMS });

  // 2. Research — on track, with a pending join request
  const p2 = project({ title: "(Demo) Rice Straw Biochar for Soil Remediation", category: "research", unit: "College of Engineering", fundSource: "Research Fund " + Y,
    leaderId: member, memberIds: [leader], status: "ongoing", start: d(2, 1), end: d(11, 30),
    description: "Produce biochar from rice straw and test its effect on heavy-metal uptake in demonstration plots." });
  target(p2, "Research papers submitted", "papers", [0, 1, 1, 1], [0, 1, 1, 0]);
  target(p2, "Field trials completed", "trials", [0, 2, 2, 0], [0, 2, 2, 0]);
  const l3 = line(p2, "CO", "Pyrolysis reactor", 150000);
  const l4 = line(p2, "MOOE", "Laboratory analysis", 60000);
  expense(p2, l3, d(3, 15), "Fabrication of pyrolysis reactor", "PO " + Y + "-0217", 142000, member);
  expense(p2, l4, d(7, 8), "Soil heavy-metal analysis, 24 samples", "OR 118834", 18500, member);
  activity(p2, "Literature review", d(2, 1), d(3, 15), 100);
  activity(p2, "Reactor fabrication", d(3, 1), d(5, 31), 100);
  activity(p2, "Field trials", d(6, 1), d(11, 30), 70);
  update(p2, d(9, 28), "Second field trial harvested; samples sent for analysis.", member);
  put("joinRequests", { projectId: p2, uid: user, note: "I can help with the statistical analysis of the trial data.", status: "pending", at: now - 1 * DAYMS });

  // 3. Academic
  const p3 = project({ title: "(Demo) OBE Curriculum Review – BS Mechanical Engineering", category: "academic", unit: "College of Engineering", fundSource: "GAA " + Y,
    leaderId: leader, memberIds: [], status: "ongoing", start: d(3, 1), end: d(12, 15),
    description: "Revise course syllabi to outcomes-based format ahead of the accreditation visit." });
  target(p3, "Syllabi revised to OBE format", "syllabi", [0, 10, 15, 15], [0, 12, 15, 6]);
  const l5 = line(p3, "MOOE", "Curriculum writeshops", 30000);
  expense(p3, l5, d(5, 22), "Writeshop venue and meals, 2 days", "DV " + Y + "-05-301", 21000, leader);
  activity(p3, "Writeshops", d(3, 1), d(9, 30), 100);
  activity(p3, "Peer review of syllabi", d(9, 1), d(12, 15), 40);

  // 4. Production — with a concern waiting for the admin
  const p4 = project({ title: "(Demo) Campus Bakery Income-Generating Project", category: "production", unit: "College of Industrial Technology", fundSource: "IGP " + Y,
    leaderId: member, memberIds: [], status: "ongoing", start: d(1, 2), end: d(12, 20),
    description: "Bakery run by Food Technology students supplying the campus canteen." });
  target(p4, "Gross sales", "₱ thousands", [50, 50, 60, 60], [48, 55, 61, 20]);
  const l6 = line(p4, "MOOE", "Raw ingredients", 120000);
  expense(p4, l6, d(9, 30), "Flour, sugar and butter, Jan–Sep", "Various ORs", 95000, member);
  activity(p4, "Daily production", d(1, 2), d(12, 20), 80);
  const t2 = put("threads", { projectId: p4, subject: "Request to realign ₱15,000 to equipment repair", kind: "concern", createdBy: member, byAdmin: false, createdAt: now - 2 * DAYMS, lastAt: now - 2 * DAYMS, awaiting: "admin", closed: false });
  put("posts", { threadId: t2, projectId: p4, from: member, asAdmin: false, text: "The deck oven needs a new thermostat. May we realign ₱15,000 from raw ingredients to repairs?", at: now - 2 * DAYMS });

  // 5. Administration
  const p5 = project({ title: "(Demo) ISO 9001:2015 Surveillance Audit Preparation", category: "admin", unit: "Planning and Development Office", fundSource: "GAA " + Y,
    leaderId: admin, memberIds: [], status: "ongoing", start: d(7, 1), end: d(11, 30),
    description: "Prepare all academic offices for the external surveillance audit." });
  target(p5, "Offices audit-ready", "offices", [0, 0, 6, 6], [0, 0, 5, 1]);
  activity(p5, "Internal quality audit", d(7, 1), d(8, 31), 100);
  activity(p5, "Document control review", d(9, 1), d(11, 15), 70);

  put("announcements", { text: "(Demo) Q4 accomplishment reports are due on December 15. Update your actuals and expenses before then.", by: admin, createdAt: now - 5 * DAYMS });
  return true;
}

/* Removes every demo record (and demo logins). */
function removeDemo(state, touch) {
  let n = 0;
  const demoUsers = new Set(Object.values(state.users).filter(u => u.demo).map(u => u.id));
  for (const [id, u] of Object.entries(state.users)) if (u.demo) { delete state.users[id]; touch("_users", id); n++; }
  for (const [k, s] of Object.entries(state.sessions)) if (demoUsers.has(s.uid)) { delete state.sessions[k]; touch("_sessions", k); }
  const demoProjects = new Set(Object.values(state.data.projects || {}).filter(p => p.demo).map(p => p.id));
  const demoThreads = new Set(Object.values(state.data.threads || {}).filter(t => t.demo || demoProjects.has(t.projectId)).map(t => t.id));
  for (const [col, docs] of Object.entries(state.data))
    for (const [id, doc] of Object.entries(docs))
      if (doc && (doc.demo || demoProjects.has(doc.projectId) || demoThreads.has(doc.threadId))) { delete docs[id]; touch(col, id); n++; }
  return n;
}

module.exports = { DEMO_ACCOUNTS, seedDemo, removeDemo, hasDemo };
