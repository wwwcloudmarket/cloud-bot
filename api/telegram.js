import { Telegraf, Markup } from "telegraf";
import { sb } from "../lib/db.js";

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: true },
});

// ===== Helpers =====
function mainMenu() {
  return Markup.keyboard([["👤 Мой профиль", "🎯 Рафлы"], ["⚙️ Настройки"]]).resize();
}
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id || ""));
}
function html(s) {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}
function parseDateToISO(s) {
  // ожидает "YYYY-MM-DD HH:mm" -> трактуем как UTC
  // пример: "2025-11-05 18:00" => "2025-11-05T18:00:00.000Z"
  const t = s.trim().replace(" ", "T") + ":00.000Z";
  return new Date(t).toISOString();
}

async function saveUser(ctx) {
  const u = ctx.from;
  if (!u) return;
  await sb.from("users").upsert({
    tg_user_id: u.id,
    username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    lang_code: u.language_code || null,
  });
}

// ===== Public commands =====
bot.start(async (ctx) => {
  await saveUser(ctx);
  await ctx.reply("Добро пожаловать в Cloud Market 🎯\nВыбери пункт меню ниже:", mainMenu());
});

bot.hears("👤 Мой профиль", async (ctx) => {
  await saveUser(ctx);
  const id = ctx.from.id;

  const { data: user } = await sb.from("users").select("*").eq("tg_user_id", id).single();

  const { data: wins } = await sb
    .from("winners")
    .select("raffle_id, decided_at")
    .eq("tg_user_id", id)
    .order("decided_at", { ascending: false });

  const text = [
    `<b>👤 Профиль</b>`,
    `ID: <code>${user.tg_user_id}</code>`,
    `Имя: ${html(user.first_name || "—")}`,
    `Username: @${user.username || "—"}`,
    ``,
    `<b>🏆 Победы:</b>`,
    wins?.length
      ? wins
          .map(
            (e, i) =>
              `${i + 1}. ${e.raffle_id.slice(0, 8)}... — ${new Date(e.decided_at).toLocaleString()}`
          )
          .join("\n")
      : "Пока нет побед 😔",
  ].join("\n");

  return ctx.reply(text, { parse_mode: "HTML", ...mainMenu() });
});

bot.hears("🎯 Рафлы", async (ctx) => {
  const { data: raffles } = await sb
    .from("raffles")
    .select("*")
    .eq("is_finished", false)
    .order("starts_at", { ascending: true });

  if (!raffles || raffles.length === 0) {
    return ctx.reply("❌ Сейчас нет активных дропов.", mainMenu());
  }

  for (const r of raffles) {
    const text = `🎯 <b>${html(r.title)}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${r.winners_count}`;
    const button = Markup.inlineKeyboard([[Markup.button.callback("🪩 Участвовать", `join_${r.id}`)]]);
    if (r.image_url) {
      await ctx.replyWithPhoto(r.image_url, { caption: text, parse_mode: "HTML", ...button });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...button });
    }
  }
});

bot.hears("⚙️ Настройки", async (ctx) => {
  return ctx.reply("Настройки пока простые:\n— язык: auto\n— уведомления: включены 🔔", mainMenu());
});

