'use strict';
/*
 * Reserve: restaurant table booking with a built-in MCP server.
 * There is no AI model, SDK or API key anywhere in this project.
 * The guest's own Claude connects to /mcp and does the thinking;
 * this app only stores, validates and serves the data.
 */
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const MANAGER_PASSCODE = process.env.MANAGER_PASSCODE || 'manager123';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'reserve.db');

const DURATION = 90;          // minutes a table is held
const OPEN = 12 * 60;         // earliest start 12:00
const LAST_START = 22 * 60;   // latest start 22:00
const MAX_PARTY = 12;
const GRID_COLS = 5;
const GRID_ROWS = 4;

/* ---------- database ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL,
  cuisine TEXT NOT NULL, rating REAL NOT NULL, address TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  label TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 12),
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE, connect_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  table_id INTEGER NOT NULL REFERENCES dining_tables(id),
  guest_id INTEGER NOT NULL REFERENCES guests(id),
  party_size INTEGER NOT NULL,
  date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  table_id INTEGER NOT NULL REFERENCES dining_tables(id),
  date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(table_id, date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_guest ON bookings(guest_id, date);
CREATE INDEX IF NOT EXISTS idx_blocks_slot ON blocks(table_id, date);

-- The database itself refuses overlapping bookings, so two simultaneous
-- requests can never hold the same table at the same time.
CREATE TRIGGER IF NOT EXISTS bookings_no_overlap
BEFORE INSERT ON bookings WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN') WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.table_id = NEW.table_id AND b.date = NEW.date AND b.status = 'confirmed'
      AND b.start_min < NEW.end_min AND b.end_min > NEW.start_min);
  SELECT RAISE(ABORT, 'SLOT_BLOCKED') WHERE EXISTS (
    SELECT 1 FROM blocks k
    WHERE k.table_id = NEW.table_id AND k.date = NEW.date
      AND k.start_min < NEW.end_min AND k.end_min > NEW.start_min);
END;
`);

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM restaurants').get().c) return;
  const restaurants = [
    ['Kopper & Cane', 'Indiranagar', 'South Indian', 4.6, '12th Main, Indiranagar, Bengaluru'],
    ['Saffron Lane', 'Koramangala', 'North Indian', 4.5, '5th Block, Koramangala, Bengaluru'],
    ['Olive & Ember', 'Church Street', 'Mediterranean', 4.3, 'Church Street, Bengaluru'],
    ['Coastline 29', 'Jayanagar', 'Coastal', 4.7, '4th Block, Jayanagar, Bengaluru'],
  ];
  const layout = [[1, 1, 2], [2, 1, 2], [3, 1, 4], [4, 1, 4], [1, 2, 2], [2, 2, 4], [3, 2, 6], [4, 2, 6]];
  const insR = db.prepare('INSERT INTO restaurants (name,area,cuisine,rating,address) VALUES (?,?,?,?,?)');
  const insT = db.prepare('INSERT INTO dining_tables (restaurant_id,label,seats,x,y) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (const r of restaurants) {
      const id = insR.run(...r).lastInsertRowid;
      layout.forEach(([x, y, seats], i) => insT.run(id, `T${i + 1}`, seats, x, y));
    }
  })();
}
seed();

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function nowIST() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
function toMin(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || '').trim());
  if (!m) throw new HttpError(400, 'Time must be in 24-hour HH:MM format, for example 19:30.');
  return Number(m[1]) * 60 + Number(m[2]);
}
const fmtMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function validDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
  const dt = new Date(d + 'T00:00:00Z');
  return !isNaN(dt) && dt.toISOString().slice(0, 10) === d;
}
function parseSlot(date, time, allowPast = false) {
  if (!validDate(date)) throw new HttpError(400, 'Date must be a real date in YYYY-MM-DD format.');
  const start = toMin(time);
  if (start < OPEN || start > LAST_START) throw new HttpError(400, 'Bookings start between 12:00 and 22:00.');
  const now = nowIST();
  if (!allowPast && (date < now.date || (date === now.date && start < now.min))) {
    throw new HttpError(400, 'That time has already passed. Choose a later time.');
  }
  return { date, start, end: start + DURATION };
}
function parseParty(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTY) throw new HttpError(400, `Party size must be a whole number from 1 to ${MAX_PARTY}.`);
  return n;
}
const cleanText = (v, max, what) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > max) throw new HttpError(400, `${what} is required and must be at most ${max} characters.`);
  return s;
};

function findRestaurant(v) {
  if (v === undefined || v === null || v === '') throw new HttpError(400, 'restaurant_id is required.');
  let r;
  if (/^\d+$/.test(String(v))) r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(Number(v));
  if (!r) r = db.prepare('SELECT * FROM restaurants WHERE lower(name) LIKE ?').get('%' + String(v).toLowerCase() + '%');
  if (!r) throw new HttpError(404, 'Restaurant not found. Use search_restaurants to get a valid restaurant_id.');
  return r;
}

function floorState(rid, date, start, end) {
  const tables = db.prepare('SELECT id,label,seats,x,y FROM dining_tables WHERE restaurant_id=? AND active=1 ORDER BY y,x').all(rid);
  const booked = db.prepare(`
    SELECT b.table_id, b.ref, b.party_size, g.name AS guest_name
    FROM bookings b JOIN guests g ON g.id = b.guest_id
    WHERE b.restaurant_id=? AND b.date=? AND b.status='confirmed' AND b.start_min<? AND b.end_min>?`).all(rid, date, end, start);
  const blocked = db.prepare('SELECT table_id FROM blocks WHERE restaurant_id=? AND date=? AND start_min<? AND end_min>?').all(rid, date, end, start);
  const bm = new Map(booked.map(b => [b.table_id, b]));
  const blm = new Set(blocked.map(b => b.table_id));
  return tables.map(t => ({
    ...t,
    state: bm.has(t.id) ? 'booked' : blm.has(t.id) ? 'blocked' : 'vacant',
    booking: bm.get(t.id) || null,
  }));
}

const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newRef = () => Array.from({ length: 6 }, () => REF_CHARS[crypto.randomInt(REF_CHARS.length)]).join('');

const bookingRow = ref => db.prepare(`
  SELECT b.ref, b.party_size, b.date, b.start_min, b.end_min, b.status, b.source, b.guest_id,
         r.id AS restaurant_id, r.name AS restaurant, r.area, r.address,
         t.label AS table_label, t.seats AS table_seats, g.name AS guest_name
  FROM bookings b
  JOIN restaurants r ON r.id=b.restaurant_id
  JOIN dining_tables t ON t.id=b.table_id
  JOIN guests g ON g.id=b.guest_id
  WHERE b.ref=?`).get(ref);
function present(b) {
  if (!b) return null;
  const { guest_id, start_min, end_min, ...rest } = b;
  return { ...rest, start: fmtMin(start_min), end: fmtMin(end_min) };
}

const insertBooking = db.prepare(`INSERT INTO bookings
  (ref,restaurant_id,table_id,guest_id,party_size,date,start_min,end_min,source) VALUES (?,?,?,?,?,?,?,?,?)`);

const bookTx = db.transaction((guest, o) => {
  const slot = parseSlot(o.date, o.time);
  const party = parseParty(o.party_size);
  const r = findRestaurant(o.restaurant_id);
  const floor = floorState(r.id, slot.date, slot.start, slot.end);
  let t;
  if (o.table_id !== undefined && o.table_id !== null && o.table_id !== '') {
    t = floor.find(x => x.id === Number(o.table_id));
    if (!t) throw new HttpError(404, 'That table does not exist at this restaurant.');
    if (t.state !== 'vacant') throw new HttpError(409, 'That table is not available at this time. Choose another table or time.');
    if (t.seats < party) throw new HttpError(400, `Table ${t.label} seats ${t.seats}, but the party is ${party}.`);
  } else {
    t = floor.filter(x => x.state === 'vacant' && x.seats >= party).sort((a, b) => a.seats - b.seats || a.id - b.id)[0];
    if (!t) throw new HttpError(409, 'No table is free for that time and party size.');
  }
  for (let i = 0; i < 6; i++) {
    const ref = newRef();
    try {
      insertBooking.run(ref, r.id, t.id, guest.id, party, slot.date, slot.start, slot.end, o.source || 'app');
      return present(bookingRow(ref));
    } catch (e) {
      if (/bookings\.ref/.test(e.message)) continue;
      throw e;
    }
  }
  throw new HttpError(500, 'Could not create a booking reference. Try again.');
});
function book(guest, o) {
  try {
    const result = bookTx(guest, o);
    notify();
    return result;
  } catch (e) {
    if (/SLOT_(TAKEN|BLOCKED)/.test(e.message)) throw new HttpError(409, 'That table was just taken. Choose another table or time.');
    throw e;
  }
}
function cancel(ref, guestId) {
  const row = bookingRow(String(ref || '').toUpperCase());
  if (!row) throw new HttpError(404, 'Booking not found.');
  if (guestId !== null && row.guest_id !== guestId) throw new HttpError(403, 'This booking belongs to another guest.');
  if (row.status === 'confirmed') {
    db.prepare("UPDATE bookings SET status='cancelled' WHERE ref=?").run(row.ref);
    notify();
  }
  return present(bookingRow(row.ref));
}

function alternativeTimes(rid, date, party, start) {
  const now = nowIST();
  const ok = [];
  for (let m = OPEN; m <= LAST_START; m += 30) {
    if (date === now.date && m < now.min) continue;
    if (floorState(rid, date, m, m + DURATION).some(t => t.state === 'vacant' && t.seats >= party)) ok.push(m);
  }
  return ok.sort((a, b) => Math.abs(a - start) - Math.abs(b - start)).slice(0, 5).sort((a, b) => a - b).map(fmtMin);
}

/* ---------- guests and manager auth ---------- */
function newKey() { return crypto.randomBytes(18).toString('base64url'); } // 24 characters
function signIn(name, email) {
  name = cleanText(name, 60, 'Name');
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new HttpError(400, 'Enter a valid email address.');
  let g = db.prepare('SELECT * FROM guests WHERE email=?').get(email);
  if (g) db.prepare('UPDATE guests SET name=? WHERE id=?').run(name, g.id);
  else db.prepare('INSERT INTO guests (name,email,connect_key) VALUES (?,?,?)').run(name, email, newKey());
  g = db.prepare('SELECT * FROM guests WHERE email=?').get(email);
  return { name: g.name, email: g.email, key: g.connect_key };
}
const guestByKey = key => (key ? db.prepare('SELECT * FROM guests WHERE connect_key=?').get(String(key)) : undefined);
function requireGuest(req) {
  const g = guestByKey(req.get('x-guest-key') || req.query.key);
  if (!g) throw new HttpError(401, 'Sign in first.');
  return g;
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function managerToken() { const exp = String(Date.now() + 8 * 3600e3); return `${exp}.${hmac(exp)}`; }
function validManagerToken(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(hmac(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(exp) > Date.now();
}
function requireManager(req) {
  if (!validManagerToken(req.get('x-manager-token'))) throw new HttpError(401, 'Manager passcode required.');
}
const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 10 * 60e3 }); return; }
  if (++a.n > 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}

