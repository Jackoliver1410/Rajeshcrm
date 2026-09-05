// Thin abstraction over a few AI providers' text-generation APIs, used for
// the "Draft with AI" feature on the Contact detail modal. Keys are supplied
// per-call (loaded from the `integrations` collection by the route handler)
// rather than read from environment variables here, since the admin manages
// them live in Settings > Integrations.
//
// Only providers with a plain HTTP text-generation endpoint are wired up:
// Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google). Copilot has no
// public completions API suited to this, and Clay is a data-enrichment
// product rather than a text generator, so both are listed in Settings as
// "not available for AI drafting" instead of faking a integration for them.

const TIMEOUT_MS = 15000;

// Google retires Gemini model IDs on a rolling basis (gemini-1.5-flash was
// fully shut down) -- gemini-3.7-flash is the current generally-available
// (GA) flash model as of August 2026. If this starts 404ing again down the
// line, check https://ai.google.dev/gemini-api/docs/models for the current
// GA flash model ID and update this one constant.
const GEMINI_MODEL = "gemini-3.7-flash";

async function withTimeout(promise, label, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms || TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt({ contactName, title, company, context, senderCompanyInfo }) {
  const who = [contactName, title, company].filter(Boolean).join(", ");
  return [
    "Write a short, warm, professional outreach/follow-up email.",
    who ? `Recipient: ${who}.` : "",
    senderCompanyInfo ? `About the sender's own company (use this for positioning/context, don't just paste it in): ${senderCompanyInfo}` : "",
    context ? `Context from the sender: ${context}` : "Context: general check-in / relationship-building follow-up.",
    "Keep it under 120 words, no subject line, no placeholder brackets, sign off with just \"Best,\" (no name — the sender will add their own).",
  ].filter(Boolean).join("\n");
}

async function callClaude(apiKey, prompt) {
  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  }), "Claude request");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  return (data.content || []).map((b) => b.text || "").join("").trim();
}

async function callOpenAI(apiKey, prompt) {
  const res = await withTimeout(fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  }), "ChatGPT request");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function callGemini(apiKey, prompt) {
  const res = await withTimeout(fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      // Google's newer "auth key" (AQ.-prefixed) API keys -- the only type
      // AI Studio issues now -- are bound to a service account and are
      // rejected by the legacy `?key=` query-string auth style that the
      // older "standard" (AIzaSy...) keys used. The fix is the
      // `x-goog-api-key` header instead, which is what Google's own current
      // REST example uses (https://ai.google.dev/gemini-api/docs/api-key).
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  ), "Gemini request");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

const PROVIDERS = {
  claude: { label: "Claude (Anthropic)", call: callClaude },
  openai: { label: "ChatGPT (OpenAI)", call: callOpenAI },
  gemini: { label: "Gemini (Google)", call: callGemini },
};

// Providers listed in Settings that intentionally have no `call` — surfaced
// so the UI can explain why they're greyed out rather than silently
// omitting tools the user explicitly asked about.
const UNSUPPORTED_PROVIDERS = {
  copilot: { label: "GitHub Copilot", reason: "No public API suited to free-text drafting outside an IDE." },
  clay: { label: "Clay", reason: "Clay is a data enrichment tool, not a text generator — better suited to a future \"enrich this contact\" feature." },
};

async function draftEmail({ provider, apiKey, contactName, title, company, context, senderCompanyInfo }) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`Unknown or unsupported provider: ${provider}`);
  if (!apiKey) throw new Error("No API key configured for this provider");
  const prompt = buildPrompt({ contactName, title, company, context, senderCompanyInfo });
  const text = await entry.call(apiKey, prompt);
  if (!text) throw new Error("The provider returned an empty response");
  return text;
}

// Outreach sequence: a first-touch draft plus 5 escalating follow-ups for a
// single contact, generated in one call (asks for JSON so the whole
// sequence comes back together rather than 6 separate round-trips). Reuses
// whichever provider is marked "active" in Settings > Integrations -- same
// as draftEmail above -- and folds in the linked account's industry/notes
// as "company data" when available, plus whatever extra context the rep
// types in on the Contacts table's Auto-draft modal.
function buildSequencePrompt({ contactName, title, company, industry, notes, context, senderCompanyInfo }) {
  const who = [contactName, title, company].filter(Boolean).join(", ");
  return [
    "Write a first-touch outreach email plus 5 short follow-up emails (for use if the first gets no reply) to a B2B prospect.",
    who ? `Recipient: ${who}.` : "",
    industry ? `Industry: ${industry}.` : "",
    senderCompanyInfo ? `About the sender's own company (use this for positioning/context, don't just paste it in): ${senderCompanyInfo}` : "",
    notes ? `Notes on file about this account: ${notes}` : "",
    context ? `Additional context from the sender: ${context}` : "",
    "The first draft should be warm, professional, under 120 words, no subject line, no placeholder brackets, sign off with just \"Best,\" (no name -- the sender adds their own).",
    "Each follow-up should be shorter than the last, reference that this is a follow-up without being repetitive, and vary the angle (a new value point, social proof, a direct question, a breakup email for the last one). No subject lines, no placeholder brackets, same sign-off style.",
    "Respond with ONLY a single JSON object -- no prose before or after, no markdown code fences -- with exactly these keys: {\"draft\":\"\",\"followup_1\":\"\",\"followup_2\":\"\",\"followup_3\":\"\",\"followup_4\":\"\",\"followup_5\":\"\"}",
  ].filter(Boolean).join("\n");
}

