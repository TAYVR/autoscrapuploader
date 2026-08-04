const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const dbConfig = CONFIG.databases;

// Initialize clients for the 3 Turso databases
const db1Client = createClient({
    url: dbConfig.db1_index.url,
    authToken: dbConfig.db1_index.authToken
});

const db2Client = createClient({
    url: dbConfig.db2_data.url,
    authToken: dbConfig.db2_data.authToken
});

const db3Client = createClient({
    url: dbConfig.db3_data.url,
    authToken: dbConfig.db3_data.authToken
});

/**
 * Initializes database tables if they do not exist
 */
async function initTables() {
    try {
        console.log('[TURSO] Initializing tables across sharded databases...');

        // Database 1: Index Table
        await db1Client.execute(`
            CREATE TABLE IF NOT EXISTS movie_index (
                tmdb_id INTEGER PRIMARY KEY,
                title TEXT,
                target_db TEXT,
                created_at TEXT
            );
        `);

        // Database 2: Data Shard 1
        await db2Client.execute(`
            CREATE TABLE IF NOT EXISTS movie_data (
                tmdb_id INTEGER PRIMARY KEY,
                title TEXT,
                movie_url TEXT,
                hls_url TEXT,
                hosts_json TEXT,
                created_at TEXT
            );
        `);

        // Database 3: Data Shard 2
        await db3Client.execute(`
            CREATE TABLE IF NOT EXISTS movie_data (
                tmdb_id INTEGER PRIMARY KEY,
                title TEXT,
                movie_url TEXT,
                hls_url TEXT,
                hosts_json TEXT,
                created_at TEXT
            );
        `);

        console.log('[TURSO] All database tables successfully initialized.');
    } catch (error) {
        console.error('[TURSO ERROR] Error initializing tables:', error.message);
    }
}

/**
 * Saves movie metadata and host iframe/download links into Turso databases
 * DB1: Index router (tmdb_id -> target_db)
 * DB2 / DB3: Sharded host data
 */
async function saveMovieRecord({ tmdbId, title, movieUrl, hlsUrl, uploads }) {
    if (!tmdbId) {
        console.error('[TURSO ERROR] Cannot save record: Missing tmdbId.');
        return;
    }

    try {
        await initTables();

        const createdAt = new Date().toISOString();
        // Determine target shard based on TMDB ID (even -> db2, odd -> db3)
        const targetDbName = (tmdbId % 2 === 0) ? 'db2' : 'db3';
        const targetClient = (targetDbName === 'db2') ? db2Client : db3Client;

        const hostsJson = JSON.stringify(uploads);

        // 1. Insert/Update Index in DB1
        await db1Client.execute({
            sql: `INSERT OR REPLACE INTO movie_index (tmdb_id, title, target_db, created_at) VALUES (?, ?, ?, ?)`,
            args: [tmdbId, title || 'Unknown', targetDbName, createdAt]
        });

        // 2. Insert/Update Data in Target Shard (DB2 or DB3)
        await targetClient.execute({
            sql: `INSERT OR REPLACE INTO movie_data (tmdb_id, title, movie_url, hls_url, hosts_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [tmdbId, title || 'Unknown', movieUrl, hlsUrl, hostsJson, createdAt]
        });

        console.log(`[TURSO SUCCESS] Saved TMDB ID ${tmdbId} ("${title}") -> Index (DB1) & Data Shard (${targetDbName.toUpperCase()})`);
        return { tmdbId, targetDb: targetDbName };
    } catch (error) {
        console.error(`[TURSO ERROR] Failed to save TMDB ID ${tmdbId}:`, error.message);
    }
}

module.exports = {
    db1Client,
    db2Client,
    db3Client,
    initTables,
    saveMovieRecord
};
