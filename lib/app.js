const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");

const store = require("./store");
const { requireLogin, requireRole, requireFeature, publicUser } = require("./auth");
const mailer = require("./mailer");
const ai = require("./ai");
const apollo = require("./apollo");
const outlook = require("./outlook");
const salesforce = require("./salesforce");
const unipile = require("./unipile");
const linkedinOauth = require("./linkedin_oauth");
const accountsGemPrompt = require("./accountsGemPrompt");

// Wraps an async route handler so a rejected promise becomes next(err)
// instead of an unhandled rejection (Express 4 doesn't do this itself).
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();

// The Chrome extension (chrome-extension://<id>) that captures LinkedIn/
// Sales Navigator profiles calls this API directly from its background
// service worker, using the SAME session cookie as whatever browser tab
// the user is already logged into this app with -- no separate extension
// login. That only works if (a) the server explicitly allows the
// extension's origin to make credentialed cross-origin requests, since
// browsers never send cookies cross-origin without both an explicit
// Access-Control-Allow-Origin echo AND Access-Control-Allow-Credentials,
// and (b) the session cookie itself is marked SameSite=None (see below) so
// the browser is willing to attach it to a cross-origin request at all.
// Restricting this to the chrome-extension: scheme (rather than a wildcard)
// keeps this from opening the API up to arbitrary websites.
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// Stateless, signed-cookie sessions. This (rather than server-side session
// storage) is what lets auth work identically whether the app is running
// as one long-lived local Node process or as a fresh serverless function
// on every request.
// SameSite=None + Secure only when actually deployed (Netlify, always
// HTTPS there) -- that's what lets the cookie ride along on the Chrome
// extension's cross-origin fetches above. Locally (`npm start`, plain
// http://localhost) a Secure cookie would just get silently dropped by the
// browser, breaking normal login, so local dev keeps the old Lax/non-secure
// behavior instead.
const ON_NETLIFY = process.env.USE_BLOBS === "true";
app.use(
  cookieSession({
    name: "trellis-session",
    secret: process.env.SESSION_SECRET || "trellis-dev-secret-change-me",
    maxAge: 1000 * 60 * 60 * 8,
    sameSite: ON_NETLIFY ? "none" : "lax",
    secure: ON_NETLIFY,
  })
);

app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- Auth ----------

app.post("/api/login", ah(async (req, res) => {
  const { email, password, remember } = req.body || {};
  const users = await store.all("users");
  const user = users.find((u) => u.email.toLowerCase() === String(email || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  req.session.userId = user.id;
  // cookie-session signs the cookie fresh on every response using whatever
  // maxAge is set on req.sessionOptions at that point -- mutating it here
  // (rather than the fixed 8h default set on the middleware itself) is what
  // makes "Remember me" actually keep someone signed in across browser
  // restarts instead of just for the rest of the day.
  if (remember) req.sessionOptions.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
  res.json({ user: publicUser(user) });
}));

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------- Forgot / reset password (self-serve, no login required) ----------
// Always responds with the same generic {ok:true} regardless of whether the
// email matched a real account -- otherwise this endpoint becomes a way to
// probe which work emails exist in the system. Tokens are single-use,
// expire in an hour, and any older unused token for the same user is
// cleared out when a new one is requested, so only the most recent reset
// link a person asked for is ever valid.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
// A brand-new user has no reason to be watching their inbox the instant an
// Admin clicks "Create user" the way someone who just clicked "Forgot
// password?" is -- so their first-time setup link stays valid for a week
// instead of the 1-hour window a live reset request gets.
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Shared by forgot-password and the new-user invite email below: clears out
// any older unused token for this user (so only the most recent link is ever
// valid) and issues a fresh one with the given lifetime.
async function createPasswordResetToken(userId, ttlMs) {
  const existing = await store.all("password_resets");
  for (const row of existing.filter((r) => r.user_id === userId && !r.used)) {
    await store.remove("password_resets", row.id);
  }
  const token = crypto.randomBytes(32).toString("hex");
  await store.insert("password_resets", {
    user_id: userId,
    token,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    used: false,
  });
  return token;
}

app.post("/api/auth/forgot-password", ah(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter your work email" });
  const users = await store.all("users");
  const user = users.find((u) => u.email.toLowerCase() === email);
  if (user) {
    const token = await createPasswordResetToken(user.id, RESET_TOKEN_TTL_MS);
    const link = `${mailer.appUrl()}/?reset=${token}`;
    // Awaited (not fire-and-forget) deliberately -- on Netlify, the
    // function's execution environment can freeze the moment the HTTP
    // response goes out, which was cutting an un-awaited sendMail off
    // mid-handshake before it ever reached Office 365. Wrapped in try/catch
    // so a slow or failed send still ends in the same generic {ok:true} the
    // route always returns (never reveals whether the email existed).
    try {
      await mailer.sendMail({
        to: user.email,
        subject: "Reset your SDR Outreach password",
        text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your SDR Outreach password. This link is valid for 1 hour:\n${link}\n\nIf you didn't request this, you can ignore this email -- your password won't change.`,
        html: `<p>Hi ${user.name},</p><p>Someone (hopefully you) asked to reset your SDR Outreach password. This link is valid for 1 hour:</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, you can ignore this email — your password won't change.</p>`,
      });
    } catch (err) {
      console.error("[auth] forgot-password send failed:", err.message);
    }
  }
  res.json({ ok: true });
}));

app.post("/api/auth/reset-password", ah(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing reset token" });
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const resets = await store.all("password_resets");
  const row = resets.find((r) => r.token === token);
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired — request a new one." });
  }
  const user = await store.find("users", row.user_id);
  if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired — request a new one." });
  await store.update("users", user.id, { password: bcrypt.hashSync(String(password), 8) });
  await store.update("password_resets", row.id, { used: true });
  res.json({ ok: true });
}));


// ---------- Users (for dropdowns / directory) ----------

app.get("/api/users", requireLogin, ah(async (req, res) => {
  res.json((await store.all("users")).map(publicUser));
}));

// ---------- Users: role-tiered management (Admin/Manager/User) ----------
// Three tiers, matching the org's actual reporting structure:
//   - Admin: sees and can edit every field on every user, always. Not
//     configurable -- an admin locking themselves out of their own user
//     list would be a real support headache with no real upside.
//   - Manager: sees themselves + whoever has them set as "Reports to"
//     (manager_id), and can edit whichever fields the field-permission
//     matrix below marks "edit" for the manager tier.
//   - Everyone else (sales_rep/hr/sub_admin -- the "user" tier): sees only
//     themselves, editable per that tier's row in the same matrix.
// FIELD_KEYS is the fixed set of profile fields this system understands --
// deliberately NOT extensible from the request body, so a client can't ask
// to grant/check permission on an arbitrary key that was never vetted.
const FIELD_KEYS = ["name", "email", "phone", "title", "manager_id", "role"];
const FIELD_PERMISSION_LEVELS = ["none", "view", "edit"];
const DEFAULT_FIELD_PERMISSIONS = {
  // A manager routinely fixes a typo'd name/email or updates a report's
  // title/phone, but changing who someone reports to or what role they
  // hold is an org-structure change -- defaulted to view-only so that stays
  // an admin decision unless an admin explicitly opens it up here.
  manager: { name: "edit", email: "edit", phone: "edit", title: "edit", manager_id: "view", role: "view" },
  // A person can keep their own contact details current without a ticket to
  // an admin, but can't rename themselves into someone else's identity,
  // reassign their own manager, or change their own role/permissions.
  user: { name: "view", email: "view", phone: "edit", title: "edit", manager_id: "view", role: "view" },
};

function roleTier(role) {
  if (role === "admin") return "admin";
  if (role === "manager") return "manager";
  return "user"; // sales_rep, hr, sub_admin
}

async function getFieldPermissions() {
  const rows = await store.all("field_permissions");
  const stored = rows.find((r) => r.id === 1);
  // Merge over the defaults field-by-field (not just tier-by-tail) so a
  // partially-saved or older row -- or a new field added to FIELD_KEYS down
  // the line -- can't leave a gap where a field silently has no permission
  // set at all.
  const merged = { manager: { ...DEFAULT_FIELD_PERMISSIONS.manager }, user: { ...DEFAULT_FIELD_PERMISSIONS.user } };
  if (stored) {
    for (const tier of ["manager", "user"]) {
      for (const key of FIELD_KEYS) {
        if (stored[tier] && FIELD_PERMISSION_LEVELS.includes(stored[tier][key])) {
          merged[tier][key] = stored[tier][key];
        }
      }
    }
  }
  return merged;
}

app.get("/api/field-permissions", requireLogin, ah(async (req, res) => {
  res.json(await getFieldPermissions());
}));

app.put("/api/field-permissions", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const body = req.body || {};
  const next = { manager: {}, user: {} };
  for (const tier of ["manager", "user"]) {
    const incoming = body[tier] || {};
    for (const key of FIELD_KEYS) {
      const level = incoming[key];
      if (!FIELD_PERMISSION_LEVELS.includes(level)) {
        return res.status(400).json({ error: `Invalid permission level for ${tier}.${key} (must be none/view/edit)` });
      }
      next[tier][key] = level;
    }
  }
  const rows = await store.all("field_permissions");
  const existing = rows.find((r) => r.id === 1);
  const saved = existing
    ? await store.update("field_permissions", 1, next)
    : await store.insert("field_permissions", next); // note: insert() assigns its own id (1, since the collection starts empty)
  res.json(saved);
}));

// ---------- Company profile ----------
// A single free-text blurb describing the sender's own company (not any
// prospect account) -- edited from the small logo button on the Accounts
// page. Any logged-in user can view/edit it (it's shared boilerplate, not
// per-user or security-sensitive like the field-permission matrix above).
// Folded into the AI draft-email / draft-sequence prompts as "About the
// sender's company" context so drafts on Contacts and Emailing can reference
// what we actually do, without the rep retyping it every time.
const COMPANY_PROFILE_MAX_LEN = 4000;

async function getCompanyProfile() {
  const rows = await store.all("company_profile");
  return rows[0] || { id: null, content: "" };
}

app.get("/api/company-profile", requireLogin, ah(async (req, res) => {
  res.json(await getCompanyProfile());
}));

app.put("/api/company-profile", requireLogin, ah(async (req, res) => {
  const content = String((req.body || {}).content || "").slice(0, COMPANY_PROFILE_MAX_LEN);
  const rows = await store.all("company_profile");
  const existing = rows[0];
  const saved = existing
    ? await store.update("company_profile", existing.id, { content })
    : await store.insert("company_profile", { content }); // insert() assigns its own id (1, since the collection starts empty)
  res.json(saved);
}));

// Scoped user list for the Settings > Users page specifically -- NOT the
// same as GET /api/users above, which stays a full unscoped directory
// because half the app (Owner columns/filters, the Assign-users dashboard
// modal, "Reports to" pickers) already depends on resolving any user's name
// from that list. Changing that endpoint's scope would ripple everywhere;
// this one is new and only feeds the Users management page.
app.get("/api/users/team", requireLogin, ah(async (req, res) => {
  const all = await store.all("users");
  let rows;
  if (req.user.role === "admin") rows = all;
  else if (req.user.role === "manager") rows = all.filter((u) => u.id === req.user.id || u.manager_id === req.user.id);
  else rows = all.filter((u) => u.id === req.user.id);
  res.json(rows.map(publicUser));
}));

// Assign a user's manager (reporting line) and/or role, or edit their
// profile fields. Three ways in:
//   - Admin, on anyone: full access to every field, unchanged from before.
//   - Manager, on themselves or a direct report: only the fields the
//     "manager" tier's row in the permission matrix marks "edit".
//   - Anyone else, on themselves only: only the fields the "user" tier's
//     row marks "edit".
// The field-level check happens server-side against the SAME matrix the
// frontend disables inputs from -- a client that stripped the `disabled`
// attribute and POSTed a field it isn't allowed to touch still gets
// rejected here, not just hidden in the UI.
app.put("/api/users/:id", requireLogin, ah(async (req, res) => {
  const target = await store.find("users", req.params.id);
  if (!target) return res.status(404).json({ error: "Not found" });
  const body = req.body || {};
  const isAdmin = req.user.role === "admin";
  const isSelf = target.id === req.user.id;
  const isManagerOfTarget = req.user.role === "manager" && target.manager_id === req.user.id;

  if (!isAdmin && !isSelf && !isManagerOfTarget) {
    return res.status(403).json({ error: "You don't have permission to edit this user." });
  }

  let allowedFields;
  if (isAdmin) {
    allowedFields = new Set(FIELD_KEYS);
  } else {
    const perms = await getFieldPermissions();
    const tier = req.user.role === "manager" ? "manager" : "user";
    allowedFields = new Set(FIELD_KEYS.filter((k) => perms[tier][k] === "edit"));
  }

  const attempted = FIELD_KEYS.filter((k) => k in body);
  const disallowed = attempted.filter((k) => !allowedFields.has(k));
  if (disallowed.length) {
    return res.status(403).json({ error: `You don't have permission to edit: ${disallowed.join(", ")}` });
  }
  // Hard safety net regardless of what the matrix says: nobody but an
  // existing admin can ever grant the admin role -- an org's field-
  // permission config shouldn't be able to become a privilege-escalation
  // path even if an admin later opens up "role" to manager-edit.
  if (!isAdmin && body.role === "admin") {
    return res.status(403).json({ error: "Only an Admin can grant the Admin role." });
  }

  const patch = {};
  if ("name" in body) {
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    patch.name = name;
  }
  if ("email" in body) {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "A valid email is required" });
    const users = await store.all("users");
    if (users.some((u) => u.id !== target.id && u.email.toLowerCase() === email)) {
      return res.status(400).json({ error: "A user with that email already exists" });
    }
    patch.email = email;
  }
  if ("phone" in body) patch.phone = body.phone || "";
  if ("title" in body) patch.title = body.title || "";
  if ("manager_id" in body) {
    const managerId = body.manager_id === null || body.manager_id === "" ? null : Number(body.manager_id);
    if (managerId === target.id) return res.status(400).json({ error: "A user can't be their own manager" });
    if (managerId !== null) {
      const manager = await store.find("users", managerId);
      if (!manager) return res.status(400).json({ error: "That manager doesn't exist" });
    }
    patch.manager_id = managerId;
  }
  if ("role" in body && body.role) {
    if (!["admin", "manager", "sales_rep", "hr", "sub_admin"].includes(body.role)) return res.status(400).json({ error: "Unknown role" });
    patch.role = body.role;
  }
  const updated = await store.update("users", target.id, patch);
  res.json(publicUser(updated));
}));

// Admin-only: create a brand-new login. There's no self-serve signup in
// this app -- every account before this route existed came from hardcoded
// seed data, so this is the only way a new person gets in going forward.
// The admin sets an initial password here and shares it with the person
// out-of-band, the same way the seeded demo accounts' shared password was
// communicated.
app.post("/api/users", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const role = body.role;
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "A valid email is required" });
  // Password is now optional. Leave it blank (the default in the New User
  // form) and the new person gets emailed a "set up your password" link
  // instead of the admin having to invent one and share it directly. An
  // admin can still type a password in themselves -- e.g. SMTP isn't set up,
  // or the person's starting right now and can't wait on an email -- and
  // that works exactly as it always has.
  if (password && password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (!["admin", "manager", "sales_rep", "hr", "sub_admin"].includes(role)) return res.status(400).json({ error: "Unknown role" });
  const users = await store.all("users");
  if (users.some((u) => u.email.toLowerCase() === email)) {
    return res.status(400).json({ error: "A user with that email already exists" });
  }
  let managerId = null;
  if (body.manager_id !== undefined && body.manager_id !== null && body.manager_id !== "") {
    managerId = Number(body.manager_id);
    const manager = await store.find("users", managerId);
    if (!manager) return res.status(400).json({ error: "That manager doesn't exist" });
  }
  // No password supplied: the account still needs *some* hash to exist
  // against, so give it one nobody (not even the acting admin) ever sees --
  // it's unusable until the new person sets their own via the invite link.
  const initialPassword = password || crypto.randomBytes(24).toString("hex");
  const row = await store.insert("users", {
    name, email, phone: body.phone || "", title: body.title || "",
    password: bcrypt.hashSync(initialPassword, 8), role, manager_id: managerId,
  });

  let mail = { sent: false, reason: "Admin set a password directly" };
  if (!password) {
    const token = await createPasswordResetToken(row.id, INVITE_TOKEN_TTL_MS);
    const link = `${mailer.appUrl()}/?reset=${token}`;
    try {
      mail = await mailer.sendMail({
        to: row.email,
        subject: "Set up your SDR Outreach password",
        text: `Hi ${row.name},\n\nAn account was just created for you on SDR Outreach. Set up your password here (this link is valid for 7 days):\n${link}\n\nOnce it's set, sign in at ${mailer.appUrl()} with this email address: ${row.email}`,
        html: `<p>Hi ${row.name},</p><p>An account was just created for you on SDR Outreach. Set up your password here (this link is valid for 7 days):</p><p><a href="${link}">${link}</a></p><p>Once it's set, sign in at <a href="${mailer.appUrl()}">${mailer.appUrl()}</a> with this email address: ${row.email}</p>`,
      });
    } catch (err) {
      mail = { sent: false, reason: err.message };
    }
  }

  res.status(201).json({ ...publicUser(row), email_notification: mail });
}));

// Admin-only: reset an existing user's password. A separate route (rather
// than folding it into the general PUT above) so a password change always
// requires its own explicit new value instead of riding along silently with
// an unrelated field edit.
app.put("/api/users/:id/password", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const target = await store.find("users", req.params.id);
  if (!target) return res.status(404).json({ error: "Not found" });
  const password = String((req.body || {}).password || "");
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  await store.update("users", target.id, { password: bcrypt.hashSync(password, 8) });
  res.json({ ok: true });
}));

// Admin-only: permanently remove a user. Deliberately gated behind the
// ACTING ADMIN'S OWN current password (like PUT /api/me/password), not just
// their session -- a destructive, irreversible action like this shouldn't
// go through on a session left open at an unlocked desk the way an
// already-authenticated click on a delete icon would. Two more guardrails
// beyond that: an admin can't delete their own account (self-lockout), and
// the last remaining admin can't be deleted (would leave nobody able to
// manage users, integrations, or access control at all).
app.delete("/api/users/:id", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const target = await store.find("users", req.params.id);
  if (!target) return res.status(404).json({ error: "Not found" });

  const password = String((req.body || {}).password || "");
  if (!password || !bcrypt.compareSync(password, req.user.password)) {
    return res.status(400).json({ error: "Your password is incorrect" });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }
  if (target.role === "admin") {
    const admins = (await store.all("users")).filter((u) => u.role === "admin");
    if (admins.length <= 1) {
      return res.status(400).json({ error: "Can't delete the only remaining Admin." });
    }
  }

  const ok = await store.remove("users", target.id);
  if (!ok) return res.status(404).json({ error: "Not found" });

  // Clean up references so nothing dangles on a deleted user's id: direct
  // reports lose their "reports to" line (same treatment as unlinking
  // contacts when their account is deleted, above), and records they owned
  // fall back to unowned rather than silently pointing at someone who no
  // longer exists.
  const id = target.id;
  const remainingUsers = await store.all("users");
  for (const u of remainingUsers.filter((u) => u.manager_id === id)) {
    await store.update("users", u.id, { manager_id: null });
  }
  for (const collection of ["accounts", "contacts", "leads"]) {
    const rows = await store.all(collection);
    for (const r of rows.filter((r) => r.owner_id === id)) {
      await store.update(collection, r.id, { owner_id: null });
    }
  }
  const grants = await store.all("data_grants");
  for (const g of grants.filter((g) => g.grantee_id === id || g.target_id === id)) {
    await store.remove("data_grants", g.id);
  }

  res.json({ ok: true });
}));

// ---------- Access control: data grants + feature access (admin-only) ----------
// Two independent controls an Admin uses to build a Sub-Admin (or extend
// anyone else's visibility) without touching the org-hierarchy-based
// Manager mechanism:
//   - Data grants: "grantee can see target's records" -- exact person to
//     exact person, many-to-many, used by resolveScopeAllowedIds()
//     everywhere records get scoped (dashboard, leads, contacts, accounts,
//     leave requests, activity reports).
//   - Feature access: per-user on/off switches for whole tabs/features
//     (Leads, Activity Report, Emailing, LinkedIn Search, Salesforce,
//     Accounts Gem), enforced by requireFeature() and mirrored in the
//     sidebar so a disabled tab doesn't even show up.

