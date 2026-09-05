const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const webpush = require('web-push');
const { loadDB, saveDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const ACTIVE_STATUSES = ['aceito', 'no_local_retirada', 'em_entrega', 'no_local_entrega'];
const OFFER_TIMEOUT_MS = 30 * 1000; // seconds a motoboy has to accept/decline
const ARRIVAL_RADIUS_METERS = 150; // how close the motoboy must be to confirm arrival
// GPS accuracy varies a lot by device (a laptop or a phone with a weak
// signal can easily report 200-400m of margin). We let the arrival check
// stretch by up to this much extra, on top of ARRIVAL_RADIUS_METERS, to
// match the motoboy's own reported accuracy — see arrivalTransition below.
const MAX_ACCURACY_ALLOWANCE_METERS = 350;
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
// Push notifications (Web Push / VAPID) — set VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY as environment variables (Railway: Variables tab).
// Without them, push is silently disabled and the app keeps working
// exactly as before (motoboys just rely on the in-app polling).
// ---------------------------------------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_CONTACT_EMAIL || 'contato@despacho.app'),
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não configuradas — notificações push desativadas.');
}

// Sends a push notification to every device a motoboy has subscribed
// from. Fire-and-forget on purpose — we never want a slow/failed push to
// delay the API response the motoboy (or business) is waiting on. A
// subscription that the browser has revoked (410/404) is removed so we
// stop wasting calls on it.
function notifyMotoboy(motoboyId, payload) {
  if (!pushEnabled) return;
  const db = loadDB();
  const m = db.motoboys[motoboyId];
  if (!m || !Array.isArray(m.pushSubscriptions) || m.pushSubscriptions.length === 0) return;
  const body = JSON.stringify(payload);
  let removedAny = false;
  Promise.all(
    m.pushSubscriptions.map((sub) =>
      webpush.sendNotification(sub, body).catch((err) => {
        if (err && (err.statusCode === 410 || err.statusCode === 404)) {
          m.pushSubscriptions = m.pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
          removedAny = true;
        } else {
          console.error('Falha ao enviar push pro motoboy', motoboyId, err && err.message);
        }
      })
    )
  ).then(() => {
    if (removedAny) {
      const freshDb = loadDB(); // re-read: time has passed since we started
      const freshM = freshDb.motoboys[motoboyId];
      if (freshM) {
        freshM.pushSubscriptions = m.pushSubscriptions;
        saveDB(freshDb);
      }
    }
  });
}

// Notifies whoever is currently at the front of an order's offer queue —
// called both when an order is first created and every time advanceOffer()
// moves the offer to the next motoboy in line.
function notifyOfferedMotoboy(db, o) {
  if (!o.offerQueue || o.offerIndex >= o.offerQueue.length) return;
  const motoboyId = o.offerQueue[o.offerIndex];
  notifyMotoboy(motoboyId, {
    title: '📦 Nova corrida disponível',
    body: o.businessName + ' — R$ ' + Number(o.value || 0).toFixed(2),
    data: { type: 'new-offer', orderId: o.id }
  });
}

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
  const { passwordHash, pushSubscriptions, ...rest } = m;
  // Always expose the EFFECTIVE status (motoboyStatus applies the forced-
  // pause override) rather than the raw stored field, so the app can't show
  // "online" while a timeout penalty is actually keeping them paused.
  rest.status = motoboyStatus(m);
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
    // A business/motoboy blocked by the admin is locked out immediately,
    // even with an already-open session — not just on their next login.
    if (session.type === 'business' && db.businesses[session.id] && db.businesses[session.id].blocked) {
      return res.status(403).json({ error: 'Esta conta foi bloqueada. Fale com o suporte.' });
    }
    if (session.type === 'motoboy' && db.motoboys[session.id] && db.motoboys[session.id].blocked) {
      return res.status(403).json({ error: 'Esta conta foi bloqueada. Fale com o suporte.' });
    }
    req.authType = session.type;
    req.authId = session.id;
    next();
  };
}
const PASSWORD_MIN_LENGTH = 6;

// ---------------------------------------------------------------
// Admin — a single owner account, not a normal signup. The password
// lives in an environment variable (ADMIN_PASSWORD on Railway) instead of
// the database, so there's no registration flow to secure or lose access
// to. Anyone with that password gets a session of type 'admin', same
// mechanism as business/motoboy sessions (requireAuth('admin') below).
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return res.status(503).json({ error: 'Painel administrativo ainda não configurado neste servidor (falta ADMIN_PASSWORD).' });
  }
  if (!password || password !== expected) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  const db = loadDB();
  const token = createSession(db, 'admin', 'admin');
  saveDB(db);
  res.json({ token });
});

// Whole-picture views — every business, every motoboy, every order, plus a
// rollup summary. All read-only; the platform-owner UI is built on top of
// these on the front-end.
app.get('/api/admin/businesses', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const list = Object.values(db.businesses).map((b) => {
    const ridesCount = Object.values(db.orders).filter((o) => o.businessId === b.id && o.status === 'entregue').length;
    return Object.assign(sanitizeBusiness(b), { ridesCount });
  });
  res.json(list);
});

app.get('/api/admin/motoboys', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const list = Object.values(db.motoboys).map((m) => {
    const ridesCount = Object.values(db.orders).filter((o) => o.motoboyId === m.id && o.status === 'entregue').length;
    return Object.assign(sanitizeMotoboy(m), { ridesCount, rating: ratingSummary(db, 'motoboy', m.id) });
  });
  res.json(list);
});

app.get('/api/admin/orders', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  let list = Object.values(db.orders);
  if (req.query.status) list = list.filter((o) => o.status === req.query.status);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(list.slice(0, 500)); // plenty for a dashboard; avoids ever shipping an unbounded list
});

