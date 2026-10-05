const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "CHANGE_THIS_ADMIN_KEY";

const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const dbFile = path.join(dataDir, "orders.json");
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, "[]");

function readOrders() { return JSON.parse(fs.readFileSync(dbFile, "utf8")); }
function saveOrders(orders) { fs.writeFileSync(dbFile, JSON.stringify(orders, null, 2)); }

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(public));
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + crypto.randomBytes(5).toString("hex") + ext);
  }
});
const upload = multer({ storage });

function adminOnly(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.post("/api/orders", upload.single("receipt"), (req, res) => {
  const orders = readOrders();
  const order = {
    id: "FE-" + Date.now().toString().slice(-8),
    createdAt: new Date().toISOString(),
    customerName: req.body.customerName || "",
    customerPhone: req.body.customerPhone || "",
    country: req.body.country || "",
    plan: req.body.plan || "",
    price: req.body.price || "",
    payment: req.body.payment || "",
    receiptUrl: req.file ? "/uploads/" + req.file.filename : "",
    status: "waiting_payment_check",
    qrUrl: "",
    activationCode: "",
    notes: ""
  };
  orders.unshift(order);
  saveOrders(orders);
  res.json({ ok: true, order });
});

app.get("/api/orders/:id", (req, res) => {
  const order = readOrders().find(x => x.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json({ ok: true, order });
});

app.get("/api/admin/orders", adminOnly, (req, res) => {
  res.json({ ok: true, orders: readOrders() });
});

app.post("/api/admin/orders/:id/qr", adminOnly, upload.single("qr"), (req, res) => {
  const orders = readOrders();
  const order = orders.find(x => x.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });

  if (req.file) order.qrUrl = "/uploads/" + req.file.filename;
  if (req.body.activationCode) order.activationCode = req.body.activationCode;
  order.status = "esim_ready";
  order.updatedAt = new Date().toISOString();
  saveOrders(orders);
  res.json({ ok: true, order });
});

app.post("/api/admin/orders/:id/status", adminOnly, (req, res) => {
  const allowed = ["waiting_payment_check", "payment_confirmed", "esim_ready", "completed", "cancelled"];
  const orders = readOrders();
  const order = orders.find(x => x.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
  order.status = req.body.status;
  order.updatedAt = new Date().toISOString();
  saveOrders(orders);
  res.json({ ok: true, order });
});

app.listen(PORT, () => console.log(`FirstESIM backend running on http://localhost:${PORT}`));
