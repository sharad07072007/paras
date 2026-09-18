const nodemailer = require('nodemailer');
require('dotenv').config();

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
const CLINIC_NAME = 'Shree Ayush Clinic — Dr. Paras Leve (BAMS, CRAV)';
const CLINIC_PHONE = process.env.CLINIC_PHONE || '+91 7067207752';
const CLINIC_ADDRESS = 'Shree Ayush Clinic, MP Nagar, Zone-II, Bhopal (M.P.) – 462011';
function normalizeDoctorEmail(email) {
  const e = (email || '').trim();
  if (!e || e.toLowerCase() === 'drparsleve@gmail.com' || e.toLowerCase() === 'sharadpatidar555@gmail.com') {
    return 'drparasleve@gmail.com';
  }
  return e;
}

const DOCTOR_EMAIL = normalizeDoctorEmail(process.env.DOCTOR_EMAIL);

function getBaseUrl() {
  if (process.env.BASE_URL && !process.env.BASE_URL.includes('localhost')) {
    return process.env.BASE_URL.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return 'https://parasleve.vercel.app';
}

function getSmtpCredentials() {
  const user = normalizeDoctorEmail(process.env.SMTP_USER || process.env.GMAIL_USER);
  const rawPass = (process.env.SMTP_PASS || process.env.GMAIL_APP_PASS || 'yllmptuohbjmzxgx').trim();
  const pass = rawPass.replace(/\s+/g, '');
  return { user, pass };
}

// Setup email transporter
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { user, pass } = getSmtpCredentials();

  if (user && pass) {
    // Real Gmail / SMTP delivery
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user,
        pass
      }
    });
    console.log(`✉️ [EMAIL SERVICE] Live Gmail SMTP connected for sender: ${user}`);
  } else {
    // Fallback stream transporter when credentials not yet set
    transporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'windows',
      buffer: true
    });
  }
  return transporter;
}

/**
 * Format phone number for WhatsApp
 */
function formatWhatsAppPhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    digits = '91' + digits;
  }
  return digits;
}

/**
 * Generate formatted WhatsApp message and wa.me deep link
 */