app.get("/api/data-grants", requireLogin, requireRole("admin"), ah(async (req, res) => {
  res.json(await store.all("data_grants"));
}));

app.post("/api/data-grants", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const granteeId = Number((req.body || {}).grantee_id);
  const targetId = Number((req.body || {}).target_id);
  if (!granteeId || !targetId) return res.status(400).json({ error: "grantee_id and target_id are required" });
  if (granteeId === targetId) return res.status(400).json({ error: "A user can't be granted their own data -- they already see it." });
  const [grantee, target] = await Promise.all([store.find("users", granteeId), store.find("users", targetId)]);
  if (!grantee) return res.status(400).json({ error: "Grantee user not found" });
  if (!target) return res.status(400).json({ error: "Target user not found" });
  const existing = (await store.all("data_grants")).find((g) => g.grantee_id === granteeId && g.target_id === targetId);
  if (existing) return res.status(200).json(existing); // idempotent -- already granted
  const row = await store.insert("data_grants", {
    grantee_id: granteeId, target_id: targetId, granted_by: req.user.id,
    created_at: new Date().toISOString(),
  });
  res.status(201).json(row);
}));

app.delete("/api/data-grants/:id", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const ok = await store.remove("data_grants", req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));

const FEATURE_KEYS = ["leads", "activity_report", "emailing", "linkedin_search", "salesforce", "accounts_gem"];

app.put("/api/users/:id/feature-access", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const target = await store.find("users", req.params.id);
  if (!target) return res.status(404).json({ error: "Not found" });
  const body = (req.body || {}).feature_access || {};
  const feature_access = {};
  for (const key of FEATURE_KEYS) feature_access[key] = body[key] !== false; // default true, opt-out only
  const updated = await store.update("users", target.id, { feature_access });
  res.json(publicUser(updated));
}));

// ---------- Dashboard stats (role-scoped) ----------
// Reps see only their own numbers. Managers default to themselves + their
// direct reports combined, but can ask for any subset of that team.
// Admins can ask for anyone. `user_ids` is always filtered down to what the
// requester is actually allowed to see server-side — the frontend selector
// is just a convenience, not the source of truth for access control.

function toDateStr(value) {
  return new Date(value).toISOString().slice(0, 10);
}

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dashboardPeriods() {
  const now = new Date();
  const today = toDateStr(now);
  const day = now.getUTCDay(); // 0 Sun .. 6 Sat
  const mondayOffset = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset));
  // Human-readable labels for whichever month/year the counts above are
  // actually bucketed by (derived from the same `today`, not recomputed
  // separately) so the Dashboard can show "Aug" / "2026" instead of the
  // generic "this month" / "this year".
  const monthLabel = MONTH_ABBREVIATIONS[Number(today.slice(5, 7)) - 1];
  const yearLabel = today.slice(0, 4);
  return {
    today,
    weekStart: toDateStr(monday),
    monthStart: `${today.slice(0, 7)}-01`,
    yearStart: `${today.slice(0, 4)}-01-01`,
    monthLabel,
    yearLabel,
  };
}

function dateFieldOf(record, field) {
  return record[field] ? String(record[field]).slice(0, 10) : null;
}

function countSince(rows, field, boundary) {
  return rows.filter((r) => {
    const d = dateFieldOf(r, field);
    return d && d >= boundary;
  }).length;
}

function sumSince(rows, dateField, numField, boundary) {
  return rows.reduce((total, r) => {
    const d = dateFieldOf(r, dateField);
    return d && d >= boundary ? total + (Number(r[numField]) || 0) : total;
  }, 0);
}

// Who a given user is allowed to see the data of. Three sources combine:
//  1. Themself, always.
//  2. Their direct reports, if they're a Manager (org-hierarchy based, via
//     each user's manager_id -- unchanged, existing behavior).
//  3. Explicit "data grants" an Admin has handed out -- exact-person
//     visibility that isn't tied to the org hierarchy at all. This is what
//     lets an Admin build a Sub-Admin (or hand a Manager/Sales Rep extra
//     visibility) by picking specific people, one at a time, rather than
//     everyone under someone in the reporting chain. The same grant can be
//     handed to more than one grantee -- an Admin can share one rep's data
//     with several sub-admins/managers at once.
// Returns `null` for Admin, meaning "no filter, see everything."
async function resolveScopeAllowedIds(req) {
  if (req.user.role === "admin") return null;
  const [users, grants] = await Promise.all([store.all("users"), store.all("data_grants")]);
  const ids = new Set([req.user.id]);
  if (req.user.role === "manager") {
    users.filter((u) => u.manager_id === req.user.id).forEach((u) => ids.add(u.id));
  }
  grants.filter((g) => g.grantee_id === req.user.id).forEach((g) => ids.add(g.target_id));
  return ids;
}

async function resolveDashboardScope(req) {
  const users = await store.all("users");
  const requested = String(req.query.user_ids || "")
    .split(",").map((s) => Number(s.trim())).filter(Boolean);

  const scopeIds = await resolveScopeAllowedIds(req);
  const allowed = scopeIds === null ? users.map((u) => u.id) : [...scopeIds];

  if (!requested.length) return allowed;
  const allowedSet = new Set(allowed);
  const filtered = requested.filter((id) => allowedSet.has(id));
  return filtered.length ? filtered : allowed;
}

app.get("/api/dashboard/stats", requireLogin, ah(async (req, res) => {
  const scopeIds = await resolveDashboardScope(req);
  const scopeSet = new Set(scopeIds);
  const { today, weekStart, monthStart, yearStart, monthLabel, yearLabel } = dashboardPeriods();

  const [sentEmails, leads, contacts, accounts, leaveRequests, activityReports, leaveTypes, sequences, enrollments] = await Promise.all([
    store.all("sent_emails"),
    store.all("leads"),
    store.all("contacts"),
    store.all("accounts"),
    store.all("leave_requests"),
    store.all("activity_reports"),
    store.all("leave_types"),
    store.all("sequences"),
    store.all("sequence_enrollments"),
  ]);

  const scopedEmails = sentEmails.filter((m) => m.sent && scopeSet.has(m.sent_by));
  const emails = {
    today: countSince(scopedEmails, "sent_at", today),
    week: countSince(scopedEmails, "sent_at", weekStart),
    month: countSince(scopedEmails, "sent_at", monthStart),
  };

  const scopedLeads = leads.filter((l) => scopeSet.has(l.bdm_assigned_id || l.created_by));
  const leadsStats = {
    today: countSince(scopedLeads, "created_at", today),
    week: countSince(scopedLeads, "created_at", weekStart),
    month: countSince(scopedLeads, "created_at", monthStart),
    year: countSince(scopedLeads, "created_at", yearStart),
  };

  const scopedContacts = contacts.filter((c) => scopeSet.has(c.owner_id));
  const contactsStats = {
    today: countSince(scopedContacts, "created_at", today),
    week: countSince(scopedContacts, "created_at", weekStart),
    month: countSince(scopedContacts, "created_at", monthStart),
  };

  const scopedAccounts = accounts.filter((a) => scopeSet.has(a.owner_id));
  const companiesStats = {
    today: countSince(scopedAccounts, "created_at", today),
    week: countSince(scopedAccounts, "created_at", weekStart),
    month: countSince(scopedAccounts, "created_at", monthStart),
  };
  const totalCompanies = scopedAccounts.length;

  const monthPrefix = today.slice(0, 7);
  const leaveThisMonth = leaveRequests.filter((r) => scopeSet.has(r.user_id) && String(r.start_date || "").slice(0, 7) === monthPrefix);
  const leave = {
    requests: leaveThisMonth.length,
    days: leaveThisMonth.reduce((s, r) => s + (r.days || 0), 0),
  };

  // Followups and new companies aren't tracked as their own records — they
  // come from the numbers reps already self-report daily in Activity
  // Reports (bucketed by the report's activity date, not when it was
  // submitted), same scoping as everything else above.
  const scopedActivity = activityReports.filter((r) => scopeSet.has(r.user_id));
  const followups = {
    today: sumSince(scopedActivity, "date", "emails_followups", today),
    week: sumSince(scopedActivity, "date", "emails_followups", weekStart),
    month: sumSince(scopedActivity, "date", "emails_followups", monthStart),
  };

  // Real follow-up cadence progress, driven by actual sends out of the
  // Emailing tab -- not self-reported. A sequence's `step_order` (1-5) maps
  // directly to "1st Followup" .. "5th Followup" on the Dashboard, so this
  // interlinks live: as soon as a sequence step goes out, it shows up here.
  // "Pending" is the other half of that interlink: active enrollments whose
  // `current_step` is queued up for this exact stage next -- i.e. contacts
  // who haven't received it yet, straight from the live sequence engine
  // rather than anything self-reported.
  const sequenceOwnerById = new Map(sequences.map((s) => [s.id, s.owner_id]));
  const scopedActiveEnrollments = enrollments.filter(
    (e) => e.status === "active" && scopeSet.has(sequenceOwnerById.get(e.sequence_id))
  );

  // Fresh Email: the one-off, non-sequence sends from /api/emailing/send
  // (step_order is null for those -- see that route) -- i.e. the actual
  // first-touch outreach, distinct from a sequence's own step 1. No
  // "pending" concept applies here since these aren't queued in a cadence,
  // so it's always 0 -- kept in the shape anyway so the Dashboard can
  // render this stage with the exact same card markup as the 5 below it.
  const freshEmailRows = scopedEmails.filter((m) => m.step_order === null || m.step_order === undefined);
  const freshEmailStage = {
    step: 0,
    today: countSince(freshEmailRows, "sent_at", today),
    week: countSince(freshEmailRows, "sent_at", weekStart),
    month: countSince(freshEmailRows, "sent_at", monthStart),
    total: freshEmailRows.length,
    pending: 0,
  };

  const followupStages = [1, 2, 3, 4, 5].map((step) => {
    const rows = scopedEmails.filter((m) => m.step_order === step);
    const pending = scopedActiveEnrollments.filter((e) => (e.current_step || 0) === step - 1).length;
    return {
      step,
      today: countSince(rows, "sent_at", today),
      week: countSince(rows, "sent_at", weekStart),
      month: countSince(rows, "sent_at", monthStart),
      total: rows.length,
      pending,
    };
  });

  // Top-of-dashboard glance cards. `leads_achieved_year` follows the same
  // role scope as everything above; `my_leave` is always the signed-in
  // user's own leave/WFH, regardless of what scope (or scope override) is in
  // play for the rest of the response — seeing your own remaining days
  // shouldn't change just because an admin is browsing someone else's
  // numbers.
  // Same scoping/reasoning as leads_achieved_year below, just against the
  // scopedContacts already computed near the top of this route for the
  // Activity panel's contacts_added stats -- no need to re-filter.
  const totalContacts = scopedContacts.length;
  const leadsAchievedYear = leads.filter((l) => scopeSet.has(l.bdm_assigned_id || l.created_by) && l.status === "approved" && dateFieldOf(l, "approved_at") >= yearStart).length;
  // Same "approved" definition as the yearly figure, just bucketed to the
  // current calendar month instead -- shown alongside it on the Dashboard
  // the same way Leaves/WFH show a month figure next to a year figure.
  const leadsAchievedMonth = leads.filter((l) => scopeSet.has(l.bdm_assigned_id || l.created_by) && l.status === "approved" && dateFieldOf(l, "approved_at") >= monthStart).length;

  // Leave and WFH are different things and shouldn't be added together --
  // identified by the leave type's explicit `is_wfh` flag where an admin has
  // set one, falling back to matching the type name for the seeded "Work
  // From Home" type (and any org that hasn't re-flagged their types yet).
  const leaveTypesById = new Map(leaveTypes.map((t) => [t.id, t]));
  const isWfhType = (typeId) => {
    const t = leaveTypesById.get(typeId);
    if (!t) return false;
    if (typeof t.is_wfh === "boolean") return t.is_wfh;
    return /work from home|\bwfh\b/i.test(t.name || "");
  };
  const myLeaveRequests = leaveRequests.filter((r) => r.user_id === req.user.id);
  const yearPrefix = today.slice(0, 4);
  const sumMyDays = (inMonth, wfh) => myLeaveRequests
    .filter((r) => isWfhType(r.leave_type_id) === wfh && String(r.start_date || "").slice(0, inMonth ? 7 : 4) === (inMonth ? monthPrefix : yearPrefix))
    .reduce((s, r) => s + (r.days || 0), 0);
  const myLeave = {
    leave: { month_days: sumMyDays(true, false), year_days: sumMyDays(false, false) },
    wfh: { month_days: sumMyDays(true, true), year_days: sumMyDays(false, true) },
  };

  res.json({
    scope_user_ids: scopeIds, emails, leads: leadsStats, contacts: contactsStats, leave, followups,
    total_contacts: totalContacts,
    total_companies: totalCompanies, companies: companiesStats,
    leads_achieved_year: leadsAchievedYear, leads_achieved_month: leadsAchievedMonth,
    my_leave: myLeave, period_labels: { month: monthLabel, year: yearLabel },
    followup_stages: followupStages, fresh_email_stage: freshEmailStage,
  });
}));

// Outreach sequence for a single contact: first-touch draft + 5 follow-ups
// in one AI call. Plus whatever extra
// context the rep types into the Contacts table's Auto-draft modal. Only
// generates -- the frontend does a separate PUT /api/contacts/:id to
// actually save draft_mode/draft_text/followups once the rep has reviewed
// (same generate-then-save split as the existing Draft with AI feature).
// Drafting features (this route, draft-stage, and draft-email) look for a
// provider specifically marked "used for drafting" first, so an admin can
// point outreach writing at a different provider than the one used for
// everything else (Quick Add, Account brief, etc). Falls back to the
// general `active` provider when no drafting-specific one is set, so an
// admin who never touches the new toggle sees no change in behavior.
// Structured Pitch & Persona (set from the Contact detail page) replaced
// the old free-text "IQ notes" as the primary source of per-contact
// drafting context -- this assembles the same kind of string IQ notes used
// to be, from whichever of the newer fields are filled in, and only falls
// back to iq_notes itself for contacts that still just have the legacy
// note and nothing else. Shared by every AI-drafting route so a change
// here (Pitch, persona, pitch type, or the fallback) updates all of them.
function contactIQContext(contact) {
  const parts = [];
  if (contact.pitch) parts.push(contact.pitch);
  if (contact.buying_committee_persona) parts.push(`Buying committee role: ${contact.buying_committee_persona}`);
  if (contact.pitch_type) parts.push(`Pitch angle: ${contact.pitch_type}`);
  if (!parts.length && contact.iq_notes) parts.push(contact.iq_notes);
  return parts.join("\n");
}

function pickDraftingProvider(rows) {
  return rows.find((r) => r.drafting_active && r.api_key && ai.PROVIDERS[r.provider])
    || rows.find((r) => r.active && r.api_key && ai.PROVIDERS[r.provider]);
}

app.post("/api/ai/draft-sequence", requireLogin, ah(async (req, res) => {
  const { contact_id, context } = req.body || {};
  const contact = await store.find("contacts", contact_id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  const rows = await store.all("integrations");
  const active = pickDraftingProvider(rows);
  if (!active) {
    return res.status(400).json({
      error: req.user.role === "admin"
        ? "No AI provider is configured yet — add an API key in Settings > Integrations."
        : "No AI provider is configured yet — ask an admin to add one in Settings > Integrations.",
    });
  }
  try {
    const companyProfile = await getCompanyProfile();
    const account = contact.account_id ? await store.find("accounts", contact.account_id) : null;
    const result = await ai.generateOutreachSequence({
      provider: active.provider,
      apiKey: active.api_key,
      contactName: `${contact.first_name} ${contact.last_name}`,
      title: contact.title,
      company: account?.name || "",
      industry: account?.industry || "",
      notes: [account?.notes, contactIQContext(contact)].filter(Boolean).join("\n"),
      context,
      senderCompanyInfo: companyProfile.content || "",
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `${ai.PROVIDERS[active.provider]?.label || active.provider} request failed: ${err.message}` });
  }
}));

// Stage-by-stage auto-draft: generates ONE stage's email (whichever the
// contact's Status is currently set to -- Fresh through 5th Followup), fed
// by the linked Account's industry/notes, this contact's own IQ notes, the
// sender's company profile, and every earlier stage's already-generated
// text (so a 2nd Followup actually reads and builds on the Fresh email and
// 1st Followup rather than being generated in isolation). Saves straight
// into the contact record (draft_text for Fresh, followups[n] for the
// numbered stages) and always marks draft_mode "auto", since this route
// only exists to be the "auto" path -- a rep who wants to hand-write instead
// uses the Manual draft modal, which never calls this.
app.post("/api/ai/draft-stage", requireLogin, ah(async (req, res) => {
  const { contact_id, context } = req.body || {};
  const contact = await store.find("contacts", contact_id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  const stage = contact.status || "Fresh";
  const stageIndex = ai.STAGE_ORDER.indexOf(stage);
  if (stageIndex === -1) {
    return res.status(400).json({ error: `Auto-draft only applies to the Fresh/Follow-up statuses, not "${stage}".` });
  }
  const rows = await store.all("integrations");
  const active = pickDraftingProvider(rows);
  if (!active) {
    return res.status(400).json({
      error: req.user.role === "admin"
        ? "No AI provider is configured yet — add an API key in Settings > Integrations."
        : "No AI provider is configured yet — ask an admin to add one in Settings > Integrations.",
    });
  }
  try {
    const companyProfile = await getCompanyProfile();
    const account = contact.account_id ? await store.find("accounts", contact.account_id) : null;
    const followups = Array.isArray(contact.followups) ? contact.followups : [];
    // Every stage strictly before this one that already has saved text,
    // oldest first -- this is what "chains" the sequence together.
    const priorEmails = [];
    if (stageIndex > 0 && contact.draft_text) priorEmails.push({ label: "Fresh", text: contact.draft_text });
    for (let i = 0; i < stageIndex - 1; i++) {
      if (followups[i]) priorEmails.push({ label: ai.STAGE_ORDER[i + 1], text: followups[i] });
    }
    const { subject, body } = await ai.generateStageEmail({
      provider: active.provider,
      apiKey: active.api_key,
      stage,
      contactName: `${contact.first_name} ${contact.last_name}`,
      title: contact.title,
      company: account?.name || "",
      industry: account?.industry || "",
      accountNotes: account?.notes || "",
      contactIQ: contactIQContext(contact),
      senderCompanyInfo: companyProfile.content || "",
      priorEmails,
      context,
    });
    const patch = { draft_mode: "auto" };
    if (stage === "Fresh") {
      patch.draft_text = body;
      patch.draft_subject = subject;
    } else {
      const followupSubjects = Array.isArray(contact.followup_subjects) ? contact.followup_subjects : [];
      const nextFollowups = [0, 1, 2, 3, 4].map((i) => followups[i] || "");
      const nextFollowupSubjects = [0, 1, 2, 3, 4].map((i) => followupSubjects[i] || "");
      nextFollowups[stageIndex - 1] = body;
      nextFollowupSubjects[stageIndex - 1] = subject;
      patch.followups = nextFollowups;
      patch.followup_subjects = nextFollowupSubjects;
    }
    const updated = await store.update("contacts", contact.id, patch);
    res.json({ contact: updated, stage, text: body, subject });
  } catch (err) {
    res.status(502).json({ error: `${ai.PROVIDERS[active.provider]?.label || active.provider} request failed: ${err.message}` });
  }
}));

// ---------- Contacts ----------

app.get("/api/contacts", requireLogin, ah(async (req, res) => {
  const contacts = await store.all("contacts");
  const allowed = await resolveScopeAllowedIds(req);
  // Contacts imported before ownership was tracked (or created without an
  // owner some other way) have no owner_id -- treat those as visible to
  // everyone rather than invisible to everyone once scoping went live.
  res.json(allowed ? contacts.filter((c) => !c.owner_id || allowed.has(c.owner_id)) : contacts);
}));

app.post("/api/contacts", requireLogin, ah(async (req, res) => {
  const { first_name, last_name, email, phone, title, location, linkedin_url, sales_navigator_url, account_id } = req.body || {};
  if (!first_name || !last_name) return res.status(400).json({ error: "First and last name are required" });
  // Every Contact must belong to an Account -- enforced here as a
  // defense-in-depth backstop behind the frontend's own required-field
  // check on the New Contact / Quick Add forms, so the rule holds even for
  // a direct API call. Message names the contact so the popup showing it
  // is specific about which record is missing an Account.
  if (!account_id) {
    return res.status(400).json({
      error: `Account name is missing for ${first_name} ${last_name}${email ? ` (${email})` : ""}.`,
    });
  }
  const row = await store.insert("contacts", {
    first_name,
    last_name,
    email: email || "",
    phone: phone || "",
    title: title || "",
    location: location || "",
    linkedin_url: linkedin_url || "",
    sales_navigator_url: sales_navigator_url || "",
    account_id: account_id ? Number(account_id) : null,
    owner_id: req.user.id,
    created_at: new Date().toISOString().slice(0, 10),
  });
  res.status(201).json(row);
}));

app.put("/api/contacts/:id", requireLogin, ah(async (req, res) => {
  const row = await store.update("contacts", req.params.id, req.body || {});
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

app.delete("/api/contacts/:id", requireLogin, requireRole("admin", "manager", "sub_admin"), ah(async (req, res) => {
  const contact = await store.find("contacts", req.params.id);
  if (!contact) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageOwnedRecord(req, contact.owner_id))) {
    return res.status(403).json({ error: "You can only delete contacts within your scope." });
  }
  await store.remove("contacts", req.params.id);
  res.json({ ok: true });
}));

// Bulk import from a CSV pasted/uploaded in the Contacts view. Contacts are
// matched by email (the one genuinely unique identifier here; first/last
// name alone isn't safe to dedupe on since real people share names). A row
// with no email always creates a new contact rather than guessing at a match.
app.post("/api/contacts/import", requireLogin, ah(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "No rows to import" });
  if (rows.length > 500) return res.status(400).json({ error: "Import is limited to 500 rows at a time" });

  const existingContacts = await store.all("contacts");
  const byEmail = new Map(existingContacts.filter((c) => c.email).map((c) => [c.email.toLowerCase(), c]));
  const importable = ["phone", "title", "location", "linkedin_url", "sales_navigator_url", "status"];
  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const firstName = String(r.first_name || "").trim();
    const lastName = String(r.last_name || "").trim();
    const email = String(r.email || "").trim();
    const lineNo = i + 2;
    if (!firstName || !lastName) { skipped++; errors.push(`Row ${lineNo}: missing first or last name — skipped`); continue; }

    // The "Account"/"Company" column matches an existing Account by name or
    // creates a new one. Every Contact needs an Account, so -- unlike a
    // missing phone/title/etc, which just leaves that field blank -- a
    // blank or unresolvable Account name skips the whole row rather than
    // importing an orphaned contact, while every other valid row still goes
    // through.
    const accountName = String(r.account || "").trim();
    if (!accountName) {
      skipped++;
      errors.push(`Row ${lineNo}: missing Account name for ${firstName} ${lastName}${email ? ` (${email})` : ""} — skipped`);
      continue;
    }
    const acct = await findOrCreateAccountByName(accountName, {}, req.user.id);
    if (!acct) {
      skipped++;
      errors.push(`Row ${lineNo}: couldn't resolve Account "${accountName}" for ${firstName} ${lastName}${email ? ` (${email})` : ""} — skipped`);
      continue;
    }

    const fields = { account_id: acct.id };
    for (const f of importable) {
      const v = r[f];
      if (v !== undefined && v !== null && String(v).trim() !== "") fields[f] = String(v).trim();
    }

    const existing = email ? byEmail.get(email.toLowerCase()) : null;
    if (existing) {
      const merged = await store.update("contacts", existing.id, fields);
      byEmail.set(email.toLowerCase(), merged);
      updated++;
    } else {
      const row = await store.insert("contacts", {
        first_name: firstName, last_name: lastName, email,
        phone: "", title: "", linkedin_url: "", sales_navigator_url: "",
        ...fields,
        owner_id: req.user.id,
        created_at: new Date().toISOString().slice(0, 10),
      });
      if (email) byEmail.set(email.toLowerCase(), row);
      created++;
    }
  }

  res.json({ created, updated, skipped, errors, total: rows.length });
}));

