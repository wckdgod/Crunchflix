// Content Script: Runs on every page to detect video playback
// With all_frames:true, this runs in both the top frame and iframes

console.log("Ghost Scrobbler content script loaded.");

const IS_TOP_FRAME = (window === window.top);
let isInvalidated = false;
let cachedNetflixTitle = null; // Persists across heartbeats

// ── Metadata Extraction (only useful in top frame) ──

// Helper: parse the Netflix metadata JSON into "Show - Season X Episode Y"
// Structure: json.video.type='show', json.video.currentEpisode=episodeId,
//            json.video.seasons[].episodes[].{id, seq}
function parseNetflixMeta(json, epId) {
    try {
        const video = json?.video ?? json;
        const showTitle = video?.title;
        const currentEp = epId || video?.currentEpisode;
        if (!showTitle || !currentEp) return null;
        if (video?.type === 'movie') return showTitle;
        for (const season of (video?.seasons ?? [])) {
            for (const ep of (season?.episodes ?? [])) {
                if (ep.id === currentEp || ep.episodeId === currentEp) {
                    return `${showTitle} - Season ${season.seq} Episode ${ep.seq}`;
                }
            }
        }
    } catch (e) { }
    return null;
}

// Fetches title from Netflix's stable shakti metadata API.
// Content scripts run in the tab's cookie context, so credentials are sent automatically.
// Falls back to the performance-entry URL if the direct call 404s (e.g. movieId is show-level).
async function fetchNetflixTitleFromAPI() {
    try {
        const epId = parseInt(window.location.pathname.match(/\/watch\/(\d+)/)?.[1]);
        if (!epId) return null;

        // Strategy A: direct shakti API — stable URL, no build-id needed
        // Discovered from universal-trakt-scrobbler source code
        const shaktiUrl = `https://www.netflix.com/api/shakti/mre/metadata?languages=en-US&movieid=${epId}`;
        let json = null;
        try {
            const res = await fetch(shaktiUrl, { credentials: 'include' });
            if (res.ok) json = await res.json();
        } catch (e) { /* might be blocked by CSP — fall through */ }

        // Strategy B: find an already-loaded metadata URL in performance entries
        if (!json) {
            const entries = performance.getEntriesByType('resource');
            const metaEntry = entries.find(e =>
                e.name.includes('netflix.com') &&
                (e.name.includes('/metadata?') || e.name.includes('metadata?')) &&
                e.name.includes('movieId')
            );
            if (metaEntry) {
                try {
                    const res = await fetch(metaEntry.name, { credentials: 'include' });
                    if (res.ok) json = await res.json();
                } catch (e) { /* ignore */ }
            }
        }

        if (json) {
            const t = parseNetflixMeta(json, epId);
            if (t) {
                console.log('[Ghost Scrobbler] Netflix title from content script API:', t);
                cachedNetflixTitle = t; // cache for all future extractTitle() calls
                return t;
            }
        }
    } catch (e) {
        console.warn('[Ghost Scrobbler] Netflix metadata fetch failed:', e);
    }
    return null;
}

