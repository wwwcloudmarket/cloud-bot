// api/telegram.js
import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import { sb } from "../lib/db.js";

/** ===================== Bot init ===================== */
const BOT = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: true },
});

/** ===================== UI / helpers ===================== */
const ITEMS_BTN = "🧾 Мои вещи";
const ADD_PROMPT = "Введите 10-значный код с бирки/карточки вещи:";

// Ручные промпты (админ)
const PROMPT_MINT_ONE   = "Введите данные для одной вещи в формате: SKU SIZE SERIAL";
const PROMPT_MINT_BATCH = "Введите данные для партии в формате: SKU SIZE RANGE (например 1..10 или 1,2,5)";

// Product picker (по выбранному товару)
const PROMPT_SIZE_SERIAL_FOR = "Укажите SIZE и SERIAL для выбранного товара (формат: SIZE SERIAL)\nТовар:";
const PROMPT_SIZE_RANGE_FOR  = "Укажите SIZE и RANGE для выбранного товара (формат: SIZE RANGE)\nТовар:";

// Автопартия (по товару) — план внутри продукта или вводом
const PROMPT_AUTO_PLAN_FOR   = "Укажите план партии в формате SIZE:COUNT через запятую (например: S:10,M:8,L:5)\nТовар:";

const PAGE_SIZE = 8; // листинг товаров, на страницу

function mainMenu() {
  return Markup.keyboard([
    ["👤 Мой профиль", "🎯 Рафлы"],
    [ITEMS_BTN, "⚙️ Настройки"],
  ]).resize();
}
function phoneKeyboard() {
  return Markup.keyboard([[{ text: "📱 Поделиться номером", request_contact: true }]])
    .oneTime()
    .resize();
}
function maskPhone(p) {
  if (!p) return "—";
  const digits = p.replace(/[^\d+]/g, "");
  if (digits.length < 6) return digits;
  return digits.slice(0, 3) + " " + digits.slice(3, 6) + " *** ** " + digits.slice(-2);
}
function html(s) {
  return s?.replace?.(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) ?? s;
}
function parseDateToISO(s) {
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

/** ===================== Codes (Luhn) ===================== */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function genCode10() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = base[8 - i];
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return base.join("") + String(check);
}
function luhnOk(code) {
  if (!/^\d{10}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return ((sum + check) % 10) === 0;
}

/** ===================== Products & roles ===================== */
function productLabel(p) {
  return (p.title || p.name || p.sku || p.id);
}
async function findProductId(skuOrId) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(skuOrId);
  if (isUuid) return skuOrId;

  // sku -> title -> name
  let q = await sb.from("products").select("id").eq("sku", skuOrId).maybeSingle();
  if (q.data?.id) return q.data.id;

  q = await sb.from("products").select("id").eq("title", skuOrId).maybeSingle();
  if (q.data?.id) return q.data.id;

  q = await sb.from("products").select("id").eq("name", skuOrId).maybeSingle();
  if (q.data?.id) return q.data.id;

  throw new Error("Товар не найден: " + skuOrId);
}

const roleCache = new Map();
async function getRole(tgId) {
  if (roleCache.has(tgId)) return roleCache.get(tgId);
  const { data } = await sb.from("user_roles").select("role").eq("tg_user_id", tgId).maybeSingle();
  const role = data?.role || null;
  roleCache.set(tgId, role);
  return role;
}
async function hasRole(ctx, roles = ["admin"]) {
  const role = await getRole(ctx.from.id);
  return !!role && roles.includes(role);
}
async function requireRole(ctx, roles = ["admin"]) {
  const ok = await hasRole(ctx, roles);
  if (!ok) {
    await ctx.reply("Доступ только для админов.");
    return false;
  }
  return true;
}

/** ===================== Diagnostics ===================== */
BOT.command("ping", (ctx) => ctx.reply("pong"));
BOT.command("id",   (ctx) => ctx.reply(`Ваш ID: ${ctx.from.id}`));
BOT.command("findp", async (ctx) => {
  const sku = (ctx.message.text.split(/\s+/)[1] || "").trim();
  if (!sku) return ctx.reply("Использование: /findp <SKU|product_id>");
  try {
    const id = await findProductId(sku);
    return ctx.reply(`product_id: <code>${id}</code>`, { parse_mode: "HTML" });
  } catch (e) {
    return ctx.reply("Не найдено: " + (e?.message || "ошибка"));
  }
});

