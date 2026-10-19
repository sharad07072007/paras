const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();

// Attempt to load existing SQLite fallback for offline development / zero-config boot
let sqliteDb = null;
try {
  const { db } = require('./database');
  sqliteDb = db;
} catch (e) {
  // SQLite might be optional or in-memory
}

/**
 * Configure Google Cloud Firestore credentials
 * Supports:
 * 1. FIREBASE_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS_JSON (raw JSON or Base64)
 * 2. GCP_PROJECT_ID + GCP_CLIENT_EMAIL + GCP_PRIVATE_KEY
 * 3. GOOGLE_APPLICATION_CREDENTIALS (file path)
 * 4. FIRESTORE_EMULATOR_HOST (local emulator)
 * 5. Google Application Default Credentials (ADC)
 */
let firestoreInstance = null;
let isFirestoreConnected = false;
let firestoreInitError = null;

function initFirestore() {
  if (firestoreInstance) return firestoreInstance;

  const options = {};

  // Check for raw or base64 JSON service account key
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
                             process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
                             process.env.GCP_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson && typeof serviceAccountJson === 'string') {
    try {
      let raw = serviceAccountJson.trim();
      if (!raw.startsWith('{') && !raw.startsWith('[')) {
        raw = Buffer.from(raw, 'base64').toString('utf8');
      }
      const parsed = JSON.parse(raw);
      options.projectId = parsed.project_id || process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
      options.credentials = {
        client_email: parsed.client_email,
        private_key: parsed.private_key
      };
      console.log(`[Firestore] Loaded credentials for service account: ${parsed.client_email} (Project: ${options.projectId})`);
    } catch (err) {
      console.warn('[Firestore] Failed to parse service account JSON from environment:', err.message);
    }
  } else if (process.env.GCP_PRIVATE_KEY && (process.env.GCP_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL)) {
    options.projectId = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    options.credentials = {
      client_email: process.env.GCP_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL,
      private_key: (process.env.GCP_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n')
    };
    console.log(`[Firestore] Loaded credentials from GCP_CLIENT_EMAIL & GCP_PRIVATE_KEY (Project: ${options.projectId})`);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credPath = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      ? process.env.GOOGLE_APPLICATION_CREDENTIALS
      : path.join(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (fs.existsSync(credPath)) {
      options.keyFilename = credPath;
      console.log(`[Firestore] Loaded credentials from file: ${credPath}`);
    } else {
      console.warn(`[Firestore] Warning: Credentials file not found at ${credPath}`);
    }
  }

  // Project ID override
  if (!options.projectId) {
    const projId = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (projId) {
      options.projectId = projId;
    }
  }

  // Database ID override (e.g. 'my-clinic-db' or '(default)')
  const dbId = process.env.FIRESTORE_DATABASE_ID || process.env.GCP_DATABASE_ID || 'my-clinic-db';
  if (dbId) {
    options.databaseId = dbId;
  }

  try {
    firestoreInstance = new Firestore(options);
    console.log(`[Firestore] Initialized Google Cloud Firestore client. (Project: ${options.projectId || 'Default ADC / Local'}, Database: ${options.databaseId || '(default)'})`);
  } catch (err) {
    firestoreInitError = err;
    console.error('[Firestore] Initialization error:', err.message);
  }

  return firestoreInstance;
}

// Instantiate on module load
initFirestore();

// Helper to sanitize Firestore documents
function docToData(doc) {
  if (!doc.exists) return null;
  const data = doc.data();
  // Ensure id is attached
  return {
    id: doc.id,
    ...data
  };
}

// Password hashing helpers
function hashPassword(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const calculated = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculated, 'hex'));
}

/**
 * Sanitize a patient/reviewer name and append a unique timestamp or code
 * Removes invalid Firestore path characters (/, ., #, $, [, ], etc.)
 */
