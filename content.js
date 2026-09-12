const IS_TOP_FRAME = (window === window.top);
let isInvalidated = false;
let cachedNetflixTitle = null;
let lastUrl = window.location.href;
let videoCheckInterval;
let heartbeatInterval;

async function remoteLog(message, context = 'CS', level = 'INFO') {
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
window.onerror = (msg, url, line, col, error) => {
    const info = `Uncaught: ${msg} at ${url}:${line}:${col}`;
    remoteLog(info, 'WINDOW', 'ERROR');
};

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
            
            // CONCATENATION PROTECTION: If showName looks like "The MentalistE2" (no space before E2)
            // Split it before the S/E if it's preceded by characters
            if (showName.match(/[a-z0-9]E\d+/i) || showName.match(/[a-z0-9]S\d+/i)) {
                showName = showName.replace(/([a-z0-9])([SE]\d+)/i, '$1 - $2');
            }

            showName = showName.split(/ Season \d+/i)[0].split(/ S\d+/i)[0].split(/ - Episode/i)[0].split(/ \| E\d+/i)[0].split(/E\d+/i)[0].trim();

            const textSeMatch = rawText.match(/S(\d+):E(\d+)/i) || rawText.match(/S(\d+)[\s:]*E(\d+)/i);

            if ((seMatch || textSeMatch) && showName) {
                const finalS = (seMatch || textSeMatch)[1];
                const finalE = (seMatch || textSeMatch)[2];
                console.log(`[STREAMPULSE] Scraped Match: ${showName} S${finalS}:E${finalE}`);
                cachedNetflixTitle = `${showName} - Season ${finalS} Episode ${finalE}`;
                return cachedNetflixTitle;
            } else if (textLines.length > 0 && showName) {
                const epInfo = textLines.find(l => l.match(/E(\d+)/i) || l.match(/Episode\s*\d+/i));
                const seasonLine = textLines.find(l => l.match(/Season\s*(\d+)/i)) || 
                                   textLines.find(l => l.match(/S(\d+)/i));
                let seasonFallback = null;
                if (seasonLine) {
                    const sMatch = seasonLine.match(/Season\s*(\d+)/i) || seasonLine.match(/S(\d+)/i);
                    seasonFallback = sMatch ? sMatch[1] : null;
                }

                // DEEP SEARCH: If not in lines, search specific data-uia or generic labels
                if (!seasonFallback) {
                    const sEl = document.querySelector('[data-uia="video-title-season"]') || 
                                document.querySelector('[class*="season-number"]');
                    if (sEl) {
                        const sMatch = sEl.textContent.match(/Season\s*(\d+)/i) || sEl.textContent.match(/S(\d+)/i);
                        seasonFallback = sMatch ? sMatch[1] : null;
                    }
                }

                let episodeTitle = null;
                if (epInfo) {
                    const epMatch = epInfo.match(/E(\d+)/i) || epInfo.match(/Episode\s*(\d+)/i);
                    // Extract quoted text or the rest of the line as episodeTitle
                    const titleMatch = epInfo.match(/"([^"]+)"/) || epInfo.match(/Episode\s*\d+\s*[|\-:]\s*(.+)$/i);
                    episodeTitle = titleMatch ? titleMatch[1] : null;

                    console.log(`[STREAMPULSE] Scraped Fallback: ${showName} S:${seasonFallback} E:${epMatch[1]} Title:${episodeTitle}`);
                    if (seasonFallback) {
                        cachedNetflixTitle = `${showName} - Season ${seasonFallback} Episode ${epMatch[1]}` + (episodeTitle ? ` - ${episodeTitle}` : '');
                    } else {
                        cachedNetflixTitle = `${showName} - Episode ${epMatch[1]}` + (episodeTitle ? ` - ${episodeTitle}` : '');
                    }
                    return cachedNetflixTitle;
                }
            }
        }
    } catch (e) {
        console.error("[STREAMPULSE] Error scraping Netflix DOM:", e);
    }

    const title = document.title;
    console.log(`[STREAMPULSE] Falling back to document.title: "${title}"`);
    const GENERIC_NETFLIX = ["Netflix", "Netflix Home", ""];
    if (GENERIC_NETFLIX.some(g => title.trim().toLowerCase().includes(g.toLowerCase()) && title.trim().length <= g.length + 2)) return null;
    return title;
}