/* ---------- live updates (server-sent events) ---------- */
const clients = new Set();
function notify() { for (const c of clients) c.write(`data: ${Date.now()}\n\n`); }
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();

/* ---------- web app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const wrap = fn => (req, res, next) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); }
};

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/guest', wrap(req => signIn(req.body.name, req.body.email)));
app.get('/api/me', wrap(req => { const g = requireGuest(req); return { name: g.name, email: g.email, key: g.connect_key }; }));

app.get('/api/restaurants', wrap(() => db.prepare('SELECT * FROM restaurants ORDER BY rating DESC, name').all()));

app.get('/api/restaurants/:id/floor', wrap(req => {
  const r = findRestaurant(req.params.id);
  const slot = parseSlot(req.query.date, req.query.time, req.query.past === '1');
  const tables = floorState(r.id, slot.date, slot.start, slot.end).map(({ booking, ...t }) => t);
  return { restaurant: r, date: slot.date, start: fmtMin(slot.start), end: fmtMin(slot.end), cols: GRID_COLS, tables };
}));

app.post('/api/bookings', wrap(req => {
  const g = requireGuest(req);
  return book(g, { ...req.body, source: 'app' });
}));
app.get('/api/bookings/:ref', wrap(req => {
  const b = bookingRow(String(req.params.ref).toUpperCase());
  if (!b) throw new HttpError(404, 'Booking not found.');
  return present(b);
}));
app.post('/api/bookings/:ref/cancel', wrap(req => cancel(req.params.ref, requireGuest(req).id)));

/* ---------- manager API ---------- */
app.post('/api/manager/login', wrap(req => {
  throttle(req.ip);
  const ok = crypto.timingSafeEqual(sha(req.body.passcode ?? ''), sha(MANAGER_PASSCODE));
  if (!ok) throw new HttpError(401, 'Wrong passcode.');
  return { token: managerToken() };
}));

