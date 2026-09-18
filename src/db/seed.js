const { db, hashPassword } = require('./database');
require('dotenv').config();

function seed() {
  console.log('🌱 Seeding database...');

  // Seed Doctor & Staff Accounts
  const adminUsername = (process.env.ADMIN_USER || 'paras').trim();
  const adminPassword = (process.env.ADMIN_PASS || 'parasleve@123').trim();

  function upsertUser(username, password, role) {
    const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
    const { hash, salt } = hashPassword(password);
    if (!existing) {
      db.prepare(`
        INSERT INTO admin_users (username, password_hash, salt, role)
        VALUES (?, ?, ?, ?)
      `).run(username, hash, salt, role);
      console.log(`✅ Created user: ${username} (${role})`);
    } else {
      db.prepare(`
        UPDATE admin_users SET password_hash = ?, salt = ?, role = ? WHERE username = ?
      `).run(hash, salt, role, username);
      console.log(`✅ Updated user credentials: ${username} (${role})`);
    }
  }

  // Primary doctor & staff portal logins
  upsertUser(adminUsername, adminPassword, 'physician');
  if (adminUsername !== 'paras') {
    upsertUser('paras', adminPassword, 'physician');
  }
  upsertUser('staff', adminPassword, 'staff');
  upsertUser('parsas', adminPassword, 'physician');
  upsertUser('admin', adminPassword, 'physician');

  // Seed sample appointments if empty
  const countRow = db.prepare('SELECT COUNT(*) as count FROM appointments').get();
  if (countRow.count === 0) {
    const insertAppointment = db.prepare(`
      INSERT INTO appointments (
        reference_code, patient_name, phone, email, consultation_type,
        preferred_date, preferred_time_slot, health_concern, status, doctor_notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const sampleAppointments = [
      {
        ref: 'AYU-2026-4821',
        name: 'Rajesh Sharma',
        phone: '+91 98231 12345',
        email: 'rajesh.sharma@example.com',
        type: 'In-clinic visit',
        date: '2026-09-08',
        time: '11:00 AM',
        concern: 'Chronic hyperacidity, bloating, and post-meal heaviness persisting for 6 months despite antacids.',
        status: 'confirmed',
        notes: 'Advised fasting blood test; planned Nadi Pariksha and Deepana-Pachana protocol with Avipattikar churna.',
        createdAt: '2026-09-06 10:15:00'
      },
      {
        ref: 'AYU-2026-4822',
        name: 'Priya Kulkarni',
        phone: '+91 97654 88901',
        email: 'priya.k@example.com',
        type: 'Online video consultation',
        date: '2026-09-08',
        time: '03:30 PM',
        concern: 'PCOS symptoms, hormonal acne flare-ups, and irregular menstrual cycles.',
        status: 'pending',
        notes: '',
        createdAt: '2026-09-07 09:30:00'
      },
      {
        ref: 'AYU-2026-4823',
        name: 'Anil Joshi',
        phone: '+91 94220 54321',
        email: 'anil.joshi@example.com',
        type: 'In-clinic visit',
        date: '2026-09-05',
        time: '12:15 PM',
        concern: 'Bilateral knee joint stiffness (Sandhivata) and morning immobility.',
        status: 'completed',
        notes: 'Session 1 completed. Prescribed Yograj Guggulu + Dashmoola decoction. Recommended 7-day Janu Basti.',
        createdAt: '2026-09-04 14:20:00'
      },
      {
        ref: 'AYU-2026-4824',
        name: 'Sunita Verma',
        phone: '+91 98901 77654',
        email: 'sunita.v@example.com',
        type: 'Online video consultation',
        date: '2026-09-09',
        time: '04:00 PM',
        concern: 'Insomnia, waking at 3:00 AM with racing pulse, high work-related stress.',
        status: 'confirmed',
        notes: 'Suggested Brahmi Vati, warm sesame oil Pada-Abhyanga before bed.',
        createdAt: '2026-09-07 11:45:00'
      }
    ];

    for (const appt of sampleAppointments) {
      insertAppointment.run(
        appt.ref,
        appt.name,
        appt.phone,
        appt.email,
        appt.type,
        appt.date,
        appt.time,
        appt.concern,
        appt.status,
        appt.notes,
        appt.createdAt
      );
    }
    console.log(`✅ Seeded ${sampleAppointments.length} sample appointments.`);
  }

  // Seed clinic settings
  const clinicDefaults = [
    ['doctor_name', 'Dr. Paras Leve'],
    ['qualifications', 'BAMS, CRAV (Certificate of Rashtriya Ayurveda Vidyapeeth)'],
    ['registration', 'AY-2019-04831 (Ministry of AYUSH)'],
    ['phone', '+91 98765 43210'],
    ['address', 'Shree Ayush Clinic, MP Nagar, Zone-II, Bhopal – 462011'],
    ['hours_weekday', 'Mon–Fri, 10:00 AM – 7:00 PM'],
    ['hours_weekend', 'Sat–Sun, 10:00 AM – 5:00 PM']
  ];

  const insertProfile = db.prepare(`
    INSERT OR REPLACE INTO clinic_profile (key, value, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
  `);

  for (const [key, val] of clinicDefaults) {
    insertProfile.run(key, val);
  }

  console.log('✅ Clinic profile seeded successfully.');
  console.log('✨ Seeding complete.');
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
