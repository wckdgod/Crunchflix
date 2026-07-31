importScripts('config.js');

const VERSION = "2.0.0";
console.log(`[CRUNCHFLIX] Background script loaded. Version: ${VERSION}`);

async function remoteLog(message, context = 'BG', level = 'INFO') {
    try {
        await fetch('http://localhost:9999/log', {
            method: 'POST',
            body: JSON.stringify({ message, context, level }),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        // Silent fail if logger isn't running
    }
}
remoteLog(`Background service worker started. Build: ${VERSION}`, 'INIT');

// --- State Management ---
const ports = new Map();         // tabId -> port
const shaktiKeys = new Map();    // tabId -> { buildId, authUrl }
const simklSearchCache = new Map(); // title -> searchResult
const tabResolvedTitle = new Map(); // tabId -> { title, epId }
const scrobbledSessionHistory = new Set(); // title:S:E
const resolvedTitleCache = new Map(); // tabId:epId -> resolvedMetadata
const lastScrobble = { title: null, season: null, episode: null, status: null, timestamp: 0 };

let isSyncing = false; // Guard to prevent concurrent history syncs

// --- Port Management (Tab Communication) ---
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "crunchflix-port") return;
    const tabId = port.sender?.tab?.id;
    if (tabId) ports.set(tabId, port);

    port.onMessage.addListener((message) => {
        if (message.action === "scrobble") {
            handleScrobble(message.payload, port.sender);
        } else if (message.action === "progress_update") {
            handleLiveProgress(message.payload, port.sender);
        } else if (message.action === "STORE_SHAKTI_KEYS") {
            // Protocol-First Normalization: standardize to authUrl immediately
            const normalized = {
                buildId: message.payload.buildId,
                authUrl: message.payload.authUrl || message.payload.authURL || message.payload.authurl
            };
            shaktiKeys.set(tabId, normalized);
            chrome.storage.local.set({ shakti: normalized });
        }
    });

    port.onDisconnect.addListener(() => {
        if (tabId) ports.delete(tabId);
    });
});

function sendMessageToTab(tabId, message) {
    const port = ports.get(tabId);
    if (port) {
        port.postMessage(message);
    } else {
        chrome.tabs.sendMessage(tabId, message).catch(() => { });
    }
}

