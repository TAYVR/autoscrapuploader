const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { saveMovieRecord, movieExists } = require('./turso');

puppeteer.use(StealthPlugin());

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const STATE_PATH = path.join(__dirname, 'state.json');

/**
 * Normalize a movie URL so the same movie is never scraped twice,
 * even if it appears with trailing slashes or different URL-encoding.
 */
function canonicalUrl(url) {
    try {
        return decodeURIComponent(url).replace(/\/+$/, '').toLowerCase();
    } catch (e) {
        return (url || '').replace(/\/+$/, '').toLowerCase();
    }
}

/**
 * Load state tracking file
 */
function loadState() {
    if (fs.existsSync(STATE_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
            return {
                currentPage: data.currentPage || 1,
                processedMovies: Array.isArray(data.processedMovies) ? data.processedMovies : []
            };
        } catch (e) {
            console.error('[STATE] Error reading state.json, using default state.');
        }
    }
    return { currentPage: 1, processedMovies: [] };
}

/**
 * Save updated state tracking file
 */
function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`[STATE] Saved state.json: Page ${state.currentPage}, total processed movies: ${state.processedMovies.length}`);
}
/**
 * Downloads an HLS stream to a local .ts file using Node.js axios.
 * Uses browser-like headers to bypass CDN bot detection that blocks FFmpeg.
 */
async function downloadHlsToFile(masterUrl, iframeUrl, outputPath) {
    const referer = iframeUrl || masterUrl;
    const origin = new URL(referer).origin;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': referer,
        'Origin': origin,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
    };

    // Step 1: Fetch master playlist
    console.log('[HLS-DL] Fetching master playlist...');
    const masterRes = await axios.get(masterUrl, { headers, timeout: 30000 });
    const masterText = masterRes.data;
    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);

    // Step 2: Find best quality sub-playlist
    let streamUrl = null;
    const lines = masterText.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (!line.startsWith('#')) {
            streamUrl = line.startsWith('http') ? line : baseUrl + line;
            break;
        }
    }

    if (!streamUrl) throw new Error('No stream playlist found in master.m3u8');

    // Step 3: Fetch segment playlist
    console.log(`[HLS-DL] Fetching segment playlist: ${streamUrl}`);
    const streamBase = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
    const segRes = await axios.get(streamUrl, { headers, timeout: 30000 });
    const segLines = segRes.data.split('\n').map(l => l.trim()).filter(Boolean);

    const segments = segLines
        .filter(l => !l.startsWith('#'))
        .map(l => l.startsWith('http') ? l : streamBase + l);

    if (segments.length === 0) throw new Error('No segments found in stream playlist');
    console.log(`[HLS-DL] Downloading ${segments.length} segments...`);

    // Step 4: Download and concatenate segments with per-segment retry + backpressure
    const writeStream = fs.createWriteStream(outputPath);

    // Fetch one segment, retrying on transient errors (aborts, resets, timeouts)
    const fetchSegment = async (url, attempt = 1) => {
        try {
            return await axios.get(url, {
                headers,
                responseType: 'arraybuffer',
                timeout: 90000
            });
        } catch (e) {
            if (attempt < 5) {
                process.stdout.write(`\r[HLS-DL] Segment retry (attempt ${attempt}/5)... `);
                await new Promise(r => setTimeout(r, 3000 * attempt));
                return fetchSegment(url, attempt + 1);
            }
            throw e;
        }
    };

    // Wait for the write stream to drain so we never overflow its internal buffer
    const writeAndDrain = async (buf) => {
        if (!writeStream.write(buf)) {
            await new Promise(resolve => writeStream.once('drain', resolve));
        }
    };

    for (let idx = 0; idx < segments.length; idx++) {
        const segUrl = segments[idx];
        if ((idx + 1) % 20 === 0 || idx === 0) {
            process.stdout.write(`\r[HLS-DL] Segment ${idx + 1}/${segments.length}`);
        }
        const segData = await fetchSegment(segUrl);
        await writeAndDrain(Buffer.from(segData.data));
    }
    console.log('');

    await new Promise((resolve, reject) => {
        writeStream.end((err) => err ? reject(err) : resolve());
    });

    const stats = fs.statSync(outputPath);
    console.log(`[HLS-DL] Download complete: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * Remux a raw MPEG-TS file (concatenated HLS segments) into a real MP4 container.
 * Uses ffmpeg with stream copy (no re-encoding => fast, lossless), and converts
 * HE-AAC to AAC via the aac_adtstoasc bitstream filter when needed.
 */
async function remuxTsToMp4(input, output) {
    const run = (args) => new Promise((resolve, reject) => {
        let stderr = '';
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => reject(new Error(`ffmpeg not available: ${err.message}`)));
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-300))));
    });

    const withBsf = ['-y', '-i', input, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', output];
    const plain = ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output];

    try {
        await run(withBsf);
    } catch (err) {
        console.log(`[FFMPEG] aac_adtstoasc failed (${String(err.message).split('\n')[0]}), retrying without bitstream filter...`);
        await run(plain);
    }
    console.log(`[FFMPEG] Remuxed ${input} -> ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
}



