const express = require("express");
const proj4 = require("proj4");
const multer = require("multer");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Op } = require("sequelize");
const { db, User, Car, ParkingSign, ParkingSpot } = require("../models");
const { getRestrictionType } = require("../parking-sign-classification");

const router = express.Router();
const nyLongIsland = "+proj=lcc +lat_1=41.03333333333333 +lat_2=40.66666666666666 +lat_0=40.16666666666666 +lon_0=-74 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs";
const searchRadiusMeters = 120;
const feetPerMeter = 1 / 0.3048006096;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const carImageDirectory = path.join(__dirname, "..", "uploads", "car-images");
const imageExtensions = {
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireNumber(value, name, minimum, maximum) {
  const number = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(number) || number < minimum || number > maximum) {
    throw new ApiError(400, `${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return number;
}

function requireUuid(value, name) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${name} is invalid.`);
  }
  return value;
}

const uploadCarImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => {
      fs.mkdir(carImageDirectory, { recursive: true }, error => callback(error, carImageDirectory));
    },
    filename: (req, file, callback) => {
      callback(null, `${randomUUID()}${imageExtensions[file.mimetype]}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!imageExtensions[file.mimetype]) {
      callback(new ApiError(400, "Car photos must be JPEG, PNG, WebP, HEIC, HEIF, AVIF, or GIF images."));
      return;
    }
    callback(null, true);
  },
});

function parseCarImage(req, res, next) {
  uploadCarImage.single("image")(req, res, error => {
    if (error instanceof multer.MulterError) {
      error.status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    }
    next(error);
  });
}

function getImagePath(car) {
  return car.imageKey ? `/api/cars/${car.id}/image` : null;
}

function getStreetLabel(sign) {
  const intersection = [sign.fromStreet, sign.toStreet].filter(Boolean).join(" & ");
  return [sign.street, intersection].filter(Boolean).join(" near ");
}

function getDistanceMeters(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1]) * 0.3048006096;
}

function groupNearbySigns(signs, origin) {
  // CSV rows sharing a projected coordinate are panels on one physical sign location.
  const groups = new Map();
  for (const sign of signs) {
    const key = `${sign.signX},${sign.signY}`;
    let group = groups.get(key);
    if (!group) {
      const distanceMeters = getDistanceMeters(origin, [sign.signX, sign.signY]);
      if (distanceMeters > searchRadiusMeters) {
        continue;
      }
      group = {
        id: sign.id,
        street: getStreetLabel(sign) || "Nearby street sign",
        sideOfStreet: sign.sideOfStreet,
        latitude: sign.latitude,
        longitude: sign.longitude,
        distanceMeters,
        signs: [],
      };
      groups.set(key, group);
    }
    group.signs.push({
      id: sign.sourceId,
      code: sign.signCode,
      description: sign.description,
    });
  }

  return [...groups.values()]
    .map(group => {
      const signsInGroup = group.signs.filter(sign => sign.description || sign.code);
      return {
        ...group,
        type: getRestrictionType(signsInGroup),
        signs: signsInGroup,
      };
    })
    .sort((first, second) => first.distanceMeters - second.distanceMeters);
}

async function getNearbySignsFromDatabase(x, y) {
  const searchRadiusFeet = searchRadiusMeters * feetPerMeter;
  // The bounding query uses the indexed NYC projection; exact distance is checked after retrieval.
  const cachedSigns = await ParkingSign.findAll({
    where: {
      sourceId: { [Op.like]: "csv:%" },
      signX: { [Op.between]: [x - searchRadiusFeet, x + searchRadiusFeet] },
      signY: { [Op.between]: [y - searchRadiusFeet, y + searchRadiusFeet] },
    },
    attributes: [
      "id",
      "sourceId",
      "street",
      "fromStreet",
      "toStreet",
      "sideOfStreet",
      "signCode",
      "description",
      "signX",
      "signY",
      "latitude",
      "longitude",
    ],
  });

  return groupNearbySigns(cachedSigns, [x, y]);
}

async function getOrCreateUser(clerkUserId, transaction) {
  const [user] = await User.findOrCreate({
    where: { clerkUserId },
    defaults: {},
    transaction,
  });
  return user;
}

async function serializeSignGroup(sign) {
  const group = await ParkingSign.findAll({
    where: { signX: sign.signX, signY: sign.signY },
    order: [["sourceId", "ASC"]],
  });
  const first = group[0] || sign;
  const signs = group
    .filter(record => record.description || record.signCode)
    .map(record => ({
      id: record.sourceId,
      code: record.signCode,
      description: record.description,
    }));
  return {
    id: first.id,
    street: getStreetLabel(first) || "Nearby street sign",
    sideOfStreet: first.sideOfStreet,
    latitude: first.latitude,
    longitude: first.longitude,
    type: getRestrictionType(signs),
    signs,
  };
}

async function getCurrentParkingState(user) {
  const cars = await Car.findAll({
    where: { userId: user.id },
    order: [["createdAt", "ASC"]],
  });
  const selectedCarExists = cars.some(car => car.id === user.selectedCarId);
  const selectedCarId = selectedCarExists ? user.selectedCarId : null;

  const parkingByCar = new Map();
  if (cars.length > 0) {
    // Keep only the newest active spot per car if legacy rows contain duplicates.
    const spots = await ParkingSpot.findAll({
      where: { carId: { [Op.in]: cars.map(car => car.id) } },
      include: [{ model: ParkingSign, as: "sign" }],
      order: [["parkedAt", "DESC"]],
    });

    for (const spot of spots) {
      if (!parkingByCar.has(spot.carId)) {
        parkingByCar.set(spot.carId, {
          carId: spot.carId,
          parkedAt: spot.parkedAt.toISOString(),
          location: { latitude: spot.latitude, longitude: spot.longitude },
          sign: spot.sign ? await serializeSignGroup(spot.sign) : null,
        });
      }
    }
  }

  const activeParking = parkingByCar.values().next().value || null;

  return {
    cars: cars.map(car => ({
      id: car.id,
      name: car.name,
      make: car.make,
      model: car.model,
      color: car.color || "",
      imagePath: getImagePath(car),
      parking: parkingByCar.get(car.id) || null,
    })),
    selectedCarId,
    activeParking,
  };
}

router.get("/parking-state", async (req, res) => {
  const user = await getOrCreateUser(req.clerkUserId);
  res.status(200).json(await getCurrentParkingState(user));
});

router.post("/cars", parseCarImage, async (req, res) => {
  const body = req.body;
  const requestedName = typeof body.name === "string" ? body.name.trim() : "";
  const make = typeof body.make === "string" ? body.make.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const color = typeof body.color === "string" ? body.color.trim() : "";
  const name = requestedName || `${make} ${model}`.trim();
  if (
    !make || !model || name.length > 100 || make.length > 100 || model.length > 100 ||
    color.length > 100
  ) {
    throw new ApiError(400, "A car make and model are required; name, make, model, and color must be 100 characters or fewer.");
  }

  const user = await getOrCreateUser(req.clerkUserId);
  let car;
  try {
    car = await db.transaction(async transaction => {
      const createdCar = await Car.create(
        {
          name,
          make,
          model,
          color: color || null,
          imageKey: req.file?.filename || null,
          imageMimeType: req.file?.mimetype || null,
          userId: user.id,
        },
        { transaction },
      );
      await user.update({ selectedCarId: createdCar.id }, { transaction });
      return createdCar;
    });
  } catch (error) {
    if (req.file) {
      await fs.promises.unlink(req.file.path).catch(unlinkError => {
        console.error("Could not remove car photo after car creation failed:", unlinkError);
      });
    }
    throw error;
  }
  res.status(201).json({
    car: {
      id: car.id,
      name: car.name,
      make: car.make,
      model: car.model,
      color: car.color || "",
      imagePath: getImagePath(car),
    },
  });
});

router.patch("/cars/:carId", parseCarImage, async (req, res) => {
  const carId = requireUuid(req.params.carId, "carId");
  const body = req.body;
  const requestedName = typeof body.name === "string" ? body.name.trim() : "";
  const make = typeof body.make === "string" ? body.make.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const color = typeof body.color === "string" ? body.color.trim() : "";
  const name = requestedName || `${make} ${model}`.trim();
  if (
    !make || !model || name.length > 100 || make.length > 100 || model.length > 100 ||
    color.length > 100
  ) {
    throw new ApiError(400, "A car make and model are required; name, make, model, and color must be 100 characters or fewer.");
  }

  const user = await getOrCreateUser(req.clerkUserId);
  const car = await Car.findOne({ where: { id: carId, userId: user.id } });
  if (!car) {
    if (req.file) {
      await fs.promises.unlink(req.file.path).catch(error => {
        console.error("Could not remove uploaded photo for unknown car:", error);
      });
    }
    throw new ApiError(404, "Car not found.");
  }

  const previousImageKey = car.imageKey;
  try {
    await car.update({
      name,
      make,
      model,
      color: color || null,
      ...(req.file
        ? { imageKey: req.file.filename, imageMimeType: req.file.mimetype }
        : {}),
    });
  } catch (error) {
    if (req.file) {
      await fs.promises.unlink(req.file.path).catch(unlinkError => {
        console.error("Could not remove car photo after car update failed:", unlinkError);
      });
    }
    throw error;
  }

  if (req.file && previousImageKey) {
    await fs.promises.unlink(path.join(carImageDirectory, previousImageKey)).catch(error => {
      console.error("Could not remove replaced car photo:", error);
    });
  }

  res.status(200).json({
    car: {
      id: car.id,
      name: car.name,
      make: car.make,
      model: car.model,
      color: car.color || "",
      imagePath: getImagePath(car),
    },
  });
});

router.get("/cars/:carId/image", async (req, res, next) => {
  const carId = requireUuid(req.params.carId, "carId");
  const user = await getOrCreateUser(req.clerkUserId);
  const car = await Car.findOne({ where: { id: carId, userId: user.id } });
  if (!car || !car.imageKey) {
    throw new ApiError(404, "Car photo not found.");
  }

  const imageFile = path.join(carImageDirectory, car.imageKey);
  res.status(200);
  res.type(car.imageMimeType || "application/octet-stream");
  res.set("Cache-Control", "private, max-age=3600");
  res.sendFile(imageFile, error => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
});

router.patch("/parking-state/selected-car", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { carId } = body;
  if (carId !== null) {
    requireUuid(carId, "carId");
  }
  const user = await getOrCreateUser(req.clerkUserId);
  if (carId !== null) {
    const car = await Car.findOne({ where: { id: carId, userId: user.id } });
    if (!car) {
      throw new ApiError(404, "Car not found.");
    }
  }
  await user.update({ selectedCarId: carId });
  res.status(200).json({ selectedCarId: carId });
});

router.put("/parking-state/current", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const carId = requireUuid(body.carId, "carId");
  const latitude = requireNumber(body.location?.latitude, "latitude", -90, 90);
  const longitude = requireNumber(body.location?.longitude, "longitude", -180, 180);
  const signId = body.signId ?? null;
  if (signId !== null) {
    requireUuid(signId, "signId");
  }

  const user = await getOrCreateUser(req.clerkUserId);
  // Replacing a car's current spot and associating its optional sign must be atomic.
  await db.transaction(async transaction => {
    const car = await Car.findOne({ where: { id: carId, userId: user.id }, transaction });
    if (!car) {
      throw new ApiError(404, "Car not found.");
    }
    const sign = signId
      ? await ParkingSign.findByPk(signId, { transaction })
      : null;
    if (signId && !sign) {
      throw new ApiError(404, "Parking sign not found. Search for nearby signs again.");
    }

    await ParkingSpot.destroy({
      where: { carId },
      transaction,
    });
    await ParkingSpot.create({
      carId,
      latitude,
      longitude,
      parkedAt: new Date(),
      parkingSignId: sign ? sign.id : null,
    }, { transaction });
  });

  res.status(200).json({ status: "saved" });
});

router.get("/parking-signs/nearby", async (req, res) => {
  const latitude = requireNumber(req.query.latitude, "latitude", -90, 90);
  const longitude = requireNumber(req.query.longitude, "longitude", -180, 180);
  const [x, y] = proj4("EPSG:4326", nyLongIsland, [longitude, latitude]);
  res
    .status(200)
    .set("X-Data-Source", "postgres")
    .json(await getNearbySignsFromDatabase(x, y));
});

module.exports = router;
