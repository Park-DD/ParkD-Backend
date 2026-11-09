const { DataTypes } = require("sequelize");
const db = require("../db");

const User = db.define("User", {
  name: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: { notEmpty: true },
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    validate: { isEmail: true },
  },
  password: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  clerkUserId: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
  },
  selectedCarId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
});

module.exports = User;