/** ===================== Product picker helpers ===================== */
function truncate(s, n = 40) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
async function renderProductPage(ctx, page = 0, mode = "one") {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data: rows, error } = await sb
    .from("products")
    .select("*")
    .range(from, to);

  if (error) {
    console.error(error);
    return ctx.reply("Ошибка загрузки товаров: " + (error.message || "unknown"));
  }
  if (!rows || rows.length === 0) {
    if (page === 0) return ctx.reply("Список товаров пуст.");
    return ctx.answerCbQuery("Это последняя страница");
  }

  const rowsKb = rows.map(p => {
    const label = truncate((productLabel(p) || "").toString());
    const cb = mode === "one"
      ? `PP_ONE_SEL_${p.id}`
      : mode === "batch"
        ? `PP_BATCH_SEL_${p.id}`
        : `PP_AUTO_SEL_${p.id}`;
    return [Markup.button.callback(label, cb)];
  });

  const nav = [];
  if (page > 0) {
    nav.push(Markup.button.callback("⬅️ Назад",
      mode === "one"   ? `PP_ONE_PAGE_${page - 1}` :
      mode === "batch" ? `PP_BATCH_PAGE_${page - 1}` :
                         `PP_AUTO_PAGE_${page - 1}`));
  }
  if (rows.length === PAGE_SIZE) {
    nav.push(Markup.button.callback("Вперёд ➡️",
      mode === "one"   ? `PP_ONE_PAGE_${page + 1}` :
      mode === "batch" ? `PP_BATCH_PAGE_${page + 1}` :
                         `PP_AUTO_PAGE_${page + 1}`));
  }
  if (nav.length) rowsKb.push(nav);

  await ctx.reply(
    mode === "one"
      ? "Выберите товар для создания кода:"
      : mode === "batch"
      ? "Выберите товар для партии кодов:"
      : "Выберите товар для авто-партии:",
    { reply_markup: Markup.inlineKeyboard(rowsKb).reply_markup }
  );
}

/** ===================== Public ===================== */
BOT.start(async (ctx) => {
  await saveUser(ctx);

  const { data: user } = await sb
    .from("users")
    .select("phone")
    .eq("tg_user_id", ctx.from.id)
    .single();

  if (!user?.phone) {
    const km = phoneKeyboard();
    await ctx.reply("Для подтверждения аккаунта поделись номером телефона (кнопка ниже) 👇", {
      reply_markup: km.reply_markup,
    });
  } else {
    const mm = mainMenu();
    await ctx.reply("Добро пожаловать в Cloud Market 🎯\nВыбери пункт меню ниже:", {
      reply_markup: mm.reply_markup,
    });
  }
});

BOT.on("contact", async (ctx) => {
  try {
    const contact = ctx.message?.contact;
    if (!contact || String(contact.user_id) !== String(ctx.from.id)) {
      const km = phoneKeyboard();
      return ctx.reply("Можно поделиться только своим номером 😊", { reply_markup: km.reply_markup });
    }
    const phone = contact.phone_number.startsWith("+")
      ? contact.phone_number
      : "+" + contact.phone_number;

    await sb.from("users").update({ phone }).eq("tg_user_id", ctx.from.id);
    const mm = mainMenu();
    await ctx.reply("Спасибо! Телефон сохранён ✅", { reply_markup: mm.reply_markup });
  } catch (e) {
    console.error(e);
    const km = phoneKeyboard();
    await ctx.reply("Не удалось сохранить номер. Попробуй ещё раз.", { reply_markup: km.reply_markup });
  }
});