app.get('/api/manager/restaurants/:id/floor', wrap(req => {
  requireManager(req);
  const r = findRestaurant(req.params.id);
  const slot = parseSlot(req.query.date, req.query.time, true);
  return { restaurant: r, date: slot.date, start: fmtMin(slot.start), end: fmtMin(slot.end), cols: GRID_COLS, tables: floorState(r.id, slot.date, slot.start, slot.end) };
}));

function labelTaken(rid, label, exceptId = 0) {
  return !!db.prepare('SELECT 1 FROM dining_tables WHERE restaurant_id=? AND active=1 AND lower(label)=lower(?) AND id!=?').get(rid, label, exceptId);
}
function tableOr404(id) {
  const t = db.prepare('SELECT * FROM dining_tables WHERE id=? AND active=1').get(Number(id));
  if (!t) throw new HttpError(404, 'Table not found.');
  return t;
}

app.post('/api/manager/restaurants/:id/tables', wrap(req => {
  requireManager(req);
  const r = findRestaurant(req.params.id);
  const seats = parseSeats(req.body.seats);
  let label = String(req.body.label || '').trim();
  if (!label) {
    const nums = db.prepare('SELECT label FROM dining_tables WHERE restaurant_id=? AND active=1').all(r.id)
      .map(t => /^T(\d+)$/i.exec(t.label)).filter(Boolean).map(m => Number(m[1]));
    label = 'T' + (Math.max(0, ...nums) + 1);
  }
  label = cleanText(label, 12, 'Table name');
  if (labelTaken(r.id, label)) throw new HttpError(409, `A table named ${label} already exists.`);
  const used = new Set(db.prepare('SELECT x,y FROM dining_tables WHERE restaurant_id=? AND active=1').all(r.id).map(c => `${c.x},${c.y}`));
  let cell = null;
  for (let y = 1; y <= GRID_ROWS && !cell; y++) for (let x = 1; x <= GRID_COLS && !cell; x++) if (!used.has(`${x},${y}`)) cell = { x, y };
  if (!cell) throw new HttpError(400, 'The floor plan is full. Remove a table first.');
  db.prepare('INSERT INTO dining_tables (restaurant_id,label,seats,x,y) VALUES (?,?,?,?,?)').run(r.id, label, seats, cell.x, cell.y);
  notify();
  return { ok: true };
}));
function parseSeats(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new HttpError(400, 'Seats must be a whole number from 1 to 12.');
  return n;
}

