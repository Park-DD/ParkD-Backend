require("dotenv").config();

const { Sequelize } = require("sequelize");

// Database credentials come only from the backend environment, never from the Expo client.
const db = new Sequelize(process.env.DATABASE_URL, {
  logging: false,
});

module.exports = db;
