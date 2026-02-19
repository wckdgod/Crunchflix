const API_URL = "https://api.trakt.tv";
// CLIENT_ID and TMDB_API_KEY are now fetched from storage


// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "scrobble") {
        handleScrobble(request.data, sender);
    }
    else if (request.action === "getMetadata") {
        // Can be used by popup if needed
    }
    else if (request.action === "setCorrection") {
        (async () => {
            try {
                const { originalTitle, correctionInput } = request.data;
                console.log(`[Ghost Scrobbler] Setting correction for "${originalTitle}" -> "${correctionInput}"`);

                let idOrSlug = correctionInput;
                const urlMatch = correctionInput.match(/shows\/([^\/\?]+)/);
                if (urlMatch) idOrSlug = urlMatch[1];

                const show = await getShowDetails(idOrSlug);
                if (show) {
                    const storage = await chrome.storage.local.get(['corrections']);
                    const corrections = storage.corrections || {};
                    const correctionObj = { type: 'show', show: show };
                    corrections[originalTitle] = correctionObj;
                    await chrome.storage.local.set({ corrections });
                    console.log("[Ghost Scrobbler] Correction saved.");
                    sendResponse({ success: true, show: show });
                } else {
                    sendResponse({ success: false, error: "Show not found on Trakt" });
                }
            } catch (e) {
                console.error(e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }
});

async function getShowDetails(idOrSlug) {
    const storage = await chrome.storage.local.get(['trakt_token', 'client_id']);
    const token = storage.trakt_token?.access_token;
    const clientId = storage.client_id;

    if (!token) throw new Error("Not authenticated");
    if (!clientId) throw new Error("Client ID not configured");

    const url = `${API_URL}/shows/${idOrSlug}?extended=full`;
    const res = await fetch(url, {
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

// Global throttling state
let lastScrobble = {
    title: null,
    status: null,
    timestamp: 0
};

// Per-tab resolved title cache — keyed by "tabId:epId"
// Populated once we successfully resolve via shakti API; reused for heartbeats
const resolvedTitleCache = new Map();

// Clear cache when tab navigates away or closes
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) {
        // New URL means new episode — purge all entries for this tab
        for (const key of resolvedTitleCache.keys()) {
            if (key.startsWith(`${tabId}:`)) resolvedTitleCache.delete(key);
        }
    }
});
chrome.tabs.onRemoved.addListener((tabId) => {
    for (const key of resolvedTitleCache.keys()) {
        if (key.startsWith(`${tabId}:`)) resolvedTitleCache.delete(key);
    }
});

async function handleScrobble(data, sender) {
    console.log("Processing scrobble:", data);

    // ALLOW messages from iframes (e.g. Crunchyroll).
    // The background script will still fetch the real metadata from the top frame (frameIds: [0]).

    // ALWAYS get fresh metadata from the tab's main frame
    if (sender?.tab?.id) {
        // Strategy 1: Ask the top-frame content script (cleaner, uses existing context)
        try {
            const response = await chrome.tabs.sendMessage(sender.tab.id, { action: "getMetadata" }, { frameId: 0 });
            if (response && response.title) {
                data.title = response.title;
                console.log("[Ghost Scrobbler] Got title via sendMessage:", data.title);
            }
        } catch (e) {
            console.log("[Ghost Scrobbler] sendMessage failed (content script might not be ready), falling back to executeScript.", e);
        }

        // Strategy 2: Inject script (Fallback)
        if (!data.title) {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id, frameIds: [0] },
                    func: extractMetadataFromPage
                });
                if (results?.[0]?.result) {
                    if (typeof results[0].result === 'object') {
                        data.title = results[0].result.title;
                        data.year = results[0].result.year;
                    } else {
                        data.title = results[0].result;
                    }
                    console.log("[Ghost Scrobbler] Got title via executeScript:", data.title);
                }
            } catch (e) {
                console.warn("[Ghost Scrobbler] executeScript failed:", e);
            }
        }
    }

    // Fallback to tab title (but reject useless generic site names)
    const GENERIC_TITLES = ["Vilos", "Netflix", "Crunchyroll", "Watch", ""];
    if (!data.title || GENERIC_TITLES.some(t => data.title.trim() === t)) {
        const tabTitle = sender?.tab?.title || "";
        // Only use tab title if it's not also a generic name
        data.title = GENERIC_TITLES.some(t => tabTitle.trim() === t) ? null : tabTitle;
    }

    // If title is still generic, try the Netflix shakti metadata API directly.
    // The background script has host_permissions for netflix.com, so cookies are included.
    // API discovered from universal-trakt-scrobbler source: /api/shakti/mre/metadata?movieid=episodeId
    if ((!data.title || GENERIC_TITLES.some(t => (data.title || '').trim() === t)) && sender?.tab?.id) {
        try {
            const tab = await chrome.tabs.get(sender.tab.id);
            const tabUrl = tab?.url || '';
            // Primary: episode ID comes from /watch/{id} in the URL
            let epId = tabUrl.match(/\/watch\/(\d+)/)?.[1];

            // Fallback: extract videoId from window.netflix via MAIN world if URL doesn't have it
            if (!epId) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: sender.tab.id, frameIds: [0] },
                        world: 'MAIN',
                        func: () => {
                            try {
                                const state = window.netflix?.appContext?.state?.playerApp?.getState?.();
                                const sessions = state?.videoPlayer?.playbackStateBySessionId ?? {};
                                const active = Object.values(sessions).find(s => s?.playing || s?.paused);
                                return active?.videoId?.toString() ?? null;
                            } catch (e) { return null; }
                        }
                    });
                    epId = results?.[0]?.result;
                } catch (e) { /* ignore */ }
            }

            if (epId) {
                const cacheKey = `${sender.tab.id}:${epId}`;

                // Cache hit: reuse the title we already resolved for this episode
                if (resolvedTitleCache.has(cacheKey)) {
                    data.title = resolvedTitleCache.get(cacheKey);
                    console.log("[Ghost Scrobbler] Netflix title from cache:", data.title);
                } else {
                    // Cache miss: hit the shakti API
                    const metaUrl = `https://www.netflix.com/api/shakti/mre/metadata?languages=en-US&movieid=${epId}`;
                    const res = await fetch(metaUrl, { credentials: 'include' });
                    if (res.ok) {
                        const json = await res.json();
                        const video = json?.video;
                        if (video) {
                            let netflixTitle = null;
                            if (video.type === 'movie') {
                                netflixTitle = video.title;
                            } else {
                                // type === 'show': walk seasons → episodes to find current episode
                                const currentEp = parseInt(epId);
                                for (const season of (video.seasons ?? [])) {
                                    for (const ep of (season.episodes ?? [])) {
                                        if (ep.id === currentEp || ep.episodeId === currentEp) {
                                            // Respect hiddenEpisodeNumbers (collections)
                                            if (!video.hiddenEpisodeNumbers) {
                                                netflixTitle = `${video.title} - Season ${season.seq} Episode ${ep.seq}`;
                                            } else {
                                                netflixTitle = `${video.title} - ${ep.title}`;
                                            }
                                            break;
                                        }
                                    }
                                    if (netflixTitle) break;
                                }
                            }
                            if (netflixTitle) {
                                console.log("[Ghost Scrobbler] Netflix title from shakti API:", netflixTitle);
                                resolvedTitleCache.set(cacheKey, netflixTitle);
                                data.title = netflixTitle;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("[Ghost Scrobbler] Netflix shakti API fetch failed:", e);
        }
    }

    // If STILL generic, schedule a retry in 3s (player may not be ready yet)
    if (!data.title || GENERIC_TITLES.some(t => (data.title || '').trim() === t)) {
        if (sender?.tab?.id) {
            console.log("[Ghost Scrobbler] Title still generic, scheduling 3s retry...");
            setTimeout(() => handleScrobble({ ...data, title: null }, sender), 3000);
        }
        return;
    }


    // 1. Get Token and Client ID
    const storage = await chrome.storage.local.get(['trakt_token', 'corrections', 'client_id']);
    const token = storage.trakt_token?.access_token;

    if (!token) {
        console.log("No Trakt token found, ignoring.");
        return;
    }

    if (!storage.client_id) {
        console.log("No Client ID configured, ignoring.");
        return;
    }

    // 2. Parse Title
    const parsed = parseTitle(data.title);
    if (!parsed) {
        console.log("Could not parse title:", data.title);
        chrome.storage.local.set({
            'nowPlaying': { status: 'parse_error', title: data.title }
        });
        return;
    }

    // 3. Search Trakt (with Override check)
    let searchResult = null;
    const corrections = storage.corrections || {};

    if (corrections[parsed.title]) {
        console.log(`[Ghost Scrobbler] Using manual override for "${parsed.title}":`, corrections[parsed.title].show.title);
        searchResult = corrections[parsed.title];
    } else {
        searchResult = await searchTrakt(parsed.title, parsed.type, token, data.year);
    }

    if (!searchResult) {
        console.log("Show not found on Trakt:", parsed.title);
        chrome.storage.local.set({
            'nowPlaying': { status: 'not_found', title: parsed.title }
        });
        return;
    }

    const show = searchResult.show || searchResult.movie;
    console.log("Found Item:", show.title, "ID:", show.ids.trakt);

    // Aesthetic Upgrade: Prefer TMDB Image, show Trakt title
    let finalImage = null;
    const tmdbId = show.ids.tmdb;

    if (tmdbId) {
        finalImage = await getTmdbImageById(tmdbId, parsed.type);
    }
    if (!finalImage) {
        finalImage = show?.images?.poster?.medium || show?.images?.poster?.thumb;
    }
    if (!finalImage) {
        const tmdbImage = await getTmdbImage(parsed.title, parsed.type);
        if (tmdbImage) finalImage = tmdbImage;
    }

    // Fetch episode synopsis from Trakt (non-blocking, best-effort)
    let synopsis = null;
    if (parsed.type === 'episode' && searchResult.show?.ids?.trakt) {
        synopsis = await getTraktEpisodeOverview(
            searchResult.show.ids.trakt,
            parsed.season || 1,
            parsed.episode,
            token
        );
    }

    // Prepare Payload
    let actionType = 'stop';
    if (data.status === 'playing') actionType = 'start';
    else if (data.status === 'paused') actionType = 'pause';

    // Update Now Playing Status (ALWAYS update UI immediately)
    chrome.storage.local.set({
        'nowPlaying': {
            title: parsed.title,
            type: parsed.type,
            season: parsed.season,
            episode: parsed.episode,
            status: data.status,
            image: finalImage,
            traktTitle: show.title,
            traktYear: show.year,
            synopsis: synopsis,
            timestamp: Date.now()
        }
    });

    // THROTTLING LOGIC
    const now = Date.now();
    const isSameShow = parsed.title === lastScrobble.title;
    const isSameStatus = actionType === lastScrobble.status;
    const timeDiff = now - lastScrobble.timestamp;
    const THROTTLE_LIMIT = 10000; // 10 seconds

    if (isSameShow && isSameStatus && timeDiff < THROTTLE_LIMIT) {
        console.log(`[Ghost Scrobbler] Throttling API call (${actionType}). Last sent ${timeDiff / 1000}s ago.`);
        return;
    }

    // 4. Send Scrobble
    const payload = {};
    if (parsed.type === 'episode') {
        payload.episode = {
            season: parsed.season || 1,
            number: parsed.episode
        };
        payload.show = {
            ids: { trakt: searchResult.show.ids.trakt }
        };
    } else {
        payload.movie = {
            ids: { trakt: searchResult.movie.ids.trakt }
        };
    }

    payload.progress = data.progress > 0 ? data.progress : 0.1;
    if (payload.progress >= 99) actionType = 'stop';

    console.log(`[Ghost Scrobbler] MATCHED SHOW: ${parsed.title} (Trakt ID: ${searchResult.show?.ids?.trakt})`);

    // NEW: Send Toast Notification to Content Script
    if (sender?.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
            action: "showToast",
            message: `Identified: ${searchResult.show?.title || searchResult.movie?.title}`
        }).catch(() => { }); // Ignore errors if tab closed/navigated
    }

    console.log(`[Ghost Scrobbler] Sending ${actionType} to Trakt...`, payload);
    await sendScrobble(actionType, payload, token, storage.client_id);

    // Update throttle tracking
    lastScrobble.title = parsed.title;
    lastScrobble.status = actionType;
    lastScrobble.timestamp = Date.now();

    // Update Storage for Popup UI
    chrome.storage.local.set({
        'nowPlaying': {
            title: parsed.title,
            type: parsed.type,
            season: parsed.season,
            episode: parsed.episode,
            image: finalImage,
            status: actionType === 'start' ? 'scrobbling' : (actionType === 'pause' ? 'paused' : 'stopped'),
            timestamp: Date.now(),
            traktTitle: show.title,
            traktYear: show.year,
            synopsis: synopsis,
            // New Metadata Fields
            rating: show.rating ? show.rating.toFixed(1) : null,
            genres: show.genres ? show.genres.slice(0, 3) : [], // Limit to 3
            runtime: show.runtime || null,
            certification: show.certification || null,
            network: show.network || null
        }
    });
}