function generateCustomDocId(name, suffix = null) {
  const safeName = (name || 'Anonymous')
    .normalize('NFKD')
    .replace(/[/\\.#$\[\]?*]/g, '') // remove invalid Firestore path characters
    .replace(/[^a-zA-Z0-9_\-]/g, '_') // convert spaces/symbols to underscores
    .replace(/_+/g, '_') // collapse multiple underscores
    .replace(/^_+|_+$/g, ''); // trim leading/trailing underscores

  const fallback = safeName.length > 0 ? safeName : 'Patient';

  let uniquePart = suffix;
  if (!uniquePart) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const rand = Math.floor(100 + Math.random() * 900);
    uniquePart = `${dateStr}_${timeStr}_${rand}`;
  }

  return `${fallback}_${uniquePart}`.slice(0, 100);
}

// Collections references
function reviewsCol() {
  return firestoreInstance.collection('reviews');
}

function appointmentsCol() {
  return firestoreInstance.collection('appointments');
}

function adminUsersCol() {
  return firestoreInstance.collection('admin_users');
}

function clinicProfileCol() {
  return firestoreInstance.collection('clinic_profile');
}

// ==========================================
// REVIEWS DATA ACCESS METHODS
// ==========================================

/**
 * Save new review permanently to Firestore
 */
async function createReview(data) {
  const timestamp = new Date().toISOString();
  const reviewerName = (data.reviewer_name || data.name || data.patient_name || '').trim();
  const rating = parseInt(data.rating, 10) || 5;
  const comment = (data.comment || data.review_text || '').trim();
  const email = (data.patient_email || data.email || '').trim().toLowerCase();
  const category = (data.treatment_category || data.category || 'General Ayurvedic Consultation').trim();

  const reviewDoc = {
    reviewer_name: reviewerName,
    name: reviewerName,
    patient_name: reviewerName,
    rating: rating,
    comment: comment,
    review_text: comment,
    patient_email: email,
    email: email,
    treatment_category: category,
    category: category,
    is_approved: data.is_approved !== undefined ? Boolean(data.is_approved) : true,
    timestamp: timestamp,
    created_at: timestamp
  };

  const docId = generateCustomDocId(reviewerName);

  try {
    const docRef = reviewsCol().doc(docId);
    await docRef.set(reviewDoc);
    const saved = { id: docRef.id, ...reviewDoc };

    // Also mirror to SQLite if available so both stores are synced
    if (sqliteDb) {
      try {
        sqliteDb.prepare(`
          INSERT INTO patient_reviews (patient_name, patient_email, rating, treatment_category, review_text, is_approved, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(reviewerName, email, rating, category, comment, timestamp);
      } catch (e) {
        // ignore SQLite mirror errors
      }
    }

    return saved;
  } catch (firestoreError) {
    console.warn('[Firestore] Warning: Could not write to remote Firestore (' + firestoreError.message + '). Writing to local permanent storage.');
    if (sqliteDb) {
      const res = sqliteDb.prepare(`
        INSERT INTO patient_reviews (patient_name, patient_email, rating, treatment_category, review_text, is_approved, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(reviewerName, email, rating, category, comment, timestamp);
      return { id: String(res.lastInsertRowid), ...reviewDoc };
    }
    throw firestoreError;
  }
}

/**
 * Get all reviews ordered by creation date / timestamp
 */
async function getAllReviews() {
  try {
    const snapshot = await reviewsCol().orderBy('timestamp', 'desc').get();
    const reviews = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      reviews.push({
        id: doc.id,
        reviewer_name: d.reviewer_name || d.patient_name || d.name || 'Verified Patient',
        patient_name: d.patient_name || d.reviewer_name || d.name || 'Verified Patient',
        name: d.name || d.reviewer_name || d.patient_name || 'Verified Patient',
        rating: Number(d.rating) || 5,
        comment: d.comment || d.review_text || '',
        review_text: d.review_text || d.comment || '',
        treatment_category: d.treatment_category || d.category || 'General Ayurvedic Consultation',
        category: d.category || d.treatment_category || 'General Ayurvedic Consultation',
        patient_email: d.patient_email || d.email || '',
        email: d.email || d.patient_email || '',
        is_approved: d.is_approved !== false,
        timestamp: d.timestamp || d.created_at || new Date().toISOString(),
        created_at: d.created_at || d.timestamp || new Date().toISOString()
      });
    });

    // Compute stats
    const stats = calculateReviewStats(reviews);
    return { reviews, stats };
  } catch (firestoreError) {
    console.warn('[Firestore] Notice: Remote Firestore read fallback (' + firestoreError.message + '). Using local permanent storage.');
    if (sqliteDb) {
      const rows = sqliteDb.prepare(`
        SELECT id, patient_name, patient_email, rating, treatment_category, review_text, is_approved, created_at
        FROM patient_reviews
        WHERE is_approved = 1
        ORDER BY id DESC
      `).all();

      const reviews = rows.map(r => ({
        id: String(r.id),
        reviewer_name: r.patient_name,
        patient_name: r.patient_name,
        name: r.patient_name,
        rating: r.rating,
        comment: r.review_text,
        review_text: r.review_text,
        treatment_category: r.treatment_category,
        category: r.treatment_category,
        patient_email: r.patient_email,
        email: r.patient_email,
        is_approved: true,
        timestamp: r.created_at,
        created_at: r.created_at
      }));

      const stats = calculateReviewStats(reviews);
      return { reviews, stats };
    }
    return { reviews: [], stats: { total: 0, average: 5.0, five_stars: 0, four_stars: 0, three_stars: 0, low_stars: 0 } };
  }
}

function calculateReviewStats(reviews) {
  const total = reviews.length;
  if (total === 0) {
    return { total: 0, average: 5.0, five_stars: 0, four_stars: 0, three_stars: 0, low_stars: 0 };
  }

  let sum = 0;
  let fiveStars = 0;
  let fourStars = 0;
  let threeStars = 0;
  let lowStars = 0;

  for (const r of reviews) {
    const rate = Number(r.rating) || 5;
    sum += rate;
    if (rate >= 5) fiveStars++;
    else if (rate === 4) fourStars++;
    else if (rate === 3) threeStars++;
    else lowStars++;
  }

  const average = parseFloat((sum / total).toFixed(1));
  return {
    total,
    average,
    five_stars: fiveStars,
    four_stars: fourStars,
    three_stars: threeStars,
    low_stars: lowStars
  };
}

// ==========================================
// APPOINTMENTS DATA ACCESS METHODS
// ==========================================

function generateReferenceCode() {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  const year = new Date().getFullYear();
  return `AYU-${year}-${randomNum}`;
}

/**
 * Save new appointment permanently to Firestore
 */
async function createAppointment(data) {
  const now = new Date().toISOString();
  const refCode = data.reference_code || generateReferenceCode();
  const approvalToken = data.approval_token || crypto.randomBytes(24).toString('hex');
  const consultationType = data.consultation_type || data.mode || 'In-clinic visit';
  const meetingLink = consultationType.includes('Online')
    ? (data.meeting_link || `https://meet.google.com/ayur-${refCode.toLowerCase().replace(/[^a-z0-9]/g, '-')}`)
    : '';

  const appointmentDoc = {
    reference_code: refCode,
    patient_name: (data.patient_name || data.name || '').trim(),
    phone: (data.phone || '').trim(),
    email: (data.email || '').trim().toLowerCase(),
    consultation_type: consultationType,
    preferred_date: data.preferred_date || 'Earliest available',
    preferred_time_slot: data.preferred_time_slot || data.preferred_time || 'Morning (10:00 AM - 01:00 PM)',
    health_concern: (data.health_concern || data.concern || '').trim(),
    status: 'pending',
    doctor_notes: data.doctor_notes || '',
    approval_token: approvalToken,
    meeting_link: meetingLink,
    confirmed_date: '',
    confirmed_time: '',
    confirmed_timestamp: null,
    confirmed_at: null,
    whatsapp_sent_at: '',
    email_sent_at: '',
    created_at: now,
    timestamp: now,
    updated_at: now
  };

  const patientName = (data.patient_name || data.name || '').trim();
  const docId = generateCustomDocId(patientName, refCode.replace(/[^a-zA-Z0-9_\-]/g, ''));

  try {
    const docRef = appointmentsCol().doc(docId);
    await docRef.set(appointmentDoc);
    const saved = { id: docRef.id, ...appointmentDoc };

    // Mirror to SQLite if available
    if (sqliteDb) {
      try {
        const res = sqliteDb.prepare(`
          INSERT INTO appointments (
            reference_code, patient_name, phone, email, consultation_type,
            preferred_date, preferred_time_slot, health_concern, status,
            doctor_notes, approval_token, meeting_link, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?)
        `).run(
          refCode,
          saved.patient_name,
          saved.phone,
          saved.email,
          saved.consultation_type,
          saved.preferred_date,
          saved.preferred_time_slot,
          saved.health_concern,
          approvalToken,
          meetingLink,
          now
        );
        saved.numeric_id = res.lastInsertRowid;
      } catch (e) {
        // ignore
      }
    }

    return saved;
  } catch (firestoreError) {
    console.warn('[Firestore] Notice: Remote Firestore write fallback (' + firestoreError.message + '). Writing to local permanent storage.');
    if (sqliteDb) {
      const res = sqliteDb.prepare(`
        INSERT INTO appointments (
          reference_code, patient_name, phone, email, consultation_type,
          preferred_date, preferred_time_slot, health_concern, status,
          doctor_notes, approval_token, meeting_link, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?)
      `).run(
        refCode,
        appointmentDoc.patient_name,
        appointmentDoc.phone,
        appointmentDoc.email,
        appointmentDoc.consultation_type,
        appointmentDoc.preferred_date,
        appointmentDoc.preferred_time_slot,
        appointmentDoc.health_concern,
        approvalToken,
        meetingLink,
        now
      );
      return { ...appointmentDoc, id: res.lastInsertRowid, numeric_id: res.lastInsertRowid };
    }
    throw firestoreError;
  }
}

/**
 * Fetch only appointments where status is 'pending'
 */
async function getPendingAppointments() {
  try {
    const snapshot = await appointmentsCol()
      .where('status', '==', 'pending')
      .get();

    const pending = [];
    snapshot.forEach(doc => {
      pending.push({ id: doc.id, ...doc.data() });
    });

    // Sort descending by created_at in memory
    pending.sort((a, b) => new Date(b.created_at || b.timestamp || 0) - new Date(a.created_at || a.timestamp || 0));
    return pending;
  } catch (firestoreError) {
    console.warn('[Firestore] Notice: Remote Firestore pending query fallback (' + firestoreError.message + '). Using local permanent storage.');
    if (sqliteDb) {
      const rows = sqliteDb.prepare(`
        SELECT * FROM appointments WHERE status = 'pending' ORDER BY id DESC
      `).all();
      return rows.map(r => ({ id: String(r.id), ...r }));
    }
    return [];
  }
}

/**
 * Find an appointment document reference or ID in Firestore
 */
async function resolveAppointmentDoc(identifier) {
  if (!identifier) return null;
  const strId = String(identifier).trim();

  // Try direct doc ID
  try {
    const docRef = appointmentsCol().doc(strId);
    const snap = await docRef.get();
    if (snap.exists) {
      return { docRef, id: snap.id, data: snap.data() };
    }
  } catch (e) {
    // Might not be a valid doc id format, continue to search
  }

  // Try reference_code
  try {
    const snap = await appointmentsCol().where('reference_code', '==', strId.toUpperCase()).limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { docRef: doc.ref, id: doc.id, data: doc.data() };
    }
  } catch (e) {
    // continue
  }

  // Try numeric id field if present
  const num = parseInt(strId, 10);
  if (!isNaN(num)) {
    try {
      const snap = await appointmentsCol().where('numeric_id', '==', num).limit(1).get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        return { docRef: doc.ref, id: doc.id, data: doc.data() };
      }
    } catch (e) {
      // continue
    }
  }

  return null;
}