function parseCrunchyrollMetadata() {
    try {
        // STRATEGY 1: JSON-LD (Improved via MALSync strategy, supports both flat schema and @graph arrays)
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
            try {
                const text = script.textContent;
                const parsed = JSON.parse(text);
                const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
                for (const json of items) {
                    const series = json.partOfSeries?.name || json.partOfSeason?.partOfSeries?.name || (json['@type'] === 'TVEpisode' ? json.name : null);
                    const episodeNumber = json.episodeNumber;
                    const seasonNumber = json.partOfSeason?.seasonNumber;

                    if (series && episodeNumber) {
                        if (seasonNumber) {
                            return `${series} Season ${seasonNumber} - Episode ${episodeNumber}`;
                        }
                        return `${series} - Episode ${episodeNumber}`;
                    }
                }
            } catch (e) { }
        }

        // STRATEGY 2: Crunchyroll Modern DOM Player Elements
        const crShowLink = document.querySelector('[data-t="show-title-link"], a[href*="/series/"] h4, a[href*="/series/"], .show-title-link, [class*="show-title"]');
        const crEpTitle = document.querySelector('[data-t="episode-title"], [data-t="current-media-title"], [class*="current-media-title"], [class*="episode-title"]');
        const crEpNum = document.querySelector('[data-t="episode-number"], [class*="episode-num"]');
        
        let showName = crShowLink?.textContent?.trim() || "";
        let epNum = crEpNum?.textContent?.trim() || "";
        let epTitleText = crEpTitle?.textContent?.trim() || "";

        // Check if episode number is in epTitleText (e.g. "E3 - Stranded", "Chronoa the Hero (2)", "Part 2")
        if (!epNum && epTitleText) {
            const m = epTitleText.match(/(?:E|Episode|Ep\.?)\s*(\d+)/i) ||
                      epTitleText.match(/[-_\s(]Part\s*(\d+)[)]?/i) ||
                      epTitleText.match(/\((\d+)\)/);
            if (m) epNum = m[1];
        }

        // Check next episode card in player: "NEXT EPISODE: E4 - The King's Homecoming" -> current is E3
        if (!epNum) {
            const nextEpEl = document.querySelector('[data-t="next-episode"], [class*="next-episode"]');
            if (nextEpEl) {
                const nextMatch = (nextEpEl.innerText || nextEpEl.textContent).match(/E(\d+)/i);
                if (nextMatch) {
                    const derived = parseInt(nextMatch[1], 10) - 1;
                    if (derived > 0) epNum = String(derived);
                }
            }
        }

        // Check URL for episode indicators (e.g. "...-episode-3-..." or "...-e3-..." or "...-part-2")
        if (!epNum && window.location.pathname) {
            const urlMatch = window.location.pathname.match(/(?:episode|ep|e)[-_](\d+)/i) ||
                             window.location.pathname.match(/(?:part)[-_](\d+)/i);
            if (urlMatch) epNum = urlMatch[1];
        }

        if (showName && epNum) {
            return `${showName} - Episode ${epNum}`;
        }
        if (showName && epTitleText) {
            return `${showName} - ${epTitleText}`;
        }

        // STRATEGY 3: Meta tags
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
        if (ogTitle) {
            let cleanOg = ogTitle.replace(/^Watch\s+/i, '');
            cleanOg = cleanOg.replace(/\s*-\s*Watch on Crunchyroll$/i, '');
            if (epNum && !cleanOg.match(/episode|e\d+/i)) {
                return `${cleanOg} - Episode ${epNum}`;
            }
            return cleanOg;
        }

        // STRATEGY 4: Page Title
        let docTitle = document.title;
        docTitle = docTitle.replace(/\s*-\s*Watch on Crunchyroll$/i, '');
        if (epNum && !docTitle.match(/episode|e\d+/i)) {
            return `${docTitle} - Episode ${epNum}`;
        }
        return docTitle;
    } catch (e) { console.warn("Crunchyroll scraper error:", e); }

    const GENERIC_CR = ["Crunchyroll", "Vilos", ""];
    if (GENERIC_CR.includes(document.title.trim())) return null;
    return document.title;
}

