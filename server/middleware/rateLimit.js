// Small in-memory limiter for auth endpoints. Enough for a demo/single process;
// use something like rate-limiter-flexible + Redis in production.
const attempts = new Map();

function rateLimit({ max = 10, windowMs = 10 * 60 * 1000 } = {}) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = attempts.get(key) || { count: 0, resetAt: now + windowMs };

    if (now >= entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    attempts.set(key, entry);

    // Periodic cleanup so the map does not grow forever.
    if (attempts.size > 1000) {
      for (const [k, v] of attempts) if (now >= v.resetAt) attempts.delete(k);
    }

    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      return res.status(429).json({ error: `Too many attempts. Try again in ${seconds}s` });
    }
    next();
  };
}

module.exports = { rateLimit };
