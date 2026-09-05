// Datastore with two backends behind one async API:
//  - Local (`npm start` on your own machine): a JSON file on disk.
//  - Deployed (Netlify): a Postgres database (Supabase/Neon/etc, via
//    DATABASE_URL), storing the whole dataset as one JSONB row --
//    serverless functions have no persistent local disk. Netlify's own
//    auto-provisioned Blobs/DB didn't wire up reliably on the upload-based
//    deploy path available here, so this uses a plain external connection
//    string instead.
// Everything else in the app just calls these async functions and doesn't
// care which backend is active.

const fs = require("fs");
const path = require("path");

const ON_NETLIFY = process.env.USE_BLOBS === "true";
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const KV_KEY = "db";

let db = null; // in-memory cache once loaded
let pool = null;

// Every collection the app expects to exist. Data written before a given
// collection existed (e.g. the live database from before "activity
// reports" was added) won't have that key -- backfill it on load so
// every part of the app can assume `db[collection]` is always an array.
const COLLECTIONS = [
  "users", "accounts", "contacts", "leads", "tasks",
  "leave_types", "leave_balances", "leave_requests", "holidays",
  "activity_reports", "integrations",
  "email_templates", "contact_lists", "sequences", "sequence_enrollments", "sent_emails",
  "outlook_connections", "inbox_messages", "linkedin_oauth_connections",
  "data_grants", "field_permissions", "company_profile", "password_resets",
];

function withDefaults(data) {
  const result = { ...data };
  for (const c of COLLECTIONS) {
    if (!Array.isArray(result[c])) result[c] = [];
  }
  return result;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function getPool() {
  if (pool) return pool;
  const { Pool } = require("pg");
  // Small pool + short timeouts: each serverless invocation may spin up
  // its own pool, so this keeps us well under Supabase's shared
  // connection limit rather than defaulting to pg's max of 10 per pool.
  pool = new Pool({
    connectionString: process.env.TRELLIS_PG_URL || process.env.TRELLIS_DB_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
  });
  await ensureTable();
  return pool;
}

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  // A free-tier Postgres instance can take a few seconds to wake up from
  // idle, so retry a couple of times instead of failing the first request.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS trellis_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)");
      tableEnsured = true;
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function load() {
  // On Netlify, `db` is only safe to cache for the lifetime of one
  // serverless invocation, NOT across invocations -- Netlify can and does
  // reuse "warm" containers for multiple requests, and each warm container
  // has its own copy of this module-level variable. Without this check, a
  // warm container that loaded the dataset once would keep serving (and
  // writing back on any insert/update/delete) its own increasingly stale
  // snapshot for as long as it stayed warm, regardless of what other
  // concurrent containers had already persisted to Postgres. That's what
  // was causing entries to intermittently "disappear" -- not a bug in any
  // one page, but in the shared datastore every collection goes through.
  // Locally (plain `npm start`, single long-lived process, one JSON file)
  // there's no such multi-instance risk, so the cache stays safe there.
  if (db && !ON_NETLIFY) return db;
  const seed = require("./seed");

  if (ON_NETLIFY) {
    const p = await getPool();
    const { rows } = await p.query("SELECT value FROM trellis_kv WHERE key = $1", [KV_KEY]);
    if (rows.length) {
      db = withDefaults(rows[0].value);
    } else {
      db = withDefaults(seed.buildSeedData());
      await p.query("INSERT INTO trellis_kv (key, value) VALUES ($1, $2::jsonb)", [KV_KEY, JSON.stringify(db)]);
    }
  } else {
    ensureDataDir();
    if (!fs.existsSync(DB_PATH)) {
      db = withDefaults(seed.buildSeedData());
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    } else {
      db = withDefaults(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
    }
  }
  return db;
}

async function persist() {
  if (ON_NETLIFY) {
    const p = await getPool();
    await p.query(
      `INSERT INTO trellis_kv (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [KV_KEY, JSON.stringify(db)]
    );
  } else {
    ensureDataDir();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }
}

async function all(collection) {
  await load();
  return db[collection];
}

async function find(collection, id) {
  await load();
  return db[collection].find((r) => r.id === Number(id));
}

// insert/update/remove all follow the same read-modify-write shape, and on
// Netlify that shape used to race: each call independently re-fetched the
// whole dataset from Postgres into the shared module-level `db` variable,
// mutated it, then wrote it back -- with no locking between those steps.
// Under a burst of concurrent writes (e.g. a 43-row bulk delete, which fires
// one DELETE per row in parallel, quite possibly landing on several
// different warm serverless containers at once), two requests could both
// load the same pre-mutation snapshot, each apply their own single change,
// and then persist -- with whichever finished last silently overwriting the
// other's change. That's a lost update, not a UI refresh problem: rows that
// genuinely got a 200 back from DELETE could still be sitting in the
// database afterward. withLock() below closes that gap by doing the entire
// load-mutate-persist cycle inside one Postgres transaction, holding a row
// lock (`SELECT ... FOR UPDATE`) for its duration -- concurrent callers
// (regardless of which container they're running in) queue on that lock
// and each one's mutation is guaranteed to build on the previous one's
// already-committed result. Locally (single long-lived process, one JSON
// file, nothing else could be writing concurrently) the plain load/persist
// pair is already safe, so this only changes behavior on Netlify.
async function withLock(mutate) {
  if (!ON_NETLIFY) {
    await load();
    const result = mutate(db);
    await persist();
    return result;
  }
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT value FROM trellis_kv WHERE key = $1 FOR UPDATE", [KV_KEY]);
    let current;
    if (rows.length) {
      current = withDefaults(rows[0].value);
    } else {
      const seed = require("./seed");
      current = withDefaults(seed.buildSeedData());
    }
    const result = mutate(current);
    await client.query(
      `INSERT INTO trellis_kv (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [KV_KEY, JSON.stringify(current)]
    );
    await client.query("COMMIT");
    db = current; // keep the in-invocation cache consistent with what's now on disk
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insert(collection, record) {
  return withLock((current) => {
    const rows = current[collection];
    const nextId = rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1;
    const row = { id: nextId, ...record };
    rows.push(row);
    return row;
  });
}

async function update(collection, id, patch) {
  return withLock((current) => {
    const rows = current[collection];
    const idx = rows.findIndex((r) => r.id === Number(id));
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch, id: rows[idx].id };
    return rows[idx];
  });
}

async function remove(collection, id) {
  return withLock((current) => {
    const rows = current[collection];
    const idx = rows.findIndex((r) => r.id === Number(id));
    if (idx === -1) return false;
    rows.splice(idx, 1);
    return true;
  });
}

async function resetToSeed() {
  const seed = require("./seed");
  db = seed.buildSeedData();
  await persist();
  return db;
}

module.exports = { load, persist, all, find, insert, update, remove, resetToSeed, ON_NETLIFY };
