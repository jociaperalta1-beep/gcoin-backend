const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const DATABASE_PATH = process.env.DB_PATH || './gcoin_guarani.db';
const JWT_SECRET = process.env.JWT_SECRET || 'clave_secreta_temporal_muy_larga_de_prueba_2026';
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || 'https://gcoin.depinguarani.com').replace(/\/+$/, '');
const REFERRAL_BONUS = 1000;
const POINTS_PER_MINUTE = 7.64;
const DAILY_POINTS_LIMIT = 11000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const MAX_HEARTBEAT_GAP_MS = 2 * HEARTBEAT_INTERVAL_MS;
const POINTS_CYCLE_MS = 24 * 60 * 60 * 1000;
const ROULETTE_SPIN_LIMIT = 15;
const WITHDRAWAL_MINIMUM_MICRO_USD = 5_000_000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const USD_PER_DEPIN_POINT = parseUsdPerPoint(process.env.USD_PER_DEPIN_POINT);
const SMTP_TRANSPORT = createSmtpTransport();
const ROULETTE_PRIZES = [
  { points: 10, weight: 450 },
  { points: 30, weight: 300 },
  { points: 50, weight: 150 },
  { points: 100, weight: 99 },
  { points: 1000, weight: 1 },
];
const GEM_MILESTONES = [
  { points: 1000, gems: 5, label: 'Primer paso' },
  { points: 3000, gems: 20, label: 'Raíces firmes' },
  { points: 5000, gems: 50, label: 'Guardián del camino' },
  { points: 7000, gems: 100, label: 'Memoria viva' },
  { points: 9000, gems: 200, label: 'Cima cultural' },
];
const JWT_ISSUER = 'gcoin-guarani';
const JWT_AUDIENCE = 'gcoin-api';
const scrypt = promisify(crypto.scrypt);
const normalizeEmail = (email) => email.trim().toLowerCase();
const isValidEmail = (email) =>
  typeof email === 'string' &&
  email.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function parseUsdPerPoint(value) {
  if (value === undefined || value === '') {
    return null;
  }
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(value)) {
    throw new Error('USD_PER_DEPIN_POINT debe ser un decimal positivo de hasta 6 decimales.');
  }
  const rate = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(rate) || rate <= 0) {
    throw new Error('USD_PER_DEPIN_POINT debe ser mayor que cero.');
  }
  return rate;
}

function createSmtpTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, ADMIN_EMAIL } = process.env;
  if (![SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, ADMIN_EMAIL].every(Boolean)) {
    return null;
  }
  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT debe ser un puerto válido.');
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const microUsdToUsd = (amount) => Number((Number(amount || 0) / 1_000_000).toFixed(6));
const payoutForPoints = (points) => USD_PER_DEPIN_POINT === null
  ? 0
  : Math.round(Math.round(points * 1_000_000) * USD_PER_DEPIN_POINT / 1_000_000);

if (typeof JWT_SECRET !== 'string' || Buffer.byteLength(JWT_SECRET) < 32) {
  console.error('Configura JWT_SECRET con al menos 32 bytes antes de iniciar el servidor.');
  process.exit(1);
}

app.use(express.json({ limit: '16kb' }));
app.use(cors());

const db = new sqlite3.Database(DATABASE_PATH, (err) => {
  if (err) {
    console.error('Error al conectar con la base de datos:', err.message);
  }
});

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        return reject(err);
      }
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        return reject(err);
      }
      return resolve(row);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        return reject(err);
      }
      return resolve(rows);
    });
  });

let transactionQueue = Promise.resolve();

const withTransaction = (callback) => {
  const transaction = transactionQueue.then(async () => {
    await run('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      await run('COMMIT');
      return result;
    } catch (err) {
      try {
        await run('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Error al revertir una transacción:', rollbackErr.message);
      }
      throw err;
    }
  });

  transactionQueue = transaction.catch(() => {});
  return transaction;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
};

const verifyPassword = async (password, storedPassword) => {
  if (storedPassword.startsWith('scrypt$')) {
    const [, saltHex, keyHex] = storedPassword.split('$');
  if (!saltHex || !keyHex || !/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(keyHex)) {
      return { valid: false, needsUpgrade: false };
    }

    const salt = Buffer.from(saltHex, 'hex');
    const expectedKey = Buffer.from(keyHex, 'hex');
    if (expectedKey.length !== 64) {
      return { valid: false, needsUpgrade: false };
    }

    const actualKey = await scrypt(password, salt, expectedKey.length);
    return {
      valid: crypto.timingSafeEqual(expectedKey, actualKey),
      needsUpgrade: false,
    };
  }

  const supplied = Buffer.from(password);
  const legacy = Buffer.from(storedPassword);
  const valid = supplied.length === legacy.length && crypto.timingSafeEqual(supplied, legacy);
  return { valid, needsUpgrade: valid };
};

const createAccessToken = (user) =>
  jwt.sign(
    { username: user.username },
    JWT_SECRET,
    {
      subject: String(user.id),
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '1h',
    },
  );

