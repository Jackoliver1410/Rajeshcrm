const state = {
  user: null,
  users: [],
  accounts: [],
  contacts: [],
  leads: [],
  leaveTypes: [],
  leaveBalances: [],
  leaveRequests: [],
  activityReports: [],
  salesforce: { connected: false },
  outlookConnections: [],
  holidays: [],
  view: "dashboard",
};

// ---------- API helper ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A response with no `error` field usually isn't from our own API at
    // all -- it's the hosting platform's own timeout/error page (plain
    // HTML, not JSON), most often because the request ran long enough to
    // hit the serverless function's execution limit. Say so instead of the
    // opaque "Request failed", since "it timed out, try something shorter"
    // is actionable and "Request failed" isn't.
    throw new Error(data.error || `Request failed (${res.status}) — it may have taken too long to respond. Try a shorter or simpler request.`);
  }
  return data;
}

// Runs `fn` over every item in `items`, at most `limit` in flight at once,
// and returns results in the same order/shape as Promise.allSettled. Used by
// bulk-delete (Accounts/Contacts): the datastore now serializes writes
// against a single row-level lock (see lib/store.js), so firing a big batch
// -- 30+ rows isn't unusual after a CSV import -- fully in parallel just
// piles every request up waiting on that one lock, and the tail end can sit
// long enough to hit the serverless function's own execution timeout (a 504
// -- the delete typically still lands right after, but the request that
// asked for it never finds out). Capping how many are in flight at once
// keeps each one comfortably inside that timeout instead.
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- Toast ----------

function toast(msg, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---------- Modal ----------

// The modal window (title bar + resize/drag/minimize/maximize) is a single
// shared skeleton in index.html -- every "open*Modal()" function across the
// app just calls openModal(html) to fill #modal-body, so the window chrome
// below applies everywhere automatically, not per-tab.
function resetModalWindowState() {
  const win = document.getElementById("modal-window");
  win.classList.remove("modal-maximized", "modal-minimized");
  win.style.width = "";
  win.style.height = "";
  win.style.left = "";
  win.style.top = "";
  win.style.position = "";
  win.style.margin = "";
  document.getElementById("modal-backdrop").classList.remove("backdrop-minimized");
}

function openModal(html, opts = {}) {
  resetModalWindowState();
  const modalWindow = document.getElementById("modal-window");
  const modalBody = document.getElementById("modal-body");
  modalBody.innerHTML = html;
  modalWindow.classList.toggle("modal-wide", Boolean(opts.wide));
  document.getElementById("modal-backdrop").classList.remove("hidden");
}
function closeModal() {
  document.getElementById("modal-backdrop").classList.add("hidden");
  document.getElementById("modal-body").innerHTML = "";
  resetModalWindowState();
}
// Deliberately no "click outside to close" handler here — a stray click on
// the backdrop (easy to hit, since it's most of the screen) used to wipe
// out whatever was typed or pasted into the open form with no confirmation.
// Every modal has an explicit title-bar Close (x) control; closing now only
// happens via that, a form's own Cancel button, or automatically after a
// form's own successful submit.

function minimizeModal() {
  const win = document.getElementById("modal-window");
  const backdrop = document.getElementById("modal-backdrop");
  const nowMinimized = win.classList.toggle("modal-minimized");
  backdrop.classList.toggle("backdrop-minimized", nowMinimized);
  if (nowMinimized) win.classList.remove("modal-maximized");
}
function maximizeModal() {
  const win = document.getElementById("modal-window");
  const nowMaximized = win.classList.toggle("modal-maximized");
  if (nowMaximized) {
    win.classList.remove("modal-minimized");
    document.getElementById("modal-backdrop").classList.remove("backdrop-minimized");
    // Maximize always fills the viewport from a clean slate, regardless of
    // any manual drag/resize currently applied -- un-maximizing (toggling
    // this again) then falls back to whatever was there before, since we
    // only clear the *class*, not the saved inline width/height/position.
    win.style.position = "";
    win.style.left = "";
    win.style.top = "";
    win.style.margin = "";
  }
}
function restoreModal() {
  const win = document.getElementById("modal-window");
  win.classList.remove("modal-minimized", "modal-maximized");
  document.getElementById("modal-backdrop").classList.remove("backdrop-minimized");
}

(function setupModalWindowChrome() {
  const win = document.getElementById("modal-window");
  const titlebar = document.getElementById("modal-titlebar");
  const minBtn = document.getElementById("modal-min-btn");
  const maxBtn = document.getElementById("modal-max-btn");
  const closeBtn = document.getElementById("modal-close-btn");

  minBtn.addEventListener("click", (e) => { e.stopPropagation(); minimizeModal(); });
  maxBtn.addEventListener("click", (e) => { e.stopPropagation(); maximizeModal(); });
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeModal(); });

  // Clicking the collapsed title bar of a minimized window restores it
  // (clicks on the control buttons themselves are handled above and don't
  // bubble down to this because of stopPropagation).
  titlebar.addEventListener("click", () => {
    if (win.classList.contains("modal-minimized")) restoreModal();
  });

  // Drag-to-move by the title bar, like a real window -- only while the
  // window is in its normal (not maximized/minimized) state.
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  titlebar.addEventListener("mousedown", (e) => {
    if (e.target.closest(".modal-ctrl")) return;
    if (win.classList.contains("modal-maximized") || win.classList.contains("modal-minimized")) return;
    const rect = win.getBoundingClientRect();
    win.style.position = "fixed";
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    win.style.margin = "0";
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    dragging = true;
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = win.getBoundingClientRect();
    let newLeft = startLeft + (e.clientX - startX);
    let newTop = startTop + (e.clientY - startY);
    newLeft = Math.max(-rect.width + 120, Math.min(newLeft, window.innerWidth - 120));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
    win.style.left = `${newLeft}px`;
    win.style.top = `${newTop}px`;
  });
  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = "";
    }
  });

  // Free resize by dragging the bottom-right handle. Implemented by hand
  // (mousemove math) rather than the native CSS `resize` property: `.modal`
  // is a flex item of the centering backdrop, and browsers don't reliably
  // apply native resize to flex items -- the handle shows but dragging it
  // does nothing. Tracking the drag ourselves and setting width/height
  // directly works the same way regardless of the parent's layout mode.
  const resizeHandle = document.getElementById("modal-resize-handle");
  let resizing = false;
  let rStartX = 0, rStartY = 0, rStartW = 0, rStartH = 0;

  resizeHandle.addEventListener("mousedown", (e) => {
    if (win.classList.contains("modal-maximized") || win.classList.contains("modal-minimized")) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = win.getBoundingClientRect();
    // Anchor the window's top-left in place (same trick as drag-to-move)
    // so growing/shrinking happens from the bottom-right corner under the
    // cursor, instead of the flex-centered box re-centering underneath us
    // mid-drag.
    win.style.position = "fixed";
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    win.style.margin = "0";
    win.style.width = `${rect.width}px`;
    win.style.height = `${rect.height}px`;
    rStartX = e.clientX;
    rStartY = e.clientY;
    rStartW = rect.width;
    rStartH = rect.height;
    resizing = true;
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const minWidth = 320, minHeight = 200;
    const maxWidth = window.innerWidth * 0.97;
    const maxHeight = window.innerHeight * 0.95;
    let newWidth = rStartW + (e.clientX - rStartX);
    let newHeight = rStartH + (e.clientY - rStartY);
    newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
    newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
    win.style.width = `${newWidth}px`;
    win.style.height = `${newHeight}px`;
  });
  window.addEventListener("mouseup", () => {
    if (resizing) {
      resizing = false;
      document.body.style.userSelect = "";
    }
  });
})();

function sfRecordUrl(sobject, sfId) {
  const base = (state.salesforce?.instance_url || "").replace(/\/$/, "");
  if (!base || !sfId) return null;
  return `${base}/lightning/r/${sobject}/${sfId}/view`;
}

// ---------- Lookups ----------

const byId = (arr, id) => arr.find((x) => x.id === Number(id));
const userName = (id) => byId(state.users, id)?.name || "Unassigned";
const accountName = (id) => (id ? byId(state.accounts, id)?.name : "") || "—";
const contactName = (id) => {
  const c = id ? byId(state.contacts, id) : null;
  return c ? `${c.first_name} ${c.last_name}` : "—";
};
const money = (n) => "$" + Number(n || 0).toLocaleString();

// ---------- Theme ----------

const FONT_STACKS = {
  system: `"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif`,
  serif: `Georgia, "Times New Roman", serif`,
  rounded: `Verdana, Tahoma, sans-serif`,
  mono: `Consolas, "SF Mono", Menlo, monospace`,
  modern: `"Segoe UI", Calibri, Arial, sans-serif`,
};
const FONT_LABELS = {
  system: "System Default",
  serif: "Classic Serif",
  rounded: "Rounded Sans",
  mono: "Monospace",
  modern: "Modern Sans",
};

const DENSITY_LABELS = { compact: "Compact", comfortable: "Comfortable", spacious: "Spacious" };
const DENSITY_DESCRIPTIONS = {
  compact: "Tighter rows, more on screen at once",
  comfortable: "The current default spacing",
  spacious: "Roomier rows, easier to scan",
};

function applyTheme(theme) {
  const t = theme || {};
  const root = document.documentElement;
  root.style.setProperty("--teal", t.primary || "#22c55e");
  root.style.setProperty("--violet", t.accent || "#1e3ae8");
  root.style.setProperty("--font-family", FONT_STACKS[t.font] || FONT_STACKS.system);
  // Table row/font density, app-wide -- every <table> reads these CSS vars
  // (see styles.css body[data-density=...]), so one attribute here covers
  // Contacts, Accounts, Leads, Activity Report, etc. all at once. Omitting
  // the attribute entirely for "comfortable" (rather than setting it to
  // that value) keeps the default state matching what the CSS already
  // ships with, with nothing to override.
  if (t.density && t.density !== "comfortable") {
    document.body.setAttribute("data-density", t.density);
  } else {
    document.body.removeAttribute("data-density");
  }
}

// ---------- Resizable table columns/rows (drag or keyboard) ----------
// Applies automatically to every <table> in the app -- Contacts, Accounts,
// Leads, Activity Report, any table inside a modal -- via a MutationObserver
// below, so no individual render function needs to opt in. A column gets a
// drag handle on its header's right edge; a row gets one on its last cell's
// bottom edge. Mouse: drag. Keyboard: Tab to a handle, then arrow keys
// (Shift = bigger step). Sizes are remembered per browser (localStorage),
// keyed to the table's own header text plus each row's own id, so
// re-rendering the same table (a filter change, editing a row) restores
// what the user set without needing a server round trip, and an unrelated
// table never inherits someone else's widths.

function tableResizeKey(table) {
  const headers = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim()).join("|");
  return `tbl-resize:${headers}`;
}

function loadResizeState(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}

function saveResizeState(key, state) {
  try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* storage full/blocked -- resizing still works for this session */ }
}

function makeTableResizable(table) {
  if (table.dataset.resizable) return;
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (!thead || !tbody || !thead.rows.length) return;
  table.dataset.resizable = "1";
  table.classList.add("resizable-table");

  const key = tableResizeKey(table);
  const state = loadResizeState(key);
  state.cols = state.cols || {};
  state.rows = state.rows || {};

  // Freeze the table's current (content-driven) column widths into a
  // <colgroup> before switching to table-layout:fixed, so turning on
  // resizing doesn't itself reflow anything -- then apply any saved
  // widths from a previous visit on top.
  const ths = Array.from(thead.rows[0].cells);
  const colgroup = document.createElement("colgroup");
  ths.forEach((th, i) => {
    const col = document.createElement("col");
    col.style.width = `${Math.round(state.cols[i] || th.getBoundingClientRect().width)}px`;
    colgroup.appendChild(col);
  });
  table.insertBefore(colgroup, table.firstChild);
  table.style.tableLayout = "fixed";
  const cols = Array.from(colgroup.children);

  function setColWidth(i, px) {
    const w = Math.max(40, Math.round(px));
    if (cols[i]) cols[i].style.width = `${w}px`;
    state.cols[i] = w;
    saveResizeState(key, state);
  }

  ths.forEach((th, i) => {
    const handle = document.createElement("span");
    handle.className = "col-resize-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = "Drag to resize this column — or focus it and press ← →";
    th.appendChild(handle);

    let startX, startW;
    const onMove = (e) => setColWidth(i, startW + (e.clientX - startX));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startW = parseFloat(cols[i].style.width);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    handle.addEventListener("keydown", (e) => {
      const cur = parseFloat(cols[i].style.width);
      const step = e.shiftKey ? 24 : 8;
      if (e.key === "ArrowLeft") { e.preventDefault(); setColWidth(i, cur - step); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setColWidth(i, cur + step); }
    });
  });

  // Row height: keyed by that row's own record id (data-contact/-account/
  // -lead/-activity, whichever the row carries) so a saved height still
  // lands on the right row after sorting/filtering re-orders the table --
  // falling back to position only for rows with no such id.
  Array.from(tbody.rows).forEach((tr, idx) => {
    const rowKey = tr.dataset.contact || tr.dataset.account || tr.dataset.lead || tr.dataset.activity || `pos-${idx}`;
    const savedH = state.rows[rowKey];
    if (savedH) tr.style.height = `${savedH}px`;
    const lastCell = tr.cells[tr.cells.length - 1];
    if (!lastCell) return;

    const handle = document.createElement("span");
    handle.className = "row-resize-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.title = "Drag to resize this row — or focus it and press ↑ ↓";
    lastCell.appendChild(handle);

    function setRowHeight(px) {
      const h = Math.max(24, Math.round(px));
      tr.style.height = `${h}px`;
      state.rows[rowKey] = h;
      saveResizeState(key, state);
    }

    let startY, startH;
    const onMove = (e) => setRowHeight(startH + (e.clientY - startY));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startY = e.clientY;
      startH = tr.getBoundingClientRect().height;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    handle.addEventListener("keydown", (e) => {
      const cur = tr.getBoundingClientRect().height;
      const step = e.shiftKey ? 24 : 8;
      if (e.key === "ArrowUp") { e.preventDefault(); setRowHeight(cur - step); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setRowHeight(cur + step); }
    });
  });
}

function enhanceResizableTables(container) {
  container.querySelectorAll("table").forEach((table) => {
    // Only real data grids qualify -- skip the Font/Density preview
    // "cards" grid and any table-less layout helpers that happen to match.
    if (!table.querySelector("thead") || !table.querySelector("tbody")) return;
    if (!table.querySelector("thead th")) return;
    makeTableResizable(table);
  });
}

// One observer, registered once at script load (before login even), covers
// every table for the lifetime of the page -- each render function
// (renderContacts, renderAccounts, ...) replaces view-root's innerHTML
// wholesale, and this just notices the new <table> nodes as they appear.
const resizableTableObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.addedNodes.length) enhanceResizableTables(m.target.nodeType === 1 ? m.target : document.body);
  }
});
["view-root", "modal-body"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) resizableTableObserver.observe(el, { childList: true, subtree: true });
});

// ---------- Sidebar collapse ----------
// The whole left rail (logo, profile, nav, sign-out) can be hidden to
// reclaim screen width -- a small button in the sidebar's own top-right
// corner hides it, and a matching themed tab pinned to the top-left corner
// of the screen brings it back. Wired here at top level (not inside
// bootstrap()) since both buttons exist statically in index.html from page
// load, and persisted per-browser so a user who hides it doesn't have to
// redo that every time they come back.
function setSidebarCollapsed(collapsed) {
  if (collapsed) document.body.setAttribute("data-sidebar", "collapsed");
  else document.body.removeAttribute("data-sidebar");
  try { localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0"); } catch { /* storage full/blocked */ }
}
document.getElementById("sidebar-collapse-btn")?.addEventListener("click", () => setSidebarCollapsed(true));
document.getElementById("sidebar-expand-btn")?.addEventListener("click", () => setSidebarCollapsed(false));
try {
  if (localStorage.getItem("sidebarCollapsed") === "1") setSidebarCollapsed(true);
} catch { /* storage blocked -- default to expanded */ }

// ---------- Auth ----------

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const remember = document.getElementById("login-remember").checked;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    const { user } = await api("/api/login", { method: "POST", body: { email, password, remember } });
    state.user = user;
    applyTheme(user.theme);
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app-shell").classList.add("active");
    await bootstrap();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ---------- Forgot / reset password ----------
// "Forgot password?" opens a small modal (reuses the app-wide modal system,
// whose backdrop lives outside #app-shell so it's usable pre-login) asking
// for the work email, then always shows the same confirmation message --
// the backend intentionally never reveals whether that email had an
// account, so this can't be used to probe who has a login.
document.getElementById("login-forgot-link").addEventListener("click", (e) => {
  e.preventDefault();
  openModal(`
    <h3>Reset your password</h3>
    <form id="forgot-password-form">
      <label for="forgot-email">Work email</label>
      <input id="forgot-email" type="email" required autocomplete="username" value="${document.getElementById("login-email").value.replace(/"/g, "&quot;")}" />
      <div class="error-text" id="forgot-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn" id="forgot-cancel-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Send reset link</button>
      </div>
    </form>
  `);
  document.getElementById("forgot-cancel-btn").addEventListener("click", closeModal);
  document.getElementById("forgot-password-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = document.getElementById("forgot-email").value;
    const errEl = document.getElementById("forgot-error");
    errEl.textContent = "";
    try {
      await api("/api/auth/forgot-password", { method: "POST", body: { email } });
      document.getElementById("modal-body").innerHTML = `
        <h3>Check your email</h3>
        <p>If an account exists for <strong>${email.replace(/</g, "&lt;")}</strong>, a password reset link is on its way. The link is valid for 1 hour.</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" id="forgot-done-btn">Done</button>
        </div>
      `;
      document.getElementById("forgot-done-btn").addEventListener("click", closeModal);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
});

// A reset link looks like https://.../?reset=<token> -- on load, if that
// query param is present, prompt for a new password before showing the
// normal login screen at all (regardless of whether anyone's already
// signed in on this browser).
function maybeShowResetPasswordModal() {
  const params = new URLSearchParams(location.search);
  const token = params.get("reset");
  if (!token) return false;
  history.replaceState(null, "", location.pathname);
  openModal(`
    <h3>Set a new password</h3>
    <form id="reset-password-form">
      <label for="reset-password-input">New password</label>
      <input id="reset-password-input" type="password" autocomplete="new-password" required minlength="6" />
      <label for="reset-password-confirm">Confirm new password</label>
      <input id="reset-password-confirm" type="password" autocomplete="new-password" required minlength="6" />
      <div class="error-text" id="reset-password-error"></div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-primary">Set password</button>
      </div>
    </form>
  `);
  document.getElementById("reset-password-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pw = document.getElementById("reset-password-input").value;
    const confirm = document.getElementById("reset-password-confirm").value;
    const errEl = document.getElementById("reset-password-error");
    errEl.textContent = "";
    if (pw !== confirm) {
      errEl.textContent = "Passwords don't match";
      return;
    }
    try {
      await api("/api/auth/reset-password", { method: "POST", body: { token, password: pw } });
      document.getElementById("modal-body").innerHTML = `
        <h3>Password updated</h3>
        <p>Your password has been reset. You can sign in now.</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" id="reset-done-btn">Sign in</button>
        </div>
      `;
      document.getElementById("reset-done-btn").addEventListener("click", closeModal);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
  return true;
}
maybeShowResetPasswordModal();

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

async function tryResumeSession() {
  try {
    const { user } = await api("/api/me");
    state.user = user;
    applyTheme(user.theme);
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app-shell").classList.add("active");
    await bootstrap();
  } catch {
    // not logged in - show login screen (default state)
  }
}

// ---------- Bootstrap & navigation ----------

// data-view value -> feature_access key from Settings > Access Control.
// A tab not listed here (Dashboard, Contacts, Accounts, Leaves/WFH) is
// always visible -- feature toggles only apply to the six gated features.
const NAV_FEATURE_KEYS = {
  emailing: "emailing",
  activity: "activity_report",
  leads: "leads",
};

// Admin always sees every tab. Everyone else: hide (not just disable) a
// nav item their feature_access has turned off, so it doesn't dangle as a
// dead link -- the backend blocks the underlying routes too (requireFeature
// in lib/auth.js), this is just keeping the sidebar honest about it.
function hideDisabledNavItems() {
  if (state.user.role === "admin") return;
  const access = state.user.feature_access || {};
  for (const [view, key] of Object.entries(NAV_FEATURE_KEYS)) {
    if (access[key] === false) {
      document.querySelectorAll(`.nav-item[data-view="${view}"]`).forEach((el) => el.classList.add("hidden"));
    }
  }
}

async function bootstrap() {
  document.getElementById("current-user-name").textContent = state.user.name;
  document.getElementById("current-user-role").textContent = roleLabel(state.user.role);
  // Regular reps only ever see their own leads (enforced by GET /api/leads
  // scoping too, this is just the label) — "My Leads" is more honest than
  // "Leads" when that's all they'll ever see. Managers/admins see their
  // team's/everyone's, so "Leads" fits.
  const navLeads = document.getElementById("nav-leads");
  if (navLeads) navLeads.textContent = ["admin", "manager"].includes(state.user.role) ? "Leads" : "My Leads";
  VIEW_TITLES.leads = navLeads ? navLeads.textContent : "Leads";
  hideDisabledNavItems();
  renderSidebarProfile();
  document.getElementById("sidebar-profile-btn").addEventListener("click", openProfileModal);
  await loadAll();
  wireNav();

  const params = new URLSearchParams(window.location.search);
  const integration = params.get("integration");
  if (integration === "salesforce_connected" || integration === "outlook_connected") {
    window.history.replaceState({}, "", window.location.pathname);
    settingsTab = "integrations";
    switchView("settings");
    toast(integration === "salesforce_connected" ? "Salesforce connected" : "Outlook connected");
  } else {
    switchView("dashboard");
  }
}

function renderSidebarProfile() {
  document.getElementById("sidebar-profile-name").textContent = state.user.name;
  document.getElementById("sidebar-profile-title").textContent = state.user.title || roleLabel(state.user.role);
}

// ---------- Editable profile ----------

function openProfileModal() {
  const u = state.user;
  openModal(`
    <h2>Your profile</h2>
    <form id="profile-form">
      <label>Name</label><input name="name" value="${escapeAttr(u.name || "")}" required />
      <label>Email</label><input name="email" type="email" value="${escapeAttr(u.email || "")}" required />
      <label>Contact number</label><input name="phone" value="${escapeAttr(u.phone || "")}" />
      <label>Role (designation)</label><input name="title" value="${escapeAttr(u.title || "")}" placeholder="e.g. Account Executive" />
      <div class="error-text" id="profile-form-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save changes</button>
      </div>
    </form>

    <hr style="margin:20px 0;border:none;border-top:1px solid var(--border)" />

    <h2>Change password</h2>
    <form id="password-form">
      <label>Current password</label><input name="current_password" type="password" required autocomplete="current-password" />
      <label>New password</label><input name="new_password" type="password" required minlength="6" autocomplete="new-password" />
      <div class="hint" style="margin-top:-4px">At least 6 characters.</div>
      <div class="error-text" id="password-form-error"></div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-primary">Update password</button>
      </div>
    </form>
  `);
  document.getElementById("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      const { user } = await api("/api/me/profile", { method: "PUT", body: fd });
      state.user = user;
      document.getElementById("current-user-name").textContent = user.name;
      renderSidebarProfile();
      toast("Profile updated");
      closeModal();
    } catch (err) {
      document.getElementById("profile-form-error").textContent = err.message;
    }
  });
  document.getElementById("password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const errEl = document.getElementById("password-form-error");
    errEl.textContent = "";
    try {
      await api("/api/me/password", { method: "PUT", body: fd });
      toast("Password updated");
      e.target.reset();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Every LinkedIn/Sales Navigator/Salesforce URL field in the app used to be
// <input type="url">, which triggers the browser's own "Please enter a URL"
// validation -- and that validation demands a full absolute URL with an
// http(s):// scheme. "www.linkedin.com/in/x" or "linkedin.com/in/x" (exactly
// what someone naturally types or pastes, without thinking to add the
// scheme) both fail it and block submission, even though they're perfectly
// usable once a scheme is added. These fields are plain type="text" now, and
// this runs on save instead: leave a value with a scheme alone, add
// "https://" to one without, leave blank alone. No more manual "https://" or
// "www." required, and nothing here can produce a browser validation error.
function normalizeUrlInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function roleLabel(role) {
  return { admin: "Admin", manager: "Manager", sub_admin: "Sub-Admin", sales_rep: "Sales Rep", hr: "HR" }[role] || role;
}

async function loadAll() {
  const [users, accounts, contacts, leads, leaveTypes, leaveRequests, activityReports, sfStatus, outlookConnections, holidays] = await Promise.all([
    api("/api/users"),
    api("/api/accounts"),
    api("/api/contacts"),
    api("/api/leads").catch(() => []), // 403 if Leads is disabled for this user via feature_access
    api("/api/leave-types"),
    api("/api/leave-requests"),
    api("/api/activity-reports").catch(() => []), // 403 if Activity Report is disabled
    api("/api/salesforce/status").catch(() => ({ connected: false })),
    api("/api/outlook/connections").catch(() => []),
    api("/api/holidays").catch(() => []),
  ]);
  state.users = users;
  state.accounts = accounts;
  state.contacts = contacts;
  state.leads = leads;
  state.leaveTypes = leaveTypes;
  state.leaveRequests = leaveRequests;
  state.activityReports = activityReports;
  state.salesforce = sfStatus;
  state.outlookConnections = outlookConnections;
  state.holidays = holidays;
  state.leaveBalances = await api(`/api/leave-balances?user_id=${state.user.id}`);

  setBadge("leave-badge", leaveRequests.filter((r) => r.current_approver_id === state.user.id).length);
  setBadge("activity-badge", activityReports.filter((r) => r.current_approver_id === state.user.id && r.status === "pending").length);
}

function setBadge(id, count) {
  const badge = document.getElementById(id);
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function wireNav() {
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => {
      // A direct sidebar click always means "show me everything" — the
      // Dashboard's scoped drill-down only applies when it sets the filter
      // and switches views itself, not on normal navigation.
      if (el.dataset.view === "accounts") accountsScopeFilter = null;
      if (el.dataset.view === "contacts") contactsScopeFilter = null;
      switchView(el.dataset.view);
    });
  });
  document.getElementById("settings-gear-btn").addEventListener("click", () => switchView("settings"));
}

const VIEW_TITLES = {
  dashboard: "Dashboard",
  leads: "Leads",
  contacts: "Contacts",
  accounts: "Accounts",
  activity: "Activity Report",
  leave: "Leaves / WFH",
  emailing: "Emailing",
  settings: "Settings",
};

function switchView(view) {
  // An open Contacts header-filter popover lives on <body>, outside
  // #view-root, specifically so it survives that view's own re-renders --
  // which also means it has to be closed by hand on the way to any other
  // view, or it'd be left floating over whatever's rendered next.
  if (typeof closeHeaderFilterPopover === "function") closeHeaderFilterPopover();
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  document.getElementById("settings-gear-btn").classList.toggle("active-icon", view === "settings");
  document.getElementById("view-title").textContent = VIEW_TITLES[view];
  document.getElementById("view-title-extra").innerHTML = "";
  const renderers = {
    dashboard: renderDashboard,
    leads: renderLeads,
    contacts: renderContacts,
    accounts: renderAccounts,
    activity: renderActivity,
    leave: renderLeave,
    emailing: renderEmailing,
    settings: renderSettings,
  };
  renderers[view]();
}

// ---------- Dashboard ----------

// ---------- Dashboard visuals ----------
// Small inline stroke icons (currentColor-based, so they pick up whatever
// accent color wraps them) -- kept dependency-free rather than pulling in an
// icon font/library for four glyphs.
const DASH_ICONS = {
  building: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M6 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16"/><path d="M14 21v-8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v8"/><path d="M9 7h1M9 11h1M9 15h1"/></svg>`,
  target: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`,
  calendar: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>`,
  bell: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
  users: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  send: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>`,
};

// Follow-up Pipeline: Fresh Email (the one-off first-touch send, step_order
// null) plus step_order 1-5 from sent_emails, colored on a
// brand-consistent amber-to-blue ramp so Fresh reads as "just sent" and
// stage 5 reads as "deep in the cadence."
const FOLLOWUP_ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];
const FOLLOWUP_STAGE_COLORS = ["#22c55e", "#16b378", "#0ea5a0", "#1c7fe0", "#1e3ae8"];
const FRESH_EMAIL_COLOR = "#f59e0b";

// Shared metrics rows for every Follow-up Pipeline card (Fresh Email + the
// 5 numbered stages) -- Today/This Week frame the icon+label from above,
// This Month/Pending frame it from below, so the card reads as a diamond
// with the stage's identity in the middle and its four numbers pinned to
// the four corners around it.
function followupStageTopRowHtml(stage) {
  return `
    <div class="followup-stage-metrics">
      <div class="followup-stage-metric"><span class="followup-stage-metric-value">${stage.today}</span><span class="followup-stage-metric-label">Today</span></div>
      <div class="followup-stage-metric"><span class="followup-stage-metric-value">${stage.week}</span><span class="followup-stage-metric-label">This Week</span></div>
    </div>
  `;
}
function followupStageBottomRowHtml(stage) {
  return `
    <div class="followup-stage-metrics">
      <div class="followup-stage-metric"><span class="followup-stage-metric-value">${stage.month}</span><span class="followup-stage-metric-label">This Month</span></div>
      <div class="followup-stage-metric"><span class="followup-stage-metric-value">${stage.pending}</span><span class="followup-stage-metric-label">Pending</span></div>
    </div>
  `;
}

// Set by clicking a Follow-up Pipeline stage on the Dashboard; consumed by
// renderEmailingEmails() to land on a pre-filtered view instead of the full
// unfiltered log -- this is the "interlink" between Dashboard and Emailing.
let emailingEmailsStepFilter = null;

async function renderDashboard() {
  document.getElementById("topbar-actions").innerHTML = "";
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;

  let stats;
  try {
    stats = await api("/api/dashboard/stats");
  } catch (err) {
    root.innerHTML = `<div class="panel"><div class="empty-state">${err.message}</div></div>`;
    return;
  }

  // Managers/admins/HR approve other people's leave, so their "pending"
  // number should mean their team's approvals waiting on them. Everyone
  // else doesn't approve anything, so it means their own requests that
  // haven't been approved yet -- two different questions, same card.
  const isApprover = ["manager", "admin", "hr"].includes(state.user.role);
  const leavePendingCount = isApprover
    ? state.leaveRequests.filter((r) => r.current_approver_id === state.user.id).length
    : state.leaveRequests.filter((r) => r.user_id === state.user.id && ["pending_manager", "pending_hr"].includes(r.status)).length;
  const leavePendingLabel = isApprover ? "Approve/Pending" : "My Requests Pending Approval";
  // Backend-computed so the sub-labels always match whichever month/year the
  // figures next to them are actually bucketed by; fall back gracefully if
  // an older cached response doesn't have it yet.
  const monthLabel = stats.period_labels?.month || "This month";
  const yearLabel = stats.period_labels?.year || "This year";

  const role = state.user.role;
  const directReports = state.users.filter((u) => u.manager_id === state.user.id);
  const showScopeSelector = role === "admin" || role === "manager";

  let scopeOptionsHtml = "";
  if (role === "admin") {
    scopeOptionsHtml = `
      <option value="">Whole company</option>
      <option value="${state.user.id}">Just me</option>
      ${state.users.filter((u) => u.id !== state.user.id).map((u) => `<option value="${u.id}">${u.name}</option>`).join("")}
    `;
  } else if (role === "manager") {
    scopeOptionsHtml = `
      <option value="">My team (combined)</option>
      <option value="${state.user.id}">Just me</option>
      ${directReports.map((u) => `<option value="${u.id}">${u.name}</option>`).join("")}
    `;
  }

  root.innerHTML = `
    <div class="stat-grid stat-grid-6">
      <div class="stat-card clickable" id="total-companies-card" title="View these companies">
        <div class="stat-card-icon icon-teal">${DASH_ICONS.building}</div>
        <div class="label">Total Companies</div>
        <div class="value accent-teal">${stats.total_companies}</div>
      </div>
      <div class="stat-card clickable" id="total-contacts-card" title="View these contacts">
        <div class="stat-card-icon icon-teal">${DASH_ICONS.users}</div>
        <div class="label">Total Contacts</div>
        <div class="value accent-teal">${stats.total_contacts}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon icon-amber">${DASH_ICONS.target}</div>
        <div class="label">Leads Achieved</div>
        <div style="display:flex;gap:20px;margin-top:4px">
          <div><div class="value accent-amber" style="font-size:22px;line-height:1.3">${stats.leads_achieved_month}</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">${monthLabel}</div></div>
          <div><div class="value accent-amber" style="font-size:22px;line-height:1.3">${stats.leads_achieved_year}</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">${yearLabel}</div></div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon icon-violet">${DASH_ICONS.calendar}</div>
        <div class="label">Leaves</div>
        <div style="display:flex;gap:20px;margin-top:4px">
          <div><div class="value" style="font-size:22px;line-height:1.3">${stats.my_leave.leave.month_days}</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">${monthLabel}</div></div>
          <div><div class="value" style="font-size:22px;line-height:1.3">${stats.my_leave.leave.year_days}</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">${yearLabel}</div></div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon icon-violet">${DASH_ICONS.calendar}</div>
        <div class="label">WFH</div>
        <div style="display:flex;gap:20px;margin-top:4px">
          <div><div class="value" style="font-size:22px;line-height:1.3">${stats.my_leave.wfh.month_days}</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">${monthLabel}</div></div>
          <div><div class="value" style="font-size:22px;line-height:1.3">${stats.my_leave.wfh.year_days}</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">${yearLabel}</div></div>
        </div>
      </div>
      <div class="stat-card clickable" id="leave-pending-card" title="${isApprover ? "Go approve these requests" : "View your pending requests"}">
        <div class="stat-card-icon icon-coral">${DASH_ICONS.bell}</div>
        <div class="label">${leavePendingLabel}</div>
        <div class="value accent-coral">${leavePendingCount}</div>
      </div>
    </div>
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:0">
        <h2 style="margin:0">Follow-up Pipeline</h2>
        <span style="font-size:12px;color:var(--text-dim)">Live from Emailing sequences — click a stage to see those sends</span>
      </div>
      <div class="followup-stepper">
        <div class="followup-stage" data-step="fresh" style="--stage-color:${FRESH_EMAIL_COLOR}" title="View Fresh Email sends">
          ${followupStageTopRowHtml(stats.fresh_email_stage)}
          <div class="followup-stage-num followup-stage-icon">${DASH_ICONS.send}</div>
          <div class="followup-stage-label">Fresh Email</div>
          ${followupStageBottomRowHtml(stats.fresh_email_stage)}
          <div class="followup-stage-sub">${stats.fresh_email_stage.total} total sent</div>
        </div>
        ${FOLLOWUP_ORDINALS.map((label, i) => {
          const stage = stats.followup_stages[i];
          const connector = `<div class="followup-stage-connector"></div>`;
          return `${connector}
            <div class="followup-stage" data-step="${i + 1}" style="--stage-color:${FOLLOWUP_STAGE_COLORS[i]}" title="View ${label} Followup sends">
              ${followupStageTopRowHtml(stage)}
              <div class="followup-stage-num">${i + 1}</div>
              <div class="followup-stage-label">${label} Followup</div>
              ${followupStageBottomRowHtml(stage)}
              <div class="followup-stage-sub">${stage.total} total sent</div>
            </div>`;
        }).join("")}
      </div>
    </div>
    <div class="panel" id="activity-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <h2 style="margin:0">Activity</h2>
        <div style="display:flex;gap:8px;align-items:center">
          ${showScopeSelector ? `<select id="dash-scope" style="width:auto">${scopeOptionsHtml}</select>` : ""}
          ${role === "admin" ? `<button class="btn btn-small" id="assign-users-btn">Assign users</button>` : ""}
        </div>
      </div>
      <div id="activity-stats"><div class="empty-state">Loading…</div></div>
    </div>
    <div class="panel">
      <h2>Recent leads</h2>
      ${renderLeadsTable(state.leads.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 6))}
    </div>
  `;

  const scopeSelect = document.getElementById("dash-scope");
  if (scopeSelect) scopeSelect.addEventListener("change", () => loadActivityStats(scopeSelect.value));
  const assignBtn = document.getElementById("assign-users-btn");
  if (assignBtn) assignBtn.addEventListener("click", openAssignUsersModal);

  document.getElementById("total-companies-card").addEventListener("click", () => {
    // Same owner scope that produced this number (self / team / company),
    // so the Accounts list that opens actually matches the count clicked.
    accountsScopeFilter = stats.scope_user_ids;
    switchView("accounts");
  });

  document.getElementById("total-contacts-card").addEventListener("click", () => {
    // Same pattern as Total Companies above -- the Contacts list that opens
    // is filtered to the exact scope (self / team / company) this count
    // came from.
    contactsScopeFilter = stats.scope_user_ids;
    switchView("contacts");
  });

  document.getElementById("leave-pending-card").addEventListener("click", () => {
    // The Leave/WFH page already puts "Pending your approval" as the first
    // panel for approvers (and "My requests" for everyone else right below
    // it), so just landing on that view surfaces exactly what this count
    // was counting -- no extra filter state needed.
    switchView("leave");
  });

  root.querySelectorAll("[data-step]").forEach((el) => {
    el.addEventListener("click", () => {
      // "fresh" is a string sentinel, not a numeric step -- Fresh Email
      // sends carry step_order: null, and 0 would be falsy everywhere this
      // filter is checked, so it can't double as the sentinel itself.
      emailingEmailsStepFilter = el.dataset.step === "fresh" ? "fresh" : Number(el.dataset.step);
      emailingTab = "emails";
      switchView("emailing");
    });
  });

  // Reuse the stats already fetched above for the top cards instead of
  // firing a second identical request just to populate the Activity panel.
  renderActivityStatsInto(stats);
}

async function loadActivityStats(userId) {
  const activityEl = document.getElementById("activity-stats");
  if (!activityEl) return;
  activityEl.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const qs = userId ? `?user_ids=${encodeURIComponent(userId)}` : "";
    const stats = await api(`/api/dashboard/stats${qs}`);
    renderActivityStatsInto(stats);
  } catch (err) {
    activityEl.innerHTML = `<div class="empty-state">${err.message}</div>`;
  }
}

function renderActivityStatsInto(stats) {
  const activityEl = document.getElementById("activity-stats");
  if (!activityEl) return;
  try {
    activityEl.innerHTML = `
      <div class="section-label"><span class="dot" style="background:var(--teal)"></span>Emails sent</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Today</div><div class="value accent-teal">${stats.emails.today}</div></div>
        <div class="stat-card"><div class="label">This Week</div><div class="value accent-teal">${stats.emails.week}</div></div>
        <div class="stat-card"><div class="label">This Month</div><div class="value accent-teal">${stats.emails.month}</div></div>
      </div>
      <div class="section-label"><span class="dot" style="background:var(--amber)"></span>Leads generated</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Today</div><div class="value accent-amber">${stats.leads.today}</div></div>
        <div class="stat-card"><div class="label">This Week</div><div class="value accent-amber">${stats.leads.week}</div></div>
        <div class="stat-card"><div class="label">This Month</div><div class="value accent-amber">${stats.leads.month}</div></div>
        <div class="stat-card"><div class="label">This Year</div><div class="value accent-amber">${stats.leads.year}</div></div>
      </div>
      <div class="section-label"><span class="dot" style="background:var(--text-dim)"></span>Contacts added</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Today</div><div class="value">${stats.contacts.today}</div></div>
        <div class="stat-card"><div class="label">This Week</div><div class="value">${stats.contacts.week}</div></div>
        <div class="stat-card"><div class="label">This Month</div><div class="value">${stats.contacts.month}</div></div>
      </div>
      <div class="section-label"><span class="dot" style="background:var(--violet)"></span>Followups done (self-reported)</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Today</div><div class="value accent-violet">${stats.followups.today}</div></div>
        <div class="stat-card"><div class="label">This Week</div><div class="value accent-violet">${stats.followups.week}</div></div>
        <div class="stat-card"><div class="label">This Month</div><div class="value accent-violet">${stats.followups.month}</div></div>
      </div>
      <div class="section-label"><span class="dot" style="background:var(--violet)"></span>Companies added</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Today</div><div class="value accent-violet">${stats.companies.today}</div></div>
        <div class="stat-card"><div class="label">This Week</div><div class="value accent-violet">${stats.companies.week}</div></div>
        <div class="stat-card"><div class="label">This Month</div><div class="value accent-violet">${stats.companies.month}</div></div>
      </div>
      <div class="section-label"><span class="dot" style="background:var(--coral)"></span>Leaves / WFH — this month</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Days Booked</div><div class="value accent-coral">${stats.leave.days}</div></div>
        <div class="stat-card"><div class="label">Requests</div><div class="value accent-coral">${stats.leave.requests}</div></div>
      </div>
    `;
  } catch (err) {
    activityEl.innerHTML = `<div class="empty-state">${err.message}</div>`;
  }
}

async function openAssignUsersModal() {
  const users = state.users;
  const managers = users.filter((u) => u.role === "admin" || u.role === "manager");
  openModal(`
    <h2>Assign users</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Set each person's role and who they report to — this drives the Dashboard's team rollups and the leave/report approval chain.</div>
    <table>
      <thead><tr><th>Name</th><th>Role</th><th>Reports to</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${u.name}</td>
            <td>
              <select data-role-select="${u.id}">
                ${["admin", "manager", "sales_rep", "hr"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${roleLabel(r)}</option>`).join("")}
              </select>
            </td>
            <td>
              <select data-manager-select="${u.id}">
                <option value="">— None —</option>
                ${managers.filter((m) => m.id !== u.id).map((m) => `<option value="${m.id}" ${u.manager_id === m.id ? "selected" : ""}>${m.name}</option>`).join("")}
              </select>
            </td>
            <td><button type="button" class="btn btn-small" data-save-user="${u.id}">Save</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Close</button></div>
  `, { wide: true });

  document.querySelectorAll("[data-save-user]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.saveUser);
      const role = document.querySelector(`[data-role-select="${id}"]`).value;
      const managerVal = document.querySelector(`[data-manager-select="${id}"]`).value;
      btn.disabled = true;
      try {
        await api(`/api/users/${id}`, { method: "PUT", body: { role, manager_id: managerVal || null } });
        toast("User updated");
        state.users = await api("/api/users");
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function leadStatusPill(status) {
  const label = { pending: "Pending", approved: "Approved", change_requested: "Change requested" }[status] || status;
  const cls = { pending: "pill-pending", approved: "pill-active", change_requested: "pill-rejected" }[status] || "";
  return `<span class="pill ${cls}">${label}</span>`;
}

function renderLeadsTable(leads, filtersActive, opts = {}) {
  if (!leads.length) return `<div class="empty-state">${filtersActive ? "No leads match these filters." : "No leads yet."}</div>`;
  const { canDelete, selected } = opts;
  const allSelected = canDelete && leads.length > 0 && leads.every((l) => selected.has(l.id));
  return `
    <table>
      <thead><tr>
        ${canDelete ? `<th style="width:34px"><input type="checkbox" id="leads-select-all" ${allSelected ? "checked" : ""} /></th>` : ""}
        <th>Contact person</th><th>Company</th><th>BDM</th><th>Source</th><th>Demo date</th><th>Status</th>
      </tr></thead>
      <tbody>
        ${leads.map((l) => `
          <tr class="row-click" data-lead="${l.id}">
            ${canDelete ? `<td onclick="event.stopPropagation()"><input type="checkbox" data-lead-select="${l.id}" ${selected.has(l.id) ? "checked" : ""} /></td>` : ""}
            <td>${l.contact_person || "—"}</td>
            <td>${l.company || "—"}</td>
            <td>${userName(l.bdm_assigned_id)}</td>
            <td>${l.source || "—"}</td>
            <td>${l.demo_date || "—"}</td>
            <td>${leadStatusPill(l.status)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ---------- Leads ----------
// Lead intake / demo tracking. Replaces the old deal-stage Pipeline Kanban.
// No field is mandatory -- a BDM can start a record with whatever they know
// from the first email. "Link existing Account/Contact" copies fields over
// for free; the Apollo-powered Auto-fill buttons hit the same lookup routes
// the Contact/Account forms already use.

// Leads filters -- same module-level pattern as contactsFilters/
// accountsFilters/activityFilters, so choices survive the re-render every
// row-open/close triggers.
let leadsFilters = { search: "", bdmId: "", source: "", status: "" };

// Row-selection state for the Leads table's select-all + bulk delete, same
// module-level Set pattern as contactsSelected/accountsSelected.
let leadsSelected = new Set();

function leadMatchesFilters(l) {
  const f = leadsFilters;
  if (f.bdmId && String(l.bdm_assigned_id || "") !== f.bdmId) return false;
  if (f.source && l.source !== f.source) return false;
  if (f.status && l.status !== f.status) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const haystack = `${l.contact_person || ""} ${l.company || ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function renderLeads() {
  document.getElementById("topbar-actions").innerHTML = `<button class="btn btn-primary" id="new-lead-btn">+ New Lead</button>`;
  document.getElementById("new-lead-btn").addEventListener("click", openLeadFormModal);

  const root = document.getElementById("view-root");
  const filtered = state.leads.filter(leadMatchesFilters);
  const filtersActive = Boolean(leadsFilters.search || leadsFilters.bdmId || leadsFilters.source || leadsFilters.status);
  const rows = filtered.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  // Same admin/manager gate as the single-lead Delete button in the detail
  // modal -- select-all + bulk delete is just a faster way to do the same
  // password-gated deletion, not a separate permission.
  const canDelete = ["admin", "manager"].includes(state.user.role);

  // Drop selected ids that fell out of view (deleted elsewhere, or scoped
  // out by a filter) so "N selected" stays accurate.
  const validIds = new Set(rows.map((l) => l.id));
  Array.from(leadsSelected).forEach((id) => { if (!validIds.has(id)) leadsSelected.delete(id); });

  root.innerHTML = `
    <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 20px">
      <input type="text" id="leads-filter-search" placeholder="Search contact, company…" value="${escapeAttr(leadsFilters.search)}" style="flex:1;min-width:180px" />
      <select id="leads-filter-bdm" style="width:auto">
        <option value="">All BDMs</option>
        ${state.users.slice().sort((a, b) => a.name.localeCompare(b.name)).map((u) => `<option value="${u.id}" ${leadsFilters.bdmId === String(u.id) ? "selected" : ""}>${u.name}</option>`).join("")}
      </select>
      <select id="leads-filter-source" style="width:auto">
        <option value="">All sources</option>
        ${LEAD_SOURCE_OPTIONS.map((s) => `<option value="${s}" ${leadsFilters.source === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <select id="leads-filter-status" style="width:auto">
        <option value="">All statuses</option>
        ${["pending", "approved", "change_requested"].map((s) => `<option value="${s}" ${leadsFilters.status === s ? "selected" : ""}>${{ pending: "Pending", approved: "Approved", change_requested: "Change requested" }[s]}</option>`).join("")}
      </select>
      ${filtersActive ? `<button type="button" class="btn btn-small" id="leads-filter-clear-btn">Clear filters</button>` : ""}
      <span style="font-size:12px;color:var(--text-dim);margin-left:auto">${rows.length} of ${state.leads.length} leads</span>
    </div>
    ${leadsSelected.size ? `
      <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px">
        <span style="font-size:13px;font-weight:600">${leadsSelected.size} selected</span>
        <button type="button" class="btn btn-small" id="leads-bulk-clear-btn">Clear selection</button>
        <button type="button" class="btn btn-small btn-danger" id="leads-bulk-delete-btn" title="Delete selected" aria-label="Delete selected" style="margin-left:auto">🗑 Delete selected</button>
      </div>
    ` : ""}
    <div class="panel">${renderLeadsTable(rows, filtersActive, { canDelete, selected: leadsSelected })}</div>
  `;
  root.querySelectorAll("[data-lead]").forEach((row) => {
    row.addEventListener("click", () => {
      const lead = state.leads.find((l) => l.id === Number(row.dataset.lead));
      if (lead) openLeadDetailModal(lead);
    });
  });

  const leadsSelectAllEl = document.getElementById("leads-select-all");
  if (leadsSelectAllEl) {
    leadsSelectAllEl.addEventListener("change", (e) => {
      // Only acts on the rows currently visible under the active filters --
      // same behavior as the equivalent checkbox on Contacts/Accounts.
      if (e.target.checked) rows.forEach((l) => leadsSelected.add(l.id));
      else rows.forEach((l) => leadsSelected.delete(l.id));
      renderLeads();
    });
  }
  root.querySelectorAll("[data-lead-select]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(cb.dataset.leadSelect);
      if (e.target.checked) leadsSelected.add(id);
      else leadsSelected.delete(id);
      renderLeads();
    });
  });
  const leadsBulkClearBtn = document.getElementById("leads-bulk-clear-btn");
  if (leadsBulkClearBtn) {
    leadsBulkClearBtn.addEventListener("click", () => {
      leadsSelected.clear();
      renderLeads();
    });
  }
  const leadsBulkDeleteBtn = document.getElementById("leads-bulk-delete-btn");
  if (leadsBulkDeleteBtn) {
    leadsBulkDeleteBtn.addEventListener("click", () => {
      const ids = Array.from(leadsSelected);
      openPasswordConfirmModal({
        title: `Delete ${ids.length} lead${ids.length === 1 ? "" : "s"}?`,
        hint: "This can't be undone.",
        confirmLabel: "Delete leads",
        onConfirm: async (password) => {
          const results = await runWithConcurrency(ids, 5, (id) => api(`/api/leads/${id}`, { method: "DELETE", body: { password } }));
          const succeededIds = ids.filter((_, i) => results[i].status === "fulfilled");
          const failed = ids
            .map((id, i) => ({ id, result: results[i] }))
            .filter((r) => r.result.status === "rejected");
          if (succeededIds.length) {
            state.leads = state.leads.filter((l) => !succeededIds.includes(l.id));
            succeededIds.forEach((id) => leadsSelected.delete(id));
          }
          if (succeededIds.length === 0 && failed.length) {
            // Every delete failed -- most commonly a wrong password. Throw
            // so openPasswordConfirmModal's own error handling shows it and
            // leaves the modal open to try again, instead of closing and
            // reporting the failure via toast (which reads as "done, and it
            // failed" rather than "try again").
            throw new Error(failed[0].result.reason.message);
          }
          closeModal();
          if (failed.length) {
            toast(`Deleted ${succeededIds.length}, ${failed.length} failed: ${failed[0].result.reason.message}`, "error");
          } else {
            toast(`Deleted ${succeededIds.length} lead${succeededIds.length === 1 ? "" : "s"}`);
          }
          renderLeads();
        },
      });
    });
  }

  const searchEl = document.getElementById("leads-filter-search");
  searchEl.addEventListener("input", (e) => {
    leadsFilters.search = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderLeads();
    const newSearchEl = document.getElementById("leads-filter-search");
    if (newSearchEl) {
      newSearchEl.focus();
      newSearchEl.setSelectionRange(cursorPos, cursorPos);
    }
  });
  document.getElementById("leads-filter-bdm").addEventListener("change", (e) => {
    leadsFilters.bdmId = e.target.value;
    renderLeads();
  });
  document.getElementById("leads-filter-source").addEventListener("change", (e) => {
    leadsFilters.source = e.target.value;
    renderLeads();
  });
  document.getElementById("leads-filter-status").addEventListener("change", (e) => {
    leadsFilters.status = e.target.value;
    renderLeads();
  });
  const clearBtn = document.getElementById("leads-filter-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      leadsFilters = { search: "", bdmId: "", source: "", status: "" };
      renderLeads();
    });
  }
}

const LEAD_SOURCE_OPTIONS = ["Website", "Referral", "Outbound", "Trade show", "Inbound email", "Partner", "Upsell", "Other"];

function leadFormFieldsHtml(v) {
  v = v || {};
  return `
    <label>Source</label>
    <select name="source">
      <option value="">—</option>
      ${LEAD_SOURCE_OPTIONS.map((s) => `<option value="${s}" ${v.source === s ? "selected" : ""}>${s}</option>`).join("")}
    </select>
    <label>Date lead received</label><input name="date_received" type="date" value="${v.date_received ? v.date_received.slice(0, 10) : ""}" />
    <label>BDM assigned</label>
    <select name="bdm_assigned_id">
      <option value="">—</option>
      ${state.users.map((u) => `<option value="${u.id}" ${Number(v.bdm_assigned_id) === u.id ? "selected" : ""}>${u.name}</option>`).join("")}
    </select>

    <div style="display:flex;gap:8px;align-items:flex-end;margin-top:18px">
      <div style="flex:1"><label style="margin-top:0">Link existing contact (optional)</label>
        <select id="lead-link-contact">
          <option value="">—</option>
          ${state.contacts.map((c) => `<option value="${c.id}">${c.first_name} ${c.last_name}${c.title ? " — " + c.title : ""}</option>`).join("")}
        </select>
      </div>
    </div>
    <label>Contact person</label>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="lead-contact-person" name="contact_person" value="${escapeAttr(v.contact_person || "")}" style="flex:1" />
      <button type="button" class="btn" id="lead-contact-autofill-btn">Auto-fill</button>
    </div>
    <input type="hidden" name="contact_linked_id" id="lead-contact-linked-id" value="${v.contact_linked_id || ""}" />
    <label>Designation</label><input id="lead-designation" name="designation" value="${escapeAttr(v.designation || "")}" />
    <label>Contact person location</label><input id="lead-contact-location" name="contact_location" value="${escapeAttr(v.contact_location || "")}" />
    <label>LinkedIn link</label><input id="lead-linkedin-link" name="linkedin_link" type="text" value="${escapeAttr(v.linkedin_link || "")}" placeholder="linkedin.com/in/..." />
    <label>Additional guests &amp; designations</label>
    <textarea name="additional_guests" rows="2" placeholder="One per line, e.g. Jane Doe — VP Engineering">${v.additional_guests || ""}</textarea>
    <label>Demo date</label><input name="demo_date" type="date" value="${v.demo_date ? v.demo_date.slice(0, 10) : ""}" />

    <div style="margin-top:18px">
      <label style="margin-top:0">Link existing account (optional)</label>
      <select id="lead-link-account">
        <option value="">—</option>
        ${state.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join("")}
      </select>
    </div>
    <label>Company</label>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="lead-company" name="company" value="${escapeAttr(v.company || "")}" style="flex:1" />
      <button type="button" class="btn" id="lead-company-autofill-btn">Auto-fill</button>
    </div>
    <input type="hidden" name="account_linked_id" id="lead-account-linked-id" value="${v.account_linked_id || ""}" />
    <label>Website</label><input id="lead-website" name="website" value="${escapeAttr(v.website || "")}" />
    <label>Revenue</label><input id="lead-revenue" name="revenue" value="${escapeAttr(v.revenue || "")}" placeholder="e.g. $50M" />
    <label>Industry</label><input id="lead-industry" name="industry" value="${escapeAttr(v.industry || "")}" />

    <label>Salesforce current status</label><input name="sf_status" value="${escapeAttr(v.sf_status || "")}" />
    <label>Salesforce link</label><input name="sf_link" type="text" value="${escapeAttr(v.sf_link || "")}" placeholder="...salesforce.com/..." />
    <label>Remarks</label><textarea name="remarks" rows="3">${v.remarks || ""}</textarea>
  `;
}

// Wires the "Link existing…" selects (instant, free) and the Apollo/Claude
// auto-fill buttons (reuse the exact same lookup routes the Contact/Account
// forms use) inside whatever modal currently has the lead form fields.
function wireLeadFormAssist() {
  const linkContact = document.getElementById("lead-link-contact");
  if (linkContact) {
    linkContact.addEventListener("change", () => {
      const c = state.contacts.find((x) => x.id === Number(linkContact.value));
      if (!c) return;
      document.getElementById("lead-contact-person").value = `${c.first_name} ${c.last_name}`.trim();
      document.getElementById("lead-designation").value = c.title || "";
      document.getElementById("lead-linkedin-link").value = c.linkedin_url || "";
      document.getElementById("lead-contact-linked-id").value = c.id;
      if (c.account_id) {
        const acct = state.accounts.find((a) => a.id === c.account_id);
        if (acct) {
          document.getElementById("lead-company").value = acct.name || "";
          document.getElementById("lead-website").value = acct.website || "";
          document.getElementById("lead-revenue").value = acct.revenue || "";
          document.getElementById("lead-industry").value = acct.industry || "";
          document.getElementById("lead-account-linked-id").value = acct.id;
          const linkAccount = document.getElementById("lead-link-account");
          if (linkAccount) linkAccount.value = acct.id;
        }
      }
    });
  }

  const linkAccount = document.getElementById("lead-link-account");
  if (linkAccount) {
    linkAccount.addEventListener("change", () => {
      const a = state.accounts.find((x) => x.id === Number(linkAccount.value));
      if (!a) return;
      document.getElementById("lead-company").value = a.name || "";
      document.getElementById("lead-website").value = a.website || "";
      document.getElementById("lead-revenue").value = a.revenue || "";
      document.getElementById("lead-industry").value = a.industry || "";
      document.getElementById("lead-account-linked-id").value = a.id;
    });
  }

  const contactAutofillBtn = document.getElementById("lead-contact-autofill-btn");
  if (contactAutofillBtn) {
    contactAutofillBtn.addEventListener("click", async () => {
      const full = document.getElementById("lead-contact-person").value.trim();
      if (!full) { toast("Enter the contact person's name first", "error"); return; }
      const [first_name, ...rest] = full.split(/\s+/);
      const last_name = rest.join(" ");
      if (!last_name) { toast("Enter a first and last name to auto-fill", "error"); return; }
      const originalLabel = contactAutofillBtn.textContent;
      contactAutofillBtn.disabled = true;
      contactAutofillBtn.textContent = "Looking up…";
      try {
        const result = await api("/api/contacts/lookup-person", { method: "POST", body: { first_name, last_name } });
        const filled = [];
        if (result.title) { document.getElementById("lead-designation").value = result.title; filled.push("designation"); }
        if (result.linkedin_url) { document.getElementById("lead-linkedin-link").value = result.linkedin_url; filled.push("LinkedIn link"); }
        toast(filled.length ? `Filled ${filled.join(", ")} from ${(result.sources || []).join(" + ") || "lookup"}` : ((result.warnings && result.warnings[0]) || "No matching data found"), filled.length ? undefined : "error");
      } catch (err) {
        toast(err.message, "error");
      } finally {
        contactAutofillBtn.disabled = false;
        contactAutofillBtn.textContent = originalLabel;
      }
    });
  }

  const companyAutofillBtn = document.getElementById("lead-company-autofill-btn");
  if (companyAutofillBtn) {
    companyAutofillBtn.addEventListener("click", async () => {
      const name = document.getElementById("lead-company").value.trim();
      if (!name) { toast("Enter the company name first", "error"); return; }
      const originalLabel = companyAutofillBtn.textContent;
      companyAutofillBtn.disabled = true;
      companyAutofillBtn.textContent = "Looking up…";
      try {
        const result = await api("/api/accounts/lookup-company", { method: "POST", body: { name } });
        const filled = [];
        if (result.website) { document.getElementById("lead-website").value = result.website; filled.push("website"); }
        if (result.revenue) { document.getElementById("lead-revenue").value = result.revenue; filled.push("revenue"); }
        if (result.industry) { document.getElementById("lead-industry").value = result.industry; filled.push("industry"); }
        toast(filled.length ? `Filled ${filled.join(", ")} from ${(result.sources || []).join(" + ") || "lookup"}` : ((result.warnings && result.warnings[0]) || "No matching data found"), filled.length ? undefined : "error");
      } catch (err) {
        toast(err.message, "error");
      } finally {
        companyAutofillBtn.disabled = false;
        companyAutofillBtn.textContent = originalLabel;
      }
    });
  }
}

function openLeadFormModal() {
  openModal(`
    <h2>New lead</h2>
    <form id="lead-form">
      ${leadFormFieldsHtml({ bdm_assigned_id: state.user.id })}
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create lead</button>
      </div>
    </form>
  `);
  wireLeadFormAssist();
  document.getElementById("lead-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    fd.linkedin_link = normalizeUrlInput(fd.linkedin_link);
    fd.sf_link = normalizeUrlInput(fd.sf_link);
    try {
      await api("/api/leads", { method: "POST", body: fd });
      toast("Lead created");
      closeModal();
      await loadAll();
      renderLeads();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// Whether the signed-in user can edit an approved lead's fields directly
// (mirrors the backend's userCanManageLead: admin always, manager only for
// leads within their team). Everyone else has to go through Request Change.
function canManageLeadClient(lead) {
  if (state.user.role === "admin") return true;
  if (state.user.role !== "manager") return false;
  const bdmId = lead.bdm_assigned_id || lead.created_by;
  if (bdmId === state.user.id) return true;
  const bdmUser = state.users.find((u) => u.id === bdmId);
  return Boolean(bdmUser && bdmUser.manager_id === state.user.id);
}

function openLeadDetailModal(lead) {
  const canManage = canManageLeadClient(lead);
  const locked = lead.status === "change_requested" && !canManage;
  const showRequestChangeFlow = lead.status === "approved" && !canManage;

  const pendingChangesHtml = (lead.status === "change_requested" && lead.pending_changes) ? `
    <div class="panel" style="padding:14px;margin-bottom:14px;border:1px solid var(--amber, #f5a623)">
      <h2 style="margin-bottom:8px">Proposed changes</h2>
      <div style="font-size:13px;line-height:1.7">
        ${Object.entries(lead.pending_changes).map(([k, v]) => `<div><strong>${k}:</strong> ${escapeAttr(String(v || "—"))}</div>`).join("") || "No field changes."}
      </div>
      ${canManage ? `
        <div class="modal-actions" style="margin-top:10px">
          <button type="button" class="btn btn-danger btn-small" id="lead-reject-btn">Reject</button>
          <button type="button" class="btn btn-primary btn-small" id="lead-approve-btn">Approve change</button>
        </div>
      ` : `<div class="hint" style="margin-top:8px">Awaiting review from your manager or an admin.</div>`}
    </div>
  ` : "";

  openModal(`
    <h2>${lead.contact_person || lead.company || "Lead"}</h2>
    <div style="margin-bottom:14px">${leadStatusPill(lead.status)}
      ${lead.status === "approved" ? `<span style="font-size:12px;color:var(--text-dim);margin-left:8px">approved ${lead.approved_at ? lead.approved_at.slice(0, 10) : ""}${lead.approved_by ? " by " + userName(lead.approved_by) : ""}</span>` : ""}
    </div>
    ${pendingChangesHtml}
    ${lead.status === "pending" && canManage ? `
      <div class="modal-actions" style="justify-content:flex-start;margin-bottom:14px">
        <button type="button" class="btn btn-primary btn-small" id="lead-approve-btn">Approve lead</button>
      </div>
    ` : ""}
    <form id="lead-detail-form" ${locked ? "style=\"opacity:.6\"" : ""}>
      ${leadFormFieldsHtml(lead)}
      ${!locked ? `
        <div class="modal-actions">
          <button type="button" class="btn" onclick="closeModal()">Close</button>
          ${["admin", "manager"].includes(state.user.role) ? `<button type="button" class="btn btn-danger" id="lead-delete-btn">Delete</button>` : ""}
          <button type="submit" class="btn btn-primary">${showRequestChangeFlow ? "Submit change request" : "Save changes"}</button>
        </div>
      ` : `
        <div class="hint">A change request is pending review — fields are locked until it's resolved.</div>
        <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Close</button></div>
      `}
    </form>
  `);

  if (locked) return;
  wireLeadFormAssist();

  document.getElementById("lead-detail-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    fd.linkedin_link = normalizeUrlInput(fd.linkedin_link);
    fd.sf_link = normalizeUrlInput(fd.sf_link);
    try {
      if (showRequestChangeFlow) {
        await api(`/api/leads/${lead.id}/request-change`, { method: "POST", body: fd });
        toast("Change request submitted for approval");
      } else {
        await api(`/api/leads/${lead.id}`, { method: "PUT", body: fd });
        toast("Lead updated");
      }
      closeModal();
      await loadAll();
      renderLeads();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const approveBtn = document.getElementById("lead-approve-btn");
  if (approveBtn) {
    approveBtn.addEventListener("click", async () => {
      try {
        await api(`/api/leads/${lead.id}/approve`, { method: "POST" });
        toast("Lead approved");
        closeModal();
        await loadAll();
        renderLeads();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
  const rejectBtn = document.getElementById("lead-reject-btn");
  if (rejectBtn) {
    rejectBtn.addEventListener("click", async () => {
      try {
        await api(`/api/leads/${lead.id}/reject`, { method: "POST" });
        toast("Change request rejected");
        closeModal();
        await loadAll();
        renderLeads();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
  const deleteBtn = document.getElementById("lead-delete-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      openPasswordConfirmModal({
        title: "Delete this lead?",
        hint: "This can't be undone.",
        confirmLabel: "Delete lead",
        onConfirm: async (password) => {
          await api(`/api/leads/${lead.id}`, { method: "DELETE", body: { password } });
          toast("Lead deleted");
          closeModal();
          await loadAll();
          renderLeads();
        },
      });
    });
  }
}

// ---------- Contacts ----------

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Real .xlsx export with Calibri 11 actually written into the cell styles
// -- a plain .csv has no way to carry a font at all, so this is the only
// export format where "Calibri 11" is real formatting rather than just a
// note. Goes through POST /api/export/xlsx (server builds the file with
// exceljs) rather than api() above, since that helper always parses JSON
// and this response is binary.
async function exportXlsx(filename, sheetName, headers, rows) {
  const res = await fetch("/api/export/xlsx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, sheetName, headers, rows }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// MM/DD only, no year -- used on the Contacts table's compact Date column.
function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d)) return "—";
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Shared header/row builder for both export formats -- Owner is left out
// entirely for anyone who isn't admin/manager (same visibility rule as the
// on-screen Owner column), and Email Date/IQ Notes ride along so a report
// pulled out of the app carries the same context the table shows.
function contactExportColumns() {
  const canSeeOwner = ["admin", "manager"].includes(state.user.role);
  const headers = [
    "Date", "First name", "Last name", "Title", "Account", "Email", "Phone", "LinkedIn URL", "Sales Navigator URL",
    ...(canSeeOwner ? ["Owner"] : []),
    "Status", "IQ Notes", "Email Date",
    "Draft Mode", "Draft",
    "Follow-up 1", "Follow-up 2", "Follow-up 3", "Follow-up 4", "Follow-up 5",
    "Response",
  ];
  const rowFn = (c) => {
    const followups = c.draft_mode === "auto" && Array.isArray(c.followups) ? c.followups : ["", "", "", "", ""];
    return [
      shortDate(c.created_at), c.first_name, c.last_name, c.title || "", accountName(c.account_id) === "—" ? "" : accountName(c.account_id),
      c.email || "", c.phone || "", c.linkedin_url || "", c.sales_navigator_url || "",
      ...(canSeeOwner ? [userName(c.owner_id)] : []),
      c.status || "Fresh", c.iq_notes || "", shortDate(c.last_emailed_at),
      c.draft_mode ? (c.draft_mode === "auto" ? "Auto" : "Manual") : "", c.draft_text || "",
      ...[0, 1, 2, 3, 4].map((i) => followups[i] || ""),
      c.response_text || "",
    ];
  };
  return { headers, rowFn };
}

// Exporting is treated as "you're about to reach out to these contacts
// outside the app" -- so before either export format runs, this confirms
// bumping Email Date to today for the contacts being exported, and the
// export is blocked entirely if the rep backs out rather than silently
// skipping the date update.
function confirmAndStampEmailDate(contacts, onAccepted) {
  const today = todayISO();
  openModal(`
    <h2>Update Email Date?</h2>
    <div style="font-size:13px;line-height:1.6;margin-bottom:14px">Exporting will set <strong>Email Date</strong> to <strong>${today}</strong> for ${contacts.length} contact${contacts.length === 1 ? "" : "s"}. Continue?</div>
    <div class="modal-actions">
      <button type="button" class="btn" id="export-date-cancel-btn">Cancel</button>
      <button type="button" class="btn btn-primary" id="export-date-accept-btn">Update &amp; export</button>
    </div>
  `);
  document.getElementById("export-date-cancel-btn").addEventListener("click", () => {
    closeModal();
    toast("Export cancelled");
  });
  document.getElementById("export-date-accept-btn").addEventListener("click", async () => {
    const btn = document.getElementById("export-date-accept-btn");
    btn.disabled = true;
    btn.textContent = "Updating…";
    const results = await runWithConcurrency(contacts, 5, (c) => api(`/api/contacts/${c.id}`, { method: "PUT", body: { last_emailed_at: today } }));
    results.forEach((r) => {
      if (r.status === "fulfilled") {
        const updated = r.value;
        const idx = state.contacts.findIndex((x) => x.id === updated.id);
        if (idx !== -1) state.contacts[idx] = updated;
      }
    });
    closeModal();
    onAccepted();
  });
}

function exportContactsCSV() {
  // Ticking rows in the table isn't just cosmetic -- if any are checked,
  // Export CSV exports only those, same as any spreadsheet tool's "export
  // selection." With nothing checked it falls back to whatever the filter
  // bar currently shows (all contacts, if no filters are set) -- so a plain
  // click always exports what's actually on screen.
  const filtersActive = Boolean(anyHeaderFilterActive(contactFilterDefs(), contactsFilters) || contactsScopeFilter);
  const source = contactsSelected.size
    ? state.contacts.filter((c) => contactsSelected.has(c.id))
    : state.contacts.filter(contactMatchesFilters);
  if (!source.length) { toast("No contacts to export", "error"); return; }
  confirmAndStampEmailDate(source, () => {
    const { headers, rowFn } = contactExportColumns();
    const rows = source.map(rowFn);
    const csv = [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`trellis-contacts-${date}.csv`, csv, "text/csv;charset=utf-8;");
    const qualifier = contactsSelected.size ? "selected " : (filtersActive ? "filtered " : "");
    toast(`Exported ${source.length} ${qualifier}contact${source.length === 1 ? "" : "s"}`);
    renderContacts();
  });
}

// Same selection/filter precedence and columns as exportContactsCSV above,
// but as a real .xlsx with Calibri 11 on every cell (a .csv can't carry a
// font at all).
async function exportContactsXlsx() {
  const filtersActive = Boolean(anyHeaderFilterActive(contactFilterDefs(), contactsFilters) || contactsScopeFilter);
  const source = contactsSelected.size
    ? state.contacts.filter((c) => contactsSelected.has(c.id))
    : state.contacts.filter(contactMatchesFilters);
  if (!source.length) { toast("No contacts to export", "error"); return; }
  confirmAndStampEmailDate(source, async () => {
    const { headers, rowFn } = contactExportColumns();
    const rows = source.map(rowFn);
    const date = new Date().toISOString().slice(0, 10);
    try {
      await exportXlsx(`trellis-contacts-${date}.xlsx`, "Contacts", headers, rows);
      const qualifier = contactsSelected.size ? "selected " : (filtersActive ? "filtered " : "");
      toast(`Exported ${source.length} ${qualifier}contact${source.length === 1 ? "" : "s"} (Excel)`);
    } catch (err) {
      toast(err.message, "error");
    }
    renderContacts();
  });
}

// Row-selection state for the Contacts table -- module-level (not inside
// renderContacts) so it survives the full re-render that every checkbox
// click and status change triggers, and only ever gets cleared explicitly
// (select-all off, Clear selection, or after a bulk action completes).
let contactsSelected = new Set();

// Which Contacts columns are hidden, persisted per-browser. Date starts
// hidden by default (still in the data, still in every export -- just not
// taking up table space day to day) but everything else starts shown.
function loadHiddenContactColumns() {
  try {
    const raw = localStorage.getItem("contactsHiddenColumns");
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* storage blocked/corrupt -- fall through to the default */ }
  return new Set(["date"]);
}
let hiddenContactColumns = loadHiddenContactColumns();
function saveHiddenContactColumns() {
  try { localStorage.setItem("contactsHiddenColumns", JSON.stringify(Array.from(hiddenContactColumns))); } catch { /* ignore */ }
}

// How the Contacts table sizes itself, persisted per-browser (same pattern
// as the column visibility above). "full" (the default) lets the table grow
// to its natural height and the page scroll, same as every other list in
// the app. "fit" bounds it to a bordered, height-capped box with its own
// scrollbar and a sticky header -- useful for a very long contact list where
// keeping the horizontal (column-resize) scrollbar on screen matters more
// than avoiding an inner scroll region.
function getContactsTableMode() {
  try { return localStorage.getItem("contactsTableMode") === "fit" ? "fit" : "full"; } catch { return "full"; }
}
function setContactsTableMode(mode) {
  try { localStorage.setItem("contactsTableMode", mode); } catch { /* ignore */ }
}
// Owner is a permission boundary, not a preference -- it's left out of the
// hideable list (and off the table entirely) for anyone who isn't
// admin/manager, regardless of what's saved in localStorage.
function contactColumnDefs() {
  const canSeeOwner = ["admin", "manager"].includes(state.user.role);
  return [
    { id: "date", label: "Date" },
    { id: "title", label: "Title" },
    { id: "account", label: "Account" },
    { id: "email", label: "Email" },
    { id: "emailIcon", label: "Send" },
    { id: "linkedin", label: "LinkedIn" },
    { id: "iq", label: "IQ" },
    ...(canSeeOwner ? [{ id: "owner", label: "Owner" }] : []),
    { id: "status", label: "Status" },
    { id: "draftType", label: "Draft Type" },
    { id: "draft", label: "Draft" },
    { id: "emailDate", label: "Email Date" },
    { id: "response", label: "Response" },
  ];
}
function contactColVisible(id) {
  if (id === "owner" && !["admin", "manager"].includes(state.user.role)) return false;
  return !hiddenContactColumns.has(id);
}

// Header-row entry point for showing/hiding columns (filtering itself now
// lives as a ▾ trigger on each column's own header cell -- see thFilterHtml
// / openHeaderFilterPopover below -- so this modal is show/hide only).
// Toggling a checkbox here re-renders the table live without closing this
// panel.
function openContactColumnsModal() {
  const defs = contactColumnDefs();
  openModal(`
    <h2>Columns</h2>
    <div class="hint" style="margin-bottom:10px">Choose which columns show in the table (saved on this browser). Each visible column has its own ▾ filter in its header.</div>
    ${defs.map((d) => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <input type="checkbox" data-col-toggle="${d.id}" ${hiddenContactColumns.has(d.id) ? "" : "checked"} />
        <span>${d.label}</span>
      </label>
    `).join("")}
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Done</button>
    </div>
  `);
  document.querySelectorAll("[data-col-toggle]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = cb.dataset.colToggle;
      if (e.target.checked) hiddenContactColumns.delete(id);
      else hiddenContactColumns.add(id);
      saveHiddenContactColumns();
      renderContacts();
    });
  });
}

// The outreach lifecycle a rep tags each contact with -- deliberately the
// same vocabulary as the Activity Report's response fields (cold/warm/
// prospect/negative/LinkedIn) plus the 5 Follow-up Pipeline stages already
// on the Dashboard, so a contact's Status here and its response category
// elsewhere in the app always mean the same thing.
const CONTACT_STATUSES = [
  "Fresh", "1st Followup", "2nd Followup", "3rd Followup", "4th Followup", "5th Followup",
  "Bounced", "Cold", "Warm", "Prospect", "Negative", "LinkedIn",
];

// Contacts table filters -- module-level like contactsSelected, so choices
// survive the re-render every checkbox/status edit triggers. Flat bag keyed
// by column id (colId+"From"/"To" for a dateRange column) -- see
// contactFilterDefs() above for what each key means and how a future column
// adds its own.
let contactsFilters = {};

// Set only when arriving from the Dashboard's "Total Contacts" card (array
// of owner_ids matching whatever scope produced that count) -- same idea as
// accountsScopeFilter for Total Companies. Cleared on any direct sidebar
// click into Contacts, and shown as its own banner (not folded into the
// filter bar above) since it's app-driven, not something typed/picked here.
let contactsScopeFilter = null;

function contactMatchesFilters(c) {
  const f = contactsFilters;
  if (contactsScopeFilter && !contactsScopeFilter.includes(c.owner_id)) return false;
  const defs = contactFilterDefs();
  for (const colId in defs) {
    const def = defs[colId];
    if (def.kind === "select") {
      if (f[colId] && String(def.getValue(c)) !== f[colId]) return false;
    } else if (def.kind === "boolean") {
      if (f[colId] === "yes" && !def.getValue(c)) return false;
      if (f[colId] === "no" && def.getValue(c)) return false;
    } else if (def.kind === "text") {
      if (f[colId]) {
        const q = f[colId].toLowerCase();
        if (!String(def.getValue(c) || "").toLowerCase().includes(q)) return false;
      }
    } else if (def.kind === "dateRange") {
      const from = f[`${colId}From`];
      const to = f[`${colId}To`];
      if (from || to) {
        const val = def.getValue(c);
        if (from && (!val || val < from)) return false;
        if (to && (!val || val > to)) return false;
      }
    }
  }
  return true;
}

// Contacts the current user is allowed to slice the table/export by owner
// for. A manager sees themself plus their direct reports (same scoping as
// the Dashboard's team selector); everyone else -- admin and reps/SDRs
// alike -- sees the full roster. Visible to every role, not just
// admin/manager, since a rep may still want to filter to a teammate's
// contacts.
function contactsOwnerFilterOptions() {
  const role = state.user.role;
  if (role === "manager") {
    const directReports = state.users.filter((u) => u.manager_id === state.user.id);
    return [state.user, ...directReports];
  }
  return state.users.slice().sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Shared inline header-column filter engine ----------
// Every list view that wants "the filter for a column lives on that column's
// own header, not in a separate bar above the table" (Contacts, Accounts,
// and any future list) plugs into this instead of rolling its own popover
// logic. A view supplies:
//   - defs: a plain object of colId -> { label, kind, getValue, getOptions }
//     kind is one of "text" (substring match), "select" (exact match against
//     getOptions()' values), "boolean" (getValue() truthy/falsy, offered as
//     Has/Missing <label>), or "dateRange" (getValue() compared against
//     colId+"From"/colId+"To").
//   - filters: that view's own flat filter-state object (colId, or
//     colId+"From"/"To" for dateRange, as keys).
//   - renderFn: the view's render function, called after every change so the
//     table re-filters live.
// Adding a filter for a brand-new column is then just one entry in that
// view's defs object plus one thFilterHtml(...) call in its header markup --
// no popover/matching code to write per column.
//
// The popover itself is appended to <body>, not into the view's own root --
// a render call replaces that root wholesale on every keystroke/selection,
// and a popover living outside that subtree survives each of those
// re-renders instead of being wiped (and losing focus) along with the table
// it's anchored to.
let openHeaderFilter = null; // { colId, popoverEl } while a popover is open, else null

function headerFilterIsActive(defs, filters, colId) {
  const def = defs[colId];
  if (!def) return false;
  if (def.kind === "dateRange") return Boolean(filters[`${colId}From`] || filters[`${colId}To`]);
  return Boolean(filters[colId]);
}

function anyHeaderFilterActive(defs, filters) {
  return Object.keys(defs).some((colId) => headerFilterIsActive(defs, filters, colId));
}

// Master on/off switch for a view's header filters, persisted per-browser
// (same try/catch-wrapped localStorage pattern as every other per-browser
// preference in the app). Turning filters off doesn't just hide the ▾
// triggers -- the caller also clears that view's filters object, so "off"
// really means no filtering, not just a hidden UI with something still
// silently applied underneath.
function getHeaderFiltersOn(storageKey) {
  try { return localStorage.getItem(storageKey) !== "off"; } catch { return true; }
}
function setHeaderFiltersOn(storageKey, on) {
  try { localStorage.setItem(storageKey, on ? "on" : "off"); } catch { /* ignore */ }
}

// The filters on/off button living at the end of a table's header row.
function filtersToggleButtonHtml(toggleId, on) {
  return `<button type="button" class="col-menu-btn filters-toggle-btn${on ? " filters-toggle-btn-on" : ""}" data-filters-toggle-btn="${toggleId}" title="${on ? "Turn column filters off" : "Turn column filters on"}" aria-label="${on ? "Turn column filters off" : "Turn column filters on"}">${FILTERS_TOGGLE_ICON_SVG}</button>`;
}

function headerFilterControlHtml(defs, filters, colId) {
  const def = defs[colId];
  if (!def) return "";
  if (def.kind === "text") {
    return `<input type="text" data-hf-input="${colId}" placeholder="Search ${def.label.toLowerCase()}…" value="${escapeAttr(filters[colId] || "")}" />`;
  }
  if (def.kind === "select") {
    const options = def.getOptions();
    return `<select data-hf-input="${colId}">
      <option value="">All</option>
      ${options.map((o) => `<option value="${escapeAttr(String(o.value))}" ${String(filters[colId] || "") === String(o.value) ? "selected" : ""}>${o.label}</option>`).join("")}
    </select>`;
  }
  if (def.kind === "boolean") {
    const cur = filters[colId] || "";
    return `<select data-hf-input="${colId}">
      <option value="">All</option>
      <option value="yes" ${cur === "yes" ? "selected" : ""}>Has ${def.label}</option>
      <option value="no" ${cur === "no" ? "selected" : ""}>Missing ${def.label}</option>
    </select>`;
  }
  if (def.kind === "dateRange") {
    return `
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:2px">${def.label} on/after</div>
      <input type="date" data-hf-input="${colId}From" value="${filters[`${colId}From`] || ""}" />
      <div style="font-size:11px;color:var(--text-dim);margin:8px 0 2px">${def.label} on/before</div>
      <input type="date" data-hf-input="${colId}To" value="${filters[`${colId}To`] || ""}" />
    `;
  }
  return "";
}

// Renders a header <th>'s inner content as "Label ▾", with the caret's
// active/inactive styling reflecting whether that column currently has a
// filter applied.
function thFilterHtml(defs, filters, colId, label) {
  const active = headerFilterIsActive(defs, filters, colId);
  return `<span class="th-filter">${label}<button type="button" class="th-filter-btn${active ? " th-filter-btn-active" : ""}" data-th-filter-btn="${colId}" title="Filter ${label}" aria-label="Filter ${label}">▾</button></span>`;
}

function closeHeaderFilterPopover() {
  if (openHeaderFilter && openHeaderFilter.popoverEl) openHeaderFilter.popoverEl.remove();
  openHeaderFilter = null;
  document.removeEventListener("mousedown", headerFilterOutsideClick, true);
}

function headerFilterOutsideClick(e) {
  if (!openHeaderFilter || !openHeaderFilter.popoverEl) return;
  if (openHeaderFilter.popoverEl.contains(e.target)) return;
  if (e.target.dataset && e.target.dataset.thFilterBtn) return;
  closeHeaderFilterPopover();
}

function openHeaderFilterPopover(defs, filters, colId, anchorBtn, renderFn) {
  const wasOpenForSameCol = openHeaderFilter && openHeaderFilter.colId === colId;
  closeHeaderFilterPopover();
  if (wasOpenForSameCol) return;
  const rect = anchorBtn.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "th-filter-pop";
  pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
  pop.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 210)}px`;
  pop.innerHTML = headerFilterControlHtml(defs, filters, colId);
  document.body.appendChild(pop);
  openHeaderFilter = { colId, popoverEl: pop };
  pop.querySelectorAll("[data-hf-input]").forEach((el) => {
    const eventName = el.tagName === "SELECT" || el.type === "date" ? "change" : "input";
    el.addEventListener(eventName, (e) => {
      filters[el.dataset.hfInput] = e.target.value;
      renderFn();
    });
  });
  const firstInput = pop.querySelector("input, select");
  if (firstInput) firstInput.focus();
  setTimeout(() => document.addEventListener("mousedown", headerFilterOutsideClick, true), 0);
}

// Single source of truth for every Contacts column's header filter: label,
// filter kind, and how to read the value off a contact. Add a new column
// here (plus one thFilterHtml(CONTACT_FILTER_DEFS, ...) call in the header
// markup in renderContacts()) and it gets a working inline filter with no
// other code to touch.
function contactFilterDefs() {
  return {
    name: { label: "Name", kind: "text", getValue: (c) => `${c.first_name || ""} ${c.last_name || ""}` },
    date: { label: "Date", kind: "dateRange", getValue: (c) => c.created_at },
    title: { label: "Title", kind: "select", getValue: (c) => c.title || "", getOptions: () => Array.from(new Set(state.contacts.map((c) => c.title).filter(Boolean))).sort().map((t) => ({ value: t, label: t })) },
    account: { label: "Account", kind: "select", getValue: (c) => String(c.account_id || ""), getOptions: () => state.accounts.slice().sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: String(a.id), label: a.name })) },
    email: { label: "Email", kind: "text", getValue: (c) => c.email || "" },
    emailIcon: { label: "Send", kind: "boolean", getValue: (c) => Boolean(c.email) },
    linkedin: { label: "LinkedIn", kind: "boolean", getValue: (c) => Boolean(c.linkedin_url) },
    iq: { label: "IQ", kind: "boolean", getValue: (c) => Boolean(c.iq_notes) },
    owner: { label: "Owner", kind: "select", getValue: (c) => String(c.owner_id || ""), getOptions: () => contactsOwnerFilterOptions().map((u) => ({ value: String(u.id), label: u.id === state.user.id ? "Just me" : u.name })) },
    status: { label: "Status", kind: "select", getValue: (c) => c.status || "Fresh", getOptions: () => CONTACT_STATUSES.map((s) => ({ value: s, label: s })) },
    draftType: { label: "Draft Type", kind: "select", getValue: (c) => c.draft_mode || "none", getOptions: () => ([{ value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }, { value: "none", label: "— (none)" }]) },
    draft: { label: "Draft", kind: "text", getValue: (c) => c.draft_text || "" },
    emailDate: { label: "Email Date", kind: "dateRange", getValue: (c) => c.last_emailed_at },
    response: { label: "Response", kind: "text", getValue: (c) => c.response_text || "" },
  };
}

function renderContacts() {
  const contactDefs = contactFilterDefs();
  const contactsFiltersOn = getHeaderFiltersOn("contactsFiltersEnabled");
  const filteredContacts = state.contacts.filter(contactMatchesFilters);
  const filtersActive = contactsFiltersOn && anyHeaderFilterActive(contactDefs, contactsFilters);
  const ownerOptions = contactsOwnerFilterOptions();
  const ownerColVisible = contactColVisible("owner");
  // When filters are toggled off, every header shows its plain label instead
  // of thFilterHtml's ▾ trigger.
  const cf = (colId, label) => contactsFiltersOn ? thFilterHtml(contactDefs, contactsFilters, colId, label) : label;

  // Drop any selected ids that no longer exist (contact deleted elsewhere)
  // so "N selected" never counts a row that isn't on screen anymore, and so
  // Export CSV's selection check below can't pick up a stale id.
  const validIds = new Set(state.contacts.map((c) => c.id));
  Array.from(contactsSelected).forEach((id) => { if (!validIds.has(id)) contactsSelected.delete(id); });
  const allSelected = filteredContacts.length > 0 && filteredContacts.every((c) => contactsSelected.has(c.id));
  const tableMode = getContactsTableMode();

  document.getElementById("topbar-actions").innerHTML = `
    <div class="topbar-filters">
      ${(contactsFiltersOn && !ownerColVisible && ownerOptions) ? `
        <select id="contacts-filter-owner">
          <option value="">All owners</option>
          ${ownerOptions.map((u) => `<option value="${u.id}" ${contactsFilters.owner === String(u.id) ? "selected" : ""}>${u.id === state.user.id ? "Just me" : u.name}</option>`).join("")}
        </select>
      ` : ""}
      ${filtersActive ? `<button type="button" class="btn btn-small" id="contacts-filter-clear-btn">Clear filters</button>` : ""}
      <span class="topbar-filter-count">${filteredContacts.length} of ${state.contacts.length}</span>
    </div>
    <span class="topbar-divider"></span>
    <button class="btn btn-compact" id="apollo-search-contacts-btn">🔍 Search Apollo</button>
    <button class="btn btn-compact" id="export-contacts-btn">Export CSV${contactsSelected.size ? ` (${contactsSelected.size} selected)` : ""}</button>
    <button class="btn btn-compact" id="export-contacts-xlsx-btn">Export XLSX</button>
    <button class="btn btn-compact" id="import-contacts-btn">Import</button>
    <button class="btn btn-compact" id="quick-add-btn">✨ Quick Add</button>
    <button class="btn btn-primary btn-compact" id="new-contact-btn">+ New Contact</button>
    <button type="button" class="btn btn-compact" id="contacts-table-mode-btn" title="${tableMode === "fit" ? "Switch to Full list — table grows with the page instead of scrolling in its own box" : "Switch to Fit window — bounds the table to a scrollable box so its scrollbar never leaves the screen"}">${tableMode === "fit" ? "⬍ Full list" : "⛶ Fit window"}</button>
  `;
  document.getElementById("new-contact-btn").addEventListener("click", () => openContactFormModal());
  document.getElementById("apollo-search-contacts-btn").addEventListener("click", () => openApolloSearchModal("people"));
  document.getElementById("export-contacts-btn").addEventListener("click", exportContactsCSV);
  document.getElementById("export-contacts-xlsx-btn").addEventListener("click", exportContactsXlsx);
  document.getElementById("import-contacts-btn").addEventListener("click", () => openImportSourceModal("contacts"));
  document.getElementById("quick-add-btn").addEventListener("click", openQuickAddModal);
  document.getElementById("contacts-table-mode-btn").addEventListener("click", () => {
    setContactsTableMode(tableMode === "fit" ? "full" : "fit");
    renderContacts();
  });

  const cv = contactColVisible;

  const root = document.getElementById("view-root");
  root.innerHTML = `
    ${contactsScopeFilter ? `
      <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
        <span class="pill pill-active">Showing contacts for this scope</span>
        <button class="btn btn-small" id="contacts-clear-scope-btn">Show all contacts</button>
      </div>
    ` : ""}
    ${contactsSelected.size ? `
      <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px">
        <span style="font-size:13px;font-weight:600">${contactsSelected.size} selected</span>
        <select id="bulk-status-select" style="width:auto">
          ${CONTACT_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join("")}
        </select>
        <button type="button" class="btn btn-small btn-primary" id="bulk-status-apply-btn">Set status</button>
        <button type="button" class="btn btn-small" id="bulk-draft-all-btn">✨ Draft all</button>
        <button type="button" class="btn btn-small" id="bulk-clear-btn">Clear selection</button>
        <span style="font-size:12px;color:var(--text-dim)">Export CSV/XLSX above will export only these while they're selected.</span>
        ${["admin", "manager"].includes(state.user.role) ? `<button type="button" class="btn btn-small btn-danger" id="contacts-bulk-delete-btn" title="Delete selected" aria-label="Delete selected" style="margin-left:auto">🗑</button>` : ""}
      </div>
    ` : ""}
    <div class="panel">
      <div class="table-scroll contacts-table${tableMode === "fit" ? " contacts-table--bounded" : ""}">
      <table>
        <thead><tr>
          <th class="sticky-col1" style="width:52px">
            <input type="checkbox" id="contacts-select-all" ${allSelected ? "checked" : ""} />
            <button type="button" class="col-menu-btn" id="contacts-columns-btn" title="Show/hide or filter columns" aria-label="Show/hide or filter columns">⋮</button>
          </th>
          <th>${cf("name", "Name")}</th>
          ${cv("date") ? `<th>${cf("date", "Date")}</th>` : ""}
          ${cv("title") ? `<th>${cf("title", "Title")}</th>` : ""}
          ${cv("account") ? `<th>${cf("account", "Account")}</th>` : ""}
          ${cv("email") ? `<th>${cf("email", "Email")}</th>` : ""}
          ${cv("emailIcon") ? `<th style="text-align:center">${cf("emailIcon", "Send")}</th>` : ""}
          ${cv("linkedin") ? `<th style="text-align:center">${cf("linkedin", "LinkedIn")}</th>` : ""}
          ${cv("iq") ? `<th style="text-align:center">${cf("iq", "IQ")}</th>` : ""}
          ${cv("owner") ? `<th>${cf("owner", "Owner")}</th>` : ""}
          ${cv("status") ? `<th>${cf("status", "Status")}</th>` : ""}
          ${cv("draftType") ? `<th>${cf("draftType", "Draft Type")}</th>` : ""}
          ${cv("draft") ? `<th>${cf("draft", "Draft")}</th>` : ""}
          ${cv("emailDate") ? `<th>${cf("emailDate", "Email Date")}</th>` : ""}
          ${cv("response") ? `<th>${cf("response", "Response")}</th>` : ""}
          <th style="width:34px">${filtersToggleButtonHtml("contacts", contactsFiltersOn)}</th>
        </tr></thead>
        <tbody>
          ${filteredContacts.map((c) => `
            <tr class="row-click" data-contact="${c.id}">
              <td class="sticky-col1" onclick="event.stopPropagation()"><input type="checkbox" data-contact-select="${c.id}" ${contactsSelected.has(c.id) ? "checked" : ""} /></td>
              <td>${c.first_name} ${c.last_name}</td>
              ${cv("date") ? `<td>${shortDate(c.created_at)}</td>` : ""}
              ${cv("title") ? `<td>${c.title || "—"}</td>` : ""}
              ${cv("account") ? `<td>${accountName(c.account_id)}</td>` : ""}
              ${cv("email") ? `<td>${c.email || "—"}</td>` : ""}
              ${cv("emailIcon") ? `
                <td onclick="event.stopPropagation()" style="text-align:center">
                  ${c.email
                    ? `<button type="button" class="email-icon email-icon-active" data-email-send="${c.id}" title="Send email">${EMAIL_ICON_SVG}</button>`
                    : `<span class="email-icon email-icon-empty" title="No email on file">${EMAIL_ICON_SVG}</span>`}
                </td>
              ` : ""}
              ${cv("linkedin") ? `
                <td onclick="event.stopPropagation()" style="text-align:center">
                  ${c.linkedin_url
                    ? `<a href="${escapeAttr(c.linkedin_url)}" target="_blank" rel="noopener" class="linkedin-icon linkedin-icon-active" title="View LinkedIn profile">${LINKEDIN_ICON_SVG}</a>`
                    : `<span class="linkedin-icon linkedin-icon-empty" title="No LinkedIn URL on file — add one from Edit contact">${LINKEDIN_ICON_SVG}</span>`}
                </td>
              ` : ""}
              ${cv("iq") ? `
                <td onclick="event.stopPropagation()" style="text-align:center">
                  <button type="button" class="draft-pill" data-iq-open="${c.id}" title="${c.iq_notes ? "Click to view/edit IQ notes" : "Click to add IQ notes"}">
                    ${c.iq_notes ? "IQ ✓" : "+ Add"}
                  </button>
                </td>
              ` : ""}
              ${cv("owner") ? `<td>${userName(c.owner_id)}</td>` : ""}
              ${cv("status") ? `
                <td onclick="event.stopPropagation()">
                  <select data-status-select="${c.id}">
                    ${CONTACT_STATUSES.map((s) => `<option value="${s}" ${(c.status || "Fresh") === s ? "selected" : ""}>${s}</option>`).join("")}
                  </select>
                </td>
              ` : ""}
              ${cv("draftType") ? `
                <td onclick="event.stopPropagation()">
                  <select data-draft-mode-select="${c.id}">
                    <option value="" ${!c.draft_mode ? "selected" : ""}>—</option>
                    <option value="auto" ${c.draft_mode === "auto" ? "selected" : ""}>Auto</option>
                    <option value="manual" ${c.draft_mode === "manual" ? "selected" : ""}>Manual</option>
                  </select>
                </td>
              ` : ""}
              ${cv("draft") ? `
                <td onclick="event.stopPropagation()">
                  <button type="button" class="draft-pill" data-draft-open="${c.id}" title="${c.draft_text ? "Click to view/edit draft" : "Click to add a draft"}">
                    ${c.draft_text ? escapeAttr(c.draft_text.slice(0, 42)) + (c.draft_text.length > 42 ? "…" : "") : "+ Add"}
                  </button>
                </td>
              ` : ""}
              ${cv("emailDate") ? `<td>${shortDate(c.last_emailed_at)}</td>` : ""}
              ${cv("response") ? `
                <td onclick="event.stopPropagation()">
                  <button type="button" class="draft-pill" data-response-open="${c.id}" title="${c.response_text ? "Click to view/edit response" : "Click to log the contact's response"}">
                    ${c.response_text ? escapeAttr(c.response_text.slice(0, 42)) + (c.response_text.length > 42 ? "…" : "") : "+ Add"}
                  </button>
                </td>
              ` : ""}
              <td></td>
            </tr>
          `).join("") || `<tr><td colspan="20" class="empty-state">${filtersActive ? "No contacts match these filters." : "No contacts yet."}</td></tr>`}
        </tbody>
      </table>
      </div>
    </div>
  `;

  root.querySelectorAll("[data-contact]").forEach((tr) => {
    tr.addEventListener("click", () => openContactDetailModal(byId(state.contacts, tr.dataset.contact)));
  });

  // Owner is the one filterable field that can end up with nowhere to live
  // in the header row (its column can be hidden, or hidden entirely for
  // non-admin/manager roles) -- when that's the case it falls back to this
  // topbar select instead of disappearing.
  const ownerFilterEl = document.getElementById("contacts-filter-owner");
  if (ownerFilterEl) {
    ownerFilterEl.addEventListener("change", (e) => {
      contactsFilters.owner = e.target.value;
      renderContacts();
    });
  }
  const filterClearBtn = document.getElementById("contacts-filter-clear-btn");
  if (filterClearBtn) {
    filterClearBtn.addEventListener("click", () => {
      contactsFilters = {};
      closeHeaderFilterPopover();
      renderContacts();
    });
  }
  root.querySelectorAll("[data-th-filter-btn]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openHeaderFilterPopover(contactDefs, contactsFilters, btn.dataset.thFilterBtn, btn, renderContacts);
    });
  });
  const contactsFiltersToggleBtn = root.querySelector('[data-filters-toggle-btn="contacts"]');
  if (contactsFiltersToggleBtn) {
    contactsFiltersToggleBtn.addEventListener("click", () => {
      const turningOn = !contactsFiltersOn;
      setHeaderFiltersOn("contactsFiltersEnabled", turningOn);
      if (!turningOn) {
        contactsFilters = {};
        closeHeaderFilterPopover();
      }
      renderContacts();
    });
  }
  const scopeClearBtn = document.getElementById("contacts-clear-scope-btn");
  if (scopeClearBtn) {
    scopeClearBtn.addEventListener("click", () => {
      contactsScopeFilter = null;
      renderContacts();
    });
  }

  const selectAllEl = document.getElementById("contacts-select-all");
  if (selectAllEl) {
    selectAllEl.addEventListener("change", (e) => {
      // Only acts on the rows currently visible under the active filters --
      // selections on filtered-out rows are left alone rather than wiped.
      if (e.target.checked) filteredContacts.forEach((c) => contactsSelected.add(c.id));
      else filteredContacts.forEach((c) => contactsSelected.delete(c.id));
      renderContacts();
    });
  }

  root.querySelectorAll("[data-contact-select]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(cb.dataset.contactSelect);
      if (e.target.checked) contactsSelected.add(id);
      else contactsSelected.delete(id);
      renderContacts();
    });
  });

  root.querySelectorAll("[data-status-select]").forEach((sel) => {
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", async () => {
      const id = Number(sel.dataset.statusSelect);
      const status = sel.value;
      sel.disabled = true;
      try {
        const updated = await api(`/api/contacts/${id}`, { method: "PUT", body: { status } });
        const idx = state.contacts.findIndex((c) => c.id === id);
        if (idx !== -1) state.contacts[idx] = updated;
        toast("Status updated");
        // Draft Type already "Auto" for this contact -- picking a new
        // Fresh/Follow-up stage regenerates that stage's email right away,
        // chained off whatever's already been drafted for earlier stages.
        await autoGenerateStageIfNeeded(updated);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        sel.disabled = false;
      }
    });
  });

  root.querySelectorAll("[data-draft-mode-select]").forEach((sel) => {
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", async (e) => {
      const id = Number(sel.dataset.draftModeSelect);
      const c = byId(state.contacts, id);
      const val = e.target.value;
      // Picking Auto or Manual just opens the matching modal -- nothing is
      // saved until the modal's own Save button, so the select isn't a
      // persisted toggle by itself (no re-render needed here; the DOM
      // already shows what was picked).
      if (val === "auto") { openAutoDraftModal(c); return; }
      if (val === "manual") { openManualDraftModal(c); return; }
      if (!c.draft_mode) return; // was already blank, nothing to clear
      if (!confirm("Clear the saved draft for this contact?")) { renderContacts(); return; }
      try {
        const updated = await api(`/api/contacts/${id}`, { method: "PUT", body: { draft_mode: null, draft_text: "", followups: [] } });
        const idx = state.contacts.findIndex((x) => x.id === id);
        if (idx !== -1) state.contacts[idx] = updated;
        toast("Draft cleared");
      } catch (err) {
        toast(err.message, "error");
      }
      renderContacts();
    });
  });

  root.querySelectorAll("[data-draft-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.draftOpen);
      const c = byId(state.contacts, id);
      if (c.draft_mode === "auto") openAutoDraftModal(c);
      else if (c.draft_mode === "manual") openManualDraftModal(c);
      else openDraftChooserModal(c);
    });
  });

  root.querySelectorAll("[data-response-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.responseOpen);
      openResponseModal(byId(state.contacts, id));
    });
  });

  root.querySelectorAll("[data-iq-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.iqOpen);
      openContactIQModal(byId(state.contacts, id));
    });
  });

  root.querySelectorAll("[data-email-send]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.emailSend);
      sendContactEmail(byId(state.contacts, id));
    });
  });

  const columnsBtn = document.getElementById("contacts-columns-btn");
  if (columnsBtn) {
    columnsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openContactColumnsModal();
    });
  }

  const bulkDraftAllBtn = document.getElementById("bulk-draft-all-btn");
  if (bulkDraftAllBtn) {
    bulkDraftAllBtn.addEventListener("click", async () => {
      const ids = Array.from(contactsSelected);
      const targets = ids.map((id) => byId(state.contacts, id)).filter((c) => c && AUTO_DRAFT_STAGES.has(c.status || "Fresh"));
      if (!targets.length) { toast("None of the selected contacts have a Fresh/Follow-up status to draft", "error"); return; }
      bulkDraftAllBtn.disabled = true;
      bulkDraftAllBtn.textContent = "Drafting…";
      const results = await runWithConcurrency(targets, 4, (c) => api("/api/ai/draft-stage", { method: "POST", body: { contact_id: c.id } }));
      let ok = 0;
      results.forEach((r) => {
        if (r.status === "fulfilled") {
          const updated = r.value.contact;
          const idx = state.contacts.findIndex((x) => x.id === updated.id);
          if (idx !== -1) state.contacts[idx] = updated;
          ok++;
        }
      });
      const failed = results.length - ok;
      const skipped = ids.length - targets.length;
      toast(
        `Drafted ${ok} of ${targets.length}${failed ? ` — ${failed} failed (${results.find((r) => r.status === "rejected")?.reason?.message || "unknown error"})` : ""}${skipped ? ` — ${skipped} skipped (not a Fresh/Follow-up status)` : ""}. Use Export CSV/XLSX above to download.`,
        failed ? "error" : "success"
      );
      bulkDraftAllBtn.disabled = false;
      bulkDraftAllBtn.textContent = "✨ Draft all";
      renderContacts();
    });
  }

  const bulkApplyBtn = document.getElementById("bulk-status-apply-btn");
  if (bulkApplyBtn) {
    bulkApplyBtn.addEventListener("click", async () => {
      const status = document.getElementById("bulk-status-select").value;
      const ids = Array.from(contactsSelected);
      bulkApplyBtn.disabled = true;
      bulkApplyBtn.textContent = "Applying…";
      try {
        const updates = await Promise.all(ids.map((id) => api(`/api/contacts/${id}`, { method: "PUT", body: { status } })));
        updates.forEach((updated) => {
          const idx = state.contacts.findIndex((c) => c.id === updated.id);
          if (idx !== -1) state.contacts[idx] = updated;
        });
        toast(`Status set to "${status}" for ${ids.length} contact${ids.length === 1 ? "" : "s"}`);
        contactsSelected.clear();
        renderContacts();
      } catch (err) {
        toast(err.message, "error");
        bulkApplyBtn.disabled = false;
        bulkApplyBtn.textContent = "Set status";
      }
    });
  }

  const bulkClearBtn = document.getElementById("bulk-clear-btn");
  if (bulkClearBtn) {
    bulkClearBtn.addEventListener("click", () => {
      contactsSelected.clear();
      renderContacts();
    });
  }

  const contactsBulkDeleteBtn = document.getElementById("contacts-bulk-delete-btn");
  if (contactsBulkDeleteBtn) {
    contactsBulkDeleteBtn.addEventListener("click", async () => {
      const ids = Array.from(contactsSelected);
      if (!confirm(`Delete ${ids.length} contact${ids.length === 1 ? "" : "s"}? This can't be undone.`)) return;
      contactsBulkDeleteBtn.disabled = true;
      contactsBulkDeleteBtn.textContent = "⏳";
      // Promise.allSettled (see the matching Accounts handler for why): a
      // single failed delete in the batch used to reject Promise.all and
      // leave every row -- including ones already deleted server-side --
      // still showing in the table.
      const results = await runWithConcurrency(ids, 5, (id) => api(`/api/contacts/${id}`, { method: "DELETE" }));
      const succeededIds = ids.filter((_, i) => results[i].status === "fulfilled");
      const failed = ids
        .map((id, i) => ({ id, result: results[i] }))
        .filter((r) => r.result.status === "rejected");
      if (succeededIds.length) {
        state.contacts = state.contacts.filter((c) => !succeededIds.includes(c.id));
        succeededIds.forEach((id) => contactsSelected.delete(id));
      }
      if (failed.length) {
        const names = failed
          .map((f) => {
            const c = state.contacts.find((c) => c.id === f.id);
            return c ? `${c.first_name} ${c.last_name}`.trim() : `#${f.id}`;
          })
          .slice(0, 3)
          .join(", ");
        toast(
          `Deleted ${succeededIds.length} of ${ids.length} — ${failed.length} failed (${names}${failed.length > 3 ? ", …" : ""}): ${failed[0].result.reason?.message || "unknown error"}`,
          "error"
        );
      } else {
        toast(`Deleted ${succeededIds.length} contact${succeededIds.length === 1 ? "" : "s"}`);
      }
      contactsBulkDeleteBtn.disabled = false;
      contactsBulkDeleteBtn.textContent = "🗑";
      renderContacts();
    });
  }
}

// ---------- Contacts: outreach drafts (Auto/Manual) ----------

const LINKEDIN_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.15 1.45-2.15 2.94v5.67H9.35V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z"/></svg>`;

const EMAIL_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg>`;

// Magnifying-glass-with-sliders "filters on/off" icon, sized to match the
// other small row icons above (Email/LinkedIn are 16x16) rather than the
// larger multi-color version it's based on -- single-color currentColor
// line art so it can sit in a plain header button like col-menu-btn.
const FILTERS_TOGGLE_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7"></circle><line x1="15.2" y1="15.2" x2="20.5" y2="20.5"></line><line x1="6.5" y1="7" x2="12" y2="7"></line><circle cx="8.2" cy="7" r="1.1" fill="currentColor" stroke="none"></circle><line x1="7" y1="10" x2="13.5" y2="10"></line><circle cx="11" cy="10" r="1.1" fill="currentColor" stroke="none"></circle><line x1="6.5" y1="13" x2="12.5" y2="13"></line><circle cx="9.3" cy="13" r="1.1" fill="currentColor" stroke="none"></circle></svg>`;

// The outreach stages that the auto-draft workflow (point 6) actually
// applies to -- the other CONTACT_STATUSES (Bounced/Cold/Warm/Prospect/
// Negative/LinkedIn) are outcome tags, not sequence stages, so picking one
// of those never triggers a draft generation.
const AUTO_DRAFT_STAGES = new Set(["Fresh", "1st Followup", "2nd Followup", "3rd Followup", "4th Followup", "5th Followup"]);

// Fires the stage-chained AI draft for whatever Status a contact is
// currently set to, but only when that contact has already opted into Auto
// drafting -- this is the "when I select Fresh and Auto, generate
// automatically" behavior, triggered from the Status dropdown's change
// handler once the status update itself has saved.
async function autoGenerateStageIfNeeded(contact) {
  if (contact.draft_mode !== "auto") return;
  if (!AUTO_DRAFT_STAGES.has(contact.status || "Fresh")) return;
  try {
    const { contact: updated, stage } = await api("/api/ai/draft-stage", { method: "POST", body: { contact_id: contact.id } });
    const idx = state.contacts.findIndex((c) => c.id === updated.id);
    if (idx !== -1) state.contacts[idx] = updated;
    toast(`Draft generated for ${stage}`);
    renderContacts();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Which mail app the Email icon column sends through, per the rep's Settings
// > Integrations preference (defaults to Outlook Classic -- the mailto:
// link that hands off to whatever desktop mail client is installed, which
// is what's already in this app as the zero-setup fallback).
function defaultEmailMethod() {
  return state.user.email_method || "outlook_classic";
}

function sendContactEmail(c) {
  if (!c.email) { toast("No email on file for this contact", "error"); return; }
  const bodyText = c.draft_text || mailBody(c.first_name);
  const method = defaultEmailMethod();
  if (method === "apollo") {
    toast("Apollo email sending isn't set up for this workspace yet — switch your default in Settings > Integrations, or use Outlook.", "error");
    return;
  }
  const links = buildMailLinks(c.email, bodyText);
  if (method === "outlook_web") window.open(links.owa, "_blank", "noopener");
  else window.location.href = links.mailto;
  // Best-effort: mailto:/OWA hand off to another app with no send
  // confirmation, so this optimistically stamps Email Date the moment the
  // rep initiates the send rather than trying (and failing) to detect
  // actual delivery.
  api(`/api/contacts/${c.id}`, { method: "PUT", body: { last_emailed_at: todayISO() } })
    .then((updated) => {
      const idx = state.contacts.findIndex((x) => x.id === updated.id);
      if (idx !== -1) state.contacts[idx] = updated;
      renderContacts();
    })
    .catch(() => { /* non-critical -- the email app still opened either way */ });
}

// Per-contact free-text notes ("IQ") -- separate from the Fresh/Follow-up
// Draft text and from Account-level research, this is what the rep knows
// about THIS person specifically (their priorities, something said on a
// call, a detail from their LinkedIn). Folded into the auto-draft prompt as
// "contactIQ" context. The modal window itself is already drag-resizable
// (see the shared modal chrome), so no extra sizing UI is needed here.
function openContactIQModal(c) {
  openModal(`
    <h2>IQ notes — ${c.first_name} ${c.last_name}</h2>
    <div class="hint" style="margin-bottom:10px">Free-form notes about this specific contact — used as context when auto-drafting their outreach emails. Drag the bottom-right corner to resize this window.</div>
    <textarea id="contact-iq-text" rows="12" style="width:100%;box-sizing:border-box" placeholder="e.g. cares most about audit trail/compliance, mentioned they're evaluating 2 other vendors, prefers short emails…">${c.iq_notes || ""}</textarea>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
      <button type="button" class="btn btn-primary" id="contact-iq-save-btn">Save</button>
    </div>
  `, { wide: true });
  document.getElementById("contact-iq-save-btn").addEventListener("click", async () => {
    const btn = document.getElementById("contact-iq-save-btn");
    const iq_notes = document.getElementById("contact-iq-text").value;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const updated = await api(`/api/contacts/${c.id}`, { method: "PUT", body: { iq_notes } });
      const idx = state.contacts.findIndex((x) => x.id === c.id);
      if (idx !== -1) state.contacts[idx] = updated;
      toast("IQ notes saved");
      closeModal();
      renderContacts();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Save";
    }
  });
}

// Shown when a rep clicks a contact's empty Draft box -- lets them pick a
// path before either modal opens, rather than forcing the Draft Type
// dropdown to be the only way in.
function openDraftChooserModal(c) {
  openModal(`
    <h2>Add draft — ${c.first_name} ${c.last_name}</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:16px">Choose how you want to create this contact's outreach draft.</div>
    <div class="modal-actions" style="justify-content:stretch;gap:10px">
      <button type="button" class="btn btn-primary" id="draft-choose-auto" style="flex:1">✨ Generate with AI</button>
      <button type="button" class="btn" id="draft-choose-manual" style="flex:1">Write manually</button>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
    </div>
  `);
  document.getElementById("draft-choose-auto").addEventListener("click", () => openAutoDraftModal(c));
  document.getElementById("draft-choose-manual").addEventListener("click", () => openManualDraftModal(c));
}

function renderSequenceEditor(draft, followups) {
  const fu = followups && followups.length ? followups : ["", "", "", "", ""];
  return `
    <label>Draft (editable)</label>
    <textarea id="seq-draft-text" class="draft-font" rows="5">${draft || ""}</textarea>
    ${fu.map((f, i) => `
      <label style="margin-top:10px">Follow-up ${i + 1}</label>
      <textarea id="seq-followup-${i}" class="draft-font" rows="3">${f || ""}</textarea>
    `).join("")}
    <div class="modal-actions" style="margin-top:10px">
      <button type="button" class="btn btn-primary" id="seq-save-btn">Save draft</button>
    </div>
  `;
}

function wireSequenceSave(contactId) {
  document.getElementById("seq-save-btn").addEventListener("click", async () => {
    const btn = document.getElementById("seq-save-btn");
    const draft_text = document.getElementById("seq-draft-text").value;
    const followups = [0, 1, 2, 3, 4].map((i) => document.getElementById(`seq-followup-${i}`).value);
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const updated = await api(`/api/contacts/${contactId}`, { method: "PUT", body: { draft_mode: "auto", draft_text, followups } });
      const idx = state.contacts.findIndex((x) => x.id === contactId);
      if (idx !== -1) state.contacts[idx] = updated;
      toast("Draft saved");
      closeModal();
      renderContacts();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Save draft";
    }
  });
}

// Auto mode: generates a first-touch draft + 5 follow-ups from the
// contact's linked-account data plus whatever extra context the rep adds,
// via POST /api/ai/draft-sequence. Nothing is persisted until Save --
// Generate can be re-run as many times as needed first.
// Auto mode: generates ONE stage's email at a time -- whichever stage this
// contact's Status is currently on -- chained off any earlier stages already
// saved, fed by the linked Account, this contact's IQ notes, and the
// company profile (see POST /api/ai/draft-stage). The first time a contact
// is switched to Auto there's nothing generated yet, so this fires the
// generation immediately rather than making the rep click Generate first --
// "when I select Fresh and Auto, generate automatically." Regenerate redoes
// just the current stage; earlier stages already saved are left alone.
function openAutoDraftModal(c) {
  const hasExisting = c.draft_mode === "auto" && (c.draft_text || (c.followups || []).some(Boolean));
  const stage = c.status || "Fresh";
  const stageIsAutoable = AUTO_DRAFT_STAGES.has(stage);
  openModal(`
    <h2>✨ Auto-generate draft — ${c.first_name} ${c.last_name}</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">Generates this contact's "${escapeAttr(stage)}" email from the linked Account, this contact's IQ notes, your company profile, and anything already drafted for earlier stages -- plus whatever you add below.</div>
    ${stageIsAutoable ? `
      <label>Extra context (optional)</label>
      <textarea id="seq-context" rows="3" placeholder="e.g. recent funding round, a pain point from the call, product angle to lead with…"></textarea>
      <div class="modal-actions" style="margin-top:8px">
        <button type="button" class="btn btn-primary" id="seq-generate-btn">${hasExisting ? `Regenerate ${escapeAttr(stage)}` : `Generate ${escapeAttr(stage)}`}</button>
      </div>
    ` : `<div class="hint" style="color:var(--coral)">Auto-draft only applies to the Fresh/Follow-up statuses -- set this contact's Status to one of those first, then come back here.</div>`}
    <div id="seq-result" style="margin-top:14px">${hasExisting ? renderSequenceEditor(c.draft_text, c.followups || []) : ""}</div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
    </div>
  `, { wide: true });
  if (hasExisting) wireSequenceSave(c.id);

  const runGenerate = async () => {
    const btn = document.getElementById("seq-generate-btn");
    const contextEl = document.getElementById("seq-context");
    const resultEl = document.getElementById("seq-result");
    if (!btn || !resultEl) return;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Generating…";
    try {
      const { contact: updated, stage: gotStage } = await api("/api/ai/draft-stage", {
        method: "POST",
        body: { contact_id: c.id, context: contextEl ? contextEl.value.trim() : "" },
      });
      const idx = state.contacts.findIndex((x) => x.id === c.id);
      if (idx !== -1) state.contacts[idx] = updated;
      resultEl.innerHTML = renderSequenceEditor(updated.draft_text, updated.followups || []);
      wireSequenceSave(c.id);
      toast(`Draft generated for ${gotStage}`);
    } catch (err) {
      resultEl.innerHTML = `<div class="hint" style="color:var(--coral);margin-top:10px">${err.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  };

  const generateBtn = document.getElementById("seq-generate-btn");
  if (generateBtn) generateBtn.addEventListener("click", runGenerate);
  // First time this contact is set to Auto (nothing generated yet): fire
  // the current stage's generation right away instead of waiting for a
  // click.
  if (!hasExisting && stageIsAutoable) runGenerate();
}

// Manual mode: the rep just writes/pastes their own draft -- no AI call, no
// follow-up sequence (a manual draft is a single message the rep owns).
function openManualDraftModal(c) {
  const existing = c.draft_mode === "manual" ? (c.draft_text || "") : "";
  openModal(`
    <h2>Write draft — ${c.first_name} ${c.last_name}</h2>
    <label>Draft</label>
    <textarea id="manual-draft-text" class="draft-font" rows="8" placeholder="Paste or write your outreach draft…">${existing}</textarea>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="manual-draft-save-btn">Save draft</button>
    </div>
  `);
  document.getElementById("manual-draft-save-btn").addEventListener("click", async () => {
    const btn = document.getElementById("manual-draft-save-btn");
    const draft_text = document.getElementById("manual-draft-text").value;
    if (!draft_text.trim()) { toast("Enter a draft first", "error"); return; }
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const updated = await api(`/api/contacts/${c.id}`, { method: "PUT", body: { draft_mode: "manual", draft_text, followups: [] } });
      const idx = state.contacts.findIndex((x) => x.id === c.id);
      if (idx !== -1) state.contacts[idx] = updated;
      toast("Draft saved");
      closeModal();
      renderContacts();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Save draft";
    }
  });
}

// The reply/response a rep got back from the contact -- a free-text field,
// separate from Status (which is the outreach-stage tag). Same click-to-
// open pattern as the Draft pill: a small truncated preview in the table,
// full text only in the modal, so the row stays compact.
function openResponseModal(c) {
  const existing = c.response_text || "";
  openModal(`
    <h2>Response — ${c.first_name} ${c.last_name}</h2>
    <label>What did they reply?</label>
    <textarea id="response-text" rows="6" placeholder="Paste or write the contact's response…">${existing}</textarea>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="response-save-btn">Save response</button>
    </div>
  `);
  document.getElementById("response-save-btn").addEventListener("click", async () => {
    const btn = document.getElementById("response-save-btn");
    const response_text = document.getElementById("response-text").value;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const updated = await api(`/api/contacts/${c.id}`, { method: "PUT", body: { response_text } });
      const idx = state.contacts.findIndex((x) => x.id === c.id);
      if (idx !== -1) state.contacts[idx] = updated;
      toast("Response saved");
      closeModal();
      renderContacts();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Save response";
    }
  });
}

function mailBody(firstName) {
  return `Hi ${firstName || ""},\n\n`;
}

// Classic fallback for when no mailbox is connected through the app (no
// Azure/Graph setup needed at all): mailto: hands off to whatever desktop
// mail client is installed, and the OWA link opens a compose window in
// Outlook on the web. Both work immediately, with zero backend setup.
function buildMailLinks(email, bodyText) {
  const bodyQS = encodeURIComponent(bodyText);
  return {
    mailto: `mailto:${encodeURIComponent(email)}?body=${bodyQS}`,
    owa: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(email)}&body=${bodyQS}`,
  };
}

function openContactDetailModal(c) {
  const email = c.email || "";
  const initialBody = mailBody(c.first_name);
  const company = accountName(c.account_id) !== "—" ? accountName(c.account_id) : "";
  const connections = state.outlookConnections || [];
  const classicLinks = email ? buildMailLinks(email, initialBody) : null;

  openModal(`
    <h2>${c.first_name} ${c.last_name}</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:16px">
      ${[c.title, company || null].filter(Boolean).join(" &middot; ") || "—"}
    </div>
    <table style="width:100%;font-size:13px;margin-bottom:18px">
      <tr><td style="color:var(--text-dim);padding:5px 0">Email</td><td style="text-align:right">${email || "—"}</td></tr>
      <tr><td style="color:var(--text-dim);padding:5px 0">Phone</td><td style="text-align:right">${c.phone || "—"}</td></tr>
      <tr><td style="color:var(--text-dim);padding:5px 0">LinkedIn</td><td style="text-align:right">${c.linkedin_url ? `<a href="${c.linkedin_url}" target="_blank" rel="noopener" style="color:var(--teal)">View profile ↗</a>` : "—"}</td></tr>
      <tr><td style="color:var(--text-dim);padding:5px 0">Sales Navigator</td><td style="text-align:right">${c.sales_navigator_url ? `<a href="${c.sales_navigator_url}" target="_blank" rel="noopener" style="color:var(--teal)">Open in Sales Nav ↗</a>` : "—"}</td></tr>
      <tr><td style="color:var(--text-dim);padding:5px 0">Salesforce</td><td style="text-align:right">${c.sf_id ? (sfRecordUrl("Contact", c.sf_id) ? `<a href="${sfRecordUrl("Contact", c.sf_id)}" target="_blank" rel="noopener" style="color:var(--teal)">View in Salesforce ↗</a>` : `<span class="pill pill-active">Synced</span>`) : (state.salesforce?.connected ? `<button type="button" class="btn btn-small" id="contact-sf-push-btn">Push to Salesforce</button>` : "—")}</td></tr>
      ${c.li_capture?.location ? `<tr><td style="color:var(--text-dim);padding:5px 0">Location</td><td style="text-align:right">${escapeAttr(c.li_capture.location)}</td></tr>` : ""}
    </table>
    ${c.li_capture?.about ? `
      <div class="panel" style="padding:12px;margin-bottom:16px">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">About (captured from LinkedIn${c.li_capture.connection_degree ? ` — ${escapeAttr(c.li_capture.connection_degree)} connection` : ""})</div>
        <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:180px;overflow-y:auto">${escapeAttr(c.li_capture.about)}</div>
        <div class="hint" style="margin-top:6px">Captured ${new Date(c.li_capture.captured_at).toLocaleString()} via the browser extension.</div>
      </div>
    ` : ""}
    ${email ? (connections.length ? `
      <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:4px">Send from</label>
      <select id="contact-email-from" style="margin-bottom:10px">
        ${connections.map((cn) => `<option value="${cn.id}">${escapeAttr(cn.email)}${cn.display_name ? ` — ${escapeAttr(cn.display_name)}` : ""}</option>`).join("")}
      </select>
      <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:4px">Subject</label>
      <input id="contact-email-subject" style="width:100%;margin-bottom:10px;box-sizing:border-box" placeholder="Following up" />
      <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:4px">Message</label>
      <textarea id="contact-email-body" class="draft-font" rows="5" style="width:100%;margin-bottom:8px;box-sizing:border-box">${initialBody}</textarea>
      <div class="error-text" id="contact-email-error"></div>
      <div style="display:flex;gap:10px;margin-bottom:8px">
        <button type="button" class="btn" id="ai-draft-toggle" style="flex:1">✨ Draft with AI</button>
        <button type="button" class="btn btn-primary" id="contact-email-send-btn" style="flex:1">Send</button>
      </div>
      <div class="hint" style="margin-top:0">Sends straight from the app — no Outlook window opens.</div>
      <div id="ai-draft-panel" class="hidden" style="margin-top:12px">
        <label>What's this email about? (optional)</label>
        <textarea id="ai-draft-context" placeholder="e.g. following up on our demo last week, checking in after the trial ended…"></textarea>
        <div class="modal-actions" style="margin-top:8px">
          <button type="button" class="btn btn-primary" id="ai-draft-generate">Generate draft</button>
        </div>
        <div id="ai-draft-result"></div>
      </div>
    ` : `
      <div style="display:flex;gap:10px;margin-bottom:8px">
        <a class="btn" id="mailto-link" style="flex:1;text-align:center;text-decoration:none" href="${classicLinks.mailto}">Email — Outlook desktop</a>
        <a class="btn" id="owa-link" style="flex:1;text-align:center;text-decoration:none" href="${classicLinks.owa}" target="_blank" rel="noopener">Email — Outlook web</a>
      </div>
      <div class="hint" style="margin-top:0">No mailbox connected in Settings yet, so this opens your desktop Outlook app or Outlook on the web to send instead.</div>
      <button type="button" class="btn" id="ai-draft-toggle" style="margin-top:14px">✨ Draft with AI</button>
      <div id="ai-draft-panel" class="hidden" style="margin-top:12px">
        <label>What's this email about? (optional)</label>
        <textarea id="ai-draft-context" placeholder="e.g. following up on our demo last week, checking in after the trial ended…"></textarea>
        <div class="modal-actions" style="margin-top:8px">
          <button type="button" class="btn btn-primary" id="ai-draft-generate">Generate draft</button>
        </div>
        <div id="ai-draft-result"></div>
      </div>
    `) : `<div class="empty-state">No email on file for this contact.</div>`}
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
      <button type="button" class="btn btn-primary" id="edit-contact-btn">Edit contact</button>
    </div>
  `);
  document.getElementById("edit-contact-btn").addEventListener("click", () => openContactFormModal(c));

  const contactSfBtn = document.getElementById("contact-sf-push-btn");
  if (contactSfBtn) {
    contactSfBtn.addEventListener("click", async () => {
      contactSfBtn.disabled = true;
      contactSfBtn.textContent = "Pushing…";
      try {
        const updated = await api(`/api/contacts/${c.id}/push-salesforce`, { method: "POST" });
        toast("Pushed to Salesforce");
        await loadAll();
        openContactDetailModal(byId(state.contacts, updated.id) || updated);
      } catch (err) {
        toast(err.message, "error");
        contactSfBtn.disabled = false;
        contactSfBtn.textContent = "Push to Salesforce";
      }
    });
  }

  if (!email) return;

  document.getElementById("ai-draft-toggle").addEventListener("click", () => {
    document.getElementById("ai-draft-panel").classList.toggle("hidden");
  });

  document.getElementById("ai-draft-generate").addEventListener("click", async () => {
    const btn = document.getElementById("ai-draft-generate");
    const context = document.getElementById("ai-draft-context").value.trim();
    const resultEl = document.getElementById("ai-draft-result");
    btn.disabled = true;
    btn.textContent = "Generating…";
    try {
      const { text } = await api("/api/ai/draft-email", {
        method: "POST",
        body: { contact_name: `${c.first_name} ${c.last_name}`, title: c.title, company, context },
      });
      resultEl.innerHTML = `
        <label style="margin-top:12px">Draft (editable)</label>
        <textarea id="ai-draft-text" class="draft-font" rows="6">${text}</textarea>
        <div class="modal-actions" style="margin-top:8px">
          <button type="button" class="btn btn-primary" id="ai-draft-use">Use this draft</button>
        </div>
      `;
      document.getElementById("ai-draft-use").addEventListener("click", () => {
        const bodyText = document.getElementById("ai-draft-text").value;
        const bodyField = document.getElementById("contact-email-body");
        if (bodyField) {
          // Silent-send mode (a mailbox is connected)
          bodyField.value = bodyText;
          document.getElementById("ai-draft-panel").classList.add("hidden");
          toast("Draft applied below — review and hit Send");
        } else {
          // Classic mode (mailto: / Outlook Web links)
          const newLinks = buildMailLinks(email, bodyText);
          document.getElementById("mailto-link").href = newLinks.mailto;
          document.getElementById("owa-link").href = newLinks.owa;
          toast("Draft applied — click Email above to open it");
        }
      });
    } catch (err) {
      resultEl.innerHTML = `<div class="hint" style="color:var(--coral);margin-top:10px">${err.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate draft";
    }
  });

  const sendBtn = document.getElementById("contact-email-send-btn");
  if (sendBtn) sendBtn.addEventListener("click", async () => {
    const btn = document.getElementById("contact-email-send-btn");
    const errorEl = document.getElementById("contact-email-error");
    errorEl.textContent = "";
    const subject = document.getElementById("contact-email-subject").value.trim();
    const bodyText = document.getElementById("contact-email-body").value;
    const connectionId = document.getElementById("contact-email-from").value;
    if (!subject) {
      errorEl.textContent = "Subject is required.";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const row = await api("/api/emailing/send", {
        method: "POST",
        body: { contact_id: c.id, subject, body: bodyText, connection_id: connectionId || undefined },
      });
      if (row.sent) {
        toast("Email sent");
        emailingEmails = await api("/api/emailing/emails").catch(() => emailingEmails);
        closeModal();
      } else {
        errorEl.textContent = row.reason || "Couldn't send — check your mailbox connection in Settings.";
      }
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });
}

// `draftOverride` is used only when re-opening this form after a detour to
// edit the linked Account (see the "Edit" button next to the Account select
// below) -- it carries the in-progress field values the user had already
// typed, layered on top of `existing`, so that detour doesn't lose their
// work. It never changes whether this is a create or an edit: that's still
// decided by `existing` alone, so the submit handler below still POSTs vs.
// PUTs correctly either way.
function openContactFormModal(existing, draftOverride) {
  const base = existing || { first_name: "", last_name: "", title: "", email: "", phone: "", linkedin_url: "", sales_navigator_url: "", account_id: "" };
  const v = draftOverride ? { ...base, ...draftOverride } : base;
  openModal(`
    <h2>${existing ? "Edit" : "New"} contact</h2>
    <form id="contact-form">
      <label>First name</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="contact-first-input" name="first_name" value="${escapeAttr(v.first_name)}" required style="flex:1" />
        <button type="button" class="btn" id="contact-autofill-btn">Auto-fill</button>
      </div>
      <label>Last name</label><input id="contact-last-input" name="last_name" value="${escapeAttr(v.last_name)}" required />
      <label>Title</label><input id="contact-title-input" name="title" value="${escapeAttr(v.title || "")}" />
      <label>Email</label><input id="contact-email-input" name="email" type="email" value="${escapeAttr(v.email || "")}" />
      <label>Phone</label><input id="contact-phone-input" name="phone" value="${escapeAttr(v.phone || "")}" />
      <label>LinkedIn URL</label><input id="contact-linkedin-input" name="linkedin_url" type="text" value="${escapeAttr(v.linkedin_url || "")}" placeholder="linkedin.com/in/..." />
      <label>Sales Navigator URL</label><input id="contact-salesnav-input" name="sales_navigator_url" type="text" value="${escapeAttr(v.sales_navigator_url || "")}" placeholder="linkedin.com/sales/lead/..." />
      <label>Account</label>
      <div style="display:flex;gap:8px;align-items:center">
        <select name="account_id" id="contact-account-select" style="flex:1">
          <option value="">—</option>
          ${state.accounts.map((a) => `<option value="${a.id}" ${Number(v.account_id) === a.id ? "selected" : ""}>${a.name}</option>`).join("")}
        </select>
        <button type="button" class="btn" id="contact-account-edit-btn" ${v.account_id ? "" : "disabled"}>Edit</button>
      </div>
      <div class="hint">Auto-fill looks up Title, LinkedIn URL, and a matching Account from First/Last name (and Email, if entered) using Apollo and Claude web search. It never guesses a phone number, and won't create a new Account. Pick an existing Account above, then use Edit to update its details without leaving this form.</div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${existing ? "Save changes" : "Create contact"}</button>
      </div>
    </form>
  `);
  // Edit button next to the Account select: only enabled once an Account is
  // actually picked, and opens that Account's own edit form -- the current
  // Contact field values (including whatever was just typed) are captured
  // first and restored when we come back, so this detour doesn't lose work.
  const accountSelect = document.getElementById("contact-account-select");
  const accountEditBtn = document.getElementById("contact-account-edit-btn");
  accountSelect.addEventListener("change", () => {
    accountEditBtn.disabled = !accountSelect.value;
  });
  accountEditBtn.addEventListener("click", () => {
    const account = state.accounts.find((a) => a.id === Number(accountSelect.value));
    if (!account) return;
    const draft = {
      first_name: document.getElementById("contact-first-input").value,
      last_name: document.getElementById("contact-last-input").value,
      title: document.getElementById("contact-title-input").value,
      email: document.getElementById("contact-email-input").value,
      phone: document.getElementById("contact-phone-input").value,
      linkedin_url: document.getElementById("contact-linkedin-input").value,
      sales_navigator_url: document.getElementById("contact-salesnav-input").value,
      account_id: account.id,
    };
    openAccountFormModal(account, (savedAccount) => {
      openContactFormModal(existing, { ...draft, account_id: savedAccount.id });
    });
  });
  // Auto-fill: mirrors the Account form's Auto-fill button. Apollo (people
  // search) is tried first, then Claude's live web search for whatever
  // Apollo didn't return. Phone is deliberately never touched by this button
  // — see /api/contacts/lookup-person for why. Account matching only links
  // to an Account that already exists; it never creates one.
  document.getElementById("contact-autofill-btn").addEventListener("click", async () => {
    const first_name = document.getElementById("contact-first-input").value.trim();
    const last_name = document.getElementById("contact-last-input").value.trim();
    if (!first_name || !last_name) { toast("Enter first and last name first", "error"); return; }
    const email = document.getElementById("contact-email-input").value.trim();
    const btn = document.getElementById("contact-autofill-btn");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Looking up…";
    try {
      const result = await api("/api/contacts/lookup-person", { method: "POST", body: { first_name, last_name, email } });
      const filled = [];
      if (result.title) { document.getElementById("contact-title-input").value = result.title; filled.push("title"); }
      if (result.linkedin_url) { document.getElementById("contact-linkedin-input").value = result.linkedin_url; filled.push("LinkedIn URL"); }
      if (result.account_id) {
        document.getElementById("contact-account-select").value = result.account_id;
        filled.push(`account (${result.account_name})`);
      }
      if (filled.length) {
        toast(`Filled ${filled.join(", ")} from ${(result.sources || []).join(" + ") || "lookup"}`);
      } else {
        toast((result.warnings && result.warnings[0]) || "No matching data found", "error");
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
  document.getElementById("contact-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.linkedin_url = normalizeUrlInput(body.linkedin_url);
    body.sales_navigator_url = normalizeUrlInput(body.sales_navigator_url);
    try {
      if (existing) {
        await api(`/api/contacts/${existing.id}`, { method: "PUT", body });
        toast("Contact updated");
      } else {
        await api("/api/contacts", { method: "POST", body });
        toast("Contact created");
      }
      closeModal();
      await loadAll();
      renderContacts();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------- Quick Add (AI paste capture) ----------
// Paste anything with contact info in it — a LinkedIn profile, an email
// signature, a company page — and the active AI provider (Settings >
// Integrations) extracts structured fields for review before saving.
// Saves through the same find-or-create-account endpoint Apollo imports
// use, so a pasted company name lands on the same Account record.

function openQuickAddModal() {
  openModal(`
    <h2>✨ Quick Add</h2>
    <div class="hint" style="margin-top:0">Paste a LinkedIn profile, an email signature, or anything else with contact info — AI will pull out the fields for you to confirm before saving.</div>
    <label>Paste text</label>
    <textarea id="quick-add-paste" rows="6" placeholder="Paste here…"></textarea>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="quick-add-parse-btn">Parse with AI</button>
    </div>
    <div id="quick-add-form-area"></div>
  `);

  document.getElementById("quick-add-parse-btn").addEventListener("click", async () => {
    const text = document.getElementById("quick-add-paste").value;
    const btn = document.getElementById("quick-add-parse-btn");
    btn.disabled = true;
    btn.textContent = "Parsing…";
    try {
      const parsed = await api("/api/quick-add/parse", { method: "POST", body: { text } });
      renderQuickAddReviewForm(parsed);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Parse with AI";
    }
  });
}

function renderQuickAddReviewForm(parsed) {
  const area = document.getElementById("quick-add-form-area");
  area.innerHTML = `
    <div class="panel" style="margin-top:16px;padding:14px">
      <h2 style="margin-bottom:8px">Review before saving</h2>
      <form id="quick-add-form">
        <label>First name</label><input name="first_name" value="${parsed.first_name || ""}" required />
        <label>Last name</label><input name="last_name" value="${parsed.last_name || ""}" required />
        <label>Title</label><input name="title" value="${parsed.title || ""}" />
        <label>Company</label><input name="organization_name" value="${parsed.company || ""}" placeholder="Creates or matches an Account" />
        <label>Email</label><input name="email" type="email" value="${parsed.email || ""}" />
        <label>Phone</label><input name="phone" value="${parsed.phone || ""}" />
        <label>LinkedIn URL</label><input name="linkedin_url" type="text" value="${parsed.linkedin_url || ""}" />
        <div class="modal-actions">
          <button type="button" class="btn" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save contact</button>
        </div>
      </form>
    </div>
  `;
  document.getElementById("quick-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    fd.linkedin_url = normalizeUrlInput(fd.linkedin_url);
    try {
      await api("/api/prospecting/import-contact", { method: "POST", body: fd });
      toast("Contact saved");
      closeModal();
      await loadAll();
      renderContacts();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------- Accounts ----------

let accountsScopeFilter = null; // array of owner_ids, or null for no filter — set when arriving from the Dashboard's "Total Companies" card

// Row-selection state for the Accounts table -- same module-level pattern as
// contactsSelected on Contacts, so it survives the full re-render every
// checkbox click triggers.
let accountsSelected = new Set();

// Accounts table filters -- same module-level pattern as contactsFilters:
// a flat bag keyed by column id (colId+"From"/"To" for a dateRange column),
// see accountFilterDefs() below for what each key means. "scoreBand" is the
// one exception -- there's no Score column in this table to hang a header
// filter off of, so it's handled by hand (falls back to the topbar, same
// idea as the Owner fallback on Contacts).
let accountsFilters = {};

// Which sub-tab of the Accounts page is showing -- "list" (the accounts
// table), "gem" (Accounts Gem), or "salesforce" (Salesforce pull/push), all
// merged in here rather than living as their own sidebar items. Module-level
// so it survives the re-renders every filter change and Gem/Salesforce
// interaction triggers.
let accountsTab = "list";

// Same accounts_gem feature_access key that used to gate the standalone
// sidebar nav item -- now gates the "Accounts Gem" sub-tab instead. Admins
// always see it; everyone else needs the flag on (default true, same as
// every other feature_access key elsewhere in the app).
function hasAccountsGemAccess() {
  if (state.user.role === "admin") return true;
  return (state.user.feature_access || {}).accounts_gem !== false;
}

// Same treatment for the salesforce feature_access key, which used to gate
// the standalone "Salesforce" sidebar item and now gates this sub-tab
// instead -- unchanged from an admin's point of view in Settings > Access
// Control, still one checkbox that hides/shows it per user.
function hasSalesforceAccess() {
  if (state.user.role === "admin") return true;
  return (state.user.feature_access || {}).salesforce !== false;
}

const INTENT_SCORE_BAND_OPTIONS = [
  ["90-99", "90–99 (Hot)"],
  ["80-89", "80–89"],
  ["70-79", "70–79"],
  ["60-69", "60–69"],
  ["below-60", "Below 60"],
  ["none", "Not scored"],
];

// Single source of truth for every Accounts column's header filter -- same
// contract as contactFilterDefs() above. Add a new column here (plus one
// thFilterHtml(ACCOUNT_FILTER_DEFS, ...) call in the header markup in
// renderAccountsListView()) and it gets a working inline filter with no
// other code to touch.
function accountFilterDefs() {
  return {
    name: { label: "Account", kind: "text", getValue: (a) => a.name || "" },
    industry: { label: "Industry", kind: "select", getValue: (a) => a.industry || "", getOptions: () => Array.from(new Set(state.accounts.map((a) => a.industry).filter(Boolean))).sort().map((i) => ({ value: i, label: i })) },
    website: { label: "Website", kind: "text", getValue: (a) => a.website || "" },
    phone: { label: "Phone", kind: "text", getValue: (a) => a.phone || "" },
    owner: { label: "Owner", kind: "select", getValue: (a) => String(a.owner_id || ""), getOptions: () => state.users.slice().sort((u1, u2) => u1.name.localeCompare(u2.name)).map((u) => ({ value: String(u.id), label: u.name })) },
    created: { label: "Created", kind: "dateRange", getValue: (a) => a.created_at },
  };
}

function accountMatchesFilters(a) {
  const f = accountsFilters;
  if (accountsScopeFilter && !accountsScopeFilter.includes(a.owner_id)) return false;
  // scoreBand has no header column to live in, so it's checked by hand here
  // rather than going through accountFilterDefs().
  if (f.scoreBand) {
    const band = intentScoreBand(a.intent_score);
    if (f.scoreBand === "none" ? band !== null : band !== f.scoreBand) return false;
  }
  const defs = accountFilterDefs();
  for (const colId in defs) {
    const def = defs[colId];
    if (def.kind === "select") {
      if (f[colId] && String(def.getValue(a)) !== f[colId]) return false;
    } else if (def.kind === "boolean") {
      if (f[colId] === "yes" && !def.getValue(a)) return false;
      if (f[colId] === "no" && def.getValue(a)) return false;
    } else if (def.kind === "text") {
      if (f[colId]) {
        const q = f[colId].toLowerCase();
        if (!String(def.getValue(a) || "").toLowerCase().includes(q)) return false;
      }
    } else if (def.kind === "dateRange") {
      const from = f[`${colId}From`];
      const to = f[`${colId}To`];
      if (from || to) {
        const val = def.getValue(a);
        if (from && (!val || val < from)) return false;
        if (to && (!val || val > to)) return false;
      }
    }
  }
  return true;
}

// ---------- Company profile ----------
// Small two-tone "Q" logo button that sits next to the Accounts page title.
// Opens a modal where the rep can maintain a short blurb about their own
// company; that blurb is folded into the AI draft-email / draft-sequence
// prompts on Contacts and Emailing so drafts can speak to what we actually
// do, without retyping it every time.
function companyProfileIconSvg() {
  return `<svg viewBox="0 0 100 100" width="18" height="18" xmlns="http://www.w3.org/2000/svg" fill="none">
    <path d="M18 38 A34 34 0 1 1 56 84" stroke="#2f5bff" stroke-width="15" stroke-linecap="round"/>
    <path d="M56 84 A34 34 0 0 1 18 38" stroke="#3ebd82" stroke-width="15" stroke-linecap="round"/>
    <line x1="66" y1="66" x2="86" y2="86" stroke="#3ebd82" stroke-width="15" stroke-linecap="round"/>
  </svg>`;
}

function renderCompanyProfileButton() {
  document.getElementById("view-title-extra").innerHTML = `
    <button type="button" class="icon-btn" id="company-profile-btn" title="Company profile (used in AI drafts)" aria-label="Edit company profile">
      ${companyProfileIconSvg()}
    </button>
  `;
  document.getElementById("company-profile-btn").addEventListener("click", () => openCompanyProfileModal());
}

async function openCompanyProfileModal() {
  let profile;
  try {
    profile = await api("/api/company-profile");
  } catch (err) {
    toast(err.message || "Couldn't load company profile", "error");
    return;
  }
  openModal(`
    <h2>Company profile</h2>
    <div class="hint" style="margin-bottom:10px">A short description of your own company — used as context whenever AI drafts an email on Contacts or Emailing.</div>
    <textarea id="company-profile-text" rows="10" style="width:100%;box-sizing:border-box" placeholder="e.g. AccelQ is a no-code, AI-powered test automation platform for web, mobile, API and enterprise apps…">${profile.content || ""}</textarea>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
      <button type="button" class="btn btn-primary" id="company-profile-save-btn">Save</button>
    </div>
  `);
  document.getElementById("company-profile-save-btn").addEventListener("click", async () => {
    const content = document.getElementById("company-profile-text").value;
    try {
      await api("/api/company-profile", { method: "PUT", body: { content } });
      toast("Company profile saved");
      closeModal();
    } catch (err) {
      toast(err.message || "Couldn't save company profile", "error");
    }
  });
}

// Dispatcher for the Accounts sidebar item -- shows the accounts table
// (accountsTab === "list"), Accounts Gem ("gem"), or Salesforce
// ("salesforce"), as sub-tabs of one page rather than three separate nav
// items. Accounts Gem and Salesforce each keep their own feature_access
// gate; if a user without that access somehow has the tab selected (e.g. an
// admin toggled it off for them mid-session), fall back to the list rather
// than rendering a tab they shouldn't see.
function renderAccounts() {
  if (accountsTab === "gem" && hasAccountsGemAccess()) {
    renderAccountsGem();
  } else if (accountsTab === "salesforce" && hasSalesforceAccess()) {
    renderSalesforce();
  } else {
    accountsTab = "list";
    renderAccountsListView();
  }
}

// data-accounts-tab sub-tab bar shown atop the Accounts page content --
// reuses the same .settings-tabs/.settings-tab pattern as Settings and
// Emailing so it looks consistent with the rest of the app's sub-tab UI.
// Accounts Gem and Salesforce each only appear once the signed-in user has
// that feature's access.
function accountsTabBarHtml() {
  return `
    <div class="settings-tabs" style="margin-bottom:16px">
      <div class="settings-tab ${accountsTab === "list" ? "active" : ""}" data-accounts-tab="list">All Accounts</div>
      ${hasAccountsGemAccess() ? `<div class="settings-tab ${accountsTab === "gem" ? "active" : ""}" data-accounts-tab="gem">Accounts Gem</div>` : ""}
      ${hasSalesforceAccess() ? `<div class="settings-tab ${accountsTab === "salesforce" ? "active" : ""}" data-accounts-tab="salesforce">Salesforce</div>` : ""}
    </div>
  `;
}

function wireAccountsTabBar(root) {
  root.querySelectorAll("[data-accounts-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      accountsTab = el.dataset.accountsTab;
      renderAccounts();
    });
  });
}

function renderAccountsListView() {
  const accountDefs = accountFilterDefs();
  const accountsFiltersOn = getHeaderFiltersOn("accountsFiltersEnabled");
  const rows = state.accounts.filter(accountMatchesFilters);
  const filtersActive = accountsFiltersOn && Boolean(anyHeaderFilterActive(accountDefs, accountsFilters) || accountsFilters.scoreBand);
  const canDelete = ["admin", "manager"].includes(state.user.role);
  // When filters are toggled off, every header shows its plain label instead
  // of thFilterHtml's ▾ trigger.
  const af = (colId, label) => accountsFiltersOn ? thFilterHtml(accountDefs, accountsFilters, colId, label) : label;

  // Drop selected ids that fell out of view (deleted elsewhere, or scoped
  // out by a filter) so "N selected" stays accurate.
  const validIds = new Set(rows.map((a) => a.id));
  Array.from(accountsSelected).forEach((id) => { if (!validIds.has(id)) accountsSelected.delete(id); });
  const allSelected = rows.length > 0 && rows.every((a) => accountsSelected.has(a.id));

  renderCompanyProfileButton();

  document.getElementById("topbar-actions").innerHTML = `
    <div class="topbar-filters">
      ${accountsFiltersOn ? `
        <select id="accounts-filter-score">
          <option value="">All scores</option>
          ${INTENT_SCORE_BAND_OPTIONS.map(([v, label]) => `<option value="${v}" ${accountsFilters.scoreBand === v ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      ` : ""}
      ${filtersActive ? `<button type="button" class="btn btn-small" id="accounts-filter-clear-btn">Clear filters</button>` : ""}
      <span class="topbar-filter-count">${rows.length} of ${state.accounts.length}</span>
    </div>
    <span class="topbar-divider"></span>
    <button class="btn btn-compact" id="apollo-search-accounts-btn">🔍 Search Apollo</button>
    <button class="btn btn-compact" id="export-accounts-btn">Export CSV${accountsSelected.size ? ` (${accountsSelected.size} selected)` : ""}</button>
    <button class="btn btn-compact" id="export-accounts-xlsx-btn">Export XLSX</button>
    <button class="btn btn-compact" id="import-accounts-btn">Import</button>
    <button class="btn btn-primary btn-compact" id="new-account-btn">+ New Account</button>
  `;
  document.getElementById("new-account-btn").addEventListener("click", () => openAccountFormModal());
  document.getElementById("apollo-search-accounts-btn").addEventListener("click", () => openApolloSearchModal("companies"));
  document.getElementById("import-accounts-btn").addEventListener("click", () => openImportSourceModal("accounts"));
  document.getElementById("export-accounts-btn").addEventListener("click", () => exportAccountsCsv());
  document.getElementById("export-accounts-xlsx-btn").addEventListener("click", () => exportAccountsXlsx());

  const root = document.getElementById("view-root");
  root.innerHTML = `
    ${(hasAccountsGemAccess() || hasSalesforceAccess()) ? accountsTabBarHtml() : ""}
    ${accountsScopeFilter ? `
      <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
        <span class="pill pill-active">Showing companies for this scope</span>
        <button class="btn btn-small" id="accounts-clear-filter-btn">Show all companies</button>
      </div>
    ` : ""}
    ${accountsSelected.size ? `
      <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px">
        <span style="font-size:13px;font-weight:600">${accountsSelected.size} selected</span>
        <button type="button" class="btn btn-small" id="accounts-bulk-clear-btn">Clear selection</button>
        ${canDelete ? `<button type="button" class="btn btn-small btn-danger" id="accounts-bulk-delete-btn" title="Delete selected" aria-label="Delete selected" style="margin-left:auto">🗑</button>` : ""}
      </div>
    ` : ""}
    <div class="panel">
      <table>
        <thead><tr>
          <th style="width:34px"><input type="checkbox" id="accounts-select-all" ${allSelected ? "checked" : ""} /></th>
          <th>${af("name", "Account")}</th>
          <th>${af("industry", "Industry")}</th>
          <th>${af("website", "Website")}</th>
          <th>${af("phone", "Phone")}</th>
          <th>${af("owner", "Owner")}</th>
          <th>${af("created", "Created")}</th>
          <th style="width:34px">${filtersToggleButtonHtml("accounts", accountsFiltersOn)}</th>
        </tr></thead>
        <tbody>
          ${rows.map((a) => `
            <tr class="row-click" data-account="${a.id}">
              <td onclick="event.stopPropagation()"><input type="checkbox" data-account-select="${a.id}" ${accountsSelected.has(a.id) ? "checked" : ""} /></td>
              <td>${a.name}<span onclick="event.stopPropagation()">${priorityPillHtml(a)}${intentScoreBadgeHtml(a)}<span data-research-trigger="${a.id}" title="Auto Gen — research this company and generate a score" style="cursor:pointer;margin-left:4px;font-size:13px;vertical-align:middle">🔎</span></span></td>
              <td>${a.industry || "—"}</td>
              <td>${a.website || "—"}</td>
              <td>${a.phone || "—"}</td>
              <td>${userName(a.owner_id)}</td>
              <td>${a.created_at}</td>
              <td></td>
            </tr>
          `).join("") || `<tr><td colspan="8" class="empty-state">${filtersActive || accountsScopeFilter ? "No accounts match these filters." : "No accounts yet."}</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  wireAccountsTabBar(root);

  const clearBtn = document.getElementById("accounts-clear-filter-btn");
  if (clearBtn) clearBtn.addEventListener("click", () => { accountsScopeFilter = null; renderAccounts(); });

  root.querySelectorAll("[data-account]").forEach((tr) => {
    tr.addEventListener("click", () => openAccountDetailModal(byId(state.accounts, tr.dataset.account)));
  });

  const scoreFilterEl = document.getElementById("accounts-filter-score");
  if (scoreFilterEl) {
    scoreFilterEl.addEventListener("change", (e) => {
      accountsFilters.scoreBand = e.target.value;
      renderAccounts();
    });
  }
  const filterClearBtn = document.getElementById("accounts-filter-clear-btn");
  if (filterClearBtn) {
    filterClearBtn.addEventListener("click", () => {
      accountsFilters = {};
      closeHeaderFilterPopover();
      renderAccounts();
    });
  }
  root.querySelectorAll("[data-th-filter-btn]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openHeaderFilterPopover(accountDefs, accountsFilters, btn.dataset.thFilterBtn, btn, renderAccounts);
    });
  });
  const accountsFiltersToggleBtn = root.querySelector('[data-filters-toggle-btn="accounts"]');
  if (accountsFiltersToggleBtn) {
    accountsFiltersToggleBtn.addEventListener("click", () => {
      const turningOn = !accountsFiltersOn;
      setHeaderFiltersOn("accountsFiltersEnabled", turningOn);
      if (!turningOn) {
        accountsFilters = {};
        closeHeaderFilterPopover();
      }
      renderAccounts();
    });
  }
  root.querySelectorAll("[data-intent-score-icon]").forEach((el) => {
    el.addEventListener("click", () => openIntentScoreModal(byId(state.accounts, el.dataset.intentScoreIcon)));
  });
  root.querySelectorAll("[data-research-trigger]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.researchTrigger);
      const originalText = el.textContent;
      const originalTitle = el.title;
      el.textContent = "⏳";
      el.style.pointerEvents = "none";
      runAccountResearch(id, {
        onProgress: (step, total, title) => { el.title = `Researching ${step}/${total}: ${title}`; },
        onDone: (updated) => openAccountDetailModal(updated),
        onSettled: () => { el.textContent = originalText; el.title = originalTitle; el.style.pointerEvents = ""; },
      });
    });
  });

  const selectAllEl = document.getElementById("accounts-select-all");
  if (selectAllEl) {
    selectAllEl.addEventListener("change", (e) => {
      if (e.target.checked) rows.forEach((a) => accountsSelected.add(a.id));
      else rows.forEach((a) => accountsSelected.delete(a.id));
      renderAccounts();
    });
  }

  root.querySelectorAll("[data-account-select]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(cb.dataset.accountSelect);
      if (e.target.checked) accountsSelected.add(id);
      else accountsSelected.delete(id);
      renderAccounts();
    });
  });

  const bulkClearBtn = document.getElementById("accounts-bulk-clear-btn");
  if (bulkClearBtn) bulkClearBtn.addEventListener("click", () => { accountsSelected.clear(); renderAccounts(); });

  const bulkDeleteBtn = document.getElementById("accounts-bulk-delete-btn");
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener("click", async () => {
      const ids = Array.from(accountsSelected);
      if (!confirm(`Delete ${ids.length} compan${ids.length === 1 ? "y" : "ies"}? This can't be undone. Contacts linked to ${ids.length === 1 ? "it" : "them"} won't be deleted, just unlinked.`)) return;
      bulkDeleteBtn.disabled = true;
      bulkDeleteBtn.textContent = "⏳";
      // Promise.allSettled, not Promise.all -- with the old all-or-nothing
      // version, one failed delete in a batch of dozens (a timeout, a
      // permission edge case) rejected the whole batch, so NONE of the rows
      // were removed from state.accounts even though most of them really
      // had been deleted server-side. That's exactly what "I deleted them
      // but they're still showing" looks like: the delete worked, the UI
      // just never found out. Now every row's own outcome is tracked, only
      // the ones that actually succeeded disappear from the list, and any
      // failures are called out by name instead of silently freezing the
      // whole selection.
      const results = await runWithConcurrency(ids, 5, (id) => api(`/api/accounts/${id}`, { method: "DELETE" }));
      const succeededIds = ids.filter((_, i) => results[i].status === "fulfilled");
      const failed = ids
        .map((id, i) => ({ id, result: results[i] }))
        .filter((r) => r.result.status === "rejected");
      if (succeededIds.length) {
        state.accounts = state.accounts.filter((a) => !succeededIds.includes(a.id));
        succeededIds.forEach((id) => accountsSelected.delete(id));
      }
      if (failed.length) {
        const names = failed
          .map((f) => state.accounts.find((a) => a.id === f.id)?.name || `#${f.id}`)
          .slice(0, 3)
          .join(", ");
        toast(
          `Deleted ${succeededIds.length} of ${ids.length} — ${failed.length} failed (${names}${failed.length > 3 ? ", …" : ""}): ${failed[0].result.reason?.message || "unknown error"}`,
          "error"
        );
      } else {
        toast(`Deleted ${succeededIds.length} compan${succeededIds.length === 1 ? "y" : "ies"}`);
      }
      bulkDeleteBtn.disabled = false;
      bulkDeleteBtn.textContent = "🗑";
      renderAccounts();
    });
  }
}

// -- Export accounts to CSV --
// Pure client-side: state.accounts is already fully loaded, so this needs
// no round trip to the server. Respects the current "Showing companies for
// this scope" filter (e.g. after clicking the Total Companies dashboard
// card) so an export taken while filtered doesn't silently include rows the
// screen isn't showing.

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportAccountsCsv() {
  // Same selection-first, filter-second precedence as Export CSV on
  // Contacts: checked rows win if any are checked, otherwise it falls back
  // to whatever the filter bar currently shows.
  const filtersActive = Boolean(anyHeaderFilterActive(accountFilterDefs(), accountsFilters) || accountsFilters.scoreBand || accountsScopeFilter);
  const rows = accountsSelected.size
    ? state.accounts.filter((a) => accountsSelected.has(a.id))
    : state.accounts.filter(accountMatchesFilters);
  if (!rows.length) { toast("No accounts to export", "error"); return; }
  const headers = ["Name", "Industry", "Website", "Phone", "Revenue", "Address", "Sales Navigator URL", "Owner", "Intent Score", "Intent Score Label", "Created"];
  const lines = [headers.join(",")];
  rows.forEach((a) => {
    lines.push([
      a.name, a.industry, a.website, a.phone, a.revenue, a.address, a.sales_navigator_url,
      userName(a.owner_id), a.intent_score ?? "", a.intent_score_label || "", a.created_at,
    ].map(csvEscape).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `accounts-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  const qualifier = accountsSelected.size ? "selected " : (filtersActive ? "filtered " : "");
  toast(`Exported ${rows.length} ${qualifier}account(s)`);
}

// Same rows/columns as exportAccountsCsv above, but a real .xlsx with
// Calibri 11 on every cell.
async function exportAccountsXlsx() {
  const filtersActive = Boolean(anyHeaderFilterActive(accountFilterDefs(), accountsFilters) || accountsFilters.scoreBand || accountsScopeFilter);
  const rows = accountsSelected.size
    ? state.accounts.filter((a) => accountsSelected.has(a.id))
    : state.accounts.filter(accountMatchesFilters);
  if (!rows.length) { toast("No accounts to export", "error"); return; }
  const headers = ["Name", "Industry", "Website", "Phone", "Revenue", "Address", "Sales Navigator URL", "Owner", "Intent Score", "Intent Score Label", "Created"];
  const dataRows = rows.map((a) => [
    a.name, a.industry, a.website, a.phone, a.revenue, a.address, a.sales_navigator_url,
    userName(a.owner_id), a.intent_score ?? "", a.intent_score_label || "", a.created_at,
  ]);
  try {
    await exportXlsx(`accounts-export-${new Date().toISOString().slice(0, 10)}.xlsx`, "Accounts", headers, dataRows);
    const qualifier = accountsSelected.size ? "selected " : (filtersActive ? "filtered " : "");
    toast(`Exported ${rows.length} ${qualifier}account(s) (Excel)`);
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------- Accounts Gem ----------
// An SDR-agent workspace backed by Gemini (see lib/accountsGemPrompt.js for
// the system prompt and POST /api/accounts-gem/run for the route). Deliber-
// ately stateless server-side beyond the API key -- each request is one
// self-contained turn, so the "history" below is a session-only scratchpad
// (module-level, not persisted) letting a rep glance back at earlier
// results without re-generating them, not a synced conversation log.

const GEM_COMMANDS = [
  { value: "/RESEARCH", label: "Research", desc: "Full account intelligence workup" },
  { value: "/FIRST_TOUCH", label: "First touch", desc: "Cold outbound email" },
  { value: "/FOLLOW_UP", label: "Follow up", desc: "Follow-up email on an existing thread" },
  { value: "/OBJECTION", label: "Objection", desc: "Objection-handling response" },
  { value: "/CALL_PREP", label: "Call prep", desc: "Prep notes ahead of a call" },
  { value: "/POST_CALL", label: "Post call", desc: "Post-call summary + follow-up draft" },
  { value: "/PIPELINE", label: "Pipeline", desc: "Prioritise accounts/opportunities" },
  { value: "/PERSONA_SHIFT", label: "Persona shift", desc: "Re-angle messaging for a different buyer" },
  { value: "/OPTIMISE", label: "Optimise", desc: "Critique + improve a draft" },
];

let gemForm = { command: "", account: "", persona: "", knownSignals: "", context: "", constraints: "", message: "" };
let gemHistory = []; // session-only, newest first: {id, command, account, persona, text, createdAt}
let gemActiveResultId = null;
let gemLoading = false;
let gemError = "";

function renderGemOutputPanel() {
  if (gemLoading) {
    return `<div class="panel"><div class="empty-state">Thinking…</div></div>`;
  }
  if (gemError) {
    return `<div class="panel"><div class="error-text" style="margin:0">${escapeAttr(gemError)}</div></div>`;
  }
  const active = gemHistory.find((h) => h.id === gemActiveResultId) || gemHistory[0];
  if (!active) {
    return `<div class="panel"><div class="empty-state">Pick a command below or just describe what you need — research an account, draft a first-touch email, prep for a call, handle an objection. The agent figures out the rest, and asks if it needs more to go on.</div></div>`;
  }
  const metaBits = [
    active.command ? `<span class="pill pill-active">${escapeAttr(active.command)}</span>` : `<span class="pill pill-inactive">Auto-detected</span>`,
    active.account ? escapeAttr(active.account) : "",
    active.persona ? escapeAttr(active.persona) : "",
  ].filter(Boolean);
  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-dim);display:flex;gap:8px;align-items:center;flex-wrap:wrap">${metaBits.join(" · ")}</div>
        <button type="button" class="btn btn-small" id="gem-copy-btn">Copy</button>
      </div>
      <div id="gem-output-text" class="draft-font" style="white-space:pre-wrap;line-height:1.6">${escapeAttr(active.text)}</div>
    </div>
  `;
}

function renderGemHistoryPanel() {
  if (!gemHistory.length) return "";
  return `
    <div class="panel">
      <h2 style="margin-bottom:10px">Earlier this session</h2>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${gemHistory.map((h) => `
          <div class="row-click" data-gem-history="${h.id}" style="display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);${h.id === gemActiveResultId ? "background:var(--panel-2)" : ""}">
            <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${h.command ? `<span class="pill pill-active" style="margin-right:6px">${escapeAttr(h.command)}</span>` : ""}${escapeAttr(h.account || h.persona || "Untitled request")}
            </div>
            <div style="font-size:11px;color:var(--text-dim);white-space:nowrap">${new Date(h.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderAccountsGem() {
  document.getElementById("topbar-actions").innerHTML = gemHistory.length
    ? `<button class="btn" id="gem-clear-history-btn">Clear session history</button>`
    : "";
  const clearBtn = document.getElementById("gem-clear-history-btn");
  if (clearBtn) clearBtn.addEventListener("click", () => { gemHistory = []; gemActiveResultId = null; renderAccountsGem(); });

  const root = document.getElementById("view-root");
  root.innerHTML = `
    ${accountsTabBarHtml()}
    <div class="panel">
      <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">
        Your enterprise-SDR agent for ACCELQ — turns account signals into business-impact reasoning, then writes copy-ready outreach, call prep, objection handling, and more. Pick a command or just describe what you need.
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${GEM_COMMANDS.map((c) => `<button type="button" class="btn btn-small" data-gem-chip="${c.value}" title="${escapeAttr(c.desc)}">${c.label}</button>`).join("")}
      </div>
      <form id="gem-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label>Command (optional — leave on Auto-detect and just describe the ask)</label>
            <select id="gem-command">
              <option value="">Auto-detect</option>
              ${GEM_COMMANDS.map((c) => `<option value="${c.value}" ${gemForm.command === c.value ? "selected" : ""}>${c.value} — ${c.label}</option>`).join("")}
            </select>
          </div>
          <div>
            <label>Account</label>
            <input id="gem-account" list="gem-account-list" placeholder="e.g. Acme Corp" value="${escapeAttr(gemForm.account)}" />
            <datalist id="gem-account-list">
              ${state.accounts.map((a) => `<option value="${escapeAttr(a.name)}"></option>`).join("")}
            </datalist>
          </div>
        </div>
        <label style="margin-top:10px">Persona</label>
        <input id="gem-persona" placeholder="e.g. VP of Quality Engineering" value="${escapeAttr(gemForm.persona)}" />
        <label style="margin-top:10px">What do you need?</label>
        <textarea id="gem-message" rows="3" placeholder="e.g. Research this account, or: write a cold email opening on their Salesforce migration">${gemForm.message}</textarea>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px">
          <div>
            <label>Known signals <span style="color:var(--text-dim);font-weight:400">(optional)</span></label>
            <textarea id="gem-signals" rows="2" placeholder="Job postings, tech stack, recent initiatives…">${gemForm.knownSignals}</textarea>
          </div>
          <div>
            <label>Context <span style="color:var(--text-dim);font-weight:400">(optional)</span></label>
            <textarea id="gem-context" rows="2" placeholder="Prior conversation, trigger event, account background…">${gemForm.context}</textarea>
          </div>
        </div>
        <label style="margin-top:10px">Constraints <span style="color:var(--text-dim);font-weight:400">(optional)</span></label>
        <input id="gem-constraints" placeholder="e.g. under 100 words, formal tone" value="${escapeAttr(gemForm.constraints)}" />
        <div class="modal-actions" style="justify-content:flex-start;margin-top:14px">
          <button type="submit" class="btn btn-primary" id="gem-generate-btn" ${gemLoading ? "disabled" : ""}>${gemLoading ? "Thinking…" : "Generate"}</button>
        </div>
      </form>
    </div>

    ${renderGemOutputPanel()}
    ${renderGemHistoryPanel()}
  `;

  wireAccountsTabBar(root);

  root.querySelectorAll("[data-gem-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("gem-command").value = btn.dataset.gemChip;
      document.getElementById("gem-message").focus();
    });
  });

  root.querySelectorAll("[data-gem-history]").forEach((el) => {
    el.addEventListener("click", () => {
      gemActiveResultId = Number(el.dataset.gemHistory);
      gemError = "";
      renderAccountsGem();
    });
  });

  const copyBtn = document.getElementById("gem-copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const text = document.getElementById("gem-output-text")?.textContent || "";
      navigator.clipboard?.writeText(text).then(
        () => toast("Copied"),
        () => toast("Couldn't copy — select and copy manually", "error")
      );
    });
  }

  document.getElementById("gem-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runAccountsGem();
  });
}

async function runAccountsGem() {
  gemForm = {
    command: document.getElementById("gem-command").value,
    account: document.getElementById("gem-account").value.trim(),
    persona: document.getElementById("gem-persona").value.trim(),
    knownSignals: document.getElementById("gem-signals").value.trim(),
    context: document.getElementById("gem-context").value.trim(),
    constraints: document.getElementById("gem-constraints").value.trim(),
    message: document.getElementById("gem-message").value.trim(),
  };

  if (!gemForm.account && !gemForm.message) {
    toast("Enter an account or describe what you need first", "error");
    return;
  }

  gemLoading = true;
  gemError = "";
  renderAccountsGem();

  try {
    const res = await api("/api/accounts-gem/run", {
      method: "POST",
      body: {
        command: gemForm.command || undefined,
        account: gemForm.account,
        persona: gemForm.persona,
        known_signals: gemForm.knownSignals,
        context: gemForm.context,
        constraints: gemForm.constraints,
        message: gemForm.message,
      },
    });
    const entry = {
      id: Date.now(),
      command: gemForm.command,
      account: gemForm.account,
      persona: gemForm.persona,
      text: res.text,
      createdAt: new Date().toISOString(),
    };
    gemHistory.unshift(entry);
    gemActiveResultId = entry.id;
  } catch (err) {
    gemError = err.message;
  } finally {
    gemLoading = false;
    renderAccountsGem();
  }
}

// -- Shared CSV import machinery (Accounts + Contacts) --
// Dependency-free CSV parser (no CDN library loaded in this app) — handles
// quoted fields, embedded commas, and escaped quotes per RFC 4180. Header
// names are matched loosely (case-insensitive, a few common synonyms) so a
// CSV exported from Salesforce, a spreadsheet, or written by hand all work
// without the user needing to match our exact column names.

// Detects the field delimiter from the header line rather than assuming
// comma — Excel saves CSV with a semicolon delimiter under many regional
// locale settings (common cause of "every field lands in one column" when a
// file that looks fine in Excel fails to import anywhere else). Comma wins
// ties/defaults since it's still the most common case.
function detectCsvDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || "";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const c of firstLine) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts[c] !== undefined) counts[c]++;
  }
  let best = ",", bestCount = counts[","];
  for (const d of [";", "\t"]) {
    if (counts[d] > bestCount) { best = d; bestCount = counts[d]; }
  }
  return best;
}

function tokenizeCsvRows(text) {
  // Strip a UTF-8 BOM — Excel adds one when saving CSV on Windows, and left
  // in place it silently glues itself to the first header cell, making that
  // one column fail to match anything in the header map.
  text = String(text || "").replace(/^﻿/, "");
  const delimiter = detectCsvDelimiter(text);
  const rawRows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rawRows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((cell) => cell !== "")) rawRows.push(row); }
  return rawRows;
}

function parseCsvWithHeaderMap(text, headerMap) {
  const rawRows = tokenizeCsvRows(text);
  if (!rawRows.length) return [];
  const headers = rawRows[0].map((h) => headerMap[h.trim().toLowerCase()] || null);
  return rawRows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((key, idx) => { if (key && r[idx] !== undefined) obj[key] = r[idx].trim(); });
    return obj;
  });
}

const ACCOUNT_IMPORT_HEADER_MAP = {
  "name": "name", "account name": "name", "account": "name", "company": "name", "company name": "name",
  "industry": "industry",
  "website": "website", "url": "website", "domain": "website", "web site": "website",
  "phone": "phone", "phone number": "phone",
  "revenue": "revenue", "annual revenue": "revenue",
  "address": "address", "hq address": "address", "headquarters": "address",
  "sales navigator url": "sales_navigator_url", "sales navigator": "sales_navigator_url",
  "linkedin": "sales_navigator_url", "linkedin url": "sales_navigator_url",
};

function parseAccountsCsv(text) {
  return parseCsvWithHeaderMap(text, ACCOUNT_IMPORT_HEADER_MAP);
}

const CONTACT_IMPORT_HEADER_MAP = {
  "first name": "first_name", "firstname": "first_name", "first": "first_name",
  "last name": "last_name", "lastname": "last_name", "last": "last_name",
  "email": "email", "email address": "email",
  "phone": "phone", "phone number": "phone",
  "title": "title", "job title": "title",
  "account": "account", "company": "account", "account name": "account", "company name": "account",
  "linkedin url": "linkedin_url", "linkedin": "linkedin_url",
  "sales navigator url": "sales_navigator_url", "sales navigator": "sales_navigator_url",
};

function parseContactsCsv(text) {
  return parseCsvWithHeaderMap(text, CONTACT_IMPORT_HEADER_MAP);
}

// -- Import: source chooser --
// The Import button (Contacts and Accounts) opens this first: pick a source,
// then that source's own modal opens. CSV, Apollo List, and LinkedIn are
// real today; Other is a placeholder for a source we don't have yet (a
// purchased third-party data provider), shown disabled so the roadmap is
// visible without pretending it works.
function openImportSourceModal(kind) {
  const nounSingular = kind === "accounts" ? "account" : "contact";
  const nounPlural = kind === "accounts" ? "accounts" : "contacts";
  openModal(`
    <h2>Import ${nounPlural}</h2>
    <div class="hint" style="margin-top:0">Choose where to import ${nounPlural} from.</div>
    <div class="import-source-grid" style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
      <button type="button" class="btn import-source-btn" id="import-src-apollo" style="text-align:left;justify-content:flex-start;padding:12px 14px">
        <div style="font-weight:600">Apollo List</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Import ${nounPlural} from a list already saved in your Apollo.io account</div>
      </button>
      <button type="button" class="btn import-source-btn" id="import-src-csv" style="text-align:left;justify-content:flex-start;padding:12px 14px">
        <div style="font-weight:600">CSV</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Upload a file or paste rows</div>
      </button>
      <button type="button" class="btn import-source-btn" id="import-src-other" disabled style="text-align:left;justify-content:flex-start;padding:12px 14px;opacity:.55;cursor:not-allowed">
        <div style="font-weight:600">Other data provider</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Coming soon — once we buy access to a third-party data source</div>
      </button>
      <button type="button" class="btn import-source-btn" id="import-src-linkedin" style="text-align:left;justify-content:flex-start;padding:12px 14px">
        <div style="font-weight:600">LinkedIn</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Search LinkedIn ${nounPlural === "accounts" ? "companies" : "people"} live via your connected LinkedIn account and import selected results</div>
      </button>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
    </div>
  `);
  document.getElementById("import-src-apollo").addEventListener("click", () => openApolloListImportModal(kind));
  document.getElementById("import-src-csv").addEventListener("click", () => {
    if (kind === "accounts") openAccountImportModal(); else openContactImportModal();
  });
  document.getElementById("import-src-linkedin").addEventListener("click", () => openLinkedInImportModal(kind));
}

// -- Import: LinkedIn (live search via Unipile) --
// Same shape as Apollo List import above (search/browse, checkbox-select,
// import selected into the existing bulk /import routes) except the source
// is a live LinkedIn search instead of a pre-built list. Deliberately maps
// straight from search-result fields into the import row shape rather than
// fetching each selected result's full profile first -- an extra Unipile
// call per row would multiply fast on a multi-select import and eat into
// the connected account's daily search/read budget (see the rate-limit note
// above unipile.getCompanyProfile). That means some fields CSV/Apollo import
// can fill (e.g. website, email) are usually blank here -- LinkedIn search
// results don't carry them; edit the row afterward if you need those.
let linkedInImportRows = [];
let linkedInImportSelected = new Set();

function openLinkedInImportModal(kind) {
  const isAccounts = kind === "accounts";
  openModal(`
    <h2>Import from LinkedIn</h2>
    <div class="hint" style="margin-top:0">Search LinkedIn ${isAccounts ? "companies" : "people"} live through your connected LinkedIn account (Settings > Integrations > Unipile).</div>
    <form id="li-import-search-form" style="display:flex;gap:8px;margin:10px 0">
      <input name="keywords" placeholder="${isAccounts ? "Company name or keyword…" : "Name or keyword…"}" style="flex:1" />
      <button type="submit" class="btn btn-primary btn-small" id="li-import-search-btn">Search</button>
    </form>
    <div class="error-text" id="li-import-error"></div>
    <div id="li-import-results"></div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
    </div>
  `);
  linkedInImportRows = [];
  linkedInImportSelected = new Set();

  document.getElementById("li-import-search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const keywords = (new FormData(e.target).get("keywords") || "").trim();
    const errorEl = document.getElementById("li-import-error");
    const resultsEl = document.getElementById("li-import-results");
    errorEl.textContent = "";
    if (!keywords) { errorEl.textContent = "Type something to search for first."; return; }
    const btn = document.getElementById("li-import-search-btn");
    btn.disabled = true;
    btn.textContent = "Searching…";
    resultsEl.innerHTML = `<div class="empty-state">Searching LinkedIn…</div>`;
    try {
      const data = isAccounts
        ? await api("/api/linkedin-search/companies", { method: "POST", body: { keywords } })
        : await api("/api/linkedin-search/people", { method: "POST", body: { keywords } });
      linkedInImportRows = isAccounts ? data.companies : data.people;
      linkedInImportSelected = new Set();
      renderLinkedInImportResults(kind);
    } catch (err) {
      errorEl.textContent = err.message;
      resultsEl.innerHTML = "";
    } finally {
      btn.disabled = false;
      btn.textContent = "Search";
    }
  });
}

function renderLinkedInImportResults(kind) {
  const isAccounts = kind === "accounts";
  const resultsEl = document.getElementById("li-import-results");
  if (!resultsEl) return;
  if (!linkedInImportRows.length) {
    resultsEl.innerHTML = `<div class="empty-state">No ${isAccounts ? "companies" : "people"} found for that search.</div>`;
    return;
  }
  resultsEl.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin:10px 0">
      <button type="button" class="btn btn-primary btn-small" id="li-import-btn">Import selected as ${isAccounts ? "Accounts" : "Contacts"}</button>
      <span id="li-import-selected-count" style="font-size:12px;color:var(--text-dim);align-self:center">${linkedInImportSelected.size} selected</span>
    </div>
    <table>
      ${isAccounts ? `
        <thead><tr><th></th><th>Company</th><th>Industry</th><th>Location</th><th>Followers</th></tr></thead>
        <tbody>
          ${linkedInImportRows.map((c, i) => `
            <tr>
              <td><input type="checkbox" data-select="${i}" ${linkedInImportSelected.has(i) ? "checked" : ""} /></td>
              <td>${escapeAttr(c.name || "—")}</td>
              <td>${escapeAttr(c.industry || "—")}</td>
              <td>${escapeAttr(c.location || "—")}</td>
              <td>${c.followers_count != null ? c.followers_count.toLocaleString() : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      ` : `
        <thead><tr><th></th><th>Name</th><th>Headline</th><th>Location</th><th>Connection</th></tr></thead>
        <tbody>
          ${linkedInImportRows.map((p, i) => `
            <tr>
              <td><input type="checkbox" data-select="${i}" ${linkedInImportSelected.has(i) ? "checked" : ""} /></td>
              <td>${escapeAttr(p.name || "—")}</td>
              <td>${escapeAttr(p.headline || "—")}</td>
              <td>${escapeAttr(p.location || "—")}</td>
              <td>${escapeAttr(p.connection_degree || "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      `}
    </table>
  `;
  resultsEl.querySelectorAll("[data-select]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.select);
      if (cb.checked) linkedInImportSelected.add(i); else linkedInImportSelected.delete(i);
      const countEl = document.getElementById("li-import-selected-count");
      if (countEl) countEl.textContent = `${linkedInImportSelected.size} selected`;
    });
  });
  document.getElementById("li-import-btn").addEventListener("click", () => importSelectedLinkedInRows(kind));
}

async function importSelectedLinkedInRows(kind) {
  const isAccounts = kind === "accounts";
  if (!linkedInImportSelected.size) { toast(`Select at least one ${isAccounts ? "company" : "person"}`, "error"); return; }
  const btn = document.getElementById("li-import-btn");
  btn.disabled = true;
  btn.textContent = "Importing…";
  const rows = [...linkedInImportSelected].map((i) => linkedInImportRows[i]).map((r) => {
    if (isAccounts) {
      return { name: r.name, industry: r.industry || "", sales_navigator_url: r.profile_url || "" };
    }
    const parts = String(r.name || "").trim().split(/\s+/);
    return {
      first_name: parts[0] || r.name || "",
      last_name: parts.slice(1).join(" ") || "",
      title: r.headline || "",
      linkedin_url: r.profile_url || "",
    };
  });
  try {
    const result = isAccounts
      ? await api("/api/accounts/import", { method: "POST", body: { rows } })
      : await api("/api/contacts/import", { method: "POST", body: { rows } });
    const parts = [];
    if (result.created) parts.push(`${result.created} created`);
    if (result.updated) parts.push(`${result.updated} updated`);
    if (result.skipped) parts.push(`${result.skipped} skipped`);
    toast(parts.length ? parts.join(", ") : "Nothing imported");
    linkedInImportSelected = new Set();
    await loadAll();
    closeModal();
    if (isAccounts) renderAccounts(); else renderContacts();
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
    btn.textContent = `Import selected as ${isAccounts ? "Accounts" : "Contacts"}`;
  }
}

// -- Import: Apollo List --
// Lets a rep pick one of their own saved Apollo Lists (a static grouping
// they built inside Apollo.io itself) and import some or all of it, instead
// of running a live keyword search like the Prospecting tab does. Reuses the
// same import-contact/import-company endpoints Prospecting and CSV import
// use, so a row lands the same way (account matched/created by name) no
// matter which of the three paths it came in through.
let apolloListRows = [];
let apolloListSelected = new Set();
// Apollo returns list contents a page at a time (see the per_page comment in
// lib/apollo.js's getListContacts/getListCompanies) -- these track where
// we are so "Load more" can fetch the next page and append to what's
// already loaded, and so the header can show "X of TOTAL" instead of
// silently capping out at one page with no indication more rows exist.
let apolloListPage = 1;
let apolloListTotal = 0;

function openApolloListImportModal(kind) {
  const isAccounts = kind === "accounts";
  openModal(`
    <h2>Import from Apollo List</h2>
    <div id="apollo-list-picker">
      <div class="hint" style="margin-top:0">Loading your Apollo lists…</div>
    </div>
    <div id="apollo-list-results" style="margin-top:12px"></div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
    </div>
  `, { wide: true });
  apolloListRows = [];
  apolloListSelected = new Set();
  apolloListPage = 1;
  apolloListTotal = 0;

  api(`/api/prospecting/apollo-lists?modality=${isAccounts ? "accounts" : "contacts"}`)
    .then((data) => {
      const picker = document.getElementById("apollo-list-picker");
      if (!picker) return; // modal closed before this resolved
      if (!data.lists || !data.lists.length) {
        picker.innerHTML = `<div class="hint" style="margin-top:0">No Apollo lists found for ${isAccounts ? "companies" : "contacts"}. Build one in Apollo.io first, or use CSV import instead.</div>`;
        return;
      }
      picker.innerHTML = `
        <label>Choose a list</label>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="apollo-list-select" style="flex:1">
            ${data.lists.map((l) => `<option value="${l.id}">${escapeAttr(l.name)} (${l.count})</option>`).join("")}
          </select>
          <button type="button" class="btn btn-primary" id="apollo-list-load-btn">Load</button>
        </div>
      `;
      document.getElementById("apollo-list-load-btn").addEventListener("click", () => loadApolloListContents(kind));
    })
    .catch((err) => {
      const picker = document.getElementById("apollo-list-picker");
      if (picker) picker.innerHTML = `<div class="hint" style="margin-top:0;color:var(--danger,#e5484d)">${err.message}</div>`;
    });
}

// `append`: false for the initial Load click (resets to page 1, replaces
// apolloListRows) or true for "Load more" (fetches the next page and
// concats onto what's already showing). Existing selections and their
// indices survive an append since concat only ever adds rows to the end.
async function loadApolloListContents(kind, append = false) {
  const isAccounts = kind === "accounts";
  const listId = document.getElementById("apollo-list-select").value;
  const resultsEl = document.getElementById("apollo-list-results");
  if (append) {
    apolloListPage += 1;
    const loadMoreBtn = document.getElementById("apollo-list-load-more-btn");
    if (loadMoreBtn) { loadMoreBtn.disabled = true; loadMoreBtn.textContent = "Loading…"; }
  } else {
    resultsEl.innerHTML = `<div class="empty-state">Loading…</div>`;
    apolloListSelected = new Set();
    apolloListPage = 1;
  }
  try {
    const data = isAccounts
      ? await api("/api/prospecting/list-companies", { method: "POST", body: { list_id: listId, page: apolloListPage } })
      : await api("/api/prospecting/list-people", { method: "POST", body: { list_id: listId, page: apolloListPage } });
    const page = isAccounts ? data.companies : data.people;
    apolloListRows = append ? apolloListRows.concat(page) : page;
    apolloListTotal = data.total ?? apolloListRows.length;
    renderApolloListResults(kind);
  } catch (err) {
    if (append) {
      apolloListPage -= 1;
      toast(err.message, "error");
      renderApolloListResults(kind);
    } else {
      resultsEl.innerHTML = `<div class="empty-state">${err.message}</div>`;
    }
  }
}

function renderApolloListResults(kind) {
  const isAccounts = kind === "accounts";
  const resultsEl = document.getElementById("apollo-list-results");
  if (!resultsEl) return;
  if (!apolloListRows.length) {
    resultsEl.innerHTML = `<div class="empty-state">That list is empty.</div>`;
    return;
  }
  const allSelected = apolloListRows.length > 0 && apolloListRows.every((_, i) => apolloListSelected.has(i));
  const hasMore = apolloListTotal > apolloListRows.length;
  resultsEl.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
      <button type="button" class="btn btn-primary btn-small" id="apollo-list-import-btn">Import selected as ${isAccounts ? "Accounts" : "Contacts"}</button>
      <span id="apollo-list-selected-count" style="font-size:12px;color:var(--text-dim);align-self:center">${apolloListSelected.size} selected</span>
    </div>
    <div class="table-scroll">
    <table>
      ${isAccounts ? `
        <thead><tr>
          <th><input type="checkbox" id="apollo-list-select-all" ${allSelected ? "checked" : ""} /></th>
          <th>Company</th><th>Website</th><th>Industry</th><th>Employees</th><th>Revenue</th><th>Phone</th><th>Address</th><th>LinkedIn</th>
        </tr></thead>
        <tbody>
          ${apolloListRows.map((c, i) => `
            <tr>
              <td><input type="checkbox" data-select="${i}" ${apolloListSelected.has(i) ? "checked" : ""} /></td>
              <td>${escapeAttr(c.name)}</td>
              <td>${escapeAttr(c.website || "—")}</td>
              <td>${escapeAttr(c.industry || "—")}</td>
              <td>${c.employees ?? "—"}</td>
              <td>${escapeAttr(c.revenue || "—")}</td>
              <td>${escapeAttr(c.phone || "—")}</td>
              <td>${escapeAttr(c.address || "—")}</td>
              <td>${c.linkedin_url ? `<a href="${escapeAttr(c.linkedin_url)}" target="_blank" rel="noopener">View</a>` : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      ` : `
        <thead><tr>
          <th><input type="checkbox" id="apollo-list-select-all" ${allSelected ? "checked" : ""} /></th>
          <th>Name</th><th>Title</th><th>Company</th><th>Location</th><th>Email</th><th>Phone</th><th>LinkedIn</th>
        </tr></thead>
        <tbody>
          ${apolloListRows.map((p, i) => `
            <tr>
              <td><input type="checkbox" data-select="${i}" ${apolloListSelected.has(i) ? "checked" : ""} /></td>
              <td>${escapeAttr(`${p.first_name} ${p.last_name}`.trim())}</td>
              <td>${escapeAttr(p.title || "—")}</td>
              <td>${escapeAttr(p.organization_name || "—")}</td>
              <td>${escapeAttr(p.location || "—")}</td>
              <td>${escapeAttr(p.email || "—")}</td>
              <td>${escapeAttr(p.phone || "—")}</td>
              <td>${p.linkedin_url ? `<a href="${escapeAttr(p.linkedin_url)}" target="_blank" rel="noopener">View</a>` : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      `}
    </table>
    </div>
    <div class="modal-actions" style="justify-content:space-between;margin-top:10px">
      <span style="font-size:12px;color:var(--text-dim)">Showing ${apolloListRows.length}${apolloListTotal ? ` of ${apolloListTotal}` : ""}</span>
      ${hasMore ? `<button type="button" class="btn btn-small" id="apollo-list-load-more-btn">Load more</button>` : ""}
    </div>
  `;
  const selectAllEl = document.getElementById("apollo-list-select-all");
  if (selectAllEl) {
    selectAllEl.addEventListener("change", (e) => {
      if (e.target.checked) apolloListRows.forEach((_, i) => apolloListSelected.add(i));
      else apolloListSelected.clear();
      renderApolloListResults(kind);
    });
  }
  resultsEl.querySelectorAll("[data-select]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.select);
      if (cb.checked) apolloListSelected.add(i); else apolloListSelected.delete(i);
      const countEl = document.getElementById("apollo-list-selected-count");
      if (countEl) countEl.textContent = `${apolloListSelected.size} selected`;
      const selectAll = document.getElementById("apollo-list-select-all");
      if (selectAll) selectAll.checked = apolloListRows.every((_, j) => apolloListSelected.has(j));
    });
  });
  const loadMoreBtn = document.getElementById("apollo-list-load-more-btn");
  if (loadMoreBtn) loadMoreBtn.addEventListener("click", () => loadApolloListContents(kind, true));
  document.getElementById("apollo-list-import-btn").addEventListener("click", () => importSelectedApolloListRows(kind));
}

async function importSelectedApolloListRows(kind) {
  const isAccounts = kind === "accounts";
  if (!apolloListSelected.size) { toast(`Select at least one ${isAccounts ? "company" : "person"}`, "error"); return; }
  const btn = document.getElementById("apollo-list-import-btn");
  btn.disabled = true;
  let count = 0;
  for (const i of apolloListSelected) {
    const row = apolloListRows[i];
    try {
      if (isAccounts) {
        await api("/api/prospecting/import-company", {
          method: "POST",
          body: {
            name: row.name, website: row.website, industry: row.industry, phone: row.phone,
            revenue: row.revenue, address: row.address, linkedin_url: row.linkedin_url,
          },
        });
      } else {
        await api("/api/prospecting/import-contact", {
          method: "POST",
          body: {
            first_name: row.first_name, last_name: row.last_name, email: row.email, phone: row.phone,
            title: row.title, linkedin_url: row.linkedin_url,
            organization_name: row.organization_name, organization_website: row.organization_website,
          },
        });
      }
      count++;
    } catch (err) {
      toast(`${isAccounts ? row.name : `${row.first_name} ${row.last_name}`}: ${err.message}`, "error");
    }
  }
  toast(`Imported ${count} ${count === 1 ? (isAccounts ? "account" : "contact") : (isAccounts ? "accounts" : "contacts")}`);
  apolloListSelected = new Set();
  await loadAll();
  if (count > 0) {
    closeModal();
    if (isAccounts) renderAccounts(); else renderContacts();
  } else {
    btn.disabled = false;
    renderApolloListResults(kind);
  }
}

function openAccountImportModal() {
  openModal(`
    <h2>Import accounts</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:10px">
      Upload a CSV or paste rows below. Columns recognized: Name (required), Industry, Website, Phone, Revenue, Address, Sales Navigator URL. A row whose name matches an existing account updates it instead of creating a duplicate.
      <br/><a href="#" id="import-template-link">Download CSV template</a>
    </div>
    <label>CSV file</label>
    <input type="file" id="import-file-input" accept=".csv,text/csv" />
    <label>Or paste CSV text</label>
    <textarea id="import-paste-input" rows="6" placeholder="Name,Industry,Website,Phone,Revenue,Address,Sales Navigator URL"></textarea>
    <div class="error-text" id="import-error"></div>
    <div id="import-preview"></div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="import-confirm-btn" disabled>Import</button>
    </div>
  `);

  let parsedRows = [];

  function updatePreview(text) {
    const errorEl = document.getElementById("import-error");
    const previewEl = document.getElementById("import-preview");
    const confirmBtn = document.getElementById("import-confirm-btn");
    errorEl.textContent = "";
    previewEl.innerHTML = "";
    parsedRows = [];
    confirmBtn.disabled = true;
    if (!text || !text.trim()) return;
    const rows = parseAccountsCsv(text);
    if (!rows.length) { errorEl.textContent = "Couldn't find any data rows."; return; }
    if (!rows.some((r) => r.name)) { errorEl.textContent = "No \"Name\" column recognized — check the header row matches the template."; return; }
    parsedRows = rows;
    const missingName = rows.filter((r) => !r.name).length;
    previewEl.innerHTML = `
      <div style="color:var(--text-dim);font-size:13px;margin:8px 0">${rows.length} row(s) found${missingName ? `, ${missingName} missing a name and will be skipped` : ""}.</div>
      <table>
        <thead><tr><th>Name</th><th>Industry</th><th>Website</th><th>Revenue</th></tr></thead>
        <tbody>
          ${rows.slice(0, 5).map((r) => `<tr><td>${escapeAttr(r.name || "—")}</td><td>${escapeAttr(r.industry || "—")}</td><td>${escapeAttr(r.website || "—")}</td><td>${escapeAttr(r.revenue || "—")}</td></tr>`).join("")}
        </tbody>
      </table>
      ${rows.length > 5 ? `<div style="color:var(--text-dim);font-size:12px;margin-top:4px">…and ${rows.length - 5} more</div>` : ""}
    `;
    confirmBtn.disabled = false;
  }

  document.getElementById("import-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      document.getElementById("import-paste-input").value = text;
      updatePreview(text);
    };
    reader.readAsText(file);
  });
  document.getElementById("import-paste-input").addEventListener("input", (e) => updatePreview(e.target.value));
  document.getElementById("import-template-link").addEventListener("click", (e) => {
    e.preventDefault();
    const csv = "Name,Industry,Website,Phone,Revenue,Address,Sales Navigator URL\nAcme Inc,Software,acme.com,+1 555 000 0000,$10M,1 Main St,https://linkedin.com/company/acme\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "accounts-import-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById("import-confirm-btn").addEventListener("click", async () => {
    const btn = document.getElementById("import-confirm-btn");
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const result = await api("/api/accounts/import", { method: "POST", body: { rows: parsedRows } });
      const parts = [];
      if (result.created) parts.push(`${result.created} created`);
      if (result.updated) parts.push(`${result.updated} updated`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      toast(parts.length ? parts.join(", ") : "Nothing imported");
      closeModal();
      await loadAll();
      renderAccounts();
    } catch (err) {
      document.getElementById("import-error").textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Import";
    }
  });
}

// -- Import contacts from CSV --
// Same shape as the Accounts importer above. The "Account" column is
// matched against existing Account names server-side (not resolved here) —
// a miss just leaves the contact unlinked, it doesn't block the row.

function openContactImportModal() {
  openModal(`
    <h2>Import contacts</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:10px">
      Upload a CSV or paste rows below. Columns recognized: First name and Last name (required), Email, Phone, Title, Account, LinkedIn URL, Sales Navigator URL. A row whose email matches an existing contact updates it instead of creating a duplicate. If "Account" doesn't match an existing account name exactly, the contact is still created — just without a linked account.
      <br/><a href="#" id="contact-import-template-link">Download CSV template</a>
    </div>
    <label>CSV file</label>
    <input type="file" id="contact-import-file-input" accept=".csv,text/csv" />
    <label>Or paste CSV text</label>
    <textarea id="contact-import-paste-input" rows="6" placeholder="First name,Last name,Email,Phone,Title,Account,LinkedIn URL,Sales Navigator URL"></textarea>
    <div class="error-text" id="contact-import-error"></div>
    <div id="contact-import-preview"></div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="contact-import-confirm-btn" disabled>Import</button>
    </div>
  `);

  let parsedRows = [];

  function updatePreview(text) {
    const errorEl = document.getElementById("contact-import-error");
    const previewEl = document.getElementById("contact-import-preview");
    const confirmBtn = document.getElementById("contact-import-confirm-btn");
    errorEl.textContent = "";
    previewEl.innerHTML = "";
    parsedRows = [];
    confirmBtn.disabled = true;
    if (!text || !text.trim()) return;
    const rows = parseContactsCsv(text);
    if (!rows.length) { errorEl.textContent = "Couldn't find any data rows."; return; }
    if (!rows.some((r) => r.first_name || r.last_name)) { errorEl.textContent = "No \"First name\"/\"Last name\" columns recognized — check the header row matches the template."; return; }
    parsedRows = rows;
    const missingName = rows.filter((r) => !r.first_name || !r.last_name).length;
    previewEl.innerHTML = `
      <div style="color:var(--text-dim);font-size:13px;margin:8px 0">${rows.length} row(s) found${missingName ? `, ${missingName} missing a first or last name and will be skipped` : ""}.</div>
      <table>
        <thead><tr><th>First name</th><th>Last name</th><th>Email</th><th>Account</th></tr></thead>
        <tbody>
          ${rows.slice(0, 5).map((r) => `<tr><td>${escapeAttr(r.first_name || "—")}</td><td>${escapeAttr(r.last_name || "—")}</td><td>${escapeAttr(r.email || "—")}</td><td>${escapeAttr(r.account || "—")}</td></tr>`).join("")}
        </tbody>
      </table>
      ${rows.length > 5 ? `<div style="color:var(--text-dim);font-size:12px;margin-top:4px">…and ${rows.length - 5} more</div>` : ""}
    `;
    confirmBtn.disabled = false;
  }

  document.getElementById("contact-import-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      document.getElementById("contact-import-paste-input").value = text;
      updatePreview(text);
    };
    reader.readAsText(file);
  });
  document.getElementById("contact-import-paste-input").addEventListener("input", (e) => updatePreview(e.target.value));
  document.getElementById("contact-import-template-link").addEventListener("click", (e) => {
    e.preventDefault();
    const csv = "First name,Last name,Email,Phone,Title,Account,LinkedIn URL,Sales Navigator URL\nJane,Doe,jane.doe@example.com,+1 555 000 0000,VP Sales,Acme Inc,https://linkedin.com/in/janedoe,https://linkedin.com/sales/people/janedoe\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "contacts-import-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById("contact-import-confirm-btn").addEventListener("click", async () => {
    const btn = document.getElementById("contact-import-confirm-btn");
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const result = await api("/api/contacts/import", { method: "POST", body: { rows: parsedRows } });
      const parts = [];
      if (result.created) parts.push(`${result.created} created`);
      if (result.updated) parts.push(`${result.updated} updated`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      toast(parts.length ? parts.join(", ") : "Nothing imported");
      closeModal();
      await loadAll();
      renderContacts();
    } catch (err) {
      document.getElementById("contact-import-error").textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Import";
    }
  });
}

// `onSaved`, if given, is called with the saved account instead of the
// default close-and-refresh-the-Accounts-page behavior -- used by the
// Contact form's "Edit" button (next to its Account select) to hand control
// back to the contact form afterward, rather than dropping the user onto
// the Accounts page.
function openAccountFormModal(existing, onSaved) {
  const v = existing || { name: "", industry: "", website: "", revenue: "", address: "", sales_navigator_url: "" };
  openModal(`
    <h2>${existing ? "Edit" : "New"} account</h2>
    <form id="account-form">
      <label>Account / website</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="acct-name-input" name="name" value="${escapeAttr(v.name)}" required placeholder="Company name or website, e.g. Barclays or facebook.com" style="flex:1" />
        <button type="button" class="btn" id="acct-autofill-btn">Auto-fill</button>
      </div>
      <div class="hint" style="margin-top:-8px;margin-bottom:10px">Type either a company name or a website — Auto-fill figures out which and fills in the real company name below if you typed a website.</div>
      <label>Industry</label><input id="acct-industry-input" name="industry" value="${escapeAttr(v.industry || "")}" />
      <label>Website</label><input id="acct-website-input" name="website" value="${escapeAttr(v.website || "")}" />
      <label>Address</label><input id="acct-address-input" name="address" value="${escapeAttr(v.address || "")}" />
      <label>Revenue</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input name="revenue" id="acct-revenue-input" value="${escapeAttr(v.revenue || "")}" placeholder="e.g. $50M" style="flex:1" />
        <a href="#" id="acct-revenue-search-link" class="btn" style="white-space:nowrap">Search on Google</a>
      </div>
      <label>Sales Navigator URL</label><input id="acct-salesnav-input" name="sales_navigator_url" type="text" value="${v.sales_navigator_url || ""}" placeholder="linkedin.com/sales/company/..." />
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${existing ? "Save changes" : "Create account"}</button>
      </div>
    </form>
  `);
  // Auto-fill: tries Apollo (already connected for Prospecting) first, then
  // falls back to Claude's live web search for whatever Apollo didn't return.
  // Both are best-effort — the button reports which source(s) actually
  // filled something, so a rep isn't left guessing whether a blank field
  // means "not found" or "lookup didn't run." Note: sales_navigator_url ends
  // up filled with the company's normal public LinkedIn URL, not a literal
  // Sales Navigator deep link — that internal ID isn't public/searchable.
  document.getElementById("acct-autofill-btn").addEventListener("click", async () => {
    const name = document.getElementById("acct-name-input").value.trim();
    if (!name) { toast("Enter the account name first", "error"); return; }
    const btn = document.getElementById("acct-autofill-btn");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Looking up…";
    try {
      const result = await api("/api/accounts/lookup-company", { method: "POST", body: { name } });
      const fieldMap = {
        industry: "acct-industry-input", website: "acct-website-input", revenue: "acct-revenue-input",
        address: "acct-address-input", sales_navigator_url: "acct-salesnav-input",
      };
      const filled = [];
      // If a website was typed instead of a company name, the lookup
      // resolves the real company behind it -- swap the name field over so
      // the account gets created under its actual name, not the raw domain.
      if (result.resolved_name && result.resolved_name.toLowerCase() !== name.toLowerCase()) {
        document.getElementById("acct-name-input").value = result.resolved_name;
        filled.push("name");
      }
      for (const [field, inputId] of Object.entries(fieldMap)) {
        if (result[field]) {
          document.getElementById(inputId).value = result[field];
          filled.push(field);
        }
      }
      if (filled.length) {
        toast(`Filled ${filled.join(", ")} from ${(result.sources || []).join(" + ") || "lookup"}`);
      } else {
        toast((result.warnings && result.warnings[0]) || "No matching data found", "error");
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
  // No live enrichment API is wired up for this link specifically — it just
  // opens a Google search so a rep can manually verify/find the revenue
  // figure if Auto-fill above didn't find one.
  document.getElementById("acct-revenue-search-link").addEventListener("click", (e) => {
    e.preventDefault();
    const name = document.getElementById("acct-name-input").value.trim();
    if (!name) { toast("Enter the account name first", "error"); return; }
    window.open(`https://www.google.com/search?q=${encodeURIComponent(`${name} annual revenue`)}`, "_blank", "noopener");
  });
  document.getElementById("account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.sales_navigator_url = normalizeUrlInput(body.sales_navigator_url);
    try {
      let saved;
      if (existing) {
        saved = await api(`/api/accounts/${existing.id}`, { method: "PUT", body });
        const idx = state.accounts.findIndex((a) => a.id === existing.id);
        if (idx !== -1) state.accounts[idx] = saved;
        toast("Account updated");
      } else {
        saved = await api("/api/accounts", { method: "POST", body });
        toast("Account created");
      }
      closeModal();
      await loadAll();
      if (onSaved) onSaved(saved); else renderAccounts();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------- Account detail: score, signals, tech stack, notes, AI brief ----------
// Adapted from a ported ACCELQ Outreach Intelligence module. Kept: priority
// scoring, intent signals, tech-stack tracking, notes, AI research brief —
// rebuilt against Trellis's real account_id-based data (so Pipeline/Contacts/
// Reports keep working) instead of the original's company-name-derived
// accounts. Left out: Apollo enrichment (not connected), portfolio scan and
// data-hygiene/company-rename (not applicable — our accounts have real IDs,
// no typo-duplicate risk), and cross-tab handoffs to features Trellis
// doesn't have (Outreach tab, deck generator, email finder).

const SIGNAL_FIELDS = [
  ["funding", "Funding round"],
  ["hiringQA", "Hiring for QA"],
  ["largeQATeam", "Large QA team"],
  ["recentLaunch", "Recent product launch"],
  ["leadershipChange", "Leadership change"],
  ["outage", "Recent outage/incident"],
  ["cicd", "CI/CD gap flagged"],
];

// ---------- Signal strength / Intent score ----------
// A second, separate score from the "Priority" one above -- Priority is a
// general engagement-readiness score (contacts on file, leads, generic
// signals). This one is specifically about buying intent for a test-
// automation product, read off the account's own Tech stack fields, so it
// works with zero AI calls and reproduces the same result for the same
// inputs every time. Bands are examples the user gave (multiple enterprise
// apps, large QA team, legacy commercial test tools, modern OSS test
// tools) -- not a fixed spec, so easy to retune the keyword lists or point
// values below without touching any caller. Ranges were tightened to be
// non-overlapping (80-89 instead of "81-90", etc.) since the example bands
// as given both included 90.
const INTENT_ENTERPRISE_APPS = ["salesforce", "coupa", "workday", "oracle", "sap", "netsuite", "servicenow", "ariba"];
const INTENT_LEGACY_TOOLS = ["tosca", "uft", "qtp", "hp alm", "alm", "silk test", "rational functional tester", "rft"];
const INTENT_MODERN_TOOLS = ["playwright", "selenium", "cypress", "appium", "webdriverio", "testcafe"];

function computeIntentScore(account) {
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

// Bucket a stored score (auto-generated OR manually typed in) into the same
// bands used for filtering, so a manually-entered 85 filters the same way
// an auto-generated 85 would.
function intentScoreBand(score) {
  if (score === null || score === undefined) return null;
  if (score >= 90) return "90-99";
  if (score >= 80) return "80-89";
  if (score >= 70) return "70-79";
  if (score >= 60) return "60-69";
  return "below-60";
}

function intentScoreColor(score) {
  if (score === null || score === undefined) return "var(--text-dim)";
  if (score >= 90) return "#dc2626";
  if (score >= 80) return "#f59e0b";
  if (score >= 70) return "var(--teal)";
  if (score >= 60) return "var(--ink)";
  return "var(--text-dim)";
}

// Small clickable badge shown right beside the account name -- the number
// itself doubles as the "icon" (more useful at a glance than a generic
// glyph would be) since it's the piece a rep actually triages by. Unscored
// accounts get a faint dashed placeholder so it's obvious scoring hasn't
// been run yet, not that it came back at 0.
function intentScoreBadgeHtml(account) {
  const score = account.intent_score;
  if (score === null || score === undefined) {
    return `<span data-intent-score-icon="${account.id}" title="Not scored yet — click to generate an intent score" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1.5px dashed var(--border-strong);color:var(--text-dim);font-size:11px;cursor:pointer;vertical-align:middle;margin-left:6px">–</span>`;
  }
  return `<span data-intent-score-icon="${account.id}" title="Intent score ${score} — click for details" style="display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 5px;border-radius:12px;background:${intentScoreColor(score)};color:#fff;font-size:11px;font-weight:700;cursor:pointer;vertical-align:middle;margin-left:6px">${score}</span>`;
}

// Single surface for viewing factors + (re)generating + manually overriding
// the score -- reused from both the Accounts list icon and the Account
// detail modal's header badge, so there's one place this logic lives.
function openIntentScoreModal(account) {
  const score = account.intent_score;
  openModal(`
    <h2>Intent score — ${escapeAttr(account.name)}</h2>
    ${score !== null && score !== undefined ? `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:40px;padding:0 8px;border-radius:20px;background:${intentScoreColor(score)};color:#fff;font-size:18px;font-weight:700">${score}</span>
        <span style="font-size:13px">${escapeAttr(account.intent_score_label || "")}${account.intent_score_manual ? " (manually set)" : ""}</span>
      </div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px">
        ${account.intent_score_factors?.length ? `Parameters used: ${account.intent_score_factors.map(escapeAttr).join(" · ")}` : "No factors on file — this score was entered manually."}
      </div>
    ` : `<div class="empty-state" style="margin-bottom:16px">Not scored yet.</div>`}
    <div class="hint" style="margin-bottom:14px">
      Example bands: 90–99 multiple enterprise apps (Salesforce, Coupa, Workday, Oracle, SAP) · 80–89 large QA team · 70–79 legacy tools (Tosca, UFT) · 60–69 modern OSS tools (Playwright, Selenium). Based on this account's Tech stack + Intent signals fields.
    </div>
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:14px">
      <button type="button" class="btn btn-small btn-primary" id="intent-generate-btn">${score !== null && score !== undefined ? "Regenerate from tech stack" : "Generate score"}</button>
    </div>
    <label>Or set manually</label>
    <div style="display:flex;gap:8px">
      <input type="number" id="intent-manual-input" min="0" max="99" placeholder="0-99" value="${score !== null && score !== undefined ? score : ""}" style="flex:1" />
      <button type="button" class="btn btn-small" id="intent-save-btn">Save</button>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
    </div>
  `);

  const persistAndRefresh = async (patch) => {
    const updated = await api(`/api/accounts/${account.id}`, { method: "PUT", body: patch });
    const idx = state.accounts.findIndex((a) => a.id === account.id);
    if (idx !== -1) state.accounts[idx] = updated;
    return updated;
  };

  document.getElementById("intent-generate-btn").addEventListener("click", async () => {
    const btn = document.getElementById("intent-generate-btn");
    btn.disabled = true;
    btn.textContent = "Scoring…";
    const result = computeIntentScore(account);
    const patch = result
      ? { intent_score: result.score, intent_score_label: result.label, intent_score_factors: result.factors, intent_score_manual: false }
      : { intent_score: null, intent_score_label: null, intent_score_factors: [], intent_score_manual: false };
    try {
      const updated = await persistAndRefresh(patch);
      toast(result ? `Scored ${result.score} — ${result.label}` : "Not enough tech-stack signal yet to score this account");
      openIntentScoreModal(updated);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = score !== null && score !== undefined ? "Regenerate from tech stack" : "Generate score";
    }
  });

  document.getElementById("intent-save-btn").addEventListener("click", async () => {
    const raw = document.getElementById("intent-manual-input").value;
    if (raw !== "" && (Number.isNaN(Number(raw)) || Number(raw) < 0 || Number(raw) > 99)) {
      toast("Enter a number between 0 and 99, or leave blank to clear", "error");
      return;
    }
    const val = raw === "" ? null : Math.round(Number(raw));
    try {
      const updated = await persistAndRefresh({
        intent_score: val,
        intent_score_label: val !== null ? "Manually set" : null,
        intent_score_factors: [],
        intent_score_manual: val !== null,
      });
      toast(val !== null ? "Score saved" : "Score cleared");
      openIntentScoreModal(updated);
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------- Company research ("Auto Gen") ----------
// Shared trigger for POST /api/accounts/:id/research -- used from both the
// Accounts list row's 🔎 icon and the Account detail modal's own button, so
// the request/state-sync/toast logic lives in one place rather than being
// copied at each call site. The route does live web search (can take up to
// ~20-25s), merges any tech-stack signals it finds into the account, and
// auto-generates the Intent score from those -- so state.accounts[idx] may
// come back with saas_apps/tools/signals/intent_score all changed, not just
// company_research.
// Mirrors lib/ai.js's COMPANY_RESEARCH_SECTIONS keys/titles (not shared as a
// module between frontend/backend in this app) -- only what's needed here
// to drive the loop and label progress; the actual prompts/signal parsing
// live server-side.
const COMPANY_RESEARCH_SECTIONS = [
  { key: "1", title: "Company Overview" },
  { key: "2", title: "Major Applications/Platforms" },
  { key: "3", title: "Technology Stack" },
  { key: "4", title: "QA/Testing Landscape" },
  { key: "5", title: "Digital Transformation Initiatives" },
  { key: "6", title: "Integrations & System Complexity" },
  { key: "7", title: "Testing/Automation Pain Points" },
  { key: "8", title: "Key Decision-Makers" },
  { key: "9", title: "Recent News & Signals" },
  { key: "10", title: "ACCELQ Opportunity" },
];

// Drives "Auto Gen" as 10 SEPARATE sequential requests (one per report
// section) instead of one big call -- each is its own short-lived Netlify
// Function invocation (one web search, a couple of sentences), so no single
// request risks the ~10-26s synchronous timeout the earlier one-shot
// version kept hitting. Slower end-to-end (~10 round trips instead of 1),
// which is why onProgress exists -- so the button can show real progress
// instead of a long unexplained spinner. One section failing doesn't sink
// the rest: it's recorded as "(unable to retrieve)" and the loop continues.
// A single POST to /research/finalize at the end persists the assembled
// report + merges signals into Tech stack + (re)generates the Intent score.
async function runAccountResearch(accountId, { onProgress, onDone, onSettled } = {}) {
  try {
    const sectionTexts = [];
    const combined = { enterprise_apps: [], legacy_test_tools: [], modern_test_tools: [], large_qa_team: false, decision_makers: [], opportunity_score: null, opportunity_summary: "" };
    for (let i = 0; i < COMPANY_RESEARCH_SECTIONS.length; i++) {
      const section = COMPANY_RESEARCH_SECTIONS[i];
      if (onProgress) onProgress(i + 1, COMPANY_RESEARCH_SECTIONS.length, section.title);
      try {
        const result = await api(`/api/accounts/${accountId}/research/section`, { method: "POST", body: { section: section.key } });
        sectionTexts.push(`${section.key}. ${result.title}\n${result.text}`);
        for (const [k, v] of Object.entries(result.signals || {})) {
          if (Array.isArray(v)) combined[k] = combined[k].concat(v);
          else if (v) combined[k] = v; // booleans/numbers/strings: last truthy value found wins
        }
      } catch (err) {
        sectionTexts.push(`${section.key}. ${section.title}\n(Unable to retrieve this section: ${err.message})`);
      }
    }
    const report_text = sectionTexts.join("\n\n");
    const updated = await api(`/api/accounts/${accountId}/research/finalize`, { method: "POST", body: { report_text, signals: combined } });
    const idx = state.accounts.findIndex((a) => a.id === accountId);
    if (idx !== -1) state.accounts[idx] = updated;
    toast(updated.intent_score !== null && updated.intent_score !== undefined
      ? `Research complete — intent score ${updated.intent_score}`
      : "Research complete");
    if (onDone) onDone(updated);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (onSettled) onSettled();
  }
}

function accountScoreInfo(account) {
  const s = account.signals || {};
  const contacts = state.contacts.filter((c) => c.account_id === account.id);
  const leads = state.leads.filter((l) => l.account_linked_id === account.id);
  const approvedLeads = leads.filter((l) => l.status === "approved").length;
  let score = 0;
  const factors = [];
  const add = (label, pts) => { if (pts > 0) { score += pts; factors.push({ label, pts }); } };
  add("Funding signal", s.funding ? 15 : 0);
  add("Hiring for QA", s.hiringQA ? 15 : 0);
  add("Recent product launch", s.recentLaunch ? 10 : 0);
  add("Leadership change", s.leadershipChange ? 10 : 0);
  add("Recent outage/incident", s.outage ? 10 : 0);
  add("CI/CD gap flagged", s.cicd ? 10 : 0);
  add("Legacy tool(s) on file", (account.tools || []).length ? 10 : 0);
  add("Contact coverage", Math.min(contacts.length * 3, 15));
  add("Leads on file", Math.min(leads.length * 5, 15));
  add("Approved leads", approvedLeads > 0 ? 10 : 0);
  return { score: Math.min(score, 100), factors, contacts, leads };
}

function scoreColor(score) {
  if (score >= 70) return "var(--teal)";
  if (score >= 40) return "var(--amber)";
  return "var(--text-dim)";
}

// Same Priority number shown in the Account detail modal's header pill,
// surfaced beside the company name on the Accounts list too so a rep can
// triage without opening each account. Just the number -- accountScoreInfo
// is cheap (pure client-side arithmetic over data already in state), so
// there's no need to persist or cache it.
// Renders the "About" + "Company IQ"-style data pulled through Unipile
// (real Sales Navigator/LinkedIn page content, not a web-search guess).
// Kept as its own function since the same shape is used both when re-
// opening the modal with saved data and right after a fresh fetch.
function linkedinCompanyPanelHtml(c) {
  if (!c) return `<div class="empty-state">No LinkedIn data yet — paste a company LinkedIn URL and fetch its profile.</div>`;
  const hq = c.headquarters ? [c.headquarters.city, c.headquarters.area, c.headquarters.country].filter(Boolean).join(", ") : "";
  const growth = (c.headcount_growth || []).map((g) => `${g.growthPercentage >= 0 ? "+" : ""}${g.growthPercentage}% (${g.monthRange}mo)`).join(" · ");
  return `
    <div style="font-size:13px;line-height:1.6">
      ${c.tagline ? `<div style="font-weight:600;margin-bottom:4px">${escapeAttr(c.tagline)}</div>` : ""}
      ${c.description ? `<div style="white-space:pre-wrap;max-height:200px;overflow-y:auto;padding-right:6px;margin-bottom:10px">${escapeAttr(c.description)}</div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12px">
        ${c.company_type ? `<div><span style="color:var(--text-dim)">Type</span><br/><strong>${escapeAttr(c.company_type)}</strong></div>` : ""}
        ${c.industry ? `<div><span style="color:var(--text-dim)">Industry</span><br/><strong>${escapeAttr(c.industry)}</strong></div>` : ""}
        ${hq ? `<div><span style="color:var(--text-dim)">HQ</span><br/><strong>${escapeAttr(hq)}</strong></div>` : ""}
        ${c.founded ? `<div><span style="color:var(--text-dim)">Founded</span><br/><strong>${escapeAttr(c.founded)}</strong></div>` : ""}
        ${c.employee_count != null ? `<div><span style="color:var(--text-dim)">Employees</span><br/><strong>${c.employee_count.toLocaleString()}${c.employee_count_range ? ` (${c.employee_count_range})` : ""}</strong></div>` : ""}
        ${c.website ? `<div><span style="color:var(--text-dim)">Website</span><br/><strong><a href="${c.website}" target="_blank" rel="noopener" style="color:var(--teal)">${escapeAttr(c.website)}</a></strong></div>` : ""}
      </div>
      ${growth ? `<div style="margin-top:10px;font-size:12px"><strong>Headcount growth (Company IQ):</strong> ${growth}</div>` : ""}
      ${c.activities?.length ? `<div style="margin-top:8px;font-size:12px"><strong>Specialties:</strong> ${c.activities.map(escapeAttr).join(" · ")}</div>` : ""}
      ${c.hashtags?.length ? `<div style="margin-top:6px;font-size:12px">${c.hashtags.map((h) => escapeAttr(h)).join(" ")}</div>` : ""}
      <div class="hint" style="margin-top:10px">Generated ${new Date(c.generated_at).toLocaleString()} via Unipile from a real logged-in LinkedIn session — this is live page data (the same fields as LinkedIn's own "About" tab). Sales Navigator's own AI-written "Account IQ" panel is a separate, seat-specific LinkedIn AI feature not exposed by this or any company-profile API — see "Account IQ (AI research)" below for the closest equivalent, built the same way.</div>
    </div>
  `;
}

// Closest available equivalent to Sales Navigator's private "Account IQ"
// panel (How this company makes money / Strategic priorities / Business
// challenges / Competitive landscape / Competitors — see the long comment
// above ai.generateSalesNavField in lib/ai.js for why the real panel isn't
// reachable via any API). Same fields, same per-field Claude web-search
// approach as the standalone LinkedIn Search page's 9-field tool, just run
// and saved straight against this Account instead of a separate report.
const ACCOUNT_IQ_FIELDS_UI = [
  { key: "account_iq", label: "Account IQ" },
  { key: "revenue_model", label: "How This Company Makes Money" },
  { key: "strategic_priorities", label: "Strategic Priorities" },
  { key: "business_challenges", label: "Business Challenges" },
  { key: "competitive_landscape", label: "Competitive Landscape" },
  { key: "competitors", label: "Competitors / Alternatives" },
];

function accountIqFieldRowHtml(f, research) {
  const value = research?.[f.key] || "";
  return `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim)">${f.label}</label>
        <button type="button" class="btn btn-small" data-account-iq-field="${f.key}">${value ? "Refresh" : "Research"}</button>
      </div>
      <textarea id="account-iq-${f.key}" rows="2" readonly style="width:100%;resize:vertical;font:inherit;background:var(--panel-2)" placeholder="Not run yet">${escapeAttr(value)}</textarea>
    </div>
  `;
}

function priorityPillHtml(account) {
  const { score } = accountScoreInfo(account);
  return `<span title="Priority score ${score} — engagement readiness (contacts, leads, signals on file)" style="display:inline-block;margin-left:6px;font-size:11px;font-weight:600;color:${scoreColor(score)}">${score}</span>`;
}

function tagChipsHtml(items, removeAttr) {
  if (!items || !items.length) return `<span style="color:var(--text-dim);font-size:12px">None yet</span>`;
  return items.map((item, i) => `
    <span class="tag-role" style="display:inline-flex;align-items:center;gap:6px;margin:0 6px 6px 0;padding:3px 8px">
      ${item}
      <span style="cursor:pointer;color:var(--coral)" data-${removeAttr}="${i}">×</span>
    </span>
  `).join("");
}

function openAccountDetailModal(account) {
  const { score, factors, contacts, leads } = accountScoreInfo(account);
  const signals = account.signals || {};

  openModal(`
    <h2>${account.name} <span id="account-detail-intent-badge">${intentScoreBadgeHtml(account)}</span></h2>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <span style="font-size:13px;color:var(--text-dim)">${[account.industry, account.website].filter(Boolean).join(" · ") || "—"}</span>
      <span class="pill" style="margin-left:auto;background:var(--panel-2);color:${scoreColor(score)}">Priority ${score}</span>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;font-size:13px">
        <div><span style="color:var(--text-dim)">Contacts</span><br/><strong>${contacts.length}</strong></div>
        <div><span style="color:var(--text-dim)">Leads</span><br/><strong>${leads.length}</strong></div>
        <div><span style="color:var(--text-dim)">Phone</span><br/><strong>${account.phone || "—"}</strong></div>
        <div><span style="color:var(--text-dim)">Owner</span><br/><strong>${userName(account.owner_id)}</strong></div>
        <div><span style="color:var(--text-dim)">Sales Navigator</span><br/><strong>${account.sales_navigator_url ? `<a href="${account.sales_navigator_url}" target="_blank" rel="noopener" style="color:var(--teal)">Open ↗</a>` : "—"}</strong></div>
        <div><span style="color:var(--text-dim)">Salesforce</span><br/><strong>${account.sf_id ? (sfRecordUrl("Account", account.sf_id) ? `<a href="${sfRecordUrl("Account", account.sf_id)}" target="_blank" rel="noopener" style="color:var(--teal)">View ↗</a>` : "Synced") : (state.salesforce?.connected ? `<button type="button" class="btn btn-small" id="account-sf-push-btn">Push</button>` : "—")}</strong></div>
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--text-dim)">
        ${factors.length ? factors.map((f) => `${f.label} (+${f.pts})`).join(" · ") : "No score signals yet — add some below."}
      </div>
    </div>

    ${account.li_capture?.about || account.li_capture?.employees ? `
      <div class="panel" style="padding:14px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <h2 style="margin:0">About (captured from LinkedIn)</h2>
          ${account.li_capture.employees ? `<span style="font-size:12px;color:var(--text-dim)">${escapeAttr(account.li_capture.employees)}</span>` : ""}
        </div>
        ${account.li_capture.about ? `<div style="font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:180px;overflow-y:auto">${escapeAttr(account.li_capture.about)}</div>` : ""}
        <div class="hint" style="margin-top:6px">Captured ${new Date(account.li_capture.captured_at).toLocaleString()} via the browser extension.</div>
      </div>
    ` : ""}

    ${contacts.length ? `
      <div class="panel" style="padding:14px;margin-bottom:14px">
        <h2 style="margin-bottom:8px">Contacts at this account</h2>
        ${contacts.map((c) => `
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid var(--border)">
            <span>${c.first_name} ${c.last_name}${c.title ? " — " + c.title : ""}</span>
            <span style="color:var(--text-dim)">${c.email || "—"}</span>
          </div>
        `).join("")}
      </div>
    ` : ""}

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <h2 style="margin-bottom:8px">Intent signals</h2>
      <div style="display:flex;flex-wrap:wrap;gap:14px">
        ${SIGNAL_FIELDS.map(([key, label]) => `
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text);margin:0">
            <input type="checkbox" data-signal="${key}" ${signals[key] ? "checked" : ""} style="width:auto" />
            ${label}
          </label>
        `).join("")}
      </div>
      <div class="modal-actions" style="margin-top:12px">
        <button type="button" class="btn btn-small btn-primary" id="save-signals-btn">Save signals</button>
      </div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:2px">
        <h2 style="margin:0">Tech stack</h2>
        ${account.company_research?.text ? `<button type="button" class="btn btn-small" id="fill-tech-from-research-btn" title="Read the research report below and add only tools/apps it confirms are actually in use">✨ Fill from research</button>` : ""}
      </div>
      <label style="font-size:12px">Legacy / manual tools flagged</label>
      <div style="margin:6px 0">${tagChipsHtml(account.tools, "remove-tool")}</div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input type="text" id="new-tool-input" placeholder="e.g. Selenium, QTP…" style="flex:1" />
        <button type="button" class="btn btn-small" id="add-tool-btn">Add</button>
      </div>
      <label style="font-size:12px">SaaS apps in use</label>
      <div style="margin:6px 0">${tagChipsHtml(account.saas_apps, "remove-saas")}</div>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-saas-input" placeholder="e.g. Jira, Salesforce…" style="flex:1" />
        <button type="button" class="btn btn-small" id="add-saas-btn">Add</button>
      </div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <h2 style="margin:0">🔎 Company &amp; software landscape research</h2>
        ${account.company_research?.opportunity_score != null ? `<span class="pill" style="background:var(--panel-2)">ACCELQ fit ${account.company_research.opportunity_score}/10</span>` : ""}
      </div>
      ${account.company_research?.text ? `
        <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:420px;overflow-y:auto;padding-right:6px">${escapeAttr(account.company_research.text)}</div>
        ${account.company_research.decision_makers?.length ? `
          <div style="margin-top:10px;font-size:12px"><strong>Decision-makers found:</strong> ${account.company_research.decision_makers.map((d) => escapeAttr(d.title ? `${d.name} (${d.title})` : d.name)).join(" · ")}</div>
        ` : ""}
        <div class="hint" style="margin-top:8px">Generated ${new Date(account.company_research.generated_at).toLocaleString()} via live web search — this auto-filled Tech stack above and (re)generated the Intent score; verify anything critical before acting on it.</div>
      ` : `<div class="empty-state">No research yet — Auto Gen searches the web and fills the report, Tech stack, and Intent score below.</div>`}
      <div class="modal-actions" style="margin-top:10px">
        <button type="button" class="btn btn-small btn-primary" id="generate-research-btn">${account.company_research?.text ? "Regenerate (Auto Gen)" : "Auto Gen"}</button>
      </div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <h2 style="margin-bottom:8px">🔗 LinkedIn Search</h2>
      ${account.linkedin_profile?.text ? `
        <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:300px;overflow-y:auto;padding-right:6px">${escapeAttr(account.linkedin_profile.text)}</div>
        <div class="hint" style="margin-top:8px">Generated ${new Date(account.linkedin_profile.generated_at).toLocaleString()} from <a href="${account.linkedin_profile.url}" target="_blank" rel="noopener" style="color:var(--teal)">${account.linkedin_profile.url}</a> via live web search — LinkedIn pages require login to view in full, so this reflects only what's publicly discoverable. Verify before acting on it.</div>
      ` : `<div class="empty-state">No LinkedIn research yet — paste a company LinkedIn/Sales Navigator URL and run a search.</div>`}
      <div style="display:flex;gap:8px;margin-top:10px">
        <input type="text" id="linkedin-search-url" placeholder="linkedin.com/company/…" value="${escapeAttr(account.linkedin_profile?.url || account.sales_navigator_url || "")}" style="flex:1" />
        <button type="button" class="btn btn-small btn-primary" id="linkedin-search-btn">${account.linkedin_profile?.text ? "Regenerate" : "LinkedIn Search"}</button>
      </div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <h2 style="margin:0">💼 LinkedIn (Sales Navigator)</h2>
        ${account.linkedin_company?.followers_count != null ? `<span class="pill" style="background:var(--panel-2)">${account.linkedin_company.followers_count.toLocaleString()} followers</span>` : ""}
      </div>
      ${linkedinCompanyPanelHtml(account.linkedin_company)}
      <div style="display:flex;gap:8px;margin-top:10px">
        <input type="text" id="linkedin-company-url" placeholder="linkedin.com/company/…" value="${escapeAttr(account.linkedin_company?.profile_url || account.sales_navigator_url || "")}" style="flex:1" />
        <button type="button" class="btn btn-small btn-primary" id="linkedin-company-btn">${account.linkedin_company ? "Refresh" : "Fetch profile"}</button>
      </div>

      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
        <h2 style="margin:0 0 8px 0;font-size:14px">Key people</h2>
        ${account.linkedin_key_people?.people?.length ? `
          <div style="display:flex;flex-direction:column;gap:8px">
            ${account.linkedin_key_people.people.map((p) => `
              <div style="display:flex;align-items:center;gap:10px;font-size:13px">
                ${p.photo_url ? `<img src="${p.photo_url}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0" />` : `<span style="width:32px;height:32px;border-radius:50%;background:var(--panel-2);flex-shrink:0"></span>`}
                <div style="flex:1;min-width:0">
                  <a href="${p.profile_url}" target="_blank" rel="noopener" style="color:var(--teal);font-weight:600">${escapeAttr(p.name)}</a>
                  ${p.connection_degree ? `<span style="color:var(--text-dim);font-size:11px"> · ${p.connection_degree}</span>` : ""}
                  <div style="color:var(--text-dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeAttr(p.title || "")}</div>
                </div>
              </div>
            `).join("")}
          </div>
          <div class="hint" style="margin-top:8px">Found ${new Date(account.linkedin_key_people.generated_at).toLocaleString()}${account.linkedin_key_people.persona_title ? ` targeting the "${escapeAttr(account.linkedin_key_people.persona_title)}" persona` : account.linkedin_key_people.keywords ? ` searching for "${escapeAttr(account.linkedin_key_people.keywords)}"` : " via a live LinkedIn search for senior/decision-maker titles"} — this uses your LinkedIn account's daily search allowance, so use sparingly.</div>
        ` : `<div class="empty-state">No key people found yet.</div>`}
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <select id="linkedin-key-people-persona" style="flex:1">
            <option value="">No persona — use keyword/default below</option>
            ${account.linkedin_key_people?.persona_id ? `<option value="${escapeAttr(account.linkedin_key_people.persona_id)}" selected>${escapeAttr(account.linkedin_key_people.persona_title || account.linkedin_key_people.persona_id)}</option>` : ""}
          </select>
          <button type="button" class="btn btn-small" id="linkedin-load-personas-btn">Load my personas</button>
        </div>
        <div class="hint" id="linkedin-personas-hint" style="margin-top:4px">Personas are Sales Navigator's own saved target-buyer profiles for your seat (Advanced Plus/Enterprise) — load them once, then pick one to search this company for people matching it.</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input type="text" id="linkedin-key-people-keywords" placeholder="Optional: title or keyword (e.g. Head of QA) — leave blank for senior/decision-maker default" value="${escapeAttr(account.linkedin_key_people?.keywords || "")}" style="flex:1" />
        </div>
        <div class="modal-actions" style="margin-top:10px;justify-content:flex-start">
          <button type="button" class="btn btn-small" id="linkedin-key-people-btn">${account.linkedin_key_people ? "Refresh key people" : "Find key people"}</button>
        </div>
      </div>

      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
        <h2 style="margin:0 0 4px 0;font-size:14px">Account IQ (AI research)</h2>
        <div class="hint" style="margin-bottom:10px">Run each one at a time — grounded in live web search, saved straight to this account.</div>
        ${ACCOUNT_IQ_FIELDS_UI.map((f) => accountIqFieldRowHtml(f, account.linkedin_sales_nav_research)).join("")}
      </div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <h2 style="margin-bottom:8px">Notes</h2>
      <textarea id="account-notes" rows="3" placeholder="Anything worth remembering about this account…">${account.notes || ""}</textarea>
      <div class="modal-actions" style="margin-top:10px">
        <button type="button" class="btn btn-small btn-primary" id="save-notes-btn">Save notes</button>
      </div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px">
      <h2 style="margin-bottom:8px">✨ AI research brief</h2>
      ${account.brief?.text ? `
        <div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${account.brief.text}</div>
        <div class="hint" style="margin-top:8px">Generated ${new Date(account.brief.generated_at).toLocaleString()} — based on account data on file, not live web research.</div>
      ` : `<div class="empty-state">No brief yet.</div>`}
      <div class="modal-actions" style="margin-top:10px">
        <button type="button" class="btn btn-small btn-primary" id="generate-brief-btn">${account.brief?.text ? "Regenerate" : "Generate brief"}</button>
      </div>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Close</button>
      <button type="button" class="btn btn-primary" id="edit-account-btn">Edit details</button>
    </div>
  `, { wide: true });

  const syncAccount = (updated) => {
    const idx = state.accounts.findIndex((a) => a.id === account.id);
    if (idx !== -1) state.accounts[idx] = updated;
    return updated;
  };

  document.getElementById("edit-account-btn").addEventListener("click", () => openAccountFormModal(account));
  document.querySelector("#account-detail-intent-badge [data-intent-score-icon]")?.addEventListener("click", () => openIntentScoreModal(account));

  document.getElementById("generate-research-btn").addEventListener("click", () => {
    const btn = document.getElementById("generate-research-btn");
    const idleLabel = account.company_research?.text ? "Regenerate (Auto Gen)" : "Auto Gen";
    btn.disabled = true;
    btn.textContent = "Researching 1/10…";
    runAccountResearch(account.id, {
      onProgress: (step, total, title) => { btn.textContent = `Researching ${step}/${total}: ${title}`; },
      onDone: (updated) => openAccountDetailModal(syncAccount(updated)),
      onSettled: () => { btn.disabled = false; btn.textContent = idleLabel; },
    });
  });

  document.getElementById("fill-tech-from-research-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("fill-tech-from-research-btn");
    btn.disabled = true;
    btn.textContent = "Reading research…";
    try {
      const { account: updated, added } = await api(`/api/accounts/${account.id}/research/extract-tech`, { method: "POST" });
      syncAccount(updated);
      const addedList = [...(added.tools || []), ...(added.saas_apps || [])];
      toast(addedList.length ? `Added to Tech stack: ${addedList.join(", ")}` : "Nothing new confirmed in the research — tags left as-is");
      openAccountDetailModal(updated);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "✨ Fill from research";
    }
  });

  document.getElementById("linkedin-search-btn").addEventListener("click", async () => {
    const btn = document.getElementById("linkedin-search-btn");
    const idleLabel = account.linkedin_profile?.text ? "Regenerate" : "LinkedIn Search";
    const url = normalizeUrlInput(document.getElementById("linkedin-search-url").value);
    if (!url) { toast("Paste a LinkedIn URL first", "error"); return; }
    btn.disabled = true;
    btn.textContent = "Searching…";
    try {
      const updated = await api(`/api/accounts/${account.id}/linkedin-research`, { method: "POST", body: { linkedin_url: url } });
      syncAccount(updated);
      toast("LinkedIn search complete");
      openAccountDetailModal(updated);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  });

  document.getElementById("linkedin-company-btn").addEventListener("click", async () => {
    const btn = document.getElementById("linkedin-company-btn");
    const idleLabel = account.linkedin_company ? "Refresh" : "Fetch profile";
    const url = normalizeUrlInput(document.getElementById("linkedin-company-url").value);
    if (!url) { toast("Paste a LinkedIn company URL first", "error"); return; }
    btn.disabled = true;
    btn.textContent = "Fetching…";
    try {
      const updated = await api(`/api/accounts/${account.id}/linkedin-company`, { method: "POST", body: { linkedin_url: url } });
      syncAccount(updated);
      toast("LinkedIn profile fetched");
      openAccountDetailModal(updated);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  });

  document.getElementById("linkedin-load-personas-btn").addEventListener("click", async () => {
    const btn = document.getElementById("linkedin-load-personas-btn");
    const select = document.getElementById("linkedin-key-people-persona");
    const hint = document.getElementById("linkedin-personas-hint");
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const { personas } = await api("/api/linkedin-search/personas");
      const current = select.value;
      select.innerHTML = `<option value="">No persona — use keyword/default below</option>` +
        personas.map((p) => `<option value="${escapeAttr(p.id)}" data-title="${escapeAttr(p.title)}">${escapeAttr(p.title)}</option>`).join("");
      if (current && personas.some((p) => p.id === current)) select.value = current;
      hint.textContent = personas.length
        ? `${personas.length} saved persona${personas.length === 1 ? "" : "s"} loaded from your Sales Navigator seat — pick one, then search.`
        : "No saved personas found on your Sales Navigator seat (needs Advanced Plus/Enterprise with personas configured) — use the keyword box below instead.";
      btn.textContent = "Reload personas";
    } catch (err) {
      toast(err.message, "error");
      hint.textContent = "Couldn't load personas — use the keyword box below instead.";
      btn.textContent = "Load my personas";
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("linkedin-key-people-btn").addEventListener("click", async () => {
    const btn = document.getElementById("linkedin-key-people-btn");
    const idleLabel = account.linkedin_key_people ? "Refresh key people" : "Find key people";
    const keywords = document.getElementById("linkedin-key-people-keywords").value.trim();
    const personaSelect = document.getElementById("linkedin-key-people-persona");
    const personaId = personaSelect.value;
    const personaTitle = personaSelect.selectedOptions[0]?.dataset.title || "";
    btn.disabled = true;
    btn.textContent = "Searching…";
    try {
      const updated = await api(`/api/accounts/${account.id}/linkedin-key-people`, { method: "POST", body: { keywords, persona_id: personaId, persona_title: personaTitle } });
      syncAccount(updated);
      const count = updated.linkedin_key_people?.people?.length || 0;
      toast(count ? `Found ${count} key people` : "No decision-makers found for this company");
      openAccountDetailModal(updated);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  });

  document.querySelectorAll("[data-account-iq-field]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const field = btn.dataset.accountIqField;
      btn.disabled = true;
      btn.textContent = "Researching…";
      try {
        const updated = await api(`/api/accounts/${account.id}/linkedin-research-field`, { method: "POST", body: { field } });
        syncAccount(updated);
        openAccountDetailModal(updated);
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "Research";
      }
    });
  });

  const accountSfBtn = document.getElementById("account-sf-push-btn");
  if (accountSfBtn) {
    accountSfBtn.addEventListener("click", async () => {
      accountSfBtn.disabled = true;
      accountSfBtn.textContent = "…";
      try {
        const updated = syncAccount(await api(`/api/accounts/${account.id}/push-salesforce`, { method: "POST" }));
        toast("Pushed to Salesforce");
        openAccountDetailModal(updated);
      } catch (err) {
        toast(err.message, "error");
        accountSfBtn.disabled = false;
        accountSfBtn.textContent = "Push";
      }
    });
  }

  document.getElementById("save-signals-btn").addEventListener("click", async () => {
    const newSignals = { ...signals };
    document.querySelectorAll("[data-signal]").forEach((el) => { newSignals[el.dataset.signal] = el.checked; });
    try {
      const updated = await api(`/api/accounts/${account.id}`, { method: "PUT", body: { signals: newSignals } });
      toast("Signals saved");
      openAccountDetailModal(syncAccount(updated));
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const wireTagAdd = (inputId, btnId, field, existing) => {
    document.getElementById(btnId).addEventListener("click", async () => {
      const input = document.getElementById(inputId);
      const val = input.value.trim();
      if (!val) return;
      try {
        const updated = await api(`/api/accounts/${account.id}`, { method: "PUT", body: { [field]: [...(existing || []), val] } });
        openAccountDetailModal(syncAccount(updated));
      } catch (err) {
        toast(err.message, "error");
      }
    });
  };
  wireTagAdd("new-tool-input", "add-tool-btn", "tools", account.tools);
  wireTagAdd("new-saas-input", "add-saas-btn", "saas_apps", account.saas_apps);

  const wireTagRemove = (selector, datasetKey, field, existing) => {
    document.querySelectorAll(selector).forEach((el) => {
      el.addEventListener("click", async () => {
        const list = (existing || []).filter((_, i) => i !== Number(el.dataset[datasetKey]));
        try {
          const updated = await api(`/api/accounts/${account.id}`, { method: "PUT", body: { [field]: list } });
          openAccountDetailModal(syncAccount(updated));
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  };
  wireTagRemove("[data-remove-tool]", "removeTool", "tools", account.tools);
  wireTagRemove("[data-remove-saas]", "removeSaas", "saas_apps", account.saas_apps);

  document.getElementById("save-notes-btn").addEventListener("click", async () => {
    const notes = document.getElementById("account-notes").value;
    try {
      const updated = await api(`/api/accounts/${account.id}`, { method: "PUT", body: { notes } });
      syncAccount(updated);
      toast("Notes saved");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  document.getElementById("generate-brief-btn").addEventListener("click", async () => {
    const btn = document.getElementById("generate-brief-btn");
    btn.disabled = true;
    btn.textContent = "Generating…";
    try {
      const updated = await api(`/api/accounts/${account.id}/brief`, { method: "POST" });
      openAccountDetailModal(syncAccount(updated));
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = account.brief?.text ? "Regenerate" : "Generate brief";
    }
  });
}

// ---------- Leave ----------

function renderLeave() {
  document.getElementById("topbar-actions").innerHTML = `<button class="btn btn-primary" id="request-leave-btn">+ Request Leave</button>`;
  document.getElementById("request-leave-btn").addEventListener("click", openLeaveRequestModal);

  const canApprove = ["manager", "hr", "admin"].includes(state.user.role);
  const myRequests = state.leaveRequests.filter((r) => r.user_id === state.user.id);
  const pendingOnMe = state.leaveRequests.filter((r) => r.current_approver_id === state.user.id);

  const root = document.getElementById("view-root");
  root.innerHTML = `
    <div class="leave-grid">
      ${state.leaveBalances.map((b) => `
        <div class="stat-card">
          <div class="label">${byId(state.leaveTypes, b.leave_type_id)?.name || "Leave"}</div>
          <div class="value accent-teal">${b.balance} days</div>
        </div>
      `).join("")}
    </div>

    ${canApprove ? `
      <div class="panel">
        <h2>Pending your approval</h2>
        ${renderApprovalTable(pendingOnMe)}
      </div>
    ` : ""}

    <div class="panel">
      <h2>My requests</h2>
      ${renderMyLeaveTable(myRequests)}
    </div>
  `;

  if (canApprove) {
    root.querySelectorAll("[data-approve]").forEach((btn) => {
      btn.addEventListener("click", () => decideLeave(btn.dataset.approve, "approve"));
    });
    root.querySelectorAll("[data-reject]").forEach((btn) => {
      btn.addEventListener("click", () => decideLeave(btn.dataset.reject, "reject"));
    });
  }
}

function renderApprovalTable(rows) {
  if (!rows.length) return `<div class="empty-state">Nothing waiting on you right now.</div>`;
  return `
    <table>
      <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Stage</th><th></th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${userName(r.user_id)}</td>
            <td>${byId(state.leaveTypes, r.leave_type_id)?.name || ""}</td>
            <td>${r.start_date} → ${r.end_date}</td>
            <td>${r.days}</td>
            <td>${r.reason || "—"}</td>
            <td><span class="pill pill-${r.status}">${r.status.replace("_", " ")}</span></td>
            <td>
              <button class="btn btn-small btn-primary" data-approve="${r.id}">Approve</button>
              <button class="btn btn-small btn-danger" data-reject="${r.id}">Reject</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderMyLeaveTable(rows) {
  if (!rows.length) return `<div class="empty-state">No leave requests yet.</div>`;
  return `
    <table>
      <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Waiting on</th></tr></thead>
      <tbody>
        ${rows.slice().reverse().map((r) => `
          <tr>
            <td>${byId(state.leaveTypes, r.leave_type_id)?.name || ""}</td>
            <td>${r.start_date} → ${r.end_date}</td>
            <td>${r.days}</td>
            <td><span class="pill pill-${r.status}">${r.status.replace("_", " ")}</span></td>
            <td>${r.current_approver_id ? userName(r.current_approver_id) : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function decideLeave(id, action) {
  let comment = "";
  if (action === "reject") comment = prompt("Reason for rejecting (optional):") || "";
  try {
    await api(`/api/leave-requests/${id}/decision`, { method: "POST", body: { action, comment } });
    toast(action === "approve" ? "Request approved" : "Request rejected");
    await loadAll();
    renderLeave();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Shows the normal success toast, then (only if a manager email should have
// gone out but didn't) a quiet follow-up toast so the person knows to
// double-check with their manager directly rather than assuming it landed.
function notifySubmitResult(created, successMsg) {
  toast(successMsg);
  const mail = created?.email_notification;
  if (mail && !mail.sent && mail.reason !== "No approver email on file") {
    setTimeout(() => toast("Heads up: the manager notification email didn't go out — you may want to follow up directly.", "error"), 1400);
  }
}

// Counts calendar days from startStr to endStr (both "YYYY-MM-DD",
// inclusive) that are NOT a Saturday, Sunday, or in the given holidays
// list. Date-only strings parse as UTC midnight in JS, so UTC day-of-week
// is used throughout to avoid local-timezone off-by-one drift.
function countBusinessDays(startStr, endStr, holidays) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const holidaySet = new Set((holidays || []).map((h) => h.date));
  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const dow = cursor.getUTCDay();
    const iso = cursor.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(iso)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function openLeaveRequestModal() {
  openModal(`
    <h2>Request leave</h2>
    <form id="leave-form">
      <label>Leave type</label>
      <select name="leave_type_id">${state.leaveTypes.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}</select>
      <label>Start date</label><input name="start_date" id="leave-start-date" type="date" required />
      <label>End date</label><input name="end_date" id="leave-end-date" type="date" required />
      <label>Days</label><input name="days" id="leave-days" type="number" min="0.5" step="0.5" required />
      <div class="hint" style="margin-top:-8px">Auto-filled from the dates above — weekends and company holidays are excluded. Adjust it yourself for a half day.</div>
      <label>Reason</label><textarea name="reason"></textarea>
      <label>CC (optional)</label>
      <input name="cc_emails" type="text" placeholder="extra.person@accelq.com, another@accelq.com" />
      <div class="hint" style="margin-top:6px">Your manager gets notified by email automatically. Add addresses here, comma-separated, to loop in anyone else.</div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Submit request</button>
      </div>
    </form>
  `);

  // Auto-fill Days from the date range so picking a single day (start ==
  // end) doesn't leave the field blank or wrong -- that's a 1-day request,
  // not 0. Counts inclusively (25th to 27th = 3 days) but walks day-by-day
  // so Saturdays, Sundays, and configured company holidays are excluded.
  // Recalculated whenever either date changes; still editable by hand
  // afterward for a half day.
  const startEl = document.getElementById("leave-start-date");
  const endEl = document.getElementById("leave-end-date");
  const daysEl = document.getElementById("leave-days");
  const recalcDays = () => {
    if (!startEl.value || !endEl.value) return;
    const count = countBusinessDays(startEl.value, endEl.value, state.holidays);
    if (count >= 0.5) daysEl.value = count;
  };
  startEl.addEventListener("change", recalcDays);
  endEl.addEventListener("change", recalcDays);

  document.getElementById("leave-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const created = await api("/api/leave-requests", { method: "POST", body: Object.fromEntries(fd) });
      notifySubmitResult(created, "Leave request submitted");
      closeModal();
      await loadAll();
      renderLeave();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------- Activity Report ----------

function canEditActivityRow(r) {
  if (state.user.role === "admin") return true;
  if (r.status === "pending" && r.user_id === state.user.id) return true;
  if (r.status === "approved" && r.current_approver_id === state.user.id) return true;
  return false;
}

// Walks backward from today (skipping Saturdays, Sundays, and configured
// company holidays -- same rule as the Leave day-count) collecting the last
// `n` business days, oldest first, for the streak strip beside the page
// title.
function lastNBusinessDays(n, holidays) {
  const holidaySet = new Set((holidays || []).map((h) => h.date));
  const out = [];
  // Use the browser's LOCAL calendar date throughout -- activity report
  // `date` values come from a plain <input type="date">, which is a naive
  // YYYY-MM-DD string with no timezone, representing the user's local
  // "today." Walking backward with UTC methods (getUTCDay/toISOString/
  // setUTCDate) anchors on the UTC calendar date instead, which can be a
  // full day behind local time for timezones ahead of UTC (e.g. IST) --
  // that mismatch was excluding today's entries from the "last 5 days"
  // window until UTC caught up. Local methods keep the window aligned with
  // what the user actually typed and sees on screen.
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  while (out.length < n) {
    const dow = cursor.getDay();
    const iso = toIso(cursor);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(iso)) out.unshift(iso);
    cursor.setDate(cursor.getDate() - 1);
  }
  return out;
}

function renderActivityStreak() {
  const days = lastNBusinessDays(5, state.holidays);
  const myDates = new Set(state.activityReports.filter((r) => r.user_id === state.user.id).map((r) => r.date));
  const doneCount = days.filter((d) => myDates.has(d)).length;
  const dayLabel = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `
    <div class="streak-strip" title="Your logged entries over the last ${days.length} workdays">
      <span class="streak-label">Last ${days.length} days</span>
      ${days.map((d) => `<div class="streak-dot ${myDates.has(d) ? "done" : "missing"}" title="${dayLabel(d)} ${d} — ${myDates.has(d) ? "logged" : "missing"}">${myDates.has(d) ? "✓" : "!"}</div>`).join("")}
      <span class="streak-count">${doneCount}/${days.length}</span>
    </div>
  `;
}

// Activity Report filters -- same module-level pattern as contactsFilters/
// accountsFilters, so choices survive the re-render every edit/approve
// triggers.
let activityFilters = { search: "", userId: "", status: "", startDate: "", endDate: "", country: "", campaign: "" };

// Row-selection state for bulk delete -- same module-level Set pattern as
// accountsSelected/contactsSelected.
let activitySelected = new Set();

function activityMatchesFilters(r, opts = {}) {
  const f = activityFilters;
  if (f.userId && String(r.user_id) !== f.userId) return false;
  if (f.status && r.status !== f.status) return false;
  if (!opts.skipDate) {
    if (f.startDate && r.date < f.startDate) return false;
    if (f.endDate && r.date > f.endDate) return false;
  }
  if (f.country && r.country !== f.country) return false;
  if (f.campaign && r.campaign !== f.campaign) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const haystack = `${r.country || ""} ${r.campaign || ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

// The tiles are a fixed "last 5 workdays" pulse, separate from whatever
// date range is picked in the filter bar above (which scopes the table) --
// so they always answer "how am I doing lately" rather than "since the
// beginning of time" or whatever wide range happens to be filtered in the
// table. Rep/status/search/country/campaign filters still narrow them (so
// scoping to one rep shows that rep's last 5 days), just not the date range.
function activitySummaryTiles(rows) {
  const sum = (field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
  const companies = sum("companies_new") + sum("companies_remapped");
  const emails = sum("emails_fresh") + sum("emails_followups");
  const linkedin = sum("linkedin_connections");
  const responses = sum("responses_cold") + sum("responses_negative") + sum("responses_warm") + sum("responses_prospect");
  return `
    <div class="tiles-heading">Last 5 days</div>
    <div class="activity-tiles">
      <div class="activity-tile tile-mapped"><div class="tile-label">Companies mapped</div><div class="tile-value">${companies}</div></div>
      <div class="activity-tile tile-emails"><div class="tile-label">Emails sent</div><div class="tile-value">${emails}</div></div>
      <div class="activity-tile tile-linkedin"><div class="tile-label">LinkedIn</div><div class="tile-value">${linkedin}</div></div>
      <div class="activity-tile tile-responses"><div class="tile-label">Responses</div><div class="tile-value">${responses}</div></div>
    </div>
  `;
}

function renderActivity() {
  document.getElementById("topbar-actions").innerHTML = `
    <button class="btn" id="pull-report-btn">Pull report</button>
    <button class="btn btn-primary" id="new-activity-btn">+ New Entry</button>
  `;
  document.getElementById("view-title-extra").innerHTML = renderActivityStreak();
  document.getElementById("new-activity-btn").addEventListener("click", () => openActivityFormModal());
  document.getElementById("pull-report-btn").addEventListener("click", () => openPullReportModal());

  const root = document.getElementById("view-root");
  const filtered = state.activityReports.filter(activityMatchesFilters);
  const filtersActive = Boolean(activityFilters.search || activityFilters.userId || activityFilters.status || activityFilters.startDate || activityFilters.endDate || activityFilters.country || activityFilters.campaign);
  const rows = filtered.slice().sort((a, b) => (a.date < b.date ? 1 : -1));

  const last5Days = new Set(lastNBusinessDays(5, state.holidays));
  const tileRows = state.activityReports.filter((r) => last5Days.has(r.date) && activityMatchesFilters(r, { skipDate: true }));

  const canDelete = ["admin", "manager"].includes(state.user.role);
  const validIds = new Set(rows.map((r) => r.id));
  Array.from(activitySelected).forEach((id) => { if (!validIds.has(id)) activitySelected.delete(id); });
  const allSelected = rows.length > 0 && rows.every((r) => activitySelected.has(r.id));

  root.innerHTML = `
    <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 20px">
      <input type="text" id="activity-filter-search" placeholder="Search country, campaign…" value="${escapeAttr(activityFilters.search)}" style="flex:1;min-width:180px" />
      <select id="activity-filter-user" style="width:auto">
        <option value="">SDR</option>
        ${state.users.slice().sort((a, b) => a.name.localeCompare(b.name)).map((u) => `<option value="${u.id}" ${activityFilters.userId === String(u.id) ? "selected" : ""}>${u.name}</option>`).join("")}
      </select>
      <select id="activity-filter-status" style="width:auto">
        <option value="">Status</option>
        ${["pending", "approved", "rejected"].map((s) => `<option value="${s}" ${activityFilters.status === s ? "selected" : ""}>${s[0].toUpperCase()}${s.slice(1)}</option>`).join("")}
      </select>
      <input type="date" id="activity-filter-start" value="${activityFilters.startDate}" style="width:auto" />
      <span style="font-size:12px;color:var(--text-dim)">to</span>
      <input type="date" id="activity-filter-end" value="${activityFilters.endDate}" style="width:auto" />
      ${filtersActive ? `<button type="button" class="btn btn-small" id="activity-filter-clear-btn">Clear filters</button>` : ""}
      <span style="font-size:12px;color:var(--text-dim);margin-left:auto">${rows.length} of ${state.activityReports.length} entries</span>
    </div>

    ${activitySummaryTiles(tileRows)}

    ${canDelete && activitySelected.size ? `
      <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px">
        <span style="font-size:13px;font-weight:600">${activitySelected.size} selected</span>
        <button type="button" class="btn btn-small" id="activity-bulk-clear-btn">Clear selection</button>
        <button type="button" class="btn btn-small btn-danger" id="activity-bulk-delete-btn" title="Delete selected" aria-label="Delete selected" style="margin-left:auto">🗑</button>
      </div>
    ` : ""}

    <div class="panel">
      <div class="table-scroll activity-table">
        <table>
          <thead>
            <tr>
              ${canDelete ? `<th rowspan="2" style="width:34px"><input type="checkbox" id="activity-select-all" ${allSelected ? "checked" : ""} /></th>` : ""}
              <th rowspan="2" class="sticky-col1">Date</th>
              <th rowspan="2" class="sticky-col2">Country</th>
              <th colspan="3" class="group group-mapped">Companies mapped</th>
              <th colspan="4" class="group group-emails">Emails sent</th>
              <th rowspan="2" class="group group-linkedin">LinkedIn<br/><span style="font-weight:400">(target 15/day)</span></th>
              <th rowspan="2">Campaign</th>
              <th colspan="4" class="group group-responses">Responses</th>
              <th rowspan="2">Status</th>
              <th rowspan="2"></th>
            </tr>
            <tr>
              <th class="subhead subhead-mapped">New</th><th class="subhead subhead-mapped">Remapped</th><th class="subhead subhead-mapped">Total contacts</th>
              <th class="subhead subhead-emails">Fresh</th><th class="subhead subhead-emails">Reach</th><th class="subhead subhead-emails">Follow ups</th><th class="subhead subhead-emails">Reach</th>
              <th class="subhead subhead-responses">Cold</th><th class="subhead subhead-responses">Negative</th><th class="subhead subhead-responses">Warm</th><th class="subhead subhead-responses">Prospect</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                ${canDelete ? `<td><input type="checkbox" data-activity-select="${r.id}" ${activitySelected.has(r.id) ? "checked" : ""} /></td>` : ""}
                <td class="sticky-col1">${r.date}</td>
                <td class="sticky-col2">${r.country || "—"}</td>
                <td class="num">${r.companies_new}</td>
                <td class="num">${r.companies_remapped}</td>
                <td class="num">${r.contacts_total_added}</td>
                <td class="num">${r.emails_fresh}</td>
                <td class="num">${r.emails_fresh_reach}</td>
                <td class="num">${r.emails_followups}</td>
                <td class="num">${r.emails_followups_reach}</td>
                <td class="num">${r.linkedin_connections}</td>
                <td>${r.campaign || "—"}</td>
                <td class="num">${r.responses_cold}</td>
                <td class="num">${r.responses_negative}</td>
                <td class="num">${r.responses_warm}</td>
                <td class="num">${r.responses_prospect}</td>
                <td><span class="pill pill-${r.status}">${r.status}</span> <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${userName(r.user_id)}</div></td>
                <td>
                  ${canEditActivityRow(r) ? `<button class="btn btn-small" data-edit="${r.id}">Edit</button>` : ""}
                  ${r.status === "pending" && r.current_approver_id === state.user.id ? `<button class="btn btn-small btn-primary" data-approve-activity="${r.id}">Approve</button>` : ""}
                </td>
              </tr>
            `).join("") || `<tr><td colspan="${canDelete ? 17 : 16}" class="empty-state">${filtersActive ? "No entries match these filters." : "No entries yet."}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  const searchEl = document.getElementById("activity-filter-search");
  searchEl.addEventListener("input", (e) => {
    activityFilters.search = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderActivity();
    const newSearchEl = document.getElementById("activity-filter-search");
    if (newSearchEl) {
      newSearchEl.focus();
      newSearchEl.setSelectionRange(cursorPos, cursorPos);
    }
  });
  document.getElementById("activity-filter-user").addEventListener("change", (e) => {
    activityFilters.userId = e.target.value;
    renderActivity();
  });
  document.getElementById("activity-filter-status").addEventListener("change", (e) => {
    activityFilters.status = e.target.value;
    renderActivity();
  });
  document.getElementById("activity-filter-start").addEventListener("change", (e) => {
    activityFilters.startDate = e.target.value;
    renderActivity();
  });
  document.getElementById("activity-filter-end").addEventListener("change", (e) => {
    activityFilters.endDate = e.target.value;
    renderActivity();
  });
  const clearBtn = document.getElementById("activity-filter-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      activityFilters = { search: "", userId: "", status: "", startDate: "", endDate: "", country: "", campaign: "" };
      renderActivity();
    });
  }

  root.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = byId(state.activityReports, btn.dataset.edit);
      openActivityFormModal(row);
    });
  });
  root.querySelectorAll("[data-approve-activity]").forEach((btn) => {
    btn.addEventListener("click", () => approveActivity(btn.dataset.approveActivity));
  });

  const selectAllEl = document.getElementById("activity-select-all");
  if (selectAllEl) {
    selectAllEl.addEventListener("change", (e) => {
      if (e.target.checked) rows.forEach((r) => activitySelected.add(r.id));
      else rows.forEach((r) => activitySelected.delete(r.id));
      renderActivity();
    });
  }

  root.querySelectorAll("[data-activity-select]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(cb.dataset.activitySelect);
      if (e.target.checked) activitySelected.add(id);
      else activitySelected.delete(id);
      renderActivity();
    });
  });

  const bulkClearBtn = document.getElementById("activity-bulk-clear-btn");
  if (bulkClearBtn) bulkClearBtn.addEventListener("click", () => { activitySelected.clear(); renderActivity(); });

  const bulkDeleteBtn = document.getElementById("activity-bulk-delete-btn");
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener("click", async () => {
      const ids = Array.from(activitySelected);
      if (!confirm(`Delete ${ids.length} entr${ids.length === 1 ? "y" : "ies"}? This can't be undone.`)) return;
      bulkDeleteBtn.disabled = true;
      bulkDeleteBtn.textContent = "⏳";
      try {
        await Promise.all(ids.map((id) => api(`/api/activity-reports/${id}`, { method: "DELETE" })));
        state.activityReports = state.activityReports.filter((r) => !ids.includes(r.id));
        activitySelected.clear();
        toast(`Deleted ${ids.length} entr${ids.length === 1 ? "y" : "ies"}`);
        renderActivity();
      } catch (err) {
        toast(err.message, "error");
        bulkDeleteBtn.disabled = false;
        bulkDeleteBtn.textContent = "🗑";
      }
    });
  }
}

// -- Pull report: a small builder so a user can scope a report by rep/date
// range/country/campaign, then either view it applied to the table above
// or export that exact slice straight to CSV without touching the table.
function exportActivityCsv(rows) {
  if (!rows.length) { toast("No entries to export", "error"); return; }
  const headers = [
    "Date", "Country", "New companies", "Remapped companies", "Total contacts",
    "Emails fresh", "Emails fresh reach", "Follow ups", "Follow ups reach",
    "LinkedIn connections", "Campaign", "Cold", "Negative", "Warm", "Prospect", "Status", "Rep",
  ];
  const lines = [headers.join(",")];
  rows.forEach((r) => {
    lines.push([
      r.date, r.country, r.companies_new, r.companies_remapped, r.contacts_total_added,
      r.emails_fresh, r.emails_fresh_reach, r.emails_followups, r.emails_followups_reach,
      r.linkedin_connections, r.campaign, r.responses_cold, r.responses_negative, r.responses_warm, r.responses_prospect,
      r.status, userName(r.user_id),
    ].map(csvEscape).join(","));
  });
  downloadFile(`activity-report-${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\n"), "text/csv;charset=utf-8;");
  toast(`Exported ${rows.length} entr${rows.length === 1 ? "y" : "ies"}`);
}

// Same rows/columns as exportActivityCsv above, but a real .xlsx with
// Calibri 11 on every cell.
async function exportActivityXlsx(rows) {
  if (!rows.length) { toast("No entries to export", "error"); return; }
  const headers = [
    "Date", "Country", "New companies", "Remapped companies", "Total contacts",
    "Emails fresh", "Emails fresh reach", "Follow ups", "Follow ups reach",
    "LinkedIn connections", "Campaign", "Cold", "Negative", "Warm", "Prospect", "Status", "Rep",
  ];
  const dataRows = rows.map((r) => [
    r.date, r.country, r.companies_new, r.companies_remapped, r.contacts_total_added,
    r.emails_fresh, r.emails_fresh_reach, r.emails_followups, r.emails_followups_reach,
    r.linkedin_connections, r.campaign, r.responses_cold, r.responses_negative, r.responses_warm, r.responses_prospect,
    r.status, userName(r.user_id),
  ]);
  try {
    await exportXlsx(`activity-report-${new Date().toISOString().slice(0, 10)}.xlsx`, "Activity Report", headers, dataRows);
    toast(`Exported ${rows.length} entr${rows.length === 1 ? "y" : "ies"} (Excel)`);
  } catch (err) {
    toast(err.message, "error");
  }
}

function openPullReportModal() {
  const countries = Array.from(new Set(state.activityReports.map((r) => r.country).filter(Boolean))).sort();
  const campaigns = Array.from(new Set(state.activityReports.map((r) => r.campaign).filter(Boolean))).sort();
  openModal(`
    <h2>Pull report</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Choose what to include, then view it on the page or export it.</div>
    <label>Rep</label>
    <select id="pr-user">
      <option value="">Everyone</option>
      ${state.users.slice().sort((a, b) => a.name.localeCompare(b.name)).map((u) => `<option value="${u.id}">${u.name}</option>`).join("")}
    </select>
    <label style="margin-top:10px">Date range</label>
    <div style="display:flex;gap:8px">
      <input type="date" id="pr-start" style="flex:1" />
      <input type="date" id="pr-end" style="flex:1" />
    </div>
    <label style="margin-top:10px">Country</label>
    <select id="pr-country">
      <option value="">All countries</option>
      ${countries.map((c) => `<option value="${c}">${c}</option>`).join("")}
    </select>
    <label style="margin-top:10px">Campaign</label>
    <select id="pr-campaign">
      <option value="">All campaigns</option>
      ${campaigns.map((c) => `<option value="${c}">${c}</option>`).join("")}
    </select>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn" id="pr-view-btn">View on page</button>
      <button type="button" class="btn" id="pr-export-btn">Export CSV</button>
      <button type="button" class="btn btn-primary" id="pr-export-xlsx-btn">Export XLSX</button>
    </div>
  `);

  const collect = () => {
    const userId = document.getElementById("pr-user").value;
    const startDate = document.getElementById("pr-start").value;
    const endDate = document.getElementById("pr-end").value;
    const country = document.getElementById("pr-country").value;
    const campaign = document.getElementById("pr-campaign").value;
    return { userId, startDate, endDate, country, campaign };
  };

  document.getElementById("pr-view-btn").addEventListener("click", () => {
    const { userId, startDate, endDate, country, campaign } = collect();
    activityFilters = { search: "", userId, status: "", startDate, endDate, country, campaign };
    closeModal();
    renderActivity();
  });

  document.getElementById("pr-export-btn").addEventListener("click", () => {
    const { userId, startDate, endDate, country, campaign } = collect();
    const rows = state.activityReports.filter((r) => {
      if (userId && String(r.user_id) !== userId) return false;
      if (startDate && r.date < startDate) return false;
      if (endDate && r.date > endDate) return false;
      if (country && r.country !== country) return false;
      if (campaign && r.campaign !== campaign) return false;
      return true;
    });
    exportActivityCsv(rows);
    closeModal();
  });

  document.getElementById("pr-export-xlsx-btn").addEventListener("click", () => {
    const { userId, startDate, endDate, country, campaign } = collect();
    const rows = state.activityReports.filter((r) => {
      if (userId && String(r.user_id) !== userId) return false;
      if (startDate && r.date < startDate) return false;
      if (endDate && r.date > endDate) return false;
      if (country && r.country !== country) return false;
      if (campaign && r.campaign !== campaign) return false;
      return true;
    });
    exportActivityXlsx(rows);
    closeModal();
  });
}

async function approveActivity(id) {
  try {
    await api(`/api/activity-reports/${id}/approve`, { method: "POST" });
    toast("Entry approved — now editable by you only");
    await loadAll();
    renderActivity();
  } catch (err) {
    toast(err.message, "error");
  }
}

function openActivityFormModal(existing) {
  const v = existing || {
    date: new Date().toISOString().slice(0, 10), country: "", campaign: "",
    companies_new: 0, companies_remapped: 0, contacts_total_added: 0,
    emails_fresh: 0, emails_fresh_reach: 0, emails_followups: 0, emails_followups_reach: 0,
    linkedin_connections: 0,
    responses_cold: 0, responses_negative: 0, responses_warm: 0, responses_prospect: 0,
  };
  const num = (name, label) => `<label>${label}</label><input name="${name}" type="number" min="0" value="${v[name]}" />`;

  openModal(`
    <h2>${existing ? "Edit" : "New"} activity entry</h2>
    <form id="activity-form">
      <label>Date</label><input name="date" type="date" value="${v.date}" required />
      <label>Country</label><input name="country" value="${v.country}" placeholder="e.g. Africa, India Captive PST,MST" />

      <div class="panel" style="margin:14px 0 0;padding:12px">
        <h2 style="margin-bottom:10px">Companies mapped</h2>
        ${num("companies_new", "New")}
        ${num("companies_remapped", "Remapped")}
        ${num("contacts_total_added", "Total contacts added")}
      </div>

      <div class="panel" style="margin:14px 0 0;padding:12px">
        <h2 style="margin-bottom:10px">Emails sent</h2>
        ${num("emails_fresh", "Fresh")}
        ${num("emails_fresh_reach", "Reach (fresh)")}
        ${num("emails_followups", "Follow ups")}
        ${num("emails_followups_reach", "Reach (follow ups)")}
      </div>

      ${num("linkedin_connections", "LinkedIn connections (target 15/day)")}
      <label>Campaign</label><input name="campaign" value="${v.campaign}" />

      <div class="panel" style="margin:14px 0 0;padding:12px">
        <h2 style="margin-bottom:10px">Responses</h2>
        ${num("responses_cold", "Cold")}
        ${num("responses_negative", "Negative")}
        ${num("responses_warm", "Warm")}
        ${num("responses_prospect", "Prospect")}
      </div>

      ${!existing ? `
        <label>CC (optional)</label>
        <input name="cc_emails" type="text" placeholder="extra.person@accelq.com, another@accelq.com" />
        <div class="hint" style="margin-top:6px">Your manager gets notified by email automatically. Add addresses here, comma-separated, to loop in anyone else.</div>
      ` : ""}

      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${existing ? "Save changes" : "Submit entry"}</button>
      </div>
    </form>
  `);

  document.getElementById("activity-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      if (existing) {
        await api(`/api/activity-reports/${existing.id}`, { method: "PUT", body: Object.fromEntries(fd) });
        toast("Entry updated");
      } else {
        const created = await api("/api/activity-reports", { method: "POST", body: Object.fromEntries(fd) });
        notifySubmitResult(created, "Entry submitted for approval");
      }
      closeModal();
      await loadAll();
      renderActivity();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------- Settings ----------

let settingsTab = "appearance";

function renderSettings() {
  document.getElementById("topbar-actions").innerHTML = "";
  const root = document.getElementById("view-root");
  const isAdmin = state.user.role === "admin";
  // "Users" used to be admin-only (it was just an org-wide directory/admin
  // console). Now every role has a real reason to be on it -- a rep views
  // their own profile, a manager manages their direct reports -- so only
  // Integrations, Access Control, and Holidays stay admin-only. Integrations
  // holds every AI/Apollo/Outlook-app/Salesforce API key for the org, so
  // it's not just gated server-side (non-admins already got a generic
  // placeholder there instead of real data) -- the tab itself is hidden so
  // a non-admin never even sees that this configuration exists.
  if ((settingsTab === "holidays" || settingsTab === "access" || settingsTab === "integrations") && !isAdmin) settingsTab = "appearance";
  root.innerHTML = `
    <div class="settings-tabs">
      <div class="settings-tab ${settingsTab === "appearance" ? "active" : ""}" data-tab="appearance">Appearance</div>
      ${isAdmin ? `<div class="settings-tab ${settingsTab === "integrations" ? "active" : ""}" data-tab="integrations">Integrations</div>` : ""}
      <div class="settings-tab ${settingsTab === "users" ? "active" : ""}" data-tab="users">${isAdmin ? "Users" : state.user.role === "manager" ? "My Team" : "My Profile"}</div>
      ${isAdmin ? `<div class="settings-tab ${settingsTab === "access" ? "active" : ""}" data-tab="access">Access Control</div>` : ""}
      ${isAdmin ? `<div class="settings-tab ${settingsTab === "holidays" ? "active" : ""}" data-tab="holidays">Holidays</div>` : ""}
    </div>
    <div id="settings-body"></div>
  `;
  root.querySelectorAll(".settings-tab").forEach((el) => {
    el.addEventListener("click", () => {
      settingsTab = el.dataset.tab;
      renderSettings();
    });
  });
  if (settingsTab === "appearance") renderAppearanceSettings();
  else if (settingsTab === "users") renderUsersSettings();
  else if (settingsTab === "access" && isAdmin) renderAccessControlSettings();
  else if (settingsTab === "holidays" && isAdmin) renderHolidaysSettings();
  else renderIntegrationSettings();
}

// ---------- Settings > Users (admin) ----------
// The only place new logins get created now -- there's no self-serve signup,
// so an admin sets a name/email/role/initial password here, same as every
// seeded demo account had a password set once at build time. Password reset
// is a separate action so it always needs its own explicit new value.
function generatePassword() {
  // Not trying to be a security product -- just long and varied enough that
  // "trellis123 for everyone" isn't the only option going forward, and easy
  // to read/type back if the admin is handing it over verbally.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out + "!" + Math.floor(Math.random() * 90 + 10);
}

// Three-tier entry point. Admin gets the full org directory (unchanged
// behavior) plus the new Field Permissions panel; Manager gets a table
// scoped to themselves + direct reports with edit rights gated by that
// panel's settings; everyone else gets a single self-profile card. All
// three pull from GET /api/users/team (server-scoped -- the frontend branch
// below is just which UI to draw, not the access-control boundary itself)
// plus GET /api/users (full directory, needed to resolve "Reports to" names
// and to populate the Reports-to picker for Admin) and the shared field
// permission matrix.
async function renderUsersSettings() {
  const body = document.getElementById("settings-body");
  body.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  let teamUsers, allUsers, perms;
  try {
    [teamUsers, allUsers, perms] = await Promise.all([
      api("/api/users/team"),
      api("/api/users"),
      api("/api/field-permissions"),
    ]);
    state.users = allUsers;
  } catch (err) {
    body.innerHTML = `<div class="panel"><div class="empty-state">${err.message}</div></div>`;
    return;
  }
  if (state.user.role === "admin") renderUsersAdminView(body, teamUsers, allUsers, perms);
  else if (state.user.role === "manager") renderUsersManagerView(body, teamUsers, allUsers, perms);
  else renderUsersSelfView(body, teamUsers[0] || state.user, perms);
}

function renderUsersAdminView(body, users, allUsers, perms) {
  body.innerHTML = `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h2 style="margin:0">Users</h2>
        <button class="btn btn-primary" id="new-user-btn">+ New User</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Title</th><th>Role</th><th>Reports to</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td>${u.name}</td>
                <td>${u.email}</td>
                <td>${u.title || "—"}</td>
                <td>${roleLabel(u.role)}</td>
                <td>${u.manager_id ? userName(u.manager_id) : "—"}</td>
                <td style="white-space:nowrap">
                  <button type="button" class="btn btn-small" data-edit-user="${u.id}">Edit</button>
                  <button type="button" class="btn btn-small" data-reset-password="${u.id}">Reset password</button>
                  ${u.id !== state.user.id ? `<button type="button" class="btn btn-small btn-danger" data-delete-user="${u.id}" title="Delete user" aria-label="Delete user">🗑</button>` : ""}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
    ${fieldPermissionsPanelHtml(perms)}
  `;
  document.getElementById("new-user-btn").addEventListener("click", openNewUserModal);
  body.querySelectorAll("[data-edit-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = users.find((x) => x.id === Number(btn.dataset.editUser));
      openEditUserModal(u); // no fieldPerms arg -- Admin always gets every field, editable
    });
  });
  body.querySelectorAll("[data-reset-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = users.find((x) => x.id === Number(btn.dataset.resetPassword));
      openResetPasswordModal(u);
    });
  });
  body.querySelectorAll("[data-delete-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = users.find((x) => x.id === Number(btn.dataset.deleteUser));
      openDeleteUserModal(u);
    });
  });
  wireFieldPermissionsPanel(body, perms);
}

// Manager: sees themselves + whoever has them as "Reports to" (that's what
// GET /api/users/team already scoped for us). No "+ New User" or password
// reset here -- creating logins and resetting credentials stay Admin-only
// actions regardless of the field-permission matrix, which only governs
// profile *fields*, not account-creation/security actions.
function renderUsersManagerView(body, users, allUsers, perms) {
  const mine = perms.manager;
  body.innerHTML = `
    <div class="panel">
      <h2 style="margin:0 0 4px">My team</h2>
      <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">You and everyone who reports to you. What you can edit here is set by your Admin.</div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Title</th><th>Role</th><th>Reports to</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td>${u.name}${u.id === state.user.id ? ' <span class="tag-role">You</span>' : ""}</td>
                <td>${u.email}</td>
                <td>${u.title || "—"}</td>
                <td>${roleLabel(u.role)}</td>
                <td>${u.manager_id ? userName(u.manager_id) : "—"}</td>
                <td style="white-space:nowrap">
                  <button type="button" class="btn btn-small" data-edit-user="${u.id}">${Object.values(mine).includes("edit") ? "Edit" : "View"}</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
  body.querySelectorAll("[data-edit-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = users.find((x) => x.id === Number(btn.dataset.editUser));
      openEditUserModal(u, mine);
    });
  });
}

// Everyone else: a single card for their own record, no table (there's
// nothing else they're allowed to see). Editable fields render as real
// inputs; view-only fields render as plain text -- same permission matrix
// the backend enforces on PUT /api/users/:id, so nothing shown here as
// "editable" can actually fail server-side, and nothing hidden here was
// ever fetchable another way.
function renderUsersSelfView(body, u, perms) {
  const mine = perms.user;
  const readOnlyBox = (value) => `<div class="hint" style="margin:4px 0 0;padding:10px 12px;background:var(--panel-2);border-radius:8px;color:var(--text)">${value || "—"}</div>`;
  const textField = (key, label, value) => {
    const level = mine[key];
    if (level === "none") return "";
    if (level === "edit") return `<label style="margin-top:10px">${label}</label><input type="text" id="my-${key}" value="${escapeAttr(value || "")}" />`;
    return `<label style="margin-top:10px">${label}</label>${readOnlyBox(escapeAttr(value))}`;
  };
  const roleField = () => {
    const level = mine.role;
    if (level === "none") return "";
    if (level === "view") return `<label style="margin-top:10px">Role</label>${readOnlyBox(roleLabel(u.role))}`;
    // Even if an Admin opens up "role" to self-edit, self-granting Admin is
    // never offered here -- same hard rule PUT /api/users/:id enforces.
    const options = ["sales_rep", "manager", "hr"];
    return `<label style="margin-top:10px">Role</label><select id="my-role">${options.map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${roleLabel(r)}</option>`).join("")}</select>`;
  };
  const managerField = () => {
    const level = mine.manager_id;
    if (level === "none") return "";
    if (level === "view") return `<label style="margin-top:10px">Reports to</label>${readOnlyBox(u.manager_id ? escapeAttr(userName(u.manager_id)) : "—")}`;
    return `<label style="margin-top:10px">Reports to</label><select id="my-manager_id">${managerOptionsHtml(state.users, u.id, u.manager_id)}</select>`;
  };
  const anyEditable = Object.values(mine).includes("edit");
  body.innerHTML = `
    <div class="panel" style="max-width:480px">
      <h2 style="margin:0 0 4px">My profile</h2>
      <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">What you can change here is set by your Admin. For anything else, ask your Manager or Admin.</div>
      ${textField("name", "Name", u.name)}
      ${textField("email", "Email", u.email)}
      ${textField("title", "Title", u.title)}
      ${textField("phone", "Phone", u.phone)}
      ${roleField()}
      ${managerField()}
      ${anyEditable ? `<div class="modal-actions" style="margin-top:18px"><button type="button" class="btn btn-primary" id="my-save-btn">Save changes</button></div>` : ""}
    </div>
  `;
  const saveBtn = document.getElementById("my-save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const patch = {};
      for (const key of Object.keys(mine)) {
        if (mine[key] !== "edit") continue;
        const el = document.getElementById(`my-${key}`);
        if (!el) continue;
        patch[key] = key === "manager_id" ? (el.value || null) : el.value.trim();
      }
      saveBtn.disabled = true;
      try {
        const updated = await api(`/api/users/${u.id}`, { method: "PUT", body: patch });
        state.user = { ...state.user, ...updated };
        toast("Profile updated");
        renderUsersSettings();
      } catch (err) {
        toast(err.message, "error");
        saveBtn.disabled = false;
      }
    });
  }
}

// ---------- Field Permissions panel (Admin only) ----------
// "What can a Manager/User see or edit on a user profile" -- three levels
// per field: hidden entirely, visible but read-only, or editable. This is
// the config that both renderUsersManagerView/renderUsersSelfView above and
// the PUT /api/users/:id route on the server key off of, so a change here
// takes effect everywhere at once, not just in this table's own UI.
const FIELD_PERMISSION_LABELS = [
  ["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["title", "Title"],
  ["manager_id", "Reports to"], ["role", "Role"],
];

function fieldPermissionsPanelHtml(perms) {
  return `
    <div class="panel">
      <h2 style="margin:0 0 4px">Field permissions</h2>
      <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">Controls what a Manager can see/edit on their direct reports, and what anyone else can see/edit on their own profile. You (Admin) always have full access to everything, everywhere — this doesn't affect you.</div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Field</th><th>Manager</th><th>User</th></tr></thead>
          <tbody>
            ${FIELD_PERMISSION_LABELS.map(([key, label]) => `
              <tr>
                <td>${label}</td>
                <td><select data-perm-tier="manager" data-perm-field="${key}">
                  ${["none", "view", "edit"].map((lvl) => `<option value="${lvl}" ${perms.manager[key] === lvl ? "selected" : ""}>${lvl === "none" ? "Hidden" : lvl === "view" ? "View only" : "Can edit"}</option>`).join("")}
                </select></td>
                <td><select data-perm-tier="user" data-perm-field="${key}">
                  ${["none", "view", "edit"].map((lvl) => `<option value="${lvl}" ${perms.user[key] === lvl ? "selected" : ""}>${lvl === "none" ? "Hidden" : lvl === "view" ? "View only" : "Can edit"}</option>`).join("")}
                </select></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="modal-actions" style="margin-top:16px;margin-left:0">
        <button type="button" class="btn btn-primary" id="save-field-perms-btn">Save permissions</button>
      </div>
    </div>
  `;
}

function wireFieldPermissionsPanel(body) {
  const saveBtn = document.getElementById("save-field-perms-btn");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", async () => {
    const next = { manager: {}, user: {} };
    body.querySelectorAll("[data-perm-tier]").forEach((sel) => {
      next[sel.dataset.permTier][sel.dataset.permField] = sel.value;
    });
    saveBtn.disabled = true;
    try {
      await api("/api/field-permissions", { method: "PUT", body: next });
      toast("Field permissions saved");
      renderUsersSettings();
    } catch (err) {
      toast(err.message, "error");
      saveBtn.disabled = false;
    }
  });
}

function managerOptionsHtml(users, excludeId, selectedId) {
  // Every other user is a valid "Reports to" pick -- including admins (an
  // org's admin can absolutely have their own manager) and reps (a small
  // team may have a lead who isn't formally a "manager" role). This used to
  // filter down to role === admin/manager only, which silently hid every
  // rep/HR/sub-admin user from the list -- with a small admin-only org that
  // can look like "the dropdown only shows one person." The one exclusion
  // that's still a real rule: a user can't report to themselves.
  const candidates = users
    .filter((u) => u.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name));
  return `
    <option value="">— None —</option>
    ${candidates.map((m) => `<option value="${m.id}" ${selectedId === m.id ? "selected" : ""}>${m.name}</option>`).join("")}
  `;
}

function openNewUserModal() {
  const users = state.users;
  let pwVisible = true;
  openModal(`
    <h2>New user</h2>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Sets a login they can use right away — share the password with them yourself once it's created.</div>
    <label>Name</label>
    <input type="text" id="nu-name" placeholder="Full name" />
    <label style="margin-top:10px">Email</label>
    <input type="email" id="nu-email" placeholder="name@accelq.com" />
    <label style="margin-top:10px">Title</label>
    <input type="text" id="nu-title" placeholder="e.g. Account Executive" />
    <label style="margin-top:10px">Phone</label>
    <input type="text" id="nu-phone" placeholder="Optional" />
    <label style="margin-top:10px">Role</label>
    <select id="nu-role">
      ${["sales_rep", "manager", "sub_admin", "admin", "hr"].map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join("")}
    </select>
    <label style="margin-top:10px">Reports to</label>
    <select id="nu-manager">${managerOptionsHtml(users, null, null)}</select>
    <label style="margin-top:10px">Password</label>
    <div style="display:flex;gap:8px">
      <input type="text" id="nu-password" placeholder="At least 6 characters" style="flex:1" value="${generatePassword()}" />
      <button type="button" class="btn" id="nu-generate-btn">Generate</button>
    </div>
    <div class="hint">Shown in plain text so you can copy it — this app has no email-invite flow yet.</div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="nu-save-btn">Create user</button>
    </div>
  `);

  document.getElementById("nu-generate-btn").addEventListener("click", () => {
    document.getElementById("nu-password").value = generatePassword();
  });

  document.getElementById("nu-save-btn").addEventListener("click", async () => {
    const name = document.getElementById("nu-name").value.trim();
    const email = document.getElementById("nu-email").value.trim();
    const title = document.getElementById("nu-title").value.trim();
    const phone = document.getElementById("nu-phone").value.trim();
    const role = document.getElementById("nu-role").value;
    const manager_id = document.getElementById("nu-manager").value || null;
    const password = document.getElementById("nu-password").value;
    if (!name || !email || !password) {
      toast("Name, email, and password are required", "error");
      return;
    }
    const btn = document.getElementById("nu-save-btn");
    btn.disabled = true;
    try {
      await api("/api/users", { method: "POST", body: { name, email, title, phone, role, manager_id, password } });
      toast(`User created — password: ${password}`);
      closeModal();
      renderUsersSettings();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// `fieldPerms` is the caller's tier row from the field-permission matrix
// (e.g. perms.manager) -- omitted entirely for the Admin path above, which
// keeps its old behavior of every field being a live, editable input. When
// present, a "none" field is left out of the form altogether, "view" renders
// read-only text, and only "edit" fields become real inputs and get sent on
// save (matching exactly what the server will accept -- see PUT
// /api/users/:id's own allowedFields check).
function openEditUserModal(u, fieldPerms) {
  const users = state.users;
  const level = (key) => (fieldPerms ? fieldPerms[key] : "edit");
  const textField = (id, label, value, type = "text") => {
    const lvl = level(id.replace("eu-", ""));
    if (lvl === "none") return "";
    if (lvl === "view") {
      return `<label style="margin-top:10px">${label}</label><div class="hint" style="margin:4px 0 0;padding:10px 12px;background:var(--panel-2);border-radius:8px;color:var(--text)">${escapeAttr(value) || "—"}</div>`;
    }
    return `<label style="margin-top:10px">${label}</label><input type="${type}" id="${id}" value="${escapeAttr(value || "")}" />`;
  };
  const roleField = () => {
    const lvl = level("role");
    if (lvl === "none") return "";
    if (lvl === "view") {
      return `<label style="margin-top:10px">Role</label><div class="hint" style="margin:4px 0 0;padding:10px 12px;background:var(--panel-2);border-radius:8px;color:var(--text)">${roleLabel(u.role)}</div>`;
    }
    // A non-admin editor who's been given "edit" on role still can't grant
    // Admin -- the same rule PUT /api/users/:id enforces server-side, kept
    // in sync here so the option isn't offered only to be rejected on save.
    const options = fieldPerms ? ["sales_rep", "manager", "hr"] : ["sales_rep", "manager", "admin", "hr"];
    return `<label style="margin-top:10px">Role</label><select id="eu-role">${options.map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${roleLabel(r)}</option>`).join("")}</select>`;
  };
  const managerField = () => {
    const lvl = level("manager_id");
    if (lvl === "none") return "";
    if (lvl === "view") {
      return `<label style="margin-top:10px">Reports to</label><div class="hint" style="margin:4px 0 0;padding:10px 12px;background:var(--panel-2);border-radius:8px;color:var(--text)">${u.manager_id ? escapeAttr(userName(u.manager_id)) : "—"}</div>`;
    }
    return `<label style="margin-top:10px">Reports to</label><select id="eu-manager">${managerOptionsHtml(users, u.id, u.manager_id)}</select>`;
  };
  openModal(`
    <h2>Edit user</h2>
    ${textField("eu-name", "Name", u.name)}
    ${textField("eu-email", "Email", u.email, "email")}
    ${textField("eu-title", "Title", u.title)}
    ${textField("eu-phone", "Phone", u.phone)}
    ${roleField()}
    ${managerField()}
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="eu-save-btn">Save changes</button>
    </div>
  `);

  document.getElementById("eu-save-btn").addEventListener("click", async () => {
    const patch = {};
    const nameEl = document.getElementById("eu-name");
    const emailEl = document.getElementById("eu-email");
    const titleEl = document.getElementById("eu-title");
    const phoneEl = document.getElementById("eu-phone");
    const roleEl = document.getElementById("eu-role");
    const managerEl = document.getElementById("eu-manager");
    if (nameEl) patch.name = nameEl.value.trim();
    if (emailEl) patch.email = emailEl.value.trim();
    if (titleEl) patch.title = titleEl.value.trim();
    if (phoneEl) patch.phone = phoneEl.value.trim();
    if (roleEl) patch.role = roleEl.value;
    if (managerEl) patch.manager_id = managerEl.value || null;
    const btn = document.getElementById("eu-save-btn");
    btn.disabled = true;
    try {
      await api(`/api/users/${u.id}`, { method: "PUT", body: patch });
      toast("User updated");
      closeModal();
      renderUsersSettings();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function openResetPasswordModal(u) {
  openModal(`
    <h2>Reset password — ${u.name}</h2>
    <label>New password</label>
    <div style="display:flex;gap:8px">
      <input type="text" id="rp-password" style="flex:1" value="${generatePassword()}" />
      <button type="button" class="btn" id="rp-generate-btn">Generate</button>
    </div>
    <div class="hint">This immediately replaces their current password. Share the new one with them directly.</div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="rp-save-btn">Reset password</button>
    </div>
  `);

  document.getElementById("rp-generate-btn").addEventListener("click", () => {
    document.getElementById("rp-password").value = generatePassword();
  });

  document.getElementById("rp-save-btn").addEventListener("click", async () => {
    const password = document.getElementById("rp-password").value;
    if (!password || password.length < 6) {
      toast("Password must be at least 6 characters", "error");
      return;
    }
    const btn = document.getElementById("rp-save-btn");
    btn.disabled = true;
    try {
      await api(`/api/users/${u.id}/password`, { method: "PUT", body: { password } });
      toast(`Password reset — new password: ${password}`);
      closeModal();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// Deleting a user is permanent, so unlike every other admin action here it
// asks for something a click alone can't provide: the ADMIN'S OWN current
// password, re-entered right before the delete goes through (mirrors the
// self-service password-change flow, not the no-password "Reset password"
// override above). The backend (DELETE /api/users/:id) checks that password
// against the signed-in admin's own hash and rejects self-delete / deleting
// the last remaining admin regardless of what the UI allows.
function openDeleteUserModal(u) {
  openModal(`
    <h2>Delete ${u.name}?</h2>
    <div class="hint" style="margin-top:0">This permanently removes their login. It can't be undone. Records they owned are unassigned rather than deleted.</div>
    <label>Confirm your password</label>
    <input type="password" id="du-password" autocomplete="current-password" placeholder="Your current password" />
    <div class="error-text" id="du-error"></div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-danger" id="du-confirm-btn">Delete user</button>
    </div>
  `);

  const passwordEl = document.getElementById("du-password");
  passwordEl.focus();
  const errEl = document.getElementById("du-error");

  document.getElementById("du-confirm-btn").addEventListener("click", async () => {
    const password = passwordEl.value;
    errEl.textContent = "";
    if (!password) {
      errEl.textContent = "Enter your password to confirm.";
      return;
    }
    const btn = document.getElementById("du-confirm-btn");
    btn.disabled = true;
    try {
      await api(`/api/users/${u.id}`, { method: "DELETE", body: { password } });
      toast(`${u.name} deleted`);
      closeModal();
      renderUsersSettings();
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
    }
  });

  passwordEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("du-confirm-btn").click(); }
  });
}

// Generic "re-enter your password to confirm this destructive action" modal
// -- same UX as openDeleteUserModal just above, factored out so any other
// password-gated delete (Leads' single/bulk delete today, and any future
// one) can reuse it instead of re-implementing the same modal. `onConfirm`
// receives the entered password and does the actual API call(s); it's
// responsible for calling closeModal() itself on success (letting the modal
// stay open, with the error shown, is exactly what should happen on
// failure -- e.g. a wrong password -- so this doesn't close it for you).
function openPasswordConfirmModal({ title, hint, confirmLabel = "Confirm", onConfirm }) {
  openModal(`
    <h2>${title}</h2>
    ${hint ? `<div class="hint" style="margin-top:0">${hint}</div>` : ""}
    <label>Confirm your password</label>
    <input type="password" id="pc-password" autocomplete="current-password" placeholder="Your current password" />
    <div class="error-text" id="pc-error"></div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-danger" id="pc-confirm-btn">${confirmLabel}</button>
    </div>
  `);
  const passwordEl = document.getElementById("pc-password");
  passwordEl.focus();
  const errEl = document.getElementById("pc-error");
  const btn = document.getElementById("pc-confirm-btn");
  const submit = async () => {
    const password = passwordEl.value;
    errEl.textContent = "";
    if (!password) {
      errEl.textContent = "Enter your password to confirm.";
      return;
    }
    btn.disabled = true;
    try {
      await onConfirm(password);
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", submit);
  passwordEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
}

// ---------- Settings > Access Control (admin) ----------
// Two independent, admin-only controls that don't touch the org-hierarchy
// Manager mechanism at all:
//   - Feature access: per-user on/off switches for whole tabs.
//   - Data sharing: exact-person grants -- "this user can additionally see
//     that user's records" -- which is what lets an admin build a
//     Sub-Admin (or extend anyone else) by hand-picking people rather than
//     relying on the reporting hierarchy. The same person can be shared
//     with more than one grantee.
const FEATURE_ACCESS_FIELDS = [
  ["leads", "Leads"],
  ["activity_report", "Activity Report"],
  ["emailing", "Emailing"],
  ["linkedin_search", "LinkedIn Search"],
  ["salesforce", "Salesforce"],
  ["accounts_gem", "Accounts Gem"],
];

let accessControlSelectedUserId = null;

async function renderAccessControlSettings() {
  const body = document.getElementById("settings-body");
  body.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  let users, grants;
  try {
    [users, grants] = await Promise.all([api("/api/users"), api("/api/data-grants")]);
    state.users = users;
  } catch (err) {
    body.innerHTML = `<div class="panel"><div class="empty-state">${err.message}</div></div>`;
    return;
  }

  if (!accessControlSelectedUserId || !users.some((u) => u.id === accessControlSelectedUserId)) {
    accessControlSelectedUserId = users.find((u) => u.id !== state.user.id)?.id || users[0]?.id || null;
  }
  const selected = users.find((u) => u.id === accessControlSelectedUserId);
  const access = { ...Object.fromEntries(FEATURE_ACCESS_FIELDS.map(([k]) => [k, true])), ...(selected?.feature_access || {}) };
  const grantedToSelected = grants.filter((g) => g.grantee_id === accessControlSelectedUserId);
  const grantableUsers = users.filter((u) => u.id !== accessControlSelectedUserId && !grantedToSelected.some((g) => g.target_id === u.id));

  body.innerHTML = `
    <div class="panel">
      <h2 style="margin-bottom:4px">Access Control</h2>
      <div class="hint" style="margin-bottom:14px">Pick a user, then set which tabs they can use and whose data they can additionally see (on top of their own, and their team's if they're a Manager). This is how you build a Sub-Admin -- give them the role on the Users tab, then hand-pick exactly whose records they should see here.</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div style="min-width:220px">
          <label>User</label>
          <select id="ac-user-select" style="width:100%">
            ${users.map((u) => `<option value="${u.id}" ${u.id === accessControlSelectedUserId ? "selected" : ""}>${u.name} — ${roleLabel(u.role)}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>

    ${selected ? `
    <div class="panel" style="margin-top:14px">
      <h2 style="margin-bottom:8px">Feature access for ${selected.name}</h2>
      <div class="hint" style="margin-top:-4px;margin-bottom:12px">Unchecking a tab here hides it from their sidebar and blocks the underlying pages, even if they type the URL directly. Admin always has every tab.</div>
      <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px">
        ${FEATURE_ACCESS_FIELDS.map(([key, label]) => `
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text);margin:0">
            <input type="checkbox" data-feature="${key}" ${access[key] ? "checked" : ""} style="width:auto" ${selected.role === "admin" ? "disabled" : ""} />
            ${label}
          </label>
        `).join("")}
      </div>
      ${selected.role === "admin" ? `<div class="hint">Admins always have every feature -- nothing to restrict here.</div>` : `<button class="btn btn-primary" id="ac-save-features-btn">Save feature access</button>`}
    </div>

    <div class="panel" style="margin-top:14px">
      <h2 style="margin-bottom:8px">Data ${selected.name} can additionally see</h2>
      <div class="hint" style="margin-top:-4px;margin-bottom:12px">On top of their own records (and their team's, if they're a Manager), ${selected.name} will also see Leads/Contacts/Accounts/Leave/Activity Reports owned by anyone granted below. The same person can be granted to more than one user.</div>
      <div class="table-scroll" style="margin-bottom:14px">
        <table>
          <thead><tr><th>Granted user</th><th>Role</th><th></th></tr></thead>
          <tbody>
            ${grantedToSelected.length ? grantedToSelected.map((g) => {
              const target = users.find((u) => u.id === g.target_id);
              return `
                <tr>
                  <td>${target ? target.name : `User #${g.target_id}`}</td>
                  <td>${target ? roleLabel(target.role) : "—"}</td>
                  <td style="white-space:nowrap"><button type="button" class="btn btn-small" data-revoke-grant="${g.id}">Remove</button></td>
                </tr>
              `;
            }).join("") : `<tr><td colspan="3"><div class="empty-state">No extra people granted yet.</div></td></tr>`}
          </tbody>
        </table>
      </div>
      ${grantableUsers.length ? `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="ac-grant-target-select">
            ${grantableUsers.map((u) => `<option value="${u.id}">${u.name} — ${roleLabel(u.role)}</option>`).join("")}
          </select>
          <button class="btn btn-primary" id="ac-add-grant-btn">+ Grant this person's data</button>
        </div>
      ` : `<div class="hint">Every other user is already granted to ${selected.name}.</div>`}
    </div>
    ` : ""}
  `;

  document.getElementById("ac-user-select").addEventListener("change", (e) => {
    accessControlSelectedUserId = Number(e.target.value);
    renderAccessControlSettings();
  });

  const saveFeaturesBtn = document.getElementById("ac-save-features-btn");
  if (saveFeaturesBtn) {
    saveFeaturesBtn.addEventListener("click", async () => {
      const feature_access = {};
      body.querySelectorAll("[data-feature]").forEach((el) => { feature_access[el.dataset.feature] = el.checked; });
      saveFeaturesBtn.disabled = true;
      try {
        await api(`/api/users/${accessControlSelectedUserId}/feature-access`, { method: "PUT", body: { feature_access } });
        toast("Feature access saved");
        renderAccessControlSettings();
      } catch (err) {
        toast(err.message, "error");
        saveFeaturesBtn.disabled = false;
      }
    });
  }

  const addGrantBtn = document.getElementById("ac-add-grant-btn");
  if (addGrantBtn) {
    addGrantBtn.addEventListener("click", async () => {
      const targetId = Number(document.getElementById("ac-grant-target-select").value);
      addGrantBtn.disabled = true;
      try {
        await api("/api/data-grants", { method: "POST", body: { grantee_id: accessControlSelectedUserId, target_id: targetId } });
        toast("Access granted");
        renderAccessControlSettings();
      } catch (err) {
        toast(err.message, "error");
        addGrantBtn.disabled = false;
      }
    });
  }

  body.querySelectorAll("[data-revoke-grant]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/data-grants/${btn.dataset.revokeGrant}`, { method: "DELETE" });
        toast("Access removed");
        renderAccessControlSettings();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

// ---------- Settings > Holidays (admin) ----------
// Company holiday dates that Leave requests exclude from the auto-filled
// Days count, alongside Saturdays/Sundays. Admin-only, same tab pattern as
// Users above.
async function renderHolidaysSettings() {
  const body = document.getElementById("settings-body");
  body.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  let holidays;
  try {
    holidays = await api("/api/holidays");
    state.holidays = holidays;
  } catch (err) {
    body.innerHTML = `<div class="panel"><div class="empty-state">${err.message}</div></div>`;
    return;
  }
  body.innerHTML = `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h2 style="margin:0">Holidays</h2>
        <button class="btn btn-primary" id="new-holiday-btn">+ Add Holiday</button>
      </div>
      <div class="hint" style="margin-top:-6px;margin-bottom:14px">These dates, plus every Saturday and Sunday, are excluded from the Days count on leave requests.</div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Name</th><th></th></tr></thead>
          <tbody>
            ${holidays.length ? holidays.map((h) => `
              <tr>
                <td>${h.date}</td>
                <td>${h.name || "—"}</td>
                <td style="white-space:nowrap"><button type="button" class="btn btn-small" data-delete-holiday="${h.id}">Delete</button></td>
              </tr>
            `).join("") : `<tr><td colspan="3"><div class="empty-state">No holidays configured yet.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById("new-holiday-btn").addEventListener("click", openNewHolidayModal);
  body.querySelectorAll("[data-delete-holiday]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this holiday? Leave-day counts will no longer exclude it.")) return;
      try {
        await api(`/api/holidays/${btn.dataset.deleteHoliday}`, { method: "DELETE" });
        toast("Holiday removed");
        renderHolidaysSettings();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

function openNewHolidayModal() {
  openModal(`
    <h2>Add holiday</h2>
    <label>Date</label>
    <input type="date" id="nh-date" />
    <label style="margin-top:10px">Name</label>
    <input type="text" id="nh-name" placeholder="e.g. Diwali" />
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="nh-save-btn">Add holiday</button>
    </div>
  `);

  document.getElementById("nh-save-btn").addEventListener("click", async () => {
    const date = document.getElementById("nh-date").value;
    const name = document.getElementById("nh-name").value.trim();
    if (!date) {
      toast("A date is required", "error");
      return;
    }
    const btn = document.getElementById("nh-save-btn");
    btn.disabled = true;
    try {
      await api("/api/holidays", { method: "POST", body: { date, name } });
      toast("Holiday added");
      closeModal();
      renderHolidaysSettings();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function renderAppearanceSettings() {
  const theme = state.user.theme || {};
  const primary = theme.primary || "#22c55e";
  const accent = theme.accent || "#1e3ae8";
  const font = theme.font || "system";
  const density = theme.density || "comfortable";
  const body = document.getElementById("settings-body");
  body.innerHTML = `
    <div class="panel">
      <h2>Colors</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-top:-8px">Just for you — everyone else keeps their own colors.</p>
      <label>Primary color</label>
      <div class="color-swatch-row">
        <input type="color" id="theme-primary" value="${primary}" />
        <span style="color:var(--text-dim);font-size:13px">Buttons, active nav, highlights</span>
      </div>
      <label style="margin-top:16px">Accent color</label>
      <div class="color-swatch-row">
        <input type="color" id="theme-accent" value="${accent}" />
        <span style="color:var(--text-dim);font-size:13px">Gradient pairing, secondary highlights</span>
      </div>
    </div>
    <div class="panel">
      <h2>Font</h2>
      <div class="font-preview-grid" id="font-grid">
        ${Object.keys(FONT_STACKS).map((key) => `
          <div class="font-preview-card ${font === key ? "selected" : ""}" data-font="${key}">
            <div class="name">${FONT_LABELS[key]}</div>
            <div class="sample" style="font-family:${FONT_STACKS[key]}">Aa Bb Cc 123</div>
          </div>
        `).join("")}
      </div>
    </div>
    <div class="panel">
      <h2>Table view size</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-top:-8px">Row height and text size across every table in the app — Contacts, Accounts, Leads, Activity Report.</p>
      <div class="font-preview-grid" id="density-grid">
        ${Object.keys(DENSITY_LABELS).map((key) => `
          <div class="font-preview-card ${density === key ? "selected" : ""}" data-density-choice="${key}">
            <div class="name">${DENSITY_LABELS[key]}</div>
            <div class="sample" style="font-size:13px">${DENSITY_DESCRIPTIONS[key]}</div>
          </div>
        `).join("")}
      </div>
    </div>
    <div class="modal-actions" style="margin-top:0">
      <button class="btn" id="theme-reset-btn">Reset to default</button>
      <button class="btn btn-primary" id="theme-save-btn">Save appearance</button>
    </div>
  `;

  let selectedFont = font;
  body.querySelectorAll("[data-font]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedFont = el.dataset.font;
      body.querySelectorAll("[data-font]").forEach((c) => c.classList.toggle("selected", c.dataset.font === selectedFont));
    });
  });

  let selectedDensity = density;
  body.querySelectorAll("[data-density-choice]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedDensity = el.dataset.densityChoice;
      body.querySelectorAll("[data-density-choice]").forEach((c) => c.classList.toggle("selected", c.dataset.densityChoice === selectedDensity));
    });
  });

  document.getElementById("theme-save-btn").addEventListener("click", async () => {
    const primaryVal = document.getElementById("theme-primary").value;
    const accentVal = document.getElementById("theme-accent").value;
    try {
      const { user } = await api("/api/me/theme", { method: "PUT", body: { primary: primaryVal, accent: accentVal, font: selectedFont, density: selectedDensity } });
      state.user = user;
      applyTheme(user.theme);
      toast("Appearance saved");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  document.getElementById("theme-reset-btn").addEventListener("click", async () => {
    try {
      const { user } = await api("/api/me/theme", { method: "PUT", body: { primary: "", accent: "", font: "", density: "" } });
      state.user = user;
      applyTheme(user.theme);
      toast("Appearance reset to default");
      renderSettings();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function renderIntegrationSettings() {
  const body = document.getElementById("settings-body");
  const isAdmin = state.user.role === "admin";
  body.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  try {
    const [outlookStatus, outlookConnections] = await Promise.all([
      api("/api/outlook/status"),
      api("/api/outlook/connections"),
    ]);
    state.outlookConnections = outlookConnections;
    let data = null, sf = null, outlookApp = null;
    if (isAdmin) {
      [data, sf, outlookApp] = await Promise.all([
        api("/api/integrations"),
        api("/api/salesforce/status"),
        api("/api/outlook/app-config"),
      ]);
    }

    const outlookPersonalPanel = `
      <div class="panel">
        <h2>Your Outlook mailboxes</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">Connect one or more Microsoft 365 mailboxes — your own, a shared team address, or both. Wherever you compose an email you'll pick which one to send from, and replies to any of them show up under Emailing &gt; Replies.</div>
        ${outlookConnections.map((cn) => `
          <div class="integration-card">
            <div class="meta">
              <div class="name">${escapeAttr(cn.email)} <span class="pill pill-active">Connected</span></div>
              <div class="desc">
                ${cn.display_name ? escapeAttr(cn.display_name) + " · " : ""}connected ${cn.connected_at ? cn.connected_at.slice(0, 10) : "—"}${cn.last_synced_at ? " · last synced " + cn.last_synced_at.slice(0, 10) : ""}
              </div>
            </div>
            <div class="row">
              <button type="button" class="btn btn-small btn-danger" data-disconnect-connection="${cn.id}">Disconnect</button>
            </div>
          </div>
        `).join("") || `<div class="empty-state" style="margin-bottom:14px">${outlookStatus.app_configured ? "No mailbox connected yet." : "Your admin hasn't set up Outlook for the organization yet."}</div>`}
        ${outlookStatus.app_configured ? `
          <div class="row" style="margin-top:${outlookConnections.length ? "12px" : "0"}">
            <button type="button" class="btn btn-small btn-primary" id="outlook-connect-btn">${outlookConnections.length ? "Connect another mailbox" : "Connect Outlook"}</button>
          </div>
        ` : ""}
      </div>
    `;

    function wireOutlookMailboxButtons() {
      const connectBtn = document.getElementById("outlook-connect-btn");
      if (connectBtn) connectBtn.addEventListener("click", () => { window.location.href = "/api/outlook/oauth/start"; });
      document.querySelectorAll("[data-disconnect-connection]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await api("/api/outlook/disconnect", { method: "POST", body: { id: btn.dataset.disconnectConnection } });
            toast("Mailbox disconnected");
            renderIntegrationSettings();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      });
    }

    // Personal default for the Contacts table's Email icon column (and
    // anywhere else that sends without asking) -- Outlook Classic opens the
    // mailto:-based desktop app hand-off already used as this app's
    // zero-setup fallback; Outlook Web opens an OWA compose deep link;
    // Apollo is listed since it's asked for, but this app has no Apollo
    // send capability yet (it's search/import only), so picking it just
    // shows a clear "not set up" message instead of silently doing nothing.
    const emailMethodPanel = `
      <div class="panel">
        <h2>Default email sending</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">Which app the Contacts table's email icon sends through by default.</div>
        <select id="email-method-select" style="width:auto">
          <option value="outlook_classic" ${(state.user.email_method || "outlook_classic") === "outlook_classic" ? "selected" : ""}>Outlook Classic (desktop app)</option>
          <option value="outlook_web" ${state.user.email_method === "outlook_web" ? "selected" : ""}>Outlook Web</option>
          <option value="apollo" ${state.user.email_method === "apollo" ? "selected" : ""}>Apollo</option>
        </select>
      </div>
    `;
    function wireEmailMethodPanel() {
      document.getElementById("email-method-select").addEventListener("change", async (e) => {
        const email_method = e.target.value;
        try {
          const { user } = await api("/api/me/email-method", { method: "PUT", body: { email_method } });
          state.user = user;
          toast("Default email sending saved");
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }

    if (!isAdmin) {
      const admin = state.users.find((u) => u.role === "admin");
      body.innerHTML = outlookPersonalPanel + emailMethodPanel + `
        <div class="panel"><div class="empty-state">AI providers, Apollo, Salesforce, and the org-wide Outlook setup are configured by an admin${admin ? ` — ask ${admin.name}` : ""}.</div></div>
      `;
      wireOutlookMailboxButtons();
      wireEmailMethodPanel();
      return;
    }

    body.innerHTML = outlookPersonalPanel + emailMethodPanel + `
      <div class="panel">
        <h2>AI providers</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">Add an API key per provider. "General" powers everything by default (Quick Add, Account briefs, etc); "Drafting" is a separate, optional override just for outreach writing (Draft with AI, auto-draft, sequences) — leave it unset and drafting just uses the General provider too. Keys are stored in the app's database and masked after saving.</div>
        ${data.providers.map((p) => `
          <div class="integration-card" data-provider="${p.provider}">
            <div class="meta">
              <div class="name">
                ${p.label}
                ${p.active ? `<span class="pill pill-active">General</span>` : ""}
                ${p.drafting_active ? `<span class="pill pill-active">Drafting</span>` : ""}
                ${!p.active && !p.drafting_active && p.configured ? `<span class="pill pill-inactive">Configured</span>` : ""}
              </div>
              <div class="desc">${p.configured ? `Key on file: ${p.key_preview}` : "No key saved yet"}${p.updated_at ? " · updated " + p.updated_at : ""}</div>
            </div>
            <div class="row">
              <input type="password" placeholder="${p.configured ? "Replace key…" : "Paste API key…"}" data-key-input />
              <button class="btn btn-small" data-save>Save</button>
              ${!p.active ? `<button class="btn btn-small btn-primary" data-activate ${p.configured ? "" : "disabled"}>Use for General</button>` : ""}
              ${!p.drafting_active ? `<button class="btn btn-small" data-activate-drafting ${p.configured ? "" : "disabled"}>Use for Drafting</button>` : `<button class="btn btn-small" data-clear-drafting>Stop using for Drafting</button>`}
            </div>
          </div>
        `).join("")}
      </div>
      <div class="panel">
        <h2>Data &amp; prospecting</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">Powers Search Apollo on Contacts and Accounts, plus the Apollo list import — find people and companies and import them straight in.</div>
        <div class="integration-card" data-provider="apollo">
          <div class="meta">
            <div class="name">${data.apollo.label} ${data.apollo.configured ? `<span class="pill pill-active">Connected</span>` : ""}</div>
            <div class="desc">${data.apollo.configured ? `Key on file: ${data.apollo.key_preview}` : "No key saved yet"}${data.apollo.updated_at ? " · updated " + data.apollo.updated_at : ""}</div>
          </div>
          <div class="row">
            <input type="password" placeholder="${data.apollo.configured ? "Replace key…" : "Paste API key…"}" data-key-input />
            <button class="btn btn-small" data-save>Save</button>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Unipile (LinkedIn)</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">
          Powers the "LinkedIn (Sales Navigator)" panel on Account records — real About/tagline, industry, headcount + growth insights, and HQ, pulled through a LinkedIn account connected via <a href="https://dashboard.unipile.com" target="_blank" rel="noopener" style="color:var(--teal)">Unipile</a>. This rides on a real logged-in LinkedIn session (not an official LinkedIn API), so it's meant for on-demand lookups on individual accounts — not a bulk or scheduled sync. You'll need the DSN (host:port shown in your Unipile dashboard, e.g. <code>api44.unipile.com:17403</code>) and the ID of the connected LinkedIn account from <code>GET /accounts</code>.
        </div>
        <div class="integration-card" data-provider="unipile">
          <div class="meta">
            <div class="name">Unipile ${data.unipile.configured ? `<span class="pill pill-active">Configured</span>` : ""}</div>
            <div class="desc">${data.unipile.configured ? `Key on file: ${data.unipile.key_preview} · DSN: ${data.unipile.dsn} · Account ID: ${data.unipile.account_id}` : "Not set up yet"}${data.unipile.updated_at ? " · updated " + data.unipile.updated_at : ""}</div>
          </div>
          <form id="unipile-config-form" style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
            <input name="api_key" type="password" placeholder="${data.unipile.configured ? "Replace API key… (leave blank to keep current)" : "X-API-KEY"}" />
            <input name="dsn" placeholder="DSN, e.g. api44.unipile.com:17403" value="${data.unipile.dsn || ""}" />
            <input name="account_id" placeholder="Connected LinkedIn account ID" value="${data.unipile.account_id || ""}" />
            <div class="error-text" id="unipile-error"></div>
            <div class="row" style="margin-top:4px">
              <button type="submit" class="btn btn-small">Save</button>
              ${data.unipile.configured ? `<button type="button" class="btn btn-small btn-primary" id="unipile-test-btn">Test connection</button>` : ""}
              ${data.unipile.configured ? `<button type="button" class="btn btn-small btn-danger" id="unipile-disconnect-btn">Disconnect</button>` : ""}
            </div>
          </form>
        </div>
      </div>
      <div class="panel">
        <h2>Salesforce</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">
          Two-way sync for Leads, Accounts, Contacts, and Opportunities — pull records in to review and import, or push local records out. Unlike the keys above, this needs a Connected App set up on the Salesforce side first (Setup &rarr; App Manager &rarr; New Connected App, with OAuth enabled and scopes <code>api</code> + <code>refresh_token, offline_access</code>). Use this as the callback URL: <code>${sf.redirect_uri}</code>
        </div>
        <div class="integration-card" data-provider="salesforce">
          <div class="meta">
            <div class="name">Salesforce ${sf.connected ? `<span class="pill pill-active">Connected</span>` : (sf.configured ? `<span class="pill pill-inactive">Configured</span>` : "")}</div>
            <div class="desc">
              ${sf.connected ? `Connected to ${sf.instance_url || sf.login_url}${sf.connected_by ? " by " + sf.connected_by : ""}${sf.connected_at ? " on " + sf.connected_at.slice(0, 10) : ""}` : (sf.configured ? "Configured — not connected yet" : "No Connected App details saved yet")}
            </div>
          </div>
          <form id="sf-config-form" style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
            <input name="login_url" placeholder="Login URL (e.g. https://accelq.my.salesforce.com)" value="${sf.login_url || ""}" />
            <input name="client_id" placeholder="${sf.client_id_preview ? "Replace Consumer Key… (on file: " + sf.client_id_preview + ")" : "Consumer Key (Client ID)"}" />
            <input name="client_secret" type="password" placeholder="Consumer Secret (Client Secret)" />
            <div class="row" style="margin-top:4px">
              <button type="submit" class="btn btn-small">Save connection details</button>
              ${sf.configured ? `<button type="button" class="btn btn-small btn-primary" id="sf-connect-btn">${sf.connected ? "Reconnect" : "Connect via OAuth"}</button>` : ""}
              ${sf.connected ? `<button type="button" class="btn btn-small btn-danger" id="sf-disconnect-btn">Disconnect</button>` : ""}
            </div>
          </form>
        </div>
      </div>
      <div class="panel">
        <h2>Outlook (Microsoft 365) — organization setup</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">
          One Azure AD app registration covers the whole org — each rep then connects their own mailbox above. In the Azure Portal: App registrations &rarr; New registration &rarr; single tenant &rarr; add a Web redirect URI of <code>${outlookApp.redirect_uri}</code> &rarr; under API permissions add Microsoft Graph delegated <code>Mail.Send</code>, <code>offline_access</code>, <code>User.Read</code> (grant admin consent) &rarr; under Certificates &amp; secrets create a client secret.
        </div>
        <div class="integration-card" data-provider="outlook_app">
          <div class="meta">
            <div class="name">Outlook app ${outlookApp.configured ? `<span class="pill pill-active">Configured</span>` : ""}</div>
            <div class="desc">${outlookApp.configured ? `Client ID on file: ${outlookApp.client_id_preview}` : "No Azure app details saved yet"}</div>
          </div>
          <form id="outlook-app-form" style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
            <input name="tenant_id" placeholder="Directory (tenant) ID" value="${outlookApp.tenant_id || ""}" required />
            <input name="client_id" placeholder="${outlookApp.client_id_preview ? "Replace Application (client) ID… (on file: " + outlookApp.client_id_preview + ")" : "Application (client) ID"}" ${outlookApp.configured ? "" : "required"} />
            <input name="client_secret" type="password" placeholder="${outlookApp.configured ? "Client secret (leave blank to keep current)" : "Client secret"}" ${outlookApp.configured ? "" : "required"} />
            <div class="error-text" id="outlook-app-error"></div>
            <div class="row" style="margin-top:4px">
              <button type="submit" class="btn btn-small">Save Outlook app details</button>
            </div>
          </form>
        </div>
      </div>
      <div class="panel">
        <h2>Not available yet</h2>
        <div style="color:var(--text-dim);font-size:13px;margin-bottom:14px">You asked about these too — here's why they're not wired up for AI drafting specifically.</div>
        ${data.unsupported.map((u) => `
          <div class="integration-card unsupported">
            <div class="meta">
              <div class="name">${u.label}</div>
              <div class="desc">${u.reason}</div>
            </div>
          </div>
        `).join("")}
      </div>
    `;
    body.querySelectorAll("[data-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".integration-card");
        const provider = card.dataset.provider;
        const key = card.querySelector("[data-key-input]").value.trim();
        if (!key) { toast("Enter an API key first", "error"); return; }
        try {
          await api(`/api/integrations/${provider}`, { method: "PUT", body: { api_key: key } });
          toast("API key saved");
          renderIntegrationSettings();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    body.querySelectorAll("[data-activate]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".integration-card");
        const provider = card.dataset.provider;
        const label = data.providers.find((pp) => pp.provider === provider)?.label || provider;
        try {
          await api(`/api/integrations/${provider}`, { method: "PUT", body: { active: true } });
          toast(`${label} set as the General provider`);
          renderIntegrationSettings();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    body.querySelectorAll("[data-activate-drafting]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".integration-card");
        const provider = card.dataset.provider;
        const label = data.providers.find((pp) => pp.provider === provider)?.label || provider;
        try {
          await api(`/api/integrations/${provider}`, { method: "PUT", body: { drafting_active: true } });
          toast(`${label} set as the Drafting provider`);
          renderIntegrationSettings();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    body.querySelectorAll("[data-clear-drafting]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".integration-card");
        const provider = card.dataset.provider;
        try {
          await api(`/api/integrations/${provider}`, { method: "PUT", body: { drafting_active: false } });
          toast("Drafting will use the General provider again");
          renderIntegrationSettings();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });

    const unipileForm = document.getElementById("unipile-config-form");
    if (unipileForm) {
      unipileForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById("unipile-error");
        errorEl.textContent = "";
        const fd = Object.fromEntries(new FormData(unipileForm));
        if (!fd.api_key) delete fd.api_key; // don't overwrite with blank on a details-only edit
        if (!fd.dsn?.trim() || !fd.account_id?.trim()) {
          errorEl.textContent = "DSN and account ID are both required.";
          return;
        }
        if (!fd.api_key && !data.unipile.configured) {
          errorEl.textContent = "API key is required the first time you set this up.";
          return;
        }
        try {
          await api("/api/integrations/unipile", { method: "PUT", body: fd });
          toast("Unipile settings saved");
          renderIntegrationSettings();
        } catch (err) {
          errorEl.textContent = err.message;
          toast(err.message, "error");
        }
      });
    }
    const unipileTestBtn = document.getElementById("unipile-test-btn");
    if (unipileTestBtn) {
      unipileTestBtn.addEventListener("click", async () => {
        unipileTestBtn.disabled = true;
        unipileTestBtn.textContent = "Testing…";
        try {
          const result = await api("/api/integrations/unipile/test", { method: "POST" });
          toast(`Connected — LinkedIn account "${result.account.name}" (${result.account.status || "status unknown"})`);
        } catch (err) {
          toast(err.message, "error");
        } finally {
          unipileTestBtn.disabled = false;
          unipileTestBtn.textContent = "Test connection";
        }
      });
    }
    const unipileDisconnectBtn = document.getElementById("unipile-disconnect-btn");
    if (unipileDisconnectBtn) {
      unipileDisconnectBtn.addEventListener("click", async () => {
        if (!confirm("Sign out of Unipile? This clears the saved API key, DSN, and account ID — company/person search, Key People, and the LinkedIn panel on Accounts will need it reconnected before they work again.")) return;
        try {
          await api("/api/integrations/unipile", { method: "DELETE" });
          toast("Signed out of Unipile");
          renderIntegrationSettings();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }

    const sfForm = document.getElementById("sf-config-form");
    if (sfForm) {
      sfForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(sfForm));
        if (!fd.client_secret) delete fd.client_secret; // don't overwrite with blank on a details-only edit
        if (!fd.client_secret && !sf.configured) { toast("Consumer Secret is required the first time", "error"); return; }
        try {
          await api("/api/salesforce/config", { method: "PUT", body: fd });
          toast("Salesforce connection details saved");
          renderIntegrationSettings();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }
    const sfConnectBtn = document.getElementById("sf-connect-btn");
    if (sfConnectBtn) {
      sfConnectBtn.addEventListener("click", () => { window.location.href = "/api/salesforce/oauth/start"; });
    }
    const sfDisconnectBtn = document.getElementById("sf-disconnect-btn");
    if (sfDisconnectBtn) {
      sfDisconnectBtn.addEventListener("click", async () => {
        try {
          await api("/api/salesforce/disconnect", { method: "POST" });
          toast("Salesforce disconnected");
          renderIntegrationSettings();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }

    wireOutlookMailboxButtons();
    wireEmailMethodPanel();
    const outlookAppForm = document.getElementById("outlook-app-form");
    if (outlookAppForm) {
      outlookAppForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById("outlook-app-error");
        errorEl.textContent = "";
        const fd = Object.fromEntries(new FormData(outlookAppForm));
        if (!fd.client_secret) delete fd.client_secret;
        if (!fd.tenant_id?.trim() || !fd.client_id?.trim()) {
          errorEl.textContent = "Directory (tenant) ID and Application (client) ID are both required.";
          return;
        }
        if (!fd.client_secret && !outlookApp.configured) {
          errorEl.textContent = "Client secret is required the first time you set this up.";
          return;
        }
        try {
          await api("/api/outlook/app-config", { method: "PUT", body: fd });
          toast("Outlook app details saved — Client ID on file now shown below");
          renderIntegrationSettings();
        } catch (err) {
          errorEl.textContent = err.message;
          toast(err.message, "error");
        }
      });
    }
  } catch (err) {
    body.innerHTML = `<div class="panel"><div class="empty-state">${err.message}</div></div>`;
  }
}

// ---------- Search Apollo (real-time, from Contacts/Accounts) ----------
// The "Search Apollo" button on the Contacts and Accounts toolbars opens
// this — a filter panel modeled on Apollo.io's own "Find people"/"Find
// companies" screens (Locations, Employee Count, Industry, Job Titles),
// backed by a live call to Apollo's search API every time you hit Search —
// nothing cached or mocked. This is separate from the Prospecting nav tab
// (which still has its own simpler keyword search); the two share the same
// backend routes and import endpoints, just different UIs for different
// entry points.

const APOLLO_LOCATION_PRESETS = ["United States", "Canada", "United Kingdom", "India", "Australia"];
const APOLLO_EMPLOYEE_RANGES = ["1-10", "11-20", "21-50", "51-100", "101-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
const APOLLO_INDUSTRY_PRESETS = ["Information Technology & Services", "Software", "Marketing & Advertising", "Retail", "Healthcare", "Financial Services", "Manufacturing", "Education"];
const APOLLO_TITLE_PRESETS = ["Founder", "CEO", "VP Engineering", "VP Sales", "Sales Manager", "Marketing Director", "IT Director", "Head of Procurement"];
const APOLLO_EMAIL_STATUS_OPTIONS = ["verified", "unverified", "unavailable"];

// Renders a row of toggle chips (click to add/remove from `selectedSet`)
// plus a small free-text "+ Add" control for values not in the preset list —
// exactly the two ways Apollo's own filter panel lets you narrow a filter.
function chipFilterHtml(groupId, label, presets, selectedSet) {
  return `
    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">${label}</div>
      <div id="${groupId}-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">
        ${[...selectedSet].filter((v) => !presets.includes(v)).map((v) => `
          <span class="tag-role" data-chip-group="${groupId}" data-chip-value="${escapeAttr(v)}" style="cursor:pointer;background:var(--panel-2);border:1px solid var(--teal);color:var(--teal)">${v} ×</span>
        `).join("")}
        ${presets.map((v) => `
          <span class="tag-role" data-chip-group="${groupId}" data-chip-value="${escapeAttr(v)}" style="cursor:pointer;${selectedSet.has(v) ? "background:var(--panel-2);border:1px solid var(--teal);color:var(--teal)" : ""}">${v}</span>
        `).join("")}
      </div>
      <div style="display:flex;gap:6px">
        <input type="text" id="${groupId}-custom-input" placeholder="Add custom…" style="flex:1;padding:6px 8px;font-size:12px" />
        <button type="button" class="btn btn-small" id="${groupId}-custom-add">Add</button>
      </div>
    </div>
  `;
}

function wireChipFilter(groupId, selectedSet, onChange) {
  document.querySelectorAll(`[data-chip-group="${groupId}"]`).forEach((chip) => {
    chip.addEventListener("click", () => {
      const v = chip.dataset.chipValue;
      if (selectedSet.has(v)) selectedSet.delete(v); else selectedSet.add(v);
      onChange();
    });
  });
  const addBtn = document.getElementById(`${groupId}-custom-add`);
  const input = document.getElementById(`${groupId}-custom-input`);
  if (addBtn && input) {
    const add = () => {
      const v = input.value.trim();
      if (!v) return;
      selectedSet.add(v);
      input.value = "";
      onChange();
    };
    addBtn.addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  }
}

function openApolloSearchModal(kind) {
  const isPeople = kind === "people";
  const filters = {
    locations: new Set(),
    employeeRanges: new Set(),
    industries: new Set(),
    titles: new Set(),
    emailStatus: new Set(),
  };
  let results = [];
  let selected = new Set();
  // Apollo returns this in pages of 15 (people) / 15 (companies) -- without
  // tracking total/page and offering a way to fetch more, a broad search
  // silently caps out at whatever fit on page 1 with no indication more
  // exist. "totalAvailable" comes back from Apollo's own pagination info.
  let currentPage = 1;
  let totalAvailable = 0;

  function renderFilterPanel() {
    const panel = document.getElementById("apollo-search-filters");
    if (!panel) return;
    panel.innerHTML = `
      ${chipFilterHtml("as-loc", "Locations", APOLLO_LOCATION_PRESETS, filters.locations)}
      ${chipFilterHtml("as-emp", "Employee Count", APOLLO_EMPLOYEE_RANGES, filters.employeeRanges)}
      ${chipFilterHtml("as-ind", "Industry", APOLLO_INDUSTRY_PRESETS, filters.industries)}
      ${isPeople ? chipFilterHtml("as-title", "Job Titles", APOLLO_TITLE_PRESETS, filters.titles) : ""}
      ${isPeople ? `
        <div style="margin-bottom:4px">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">Email Status</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${APOLLO_EMAIL_STATUS_OPTIONS.map((v) => `
              <span class="tag-role" data-chip-group="as-email" data-chip-value="${v}" style="cursor:pointer;text-transform:capitalize;${filters.emailStatus.has(v) ? "background:var(--panel-2);border:1px solid var(--teal);color:var(--teal)" : ""}">${v}</span>
            `).join("")}
          </div>
        </div>
      ` : ""}
    `;
    wireChipFilter("as-loc", filters.locations, renderFilterPanel);
    wireChipFilter("as-emp", filters.employeeRanges, renderFilterPanel);
    wireChipFilter("as-ind", filters.industries, renderFilterPanel);
    if (isPeople) {
      wireChipFilter("as-title", filters.titles, renderFilterPanel);
      document.querySelectorAll('[data-chip-group="as-email"]').forEach((chip) => {
        chip.addEventListener("click", () => {
          const v = chip.dataset.chipValue;
          if (filters.emailStatus.has(v)) filters.emailStatus.delete(v); else filters.emailStatus.add(v);
          renderFilterPanel();
        });
      });
    }
  }

  // Apollo paginates at 15 results per page -- this is what tells the rep
  // there's more beyond what's on screen and lets them fetch it, instead of
  // the list silently capping out with no indication anything was cut off.
  function loadMoreBarHtml() {
    const hasMore = totalAvailable > results.length;
    return `
      <div class="modal-actions" style="justify-content:space-between;margin-top:10px">
        <span style="font-size:12px;color:var(--text-dim)">Showing ${results.length}${totalAvailable ? ` of ${totalAvailable}` : ""}</span>
        ${hasMore ? `<button type="button" class="btn btn-small" id="apollo-search-load-more-btn">Load more</button>` : ""}
      </div>
    `;
  }

  function renderResults() {
    const resultsEl = document.getElementById("apollo-search-results");
    if (!resultsEl) return;
    if (!results.length) {
      resultsEl.innerHTML = `<div class="empty-state">Set filters and/or keywords above, then hit Search — this calls Apollo live, nothing cached.</div>`;
      return;
    }
    if (isPeople) {
      resultsEl.innerHTML = `
        <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
          <button type="button" class="btn btn-primary btn-small" id="apollo-search-import-btn">Import selected as Contacts</button>
          <span id="apollo-search-selected-count" style="font-size:12px;color:var(--text-dim);align-self:center">${selected.size} selected</span>
        </div>
        <table>
          <thead><tr><th></th><th>Name</th><th>Title</th><th>Company</th><th>Location</th><th>Email</th></tr></thead>
          <tbody>
            ${results.map((p, i) => `
              <tr>
                <td><input type="checkbox" data-select="${i}" ${selected.has(i) ? "checked" : ""} /></td>
                <td>${p.first_name} ${p.last_name}</td>
                <td>${p.title || "—"}</td>
                <td>${p.organization_name || "—"}</td>
                <td>${p.location || "—"}</td>
                <td>${p.email ? p.email : `<button type="button" class="btn btn-small" data-reveal="${i}">Reveal (1 credit)</button>`}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        ${loadMoreBarHtml()}
      `;
      resultsEl.querySelectorAll("[data-reveal]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const i = Number(btn.dataset.reveal);
          const p = results[i];
          btn.disabled = true;
          btn.textContent = "Revealing…";
          try {
            const result = await api("/api/prospecting/reveal-email", {
              method: "POST",
              body: { first_name: p.first_name, last_name: p.last_name, organization_name: p.organization_name, linkedin_url: p.linkedin_url },
            });
            results[i] = { ...p, email: result.email, phone: result.phone || p.phone };
            renderResults();
          } catch (err) {
            toast(err.message, "error");
            btn.disabled = false;
            btn.textContent = "Reveal (1 credit)";
          }
        });
      });
    } else {
      resultsEl.innerHTML = `
        <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
          <button type="button" class="btn btn-primary btn-small" id="apollo-search-import-btn">Import selected as Accounts</button>
          <span id="apollo-search-selected-count" style="font-size:12px;color:var(--text-dim);align-self:center">${selected.size} selected</span>
        </div>
        <table>
          <thead><tr><th></th><th>Company</th><th>Website</th><th>Industry</th><th>Employees</th></tr></thead>
          <tbody>
            ${results.map((c, i) => `
              <tr>
                <td><input type="checkbox" data-select="${i}" ${selected.has(i) ? "checked" : ""} /></td>
                <td>${c.name}</td>
                <td>${c.website || "—"}</td>
                <td>${c.industry || "—"}</td>
                <td>${c.employees ?? "—"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        ${loadMoreBarHtml()}
      `;
    }
    const loadMoreBtn = document.getElementById("apollo-search-load-more-btn");
    if (loadMoreBtn) loadMoreBtn.addEventListener("click", () => runSearch(true));
    resultsEl.querySelectorAll("[data-select]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const i = Number(cb.dataset.select);
        if (cb.checked) selected.add(i); else selected.delete(i);
        const countEl = document.getElementById("apollo-search-selected-count");
        if (countEl) countEl.textContent = `${selected.size} selected`;
      });
    });
    document.getElementById("apollo-search-import-btn").addEventListener("click", importSelectedApolloSearch);
  }

  async function importSelectedApolloSearch() {
    if (!selected.size) { toast(`Select at least one ${isPeople ? "person" : "company"}`, "error"); return; }
    const btn = document.getElementById("apollo-search-import-btn");
    btn.disabled = true;
    let count = 0;
    for (const i of selected) {
      const row = results[i];
      try {
        if (isPeople) {
          await api("/api/prospecting/import-contact", {
            method: "POST",
            body: {
              first_name: row.first_name, last_name: row.last_name, email: row.email, phone: row.phone,
              title: row.title, linkedin_url: row.linkedin_url,
              organization_name: row.organization_name, organization_website: row.organization_website,
            },
          });
        } else {
          await api("/api/prospecting/import-company", {
            method: "POST",
            body: {
              name: row.name, website: row.website, industry: row.industry, phone: row.phone,
              revenue: row.revenue, address: row.address, linkedin_url: row.linkedin_url,
            },
          });
        }
        count++;
      } catch (err) {
        toast(`${isPeople ? `${row.first_name} ${row.last_name}` : row.name}: ${err.message}`, "error");
      }
    }
    toast(`Imported ${count} ${count === 1 ? (isPeople ? "contact" : "account") : (isPeople ? "contacts" : "accounts")}`, count ? "success" : "error");
    selected = new Set();
    await loadAll();
    btn.disabled = false;
    if (isPeople) renderContacts(); else renderAccounts();
    renderResults();
  }

  async function runSearch(append = false) {
    const resultsEl = document.getElementById("apollo-search-results");
    if (append) {
      currentPage += 1;
      const loadMoreBtn = document.getElementById("apollo-search-load-more-btn");
      if (loadMoreBtn) { loadMoreBtn.disabled = true; loadMoreBtn.textContent = "Loading…"; }
    } else {
      resultsEl.innerHTML = `<div class="empty-state">Searching Apollo…</div>`;
      selected = new Set();
      currentPage = 1;
    }
    const keywords = document.getElementById("apollo-search-keywords").value.trim();
    const body = {
      keywords,
      page: currentPage,
      organizationLocations: [...filters.locations],
      employeeRanges: [...filters.employeeRanges],
      industries: [...filters.industries],
    };
    if (isPeople) {
      body.titles = [...filters.titles];
      body.emailStatus = [...filters.emailStatus];
      body.personLocations = [...filters.locations];
    }
    try {
      const data = isPeople
        ? await api("/api/prospecting/search-people", { method: "POST", body })
        : await api("/api/prospecting/search-companies", { method: "POST", body });
      const page = isPeople ? data.people : data.companies;
      results = append ? results.concat(page) : page;
      totalAvailable = data.total ?? results.length;
      renderResults();
    } catch (err) {
      if (append) {
        currentPage -= 1;
        toast(err.message, "error");
        renderResults();
      } else {
        resultsEl.innerHTML = `<div class="empty-state">${err.message}</div>`;
      }
    }
  }

  openModal(`
    <h2>Search Apollo — ${isPeople ? "People" : "Companies"}</h2>
    <div class="hint" style="margin-top:0">Live search against your connected Apollo.io account — same filter categories as apollo.io itself. Needs an Apollo API key in Settings &gt; Integrations.</div>
    <div style="display:flex;gap:8px;margin:10px 0 16px">
      <input type="text" id="apollo-search-keywords" placeholder="${isPeople ? "Keywords (name, company, industry…)" : "Company name or keywords"}" style="flex:1" />
      <button type="button" class="btn btn-primary" id="apollo-search-btn">Search</button>
    </div>
    <div id="apollo-search-filters"></div>
    <div id="apollo-search-results" style="margin-top:8px"></div>
    <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Close</button></div>
  `);
  renderFilterPanel();
  renderResults();
  document.getElementById("apollo-search-btn").addEventListener("click", runSearch);
  document.getElementById("apollo-search-keywords").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
}


// ---------- Salesforce (two-way sync) ----------
// Pull = fetch recent Salesforce records, review, and import selected ones
// (same checkbox-table pattern as Prospecting). Push = send local records
// that aren't linked yet (no sf_id) out to Salesforce, one at a time or in
// bulk. Nothing syncs automatically — every action here is something a rep
// explicitly clicked, since this touches production Salesforce data.

const SF_OBJECT_LABELS = { lead: "Lead", account: "Account", contact: "Contact" };
const SF_OBJECT_PLURALS = { lead: "Leads", account: "Accounts", contact: "Contacts" };

let sfTab = "pull";
let sfPullObject = "lead";
let sfPushObject = "account";
let sfPullResults = [];
let sfPullSelected = new Set();
let sfPushSelected = new Set();

// Rendered as the "salesforce" sub-tab of the Accounts page (see
// renderAccounts()'s dispatcher above) rather than its own sidebar item --
// still gated by the same salesforce feature_access key via
// hasSalesforceAccess(), just controlling a tab's visibility now instead of
// a nav item's. The accountsTabBarHtml() header + wireAccountsTabBar() call
// in every branch below is what keeps the All Accounts / Accounts Gem /
// Salesforce tabs on screen no matter which of Salesforce's own states
// (loading, not connected, connected) is showing.
async function renderSalesforce() {
  document.getElementById("topbar-actions").innerHTML = "";
  const root = document.getElementById("view-root");
  root.innerHTML = `${accountsTabBarHtml()}<div class="panel"><div class="empty-state">Loading…</div></div>`;
  wireAccountsTabBar(root);

  let status;
  try {
    status = await api("/api/salesforce/status");
  } catch (err) {
    root.innerHTML = `${accountsTabBarHtml()}<div class="panel"><div class="empty-state">${err.message}</div></div>`;
    wireAccountsTabBar(root);
    return;
  }

  if (!status.connected) {
    const isAdmin = state.user.role === "admin";
    root.innerHTML = `
      ${accountsTabBarHtml()}
      <div class="panel">
        <div class="empty-state">
          Salesforce isn't connected yet. ${isAdmin ? "Connect it in Settings → Integrations — you'll need a Connected App set up on the Salesforce side first." : "Ask an admin to connect it in Settings → Integrations."}
        </div>
        ${isAdmin ? `<div class="modal-actions" style="justify-content:flex-start;margin-top:10px"><button class="btn btn-primary btn-small" id="sf-goto-settings">Go to Settings</button></div>` : ""}
      </div>
    `;
    wireAccountsTabBar(root);
    const btn = document.getElementById("sf-goto-settings");
    if (btn) btn.addEventListener("click", () => { settingsTab = "integrations"; switchView("settings"); });
    return;
  }

  root.innerHTML = `
    ${accountsTabBarHtml()}
    <div class="panel">
      <div class="settings-tabs" style="margin-bottom:16px">
        <div class="settings-tab ${sfTab === "pull" ? "active" : ""}" data-sf-tab="pull">Pull from Salesforce</div>
        <div class="settings-tab ${sfTab === "push" ? "active" : ""}" data-sf-tab="push">Push to Salesforce</div>
      </div>
      <div id="sf-body"></div>
    </div>
  `;
  wireAccountsTabBar(root);
  root.querySelectorAll("[data-sf-tab]").forEach((el) => {
    el.addEventListener("click", () => { sfTab = el.dataset.sfTab; renderSalesforce(); });
  });

  if (sfTab === "pull") renderSfPull();
  else renderSfPush();
}

function renderSfPull() {
  const body = document.getElementById("sf-body");
  body.innerHTML = `
    <div class="settings-tabs" style="margin-bottom:14px">
      ${["lead", "account", "contact"].map((o) => `
        <div class="settings-tab ${sfPullObject === o ? "active" : ""}" data-sf-pull-object="${o}">${SF_OBJECT_PLURALS[o]}</div>
      `).join("")}
    </div>
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
      <button class="btn btn-small btn-primary" id="sf-fetch-btn">Fetch recent ${SF_OBJECT_PLURALS[sfPullObject]}</button>
    </div>
    <div id="sf-pull-results"></div>
  `;
  body.querySelectorAll("[data-sf-pull-object]").forEach((el) => {
    el.addEventListener("click", () => {
      sfPullObject = el.dataset.sfPullObject;
      sfPullResults = [];
      sfPullSelected = new Set();
      renderSfPull();
    });
  });
  document.getElementById("sf-fetch-btn").addEventListener("click", runSfPull);
  renderSfPullResults();
}

async function runSfPull() {
  const resultsEl = document.getElementById("sf-pull-results");
  resultsEl.innerHTML = `<div class="empty-state">Fetching…</div>`;
  sfPullSelected = new Set();
  try {
    const { records } = await api(`/api/salesforce/pull/${sfPullObject}`, { method: "POST" });
    sfPullResults = records;
    renderSfPullResults();
  } catch (err) {
    resultsEl.innerHTML = `<div class="empty-state">${err.message}</div>`;
  }
}

function sfPullRowLabel(r) {
  if (sfPullObject === "lead" || sfPullObject === "contact") return [r.FirstName, r.LastName].filter(Boolean).join(" ") || "—";
  return r.Name || "—";
}

function renderSfPullResults() {
  const resultsEl = document.getElementById("sf-pull-results");
  if (!resultsEl) return;
  if (!sfPullResults.length) {
    resultsEl.innerHTML = `<div class="empty-state">Fetch ${SF_OBJECT_PLURALS[sfPullObject]} above to see the 50 most recently modified records.</div>`;
    return;
  }

  const extraCols = {
    lead: (r) => [r.Company || "—", r.Email || "—", r.Status || "—"],
    account: (r) => [r.Industry || "—", r.Website || "—", r.Phone || "—"],
    contact: (r) => [r.Account?.Name || "—", r.Title || "—", r.Email || "—"],
    opportunity: (r) => [r.Account?.Name || "—", r.Amount ? money(r.Amount) : "—", r.StageName || "—"],
  }[sfPullObject];
  const extraHeaders = {
    lead: ["Company", "Email", "Status"],
    account: ["Industry", "Website", "Phone"],
    contact: ["Account", "Title", "Email"],
    opportunity: ["Account", "Amount", "Stage"],
  }[sfPullObject];

  resultsEl.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
      <button type="button" class="btn btn-primary btn-small" id="sf-import-btn">Import selected</button>
      <span id="sf-selected-count" style="font-size:12px;color:var(--text-dim);align-self:center">${sfPullSelected.size} selected</span>
    </div>
    <table>
      <thead><tr><th></th><th>Name</th>${extraHeaders.map((h) => `<th>${h}</th>`).join("")}<th></th></tr></thead>
      <tbody>
        ${sfPullResults.map((r, i) => `
          <tr>
            <td>${r._already_linked ? "" : `<input type="checkbox" data-sf-select="${i}" ${sfPullSelected.has(i) ? "checked" : ""} />`}</td>
            <td>${sfPullRowLabel(r)}</td>
            ${extraCols(r).map((v) => `<td>${v}</td>`).join("")}
            <td>${r._already_linked ? `<span class="pill pill-active">Imported</span>` : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  resultsEl.querySelectorAll("[data-sf-select]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.sfSelect);
      if (cb.checked) sfPullSelected.add(i); else sfPullSelected.delete(i);
      document.getElementById("sf-selected-count").textContent = `${sfPullSelected.size} selected`;
    });
  });
  document.getElementById("sf-import-btn").addEventListener("click", importSelectedSfRecords);
}

async function importSelectedSfRecords() {
  if (!sfPullSelected.size) { toast("Select at least one record", "error"); return; }
  const btn = document.getElementById("sf-import-btn");
  btn.disabled = true;
  let count = 0;
  for (const i of sfPullSelected) {
    const r = sfPullResults[i];
    try {
      await api(`/api/salesforce/import/${sfPullObject}`, { method: "POST", body: { ...r, sf_id: r.Id } });
      count++;
    } catch (err) {
      toast(`${sfPullRowLabel(r)}: ${err.message}`, "error");
    }
  }
  toast(`Imported ${count} ${(count === 1 ? SF_OBJECT_LABELS[sfPullObject] : SF_OBJECT_PLURALS[sfPullObject]).toLowerCase()}`);
  sfPullSelected = new Set();
  await loadAll();
  btn.disabled = false;
  await runSfPull();
}

function renderSfPush() {
  const body = document.getElementById("sf-body");
  sfPushSelected = new Set();
  body.innerHTML = `
    <div class="settings-tabs" style="margin-bottom:14px">
      ${["account", "contact", "lead"].map((o) => `
        <div class="settings-tab ${sfPushObject === o ? "active" : ""}" data-sf-push-object="${o}">${SF_OBJECT_PLURALS[o]}</div>
      `).join("")}
    </div>
    ${sfPushObject === "lead" ? `
      <div style="margin-bottom:12px;font-size:13px;color:var(--text-dim)">Pushes as a Salesforce Lead (Company/Website/Industry) — sf_status stays a local note and isn't written back to Salesforce's own Status field.</div>
    ` : ""}
    <div id="sf-push-results"></div>
  `;
  body.querySelectorAll("[data-sf-push-object]").forEach((el) => {
    el.addEventListener("click", () => { sfPushObject = el.dataset.sfPushObject; renderSfPush(); });
  });
  renderSfPushResults();
}

function sfLocalRows() {
  if (sfPushObject === "account") return state.accounts;
  if (sfPushObject === "contact") return state.contacts;
  return state.leads;
}

function sfLocalRowLabel(row) {
  if (sfPushObject === "contact") return `${row.first_name} ${row.last_name}`;
  if (sfPushObject === "lead") return row.contact_person || row.company || "Untitled lead";
  return row.name;
}

function renderSfPushResults() {
  const resultsEl = document.getElementById("sf-push-results");
  const rows = sfLocalRows();
  if (!rows.length) {
    resultsEl.innerHTML = `<div class="empty-state">No local ${sfPushObject === "lead" ? "leads" : sfPushObject + "s"} yet.</div>`;
    return;
  }
  resultsEl.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:10px">
      <button type="button" class="btn btn-primary btn-small" id="sf-push-btn">Push selected</button>
      <span id="sf-push-selected-count" style="font-size:12px;color:var(--text-dim);align-self:center">${sfPushSelected.size} selected</span>
    </div>
    <table>
      <thead><tr><th></th><th>Name</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${row.sf_id ? "" : `<input type="checkbox" data-sf-push-select="${row.id}" ${sfPushSelected.has(row.id) ? "checked" : ""} />`}</td>
            <td>${sfLocalRowLabel(row)}</td>
            <td>${row.sf_id ? `<span class="pill pill-active">Synced${row.sf_object_type ? " · " + row.sf_object_type : ""}</span>` : `<span class="pill pill-inactive">Not synced</span>`}</td>
            <td>${row.sf_id ? `<button class="btn btn-small" data-sf-resync="${row.id}">Sync update</button>` : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  resultsEl.querySelectorAll("[data-sf-push-select]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.sfPushSelect);
      if (cb.checked) sfPushSelected.add(id); else sfPushSelected.delete(id);
      document.getElementById("sf-push-selected-count").textContent = `${sfPushSelected.size} selected`;
    });
  });
  document.getElementById("sf-push-btn").addEventListener("click", () => pushSelectedToSalesforce([...sfPushSelected]));
  resultsEl.querySelectorAll("[data-sf-resync]").forEach((btn) => {
    btn.addEventListener("click", () => pushSelectedToSalesforce([Number(btn.dataset.sfResync)]));
  });
}

async function pushOneToSalesforce(id) {
  if (sfPushObject === "account") return api(`/api/accounts/${id}/push-salesforce`, { method: "POST" });
  if (sfPushObject === "contact") return api(`/api/contacts/${id}/push-salesforce`, { method: "POST" });
  return api(`/api/leads/${id}/push-salesforce`, { method: "POST" });
}

async function pushSelectedToSalesforce(ids) {
  if (!ids.length) { toast("Select at least one record", "error"); return; }
  const btn = document.getElementById("sf-push-btn");
  if (btn) btn.disabled = true;
  let count = 0;
  for (const id of ids) {
    try {
      await pushOneToSalesforce(id);
      count++;
    } catch (err) {
      toast(`${sfLocalRowLabel(byId(sfLocalRows(), id))}: ${err.message}`, "error");
    }
  }
  toast(`Pushed ${count} record${count === 1 ? "" : "s"} to Salesforce`);
  sfPushSelected = new Set();
  await loadAll();
  renderSfPushResults();
}

// ---------- Emailing (native templates, lists & sequences — no Apollo) ----------
// Fully self-contained: templates, lists, sequences and the send log all
// live in this app's own data store. Sends go out through the same SMTP
// config as leave/report notifications; if it isn't configured, sends are
// still logged here with sent:false so the flow is fully visible either way.

const MERGE_FIELD_HINT = `<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">Merge fields: {{first_name}} {{last_name}} {{company}} {{title}} {{sender_name}}</div>`;

let emailingTab = "sequencing";
let emailingSequences = [];
let emailingTemplates = [];
let emailingLists = [];
let emailingEmails = [];
let emailingReplies = [];

async function renderEmailing() {
  document.getElementById("topbar-actions").innerHTML = "";
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  try {
    const [sequences, templates, lists, emails, replies] = await Promise.all([
      api("/api/emailing/sequences"),
      api("/api/emailing/templates"),
      api("/api/emailing/lists"),
      api("/api/emailing/emails"),
      api("/api/outlook/inbox"),
    ]);
    emailingSequences = sequences;
    emailingTemplates = templates;
    emailingLists = lists;
    emailingEmails = emails;
    emailingReplies = replies;
  } catch (err) {
    root.innerHTML = `<div class="panel"><div class="empty-state">${err.message}</div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="panel">
      <div class="settings-tabs" style="margin-bottom:16px">
        <div class="settings-tab ${emailingTab === "sequencing" ? "active" : ""}" data-emailing-tab="sequencing">Sequencing</div>
        <div class="settings-tab ${emailingTab === "emails" ? "active" : ""}" data-emailing-tab="emails">Emails</div>
        <div class="settings-tab ${emailingTab === "replies" ? "active" : ""}" data-emailing-tab="replies">Replies</div>
        <div class="settings-tab ${emailingTab === "templates" ? "active" : ""}" data-emailing-tab="templates">Templates</div>
        <div class="settings-tab ${emailingTab === "lists" ? "active" : ""}" data-emailing-tab="lists">Lists</div>
      </div>
      <div id="emailing-body"></div>
    </div>
  `;
  root.querySelectorAll("[data-emailing-tab]").forEach((el) => {
    el.addEventListener("click", () => { emailingTab = el.dataset.emailingTab; renderEmailing(); });
  });

  if (emailingTab === "sequencing") renderEmailingSequencing();
  else if (emailingTab === "templates") renderEmailingTemplates();
  else if (emailingTab === "lists") renderEmailingLists();
  else if (emailingTab === "replies") renderEmailingReplies();
  else renderEmailingEmails();
}

async function refreshEmailingSequences() {
  emailingSequences = await api("/api/emailing/sequences");
}

// -- Sequencing --

// Small shared helper used by every Emailing sub-tab below: a one-line
// search box (+ optional extra <select> controls passed in as HTML) above
// the tab's table, all following the same module-level-filter-state pattern
// as Contacts/Accounts/Leads/Activity Report.
function renderMiniFilterBar({ id, searchValue, searchPlaceholder, extraHtml, resultLabel }) {
  return `
    <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px;margin-bottom:12px">
      <input type="text" id="${id}-search" placeholder="${searchPlaceholder}" value="${escapeAttr(searchValue)}" style="flex:1;min-width:160px" />
      ${extraHtml || ""}
      <span style="font-size:12px;color:var(--text-dim);margin-left:auto">${resultLabel}</span>
    </div>
  `;
}

let sequencingFilters = { search: "", status: "" };
function sequenceMatchesFilters(s) {
  const f = sequencingFilters;
  if (f.status === "active" && !s.active) return false;
  if (f.status === "inactive" && s.active) return false;
  if (f.search && !s.name.toLowerCase().includes(f.search.toLowerCase())) return false;
  return true;
}

function renderEmailingSequencing() {
  const body = document.getElementById("emailing-body");
  const rows = emailingSequences.filter(sequenceMatchesFilters);
  body.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:12px">
      <button class="btn btn-primary btn-small" id="seq-new-btn">+ New sequence</button>
      <button class="btn btn-small" id="seq-process-due-btn">Send due emails now</button>
    </div>
    ${renderMiniFilterBar({
      id: "seq-filter", searchValue: sequencingFilters.search, searchPlaceholder: "Search sequence name…",
      extraHtml: `
        <select id="seq-filter-status" style="width:auto">
          <option value="">All statuses</option>
          <option value="active" ${sequencingFilters.status === "active" ? "selected" : ""}>Active</option>
          <option value="inactive" ${sequencingFilters.status === "inactive" ? "selected" : ""}>Inactive</option>
        </select>
      `,
      resultLabel: `${rows.length} of ${emailingSequences.length} sequences`,
    })}
    ${!emailingSequences.length ? `<div class="empty-state">No sequences yet. Create one to start a multi-step outreach cadence — every step is editable right here.</div>` : !rows.length ? `<div class="empty-state">No sequences match these filters.</div>` : `
    <table>
      <thead><tr><th>Name</th><th>Steps</th><th>Status</th><th>Active enrollments</th><th>Completed</th><th></th></tr></thead>
      <tbody>
        ${rows.map((s) => `
          <tr>
            <td>${s.name}</td>
            <td>${(s.steps || []).length}</td>
            <td><span class="pill ${s.active ? "pill-active" : "pill-inactive"}">${s.active ? "Active" : "Inactive"}</span></td>
            <td>${s.enrolled_count}</td>
            <td>${s.completed_count}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-small" data-seq-enroll="${s.id}">Enroll</button>
              <button class="btn btn-small" data-seq-view="${s.id}">Enrollments</button>
              <button class="btn btn-small" data-seq-edit="${s.id}">Edit</button>
              <button class="btn btn-small" data-seq-toggle="${s.id}">${s.active ? "Deactivate" : "Activate"}</button>
              <button class="btn btn-small btn-danger" data-seq-delete="${s.id}">Delete</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    `}
    <div id="seq-enrollments-panel" style="margin-top:20px"></div>
  `;
  document.getElementById("seq-new-btn").addEventListener("click", () => openSequenceModal(null));
  document.getElementById("seq-process-due-btn").addEventListener("click", runProcessDue);
  const seqSearchEl = document.getElementById("seq-filter-search");
  seqSearchEl.addEventListener("input", (e) => {
    sequencingFilters.search = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderEmailingSequencing();
    const el = document.getElementById("seq-filter-search");
    if (el) { el.focus(); el.setSelectionRange(cursorPos, cursorPos); }
  });
  document.getElementById("seq-filter-status").addEventListener("change", (e) => {
    sequencingFilters.status = e.target.value;
    renderEmailingSequencing();
  });
  body.querySelectorAll("[data-seq-enroll]").forEach((btn) => btn.addEventListener("click", () => openEnrollModal(byId(emailingSequences, btn.dataset.seqEnroll))));
  body.querySelectorAll("[data-seq-view]").forEach((btn) => btn.addEventListener("click", () => showSequenceEnrollments(byId(emailingSequences, btn.dataset.seqView))));
  body.querySelectorAll("[data-seq-edit]").forEach((btn) => btn.addEventListener("click", () => openSequenceModal(byId(emailingSequences, btn.dataset.seqEdit))));
  body.querySelectorAll("[data-seq-toggle]").forEach((btn) => btn.addEventListener("click", () => toggleSequenceActive(byId(emailingSequences, btn.dataset.seqToggle))));
  body.querySelectorAll("[data-seq-delete]").forEach((btn) => btn.addEventListener("click", () => deleteSequence(Number(btn.dataset.seqDelete))));
}

async function runProcessDue() {
  const btn = document.getElementById("seq-process-due-btn");
  if (btn) btn.disabled = true;
  try {
    const { processed } = await api("/api/emailing/process-due", { method: "POST" });
    toast(processed ? `Sent ${processed} email${processed === 1 ? "" : "s"}` : "No emails due right now");
    await refreshEmailingSequences();
    emailingEmails = await api("/api/emailing/emails");
    renderEmailingSequencing();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function toggleSequenceActive(seq) {
  if (!seq) return;
  await api(`/api/emailing/sequences/${seq.id}`, { method: "PUT", body: { active: !seq.active } });
  toast(seq.active ? "Sequence deactivated" : "Sequence activated");
  await refreshEmailingSequences();
  renderEmailingSequencing();
}

async function deleteSequence(id) {
  if (!confirm("Delete this sequence? Enrolled contacts will be removed from it.")) return;
  await api(`/api/emailing/sequences/${id}`, { method: "DELETE" });
  toast("Sequence deleted");
  await refreshEmailingSequences();
  renderEmailingSequencing();
}

// Full step-builder: add/remove/reorder steps, each with its own subject,
// body and delay — this is the "all the steps show here" editor, not a
// summary of steps defined somewhere else.
function openSequenceModal(seq) {
  const steps = seq && seq.steps && seq.steps.length
    ? seq.steps.map((s) => ({ delay_days: s.delay_days || 0, subject: s.subject || "", body: s.body || "" }))
    : [{ delay_days: 0, subject: "", body: "" }];

  function stepRowHtml(step, idx) {
    return `
      <div class="step-row" data-step-idx="${idx}" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
          <strong>Step ${idx + 1}</strong>
          ${idx > 0
            ? `<label style="display:flex;align-items:center;gap:6px;font-weight:normal;font-size:12px;color:var(--text-dim)">Wait <input type="number" min="0" data-step-delay="${idx}" value="${step.delay_days}" style="width:56px;padding:4px 6px" /> day(s) after the previous step</label>`
            : `<span style="font-size:12px;color:var(--text-dim)">Sends immediately on enrollment</span>`}
          <div style="display:flex;gap:6px">
            <button type="button" class="btn btn-small" data-step-up="${idx}" ${idx === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="btn btn-small" data-step-down="${idx}" ${idx === steps.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" class="btn btn-small btn-danger" data-step-remove="${idx}">Remove</button>
          </div>
        </div>
        <label>Subject</label><input data-step-subject="${idx}" value="${escapeAttr(step.subject)}" placeholder="e.g. Quick intro from {{sender_name}} at AccelQ" />
        <label>Body</label><textarea data-step-body="${idx}" class="draft-font" rows="4" placeholder="Hi {{first_name}}, …">${step.body}</textarea>
      </div>
    `;
  }

  function wireStepHandlers() {
    const list = document.getElementById("seq-steps-list");
    list.querySelectorAll("[data-step-subject]").forEach((el) => el.addEventListener("input", () => { steps[Number(el.dataset.stepSubject)].subject = el.value; }));
    list.querySelectorAll("[data-step-body]").forEach((el) => el.addEventListener("input", () => { steps[Number(el.dataset.stepBody)].body = el.value; }));
    list.querySelectorAll("[data-step-delay]").forEach((el) => el.addEventListener("input", () => { steps[Number(el.dataset.stepDelay)].delay_days = Number(el.value) || 0; }));
    list.querySelectorAll("[data-step-remove]").forEach((el) => el.addEventListener("click", () => {
      if (steps.length <= 1) { toast("A sequence needs at least one step", "error"); return; }
      steps.splice(Number(el.dataset.stepRemove), 1);
      renderStepsInto();
    }));
    list.querySelectorAll("[data-step-up]").forEach((el) => el.addEventListener("click", () => {
      const i = Number(el.dataset.stepUp);
      if (i > 0) { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; renderStepsInto(); }
    }));
    list.querySelectorAll("[data-step-down]").forEach((el) => el.addEventListener("click", () => {
      const i = Number(el.dataset.stepDown);
      if (i < steps.length - 1) { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; renderStepsInto(); }
    }));
  }

  function renderStepsInto() {
    document.getElementById("seq-steps-list").innerHTML = steps.map(stepRowHtml).join("");
    wireStepHandlers();
  }

  openModal(`
    <h2>${seq ? "Edit sequence" : "New sequence"}</h2>
    <form id="seq-form">
      <label>Sequence name</label><input name="name" value="${escapeAttr(seq?.name || "")}" required />
      <div style="margin:12px 0 4px"><strong>Steps</strong></div>
      ${MERGE_FIELD_HINT}
      <div id="seq-steps-list"></div>
      <button type="button" class="btn btn-small" id="seq-add-step-btn">+ Add step</button>
      <div class="error-text" id="seq-form-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${seq ? "Save changes" : "Create sequence"}</button>
      </div>
    </form>
  `, { wide: true });

  renderStepsInto();
  document.getElementById("seq-add-step-btn").addEventListener("click", () => {
    steps.push({ delay_days: 2, subject: "", body: "" });
    renderStepsInto();
  });
  document.getElementById("seq-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value;
    const cleanSteps = steps.filter((s) => s.subject.trim() || s.body.trim());
    if (!cleanSteps.length) {
      document.getElementById("seq-form-error").textContent = "Add at least one step with a subject or body.";
      return;
    }
    try {
      if (seq) {
        await api(`/api/emailing/sequences/${seq.id}`, { method: "PUT", body: { name, steps: cleanSteps } });
        toast("Sequence updated");
      } else {
        await api("/api/emailing/sequences", { method: "POST", body: { name, steps: cleanSteps, active: true } });
        toast("Sequence created");
      }
      closeModal();
      await refreshEmailingSequences();
      renderEmailingSequencing();
    } catch (err) {
      document.getElementById("seq-form-error").textContent = err.message;
    }
  });
}

async function openEnrollModal(seq) {
  if (!seq) return;
  const activeEnrollments = await api(`/api/emailing/sequences/${seq.id}/enrollments`);
  const alreadyActive = new Set(activeEnrollments.filter((e) => e.status === "active").map((e) => e.contact_id));
  const selected = new Set();

  openModal(`
    <h2>Enroll contacts — ${seq.name}</h2>
    <label>From a list (optional)</label>
    <select id="enroll-list-select">
      <option value="">— Select individually below —</option>
      ${emailingLists.map((l) => `<option value="${l.id}">${escapeAttr(l.name)} (${(l.contact_ids || []).length})</option>`).join("")}
    </select>
    <label>Or pick contacts</label>
    <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
      ${state.contacts.map((c) => `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-weight:normal">
          <input type="checkbox" data-enroll-contact="${c.id}" style="width:auto" ${alreadyActive.has(c.id) ? "disabled" : ""} />
          ${c.first_name} ${c.last_name} <span style="color:var(--text-dim);font-size:12px">${c.email || "no email"}${alreadyActive.has(c.id) ? " · already enrolled" : ""}</span>
        </label>
      `).join("")}
    </div>
    <div class="error-text" id="enroll-form-error"></div>
    <div class="modal-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="enroll-submit-btn">Enroll</button>
    </div>
  `, { wide: true });

  document.querySelectorAll("[data-enroll-contact]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.enrollContact);
      if (cb.checked) selected.add(id); else selected.delete(id);
    });
  });

  document.getElementById("enroll-submit-btn").addEventListener("click", async () => {
    const listId = document.getElementById("enroll-list-select").value;
    if (!selected.size && !listId) {
      document.getElementById("enroll-form-error").textContent = "Pick at least one contact or a list.";
      return;
    }
    try {
      const { enrolled } = await api(`/api/emailing/sequences/${seq.id}/enroll`, {
        method: "POST",
        body: { contact_ids: [...selected], list_id: listId || undefined },
      });
      toast(`Enrolled ${enrolled} contact${enrolled === 1 ? "" : "s"}`);
      closeModal();
      await refreshEmailingSequences();
      renderEmailingSequencing();
    } catch (err) {
      document.getElementById("enroll-form-error").textContent = err.message;
    }
  });
}

async function showSequenceEnrollments(seq) {
  if (!seq) return;
  const panel = document.getElementById("seq-enrollments-panel");
  panel.innerHTML = `<div class="empty-state">Loading enrollments…</div>`;
  const enrollments = await api(`/api/emailing/sequences/${seq.id}/enrollments`);
  if (!enrollments.length) {
    panel.innerHTML = `<div class="empty-state">No one enrolled in "${seq.name}" yet.</div>`;
    return;
  }
  const statusPill = { active: "pill-active", paused: "pill-inactive", completed: "pill-active", stopped: "pill-lost" };
  panel.innerHTML = `
    <h3 style="margin-bottom:10px">Enrollments — ${seq.name}</h3>
    <table>
      <thead><tr><th>Contact</th><th>Status</th><th>Step</th><th>Next send</th><th></th></tr></thead>
      <tbody>
        ${enrollments.map((e) => `
          <tr>
            <td>${e.contact_name}${e.contact_email ? ` <span style="color:var(--text-dim);font-size:12px">(${e.contact_email})</span>` : ""}</td>
            <td><span class="pill ${statusPill[e.status] || "pill-inactive"}">${e.status}</span></td>
            <td>${Math.min(e.current_step + 1, (seq.steps || []).length)} / ${(seq.steps || []).length}</td>
            <td>${e.status === "active" && e.next_send_at ? new Date(e.next_send_at).toLocaleString() : "—"}</td>
            <td style="white-space:nowrap">
              ${e.status === "active" ? `<button class="btn btn-small" data-enr-pause="${e.id}">Pause</button>` : ""}
              ${e.status === "paused" ? `<button class="btn btn-small" data-enr-resume="${e.id}">Resume</button>` : ""}
              ${["active", "paused"].includes(e.status) ? `<button class="btn btn-small btn-danger" data-enr-stop="${e.id}">Stop</button>` : ""}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  panel.querySelectorAll("[data-enr-pause]").forEach((btn) => btn.addEventListener("click", () => enrollmentAction(btn.dataset.enrPause, "pause", seq)));
  panel.querySelectorAll("[data-enr-resume]").forEach((btn) => btn.addEventListener("click", () => enrollmentAction(btn.dataset.enrResume, "resume", seq)));
  panel.querySelectorAll("[data-enr-stop]").forEach((btn) => btn.addEventListener("click", () => enrollmentAction(btn.dataset.enrStop, "stop", seq)));
}

async function enrollmentAction(id, action, seq) {
  await api(`/api/emailing/enrollments/${id}/${action}`, { method: "POST" });
  toast(`Enrollment ${action}d`);
  await refreshEmailingSequences();
  showSequenceEnrollments(byId(emailingSequences, seq.id));
}

// -- Templates --

let templatesFilters = { search: "" };
function templateMatchesFilters(t) {
  if (!templatesFilters.search) return true;
  const q = templatesFilters.search.toLowerCase();
  return `${t.name} ${t.subject}`.toLowerCase().includes(q);
}

function renderEmailingTemplates() {
  const body = document.getElementById("emailing-body");
  const rows = emailingTemplates.filter(templateMatchesFilters);
  body.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:12px">
      <button class="btn btn-primary btn-small" id="tpl-new-btn">+ New template</button>
    </div>
    ${renderMiniFilterBar({
      id: "tpl-filter", searchValue: templatesFilters.search, searchPlaceholder: "Search name, subject…",
      resultLabel: `${rows.length} of ${emailingTemplates.length} templates`,
    })}
    ${!emailingTemplates.length ? `<div class="empty-state">No templates yet.</div>` : !rows.length ? `<div class="empty-state">No templates match this search.</div>` : `
    <table>
      <thead><tr><th>Name</th><th>Subject</th><th></th></tr></thead>
      <tbody>
        ${rows.map((t) => `
          <tr>
            <td>${t.name}</td>
            <td>${t.subject}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-small" data-tpl-edit="${t.id}">Edit</button>
              <button class="btn btn-small btn-danger" data-tpl-delete="${t.id}">Delete</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    `}
  `;
  document.getElementById("tpl-new-btn").addEventListener("click", () => openTemplateModal(null));
  const tplSearchEl = document.getElementById("tpl-filter-search");
  tplSearchEl.addEventListener("input", (e) => {
    templatesFilters.search = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderEmailingTemplates();
    const el = document.getElementById("tpl-filter-search");
    if (el) { el.focus(); el.setSelectionRange(cursorPos, cursorPos); }
  });
  body.querySelectorAll("[data-tpl-edit]").forEach((btn) => btn.addEventListener("click", () => openTemplateModal(byId(emailingTemplates, btn.dataset.tplEdit))));
  body.querySelectorAll("[data-tpl-delete]").forEach((btn) => btn.addEventListener("click", () => deleteTemplate(Number(btn.dataset.tplDelete))));
}

function openTemplateModal(tpl) {
  openModal(`
    <h2>${tpl ? "Edit template" : "New template"}</h2>
    <form id="tpl-form">
      <label>Name</label><input name="name" value="${escapeAttr(tpl?.name || "")}" required />
      <label>Subject</label><input name="subject" value="${escapeAttr(tpl?.subject || "")}" required />
      <label>Body</label>
      ${MERGE_FIELD_HINT}
      <textarea name="body" class="draft-font" rows="6">${tpl?.body || ""}</textarea>
      <div class="error-text" id="tpl-form-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${tpl ? "Save changes" : "Create template"}</button>
      </div>
    </form>
  `);
  document.getElementById("tpl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      if (tpl) await api(`/api/emailing/templates/${tpl.id}`, { method: "PUT", body: fd });
      else await api("/api/emailing/templates", { method: "POST", body: fd });
      toast(tpl ? "Template updated" : "Template created");
      closeModal();
      emailingTemplates = await api("/api/emailing/templates");
      renderEmailingTemplates();
    } catch (err) {
      document.getElementById("tpl-form-error").textContent = err.message;
    }
  });
}

async function deleteTemplate(id) {
  if (!confirm("Delete this template?")) return;
  await api(`/api/emailing/templates/${id}`, { method: "DELETE" });
  toast("Template deleted");
  emailingTemplates = await api("/api/emailing/templates");
  renderEmailingTemplates();
}

// -- Lists --

let listsFilters = { search: "" };
function listMatchesFilters(l) {
  if (!listsFilters.search) return true;
  return l.name.toLowerCase().includes(listsFilters.search.toLowerCase());
}

function renderEmailingLists() {
  const body = document.getElementById("emailing-body");
  const rows = emailingLists.filter(listMatchesFilters);
  body.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:12px">
      <button class="btn btn-primary btn-small" id="list-new-btn">+ New list</button>
    </div>
    ${renderMiniFilterBar({
      id: "list-filter", searchValue: listsFilters.search, searchPlaceholder: "Search list name…",
      resultLabel: `${rows.length} of ${emailingLists.length} lists`,
    })}
    ${!emailingLists.length ? `<div class="empty-state">No lists yet.</div>` : !rows.length ? `<div class="empty-state">No lists match this search.</div>` : `
    <table>
      <thead><tr><th>Name</th><th>Contacts</th><th></th></tr></thead>
      <tbody>
        ${rows.map((l) => `
          <tr>
            <td>${l.name}</td>
            <td>${(l.contact_ids || []).length}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-small" data-list-manage="${l.id}">Manage contacts</button>
              <button class="btn btn-small btn-danger" data-list-delete="${l.id}">Delete</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    `}
  `;
  document.getElementById("list-new-btn").addEventListener("click", () => openListModal(null));
  const listSearchEl = document.getElementById("list-filter-search");
  listSearchEl.addEventListener("input", (e) => {
    listsFilters.search = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderEmailingLists();
    const el = document.getElementById("list-filter-search");
    if (el) { el.focus(); el.setSelectionRange(cursorPos, cursorPos); }
  });
  body.querySelectorAll("[data-list-manage]").forEach((btn) => btn.addEventListener("click", () => openListModal(byId(emailingLists, btn.dataset.listManage))));
  body.querySelectorAll("[data-list-delete]").forEach((btn) => btn.addEventListener("click", () => deleteList(Number(btn.dataset.listDelete))));
}

function openListModal(list) {
  const selected = new Set(list ? list.contact_ids || [] : []);
  openModal(`
    <h2>${list ? "Manage list" : "New list"}</h2>
    <form id="list-form">
      <label>List name</label><input name="name" value="${escapeAttr(list?.name || "")}" required />
      <label>Contacts</label>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
        ${state.contacts.map((c) => `
          <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-weight:normal">
            <input type="checkbox" data-list-contact="${c.id}" style="width:auto" ${selected.has(c.id) ? "checked" : ""} />
            ${c.first_name} ${c.last_name} <span style="color:var(--text-dim);font-size:12px">${accountName(c.account_id)}</span>
          </label>
        `).join("")}
      </div>
      <div class="error-text" id="list-form-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${list ? "Save changes" : "Create list"}</button>
      </div>
    </form>
  `, { wide: true });
  document.querySelectorAll("[data-list-contact]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.listContact);
      if (cb.checked) selected.add(id); else selected.delete(id);
    });
  });
  document.getElementById("list-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value;
    const contact_ids = [...selected];
    try {
      if (list) await api(`/api/emailing/lists/${list.id}`, { method: "PUT", body: { name, contact_ids } });
      else await api("/api/emailing/lists", { method: "POST", body: { name, contact_ids } });
      toast(list ? "List updated" : "List created");
      closeModal();
      emailingLists = await api("/api/emailing/lists");
      renderEmailingLists();
    } catch (err) {
      document.getElementById("list-form-error").textContent = err.message;
    }
  });
}

async function deleteList(id) {
  if (!confirm("Delete this list?")) return;
  await api(`/api/emailing/lists/${id}`, { method: "DELETE" });
  toast("List deleted");
  emailingLists = await api("/api/emailing/lists");
  renderEmailingLists();
}

// -- Emails (one-off send + log) --

let emailsFilters = { search: "", status: "", source: "" };
function emailMatchesFilters(m) {
  const f = emailsFilters;
  if (f.status === "sent" && !m.sent) return false;
  if (f.status === "not_sent" && m.sent) return false;
  if (f.source === "sequence" && !m.sequence_id) return false;
  if (f.source === "oneoff" && m.sequence_id) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const haystack = `${m.contact_name || ""} ${m.subject || ""} ${m.to || ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function renderEmailingEmails() {
  const body = document.getElementById("emailing-body");
  const stepRows = emailingEmailsStepFilter === "fresh"
    ? emailingEmails.filter((m) => m.step_order === null || m.step_order === undefined)
    : emailingEmailsStepFilter
    ? emailingEmails.filter((m) => m.step_order === emailingEmailsStepFilter)
    : emailingEmails;
  const rows = stepRows.filter(emailMatchesFilters);
  const filtersActive = Boolean(emailsFilters.search || emailsFilters.status || emailsFilters.source);
  body.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-primary btn-small" id="email-send-btn">+ Send email</button>
      ${emailingEmailsStepFilter ? `
        <span class="pill pill-new">Showing: ${emailingEmailsStepFilter === "fresh" ? "Fresh Email" : `${FOLLOWUP_ORDINALS[emailingEmailsStepFilter - 1] || emailingEmailsStepFilter} Followup`} sends</span>
        <button type="button" class="btn btn-small" id="clear-step-filter-btn">Clear filter</button>
      ` : ""}
    </div>
    ${renderMiniFilterBar({
      id: "email-filter", searchValue: emailsFilters.search, searchPlaceholder: "Search contact, subject…",
      extraHtml: `
        <select id="email-filter-status" style="width:auto">
          <option value="">All statuses</option>
          <option value="sent" ${emailsFilters.status === "sent" ? "selected" : ""}>Sent</option>
          <option value="not_sent" ${emailsFilters.status === "not_sent" ? "selected" : ""}>Not sent</option>
        </select>
        <select id="email-filter-source" style="width:auto">
          <option value="">All sources</option>
          <option value="sequence" ${emailsFilters.source === "sequence" ? "selected" : ""}>Sequence</option>
          <option value="oneoff" ${emailsFilters.source === "oneoff" ? "selected" : ""}>One-off</option>
        </select>
      `,
      resultLabel: `${rows.length} of ${stepRows.length} emails`,
    })}
    ${!stepRows.length ? `<div class="empty-state">${emailingEmailsStepFilter === "fresh" ? "No Fresh Email sends yet." : emailingEmailsStepFilter ? "No emails sent yet at this follow-up stage." : "No emails sent yet."}</div>` : !rows.length ? `<div class="empty-state">${filtersActive ? "No emails match these filters." : "No emails sent yet."}</div>` : `
    <table>
      <thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>Source</th><th>Sent via</th><th>Status</th></tr></thead>
      <tbody>
        ${rows.map((m) => `
          <tr>
            <td>${new Date(m.sent_at).toLocaleString()}</td>
            <td>${m.contact_name}${m.to ? ` <span style="color:var(--text-dim);font-size:12px">(${m.to})</span>` : ""}</td>
            <td>${m.subject}</td>
            <td>${m.sequence_id ? `Sequence · step ${m.step_order}` : "One-off"}</td>
            <td>${{ outlook: "Outlook", smtp: "Shared mailbox", smtp_fallback: "Shared mailbox (fallback)" }[m.via] || "—"}</td>
            <td>${m.sent ? `<span class="pill pill-active">Sent</span>` : `<span class="pill pill-inactive" title="${escapeAttr(m.reason || "")}">Not sent</span>`}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    `}
  `;
  document.getElementById("email-send-btn").addEventListener("click", openSendEmailModal);
  const clearBtn = document.getElementById("clear-step-filter-btn");
  if (clearBtn) clearBtn.addEventListener("click", () => { emailingEmailsStepFilter = null; renderEmailingEmails(); });
  const emailSearchEl = document.getElementById("email-filter-search");
  emailSearchEl.addEventListener("input", (e) => {
    emailsFilters.search = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderEmailingEmails();
    const el = document.getElementById("email-filter-search");
    if (el) { el.focus(); el.setSelectionRange(cursorPos, cursorPos); }
  });
  document.getElementById("email-filter-status").addEventListener("change", (e) => {
    emailsFilters.status = e.target.value;
    renderEmailingEmails();
  });
  document.getElementById("email-filter-source").addEventListener("change", (e) => {
    emailsFilters.source = e.target.value;
    renderEmailingEmails();
  });
}

// -- Replies (Outlook inbox sync) --
// Pulls recent messages from the signed-in user's own connected Outlook
// mailbox and matches senders to known Contacts by email. Only surfaces
// what a "Sync inbox" click actually found — no background polling, since
// this app has no long-lived process to run it from (Netlify Function).

let repliesFilters = { search: "", matched: "" };
function replyMatchesFilters(m) {
  const f = repliesFilters;
  if (f.matched === "matched" && !m.contact_id) return false;
  if (f.matched === "unmatched" && m.contact_id) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const haystack = `${m.from_name || ""} ${m.from_email || ""} ${m.subject || ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function renderEmailingReplies() {
  const body = document.getElementById("emailing-body");
  const rows = emailingReplies.filter(replyMatchesFilters);
  const filtersActive = Boolean(repliesFilters.search || repliesFilters.matched);
  body.innerHTML = `
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:12px">
      <button class="btn btn-primary btn-small" id="sync-inbox-btn">Sync inbox</button>
      <a class="btn btn-small" style="text-decoration:none" href="https://outlook.office.com/mail/" target="_blank" rel="noopener">Open Outlook Web App ↗</a>
      <span style="color:var(--text-dim);font-size:13px;align-self:center">Sync pulls from mailboxes connected in Settings &gt; Integrations — no mailbox connected yet? Check replies directly in Outlook Web App instead.</span>
    </div>
    ${renderMiniFilterBar({
      id: "replies-filter", searchValue: repliesFilters.search, searchPlaceholder: "Search from, subject…",
      extraHtml: `
        <select id="replies-filter-matched" style="width:auto">
          <option value="">All</option>
          <option value="matched" ${repliesFilters.matched === "matched" ? "selected" : ""}>Matched contact</option>
          <option value="unmatched" ${repliesFilters.matched === "unmatched" ? "selected" : ""}>No match</option>
        </select>
      `,
      resultLabel: `${rows.length} of ${emailingReplies.length} replies`,
    })}
    ${!emailingReplies.length ? `<div class="empty-state">No replies synced yet — connect a mailbox in Settings and click "Sync inbox."</div>` : !rows.length ? `<div class="empty-state">${filtersActive ? "No replies match these filters." : "No replies synced yet."}</div>` : `
    <table>
      <thead><tr><th>Received</th><th>Mailbox</th><th>From</th><th>Subject</th><th>Preview</th><th>Matched to</th><th></th></tr></thead>
      <tbody>
        ${rows.map((m) => `
          <tr>
            <td>${new Date(m.received_at).toLocaleString()}</td>
            <td style="color:var(--text-dim);font-size:13px">${escapeAttr(m.mailbox_email || "—")}</td>
            <td>${escapeAttr(m.from_name || m.from_email || "—")}${m.from_name ? ` <span style="color:var(--text-dim);font-size:12px">(${escapeAttr(m.from_email)})</span>` : ""}</td>
            <td>${escapeAttr(m.subject || "—")}</td>
            <td style="color:var(--text-dim);font-size:13px">${escapeAttr((m.preview || "").slice(0, 90))}${(m.preview || "").length > 90 ? "…" : ""}</td>
            <td>${m.contact_id ? `<span class="pill pill-active">Matched contact</span>` : `<span class="pill pill-inactive">No match</span>`}</td>
            <td>${m.web_link ? `<a href="${escapeAttr(m.web_link)}" target="_blank" rel="noopener">Open in Outlook</a>` : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    `}
  `;
  const repliesSearchEl = document.getElementById("replies-filter-search");
  repliesSearchEl.addEventListener("input", (e) => {
    repliesFilters.search = e.target.value;
    const cursorPos = e.target.selectionStart;
    renderEmailingReplies();
    const el = document.getElementById("replies-filter-search");
    if (el) { el.focus(); el.setSelectionRange(cursorPos, cursorPos); }
  });
  document.getElementById("replies-filter-matched").addEventListener("change", (e) => {
    repliesFilters.matched = e.target.value;
    renderEmailingReplies();
  });
  document.getElementById("sync-inbox-btn").addEventListener("click", async () => {
    const btn = document.getElementById("sync-inbox-btn");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const result = await api("/api/outlook/sync-inbox", { method: "POST" });
      if (result.errors?.length) {
        toast(`Synced with issues: ${result.errors[0]}`, "error");
      } else {
        toast(result.imported ? `Imported ${result.imported} new message(s)` : "No new messages since last sync");
      }
      emailingReplies = await api("/api/outlook/inbox");
      renderEmailingReplies();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Sync inbox";
    }
  });
}

function openSendEmailModal() {
  openModal(`
    <h2>Send email</h2>
    <form id="send-email-form">
      <label>Contact</label>
      <select name="contact_id" id="send-email-contact" required>
        <option value="">Select a contact…</option>
        ${state.contacts.map((c) => `<option value="${c.id}">${c.first_name} ${c.last_name} (${c.email || "no email"})</option>`).join("")}
      </select>
      <label>Template (optional)</label>
      <select id="send-email-template">
        <option value="">— Write custom —</option>
        ${emailingTemplates.map((t) => `<option value="${t.id}">${escapeAttr(t.name)}</option>`).join("")}
      </select>
      <label>Send from</label>
      <select name="connection_id" id="send-email-from">
        ${state.outlookConnections.length
          ? state.outlookConnections.map((c) => `<option value="${c.id}">${escapeAttr(c.email)}${c.display_name ? ` — ${escapeAttr(c.display_name)}` : ""}</option>`).join("")
          : `<option value="">Shared mailbox (no personal mailbox connected)</option>`}
      </select>
      <label>Subject</label><input name="subject" id="send-email-subject" required />
      <label>Body</label>
      ${MERGE_FIELD_HINT}
      <textarea name="body" id="send-email-body" class="draft-font" rows="6"></textarea>
      <div class="error-text" id="send-email-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Send</button>
      </div>
    </form>
  `);
  document.getElementById("send-email-template").addEventListener("change", (e) => {
    const tpl = byId(emailingTemplates, e.target.value);
    if (tpl) {
      document.getElementById("send-email-subject").value = tpl.subject;
      document.getElementById("send-email-body").value = tpl.body;
    }
  });
  document.getElementById("send-email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      const row = await api("/api/emailing/send", { method: "POST", body: fd });
      toast(row.sent ? "Email sent" : `Logged — not delivered (${row.reason || "SMTP not configured"})`, row.sent ? "success" : "error");
      closeModal();
      emailingEmails = await api("/api/emailing/emails");
      renderEmailingEmails();
    } catch (err) {
      document.getElementById("send-email-error").textContent = err.message;
    }
  });
}

// ---------- Init ----------

tryResumeSession();
