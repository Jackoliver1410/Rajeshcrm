// Microsoft Graph OAuth wrapper for per-user "Connect your inbox" sending.
// Two-layer setup, same shape as Salesforce elsewhere in this app:
//   1. One Azure AD app registration for the whole org (admin sets
//      Tenant ID / Client ID / Client secret once in Settings > Integrations).
//   2. Each rep then authorizes their own mailbox against that app — no
//      shared password, no SMTP credentials. Every send goes out through
//      Microsoft Graph as that rep's real Outlook identity.
//
// Like Salesforce, this app has no long-lived process to hold an access
// token in memory (it runs as a Netlify Function), so only the long-lived
// refresh_token is stored; a fresh access token is minted from it on every
// send. Microsoft may rotate the refresh_token on each use — callers must
// persist whatever comes back, or a later send can fail once the old one
// expires.

const TIMEOUT_MS = 15000;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access Mail.Send Mail.Read User.Read";

async function withTimeout(promise, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthorizeUrl({ tenantId, clientId, redirectUri, state }) {
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest({ tenantId, clientId, clientSecret, params }) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params });
  const res = await withTimeout(fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), "Microsoft token endpoint");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Microsoft token request failed (${res.status})`);
  }
  return data;
}

async function exchangeCode({ tenantId, clientId, clientSecret, code, redirectUri }) {
  return tokenRequest({
    tenantId, clientId, clientSecret,
    params: { grant_type: "authorization_code", code, redirect_uri: redirectUri, scope: SCOPES },
  });
}

async function refreshAccessToken({ tenantId, clientId, clientSecret, refreshToken }) {
  return tokenRequest({
    tenantId, clientId, clientSecret,
    params: { grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPES },
  });
}

async function getProfile(accessToken) {
  const res = await withTimeout(fetch(`${GRAPH_BASE}/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }), "Microsoft Graph /me");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Couldn't read the connected profile (${res.status})`);
  return data;
}

async function getAccessToken({ appConfig, connection }) {
  if (!appConfig?.client_id || !appConfig?.client_secret || !appConfig?.tenant_id) {
    const err = new Error("Outlook isn't set up for this organization yet — ask an admin to add the Azure app details in Settings > Integrations.");
    err.notConfigured = true;
    throw err;
  }
  if (!connection?.refresh_token) {
    const err = new Error("Connect your Outlook inbox in Settings > Integrations first.");
    err.notConnected = true;
    throw err;
  }
  return refreshAccessToken({
    tenantId: appConfig.tenant_id,
    clientId: appConfig.client_id,
    clientSecret: appConfig.client_secret,
    refreshToken: connection.refresh_token,
  });
}

// Sends as the connected user via Graph's /me/sendMail. Returns the
// (possibly rotated) refresh token so the caller can persist it — the
// access token itself is never stored, only used for this one call.
async function sendMail({ appConfig, connection, to, subject, html, text }) {
  const tokenData = await getAccessToken({ appConfig, connection });
  const res = await withTimeout(fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenData.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html || (text || "").replace(/\n/g, "<br>") },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  }), "Microsoft Graph sendMail");
  if (res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error?.message || `Outlook send failed (${res.status})`);
    err.refreshToken = tokenData.refresh_token || connection.refresh_token;
    throw err;
  }
  return { refreshToken: tokenData.refresh_token || connection.refresh_token };
}

// Reads recent Inbox messages for the "Replies" view — a real Graph read,
// not a webhook subscription (that would need a publicly reachable
// notification endpoint and renewal logic this app has no place to run,
// being a Netlify Function with no long-lived process). Reps trigger a
// sync on demand instead; `sinceISO` lets the caller only ask for messages
// received after the last sync. Returns the (possibly rotated) refresh
// token alongside the messages, same pattern as sendMail.
async function listInboxMessages({ appConfig, connection, top, sinceISO }) {
  const tokenData = await getAccessToken({ appConfig, connection });
  const params = new URLSearchParams({
    "$top": String(top || 25),
    "$orderby": "receivedDateTime desc",
    "$select": "id,subject,from,receivedDateTime,bodyPreview,webLink",
  });
  if (sinceISO) params.set("$filter", `receivedDateTime ge ${sinceISO}`);
  const res = await withTimeout(fetch(`${GRAPH_BASE}/me/mailFolders/inbox/messages?${params.toString()}`, {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
  }), "Microsoft Graph inbox messages");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A connection made before Mail.Read was added to SCOPES won't have
    // that permission on its refresh token — Microsoft rejects the read
    // with an access-denied error rather than silently degrading, so
    // surface a message that points at the actual fix (reconnect).
    const insufficientScope = res.status === 403 || /scope|permission|consent/i.test(data.error?.message || "");
    const hint = insufficientScope
      ? " Try disconnecting and reconnecting your Outlook inbox in Settings > Integrations — inbox reading needs a permission your existing connection may predate."
      : "";
    const err = new Error((data.error?.message || `Couldn't read the inbox (${res.status})`) + hint);
    err.refreshToken = tokenData.refresh_token || connection.refresh_token;
    throw err;
  }
  return { refreshToken: tokenData.refresh_token || connection.refresh_token, messages: data.value || [] };
}

module.exports = { buildAuthorizeUrl, exchangeCode, refreshAccessToken, getProfile, sendMail, listInboxMessages };
