const express = require('express');
const router = express.Router();
const { db, verifyPassword, hashPassword } = require('../db/database');
const { signToken, requireAdminAuth } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/validator');
const {
  generateWhatsAppMessage,
  sendPatientConfirmationEmail
} = require('../services/notificationService');

/**
 * POST /api/admin/login
 */
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username.trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const isValid = verifyPassword(password, user.password_hash, user.salt);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = signToken({
      id: user.id,
      username: user.username,
      role: user.role
    }, 7 * 24 * 3600); // 7 days expiration

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({ error: 'Internal server error during authentication.' });
  }
});

// All subsequent routes require admin authentication
router.use(requireAdminAuth);

/**
 * GET /api/admin/me
 */
router.get('/me', (req, res) => {
  return res.json({ success: true, user: req.user });
});

/**
 * GET /api/admin/stats
 */
router.get('/stats', (req, res) => {
  try {
    const totalRow = db.prepare('SELECT COUNT(*) as count FROM appointments').get();
    const pendingRow = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'pending'").get();
    const confirmedRow = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'confirmed'").get();
    const completedRow = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'completed'").get();
    const onlineRow = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE consultation_type LIKE '%Online%'").get();
    const clinicRow = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE consultation_type LIKE '%In-clinic%'").get();

    return res.json({
      success: true,
      stats: {
        total: totalRow.count,
        pending: pendingRow.count,
        confirmed: confirmedRow.count,
        completed: completedRow.count,
        online: onlineRow.count,
        inClinic: clinicRow.count
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    return res.status(500).json({ error: 'Failed to retrieve dashboard statistics.' });
  }
});

/**
 * GET /api/admin/appointments
 */
router.get('/appointments', (req, res) => {
  try {
    const { status, search, type, limit = 100, offset = 0 } = req.query;

    let query = 'SELECT * FROM appointments WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }

    if (type && type !== 'all') {
      query += ' AND consultation_type = ?';
      params.push(type);
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      const num = parseInt(search.trim(), 10);
      if (!isNaN(num) && num > 0) {
        query += ' AND (id = ? OR patient_name LIKE ? OR phone LIKE ? OR reference_code LIKE ? OR health_concern LIKE ?)';
        params.push(num, term, term, term, term);
      } else {
        query += ' AND (patient_name LIKE ? OR phone LIKE ? OR reference_code LIKE ? OR health_concern LIKE ?)';
        params.push(term, term, term, term);
      }
    }

    query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 100, parseInt(offset, 10) || 0);

    const rows = db.prepare(query).all(...params);

    return res.json({
      success: true,
      count: rows.length,
      appointments: rows
    });
  } catch (error) {
    console.error('Error listing appointments:', error);
    return res.status(500).json({ error: 'Failed to list appointments.' });
  }
});

/**
 * GET /api/admin/appointments/:id
 * Fetch single appointment by numeric ID
 */
router.get('/appointments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid appointment ID.' });
    }
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }
    return res.json({ success: true, appointment });
  } catch (error) {
    console.error('Error fetching appointment:', error);
    return res.status(500).json({ error: 'Failed to retrieve appointment.' });
  }
});

/**
 * POST /api/admin/appointments/:id/approve
 * Approves appointment and triggers WhatsApp & Email notifications
 */
router.post('/appointments/:id/approve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }

    const {
      confirmed_date,
      confirmed_time,
      meeting_link,
      doctor_notes,
      send_email = true
    } = req.body || {};

    const finalDate = sanitizeText(confirmed_date) || existing.preferred_date || new Date().toISOString().slice(0, 10);
    const finalTime = sanitizeText(confirmed_time) || existing.preferred_time_slot || 'Morning (10:00 AM – 01:00 PM)';
    const finalMeetingLink = sanitizeText(meeting_link) || existing.meeting_link || 
      (existing.consultation_type.includes('Online') ? `https://meet.google.com/ayur-${existing.reference_code.toLowerCase().replace(/[^a-z0-9]/g, '-')}` : '');
    const finalNotes = doctor_notes !== undefined ? sanitizeText(doctor_notes) : existing.doctor_notes;

    db.prepare(`
      UPDATE appointments
      SET status = 'confirmed',
          confirmed_date = ?,
          confirmed_time = ?,
          meeting_link = ?,
          doctor_notes = ?,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(finalDate, finalTime, finalMeetingLink, finalNotes, id);

    const updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);

    // 1. Send Email Notification
    let emailResult = { sent: false };
    if (send_email && updated.email) {
      emailResult = await sendPatientConfirmationEmail(updated);
      if (emailResult.sent) {
        db.prepare("UPDATE appointments SET email_sent_at = datetime('now', 'localtime') WHERE id = ?").run(id);
      }
    }

    // 2. Generate WhatsApp Template & Link
    const wa = generateWhatsAppMessage(updated);

    return res.json({
      success: true,
      message: 'Consultation successfully approved and confirmed.',
      appointment: updated,
      whatsapp: wa,
      email_sent: emailResult.sent
    });
  } catch (error) {
    console.error('Error approving appointment:', error);
    return res.status(500).json({ error: 'Failed to approve appointment and dispatch notifications.' });
  }
});

/**
 * POST /api/admin/appointments/:id/mark-whatsapp-sent
 */
router.post('/appointments/:id/mark-whatsapp-sent', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.prepare("UPDATE appointments SET whatsapp_sent_at = datetime('now', 'localtime') WHERE id = ?").run(id);
    return res.json({ success: true, message: 'WhatsApp notification marked as dispatched.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/admin/appointments/:id/status
 * Dedicated endpoint for fast, real-time status transitions (pending, confirmed, completed, cancelled)
 */
router.patch('/appointments/:id/status', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid appointment ID parameter.' });
    }

    const { status } = req.body || {};
    if (!status || typeof status !== 'string') {
      return res.status(400).json({ error: 'Status field is required and must be a string.' });
    }

    let normalizedStatus = status.trim().toLowerCase();
    if (normalizedStatus === 'canceled') normalizedStatus = 'cancelled';

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!validStatuses.includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Invalid status "${status}". Allowed values: ${validStatuses.join(', ')}`
      });
    }

    const existing = db.prepare('SELECT id, status, patient_name, reference_code FROM appointments WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: `Appointment #${id} not found.` });
    }

    const result = db.prepare(`
      UPDATE appointments
      SET status = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(normalizedStatus, id);

    if (result.changes === 0) {
      return res.status(500).json({ error: 'Failed to update appointment status.' });
    }

    const updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);

    return res.json({
      success: true,
      message: `Appointment #${id} status updated to "${normalizedStatus}".`,
      appointment: updated
    });
  } catch (error) {
    console.error('Error updating appointment status:', error);
    return res.status(500).json({ error: 'Internal server error while updating status.' });
  }
});

