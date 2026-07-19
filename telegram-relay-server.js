const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const PORT = Number(process.env.PORT || 3001);
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body, null, 2));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 64) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function readOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function sanitizeOrder(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const safeItems = items.map((item) => ({
    id: String(item.id || '').slice(0, 80),
    name: String(item.name || item.id || 'product').slice(0, 160),
    qty: Number(item.qty) || 1,
    price: Number(item.price) || 0,
  }));

  const totalQty = Number(payload.totalQty) || safeItems.reduce((sum, item) => sum + item.qty, 0);
  const subtotal = Number(payload.subtotal) || safeItems.reduce((sum, item) => sum + item.price * item.qty, 0);

  return {
    id: payload.orderId || `DR-${Date.now().toString(36).toUpperCase()}`,
    createdAt: new Date().toISOString(),
    source: String(payload.source || 'site').slice(0, 40),
    event: String(payload.event || 'order_summary').slice(0, 40),
    totalQty,
    subtotal,
    currency: String(payload.currency || 'SAR').slice(0, 12),
    items: safeItems,
  };
}

function formatOrderMessage(order) {
  const lines = [
    'طلب جديد',
    `رقم الطلب: ${order.id}`,
    `المصدر: ${order.source}`,
    `العملية: ${order.event}`,
    `عدد القطع: ${order.totalQty}`,
    `الإجمالي: ${order.subtotal} ${order.currency}`,
    '',
    'المنتجات:',
  ];

  if (!order.items.length) {
    lines.push('- لا توجد منتجات');
  } else {
    order.items.forEach((item) => {
      lines.push(`- ${item.name} | الكمية: ${item.qty} | السعر: ${item.price} ${order.currency}`);
    });
  }

  return lines.join('\n');
}

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      resolve({ skipped: true, reason: 'telegram_not_configured' });
      return;
    }

    const data = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
    });

    const request = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ skipped: false, ok: true });
          } else {
            reject(new Error(`Telegram returned ${response.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    request.on('error', reject);
    request.write(data);
    request.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      mode: 'local-orders',
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/orders') {
    sendJson(res, 200, { ok: true, orders: readOrders() });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/orders') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  try {
    const payload = await readJson(req);
    const order = sanitizeOrder(payload);
    const orders = readOrders();
    orders.push(order);
    writeOrders(orders);
    let telegram = { skipped: true, reason: 'telegram_not_configured' };
    try {
      telegram = await sendTelegramMessage(formatOrderMessage(order));
    } catch (telegramError) {
      telegram = { skipped: false, ok: false, error: telegramError.message };
    }
    sendJson(res, 200, { ok: true, order, telegram });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Local orders server listening on http://127.0.0.1:${PORT}`);
  console.log(`Orders endpoint: http://127.0.0.1:${PORT}/orders`);
  console.log(`Telegram configured: ${Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)}`);
});
