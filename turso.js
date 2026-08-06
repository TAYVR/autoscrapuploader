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

        // Migrate each database to the append-only schema (every save = new row)
        const shards = [
            ['db1', db1Client],
            ['db2', db2Client],
            ['db3', db3Client]
        ];

        for (const [name, client] of shards) {
            await client.execute(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, version INTEGER);`);
            const meta = await client.execute(`SELECT version FROM schema_meta WHERE key = 'schema';`);
            const current = (meta && meta.rows && meta.rows.length) ? Number(meta.rows[0].version) : 0;

            if (current < 1) {
                if (name === 'db1') {
                    await client.execute(`DROP TABLE IF EXISTS movie_index;`);
                    await client.execute(`
                        CREATE TABLE IF NOT EXISTS movie_index (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            tmdb_id INTEGER,
                            title TEXT,
                            target_db TEXT,
                            created_at TEXT
                        );
                    `);
                } else {
                    await client.execute(`DROP TABLE IF EXISTS movie_data;`);
                    await client.execute(`
                        CREATE TABLE IF NOT EXISTS movie_data (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            tmdb_id INTEGER,
                            title TEXT,
                            movie_url TEXT,
                            hls_url TEXT,
                            hosts_json TEXT,
                            created_at TEXT
                        );
                    `);
                }
                await client.execute(`INSERT OR REPLACE INTO schema_meta (key, version) VALUES ('schema', 1);`);
                console.log(`[TURSO] ${name}: migrated to append-only schema (v1).`);
            }
        }

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

        // 1. Append a new row to the Index in DB1 (never overwrite)
        await db1Client.execute({
            sql: `INSERT INTO movie_index (tmdb_id, title, target_db, created_at) VALUES (?, ?, ?, ?)`,
            args: [tmdbId, title || 'Unknown', targetDbName, createdAt]
        });

        // 2. Append a new row to the Data Shard (DB2 or DB3) (never overwrite)
        await targetClient.execute({
            sql: `INSERT INTO movie_data (tmdb_id, title, movie_url, hls_url, hosts_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [tmdbId, title || 'Unknown', movieUrl, hlsUrl, hostsJson, createdAt]
        });

        console.log(`[TURSO SUCCESS] Saved TMDB ID ${tmdbId} ("${title}") -> Index (DB1) & Data Shard (${targetDbName.toUpperCase()})`);
        return { tmdbId, targetDb: targetDbName };
    } catch (error) {
        console.error(`[TURSO ERROR] Failed to save TMDB ID ${tmdbId}:`, error.message);
    }
}

/**
 * Checks whether a movie was already uploaded/saved before (dedup guard).
 * Matches on the deterministic TMDB-ID hash OR the normalized title in the index.
 */
async function movieExists({ tmdbId, title }) {
    try {
        await initTables();
        const norm = (title || '').toString().toLowerCase().trim();
        const res = await db1Client.execute({
            sql: `SELECT COUNT(*) AS count FROM movie_index WHERE tmdb_id = ? OR lower(title) = ?`,
            args: [tmdbId, norm]
        });
        const count = (res && res.rows && res.rows.length) ? Number(res.rows[0].count) : 0;
        return count > 0;
    } catch (error) {
        console.error('[TURSO ERROR] movieExists check failed:', error.message);
        return false;
    }
}

module.exports = {
    db1Client,
    db2Client,
    db3Client,
    initTables,
    saveMovieRecord,
    movieExists
};
