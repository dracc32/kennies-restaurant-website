# Repository notes

## What this project is

A single-page restaurant booking prototype (`index.html` + Netlify Identity helper
`auth.js`). There is **no build step, no package.json and no server code**:
`netlify.toml` publishes the static folder `deploy-6ae1ec6b5f4c161d122f9211`.

## Running it in the sandbox

`docker-compose.base44.yml` runs one `nginx:alpine` service that serves the publish
folder straight from the bind-mounted checkout on host port 3000. Because the files
are mounted (not baked into an image) an edit to `index.html`/`auth.js` shows up on
the next page load — there is no watcher or compiler to wait for, but a full preview
reload is needed if the browser cached the page.

No environment variables or secrets are required to boot.

## Netlify-only pieces that do not exist locally

The frontend talks to Netlify platform features that are not part of this repository,
so they 404 in the sandbox (`/.netlify/identity/*` and `/api/*`):

- `/.netlify/identity` — Netlify Identity. Login, signup, password reset and every
  signed-in screen (My Bookings, Bookings Desk, Admin) need it. A failed login leaves
  an **empty** error box because the thrown `AuthError` carries no message.
- `/api/reservations` and `/api/users` — Netlify Functions that are not in this
  checkout. "Confirm Booking & Payment", the bookings desk and the admin user list
  cannot work without them.

So a local run covers: home, menu + category filters, cart/order totals, reservation
form and the payment step up to the login prompt.

## How to verify

```bash
docker compose -f docker-compose.base44.yml up -d --build
docker compose -f docker-compose.base44.yml ps          # web should be healthy
curl -sI http://localhost:3000/ | head -1               # 200
curl -sI http://localhost:3000/auth.js | grep Content-Type   # application/javascript
```

Then in the browser: Home → Menu (filter a category) → `+ Add` → Order → Continue to
Reservation → fill name/email/date → Continue to Payment.