BOT.hears("👤 Мой профиль", async (ctx) => {
  await saveUser(ctx);
  const id = ctx.from.id;

  const { data: user } = await sb
    .from("users")
    .select("tg_user_id, first_name, username, phone")
    .eq("tg_user_id", id)
    .single();

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
    `Телефон: ${maskPhone(user.phone)}`,
    ``,
    `<b>🏆 Победы:</b>`,
    wins?.length
      ? wins.map((e, i) => `${i + 1}. ${e.raffle_id.slice(0, 8)}... — ${new Date(e.decided_at).toLocaleString()}`).join("\n")
      : "Пока нет побед 😔",
  ].join("\n");

  const mm = mainMenu();
  if (!user?.phone) {
    const km = phoneKeyboard();
    await ctx.reply("Добавь телефон, чтобы мы могли связаться, если ты победишь:", { reply_markup: km.reply_markup });
  }
  return ctx.reply(text, { parse_mode: "HTML", reply_markup: mm.reply_markup });
});

BOT.hears(ITEMS_BTN, async (ctx) => {
  try {
    const { data: rows } = await sb
      .from("item_instances")
      .select("id,size,serial,claimed_at,products(title,sku,image_url)")
      .eq("claimed_by_tg_id", ctx.from.id)
      .order("claimed_at", { ascending: false })
      .limit(20);

    const list = (rows?.length)
      ? rows.map(r => {
          const p = r.products || {};
          const name = p.title || p.sku || "Product";
          const when = r.claimed_at ? new Date(r.claimed_at).toLocaleDateString() : "";
          return `• ${name} ${r.size || ""} #${r.serial ?? ""} — ${when}`;
        }).join("\n")
      : "Пока пусто.";

    const kb = Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить вещь", "ADD_ITEM")]]);
    await ctx.reply(`<b>🧾 Мои вещи</b>\n\n${list}\n\nНажми «Добавить вещь», если у тебя есть код.`, {
      parse_mode: "HTML",
      reply_markup: kb.reply_markup,
    });
  } catch (e) {
    console.error(e);
    const mm = mainMenu();
    return ctx.reply("Не удалось загрузить список вещей 😔", { reply_markup: mm.reply_markup });
  }
});

BOT.action("ADD_ITEM", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(ADD_PROMPT, {
    reply_markup: { force_reply: true, input_field_placeholder: "Например: 1234567890" },
  });
});