async function generateOutreachSequence({ provider, apiKey, contactName, title, company, industry, notes, context, senderCompanyInfo }) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`Unknown or unsupported provider: ${provider}`);
  if (!apiKey) throw new Error("No API key configured for this provider");
  const raw = await entry.call(apiKey, buildSequencePrompt({ contactName, title, company, industry, notes, context, senderCompanyInfo }));
  const obj = extractJsonObject(raw);
  return {
    draft: obj.draft || "",
    followups: [obj.followup_1, obj.followup_2, obj.followup_3, obj.followup_4, obj.followup_5].map((f) => f || ""),
  };
}

// Account research brief: a one-page summary based on whatever's already on
// file for the account (signals, notes, known contacts) — NOT live web
// research. The prompt says so explicitly and asks the model to flag
// anything it's inferring rather than certain of, so the output doesn't
// read as more authoritative than it is.
function buildBriefPrompt({ name, industry, website, notes, signals, contacts }) {
  const activeSignals = Object.entries(signals || {})
    .filter(([k, v]) => v && k !== "updatedAt")
    .map(([k]) => ({
      funding: "recent funding", hiringQA: "hiring for QA", recentLaunch: "recent product launch",
      leadershipChange: "recent leadership change", outage: "recent outage/incident", cicd: "CI/CD gap flagged",
    }[k] || k));
  const contactList = (contacts || []).map((c) => c.title ? `${c.name} (${c.title})` : c.name).join("; ");
  return [
    `Write a concise account brief (150-200 words) for a B2B sales rep about to reach out to "${name}"${industry ? `, a company in ${industry}` : ""}.`,
    website ? `Website: ${website}` : "",
    activeSignals.length ? `Known signals on file: ${activeSignals.join(", ")}.` : "",
    contactList ? `Known contacts: ${contactList}.` : "",
    notes ? `Rep's notes: ${notes}` : "",
    "Cover: why this account is worth prioritizing right now, a plausible pain point to lead with, and one specific opening line for outreach. This is based only on the information given above, not live research — say so if you're inferring rather than certain of something. Write in plain prose, 2-3 short paragraphs, no headers or bullet points.",
  ].filter(Boolean).join("\n");
}

async function generateAccountBrief({ provider, apiKey, name, industry, website, notes, signals, contacts }) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`Unknown or unsupported provider: ${provider}`);
  if (!apiKey) throw new Error("No API key configured for this provider");
  const prompt = buildBriefPrompt({ name, industry, website, notes, signals, contacts });
  const text = await entry.call(apiKey, prompt);
  if (!text) throw new Error("The provider returned an empty response");
  return text;
}

// Quick Add: turns pasted freeform text (a LinkedIn profile, an email
// signature, a company About page — anything) into structured contact
// fields the user can review before saving. Asks for JSON-only output and
// extracts the first {...} block defensively, since models occasionally
// wrap JSON in a sentence or code fence despite instructions not to.
function buildParsePrompt(text) {
  return [
    "Extract contact information from the following pasted text (it might be a LinkedIn profile, an email signature, a company About page, or something similar).",
    'Return ONLY a single JSON object — no prose, no markdown code fences — with exactly these keys, using an empty string for anything not found: {"first_name":"","last_name":"","title":"","company":"","email":"","phone":"","linkedin_url":""}',
    "If the text contains a LinkedIn profile URL, put it in linkedin_url.",
    "---",
    text,
  ].join("\n");
}

function extractJsonObject(raw) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not find structured data in the model's response");
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new Error("The model's response wasn't valid JSON");
  }
}

async function parsePastedContact({ provider, apiKey, text }) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`Unknown or unsupported provider: ${provider}`);
  if (!apiKey) throw new Error("No API key configured for this provider");
  if (!text || !text.trim()) throw new Error("Paste some text first");
  const raw = await entry.call(apiKey, buildParsePrompt(text));
  return extractJsonObject(raw);
}

// Account auto-fill fallback: real live web search via Claude's server-side
// web_search tool (not the model's static training knowledge — it actually
// searches). Only wired up for Claude, since that's the provider with a
// built-in web search tool in this app's supported set. Used as a fallback
// when Apollo has no key configured or didn't return every field, so a rep
// can still auto-fill Industry/Website/Revenue/Address for a company Apollo
// doesn't have on file.
const RESEARCH_TIMEOUT_MS = 25000;

