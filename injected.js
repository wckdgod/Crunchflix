// injected.js
// This script runs in the actual Netflix page context (MAIN world)
// to intercept internal API calls and session metadata.

(function () {
    console.log("[CRUNCHFLIX] Network Interceptor Active.");

    const extractFromUrl = (url) => {
        try {
            const urlObj = new URL(url, window.location.origin);
            const authURL = urlObj.searchParams.get('authURL');
            if (authURL) {
                window.postMessage({ type: "SHAKTI_DATA", payload: { authUrl: authURL } }, "*");
            }
        } catch (e) { }
    };

    // 1. Intercept XMLHttpRequest
    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        extractFromUrl(url);
        return oldOpen.apply(this, arguments);
    };

    // 2. Intercept Fetch
    const oldFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = (typeof input === 'string') ? input : input.url;
        extractFromUrl(url);
        return oldFetch.apply(this, arguments);
    };

    // 3. Static Extraction (Fallback)
    const extractStatic = () => {
        const buildId = window.netflix?.reactContext?.models?.serverDefs?.data?.BUILD_IDENTIFIER;
        const authUrl = window.netflix?.reactContext?.models?.userInfo?.data?.authURL;

        if (buildId || authUrl) {
            window.postMessage({
                type: "SHAKTI_DATA",
                payload: { buildId, authUrl }
            }, "*");
        }
    };

    extractStatic();

    // Listen for forced refresh requests
    window.addEventListener("message", (event) => {
        if (event.source === window && event.data.type === "GET_NETFLIX_METADATA_FORCE") {
            extractStatic();
        }
    });

    // Navigation Watcher
    let lastUrl = window.location.href;
    setInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            extractStatic();
        }
    }, 5000);
})();
