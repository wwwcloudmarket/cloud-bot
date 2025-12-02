// server.js
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const port = 3000;

// Настройка Supabase
const supabaseUrl = 'https://tukbbkddbkhvprbpmppf.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1a2Jia2RkYmtodnByYnBtcHBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4OTkzMTgsImV4cCI6MjA3NzQ3NTMxOH0.TyCS-s3BqOenoVwWdF0ETFoATPYEz34Fnl2hMYa9ZaY';
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.json()); // Для парсинга JSON из тела запроса

app.post('/api/submit-order', async (req, res) => {
  const { orderid, clientemail, clientname, clientphone, products } = req.body;

  try {
    // Сохранение данных в таблицу "orders"
    const { data, error } = await supabase
      .from('orders')
      .insert([
        {
          order_id: orderid,
          client_email: clientemail,
          client_name: clientname,
          client_phone: clientphone,
          products: JSON.stringify(products) // Преобразуем в строку JSON
        }
      ]);

    if (error) {
      return res.status(500).json({ error: 'Failed to save order' });
    }

    res.status(200).json({ message: 'Order saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