/** ===== Force-reply промпты (ВАЖНО: next() чтобы /admin не «молчал») ===== */
BOT.on("text", async (ctx, next) => {
  const prompt = ctx.message?.reply_to_message?.text || "";
  if (!prompt) return next();

  // Пользователь: ввод кода
  if (prompt.startsWith(ADD_PROMPT)) {
    const raw = (ctx.message.text || "").replace(/\D/g, "");
    if (raw.length !== 10) return ctx.reply("Код должен состоять из 10 цифр. Нажмите «➕ Добавить вещь» и попробуйте ещё раз.");
    if (!luhnOk(raw)) return ctx.reply("Похоже, код введён с ошибкой (контрольная цифра не сходится). Проверьте и попробуйте снова.");

    try {
      const hash = sha256(raw);
      const { error } = await sb.rpc("claim_item_by_code", { p_code_hash: hash, p_owner: ctx.from.id });
      if (error) return ctx.reply("Код не найден или уже использован. Проверьте цифры и попробуйте снова.");
      await ctx.reply("Готово! Вещь добавлена в «Мои вещи» ✅");
    } catch (e) {
      console.error(e);
      return ctx.reply("Не удалось добавить вещь. Попробуйте позже.");
    }
    return;
  }

  /* ---------- Ручные промпты (SKU SIZE SERIAL / RANGE) остаются как раньше ---------- */
  if (prompt.startsWith(PROMPT_MINT_ONE)) {
    if (!(await requireRole(ctx, ["admin","manager"]))) return;
    const [sku, size, serialStr] = (ctx.message.text || "").trim().split(/\s+/);
    const serial = parseInt(serialStr, 10);
    if (!sku || !size || !serial) return ctx.reply("Нужно: SKU SIZE SERIAL (например CM-TEE-001 L 1)");
    try {
      const product_id = await findProductId(sku);
      const code = genCode10();
      const hash = sha256(code);
      const { data: row, error } = await sb
        .from("item_instances")
        .insert({ product_id, size, serial, claim_code_hash: hash, claim_token_hash: "code" })
        .select("id").single();
      if (error) throw error;
      await ctx.reply(`✅ Создано\nID: <code>${row.id}</code>\n${size} #${serial}\nКОД: <b>${code}</b>`, { parse_mode: "HTML" });
    } catch (e) {
      const dup = (e?.message || "").includes("duplicate key") || e?.code === "23505";
      if (dup) return ctx.reply("Такая комбинация уже есть. Попробуй другой SERIAL.");
      console.error(e);
      return ctx.reply("Ошибка создания: " + (e?.message || "unknown"));
    }
    return;
  }

  if (prompt.startsWith(PROMPT_MINT_BATCH)) {
    if (!(await requireRole(ctx, ["admin","manager"]))) return;
    const [sku, size, rangeRaw] = (ctx.message.text || "").trim().split(/\s+/);
    if (!sku || !size || !rangeRaw) return ctx.reply("Нужно: SKU SIZE RANGE (1..10 или 1,2,5)");
    let serials = [];
    if (/^\d+\.\.\d+$/.test(rangeRaw)) {
      const [a,b] = rangeRaw.split("..").map(n=>parseInt(n,10));
      for (let i=a;i<=b;i++) serials.push(i);
    } else {
      serials = rangeRaw.split(",").map(n=>parseInt(n.trim(),10)).filter(Boolean);
    }
    if (!serials.length) return ctx.reply("Пустой диапазон.");
    const product_id = await findProductId(sku);
    const lines = [];
    for (const s of serials) {
      try {
        const code = genCode10();
        const hash = sha256(code);
        const { error } = await sb.from("item_instances")
          .insert({ product_id, size, serial: s, claim_code_hash: hash, claim_token_hash: "code" });
        if (error) throw error;
        lines.push(`${size} #${s} — ${code}`);
      } catch (e) {
        lines.push(`${size} #${s} — ошибка/дубликат`);
      }
    }
    for (let i=0;i<lines.length;i+=60) await ctx.reply(lines.slice(i,i+60).join("\n"));
    await ctx.reply(`✅ Партия обработана: ${serials.length} шт.`);
    return;
  }

  /* ---------- По выбранному товару (ONE/BATCH) как раньше ---------- */
  if (prompt.startsWith(PROMPT_SIZE_SERIAL_FOR)) {
    if (!(await requireRole(ctx, ["admin","manager"]))) return;
    const m = prompt.match(/\[P:\s*([0-9a-f-]{36})\]/i);
    if (!m) return ctx.reply("Не распознали товар. Повтори выбор.");
    const product_id = m[1];

    const [size, serialStr] = (ctx.message.text || "").trim().split(/\s+/);
    const serial = parseInt(serialStr, 10);
    if (!size || !serial) return ctx.reply("Нужно: SIZE SERIAL (пример: L 1)");

    try {
      const code = genCode10();
      const hash = sha256(code);
      const { data: row, error } = await sb
        .from("item_instances")
        .insert({ product_id, size, serial, claim_code_hash: hash, claim_token_hash: "code" })
        .select("id").single();
      if (error) throw error;
      await ctx.reply(`✅ Создано\nID: <code>${row.id}</code>\n${size} #${serial}\nКОД: <b>${code}</b>`, { parse_mode: "HTML" });
    } catch (e) {
      return ctx.reply("Ошибка создания: " + (e?.message || "unknown"));
    }
    return;
  }

  if (prompt.startsWith(PROMPT_SIZE_RANGE_FOR)) {
    if (!(await requireRole(ctx, ["admin","manager"]))) return;
    const m = prompt.match(/\[P:\s*([0-9a-f-]{36})\]/i);
    if (!m) return ctx.reply("Не распознали товар. Повтори выбор.");
    const product_id = m[1];

    const [size, rangeRaw] = (ctx.message.text || "").trim().split(/\s+/);
    if (!size || !rangeRaw) return ctx.reply("Нужно: SIZE RANGE (пример: L 1..10 или L 1,2,5)");

    let serials = [];
    if (/^\d+\.\.\d+$/.test(rangeRaw)) {
      const [a,b] = rangeRaw.split("..").map(n=>parseInt(n,10));
      for (let i=a;i<=b;i++) serials.push(i);
    } else {
      serials = rangeRaw.split(",").map(n=>parseInt(n.trim(),10)).filter(Boolean);
    }
    if (!serials.length) return ctx.reply("Пустой диапазон.");

    const lines = [];
    for (const s of serials) {
      try {
        const code = genCode10();
        const hash = sha256(code);
        const { error } = await sb.from("item_instances")
          .insert({ product_id, size, serial: s, claim_code_hash: hash, claim_token_hash: "code" });
        if (error) throw error;
        lines.push(`${size} #${s} — ${code}`);
      } catch (e) {
        lines.push(`${size} #${s} — ошибка/дубликат`);
      }
    }
    for (let i=0;i<lines.length;i+=60) await ctx.reply(lines.slice(i,i+60).join("\n"));
    await ctx.reply(`✅ Партия обработана: ${serials.length} шт.`);
    return;
  }

  /* ---------- Автопартия: план вводом (S:10,M:8,...) ---------- */
  if (prompt.startsWith(PROMPT_AUTO_PLAN_FOR)) {
    if (!(await requireRole(ctx, ["admin","manager"]))) return;
    const m = prompt.match(/\[P:\s*([0-9a-f-]{36})\]/i);
    if (!m) return ctx.reply("Не распознали товар. Повтори выбор.");
    const product_id = m[1];

    // парсим план: S:10,M:8,L:5
    const text = (ctx.message.text || "").trim();
    const map = {};
    for (const part of text.split(",")) {
      const [size, cntStr] = part.split(":").map(s=>s.trim());
      const cnt = parseInt(cntStr, 10);
      if (size && cnt > 0) map[size] = (map[size] || 0) + cnt;
    }
    const sizes = Object.keys(map);
    if (!sizes.length) return ctx.reply("Не распознал план. Пример: S:10,M:8,L:5");

    // для каждого размера продолжим serial от максимального
    const lines = [];
    for (const size of sizes) {
      const count = map[size];
      // найдём текущий max(serial)
      const { data: maxRow } = await sb.rpc("max_serial_for_product_size", { p_product_id: product_id, p_size: size }).maybeSingle?.() ?? {};
      let startSerial = (maxRow?.max || 0) + 1;

      for (let i = 0; i < count; i++) {
        try {
          const code = genCode10();
          const hash = sha256(code);
          const serial = startSerial + i;
          const { error } = await sb.from("item_instances")
            .insert({ product_id, size, serial, claim_code_hash: hash, claim_token_hash: "code" });
          if (error) throw error;
          lines.push(`${size} #${serial} — ${code}`);
        } catch (e) {
          lines.push(`${size} #${startSerial + i} — ошибка/дубликат`);
        }
      }
    }
    for (let i=0;i<lines.length;i+=60) await ctx.reply(lines.slice(i,i+60).join("\n"));
    await ctx.reply(`✅ Автопартия создана: ${lines.length} шт.`);
    return;
  }
});

