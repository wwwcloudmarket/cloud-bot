import { sb } from "../lib/db.js";
import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  try {
    // 1️⃣ Проверка секрета
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Invalid secret" });
    }

    // 2️⃣ Вычисляем московское время
    const now = new Date();
    const offsetMinutes = now.getTimezoneOffset(); // в минутах (для Москвы -180)
    const nowLocal = new Date(now.getTime() - offsetMinutes * 60 * 1000).toISOString();
    console.log("⏰ Local time:", nowLocal);

    // 3️⃣ Ищем новые дропы
    const { data: raffles, error } = await sb
      .from("raffles")
      .select("*")
      .eq("status", "scheduled")
      .lte("starts_at", nowLocal);

    if (error) throw error;
    if (!raffles?.length) {
      console.log("⏰ Нет новых дропов");
      return res.json({ ok: true, message: "Нет новых дропов" });
    }

    console.log(`🎁 Найдено ${raffles.length} новых дропов`);

    // 4️⃣ Получаем всех активных пользователей
    const { data: users, error: usersError } = await sb
      .from("users")
      .select("tg_user_id")
      .is("is_active", true) // либо активные по умолчанию
      .not("tg_user_id", "is", null);

    if (usersError) throw usersError;
    if (!users?.length) {
      console.log("⚠️ Нет пользователей для рассылки");
      return res.json({ ok: false, error: "No users" });
    }

    console.log(`👥 Пользователей для рассылки: ${users.length}`);

    // 5️⃣ Перебираем каждый раффл
    for (const raffle of raffles) {
      const caption = `🎯 <b>${raffle.title}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${raffle.winners_count}`;

      // 6️⃣ Отправляем каждому пользователю
      for (const user of users) {
        try {
          if (raffle.image_url) {
            await bot.telegram.sendPhoto(user.tg_user_id, raffle.image_url, {
              caption,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🪩 Участвовать", callback_data: `join_${raffle.id}` }],
                ],
              },
            });
          } else {
            await bot.telegram.sendMessage(user.tg_user_id, caption, {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🪩 Участвовать", callback_data: `join_${raffle.id}` }],
                ],
              },
            });
          }

          console.log(`📨 Отправлено пользователю ${user.tg_user_id}`);
        } catch (e) {
          console.error(`❌ Ошибка при отправке пользователю ${user.tg_user_id}:`, e.message);

          // если пользователь заблокировал бота — помечаем его неактивным
          if (e.message.includes("bot was blocked") || e.message.includes("user is deactivated")) {
            await sb
              .from("users")
              .update({ is_active: false })
              .eq("tg_user_id", user.tg_user_id);
          }
        }

        // 🔹 защита от flood limit Telegram
        await new Promise((r) => setTimeout(r, 200));
      }

      // 7️⃣ Обновляем статус раффла
      await sb.from("raffles").update({ status: "active" }).eq("id", raffle.id);
      console.log(`✅ Рафл "${raffle.title}" теперь активен`);
    }

    return res.json({
      ok: true,
      sent_raffles: raffles.length,
      sent_users: users.length,
    });
  } catch (e) {
    console.error("Scheduler error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
