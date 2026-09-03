const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { loadDB, saveDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { loadDB, saveDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const ACTIVE_STATUSES = ['aceito', 'no_local_retirada', 'em_entrega', 'no_local_entrega'];
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
  res.json(sanitizeMotoboy(m));
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
    return res.json({ type: 'business', profile: sanitizeBusiness(b) });
  }
  const m = db.motoboys[session.id];
  if (!m) return res.status(401).json({ error: 'Conta não encontrada' });
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

// Who gets offered the ride first: only online + free motoboys, ordered by
// whoever has done the fewest rides so far (spreads the work around).
// If you later add geocoded addresses, sort by distance here instead.
function buildOfferQueue(db) {
  const candidates = Object.values(db.motoboys).filter((m) => {
    if (!m.online) return false;
    const busy = Object.values(db.orders).some(
      (o) => o.motoboyId === m.id && ACTIVE_STATUSES.includes(o.status)
    );
    return !busy;
  });
  candidates.sort((a, b) => rideCount(db, a.id) - rideCount(db, b.id));
  return candidates.map((m) => m.id);
}

function isOfferedTo(o, motoboyId) {
  if (o.status !== 'pendente') return false;
  if (o.declinedBy && o.declinedBy.includes(motoboyId)) return false;
  if (!o.offerQueue || o.offerQueue.length === 0) return true; // nobody was online — open to anyone
  if (o.offerIndex >= o.offerQueue.length) return true; // everyone passed — open to anyone left
  return o.offerQueue[o.offerIndex] === motoboyId;
}

app.post('/api/orders', requireAuth('business'), async (req, res) => {
  const businessId = req.authId;
  const { pickupAddress, deliveryAddress, value, note } = req.body || {};
  const db = loadDB();
  const business = db.businesses[businessId];
  if (!business) return res.status(404).json({ error: 'Comércio não encontrado' });
  if (!pickupAddress || !deliveryAddress || !value) {
    return res.status(400).json({ error: 'Preencha os endereços e o valor' });
  }
  const rideValue = parseFloat(value) || 0;
  const currentCredits = business.credits || 0;
  if (currentCredits < rideValue) {
    return res.status(402).json({
      error: `Saldo insuficiente (você tem ${currentCredits.toFixed(2)} de crédito) — adicione créditos para solicitar esta entrega.`,
      credits: currentCredits
    });
  }
  const offerQueue = buildOfferQueue(db);

  // Geocode both addresses so we can later enforce the GPS arrival lock.
  // Sequential on purpose — keeps us within Nominatim's rate limit.
  const pickupCoords = await geocodeAddress(pickupAddress);
  const deliveryCoords = await geocodeAddress(deliveryAddress);

  const order = {
    id: shortId('ord'),
    businessId,
    businessName: business.name,
    businessPhone: business.phone,
    pickupAddress,
    deliveryAddress,
    pickupCoords, // {lat,lng} or null if the address couldn't be located
    deliveryCoords,
    value: rideValue,
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
    cancelledAt: null
  };
  // Re-read the db in case anything else wrote in the meantime (geocoding awaited above).
  const freshDb = loadDB();
  const freshBusiness = freshDb.businesses[businessId];
  if (!freshBusiness || (freshBusiness.credits || 0) < rideValue) {
    return res.status(402).json({ error: 'Saldo insuficiente — adicione créditos para solicitar esta entrega.' });
  }
  freshBusiness.credits -= rideValue;
  freshDb.orders[order.id] = order;
  addTransaction(freshDb, businessId, 'debito', rideValue, 'Entrega #' + order.id.slice(-6).toUpperCase(), order.id);
  saveDB(freshDb);
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
    o.offerIndex += 1;
    o.offeredAt = Date.now();
  }
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
      if (dist > ARRIVAL_RADIUS_METERS) {
        return res.status(409).json({
          error: `Você está a ${dist}m do endereço — chegue mais perto (até ${ARRIVAL_RADIUS_METERS}m) para confirmar.`,
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
      business.credits = (business.credits || 0) + o.value;
      addTransaction(db, o.businessId, 'credito', o.value, 'Estorno — Entrega #' + o.id.slice(-6).toUpperCase() + ' cancelada', o.id);
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
// Background job — advances any offer that timed out without a response.
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
      o.offerIndex += 1;
      o.offeredAt = Date.now();
      changed = true;
    }
  });
  if (changed) saveDB(db);
}, 5000);

app.get('/', (req, res) => res.send('Despacho API rodando ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Despacho API na porta ' + PORT));
