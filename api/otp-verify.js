// api/otp-verify.js
import { sb } from "../lib/db.js";
import crypto from "node:crypto";

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D+/g, "");
  if (digits.startsWith("8") && digits.length === 11) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  if (!digits.startsWith("7")) digits = "7" + digits;
  return "+" + digits;
}

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const phoneRaw = (body?.phone || "").trim();
    const code = (body?.code || "").trim();
    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm || !code) return res.status(400).json({ ok: false, error: "invalid payload" });

    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    // 1️⃣ Находим последний активный код
    const { data: rows, error: selErr } = await sb
      .from("otp_codes")
      .select("id, code_hash, expires_at, used")
      .eq("phone", phoneNorm)
      .eq("used", false)
      .order("expires_at", { ascending: false })
      .limit(1);

    if (selErr) {
      console.error("otp-verify select error:", selErr);
      return res.status(500).json({ ok: false, error: "db error" });
    }

    const row = rows?.[0];
    if (!row) return res.status(400).json({ ok: false, error: "code not found" });

    // 2️⃣ Проверяем срок и совпадение
    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ ok: false, error: "code expired" });
    }

    if (row.code_hash !== codeHash) {
      return res.status(400).json({ ok: false, error: "wrong code" });
    }

    // ✅ помечаем как использованный
await sb.from("otp_codes")
  .update({ used: true })
  .eq("id", row.id);

// 🧹 полностью удаляем код после отметки
await sb.from("otp_codes")
  .delete()
  .eq("id", row.id);

    // 4️⃣ Возвращаем профиль
    const { data: users } = await sb
      .from("users")
      .select("tg_user_id, first_name, last_name, username, phone, photo_url")
      .eq("phone", phoneNorm)
      .limit(1);

    const user = users?.[0] ?? null;
    return res.json({ ok: true, app_token: null, user });
  } catch (e) {
    console.error("otp-verify error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
