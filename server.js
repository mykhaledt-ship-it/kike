const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

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
const CENTER_NAME = (process.env.CENTER_NAME || 'مختبر التحاليل الطبية').trim();
const STORAGE_DIR = path.join(__dirname, 'storage');
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(STORAGE_DIR, 'lab_system.sqlite');
const INDEX_FILE = path.join(__dirname, 'index.html');
const RESULTS_FILE = path.join(__dirname, 'results.html');
const BACKUP_DIR = path.join(STORAGE_DIR, 'backups');
const BACKUP_KEEP_LIMIT = 25;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const LOGIN_WINDOW_MS = 1000 * 60 * 10;
const LOGIN_MAX_ATTEMPTS = 10;
const BOOTSTRAP_ADMIN_FILE = path.join(STORAGE_DIR, 'bootstrap-admin.txt');
const LEGACY_DATA_FILE_CANDIDATES = Array.from(new Set([
  process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : null,
  path.join(__dirname, 'lab_data.json'),
  path.join(STORAGE_DIR, 'lab_data.json'),
  path.join(__dirname, 'api', 'data', 'lab_data.json')
].filter(Boolean)));
const DEFAULT_PUBLIC_SETTINGS = {
  headerTitle: 'نتائج التحاليل الطبية',
  headerLead: 'المنصة المعتمدة لعرض النتائج',
  footerText: 'النتائج الظاهرة هنا مرتبطة بالطلب المحفوظ في النظام.'
};
const ROLE_PERMISSIONS = {
  admin: {
    settingsAccess: true,
    userManagement: true,
    testManagement: true,
    saveRecords: true,
    deleteRecords: true,
    clearStorage: true,
    createRecords: true
  },
  lab: {
    settingsAccess: true,
    userManagement: true,
    testManagement: true,
    saveRecords: true,
    deleteRecords: true,
    clearStorage: true,
    createRecords: true
  },
  doctor: {
    settingsAccess: false,
    userManagement: false,
    testManagement: false,
    saveRecords: false,
    deleteRecords: false,
    clearStorage: false,
    createRecords: false
  },
  reception: {
    settingsAccess: false,
    userManagement: false,
    testManagement: false,
    saveRecords: true,
    deleteRecords: false,
    clearStorage: false,
    createRecords: true
  }
};

const loginAttempts = new Map();

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function stripUtf8Bom(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
}

function nowIso() {
  return new Date().toISOString();
}