// --- Message Listener (Requests from non-port contexts like Popup/History) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender?.tab?.id;

    if (message.action === "fetchNetflixHistory") {
        fetchNetflixHistory(sendResponse);
        return true;
    }
    else if (message.action === "bulkCheckTrakt" || message.action === "bulkCheckSimkl") {
        bulkCheckSimkl(message.payload?.items || message.items, sendResponse);
        return true;
    }
    else if (message.action === "bulkSyncToTrakt" || message.action === "bulkSyncToSimkl") {
        bulkSyncToSimkl(message.payload?.items || message.items, sendResponse);
        return true;
    }
    else if (message.action === "performTraktSearch" || message.action === "performSimklSearch") {
        handleSimklSearch(message.query, message.type, sendResponse);
        return true;
    }
    else if (message.action === "resolveTraktUrl" || message.action === "resolveSimklUrl") {
        resolveSimklUrl(message.url, sendResponse);
        return true;
    }
    else if (message.action === "searchTrakt" || message.action === "searchTraktForPopup" || message.action === "searchSimkl" || message.action === "searchSimklForPopup") {
        (async () => {
            try {
                const storage = await chrome.storage.local.get(['simkl_token', 'trakt_token']);
                const token = storage.simkl_token?.access_token || storage.trakt_token?.access_token;
                if (!token) throw new Error("No Simkl token found.");

                const searchType = message.payload?.type || 'tv';
                const results = await doSearchRaw(message.payload?.query || message.query, token, searchType);
                sendResponse({ success: true, results: results });
            } catch (e) {
                console.error(e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }
    else if (message.action === "setCorrection") {
        (async () => {
            try {
                const { originalTitle, correctionResult } = message.payload;
                const cleanTitle = sanitizeShowTitle(originalTitle);
                const storage = await chrome.storage.local.get(['corrections']);
                const corrections = storage.corrections || {};

                corrections[cleanTitle] = {
                    data: correctionResult,
                    offsets: corrections[cleanTitle]?.offsets || {}
                };
                await chrome.storage.local.set({ corrections });

                simklSearchCache.delete(originalTitle);
                simklSearchCache.delete(cleanTitle);

                sendResponse({ success: true });
                if (tabId) handleScrobble({ title: originalTitle, status: 'playing', progress: 1 }, sender);
            } catch (e) {
                console.error(e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }
    else if (message.action === "clearCache") {
        const title = message.payload?.title;
        if (title) {
            simklSearchCache.delete(title);
            const clean = sanitizeShowTitle(title);
            simklSearchCache.delete(clean);
        }
        sendResponse({ success: true });
    }
    else if (message.action === "CLEAR_MEMORY_CACHE") {
        simklSearchCache.clear();
        sendResponse({ success: true });
    }
});

// --- Lifecycle Management ---
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url || info.status === 'loading') {
        // Aggressively clear tab metadata on any navigation or reload
        console.log(`[CRUNCHFLIX] Tab ${tabId} updated (${info.status || 'url change'}), clearing metadata...`);
        for (const key of resolvedTitleCache.keys()) {
            if (key.startsWith(`${tabId}:`)) resolvedTitleCache.delete(key);
        }
        tabResolvedTitle.delete(tabId);
        
        // Clear nowPlaying if it belonged to this tab
        chrome.storage.local.get(['nowPlaying'], (res) => {
            if (res.nowPlaying && res.nowPlaying.tabId === tabId) {
                chrome.storage.local.remove('nowPlaying');
            }
        });
    }
});
chrome.tabs.onRemoved.addListener((tabId) => {
    for (const key of resolvedTitleCache.keys()) {
        if (key.startsWith(`${tabId}:`)) resolvedTitleCache.delete(key);
    }
    shaktiKeys.delete(tabId);
    ports.delete(tabId);

    // Clear nowPlaying if it belonged to this tab
    chrome.storage.local.get(['nowPlaying'], (res) => {
        if (res.nowPlaying && res.nowPlaying.tabId === tabId) {
            chrome.storage.local.remove('nowPlaying');
        }
    });
});

chrome.runtime.onStartup.addListener(() => {
    console.log("[CRUNCHFLIX] Browser startup, clearing nowPlaying state.");
    chrome.storage.local.remove('nowPlaying');
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("[CRUNCHFLIX] Extension installed/updated, clearing nowPlaying state.");
    chrome.storage.local.remove('nowPlaying');
});

async function getShowDetails(idOrSlug) {
    const storage = await chrome.storage.local.get(['trakt_token', 'client_id']);
    const token = storage.trakt_token?.access_token;
    const clientId = storage.client_id;

    if (!token) throw new Error("Not authenticated");
    if (!clientId) throw new Error("Client ID not configured");

    const url = `${API_URL}/shows/${idOrSlug}?extended=full`;
    const res = await fetch(url, {
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': clientId,
            'Authorization': `Bearer ${token}`
        }
    });
    if (!res.ok) return null;
    return await res.json();
}

// --- Helper Functions ---

function extractEpId(url) {
    const match = url.match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
}

async function resolveNetflixTitle(epId, tabId) {
    // 1. Try the new NQ Netflix API (Does not require buildId!)
    const nqUrl = `https://www.netflix.com/nq/website/memberapi/release/metadata?movieid=${epId}&imageFormat=jpg&withSize=true&materialize=true`;
    console.log(`[CRUNCHFLIX] [NQ API] Fetching: ${nqUrl}`);
    try {
        const response = await fetch(nqUrl, {
            method: 'GET',
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();
            const video = data?.video;

            if (video) {
                console.log(`[CRUNCHFLIX] [NQ API] Video Type: ${video.type}, Title: ${video.title}`);

                if (video.type === 'movie') {
                    return { title: video.title, type: 'movie' };
                }

                // EPISODE-SPECIFIC PAYLOAD (sometimes returned if materialize=true is missing/partial)
                if (video.type === 'episode') {
                    console.log(`[CRUNCHFLIX] [NQ API] Direct episode hit: S${video.seasonSeq}E${video.episodeSeq}`);
                    return {
                        title: video.parentTitle || video.title,
                        type: 'show',
                        season: video.seasonSeq || null,
                        episode: video.episodeSeq || video.seq || null
                    };
                }

                if (video.type === 'show') {
                    let seasonNum = null;
                    let episodeNum = null;
                    const urlId = parseInt(epId);
                    const currentId = video.currentEpisode;

                    console.log(`[CRUNCHFLIX] [NQ API] Searching show for URL ID: ${urlId} (CurrentBookmark: ${currentId})`);

                    if (video.seasons && Array.isArray(video.seasons)) {
                        for (const seasonObj of video.seasons) {
                            // Try URL ID first, then currentId
                            const epMatch = seasonObj.episodes?.find(e =>
                                e.id == urlId || e.episodeId == urlId ||
                                e.id == currentId || e.episodeId == currentId
                            );

                            if (epMatch) {
                                seasonNum = seasonObj.seq;
                                episodeNum = epMatch.seq;
                                console.log(`[CRUNCHFLIX] [NQ API] Found MATCH in Season ${seasonNum}! Ep Seq: ${episodeNum}`);
                                break;
                            }
                        }
                    }

                    if (!seasonNum) {
                        console.warn(`[CRUNCHFLIX] [NQ API] Failed to match ID ${epId} in seasons list.`);
                    }

                    return {
                        title: video.title, // Show Name
                        type: "show",
                        season: seasonNum,
                        episode: episodeNum
                    };
                }
            }
        }
    } catch (e) {
        console.warn("[CRUNCHFLIX] NQ metadata endpoint failed:", e);
    }

    // 2. Fallback to pathEvaluator if NQ API fails...
    console.log("[CRUNCHFLIX] NQ API failed, falling back to pathEvaluator.");
    const storage = await chrome.storage.local.get(['shakti']);
    const keys = shaktiKeys.get(tabId);
    const shakti = keys || storage.shakti;
    const rawToken = shakti?.authUrl || shakti?.authURL || shakti?.authurl;

    // Robust Unescaping (same as sync recovery)
    let activeToken = rawToken ? rawToken.replace(/\\u([0-9a-fA-F]{4})/g, (m, g) => String.fromCharCode(parseInt(g, 16))).replace(/\\(.)/g, '$1') : null;

    if (!activeToken || !keys?.buildId) {
        console.warn("[CRUNCHFLIX] Missing Shakti keys for live scrobbler. Attempting recovery...");
        const recovered = await fetchAndScrapeNetflixAuth();
        if (recovered && recovered.authUrl) {
            // Re-resolve keys with the newly scraped token
            const freshKeys = shaktiKeys.get(tabId) || { buildId: keys?.buildId || 'shakti', authUrl: recovered.authUrl, guid: recovered.guid };
            return resolveNetflixTitle(epId, tabId); // Recurse once with new keys
        }
        return null;
    }

    let shaktiUrl = `https://www.netflix.com/api/shakti/${keys.buildId}/pathEvaluator?languages=en-US`;
    if (shakti?.guid) shaktiUrl += `&guid=${shakti.guid}`;

    // Based on universal-trakt-scrobbler graph paths
    const payload = {
        authURL: activeToken,
        paths: [
            ["videos", epId, ["title", "summary", "episodeSummary"]],
            ["videos", epId, "show", ["title", "summary"]],
            ["videos", epId, "ancestor", ["title", "summary"]],
            ["videos", epId, "seasonList", "current", ["summary", "name"]] // Fetch the season list
        ]
    };

    try {
        const response = await fetch(shaktiUrl, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) return null;
        const data = await response.json();
        const videoData = data?.value?.videos?.[epId];

        if (videoData) {
            console.log("[CRUNCHFLIX] [Falcor Debug] Raw Netflix Data:", JSON.stringify(videoData, null, 2));

            // Fallback chain: Try to get Ancestor Title, then Show Title, then standard title
            const actualShowTitle = videoData.ancestor?.title || videoData.show?.title || videoData.title;

            if (videoData.summary?.type === 'movie') {
                return { title: actualShowTitle, type: 'movie' };
            }

            // Trust episodeSummary over summary if available
            const epsTarget = videoData.episodeSummary || videoData.summary || {};
            const seasonNum = epsTarget.season || null;
            const episodeNum = epsTarget.episode || null;

            return {
                title: actualShowTitle,
                type: videoData.summary?.type || "show",
                season: seasonNum,
                episode: episodeNum
            };
        }
    } catch (e) {
        console.error("[CRUNCHFLIX] pathEvaluator lookup failed:", e);
    }
    return null;
}

function handleLiveProgress(payload, sender) {
    if (!payload || payload.progress === undefined) return;
    chrome.storage.local.get(['nowPlaying'], (res) => {
        if (res.nowPlaying && (res.nowPlaying.status === 'scrobbling' || res.nowPlaying.status === 'playing')) {
            const updated = { ...res.nowPlaying, progress: payload.progress };
            chrome.storage.local.set({ nowPlaying: updated });

            // Broadcast targeted live progress message specifically for smooth UI 
            chrome.runtime.sendMessage({ action: "LIVE_PROGRESS", progress: payload.progress }).catch(() => { });
        }
    });
}

async function handleScrobble(data, sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return;

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tabUrl = tab?.url || "";

    console.log("[CRUNCHFLIX] Processing scrobble heartbeat...");

    // ── 1. RESOLUTION: Define the clean title ──

    try {
        if (tabUrl.includes('netflix.com')) {
            const epId = extractEpId(tabUrl);
            console.log(`[CRUNCHFLIX] Netflix match: epId=${epId} from URL: ${tabUrl}`);

            if (epId) {
                const cacheKey = `${tabId}:${epId}`;

                // Check in-tab cache first
                if (tabResolvedTitle.has(tabId)) {
                    const cached = tabResolvedTitle.get(tabId);
                    if (cached.epId === epId) {
                        data.title = cached.title;
                        console.log("[CRUNCHFLIX] Using tab-cached metadata:", data.title);
                    }
                }

                // If no tab-cache, try global epId cache or Shakti
                if (!data.title) {
                    if (resolvedTitleCache.has(cacheKey)) {
                        data.title = resolvedTitleCache.get(cacheKey);
                        console.log("[CRUNCHFLIX] Using global-cached metadata:", data.title);
                    } else {
                        console.log(`[CRUNCHFLIX] Cache miss for ${epId}. Resolving via pathEvaluator...`);
                        const metadata = await resolveNetflixTitle(epId, tabId);
                        if (metadata && metadata.title) {
                            // Reconstruct the composite title for episodes to keep parseTitle/UI compatible
                            if (metadata.season !== null && metadata.episode !== null) {
                                data.title = `${metadata.title} - Season ${metadata.season} Episode ${metadata.episode}`;
                            } else {
                                data.title = metadata.title;
                            }

                            resolvedTitleCache.set(cacheKey, data.title);
                            tabResolvedTitle.set(tabId, { title: data.title, epId: epId });
                            console.log(`[CRUNCHFLIX] Successfully cached MRE metadata:`, data.title);
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn("[CRUNCHFLIX] Primary resolution failed, falling back to scrapers...");
    }

    // ── 2. FALLBACK: Scrapers, Tab Title ──

    if (!data.title) {
        try {
            const response = await chrome.tabs.sendMessage(tabId, { action: "getMetadata" }, { frameId: 0 });
            if (response?.title) data.title = response.title;
        } catch (e) { }
    }

    // ── 3. VALIDATION: Handle generic titles and retries ──
    const isGenericTitle = (title) => {
        if (!title) return true;
        const t = title.trim().toLowerCase();
        if (t === "") return true;
        if (t.includes("season") && !t.includes("episode") && !t.includes("ep.") && !t.includes("ep ")) return true;
        const exactMatches = ["vilos", "netflix", "crunchyroll", "watch", "{iframe, needs metadata}", "jiohotstar", "jio hotstar", "hotstar", "disney+ hotstar", "prime video", "primevideo", "amazon prime", "amazon prime video", "amazon"];
        if (exactMatches.includes(t)) return true;
        if (t.includes("watch tv shows, movies") || t.includes("live cricket") || t.startsWith("netflix - ")) return true;
        return false;
    };

    if (isGenericTitle(data.title)) {
        const tabTitle = sender?.tab?.title || "";
        // Only use tab title if it's not also a generic name
        data.title = isGenericTitle(tabTitle) ? null : tabTitle;
    }

    // If STILL generic, schedule a retry in 5s (but NOT more than 3 times per tab to avoid spam)
    if (isGenericTitle(data.title)) {
        if (sender?.tab?.id) {
            const retryKey = `retry:${sender.tab.id}`;
            const retryCount = (globalThis[retryKey] || 0) + 1;
            if (retryCount <= 3) {
                globalThis[retryKey] = retryCount;
                console.log(`[CRUNCHFLIX] Title still unknown, scheduling retry ${retryCount}/3...`);
                setTimeout(() => {
                    handleScrobble({ ...data, title: null }, sender);
                }, 5000);
            } else {
                // Reset after some time or on new message
                setTimeout(() => delete globalThis[retryKey], 20000);
            }
        }
        return;
    }
    // Success — reset retry count
    if (sender?.tab?.id) delete globalThis[`retry:${sender.tab.id}`];

    // Get current state to check if we need to update UI
    const storage = await chrome.storage.local.get(['trakt_token', 'corrections', 'client_id', 'nowPlaying']);

    // IMMEDIATE UI FEEDBACK: Update storage with the raw title so the popup doesn't stay stuck on the previous show
    const currentNP = storage.nowPlaying || {};
    const isNewShow = (currentNP.rawTitle || currentNP.title) !== data.title && !isGenericTitle(data.title);
    
    // STATE PROTECTION: If we already have a detailed "scrobbling" status from a tab,
    // don't let a generic "resolving" message from an iframe (usually data.fromIframe) overwrite it.
    const isIframeOverwrite = data.fromIframe && currentNP.status === 'scrobbling' && currentNP.tabId === tabId;

    if (isNewShow && !isIframeOverwrite) {
        console.log(`[CRUNCHFLIX] New show detected: "${data.title}". Overwriting stale state ("${currentNP.rawTitle || currentNP.title}").`);
        
        // Reset throttle to ensure this new show's first message always processes
        lastScrobble.title = null;
        lastScrobble.timestamp = 0;

        chrome.storage.local.set({
            'nowPlaying': {
                status: 'resolving',
                title: data.title,
                rawTitle: data.title,
                timestamp: Date.now(),
                platform: data.platform,
                tabId: tabId
            }
        });
    }

    // 1. Get Token
    const token = storage.simkl_token?.access_token || storage.trakt_token?.access_token;

    if (!token) {
        console.log("No Simkl token found, ignoring.");
        return;
    }

    // 2. Parse Title
    const platform = data.platform || 'netflix';
    const parsed = await parseTitle(data.title, platform);
    if (!parsed) {
        console.log("Could not parse title:", data.title);
        chrome.storage.local.set({
            'nowPlaying': { status: 'parse_error', title: data.title, rawTitle: data.title }
        });
        return;
    }

    // IMMEDIATE UI UPDATE: If same show, update status now (UI feels snappy)
    if (storage.nowPlaying && storage.nowPlaying.title === parsed.title) {
        const uiStatus = data.status === 'playing' ? 'scrobbling' : (data.status === 'paused' ? 'paused' : 'stopped');
        if (storage.nowPlaying.status !== uiStatus) {
            chrome.storage.local.set({
                'nowPlaying': { ...storage.nowPlaying, status: uiStatus, timestamp: Date.now() }
            });
        }
    }

    console.log(`[CRUNCHFLIX] Successfully parsed metadata: "${parsed.title}" S${parsed.season}E${parsed.episode}`);

    if (tabId && platform === 'netflix') {
        tabResolvedTitle.set(tabId, { title: data.title, epId: extractEpId(tabUrl) });
    }

    let finalImage = null;
    let synopsis = null;
    
    // 3. Search Simkl (Priority: 1. Manual Corrections, 2. Memory Cache, 3. API Search)
    let searchResult = null;
    const corrections = storage.corrections || {};
    const cleanForCorrection = sanitizeShowTitle(parsed.title);

    if (corrections[cleanForCorrection]) {
        const correctionObj = corrections[cleanForCorrection];

        if (correctionObj.data || !correctionObj.offsets) {
            const resultData = correctionObj.data || correctionObj;
            console.log(`[CRUNCHFLIX] Using show-level override for "${cleanForCorrection}":`, (resultData.show || resultData.movie)?.title);
            searchResult = resultData;
        }

        if (parsed.type === 'episode' && correctionObj.offsets) {
            const mappingKey = `${parsed.season}_${parsed.episode}`;
            if (correctionObj.offsets[mappingKey]) {
                const mapped = correctionObj.offsets[mappingKey];
                console.log(`[CRUNCHFLIX] Applying episode offset: S${parsed.season}E${parsed.episode} -> S${mapped.s}E${mapped.e}`);
                parsed.season = mapped.s;
                parsed.episode = mapped.e;
            }
        }
    }

    if (!searchResult && simklSearchCache.has(parsed.title)) {
        const cached = simklSearchCache.get(parsed.title);
        const cachedEntity = cached.show || cached.movie || cached;
        const cachedIsShow = !!cached.show || cached.ids?.simkl || cached.ids?.imdb;
        const needsShow = parsed.type === 'episode';
        if (cachedIsShow === needsShow) {
            console.log(`[CRUNCHFLIX] Using search cache for "${parsed.title}"`);
            searchResult = cached;
        } else {
            simklSearchCache.delete(parsed.title);
        }
    }

    if (!searchResult) {
        searchResult = await searchSimkl(parsed.title, parsed.type, token, data.year);
        if (searchResult) {
            simklSearchCache.set(parsed.title, searchResult);
        }
    }

    if (!searchResult) {
        console.log("Show not found on Simkl:", parsed.title);
        chrome.storage.local.set({
            'nowPlaying': { status: 'not_found', title: parsed.title, rawTitle: data.title, progress: data.progress || 0 }
        });
        return;
    }

    const show = searchResult.show || searchResult.movie || searchResult;
    console.log("Found Item on Simkl:", show.title, "ID:", show.ids?.simkl || show.ids?.imdb || show.ids?.tmdb);

    finalImage = show.poster ? `https://simkl.in/posters/${show.poster}_m.jpg` : null;
    if (!finalImage && show.ids?.tmdb) {
        finalImage = await getTmdbImageById(show.ids.tmdb, parsed.type);
    }
    if (!finalImage) {
        finalImage = await getTmdbImage(parsed.title, parsed.type);
    }

    synopsis = show.overview || null;
    if (parsed.type === 'episode' && show.ids?.simkl) {
        const epOverview = await getSimklEpisodeOverview(show.ids.simkl, parsed.season || 1, parsed.episode, token);
        if (epOverview) synopsis = epOverview;
    }

    let actionType = 'stop';
    if (data.status === 'playing') actionType = 'start';
    else if (data.status === 'paused') actionType = 'pause';

    const now = Date.now();
    const isSameEpisode = (parsed.title === lastScrobble.title &&
        parsed.season === lastScrobble.season &&
        parsed.episode === lastScrobble.episode);
    const isSameStatus = actionType === lastScrobble.status;
    const timeDiff = now - lastScrobble.timestamp;
    const THROTTLE_LIMIT = 10000;

    if (isSameEpisode && isSameStatus && timeDiff < THROTTLE_LIMIT) {
        console.log(`[CRUNCHFLIX] Throttling API call (${actionType}). Last sent ${timeDiff / 1000}s ago.`);
        chrome.storage.local.get(['nowPlaying'], (res) => {
            if (res.nowPlaying && res.nowPlaying.title === parsed.title) {
                chrome.storage.local.set({
                    nowPlaying: { ...res.nowPlaying, progress: data.progress || res.nowPlaying.progress || 0, synopsis: synopsis || res.nowPlaying.synopsis }
                });
            }
        });
        return;
    }

    if (isSameEpisode && !isSameStatus && timeDiff < THROTTLE_LIMIT) {
        const existing = await chrome.storage.local.get(['nowPlaying']);
        if (existing.nowPlaying) {
            const uiStatus = actionType === 'start' ? 'scrobbling' : (actionType === 'pause' ? 'paused' : 'stopped');
            chrome.storage.local.set({
                'nowPlaying': { ...existing.nowPlaying, status: uiStatus, timestamp: Date.now(), progress: data.progress || existing.nowPlaying.progress || 0, synopsis: synopsis || existing.nowPlaying.synopsis }
            });
        }
    }

    const netflixEpId = extractEpId(tabUrl);
    const progressVal = Math.min(100, Math.max(0, parseFloat((data.progress || 1).toFixed(2))));

    const payload = {};
    if (parsed.type === 'episode') {
        let targetSeason = parsed.season;
        payload.shows = [
            {
                title: show.title || parsed.title,
                year: show.year || data.year || null,
                ids: {
                    ...(show.ids || {}),
                    ...(netflixEpId ? { netflix: parseInt(netflixEpId) } : {})
                },
                episodes: [
                    {
                        season: targetSeason || 1,
                        number: parsed.episode
                    }
                ]
            }
        ];
    } else {
        payload.movies = [
            {
                title: show.title || parsed.title,
                year: show.year || data.year || null,
                ids: {
                    ...(show.ids || {}),
                    ...(netflixEpId ? { netflix: parseInt(netflixEpId) } : {})
                }
            }
        ];
    }

    payload.progress = progressVal;
    const historyKey = `${parsed.title}:${parsed.season}:${parsed.episode}`;

    if (payload.progress >= 85) {
        actionType = 'stop';
        if (scrobbledSessionHistory.has(historyKey)) {
            console.log(`[CRUNCHFLIX] Already scrobbled ${historyKey} as 'stop'. Skipping.`);
            return;
        }
    }

    console.log(`[CRUNCHFLIX] MATCHED SHOW: ${parsed.title} (Simkl ID: ${show.ids?.simkl})`);

    if (sender?.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
            action: "showToast",
            message: `Identified: ${show.title}`
        }).catch(() => { });
    }

    console.log(`[CRUNCHFLIX] Sending ${actionType} to Simkl...`, payload);
    await sendScrobble(actionType, payload, token);

    if (actionType === 'stop') {
        scrobbledSessionHistory.add(historyKey);
    }

    lastScrobble.title = parsed.title;
    lastScrobble.season = parsed.season;
    lastScrobble.episode = parsed.episode;
    lastScrobble.status = actionType;
    lastScrobble.timestamp = Date.now();

    const finalSeason = parsed.type === 'episode' ? (parsed.season || 1) : parsed.season;

    chrome.storage.local.set({
        'nowPlaying': {
            title: parsed.title,
            rawTitle: data.title,
            type: parsed.type,
            season: finalSeason,
            episode: parsed.episode,
            image: finalImage,
            status: actionType === 'start' ? 'scrobbling' : (actionType === 'pause' ? 'paused' : 'stopped'),
            timestamp: Date.now(),
            traktTitle: show.title,
            traktYear: show.year,
            year: show.year,
            synopsis: synopsis,
            rating: show.ratings?.simkl?.rating ? show.ratings.simkl.rating.toFixed(1) : null,
            genres: show.genres ? show.genres.slice(0, 3) : [],
            runtime: show.runtime || null,
            certification: show.certification || null,
            network: show.network || null
        }
    });
}

async function getSimklEpisodeOverview(showId, season, episode, token) {
    try {
        if (!showId) return null;
        const url = getSimklUrl(`/tv/episodes/${showId}`);
        const res = await fetch(url, {
            headers: getSimklHeaders(token)
        });
        if (!res.ok) return null;
        const episodes = await res.json();
        if (Array.isArray(episodes)) {
            const ep = episodes.find(e => e.season == season && e.episode == episode);
            return ep?.description || ep?.overview || null;
        }
        return null;
    } catch (e) {
        console.warn('[CRUNCHFLIX] Could not fetch Simkl episode overview:', e);
        return null;
    }
}

// This function is injected into the tab's MAIN frame by chrome.scripting.executeScript
// It must be self-contained (no references to outer scope)
function extractMetadataFromPage() {
    let title = document.title;
    let year = null;

    // --- Crunchyroll ---
    if (window.location.hostname.includes('crunchyroll.com')) {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
            try {
                const json = JSON.parse(script.textContent);

                if (json.datePublished || json.uploadDate) {
                    const d = new Date(json.datePublished || json.uploadDate);
                    if (!isNaN(d.getFullYear())) year = d.getFullYear();
                }

                if (json['@type'] === 'TVEpisode' || json.partOfSeries) {
                    const series = json.partOfSeries?.name;
                    const episodeNumber = json.episodeNumber;

                    if (!year && json.partOfSeries?.startDate) {
                        const d = new Date(json.partOfSeries.startDate);
                        if (!isNaN(d.getFullYear())) year = d.getFullYear();
                    }

                    if (series && episodeNumber) {
                        return { title: `${series} - Episode ${episodeNumber}`, year: year };
                    }
                }
            } catch (e) { /* ignore */ }
        }

        if (!year) {
            const releaseMatch = document.body.innerText.match(/Released on\s+\w+\s+\d+,\s+(\d{4})/);
            if (releaseMatch) year = releaseMatch[1];
        }

        let crShow = "";
        let crEp = "";
        const showLink = document.querySelector('a[href*="/series/"] h4');
        if (showLink) crShow = showLink.textContent;
        else {
            const h4s = document.getElementsByTagName('h4');
            if (h4s.length > 0) crShow = h4s[0].textContent;
        }
        const headings = document.getElementsByTagName('h1');
        if (headings.length > 0) crEp = headings[0].textContent;

        if (crShow && crEp) {
            const epMatch = crEp.match(/E(\d+)/);
            if (epMatch) return { title: `${crShow} - Episode ${epMatch[1]}`, year: year };
        }

        const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
        if (ogTitle) return { title: ogTitle, year: year };
    }

    // --- Netflix ---
    if (window.location.hostname.includes('netflix.com')) {
        try {
            // PRIMARY: player-title-evidence div — ALWAYS in DOM even before video renders.
            // aria-label = 'S2:E8 "Divergence"', first text line = show name.
            const titleEvEl = document.querySelector('[class*="player-title-evidence"]');
            if (titleEvEl) {
                const ariaLabel = titleEvEl.getAttribute('aria-label') || '';
                const seMatch = ariaLabel.match(/S(\d+):E(\d+)/i);
                // Join with space to avoid mashing names and episode numbers
                const text = (titleEvEl.innerText || titleEvEl.textContent).replace(/\n/g, ' ').trim();

                if (seMatch) {
                    // Try to find show name as the first part of the text before the SE info
                    let showPart = text.split(/S\d+:E\d+/i)[0].trim();

                    // If text was mashed together (e.g. "The Night AgentE5The Isolation Play")
                    // Extract just the show name before the E<number> part.
                    const mangledMatch = showPart.match(/^(.+?)(?:\s*[S\-:]{1,2}\d+)?[\s\-:]*E\d+/i);
                    if (mangledMatch) {
                        showPart = mangledMatch[1].trim();
                    }

                return { title: `${showName} - Season ${seasonNum} Episode ${epNum[1]}` };
                }
                return { title: `${showName} - ${epText}` };
            }
        } catch (e) { /* ignore */ }
    }

    // --- Jio Hotstar ---
    if (window.location.hostname.includes('hotstar.com') || window.location.hostname.includes('jiohotstar.com')) {
        try {
            // STRATEGY 0: Player UI (Highest accuracy)
            const playerTitleEl = document.querySelector('div[aria-label*="Season"][aria-label*="Episode"][role="button"]');
            if (playerTitleEl) {
                const aria = playerTitleEl.getAttribute('aria-label');
                if (aria) return { title: aria, year: year };
            }

            // STRATEGY 1: JSON-LD structured data
            const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of ldScripts) {
                try {
                    const json = JSON.parse(script.textContent);

                    if (json.datePublished || json.uploadDate) {
                        const d = new Date(json.datePublished || json.uploadDate);
                        if (!isNaN(d.getFullYear())) year = d.getFullYear();
                    }

                    if (json['@type'] === 'TVEpisode' || json.partOfSeries) {
                        const series = json.partOfSeries?.name;
                        const episodeNumber = json.episodeNumber;
                        const seasonNumber = json.partOfSeason?.seasonNumber;

                        if (!year && json.partOfSeries?.startDate) {
                            const d = new Date(json.partOfSeries.startDate);
                            if (!isNaN(d.getFullYear())) year = d.getFullYear();
                        }

                        if (series && episodeNumber) {
                            if (seasonNumber) {
                                return { title: `${series} Season ${seasonNumber} - Episode ${episodeNumber}`, year: year };
                            }
                            return { title: `${series} - Episode ${episodeNumber}`, year: year };
                        }
                    }

                    if (json['@type'] === 'Movie' && json.name) {
                        return { title: json.name, year: year };
                    }
                } catch (e) { /* ignore */ }
            }

            // STRATEGY 2: og:title meta tag
            const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
            if (ogTitle) {
                let cleaned = ogTitle
                    .replace(/^Watch\s+/i, '')
                    .replace(/\s*[|\-]\s*(?:Jio\s*)?Hotstar\s*$/i, '')
                    .replace(/\s*[|\-]\s*Disney\+?\s*Hotstar\s*$/i, '')
                    .replace(/\s+on\s+(?:Jio\s*)?Hotstar\s*$/i, '')
                    .replace(/\s+on\s+Disney\+?\s*Hotstar\s*$/i, '')
                    .trim();
                if (cleaned) return { title: cleaned, year: year };
            }

            // STRATEGY 3: Document title fallback
            let hsTitle = document.title
                .replace(/^Watch\s+/i, '')
                .replace(/\s*[|\-]\s*(?:Jio\s*)?Hotstar\s*$/i, '')
                .replace(/\s*[|\-]\s*Disney\+?\s*Hotstar\s*$/i, '')
                .replace(/\s+on\s+(?:Jio\s*)?Hotstar\s*$/i, '')
                .replace(/\s+on\s+Disney\+?\s*Hotstar\s*$/i, '')
                .trim();
            if (hsTitle && !["JioHotstar", "Jio Hotstar", "Hotstar", "Disney+ Hotstar", ""].includes(hsTitle)) {
                return { title: hsTitle, year: year };
            }
        } catch (e) { /* ignore */ }
    }

    // --- Amazon Prime Video ---
    if (window.location.hostname.includes('primevideo.com') || window.location.hostname.includes('amazon.com') || window.location.hostname.includes('amazon.co.uk') || window.location.hostname.includes('amazon.co.jp') || window.location.hostname.includes('amazon.de') || window.location.hostname.includes('amazon.com.au')) {
        try {
            const querySelectorShadow = (selector, root = document) => {
                const el = root.querySelector(selector);
                if (el) return el;
                try {
                    const all = root.querySelectorAll('*');
                    for (const item of all) {
                        if (item.shadowRoot) {
                            const found = querySelectorShadow(selector, item.shadowRoot);
                            if (found) return found;
                        }
                    }
                } catch (e) { }
                return null;
            };
            const titleElement = querySelectorShadow('.atvwebplayersdk-title-text');
            const subtitleElement = querySelectorShadow('.atvwebplayersdk-subtitle-text');

            if (titleElement) {
                const titleText = titleElement.textContent?.trim() || '';
                const subtitleText = subtitleElement?.textContent?.trim() || '';

                if (titleText) {
                    const episodeMatch = subtitleText.match(
                        /Season\s+(?<season>\d+),?\s*Ep\.?\s*(?<episode>\d+)\s*(?<episodeTitle>.*)/i
                    );
                    if (episodeMatch?.groups) {
                        const season = episodeMatch.groups.season;
                        const episode = episodeMatch.groups.episode;
                        const epTitle = episodeMatch.groups.episodeTitle?.trim() || '';
                        return { title: `${titleText} - Season ${season} Episode ${episode}` + (epTitle ? ` - ${epTitle}` : ''), year: year };
                    }
                    return { title: titleText, year: year };
                }
            }
        } catch (e) { /* ignore */ }
    }


    return { title: title };
}

// ── AI-Powered Title Parser (Chrome Built-in AI / Gemini Nano) ──

let aiSession = null; // Cached session for reuse

async function parseTitleWithAI(rawTitle) {
    try {
        // Feature detection: self.ai works in MV3 service workers (no window object)
        const aiRoot = (typeof self !== 'undefined' && self.ai) || (typeof globalThis !== 'undefined' && globalThis.ai);
        if (!aiRoot || !aiRoot.languageModel) {
            return null; // AI not available
        }

        // Create or reuse session
        if (!aiSession) {
            aiSession = await aiRoot.languageModel.create({
                systemPrompt: 'You are a media parser. Extract the show title, season number, episode number, and episode title from the provided string. Return strictly valid JSON with keys: title, season, episode, episodeTitle. If the season is missing, set to null. Extract the episode title from quotes if present. If it is a movie, set season/episode/episodeTitle to null.'
            });
        }

        const response = await aiSession.prompt(rawTitle);

        // Strip markdown fences if the model wraps its response
        let cleaned = response.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        }

        const result = JSON.parse(cleaned);

        // Validate required keys
        if (!result.title || typeof result.title !== 'string') {
            console.warn('[CRUNCHFLIX] AI returned invalid title:', result);
            return null;
        }

        const parsed = {
            type: (result.episode !== null) ? 'episode' : 'movie',
            title: result.title.trim(),
            season: result.season !== null ? parseInt(result.season) : null,
            episode: result.episode !== null ? parseInt(result.episode) : null
        };

        console.log(`[CRUNCHFLIX] AI parseTitle SUCCESS: "${parsed.title}" S${parsed.season} E${parsed.episode}`);
        return parsed;

    } catch (e) {
        console.warn('[CRUNCHFLIX] AI parseTitle failed, falling back to regex:', e.message);
        // Destroy broken session so it's recreated next time
        aiSession = null;
        return null;
    }
}

// ── DeepSeek API Title Parser (V3.2, Primary) ──

const deepseekParseCache = new Map(); // rawTitle -> Promise<parsed result>

async function parseTitleWithDeepSeek(rawTitle) {
    // Check cache first — stores Promises to prevent concurrent API calls
    if (deepseekParseCache.has(rawTitle)) {
        const cached = await deepseekParseCache.get(rawTitle);
        if (cached) {
            console.log(`[CRUNCHFLIX] DeepSeek cache hit for: "${rawTitle}"`);
            return cached;
        }
        // Previous attempt failed, remove and retry
        deepseekParseCache.delete(rawTitle);
    }

    const storage = await chrome.storage.local.get(['deepseek_api_key']);
    const apiKey = storage.deepseek_api_key;
    if (!apiKey) {
        console.log('[CRUNCHFLIX] DeepSeek skipped: no API key configured');
        return null;
    }

    // Store the Promise immediately to prevent concurrent calls
    const apiPromise = _callDeepSeek(rawTitle, apiKey);
    deepseekParseCache.set(rawTitle, apiPromise);
    return apiPromise;
}

async function _callDeepSeek(rawTitle, apiKey) {
    try {
        console.log(`[CRUNCHFLIX] DeepSeek V3.2 parsing: "${rawTitle}"...`);
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert media title parser with deep knowledge of TV shows and movies. Given a raw, often messy string scraped from a streaming platform, extract: the show name, season number, and episode number. Use your knowledge of real TV shows to infer the correct season when not explicitly stated (e.g. "Pilot" is almost always Season 1 Episode 1, "Three Little Birds" is S3E1 of Lost in Space). Separate mangled strings like "ShowNameE1EpTitle" into the proper show name and episode info. Return strictly valid JSON with keys: title (string, the clean official show name), season (number, infer from your knowledge if possible, default to 1 if episode exists but season is ambiguous), episode (number or null). Strip quality tags, brackets, and prefixes like "Watching:". No explanation, only JSON.'
                    },
                    {
                        role: 'user',
                        content: rawTitle
                    }
                ]
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.warn(`[CRUNCHFLIX] DeepSeek API error (${response.status}):`, errText);
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
            console.warn('[CRUNCHFLIX] DeepSeek returned empty content');
            return null;
        }

        // Strip markdown fences just in case
        let cleaned = content.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        }

        const result = JSON.parse(cleaned);

        if (!result.title || typeof result.title !== 'string') {
            console.warn('[CRUNCHFLIX] DeepSeek returned invalid title:', result);
            return null;
        }

        const parsed = {
            type: (result.episode !== null) ? 'episode' : 'movie',
            title: result.title.trim(),
            season: result.season !== null ? parseInt(result.season) : null,
            episode: result.episode !== null ? parseInt(result.episode) : null
        };

        console.log(`[CRUNCHFLIX] DeepSeek parseTitle SUCCESS: "${parsed.title}" S${parsed.season} E${parsed.episode}`);
        return parsed;

    } catch (e) {
        console.warn('[CRUNCHFLIX] DeepSeek parseTitle failed:', e.message);
        return null;
    }
}

