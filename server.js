
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
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');

fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const dbFile = path.join(dataDir, 'orders.json');
const pushFile = path.join(dataDir, 'push-subscriptions.json');
const customerPushFile = path.join(dataDir, 'customer-push-subscriptions.json');
const vapidFile = path.join(dataDir, 'vapid.json');
const usersFile = path.join(dataDir, 'users.json');
const authSecretFile = path.join(dataDir, 'auth-secret.txt');
const otpFile = path.join(dataDir, 'auth-otps.json');

if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '[]');
if (!fs.existsSync(pushFile)) fs.writeFileSync(pushFile, '[]');
if (!fs.existsSync(customerPushFile)) {
  fs.writeFileSync(customerPushFile, '[]');
}
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '[]');
if (!fs.existsSync(otpFile)) fs.writeFileSync(otpFile, '{}');
if (!fs.existsSync(authSecretFile)) fs.writeFileSync(authSecretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
const AUTH_SECRET = process.env.AUTH_SECRET || fs.readFileSync(authSecretFile, 'utf8').trim();

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
function readUsers() { return readJson(usersFile, []); }
function saveUsers(value) { writeJson(usersFile, value); }

function readSubs() {
  return readJson(pushFile, []);
}

function saveSubs(value) {
  writeJson(pushFile, value);
}

function readCustomerSubs() {
  return readJson(customerPushFile, []);
}

function saveCustomerSubs(value) {
  writeJson(customerPushFile, value);
}

// VAPID keys: persist them using a persistent Render disk or
// provide stable VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars.
let vapid = readJson(vapidFile, null);

if (
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY
) {
  vapid = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  };
} else if (!vapid || !vapid.publicKey || !vapid.privateKey) {
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
    'Content-Type,x-admin-key,Authorization'
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
      Date.now() + '-' + crypto.randomBytes(5).toString('hex') + ext
    );
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

function adminOnly(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Customer accounts: email + phone + password. Passwords are salted and hashed.
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function normalizePhone(value) { return String(value || '').trim().replace(/[\s()-]/g, ''); }
function publicUser(user) {
  return { id: user.id, email: user.email, phone: user.phone, emailVerified: !!user.emailVerified, phoneVerified: !!user.phoneVerified, createdAt: user.createdAt };
}
function signToken(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function getTokenUser(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(parts[0]).digest();
  let got;
  try { got = Buffer.from(parts[1], 'base64url'); } catch (_) { return null; }
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!p.sub || !p.exp || p.exp < Date.now()) return null;
    return readUsers().find(u => u.id === p.sub) || null;
  } catch (_) { return null; }
}
function requireCustomer(req, res, next) {
  const user = getTokenUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  req.customer = user;
  next();
}
function optionalCustomer(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && !getTokenUser(req)) return res.status(401).json({ error: 'Invalid or expired account session.' });
  req.customer = auth ? getTokenUser(req) : null;
  next();
}
const loginAttempts = new Map();
function rateLimitAuth(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const old = loginAttempts.get(key) || { start: now, count: 0 };
  if (now - old.start > 15 * 60 * 1000) { old.start = now; old.count = 0; }
  old.count++;
  loginAttempts.set(key, old);
  if (old.count > 30) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  next();
}


