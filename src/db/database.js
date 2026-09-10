const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/clinic.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);

// Enable WAL mode & foreign keys for robust concurrency
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_code TEXT UNIQUE NOT NULL,
    patient_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT DEFAULT '',
    consultation_type TEXT NOT NULL,
    preferred_date TEXT DEFAULT '',
    preferred_time_slot TEXT DEFAULT '',
    health_concern TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'completed', 'cancelled')),
    doctor_notes TEXT DEFAULT '',
    approval_token TEXT UNIQUE,
    confirmed_date TEXT DEFAULT '',
    confirmed_time TEXT DEFAULT '',
    meeting_link TEXT DEFAULT '',
    whatsapp_sent_at TEXT DEFAULT '',
    email_sent_at TEXT DEFAULT '',
    is_phone_verified INTEGER DEFAULT 1,
    notification_logs TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT DEFAULT 'physician',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS clinic_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS otp_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    verified INTEGER DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// Migration helper for existing databases: ensure new columns exist
try {
  const existingCols = db.prepare('PRAGMA table_info(appointments)').all().map(c => c.name);
  const newCols = [
    { name: 'approval_token', def: 'TEXT' },
    { name: 'confirmed_date', def: "TEXT DEFAULT ''" },
    { name: 'confirmed_time', def: "TEXT DEFAULT ''" },
    { name: 'meeting_link', def: "TEXT DEFAULT ''" },
    { name: 'whatsapp_sent_at', def: "TEXT DEFAULT ''" },
    { name: 'email_sent_at', def: "TEXT DEFAULT ''" },
    { name: 'is_phone_verified', def: "INTEGER DEFAULT 1" },
    { name: 'notification_logs', def: "TEXT DEFAULT '[]'" }
  ];

  for (const col of newCols) {
    if (!existingCols.includes(col.name)) {
      db.exec(`ALTER TABLE appointments ADD COLUMN ${col.name} ${col.def};`);
    }
  }
} catch (e) {
  console.warn('Column migration notice:', e.message);
}

// Password / OTP hashing helpers using PBKDF2
function hashPassword(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const calculated = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculated, 'hex'));
}

module.exports = {
  db,
  hashPassword,
  verifyPassword
};
