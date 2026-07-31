let historyData = [];
let currentFilter = 'all';
let currentFixItem = null;
let selectedTraktItem = null;

document.addEventListener('DOMContentLoaded', () => {
    fetchHistory();
    setupListeners();
});

function setupListeners() {
    document.getElementById('refresh-netflix').addEventListener('click', () => {
        showLoader();
        chrome.runtime.sendMessage({ action: "fetchNetflixHistory" }, (response) => {
            if (response && response.success) {
                historyData = response.items;
                processAndDisplay();
            } else {
                hideLoader();
                console.error("Fetch failed:", response?.error);
            }
        });
    });

    document.getElementById('sync-trakt').addEventListener('click', startSync);

    document.getElementById('history-search').addEventListener('input', (e) => {
        processAndDisplay(e.target.value);
    });

    document.querySelectorAll('.pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentFilter = pill.dataset.filter;
            processAndDisplay(document.getElementById('history-search').value);
        });
    });

    // Modal Listeners
    document.querySelector('.close-modal').addEventListener('click', hideFixModal);
    document.getElementById('cancel-fix').addEventListener('click', hideFixModal);
    document.getElementById('save-fix').addEventListener('click', saveOverride);

    let searchTimeout;
    document.getElementById('trakt-search-input').addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        if (query.length < 3) return;

        // URL Parsing for direct links
        if (query.startsWith('http') && (query.includes('simkl.com') || query.includes('trakt.tv'))) {
            handleSimklUrl(query);
            return;
        }

        searchTimeout = setTimeout(() => {
            performSimklSearch(query);
        }, 500);
    });
}

function handleSimklUrl(url) {
    const showMatch = url.match(/shows\/([^/]+)/) || url.match(/tv\/([^/]+)/);
    const movieMatch = url.match(/movies\/([^/]+)/);
    const seasonMatch = url.match(/seasons\/(\d+)/);
    const epMatch = url.match(/episodes\/(\d+)/);

    const slug = (showMatch || movieMatch)?.[1];
    if (!slug) return;

    const resultsContainer = document.getElementById('search-results-mini');
    resultsContainer.innerHTML = '<p style="padding: 10px; font-size:12px;">Resolving Precision Link...</p>';
    resultsContainer.style.display = 'block';

    chrome.runtime.sendMessage({ action: "resolveSimklUrl", url }, (response) => {
        if (response && response.success && response.results.length > 0) {
            const res = response.results[0];
            selectTraktItem(res);

            if (seasonMatch) document.getElementById('manual-season').value = seasonMatch[1];
            if (epMatch) document.getElementById('manual-episode').value = epMatch[1];

            document.getElementById('search-results-mini').style.display = 'none';
        } else {
            console.error("[CRUNCHFLIX] Resolution failed:", response?.error);
            resultsContainer.innerHTML = `<p style="padding: 10px; font-size:12px; color: #e50914;">Link resolution failed: ${response?.error || 'Unknown error'}</p>`;
        }
    });
}

function fetchHistory() {
    showLoader();
    chrome.runtime.sendMessage({ action: "fetchNetflixHistory" }, (response) => {
        if (response && response.success) {
            historyData = response.items;
            processAndDisplay();
        } else {
            hideLoader();
            console.error("Initial fetch failed:", response?.error);
        }
    });
}

function processAndDisplay(searchQuery = "") {
    const listContainer = document.getElementById('history-list');
    listContainer.innerHTML = '';
    const query = searchQuery.toLowerCase();

    const filtered = historyData.filter(item => {
        const titleMatch = (item.seriesTitle || item.videoTitle || "").toLowerCase().includes(query);
        const filterMatch = currentFilter === 'all' ||
            (currentFilter === 'ready' && !item.isSynced) ||
            (currentFilter === 'synced' && item.isSynced);
        return titleMatch && filterMatch;
    });

    let ready = 0;
    let synced = 0;

    filtered.forEach(item => {
        if (item.isSynced) synced++; else ready++;

        const div = document.createElement('div');
        div.className = `history-item ${item.isSynced ? 'synced' : ''}`;
        div._itemData = item;

        const showTitle = item.seriesTitle || item.videoTitle || "Unknown Show";
        const sNum = String(Number(item.seasonNumber) || 1).padStart(2, '0');
        const eNum = String(Number(item.episodeNumber) || 1).padStart(2, '0');
        const epInfo = (item.seriesTitle) ? `S${sNum}E${eNum} - ${item.videoTitle}` : (item.videoTitle || "No Episode Title");

        let ts = item.watchedDate;
        if (ts > 10000000000000) ts = Math.floor(ts / 1000);
        const dateObj = new Date(ts);
        const formattedDate = isNaN(dateObj.getTime()) ? "Unknown Date" : dateObj.toLocaleDateString();

        const thumbUrl = item.thumbUrl || "https://via.placeholder.com/140x79?text=No+Preview";
        const badgeHTML = item.isSynced ? `<span class="badge synced-badge">SYNCED</span>` : '';
        const checkboxState = item.isSynced ? 'checked disabled' : 'checked';

        div.innerHTML = `
            <img src="${thumbUrl}" alt="Thumbnail" class="ep-thumbnail" onerror="this.src='https://via.placeholder.com/140x79?text=No+Preview'; this.onerror=null;">
            
            <div class="ep-details">
                <h3 class="show-title">${showTitle}</h3>
                <div class="ep-info">
                   <span>${epInfo}</span>
                </div>
                <p class="watch-date">Watched: ${formattedDate}</p>
            </div>
            
            <div class="ep-actions">
                ${badgeHTML}
                <button class="fix-btn-sm">Fix</button>
                <label class="custom-checkbox">
                    <input type="checkbox" ${checkboxState} class="sync-check">
                    <span class="checkmark"></span>
                </label>
            </div>
        `;

        div.querySelector('.fix-btn-sm').addEventListener('click', (e) => {
            e.stopPropagation();
            showFixModal(item);
        });

        listContainer.appendChild(div);
    });

    updateStats(ready, synced, historyData.length);
    hideLoader();
}