function parseHotstarMetadata() {
    try {
        // STRATEGY 1: Player UI (Highest accuracy)
        // Targeted based on user-provided structure: <div aria-label="Show, Season, Episode, Title" role="button">
        const playerTitleEl = document.querySelector('div[aria-label*="Season"][aria-label*="Episode"][role="button"]');
        if (playerTitleEl) {
            const aria = playerTitleEl.getAttribute('aria-label');
            if (aria) {
                // Return cleaned version: "Malcolm in the Middle, Season 1, Episode 2"
                return aria.replace(/,\s*[^,]+$/, '').trim(); // Remove the episode name if it's the 4th item
            }
        }

        // STRATEGY 2: JSON-LD structured data
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
            try {
                const json = JSON.parse(script.textContent);

                // TVEpisode type
                if (json['@type'] === 'TVEpisode' || json.partOfSeries) {
                    const series = json.partOfSeries?.name || json.name;
                    const episodeNumber = json.episodeNumber;
                    const seasonNumber = json.partOfSeason?.seasonNumber;

                    if (series && episodeNumber) {
                        if (seasonNumber) {
                            return `${series} Season ${seasonNumber} - Episode ${episodeNumber}`;
                        }
                        return `${series} - Episode ${episodeNumber}`;
                    }
                }

                // Movie type
                if (json['@type'] === 'Movie' && json.name) {
                    return json.name;
                }
            } catch (e) { }
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
            if (cleaned) return cleaned;
        }

        // STRATEGY 3: Document title
        let docTitle = document.title;
        docTitle = docTitle
            .replace(/^Watch\s+/i, '')
            .replace(/\s*[|\-]\s*(?:Jio\s*)?Hotstar\s*$/i, '')
            .replace(/\s*[|\-]\s*Disney\+?\s*Hotstar\s*$/i, '')
            .replace(/\s+on\s+(?:Jio\s*)?Hotstar\s*$/i, '')
            .replace(/\s+on\s+Disney\+?\s*Hotstar\s*$/i, '')
            .trim();

        const GENERIC_HS = ["JioHotstar", "Jio Hotstar", "Hotstar", "Disney+ Hotstar", ""];
        if (GENERIC_HS.some(g => docTitle.toLowerCase() === g.toLowerCase())) return null;
        return docTitle;
    } catch (e) {
        console.error("[STREAMPULSE] Error scraping Hotstar DOM:", e);
    }
    return null;
}

function querySelectorShadow(selector, root = document) {
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
}

function parsePrimeVideoSubtitle(subtitleText) {
    if (!subtitleText) return null;
    const text = subtitleText.trim();
    if (!text) return null;

    // Pattern 1: Season & Episode with optional title across languages (Season, Staffel, Saison, Temporada, Stagione, Sezon, Seizoen, T, 季, 시즌, シーズン)
    const fullMatch = text.match(/(?:Season|Staffel|Saison|Temporada|Stagione|Sezon|Seizoen|Temp|St|S|T|季|시즌|シーズン)\s*(\d+)[\s,.:\-_\|•\/\\]*(?:Episode|Episodio|Episódio|Épisode|Folge|Odcinek|Aflevering|Bölüm|Ep|E|F|Odc|Afl|B|話|화|集)\.?\s*(\d+)[\s:|\-]*([\s\S]*)/i);
    if (fullMatch) {
        return {
            season: parseInt(fullMatch[1]),
            episode: parseInt(fullMatch[2]),
            episodeTitle: fullMatch[3]?.trim() || null
        };
    }

    // Pattern 2: 1x02 or S01E02 format
    const codeMatch = text.match(/(?:S|T)?\s*(\d+)\s*(?:x|e|ep)\s*(\d+)[\s:|\-]*([\s\S]*)/i);
    if (codeMatch && (text.toLowerCase().includes('x') || text.toLowerCase().includes('e') || text.toLowerCase().includes('ep'))) {
        return {
            season: parseInt(codeMatch[1]),
            episode: parseInt(codeMatch[2]),
            episodeTitle: codeMatch[3]?.trim() || null
        };
    }

    // Pattern 3: Episode keyword only (e.g. "Episode 2 Pilot", "Folge 2", "Épisode 2", "Ep. 2", "Odcinek 2")
    const epMatch = text.match(/(?:Episode|Episodio|Episódio|Épisode|Folge|Odcinek|Aflevering|Bölüm|Ep|E|F|Odc|Afl|B|話|화|集)\.?\s*(\d+)[\s:|\-]*([\s\S]*)/i);
    if (epMatch) {
        return {
            season: 1,
            episode: parseInt(epMatch[1]),
            episodeTitle: epMatch[2]?.trim() || null
        };
    }

    // Pattern 4: Season keyword only (e.g. "Season 1", "Staffel 1", "Temporada 1")
    const seasonMatch = text.match(/^(?:Season|Staffel|Saison|Temporada|Stagione|Sezon|Seizoen|Temp|St|S|T)\s*(\d+)$/i);
    if (seasonMatch) {
        return {
            season: parseInt(seasonMatch[1]),
            episode: null,
            episodeTitle: null
        };
    }

    return null;
}

