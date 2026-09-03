// Simple JSON-file database. No external database service needed —
// everything is stored in data.json next to this file.
//
// This is fine for a small operation (one city, a handful of businesses
// and motoboys) running as a SINGLE server process (which is how Railway
// runs a small app by default). If the app grows a lot — or ever runs as
// multiple server instances — swap this file for a real database
// (Postgres, MySQL, etc.); the rest of server.js doesn't need to change
// much since it only calls loadDB()/saveDB().
//
// Two safety measures, both fixing real data-loss bugs found in testing:
//
// 1. IN-MEMORY CACHE — loadDB() always returns the SAME shared object
//    instead of re-reading the file from disk on every call. Without
//    this, two requests handled close together (e.g. two orders created
//    within the same instant) could each read an independent snapshot,
//    make their own change, and save it back — with the second save
//    silently overwriting the first request's change. Since Node runs
//    one request's synchronous code at a time, every request mutating
//    the one shared in-memory object (instead of independent copies)
//    means concurrent changes are never lost.
//
// 2. ATOMIC WRITE-THEN-RENAME — saveDB() writes the new data to a temp
//    file first, and only swaps it into place with an OS-level rename
//    once that write finishes completely. A rename is effectively
//    instantaneous, so a reader can never see a half-written file, and a
//    crash mid-write can't leave data.json corrupted — worst case it's
//    still the previous, complete version. A one-generation backup
//    (data.json.bak) is also kept for manual recovery if ever needed.

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');
const TMP_PATH = DB_PATH + '.tmp';
const BAK_PATH = DB_PATH + '.bak';

function emptyDB() {
  return { businesses: {}, motoboys: {}, orders: {} };
}

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

// The one shared in-memory copy — loaded from disk once, then mutated in
// place by every request from then on.
let cache = null;

function loadDB() {
  if (!cache) cache = loadFromDisk();
  return cache;
}

// Serializes the actual disk writes (so two saves can't race each other's
// file I/O) and makes each one atomic via write-then-rename.
let writeQueue = Promise.resolve();
function saveDB(db) {
  // db is expected to be the same object loadDB() handed out (mutated in
  // place) — this just makes sure the cache and the argument never drift.
  cache = db;
  const json = JSON.stringify(cache, null, 2);

  writeQueue = writeQueue
    .catch(() => {}) // a previous failed write must never jam future writes
    .then(
      () =>
        new Promise((resolve, reject) => {
          fs.writeFile(TMP_PATH, json, (err) => {
            if (err) return reject(err);
            // Best-effort one-generation backup of the last known-good file.
            // At this point data.json still holds the PREVIOUS complete
            // version (we haven't swapped the new one in yet), so this
            // copy always reads a stable, complete file.
            try {
              if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, BAK_PATH);
            } catch (e) {
              /* backup is a nice-to-have, never fatal */
            }
            // Atomic swap — this is the step that actually prevents corruption.
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
}

module.exports = { loadDB, saveDB };