/**
 * Resolves TMDB ID via TMDB Search API or fallback hash
 */
async function resolveTmdbId(title, year) {
    const apiKey = process.env.TMDB_API_KEY || CONFIG.tmdbApiKey;
    if (apiKey && title) {
        try {
            const cleanTitle = title.replace(/فيلم|مترجم|اون|لاين|مشاهدة|تحميل/gi, '').trim();
            const res = await axios.get('https://api.themoviedb.org/3/search/movie', {
                params: { api_key: apiKey, query: cleanTitle, year: year }
            });
            if (res.data && res.data.results && res.data.results.length > 0) {
                return res.data.results[0].id;
            }
        } catch (e) {
            console.log('[TMDB] Search API notice:', e.message);
        }
    }

    // Deterministic hash fallback for numeric TMDB ID representation
    let hash = 0;
    const str = title || 'movie';
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

/**
 * Recursively dig for the first matching key in a (possibly nested) API response.
 */
function digFor(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    for (const key of keys) {
        if (obj[key] && typeof obj[key] === 'string') return obj[key];
    }
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const v = digFor(item, keys, depth + 1);
            if (v) return v;
        }
        return null;
    }
    for (const key of Object.keys(obj)) {
        const v = digFor(obj[key], keys, depth + 1);
        if (v) return v;
    }
    return null;
}

/**
 * Remote URL upload: the host fetches and converts the m3u8 itself.
 * No local download, no file upload, no conversion errors on our side.
 */
async function uploadRemoteToHost(hostName, hostConfig, m3u8Url) {
    const api = hostConfig.api;
    const params = { key: hostConfig.key, url: m3u8Url };
    if (hostConfig.type === 'clickn') params.fld_id = 0;

    try {
        console.log(`[UPLOAD] Remote upload to ${hostName}...`);
        const res = await axios.get(`${api}/upload/url`, { params, timeout: 90000 });
        const data = res.data;

        const fileCode = digFor(data, ['filecode', 'file_code']);
        if (!fileCode) {
            return { error: `No filecode returned`, raw: JSON.stringify(data).slice(0, 200) };
        }

        const embedUrl = digFor(data, ['embed_url', 'embedurl', 'url']);
        console.log(`[UPLOAD] ${hostName} accepted -> filecode ${fileCode}`);

        // Best-effort: quick poll for the file to be ready (~10s max)
        let info = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
                const pollRes = await axios.get(`${api}/file/info`, {
                    params: { key: hostConfig.key, file_code: fileCode },
                    timeout: 15000
                });
                const found = pollRes.data;
                const dl = digFor(found, ['download_url', 'link']);
                if (dl) { info = { download_url: dl, embed_url: digFor(found, ['embed_url', 'embedurl']) }; break; }
            } catch (e) { /* not ready yet */ }
        }

        console.log(`[UPLOAD] Success on ${hostName} (remote)`);
        return {
            success: true,
            filecode: fileCode,
            embed_url: (info && info.embed_url) || embedUrl,
            download_url: (info && info.download_url) || null,
            polled: !!info
        };
    } catch (error) {
        console.error(`[UPLOAD ERROR] Failed remote upload on ${hostName}:`, error.message);
        return { error: error.message };
    }
}

