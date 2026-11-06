# Travel planner

A trip planner for **Japan** (more countries later). You answer a few questions, it helps you pick
flights and hotels, then an AI builds a day-by-day itinerary from a curated Japan skill, and the same plan shows up in three views — **Itinerary**, **Calendar** and
**Map** — with live photos, ratings and real travel routes. A trip assistant can then propose
changes that you approve before they are applied.

A sample trip (*Japan in Autumn*, 18 days) is included and can be opened from the start screen.

## Start it

You need **Node.js 18 or newer**.

```bash
npm install
npm start          # the site and its backend (Cloudflare Worker) at http://localhost:4173
```

`npm start` runs `wrangler dev`, which serves the static site and the `/api` backend together and
reads the keys from `.dev.vars` (see below). `npm run start:static` still serves the files alone,
but without the backend nothing can be generated.

## Keys

Keys live on the server, never in the browser. Locally they are in **`.dev.vars`** (gitignored and
never published, see `.assetsignore`); in production they are Worker secrets.

| Secret | Used for |
|---|---|
| `DEEPSEEK_API_KEY` | Route, itinerary, hotel ranking and the trip assistant ([platform.deepseek.com](https://platform.deepseek.com/api_keys)) |
| `GOOGLE_MAPS_KEY` | Map, place search, photos, ratings, routes. Sent to the browser (the Maps JavaScript API runs there), so restrict it by HTTP referrer to your domain |
| `TREG_TOKEN`, `TREG_ORG` | Google Flights and Google Hotels data (SerpApi) through [treg](https://treg.to) |

```
DEEPSEEK_API_KEY=sk-…
GOOGLE_MAPS_KEY=AIza…
TREG_TOKEN=…
TREG_ORG=…
```

For the Google key, enable the Maps JavaScript API, Places API (New) and Routes API.

## How a trip is generated

The planner is built around the **Japan country skill** (`skills/japan.md`). The Worker sends its
core rules on every call and adds only the catalog experiences that match the traveller's interests
(tested against the full file: same quality, about 43% fewer tokens).

1. **Questions** — dates, who's going, interests (the skill's categories), pace and crowds, food and
   diet, onsen and tattoos, budget, and what's already booked.
2. **Route** — the skill proposes cities, nights, neighbourhoods and airports; the traveller adjusts.
3. **Flights** — booked: looked up by flight number on Google Flights. Booking them later: the
   traveller says when they land and leave (never assumed). Not booked: 3 options
   (best overall, cheapest, fastest) with real return legs and totals, linked to Google Flights.
   "Compare nearby days" shows the fastest flight and lowest one-way fare for each day up to 3 days
   either side (one quick search per day, ~$0.10 per direction); tapping a day searches again with
   it, and the route gains or loses nights to match. The "Not quite right?" comment can move the
   dates too ("a shorter flight home, I can leave a day later").
4. **Hotels** — priorities (central, near a station, clean, quiet…), beds, a max per room per night
   and a free-text comment, then 3 hotels per stop. Each search keeps hotels within ~2.5 km of the
   stop's neighbourhood (never airport hotels), fetches details for the strongest 6 (every booking
   site's live price, room types with their own photos), drops hotels with no availability, and
   reads the 10 latest Google reviews of the best 4. DeepSeek ranks them with the skill's hotel rules
   and the reviews; each card shows why, a verified guest quote, caveats and the cheapest site.
5. **Itinerary** — outline and days (DeepSeek, built around the fixed flights and hotels). The outline
   picks every lunch and dinner, so days written in parallel never repeat a restaurant. Then a
   **checker** reads the whole plan once: code flags what it can find for certain (a restaurant on
   two days, vague "or a nearby…" places, check-ins away from that night's hotel, food stops that
   mention something the diet rules out) and DeepSeek fixes those and anything else that doesn't hold
   together (timing, closing days, wrong city, "ask for…" diet workarounds). A second short round
   runs only if code still finds problems. Then every place is matched on Google Places. Each item lists **why it is there**: a curated catalog entry
   (solid badge) and/or a source the planner cites, such as Tabelog or Japan-Guide (outlined badge,
   not checked live).
6. **Assistant** — opens with what the plan is and why it looks the way it does, and proposes
   changes you approve.

**Booking sites.** Hotel prices and links come only from trusted booking sites plus the hotel's
own website (default: Booking.com, Expedia, Hotels.com, Agoda, Trip.com, Rakuten Travel, Ikyu,
JAPANiCAN, Relux). Price-comparison sites that redirect elsewhere are left out. Set the
`BOOKING_SITES` secret (comma-separated, names as Google lists them) to change the list.

**Photos.** Only photos from the hotel or booking sites are shown, never guests' uploads. Hotels
also post their social media to Google (portrait or square shots of guests, staff and offers), so
the hotel gallery keeps wide photos only, booking-site photography first. The room tab shows the
room we recommend ("Your room"), from the booking sites' photos of that room type, when there are
at least 3; otherwise it falls back to the hotel's own bedroom photos ("Rooms"). Groups of two or
more are never offered dorm, bunk or capsule beds.

**Map.** A minimal base style is applied in code (no Cloud Map ID needed), with page-drawn markers,
cased route lines per mode, direction arrows and mode badges.

### Data sources (tested 2026-11-06, LHR→Tokyo and Shinjuku/Kyoto hotels)

- **Google Flights via SerpApi (treg)** — chosen. Same fares as `fli` (both read Google Flights) and
  wider airline coverage than Tourmind; works from a Worker. ~$0.09 per search.
- **Google Hotels via SerpApi (treg)** — chosen. Photos, ratings, review aspects (e.g. "Sleep") and
  ~15 booking sites' live prices per hotel with links (Expedia, Booking.com, Agoda, Ikyu, Rakuten…),
  room photos and recent reviews. ~$0.17 per stop.
- Tourmind (similar prices, no public booking link, no guest reviews), LetsFG (no hotel photos,
  markup in price), DataForSEO (no photos) and the Airbnb MCP (homes, scraping) were not used.

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

DeepSeek: one outline call, one call per three days and one or two checker calls for each generated trip, and one call
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
skills/japan.md       the Japan country skill (rules + 300 curated experiences)
skills/itinerary.md   general planning instructions sent with the skill
assets/api.js         calls to the site's backend; which parts of the skill a traveller needs
assets/booking.js     route, flights and hotels between the questions and the itinerary
worker/               Cloudflare Worker: /api/llm, /api/flights, /api/hotels, Access check
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

## Deploying (Cloudflare)

```bash
npx wrangler login
npx wrangler secret put DEEPSEEK_API_KEY     # and GOOGLE_MAPS_KEY, TREG_TOKEN, TREG_ORG
npm run deploy
```

Then protect it with **Cloudflare Access** (Zero Trust → Access → Applications → Self-hosted) on the
custom domain and the `workers.dev` URL, allowing only your emails. Put the team domain
(`yourteam.cloudflareaccess.com`) and the application's AUD tag in `wrangler.jsonc`
(`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and deploy again: the Worker then verifies the Access token on
every request. Without them it only answers on localhost, so a deploy can't expose the keys.

## Credits

- [Google Maps Platform](https://developers.google.com/maps) — map, places, photos and routes
- [DeepSeek](https://platform.deepseek.com/) — itinerary generation and the assistant
