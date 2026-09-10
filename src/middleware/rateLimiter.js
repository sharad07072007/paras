/**
 * Simple in-memory rate limiter
 */
const requests = new Map();

function rateLimiter({ windowMs = 60000, max = 40, message = 'Too many requests, please try again shortly.' } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    const record = requests.get(ip) || [];
    // Filter out requests older than window
    const recent = record.filter(timestamp => now - timestamp < windowMs);

    if (recent.length >= max) {
      return res.status(429).json({
        error: message,
        retryAfterSeconds: Math.ceil((recent[0] + windowMs - now) / 1000)
      });
    }

    recent.push(now);
    requests.set(ip, recent);

    // Periodic cleanup
    if (requests.size > 5000) {
      for (const [key, timestamps] of requests.entries()) {
        if (timestamps.length === 0 || now - timestamps[timestamps.length - 1] > windowMs) {
          requests.delete(key);
        }
      }
    }

    next();
  };
}

module.exports = { rateLimiter };