// `knownFields` carries whatever another source (Apollo) already confirmed
// about THIS SPECIFIC company -- e.g. its industry or HQ address -- so the
// web search has something to anchor on. This matters a lot for common or
// ambiguous names (a global bank like "Barclays" also has hundreds of local
// branch pages, directory listings, and unrelated small businesses sharing
// fragments of the name). Without an anchor, a bare "search the web for
// Barclays" prompt can come back with a branch locator page's local domain
// and a single branch's tiny revenue figure instead of the parent group's --
// confidently wrong rather than obviously wrong, which is the worse failure
// mode. Anchoring + an explicit "prefer blank over an inconsistent guess"
// instruction is the fix, not more web searches.
// `domain` is set when the rep typed a website instead of a company name
// into the single Account/website field (e.g. "facebook.com") -- in that
// case `name` is just whatever was typed (which IS the domain) and the
// prompt needs to ask Claude to identify the real company behind the domain
// and hand back its actual name as `resolved_name`, rather than treating
// the raw domain string as if it were already a company name.
async function researchCompanyFields({ apiKey, name, domain, fields, knownFields }) {
  if (!apiKey) throw new Error("No Claude API key configured");
  if (!name || !name.trim()) throw new Error("Company name is required");
  const allFields = ["industry", "website", "revenue", "address", "sales_navigator_url"];
  const wanted = fields && fields.length ? fields.filter((f) => allFields.includes(f)) : allFields;
  const known = Object.entries(knownFields || {}).filter(([, v]) => v);
  const subject = domain ? `the company that owns/operates the website "${domain}"` : `the company "${name.trim()}"`;
  const prompt = [
    `Search the web for up-to-date, factual public information about ${subject}.`,
    domain ? `Identify the real company behind this domain and use its actual name (not the domain string) everywhere in your answer, including in "resolved_name".` : "",
    known.length ? `Already confirmed about THIS SPECIFIC company from another source (use this to make sure you're researching the same company, not a differently-named subsidiary, local branch, franchise location, or unrelated business that happens to share part of the name): ${known.map(([k, v]) => `${k} = ${v}`).join("; ")}.` : "",
    `Find these fields if available: ${wanted.join(", ")}${domain ? ", and the company's real name as \"resolved_name\"" : ""}.`,
    `"industry" is a short industry label. "website" is the company's main corporate domain (no protocol needed) — the company's own official site, never a branch locator page, franchise directory listing, review/aggregator site, or a local office's page. "revenue" is the most recently reported annual revenue for the whole company/group (not a single branch, store, or subsidiary) as a short string like "$50M" or "$1.2B". "address" is the company's primary or headquarters address as a single line. "sales_navigator_url" is the company's normal public LinkedIn company page URL (e.g. linkedin.com/company/...) — not a Sales Navigator deep link, since that ID isn't public.`,
    "Large or common company names often collide with local branches, franchisees, or unrelated small businesses in search results. Before answering, sanity-check that every field you're about to return is actually about the same entity (consistent with the confirmed info above, and with each other in scale/geography) -- if a result looks like it belongs to a local branch, a franchise, or a differently-scaled/differently-located entity than the rest, do not use it.",
    "If you cannot find a field with reasonable confidence, or the best match you found seems inconsistent with the rest, use an empty string for it rather than guessing or returning a mismatched result.",
    `After searching, respond with ONLY a single JSON object on its own line — no prose before or after, no markdown code fences — with exactly these keys: {"industry":"","website":"","revenue":"","address":"","sales_navigator_url":""${domain ? ',"resolved_name":""' : ""}}`,
  ].filter(Boolean).join("\n");
  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
  }), "Claude web search request", RESEARCH_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  return extractJsonObject(text);
}

// Contact auto-fill fallback, same shape as researchCompanyFields above:
// real live web search via Claude, used when Apollo has no key or didn't
// return every field. Deliberately never asked for phone or email — those
// aren't reliably public and shouldn't be guessed at from search results;
// the caller only ever requests "title" and "linkedin_url" here, plus the
// person's current company if that's not already known (helps match/create
// the right Account). Sales Navigator URLs are a private per-viewer lead ID
// with no public source, so that field is never touched by this.
async function researchPersonFields({ apiKey, firstName, lastName, company, fields }) {
  if (!apiKey) throw new Error("No Claude API key configured");
  if (!firstName || !lastName) throw new Error("First and last name are required");
  const allFields = ["title", "linkedin_url"];
  const wanted = fields && fields.length ? fields.filter((f) => allFields.includes(f)) : allFields;
  const who = `${firstName} ${lastName}`.trim() + (company ? ` at ${company}` : "");
  const prompt = [
    `Search the web for up-to-date, factual public information about the professional "${who}".`,
    `Find these fields if available: ${wanted.join(", ")}, and their current company (employer) if it isn't already given above.`,
    `"title" is their current job title. "linkedin_url" is their normal public LinkedIn profile URL (e.g. linkedin.com/in/...). "company" is the name of their current employer.`,
    "This name may be shared by multiple people -- only fill in a field if you're reasonably confident you found the specific person described, not just someone with a similar name. Never invent or guess a phone number or email address; those are not requested and must not appear anywhere in your answer.",
    "If you cannot find a field with reasonable confidence, use an empty string for it rather than guessing.",
    "After searching, respond with ONLY a single JSON object on its own line — no prose before or after, no markdown code fences — with exactly these keys: {\"title\":\"\",\"linkedin_url\":\"\",\"company\":\"\"}",
  ].join("\n");
  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
  }), "Claude web search request", RESEARCH_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  return extractJsonObject(text);
}