/**
 * Confirm an appointment:
 * Updates status to 'confirmed', adds confirmed_timestamp, and updates confirmed date/time.
 * Removes it effectively from the active pending queue while retaining it permanently in Firestore!
 */
async function confirmAppointment(identifier, extraData = {}) {
  const now = new Date().toISOString();
  const confirmedTimestamp = now;

  const updatePayload = {
    status: 'confirmed',
    confirmed_timestamp: confirmedTimestamp,
    confirmed_at: confirmedTimestamp,
    updated_at: now
  };

  if (extraData.confirmed_date) updatePayload.confirmed_date = extraData.confirmed_date;
  if (extraData.confirmed_time) updatePayload.confirmed_time = extraData.confirmed_time;
  if (extraData.meeting_link) updatePayload.meeting_link = extraData.meeting_link;
  if (extraData.doctor_notes) updatePayload.doctor_notes = extraData.doctor_notes;

  try {
    const resolved = await resolveAppointmentDoc(identifier);
    if (resolved) {
      await resolved.docRef.update(updatePayload);
      const updatedSnap = await resolved.docRef.get();
      const updatedRecord = { id: updatedSnap.id, ...updatedSnap.data() };

      // Mirror to SQLite
      if (sqliteDb) {
        try {
          sqliteDb.prepare(`
            UPDATE appointments
            SET status = 'confirmed',
                confirmed_date = COALESCE(?, confirmed_date),
                confirmed_time = COALESCE(?, confirmed_time),
                doctor_notes = COALESCE(?, doctor_notes),
                updated_at = ?
            WHERE id = ? OR reference_code = ?
          `).run(
            extraData.confirmed_date || null,
            extraData.confirmed_time || null,
            extraData.doctor_notes || null,
            now,
            parseInt(identifier, 10) || 0,
            String(identifier)
          );
        } catch (e) {
          // ignore
        }
      }

      return updatedRecord;
    }
  } catch (firestoreError) {
    console.warn('[Firestore] Notice: Remote Firestore confirm update fallback (' + firestoreError.message + '). Using local permanent storage.');
  }

  // SQLite fallback
  if (sqliteDb) {
    const existing = sqliteDb.prepare(`
      SELECT * FROM appointments WHERE id = ? OR UPPER(reference_code) = UPPER(?)
    `).get(parseInt(identifier, 10) || 0, String(identifier));

    if (!existing) return null;

    const confDate = extraData.confirmed_date || existing.preferred_date || now.slice(0, 10);
    const confTime = extraData.confirmed_time || existing.preferred_time_slot || 'Morning (10:00 AM – 01:00 PM)';
    const notes = extraData.doctor_notes !== undefined ? extraData.doctor_notes : existing.doctor_notes;

    sqliteDb.prepare(`
      UPDATE appointments
      SET status = 'confirmed',
          confirmed_date = ?,
          confirmed_time = ?,
          doctor_notes = ?,
          updated_at = ?
      WHERE id = ?
    `).run(confDate, confTime, notes, now, existing.id);

    const updated = sqliteDb.prepare('SELECT * FROM appointments WHERE id = ?').get(existing.id);
    return {
      id: String(updated.id),
      ...updated,
      confirmed_timestamp: confirmedTimestamp
    };
  }

  return null;
}

