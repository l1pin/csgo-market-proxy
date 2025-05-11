const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const WebSocket = require('ws');
const url = require('url');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_HOST = 'https://market.csgo.com';
const WS_TARGET = 'wss://centrifugo2.csgotrader.app';

// Создаем HTTP сервер
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(compression());

// Хранилище для cookies и токенов
const sessions = new Map();

// Создаем агент для HTTPS с игнорированием сертификатов
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

// Middleware для CORS
app.use((req, res, next) => {
    const origin = req.get('origin') || '*';
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, Set-Cookie, X-Api-Key');
    res.header('Access-Control-Expose-Headers', 'Set-Cookie');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Функция для получения базового URL
function getBaseUrl(req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${protocol}://${host}`;
}

// Получение или создание сессии
function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            cookies: new Map(),
            tokens: new Map(),
            wsToken: null
        });
    }
    return sessions.get(sessionId);
}

// Парсинг cookies из заголовков
function parseCookieHeader(cookieHeader) {
    const cookies = new Map();
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const [name, ...rest] = cookie.trim().split('=');
            if (name && rest.length > 0) {
                cookies.set(name, rest.join('='));
            }
        });
    }
    return cookies;
}

// Обработка set-cookie заголовков
function parseSetCookieHeaders(setCookieHeaders) {
    const cookies = new Map();
    if (Array.isArray(setCookieHeaders)) {
        setCookieHeaders.forEach(cookie => {
            const [nameValue] = cookie.split(';');
            const [name, ...valueParts] = nameValue.split('=');
            if (name && valueParts.length > 0) {
                cookies.set(name.trim(), valueParts.join('='));
            }
        });
    }
    return cookies;
}

