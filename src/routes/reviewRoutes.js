const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { sanitizeText } = require('../middleware/validator');
const { rateLimiter } = require('../middleware/rateLimiter');
const {
  sendDoctorNewReviewAlert,
  sendPatientReviewAcknowledgement
} = require('../services/notificationService');

const reviewLimiter = rateLimiter({ windowMs: 60 * 1000, max: 10 });

/**
 * POST /api/reviews
 * Submit patient review / testimonial with Gmail notification
 */
router.post('/', reviewLimiter, async (req, res) => {
  try {
    const { name, email, rating, category, review_text } = req.body || {};

    const patientName = sanitizeText(name);
    if (!patientName || patientName.length < 2) {
      return res.status(400).json({ error: 'Please enter your full name (minimum 2 characters).' });
    }

    const patientEmail = (email || '').toString().trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!patientEmail || !emailRegex.test(patientEmail)) {
      return res.status(400).json({ error: 'A valid email address (e.g. Gmail) is required to authenticate your review.' });
    }

    const numRating = parseInt(rating, 10);
    if (isNaN(numRating) || numRating < 1 || numRating > 5) {
      return res.status(400).json({ error: 'Please select a star rating between 1 and 5.' });
    }

    const sanitizedCategory = sanitizeText(category) || 'General Ayurvedic Consultation';
    const sanitizedText = sanitizeText(review_text);
    if (!sanitizedText || sanitizedText.length < 10) {
      return res.status(400).json({ error: 'Please write a helpful review description (at least 10 characters).' });
    }

    const insertStmt = db.prepare(`
      INSERT INTO patient_reviews (
        patient_name,
        patient_email,
        rating,
        treatment_category,
        review_text,
        is_approved
      ) VALUES (?, ?, ?, ?, ?, 1)
    `);

    const result = insertStmt.run(
      patientName,
      patientEmail,
      numRating,
      sanitizedCategory,
      sanitizedText
    );

    const newReview = db.prepare('SELECT * FROM patient_reviews WHERE id = ?').get(result.lastInsertRowid);

    // Dispatch background email alert to Dr. Paras Leve and receipt to patient
    Promise.allSettled([
      sendDoctorNewReviewAlert(newReview).catch(e => console.error('Review alert error:', e.message)),
      sendPatientReviewAcknowledgement(newReview).catch(e => console.error('Patient review ack error:', e.message))
    ]);

    return res.status(201).json({
      success: true,
      message: 'Thank you for your valuable feedback! Your review has been recorded.',
      review: {
        id: newReview.id,
        patient_name: newReview.patient_name,
        rating: newReview.rating,
        treatment_category: newReview.treatment_category,
        review_text: newReview.review_text,
        created_at: newReview.created_at
      }
    });

  } catch (error) {
    console.error('Error submitting review:', error);
    return res.status(500).json({ error: 'Failed to submit review. Please try again.' });
  }
});

/**
 * GET /api/reviews
 * Retrieve public approved patient reviews and aggregate ratings
 */
router.get('/', (req, res) => {
  try {
    const reviews = db.prepare(`
      SELECT id, patient_name, rating, treatment_category, review_text, created_at
      FROM patient_reviews
      WHERE is_approved = 1
      ORDER BY id DESC
      LIMIT 50
    `).all();

    const statsRow = db.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(rating) as average,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_stars,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as four_stars,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as three_stars,
        SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as low_stars
      FROM patient_reviews
      WHERE is_approved = 1
    `).get();

    return res.json({
      success: true,
      stats: {
        total: statsRow.total || 0,
        average: statsRow.average ? parseFloat(statsRow.average.toFixed(1)) : 5.0,
        five_stars: statsRow.five_stars || 0,
        four_stars: statsRow.four_stars || 0,
        three_stars: statsRow.three_stars || 0,
        low_stars: statsRow.low_stars || 0
      },
      reviews
    });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    return res.status(500).json({ error: 'Failed to load patient reviews.' });
  }
});

module.exports = router;
