const express = require('express');
const router = express.Router();
const crypto = require('node:crypto');
const { db } = require('../db/database');
const { validateAppointmentInput, sanitizeText } = require('../middleware/validator');
const { rateLimiter } = require('../middleware/rateLimiter');
const {
  generateWhatsAppMessage,
  sendPatientConfirmationEmail,
  sendPatientBookingReceivedEmail,
  sendDoctorNewBookingAlert
} = require('../services/notificationService');

// Rate limit booking to prevent automated spam
const bookingLimiter = rateLimiter({ windowMs: 60 * 1000, max: 15 });

function generateReferenceCode() {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  const year = new Date().getFullYear();
  return `AYU-${year}-${randomNum}`;
}

/**
 * POST /api/appointments
 * Public booking submission with automated doctor alert
 */
router.post('/', bookingLimiter, validateAppointmentInput, async (req, res) => {
  try {
    const {
      patient_name,
      phone,
      email,
      consultation_type,
      preferred_date,
      preferred_time_slot,
      health_concern
    } = req.sanitized;

    let referenceCode;
    let attempts = 0;
    while (attempts < 5) {
      referenceCode = generateReferenceCode();
      const existing = db.prepare('SELECT id FROM appointments WHERE reference_code = ?').get(referenceCode);
      if (!existing) break;
      attempts++;
    }

    const approvalToken = crypto.randomBytes(24).toString('hex');
    const meetingLink = consultation_type.includes('Online')
      ? `https://meet.google.com/ayur-${referenceCode.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
      : '';

    const insertStmt = db.prepare(`
      INSERT INTO appointments (
        reference_code,
        patient_name,
        phone,
        email,
        consultation_type,
        preferred_date,
        preferred_time_slot,
        health_concern,
        status,
        doctor_notes,
        approval_token,
        meeting_link
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)
    `);

    const result = insertStmt.run(
      referenceCode,
      patient_name,
      phone,
      email,
      consultation_type,
      preferred_date || 'Earliest available',
      preferred_time_slot || 'Morning (10:00 AM - 01:00 PM)',
      health_concern,
      approvalToken,
      meetingLink
    );

    const newRecord = db.prepare(`
      SELECT * FROM appointments WHERE id = ?
    `).get(result.lastInsertRowid);

    // Dispatch automated emails to both Doctor and Patient (if email provided)
    // We await them so serverless environments (e.g. Vercel) complete network transmission
    const emailTasks = [
      sendDoctorNewBookingAlert(newRecord).catch(e => {
        console.error('Doctor alert dispatch error:', e.message);
        return { sent: false, error: e.message };
      })
    ];

    if (newRecord.email && newRecord.email.includes('@')) {
      emailTasks.push(
        sendPatientBookingReceivedEmail(newRecord).catch(e => {
          console.error('Patient receipt dispatch error:', e.message);
          return { sent: false, error: e.message };
        })
      );
    }

    await Promise.allSettled(emailTasks);

    return res.status(201).json({
      success: true,
      message: 'Consultation request submitted successfully. Dr. Leve’s clinic will contact you shortly to confirm your slot.',
      data: {
        id: newRecord.id,
        reference_code: newRecord.reference_code,
        patient_name: newRecord.patient_name,
        phone: newRecord.phone,
        consultation_type: newRecord.consultation_type,
        preferred_date: newRecord.preferred_date,
        preferred_time_slot: newRecord.preferred_time_slot,
        status: newRecord.status,
        created_at: newRecord.created_at
      }
    });
  } catch (error) {
    console.error('Error creating appointment:', error);
    return res.status(500).json({
      error: 'An unexpected error occurred while processing your appointment request. Please try again or call the clinic directly.'
    });
  }
});

/**
 * GET /api/appointments/quick-approve
 * Doctor 1-click approval via email action link
 */
router.get('/quick-approve', async (req, res) => {
  try {
    const { token, date, time } = req.query;
    if (!token) {
      return res.status(400).send('<h3>Invalid approval link. Missing token.</h3>');
    }

    const appointment = db.prepare('SELECT * FROM appointments WHERE approval_token = ?').get(token);
    if (!appointment) {
      return res.status(404).send('<h3>Appointment not found or approval token expired.</h3>');
    }

    const confirmedDate = sanitizeText(date) || appointment.preferred_date || new Date().toISOString().slice(0, 10);
    const confirmedTime = sanitizeText(time) || appointment.preferred_time_slot || 'Morning (10:00 AM – 01:00 PM)';
    const meetingLink = appointment.meeting_link || `https://meet.google.com/ayur-${appointment.reference_code.toLowerCase()}`;

    // Update to confirmed
    db.prepare(`
      UPDATE appointments
      SET status = 'confirmed',
          confirmed_date = ?,
          confirmed_time = ?,
          meeting_link = ?,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(confirmedDate, confirmedTime, meetingLink, appointment.id);

    const updatedAppt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);

    // Send Email to patient
    let emailResult = { sent: false };
    if (updatedAppt.email) {
      emailResult = await sendPatientConfirmationEmail(updatedAppt);
      if (emailResult.sent) {
        db.prepare("UPDATE appointments SET email_sent_at = datetime('now', 'localtime') WHERE id = ?").run(appointment.id);
      }
    }

    // Generate WhatsApp deep link
    const wa = generateWhatsAppMessage(updatedAppt);

    // Render HTML response for Doctor
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Appointment Approved — Dr. Paras Leve</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family:'Segoe UI',Roboto,sans-serif; background:#ECE8DC; color:#23261F; padding:24px; display:flex; justify-content:center; align-items:center; min-height:85vh; margin:0; }
          .card { background:#FBFAF6; border:1px solid #D6D0BE; max-width:540px; width:100%; padding:32px; border-radius:8px; box-shadow:0 8px 24px rgba(31,58,46,0.1); }
          .badge { background:#E8F5E9; color:#2E7D32; font-weight:bold; padding:4px 12px; border-radius:16px; font-size:13px; display:inline-block; }
          h2 { color:#1F3A2E; margin-top:12px; }
          .btn-wa { background:#25D366; color:#FFF; font-weight:bold; padding:12px 20px; border-radius:4px; text-decoration:none; display:inline-flex; align-items:center; gap:8px; margin-top:16px; }
          .btn-portal { background:#1F3A2E; color:#ECE8DC; padding:10px 18px; border-radius:4px; text-decoration:none; font-size:14px; margin-left:8px; }
        </style>
      </head>
      <body>
        <div class="card">
          <span class="badge">✓ APPROVED & CONFIRMED</span>
          <h2>Consultation Confirmed</h2>
          <p><strong>Patient:</strong> ${updatedAppt.patient_name}</p>
          <p><strong>Booking Ref:</strong> <code style="color:#C9971F; font-size:16px;">${updatedAppt.reference_code}</code></p>
          <p><strong>Confirmed Schedule:</strong> ${confirmedDate} (${confirmedTime})</p>
          <p><strong>Email Notification:</strong> ${emailResult.sent ? '<span style="color:#2E7D32;">✓ Dispatched to ' + updatedAppt.email + '</span>' : '<span style="color:#8C8878;">No email provided or queued</span>'}</p>
          
          <div style="margin-top:24px; padding-top:16px; border-top:1px solid #D6D0BE;">
            <p style="font-size:14px; margin-bottom:8px;">Send instant WhatsApp confirmation to patient:</p>
            <a href="${wa.url}" target="_blank" class="btn-wa">
              💬 Open WhatsApp Confirmation
            </a>
            <a href="/admin.html" class="btn-portal">
              Open Dashboard
            </a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error in quick-approve:', error);
    return res.status(500).send('<h3>Error processing approval. Please check clinic dashboard.</h3>');
  }
});

/**
 * GET /api/appointments/track/:reference
 * Patient lookup by booking reference code or registered phone number
 */
router.get('/track/:reference', (req, res) => {
  try {
    const raw = (req.params.reference || '').trim();
    const query = sanitizeText(raw);
    if (!query) {
      return res.status(400).json({ error: 'Please provide a valid reference code or phone number.' });
    }

    const cleanPhone = query.replace(/\D/g, '').slice(-10);

    const appointment = db.prepare(`
      SELECT 
        reference_code,
        patient_name,
        consultation_type,
        preferred_date,
        preferred_time_slot,
        confirmed_date,
        confirmed_time,
        meeting_link,
        status,
        created_at,
        updated_at
      FROM appointments
      WHERE UPPER(reference_code) = UPPER(?)
         OR phone = ?
         OR (length(?) = 10 AND (phone LIKE '%' || ? OR replace(phone, ' ', '') LIKE '%' || ?))
      ORDER BY id DESC
      LIMIT 1
    `).get(query, query, cleanPhone, cleanPhone, cleanPhone);

    if (!appointment) {
      return res.status(404).json({
        error: `No appointment found matching "${query}". Please check your booking code or phone number.`
      });
    }

    return res.json({
      success: true,
      data: appointment
    });
  } catch (error) {
    console.error('Error tracking appointment:', error);
    return res.status(500).json({ error: 'Server error retrieving appointment status.' });
  }
});

/**
 * GET /api/appointments/clinic-info
 */
router.get('/clinic-info', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM clinic_profile').all();
    const info = {};
    for (const row of rows) {
      info[row.key] = row.value;
    }
    return res.json({ success: true, data: info });
  } catch (error) {
    console.error('Error fetching clinic info:', error);
    return res.status(500).json({ error: 'Failed to retrieve clinic info.' });
  }
});

module.exports = router;