app.get('/api/admin/summary', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const orders = Object.values(db.orders);
  const delivered = orders.filter((o) => o.status === 'entregue');
  const active = orders.filter((o) => ACTIVE_STATUSES.includes(o.status));
  const businesses = Object.values(db.businesses);
  const motoboys = Object.values(db.motoboys);
  res.json({
    totalBusinesses: businesses.length,
    totalMotoboys: motoboys.length,
    motoboysOnline: motoboys.filter((m) => motoboyStatus(m) === 'online').length,
    motoboysPendingApproval: motoboys.filter((m) => m.approved === false).length,
    totalOrders: orders.length,
    deliveredOrders: delivered.length,
    activeOrders: active.length,
    canceledOrders: orders.filter((o) => o.status === 'cancelado').length,
    // Platform revenue so far: CREDIT_COST_PER_RIDE per completed delivery.
    platformRevenue: delivered.length * CREDIT_COST_PER_RIDE,
    // Total paid out to motoboys so far (the `value` field on each order is
    // what the motoboy earns for it — set when the business creates the ride).
    totalPaidToMotoboys: delivered.reduce((sum, o) => sum + (o.value || 0), 0),
    creditsInCirculation: businesses.reduce((sum, b) => sum + (b.credits || 0), 0)
  });
});

// Report buckets for the admin dashboard's chart. `period` controls both
// the range covered and how it's sliced:
//   'hoje'   -> today, one bucket per hour (00h..current hour)
//   'semana' -> last 7 days, one bucket per day
//   'mes'    -> last 30 days, one bucket per day
// Each bucket reports deliveries, cancellations, platform revenue (an
// automatic CREDIT_COST_PER_RIDE per delivery) and total paid to motoboys
// (the sum of each delivered ride's own `value`) — everything the chart
// and the totals row need, computed once here instead of on the front-end.
app.get('/api/admin/reports', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const period = ['hoje', 'semana', 'mes'].includes(req.query.period) ? req.query.period : 'semana';
  const orders = Object.values(db.orders);
  const now = new Date();

  let buckets; // [{label, start, end}]
  if (period === 'hoje') {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    buckets = [];
    for (let h = 0; h <= now.getHours(); h++) {
      const start = new Date(startOfDay).setHours(h, 0, 0, 0);
      const end = new Date(startOfDay).setHours(h, 59, 59, 999);
      buckets.push({ label: String(h).padStart(2, '0') + 'h', start, end });
    }
  } else {
    const days = period === 'semana' ? 7 : 30;
    buckets = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const start = new Date(day).setHours(0, 0, 0, 0);
      const end = new Date(day).setHours(23, 59, 59, 999);
      buckets.push({ label: String(day.getDate()).padStart(2, '0') + '/' + String(day.getMonth() + 1).padStart(2, '0'), start, end });
    }
  }

  const series = buckets.map((b) => {
    const delivered = orders.filter((o) => o.status === 'entregue' && o.deliveredAt >= b.start && o.deliveredAt <= b.end);
    const canceled = orders.filter((o) => o.status === 'cancelado' && o.cancelledAt >= b.start && o.cancelledAt <= b.end);
    return {
      label: b.label,
      delivered: delivered.length,
      canceled: canceled.length,
      revenue: delivered.length * CREDIT_COST_PER_RIDE,
      paidToMotoboys: delivered.reduce((sum, o) => sum + (o.value || 0), 0)
    };
  });

  const totals = series.reduce(
    (acc, s) => ({
      delivered: acc.delivered + s.delivered,
      canceled: acc.canceled + s.canceled,
      revenue: acc.revenue + s.revenue,
      paidToMotoboys: acc.paidToMotoboys + s.paidToMotoboys
    }),
    { delivered: 0, canceled: 0, revenue: 0, paidToMotoboys: 0 }
  );

  res.json({ period, series, totals });
});

// Block / unblock — a blocked business can't log in or create new rides; a
// blocked motoboy can't log in and is treated as offline for new offers.
// Existing in-progress rides are left alone (finish naturally) rather than
// yanked out from under whoever's mid-delivery.
app.patch('/api/admin/businesses/:id/block', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const b = db.businesses[req.params.id];
  if (!b) return res.status(404).json({ error: 'Comércio não encontrado' });
  b.blocked = !!req.body.blocked;
  saveDB(db);
  res.json(sanitizeBusiness(b));
});

app.patch('/api/admin/motoboys/:id/block', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  m.blocked = !!req.body.blocked;
  saveDB(db);
  res.json(sanitizeMotoboy(m));
});

// Approve (or reject/undo) a motoboy's registration. A rejected motoboy
// simply stays approved:false — they keep their account and can be
// approved later if it was a mistake, rather than being deleted outright.
app.patch('/api/admin/motoboys/:id/approve', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  m.approved = !!req.body.approved;
  saveDB(db);
  res.json(sanitizeMotoboy(m));
});

// Editing a comércio/motoboy's own basic details from the admin panel —
// same validation as their own self-edit routes above, just reachable by
// an admin instead of requiring the account holder to do it themselves.
app.patch('/api/admin/businesses/:id', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const b = db.businesses[req.params.id];
  if (!b) return res.status(404).json({ error: 'Comércio não encontrado' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) b.name = req.body.name.trim();
  if (typeof req.body.phone === 'string' && req.body.phone.trim()) b.phone = req.body.phone.trim();
  if (typeof req.body.address === 'string' && req.body.address.trim()) b.address = req.body.address.trim();
  if (typeof req.body.email === 'string' && req.body.email.trim()) {
    const emailLower = req.body.email.trim().toLowerCase();
    const taken = Object.values(db.businesses).some((x) => x.id !== b.id && (x.email || '').toLowerCase() === emailLower);
    if (taken) return res.status(409).json({ error: 'Esse e-mail já está em uso' });
    b.email = emailLower;
  }
  saveDB(db);
  res.json(sanitizeBusiness(b));
});

app.patch('/api/admin/motoboys/:id/details', requireAuth('admin'), (req, res) => {
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) m.name = req.body.name.trim();
  if (typeof req.body.phone === 'string' && req.body.phone.trim()) m.phone = req.body.phone.trim();
  if (typeof req.body.vehicle === 'string' && req.body.vehicle.trim()) m.vehicle = req.body.vehicle.trim();
  if (typeof req.body.email === 'string' && req.body.email.trim()) {
    const emailLower = req.body.email.trim().toLowerCase();
    const taken = Object.values(db.motoboys).some((x) => x.id !== m.id && (x.email || '').toLowerCase() === emailLower);
    if (taken) return res.status(409).json({ error: 'Esse e-mail já está em uso' });
    m.email = emailLower;
  }
  saveDB(db);
  res.json(sanitizeMotoboy(m));
});


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
  if (business.blocked) {
    return res.status(403).json({ error: 'Esta conta foi bloqueada. Fale com o suporte.' });
  }
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

