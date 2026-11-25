const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const items = db
    .prepare('SELECT * FROM announcements ORDER BY created_at DESC')
    .all();
  res.json({ items });
});

router.post('/', requireAuth, requireRole('admin', 'staff'), (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  if (title.length > 120 || body.length > 2000) {
    return res.status(400).json({ error: 'Title max 120 chars, body max 2000 chars' });
  }

  const result = db
    .prepare('INSERT INTO announcements (title, body, posted_by) VALUES (?, ?, ?)')
    .run(title, body, req.user.name);

  res.status(201).json({ id: result.lastInsertRowid });
});

module.exports = router;
