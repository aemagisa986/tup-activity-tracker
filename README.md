# TUP University Activity Tracker

A web app for monitoring university projects and reporting annual or quarterly accomplishments against targets. Projects are grouped into Academic, Research, Community Extension, Production and Administration. Users register, create or join projects and post updates; administrators monitor every project, send queries, and produce reports.

You can run it two ways:

| | Where data is kept | Cost |
|---|---|---|
| **Online, on Render + Neon** (below) | A free PostgreSQL database at Neon | ₱0 |
| **On one computer in your office** (further below) | `data/db.json` next to `server.js` | ₱0 |

---

## Put it online for free (Render + Neon)

You'll create three free accounts: **GitHub** (holds the code), **Neon** (the database) and **Render** (runs the app). None of them needs a credit card. Allow about 20 minutes.

**What "free" means here**
- The app **sleeps after 15 minutes without visitors**. The next visitor waits about a minute while it wakes up. The page shows "Starting the tracker…" and opens by itself.
- Your data is safe while it sleeps. It's stored in Neon, not on Render.
- Neon's free plan includes 1 GB of storage, which is far more than this app needs for years of records.
- To remove the sleep, upgrade the Render service to a paid plan later. Nothing else changes.

### 1. Put the code on GitHub
1. Sign up or sign in at https://github.com.
2. Create a new repository (the **+** menu → **New repository**). Name it `tup-activity-tracker` and choose **Private**. Leave everything else as it is and click **Create repository**.
3. On the next page, click **uploading an existing file**. Drag in **everything inside this folder** (`server.js`, `storage.js`, `demo.js`, `package.json`, `package-lock.json`, `render.yaml`, and the `public` and `scripts` folders). Do not upload a `data` or `node_modules` folder.
4. Click **Commit changes**.

### 2. Create the database on Neon
1. Sign up at https://neon.com. Signing in with GitHub is quickest.
2. Create a project named `tup-tracker`. For the region, choose **AWS Asia Pacific (Singapore)**.
3. On the project dashboard, click **Connect**. Copy the connection string that starts with `postgresql://` and ends with `?sslmode=require`. Keep it private, because it contains the database password.

### 3. Run the app on Render
1. Sign up at https://render.com with **GitHub**, and allow Render to see the `tup-activity-tracker` repository.
2. Click **New → Blueprint** and pick the repository. Render reads `render.yaml` and proposes a free web service.
3. Fill in the three values it asks for:
   - **DATABASE_URL**: the Neon connection string from step 2.
   - **ADMIN_EMAIL**: your email. This account becomes the administrator when you register.
   - **ALLOWED_EMAIL_DOMAINS**: `tup.edu.ph`, so only university emails can register. Leave it empty to allow any email.
4. Click **Apply**. The first build takes 2–4 minutes. The service page then shows the address, like `https://tup-activity-tracker.onrender.com`.

