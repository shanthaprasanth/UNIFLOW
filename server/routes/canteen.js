const express = require('express');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const PICKUP_WINDOW_MINUTES = 40;
const PAYMENT_WINDOW_MINUTES = 15;
const MAX_QTY_PER_ITEM = 50;

function inMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function isPast(value) {
  return Boolean(value) && new Date(value).getTime() <= Date.now();
}

function restoreStock(orderId) {
  const items = db.prepare('SELECT menu_item_id, qty FROM order_items WHERE order_id = ?').all(orderId);
  const update = db.prepare(
    'UPDATE menu_items SET stock_quantity = stock_quantity + ?, available = 1 WHERE id = ? AND stock_quantity IS NOT NULL'
  );
  for (const item of items) update.run(item.qty, item.menu_item_id);
}

function expireOrder(order) {
  if (order.status === 'pending' && isPast(order.reservation_expires_at)) {
    db.transaction(() => {
      db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(order.id);
      restoreStock(order.id);
    })();
    return true;
  }
  if (order.status === 'paid' && isPast(order.expires_at)) {
    db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'paid'").run(order.id);
    return true;
  }
  return false;
}

// Lazy expiry: no background job needed for this demo.
function expireStaleOrders() {
  const orders = db.prepare("SELECT * FROM orders WHERE status IN ('pending', 'paid')").all();
  for (const order of orders) expireOrder(order);
}

// ---- Menu ----
router.get('/menu', requireAuth, (req, res) => {
  expireStaleOrders();
  const items = db.prepare('SELECT * FROM menu_items WHERE available = 1 ORDER BY category, id').all();
  res.json({ items });
});

// ---- Staff: menu management ----
router.get('/staff/menu', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  // Includes sold-out items so staff can restock and edit them.
  const items = db.prepare('SELECT * FROM menu_items ORDER BY category, id').all();
  res.json({ items });
});

function parseMenuBody(body) {
  const { name, price, category, stockQuantity } = body;
  const validCategories = ['Food & Meals', 'Snacks & Beverages'];
  const numericPrice = Number(price);
  const stock = stockQuantity === '' || stockQuantity === null || stockQuantity === undefined
    ? null : Number(stockQuantity);

  if (!String(name || '').trim() || !Number.isFinite(numericPrice) || numericPrice < 0 || !validCategories.includes(category)) {
    return { error: 'Name, valid price, and category are required' };
  }
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) {
    return { error: 'Stock quantity must be a whole number of 0 or more' };
  }
  return { name: String(name).trim(), price: numericPrice, category, stock };
}

router.post('/staff/menu', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const values = parseMenuBody(req.body);
  if (values.error) return res.status(400).json({ error: values.error });

  const result = db.prepare(
    'INSERT INTO menu_items (name, price, category, stock_quantity, available) VALUES (?, ?, ?, ?, ?)'
  ).run(values.name, values.price, values.category, values.stock, values.stock === 0 ? 0 : 1);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/staff/menu/:id', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const values = parseMenuBody(req.body);
  if (values.error) return res.status(400).json({ error: values.error });

  const result = db.prepare(
    'UPDATE menu_items SET name = ?, price = ?, category = ?, stock_quantity = ?, available = ? WHERE id = ?'
  ).run(values.name, values.price, values.category, values.stock, values.stock === 0 ? 0 : 1, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Menu item not found' });
  res.json({ ok: true });
});