// Updates basic profile fields. Only the business themself can edit their own record.
app.patch('/api/businesses/:id', requireAuth('business'), (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const db = loadDB();
  const b = db.businesses[req.params.id];
  if (!b) return res.status(404).json({ error: 'Comércio não encontrado' });

  if (typeof req.body.name === 'string' && req.body.name.trim()) b.name = req.body.name.trim();
  if (typeof req.body.phone === 'string' && req.body.phone.trim()) b.phone = req.body.phone.trim();
  if (typeof req.body.address === 'string' && req.body.address.trim()) b.address = req.body.address.trim();
  if (typeof req.body.email === 'string' && req.body.email.trim()) {
    const emailLower = req.body.email.trim().toLowerCase();
    const taken = Object.values(db.businesses).some((x) => x.id !== b.id && (x.email || '').toLowerCase() === emailLower);
    if (taken) return res.status(409).json({ error: 'Esse e-mail já está em uso' });
    b.email = emailLower;
  }

  saveDB(db);
  res.json(sanitizeBusiness(b));
});

app.post('/api/businesses/:id/change-password', requireAuth('business'), async (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'As senhas não coincidem' });
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` });
  }
  const db = loadDB();
  const b = db.businesses[req.params.id];
  if (!b) return res.status(404).json({ error: 'Comércio não encontrado' });
  const ok = await bcrypt.compare(currentPassword, b.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
  b.passwordHash = await bcrypt.hash(newPassword, 10);
  saveDB(db);
  res.json({ ok: true });
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
    status: 'offline', // 'online' | 'pausado' | 'offline'
    approved: false, // an admin has to approve before this motoboy can go online / receive rides
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
  if (motoboy.blocked) {
    return res.status(403).json({ error: 'Esta conta foi bloqueada. Fale com o suporte.' });
  }
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

const PICKUP_WINDOW_MS = 16 * 60 * 1000; // minutes the motoboy has to reach the pickup after accepting
const FORCED_PAUSE_MS = 10 * 60 * 1000; // penalty pause after missing that window

// Reads a motoboy's status, falling back to the old boolean `online` field
// for accounts created before the online/pausado/offline system existed,
// and forcing 'pausado' while a timeout penalty (forcedPauseUntil) is still
// running — even if the stored `status` field says something else.
function motoboyStatus(m) {
  if (m.blocked) return 'offline'; // blocked accounts never receive new rides, no matter their own toggle
  // approved === false (explicitly) means still awaiting admin review — a
  // motoboy record from before this feature existed has no `approved`
  // field at all (undefined), and stays treated as already approved so
  // existing accounts aren't suddenly locked out by this update.
  if (m.approved === false) return 'offline';
  if (m.forcedPauseUntil && Date.now() < m.forcedPauseUntil) return 'pausado';
  if (m.status) return m.status;
  return m.online ? 'online' : 'offline';
}
const MOTOBOY_STATUSES = ['online', 'pausado', 'offline'];

// Used for the online/pausado/offline toggle, and for updating basic
// profile fields. Only the motoboy themself can change their own record.
app.patch('/api/motoboys/:id', requireAuth('motoboy'), async (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });

  if (typeof req.body.status === 'string') {
    if (!MOTOBOY_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }
    if (req.body.status === 'online' && m.approved === false) {
      return res.status(403).json({ error: 'Seu cadastro ainda está em análise — você poderá ficar on-line assim que for aprovado.' });
    }
    if (req.body.status === 'online' && m.forcedPauseUntil && Date.now() < m.forcedPauseUntil) {
      const minutesLeft = Math.ceil((m.forcedPauseUntil - Date.now()) / 60000);
      return res.status(409).json({
        error: `Você perdeu a última corrida por não chegar a tempo — aguarde mais ${minutesLeft} min para voltar a ficar on-line.`,
        forcedPauseUntil: m.forcedPauseUntil
      });
    }
    m.status = req.body.status;
    m.online = m.status === 'online'; // kept in sync for backward compatibility
  } else if (typeof req.body.online === 'boolean') {
    // Old clients still sending {online: true/false} — keep working.
    if (req.body.online && m.approved === false) {
      return res.status(403).json({ error: 'Seu cadastro ainda está em análise — você poderá ficar on-line assim que for aprovado.' });
    }
    m.status = req.body.online ? 'online' : 'offline';
    m.online = req.body.online;
  }

  // Live location ping — the app sends this every so often while the
  // motoboy is online, purely so the offer queue can rank by real
  // distance to the pickup address (see buildOfferQueue). Not used for
  // anything else, and never required to keep the account online.
  if (typeof req.body.lat === 'number' && typeof req.body.lng === 'number') {
    m.lastLocation = { lat: req.body.lat, lng: req.body.lng, updatedAt: Date.now() };
  }

  if (typeof req.body.name === 'string' && req.body.name.trim()) m.name = req.body.name.trim();
  if (typeof req.body.phone === 'string' && req.body.phone.trim()) m.phone = req.body.phone.trim();
  if (typeof req.body.vehicle === 'string' && req.body.vehicle.trim()) m.vehicle = req.body.vehicle.trim();
  if (typeof req.body.email === 'string' && req.body.email.trim()) {
    const emailLower = req.body.email.trim().toLowerCase();
    const taken = Object.values(db.motoboys).some((x) => x.id !== m.id && (x.email || '').toLowerCase() === emailLower);
    if (taken) return res.status(409).json({ error: 'Esse e-mail já está em uso' });
    m.email = emailLower;
  }

  saveDB(db);
  res.json(sanitizeMotoboy(m));
});

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ enabled: pushEnabled, publicKey: VAPID_PUBLIC_KEY || null });
});

// Called by the front-end after the motoboy grants notification permission
// and subscribes via the service worker's pushManager. One motoboy can have
// several subscriptions (phone + tablet, or after reinstalling) — endpoint
// is the unique key, so subscribing again with the same one just updates it.
app.post('/api/motoboys/:id/push-subscription', requireAuth('motoboy'), (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Inscrição de notificação inválida' });
  }
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  if (!Array.isArray(m.pushSubscriptions)) m.pushSubscriptions = [];
  m.pushSubscriptions = m.pushSubscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  m.pushSubscriptions.push(subscription);
  saveDB(db);
  res.json({ ok: true });
});

// Called when the motoboy turns notifications off (or the app wants to
// clean up before unregistering) — removes just this device's subscription.
app.delete('/api/motoboys/:id/push-subscription', requireAuth('motoboy'), (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const { endpoint } = req.body || {};
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  m.pushSubscriptions = (m.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/motoboys/:id/change-password', requireAuth('motoboy'), async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'As senhas não coincidem' });
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` });
  }
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  const ok = await bcrypt.compare(currentPassword, m.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
  m.passwordHash = await bcrypt.hash(newPassword, 10);
  saveDB(db);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// Session
// ---------------------------------------------------------------

// Restores a session on app reload — the frontend keeps only the token,
// and asks "who am I" instead of trusting a locally-cached profile.
app.get('/api/me', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const db = loadDB();
  db.sessions = db.sessions || {};
  const session = db.sessions[token];
  if (!session) return res.status(401).json({ error: 'Sessão inválida' });
  if (session.type === 'business') {
    const b = db.businesses[session.id];
    if (!b) return res.status(401).json({ error: 'Conta não encontrada' });
    if (b.blocked) return res.status(403).json({ error: 'Esta conta foi bloqueada. Fale com o suporte.' });
    return res.json({ type: 'business', profile: sanitizeBusiness(b) });
  }
  if (session.type === 'admin') {
    return res.json({ type: 'admin', profile: { id: 'admin', name: 'Administrador' } });
  }
  const m = db.motoboys[session.id];
  if (!m) return res.status(401).json({ error: 'Conta não encontrada' });
  if (m.blocked) return res.status(403).json({ error: 'Esta conta foi bloqueada. Fale com o suporte.' });
  res.json({ type: 'motoboy', profile: sanitizeMotoboy(m) });
});

