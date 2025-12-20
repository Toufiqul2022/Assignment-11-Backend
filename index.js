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
const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(decodedKey)),
});

/* ======================
   AUTH MIDDLEWARE
====================== */
const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
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
       ROLE MIDDLEWARE
    ====================== */
    const verifyAdmin = async (req, res, next) => {
      const user = await userCollection.findOne({
        email: req.decoded_email,
      });

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden" });
      }
      next();
    };

    const verifyVolunteer = async (req, res, next) => {
      const user = await userCollection.findOne({
        email: req.decoded_email,
      });

      if (!user || user.role !== "volunteer") {
        return res.status(403).send({ message: "Volunteer only" });
      }

      if (user.status === "blocked") {
        return res.status(403).send({ message: "User is blocked" });
      }
      next();
    };

    const verifyDonor = async (req, res, next) => {
      const user = await userCollection.findOne({
        email: req.decoded_email,
      });

      if (!user || user.role !== "donor") {
        return res.status(403).send({ message: "Donor only" });
      }

      if (user.status === "blocked") {
        return res.status(403).send({ message: "User is blocked" });
      }
      next();
    };

    /* ======================
       USERS
    ====================== */
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
      const user = await userCollection.findOne({
        email: req.params.email,
      });
      res.send({ role: user?.role, status: user?.status });
    });

    app.patch(
      "/update/user/status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { email, status } = req.query;
        const result = await userCollection.updateOne(
          { email },
          { $set: { status } }
        );
        res.send(result);
      }
    );

    app.patch(
      "/users/make-volunteer/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await userCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: "volunteer" } }
        );
        res.send(result);
      }
    );

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
      const updatedData = req.body;
      delete updatedData._id;
      delete updatedData.email;

      const result = await userCollection.updateOne(
        { email: req.decoded_email },
        { $set: updatedData }
      );

      res.send(result);
    });

    /* ======================
       CREATE REQUEST (DONOR)
    ====================== */
    app.post("/requests", verifyFBToken, verifyDonor, async (req, res) => {
      const data = req.body;
      data.requesterEmail = req.decoded_email;
      data.status = "pending";
      data.createdAt = new Date();

      const result = await requestCollection.insertOne(data);
      res.send(result);
    });

    /* ======================
       MY REQUESTS (DONOR)
    ====================== */
    app.get("/my-requests", verifyFBToken, verifyDonor, async (req, res) => {
      const email = req.decoded_email;
      const page = Number(req.query.page) || 1;
      const size = Number(req.query.size) || 10;

      const query = { requesterEmail: email };

      const requests = await requestCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(size * (page - 1))
        .limit(size)
        .toArray();

      const total = await requestCollection.countDocuments(query);
      res.send({ requests, total });
    });

    /* ======================
       ADMIN: ALL REQUESTS
    ====================== */
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

    /* ======================
       VOLUNTEER: ALL REQUESTS (VIEW + FILTER)
    ====================== */
    app.get(
      "/volunteer/requests",
      verifyFBToken,
      verifyVolunteer,
      async (req, res) => {
        const { status } = req.query;
        const query = status ? { status } : {};
        const result = await requestCollection.find(query).toArray();
        res.send(result);
      }
    );

    /* ======================
       PUBLIC SEARCH
    ====================== */
    app.get("/search-requests", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = {};

      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;

      const result = await requestCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/donation-requests", async (req, res) => {
      const result = await requestCollection
        .find({ status: "pending" })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.get("/donation-requests/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const result = await requestCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!result) return res.status(404).send({ message: "Not found" });
      res.send(result);
    });

    /* ======================
       TAKE DONATION
    ====================== */
    app.patch("/donation-requests/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;

      const request = await requestCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!request || request.status !== "pending") {
        return res.status(400).send({ message: "Not available" });
      }

      const result = await requestCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "inprogress",
            donorEmail: req.decoded_email,
            donorName: req.body.donorName,
            donatedAt: new Date(),
          },
        }
      );

      res.send(result);
    });

    /* ======================
       STATUS UPDATE
    ====================== */
    app.patch(
      "/requests/status/:id",
      verifyFBToken,
      verifyDonor,
      async (req, res) => {
        const { status } = req.body;

        const result = await requestCollection.updateOne(
          {
            _id: new ObjectId(req.params.id),
            requesterEmail: req.decoded_email,
          },
          { $set: { status } }
        );

        res.send(result);
      }
    );

    app.patch(
      "/admin/requests/status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await requestCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status } }
        );
        res.send(result);
      }
    );

    app.patch(
      "/volunteer/requests/status/:id",
      verifyFBToken,
      verifyVolunteer,
      async (req, res) => {
        const result = await requestCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status } }
        );
        res.send(result);
      }
    );

    /* ======================
       DELETE REQUEST
    ====================== */
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
      }
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
      }
    );

    /* ======================
       STRIPE PAYMENT
    ====================== */
    app.post("/create-payment-checkout", async (req, res) => {
      const { donateAmount, donorEmail } = req.body;
      const amount = parseInt(donateAmount) * 100;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: donorEmail,
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
       DASHBOARD STATS
    ====================== */
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