### 4. First sign-in
Open the address. To explore first, sign in with the [demo accounts](#demo-accounts). For real use, **register with the ADMIN_EMAIL** you entered, remove the demo, and share the address with faculty and staff so they can register.

### Updating the app later
Upload the changed files to the GitHub repository. Render redeploys automatically, and your data stays in Neon.

### Moving data you already entered locally
If you used the tracker on your own computer first, you can copy that data into Neon:
1. In this folder on that computer, run `npm install`.
2. Windows:
   `set DATABASE_URL=postgresql://…your Neon string…` then `node scripts/import.js data\db.json`
   macOS/Linux:
   `DATABASE_URL='postgresql://…' node scripts/import.js data/db.json`
3. In Render, click **Manual Deploy → Restart service**. Everyone keeps their accounts and passwords.

---

## Run it on one computer instead

1. Install **Node.js 20 or newer** (the LTS version) from https://nodejs.org.
2. **Windows:** double-click `start-windows.bat`. **macOS/Linux:** run `sh start-mac-linux.sh`.
3. Open http://localhost:3000. Colleagues on the same network use the "On your network" address the window shows. Keep the window open while people use the tracker.

The first account registered becomes the administrator, unless `ADMIN_EMAIL` is set. Data is saved in `data/db.json`, with a daily copy in `data/backups/`.

---

## Demo accounts

To try every role, load the demo. It has five sample projects (one per category) with targets, budgets, expenses, a revised timeline, a catch-up activity, an open admin query, a concern from a user, and a pending join request.

| Role | Email | Password | What to try |
|---|---|---|---|
| Administrator | `admin@demo.tup.edu.ph` | `Admin@2026` | Admin page, reports, answer the bakery concern, send queries |
| Project leader | `leader@demo.tup.edu.ph` | `Leader@2026` | Reply to the "Q3 learners below target" query, revise dates |
| Project member | `member@demo.tup.edu.ph` | `Member@2026` | Leads the research project: approve Dan's join request |
| Ordinary user | `user@demo.tup.edu.ph` | `User@2026` | Browse all projects and ask to join one |

**Turning it on and off**
- **On Render:** `render.yaml` already sets `SEED_DEMO=1`, so the demo loads on first start. To remove it, change `SEED_DEMO` to `remove` under the service's **Environment**, save, and let it restart. Then delete the variable.
- **On your computer:** run `npm run demo` to add it, and `npm run demo:remove` to remove it. Stop the server first, or restart it afterwards.

Removing the demo deletes the demo accounts, the demo projects and anything posted on them. Real accounts and projects are not touched. Anything created in a demo project is marked so it goes with it.

> **Remove the demo before real use.** Anyone who knows these passwords can sign in, including as an administrator.

## Backups

Administrators can click **Admin → Download backup** at any time. The file contains every project, update, budget record and account, so store it somewhere private. To restore it into an empty database, use `node scripts/import.js tracker-backup-YYYY-MM-DD.json`. Add `--replace` to overwrite a database that already has data.

Neon's free plan also keeps a short history of the database that you can restore from in its dashboard.

## Settings

Set these as environment variables (on Render: the service → **Environment**).

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. When set, data goes to the database. When unset, it goes to `data/db.json`. |
| `ADMIN_EMAIL` | This email becomes the administrator when it registers. If unset, the first account registered becomes administrator. |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated, such as `tup.edu.ph`. Only these emails can register. |
| `PORT` | Port to listen on. Defaults to 3000, and `render.yaml` sets 10000. |
| `HOST` | Defaults to `0.0.0.0`. Use `127.0.0.1` to allow this computer only. |
| `DATA_DIR` | Folder for `db.json` in file mode. Defaults to `./data`. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy. This is automatic on Render. |
| `SEED_DEMO` | `1` loads the demo accounts at startup. `remove` deletes them. |

## Other hosts

- **Hostinger Node.js hosting** (from about ₱129/month on a long contract): create a Node.js app, point it at `server.js`, and either leave `DATABASE_URL` unset (data in `data/db.json`) or point it at a Neon database.
- **A VPS or university server:** run `npm ci --omit=dev && node server.js` behind nginx or Caddy for HTTPS. Use pm2 or systemd to keep it running.
- **Any host:** run a **single instance**. The app keeps its working copy in memory, so it must not be scaled to several copies.

## Who can do what

| | Administrator | Project leader | Project member | Other users |
|---|---|---|---|---|
| See all projects and reports | ✓ | ✓ | ✓ | ✓ |
| Create a project (becomes its leader) | ✓ | ✓ | ✓ | ✓ |
| Edit project details, sub-activities, targets, budget lines | ✓ | ✓ | | |
| Revise dates and add catch-up activities | ✓ | ✓ | | |
| Approve join requests, add or remove members | ✓ | ✓ | | |
| Post status updates, set progress, enter actuals, record expenses | ✓ | ✓ | ✓ | |
| Ask to join a project | | | | ✓ |
| Send queries and messages to project teams | ✓ | | | |
| Reply to queries, raise a concern with the admin | ✓ | ✓ | ✓ | |
| Post announcements, manage accounts, reset passwords, download backups | ✓ | | | |

The server checks these rules on every change. They aren't only hidden in the page.

## University seal

The seal is `public/logo.svg`. It appears in the header, on the sign-in screen, on printed reports and as the browser-tab icon. Replace that file to change it.

## Security notes

- Passwords are stored as scrypt hashes. Sessions last 14 days and are stored as hashes.
- Ten failed sign-ins from one address lock sign-in for 15 minutes.
- When the app is served over HTTPS, as on Render, cookies are marked Secure and browsers are told to use HTTPS only.
- Keep `DATABASE_URL` and downloaded backups private.