/** ===================== Raffles ===================== */
BOT.hears("🎯 Рафлы", async (ctx) => {
  const { data: raffles } = await sb
    .from("raffles")
    .select("*")
    .eq("is_finished", false)
    .order("starts_at", { ascending: true });

  if (!raffles || raffles.length === 0) {
    const mm = mainMenu();
    return ctx.reply("❌ Сейчас нет активных дропов.", { reply_markup: mm.reply_markup });
  }

  for (const r of raffles) {
    const text = `🎯 <b>${html(r.title)}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${r.winners_count}`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("🪩 Участвовать", `join_${r.id}`)]]);
    if (r.image_url) {
      await ctx.replyWithPhoto(r.image_url, { caption: text, parse_mode: "HTML", reply_markup: kb.reply_markup });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb.reply_markup });
    }
  }
});

BOT.action(/join_(.+)/, async (ctx) => {
  const raffleId = ctx.match[1];
  const user = ctx.from;
  try {
    const { data: r } = await sb.from("raffles").select("*").eq("id", raffleId).single();
    if (!r) return ctx.answerCbQuery("Раффл не найден 😔");
    if (r.is_finished) {
      await ctx.answerCbQuery("❌ Дроп завершён!");
      const mm = mainMenu();
      return ctx.reply("❌ Дроп уже закрыт!", { reply_markup: mm.reply_markup });
    }
    const { data: existing } = await sb.from("winners").select("id").eq("raffle_id", raffleId);
    const count = existing?.length || 0;
    if (count >= r.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
      return ctx.answerCbQuery("Все победители уже выбраны 😅");
    }
    const { data: prev } = await sb.from("entries").select("id").eq("raffle_id", raffleId).eq("tg_user_id", user.id).maybeSingle();
    if (prev) return ctx.answerCbQuery("Ты уже участвуешь 😎");

    await sb.from("entries").insert({ raffle_id: raffleId, tg_user_id: user.id, tg_username: user.username || null });
    await sb.from("winners").insert({ raffle_id: raffleId, tg_user_id: user.id });

    await ctx.answerCbQuery("🎉 Ты выиграл!");
    await ctx.reply(`🏆 Поздравляем, ${html(user.first_name || "участник")}!\nТы стал победителем дропа <b>${html(r.title)}</b> 🎯`, { parse_mode: "HTML" });

    const { data: allWinners } = await sb.from("winners").select("tg_user_id").eq("raffle_id", raffleId);
    if ((allWinners?.length || 0) >= r.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
      if (process.env.CHAT_ID) {
        await BOT.telegram.sendMessage(process.env.CHAT_ID, `🎯 Дроп <b>${html(r.title)}</b> завершён!\nПобедителей: ${r.winners_count}`, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("Ошибка 😔");
  }
});

/** ===================== Admin panel ===================== */
async function openAdminPanel(ctx) {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  const rows = [
    [ Markup.button.callback("➕ Код для вещи", "ADM_MINT_ONE"),
      Markup.button.callback("📦 Партия кодов", "ADM_MINT_BATCH") ],
    [ Markup.button.callback("🧾 Код по товару (выбор)", "ADM_PICK_ONE"),
      Markup.button.callback("📦 Партия по товару (выбор)", "ADM_PICK_BATCH") ],
    [ Markup.button.callback("🛠 Авто-партия (из products)", "ADM_AUTO_BATCH") ],
    [ Markup.button.callback("🎯 Создать дроп", "ADM_ADD_DROP"),
      Markup.button.callback("✅ Завершить дроп", "ADM_FINISH_DROP") ],
  ];
  if (await hasRole(ctx, ["admin"])) {
    rows.push([Markup.button.callback("📋 Роли: список", "ADM_ROLE_LIST")]);
  }
  await ctx.reply("👑 Админ-панель", { reply_markup: Markup.inlineKeyboard(rows).reply_markup });
}
BOT.command("admin", async (ctx) => openAdminPanel(ctx));
BOT.hears(/^\/admin(@\w+)?$/i, async (ctx) => openAdminPanel(ctx));

// Ручные промпты-кнопки
BOT.action("ADM_MINT_ONE",   async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return ctx.reply(PROMPT_MINT_ONE,   { reply_markup: { force_reply: true, input_field_placeholder: "CM-TEE-001 L 1" } }); });
BOT.action("ADM_MINT_BATCH", async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return ctx.reply(PROMPT_MINT_BATCH, { reply_markup: { force_reply: true, input_field_placeholder: "CM-TEE-001 L 1..10" } }); });

// Выбор товара (one/batch/auto)
BOT.action("ADM_PICK_ONE",    async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return renderProductPage(ctx, 0, "one"); });
BOT.action("ADM_PICK_BATCH",  async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return renderProductPage(ctx, 0, "batch"); });
BOT.action("ADM_AUTO_BATCH",  async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return renderProductPage(ctx, 0, "auto"); });