async function getTraktEpisodeOverview(showId, season, episode, token) {
    try {
        const storage = await chrome.storage.local.get(['client_id']);
        if (!storage.client_id) return null;

        const url = `${API_URL}/shows/${showId}/seasons/${season}/episodes/${episode}?extended=full`;
        const res = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': storage.client_id,
                'Authorization': `Bearer ${token}`
            }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.overview || null;
    } catch (e) {
        console.warn('[Ghost Scrobbler] Could not fetch episode overview:', e);
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
                const textLines = (titleEvEl.innerText || titleEvEl.textContent).trim().split('\n').map(l => l.trim()).filter(Boolean);
                const showName = textLines[0] || document.querySelector('h2')?.textContent.trim();
                if (seMatch && showName) {
                    return { title: `${showName} - Season ${seMatch[1]} Episode ${seMatch[2]}` };
                }
            }

            // FALLBACK: hover overlay (only visible when paused / hovering)
            const showEl = document.querySelector('h2');
            const seasonEl = Array.from(document.querySelectorAll('h4')).find(el => /season/i.test(el.textContent));
            const epEl = document.querySelector('[data-uia="evidence-overlay-episode-title"]');
            if (showEl && epEl) {
                const showName = showEl.textContent.trim();
                const epText = epEl.textContent.trim();
                let seasonNum = 1;
                if (seasonEl) {
                    const sMatch = seasonEl.textContent.match(/(\d+)/);
                    if (sMatch) seasonNum = parseInt(sMatch[1]);
                }
                const epNum = epText.match(/(?:Ep\.?\s*|E)(\d+)/i);
                if (epNum) {
                    return { title: `${showName} - Season ${seasonNum} Episode ${epNum[1]}` };
                }
                return { title: `${showName} - ${epText}` };
            }
        } catch (e) { /* ignore */ }
    }


    return { title: title };
}

