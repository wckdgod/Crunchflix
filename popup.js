// CLIENT_ID handled in background/auth


document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

const connectBtn = document.getElementById('authBtn');
if (connectBtn) connectBtn.addEventListener('click', openAuthWindow);

const disconnectBtn = document.getElementById('disconnectBtn');
if (disconnectBtn) disconnectBtn.addEventListener('click', logout);

const settingsBtn = document.getElementById('settingsBtnAuth');
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
}

const settingsBtnConnected = document.getElementById('settingsBtn');
if (settingsBtnConnected) {
    settingsBtnConnected.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
}

const openHistoryBtn = document.getElementById('openHistoryBtn');
if (openHistoryBtn) {
    openHistoryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'history.html' });
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

    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "LIVE_PROGRESS") {
            const progressBar = document.getElementById('play-progress-bar');
            if (progressBar) progressBar.style.width = `${message.progress}%`;
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
    const npTitle = document.getElementById('np-title');
    const npEpisode = document.getElementById('np-episode');
    const npStatus = document.getElementById('np-status');
    const npImage = document.getElementById('np-image');
    const npBgImage = document.getElementById('np-bg-image');

    const metaYear = document.getElementById('meta-year');
    const metaRuntime = document.getElementById('meta-runtime');
    const metaGenres = document.getElementById('meta-genres');
    const npSynopsis = document.getElementById('synopsis-text');
    const progressBar = document.getElementById('play-progress-bar');

    if (!npTitle || !npStatus || !npImage) return;

    if (nowPlaying) {
        // Build display title
        let display = nowPlaying.traktTitle || nowPlaying.title;
        npTitle.textContent = display;

        if (nowPlaying.type === 'episode' && npEpisode) {
            npEpisode.textContent = `S${nowPlaying.season || '?'} E${nowPlaying.episode || '?'}`;
        } else if (npEpisode) {
            npEpisode.textContent = '';
        }

        // Status badge
        const status = nowPlaying.status || 'scrobbling';
        let badgeClass = `status-badge ${status}`;
        let statusText = 'WATCHING';
        let iconHtml = '';

        if (status === 'paused') {
            statusText = 'PAUSED';
            iconHtml = `<svg class="status-icon pause-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
        } else if (status === 'stopped' || status === 'not_found' || status === 'parse_error') {
            statusText = status === 'stopped' ? 'STOPPED' : 'NOT FOUND';
            badgeClass = 'status-badge paused';
            iconHtml = `<svg class="status-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`;
        } else {
            statusText = 'SCROBBLING';
            iconHtml = `<svg class="status-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        }

        npStatus.className = badgeClass;
        npStatus.innerHTML = `${iconHtml}<span class="status-text">${statusText}</span>`;

        // Metadata with defaults for bullet points mapping
        let yearText = nowPlaying.traktYear ? nowPlaying.traktYear : 'Unknown Year';
        if (metaYear) metaYear.textContent = yearText;

        if (metaRuntime) {
            let runtimeStr = nowPlaying.runtime ? `${nowPlaying.runtime}m` : 'Unknown length';
            metaRuntime.textContent = runtimeStr;
        }

        if (metaGenres) {
            metaGenres.textContent = (nowPlaying.genres && nowPlaying.genres.length > 0) ? nowPlaying.genres[0] : 'Anime';
        }

        // Synopsis
        if (npSynopsis) {
            if (nowPlaying.synopsis) {
                npSynopsis.textContent = nowPlaying.synopsis;
                npSynopsis.classList.remove('hidden');
            } else {
                npSynopsis.classList.add('hidden');
            }
        }

        // Progress Bar styling
        if (progressBar) {
            const progressPct = nowPlaying.progress || 0;
            progressBar.style.width = `${progressPct}%`;
        }

        // Poster and Color Extraction
        if (nowPlaying.image && npImage.src !== nowPlaying.image) {
            npImage.style.opacity = '0';
            if (npBgImage) npBgImage.style.opacity = '0';

            npImage.onload = () => {
                npImage.style.opacity = '1';
                extractDominantColor(npImage);
            };
            npImage.src = nowPlaying.image;
            if (npBgImage) {
                npBgImage.onload = () => npBgImage.style.opacity = '1';
                npBgImage.src = nowPlaying.image;
            }
        } else if (!nowPlaying.image) {
            npImage.style.opacity = '0';
            if (npBgImage) npBgImage.style.opacity = '0';
            resetDominantColor();
        }

    } else {
        // Nothing playing
        npTitle.textContent = 'Ready to Stream';
        if (npEpisode) npEpisode.textContent = '';
        npStatus.className = 'status-badge paused';
        npStatus.innerHTML = `<svg class="status-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg><span class="status-text">WAITING</span>`;
        if (metaYear) metaYear.textContent = '';
        if (metaRuntime) metaRuntime.textContent = '';
        if (metaGenres) metaGenres.textContent = '';
        if (npSynopsis) npSynopsis.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
        npImage.style.opacity = '0';
        if (npBgImage) npBgImage.style.opacity = '0';
        resetDominantColor();
    }
}

// Custom animation cross-fade utility
function animateCrossFade(element, newText) {
    element.classList.add('cross-fade-item', 'cross-fade-out');

    setTimeout(() => {
        element.textContent = newText;
        element.classList.remove('cross-fade-out');
        element.classList.add('cross-fade-initial');

        // Force reflow
        void element.offsetWidth;

        element.classList.remove('cross-fade-initial');
        element.classList.add('cross-fade-in');

        setTimeout(() => {
            element.classList.remove('cross-fade-item', 'cross-fade-in');
        }, 400); // Wait for transition
    }, 300); // 300ms out duration
}

// Basic Color Extraction
function extractDominantColor(imgEl) {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 64; // Scale down for speed
        canvas.height = 64;

        // Use try-catch for cross-origin issues
        ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        let r = 0, g = 0, b = 0, count = 0;

        for (let i = 0; i < data.length; i += 16) { // Sample every 4th pixel
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
        }

        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);

        // Ensure color isn't too dark or too bright (boost saturation slightly)
        const avg = (r + g + b) / 3;
        if (avg < 40) { r += 30; g += 30; b += 30; } // Boost darks

        const finalColor = `rgb(${r}, ${g}, ${b})`;
        const finalGlow = `rgba(${r}, ${g}, ${b}, 0.4)`;

        document.documentElement.style.setProperty('--dynamic-accent', finalColor);
        document.documentElement.style.setProperty('--dynamic-glow', finalGlow);
    } catch (e) {
        console.warn("Could not extract color", e);
        resetDominantColor();
    }
}

