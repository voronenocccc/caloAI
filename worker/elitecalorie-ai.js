import { FOOD_DB } from "../assets/food-db.js";

const MODEL = "gemini-2.5-flash";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" }
  });
}

function modelText(data) {
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "";
}

function parseJson(text) {
  const normalized = String(text || "").replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(normalized);
}

function foodSearch(query) {
  const normalized = String(query || "").trim().toLowerCase().replace(/ё/g, "е");
  if (!normalized) return [];
  return FOOD_DB.filter((food) => `${food.name} ${food.brand} ${food.country}`.toLowerCase().replace(/ё/g, "е").includes(normalized)).slice(0, 45);
}

async function callGemini(env, contents, schema) {
  if (!env.GEMINI_API_KEY) throw new Error("AI_NOT_CONFIGURED");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: schema
      }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = JSON.stringify(data);
    const quota = response.status === 402 || response.status === 429 || /quota|resource exhausted|billing|rate limit/i.test(message);
    const error = new Error(quota ? "FREE_QUOTA_EXHAUSTED" : "AI_PROVIDER_ERROR");
    error.status = quota ? 429 : 502;
    throw error;
  }
  return parseJson(modelText(data));
}

async function analyzePhoto(request, env) {
  const form = await request.formData();
  const image = form.get("image");
  const note = String(form.get("note") || "").slice(0, 500);
  if (!(image instanceof File) || !image.type.startsWith("image/")) return json({ error: "IMAGE_REQUIRED" }, 400);
  if (image.size > MAX_IMAGE_BYTES) return json({ error: "IMAGE_TOO_LARGE", message: "Фото должно быть меньше 6 МБ" }, 413);
  const bytes = new Uint8Array(await image.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const prompt = `Определи еду на фото для дневника калорий. ${note ? `Уточнение пользователя: ${note}` : "Вес оцени приблизительно по порции."} Верни только JSON. Если фото не про еду, верни пустой items.`;
  try {
    const result = await callGemini(env, [{ role: "user", parts: [
      { text: prompt },
      { inlineData: { mimeType: image.type, data: btoa(binary) } }
    ] }], {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: {
        name: { type: "string" }, grams: { type: "number" }, kcal: { type: "number" },
        protein_g: { type: "number" }, fat_g: { type: "number" }, carbs_g: { type: "number" }
      }, required: ["name", "grams", "kcal", "protein_g", "fat_g", "carbs_g"] } } },
      required: ["items"]
    });
    return json(result);
  } catch (error) {
    return json({ error: error.message === "FREE_QUOTA_EXHAUSTED" ? error.message : "AI_UNAVAILABLE" }, error.status || 502);
  }
}

async function coach(request, env) {
  const payload = await request.json().catch(() => ({}));
  const question = String(payload.question || "").trim().slice(0, 600);
  if (!question) return json({ error: "QUESTION_REQUIRED" }, 400);
  const context = payload.context && typeof payload.context === "object" ? payload.context : {};
  const safeContext = {
    profile: context.profile || {},
    date: String(context.date || "").slice(0, 10),
    entries: Array.isArray(context.entries) ? context.entries.slice(0, 50) : []
  };
  try {
    const result = await callGemini(env, [{ role: "user", parts: [{ text: `Ты доброжелательный тренер по питанию. Отвечай по-русски кратко, без медицинских диагнозов и категоричных обещаний. Вопрос: ${question}\nКонтекст дневника (не идентифицирует пользователя): ${JSON.stringify(safeContext)}` }] }], {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"]
    });
    return json({ answer: String(result.answer || "").slice(0, 2500) });
  } catch (error) {
    return json({ error: error.message === "FREE_QUOTA_EXHAUSTED" ? error.message : "AI_UNAVAILABLE" }, error.status || 502);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return json({ ok: true, provider: "gemini", model: MODEL, paidFallback: false });
    if (request.method === "GET" && url.pathname === "/food") return json({ products: foodSearch(url.searchParams.get("q")), fallback: true });
    if (request.method === "POST" && url.pathname === "/coach") return coach(request, env);
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/analyze")) return analyzePhoto(request, env);
    return json({ ok: true, service: "EliteCalorie AI", routes: { status: "/status", coach: "POST /coach", photo: "POST /" } });
  }
};