/**
 * Get appointment by ID or Reference Code
 */
async function getAppointmentById(identifier) {
  try {
    const resolved = await resolveAppointmentDoc(identifier);
    if (resolved) {
      return { id: resolved.id, ...resolved.data };
    }
  } catch (firestoreError) {
    console.warn('[Firestore] Read error:', firestoreError.message);
  }

  if (sqliteDb) {
    const row = sqliteDb.prepare(`
      SELECT * FROM appointments WHERE id = ? OR UPPER(reference_code) = UPPER(?)
    `).get(parseInt(identifier, 10) || 0, String(identifier));
    if (row) return { ...row, id: row.id, numeric_id: row.id };
  }

  return null;
}

/**
 * Track appointment by Reference Code or Phone
 */
async function getAppointmentByReferenceOrPhone(query) {
  const clean = String(query || '').trim();
  if (!clean) return null;
  const cleanPhone = clean.replace(/\D/g, '').slice(-10);

  try {
    // Try reference_code
    const snapRef = await appointmentsCol().where('reference_code', '==', clean.toUpperCase()).limit(1).get();
    if (!snapRef.empty) {
      const doc = snapRef.docs[0];
      return { id: doc.id, ...doc.data() };
    }

    // Try exact phone
    const snapPhone = await appointmentsCol().where('phone', '==', clean).limit(1).get();
    if (!snapPhone.empty) {
      const doc = snapPhone.docs[0];
      return { id: doc.id, ...doc.data() };
    }

    // Scan for 10-digit phone match
    if (cleanPhone.length === 10) {
      const allSnap = await appointmentsCol().limit(200).get();
      for (const doc of allSnap.docs) {
        const p = (doc.data().phone || '').replace(/\D/g, '');
        if (p.endsWith(cleanPhone)) {
          return { id: doc.id, ...doc.data() };
        }
      }
    }
  } catch (firestoreError) {
    console.warn('[Firestore] Track error:', firestoreError.message);
  }

  if (sqliteDb) {
    const row = sqliteDb.prepare(`
      SELECT * FROM appointments
      WHERE UPPER(reference_code) = UPPER(?)
         OR phone = ?
         OR (length(?) = 10 AND (phone LIKE '%' || ? OR replace(phone, ' ', '') LIKE '%' || ?))
      ORDER BY id DESC
      LIMIT 1
    `).get(clean, clean, cleanPhone, cleanPhone, cleanPhone);
    if (row) return { id: String(row.id), ...row };
  }

  return null;
}