// ---------- Browser extension capture (LinkedIn / Sales Navigator) ----------
// Backs the Chrome extension that scrapes profile cards straight off
// LinkedIn/Sales Navigator pages and drops them into Contacts. The
// extension reuses whatever session cookie the user already has for this
// app (see the CORS + SameSite=None cookie settings above) -- there's no
// separate login inside the extension itself, so this route is just
// requireLogin like everything else, not a special unauthenticated surface.
//
// Each row finds-or-creates an Account by company name (same helper every
// other import path uses, so a company landing here converges with rows
// imported via CSV/Apollo/Salesforce), then matches an existing Contact by
// LinkedIn URL first (the one closest-to-unique signal scraping can
// produce), falling back to first+last name within that Account. Existing
// contacts are enriched, never clobbered -- a field the rep already filled
// in by hand (email, phone, a corrected title) is left alone; only blanks
// get filled, and the raw scrape (location/about/connection degree) is
// always refreshed into li_capture so the latest snapshot is on file.
function looksLikeLinkedInCompanyUrl(url) {
  return /linkedin\.com\/(?:sales\/)?company\//i.test(String(url || ""));
}

async function upsertContactFromCapture(row, ownerId) {
  const firstName = String(row.first_name || "").trim();
  const lastName = String(row.last_name || "").trim();
  if (!firstName && !lastName) {
    return { status: "skipped", error: "No name found on this card" };
  }

  let accountId = null;
  const companyName = String(row.company_name || "").trim();
  if (companyName) {
    const extra = {};
    if (row.company_url && looksLikeLinkedInCompanyUrl(row.company_url)) extra.sales_navigator_url = row.company_url;
    const account = await findOrCreateAccountByName(companyName, extra, ownerId);
    if (account) accountId = account.id;
  }

  const linkedinUrl = String(row.linkedin_url || "").trim();
  const contacts = await store.all("contacts");
  let existing = null;
  if (linkedinUrl) {
    existing = contacts.find((c) => (c.linkedin_url || "").toLowerCase() === linkedinUrl.toLowerCase());
  }
  if (!existing && firstName && lastName) {
    existing = contacts.find((c) =>
      c.first_name.toLowerCase() === firstName.toLowerCase() &&
      c.last_name.toLowerCase() === lastName.toLowerCase() &&
      (accountId ? c.account_id === accountId : true)
    );
  }

  const liCapture = {
    location: row.location || "",
    about: row.about || "",
    connection_degree: row.connection_degree || "",
    source: row.source || "",
    captured_at: new Date().toISOString(),
  };

  if (existing) {
    const patch = { li_capture: liCapture };
    if (!existing.title && row.title) patch.title = row.title;
    if (!existing.linkedin_url && linkedinUrl) patch.linkedin_url = linkedinUrl;
    if (!existing.account_id && accountId) patch.account_id = accountId;
    const updated = await store.update("contacts", existing.id, patch);
    return { status: "updated", contact: updated };
  }

  // Every Contact needs an Account -- an existing one just gets enriched
  // above regardless (it already has one, or gets one filled in if this
  // scrape happens to carry a company name it was missing), but a brand
  // new contact with no company name on the card is skipped rather than
  // created orphaned.
  if (!accountId) {
    return { status: "skipped", error: `Account name is missing for ${firstName} ${lastName}`.trim() + " — no company found on this card" };
  }

  const created = await store.insert("contacts", {
    first_name: firstName || "(Unknown)",
    last_name: lastName || "",
    email: "", phone: "",
    title: row.title || "",
    linkedin_url: linkedinUrl,
    sales_navigator_url: /sales\/(?:lead|people)\//i.test(linkedinUrl) ? linkedinUrl : "",
    account_id: accountId,
    li_capture: liCapture,
    owner_id: ownerId,
    created_at: new Date().toISOString().slice(0, 10),
  });
  return { status: "created", contact: created };
}

app.post("/api/extension/import-contacts", requireLogin, ah(async (req, res) => {
  const rows = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (!rows.length) return res.status(400).json({ error: "No contacts in request" });
  if (rows.length > 100) return res.status(400).json({ error: "Import is limited to 100 profiles at a time" });

  let created = 0, updated = 0, skipped = 0;
  const results = [];
  for (const row of rows) {
    try {
      const result = await upsertContactFromCapture(row, req.user.id);
      if (result.status === "created") created++;
      else if (result.status === "updated") updated++;
      else skipped++;
      results.push(result);
    } catch (err) {
      skipped++;
      results.push({ status: "skipped", error: err.message });
    }
  }
  res.json({ created, updated, skipped, results });
}));

// A Sales Navigator Account (company) page capture, as opposed to a person
// -- lands directly on Accounts via the same findOrCreateAccountByName
// helper every other import path uses (case-insensitive name match), so a
// company already on file from CSV/Apollo/Salesforce/a person capture
// converges onto that same record instead of duplicating it. Fields that
// are real Account columns (industry/website/address/sales_navigator_url)
// only fill in if currently blank, same no-clobber rule as everywhere
// else; the freeform extras (headcount, About paragraph) don't have their
// own columns so they're kept in an li_capture snapshot, refreshed on
// every capture, mirroring how the Contact capture route handles it.
app.post("/api/extension/import-account", requireLogin, ah(async (req, res) => {
  const row = req.body?.account || {};
  const name = String(row.name || "").trim();
  if (!name) return res.status(400).json({ error: "Company name is required" });

  const accountsBefore = await store.all("accounts");
  const existedBefore = accountsBefore.some((a) => a.name.toLowerCase() === name.toLowerCase());

  const extra = {};
  if (row.industry) extra.industry = String(row.industry).trim();
  if (row.website) extra.website = String(row.website).trim();
  if (row.location) extra.address = String(row.location).trim();
  if (row.sales_navigator_url) extra.sales_navigator_url = String(row.sales_navigator_url).trim();

  const account = await findOrCreateAccountByName(name, extra, req.user.id);
  if (!account) return res.status(500).json({ error: "Could not save account" });

  const liCapture = {
    about: row.about || "",
    employees: row.employees || "",
    location: row.location || "",
    source: row.source || "",
    captured_at: new Date().toISOString(),
  };
  const updated = await store.update("accounts", account.id, { li_capture: liCapture });

  res.json({ status: existedBefore ? "updated" : "created", account: updated || account });
}));

// ---------- Accounts ----------
// Companies a rep is prospecting/selling into. Contacts and Leads link back
// to an Account by id (account_id / account_linked_id); Salesforce, Apollo,
// and LinkedIn imports all find-or-create Accounts by (case-insensitive)
// name via findOrCreateAccountByName below, so the same company landing
// through three different import paths converges on one record rather than
// creating duplicates.

async function findOrCreateAccountByName(name, extra = {}, ownerId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const accounts = await store.all("accounts");
  const existing = accounts.find((a) => a.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    const fields = {};
    for (const [k, v] of Object.entries(extra)) {
      if (v && !existing[k]) fields[k] = v;
    }
    return Object.keys(fields).length ? store.update("accounts", existing.id, fields) : existing;
  }
  return store.insert("accounts", {
    name: trimmed, industry: "", website: "", phone: "", revenue: "", address: "", sales_navigator_url: "",
    ...extra,
    owner_id: ownerId || null,
    created_at: new Date().toISOString().slice(0, 10),
  });
}

app.get("/api/accounts", requireLogin, ah(async (req, res) => {
  const accounts = await store.all("accounts");
  const allowed = await resolveScopeAllowedIds(req);
  res.json(allowed ? accounts.filter((a) => !a.owner_id || allowed.has(a.owner_id)) : accounts);
}));

app.post("/api/accounts", requireLogin, ah(async (req, res) => {
  const { name, industry, website, phone, revenue, address, sales_navigator_url } = req.body || {};
  if (!name) return res.status(400).json({ error: "Account name is required" });
  const row = await store.insert("accounts", {
    name,
    industry: industry || "",
    website: website || "",
    phone: phone || "",
    revenue: revenue || "",
    address: address || "",
    sales_navigator_url: sales_navigator_url || "",
    owner_id: req.user.id,
    created_at: new Date().toISOString().slice(0, 10),
  });
  res.status(201).json(row);
}));

app.put("/api/accounts/:id", requireLogin, ah(async (req, res) => {
  const row = await store.update("accounts", req.params.id, req.body || {});
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

app.delete("/api/accounts/:id", requireLogin, requireRole("admin", "manager", "sub_admin"), ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageOwnedRecord(req, account.owner_id))) {
    return res.status(403).json({ error: "You can only delete accounts within your scope." });
  }
  const ok = await store.remove("accounts", req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  // Contacts linked to this account aren't deleted, just unlinked.
  const id = Number(req.params.id);
  const contacts = await store.all("contacts");
  for (const c of contacts.filter((c) => c.account_id === id)) {
    await store.update("contacts", c.id, { account_id: null });
  }
  res.json({ ok: true });
}));

// CSV/Apollo-list/LinkedIn-search imports all funnel through this one route
// -- rows are matched by case-insensitive name against existing Accounts
// (updating them) or create a new one.
app.post("/api/accounts/import", requireLogin, ah(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "No rows to import" });
  if (rows.length > 500) return res.status(400).json({ error: "Import is limited to 500 rows at a time" });

  const existingAccounts = await store.all("accounts");
  const byName = new Map(existingAccounts.map((a) => [a.name.toLowerCase(), a]));
  const importable = ["industry", "website", "phone", "revenue", "address", "sales_navigator_url"];
  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const name = String(r.name || "").trim();
    const lineNo = i + 2;
    if (!name) { skipped++; errors.push(`Row ${lineNo}: missing name — skipped`); continue; }

    const fields = {};
    for (const f of importable) {
      const v = r[f];
      if (v !== undefined && v !== null && String(v).trim() !== "") fields[f] = String(v).trim();
    }

    const existing = byName.get(name.toLowerCase());
    if (existing) {
      const merged = await store.update("accounts", existing.id, fields);
      byName.set(name.toLowerCase(), merged);
      updated++;
    } else {
      const row = await store.insert("accounts", {
        name, industry: "", website: "", phone: "", revenue: "", address: "", sales_navigator_url: "",
        ...fields,
        owner_id: req.user.id,
        created_at: new Date().toISOString().slice(0, 10),
      });
      byName.set(name.toLowerCase(), row);
      created++;
    }
  }

  res.json({ created, updated, skipped, errors, total: rows.length });
}));

// ---------- Account intelligence (brief, Auto Gen research, tech extract) ----------

async function getClaudeKey() {
  const rows = await store.all("integrations");
  const row = rows.find((r) => r.provider === "claude" && r.active && r.api_key);
  return row?.api_key || null;
}
function claudeNotConfiguredError(req) {
  return req.user.role === "admin"
    ? "Claude isn't configured — add and activate a Claude API key in Settings > Integrations."
    : "Claude isn't configured — ask an admin to add and activate a Claude API key in Settings > Integrations.";
}

app.post("/api/accounts/:id/brief", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const rows = await store.all("integrations");
  const active = rows.find((r) => r.active && r.api_key && ai.PROVIDERS[r.provider]);
  if (!active) {
    return res.status(400).json({
      error: req.user.role === "admin"
        ? "No AI provider is configured yet — add an API key in Settings > Integrations."
        : "No AI provider is configured yet — ask an admin to add one in Settings > Integrations.",
    });
  }
  const contacts = (await store.all("contacts"))
    .filter((c) => c.account_id === account.id)
    .map((c) => ({ name: `${c.first_name} ${c.last_name}`.trim(), title: c.title || "" }));
  try {
    const text = await ai.generateAccountBrief({
      provider: active.provider, apiKey: active.api_key,
      name: account.name, industry: account.industry, website: account.website,
      notes: account.notes, signals: account.signals, contacts,
    });
    const updated = await store.update("accounts", account.id, { brief: { text, generated_at: new Date().toISOString() } });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: `${ai.PROVIDERS[active.provider]?.label || active.provider} request failed: ${err.message}` });
  }
}));