// ===== Join (multi-winner + notifications) =====
bot.action(/join_(.+)/, async (ctx) => {
  const raffleId = ctx.match[1];
  const user = ctx.from;

  try {
    const { data: raffle } = await sb.from("raffles").select("*").eq("id", raffleId).single();
    if (!raffle) return ctx.answerCbQuery("Раффл не найден 😔");

    if (raffle.is_finished) {
      await ctx.answerCbQuery("❌ Дроп завершён!");
      return ctx.reply("❌ Дроп уже закрыт!");
    }

    // сколько уже победителей
    const { data: existing } = await sb.from("winners").select("id").eq("raffle_id", raffleId);
    const count = existing?.length || 0;
    if (count >= raffle.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
      return ctx.answerCbQuery("Все победители уже выбраны 😅");
    }

    // уже участвовал?
    const { data: prev } = await sb
      .from("entries")
      .select("id")
      .eq("raffle_id", raffleId)
      .eq("tg_user_id", user.id)
      .maybeSingle();
    if (prev) return ctx.answerCbQuery("Ты уже участвуешь 😎");

    // записываем участие
    await sb.from("entries").insert({
      raffle_id: raffleId,
      tg_user_id: user.id,
      tg_username: user.username || null,
    });

    // записываем победителя
    await sb.from("winners").insert({ raffle_id: raffleId, tg_user_id: user.id });

    await ctx.answerCbQuery("🎉 Ты выиграл!");
    await ctx.reply(
      `🏆 Поздравляем, ${html(user.first_name || "участник")}!\nТы стал победителем дропа <b>${html(
        raffle.title
      )}</b> 🎯`,
      { parse_mode: "HTML" }
    );

    // проверить, закрыт ли дроп после этого
    const { data: allWinners } = await sb.from("winners").select("tg_user_id").eq("raffle_id", raffleId);
    if ((allWinners?.length || 0) >= raffle.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);

      // уведомления
      // 1) победителям (лично)
      for (const w of allWinners) {
        try {
          await bot.telegram.sendMessage(
            w.tg_user_id,
            `🏆 Ты в числе победителей дропа <b>${html(raffle.title)}</b>!`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }

      // 2) участникам-непобедителям (лично)
      const { data: allEntries } = await sb
        .from("entries")
        .select("tg_user_id")
        .eq("raffle_id", raffleId);
      const winnerIds = new Set(allWinners.map((w) => String(w.tg_user_id)));
      for (const e of allEntries || []) {
        const uid = String(e.tg_user_id);
        if (!winnerIds.has(uid)) {
          try {
            await bot.telegram.sendMessage(
              e.tg_user_id,
              `😔 В этот раз дроп <b>${html(raffle.title)}</b> уже закрыт. Удача будет на твоей стороне в следующем!`,
              { parse_mode: "HTML" }
            );
          } catch {}
        }
      }

      // 3) сообщение в общий чат (если задан)
      if (process.env.CHAT_ID) {
        await bot.telegram.sendMessage(
          process.env.CHAT_ID,
          `🎯 Дроп <b>${html(raffle.title)}</b> завершён!\nПобедителей: ${raffle.winners_count}`,
          { parse_mode: "HTML" }
        );
      }
    }
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("Ошибка 😔");
  }
});

// ===== Admin panel =====
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text =
    "👑 <b>Админ-меню</b>\n\n" +
    "• Создать дроп:\n" +
    "<code>/adddrop Название | 2025-11-05 18:00 | 2 | https://.../image.jpg</code>\n" +
    "image_url — опционально\n\n" +
    "• Завершить дроп вручную:\n" +
    "<code>/finish &lt;raffle_uuid&gt;</code>";
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.command("adddrop", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const raw = ctx.message.text.replace(/^\/adddrop\s*/i, "");
  const parts = raw.split("|").map((s) => s.trim());
  if (parts.length < 3) {
    return ctx.reply(
      "Формат:\n/adddrop Название | 2025-11-05 18:00 | 2 | https://.../image.jpg (опционально)"
    );
  }
  const [title, starts, winnersCountStr, imageUrl] = parts;
  const winners_count = parseInt(winnersCountStr, 10) || 1;

  try {
    const starts_at = parseDateToISO(starts);
    const insert = {
      title,
      starts_at,
      winners_count,
      created_by: ctx.from.id,
      status: "scheduled",
      is_finished: false,
    };
    if (imageUrl) insert.image_url = imageUrl;

    const { data, error } = await sb.from("raffles").insert(insert).select("id").single();
    if (error) throw error;

    await ctx.reply(
      `✅ Дроп создан:\n<b>${html(title)}</b>\nСтарт: ${starts}\nПобедителей: ${winners_count}\nID: <code>${data.id}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply("Ошибка при создании дропа. Проверь формат и время.");
  }
});

bot.command("finish", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = (ctx.message.text.split(" ").slice(1).join(" ") || "").trim();
  if (!id) return ctx.reply("Укажи ID: /finish <raffle_uuid>");
  try {
    await sb.from("raffles").update({ is_finished: true }).eq("id", id);
    await ctx.reply(`✅ Дроп ${id} помечен завершённым`);
  } catch (e) {
    console.error(e);
    await ctx.reply("Не удалось завершить дроп");
  }
});

// ===== Vercel webhook handler =====
export default async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
    await bot.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (e) {
    console.error("Bot error:", e);
    return res.status(200).json({ ok: true });
  }
}
