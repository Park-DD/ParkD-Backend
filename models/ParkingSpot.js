const { DataTypes } = require("sequelize");
const db = require("../db");

const ParkingSpot = db.define("ParkingSpot", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  latitude: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  longitude: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  parkedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

module.exports = ParkingSpot;
