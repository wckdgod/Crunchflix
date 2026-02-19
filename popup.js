// CLIENT_ID handled in background/auth


document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

const connectBtn = document.getElementById('connectBtn');
if (connectBtn) connectBtn.addEventListener('click', openAuthWindow);

const disconnectBtn = document.getElementById('disconnectBtn');
if (disconnectBtn) disconnectBtn.addEventListener('click', logout);

const settingsBtn = document.getElementById('settingsBtn');
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
}

function checkAuth() {
    chrome.storage.local.get(['trakt_token', 'nowPlaying'], (result) => {
        if (result.trakt_token) {
            showConnected(result.nowPlaying);
        } else {
            showDisconnected();
        }
    });

    // Listen for updates
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.trakt_token) {
                // If token appears, we are connected!
                checkAuth();
            }
            if (changes.nowPlaying) {
                updateNowPlaying(changes.nowPlaying.newValue);
            }
        }
    });
}

function openAuthWindow() {
    chrome.windows.create({
        url: 'auth.html',
        type: 'popup',
        width: 400,
        height: 600
    });
}

function showConnected(nowPlaying) {
    const authSection = document.getElementById('auth-section');
    const codeSection = document.getElementById('code-section');
    const connectedSection = document.getElementById('connected-section');

    // Use classList for visibility (Lint Compliant)
    if (authSection) authSection.classList.add('hidden'); // Hide Auth
    if (codeSection) codeSection.classList.add('hidden'); // Hide Code
    if (connectedSection) connectedSection.classList.remove('hidden'); // Show Connected

    updateNowPlaying(nowPlaying);
}

function updateNowPlaying(nowPlaying) {
    // Target elements directly within new HTML structure
    const npTitle = document.getElementById('np-title');
    const npStatus = document.getElementById('np-status');
    const npImage = document.getElementById('np-image');
    const heroBg = document.getElementById('hero-bg');
    const npSynopsis = document.getElementById('np-synopsis');

    // Robust Null Check
    if (!npTitle || !npStatus || !npImage) return;

    if (nowPlaying) {
        // Transparent Title Logic (v1.4)
        let display = nowPlaying.traktTitle || nowPlaying.title;
        if (nowPlaying.traktYear) display += ` (${nowPlaying.traktYear})`;

        if (nowPlaying.type === 'episode') {
            display += ` • S${nowPlaying.season} E${nowPlaying.episode}`;
        }

        const status = nowPlaying.status || 'scrobbling';

        // Status Badge Logic
        let badgeClass = `status-badge ${status}`;
        if (status === 'paused' || status === 'stopped') badgeClass = `status-badge ${status}`;

        let statusText = "Watching";
        if (status === 'paused') statusText = "Paused";
        if (status === 'stopped') statusText = "Stopped";
        if (status === 'scrobbling') statusText = "Scrobbling";
        if (status === 'not_found' || status === 'parse_error') {
            statusText = "Not Found";
            badgeClass = "status-badge error";
        }

        npStatus.className = badgeClass;
        npTitle.textContent = display;
        npStatus.textContent = statusText;

        // Synopsis
        if (npSynopsis) {
            npSynopsis.textContent = nowPlaying.synopsis || '';
            npSynopsis.style.display = nowPlaying.synopsis ? 'block' : 'none';
        }

        // Image Handling with Fallback
        if (nowPlaying.image) {
            npImage.src = nowPlaying.image;
            npImage.style.opacity = "1";
            if (heroBg) {
                heroBg.src = nowPlaying.image;
                heroBg.style.opacity = "0.8";
            }
        } else {
            // Placeholder Styling
            npImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; // Transparent
            npImage.style.opacity = "0"; // Hide foreground
            if (heroBg) {
                heroBg.src = "";
                heroBg.style.opacity = "0";
            }
        }

        npImage.style.display = 'block';

    } else {
        // Nothing playing state
        npTitle.textContent = "Waiting for video...";
        npStatus.className = "status-badge ready";
        npStatus.textContent = "Ready";
        if (npSynopsis) { npSynopsis.textContent = ''; npSynopsis.style.display = 'none'; }
        if (heroBg) {
            heroBg.src = "";
            heroBg.style.opacity = "0";
        }
        npImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        npImage.style.opacity = "0";
    }
}

function showDisconnected() {
    const authSection = document.getElementById('auth-section');
    const codeSection = document.getElementById('code-section');
    const connectedSection = document.getElementById('connected-section');

    if (authSection) authSection.classList.remove('hidden'); // Show Auth
    if (connectedSection) connectedSection.classList.add('hidden'); // Hide Connected
    if (codeSection) codeSection.classList.add('hidden'); // Hide Code
}

function logout() {
    chrome.storage.local.remove(['trakt_token', 'nowPlaying'], () => {
        showDisconnected();
    });
}

// --- Fix Match Logic ---
const fixMatchBtn = document.getElementById('fixMatchBtn');
if (fixMatchBtn) {
    fixMatchBtn.addEventListener('click', () => {
        const fixSection = document.getElementById('fix-section');
        if (fixSection) {
            // Toggle Hidden Class
            if (fixSection.classList.contains('hidden')) {
                fixSection.classList.remove('hidden');
            } else {
                fixSection.classList.add('hidden');
            }
        }
    });
}

const fixCancelBtn = document.getElementById('fixCancelBtn');
if (fixCancelBtn) {
    fixCancelBtn.addEventListener('click', () => {
        const fixSection = document.getElementById('fix-section');
        const fixStatus = document.getElementById('fix-status');
        if (fixSection) fixSection.classList.add('hidden');
        if (fixStatus) fixStatus.textContent = '';
    });
}

const fixSaveBtn = document.getElementById('fixSaveBtn');
if (fixSaveBtn) {
    fixSaveBtn.addEventListener('click', () => {
        const fixInput = document.getElementById('fixInput');
        if (!fixInput) return;

        const input = fixInput.value.trim();
        if (!input) return;

        const statusDiv = document.getElementById('fix-status');
        if (statusDiv) {
            statusDiv.textContent = "Resolving...";
            statusDiv.style.color = "#aaa";
        }

        // Get current nowPlaying title to serve as Key
        chrome.storage.local.get(['nowPlaying'], (result) => {
            if (!result.nowPlaying || !result.nowPlaying.title) {
                if (statusDiv) {
                    statusDiv.textContent = "Error: No active show to fix.";
                    statusDiv.style.color = "#ff5252";
                }
                return;
            }

            const originalTitle = result.nowPlaying.title; // The source title

            chrome.runtime.sendMessage({
                action: "setCorrection",
                data: { originalTitle: originalTitle, correctionInput: input }
            }, (response) => {
                if (statusDiv) {
                    if (response && response.success) {
                        statusDiv.textContent = `Saved! Mapped to: ${response.show.title}`;
                        statusDiv.style.color = "#69f0ae";
                        setTimeout(() => {
                            const fixSection = document.getElementById('fix-section');
                            if (fixSection) fixSection.classList.add('hidden');
                            statusDiv.textContent = '';
                        }, 2000);
                    } else {
                        statusDiv.textContent = "Error: " + (response?.error || "Unknown");
                        statusDiv.style.color = "#ff5252";
                    }
                }
            });
        });
    });
}