app.post('/api/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const db = loadDB();
    db.sessions = db.sessions || {};
    delete db.sessions[token];
    saveDB(db);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// Financial transactions ledger — every credit and debit to a business's
// balance gets a record here, so the extrato shows the full history.
// ---------------------------------------------------------------
function addTransaction(db, businessId, type, amount, description, orderId) {
  db.transactions = db.transactions || {};
  const id = shortId('txn');
  db.transactions[id] = {
    id,
    businessId,
    type, // 'credito' | 'debito'
    amount,
    description,
    orderId: orderId || null,
    createdAt: Date.now()
  };
  return db.transactions[id];
}

app.get('/api/businesses/:id/transactions', requireAuth('business'), (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const db = loadDB();
  db.transactions = db.transactions || {};
  const list = Object.values(db.transactions).filter((t) => t.businessId === req.params.id);
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// A simple, printable internal summary/receipt for the business — NOT an
// official fiscal invoice (nota fiscal eletrônica). Brazilian tax rules for
// that depend on how the business is registered (CNPJ/MEI/etc) and usually
// require a paid third-party integration (NFe.io, Focus NFe...), which is
// out of scope here. This just totals up what the business actually spent
// in a period, for their own records.
app.get('/api/businesses/:id/invoice', requireAuth('business'), (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  const db = loadDB();
  const business = db.businesses[req.params.id];
  if (!business) return res.status(404).json({ error: 'Comércio não encontrado' });

  const period = ['hoje', 'semana', 'mes'].includes(req.query.period) ? req.query.period : 'mes';
  const now = new Date();
  let start;
  let rangeLabel;
  if (period === 'hoje') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    rangeLabel = 'Hoje (' + now.toLocaleDateString('pt-BR') + ')';
  } else if (period === 'semana') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
    rangeLabel = 'Últimos 7 dias';
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime();
    rangeLabel = 'Últimos 30 dias';
  }

  const orders = Object.values(db.orders)
    .filter((o) => o.businessId === business.id && o.status === 'entregue' && o.deliveredAt >= start)
    .sort((a, b) => a.deliveredAt - b.deliveredAt);

  const totalCreditsSpent = orders.length * CREDIT_COST_PER_RIDE;
  const totalPaidToMotoboys = orders.reduce((sum, o) => sum + (o.value || 0), 0);

  res.json({
    business: { name: business.name, email: business.email, phone: business.phone, address: business.address },
    period,
    rangeLabel,
    generatedAt: Date.now(),
    orders: orders.map((o) => ({
      id: o.id,
      deliveredAt: o.deliveredAt,
      value: o.value,
      pickupAddress: o.pickupAddress,
      deliveryAddress: o.deliveryAddress,
      motoboyName: o.motoboyName || null
    })),
    totals: {
      deliveredCount: orders.length,
      totalCreditsSpent,
      totalPaidToMotoboys
    }
  });
});

// ---------------------------------------------------------------
// Credits (Pix top-up via Mercado Pago)
// ---------------------------------------------------------------

// Applies a confirmed payment to the business's balance exactly once,
// no matter how many times we're told about it (webhook + polling can
// both fire for the same payment).
function creditIfNewlyApproved(db, paymentRecord, mpStatus) {
  paymentRecord.status = mpStatus;
  if (mpStatus === 'approved' && !paymentRecord.credited) {
    const business = db.businesses[paymentRecord.businessId];
    if (business) {
      business.credits = (business.credits || 0) + paymentRecord.amount;
      paymentRecord.credited = true;
      addTransaction(db, business.id, 'credito', paymentRecord.amount, 'Recarga via Pix');
    }
  }
}

app.post('/api/businesses/:id/topup', requireAuth('business'), async (req, res) => {
  if (req.authId !== req.params.id) return res.status(403).json({ error: 'Não autorizado' });
  if (!mpPayment) {
    return res.status(503).json({ error: 'Pagamentos ainda não configurados neste servidor (falta MERCADOPAGO_ACCESS_TOKEN).' });
  }
  const db = loadDB();
  const business = db.businesses[req.params.id];
  if (!business) return res.status(404).json({ error: 'Comércio não encontrado' });

  const { amount, email, cpf } = req.body || {};
  const value = parseFloat(amount);
  if (!value || value <= 0) return res.status(400).json({ error: 'Informe um valor válido' });
  if (!email) return res.status(400).json({ error: 'Informe um e-mail para o pagamento' });

  try {
    const payer = { email };
    if (cpf) payer.identification = { type: 'CPF', number: String(cpf).replace(/\D/g, '') };

    const mpRes = await mpPayment.create({
      body: {
        transaction_amount: value,
        description: 'Créditos Despacho — ' + business.name,
        payment_method_id: 'pix',
        payer
      }
    });

    const record = {
      id: String(mpRes.id),
      businessId: business.id,
      amount: value,
      status: mpRes.status,
      credited: false,
      createdAt: Date.now()
    };
    if (mpRes.status === 'approved') creditIfNewlyApproved(db, record, mpRes.status);
    db.payments = db.payments || {};
    db.payments[record.id] = record;
    saveDB(db);

    const txData = (mpRes.point_of_interaction || {}).transaction_data || {};
    res.json({
      paymentId: record.id,
      status: record.status,
      qrCodeBase64: txData.qr_code_base64 || null,
      qrCode: txData.qr_code || null
    });
  } catch (e) {
    // Surface the real reason from Mercado Pago instead of a generic
    // message — the SDK usually puts the actual API error in e.cause.
    const detail = (e.cause && e.cause[0] && (e.cause[0].description || e.cause[0].message))
      || e.message
      || 'erro desconhecido';
    console.error('Erro ao criar pagamento Pix:', detail, JSON.stringify(e.cause || ''));
    res.status(502).json({ error: 'Não consegui gerar o Pix: ' + detail });
  }
});

// The app polls this while the Pix QR code is on screen, in case the
// webhook below is delayed or Railway is between deploys when it arrives.
app.get('/api/payments/:id/status', requireAuth('business'), async (req, res) => {
  const db = loadDB();
  db.payments = db.payments || {};
  const record = db.payments[req.params.id];
  if (!record) return res.status(404).json({ error: 'Pagamento não encontrado' });
  if (record.businessId !== req.authId) return res.status(403).json({ error: 'Não autorizado' });

  if (record.status !== 'approved' && mpPayment) {
    try {
      const mpRes = await mpPayment.get({ id: req.params.id });
      creditIfNewlyApproved(db, record, mpRes.status);
      saveDB(db);
    } catch (e) {
      console.error('Erro ao consultar status do pagamento:', e.message);
    }
  }
  const business = db.businesses[record.businessId];
  res.json({ status: record.status, credits: business ? business.credits : null });
});

// Mercado Pago calls this automatically when a payment's status changes.
// Configure this URL (https://SUA-API/api/webhooks/mercadopago) in your
// Mercado Pago dashboard under Webhooks.
app.post('/api/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately — Mercado Pago retries if we don't
  try {
    const paymentId = (req.body && req.body.data && req.body.data.id) || req.query['data.id'];
    if (!paymentId || !mpPayment) return;
    const db = loadDB();
    db.payments = db.payments || {};
    const record = db.payments[String(paymentId)];
    if (!record) return; // not one of ours (or not created through /topup)
    const mpRes = await mpPayment.get({ id: paymentId });
    creditIfNewlyApproved(db, record, mpRes.status);
    saveDB(db);
  } catch (e) {
    console.error('Erro no webhook do Mercado Pago:', e.message);
  }
});