// Company + software-landscape research ("Auto Gen"), one section at a
// time. Each of the user's 10 requested report sections gets its OWN
// Claude call here -- one web search, 1-3 sentences -- rather than one call
// doing everything. That's not just a smaller prompt: the point is that the
// ROUTE caller (lib/app.js) invokes this once per section as 10 SEPARATE
// HTTP requests from the browser, so each individual request/response stays
// a few seconds and comfortably clears this synchronous Netlify Function's
// real-world ~10-26s ceiling. An earlier version tried to do all 10
// sections (even down to 1 search total) in a single call and reliably
// timed out in production -- bundling the work into fewer, longer backend
// calls doesn't help when the constraint is wall-clock time per HTTP
// request, only splitting it into genuinely separate requests does.
const SECTION_TIMEOUT_MS = 15000;

// Default/empty shape for every signal key any section might return --
// lib/app.js's finalize route merges these across all 10 sections' results.
const COMPANY_RESEARCH_SIGNAL_DEFAULTS = {
  enterprise_apps: [], legacy_test_tools: [], modern_test_tools: [],
  large_qa_team: false, decision_makers: [], opportunity_score: null, opportunity_summary: "",
};

// Section 2 and 4 carry the tech-stack signals that drive the Intent score;
// section 8 carries decision-makers; section 10 carries the opportunity
// score. The other 6 sections are narrative-only (signalKeys: []).
const COMPANY_RESEARCH_SECTIONS = [
  { key: "1", title: "Company Overview", guidance: "Industry, HQ, size (employees/revenue if known), key business areas.", signalKeys: [] },
  { key: "2", title: "Major Applications/Platforms", guidance: "Enterprise apps in use if publicly known, e.g. Salesforce, SAP, Oracle, JD Edwards, ServiceNow, Workday, Coupa, NetSuite.", signalKeys: ["enterprise_apps"] },
  { key: "3", title: "Technology Stack", guidance: "Cloud provider(s), databases, APIs, frontend/backend frameworks, DevOps/CI-CD tools, if publicly known.", signalKeys: [] },
  { key: "4", title: "QA/Testing Landscape", guidance: "QA team size/structure if known, testing methodology, automation maturity, named testing tools e.g. Selenium, Cypress, Playwright, Tosca, UFT, QTP.", signalKeys: ["legacy_test_tools", "modern_test_tools", "large_qa_team"] },
  { key: "5", title: "Digital Transformation Initiatives", guidance: "Major ERP/CRM/cloud/AI projects announced or reported.", signalKeys: [] },
  { key: "6", title: "Integrations & System Complexity", guidance: "How complex their integration landscape appears, named integrations if known.", signalKeys: [] },
  { key: "7", title: "Testing/Automation Pain Points", guidance: "Evidence of current challenges (job postings, articles, outages, reviews).", signalKeys: [] },
  { key: "8", title: "Key Decision-Makers", guidance: "Named QA, Engineering, IT, and Digital decision-makers (name + title) if publicly findable.", signalKeys: ["decision_makers"] },
  { key: "9", title: "Recent News & Signals", guidance: "Relevant news, hiring signals, or technology initiatives, last 12 months where possible.", signalKeys: [] },
  { key: "10", title: "ACCELQ Opportunity", guidance: "Strongest use case, likely pain point, target persona to approach, and an opportunity score from 1-10 with one sentence of reasoning.", signalKeys: ["opportunity_score", "opportunity_summary"] },
];

