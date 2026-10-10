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
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-admin-key');
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
