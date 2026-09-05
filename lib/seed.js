// Builds the initial demo dataset: users, accounts, contacts, leads,
// tasks, leave types, and one sample leave request already in flight.
// All demo users share the password "trellis123" (see README).

const bcrypt = require("bcryptjs");

function buildSeedData() {
  const hash = bcrypt.hashSync("trellis123", 8);

  const users = [
    { id: 1, name: "Aditi Rao", email: "aditi.rao@accelq.com", phone: "+1 415 555 0101", password: hash, role: "admin", manager_id: null, title: "Platform Admin" },
    { id: 2, name: "Karan Mehta", email: "karan.mehta@accelq.com", phone: "+1 415 555 0102", password: hash, role: "manager", manager_id: null, title: "Sales Manager" },
    { id: 3, name: "Priya Nair", email: "priya.nair@accelq.com", phone: "+1 415 555 0103", password: hash, role: "sales_rep", manager_id: 2, title: "Account Executive" },
    { id: 4, name: "Sam D'Souza", email: "sam.dsouza@accelq.com", phone: "+1 415 555 0104", password: hash, role: "sales_rep", manager_id: 2, title: "Account Executive" },
    { id: 5, name: "Neha Kapoor", email: "neha.kapoor@accelq.com", phone: "+1 415 555 0105", password: hash, role: "hr", manager_id: null, title: "HR Business Partner" },
  ];

  const accounts = [
    { id: 1, name: "Bluepeak Retail", industry: "Retail", website: "bluepeakretail.com", phone: "+1 415 555 0142", revenue: "$42M", address: "480 Market St, San Francisco, CA", owner_id: 3, created_at: "2026-06-02" },
    { id: 2, name: "Orenda Health Systems", industry: "Healthcare", website: "orendahealth.com", phone: "+1 312 555 0199", revenue: "$118M", address: "220 N LaSalle St, Chicago, IL", owner_id: 4, created_at: "2026-06-18" },
    { id: 3, name: "Fintrace Capital", industry: "Financial Services", website: "fintracecapital.com", phone: "+1 646 555 0110", revenue: "$67M", address: "55 Water St, New York, NY", owner_id: 3, created_at: "2026-07-05" },
  ];

  const contacts = [
    { id: 1, account_id: 1, first_name: "Laura", last_name: "Kim", email: "laura.kim@bluepeakretail.com", phone: "+1 415 555 0143", title: "VP Operations", owner_id: 3, created_at: "2026-06-02" },
    { id: 2, account_id: 2, first_name: "Marcus", last_name: "Webb", email: "marcus.webb@orendahealth.com", phone: "+1 312 555 0201", title: "Director of IT", owner_id: 4, created_at: "2026-06-18" },
    { id: 3, account_id: 3, first_name: "Elena", last_name: "Torres", email: "elena.torres@fintracecapital.com", phone: "+1 646 555 0121", title: "Head of Procurement", owner_id: 3, created_at: "2026-07-05" },
  ];

  const leads = [
    { id: 1, name: "Bluepeak - POS rollout", company: "Bluepeak Retail", account_id: 1, contact_id: 1, email: "laura.kim@bluepeakretail.com", phone: "+1 415 555 0143", source: "Referral", stage: "Proposal", value: 48000, owner_id: 3, created_at: "2026-06-05", updated_at: "2026-08-10" },
    { id: 2, name: "Orenda - Patient portal", company: "Orenda Health Systems", account_id: 2, contact_id: 2, email: "marcus.webb@orendahealth.com", phone: "+1 312 555 0201", source: "Website", stage: "Qualified", value: 76000, owner_id: 4, created_at: "2026-06-20", updated_at: "2026-08-01" },
    { id: 3, name: "Fintrace - Vendor onboarding", company: "Fintrace Capital", account_id: 3, contact_id: 3, email: "elena.torres@fintracecapital.com", phone: "+1 646 555 0121", source: "Outbound", stage: "New", value: 22000, owner_id: 3, created_at: "2026-08-01", updated_at: "2026-08-01" },
    { id: 4, name: "Bluepeak - Loyalty module", company: "Bluepeak Retail", account_id: 1, contact_id: 1, email: "laura.kim@bluepeakretail.com", phone: "+1 415 555 0143", source: "Upsell", stage: "Won", value: 15000, owner_id: 3, created_at: "2026-05-10", updated_at: "2026-06-30" },
    { id: 5, name: "Coastal Freight - Fleet CRM", company: "Coastal Freight Co.", account_id: null, contact_id: null, email: "ops@coastalfreight.com", phone: "+1 206 555 0177", source: "Trade show", stage: "Contacted", value: 34000, owner_id: 4, created_at: "2026-07-22", updated_at: "2026-08-05" },
    { id: 6, name: "Grantwell Legal - Case tracker", company: "Grantwell Legal", account_id: null, contact_id: null, email: "info@grantwelllegal.com", phone: "+1 212 555 0166", source: "Website", stage: "Lost", value: 18000, owner_id: 3, created_at: "2026-06-14", updated_at: "2026-07-20" },
  ];

  const tasks = [
    { id: 1, related_type: "lead", related_id: 1, subject: "Send revised proposal", due_date: "2026-08-22", status: "open", owner_id: 3 },
    { id: 2, related_type: "lead", related_id: 2, subject: "Schedule technical demo", due_date: "2026-08-25", status: "open", owner_id: 4 },
    { id: 3, related_type: "account", related_id: 3, subject: "Intro call with procurement", due_date: "2026-08-20", status: "open", owner_id: 3 },
  ];

  const leaveTypes = [
    { id: 1, name: "Annual Leave", default_days: 18, requires_hr: true, is_wfh: false },
    { id: 2, name: "Sick Leave", default_days: 10, requires_hr: false, is_wfh: false },
    { id: 3, name: "Work From Home", default_days: 24, requires_hr: false, is_wfh: true },
  ];

  const leaveBalances = [
    { id: 1, user_id: 3, leave_type_id: 1, balance: 12 },
    { id: 2, user_id: 3, leave_type_id: 2, balance: 8 },
    { id: 3, user_id: 3, leave_type_id: 3, balance: 20 },
    { id: 4, user_id: 4, leave_type_id: 1, balance: 15 },
    { id: 5, user_id: 4, leave_type_id: 2, balance: 10 },
    { id: 6, user_id: 4, leave_type_id: 3, balance: 22 },
    { id: 7, user_id: 2, leave_type_id: 1, balance: 18 },
    { id: 8, user_id: 2, leave_type_id: 2, balance: 10 },
    { id: 9, user_id: 2, leave_type_id: 3, balance: 24 },
  ];

  const leaveRequests = [
    {
      id: 1,
      user_id: 3,
      leave_type_id: 1,
      start_date: "2026-09-01",
      end_date: "2026-09-03",
      days: 3,
      reason: "Family event",
      status: "pending_manager",
      current_approver_id: 2,
      history: [],
      created_at: "2026-08-15",
    },
  ];

  const activityReports = [
    {
      id: 1,
      user_id: 3,
      date: "2026-08-18",
      country: "Africa, India Captive PST,MST",
      companies_new: 6,
      companies_remapped: 2,
      contacts_total_added: 77,
      emails_fresh: 108,
      emails_fresh_reach: 99,
      emails_followups: 350,
      emails_followups_reach: 129,
      linkedin_connections: 7,
      campaign: "Generic",
      responses_cold: 0,
      responses_negative: 0,
      responses_warm: 0,
      responses_prospect: 0,
      status: "pending",
      current_approver_id: 2,
      history: [],
      created_at: "2026-08-18",
      updated_at: "2026-08-18",
    },
  ];

  const emailTemplates = [
    {
      id: 1,
      name: "Intro email",
      subject: "Quick intro from {{sender_name}} at AccelQ",
      body: "Hi {{first_name}},\n\nI'm reaching out from AccelQ — we help teams like {{company}} ship QA faster. Worth a quick chat this week?\n\nBest,\n{{sender_name}}",
      owner_id: 3,
      created_at: "2026-07-01",
      updated_at: "2026-07-01",
    },
  ];

  const sequences = [
    {
      id: 1,
      name: "New lead welcome",
      active: false,
      steps: [
        { order: 1, delay_days: 0, subject: "Quick intro from {{sender_name}} at AccelQ", body: "Hi {{first_name}},\n\nThanks for your interest — wanted to introduce myself and see if a quick call makes sense this week.\n\nBest,\n{{sender_name}}" },
        { order: 2, delay_days: 3, subject: "Following up — {{company}}", body: "Hi {{first_name}},\n\nJust floating this back to the top of your inbox in case it got buried. Happy to work around your schedule.\n\nBest,\n{{sender_name}}" },
      ],
      owner_id: 3,
      created_at: "2026-07-05",
      updated_at: "2026-07-05",
    },
  ];

  return {
    users,
    accounts,
    contacts,
    leads,
    tasks,
    leave_types: leaveTypes,
    leave_balances: leaveBalances,
    leave_requests: leaveRequests,
    holidays: [
      { id: 1, date: "2026-10-02", name: "Gandhi Jayanti" },
      { id: 2, date: "2026-11-08", name: "Diwali" },
      { id: 3, date: "2026-12-25", name: "Christmas" },
    ],
    activity_reports: activityReports,
    integrations: [],
    email_templates: emailTemplates,
    contact_lists: [],
    sequences,
    sequence_enrollments: [],
    sent_emails: [],
    outlook_connections: [],
    inbox_messages: [],
    linkedin_oauth_connections: [],
  };
}

module.exports = { buildSeedData };

if (require.main === module && process.argv.includes("--reset")) {
  const store = require("./store");
  store.resetToSeed();
  console.log("Database reset to seed data.");
}
