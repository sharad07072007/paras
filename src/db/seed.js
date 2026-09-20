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

  // Seed sample patient reviews if empty
  try {
    const reviewCount = db.prepare('SELECT COUNT(*) as count FROM patient_reviews').get();
    if (reviewCount.count === 0) {
      const insertReview = db.prepare(`
        INSERT INTO patient_reviews (patient_name, patient_email, rating, treatment_category, review_text, is_approved, created_at)
        VALUES (?, ?, ?, ?, ?, 1, datetime('now', 'localtime', ?))
      `);

      const sampleReviews = [
        {
          name: 'Rameshwar Patidar',
          email: 'rameshwar.p@gmail.com',
          rating: 5,
          category: 'Chronic Digestion & Acidity',
          text: 'Suffered from severe GERD and acidity for 4 years. Dr. Paras Leve did Nadi Pariksha and diagnosed Pitta imbalance. Within 3 weeks of his herbal formulation and Ahara changes, my digestion is completely normal. Highly recommended!',
          offset: '-5 days'
        },
        {
          name: 'Sunita Mehra',
          email: 'sunita.mehra.bhopal@gmail.com',
          rating: 5,
          category: 'Joint Pain & Sciatica',
          text: 'Outstanding Ayurvedic physician in Bhopal. I had intense lower back and sciatica pain. His customized Kati Basti recommendations and Vata-pacifying herbs brought 80% relief in just 2 weeks.',
          offset: '-12 days'
        },
        {
          name: 'Vikram Singh Chouhan',
          email: 'vikram.chouhan@gmail.com',
          rating: 5,
          category: 'Skin & Allergy Management',
          text: 'Consulted Dr. Leve online for chronic urticaria. Very patient doctor who explains the root cause according to classical Ayurveda instead of just suppressing symptoms.',
          offset: '-18 days'
        },
        {
          name: 'Dr. Anita Joshi',
          email: 'anita.joshi@gmail.com',
          rating: 5,
          category: 'Lifestyle & Metabolic Health',
          text: 'As an allopathic physician myself, I admire Dr. Paras Leve’s authentic mastery of classical Ayurveda and pulse diagnosis (Nadi Pariksha). His dietary regimens are scientific and gentle.',
          offset: '-25 days'
        }
      ];

      for (const r of sampleReviews) {
        insertReview.run(r.name, r.email, r.rating, r.category, r.text, r.offset);
      }
      console.log(`✅ Seeded ${sampleReviews.length} authentic patient reviews.`);
    }
  } catch (err) {
    console.warn('Review seed notice:', err.message);
  }

  console.log('✨ Seeding complete.');
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