async function parseTitle(rawTitle, platform = 'netflix') {
    if (!rawTitle) return null;

    console.log(`[CRUNCHFLIX] parseTitle called with: "${rawTitle}" (platform: ${platform})`);

    // 1. Try DeepSeek API (cloud, primary) - Netflix ONLY
    if (platform === 'netflix') {
        const deepseekResult = await parseTitleWithDeepSeek(rawTitle);
        if (deepseekResult) {
            console.log(`[CRUNCHFLIX] Using DeepSeek result: "${deepseekResult.title}"`);
            return deepseekResult;
        }
    }

    // 2. Try Chrome AI (local, on-device Gemini Nano)
    const aiResult = await parseTitleWithAI(rawTitle);
    if (aiResult) {
        console.log(`[CRUNCHFLIX] Using Chrome AI result: "${aiResult.title}"`);
        return aiResult;
    }

    // 3. Fallback to regex (deterministic, always works)
    console.log(`[CRUNCHFLIX] Using regex fallback`);
    return parseTitleRegex(rawTitle, platform);
}

function parseTitleRegex(rawTitle, platform = 'netflix') {
    if (!rawTitle) return null;

    // Crunchyroll / Hotstar handle explicit patterns from content.js or og:title metadata
    if (platform === 'crunchyroll' || platform === 'hotstar') {
        const crPatterns = [
            /^(.+?),\s+Season\s+(\d+),\s+Episode\s+(\d+)/i, // Hotstar ARIA "Show, Season 1, Episode 2"
            /^(.+?)\s+Season\s+(\d+)\s*-\s*Episode\s+(\d+)/i, // Enhanced "Show Season X - Episode Y"
            /^(.+?)\s+S(\d+)\s+Episode\s+(\d+)/i,            // "Show S1 Episode 2"
            /^(.+?)\s+S(\d+)\s+E(\d+)/i,                    // "Show S1 E2"
            /^(.+?)\s*[|\-]\s*S(\d+)\s*E(\d+)/i,             // "Show | S1 E2"
            /^(.+?)\s*-\s*Episode\s+(\d+)/i,                 // Fallback "Show - Episode X"
            /^(.+?)\s*\|\s*E(\d+)/i,                          // Native og:title "Show | EXX"
            /^(.+?)\s*\|\s*Episode\s+(\d+)/i                  // Alternative "Show | Episode X"
        ];

        for (const regex of crPatterns) {
            const crMatch = rawTitle.match(regex);
            if (crMatch) {
                if (crMatch.length === 4) {
                    return { type: 'episode', title: crMatch[1].trim(), season: parseInt(crMatch[2]), episode: parseInt(crMatch[3]) };
                }
                return { type: 'episode', title: crMatch[1].trim(), season: null, episode: parseInt(crMatch[2]) };
            }
        }
        return { type: 'movie', title: rawTitle.trim() };
    }

    // Match: "Show - Episode 8", "Show - Ep. 8", "Show - E8", "Show - S2:E8", "Show - Season 2 Episode 8"
    const patterns = [
        // PRIORITY: "Show S2:E8" or "Show S2 E8"
        /^(.+?)\s+S(\d+)\s*[: ]\s*E(\d+)/i,
        // "Show - Episode 8" or "Show: Episode 8"
        /^(.+?)\s*[-:]\s*(?:Season\s*(\d+)\s+)?Episode\s+(\d+)/i,
        // "Show - Ep. 8" or "Show - Ep 8"
        /^(.+?)\s*[-:]\s*(?:Season\s*(\d+)\s+)?Ep\.?\s*(\d+)/i,
        // "Show - E8" or "Show - S2:E8"
        /^(.+?)\s*[-:]\s*(?:S(\d+):)?E(\d+)/i,
        // CATCH MANGLED: "ShowS2E5", "Show E5", "ShowS2:E5"
        /^(.+?)(?:\s*[S\-:]{1,2}(\d+))?[\s\-:]*E(\d+)/i,
    ];

    for (const regex of patterns) {
        const match = rawTitle.match(regex);
        if (match) {
            const title = match[1].trim();
            let season = null;
            let episode;
            if (match.length === 4) {
                season = match[2] ? parseInt(match[2]) : null;
                episode = parseInt(match[3]);
            } else {
                episode = parseInt(match[match.length - 1]);
            }
            console.log(`[CRUNCHFLIX] parseTitleRegex SUCCESS: "${title}" S${season} E${episode} (Matched: ${regex.toString()})`);
            return { type: 'episode', title, season: season, episode };
        }
    }

    console.log(`[CRUNCHFLIX] parseTitleRegex FAILED to find S/E pattern. Defaulting to movie: "${rawTitle.trim()}"`);
    return {
        type: 'movie',
        title: rawTitle.trim()
    };
}