BOT.action(/^PP_ONE_PAGE_(\d+)$/,   async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return renderProductPage(ctx, parseInt(ctx.match[1],10)||0, "one"); });
BOT.action(/^PP_BATCH_PAGE_(\d+)$/, async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return renderProductPage(ctx, parseInt(ctx.match[1],10)||0, "batch"); });
BOT.action(/^PP_AUTO_PAGE_(\d+)$/,  async (ctx) => { if (!(await requireRole(ctx, ["admin","manager"]))) return; await ctx.answerCbQuery(); return renderProductPage(ctx, parseInt(ctx.match[1],10)||0, "auto"); });

BOT.action(/^PP_ONE_SEL_([0-9a-f-]{36})$/i, async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  await ctx.answerCbQuery();
  const product_id = ctx.match[1];
  const { data: p } = await sb.from("products").select("*").eq("id", product_id).maybeSingle();
  const label = productLabel(p) || product_id;
  return ctx.reply(`${PROMPT_SIZE_SERIAL_FOR}\n${label}\n[P: ${product_id}]`, { reply_markup: { force_reply: true, input_field_placeholder: "Например: L 1" } });
});
BOT.action(/^PP_BATCH_SEL_([0-9a-f-]{36})$/i, async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  await ctx.answerCbQuery();
  const product_id = ctx.match[1];
  const { data: p } = await sb.from("products").select("*").eq("id", product_id).maybeSingle();
  const label = productLabel(p) || product_id;
  return ctx.reply(`${PROMPT_SIZE_RANGE_FOR}\n${label}\n[P: ${product_id}]`, { reply_markup: { force_reply: true, input_field_placeholder: "Например: L 1..10" } });
});
BOT.action(/^PP_AUTO_SEL_([0-9a-f-]{36})$/i, async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  await ctx.answerCbQuery();
  const product_id = ctx.match[1];

  // пытаемся найти план внутри продукта
  const { data: p } = await sb.from("products").select("*").eq("id", product_id).maybeSingle();

  // sizes_json: {"S":10,"M":8} или sizes_map / sizes (json/text[])
  let plan = null;
  if (p?.sizes_json && typeof p.sizes_json === "object") plan = p.sizes_json;
  else if (p?.sizes_map && typeof p.sizes_map === "object") plan = p.sizes_map;
  else if (Array.isArray(p?.sizes)) plan = Object.fromEntries(p.sizes.map(s => [s, 1])); // по 1 на размер
  else if (typeof p?.sizes === "string") {
    // строка "S,M,L" -> по 1 на размер
    const arr = p.sizes.split(",").map(s=>s.trim()).filter(Boolean);
    if (arr.length) plan = Object.fromEntries(arr.map(s => [s, 1]));
  }

  const label = productLabel(p) || product_id;
  if (!plan || !Object.keys(plan).length) {
    // спросим план вручную
    return ctx.reply(`${PROMPT_AUTO_PLAN_FOR}\n${label}\n[P: ${product_id}]`, {
      reply_markup: { force_reply: true, input_field_placeholder: "Пример: S:10,M:8,L:5" }
    });
  }

  // есть план — создаём сразу
  const sizes = Object.keys(plan);
  const lines = [];
  for (const size of sizes) {
    const count = parseInt(plan[size], 10);
    if (!(count > 0)) continue;

    // найдём текущее max(serial) для пары product_id+size
    let startSerial = 1;
    try {
      const { data: rows } = await sb
        .from("item_instances")
        .select("serial")
        .eq("product_id", product_id)
        .eq("size", size)
        .order("serial", { ascending: false })
        .limit(1);
      startSerial = ((rows?.[0]?.serial || 0) + 1);
    } catch {}

    for (let i = 0; i < count; i++) {
      try {
        const code = genCode10();
        const hash = sha256(code);
        const serial = startSerial + i;
        const { error } = await sb.from("item_instances")
          .insert({ product_id, size, serial, claim_code_hash: hash, claim_token_hash: "code" });
        if (error) throw error;
        lines.push(`${size} #${serial} — ${code}`);
      } catch (e) {
        lines.push(`${size} #${startSerial + i} — ошибка/дубликат`);
      }
    }
  }
  if (!lines.length) return ctx.reply("План пуст. Укажи план вручную: S:10,M:8,L:5");
  for (let i=0;i<lines.length;i+=60) await ctx.reply(lines.slice(i,i+60).join("\n"));
  await ctx.reply(`✅ Автопартия создана: ${lines.length} шт.`);
});

