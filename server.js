const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let multer;
try {
  multer = require('multer');
} catch (error) {
  console.warn('Multer not installed, file upload disabled');
  multer = null;
}

const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3100);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const INDEX_FILE = path.join(__dirname, 'index.html');
const RESULTS_FILE = path.join(__dirname, 'results.html');
const STORAGE_DIR = path.join(__dirname, 'storage');
const DB_FILE = path.join(STORAGE_DIR, 'lab_system.sqlite');
const BOOTSTRAP_FILE = path.join(STORAGE_DIR, 'bootstrap-admin.txt');
const BACKUP_DIR = path.join(STORAGE_DIR, 'backups');
const BACKUP_KEEP_LIMIT = 25;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const LOGIN_MAX_ATTEMPTS = 8;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const DEFAULT_PUBLIC_SETTINGS = {
  headerTitle: 'نتائج التحاليل الطبية',
  headerLead: 'المنصة المعتمدة لعرض النتائج',
  footerText: 'النتائج الظاهرة هنا مرتبطة بالطلب المحفوظ في النظام.'
};
const DATA_FILE_CANDIDATES = Array.from(new Set([
  process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : null,
  path.join(__dirname, 'storage', 'lab_data.json'),
  path.join(__dirname, 'lab_data.json'),
  path.join(__dirname, 'api', 'data', 'lab_data.json')
].filter(Boolean)));
const ROLE_PERMISSIONS = {
  admin: { save: true, publish: true, delete: true, userManagement: true },
  lab: { save: true, publish: true, delete: true, userManagement: true },
  reception: { save: true, publish: false, delete: false, userManagement: false },
  doctor: { save: false, publish: false, delete: false, userManagement: false }
};
const loginAttemptStore = new Map();

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function stripUtf8Bom(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
}

ensureDirectory(STORAGE_DIR);
ensureDirectory(BACKUP_DIR);

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
});
app.use(cors());
app.options('/api/*', cors());
app.use(express.json({ limit: '2mb' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json({ message: 'Invalid JSON request body' });
  }
  return next(error);
});
app.use((req, res, next) => {
  if (/\.php$/i.test(req.path)) {
    return res.status(404).json({ message: 'Not found' });
  }
  return next();
});

let upload = null;
if (multer) {
  upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        ensureDirectory(uploadDir);
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
      }
    })
  });
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = stripUtf8Bom(fs.readFileSync(filePath, 'utf8'));
    if (!text.trim()) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function cleanupOldBackups() {
  try {
    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .map(name => path.join(BACKUP_DIR, name))
      .filter(file => fs.statSync(file).isFile())
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

    backupFiles.slice(BACKUP_KEEP_LIMIT).forEach(file => {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        console.warn('Failed to remove old backup:', error.message);
      }
    });
  } catch (error) {
    console.warn('Failed to cleanup backups:', error.message);
  }
}

function createJsonBackup(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const text = stripUtf8Bom(fs.readFileSync(filePath, 'utf8'));
    if (!text.trim()) return;
    const safeBaseName = path.basename(filePath).replace(/[^\w.-]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `${safeBaseName}.${stamp}.bak.json`);
    fs.writeFileSync(backupPath, text, 'utf8');
    cleanupOldBackups();
  } catch (error) {
    console.warn('Failed to create backup copy:', error.message);
  }
}

function randomHex(size = 24) {
  return crypto.randomBytes(size).toString('hex');
}

function getClientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function cleanupLoginAttempts(now = Date.now()) {
  for (const [key, entry] of loginAttemptStore.entries()) {
    if (!entry || entry.resetAt <= now) {
      loginAttemptStore.delete(key);
    }
  }
}

