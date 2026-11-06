/* DeepSeek proxy. The browser sends a chat-completions body without a key; the
   Worker adds the key, caps the request, and (with `skill`) puts the Japan skill
   in front of the messages as the first system message. Streams pass through. */
import { skillText } from "./skill.js";
import { HttpError, json } from "./util.js";

const API = "https://api.deepseek.com/chat/completions";
const MODELS = ["deepseek-flash", "deepseek-v4-pro"];
const MAX_TOKENS = 16000;

export async function deepseek(env, body, signal) {
  if (!env.DEEPSEEK_API_KEY) throw new HttpError(503, "The DeepSeek key is not configured on the server.");
  return fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.DEEPSEEK_API_KEY },
    body: JSON.stringify(body), signal,
  });
}

/* Server-side JSON call used by other routes (e.g. hotel ranking). */
export async function deepseekJSON(env, system, user, { maxTokens = 4000 } = {}) {
  const res = await deepseek(env, {
    model: "deepseek-flash", thinking: { type: "disabled" }, temperature: 0.4, max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  if (!res.ok) throw new HttpError(502, "DeepSeek returned HTTP " + res.status);
  const j = await res.json();
  return JSON.parse(j.choices?.[0]?.message?.content || "{}");
}

export async function llm(body, env, { request, url }) {
  const messages = Array.isArray(body.messages) ? body.messages.filter(m => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string") : [];
  if (!messages.length) throw new HttpError(400, "No messages.");
  const model = MODELS.includes(body.model) ? body.model : "deepseek-flash";
  const out = {
    model, messages, stream: !!body.stream,
    max_tokens: Math.min(MAX_TOKENS, Math.max(256, +body.max_tokens || 4000)),
  };
  if (model !== "deepseek-v4-pro") { out.thinking = { type: "disabled" }; out.temperature = Math.min(1.2, Math.max(0, +body.temperature || 0.6)); }
  if (body.response_format?.type === "json_object") out.response_format = { type: "json_object" };
  if (body.skill) out.messages = [{ role: "system", content: await skillText(env, url.origin, body.skill) }, ...messages];

  const res = await deepseek(env, out, request.signal);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch {}
    return json({ error: { message: detail || "DeepSeek returned HTTP " + res.status } }, res.status === 401 ? 502 : res.status);
  }
  if (out.stream) return new Response(res.body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" } });
  return json(await res.json());
}