/**
 * Update arbitrary appointment fields (for PATCH /api/admin/appointments/:id)
 */
async function updateAppointment(identifier, fields) {
  const now = new Date().toISOString();
  const updateData = { ...fields, updated_at: now };

  try {
    const resolved = await resolveAppointmentDoc(identifier);
    if (resolved) {
      await resolved.docRef.update(updateData);
      const snap = await resolved.docRef.get();
      const updated = { id: snap.id, ...snap.data() };

      if (sqliteDb) {
        try {
          if (fields.status) {
            sqliteDb.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ? OR reference_code = ?")
              .run(fields.status, now, parseInt(identifier, 10) || 0, String(identifier));
          }
        } catch (e) {
          // ignore
        }
      }

      return updated;
    }
  } catch (firestoreError) {
    console.warn('[Firestore] Update error:', firestoreError.message);
  }

  if (sqliteDb) {
    const existing = sqliteDb.prepare('SELECT * FROM appointments WHERE id = ? OR reference_code = ?')
      .get(parseInt(identifier, 10) || 0, String(identifier));
    if (!existing) return null;

    const status = fields.status || existing.status;
    const notes = fields.doctor_notes !== undefined ? fields.doctor_notes : existing.doctor_notes;
    const prefDate = fields.preferred_date !== undefined ? fields.preferred_date : existing.preferred_date;
    const prefTime = fields.preferred_time_slot !== undefined ? fields.preferred_time_slot : existing.preferred_time_slot;
    const confDate = fields.confirmed_date !== undefined ? fields.confirmed_date : existing.confirmed_date;
    const confTime = fields.confirmed_time !== undefined ? fields.confirmed_time : existing.confirmed_time;
    const meetingLink = fields.meeting_link !== undefined ? fields.meeting_link : existing.meeting_link;

    sqliteDb.prepare(`
      UPDATE appointments
      SET status = ?, doctor_notes = ?, preferred_date = ?, preferred_time_slot = ?,
          confirmed_date = ?, confirmed_time = ?, meeting_link = ?, updated_at = ?
      WHERE id = ?
    `).run(status, notes, prefDate, prefTime, confDate, confTime, meetingLink, now, existing.id);

    const updated = sqliteDb.prepare('SELECT * FROM appointments WHERE id = ?').get(existing.id);
    return { id: String(updated.id), ...updated };
  }

  return null;
}

