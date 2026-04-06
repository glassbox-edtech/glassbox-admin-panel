// ==========================================
// 🔔 GLASSBOX ADMIN SERVICE WORKER
// Handles background push notifications and quick actions
// ==========================================

const DEBUG_MODE = true; // 🎯 Set to false to disable diagnostic log popups

// 1. Minimal IndexedDB wrapper to securely store credentials across browser restarts
function getDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('glassbox-sw-db', 1);
        req.onupgradeneeded = (e) => {
            e.target.result.createObjectStore('config');
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e);
    });
}

async function getConfig(key) {
    const db = await getDb();
    return new Promise((resolve) => {
        const tx = db.transaction('config', 'readonly');
        const store = tx.objectStore('config');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

// 2. Listen for messages from the open admin.html dashboard to save the login info
self.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'SET_CREDENTIALS') {
        const db = await getDb();
        const tx = db.transaction('config', 'readwrite');
        const store = tx.objectStore('config');
        store.put(event.data.workerUrl, 'workerUrl');
        store.put(event.data.adminSecret, 'adminSecret');
    }
});

// 3. Listen for incoming Web Push Notifications from Cloudflare
self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    
    const title = "New Unblock Request";
    const options = {
        body: `URL: ${data.url}\nReason: ${data.reason}`,
        icon: 'https://cdn-icons-png.flaticon.com/512/2040/2040504.png', // Placeholder shield icon
        badge: 'https://cdn-icons-png.flaticon.com/512/2040/2040504.png',
        tag: data.requestId ? `req-${data.requestId}` : 'new-req', // 🎯 FIX 1: Force Android to create a unique UI state
        data: data, // Stores the requestId and target for the button clicks
        actions: [
            // 🎯 FIX 2: Remove Emojis and use pure alphanumeric strings to prevent Android Intent parsing bugs
            { action: 'APPROVEREQ', title: 'Approve' },
            { action: 'DENYREQ', title: 'Deny' }
        ],
        requireInteraction: true // Keeps the notification open until clicked
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// 4. Handle Quick Action button clicks
self.addEventListener('notificationclick', function(event) {
    event.notification.close(); // Instantly close the popup

    const clickedAction = event.action;
    const data = event.notification.data || {};

    // --- START DIAGNOSTIC LOG ---
    let dbgOutput = `--- GLASSBOX SW DIAGNOSTICS ---\n`;
    dbgOutput += `1. Raw Action: "${clickedAction}"\n`;
    dbgOutput += `2. Raw Data: ${JSON.stringify(data)}\n`;

    // If they just clicked the body of the notification, open the dashboard
    if (!clickedAction) {
        event.waitUntil(clients.openWindow(self.registration.scope));
        return;
    }

    const normalizedAction = clickedAction.toLowerCase().trim();
    dbgOutput += `3. Normalized Action: "${normalizedAction}"\n`;

    // 🎯 FIX 3: Translate the new alphanumeric IDs back to the API standard
    let apiAction = null;
    if (normalizedAction === 'approvereq' || normalizedAction === 'approve') {
        apiAction = 'approve';
    } else if (normalizedAction === 'denyreq' || normalizedAction === 'deny') {
        apiAction = 'deny';
    }

    // If they clicked Approve or Deny, fire off the API request!
    if (apiAction) {
        event.waitUntil((async () => {
            try {
                const workerUrl = await getConfig('workerUrl');
                const adminSecret = await getConfig('adminSecret');

                dbgOutput += `4. Auth Loaded: URL=${!!workerUrl}, Secret=${!!adminSecret}\n`;
                dbgOutput += `-> Mapped API Action: ${apiAction}\n`;

                if (!workerUrl || !adminSecret) {
                    dbgOutput += `❌ ERROR: Missing credentials in IndexedDB.\n`;
                    if (DEBUG_MODE) await openDebugLog(dbgOutput);
                    return;
                }

                let finalTarget = data.url;
                let finalMatchType = data.matchType || 'domain';

                try {
                    let cleanUrl = (data.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
                    if (cleanUrl.includes('/') && cleanUrl.split('/')[1] !== '') {
                        finalTarget = cleanUrl;
                        finalMatchType = 'path';
                    } else {
                        finalTarget = cleanUrl.replace(/\/$/, '');
                        finalMatchType = 'domain';
                    }
                } catch (e) {
                    dbgOutput += `⚠️ URL parse warning.\n`;
                }

                const cleanWorkerUrl = workerUrl.endsWith('/') ? workerUrl.slice(0, -1) : workerUrl;
                
                const payload = {
                    requestId: data.requestId,
                    action: apiAction, 
                    target: finalTarget,
                    matchType: finalMatchType
                };
                
                dbgOutput += `5. Payload: ${JSON.stringify(payload)}\n`;
                dbgOutput += `6. Sending POST to: ${cleanWorkerUrl}/api/admin/filter/resolve\n`;

                const response = await fetch(`${cleanWorkerUrl}/api/admin/filter/resolve`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${adminSecret}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                
                const responseText = await response.text();
                dbgOutput += `7. Server Status: ${response.status}\n`;
                dbgOutput += `8. Server Response: ${responseText}\n`;
                
                if (DEBUG_MODE) await openDebugLog(dbgOutput);
                
            } catch (err) {
                dbgOutput += `❌ CRITICAL EXCEPTION: ${err.message}\n`;
                if (DEBUG_MODE) await openDebugLog(dbgOutput);
            }
        })());
    } else {
        dbgOutput += `❌ ERROR: Action did not map to 'approve' or 'deny'.\n`;
        if (DEBUG_MODE) event.waitUntil(openDebugLog(dbgOutput));
    }
});

// Helper function to generate an on-the-fly debug tab
async function openDebugLog(logText) {
    const html = `
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>SW Debug Log</title>
            <style>
                body { font-family: monospace; padding: 1rem; background: #1e1e1e; color: #00ff00; }
                h2 { color: #fff; font-family: sans-serif; margin-top: 0; }
                pre { white-space: pre-wrap; word-break: break-all; font-size: 14px; line-height: 1.5; }
            </style>
        </head>
        <body>
            <h2>📡 Glassbox SW Log</h2>
            <pre>${logText}</pre>
        </body>
        </html>
    `;
    const dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    return clients.openWindow(dataUri);
}