// ---- Create order (status: pending, not paid yet) ----
router.post('/orders', requireAuth, (req, res) => {
  const { items } = req.body; // [{ menuItemId, qty }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  // Combine repeated lines for the same item before checking stock.
  const quantities = new Map();
  for (const it of items) {
    const menuItemId = Number(it.menuItemId);
    const qty = Number(it.qty);
    if (!Number.isInteger(menuItemId) || menuItemId < 1) {
      return res.status(400).json({ error: 'Invalid menu item id' });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
      return res.status(400).json({ error: `Quantity must be between 1 and ${MAX_QTY_PER_ITEM}` });
    }
    quantities.set(menuItemId, (quantities.get(menuItemId) || 0) + qty);
  }

  const paymentExpiresAt = inMinutes(PAYMENT_WINDOW_MINUTES);
  let orderId;
  let total;
  try {
    ({ orderId, total } = db.transaction(() => {
      let runningTotal = 0;
      const resolvedItems = [];

      for (const [menuItemId, qty] of quantities) {
        const menuItem = db
          .prepare('SELECT * FROM menu_items WHERE id = ? AND available = 1')
          .get(menuItemId);
        if (!menuItem) {
          const error = new Error(`Menu item ${menuItemId} not available`);
          error.status = 400;
          throw error;
        }
        if (menuItem.stock_quantity !== null && qty > menuItem.stock_quantity) {
          const error = new Error(`Only ${menuItem.stock_quantity} ${menuItem.name} remaining`);
          error.status = 400;
          throw error;
        }
        runningTotal += menuItem.price * qty;
        resolvedItems.push({ menuItemId, qty, priceEach: menuItem.price });
      }

      const result = db
        .prepare('INSERT INTO orders (user_id, total, status, reservation_expires_at) VALUES (?, ?, ?, ?)')
        .run(req.user.id, runningTotal, 'pending', paymentExpiresAt);
      const newOrderId = Number(result.lastInsertRowid);

      const insertItem = db.prepare(
        'INSERT INTO order_items (order_id, menu_item_id, qty, price_each) VALUES (?, ?, ?, ?)'
      );
      for (const ri of resolvedItems) {
        insertItem.run(newOrderId, ri.menuItemId, ri.qty, ri.priceEach);
        const stockRow = db.prepare('SELECT stock_quantity FROM menu_items WHERE id = ?').get(ri.menuItemId);
        if (stockRow.stock_quantity !== null) {
          const nextStock = stockRow.stock_quantity - ri.qty;
          db.prepare('UPDATE menu_items SET stock_quantity = ?, available = ? WHERE id = ?')
            .run(nextStock, nextStock > 0 ? 1 : 0, ri.menuItemId);
        }
      }
      return { orderId: newOrderId, total: runningTotal };
    })());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  res.json({ orderId, total, status: 'pending', paymentExpiresAt });
});

// ---- Mock payment ----
// In a real system this would verify a payment gateway webhook/signature.
// Here we simulate success and issue a signed, single-use, time-boxed QR token.
router.post('/orders/:id/pay', requireAuth, (req, res) => {
  expireStaleOrders();
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') {
    return res.status(400).json({ error: `Order is ${order.status}, not available for payment` });
  }

  const expiresAt = new Date(Date.now() + PICKUP_WINDOW_MINUTES * 60 * 1000);
  const jti = crypto.randomUUID();
  const qrToken = jwt.sign(
    { orderId: order.id, jti },
    process.env.QR_SECRET,
    { expiresIn: `${PICKUP_WINDOW_MINUTES}m` }
  );

  // Store the exact token so re-downloading the QR cannot extend its expiry.
  db.prepare(
    `UPDATE orders
     SET status = 'paid', qr_token = ?, qr_token_value = ?, paid_at = datetime('now'),
         expires_at = ?, reservation_expires_at = NULL
     WHERE id = ?`
  ).run(jti, qrToken, expiresAt.toISOString(), order.id);

  res.json({ orderId: order.id, status: 'paid', qrToken, expiresAt: expiresAt.toISOString() });
});

// ---- Get QR image (PNG data URL) for a paid order, owned by the logged-in user ----
router.get('/orders/:id/qr', requireAuth, async (req, res, next) => {
  expireStaleOrders();
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'paid') {
    return res.status(400).json({ error: `QR only available for paid orders (status: ${order.status})` });
  }

  let token = order.qr_token_value;
  if (!token) {
    // Legacy order from before qr_token_value existed: issue a token that
    // expires with the existing deadline, never a fresh 40-minute window.
    const secondsLeft = Math.ceil((new Date(order.expires_at).getTime() - Date.now()) / 1000);
    if (secondsLeft <= 0) {
      expireStaleOrders();
      return res.status(400).json({ error: 'Order has expired' });
    }
    token = jwt.sign(
      { orderId: order.id, jti: order.qr_token },
      process.env.QR_SECRET,
      { expiresIn: secondsLeft }
    );
    db.prepare('UPDATE orders SET qr_token_value = ? WHERE id = ?').run(token, order.id);
  }

  try {
    const dataUrl = await QRCode.toDataURL(token);
    res.json({ dataUrl, expiresAt: order.expires_at });
  } catch (err) {
    next(err);
  }
});

