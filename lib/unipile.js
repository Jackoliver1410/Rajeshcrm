// Unipile: a third-party API that proxies a real, logged-in LinkedIn
// session (connected via the user's own LinkedIn credentials) so this app
// can pull LinkedIn data server-side. This is NOT LinkedIn's own official
// partner API -- it's automation on top of a personal LinkedIn account, so
// treat every call here as a real action against a real LinkedIn session,
// not a free/unlimited lookup. See the rate-limit note above
// getCompanyProfile below before adding any bulk/scheduled usage.
//
// Three pieces of config are needed (all stored in the "unipile" row of the
// integrations table, entered once in Settings > Integrations):
// - api_key: the X-API-KEY header value from the Unipile dashboard.
// - dsn: this workspace's host:port, e.g. "api44.unipile.com:17403" --
//   Unipile assigns a specific subdomain/port per account, it's not a
//   shared base URL like most APIs.
// - account_id: the internal ID of the LinkedIn account Unipile is
//   proxying (from GET /accounts) -- required on every request so Unipile
//   knows which logged-in session to use.
const TIMEOUT_MS = 12000;

async function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function unipileFetch({ apiKey, dsn, path }) {
  const res = await withTimeout(fetch(`https://${dsn}${path}`, {
    headers: { "X-API-KEY": apiKey, accept: "application/json" },
  }), "Unipile request");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.detail || data?.title || `Unipile error (${res.status})`);
  }
  return data;
}

async function unipilePostFetch({ apiKey, dsn, path, body }) {
  const res = await withTimeout(fetch(`https://${dsn}${path}`, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), "Unipile request");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.detail || data?.title || `Unipile error (${res.status})`);
  }
  return data;
}

// Confirms the key/dsn/account_id combination actually works -- used by the
// Settings "Test connection" button so a typo in the DSN or a stale
// account_id is caught immediately instead of surfacing later as a cryptic
// failure on some account's LinkedIn panel.
async function listAccounts({ apiKey, dsn }) {
  const data = await unipileFetch({ apiKey, dsn, path: "/api/v1/accounts" });
  return (data.items || []).map((a) => ({
    id: a.id, name: a.name, type: a.type,
    status: a.sources?.[0]?.status || null,
  }));
}

// A company's LinkedIn public slug (e.g. "accelq") or numeric ID both work
// against this endpoint -- extractCompanyIdentifier (lib/app.js) pulls
// whichever is present out of a stored linkedin.com/company/... or
// linkedin.com/sales/company/... URL.
async function getCompanyProfile({ apiKey, dsn, accountId, identifier }) {
  if (!apiKey || !dsn || !accountId) throw new Error("Unipile isn't fully configured (need API key, DSN, and account ID)");
  if (!identifier) throw new Error("No LinkedIn company identifier to look up");
  const data = await unipileFetch({
    apiKey, dsn, path: `/api/v1/linkedin/company/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`,
  });
  // LinkedIn represents an open-ended upper bound (e.g. "10,001+") with
  // `to: null` -- render that as "10001+" rather than the literal "null".
  const range = data.employee_count_range;
  const employeeCountRange = range
    ? (range.to != null ? `${range.from}-${range.to}` : `${range.from}+`)
    : "";

  return {
    name: data.name || "",
    tagline: data.tagline || "",
    description: data.description || "",
    company_type: data.organization_type || "",
    industry: Array.isArray(data.industry) ? data.industry.join(", ") : (data.industry || ""),
    website: data.website || "",
    profile_url: data.profile_url || "",
    founded: data.foundation_date || "",
    followers_count: data.followers_count ?? null,
    employee_count: data.employee_count ?? null,
    employee_count_range: employeeCountRange,
    headquarters: (data.locations || []).find((l) => l.is_headquarter) || data.locations?.[0] || null,
    activities: Array.isArray(data.activities) ? data.activities.slice(0, 12) : [],
    hashtags: Array.isArray(data.hashtags) ? data.hashtags.map((h) => h.title).filter(Boolean) : [],
    logo: data.logo || "",
    // "Company IQ"-style headcount growth graph, when LinkedIn returns it
    // for this company/viewer combination -- not guaranteed present for
    // every page. NOTE: this endpoint does NOT return Sales Navigator's
    // AI-generated "Account IQ" panel (opportunity bullets/how-they-make-
    // money/strategic priorities/competitors), "Key people", or "Common
    // searches"/"Your personas" -- those aren't part of this API response
    // at all (confirmed by inspecting the full raw response), not a parsing
    // gap on our side. See the caller for what to do about that gap.
    headcount_growth: data.insights?.employeesCount?.growthGraph || [],
  };
}

