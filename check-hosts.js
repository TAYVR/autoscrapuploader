const { db2Client, db3Client } = require('./turso');

async function analyze() {
    const hosts = {};
    let totalMovies = 0;

    for (const [name, client] of [['db2', db2Client], ['db3', db3Client]]) {
        const res = await client.execute(`SELECT tmdb_id, title, hosts_json FROM movie_data;`);
        if (!res || !res.rows) continue;
        for (const row of res.rows) {
            totalMovies++;
            let uploads = {};
            try { uploads = JSON.parse(row.hosts_json || '{}'); } catch (e) { uploads = {}; }
            for (const [host, val] of Object.entries(uploads)) {
                if (!hosts[host]) hosts[host] = { success: 0, failed: 0, errors: {} };
                const ok = isSuccess(host, val);
                if (ok) hosts[host].success++;
                else {
                    hosts[host].failed++;
                    const msg = extractError(host, val);
                    hosts[host].errors[msg] = (hosts[host].errors[msg] || 0) + 1;
                }
            }
        }
    }

    console.log(`\n=== TOTAL MOVIES SAVED: ${totalMovies} ===\n`);
    console.log('=== HOST STATUS ===');
    for (const [host, h] of Object.entries(hosts)) {
        const status = h.failed === 0 ? '✅ WORKING' : (h.success === 0 ? '❌ FAILING' : '⚠️ PARTIAL');
        console.log(`\n[${host}] ${status}  (ok=${h.success}, fail=${h.failed})`);
        if (h.failed > 0) {
            for (const [err, count] of Object.entries(h.errors)) {
                console.log(`    ✗ ${count}x: ${err}`);
            }
        }
    }
}

function isSuccess(host, val) {
    if (!val) return false;
    if (val.error) return false;
    if (val.success === true) return true;
    if (val.filecode || val.file_code || val.fileref) return true;
    if (val.msg && String(val.msg).toLowerCase().includes('not allowed')) return false;
    if (val.msg && String(val.msg).toLowerCase().includes('error')) return false;
    if (typeof val.status === 'number' && val.status >= 400) return false;
    if (host === 'mixdrop' && val.result && val.result.fileref) return true;
    if (val.result && val.result.filecode) return true;
    if (Array.isArray(val.files)) {
        return val.files.some(f => f && f.filecode && f.filecode !== '');
    }
    if (Array.isArray(val.result)) {
        return val.result.some(f => f && f.filecode);
    }
    return false;
}

function extractError(host, val) {
    if (val && val.error) return val.error;
    if (val && val.msg) return val.msg;
    return JSON.stringify(val).slice(0, 150);
}

analyze().catch(e => { console.error('ERROR:', e.message); process.exit(1); });