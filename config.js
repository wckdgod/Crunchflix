const DEFAULT_SCROB_URL = "http://localhost:7330";
const DEFAULT_SCROB_API_KEY = "";
const APP_NAME = "StreamPulse";
const APP_VERSION = "3.3.0";

// Cross-browser compatibility polyfill for chrome / browser namespaces
if (typeof chrome === 'undefined' && typeof browser !== 'undefined') {
    globalThis.chrome = browser;
}
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    globalThis.browser = chrome;
}

function normalizeBaseUrl(url) {
    if (!url) return DEFAULT_SCROB_URL;
    return url.replace(/\/+$/, '');
}

function getScrobUrl(endpoint, baseUrl = DEFAULT_SCROB_URL) {
    let cleanBase = normalizeBaseUrl(baseUrl);
    let cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

    // Strip trailing /api/proxy from base if user specified it
    if (cleanBase.endsWith('/api/proxy')) {
        cleanBase = cleanBase.substring(0, cleanBase.length - 10);
    }

    // Scrob self-hosted routes all backend API requests through /api/proxy/
    if (!cleanEndpoint.startsWith('/api/proxy/')) {
        cleanEndpoint = `/api/proxy${cleanEndpoint}`;
    }
    return `${cleanBase}${cleanEndpoint}`;
}

function getScrobHeaders(token = null, apiKey = null) {
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': `${APP_NAME}/${APP_VERSION}`
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (apiKey) {
        headers['X-Api-Key'] = apiKey;
    }
    return headers;
}
