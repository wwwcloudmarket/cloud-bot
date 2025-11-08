import { sb } from "../lib/db.js";

export default async function handler(req, res) {
  const { raffleId, tg_user_id } = req.body;

  const { data: existing } = await sb
    .from("entries")
    .select("*")
    .eq("raffle_id", raffleId)
    .eq("tg_user_id", tg_user_id);

  if (existing && existing.length > 0) {
    return res.json({ ok: true, result: "already" });
  }

  const { data: others } = await sb
    .from("entries")
    .select("id")
    .eq("raffle_id", raffleId);

  const isWinner = others.length === 0;

  await sb.from("entries").insert({
    raffle_id: raffleId,
    tg_user_id,
    result: isWinner ? "win" : "lose"
  });

  return res.json({ ok: true, result: isWinner ? "win" : "lose" });
}
