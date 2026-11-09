require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

const requiredEnvironment = [
  {
    name: "DATABASE_URL",
    purpose: "PostgreSQL connection string used to store users, cars, parking spots, and signs.",
  },
  {
    name: "CLERK_PUBLISHABLE_KEY",
    purpose: "Clerk application publishable key used by the backend to verify sessions.",
  },
  {
    name: "CLERK_SECRET_KEY",
    purpose: "Server-only Clerk secret key used to verify signed-in users. Never put this in the Expo app.",
  },
];

async function start() {
  const missingEnvironment = requiredEnvironment.filter(({ name }) => !process.env[name]?.trim());
  if (missingEnvironment.length > 0) {
    console.error("Server startup aborted. The following required environment variables are missing:");
    for (const { name, purpose } of missingEnvironment) {
      console.error(`- ${name}: ${purpose}`);
    }
    console.error("Add the missing values to Backend/.env, then restart the backend.");
    process.exitCode = 1;
    return;
  }

  const { clerkMiddleware, getAuth } = require("@clerk/express");
  const parkingRouter = require("./routes/parking");
  const { router: parkingSignTilesRouter } = require("./routes/parkingSignTiles");
  const { syncDatabase } = require("./models");

  // Clerk runs globally, while public sign tiles are mounted before user-authenticated API routes.
  app.use(clerkMiddleware());
  app.use(cors());
  app.use(express.json({ limit: "32kb" }));
  app.use(parkingSignTilesRouter);

  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api", (req, res, next) => {
    const auth = getAuth(req);
    const { isAuthenticated, userId } = auth;
    if (!isAuthenticated || !userId) {
      const { reason, message } = auth.debug();
      console.warn(
        `Unauthenticated API request ${req.method} ${req.path}; ` +
        `Authorization header present: ${Boolean(req.get("authorization"))}; ` +
        `Clerk reason: ${reason || "unknown"}; ` +
        `detail: ${message || "no additional detail"}`,
      );
      return res.status(401).json({ error: "Authentication required." });
    }
    req.clerkUserId = userId;
    next();
  }, parkingRouter);

  // Keep internal errors in server logs; expose detailed messages only for client errors.
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    console.error("Request failed:", error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    res.status(status).json({
      error: status < 500 ? error.message : "The request could not be completed.",
    });
  });

  await syncDatabase();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error("Server could not start:", error);
    process.exitCode = 1;
  });
}

module.exports = app;