app.post("/api/accounts/:id/research/section", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const apiKey = await getClaudeKey();
  if (!apiKey) return res.status(400).json({ error: claudeNotConfiguredError(req) });
  const { section } = req.body || {};
  try {
    const result = await ai.generateCompanyResearchSection({
      apiKey, name: account.name, website: account.website, industry: account.industry, sectionKey: section,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// Mirrors the client-side computeIntentScore in public/js/app.js exactly --
// duplicated rather than shared (no shared module between frontend/backend
// in this app) so /research/finalize can auto-(re)generate the Intent score
// server-side right after merging this research pass's tech-stack signals,
// the same way the manual "Regenerate from tech stack" button does it
// client-side against whatever's already saved.
const INTENT_ENTERPRISE_APPS = ["salesforce", "coupa", "workday", "oracle", "sap", "netsuite", "servicenow", "ariba"];
const INTENT_LEGACY_TOOLS = ["tosca", "uft", "qtp", "hp alm", "alm", "silk test", "rational functional tester", "rft"];
const INTENT_MODERN_TOOLS = ["playwright", "selenium", "cypress", "appium", "webdriverio", "testcafe"];

function computeIntentScoreServer(account) {
  const saas = (account.saas_apps || []).map((s) => String(s).toLowerCase());
  const tools = (account.tools || []).map((s) => String(s).toLowerCase());
  const matchAll = (list, keywords) => keywords.filter((kw) => list.some((item) => item.includes(kw)));
  const enterpriseHits = matchAll(saas, INTENT_ENTERPRISE_APPS);
  const legacyHits = matchAll(tools, INTENT_LEGACY_TOOLS);
  const modernHits = matchAll(tools, INTENT_MODERN_TOOLS);
  const largeQATeam = Boolean((account.signals || {}).largeQATeam);

  if (enterpriseHits.length >= 2) {
    return {
      score: Math.min(90 + (enterpriseHits.length - 2), 99),
      label: "Hot — multiple enterprise apps",
      factors: enterpriseHits.map((h) => `Uses ${h} (enterprise app)`),
    };
  }
  if (largeQATeam) {
    return {
      score: Math.min(80 + enterpriseHits.length * 2, 89),
      label: "Warm — large QA team",
      factors: ["Large QA team on file", ...enterpriseHits.map((h) => `Uses ${h} (enterprise app)`)],
    };
  }
  if (legacyHits.length) {
    return {
      score: Math.min(70 + (legacyHits.length - 1) * 3, 79),
      label: "Warm — legacy/commercial test tooling",
      factors: legacyHits.map((h) => `Uses ${h} (legacy/commercial test tool)`),
    };
  }
  if (modernHits.length) {
    return {
      score: Math.min(60 + (modernHits.length - 1) * 3, 69),
      label: "Cool — modern open-source test tooling",
      factors: modernHits.map((h) => `Uses ${h} (open-source test tool)`),
    };
  }
  return null;
}

app.post("/api/accounts/:id/research/finalize", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const { report_text, signals } = req.body || {};
  const s = signals || {};
  const saasApps = Array.from(new Set([...(account.saas_apps || []), ...(s.enterprise_apps || [])]));
  const tools = Array.from(new Set([...(account.tools || []), ...(s.legacy_test_tools || []), ...(s.modern_test_tools || [])]));
  const newSignals = { ...(account.signals || {}) };
  if (s.large_qa_team) newSignals.largeQATeam = true;

  const patch = {
    saas_apps: saasApps,
    tools,
    signals: newSignals,
    company_research: {
      text: report_text || "",
      generated_at: new Date().toISOString(),
      decision_makers: Array.isArray(s.decision_makers) ? s.decision_makers : [],
      opportunity_score: s.opportunity_score ?? null,
      opportunity_summary: s.opportunity_summary || "",
    },
  };
  const scoreResult = computeIntentScoreServer({ ...account, ...patch });
  if (scoreResult) {
    patch.intent_score = scoreResult.score;
    patch.intent_score_label = scoreResult.label;
    patch.intent_score_factors = scoreResult.factors;
    patch.intent_score_manual = false;
  }
  const updated = await store.update("accounts", account.id, patch);
  res.json(updated);
}));

app.post("/api/accounts/:id/research/extract-tech", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const apiKey = await getClaudeKey();
  if (!apiKey) return res.status(400).json({ error: claudeNotConfiguredError(req) });
  if (!account.company_research?.text) return res.status(400).json({ error: "Run Auto Gen research first." });
  try {
    const { saas_apps, tools } = await ai.extractTechStackFromReport({ apiKey, reportText: account.company_research.text });
    const existingSaas = new Set((account.saas_apps || []).map((s) => String(s).toLowerCase()));
    const existingTools = new Set((account.tools || []).map((s) => String(s).toLowerCase()));
    const addedSaas = saas_apps.filter((s) => !existingSaas.has(String(s).toLowerCase()));
    const addedTools = tools.filter((t) => !existingTools.has(String(t).toLowerCase()));
    const updated = await store.update("accounts", account.id, {
      saas_apps: [...(account.saas_apps || []), ...addedSaas],
      tools: [...(account.tools || []), ...addedTools],
    });
    res.json({ account: updated, added: { saas_apps: addedSaas, tools: addedTools } });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/accounts/:id/linkedin-research", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const apiKey = await getClaudeKey();
  if (!apiKey) return res.status(400).json({ error: claudeNotConfiguredError(req) });
  const { linkedin_url } = req.body || {};
  if (!linkedin_url) return res.status(400).json({ error: "Paste a LinkedIn URL first" });
  try {
    const result = await ai.generateLinkedInResearch({ apiKey, name: account.name, linkedinUrl: linkedin_url });
    const updated = await store.update("accounts", account.id, {
      linkedin_profile: { text: result.text, url: linkedin_url, generated_at: new Date().toISOString() },
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// ---------- Unipile (LinkedIn) ----------

async function getUnipileConfig() {
  const rows = await store.all("integrations");
  const row = rows.find((r) => r.provider === "unipile");
  if (!row?.api_key || !row?.dsn || !row?.account_id) return null;
  return { apiKey: row.api_key, dsn: row.dsn, accountId: row.account_id };
}
function unipileNotConfiguredError(req) {
  return req.user.role === "admin"
    ? "Unipile isn't configured — add the API key, DSN, and account ID in Settings > Integrations first."
    : "Unipile isn't configured — ask an admin to set it up in Settings > Integrations first.";
}
// Accepts either linkedin.com/company/<slug> or the Sales Navigator
// linkedin.com/sales/company/<id> form -- Unipile's API takes either as an
// "identifier".
function extractCompanyIdentifier(url) {
  const m = String(url || "").match(/linkedin\.com\/(?:sales\/)?company\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : "";
}

app.post("/api/integrations/unipile/test", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const cfg = await getUnipileConfig();
  if (!cfg) return res.status(400).json({ error: "Unipile isn't fully configured yet — fill in API key, DSN, and account ID first." });
  try {
    const accounts = await unipile.listAccounts({ apiKey: cfg.apiKey, dsn: cfg.dsn });
    const account = accounts.find((a) => String(a.id) === String(cfg.accountId));
    if (!account) return res.status(400).json({ error: `Connected to Unipile, but no account found matching ID ${cfg.accountId}.` });
    res.json({ account });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/accounts/:id/linkedin-company", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const cfg = await getUnipileConfig();
  if (!cfg) return res.status(400).json({ error: unipileNotConfiguredError(req) });
  const { linkedin_url } = req.body || {};
  const identifier = extractCompanyIdentifier(linkedin_url);
  if (!identifier) return res.status(400).json({ error: "Couldn't recognize that as a LinkedIn company URL." });
  try {
    const profile = await unipile.getCompanyProfile({ apiKey: cfg.apiKey, dsn: cfg.dsn, accountId: cfg.accountId, identifier });
    const updated = await store.update("accounts", account.id, {
      linkedin_company: { ...profile, profile_url: profile.profile_url || linkedin_url, generated_at: new Date().toISOString() },
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/accounts/:id/linkedin-key-people", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const cfg = await getUnipileConfig();
  if (!cfg) return res.status(400).json({ error: unipileNotConfiguredError(req) });
  const { keywords, persona_id, persona_title } = req.body || {};
  const companyName = account.linkedin_company?.name || account.name;
  try {
    const people = await unipile.searchKeyPeople({
      apiKey: cfg.apiKey, dsn: cfg.dsn, accountId: cfg.accountId, companyName, keywords, personaId: persona_id,
    });
    const updated = await store.update("accounts", account.id, {
      linkedin_key_people: {
        people, generated_at: new Date().toISOString(),
        keywords: keywords || "", persona_id: persona_id || "", persona_title: persona_title || "",
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/accounts/:id/linkedin-research-field", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const apiKey = await getClaudeKey();
  if (!apiKey) return res.status(400).json({ error: claudeNotConfiguredError(req) });
  const { field } = req.body || {};
  try {
    const result = await ai.generateSalesNavField({
      apiKey,
      companyName: account.linkedin_company?.name || account.name,
      website: account.linkedin_company?.website || account.website,
      industry: account.linkedin_company?.industry || account.industry,
      fieldKey: field,
    });
    const updated = await store.update("accounts", account.id, {
      linkedin_sales_nav_research: { ...(account.linkedin_sales_nav_research || {}), [field]: result.text },
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// ---------- LinkedIn Search (standalone page) ----------

app.get("/api/linkedin-search/personas", requireLogin, ah(async (req, res) => {
  const cfg = await getUnipileConfig();
  if (!cfg) return res.status(400).json({ error: unipileNotConfiguredError(req) });
  try {
    const personas = await unipile.listPersonas({ apiKey: cfg.apiKey, dsn: cfg.dsn, accountId: cfg.accountId });
    res.json({ personas });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/linkedin-search/company-profile", requireLogin, ah(async (req, res) => {
  const cfg = await getUnipileConfig();
  if (!cfg) return res.status(400).json({ error: unipileNotConfiguredError(req) });
  const { sales_navigator_url } = req.body || {};
  const identifier = extractCompanyIdentifier(sales_navigator_url);
  if (!identifier) return res.status(400).json({ error: "Couldn't recognize that as a LinkedIn company URL." });
  try {
    const profile = await unipile.getCompanyProfile({ apiKey: cfg.apiKey, dsn: cfg.dsn, accountId: cfg.accountId, identifier });
    res.json({ profile, sales_navigator_url });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/linkedin-search/ai-field", requireLogin, ah(async (req, res) => {
  const apiKey = await getClaudeKey();
  if (!apiKey) return res.status(400).json({ error: claudeNotConfiguredError(req) });
  const { field, company_name, website, industry } = req.body || {};
  try {
    const result = await ai.generateSalesNavField({ apiKey, companyName: company_name, website, industry, fieldKey: field });
    res.json({ text: result.text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/linkedin-search/companies", requireLogin, requireFeature("linkedin_search"), ah(async (req, res) => {
  const cfg = await getUnipileConfig();
  if (!cfg) return res.status(400).json({ error: unipileNotConfiguredError(req) });
  const { keywords } = req.body || {};
  try {
    const companies = await unipile.searchCompanies({ apiKey: cfg.apiKey, dsn: cfg.dsn, accountId: cfg.accountId, keywords });
    res.json({ companies });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/linkedin-search/people", requireLogin, requireFeature("linkedin_search"), ah(async (req, res) => {
  const cfg = await getUnipileConfig();
  if (!cfg) return res.status(400).json({ error: unipileNotConfiguredError(req) });
  const { keywords } = req.body || {};
  try {
    const people = await unipile.searchPeople({ apiKey: cfg.apiKey, dsn: cfg.dsn, accountId: cfg.accountId, keywords });
    res.json({ people });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.post("/api/linkedin-search/save", requireLogin, ah(async (req, res) => {
  const { sales_navigator_url, website, industry, company_name, about, headcount_insights } = req.body || {};
  const name = String(company_name || "").trim();
  if (!name) return res.status(400).json({ error: "No company name to save against" });
  const salesNavPatch = {};
  ["account_iq", "revenue_model", "strategic_priorities", "business_challenges", "competitive_landscape", "competitors"].forEach((k) => {
    if (req.body[k] !== undefined) salesNavPatch[k] = req.body[k];
  });
  const accounts = await store.all("accounts");
  const existing = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  let account, created = false;
  if (existing) {
    account = await store.update("accounts", existing.id, {
      sales_navigator_url: sales_navigator_url || existing.sales_navigator_url || "",
      website: existing.website || website || "",
      industry: existing.industry || industry || "",
      linkedin_company: { ...(existing.linkedin_company || {}), name: company_name, about: about || "", headcount_insights: headcount_insights || "" },
      linkedin_sales_nav_research: { ...(existing.linkedin_sales_nav_research || {}), ...salesNavPatch },
    });
  } else {
    account = await store.insert("accounts", {
      name, industry: industry || "", website: website || "", phone: "", revenue: "", address: "",
      sales_navigator_url: sales_navigator_url || "",
      linkedin_company: { name: company_name, about: about || "", headcount_insights: headcount_insights || "" },
      linkedin_sales_nav_research: salesNavPatch,
      owner_id: req.user.id,
      created_at: new Date().toISOString().slice(0, 10),
    });
    created = true;
  }
  res.json({ created, account });
}));

// ---------- LinkedIn OAuth (official "Sign In with LinkedIn") ----------

async function getLinkedinOauthAppConfig() {
  const rows = await store.all("integrations");
  return rows.find((r) => r.provider === "linkedin_oauth_app") || null;
}
function linkedinOauthRedirectUri() {
  return `${mailer.appUrl()}/api/linkedin-oauth/oauth/callback`;
}

app.get("/api/linkedin-oauth/app-config", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const row = await getLinkedinOauthAppConfig();
  res.json({
    configured: Boolean(row?.client_id && row?.client_secret),
    client_id_preview: maskKey(row?.client_id),
    redirect_uri: linkedinOauthRedirectUri(),
  });
}));

app.put("/api/linkedin-oauth/app-config", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const row = await getLinkedinOauthAppConfig();
  const { client_id, client_secret } = req.body || {};
  if (!client_id?.trim() && !row?.client_id) return res.status(400).json({ error: "Client ID is required the first time you set this up." });
  if (!client_secret && !row?.client_secret) return res.status(400).json({ error: "Client secret is required the first time you set this up." });
  const patch = { provider: "linkedin_oauth_app" };
  if (client_id?.trim()) patch.client_id = client_id.trim();
  if (client_secret) patch.client_secret = client_secret;
  const saved = row ? await store.update("integrations", row.id, patch) : await store.insert("integrations", patch);
  res.json({ configured: true, client_id_preview: maskKey(saved.client_id), redirect_uri: linkedinOauthRedirectUri() });
}));

app.get("/api/linkedin-oauth/status", requireLogin, ah(async (req, res) => {
  const appConfig = await getLinkedinOauthAppConfig();
  const rows = await store.all("linkedin_oauth_connections");
  const connection = rows.find((r) => r.user_id === req.user.id);
  res.json({
    app_configured: Boolean(appConfig?.client_id && appConfig?.client_secret),
    connected: Boolean(connection),
    profile: connection ? { name: connection.name, email: connection.email, picture: connection.picture, connected_at: connection.connected_at } : null,
  });
}));

app.get("/api/linkedin-oauth/oauth/start", requireLogin, ah(async (req, res) => {
  const appConfig = await getLinkedinOauthAppConfig();
  if (!appConfig?.client_id) return res.status(400).send("LinkedIn isn't set up for this organization yet — ask an admin to add the Developer app details first.");
  const state = require("crypto").randomBytes(16).toString("hex");
  req.session.linkedinOauthState = state;
  const url = linkedinOauth.buildAuthorizeUrl({ clientId: appConfig.client_id, redirectUri: linkedinOauthRedirectUri(), state });
  res.redirect(url);
}));

app.get("/api/linkedin-oauth/oauth/callback", requireLogin, ah(async (req, res) => {
  const { code, state, error, error_description } = req.query || {};
  if (error) return res.status(400).send(`LinkedIn declined the connection: ${error_description || error}`);
  if (!code || !state || state !== req.session.linkedinOauthState) {
    return res.status(400).send("LinkedIn login didn't come back with a valid state token — please try connecting again from LinkedIn Search.");
  }
  req.session.linkedinOauthState = null;
  const appConfig = await getLinkedinOauthAppConfig();
  if (!appConfig) return res.status(400).send("LinkedIn app configuration was cleared before the login finished — please try again.");
  try {
    const data = await linkedinOauth.exchangeCode({ clientId: appConfig.client_id, clientSecret: appConfig.client_secret, code, redirectUri: linkedinOauthRedirectUri() });
    const profile = await linkedinOauth.getUserInfo(data.access_token);
    const rows = await store.all("linkedin_oauth_connections");
    const existing = rows.find((r) => r.user_id === req.user.id);
    const patch = { user_id: req.user.id, name: profile.name || "", email: profile.email || "", picture: profile.picture || "", connected_at: new Date().toISOString() };
    if (existing) await store.update("linkedin_oauth_connections", existing.id, patch);
    else await store.insert("linkedin_oauth_connections", patch);
    res.redirect("/?integration=linkedin_connected");
  } catch (err) {
    res.status(502).send(`Couldn't finish connecting LinkedIn: ${err.message}`);
  }
}));

app.post("/api/linkedin-oauth/disconnect", requireLogin, ah(async (req, res) => {
  const rows = await store.all("linkedin_oauth_connections");
  const existing = rows.find((r) => r.user_id === req.user.id);
  if (existing) await store.remove("linkedin_oauth_connections", existing.id);
  res.json({ ok: true });
}));

// ---------- Salesforce ----------

async function getSalesforceRow() {
  const rows = await store.all("integrations");
  return rows.find((r) => r.provider === "salesforce") || null;
}
function salesforceRedirectUri() {
  return `${mailer.appUrl()}/api/salesforce/oauth/callback`;
}

app.get("/api/salesforce/status", requireLogin, ah(async (req, res) => {
  const row = await getSalesforceRow();
  res.json({
    configured: Boolean(row?.login_url && row?.client_id && row?.client_secret),
    connected: Boolean(row?.refresh_token),
    login_url: row?.login_url || "",
    client_id_preview: maskKey(row?.client_id),
    instance_url: row?.instance_url || "",
    connected_by: row?.connected_by || null,
    connected_at: row?.connected_at || null,
    redirect_uri: salesforceRedirectUri(),
  });
}));

app.put("/api/salesforce/config", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const { login_url, client_id, client_secret } = req.body || {};
  const row = await getSalesforceRow();
  if (!login_url?.trim()) return res.status(400).json({ error: "Login URL is required" });
  if (!client_id?.trim() && !row?.client_id) return res.status(400).json({ error: "Consumer Key is required the first time you set this up." });
  if (!client_secret && !row?.client_secret) return res.status(400).json({ error: "Consumer Secret is required the first time you set this up." });
  const patch = { provider: "salesforce", login_url: login_url.trim() };
  if (client_id?.trim()) patch.client_id = client_id.trim();
  if (client_secret) patch.client_secret = client_secret;
  const saved = row ? await store.update("integrations", row.id, patch) : await store.insert("integrations", patch);
  res.json({ ok: true, login_url: saved.login_url, client_id_preview: maskKey(saved.client_id) });
}));

app.get("/api/salesforce/oauth/start", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const row = await getSalesforceRow();
  if (!row?.client_id || !row?.client_secret) return res.status(400).send("Salesforce isn't configured yet — save Connected App details in Settings > Integrations first.");
  const state = require("crypto").randomBytes(16).toString("hex");
  req.session.sfOauthState = state;
  const url = salesforce.buildAuthorizeUrl({ loginUrl: row.login_url, clientId: row.client_id, redirectUri: salesforceRedirectUri(), state });
  res.redirect(url);
}));

app.get("/api/salesforce/oauth/callback", requireLogin, ah(async (req, res) => {
  const { code, state, error, error_description } = req.query || {};
  if (error) return res.status(400).send(`Salesforce declined the connection: ${error_description || error}`);
  if (!code || !state || state !== req.session.sfOauthState) {
    return res.status(400).send("Salesforce login didn't come back with a valid state token — please try connecting again from Settings.");
  }
  req.session.sfOauthState = null;
  const row = await getSalesforceRow();
  if (!row) return res.status(400).send("Salesforce configuration was cleared before the login finished — please try again.");
  try {
    const data = await salesforce.exchangeCode({ loginUrl: row.login_url, clientId: row.client_id, clientSecret: row.client_secret, code, redirectUri: salesforceRedirectUri() });
    await store.update("integrations", row.id, {
      refresh_token: data.refresh_token, instance_url: data.instance_url,
      connected_by: req.user.name, connected_at: new Date().toISOString(),
    });
    res.redirect("/?integration=salesforce_connected");
  } catch (err) {
    res.status(502).send(`Couldn't finish connecting Salesforce: ${err.message}`);
  }
}));

app.post("/api/salesforce/disconnect", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const row = await getSalesforceRow();
  if (row) await store.update("integrations", row.id, { refresh_token: null, instance_url: null, connected_by: null, connected_at: null });
  res.json({ ok: true });
}));

const SF_LOCAL_COLLECTION = { lead: "leads", account: "accounts", contact: "contacts" };

app.post("/api/salesforce/pull/:objectKey", requireLogin, requireFeature("salesforce"), ah(async (req, res) => {
  const { objectKey } = req.params;
  const collection = SF_LOCAL_COLLECTION[objectKey];
  if (!collection) return res.status(400).json({ error: "Unknown Salesforce object" });
  const row = await getSalesforceRow();
  try {
    const records = await salesforce.pullRecords(row, objectKey);
    const localRows = await store.all(collection);
    const linkedIds = new Set(localRows.filter((r) => r.sf_id).map((r) => r.sf_id));
    res.json({ records: records.map((r) => ({ ...r, _already_linked: linkedIds.has(r.Id) })) });
  } catch (err) {
    res.status(err.notConnected ? 400 : 502).json({ error: err.message });
  }
}));

app.post("/api/salesforce/import/:objectKey", requireLogin, ah(async (req, res) => {
  const { objectKey } = req.params;
  const body = req.body || {};
  const sfId = body.sf_id || body.Id;
  if (!sfId) return res.status(400).json({ error: "Missing Salesforce record ID" });

  if (objectKey === "account") {
    const existing = (await store.all("accounts")).find((a) => a.sf_id === sfId);
    const fields = { sf_id: sfId, name: body.Name || "Unnamed", industry: body.Industry || "", website: body.Website || "", phone: body.Phone || "" };
    const row = existing
      ? await store.update("accounts", existing.id, fields)
      : await store.insert("accounts", { ...fields, revenue: "", address: "", sales_navigator_url: "", owner_id: req.user.id, created_at: new Date().toISOString().slice(0, 10) });
    return res.status(201).json(row);
  }
  if (objectKey === "contact") {
    const existing = (await store.all("contacts")).find((c) => c.sf_id === sfId);
    let accountId = null;
    const accountName = body["Account.Name"] || (body.Account && body.Account.Name);
    if (accountName) {
      const acct = await findOrCreateAccountByName(accountName, {}, req.user.id);
      accountId = acct ? acct.id : null;
    }
    // Every Contact needs an Account. An existing (already-linked) contact
    // just gets enriched either way; a brand-new one with no Account.Name on
    // the Salesforce record is rejected -- the caller (importSelectedSfRecords
    // in app.js) already toasts each row's error individually, so this
    // naturally becomes the per-row "skipped, here's why" feedback without
    // needing a separate summary UI for this import path.
    if (!existing && !accountId) {
      return res.status(400).json({
        error: `Account name is missing for ${body.FirstName || ""} ${body.LastName || ""}`.trim() + (body.Email ? ` (${body.Email})` : "") + " — skipped",
      });
    }
    const fields = { sf_id: sfId, first_name: body.FirstName || "", last_name: body.LastName || "Unknown", title: body.Title || "", email: body.Email || "", phone: body.Phone || "" };
    if (accountId) fields.account_id = accountId;
    const row = existing
      ? await store.update("contacts", existing.id, fields)
      : await store.insert("contacts", { ...fields, linkedin_url: "", sales_navigator_url: "", owner_id: req.user.id, created_at: new Date().toISOString().slice(0, 10) });
    return res.status(201).json(row);
  }
  if (objectKey === "lead") {
    const existing = (await store.all("leads")).find((l) => l.sf_id === sfId);
    const contactPerson = [body.FirstName, body.LastName].filter(Boolean).join(" ");
    const fields = { sf_id: sfId, contact_person: contactPerson, company: body.Company || "" };
    const now = new Date().toISOString();
    const row = existing
      ? await store.update("leads", existing.id, fields)
      : await store.insert("leads", {
          ...fields, source: "Salesforce", date_received: now.slice(0, 10),
          bdm_assigned_id: req.user.id, contact_linked_id: null, designation: "", contact_location: "",
          linkedin_link: "", additional_guests: "", demo_date: "", website: "", revenue: "", industry: "", remarks: "",
          account_linked_id: null, sf_status: body.Status || "", sf_link: "",
          status: "pending", pending_changes: null, approved_by: null, approved_at: null,
          created_by: req.user.id, created_at: now, updated_at: now,
        });
    return res.status(201).json(row);
  }
  res.status(400).json({ error: "Unknown Salesforce object" });
}));

app.post("/api/accounts/:id/push-salesforce", requireLogin, ah(async (req, res) => {
  const account = await store.find("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const row = await getSalesforceRow();
  try {
    const sfId = await salesforce.pushRecord(row, "account", {
      sfId: account.sf_id,
      fields: { Name: account.name, Industry: account.industry || undefined, Website: account.website || undefined, Phone: account.phone || undefined },
    });
    const updated = await store.update("accounts", account.id, { sf_id: sfId });
    res.json(updated);
  } catch (err) {
    res.status(err.notConnected ? 400 : 502).json({ error: err.message });
  }
}));

app.post("/api/contacts/:id/push-salesforce", requireLogin, ah(async (req, res) => {
  const contact = await store.find("contacts", req.params.id);
  if (!contact) return res.status(404).json({ error: "Not found" });
  const row = await getSalesforceRow();
  try {
    const account = contact.account_id ? await store.find("accounts", contact.account_id) : null;
    const fields = { FirstName: contact.first_name, LastName: contact.last_name, Title: contact.title || undefined, Email: contact.email || undefined, Phone: contact.phone || undefined };
    if (account?.sf_id) fields.AccountId = account.sf_id;
    const sfId = await salesforce.pushRecord(row, "contact", { sfId: contact.sf_id, fields });
    const updated = await store.update("contacts", contact.id, { sf_id: sfId });
    res.json(updated);
  } catch (err) {
    res.status(err.notConnected ? 400 : 502).json({ error: err.message });
  }
}));

app.post("/api/leads/:id/push-salesforce", requireLogin, ah(async (req, res) => {
  const lead = await store.find("leads", req.params.id);
  if (!lead) return res.status(404).json({ error: "Not found" });
  const row = await getSalesforceRow();
  try {
    const [first, ...rest] = String(lead.contact_person || "").trim().split(/\s+/).filter(Boolean);
    const sfId = await salesforce.pushRecord(row, "lead", {
      sfId: lead.sf_id,
      fields: {
        FirstName: first || "Unknown", LastName: rest.join(" ") || "Unknown",
        Company: lead.company || "Unknown", Website: lead.website || undefined, Industry: lead.industry || undefined,
      },
    });
    const updated = await store.update("leads", lead.id, { sf_id: sfId });
    res.json(updated);
  } catch (err) {
    res.status(err.notConnected ? 400 : 502).json({ error: err.message });
  }
}));

// ---------- Accounts Gem ----------
// An SDR-agent workspace backed by Gemini/OpenAI/Claude (see
// lib/accountsGemPrompt.js for the system prompt). Prefers Gemini, then
// OpenAI, then Claude -- whichever has a configured key -- rather than
// going through the single "active" drafting provider, since this feature
// was deliberately pinned away from that shared toggle (see task history).
// Switched back to Gemini-first after the org's OpenAI key ran out of
// billing credits (platform.openai.com/settings/organization/billing) --
// add/refresh the Gemini key in Settings > Integrations to actually pick
// this path up; a present-but-dead OpenAI key would otherwise still win
// under an OpenAI-first order even though every call through it 429s.

app.post("/api/accounts-gem/run", requireLogin, requireFeature("accounts_gem"), ah(async (req, res) => {
  const { command, account, persona, known_signals, context, constraints, message } = req.body || {};
  const rows = await store.all("integrations");
  const order = ["gemini", "openai", "claude"];
  const row = order.map((p) => rows.find((r) => r.provider === p && r.api_key)).find(Boolean);
  if (!row) {
    return res.status(400).json({
      error: req.user.role === "admin"
        ? "No AI provider is configured yet — add an OpenAI, Gemini, or Claude API key in Settings > Integrations."
        : "No AI provider is configured yet — ask an admin to add one in Settings > Integrations.",
    });
  }
  const userMessage = [
    command ? `Command: ${command}` : "",
    account ? `Account: ${account}` : "",
    persona ? `Persona: ${persona}` : "",
    known_signals ? `Known signals: ${known_signals}` : "",
    context ? `Context: ${context}` : "",
    constraints ? `Constraints: ${constraints}` : "",
    message || "",
  ].filter(Boolean).join("\n");
  try {
    const text = await ai.runAccountsGem({ apiKey: row.api_key, systemPrompt: accountsGemPrompt.SYSTEM_PROMPT, userMessage, provider: row.provider });
    res.json({ text, provider: row.provider });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// ---------- Leads ----------
// Lead intake / demo tracking (replaces the old deal-stage Pipeline). No
// field is mandatory on create -- a BDM can start a record with just
// whatever they know from the first email and fill the rest in later.
// contact_linked_id is an optional pointer to an existing Contact (set by
// the "Link existing…" picker in the UI, which copies over fields like
// designation/LinkedIn link for free); Apollo auto-fill on the
// Contact-person and Company fields goes through the same
// /api/contacts/lookup-person and /api/accounts/lookup-company routes the
// Contact form and (formerly) Account form already used, rather than
// duplicating that logic.
//
// Approval workflow: a new lead starts "pending". An admin, or the manager
// of whoever the lead is assigned to, can Approve it directly, or edit
// fields directly at any time. Once approved, the assigned BDM (or whoever
// created it) can still edit the fields, but saving submits a
// "change_requested" state with the proposed values held in
// pending_changes -- the record itself doesn't change until an admin/manager
// reviews and approves (applies the pending_changes) or rejects (discards
// them, record stays as it was). This matches "once approved, the user can
// change data with permission from the admin or manager."

const LEAD_FIELDS = [
  "source", "date_received", "bdm_assigned_id",
  "contact_person", "contact_linked_id", "designation", "contact_location", "linkedin_link",
  "additional_guests", "demo_date",
  "company", "website", "revenue", "industry",
  "remarks",
  "account_linked_id", "sf_status", "sf_link",
];

function cleanLeadPatch(body) {
  const patch = {};
  for (const f of LEAD_FIELDS) {
    if (body[f] === undefined) continue;
    if (f === "bdm_assigned_id" || f === "contact_linked_id" || f === "account_linked_id") {
      patch[f] = body[f] === null || body[f] === "" ? null : Number(body[f]);
    } else {
      patch[f] = body[f] === null ? "" : String(body[f]);
    }
  }
  return patch;
}

function leadScopeKey(lead) {
  return lead.bdm_assigned_id || lead.created_by;
}

async function resolveLeadsAllowedIds(req) {
  return resolveScopeAllowedIds(req); // null == no filter (admin)
}

async function userCanManageLead(req, lead) {
  if (req.user.role === "admin") return true;
  if (req.user.role !== "manager" && req.user.role !== "sub_admin") return false;
  const allowed = await resolveLeadsAllowedIds(req);
  return allowed === null || allowed.has(leadScopeKey(lead));
}

// Same idea as userCanManageLead, but for the simpler owner_id-tagged
// records (Contacts, Accounts, Activity Reports) -- a Manager or Sub-Admin
// can edit/delete a record if its owner is within their scope (direct
// reports + anything an Admin has explicitly granted them); an unowned
// record (created before ownership was tracked) is treated as manageable
// by any Manager/Sub-Admin rather than orphaned and un-deletable.
async function userCanManageOwnedRecord(req, ownerId) {
  if (req.user.role === "admin") return true;
  if (req.user.role !== "manager" && req.user.role !== "sub_admin") return false;
  if (!ownerId) return true;
  const allowed = await resolveScopeAllowedIds(req);
  return allowed === null || allowed.has(ownerId);
}

// Same idea again, for leave/WFH requests: Admin and HR can manage anyone's
// (they already see everyone's per GET /api/leave-requests above), a
// Manager/Sub-Admin can manage a request if its owner is within their scope
// (direct reports + explicit data grants), everyone else can't touch a
// request that isn't their own through this route.
async function userCanManageLeaveRequest(req, leaveReq) {
  if (req.user.role === "admin" || req.user.role === "hr") return true;
  return userCanManageOwnedRecord(req, leaveReq.user_id);
}

app.get("/api/leads", requireLogin, requireFeature("leads"), ah(async (req, res) => {
  const leads = await store.all("leads");
  const allowed = await resolveLeadsAllowedIds(req);
  res.json(allowed ? leads.filter((l) => allowed.has(leadScopeKey(l))) : leads);
}));

app.post("/api/leads", requireLogin, ah(async (req, res) => {
  const body = req.body || {};
  const now = new Date().toISOString();
  const row = await store.insert("leads", {
    ...cleanLeadPatch(body),
    bdm_assigned_id: body.bdm_assigned_id ? Number(body.bdm_assigned_id) : req.user.id,
    status: "pending",
    pending_changes: null,
    approved_by: null,
    approved_at: null,
    created_by: req.user.id,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(row);
}));

app.put("/api/leads/:id", requireLogin, ah(async (req, res) => {
  const lead = await store.find("leads", req.params.id);
  if (!lead) return res.status(404).json({ error: "Not found" });
  if (lead.status === "change_requested") {
    return res.status(409).json({ error: "A change request is already pending review for this lead." });
  }
  if (lead.status === "approved" && !(await userCanManageLead(req, lead))) {
    return res.status(403).json({ error: "This lead is approved — submit a change request instead.", requiresApproval: true });
  }
  const patch = { ...cleanLeadPatch(req.body || {}), updated_at: new Date().toISOString() };
  const row = await store.update("leads", lead.id, patch);
  res.json(row);
}));

app.post("/api/leads/:id/request-change", requireLogin, ah(async (req, res) => {
  const lead = await store.find("leads", req.params.id);
  if (!lead) return res.status(404).json({ error: "Not found" });
  if (lead.status !== "approved") return res.status(400).json({ error: "Change requests only apply to already-approved leads." });
  if (await userCanManageLead(req, lead)) return res.status(400).json({ error: "You can edit this lead directly — no need to request a change." });
  const row = await store.update("leads", lead.id, {
    status: "change_requested",
    pending_changes: cleanLeadPatch(req.body || {}),
    updated_at: new Date().toISOString(),
  });
  res.json(row);
}));

app.post("/api/leads/:id/approve", requireLogin, ah(async (req, res) => {
  const lead = await store.find("leads", req.params.id);
  if (!lead) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageLead(req, lead))) return res.status(403).json({ error: "Only an admin or this lead's manager can approve it." });
  const now = new Date().toISOString();
  const patch = { status: "approved", approved_by: req.user.id, approved_at: now, updated_at: now };
  if (lead.status === "change_requested" && lead.pending_changes) {
    Object.assign(patch, lead.pending_changes);
    patch.pending_changes = null;
  }
  const row = await store.update("leads", lead.id, patch);
  res.json(row);
}));

app.post("/api/leads/:id/reject", requireLogin, ah(async (req, res) => {
  const lead = await store.find("leads", req.params.id);
  if (!lead) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageLead(req, lead))) return res.status(403).json({ error: "Only an admin or this lead's manager can review this." });
  if (lead.status !== "change_requested") return res.status(400).json({ error: "Nothing to reject — this lead has no pending change request." });
  const row = await store.update("leads", lead.id, { status: "approved", pending_changes: null, updated_at: new Date().toISOString() });
  res.json(row);
}));

app.delete("/api/leads/:id", requireLogin, requireRole("admin", "manager", "sub_admin"), ah(async (req, res) => {
  const lead = await store.find("leads", req.params.id);
  if (!lead) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageLead(req, lead))) return res.status(403).json({ error: "You can only delete leads assigned within your team." });
  // Same password-re-entry gate as deleting a user (DELETE /api/users/:id)
  // -- deleting a lead is permanent, so a click alone isn't enough; the
  // signed-in rep re-confirms with their own current password.
  const password = String((req.body || {}).password || "");
  if (!password || !bcrypt.compareSync(password, req.user.password)) {
    return res.status(400).json({ error: "Your password is incorrect" });
  }
  await store.remove("leads", req.params.id);
  res.json({ ok: true });
}));

app.get("/api/reports/leads", requireLogin, ah(async (req, res) => {
  const leads = await store.all("leads");
  const users = await store.all("users");
  const byStatus = ["pending", "approved", "change_requested"].map((status) => ({
    status, count: leads.filter((l) => l.status === status).length,
  }));
  const bySourceMap = {};
  leads.forEach((l) => { const k = l.source || "Unspecified"; bySourceMap[k] = (bySourceMap[k] || 0) + 1; });
  const byBdmMap = {};
  leads.forEach((l) => {
    const id = leadScopeKey(l);
    byBdmMap[id] = byBdmMap[id] || { bdm_id: id, count: 0, approved: 0 };
    byBdmMap[id].count += 1;
    if (l.status === "approved") byBdmMap[id].approved += 1;
  });
  res.json({
    byStatus,
    bySource: Object.entries(bySourceMap).map(([source, count]) => ({ source, count })),
    byBdm: Object.values(byBdmMap).map((o) => ({ ...o, bdm_name: users.find((u) => u.id === Number(o.bdm_id))?.name || "Unassigned" })),
  });
}));

// ---------- Tasks ----------

app.get("/api/tasks", requireLogin, ah(async (req, res) => {
  res.json(await store.all("tasks"));
}));

app.post("/api/tasks", requireLogin, ah(async (req, res) => {
  const { related_type, related_id, subject, due_date } = req.body || {};
  if (!subject) return res.status(400).json({ error: "Task subject is required" });
  const row = await store.insert("tasks", {
    related_type: related_type || null,
    related_id: related_id ? Number(related_id) : null,
    subject,
    due_date: due_date || null,
    status: "open",
    owner_id: req.user.id,
  });
  res.status(201).json(row);
}));

app.put("/api/tasks/:id", requireLogin, ah(async (req, res) => {
  const row = await store.update("tasks", req.params.id, req.body || {});
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

// ---------- Leave types (HR/admin configurable) ----------

app.get("/api/leave-types", requireLogin, ah(async (req, res) => {
  res.json(await store.all("leave_types"));
}));

app.post("/api/leave-types", requireLogin, requireRole("admin", "hr"), ah(async (req, res) => {
  const { name, default_days, requires_hr, is_wfh } = req.body || {};
  if (!name) return res.status(400).json({ error: "Leave type name is required" });
  const row = await store.insert("leave_types", {
    name,
    default_days: Number(default_days) || 0,
    requires_hr: !!requires_hr,
    // Explicit flag so the Dashboard can split "Leave" from "WFH" instead of
    // guessing from the type name -- falls back to a name match (see
    // isWfhType in the dashboard stats route) for types created before this
    // field existed.
    is_wfh: !!is_wfh,
  });
  res.status(201).json(row);
}));

// ---------- Company holidays (admin configurable) ----------
// Festival/company-holiday dates an admin maintains so they're excluded
// from the day count on leave requests -- alongside Saturdays/Sundays,
// which are always excluded and need no configuration.

app.get("/api/holidays", requireLogin, ah(async (req, res) => {
  res.json((await store.all("holidays")).sort((a, b) => (a.date < b.date ? -1 : 1)));
}));

app.post("/api/holidays", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const { date, name } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "A valid date is required" });
  const holidays = await store.all("holidays");
  if (holidays.some((h) => h.date === date)) return res.status(400).json({ error: "That date is already marked as a holiday" });
  const row = await store.insert("holidays", { date, name: name || "" });
  res.status(201).json(row);
}));

app.delete("/api/holidays/:id", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const ok = await store.remove("holidays", req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));

// ---------- Leave balances ----------

app.get("/api/leave-balances", requireLogin, ah(async (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : req.user.id;
  if (userId !== req.user.id && !["admin", "hr", "manager", "sub_admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Not permitted" });
  }
  const balances = await store.all("leave_balances");
  res.json(balances.filter((b) => b.user_id === userId));
}));

// ---------- Leave requests + approval chain ----------
// Flow: employee submits -> pending_manager -> manager approves ->
//   if leave type requires_hr: pending_hr -> hr approves -> approved
//   else: approved directly after manager sign-off.
// Manager or HR can reject at their stage, which ends the chain.

app.get("/api/leave-requests", requireLogin, ah(async (req, res) => {
  const { role } = req.user;
  let rows = await store.all("leave_requests");
  if (role !== "admin" && role !== "hr") {
    // sales_rep / manager / sub_admin: self + (manager's direct reports) +
    // anyone an Admin has explicitly data-granted to this user.
    const allowed = await resolveScopeAllowedIds(req);
    if (allowed) rows = rows.filter((r) => allowed.has(r.user_id));
  }
  // admin + hr see all
  res.json(rows);
}));

app.post("/api/leave-requests", requireLogin, ah(async (req, res) => {
  const { leave_type_id, start_date, end_date, days, reason, cc_emails } = req.body || {};
  if (!leave_type_id || !start_date || !end_date || !days) {
    return res.status(400).json({ error: "Leave type, dates, and days are required" });
  }
  const balances = await store.all("leave_balances");
  const balance = balances.find(
    (b) => b.user_id === req.user.id && b.leave_type_id === Number(leave_type_id)
  );
  if (balance && Number(days) > balance.balance) {
    return res.status(400).json({ error: `Insufficient balance: ${balance.balance} day(s) remaining` });
  }
  const users = await store.all("users");
  const approver = req.user.manager_id
    ? req.user.manager_id
    : users.find((u) => u.role === "hr")?.id || null;
  const cc = mailer.parseEmailList(cc_emails);
  const row = await store.insert("leave_requests", {
    user_id: req.user.id,
    leave_type_id: Number(leave_type_id),
    start_date,
    end_date,
    days: Number(days),
    reason: reason || "",
    status: "pending_manager",
    current_approver_id: approver,
    cc_emails: cc,
    history: [],
    created_at: new Date().toISOString().slice(0, 10),
  });

  const approverUser = users.find((u) => u.id === approver);
  let mail = { sent: false, reason: "No approver email on file" };
  if (approverUser?.email) {
    const leaveType = await store.find("leave_types", Number(leave_type_id));
    mail = await mailer.sendMail({
      to: approverUser.email,
      cc,
      subject: `Leave request — ${req.user.name} (${days} day${Number(days) === 1 ? "" : "s"})`,
      html: `
        <p>${req.user.name} has submitted a leave request for your approval.</p>
        <table cellpadding="6" style="border-collapse:collapse">
          <tr><td><strong>Type</strong></td><td>${leaveType?.name || "—"}</td></tr>
          <tr><td><strong>Dates</strong></td><td>${start_date} to ${end_date}</td></tr>
          <tr><td><strong>Days</strong></td><td>${days}</td></tr>
          <tr><td><strong>Reason</strong></td><td>${reason || "—"}</td></tr>
        </table>
        <p><a href="${mailer.appUrl()}">Review it in SDR Outreach</a></p>
      `,
      text: `${req.user.name} has submitted a leave request for your approval.\nType: ${leaveType?.name || "—"}\nDates: ${start_date} to ${end_date}\nDays: ${days}\nReason: ${reason || "—"}\n\nReview it in SDR Outreach: ${mailer.appUrl()}`,
    });
  }

  res.status(201).json({ ...row, email_notification: mail });
}));

app.post("/api/leave-requests/:id/decision", requireLogin, ah(async (req, res) => {
  const { action, comment } = req.body || {}; // action: "approve" | "reject"
  const reqRow = await store.find("leave_requests", req.params.id);
  if (!reqRow) return res.status(404).json({ error: "Not found" });
  if (reqRow.current_approver_id !== req.user.id) {
    return res.status(403).json({ error: "You are not the current approver for this request" });
  }
  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
  }

  const history = [...(reqRow.history || []), {
    approver_id: req.user.id,
    approver_name: req.user.name,
    action,
    comment: comment || "",
    at: new Date().toISOString(),
    stage: reqRow.status,
  }];

  if (action === "reject") {
    const row = await store.update("leave_requests", reqRow.id, { status: "rejected", current_approver_id: null, history });
    return res.json(row);
  }

  const leaveType = await store.find("leave_types", reqRow.leave_type_id);
  let nextStatus = "approved";
  let nextApprover = null;

  if (reqRow.status === "pending_manager" && leaveType && leaveType.requires_hr) {
    nextStatus = "pending_hr";
    const users = await store.all("users");
    nextApprover = users.find((u) => u.role === "hr")?.id || null;
  }

  const row = await store.update("leave_requests", reqRow.id, {
    status: nextStatus,
    current_approver_id: nextApprover,
    history,
  });

  if (nextStatus === "approved") {
    const balances = await store.all("leave_balances");
    const balance = balances.find(
      (b) => b.user_id === reqRow.user_id && b.leave_type_id === reqRow.leave_type_id
    );
    if (balance) {
      await store.update("leave_balances", balance.id, { balance: Math.max(0, balance.balance - reqRow.days) });
    }
  }

  res.json(row);
}));

// Edit a leave/WFH request -- lets Admin/HR (org-wide) or a Manager/Sub-Admin
// (their own team's requests) correct dates/type/days/reason, or hand-adjust
// its status, from the team/org leaves panel. Same scope rule as delete
// below (see userCanManageLeaveRequest); no password re-entry here since an
// edit isn't destructive the way a delete is.
app.patch("/api/leave-requests/:id", requireLogin, requireRole("admin", "hr", "manager", "sub_admin"), ah(async (req, res) => {
  const reqRow = await store.find("leave_requests", req.params.id);
  if (!reqRow) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageLeaveRequest(req, reqRow))) {
    return res.status(403).json({ error: "You can only edit leave requests within your team." });
  }
  const body = req.body || {};
  const patch = {};
  if (body.leave_type_id !== undefined) patch.leave_type_id = Number(body.leave_type_id);
  if (body.start_date !== undefined) patch.start_date = body.start_date;
  if (body.end_date !== undefined) patch.end_date = body.end_date;
  if (body.days !== undefined) patch.days = Number(body.days);
  if (body.reason !== undefined) patch.reason = body.reason;
  if (body.status !== undefined && ["pending_manager", "pending_hr", "approved", "rejected"].includes(body.status)) {
    patch.status = body.status;
    // Hand-setting status away from a pending stage clears the approval-chain
    // pointer so it doesn't keep showing up in someone's "Pending your
    // approval" inbox after being manually resolved here.
    if (patch.status === "approved" || patch.status === "rejected") patch.current_approver_id = null;
  }
  const row = await store.update("leave_requests", reqRow.id, patch);
  res.json(row);
}));

// Delete a leave/WFH request. Same password-re-entry gate as deleting a lead
// or a user -- permanent, so a click alone isn't enough.
app.delete("/api/leave-requests/:id", requireLogin, requireRole("admin", "hr", "manager", "sub_admin"), ah(async (req, res) => {
  const reqRow = await store.find("leave_requests", req.params.id);
  if (!reqRow) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageLeaveRequest(req, reqRow))) {
    return res.status(403).json({ error: "You can only delete leave requests within your team." });
  }
  const password = String((req.body || {}).password || "");
  if (!password || !bcrypt.compareSync(password, req.user.password)) {
    return res.status(400).json({ error: "Your password is incorrect" });
  }
  await store.remove("leave_requests", req.params.id);
  res.json({ ok: true });
}));

// ---------- Activity reports ----------
// Flow: an SDR logs a daily row (status "pending") and can keep editing it
// themselves. Once their manager approves it, editing rights flip: the
// SDR can no longer touch it, only the approving manager (or an admin)
// can, so the approved figure stays authoritative but correctable.

const ACTIVITY_FIELDS = [
  "date", "country",
  "companies_new", "companies_remapped", "contacts_total_added",
  "emails_fresh", "emails_fresh_reach", "emails_followups", "emails_followups_reach",
  "linkedin_connections", "campaign",
  "responses_cold", "responses_negative", "responses_warm", "responses_prospect",
];
const ACTIVITY_NUMERIC_FIELDS = ACTIVITY_FIELDS.filter((f) => !["date", "country", "campaign"].includes(f));

function normalizeActivityBody(body) {
  const patch = {};
  for (const f of ACTIVITY_FIELDS) {
    if (body[f] === undefined) continue;
    patch[f] = ACTIVITY_NUMERIC_FIELDS.includes(f) ? Number(body[f]) || 0 : body[f];
  }
  return patch;
}

app.get("/api/activity-reports", requireLogin, requireFeature("activity_report"), ah(async (req, res) => {
  const allowed = await resolveScopeAllowedIds(req);
  const rows = await store.all("activity_reports");
  res.json(allowed ? rows.filter((r) => allowed.has(r.user_id)) : rows);
}));

app.post("/api/activity-reports", requireLogin, ah(async (req, res) => {
  const patch = normalizeActivityBody(req.body || {});
  if (!patch.date) return res.status(400).json({ error: "Date is required" });
  const users = await store.all("users");
  const approver = req.user.manager_id
    ? req.user.manager_id
    : users.find((u) => u.role === "admin")?.id || null;
  const now = new Date().toISOString().slice(0, 10);
  const cc = mailer.parseEmailList(req.body?.cc_emails);
  const row = await store.insert("activity_reports", {
    ...patch,
    user_id: req.user.id,
    status: "pending",
    current_approver_id: approver,
    cc_emails: cc,
    history: [],
    created_at: now,
    updated_at: now,
  });

  const approverUser = users.find((u) => u.id === approver);
  let mail = { sent: false, reason: "No approver email on file" };
  if (approverUser?.email) {
    mail = await mailer.sendMail({
      to: approverUser.email,
      cc,
      subject: `Activity report — ${req.user.name} (${patch.date})`,
      html: `
        <p>${req.user.name} has submitted a daily activity report for your approval.</p>
        <table cellpadding="6" style="border-collapse:collapse">
          <tr><td><strong>Date</strong></td><td>${patch.date}</td></tr>
          <tr><td><strong>Country</strong></td><td>${patch.country || "—"}</td></tr>
          <tr><td><strong>Companies (new / remapped)</strong></td><td>${patch.companies_new || 0} / ${patch.companies_remapped || 0}</td></tr>
          <tr><td><strong>Emails (fresh / follow-ups)</strong></td><td>${patch.emails_fresh || 0} / ${patch.emails_followups || 0}</td></tr>
          <tr><td><strong>LinkedIn connections</strong></td><td>${patch.linkedin_connections || 0}</td></tr>
          <tr><td><strong>Campaign</strong></td><td>${patch.campaign || "—"}</td></tr>
        </table>
        <p><a href="${mailer.appUrl()}">Review it in SDR Outreach</a></p>
      `,
      text: `${req.user.name} has submitted a daily activity report for your approval.\nDate: ${patch.date}\nCountry: ${patch.country || "—"}\nCampaign: ${patch.campaign || "—"}\n\nReview it in SDR Outreach: ${mailer.appUrl()}`,
    });
  }
  res.status(201).json({ ...row, email_notification: mail });
}));

app.put("/api/activity-reports/:id", requireLogin, ah(async (req, res) => {
  const row = await store.find("activity_reports", req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });

  const isAdmin = req.user.role === "admin";
  const canEditPending = row.status === "pending" && row.user_id === req.user.id;
  const canEditApproved = row.status === "approved" && row.current_approver_id === req.user.id;
  if (!isAdmin && !canEditPending && !canEditApproved) {
    return res.status(403).json({
      error: row.status === "approved"
        ? "This entry is approved — only the approving manager can edit it now"
        : "Only the person who logged this entry can edit it before approval",
    });
  }

  const patch = normalizeActivityBody(req.body || {});
  patch.updated_at = new Date().toISOString().slice(0, 10);
  const updated = await store.update("activity_reports", row.id, patch);
  res.json(updated);
}));

app.post("/api/activity-reports/:id/approve", requireLogin, ah(async (req, res) => {
  const row = await store.find("activity_reports", req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.current_approver_id !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "You are not the approver for this entry" });
  }
  const history = [...(row.history || []), {
    approver_id: req.user.id,
    approver_name: req.user.name,
    action: "approve",
    at: new Date().toISOString(),
  }];
  const updated = await store.update("activity_reports", row.id, { status: "approved", history });
  res.json(updated);
}));

app.delete("/api/activity-reports/:id", requireLogin, requireRole("admin", "manager", "sub_admin"), ah(async (req, res) => {
  const report = await store.find("activity_reports", req.params.id);
  if (!report) return res.status(404).json({ error: "Not found" });
  if (!(await userCanManageOwnedRecord(req, report.user_id))) {
    return res.status(403).json({ error: "You can only delete activity reports within your scope." });
  }
  await store.remove("activity_reports", req.params.id);
  res.json({ ok: true });
}));

// ---------- Reporting ----------


app.get("/api/reports/leave", requireLogin, ah(async (req, res) => {
  const requests = await store.all("leave_requests");
  const users = await store.all("users");
  const types = await store.all("leave_types");
  const balances = await store.all("leave_balances");

  const byStatus = {};
  requests.forEach((r) => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  });

  const byUser = users.map((u) => {
    const userBalances = balances.filter((b) => b.user_id === u.id);
    const used = requests.filter((r) => r.user_id === u.id && r.status === "approved").reduce((s, r) => s + r.days, 0);
    return {
      user_id: u.id,
      user_name: u.name,
      balances: userBalances.map((b) => ({
        leave_type: types.find((t) => t.id === b.leave_type_id)?.name || "Unknown",
        balance: b.balance,
      })),
      days_used: used,
    };
  });

  res.json({ byStatus, byUser, totalRequests: requests.length });
}));

// ---------- Profile: editable by the signed-in user themselves ----------
// Name, email, phone, and title (their designation) — NOT the permission
// role (admin/manager/sales_rep/hr), which stays admin-managed only so a
// user can't grant themselves elevated access via their own profile form.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.put("/api/me/profile", requireLogin, ah(async (req, res) => {
  const { name, email, phone, title } = req.body || {};
  const patch = {};

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ error: "Name can't be empty" });
    patch.name = trimmed;
  }

  if (email !== undefined) {
    const trimmed = String(email).trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) return res.status(400).json({ error: "Enter a valid email address" });
    const users = await store.all("users");
    const clash = users.find((u) => u.id !== req.user.id && u.email.toLowerCase() === trimmed);
    if (clash) return res.status(400).json({ error: "That email is already in use by another account" });
    patch.email = trimmed;
  }

  if (phone !== undefined) patch.phone = String(phone).trim();
  if (title !== undefined) patch.title = String(title).trim();

  const updated = await store.update("users", req.user.id, patch);
  res.json({ user: publicUser(updated) });
}));

// Self-service password change -- any logged-in user, for themselves,
// requiring their current password (unlike PUT /api/users/:id/password,
// which is the admin-only override that resets someone ELSE's password
// without knowing it). Kept as a separate route rather than folding into
// the profile-edit route above so a password change always needs its own
// deliberate current+new pair instead of riding along with an unrelated
// name/email edit.
app.put("/api/me/password", requireLogin, ah(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !bcrypt.compareSync(String(current_password), req.user.password)) {
    return res.status(400).json({ error: "Current password is incorrect" });
  }
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  await store.update("users", req.user.id, { password: bcrypt.hashSync(String(new_password), 8) });
  res.json({ ok: true });
}));

// ---------- Export to Excel (Calibri 11) ----------
// A plain .csv can't carry font info at all -- there's no such thing as a
// "font" on a text file -- so wherever exported data needs to actually
// render in Calibri 11 when opened, it has to be a real .xlsx with that
// font written into the cell styles. This one generic route does that for
// any table in the app: the client already computes exactly which rows/
// columns to export (same filter/selection logic as its "Export CSV"
// button), so it just hands that same {headers, rows} shape here instead
// of building a CSV string, and gets a styled workbook back. Kept generic
// rather than one route per table so Contacts/Accounts/Activity Report
// (or anything exported later) all go through one tested code path.
app.post("/api/export/xlsx", requireLogin, ah(async (req, res) => {
  const { filename, sheetName, headers, rows } = req.body || {};
  if (!Array.isArray(headers) || !headers.length) {
    return res.status(400).json({ error: "headers is required" });
  }
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: "rows is required" });
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(String(sheetName || "Export").slice(0, 31));
  const CALIBRI_11 = { name: "Calibri", size: 11 };
  sheet.columns = headers.map((h) => ({ header: String(h), key: String(h), width: Math.min(40, Math.max(12, String(h).length + 4)) }));
  sheet.getRow(1).eachCell((cell) => { cell.font = { ...CALIBRI_11, bold: true }; });
  rows.forEach((r) => {
    const row = sheet.addRow(Array.isArray(r) ? r : headers.map((h) => r?.[h] ?? ""));
    row.eachCell((cell) => { cell.font = CALIBRI_11; });
  });
  const buf = await workbook.xlsx.writeBuffer();
  const safeName = String(filename || "export").replace(/[^a-z0-9_.-]+/gi, "-");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName.endsWith(".xlsx") ? safeName : safeName + ".xlsx"}"`);
  res.send(Buffer.from(buf));
}));