/**
 * Delete an appointment permanently
 */
async function deleteAppointment(identifier) {
  try {
    const resolved = await resolveAppointmentDoc(identifier);
    if (resolved) {
      await resolved.docRef.delete();
      if (sqliteDb) {
        try {
          sqliteDb.prepare('DELETE FROM appointments WHERE id = ? OR reference_code = ?')
            .run(parseInt(identifier, 10) || 0, String(identifier));
        } catch (e) {
          // ignore
        }
      }
      return true;
    }
  } catch (firestoreError) {
    console.warn('[Firestore] Delete error:', firestoreError.message);
  }

  if (sqliteDb) {
    const res = sqliteDb.prepare('DELETE FROM appointments WHERE id = ? OR reference_code = ?')
      .run(parseInt(identifier, 10) || 0, String(identifier));
    return res.changes > 0;
  }

  return false;
}

/**
 * List appointments with search, filter, and pagination
 */
async function listAppointments({ status, search, type, limit = 100, offset = 0 } = {}) {
  try {
    let query = appointmentsCol();
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }
    if (type && type !== 'all') {
      query = query.where('consultation_type', '==', type);
    }

    const snap = await query.get();
    let records = [];
    snap.forEach(doc => {
      records.push({ id: doc.id, ...doc.data() });
    });

    // In-memory search filtering if specified
    if (search && search.trim()) {
      const term = search.trim().toLowerCase();
      records = records.filter(r =>
        (r.patient_name && r.patient_name.toLowerCase().includes(term)) ||
        (r.phone && r.phone.toLowerCase().includes(term)) ||
        (r.reference_code && r.reference_code.toLowerCase().includes(term)) ||
        (r.health_concern && r.health_concern.toLowerCase().includes(term)) ||
        (String(r.id) === term)
      );
    }

    // Sort descending by created_at / timestamp
    records.sort((a, b) => new Date(b.created_at || b.timestamp || 0) - new Date(a.created_at || a.timestamp || 0));

    // Pagination
    const paginated = records.slice(offset, offset + limit);
    return { count: records.length, appointments: paginated };
  } catch (firestoreError) {
    console.warn('[Firestore] List error fallback (' + firestoreError.message + ').');
    if (sqliteDb) {
      let q = 'SELECT * FROM appointments WHERE 1=1';
      const params = [];
      if (status && status !== 'all') {
        q += ' AND status = ?';
        params.push(status);
      }
      if (type && type !== 'all') {
        q += ' AND consultation_type = ?';
        params.push(type);
      }
      if (search && search.trim()) {
        const term = `%${search.trim()}%`;
        q += ' AND (id = ? OR patient_name LIKE ? OR phone LIKE ? OR reference_code LIKE ? OR health_concern LIKE ?)';
        params.push(parseInt(search.trim(), 10) || 0, term, term, term, term);
      }
      q += ' ORDER BY id DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = sqliteDb.prepare(q).all(...params);
      return { count: rows.length, appointments: rows.map(r => ({ id: String(r.id), ...r })) };
    }
    return { count: 0, appointments: [] };
  }
}

