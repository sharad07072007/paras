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
      assert(res.status === 200 && res.body.appointment && res.body.appointment.id === testApptId, 'GET /api/admin/appointments/:id returns single appointment');
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
