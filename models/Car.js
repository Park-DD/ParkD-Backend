const { DataTypes } = require("sequelize");
const db = require("../db");

const Car = db.define("Car", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: { notEmpty: true },
  },
  make: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: { notEmpty: true },
  },
  model: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: { notEmpty: true },
  },
  color: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  imageKey: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  imageMimeType: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
});

module.exports = Car;
