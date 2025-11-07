// api/web-products.js
import { sb } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    const { data, error } = await sb
      .from("products")
      .select("id, title, price, image_url, description")
      .eq("is_available", true)
      .order("title");

    if (error) throw error;

    return res.status(200).json(data);
  } catch (e) {
    console.error("web-products error:", e);
    return res.status(500).json({ ok: false });
  }
}
