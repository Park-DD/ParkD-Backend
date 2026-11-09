const crypto = require("node:crypto");
const express = require("express");
const geojsonvtModule = require("geojson-vt");
const proj4 = require("proj4");
const { fromGeojsonVt } = require("vt-pbf");
const { Op } = require("sequelize");
const { ParkingSign } = require("../models");
const { getRestrictionType } = require("../parking-sign-classification");

const router = express.Router();
const geojsonvt = geojsonvtModule.default || geojsonvtModule;
const nyLongIsland = "+proj=lcc +lat_1=41.03333333333333 +lat_2=40.66666666666666 +lat_0=40.16666666666666 +lon_0=-74 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs";
const minimumZoom = 16;
const maximumZoom = 20;
const tileCacheDurationMs = 60_000;
const maximumCachedTiles = 500;
const tileCache = new Map();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getTileBounds(z, x, y) {
  const scale = 2 ** z;
  const longitude = tileX => tileX / scale * 360 - 180;
  const latitude = tileY => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / scale))) * 180 / Math.PI;
  return {
    west: longitude(x),
    east: longitude(x + 1),
    north: latitude(y),
    south: latitude(y + 1),
  };
}

function getProjectedBounds(bounds) {
  // PostGIS-free tile lookup uses the same Long Island State Plane coordinates as the CSV.
  const corners = [
    [bounds.west, bounds.south],
    [bounds.west, bounds.north],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
  ].map(coordinate => proj4("EPSG:4326", nyLongIsland, coordinate));
  return {
    minX: Math.min(...corners.map(([x]) => x)),
    maxX: Math.max(...corners.map(([x]) => x)),
    minY: Math.min(...corners.map(([, y]) => y)),
    maxY: Math.max(...corners.map(([, y]) => y)),
  };
}

function getExpandedTileBounds(z, x, y) {
  const bounds = getTileBounds(z, x, y);
  const latitude = (bounds.north + bounds.south) / 2;
  const latitudeMargin = 12 / 111_320;
  const longitudeMargin = latitudeMargin / Math.max(0.01, Math.cos(latitude * Math.PI / 180));
  return {
    west: bounds.west - longitudeMargin,
    east: bounds.east + longitudeMargin,
    north: Math.min(85.05112878, bounds.north + latitudeMargin),
    south: Math.max(-85.05112878, bounds.south - latitudeMargin),
  };
}

function createFeatures(signs) {
  // Keep one point per physical sign location and include all of its regulatory panels.
  const groups = new Map();
  for (const sign of signs) {
    const key = `${sign.signX},${sign.signY}`;
    const group = groups.get(key) || {
      id: sign.id,
      signX: sign.signX,
      signY: sign.signY,
      latitude: sign.latitude,
      longitude: sign.longitude,
      street: [sign.street, [sign.fromStreet, sign.toStreet].filter(Boolean).join(" & ")]
        .filter(Boolean)
        .join(" near ") || "Nearby street sign",
      sideOfStreet: sign.sideOfStreet || "",
      signs: [],
    };
    group.signs.push({
      id: sign.sourceId,
      code: sign.signCode,
      description: sign.description,
    });
    if (!groups.has(key)) {
      groups.set(key, group);
    }
  }

  const groupedSigns = [...groups.values()].map(group => ({
    ...group,
    signs: group.signs.filter(sign => sign.description || sign.code),
  }));
  const features = [];

  for (const sign of groupedSigns) {
    const type = getRestrictionType(sign.signs);
    const properties = {
      signId: sign.id,
      type,
      panelCount: sign.signs.length,
      sideOfStreet: sign.sideOfStreet,
      street: sign.street,
    };
    features.push({
      type: "Feature",
      properties: { ...properties, markerType: "badge" },
      geometry: { type: "Point", coordinates: [sign.longitude, sign.latitude] },
    });
  }

  return { type: "FeatureCollection", features };
}

function getCachedTile(key) {
  const cached = tileCache.get(key);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.createdAt >= tileCacheDurationMs) {
    tileCache.delete(key);
    return null;
  }
  return cached;
}