// ---------------------------------------------------------------
// Orders
// ---------------------------------------------------------------
function rideCount(db, motoboyId) {
  return Object.values(db.orders).filter(
    (o) => o.motoboyId === motoboyId && (o.status === 'entregue' || ACTIVE_STATUSES.includes(o.status))
  ).length;
}

// How old a motoboy's last known GPS fix can be and still count as "live"
// for distance sorting. Older than this, we treat them as if we don't
// know where they are (falls back to the fewest-rides rule for them).
const LOCATION_FRESHNESS_MS = 10 * 60 * 1000; // 10 minutes

function hasFreshLocation(m) {
  return !!(
    m.lastLocation &&
    typeof m.lastLocation.lat === 'number' &&
    typeof m.lastLocation.lng === 'number' &&
    Date.now() - (m.lastLocation.updatedAt || 0) <= LOCATION_FRESHNESS_MS
  );
}

// Who gets offered the ride first: only online + free motoboys.
// If we know the pickup coordinates AND a motoboy's recent live location,
// the nearest motoboy goes first — that's the fair, real-world way to do
// it. Motoboys we can't place (no fresh GPS, or the pickup address didn't
// geocode) fall back to "fewest rides so far", same as before, and are
// slotted in after everyone we could measure a distance for.
function buildOfferQueue(db, pickupCoords) {
  const candidates = Object.values(db.motoboys).filter((m) => {
    if (motoboyStatus(m) !== 'online') return false; // pausado/offline never receive new rides
    const busy = Object.values(db.orders).some(
      (o) => o.motoboyId === m.id && ACTIVE_STATUSES.includes(o.status)
    );
    return !busy;
  });

  candidates.sort((a, b) => {
    const aHasDist = !!pickupCoords && hasFreshLocation(a);
    const bHasDist = !!pickupCoords && hasFreshLocation(b);
    if (aHasDist && bHasDist) {
      const da = distanceMeters(a.lastLocation.lat, a.lastLocation.lng, pickupCoords.lat, pickupCoords.lng);
      const db_ = distanceMeters(b.lastLocation.lat, b.lastLocation.lng, pickupCoords.lat, pickupCoords.lng);
      return da - db_;
    }
    if (aHasDist !== bHasDist) return aHasDist ? -1 : 1; // known distance beats unknown
    return rideCount(db, a.id) - rideCount(db, b.id); // tiebreaker / fallback
  });
  return candidates.map((m) => m.id);
}

// Moves the offer to the next motoboy in line (called both when someone
// explicitly declines and when their 30s window times out). If everyone
// in the current round has now passed, start a brand new round — re-check
// who's online right now and ring through everyone again, one at a time,
// instead of leaving it open to whoever grabs it first.
function advanceOffer(db, o) {
  o.offerIndex += 1;
  if (o.offerIndex >= o.offerQueue.length) {
    o.offerQueue = buildOfferQueue(db, o.pickupCoords);
    o.offerIndex = 0;
    o.declinedBy = []; // fresh round — everyone gets asked again
  }
  o.offeredAt = o.offerQueue.length > 0 ? Date.now() : null;
  notifyOfferedMotoboy(db, o);
}

function isOfferedTo(o, motoboyId) {
  if (o.status !== 'pendente') return false;
  if (o.declinedBy && o.declinedBy.includes(motoboyId)) return false;
  if (!o.offerQueue || o.offerQueue.length === 0) return true; // nobody was online — open to anyone
  if (o.offerIndex >= o.offerQueue.length) return true; // shouldn't normally happen now — safety fallback
  return o.offerQueue[o.offerIndex] === motoboyId;
}