function generateWhatsAppMessage(appointment) {
  const patientName = appointment.patient_name;
  const refCode = appointment.reference_code;
  const mode = appointment.consultation_type;
  const date = appointment.confirmed_date || appointment.preferred_date || 'Upcoming';
  const time = appointment.confirmed_time || appointment.preferred_time_slot || 'Regular clinic hours';
  const meetLink = appointment.meeting_link;

  let locationOrLink = '';
  if (mode.includes('Online')) {
    locationOrLink = `• *Video Consultation Link:* ${meetLink || `${BASE_URL}/consultation/${refCode}`}\n`;
  } else {
    locationOrLink = `• *Clinic Location:* ${CLINIC_ADDRESS}\n`;
  }

  const messageText = 
`*SHREE AYUSH CLINIC — DR. PARAS LEVE*
_BAMS, CRAV (Reg. No. AY-2019-04831)_

Namaste *${patientName}* 🙏

Your consultation appointment has been *APPROVED & CONFIRMED* by Dr. Paras Leve.

📋 *Appointment Summary:*
• *Booking Ref:* ${refCode}
• *Consultation Type:* ${mode}
• *Date:* ${date}
• *Time Slot:* ${time}
${locationOrLink}
🌿 *Patient Instructions for Assessment:*
1. For classical Nadi Pariksha (pulse diagnosis), maintain a 2–3 hour light gap after heavy meals.
2. Keep previous diagnostic or blood reports ready.

For queries or rescheduling, reply directly or call ${CLINIC_PHONE}.

_Wishing you holistic health, vitality, and balance._`;

  const phone = formatWhatsAppPhone(appointment.phone);
  const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(messageText)}`;

  return {
    phone,
    text: messageText,
    url: whatsappUrl
  };
}

/**
 * Send Patient Approval Confirmation Email
 */
async function sendPatientConfirmationEmail(appointment) {
  if (!appointment.email || !appointment.email.includes('@')) {
    return { sent: false, reason: 'Patient provided no email address' };
  }

  const client = getTransporter();
  const date = appointment.confirmed_date || appointment.preferred_date || 'Upcoming';
  const time = appointment.confirmed_time || appointment.preferred_time_slot || 'Scheduled Slot';
  const isOnline = appointment.consultation_type.includes('Online');
  const meetLink = appointment.meeting_link || `https://meet.google.com/ayur-${appointment.reference_code.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

  const htmlContent = `
    <div style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#ECE8DC; padding:24px; border-radius:8px;">
      <div style="background:#1F3A2E; color:#ECE8DC; padding:24px; border-radius:6px 6px 0 0; text-align:center; border-bottom:3px solid #C9971F;">
        <h1 style="margin:0; font-size:24px; font-weight:600; color:#FBFAF6;">Dr. Paras Leve</h1>
        <p style="margin:4px 0 0; font-size:13px; color:#C9971F; letter-spacing:0.05em;">BAMS, CRAV · REGISTERED AYURVEDIC PHYSICIAN</p>
      </div>

      <div style="background:#FBFAF6; padding:32px; border-radius:0 0 6px 6px; box-shadow:0 4px 12px rgba(0,0,0,0.06); color:#23261F;">
        <div style="text-align:center; margin-bottom:20px;">
          <span style="background:#E8F5E9; color:#2E7D32; border:1px solid #C8E6C9; padding:6px 14px; border-radius:20px; font-size:13px; font-weight:600; text-transform:uppercase;">
            ✓ Consultation Confirmed
          </span>
        </div>

        <h2 style="font-size:20px; color:#1F3A2E; margin-top:0;">Namaste ${appointment.patient_name},</h2>
        <p style="font-size:15px; line-height:1.6; color:#5C5A4E;">
          Your appointment request with <strong>Dr. Paras Leve</strong> has been approved. Here are your consultation details:
        </p>

        <div style="background:#FAF8F2; border:1px solid #D6D0BE; border-radius:6px; padding:18px; margin:20px 0;">
          <table style="width:100%; border-collapse:collapse; font-size:14px;">
            <tr>
              <td style="padding:6px 0; color:#5C5A4E; width:40%;">Booking Reference:</td>
              <td style="padding:6px 0; font-weight:700; color:#C9971F; font-family:monospace; font-size:16px;">${appointment.reference_code}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Consultation Mode:</td>
              <td style="padding:6px 0; font-weight:600; color:#1F3A2E;">${appointment.consultation_type}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Confirmed Date:</td>
              <td style="padding:6px 0; font-weight:600;">${date}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Confirmed Time:</td>
              <td style="padding:6px 0; font-weight:600;">${time}</td>
            </tr>
            ${isOnline ? `
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Video Meeting:</td>
              <td style="padding:6px 0;"><a href="${meetLink}" target="_blank" style="color:#1F3A2E; font-weight:600; text-decoration:underline;">Join Video Consultation</a></td>
            </tr>
            ` : `
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Clinic Location:</td>
              <td style="padding:6px 0; color:#1F3A2E;">${CLINIC_ADDRESS}</td>
            </tr>
            `}
          </table>
        </div>

        <div style="background:#FFF9E6; border-left:4px solid #C9971F; padding:14px; margin:20px 0; font-size:13px; color:#6B5310; line-height:1.5;">
          <strong>Clinical Preparation Tips:</strong>
          <ul style="margin:6px 0 0 16px; padding:0;">
            <li>For classical Nadi Pariksha, maintain a 2–3 hour light gap after meals.</li>
            <li>Keep any current medications, prescriptions, or blood reports available.</li>
          </ul>
        </div>

        <p style="font-size:14px; color:#5C5A4E;">
          If you need to reschedule or have questions, please reach us directly at <strong>${CLINIC_PHONE}</strong>.
        </p>

        <div style="margin-top:28px; padding-top:20px; border-top:1px solid #D6D0BE; font-size:12px; color:#8C8878; text-align:center;">
          Shree Ayush Clinic · Reg. No. AY-2019-04831 · Bhopal (M.P.)
        </div>
      </div>
    </div>
  `;

  try {
    const { user: sender } = getSmtpCredentials();
    const info = await client.sendMail({
      from: `"Dr. Paras Leve Clinic" <${sender}>`,
      to: appointment.email,
      subject: `✓ Consultation Confirmed [${appointment.reference_code}] — Dr. Paras Leve`,
      html: htmlContent
    });
    console.log(`📧 [EMAIL SENT TO PATIENT]: ${appointment.email} (Message ID: ${info.messageId || 'local'})`);
    return { sent: true, messageId: info.messageId || 'local-stream' };
  } catch (err) {
    console.error('Failed to dispatch email to patient:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * AUTOMATICALLY SEND EMAIL TO DOCTOR (drparasleve@gmail.com)
 * Triggered immediately when a patient books an appointment
 */
async function sendDoctorNewBookingAlert(appointment) {
  const targetEmail = normalizeDoctorEmail(process.env.DOCTOR_EMAIL);
  const client = getTransporter();
  const baseUrl = getBaseUrl();

  const quickApproveUrl = `${baseUrl}/api/appointments/quick-approve?token=${appointment.approval_token}&date=${encodeURIComponent(appointment.preferred_date || '')}&time=${encodeURIComponent(appointment.preferred_time_slot || '')}`;
  const dashboardUrl = `${baseUrl}/admin.html`;
  const cleanPhone = formatWhatsAppPhone(appointment.phone);
  const patientWaUrl = `https://wa.me/${cleanPhone}`;
  const callPhoneUrl = `tel:${appointment.phone.replace(/[^0-9+]/g, '')}`;

  const htmlContent = `
    <div style="font-family:'Segoe UI',Roboto,Helvetica,sans-serif; max-width:620px; margin:0 auto; background:#ECE8DC; padding:24px; border-radius:8px;">
      <div style="background:#1F3A2E; color:#ECE8DC; padding:20px 24px; border-radius:6px 6px 0 0; text-align:center; border-bottom:3px solid #C9971F;">
        <h2 style="margin:0; color:#FBFAF6; font-size:22px;">New Patient Consultation Request</h2>
        <p style="margin:4px 0 0; color:#C9971F; font-size:13px; letter-spacing:0.05em;">DR. PARAS LEVE AYURVEDIC CLINIC NOTIFICATION</p>
      </div>

      <div style="background:#FBFAF6; padding:28px; border-radius:0 0 6px 6px; box-shadow:0 4px 14px rgba(0,0,0,0.06); color:#23261F;">
        <div style="display:flex; justify-content:space-between; margin-bottom:16px; border-bottom:1px solid #D6D0BE; padding-bottom:12px;">
          <div>
            <span style="font-size:12px; color:#5C5A4E;">BOOKING REFERENCE</span><br>
            <strong style="font-family:monospace; font-size:18px; color:#C9971F;">${appointment.reference_code}</strong>
          </div>
          <div style="text-align:right;">
            <span style="font-size:12px; color:#5C5A4E;">BOOKING STATUS</span><br>
            <span style="background:#FFF3E0; color:#E65100; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">PENDING REVIEW</span>
          </div>
        </div>

        <h3 style="margin:14px 0 8px; color:#1F3A2E; font-size:17px;">Patient Details:</h3>
        <table style="width:100%; font-size:14px; line-height:1.6; margin-bottom:16px;">
          <tr>
            <td style="color:#5C5A4E; width:35%;">Full Name:</td>
            <td><strong>${appointment.patient_name}</strong></td>
          </tr>
          <tr>
            <td style="color:#5C5A4E;">Mobile Number:</td>
            <td><strong><a href="${callPhoneUrl}" style="color:#1F3A2E; text-decoration:underline;">${appointment.phone}</a></strong></td>
          </tr>
          <tr>
            <td style="color:#5C5A4E;">Email:</td>
            <td>${appointment.email || '<em>Not provided</em>'}</td>
          </tr>
          <tr>
            <td style="color:#5C5A4E;">Consultation Mode:</td>
            <td><strong style="color:#1F3A2E;">${appointment.consultation_type}</strong></td>
          </tr>
          <tr>
            <td style="color:#5C5A4E;">Requested Date:</td>
            <td>${appointment.preferred_date || 'Earliest available'}</td>
          </tr>
          <tr>
            <td style="color:#5C5A4E;">Requested Time Slot:</td>
            <td>${appointment.preferred_time_slot || 'Regular hours'}</td>
          </tr>
        </table>

        <div style="background:#FAF8F2; border:1px solid #D6D0BE; border-left:4px solid #1F3A2E; border-radius:4px; padding:14px; margin:18px 0;">
          <strong style="color:#1F3A2E; font-size:13px; text-transform:uppercase; letter-spacing:0.04em; display:block; margin-bottom:4px;">Patient Health Symptoms / Concern:</strong>
          <div style="font-size:14px; line-height:1.5; color:#23261F;">
            ${appointment.health_concern}
          </div>
        </div>

        <!-- DOCTOR QUICK ACTION BUTTONS -->
        <div style="margin-top:24px; text-align:center; padding-top:16px; border-top:1px solid #D6D0BE;">
          <p style="font-size:13px; color:#5C5A4E; margin-bottom:14px; font-weight:bold; text-transform:uppercase; letter-spacing:0.04em;">Doctor Quick Actions:</p>
          
          <div style="margin-bottom:8px;">
            <a href="${quickApproveUrl}" style="background:#2E7D32; color:#FFF; padding:12px 24px; text-decoration:none; border-radius:4px; font-weight:bold; font-size:14px; display:inline-block; min-width:240px; box-shadow:0 2px 5px rgba(46,125,50,0.2);">
              ✓ Quick Approve Consultation
            </a>
          </div>

          <div style="margin-bottom:8px;">
            <a href="${patientWaUrl}" target="_blank" style="background:#25D366; color:#FFF; padding:12px 24px; text-decoration:none; border-radius:4px; font-weight:bold; font-size:14px; display:inline-block; min-width:240px; box-shadow:0 2px 5px rgba(37,211,102,0.2);">
              💬 Open WhatsApp Chat
            </a>
          </div>

          <!-- OPTION OF CALL BELOW THE OPEN WHATSAPP CHAT -->
          <div style="margin-bottom:8px;">
            <a href="${callPhoneUrl}" style="background:#0D47A1; color:#FFFFFF; padding:12px 24px; text-decoration:none; border-radius:4px; font-weight:bold; font-size:14px; display:inline-block; min-width:240px; box-shadow:0 2px 5px rgba(13,71,161,0.25);">
              📞 Call Patient (${appointment.phone})
            </a>
          </div>

          <div style="margin-top:12px;">
            <a href="${dashboardUrl}" style="background:#1F3A2E; color:#ECE8DC; padding:10px 20px; text-decoration:none; border-radius:4px; font-weight:bold; font-size:13px; display:inline-block; min-width:240px;">
              🩺 Open Clinic Dashboard
            </a>
          </div>
        </div>

        <div style="margin-top:24px; font-size:11px; color:#8C8878; text-align:center;">
          Automated consultation alert dispatched to ${targetEmail}.
        </div>
      </div>
    </div>
  `;

  console.log('====================================================');
  console.log(`📧 [EMAIL TO DOCTOR DISPATCHED]`);
  console.log(`📬 Recipient: ${targetEmail}`);
  console.log(`📋 Patient:   ${appointment.patient_name} (${appointment.reference_code})`);
  console.log(`📱 Phone:     ${appointment.phone}`);
  console.log(`🏥 Mode:      ${appointment.consultation_type}`);
  console.log('====================================================');

  try {
    const { user: sender } = getSmtpCredentials();
    const info = await client.sendMail({
      from: `"Dr. Paras Leve Clinic" <${sender}>`,
      to: targetEmail,
      subject: `🌿 New Appointment Request: ${appointment.patient_name} [${appointment.reference_code}]`,
      html: htmlContent
    });

    console.log(`✅ [GMAIL SUCCESS] Email delivered to ${targetEmail} (Message ID: ${info.messageId || 'local'})`);
    return { sent: true, messageId: info.messageId || 'stream-logged' };
  } catch (err) {
    console.error(`❌ [EMAIL ERROR to ${targetEmail}]:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send Patient Booking Acknowledgment Email (immediately upon submission)
 */
async function sendPatientBookingReceivedEmail(appointment) {
  if (!appointment.email || !appointment.email.includes('@')) {
    return { sent: false, reason: 'Patient provided no email address' };
  }

  const client = getTransporter();
  const baseUrl = getBaseUrl();
  const date = appointment.preferred_date || 'Earliest available';
  const time = appointment.preferred_time_slot || 'Regular hours';
  const trackUrl = `${baseUrl}/#contact`;

  const htmlContent = `
    <div style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#ECE8DC; padding:24px; border-radius:8px;">
      <div style="background:#1F3A2E; color:#ECE8DC; padding:24px; border-radius:6px 6px 0 0; text-align:center; border-bottom:3px solid #C9971F;">
        <h1 style="margin:0; font-size:24px; font-weight:600; color:#FBFAF6;">Dr. Paras Leve</h1>
        <p style="margin:4px 0 0; font-size:13px; color:#C9971F; letter-spacing:0.05em;">BAMS, CRAV · REGISTERED AYURVEDIC PHYSICIAN</p>
      </div>

      <div style="background:#FBFAF6; padding:32px; border-radius:0 0 6px 6px; box-shadow:0 4px 12px rgba(0,0,0,0.06); color:#23261F;">
        <div style="text-align:center; margin-bottom:20px;">
          <span style="background:#FFF3E0; color:#E65100; border:1px solid #FFE0B2; padding:6px 14px; border-radius:20px; font-size:13px; font-weight:600; text-transform:uppercase;">
            ⏳ Request Received — Pending Review
          </span>
        </div>

        <h2 style="font-size:20px; color:#1F3A2E; margin-top:0;">Namaste ${appointment.patient_name},</h2>
        <p style="font-size:15px; line-height:1.6; color:#5C5A4E;">
          Thank you for requesting an Ayurvedic consultation with <strong>Dr. Paras Leve</strong>. We have received your booking details and our clinic team will review and confirm your scheduled slot shortly.
        </p>

        <div style="background:#FAF8F2; border:1px solid #D6D0BE; border-radius:6px; padding:18px; margin:20px 0;">
          <table style="width:100%; border-collapse:collapse; font-size:14px;">
            <tr>
              <td style="padding:6px 0; color:#5C5A4E; width:40%;">Booking Reference:</td>
              <td style="padding:6px 0; font-weight:700; color:#C9971F; font-family:monospace; font-size:16px;">${appointment.reference_code}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Consultation Mode:</td>
              <td style="padding:6px 0; font-weight:600; color:#1F3A2E;">${appointment.consultation_type}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Requested Date:</td>
              <td style="padding:6px 0; font-weight:600;">${date}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#5C5A4E;">Requested Time Slot:</td>
              <td style="padding:6px 0; font-weight:600;">${time}</td>
            </tr>
          </table>
        </div>

        <div style="background:#FFF9E6; border-left:4px solid #C9971F; padding:14px; margin:20px 0; font-size:13px; color:#6B5310; line-height:1.5;">
          <strong>What happens next?</strong>
          <ul style="margin:6px 0 0 16px; padding:0;">
            <li>Dr. Paras Leve will review your consultation request.</li>
            <li>You will receive an official confirmation email & WhatsApp message once approved.</li>
            <li>You can track your appointment status anytime on our website using your reference code: <strong>${appointment.reference_code}</strong>.</li>
          </ul>
        </div>

        <div style="text-align:center; margin-top:24px;">
          <a href="${trackUrl}" style="background:#1F3A2E; color:#ECE8DC; padding:12px 24px; text-decoration:none; border-radius:4px; font-weight:600; font-size:14px; display:inline-block;">
            🔍 Track Appointment Status
          </a>
        </div>

        <p style="font-size:13px; color:#5C5A4E; margin-top:24px; text-align:center;">
          Need urgent assistance? Call the clinic directly at <strong>${CLINIC_PHONE}</strong>.
        </p>

        <div style="margin-top:28px; padding-top:20px; border-top:1px solid #D6D0BE; font-size:12px; color:#8C8878; text-align:center;">
          Shree Ayush Clinic · Reg. No. AY-2019-04831 · Bhopal (M.P.)
        </div>
      </div>
    </div>
  `;

  try {
    const { user: sender } = getSmtpCredentials();
    const info = await client.sendMail({
      from: `"Dr. Paras Leve Clinic" <${sender}>`,
      to: appointment.email,
      subject: `🌿 Consultation Request Received [${appointment.reference_code}] — Dr. Paras Leve`,
      html: htmlContent
    });
    console.log(`📧 [RECEIPT SENT TO PATIENT]: ${appointment.email}`);
    return { sent: true, messageId: info.messageId || 'local-stream' };
  } catch (err) {
    console.error('Failed to dispatch receipt to patient:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  formatWhatsAppPhone,
  generateWhatsAppMessage,
  sendPatientConfirmationEmail,
  sendPatientBookingReceivedEmail,
  sendDoctorNewBookingAlert
};