// Создание строки cookies для запроса
function createCookieString(cookieMap) {
    return Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

// Модификация URL в контенте
function modifyUrls(content, baseUrl, contentType = '') {
    if (!content) return content;
    
    let modified = content.toString();
    
    // Основные замены для всех типов контента
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/wss:\/\/centrifugo2\.csgotrader\.app/g, baseUrl.replace('http', 'ws') + '/ws');
    
    // Специфичные замены для HTML
    if (contentType.includes('html')) {
        // Добавляем base тег
        if (!modified.includes('<base')) {
            modified = modified.replace(/<head[^>]*>/i, `$&<base href="${baseUrl}/">`);
        }
        
        // Инжектим прокси скрипт
        const proxyScript = `
        <script>
        (function() {
            console.log('🔧 Market proxy initialized');
            
            // Сохраняем оригинальные функции
            const originalFetch = window.fetch;
            const originalXHR = XMLHttpRequest.prototype.open;
            const originalWS = window.WebSocket;
            
            // Модификация URL
            function modifyUrl(url) {
                if (!url) return url;
                
                // Если уже наш домен
                if (url.includes(window.location.host)) {
                    return url;
                }
                
                // WebSocket URLs
                if (url.startsWith('wss://centrifugo2.csgotrader.app')) {
                    return url.replace('wss://centrifugo2.csgotrader.app', 
                        window.location.protocol.replace('http', 'ws') + '//' + window.location.host + '/ws');
                }
                
                // API URLs
                if (url.includes('market.csgo.com')) {
                    return url.replace(/https?:\\/\\/market\\.csgo\\.com/, 
                        window.location.protocol + '//' + window.location.host);
                }
                
                // Относительные URLs
                if (url.startsWith('/') && !url.startsWith('//')) {
                    return window.location.origin + url;
                }
                
                return url;
            }
            
            // Перехват fetch
            window.fetch = async function(input, init = {}) {
                let url = input;
                if (typeof input === 'string') {
                    url = modifyUrl(input);
                } else if (input instanceof Request) {
                    url = new Request(modifyUrl(input.url), input);
                }
                
                // Добавляем credentials для корректной работы cookies
                init.credentials = init.credentials || 'include';
                
                console.log('Fetch:', url);
                return originalFetch.call(this, url, init);
            };
            
            // Перехват XMLHttpRequest
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                url = modifyUrl(url);
                console.log('XHR:', method, url);
                return originalXHR.call(this, method, url, ...args);
            };
            
            // Перехват WebSocket
            window.WebSocket = function(url, protocols) {
                url = modifyUrl(url);
                console.log('WebSocket:', url);
                return new originalWS(url, protocols);
            };
            
            // Перехват EventSource если используется
            if (window.EventSource) {
                const originalES = window.EventSource;
                window.EventSource = function(url, config) {
                    url = modifyUrl(url);
                    console.log('EventSource:', url);
                    return new originalES(url, config);
                };
            }
        })();
        </script>
        `;
        
        modified = modified.replace(/<head[^>]*>/i, `$&${proxyScript}`);
    }
    
    // Специфичные замены для JavaScript
    if (contentType.includes('javascript')) {
        modified = modified.replace(/"\/api\//g, `"${baseUrl}/api/`);
        modified = modified.replace(/'\/api\//g, `'${baseUrl}/api/`);
        modified = modified.replace(/centrifugo2\.csgotrader\.app/g, 
            baseUrl.replace('https://', '').replace('http://', '') + '/ws');
    }
    
    // Специфичные замены для CSS
    if (contentType.includes('css')) {
        modified = modified.replace(/url\(['"]?\//g, `url('${baseUrl}/`);
    }
    
    return modified;
}

// Обработка WebSocket прокси
const wsProxy = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    
    if (pathname === '/ws' || pathname.startsWith('/centrifugo')) {
        wsProxy.handleUpgrade(request, socket, head, (ws) => {
            handleWebSocketProxy(ws, request);
        });
    }
});

function handleWebSocketProxy(clientWs, request) {
    const targetUrl = WS_TARGET + (request.url.replace('/ws', '') || '/connection/websocket');
    console.log('WebSocket proxy:', targetUrl);
    
    const targetWs = new WebSocket(targetUrl, {
        headers: {
            'Origin': 'https://market.csgo.com',
            'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0',
            ...request.headers
        }
    });
    
    targetWs.on('open', () => {
        console.log('Target WebSocket connected');
    });
    
    // Client -> Server
    clientWs.on('message', (message) => {
        if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(message);
        }
    });
    
    // Server -> Client
    targetWs.on('message', (message) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(message);
        }
    });
    
    // Обработка закрытия соединений
    clientWs.on('close', () => {
        targetWs.close();
    });
    
    targetWs.on('close', () => {
        clientWs.close();
    });
    
    // Обработка ошибок
    clientWs.on('error', (err) => {
        console.error('Client WebSocket error:', err);
        targetWs.close();
    });
    
    targetWs.on('error', (err) => {
        console.error('Target WebSocket error:', err);
        clientWs.close();
    });
}

// Главный обработчик HTTP запросов
app.use('*', async (req, res) => {
    try {
        const baseUrl = getBaseUrl(req);
        const targetUrl = TARGET_HOST + req.originalUrl;
        const sessionId = req.cookies.sessionId || Math.random().toString(36).substring(7);
        const session = getSession(sessionId);
        
        // Устанавливаем sessionId если его нет
        if (!req.cookies.sessionId) {
            res.cookie('sessionId', sessionId, { 
                httpOnly: true, 
                secure: false,
                sameSite: 'lax'
            });
        }
        
        // Собираем cookies для запроса
        const requestCookies = new Map([
            ...session.cookies,
            ...parseCookieHeader(req.headers.cookie)
        ]);
        
        console.log(`🌐 ${req.method} ${req.originalUrl}`);
        
        // Настройки для axios
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: {
                ...req.headers,
                'host': 'market.csgo.com',
                'origin': 'https://market.csgo.com',
                'referer': 'https://market.csgo.com/',
                'sec-fetch-site': 'same-origin',
                'sec-fetch-mode': req.headers['sec-fetch-mode'] || 'cors',
                'sec-fetch-dest': req.headers['sec-fetch-dest'] || 'empty',
                'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'cookie': createCookieString(requestCookies)
            },
            data: req.body,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            maxRedirects: 0,
            decompress: true,
            httpsAgent: httpsAgent
        };
        
        // Удаляем заголовки прокси
        delete axiosConfig.headers['x-forwarded-for'];
        delete axiosConfig.headers['x-forwarded-proto'];
        delete axiosConfig.headers['x-forwarded-host'];
        delete axiosConfig.headers['x-real-ip'];
        delete axiosConfig.headers['cf-connecting-ip'];
        delete axiosConfig.headers['cf-ipcountry'];
        
        const response = await axios(axiosConfig);
        
        // Обработка редиректов
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            let location = response.headers.location;
            if (location) {
                if (location.includes('market.csgo.com')) {
                    location = location.replace(/https?:\/\/market\.csgo\.com/, baseUrl);
                } else if (location.startsWith('/')) {
                    location = baseUrl + location;
                }
                console.log(`↪️ Redirect: ${location}`);
                return res.redirect(response.status, location);
            }
        }
        
        // Сохраняем cookies из ответа
        if (response.headers['set-cookie']) {
            const newCookies = parseSetCookieHeaders(response.headers['set-cookie']);
            newCookies.forEach((value, name) => {
                session.cookies.set(name, value);
            });
        }
        
        // Модификация контента
        let content = response.data;
        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('text/') || contentType.includes('application/javascript') || contentType.includes('application/json')) {
            content = Buffer.from(modifyUrls(content.toString('utf8'), baseUrl, contentType), 'utf8');
        }
        
        // Подготовка заголовков ответа
        const responseHeaders = { ...response.headers };
        
        // Удаляем небезопасные заголовки
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['x-content-type-options'];
        delete responseHeaders['strict-transport-security'];
        delete responseHeaders['permissions-policy'];
        delete responseHeaders['cross-origin-opener-policy'];
        delete responseHeaders['cross-origin-embedder-policy'];
        
        // Модификация set-cookie
        if (responseHeaders['set-cookie']) {
            responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(cookie => {
                return cookie
                    .replace(/domain=.*?(;|$)/gi, '')
                    .replace(/secure;/gi, '')
                    .replace(/samesite=none/gi, 'samesite=lax');
            });
        }
        
        // Устанавливаем заголовки
        Object.entries(responseHeaders).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
                res.set(key, value);
            }
        });
        
        res.set('content-length', content.length);
        res.status(response.status);
        res.send(content);
        
    } catch (error) {
        console.error('❌ Proxy error:', error.message);
        res.status(500).json({ 
            error: 'Proxy Error', 
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Запуск сервера
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Advanced Market Proxy Server
    📡 Port: ${PORT}
    🎯 Target: ${TARGET_HOST}
    🔌 WebSocket: ${WS_TARGET}
    
    Features:
    ✓ Full HTTP/HTTPS proxy
    ✓ WebSocket support
    ✓ Cookie management
    ✓ CORS handling
    ✓ URL rewriting
    ✓ Content modification
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