function findPrimeVideoSeasonEpisodeDOM() {
    // 1. Check subtitle selectors
    const subtitleSelectors = [
        '.atvwebplayersdk-subtitle-text',
        '[data-automation-id="subtitle"]',
        '[class*="atvwebplayersdk-subtitle"]',
        '[class*="Subtitle-module__subtitle"]',
        '[class*="subtitle"]',
        '[class*="Subtitle"]',
        '[class*="secondary-title"]',
        '[class*="meta"]'
    ];

    for (const sel of subtitleSelectors) {
        const el = querySelectorShadow(sel);
        if (el?.textContent?.trim()) {
            const epInfo = parsePrimeVideoSubtitle(el.textContent);
            if (epInfo && epInfo.episode) return epInfo;
        }
    }

    // 2. Check titleElement siblings or parent text
    const titleSelectors = [
        '.atvwebplayersdk-title-text',
        '[data-automation-id="title"]',
        '[class*="atvwebplayersdk-title"]',
        '[class*="Title-module__title"]',
        '[data-testid="video-title"]',
        '.webPlayerTitle'
    ];

    for (const sel of titleSelectors) {
        const el = querySelectorShadow(sel);
        if (el) {
            if (el.nextElementSibling?.textContent) {
                const epInfo = parsePrimeVideoSubtitle(el.nextElementSibling.textContent);
                if (epInfo && epInfo.episode) return epInfo;
            }
            if (el.parentElement?.textContent) {
                const epInfo = parsePrimeVideoSubtitle(el.parentElement.textContent);
                if (epInfo && epInfo.episode) return epInfo;
            }
        }
    }

    // 3. Search aria-labels
    const ariaElements = document.querySelectorAll('[aria-label*="Season"], [aria-label*="Staffel"], [aria-label*="Saison"], [aria-label*="Temporada"], [aria-label*="Stagione"], [aria-label*="Episode"], [aria-label*="Folge"], [aria-label*="Épisode"], [aria-label*="Episodio"], [aria-label*="Ep."]');
    for (const el of ariaElements) {
        const aria = el.getAttribute('aria-label') || '';
        const epInfo = parsePrimeVideoSubtitle(aria);
        if (epInfo && epInfo.episode) return epInfo;
    }

    // 4. Broad DOM search for leaf elements
    try {
        const allLeafs = document.querySelectorAll('div, span, p');
        for (const el of allLeafs) {
            if (el.children.length === 0 && el.textContent) {
                const text = el.textContent.trim();
                if (text.length > 3 && text.length < 100) {
                    const epInfo = parsePrimeVideoSubtitle(text);
                    if (epInfo && epInfo.episode) return epInfo;
                }
            }
        }
    } catch (e) { }

    return null;
}