app.patch('/api/manager/tables/:id', wrap(req => {
  requireManager(req);
  const t = tableOr404(req.params.id);
  const label = req.body.label !== undefined ? cleanText(req.body.label, 12, 'Table name') : t.label;
  const seats = req.body.seats !== undefined ? parseSeats(req.body.seats) : t.seats;
  if (labelTaken(t.restaurant_id, label, t.id)) throw new HttpError(409, `A table named ${label} already exists.`);
  if (seats < t.seats) {
    const today = nowIST().date;
    const clash = db.prepare("SELECT COUNT(*) c FROM bookings WHERE table_id=? AND status='confirmed' AND date>=? AND party_size>?").get(t.id, today, seats).c;
    if (clash) throw new HttpError(409, `Upcoming bookings here are for more than ${seats} guests. Cancel them first.`);
  }
  db.prepare('UPDATE dining_tables SET label=?, seats=? WHERE id=?').run(label, seats, t.id);
  notify();
  return { ok: true };
}));

app.delete('/api/manager/tables/:id', wrap(req => {
  requireManager(req);
  const t = tableOr404(req.params.id);
  db.transaction(() => {
    db.prepare("UPDATE bookings SET status='cancelled' WHERE table_id=? AND status='confirmed' AND date>=?").run(t.id, nowIST().date);
    db.prepare('DELETE FROM blocks WHERE table_id=?').run(t.id);
    db.prepare('UPDATE dining_tables SET active=0 WHERE id=?').run(t.id);
  })();
  notify();
  return { ok: true };
}));

