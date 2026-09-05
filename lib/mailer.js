// Sends notification emails (leave requests, activity reports) via SMTP.
// Configured entirely through environment variables so no secrets live in
// code or get committed anywhere:
//
//   SMTP_HOST    default "smtp.office365.com"
//   SMTP_PORT    default 587
//   SMTP_SECURE  "true" for implicit TLS (port 465); default false (STARTTLS)
//   SMTP_USER    the mailbox that authenticates and sends, e.g. rajesh.botta@accelq.com
//   SMTP_PASS    that mailbox's SMTP/app password
//   MAIL_FROM    the From address shown to recipients (defaults to SMTP_USER)
//   APP_URL      base URL used to build links inside emails
//
// If SMTP_USER / SMTP_PASS aren't set, sendMail() quietly no-ops (logs and
// resolves) so the rest of the app keeps working even before email is wired
// up, and one bad send never blocks the leave/report submission it's tied to.

let transporter = null;

function isConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.office365.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Serverless functions can freeze right after the HTTP response is
    // sent, killing any still-open connection — so callers must await
    // sendMail() rather than fire-and-forget it. These timeouts make sure
    // that await never hangs a leave/report submission for long if the
    // network can't reach the SMTP host at all.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
  return transporter;
}

// Accepts "a@x.com, b@y.com; c@z.com" (or an array) and returns a clean,
// validated array of addresses.
function parseEmailList(raw) {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,;]/);
  return parts
    .map((s) => String(s).trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

function appUrl() {
  return (process.env.APP_URL || "https://rajeshcrm.netlify.app").replace(/\/$/, "");
}

async function sendMail({ to, cc, subject, html, text }) {
  if (!to) return { sent: false, reason: "No recipient" };
  if (!isConfigured()) {
    console.log(`[mailer] SMTP not configured — skipped "${subject}" to ${to}`);
    return { sent: false, reason: "SMTP not configured" };
  }
  const attempt = (async () => {
    const t = getTransporter();
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    const info = await t.sendMail({
      from: `"SDR Outreach" <${from}>`,
      to,
      cc: cc && cc.length ? cc.join(", ") : undefined,
      subject,
      text,
      html,
    });
    return { sent: true, messageId: info.messageId };
  })();
  // Belt-and-suspenders: transport-level timeouts (see getTransporter) should
  // already bound this, but a hard outer race guarantees a leave/report
  // submission can never hang on a flaky or fully-blocked network path.
  const guard = new Promise((resolve) =>
    setTimeout(() => resolve({ sent: false, reason: "Timed out reaching mail server" }), 9000)
  );
  try {
    return await Promise.race([attempt, guard]);
  } catch (err) {
    console.error("[mailer] send failed:", err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail, parseEmailList, isConfigured, appUrl };
