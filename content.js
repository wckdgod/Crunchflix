const IS_TOP_FRAME = (window === window.top);
let isInvalidated = false;
let cachedNetflixTitle = null;
let lastUrl = window.location.href;
let videoCheckInterval;
let heartbeatInterval;

// ── Site-Specific Parsers ──

function parseNetflixMetadata() {
    if (cachedNetflixTitle) return cachedNetflixTitle;

    try {
        const titleEvEl = document.querySelector('[class*="player-title-evidence"]') ||
            document.querySelector('[class*="video-title"]') ||
            document.querySelector('[data-uia="video-title"]');

        if (titleEvEl) {
            const ariaLabel = titleEvEl.getAttribute('aria-label') || '';
            let seMatch = ariaLabel.match(/S(\d+):E(\d+)/i);
            if (!seMatch) {
                const numericMatch = ariaLabel.match(/(\d+):(\d+)/);
                if (numericMatch && parseInt(numericMatch[1]) < 50 && parseInt(numericMatch[2]) < 300) {
                    seMatch = numericMatch;
                }
            }

            let rawText = (titleEvEl.innerText || titleEvEl.textContent).trim();
            const textLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

            let showName = textLines[0] || document.querySelector('h2')?.textContent.trim() || rawText;
            showName = showName.split(/ Season \d+/i)[0].split(/ S\d+/i)[0].split(/ - Episode/i)[0].split(/ \| E\d+/i)[0].trim();

            const textSeMatch = rawText.match(/S(\d+):E(\d+)/i);

            if ((seMatch || textSeMatch) && showName) {
                const finalS = (seMatch || textSeMatch)[1];
                const finalE = (seMatch || textSeMatch)[2];
                console.log(`[CRUNCHFLIX] Scraped Match: ${showName} S${finalS}:E${finalE}`);
                cachedNetflixTitle = `${showName} - Season ${finalS} Episode ${finalE}`;
                return cachedNetflixTitle;
            } else if (textLines.length > 0 && showName) {
                const epInfo = textLines.find(l => l.match(/E(\d+)/i) || l.match(/Episode\s*\d+/i));
                const seasonLine = textLines.find(l => l.match(/Season\s*(\d+)/i));
                let seasonFallback = null;
                if (seasonLine) {
                    const sMatch = seasonLine.match(/Season\s*(\d+)/i);
                    seasonFallback = sMatch ? sMatch[1] : null;
                }

                if (epInfo) {
                    const epMatch = epInfo.match(/E(\d+)/i) || epInfo.match(/Episode\s*(\d+)/i);
                    console.log(`[CRUNCHFLIX] Scraped Fallback: ${showName} S:${seasonFallback} E:${epMatch[1]}`);
                    if (seasonFallback) {
                        cachedNetflixTitle = `${showName} - Season ${seasonFallback} Episode ${epMatch[1]}`;
                    } else {
                        cachedNetflixTitle = `${showName} - Episode ${epMatch[1]}`;
                    }
                    return cachedNetflixTitle;
                }
            }
        }
    } catch (e) {
        console.error("[CRUNCHFLIX] Error scraping Netflix DOM:", e);
    }

    const title = document.title;
    console.log(`[CRUNCHFLIX] Falling back to document.title: "${title}"`);
    const GENERIC_NETFLIX = ["Netflix", "Netflix Home", ""];
    if (GENERIC_NETFLIX.some(g => title.trim().toLowerCase().includes(g.toLowerCase()) && title.trim().length <= g.length + 2)) return null;
    return title;
}

