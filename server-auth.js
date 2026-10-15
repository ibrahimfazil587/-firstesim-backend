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
fs.mkdirSync(publicDir, { recursive:true });
fs.mkdirSync(dataDir, { recursive:true });
fs.mkdirSync(uploadsDir, { recursive:true });

const dbFile = path.join(dataDir,'orders.json');
const pushFile = path.join(dataDir,'push-subscriptions.json');
const customerPushFile = path.join(dataDir,'customer-push-subscriptions.json');
const vapidFile = path.join(dataDir,'vapid.json');
const usersFile = path.join(dataDir,'users.json');
const authSecret = process.env.AUTH_SECRET;
if (!authSecret || authSecret.length < 32) console.warn('WARNING: Set AUTH_SECRET to a random secret of at least 32 characters before enabling customer accounts.');
if(!fs.existsSync(usersFile)) fs.writeFileSync(usersFile,'[]');
if(!fs.existsSync(dbFile)) fs.writeFileSync(dbFile,'[]');
if(!fs.existsSync(pushFile)) fs.writeFileSync(pushFile,'[]');
if(!fs.existsSync(customerPushFile)) fs.writeFileSync(customerPushFile,'[]');

function readJson(file,fallback){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){return fallback;} }
function writeJson(file,value){ fs.writeFileSync(file,JSON.stringify(value,null,2)); }
function readOrders(){return readJson(dbFile,[]);}
function saveOrders(v){writeJson(dbFile,v);}
function readSubs(){return readJson(pushFile,[]);}
function saveSubs(v){writeJson(pushFile,v);}
function readCustomerSubs(){return readJson(customerPushFile,[]);}
function saveCustomerSubs(v){writeJson(customerPushFile,v);}

function readUsers(){return readJson(usersFile,[]);}
function saveUsers(v){writeJson(usersFile,v);}
function b64url(value){return Buffer.from(value).toString('base64url');}
function makeToken(user){
  if(!authSecret || authSecret.length < 32) throw new Error('AUTH_SECRET is not configured');
  const now=Math.floor(Date.now()/1000);
  const payload=b64url(JSON.stringify({sub:user.id,iat:now,exp:now+60*60*24*14}));
  const signature=crypto.createHmac('sha256',authSecret).update(payload).digest('base64url');
  return payload+'.'+signature;
}
function verifyToken(token){
  if(!authSecret || authSecret.length < 32 || typeof token!=='string') return null;
  const parts=token.split('.'); if(parts.length!==2)return null;
  const expected=crypto.createHmac('sha256',authSecret).update(parts[0]).digest();
  let actual; try{actual=Buffer.from(parts[1],'base64url')}catch(_){return null;}
  if(actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected))return null;
  let payload; try{payload=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'))}catch(_){return null;}
  if(!payload.sub || !payload.exp || payload.exp<Math.floor(Date.now()/1000))return null;
  return readUsers().find(u=>u.id===payload.sub)||null;
}
function currentUser(req){
  const header=req.headers.authorization||'';
  return header.startsWith('Bearer ')?verifyToken(header.slice(7)):null;
}
function requireUser(req,res,next){
  const user=currentUser(req);
  if(!user)return res.status(401).json({ok:false,error:'Please sign in again.'});
  req.user=user; next();
}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function safeUser(user){return {id:user.id,name:user.name,email:user.email,phone:user.phone,createdAt:user.createdAt};}

let vapid = readJson(vapidFile,null);
if(!vapid || !vapid.publicKey || !vapid.privateKey){
  vapid = webpush.generateVAPIDKeys();
  writeJson(vapidFile,vapid);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@firstesim.net', vapid.publicKey, vapid.privateKey);

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin==='https://firstesim.net' || origin==='https://www.firstesim.net' || origin?.endsWith('.github.io')){
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
  }
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-admin-key,Authorization');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(publicDir));
app.use('/uploads',express.static(uploadsDir));

const storage=multer.diskStorage({
  destination:uploadsDir,
  filename:(req,file,cb)=>{
    const ext=path.extname(file.originalname);
    cb(null,Date.now()+'-'+crypto.randomBytes(5).toString('hex')+ext);
  }
});
const upload=multer({storage});
function adminOnly(req,res,next){
  if(req.headers['x-admin-key']!==ADMIN_KEY) return res.status(401).json({error:'Unauthorized'});
  next();
}

