# Repository notes

## What this project is

A single-page restaurant booking site: `site/index.html` (all UI and client logic)
plus `site/auth.js` (accounts client). It is served by `server/server.js`, a
dependency-free Node HTTP server that also provides the JSON API.

There is **no build step, no package.json and no npm dependencies**. Netlify
(`netlify.toml`, Identity, Functions) is no longer used: hosting, accounts and
bookings all come from this repository now.

## Running it in the sandbox

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

One `node:22-alpine` service runs `node --watch server/server.js` with `./site` and
`./server` bind-mounted read-only, so edits restart the process automatically. The
data file lives in the `kennies-data` volume at `/app/data/db.json` — never delete
that volume to "reset" dependencies; it holds accounts and bookings.

`docker compose -f docker-compose.base44.yml down` keeps the volume; add `-v` only
when you really mean to wipe every account and booking.

## Accounts and API

`server/server.js` stores everything in one JSON file and exposes:

- `POST /api/auth/signup|login|logout`, `GET /api/auth/me`, `POST /api/auth/password`
- `POST /api/auth/forgot`, `POST /api/auth/verify` — password reset. No mail provider
  is configured, so the reset link is printed in the server log
  (`[password-reset] email: /?recovery_token=…`); staff can copy it to the customer.
- `GET|POST /api/reservations`, `PATCH /api/reservations/:id` — customers only see and
  cancel their own bookings; manager/admin see and update all.
- `GET /api/users`, `PATCH /api/users/:id` — admin only; a role change applies at the
  user's next request because the server re-reads the account on every call.

A bootstrap admin is seeded on first boot from `ADMIN_EMAIL` / `ADMIN_PASSWORD`
(defaults `admin@kennies.local` / `kennies123`, set in `docker-compose.base44.yml`).
Change both before the site is public — signup only ever creates customers, and roles
can only be granted from the Admin page.

Sessions are an HttpOnly same-origin cookie, so serve the site and API from one origin
(as this compose file does). Behind the preview proxy the cookie gets `Secure` from
`X-Forwarded-Proto`.

## How to verify

```bash
docker compose -f docker-compose.base44.yml ps                 # web healthy
curl -sI http://localhost:3000/ | head -1                      # 200
curl -s http://localhost:3000/api/auth/me                      # {"user":null}
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/img/lava-cake.jpg
```

Then in the browser: sign up at *Log in → Create account*, add menu items, continue to
payment and confirm a booking, open *My Bookings*, then log in as the admin to check
the Bookings Desk and Admin pages.