// LinkedIn represents connection degree as strings like "DISTANCE_1" (search
// results) or "FIRST_DEGREE" (profile reads) depending on the endpoint --
// normalize both forms to the "1st/2nd/3rd+" labels reps actually recognize
// from the LinkedIn UI itself.
function connectionDegreeLabel(distance) {
  const map = {
    DISTANCE_1: "1st", DISTANCE_2: "2nd", DISTANCE_3: "3rd+",
    FIRST_DEGREE: "1st", SECOND_DEGREE: "2nd", THIRD_DEGREE: "3rd+",
    OUT_OF_NETWORK: "Out of network",
  };
  return map[distance] || "";
}

// LinkedIn's Sales Navigator search doesn't accept raw text for several of
// its filters -- it needs internal IDs, looked up first via this route.
// Used here for `type: "PERSONA"`: the connected LinkedIn seat's own saved
// Sales Navigator personas (a Sales Navigator Advanced Plus/Enterprise
// feature -- an org defines target-buyer personas once, e.g. "IT Decision
// Maker" or "Economic Buyer", and every rep on the seat can filter people
// search by them). This is real Sales Navigator configuration read straight
// from the connected account, not anything guessed or synthesized -- if the
// seat has no personas feature/plan, LinkedIn just returns an empty list
// (or Unipile surfaces a "feature not subscribed" error), which the caller
// should treat as "personas aren't available here", not a bug.
async function listSearchParameters({ apiKey, dsn, accountId, type, keywords, service = "SALES_NAVIGATOR", limit = 20 }) {
  if (!apiKey || !dsn || !accountId) throw new Error("Unipile isn't fully configured (need API key, DSN, and account ID)");
  if (!type) throw new Error("No parameter type to look up");
  const params = new URLSearchParams({ type, service, account_id: accountId, limit: String(Math.min(Math.max(limit, 1), 100)) });
  if (keywords) params.set("keywords", keywords);
  const data = await unipileFetch({ apiKey, dsn, path: `/api/v1/linkedin/search/parameters?${params.toString()}` });
  return (data.items || []).map((i) => ({ id: i.id, title: i.title, picture_url: i.picture_url || "" }));
}

async function listPersonas({ apiKey, dsn, accountId, keywords }) {
  return listSearchParameters({ apiKey, dsn, accountId, type: "PERSONA", keywords });
}

// "Key people" (decision-makers at a company, with LinkedIn connection
// degree) -- unlike getCompanyProfile above, this is a real LinkedIn
// SEARCH, not a page-content read, so it counts against LinkedIn's own
// daily search-usage limits on the connected account (Unipile's own
// guidance: keep any one route to roughly 100 actions/day per account,
// spaced out). `companyName` is matched as free text by LinkedIn's own
// search (Sales Navigator's "company" filter accepts a plain name, not
// just an internal ID), so no separate ID-resolution call is needed first.
// `keywords`, when passed, is Sales Navigator's native KEYWORDS filter
// (confirmed in Unipile's reference docs under "Sales Navigator - People")
// -- e.g. a job title like "Head of QA". `personaId` is Sales Navigator's
// native PERSONA filter (an ID from listPersonas above, i.e. one of the
// seat's own saved target-buyer personas). Either or both narrow the
// search further; with neither, the default senior/decision-maker
// seniority filter (owner/partner, C-suite, VP, director) is used instead.
async function searchKeyPeople({ apiKey, dsn, accountId, companyName, keywords, personaId, limit = 8 }) {
  if (!apiKey || !dsn || !accountId) throw new Error("Unipile isn't fully configured (need API key, DSN, and account ID)");
  if (!companyName) throw new Error("No company name to search for");
  const body = {
    api: "sales_navigator",
    category: "people",
    company: { include: [companyName] },
  };
  const trimmedKeywords = String(keywords || "").trim();
  const trimmedPersona = String(personaId || "").trim();
  if (trimmedPersona) body.persona = [trimmedPersona];
  if (trimmedKeywords) body.keywords = trimmedKeywords;
  if (!trimmedPersona && !trimmedKeywords) {
    body.seniority = { include: ["owner/partner", "cxo", "vice_president", "director"] };
  }
  const data = await unipilePostFetch({
    apiKey, dsn,
    path: `/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}&limit=${Math.min(Math.max(limit, 1), 25)}`,
    body,
  });
  return (data.items || []).filter((p) => p.type === "PEOPLE").map((p) => ({
    name: p.name || "",
    title: p.headline || p.current_positions?.[0]?.role || "",
    connection_degree: connectionDegreeLabel(p.network_distance),
    profile_url: p.public_profile_url || "",
    photo_url: p.profile_picture_url || "",
  }));
}

