const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_HOST = 'https://market.csgo.com';

// Получаем базовый URL для текущего хоста
function getBaseUrl(req) {
    const protocol = req.secure ? 'https' : 'http';
    const host = req.get('host');
    return `${protocol}://${host}`;
}

app.use(cookieParser());
app.use(compression());

// Хранилище для cookies сессии
const sessionCookies = new Map();

// Функция для получения cookies для сессии
function getSessionCookies(sessionId) {
    return sessionCookies.get(sessionId) || {};
}

// Функция для сохранения cookies сессии
function saveSessionCookies(sessionId, cookies) {
    const existing = getSessionCookies(sessionId);
    sessionCookies.set(sessionId, { ...existing, ...cookies });
}

// Парсинг cookies из заголовков
function parseCookies(cookieHeaders) {
    const cookies = {};
    if (Array.isArray(cookieHeaders)) {
        cookieHeaders.forEach(cookie => {
            const [nameValue] = cookie.split(';');
            const [name, value] = nameValue.split('=');
            if (name && value) {
                cookies[name.trim()] = value.trim();
            }
        });
    }
    return cookies;
}

// Создание строки cookies для запроса
function createCookieString(cookies) {
    return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

// Модификация HTML
function modifyHtml(html, baseUrl) {
    let modified = html.toString();
    
    // Заменяем все ссылки на market.csgo.com
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/"\/api\//g, `"${baseUrl}/api/`);
    modified = modified.replace(/'\/api\//g, `'${baseUrl}/api/`);
    
    // Добавляем скрипт для перехвата навигации
    const interceptScript = `
    <script>
    (function() {
        console.log('🔥 Navigation interceptor active');
        
        // Сохраняем оригинальные функции
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        const originalLocation = window.location;
        
        // Модификация URL
        function modifyUrl(url) {
            if (!url) return url;
            if (url.includes('market.csgo.com')) {
                return url.replace(/https?:\\/\\/market\\.csgo\\.com/, '${baseUrl}');
            }
            return url;
        }
        
        // Перехват history API
        history.pushState = function(state, title, url) {
            url = modifyUrl(url);
            return originalPushState.call(this, state, title, url);
        };
        
        history.replaceState = function(state, title, url) {
            url = modifyUrl(url);
            return originalReplaceState.call(this, state, title, url);
        };
        
        // Перехват всех кликов по ссылкам
        document.addEventListener('click', function(e) {
            let target = e.target;
            while (target && target.tagName !== 'A') {
                target = target.parentElement;
            }
            
            if (target && target.tagName === 'A' && target.href) {
                const href = target.getAttribute('href');
                if (href && (href.includes('market.csgo.com') || href.startsWith('/'))) {
                    e.preventDefault();
                    const newUrl = modifyUrl(target.href);
                    window.location.href = newUrl;
                }
            }
        }, true);
        
        // Перехват прямых изменений location
        Object.defineProperty(window, 'location', {
            get: function() {
                return originalLocation;
            },
            set: function(url) {
                url = modifyUrl(url);
                originalLocation.href = url;
            }
        });
        
        // Перехват XMLHttpRequest
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            url = modifyUrl(url);
            return originalOpen.apply(this, arguments);
        };
        
        // Перехват fetch
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
            if (typeof url === 'string') {
                url = modifyUrl(url);
            }
            return originalFetch.apply(this, arguments);
        };
    })();
    </script>
    `;
    
    // Вставляем скрипт перед закрывающим тегом body
    modified = modified.replace('</body>', interceptScript + '</body>');
    
    return modified;
}

// Модификация CSS
function modifyCss(css, baseUrl) {
    let modified = css.toString();
    modified = modified.replace(/url\(['"]?https:\/\/market\.csgo\.com/g, `url('${baseUrl}`);
    modified = modified.replace(/url\(['"]?\/\//g, `url('${baseUrl}/`);
    return modified;
}

// Модификация JavaScript
function modifyJs(js, baseUrl) {
    let modified = js.toString();
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/"\/api\//g, `"${baseUrl}/api/`);
    modified = modified.replace(/'\/api\//g, `'${baseUrl}/api/`);
    return modified;
}

// Основной обработчик всех запросов
app.use('*', async (req, res) => {
    try {
        const baseUrl = getBaseUrl(req);
        const targetUrl = TARGET_HOST + req.originalUrl;
        const sessionId = req.cookies.sessionId || Math.random().toString(36).substring(7);
        
        // Устанавливаем sessionId если его нет
        if (!req.cookies.sessionId) {
            res.cookie('sessionId', sessionId, { httpOnly: true, secure: false });
        }
        
        // Получаем сохраненные cookies для этой сессии
        const savedCookies = getSessionCookies(sessionId);
        const cookieString = createCookieString(savedCookies);
        
        console.log(`🚀 ${req.method} ${req.originalUrl} -> ${targetUrl}`);
        
        // Настройки запроса
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: {
                ...req.headers,
                'host': 'market.csgo.com',
                'origin': TARGET_HOST,
                'referer': TARGET_HOST,
                'cookie': cookieString,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': req.headers.accept || '*/*',
                'accept-language': 'en-US,en;q=0.9,ru;q=0.8',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1'
            },
            data: req.body,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            maxRedirects: 0,
            decompress: false
        };
        
        // Удаляем заголовки, которые могут выдать прокси
        delete axiosConfig.headers['x-forwarded-for'];
        delete axiosConfig.headers['x-forwarded-proto'];
        delete axiosConfig.headers['x-forwarded-host'];
        delete axiosConfig.headers['x-real-ip'];
        
        // Делаем запрос
        const response = await axios(axiosConfig);
        
        console.log(`✅ Response: ${response.status} ${response.headers['content-type']}`);
        
        // Сохраняем cookies из ответа
        if (response.headers['set-cookie']) {
            const newCookies = parseCookies(response.headers['set-cookie']);
            saveSessionCookies(sessionId, newCookies);
        }
        
        // Обработка редиректов
        if (response.status === 301 || response.status === 302) {
            let location = response.headers.location;
            console.log(`🔄 Original redirect: ${location}`);
            
            if (location) {
                // Если редирект на market.csgo.com, меняем на наш домен
                if (location.includes('market.csgo.com')) {
                    location = location.replace(/https?:\/\/market\.csgo\.com/, baseUrl);
                } else if (location.startsWith('/')) {
                    location = baseUrl + location;
                }
                
                console.log(`🔄 Modified redirect: ${location}`);
                return res.redirect(location);
            }
        }
        
        // Получаем контент
        let content = response.data;
        
        // Декомпрессия если нужно
        const encoding = response.headers['content-encoding'];
        if (encoding === 'gzip') {
            content = zlib.gunzipSync(content);
        } else if (encoding === 'deflate') {
            content = zlib.inflateSync(content);
        } else if (encoding === 'br') {
            content = zlib.brotliDecompressSync(content);
        }
        
        // Модификация контента
        const contentType = response.headers['content-type'] || '';
        let modifiedContent = content;
        
        if (contentType.includes('text/html')) {
            modifiedContent = Buffer.from(modifyHtml(content.toString('utf8'), baseUrl), 'utf8');
        } else if (contentType.includes('text/css')) {
            modifiedContent = Buffer.from(modifyCss(content.toString('utf8'), baseUrl), 'utf8');
        } else if (contentType.includes('javascript')) {
            modifiedContent = Buffer.from(modifyJs(content.toString('utf8'), baseUrl), 'utf8');
        } else if (contentType.includes('application/json')) {
            let json = content.toString('utf8');
            json = json.replace(/https:\/\/market\.csgo\.com/g, baseUrl);
            modifiedContent = Buffer.from(json, 'utf8');
        }
        
        // Устанавливаем заголовки ответа
        const responseHeaders = { ...response.headers };
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['strict-transport-security'];
        
        // Устанавливаем новые заголовки
        Object.entries(responseHeaders).forEach(([key, value]) => {
            if (key === 'set-cookie') {
                // Модифицируем cookies
                if (Array.isArray(value)) {
                    value = value.map(cookie => {
                        return cookie
                            .replace(/domain=.*?;/gi, '')
                            .replace(/secure;/gi, '')
                            .replace(/samesite=none;/gi, 'samesite=lax;');
                    });
                }
            }
            res.set(key, value);
        });
        
        res.set('content-length', modifiedContent.length);
        res.status(response.status);
        res.send(modifiedContent);
        
    } catch (error) {
        console.error('❌ Proxy error:', error);
        res.status(500).send('Proxy Error: ' + error.message);
    }
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Advanced proxy server running on port ${PORT}`);
    console.log(`🎯 Proxying to ${TARGET_HOST}`);
});
