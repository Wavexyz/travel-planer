/* Cloudflare Access: verify the signed JWT Access adds to every request
   (Cf-Access-Jwt-Assertion) against the team's public keys. Without ACCESS_*
   configured, only local development (localhost) is allowed, so a deploy that
   forgot Access never exposes the keys. */
let certs = null, certsAt = 0;

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));

async function keys(team) {
  if (certs && Date.now() - certsAt < 3600e3) return certs;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Could not load Access certificates");
  certs = (await res.json()).keys || [];
  certsAt = Date.now();
  return certs;
}

export async function accessAllowed(request, env, url) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) return ["localhost", "127.0.0.1"].includes(url.hostname);
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    const jwk = (await keys(team)).find(k => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return ok && auds.includes(aud) && payload.iss === `https://${team}` && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