function parsePrimeVideoMetadata() {
    try {
        // TIER 1: Meta Tags (og:title, meta description, twitter:title, og:description)
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content ||
                        document.querySelector('meta[name="twitter:title"]')?.content || '';
        const metaDesc = document.querySelector('meta[name="description"]')?.content ||
                         document.querySelector('meta[property="og:description"]')?.content || '';

        if (ogTitle) {
            let cleanOg = ogTitle
                .replace(/^Prime Video:\s*/i, '')
                .replace(/^Watch\s+/i, '')
                .replace(/\s*[|\-]\s*Prime Video\s*$/i, '')
                .replace(/\s*[|\-]\s*Amazon\s*$/i, '')
                .trim();

            const ogMatch = cleanOg.match(/(.+?)\s+[-:,|]?\s*(?:Season|Staffel|Saison|Temporada|Stagione|Sezon|Seizoen|S|T)\s*(\d+)[\s,.:\-_\|•\/\\]*(?:Episode|Episodio|Episódio|Épisode|Folge|Odcinek|Aflevering|Bölüm|Ep|E|F)\.?\s*(\d+)/i);
            if (ogMatch) {
                console.log(`[STREAMPULSE] Prime Video og:title matched: ${ogMatch[1]} S${ogMatch[2]}:E${ogMatch[3]}`);
                return `${ogMatch[1].trim()} - Season ${ogMatch[2]} Episode ${ogMatch[3]}`;
            }

            // If og:title has Show Name & Season, check if metaDesc has Episode Number
            const showSeasonMatch = cleanOg.match(/(.+?)\s+[-:,|]?\s*(?:Season|Staffel|Saison|Temporada|Stagione|Sezon|Seizoen|S|T)\s*(\d+)/i);
            if (showSeasonMatch && metaDesc) {
                const epMatch = metaDesc.match(/(?:Episode|Episodio|Episódio|Épisode|Folge|Odcinek|Aflevering|Bölüm|Ep|E|F)\.?\s*(\d+)/i);
                if (epMatch) {
                    console.log(`[STREAMPULSE] Prime Video og:title + metaDesc matched: ${showSeasonMatch[1]} S${showSeasonMatch[2]}:E${epMatch[1]}`);
                    return `${showSeasonMatch[1].trim()} - Season ${showSeasonMatch[2]} Episode ${epMatch[1]}`;
                }
            }
        }

        // TIER 2: JSON-LD Structured Data
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
            try {
                const json = JSON.parse(script.textContent);
                if (json['@type'] === 'TVEpisode' || json.partOfSeries) {
                    const series = json.partOfSeries?.name || json.name;
                    const episodeNumber = json.episodeNumber;
                    const seasonNumber = json.partOfSeason?.seasonNumber;
                    if (series && episodeNumber) {
                        const sNum = seasonNumber || 1;
                        console.log(`[STREAMPULSE] Prime Video JSON-LD matched: ${series} S${sNum}:E${episodeNumber}`);
                        return `${series} - Season ${sNum} Episode ${episodeNumber}`;
                    }
                }
            } catch (e) { }
        }

        // TIER 3: DOM Player Title + Multi-tier Subtitle / Season-Episode Search
        const titleSelectors = [
            '.atvwebplayersdk-title-text',
            '[data-automation-id="title"]',
            '[class*="atvwebplayersdk-title"]',
            '[class*="Title-module__title"]',
            '[data-testid="video-title"]',
            '.webPlayerTitle'
        ];

        let titleElement = null;
        for (const sel of titleSelectors) {
            titleElement = querySelectorShadow(sel);
            if (titleElement?.textContent?.trim()) break;
        }

        if (titleElement) {
            const titleText = titleElement.textContent?.trim() || '';

            if (titleText) {
                // Check if titleText itself already contains Season/Episode
                const titleSeMatch = titleText.match(/(.+?)\s+[-:]?\s*(?:Season|Staffel|Saison|Temporada|Stagione|Sezon|Seizoen|S|T)\s*(\d+)\s*(?:Episode|Episodio|Episódio|Épisode|Folge|Odcinek|Aflevering|Bölüm|Ep|E|F)\.?\s*(\d+)/i);
                if (titleSeMatch) {
                    return `${titleSeMatch[1].trim()} - Season ${titleSeMatch[2]} Episode ${titleSeMatch[3]}`;
                }

                const epInfo = findPrimeVideoSeasonEpisodeDOM();
                if (epInfo && epInfo.episode) {
                    const sNum = epInfo.season || 1;
                    const eNum = epInfo.episode;
                    const epTitle = epInfo.episodeTitle ? ` - ${epInfo.episodeTitle}` : '';
                    console.log(`[STREAMPULSE] Prime Video DOM matched: ${titleText} S${sNum}:E${eNum}${epTitle}`);
                    return `${titleText} - Season ${sNum} Episode ${eNum}${epTitle}`;
                }

                if (epInfo && epInfo.season && !epInfo.episode) {
                    return `${titleText} Season ${epInfo.season}`;
                }

                return titleText;
            }
        }

        // TIER 4: Document Title Parsing
        const docTitle = (document.title || '').trim();
        let cleanDoc = docTitle
            .replace(/^Prime Video:\s*/i, '')
            .replace(/^Watch\s+/i, '')
            .replace(/\s*[|\-]\s*Prime Video\s*$/i, '')
            .replace(/\s*[|\-]\s*Amazon\s*$/i, '')
            .trim();

        const docSeMatch = cleanDoc.match(/(.+?)\s+[-:,|]?\s*(?:Season|Staffel|Saison|Temporada|Stagione|Sezon|Seizoen|S|T)\s*(\d+)[\s,.:\-_\|•\/\\]*(?:Episode|Episodio|Episódio|Épisode|Folge|Odcinek|Aflevering|Bölüm|Ep|E|F)\.?\s*(\d+)/i);
        if (docSeMatch) {
            console.log(`[STREAMPULSE] Prime Video docTitle matched: ${docSeMatch[1]} S${docSeMatch[2]}:E${docSeMatch[3]}`);
            return `${docSeMatch[1].trim()} - Season ${docSeMatch[2]} Episode ${docSeMatch[3]}`;
        }
    } catch (e) {
        console.error("[STREAMPULSE] Error scraping Prime Video DOM:", e);
    }

    const checkGeneric = (title) => {
        if (!title) return true;
        const t = title.trim().toLowerCase();
        if (t === "") return true;
        if (t.includes("season") && !t.includes("episode") && !t.includes("ep.") && !t.includes("ep ")) return true;
        const exactMatches = ["vilos", "netflix", "crunchyroll", "watch", "{iframe, needs metadata}", "jiohotstar", "jio hotstar", "hotstar", "disney+ hotstar", "prime video", "primevideo", "amazon prime", "amazon prime video", "amazon"];
        if (exactMatches.includes(t)) return true;
        if (t.includes("watch tv shows, movies") || t.includes("watch movies, tv shows") || t.includes("sports, and live tv") || t.includes("live cricket") || t.startsWith("netflix - ")) return true;
        if (t.startsWith("prime video:") && (t.includes("watch") || t.includes("movies") || t.includes("tv shows"))) return true;
        return false;
    };

    const docTitle = (document.title || '').trim();
    if (checkGeneric(docTitle)) return null;

    let cleanDoc = docTitle
        .replace(/^Prime Video:\s*/i, '')
        .replace(/^Watch\s+/i, '')
        .replace(/\s*[|\-]\s*Prime Video\s*$/i, '')
        .replace(/\s*[|\-]\s*Amazon\s*$/i, '')
        .trim();

    if (checkGeneric(cleanDoc)) return null;

    if (cleanDoc.toLowerCase().includes("season") && !cleanDoc.toLowerCase().includes("episode") && !cleanDoc.toLowerCase().includes("ep.") && !cleanDoc.toLowerCase().includes("ep ")) {
        return null;
    }

    return cleanDoc;
}

