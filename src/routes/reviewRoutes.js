const express = require('express');
const router = express.Router();
const { createReview, getAllReviews } = require('../db/firestore');
const { sanitizeText } = require('../middleware/validator');
const { rateLimiter } = require('../middleware/rateLimiter');
const {
  sendDoctorNewReviewAlert,
  sendPatientReviewAcknowledgement
} = require('../services/notificationService');

const reviewLimiter = rateLimiter({ windowMs: 60 * 1000, max: 20 });

/**
 * POST /api/reviews
 * Submit patient review / testimonial with permanent Google Cloud Firestore storage
 */
router.post('/', reviewLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const rawName = body.reviewer_name || body.name || body.patient_name;
    const patientName = sanitizeText(rawName);

    if (!patientName || patientName.length < 2) {
      return res.status(400).json({ error: 'Please enter your full name (minimum 2 characters).' });
    }

    const rawEmail = body.email || body.patient_email || '';
    const patientEmail = rawEmail.toString().trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!patientEmail || !emailRegex.test(patientEmail)) {
      return res.status(400).json({ error: 'A valid email address (e.g. Gmail) is required to authenticate your review.' });
    }

    const numRating = parseInt(body.rating, 10);
    if (isNaN(numRating) || numRating < 1 || numRating > 5) {
      return res.status(400).json({ error: 'Please select a star rating between 1 and 5.' });
    }

    const rawCategory = body.category || body.treatment_category;
    const sanitizedCategory = sanitizeText(rawCategory) || 'General Ayurvedic Consultation';

    const rawComment = body.comment || body.review_text;
    const sanitizedComment = sanitizeText(rawComment);
    if (!sanitizedComment || sanitizedComment.length < 10) {
      return res.status(400).json({ error: 'Please write a helpful review description (at least 10 characters).' });
    }

    // Save permanently to Google Cloud Firestore
    const newReview = await createReview({
      reviewer_name: patientName,
      name: patientName,
      patient_name: patientName,
      patient_email: patientEmail,
      email: patientEmail,
      rating: numRating,
      treatment_category: sanitizedCategory,
      category: sanitizedCategory,
      comment: sanitizedComment,
      review_text: sanitizedComment,
      is_approved: true
    });

    // Dispatch background email alert to Dr. Paras Leve and receipt to patient
    Promise.allSettled([
      sendDoctorNewReviewAlert(newReview).catch(e => console.error('[Review Alert] Error:', e.message)),
      sendPatientReviewAcknowledgement(newReview).catch(e => console.error('[Patient Review Ack] Error:', e.message))
    ]);

    return res.status(201).json({
      success: true,
      message: 'Thank you for your valuable feedback! Your review has been recorded permanently.',
      review: {
        id: newReview.id,
        reviewer_name: newReview.reviewer_name,
        name: newReview.name,
        patient_name: newReview.patient_name,
        rating: newReview.rating,
        treatment_category: newReview.treatment_category,
        category: newReview.category,
        comment: newReview.comment,
        review_text: newReview.review_text,
        timestamp: newReview.timestamp,
        created_at: newReview.created_at
      }
    });

  } catch (error) {
    console.error('Error submitting review to Firestore:', error);
    return res.status(500).json({ error: 'Failed to submit review. Please try again.' });
  }
});

/**
 * GET /api/reviews
 * Retrieve public patient reviews from Firestore ordered by creation date
 */
router.get('/', async (req, res) => {
  try {
    const { reviews, stats } = await getAllReviews();

    return res.json({
      success: true,
      count: reviews.length,
      stats,
      reviews
    });
  } catch (error) {
    console.error('Error fetching reviews from Firestore:', error);
    return res.status(500).json({ error: 'Failed to load patient reviews.' });
  }
});

module.exports = router;
