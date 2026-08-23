const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { loadDB, saveDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const ACTIVE_STATUSES = ['aceito', 'no_local_retirada', 'em_entrega', 'no_local_entrega'];
const OFFER_TIMEOUT_MS = 30 * 1000; // seconds a motoboy has to accept/decline
const shortId = (prefix) => prefix + '_' + uuidv4().slice(0, 8);

// ---------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------
app.post('/api/businesses', (req, res) => {
  const { name, phone, address } = req.body || {};
  if (!name || !phone || !address) {
    return res.status(400).json({ error: 'Preencha nome, telefone e endereço' });
  }
  const db = loadDB();
  const business = { id: shortId('biz'), name, phone, address, createdAt: Date.now() };
  db.businesses[business.id] = business;
  saveDB(db);
  res.json(business);
});

app.get('/api/businesses', (req, res) => {
  res.json(Object.values(loadDB().businesses));
});

app.get('/api/businesses/:id', (req, res) => {
  const b = loadDB().businesses[req.params.id];
  if (!b) return res.status(404).json({ error: 'Comércio não encontrado' });
  res.json(b);
});

// ---------------------------------------------------------------
// Motoboys
// ---------------------------------------------------------------
app.post('/api/motoboys', (req, res) => {
  const { name, phone, vehicle } = req.body || {};
  if (!name || !phone || !vehicle) {
    return res.status(400).json({ error: 'Preencha nome, telefone e moto/placa' });
  }
  const db = loadDB();
  const motoboy = { id: shortId('moto'), name, phone, vehicle, online: false, createdAt: Date.now() };
  db.motoboys[motoboy.id] = motoboy;
  saveDB(db);
  res.json(motoboy);
});

app.get('/api/motoboys', (req, res) => {
  res.json(Object.values(loadDB().motoboys));
});

app.get('/api/motoboys/:id', (req, res) => {
  const m = loadDB().motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  res.json(m);
});

// Used for the online/offline toggle.
app.patch('/api/motoboys/:id', (req, res) => {
  const db = loadDB();
  const m = db.motoboys[req.params.id];
  if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
  if (typeof req.body.online === 'boolean') m.online = req.body.online;
  saveDB(db);
  res.json(m);
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

app.post('/api/orders', (req, res) => {
  const { businessId, pickupAddress, deliveryAddress, value, note } = req.body || {};
  const db = loadDB();
  const business = db.businesses[businessId];
  if (!business) return res.status(404).json({ error: 'Comércio não encontrado' });
  if (!pickupAddress || !deliveryAddress || !value) {
    return res.status(400).json({ error: 'Preencha os endereços e o valor' });
  }
  const offerQueue = buildOfferQueue(db);
  const order = {
    id: shortId('ord'),
    businessId,
    businessName: business.name,
    businessPhone: business.phone,
    pickupAddress,
    deliveryAddress,
    value: parseFloat(value) || 0,
    note: note || '',
    status: 'pendente',
    motoboyId: null,
    motoboyName: null,
    motoboyPhone: null,
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
  db.orders[order.id] = order;
  saveDB(db);
  res.json(order);
});

// All orders, optionally filtered by ?businessId= or ?motoboyId=
app.get('/api/orders', (req, res) => {
  let orders = Object.values(loadDB().orders);
  if (req.query.businessId) orders = orders.filter((o) => o.businessId === req.query.businessId);
  if (req.query.motoboyId) orders = orders.filter((o) => o.motoboyId === req.query.motoboyId);
  orders.sort((a, b) => b.createdAt - a.createdAt);
  res.json(orders);
});

// Orders currently visible/offered to one specific motoboy — this is what
// the "Disponíveis" tab should call instead of filtering the full list
// client-side, so a motoboy never even receives orders that aren't theirs yet.
app.get('/api/orders/available/:motoboyId', (req, res) => {
  const list = Object.values(loadDB().orders).filter((o) => isOfferedTo(o, req.params.motoboyId));
  list.sort((a, b) => a.createdAt - b.createdAt);
  res.json(list);
});

app.get('/api/orders/:id', (req, res) => {
  const o = loadDB().orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Corrida não encontrada' });
  res.json(o);
});

app.post('/api/orders/:id/accept', (req, res) => {
  const { motoboyId } = req.body || {};
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

app.post('/api/orders/:id/decline', (req, res) => {
  const { motoboyId } = req.body || {};
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

// One helper for the four straight-line stage transitions.
function stageTransition(fromStatus, toStatus, extraFields) {
  return (req, res) => {
    const db = loadDB();
    const o = db.orders[req.params.id];
    if (!o) return res.status(404).json({ error: 'Não encontrado' });
    if (o.status !== fromStatus) {
      return res.status(409).json({ error: 'Etapa inválida — status atual: ' + o.status });
    }
    Object.assign(o, extraFields(req.body || {}));
    o.status = toStatus;
    saveDB(db);
    res.json(o);
  };
}

app.post(
  '/api/orders/:id/arrive-pickup',
  stageTransition('aceito', 'no_local_retirada', (body) => ({
    arrivedPickupAt: Date.now(),
    arrivedPickupGeo: body.geo || null
  }))
);
app.post(
  '/api/orders/:id/depart',
  stageTransition('no_local_retirada', 'em_entrega', () => ({ departedAt: Date.now() }))
);
app.post(
  '/api/orders/:id/arrive-delivery',
  stageTransition('em_entrega', 'no_local_entrega', (body) => ({
    arrivedDeliveryAt: Date.now(),
    arrivedDeliveryGeo: body.geo || null
  }))
);
app.post(
  '/api/orders/:id/deliver',
  stageTransition('no_local_entrega', 'entregue', () => ({ deliveredAt: Date.now() }))
);

app.post('/api/orders/:id/cancel', (req, res) => {
  const db = loadDB();
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Não encontrado' });
  o.status = 'cancelado';
  o.cancelledAt = Date.now();
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