function verificarToken(req, res, next) {
  const authHeader = req.get('authorization');
  const match = typeof authHeader === 'string' && authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Acceso denegado. Token Bearer no proporcionado.' });
  }

  jwt.verify(
    match[1],
    JWT_SECRET,
    { issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    (err, decoded) => {
      if (err || !decoded || typeof decoded === 'string' || !/^\d+$/.test(decoded.sub || '')) {
        return res.status(403).json({ error: 'Token inválido o expirado.' });
      }

      req.user = { id: Number(decoded.sub), username: decoded.username };
      return next();
    },
  );
}

const getUserToken = (req) => {
  const token = req.get('x-node-token');
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
    throw new HttpError(401, 'Token de nodo inválido o no proporcionado.');
  }
  return crypto.createHash('sha256').update(token).digest('hex');
};

const normalizePointCycle = (pointsValue, cycleStartedAtValue, now) => {
  let pointsToday = Number(pointsValue) || 0;
  let cycleStartedAt = cycleStartedAtValue ? Date.parse(cycleStartedAtValue) : null;

  if (cycleStartedAt !== null && !Number.isFinite(cycleStartedAt)) {
    throw new Error('La fecha del ciclo de puntos almacenada no es válida.');
  }
  if (cycleStartedAt !== null && now >= cycleStartedAt + POINTS_CYCLE_MS) {
    const elapsedCycles = Math.floor((now - cycleStartedAt) / POINTS_CYCLE_MS);
    cycleStartedAt += elapsedCycles * POINTS_CYCLE_MS;
    pointsToday = 0;
  }

  return { pointsToday, cycleStartedAt };
};

const awardCrossedMilestones = async (userId, previousPoints, currentPoints, initialGemsBalance) => {
  let gemsBalance = initialGemsBalance;
  let gemsAdded = 0;
  const unlockedMilestones = [];

  for (const milestone of GEM_MILESTONES) {
    if (previousPoints < milestone.points && currentPoints >= milestone.points) {
      const award = await run(
        `INSERT OR IGNORE INTO gem_milestones (user_id, milestone_points, gems_awarded)
         VALUES (?, ?, ?)`,
        [userId, milestone.points, milestone.gems],
      );
      if (award.changes) {
        gemsBalance += milestone.gems;
        gemsAdded += milestone.gems;
        unlockedMilestones.push({
          points: milestone.points,
          gems: milestone.gems,
          label: milestone.label,
        });
      }
    }
  }

  return { gemsBalance, gemsAdded, unlockedMilestones };
};

const getRoulettePrize = (roll) => {
  let limit = 0;
  for (const prize of ROULETTE_PRIZES) {
    limit += prize.weight;
    if (roll < limit) {
      return prize.points;
    }
  }
  throw new Error('El sorteo de la ruleta produjo un resultado fuera de rango.');
};

