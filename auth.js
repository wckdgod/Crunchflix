import { CLIENT_ID, CLIENT_SECRET, getSimklUrl, getSimklHeaders } from './config.js';

async function startAuth() {
    try {
        const clientId = CLIENT_ID;
        const pinUrl = getSimklUrl('/oauth/pin');

        const response = await fetch(pinUrl, {
            method: 'GET',
            headers: getSimklHeaders()
        });

        if (!response.ok) throw new Error('Failed to get PIN from Simkl. Check API credentials.');

        const data = await response.json();
        if (data.result !== 'OK' || !data.user_code) {
            throw new Error(data.message || 'Invalid response from Simkl PIN service.');
        }

        const userCode = data.user_code;
        const verificationUrl = data.verification_url || data.verification_uri || 'https://simkl.com/pin';
        const interval = data.interval || 5;

        document.getElementById('loading').style.display = 'none';
        document.getElementById('auth-content').style.display = 'block';
        document.getElementById('userCode').textContent = userCode;

        const link = document.getElementById('verificationLink');
        link.href = verificationUrl;
        link.textContent = verificationUrl;

        pollForToken(userCode, interval, clientId);

    } catch (error) {
        showError(error.message);
    }
}

function pollForToken(userCode, interval, clientId) {
    const pollInterval = setInterval(async () => {
        try {
            const checkUrl = getSimklUrl(`/oauth/pin/${userCode}`);
            const response = await fetch(checkUrl, {
                method: 'GET',
                headers: getSimklHeaders()
            });

            if (response.ok) {
                const data = await response.json();
                if (data.result === 'OK' && data.access_token) {
                    clearInterval(pollInterval);

                    const tokenData = {
                        access_token: data.access_token,
                        created_at: Math.floor(Date.now() / 1000)
                    };

                    chrome.storage.local.set({ 'simkl_token': tokenData, 'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET }, () => {
                        setTimeout(() => window.close(), 500);
                    });
                } else if (data.result === 'KO' && data.message === 'Authorization expired') {
                    clearInterval(pollInterval);
                    showError("Authorization expired. Please try again.");
                }
                // Pending, continue polling
            }
        } catch (error) {
            console.error('Error polling Simkl token:', error);
        }
    }, interval * 1000);
}

function showError(msg) {
    const errDiv = document.getElementById('error');
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
    document.getElementById('loading').style.display = 'none';
    document.getElementById('auth-content').style.display = 'none';
}

startAuth();
