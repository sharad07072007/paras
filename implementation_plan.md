# Implementation Plan - Patient Review System & GitHub Synchronization

Implement a patient review section above the footer on the public website allowing patients to submit reviews with their Gmail, notify the doctor via Gmail, provide a direct Google Review button, and commit & push all changes to GitHub (`sharad07072007/paras`).

## User Review Required

> [!IMPORTANT]
> - Review submissions will be stored in SQLite and will immediately trigger an automated email notification to Dr. Paras Leve's Gmail (`drparasleve@gmail.com`) using the existing Gmail SMTP service.
> - A direct "Review on Google (via Gmail)" link will be provided alongside the form so patients can also post publicly to Google Maps / Google Business.
> - After implementation and test verification, all changes will be committed and pushed to the GitHub repository (`origin main`).

---

## Proposed Changes

### Database Layer

#### [MODIFY] [src/db/database.js](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/src/db/database.js)
- Create `patient_reviews` table with schema:
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `patient_name` TEXT NOT NULL
  - `patient_email` TEXT NOT NULL
  - `rating` INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5)
  - `treatment_category` TEXT DEFAULT ''
  - `review_text` TEXT NOT NULL
  - `is_approved` INTEGER DEFAULT 1
  - `created_at` TEXT DEFAULT (datetime('now', 'localtime'))

#### [MODIFY] [src/db/seed.js](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/src/db/seed.js)
- Seed initial authentic Ayurvedic patient reviews if empty so the section displays established testimonials immediately.

---

### Notification Service

#### [MODIFY] [src/services/notificationService.js](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/src/services/notificationService.js)
- Add `sendDoctorNewReviewAlert(review)`:
  - Dispatches an email alert to `drparasleve@gmail.com` with review details, star rating, treatment type, and patient Gmail.
- Add `sendPatientReviewAcknowledgement(review)`:
  - Sends a warm thank-you email receipt to the patient's Gmail.

---

### Backend API Layer

#### [NEW] [src/routes/reviewRoutes.js](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/src/routes/reviewRoutes.js)
- `POST /api/reviews`:
  - Validates name, email format, rating (1-5), and review comment.
  - Inserts into `patient_reviews`.
  - Dispatches Gmail notifications.
- `GET /api/reviews`:
  - Returns approved reviews and aggregate rating score.

#### [MODIFY] [server.js](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/server.js)
- Mount `app.use('/api/reviews', reviewRoutes);`.

#### [MODIFY] [src/routes/adminRoutes.js](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/src/routes/adminRoutes.js)
- Add `GET /api/admin/reviews` to list all reviews in the admin dashboard.

---

### Frontend UI Layer

#### [MODIFY] [public/index.html](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/public/index.html)
- Insert `#reviewsSection` directly above `<footer>`:
  - **Left Card: Submit a Review**:
    - Interactive 5-star rating widget (⭐) with hover effects.
    - Patient Name input.
    - Patient Gmail / Email input.
    - Treatment category selector (Digestive / Acidity, Joint / Spine Pain, Skin & Hair, Lifestyle / Metabolic, General Consultation).
    - Review feedback text area.
    - "Submit Review" button with real-time feedback toast.
    - "Write a Google Review (via Gmail / Google Account)" external action button.
  - **Right Card: Patient Testimonials Showcase**:
    - Average clinic rating summary (e.g. 4.9/5 stars).
    - Live list of patient review cards with avatars, star badges, and treatment tags.
    - Dynamic append of new reviews upon submission.

#### [MODIFY] [public/admin.html](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/public/admin.html)
- Add a "Patient Reviews" tab / section in the admin portal to inspect received reviews.

---

### GitHub Synchronization

- Verify all tests pass with `npm test`.
- Stage all modified and new files: `git add .`
- Commit with a descriptive message.
- Push to GitHub: `git push origin main`.

---

## Verification Plan

### Automated Tests
- Add review API tests to [test/api.test.js](file:///c:/Users/Asus/PARAS%20LEVE%20FINAL/paras/test/api.test.js):
  - `POST /api/reviews` validation and creation.
  - `GET /api/reviews` fetching reviews.
- Run `npm test`.

### Manual & Git Verification
- Submit a review from the web UI; verify email dispatch and dynamic UI update.
- Verify `git status` and `git log` confirming successful push to GitHub.