function extractTitle() {
    let title = document.title;

    // --- Netflix ---
    if (window.location.hostname.includes('netflix.com')) {
        // Return cached title (populated by waitForNetflixPlayer before first scrobble)
        if (cachedNetflixTitle) return cachedNetflixTitle;

        // Sync fallback: player-title-evidence aria-label (e.g. "S2:E8 'Divergence'")
        try {
            const titleEvEl = document.querySelector('[class*="player-title-evidence"]');
            if (titleEvEl) {
                const ariaLabel = titleEvEl.getAttribute('aria-label') || '';
                const seMatch = ariaLabel.match(/S(\d+):E(\d+)/i);
                const textLines = (titleEvEl.innerText || titleEvEl.textContent).trim().split('\n').map(l => l.trim()).filter(Boolean);
                const showName = textLines[0] || document.querySelector('h2')?.textContent.trim();
                if (seMatch && showName) {
                    cachedNetflixTitle = `${showName} - Season ${seMatch[1]} Episode ${seMatch[2]}`;
                    return cachedNetflixTitle;
                }
            }
        } catch (e) { /* ignore */ }

        // Last resort: document.title (probably "Netflix", will trigger a background lookup)
        return title;
    }

    // --- Crunchyroll ---
    if (window.location.hostname.includes('crunchyroll.com')) {
        try {
            // STRATEGY 1: JSON-LD (Most Reliable)
            const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of ldScripts) {
                try {
                    const json = JSON.parse(script.textContent);
                    if (json['@type'] === 'TVEpisode' || json.partOfSeries) {
                        const series = json.partOfSeries?.name;
                        const episodeNumber = json.episodeNumber;
                        if (series && episodeNumber) {
                            console.log("[Ghost Scrobbler] Crunchyroll JSON-LD:", series, "Ep", episodeNumber);
                            return `${series} - Episode ${episodeNumber}`;
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // STRATEGY 2: DOM (Updated Selectors for 2024/2025 UI)
            // Show title is often in an H4 with a link, or just H4
            let crShow = "";
            let crEp = "";

            // Try to find the show title link (often in the "up next" or "info" area)
            const showLink = document.querySelector('a[href*="/series/"] h4') ||
                document.querySelector('h4.text--gq6o-'); // specific class if standard fails

            if (showLink) {
                crShow = showLink.textContent;
            } else {
                // Fallback: look for any h4 that isn't the episode title
                const h4s = document.getElementsByTagName('h4');
                if (h4s.length > 0) crShow = h4s[0].textContent;
            }

            // Episode title is usually the main H1
            const headings = document.getElementsByTagName('h1');
            if (headings.length > 0) crEp = headings[0].textContent;

            if (crShow && crEp) {
                // Check if crEp contains "E11" or similar
                const epMatch = crEp.match(/E(\d+)/) || crEp.match(/Episode\s+(\d+)/i);
                if (epMatch) {
                    return `${crShow} - Episode ${epMatch[1]}`;
                }
                // If the episode title is just the name (e.g. "Winter in the Northern Lands"), 
                // we might need to rely on the season/episode info which is sometimes separate.
                return `${crShow} - ${crEp}`; // "Frieren - Winter in the Northern Lands"
            }

            // STRATEGY 3: Meta tags (og:title often has "Show - Ep N - Title")
            const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
            if (ogTitle) {
                // Crunchyroll og:title format: "Watch Frieren: Beyond Journey's End - E11 - Winter in the Northern Lands"
                // Remove "Watch " prefix if present
                const cleanOg = ogTitle.replace(/^Watch\s+/i, '');
                console.log("[Ghost Scrobbler] Crunchyroll Meta:", cleanOg);
                return cleanOg;
            }

            // STRATEGY 4: Page Title (document.title)
            // "Frieren: Beyond Journey's End Episode 11, Winter in the Northern Lands - Watch on Crunchyroll"
            if (document.title.includes(" - Watch on Crunchyroll")) {
                return document.title.replace(" - Watch on Crunchyroll", "");
            }

        } catch (e) { console.warn("Crunchyroll scraper error:", e); }
    }

    return title;
}

// ── Listen for metadata requests from background (top frame only) ──

if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "getMetadata" && IS_TOP_FRAME) {
            const title = extractTitle();
            console.log("[Ghost Scrobbler] Top frame responding with metadata:", title);
            sendResponse({ title: title });
        }
        else if (request.action === "showToast" && IS_TOP_FRAME) {
            showToast(request.message);
        }
        return true;
    });
}