function extractTitle() {
    const domain = window.location.hostname;
    if (domain.includes("netflix.com")) return parseNetflixMetadata();
    if (domain.includes("crunchyroll.com")) return parseCrunchyrollMetadata();
    if (domain.includes("hotstar.com") || domain.includes("jiohotstar.com")) return parseHotstarMetadata();
    if (domain.includes("primevideo.com") || domain.includes("amazon.com") || domain.includes("amazon.co.uk") || domain.includes("amazon.co.jp") || domain.includes("amazon.de") || domain.includes("amazon.com.au")) return parsePrimeVideoMetadata();
    return document.title;
}

// ── Site-Specific Initializers ──

let port = null;

// Background message listener for on-demand metadata or UI actions
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "getMetadata") {
        sendResponse({ title: extractTitle() });
    } else if (message.action === "showToast") {
        showToast(message.payload?.message || message.message);
    }
});

function connectToBackground() {
    // Check if context is already invalidated
    if (chrome.runtime?.id === undefined) {
        if (!isInvalidated) {
            console.error("[STREAMPULSE] Extension context invalidated. Monitoring stopped.");
            isInvalidated = true;
            stopAllIntervals();
            showRefreshToast();
        }
        return;
    }

    try {
        port = chrome.runtime.connect({ name: "streampulse-port" });
        port.onDisconnect.addListener(() => {
            if (chrome.runtime?.id === undefined) {
                console.error("[STREAMPULSE] Extension context invalidated during disconnect.");
                isInvalidated = true;
                return;
            }
            console.warn("[STREAMPULSE] Port disconnected. Reconnecting in 1s...");
            port = null;
            setTimeout(connectToBackground, 1000);
        });
        console.log("[STREAMPULSE] Connected to background port.");
    } catch (e) {
        console.error("[STREAMPULSE] Failed to connect to background:", e);
        if (e.message.includes("context invalidated")) {
            isInvalidated = true;
        }
    }
}

function sendToPort(action, payload) {
    if (isInvalidated || chrome.runtime?.id === undefined) {
        if (!isInvalidated) {
            isInvalidated = true;
            stopAllIntervals();
            showRefreshToast();
        }
        return;
    }
    try {
        if (port) {
            port.postMessage({ action, payload });
        }
    } catch (e) {
        if (e.message?.includes("Extension context invalidated")) {
            isInvalidated = true;
            stopAllIntervals();
            showRefreshToast();
        } else {
            console.error("[STREAMPULSE] Error sending to port:", e);
        }
    }
}

let globalIframeTitle = null;

// Global listener for iframe title broadcasts from the top window
window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "STREAMPULSE_TITLE_BROADCAST") {
        globalIframeTitle = event.data.title;
    }
});

