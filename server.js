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
fs.mkdirSync(publicDir, { recursive:true });
fs.mkdirSync(dataDir, { recursive:true });
fs.mkdirSync(uploadsDir, { recursive:true });

const dbFile = path.join(dataDir,'orders.json');
const pushFile = path.join(dataDir,'push-subscriptions.json');
const vapidFile = path.join(dataDir,'vapid.json');
if(!fs.existsSync(dbFile)) fs.writeFileSync(dbFile,'[]');
if(!fs.existsSync(pushFile)) fs.writeFileSync(pushFile,'[]');

function readJson(file,fallback){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){return fallback;} }
function writeJson(file,value){ fs.writeFileSync(file,JSON.stringify(value,null,2)); }
function readOrders(){return readJson(dbFile,[]);}
function saveOrders(v){writeJson(dbFile,v);}
function readSubs(){return readJson(pushFile,[]);}
function saveSubs(v){writeJson(pushFile,v);}

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
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
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

async function notifyAdmins(order){
  const subs=readSubs();
  if(!subs.length) return;
  const payload=JSON.stringify({
    title:'FirstESIM — Order نوێ 🔔',
    body:`${order.id} — ${order.country} — ${order.plan} — ${order.price}`,
    url:'/admin.html',
    orderId:order.id,
    tag:'order-'+order.id
  });
  const keep=[];
  for(const sub of subs){
    try{ await webpush.sendNotification(sub,payload); keep.push(sub); }
    catch(err){ if(err.statusCode!==404 && err.statusCode!==410) keep.push(sub); }
  }
  saveSubs(keep);
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
    customerName:req.body.customerName||'', customerPhone:req.body.customerPhone||'',
    country:req.body.country||'', plan:req.body.plan||'', price:req.body.price||'',
    payment:req.body.payment||'', receiptUrl:req.file?'/uploads/'+req.file.filename:'',
    status:'waiting_payment_check', qrUrl:'', activationCode:'', notes:''
  };
  orders.unshift(order); saveOrders(orders);
  res.json({ok:true,order});
  notifyAdmins(order).catch(e=>console.error('push notification error',e));
});

app.get('/api/orders/:id',(req,res)=>{
  const order=readOrders().find(x=>x.id===req.params.id);
  if(!order)return res.status(404).json({error:'Order not found'});
  res.json({ok:true,order});
});
app.get('/api/admin/orders',adminOnly,(req,res)=>res.json({ok:true,orders:readOrders()}));
app.post('/api/admin/orders/:id/status',adminOnly,(req,res)=>{
  const allowed=['waiting_payment_check','payment_confirmed','esim_ready','completed','cancelled'];
  const orders=readOrders(); const order=orders.find(x=>x.id===req.params.id);
  if(!order)return res.status(404).json({error:'Order not found'});
  if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid status'});
  order.status=req.body.status; order.updatedAt=new Date().toISOString(); saveOrders(orders);
  res.json({ok:true,order});
});
app.post('/api/admin/orders/:id/qr',adminOnly,upload.single('qr'),(req,res)=>{
  const orders=readOrders(); const order=orders.find(x=>x.id===req.params.id);
  if(!order)return res.status(404).json({error:'Order not found'});
  if(req.file)order.qrUrl='/uploads/'+req.file.filename;
  if(req.body.activationCode)order.activationCode=req.body.activationCode;
  order.status='esim_ready'; order.updatedAt=new Date().toISOString(); saveOrders(orders);
  res.json({ok:true,order});
});

app.listen(PORT,'0.0.0.0',()=>console.log(`FirstESIM backend running on ${PORT}`));