// ── Toast Notification UI ──
function showToast(message) {
    // Avoid duplicates
    if (document.getElementById('ghost-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'ghost-toast';
    toast.textContent = message;

    // Inline Styles for "Small Popup from Below"
    Object.assign(toast.style, {
        position: 'fixed',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%) translateY(100px)', // Start below screen
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        color: '#fff',
        padding: '12px 24px',
        borderRadius: '50px',
        zIndex: '999999',
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: '14px',
        fontWeight: '500',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
        opacity: '0',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
    });

    // Add Icon (Simple SVG)
    const icon = document.createElement('span');
    icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#e50914"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>';
    toast.prepend(icon);

    document.body.appendChild(toast);

    // Animate In
    requestAnimationFrame(() => {
        toast.style.transform = 'translateX(-50%) translateY(0)';
        toast.style.opacity = '1';
    });

    // Remove after 4 seconds
    setTimeout(() => {
        toast.style.transform = 'translateX(-50%) translateY(100px)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ── Video Detection ──

function sendScrobbleMessage(video, status) {
    const progress = video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0;

    // Stop if previously invalidated
    if (isInvalidated) return;

    // If in iframe, don't extract title (it will be wrong like "Vilos")
    // Background will ask the top frame for the real title
    const title = IS_TOP_FRAME ? extractTitle() : "";

    console.log(`[Ghost Scrobbler] Sending: status=${status}, title="${title || '(iframe, needs metadata)'}", progress=${progress}%`);

    if (!chrome?.runtime?.sendMessage) {
        console.warn("[Ghost Scrobbler] chrome.runtime not available in this frame, skipping.");
        return;
    }

    try {
        chrome.runtime.sendMessage({
            action: "scrobble",
            data: { status: status, title: title, progress: progress, fromIframe: !IS_TOP_FRAME }
        });
    } catch (e) {
        console.log("[Ghost Scrobbler] Message failed (Extension invalidated?):", e);
        // If extension is invalidated, stop everything
        if (e.message.includes("Extension context invalidated")) {
            console.log("[Ghost Scrobbler] Stopping script due to invalidation.");
            isInvalidated = true;
            clearInterval(videoCheckInterval);
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        }
    }
}

let videoCheckInterval; // Store check interval ID
let heartbeatInterval;  // Store heartbeat interval ID

function checkForVideo() {
    const videos = document.getElementsByTagName('video');
    if (videos.length > 0) {
        monitorVideo(videos[0]);
    }
}

// Waits for Netflix player controls to render, then calls cb.
// Uses MutationObserver for immediate response instead of polling.
async function waitForNetflixPlayer(cb) {
    // Strategy 1: Netflix metadata via window.netflix (needs MAIN world — done in background.js)
    // Here just wait for the DOM player bar with any aria-label
    const tryFire = () => {
        const el = document.querySelector('[class*="player-title-evidence"]');
        const ariaLabel = el?.getAttribute('aria-label') || '';
        if (ariaLabel.trim()) {
            console.log('[Ghost Scrobbler] Netflix player ready (MutationObserver), aria-label:', ariaLabel);
            observer.disconnect();
            clearTimeout(fallback);
            cb();
            return true;
        }
        return false;
    };

    // Immediate check (element may already be there)
    if (tryFire()) return;

    const observer = new MutationObserver(() => { tryFire(); });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label']
    });

    // Hard fallback — fire after 12s regardless
    const fallback = setTimeout(() => {
        observer.disconnect();
        console.log('[Ghost Scrobbler] Netflix player wait timed out, firing anyway.');
        cb();
    }, 12000);
}

function monitorVideo(video) {
    if (video.getAttribute('data-ghost-monitored')) return;
    video.setAttribute('data-ghost-monitored', 'true');

    // Stop searching once found? Maybe not, SPA logic might remove/add video.
    // For now keep searching but duplicate check handles it.

    console.log("[Ghost Scrobbler] Monitoring video element" + (IS_TOP_FRAME ? " (top frame)" : " (iframe)"));

    video.addEventListener('play', async () => {
        console.log("[Ghost Scrobbler] Video play event fired.");
        if (window.location.hostname.includes('netflix.com') && !cachedNetflixTitle) {
            await fetchNetflixTitleFromAPI();
        }
        sendScrobbleMessage(video, 'playing');
    });

    video.addEventListener('pause', () => {
        console.log("[Ghost Scrobbler] Video paused.");
        sendScrobbleMessage(video, 'paused');
    });

    video.addEventListener('ended', () => {
        console.log("[Ghost Scrobbler] Video ended.");
        sendScrobbleMessage(video, 'stopped');
    });

    // KEY FIX: If video is ALREADY playing when we find it, send but wait for player UI to render first
    if (!video.paused && !video.ended) {
        console.log("[Ghost Scrobbler] Video already playing, sending now.");
        if (window.location.hostname.includes('netflix.com')) {
            // On Netflix: wait for player UI AND pre-fetch title via shakti API before first scrobble
            waitForNetflixPlayer(async () => {
                if (!cachedNetflixTitle) {
                    await fetchNetflixTitleFromAPI();
                }
                sendScrobbleMessage(video, 'playing');
            });
        } else {
            sendScrobbleMessage(video, 'playing');
        }
    }

    // Heartbeat: Check every 10 seconds if still playing to keep extension status alive
    // This fixes "Stuck on Paused" issue if events are missed
    if (heartbeatInterval) clearInterval(heartbeatInterval); // Clear existing if re-monitoring
    heartbeatInterval = setInterval(() => {
        if (!video.paused && !video.ended) {
            // sendScrobbleMessage checks for extension invalidation internally
            sendScrobbleMessage(video, 'playing');
        }
    }, 10000);

    // Save progress when user closes tab or navigates away
    window.addEventListener('beforeunload', () => {
        if (!video.paused && !video.ended) {
            console.log("[Ghost Scrobbler] Page unloading, saving progress...");
            sendScrobbleMessage(video, 'paused');
        }
    });
}

// Check periodically for dynamic content loading (SPA)
videoCheckInterval = setInterval(checkForVideo, 2000);
