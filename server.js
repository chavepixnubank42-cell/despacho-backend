const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { loadDB, saveDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const ACTIVE_STATUSES = ['aceito', 'no_local_retirada', 'em_entrega', 'no_local_entrega'];
const OFFER_TIMEOUT_MS = 30 * 1000; // seconds a motoboy has to accept/decline
const ARRIVAL_RADIUS_METERS = 150; // how close the motoboy must be to confirm arrival
const shortId = (prefix) => prefix + '_' + uuidv4().slice(0, 8);

// ---------------------------------------------------------------
// Mercado Pago (Pix) — set MERCADOPAGO_ACCESS_TOKEN as an environment
// variable on your host (Railway: Variables tab). Without it, credit
// top-ups are disabled but the rest of the app keeps working.
// ---------------------------------------------------------------
const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
const mpClient = mpToken ? new MercadoPagoConfig({ accessToken: mpToken, options: { timeout: 8000 } }) : null;
const mpPayment = mpClient ? new Payment(mpClient) : null;

// ---------------------------------------------------------------
// Geocoding (Nominatim/OpenStreetMap) — turns an address into lat/lng so
// we can later check how far the motoboy really is from it.
// ---------------------------------------------------------------

// Nominatim's usage policy caps public requests at ~1/second, so we queue
// them and only ever have one in flight, spaced a second apart.
let geocodeChain = Promise.resolve();
function throttledFetch(url, options) {
  const run = geocodeChain.then(async () => {
    const res = await fetch(url, options);
    await new Promise((r) => setTimeout(r, 1000)); // hold the slot for 1s
    return res;
  });
  geocodeChain = run.catch(() => {}); // never let one failure jam the queue
  return run;
}

async function geocodeAddress(address) {
  if (!address) return null;
  const key = address.trim().toLowerCase();
  const db = loadDB();
  db.geocodeCache = db.geocodeCache || {};
  if (db.geocodeCache[key] !== undefined) return db.geocodeCache[key];

  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address);
    const res = await throttledFetch(url, {
      headers: { 'User-Agent': 'DespachoApp/1.0 (app de despacho de entregas por moto)' }
    });
    const data = await res.json();
    const coords = data && data[0] ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
    const db2 = loadDB();
    db2.geocodeCache = db2.geocodeCache || {};
    db2.geocodeCache[key] = coords; // cache the miss too, so we don't retry a bad address every time
    saveDB(db2);
    return coords;
  } catch (e) {
    console.error('Geocoding falhou para', address, e.message);
    return null;
  }
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------
// Auth — hashed passwords (bcryptjs) + server-side session tokens.
// Never store or return a plain-text password; never return passwordHash.
// ---------------------------------------------------------------
function sanitizeBusiness(b) {
  if (!b) return b;
  const { passwordHash, ...rest } = b;
  return rest;
}
function sanitizeMotoboy(m) {
  if (!m) return m;
  const { passwordHash, ...rest } = m;
  return rest;
}
function makeToken() {
  return uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
}
function createSession(db, type, id) {
  db.sessions = db.sessions || {};
  const token = makeToken();
  db.sessions[token] = { type, id, createdAt: Date.now() };
  return token;
}
// Protects a route: only requests with a valid session token of one of the
// given types get through. req.authType / req.authId are set for the handler.
function requireAuth(...allowedTypes) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Não autenticado — faça login novamente' });
    const db = loadDB();
    db.sessions = db.sessions || {};
    const session = db.sessions[token];
    if (!session || (allowedTypes.length && !allowedTypes.includes(session.type))) {
      return res.status(401).json({ error: 'Sessão inválida — faça login novamente' });
    }
    req.authType = session.type;
    req.authId = session.id;
    next();
  };
}
const PASSWORD_MIN_LENGTH = 6;

// ---------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------
app.post('/api/businesses', async (req, res) => {
  const { name, phone, email, password, confirmPassword, address } = req.body || {};
  if (!name || !phone || !email || !password || !address) {
    return res.status(400).json({ error: 'Preencha todos os campos' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'As senhas não coincidem' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` });
  }
  const db = loadDB();
  const emailLower = email.trim().toLowerCase();
  const emailTaken = Object.values(db.businesses).some((b) => (b.email || '').toLowerCase() === emailLower);
  if (emailTaken) return res.status(409).json({ error: 'Já existe uma conta de comércio com esse e-mail' });

  const passwordHash = await bcrypt.hash(password, 10);
  const business = {
    id: shortId('biz'),
    name,
    phone,
    email: emailLower,
    passwordHash,
    address,
    credits: 0,
    createdAt: Date.now()
  };
  db.businesses[business.id] = business;
  const token = createSession(db, 'business', business.id);
  saveDB(db);
  res.json({ token, business: sanitizeBusiness(business) });
});

app.post('/api/businesses/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha' });
  const db = loadDB();
  const emailLower = email.trim().toLowerCase();
  const business = Object.values(db.businesses).find((b) => (b.email || '').toLowerCase() === emailLower);
  if (!business || !business.passwordHash) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }
  const ok = await bcrypt.compare(password, business.passwordHash);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  const token = createSession(db, 'business', business.id);
  saveDB(db);
  res.json({ token, business: sanitizeBusiness(business) });
});

// Migration path for businesses that registered before login existed —
// identified by phone (since that's all the old records have), then they
// set their own email + password to finish becoming a real account.
app.post('/api/businesses/complete-profile', async (req, res) => {
  const { phone, email, password, confirmPassword } = req.body || {};
  if (!phone || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'As senhas não coincidem' });
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` });
  }
  const db = loadDB();
  const business = Object.values(db.businesses).find((b) => b.phone === phone.trim());
  if (!business) return res.status(404).json({ error: 'Não encontramos um comércio com esse telefone' });
  if (business.passwordHash) {
    return res.status(409).json({ error: 'Essa conta já tem senha — use a tela de entrar' });
  }
  const emailLower = email.trim().toLowerCase();
  const emailTaken = Object.values(db.businesses).some(
    (b) => b.id !== business.id && (b.email || '').toLowerCase() === emailLower
  );
  if (emailTaken) return res.status(409).json({ error: 'Esse e-mail já está em uso' });
  business.email = emailLower;
  business.passwordHash = await bcrypt.hash(password, 10);
  const token = createSession(db, 'business', business.id);
  saveDB(db);
  res.json({ token, business: sanitizeBusiness(business) });
});