function getLoginAttemptState(key) {
  cleanupLoginAttempts();
  const existing = loginAttemptStore.get(key);
  if (existing && existing.resetAt > Date.now()) {
    return existing;
  }

  const next = { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
  loginAttemptStore.set(key, next);
  return next;
}

function registerLoginFailure(key) {
  const state = getLoginAttemptState(key);
  state.count += 1;
  loginAttemptStore.set(key, state);
  return state;
}

function clearLoginFailures(key) {
  loginAttemptStore.delete(key);
}

function hashPassword(password, salt = randomHex(16)) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const derived = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

function generateShareToken() {
  return `res_${Date.now().toString(36)}_${randomHex(4)}`;
}

function getPatientIdKey(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function getOrderPatientId(order) {
  if (!order || typeof order !== 'object') return '';
  if (order.patient && Object.prototype.hasOwnProperty.call(order.patient, 'id')) {
    return order.patient.id;
  }
  return order.patient_id;
}

function normalizeOrder(order = {}) {
  const patient = order && typeof order.patient === 'object' && order.patient !== null ? order.patient : {};
  const patientId = getPatientIdKey(getOrderPatientId(order));
  const now = new Date().toISOString();
  const shareToken = order.share_token || patient.share_token || generateShareToken();
  const resultsPublished = !!(order.results_published ?? patient.results_published ?? false);
  const publishedAt = order.published_at ?? patient.published_at ?? null;
  const createdAt = order.created_at || order.date || now;
  const updatedAt = order.updated_at || order.date || createdAt;

  return {
    ...order,
    patient_id: patientId,
    patient: {
      ...patient,
      id: patientId,
      share_token: shareToken,
      results_published: resultsPublished,
      published_at: publishedAt
    },
    order: Array.isArray(order.order) ? order.order : [],
    settings: {
      ...DEFAULT_PUBLIC_SETTINGS,
      ...(order.settings || {})
    },
    created_at: createdAt,
    updated_at: updatedAt,
    share_token: shareToken,
    results_published: resultsPublished,
    published_at: publishedAt
  };
}

function readBootstrapCredentials() {
  if (!fs.existsSync(BOOTSTRAP_FILE)) return null;
  const text = stripUtf8Bom(fs.readFileSync(BOOTSTRAP_FILE, 'utf8'));
  const usernameMatch = text.match(/^username=(.*)$/m);
  const passwordMatch = text.match(/^password=(.*)$/m);
  const username = usernameMatch ? usernameMatch[1].trim() : '';
  const password = passwordMatch ? passwordMatch[1].trim() : '';
  return username && password ? { username, password } : null;
}

function writeBootstrapCredentials(username, password) {
  fs.writeFileSync(
    BOOTSTRAP_FILE,
    [
      'Initial bootstrap administrator credentials',
      `username=${username}`,
      `password=${password}`,
      'Delete or secure this file after the first login.'
    ].join('\n'),
    'utf8'
  );
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS orders (
    patient_id TEXT PRIMARY KEY,
    patient_name TEXT,
    physician TEXT,
    unit TEXT,
    search_text TEXT NOT NULL DEFAULT '',
    share_token TEXT NOT NULL UNIQUE,
    results_published INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    patient_json TEXT NOT NULL,
    order_json TEXT NOT NULL,
    settings_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function getTableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name);
}

function ensureColumn(tableName, columnName, definition) {
  const columns = new Set(getTableColumns(tableName));
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn('orders', 'patient_name', 'TEXT');
ensureColumn('orders', 'physician', 'TEXT');
ensureColumn('orders', 'unit', 'TEXT');
ensureColumn('orders', 'search_text', `TEXT NOT NULL DEFAULT ''`);
ensureColumn('orders', 'share_token', `TEXT NOT NULL DEFAULT 'legacy_${Date.now().toString(36)}'`);
ensureColumn('orders', 'results_published', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'published_at', 'TEXT');
ensureColumn('orders', 'created_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');
ensureColumn('orders', 'updated_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');
ensureColumn('orders', 'patient_json', `TEXT NOT NULL DEFAULT '{}'`);
ensureColumn('orders', 'order_json', `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn('orders', 'settings_json', `TEXT NOT NULL DEFAULT '{}'`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_patient_name ON orders (patient_name);
  CREATE INDEX IF NOT EXISTS idx_orders_physician ON orders (physician);
  CREATE INDEX IF NOT EXISTS idx_orders_results_published ON orders (results_published);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
`);

const statements = {
  countUsers: db.prepare('SELECT COUNT(*) AS total FROM users'),
  listUsers: db.prepare('SELECT id, username, display_name, role, active, created_at, updated_at FROM users ORDER BY created_at ASC'),
  countActiveAdmins: db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1"),
  insertUser: db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, active, created_at, updated_at)
    VALUES (@username, @display_name, @password_hash, @role, @active, @created_at, @updated_at)
  `),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ? LIMIT 1'),
  updateUserCredentials: db.prepare(`
    UPDATE users
    SET display_name = @display_name,
        password_hash = @password_hash,
        role = @role,
        active = @active,
        updated_at = @updated_at
    WHERE username = @username
  `),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (@token, @user_id, @created_at, @expires_at)'),
  getSessionWithUser: db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.role, u.active
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
    LIMIT 1
  `),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  deleteSessionsByUserId: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  listSystemState: db.prepare('SELECT key, value_json, updated_at FROM system_state ORDER BY key ASC'),
  getSystemStateEntry: db.prepare('SELECT key, value_json, updated_at FROM system_state WHERE key = ? LIMIT 1'),
  upsertSystemState: db.prepare(`
    INSERT INTO system_state (key, value_json, updated_at)
    VALUES (@key, @value_json, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `),
  countOrders: db.prepare('SELECT COUNT(*) AS total FROM orders'),
  orderStats: db.prepare(`
    SELECT
      COUNT(*) AS totalOrders,
      COALESCE(SUM(json_array_length(order_json)), 0) AS totalTests,
      COALESCE(SUM(CASE WHEN results_published = 1 THEN 1 ELSE 0 END), 0) AS completedOrders,
      COALESCE(SUM(CASE WHEN results_published = 0 THEN 1 ELSE 0 END), 0) AS pendingOrders
    FROM orders
  `),
  getOrderByPatientId: db.prepare('SELECT * FROM orders WHERE patient_id = ? LIMIT 1'),
  getOrderByShareToken: db.prepare('SELECT * FROM orders WHERE share_token = ? LIMIT 1'),
  deleteUserByUsername: db.prepare('DELETE FROM users WHERE username = ?'),
  deleteAllOrders: db.prepare('DELETE FROM orders'),
  deleteOrder: db.prepare('DELETE FROM orders WHERE patient_id = ?'),
  upsertOrder: db.prepare(`
    INSERT INTO orders (
      patient_id, patient_name, physician, unit, search_text, share_token, results_published, published_at,
      created_at, updated_at, patient_json, order_json, settings_json
    ) VALUES (
      @patient_id, @patient_name, @physician, @unit, @search_text, @share_token, @results_published, @published_at,
      @created_at, @updated_at, @patient_json, @order_json, @settings_json
    )
    ON CONFLICT(patient_id) DO UPDATE SET
      patient_name = excluded.patient_name,
      physician = excluded.physician,
      unit = excluded.unit,
      search_text = excluded.search_text,
      share_token = excluded.share_token,
      results_published = excluded.results_published,
      published_at = excluded.published_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      patient_json = excluded.patient_json,
      order_json = excluded.order_json,
      settings_json = excluded.settings_json
  `)
};

function serializeOrder(normalizedOrder) {
  const searchText = [
    normalizedOrder.patient_id,
    normalizedOrder.patient?.name || '',
    normalizedOrder.patient?.physician || '',
    normalizedOrder.patient?.unit || ''
  ].join(' ').trim();

  return {
    patient_id: normalizedOrder.patient_id,
    patient_name: normalizedOrder.patient?.name || '',
    physician: normalizedOrder.patient?.physician || '',
    unit: normalizedOrder.patient?.unit || '',
    search_text: searchText,
    share_token: normalizedOrder.share_token,
    results_published: normalizedOrder.results_published ? 1 : 0,
    published_at: normalizedOrder.published_at,
    created_at: normalizedOrder.created_at,
    updated_at: normalizedOrder.updated_at,
    patient_json: JSON.stringify(normalizedOrder.patient || {}),
    order_json: JSON.stringify(normalizedOrder.order || []),
    settings_json: JSON.stringify(normalizedOrder.settings || DEFAULT_PUBLIC_SETTINGS)
  };
}

function parseJsonColumn(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function rowToOrder(row) {
  if (!row) return null;
  return normalizeOrder({
    patient_id: row.patient_id,
    patient: parseJsonColumn(row.patient_json, {}),
    order: parseJsonColumn(row.order_json, []),
    settings: parseJsonColumn(row.settings_json, DEFAULT_PUBLIC_SETTINGS),
    created_at: row.created_at,
    updated_at: row.updated_at,
    share_token: row.share_token,
    results_published: !!row.results_published,
    published_at: row.published_at
  });
}

function ensureBootstrapAdmin() {
  const fileCredentials = readBootstrapCredentials();
  const username = process.env.ADMIN_USERNAME || fileCredentials?.username || 'admin';
  const password = process.env.ADMIN_PASSWORD || fileCredentials?.password || randomHex(12);
  const now = new Date().toISOString();

  if (statements.countUsers.get().total === 0) {
    statements.insertUser.run({
      username,
      display_name: 'مدير النظام',
      password_hash: hashPassword(password),
      role: 'admin',
      active: 1,
      created_at: now,
      updated_at: now
    });

    writeBootstrapCredentials(username, password);
    return;
  }

  if (fileCredentials && username === fileCredentials.username) {
    const existingAdmin = statements.getUserByUsername.get(username);
    if (existingAdmin) {
      statements.updateUserCredentials.run({
        username,
        display_name: existingAdmin.display_name || 'مدير النظام',
        password_hash: hashPassword(password),
        role: existingAdmin.role || 'admin',
        active: 1,
        updated_at: now
      });
    }
  }
}

function migrateLegacyJsonData() {
  if (statements.countOrders.get().total > 0) return;

  for (const candidate of DATA_FILE_CANDIDATES) {
    const parsed = readJsonFile(candidate);
    if (!Array.isArray(parsed) || parsed.length === 0) continue;

    createJsonBackup(candidate);
    const transaction = db.transaction(rows => {
      rows.forEach(row => {
        const normalized = normalizeOrder(row);
        statements.upsertOrder.run(serializeOrder(normalized));
      });
    });
    transaction(parsed);
    return;
  }
}

ensureBootstrapAdmin();
migrateLegacyJsonData();

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateRole(role) {
  return ['admin', 'lab', 'doctor', 'reception'].includes(role) ? role : null;
}

function canDisableLastAdmin(nextRole, nextActive, existingUser = null) {
  const activeAdminCount = statements.countActiveAdmins.get().total;
  const wasActiveAdmin = existingUser && existingUser.role === 'admin' && !!existingUser.active;
  const willRemainActiveAdmin = nextRole === 'admin' && !!nextActive;
  return wasActiveAdmin && !willRemainActiveAdmin && activeAdminCount <= 1;
}

function cleanupSessions() {
  statements.deleteExpiredSessions.run(new Date().toISOString());
}

function createSession(userId) {
  cleanupSessions();
  const now = new Date();
  const token = randomHex(32);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  statements.insertSession.run({ token, user_id: userId, created_at: createdAt, expires_at: expiresAt });
  return { token, expiresAt };
}

function getAuthToken(req) {
  const header = String(req.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireAuth(req, res, next) {
  cleanupSessions();
  const token = getAuthToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const sessionRow = statements.getSessionWithUser.get(token);
  if (!sessionRow || !sessionRow.active) {
    return res.status(401).json({ message: 'Invalid or expired session' });
  }

  if (new Date(sessionRow.expires_at).getTime() <= Date.now()) {
    statements.deleteSession.run(token);
    return res.status(401).json({ message: 'Session expired' });
  }

  req.authToken = token;
  req.user = mapUser(sessionRow);
  return next();
}

function requirePermission(permissionKey) {
  return (req, res, next) => {
    const permissions = ROLE_PERMISSIONS[req.user?.role] || ROLE_PERMISSIONS.doctor;
    if (!permissions[permissionKey]) {
      return res.status(403).json({ message: 'Permission denied' });
    }
    return next();
  };
}

function parsePositiveInteger(value, fallback, maxValue = Number.MAX_SAFE_INTEGER) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, maxValue);
}

function escapeSqlLike(value) {
  return String(value).replace(/[\\%_]/g, match => `\\${match}`);
}

function startOfDayIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function endOfDayIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

function buildOrderFilters(query = {}) {
  const where = [];
  const params = {};
  const search = String(query.search || '').trim();
  const fromIso = startOfDayIso(query.from);
  const toIso = endOfDayIso(query.to);
  const published = String(query.published || '').trim().toLowerCase();

  if (search) {
    params.search = `%${escapeSqlLike(search)}%`;
    where.push(`(
      patient_id LIKE @search ESCAPE '\\' OR
      patient_name LIKE @search ESCAPE '\\' COLLATE NOCASE OR
      physician LIKE @search ESCAPE '\\' COLLATE NOCASE
    )`);
  }

  if (fromIso) {
    params.from = fromIso;
    where.push('updated_at >= @from');
  }

  if (toIso) {
    params.to = toIso;
    where.push('updated_at <= @to');
  }

  if (published === 'true' || published === 'false') {
    params.published = published === 'true' ? 1 : 0;
    where.push('results_published = @published');
  }

  return {
    clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

function listOrders(query = {}) {
  const page = parsePositiveInteger(query.page, 1);
  const pageSize = parsePositiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const filters = buildOrderFilters(query);
  const total = db.prepare(`SELECT COUNT(*) AS total FROM orders ${filters.clause}`).get(filters.params).total;
  const rows = db.prepare(`
    SELECT * FROM orders
    ${filters.clause}
    ORDER BY datetime(updated_at) DESC, patient_id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...filters.params, limit: pageSize, offset });

  return {
    items: rows.map(rowToOrder),
    meta: {
      page,
      pageSize,
      totalItems: total,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    }
  };
}

function findOrderByPatientId(patientId) {
  return rowToOrder(statements.getOrderByPatientId.get(getPatientIdKey(patientId)));
}

function findOrderByShareToken(shareToken) {
  return rowToOrder(statements.getOrderByShareToken.get(String(shareToken || '').trim()));
}

function saveOrder(order) {
  const normalized = normalizeOrder(order);
  statements.upsertOrder.run(serializeOrder(normalized));
  return normalized;
}

function parseSystemStateRows(rows = []) {
  return rows.reduce((accumulator, row) => {
    try {
      accumulator[row.key] = JSON.parse(row.value_json);
    } catch (error) {
      accumulator[row.key] = null;
    }
    return accumulator;
  }, {});
}

function getSystemStateSnapshot() {
  return parseSystemStateRows(statements.listSystemState.all());
}

function saveSystemStatePatch(patch = {}) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return getSystemStateSnapshot();

  const now = new Date().toISOString();
  const transaction = db.transaction(items => {
    items.forEach(([key, value]) => {
      statements.upsertSystemState.run({
        key,
        value_json: JSON.stringify(value ?? null),
        updated_at: now
      });
    });
  });
  transaction(entries);
  return getSystemStateSnapshot();
}

function exportSystemBackup() {
  const orders = db.prepare('SELECT * FROM orders ORDER BY datetime(updated_at) DESC, patient_id DESC').all().map(rowToOrder);
  const users = statements.listUsers.all().map(mapUser);
  const stats = statements.orderStats.get();
  const state = getSystemStateSnapshot();
  return {
    version: '2026.04.server',
    exportedAt: new Date().toISOString(),
    counts: {
      orders: stats.totalOrders,
      tests: stats.totalTests,
      completed: stats.completedOrders,
      pending: stats.pendingOrders,
      users: users.length
    },
    state,
    users,
    orders
  };
}

const restoreOrdersTransaction = db.transaction(orders => {
  statements.deleteAllOrders.run();
  orders.forEach(order => {
    const normalized = normalizeOrder(order);
    statements.upsertOrder.run(serializeOrder(normalized));
  });
});

const restoreSystemStateTransaction = db.transaction(state => {
  if (!state || typeof state !== 'object') return;
  Object.entries(state).forEach(([key, value]) => {
    statements.upsertSystemState.run({
      key,
      value_json: JSON.stringify(value ?? null),
      updated_at: new Date().toISOString()
    });
  });
});

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(INDEX_FILE);
});

app.get('/results.html', (req, res) => {
  res.sendFile(RESULTS_FILE);
});

app.get('/results/:token', (req, res) => {
  res.sendFile(RESULTS_FILE);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    db: 'sqlite',
    connected: true,
    bootstrapFileExists: fs.existsSync(BOOTSTRAP_FILE)
  });
});

app.get('/api/config', (req, res) => {
  const fallbackBaseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    publicBaseUrl: PUBLIC_BASE_URL || fallbackBaseUrl,
    port: PORT,
    host: HOST,
    centerName: process.env.CENTER_NAME || 'مختبر التحاليل الطبية',
    storage: 'sqlite'
  });
});

app.post('/api/auth/login', (req, res) => {
  const clientKey = getClientKey(req);
  const attemptState = getLoginAttemptState(clientKey);
  if (attemptState.count >= LOGIN_MAX_ATTEMPTS && attemptState.resetAt > Date.now()) {
    return res.status(429).json({ message: 'Too many login attempts. Try again later.' });
  }

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const userRow = statements.getUserByUsername.get(username);
  if (!userRow || !userRow.active || !verifyPassword(password, userRow.password_hash)) {
    registerLoginFailure(clientKey);
    return res.status(401).json({ message: 'Invalid username or password' });
  }

  clearLoginFailures(clientKey);
  const session = createSession(userRow.id);
  res.json({ token: session.token, expiresAt: session.expiresAt, user: mapUser(userRow) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  statements.deleteSession.run(req.authToken);
  res.json({ loggedOut: true });
});

app.get('/api/users', requireAuth, requirePermission('userManagement'), (req, res) => {
  res.json({ items: statements.listUsers.all().map(mapUser) });
});

app.get('/api/stats', requireAuth, (req, res) => {
  const stats = statements.orderStats.get();
  res.json({
    totalCases: stats.totalOrders,
    totalTests: stats.totalTests,
    completedCases: stats.completedOrders,
    pendingCases: stats.pendingOrders,
    users: statements.countUsers.get().total
  });
});

app.get('/api/system/backup', requireAuth, requirePermission('userManagement'), (req, res) => {
  res.json(exportSystemBackup());
});

app.get('/api/system/state', requireAuth, (req, res) => {
  res.json({ state: getSystemStateSnapshot() });
});

app.put('/api/system/state', requireAuth, requirePermission('userManagement'), (req, res) => {
  const statePatch = req.body && typeof req.body === 'object' ? req.body : null;
  if (!statePatch) {
    return res.status(400).json({ message: 'State payload is required' });
  }

  const snapshot = saveSystemStatePatch(statePatch);
  res.json({ saved: true, state: snapshot });
});

app.post('/api/system/restore', requireAuth, requirePermission('delete'), (req, res) => {
  const orders = Array.isArray(req.body?.orders) ? req.body.orders : null;
  if (!orders) {
    return res.status(400).json({ message: 'orders array is required for restore' });
  }

  restoreOrdersTransaction(orders);
  if (req.body?.state && typeof req.body.state === 'object') {
    restoreSystemStateTransaction(req.body.state);
  }
  res.json({ restored: true, count: orders.length });
});

app.post('/api/users', requireAuth, requirePermission('userManagement'), (req, res) => {
  const displayName = String(req.body?.displayName || '').trim();
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const role = validateRole(String(req.body?.role || '').trim());
  const active = req.body?.active !== false;
  const editingUsername = String(req.body?.editingUsername || '').trim();

  if (displayName.length < 2) {
    return res.status(400).json({ message: 'اسم العرض يجب أن يكون حرفين على الأقل.' });
  }
  if (username.length < 3 || /\s/.test(username)) {
    return res.status(400).json({ message: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل وبدون مسافات.' });
  }
  if (!role) {
    return res.status(400).json({ message: 'الدور غير صالح.' });
  }

  const existingUser = editingUsername ? statements.getUserByUsername.get(editingUsername) : null;
  const duplicateUser = statements.getUserByUsername.get(username);
  if (duplicateUser && (!existingUser || duplicateUser.username !== existingUser.username)) {
    return res.status(409).json({ message: 'اسم المستخدم مستخدم بالفعل.' });
  }

  if (!existingUser && password.length < 4) {
    return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل.' });
  }

  if (existingUser && canDisableLastAdmin(role, active, existingUser)) {
    return res.status(400).json({ message: 'لا يمكن تعطيل أو تغيير آخر مدير نشط في النظام.' });
  }

  const now = new Date().toISOString();
  if (!existingUser) {
    statements.insertUser.run({
      username,
      display_name: displayName,
      password_hash: hashPassword(password),
      role,
      active: active ? 1 : 0,
      created_at: now,
      updated_at: now
    });
    return res.json({ saved: true, created: true, user: mapUser(statements.getUserByUsername.get(username)) });
  }

  statements.updateUserCredentials.run({
    username: existingUser.username,
    display_name: displayName,
    password_hash: password ? hashPassword(password) : existingUser.password_hash,
    role,
    active: active ? 1 : 0,
    updated_at: now
  });

  if (username !== existingUser.username) {
    db.prepare('UPDATE users SET username = ? WHERE username = ?').run(username, existingUser.username);
  }

  return res.json({ saved: true, created: false, user: mapUser(statements.getUserByUsername.get(username)) });
});

app.delete('/api/users/:username', requireAuth, requirePermission('userManagement'), (req, res) => {
  const username = String(req.params.username || '').trim();
  const existingUser = statements.getUserByUsername.get(username);
  if (!existingUser) {
    return res.status(404).json({ message: 'المستخدم غير موجود.' });
  }

  if (canDisableLastAdmin('doctor', false, existingUser)) {
    return res.status(400).json({ message: 'لا يمكن حذف آخر مدير نشط في النظام.' });
  }

  statements.deleteSessionsByUserId.run(existingUser.id);
  statements.deleteUserByUsername.run(username);
  res.json({ deleted: true });
});

app.get('/api/orders', requireAuth, (req, res) => {
  res.json(listOrders(req.query));
});

app.get('/api/orders/:patientId', requireAuth, (req, res) => {
  const row = findOrderByPatientId(req.params.patientId);
  if (!row) return res.status(404).json({ message: 'غير موجود' });
  res.json(row);
});

app.get('/api/public-results/:token', (req, res) => {
  const row = findOrderByShareToken(req.params.token);
  if (!row) return res.status(404).json({ message: 'Result link not found' });
  if (!row.results_published) {
    return res.status(423).json({
      message: 'Results are not published yet',
      published: false,
      settings: row.settings || {}
    });
  }

  res.json({
    patient_id: row.patient_id,
    patient: row.patient,
    order: row.order || [],
    settings: row.settings || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    share_token: row.share_token,
    results_published: row.results_published,
    published_at: row.published_at
  });
});

app.post('/api/orders', requireAuth, requirePermission('save'), (req, res) => {
  const { patient, order, settings } = req.body || {};
  const patientId = getPatientIdKey(patient?.id);
  if (!patientId) return res.status(400).json({ error: 'patient.id مطلوب' });

  const now = new Date().toISOString();
  const existingEntry = findOrderByPatientId(patientId);
  const saved = saveOrder({
    patient_id: patientId,
    patient: {
      ...(patient || {}),
      results_published: existingEntry?.results_published || false,
      published_at: existingEntry?.published_at || null
    },
    order: Array.isArray(order) ? order : [],
    settings: settings || existingEntry?.settings || {},
    created_at: existingEntry?.created_at || now,
    updated_at: now,
    share_token: existingEntry?.share_token || patient?.share_token || generateShareToken(),
    results_published: existingEntry?.results_published || false,
    published_at: existingEntry?.published_at || null
  });

  res.json({
    saved: true,
    patientId: saved.patient_id,
    date: saved.updated_at,
    shareToken: saved.share_token,
    resultsPublished: saved.results_published,
    publishedAt: saved.published_at
  });
});

app.post('/api/orders/:patientId/publish', requireAuth, requirePermission('publish'), (req, res) => {
  const existing = findOrderByPatientId(req.params.patientId);
  if (!existing) return res.status(404).json({ message: 'Order not found' });

  const publishedAt = new Date().toISOString();
  const saved = saveOrder({
    ...existing,
    patient: {
      ...(existing.patient || {}),
      results_published: true,
      published_at: publishedAt
    },
    updated_at: publishedAt,
    results_published: true,
    published_at: publishedAt
  });

  res.json({ published: true, patientId: saved.patient_id, publishedAt: saved.published_at, shareToken: saved.share_token });
});

app.post('/api/orders/:patientId/unpublish', requireAuth, requirePermission('publish'), (req, res) => {
  const existing = findOrderByPatientId(req.params.patientId);
  if (!existing) return res.status(404).json({ message: 'Order not found' });

  const updatedAt = new Date().toISOString();
  const saved = saveOrder({
    ...existing,
    patient: {
      ...(existing.patient || {}),
      results_published: false,
      published_at: null
    },
    updated_at: updatedAt,
    results_published: false,
    published_at: null
  });

  res.json({ published: false, patientId: saved.patient_id, shareToken: saved.share_token });
});

app.delete('/api/orders/:patientId', requireAuth, requirePermission('delete'), (req, res) => {
  const result = statements.deleteOrder.run(getPatientIdKey(req.params.patientId));
  if (!result.changes) {
    return res.status(404).json({ message: 'فات الطلب' });
  }
  res.json({ deleted: true });
});

if (upload) {
  app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }

    res.json({
      message: 'تم رفع الملف بنجاح',
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    });
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_FILE}`);
  if (fs.existsSync(BOOTSTRAP_FILE)) {
    console.log(`Bootstrap admin credentials file: ${BOOTSTRAP_FILE}`);
  }
  if (PUBLIC_BASE_URL) {
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server process or set PORT to a different value before starting this app.`);
  } else if (error.code === 'EACCES') {
    console.error(`Port ${PORT} requires elevated permissions or is blocked on this machine.`);
  } else {
    console.error('Server failed to start:', error.message);
  }

  process.exit(1);
});