function sanitizeShowTitle(rawTitle) {
    if (!rawTitle) return rawTitle;

    // Strip accidentally captured season markers (e.g. "The Night Agent S3")
    let cleanTitle = rawTitle.replace(/\s+S\d+.*$/i, '').trim();

    // Strip trailing episode markers preceded by space or dash
    cleanTitle = cleanTitle.replace(/[\s-]{1,2}E\d+.*$/i, '').trim();

    // Also strip out any trailing " - Episode X" just in case
    cleanTitle = cleanTitle.replace(/\s*-\s*Episode\s*\d+/i, '').trim();

    return cleanTitle;
}

function validateMatch(query, result, expectedYear) {
    const entity = result?.show || result?.movie;
    if (!entity) return false;

    const normalize = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const q = normalize(query);
    const r = normalize(entity.title);

    // 1. Year Check (High Confidence)
    if (expectedYear) {
        const resultYear = parseInt(entity.year);
        if (Math.abs(resultYear - parseInt(expectedYear)) > 1) {
            console.log(`[CRUNCHFLIX] Rejected match: "${entity.title}" (Year mismatch: ${resultYear} vs ${expectedYear})`);
            return false;
        }
    }

    // 2. Exact Match (Highest Confidence)
    if (q === r) return true;

    // 3. Substring Logic (Handling suffixes/prefixes)
    if (r.includes(q)) {
        const diff = r.length - q.length;
        // If it's a small difference (like a year suffix "(1999)" or "UK"), allow it
        if (diff <= 6) return true; 

        // If it's a large difference (like "Wise Guy: David Chase and The Sopranos"), reject
        console.log(`[CRUNCHFLIX] Rejected fuzzy match: "${entity.title}" (Title baggage/documentary detected for "${query}")`);
        return false;
    }

    // 4. Prefix match (query: "The Sopranos Season 1", result: "The Sopranos")
    if (q.startsWith(r)) {
        const diff = q.length - r.length;
        // Allow common suffixes in the query like "Season 1", "Episode 1"
        if (diff < 15) return true; 
    }

    return false;
}