function safeTrim(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function generateShareToken() {
  return `res_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizePublicSettings(settings = {}) {
  return {
    ...DEFAULT_PUBLIC_SETTINGS,
    ...(settings && typeof settings === 'object' ? settings : {})
  };
}

function getPatientId(order) {
  if (!order || typeof order !== 'object') return '';
  if (order.patient && Object.prototype.hasOwnProperty.call(order.patient, 'id')) {
    return safeTrim(order.patient.id);
  }
  return safeTrim(order.patient_id);
}

function normalizeOrder(order = {}) {
  const patient = order && typeof order.patient === 'object' && order.patient !== null ? { ...order.patient } : {};
  const patientId = getPatientId(order);
  const shareToken = safeTrim(order.share_token || patient.share_token) || generateShareToken();
  const resultsPublished = !!(order.results_published ?? patient.results_published ?? false);
  const publishedAt = order.published_at ?? patient.published_at ?? null;
  const createdAt = order.created_at || order.date || nowIso();
  const updatedAt = order.updated_at || order.date || createdAt;

  patient.id = patientId;
  patient.share_token = shareToken;
  patient.results_published = resultsPublished;
  patient.published_at = publishedAt;

  return {
    patient_id: patientId,
    patient,
    order: Array.isArray(order.order) ? order.order : [],
    settings: normalizePublicSettings(order.settings || {}),
    created_at: createdAt,
    updated_at: updatedAt,
    share_token: shareToken,
    results_published: resultsPublished,
    published_at: publishedAt
  };
}

function createDataBackup(filePath, content) {
  try {
    const text = typeof content === 'string' ? stripUtf8Bom(content) : '';
    if (!text.trim()) return;

    ensureDirectory(BACKUP_DIR);
    const safeBaseName = path.basename(filePath).replace(/[^\w.-]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `${safeBaseName}.${stamp}.bak.json`);
    fs.writeFileSync(backupPath, text, 'utf8');
    cleanupOldBackups();
  } catch (error) {
    console.warn('Failed to create backup copy:', error.message);
  }
}

function cleanupOldBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
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

function readLegacyOrdersFromFiles() {
  for (const candidate of LEGACY_DATA_FILE_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const text = stripUtf8Bom(fs.readFileSync(candidate, 'utf8'));
      if (!text.trim()) continue;

      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) continue;

      createDataBackup(candidate, text);
      return parsed.map(normalizeOrder).filter(order => order.patient_id);
    } catch (error) {
      console.warn(`Failed to read legacy data from ${candidate}:`, error.message);
    }
  }

  return [];
}

function buildSearchText(order) {
  const patient = order.patient || {};
  return [
    order.patient_id,
    patient.id,
    patient.name,
    patient.title,
    patient.phone,
    patient.nationality,
    patient.doctor,
    patient.refBy,
    patient.fileNumber
  ]
    .filter(Boolean)
    .map(value => String(value).trim())
    .join(' | ');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  const [scheme, salt, derivedKey] = String(storedHash || '').split(':');
  if (scheme !== 'scrypt' || !salt || !derivedKey) return false;

  const expected = Buffer.from(derivedKey, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function generateBootstrapPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  return Array.from({ length: 18 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.reception;
}

function hasPermission(user, permissionKey) {
  if (!user) return false;
  const permissions = getPermissionsForRole(user.role);
  return !!permissions[permissionKey];
}

function serializeUser(userRow) {
  return {
    id: userRow.id,
    username: userRow.username,
    displayName: userRow.display_name,
    role: userRow.role,
    active: !!userRow.active,
    mustChangePassword: !!userRow.must_change_password,
    createdAt: userRow.created_at,
    updatedAt: userRow.updated_at,
    lastLoginAt: userRow.last_login_at || null
  };
}

function getAllowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const defaults = ['http://127.0.0.1:3100', 'http://localhost:3100'];

  if (PUBLIC_BASE_URL) {
    try {
      defaults.push(new URL(PUBLIC_BASE_URL).origin);
    } catch (error) {
      console.warn('Invalid PUBLIC_BASE_URL:', error.message);
    }
  }

  return [...new Set([...configured, ...defaults])];
}

const allowedOrigins = getAllowedOrigins();

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS'));
  }
};

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors(corsOptions));
app.options('/api/*', cors(corsOptions));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '8mb' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json({ message: 'Invalid JSON request body' });
  }
  if (error && /Origin not allowed/i.test(error.message)) {
    return res.status(403).json({ message: 'Origin not allowed' });
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
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, 'uploads');
      ensureDirectory(uploadDir);
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
  });

  upload = multer({
    storage,
    limits: {
      fileSize: 10 * 1024 * 1024
    }
  });
}

ensureDirectory(STORAGE_DIR);
ensureDirectory(BACKUP_DIR);

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA temp_store = MEMORY;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS orders (
    patient_id TEXT PRIMARY KEY,
    patient_name TEXT,
    doctor_name TEXT,
    share_token TEXT NOT NULL UNIQUE,
    results_published INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    patient_json TEXT NOT NULL,
    order_json TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    search_text TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_patient_name ON orders (patient_name);
  CREATE INDEX IF NOT EXISTS idx_orders_doctor_name ON orders (doctor_name);
  CREATE INDEX IF NOT EXISTS idx_orders_share_token ON orders (share_token);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON auth_sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON auth_sessions (expires_at);
`);

const statements = {
  countOrders: db.prepare('SELECT COUNT(*) AS count FROM orders'),
  countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
  getOrderByPatientId: db.prepare('SELECT * FROM orders WHERE patient_id = ?'),
  getOrderByShareToken: db.prepare('SELECT * FROM orders WHERE share_token = ?'),
  countTokenOwners: db.prepare('SELECT patient_id FROM orders WHERE share_token = ?'),
  upsertOrder: db.prepare(`
    INSERT INTO orders (
      patient_id,
      patient_name,
      doctor_name,
      share_token,
      results_published,
      published_at,
      created_at,
      updated_at,
      patient_json,
      order_json,
      settings_json,
      search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(patient_id) DO UPDATE SET
      patient_name = excluded.patient_name,
      doctor_name = excluded.doctor_name,
      share_token = excluded.share_token,
      results_published = excluded.results_published,
      published_at = excluded.published_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      patient_json = excluded.patient_json,
      order_json = excluded.order_json,
      settings_json = excluded.settings_json,
      search_text = excluded.search_text
  `),
  deleteOrder: db.prepare('DELETE FROM orders WHERE patient_id = ?'),
  listUsers: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (
      username,
      display_name,
      password_hash,
      role,
      active,
      must_change_password,
      created_at,
      updated_at,
      last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateUser: db.prepare(`
    UPDATE users
    SET display_name = ?, password_hash = ?, role = ?, active = ?, must_change_password = ?, updated_at = ?
    WHERE username = ?
  `),
  updateUserProfileWithoutPassword: db.prepare(`
    UPDATE users
    SET display_name = ?, role = ?, active = ?, must_change_password = ?, updated_at = ?
    WHERE username = ?
  `),
  deleteUser: db.prepare('DELETE FROM users WHERE username = ?'),
  countActiveAdmins: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1"),
  updateLastLoginAt: db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?'),
  insertSession: db.prepare(`
    INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  getSessionByHash: db.prepare(`
    SELECT
      auth_sessions.token_hash,
      auth_sessions.user_id,
      auth_sessions.created_at AS session_created_at,
      auth_sessions.expires_at,
      auth_sessions.last_used_at,
      users.id,
      users.username,
      users.display_name,
      users.password_hash,
      users.role,
      users.active,
      users.must_change_password,
      users.created_at,
      users.updated_at,
      users.last_login_at
    FROM auth_sessions
    INNER JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ?
  `),
  touchSession: db.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?'),
  deleteSessionsForUser: db.prepare('DELETE FROM auth_sessions WHERE user_id = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?')
};

function deserializeOrderRow(row) {
  if (!row) return null;

  const patient = JSON.parse(row.patient_json);
  const orderItems = JSON.parse(row.order_json);
  const settings = JSON.parse(row.settings_json);

  return normalizeOrder({
    patient_id: row.patient_id,
    patient,
    order: orderItems,
    settings,
    created_at: row.created_at,
    updated_at: row.updated_at,
    share_token: row.share_token,
    results_published: !!row.results_published,
    published_at: row.published_at
  });
}

function ensureUniqueShareToken(preferredToken, patientId) {
  let candidate = safeTrim(preferredToken) || generateShareToken();

  while (true) {
    const row = statements.countTokenOwners.get(candidate);
    if (!row || safeTrim(row.patient_id) === safeTrim(patientId)) {
      return candidate;
    }
    candidate = generateShareToken();
  }
}

function buildOrderRow(order) {
  const normalized = normalizeOrder(order);
  const patient = normalized.patient || {};
  const patientName = [patient.title, patient.name].filter(Boolean).join(' ').trim() || safeTrim(patient.name);
  const doctorName = safeTrim(patient.doctor || patient.refBy);

  return {
    patientId: normalized.patient_id,
    patientName,
    doctorName,
    shareToken: ensureUniqueShareToken(normalized.share_token, normalized.patient_id),
    resultsPublished: normalized.results_published ? 1 : 0,
    publishedAt: normalized.published_at || null,
    createdAt: normalized.created_at,
    updatedAt: normalized.updated_at,
    patientJson: JSON.stringify(normalized.patient),
    orderJson: JSON.stringify(normalized.order || []),
    settingsJson: JSON.stringify(normalized.settings || DEFAULT_PUBLIC_SETTINGS),
    searchText: buildSearchText(normalized)
  };
}

function migrateLegacyOrders(orders) {
  db.exec('BEGIN');
  try {
    orders.forEach(order => {
      const row = buildOrderRow(order);
      statements.upsertOrder.run(
        row.patientId,
        row.patientName,
        row.doctorName,
        row.shareToken,
        row.resultsPublished,
        row.publishedAt,
        row.createdAt,
        row.updatedAt,
        row.patientJson,
        row.orderJson,
        row.settingsJson,
        row.searchText
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateLegacyJsonData() {
  const { count } = statements.countOrders.get();
  if (count > 0) return;

  const legacyOrders = readLegacyOrdersFromFiles();
  if (legacyOrders.length === 0) return;

  migrateLegacyOrders(legacyOrders);
  console.log(`Migrated ${legacyOrders.length} orders from legacy JSON files into SQLite.`);
}

function seedAdminUser() {
  const { count } = statements.countUsers.get();
  if (count > 0) return;

  const username = safeTrim(process.env.ADMIN_USERNAME) || 'admin';
  const displayName = safeTrim(process.env.ADMIN_DISPLAY_NAME) || 'مدير النظام';
  const configuredPassword = safeTrim(process.env.ADMIN_PASSWORD);
  const password = configuredPassword || generateBootstrapPassword();
  const createdAt = nowIso();

  statements.insertUser.run(
    username,
    displayName,
    createPasswordHash(password),
    'admin',
    1,
    configuredPassword ? 0 : 1,
    createdAt,
    createdAt,
    null
  );

  if (!configuredPassword) {
    const bootstrapText = [
      'Initial bootstrap administrator credentials',
      `username=${username}`,
      `password=${password}`,
      'Delete or secure this file after the first login.'
    ].join('\n');
    fs.writeFileSync(BOOTSTRAP_ADMIN_FILE, bootstrapText, 'utf8');
    console.warn(`Bootstrap admin credentials written to ${BOOTSTRAP_ADMIN_FILE}`);
  }
}

function cleanupExpiredSessions() {
  statements.deleteExpiredSessions.run(nowIso());
}

function findUserByUsername(username) {
  return statements.getUserByUsername.get(safeTrim(username));
}

function createUserSession(userId) {
  cleanupExpiredSessions();

  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const tokenHash = hashSessionToken(token);

  statements.insertSession.run(tokenHash, userId, createdAt, expiresAt, createdAt);

  return {
    token,
    expiresAt
  };
}

function getAuthenticatedSession(token) {
  cleanupExpiredSessions();

  const tokenHash = hashSessionToken(token);
  const sessionRow = statements.getSessionByHash.get(tokenHash);
  if (!sessionRow) return null;
  if (!sessionRow.active) return null;
  if (String(sessionRow.expires_at) <= nowIso()) {
    statements.deleteSession.run(tokenHash);
    return null;
  }

  statements.touchSession.run(nowIso(), tokenHash);

  return {
    tokenHash,
    expiresAt: sessionRow.expires_at,
    user: serializeUser(sessionRow)
  };
}

function requireAuth(req, res, next) {
  const authorization = safeTrim(req.get('authorization'));
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const session = getAuthenticatedSession(match[1]);
  if (!session) {
    return res.status(401).json({ message: 'Invalid or expired session' });
  }

  req.auth = session;
  return next();
}

function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.auth || !req.auth.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!hasPermission(req.auth.user, permissionKey)) {
      return res.status(403).json({ message: 'You do not have permission for this action' });
    }

    return next();
  };
}

function ensureLoginAllowed(ipAddress) {
  const now = Date.now();
  const entry = loginAttempts.get(ipAddress);
  if (!entry) return true;
  if (now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ipAddress);
    return true;
  }
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ipAddress) {
  const now = Date.now();
  const entry = loginAttempts.get(ipAddress);
  if (!entry || now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ipAddress, { count: 1, firstAttemptAt: now });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(ipAddress) {
  loginAttempts.delete(ipAddress);
}

function listOrders({ page, pageSize, search, published, fromDate, toDate }) {
  const conditions = [];
  const values = [];

  if (search) {
    conditions.push('search_text LIKE ?');
    values.push(`%${search}%`);
  }

  if (published === 'true' || published === 'false') {
    conditions.push('results_published = ?');
    values.push(published === 'true' ? 1 : 0);
  }

  if (fromDate) {
    conditions.push('updated_at >= ?');
    values.push(fromDate);
  }

  if (toDate) {
    conditions.push('updated_at <= ?');
    values.push(toDate);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*) AS count FROM orders ${whereClause}`;
  const total = db.prepare(countSql).get(...values).count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  const listSql = `
    SELECT *
    FROM orders
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(listSql).all(...values, pageSize, offset);

  return {
    items: rows.map(deserializeOrderRow),
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1
    }
  };
}

function saveOrder(payload, existingOrder = null) {
  const patient = payload && typeof payload.patient === 'object' && payload.patient !== null ? payload.patient : {};
  const patientId = safeTrim(patient.id || payload.patient_id);
  if (!patientId) {
    const error = new Error('patient.id is required');
    error.status = 400;
    throw error;
  }

  const now = nowIso();
  const normalized = normalizeOrder({
    patient_id: patientId,
    patient,
    order: Array.isArray(payload.order) ? payload.order : [],
    settings: payload.settings || existingOrder?.settings || {},
    created_at: existingOrder?.created_at || now,
    updated_at: now,
    share_token: existingOrder?.share_token || patient.share_token,
    results_published: existingOrder?.results_published || false,
    published_at: existingOrder?.published_at || null
  });
  const row = buildOrderRow(normalized);

  statements.upsertOrder.run(
    row.patientId,
    row.patientName,
    row.doctorName,
    row.shareToken,
    row.resultsPublished,
    row.publishedAt,
    row.createdAt,
    row.updatedAt,
    row.patientJson,
    row.orderJson,
    row.settingsJson,
    row.searchText
  );

  return deserializeOrderRow(statements.getOrderByPatientId.get(patientId));
}

function updateOrderPublication(patientId, shouldPublish) {
  const existing = deserializeOrderRow(statements.getOrderByPatientId.get(patientId));
  if (!existing) {
    const error = new Error('Order not found');
    error.status = 404;
    throw error;
  }

  const publishedAt = shouldPublish ? nowIso() : null;
  const updated = normalizeOrder({
    ...existing,
    patient: {
      ...existing.patient,
      results_published: shouldPublish,
      published_at: publishedAt
    },
    results_published: shouldPublish,
    published_at: publishedAt,
    updated_at: nowIso()
  });
  const row = buildOrderRow(updated);

  statements.upsertOrder.run(
    row.patientId,
    row.patientName,
    row.doctorName,
    row.shareToken,
    row.resultsPublished,
    row.publishedAt,
    row.createdAt,
    row.updatedAt,
    row.patientJson,
    row.orderJson,
    row.settingsJson,
    row.searchText
  );

  return deserializeOrderRow(statements.getOrderByPatientId.get(patientId));
}

function deleteOrder(patientId) {
  const result = statements.deleteOrder.run(safeTrim(patientId));
  return result.changes > 0;
}

function validateRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role) ? role : null;
}

function saveUser({ username, displayName, password, role, active, mustChangePassword }, existingUser = null) {
  const normalizedUsername = safeTrim(username);
  const normalizedDisplayName = safeTrim(displayName);
  const normalizedRole = validateRole(safeTrim(role));

  if (!normalizedUsername || normalizedUsername.length < 3) {
    const error = new Error('Username must be at least 3 characters');
    error.status = 400;
    throw error;
  }
  if (/\s/.test(normalizedUsername)) {
    const error = new Error('Username must not contain spaces');
    error.status = 400;
    throw error;
  }
  if (!normalizedDisplayName || normalizedDisplayName.length < 2) {
    const error = new Error('Display name must be at least 2 characters');
    error.status = 400;
    throw error;
  }
  if (!normalizedRole) {
    const error = new Error('Invalid user role');
    error.status = 400;
    throw error;
  }
  if (!existingUser && safeTrim(password).length < 8) {
    const error = new Error('Password must be at least 8 characters');
    error.status = 400;
    throw error;
  }

  const now = nowIso();

  if (existingUser) {
    if (existingUser.role === 'admin' && existingUser.active && active === false) {
      const { count } = statements.countActiveAdmins.get();
      if (count <= 1) {
        const error = new Error('Cannot disable the last active admin');
        error.status = 400;
        throw error;
      }
    }

    if (safeTrim(password)) {
      statements.updateUser.run(
        normalizedDisplayName,
        createPasswordHash(password),
        normalizedRole,
        active ? 1 : 0,
        mustChangePassword ? 1 : 0,
        now,
        normalizedUsername
      );
    } else {
      statements.updateUserProfileWithoutPassword.run(
        normalizedDisplayName,
        normalizedRole,
        active ? 1 : 0,
        mustChangePassword ? 1 : 0,
        now,
        normalizedUsername
      );
    }

    return serializeUser(findUserByUsername(normalizedUsername));
  }

  statements.insertUser.run(
    normalizedUsername,
    normalizedDisplayName,
    createPasswordHash(password),
    normalizedRole,
    active ? 1 : 0,
    mustChangePassword ? 1 : 0,
    now,
    now,
    null
  );
  return serializeUser(findUserByUsername(normalizedUsername));
}

function deleteUser(username, currentUser) {
  const existing = findUserByUsername(username);
  if (!existing) return false;

  if (existing.id === currentUser.id) {
    const error = new Error('You cannot delete your current account');
    error.status = 400;
    throw error;
  }

  if (existing.role === 'admin' && existing.active) {
    const { count } = statements.countActiveAdmins.get();
    if (count <= 1) {
      const error = new Error('Cannot delete the last active admin');
      error.status = 400;
      throw error;
    }
  }

  statements.deleteSessionsForUser.run(existing.id);
  const result = statements.deleteUser.run(username);
  return result.changes > 0;
}

function healthPayload() {
  const orderCount = statements.countOrders.get().count;
  const userCount = statements.countUsers.get().count;
  return {
    status: 'ok',
    db: 'sqlite',
    connected: true,
    runtime: 'node',
    counts: {
      orders: orderCount,
      users: userCount
    }
  };
}

migrateLegacyJsonData();
seedAdminUser();
cleanupExpiredSessions();

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
  res.json(healthPayload());
});

app.get('/api/config', (req, res) => {
  const fallbackBaseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    publicBaseUrl: PUBLIC_BASE_URL || fallbackBaseUrl,
    port: PORT,
    host: HOST,
    centerName: CENTER_NAME,
    authMode: 'token',
    db: 'sqlite'
  });
});

app.post('/api/auth/login', (req, res) => {
  const username = safeTrim(req.body?.username);
  const password = safeTrim(req.body?.password);

  if (!ensureLoginAllowed(req.ip)) {
    return res.status(429).json({ message: 'Too many login attempts. Try again later.' });
  }
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const user = findUserByUsername(username);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ message: 'Invalid username or password' });
  }

  clearLoginFailures(req.ip);
  const session = createUserSession(user.id);
  const loginAt = nowIso();
  statements.updateLastLoginAt.run(loginAt, loginAt, user.id);

  res.json({
    authenticated: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: serializeUser({ ...user, last_login_at: loginAt, updated_at: loginAt })
  });
});

app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({
    authenticated: true,
    expiresAt: req.auth.expiresAt,
    user: req.auth.user
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  statements.deleteSession.run(req.auth.tokenHash);
  res.json({ loggedOut: true });
});

app.get('/api/orders', requireAuth, (req, res) => {
  const page = parseInteger(req.query.page, 1, 1, 1000000);
  const pageSize = parseInteger(req.query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const search = safeTrim(req.query.search);
  const published = safeTrim(req.query.published).toLowerCase();
  const fromDate = safeTrim(req.query.fromDate);
  const toDate = safeTrim(req.query.toDate);

  res.json(listOrders({ page, pageSize, search, published, fromDate, toDate }));
});

app.get('/api/orders/:patientId', requireAuth, (req, res) => {
  const order = deserializeOrderRow(statements.getOrderByPatientId.get(safeTrim(req.params.patientId)));
  if (!order) {
    return res.status(404).json({ message: 'غير موجود' });
  }
  return res.json(order);
});

app.get('/api/public-results/:token', (req, res) => {
  const row = statements.getOrderByShareToken.get(safeTrim(req.params.token));
  if (!row) {
    return res.status(404).json({ message: 'Result link not found' });
  }

  const order = deserializeOrderRow(row);
  if (!order.results_published) {
    return res.status(423).json({
      message: 'Results are not published yet',
      published: false,
      settings: order.settings || {}
    });
  }

  return res.json(order);
});

app.post('/api/orders', requireAuth, requirePermission('saveRecords'), (req, res, next) => {
  try {
    const existing = deserializeOrderRow(statements.getOrderByPatientId.get(safeTrim(req.body?.patient?.id || req.body?.patient_id)));
    const order = saveOrder(req.body, existing);

    res.json({
      saved: true,
      patientId: order.patient_id,
      date: order.updated_at,
      shareToken: order.share_token,
      resultsPublished: order.results_published,
      publishedAt: order.published_at
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders/:patientId/publish', requireAuth, requirePermission('saveRecords'), (req, res, next) => {
  try {
    const order = updateOrderPublication(safeTrim(req.params.patientId), true);
    res.json({
      published: true,
      patientId: order.patient_id,
      publishedAt: order.published_at,
      shareToken: order.share_token
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders/:patientId/unpublish', requireAuth, requirePermission('saveRecords'), (req, res, next) => {
  try {
    const order = updateOrderPublication(safeTrim(req.params.patientId), false);
    res.json({
      published: false,
      patientId: order.patient_id,
      shareToken: order.share_token
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/orders/:patientId', requireAuth, requirePermission('deleteRecords'), (req, res) => {
  const deleted = deleteOrder(req.params.patientId);
  if (!deleted) {
    return res.status(404).json({ message: 'فات الطلب' });
  }
  return res.json({ deleted: true });
});

app.get('/api/users', requireAuth, requirePermission('userManagement'), (req, res) => {
  const users = statements.listUsers.all().map(serializeUser);
  res.json({ items: users });
});

app.post('/api/users', requireAuth, requirePermission('userManagement'), (req, res, next) => {
  try {
    const user = saveUser({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: req.body?.role,
      active: req.body?.active !== false,
      mustChangePassword: req.body?.mustChangePassword === true
    });
    res.status(201).json({ created: true, user });
  } catch (error) {
    next(error);
  }
});

app.put('/api/users/:username', requireAuth, requirePermission('userManagement'), (req, res, next) => {
  try {
    const existing = findUserByUsername(req.params.username);
    if (!existing) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = saveUser({
      username: req.params.username,
      displayName: req.body?.displayName ?? existing.display_name,
      password: req.body?.password,
      role: req.body?.role ?? existing.role,
      active: req.body?.active ?? !!existing.active,
      mustChangePassword: req.body?.mustChangePassword ?? !!existing.must_change_password
    }, existing);

    res.json({ updated: true, user });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/users/:username', requireAuth, requirePermission('userManagement'), (req, res, next) => {
  try {
    const deleted = deleteUser(req.params.username, req.auth.user);
    if (!deleted) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

if (upload) {
  app.post('/api/upload', requireAuth, requirePermission('saveRecords'), upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }

    return res.json({
      message: 'تم رفع الملف بنجاح',
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    });
  });
}

app.use((error, req, res, next) => {
  const status = Number(error?.status) || 500;
  const message = error?.message || 'Internal Server Error';
  if (status >= 500) {
    console.error('Server error:', error);
  }
  res.status(status).json({ message });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Database file: ${DB_FILE}`);
  if (PUBLIC_BASE_URL) {
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  }
  if (fs.existsSync(BOOTSTRAP_ADMIN_FILE)) {
    console.warn(`Bootstrap admin file detected at ${BOOTSTRAP_ADMIN_FILE}. Remove it after first secure login.`);
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