function buildSectionPrompt({ name, website, industry, section }) {
  const lines = [
    `Research the company "${name.trim()}"${website ? ` (${website})` : ""}${industry ? `, industry: ${industry}` : ""}. Use AT MOST ONE web search, focused specifically on: ${section.title}.`,
    `Write 1-3 short sentences (not a paragraph) covering: ${section.guidance}`,
    "Clearly distinguish confirmed information (found via search) from assumptions or inference -- if nothing can be found, say so plainly rather than guessing.",
  ];
  if (section.signalKeys.length) {
    const schema = {};
    for (const k of section.signalKeys) schema[k] = COMPANY_RESEARCH_SIGNAL_DEFAULTS[k];
    lines.push("After your answer, on its own line write exactly: ---SIGNALS---");
    lines.push(`Then output ONLY a single JSON object (no prose, no markdown fences) with exactly these keys: ${JSON.stringify(schema)}`);
    if (section.key === "2") lines.push("enterprise_apps: any of Salesforce/SAP/Oracle/JD Edwards/ServiceNow/Workday/Coupa/NetSuite/Ariba found, empty array if none.");
    if (section.key === "4") lines.push("legacy_test_tools: any of Tosca/UFT/QTP/HP ALM/Silk Test/Rational Functional Tester found. modern_test_tools: any of Playwright/Selenium/Cypress/Appium/WebdriverIO/TestCafe found. large_qa_team: true only if a sizeable dedicated QA/testing organization is indicated.");
    if (section.key === "8") lines.push("decision_makers: named QA/Engineering/IT/Digital decision-makers found, empty array if none.");
    if (section.key === "10") lines.push("opportunity_score: an integer 1-10. opportunity_summary: one sentence.");
  }
  return lines.join("\n");
}

async function generateCompanyResearchSection({ apiKey, name, website, industry, sectionKey }) {
  if (!apiKey) throw new Error("No Claude API key configured");
  if (!name || !name.trim()) throw new Error("Company name is required");
  const section = COMPANY_RESEARCH_SECTIONS.find((s) => s.key === String(sectionKey));
  if (!section) throw new Error(`Unknown research section: ${sectionKey}`);

  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: buildSectionPrompt({ name, website, industry, section }) }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    }),
  }), `Claude research (${section.title})`, SECTION_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  const fullText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  const splitIdx = fullText.search(/---SIGNALS---/i);
  const text = (splitIdx === -1 ? fullText : fullText.slice(0, splitIdx)).trim();

  const signals = {};
  for (const k of section.signalKeys) signals[k] = COMPANY_RESEARCH_SIGNAL_DEFAULTS[k];
  if (splitIdx !== -1 && section.signalKeys.length) {
    try {
      const parsed = extractJsonObject(fullText.slice(splitIdx));
      for (const k of section.signalKeys) {
        if (k === "large_qa_team") signals[k] = Boolean(parsed[k]);
        else if (k === "decision_makers") signals[k] = Array.isArray(parsed[k]) ? parsed[k].filter((d) => d && d.name) : [];
        else if (k === "opportunity_score") {
          const n = Number(parsed[k]);
          signals[k] = Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null;
        } else if (k === "opportunity_summary") signals[k] = parsed[k] || "";
        else signals[k] = Array.isArray(parsed[k]) ? parsed[k].filter(Boolean) : [];
      }
    } catch {
      // Keep this section's signal defaults -- its narrative text is still
      // useful even if the trailing JSON block didn't parse.
    }
  }
  return { key: section.key, title: section.title, text: text || "(no information found)", signals };
}

// Tech stack extraction: reads the ALREADY-GENERATED research report text
// (no web search -- this is pure reading comprehension over text we already
// have, so it's fast and doesn't need the section-splitting trick) and asks
// Claude to use judgment about what actually counts as a confirmed tool in
// use, rather than the narrow fixed-keyword matching the intent-score
// tiers use (which only recognizes a short hardcoded list like Salesforce/
// Tosca/Selenium). This catches things like "Snowflake", "Jira",
// "TestRail", "Datadog" etc. that the report may mention but the keyword
// list doesn't know about, while explicitly excluding anything the report
// flagged as an assumption, a competitor mention, or "could not confirm."
const TECH_EXTRACT_TIMEOUT_MS = 12000;

function buildTechExtractPrompt(reportText) {
  return [
    "Below is a multi-section research report about a company's technology and QA/testing landscape.",
    "Read it and decide, using judgment, which named tools/platforms/products are CONFIRMED to actually be in use at this company -- not examples, not competitors, not industry-standard mentions, not things the report explicitly flagged as an assumption or unable to confirm.",
    "Sort each confirmed item into exactly one bucket:",
    "- saas_apps: business/enterprise SaaS platforms (CRM, ERP, ITSM, cloud, DevOps, collaboration, support, data, etc. -- e.g. Salesforce, SAP, ServiceNow, AWS, Jira, Snowflake, Zendesk).",
    "- tools: testing/QA/automation tools specifically (e.g. Selenium, Tosca, Playwright, Cypress, UFT, TestRail, Katalon, Appium).",
    "Rules: only include actual named products (never generic terms like 'cloud' or 'CI/CD pipeline' on their own). Do not pad the list to seem thorough -- if the report doesn't clearly confirm something, leave it out. It is fine and expected for a bucket to be empty.",
    "Output ONLY a single JSON object, no prose, no markdown fences, in exactly this shape: {\"saas_apps\": [], \"tools\": []}",
    "",
    "REPORT:",
    reportText,
  ].join("\n");
}