// ---------- Settings: per-user appearance ----------

const THEME_FONTS = ["system", "serif", "rounded", "mono", "modern"];
// Table row/font size, app-wide -- distinct from the per-table Calibri-11
// draft/export styling (that's about a specific font for outreach content;
// this is about how much fits on screen). Applied via a data-density
// attribute the frontend sets on <body>, which every table's CSS reads.
const THEME_DENSITIES = ["compact", "comfortable", "spacious"];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

app.put("/api/me/theme", requireLogin, ah(async (req, res) => {
  const { primary, accent, font, density } = req.body || {};
  const patch = {};
  const theme = { ...(req.user.theme || {}) };
  if (primary !== undefined) {
    if (primary !== "" && !HEX_RE.test(primary)) return res.status(400).json({ error: "Primary color must be a hex value like #22c55e" });
    theme.primary = primary || undefined;
  }
  if (accent !== undefined) {
    if (accent !== "" && !HEX_RE.test(accent)) return res.status(400).json({ error: "Accent color must be a hex value like #1e3ae8" });
    theme.accent = accent || undefined;
  }
  if (font !== undefined) {
    if (font !== "" && !THEME_FONTS.includes(font)) return res.status(400).json({ error: "Unknown font choice" });
    theme.font = font || undefined;
  }
  if (density !== undefined) {
    if (density !== "" && !THEME_DENSITIES.includes(density)) return res.status(400).json({ error: "Unknown density choice" });
    theme.density = density || undefined;
  }
  patch.theme = theme;
  const updated = await store.update("users", req.user.id, patch);
  res.json({ user: publicUser(updated) });
}));