const CREDIT_COST_PER_RIDE = 1; // every delivery costs exactly 1 credit, no matter what the motoboy is paid

app.post('/api/orders', requireAuth('business'), async (req, res) => {
  const businessId = req.authId;
  const { pickupAddress, deliveryAddress, value, note } = req.body || {};
  const db = loadDB();
  const business = db.businesses[businessId];
  if (!business) return res.status(404).json({ error: 'Comércio não encontrado' });
  if (!pickupAddress || !deliveryAddress || !value) {
    return res.status(400).json({ error: 'Preencha os endereços e o valor' });
  }
  const rideValue = parseFloat(value) || 0; // what the motoboy gets paid — unrelated to credits now
  const currentCredits = business.credits || 0;
  if (currentCredits < CREDIT_COST_PER_RIDE) {
    return res.status(402).json({
      error: `Créditos insuficientes (você tem ${currentCredits.toFixed(2)}) — adicione créditos para solicitar esta entrega.`,
      credits: currentCredits
    });
  }
  // Geocode both addresses so we can later enforce the GPS arrival lock,
  // and so the offer queue below can prioritize the nearest motoboy.
  // Sequential on purpose — keeps us within Nominatim's rate limit.
  const pickupCoords = await geocodeAddress(pickupAddress);
  const deliveryCoords = await geocodeAddress(deliveryAddress);

  // Built AFTER geocoding so it can sort candidates by real distance to
  // the pickup address instead of just fewest-rides-so-far.
  const offerQueue = buildOfferQueue(db, pickupCoords);

  const order = {
    id: shortId('ord'),
    businessId,
    businessName: business.name,
    businessPhone: business.phone,
    pickupAddress,
    deliveryAddress,
    pickupCoords, // {lat,lng} or null if the address couldn't be located
    deliveryCoords,
    value: rideValue, // paid to the motoboy — does not affect credit balance
    note: note || '',
    status: 'pendente',
    motoboyId: null,
    motoboyName: null,
    motoboyPhone: null,
    creditsCharged: true,
    offerQueue,
    offerIndex: 0,
    offeredAt: offerQueue.length > 0 ? Date.now() : null,
    declinedBy: [],
    createdAt: Date.now(),
    acceptedAt: null,
    arrivedPickupAt: null,
    departedAt: null,
    arrivedDeliveryAt: null,
    deliveredAt: null,
    cancelledAt: null,
    ratedByBusiness: false,
    ratedByMotoboy: false
  };
  // Re-read the db in case anything else wrote in the meantime (geocoding awaited above).
  const freshDb = loadDB();
  const freshBusiness = freshDb.businesses[businessId];
  if (!freshBusiness || (freshBusiness.credits || 0) < CREDIT_COST_PER_RIDE) {
    return res.status(402).json({ error: 'Créditos insuficientes — adicione créditos para solicitar esta entrega.' });
  }
  freshBusiness.credits -= CREDIT_COST_PER_RIDE;
  freshDb.orders[order.id] = order;
  addTransaction(freshDb, businessId, 'debito', CREDIT_COST_PER_RIDE, 'Entrega #' + order.id.slice(-6).toUpperCase() + ' (motoboy recebe ' + rideValue.toFixed(2) + ')', order.id);
  saveDB(freshDb);
  notifyOfferedMotoboy(freshDb, order);
  res.json(order);
});

// All orders belonging to whoever is logged in (business sees their own
// requests, motoboy sees rides they've been assigned to at some point).
app.get('/api/orders', requireAuth('business', 'motoboy'), (req, res) => {
  let orders = Object.values(loadDB().orders);
  if (req.authType === 'business') orders = orders.filter((o) => o.businessId === req.authId);
  else orders = orders.filter((o) => o.motoboyId === req.authId);
  orders.sort((a, b) => b.createdAt - a.createdAt);
  res.json(orders);
});

// Orders currently visible/offered to the logged-in motoboy — this is what
// the "Disponíveis" tab calls, so a motoboy never even receives orders
// that aren't theirs to see yet.
app.get('/api/orders/available', requireAuth('motoboy'), (req, res) => {
  const list = Object.values(loadDB().orders).filter((o) => isOfferedTo(o, req.authId));
  list.sort((a, b) => a.createdAt - b.createdAt);
  res.json(list);
});

app.get('/api/orders/:id', requireAuth('business', 'motoboy'), (req, res) => {
  const o = loadDB().orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Corrida não encontrada' });
  const owns = (req.authType === 'business' && o.businessId === req.authId) ||
               (req.authType === 'motoboy' && o.motoboyId === req.authId);
  if (!owns) return res.status(403).json({ error: 'Não autorizado' });
  res.json(o);
});

app.post('/api/orders/:id/accept', requireAuth('motoboy'), (req, res) => {
  const motoboyId = req.authId;
  const db = loadDB();
  const o = db.orders[req.params.id];
  const m = db.motoboys[motoboyId];
  if (!o || !m) return res.status(404).json({ error: 'Não encontrado' });
  if (motoboyStatus(m) !== 'online') {
    return res.status(409).json({ error: 'Fique on-line para aceitar corridas' });
  }
  const alreadyActive = Object.values(db.orders).some(
    (x) => x.motoboyId === motoboyId && ACTIVE_STATUSES.includes(x.status)
  );
  if (alreadyActive) return res.status(409).json({ error: 'Você já tem uma corrida em andamento' });
  if (o.status !== 'pendente') return res.status(409).json({ error: 'Corrida não está mais disponível' });
  if (!isOfferedTo(o, motoboyId)) {
    return res.status(409).json({ error: 'Corrida está sendo oferecida a outro motoboy no momento' });
  }
  o.status = 'aceito';
  o.motoboyId = motoboyId;
  o.motoboyName = m.name;
  o.motoboyPhone = m.phone;
  o.acceptedAt = Date.now();
  saveDB(db);
  res.json(o);
});

app.post('/api/orders/:id/decline', requireAuth('motoboy'), (req, res) => {
  const motoboyId = req.authId;
  const db = loadDB();
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Não encontrado' });
  if (o.status !== 'pendente') return res.json(o);
  o.declinedBy = Array.from(new Set([...(o.declinedBy || []), motoboyId]));
  if (o.offerQueue && o.offerQueue[o.offerIndex] === motoboyId) {
    advanceOffer(db, o);
  }
  saveDB(db);
  res.json(o);
});