// Email/SMS verification and password reset. Delivery requires SMTP and Twilio environment settings.
const otpStore = () => readJson(otpFile, {});
function saveOtpStore(v) { writeJson(otpFile, v); }
function otpHash(code, salt) { return crypto.createHmac('sha256', AUTH_SECRET).update(salt + ':' + code).digest('hex'); }
function makeCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
async function sendEmailCode(to, subject, body) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.SMTP_FROM) {
    const e = new Error('Email delivery is not configured.'); e.status = 503; throw e;
  }
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  await transport.sendMail({from:process.env.SMTP_FROM,to,subject,text:body});
}
async function sendSmsCode(to, body) {
  const sid=process.env.TWILIO_ACCOUNT_SID, token=process.env.TWILIO_AUTH_TOKEN, from=process.env.TWILIO_FROM;
  if(!sid||!token||!from){const e=new Error('SMS delivery is not configured.');e.status=503;throw e;}
  const auth=Buffer.from(sid+':'+token).toString('base64');
  const form=new URLSearchParams({To:to,From:from,Body:body});
  const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/x-www-form-urlencoded'},body:form});
  if(!r.ok){const e=new Error('SMS provider could not send the message.');e.status=502;throw e;}
}
async function deliverCode(purpose,user,channel) {
  const key=`${purpose}:${user.id}:${channel}`, store=otpStore(), old=store[key];
  if(old && Date.now()-old.sentAt<60000){const e=new Error('Wait one minute before requesting another code.');e.status=429;throw e;}
  const code=makeCode(), salt=crypto.randomBytes(16).toString('hex'), destination=channel==='email'?user.email:user.phone;
  store[key]={userId:user.id,purpose,channel,destination,salt,hash:otpHash(code,salt),expiresAt:Date.now()+600000,attempts:0,sentAt:Date.now()};
  saveOtpStore(store);
  try {
    const label=purpose==='reset'?'password reset':'account verification';
    if(channel==='email') await sendEmailCode(destination,'FirstESIM verification code',`Your FirstESIM ${label} code is ${code}. It expires in 10 minutes.`);
    else await sendSmsCode(destination,`Your FirstESIM ${label} code is ${code}. It expires in 10 minutes.`);
  } catch(e) { const s=otpStore();delete s[key];saveOtpStore(s);throw e; }
}
function verifyOtp(purpose,user,channel,code) {
  const s=otpStore(), key=`${purpose}:${user.id}:${channel}`, item=s[key];
  if(!item||item.expiresAt<Date.now()||item.attempts>=5){delete s[key];saveOtpStore(s);return false;}
  item.attempts++;
  const a=Buffer.from(otpHash(String(code),item.salt),'hex'),b=Buffer.from(item.hash,'hex');
  const ok=a.length===b.length&&crypto.timingSafeEqual(a,b);
  if(ok)delete s[key];saveOtpStore(s);return ok;
}
function lookupIdentity(identity) {
  const v=String(identity||'').trim();
  return readUsers().find(u=>u.email===normalizeEmail(v)||u.phone===normalizePhone(v));
}
app.post('/api/auth/send-verification',rateLimitAuth,async(req,res)=>{
  try{const user=getTokenUser(req);if(!user)return res.status(401).json({ok:false,error:'Please sign in again.'});
  const channel=req.body?.channel;if(!['email','phone'].includes(channel))return res.status(400).json({ok:false,error:'Choose email or phone.'});
  await deliverCode('verify',user,channel);res.json({ok:true,message:'Code sent.'});}
  catch(e){res.status(e.status||500).json({ok:false,error:e.message||'Could not send code.'});}
});
app.post('/api/auth/verify',rateLimitAuth,(req,res)=>{
  const user=getTokenUser(req);if(!user)return res.status(401).json({ok:false,error:'Please sign in again.'});
  const channel=req.body?.channel,code=String(req.body?.code||'');
  if(!['email','phone'].includes(channel)||!/^\d{6}$/.test(code))return res.status(400).json({ok:false,error:'Enter the six-digit code.'});
  if(!verifyOtp('verify',user,channel,code))return res.status(400).json({ok:false,error:'Invalid or expired code.'});
  const users=readUsers(),i=users.findIndex(u=>u.id===user.id);if(i<0)return res.status(404).json({ok:false,error:'Account not found.'});
  users[i][channel+'Verified']=true;saveUsers(users);res.json({ok:true,user:publicUser(users[i])});
});
app.post('/api/auth/forgot-password',rateLimitAuth,async(req,res)=>{
  try{const channel=req.body?.channel,identity=req.body?.identity;if(!['email','phone'].includes(channel))return res.status(400).json({ok:false,error:'Choose email or phone.'});
  const user=lookupIdentity(identity);
  if(user)await deliverCode('reset',user,channel);
  res.json({ok:true,message:'If the account exists, a code will be sent.'});}
  catch(e){res.status(e.status||500).json({ok:false,error:e.message||'Could not send reset code.'});}
});
app.post('/api/auth/reset-password',rateLimitAuth,(req,res)=>{
  const identity=String(req.body?.identity||'').trim(),channel=req.body?.channel,code=String(req.body?.code||''),password=String(req.body?.password||'');
  if(!['email','phone'].includes(channel)||!/^\d{6}$/.test(code)||password.length<10||password.length>128)return res.status(400).json({ok:false,error:'Enter a valid code and password (10–128 characters).'});
  const user=lookupIdentity(identity);if(!user||(channel==='email'&&user.email!==normalizeEmail(identity))||(channel==='phone'&&user.phone!==normalizePhone(identity)))return res.status(400).json({ok:false,error:'Invalid or expired code.'});
  if(!verifyOtp('reset',user,channel,code))return res.status(400).json({ok:false,error:'Invalid or expired code.'});
  const users=readUsers(),i=users.findIndex(u=>u.id===user.id),salt=crypto.randomBytes(16).toString('hex');
  users[i].salt=salt;users[i].passwordHash=crypto.scryptSync(password,salt,64).toString('hex');saveUsers(users);
  res.json({ok:true,message:'Password reset successfully. Please sign in.'});
});

