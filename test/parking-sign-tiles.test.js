process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const geojsonvtModule = require("geojson-vt");
const proj4 = require("proj4");
const { fromGeojsonVt } = require("vt-pbf");
const {
  createFeatures,
  getExpandedTileBounds,
  getProjectedBounds,
  getTileBounds,
  router,
} = require("../routes/parkingSignTiles");
const { ParkingSign } = require("../models");

const nyLongIsland = "+proj=lcc +lat_1=41.03333333333333 +lat_2=40.66666666666666 +lat_0=40.16666666666666 +lon_0=-74 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs";

function getTileCoordinates(longitude, latitude, zoom) {
  const scale = 2 ** zoom;
  return [
    Math.floor((longitude + 180) / 360 * scale),
    Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * scale),
  ];
}

test("computes WGS84 and projected bounds for a valid New York tile", () => {
  const [x, y] = getTileCoordinates(-73.9855, 40.758, 16);
  const bounds = getTileBounds(16, x, y);
  const projected = getProjectedBounds(bounds);

  assert.ok(bounds.west < -73.9855 && bounds.east > -73.9855);
  assert.ok(bounds.south < 40.758 && bounds.north > 40.758);
  assert.ok(projected.minX < projected.maxX);
  assert.ok(projected.minY < projected.maxY);
});

test("encodes categorized sign markers at their mapped coordinates without fan-out lines", () => {
  const zoom = 19;
  const [x, y] = getTileCoordinates(-73.9855, 40.758, zoom);
  const [signX, signY] = proj4("EPSG:4326", nyLongIsland, [-73.9855, 40.758]);
  const nearby = proj4(nyLongIsland, "EPSG:4326", [signX + 6, signY]);
  const features = createFeatures([
    {
      id: "sign-one",
      sourceId: "csv:one",
      street: "Broadway",
      sideOfStreet: "W",
      signCode: null,
      description: "NO PARKING ANYTIME",
      signX,
      signY,
      latitude: 40.758,
      longitude: -73.9855,
    },
    {
      id: "sign-two",
      sourceId: "csv:two",
      street: "Broadway",
      sideOfStreet: "E",
      signCode: null,
      description: "NO STANDING ANYTIME",
      signX: signX + 6,
      signY,
      latitude: nearby[1],
      longitude: nearby[0],
    },
  ]);
  const index = new (geojsonvtModule.default || geojsonvtModule)(features, {
    extent: 4096,
    buffer: 64,
    maxZoom: 20,
    indexMaxZoom: 0,
    indexMaxPoints: 0,
  });
  const tile = index.getTile(zoom, x, y);
  assert.ok(tile);
  const badges = features.features.filter(feature => feature.properties.markerType === "badge");
  assert.equal(badges.length, 2);
  assert.equal(features.features.length, 2);
  assert.deepEqual(new Set(badges.map(feature => feature.properties.type)), new Set(["no_parking", "no_standing"]));
  assert.ok(badges.some(feature => feature.geometry.coordinates[0] === -73.9855));
  assert.ok(badges.some(feature => feature.geometry.coordinates[0] === nearby[0]));
  assert.ok(fromGeojsonVt({ parking_signs: tile }).length > 0);
});

test("returns a valid encoded empty tile for areas outside New York City", () => {
  const bounds = getExpandedTileBounds(16, 0, 0);
  assert.ok(bounds.east < -74.3 || bounds.west > -73.65);
  const emptyTile = fromGeojsonVt({ parking_signs: { features: [], extent: 4096 } });
  assert.ok(emptyTile.length > 0);
});

test("serves public vector tiles with cache validators and public sign details", async () => {
  const [signX, signY] = proj4("EPSG:4326", nyLongIsland, [-73.9855, 40.758]);
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    sourceId: "csv:public-sign",
    street: "Broadway",
    fromStreet: null,
    toStreet: null,
    sideOfStreet: "W",
    signCode: null,
    description: "NO PARKING ANYTIME",
    signX,
    signY,
    latitude: 40.758,
    longitude: -73.9855,
  };
  const originalFindAll = ParkingSign.findAll;
  const originalFindByPk = ParkingSign.findByPk;
  let queryCount = 0;
  ParkingSign.findAll = async () => {
    queryCount += 1;
    return [row];
  };
  ParkingSign.findByPk = async () => row;
  const app = express();
  app.use(router);
  const server = app.listen(0);

  try {
    await new Promise(resolve => server.once("listening", resolve));
    const { port } = server.address();
    const outsideResponse = await fetch(
      `http://127.0.0.1:${port}/api/parking-signs/tiles/16/0/0.pbf`,
    );
    assert.equal(outsideResponse.status, 200);
    assert.ok((await outsideResponse.arrayBuffer()).byteLength > 0);
    assert.equal(queryCount, 0);

    const [x, y] = getTileCoordinates(row.longitude, row.latitude, 16);
    const tileUrl = `http://127.0.0.1:${port}/api/parking-signs/tiles/16/${x}/${y}.pbf`;
    const tileResponse = await fetch(tileUrl);
    assert.equal(tileResponse.status, 200);
    assert.match(tileResponse.headers.get("content-type"), /application\/vnd\.mapbox-vector-tile/);
    assert.match(tileResponse.headers.get("cache-control"), /public/);
    const etag = tileResponse.headers.get("etag");
    assert.ok(etag);
    assert.equal(queryCount, 1);
    const cachedResponse = await fetch(tileUrl, { headers: { "If-None-Match": etag } });
    assert.equal(cachedResponse.status, 304);
    assert.equal(queryCount, 1);

    const detailsResponse = await fetch(
      `http://127.0.0.1:${port}/api/parking-signs/${row.id}`,
    );
    assert.equal(detailsResponse.status, 200);
    assert.equal((await detailsResponse.json()).signs[0].description, row.description);
    const invalidTileResponse = await fetch(
      `http://127.0.0.1:${port}/api/parking-signs/tiles/15/${x}/${y}.pbf`,
    );
    assert.equal(invalidTileResponse.status, 400);
  } finally {
    ParkingSign.findAll = originalFindAll;
    ParkingSign.findByPk = originalFindByPk;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
