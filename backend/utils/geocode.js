/**
 * Reverse geocoding — turning a GPS fix into a place name.
 *
 * Source: KL_App_Requirements_FINAL.pdf D.2, "What is Recorded":
 *   "Name of the location or nearest landmark (reverse geocoded from
 *    coordinates)"
 *
 * ---------------------------------------------------------------------------
 * Off by default, and that is a deliberate privacy decision
 * ---------------------------------------------------------------------------
 * Reverse geocoding means sending the exact coordinates of an identified
 * employee to a third party. This app tracks named people continuously during
 * working hours (D.1) and CLAUDE.md already notes that this puts it under
 * privacy rules. Streaming those positions to an external service is a decision
 * for the business, with a named provider and a stated retention position — not
 * something a backend should switch on because a requirement mentions the word
 * "geocoded".
 *
 * So `GEOCODE_ENABLED` defaults to false, and with it off the app uses the
 * place name the client supplies (`gps.place`), recording `gps_place_source` as
 * 'client' so the difference is visible on the order. A salesman who can type
 * the place name can type the wrong one, and Yash reviewing a location needs to
 * know which kind of evidence he is looking at — which is why the source is a
 * column rather than an assumption.
 *
 * When switched on, the provider is Nominatim (OpenStreetMap): no API key, and
 * its usage policy requires an identifying User-Agent, which is set below.
 */

const https = require('https');

function config() {
  return {
    enabled: process.env.GEOCODE_ENABLED === 'true',
    // Overridable so a self-hosted Nominatim can be used instead, which is the
    // right answer for a business that would rather not send staff positions
    // off-site at all.
    host: process.env.GEOCODE_HOST || 'nominatim.openstreetmap.org',
    // Nominatim's policy requires a real contact address in the User-Agent and
    // will block a generic one.
    userAgent: process.env.GEOCODE_USER_AGENT
      || 'KLElectricalsApp/1.0 (klelectricals@gmail.com)',
    timeoutMs: Number(process.env.GEOCODE_TIMEOUT_MS || 4000),
  };
}

/**
 * A tiny in-process cache.
 *
 * Coordinates are rounded to about 11 metres before lookup. A salesman standing
 * at a dealer's counter for twenty minutes produces dozens of fixes within a
 * few metres of each other, and asking a free public service the same question
 * fifty times is both slow and rude. Rounding also blunts the precision of what
 * leaves the building, which is a small privacy gain for nothing.
 */
const cache = new Map();
const CACHE_MAX = 500;
const key = (lat, lng) => `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;

/**
 * Resolve a place name, or return null.
 *
 * Never throws and never blocks for long: this is a nice-to-have string on an
 * order, and an order must not fail — or wait four seconds — because a mapping
 * service is slow. Every failure path returns null and the caller falls back to
 * whatever the client sent.
 */
async function reverse(lat, lng) {
  const cfg = config();
  if (!cfg.enabled) return null;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;

  const k = key(lat, lng);
  if (cache.has(k)) return cache.get(k);

  const place = await new Promise((resolve) => {
    const path = `/reverse?format=jsonv2&lat=${Number(lat).toFixed(4)}`
      + `&lon=${Number(lng).toFixed(4)}&zoom=18&addressdetails=1`;

    const req = https.request({
      host: cfg.host,
      path,
      method: 'GET',
      headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json' },
      timeout: cfg.timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const body = JSON.parse(text);
          const a = body.address || {};
          // "Name of the location or nearest landmark" — the most specific
          // useful component first. A full postal address is not a landmark and
          // is not what "Basistha, near Sharma Electricals" looks like.
          const parts = [
            body.name || a.amenity || a.shop || a.building,
            a.neighbourhood || a.suburb || a.village || a.town || a.city_district,
            a.city || a.state_district,
          ].filter(Boolean);
          const unique = [...new Set(parts)];
          return resolve(unique.length ? unique.slice(0, 2).join(', ').slice(0, 160) : null);
        } catch {
          return resolve(null);
        }
      });
    });

    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, place);
  return place;
}

/**
 * The place name for an order, and where it came from.
 *
 * Returns `{ place, source }`. A server-side geocode wins over a
 * client-supplied string — it is the stronger evidence, and D.2 exists so that
 * "Yash can view, for any order, exactly where the salesman was". If geocoding
 * is off or fails, the client's string is used and labelled as such.
 */
async function placeFor({ lat, lng, clientPlace }) {
  const geocoded = await reverse(lat, lng);
  if (geocoded) return { place: geocoded, source: 'geocoded' };
  if (clientPlace) return { place: String(clientPlace).slice(0, 160), source: 'client' };
  return { place: null, source: null };
}

module.exports = { config, reverse, placeFor };
