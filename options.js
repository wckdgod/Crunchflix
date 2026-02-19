document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('saveBtn').addEventListener('click', saveOptions);

function saveOptions() {
    const clientId = document.getElementById('clientId').value.trim();
    const clientSecret = document.getElementById('clientSecret').value.trim();
    const tmdbApiKey = document.getElementById('tmdbApiKey').value.trim();
    const status = document.getElementById('status');

    if (!clientId || !clientSecret) {
        showStatus('Please enter both Trakt Client ID and Client Secret.', 'error');
        return;
    }

    chrome.storage.local.set({
        client_id: clientId,
        client_secret: clientSecret,
        tmdb_api_key: tmdbApiKey
    }, () => {
        showStatus('Settings saved successfully!', 'success');
        
        // Notify background script to refresh configuration if needed
        chrome.runtime.sendMessage({ action: "configUpdated" });
    });
}

function restoreOptions() {
    chrome.storage.local.get(['client_id', 'client_secret', 'tmdb_api_key'], (items) => {
        if (items.client_id) document.getElementById('clientId').value = items.client_id;
        if (items.client_secret) document.getElementById('clientSecret').value = items.client_secret;
        if (items.tmdb_api_key) document.getElementById('tmdbApiKey').value = items.tmdb_api_key;
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