async function extractTechStackFromReport({ apiKey, reportText }) {
  if (!apiKey) throw new Error("No Claude API key configured");
  if (!reportText || !reportText.trim()) return { saas_apps: [], tools: [] };

  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: buildTechExtractPrompt(reportText) }],
    }),
  }), "Claude tech stack extraction", TECH_EXTRACT_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  const fullText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  try {
    const parsed = extractJsonObject(fullText);
    return {
      saas_apps: Array.isArray(parsed.saas_apps) ? parsed.saas_apps.filter(Boolean) : [],
      tools: Array.isArray(parsed.tools) ? parsed.tools.filter(Boolean) : [],
    };
  } catch {
    return { saas_apps: [], tools: [] };
  }
}

// LinkedIn profile research: a single short Claude call (one web_search
// round-trip, same "each request must independently clear the Netlify
// timeout" reasoning as the per-section research above -- one page's worth
// of profile info doesn't need splitting into 10 calls the way the full
// company report did). Honest limitation worth keeping visible in the
// prompt and surfaced in the UI: LinkedIn puts most profile/company page
// content behind a login wall, so this can only report what's discoverable
// via public search snippets/caches, not a full authenticated page read.
const LINKEDIN_TIMEOUT_MS = 15000;

function buildLinkedInPrompt({ name, linkedinUrl }) {
  return [
    `Research the LinkedIn page ${linkedinUrl ? `at ${linkedinUrl}` : `for "${name}"`}${name && linkedinUrl ? ` (company: ${name})` : ""}.`,
    "Use AT MOST TWO web searches. Summarize whatever is publicly discoverable about this LinkedIn page, covering: company/person description or headline, industry, headquarters/location, company size or employee count, founded year, specialties, website, and follower count -- or, if this is a person's profile, current title, company, past roles, and location.",
    "Write short factual bullet-style sentences, each on its own line prefixed with '- '.",
    "IMPORTANT: LinkedIn requires a login to view full profile/company pages, so you likely only have partial, indexed, or cached information. Clearly state at the end which fields you could not confirm, rather than guessing or inventing details.",
  ].join("\n");
}

async function generateLinkedInResearch({ apiKey, name, linkedinUrl }) {
  if (!apiKey) throw new Error("No Claude API key configured");
  if (!linkedinUrl && !name) throw new Error("A LinkedIn URL or company name is required");

  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      messages: [{ role: "user", content: buildLinkedInPrompt({ name, linkedinUrl }) }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    }),
  }), "Claude LinkedIn research", LINKEDIN_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
  return { text: text || "(no information found)" };
}

// Sales Navigator 9-field account research. Company Name/About/Headcount
// come from Unipile's real, logged-in LinkedIn session (lib/unipile.js
// getCompanyProfile) -- the route caller fetches those directly, no AI
// involved. The other 6 fields here (Account IQ, revenue model, strategic
// priorities, business challenges, competitive landscape, competitors) are
// NOT obtainable from any LinkedIn API at any tier -- Sales Navigator's own
// "Account IQ" panel is an AI summary LinkedIn generates privately inside
// its own web UI, confirmed absent from Unipile's raw company-profile
// response (see the comment above getCompanyProfile). These 6 are Claude
// web-search syntheses instead, grounded on the real company name/website/
// industry Unipile already confirmed.
//
// Same "one field, one HTTP request" split as generateCompanyResearchSection
// above, for the same hard-won reason: an earlier single-call version that
// tried to cover many fields' worth of web search in one request reliably
// timed out on Netlify's synchronous function ceiling. The route caller
// (lib/app.js) is invoked once per field as 6 separate requests from the
// frontend, each one comfortably inside any real ceiling.
const SALES_NAV_AI_FIELDS = [
  { key: "account_iq", title: "Account IQ", guidance: "A concise executive snapshot of this account: size/scale, growth trajectory, and why a B2B seller should care about them right now -- synthesizing company stage, momentum, and any notable public signals." },
  { key: "revenue_model", title: "How This Company Makes Money", guidance: "Their core revenue/business model -- main products or services sold, target customers, and pricing model if known (subscription, transaction fees, licensing, services, etc.)." },
  { key: "strategic_priorities", title: "Strategic Priorities", guidance: "Publicly stated or reported strategic priorities/initiatives for the current period -- from earnings calls, press releases, leadership interviews, or investor materials." },
  { key: "business_challenges", title: "Business Challenges", guidance: "Challenges or headwinds this company appears to be facing -- from news coverage, job postings, analyst commentary, or public statements." },
  { key: "competitive_landscape", title: "Competitive Landscape", guidance: "The general market/competitive landscape they operate in -- how crowded or mature the space is, and where this company is positioned within it." },
  { key: "competitors", title: "Competitors / Alternatives", guidance: "Named direct competitors or commonly-cited alternatives to this company, as a short list with a one-clause note on each if possible." },
];

