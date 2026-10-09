# Real-Time Solar Generation Data API

[![CI](https://github.com/Grandeur77/Solar_Generation_Data_Manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Grandeur77/Solar_Generation_Data_Manager/actions/workflows/ci.yml)

A REST API for the Sri Lanka Sustainable Energy Authority (SLSEA). Rooftop solar meters push generation
readings; SLSEA analysts read the hierarchy (province → district → grid substation → installation),
each installation's reading history and district and province generation summaries, limited to their own
jurisdiction; a registry administrator maintains the installations.

| | |
|---|---|
| **Live API** | https://solargenerationdatamanager.vercel.app |
| **Swagger UI** | https://solargenerationdatamanager.vercel.app/api-docs |
| **OpenAPI spec** | https://solargenerationdatamanager.vercel.app/api-docs/openapi |
| **Health** | https://solargenerationdatamanager.vercel.app/health |
| **Repository** | https://github.com/Grandeur77/Solar_Generation_Data_Manager |

Stack: Node.js 24, Express 5, Mongoose, MongoDB Atlas, JWT bearer tokens, Jest; deployed on Vercel (HTTPS).

## Contents

- [Getting a token](#getting-a-token)
- [Example calls](#example-calls)
- [Running it locally](#running-it-locally)
- [Seed data](#seed-data)
- [Tests and coverage](#tests-and-coverage)
- [Deployment](#deployment)
- [Project layout](#project-layout)

## Getting a token

Every resource except `/health`, `/api-docs` and `POST /auth/tokens` needs `Authorization: Bearer <token>`.
A token comes from `POST /auth/tokens`, with one of two credential pairs:

| Role | Send | Token scope | Lifetime | Can |
|---|---|---|---|---|
| National analyst | `email` + `password` | `analyst-read-by-jurisdiction` (national) | 1 h | read everything |
| Province analyst | `email` + `password` | `analyst-read-by-jurisdiction` (one province) | 1 h | read that province only |
| District analyst | `email` + `password` | `analyst-read-by-jurisdiction` (one district) | 1 h | read that district only |
| Registry admin | `email` + `password` | `asset-admin analyst-read-by-jurisdiction` (national) | 15 min | read everything; register, replace and delete installations |
| Meter (device) | `meter_id` + `device_secret` | `installation-write` (bound to its installation) | 24 h | add readings to its own installation only; read nothing |

Seeded accounts (the same in every seed run):

| Account | Email | Jurisdiction |
|---|---|---|
| National analyst | `national.analyst@slsea.example` | all of Sri Lanka |
| Western Province analyst | `western.analyst@slsea.example` | PV-01 |
| Central Province analyst | `central.analyst@slsea.example` | PV-02 |
| Colombo District analyst | `colombo.analyst@slsea.example` | DT-01 |
| Gampaha District analyst | `gampaha.analyst@slsea.example` | DT-02 |
| Kandy District analyst (**inactive**: sign-in gives 403) | `kandy.analyst@slsea.example` | DT-04 |
| Registry admin | `registry.admin@slsea.example` | all of Sri Lanka |

Every installation has a meter: `INS-0001` has `MTR-000001`, and so on up to `INS-0220` / `MTR-000220`.

**Passwords and device secrets are never in this repository.** Each seed run generates new random ones and
writes them only to `seed/credentials.json` on the machine that ran it (git-ignored, owner-readable only).
For marking, the current credentials are shared with the module leader separately.

## Example calls

Set the address once, and read a password without it appearing on screen or in your shell history:

```bash
BASE=https://solargenerationdatamanager.vercel.app     # or http://localhost:3000
EMAIL=colombo.analyst@slsea.example
read -s PASSWORD                                        # paste the password, press Enter
```

**Sign in and keep the token**

```bash
curl -s -X POST "$BASE/auth/tokens" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
# 201 {"access_token":"eyJ…","token_type":"Bearer","expires_in":3600,"scope":"analyst-read-by-jurisdiction"}

TOKEN=$(curl -s -X POST "$BASE/auth/tokens" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
```

A meter signs in the same way with `{"meter_id":"MTR-000001","device_secret":"…"}`.

**Read**

```bash
# The hierarchy, cut to the caller's jurisdiction
curl -s "$BASE/provinces" -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/districts?province-id=PV-01" -H "Authorization: Bearer $TOKEN"

# Installations: paginated { count, next, previous, results }, filtered and sorted
curl -s "$BASE/installations?district-id=DT-01&status=active&sort=-capacity_kw&page-size=5" -H "Authorization: Bearer $TOKEN"

# One installation with its latest reading embedded, and the latest reading on its own
curl -s "$BASE/installations/INS-0001" -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/installations/INS-0001/last-known-reading" -H "Authorization: Bearer $TOKEN"

# Reading history: a time window [from, to), sorted by power, 10 per page
curl -s "$BASE/installations/INS-0001/readings?from=2026-10-06T00:00:00%2B05:30&to=2026-10-07T00:00:00%2B05:30&sort=-power_kw&page-size=10" \
  -H "Authorization: Bearer $TOKEN"

# Generation summaries for a Sri Lanka calendar day (today if ?date= is left out)
curl -s "$BASE/districts/DT-01/generation-summary" -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/provinces/PV-01/generation-summary?date=2026-10-06" -H "Authorization: Bearer $TOKEN"
```

Timestamps are UTC (`…Z`). Sri Lanka is UTC+05:30, so in a query write either form, e.g.
`2026-10-06T00:00:00Z` or `2026-10-06T05:30:00%2B05:30` (`+` must be sent as `%2B`).

**Conditional GET**: send the ETag back and an unchanged resource answers `304` with no body:

```bash
ETAG=$(curl -si "$BASE/installations/INS-0001" -H "Authorization: Bearer $TOKEN" | grep -i '^etag:' | cut -d' ' -f2 | tr -d '\r')
curl -si "$BASE/installations/INS-0001" -H "Authorization: Bearer $TOKEN" -H "If-None-Match: $ETAG" | head -1
# HTTP/2 304
```

**Write**

`METER_TOKEN` comes from a meter's sign-in and `ADMIN_TOKEN` from the registry admin's, both as above.
A new reading needs the current time and an `energy_kwh` at least the installation's last total
(from `/last-known-reading`); otherwise it is refused as implausible.

```bash
# A meter adds a reading to its own installation: 201 with Location, ETag and Last-Modified
curl -si -X POST "$BASE/installations/INS-0001/readings" -H "Authorization: Bearer $METER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timestamp":"2026-10-09T12:45:00+05:30","power_kw":3.42,"energy_kwh":1021.6,"voltage":231.4}'

# The registry admin replaces an installation (the whole document), only if nobody changed it since
curl -si -X PUT "$BASE/installations/INS-0001" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -H "If-Match: $ETAG" -d @installation.json
```

A reading must be plausible for the installation (energy never decreases, power within capacity, voltage
180–270 V, not in the future) or the answer is `400 READING_IMPLAUSIBLE`; the same timestamp twice is `409`.

**Errors** all use one body, and `401` always carries `WWW-Authenticate`:

```bash
curl -si "$BASE/installations"                                         # 401 AUTHENTICATION_REQUIRED
curl -si "$BASE/districts/DT-02" -H "Authorization: Bearer $TOKEN"     # 403 OUTSIDE_JURISDICTION (a Colombo user)
# {"code":"OUTSIDE_JURISDICTION","message":"This district is outside your jurisdiction.","details":[…],"more_info":"/api-docs#error-codes"}
```

Every endpoint, parameter, status code and header is documented, with examples, in the
[Swagger UI](https://solargenerationdatamanager.vercel.app/api-docs). Every response carries
`X-Request-Id`; quote it when reporting a problem.

## Running it locally

Requires Node.js 24 and a MongoDB database (an Atlas M0 cluster works).

```bash
git clone https://github.com/Grandeur77/Solar_Generation_Data_Manager.git
cd Solar_Generation_Data_Manager
npm install
cp .env.example .env      # then fill in MONGODB_URI and JWT_SECRET
npm run setup-db          # create the indexes
npm run seed -- --yes     # load the seed data (see below)
npm run dev               # http://localhost:3000, restarts on code changes
```

| Variable | Required | Meaning |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | at least 32 random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | no | local port, default 3000 |
| `CORS_ORIGINS` | no | browser origins allowed to call the API, comma-separated; none by default |
| `AUTH_TOKEN_MAX_FAILURES` | no | failed sign-ins allowed per client per 15 minutes, default 10 |
| `LOG_REQUESTS` | no | `true` / `false` to force request logging on or off |

## Seed data

```bash
npm run seed -- --yes     # delete and reload everything; writes seed/credentials.json
npm run verify-seed       # check the scale, the parent ids and that energy never decreases
```

The seed meets the brief's scale: **9 provinces and 25 districts** (Sri Lanka's real ones), **40 grid
substations**, **220 installations**, and **8 days of 15-minute readings** per installation
(about 164,000 readings), ending at the current quarter-hour. It is idempotent: each run replaces the
previous data, so re-run it shortly before a demonstration to keep "today" current. Edge cases are built
in on purpose: three installations with no readings, inactive installations, an inactive user and cloudy days.

`npm run generate-hierarchy` rebuilds `seed/hierarchy.json` (the provinces, districts, substations and
installations), which is committed so every seed run uses the same hierarchy.

## Tests and coverage

```bash
npm test                  # 931 tests; uses an in-memory MongoDB, so no database or secrets are needed
npm run coverage          # the same, with a coverage report in coverage/
```

Coverage of `src/` (9 October 2026): 97.7 % statements, 95.0 % branches, 97.5 % functions, 97.5 % lines.

The suite covers every endpoint and status code, the conditional GET and `If-Match` rules, pagination,
filters, sorting and time windows, the generation-summary calculations against hand-computed values,
authentication and scopes, a leakage suite proving no user sees another jurisdiction's data on any read
endpoint, the hardening (rate limit, injection guard, headers, CORS), and a conformance test that checks
every real response against `openapi.yaml`.

**Smoke test against a deployment** (read-only by default):

```bash
SMOKE_BASE_URL=https://solargenerationdatamanager.vercel.app npm run smoke
```

It checks every endpoint's status, headers and shape, including `304`, `401`, `403`, `404`, `405`, `409`,
`412` and `415`, and confirms the seed's scale. It reads the credentials from `seed/credentials.json`, so it
must be the file from the seed run that loaded that database. `SMOKE_WRITE=1` also adds one real reading.

GitHub Actions runs `npm test` on every push and pull request (badge at the top).

## Deployment

Vercel runs `api/index.js`, which exports the Express app; `vercel.json` sends every path to it.
Set `MONGODB_URI` and `JWT_SECRET` in **Project → Settings → Environment Variables** for every
environment that is deployed (Production, and Preview if branches other than the production branch are
deployed), then redeploy. `.env` is only read locally.

## Project layout

```
api/index.js          Vercel entry point
src/app.js            the Express app: middleware order and routes
src/routes/           read and write routes, tokens, health, docs
src/services/         business logic and every database query (jurisdiction filtering lives here)
src/middleware/       authentication, scopes, conditional GET, errors, hardening, request id
src/models/           Mongoose models
src/utils/            validation, pagination, sorting, time windows, tokens
scripts/              setup-db, seed, verify-seed, generate-hierarchy, smoke-test
seed/hierarchy.json   the seeded hierarchy
tests/                Jest tests (in-memory MongoDB)
openapi.yaml          the API contract, served at /api-docs
docs/design/          the data model
```
