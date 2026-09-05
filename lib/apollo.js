// Apollo.io API wrapper for the Prospecting tab: people search, company
// search, and email reveal. Uses the key saved in Settings > Integrations —
// never an environment variable, matching the "stored in-app" choice made
// for the other integrations.
//
// Built against Apollo's documented v1 API surface from what's known at
// build time. Apollo's exact field names/filters can drift, so every
// request's real error message is passed straight through to the caller
// instead of being swallowed — if something's off once a real key is
// added, the admin sees Apollo's own explanation, not a generic failure.

const TIMEOUT_MS = 15000;
const BASE = "https://api.apollo.io/api/v1";

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

async function apolloFetch(apiKey, path, body) {
  const res = await withTimeout(fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body || {}),
  }), `Apollo ${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || data?.message || (Array.isArray(data?.errors) ? data.errors.join(", ") : null);
    throw new Error(msg || `Apollo API error (${res.status})`);
  }
  return data;
}

function cleanEmail(email) {
  return email && !/^email_not_unlocked/i.test(email) ? email : null;
}

// Employee-count filters go over the wire as Apollo's own "min,max" range
// strings (e.g. "1,10", "10001,"). Centralized here so the frontend can send
// the same short codes ("1-10") the UI shows and this maps them to what
// Apollo's API actually expects, rather than the browser needing to know
// Apollo's internal string format.
const EMPLOYEE_RANGE_MAP = {
  "1-10": "1,10", "11-20": "11,20", "21-50": "21,50", "51-100": "51,100",
  "101-200": "101,200", "201-500": "201,500", "501-1000": "501,1000",
  "1001-5000": "1001,5000", "5001-10000": "5001,10000", "10001+": "10001,",
};

function toArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
}

// Apollo's search endpoints return results under different keys depending on
// the request shape (e.g. a name-filtered company search populates
// `organizations`, but a tag/range-filtered one instead populates `accounts`
// while `organizations` comes back as `[]`). A plain `data.organizations ||
// data.accounts` bug-hides that: `[]` is truthy in JS, so the `||` stops at
// the first key without ever checking whether it's actually empty. This
// picks whichever candidate key actually has entries.
function firstNonEmptyArray(...candidates) {
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  return [];
}

// Apollo's People Search results don't always carry populated first_name/
// last_name fields -- lower-confidence or not-fully-enriched profiles can
// come back with one or both blank even though a full `name` field is
// present. Left as-is, that silently broke "Import selected as Contacts"
// downstream: the import route requires both a first and last name, so
// every row with a missing last_name was rejected with no visible reason
// beyond a generic "Imported 0 contacts" toast. Falling back to splitting
// `name` here means the person only shows up nameless in the results table
// (and fails to import) in the rarer case where Apollo has no name data at
// all, not merely unsplit name data.
function namesFromApolloPerson(p) {
  let first = p.first_name || "";
  let last = p.last_name || "";
  if (!first || !last) {
    const parts = String(p.name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length) {
      first = first || parts[0];
      last = last || parts.slice(1).join(" ");
    }
  }
  return { first, last };
}

async function searchPeople({
  apiKey, keywords, titles, page,
  personLocations, organizationLocations, employeeRanges, industries, emailStatus,
}) {
  const body = { page: page || 1, per_page: 15 };
  const titleList = toArr(titles);
  if (titleList.length) body.person_titles = titleList;
  const personLocList = toArr(personLocations);
  if (personLocList.length) body.person_locations = personLocList;
  const orgLocList = toArr(organizationLocations);
  if (orgLocList.length) body.organization_locations = orgLocList;
  const rangeList = toArr(employeeRanges).map((r) => EMPLOYEE_RANGE_MAP[r] || r);
  if (rangeList.length) body.organization_num_employees_ranges = rangeList;
  const statusList = toArr(emailStatus);
  if (statusList.length) body.contact_email_status = statusList;
  // The People API Search endpoint (see below) doesn't document a keyword-tag
  // industry filter the way Organization Search does -- so industry picks
  // get folded into q_keywords as plain text instead of a dedicated param.
  // Less precise than the company-search industry filter, but it's the only
  // documented way to nudge this endpoint toward an industry on the people
  // side.
  const industryList = toArr(industries);
  const combinedKeywords = [keywords, ...industryList].filter(Boolean).join(" ");
  if (combinedKeywords) body.q_keywords = combinedKeywords;

  // Apollo deprecated POST /mixed_people/search for API callers in favor of
  // this endpoint (same request/response shape, different path) -- calling
  // the old one now returns a 403 telling callers to switch.
  const data = await apolloFetch(apiKey, "/mixed_people/api_search", body);
  const people = firstNonEmptyArray(data.people, data.contacts).map((p) => {
    const { first, last } = namesFromApolloPerson(p);
    return {
      apollo_id: p.id,
      first_name: first,
      last_name: last,
      title: p.title || "",
      email: cleanEmail(p.email),
      email_status: p.email_status || null,
      linkedin_url: p.linkedin_url || "",
      organization_name: p.organization_name || p.organization?.name || "",
      organization_website: p.organization?.website_url || "",
      location: [p.city, p.state, p.country].filter(Boolean).join(", "),
      phone: p.phone_numbers?.[0]?.raw_number || "",
    };
  });
  return { people, total: data.pagination?.total_entries ?? people.length };
}

