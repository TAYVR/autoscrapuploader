const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { saveMovieRecord } = require('./turso');

puppeteer.use(StealthPlugin());

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const STATE_PATH = path.join(__dirname, 'state.json');

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
 * Helper to run shell commands (FFmpeg) with progress logging
 */
function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);
        proc.stderr.on('data', (data) => {
            const output = data.toString();
            if (output.includes('time=')) {
                const match = output.match(/time=\S+/);
                if (match) process.stdout.write(`\r[FFMPEG PROGRESS]: ${match[0]}`);
            }
        });
        proc.on('close', (code) => {
            console.log('');
            if (code === 0) resolve();
            else reject(new Error(`Process exited with code ${code}`));
        });
    });
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
 * Upload a local file to a video hosting platform
 */
async function uploadToHost(hostName, hostConfig, filePath) {
    const form = new FormData();
    let uploadUrl = '';

    try {
        if (hostConfig.type === 'xfs' || hostConfig.type === 'clickn' || hostConfig.type === 'vinovo') {
            const serverRes = await axios.get(`${hostConfig.api}/upload/server`, {
                params: { key: hostConfig.key }
            });
            if (serverRes.data && serverRes.data.result) {
                uploadUrl = serverRes.data.result;
            } else {
                throw new Error('Failed to retrieve upload server URL');
            }
            form.append('key', hostConfig.key);
        } else if (hostConfig.type === 'dood') {
            const serverRes = await axios.get(`${hostConfig.api}/upload/to`, {
                params: { key: hostConfig.key }
            });
            if (serverRes.data && serverRes.data.result) {
                uploadUrl = serverRes.data.result;
            } else {
                throw new Error('Failed to retrieve Doodstream upload URL');
            }
            form.append('key', hostConfig.key);
        } else if (hostConfig.type === 'mixdrop') {
            uploadUrl = `${hostConfig.api}/upload`;
            form.append('email', hostConfig.email);
            form.append('key', hostConfig.key);
        }

        form.append('file', fs.createReadStream(filePath));

        console.log(`[UPLOAD] Starting upload to ${hostName}...`);
        const uploadRes = await axios.post(uploadUrl, form, {
            headers: form.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 3600000
        });

        console.log(`[UPLOAD] Success on ${hostName}:`, uploadRes.data);
        return uploadRes.data;
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
                if (!state.processedMovies.includes(link) && !newMovies.includes(link)) {
                    newMovies.push(link);
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

        // Extract title & year
        const titleData = await page.evaluate(() => {
            const h1 = document.querySelector('h1.post-title, .MasterSingleMeta h1, h1');
            const text = h1 ? h1.innerText.trim() : '';
            const yearMatch = text.match(/\b(19\d\d|20\d\d)\b/);
            return {
                title: text || 'Unknown Movie',
                year: yearMatch ? yearMatch[1] : null
            };
        });

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

        const outputVideo = `output_${i}.mp4`;
        console.log('[FFMPEG] Downloading and converting stream to local MP4...');

        // Use the StreamWish iframe URL as Referer so the CDN authorizes the request
        const refererUrl = metadata.iframeUrl || movieUrl;
        const swOrigin = refererUrl ? new URL(refererUrl).origin : 'https://streamwish.fun';

        try {
            const ffmpegArgs = [
                '-y',
                '-headers', `Referer: ${refererUrl}\r\nOrigin: ${swOrigin}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n`,
                '-i', hlsUrl,
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                outputVideo
            ];
            await runCommand('ffmpeg', ffmpegArgs);
        } catch (err) {
            console.error('[FFMPEG ERROR] Conversion failed:', err.message);
            continue;
        }

        const movieUploadResults = {};
        for (const [hostName, hostConfig] of Object.entries(CONFIG.hosts)) {
            const res = await uploadToHost(hostName, hostConfig, outputVideo);
            movieUploadResults[hostName] = res;
        }

        // Resolve TMDB ID for database indexing
        const tmdbId = await resolveTmdbId(metadata.title, metadata.year);
        console.log(`[TMDB] Resolved TMDB ID: ${tmdbId} for "${metadata.title}"`);

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

        if (fs.existsSync(outputVideo)) {
            fs.unlinkSync(outputVideo);
            console.log(`[CLEANUP] Deleted local file ${outputVideo}`);
        }

        saveState(state);
    }

    fs.writeFileSync('result.json', JSON.stringify(allResults, null, 2));
    console.log('\n[DONE] All tasks completed successfully. Updated state, Turso DBs, and saved result.json.');
}

main().catch(console.error);