function parseTitle(rawTitle) {
    if (!rawTitle) return null;

    // Match: "Show - Episode 8", "Show - Ep. 8", "Show - E8", "Show - S2:E8", "Show - Season 2 Episode 8"
    const patterns = [
        // "Show - Episode 8" or "Show: Episode 8"
        /^(.+?)\s*[-:]\s*(?:Season\s*(\d+)\s+)?Episode\s+(\d+)/i,
        // "Show - Ep. 8" or "Show - Ep 8"
        /^(.+?)\s*[-:]\s*(?:Season\s*(\d+)\s+)?Ep\.?\s*(\d+)/i,
        // "Show - E8" or "Show - S2:E8"
        /^(.+?)\s*[-:]\s*(?:S(\d+):)?E(\d+)/i,
    ];

    for (const regex of patterns) {
        const match = rawTitle.match(regex);
        if (match) {
            // Groups differ by pattern: find season and episode
            const title = match[1].trim();
            // For patterns with optional season group
            let season = 1;
            let episode;
            if (match.length === 4) {
                // Pattern has (title, season?, episode)
                season = match[2] ? parseInt(match[2]) : 1;
                episode = parseInt(match[3]);
            } else {
                episode = parseInt(match[match.length - 1]);
            }
            return { type: 'episode', title, season, episode };
        }
    }

    return {
        type: 'movie',
        title: rawTitle.trim()
    };
}

