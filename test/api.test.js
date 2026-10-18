const http = require('node:http');
const app = require('../server');

const PORT = 5058;
let server;
let adminToken = '';
let testRefCode = '';
let testApptId = null;
const testPhone = '9812345678';

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {
          json = body;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n🧪 Starting Direct Appointment & Admin Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  server = app.listen(PORT);
  await new Promise(r => setTimeout(r, 400));

  try {
    // 1. Health
    {
      const res = await makeRequest({ hostname: 'localhost', port: PORT, path: '/api/health', method: 'GET' });
      assert(res.status === 200, 'GET /api/health returns 200');
    }

    // 2. Direct Booking Validation Failure (Short name / invalid phone)
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/appointments',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        name: 'A',
        phone: '123',
        mode: 'In-clinic visit',
        concern: 'Test'
      });
      assert(res.status === 400, 'POST /api/appointments rejects invalid input with 400');
    }

    // 3. Direct Booking Submission (WITHOUT OTP)
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/appointments',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        name: 'Gaurav Verma',
        phone: testPhone,
        email: 'drparsleve@gmail.com',
        mode: 'Online video consultation',
        preferred_date: '2026-09-15',
        preferred_time: 'Morning (10:00 AM – 01:00 PM)',
        concern: 'Severe acid reflux, hyperacidity and gut sluggishness.'
      });
      assert(res.status === 201 && res.body.success === true, 'POST /api/appointments creates appointment directly without OTP (201 Created)');
      testRefCode = res.body.data.reference_code;
      testApptId = res.body.data.id;
    }

    // 4. Tracking Appointment
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/appointments/track/${encodeURIComponent(testRefCode)}`,
        method: 'GET'
      });
      assert(res.status === 200 && res.body.data.reference_code === testRefCode, 'GET /api/appointments/track/:code returns booked appointment');
    }

    // 5. Admin / Staff Login
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/admin/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username: 'paras', password: 'parasleve@123' });
      assert(res.status === 200 && res.body.token, 'POST /api/admin/login authenticates with paras / parasleve@123');
      adminToken = res.body.token;
    }

    // 6. Fetch Appointment by ID
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/admin/appointments/${testApptId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${adminToken}`
        }
      });
      assert(res.status === 200 && res.body.appointment && String(res.body.appointment.id) === String(testApptId), 'GET /api/admin/appointments/:id returns single appointment');
    }

    // 7. Admin Approval
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/admin/appointments/${testApptId}/approve`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        }
      }, {
        confirmed_date: '2026-09-15',
        confirmed_time: 'Exact: 11:00 AM',
        doctor_notes: 'Fast 2 hours prior to Nadi Pariksha.',
        send_email: false
      });
      assert(res.status === 200 && res.body.appointment.status === 'confirmed', 'Admin approval succeeds without OTP dependencies');
    }

    // 8. Case-insensitive Tracking Lookup (lowercased reference code)
    {
      const lowerRef = testRefCode.toLowerCase();
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/appointments/track/${encodeURIComponent(lowerRef)}`,
        method: 'GET'
      });
      assert(
        res.status === 200 && res.body.data && res.body.data.reference_code === testRefCode,
        'GET /api/appointments/track/:code finds appointment using lowercase reference code'
      );
    }

    // 9. Dedicated Status Update: Confirmed -> Completed
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/admin/appointments/${testApptId}/status`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        }
      }, { status: 'completed' });
      assert(
        res.status === 200 && res.body.appointment && res.body.appointment.status === 'completed',
        'PATCH /api/admin/appointments/:id/status updates status to "completed"'
      );
    }

    // 10. Status Alias Normalization: "canceled" -> "cancelled"
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/admin/appointments/${testApptId}/status`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        }
      }, { status: 'canceled' });
      assert(
        res.status === 200 && res.body.appointment && res.body.appointment.status === 'cancelled',
        'PATCH /api/admin/appointments/:id/status normalizes "canceled" to "cancelled"'
      );
    }

    // 11. Reject Invalid Status Value (400 Bad Request)
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/admin/appointments/${testApptId}/status`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        }
      }, { status: 'invalid_status_xyz' });
      assert(
        res.status === 400 && res.body.error,
        'PATCH /api/admin/appointments/:id/status rejects invalid status with 400'
      );
    }

    // 12. Verification: Patient Track Reflects New Status
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/appointments/track/${encodeURIComponent(testRefCode)}`,
        method: 'GET'
      });
      assert(
        res.status === 200 && res.body.data && res.body.data.status === 'cancelled',
        'GET /api/appointments/track/:code reflects persisted status "cancelled"'
      );
    }

    // 13. Submit Patient Review
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/reviews',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        name: 'Sharad Patidar',
        email: 'sharad.test@gmail.com',
        rating: 5,
        category: 'Chronic Digestion & Acidity (GERD, IBS)',
        review_text: 'Excellent treatment from Dr. Paras Leve. Fasting advice and Nadi Pariksha were spot on.'
      });
      assert(
        res.status === 201 && res.body.success === true && res.body.review.patient_name === 'Sharad Patidar',
        'POST /api/reviews submits patient review with 201 Created'
      );
    }

    // 14. Review Validation (Invalid Email & Out of range rating)
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/reviews',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        name: 'T',
        email: 'invalid-email',
        rating: 6,
        review_text: 'Short'
      });
      assert(
        res.status === 400 && res.body.error,
        'POST /api/reviews rejects invalid rating/email with 400'
      );
    }

    // 15. Fetch Public Reviews & Stats
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/reviews',
        method: 'GET'
      });
      assert(
        res.status === 200 && res.body.success && Array.isArray(res.body.reviews) && res.body.stats.total > 0,
        'GET /api/reviews returns approved reviews and aggregate stats'
      );
    }

    // 16. Admin Fetch Reviews
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/admin/reviews',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${adminToken}`
        }
      });
      assert(
        res.status === 200 && res.body.success && res.body.count > 0,
        'GET /api/admin/reviews returns reviews list for admin dashboard'
      );
    }

    // 17. GET /api/appointments/pending
    {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/appointments/pending',
        method: 'GET'
      });
      assert(
        res.status === 200 && res.body.success && Array.isArray(res.body.appointments),
        'GET /api/appointments/pending returns only pending appointments'
      );
      const allPending = res.body.appointments.every(a => a.status === 'pending');
      assert(allPending, 'Every record in /api/appointments/pending has status === "pending"');
    }

    // 18. PUT /api/appointments/confirm/:id (Confirms appointment and archives from pending queue)
    {
      // Create a fresh pending appointment to confirm
      const createRes = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/appointments',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        name: 'Vikas Patel',
        phone: '9876543210',
        email: 'vikas.patel@gmail.com',
        mode: 'In-clinic visit',
        preferred_date: '2026-10-30',
        preferred_time: 'Evening (04:00 PM – 07:00 PM)',
        concern: 'Chronic neck stiffness and cervical spondylosis.'
      });
      assert(createRes.status === 201 && createRes.body.data.id, 'POST /api/appointments creates pending appointment for confirm test');
      const newApptId = createRes.body.data.id;

      // Verify it shows up in pending queue
      const pendingBefore = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/appointments/pending',
        method: 'GET'
      });
      const inPendingBefore = pendingBefore.body.appointments.some(a => String(a.id) === String(newApptId));
      assert(inPendingBefore, 'New appointment is initially present in GET /api/appointments/pending');

      // Call PUT /api/appointments/confirm/:id
      const confirmRes = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/api/appointments/confirm/${encodeURIComponent(newApptId)}`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          confirmed_date: '2026-10-30',
          confirmed_time: '04:30 PM',
          doctor_notes: 'Bring previous cervical spine X-Ray reports.'
        })
      });
      assert(
        confirmRes.status === 200 && confirmRes.body.success && confirmRes.body.appointment.status === 'confirmed',
        'PUT /api/appointments/confirm/:id sets status to "confirmed"'
      );
      assert(
        Boolean(confirmRes.body.appointment.confirmed_timestamp || confirmRes.body.appointment.confirmed_at),
        'PUT /api/appointments/confirm/:id adds permanent confirmed timestamp'
      );

      // Verify it is now removed from pending queue
      const pendingAfter = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/appointments/pending',
        method: 'GET'
      });
      const inPendingAfter = pendingAfter.body.appointments.some(a => String(a.id) === String(newApptId));
      assert(!inPendingAfter, 'Confirmed appointment is automatically removed/archived from GET /api/appointments/pending');
    }

    // 19. POST /api/reviews with reviewer_name and comment fields
    {
      const reviewRes = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/reviews',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        reviewer_name: 'Meena Sharma',
        email: 'meena.sharma@gmail.com',
        rating: 5,
        comment: 'Remarkable healing experience with Dr. Paras Leve. Highly experienced Ayurvedic physician.',
        category: 'Nadi Pariksha & Classical Consultation'
      });
      assert(
        reviewRes.status === 201 && reviewRes.body.success && reviewRes.body.review.reviewer_name === 'Meena Sharma',
        'POST /api/reviews accepts reviewer_name and comment fields permanently'
      );
      assert(
        Boolean(reviewRes.body.review.timestamp || reviewRes.body.review.created_at),
        'POST /api/reviews permanently records timestamp'
      );
    }

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    server.close();
    console.log(`\n📊 Direct Booking & Admin Test Suite Complete: ${passed} Passed, ${failed} Failed\n`);
    if (failed > 0) process.exit(1);
  }
}

runTests();