/**
 * Local file upload (used only for hosts without remote upload, e.g. mixdrop).
 */
async function uploadFileToHost(hostName, hostConfig, filePath) {
    const form = new FormData();
    let uploadUrl = '';
    let fileField = 'file';

    try {
        if (hostConfig.type === 'xfs' || hostConfig.type === 'dood') {
            const serverRes = await axios.get(`${hostConfig.api}/upload/server`, {
                params: { key: hostConfig.key }
            });
            if (serverRes.data && typeof serverRes.data.result === 'string' && serverRes.data.result.length > 0) {
                uploadUrl = serverRes.data.result;
            } else {
                throw new Error(`Failed to retrieve upload server URL. Raw response: ${JSON.stringify(serverRes.data).slice(0, 200)}`);
            }
            form.append('key', hostConfig.key);
        } else if (hostConfig.type === 'vinovo') {
            const serverRes = await axios.get(`${hostConfig.api}/upload/server`, {
                params: { key: hostConfig.key }
            });
            if (serverRes.data && typeof serverRes.data.result === 'string' && serverRes.data.result.length > 0) {
                uploadUrl = serverRes.data.result;
            } else {
                throw new Error(`Failed to retrieve Vinovo upload server URL. Raw response: ${JSON.stringify(serverRes.data).slice(0, 200)}`);
            }
            form.append('api_key', hostConfig.key);
        } else if (hostConfig.type === 'clickn') {
            const serverRes = await axios.get(`${hostConfig.api}/upload/server`, {
                params: { key: hostConfig.key }
            });
            const url = serverRes.data && (serverRes.data.upload_url || serverRes.data.result);
            const sessId = serverRes.data && serverRes.data.sess_id;
            if (!url || typeof url !== 'string' || url.length === 0 || !sessId) {
                throw new Error(`Failed to retrieve Clicknupload upload URL. Raw response: ${JSON.stringify(serverRes.data).slice(0, 200)}`);
            }
            uploadUrl = url;
            form.append('sess_id', sessId);
            form.append('utype', 'prem');
            fileField = 'file_0';
        } else if (hostConfig.type === 'mixdrop') {
            uploadUrl = hostConfig.api;
            form.append('email', hostConfig.email);
            form.append('key', hostConfig.key);
        }

        form.append(fileField, fs.createReadStream(filePath), { filename: path.basename(filePath) });

        console.log(`[UPLOAD] Starting file upload to ${hostName}...`);
        let lastError = null;
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const uploadRes = await axios.post(uploadUrl, form, {
                    headers: form.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 3600000
                });
                console.log(`[UPLOAD] Success on ${hostName}:`, uploadRes.data);
                return uploadRes.data;
            } catch (e) {
                lastError = e;
                if (attempt < maxAttempts) {
                    console.log(`[UPLOAD] ${hostName} attempt ${attempt} failed (${e.message}), retrying...`);
                    await new Promise(r => setTimeout(r, 15000 * attempt));
                }
            }
        }
        console.error(`[UPLOAD ERROR] Failed on ${hostName}:`, lastError.message);
        return { error: lastError.message };
    } catch (error) {
        console.error(`[UPLOAD ERROR] Failed on ${hostName}:`, error.message);
        return { error: error.message };
    }
}

/**
 * Scrapes Topcinemaa for up to 3 NEW movie URLs using state pagination tracking
 */