// A motoboy who already accepted, but needs to back out before actually
// picking up the package (car broke down, emergency, etc). Unlike /cancel,
// this does NOT kill the order or refund the business — it puts the ride
// straight back into the offer queue for the next motoboy in line, exactly
// like a decline, so the business never has to notice or re-create it.
// Only allowed up to 'aceito' — once the package is physically in the
// motoboy's hands (arrived at pickup or later), backing out is a real
// problem for the business to know about, so that still has to go through
// /cancel instead.
app.post('/api/orders/:id/give-up', requireAuth('motoboy'), (req, res) => {
  const motoboyId = req.authId;
  const db = loadDB();
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Não encontrado' });
  if (o.motoboyId !== motoboyId) return res.status(403).json({ error: 'Essa corrida não é sua' });
  if (o.status !== 'aceito') {
    return res.status(409).json({
      error: 'Só dá pra devolver a corrida antes de retirar o pedido — depois disso, cancele em vez disso.'
    });
  }
  o.declinedBy = Array.from(new Set([...(o.declinedBy || []), motoboyId]));
  o.status = 'pendente';
  o.motoboyId = null;
  o.motoboyName = null;
  o.motoboyPhone = null;
  o.acceptedAt = null;
  advanceOffer(db, o); // hands it to the next motoboy in line, fresh 30s window
  saveDB(db);
  res.json(o);
});

// One helper for the straight-line stage transitions that DON'T need a
// GPS check (departing doesn't require proximity to anything). Only the
// motoboy assigned to this specific order can advance it.
function stageTransition(fromStatus, toStatus, extraFields) {
  return (req, res) => {
    const db = loadDB();
    const o = db.orders[req.params.id];
    if (!o) return res.status(404).json({ error: 'Não encontrado' });
    if (o.motoboyId !== req.authId) return res.status(403).json({ error: 'Essa corrida não é sua' });
    if (o.status !== fromStatus) {
      return res.status(409).json({ error: 'Etapa inválida — status atual: ' + o.status });
    }
    Object.assign(o, extraFields(req.body || {}));
    o.status = toStatus;
    saveDB(db);
    res.json(o);
  };
}

// GPS-gated transition: only allows arrival if the motoboy's reported
// position is within ARRIVAL_RADIUS_METERS of the target coordinates.
// If we don't have coordinates for that address (geocoding failed) or the
// motoboy's browser refused location, we require the location — this is
// the actual lock the person is trying to enforce.
function arrivalTransition(fromStatus, toStatus, coordsField, extraFields) {
  return (req, res) => {
    const db = loadDB();
    const o = db.orders[req.params.id];
    if (!o) return res.status(404).json({ error: 'Não encontrado' });
    if (o.motoboyId !== req.authId) return res.status(403).json({ error: 'Essa corrida não é sua' });
    if (o.status !== fromStatus) {
      return res.status(409).json({ error: 'Etapa inválida — status atual: ' + o.status });
    }
    const target = o[coordsField];
    const geo = req.body && req.body.geo;

    if (target && (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number')) {
      return res.status(412).json({
        error: 'Precisamos da sua localização para confirmar a chegada — ative o GPS e tente de novo.',
        needsGeo: true
      });
    }
    if (target && geo) {
      const dist = Math.round(distanceMeters(geo.lat, geo.lng, target.lat, target.lng));
      // A GPS fix always comes with a margin of error (geo.acc, in meters —
      // e.g. weak signal indoors or on a laptop can easily mean 200-400m).
      // If we ignore that margin, an honestly-arrived motoboy with a rough
      // fix gets wrongly blocked. So we allow the distance to exceed the
      // radius by up to the reported accuracy (capped, so a wildly
      // inaccurate/spoofed reading can't just disable the lock entirely).
      const accuracyAllowance = Math.min(typeof geo.acc === 'number' ? geo.acc : 0, MAX_ACCURACY_ALLOWANCE_METERS);
      const effectiveRadius = ARRIVAL_RADIUS_METERS + accuracyAllowance;
      if (dist > effectiveRadius) {
        return res.status(409).json({
          error: `Você está a ${dist}m do endereço — chegue mais perto (até ${effectiveRadius}m, considerando a precisão do seu GPS) para confirmar.`,
          distance: dist
        });
      }
    }
    // No coordinates for this address at all (geocoding never found it) —
    // can't verify, so we let it through rather than blocking the delivery entirely.
    Object.assign(o, extraFields(req.body || {}));
    o.status = toStatus;
    saveDB(db);
    res.json(o);
  };
}

app.post(
  '/api/orders/:id/arrive-pickup',
  requireAuth('motoboy'),
  arrivalTransition('aceito', 'no_local_retirada', 'pickupCoords', (body) => ({
    arrivedPickupAt: Date.now(),
    arrivedPickupGeo: body.geo || null
  }))
);
app.post(
  '/api/orders/:id/depart',
  requireAuth('motoboy'),
  stageTransition('no_local_retirada', 'em_entrega', () => ({ departedAt: Date.now() }))
);
app.post(
  '/api/orders/:id/arrive-delivery',
  requireAuth('motoboy'),
  arrivalTransition('em_entrega', 'no_local_entrega', 'deliveryCoords', (body) => ({
    arrivedDeliveryAt: Date.now(),
    arrivedDeliveryGeo: body.geo || null
  }))
);
app.post(
  '/api/orders/:id/deliver',
  requireAuth('motoboy'),
  stageTransition('no_local_entrega', 'entregue', () => ({ deliveredAt: Date.now() }))
);

// ---------------------------------------------------------------
// Ratings — one review per side per completed order (business rates the
// motoboy, motoboy rates the business). The order itself carries a
// ratedByBusiness/ratedByMotoboy flag so duplicate-checking is instant
// and free, no extra lookup needed.
// ---------------------------------------------------------------
function ratingSummary(db, type, id) {
  const list = Object.values(db.ratings || {}).filter((r) => r.toType === type && r.toId === id);
  if (list.length === 0) return { average: 0, count: 0 };
  const sum = list.reduce((s, r) => s + r.stars, 0);
  return { average: Math.round((sum / list.length) * 10) / 10, count: list.length };
}

app.post('/api/orders/:id/rate', requireAuth('business', 'motoboy'), (req, res) => {
  const db = loadDB();
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Não encontrado' });
  if (o.status !== 'entregue') return res.status(409).json({ error: 'Só é possível avaliar corridas já entregues' });

  const isBusiness = req.authType === 'business' && o.businessId === req.authId;
  const isMotoboy = req.authType === 'motoboy' && o.motoboyId === req.authId;
  if (!isBusiness && !isMotoboy) return res.status(403).json({ error: 'Você não participou dessa corrida' });

  if (isBusiness && o.ratedByBusiness) return res.status(409).json({ error: 'Você já avaliou essa corrida' });
  if (isMotoboy && o.ratedByMotoboy) return res.status(409).json({ error: 'Você já avaliou essa corrida' });

  const stars = parseInt(req.body && req.body.stars, 10);
  const comment = (req.body && req.body.comment) || '';
  if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: 'Escolha de 1 a 5 estrelas' });

  db.ratings = db.ratings || {};
  const rating = {
    id: shortId('rate'),
    orderId: o.id,
    fromType: req.authType,
    fromId: req.authId,
    toType: isBusiness ? 'motoboy' : 'business',
    toId: isBusiness ? o.motoboyId : o.businessId,
    stars,
    comment,
    createdAt: Date.now()
  };
  db.ratings[rating.id] = rating;

  if (isBusiness) o.ratedByBusiness = true;
  else o.ratedByMotoboy = true;

  saveDB(db);
  res.json({ ok: true, rating });
});

