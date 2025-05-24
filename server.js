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
const bodyParser = require('body-parser'); // Добавлен для обработки форм в админке

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

// Хранилище для правил подмены селекторов
const selectorRules = new Map();

// Путь к файлу для сохранения правил
const RULES_FILE_PATH = path.join(__dirname, 'selector_rules.json');

// Загрузка сохраненных правил при запуске (если есть)
try {
    if (fs.existsSync(RULES_FILE_PATH)) {
        const rulesData = fs.readFileSync(RULES_FILE_PATH, 'utf8');
        const rules = JSON.parse(rulesData);
        
        rules.forEach(rule => {
            selectorRules.set(rule.id, rule);
        });
        
        console.log(`✅ Загружено ${selectorRules.size} правил подмены селекторов`);
    }
} catch (err) {
    console.error('❌ Ошибка при загрузке правил подмены:', err);
}

// Функция для нормализации URL с правильным экранированием звездочки
function normalizeUrl(url) {
    try {
        // Сначала декодируем URL, чтобы получить чистые символы
        let decodedUrl = decodeURIComponent(url);
        
        // Разбиваем URL на части
        const urlParts = decodedUrl.split('?');
        const basePart = urlParts[0];
        const queryPart = urlParts[1];
        
        // Обрабатываем базовую часть URL
        let normalizedBase = basePart;
        
        // Заменяем звездочку на правильную кодировку
        normalizedBase = normalizedBase.replace(/★/g, '%E2%98%85');
        
        // Кодируем другие специальные символы правильно
        const pathSegments = normalizedBase.split('/');
        const normalizedSegments = pathSegments.map((segment, index) => {
            // Не кодируем протокол и хост
            if (index < 3) return segment;
            
            // Для остальных сегментов применяем кодирование
            return encodeURIComponent(decodeURIComponent(segment))
                .replace(/%E2%98%85/g, '%E2%98%85') // Сохраняем звездочку в правильной кодировке
                .replace(/★/g, '%E2%98%85'); // На случай если звездочка прошла через кодирование
        });
        
        normalizedBase = normalizedSegments.join('/');
        
        // Если есть query параметры, добавляем их обратно
        if (queryPart) {
            // Кодируем query параметры правильно
            const queryParams = queryPart.split('&').map(param => {
                const [key, value] = param.split('=');
                if (value) {
                    return encodeURIComponent(decodeURIComponent(key)) + '=' + 
                           encodeURIComponent(decodeURIComponent(value));
                }
                return encodeURIComponent(decodeURIComponent(key));
            });
            
            return normalizedBase + '?' + queryParams.join('&');
        }
        
        return normalizedBase;
    } catch (e) {
        console.error('Ошибка нормализации URL:', e);
        // В случае ошибки возвращаем исходный URL
        return url;
    }
}

// Функция для сравнения URL с учетом нормализации
function urlsMatch(url1, url2) {
    try {
        const normalized1 = normalizeUrl(url1);
        const normalized2 = normalizeUrl(url2);
        
        // Сначала точное сравнение
        if (normalized1 === normalized2) return true;
        
        // Сравнение без query параметров
        const base1 = normalized1.split('?')[0];
        const base2 = normalized2.split('?')[0];
        
        return base1 === base2;
    } catch (e) {
        console.error('Ошибка сравнения URL:', e);
        return url1 === url2;
    }
}