const ensureColumn = async (table, column, definition) => {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

const initializeDatabase = async () => {
  await run('PRAGMA foreign_keys = ON');
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    gcoins REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    referred_by TEXT,
    points_today REAL NOT NULL DEFAULT 0,
    points_cycle_started_at TEXT,
    gems_balance INTEGER NOT NULL DEFAULT 0
  )`);
  await ensureColumn('users', 'referred_by', 'TEXT');
  await ensureColumn('users', 'points_today', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('users', 'points_cycle_started_at', 'TEXT');
  await ensureColumn('users', 'gems_balance', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'payout_wallet_address', 'TEXT');
  await ensureColumn('users', 'payout_balance_microusd', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'email', 'TEXT');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL');

  await run(`CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_name TEXT UNIQUE NOT NULL,
    wallet_address TEXT,
    points REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    owner_user_id INTEGER REFERENCES users(id),
    token_hash TEXT,
    last_heartbeat_at TEXT
  )`);
  await ensureColumn('nodes', 'owner_user_id', 'INTEGER REFERENCES users(id)');
  await ensureColumn('nodes', 'token_hash', 'TEXT');
  await ensureColumn('nodes', 'last_heartbeat_at', 'TEXT');
  await run('CREATE INDEX IF NOT EXISTS idx_nodes_owner_user_id ON nodes(owner_user_id)');
  await run(`CREATE TABLE IF NOT EXISTS gem_milestones (
    user_id INTEGER NOT NULL REFERENCES users(id),
    milestone_points INTEGER NOT NULL,
    gems_awarded INTEGER NOT NULL,
    achieved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, milestone_points)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS roulette_spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    cycle_started_at TEXT NOT NULL,
    random_roll INTEGER NOT NULL,
    selected_prize_points INTEGER NOT NULL,
    points_awarded REAL NOT NULL,
    points_before REAL NOT NULL,
    points_after REAL NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, request_id)
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_roulette_spins_cycle ON roulette_spins(user_id, cycle_started_at)');
  await run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id, used_at)');
  await run(`CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount_microusd INTEGER NOT NULL CHECK (amount_microusd > 0),
    wallet_snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    notification_status TEXT NOT NULL DEFAULT 'PENDING',
    notification_error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notified_at DATETIME
  )`);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_status
     ON withdrawal_requests(user_id, status, created_at)`,
  );

  await run(`CREATE TRIGGER IF NOT EXISTS users_referral_bonus
    AFTER INSERT ON users
    WHEN NEW.referred_by IS NOT NULL
    BEGIN
      UPDATE users
      SET gcoins = COALESCE(gcoins, 0) + ${REFERRAL_BONUS}
      WHERE username = NEW.referred_by;
    END`);
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/register', asyncHandler(async (req, res) => {
  const { username, password, email, referredBy } = req.body || {};
  if (
    typeof username !== 'string' ||
    !username.trim() ||
    username.trim().length > 64 ||
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 256 ||
    !isValidEmail(email)
  ) {
    throw new HttpError(400, 'Ingresa un usuario válido, un correo válido y una contraseña de entre 8 y 256 caracteres.');
  }

  const normalizedUsername = username.trim();
  const normalizedEmail = normalizeEmail(email);
  const existingEmail = await get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', [normalizedEmail]);
  if (existingEmail) {
    throw new HttpError(409, 'Este correo ya está asociado a una cuenta.');
  }

  let normalizedReferrer;
  if (referredBy !== undefined && referredBy !== null && referredBy !== '') {
    if (typeof referredBy !== 'string' || !referredBy.trim() || referredBy.trim().length > 64) {
      throw new HttpError(400, 'El campo referredBy debe ser un username válido.');
    }
    normalizedReferrer = referredBy.trim();
    if (normalizedReferrer === normalizedUsername) {
      throw new HttpError(400, 'No puedes referirte a ti mismo.');
    }
  }

  const passwordHash = await hashPassword(password);
  const result = await withTransaction(async () => {
    let referrer = null;
    if (normalizedReferrer) {
      referrer = await get(
        'SELECT id, username FROM users WHERE username = ?',
        [normalizedReferrer],
      );
      if (!referrer) {
        throw new HttpError(400, 'El usuario o código de referido no existe.');
      }
    }

    const referralApplied = Boolean(referrer);
    const initialGcoins = referralApplied ? REFERRAL_BONUS : 0;
    const insert = await run(
      `INSERT INTO users (username, password, email, gcoins, referred_by)
       VALUES (?, ?, ?, ?, ?)`,
      [normalizedUsername, passwordHash, normalizedEmail, initialGcoins, referrer ? referrer.username : null],
    );
    return {
      user: { id: insert.lastID, username: normalizedUsername },
      referralApplied,
      referredBy: referrer ? referrer.username : null,
      newUserBonus: initialGcoins,
      referrerBonus: referralApplied ? REFERRAL_BONUS : 0,
    };
  });

  return res.status(201).json({
    message: '¡Usuario registrado con éxito en Gcoin Guaraní!',
    userId: result.user.id,
    username: result.user.username,
    token: createAccessToken(result.user),
    referralApplied: result.referralApplied,
    referredBy: result.referredBy,
    newUserBonus: result.newUserBonus,
    referrerBonus: result.referrerBonus,
  });
}));

app.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    throw new HttpError(400, 'Ingresa un correo válido.');
  }
  if (!SMTP_TRANSPORT) {
    throw new HttpError(503, 'La recuperación de contraseña no está disponible: falta configurar el correo SMTP.');
  }

  const user = await get(
    'SELECT id, email FROM users WHERE email = ? COLLATE NOCASE',
    [normalizeEmail(email)],
  );
  if (!user) {
    return res.json({ message: 'Si existe una cuenta con ese correo, recibirá un enlace para restablecer la contraseña.' });
  }
  const recentRequests = await get(
    `SELECT COUNT(*) AS count FROM password_reset_tokens
     WHERE user_id = ? AND created_at >= datetime('now', '-1 hour')`,
    [user.id],
  );
  if (Number(recentRequests.count) >= 3) {
    return res.json({ message: 'Si existe una cuenta con ese correo, recibirá un enlace para restablecer la contraseña.' });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
  await withTransaction(async () => {
    await run(
      'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL',
      [user.id],
    );
    await run(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [user.id, tokenHash, expiresAt],
    );
  });

  const resetUrl = new URL('/', `${PUBLIC_APP_URL}/`);
  resetUrl.hash = new URLSearchParams({ resetToken }).toString();
  try {
    await SMTP_TRANSPORT.sendMail({
      from: process.env.SMTP_FROM,
      to: user.email,
      subject: 'Restablece tu contraseña de Gcoin Guaraní',
      text: `Usa este enlace para crear una nueva contraseña. El enlace vence en 30 minutos y solo puede usarse una vez:\n\n${resetUrl.href}\n\nSi no solicitaste este cambio, ignora este mensaje.`,
    });
  } catch (error) {
    await run(
      'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL',
      [tokenHash],
    );
    console.error('No se pudo enviar el correo de recuperación de contraseña:', error.message);
    throw new HttpError(502, 'No se pudo enviar el correo de recuperación. Intenta nuevamente más tarde.');
  }

  return res.json({ message: 'Si existe una cuenta con ese correo, recibirá un enlace para restablecer la contraseña.' });
}));

app.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(token) ||
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 256
  ) {
    throw new HttpError(400, 'El enlace no es válido o la contraseña no cumple los requisitos.');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const tokenRecord = await get(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?',
    [tokenHash],
  );
  if (
    !tokenRecord ||
    tokenRecord.used_at ||
    !Number.isFinite(Date.parse(tokenRecord.expires_at)) ||
    Date.parse(tokenRecord.expires_at) <= Date.now()
  ) {
    throw new HttpError(400, 'El enlace de recuperación venció o ya fue utilizado. Solicita uno nuevo.');
  }

  const passwordHash = await hashPassword(password);
  await withTransaction(async () => {
    const activeToken = await get(
      'SELECT id, expires_at FROM password_reset_tokens WHERE id = ? AND used_at IS NULL',
      [tokenRecord.id],
    );
    if (
      !activeToken ||
      !Number.isFinite(Date.parse(activeToken.expires_at)) ||
      Date.parse(activeToken.expires_at) <= Date.now()
    ) {
      throw new HttpError(400, 'El enlace de recuperación venció o ya fue utilizado. Solicita uno nuevo.');
    }
    await run('UPDATE users SET password = ? WHERE id = ?', [passwordHash, tokenRecord.user_id]);
    await run(
      'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL',
      [tokenRecord.user_id],
    );
  });

  return res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
}));

app.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'Username y password son obligatorios.');
  }

  const user = await get(
    'SELECT id, username, password FROM users WHERE username = ?',
    [username.trim()],
  );
  if (!user) {
    throw new HttpError(401, 'Credenciales inválidas.');
  }

  const verification = await verifyPassword(password, user.password);
  if (!verification.valid) {
    throw new HttpError(401, 'Credenciales inválidas.');
  }

  if (verification.needsUpgrade) {
    const passwordHash = await hashPassword(password);
    await run('UPDATE users SET password = ? WHERE id = ?', [passwordHash, user.id]);
  }

  return res.json({
    message: 'Inicio de sesión exitoso.',
    userId: user.id,
    username: user.username,
    token: createAccessToken(user),
  });
}));

app.get('/api/nodes', verificarToken, asyncHandler(async (req, res) => {
  const nodes = await all(
    `SELECT id, node_name, wallet_address, points, created_at, last_heartbeat_at
     FROM nodes WHERE owner_user_id = ? ORDER BY id`,
    [req.user.id],
  );
  return res.json({ nodes });
}));

app.post('/api/nodes', verificarToken, asyncHandler(async (req, res) => {
  const { nodeName, walletAddress = null } = req.body || {};
  if (
    typeof nodeName !== 'string' ||
    !nodeName.trim() ||
    nodeName.trim().length > 100 ||
    (walletAddress !== null && (typeof walletAddress !== 'string' || walletAddress.length > 255))
  ) {
    throw new HttpError(400, 'nodeName es obligatorio y walletAddress debe ser una cadena válida.');
  }

  const nodeToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(nodeToken).digest('hex');
  const result = await withTransaction(() =>
    run(
      `INSERT INTO nodes (node_name, wallet_address, owner_user_id, token_hash)
       VALUES (?, ?, ?, ?)`,
      [nodeName.trim(), walletAddress, req.user.id, tokenHash],
    ),
  );

  return res.status(201).json({
    message: 'Nodo registrado. Guarda su token: no volverá a mostrarse.',
    node: {
      id: result.lastID,
      nodeName: nodeName.trim(),
      walletAddress,
      points: 0,
    },
    nodeToken,
  });
}));

app.post('/api/nodes/:id/rotate-token', verificarToken, asyncHandler(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    throw new HttpError(400, 'Identificador de nodo inválido.');
  }

  const nodeToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(nodeToken).digest('hex');
  const result = await withTransaction(() =>
    run(
      'UPDATE nodes SET token_hash = ? WHERE id = ? AND owner_user_id = ?',
      [tokenHash, Number(req.params.id), req.user.id],
    ),
  );
  if (!result.changes) {
    throw new HttpError(404, 'No se encontró un nodo tuyo con ese identificador.');
  }

  return res.json({
    message: 'Token de nodo renovado. Guarda el nuevo token; el anterior ya no sirve.',
    nodeToken,
  });
}));

app.post('/api/nodes/heartbeat', asyncHandler(async (req, res) => {
  const tokenHash = getUserToken(req);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const result = await withTransaction(async () => {
    const node = await get(
      `SELECT id, owner_user_id, points, last_heartbeat_at
       FROM nodes WHERE token_hash = ?`,
      [tokenHash],
    );
    if (!node || !node.owner_user_id) {
      throw new HttpError(401, 'Token de nodo inválido o nodo sin propietario.');
    }

    if (!node.last_heartbeat_at) {
      await run('UPDATE nodes SET last_heartbeat_at = ? WHERE id = ?', [nowIso, node.id]);
      const user = await get(
        `SELECT points_today, points_cycle_started_at, gems_balance, payout_balance_microusd
         FROM users WHERE id = ?`,
        [node.owner_user_id],
      );
      if (!user) {
        throw new Error('El propietario del nodo no existe.');
      }
      return {
        pointsAdded: 0,
        pointsForNode: Number(node.points) || 0,
        pointsToday: Number(user.points_today) || 0,
        cycleStartedAt: user.points_cycle_started_at,
        gemsBalance: Number(user.gems_balance) || 0,
        payoutBalanceMicrousd: Number(user.payout_balance_microusd) || 0,
        payoutEarnedMicrousd: 0,
        gemsAdded: 0,
        unlockedMilestones: [],
        baseline: true,
      };
    }

    const lastHeartbeat = Date.parse(node.last_heartbeat_at);
    if (!Number.isFinite(lastHeartbeat) || now <= lastHeartbeat) {
      throw new HttpError(409, 'La hora del heartbeat no es posterior al anterior.');
    }

    const user = await get(
      `SELECT points_today, points_cycle_started_at, gems_balance, payout_balance_microusd
       FROM users WHERE id = ?`,
      [node.owner_user_id],
    );
    if (!user) {
      throw new Error('El propietario del nodo no existe.');
    }

    const cycle = normalizePointCycle(user.points_today, user.points_cycle_started_at, now);
    let pointsToday = cycle.pointsToday;
    let cycleStartedAt = cycle.cycleStartedAt;

    let creditedMs = 0;
    const elapsedMs = now - lastHeartbeat;
    if (elapsedMs <= MAX_HEARTBEAT_GAP_MS) {
      if (cycleStartedAt === null) {
        cycleStartedAt = lastHeartbeat;
      }
      creditedMs = Math.max(0, now - Math.max(lastHeartbeat, cycleStartedAt));
    }

    const potentialPoints = (creditedMs / 60000) * POINTS_PER_MINUTE;
    const pointsAdded = Math.min(
      potentialPoints,
      Math.max(0, DAILY_POINTS_LIMIT - pointsToday),
    );
    const previousPointsToday = pointsToday;
    pointsToday += pointsAdded;
    const milestoneRewards = await awardCrossedMilestones(
      node.owner_user_id,
      previousPointsToday,
      pointsToday,
      Number(user.gems_balance) || 0,
    );
    const payoutEarnedMicrousd = payoutForPoints(pointsAdded);
    const payoutBalanceMicrousd =
      (Number(user.payout_balance_microusd) || 0) + payoutEarnedMicrousd;

    await run(
      `UPDATE users
       SET points_today = ?, points_cycle_started_at = ?, gems_balance = ?,
           payout_balance_microusd = ?
       WHERE id = ?`,
      [
        pointsToday,
        cycleStartedAt === null ? null : new Date(cycleStartedAt).toISOString(),
        milestoneRewards.gemsBalance,
        payoutBalanceMicrousd,
        node.owner_user_id,
      ],
    );
    const nodePoints = (Number(node.points) || 0) + pointsAdded;
    await run(
      'UPDATE nodes SET points = ?, last_heartbeat_at = ? WHERE id = ?',
      [nodePoints, nowIso, node.id],
    );

    return {
      pointsAdded,
      pointsForNode: nodePoints,
      pointsToday,
      cycleStartedAt,
      gemsBalance: milestoneRewards.gemsBalance,
      payoutBalanceMicrousd,
      payoutEarnedMicrousd,
      gemsAdded: milestoneRewards.gemsAdded,
      unlockedMilestones: milestoneRewards.unlockedMilestones,
      baseline: false,
    };
  });

  const cycleStart = result.cycleStartedAt === null
    ? null
    : typeof result.cycleStartedAt === 'number'
      ? result.cycleStartedAt
      : Date.parse(result.cycleStartedAt);

  return res.json({
    success: true,
    pointsAdded: Number(result.pointsAdded.toFixed(6)),
    pointsToday: Number(result.pointsToday.toFixed(6)),
    pointsForNode: Number(result.pointsForNode.toFixed(6)),
    pointsPerMinute: POINTS_PER_MINUTE,
    dailyLimit: DAILY_POINTS_LIMIT,
    gemsBalance: result.gemsBalance,
    payoutBalanceUsd: microUsdToUsd(result.payoutBalanceMicrousd),
    payoutEarnedUsd: microUsdToUsd(result.payoutEarnedMicrousd),
    payoutRateConfigured: USD_PER_DEPIN_POINT !== null,
    gemsAdded: result.gemsAdded,
    unlockedMilestones: result.unlockedMilestones,
    milestones: GEM_MILESTONES,
    nextResetAt: cycleStart === null ? null : new Date(cycleStart + POINTS_CYCLE_MS).toISOString(),
    baseline: result.baseline,
    message: result.baseline
      ? 'Heartbeat inicial registrado; se acreditarán puntos al verificar el siguiente.'
      : 'Heartbeat procesado.',
  });
}));

app.post('/api/roulette/spin', verificarToken, asyncHandler(async (req, res) => {
  const requestId = req.get('idempotency-key');
  if (
    typeof requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
  ) {
    throw new HttpError(400, 'Se requiere un Idempotency-Key UUID válido para el giro.');
  }

  const now = Date.now();
  const result = await withTransaction(async () => {
    const user = await get(
      'SELECT points_today, points_cycle_started_at, gems_balance FROM users WHERE id = ?',
      [req.user.id],
    );
    if (!user) {
      throw new HttpError(404, 'No se encontró la cuenta autenticada.');
    }

    const previousSpin = await get(
      `SELECT request_id, cycle_started_at, random_roll, selected_prize_points,
              points_awarded, points_before, points_after
       FROM roulette_spins WHERE user_id = ? AND request_id = ?`,
      [req.user.id, requestId],
    );
    if (previousSpin) {
      const spinCount = await get(
        'SELECT COUNT(*) AS count FROM roulette_spins WHERE user_id = ? AND cycle_started_at = ?',
        [req.user.id, previousSpin.cycle_started_at],
      );
      const cycle = normalizePointCycle(user.points_today, user.points_cycle_started_at, now);
      return {
        requestId: previousSpin.request_id,
        idempotent: true,
        randomRoll: previousSpin.random_roll,
        selectedPrizePoints: previousSpin.selected_prize_points,
        pointsAdded: previousSpin.points_awarded,
        pointsBefore: previousSpin.points_before,
        pointsToday: cycle.pointsToday,
        gemsBalance: Number(user.gems_balance) || 0,
        gemsAdded: 0,
        unlockedMilestones: [],
        spinsUsed: spinCount.count,
        spinsRemaining: Math.max(0, ROULETTE_SPIN_LIMIT - spinCount.count),
        cycleStartedAt: cycle.cycleStartedAt,
      };
    }

    const cycle = normalizePointCycle(user.points_today, user.points_cycle_started_at, now);
    const cycleStartedAt = cycle.cycleStartedAt ?? now;
    const cycleStartedAtIso = new Date(cycleStartedAt).toISOString();
    const spinCount = await get(
      'SELECT COUNT(*) AS count FROM roulette_spins WHERE user_id = ? AND cycle_started_at = ?',
      [req.user.id, cycleStartedAtIso],
    );
    if (spinCount.count >= ROULETTE_SPIN_LIMIT) {
      throw new HttpError(429, 'Ya usaste los 15 giros disponibles en este ciclo de 24 horas.');
    }

    const pointsRemaining = Math.max(0, DAILY_POINTS_LIMIT - cycle.pointsToday);
    if (pointsRemaining <= 0) {
      throw new HttpError(409, 'Alcanzaste el límite de puntos del ciclo. Espera al reinicio para volver a girar.');
    }

    const randomRoll = crypto.randomInt(1000);
    const selectedPrizePoints = getRoulettePrize(randomRoll);
    const pointsAdded = Math.min(selectedPrizePoints, pointsRemaining);
    const pointsToday = cycle.pointsToday + pointsAdded;
    const milestoneRewards = await awardCrossedMilestones(
      req.user.id,
      cycle.pointsToday,
      pointsToday,
      Number(user.gems_balance) || 0,
    );

    await run(
      `UPDATE users
       SET points_today = ?, points_cycle_started_at = ?, gems_balance = ?
       WHERE id = ?`,
      [pointsToday, cycleStartedAtIso, milestoneRewards.gemsBalance, req.user.id],
    );
    await run(
      `INSERT INTO roulette_spins (
        user_id, request_id, cycle_started_at, random_roll, selected_prize_points,
        points_awarded, points_before, points_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        requestId,
        cycleStartedAtIso,
        randomRoll,
        selectedPrizePoints,
        pointsAdded,
        cycle.pointsToday,
        pointsToday,
      ],
    );

    return {
      requestId,
      idempotent: false,
      randomRoll,
      selectedPrizePoints,
      pointsAdded,
      pointsBefore: cycle.pointsToday,
      pointsToday,
      gemsBalance: milestoneRewards.gemsBalance,
      gemsAdded: milestoneRewards.gemsAdded,
      unlockedMilestones: milestoneRewards.unlockedMilestones,
      spinsUsed: spinCount.count + 1,
      spinsRemaining: ROULETTE_SPIN_LIMIT - spinCount.count - 1,
      cycleStartedAt,
    };
  });

  return res.json({
    success: true,
    ...result,
    pointsToday: Number(result.pointsToday.toFixed(6)),
    dailyLimit: DAILY_POINTS_LIMIT,
    spinLimit: ROULETTE_SPIN_LIMIT,
    prizes: ROULETTE_PRIZES.map((prize) => ({
      points: prize.points,
      probabilityPercent: prize.weight / 10,
    })),
    milestones: GEM_MILESTONES,
  });
}));