function validateMatch(query, result, expectedYear) {
    if (!result || !result.show) return false;

    const normalize = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const q = normalize(query);
    const r = normalize(result.show.title);

    if (expectedYear) {
        const resultYear = parseInt(result.show.year);
        if (Math.abs(resultYear - parseInt(expectedYear)) > 1) {
            console.log(`[Ghost Scrobbler] Rejected match: "${result.show.title}" (Year mismatch: ${resultYear} vs ${expectedYear})`);
            return false;
        }
        console.log(`[Ghost Scrobbler] Accepted match based on Year: "${result.show.title}" (${resultYear})`);
        return true;
    }

    if (q === r) return true;

    if (q.length > r.length + 5 && q.startsWith(r)) {
        console.log(`[Ghost Scrobbler] Rejected match: "${result.show.title}" (too short for "${query}")`);
        return false;
    }

    return true;
}

async function searchTmdbAndResolve(query, token) {
    try {
        const storage = await chrome.storage.local.get(['tmdb_api_key', 'client_id']);
        const tmdbKey = storage.tmdb_api_key;
        const clientId = storage.client_id;

        if (!tmdbKey) {
            console.log("[Ghost Scrobbler] TMDB API Key not configured, skipping fallback.");
            return null;
        }

        console.log(`[Ghost Scrobbler] Fallback: Searching TMDB for "${query}"...`);
        const tmdbUrl = `https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(query)}`;
        const tmdbRes = await fetch(tmdbUrl);
        const tmdbData = await tmdbRes.json();

        const bestTmdb = tmdbData.results?.[0];
        if (!bestTmdb) return null;

        console.log(`[Ghost Scrobbler] Found on TMDB: "${bestTmdb.name}" (ID: ${bestTmdb.id}). Resolving to Trakt...`);

        if (!clientId) return null;

        const traktUrl = `${API_URL}/search/tmdb/${bestTmdb.id}?type=show`;
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
            console.log(`[Ghost Scrobbler] Resolved TMDB ID to Trakt Show: "${traktResults[0].show.title}"`);
            return traktResults[0];
        }
    } catch (e) {
        console.error("TMDB Fallback failed:", e);
    }
    return null;
}