// Real average + count for a business or motoboy — never fabricated.
app.get('/api/ratings/:type/:id/summary', (req, res) => {
  const { type, id } = req.params;
  if (type !== 'business' && type !== 'motoboy') return res.status(400).json({ error: 'Tipo inválido' });
  const db = loadDB();
  res.json(ratingSummary(db, type, id));
});

// Either the business that owns the order, or the motoboy currently
// assigned to it, can cancel — anyone else gets rejected.
app.post('/api/orders/:id/cancel', requireAuth('business', 'motoboy'), (req, res) => {
  const db = loadDB();
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Não encontrado' });
  const isOwner = req.authType === 'business' && o.businessId === req.authId;
  const isAssignedMotoboy = req.authType === 'motoboy' && o.motoboyId === req.authId;
  if (!isOwner && !isAssignedMotoboy) return res.status(403).json({ error: 'Você não pode cancelar essa corrida' });
  const { reason, note } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'Selecione um motivo para o cancelamento' });
  if (o.creditsCharged) {
    const business = db.businesses[o.businessId];
    if (business) {
      business.credits = (business.credits || 0) + CREDIT_COST_PER_RIDE;
      addTransaction(db, o.businessId, 'credito', CREDIT_COST_PER_RIDE, 'Estorno — Entrega #' + o.id.slice(-6).toUpperCase() + ' cancelada', o.id);
    }
    o.creditsCharged = false;
  }
  o.status = 'cancelado';
  o.cancelledAt = Date.now();
  o.cancelledBy = req.authType; // 'business' | 'motoboy'
  o.cancelReason = reason;
  o.cancelNote = note || null;
  saveDB(db);
  res.json(o);
});

// ---------------------------------------------------------------
// Background job — advances any offer that timed out without a response,
// and takes back rides from motoboys who accepted but never reached the
// pickup within PICKUP_WINDOW_MS (same 16-minute window the app already
// shows as a countdown). That motoboy loses the ride — it goes straight
// back into the queue for the next one in line, same as a manual "give up"
// — and gets a forced 10-minute pause before they can go online again.
// (Only the pickup leg is handled this way: once a motoboy has actually
// picked up the package, en route to the delivery, there's no one else to
// hand a physical package to, so a late delivery can't be reassigned the
// same way — that stays a business decision via cancel/support instead.)
// Runs on the server itself, so it works even if every phone is asleep.
// ---------------------------------------------------------------
setInterval(() => {
  const db = loadDB();
  let changed = false;
  Object.values(db.orders).forEach((o) => {
    if (
      o.status === 'pendente' &&
      o.offerQueue &&
      o.offerQueue.length > 0 &&
      o.offerIndex < o.offerQueue.length &&
      o.offeredAt &&
      Date.now() - o.offeredAt > OFFER_TIMEOUT_MS
    ) {
      const skipped = o.offerQueue[o.offerIndex];
      o.declinedBy = Array.from(new Set([...(o.declinedBy || []), skipped]));
      advanceOffer(db, o);
      changed = true;
    }

    if (o.status === 'aceito' && o.acceptedAt && Date.now() - o.acceptedAt > PICKUP_WINDOW_MS) {
      const missedMotoboyId = o.motoboyId;
      o.declinedBy = Array.from(new Set([...(o.declinedBy || []), missedMotoboyId]));
      o.status = 'pendente';
      o.motoboyId = null;
      o.motoboyName = null;
      o.motoboyPhone = null;
      o.acceptedAt = null;
      o.missedPickupBy = Array.from(new Set([...(o.missedPickupBy || []), missedMotoboyId]));
      advanceOffer(db, o);

      const missedMotoboy = db.motoboys[missedMotoboyId];
      if (missedMotoboy) {
        missedMotoboy.forcedPauseUntil = Date.now() + FORCED_PAUSE_MS;
        missedMotoboy.status = 'online'; // stored status stays 'online' — motoboyStatus() overrides to 'pausado' meanwhile, then this takes over automatically once the pause is over
      }
      changed = true;
    }
  });
  if (changed) saveDB(db);
}, 5000);

// Serve the front-end (entregas.html) from this same server, so the one
// Railway URL works both as the API and as the app link people open on
// their phone. IMPORTANT: only this one file is exposed — never the whole
// folder (data.json has password hashes and personal data in it, and must
// never be reachable over HTTP).
const path = require('path');
// PWA assets (manifest, icon, service worker) live in their own folder —
// express.static only exposes what's inside public/, never the project
// root, so data.json (password hashes, personal data) stays unreachable.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'entregas.html')));
app.get('/entregas.html', (req, res) => res.sendFile(path.join(__dirname, 'entregas.html')));
// Admin panel — a completely separate page from the business/motoboy app,
// with its own link. Not linked from entregas.html at all; whoever runs
// the operation just needs to know/bookmark this address directly.
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/api', (req, res) => res.send('Despacho API rodando ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Despacho API na porta ' + PORT));
