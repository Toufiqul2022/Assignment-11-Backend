const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_CODE);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

/* ======================
   MIDDLEWARE
====================== */
app.use(cors());
app.use(express.json());

/* ======================
   FIREBASE ADMIN
====================== */
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: "Unauthorized" });

  try {
    const token = authHeader.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.decoded_email = decodedToken.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized" });
  }
};

/* ======================
   MONGODB CONNECTION
====================== */
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected");

    const db = client.db("Assignment11");
    const userCollection = db.collection("user");
    const requestCollection = db.collection("requests");
    const paymentCollection = db.collection("payment");

    /* ======================
       USERS
    ====================== */

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.createdAt = new Date();
      user.role = "donor";
      user.status = "active";

      const exists = await userCollection.findOne({ email: user.email });
      if (exists) return res.send({ message: "User already exists" });

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users", verifyFBToken, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get("/users/role/:email", async (req, res) => {
      const user = await userCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).send({ message: "Not found" });
      res.send({ role: user.role, status: user.status });
    });

    app.patch("/update/user/status", verifyFBToken, async (req, res) => {
      const { email, status } = req.query;
      const result = await userCollection.updateOne(
        { email },
        { $set: { status } }
      );
      res.send(result);
    });

    /* ======================
       DONATION REQUESTS
    ====================== */

    // CREATE REQUEST
    app.post("/requests", verifyFBToken, async (req, res) => {
      const data = req.body;

      data.requesterEmail = req.decoded_email.trim();
      data.createdAt = new Date();
      data.status = "pending";

      const result = await requestCollection.insertOne(data);
      res.send(result);
    });

    // MY REQUESTS (Dashboard)
    app.get("/my-requests", verifyFBToken, async (req, res) => {
      const email = req.decoded_email.trim();
      const size = Number(req.query.size) || 3;
      const page = Number(req.query.page) || 1;

      const query = { requesterEmail: email };

      const requests = await requestCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(size)
        .skip(size * (page - 1))
        .toArray();

      const total = await requestCollection.countDocuments(query);
      res.send({ requests, total });
    });

    // PUBLIC SEARCH
    app.get("/search-requests", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = {};

      if (bloodGroup) query.bloodGroup = bloodGroup.trim();
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;

      const result = await requestCollection.find(query).toArray();
      res.send(result);
    });

    // PUBLIC REQUESTS
    app.get("/donation-requests", async (req, res) => {
      const result = await requestCollection
        .find({ status: "pending" })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    // SINGLE REQUEST
    app.get("/donation-requests/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid ID" });

      const result = await requestCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!result) return res.status(404).send({ message: "Not found" });
      res.send(result);
    });

    /* ======================
       DONATE (TAKE REQUEST)
    ====================== */

    app.patch("/donation-requests/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const donorEmail = req.decoded_email.trim();
      const donorName = req.body.donorName;

      const request = await requestCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!request) return res.status(404).send({ message: "Not found" });
      if (request.status !== "pending")
        return res.status(400).send({ message: "Already taken" });

      const result = await requestCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "inprogress",
            donorName,
            donorEmail,
            donatedAt: new Date(),
          },
        }
      );

      res.send({ success: true, modifiedCount: result.modifiedCount });
    });

    /* ======================
       STATUS UPDATE
    ====================== */

    app.patch("/requests/status/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      if (!["done", "canceled"].includes(status))
        return res.status(400).send({ message: "Invalid status" });

      const result = await requestCollection.updateOne(
        {
          _id: new ObjectId(id),
          requesterEmail: req.decoded_email.trim(),
          status: "inprogress",
        },
        { $set: { status } }
      );

      res.send(result);
    });

    // DELETE REQUEST
    app.delete("/requests/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;

      const result = await requestCollection.deleteOne({
        _id: new ObjectId(id),
        requesterEmail: req.decoded_email.trim(),
      });

      res.send(result);
    });

    /* ======================
       STRIPE PAYMENT
    ====================== */

    app.post("/create-payment-checkout", async (req, res) => {
      const { donateAmount, donorEmail } = req.body;
      const amount = parseInt(donateAmount) * 100;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: { name: "Donation" },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: donorEmail,
        success_url: `${process.env.SITE_DOMAIN}/success-payment?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    app.get("/success-payment", async (req, res) => {
      const session = await stripe.checkout.sessions.retrieve(
        req.query.session_id
      );

      if (session.payment_status === "paid") {
        const payment = {
          amount: session.amount_total / 100,
          donorEmail: session.customer_email,
          transactionId: session.payment_intent,
          status: session.payment_status,
          paidAt: new Date(),
        };

        const exists = await paymentCollection.findOne({
          transactionId: payment.transactionId,
        });

        if (!exists) await paymentCollection.insertOne(payment);
        res.send({ success: true });
      }
    });

    /* ======================
       PROFILE
    ====================== */

    app.get("/profile", verifyFBToken, async (req, res) => {
      const user = await userCollection.findOne({
        email: req.decoded_email,
      });

      if (!user) return res.status(404).send({ message: "Not found" });
      res.send(user);
    });

    app.patch("/profile", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const updatedData = req.body;

      delete updatedData._id;
      delete updatedData.email;

      const result = await userCollection.updateOne(
        { email },
        { $set: updatedData }
      );

      res.send(result);
    });
    /* ======================
   DASHBOARD STATS
====================== */
    app.get("/dashboard-stats", verifyFBToken, async (req, res) => {
      try {
        // Count total users
        const totalUsers = await userCollection.countDocuments();

        // Count total donation requests
        const totalRequests = await requestCollection.countDocuments();

        // Aggregate total funding from payment collection
        const fundingAggregation = await paymentCollection
          .aggregate([
            { $group: { _id: null, totalFunding: { $sum: "$amount" } } },
          ])
          .toArray();

        const totalFunding = fundingAggregation[0]?.totalFunding || 0;

        // Send response
        return res.status(200).json({
          totalUsers,
          totalRequests,
          totalFunding,
        });
      } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        return res.status(500).json({
          message: "Failed to fetch dashboard stats",
          error: error.message,
        });
      }
    });
  } finally {
  }
}

run().catch(console.dir);

/* ======================
   ROOT
====================== */
app.get("/", (req, res) => {
  res.send("🚀 Blood Donation Server Running");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