/**
 * Get dashboard statistics
 */
async function getAppointmentStats() {
  try {
    const snap = await appointmentsCol().get();
    let total = 0;
    let pending = 0;
    let confirmed = 0;
    let completed = 0;
    let online = 0;
    let inClinic = 0;

    snap.forEach(doc => {
      const d = doc.data();
      total++;
      if (d.status === 'pending') pending++;
      else if (d.status === 'confirmed') confirmed++;
      else if (d.status === 'completed') completed++;

      if (d.consultation_type && d.consultation_type.includes('Online')) online++;
      else inClinic++;
    });

    return { total, pending, confirmed, completed, online, inClinic };
  } catch (firestoreError) {
    console.warn('[Firestore] Stats fallback (' + firestoreError.message + ').');
    if (sqliteDb) {
      const totalRow = sqliteDb.prepare('SELECT COUNT(*) as count FROM appointments').get();
      const pendingRow = sqliteDb.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'pending'").get();
      const confirmedRow = sqliteDb.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'confirmed'").get();
      const completedRow = sqliteDb.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'completed'").get();
      const onlineRow = sqliteDb.prepare("SELECT COUNT(*) as count FROM appointments WHERE consultation_type LIKE '%Online%'").get();
      const clinicRow = sqliteDb.prepare("SELECT COUNT(*) as count FROM appointments WHERE consultation_type LIKE '%In-clinic%'").get();

      return {
        total: totalRow.count,
        pending: pendingRow.count,
        confirmed: confirmedRow.count,
        completed: completedRow.count,
        online: onlineRow.count,
        inClinic: clinicRow.count
      };
    }
    return { total: 0, pending: 0, confirmed: 0, completed: 0, online: 0, inClinic: 0 };
  }
}

// ==========================================
// ADMIN USER AUTHENTICATION
// ==========================================

async function getAdminUser(username) {
  const uname = (username || '').trim();
  try {
    const snap = await adminUsersCol().where('username', '==', uname).limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { id: doc.id, ...doc.data() };
    }
  } catch (firestoreError) {
    console.warn('[Firestore] Admin lookup fallback (' + firestoreError.message + ').');
  }

  if (sqliteDb) {
    const user = sqliteDb.prepare('SELECT * FROM admin_users WHERE username = ?').get(uname);
    if (user) return { id: String(user.id), ...user };
  }

  return null;
}