/**
 * PATCH /api/admin/appointments/:id
 */
router.patch('/appointments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid appointment ID parameter.' });
    }

    const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }

    const { status, doctor_notes, preferred_date, preferred_time_slot, confirmed_date, confirmed_time, meeting_link } = req.body || {};

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    let newStatus = existing.status;

    if (status) {
      let normalized = status.toString().trim().toLowerCase();
      if (normalized === 'canceled') normalized = 'cancelled';
      if (!validStatuses.includes(normalized)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
      }
      newStatus = normalized;
    }

    const newNotes = doctor_notes !== undefined ? sanitizeText(doctor_notes) : existing.doctor_notes;
    const newDate = preferred_date !== undefined ? sanitizeText(preferred_date) : existing.preferred_date;
    const newTime = preferred_time_slot !== undefined ? sanitizeText(preferred_time_slot) : existing.preferred_time_slot;
    const newConfDate = confirmed_date !== undefined ? sanitizeText(confirmed_date) : existing.confirmed_date;
    const newConfTime = confirmed_time !== undefined ? sanitizeText(confirmed_time) : existing.confirmed_time;
    const newMeetingLink = meeting_link !== undefined ? sanitizeText(meeting_link) : existing.meeting_link;

    db.prepare(`
      UPDATE appointments
      SET status = ?, doctor_notes = ?, preferred_date = ?, preferred_time_slot = ?,
          confirmed_date = ?, confirmed_time = ?, meeting_link = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(newStatus, newNotes, newDate, newTime, newConfDate, newConfTime, newMeetingLink, id);

    const updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);

    return res.json({
      success: true,
      message: 'Appointment updated successfully.',
      appointment: updated
    });
  } catch (error) {
    console.error('Error updating appointment:', error);
    return res.status(500).json({ error: 'Failed to update appointment.' });
  }
});

/**
 * DELETE /api/admin/appointments/:id
 */
router.delete('/appointments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT id FROM appointments WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }

    db.prepare('DELETE FROM appointments WHERE id = ?').run(id);

    return res.json({
      success: true,
      message: 'Appointment deleted successfully.'
    });
  } catch (error) {
    console.error('Error deleting appointment:', error);
    return res.status(500).json({ error: 'Failed to delete appointment.' });
  }
});

/**
 * GET /api/admin/export
 */
router.get('/export', (req, res) => {
  try {
    const appointments = db.prepare('SELECT * FROM appointments ORDER BY id DESC').all();

    const headers = [
      'ID',
      'Reference Code',
      'Patient Name',
      'Phone',
      'Email',
      'Consultation Type',
      'Confirmed Date',
      'Confirmed Time',
      'Status',
      'WhatsApp Sent At',
      'Email Sent At',
      'Doctor Notes',
      'Created At'
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvRows = [headers.join(',')];
    for (const appt of appointments) {
      const row = [
        appt.id,
        appt.reference_code,
        appt.patient_name,
        appt.phone,
        appt.email,
        appt.consultation_type,
        appt.confirmed_date || appt.preferred_date,
        appt.confirmed_time || appt.preferred_time_slot,
        appt.status,
        appt.whatsapp_sent_at || 'No',
        appt.email_sent_at || 'No',
        appt.doctor_notes,
        appt.created_at
      ].map(escapeCsv).join(',');
      csvRows.push(row);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ayurveda_consultations_${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csvRows.join('\r\n'));
  } catch (error) {
    console.error('Error exporting appointments:', error);
    return res.status(500).json({ error: 'Failed to export appointments.' });
  }
});

/**
 * GET /api/admin/reviews
 * Fetch all patient reviews for doctor / staff dashboard
 */
router.get('/reviews', (req, res) => {
  try {
    const reviews = db.prepare('SELECT * FROM patient_reviews ORDER BY id DESC').all();
    return res.json({ success: true, count: reviews.length, reviews });
  } catch (error) {
    console.error('Error fetching admin reviews:', error);
    return res.status(500).json({ error: 'Failed to retrieve patient reviews.' });
  }
});

module.exports = router;