// Personal default for "which email app do I send from" -- read by the
// Contacts table's Email icon column (and anywhere else a rep sends without
// picking explicitly). Outlook Classic = mailto: (opens the desktop app),
// Outlook Web = an OWA compose deep link, Apollo = reserved for a future
// Apollo-backed send; the frontend shows a clear "not set up yet" message
// for that choice rather than silently doing nothing, since Apollo in this
// app is currently search/import only, no send capability.
const EMAIL_METHODS = ["outlook_classic", "outlook_web", "apollo"];

app.put("/api/me/email-method", requireLogin, ah(async (req, res) => {
  const { email_method } = req.body || {};
  if (!EMAIL_METHODS.includes(email_method)) {
    return res.status(400).json({ error: "Unknown email method" });
  }
  const updated = await store.update("users", req.user.id, { email_method });
  res.json({ user: publicUser(updated) });
}));

// ---------- Settings: AI integrations (admin) ----------
// API keys live in the store (per the admin's choice to manage them in-app
// rather than as environment variables) but are never echoed back in full —
// only a masked "sk-...ab12" preview, same pattern as password fields.

function maskKey(key) {
  if (!key) return null;
  return key.length <= 6 ? "••••" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

const APOLLO_LABEL = "Apollo.io";

app.get("/api/integrations", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const rows = await store.all("integrations");
  const configured = Object.keys(ai.PROVIDERS).map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    return {
      provider,
      label: ai.PROVIDERS[provider].label,
      configured: Boolean(row?.api_key),
      key_preview: maskKey(row?.api_key),
      active: Boolean(row?.active),
      drafting_active: Boolean(row?.drafting_active),
      updated_at: row?.updated_at || null,
    };
  });
  const unsupported = Object.entries(ai.UNSUPPORTED_PROVIDERS).map(([provider, v]) => ({
    provider, label: v.label, reason: v.reason,
  }));
  const apolloRow = rows.find((r) => r.provider === "apollo");
  const apolloStatus = {
    provider: "apollo",
    label: APOLLO_LABEL,
    configured: Boolean(apolloRow?.api_key),
    key_preview: maskKey(apolloRow?.api_key),
    updated_at: apolloRow?.updated_at || null,
  };
  const unipileRow = rows.find((r) => r.provider === "unipile");
  const unipileStatus = {
    provider: "unipile",
    configured: Boolean(unipileRow?.api_key && unipileRow?.dsn && unipileRow?.account_id),
    key_preview: maskKey(unipileRow?.api_key),
    dsn: unipileRow?.dsn || "",
    account_id: unipileRow?.account_id || "",
    updated_at: unipileRow?.updated_at || null,
  };
  res.json({ providers: configured, unsupported, apollo: apolloStatus, unipile: unipileStatus });
}));

app.put("/api/integrations/:provider", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const { provider } = req.params;
  const isApollo = provider === "apollo";
  const isUnipile = provider === "unipile";
  if (isUnipile) {
    const { api_key, dsn, account_id } = req.body || {};
    const rows = await store.all("integrations");
    const existing = rows.find((r) => r.provider === "unipile");
    if ((!dsn || !String(dsn).trim() || !account_id || !String(account_id).trim())) {
      return res.status(400).json({ error: "DSN and account ID are both required." });
    }
    if (!api_key && !existing?.api_key) {
      return res.status(400).json({ error: "API key is required the first time you set this up." });
    }
    const patch = { provider: "unipile", dsn: String(dsn).trim(), account_id: String(account_id).trim(), updated_at: new Date().toISOString().slice(0, 10) };
    if (api_key) patch.api_key = api_key;
    const row = existing ? await store.update("integrations", existing.id, patch) : await store.insert("integrations", patch);
    return res.json({
      provider: "unipile",
      configured: Boolean(row.api_key && row.dsn && row.account_id),
      key_preview: maskKey(row.api_key),
      dsn: row.dsn, account_id: row.account_id, updated_at: row.updated_at,
    });
  }
  if (!isApollo && !ai.PROVIDERS[provider]) return res.status(400).json({ error: "Unknown provider" });
  const { api_key, active, drafting_active } = req.body || {};
  const rows = await store.all("integrations");
  const existing = rows.find((r) => r.provider === provider);

  if (active && !isApollo) {
    // Only one active AI provider at a time for the general AI features
    // (Quick Add, Account brief, etc). Apollo isn't part of that
    // exclusivity — it's a different capability entirely, not an
    // interchangeable text-generation backend.
    for (const r of rows) {
      if (r.active && r.provider !== provider && ai.PROVIDERS[r.provider]) {
        await store.update("integrations", r.id, { active: false });
      }
    }
  }
  if (drafting_active && !isApollo) {
    // Separate exclusivity group for "used for drafting" (Draft with AI,
    // auto-draft, outreach sequences) — deliberately independent of the
    // general `active` provider above, so e.g. Claude can stay the default
    // for everything else while ChatGPT is the one that actually writes
    // outreach drafts.
    for (const r of rows) {
      if (r.drafting_active && r.provider !== provider && ai.PROVIDERS[r.provider]) {
        await store.update("integrations", r.id, { drafting_active: false });
      }
    }
  }

  const patch = { provider, updated_at: new Date().toISOString().slice(0, 10) };
  if (api_key !== undefined && api_key !== "") patch.api_key = api_key;
  if (isApollo) patch.active = true; // no on/off toggle — configured means usable
  else {
    if (active !== undefined) patch.active = Boolean(active);
    if (drafting_active !== undefined) patch.drafting_active = Boolean(drafting_active);
  }

  const row = existing
    ? await store.update("integrations", existing.id, patch)
    : await store.insert("integrations", { active: false, drafting_active: false, ...patch });

  if (isApollo) {
    return res.json({
      provider: "apollo",
      label: APOLLO_LABEL,
      configured: Boolean(row.api_key),
      key_preview: maskKey(row.api_key),
      updated_at: row.updated_at,
    });
  }

  res.json({
    provider: row.provider,
    label: ai.PROVIDERS[provider].label,
    configured: Boolean(row.api_key),
    key_preview: maskKey(row.api_key),
    active: Boolean(row.active),
    drafting_active: Boolean(row.drafting_active),
    updated_at: row.updated_at,
  });
}));

app.delete("/api/integrations/:provider", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const rows = await store.all("integrations");
  const existing = rows.find((r) => r.provider === req.params.provider);
  if (!existing) return res.status(404).json({ error: "Not found" });
  await store.remove("integrations", existing.id);
  res.json({ ok: true });
}));

