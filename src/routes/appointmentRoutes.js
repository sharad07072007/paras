const express = require('express');
const router = express.Router();
const crypto = require('node:crypto');
const {
  createAppointment,
  getPendingAppointments,
  confirmAppointment,
  getAppointmentById,
  getAppointmentByReferenceOrPhone
} = require('../db/firestore');
const { validateAppointmentInput, sanitizeText } = require('../middleware/validator');
const { rateLimiter } = require('../middleware/rateLimiter');
const {
  generateWhatsAppMessage,
  sendPatientConfirmationEmail,
  sendPatientBookingReceivedEmail,
  sendDoctorNewBookingAlert
} = require('../services/notificationService');

// Rate limit booking to prevent automated spam
const bookingLimiter = rateLimiter({ windowMs: 60 * 1000, max: 20 });

/**
 * POST /api/appointments
 * Public booking submission saving permanently to Google Cloud Firestore
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

    const newRecord = await createAppointment({
      patient_name,
      phone,
      email,
      consultation_type,
      preferred_date: preferred_date || 'Earliest available',
      preferred_time_slot: preferred_time_slot || 'Morning (10:00 AM - 01:00 PM)',
      health_concern
    });

    // Dispatch automated emails to both Doctor and Patient (if email provided)
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
        email: newRecord.email,
        consultation_type: newRecord.consultation_type,
        preferred_date: newRecord.preferred_date,
        preferred_time_slot: newRecord.preferred_time_slot,
        health_concern: newRecord.health_concern,
        status: newRecord.status,
        created_at: newRecord.created_at,
        timestamp: newRecord.timestamp
      }
    });
  } catch (error) {
    console.error('Error creating appointment in Firestore:', error);
    return res.status(500).json({
      error: 'An unexpected error occurred while processing your appointment request. Please try again or call the clinic directly.'
    });
  }
});

/**
 * GET /api/appointments/pending
 * Fetch only appointments where status is 'pending' from Firestore
 */
router.get('/pending', async (req, res) => {
  try {
    const pendingAppointments = await getPendingAppointments();
    return res.json({
      success: true,
      count: pendingAppointments.length,
      appointments: pendingAppointments
    });
  } catch (error) {
    console.error('Error fetching pending appointments from Firestore:', error);
    return res.status(500).json({ error: 'Failed to retrieve pending appointments.' });
  }
});

/**
 * PUT /api/appointments/confirm/:id
 * Updates an appointment's status to 'confirmed' and adds a confirmed timestamp,
 * effectively removing it from the active staff portal view while retaining it permanently in Firestore.
 */
router.put('/confirm/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'Appointment ID parameter is required.' });
    }

    const {
      confirmed_date,
      confirmed_time,
      meeting_link,
      doctor_notes,
      send_email = true
    } = req.body || {};

    const updatedAppt = await confirmAppointment(id, {
      confirmed_date: sanitizeText(confirmed_date),
      confirmed_time: sanitizeText(confirmed_time),
      meeting_link: sanitizeText(meeting_link),
      doctor_notes: sanitizeText(doctor_notes)
    });

    if (!updatedAppt) {
      return res.status(404).json({ error: `Appointment "${id}" not found.` });
    }

    // Optional email confirmation dispatch
    let emailResult = { sent: false };
    if (send_email && updatedAppt.email) {
      emailResult = await sendPatientConfirmationEmail(updatedAppt).catch(e => {
        console.error('Confirmation email dispatch error:', e.message);
        return { sent: false };
      });
    }

    // Generate WhatsApp deep link helper
    const wa = generateWhatsAppMessage(updatedAppt);

    return res.json({
      success: true,
      message: 'Appointment confirmed and archived from active queue.',
      appointment: updatedAppt,
      whatsapp: wa,
      email_sent: emailResult.sent
    });
  } catch (error) {
    console.error('Error confirming appointment in Firestore:', error);
    return res.status(500).json({ error: 'Failed to confirm appointment.' });
  }
});

