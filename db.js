// Database layer. Two modes, chosen automatically:
//
// 1. SUPABASE / POSTGRES (used whenever DATABASE_URL is set — e.g. in
//    production on Render). The whole app state (businesses, motoboys,
//    orders, banners, generalTickets) is stored as ONE jsonb blob in a
//    single row of the `app_state` table. This keeps the exact same
//    in-memory shape the rest of server.js already expects — server.js
//    only ever calls loadDB()/saveDB(), so nothing else needs to change.
//
// 2. LOCAL JSON FILE (used when DATABASE_URL is NOT set — e.g. running
//    on your own machine without a database). Same behavior as before:
//    everything lives in data.json next to this file.
//
// Two safety measures carried over from the file-based version, both
// fixing real data-loss bugs found in testing:
//
// 1. IN-MEMORY CACHE — loadDB() always returns the SAME shared object
//    instead of re-reading on every call. Since Node runs one request's
//    synchronous code at a time, every request mutating the one shared
//    in-memory object means concurrent changes are never lost.
//
// 2. SERIALIZED, QUEUED WRITES — saveDB() pushes writes into a queue so
//    two saves never race each other, whether writing to disk (atomic
//    write-then-rename) or to Postgres (sequential UPDATEs).

const fs = require('fs');
const path = require('path');

function emptyDB() {
  return { businesses: {}, motoboys: {}, orders: {}, banners: {}, generalTickets: {} };
}

function withDefaults(db) {
  if (!db.businesses) db.businesses = {};
  if (!db.motoboys) db.motoboys = {};
  if (!db.orders) db.orders = {};
  if (!db.banners) db.banners = {};
  if (!db.generalTickets) db.generalTickets = {};
  return db;
}

let cache = null;
let saveDBImpl;
let initDBImpl;

if (process.env.DATABASE_URL) {
  // ---------- SUPABASE / POSTGRES MODE ----------
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Supabase's pooled connection requires SSL; it uses a certificate
    // that Node doesn't have in its default trust store, so we disable
    // strict verification (same approach Supabase's own docs recommend
    // for typical app servers).
    ssl: { rejectUnauthorized: false },
  });

  async function ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INT PRIMARY KEY DEFAULT 1,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (rows.length === 0) {
      const initial = emptyDB();
      await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [initial]);
      return initial;
    }
    return withDefaults(rows[0].data);
  }

  initDBImpl = async function initDB() {
    cache = await ensureTable();
    console.log('Banco de dados: conectado ao Supabase (Postgres).');
    return cache;
  };

  let writeQueue = Promise.resolve();
  saveDBImpl = function saveDB(db) {
    cache = db;
    const json = cache;
    writeQueue = writeQueue
      .catch(() => {}) // a previous failed write must never jam future writes
      .then(() =>
        pool.query('UPDATE app_state SET data = $1, updated_at = now() WHERE id = 1', [json])
      )
      .catch((e) => {
        console.error('Erro ao salvar no Supabase:', e.message);
      });
    return writeQueue;
  };
} else {
  // ---------- LOCAL JSON FILE MODE (fallback for local dev) ----------
  const DATA_DIR = process.env.DATA_DIR || __dirname;
  const DB_PATH = path.join(DATA_DIR, 'data.json');
  const TMP_PATH = DB_PATH + '.tmp';
  const BAK_PATH = DB_PATH + '.bak';

  function tryParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function loadFromDisk() {
    if (!fs.existsSync(DB_PATH)) {
      const initial = emptyDB();
      fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
      return initial;
    }
    const parsed = tryParse(fs.readFileSync(DB_PATH, 'utf8'));
    if (parsed) return parsed;

    console.error('data.json corrompido ao ler — tentando recuperar do backup (data.json.bak)...');
    if (fs.existsSync(BAK_PATH)) {
      const backupParsed = tryParse(fs.readFileSync(BAK_PATH, 'utf8'));
      if (backupParsed) {
        console.error('Recuperado com sucesso a partir do backup — restaurando data.json.');
        fs.writeFileSync(DB_PATH, JSON.stringify(backupParsed, null, 2));
        return backupParsed;
      }
      console.error('O backup também estava corrompido.');
    } else {
      console.error('Nenhum backup encontrado.');
    }
    console.error('Recriando data.json do zero — dados anteriores podem ter sido perdidos.');
    const initial = emptyDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }

  initDBImpl = async function initDB() {
    cache = withDefaults(loadFromDisk());
    console.log('Banco de dados: usando arquivo local (' + DB_PATH + ') — sem DATABASE_URL configurada.');
    return cache;
  };

  let writeQueue = Promise.resolve();
  saveDBImpl = function saveDB(db) {
    cache = db;
    const json = JSON.stringify(cache, null, 2);
    writeQueue = writeQueue
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve, reject) => {
            fs.writeFile(TMP_PATH, json, (err) => {
              if (err) return reject(err);
              try {
                if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, BAK_PATH);
              } catch (e) {
                /* backup is a nice-to-have, never fatal */
              }
              fs.rename(TMP_PATH, DB_PATH, (err2) => {
                if (err2) reject(err2);
                else resolve();
              });
            });
          })
      )
      .catch((e) => {
        console.error('Erro ao salvar data.json:', e.message);
      });
    return writeQueue;
  };
}

function loadDB() {
  // By the time any route handler runs, initDB() has already populated
  // the cache once at startup (see server.js) — this just hands out the
  // same shared in-memory object every time, exactly like before.
  if (!cache) cache = emptyDB();
  return withDefaults(cache);
}

function saveDB(db) {
  return saveDBImpl(db);
}

async function initDB() {
  return initDBImpl();
}

module.exports = { loadDB, saveDB, initDB };