app.post("/api/ai/draft-email", requireLogin, ah(async (req, res) => {
  const { contact_name, title, company, context } = req.body || {};
  const rows = await store.all("integrations");
  const active = pickDraftingProvider(rows);
  if (!active) {
    return res.status(400).json({
      error: req.user.role === "admin"
        ? "No AI provider is configured yet — add an API key in Settings > Integrations."
        : "No AI provider is configured yet — ask an admin to add one in Settings > Integrations.",
    });
  }
  try {
    const companyProfile = await getCompanyProfile();
    const text = await ai.draftEmail({
      provider: active.provider,
      apiKey: active.api_key,
      contactName: contact_name,
      title,
      company,
      context,
      senderCompanyInfo: companyProfile.content || "",
    });
    res.json({ text, provider: active.provider });
  } catch (err) {
    res.status(502).json({ error: `${ai.PROVIDERS[active.provider]?.label || active.provider} request failed: ${err.message}` });
  }
}));

// ---------- Prospecting (Apollo.io) ----------
// Search runs for any logged-in user (the key itself is admin-managed in
// Settings > Integrations, same split as the AI drafting feature). Imports
// find-or-create the target Account by name so repeated imports from the
// same company land on one record instead of duplicating it.

async function getApolloKey() {
  const rows = await store.all("integrations");
  const row = rows.find((r) => r.provider === "apollo" && r.api_key);
  return row?.api_key || null;
}

function apolloNotConfiguredError(req) {
  return req.user.role === "admin"
    ? "Apollo isn't connected yet — add an API key in Settings > Integrations."
    : "Apollo isn't connected yet — ask an admin to add an API key in Settings > Integrations.";
}

app.post("/api/prospecting/search-people", requireLogin, ah(async (req, res) => {
  const apiKey = await getApolloKey();
  if (!apiKey) return res.status(400).json({ error: apolloNotConfiguredError(req) });
  try {
    const result = await apollo.searchPeople({ apiKey, ...(req.body || {}) });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apollo request failed: ${err.message}` });
  }
}));

app.post("/api/prospecting/search-companies", requireLogin, ah(async (req, res) => {
  const apiKey = await getApolloKey();
  if (!apiKey) return res.status(400).json({ error: apolloNotConfiguredError(req) });
  try {
    const result = await apollo.searchCompanies({ apiKey, ...(req.body || {}) });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apollo request failed: ${err.message}` });
  }
}));

app.post("/api/prospecting/reveal-email", requireLogin, ah(async (req, res) => {
  const apiKey = await getApolloKey();
  if (!apiKey) return res.status(400).json({ error: apolloNotConfiguredError(req) });
  const { first_name, last_name, organization_name, linkedin_url } = req.body || {};
  try {
    const result = await apollo.revealEmail({
      apiKey, firstName: first_name, lastName: last_name,
      organizationName: organization_name, linkedinUrl: linkedin_url,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apollo request failed: ${err.message}` });
  }
}));

// Apollo Lists import: a rep picks one of their already-saved Apollo Lists
// (contacts or companies grouped inside their own Apollo.io account) instead
// of running a live keyword search, then imports some or all of it. This is
// one of the four import sources offered from Contacts/Accounts > Import,
// alongside CSV (built), and Other/LinkedIn (placeholders for later).
app.get("/api/prospecting/apollo-lists", requireLogin, ah(async (req, res) => {
  const apiKey = await getApolloKey();
  if (!apiKey) return res.status(400).json({ error: apolloNotConfiguredError(req) });
  const modality = req.query.modality === "accounts" ? "accounts" : "contacts";
  try {
    const result = await apollo.getLists({ apiKey, modality });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apollo request failed: ${err.message}` });
  }
}));

app.post("/api/prospecting/list-people", requireLogin, ah(async (req, res) => {
  const apiKey = await getApolloKey();
  if (!apiKey) return res.status(400).json({ error: apolloNotConfiguredError(req) });
  const { list_id, page } = req.body || {};
  if (!list_id) return res.status(400).json({ error: "list_id is required" });
  try {
    const result = await apollo.getListContacts({ apiKey, listId: list_id, page });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apollo request failed: ${err.message}` });
  }
}));

app.post("/api/prospecting/list-companies", requireLogin, ah(async (req, res) => {
  const apiKey = await getApolloKey();
  if (!apiKey) return res.status(400).json({ error: apolloNotConfiguredError(req) });
  const { list_id, page } = req.body || {};
  if (!list_id) return res.status(400).json({ error: "list_id is required" });
  try {
    const result = await apollo.getListCompanies({ apiKey, listId: list_id, page });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apollo request failed: ${err.message}` });
  }
}));

// Account form auto-fill: given a company name, try to fill Industry,
// Website, Revenue, Address, and a LinkedIn company URL for the Sales
// Navigator field. Apollo (already connected for Prospecting) is tried
// first since it's a single structured lookup; whatever fields it doesn't
// return are then filled by Claude's live web_search tool, if a Claude key
// is configured — a real web search per request, not the model guessing
// from memory. Both sources are best-effort: a source failing (no key
// configured, no match, request error) is recorded as a warning rather than
// failing the whole lookup, so the rep still gets whatever could be found
// and can fill the rest in by hand.
//
// Note on sales_navigator_url: neither Apollo nor a web search can produce a
// literal linkedin.com/sales/company/<id> deep link — that ID is internal
// to LinkedIn Sales Navigator and isn't public. What gets filled is the
// company's normal public LinkedIn URL, which is enough to find/open the
// account from inside Sales Navigator.
// The one Account/website field doubles as either input -- typing
// "facebook.com" works the same as typing "Facebook". `extractDomain` is
// deliberately strict (must be the WHOLE trimmed string, no spaces, ending
// in a plausible TLD) so an ordinary company name that happens to contain a
// period ("Acme Corp.") never gets misread as a domain.
function extractDomain(raw) {
  const cleaned = raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].split("?")[0];
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(cleaned) ? cleaned.toLowerCase() : "";
}
function domainsMatch(website, domain) {
  if (!website || !domain) return false;
  const w = String(website).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return w === domain || w.endsWith(`.${domain}`) || domain.endsWith(`.${w}`);
}

app.post("/api/accounts/lookup-company", requireLogin, ah(async (req, res) => {
  const raw = (req.body?.name || "").trim();
  if (!raw) return res.status(400).json({ error: "Company name or website is required" });

  const domain = extractDomain(raw);
  const fields = { industry: "", website: domain || "", revenue: "", address: "", sales_navigator_url: "" };
  let resolvedName = "";
  const sources = [];
  const warnings = [];

  const apolloKey = await getApolloKey();
  if (apolloKey) {
    try {
      const { companies } = await apollo.searchCompanies(
        domain ? { apiKey: apolloKey, domain } : { apiKey: apolloKey, keywords: raw }
      );
      const match = domain
        ? companies.find((c) => domainsMatch(c.website, domain))
        : (companies.find((c) => c.name.toLowerCase() === raw.toLowerCase()) || companies[0]);
      if (match) {
        for (const f of ["industry", "website", "revenue", "address"]) {
          if (match[f]) fields[f] = match[f];
        }
        if (match.linkedin_url) fields.sales_navigator_url = match.linkedin_url;
        if (domain && match.name) resolvedName = match.name;
        sources.push("Apollo");
      } else {
        warnings.push(domain ? "Apollo had no match for that website." : "Apollo had no match for that company name.");
      }
    } catch (err) {
      warnings.push(`Apollo lookup failed: ${err.message}`);
    }
  } else {
    warnings.push("Apollo isn't connected — add an API key in Settings > Integrations to use it here.");
  }

  const missing = Object.keys(fields).filter((f) => !fields[f]);
  const needsNameResolution = domain && !resolvedName;
  if (missing.length || needsNameResolution) {
    const integrationRows = await store.all("integrations");
    const claudeRow = integrationRows.find((r) => r.provider === "claude" && r.active && r.api_key);
    if (claudeRow) {
      try {
        // Anchor the web search on whatever Apollo already confirmed about
        // THIS company (e.g. industry/address), so a common/ambiguous name
        // doesn't get resolved against a differently-scoped entity (a local
        // branch, a franchise, an unrelated business with a similar name)
        // for the fields Apollo didn't have.
        const knownFields = Object.fromEntries(Object.entries(fields).filter(([f, v]) => v && !missing.includes(f)));
        const webResult = await ai.researchCompanyFields({
          apiKey: claudeRow.api_key, name: resolvedName || raw, domain: domain || undefined, fields: missing, knownFields,
        });
        for (const f of missing) {
          if (webResult[f]) fields[f] = webResult[f];
        }
        if (needsNameResolution && webResult.resolved_name) resolvedName = webResult.resolved_name;
        sources.push("Claude web search");
      } catch (err) {
        warnings.push(`Web search failed: ${err.message}`);
      }
    } else if (!apolloKey) {
      warnings.push("No Claude provider configured — add one in Settings > Integrations to enable web-search fallback.");
    }
  }

  res.json({ ...fields, resolved_name: resolvedName, sources, warnings });
}));

// Contact form auto-fill: given First/Last name (+ optional email), try to
// fill Title and LinkedIn URL. Same Apollo-first, Claude-web-search-fallback
// pattern as the company lookup above, with one deliberate difference:
// Phone is never included here. Apollo's own structured phone data isn't
// requested by this route at all (title/linkedin_url only) because a
// name+email match is a much weaker identity signal than a company lookup,
// and a wrong phone number silently attached to the wrong person is worse
// than an empty field. If Apollo returns a phone on a high-confidence match
// we still ignore it here, and the web-search fallback is never even asked
// for a phone. sales_navigator_url is intentionally never touched — see the
// field's own placeholder text; it's a private per-viewer Sales Navigator
// lead link that no public data source (Apollo or a web search) can produce.
app.post("/api/contacts/lookup-person", requireLogin, ah(async (req, res) => {
  const firstName = (req.body?.first_name || "").trim();
  const lastName = (req.body?.last_name || "").trim();
  const email = (req.body?.email || "").trim();
  if (!firstName || !lastName) return res.status(400).json({ error: "First and last name are required" });

  const fields = { title: "", linkedin_url: "" };
  const sources = [];
  const warnings = [];
  let companyHint = "";

  const freeMailDomains = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com"]);
  const emailDomain = email.includes("@") ? email.split("@")[1].toLowerCase() : "";
  const isCompanyEmail = emailDomain && !freeMailDomains.has(emailDomain);

  const apolloKey = await getApolloKey();
  if (apolloKey) {
    try {
      const { people } = await apollo.searchPeople({ apiKey: apolloKey, keywords: `${firstName} ${lastName}` });
      const fullName = `${firstName} ${lastName}`.toLowerCase();
      let match = people.find((p) => `${p.first_name} ${p.last_name}`.toLowerCase() === fullName
        && isCompanyEmail && (p.organization_website || "").toLowerCase().includes(emailDomain));
      if (!match && people.length === 1) match = people[0];
      if (!match) match = people.find((p) => `${p.first_name} ${p.last_name}`.toLowerCase() === fullName);
      if (match) {
        if (match.title) fields.title = match.title;
        if (match.linkedin_url) fields.linkedin_url = match.linkedin_url;
        if (match.organization_name) companyHint = match.organization_name;
        sources.push("Apollo");
      } else {
        warnings.push("Apollo had no confident match for that name.");
      }
    } catch (err) {
      warnings.push(`Apollo lookup failed: ${err.message}`);
    }
  } else {
    warnings.push("Apollo isn't connected — add an API key in Settings > Integrations to use it here.");
  }

  const missing = ["title", "linkedin_url"].filter((f) => !fields[f]);
  if (missing.length) {
    const integrationRows = await store.all("integrations");
    const claudeRow = integrationRows.find((r) => r.provider === "claude" && r.active && r.api_key);
    if (claudeRow) {
      try {
        const webResult = await ai.researchPersonFields({
          apiKey: claudeRow.api_key, firstName, lastName, company: companyHint, fields: missing,
        });
        for (const f of missing) {
          if (webResult[f]) fields[f] = webResult[f];
        }
        if (!companyHint && webResult.company) companyHint = webResult.company;
        sources.push("Claude web search");
      } catch (err) {
        warnings.push(`Web search failed: ${err.message}`);
      }
    } else if (!apolloKey) {
      warnings.push("No Claude provider configured — add one in Settings > Integrations to enable web-search fallback.");
    }
  }

  res.json({ ...fields, sources, warnings });
}));

app.post("/api/prospecting/import-contact", requireLogin, ah(async (req, res) => {
  const { first_name, last_name, email, phone, title, linkedin_url, organization_name, organization_website } = req.body || {};
  // Apollo's People Search doesn't always return a populated last_name for
  // lower-confidence/unenriched profiles (even after the first_name/
  // last_name split-from-full-name fallback in lib/apollo.js) -- blocking
  // the import on "both required" silently rejected those rows with no
  // visible reason beyond a generic "Imported 0 contacts" toast. A contact
  // just needs *a* name; only reject if there's nothing to import at all.
  if (!first_name && !last_name) return res.status(400).json({ error: "This result has no name data from Apollo — nothing to import" });
  // Every Contact must belong to an Account, same rule as the New Contact
  // form and the CSV/list bulk import -- Quick Add and the Apollo
  // single-result "Import" button both land here, so this is the one place
  // that needs the check for both of those entry points.
  if (!organization_name) {
    return res.status(400).json({
      error: `Account name is missing for ${[first_name, last_name].filter(Boolean).join(" ")}${email ? ` (${email})` : ""}.`,
    });
  }
  const acct = await findOrCreateAccountByName(organization_name, organization_website ? { website: organization_website } : {}, req.user.id);
  const accountId = acct ? acct.id : null;
  const row = await store.insert("contacts", {
    first_name: first_name || "", last_name: last_name || "", email: email || "", phone: phone || "", title: title || "",
    linkedin_url: linkedin_url || "", sales_navigator_url: "", account_id: accountId, owner_id: req.user.id,
    created_at: new Date().toISOString().slice(0, 10),
  });
  res.status(201).json({ contact: row });
}));

app.post("/api/prospecting/import-company", requireLogin, ah(async (req, res) => {
  const { name, website, industry, phone, revenue, address, linkedin_url } = req.body || {};
  if (!name) return res.status(400).json({ error: "Company name is required" });
  const extra = {};
  if (website) extra.website = website;
  if (industry) extra.industry = industry;
  if (phone) extra.phone = phone;
  // Apollo returns these too (see getListCompanies/searchCompanies in
  // lib/apollo.js) -- previously dropped on the floor here even though the
  // import source already had them, so an imported Account came in missing
  // detail its own source data had. linkedin_url lands in sales_navigator_url,
  // matching how every other part of the app stores a company's LinkedIn URL.
  if (revenue) extra.revenue = revenue;
  if (address) extra.address = address;
  if (linkedin_url) extra.sales_navigator_url = linkedin_url;
  const account = await findOrCreateAccountByName(name, extra, req.user.id);
  res.status(201).json({ account });
}));


// ---------- Outlook (per-user "connect your inbox" for sending) ----------
// Two layers, same shape as Salesforce above: an admin registers one Azure
// AD app for the whole org (stored as a row in `integrations`), then every
// rep — any role — connects their own mailbox against that app. Each rep's
// connection lives in its own `outlook_connections` collection, never on
// the `users` record itself, so a refresh token can never leak through
// publicUser()/`/api/users` the way it would if it were just another user
// field.

async function getOutlookAppConfig() {
  const rows = await store.all("integrations");
  return rows.find((r) => r.provider === "outlook_app") || null;
}

// A user can connect more than one mailbox (their own + a shared team
// address, for instance) -- every connection is its own row, distinguished
// by email. `getOutlookConnections` returns all of them; the "primary" one
// (first connected) is what automated sends (sequences) use by default when
// no explicit mailbox was chosen.
async function getOutlookConnections(userId) {
  const rows = await store.all("outlook_connections");
  return rows.filter((r) => r.user_id === userId);
}
async function getOutlookConnection(userId) {
  const rows = await getOutlookConnections(userId);
  return rows[0] || null;
}

function outlookRedirectUri() {
  return `${mailer.appUrl()}/api/outlook/oauth/callback`;
}

app.get("/api/outlook/app-config", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const row = await getOutlookAppConfig();
  res.json({
    configured: Boolean(row?.client_id && row?.client_secret && row?.tenant_id),
    tenant_id: row?.tenant_id || "",
    client_id_preview: maskKey(row?.client_id),
    redirect_uri: outlookRedirectUri(),
  });
}));

app.put("/api/outlook/app-config", requireLogin, requireRole("admin"), ah(async (req, res) => {
  const { tenant_id, client_id, client_secret } = req.body || {};
  if (!tenant_id || !client_id || !client_secret) {
    return res.status(400).json({ error: "Tenant ID, Application (client) ID, and Client secret are all required" });
  }
  const row = await getOutlookAppConfig();
  const patch = { provider: "outlook_app", tenant_id: tenant_id.trim(), client_id: client_id.trim(), client_secret: client_secret.trim() };
  const saved = row ? await store.update("integrations", row.id, patch) : await store.insert("integrations", patch);
  res.json({ configured: true, tenant_id: saved.tenant_id, client_id_preview: maskKey(saved.client_id), redirect_uri: outlookRedirectUri() });
}));

app.get("/api/outlook/status", requireLogin, ah(async (req, res) => {
  const [appConfig, connections] = await Promise.all([getOutlookAppConfig(), getOutlookConnections(req.user.id)]);
  res.json({
    app_configured: Boolean(appConfig?.client_id && appConfig?.client_secret && appConfig?.tenant_id),
    connected: connections.length > 0,
    count: connections.length,
  });
}));

// Full list of the current user's connected mailboxes -- powers the
// "Connected mailboxes" list in Settings and the "Send from" picker
// wherever a rep composes an email.
app.get("/api/outlook/connections", requireLogin, ah(async (req, res) => {
  const rows = await getOutlookConnections(req.user.id);
  res.json(rows.map((r) => ({
    id: r.id,
    email: r.email || "",
    display_name: r.display_name || "",
    connected_at: r.connected_at || null,
    last_synced_at: r.last_synced_at || null,
  })));
}));

app.get("/api/outlook/oauth/start", requireLogin, ah(async (req, res) => {
  const appConfig = await getOutlookAppConfig();
  if (!appConfig?.client_id || !appConfig?.tenant_id) {
    return res.status(400).send("Outlook isn't set up for this organization yet — ask an admin to add the Azure app details in Settings > Integrations first.");
  }
  const state = require("crypto").randomBytes(16).toString("hex");
  req.session.outlookOauthState = state;
  const url = outlook.buildAuthorizeUrl({ tenantId: appConfig.tenant_id, clientId: appConfig.client_id, redirectUri: outlookRedirectUri(), state });
  res.redirect(url);
}));

app.get("/api/outlook/oauth/callback", requireLogin, ah(async (req, res) => {
  const { code, state, error, error_description } = req.query || {};
  if (error) return res.status(400).send(`Microsoft declined the connection: ${error_description || error}`);
  if (!code || !state || state !== req.session.outlookOauthState) {
    return res.status(400).send("Outlook login didn't come back with a valid state token — please try connecting again from Settings.");
  }
  req.session.outlookOauthState = null;
  const appConfig = await getOutlookAppConfig();
  if (!appConfig) return res.status(400).send("Outlook configuration was cleared before the login finished — please try again.");
  try {
    const data = await outlook.exchangeCode({
      tenantId: appConfig.tenant_id, clientId: appConfig.client_id, clientSecret: appConfig.client_secret,
      code, redirectUri: outlookRedirectUri(),
    });
    const profile = await outlook.getProfile(data.access_token);
    const email = profile.mail || profile.userPrincipalName || "";
    // Match by email, not just by user -- that's what lets someone connect
    // a *second*, different mailbox instead of always overwriting the same
    // row. Reconnecting the same address still just refreshes its tokens.
    const existing = (await getOutlookConnections(req.user.id)).find((r) => (r.email || "").toLowerCase() === email.toLowerCase());
    const patch = { user_id: req.user.id, refresh_token: data.refresh_token, email, display_name: profile.displayName || "", connected_at: new Date().toISOString() };
    if (existing) await store.update("outlook_connections", existing.id, patch);
    else await store.insert("outlook_connections", patch);
    res.redirect("/?integration=outlook_connected");
  } catch (err) {
    res.status(502).send(`Couldn't finish connecting Outlook: ${err.message}`);
  }
}));