async function scrapeTopcinemaaMovies(state) {
    const baseUrl = process.env.TARGET_BASE_URL || 'https://topcinemaa.co/';
    const baseClean = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

    console.log(`[SCRAPE] Launching stealth browser to fetch movies. Current page: ${state.currentPage}...`);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const newMovies = [];
    let pageNum = state.currentPage;
    const maxPageAttempts = pageNum + 5;

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        const limit = parseInt(process.env.BATCH_SIZE || '1', 10);
        console.log(`[SCRAPE] Target batch size: ${limit} movie(s) per run.`);

        while (newMovies.length < limit && pageNum <= maxPageAttempts) {
            const pageUrl = pageNum === 1
                ? `${baseClean}/movies/`
                : `${baseClean}/movies/page/${pageNum}/`;

            console.log(`[SCRAPE] Scanning Page ${pageNum}: ${pageUrl}`);

            const loaded = await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 }).then(() => true).catch(() => false);
            if (!loaded) {
                console.log(`[SCRAPE] Page ${pageNum} failed to load, stopping page scan.`);
                break;
            }

            const foundLinks = await page.evaluate(() => {
                const links = [];
                const selectors = [
                    'div.Block--Item a',
                    'div.Small--Box a',
                    '.box-item a',
                    'article a',
                    '.items .item a',
                    '.movies-list .movie-item a'
                ];

                document.querySelectorAll(selectors.join(', ')).forEach(a => {
                    const href = a.href;
                    if (!href) return;

                    const decodedHref = decodeURIComponent(href);
                    const isExclude = ['/page/', '/category/', '/genre/', '/series/'].some(ex => href.includes(ex));
                    const isMovie = href.includes('/movie/') || href.includes('/film/') || decodedHref.includes('/فيلم-');

                    if (isMovie && !isExclude && !links.includes(href)) {
                        links.push(href);
                    }
                });

                return links;
            });

            console.log(`[SCRAPE] Page ${pageNum} yielded ${foundLinks.length} total movie candidate links.`);

            let addedFromThisPage = 0;
            for (const link of foundLinks) {
                const canon = canonicalUrl(link);
                if (!state.processedMovies.includes(canon) && !newMovies.includes(canon)) {
                    newMovies.push(canon);
                    addedFromThisPage++;
                    if (newMovies.length === limit) break;
                }
            }

            console.log(`[SCRAPE] Added ${addedFromThisPage} NEW unprocessed movies from Page ${pageNum}.`);

            if (addedFromThisPage > 0 || foundLinks.length > 0) {
                state.currentPage = pageNum;
            }

            pageNum++;
        }

        console.log(`[SCRAPE] Total NEW movies ready to process: ${newMovies.length}`);
        return newMovies;
    } finally {
        await browser.close();
    }
}

/**
 * Navigates to a movie URL and extracts StreamWish HLS (.m3u8) stream and Title metadata
 */
