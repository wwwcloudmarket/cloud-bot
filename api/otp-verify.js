// api/otp-verify.js
import { sb } from "../lib/db.js";
import crypto from "node:crypto";

// === CORS для iOS / веба ===
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// === Подпись сессии ===
function signSession(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.WEB_JWT_SECRET)
    .update(json)
    .digest("base64url");
  return `${json}.${sig}`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { phone, code } = body;

    if (!phone || !code)
      return res.status(400).json({ ok: false, error: "missing_fields" });

    const phoneLower = phone.toLowerCase();

    // Проверяем код
    const { data: otp } = await sb
      .from("otp_codes")
      .select("*")
      .eq("phone", phoneLower)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otp) return res.json({ ok: false, error: "code_not_found" });
    if (otp.code_hash !== hashCode(code))
      return res.json({ ok: false, error: "wrong_code" });

    // Проверяем срок действия
    if (new Date(otp.expires_at) < new Date()) {
      return res.json({ ok: false, error: "code_expired" });
    }

    // Получаем пользователя
    const { data: user } = await sb
      .from("users")
      .select("tg_user_id, first_name, username, phone")
      .eq("phone", phoneLower)
      .maybeSingle();

    if (!user) return res.json({ ok: false, error: "user_not_found" });

    // Подписываем сессию
    const appToken = signSession({ uid: user.tg_user_id, u: user.username });

    return res.json({ ok: true, app_token: appToken, user });
  } catch (e) {
    console.error("otp-verify error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