app.post("/api/outlook/disconnect", requireLogin, ah(async (req, res) => {
  const { id } = req.body || {};
  const rows = await getOutlookConnections(req.user.id);
  const target = id ? rows.find((r) => String(r.id) === String(id)) : rows[0];
  if (target) await store.remove("outlook_connections", target.id);
  res.json({ ok: true });
}));

// ---------- Outlook inbox sync ("Replies" view) ----------
// On-demand pull, not a live webhook — matches replies to a Contact by
// sender email so a rep can see who's responded without leaving the CRM.
// Only ever reads the signed-in user's own mailbox, and only ever writes
// rows tagged with their own owner_id, so one rep's sync can never surface
// another rep's inbox contents.

app.post("/api/outlook/sync-inbox", requireLogin, ah(async (req, res) => {
  const appConfig = await getOutlookAppConfig();
  const connections = await getOutlookConnections(req.user.id);
  if (!connections.length) {
    return res.status(400).json({ error: "Connect at least one Outlook mailbox in Settings > Integrations first." });
  }
  try {
    const [contacts, existingRows] = await Promise.all([
      store.all("contacts"), store.all("inbox_messages"),
    ]);
    const seenIds = new Set(existingRows.filter((r) => r.owner_id === req.user.id).map((r) => r.graph_id));
    let imported = 0;
    let fetched = 0;
    const errors = [];
    // Every connected mailbox is synced in turn -- a failure on one (an
    // expired/revoked connection, say) is recorded per-mailbox rather than
    // aborting the sync for the others.
    for (const connection of connections) {
      try {
        const { refreshToken, messages } = await outlook.listInboxMessages({
          appConfig, connection, top: 50, sinceISO: connection.last_synced_at || null,
        });
        if (refreshToken && refreshToken !== connection.refresh_token) {
          await store.update("outlook_connections", connection.id, { refresh_token: refreshToken });
        }
        fetched += messages.length;
        for (const m of messages) {
          if (seenIds.has(m.id)) continue;
          const fromEmail = (m.from?.emailAddress?.address || "").toLowerCase();
          const contact = fromEmail ? contacts.find((c) => (c.email || "").toLowerCase() === fromEmail) : null;
          await store.insert("inbox_messages", {
            graph_id: m.id,
            owner_id: req.user.id,
            mailbox_email: connection.email || "",
            from_email: fromEmail,
            from_name: m.from?.emailAddress?.name || "",
            subject: m.subject || "(no subject)",
            preview: m.bodyPreview || "",
            received_at: m.receivedDateTime || new Date().toISOString(),
            web_link: m.webLink || "",
            contact_id: contact?.id || null,
          });
          seenIds.add(m.id);
          imported++;
        }
        await store.update("outlook_connections", connection.id, { last_synced_at: new Date().toISOString() });
      } catch (err) {
        errors.push(`${connection.email || "a connected mailbox"}: ${err.message}`);
      }
    }
    res.json({ imported, fetched, errors });
  } catch (err) {
    res.status(err.notConfigured || err.notConnected ? 400 : 502).json({ error: err.message });
  }
}));

app.get("/api/outlook/inbox", requireLogin, ah(async (req, res) => {
  const rows = (await store.all("inbox_messages")).filter((r) => r.owner_id === req.user.id);
  rows.sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")));
  res.json(rows);
}));

// Tries the sending user's own connected Outlook mailbox first, falling
// back to the shared SMTP mailbox (lib/mailer.js) if they haven't
// connected one — so the feature works out of the box for anyone who
// hasn't set up Outlook yet, and upgrades automatically once they do.
// `connectionId` lets a caller pick a *specific* one of the sender's
// connected mailboxes (the "Send from" picker on a contact or the Emailing
// tab); with no id, automated sends (sequences) fall back to whichever
// mailbox was connected first.
// Every outbound send goes through here, so this is the one place that
// needs to wrap the body -- the compose/draft UIs only style what the rep
// sees while writing it (a textarea can't carry font info into an email),
// this inline style is what actually reaches the recipient's inbox.
// Inline (not a <style> block) because most mail clients strip <style>
// tags and only reliably honor inline styles.
function wrapEmailHtml(html) {
  if (!html) return html;
  return `<div style="font-family:Calibri,Candara,'Segoe UI',Optima,Arial,sans-serif;font-size:11pt;line-height:1.5">${html}</div>`;
}

async function deliverEmail({ senderUser, to, subject, html, text, connectionId }) {
  if (!to) return { sent: false, reason: "No recipient", via: null };
  html = wrapEmailHtml(html);
  let connection = null;
  if (senderUser) {
    const connections = await getOutlookConnections(senderUser.id);
    connection = (connectionId && connections.find((r) => String(r.id) === String(connectionId))) || connections[0] || null;
  }
  if (connection?.refresh_token) {
    const appConfig = await getOutlookAppConfig();
    try {
      const { refreshToken } = await outlook.sendMail({ appConfig, connection, to, subject, html, text });
      if (refreshToken && refreshToken !== connection.refresh_token) {
        await store.update("outlook_connections", connection.id, { refresh_token: refreshToken });
      }
      return { sent: true, via: "outlook", from: connection.email };
    } catch (err) {
      if (err.refreshToken && err.refreshToken !== connection.refresh_token) {
        await store.update("outlook_connections", connection.id, { refresh_token: err.refreshToken });
      }
      const fallback = await mailer.sendMail({ to, subject, html, text });
      return fallback.sent
        ? { ...fallback, via: "smtp_fallback" }
        : { sent: false, via: null, reason: `Outlook send failed (${err.message})` };
    }
  }
  const result = await mailer.sendMail({ to, subject, html, text });
  return { ...result, via: result.sent ? "smtp" : null };
}

// ---------- Quick Add (AI paste capture) ----------

app.post("/api/quick-add/parse", requireLogin, ah(async (req, res) => {
  const rows = await store.all("integrations");
  const active = rows.find((r) => r.active && r.api_key && ai.PROVIDERS[r.provider]);
  if (!active) {
    return res.status(400).json({
      error: req.user.role === "admin"
        ? "No AI provider is configured yet — add an API key in Settings > Integrations."
        : "No AI provider is configured yet — ask an admin to add one in Settings > Integrations.",
    });
  }
  try {
    const parsed = await ai.parsePastedContact({ provider: active.provider, apiKey: active.api_key, text: req.body?.text });
    res.json(parsed);
  } catch (err) {
    res.status(502).json({ error: `${ai.PROVIDERS[active.provider]?.label || active.provider} request failed: ${err.message}` });
  }
}));

// ---------- Emailing (native templates, lists, sequences) ----------
// Entirely self-contained — no Apollo (or any external ESP) account
// required. Sends go out through the same SMTP config as leave/report
// notifications (lib/mailer.js); if SMTP isn't configured, sendMail()
// no-ops and every send is still logged to `sent_emails` with
// sent:false so the UI can show exactly what would have gone out.

function renderMerge(str, ctx) {
  if (!str) return "";
  const map = {
    first_name: ctx.first_name || "",
    last_name: ctx.last_name || "",
    company: ctx.company || "",
    title: ctx.title || "",
    sender_name: ctx.sender_name || "",
  };
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (key in map ? map[key] : ""));
}

async function mergeContextForContact(contact, senderUser) {
  return {
    first_name: contact.first_name || "",
    last_name: contact.last_name || "",
    title: contact.title || "",
    company: "",
    sender_name: senderUser ? senderUser.name : "",
  };
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s, i) => ({
      order: i + 1,
      delay_days: Number(s.delay_days) || 0,
      subject: s.subject || "",
      body: s.body || "",
    }))
    .filter((s) => s.subject || s.body);
}

async function sendSequenceStep(enrollment, sequence, contact, step, senderUser) {
  const ctx = await mergeContextForContact(contact, senderUser);
  const subject = renderMerge(step.subject, ctx);
  const bodyText = renderMerge(step.body, ctx);
  const html = bodyText.replace(/\n/g, "<br>");
  const result = await deliverEmail({ senderUser, to: contact.email, subject, html, text: bodyText });
  return store.insert("sent_emails", {
    contact_id: contact.id,
    sequence_id: sequence.id,
    enrollment_id: enrollment.id,
    step_order: step.order,
    subject,
    body: bodyText,
    to: contact.email || "",
    sent: result.sent,
    via: result.via || null,
    reason: result.reason || null,
    sent_at: new Date().toISOString(),
    sent_by: senderUser ? senderUser.id : null,
  });
}

// Advances every active enrollment whose next step is due. There's no
// persistent background scheduler available on Netlify Functions, so this
// is triggered from the client instead: once when the Emailing tab loads,
// and via a manual "Send due emails now" button — same pattern as other
// on-demand sweeps in this app.
async function processDueEnrollments(triggeredByUser) {
  const enrollments = await store.all("sequence_enrollments");
  const now = new Date();
  const results = [];
  for (const enr of enrollments) {
    if (enr.status !== "active") continue;
    if (!enr.next_send_at || new Date(enr.next_send_at) > now) continue;
    const sequence = await store.find("sequences", enr.sequence_id);
    if (!sequence || !sequence.active) continue;
    const steps = (sequence.steps || []).slice().sort((a, b) => a.order - b.order);
    const stepIdx = enr.current_step || 0;
    const step = steps[stepIdx];
    if (!step) {
      await store.update("sequence_enrollments", enr.id, { status: "completed", completed_at: new Date().toISOString(), next_send_at: null });
      continue;
    }
    const contact = await store.find("contacts", enr.contact_id);
    if (!contact) {
      await store.update("sequence_enrollments", enr.id, { status: "stopped", next_send_at: null });
      continue;
    }
    // Send as the sequence's owner, not whoever happened to trigger the
    // sweep — different reps' sequences send from different mailboxes,
    // which is the whole point of connecting Outlook per-user.
    const senderUser = (sequence.owner_id && await store.find("users", sequence.owner_id)) || triggeredByUser;
    const sentRow = await sendSequenceStep(enr, sequence, contact, step, senderUser);
    const nextIdx = stepIdx + 1;
    const nextStep = steps[nextIdx];
    const patch = { current_step: nextIdx, last_sent_at: new Date().toISOString() };
    if (nextStep) {
      const nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + (nextStep.delay_days || 0));
      patch.next_send_at = nextDate.toISOString();
    } else {
      patch.status = "completed";
      patch.completed_at = new Date().toISOString();
      patch.next_send_at = null;
    }
    const updated = await store.update("sequence_enrollments", enr.id, patch);
    results.push({ enrollment: updated, sent: sentRow });
  }
  return results;
}

// -- Templates --

app.get("/api/emailing/templates", requireLogin, requireFeature("emailing"), ah(async (req, res) => {
  res.json(await store.all("email_templates"));
}));

app.post("/api/emailing/templates", requireLogin, ah(async (req, res) => {
  const { name, subject, body } = req.body || {};
  if (!name || !subject) return res.status(400).json({ error: "Template name and subject are required" });
  const now = new Date().toISOString().slice(0, 10);
  const row = await store.insert("email_templates", { name, subject, body: body || "", owner_id: req.user.id, created_at: now, updated_at: now });
  res.status(201).json(row);
}));

app.put("/api/emailing/templates/:id", requireLogin, ah(async (req, res) => {
  const { name, subject, body } = req.body || {};
  const patch = { updated_at: new Date().toISOString().slice(0, 10) };
  if (name !== undefined) patch.name = name;
  if (subject !== undefined) patch.subject = subject;
  if (body !== undefined) patch.body = body;
  const row = await store.update("email_templates", req.params.id, patch);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

app.delete("/api/emailing/templates/:id", requireLogin, ah(async (req, res) => {
  const ok = await store.remove("email_templates", req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));

// -- Lists --

app.get("/api/emailing/lists", requireLogin, requireFeature("emailing"), ah(async (req, res) => {
  res.json(await store.all("contact_lists"));
}));

app.post("/api/emailing/lists", requireLogin, ah(async (req, res) => {
  const { name, contact_ids } = req.body || {};
  if (!name) return res.status(400).json({ error: "List name is required" });
  const now = new Date().toISOString().slice(0, 10);
  const row = await store.insert("contact_lists", {
    name,
    contact_ids: Array.isArray(contact_ids) ? contact_ids.map(Number) : [],
    owner_id: req.user.id,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(row);
}));

app.put("/api/emailing/lists/:id", requireLogin, ah(async (req, res) => {
  const { name, contact_ids } = req.body || {};
  const patch = { updated_at: new Date().toISOString().slice(0, 10) };
  if (name !== undefined) patch.name = name;
  if (contact_ids !== undefined) patch.contact_ids = Array.isArray(contact_ids) ? contact_ids.map(Number) : [];
  const row = await store.update("contact_lists", req.params.id, patch);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

app.delete("/api/emailing/lists/:id", requireLogin, ah(async (req, res) => {
  const ok = await store.remove("contact_lists", req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));

app.post("/api/emailing/lists/:id/contacts", requireLogin, ah(async (req, res) => {
  const list = await store.find("contact_lists", req.params.id);
  if (!list) return res.status(404).json({ error: "Not found" });
  const add = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids.map(Number) : [];
  const merged = Array.from(new Set([...(list.contact_ids || []), ...add]));
  const row = await store.update("contact_lists", list.id, { contact_ids: merged, updated_at: new Date().toISOString().slice(0, 10) });
  res.json(row);
}));

app.delete("/api/emailing/lists/:id/contacts/:contactId", requireLogin, ah(async (req, res) => {
  const list = await store.find("contact_lists", req.params.id);
  if (!list) return res.status(404).json({ error: "Not found" });
  const remaining = (list.contact_ids || []).filter((cid) => cid !== Number(req.params.contactId));
  const row = await store.update("contact_lists", list.id, { contact_ids: remaining, updated_at: new Date().toISOString().slice(0, 10) });
  res.json(row);
}));

// -- Sequences --

app.get("/api/emailing/sequences", requireLogin, requireFeature("emailing"), ah(async (req, res) => {
  const sequences = await store.all("sequences");
  const enrollments = await store.all("sequence_enrollments");
  const withCounts = sequences.map((s) => ({
    ...s,
    enrolled_count: enrollments.filter((e) => e.sequence_id === s.id && e.status === "active").length,
    completed_count: enrollments.filter((e) => e.sequence_id === s.id && e.status === "completed").length,
  }));
  res.json(withCounts);
}));

app.post("/api/emailing/sequences", requireLogin, ah(async (req, res) => {
  const { name, steps, active } = req.body || {};
  if (!name) return res.status(400).json({ error: "Sequence name is required" });
  const now = new Date().toISOString().slice(0, 10);
  const row = await store.insert("sequences", {
    name,
    active: Boolean(active),
    steps: normalizeSteps(steps),
    owner_id: req.user.id,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(row);
}));

app.put("/api/emailing/sequences/:id", requireLogin, ah(async (req, res) => {
  const { name, steps, active } = req.body || {};
  const patch = { updated_at: new Date().toISOString().slice(0, 10) };
  if (name !== undefined) patch.name = name;
  if (steps !== undefined) patch.steps = normalizeSteps(steps);
  if (active !== undefined) patch.active = Boolean(active);
  const row = await store.update("sequences", req.params.id, patch);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

app.delete("/api/emailing/sequences/:id", requireLogin, ah(async (req, res) => {
  const ok = await store.remove("sequences", req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  const enrollments = await store.all("sequence_enrollments");
  for (const e of enrollments.filter((e) => e.sequence_id === Number(req.params.id))) {
    await store.remove("sequence_enrollments", e.id);
  }
  res.json({ ok: true });
}));

app.get("/api/emailing/sequences/:id/enrollments", requireLogin, ah(async (req, res) => {
  const enrollments = (await store.all("sequence_enrollments")).filter((e) => e.sequence_id === Number(req.params.id));
  const contacts = await store.all("contacts");
  const enriched = enrollments.map((e) => {
    const c = contacts.find((c) => c.id === e.contact_id);
    return { ...e, contact_name: c ? `${c.first_name} ${c.last_name}`.trim() : "(deleted contact)", contact_email: c?.email || "" };
  });
  res.json(enriched);
}));

app.post("/api/emailing/sequences/:id/enroll", requireLogin, ah(async (req, res) => {
  const sequence = await store.find("sequences", req.params.id);
  if (!sequence) return res.status(404).json({ error: "Not found" });
  let contactIds = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids.map(Number) : [];
  if (req.body?.list_id) {
    const list = await store.find("contact_lists", req.body.list_id);
    if (list) contactIds = Array.from(new Set([...contactIds, ...(list.contact_ids || [])]));
  }
  if (!contactIds.length) return res.status(400).json({ error: "No contacts to enroll" });
  const existing = (await store.all("sequence_enrollments")).filter((e) => e.sequence_id === sequence.id);
  const now = new Date().toISOString();
  const created = [];
  for (const cid of contactIds) {
    if (existing.some((e) => e.contact_id === cid && e.status === "active")) continue;
    const row = await store.insert("sequence_enrollments", {
      sequence_id: sequence.id,
      contact_id: cid,
      status: "active",
      current_step: 0,
      enrolled_at: now,
      next_send_at: now,
      last_sent_at: null,
      completed_at: null,
    });
    created.push(row);
  }
  res.status(201).json({ enrolled: created.length, enrollments: created });
}));

app.post("/api/emailing/enrollments/:id/pause", requireLogin, ah(async (req, res) => {
  const row = await store.update("sequence_enrollments", req.params.id, { status: "paused" });
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

app.post("/api/emailing/enrollments/:id/resume", requireLogin, ah(async (req, res) => {
  const enr = await store.find("sequence_enrollments", req.params.id);
  if (!enr) return res.status(404).json({ error: "Not found" });
  const row = await store.update("sequence_enrollments", enr.id, { status: "active", next_send_at: new Date().toISOString() });
  res.json(row);
}));

app.post("/api/emailing/enrollments/:id/stop", requireLogin, ah(async (req, res) => {
  const row = await store.update("sequence_enrollments", req.params.id, { status: "stopped", next_send_at: null });
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
}));

app.post("/api/emailing/process-due", requireLogin, ah(async (req, res) => {
  const results = await processDueEnrollments(req.user);
  res.json({ processed: results.length, results });
}));

// -- Emails (one-off send + log) --

app.get("/api/emailing/emails", requireLogin, requireFeature("emailing"), ah(async (req, res) => {
  const emails = await store.all("sent_emails");
  const contacts = await store.all("contacts");
  const enriched = emails
    .slice()
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))
    .map((m) => {
      const c = contacts.find((c) => c.id === m.contact_id);
      return { ...m, contact_name: c ? `${c.first_name} ${c.last_name}`.trim() : "(deleted contact)" };
    });
  res.json(enriched);
}));

app.post("/api/emailing/send", requireLogin, ah(async (req, res) => {
  const { contact_id, template_id, subject, body, connection_id } = req.body || {};
  const contact = await store.find("contacts", contact_id);
  if (!contact) return res.status(400).json({ error: "Contact not found" });
  let finalSubject = subject || "";
  let finalBody = body || "";
  if (template_id) {
    const tpl = await store.find("email_templates", template_id);
    if (tpl) {
      finalSubject = finalSubject || tpl.subject;
      finalBody = finalBody || tpl.body;
    }
  }
  if (!finalSubject) return res.status(400).json({ error: "Subject is required" });
  const ctx = await mergeContextForContact(contact, req.user);
  const renderedSubject = renderMerge(finalSubject, ctx);
  const renderedBody = renderMerge(finalBody, ctx);
  const html = renderedBody.replace(/\n/g, "<br>");
  const result = await deliverEmail({ senderUser: req.user, to: contact.email, subject: renderedSubject, html, text: renderedBody, connectionId: connection_id });
  const row = await store.insert("sent_emails", {
    contact_id: contact.id,
    sequence_id: null,
    enrollment_id: null,
    step_order: null,
    subject: renderedSubject,
    body: renderedBody,
    to: contact.email || "",
    sent: result.sent,
    via: result.via || null,
    reason: result.reason || null,
    sent_at: new Date().toISOString(),
    sent_by: req.user.id,
  });
  res.status(201).json(row);
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  // DEBUG_ERRORS is an env var an admin can set in Netlify's site settings
  // to get the real error message back in the response instead of the
  // generic one below -- useful when something fails in production only
  // (e.g. a database connectivity blip) and the function logs aren't handy.
  // Off by default since a raw error message can leak internal details.
  const detail = process.env.DEBUG_ERRORS === "true" ? `: ${err.message}` : "";
  res.status(500).json({ error: `Something went wrong on the server${detail}` });
});

module.exports = app;
