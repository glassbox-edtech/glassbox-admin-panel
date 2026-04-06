// ==========================================
// 🔔 GLASSBOX ADMIN SERVICE WORKER
// Handles background push notifications and quick actions
// ==========================================

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
        data: data, // Stores the requestId and target for the button clicks
        actions: [
            { action: 'approve', title: '✅ Approve' },
            { action: 'deny', title: '❌ Deny' }
        ],
        requireInteraction: true // Keeps the notification open until clicked
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// 4. Handle Quick Action button clicks
self.addEventListener('notificationclick', function(event) {
    event.notification.close(); // Instantly close the popup

    const clickedAction = event.action;
    const data = event.notification.data;

    // If they just clicked the body of the notification, open the dashboard
    if (!clickedAction) {
        event.waitUntil(clients.openWindow(self.registration.scope));
        return;
    }

    // 🎯 FIX 1: Normalize the action to lowercase to prevent OS-level capitalization bugs
    const normalizedAction = clickedAction.toLowerCase();

    // If they clicked Approve or Deny, fire off the API request!
    if (normalizedAction === 'approve' || normalizedAction === 'deny') {
        event.waitUntil((async () => {
            try {
                const workerUrl = await getConfig('workerUrl');
                const adminSecret = await getConfig('adminSecret');

                if (!workerUrl || !adminSecret) {
                    console.error("Missing credentials in SW. Cannot perform quick action.");
                    return;
                }

                let finalTarget = data.url;
                let finalMatchType = data.matchType || 'domain';

                try {
                    let cleanUrl = data.url.replace(/^https?:\/\//, '').replace(/^www\./, '');
                    if (cleanUrl.includes('/') && cleanUrl.split('/')[1] !== '') {
                        finalTarget = cleanUrl;
                        finalMatchType = 'path';
                    } else {
                        finalTarget = cleanUrl.replace(/\/$/, '');
                        finalMatchType = 'domain';
                    }
                } catch (e) {
                    console.warn("Could not parse URL intelligently, using raw input.");
                }

                // 🎯 FIX 2: Ensure the worker URL never has a trailing slash before appending our path
                const cleanWorkerUrl = workerUrl.endsWith('/') ? workerUrl.slice(0, -1) : workerUrl;

                console.log(`[SW] Firing ${normalizedAction} for request ID: ${data.requestId}`);

                // Fire the exact same POST request the dashboard uses
                const response = await fetch(`${cleanWorkerUrl}/api/admin/filter/resolve`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${adminSecret}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        requestId: data.requestId,
                        action: normalizedAction,
                        target: finalTarget,
                        matchType: finalMatchType
                    })
                });
                
                // 🎯 FIX 3: Log the exact server response to the SW console for debugging
                const responseText = await response.text();
                console.log(`[SW] Server responded: ${response.status} - ${responseText}`);
                
            } catch (err) {
                console.error("Quick Action failed:", err);
            }
        })());
    }
});