// Ad hoc "Account IQ" company search -- unlike getCompanyProfile above
// (which needs an exact identifier already extracted from a saved URL),
// this powers the standalone LinkedIn Search page: type a plain company
// name, get back a short list of candidates to pick from, each carrying an
// `identifier` (the search result's own id, which also works directly as
// the identifier for a later getCompanyProfile/getPersonProfile call --
// Unipile accepts either the public slug or this internal id).
async function searchCompanies({ apiKey, dsn, accountId, keywords, limit = 8 }) {
  if (!apiKey || !dsn || !accountId) throw new Error("Unipile isn't fully configured (need API key, DSN, and account ID)");
  if (!keywords) throw new Error("No company name to search for");
  const data = await unipilePostFetch({
    apiKey, dsn,
    path: `/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}&limit=${Math.min(Math.max(limit, 1), 25)}`,
    body: { api: "classic", category: "companies", keywords },
  });
  return (data.items || []).filter((c) => c.type === "COMPANY").map((c) => ({
    identifier: c.id,
    name: c.name || "",
    industry: c.industry || "",
    location: c.location || "",
    summary: c.summary || "",
    followers_count: c.followers_count ?? null,
    profile_url: c.profile_url || "",
  }));
}

// Ad hoc "Lead IQ" person search -- same idea as searchCompanies above, but
// for people. Distinct from searchKeyPeople (which is scoped to senior
// titles at ONE already-known company); this is a free-text name search
// independent of any CRM Account.
async function searchPeople({ apiKey, dsn, accountId, keywords, limit = 8 }) {
  if (!apiKey || !dsn || !accountId) throw new Error("Unipile isn't fully configured (need API key, DSN, and account ID)");
  if (!keywords) throw new Error("No name to search for");
  const data = await unipilePostFetch({
    apiKey, dsn,
    path: `/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}&limit=${Math.min(Math.max(limit, 1), 25)}`,
    body: { api: "classic", category: "people", keywords },
  });
  return (data.items || []).filter((p) => p.type === "PEOPLE").map((p) => ({
    identifier: p.id,
    name: p.name || "",
    headline: p.headline || "",
    location: p.location || "",
    connection_degree: connectionDegreeLabel(p.network_distance),
    profile_url: p.profile_url || p.public_profile_url || "",
    photo_url: p.profile_picture_url || "",
  }));
}

// "Lead IQ" profile read -- the person-level equivalent of getCompanyProfile:
// a real LinkedIn profile (headline, summary, work experience, education,
// skills), not just a search-result snippet. `linkedin_sections=*_preview`
// pulls preview data for every section in one call rather than one heavy
// full-data call per section (LinkedIn throttles those). Same on-demand,
// one-profile-at-a-time usage pattern as every other Unipile call in this
// file -- see the rate-limit note above getCompanyProfile.
async function getPersonProfile({ apiKey, dsn, accountId, identifier }) {
  if (!apiKey || !dsn || !accountId) throw new Error("Unipile isn't fully configured (need API key, DSN, and account ID)");
  if (!identifier) throw new Error("No LinkedIn profile identifier to look up");
  const data = await unipileFetch({
    apiKey, dsn,
    path: `/api/v1/users/${encodeURIComponent(identifier)}?linkedin_sections=%2A_preview&account_id=${encodeURIComponent(accountId)}`,
  });
  const skills = Array.isArray(data.skills)
    ? data.skills.map((s) => (typeof s === "string" ? s : s?.name || s?.title || "")).filter(Boolean)
    : [];
  const workExperience = Array.isArray(data.work_experience) ? data.work_experience : [];
  const currentPosition = workExperience.find((w) => !w.end) || workExperience[0] || null;
  return {
    name: [data.first_name, data.last_name].filter(Boolean).join(" "),
    headline: data.headline || "",
    summary: data.summary || "",
    location: data.location || "",
    connection_degree: connectionDegreeLabel(data.network_distance),
    is_premium: Boolean(data.is_premium),
    is_open_profile: Boolean(data.is_open_profile),
    is_influencer: Boolean(data.is_influencer),
    follower_count: data.follower_count ?? null,
    connections_count: data.connections_count ?? null,
    profile_picture_url: data.profile_picture_url || "",
    profile_url: data.public_identifier ? `https://www.linkedin.com/in/${data.public_identifier}` : "",
    current_company: currentPosition?.company || "",
    current_position: currentPosition?.position || "",
    work_experience: workExperience.slice(0, 8).map((w) => ({
      company: w.company || "", position: w.position || "", location: w.location || "",
      start: w.start || "", end: w.end || "",
    })),
    education: (Array.isArray(data.education) ? data.education : []).slice(0, 6).map((e) => ({
      school: e.school || "", degree: e.degree || "", start: e.start || "", end: e.end || "",
    })),
    skills: skills.slice(0, 20),
    websites: Array.isArray(data.websites) ? data.websites : [],
  };
}

module.exports = { listAccounts, getCompanyProfile, searchKeyPeople, searchCompanies, searchPeople, getPersonProfile, listSearchParameters, listPersonas };
