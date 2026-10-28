'use strict';

/*
 * Kennies — self-contained site server.
 *
 * Serves the static site in ./site plus a small JSON API for accounts and
 * reservations. Everything lives in this process and a JSON file, so the app
 * no longer depends on any hosting platform's identity or function services.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(__dirname, '..', 'site'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_COOKIE = 'kennies_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;
const RESET_TTL = 1000 * 60 * 60;
const STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled'];

/* ---------- Storage ---------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDb() {
  return { users: [], reservations: [], sessions: {}, resets: {}, nextReservationId: 1 };
}

function loadDb() {
  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return emptyDb();
  }
}

let db = loadDb();

function saveDb() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- Helpers ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: user.roles,
    userMetadata: { full_name: user.name },
    appMetadata: { roles: user.roles },
    createdAt: user.createdAt,
    lastSignInAt: user.lastSignInAt || null,
  };
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = db.sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete db.sessions[token];
    saveDb();
    return null;
  }
  return db.users.find(user => user.id === session.userId) || null;
}

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId: user.id, expiresAt: Date.now() + SESSION_TTL };
  for (const [key, session] of Object.entries(db.sessions)) {
    if (session.expiresAt < Date.now()) delete db.sessions[key];
  }
  user.lastSignInAt = new Date().toISOString();
  saveDb();
  res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(SESSION_TTL / 1000)));
}

function endSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token && db.sessions[token]) {
    delete db.sessions[token];
    saveDb();
  }
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}

function roleOf(user) {
  if (!user) return 'customer';
  if (user.roles.includes('admin')) return 'admin';
  if (user.roles.includes('manager')) return 'manager';
  return 'customer';
}

function isStaff(user) {
  return ['manager', 'admin'].includes(roleOf(user));
}

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'KN-';
  for (let i = 0; i < 6; i += 1) {
    ref += alphabet[crypto.randomInt(alphabet.length)];
  }
  return ref;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, pathname) {
  const clean = decodeURIComponent(pathname);
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const file = path.resolve(SITE_DIR, relative);
  if (!file.startsWith(SITE_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------- API ---------- */

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    json(res, 401, { error: 'Please log in to continue.' });
    return null;
  }
  return user;
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = segments.slice(1);
  const method = req.method;

  /* ----- accounts ----- */

  if (route[0] === 'auth') {
    const action = route[1];

    if (action === 'signup' && method === 'POST') {
      const body = await readBody(req);
      const email = normaliseEmail(body.email);
      const password = String(body.password || '');
      const name = String(body.full_name || '').trim();
      if (!validEmail(email)) return json(res, 422, { error: 'Enter a valid email address.' });
      if (password.length < 6) return json(res, 422, { error: 'Use a password of at least 6 characters.' });
      if (db.users.some(user => user.email === email)) {
        return json(res, 422, { error: 'That email already has an account.' });
      }
      const user = {
        id: crypto.randomUUID(),
        email,
        name: name || email.split('@')[0],
        roles: ['customer'],
        password: hashPassword(password),
        createdAt: new Date().toISOString(),
        lastSignInAt: null,
      };
      db.users.push(user);
      saveDb();
      startSession(req, res, user);
      return json(res, 201, { user: publicUser(user) });
    }

    if (action === 'login' && method === 'POST') {
      const body = await readBody(req);
      const email = normaliseEmail(body.email);
      const password = String(body.password || '');
      const user = db.users.find(candidate => candidate.email === email);
      if (!user || !verifyPassword(password, user.password)) {
        return json(res, 401, { error: 'Invalid email or password.' });
      }
      startSession(req, res, user);
      return json(res, 200, { user: publicUser(user) });
    }

    if (action === 'logout' && method === 'POST') {
      endSession(req, res);
      return json(res, 200, { ok: true });
    }

    if (action === 'me' && method === 'GET') {
      return json(res, 200, { user: publicUser(currentUser(req)) });
    }

    if (action === 'password' && method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return undefined;
      const body = await readBody(req);
      const password = String(body.password || '');
      if (password.length < 6) return json(res, 422, { error: 'Use a password of at least 6 characters.' });
      user.password = hashPassword(password);
      saveDb();
      return json(res, 200, { user: publicUser(user) });
    }

    if (action === 'forgot' && method === 'POST') {
      const body = await readBody(req);
      const email = normaliseEmail(body.email);
      const user = db.users.find(candidate => candidate.email === email);
      if (user) {
        const token = crypto.randomBytes(24).toString('hex');
        db.resets[token] = { userId: user.id, expiresAt: Date.now() + RESET_TTL };
        for (const [key, entry] of Object.entries(db.resets)) {
          if (entry.expiresAt < Date.now()) delete db.resets[key];
        }
        saveDb();
        // No mail provider is configured: the reset link is written to the server log
        // so staff can hand it to the customer.
        console.log(`[password-reset] ${email}: /?recovery_token=${token}`);
      }
      return json(res, 200, { ok: true });
    }

    if (action === 'verify' && method === 'POST') {
      const body = await readBody(req);
      const token = String(body.token || '');
      const entry = db.resets[token];
      if (!entry || entry.expiresAt < Date.now()) {
        return json(res, 401, { error: 'That reset link has expired. Please request a new one.' });
      }
      const user = db.users.find(candidate => candidate.id === entry.userId);
      if (!user) return json(res, 401, { error: 'That reset link is no longer valid.' });
      delete db.resets[token];
      startSession(req, res, user);
      return json(res, 200, { user: publicUser(user) });
    }

    return json(res, 404, { error: 'Unknown account action.' });
  }

  /* ----- reservations ----- */

  if (route[0] === 'reservations') {
    const user = requireUser(req, res);
    if (!user) return undefined;
    const id = route[1] ? Number(route[1]) : null;

    if (!id && method === 'GET') {
      const rows = isStaff(user)
        ? db.reservations.slice()
        : db.reservations.filter(row => row.userId === user.id);
      rows.sort((a, b) => b.id - a.id);
      return json(res, 200, rows);
    }

    if (!id && method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items)
        ? body.items.slice(0, 100).map(item => ({
            name: String(item.name || '').slice(0, 120),
            price: Number(item.price) || 0,
            qty: Math.max(1, Math.min(99, Number(item.qty) || 1)),
          }))
        : [];
      const reservation = {
        id: db.nextReservationId,
        userId: user.id,
        ref: makeRef(),
        name: String(body.name || user.name).slice(0, 120),
        email: normaliseEmail(body.email || user.email),
        date: String(body.date || '').slice(0, 20),
        time: String(body.time || '').slice(0, 20),
        guests: String(body.guests || '').slice(0, 20),
        seating: String(body.seating || body.seat || '').slice(0, 40),
        note: String(body.note || '').slice(0, 500),
        paymentMethod: String(body.paymentMethod || '').slice(0, 40),
        items,
        total: items.reduce((sum, item) => sum + item.price * item.qty, 0),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      if (!reservation.date) return json(res, 400, { error: 'Please choose a date for your booking.' });
      db.nextReservationId += 1;
      db.reservations.push(reservation);
      saveDb();
      return json(res, 201, reservation);
    }

    const reservation = db.reservations.find(row => row.id === id);
    if (!reservation) return json(res, 404, { error: 'Booking not found.' });

    if (method === 'PATCH') {
      const body = await readBody(req);
      const status = String(body.status || '');
      if (!STATUSES.includes(status)) return json(res, 400, { error: 'Unknown booking status.' });
      const owns = reservation.userId === user.id;
      if (!isStaff(user) && !(owns && status === 'cancelled')) {
        return json(res, 403, { error: "You can't change this booking." });
      }
      reservation.status = status;
      saveDb();
      return json(res, 200, reservation);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  }

  /* ----- users (admin) ----- */

  if (route[0] === 'users') {
    const user = requireUser(req, res);
    if (!user) return undefined;
    if (roleOf(user) !== 'admin') return json(res, 403, { error: 'Admins only.' });

    if (method === 'GET' && !route[1]) {
      return json(res, 200, db.users.map(publicUser));
    }

    if (method === 'PATCH' && route[1]) {
      const target = db.users.find(candidate => candidate.id === route[1]);
      if (!target) return json(res, 404, { error: 'User not found.' });
      if (target.id === user.id) return json(res, 403, { error: "You can't change your own role." });
      const body = await readBody(req);
      const role = String(body.role || '');
      if (!['customer', 'manager', 'admin'].includes(role)) {
        return json(res, 400, { error: 'Unknown role.' });
      }
      target.roles = [role];
      saveDb();
      return json(res, 200, publicUser(target));
    }

    return json(res, 405, { error: 'Method not allowed.' });
  }

  return json(res, 404, { error: 'Not found.' });
}

/* ---------- Bootstrap ---------- */

function seedAdmin() {
  const email = normaliseEmail(process.env.ADMIN_EMAIL || 'admin@kennies.local');
  const password = String(process.env.ADMIN_PASSWORD || 'kennies123');
  if (!db.users.some(user => user.roles.includes('admin')) && !db.users.some(user => user.email === email)) {
    db.users.push({
      id: crypto.randomUUID(),
      email,
      name: 'Kennies Admin',
      roles: ['admin'],
      password: hashPassword(password),
      createdAt: new Date().toISOString(),
      lastSignInAt: null,
    });
    saveDb();
    console.log(`[seed] admin account ready: ${email}`);
  }
}

seedAdmin();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const work = url.pathname.startsWith('/api/')
    ? handleApi(req, res, url)
    : Promise.resolve(serveStatic(res, url.pathname));

  work.catch(err => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    json(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Kennies listening on http://${HOST}:${PORT} (site: ${SITE_DIR})`);
});
