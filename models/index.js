const db = require("../db");
const User = require("./User");
const Car = require("./Car");
const ParkingSign = require("./ParkingSign");
const ParkingSpot = require("./ParkingSpot");

// Users own cars; each car has one current spot, and a spot may optionally reference a sign.
User.hasMany(Car, {
  foreignKey: { name: "userId", allowNull: false },
  onDelete: "CASCADE",
});
Car.belongsTo(User, { foreignKey: { name: "userId", allowNull: false } });
Car.hasOne(ParkingSpot, {
  foreignKey: { name: "carId", allowNull: false },
  onDelete: "CASCADE",
});
ParkingSpot.belongsTo(Car, { foreignKey: { name: "carId", allowNull: false } });
ParkingSign.hasMany(ParkingSpot, {
  foreignKey: { name: "parkingSignId", allowNull: true },
});
ParkingSpot.belongsTo(ParkingSign, {
  foreignKey: { name: "parkingSignId", allowNull: true },
  as: "sign",
});

async function syncDatabase() {
  const queryInterface = db.getQueryInterface();
  const tableName = User.getTableName();
  const tables = await queryInterface.showAllTables();

  // Apply small compatibility changes before Sequelize syncs the current model definitions.
  if (tables.includes(tableName)) {
    const columns = await queryInterface.describeTable(tableName);
    if (!columns.clerkUserId) {
      await queryInterface.addColumn(tableName, "clerkUserId", {
        type: User.rawAttributes.clerkUserId.type,
        allowNull: true,
      });
    }
    if (!columns.selectedCarId) {
      await queryInterface.addColumn(tableName, "selectedCarId", {
        type: User.rawAttributes.selectedCarId.type,
        allowNull: true,
      });
    }

    for (const columnName of ["name", "email", "password"]) {
      if (columns[columnName] && !columns[columnName].allowNull) {
        await queryInterface.changeColumn(tableName, columnName, {
          type: User.rawAttributes[columnName].type,
          allowNull: true,
        });
      }
    }
  }

  const carTableName = Car.getTableName();
  if (tables.includes(carTableName)) {
    const columns = await queryInterface.describeTable(carTableName);
    if (!columns.name) {
      await queryInterface.addColumn(carTableName, "name", {
        type: Car.rawAttributes.name.type,
        allowNull: true,
      });
    }
    if (!columns.imageKey) {
      await queryInterface.addColumn(carTableName, "imageKey", {
        type: Car.rawAttributes.imageKey.type,
        allowNull: true,
      });
    }
    if (!columns.imageMimeType) {
      await queryInterface.addColumn(carTableName, "imageMimeType", {
        type: Car.rawAttributes.imageMimeType.type,
        allowNull: true,
      });
    }

    await Car.update(
      {
        name: db.literal(
          'COALESCE(NULLIF(TRIM("name"), \'\'), TRIM("make" || \' \' || "model"))',
        ),
      },
      { where: db.literal('"name" IS NULL OR TRIM("name") = \'\'') },
    );
    await queryInterface.changeColumn(carTableName, "name", {
      type: Car.rawAttributes.name.type,
      allowNull: false,
    });
  }

  const parkingSignTableName = ParkingSign.getTableName();
  if (tables.includes(parkingSignTableName)) {
    const columns = await queryInterface.describeTable(parkingSignTableName);
    if (!columns.sideOfStreet) {
      await queryInterface.addColumn(parkingSignTableName, "sideOfStreet", {
        type: ParkingSign.rawAttributes.sideOfStreet.type,
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex(parkingSignTableName);
    if (
      !indexes.some((index) => index.name === "parking_sign_coordinates_idx")
    ) {
      await queryInterface.addIndex(parkingSignTableName, ["signX", "signY"], {
        name: "parking_sign_coordinates_idx",
      });
    }
    if (
      !indexes.some((index) => index.name === "parking_sign_y_idx")
    ) {
      await queryInterface.addIndex(parkingSignTableName, ["signY"], {
        name: "parking_sign_y_idx",
      });
    }
  }

  await db.sync();
}

module.exports = { db, User, Car, ParkingSign, ParkingSpot, syncDatabase };
