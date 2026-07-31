const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9999;
const LOG_FILE = path.join(__dirname, 'remote_logs.txt');

const server = http.createServer((req, res) => {
    // Enable CORS for the extension
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const timestamp = new Date().toISOString();
                const logEntry = `[${timestamp}] [${data.level || 'INFO'}] [${data.context || 'GEN'}] ${data.message}\n`;
                
                fs.appendFileSync(LOG_FILE, logEntry);
                process.stdout.write(logEntry); // Also show in terminal
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`[CRUNCHFLIX] AI Remote Logger active on port ${PORT}`);
    console.log(`[CRUNCHFLIX] Writing to: ${LOG_FILE}`);
    
    // Clear log file on start to avoid confusion with old logs
    fs.writeFileSync(LOG_FILE, `--- LOG STARTED AT ${new Date().toISOString()} ---\n`);
});
