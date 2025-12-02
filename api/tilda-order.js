// api/tilda-order.js
const { sb } = require("../lib/db.js");

module.exports = async (req, res) => {
  console.log("Received request:", req.method);  // Логирование метода запроса

  if (req.method !== "POST") {
    console.log("Invalid method");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    console.log("Request Body:", JSON.stringify(body, null, 2));  // Логирование всего тела запроса

    const {
      orderid,
      clientemail,
      clientname,
      clientphone,
      products,
      payment,
      delivery,
      comment,
      promocode,
      amount,
      currency,
    } = body;

    // Проверка, что все необходимые поля присутствуют
    if (!orderid || !clientemail || !clientname || !products) {
      console.log("Missing required fields:", { orderid, clientemail, clientname, products });
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ---------- 1. Находим или создаём профиль по email ----------
    let userId = null;

    if (clientemail) {
      const { data: existingProfile, error: profileError } = await sb
        .from("profiles")
        .select("*")
        .eq("email", clientemail)
        .maybeSingle();

      if (profileError) {
        console.error("Profile select error:", profileError);
        return res.status(500).json({ error: "Profile select error" });
      }

      if (existingProfile) {
        userId = existingProfile.id;
      } else {
        const { data: newProfile, error: insertProfileError } = await sb
          .from("profiles")
          .insert({
            email: clientemail,
            full_name: clientname || null,
            phone: clientphone || null,
          })
          .select()
          .single();

        if (insertProfileError) {
          console.error("Profile insert error:", insertProfileError);
          return res.status(500).json({ error: "Cannot create profile" });
        }

        userId = newProfile.id;
      }
    }

    // ---------- 2. Создаём заказ ----------
    const { data: order, error: orderError } = await sb
      .from("orders")
      .insert({
        tilda_order_id: orderid,
        user_id: userId,
        status: "new", 
        payment_method: payment || null,
        delivery_method: delivery || null,
        comment: comment || null,
        promocode: promocode || null,
        total_amount: amount ? Number(amount) : null,
        currency: currency || "RUB",
        raw_payload: body, 
      })
      .select()
      .single();

    if (orderError) {
      console.error("Order insert error:", orderError);
      return res.status(500).json({ error: "Cannot create order" });
    }

    const orderId = order.id;
    console.log("Order created:", orderId);

    // ---------- 3. Сохраняем товары заказа ----------
    let parsedProducts = [];

    if (products) {
      try {
        parsedProducts =
          typeof products === "string" ? JSON.parse(products) : products;
        console.log("Parsed Products:", parsedProducts); // Печать товаров для отладки
      } catch (e) {
        console.error("Products parse error:", e);
        return res.status(500).json({ error: "Error parsing products" });
      }
    }

    if (Array.isArray(parsedProducts) && parsedProducts.length > 0) {
      const itemsToInsert = parsedProducts.map((p) => ({
        order_id: orderId,
        product_title: p.title || p.name || null,
        product_sku: p.sku || null,
        price: p.price ? Number(p.price) : null,
        quantity: p.quantity ? Number(p.quantity) : 1,
        size: p.size || null,
        color: p.color || null,
      }));

      const { error: itemsError } = await sb
        .from("order_items")
        .insert(itemsToInsert);

      if (itemsError) {
        console.error("Order items insert error:", itemsError);
        return res.status(500).json({ error: "Error saving order items" });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Tilda hook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