app.get('/api/me/wallet', verificarToken, asyncHandler(async (req, res) => {
  const user = await get(
    'SELECT payout_wallet_address FROM users WHERE id = ?',
    [req.user.id],
  );
  if (!user) {
    throw new HttpError(404, 'No se encontró la cuenta autenticada.');
  }
  return res.json({ walletAddress: user.payout_wallet_address || '' });
}));

app.get('/api/me/email', verificarToken, asyncHandler(async (req, res) => {
  const user = await get('SELECT email FROM users WHERE id = ?', [req.user.id]);
  if (!user) {
    throw new HttpError(404, 'No se encontró la cuenta autenticada.');
  }
  return res.json({ email: user.email || '' });
}));

app.put('/api/me/email', verificarToken, asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    throw new HttpError(400, 'Ingresa un correo válido.');
  }
  const normalizedEmail = normalizeEmail(email);
  const existingEmail = await get(
    'SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?',
    [normalizedEmail, req.user.id],
  );
  if (existingEmail) {
    throw new HttpError(409, 'Este correo ya está asociado a otra cuenta.');
  }
  await run('UPDATE users SET email = ? WHERE id = ?', [normalizedEmail, req.user.id]);
  return res.json({ success: true, email: normalizedEmail });
}));

app.put('/api/me/wallet', verificarToken, asyncHandler(async (req, res) => {
  const { walletAddress } = req.body || {};
  if (
    typeof walletAddress !== 'string' ||
    walletAddress.trim().length < 8 ||
    walletAddress.trim().length > 255 ||
    /[\s\u0000-\u001f\u007f]/.test(walletAddress.trim())
  ) {
    throw new HttpError(400, 'Ingresa una dirección de wallet válida (8 a 255 caracteres, sin espacios).');
  }
  await run(
    'UPDATE users SET payout_wallet_address = ? WHERE id = ?',
    [walletAddress.trim(), req.user.id],
  );
  return res.json({ success: true, walletAddress: walletAddress.trim() });
}));