// ---- Order status (for polling the checkout/QR page) ----
router.get('/orders/:id', requireAuth, (req, res) => {
  expireStaleOrders();
  const order = db
    .prepare('SELECT id, status, total, created_at, paid_at, expires_at, reservation_expires_at, picked_up_at, cancelled_at FROM orders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

// ---- Student: list all of their own orders, newest first ----
router.get('/my/orders', requireAuth, (req, res) => {
  expireStaleOrders();
  const orders = db.prepare(
    `SELECT id, status, total, created_at, paid_at, expires_at, reservation_expires_at,
            picked_up_at, cancelled_at
     FROM orders WHERE user_id = ? ORDER BY id DESC`
  ).all(req.user.id);

  const getItems = db.prepare(
    `SELECT mi.name, oi.qty, oi.price_each
     FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE oi.order_id = ?`
  );

  res.json({ orders: orders.map(order => ({ ...order, items: getItems.all(order.id) })) });
});

// ---- Student: cancel an order before it has been picked up ----
router.post('/orders/:id/cancel', requireAuth, (req, res) => {
  expireStaleOrders();
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['pending', 'paid'].includes(order.status)) {
    return res.status(400).json({ error: `Order is ${order.status} and cannot be cancelled` });
  }

  try {
    db.transaction(() => {
      const update = db.prepare(
        "UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'), qr_token_value = NULL WHERE id = ? AND status IN ('pending', 'paid')"
      ).run(order.id);
      if (update.changes === 0) throw new Error('Order can no longer be cancelled');
      // The stock was reserved when the order was created; give it back.
      restoreStock(order.id);
    })();
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  res.json({ ok: true, orderId: order.id, status: 'cancelled' });
});

// ---- Staff: view the canteen order queue ----
// Kept separate from the student order endpoint so students can never see
// other students' orders.
router.get('/staff/orders', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  expireStaleOrders();
  const orders = db.prepare(
    `SELECT o.id, o.total, o.status, o.created_at, o.paid_at, o.expires_at, o.picked_up_at, o.cancelled_at,
            u.name AS student_name, u.email AS student_email
     FROM orders o
     JOIN users u ON u.id = o.user_id
     ORDER BY o.id DESC`
  ).all();

  const getItems = db.prepare(
    `SELECT mi.name, oi.qty, oi.price_each
     FROM order_items oi
     JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE oi.order_id = ?`
  );

  res.json({
    orders: orders.map(order => ({ ...order, items: getItems.all(order.id) }))
  });
});

// ---- Staff: verify & redeem a scanned QR token ----
// Signature check, expiry check, exact-token/single-use check (replay rejected).
router.post('/verify', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  expireStaleOrders();
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.QR_SECRET);
  } catch (err) {
    const reason = err.name === 'TokenExpiredError' ? 'expired' : 'invalid_signature';
    return res.status(400).json({ error: 'Invalid or expired QR code', reason });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payload.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'picked_up') {
    return res.status(409).json({ error: 'This code was already redeemed', reason: 'replay' });
  }
  if (order.status === 'expired') {
    return res.status(400).json({ error: 'This order has expired', reason: 'expired' });
  }
  if (order.status !== 'paid') {
    return res.status(400).json({ error: `Order is ${order.status}, not ready for pickup` });
  }

  // New orders: the scanned token must be byte-for-byte the one we issued.
  // Legacy orders: fall back to matching the stored jti.
  const tokenMatches = order.qr_token_value
    ? token === order.qr_token_value && payload.jti === order.qr_token
    : payload.jti === order.qr_token;
  if (!tokenMatches) {
    return res.status(400).json({ error: 'Token does not match this order', reason: 'jti_mismatch' });
  }

  const update = db.prepare(
    "UPDATE orders SET status = 'picked_up', picked_up_at = datetime('now') WHERE id = ? AND status = 'paid'"
  ).run(order.id);
  if (update.changes === 0) {
    return res.status(409).json({ error: 'This code was already redeemed', reason: 'replay' });
  }

  const items = db
    .prepare(
      `SELECT mi.name, oi.qty, oi.price_each
       FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.order_id = ?`
    )
    .all(order.id);

  const student = db.prepare('SELECT name, email FROM users WHERE id = ?').get(order.user_id);

  res.json({
    status: 'redeemed',
    orderId: order.id,
    student,
    items,
    total: order.total
  });
});

module.exports = router;