// Send a push notification to every subscribed admin when a new order is created.
async function notifyAdmins(order){
  const subs=readSubs();
  if(!subs.length){
    console.log('Admin push: no subscriptions saved; order',order.id);
    return;
  }

  const payload=JSON.stringify({
    title:'FirstESIM — Order نوێ 🔔',
    body:`${order.id} — ${order.country} — ${order.plan} — ${order.price}`,
    url:`https://firstesim.net/admin.html?order=${encodeURIComponent(order.id)}`,
    orderId:order.id,
    tag:'order-'+order.id
  });

  const keep=[];
  for(const sub of subs){
    try{
      await webpush.sendNotification(sub,payload);
      keep.push(sub);
    }catch(err){
      console.error('Admin push send error:',err.statusCode||'',err.message||err);
      if(err.statusCode!==404 && err.statusCode!==410) keep.push(sub);
    }
  }
  saveSubs(keep);
}

app.get('/api/customer/push/public-key',(req,res)=>{
  res.json({ok:true,publicKey:vapid.publicKey});
});

app.post('/api/customer/push/subscribe',(req,res)=>{
  const orderId=req.body?.orderId;
  const sub=req.body?.subscription;

  if(!orderId || !sub || typeof sub!=='object' || !sub.endpoint ||
     !sub.keys || !sub.keys.p256dh || !sub.keys.auth){
    return res.status(400).json({error:'Invalid customer subscription'});
  }

  const orders=readOrders();
  const order=orders.find(x=>x.id===orderId);
  if(!order)return res.status(404).json({error:'Order not found'});

  const subs=readCustomerSubs();
  const clean={
    orderId,
    endpoint:sub.endpoint,
    expirationTime:sub.expirationTime ?? null,
    keys:{p256dh:sub.keys.p256dh,auth:sub.keys.auth}
  };

  const idx=subs.findIndex(x=>x.endpoint===clean.endpoint);
  if(idx>=0)subs[idx]=clean;else subs.push(clean);
  saveCustomerSubs(subs);

  res.json({ok:true});
});

async function notifyCustomers(order){
  const all=readCustomerSubs();
  const subs=all.filter(x=>x.orderId===order.id);
  if(!subs.length)return;

  const payload=JSON.stringify({
    title:'FirstESIM — QR ـەکەت ئامادەیە 🔔',
    body:`${order.country} — ${order.plan}`,
    url:`https://firstesim.net/FirstESIM-App/?order=${encodeURIComponent(order.id)}`,
    orderId:order.id,
    tag:'qr-'+order.id
  });

  const keep=[];
  for(const sub of all){
    if(sub.orderId!==order.id){keep.push(sub);continue;}
    try{
      await webpush.sendNotification(
        {endpoint:sub.endpoint,expirationTime:sub.expirationTime,keys:sub.keys},
        payload
      );
    }catch(err){
      console.error('Customer push error:',err.statusCode||'',err.message||err);
      if(err.statusCode!==404 && err.statusCode!==410)keep.push(sub);
    }
  }
  saveCustomerSubs(keep);
}


// Customer account endpoints. Guest checkout remains supported.
app.post('/api/auth/register', (req,res)=>{
  const {name,email,phone,password}=req.body||{};
  if(typeof name!=='string'||typeof email!=='string'||typeof phone!=='string'||typeof password!=='string'||
     name.trim().length<2||email.trim().length>254||!/^\S+@\S+\.\S+$/.test(email.trim())||
     phone.trim().length<6||phone.trim().length>30||password.length<10||password.length>200){
    return res.status(400).json({ok:false,error:'Enter a valid name, email, phone, and password of at least 10 characters.'});
  }
  if(!authSecret||authSecret.length<32)return res.status(503).json({ok:false,error:'Customer accounts are not configured yet.'});
  const users=readUsers(), normalizedEmail=email.trim().toLowerCase(), normalizedPhone=phone.trim().replace(/[\s()-]/g,'');
  if(users.some(u=>u.email===normalizedEmail||u.phone===normalizedPhone))return res.status(409).json({ok:false,error:'Email or phone number is already registered.'});
  const salt=crypto.randomBytes(16).toString('hex');
  const user={id:crypto.randomUUID(),name:name.trim(),email:normalizedEmail,phone:normalizedPhone,salt,passwordHash:hashPassword(password,salt),createdAt:new Date().toISOString()};
  users.push(user);saveUsers(users);
  try{return res.status(201).json({ok:true,token:makeToken(user),user:safeUser(user)});}catch(e){return res.status(503).json({ok:false,error:'Account service is not configured.'});}
});