function resetDominantColor() {
    document.documentElement.style.removeProperty('--dynamic-accent');
    document.documentElement.style.removeProperty('--dynamic-glow');
}

// Parallax Title Effect
document.addEventListener('mousemove', (e) => {
    const layer = document.querySelector('.app-content-layer');
    if (!layer) return;

    // Calculate rotation based on center of screen
    const x = (window.innerWidth / 2 - e.pageX) / 25; // dampening factor
    const y = (window.innerHeight / 2 - e.pageY) / 25;

    layer.style.transform = `rotateX(${y}deg) rotateY(${-x}deg)`;
});


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
// --- Fix UI Handling ---

if (fixMatchBtn) {
    fixMatchBtn.addEventListener('click', () => {
        const fixSection = document.getElementById('fix-section');
        const epSection = document.getElementById('fix-episode-section');
        if (epSection) epSection.classList.add('hidden'); // Close other fix tool
        if (fixSection) fixSection.classList.toggle('hidden');
    });
}

const fixEpisodeBtn = document.getElementById('fixEpisodeBtn');
const saveEpFixBtn = document.getElementById('saveEpFixBtn');
const cancelEpFixBtn = document.getElementById('cancelEpFixBtn');

if (fixEpisodeBtn) {
    fixEpisodeBtn.addEventListener('click', () => {
        const fixSection = document.getElementById('fix-section');
        const epSection = document.getElementById('fix-episode-section');
        if (fixSection) fixSection.classList.add('hidden'); // Close other fix tool
        if (epSection) epSection.classList.toggle('hidden');

        // Pre-fill current episode if we have it
        chrome.storage.local.get(['nowPlaying'], (res) => {
            const title = res.nowPlaying?.title || "";
            const seMatch = title.match(/Season (\d+) Episode (\d+)/i);
            if (seMatch) {
                document.getElementById('fixSeasonInput').value = seMatch[1];
                document.getElementById('fixEpInput').value = seMatch[2];
            }
        });
    });
}

