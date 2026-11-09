const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { parse } = require("csv-parse");
const proj4 = require("proj4");
const { db, ParkingSign, syncDatabase } = require("./models");

const nyLongIsland = "+proj=lcc +lat_1=41.03333333333333 +lat_2=40.66666666666666 +lat_0=40.16666666666666 +lon_0=-74 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs";
const batchSize = 2000;
const updateColumns = [
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
];
const requiredColumns = [
  "order_number",
  "record_type",
  "on_street",
  "from_street",
  "to_street",
  "side_of_street",
  "sign_code",
  "sign_description",
  "sign_notes",
  "sign_x_coord",
  "sign_y_coord",
];

function parseCoordinate(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
}

function makeSourceId(record, signX, signY) {
  // order_number is shared by panels; the content fingerprint makes each source row stable.
  const identity = JSON.stringify({ ...record, sign_x_coord: signX, sign_y_coord: signY });
  const fingerprint = createHash("sha256").update(identity).digest("hex");
  return `csv:${record.order_number}:${fingerprint}`;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    throw new Error("Usage: npm run import-parking-signs -- <path-to-csv>");
  }

  await syncDatabase();
  const parser = createReadStream(path.resolve(csvPath)).pipe(parse({
    bom: true,
    columns: headers => {
      const missingColumns = requiredColumns.filter(column => !headers.includes(column));
      if (missingColumns.length > 0) {
        throw new Error(`CSV is missing required columns: ${missingColumns.join(", ")}`);
      }
      return headers;
    },
    skip_empty_lines: true,
    trim: true,
  }));

  let batch = [];
  let batchSourceIds = new Set();
  let rowsRead = 0;
  let imported = 0;
  let skipped = 0;

  const flushBatch = async () => {
    if (batch.length === 0) {
      return;
    }
    await ParkingSign.bulkCreate(batch, {
      updateOnDuplicate: updateColumns,
    });
    imported += batch.length;
    batch = [];
    batchSourceIds = new Set();
    if (imported % 100000 === 0) {
      console.info(`Imported ${imported.toLocaleString()} parking sign rows...`);
    }
  };

  for await (const record of parser) {
    rowsRead += 1;
    if (record.record_type !== "Current") {
      skipped += 1;
      continue;
    }

    const orderNumber = record.order_number;
    const signX = parseCoordinate(record.sign_x_coord);
    const signY = parseCoordinate(record.sign_y_coord);
    if (!orderNumber || signX === null || signY === null) {
      skipped += 1;
      continue;
    }

    // Store both the source projection for fast spatial queries and WGS84 for map clients.
    const [longitude, latitude] = proj4(nyLongIsland, "EPSG:4326", [signX, signY]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      skipped += 1;
      continue;
    }

    const sourceId = makeSourceId(record, signX, signY);
    if (batchSourceIds.has(sourceId)) {
      skipped += 1;
      continue;
    }

    batchSourceIds.add(sourceId);
    batch.push({
      sourceId,
      street: record.on_street || "",
      fromStreet: record.from_street || null,
      toStreet: record.to_street || null,
      sideOfStreet: record.side_of_street || null,
      signCode: record.sign_code || null,
      description: record.sign_description || null,
      signX,
      signY,
      latitude,
      longitude,
    });

    if (batch.length >= batchSize) {
      await flushBatch();
    }
  }

  await flushBatch();
  console.info(
    `Parking sign import complete: ${imported.toLocaleString()} rows imported, ` +
    `${skipped.toLocaleString()} skipped, ${rowsRead.toLocaleString()} CSV rows read.`,
  );
}

main()
  .catch(error => {
    console.error("Parking sign CSV import failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
