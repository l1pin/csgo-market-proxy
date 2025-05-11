const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const zlib = require('zlib');

const app = express();
const TARGET_HOST = 'https://market.csgo.com';
const PORT = process.env.PORT || 3000; // Важно для Render
const LOCAL_HOST = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

console.log('Starting server with:', { PORT, LOCAL_HOST });

// Настройка middleware
app.use(cookieParser());
app.use(compression());

// Отключаем кеширование
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Функция модификации HTML контента
function modifyHtml(html, currentHost) {
    if (!html) return html;
    
    let modified = html.toString();
    
    // Заменяем все URL в HTML
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, currentHost);
    modified = modified.replace(/\/\/market\.csgo\.com/g, currentHost);
    modified = modified.replace(/market\.csgo\.com/g, currentHost.replace(/https?:\/\//, ''));
    
    // Добавляем базовый тег
    if (!modified.includes('<base')) {
        modified = modified.replace(/<head[^>]*>/i, `$&<base href="${currentHost}/">`);
    }
    
    // Улучшенный скрипт для перехвата запросов
    const proxyScript = `
    <script data-proxy-injected="true">
    (function() {
        console.log('🚀 Proxy script initializing...');
        
        const originalFetch = window.fetch;
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const LOCAL_HOST = '${currentHost}';
        
        // Модификация URL
        function modifyUrl(url) {
            if (!url) return url;
            
            // Если это уже наш домен, не меняем
            if (url.includes(window.location.hostname)) {
                return url;
            }
            
            // Заменяем домен market.csgo.com
            if (url.includes('market.csgo.com')) {
                return url.replace(/https?:\\/\\/market\\.csgo\\.com/, LOCAL_HOST);
            }
            
            // Относительные URL
            if (url.startsWith('/')) {
                return LOCAL_HOST + url;
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
            
            init.credentials = init.credentials || 'include';
            console.log('Fetch intercepted:', input);
            return originalFetch.call(this, input, init);
        };
        
        // Перехват XMLHttpRequest
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            url = modifyUrl(url);
            console.log('XHR intercepted:', method, url);
            return originalXHROpen.call(this, method, url, async, user, password);
        };
        
        // Перехват навигации
        const originalAssign = window.location.assign;
        const originalReplace = window.location.replace;
        
        window.location.assign = function(url) {
            url = modifyUrl(url);
            console.log('Navigation intercepted (assign):', url);
            return originalAssign.call(this, url);
        };
        
        window.location.replace = function(url) {
            url = modifyUrl(url);
            console.log('Navigation intercepted (replace):', url);
            return originalReplace.call(this, url);
        };
        
        // Перехват установки href
        Object.defineProperty(window.location, 'href', {
            set: function(url) {
                url = modifyUrl(url);
                console.log('Navigation intercepted (href):', url);
                this.assign(url);
            },
            get: function() {
                return window.location.toString();
            }
        });
        
        console.log('✅ Proxy script initialized successfully');
    })();
    </script>
    `;
    
    modified = modified.replace(/<head[^>]*>/i, '$&' + proxyScript);
    
    return modified;
}

// Основной прокси middleware
const proxyMiddleware = createProxyMiddleware({
    target: TARGET_HOST,
    changeOrigin: true,
    followRedirects: false, // Важно! Не следуем редиректам автоматически
    secure: false,
    ws: true,
    cookieDomainRewrite: {
        'market.csgo.com': '',
        '.market.csgo.com': ''
    },
    onProxyReq: (proxyReq, req, res) => {
        // Устанавливаем правильные заголовки
        proxyReq.setHeader('Host', 'market.csgo.com');
        proxyReq.setHeader('Origin', TARGET_HOST);
        proxyReq.setHeader('Referer', TARGET_HOST + req.url);
        
        // Устанавливаем User-Agent как у браузера
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Не отправляем заголовки, которые могут выдать прокси
        proxyReq.removeHeader('x-forwarded-for');
        proxyReq.removeHeader('x-forwarded-proto');
        proxyReq.removeHeader('x-forwarded-host');
        
        console.log(`➡️  ${req.method} ${req.url}`);
    },
    selfHandleResponse: true,
    onProxyRes: (proxyRes, req, res) => {
        console.log(`⬅️  ${proxyRes.statusCode} ${req.url}`);
        
        // Обработка редиректов
        if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
            const location = proxyRes.headers.location;
            if (location && location.includes('market.csgo.com')) {
                // Перехватываем редирект и меняем на наш домен
                const newLocation = location.replace(/https?:\/\/market\.csgo\.com/, LOCAL_HOST);
                proxyRes.headers.location = newLocation;
                console.log(`🔄 Redirect intercepted: ${location} -> ${newLocation}`);
            }
        }
        
        let body = [];
        
        proxyRes.on('data', (chunk) => {
            body.push(chunk);
        });
        
        proxyRes.on('end', () => {
            let buffer = Buffer.concat(body);
            
            // Декодируем если сжато
            const encoding = proxyRes.headers['content-encoding'];
            
            try {
                if (encoding === 'gzip') {
                    buffer = zlib.gunzipSync(buffer);
                } else if (encoding === 'deflate') {
                    buffer = zlib.inflateSync(buffer);
                } else if (encoding === 'br') {
                    buffer = zlib.brotliDecompressSync(buffer);
                }
            } catch (e) {
                console.error('Decompression error:', e);
            }
            
            // Определяем тип контента и модифицируем
            const contentType = proxyRes.headers['content-type'] || '';
            let modifiedContent = buffer;
            
            try {
                if (contentType.includes('text/html')) {
                    modifiedContent = Buffer.from(modifyHtml(buffer.toString('utf8'), LOCAL_HOST));
                } else if (contentType.includes('javascript')) {
                    let js = buffer.toString('utf8');
                    js = js.replace(/https:\/\/market\.csgo\.com/g, LOCAL_HOST);
                    js = js.replace(/market\.csgo\.com/g, LOCAL_HOST.replace(/https?:\/\//, ''));
                    modifiedContent = Buffer.from(js);
                } else if (contentType.includes('text/css')) {
                    let css = buffer.toString('utf8');
                    css = css.replace(/url\(['"]?https:\/\/market\.csgo\.com/g, `url('${LOCAL_HOST}`);
                    css = css.replace(/url\(['"]?\/\//g, `url('${LOCAL_HOST}/`);
                    modifiedContent = Buffer.from(css);
                } else if (contentType.includes('application/json')) {
                    let json = buffer.toString('utf8');
                    json = json.replace(/https:\/\/market\.csgo\.com/g, LOCAL_HOST);
                    modifiedContent = Buffer.from(json);
                }
            } catch (error) {
                console.error('Content modification error:', error);
            }
            
            // Удаляем заголовки безопасности
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['x-content-type-options'];
            delete proxyRes.headers['strict-transport-security'];
            
            // Устанавливаем заголовки ответа
            res.status(proxyRes.statusCode);
            Object.keys(proxyRes.headers).forEach(key => {
                if (key === 'content-encoding') {
                    return; // Удаляем так как мы декодировали
                }
                if (key === 'content-length') {
                    res.setHeader(key, modifiedContent.length);
                } else if (key === 'set-cookie') {
                    // Обрабатываем cookies
                    const cookies = proxyRes.headers[key];
                    if (Array.isArray(cookies)) {
                        res.setHeader(key, cookies.map(cookie => {
                            return cookie
                                .replace(/domain=.*?;/gi, '')
                                .replace(/secure;/gi, '');
                        }));
                    }
                } else {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });
            
            // CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            
            res.end(modifiedContent);
        });
    }
});

// Применяем прокси ко всем маршрутам
app.use('/', proxyMiddleware);

// Запуск сервера
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n✨ Proxy Server Started ✨');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Local URL: ${LOCAL_HOST}`);
    console.log(`🎯 Target: ${TARGET_HOST}`);
    console.log('\n');
});

// Обработка ошибок
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});