const express = require('express');
const http = require('http');
const { chromium } = require('playwright');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ================== CONFIGURATION ==================
const MAX_CONCURRENT_TASKS = 3; 

// ================== CRASH PREVENTION ==================
process.on('unhandledRejection', (err) => console.log('[UNHANDLED REJECTION]', err?.message || err));
process.on('uncaughtException', (err) => console.log('[UNCAUGHT EXCEPTION]', err?.message || err));
process.on('SIGTERM', async () => {
    for (const [id, t] of activeTasks.entries()) {
        t.isRunning = false;
        if (t.context) await t.context.close().catch(() => {});
    }
    process.exit(0);
});

// ================== GLOBAL BROWSER MANAGEMENT ==================
let GLOBAL_BROWSER = null;
const activeTasks = new Map();
const sleep = (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000));

async function getBrowser() {
    if (GLOBAL_BROWSER && GLOBAL_BROWSER.isConnected()) return GLOBAL_BROWSER;
    console.log('Launching fresh Chromium Instance...');
    GLOBAL_BROWSER = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--disable-gpu'
        ]
    });
    GLOBAL_BROWSER.on('disconnected', () => { GLOBAL_BROWSER = null; });
    return GLOBAL_BROWSER;
}

function parseCookies(cookieStr) {
    return cookieStr.split(';').map(pair => {
        const [name, ...rest] = pair.trim().split('=');
        if (!name || rest.length === 0) return null;
        return {
            name: name.trim(), value: rest.join('=').trim(),
            domain: '.messenger.com', path: '/',
            httpOnly: false, secure: true, sameSite: 'Lax'
        };
    }).filter(Boolean);
}