app.post('/api/auth/login',(req,res)=>{
  const {identifier,password}=req.body||{};
  if(typeof identifier!=='string'||typeof password!=='string'||!authSecret||authSecret.length<32)return res.status(400).json({ok:false,error:'Invalid sign-in details or account service unavailable.'});
  const id=identifier.trim();
  const normalized=id.includes('@')?id.toLowerCase():id.replace(/[\s()-]/g,'');
  const user=readUsers().find(u=>u.email===normalized||u.phone===normalized);
  const dummySalt='firstesim-fixed-dummy-salt';
  const actual=hashPassword(password,user?user.salt:dummySalt);
  const expected=user?user.passwordHash:hashPassword('not-the-password',dummySalt);
  const a=Buffer.from(actual,'hex'),b=Buffer.from(expected,'hex');
  if(!user||a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({ok:false,error:'Email/phone or password is incorrect.'});
  return res.json({ok:true,token:makeToken(user),user:safeUser(user)});
});

app.get('/api/account/orders',requireUser,(req,res)=>{
  const orders=readOrders().filter(o=>o.userId===req.user.id).map(o=>({
    id:o.id,createdAt:o.createdAt,customerName:o.customerName,customerPhone:o.customerPhone,
    country:o.country,plan:o.plan,price:o.price,payment:o.payment,status:o.status,qrUrl:o.qrUrl,activationCode:o.activationCode
  }));
  res.json({ok:true,orders});
});

app.get('/api/health',(req,res)=>res.json({ok:true}));
app.get('/api/admin/push/public-key',adminOnly,(req,res)=>res.json({ok:true,publicKey:vapid.publicKey}));

app.post('/api/admin/push/subscribe',adminOnly,(req,res)=>{
  const sub=req.body?.subscription;
  if(!sub || !sub.endpoint) return res.status(400).json({error:'Invalid subscription'});
  const subs=readSubs();
  const idx=subs.findIndex(x=>x.endpoint===sub.endpoint);
  if(idx>=0) subs[idx]=sub; else subs.push(sub);
  saveSubs(subs);
  res.json({ok:true});
});

app.post('/api/admin/push/unsubscribe',adminOnly,(req,res)=>{
  const endpoint=req.body?.endpoint;
  saveSubs(readSubs().filter(x=>x.endpoint!==endpoint));
  res.json({ok:true});
});

app.post('/api/orders',upload.single('receipt'),async(req,res)=>{
  const orders=readOrders();
  const order={
    id:'FE-'+Date.now().toString().slice(-8),
    userId:(currentUser(req)||{}).id||null,
    createdAt:new Date().toISOString(),
    customerName:req.body.customerName||'',
    customerPhone:req.body.customerPhone||'',
    country:req.body.country||'',
    plan:req.body.plan||'',
    price:req.body.price||'',
    payment:req.body.payment||'',
    receiptUrl:req.file?'/uploads/'+req.file.filename:'',
    status:'waiting_payment_check',
    qrUrl:'',
    activationCode:'',
    notes:''
  };
  orders.unshift(order);
  saveOrders(orders);
  res.json({ok:true,order});
  notifyAdmins(order).catch(err=>console.error('Admin notification failed:',err));
});

app.get('/api/orders/:id',(req,res)=>{
  const order=readOrders().find(x=>x.id===req.params.id);
  if(!order)return res.status(404).json({error:'Order not found'});
  res.json({ok:true,order});
});

app.get('/api/admin/orders',adminOnly,(req,res)=>{
  res.json({ok:true,orders:readOrders()});
});

app.post('/api/admin/orders/:id/status',adminOnly,(req,res)=>{
  const allowed=['waiting_payment_check','payment_confirmed','esim_ready','completed','cancelled'];
  const orders=readOrders();
  const order=orders.find(x=>x.id===req.params.id);
  if(!order)return res.status(404).json({error:'Order not found'});
  if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid status'});
  order.status=req.body.status;
  order.updatedAt=new Date().toISOString();
  saveOrders(orders);
  res.json({ok:true,order});
});

app.post('/api/admin/orders/:id/qr',adminOnly,upload.single('qr'),(req,res)=>{
  const orders=readOrders();
  const order=orders.find(x=>x.id===req.params.id);
  if(!order)return res.status(404).json({error:'Order not found'});

  if(req.file){
    order.qrUrl='/uploads/'+req.file.filename;
    order.qrUploadedAt=new Date().toISOString();
  }

  if(req.body.activationCode)order.activationCode=req.body.activationCode;
  order.status='esim_ready';
  order.updatedAt=new Date().toISOString();
  saveOrders(orders);

  res.json({ok:true,order});
  notifyCustomers(order).catch(e=>console.error('customer push notification error',e));
});

app.delete('/api/admin/orders/:id',adminOnly,(req,res)=>{
  const orders=readOrders();
  const index=orders.findIndex(x=>x.id===req.params.id);
  if(index===-1)return res.status(404).json({error:'Order not found'});

  const [order]=orders.splice(index,1);
  saveOrders(orders);

  for(const url of [order.receiptUrl,order.qrUrl]){
    if(!url || !url.startsWith('/uploads/')) continue;
    const file=path.join(uploadsDir,path.basename(url));
    try{
      if(fs.existsSync(file))fs.unlinkSync(file);
    }catch(_){}
  }

  res.json({ok:true});
});

app.listen(PORT,'0.0.0.0',()=>console.log(`FirstESIM backend running on ${PORT}`));
