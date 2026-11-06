# Travel planner

An open-source trip planner that runs in the browser. You answer a few questions, an AI builds a
day-by-day itinerary, and the same plan shows up in three views — **Itinerary**, **Calendar** and
**Map** — with live photos, ratings and real travel routes. A trip assistant can then propose
changes that you approve before they are applied.

A sample trip (*Japan in Autumn*, 18 days) is included and can be opened from the start screen.

## Start it

You need **Node.js 18 or newer** — nothing else, no install step.

```bash
npm start
```

The site opens at <http://127.0.0.1:4173>. `npm start -- --no-open` starts without opening a
browser; `PORT=8080 npm start` uses another port.

## Keys

Open **Keys & settings** (the gear in the top bar, or on the start screen). Both keys are stored in
this browser's `localStorage` and sent only to their own service.

| Key | Used for | Where to get it |
|---|---|---|
| **DeepSeek** | Generating itineraries and the trip assistant | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| **Google Maps Platform** | Map, place search, photos, ratings, reviews, routes | [Google Cloud console](https://console.cloud.google.com/google/maps-apis/credentials) |

For the Google key, enable these three APIs on the project:

- **Maps JavaScript API** — the map
- **Places API (New)** — finding each place, its photos, rating and reviews
- **Routes API** — walking, driving and public-transport routes and times

Then restrict the key to your site's address (HTTP referrers, e.g. `http://127.0.0.1:4173/*` and
your production domain), because it is used from the browser. The **Map ID** is optional; without
one the app uses Google's `DEMO_MAP_ID`. For a custom map style, create a Map ID in the console.

## How a trip is generated

1. **Questions** — destination, dates, arrival/departure, who is travelling, interests, pace,
   walking, transport, accommodation, budget, diet, must-dos and things to avoid.
2. **Outline** (DeepSeek) — route, hotels, a title and purpose for each day, and the day's
   highlights.
3. **Days** (DeepSeek, three days per call, in parallel) — timed items, meals, travel modes,
   rain plans, alternatives and watch-outs.
4. **Places** (Google Places) — every place is matched to a Google place id and coordinates,
   biased to its city. That match is what keeps the itinerary, calendar and map in step.

The planning instructions live in **`skills/itinerary.md`**. It is a placeholder: replace it with
your own itinerary-generation skill. The app sends it as the planner's instructions and adds the
JSON format it needs itself (`assets/generator.js`), so the skill only has to describe how to plan.

## What is stored where

| Data | Where | How long |
|---|---|---|
| Trips (days, items, place names, kinds, coordinates, Google place ids) | `localStorage` (`trips-v1`, `trip:<id>`) | Until deleted |
| Chat history | `localStorage` (`trip-chat:<id>`) | Until the trip is deleted |
| Photos, ratings, addresses, reviews | `sessionStorage` (`google-places-session-v1`) | This browser session |
| Routes and travel times | `sessionStorage` (`trip-route-session-v1`) | This browser session |

Photos are never downloaded: the page points `<img>` tags at the Places photo endpoint and the
browser loads them from Google. Place details are fetched only for rows that scroll into view.
This also follows Google's terms, which allow storing place ids but not caching Places content,
and require Places content to be shown on a Google map (which is why the map is Google Maps).

## Cost

Google Maps Platform bills per request, with a free monthly allowance per API. In this app:

- Generating a trip: one Places Text Search per place (typically 40–120 per trip).
- Viewing a trip: one Place Details request per place shown and one Place Photo request per photo
  shown, once per session. Opening a place panel adds a details request with reviews.
- Map: one map load per page view; one Routes request per leg the first time a day is shown in a
  session.

DeepSeek: one outline call plus one call per three days for each generated trip, and one call
per assistant question (roughly 20k input tokens for a long trip; repeated prefixes are cached).

## Using the app

- **Trips menu** (top left) — switch between saved trips, start a new one, add the sample, delete.
- **Itinerary** — all days with times, places, ratings, plan B, budget notes and warnings. Click
  any place for photos, reviews and the days it appears on.
- **Calendar** — one week at a time (one day on phones). Drag across a free time, or use
  **Plan a time**, to ask the assistant for something that fits, with the real travel time.
- **Map** — whole trip (one pin per base, with the legs between them) or one day (numbered stops
  with walking, transit, bus, taxi or flight routes).
- **Assistant** — ask anything, or ask for changes (“move the museum to the morning”, “drop
  lunch on Day 3”). It replies with a **Proposed changes** card; nothing changes until you press
  **Apply changes**.
- **Print** — the full itinerary, all days expanded.
- **Deep links** — `#day-3`, `#calendar`, `#map`, `#place-<id>`.

## Files

```
index.html            page shell: trip page, questionnaire, dialogs
assets/app.css        all styles, including dark mode and print
assets/google.js      Google key, Maps JS loader, Places search/details/photos (session cache)
assets/settings.js    the Keys & settings dialog
assets/trips.js       saved trips in localStorage; picks the active trip
assets/routing.js     Google Routes API: legs, geometry and times (session cache)
assets/app.js         itinerary, calendar, map, place panels, slot selection
assets/assistant.js   DeepSeek chat, slot planner, plan and change cards
assets/generator.js   questionnaire answers → trip (DeepSeek + Google Places)
assets/onboarding.js  start screen, questionnaire, generation progress, Trips menu
skills/itinerary.md   the itinerary-generation skill (replace with your own)
samples/              the Japan in Autumn sample trip
icons/                walk, train, bus, taxi and flight route badges
server.mjs            zero-dependency static server
```

## Trip format

A trip is one JSON object (see `samples/japan-in-autumn.json`):

- `meta` — `title`, `emoji`, `version`, `start`, `end`, `days`, `nights`, `budget`, `budgetNote`,
  `route`, `routeLine`, `timeZone`.
- `profile` — the traveller's answers as text; the assistant reads it.
- `places` — keyed by id: `name`, `kind` (`sight`, `nature`, `food`, `hotel`, `shop`,
  `transport`, `city`), `city` (a city place id), `lat`, `lng`, `placeId` (Google).
- `days` — `d`, `date`, `tz`, `title`, `city`, `stay`, `purpose`, `items`, `planB`, `alts`,
  `spend`, `watch`. Each item has `s`/`e` (start/end), `t` (title), optional `p` (place id),
  `n` (note), `c` (kind), `k` (label such as “Sit-down”), `mode` (how you get there), `allDay`.
- `plan` — markdown summary for the assistant; `chat` — the opening conversation.

Place mentions in markdown use `{{place-id}}`; the page turns them into chips.

## Deploying

The site is plain static files; `server.mjs` is only a local convenience. Upload the folder to
Netlify, Vercel, Cloudflare Pages or GitHub Pages and add the domain to the Google key's
referrer restrictions.

## Credits

- [Google Maps Platform](https://developers.google.com/maps) — map, places, photos and routes
- [DeepSeek](https://platform.deepseek.com/) — itinerary generation and the assistant