function showFixModal(item) {
    currentFixItem = item;
    selectedTraktItem = null;

    const modal = document.getElementById('fix-modal');
    modal.classList.add('active');

    document.getElementById('trakt-search-input').value = item.seriesTitle || item.videoTitle;
    document.getElementById('manual-season').value = item.seasonNumber || 1;
    document.getElementById('manual-episode').value = item.episodeNumber || 1;
    document.getElementById('search-results-mini').style.display = 'none';
    document.getElementById('selected-info').innerHTML = `Currently linked to: <b>${item.videoTitle}</b>`;
}

function hideFixModal() {
    document.getElementById('fix-modal').classList.remove('active');
}

async function performSimklSearch(query) {
    const resultsContainer = document.getElementById('search-results-mini');
    resultsContainer.innerHTML = '<p style="padding: 10px; font-size:12px;">Searching Simkl...</p>';
    resultsContainer.style.display = 'block';

    const searchType = currentFixItem?.seriesTitle ? 'tv' : 'movie';
    chrome.runtime.sendMessage({ action: "performSimklSearch", query, type: searchType }, (response) => {
        if (response && response.success && response.results.length > 0) {
            resultsContainer.innerHTML = '';
            response.results.forEach(res => {
                const item = res.show || res.movie || res;
                const div = document.createElement('div');
                div.className = 'search-item-mini';
                const typeLabel = (res.type || item.type || 'TV').toUpperCase();
                div.innerHTML = `
                    <div class="search-item-info">
                        <span class="item-title-mini">${item.title} (${item.year || ''})</span>
                        <span class="item-meta-mini">${typeLabel}</span>
                    </div>
                `;
                div.addEventListener('click', () => selectTraktItem(res));
                resultsContainer.appendChild(div);
            });
        } else {
            resultsContainer.innerHTML = '<p style="padding: 10px; font-size:12px;">No results found.</p>';
        }
    });
}

function selectTraktItem(res) {
    selectedTraktItem = res;
    const item = res.show || res.movie || res;
    document.getElementById('search-results-mini').style.display = 'none';
    document.getElementById('trakt-search-input').value = item.title;
    document.getElementById('selected-info').innerHTML = `Linked to: <b>${item.title}</b> (${item.year || ''})`;
}

async function saveOverride() {
    if (!currentFixItem) return;

    const override = {
        movieID: currentFixItem.movieID,
        traktItem: selectedTraktItem,
        season: parseInt(document.getElementById('manual-season').value),
        episode: parseInt(document.getElementById('manual-episode').value)
    };

    chrome.storage.local.get(['history_overrides'], (data) => {
        const overrides = data.history_overrides || {};
        overrides[currentFixItem.movieID] = override;

        chrome.storage.local.set({ history_overrides: overrides }, () => {
            hideFixModal();
            fetchHistory(); // Refresh view
        });
    });
}

function updateStats(ready, synced, total) {
    document.getElementById('total-found').textContent = total;
    document.getElementById('ready-count').textContent = ready;
    document.getElementById('synced-count').textContent = synced;
}

function startSync() {
    const selected = Array.from(document.querySelectorAll('.history-item:not(.synced)'))
        .filter(div => div.querySelector('.sync-check').checked)
        .map(div => div._itemData);

    if (selected.length === 0) {
        alert("Please select items to sync.");
        return;
    }

    showLoader();
    chrome.runtime.sendMessage({ action: "bulkSyncToSimkl", items: selected }, (response) => {
        hideLoader();
        if (response && response.success) {
            alert(`Successfully synced items to Simkl!`);
            fetchHistory(); // Refresh
        } else {
            alert("Sync failed: " + (response?.error || "Unknown error"));
        }
    });
}

function showLoader() {
    document.getElementById('loader-overlay').style.display = 'flex';
}

function hideLoader() {
    document.getElementById('loader-overlay').style.display = 'none';
}