async function searchCompanies({
  apiKey, keywords, domain, page,
  organizationLocations, employeeRanges, industries,
}) {
  const body = { page: page || 1, per_page: 15 };
  if (keywords) body.q_organization_name = keywords;
  // Domain search is a separate Apollo filter from the name-keyword one --
  // used when the rep typed a website (e.g. "facebook.com") instead of a
  // company name, so the match doesn't depend on Apollo's name fuzzy-match
  // guessing which "Facebook" among several similarly-named orgs is meant.
  if (domain) body.q_organization_domains_list = [domain];
  const orgLocList = toArr(organizationLocations);
  if (orgLocList.length) body.organization_locations = orgLocList;
  const rangeList = toArr(employeeRanges).map((r) => EMPLOYEE_RANGE_MAP[r] || r);
  if (rangeList.length) body.organization_num_employees_ranges = rangeList;
  const industryList = toArr(industries);
  if (industryList.length) body.q_organization_keyword_tags = industryList;

  const data = await apolloFetch(apiKey, "/mixed_companies/search", body);
  const companies = firstNonEmptyArray(data.organizations, data.accounts).map((o) => ({
    apollo_id: o.id,
    name: o.name || "",
    website: o.website_url || "",
    industry: o.industry || "",
    phone: o.phone || "",
    linkedin_url: o.linkedin_url || "",
    employees: o.estimated_num_employees ?? null,
    // Revenue/address aren't in every Apollo plan's response — pull from
    // whichever of Apollo's known field name variants is present rather than
    // assuming one, and fall back to "" (never guess a number).
    revenue: o.organization_revenue_printed || o.annual_revenue_printed
      || (o.annual_revenue ? `$${Math.round(o.annual_revenue / 1e6)}M` : "") || "",
    address: o.raw_address || [o.street_address, o.city, o.state, o.country].filter(Boolean).join(", ") || "",
  }));
  return { companies, total: data.pagination?.total_entries ?? companies.length };
}

// Unlocks a verified email for one person — consumes an Apollo credit, so
// this is only called per-row on demand, never automatically for a whole
// results page.
async function revealEmail({ apiKey, firstName, lastName, organizationName, linkedinUrl }) {
  const body = { reveal_personal_emails: false };
  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (organizationName) body.organization_name = organizationName;
  if (linkedinUrl) body.linkedin_url = linkedinUrl;
  const data = await apolloFetch(apiKey, "/people/match", body);
  const p = data.person || {};
  return {
    email: cleanEmail(p.email),
    email_status: p.email_status || null,
    phone: p.phone_numbers?.[0]?.raw_number || "",
  };
}

// Apollo "Lists" (called Labels in the API) are saved groupings a rep
// already built inside their Apollo.io account — a static set of contacts or
// companies, as opposed to mixed_people/mixed_companies search which queries
// Apollo's whole database live. GET (not POST, unlike every other call here)
// per Apollo's documented Labels endpoint. modality is "contacts" or
// "accounts" — a rep's Apollo account can have lists of either kind.
async function getLists({ apiKey, modality }) {
  const res = await withTimeout(fetch(`${BASE}/labels`, {
    method: "GET",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
  }), "Apollo /labels");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || data?.message || (Array.isArray(data?.errors) ? data.errors.join(", ") : null);
    throw new Error(msg || `Apollo API error (${res.status})`);
  }
  const raw = Array.isArray(data) ? data : (data.labels || []);
  const lists = raw
    .filter((l) => !modality || (l.modality || "contacts") === modality)
    .map((l) => ({ id: l.id, name: l.name || "Untitled list", count: l.cached_count ?? 0 }));
  return { lists };
}

// Pulls the contacts already saved into one specific Apollo list. Uses the
// Contacts Search endpoint (contacts a rep already owns in Apollo) filtered
// by label_ids, distinct from mixed_people/search which searches everyone in
// Apollo's database. Mapped to the exact same shape as searchPeople so the
// existing Prospecting results table/import flow can render either one.
async function getListContacts({ apiKey, listId, page }) {
  const data = await apolloFetch(apiKey, "/contacts/search", {
    label_ids: [listId], page: page || 1, per_page: 25,
  });
  const people = firstNonEmptyArray(data.contacts, data.people).map((p) => {
    const { first, last } = namesFromApolloPerson(p);
    return {
      apollo_id: p.id,
      first_name: first,
      last_name: last,
      title: p.title || "",
      email: cleanEmail(p.email),
      email_status: p.email_status || null,
      linkedin_url: p.linkedin_url || "",
      organization_name: p.organization_name || p.organization?.name || p.account?.name || "",
      organization_website: p.organization?.website_url || p.account?.website_url || "",
      phone: p.phone_numbers?.[0]?.raw_number || "",
    };
  });
  return { people, total: data.pagination?.total_entries ?? people.length };
}

// Same idea as getListContacts, for a list of saved companies (Accounts, in
// Apollo's own terminology) instead of contacts. Mapped to searchCompanies's
// shape for the same reason.
async function getListCompanies({ apiKey, listId, page }) {
  const data = await apolloFetch(apiKey, "/accounts/search", {
    label_ids: [listId], page: page || 1, per_page: 25,
  });
  const companies = firstNonEmptyArray(data.accounts, data.organizations).map((o) => ({
    apollo_id: o.id,
    name: o.name || "",
    website: o.website_url || o.domain || "",
    industry: o.industry || "",
    phone: o.phone || "",
    linkedin_url: o.linkedin_url || "",
    revenue: o.organization_revenue_printed || o.annual_revenue_printed
      || (o.annual_revenue ? `$${Math.round(o.annual_revenue / 1e6)}M` : "") || "",
    address: o.raw_address || [o.street_address, o.city, o.state, o.country].filter(Boolean).join(", ") || "",
  }));
  return { companies, total: data.pagination?.total_entries ?? companies.length };
}

module.exports = { searchPeople, searchCompanies, revealEmail, getLists, getListContacts, getListCompanies };
