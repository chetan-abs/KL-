/**
 * A fixed-window request brake, in process, with no dependency.
 *
 *   router.post('/log', rateLimit({ max: 120, windowMs: 60_000 }), handler)
 *
 * The login route had a throttle of its own and nothing else had any, which
 * left every write endpoint — including the GPS ping, whose table is the only
 * one with no natural ceiling — open to an unbounded stream from a single
 * token. This is the same speed bump generalised.
 *
 * It is deliberately modest about what it is: state lives in this process, so
 * it survives neither a restart nor a second instance. A real limiter backed by
 * Redis is still what belongs in front of a deployment. What this does buy is a
 * ceiling on accidental floods (a client stuck in a retry loop) and on casual
 * abuse from an authenticated account.
 */

/**
 * Callers are keyed by authenticated user where there is one, and by IP
 * otherwise. Keying an authenticated route on IP alone would let one bad client
 * lock out a whole office behind a shared NAT.
 */
function defaultKey(req) {
  return req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
}

function rateLimit({ max = 60, windowMs = 60_000, key = defaultKey, message } = {}) {
  const hits = new Map();

  // Bounded so a long-running process cannot accumulate an entry per caller
  // that ever appeared. unref'd so it never holds the process open at shutdown.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, rec] of hits) if (rec.first < cutoff) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return function limiter(req, res, next) {
    const id = key(req);
    const now = Date.now();
    const rec = hits.get(id);

    if (!rec || now - rec.first > windowMs) {
      hits.set(id, { count: 1, first: now });
      return next();
    }

    rec.count++;
    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.first + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || 'Too many requests. Slow down and try again.',
        retryAfter,
      });
    }

    next();
  };
}

module.exports = { rateLimit };