/**
 * GET /api/appointments/track/:reference
 * Patient lookup by booking reference code or registered phone number
 */
router.get('/track/:reference', async (req, res) => {
  try {
    const raw = (req.params.reference || '').trim();
    const query = sanitizeText(raw);
    if (!query) {
      return res.status(400).json({ error: 'Please provide a valid reference code or phone number.' });
    }

    const appointment = await getAppointmentByReferenceOrPhone(query);

    if (!appointment) {
      return res.status(404).json({
        error: `No appointment found matching "${query}". Please check your booking code or phone number.`
      });
    }

    return res.json({
      success: true,
      data: {
        id: appointment.id,
        reference_code: appointment.reference_code,
        patient_name: appointment.patient_name,
        consultation_type: appointment.consultation_type,
        preferred_date: appointment.preferred_date,
        preferred_time_slot: appointment.preferred_time_slot,
        confirmed_date: appointment.confirmed_date,
        confirmed_time: appointment.confirmed_time,
        confirmed_timestamp: appointment.confirmed_timestamp || appointment.confirmed_at,
        meeting_link: appointment.meeting_link,
        status: appointment.status,
        created_at: appointment.created_at,
        updated_at: appointment.updated_at
      }
    });
  } catch (error) {
    console.error('Error tracking appointment in Firestore:', error);
    return res.status(500).json({ error: 'Server error retrieving appointment status.' });
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

    // Find appointment by approval token
    let appointment = null;
    const pending = await getPendingAppointments();
    appointment = pending.find(a => a.approval_token === token);

    if (!appointment) {
      // Check if already confirmed or lookup by token
      const all = await getAppointmentById(token);
      appointment = all;
    }

    if (!appointment) {
      return res.status(404).send('<h3>Appointment not found or approval token expired.</h3>');
    }

    const confirmedDate = sanitizeText(date) || appointment.preferred_date || new Date().toISOString().slice(0, 10);
    const confirmedTime = sanitizeText(time) || appointment.preferred_time_slot || 'Morning (10:00 AM – 01:00 PM)';
    const meetingLink = appointment.meeting_link || `https://meet.google.com/ayur-${appointment.reference_code.toLowerCase()}`;

    // Update to confirmed in Firestore
    const updatedAppt = await confirmAppointment(appointment.id, {
      confirmed_date: confirmedDate,
      confirmed_time: confirmedTime,
      meeting_link: meetingLink
    });

    // Send Email to patient
    let emailResult = { sent: false };
    if (updatedAppt && updatedAppt.email) {
      emailResult = await sendPatientConfirmationEmail(updatedAppt).catch(e => ({ sent: false }));
    }

    // Generate WhatsApp deep link
    const wa = generateWhatsAppMessage(updatedAppt || appointment);

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
          <p><strong>Patient:</strong> ${appointment.patient_name}</p>
          <p><strong>Booking Ref:</strong> <code style="color:#C9971F; font-size:16px;">${appointment.reference_code}</code></p>
          <p><strong>Confirmed Schedule:</strong> ${confirmedDate} (${confirmedTime})</p>
          <p><strong>Email Notification:</strong> ${emailResult.sent ? '<span style="color:#2E7D32;">✓ Dispatched to ' + appointment.email + '</span>' : '<span style="color:#8C8878;">No email provided or queued</span>'}</p>
          
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
 * GET /api/appointments/clinic-info
 */
router.get('/clinic-info', (req, res) => {
  return res.json({
    success: true,
    data: {
      doctor_name: 'Dr. Paras Leve',
      qualifications: 'BAMS, CRAV (Certificate of Rashtriya Ayurveda Vidyapeeth)',
      registration: 'AY-2019-04831 (Ministry of AYUSH)',
      phone: '+91 7389808594',
      address: 'Shree Ayush Clinic, MP Nagar, Zone-II, Bhopal – 462011',
      hours_weekday: 'Mon–Fri, 10:00 AM – 7:00 PM',
      hours_weekend: 'Sat–Sun, 10:00 AM – 5:00 PM'
    }
  });
});

module.exports = router;
