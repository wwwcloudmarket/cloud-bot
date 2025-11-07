import { sb } from "../lib/db.js";

// Временное хранилище кодов (можно заменить на таблицу phone_codes)
const CODE_TABLE = "phone_codes"; // создается в Supabase с колонками: phone (text), code (text)

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { phone, code } = body;

    if (!phone || !code) {
      return res.status(400).json({ ok: false, error: "missing phone or code" });
    }

    // 1️⃣ Находим код в Supabase
    const { data, error } = await sb
      .from(CODE_TABLE)
      .select("*")
      .eq("phone", phone)
      .single();

    if (error || !data) {
      return res.status(400).json({ ok: false, error: "code not found" });
    }

    // 2️⃣ Сравниваем коды
    if (String(data.code).trim() !== String(code).trim()) {
      return res.status(400).json({ ok: false, error: "invalid code" });
    }

    // 3️⃣ Удаляем использованный код
    await sb.from(CODE_TABLE).delete().eq("phone", phone);

    // 4️⃣ Регистрируем / находим пользователя
    const { data: user } = await sb
      .from("users")
      .select("*")
      .eq("phone", phone)
      .maybeSingle();

    if (user) {
      return res.json({ ok: true, user });
    }

    const { data: newUser } = await sb
      .from("users")
      .insert({ phone })
      .select("*")
      .single();

    return res.json({ ok: true, user: newUser });
  } catch (e) {
    console.error("verify-code error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
