document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('saveBtn').addEventListener('click', saveOptions);
document.getElementById('testBtn').addEventListener('click', testConnection);

function normalizeUrl(url) {
    if (!url) return (typeof DEFAULT_SCROB_URL !== 'undefined' ? DEFAULT_SCROB_URL : "http://localhost:7330");
    return url.trim().replace(/\/+$/, '');
}

function saveOptions() {
    const scrobUrl = normalizeUrl(document.getElementById('scrobUrl').value);
    const scrobApiKey = document.getElementById('scrobApiKey').value.trim();
    const scrobTokenVal = document.getElementById('scrobToken').value.trim();
    const tmdbApiKey = document.getElementById('tmdbApiKey').value.trim();
    const deepseekApiKey = document.getElementById('deepseekApiKey').value.trim();

    if (!scrobApiKey && !scrobTokenVal) {
        showStatus('Please enter a Scrob API Key or authenticate via the Connect button.', 'error');
        return;
    }

    const saveData = {
        scrob_url: scrobUrl,
        scrob_api_key: scrobApiKey,
        tmdb_api_key: tmdbApiKey,
        deepseek_api_key: deepseekApiKey
    };

    if (scrobTokenVal) {
        saveData.scrob_token = scrobTokenVal;
    }

    chrome.storage.local.set(saveData, () => {
        showStatus('Settings saved successfully! Scrob configuration updated.', 'success');
        chrome.runtime.sendMessage({ action: "configUpdated" });
    });
}

function restoreOptions() {
    chrome.storage.local.get(['scrob_url', 'scrob_api_key', 'scrob_token', 'tmdb_api_key', 'deepseek_api_key'], (items) => {
        document.getElementById('scrobUrl').value = items.scrob_url || (typeof DEFAULT_SCROB_URL !== 'undefined' ? DEFAULT_SCROB_URL : "http://localhost:7330");
        document.getElementById('scrobApiKey').value = items.scrob_api_key || "";
        
        if (items.scrob_token) {
            const tokenStr = typeof items.scrob_token === 'string' ? items.scrob_token : (items.scrob_token.access_token || '');
            document.getElementById('scrobToken').value = tokenStr;
        }
        if (items.tmdb_api_key) document.getElementById('tmdbApiKey').value = items.tmdb_api_key;
        if (items.deepseek_api_key) document.getElementById('deepseekApiKey').value = items.deepseek_api_key;
    });
}

async function testConnection() {
    const scrobUrl = normalizeUrl(document.getElementById('scrobUrl').value);
    const scrobApiKey = document.getElementById('scrobApiKey').value.trim();
    const scrobTokenVal = document.getElementById('scrobToken').value.trim();

    showStatus('Testing connection to Scrob server...', '');
    const statusDiv = document.getElementById('status');
    statusDiv.style.display = 'block';
    statusDiv.className = 'status';
    statusDiv.textContent = 'Connecting to ' + scrobUrl + '...';

    try {
        const headers = getScrobHeaders(scrobTokenVal || null, scrobApiKey || null);

        // 1. Test unauthenticated /health or authenticated proxy
        const healthUrl = getScrobUrl('/health', scrobUrl);
        const healthRes = await fetch(healthUrl, { method: 'GET', headers });
        if (healthRes.status === 401 || healthRes.status === 403) {
            throw new Error('Server reachable, but credentials rejected (HTTP ' + healthRes.status + '). Please check your API Key.');
        }
        if (!healthRes.ok) {
            throw new Error(`Server returned HTTP ${healthRes.status} from ${healthUrl}`);
        }
        const healthData = await healthRes.json().catch(() => ({}));
        if (healthData.status !== 'ok') {
            throw new Error(`Scrob health status: ${healthData.status || 'unknown'}`);
        }

        // 2. Test authenticated endpoint
        if (scrobApiKey || scrobTokenVal) {
            const authUrl = getScrobUrl('/history/now-playing', scrobUrl);
            const authTestRes = await fetch(authUrl, {
                method: 'GET',
                headers: headers
            });

            if (authTestRes.status === 401 || authTestRes.status === 403) {
                throw new Error('Server reachable, but credentials rejected (HTTP ' + authTestRes.status + '). Please check your API Key or Access Token.');
            }
            if (!authTestRes.ok) {
                throw new Error(`Authenticated request failed with HTTP ${authTestRes.status}`);
            }

            showStatus(`Connected successfully! Scrob server at ${scrobUrl} is online and API key is valid.`, 'success');
        } else {
            showStatus(`Scrob server at ${scrobUrl} is online and healthy. (No API Key entered yet).`, 'success');
        }
    } catch (err) {
        showStatus(`Connection failed: ${err.message}`, 'error');
    }
}

function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = 'status ' + (type || '');
    status.style.display = 'block';

    if (type === 'success') {
        setTimeout(() => {
            status.style.display = 'none';
        }, 5000);
    }
}