app.post('/api/manager/tables/:id/block', wrap(req => {
  requireManager(req);
  const t = tableOr404(req.params.id);
  const s = parseSlot(req.body.date, req.body.time, false);
  const clash = db.prepare("SELECT 1 FROM bookings WHERE table_id=? AND date=? AND status='confirmed' AND start_min<? AND end_min>?").get(t.id, s.date, s.end, s.start);
  if (clash) throw new HttpError(409, 'This table has a booking in that slot. Cancel the booking first.');
  const already = db.prepare('SELECT 1 FROM blocks WHERE table_id=? AND date=? AND start_min<? AND end_min>?').get(t.id, s.date, s.end, s.start);
  if (!already) db.prepare('INSERT INTO blocks (restaurant_id,table_id,date,start_min,end_min) VALUES (?,?,?,?,?)').run(t.restaurant_id, t.id, s.date, s.start, s.end);
  notify();
  return { ok: true };
}));
app.post('/api/manager/tables/:id/free', wrap(req => {
  requireManager(req);
  const t = tableOr404(req.params.id);
  const s = parseSlot(req.body.date, req.body.time, true);
  db.prepare('DELETE FROM blocks WHERE table_id=? AND date=? AND start_min<? AND end_min>?').run(t.id, s.date, s.end, s.start);
  notify();
  return { ok: true };
}));

app.get('/api/manager/bookings/today', wrap(req => {
  requireManager(req);
  const r = findRestaurant(req.query.restaurant_id);
  const rows = db.prepare(`
    SELECT b.ref, b.party_size, b.start_min, b.end_min, b.source, t.label AS table_label, g.name AS guest_name
    FROM bookings b JOIN dining_tables t ON t.id=b.table_id JOIN guests g ON g.id=b.guest_id
    WHERE b.restaurant_id=? AND b.date=? AND b.status='confirmed' ORDER BY b.start_min, t.label`).all(r.id, nowIST().date);
  return { date: nowIST().date, bookings: rows.map(({ start_min, end_min, ...x }) => ({ ...x, start: fmtMin(start_min), end: fmtMin(end_min) })) };
}));
app.post('/api/manager/bookings/:ref/cancel', wrap(req => { requireManager(req); return cancel(req.params.ref, null); }));

/* ---------- MCP server (streamable HTTP, JSON-RPC) ---------- */
const TOOLS = [
  {
    name: 'search_restaurants',
    description: 'Find restaurants that accept table bookings through Reserve. Optionally filter by area (for example Indiranagar), cuisine, or a minimum rating. Results are sorted by rating, highest first. Call this first to get a restaurant_id.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Neighbourhood to match, for example "Koramangala".' },
        cuisine: { type: 'string', description: 'Cuisine to match, for example "South Indian".' },
        min_rating: { type: 'number', description: 'Only return restaurants rated at least this much (0 to 5).' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'check_availability',
    description: 'List the vacant tables at a restaurant for a date, start time and party size. A booking holds a table for 90 minutes. Times are in India Standard Time. If nothing is free, nearby start times that do have a table are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurant_id: { type: 'number', description: 'Restaurant id from search_restaurants.' },
        date: { type: 'string', description: 'Date as YYYY-MM-DD.' },
        time: { type: 'string', description: 'Start time in 24-hour HH:MM, between 12:00 and 22:00.' },
        party_size: { type: 'number', description: 'Number of guests.' },
      },
      required: ['restaurant_id', 'date', 'time', 'party_size'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'book_table',
    description: 'Book a table for the signed-in guest. Pass table_id to book the table the guest chose from check_availability; leave it out to get the smallest vacant table that fits. Confirm the restaurant, date, time and party size with the guest before calling. Returns a booking reference and a confirmation link the guest can open.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurant_id: { type: 'number', description: 'Restaurant id from search_restaurants.' },
        date: { type: 'string', description: 'Date as YYYY-MM-DD.' },
        time: { type: 'string', description: 'Start time in 24-hour HH:MM.' },
        party_size: { type: 'number', description: 'Number of guests.' },
        table_id: { type: 'number', description: 'Optional table_id from check_availability.' },
      },
      required: ['restaurant_id', 'date', 'time', 'party_size'],
    },
  },
  {
    name: 'list_my_bookings',
    description: "List the signed-in guest's upcoming confirmed bookings.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cancel_booking',
    description: "Cancel one of the signed-in guest's bookings by its booking reference (for example K7M2QX). The table becomes vacant again immediately.",
    inputSchema: {
      type: 'object',
      properties: { booking_ref: { type: 'string', description: 'Reference from book_table or list_my_bookings.' } },
      required: ['booking_ref'],
    },
    annotations: { destructiveHint: true },
  },
];