if (cancelEpFixBtn) {
    cancelEpFixBtn.addEventListener('click', () => {
        document.getElementById('fix-episode-section').classList.add('hidden');
    });
}

if (saveEpFixBtn) {
    saveEpFixBtn.addEventListener('click', () => {
        const s = parseInt(document.getElementById('fixSeasonInput').value);
        const e = parseInt(document.getElementById('fixEpInput').value);
        const statusDiv = document.getElementById('fix-ep-status');

        if (isNaN(s) || isNaN(e)) {
            if (statusDiv) statusDiv.textContent = "Please enter valid numbers.";
            return;
        }

        chrome.storage.local.get(['nowPlaying', 'corrections'], async (res) => {
            const nowPlaying = res.nowPlaying;
            if (!nowPlaying || !nowPlaying.title) {
                if (statusDiv) statusDiv.textContent = "Error: Nothing currently playing.";
                return;
            }

            // 1. EXTRACT ORG SEASON AND EPISODE FROM BACKGROUND STATE
            const cleanTitle = nowPlaying.title; // The title is already sanitized by background.js 
            let orgS = nowPlaying.season || 1; // Default to 1 if missing
            let orgE = nowPlaying.episode;

            if (!orgE) {
                if (statusDiv) statusDiv.textContent = "Error: Could not identify current episode number from playing title.";
                return;
            }

            const corrections = res.corrections || {};

            // This show might be auto-mapped or manually mapped. We allow overriding episode offsets for both!
            if (!corrections[cleanTitle]) {
                // Create base structure if it doesn't exist
                corrections[cleanTitle] = { data: null, offsets: {} };
            }

            const mappingKey = `${orgS}_${orgE}`;
            corrections[cleanTitle].offsets = corrections[cleanTitle].offsets || {};
            corrections[cleanTitle].offsets[mappingKey] = { s: s, e: e };

            await chrome.storage.local.set({ corrections });

            // Invalidate cache for this title in background memory
            chrome.runtime.sendMessage({ action: "clearCache", payload: { title: cleanTitle } });

            if (statusDiv) {
                statusDiv.textContent = "Episode mapping saved!";
                statusDiv.style.color = "#4CAF50";
            }

            // Immediate scrobble attempt (Reconstruct fake raw string so background.js's handleScrobble picks up the fresh manual fetch!)
            const scrobbleTitleFormat = `${cleanTitle} - Season ${orgS} Episode ${orgE}`;
            chrome.runtime.sendMessage({ action: "scrobble", payload: { title: scrobbleTitleFormat, status: 'playing', progress: 1 } });

            setTimeout(() => {
                document.getElementById('fix-episode-section').classList.add('hidden');
            }, 1500);
        });
    });
}

const cancelFixBtn = document.getElementById('cancelFixBtn');
if (cancelFixBtn) {
    cancelFixBtn.addEventListener('click', () => {
        document.getElementById('fix-section').classList.add('hidden');
    });
}

const fixSearchBtn = document.getElementById('fixSearchBtn');
const fixInput = document.getElementById('fixInput');

