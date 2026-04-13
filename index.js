const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://assignment-11-frontend-pi.vercel.app",
      process.env.SITE_DOMAIN,
    ].filter(Boolean),
    credentials: true,
  }),
);
app.use(express.json());

// ── FIREBASE ADMIN ────────────────────────────────────────────────────────────
const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(decodedKey)),
});

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
const verifyFBToken = async (req, res, next) => {
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader) return res.status(401).send({ message: "Unauthorized" });
  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    next();
  } catch {
    return res.status(401).send({ message: "Unauthorized" });
  }
};

// ── MONGODB ───────────────────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    console.log("✅ MongoDB Ready");

    const db = client.db("Assignment11");
    const userCollection = db.collection("user");
    const requestCollection = db.collection("requests");
    const paymentCollection = db.collection("payment");

    // ── ROLE HELPERS ──────────────────────────────────────────────────────────
    const verifyAdmin = async (req, res, next) => {
      const user = await userCollection.findOne({ email: req.decoded_email });
      if (!user || user.role !== "admin")
        return res.status(403).send({ message: "Forbidden: Admin Only" });
      next();
    };

    const verifyVolunteerOrAdmin = async (req, res, next) => {
      const user = await userCollection.findOne({ email: req.decoded_email });
      if (!user || (user.role !== "volunteer" && user.role !== "admin"))
        return res.status(403).send({ message: "Forbidden" });
      if (user.status === "blocked")
        return res.status(403).send({ message: "User is blocked" });
      next();
    };

    const verifyDonor = async (req, res, next) => {
      const user = await userCollection.findOne({ email: req.decoded_email });
      if (!user || user.role !== "donor")
        return res.status(403).send({ message: "Forbidden: Donor Only" });
      if (user.status === "blocked")
        return res.status(403).send({ message: "User is blocked" });
      next();
    };

    // ── USER ROUTES ───────────────────────────────────────────────────────────
    app.post("/users", async (req, res) => {
      const user = req.body;
      const exists = await userCollection.findOne({ email: user.email });
      if (exists) return res.send({ message: "User already exists" });
      user.role = "donor";
      user.status = "active";
      user.createdAt = new Date();
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get("/users/role/:email", async (req, res) => {
      const user = await userCollection.findOne({ email: req.params.email });
      res.send({
        role: user?.role || "donor",
        status: user?.status || "active",
      });
    });

    app.patch(
      "/update/user/status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { email, status } = req.query;
        const result = await userCollection.updateOne(
          { email },
          { $set: { status } },
        );
        res.send(result);
      },
    );

    app.patch(
      "/users/make-volunteer/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await userCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: "volunteer" } },
        );
        res.send(result);
      },
    );

    // ── PROFILE ROUTES ────────────────────────────────────────────────────────
    app.get("/profile", verifyFBToken, async (req, res) => {
      const user = await userCollection.findOne({ email: req.decoded_email });
      if (!user) return res.status(404).send({ message: "Not found" });
      res.send(user);
    });

    app.patch("/profile", verifyFBToken, async (req, res) => {
      const data = { ...req.body };
      delete data._id;
      delete data.email;
      const result = await userCollection.updateOne(
        { email: req.decoded_email },
        { $set: data },
      );
      res.send(result);
    });

    // ── REQUEST ROUTES ────────────────────────────────────────────────────────
    app.post("/requests", verifyFBToken, verifyDonor, async (req, res) => {
      const data = req.body;
      data.requesterEmail = req.decoded_email;
      data.status = "pending";
      data.createdAt = new Date();
      const result = await requestCollection.insertOne(data);
      res.send(result);
    });

    app.get("/my-requests", verifyFBToken, verifyDonor, async (req, res) => {
      const page = Number(req.query.page) || 1;
      const size = Number(req.query.size) || 10;
      const query = { requesterEmail: req.decoded_email };
      const requests = await requestCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(size * (page - 1))
        .limit(size)
        .toArray();
      const total = await requestCollection.countDocuments(query);
      res.send({ requests, total });
    });

    app.get("/donation-requests", async (req, res) => {
      const result = await requestCollection
        .find({ status: "pending" })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // Alias — some frontend pages call /requests directly
    app.get("/requests", async (req, res) => {
      const result = await requestCollection
        .find({ status: "pending" })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/donation-requests/:id", verifyFBToken, async (req, res) => {
      const result = await requestCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!result) return res.status(404).send({ message: "Not found" });
      res.send(result);
    });

    app.patch("/donation-requests/:id", verifyFBToken, async (req, res) => {
      const request = await requestCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!request || request.status !== "pending")
        return res.status(400).send({ message: "Not available" });
      const result = await requestCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            status: "inprogress",
            donorEmail: req.decoded_email,
            donorName: req.body.donorName,
            donatedAt: new Date(),
          },
        },
      );
      res.send(result);
    });

    app.patch(
      "/requests/status/:id",
      verifyFBToken,
      verifyDonor,
      async (req, res) => {
        const result = await requestCollection.updateOne(
          {
            _id: new ObjectId(req.params.id),
            requesterEmail: req.decoded_email,
          },
          { $set: { status: req.body.status } },
        );
        res.send(result);
      },
    );

    app.delete(
      "/requests/:id",
      verifyFBToken,
      verifyDonor,
      async (req, res) => {
        const result = await requestCollection.deleteOne({
          _id: new ObjectId(req.params.id),
          requesterEmail: req.decoded_email,
        });
        res.send(result);
      },
    );

    app.get("/admin/requests", verifyFBToken, verifyAdmin, async (req, res) => {
      const page = Number(req.query.page) || 1;
      const size = Number(req.query.size) || 10;
      const requests = await requestCollection
        .find()
        .sort({ createdAt: -1 })
        .skip(size * (page - 1))
        .limit(size)
        .toArray();
      const total = await requestCollection.countDocuments();
      res.send({ requests, total });
    });

    app.patch(
      "/admin/requests/status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await requestCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status } },
        );
        res.send(result);
      },
    );

    app.delete(
      "/admin/requests/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await requestCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      },
    );

    app.get(
      "/volunteer/requests",
      verifyFBToken,
      verifyVolunteerOrAdmin,
      async (req, res) => {
        const { status } = req.query;
        const query = status ? { status } : {};
        const result = await requestCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      },
    );

    app.patch(
      "/volunteer/requests/status/:id",
      verifyFBToken,
      verifyVolunteerOrAdmin,
      async (req, res) => {
        const result = await requestCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status } },
        );
        res.send(result);
      },
    );

    // Search donation requests by blood group / district / upazila
    app.get("/search-requests", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = { status: "pending" };
      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;
      const result = await requestCollection.find(query).toArray();
      res.send(result);
    });

    // ── SEARCH DONORS (users) by blood / district / upazila ──────────────────
    app.get("/search-donors", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = { status: "active" };
      if (bloodGroup) query.blood = bloodGroup;
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;
      const result = await userCollection
        .find(query, {
          projection: {
            name: 1,
            blood: 1,
            district: 1,
            upazila: 1,
            photoURL: 1,
          },
        })
        .toArray();
      res.send(result);
    });

    // ── PUBLIC GET /requests (Blood Donation Requests page) ──────────────────
    app.get("/requests", async (req, res) => {
      const result = await requestCollection
        .find({ status: "pending" })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/dashboard-stats", verifyFBToken, async (req, res) => {
      const totalUsers = await userCollection.countDocuments();
      const totalRequests = await requestCollection.countDocuments();
      const funding = await paymentCollection
        .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
        .toArray();
      res.send({
        totalUsers,
        totalRequests,
        totalFunding: funding[0]?.total || 0,
      });
    });

    // ── STRIPE PAYMENT ROUTES ─────────────────────────────────────────────────
    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      const { amount } = req.body;
      if (!amount || amount < 50)
        return res
          .status(400)
          .send({ message: "Minimum amount is 50 cents ($0.50)" });
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount),
          currency: "usd",
          automatic_payment_methods: { enabled: true },
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    app.post("/create-payment-checkout", async (req, res) => {
      const { donateAmount, donorEmail } = req.body;
      const amountCents = Math.round(parseFloat(donateAmount) * 100);
      if (!amountCents || amountCents < 50)
        return res.status(400).send({ message: "Minimum donation is $0.50" });
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          customer_email: donorEmail || undefined,
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: amountCents,
                product_data: { name: "BloodUnity Platform Donation" },
              },
              quantity: 1,
            },
          ],
          success_url: `${process.env.SITE_DOMAIN}/success-payment?session_id={CHECKOUT_SESSION_ID}&amount=${donateAmount}`,
          cancel_url: `${process.env.SITE_DOMAIN}/funding?cancelled=true`,
        });
        res.send({ url: session.url });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    app.get("/verify-payment", async (req, res) => {
      const { session_id } = req.query;
      if (!session_id)
        return res.status(400).send({ message: "No session_id" });
      try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        if (session.payment_status === "paid") {
          const payment = {
            amount: session.amount_total / 100,
            donorEmail: session.customer_email,
            transactionId: session.payment_intent,
            sessionId: session.id,
            status: "paid",
            paidAt: new Date(),
          };
          const exists = await paymentCollection.findOne({
            transactionId: payment.transactionId,
          });
          if (!exists) await paymentCollection.insertOne(payment);
          res.send({
            success: true,
            amount: payment.amount,
            transactionId: payment.transactionId,
          });
        } else {
          res
            .status(400)
            .send({ success: false, status: session.payment_status });
        }
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });
  } finally {
    // client.close() commented out for Vercel
  }
}

run().catch(console.error);

app.get("/", (req, res) => res.send("Blood Donation Server Running ✅"));

app.listen(port, () => console.log(`Server running on port ${port}`));

module.exports = app; // ← MUST be last line
