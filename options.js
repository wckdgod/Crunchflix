document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('saveBtn').addEventListener('click', saveOptions);

function saveOptions() {
    const clientId = document.getElementById('clientId').value.trim();
    const clientSecret = document.getElementById('clientSecret').value.trim();
    const tmdbApiKey = document.getElementById('tmdbApiKey').value.trim();
    const deepseekApiKey = document.getElementById('deepseekApiKey').value.trim();
    const status = document.getElementById('status');

    if (!clientId || !clientSecret) {
        showStatus('Please enter both Simkl Client ID and Client Secret.', 'error');
        return;
    }

    chrome.storage.local.set({
        client_id: clientId,
        client_secret: clientSecret,
        tmdb_api_key: tmdbApiKey,
        deepseek_api_key: deepseekApiKey
    }, () => {
        showStatus('Settings saved successfully!', 'success');

        // Notify background script to refresh configuration if needed
        chrome.runtime.sendMessage({ action: "configUpdated" });
    });
}

function restoreOptions() {
    chrome.storage.local.get(['client_id', 'client_secret', 'tmdb_api_key', 'deepseek_api_key'], (items) => {
        document.getElementById('clientId').value = items.client_id || "a63b63d85af0e02d4cfc791d87c881f710693ecc86d280fc98f8618f8f1faaad";
        document.getElementById('clientSecret').value = items.client_secret || "9df1b7e078119eec54b694c216667be23f5a0c434aa7e7792e1ddbffb7d47336";
        if (items.tmdb_api_key) document.getElementById('tmdbApiKey').value = items.tmdb_api_key;
        if (items.deepseek_api_key) document.getElementById('deepseekApiKey').value = items.deepseek_api_key;
    });
}

function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = 'status ' + type;
    status.style.display = 'block';

    if (type === 'success') {
        setTimeout(() => {
            status.style.display = 'none';
        }, 3000);
    }
}