function buildSalesNavFieldPrompt({ companyName, website, industry, field }) {
  return [
    `Research the company "${companyName.trim()}"${website ? ` (${website})` : ""}${industry ? `, industry: ${industry}` : ""}. Use AT MOST ONE web search, focused specifically on: ${field.title}.`,
    `Write 1-3 short sentences (not a paragraph) covering: ${field.guidance}`,
    "Clearly distinguish confirmed information (found via search) from reasonable inference -- if nothing can be found, say so plainly rather than guessing.",
  ].join("\n");
}

async function generateSalesNavField({ apiKey, companyName, website, industry, fieldKey }) {
  if (!apiKey) throw new Error("No Claude API key configured");
  if (!companyName || !companyName.trim()) throw new Error("Company name is required");
  const field = SALES_NAV_AI_FIELDS.find((f) => f.key === String(fieldKey));
  if (!field) throw new Error(`Unknown research field: ${fieldKey}`);

  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: buildSalesNavFieldPrompt({ companyName, website, industry, field }) }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    }),
  }), `Claude research (${field.title})`, SECTION_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
  return { key: field.key, title: field.title, text: text || "(no information found)" };
}

// Accounts Gem: a longer-running, structured "SDR agent" call, distinct
// from the short one-off prompts above. Always Gemini specifically (the
// route caller looks up the "gemini" integrations row directly, not
// whichever provider is marked "active" for drafting) since that's the
// provider the org built this feature's system prompt around. Uses
// Gemini's dedicated systemInstruction field rather than folding
// instructions into the user turn, so the persona/rules stay stable across
// very different request types (research vs. objection handling vs. call
// prep) without bleeding into the model's read of "what the user asked."
//
// Live testing against this org's actual Gemini key: BOTH a full /RESEARCH
// request and a short 100-word /FIRST_TOUCH email consistently never got a
// response at all within 25-30 real seconds -- eventually root-caused to
// the API key itself, not latency or timeout tuning. Google is retiring
// "standard" (AIzaSy...) Gemini keys in favor of "auth" keys (AQ.-prefixed
// -- the only type AI Studio issues now), and auth keys don't authenticate
// via the old `?key=` query-string convention; they need the
// `x-goog-api-key` header instead (confirmed against Google's own current
// docs: https://ai.google.dev/gemini-api/docs/api-key). That mismatch is
// the most likely explanation for requests going nowhere rather than
// failing fast. Also worth knowing: this runs inside a synchronous Netlify
// Function, capped at 10s by default (an extended 26s ceiling exists on
// some paid plans, but it's a dashboard/plan setting -- `[functions]
// timeout = 26` in netlify.toml fails the build outright, "functions.timeout
// must be an object", so it can't be requested from here). Kept at 15s:
// long enough to give a borderline-slow call a real chance, short enough
// that a stuck one fails with our own clear message rather than hanging
// the UI for 30s and failing anyway.
const GEM_TIMEOUT_MS = 15000;

async function callGeminiWithSystem(apiKey, systemPrompt, userMessage) {
  const res = await withTimeout(fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        // Gemini 3.x models dropped temperature/top_p/top_k (they now
        // error on these instead of just ignoring them). thinkingLevel
        // "low" trades a bit of reasoning depth for a much faster response,
        // which matters more here given the function timeout above.
        generationConfig: {
          maxOutputTokens: 1536,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    }
  ), "Gemini request (no response — double-check the API key is active and has quota)", GEM_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`Gemini blocked this request (${blockReason})`);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

// OpenAI's chat completions API takes a system message natively (no
// query-param key gotchas like Gemini's -- just the same Bearer header
// callOpenAI above already uses), so this is a straightforward sibling to
// callGeminiWithSystem rather than a workaround.
async function callOpenAIWithSystem(apiKey, systemPrompt, userMessage) {
  const res = await withTimeout(fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1536,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  }), "ChatGPT request (no response — double-check the API key is active and has quota)", GEM_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// Claude's Messages API takes a dedicated top-level `system` field (unlike
