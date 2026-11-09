const { DataTypes } = require("sequelize");
const db = require("../db");

const ParkingSign = db.define("ParkingSign", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  sourceId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  street: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  fromStreet: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  toStreet: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  sideOfStreet: {
    type: DataTypes.STRING(8),
    allowNull: true,
  },
  signCode: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  signX: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  signY: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  latitude: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  longitude: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
}, {
  indexes: [
    { fields: ["signX", "signY"], name: "parking_sign_coordinates_idx" },
  ],
});

module.exports = ParkingSign;
