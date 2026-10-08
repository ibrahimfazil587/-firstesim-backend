const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'CHANGE_THIS_ADMIN_KEY';

const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');

fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const dbFile = path.join(dataDir, 'orders.json');
const pushFile = path.join(dataDir, 'push-subscriptions.json');
const vapidFile = path.join(dataDir, 'vapid.json');

if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '[]');
if (!fs.existsSync(pushFile)) fs.writeFileSync(pushFile, '[]');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readOrders() {
  return readJson(dbFile, []);
}

function saveOrders(value) {
  writeJson(dbFile, value);
}

function readSubs() {
  return readJson(pushFile, []);
}

function saveSubs(value) {
  writeJson(pushFile, value);
}

let vapid = readJson(vapidFile, null);

if (!vapid || !vapid.publicKey || !vapid.privateKey) {
  vapid = webpush.generateVAPIDKeys();
  writeJson(vapidFile, vapid);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@firstesim.net',
  vapid.publicKey,
  vapid.privateKey
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (
    origin === 'https://firstesim.net' ||
    origin === 'https://www.firstesim.net' ||
    origin?.endsWith('.github.io')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,DELETE,OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,x-admin-key'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: uploadsDir,

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);

    cb(
      null,
      Date.now() +
        '-' +
        crypto.randomBytes(5).toString('hex') +
        ext
    );
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

function adminOnly(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  next();
}


/* =========================
   PUSH NOTIFICATION
========================= */

async function notifyAdmins(order) {
  const subs = readSubs();

  if (!subs.length) return;

  const payload = JSON.stringify({
    title: 'FirstESIM — Order نوێ 🔔',

    body:
      `${order.id} — ` +
      `${order.country} — ` +
      `${order.plan} — ` +
      `${order.price}`,

    url:
      `/admin.html?order=${encodeURIComponent(order.id)}`,

    orderId: order.id,

    tag: 'order-' + order.id
  });

  const keep = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      keep.push(sub);

    } catch (err) {

      if (err.statusCode !== 404 && err.statusCode !== 410) {
        keep.push(sub);

        console.error(
          'Push send error:',
          err.message
        );
      }
    }
  }

  saveSubs(keep);
}


/* =========================
   HEALTH
========================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true
  });
});


/* =========================
   PUSH PUBLIC KEY
========================= */

app.get(
  '/api/admin/push/public-key',
  adminOnly,
  (req, res) => {

    res.json({
      ok: true,
      publicKey: vapid.publicKey
    });
  }
);


/* =========================
   PUSH SUBSCRIBE
========================= */

app.post(
  '/api/admin/push/subscribe',
  adminOnly,
  (req, res) => {

    const sub = req.body?.subscription;

    if (
      !sub ||
      typeof sub !== 'object' ||
      !sub.endpoint ||
      !sub.keys ||
      !sub.keys.p256dh ||
      !sub.keys.auth
    ) {

      return res.status(400).json({
        error: 'Invalid subscription',

        details:
          'endpoint, keys.p256dh and keys.auth are required'
      });
    }

    const cleanSub = {
      endpoint: sub.endpoint,

      expirationTime:
        sub.expirationTime ?? null,

      keys: {
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth
      }
    };

    const subs = readSubs();

    const index = subs.findIndex(
      x => x.endpoint === cleanSub.endpoint
    );

    if (index >= 0) {
      subs[index] = cleanSub;
    } else {
      subs.push(cleanSub);
    }

    saveSubs(subs);

    res.json({
      ok: true
    });
  }
);


/* =========================
   PUSH UNSUBSCRIBE
========================= */

app.post(
  '/api/admin/push/unsubscribe',
  adminOnly,
  (req, res) => {

    const endpoint = req.body?.endpoint;

    if (!endpoint) {
      return res.status(400).json({
        error: 'Endpoint required'
      });
    }

    saveSubs(
      readSubs().filter(
        x => x.endpoint !== endpoint
      )
    );

    res.json({
      ok: true
    });
  }
);


/* =========================
   CREATE ORDER
========================= */