async function extractMovieMetadataAndStream(movieUrl) {
    console.log(`[DECODE] Extracting stream & metadata from: ${movieUrl}`);
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        let streamUrl = null;

        page.on('response', (response) => {
            const url = response.url();
            const contentType = (response.headers()['content-type'] || '').toLowerCase();

            if (url.includes('.m3u8') || url.includes('master.txt') || contentType.includes('mpegurl') || contentType.includes('m3u8')) {
                if (!streamUrl) {
                    streamUrl = url;
                    console.log(`[INTERCEPTED HLS] ${url}`);
                }
            }
        });

        await page.goto(movieUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => { });

        // Extract title & year. Prefer the URL slug (reliable) over the h1,
        // because the first h1 on the page is often the site header, not the movie.
        const titleFromSlug = (url) => {
            try {
                const decoded = decodeURIComponent(url);
                const last = decoded.split('/').filter(Boolean).pop() || decoded;
                let t = last.replace(/فيلم|مترجم|اون|لاين|مشاهدة|تحميل/gi, ' ');
                t = t.replace(/[-_]+/g, ' ').replace(/\d{4}\b/g, '').trim();
                if (t && t.length >= 2) return t;
            } catch (e) { }
            return '';
        };

        const slugTitle = titleFromSlug(movieUrl);
        const titleData = await page.evaluate(() => {
            const pick = (...selectors) => {
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        const t = (el.innerText || '').trim();
                        if (t) return t;
                    }
                }
                return '';
            };
            let text = pick('h1.post-title', '.post-title', '.MasterSingleMeta h1', '.Single-Beta h1', 'article h1');
            if (!text) {
                // Fallback: longest heading on the page (typical movie title is the longest)
                let best = '';
                document.querySelectorAll('h1, h2').forEach(h => {
                    const t = (h.innerText || '').trim();
                    if (t.length > best.length) best = t;
                });
                text = best;
            }
            const yearMatch = text.match(/\b(19\d\d|20\d\d)\b/);
            return {
                title: text || 'Unknown Movie',
                year: yearMatch ? yearMatch[1] : null
            };
        });

        // Use the slug when the h1 is missing or just the site brand header
        if (!titleData.title || titleData.title.length < 3 || /توب سينما|topcinema|cinemaa/i.test(titleData.title)) {
            titleData.title = slugTitle || titleData.title;
        }

        const watchUrl = await page.evaluate(() => {
            const a = document.querySelector('a.watch, a[href*="/watch/"]');
            return a ? a.href : null;
        });

        let currentWatchPage = movieUrl;
        if (watchUrl) {
            console.log(`[DECODE] Navigating to watch page: ${watchUrl}`);
            currentWatchPage = watchUrl;
            await page.goto(watchUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => { });
        }

        const serverItems = await page.evaluate(() => {
            const items = [];
            const elements = document.querySelectorAll('.watch--servers--list ul li, .servers-list li, li[data-id][data-server]');
            elements.forEach(el => {
                items.push({
                    text: el.innerText || '',
                    id: el.getAttribute('data-id'),
                    server: el.getAttribute('data-server')
                });
            });
            return items;
        });

        let streamWishIframeSrc = null;

        for (const s of serverItems) {
            if (!s.id || !s.server) continue;

            try {
                const formData = new URLSearchParams();
                formData.append('id', s.id);
                formData.append('i', s.server);

                const ajaxRes = await axios.post('https://topcinemaa.co/wp-content/themes/movies2023/Ajaxat/Single/Server.php', formData, {
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': currentWatchPage,
                        'Origin': 'https://topcinemaa.co',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 10000
                });

                if (ajaxRes.data && typeof ajaxRes.data === 'string') {
                    const match = ajaxRes.data.match(/<iframe[^>]+src=["']([^"']+)["']/i);
                    if (match && match[1]) {
                        const iframeSrc = match[1];
                        if (iframeSrc.includes('streamwish') || iframeSrc.includes('strwish') || s.text.toLowerCase().includes('wish')) {
                            streamWishIframeSrc = iframeSrc;
                            break;
                        } else if (!streamWishIframeSrc) {
                            streamWishIframeSrc = iframeSrc;
                        }
                    }
                }
            } catch (err) {
                console.log(`[DECODE] AJAX server error:`, err.message);
            }
        }

        if (streamWishIframeSrc) {
            console.log(`[DECODE] Navigating Puppeteer to iframe: ${streamWishIframeSrc}`);
            await page.goto(streamWishIframeSrc, { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => { });

            await page.evaluate(() => {
                const v = document.querySelector('video');
                if (v) {
                    v.muted = true;
                    v.play().catch(() => { });
                }
            }).catch(() => { });
        }

        await new Promise(resolve => setTimeout(resolve, 6000));
        return {
            hlsUrl: streamUrl,
            iframeUrl: streamWishIframeSrc,
            title: titleData.title,
            year: titleData.year
        };
    } finally {
        await browser.close();
    }
}

/**
 * Main execution pipeline
 */
