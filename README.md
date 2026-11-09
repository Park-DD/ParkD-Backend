# Parking API

The Express API is the source of truth for parking data. It verifies Clerk session tokens and associates each record with the authenticated Clerk user.

## Project structure

- `app.js` configures Express, Clerk authentication, public sign routes, and startup.
- `routes/parking.js` implements authenticated car and parking operations.
- `routes/parkingSignTiles.js` serves public vector tiles and parking-sign details.
- `models/` defines the Sequelize tables, relationships, and compatibility sync.
- `import-parking-signs.js` streams and imports the NYC sign CSV.
- `parking-sign-classification.js` categorizes sign panels for map styling.
- `test/` contains the Node test suite.

The backend directory has its own `.gitignore`. Keep `.env`, `node_modules/`, and uploaded car photos out of commits.

## Configuration

Copy `.env.example` to `.env` and set these required values:

- `DATABASE_URL`: PostgreSQL connection string used to store parking data.
- `CLERK_PUBLISHABLE_KEY`: publishable key for the same Clerk application used by Expo.
- `CLERK_SECRET_KEY`: server-only key used to verify Clerk sessions. Never put it in the Expo app.
- `PORT` (optional): HTTP port; defaults to `3000`.

On startup, the backend logs each missing variable and what it is used for. The app adds the parking tables and updates the existing `Users` table for Clerk-linked accounts when it starts.

Run the API from this directory:

```bash
npm install
npm run dev
```

Run the test suite with:

```bash
npm test
```

Set `EXPO_PUBLIC_API_BASE_URL` in the Expo app to a URL the device can reach. Use the computer's LAN IP for physical-device development.

Import the supplied NYC parking-sign CSV into PostgreSQL before using nearby sign lookup:

```bash
npm run import:parking-signs -- /path/to/Parking_Regulation_Locations_and_Signs.csv
```

The importer streams the CSV, imports current records with valid coordinates, converts NYC Long Island State Plane coordinates to latitude/longitude, and can be safely rerun to update rows. Each sign record is keyed separately because the CSV's `order_number` is shared by multiple signs. Sign tiles and details query PostgreSQL only; no live NYC data API request is made.

The former `seed` command was removed because it force-dropped and recreated every table. Use a disposable test database for development experiments; never run destructive synchronization against production data.

## Data model

- A `User` has many `Car` records. The Clerk user ID is stored as `clerkUserId`.
- A `Car` has at most one current `ParkingSpot`.
- A `ParkingSpot` stores the parked coordinates and time; its `parkingSignId` is optional for private or off-street parking.
- `ParkingSign` rows store imported NYC sign records and their geographic coordinates and side of street. A parking spot can reference one sign row; nearby panels at that same location are returned together.

## API

User-specific `/api` endpoints require a valid Clerk bearer token. Public NYC sign data is available without a token.

- `GET /api/parking-state` returns a user's cars, selected car, and current parking.
- `POST /api/cars` creates a car and selects it. Send `name`, `make`, `model`, and `color` as multipart form fields and an optional `image` file (JPEG, PNG, WebP, HEIC, HEIF, AVIF, or GIF; maximum 5 MB). Name defaults to the make and model.
- `PATCH /api/cars/:carId` updates an owned car's name, make, model, color, and optional photo using the same multipart fields as `POST /api/cars`.
- `GET /api/cars/:carId/image` returns an owned car's uploaded photo and requires authentication.

Car photos are currently stored on the backend filesystem in `uploads/car-images`; back up that directory with the database. Move the image storage adapter to cloud object storage before deploying to hosts with ephemeral filesystems.
- `PATCH /api/parking-state/selected-car` selects an owned car. Body: `{ "carId" }`.
- `PUT /api/parking-state/current` saves the current spot and replaces the user's prior current spot. Body: `{ "carId", "location": { "latitude", "longitude" }, "signId" }`; `signId` may be `null`.
- `GET /api/parking-signs/tiles/:z/:x/:y.pbf` returns a cacheable Mapbox Vector Tile for zoom levels 16–20. Tile bounds are queried against the imported PostgreSQL coordinates; sign categories, panel counts, and street sides are encoded into the tile. The response includes an ETag and public cache headers.
- `GET /api/parking-signs/:signId` returns complete rule descriptions for a mapped sign location. The map calls this after a user taps a tile feature.
- `GET /api/parking-signs/nearby?latitude=...&longitude=...` remains available to authenticated clients as a center-radius lookup.
- `GET /health` is a public health check.
