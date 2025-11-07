// api/otp-verify.js
import { sb } from "../lib/db.js";
import crypto from "node:crypto";
import { normalizePhone, hashCode } from "../lib/util.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

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
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const phone = normalizePhone(body?.phone || "");
    const code = String(body?.code || "").trim();
    if (!phone || !code) return res.status(400).json({ ok: false, error: "missing_fields" });

    // берём ПОСЛЕДНИЙ код по номеру
    const { data: otp, error: otpErr } = await sb
      .from("otp_codes")
      .select("code_hash, expires_at, created_at")
      .eq("phone", phone.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otpErr) throw otpErr;
    if (!otp) return res.json({ ok: false, error: "code_not_found" });

    // сверяем по хэшу
    if (otp.code_hash !== hashCode(code)) {
      return res.json({ ok: false, error: "wrong_code" });
    }

    // проверяем срок действия
    if (new Date(otp.expires_at) < new Date()) {
      return res.json({ ok: false, error: "code_expired" });
    }

    // находим пользователя по телефону
    const { data: user } = await sb
      .from("users")
      .select("tg_user_id, first_name, username, phone, photo_url")
      .eq("phone", phone)
      .maybeSingle();

    if (!user?.tg_user_id) {
      return res.json({ ok: false, error: "user_not_found" });
    }

    // подписываем токен для приложения (можно класть в Keychain)
    const appToken = signSession({ uid: user.tg_user_id, u: user.username || null });

    // по желанию: одноразовый код можно удалить
    await sb.from("otp_codes").delete().eq("phone", phone.toLowerCase());

    return res.json({ ok: true, app_token: appToken, user });
  } catch (e) {
    console.error("otp-verify error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