/** ===================== Drops ===================== */
BOT.hears("🎯 Рафлы", async (ctx) => {
  const { data: raffles } = await sb
    .from("raffles")
    .select("*")
    .eq("is_finished", false)
    .order("starts_at", { ascending: true });

  if (!raffles || raffles.length === 0) {
    const mm = mainMenu();
    return ctx.reply("❌ Сейчас нет активных дропов.", { reply_markup: mm.reply_markup });
  }

  for (const r of raffles) {
    const text = `🎯 <b>${html(r.title)}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${r.winners_count}`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("🪩 Участвовать", `join_${r.id}`)]]);
    if (r.image_url) {
      await ctx.replyWithPhoto(r.image_url, { caption: text, parse_mode: "HTML", reply_markup: kb.reply_markup });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb.reply_markup });
    }
  }
});

BOT.action(/join_(.+)/, async (ctx) => {
  const raffleId = ctx.match[1];
  const user = ctx.from;
  try {
    const { data: r } = await sb.from("raffles").select("*").eq("id", raffleId).single();
    if (!r) return ctx.answerCbQuery("Раффл не найден 😔");
    if (r.is_finished) {
      await ctx.answerCbQuery("❌ Дроп завершён!");
      const mm = mainMenu();
      return ctx.reply("❌ Дроп уже закрыт!", { reply_markup: mm.reply_markup });
    }
    const { data: existing } = await sb.from("winners").select("id").eq("raffle_id", raffleId);
    const count = existing?.length || 0;
    if (count >= r.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
      return ctx.answerCbQuery("Все победители уже выбраны 😅");
    }
    const { data: prev } = await sb.from("entries").select("id").eq("raffle_id", raffleId).eq("tg_user_id", user.id).maybeSingle();
    if (prev) return ctx.answerCbQuery("Ты уже участвуешь 😎");

    await sb.from("entries").insert({ raffle_id: raffleId, tg_user_id: user.id, tg_username: user.username || null });
    await sb.from("winners").insert({ raffle_id: raffleId, tg_user_id: user.id });

    await ctx.answerCbQuery("🎉 Ты выиграл!");
    await ctx.reply(`🏆 Поздравляем, ${html(user.first_name || "участник")}!\nТы стал победителем дропа <b>${html(r.title)}</b> 🎯`, { parse_mode: "HTML" });

    const { data: allWinners } = await sb.from("winners").select("tg_user_id").eq("raffle_id", raffleId);
    if ((allWinners?.length || 0) >= r.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
      if (process.env.CHAT_ID) {
        await BOT.telegram.sendMessage(process.env.CHAT_ID, `🎯 Дроп <b>${html(r.title)}</b> завершён!\nПобедителей: ${r.winners_count}`, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("Ошибка 😔");
  }
});

/** ===================== Settings ===================== */
BOT.hears("⚙️ Настройки", async (ctx) => {
  const km = phoneKeyboard();
  const mm = mainMenu();
  await ctx.reply("Если нужно обновить номер — нажми кнопку ниже 👇", { reply_markup: km.reply_markup });
  return ctx.reply("Настройки:\n— язык: auto\n— уведомления: включены 🔔", { reply_markup: mm.reply_markup });
});

/** ===================== Webhook handler ===================== */
export default async function handler(req, res) {
  try {
    const secret = req.query?.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }

    // быстрый самотест:
    // /api/telegram?secret=...&test=simulate&chat_id=<YOUR_ID>
    if (req.method === "GET" && req.query?.test === "simulate") {
      const chatId = Number(req.query.chat_id);
      if (chatId) {
        await BOT.handleUpdate({
          update_id: Date.now(),
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            text: "/ping",
            chat: { id: chatId, type: "private" },
            from: { id: chatId, is_bot: false, first_name: "Test" },
          },
        });
      }
      return res.json({ ok: true, simulated: true });
    }

    await BOT.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (e) {
    console.error("Bot error:", e);
    return res.status(200).json({ ok: true });
  }
}