async function searchTmdbAndResolve(query, type, token) {
    try {
        const storage = await chrome.storage.local.get(['tmdb_api_key', 'client_id']);
        const tmdbKey = storage.tmdb_api_key;
        const clientId = storage.client_id;

        if (!tmdbKey) {
            console.log("[CRUNCHFLIX] TMDB API Key not configured, skipping fallback.");
            return null;
        }

        const searchType = type === 'episode' ? 'tv' : 'movie';
        console.log(`[CRUNCHFLIX] Fallback: Searching TMDB (${searchType}) for "${query}"...`);
        const tmdbUrl = `https://api.themoviedb.org/3/search/${searchType}?api_key=${tmdbKey}&query=${encodeURIComponent(query)}`;
        const tmdbRes = await fetch(tmdbUrl);
        const tmdbData = await tmdbRes.json();

        const bestTmdb = tmdbData.results?.[0];
        if (!bestTmdb) return null;

        const bestTitle = bestTmdb.name || bestTmdb.title;
        console.log(`[CRUNCHFLIX] Found on TMDB: "${bestTitle}" (ID: ${bestTmdb.id}). Resolving to Trakt...`);

        if (!clientId) return null;

        const traktType = type === 'episode' ? 'show' : 'movie';
        const traktUrl = `${API_URL}/search/tmdb/${bestTmdb.id}?type=${traktType}`;
        const traktRes = await fetch(traktUrl, {
            headers: {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': clientId,
                'Authorization': `Bearer ${token}`
            }
        });
        const traktResults = await traktRes.json();
        if (traktResults && traktResults.length > 0) {
            const resolved = traktResults[0];
            const resolvedEntity = resolved.show || resolved.movie;
            console.log(`[CRUNCHFLIX] Resolved TMDB ID to Trakt: "${resolvedEntity?.title}"`);
            return resolved;
        }
    } catch (e) {
        console.error("TMDB Fallback failed:", e);
    }
    return null;
}

