// scripts/generate_qr_batch.js
// npm i jsonwebtoken qrcode @supabase/supabase-js
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CLAIM_SECRET = process.env.CLAIM_SECRET;

async function getProductIdBySku(sku) {
  const { data, error } = await supabase.from('products').select('id').eq('sku', sku).single();
  if (error || !data) throw new Error('Product not found by sku: ' + sku);
  return data.id;
}

(async () => {
  // ВАРИАНТ 1: через SKU
  const SKU = 'CM-TEE-001'; // поменяй
  const productId = await getProductIdBySku(SKU);

  // Список экземпляров для партии
  const batch = [
    { size: 'M', serial: 1 },
    { size: 'L', serial: 2 },
    // добавляй…
  ];

  fs.mkdirSync('qr', { recursive: true });

  for (const it of batch) {
    // создаём запись экземпляра
    const { data: row, error } = await supabase
      .from('item_instances')
      .insert({ product_id: productId, size: it.size, serial: it.serial, claim_token_hash: 'placeholder' })
      .select('id')
      .single();
    if (error) throw error;

    // генерим одноразовый токен
    const jti = crypto.randomUUID();
    const token = jwt.sign({ kind: 'claim', itemId: row.id, jti }, CLAIM_SECRET, { expiresIn: '3650d' });
    const hash = crypto.createHash('sha256').update(jti).digest('hex');

    // сохраняем хеш токена
    await supabase.from('item_instances').update({ claim_token_hash: hash }).eq('id', row.id);

    // делаем QR
    const url = `https://t.me/<ТВОЙ_бот>?start=claim_${token}`; // подставь имя бота
    const file = path.join('qr', `${SKU}_${it.size}_${it.serial}.png`);
    await QRCode.toFile(file, url, { margin: 1, width: 512 });

    console.log('QR saved:', file);
  }
})();