app.post(
  '/api/orders',
  upload.single('receipt'),
  async (req, res) => {

    try {

      const orders = readOrders();

      const order = {

        id:
          'FE-' +
          Date.now()
            .toString()
            .slice(-8),

        createdAt:
          new Date().toISOString(),

        customerName:
          req.body.customerName || '',

        customerPhone:
          req.body.customerPhone || '',

        country:
          req.body.country || '',

        plan:
          req.body.plan || '',

        price:
          req.body.price || '',

        payment:
          req.body.payment || '',

        receiptUrl:
          req.file
            ? '/uploads/' + req.file.filename
            : '',

        status:
          'waiting_payment_check',

        paymentConfirmedAt: '',

        qrUploadedAt: '',

        qrUrl: '',

        activationCode: '',

        notes: ''
      };

      orders.unshift(order);

      saveOrders(orders);

      res.json({
        ok: true,
        order
      });

      notifyAdmins(order)
        .catch(e =>
          console.error(
            'push notification error',
            e
          )
        );

    } catch (err) {

      console.error(
        'Order error:',
        err
      );

      res.status(500).json({
        error: 'Could not create order'
      });
    }
  }
);


/* =========================
   CUSTOMER GET ORDER
========================= */

app.get(
  '/api/orders/:id',
  (req, res) => {

    const order =
      readOrders().find(
        x => x.id === req.params.id
      );

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    res.json({
      ok: true,
      order
    });
  }
);


/* =========================
   ADMIN GET ORDERS
========================= */

app.get(
  '/api/admin/orders',
  adminOnly,
  (req, res) => {

    res.json({
      ok: true,
      orders: readOrders()
    });
  }
);


/* =========================
   CHANGE STATUS
========================= */

app.post(
  '/api/admin/orders/:id/status',
  adminOnly,
  (req, res) => {

    const allowed = [
      'waiting_payment_check',
      'payment_confirmed',
      'esim_ready',
      'completed',
      'cancelled'
    ];

    const orders = readOrders();

    const order =
      orders.find(
        x => x.id === req.params.id
      );

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (
      !allowed.includes(
        req.body.status
      )
    ) {

      return res.status(400).json({
        error: 'Invalid status'
      });
    }

    order.status =
      req.body.status;

    order.updatedAt =
      new Date().toISOString();

    if (
      req.body.status ===
        'payment_confirmed' &&
      !order.paymentConfirmedAt
    ) {

      order.paymentConfirmedAt =
        new Date().toISOString();
    }

    saveOrders(orders);

    res.json({
      ok: true,
      order
    });
  }
);


/* =========================
   UPLOAD QR
========================= */

app.post(
  '/api/admin/orders/:id/qr',
  adminOnly,
  upload.single('qr'),
  (req, res) => {

    const orders = readOrders();

    const order =
      orders.find(
        x => x.id === req.params.id
      );

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'QR file is required'
      });
    }

    order.qrUrl =
      '/uploads/' +
      req.file.filename;

    if (req.body.activationCode) {
      order.activationCode =
        req.body.activationCode;
    }

    order.status =
      'esim_ready';

    order.qrUploadedAt =
      new Date().toISOString();

    order.updatedAt =
      new Date().toISOString();

    saveOrders(orders);

    res.json({
      ok: true,
      order
    });
  }
);


/* =========================
   DELETE ORDER
========================= */

app.delete(
  '/api/admin/orders/:id',
  adminOnly,
  (req, res) => {

    const orders = readOrders();

    const index =
      orders.findIndex(
        x => x.id === req.params.id
      );

    if (index === -1) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    const deleted =
      orders.splice(index, 1)[0];

    saveOrders(orders);

    /* Delete Receipt + QR files */

    for (
      const url of [
        deleted.receiptUrl,
        deleted.qrUrl
      ]
    ) {

      if (
        !url ||
        !url.startsWith('/uploads/')
      ) {
        continue;
      }

      const filename =
        path.basename(url);

      const filePath =
        path.join(
          uploadsDir,
          filename
        );

      try {

        if (
          fs.existsSync(filePath)
        ) {
          fs.unlinkSync(filePath);
        }

      } catch (e) {

        console.error(
          'File delete error:',
          e.message
        );
      }
    }

    res.json({
      ok: true,
      deletedOrderId:
        deleted.id
    });
  }
);


/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `FirstESIM backend running on ${PORT}`
    );
  }
);
