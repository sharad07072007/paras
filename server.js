const express = require('express');
const cors = require('cors');
const path = require('node:path');
require('dotenv').config();

const { seed } = require('./src/db/seed');
const appointmentRoutes = require('./src/routes/appointmentRoutes');
const adminRoutes = require('./src/routes/adminRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Security & Parsing Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '120kb' }));
app.use(express.urlencoded({ extended: true, limit: '120kb' }));

// Custom basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Simple request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!req.url.startsWith('/css/') && !req.url.startsWith('/js/') && !req.url.endsWith('.png') && !req.url.endsWith('.svg')) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Static assets (serves public frontend)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Healthcheck API
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    clinic: 'Dr. Paras Leve - Ayurvedic Clinic API',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/appointments', appointmentRoutes);
app.use('/api/admin', adminRoutes);

// Fallback for API routes (404)
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `API route '${req.originalUrl}' not found.` });
});

// Fallback for SPA/HTML navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON payload.' });
  }
  return res.status(500).json({
    error: 'Internal server error.',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Auto-seed if database is newly initialized
try {
  seed();
} catch (e) {
  console.warn('Seed notice:', e.message);
}

// Start Server (only in standalone Node.js environments, NOT under Vercel serverless runtime)
if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🌿 Dr. Paras Leve - Ayurvedic Physician Backend`);
    console.log(`🚀 Server running at: http://localhost:${PORT}`);
    console.log(`📋 Patient Portal:    http://localhost:${PORT}/`);
    console.log(`🩺 Admin Portal:      http://localhost:${PORT}/admin.html`);
    console.log(`🔑 Staff/Doctor Login: paras / parasleve@123`);
    console.log(`🏥 Health Check:      http://localhost:${PORT}/api/health`);
    console.log('====================================================');
  });
}

module.exports = app;