async function main() {
    const state = loadState();
    console.log(`[MAIN] Loaded state - Current Page: ${state.currentPage}, Processed Movies count: ${state.processedMovies.length}`);

    const movieUrls = await scrapeTopcinemaaMovies(state);
    if (movieUrls.length === 0) {
        console.log('[MAIN] No new unprocessed movies found today.');
        saveState(state);
        fs.writeFileSync('result.json', JSON.stringify([], null, 2));
        return;
    }

    const allResults = [];

    for (let i = 0; i < movieUrls.length; i++) {
        const movieUrl = movieUrls[i];
        console.log(`\n--- Processing Movie ${i + 1} of ${movieUrls.length}: ${movieUrl} ---`);

        const metadata = await extractMovieMetadataAndStream(movieUrl);
        const hlsUrl = metadata.hlsUrl;

        if (!hlsUrl) {
            console.error(`[ERROR] Could not extract m3u8 stream for ${movieUrl}`);
            continue;
        }
        console.log(`[HLS] Extracted stream URL: ${hlsUrl}`);

        // Resolve TMDB ID and check the database BEFORE downloading/uploading,
        // so an already-uploaded movie is never downloaded or uploaded again.
        const tmdbId = await resolveTmdbId(metadata.title, metadata.year);
        console.log(`[TMDB] Resolved TMDB ID: ${tmdbId} for "${metadata.title}"`);

        const alreadySaved = await movieExists({ tmdbId, title: metadata.title });
        if (alreadySaved) {
            console.log(`[SKIP] "${metadata.title}" already exists in database, skipping download & upload.`);
            if (!state.processedMovies.includes(movieUrl)) {
                state.processedMovies.push(movieUrl);
            }
            saveState(state);
            continue;
        }

        // Decide which hosts need a local file (no remote upload API) vs remote URL upload
        const activeHosts = Object.entries(CONFIG.hosts).filter(([, h]) => h.enabled !== false);
        const hostsWithLocalUpload = activeHosts.filter(([, h]) => h.remote !== true);
        const needsLocalFile = hostsWithLocalUpload.length > 0;

        const safeTitle = (metadata.title || `output_${i}`).replace(/[^a-zA-Z0-9\u0600-\u06FF\s-]/g, '').trim().replace(/\s+/g, '_');
        const rawTs = `${safeTitle}.ts`;
        const outputVideo = `${safeTitle}.mp4`;
        let localVideoReady = false;

        if (needsLocalFile) {
            console.log('[HLS-DL] Downloading stream via Node.js HLS downloader (needed for local hosts)...');
            try {
                await downloadHlsToFile(hlsUrl, metadata.iframeUrl, rawTs);
                await remuxTsToMp4(rawTs, outputVideo);
                localVideoReady = true;
            } catch (err) {
                console.error('[LOCAL-DL ERROR] Local download/remux failed (remote hosts still run):', err.message);
            } finally {
                if (fs.existsSync(rawTs)) fs.unlinkSync(rawTs);
            }
        }

        const movieUploadResults = {};
        await Promise.all(activeHosts.map(async ([hostName, hostConfig]) => {
            if (hostConfig.remote === true) {
                movieUploadResults[hostName] = await uploadRemoteToHost(hostName, hostConfig, hlsUrl);
            } else {
                if (localVideoReady && fs.existsSync(outputVideo)) {
                    movieUploadResults[hostName] = await uploadFileToHost(hostName, hostConfig, outputVideo);
                } else {
                    movieUploadResults[hostName] = { error: 'Skipped: local file not available (download/remux failed)' };
                }
            }
        }));

        // Save to Turso Sharded Databases
        await saveMovieRecord({
            tmdbId: tmdbId,
            title: metadata.title,
            movieUrl: movieUrl,
            hlsUrl: hlsUrl,
            uploads: movieUploadResults
        });

        if (!state.processedMovies.includes(movieUrl)) {
            state.processedMovies.push(movieUrl);
        }

        allResults.push({
            tmdbId,
            title: metadata.title,
            movieUrl,
            hlsUrl,
            uploads: movieUploadResults
        });

        for (const f of [rawTs, outputVideo]) {
            if (fs.existsSync(f)) {
                fs.unlinkSync(f);
                console.log(`[CLEANUP] Deleted local file ${f}`);
            }
        }

        saveState(state);
    }

    fs.writeFileSync('result.json', JSON.stringify(allResults, null, 2));
    console.log('\n[DONE] All tasks completed successfully. Updated state, Turso DBs, and saved result.json.');
}

main().catch(console.error);