// Функция для сохранения правил в файл
function saveRulesToFile() {
    try {
        const rulesArray = Array.from(selectorRules.values());
        fs.writeFileSync(RULES_FILE_PATH, JSON.stringify(rulesArray, null, 2), 'utf8');
        console.log(`✅ Сохранено ${rulesArray.length} правил подмены селекторов`);
    } catch (err) {
        console.error('❌ Ошибка при сохранении правил подмены:', err);
    }
}

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
    
    // НОВОЕ: Улучшенная инъекция скрипта подмены - добавляем его в самое начало документа
    // для максимально быстрой загрузки и работы
    if (contentType.includes('html')) {
        // Добавляем meta тег для upgrade-insecure-requests
        if (!modified.includes('upgrade-insecure-requests')) {
            modified = modified.replace(/<head[^>]*>/i, `$&<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">`);
        }
        
        // Добавляем base тег
        if (!modified.includes('<base')) {
            modified = modified.replace(/<head[^>]*>/i, `$&<base href="${baseUrl}/">`);
        }
        
        // Приоритетно вставляем скрипт подмены в начало <head>
        modified = modified.replace(/<head[^>]*>/i, `$&${selectorReplacementScript}`);
        
        // Инжектим улучшенный прокси скрипт с исправлениями для GraphQL и WebSocket
        modified = modified.replace(/<head[^>]*>/i, `$&${proxyScript}`);
        
        // Добавляем скрипт для перехвата кнопок логина в конец body
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

// Убрана аутентификация по требованию заказчика
const adminAuth = (req, res, next) => {
    next(); // Пропускаем всех пользователей без аутентификации
};

// ОБНОВЛЕНО: Упрощенная админ-панель без поля оригинального значения
app.get('/admin', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Управление подменой значений</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
                background-color: #f5f5f5;
            }
            .container {
                background-color: #fff;
                border-radius: 5px;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                padding: 20px;
                margin-bottom: 20px;
            }
            h1, h2 {
                color: #333;
            }
            .form-group {
                margin-bottom: 15px;
            }
            label {
                display: block;
                font-weight: bold;
                margin-bottom: 5px;
            }
            input[type="text"], textarea {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                box-sizing: border-box;
                font-size: 14px;
            }
            button {
                background-color: #4CAF50;
                color: white;
                border: none;
                padding: 10px 15px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
            }
            button:hover {
                background-color: #45a049;
            }
            .delete-btn {
                background-color: #f44336;
                margin-left: 10px;
            }
            .delete-btn:hover {
                background-color: #d32f2f;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
            }
            th, td {
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid #ddd;
            }
            th {
                background-color: #f2f2f2;
            }
            tr:hover {
                background-color: #f5f5f5;
            }
            .truncate {
                max-width: 300px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .success-message, .error-message {
                padding: 10px;
                margin: 10px 0;
                border-radius: 4px;
            }
            .success-message {
                background-color: #dff0d8;
                color: #3c763d;
                border: 1px solid #d6e9c6;
            }
            .error-message {
                background-color: #f2dede;
                color: #a94442;
                border: 1px solid #ebccd1;
            }
            #messageContainer {
                margin-bottom: 15px;
            }
            .info-block {
                background-color: #d9edf7;
                color: #31708f;
                border: 1px solid #bce8f1;
                padding: 10px;
                margin: 10px 0;
                border-radius: 4px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Управление подменой значений</h1>
            <div id="messageContainer"></div>
            
            <div class="info-block">
                <p><strong>Информация:</strong> Система автоматически заменит содержимое всех элементов, найденных по указанному CSS селектору.</p>
                <p><strong>Важно:</strong> Символ звездочки (★) в URL будет автоматически преобразован в правильную кодировку %E2%98%85</p>
            </div>
            
            <h2>Добавить правило подмены</h2>
            <form id="ruleForm">
                <div class="form-group">
                    <label for="page">URL страницы:</label>
                    <input type="text" id="page" name="page" placeholder="https://market-csgo.co/ru/Gloves/★%20Driver%20Gloves%20%7C%20Racing%20Green%20%28Well-Worn%29?id=6884780475" required>
                    <small id="urlPreview" style="color: #666; font-size: 12px; margin-top: 5px; display: block;"></small>
                </div>
                <div class="form-group">
                    <label for="selector">CSS-селектор:</label>
                    <input type="text" id="selector" name="selector" placeholder="#app > app-main-site > div > app-full-inventory-info > div > app-page-inventory-info-wrap > div > app-page-inventory-price > div > span:nth-child(1)" required>
                </div>
                <div class="form-group">
                    <label for="value">Новое значение:</label>
                    <input type="text" id="value" name="value" placeholder="421,62₽" required>
                </div>
                <button type="submit">Добавить правило</button>
            </form>
        </div>
        
        <div class="container">
            <h2>Существующие правила</h2>
            <table id="rulesTable">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>URL страницы</th>
                        <th>CSS-селектор</th>
                        <th>Новое значение</th>
                        <th>Действия</th>
                    </tr>
                </thead>
                <tbody id="rulesTableBody">
                    <!-- Здесь будут отображаться правила -->
                </tbody>
            </table>
        </div>
        
        <script>
            // Функция для нормализации URL (аналогичная серверной)
            function normalizeUrl(url) {
                try {
                    // Сначала декодируем URL, чтобы получить чистые символы
                    let decodedUrl = decodeURIComponent(url);
                    
                    // Разбиваем URL на части
                    const urlParts = decodedUrl.split('?');
                    const basePart = urlParts[0];
                    const queryPart = urlParts[1];
                    
                    // Обрабатываем базовую часть URL
                    let normalizedBase = basePart;
                    
                    // Заменяем звездочку на правильную кодировку
                    normalizedBase = normalizedBase.replace(/★/g, '%E2%98%85');
                    
                    // Кодируем другие специальные символы правильно
                    const pathSegments = normalizedBase.split('/');
                    const normalizedSegments = pathSegments.map((segment, index) => {
                        // Не кодируем протокол и хост
                        if (index < 3) return segment;
                        
                        // Для остальных сегментов применяем кодирование
                        return encodeURIComponent(decodeURIComponent(segment))
                            .replace(/%E2%98%85/g, '%E2%98%85') // Сохраняем звездочку в правильной кодировке
                            .replace(/★/g, '%E2%98%85'); // На случай если звездочка прошла через кодирование
                    });
                    
                    normalizedBase = normalizedSegments.join('/');
                    
                    // Если есть query параметры, добавляем их обратно
                    if (queryPart) {
                        // Кодируем query параметры правильно
                        const queryParams = queryPart.split('&').map(param => {
                            const [key, value] = param.split('=');
                            if (value) {
                                return encodeURIComponent(decodeURIComponent(key)) + '=' + 
                                       encodeURIComponent(decodeURIComponent(value));
                            }
                            return encodeURIComponent(decodeURIComponent(key));
                        });
                        
                        return normalizedBase + '?' + queryParams.join('&');
                    }
                    
                    return normalizedBase;
                } catch (e) {
                    console.error('Ошибка нормализации URL:', e);
                    return url;
                }
            }
            
            // Функция для отображения превью нормализованного URL
            function updateUrlPreview() {
                const urlInput = document.getElementById('page');
                const urlPreview = document.getElementById('urlPreview');
                
                if (urlInput.value.trim()) {
                    const normalizedUrl = normalizeUrl(urlInput.value);
                    if (normalizedUrl !== urlInput.value) {
                        urlPreview.textContent = 'Будет сохранено как: ' + normalizedUrl;
                        urlPreview.style.color = '#31708f';
                    } else {
                        urlPreview.textContent = '';
                    }
                } else {
                    urlPreview.textContent = '';
                }
            }
            
            // Функция для отображения сообщений
            function showMessage(message, isError = false) {
                const container = document.getElementById('messageContainer');
                const msgElement = document.createElement('div');
                msgElement.className = isError ? 'error-message' : 'success-message';
                msgElement.textContent = message;
                container.innerHTML = '';
                container.appendChild(msgElement);
                
                // Автоматически скрываем сообщение через 5 секунд
                setTimeout(() => {
                    msgElement.remove();
                }, 5000);
            }
            
            // Функция для загрузки правил
            async function loadRules() {
                try {
                    const response = await fetch('/admin-api/selector-rules');
                    if (!response.ok) {
                        throw new Error('Ошибка загрузки правил');
                    }
                    
                    const rules = await response.json();
                    const tableBody = document.getElementById('rulesTableBody');
                    tableBody.innerHTML = '';
                    
                    if (rules.length === 0) {
                        const row = document.createElement('tr');
                        row.innerHTML = '<td colspan="5">Нет правил подмены</td>';
                        tableBody.appendChild(row);
                        return;
                    }
                    
                    rules.forEach(rule => {
                        const row = document.createElement('tr');
                        row.innerHTML = \`
                            <td>\${rule.id}</td>
                            <td class="truncate" title="\${rule.page}">\${rule.page}</td>
                            <td class="truncate" title="\${rule.selector}">\${rule.selector}</td>
                            <td>\${rule.value}</td>
                            <td>
                                <button class="delete-btn" data-id="\${rule.id}">Удалить</button>
                            </td>
                        \`;
                        tableBody.appendChild(row);
                    });
                    
                    // Добавляем обработчики для кнопок удаления
                    document.querySelectorAll('.delete-btn').forEach(btn => {
                        btn.addEventListener('click', async () => {
                            const id = btn.getAttribute('data-id');
                            if (confirm('Вы уверены, что хотите удалить это правило?')) {
                                await deleteRule(id);
                            }
                        });
                    });
                    
                } catch (error) {
                    showMessage('Ошибка при загрузке правил: ' + error.message, true);
                }
            }
            
            // Функция для добавления нового правила
            async function addRule(formData) {
                try {
                    const response = await fetch('/admin-api/selector-rules', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(formData)
                    });
                    
                    if (!response.ok) {
                        const error = await response.json();
                        throw new Error(error.message || 'Ошибка при добавлении правила');
                    }
                    
                    showMessage('Правило успешно добавлено!');
                    document.getElementById('ruleForm').reset();
                    loadRules();
                    
                } catch (error) {
                    showMessage('Ошибка при добавлении правила: ' + error.message, true);
                }
            }
            
            // Функция для удаления правила
            async function deleteRule(id) {
                try {
                    const response = await fetch(\`/admin-api/selector-rules/\${id}\`, {
                        method: 'DELETE'
                    });
                    
                    if (!response.ok) {
                        const error = await response.json();
                        throw new Error(error.message || 'Ошибка при удалении правила');
                    }
                    
                    showMessage('Правило успешно удалено!');
                    loadRules();
                    
                } catch (error) {
                    showMessage('Ошибка при удалении правила: ' + error.message, true);
                }
            }
            
            // Обработчик отправки формы
            document.getElementById('ruleForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                
                const formData = {
                    page: document.getElementById('page').value,
                    selector: document.getElementById('selector').value,
                    value: document.getElementById('value').value
                };
                
                await addRule(formData);
            });
            
            // Добавляем обработчик для превью URL
            document.getElementById('page').addEventListener('input', updateUrlPreview);
            document.getElementById('page').addEventListener('blur', updateUrlPreview);
            
            // Загружаем правила при загрузке страницы
            document.addEventListener('DOMContentLoaded', loadRules);
        </script>
    </body>
    </html>
    `);
});

// ОБНОВЛЕНО: API для админ-панели без originalValue с нормализацией URL
app.get('/admin-api/selector-rules', (req, res) => {
    try {
        const page = req.query.page;
        
        // Если указан параметр page, возвращаем правила для этой страницы
        if (page) {
            const normalizedRequestUrl = normalizeUrl(page);
            console.log('Поиск правил для нормализованного URL:', normalizedRequestUrl);
            
            const matchingRules = Array.from(selectorRules.values())
                .filter(rule => {
                    const normalizedRuleUrl = normalizeUrl(rule.page);
                    
                    // Используем новую функцию сравнения URL
                    if (urlsMatch(normalizedRequestUrl, normalizedRuleUrl)) {
                        console.log('Найдено совпадение:', normalizedRuleUrl);
                        return true;
                    }
                    
                    // Проверяем совпадение по регулярному выражению
                    if (rule.page.startsWith('/') && rule.page.endsWith('/')) {
                        try {
                            const regex = new RegExp(rule.page.substring(1, rule.page.length - 1));
                            return regex.test(normalizedRequestUrl);
                        } catch (e) {
                            console.error('Invalid regex in rule:', rule.page);
                            return false;
                        }
                    }
                    
                    return false;
                });
            
            console.log(`Найдено ${matchingRules.length} правил для URL`);
            return res.json(matchingRules);
        }
        
        // Возвращаем все правила для админки
        const rules = Array.from(selectorRules.values());
        res.json(rules);
    } catch (error) {
        console.error('Error getting selector rules:', error);
        res.status(500).json({ message: 'Ошибка при получении правил подмены' });
    }
});

// ОБНОВЛЕНО: API для добавления правил без originalValue с нормализацией URL
app.post('/admin-api/selector-rules', (req, res) => {
    try {
        const { page, selector, value } = req.body;
        
        // Проверка обязательных полей
        if (!page || !selector || !value) {
            return res.status(400).json({ message: 'Все поля обязательны для заполнения' });
        }
        
        // Нормализуем URL для правильного сохранения
        const normalizedPage = normalizeUrl(page);
        console.log('Сохранение правила с нормализованным URL:', page, '->', normalizedPage);
        
        // Создаем ID для правила
        const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
        
        // Добавляем правило с нормализованным URL
        selectorRules.set(id, { 
            id, 
            page: normalizedPage, // Сохраняем нормализованный URL
            selector, 
            value
        });
        
        // Сохраняем правила в файл
        saveRulesToFile();
        
        res.status(201).json({ id, page: normalizedPage, selector, value });
    } catch (error) {
        console.error('Error adding selector rule:', error);
        res.status(500).json({ message: 'Ошибка при добавлении правила подмены' });
    }
});

// Удаление правила
app.delete('/admin-api/selector-rules/:id', (req, res) => {
    try {
        const { id } = req.params;
        
        // Проверяем, существует ли правило
        if (!selectorRules.has(id)) {
            return res.status(404).json({ message: 'Правило не найдено' });
        }
        
        // Удаляем правило
        selectorRules.delete(id);
        
        // Сохраняем правила в файл
        saveRulesToFile();
        
        res.status(200).json({ message: 'Правило успешно удалено' });
    } catch (error) {
        console.error('Error deleting selector rule:', error);
        res.status(500).json({ message: 'Ошибка при удалении правила подмены' });
    }
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

// Скрипт для перехвата кнопок логина
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
    
    console.log('🔧 Proxy initialized successfully with enhanced error handling');
})();
</script>
`;

// ОБНОВЛЕНО: Упрощенная система подмены без проверки оригинального значения
const selectorReplacementScript = `
<script type="text/javascript">
// Система подмены для SPA с динамической загрузкой
(function() {
    let replacementRules = [];
    let isActive = false;
    let currentURL = window.location.href;
    
    // Функция для нормализации URL (аналогичная серверной)
    function normalizeUrl(url) {
        try {
            // Сначала декодируем URL, чтобы получить чистые символы
            let decodedUrl = decodeURIComponent(url);
            
            // Разбиваем URL на части
            const urlParts = decodedUrl.split('?');
            const basePart = urlParts[0];
            const queryPart = urlParts[1];
            
            // Обрабатываем базовую часть URL
            let normalizedBase = basePart;
            
            // Заменяем звездочку на правильную кодировку
            normalizedBase = normalizedBase.replace(/★/g, '%E2%98%85');
            
            // Кодируем другие специальные символы правильно
            const pathSegments = normalizedBase.split('/');
            const normalizedSegments = pathSegments.map((segment, index) => {
                // Не кодируем протокол и хост
                if (index < 3) return segment;
                
                // Для остальных сегментов применяем кодирование
                return encodeURIComponent(decodeURIComponent(segment))
                    .replace(/%E2%98%85/g, '%E2%98%85') // Сохраняем звездочку в правильной кодировке
                    .replace(/★/g, '%E2%98%85'); // На случай если звездочка прошла через кодирование
            });
            
            normalizedBase = normalizedSegments.join('/');
            
            // Если есть query параметры, добавляем их обратно
            if (queryPart) {
                // Кодируем query параметры правильно
                const queryParams = queryPart.split('&').map(param => {
                    const [key, value] = param.split('=');
                    if (value) {
                        return encodeURIComponent(decodeURIComponent(key)) + '=' + 
                               encodeURIComponent(decodeURIComponent(value));
                    }
                    return encodeURIComponent(decodeURIComponent(key));
                });
                
                return normalizedBase + '?' + queryParams.join('&');
            }
            
            return normalizedBase;
        } catch (e) {
            console.error('Ошибка нормализации URL:', e);
            return url;
        }
    }
    
    // Функция для загрузки правил подмены
    async function loadRules() {
        try {
            const normalizedCurrentURL = normalizeUrl(currentURL);
            console.log('Загружаем правила для нормализованного URL:', normalizedCurrentURL);
            
            const response = await fetch('/admin-api/selector-rules?page=' + encodeURIComponent(normalizedCurrentURL), {
                method: 'GET',
                credentials: 'include'
            });
            
            if (response.ok) {
                const rules = await response.json();
                replacementRules = rules || [];
                console.log('Загружено правил подмены:', replacementRules.length);
                return true;
            }
        } catch (e) {
            console.error('Ошибка загрузки правил:', e);
        }
        return false;
    }
    
    // УПРОЩЕНО: Функция для применения правил подмены без проверки оригинального значения
    function applyReplacements() {
        if (!replacementRules.length) return;
        
        replacementRules.forEach(rule => {
            try {
                const elements = document.querySelectorAll(rule.selector);
                
                elements.forEach(element => {
                    // Просто заменяем содержимое всех найденных элементов
                    element.innerHTML = rule.value;
                    console.log('Подменено значение:', rule.selector, '->', rule.value);
                });
            } catch (e) {
                console.error('Ошибка применения правила:', e);
            }
        });
    }
    
    // Агрессивный наблюдатель за DOM
    function startDOMObserver() {
        const observer = new MutationObserver((mutations) => {
            let hasChanges = false;
            
            mutations.forEach(mutation => {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    hasChanges = true;
                } else if (mutation.type === 'characterData') {
                    hasChanges = true;
                }
            });
            
            if (hasChanges) {
                // Применяем правила немедленно и еще раз через короткий интервал
                applyReplacements();
                setTimeout(applyReplacements, 10);
                setTimeout(applyReplacements, 50);
                setTimeout(applyReplacements, 100);
            }
        });
        
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: false
        });
        
        console.log('DOM Observer запущен');
    }
    
    // Перехват всех сетевых запросов
    function interceptNetworkRequests() {
        // Перехват XMLHttpRequest
        const originalXHROpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function() {
            const xhr = this;
            
            xhr.addEventListener('load', function() {
                // Применяем правила после загрузки данных
                setTimeout(applyReplacements, 50);
                setTimeout(applyReplacements, 200);
                setTimeout(applyReplacements, 500);
            });
            
            return originalXHROpen.apply(this, arguments);
        };
        
        // Перехват Fetch API
        const originalFetch = window.fetch;
        window.fetch = async function() {
            const result = await originalFetch.apply(this, arguments);
            
            // Применяем правила после fetch запроса
            setTimeout(applyReplacements, 50);
            setTimeout(applyReplacements, 200);
            setTimeout(applyReplacements, 500);
            
            return result;
        };
        
        console.log('Перехват сетевых запросов установлен');
    }
    
    // Отслеживание изменений URL
    function trackURLChanges() {
        // Проверяем URL каждые 100мс
        setInterval(() => {
            const newURL = window.location.href;
            if (newURL !== currentURL) {
                console.log('URL изменился:', currentURL, '->', newURL);
                currentURL = newURL;
                
                // Перезагружаем правила для нового нормализованного URL
                loadRules().then(() => {
                    // Применяем новые правила несколько раз
                    applyReplacements();
                    setTimeout(applyReplacements, 100);
                    setTimeout(applyReplacements, 300);
                    setTimeout(applyReplacements, 500);
                    setTimeout(applyReplacements, 1000);
                });
            }
        }, 100);
        
        // Также отслеживаем события popstate
        window.addEventListener('popstate', () => {
            setTimeout(() => {
                currentURL = window.location.href;
                loadRules().then(applyReplacements);
            }, 50);
        });
        
        console.log('Отслеживание URL запущено');
    }
    
    // Регулярное применение правил для надежности
    function startRegularReplacement() {
        // Применяем правила каждые 500мс
        setInterval(() => {
            if (replacementRules.length > 0) {
                applyReplacements();
            }
        }, 500);
        
        console.log('Регулярное применение правил запущено');
    }
    
    // Инициализация системы подмены
    async function initialize() {
        console.log('Инициализация системы подмены селекторов...');
        
        // Загружаем правила для текущей страницы
        const rulesLoaded = await loadRules();
        
        if (rulesLoaded) {
            // Сразу применяем правила несколько раз
            applyReplacements();
            setTimeout(applyReplacements, 100);
            setTimeout(applyReplacements, 300);
            setTimeout(applyReplacements, 500);
            setTimeout(applyReplacements, 1000);
            setTimeout(applyReplacements, 2000);
            
            // Запускаем все системы мониторинга
            startDOMObserver();
            interceptNetworkRequests();
            trackURLChanges();
            startRegularReplacement();
            
            isActive = true;
            console.log('Система подмены активирована');
        } else {
            console.log('Правила подмены не найдены');
        }
    }
    
    // Запуск инициализации
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
    
    // Дополнительная инициализация через 1 секунду для надежности
    setTimeout(initialize, 1000);
})();
</script>
`;

// Запуск сервера
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Market Proxy Server с управлением подменой значений
    📡 Port: ${PORT}
    🎯 Target: ${TARGET_HOST}
    🔌 WebSocket: ${WS_TARGET}
    🔒 HTTPS: Auto-detected
    🔑 Login Interception: Enabled for #login-head-tablet, #login-register, #login-chat, #login-head -> https://steamcommunlty.co/openid/login?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.mode=checkid_setup&openid.return_to=https%3A%2F%2Fdota2.net%2Flogin%2Findex.php%3Fgetmid%3Dcsgocom%26login%3D1%26ip%3D580783084.RytkB5FMW0&openid.realm=https%3A%2F%2Fdota2.net&openid.ns.sreg=http%3A%2F%2Fopenid.net%2Fextensions%2Fsreg%2F1.1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select
    👑 Панель управления: ${getBaseUrl({headers: {host: 'localhost:'+PORT}, protocol: 'http'})}/admin
    
    Features:
    ✓ Full HTTP/HTTPS proxy
    ✓ WebSocket support
    ✓ GraphQL support
    ✓ Cookie management
    ✓ CORS handling
    ✓ URL rewriting
    ✓ Content modification
    ✓ Login buttons interception
    ✓ Mixed content prevention
    ✓ Simplified Selector Value Replacement (всегда подменяет найденные элементы)
    ✓ URL Normalization (автоматическое экранирование ★ -> %E2%98%85)
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
