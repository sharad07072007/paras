/**
 * Input validation and sanitization middleware for appointment bookings
 */
function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .replace(/[<>]/g, '')
    .slice(0, 2000);
}

function cleanDigits(phone) {
  if (!phone) return '';
  let digits = phone.toString().replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(2);
  return digits.slice(-10);
}

function validateAppointmentInput(req, res, next) {
  const {
    name,
    phone,
    email,
    mode,
    consultation_type,
    concern,
    health_concern,
    preferred_date,
    preferred_time
  } = req.body || {};

  const errors = [];

  const patientName = sanitizeText(name);
  if (!patientName || patientName.length < 2) {
    errors.push('Patient full name is required and must be at least 2 characters.');
  }

  const rawPhone = (phone || '').toString().trim();
  const phoneDigits = rawPhone.replace(/\D/g, '');
  if (!rawPhone || phoneDigits.length < 10 || phoneDigits.length > 15) {
    errors.push('A valid phone number with at least 10 digits is required.');
  }

  const consultationMode = (mode || consultation_type || '').toString().trim();
  const allowedModes = ['Online video consultation', 'In-clinic visit'];
  if (!allowedModes.includes(consultationMode)) {
    errors.push(`Consultation type must be either "${allowedModes[0]}" or "${allowedModes[1]}".`);
  }

  const healthDesc = sanitizeText(concern || health_concern);
  if (!healthDesc || healthDesc.length < 5) {
    errors.push('Please provide a brief description of your health concern (minimum 5 characters).');
  }

  if (email && typeof email === 'string' && email.trim().length > 0) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      errors.push('Invalid email address format.');
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors
    });
  }

  // Attach sanitized data to request (no OTP verification required)
  req.sanitized = {
    patient_name: patientName,
    phone: rawPhone,
    email: (email || '').toString().trim().toLowerCase(),
    consultation_type: consultationMode,
    health_concern: healthDesc,
    preferred_date: (preferred_date || '').toString().trim(),
    preferred_time_slot: (preferred_time || '').toString().trim(),
    is_phone_verified: 0
  };

  next();
}

module.exports = {
  sanitizeText,
  cleanDigits,
  validateAppointmentInput
};