app.post('/api/auth/register', rateLimitAuth, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!/^\+?[0-9]{7,18}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number with country code.' });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be 10–128 characters.' });
  const users = readUsers();
  if (users.some(u => u.email === email)) return res.status(409).json({ error: 'This email is already registered.' });
  if (users.some(u => u.phone === phone)) return res.status(409).json({ error: 'This phone number is already registered.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const user = { id: 'CUS-' + crypto.randomBytes(12).toString('hex'), email, phone, salt, passwordHash, createdAt: new Date().toISOString() };
  users.push(user); saveUsers(users);
  res.status(201).json({ ok: true, token: signToken(user), user: publicUser(user), note: 'Email and phone have not been independently verified.' });
});

app.post('/api/auth/login', rateLimitAuth, (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  const email = normalizeEmail(identifier);
  const phone = normalizePhone(identifier);
  const password = String(req.body?.password || '');
  const user = readUsers().find(u => u.email === email || u.phone === phone);
  if (!user || !user.salt || !user.passwordHash) return res.status(401).json({ error: 'Email/phone or password is incorrect.' });
  const candidate = crypto.scryptSync(password, user.salt, 64);
  const stored = Buffer.from(user.passwordHash, 'hex');
  if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return res.status(401).json({ error: 'Email/phone or password is incorrect.' });
  res.json({ ok: true, token: signToken(user), user: publicUser(user) });
});

app.get('/api/auth/me', requireCustomer, (req, res) => {
  res.json({ ok: true, user: publicUser(req.customer) });
});

app.get('/api/account/orders', requireCustomer, (req, res) => {
  const orders = readOrders().filter(order => order.customerId === req.customer.id)
    .map(({ customerId, ...order }) => order);
  res.json({ ok: true, orders });
});

// Send notification to admins when a new order is created.
async function notifyAdmins(order) {
  const subs = readSubs();

  if (!subs.length) {
    console.log('Admin push: no subscriptions saved for', order.id);
    return;
  }

  const payload = JSON.stringify({
    title: 'FirstESIM — Order نوێ 🔔',
    body: `${order.id} — ${order.country} — ${order.plan} — ${order.price}`,
    url: `https://firstesim.net/admin.html?order=${encodeURIComponent(order.id)}`,
    orderId: order.id,
    tag: 'order-' + order.id
  });

  const keep = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      keep.push(sub);
    } catch (err) {
      console.error(
        'Admin push send error:',
        err.statusCode || '',
        err.message || err
      );

      if (err.statusCode !== 404 && err.statusCode !== 410) {
        keep.push(sub);
      }
    }
  }

  saveSubs(keep);
}

// Customer push subscription: used to notify when their QR is ready.
app.get('/api/customer/push/public-key', (req, res) => {
  res.json({ ok: true, publicKey: vapid.publicKey });
});

app.post('/api/customer/push/subscribe', (req, res) => {
  const orderId = req.body?.orderId;
  const sub = req.body?.subscription;

  if (
    !orderId ||
    !sub ||
    typeof sub !== 'object' ||
    !sub.endpoint ||
    !sub.keys ||
    !sub.keys.p256dh ||
    !sub.keys.auth
  ) {
    return res.status(400).json({
      error: 'Invalid customer subscription'
    });
  }

  const order = readOrders().find(item => item.id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const subs = readCustomerSubs();

  const clean = {
    orderId,
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: {
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth
    }
  };

  const index = subs.findIndex(
    item => item.endpoint === clean.endpoint &&
            item.orderId === clean.orderId
  );

  if (index >= 0) {
    subs[index] = clean;
  } else {
    subs.push(clean);
  }

  saveCustomerSubs(subs);
  res.json({ ok: true });
});

// Notify customer when their eSIM QR is ready.
async function notifyCustomers(order) {
  const all = readCustomerSubs();
  const targets = all.filter(item => item.orderId === order.id);

  if (!targets.length) {
    console.log('Customer push: no subscription for', order.id);
    return;
  }

  const payload = JSON.stringify({
    title: 'FirstESIM — QR ـەکەت ئامادەیە 🔔',
    body: `${order.country} — ${order.plan}`,
    url: `https://firstesim.net/FirstESIM-App/?order=${encodeURIComponent(order.id)}`,
    orderId: order.id,
    tag: 'qr-' + order.id
  });

  const keep = [];

  for (const sub of all) {
    if (sub.orderId !== order.id) {
      keep.push(sub);
      continue;
    }

    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          expirationTime: sub.expirationTime,
          keys: sub.keys
        },
        payload
      );
    } catch (err) {
      console.error(
        'Customer push error:',
        err.statusCode || '',
        err.message || err
      );

      if (err.statusCode !== 404 && err.statusCode !== 410) {
        keep.push(sub);
      }
    }
  }

  saveCustomerSubs(keep);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/admin/push/public-key', adminOnly, (req, res) => {
  res.json({ ok: true, publicKey: vapid.publicKey });
});

