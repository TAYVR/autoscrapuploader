const fs = require('fs');
const path = require('path');
const { db1Client, db2Client, db3Client } = require('./turso');

const STATE_PATH = path.join(__dirname, 'state.json');

async function wipeDatabase(name, client, tables) {
    for (const table of tables) {
        try {
            await client.execute(`DROP TABLE IF EXISTS ${table};`);
            console.log(`[RESET] ${name}: dropped table "${table}".`);
        } catch (error) {
            console.error(`[RESET ERROR] ${name}: failed to drop "${table}":`, error.message);
        }
    }
}

async function resetAll() {
    console.log('[RESET] Wiping all databases and state...');

    // DB1: Index
    await wipeDatabase('db1_index', db1Client, ['movie_index', 'schema_meta']);

    // DB2: Data shard 1
    await wipeDatabase('db2_data', db2Client, ['movie_data', 'schema_meta']);

    // DB3: Data shard 2
    await wipeDatabase('db3_data', db3Client, ['movie_data', 'schema_meta']);

    // Reset state.json to start from the very first movie / page 1
    fs.writeFileSync(STATE_PATH, JSON.stringify({ currentPage: 1, processedMovies: [] }, null, 2));
    console.log('[RESET] state.json reset: page 1, no processed movies.');

    // Clear old result file
    fs.writeFileSync('result.json', JSON.stringify([], null, 2));
    console.log('[RESET] result.json emptied.');

    console.log('[RESET] Done. Next run of script.js will start from scratch (first movie).');
}

resetAll().catch(console.error);