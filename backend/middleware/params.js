/**
 * Route parameter validation.
 *
 *   const { numericId } = require('../middleware/params');
 *   numericId(router);            // guards :id
 *   numericId(router, 'sheetId'); // guards some other name
 *
 * Every handler that reads a numeric path parameter used to do its own
 * `Number(req.params.id)` and most did not check the result. `Number('abc')` is
 * NaN, and mysql2 renders a bound NaN as the bare token `NaN`, so the query
 * reached MySQL as `WHERE id = NaN` and came back "Unknown column 'NaN' in
 * 'where clause'" — a 500 that quotes our schema, in response to what is simply
 * a bad request.
 *
 * Registered with router.param, so it runs once per router before any handler
 * and cannot be forgotten on the next route added.
 */

/** Digits only: an id is a positive integer, and MySQL AUTO_INCREMENT starts at 1. */
const NUMERIC = /^[1-9]\d{0,17}$/;

function numericId(router, name = 'id') {
  router.param(name, (req, res, next, value) => {
    if (!NUMERIC.test(String(value))) {
      return res.status(400).json({ error: `Invalid ${name}`, code: 'BAD_PARAM' });
    }
    next();
  });
  return router;
}

module.exports = { numericId };