async function searchTrakt(query, type, token, year = null) {
    const searchType = type === 'episode' ? 'show' : 'movie';
    let bestResult = null;

    const doSearch = async (q) => {
        let url = `${API_URL}/search/${searchType}?query=${encodeURIComponent(q)}&extended=full`;
        if (year) url += `&years=${year}`;

        console.log(`[Ghost Scrobbler] Searching Trakt: ${url}`);
        try {
            const storage = await chrome.storage.local.get(['client_id']);
            if (!storage.client_id) throw new Error("Client ID missing");

            const res = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    'trakt-api-version': '2',
                    'trakt-api-key': storage.client_id,
                    'Authorization': `Bearer ${token}`
                }
            });
            const results = await res.json();
            console.log(`[Ghost Scrobbler] Search results for "${q}" (Year: ${year}):`, results.length);
            return results;
        } catch (e) {
            console.error("Search failed", e);
            return [];
        }
    };

    // 1. Try Exact Match
    let results = await doSearch(query);
    if (results && results.length > 0) {
        for (const result of results) {
            if (validateMatch(query, result, year)) return result;
        }
        bestResult = results[0];
    }

    // 2. Try Cleaned Title
    const cleaned = query.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned !== query) {
        console.log(`[Ghost Scrobbler] Retrying search with cleaned title: "${cleaned}"`);
        results = await doSearch(cleaned);
        if (results && results.length > 0) {
            for (const result of results) {
                if (validateMatch(query, result, year)) return result;
            }
            if (!bestResult) bestResult = results[0];
        }
    }

    // 3. Fallback to TMDB
    const tmdbResult = await searchTmdbAndResolve(query, token);
    if (tmdbResult) return tmdbResult;

    return bestResult;
}

async function getTmdbImageById(tmdbId, type) {
    if (!tmdbId) return null;
    const storage = await chrome.storage.local.get(['tmdb_api_key']);
    const tmdbKey = storage.tmdb_api_key;
    if (!tmdbKey) return null;

    const searchType = type === 'episode' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${searchType}/${tmdbId}?api_key=${tmdbKey}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.poster_path) {
            return `https://image.tmdb.org/t/p/w500${data.poster_path}`;
        }
    } catch (e) {
        console.error("TMDB ID lookup failed", e);
    }
    return null;
}

async function getTmdbImage(query, type) {
    const storage = await chrome.storage.local.get(['tmdb_api_key']);
    const tmdbKey = storage.tmdb_api_key;
    if (!tmdbKey) return null;

    const searchType = type === 'episode' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/search/${searchType}?api_key=${tmdbKey}&query=${encodeURIComponent(query)}`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.results && data.results.length > 0) {
            const posterPath = data.results[0].poster_path;
            if (posterPath) {
                return `https://image.tmdb.org/t/p/w500${posterPath}`;
            }
        }
    } catch (e) {
        console.error("TMDB search failed", e);
    }
    return null;
}

async function sendScrobble(action, payload, token, clientId) {
    const url = `${API_URL}/scrobble/${action}`;
    try {
        if (!clientId) throw new Error("Client ID missing for scrobble");
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': clientId,
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        console.log(`Scrobble ${action} response:`, json);
    } catch (e) {
        console.error("Scrobble failed", e);
    }
}