async function doSearchRaw(q, token, type = 'show', year = null) {
    const url = `${API_URL}/search/${type}?query=${encodeURIComponent(q)}&extended=full${year ? `&years=${year}` : ''}`;

    try {
        const storage = await chrome.storage.local.get(['client_id']);
        if (!storage.client_id) throw new Error("Client ID missing");

        const res = await fetch(url, {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': storage.client_id,
                'Authorization': `Bearer ${token}`
            }
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (e) {
        console.error("[CRUNCHFLIX] Trakt Search failed:", e);
        return [];
    }
}

async function searchTrakt(query, type, token, year = null) {
    const searchType = type === 'episode' ? 'show' : 'movie';
    let bestResult = null;

    // 1. Try metadata-based clean title
async function sendScrobble(action, payload, token) {
    const url = getSimklUrl(`/scrobble/${action}`);
    try {
        console.log(`[CRUNCHFLIX] Sending ${action.toUpperCase()} to Simkl...`, payload);
        const res = await fetch(url, {
            method: 'POST',
            headers: getSimklHeaders(token),
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[CRUNCHFLIX] Simkl ${action} failed (${res.status}):`, errText);
        } else {
            const json = await res.json();
            console.log(`[CRUNCHFLIX] Simkl ${action} success:`, json);
        }
    } catch (e) {
        console.error(`[CRUNCHFLIX] Scrobble ${action} exception:`, e);
    }
}

async function doSearchRaw(q, token, type = 'tv', year = null) {
    const simklType = type === 'show' || type === 'episode' ? 'tv' : type;
    let url = getSimklUrl(`/search/text?q=${encodeURIComponent(q)}&type=${simklType}`);
    if (year) url += `&year=${year}`;

    try {
        const res = await fetch(url, {
            headers: getSimklHeaders(token)
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (e) {
        console.error("[CRUNCHFLIX] Simkl Search failed:", e);
        return [];
    }
}

async function searchSimkl(query, type, token, year = null) {
    const searchType = type === 'episode' ? 'tv' : 'movie';
    let bestResult = null;

    const searchPart = sanitizeShowTitle(query);
    console.log(`[CRUNCHFLIX] Searching Simkl: "${searchPart}" (${searchType})`);
    let results = await doSearchRaw(searchPart, token, searchType, year);

    if (results && results.length > 0) {
        for (const result of results) {
            const isValid = validateMatch(searchPart, { show: result, movie: result }, year);
            if (isValid) return { show: result, movie: result, ...result };
        }
        bestResult = { show: results[0], movie: results[0], ...results[0] };
    }

    const cleaned = searchPart.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned !== searchPart) {
        results = await doSearchRaw(cleaned, token, searchType, year);
        if (results && results.length > 0) {
            for (const result of results) {
                if (validateMatch(cleaned, { show: result, movie: result }, year)) {
                    return { show: result, movie: result, ...result };
                }
            }
            if (!bestResult) bestResult = { show: results[0], movie: results[0], ...results[0] };
        }
    }

    return bestResult;
}
/**
 * Proactive Recovery: Fetches/Scrapes Netflix auth tokens using UTS methodology.
 * Prioritizes MAIN world injection to reach window.netflix directly.
 */
async function fetchAndScrapeNetflixAuth() {
    try {
        console.log("[CRUNCHFLIX] [UTS RECOVERY] Initiating session extraction...");

        // 1. Primary Method: Injection into MAIN world of an existing Netflix tab
        const netflixTabs = await chrome.tabs.query({ url: "*://*.netflix.com/*" });
        if (netflixTabs.length > 0) {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: netflixTabs[0].id },
                    world: 'MAIN',
                    func: () => {
                        const netflix = window.netflix;
                        if (netflix && netflix.reactContext && netflix.reactContext.models) {
                            const userInfo = netflix.reactContext.models.userInfo;
                            const serverDefs = netflix.reactContext.models.serverDefs;
                            return {
                                authUrl: userInfo?.data?.authURL || null,
                                guid: userInfo?.data?.userGuid || userInfo?.data?.guid || null,
                                buildId: serverDefs?.data?.BUILD_IDENTIFIER || null
                            };
                        }
                        return null;
                    }
                });

                const session = results[0]?.result;
                if (session && session.authUrl) {
                    console.log("[CRUNCHFLIX] [UTS RECOVERY] Successfully extracted session via MAIN world injection.");
                    return await updateSessionCache(session.authUrl, session.guid, session.buildId);
                }
            } catch (injectionError) {
                console.warn("[CRUNCHFLIX] Injection attempt failed:", injectionError);
            }
        }

        // 2. Fallback Method: Regex Scraping from /settings/viewed/ (UTS Style)
        console.log("[CRUNCHFLIX] [UTS RECOVERY] Falling back to regex scraping...");
        const response = await fetch("https://www.netflix.com/settings/viewed/", { credentials: 'include' });
        const html = await response.text();

        // UTS Regex Patterns
        const authUrlMatch = html.match(/"authURL":"(?<authUrl>.*?)"/) || html.match(/"authUrl":"(?<authUrl>.*?)"/);
        const guidMatch = html.match(/"userGuid":"(?<guid>.*?)"/) || html.match(/"guid":"(?<guid>.*?)"/);
        const buildIdMatch = html.match(/"BUILD_IDENTIFIER":"(?<buildId>.*?)"/);

        if (authUrlMatch) {
            const rawAuthUrl = authUrlMatch[1];

            // UTS Robust Unescaping
            const unescape = (str) => {
                try {
                    return JSON.parse(`"${str}"`);
                } catch (e) {
                    return str
                        .replace(/\\u([0-9a-fA-F]{4})/g, (m, g) => String.fromCharCode(parseInt(g, 16)))
                        .replace(/\\x([0-9a-fA-F]{2})/g, (m, g) => String.fromCharCode(parseInt(g, 16)))
                        .replace(/\\(.)/g, '$1');
                }
            };

            const authUrl = unescape(rawAuthUrl);
            const guid = guidMatch ? unescape(guidMatch[1]) : null;
            const buildId = buildIdMatch ? unescape(buildIdMatch[1]) : null;

            console.log("[CRUNCHFLIX] [UTS RECOVERY] Successfully extracted session via regex scraping.");
            return await updateSessionCache(authUrl, guid, buildId);
        }

        throw new Error("UTS extraction failed. Bootstrap context not found.");
    } catch (e) {
        console.error("[CRUNCHFLIX] UTS Recovery Layer Failed:", e);
        return null;
    }
}

/**
 * Updates memory and disk cache with fresh Netflix tokens.
 */
async function updateSessionCache(authUrl, guid, buildId) {
    const tokens = { authUrl, guid, buildId, timestamp: Date.now() };

    // Clear stale memory to prevent 403 loops
    shaktiKeys.clear();
    console.log("[CRUNCHFLIX] Memory cache cleared.");

    // Update memory for all active netflix tabs
    const tabs = await chrome.tabs.query({ url: "*://*.netflix.com/*" });
    tabs.forEach(tab => shaktiKeys.set(tab.id, { buildId: buildId || 'shakti', authUrl }));

    // Update disk
    await chrome.storage.local.set({ shakti: tokens });

    const display = authUrl.length > 10 ? `${authUrl.substring(0, 5)}...${authUrl.substring(authUrl.length - 5)}` : authUrl;
    console.log(`[CRUNCHFLIX] Handshake restored. Token: ${display}`);
    return tokens;
}

// --- History Sync Logic ---

async function fetchNetflixHistory(sendResponse, retries = 0) {
    if (isSyncing && retries === 0) {
        console.warn("[CRUNCHFLIX] Sync already in progress. Ignoring request.");
        return;
    }

    if (retries === 0) isSyncing = true;

    // 1. Unified Key Retrieval
    const storage = await chrome.storage.local.get(['shakti']);
    let shakti = (retries > 0) ? storage.shakti : (Array.from(shaktiKeys.values())[0] || storage.shakti);

    const activeToken = shakti?.authUrl;
    const userGuid = shakti?.guid;

    try {
        if (!activeToken && retries < 2) {
            console.log("[CRUNCHFLIX] Token missing. Initiating retry/recovery...");
            const recovered = await fetchAndScrapeNetflixAuth();
            if (recovered) return fetchNetflixHistory(sendResponse, retries + 1);
        }

        if (!activeToken) throw new Error("Netflix session not active. Please open a Netflix tab.");

        // 2. UTS AUI Endpoint Fetch
        // UTS uses aui pathEvaluator for more robust history retrieval
        const callPath = `["aui","viewingActivity",0,50]`;
        const url = `https://www.netflix.com/api/aui/pathEvaluator/web/%5E2.0.0?method=call&callPath=${encodeURIComponent(callPath)}&falcor_server=0.1.0`;

        const body = `param=${encodeURIComponent(JSON.stringify({ guid: userGuid }))}&authURL=${encodeURIComponent(activeToken)}`;
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-netflix.request.routing': '{"path":"/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator","control_tag":"auinqweb"}'
        };

        console.log(`[CRUNCHFLIX] Fetching History via AUI (Retry: ${retries})`);
        const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers,
            body
        });

        if (!res.ok) {
            if (retries < 2 && (res.status === 403 || res.status === 401)) {
                console.warn(`[CRUNCHFLIX] AUI Auth Fail (${res.status}). Purging and recovering...`);
                shaktiKeys.clear();
                await chrome.storage.local.remove('shakti');
                const recovered = await fetchAndScrapeNetflixAuth();
                if (recovered) return fetchNetflixHistory(sendResponse, retries + 1);
            }
            throw new Error(`AUI Fetch Failed (${res.status})`);
        }

        const data = await res.json();
        const rawItems = data?.jsonGraph?.aui?.viewingActivity?.value?.viewedItems || [];

        if (rawItems.length > 0) {
            console.log("[CRUNCHFLIX] Raw AUI Item Sample:", JSON.stringify(rawItems[0], null, 2));
        }

        // Normalize AUI items to extension's standard format
        const items = rawItems.map(item => {
            // DATE FIX: Handle both seconds and milliseconds to prevent "Year 58113"
            let ts = parseInt(item.date, 10) || Date.now();
            if (ts < 10000000000) ts *= 1000; // Convert seconds to ms
            const watchedDate = ts;

            const videoTitle = item.episodeTitle || item.title || "Unknown Title";
            const seriesTitle = item.seriesTitle || null;

            // THUMBNAIL FIX: Deeper check for thumbnails
            const thumbUrl = (item.thumbs && item.thumbs[0]?.url) ||
                (item.stills && item.stills[0]?.url) ||
                item.image ||
                (item.summary?.thumbUrl) ||
                "https://via.placeholder.com/140x79?text=No+Preview";

            // METADATA FIX: Comprehensive search for SxxExx
            // Netflix AUI often buries these in different fields depending on the show type
            const seasonNumber = item.summary?.season || item.seasonSeq || item.seasonNumber || 0;
            const episodeNumber = item.summary?.episode || item.episodeSeq || item.episodeNumber || item.seq || 0;

            return {
                ...item,
                videoTitle,
                seriesTitle,
                watchedDate,
                thumbUrl,
                seasonNumber,
                episodeNumber,
                watchedAt: Math.floor(watchedDate / 1000) // Trakt uses seconds
            };
        });

        // 3. High-Fidelity Filtering & Metadata Enrichment: Check progress via NQ API
        const ids = items.map(i => String(i.movieID));
        const enrichmentMap = await fetchNetflixProgress(ids);

        const highFidelityItems = items.filter(item => {
            const enrich = enrichmentMap[String(item.movieID)];
            if (!enrich) return true; // Fallback to including if progress missing

            const dur = parseInt(enrich.runtime) || 0;
            const book = parseInt(enrich.bookmark) || 0;

            // Update item metadata from NQ API (more reliable than AUI)
            if (enrich.seasonSeq != null) item.seasonNumber = parseInt(enrich.seasonSeq);
            if (enrich.episodeSeq != null) item.episodeNumber = parseInt(enrich.episodeSeq);

            // Simkl Standard: 70% threshold
            const progressPercent = dur > 0 ? (book / dur) : 1;
            return progressPercent >= 0.70;
        });

        console.log(`[CRUNCHFLIX] AUI Sync Success! Found ${items.length} items. Filtered to ${highFidelityItems.length} (70% watch threshold).`);
        isSyncing = false;
        sendResponse({ success: true, items: highFidelityItems });

    } catch (e) {
        isSyncing = false;
        console.error("[CRUNCHFLIX] UTS History fetch failed:", e);
        sendResponse({ success: false, error: e.message });
    }
}

/**
 * Fetches watch progress (bookmark/runtime) for a list of Netflix IDs.
 */
async function fetchNetflixProgress(ids) {
    if (!ids || !ids.length) return {};

    try {
        const url = 'https://www.netflix.com/nq/website/memberapi/release/pathEvaluator?original_path=%2Fshakti%2Fmre%2FpathEvaluator';
        const body = new URLSearchParams({
            path: JSON.stringify(['videos', ids, ['summary', 'runtime', 'bookmarkPosition', 'seasonSeq', 'episodeSeq']])
        });

        const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        if (!res.ok) return {};
        const data = await res.json();

        const progress = {};
        const videos = data?.jsonGraph?.videos;
        if (videos) {
            ids.forEach(id => {
                const v = videos[id];
                if (v) {
                    progress[id] = {
                        runtime: v.runtime?.value ?? 0,
                        bookmark: v.bookmarkPosition?.value ?? -1,
                        // Enrichment: Grab sequences directly from NQ metadata
                        seasonSeq: v.summary?.season || v.seasonSeq || null,
                        episodeSeq: v.summary?.episode || v.episodeSeq || null
                    };
                }
            });
        }
        return progress;
    } catch (e) {
        console.warn("[CRUNCHFLIX] Progress fetch failed:", e);
        return {};
    }
}


async function bulkCheckTrakt(items, sendResponse) {
    try {
        const storage = await chrome.storage.local.get(['trakt_token', 'client_id']);
        const token = storage.trakt_token?.access_token;
async function bulkCheckSimkl(items, sendResponse) {
    try {
        const storage = await chrome.storage.local.get(['simkl_token', 'trakt_token']);
        const token = storage.simkl_token?.access_token || storage.trakt_token?.access_token;
        if (!token) throw new Error("Simkl not connected.");

        const url = getSimklUrl('/sync/activities');
        const res = await fetch(url, {
            headers: getSimklHeaders(token)
        });

        if (!res.ok) throw new Error("Could not fetch Simkl activities.");
        const activities = await res.json();

        const syncedItems = (items || []).map(item => ({ ...item, isSynced: false }));
        sendResponse({ success: true, items: syncedItems, activities });
    } catch (e) {
        console.error("[CRUNCHFLIX] Bulk check error:", e);
        sendResponse({ success: false, error: e.message });
    }
}

async function bulkSyncToSimkl(items, sendResponse) {
    try {
        const storage = await chrome.storage.local.get(['simkl_token', 'trakt_token']);
        const token = storage.simkl_token?.access_token || storage.trakt_token?.access_token;
        if (!token) throw new Error("Simkl not connected.");

        const showsToSync = [];
        const moviesToSync = [];
        let completed = 0;
        const total = (items || []).length;

        for (const item of items) {
            const isEpisode = !!item.seriesTitle;
            const watchedAt = new Date(item.watchedDate).toISOString();

            if (isEpisode) {
                showsToSync.push({
                    title: item.seriesTitle,
                    ids: { netflix: item.movieID },
                    episodes: [
                        {
                            season: item.seasonNumber || 1,
                            number: item.episodeNumber || 1,
                            watched_at: watchedAt
                        }
                    ]
                });
            } else {
                moviesToSync.push({
                    title: item.videoTitle,
                    ids: { netflix: item.movieID },
                    watched_at: watchedAt
                });
            }

            completed++;
            const progress = Math.round((completed / total) * 100);
            chrome.runtime.sendMessage({ action: "syncProgress", progress }).catch(() => { });
            await new Promise(r => setTimeout(r, 20));
        }

        const syncPayload = {};
        if (showsToSync.length > 0) syncPayload.shows = showsToSync;
        if (moviesToSync.length > 0) syncPayload.movies = moviesToSync;

        const res = await fetch(getSimklUrl('/sync/history'), {
            method: 'POST',
            headers: getSimklHeaders(token),
            body: JSON.stringify(syncPayload)
        });

        if (!res.ok) throw new Error(`Simkl Sync failed: ${await res.text()}`);

        const result = await res.json();
        sendResponse({ success: true, added: result.added || result });
    } catch (e) {
        console.error("[CRUNCHFLIX] Bulk sync error:", e);
        sendResponse({ success: false, error: e.message });
    }
}

async function resolveSimklUrl(url, sendResponse) {
    try {
        const storage = await chrome.storage.local.get(['simkl_token', 'trakt_token']);
        const token = storage.simkl_token?.access_token || storage.trakt_token?.access_token;
        if (!token) throw new Error("Simkl not connected.");

        const showMatch = url.match(/shows\/([^/]+)/) || url.match(/tv\/([^/]+)/);
        const movieMatch = url.match(/movies\/([^/]+)/);
        const slug = (showMatch || movieMatch)?.[1];
        if (!slug) throw new Error("Invalid URL.");

        const type = showMatch ? 'tv' : 'movie';
        const results = await doSearchRaw(slug, token, type);
        sendResponse({ success: true, results });
    } catch (e) {
        console.error("[CRUNCHFLIX] URL Resolution error:", e);
        sendResponse({ success: false, error: e.message });
    }
}

async function handleSimklSearch(query, type, sendResponse) {
    try {
        const storage = await chrome.storage.local.get(['simkl_token', 'trakt_token']);
        const token = storage.simkl_token?.access_token || storage.trakt_token?.access_token;
        if (!token) throw new Error("Simkl not connected.");

        const results = await doSearchRaw(query, token, type);
        sendResponse({ success: true, results });
    } catch (e) {
        sendResponse({ success: false, error: e.message });
    }
}