async function upsertAdminUser(username, password, role = 'physician') {
  const uname = (username || '').trim();
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();

  try {
    const snap = await adminUsersCol().where('username', '==', uname).limit(1).get();
    if (snap.empty) {
      await adminUsersCol().add({
        username: uname,
        password_hash: hash,
        salt: salt,
        role: role,
        created_at: now
      });
    } else {
      await snap.docs[0].ref.update({
        password_hash: hash,
        salt: salt,
        role: role,
        updated_at: now
      });
    }
  } catch (firestoreError) {
    console.warn('[Firestore] Admin upsert fallback (' + firestoreError.message + ').');
  }

  if (sqliteDb) {
    try {
      const existing = sqliteDb.prepare('SELECT id FROM admin_users WHERE username = ?').get(uname);
      if (!existing) {
        sqliteDb.prepare('INSERT INTO admin_users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
          .run(uname, hash, salt, role);
      } else {
        sqliteDb.prepare('UPDATE admin_users SET password_hash = ?, salt = ?, role = ? WHERE username = ?')
          .run(hash, salt, role, uname);
      }
    } catch (e) {
      // ignore
    }
  }
}

// ==========================================
// INITIAL DATABASE SEEDING
// ==========================================

async function seedInitialDataIfEmpty() {
  const adminUsername = (process.env.ADMIN_USER || 'paras').trim();
  const adminPassword = (process.env.ADMIN_PASS || 'parasleve@123').trim();

  // Seed default admin accounts
  await upsertAdminUser(adminUsername, adminPassword, 'physician');
  if (adminUsername !== 'paras') {
    await upsertAdminUser('paras', adminPassword, 'physician');
  }
  await upsertAdminUser('staff', adminPassword, 'staff');

  // Seed sample reviews if collection is empty
  try {
    const revSnap = await reviewsCol().limit(1).get();
    if (revSnap.empty) {
      console.log('[Firestore] Seeding sample verified patient reviews...');
      const sampleReviews = [
        {
          reviewer_name: 'Rameshwar Patidar',
          patient_email: 'rameshwar.p@gmail.com',
          rating: 5,
          treatment_category: 'Chronic Digestion & Acidity',
          comment: 'Suffered from severe GERD and acidity for 4 years. Dr. Paras Leve did Nadi Pariksha and diagnosed Pitta imbalance. Within 3 weeks of his herbal formulation and Ahara changes, my digestion is completely normal. Highly recommended!'
        },
        {
          reviewer_name: 'Sunita Mehra',
          patient_email: 'sunita.mehra.bhopal@gmail.com',
          rating: 5,
          treatment_category: 'Joint Pain & Sciatica',
          comment: 'Outstanding Ayurvedic physician in Bhopal. I had intense lower back and sciatica pain. His customized Kati Basti recommendations and Vata-pacifying herbs brought 80% relief in just 2 weeks.'
        },
        {
          reviewer_name: 'Vikram Singh Chouhan',
          patient_email: 'vikram.chouhan@gmail.com',
          rating: 5,
          treatment_category: 'Skin & Allergy Management',
          comment: 'Consulted Dr. Leve online for chronic urticaria. Very patient doctor who explains the root cause according to classical Ayurveda instead of just suppressing symptoms.'
        },
        {
          reviewer_name: 'Dr. Anita Joshi',
          patient_email: 'anita.joshi@gmail.com',
          rating: 5,
          treatment_category: 'Lifestyle & Metabolic Health',
          comment: 'As an allopathic physician myself, I admire Dr. Paras Leve’s authentic mastery of classical Ayurveda and pulse diagnosis (Nadi Pariksha). His dietary regimens are scientific and gentle.'
        }
      ];

      for (const r of sampleReviews) {
        await createReview(r);
      }
      console.log(`[Firestore] ✅ Seeded ${sampleReviews.length} sample reviews.`);
    }
  } catch (err) {
    // Firestore might be in fallback mode
  }

  // Seed sample appointments if collection is empty
  try {
    const apptSnap = await appointmentsCol().limit(1).get();
    if (apptSnap.empty) {
      console.log('[Firestore] Seeding sample consultations...');
      const sampleAppointments = [
        {
          reference_code: 'AYU-2026-4821',
          patient_name: 'Rajesh Sharma',
          phone: '+91 98231 12345',
          email: 'rajesh.sharma@example.com',
          consultation_type: 'In-clinic visit',
          preferred_date: '2026-10-25',
          preferred_time_slot: '11:00 AM',
          health_concern: 'Chronic hyperacidity, bloating, and post-meal heaviness persisting for 6 months despite antacids.'
        },
        {
          reference_code: 'AYU-2026-4822',
          patient_name: 'Priya Kulkarni',
          phone: '+91 97654 88901',
          email: 'priya.k@example.com',
          consultation_type: 'Online video consultation',
          preferred_date: '2026-10-26',
          preferred_time_slot: '03:30 PM',
          health_concern: 'PCOS symptoms, hormonal acne flare-ups, and irregular menstrual cycles.'
        }
      ];

      for (const a of sampleAppointments) {
        await createAppointment(a);
      }
      console.log(`[Firestore] ✅ Seeded ${sampleAppointments.length} sample appointments.`);
    }
  } catch (err) {
    // Firestore might be in fallback mode
  }
}

module.exports = {
  getFirestore: () => firestoreInstance,
  hashPassword,
  verifyPassword,
  createReview,
  getAllReviews,
  createAppointment,
  getPendingAppointments,
  confirmAppointment,
  getAppointmentById,
  getAppointmentByReferenceOrPhone,
  updateAppointment,
  deleteAppointment,
  listAppointments,
  getAppointmentStats,
  getAdminUser,
  upsertAdminUser,
  seedInitialDataIfEmpty
};
