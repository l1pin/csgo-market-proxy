// Полнофункциональный прокси-сервер с правильной обработкой всех типов контента
// npm install express http-proxy-middleware cookie-parser compression

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const zlib = require('zlib');

const app = express();
const TARGET_HOST = 'https://market.csgo.com';
const LOCAL_HOST = 'http://localhost:3000';
const PORT = 3000;

// Настройка middleware
app.use(cookieParser());
app.use(compression());

// Отключаем кеширование для разработки
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
});

// Функция модификации HTML контента
function modifyHtml(html) {
    if (!html) return html;
    
    // Заменяем все URL в HTML
    let modified = html.toString();
    
    // Основные замены
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, LOCAL_HOST);
    modified = modified.replace(/\/\/market\.csgo\.com/g, LOCAL_HOST);
    
    // Важно: добавляем базовый тег для правильной работы относительных путей
    if (!modified.includes('<base')) {
        modified = modified.replace(/<head[^>]*>/i, `$&<base href="${LOCAL_HOST}/">`);
    }
    
    // Инжектим скрипт для перехвата всех запросов
    const proxyScript = `
    <script data-proxy-injected="true">
    (function() {
        console.log('🚀 Proxy script initializing...');
        
        // Сохраняем оригинальные функции
        const originalFetch = window.fetch;
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalWebSocket = window.WebSocket;
        
        // Модификация URL
        function modifyUrl(url) {
            if (!url) return url;
            
            // Если это уже модифицированный URL, возвращаем как есть
            if (url.startsWith('${LOCAL_HOST}')) {
                return url;
            }
            
            // Обрабатываем абсолютные URL
            if (url.startsWith('https://market.csgo.com') || url.startsWith('http://market.csgo.com')) {
                return url.replace(/https?:\\/\\/market\\.csgo\\.com/, '${LOCAL_HOST}');
            }
            
            // Обрабатываем protocol-relative URL
            if (url.startsWith('//market.csgo.com')) {
                return url.replace('//market.csgo.com', '${LOCAL_HOST}');
            }
            
            // Обрабатываем относительные URL
            if (url.startsWith('/')) {
                return '${LOCAL_HOST}' + url;
            }
            
            return url;
        }
        
        // Перехват fetch
        window.fetch = function(input, init = {}) {
            if (typeof input === 'string') {
                input = modifyUrl(input);
            } else if (input instanceof Request) {
                input = new Request(modifyUrl(input.url), input);
            }
            
            // Добавляем заголовки
            init.credentials = init.credentials || 'include';
            init.headers = init.headers || {};
            
            console.log('Fetch intercepted:', input);
            return originalFetch.call(this, input, init);
        };
        
        // Перехват XMLHttpRequest
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            url = modifyUrl(url);
            console.log('XHR intercepted:', method, url);
            return originalXHROpen.call(this, method, url, async, user, password);
        };
        
        // Перехват WebSocket
        window.WebSocket = function(url, protocols) {
            if (url.startsWith('wss://market.csgo.com') || url.startsWith('ws://market.csgo.com')) {
                url = url.replace(/wss?:\\/\\/market\\.csgo\\.com/, 'ws://localhost:${PORT}');
            }
            console.log('WebSocket intercepted:', url);
            return new originalWebSocket(url, protocols);
        };
        
        // Перехват динамического создания скриптов
        const originalCreateElement = document.createElement;
        document.createElement = function(tagName) {
            const element = originalCreateElement.call(this, tagName);
            
            if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'link') {
                const originalSetAttribute = element.setAttribute;
                element.setAttribute = function(name, value) {
                    if (name === 'src' || name === 'href') {
                        value = modifyUrl(value);
                    }
                    return originalSetAttribute.call(this, name, value);
                };
                
                // Перехват прямого присвоения свойств
                Object.defineProperty(element, 'src', {
                    set: function(value) {
                        this.setAttribute('src', modifyUrl(value));
                    },
                    get: function() {
                        return this.getAttribute('src');
                    }
                });
                
                Object.defineProperty(element, 'href', {
                    set: function(value) {
                        this.setAttribute('href', modifyUrl(value));
                    },
                    get: function() {
                        return this.getAttribute('href');
                    }
                });
            }
            
            return element;
        };
        
        console.log('✅ Proxy script initialized successfully');
    })();
    </script>
    `;
    
    // Вставляем скрипт сразу после открывающего тега head
    modified = modified.replace(/<head[^>]*>/i, '$&' + proxyScript);
    
    return modified;
}

// Функция модификации JavaScript
function modifyJavaScript(js) {
    if (!js) return js;
    
    let modified = js.toString();
    
    // Заменяем URL в JavaScript
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, LOCAL_HOST);
    modified = modified.replace(/\/\/market\.csgo\.com/g, LOCAL_HOST);
    
    // Заменяем API endpoints
    modified = modified.replace(/"\/api\//g, `"${LOCAL_HOST}/api/`);
    modified = modified.replace(/'\/api\//g, `'${LOCAL_HOST}/api/`);
    
    return modified;
}

