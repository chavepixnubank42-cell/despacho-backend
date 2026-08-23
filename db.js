// Simple JSON-file database. No external database service needed —
// everything is stored in data.json next to this file.
//
// This is fine for a small operation (one city, a handful of businesses
// and motoboys). If the app grows a lot, swap this file for a real
// database (Postgres, MySQL, etc.) — the rest of server.js doesn't need
// to change much since it only calls loadDB()/saveDB().

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { businesses: {}, motoboys: {}, orders: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('data.json corrompido, recriando do zero:', e);
    const initial = { businesses: {}, motoboys: {}, orders: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
}

// Serializes writes so two requests arriving at the same time don't
// clobber each other's changes to the file.
let writeQueue = Promise.resolve();
function saveDB(db) {
  writeQueue = writeQueue.then(() => {
    return new Promise((resolve, reject) => {
      fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
  return writeQueue;
}

module.exports = { loadDB, saveDB };
