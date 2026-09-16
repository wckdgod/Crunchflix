// CLIENT_ID handled in background/auth


document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    updateServerStatus();
    initScrobbleNowBtn();
});

function formatSeconds(seconds) {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hrs > 0) {
        return `${hrs}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
}

function updateServerStatus() {
    const el = document.getElementById('server-status-text');
    if (!el) return;
    chrome.storage.local.get(['scrob_url'], (res) => {
        const url = res.scrob_url || (typeof DEFAULT_SCROB_URL !== 'undefined' ? DEFAULT_SCROB_URL : 'http://localhost:7330');
        try {
            const parsed = new URL(url);
            el.textContent = `${parsed.host} - Scrob`;
            el.title = `Connected to ${url}`;
        } catch (e) {
            el.textContent = `${url} - Scrob`;
        }
    });
}

function initScrobbleNowBtn() {
    const scrobbleNowBtn = document.getElementById('scrobbleNowBtn');
    if (!scrobbleNowBtn) return;
    scrobbleNowBtn.addEventListener('click', () => {
        chrome.storage.local.get(['nowPlaying'], (res) => {
            const np = res.nowPlaying;
            if (np && (np.title || np.rawTitle)) {
                const manualProgress = Math.max(np.progress || 0, 85);
                chrome.runtime.sendMessage({
                    action: 'scrobble',
                    payload: {
                        ...np,
                        status: 'playing',
                        progress: manualProgress
                    }
                });

                scrobbleNowBtn.classList.add('success');
                const label = scrobbleNowBtn.querySelector('span:last-child');
                if (label) label.textContent = 'Scrobbled!';
                setTimeout(() => {
                    scrobbleNowBtn.classList.remove('success');
                    if (label) label.textContent = 'Scrobble Now';
                }, 1600);
            }
        });
    });
}

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

const openScrobBtn = document.getElementById('openScrobBtn');
if (openScrobBtn) {
    openScrobBtn.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.storage.local.get(['scrob_url'], (res) => {
            const url = res.scrob_url || 'http://localhost:7330';
            chrome.tabs.create({ url });
        });
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
    chrome.storage.local.get(['scrob_token', 'scrob_api_key', 'simkl_token', 'trakt_token', 'nowPlaying'], (result) => {
        if (result.scrob_token || result.scrob_api_key || result.simkl_token || result.trakt_token) {
            showConnected(result.nowPlaying);
        } else {
            showDisconnected();
        }
    });

    // Listen for updates
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.scrob_token || changes.scrob_api_key || changes.simkl_token || changes.trakt_token) {
                checkAuth();
            }
            if (changes.nowPlaying) {
                updateNowPlaying(changes.nowPlaying.newValue);
            }
            if (changes.scrob_url) {
                updateServerStatus();
            }
        }
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "LIVE_PROGRESS") {
            const progressBar = document.getElementById('play-progress-bar');
            if (progressBar) progressBar.style.width = `${message.progress}%`;
            const progressPctLabel = document.getElementById('progress-pct-label');
            if (progressPctLabel) progressPctLabel.textContent = `${Math.round(message.progress)}%`;
            const progressTimeLabel = document.getElementById('progress-time-label');
            if (progressTimeLabel && message.currentTime !== undefined && message.duration) {
                progressTimeLabel.textContent = `${formatSeconds(message.currentTime)} / ${formatSeconds(message.duration)}`;
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

    // Antigravity GSAP Staggered Entrance
    if (typeof gsap !== 'undefined') {
        gsap.fromTo(['.popup-header', '.hero-floating-header', '.actions-grid', '.popup-footer'], 
            { opacity: 0, y: 15, scale: 0.98 },
            { opacity: 1, y: 0, scale: 1, duration: 0.45, stagger: 0.08, ease: "power2.out", clearProps: "transform,opacity" }
        );
    }

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
        } else if (status === 'resolving') {
            statusText = 'RESOLVING...';
            badgeClass = 'status-badge resolving';
            iconHtml = `<svg class="status-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>`;
        } else if (status === 'stopped' || status === 'not_found' || status === 'parse_error') {
            statusText = status === 'stopped' ? 'STOPPED' : 'NOT FOUND';
            badgeClass = 'status-badge paused';
            iconHtml = `<svg class="status-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`;
        } else {
            statusText = 'SCROBBLING';
            badgeClass = 'status-badge scrobbling';
            iconHtml = `<div class="visualizer-wave"><span class="visualizer-bar"></span><span class="visualizer-bar"></span><span class="visualizer-bar"></span></div>`;
        }

        npStatus.className = badgeClass;
        npStatus.innerHTML = `${iconHtml}<span class="status-text">${statusText}</span>`;

        // Platform Badge (Vector Logos)
        updatePlatformBadge(nowPlaying.platform);


        // Metadata with defaults for bullet points mapping
        let yearText = (nowPlaying.traktYear || nowPlaying.year) ? (nowPlaying.traktYear || nowPlaying.year) : '';
        if (metaYear) metaYear.textContent = yearText;

        if (metaRuntime) {
            let runtimeStr = nowPlaying.runtime ? `${nowPlaying.runtime}m` : '';
            metaRuntime.textContent = runtimeStr;
        }

        if (metaGenres) {
            metaGenres.textContent = (nowPlaying.genres && nowPlaying.genres.length > 0) ? nowPlaying.genres[0] : (nowPlaying.type === 'movie' ? 'Movie' : 'TV Show');
        }

        // Progress Bar & Telemetry progress calculation
        const progressPct = nowPlaying.progress || 0;

        // Dynamic hover tooltips
        const hoverTooltipText = `[${statusText}] ${display}${(nowPlaying.type === 'episode' && (nowPlaying.season || nowPlaying.episode)) ? ` S${nowPlaying.season || 1}E${nowPlaying.episode || 1}` : ''} (${Math.round(progressPct)}%)`;
        const brandLogo = document.querySelector('.brand-logo');
        if (brandLogo) brandLogo.title = hoverTooltipText;
        if (npStatus) npStatus.title = hoverTooltipText;
        const telemetryCard = document.querySelector('.telemetry-card');
        if (telemetryCard) telemetryCard.title = hoverTooltipText;

        // Ensure idle radar pill and idle platform chips are hidden when content is playing/identified
        const idleRadarPill = document.getElementById('idle-radar-pill');
        const idlePlatforms = document.getElementById('idle-platforms');
        if (idleRadarPill) idleRadarPill.classList.add('hidden');
        if (idlePlatforms) idlePlatforms.classList.add('hidden');

        // Episode Title
        const npEpName = document.getElementById('episode-name');
        if (npEpName) {
            if (nowPlaying.episodeTitle) {
                npEpName.textContent = `Ep. "${nowPlaying.episodeTitle}"`;
                npEpName.classList.remove('hidden');
            } else {
                npEpName.classList.add('hidden');
            }
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

        // Progress Bar & Telemetry styling
        if (progressBar) {
            progressBar.style.width = `${progressPct}%`;
            progressBar.title = `${Math.round(progressPct)}% completed`;
        }

        const progressPctLabel = document.getElementById('progress-pct-label');
        if (progressPctLabel) {
            progressPctLabel.textContent = `${Math.round(progressPct)}%`;
        }

        const progressTimeLabel = document.getElementById('progress-time-label');
        if (progressTimeLabel) {
            if (nowPlaying.currentTime !== null && nowPlaying.currentTime !== undefined && nowPlaying.duration) {
                progressTimeLabel.textContent = `${formatSeconds(nowPlaying.currentTime)} / ${formatSeconds(nowPlaying.duration)}`;
            } else if (nowPlaying.duration) {
                const estSecs = Math.floor((progressPct / 100) * nowPlaying.duration);
                progressTimeLabel.textContent = `${formatSeconds(estSecs)} / ${formatSeconds(nowPlaying.duration)}`;
            } else {
                progressTimeLabel.textContent = `${Math.round(progressPct)}% Completed`;
            }
        }

        // Poster and Backdrop Extraction
        const imgUrl = nowPlaying.backdrop || nowPlaying.image;
        const idleMesh = document.querySelector('.hero-idle-mesh');
        if (idleMesh) idleMesh.style.opacity = imgUrl ? '0' : '0.85';
        if (imgUrl) {
            if (npImage.src !== imgUrl) {
                npImage.style.opacity = '0';
                if (npBgImage) npBgImage.style.opacity = '0';

                npImage.onload = () => {
                    npImage.style.opacity = '1';
                    extractDominantColor(npImage);
                };
                npImage.onerror = () => {
                    // Fallback to poster if backdrop failed
                    if (nowPlaying.image && npImage.src !== nowPlaying.image) {
                        npImage.src = nowPlaying.image;
                    } else {
                        npImage.style.opacity = '0';
                    }
                };
                npImage.src = imgUrl;

                if (npBgImage) {
                    npBgImage.onload = () => { npBgImage.style.opacity = '1'; };
                    npBgImage.src = imgUrl;
                }
            } else {
                npImage.style.opacity = '1';
                if (npBgImage) npBgImage.style.opacity = '1';
            }
        } else {
            npImage.style.opacity = '0';
            if (npBgImage) npBgImage.style.opacity = '0';
            resetDominantColor();
        }

    } else {
        // Nothing playing
        npTitle.textContent = 'Ready to Stream';
        if (npEpisode) npEpisode.textContent = '';
        npStatus.className = 'status-badge paused';
        npStatus.innerHTML = `<svg class="status-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg><span class="status-text">RADAR ACTIVE</span>`;
        
        const idleRadarPill = document.getElementById('idle-radar-pill');
        const idlePlatforms = document.getElementById('idle-platforms');
        if (idleRadarPill) idleRadarPill.classList.remove('hidden');
        if (idlePlatforms) idlePlatforms.classList.remove('hidden');

        const idleMesh = document.querySelector('.hero-idle-mesh');
        if (idleMesh) idleMesh.style.opacity = '0.85';

        if (metaYear) metaYear.textContent = '';
        if (metaRuntime) metaRuntime.textContent = '';
        if (metaGenres) metaGenres.textContent = '';
        if (npSynopsis) npSynopsis.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
        const progressPctLabel = document.getElementById('progress-pct-label');
        if (progressPctLabel) progressPctLabel.textContent = '0%';
        const progressTimeLabel = document.getElementById('progress-time-label');
        if (progressTimeLabel) progressTimeLabel.textContent = '00:00 / 00:00';
        npImage.style.opacity = '0';
        if (npBgImage) npBgImage.style.opacity = '0';
        resetDominantColor();
        updatePlatformBadge(null);

        const brandLogo = document.querySelector('.brand-logo');
        if (brandLogo) brandLogo.title = 'Scrobblr - Ready to Stream';
        if (npStatus) npStatus.title = 'Scrobblr Radar Active';
        const telemetryCard = document.querySelector('.telemetry-card');
        if (telemetryCard) telemetryCard.title = 'Scrobblr - Ready to Stream';
    }
}