function cacheTile(key, tile) {
  // Evict the oldest inserted tile when the in-memory cache reaches its fixed size.
  if (tileCache.size >= maximumCachedTiles) {
    tileCache.delete(tileCache.keys().next().value);
  }
  tileCache.set(key, { ...tile, createdAt: Date.now() });
}

async function createTile(z, x, y) {
  const bounds = getExpandedTileBounds(z, x, y);
  if (
    bounds.east < -74.3 || bounds.west > -73.65 ||
    bounds.north < 40.45 || bounds.south > 41.0
  ) {
    return {
      body: Buffer.from(fromGeojsonVt({
        parking_signs: { features: [], extent: 4096 },
      })),
      etag: null,
    };
  }
  const projectedBounds = getProjectedBounds(bounds);
  // Query only signs in this tile's projected bounds plus a small edge buffer.
  const signs = await ParkingSign.findAll({
    where: {
      sourceId: { [Op.like]: "csv:%" },
      signX: { [Op.between]: [projectedBounds.minX, projectedBounds.maxX] },
      signY: { [Op.between]: [projectedBounds.minY, projectedBounds.maxY] },
    },
    attributes: [
      "id", "sourceId", "street", "fromStreet", "toStreet", "sideOfStreet",
      "signCode", "description", "signX", "signY", "latitude", "longitude",
    ],
  });
  const index = new geojsonvt(createFeatures(signs), {
    extent: 4096,
    buffer: 64,
    maxZoom: maximumZoom,
    indexMaxZoom: 0,
    indexMaxPoints: 0,
  });
  const tile = index.getTile(z, x, y) || { features: [], extent: 4096 };
  const body = Buffer.from(fromGeojsonVt({ parking_signs: tile }));
  const etag = `"${crypto.createHash("sha256").update(body).digest("base64url")}"`;
  return { body, etag };
}

router.get("/api/parking-signs/tiles/:z/:x/:y.pbf", async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  if (
    !Number.isInteger(z) || z < minimumZoom || z > maximumZoom ||
    !Number.isInteger(x) || !Number.isInteger(y) ||
    x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
  ) {
    return res.status(400).json({ error: `Tile coordinates must be valid at zoom ${minimumZoom}–${maximumZoom}.` });
  }

  const key = `${z}/${x}/${y}`;
  let tile = getCachedTile(key);
  if (!tile) {
    tile = await createTile(z, x, y);
    if (!tile.etag) {
      tile.etag = `"${crypto.createHash("sha256").update(tile.body).digest("base64url")}"`;
    }
    cacheTile(key, tile);
  }
  res
    .set("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400")
    .set("ETag", tile.etag)
    .type("application/vnd.mapbox-vector-tile");
  const requestEtags = (req.get("If-None-Match") || "")
    .split(",")
    .map(etag => etag.trim().replace(/^W\//, ""));
  if (requestEtags.includes("*") || requestEtags.includes(tile.etag)) {
    return res.status(304).end();
  }
  return res.status(200).send(tile.body);
});

router.get("/api/parking-signs/:signId", async (req, res, next) => {
  if (req.params.signId === "nearby") {
    return next();
  }
  if (!uuidPattern.test(req.params.signId)) {
    return res.status(400).json({ error: "signId is invalid." });
  }
  const sign = await ParkingSign.findByPk(req.params.signId);
  if (!sign) {
    return res.status(404).json({ error: "Parking sign not found." });
  }
  const group = await ParkingSign.findAll({
    where: {
      sourceId: { [Op.like]: "csv:%" },
      signX: sign.signX,
      signY: sign.signY,
    },
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
  const intersection = [first.fromStreet, first.toStreet].filter(Boolean).join(" & ");
  res
    .set("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400")
    .status(200)
    .json({
      id: first.id,
      street: [first.street, intersection].filter(Boolean).join(" near ") || "Nearby street sign",
      sideOfStreet: first.sideOfStreet,
      latitude: first.latitude,
      longitude: first.longitude,
      type: getRestrictionType(signs),
      signs,
    });
});

module.exports = {
  createFeatures,
  getExpandedTileBounds,
  getProjectedBounds,
  getTileBounds,
  router,
};
