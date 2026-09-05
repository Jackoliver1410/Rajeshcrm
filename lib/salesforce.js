// Salesforce integration: OAuth 2.0 Web Server Flow against a Connected App
// the org admin creates in Salesforce Setup > App Manager, plus thin REST/SOQL
// helpers for the four objects the app syncs (Lead, Account, Contact,
// Opportunity). Unlike LinkedIn Sales Navigator, Salesforce's REST API is
// fully self-service — no partner approval needed, just a Connected App with
// OAuth enabled and the "api" + "refresh_token, offline_access" scopes.
//
// Tokens: the OAuth code exchange returns a short-lived access_token plus a
// long-lived refresh_token. We persist only the refresh_token (and the
// instance_url Salesforce hands back, which is the actual API host — not
// necessarily the same as the login/My Domain host used to start the flow).
// Every API call fetches a fresh access_token via the refresh flow rather
// than trying to cache/expire one, since call volume here is low (manual
// pull/push actions, not a live poller) and this keeps the token logic to a
// single path with no stale-cache bugs.

const API_VERSION = "v59.0";
const TIMEOUT_MS = 15000;

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

function cleanLoginUrl(url) {
  return String(url || "").trim().replace(/\/$/, "");
}

function buildAuthorizeUrl({ loginUrl, clientId, redirectUri, state }) {
  const base = cleanLoginUrl(loginUrl) || "https://login.salesforce.com";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "api refresh_token offline_access",
    state,
  });
  return `${base}/services/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode({ loginUrl, clientId, clientSecret, code, redirectUri }) {
  const base = cleanLoginUrl(loginUrl) || "https://login.salesforce.com";
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const res = await withTimeout(fetch(`${base}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }), "Salesforce token exchange");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Salesforce token exchange failed (${res.status})`);
  return data; // { access_token, refresh_token, instance_url, id, token_type }
}

async function refreshAccessToken({ loginUrl, clientId, clientSecret, refreshToken }) {
  const base = cleanLoginUrl(loginUrl) || "https://login.salesforce.com";
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const res = await withTimeout(fetch(`${base}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }), "Salesforce token refresh");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || `Salesforce token refresh failed (${res.status})`;
    const err = new Error(msg);
    err.needsReconnect = data.error === "invalid_grant";
    throw err;
  }
  return data; // { access_token, instance_url, ... }
}

// Every route handler that talks to Salesforce calls this first to get a
// live access_token + instance_url from the stored refresh_token, rather
// than threading a cached token through the call site.
async function getSession(row) {
  if (!row || !row.refresh_token) {
    const err = new Error("Salesforce isn't connected yet — connect it in Settings > Integrations.");
    err.notConnected = true;
    throw err;
  }
  const data = await refreshAccessToken({
    loginUrl: row.login_url,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    refreshToken: row.refresh_token,
  });
  return { accessToken: data.access_token, instanceUrl: data.instance_url || row.instance_url };
}

async function sfFetch(session, path, opts = {}) {
  const res = await withTimeout(fetch(`${session.instanceUrl}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  }), "Salesforce API request");
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = Array.isArray(data) ? (data[0]?.message || `Salesforce API error (${res.status})`) : (data?.message || `Salesforce API error (${res.status})`);
    throw new Error(msg);
  }
  return data;
}

async function soqlQuery(session, soql) {
  const data = await sfFetch(session, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
  return data.records || [];
}

async function createRecord(session, sobject, fields) {
  const data = await sfFetch(session, `/services/data/${API_VERSION}/sobjects/${sobject}`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
  return data.id;
}

async function updateRecord(session, sobject, id, fields) {
  await sfFetch(session, `/services/data/${API_VERSION}/sobjects/${sobject}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
  return id;
}

// Field selects + a light escape for values interpolated into SOQL (only
// used for the fixed ORDER BY/LIMIT we build ourselves — no user input goes
// into a SOQL string unescaped).
const OBJECT_QUERIES = {
  lead: `SELECT Id, FirstName, LastName, Company, Title, Email, Phone, Status, LeadSource, Website, City, State, Country, LastModifiedDate FROM Lead ORDER BY LastModifiedDate DESC LIMIT 50`,
  account: `SELECT Id, Name, Industry, Website, Phone, BillingCity, BillingState, LastModifiedDate FROM Account ORDER BY LastModifiedDate DESC LIMIT 50`,
  contact: `SELECT Id, FirstName, LastName, Title, Email, Phone, AccountId, Account.Name, LastModifiedDate FROM Contact ORDER BY LastModifiedDate DESC LIMIT 50`,
  opportunity: `SELECT Id, Name, AccountId, Account.Name, Amount, StageName, CloseDate, LastModifiedDate FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 50`,
};

const SOBJECT_NAMES = { lead: "Lead", account: "Account", contact: "Contact", opportunity: "Opportunity" };

async function pullRecords(row, objectKey) {
  const session = await getSession(row);
  const soql = OBJECT_QUERIES[objectKey];
  if (!soql) throw new Error(`Unknown Salesforce object: ${objectKey}`);
  return soqlQuery(session, soql);
}

async function pushRecord(row, objectKey, { sfId, fields }) {
  const session = await getSession(row);
  const sobject = SOBJECT_NAMES[objectKey];
  if (!sobject) throw new Error(`Unknown Salesforce object: ${objectKey}`);
  if (sfId) {
    await updateRecord(session, sobject, sfId, fields);
    return sfId;
  }
  return createRecord(session, sobject, fields);
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getSession,
  soqlQuery,
  createRecord,
  updateRecord,
  pullRecords,
  pushRecord,
  OBJECT_QUERIES,
  SOBJECT_NAMES,
};