const notifyWithdrawal = async (withdrawal) => {
    try {
        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.ADMIN_EMAIL,
            subject: `Solicitud de retiro Gcoin #${withdrawal.id}`,
            text: `El usuario ${withdrawal.username} solicitó un retiro.\nMonto: $${microUsdToUsd(withdrawal.amountMicrousd).toFixed(2)} USD,\nEstado: pendiente de revisión y pago manual.`,
        });
        await run(
            'UPDATE withdrawal_requests SET notification_status = ?, notification_error = NULL, notified_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
            ['SENT', withdrawal.id, withdrawal.userId]
        );
        return true;
    } catch (error) {
        console.error("No se pudo notificar la solicitud de retiro:", error);
        await run(
            'UPDATE withdrawal_requests SET notification_status = ?, notification_error = ? WHERE id = ? AND user_id = ?',
            ['FAILED', typeof error.code === 'string' ? error.code : 'SMTP_SEND_FAILED', withdrawal.id, withdrawal.userId]
        );
        return false;
    }
};
app.get('/api/me/withdrawals', verificarToken, asyncHandler(async (req, res) => {
  const requests = await all(
    `SELECT id, amount_microusd, wallet_snapshot, status, notification_status,
            created_at, notified_at
     FROM withdrawal_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
    [req.user.id],
  );
  return res.json({
    withdrawals: requests.map((request) => ({
      id: request.id,
      amountUsd: microUsdToUsd(request.amount_microusd),
      walletAddress: request.wallet_snapshot,
      status: request.status,
      notificationStatus: request.notification_status,
      createdAt: request.created_at,
      notifiedAt: request.notified_at,
    })),
  });
}));

app.post('/api/me/withdrawals', verificarToken, asyncHandler(async (req, res) => {
  if (USD_PER_DEPIN_POINT === null) {
    throw new HttpError(503, 'Los retiros están deshabilitados: el servidor aún no tiene una conversión USD por punto DePIN configurada.');
  }
  if (!SMTP_TRANSPORT) {
    throw new HttpError(503, 'Los retiros están temporalmente deshabilitados: falta configurar el correo SMTP de administración.');
  }

  const withdrawal = await withTransaction(async () => {
    const user = await get(
      `SELECT id, username, payout_wallet_address, payout_balance_microusd
       FROM users WHERE id = ?`,
      [req.user.id],
    );
    if (!user) {
      throw new HttpError(404, 'No se encontró la cuenta autenticada.');
    }
    if (!user.payout_wallet_address) {
      throw new HttpError(400, 'Guarda tu wallet antes de solicitar un retiro.');
    }
    const existing = await get(
      `SELECT id FROM withdrawal_requests
       WHERE user_id = ? AND status = 'PENDING' LIMIT 1`,
      [req.user.id],
    );
    if (existing) {
      throw new HttpError(409, 'Ya tienes una solicitud pendiente de revisión.');
    }
    const amountMicrousd = Number(user.payout_balance_microusd) || 0;
    if (amountMicrousd < WITHDRAWAL_MINIMUM_MICRO_USD) {
      throw new HttpError(400, 'El saldo disponible mínimo para retirar es $5.00 USD.');
    }

    const created = await run(
      `INSERT INTO withdrawal_requests (user_id, amount_microusd, wallet_snapshot)
       VALUES (?, ?, ?)`,
      [req.user.id, amountMicrousd, user.payout_wallet_address],
    );
    await run(
      'UPDATE users SET payout_balance_microusd = 0 WHERE id = ?',
      [req.user.id],
    );
    return {
      id: created.lastID,
      userId: user.id,
      username: user.username,
      walletAddress: user.payout_wallet_address,
      amountMicrousd,
    };
  });

  const notificationSent = await notifyWithdrawal(withdrawal);
  return res.status(202).json({
    success: true,
    withdrawal: {
      id: withdrawal.id,
      amountUsd: microUsdToUsd(withdrawal.amountMicrousd),
      status: 'PENDING',
      notificationStatus: notificationSent ? 'SENT' : 'FAILED',
    },
    notificationSent,
    message: notificationSent
      ? 'Solicitud guardada y enviada para revisión manual. El envío del correo no significa que el pago se haya realizado.'
      : 'La solicitud quedó guardada y el saldo reservado, pero falló el aviso por correo. Usa “Reintentar aviso” para volver a notificar; no repitas la solicitud.',
  });
}));

app.post('/api/me/withdrawals/:id/notify', verificarToken, asyncHandler(async (req, res) => {
  if (!SMTP_TRANSPORT) {
    throw new HttpError(503, 'El correo SMTP de administración no está configurado.');
  }
  if (!/^\d+$/.test(req.params.id)) {
    throw new HttpError(400, 'Identificador de solicitud inválido.');
  }
  const withdrawal = await get(
    `SELECT wr.id, wr.user_id, wr.amount_microusd, wr.wallet_snapshot, u.username
     FROM withdrawal_requests wr
     JOIN users u ON u.id = wr.user_id
     WHERE wr.id = ? AND wr.user_id = ? AND wr.status = 'PENDING'`,
    [Number(req.params.id), req.user.id],
  );
  if (!withdrawal) {
    throw new HttpError(404, 'No se encontró una solicitud pendiente de tu cuenta.');
  }
  const notificationSent = await notifyWithdrawal({
    id: withdrawal.id,
    userId: withdrawal.user_id,
    username: withdrawal.username,
    amountMicrousd: withdrawal.amount_microusd,
    walletAddress: withdrawal.wallet_snapshot,
  });
  if (!notificationSent) {
    throw new HttpError(502, 'No se pudo enviar el correo. La solicitud y el saldo reservado permanecen sin cambios.');
  }
  return res.json({ success: true, message: 'Aviso enviado. La solicitud sigue pendiente de revisión y pago manual.' });
}));

app.get('/api/me/points', verificarToken, asyncHandler(async (req, res) => {
  const user = await get(
    `SELECT points_today, points_cycle_started_at, gems_balance, payout_balance_microusd
     FROM users WHERE id = ?`,
    [req.user.id],
  );
  if (!user) {
    throw new HttpError(404, 'No se encontró la cuenta autenticada.');
  }

  const cycle = normalizePointCycle(
    user.points_today,
    user.points_cycle_started_at,
    Date.now(),
  );

  const totals = await get(
    'SELECT COALESCE(SUM(points), 0) AS pointsTotal FROM nodes WHERE owner_user_id = ?',
    [req.user.id],
  );
  const networkStats = await get(
    `SELECT
       COALESCE(SUM(points), 0) AS pointsTotal,
       COUNT(*) AS nodeCount,
       (SELECT COUNT(*) FROM users) AS userCount
     FROM nodes`,
  );
  const earnedMilestones = await all(
    'SELECT milestone_points, gems_awarded, achieved_at FROM gem_milestones WHERE user_id = ?',
    [req.user.id],
  );
  const earnedByPoints = new Map(
    earnedMilestones.map((milestone) => [milestone.milestone_points, milestone]),
  );
  const cycleStartedAtIso = cycle.cycleStartedAt === null
    ? null
    : new Date(cycle.cycleStartedAt).toISOString();
  const spinCount = cycleStartedAtIso === null
    ? { count: 0 }
    : await get(
      'SELECT COUNT(*) AS count FROM roulette_spins WHERE user_id = ? AND cycle_started_at = ?',
      [req.user.id, cycleStartedAtIso],
    );
  return res.json({
    pointsToday: Number(cycle.pointsToday.toFixed(6)),
    pointsTotal: Number((Number(totals.pointsTotal) || 0).toFixed(6)),
    networkStats: {
      pointsTotal: Number((Number(networkStats.pointsTotal) || 0).toFixed(6)),
      nodeCount: Number(networkStats.nodeCount) || 0,
      userCount: Number(networkStats.userCount) || 0,
      source: 'depin-node-lifetime',
    },
    dailyLimit: DAILY_POINTS_LIMIT,
    pointsPerMinute: POINTS_PER_MINUTE,
    rouletteSpinLimit: ROULETTE_SPIN_LIMIT,
    rouletteSpinsUsed: spinCount.count,
    rouletteSpinsRemaining: Math.max(0, ROULETTE_SPIN_LIMIT - spinCount.count),
    roulettePrizes: ROULETTE_PRIZES.map((prize) => ({
      points: prize.points,
      probabilityPercent: prize.weight / 10,
    })),
    gemsBalance: Number(user.gems_balance) || 0,
    payoutBalanceUsd: microUsdToUsd(user.payout_balance_microusd),
    payoutRateConfigured: USD_PER_DEPIN_POINT !== null,
    payoutRateUsdPerPoint: USD_PER_DEPIN_POINT === null
      ? null
      : microUsdToUsd(USD_PER_DEPIN_POINT),
    milestones: GEM_MILESTONES.map((milestone) => ({
      ...milestone,
      claimed: earnedByPoints.has(milestone.points),
      achievedAt: earnedByPoints.get(milestone.points)?.achieved_at || null,
    })),
    cycleStartedAt: cycleStartedAtIso,
    nextResetAt: cycle.cycleStartedAt === null
      ? null
      : new Date(cycle.cycleStartedAt + POINTS_CYCLE_MS).toISOString(),
  });
}));

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la solicitud no contiene JSON válido.' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }

  if (err.code === 'SQLITE_CONSTRAINT') {
    return res.status(409).json({ error: 'El usuario, correo o nodo ya se encuentra registrado.' });
  }

  console.error('Error al procesar la solicitud:', err.message);
  return res.status(500).json({ error: 'Error interno del servidor.' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor de Gcoin Guaraní corriendo en el puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err.message);
    db.close();
    process.exitCode = 1;
  });