function parseCrunchyrollMetadata() {
    try {
        // STRATEGY 1: JSON-LD (Improved via MALSync strategy)
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
            try {
                const text = script.textContent;
                if (!text.includes('episodeNumber')) continue;

                const json = JSON.parse(text);
                const series = json.partOfSeries?.name || json.name;
                const episodeNumber = json.episodeNumber;
                const seasonNumber = json.partOfSeason?.seasonNumber;

                if (series && episodeNumber) {
                    if (seasonNumber) {
                        return `${series} Season ${seasonNumber} - Episode ${episodeNumber}`;
                    }
                    return `${series} - Episode ${episodeNumber}`;
                }
            } catch (e) { }
        }

        // STRATEGY 2: Meta tags
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
        if (ogTitle) {
            let cleanOg = ogTitle.replace(/^Watch\s+/i, '');
            cleanOg = cleanOg.replace(/\s*-\s*Watch on Crunchyroll$/i, '');
            return cleanOg;
        }

        // STRATEGY 3: Page Title
        let docTitle = document.title;
        docTitle = docTitle.replace(/\s*-\s*Watch on Crunchyroll$/i, '');
        return docTitle;
    } catch (e) { console.warn("Crunchyroll scraper error:", e); }

    const GENERIC_CR = ["Crunchyroll", "Vilos", ""];
    if (GENERIC_CR.includes(document.title.trim())) return null;
    return document.title;
}

function extractTitle() {
    const domain = window.location.hostname;
    if (domain.includes("netflix.com")) return parseNetflixMetadata();
    if (domain.includes("crunchyroll.com")) return parseCrunchyrollMetadata();
    return document.title;
}

// ── Site-Specific Initializers ──

let port = null;

function connectToBackground() {
    // Check if context is already invalidated
    if (chrome.runtime?.id === undefined) {
        if (!isInvalidated) {
            console.error("[CRUNCHFLIX] Extension context invalidated. Monitoring stopped.");
            isInvalidated = true;
        }
        return;
    }

    try {
        port = chrome.runtime.connect({ name: "crunchflix-port" });
        port.onDisconnect.addListener(() => {
            if (chrome.runtime?.id === undefined) {
                console.error("[CRUNCHFLIX] Extension context invalidated during disconnect.");
                isInvalidated = true;
                return;
            }
            console.warn("[CRUNCHFLIX] Port disconnected. Reconnecting in 1s...");
            port = null;
            setTimeout(connectToBackground, 1000);
        });
        console.log("[CRUNCHFLIX] Connected to background port.");
    } catch (e) {
        console.error("[CRUNCHFLIX] Failed to connect to background:", e);
        if (e.message.includes("context invalidated")) {
            isInvalidated = true;
        }
    }
}

function sendToPort(action, payload) {
    if (isInvalidated) return;

    if (!port) {
        connectToBackground();
        if (!port) return;
    }

    try {
        port.postMessage({ action, payload });
    } catch (e) {
        console.error("[CRUNCHFLIX] Error sending to port:", e);
        if (e.message.includes("context invalidated")) {
            isInvalidated = true;
        }
    }
}

let globalIframeTitle = null;

// Global listener for iframe title broadcasts from the top window
window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "CRUNCHFLIX_TITLE_BROADCAST") {
        globalIframeTitle = event.data.title;
    }
});

function initNetflix() {
    if (!IS_TOP_FRAME) return;

    console.log("[CRUNCHFLIX] Initializing Netflix Parser...");

    // Port listener for background messages
    if (port) {
        port.onMessage.addListener((message) => {
            if (message.action === "REFRESH_SESSION") {
                console.log("[CRUNCHFLIX] Force-refreshing Shakti keys...");
                window.postMessage({ type: "GET_NETFLIX_METADATA_FORCE" }, "*");
            } else if (message.action === "showToast") {
                showToast(message.payload.message);
            }
        });
    }

    window.addEventListener("message", function (event) {
        if (event.source !== window || !event.data.type) return;
        if (event.data.type === "SHAKTI_DATA") {
            sendToPort("STORE_SHAKTI_KEYS", event.data.payload);
        }
    });

    try {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('injected.js');
        script.onload = function () { this.remove(); };
        (document.head || document.documentElement).appendChild(script);
    } catch (e) { }
}

