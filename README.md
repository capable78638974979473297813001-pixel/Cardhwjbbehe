# AfterHours backend

A time-locked, ephemeral-pin map of what's happening in a city tonight. This is the
backend: zero npm dependencies, Node 22.13+ (uses built-in `node:sqlite` and `node:test`).

```
npm test     # 23 tests, no network or real clock needed
npm start    # PORT (default 3000), DB_PATH (default ./afterhours.sqlite)
```

Env: `ADMIN_KEY` (enables admin endpoints), `ATTESTATION_MODE` = `dev` | `strict` | `off`.

## What's implemented

| Feature | How it works |
|---|---|
| 18+ only | Sign-up requires a birthdate; under-18 is rejected. |
| Midnight Shift | `POST /v1/map` returns a locked teaser (`unlocks_at`, count of scheduled spots) from 6 AM to 8 PM city-local time. Pin actions are also locked then. |
| 3-hour kill switch | Pins expire 3h after creation and drop off the map. |
| "Still Here" | Needs a device within 150 m, a different person than the creator, and **2 distinct people within 30 min** to extend. Hard cap of 12h per pin. |
| Approximate-then-exact | Viewers more than ~1 mile away see the pin snapped to a ~550 m grid cell; nearby viewers get exact coordinates. |
| Anonymous crowd count | Opt-in presence heartbeat (30 min TTL). Counts come from a 5-minute delayed snapshot, hidden under 5, shown as bands (`5+`, `10+`, `25+`, `50+`). The dots are random decoration inside the venue, not real positions, and only returned to nearby viewers. Leaving the spot or opting out removes you. **Presence stores the pin id only, never coordinates.** |
| Ghost Nodes | A squad shares a meeting *spot* (6h TTL), visible only to members. No live location sharing anywhere. |
| Flash Drops | Vendors spend a token for a 60-minute promoted pin within 5 miles; max 5 per city per night; can be scheduled up to 24h ahead (shows in the daytime teaser); always flagged `promoted: true`. |
| Safety | Category allowlist, banned-term content policy, admin-defined sensitive zones (no pins/presence), 3 reports hide a pin, stricter nightly pin cap for new accounts, GPS accuracy limit, per-user rate limit. |

## API

All `POST` bodies are JSON. Auth is `Authorization: Bearer <token>` (returned by sign-up).

```
POST   /v1/users                      {handle, birthdate}            -> {user, token}
GET    /v1/me            PATCH /v1/me {presence_opt_in}
POST   /v1/map                        {lat, lng}                     -> {locked, pins, drops, ...}
POST   /v1/pins                       {lat, lng, category, title, attestation}
POST   /v1/pins/:id/view              {lat?, lng?}
POST   /v1/pins/:id/still-here        {lat, lng, attestation}
POST   /v1/pins/:id/report            {reason}
POST   /v1/presence                   {lat, lng}      DELETE /v1/presence
POST   /v1/squads {name}   POST /v1/squads/join {invite_code}
POST   /v1/squads/:id/nodes {lat, lng, name}   GET /v1/squads/:id/nodes
POST   /v1/vendor/drops               {title, lat, lng, starts_at?}
# admin (x-admin-key)
POST   /v1/sensitive-zones            {label, lat, lng, radius_m}
POST   /v1/admin/vendors/:id/tokens   {amount}
```

## Not production-ready yet (be honest about these)

- **Device attestation is a stub.** `dev` mode accepts the literal string `dev-ok`; `strict` fails
  closed. Plug Apple App Attest / Google Play Integrity into `verifyAttestation` before launch.
  Until then "proof of presence" can be spoofed.
- **Vendor payments:** tokens are granted by an admin endpoint; no Stripe/IAP yet.
- **Sensitive zones** are an empty table you must fill (schools, hospitals, homes data, etc.).
- **Moderation** is keyword + report-count only; no human review queue, image checks, or law-enforcement
  request process.
- **Auth** is bearer tokens with no phone/email verification, so ban evasion and fake accounts are easy.
- Cities are a hard-coded list in `src/config.js`; rate limiting is in-memory (single instance).