// Функция модификации CSS
function modifyCSS(css) {
    if (!css) return css;
    
    let modified = css.toString();
    
    // Заменяем URL в CSS
    modified = modified.replace(/url\(['"]?https:\/\/market\.csgo\.com/g, `url('${LOCAL_HOST}`);
    modified = modified.replace(/url\(['"]?\/\/market\.csgo\.com/g, `url('${LOCAL_HOST}`);
    modified = modified.replace(/url\(['"]?\//g, `url('${LOCAL_HOST}/`);
    
    return modified;
}

// Основной прокси middleware
const proxyMiddleware = createProxyMiddleware({
    target: TARGET_HOST,
    changeOrigin: true,
    ws: true,
    secure: false,
    cookieDomainRewrite: {
        '*': 'localhost'
    },
    headers: {
        'Referer': TARGET_HOST,
        'Origin': TARGET_HOST
    },
    onProxyReq: (proxyReq, req, res) => {
        // Устанавливаем правильные заголовки
        proxyReq.setHeader('Host', 'market.csgo.com');
        proxyReq.setHeader('Origin', TARGET_HOST);
        proxyReq.setHeader('Referer', TARGET_HOST + req.url);
        
        // Добавляем User-Agent если его нет
        if (!proxyReq.getHeader('User-Agent')) {
            proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }
        
        // Передаем cookies
        const cookies = req.headers.cookie;
        if (cookies) {
            proxyReq.setHeader('Cookie', cookies);
        }
        
        console.log(`➡️  ${req.method} ${req.url}`);
    },
    onProxyRes: (proxyRes, req, res) => {
        console.log(`⬅️  ${proxyRes.statusCode} ${req.url}`);
        
        // Удаляем заголовки безопасности
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['x-content-type-options'];
        delete proxyRes.headers['strict-transport-security'];
        
        // Добавляем CORS заголовки
        proxyRes.headers['access-control-allow-origin'] = '*';
        proxyRes.headers['access-control-allow-credentials'] = 'true';
        proxyRes.headers['access-control-allow-methods'] = '*';
        proxyRes.headers['access-control-allow-headers'] = '*';
        
        // Обрабатываем cookies
        if (proxyRes.headers['set-cookie']) {
            proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => {
                return cookie
                    .replace(/domain=.*?;/gi, 'domain=localhost;')
                    .replace(/secure;/gi, '');
            });
        }
    },
    selfHandleResponse: true,
    onProxyRes: (proxyRes, req, res) => {
        let body = [];
        
        proxyRes.on('data', (chunk) => {
            body.push(chunk);
        });
        
        proxyRes.on('end', () => {
            let buffer = Buffer.concat(body);
            
            // Проверяем, сжат ли контент
            const encoding = proxyRes.headers['content-encoding'];
            
            // Декодируем если нужно
            if (encoding === 'gzip') {
                buffer = zlib.gunzipSync(buffer);
            } else if (encoding === 'deflate') {
                buffer = zlib.inflateSync(buffer);
            } else if (encoding === 'br') {
                buffer = zlib.brotliDecompressSync(buffer);
            }
            
            // Определяем тип контента
            const contentType = proxyRes.headers['content-type'] || '';
            let modifiedContent = buffer;
            
            try {
                if (contentType.includes('text/html')) {
                    modifiedContent = Buffer.from(modifyHtml(buffer.toString('utf8')));
                } else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
                    modifiedContent = Buffer.from(modifyJavaScript(buffer.toString('utf8')));
                } else if (contentType.includes('text/css')) {
                    modifiedContent = Buffer.from(modifyCSS(buffer.toString('utf8')));
                } else if (contentType.includes('application/json')) {
                    let json = buffer.toString('utf8');
                    json = json.replace(/https:\/\/market\.csgo\.com/g, LOCAL_HOST);
                    modifiedContent = Buffer.from(json);
                }
            } catch (error) {
                console.error('Error modifying content:', error);
            }
            
            // Удаляем заголовки безопасности
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['x-content-type-options'];
            delete proxyRes.headers['strict-transport-security'];
            
            // Устанавливаем правильные заголовки ответа
            res.status(proxyRes.statusCode);
            Object.keys(proxyRes.headers).forEach(key => {
                if (key === 'content-encoding') {
                    // Удаляем content-encoding так как мы уже декодировали контент
                    return;
                }
                if (key === 'content-length') {
                    // Обновляем content-length для модифицированного контента
                    res.setHeader(key, modifiedContent.length);
                } else {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });
            
            // Добавляем CORS заголовки
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            
            res.end(modifiedContent);
        });
    },
    onError: (err, req, res) => {
        console.error('Proxy error:', err);
        res.status(500).send('Proxy Error: ' + err.message);
    }
});

// Применяем прокси ко всем маршрутам
app.use('/', proxyMiddleware);

// Запуск сервера
const server = app.listen(PORT, () => {
    console.log('\n✨ Ultimate Proxy Server Started ✨');
    console.log(`📡 Local URL: http://localhost:${PORT}`);
    console.log(`🎯 Target: ${TARGET_HOST}`);
    console.log('\n🔍 Features:');
    console.log('   ✓ Полное проксирование всех типов контента');
    console.log('   ✓ Обработка HTML/CSS/JS с модификацией URL');
    console.log('   ✓ Поддержка WebSocket');
    console.log('   ✓ Правильная обработка cookies');
    console.log('   ✓ Декомпрессия gzip/deflate/brotli');
    console.log('   ✓ Обход всех заголовков безопасности');
    console.log('\n📌 Usage:');
    console.log(`   Main page: http://localhost:${PORT}/ru`);
    console.log(`   Example: http://localhost:${PORT}/ru/Pistol/Desert%20Eagle/Desert%20Eagle%20%7C%20Printstream%20%28Battle-Scarred%29`);
    console.log('\n');
});

// Обработка ошибок
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down...');
    server.close(() => {
        console.log('✅ Server stopped');
        process.exit(0);
    });
});