if (fixSearchBtn && fixInput) {
    const performSearch = () => {
        const query = fixInput.value.trim();
        if (!query) return;

        const resultsDiv = document.getElementById('fix-results');
        const statusDiv = document.getElementById('fix-status');

        if (statusDiv) {
            statusDiv.textContent = "Searching Trakt...";
            statusDiv.style.color = "#aaa";
        }
        if (resultsDiv) {
            resultsDiv.classList.remove('hidden');
            resultsDiv.innerHTML = '<div style="padding:15px; text-align:center; color:#888;">Searching...</div>';
        }

        chrome.runtime.sendMessage({
            action: "searchTraktForPopup",
            payload: { query: query }
        }, (response) => {
            if (response && response.success) {
                displayResults(response.results);
                if (statusDiv) statusDiv.textContent = "";
            } else {
                if (statusDiv) {
                    statusDiv.textContent = "Error: " + (response?.error || "Search failed");
                    statusDiv.style.color = "#ff5252";
                }
                if (resultsDiv) resultsDiv.innerHTML = "";
            }
        });
    };

    fixSearchBtn.addEventListener('click', performSearch);
    fixInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') performSearch();
    });
}

function displayResults(results) {
    const resultsDiv = document.getElementById('fix-results');
    if (!resultsDiv) return;

    resultsDiv.innerHTML = '';
    if (!results || results.length === 0) {
        resultsDiv.innerHTML = '<div style="padding:15px; text-align:center; color:#888;">No results found.</div>';
        return;
    }

    results.forEach(result => {
        const item = result.show || result.movie;
        if (!item) return;

        const div = document.createElement('div');
        div.className = 'result-item';
        div.innerHTML = `
            <span class="item-title">${item.title}</span>
            <span class="item-meta">${item.year ? item.year : ''} • ${result.type.toUpperCase()}</span>
        `;

        div.onclick = () => {
            selectResult(result);
        };

        resultsDiv.appendChild(div);
    });
}

const resetMappingsBtn = document.getElementById('resetMappingsBtn');
if (resetMappingsBtn) {
    resetMappingsBtn.addEventListener('click', async () => {
        if (confirm("Reset show/episode library mappings? (API keys will be saved).")) {
            await chrome.storage.local.remove('corrections');
            // Global cache clear
            chrome.runtime.sendMessage({ action: "CLEAR_MEMORY_CACHE" });
            window.location.reload();
        }
    });
}

function selectResult(result) {
    const statusDiv = document.getElementById('fix-status');
    const resultsDiv = document.getElementById('fix-results');

    if (statusDiv) {
        statusDiv.textContent = "Saving mapping...";
        statusDiv.style.color = "#aaa";
    }
    if (resultsDiv) resultsDiv.classList.add('hidden');

    chrome.storage.local.get(['nowPlaying'], (res) => {
        const originalTitle = res.nowPlaying?.title;
        if (!originalTitle) {
            if (statusDiv) {
                statusDiv.textContent = "Error: Nothing currently playing.";
                statusDiv.style.color = "#ff5252";
            }
            return;
        }

        chrome.runtime.sendMessage({
            action: "setCorrection",
            payload: { originalTitle: originalTitle, correctionResult: result }
        }, (response) => {
            if (response && response.success) {
                if (statusDiv) {
                    statusDiv.textContent = "Match saved! Check the sync icon.";
                    statusDiv.style.color = "#4CAF50";
                }
                setTimeout(() => {
                    document.getElementById('fix-section').classList.add('hidden');
                }, 1500);

                // Re-trigger the active video title to background for immediate update
                chrome.runtime.sendMessage({ action: "scrobble", payload: { title: originalTitle, status: 'playing', progress: 1 } });
            } else {
                if (statusDiv) {
                    statusDiv.textContent = "Failed to save mapping.";
                    statusDiv.style.color = "#ff5252";
                }
            }
        });
    });
}