function runTool(name, a, guest, base) {
  switch (name) {
    case 'search_restaurants': {
      let rows = db.prepare('SELECT * FROM restaurants ORDER BY rating DESC, name').all();
      if (a.area) rows = rows.filter(r => r.area.toLowerCase().includes(String(a.area).toLowerCase()));
      if (a.cuisine) rows = rows.filter(r => r.cuisine.toLowerCase().includes(String(a.cuisine).toLowerCase()));
      if (a.min_rating !== undefined) rows = rows.filter(r => r.rating >= Number(a.min_rating));
      const n = nowIST();
      return { now_ist: `${n.date} ${fmtMin(n.min)}`, count: rows.length, restaurants: rows.map(r => ({ restaurant_id: r.id, name: r.name, area: r.area, cuisine: r.cuisine, rating: r.rating, address: r.address })) };
    }
    case 'check_availability': {
      const r = findRestaurant(a.restaurant_id);
      const s = parseSlot(a.date, a.time);
      const party = parseParty(a.party_size);
      const vacant = floorState(r.id, s.date, s.start, s.end).filter(t => t.state === 'vacant' && t.seats >= party)
        .sort((x, y) => x.seats - y.seats).map(t => ({ table_id: t.id, label: t.label, seats: t.seats }));
      const out = { restaurant: r.name, restaurant_id: r.id, date: s.date, window: `${fmtMin(s.start)} to ${fmtMin(s.end)}`, party_size: party, vacant_tables: vacant };
      if (!vacant.length) out.nearby_times_with_a_free_table = alternativeTimes(r.id, s.date, party, s.start);
      return out;
    }
    case 'book_table': {
      const b = book(guest, { ...a, source: 'claude' });
      return { booked: true, ...b, confirmation_url: `${base}/confirmation?ref=${b.ref}` };
    }
    case 'list_my_bookings': {
      const rows = db.prepare("SELECT ref FROM bookings WHERE guest_id=? AND status='confirmed' AND date>=? ORDER BY date, start_min").all(guest.id, nowIST().date);
      return { count: rows.length, bookings: rows.map(r => present(bookingRow(r.ref))) };
    }
    case 'cancel_booking': {
      const b = cancel(a.booking_ref, guest.id);
      return { cancelled: b.status === 'cancelled', booking: b };
    }
    default:
      throw new HttpError(404, `Unknown tool: ${name}`);
  }
}

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
function rpc(msg, guest, base) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (typeof method !== 'string') return err(-32600, 'Invalid request');
  if (isNotification) return null;
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'reserve', version: '1.0.0' },
        instructions: `Reserve books restaurant tables for ${guest.name}. Dates are YYYY-MM-DD and times are 24-hour India Standard Time. A booking holds a table for 90 minutes. Check availability before booking, confirm the details with the guest, and share the confirmation link after booking.`,
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return err(-32602, `Unknown tool: ${params.name}`);
      try {
        const out = runTool(params.name, params.arguments || {}, guest, base);
        return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(e);
        return ok({ content: [{ type: 'text', text: e instanceof HttpError ? e.message : 'Something went wrong. Try again.' }], isError: true });
      }
    }
    default: return err(-32601, `Method not found: ${method}`);
  }
}

app.options('/mcp', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id' });
  res.sendStatus(204);
});
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'This MCP endpoint accepts POST requests.' }));
app.post('/mcp', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const guest = guestByKey(req.query.key);
  if (!guest) return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or missing connect key. Copy your personal link from the Reserve sign-in page.' } });
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const body = req.body;
  if (Array.isArray(body)) {
    const out = body.map(m => rpc(m, guest, base)).filter(Boolean);
    return out.length ? res.json(out) : res.sendStatus(202);
  }
  const out = rpc(body, guest, base);
  return out ? res.json(out) : res.sendStatus(202);
});

/* ---------- static pages ---------- */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Reserve is running on port ${PORT}`));
}
module.exports = { app, nowIST, db };