// OpenAI's system-role message or Gemini's systemInstruction object) --
// same auth header this file already uses for callClaude/researchCompany-
// Fields/researchPersonFields, so nothing new to get wrong here. Added as
// a fallback for Accounts Gem alongside Gemini/OpenAI since both of those
// have had their own outages for this org (Gemini's key-format rollout,
// OpenAI running out of credits) -- Claude is the one that's stayed
// reliable across everything else in the app.
async function callClaudeWithSystem(apiKey, systemPrompt, userMessage) {
  const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1536,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  }), "Claude request (no response — double-check the API key is active and has quota)", GEM_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error (${res.status})`);
  return (data.content || []).map((b) => b.text || "").join("").trim();
}

const GEM_PROVIDER_CALLS = {
  claude: { label: "Claude", call: callClaudeWithSystem },
  gemini: { label: "Gemini", call: callGeminiWithSystem },
  openai: { label: "ChatGPT", call: callOpenAIWithSystem },
};

async function runAccountsGem({ apiKey, systemPrompt, userMessage, provider }) {
  const entry = GEM_PROVIDER_CALLS[provider] || GEM_PROVIDER_CALLS.claude;
  if (!apiKey) throw new Error(`No ${entry.label} API key configured`);
  if (!userMessage || !userMessage.trim()) throw new Error("Enter a request first");
  const text = await entry.call(apiKey, systemPrompt, userMessage);
  if (!text) throw new Error(`${entry.label} returned an empty response`);
  return text;
}

// Stage-by-stage draft generation (as opposed to generateOutreachSequence's
// single "write the whole sequence at once" call). Used by the Contacts
// table's auto-draft workflow: a rep sets Status to a stage while Draft Type
// is Auto, and each stage is generated on its own, chained off whatever
// stage(s) came before it -- so a 2nd Followup actually reads the 1st
// Followup and Fresh email it's following up on, rather than being
// generated blind. `priorEmails` is the ordered list of already-generated
// stages for this contact: [{label, text}, ...].
const STAGE_ORDER = ["Fresh", "1st Followup", "2nd Followup", "3rd Followup", "4th Followup", "5th Followup"];

const STAGE_INSTRUCTIONS = {
  "Fresh": "Write a first-touch cold outreach email introducing yourself and why you're reaching out. This is the opening message in the sequence.",
  "1st Followup": "Write a short, simple, friendly follow-up email to the Fresh email above, on the assumption there's been no reply yet. Keep the same core ask, just a light, low-pressure nudge -- don't repeat the Fresh email's content verbatim.",
  "2nd Followup": "Write a follow-up email with a more technical angle: reference specific technical or product detail relevant to this prospect (an integration, a capability, how the product addresses a technical pain point tied to their role/industry) that builds on -- but doesn't repeat -- what was already shared in the Fresh email and 1st Followup above.",
  "3rd Followup": "Write a follow-up that leads with a new value point or proof point (e.g. a customer outcome, a result, social proof) distinct from anything shared in the earlier emails above.",
  "4th Followup": "Write a follow-up that asks one direct, low-friction question designed to prompt a quick reply either way.",
  "5th Followup": "Write a final, polite breakup-style follow-up -- the last touch in this sequence. Acknowledge there's been no response and leave the door open for later, without sounding frustrated.",
};

function buildStagePrompt({ stage, contactName, title, company, industry, accountNotes, contactIQ, senderCompanyInfo, priorEmails, context }) {
  const who = [contactName, title, company].filter(Boolean).join(", ");
  const isFollowup = stage !== "Fresh";
  return [
    STAGE_INSTRUCTIONS[stage] || STAGE_INSTRUCTIONS.Fresh,
    who ? `Recipient: ${who}.` : "",
    industry ? `Their industry: ${industry}.` : "",
    accountNotes ? `Notes on file about this account: ${accountNotes}` : "",
    contactIQ ? `What we know about this specific contact (IQ notes): ${contactIQ}` : "",
    senderCompanyInfo ? `About the sender's own company (use for positioning/context, don't just paste it in): ${senderCompanyInfo}` : "",
    context ? `Additional context from the sender: ${context}` : "",
    (priorEmails || []).length
      ? priorEmails.map((p) => `--- ${p.label} (already sent) ---\n${p.text}`).join("\n\n")
      : "",
    `Keep it under ${isFollowup ? 90 : 120} words, no subject line, no placeholder brackets, sign off with just "Best," (no name -- the sender adds their own).`,
  ].filter(Boolean).join("\n");
}

async function generateStageEmail({ provider, apiKey, stage, contactName, title, company, industry, accountNotes, contactIQ, senderCompanyInfo, priorEmails, context }) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`Unknown or unsupported provider: ${provider}`);
  if (!apiKey) throw new Error("No API key configured for this provider");
  if (!STAGE_INSTRUCTIONS[stage]) throw new Error(`Auto-draft doesn't apply to the "${stage}" status`);
  const prompt = buildStagePrompt({ stage, contactName, title, company, industry, accountNotes, contactIQ, senderCompanyInfo, priorEmails, context });
  const text = await entry.call(apiKey, prompt);
  if (!text) throw new Error("The provider returned an empty response");
  return text;
}

module.exports = {
  draftEmail, generateAccountBrief, generateOutreachSequence, generateCompanyResearchSection, COMPANY_RESEARCH_SECTIONS,
  generateLinkedInResearch, extractTechStackFromReport,
  parsePastedContact, researchCompanyFields, researchPersonFields,
  runAccountsGem, PROVIDERS, UNSUPPORTED_PROVIDERS,
  generateSalesNavField, SALES_NAV_AI_FIELDS,
  generateStageEmail, STAGE_ORDER,
};
