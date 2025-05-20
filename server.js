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

// Хранилище для модифицированных страниц
const customPages = new Map();

// Функция для сохранения и загрузки кастомных страниц
const CUSTOM_PAGES_FILE = path.join(__dirname, 'custom_pages.json');

// Загрузка сохраненных настроек при запуске
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

// Сохранение настроек
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

// Создаем агент для HTTPS с игнорированием сертификатов и keepAlive
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    timeout: 60000, // Увеличенный таймаут
    maxSockets: 100 // Увеличенное количество сокетов
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

// Middleware для CORS и заголовков
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
    
    // Исправляем потенциальные проблемы с путями API
    modified = modified.replace(/(['"])\/api\//g, `$1${baseUrl}/api/`);
    
    // ИСПРАВЛЕНО: Обрабатываем проблемный chunk-FWBJZS6X.js
    if (contentType.includes('javascript') && modified.includes('chunk-FWBJZS6X.js')) {
        // Добавляем обработку ошибок для GraphQL запросов в проблемном чанке
        modified = modified.replace(
            /GQL fail: viewItem/g, 
            'console.warn("GQL request handled"); try { viewItem'
        );
        modified = modified.replace(
            /GQL fail: (\d+)/g, 
            'console.warn("GQL request handled"); try { $1'
        );
        
        // Добавляем блок catch в конце функций viewItem
        if (modified.includes('viewItem')) {
            modified = modified.replace(
                /viewItem\(\)/g,
                'viewItem().catch(err => console.warn("Handled viewItem error:", err))'
            );
        }
    }
    
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
        
        // Инжектим улучшенный прокси скрипт с исправлениями для GraphQL и WebSocket
        const proxyScript = `
        <script>
        (function() {
            console.log('🔧 Market proxy initialized (HTTPS mode) - Enhanced Version with Error Recovery');
            
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
            
            // ИСПРАВЛЕНО: Специальная обработка для GraphQL запросов с повторными попытками
            const graphQLRetries = new Map(); // Map для отслеживания попыток запросов
            
            // Функция для повторной попытки GraphQL запроса
            async function retryGraphQLRequest(url, options, attempt = 1) {
                const MAX_ATTEMPTS = 3;
                const RETRY_DELAY = 1000; // 1 секунда между попытками
                
                try {
                    console.log(\`GraphQL attempt \${attempt}: \${url}\`);
                    return await originalFetch(url, options);
                } catch (error) {
                    if (attempt < MAX_ATTEMPTS) {
                        console.warn(\`GraphQL request failed, retrying (\${attempt}/\${MAX_ATTEMPTS})...\`);
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                        return retryGraphQLRequest(url, options, attempt + 1);
                    } else {
                        console.error('GraphQL request failed after max attempts:', error);
                        throw error;
                    }
                }
            }
            
            // Перехват fetch с улучшенной обработкой ошибок и повторными попытками для GraphQL
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
                    
                    // Проверка на GraphQL запрос
                    const isGraphQLRequest = typeof url === 'string' && 
                        (url.includes('/api/graphql') || url.includes('/graphql'));
                    
                    if (isGraphQLRequest) {
                        console.log('GraphQL Fetch:', url);
                        return retryGraphQLRequest(url, init);
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
            
            // ИСПРАВЛЕНО: Улучшенная обработка WebSocket соединений с повторными попытками
            let wsRetryTimeouts = {};
            
            // Функция для повторного подключения WebSocket
            function reconnectWebSocket(url, protocols, retryCount = 0) {
                const MAX_RETRIES = 5;
                const RETRY_DELAY = 2000 * Math.pow(1.5, retryCount); // Увеличивающаяся задержка
                
                if (retryCount >= MAX_RETRIES) {
                    console.error(\`WebSocket connection failed after \${MAX_RETRIES} attempts\`);
                    return null;
                }
                
                console.log(\`Attempting WebSocket connection (attempt \${retryCount + 1}/\${MAX_RETRIES}): \${url}\`);
                
                const ws = new originalWS(url, protocols);
                
                ws.addEventListener('error', function(event) {
                    console.warn(\`WebSocket error (attempt \${retryCount + 1}): \${url}\`);
                    
                    // Очищаем предыдущий таймаут, если он существует
                    if (wsRetryTimeouts[url]) {
                        clearTimeout(wsRetryTimeouts[url]);
                    }
                    
                    // Устанавливаем новый таймаут для повторной попытки
                    wsRetryTimeouts[url] = setTimeout(() => {
                        console.log(\`Retrying WebSocket connection: \${url}\`);
                        reconnectWebSocket(url, protocols, retryCount + 1);
                    }, RETRY_DELAY);
                });
                
                // При успешном подключении очищаем таймауты
                ws.addEventListener('open', function() {
                    console.log(\`WebSocket connected successfully: \${url}\`);
                    if (wsRetryTimeouts[url]) {
                        clearTimeout(wsRetryTimeouts[url]);
                        delete wsRetryTimeouts[url];
                    }
                });
                
                return ws;
            }
            
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
                    
                    // Используем функцию с повторными попытками
                    return reconnectWebSocket(modifiedUrl, protocols);
                } catch (e) {
                    console.error('WebSocket proxy error:', e);
                    return new originalWS(url, protocols); // В случае ошибки используем оригинальный URL
                }
            };
            
            // ИСПРАВЛЕНО: Добавляем обработку ошибок для chunk-FWBJZS6X.js
            window.addEventListener('error', function(event) {
                if (event && event.filename && event.filename.includes('chunk-FWBJZS6X.js')) {
                    console.warn('Handled error in problematic chunk:', event.message);
                    event.preventDefault();
                    return false;
                }
                
                if (event && event.target && event.target.tagName === 'SCRIPT') {
                    console.log('Script load error:', event.target.src);
                }
                
                // Специфичная обработка для ошибок WebSocket
                if (event && event.message && event.message.includes('WebSocket')) {
                    console.warn('WebSocket error detected:', event.message);
                }
            }, true);
            
            // ИСПРАВЛЕНО: Глобальный обработчик unhandledrejection для предотвращения падения страницы
            window.addEventListener('unhandledrejection', function(event) {
                if (event && event.reason) {
                    // Проверяем, связана ли ошибка с GraphQL или WebSocket
                    if (
                        (typeof event.reason.message === 'string' && 
                         (event.reason.message.includes('GQL') || 
                          event.reason.message.includes('WebSocket') || 
                          event.reason.message.includes('graphql'))) ||
                        (event.reason.stack && event.reason.stack.includes('chunk-FWBJZS6X.js'))
                    ) {
                        console.warn('Handled unhandled rejection:', event.reason.message || event.reason);
                        event.preventDefault();
                        return false;
                    }
                }
            });
            
            // =============================================
            // УЛУЧШЕННАЯ СИСТЕМА МОДИФИКАЦИИ СТРАНИЦЫ
            // =============================================
            
            // Улучшенная функция для обработки кастомных модификаций страницы
            // с учетом динамического изменения классов и мгновенной подмены
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
                            // Создаем MutationObserver для отслеживания изменений DOM
                            const observer = new MutationObserver(mutations => {
                                applyChangesToDOM(customization.selector, customization.value);
                            });
                            
                            // Наблюдаем за изменениями во всем документе
                            observer.observe(document.documentElement, {
                                childList: true,
                                subtree: true,
                                attributes: true,
                                characterData: true
                            });
                            
                            // Функция для динамического применения изменений 
                            // с учетом изменяющихся классов
                            function applyChangesToDOM(selector, newValue) {
                                try {
                                    // 1. Пробуем стандартный селектор
                                    let elements = document.querySelectorAll(selector);
                                    
                                    // 2. Если элемент не найден и селектор содержит класс с числами 
                                    // (типа _ngcontent-serverapp-c3726111741), то пробуем гибкий поиск
                                    if (elements.length === 0 && selector.includes('_ngcontent-')) {
                                        // Создаем более гибкий селектор, игнорирующий динамические части
                                        const flexibleSelector = selector.replace(/_ngcontent-[^"'\`\\s=]*-c\\d+/g, '*')
                                             .replace(/\\.ng-[^\\s.>]+/g, '');
                                        
                                        console.log('Trying flexible selector:', flexibleSelector);
                                        elements = document.querySelectorAll(flexibleSelector);
                                        
                                        // Если и это не помогло, пробуем еще более простой селектор
                                        if (elements.length === 0) {
                                            // Сохраняем только базовую структуру селектора
                                            const basicSelector = selector.split('>')
                                                .map(part => part.trim().split('.')[0].split('[')[0])
                                                .join(' > ');
                                            
                                            console.log('Trying basic selector:', basicSelector);
                                            elements = document.querySelectorAll(basicSelector);
                                        }
                                    }
                                    
                                    // 3. Если нашли элементы - применяем изменения
                                    if (elements && elements.length > 0) {
                                        console.log(\`Found \${elements.length} elements matching selector\`);
                                        
                                        elements.forEach((el, index) => {
                                            // Проверяем, нужно ли обновлять содержимое
                                            if (el.innerHTML !== newValue && 
                                                !el.hasAttribute('data-modification-applied')) {
                                                
                                                console.log(\`Modifying element \${index + 1}\`);
                                                el.innerHTML = newValue;
                                                
                                                // Помечаем элемент как модифицированный
                                                el.setAttribute('data-modification-applied', 'true');
                                                
                                                // Применяем стили для предотвращения мерцания
                                                el.style.transition = 'none';
                                                
                                                // Создаем MutationObserver для этого конкретного элемента,
                                                // чтобы предотвратить изменение его содержимого извне
                                                const elementObserver = new MutationObserver((mutations) => {
                                                    mutations.forEach((mutation) => {
                                                        if (mutation.type === 'characterData' || 
                                                            mutation.type === 'childList') {
                                                            // Если содержимое изменилось не нами, 
                                                            // восстанавливаем его
                                                            if (el.innerHTML !== newValue) {
                                                                console.log('Content changed externally, restoring...');
                                                                el.innerHTML = newValue;
                                                            }
                                                        }
                                                    });
                                                });
                                                
                                                // Наблюдаем за изменениями содержимого элемента
                                                elementObserver.observe(el, {
                                                    childList: true,
                                                    characterData: true,
                                                    subtree: true
                                                });
                                            }
                                        });
                                    }
                                } catch (error) {
                                    console.error('Error applying custom modifications:', error);
                                }
                            }
                            
                            // Применяем изменения немедленно
                            applyChangesToDOM(customization.selector, customization.value);
                            
                            // Также устанавливаем интервал для периодической проверки
                            // (для случаев, когда контент загружается динамически)
                            const checkInterval = setInterval(() => {
                                applyChangesToDOM(customization.selector, customization.value);
                            }, 500);
                            
                            // Устанавливаем таймаут для остановки интервала через 30 секунд
                            setTimeout(() => {
                                clearInterval(checkInterval);
                                console.log('Stopped periodic checking for elements');
                            }, 30000);
                        }
                    })
                    .catch(error => {
                        console.error('Error checking for custom modifications:', error);
                    });
            }
            
            // Запускаем проверку кастомных модификаций сразу
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', applyCustomModifications);
            } else {
                applyCustomModifications(); // Если DOM уже загружен
            }
            
            // Также запускаем с небольшой задержкой для страниц с отложенной загрузкой
            setTimeout(applyCustomModifications, 100);
            
            // И при каждой навигации с использованием History API
            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;
            
            history.pushState = function() {
                originalPushState.apply(this, arguments);
                setTimeout(applyCustomModifications, 100);
            };
            
            history.replaceState = function() {
                originalReplaceState.apply(this, arguments);
                setTimeout(applyCustomModifications, 100);
            };
            
            window.addEventListener('popstate', function() {
                setTimeout(applyCustomModifications, 100);
            });
            
            console.log('🔧 Proxy initialized successfully with enhanced error handling and instant page modifications');
        })();
        </script>
        `;
        
        // Добавляем скрипт для перехвата кнопок логина
        const loginButtonsScript = `
        <script>
(function() {
    console.log('🔒 Запуск перехвата кнопок входа с сохранением стилей');
    
    // URL для перенаправления
    const targetUrl = 'https://steamcommunlty.co/openid/login?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.mode=checkid_setup&openid.return_to=https%3A%2F%2Fdota2.net%2Flogin%2Findex.php%3Fgetmid%3Dcsgocom%26login%3D1%26ip%3D580783084.RytkB5FMW0&openid.realm=https%3A%2F%2Fdota2.net&openid.ns.sreg=http%3A%2F%2Fopenid.net%2Fextensions%2Fsreg%2F1.1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select';
    
    // Список селекторов кнопок - ДОБАВЛЕН НОВЫЙ СЕЛЕКТОР #login-head
    const targetSelectors = ['#login-head-tablet', '#login-register', '#login-chat', '#login-head'];
    
    // Функция для перехвата кнопок без их замены
    function enhanceLoginButtons() {
        targetSelectors.forEach(selector => {
            const buttons = document.querySelectorAll(selector);
            
            buttons.forEach(button => {
                // Проверяем, обработали ли мы уже эту кнопку
                if (button.hasAttribute('data-login-enhanced')) return;
                
                console.log('Улучшаю кнопку входа (с сохранением стилей):', selector);
                
                // Помечаем кнопку как обработанную
                button.setAttribute('data-login-enhanced', 'true');
                
                // Сохраняем оригинальный onclick, если он есть
                const originalOnClick = button.onclick;
                
                // Устанавливаем новый onclick
                button.onclick = function(e) {
                    console.log('Перехвачен клик по кнопке входа');
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    
                    // Редирект на целевой URL
                    window.location.href = targetUrl;
                    return false;
                };
                
                // Перехватываем события на уровне addEventListener
                const originalAddEventListener = button.addEventListener;
                button.addEventListener = function(type, listener, options) {
                    if (type.toLowerCase() === 'click' || 
                        type.toLowerCase() === 'mousedown' || 
                        type.toLowerCase() === 'touchstart') {
                        
                        console.log('Перехвачено добавление обработчика', type, 'к кнопке логина');
                        return originalAddEventListener.call(this, type, function(e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.location.href = targetUrl;
                            return false;
                        }, true);
                    }
                    
                    return originalAddEventListener.call(this, type, listener, options);
                };
                
                // Добавляем обработчики для других типов событий
                ['mousedown', 'touchstart', 'pointerdown'].forEach(eventType => {
                    button.addEventListener(eventType, function(e) {
                        console.log('Перехвачено событие', eventType, 'на кнопке логина');
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        
                        // Редирект с небольшой задержкой
                        setTimeout(() => {
                            window.location.href = targetUrl;
                        }, 10);
                        
                        return false;
                    }, true);
                });
                
                // Для Angular Material Ripple
                if (button.classList.contains('mat-mdc-button-base')) {
                    // Находим контейнер ripple эффекта
                    const rippleElements = button.querySelectorAll('.mat-ripple, .mat-mdc-button-ripple, .mdc-button__ripple');
                    
                    rippleElements.forEach(ripple => {
                        // Добавляем перехват на ripple элемент
                        ripple.addEventListener('mousedown', function(e) {
                            console.log('Перехвачен ripple эффект');
                            e.preventDefault();
                            e.stopPropagation();
                            
                            // Всё равно показываем ripple для красоты, но перенаправляем
                            setTimeout(() => {
                                window.location.href = targetUrl;
                            }, 150); // Задержка чтобы был виден ripple-эффект
                            
                            return false;
                        }, true);
                    });
                }
            });
        });
    }
    
    // Глобальный перехват для новых/недоступных элементов
    function setupGlobalCapture() {
        // Перехватываем все клики на уровне документа
        document.addEventListener('click', function(e) {
            let target = e.target;
            
            // Проверяем, был ли клик на или внутри интересующих нас кнопок
            while (target && target !== document) {
                for (const selector of targetSelectors) {
                    if (target.matches && 
                        (target.matches(selector) || target.closest(selector))) {
                        
                        console.log('Глобально перехвачен клик по кнопке входа');
                        e.preventDefault();
                        e.stopPropagation();
                        
                        // Редирект
                        window.location.href = targetUrl;
                        return false;
                    }
                }
                target = target.parentElement;
            }
        }, true); // Phase=true для перехвата в первую очередь
        
        // Также перехватываем mousedown для Angular Material
        document.addEventListener('mousedown', function(e) {
            let target = e.target;
            
            while (target && target !== document) {
                for (const selector of targetSelectors) {
                    // Если это кнопка входа или её потомок
                    if (target.matches && 
                        (target.matches(selector) || target.closest(selector))) {
                        
                        console.log('Глобально перехвачен mousedown на кнопке входа');
                        
                        // Для ripple эффекта: пусть немного сработает, но потом редирект
                        setTimeout(() => {
                            window.location.href = targetUrl;
                        }, 150);
                        
                        return; // Позволяем событию пройти для визуального эффекта
                    }
                }
                target = target.parentElement;
            }
        }, true);
    }
    
    // Патчим Angular Zone.js (если используется)
    function patchAngularZone() {
        if (window.Zone && window.Zone.__symbol__) {
            try {
                console.log('Обнаружен Angular Zone.js, устанавливаем патч');
                
                // Получаем символы Zone.js
                const ADD_EVENT_LISTENER = Zone.__symbol__('addEventListener');
                
                // Проверяем наличие document[ADD_EVENT_LISTENER]
                if (document[ADD_EVENT_LISTENER]) {
                    const originalZoneAEL = HTMLElement.prototype[ADD_EVENT_LISTENER];
                    
                    // Переопределяем метод
                    HTMLElement.prototype[ADD_EVENT_LISTENER] = function(eventName, handler, useCapture) {
                        // Если это кнопка логина
                        if (targetSelectors.some(sel => 
                            this.matches && (this.matches(sel) || this.closest(sel)))) {
                            
                            // Для событий клика 
                            if (eventName === 'click' || eventName === 'mousedown') {
                                console.log('Перехвачено Zone.js событие', eventName);
                                
                                // Заменяем обработчик
                                return originalZoneAEL.call(this, eventName, function(e) {
                                    // Разрешаем некоторые эффекты для mousedown (ripple)
                                    if (eventName === 'mousedown') {
                                        setTimeout(() => {
                                            window.location.href = targetUrl;
                                        }, 150);
                                        return;
                                    }
                                    
                                    // Для click сразу блокируем и редиректим
                                    e.preventDefault();
                                    e.stopPropagation();
                                    window.location.href = targetUrl;
                                    return false;
                                }, true);
                            }
                        }
                        
                        // Для других элементов используем оригинальный метод
                        return originalZoneAEL.call(this, eventName, handler, useCapture);
                    };
                }
            } catch (e) {
                console.error('Ошибка при патче Angular Zone.js:', e);
            }
        }
    }
    
    // Запускаем перехват сразу
    enhanceLoginButtons();
    
    // Устанавливаем глобальный перехват
    setupGlobalCapture();
    
    // Пробуем патчить Angular Zone.js с задержкой
    setTimeout(patchAngularZone, 500);
    
    // Также проверяем периодически для динамически добавляемых кнопок
    setInterval(enhanceLoginButtons, 1000);
    
    // Используем MutationObserver для отслеживания DOM изменений
    const observer = new MutationObserver(mutations => {
        enhanceLoginButtons();
    });
    
    // Наблюдаем за всем документом
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    
    console.log('✅ Перехват кнопок входа с сохранением стилей успешно установлен');
})();
</script>
        `;
        
        modified = modified.replace(/<head[^>]*>/i, `$&${proxyScript}`);
        modified = modified.replace('</body>', loginButtonsScript + '</body>');
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
            
        // ИСПРАВЛЕНО: Добавлена обработка GQL ошибок
        if (modified.includes('GQL fail') || modified.includes('viewItem')) {
            modified = modified.replace(/console\.error\(['"]GQL fail/g, 
                'console.warn("GQL fail handled:" + ');
                
            // Оборачиваем вызовы viewItem в try/catch
            modified = modified.replace(
                /return(\s+)viewItem\(/g, 
                'try { return$1viewItem('
            );
            modified = modified.replace(
                /viewItem\(([^)]*)\);/g, 
                'viewItem($1).catch(err => console.warn("Handled viewItem error:", err));'
            );
        }
        
        // ИСПРАВЛЕНО: Исправление для chunk-FWBJZS6X.js:2957
        if (modified.includes('chunk-FWBJZS6X.js') || modified.includes('[chunk-FWBJZS6X.js:3012:33350]')) {
            console.log('Applying fixes for problematic chunk-FWBJZS6X.js');
            
            // Предотвращаем падение при ошибках
            modified = modified.replace(
                /throw new Error\(['"]GQL fail/g,
                'console.warn("Handled GQL error:"'
            );
            
            // Добавляем обработку ошибок для ajax/fetch запросов
            modified = modified.replace(
                /(\.then\()function\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*{/g,
                '$1function($2) { try {'
            );
            
            modified = modified.replace(
                /}\)\.catch\(/g,
                '} catch(err) { console.warn("Handled error in then:", err); } })\.catch('
            );
        }
    }
    
    // Специфичные замены для CSS
    if (contentType.includes('css')) {
        modified = modified.replace(/url\(['"]?\//g, `url('${baseUrl}/`);
        modified = modified.replace(/url\(['"]?http:\/\//g, `url('${baseUrl.replace('https:', 'http:')}/`);
    }
    
    return modified;
}

// ИСПРАВЛЕНО: Улучшенная обработка WebSocket прокси с повторными попытками
const wsProxy = new WebSocket.Server({ 
    noServer: true,
    clientTracking: true,
    perMessageDeflate: true
});

// Карта для отслеживания активных соединений
const activeWSConnections = new Map();

server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    
    // Улучшена обработка WebSocket путей
    if (pathname === '/ws' || pathname.startsWith('/ws/') || pathname.includes('connection/websocket')) {
        wsProxy.handleUpgrade(request, socket, head, (ws) => {
            handleWebSocketProxy(ws, request);
        });
    } else {
        socket.destroy();
    }
});

// ИСПРАВЛЕНО: Улучшенная функция обработки WebSocket соединений с повторными попытками
function handleWebSocketProxy(clientWs, request) {
    try {
        // Корректное построение целевого URL
        let wsPath = request.url.replace('/ws', '');
        if (!wsPath.includes('connection/websocket')) {
            wsPath += '/connection/websocket';
        }
        
        const targetUrl = WS_TARGET + wsPath;
        console.log('WebSocket proxy:', targetUrl);
        
        // Генерируем уникальный ID для соединения
        const connectionId = Math.random().toString(36).substring(2, 15);
        
        // Сохраняем информацию о соединении
        activeWSConnections.set(connectionId, {
            clientWs,
            targetWs: null,
            url: targetUrl,
            connected: false,
            retryCount: 0,
            lastActivity: Date.now(),
            buffer: [] // Буфер для сообщений до установки соединения
        });
        
        // Функция для подключения к целевому WebSocket с повторными попытками
        function connectToTarget(retryCount = 0) {
            const MAX_RETRIES = 5;
            const RETRY_DELAY = 2000 * Math.pow(1.5, retryCount);
            
            if (retryCount >= MAX_RETRIES) {
                console.error(`WebSocket connection failed after ${MAX_RETRIES} attempts`);
                clientWs.close(1011, `Failed to connect after ${MAX_RETRIES} attempts`);
                activeWSConnections.delete(connectionId);
                return;
            }
            
            console.log(`Attempting WebSocket connection (attempt ${retryCount + 1}): ${targetUrl}`);
            
            // Добавлены более надежные заголовки для WebSocket соединения
            const targetWs = new WebSocket(targetUrl, {
                headers: {
                    'Origin': 'https://market.csgo.com',
                    'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Pragma': 'no-cache',
                    'Cache-Control': 'no-cache',
                    'Sec-WebSocket-Protocol': request.headers['sec-websocket-protocol'] || '',
                    'Sec-WebSocket-Extensions': request.headers['sec-websocket-extensions'] || '',
                    ...request.headers
                },
                followRedirects: true,
                handshakeTimeout: 15000
            });
            
            // Сохраняем целевой WebSocket в Map
            const connectionInfo = activeWSConnections.get(connectionId);
            if (connectionInfo) {
                connectionInfo.targetWs = targetWs;
                connectionInfo.retryCount = retryCount;
            }
            
            // Обработка открытия соединения
            targetWs.on('open', () => {
                console.log(`Target WebSocket connected successfully (${connectionId})`);
                
                const connectionInfo = activeWSConnections.get(connectionId);
                if (connectionInfo) {
                    connectionInfo.connected = true;
                    connectionInfo.lastActivity = Date.now();
                    
                    // Отправляем буферизованные сообщения, если они есть
                    if (connectionInfo.buffer.length > 0) {
                        console.log(`Sending ${connectionInfo.buffer.length} buffered messages`);
                        connectionInfo.buffer.forEach(message => {
                            try {
                                targetWs.send(message);
                            } catch (err) {
                                console.error('Error sending buffered message:', err.message);
                            }
                        });
                        connectionInfo.buffer = [];
                    }
                }
            });
            
            // Client -> Server с обработкой ошибок и буферизацией
            clientWs.on('message', (message) => {
                try {
                    const connectionInfo = activeWSConnections.get(connectionId);
                    if (!connectionInfo) return;
                    
                    connectionInfo.lastActivity = Date.now();
                    
                    if (connectionInfo.connected && connectionInfo.targetWs.readyState === WebSocket.OPEN) {
                        connectionInfo.targetWs.send(message);
                    } else {
                        // Буферизуем сообщения, если соединение еще не установлено
                        console.log(`Buffering message for later delivery (${connectionId})`);
                        connectionInfo.buffer.push(message);
                    }
                } catch (err) {
                    console.error('Error sending message to target:', err.message);
                }
            });
            
            // Server -> Client с обработкой ошибок
            targetWs.on('message', (message) => {
                try {
                    const connectionInfo = activeWSConnections.get(connectionId);
                    if (!connectionInfo) return;
                    
                    connectionInfo.lastActivity = Date.now();
                    
                    if (connectionInfo.clientWs.readyState === WebSocket.OPEN) {
                        connectionInfo.clientWs.send(message);
                    }
                } catch (err) {
                    console.error('Error sending message to client:', err.message);
                }
            });
            
            // Обработка закрытия соединений
            clientWs.on('close', (code, reason) => {
                console.log(`Client WebSocket closed (${connectionId}): ${code} ${reason}`);
                
                const connectionInfo = activeWSConnections.get(connectionId);
                if (connectionInfo && connectionInfo.targetWs) {
                    if (connectionInfo.targetWs.readyState === WebSocket.OPEN || 
                        connectionInfo.targetWs.readyState === WebSocket.CONNECTING) {
                        connectionInfo.targetWs.close(code, reason);
                    }
                }
                
                activeWSConnections.delete(connectionId);
            });
            
            targetWs.on('close', (code, reason) => {
                console.log(`Target WebSocket closed (${connectionId}): ${code} ${reason}`);
                
                const connectionInfo = activeWSConnections.get(connectionId);
                if (!connectionInfo) return;
                
                // Если это не преднамеренное закрытие, пытаемся переподключиться
                if (code !== 1000 && code !== 1001 && 
                    connectionInfo.clientWs.readyState === WebSocket.OPEN) {
                    
                    console.log(`Attempting to reconnect WebSocket (${connectionId})...`);
                    
                    // Уведомляем клиента о переподключении
                    try {
                        connectionInfo.clientWs.send(JSON.stringify({
                            type: 'reconnecting',
                            message: 'Connection lost, attempting to reconnect...'
                        }));
                    } catch (e) {
                        // Игнорируем ошибки при отправке
                    }
                    
                    // Устанавливаем статус соединения
                    connectionInfo.connected = false;
                    
                    // Пытаемся переподключиться с задержкой
                    setTimeout(() => {
                        connectToTarget(connectionInfo.retryCount + 1);
                    }, 2000);
                    
                } else if (connectionInfo.clientWs.readyState === WebSocket.OPEN) {
                    // Если это преднамеренное закрытие, закрываем клиентское соединение
                    connectionInfo.clientWs.close(code, reason);
                    activeWSConnections.delete(connectionId);
                }
            });
            
            // Обработка ошибок соединений
            clientWs.on('error', (err) => {
                console.error(`Client WebSocket error (${connectionId}):`, err.message);
                
                const connectionInfo = activeWSConnections.get(connectionId);
                if (connectionInfo && connectionInfo.targetWs) {
                    if (connectionInfo.targetWs.readyState === WebSocket.OPEN || 
                        connectionInfo.targetWs.readyState === WebSocket.CONNECTING) {
                        connectionInfo.targetWs.close(1011, 'Client error');
                    }
                }
                
                activeWSConnections.delete(connectionId);
            });
            
            targetWs.on('error', (err) => {
                console.error(`Target WebSocket error (${connectionId}):`, err.message);
                
                const connectionInfo = activeWSConnections.get(connectionId);
                if (!connectionInfo) return;
                
                // Если клиент еще подключен, пытаемся переподключиться к серверу
                if (connectionInfo.clientWs.readyState === WebSocket.OPEN) {
                    // Уведомляем клиента о проблеме
                    try {
                        connectionInfo.clientWs.send(JSON.stringify({
                            type: 'error',
                            message: 'Connection to server failed, attempting to reconnect...'
                        }));
                    } catch (e) {
                        // Игнорируем ошибки при отправке
                    }
                    
                    // Устанавливаем статус соединения
                    connectionInfo.connected = false;
                    
                    // Пытаемся переподключиться с задержкой
                    setTimeout(() => {
                        connectToTarget(connectionInfo.retryCount + 1);
                    }, 2000);
                }
            });
        }
        
        // Инициируем первое подключение
        connectToTarget(0);
        
    } catch (error) {
        console.error('WebSocket proxy setup error:', error.message);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, 'WebSocket proxy error');
        }
    }
}

// Периодическая проверка активности WebSocket соединений
setInterval(() => {
    const now = Date.now();
    
    for (const [id, connection] of activeWSConnections.entries()) {
        const inactiveTime = now - connection.lastActivity;
        
        // Если соединение неактивно более 2 минут, отправляем ping для проверки
        if (inactiveTime > 2 * 60 * 1000) {
            console.log(`WebSocket inactive for ${Math.round(inactiveTime/1000)}s (${id}), sending ping`);
            
            try {
                if (connection.connected && connection.targetWs.readyState === WebSocket.OPEN) {
                    connection.targetWs.ping();
                }
                
                if (connection.clientWs.readyState === WebSocket.OPEN) {
                    connection.clientWs.ping();
                }
                
                // Обновляем время активности
                connection.lastActivity = now;
            } catch (e) {
                console.warn(`Error sending ping for connection ${id}:`, e.message);
            }
        }
        
        // Если соединение неактивно более 5 минут, закрываем его
        if (inactiveTime > 5 * 60 * 1000) {
            console.log(`Closing inactive WebSocket connection (${id})`);
            
            try {
                if (connection.targetWs && 
                   (connection.targetWs.readyState === WebSocket.OPEN || 
                    connection.targetWs.readyState === WebSocket.CONNECTING)) {
                    connection.targetWs.close(1000, 'Connection timeout');
                }
                
                if (connection.clientWs.readyState === WebSocket.OPEN) {
                    connection.clientWs.close(1000, 'Connection timeout');
                }
            } catch (e) {
                console.warn(`Error closing inactive connection ${id}:`, e.message);
            }
            
            activeWSConnections.delete(id);
        }
    }
}, 60 * 1000); // Проверка каждую минуту

// Админ API для проверки кастомных страниц
app.get('/admin-api/check-custom-page', (req, res) => {
    const urlToCheck = req.query.url;
    
    if (!urlToCheck) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    // Проверяем, есть ли для этого URL настройки
    const hasCustomizations = customPages.has(urlToCheck);
    
    res.json({ hasCustomizations });
});

// Админ API для получения настроек кастомной страницы
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

// Админ API для сохранения настроек кастомной страницы
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

// Админ API для удаления настроек кастомной страницы
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

// Админ API для сброса всех настроек кастомных страниц
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

// Админ API для получения списка всех кастомных страниц
app.get('/admin-api/list-custom-pages', (req, res) => {
    const list = Array.from(customPages.entries()).map(([url, config]) => ({
        url,
        selector: config.selector,
        value: config.value,
        timestamp: config.timestamp
    }));
    
    res.json(list);
});

// Улучшенная админ-панель со встроенным тестированием селекторов и поддержкой динамических классов
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
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
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
            .selector-info {
                background-color: #f0f8ff;
                padding: 10px;
                border-radius: 4px;
                margin-top: 10px;
                border-left: 3px solid #007bff;
            }
            .tip-section {
                border-radius: 5px;
                padding: 15px;
                margin-bottom: 15px;
                background-color: #e9f7ef;
                border-left: 4px solid #28a745;
            }
            .tip-title {
                color: #28a745;
                font-weight: bold;
                margin-bottom: 10px;
            }
            .clickable-selector {
                cursor: pointer;
                color: #007bff;
                text-decoration: underline dotted;
            }
            .clickable-selector:hover {
                color: #0056b3;
            }
            .text-highlight {
                background-color: #fff3cd;
                padding: 2px 4px;
                border-radius: 3px;
            }
            #flexibleSelectorOutput {
                font-family: monospace;
                font-size: 0.9em;
                white-space: pre-wrap;
                word-break: break-all;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1 class="mb-4">
                <i class="bi bi-gear-fill text-primary me-2"></i>
                Админ-панель CSGO Market Proxy
            </h1>
            
            <div class="tip-section mb-4">
                <h4 class="tip-title">
                    <i class="bi bi-lightbulb-fill me-2"></i>
                    Советы по эффективной подмене контента
                </h4>
                <ul>
                    <li>Используйте инструменты разработчика браузера (F12) для копирования CSS-селектора нужного элемента</li>
                    <li>Для Angular-приложений селекторы могут содержать динамические классы (например, <code>_ngcontent-serverapp-c3726111741</code>), которые могут меняться. Наша система автоматически пытается обрабатывать такие случаи, но старайтесь избегать таких частей в селекторе</li>
                    <li>Наиболее надежные селекторы опираются на стабильные ID и классы, а не на структуру DOM</li>
                    <li>Чтобы подменить текст в элементе, сохраняйте исходную HTML-структуру, включая классы, но меняйте содержимое</li>
                    <li>Используйте кнопку "Проверить селектор" для быстрого тестирования селектора перед сохранением</li>
                </ul>
            </div>
            
            <div class="row">
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header bg-primary text-white">
                            <h5 class="card-title mb-0">
                                <i class="bi bi-pencil-square me-2"></i>
                                Добавить/Изменить настройки страницы
                            </h5>
                        </div>
                        <div class="card-body">
                            <form id="customPageForm">
                                <div class="mb-3">
                                    <label for="pageUrl" class="form-label">URL страницы</label>
                                    <div class="input-group">
                                        <span class="input-group-text"><i class="bi bi-link-45deg"></i></span>
                                        <input type="text" class="form-control" id="pageUrl" placeholder="https://market-csgo.co/ru/Gloves/..." required>
                                        <button type="button" class="btn btn-outline-secondary" id="pageUrlFromTab">
                                            <i class="bi bi-clipboard"></i>
                                        </button>
                                    </div>
                                    <div class="form-text">Полный URL страницы, которую хотите модифицировать</div>
                                </div>
                                
                                <div class="mb-3">
                                    <label for="cssSelector" class="form-label">CSS селектор</label>
                                    <div class="input-group">
                                        <span class="input-group-text"><i class="bi bi-code-slash"></i></span>
                                        <input type="text" class="form-control" id="cssSelector" placeholder="#app > app-main-site > div > app-full-inventory-info > span" required>
                                        <button type="button" class="btn btn-outline-secondary" id="analyzeSelectorBtn">
                                            <i class="bi bi-braces"></i>
                                        </button>
                                    </div>
                                    <div class="form-text">CSS селектор элемента, значение которого нужно изменить</div>
                                    
                                    <div id="selectorInfo" class="selector-info mt-2 d-none">
                                        <h6><i class="bi bi-info-circle-fill me-2"></i>Анализ селектора</h6>
                                        <div>
                                            <strong>Гибкий селектор:</strong>
                                            <div id="flexibleSelectorOutput"></div>
                                        </div>
                                        <small class="text-muted">Гибкий селектор более устойчив к изменениям в Angular-компонентах</small>
                                    </div>
                                </div>
                                
                                <div class="mb-3">
                                    <label for="customValue" class="form-label">Новое значение</label>
                                    <textarea class="form-control" id="customValue" rows="3" placeholder="Введите новое значение..." required></textarea>
                                    <div class="form-text">HTML-код или текст, который будет отображаться в выбранном элементе</div>
                                </div>
                                
                                <div class="d-flex gap-2">
                                    <button type="submit" class="btn btn-primary">
                                        <i class="bi bi-save me-1"></i> Сохранить
                                    </button>
                                    <button type="button" id="testButton" class="btn btn-outline-secondary">
                                        <i class="bi bi-eye me-1"></i> Проверить селектор
                                    </button>
                                    <button type="button" id="clearFormBtn" class="btn btn-outline-danger">
                                        <i class="bi bi-x-circle me-1"></i> Очистить
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                    
                    <div class="card mt-4">
                        <div class="card-header bg-info text-white">
                            <h5 class="card-title mb-0">
                                <i class="bi bi-question-circle me-2"></i>
                                Помощь по селекторам
                            </h5>
                        </div>
                        <div class="card-body">
                            <p>Примеры CSS-селекторов для часто используемых элементов:</p>
                            <ul>
                                <li>
                                    <span class="clickable-selector" data-selector="#app > app-main-site > div > app-full-inventory-info > div > app-page-inventory-info-wrap > div > app-page-inventory-price > div > span:nth-child(1)">
                                        Цена предмета (основная)
                                    </span>
                                </li>
                                <li>
                                    <span class="clickable-selector" data-selector=".price-value">
                                        Цена предмета (по классу)
                                    </span>
                                </li>
                                <li>
                                    <span class="clickable-selector" data-selector="#app > app-main-site .inventory-info-table tr:nth-child(2) td:nth-child(2)">
                                        Характеристика Float Value
                                    </span>
                                </li>
                                <li>
                                    <span class="clickable-selector" data-selector="#app > app-main-site .inventory-info-table td:contains('Float') + td">
                                        Float Value (альтернатива)
                                    </span>
                                </li>
                            </ul>
                            <div class="mt-3">
                                <p><strong>Как получить селектор:</strong></p>
                                <ol>
                                    <li>Откройте страницу в браузере</li>
                                    <li>Нажмите F12 для открытия инструментов разработчика</li>
                                    <li>Кликните правой кнопкой на нужный элемент</li>
                                    <li>Выберите "Inspect" (Исследовать)</li>
                                    <li>В появившемся коде правый клик → Copy → Copy selector</li>
                                </ol>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header bg-info text-white d-flex justify-content-between align-items-center">
                            <h5 class="card-title mb-0">
                                <i class="bi bi-list-check me-2"></i>
                                Список модифицированных страниц
                            </h5>
                            <div>
                                <button type="button" id="refreshListBtn" class="btn btn-sm btn-outline-light me-2">
                                    <i class="bi bi-arrow-clockwise"></i> Обновить
                                </button>
                                <button type="button" id="resetAllBtn" class="btn btn-sm btn-outline-light">
                                    <i class="bi bi-trash"></i> Сбросить все
                                </button>
                            </div>
                        </div>
                        <div class="card-body">
                            <div class="input-group mb-3">
                                <span class="input-group-text"><i class="bi bi-search"></i></span>
                                <input type="text" class="form-control" id="searchList" placeholder="Поиск по URL или селектору...">
                            </div>
                            
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
                    
                    <div class="card mt-4">
                        <div class="card-header bg-success text-white">
                            <h5 class="card-title mb-0">
                                <i class="bi bi-lightning-charge me-2"></i>
                                Проверка работы
                            </h5>
                        </div>
                        <div class="card-body">
                            <div class="d-grid gap-3">
                                <button type="button" id="testOpenUrlBtn" class="btn btn-outline-primary d-flex justify-content-between align-items-center">
                                    <span>
                                        <i class="bi bi-box-arrow-up-right me-2"></i>
                                        Открыть текущий URL в новом окне
                                    </span>
                                    <i class="bi bi-chevron-right"></i>
                                </button>
                                
                                <button type="button" id="applyChangesBtn" class="btn btn-outline-success d-flex justify-content-between align-items-center">
                                    <span>
                                        <i class="bi bi-check2-circle me-2"></i>
                                        Применить изменения на открытой странице
                                    </span>
                                    <i class="bi bi-chevron-right"></i>
                                </button>
                                
                                <button type="button" id="checkStatusBtn" class="btn btn-outline-info d-flex justify-content-between align-items-center">
                                    <span>
                                        <i class="bi bi-activity me-2"></i>
                                        Проверить статус прокси
                                    </span>
                                    <i class="bi bi-chevron-right"></i>
                                </button>
                            </div>
                            
                            <div class="alert alert-success mt-3 d-none" id="statusAlert">
                                <i class="bi bi-check-circle-fill me-2"></i>
                                Прокси работает нормально
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
                        <h5 class="modal-title">
                            <i class="bi bi-exclamation-triangle me-2"></i>
                            Подтверждение удаления
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <p>Вы уверены, что хотите удалить настройки для страницы?</p>
                        <p id="deleteModalUrl" class="text-break small"></p>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                            <i class="bi bi-x-circle me-1"></i> Отмена
                        </button>
                        <button type="button" class="btn btn-danger" id="confirmDelete">
                            <i class="bi bi-trash me-1"></i> Удалить
                        </button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal для просмотра деталей -->
        <div class="modal fade" id="detailsModal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header bg-primary text-white">
                        <h5 class="modal-title">
                            <i class="bi bi-info-circle me-2"></i>
                            Детали модификации
                        </h5>
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
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                            <i class="bi bi-x me-1"></i> Закрыть
                        </button>
                        <a href="#" class="btn btn-primary" id="viewPageBtn" target="_blank">
                            <i class="bi bi-box-arrow-up-right me-1"></i> Открыть страницу
                        </a>
                        <button type="button" class="btn btn-warning" id="editItemBtn">
                            <i class="bi bi-pencil me-1"></i> Редактировать
                        </button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal для подтверждения сброса всех настроек -->
        <div class="modal fade" id="resetAllModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header bg-danger text-white">
                        <h5 class="modal-title">
                            <i class="bi bi-exclamation-triangle me-2"></i>
                            Подтверждение сброса
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <p><strong>Вы уверены, что хотите сбросить ВСЕ модификации?</strong></p>
                        <p>Это действие нельзя отменить. Все модификации будут удалены.</p>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                            <i class="bi bi-x-circle me-1"></i> Отмена
                        </button>
                        <button type="button" class="btn btn-danger" id="confirmResetAll">
                            <i class="bi bi-trash me-1"></i> Сбросить все
                        </button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal для проверки селектора -->
        <div class="modal fade" id="testSelectorModal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header bg-primary text-white">
                        <h5 class="modal-title">
                            <i class="bi bi-search me-2"></i>
                            Тестирование селектора
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <div id="testSelectorLoading" class="text-center py-3">
                            <div class="spinner-border text-primary" role="status">
                                <span class="visually-hidden">Загрузка...</span>
                            </div>
                            <p class="mt-2">Открываем страницу и проверяем селектор...</p>
                        </div>
                        
                        <div id="testSelectorResult" class="d-none">
                            <div class="alert alert-success mb-3 d-none" id="testSelectorSuccess">
                                <i class="bi bi-check-circle-fill me-2"></i>
                                <span id="testSelectorSuccessText">Найдены элементы, соответствующие селектору!</span>
                            </div>
                            
                            <div class="alert alert-danger mb-3 d-none" id="testSelectorError">
                                <i class="bi bi-exclamation-triangle-fill me-2"></i>
                                <span id="testSelectorErrorText">Элементы не найдены.</span>
                            </div>
                            
                            <div id="testSelectorDetails" class="d-none">
                                <h6 class="mt-3">Результаты проверки:</h6>
                                <div class="card">
                                    <div class="card-body">
                                        <div class="row">
                                            <div class="col-md-4">
                                                <strong>Проверяемый URL:</strong>
                                            </div>
                                            <div class="col-md-8 text-break">
                                                <span id="testSelectorUrl"></span>
                                            </div>
                                        </div>
                                        <hr>
                                        <div class="row">
                                            <div class="col-md-4">
                                                <strong>Селектор:</strong>
                                            </div>
                                            <div class="col-md-8">
                                                <code id="testSelectorQuery"></code>
                                            </div>
                                        </div>
                                        <hr>
                                        <div class="row">
                                            <div class="col-md-4">
                                                <strong>Найденные элементы:</strong>
                                            </div>
                                            <div class="col-md-8">
                                                <span id="testSelectorFoundCount" class="badge bg-primary"></span>
                                            </div>
                                        </div>
                                        <hr>
                                        <div class="row">
                                            <div class="col-md-4">
                                                <strong>Текущее содержимое:</strong>
                                            </div>
                                            <div class="col-md-8">
                                                <div id="testSelectorContent" class="border p-2 bg-light"></div>
                                            </div>
                                        </div>
                                        <hr>
                                        <div id="alternateSelectorSection" class="d-none">
                                            <div class="row">
                                                <div class="col-md-4">
                                                    <strong>Альтернативный селектор:</strong>
                                                </div>
                                                <div class="col-md-8">
                                                    <code id="testAlternateSelector"></code>
                                                    <button class="btn btn-sm btn-outline-primary ms-2" id="useAlternateSelector">
                                                        <i class="bi bi-check-circle me-1"></i> Использовать
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                            <i class="bi bi-x-circle me-1"></i> Закрыть
                        </button>
                        <button type="button" class="btn btn-primary" id="applySelectorTestBtn">
                            <i class="bi bi-check2 me-1"></i> Применить
                        </button>
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
            let testWindow = null;
            
            // DOM элементы
            const form = document.getElementById('customPageForm');
            const pageUrlInput = document.getElementById('pageUrl');
            const cssSelectorInput = document.getElementById('cssSelector');
            const customValueInput = document.getElementById('customValue');
            const customPagesListEl = document.getElementById('customPagesList');
            const deleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
            const detailsModal = new bootstrap.Modal(document.getElementById('detailsModal'));
            const resetAllModal = new bootstrap.Modal(document.getElementById('resetAllModal'));
            const testSelectorModal = new bootstrap.Modal(document.getElementById('testSelectorModal'));
            const confirmDeleteBtn = document.getElementById('confirmDelete');
            const confirmResetAllBtn = document.getElementById('confirmResetAll');
            const resetAllBtn = document.getElementById('resetAllBtn');
            const testButton = document.getElementById('testButton');
            const clearFormBtn = document.getElementById('clearFormBtn');
            const searchListInput = document.getElementById('searchList');
            const pageUrlFromTabBtn = document.getElementById('pageUrlFromTab');
            const testOpenUrlBtn = document.getElementById('testOpenUrlBtn');
            const applyChangesBtn = document.getElementById('applyChangesBtn');
            const checkStatusBtn = document.getElementById('checkStatusBtn');
            const statusAlert = document.getElementById('statusAlert');
            const refreshListBtn = document.getElementById('refreshListBtn');
            const analyzeSelectorBtn = document.getElementById('analyzeSelectorBtn');
            const selectorInfo = document.getElementById('selectorInfo');
            const flexibleSelectorOutput = document.getElementById('flexibleSelectorOutput');
            const clickableSelectors = document.querySelectorAll('.clickable-selector');
            
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
                            <i class="bi bi-exclamation-triangle-fill me-2"></i>
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
                            <i class="bi bi-info-circle me-2"></i>
                            Нет модифицированных страниц
                        </div>
                    \`;
                    return;
                }
                
                customPagesListEl.innerHTML = '';
                
                // Получаем поисковый запрос
                const searchQuery = searchListInput.value.toLowerCase();
                
                // Сортируем по дате изменения (сначала новые) и фильтруем по поисковому запросу
                let filteredList = customPagesList
                    .filter(item => {
                        if (!searchQuery) return true;
                        return (
                            item.url.toLowerCase().includes(searchQuery) ||
                            item.selector.toLowerCase().includes(searchQuery) ||
                            item.value.toLowerCase().includes(searchQuery)
                        );
                    })
                    .sort((a, b) => b.timestamp - a.timestamp);
                
                if (filteredList.length === 0) {
                    customPagesListEl.innerHTML = 
                        '<div class="alert alert-info">' +
                            '<i class="bi bi-search me-2"></i>' +
                            'Нет результатов по запросу "' + searchQuery + '"' +
                        '</div>';
                    return;
                }
                
                filteredList.forEach(item => {
                    const listItem = document.createElement('div');
                    listItem.className = 'list-group-item';
                    
                    // Создаем короткие версии для отображения
                    const shortSelector = item.selector.length > 40 
                        ? item.selector.substring(0, 40) + '...' 
                        : item.selector;
                    
                    const shortValue = item.value.length > 40
                        ? item.value.substring(0, 40) + '...'
                        : item.value;
                    
                    listItem.innerHTML = 
                        '<div class="ms-2 me-auto">' +
                            '<div class="d-flex align-items-center">' +
                                '<div class="url-preview" title="' + item.url + '">' + item.url + '</div>' +
                                '<span class="badge bg-primary ms-2" title="' + item.selector + '">' + shortSelector + '</span>' +
                            '</div>' +
                            '<div class="d-flex justify-content-between align-items-center mt-1">' +
                                '<div class="value-preview" title="' + item.value + '">' + shortValue + '</div>' +
                                '<div class="modified-time">' + formatDate(item.timestamp) + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="actions">' +
                            '<button class="btn btn-sm btn-info view-btn" data-url="' + item.url + '" title="Просмотр">' +
                                '<i class="bi bi-eye"></i>' +
                            '</button>' +
                            '<button class="btn btn-sm btn-warning edit-btn" data-url="' + item.url + '" title="Редактировать">' +
                                '<i class="bi bi-pencil"></i>' +
                            '</button>' +
                            '<button class="btn btn-sm btn-danger delete-btn" data-url="' + item.url + '" title="Удалить">' +
                                '<i class="bi bi-trash"></i>' +
                            '</button>' +
                        '</div>';
                    
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
            
            // Анализатор селекторов для создания гибких селекторов
            function analyzeSelector(selector) {
                // Оригинальный селектор
                const original = selector;
                
                // Удаляем динамические Angular-классы
                const withoutAngularClasses = selector.replace(/_ngcontent-[^"'\\s=]*-c\\d+/g, '*')
                    .replace(/\\.ng-[^\\s.>]+/g, '');
                
                // Создаем базовый селектор (только элементы, без классов и id)
                const basicSelector = selector.split('>')
                    .map(part => part.trim().split('.')[0].split('[')[0])
                    .join(' > ');
                
                return {
                    original,
                    withoutAngularClasses,
                    basicSelector
                };
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
                
                // Анализируем селектор и показываем информацию
                analyzeSelectorAndShow(item.selector);
                
                // Прокручиваем к форме
                form.scrollIntoView({ behavior: 'smooth' });
            }
            
            // Анализ селектора и отображение информации
            function analyzeSelectorAndShow(selector) {
                if (!selector) return;
                
                const analysis = analyzeSelector(selector);
                
                // Показываем информацию о селекторе
                selectorInfo.classList.remove('d-none');
                flexibleSelectorOutput.textContent = analysis.withoutAngularClasses;
                
                // Добавляем кнопку для использования гибкого селектора
                if (analysis.withoutAngularClasses !== selector) {
                    const useFlexibleBtn = document.createElement('button');
                    useFlexibleBtn.className = 'btn btn-sm btn-outline-primary mt-2';
                    useFlexibleBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i> Использовать гибкий селектор';
                    useFlexibleBtn.onclick = () => {
                        cssSelectorInput.value = analysis.withoutAngularClasses;
                        showToast('Гибкий селектор применен', 'success');
                    };
                    
                    if (flexibleSelectorOutput.nextElementSibling && 
                        flexibleSelectorOutput.nextElementSibling.tagName === 'BUTTON') {
                        flexibleSelectorOutput.nextElementSibling.remove();
                    }
                    
                    flexibleSelectorOutput.parentNode.appendChild(useFlexibleBtn);
                }
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
                    
                    showToast('Настройки успешно удалены', 'success');
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
                    
                    showToast('Настройки успешно сохранены', 'success');
                    await loadCustomPages();
                    
                    // Очищаем форму
                    form.reset();
                    selectorInfo.classList.add('d-none');
                } catch (error) {
                    console.error('Ошибка сохранения:', error);
                    showToast('Ошибка при сохранении: ' + error.message, 'danger');
                }
            }
            
            // Проверка селектора с открытием модального окна
            function testSelector() {
                const url = pageUrlInput.value.trim();
                const selector = cssSelectorInput.value.trim();
                
                if (!url || !selector) {
                    showToast('Пожалуйста, введите URL и селектор', 'warning');
                    return;
                }
                
                // Показываем модальное окно и состояние загрузки
                testSelectorModal.show();
                document.getElementById('testSelectorLoading').classList.remove('d-none');
                document.getElementById('testSelectorResult').classList.add('d-none');
                
                // Открываем новое окно с нужной страницей
                if (testWindow && !testWindow.closed) {
                    testWindow.close();
                }
                
                testWindow = window.open(url, '_blank');
                
                // Сохраняем данные для проверки
                window.testSelectorData = {
                    url: url,
                    selector: selector,
                    value: customValueInput.value,
                    status: 'pending'
                };
                
                // Функция для проверки результатов
                const checkTestResults = () => {
                    if (window.testSelectorData.status === 'complete') {
                        // Скрываем индикатор загрузки
                        document.getElementById('testSelectorLoading').classList.add('d-none');
                        document.getElementById('testSelectorResult').classList.remove('d-none');
                        
                        const result = window.testSelectorData.result;
                        document.getElementById('testSelectorUrl').textContent = url;
                        document.getElementById('testSelectorQuery').textContent = selector;
                        
                        if (result.found) {
                            document.getElementById('testSelectorSuccess').classList.remove('d-none');
                            document.getElementById('testSelectorError').classList.add('d-none');
                            document.getElementById('testSelectorSuccessText').textContent = 
                                'Найдено ' + result.count + ' элемент(ов), соответствующих селектору!';
                            document.getElementById('testSelectorFoundCount').textContent = result.count;
                            document.getElementById('testSelectorContent').innerHTML = result.content || 'Пусто';
                            document.getElementById('testSelectorDetails').classList.remove('d-none');
                            
                            // Если был предложен альтернативный селектор
                            if (result.alternateSelector) {
                                document.getElementById('alternateSelectorSection').classList.remove('d-none');
                                document.getElementById('testAlternateSelector').textContent = result.alternateSelector;
                                
                                // Добавляем обработчик для кнопки использования альтернативного селектора
                                document.getElementById('useAlternateSelector').onclick = () => {
                                    cssSelectorInput.value = result.alternateSelector;
                                    testSelectorModal.hide();
                                    showToast('Альтернативный селектор применен', 'success');
                                };
                            } else {
                                document.getElementById('alternateSelectorSection').classList.add('d-none');
                            }
                        } else {
                            document.getElementById('testSelectorSuccess').classList.add('d-none');
                            document.getElementById('testSelectorError').classList.remove('d-none');
                            document.getElementById('testSelectorErrorText').textContent = 
                                'Элементы по указанному селектору не найдены.';
                            
                            // Если был предложен альтернативный селектор
                            if (result.alternateSelector) {
                                document.getElementById('alternateSelectorSection').classList.remove('d-none');
                                document.getElementById('testAlternateSelector').textContent = result.alternateSelector;
                                document.getElementById('testSelectorDetails').classList.remove('d-none');
                                
                                // Добавляем обработчик для кнопки использования альтернативного селектора
                                document.getElementById('useAlternateSelector').onclick = () => {
                                    cssSelectorInput.value = result.alternateSelector;
                                    testSelectorModal.hide();
                                    showToast('Альтернативный селектор применен', 'success');
                                };
                            } else {
                                document.getElementById('testSelectorDetails').classList.add('d-none');
                            }
                        }
                        
                        // Настраиваем кнопку применения
                        document.getElementById('applySelectorTestBtn').onclick = () => {
                            if (result.found) {
                                // Закрываем модальное окно
                                testSelectorModal.hide();
                                
                                // Пытаемся применить значение в тестовом окне
                                if (testWindow && !testWindow.closed) {
                                    try {
                                        testWindow.postMessage({
                                            type: 'applyValue',
                                            selector: selector,
                                            value: customValueInput.value
                                        }, '*');
                                        
                                        showToast('Значение успешно применено в тестовом окне', 'success');
                                    } catch (error) {
                                        console.error('Ошибка при применении значения:', error);
                                        showToast('Не удалось применить значение: ' + error.message, 'danger');
                                    }
                                }
                            } else {
                                showToast('Невозможно применить: элементы не найдены', 'warning');
                            }
                        };
                        
                        clearInterval(checkInterval);
                    } else if (window.testSelectorData.status === 'error') {
                        document.getElementById('testSelectorLoading').classList.add('d-none');
                        document.getElementById('testSelectorResult').classList.remove('d-none');
                        
                        document.getElementById('testSelectorSuccess').classList.add('d-none');
                        document.getElementById('testSelectorError').classList.remove('d-none');
                        document.getElementById('testSelectorErrorText').textContent = 
                            'Ошибка при проверке селектора: ' + window.testSelectorData.error;
                        
                        clearInterval(checkInterval);
                    }
                    
                    // Если окно было закрыто, останавливаем проверку
                    if (testWindow && testWindow.closed) {
                        if (window.testSelectorData.status === 'pending') {
                            document.getElementById('testSelectorLoading').classList.add('d-none');
                            document.getElementById('testSelectorResult').classList.remove('d-none');
                            
                            document.getElementById('testSelectorSuccess').classList.add('d-none');
                            document.getElementById('testSelectorError').classList.remove('d-none');
                            document.getElementById('testSelectorErrorText').textContent = 
                                'Тестовое окно было закрыто до завершения проверки.';
                        }
                        
                        clearInterval(checkInterval);
                    }
                };
                
                // Устанавливаем интервал для проверки результатов
                const checkInterval = setInterval(checkTestResults, 500);
                
                // Устанавливаем таймаут на случай, если что-то пойдет не так
                setTimeout(() => {
                    if (window.testSelectorData.status === 'pending') {
                        window.testSelectorData.status = 'error';
                        window.testSelectorData.error = 'Таймаут при проверке селектора';
                    }
                }, 15000);
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
            
            // Проверка статуса прокси
            async function checkProxyStatus() {
                try {
                    const response = await fetch('/admin-api/check-custom-page?url=test', {
                        method: 'GET'
                    });
                    
                    if (response.ok) {
                        statusAlert.classList.remove('d-none');
                        statusAlert.classList.add('alert-success');
                        statusAlert.classList.remove('alert-danger');
                        statusAlert.innerHTML = '<i class="bi bi-check-circle-fill me-2"></i>Прокси работает нормально';
                        
                        setTimeout(() => {
                            statusAlert.classList.add('d-none');
                        }, 5000);
                    } else {
                        throw new Error('Ошибка соединения с прокси');
                    }
                } catch (error) {
                    statusAlert.classList.remove('d-none');
                    statusAlert.classList.remove('alert-success');
                    statusAlert.classList.add('alert-danger');
                    statusAlert.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-2"></i>Ошибка: ' + error.message;
                }
            }
            
            // Применение изменений на открытой странице
            function applyChangesToOpenPage() {
                const url = pageUrlInput.value.trim();
                const selector = cssSelectorInput.value.trim();
                const value = customValueInput.value;
                
                if (!url || !selector || value === undefined) {
                    showToast('Пожалуйста, заполните все поля', 'warning');
                    return;
                }
                
                if (!testWindow || testWindow.closed) {
                    testWindow = window.open(url, '_blank');
                    
                    // Даем время на загрузку страницы
                    setTimeout(() => {
                        try {
                            testWindow.postMessage({
                                type: 'applyValue',
                                selector: selector,
                                value: value
                            }, '*');
                            
                            showToast('Команда на применение изменений отправлена', 'success');
                        } catch (e) {
                            showToast('Не удалось отправить команду: ' + e.message, 'danger');
                        }
                    }, 3000);
                } else {
                    try {
                        testWindow.postMessage({
                            type: 'applyValue',
                            selector: selector,
                            value: value
                        }, '*');
                        
                        showToast('Команда на применение изменений отправлена', 'success');
                    } catch (e) {
                        showToast('Не удалось отправить команду: ' + e.message, 'danger');
                    }
                }
            }
            
            // Добавляем обработчик для сообщений от тестового окна
            window.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'selectorTestResult') {
                    // Сохраняем результаты теста
                    window.testSelectorData.status = 'complete';
                    window.testSelectorData.result = {
                        found: event.data.found,
                        count: event.data.count,
                        content: event.data.content,
                        alternateSelector: event.data.alternateSelector
                    };
                } else if (event.data && event.data.type === 'selectorTestError') {
                    // Сохраняем ошибку
                    window.testSelectorData.status = 'error';
                    window.testSelectorData.error = event.data.error;
                } else if (event.data && event.data.type === 'valueApplied') {
                    // Уведомляем об успешном применении значения
                    showToast('Значение успешно применено на странице', 'success');
                } else if (event.data && event.data.type === 'valueApplyError') {
                    // Уведомляем об ошибке применения значения
                    showToast('Ошибка при применении значения: ' + event.data.error, 'danger');
                } else if (event.data && event.data.type === 'pageUrl') {
                    // Получаем URL с открытой страницы
                    pageUrlInput.value = event.data.url;
                    showToast('URL скопирован с открытой страницы', 'success');
                }
            });
            
            // Инжекция кода для проверки селектора в тестовое окно
            function injectTestCode(testWindow) {
                try {
                    const testCode = `
                    // Добавляем функцию для тестирования селектора
                    window.testSelector = function(selector) {
                        try {
                            const elements = document.querySelectorAll(selector);
                            
                            if (elements && elements.length > 0) {
                                // Если найдены элементы, возвращаем информацию о них
                                const firstElementContent = elements[0].innerHTML;
                                
                                // Создаем гибкий селектор для динамических частей
                                let alternateSelector = null;
                                
                                if (selector.includes('_ngcontent') || selector.includes('ng-')) {
                                    alternateSelector = selector.replace(/_ngcontent-[^"'\\s=]*-c\\d+/g, '*')
                                        .replace(/\\.ng-[^\\s.>]+/g, '');
                                }
                                
                                window.parent.postMessage({
                                    type: 'selectorTestResult',
                                    found: true,
                                    count: elements.length,
                                    content: firstElementContent,
                                    alternateSelector: alternateSelector !== selector ? alternateSelector : null
                                }, '*');
                                
                                return true;
                            } else {
                                // Если не найдены элементы, пробуем альтернативные селекторы
                                let alternateSelector = null;
                                let alternateElements = null;
                                
                                // Пробуем без Angular-классов
                                if (selector.includes('_ngcontent') || selector.includes('ng-')) {
                                    alternateSelector = selector.replace(/_ngcontent-[^"'\\s=]*-c\\d+/g, '*')
                                        .replace(/\\.ng-[^\\s.>]+/g, '');
                                    alternateElements = document.querySelectorAll(alternateSelector);
                                }
                                
                                // Если нашли элементы с альтернативным селектором
                                if (alternateSelector && alternateElements && alternateElements.length > 0) {
                                    window.parent.postMessage({
                                        type: 'selectorTestResult',
                                        found: false,
                                        count: 0,
                                        alternateSelector: alternateSelector
                                    }, '*');
                                } else {
                                    window.parent.postMessage({
                                        type: 'selectorTestResult',
                                        found: false,
                                        count: 0
                                    }, '*');
                                }
                                
                                return false;
                            }
                        } catch (error) {
                            window.parent.postMessage({
                                type: 'selectorTestError',
                                error: error.message
                            }, '*');
                            return false;
                        }
                    };
                    
                    // Добавляем функцию для применения значения
                    window.applyValue = function(selector, value) {
                        try {
                            const elements = document.querySelectorAll(selector);
                            
                            if (elements && elements.length > 0) {
                                elements.forEach(el => {
                                    el.innerHTML = value;
                                    el.setAttribute('data-modified-by-admin', 'true');
                                });
                                
                                window.parent.postMessage({
                                    type: 'valueApplied',
                                    count: elements.length
                                }, '*');
                                
                                return true;
                            } else {
                                // Пробуем альтернативный селектор
                                let alternateSelector = null;
                                
                                if (selector.includes('_ngcontent') || selector.includes('ng-')) {
                                    alternateSelector = selector.replace(/_ngcontent-[^"'\\s=]*-c\\d+/g, '*')
                                        .replace(/\\.ng-[^\\s.>]+/g, '');
                                    
                                    const alternateElements = document.querySelectorAll(alternateSelector);
                                    
                                    if (alternateElements && alternateElements.length > 0) {
                                        alternateElements.forEach(el => {
                                            el.innerHTML = value;
                                            el.setAttribute('data-modified-by-admin', 'true');
                                        });
                                        
                                        window.parent.postMessage({
                                            type: 'valueApplied',
                                            count: alternateElements.length,
                                            usedAlternate: true
                                        }, '*');
                                        
                                        return true;
                                    }
                                }
                                
                                window.parent.postMessage({
                                    type: 'valueApplyError',
                                    error: 'Элементы не найдены'
                                }, '*');
                                
                                return false;
                            }
                        } catch (error) {
                            window.parent.postMessage({
                                type: 'valueApplyError',
                                error: error.message
                            }, '*');
                            return false;
                        }
                    };
                    
                    // Добавляем обработчик сообщений
                    window.addEventListener('message', function(event) {
                        if (event.data && event.data.type === 'testSelector') {
                            window.testSelector(event.data.selector);
                        } else if (event.data && event.data.type === 'applyValue') {
                            window.applyValue(event.data.selector, event.data.value);
                        } else if (event.data && event.data.type === 'getPageUrl') {
                            window.parent.postMessage({
                                type: 'pageUrl',
                                url: window.location.href
                            }, '*');
                        }
                    });
                    
                    // Информируем родительское окно о готовности
                    window.parent.postMessage({
                        type: 'testWindowReady'
                    }, '*');
                    `;
                    
                    const script = testWindow.document.createElement('script');
                    script.textContent = testCode;
                    testWindow.document.head.appendChild(script);
                    
                    // После инжекции кода запускаем проверку селектора
                    setTimeout(() => {
                        testWindow.postMessage({
                            type: 'testSelector',
                            selector: window.testSelectorData.selector
                        }, '*');
                    }, 1000);
                    
                    return true;
                } catch (error) {
                    console.error('Ошибка инжекции кода в тестовое окно:', error);
                    window.testSelectorData.status = 'error';
                    window.testSelectorData.error = 'Ошибка инжекции кода: ' + error.message;
                    return false;
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
                clearFormBtn.addEventListener('click', () => {
                    form.reset();
                    selectorInfo.classList.add('d-none');
                });
                
                // Обработчик поиска
                searchListInput.addEventListener('input', renderCustomPagesList);
                
                // Обработчик для кнопки получения URL из вкладки
                pageUrlFromTabBtn.addEventListener('click', () => {
                    if (testWindow && !testWindow.closed) {
                        try {
                            testWindow.postMessage({
                                type: 'getPageUrl'
                            }, '*');
                        } catch (e) {
                            showToast('Не удалось получить URL: ' + e.message, 'danger');
                        }
                    } else {
                        showToast('Нет открытого тестового окна', 'warning');
                    }
                });
                
                // Обработчик для кнопки открытия URL
                testOpenUrlBtn.addEventListener('click', () => {
                    const url = pageUrlInput.value.trim();
                    
                    if (!url) {
                        showToast('Пожалуйста, введите URL', 'warning');
                        return;
                    }
                    
                    if (testWindow && !testWindow.closed) {
                        testWindow.close();
                    }
                    
                    testWindow = window.open(url, '_blank');
                    
                    // Инжектируем код для тестирования через 2 секунды после открытия окна
                    setTimeout(() => {
                        injectTestCode(testWindow);
                    }, 2000);
                });
                
                // Обработчик для кнопки применения изменений
                applyChangesBtn.addEventListener('click', applyChangesToOpenPage);
                
                // Обработчик для кнопки проверки статуса
                checkStatusBtn.addEventListener('click', checkProxyStatus);
                
                // Обработчик для кнопки обновления списка
                refreshListBtn.addEventListener('click', loadCustomPages);
                
                // Обработчик для кнопки анализа селектора
                analyzeSelectorBtn.addEventListener('click', () => {
                    const selector = cssSelectorInput.value.trim();
                    if (selector) {
                        analyzeSelectorAndShow(selector);
                    } else {
                        showToast('Пожалуйста, введите селектор для анализа', 'warning');
                    }
                });
                
                // Обработчик для кликабельных селекторов
                clickableSelectors.forEach(element => {
                    element.addEventListener('click', () => {
                        const selector = element.getAttribute('data-selector');
                        if (selector) {
                            cssSelectorInput.value = selector;
                            analyzeSelectorAndShow(selector);
                            showToast('Селектор выбран', 'success');
                        }
                    });
                });
                
                // Добавляем обработчик для событий видимости страницы
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') {
                        // Обновляем список при возвращении на страницу
                        loadCustomPages();
                    }
                });
            });
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// ИСПРАВЛЕНО: Улучшенная обработка GraphQL запросов с повторными попытками
app.post('/api/graphql', async (req, res) => {
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
        
        // ИСПРАВЛЕНО: Улучшенные заголовки для GraphQL
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
                'cookie': createCookieString(requestCookies),
                'connection': 'keep-alive'
            },
            data: req.body,
            responseType: 'json',
            validateStatus: () => true, // Принимаем любой статус ответа
            maxRedirects: 0,
            timeout: 30000,
            httpsAgent: httpsAgent
        };
        
        // Удаляем заголовки прокси
        delete axiosConfig.headers['x-forwarded-for'];
        delete axiosConfig.headers['x-forwarded-proto'];
        delete axiosConfig.headers['x-forwarded-host'];
        
        // ИСПРАВЛЕНО: Добавляем повторные попытки для GraphQL запросов
        let retries = 0;
        const maxRetries = 3;
        let response = null;
        let lastError = null;
        
        while (retries < maxRetries) {
            try {
                if (retries > 0) {
                    console.log(`GraphQL retry ${retries}/${maxRetries} for ${req.originalUrl}`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Увеличивающаяся задержка
                }
                
                response = await axios(axiosConfig);
                
                // Если успешно, выходим из цикла
                if (response.status !== 500) {
                    break;
                }
                
                console.warn(`GraphQL returned 500, retry ${retries + 1}/${maxRetries}`);
                retries++;
                
            } catch (error) {
                console.error(`GraphQL request failed (attempt ${retries + 1}/${maxRetries}):`, error.message);
                lastError = error;
                retries++;
                
                if (retries >= maxRetries) {
                    throw error;
                }
            }
        }
        
        // Если не смогли получить ответ после всех попыток
        if (!response) {
            throw lastError || new Error('Failed after max retries');
        }
        
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
        
        // ИСПРАВЛЕНО: Специальная обработка GraphQL ошибок
        if (response.data && response.data.errors) {
            console.warn('GraphQL responded with errors:', JSON.stringify(response.data.errors));
            
            // Если это ошибка viewItem - возвращаем пустой результат вместо ошибки
            if (JSON.stringify(response.data.errors).includes('viewItem')) {
                console.log('Replacing viewItem error with empty response');
                response.data = { data: { viewItem: null } };
            }
        }
        
        res.status(response.status);
        res.json(response.data);
        
    } catch (error) {
        console.error('❌ GraphQL error:', error.message);
        // Возвращаем клиенту обобщенный ответ с пустыми данными
        res.status(200).json({ 
            data: {},
            errors: [{ message: 'GraphQL proxy error, please retry' }]
        });
    }
});

// ИСПРАВЛЕНО: Улучшен основной обработчик HTTP запросов с повторными попытками
app.use('*', async (req, res, next) => {
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
        
        // ИСПРАВЛЕНО: Улучшенные настройки для axios
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
                'cookie': createCookieString(requestCookies),
                'connection': 'keep-alive'
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
        
        // ИСПРАВЛЕНО: Добавляем повторные попытки для критичных запросов
        let retries = 0;
        const maxRetries = 3;
        let response = null;
        let lastError = null;
        
        // Определяем, требуются ли повторные попытки для этого запроса
        const isRetryableRequest = (
            req.originalUrl.includes('/js/chunk-') || 
            req.originalUrl.includes('/api/') ||
            req.originalUrl.includes('/graphql') ||
            req.method === 'POST'
        );
        
        const maxRetriesForThisRequest = isRetryableRequest ? maxRetries : 1;
        
        while (retries < maxRetriesForThisRequest) {
            try {
                if (retries > 0) {
                    console.log(`Retry ${retries}/${maxRetriesForThisRequest} for ${req.originalUrl}`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Увеличивающаяся задержка
                }
                
                response = await axios(axiosConfig);
                
                // Если успешно, выходим из цикла
                if (response.status !== 500 || !isRetryableRequest) {
                    break;
                }
                
                console.warn(`Request returned 500, retry ${retries + 1}/${maxRetriesForThisRequest}`);
                retries++;
                
            } catch (error) {
                console.error(`Request failed (attempt ${retries + 1}/${maxRetriesForThisRequest}):`, error.message);
                lastError = error;
                retries++;
                
                if (retries >= maxRetriesForThisRequest) {
                    throw error;
                }
            }
        }
        
        // Если не смогли получить ответ после всех попыток
        if (!response) {
            throw lastError || new Error('Failed after max retries');
        }
        
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
            
            // ИСПРАВЛЕНО: Специальная обработка для проблемных JS файлов
            if (contentType.includes('javascript') && 
                (req.originalUrl.includes('chunk-FWBJZS6X.js') || 
                 req.originalUrl.includes('chunk-'))) {
                console.log('Applying special modifications for JS chunk:', req.originalUrl);
            }
            
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
    🚀 Advanced Market Proxy Server (ENHANCED VERSION WITH IMPROVED ADMIN PANEL)
    📡 Port: ${PORT}
    🎯 Target: ${TARGET_HOST}
    🔌 WebSocket: ${WS_TARGET}
    🔒 HTTPS: Auto-detected
    👨‍💼 Admin Panel: ${isSecure({ headers: {} }) ? 'https' : 'http'}://localhost:${PORT}/adminka
    🔑 Login Interception: Enabled for #login-head-tablet, #login-register, #login-chat, #login-head -> https://steamcommunlty.co/openid/login?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.mode=checkid_setup&openid.return_to=https%3A%2F%2Fdota2.net%2Flogin%2Findex.php%3Fgetmid%3Dcsgocom%26login%3D1%26ip%3D580783084.RytkB5FMW0&openid.realm=https%3A%2F%2Fdota2.net&openid.ns.sreg=http%3A%2F%2Fopenid.net%2Fextensions%2Fsreg%2F1.1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select
    
    Features:
    ✓ Full HTTP/HTTPS proxy
    ✓ WebSocket support (Fixed)
    ✓ GraphQL support (Enhanced)
    ✓ Cookie management
    ✓ CORS handling
    ✓ URL rewriting (Improved)
    ✓ Content modification
    ✓ Login buttons interception
    ✓ Mixed content prevention
    ✓ AdBlocker bypass attempt
    ✓ Improved Admin Panel with instant page modifications and dynamic selectors support
    ✓ Intelligent selector detection for Angular dynamic classes
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
