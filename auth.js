import { API_URL } from './config.js';

async function startAuth() {
    try {
        const keys = await getApiKeys();
        if (!keys) return; // Error handled in getApiKeys

        const response = await fetch(`${API_URL}/oauth/device/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: keys.clientId })
        });

        if (!response.ok) throw new Error('Failed to get code from Trakt. Check Client ID.');

        const data = await response.json();
        const userCode = data.user_code;
        const verificationUrl = data.verification_url;
        const interval = data.interval;
        const deviceCode = data.device_code;

        document.getElementById('loading').style.display = 'none';
        document.getElementById('auth-content').style.display = 'block';
        document.getElementById('userCode').textContent = userCode;

        const link = document.getElementById('verificationLink');
        link.href = verificationUrl;
        link.textContent = verificationUrl;

        pollForToken(deviceCode, interval, keys.clientId, keys.clientSecret);

    } catch (error) {
        showError(error.message);
    }
}

function pollForToken(deviceCode, interval, clientId, clientSecret) {
    const pollInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_URL}/oauth/device/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: deviceCode,
                    client_id: clientId,
                    client_secret: clientSecret
                })
            });

            if (response.status === 200) {
                const data = await response.json();
                clearInterval(pollInterval);

                // Save token and close
                chrome.storage.local.set({ 'trakt_token': data }, () => {
                    // Slight delay to ensure storage writes
                    setTimeout(() => window.close(), 500);
                });

            } else if (response.status === 404 || response.status === 409 || response.status === 410) {
                clearInterval(pollInterval);
                showError("Authorization expired. Please try again.");
            }
            // 400 = Pending, continue polling
        } catch (error) {
            console.error(error);
            // Don't modify UI on network glitches during poll, just retry
        }
    }, interval * 1000);
}

async function getApiKeys() {
    const storage = await chrome.storage.local.get(['client_id', 'client_secret']);
    if (!storage.client_id || !storage.client_secret) {
        showError("Trakt API Keys missing. Please configure them in Settings.");
        return null;
    }
    return { clientId: storage.client_id, clientSecret: storage.client_secret };
}

function showError(msg) {
    const errDiv = document.getElementById('error');
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
    document.getElementById('loading').style.display = 'none';
    document.getElementById('auth-content').style.display = 'none';
}

startAuth();