function initNetflix() {
    if (!IS_TOP_FRAME) return;

    console.log("[STREAMPULSE] Initializing Netflix Parser...");

    // Port listener for background messages
    if (port) {
        port.onMessage.addListener((message) => {
            if (message.action === "REFRESH_SESSION") {
                console.log("[STREAMPULSE] Force-refreshing Shakti keys...");
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
    console.log("[STREAMPULSE] Initializing Crunchyroll Parser...");

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
                        type: "STREAMPULSE_TITLE_BROADCAST",
                        title: topTitle
                    }, "*");
                } catch (e) { }
            });
        }
    }, 3000);
}

function initHotstar() {
    if (!IS_TOP_FRAME) return;
    console.log("[STREAMPULSE] Initializing Jio Hotstar Parser...");

    setInterval(() => {
        const topTitle = extractTitle();
        if (topTitle) {
            const frames = document.querySelectorAll('iframe');
            frames.forEach(frame => {
                try {
                    frame.contentWindow.postMessage({
                        type: "STREAMPULSE_TITLE_BROADCAST",
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

function showRefreshToast() {
    try {
        const toast = document.createElement('div');
        toast.textContent = "STREAMPULSE: Extension updated. Please refresh the page to continue scrobbling.";
        Object.assign(toast.style, {
            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
            backgroundColor: '#e50914', color: '#fff', padding: '10px 20px', borderRadius: '4px',
            zIndex: '999999', fontFamily: 'sans-serif', fontWeight: 'bold', boxShadow: '0 2px 10px rgba(0,0,0,0.5)'
        });
        document.body.appendChild(toast);
    } catch (e) { }
}

function stopAllIntervals() {
    if (videoCheckInterval) clearInterval(videoCheckInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
}

function sendScrobbleMessage(video, status) {
    if (isInvalidated) return;

    // Filter out disconnected or hidden/inactive video elements
    if (!video.isConnected) return;
    try {
        const rect = video.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
    } catch (e) { }

    // Filter out trailers, previews, and ads (less than 5 mins)
    if (video.duration && video.duration < 300) {
        return;
    }

    const progress = video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0;

    // If we're inside an iframe, prefer the broadcasted title from the top window
    let title = (!IS_TOP_FRAME && globalIframeTitle) ? globalIframeTitle : extractTitle();

    // IFRAME POLLUTION PROTECTION: 
    // If we are an iframe and have no title (generic), skip sending to avoid overwriting top-frame state
    if (!IS_TOP_FRAME && !globalIframeTitle && (!title || title.toLowerCase().includes('netflix') || title.toLowerCase().includes('hotstar') || title.toLowerCase().includes('amazon') || title.toLowerCase().includes('prime'))) {
        return;
    }

    if (window.location.href !== lastUrl) {
        console.log(`[STREAMPULSE] Navigation detected (${lastUrl} -> ${window.location.href}), resetting cached metadata.`);
        lastUrl = window.location.href;
        cachedNetflixTitle = null;
        globalIframeTitle = null;
    }

    console.log(`[STREAMPULSE] Sending: status=${status}, title="${title || '(iframe, needs metadata)'}", progress=${progress}%`);

    const hostname = window.location.hostname;
    let platform = 'netflix';
    if (hostname.includes('crunchyroll')) platform = 'crunchyroll';
    else if (hostname.includes('hotstar') || hostname.includes('jiohotstar')) platform = 'hotstar';
    else if (hostname.includes('primevideo') || hostname.includes('amazon')) platform = 'amazon-prime';

    sendToPort("scrobble", {
        status,
        title,
        progress,
        currentTime: video.currentTime,
        duration: video.duration,
        platform,
        fromIframe: !IS_TOP_FRAME
    });
}

function sendLiveProgressUpdate(video) {
    if (isInvalidated || video.paused || video.ended) return;

    // Filter out disconnected or hidden/inactive video elements
    if (!video.isConnected) return;
    try {
        const rect = video.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
    } catch (e) { }

    // Filter out trailers, previews, and ads (less than 5 mins)
    if (video.duration && video.duration < 300) {
        return;
    }

    const progress = video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0;

    const hostname = window.location.hostname;
    let platform = 'netflix';
    if (hostname.includes('crunchyroll')) platform = 'crunchyroll';
    else if (hostname.includes('hotstar') || hostname.includes('jiohotstar')) platform = 'hotstar';
    else if (hostname.includes('primevideo') || hostname.includes('amazon')) platform = 'amazon-prime';

    sendToPort("progress_update", {
        progress,
        currentTime: video.currentTime,
        duration: video.duration,
        platform,
        status: 'playing'
    });
}

function monitorVideo(video) {
    if (video.getAttribute('data-ghost-monitored')) return;
    video.setAttribute('data-ghost-monitored', 'true');
    console.log("[STREAMPULSE] Monitoring video element" + (IS_TOP_FRAME ? " (top frame)" : " (iframe)"));

    if (window.location.hostname.includes('primevideo.com') || window.location.hostname.includes('amazon')) {
        showToast("STREAMPULSE: Video playback detected!");
    }

    video.addEventListener('play', () => {
        video._autoStopped = false;
        sendScrobbleMessage(video, 'playing');
    });
    video.addEventListener('pause', () => sendScrobbleMessage(video, 'paused'));
    video.addEventListener('ended', () => sendScrobbleMessage(video, 'stopped'));

    // Listen for metadata loading so we can start scrobbling as soon as duration is available
    video.addEventListener('loadedmetadata', () => {
        if (!video.paused && !video.ended) {
            sendScrobbleMessage(video, 'playing');
        }
    });

    if (!video.paused && !video.ended) sendScrobbleMessage(video, 'playing');

    if (video._ghostHeartbeat) clearInterval(video._ghostHeartbeat);
    video._ghostHeartbeat = setInterval(() => {
        if (!video.paused && !video.ended && !video._autoStopped) {
            const progress = video.duration ? (video.currentTime / video.duration) * 100 : 0;
            if (progress >= 80) {
                video._autoStopped = true;
                sendScrobbleMessage(video, 'stopped');
            }
        }
    }, 5000);

    // Live UI updates (every second)
    if (video._ghostLiveProgress) clearInterval(video._ghostLiveProgress);
    video._ghostLiveProgress = setInterval(() => {
        sendLiveProgressUpdate(video);
    }, 1000);

    window.addEventListener('beforeunload', () => {
        if (video && !video.ended) {
            const progress = video.duration ? (video.currentTime / video.duration) * 100 : 0;
            sendScrobbleMessage(video, progress >= 85 ? 'stopped' : 'paused');
        }
    }, { capture: true });
}

function checkForVideo() {
    // 1. Search in main DOM
    const videos = Array.from(document.getElementsByTagName('video'));

    // 2. Search inside Shadow DOMs (recursively)
    function findVideoInShadow(root) {
        const shadowVideos = Array.from(root.querySelectorAll('video'));
        if (shadowVideos.length > 0) videos.push(...shadowVideos);

        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
            if (el.shadowRoot) findVideoInShadow(el.shadowRoot);
        }
    }

    // Start shadow search from common containers
    const all = document.querySelectorAll('*');
    for (const el of all) {
        if (el.shadowRoot) findVideoInShadow(el.shadowRoot);
    }

    if (videos.length > 0) {
        // Monitor all found video elements
        videos.forEach(v => monitorVideo(v));
    }
}

// ── Routing and Entry Point ──

function initPrimeVideo() {
    if (!IS_TOP_FRAME) return;
    console.log("[STREAMPULSE] Initializing Prime Video Parser...");
    showToast("STREAMPULSE: Initializing Prime Video...");

    // Broadcast the scraped title from top frame down to player iframes
    setInterval(() => {
        const topTitle = extractTitle();
        if (topTitle) {
            const frames = document.querySelectorAll('iframe');
            frames.forEach(frame => {
                try {
                    frame.contentWindow.postMessage({
                        type: "STREAMPULSE_TITLE_BROADCAST",
                        title: topTitle
                    }, "*");
                } catch (e) { }
            });
        }
    }, 3000);
}

(function init() {
    const CS_VERSION = "3.0.1";
    console.log(`[STREAMPULSE] Content script loaded. Version: ${CS_VERSION}`);
    remoteLog(`Content script loaded on ${window.location.hostname}. Version: ${CS_VERSION}`, "INIT");
    connectToBackground();

    const domain = window.location.hostname;

    if (domain.includes("netflix.com")) {
        initNetflix();
    } else if (domain.includes("crunchyroll.com")) {
        initCrunchyroll();
    } else if (domain.includes("hotstar.com") || domain.includes("jiohotstar.com")) {
        initHotstar();
    } else if (domain.includes("primevideo.com") || domain.includes("amazon.com") || domain.includes("amazon.co.uk") || domain.includes("amazon.co.jp") || domain.includes("amazon.de") || domain.includes("amazon.com.au")) {
        initPrimeVideo();
    }

    videoCheckInterval = setInterval(checkForVideo, 2000);
})();