// Official Image Brand Logos for Streaming Platforms
const PLATFORM_LOGOS = {
    netflix: `<img src="assets/platforms/netflix.png" alt="Netflix" class="platform-img" />`,
    hotstar: `<img src="assets/platforms/hotstar.png" alt="JioHotstar" class="platform-img" />`,
    prime: `<img src="assets/platforms/prime.png" alt="Prime Video" class="platform-img" />`,
    crunchyroll: `<img src="assets/platforms/crunchyroll.png" alt="Crunchyroll" class="platform-img" />`,
    unknown: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>`
};

function updatePlatformBadge(platform) {
    const badge = document.getElementById('platform-badge');
    const iconWrap = document.getElementById('platform-icon');
    if (!badge || !iconWrap) return;

    const applyPlatform = (p) => {
        const raw = (p || '').toLowerCase();
        let key = 'unknown';
        let title = 'Streaming Radar';
        let cls = 'platform-badge platform-unknown';

        if (raw.includes('hotstar')) {
            key = 'hotstar';
            title = 'JioHotstar';
            cls = 'platform-badge platform-hotstar';
        } else if (raw.includes('prime') || raw.includes('amazon')) {
            key = 'prime';
            title = 'Prime Video';
            cls = 'platform-badge platform-amazon-prime';
        } else if (raw.includes('crunchyroll')) {
            key = 'crunchyroll';
            title = 'Crunchyroll';
            cls = 'platform-badge platform-crunchyroll';
        } else if (raw.includes('netflix')) {
            key = 'netflix';
            title = 'Netflix';
            cls = 'platform-badge platform-netflix';
        }

        badge.className = cls;
        badge.title = title;
        iconWrap.innerHTML = PLATFORM_LOGOS[key] || PLATFORM_LOGOS.unknown;
    };

    if (platform) {
        applyPlatform(platform);
    } else {
        // Query active browser tab to identify platform immediately upon visiting the website
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const url = tabs && tabs[0]?.url ? tabs[0].url.toLowerCase() : '';
            if (url.includes('hotstar.com') || url.includes('jiohotstar.com')) {
                applyPlatform('hotstar');
            } else if (url.includes('primevideo.com') || url.includes('amazon.')) {
                applyPlatform('prime');
            } else if (url.includes('crunchyroll.com')) {
                applyPlatform('crunchyroll');
            } else if (url.includes('netflix.com')) {
                applyPlatform('netflix');
            } else {
                applyPlatform(null);
            }
        });
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

// Antigravity Parallax 3D Tilt Effect with Smooth Damping
let targetTiltX = 0;
let targetTiltY = 0;
let currentTiltX = 0;
let currentTiltY = 0;
let tiltRaf = null;

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!prefersReducedMotion) {
    document.addEventListener('mousemove', (e) => {
        const layer = document.querySelector('.app-content-layer');
        if (!layer) return;

        // Calculate smooth rotation (-4.5deg to +4.5deg max)
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        targetTiltX = ((e.clientY - centerY) / centerY) * -4.5;
        targetTiltY = ((e.clientX - centerX) / centerX) * 4.5;

        if (!tiltRaf) {
            tiltRaf = requestAnimationFrame(updateTiltLoop);
        }
    });

    document.addEventListener('mouseleave', () => {
        targetTiltX = 0;
        targetTiltY = 0;
    });
}

function updateTiltLoop() {
    const layer = document.querySelector('.app-content-layer');
    if (!layer) {
        tiltRaf = null;
        return;
    }

    currentTiltX += (targetTiltX - currentTiltX) * 0.12;
    currentTiltY += (targetTiltY - currentTiltY) * 0.12;

    layer.style.transform = `rotateX(${currentTiltX.toFixed(2)}deg) rotateY(${currentTiltY.toFixed(2)}deg)`;

    if (Math.abs(targetTiltX - currentTiltX) > 0.01 || Math.abs(targetTiltY - currentTiltY) > 0.01) {
        tiltRaf = requestAnimationFrame(updateTiltLoop);
    } else {
        layer.style.transform = `rotateX(${targetTiltX.toFixed(2)}deg) rotateY(${targetTiltY.toFixed(2)}deg)`;
        tiltRaf = null;
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
    chrome.storage.local.remove(['scrob_token', 'scrob_api_key', 'scrob_refresh_token', 'simkl_token', 'trakt_token', 'nowPlaying'], () => {
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
            if (statusDiv) {
                statusDiv.textContent = "Please enter valid numbers.";
                statusDiv.style.color = "#ff5252";
            }
            return;
        }

        chrome.storage.local.get(['nowPlaying', 'corrections'], async (res) => {
            const nowPlaying = res.nowPlaying;
            if (!nowPlaying || (!nowPlaying.title && !nowPlaying.rawTitle)) {
                if (statusDiv) {
                    statusDiv.textContent = "Error: Nothing currently playing.";
                    statusDiv.style.color = "#ff5252";
                }
                return;
            }

            // Extract best available show title
            let cleanTitle = (nowPlaying.traktTitle || nowPlaying.title || nowPlaying.rawTitle || "").trim();
            // If cleanTitle has trailing episode name (e.g., "Show - Subtitle"), strip down to show name
            if (cleanTitle.includes(' - ')) {
                cleanTitle = cleanTitle.split(/\s*-\s*/)[0].trim();
            }

            const corrections = res.corrections || {};
            if (!corrections[cleanTitle]) {
                corrections[cleanTitle] = { data: null, offsets: {} };
            }

            let orgS = nowPlaying.season || 1;
            let orgE = nowPlaying.episode;

            if (orgE) {
                const mappingKey = `${orgS}_${orgE}`;
                corrections[cleanTitle].offsets = corrections[cleanTitle].offsets || {};
                corrections[cleanTitle].offsets[mappingKey] = { s: s, e: e };
            }

            // Always save explicit manual episode mapping as well (works even if orgE was never detected!)
            corrections[cleanTitle].manualEpisode = { s: s, e: e };
            if (nowPlaying.rawTitle) {
                corrections[cleanTitle].rawMapping = corrections[cleanTitle].rawMapping || {};
                corrections[cleanTitle].rawMapping[nowPlaying.rawTitle] = { s: s, e: e };
            }

            await chrome.storage.local.set({ corrections });

            chrome.runtime.sendMessage({ action: "clearCache", payload: { title: cleanTitle } });

            if (statusDiv) {
                statusDiv.textContent = `Applied! Set to S${s} E${e}`;
                statusDiv.style.color = "#4CAF50";
            }

            // Format scrobble title with the user's explicit season and episode
            const scrobbleTitleFormat = `${cleanTitle} - Season ${s} Episode ${e}`;
            chrome.runtime.sendMessage({
                action: "scrobble",
                payload: {
                    title: scrobbleTitleFormat,
                    showTitle: cleanTitle,
                    season: s,
                    episode: e,
                    type: 'episode',
                    status: 'playing',
                    progress: nowPlaying.progress || 1,
                    platform: nowPlaying.platform
                }
            });

            // Optimistically update nowPlaying UI so user sees immediate feedback
            const updatedNowPlaying = {
                ...nowPlaying,
                status: 'scrobbling',
                type: 'episode',
                season: s,
                episode: e,
                title: cleanTitle
            };
            chrome.storage.local.set({ nowPlaying: updatedNowPlaying });
            updateNowPlaying(updatedNowPlaying);

            setTimeout(() => {
                document.getElementById('fix-episode-section').classList.add('hidden');
                if (statusDiv) statusDiv.textContent = '';
            }, 1200);
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
            statusDiv.textContent = "Searching Scrob...";
            statusDiv.style.color = "#aaa";
        }
        if (resultsDiv) {
            resultsDiv.classList.remove('hidden');
            resultsDiv.innerHTML = '<div style="padding:15px; text-align:center; color:#888;">Searching...</div>';
        }

        chrome.runtime.sendMessage({
            action: "searchScrobForPopup",
            payload: { query: query, type: 'tv,movie' }
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
        const item = result.show || result.movie || result;
        if (!item || !item.title) return;

        const div = document.createElement('div');
        div.className = 'result-item';
        const typeLabel = (result.type || item.type || 'TV').toUpperCase();
        div.innerHTML = `
            <span class="item-title">${item.title}</span>
            <span class="item-meta">${item.year ? item.year : ''} • ${typeLabel}</span>
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