// ================== SESSION SETUP ==================
async function setupSession(cookiesStr, threadId, e2eePin, addLog) {
    const browser = await getBrowser();
    
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        deviceScaleFactor: 1, isMobile: false, hasTouch: false, locale: 'en-US'
    });

    const parsedCookies = parseCookies(cookiesStr);
    await context.addCookies(parsedCookies);
    const page = await context.newPage();

    addLog(`Navigating to Thread: ${threadId}`);
    await page.goto(`https://www.messenger.com/t/${threadId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (e2eePin) {
        try {
            const pinSelector = 'input[type="password"], input[aria-label*="PIN"], input[placeholder*="PIN"]';
            const pinInput = await page.waitForSelector(pinSelector, { timeout: 8000 }).catch(() => null);
            if (pinInput) {
                addLog(`E2EE PIN Prompt detected. Unlocking...`);
                await pinInput.click();
                await pinInput.fill(e2eePin);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(6000);
            }
        } catch (e) { addLog(`PIN Warning: ${e.message}`); }
    }

    return { browser, context, page };
}

// ================== FIXED E2EE DISPATCHER (AUTO-WAIT FOR CHATBOX) ==================
async function sendDirectE2EEMessage(page, threadId, textPayload, addLog) {
    try {
        const selector = 'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][aria-label*="Message"]';

        // Wait until Chatbox renders on UI
        const chatBoxHandle = await page.waitForSelector(selector, { state: 'visible', timeout: 15000 }).catch(() => null);

        if (!chatBoxHandle) {
            throw new Error("Chat input box not found (DOM Timeout)");
        }

        const sent = await page.evaluate(async ({ textPayload }) => {
            const chatBox = document.querySelector('div[role="textbox"][contenteditable="true"]') ||
                            document.querySelector('div[contenteditable="true"]');

            if (!chatBox) return { success: false, reason: "Chatbox handle lost" };

            chatBox.focus();

            // Direct TextNode Injection
            chatBox.innerHTML = '';
            const textNode = document.createTextNode(textPayload);
            chatBox.appendChild(textNode);

            // React State Event Trigger for E2EE Payload Encryption
            const inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: textPayload
            });
            chatBox.dispatchEvent(inputEvent);

            return { success: true };
        }, { textPayload });

        if (sent.success) {
            await page.waitForTimeout(200);
            await page.keyboard.press('Enter');
            
            addLog(`Direct E2EE Sent: "${textPayload.substring(0, 30)}..."`);
            return true;
        } else {
            throw new Error(sent.reason);
        }

    } catch (err) {
        addLog(`⚠️ Send Error: ${err.message}`);
        throw err;
    }
}

// ================== MAIN BOT LOOP ==================
async function runPlaywrightBot(taskId, cookiesStr, threadId, e2eePin, prefix, messages, delay) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const addLog = (msg) => {
        if (!task.logs) task.logs = [];
        task.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (task.logs.length > 100) task.logs.shift();
    };

    let context = null, page = null;
    let failureCount = 0;
    const MAX_FAILURES = 3;

    try {
        const session = await setupSession(cookiesStr, threadId, e2eePin, addLog);
        context = session.context; page = session.page;
        task.context = context;
        addLog(`Connected to Chat. Dispatcher Ready.`);

        let index = 0, msgCount = 0;

        while (task.isRunning) {
            if (!page || page.isClosed()) failureCount = MAX_FAILURES;

            const finalPayload = (prefix ? prefix + " " : "") + messages[index];

            try {
                await sendDirectE2EEMessage(page, threadId, finalPayload, addLog);
                failureCount = 0;
            } catch (err) {
                failureCount++;
                addLog(`⚠️ Failures: ${failureCount}/${MAX_FAILURES}`);

                if (failureCount >= MAX_FAILURES) {
                    addLog(`❌ Failure threshold reached. Recovering Session...`);
                    try { if (context) await context.close(); } catch(e) {}
                    try {
                        const newSession = await setupSession(cookiesStr, threadId, e2eePin, addLog);
                        context = newSession.context; page = newSession.page;
                        task.context = context;
                        failureCount = 0;
                        addLog(`✅ Session Recovered. Resuming...`);
                        continue;
                    } catch (e) {
                        addLog(`❌ Recovery Failed. Stopping Task.`);
                        task.isRunning = false; break;
                    }
                }
            }

            index = (index + 1) % messages.length;
            msgCount++;

            if (msgCount % 60 === 0) {
                addLog(`🔄 Memory Refreshing...`);
                try { 
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); 
                    await page.waitForTimeout(4000); 
                } catch(e) {}
            }

            for (let i = 0; i < delay; i++) {
                if (!task.isRunning) break;
                await sleep(1);
            }
        }
    } catch (err) {
        addLog(`FATAL ERROR: ${err.message}`);
    } finally {
        task.isRunning = false;
        if (context) await context.close().catch(()=>{});
    }
}

// ================== DASHBOARD UI ==================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messenger Web-API Bot</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
        .container { max-width: 700px; margin: auto; background: #1e293b; padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
        h2 { color: #38bdf8; text-align: center; margin-bottom: 5px; }
        .tag { text-align: center; color: #94a3b8; font-size: 12px; margin-bottom: 20px; font-weight: bold; letter-spacing: 1px; }
        label { display: block; margin-top: 15px; font-size: 13px; color: #cbd5e1; }
        input, textarea { width: 100%; padding: 10px; margin-top: 5px; background: #0f172a; border: 1px solid #334155; color: #fff; border-radius: 6px; box-sizing: border-box; }
        button { width: 100%; padding: 12px; margin-top: 20px; background: #0284c7; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        button:hover { background: #0369a1; }
        .log-box { background: #000; height: 220px; overflow-y: auto; padding: 10px; margin-top: 20px; font-family: monospace; font-size: 12px; border-radius: 6px; color: #4ade80; border: 1px solid #334155; }
        .row { display: flex; gap: 10px; align-items: flex-end; }
        .btn-view { background: #6366f1; width: auto; padding: 10px 20px; }
        .btn-stop { background: #ef4444; width: auto; padding: 10px 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Messenger Web-API Bot</h2>
        <div class="tag">DIRECT E2EE DISPATCHER EDITION</div>
        
        <form id="botForm" onsubmit="event.preventDefault(); startTask();">
            <label>Messenger Cookie:</label>
            <textarea id="cookies" rows="3" placeholder="c_user=...; xs=...;" required></textarea>
            
            <label>Target UID / Thread ID:</label>
            <input type="text" id="threadId" placeholder="1000XXXXXXXXX" required>
            
            <label>E2EE PIN (Optional):</label>
            <input type="password" id="e2eePin">
            
            <label>Prefix (Optional):</label>
            <input type="text" id="prefix">
            
            <label>Message File (.txt):</label>
            <input type="file" id="msgFile" accept=".txt" required>
            
            <label>Delay (Seconds):</label>
            <input type="number" id="delay" value="30" min="5" required>
            
            <button type="submit" id="startBtn">START TASK</button>
        </form>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #334155;">
            <label>Monitor Task ID:</label>
            <div class="row">
                <input type="text" id="taskId" placeholder="TASK-XXXXXX">
                <button type="button" class="btn-view" onclick="viewTask()">VIEW</button>
                <button type="button" class="btn-stop" onclick="stopTask()">STOP</button>
            </div>
            <div class="log-box" id="logBox">Waiting for logs...</div>
        </div>
    </div>

    <script>
        let poll = null;

        async function startTask() {
            const startBtn = document.getElementById('startBtn');
            const cookies = document.getElementById('cookies').value.trim();
            const threadId = document.getElementById('threadId').value.trim();
            const e2eePin = document.getElementById('e2eePin').value.trim();
            const prefix = document.getElementById('prefix').value.trim();
            const delay = document.getElementById('delay').value;
            const fileInput = document.getElementById('msgFile');

            if (!cookies) return alert('Cookies daalna zaroori hai!');
            if (!threadId) return alert('Target UID daalna zaroori hai!');
            if (!fileInput.files || fileInput.files.length === 0) return alert('Message .txt file select karein!');

            startBtn.disabled = true;
            startBtn.innerText = "STARTING TASK...";

            try {
                const file = fileInput.files[0];
                const text = await file.text();
                const messages = text.split('\n').map(m => m.trim()).filter(m => m.length > 0);

                if (messages.length === 0) {
                    alert('Select ki hui file empty hai!');
                    startBtn.disabled = false;
                    startBtn.innerText = "START TASK";
                    return;
                }

                const res = await fetch('/api/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ cookies, threadId, e2eePin, prefix, messages, delay })
                });

                const data = await res.json();

                if (data.success) {
                    document.getElementById('taskId').value = data.taskId;
                    alert('Task successfully start ho gaya hai! Task ID: ' + data.taskId);
                    viewTask();
                } else {
                    alert('Error: ' + data.message);
                }
            } catch (err) {
                console.error(err);
                alert('Task start karne mein error aaya.');
            } finally {
                startBtn.disabled = false;
                startBtn.innerText = "START TASK";
            }
        }

        function viewTask() {
            const id = document.getElementById('taskId').value.trim();
            if (!id) return alert('Task ID daalein!');
            if (poll) clearInterval(poll);
            
            poll = setInterval(async () => {
                try {
                    const res = await fetch('/api/status/' + id);
                    const data = await res.json();
                    if(data.found) {
                        document.getElementById('logBox').innerHTML = data.logs.join('<br>') + '<br><br>Status: ' + (data.isRunning ? '<b style="color:#4ade80">Running</b>' : '<b style="color:#ef4444">Stopped</b>');
                    } else {
                        document.getElementById('logBox').innerText = 'Task ID Not Found!';
                    }
                } catch(e) {}
            }, 2000);
        }

        async function stopTask() {
            const taskId = document.getElementById('taskId').value.trim();
            if (!taskId) return alert('Task ID daalein!');
            await fetch('/api/stop', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ taskId }) });
            alert('Stop signal bhej diya gaya hai.');
        }
    </script>
</body>
</html>
    `);
});

// ================== API ENDPOINTS ==================
app.post('/api/start', async (req, res) => {
    if (Array.from(activeTasks.values()).filter(t => t.isRunning).length >= MAX_CONCURRENT_TASKS) {
        return res.status(400).json({ success: false, message: 'Server Max Task Limit Reached!' });
    }
    const { cookies, threadId, e2eePin, prefix, messages, delay } = req.body;
    const taskId = "TASK-" + Math.floor(100000 + Math.random() * 900000);
    
    activeTasks.set(taskId, { taskId, isRunning: true, logs: [`[${new Date().toLocaleTimeString()}] Task Started.`], context: null });
    runPlaywrightBot(taskId, cookies, threadId, e2eePin, prefix, messages, delay).catch(e => console.log(e));
    res.json({ success: true, taskId });
});

app.get('/api/status/:id', (req, res) => {
    const task = activeTasks.get(req.params.id);
    res.json(task ? { found: true, isRunning: task.isRunning, logs: task.logs } : { found: false });
});

app.post('/api/stop', async (req, res) => {
    const task = activeTasks.get(req.body.taskId);
    if (task) { 
        task.isRunning = false; 
        if (task.context) await task.context.close().catch(()=>{}); 
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
