// Official "Sign In with LinkedIn using OpenID Connect" -- LinkedIn's own
// supported OAuth product, completely separate from the Unipile integration
// used elsewhere in this app (lib/unipile.js). This is intentionally a much
// smaller thing: LinkedIn's official API, at any tier (including paid
// Marketing/Talent products), has no capability to search or read OTHER
// people's or companies' data for a third-party app. The ONLY thing this
// product returns is the profile of whoever clicks "Connect" -- their own
// name, email, and photo. That's a hard platform limitation, not a scope
// this app forgot to request.
//
// Two-layer setup, same shape as the Outlook/Salesforce integrations
// elsewhere in this app: one LinkedIn Developer app for the whole org
// (admin sets Client ID/Secret once in Settings, or right on the LinkedIn
// Search page), then any rep connects their own LinkedIn identity against
// it. No refresh-token dance is needed here -- unlike Outlook, this app
// never calls the LinkedIn API again after the initial connect, so only
// the resulting profile snapshot is persisted, not the access token.
const TIMEOUT_MS = 15000;
const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const SCOPES = "openid profile email";

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

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await withTimeout(fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), "LinkedIn token endpoint");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `LinkedIn token request failed (${res.status})`);
  }
  return data;
}

async function getUserInfo(accessToken) {
  const res = await withTimeout(fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  }), "LinkedIn userinfo");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error_description || `Couldn't read the connected LinkedIn profile (${res.status})`);
  }
  return data;
}

module.exports = { buildAuthorizeUrl, exchangeCode, getUserInfo };
