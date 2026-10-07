const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// Folders
// ===============================

const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(__dirname, "uploads");
const publicDir = path.join(__dirname, "public");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });

const ordersFile = path.join(dataDir, "orders.json");

if (!fs.existsSync(ordersFile)) {
  fs.writeFileSync(ordersFile, "[]", "utf8");
}

// ===============================
// Middleware
// ===============================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (
    origin === "https://firstesim.net" ||
    origin === "https://www.firstesim.net"
  ) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, x-admin-key"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Static files
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(publicDir));

// ===============================
// Multer upload
// ===============================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();

    const name =
      Date.now() +
      "-" +
      crypto.randomBytes(6).toString("hex") +
      ext;

    cb(null, name);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

// ===============================
// Helpers
// ===============================

function readOrders() {
  try {
    const raw = fs.readFileSync(ordersFile, "utf8");

    if (!raw.trim()) {
      return [];
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error("READ ORDERS ERROR:", error);
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(
    ordersFile,
    JSON.stringify(orders, null, 2),
    "utf8"
  );
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

// ===============================
// Health check
// ===============================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "FirstESIM API",
    status: "online"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online"
  });
});

// ===============================
// CREATE ORDER
// ===============================

app.post(
  "/api/orders",
  upload.single("receipt"),
  (req, res) => {
    try {
      const {
        customerName = "",
        customerPhone = "",
        country = "",
        plan = "",
        price = "",
        payment = ""
      } = req.body;

      if (!country || !plan || !payment) {
        return res.status(400).json({
          ok: false,
          error: "Missing order information"
        });
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "Receipt is required"
        });
      }

      const orders = readOrders();

      const id =
        "ESIM-" +
        Date.now() +
        "-" +
        crypto.randomBytes(3).toString("hex").toUpperCase();

      const receiptUrl =
        getBaseUrl(req) +
        "/uploads/" +
        req.file.filename;

      const order = {
        id,

        customerName,
        customerPhone,

        country,
        plan,
        price,
        payment,

        receiptUrl,

        status: "waiting_payment_check",

        qrUrl: "",
        activationCode: "",

        notes: "",

        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      orders.push(order);
      writeOrders(orders);

      console.log("NEW ORDER:", id);

      return res.status(201).json({
        ok: true,
        order
      });
    } catch (error) {
      console.error("CREATE ORDER ERROR:", error);

      return res.status(500).json({
        ok: false,
        error: "Could not create order"
      });
    }
  }
);

// ===============================
// GET CUSTOMER ORDER
// ===============================

app.get("/api/orders/:id", (req, res) => {
  try {
    const orders = readOrders();

    const order = orders.find(
      (item) => item.id === req.params.id
    );

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    return res.json({
      ok: true,
      order
    });
  } catch (error) {
    console.error("GET ORDER ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Could not read order"
    });
  }
});

// ===============================
// ADMIN AUTH
// ===============================

function adminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;

  if (!adminKey) {
    return res.status(500).json({
      ok: false,
      error: "ADMIN_KEY is not configured"
    });
  }

  const key = req.headers["x-admin-key"];

  if (!key || key !== adminKey) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}

// ===============================
// ADMIN - GET ORDERS
// ===============================

app.get(
  "/api/admin/orders",
  adminAuth,
  (req, res) => {
    try {
      const orders = readOrders();

      return res.json({
        ok: true,
        orders: orders.reverse()
      });
    } catch (error) {
      console.error("ADMIN ORDERS ERROR:", error);

      return res.status(500).json({
        ok: false,
        error: "Could not read orders"
      });
    }
  }
);

// ===============================
// ADMIN - UPDATE STATUS
// ===============================

app.post(
  "/api/admin/orders/:id/status",
  adminAuth,
  (req, res) => {
    try {
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({
          ok: false,
          error: "Status is required"
        });
      }

      const orders = readOrders();

      const index = orders.findIndex(
        (item) => item.id === req.params.id
      );

      if (index === -1) {
        return res.status(404).json({
          ok: false,
          error: "Order not found"
        });
      }

      orders[index].status = status;
      orders[index].updatedAt = new Date().toISOString();

      writeOrders(orders);

      return res.json({
        ok: true,
        order: orders[index]
      });
    } catch (error) {
      console.error("STATUS UPDATE ERROR:", error);

      return res.status(500).json({
        ok: false,
        error: "Could not update status"
      });
    }
  }
);

// ===============================
// ADMIN - UPLOAD QR
// ===============================

app.post(
  "/api/admin/orders/:id/qr",
  adminAuth,
  upload.single("qr"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "QR file is required"
        });
      }

      const orders = readOrders();

      const index = orders.findIndex(
        (item) => item.id === req.params.id
      );

      if (index === -1) {
        return res.status(404).json({
          ok: false,
          error: "Order not found"
        });
      }

      const qrUrl =
        getBaseUrl(req) +
        "/uploads/" +
        req.file.filename;

      orders[index].qrUrl = qrUrl;

      orders[index].activationCode =
        req.body.activationCode || "";

      orders[index].status = "esim_ready";

      orders[index].updatedAt =
        new Date().toISOString();

      writeOrders(orders);

      console.log(
        "QR READY FOR ORDER:",
        orders[index].id
      );

      return res.json({
        ok: true,
        order: orders[index]
      });
    } catch (error) {
      console.error("QR UPLOAD ERROR:", error);

      return res.status(500).json({
        ok: false,
        error: "Could not upload QR"
      });
    }
  }
);

// ===============================
// START SERVER
// ===============================

app.listen(PORT, "0.0.0.0", () => {
  console.log("=================================");
  console.log("FirstESIM API is running");
  console.log("PORT:", PORT);
  console.log("=================================");
});
