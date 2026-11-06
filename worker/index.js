/* Trip planner backend: serves the static site and the /api routes.
   Keys stay here (Worker secrets); the browser never sees DeepSeek or treg keys.
     POST /api/llm      DeepSeek chat completions, optionally prefixed with the Japan skill
     POST /api/flights  3 flight options (Google Flights via SerpApi on treg), or a booked-flight lookup
     POST /api/hotels   3 hotels for one city (Google Hotels via SerpApi on treg), ranked with the skill
     POST /api/deck     ~10 curated experiences to say yes / maybe / no to
   Every request requires a valid Cloudflare Access login once ACCESS_* is configured. */
import { llm } from "./llm.js";
import { flights } from "./flights.js";
import { hotels } from "./hotels.js";
import { deck } from "./deck.js";
import { accessAllowed } from "./access.js";
import { HttpError, json } from "./util.js";

const ROUTES = { "/api/llm": llm, "/api/flights": flights, "/api/hotels": hotels, "/api/deck": deck };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (!(await accessAllowed(request, env, url))) throw new HttpError(403, "Sign in through Cloudflare Access to use this site.");
      if (url.pathname.startsWith("/api/")) {
        const handler = ROUTES[url.pathname];
        if (!handler) throw new HttpError(404, "Unknown API route.");
        if (request.method !== "POST") throw new HttpError(405, "Use POST.");
        let body;
        try { body = await request.json(); } catch { throw new HttpError(400, "The request body must be JSON."); }
        return await handler(body, env, { request, ctx, url });
      }
      return await page(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: { message: err.message } }, err.status);
      console.error(err);
      return json({ error: { message: "The server hit an unexpected problem." } }, 500);
    }
  },
};

/* The page gets the public, browser-side config. The Google Maps key is used by the
   Maps JavaScript API in the browser, so it is protected by an HTTP-referrer restriction. */
async function page(request, env) {
  // Ask for "/" (the asset server redirects /index.html to /).
  const res = await env.ASSETS.fetch(new Request(new URL("/", request.url), { headers: request.headers }));
  const config = { server: true, googleMapsKey: env.GOOGLE_MAPS_KEY || "", mapId: env.GOOGLE_MAP_ID || "" };
  const tag = `<script>window.APP_CONFIG=${JSON.stringify(config).replace(/</g, "\\u003c")};</script>`;
  return new HTMLRewriter().on("head", { element(el) { el.prepend(tag, { html: true }); } }).transform(res);
}
