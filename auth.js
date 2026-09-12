// config.js is loaded prior to auth.js

let currentScrobUrl = DEFAULT_SCROB_URL;
let pollIntervalTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['scrob_url'], (data) => {
        if (data.scrob_url) {
            currentScrobUrl = normalizeBaseUrl(data.scrob_url);
        }
        const serverInput = document.getElementById('serverUrlInput');
        if (serverInput) serverInput.value = currentScrobUrl;

        startAuth(currentScrobUrl);
    });

    const startBtn = document.getElementById('startAuthBtn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            const inputVal = document.getElementById('serverUrlInput').value.trim();
            currentScrobUrl = normalizeBaseUrl(inputVal);
            chrome.storage.local.set({ scrob_url: currentScrobUrl });
            startAuth(currentScrobUrl);
        });
    }
});

async function startAuth(serverUrl) {
    showLoading("Connecting to Scrob server at " + serverUrl + "...");
    hideError();

    try {
        const codeUrl = getScrobUrl('/auth/device/code', serverUrl);
        const response = await fetch(codeUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                client_name: APP_NAME,
                scope: "write"
            })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Failed to request code from Scrob (${response.status}): ${errText || 'Server unreachable'}`);
        }

        const data = await response.json();
        if (!data.device_code || !data.user_code) {
            throw new Error('Invalid response from Scrob device flow.');
        }

        const userCode = data.user_code;
        const verificationUrl = data.verification_uri_complete || data.verification_uri || `${serverUrl}/link`;
        const interval = data.interval || 5;

        document.getElementById('loading').style.display = 'none';
        document.getElementById('setup-step').style.display = 'none';
        document.getElementById('auth-content').style.display = 'block';
        document.getElementById('userCode').textContent = userCode;

        const link = document.getElementById('verificationLink');
        link.href = verificationUrl;

        pollForToken(serverUrl, data.device_code, interval);

    } catch (error) {
        showError(error.message);
        document.getElementById('setup-step').style.display = 'block';
    }
}

function pollForToken(serverUrl, deviceCode, interval) {
    if (pollIntervalTimer) clearInterval(pollIntervalTimer);

    let pollIntervalSeconds = interval || 5;

    pollIntervalTimer = setInterval(async () => {
        try {
            const tokenUrl = getScrobUrl('/auth/device/token', serverUrl);
            const response = await fetch(tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    device_code: deviceCode
                })
            });

            if (response.ok) {
                const data = await response.json();
                if (data.access_token) {
                    clearInterval(pollIntervalTimer);

                    const storagePayload = {
                        scrob_url: serverUrl,
                        scrob_token: data.access_token
                    };
                    if (data.refresh_token) {
                        storagePayload.scrob_refresh_token = data.refresh_token;
                    }

                    chrome.storage.local.set(storagePayload, () => {
                        chrome.runtime.sendMessage({ action: "configUpdated" });
                        document.getElementById('auth-content').innerHTML = `
                            <h3 style="color: #81c784;">Authorized Successfully!</h3>
                            <p>Connected to Scrob at ${serverUrl}. Closing window...</p>
                        `;
                        setTimeout(() => window.close(), 1000);
                    });
                }
            } else {
                const errData = await response.json().catch(() => ({}));
                const err = errData.error || errData.detail;
                if (err === 'slow_down') {
                    pollIntervalSeconds += 5;
                } else if (err === 'expired_token') {
                    clearInterval(pollIntervalTimer);
                    showError("Authorization code expired. Please restart authorization.");
                    document.getElementById('setup-step').style.display = 'block';
                } else if (err === 'access_denied') {
                    clearInterval(pollIntervalTimer);
                    showError("Access was denied in Scrob.");
                    document.getElementById('setup-step').style.display = 'block';
                }
                // authorization_pending: keep waiting
            }
        } catch (error) {
            console.error('Error polling Scrob token:', error);
        }
    }, pollIntervalSeconds * 1000);
}

function showLoading(msg) {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('loading-text').textContent = msg;
    document.getElementById('auth-content').style.display = 'none';
}

function showError(msg) {
    const errDiv = document.getElementById('error');
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
    document.getElementById('loading').style.display = 'none';
}

function hideError() {
    const errDiv = document.getElementById('error');
    errDiv.style.display = 'none';
}