function initCrunchyroll() {
    if (!IS_TOP_FRAME) return;
    console.log("[CRUNCHFLIX] Initializing Crunchyroll Parser...");

    // Crunchyroll's video player is inside a cross-origin iframe (vilos) which
    // cannot read the top-level URL or top-level DOM (og:title) directly.
    // The top frame must continuously broadcast the scraped title down to all children.
    setInterval(() => {
        const topTitle = extractTitle();
        if (topTitle) {
            // Broadcast to all iframes
            const frames = document.querySelectorAll('iframe');
            frames.forEach(frame => {
                try {
                    frame.contentWindow.postMessage({
                        type: "CRUNCHFLIX_TITLE_BROADCAST",
                        title: topTitle
                    }, "*");
                } catch (e) { }
            });
        }
    }, 3000);
}

// ── Core Systems (Toast, Scrobble, Monitoring) ──

function showToast(message) {
    if (document.getElementById('ghost-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'ghost-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
        position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%) translateY(100px)',
        backgroundColor: 'rgba(0, 0, 0, 0.85)', color: '#fff', padding: '12px 24px', borderRadius: '50px',
        zIndex: '999999', fontFamily: 'Segoe UI, sans-serif', fontSize: '14px', fontWeight: '500',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)', transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
        opacity: '0', pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: '8px'
    });
    const icon = document.createElement('span');
    icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#e50914"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>';
    toast.prepend(icon);
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.transform = 'translateX(-50%) translateY(0)'; toast.style.opacity = '1'; });
    setTimeout(() => {
        toast.style.transform = 'translateX(-50%) translateY(100px)'; toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function sendScrobbleMessage(video, status) {
    if (isInvalidated) return;

    const progress = video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0;

    // If we're inside an iframe, prefer the broadcasted title from the top window
    let title = (!IS_TOP_FRAME && globalIframeTitle) ? globalIframeTitle : extractTitle();

    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        if (window.location.hostname.includes('netflix.com')) {
            console.log("[CRUNCHFLIX] Navigation detected, resetting cached title.");
            cachedNetflixTitle = null;
        }
    }

    console.log(`[CRUNCHFLIX] Sending: status=${status}, title="${title || '(iframe, needs metadata)'}", progress=${progress}%`);

    const platform = window.location.hostname.includes('netflix') ? 'netflix' : 'crunchyroll';
    sendToPort("scrobble", { status, title, progress, platform, fromIframe: !IS_TOP_FRAME });
}

function monitorVideo(video) {
    if (video.getAttribute('data-ghost-monitored')) return;
    video.setAttribute('data-ghost-monitored', 'true');
    console.log("[CRUNCHFLIX] Monitoring video element" + (IS_TOP_FRAME ? " (top frame)" : " (iframe)"));

    video.addEventListener('play', () => sendScrobbleMessage(video, 'playing'));
    video.addEventListener('pause', () => sendScrobbleMessage(video, 'paused'));
    video.addEventListener('ended', () => sendScrobbleMessage(video, 'stopped'));

    if (!video.paused && !video.ended) sendScrobbleMessage(video, 'playing');

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (!video.paused && !video.ended) {
            const progress = video.duration ? (video.currentTime / video.duration) * 100 : 0;
            if (progress >= 85) {
                sendScrobbleMessage(video, 'stopped');
            } else {
                sendScrobbleMessage(video, 'playing');
            }
        }
    }, 10000);

    window.addEventListener('beforeunload', () => {
        if (video && !video.ended) {
            const progress = video.duration ? (video.currentTime / video.duration) * 100 : 0;
            sendScrobbleMessage(video, progress >= 85 ? 'stopped' : 'paused');
        }
    }, { capture: true });
}

function checkForVideo() {
    const videos = document.getElementsByTagName('video');
    if (videos.length > 0) monitorVideo(videos[0]);
}

// ── Routing and Entry Point ──

(function init() {
    console.log("[CRUNCHFLIX] Content script loaded.");
    connectToBackground();

    const domain = window.location.hostname;

    if (domain.includes("netflix.com")) {
        initNetflix();
    } else if (domain.includes("crunchyroll.com")) {
        initCrunchyroll();
    }

    videoCheckInterval = setInterval(checkForVideo, 2000);
})();