app.get('/api/businesses', (req, res) => {
  res.json(Object.values(loadDB().businesses).map(sanitizeBusiness));
});

app.get('/api/businesses/:id', (req, res) => {
  const b = loadDB().businesses[req.params.id];
  if (!b) return res.status(404).json({ error: 'Comércio não encontrado' });
  res.json(sanitizeBusiness(b));
});

// ---------------------------------------------------------------
// Motoboys
// ---------------------------------------------------------------
app.post('/api/motoboys', async (req, res) => {
  const { name, phone, email, password, confirmPassword, vehicle } = req.body || {};
  if (!name || !phone || !email || !password || !vehicle) {
    return res.status(400).json({ error: 'Preencha todos os campos' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'As senhas não coincidem' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` });
  }
  const db = loadDB();
  const emailLower = email.trim().toLowerCase();
  const emailTaken = Object.values(db.motoboys).some((m) => (m.email || '').toLowerCase() === emailLower);
  if (emailTaken) return res.status(409).json({ error: 'Já existe uma conta de motoboy com esse e-mail' });

  const passwordHash = await bcrypt.hash(password, 10);
  const motoboy = {
    id: shortId('moto'),
    name,
    phone,
    email: emailLower,
    passwordHash,
    vehicle,
    online: false,
    createdAt: Date.now()
  };
  db.motoboys[motoboy.id] = motoboy;
  const token = createSession(db, 'motoboy', motoboy.id);
  saveDB(db);
  res.json({ token, motoboy: sanitizeMotoboy(motoboy) });
});

app.post('/api/motoboys/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha' });
  const db = loadDB();
  const emailLower = email.trim().toLowerCase();
  const motoboy = Object.values(db.motoboys).find((m) => (m.email || '').toLowerCase() === emailLower);
  if (!motoboy || !motoboy.passwordHash) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }
  const ok = await bcrypt.compare(password, motoboy.passwordHash);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  const token = createSession(db, 'motoboy', motoboy.id);
  saveDB(db);
  res.json({ token, motoboy: sanitizeMotoboy(motoboy) });
});

// Migration path for motoboys that registered before login existed.
app.post('/api/motoboys/complete-profile', async (req, res) => {
  const { phone, email, password, confirmPassword } = req.body || {};
  if (!phone || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'As senhas não coincidem' });
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` });
  }
  const db = loadDB();
  const motoboy = Object.values(db.motoboys).find((m) => m.phone === phone.trim());
  if (!motoboy) return res.status(404).json({ error: 'Não encontramos um motoboy com esse telefone' });
  if (motoboy.passwordHash) {
    return res.status(409).json({ error: 'Essa conta já tem senha — use a tela de entrar' });
  }
  const emailLower = email.trim().toLowerCase();
  const emailTaken = Object.values(db.motoboys).some(
    (m) => m.id !== motoboy.id && (m.email || '').toLowerCase() === emailLower
  );
  if (emailTaken) return res.status(409).json({ error: 'Esse e-mail já está em uso' });
  motoboy.email = emailLower;
  motoboy.passwordHash = await bcrypt.hash(password, 10);
  const token = createSession(db, 'motoboy', motoboy.id);
  saveDB(db);
  res.json({ token, motoboy: sanitizeMotoboy(motoboy) });
});

app.get('/api/motoboys', (req, res) => {
  res.json(Object.values(loadDB().motoboys).map(sanitizeMotoboy));
});

app.get('/api/motoboys/:id', (req, res) => {
  const m = loadDB().motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  res.json(sanitizeMotoboy(m));
});

// Used for the online/offline toggle. Only the motoboy themself can flip it.
app.patch('/api/motoboys/:id', requireAuth('motoboy'), (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  if (typeof req.body.online === 'boolean') m.online = req.body.online;
  saveDB(db);
