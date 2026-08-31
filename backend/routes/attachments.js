/**
 * File capture — delivery photos, and anything else the field sends up.
 *
 *   POST /api/attachments        upload one (JSON, base64 body)
 *   GET  /api/attachments/:name  read one back
 *
 * Uploads arrive as base64 inside JSON rather than multipart. The API takes no
 * other content type and has no multipart dependency; adding one for a single
 * route, on a phone that already has the image as a data URI from
 * expo-image-picker, buys nothing. `express.json` is already capped, and the cap
 * is raised only for this router.
 *
 * Files are served through this route, never a static mount. They are
 * photographs of identified people's premises: a public /uploads directory would
 * make the whole delivery history readable to anyone who guessed a filename, and
 * this app is already subject to the GPS-tracking privacy rules.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Created at load rather than per request: a missing directory is a deployment
// fact, and finding out on the first delivery of the day is too late.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * What the camera actually produces, and nothing else.
 *
 * An allow-list, not a block-list: the extension is derived from this map rather
 * than from the client's filename, so a request cannot name its upload
 * `proof.html` and have it served back as markup from our origin.
 */
const TYPES = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

// A phone photo is well under this; the cap is what stops a single request
// filling the disk. Applied to the decoded bytes, not the base64 text.
const MAX_BYTES = 8 * 1024 * 1024;

router.use(authenticate);

// The default limit is 1mb, which a camera JPEG clears immediately. Raised for
// this router alone so the rest of the API keeps the smaller cap.
router.use(express.json({ limit: '12mb' }));

// POST /api/attachments
router.post('/', async (req, res, next) => {
  const { data, mime_type, original_name, ref_type, ref_id } = req.body || {};

  if (!data || typeof data !== 'string') {
    return res.status(400).json({ error: 'A base64 `data` field is required' });
  }
  const extension = TYPES[String(mime_type || '').toLowerCase()];
  if (!extension) {
    return res.status(400).json({
      error: `mime_type must be one of ${Object.keys(TYPES).join(', ')}`,
      code: 'BAD_TYPE',
    });
  }

  // Tolerates a full data URI as well as bare base64, because that is what
  // expo-image-picker hands back depending on how it is asked.
  const payload = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;

  let bytes;
  try {
    bytes = Buffer.from(payload, 'base64');
  } catch {
    return res.status(400).json({ error: 'data is not valid base64' });
  }

  if (!bytes.length) return res.status(400).json({ error: 'The file is empty' });
  if (bytes.length > MAX_BYTES) {
    return res.status(413).json({
      error: `That file is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 8 MB.`,
      code: 'TOO_LARGE',
    });
  }

  // Random, not derived from the client's name: a predictable filename on a
  // route that serves files is a way to read somebody else's delivery photo.
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${extension}`;

  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, storedName), bytes);

    const [result] = await pool.query(
      `INSERT INTO attachments
         (stored_name, original_name, mime_type, byte_size, ref_type, ref_id, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        storedName,
        original_name ? String(original_name).slice(0, 255) : null,
        mime_type,
        bytes.length,
        ref_type || null,
        ref_id ? Number(ref_id) : null,
        req.user.id,
      ]
    );

    res.status(201).json({
      message: 'Uploaded',
      attachment_id: result.insertId,
      // What the caller stores on the delivery: deliveries.photo_ref.
      photo_ref: storedName,
      byte_size: bytes.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attachments/:name
router.get('/:name', async (req, res, next) => {
  const name = String(req.params.name);

  // The name must be exactly what we generated. Validated by shape rather than
  // by resolving the path and comparing prefixes: `..%2f` and friends never get
  // as far as the filesystem this way.
  if (!/^[0-9a-f]{32}\.(jpg|png|webp|heic)$/.test(name)) {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  try {
    const [[row]] = await pool.query(
      'SELECT stored_name, mime_type FROM attachments WHERE stored_name = ?',
      [name]
    );
    if (!row) return res.status(404).json({ error: 'No such file' });

    const filePath = path.join(UPLOAD_DIR, row.stored_name);
    if (!fs.existsSync(filePath)) {
      // The row outlived the file — worth saying plainly rather than serving a
      // zero-byte image the viewer will read as a broken camera.
      return res.status(410).json({ error: 'That file is no longer on disk', code: 'GONE' });
    }

    res.type(row.mime_type || 'application/octet-stream');
    // Private: these are per-party photographs, and a shared cache must not hold
    // one where the next viewer can be handed it.
    res.set('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