app.post('/api/admin/push/subscribe', adminOnly, (req, res) => {
  const sub = req.body?.subscription;

  if (
    !sub ||
    !sub.endpoint ||
    !sub.keys ||
    !sub.keys.p256dh ||
    !sub.keys.auth
  ) {
    return res.status(400).json({
      error: 'Invalid subscription'
    });
  }

  const clean = {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: {
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth
    }
  };

  const subs = readSubs();
  const index = subs.findIndex(item => item.endpoint === clean.endpoint);

  if (index >= 0) {
    subs[index] = clean;
  } else {
    subs.push(clean);
  }

  saveSubs(subs);
  res.json({ ok: true });
});

app.post('/api/admin/push/unsubscribe', adminOnly, (req, res) => {
  const endpoint = req.body?.endpoint;

  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint required' });
  }

  saveSubs(readSubs().filter(item => item.endpoint !== endpoint));
  res.json({ ok: true });
});

// Create order, save receipt, and notify admins.
app.post('/api/orders', optionalCustomer, upload.single('receipt'), async (req, res) => {
  try {
    const orders = readOrders();

    const order = {
      id: 'FE-' + Date.now().toString().slice(-8),
      createdAt: new Date().toISOString(),
      customerName: req.body.customerName || '',
      customerPhone: req.body.customerPhone || (req.customer ? req.customer.phone : ''),
      customerId: req.customer ? req.customer.id : '',
      country: req.body.country || '',
      plan: req.body.plan || '',
      price: req.body.price || '',
      payment: req.body.payment || '',
      receiptUrl: req.file ? '/uploads/' + req.file.filename : '',
      status: 'waiting_payment_check',
      paymentConfirmedAt: '',
      qrUrl: '',
      qrUploadedAt: '',
      activationCode: '',
      notes: ''
    };

    orders.unshift(order);
    saveOrders(orders);

    res.json({ ok: true, order });

    notifyAdmins(order).catch(err => {
      console.error('Admin notification failed:', err);
    });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Could not create order' });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = readOrders().find(item => item.id === req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const { customerId, ...safeOrder } = order;
  res.json({ ok: true, order: safeOrder });
});

app.get('/api/admin/orders', adminOnly, (req, res) => {
  res.json({ ok: true, orders: readOrders() });
});

app.post('/api/admin/orders/:id/status', adminOnly, (req, res) => {
  const allowed = [
    'waiting_payment_check',
    'payment_confirmed',
    'esim_ready',
    'completed',
    'cancelled'
  ];

  const orders = readOrders();
  const order = orders.find(item => item.id === req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (!allowed.includes(req.body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  order.status = req.body.status;
  order.updatedAt = new Date().toISOString();

  if (
    req.body.status === 'payment_confirmed' &&
    !order.paymentConfirmedAt
  ) {
    order.paymentConfirmedAt = new Date().toISOString();
  }

  saveOrders(orders);
  res.json({ ok: true, order });
});

// Upload QR and notify the customer.
app.post('/api/admin/orders/:id/qr', adminOnly, upload.single('qr'), (req, res) => {
  const orders = readOrders();
  const order = orders.find(item => item.id === req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (req.file) {
    order.qrUrl = '/uploads/' + req.file.filename;
    order.qrUploadedAt = new Date().toISOString();
  }

  if (req.body.activationCode) {
    order.activationCode = req.body.activationCode;
  }

  order.status = 'esim_ready';
  order.updatedAt = new Date().toISOString();

  saveOrders(orders);

  res.json({ ok: true, order });

  notifyCustomers(order).catch(err => {
    console.error('Customer notification failed:', err);
  });
});

app.delete('/api/admin/orders/:id', adminOnly, (req, res) => {
  const orders = readOrders();
  const index = orders.findIndex(item => item.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const [order] = orders.splice(index, 1);
  saveOrders(orders);

  for (const url of [order.receiptUrl, order.qrUrl]) {
    if (!url || !url.startsWith('/uploads/')) continue;

    const file = path.join(uploadsDir, path.basename(url));

    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {}
  }

  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FirstESIM backend running on ${PORT}`);
});
