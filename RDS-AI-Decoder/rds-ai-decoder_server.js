///////////////////////////////////////////////////////////////
//                                                           //
//  RDS AI DECODER SERVER PLUGIN FOR FM-DX-WEBSERVER (V2.1)  //
//                                                           //
//  by Highpoint                last update: 2026-03-26      //
//                                                           //
//  https://github.com/Highpoint2000/RDS-AI-Decoder          //
//                                                           //
///////////////////////////////////////////////////////////////

'use strict';

// ── Debug switch ─────────────────────────────────────────────
const DEBUG = false;

const fs         = require('fs');
const path       = require('path');
const WebSocket  = require('ws');
const pluginsApi = require('../../server/plugins_api');
const { logInfo, logWarn, logError } = require('../../server/console');

const pluginConfig = {
    name:         'RDS AI Decoder',
    version:      '2.1',
    frontEndPath: 'rds-ai-decoder.js',
};
module.exports = { pluginConfig };

const PLUGIN_NAME          = 'RDS AI Decoder';
const DB_FILE              = path.join(__dirname, 'rdsm_memory.json');
const FMDX_BULK_FILE       = path.join(__dirname, 'rdsm_fmdx_cache.json');
const DB_SAVE_INTERVAL     = 60 * 1000;
const MAX_STATIONS         = 2000;
const CONF_TABLE           = [1.00, 0.90, 0.70, 0.00];
const VOTE_HALFLIFE_DAYS   = 7;
const VOTE_EXPIRE_DAYS     = 30;
const STATION_EXPIRE_DAYS  = 90;
const QUICK_EXPIRE_DAYS    = 7;
const CONSISTENCY_BOOST    = 1.5;
const AI_BROADCAST_DELAY   = 80; // ms

const FMDX_RADIUS_KM       = 3000;
const FMDX_BULK_TTL_MS     = 6 * 60 * 60 * 1000;

const PI_CONFIRM_THRESHOLD = 2;
const GHOST_PI_THRESHOLD   = 8; // consecutive error-free groups for an unrecognised PI

// ── Special / wildcard PI codes that must never be stored or looked up ────────
// FFFF = test / wildcard, 0000 = invalid
const SPECIAL_PI_CODES = new Set(['FFFF', '0000']);
function isSpecialPI(pi) {
    return !pi || SPECIAL_PI_CODES.has(pi.toUpperCase());
}

let aiExclusiveMode    = false;
let rdsFollowMode      = false;
let nativeRDSDisabled  = false;
let pluginsWss         = null;
let pluginsMainWss     = null;
let currentFreq        = null;
let legacyPiCache      = null;
let lastBroadcastPS    = null;

let piConfirmCount     = 0;
let piConfirmed        = false;
let piPendingBroadcast = false;

// ── PS lock flag ──────────────────────────────────────────────
let psLocked = false;

let ownLat = null;
let ownLon = null;

let gpsWsClient      = null;
let gpsWsReconnTimer = null;
let gpsWsConnected   = false;  // eslint-disable-line no-unused-vars

// ── GPS WebSocket listener ────────────────────────────────────
function startGpsWsListener() {
    let wsPort = 8080;
    try {
        const cfgPath = path.join(__dirname, '../../config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            wsPort = cfg?.webserver?.webserverPort || 8080;
        }
    } catch(e) { /* ignore */ }

    const wsUrl = `ws://127.0.0.1:${wsPort}/data_plugins`;

    function connect() {
        if (gpsWsClient) {
            try { gpsWsClient.removeAllListeners(); gpsWsClient.terminate(); } catch(e) {}
            gpsWsClient = null;
        }
        const ws = new WebSocket(wsUrl);
        gpsWsClient = ws;

        ws.on('open', () => { gpsWsConnected = true; });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                if (msg.type === 'GPS' && msg.value) {
                    const lat = parseFloat(msg.value.lat);
                    const lon = parseFloat(msg.value.lon);
                    if (!isNaN(lat) && !isNaN(lon) && msg.value.status === 'active') {
                        if (lat !== ownLat || lon !== ownLon) {
                            ownLat = lat;
                            ownLon = lon;
                            if (fmdxLoadedAt > 0) {
                                try {
                                    const cached = JSON.parse(fs.readFileSync(FMDX_BULK_FILE, 'utf8'));
                                    if (cached && cached.raw) buildFmdxIndex(cached.raw);
                                } catch(e) { /* no cache yet */ }
                            }
                        }
                    }
                }
            } catch(e) { /* ignore parse errors */ }
        });

        ws.on('close', () => { gpsWsConnected = false; scheduleGpsWsReconnect(); });
        ws.on('error', () => { gpsWsConnected = false; scheduleGpsWsReconnect(); });
    }

    function scheduleGpsWsReconnect() {
        if (gpsWsReconnTimer) return;
        gpsWsReconnTimer = setTimeout(() => { gpsWsReconnTimer = null; connect(); }, 15000);
    }

    setTimeout(connect, 5000);
}

// ── Load own location from config.json ───────────────────────
function loadOwnLocation() {
    try {
        const cfgPath = path.join(__dirname, '../../config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            const lat = parseFloat(cfg?.identification?.lat);
            const lon = parseFloat(cfg?.identification?.lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                ownLat = lat;
                ownLon = lon;
                logInfo(`[${PLUGIN_NAME}] Own location: ${lat}, ${lon}`);
            } else {
                logWarn(`[${PLUGIN_NAME}] No valid lat/lon in config.json – distance filter disabled`);
            }
        }
    } catch(e) {
        logWarn(`[${PLUGIN_NAME}] Could not read config.json for location: ${e.message}`);
    }
}

// ── Haversine distance ────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
    const R  = 6371;
    const dL = (lat2 - lat1) * Math.PI / 180;
    const dO = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(dL/2) * Math.sin(dL/2)
             + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180)
             * Math.sin(dO/2) * Math.sin(dO/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

let fmdxByFreq   = {};
let fmdxLoadedAt = 0;

// ── PI → frequencies reverse index (includes pireg entries) ──
let fmdxByPI = {};

function roundFreq(freqStr) {
    if (!freqStr) return freqStr;
    const f = parseFloat(freqStr);
    if (isNaN(f)) return freqStr;
    return (Math.round(f * 10) / 10).toFixed(2);
}

function parsePSVariants(psRaw) {
    if (!psRaw || typeof psRaw !== 'string') return [];
    const tokens   = psRaw.split(' ').filter(t => t.length > 0);
    const variants = [];
    for (const token of tokens) {
        const chunk = token.slice(0, 8).padEnd(8, ' ').replace(/_/g, ' ');
        if (chunk.trim().length > 0) variants.push(chunk);
    }
    if (variants.length === 0) {
        const single = psRaw.replace(/_/g, ' ').trim().slice(0, 8).padEnd(8, ' ');
        if (single.trim().length > 0) variants.push(single);
    }
    return variants;
}

function nodeHttpGetJSON(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        const req = mod.get(url, { timeout: 20000 }, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        });
        req.on('error',   reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ── Load fmdx.org bulk data (with cache) ─────────────────────
async function loadFmdxBulk() {
    if (ownLat === null || ownLon === null) {
        logWarn(`[${PLUGIN_NAME}] fmdx.org bulk load skipped – no location in config.json`);
        return;
    }
    if (fs.existsSync(FMDX_BULK_FILE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(FMDX_BULK_FILE, 'utf8'));
            const fresh  = cached._ts && (Date.now() - cached._ts) < FMDX_BULK_TTL_MS;
            const hasRaw = cached.raw && typeof cached.raw === 'object';
            if (fresh && hasRaw) {
                fmdxLoadedAt = cached._ts;
                buildFmdxIndex(cached.raw);
                if (Object.keys(fmdxByFreq).length > 0) {
                    logInfo(`[${PLUGIN_NAME}] fmdx.org DB restored from cache`);
                    const remaining = FMDX_BULK_TTL_MS - (Date.now() - cached._ts);
                    setTimeout(downloadFmdxBulk, Math.max(remaining, 60000));
                    return;
                }
                logWarn(`[${PLUGIN_NAME}] Cache produced empty index – re-downloading`);
            }
        } catch(e) {
            logWarn(`[${PLUGIN_NAME}] Cache read error: ${e.message}`);
        }
    }
    await downloadFmdxBulk();
}

async function downloadFmdxBulk() {
    if (ownLat === null || ownLon === null) return;
    const url = `https://maps.fmdx.org/api/?qth=${ownLat},${ownLon}`;
    let raw;
    try {
        if (typeof fetch === 'function') {
            const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            raw = await res.json();
        } else {
            raw = await nodeHttpGetJSON(url);
        }
    } catch(e) {
        logWarn(`[${PLUGIN_NAME}] fmdx.org download failed: ${e.message} – retry in 10 min`);
        setTimeout(downloadFmdxBulk, 10 * 60 * 1000);
        return;
    }
    const locations = extractLocations(raw);
    const txCount   = Object.keys(locations).length;
    if (txCount === 0) {
        logWarn(`[${PLUGIN_NAME}] fmdx.org returned empty structure – retry in 10 min`);
        setTimeout(downloadFmdxBulk, 10 * 60 * 1000);
        return;
    }
    fmdxLoadedAt = Date.now();
    buildFmdxIndex(raw);
    try {
        fs.writeFileSync(FMDX_BULK_FILE, JSON.stringify({ _ts: fmdxLoadedAt, raw }), 'utf8');
        logInfo(`[${PLUGIN_NAME}] fmdx.org DB cached to disk`);
    } catch(e) {
        logWarn(`[${PLUGIN_NAME}] Could not save fmdx bulk cache: ${e.message}`);
    }
    setTimeout(downloadFmdxBulk, FMDX_BULK_TTL_MS);
}

function extractLocations(raw) {
    if (!raw || typeof raw !== 'object') return {};
    if (raw.locations && typeof raw.locations === 'object' && !Array.isArray(raw.locations))
        return raw.locations;
    const firstVal = Object.values(raw)[0];
    if (firstVal && Array.isArray(firstVal.stations)) return raw;
    return {};
}

// ── Build frequency-keyed and PI-keyed lookup from raw API response ──────────
// Each station entry stores both pi and pireg (regional PI code).
// The fmdxByPI index is populated for BOTH pi and pireg so that a
// received regional PI code resolves to the correct station.
function buildFmdxIndex(raw) {
    const byFreq     = {};
    const byPI       = {};
    let totalEntries = 0;
    let skippedDist  = 0;
    const locations  = extractLocations(raw);

    for (const [txId, txData] of Object.entries(locations)) {
        if (!txData || !Array.isArray(txData.stations)) continue;
        const txLat  = parseFloat(txData.lat);
        const txLon  = parseFloat(txData.lon);
        const txName = txData.name || txId;
        if (isNaN(txLat) || isNaN(txLon)) continue;
        const distKm = Math.round(haversineKm(ownLat, ownLon, txLat, txLon));
        if (distKm > FMDX_RADIUS_KM) { skippedDist++; continue; }

        for (const st of txData.stations) {
            if (!st.pi || !st.freq) continue;
            const f       = roundFreq(String(st.freq));
            const piUp    = st.pi.toUpperCase();
            // pireg: regional PI variant (e.g. used in Slovenia, Spain, etc.)
            const piRegUp = st.pireg ? st.pireg.toUpperCase() : null;

            const entry = {
                pi:         piUp,
                pireg:      piRegUp,        // regional PI code (may be null)
                psVariants: parsePSVariants(st.ps),
                station:    st.station || txName,
                lat:        txLat,
                lon:        txLon,
                distKm,
            };

            if (!byFreq[f]) byFreq[f] = [];
            byFreq[f].push(entry);

            // Index by primary PI
            if (!byPI[piUp]) byPI[piUp] = [];
            byPI[piUp].push({
                freq:       f,
                distKm,
                station:    entry.station,
                psVariants: entry.psVariants,
                pireg:      piRegUp,
            });

            // Also index by regional PI (pireg) if present and different from primary
            if (piRegUp && piRegUp !== piUp) {
                if (!byPI[piRegUp]) byPI[piRegUp] = [];
                byPI[piRegUp].push({
                    freq:       f,
                    distKm,
                    station:    entry.station,
                    psVariants: entry.psVariants,
                    pireg:      piRegUp,
                    piMain:     piUp,       // back-reference to the primary PI
                });
            }

            totalEntries++;
        }
    }

    for (const f of Object.keys(byFreq))
        byFreq[f].sort((a, b) => a.distKm - b.distKm);

    for (const pi of Object.keys(byPI))
        byPI[pi].sort((a, b) => a.distKm - b.distKm);

    fmdxByFreq = byFreq;
    fmdxByPI   = byPI;

    if (DEBUG) logInfo(
        `[${PLUGIN_NAME}] fmdx.org index: ${totalEntries} entries on ` +
        `${Object.keys(byFreq).length} frequencies, ` +
        `${Object.keys(byPI).length} unique PI/PIreg codes ` +
        `(${skippedDist} tx outside ${FMDX_RADIUS_KM} km)`
    );
}

// ── Look up fmdx.org reference entries for a given frequency ─
function getFreqRefs(freq) {
    const f    = roundFreq(freq);
    const refs = fmdxByFreq[f] || [];
    if (DEBUG) logInfo(`[${PLUGIN_NAME}] getFreqRefs: "${f}" → ${refs.length} entry(s)`);
    return refs;
}

// ── Look up all frequencies that carry a given PI (or PIreg) ─
function getAltFreqsForPI(pi) {
    if (!pi || pi === '----' || pi === '?') return [];
    return fmdxByPI[pi.toUpperCase()] || [];
}

// ── Look up frequencies for a PI filtered by a confirmed PS string ───────────
function getAltFreqsForPIAndPS(pi, confirmedPS) {
    const all = getAltFreqsForPI(pi);
    if (!confirmedPS || typeof confirmedPS !== 'string' || confirmedPS.trim().length === 0) {
        return all;
    }

    const normConfirmed = confirmedPS.trim().toUpperCase();

    const filtered = all.filter(item => {
        if (!item.psVariants || item.psVariants.length === 0) return false;
        return item.psVariants.some(v => {
            const normV = v.trim().toUpperCase();
            if (!normV) return false;
            if (normV === normConfirmed) return true;
            if (normConfirmed.startsWith(normV)) return true;
            if (normV.startsWith(normConfirmed)) return true;
            return false;
        });
    });

    return filtered.length > 0 ? filtered : all;
}

// ── Load datahandler ──────────────────────────────────────────
let dataHandler = null;
try { dataHandler = require('../../server/datahandler'); }
catch(e) { logWarn(`[${PLUGIN_NAME}] Could not load datahandler: ${e.message}`); }

// ── RDS character set (ETSI EN 50067) ────────────────────────
const RDS_CHARSET = [
    ' ','!','"','#','¤','%','&',"'",
    '(',')', '*','+',',','-','.','/',
    '0','1','2','3','4','5','6','7',
    '8','9',':',';','<','=','>','?',
    '@','A','B','C','D','E','F','G',
    'H','I','J','K','L','M','N','O',
    'P','Q','R','S','T','U','V','W',
    'X','Y','Z','[','\\',']','―','_',
    '‖','a','b','c','d','e','f','g',
    'h','i','j','k','l','m','n','o',
    'p','q','r','s','t','u','v','w',
    'x','y','z','{','|','}','¯',' ',
    'á','à','é','è','í','ì','ó','ò',
    'ú','ù','Ñ','Ç','Ş','β','¡','Ĳ',
    'â','ä','ê','ë','î','ï','ô','ö',
    'û','ü','ñ','ç','ş','ǧ','ı','ĳ',
    'ª','α','©','‰','Ǧ','ě','ň','ő',
    'π','€','£','$','←','↑','→','↓',
    'º','¹','²','³','±','İ','ń','ű',
    'µ','¿','÷','°','¼','½','¾','§',
    'Á','À','É','È','Í','Ì','Ó','Ò',
    'Ú','Ù','Ř','Č','Š','Ž','Ð','Ŀ',
    'Â','Ä','Ê','Ë','Î','Ï','Ô','Ö',
    'Û','Ü','ř','č','š','ž','đ','ŀ',
    'Ã','Å','Æ','Œ','ŷ','Ý','Õ','Ø',
    'Þ','Ŋ','Ŕ','Ć','Ś','Ź','Ŧ','ð',
    'ã','å','æ','œ','ŵ','ý','õ','ø',
    'þ','ŋ','ŕ','ć','ś','ź','ŧ',' ',
];

function rdsChar(b) {
    if (b === 0x0D) return '\r';
    if (b < 0x20)  return ' ';
    return RDS_CHARSET[b - 0x20] || ' ';
}

function decodeAFCode(code) {
    if (code >= 1 && code <= 204) return (code + 875) / 10;
    return null;
}

// ── RDS country / ECC lookup ──────────────────────────────────
const RDS_COUNTRY = (() => {
    const T = {
        0xE0: { 0x1:'DE', 0x2:'DZ', 0x3:'AD', 0x4:'IL', 0x5:'IT',
                0x6:'BE', 0x7:'RU', 0x8:'PS', 0x9:'AL', 0xA:'AT',
                0xB:'HU', 0xC:'MT', 0xD:'DE', 0xE:'GE', 0xF:'IT' },
        0xE1: { 0x1:'GR', 0x2:'CY', 0x3:'SM', 0x4:'CH', 0x5:'JO',
                0x6:'FI', 0x7:'LU', 0x8:'BG', 0x9:'DK', 0xA:'GI',
                0xB:'IQ', 0xC:'GB', 0xD:'LY', 0xE:'RO', 0xF:'FR' },
        0xE2: { 0x1:'MA', 0x2:'CZ', 0x3:'PL', 0x4:'VA', 0x5:'SK',
                0x6:'SY', 0x7:'TN', 0x9:'LI', 0xA:'IS',
                0xB:'MC', 0xC:'LT', 0xD:'RS', 0xE:'ES', 0xF:'NO' },
        0xE3: { 0x1:'IE', 0x2:'TR', 0x3:'MK', 0x4:'TJ',
                0x6:'SE', 0x7:'BY', 0x8:'MN', 0x9:'MD', 0xA:'EE',
                0xB:'KG', 0xD:'UA', 0xF:'PT' },
        0xE4: { 0x1:'NL', 0x2:'LV', 0x3:'LB', 0x4:'AZ', 0x5:'HR',
                0x6:'KZ', 0x7:'SE', 0x8:'UZ', 0x9:'AM',
                0xB:'BA', 0xC:'TM', 0xF:'SI' },
    };
    const NAMES = {
        'DE':'Germany',       'DZ':'Algeria',       'AD':'Andorra',
        'IL':'Israel',        'IT':'Italy',          'BE':'Belgium',
        'RU':'Russia',        'PS':'Palestine',      'AL':'Albania',
        'AT':'Austria',       'HU':'Hungary',        'MT':'Malta',
        'GE':'Georgia',       'GR':'Greece',         'CY':'Cyprus',
        'SM':'San Marino',    'CH':'Switzerland',    'JO':'Jordan',
        'FI':'Finland',       'LU':'Luxembourg',     'BG':'Bulgaria',
        'DK':'Denmark',       'GI':'Gibraltar',      'IQ':'Iraq',
        'GB':'United Kingdom','LY':'Libya',          'RO':'Romania',
        'FR':'France',        'MA':'Morocco',        'CZ':'Czech Republic',
        'PL':'Poland',        'VA':'Vatican',        'SK':'Slovakia',
        'SY':'Syria',         'TN':'Tunisia',        'LI':'Liechtenstein',
        'IS':'Iceland',       'MC':'Monaco',         'LT':'Lithuania',
        'RS':'Serbia',        'ES':'Spain',          'NO':'Norway',
        'IE':'Ireland',       'TR':'Turkey',         'MK':'North Macedonia',
        'TJ':'Tajikistan',    'SE':'Sweden',         'BY':'Belarus',
        'MN':'Mongolia',      'MD':'Moldova',        'EE':'Estonia',
        'KG':'Kyrgyzstan',    'UA':'Ukraine',        'PT':'Portugal',
        'NL':'Netherlands',   'LV':'Latvia',         'LB':'Lebanon',
        'AZ':'Azerbaijan',    'HR':'Croatia',        'KZ':'Kazakhstan',
        'UZ':'Uzbekistan',    'AM':'Armenia',        'BA':'Bosnia',
        'TM':'Turkmenistan',  'SI':'Slovenia',
    };
    return { T, NAMES };
})();

function lookupCountry(pi, eccByte) {
    if (!pi || pi === '?' || pi === '----') return null;
    if (!eccByte || eccByte === 0) return null;
    const piNibble = (parseInt(pi, 16) >> 12) & 0xF;
    if (piNibble === 0) return null;
    const eccMap = RDS_COUNTRY.T[eccByte];
    if (!eccMap) return null;
    const iso = eccMap[piNibble];
    if (!iso) return null;
    return { iso, name: RDS_COUNTRY.NAMES[iso] || iso };
}

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════
let db      = {};
let dbDirty = false;

const DB_VERSION = 1;

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

            if (!raw._meta || raw._meta.dbVersion !== DB_VERSION) {
                logInfo(`[${PLUGIN_NAME}] Old database structure detected – performing one-time wipe for schema update`);
                let preservedFollowMode = false;
                if (raw._meta && typeof raw._meta.rdsFollowMode === 'boolean') {
                    preservedFollowMode = raw._meta.rdsFollowMode;
                }
                rdsFollowMode     = preservedFollowMode;
                nativeRDSDisabled = preservedFollowMode;
                if (preservedFollowMode) {
                    logInfo(`[${PLUGIN_NAME}] RDS Follow state preserved across wipe: ON`);
                }
                db = { _meta: { rdsFollowMode: preservedFollowMode, dbVersion: DB_VERSION } };
                dbDirty = true;
                saveDB();
                return;
            }

            if (raw._meta && typeof raw._meta === 'object') {
                if (typeof raw._meta.rdsFollowMode === 'boolean') {
                    rdsFollowMode     = raw._meta.rdsFollowMode;
                    nativeRDSDisabled = rdsFollowMode;
                    logInfo(`[${PLUGIN_NAME}] RDS Follow restored: ${rdsFollowMode ? 'ON' : 'OFF'}`);
                }
            }
            for (const [pi, entry] of Object.entries(raw)) {
                if (pi === '_meta') continue;
                // Remove any accidentally persisted special PIs
                if (isSpecialPI(pi)) { delete raw[pi]; continue; }
                delete entry.rt;
                delete entry.rtLast;
                delete entry.psDynamicBuf;
                if (entry.ps && typeof entry.ps === 'object') {
                    for (const [pos, posData] of Object.entries(entry.ps)) {
                        if (!posData || typeof posData !== 'object') continue;
                        if (posData.votes && typeof posData.votes === 'object') {
                            const migrated = {};
                            for (const [ch, arr] of Object.entries(posData.votes)) {
                                if (!Array.isArray(arr) || arr.length === 0) continue;
                                const totalW = arr.reduce((s, e) => s + (e.w || 0), 0);
                                const times  = arr.map(e => e.ts || 0).filter(Boolean);
                                migrated[ch] = {
                                    w:         totalW,
                                    count:     arr.length,
                                    firstSeen: times.length ? Math.min(...times) : Date.now(),
                                    lastSeen:  times.length ? Math.max(...times) : Date.now(),
                                };
                            }
                            raw[pi].ps[pos] = migrated;
                        }
                    }
                }
                if (entry.freq) entry.freq = roundFreq(entry.freq);
                if (!Array.isArray(entry.af)) entry.af = [];
            }
            db = raw;
            const n = Object.keys(db).filter(k => k !== '_meta').length;
            logInfo(`[${PLUGIN_NAME}] AI memory loaded: ${n} stations`);
        } else {
            db = { _meta: { rdsFollowMode: false, dbVersion: DB_VERSION } };
            logInfo(`[${PLUGIN_NAME}] AI memory: new database created`);
        }
    } catch(e) {
        logWarn(`[${PLUGIN_NAME}] Could not load AI DB: ${e.message} – starting fresh`);
        db = { _meta: { rdsFollowMode: false, dbVersion: DB_VERSION } };
    }
}

function saveDB() {
    if (!dbDirty) return;
    try {
        const now           = Date.now();
        const expireMs      = STATION_EXPIRE_DAYS * 86400000;
        const quickExpireMs = QUICK_EXPIRE_DAYS   * 86400000;
        const toSave        = {};

        toSave._meta = { rdsFollowMode, savedAt: now, dbVersion: DB_VERSION };

        for (const [pi, entry] of Object.entries(db)) {
            if (pi === '_meta') continue;
            // Never persist special PIs
            if (isSpecialPI(pi)) continue;
            if ((now - (entry.seen || 0)) > expireMs) continue;
            const hasPS     = entry.ps && Object.keys(entry.ps).length > 0;
            const hasUseful = hasPS || entry.ecc || (entry.pty > 0) ||
                              (Array.isArray(entry.af) && entry.af.length > 0);
            if (!hasUseful && (entry.seenCount || 0) <= 2 &&
                (now - (entry.seen || 0)) > quickExpireMs) continue;
            const { psDynamicBuf, ...saveable } = entry; // eslint-disable-line no-unused-vars
            toSave[pi] = saveable;
        }
        const stationKeys = Object.keys(toSave).filter(k => k !== '_meta');
        if (stationKeys.length > MAX_STATIONS) {
            stationKeys
                .sort((a, b) => (toSave[a].seen || 0) - (toSave[b].seen || 0))
                .slice(0, stationKeys.length - MAX_STATIONS)
                .forEach(k => delete toSave[k]);
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(toSave), 'utf8');
        dbDirty = false;
    } catch(e) {
        logError(`[${PLUGIN_NAME}] Could not save AI DB: ${e.message}`);
    }
}

setInterval(saveDB, DB_SAVE_INTERVAL);
process.on('SIGINT',  () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });
process.on('exit',    () => { try { saveDB(); } catch(e) {} });

function ensurePI(pi) {
    if (!db[pi]) {
        db[pi] = {
            freq: null, ps: {},
            psResolved: null, psConf: new Array(8).fill(0),
            psIsDynamic: false,
            psLastRaw: new Array(8).fill(null), psLastRawTs: 0,
            pty: -1, tp: false, ta: false, ms: -1, stereo: false,
            ecc: null, af: [],
            seen: Date.now(), seenCount: 0,
        };
        Object.defineProperty(db[pi], 'psDynamicBuf', {
            value: [], writable: true, enumerable: false, configurable: true,
        });
    } else {
        if (!db[pi].psDynamicBuf) {
            Object.defineProperty(db[pi], 'psDynamicBuf', {
                value: [], writable: true, enumerable: false, configurable: true,
            });
        }
        if (!Array.isArray(db[pi].af)) db[pi].af = [];
    }
    return db[pi];
}

function findKnownPIForFreq(freq) {
    if (!freq) return null;
    const rounded = roundFreq(freq);
    let bestPI = null, bestScore = 0;
    for (const [pi, entry] of Object.entries(db)) {
        if (pi === '_meta') continue;
        if (isSpecialPI(pi)) continue;
        if (entry.freq !== rounded) continue;
        const resolved = entry.psResolved || '';
        if (resolved.trim().length < 1) continue;
        const avgConf = entry.psConf
            ? entry.psConf.reduce((a, b) => a + b, 0) / 8 : 0;
        const score = Math.log10(Math.max(1, entry.seenCount)) * 0.5 + avgConf * 0.5;
        if (score > bestScore) { bestScore = score; bestPI = pi; }
    }
    return bestPI;
}

function cacheAF(pi, freqMHz) {
    // Never cache AF for special PIs
    if (isSpecialPI(pi) || freqMHz === null || freqMHz === undefined) return;
    const entry   = ensurePI(pi);
    const rounded = Math.round(freqMHz * 10) / 10;
    if (!entry.af.includes(rounded)) {
        entry.af.push(rounded);
        entry.af.sort((a, b) => a - b);
        dbDirty = true;
    }
}

// ═══════════════════════════════════════════════════════════════
//  VOTE ENGINE
// ═══════════════════════════════════════════════════════════════
function votePS(pi, pos, char, weight, errLevel) {
    if (!pi || pi === '----' || !char || char < ' ') return;
    // Never vote for special PIs – their PS is passed through raw
    if (isSpecialPI(pi)) return;
    if (errLevel > 1) return;
    const entry = ensurePI(pi);
    if (entry.psIsDynamic) {
        entry.psLastRaw[pos] = char;
        entry.psLastRawTs    = Date.now();
        dbDirty = true;
        return;
    }
    if (!entry.ps[pos]) entry.ps[pos] = {};
    const posVotes = entry.ps[pos];
    const now      = Date.now();
    const halfMs   = VOTE_HALFLIFE_DAYS * 86400000;
    for (const [ch, v] of Object.entries(posVotes)) {
        const ageMs = now - (v.lastSeen || now);
        v.w        = v.w * Math.pow(0.5, ageMs / halfMs);
        v.lastSeen = now;
        if (v.w < 0.1 && v.count < 3) delete posVotes[ch];
    }
    let finalWeight = weight;
    if (posVotes[char] && posVotes[char].w > 0) {
        const competitorW = Object.entries(posVotes)
            .filter(([ch]) => ch !== char)
            .reduce((s, [, v]) => s + v.w, 0);
        if (posVotes[char].w > competitorW * 2) finalWeight = weight * CONSISTENCY_BOOST;
    }
    if (!posVotes[char])
        posVotes[char] = { w: 0, count: 0, firstSeen: now, lastSeen: now };
    posVotes[char].w       += finalWeight;
    posVotes[char].count   += 1;
    posVotes[char].lastSeen = now;
    entry.psResolved = resolvePS(pi);
    entry.psConf     = computePSConf(pi);
    dbDirty = true;
}

function getWeightedVotes(posVotes) {
    if (!posVotes || typeof posVotes !== 'object') return {};
    const now    = Date.now();
    const halfMs = VOTE_HALFLIFE_DAYS * 86400000;
    const expMs  = VOTE_EXPIRE_DAYS   * 86400000;
    const result = {};
    for (const [ch, v] of Object.entries(posVotes)) {
        const ageMs = now - (v.lastSeen || now);
        if (ageMs > expMs) continue;
        const decayed = v.w * Math.pow(0.5, ageMs / halfMs);
        if (decayed > 0.01) result[ch] = decayed;
    }
    return result;
}

function resolvePS(pi) {
    const entry = db[pi];
    if (!entry) return null;
    let result = '';
    for (let i = 0; i < 8; i++) {
        const wv = getWeightedVotes(entry.ps[i]);
        if (!Object.keys(wv).length) { result += ' '; continue; }
        let best = ' ', bestN = 0;
        for (const [ch, n] of Object.entries(wv)) { if (n > bestN) { bestN = n; best = ch; } }
        result += best;
    }
    return result;
}

function computePSConf(pi) {
    const entry = db[pi];
    if (!entry) return new Array(8).fill(0);
    return Array.from({length: 8}, (_, i) => {
        const wv = getWeightedVotes(entry.ps[i]);
        if (!wv) return 0;
        const vals  = Object.values(wv).sort((a, b) => b - a);
        const total = vals.reduce((a, b) => a + b, 0);
        if (total === 0) return 0;
        const best       = vals[0], second = vals[1] || 0;
        const share      = best / total;
        const dominance  = total > 1 ? (best - second) / total : share;
        const totalCount = Object.values(entry.ps[i] || {})
            .reduce((s, v) => s + (v.count || 0), 0);
        const voteFactor = Math.min(1, totalCount / 30);
        return Math.min(0.97, share * 0.5 + dominance * 0.3 + voteFactor * 0.2);
    });
}

function checkPSDynamic(pi, psString) {
    // Special PIs are always considered dynamic (pass-through)
    if (isSpecialPI(pi)) return;
    const entry = ensurePI(pi);
    const buf   = entry.psDynamicBuf;
    buf.push(psString);
    if (buf.length > 8) buf.shift();
    if (buf.length < 3) return;
    const wasDynamic = entry.psIsDynamic;
    if (!wasDynamic) {
        entry.psIsDynamic = detectScrollPS(buf) || detectChangingPS(buf);
        if (entry.psIsDynamic) {
            entry.ps = {};
            entry.psResolved = null;
            entry.psConf = new Array(8).fill(0);
            dbDirty = true;
        }
    }
}

function detectScrollPS(buf) {
    if (buf.length < 3) return false;
    let scrollCount = 0;
    for (let i = 1; i < buf.length; i++) {
        const a = buf[i-1].trim(), b = buf[i].trim();
        if (!a.length || !b.length) continue;
        for (let shift = 1; shift <= 4; shift++) {
            const rotated = a.slice(shift) + a.slice(0, shift);
            if (rotated.replace(/_/g, ' ').trim() === b.replace(/_/g, ' ').trim()) {
                scrollCount++; break;
            }
        }
    }
    return scrollCount / (buf.length - 1) > 0.6;
}

function detectChangingPS(buf) {
    if (buf.length < 5) return false;
    const counts = {};
    for (const s of buf) {
        const clean = s.trim();
        if (!clean) continue;
        counts[clean] = (counts[clean] || 0) + 1;
    }
    let recurring = 0;
    for (const count of Object.values(counts)) { if (count >= 2) recurring++; }
    return recurring >= 2;
}

// ═══════════════════════════════════════════════════════════════
//  PS LOCK & DYNAMIC JUMP ENGINE
// ═══════════════════════════════════════════════════════════════
function checkAndLockPS(pi) {
    // Special PIs never get locked – raw PS passes through
    if (isSpecialPI(pi)) return;
    const entry = pi ? db[pi] : null;
    if (!entry) return;

    const ref            = findRefEntry(pi);
    const allRawVerified = currentState.psErrBuf.every(e => e <= 1) &&
                           currentState.psBuf.every(c => c && c !== ' ') &&
                           currentState.psRoundReceivedAfterConfirm;

    let bestVariant  = null;
    let bestScore    = 0;
    if (ref?.psVariants?.length > 0) {
        const psBufUpper = currentState.psBuf.join('').toUpperCase();
        for (const v of ref.psVariants) {
            const rv = v.toUpperCase().padEnd(8, ' ');
            const pb = psBufUpper.padEnd(8, ' ');
            let m = 0, c = 0;
            for (let i = 0; i < 8; i++) {
                if (rv[i] !== ' ') { c++; if (rv[i] === pb[i]) m++; }
            }
            const s = c > 0 ? m / c : 0;
            if (s > bestScore) { bestScore = s; bestVariant = v; }
        }
    }

    const refMatchIsGood = bestVariant && bestScore >= 0.75;

    const buildHybridPS = (referenceStr) => {
        let hybridPS = "";
        const cleanRef = referenceStr.padEnd(8, ' ');
        for (let i = 0; i < 8; i++) {
            const rawChar = currentState.psBuf[i] || ' ';
            const rawErr  = currentState.psErrBuf[i];
            const refChar = cleanRef[i];
            if (rawErr <= 2 && rawChar.toUpperCase() === refChar.toUpperCase()) {
                hybridPS += rawChar;
            } else {
                hybridPS += refChar;
            }
        }
        return hybridPS;
    };

    if (!psLocked) {
        let newPS      = null;
        let lockReason = "";

        if (entry.psVerifiedRaw && entry.psVerifiedRaw.trim().length > 0) {
            if (ref?.psVariants?.length > 0) {
                if (refMatchIsGood && bestScore >= 0.8) {
                    newPS = buildHybridPS(bestVariant);
                } else if (!ref || !ref.psVariants || ref.psVariants.length === 0) {
                    newPS = entry.psVerifiedRaw;
                }
            } else {
                newPS = entry.psVerifiedRaw;
            }
            if (newPS) lockReason = "DB verified string";
        }

        if (!newPS && refMatchIsGood) {
            newPS      = buildHybridPS(bestVariant);
            lockReason = `FMDX match ${Math.round(bestScore*100)}%`;
        }

        if (!newPS && allRawVerified) {
            newPS = currentState.psBuf.join('');
            if (ref?.psVariants?.length > 0) {
                const newPSUpper = newPS.trim().toUpperCase();
                const matchesRef = ref.psVariants.some(v =>
                    v.trim().toUpperCase() === newPSUpper ||
                    v.trim().toUpperCase().startsWith(newPSUpper) ||
                    newPSUpper.startsWith(v.trim().toUpperCase())
                );
                if (matchesRef) {
                    entry.psVerifiedRaw   = newPS;
                    entry.psVerifiedRawTs = Date.now();
                    dbDirty = true;
                }
            } else {
                entry.psVerifiedRaw   = newPS;
                entry.psVerifiedRawTs = Date.now();
                dbDirty = true;
            }
            lockReason = "Raw RDS fully verified";
        }

        if (newPS) {
            psLocked = true;
            lastBroadcastPS = newPS;
            if (DEBUG) logInfo(`[${PLUGIN_NAME}] PS locked for PI=${pi}: "${lastBroadcastPS}" (${lockReason})`);

            if (piConfirmed) {
                if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
                const prediction = buildAIPrediction(pi);
                currentState.lastPrediction = prediction;
                setTimeout(() => {
                    broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() });
                    if (rdsFollowMode) applyFollowToDataHandler();
                }, AI_BROADCAST_DELAY);
            }
        }
    } else {
        if (ref?.psVariants?.length > 1 && refMatchIsGood) {
            const currentPSUpper   = (lastBroadcastPS || "").toUpperCase().padEnd(8, ' ');
            const bestVariantUpper = bestVariant.toUpperCase().padEnd(8, ' ');
            if (currentPSUpper !== bestVariantUpper) {
                lastBroadcastPS   = buildHybridPS(bestVariant);
                entry.psIsDynamic = true;
                dbDirty = true;
                if (DEBUG) logInfo(`[${PLUGIN_NAME}] Dynamic FMDX PS jump for PI=${pi}: switched to "${lastBroadcastPS}"`);

                if (piConfirmed) {
                    if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
                    const prediction = buildAIPrediction(pi);
                    currentState.lastPrediction = prediction;
                    setTimeout(() => {
                        broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() });
                        if (rdsFollowMode) applyFollowToDataHandler();
                    }, AI_BROADCAST_DELAY);
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  TX-SEARCH  (Follow mode off)
// ═══════════════════════════════════════════════════════════════
let txUpdateTimer = null;
function scheduleDataHandlerUpdate(pi) {
    if (!dataHandler || rdsFollowMode || !piConfirmed || psLocked) return;
    if (txUpdateTimer) clearTimeout(txUpdateTimer);
    txUpdateTimer = setTimeout(() => {
        txUpdateTimer = null;
        if (!piConfirmed) return;
        const entry = db[pi];
        if (!entry) return;
        if (pi && pi !== '?' && pi !== '----') {
            dataHandler.dataToSend.pi  = pi;
            dataHandler.initialData.pi = pi;
        }
        dataHandler.dataToSend.ps = '        ';
        const psStr = buildPSString(pi);
        if (psStr && psStr.trim().length > 0) {
            if (psStr !== lastBroadcastPS) {
                lastBroadcastPS = psStr;
                dataHandler.dataToSend.ps = psStr;
            } else {
                dataHandler.dataToSend.ps = psStr;
            }
        }
        if (entry.pty >= 0) dataHandler.dataToSend.pty = entry.pty;
        if (currentState.freq) dataHandler.dataToSend.freq = currentState.freq;
    }, 500);
}

function normPS(s) {
    if (!s || typeof s !== 'string') return s;
    return s;
}

function buildPSString(pi) {
    const entry = db[pi];
    if (!entry) return '';
    if (entry.psIsDynamic) {
        const raw = entry.psLastRaw || [];
        if (raw.every(c => c !== null)) return raw.map(c => c || ' ').join('');
        return '';
    }
    if (entry.psVerifiedRaw) return entry.psVerifiedRaw;
    return entry.psResolved || '';
}

// ═══════════════════════════════════════════════════════════════
//  fmdx.org REFERENCE MATCHING
// ═══════════════════════════════════════════════════════════════

// Find the best matching fmdx.org entry for a received PI code.
// Matching priority:
//   1. Exact primary PI match on current frequency
//   2. Regional PI (pireg) match on current frequency
// This ensures that stations transmitting a regional PI variant
// (e.g. Radio 1 Ljubljana with pireg="9857") are correctly identified
// even when the received PI does not match the primary PI field.
function findBestRefEntry(pi) {
    if (!currentState.freqRefs || !pi || !currentState.freq) return null;
    if (isSpecialPI(pi)) return null;
    const piUp = pi.toUpperCase();

    // Priority 1: exact primary-PI match
    const exactMatches = currentState.freqRefs.filter(r => r.pi === piUp);
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1)
        return exactMatches.sort((a, b) => (a.distKm ?? 99999) - (b.distKm ?? 99999))[0];

    // Priority 2: regional PI (pireg) match
    const piRegMatches = currentState.freqRefs.filter(r => r.pireg && r.pireg === piUp);
    if (piRegMatches.length === 1) return piRegMatches[0];
    if (piRegMatches.length > 1)
        return piRegMatches.sort((a, b) => (a.distKm ?? 99999) - (b.distKm ?? 99999))[0];

    return null;
}

function findRefEntry(pi) { return findBestRefEntry(pi); }

function computeRefMatchScore(pi) {
    if (isSpecialPI(pi)) return 0;
    const ref   = findRefEntry(pi);
    if (!ref?.psVariants?.length) return 0;
    const buf   = currentState.psBuf;
    const errB  = currentState.psErrBuf || new Array(8).fill(3);
    const cleanPositions = buf.map((_, i) => errB[i] <= 1);
    const cleanCount = cleanPositions.filter(Boolean).length;
    if (cleanCount < 2) {
        const entry = db[pi];
        if (!entry?.psResolved) return 0;
        const resolved = entry.psResolved.toUpperCase().padEnd(8, ' ');
        let best = 0;
        for (const variant of ref.psVariants) {
            const rv = variant.toUpperCase().padEnd(8, ' ');
            let m = 0, c = 0;
            for (let i = 0; i < 8; i++) {
                c++;
                if (rv[i] === resolved[i]) m++;
            }
            const s = c > 0 ? m / c : 0;
            if (s > best) best = s;
        }
        return best;
    }
    let best = 0;
    for (const variant of ref.psVariants) {
        const rv = variant.toUpperCase().padEnd(8, ' ');
        let m = 0, c = 0;
        for (let i = 0; i < 8; i++) {
            if (!cleanPositions[i]) continue;
            c++;
            const received = (buf[i] || ' ').toUpperCase();
            if (rv[i] === received) m++;
        }
        const s = c > 0 ? m / c : 0;
        if (s > best) best = s;
    }
    return best;
}

// Check whether a received PI is present on the current frequency,
// either as a primary PI or as a regional PI (pireg).
function isPIAllowed(pi) {
    if (!pi || pi === '----') return false;
    if (isSpecialPI(pi)) return true;
    const refs = currentState.freqRefs;
    if (!refs || refs.length === 0) return true;
    const piUp   = pi.toUpperCase();
    const inFmdx = refs.some(r => r.pi === piUp || (r.pireg && r.pireg === piUp));
    if (!inFmdx) {
        if (DEBUG) logInfo(
            `[${PLUGIN_NAME}] PI ${piUp} not in fmdx.org (neither pi nor pireg) for ` +
            `${currentState.freq} MHz – allowing anyway`
        );
    }
    return true;
}

// Return the PI confirmation threshold.
// Uses a lower threshold for stations that are close by and known in fmdx.org
// (matched by either primary PI or pireg).
function getConfirmThreshold(pi) {
    if (isSpecialPI(pi)) return PI_CONFIRM_THRESHOLD;
    const refs = currentState.freqRefs;
    if (refs && refs.length > 0) {
        const piUp   = pi ? pi.toUpperCase() : '';
        const inFmdx = refs.some(r => r.pi === piUp || (r.pireg && r.pireg === piUp));
        if (!inFmdx) return PI_CONFIRM_THRESHOLD;
        const ref = findRefEntry(pi);
        return (ref?.distKm ?? 9999) < 500 ? 1 : 2;
    }
    return PI_CONFIRM_THRESHOLD;
}

// ═══════════════════════════════════════════════════════════════
//  CURRENT STATE
// ═══════════════════════════════════════════════════════════════
let currentState = {
    pi: null, freq: null,
    rtSlots:  Array.from({length: 64}, () => ({ char: ' ', conf: 0 })),
    rtAB: -1,
    psSegsSeen: new Set(), psBuf: new Array(8).fill(' '),
    psErrBuf: new Array(8).fill(3), psRoundComplete: false,
    psRoundReceivedAfterConfirm: false,
    lastPrediction: null,
    tp: false, ta: false, ms: -1, stereo: false,
    freqRefs: [],
    afSet: new Set(),
};

// ═════════════════════════���═════════════════════════════════════
//  DATAHANDLER HELPERS
// ═══════════════════════════════════════════════════════════════
function clearRDSInDataHandler() {
    if (!dataHandler) return;
    const rdsFields = {
        pi: '?', ps: '', ps_errors: '',
        pty: 0, tp: 0, ta: 0, ms: -1,
        rt0: '', rt1: '', rt0_errors: '', rt1_errors: '', rt_flag: '',
        rds: false, ecc: null, country_name: '', country_iso: 'UN',
    };
    Object.assign(dataHandler.dataToSend, rdsFields);
    if (Array.isArray(dataHandler.dataToSend.af)) dataHandler.dataToSend.af.length = 0;
    Object.assign(dataHandler.initialData, rdsFields);
    if (Array.isArray(dataHandler.initialData.af)) {
        dataHandler.initialData.af.length = 0;
    } else {
        dataHandler.initialData.af = dataHandler.dataToSend.af;
    }
    piConfirmCount     = 0;
    piConfirmed        = false;
    piPendingBroadcast = false;
    currentState.lastPrediction = null;
}

// Apply live-received AF frequencies to the datahandler (RDS Follow mode).
// Uses ONLY the live currentState.afSet – never the cached entry.af –
// so each call produces exactly the set received this session, without
// duplicates from the DB cache.
function applyAFToDataHandler() {
    if (!dataHandler || !rdsFollowMode) return;
    if (!Array.isArray(dataHandler.dataToSend.af)) dataHandler.dataToSend.af = [];
    // Rebuild from scratch on every call to prevent duplicates
    dataHandler.dataToSend.af.length = 0;
    for (const f of currentState.afSet) {
        const fKHz = Math.round(parseFloat(f) * 1000);
        dataHandler.dataToSend.af.push(fKHz);
    }
    dataHandler.dataToSend.af.sort((a, b) => a - b);
}

function applyFollowToDataHandler() {
    if (!dataHandler || !rdsFollowMode || !piConfirmed) return;
    const pi    = currentState.pi;
    const entry = (!isSpecialPI(pi) && pi) ? db[pi] : null;
    const ref   = findRefEntry(pi);
    const pred  = currentState.lastPrediction;

    dataHandler.dataToSend.pi  = (pi && pi !== '----' && pi !== '?') ? pi : '?';
    dataHandler.initialData.pi = dataHandler.dataToSend.pi;

    const getDbMixedCasePS = () => {
        if (entry && entry.psVerifiedRaw && entry.psVerifiedRaw.trim().length > 0) {
            return entry.psVerifiedRaw;
        }
        if (entry && entry.psResolved && entry.psResolved.trim().length > 0) {
             if (entry.psResolved.indexOf('?') === -1) return entry.psResolved;
        }
        return null;
    };

    // ── Special PI: pass raw live PS straight through ─────────────────────────
    if (isSpecialPI(pi)) {
        const rawPS = currentState.psBuf.join('');
        const hasContent = rawPS.trim().length > 0 &&
                           currentState.psErrBuf.every(e => e <= 2);
        if (hasContent) {
            dataHandler.dataToSend.ps        = rawPS;
            dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
            dataHandler.initialData.ps       = rawPS;
            lastBroadcastPS = rawPS;
        } else if (lastBroadcastPS) {
            dataHandler.dataToSend.ps        = lastBroadcastPS;
            dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
            dataHandler.initialData.ps       = lastBroadcastPS;
        } else {
            dataHandler.dataToSend.ps        = '        ';
            dataHandler.dataToSend.ps_errors = '';
        }
        // RT, PTY, flags
        const rtLive = buildRTString();
        if (rtLive.trim().length >= 3) {
            const rtFlag = currentState.rtAB >= 0 ? currentState.rtAB : 0;
            if (rtFlag === 0) { dataHandler.dataToSend.rt0 = rtLive; dataHandler.dataToSend.rt0_errors = ''; }
            else              { dataHandler.dataToSend.rt1 = rtLive; dataHandler.dataToSend.rt1_errors = ''; }
            dataHandler.dataToSend.rt_flag  = rtFlag;
            dataHandler.initialData.rt0     = dataHandler.dataToSend.rt0;
            dataHandler.initialData.rt1     = dataHandler.dataToSend.rt1;
            dataHandler.initialData.rt_flag = rtFlag;
        }
        dataHandler.dataToSend.tp  = currentState.tp ? 1 : 0;
        dataHandler.dataToSend.ta  = currentState.ta ? 1 : 0;
        dataHandler.dataToSend.ms  = currentState.ms;
        dataHandler.dataToSend.rds = true;
        applyAFToDataHandler();
        return;
    }
    // ── Normal PI ─────────────────────────────────────────────────────────────

    if (!lastBroadcastPS) {
        const dbStr = getDbMixedCasePS();
        if (dbStr) {
            lastBroadcastPS = dbStr;
        } else if (ref?.psVariants?.length > 0) {
            lastBroadcastPS = ref.psVariants[0].padEnd(8, ' ');
        }
    }

    const isDynamic = (entry?.psIsDynamic || false) ||
                      (ref?.psVariants && ref.psVariants.length > 1);
    const isScrollingNonFmdx = entry?.psIsDynamic && (!ref?.psVariants || ref.psVariants.length <= 1);

    if (psLocked && lastBroadcastPS && !isScrollingNonFmdx) {
        dataHandler.dataToSend.ps        = lastBroadcastPS;
        dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
        dataHandler.initialData.ps       = lastBroadcastPS;

    } else if (isScrollingNonFmdx) {
        const raw = entry?.psLastRaw;
        const rawClean = currentState.psErrBuf.every(e => e <= 2);
        if (raw && raw.every(c => c !== null) && rawClean) {
            const psStr = raw.map(c => c || ' ').join('');
            lastBroadcastPS = psStr;
            dataHandler.dataToSend.ps        = psStr;
            dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
            dataHandler.initialData.ps       = psStr;
        } else if (lastBroadcastPS) {
            dataHandler.dataToSend.ps        = lastBroadcastPS;
            dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
            dataHandler.initialData.ps       = lastBroadcastPS;
        } else {
            dataHandler.dataToSend.ps        = '        ';
            dataHandler.dataToSend.ps_errors = '';
        }

    } else if (isDynamic) {
        if (ref?.psVariants?.length > 0) {
            const psBufUpper = currentState.psBuf.join('').toUpperCase();
            let bestVariant  = null;
            let bestScore    = 0;
            for (const v of ref.psVariants) {
                const rv = v.toUpperCase().padEnd(8, ' ');
                const pb = psBufUpper.padEnd(8, ' ');
                let m = 0, c = 0;
                for (let i = 0; i < 8; i++) {
                    if (rv[i] !== ' ') { c++; if (rv[i] === pb[i]) m++; }
                }
                const s = c > 0 ? m / c : 0;
                if (s > bestScore) { bestScore = s; bestVariant = v; }
            }
            if (bestVariant && bestScore >= 0.5) {
                const dbStr = getDbMixedCasePS();
                const psStr = dbStr ? dbStr : bestVariant.padEnd(8, ' ');
                lastBroadcastPS = psStr;
                dataHandler.dataToSend.ps        = psStr;
                dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
                dataHandler.initialData.ps       = psStr;
            } else if (lastBroadcastPS) {
                dataHandler.dataToSend.ps        = lastBroadcastPS;
                dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
                dataHandler.initialData.ps       = lastBroadcastPS;
            } else {
                dataHandler.dataToSend.ps        = '        ';
                dataHandler.dataToSend.ps_errors = '';
            }
        }
    } else if (pred && pred.ps && Array.isArray(pred.ps)) {
        const refScore   = computeRefMatchScore(pi);
        const isRefReady = refScore >= 0.8;

        if (isRefReady && ref?.psVariants?.length > 0) {
            const dbStr = getDbMixedCasePS();
            let psStr;
            if (dbStr) {
                psStr = dbStr;
            } else {
                const psBufUpper = currentState.psBuf.join('').toUpperCase();
                let bestVariant  = ref.psVariants[0];
                let bestScore    = 0;
                for (const v of ref.psVariants) {
                    const rv = v.toUpperCase().padEnd(8, ' ');
                    const pb = psBufUpper.padEnd(8, ' ');
                    let m = 0, c = 0;
                    for (let i = 0; i < 8; i++) {
                        if (rv[i] !== ' ') { c++; if (rv[i] === pb[i]) m++; }
                    }
                    const s = c > 0 ? m / c : 0;
                    if (s > bestScore) { bestScore = s; bestVariant = v; }
                }
                let hybridPS = "";
                const cleanVariant = bestVariant.padEnd(8, ' ');
                for (let i = 0; i < 8; i++) {
                    const rawChar = currentState.psBuf[i] || ' ';
                    const rawErr  = currentState.psErrBuf[i];
                    const refChar = cleanVariant[i];
                    if (rawErr <= 2 && rawChar.toUpperCase() === refChar.toUpperCase()) {
                        hybridPS += rawChar;
                    } else {
                        hybridPS += refChar;
                    }
                }
                psStr = hybridPS;
            }
            lastBroadcastPS = psStr;
            dataHandler.dataToSend.ps        = psStr;
            dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
            dataHandler.initialData.ps       = psStr;
        } else {
            const goodSlots = pred.ps.filter(s =>
                s && s.src !== 'empty' && s.src !== 'ai-bigram' && s.conf >= 0.5
            ).length;
            if (goodSlots >= 4 || lastBroadcastPS) {
                const psStr = pred.ps.map(s =>
                    (s && s.src !== 'empty' && s.src !== 'ai-bigram' && s.char) ? s.char : ' '
                ).join('');
                if (!lastBroadcastPS || goodSlots >= 4) lastBroadcastPS = psStr;
                dataHandler.dataToSend.ps        = lastBroadcastPS;
                dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
                dataHandler.initialData.ps       = lastBroadcastPS;
            }
        }
    } else if (lastBroadcastPS) {
        dataHandler.dataToSend.ps        = lastBroadcastPS;
        dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
        dataHandler.initialData.ps       = lastBroadcastPS;
    } else {
        dataHandler.dataToSend.ps        = '        ';
        dataHandler.dataToSend.ps_errors = '';
    }

    if (dataHandler.dataToSend.ps)  dataHandler.dataToSend.ps  = normPS(dataHandler.dataToSend.ps);
    if (dataHandler.initialData.ps) dataHandler.initialData.ps = normPS(dataHandler.initialData.ps);
    if (lastBroadcastPS)            lastBroadcastPS             = normPS(lastBroadcastPS);

    dataHandler.dataToSend.pty = (entry && entry.pty >= 0) ? entry.pty : 0;
    dataHandler.dataToSend.tp  = currentState.tp ? 1 : 0;
    dataHandler.dataToSend.ta  = currentState.ta ? 1 : 0;
    dataHandler.dataToSend.ms  = currentState.ms;

    const rtLive = buildRTString();
    const rtSrc  = rtLive.trim().length >= 3 ? rtLive
                 : (pred?.rt?.text?.trim().length >= 3 ? pred.rt.text : null);

    if (rtSrc) {
        const rtFlag = currentState.rtAB >= 0 ? currentState.rtAB : 0;
        if (rtFlag === 0) {
            dataHandler.dataToSend.rt0        = rtSrc;
            dataHandler.dataToSend.rt0_errors = '';
        } else {
            dataHandler.dataToSend.rt1        = rtSrc;
            dataHandler.dataToSend.rt1_errors = '';
        }
        dataHandler.dataToSend.rt_flag  = rtFlag;
        dataHandler.initialData.rt0     = dataHandler.dataToSend.rt0;
        dataHandler.initialData.rt1     = dataHandler.dataToSend.rt1;
        dataHandler.initialData.rt_flag = rtFlag;
    } else {
        dataHandler.dataToSend.rt0        = '';
        dataHandler.dataToSend.rt1        = '';
        dataHandler.dataToSend.rt0_errors = '';
        dataHandler.dataToSend.rt1_errors = '';
        dataHandler.initialData.rt0       = '';
        dataHandler.initialData.rt1       = '';
    }

    // ── ECC / Country ─────────────────────────────────────────
    // Resolve the ECC byte: prefer live DB entry, then fall back to
    // whatever the datahandler already holds – never overwrite with
    // null/unknown when we simply don't have the data yet.
    const eccByte = (entry && entry.ecc) ? parseInt(entry.ecc, 16) : null;

    if (eccByte) {
        // Known ECC – write it together with the derived country
        dataHandler.dataToSend.ecc = eccByte;
        const country = lookupCountry(pi, eccByte);
        dataHandler.dataToSend.country_iso  = country ? country.iso  : 'UN';
        dataHandler.dataToSend.country_name = country ? country.name : '';
    }
    // If eccByte is null we intentionally do NOT touch ecc / country_iso /
    // country_name so the native decoder's value (or a previously set one)
    // remains intact and the country flag never disappears.

    dataHandler.dataToSend.rds = !!(pi && pi !== '?');
    applyAFToDataHandler();
}

// ════════════════��══════════════════════════════════════════════
//  GROUP DECODING
// ═══════════════════════════════════════════════════════════════
function decodeGroup(pi, b2hex, b3hex, b4hex, errB) {
    if (!b2hex) return;
    const g2 = parseInt(b2hex, 16);
    const g3 = b3hex ? parseInt(b3hex, 16) : NaN;
    const g4 = b4hex ? parseInt(b4hex, 16) : NaN;
    const gT = (g2 >> 12) & 0x0F;
    const vB = (g2 >> 11) & 0x01;
    const tp = !!((g2 >> 10) & 0x01);
    const pty = (g2 >> 5) & 0x1F;
    const c3 = CONF_TABLE[errB[2]];
    const c4 = CONF_TABLE[errB[3]];
    const blkAok = errB[0] <= 1;
    const blkBok = errB[1] <= 1;

    // For special PIs: still track live state but skip DB writes
    const entry = isSpecialPI(pi) ? null : ensurePI(pi);
    if (entry) {
        entry.seenCount++;
        entry.seen = Date.now();
        if (currentState.freq) entry.freq = roundFreq(currentState.freq);
        if (blkAok && blkBok) {
            entry.tp = tp; currentState.tp = tp;
            if (pty > 0) entry.pty = pty;
        }
        dbDirty = true;
    } else {
        // Special PI: still update live TP/PTY for follow mode
        if (blkAok && blkBok) {
            currentState.tp = tp;
        }
    }

    // ── Group 0A ─────────────────────────────────────────────
    if (gT === 0 && vB === 0) {
        if (blkAok && blkBok) {
            const ta  = !!((g2 >> 4) & 0x01);
            const ms  = !!((g2 >> 3) & 0x01);
            const seg =    g2 & 0x03;
            const di  = !!((g2 >> 2) & 0x01);
            if (entry) { entry.ta = ta; entry.ms = ms ? 1 : 0; }
            currentState.ta = ta;
            currentState.ms = ms ? 1 : 0;
            if (seg === 3 && entry) { entry.stereo = di; currentState.stereo = di; }
            else if (seg === 3)     { currentState.stereo = di; }
        }
        if (b3hex && errB[2] <= 1 && blkAok && blkBok) {
            const af1code = (g3 >> 8) & 0xFF;
            const af2code =  g3 & 0xFF;
            if (af1code !== 250) {
                const f1 = decodeAFCode(af1code);
                if (f1 !== null) {
                    const f1r  = Math.round(f1 * 10) / 10;
                    const isNew = !currentState.afSet.has(f1r);
                    currentState.afSet.add(f1r);
                    if (!isSpecialPI(pi)) cacheAF(pi, f1r);
                    if (DEBUG && isNew)
                        logInfo(`[${PLUGIN_NAME}] AF discovered: ${f1r.toFixed(1)}`);
                }
            }
            if (af2code !== 250) {
                const f2 = decodeAFCode(af2code);
                if (f2 !== null) {
                    const f2r  = Math.round(f2 * 10) / 10;
                    const isNew = !currentState.afSet.has(f2r);
                    currentState.afSet.add(f2r);
                    if (!isSpecialPI(pi)) cacheAF(pi, f2r);
                    if (DEBUG && isNew)
                        logInfo(`[${PLUGIN_NAME}] AF discovered: ${f2r.toFixed(1)}`);
                }
            }
        }
        if (b4hex && c4 > 0) {
            const seg    = g2 & 0x03;
            const addr   = seg * 2;
            const c0     = rdsChar((g4 >> 8) & 0xFF);
            const c1     = rdsChar(g4 & 0xFF);
            const weight = errB[3] === 0 ? 10 : errB[3] === 1 ? 5 : 0;
            if (weight > 0 && blkAok && blkBok) {
                if (c0 !== '\r') votePS(pi, addr,     c0, weight, errB[3]);
                if (c1 !== '\r') votePS(pi, addr + 1, c1, weight, errB[3]);
            }
            if (c0 !== '\r') {
                currentState.psBuf[addr]    = c0;
                currentState.psErrBuf[addr] = errB[3];
                currentState.psSegsSeen.add(seg);
            }
            if (c1 !== '\r') {
                currentState.psBuf[addr + 1]    = c1;
                currentState.psErrBuf[addr + 1] = errB[3];
            }
            if (currentState.psSegsSeen.size >= 4 && !currentState.psRoundComplete) {
                currentState.psRoundComplete = true;
                if (!isSpecialPI(pi)) checkPSDynamic(pi, currentState.psBuf.join(''));
                if (entry && currentState.psErrBuf.every(e => e <= 1)) {
                    entry.psLastRaw   = [...currentState.psBuf];
                    entry.psLastRawTs = Date.now();
                    dbDirty = true;
                }
                if (!currentState.psRoundReceivedAfterConfirm && piConfirmed)
                    currentState.psRoundReceivedAfterConfirm = true;
                currentState.psSegsSeen.clear();
                currentState.psRoundComplete = false;
                checkAndLockPS(pi);
                scheduleDataHandlerUpdate(pi);
            }
        }
    }

    // ── Group 0B ─────────────────────────────────────────────
    if (gT === 0 && vB === 1) {
        if (blkAok && blkBok) {
            const ta  = !!((g2 >> 4) & 0x01);
            const ms  = !!((g2 >> 3) & 0x01);
            const seg =    g2 & 0x03;
            const di  = !!((g2 >> 2) & 0x01);
            if (entry) { entry.ta = ta; entry.ms = ms ? 1 : 0; }
            currentState.ta = ta;
            currentState.ms = ms ? 1 : 0;
            if (seg === 3 && entry) { entry.stereo = di; currentState.stereo = di; }
            else if (seg === 3)     { currentState.stereo = di; }
        }
        if (b4hex && c4 > 0) {
            const seg  = g2 & 0x03;
            const addr = seg * 2;
            const c0   = rdsChar((g4 >> 8) & 0xFF);
            const c1   = rdsChar(g4 & 0xFF);
            const weight = errB[3] === 0 ? 10 : errB[3] === 1 ? 5 : 0;
            if (weight > 0 && blkAok && blkBok) {
                if (c0 !== '\r') votePS(pi, addr,     c0, weight, errB[3]);
                if (c1 !== '\r') votePS(pi, addr + 1, c1, weight, errB[3]);
            }
            if (c0 !== '\r') { currentState.psBuf[addr]     = c0; currentState.psErrBuf[addr]     = errB[3]; currentState.psSegsSeen.add(seg); }
            if (c1 !== '\r') { currentState.psBuf[addr + 1] = c1; currentState.psErrBuf[addr + 1] = errB[3]; }
            if (currentState.psSegsSeen.size >= 4 && !currentState.psRoundComplete) {
                currentState.psRoundComplete = true;
                if (!isSpecialPI(pi)) checkPSDynamic(pi, currentState.psBuf.join(''));
                if (entry && currentState.psErrBuf.every(e => e <= 1)) {
                    entry.psLastRaw   = [...currentState.psBuf];
                    entry.psLastRawTs = Date.now();
                    dbDirty = true;
                }
                if (!currentState.psRoundReceivedAfterConfirm && piConfirmed)
                    currentState.psRoundReceivedAfterConfirm = true;
                currentState.psSegsSeen.clear();
                currentState.psRoundComplete = false;
                checkAndLockPS(pi);
                scheduleDataHandlerUpdate(pi);
            }
        }
    }

    // ── Group 2A (RadioText) ──────────────────────────────────
    if (gT === 2 && vB === 0) {
        const abF  = (g2 >> 4) & 0x01;
        const addr = (g2 & 0x0F) * 4;
        if (abF !== currentState.rtAB) {
            currentState.rtSlots = Array.from({length: 64}, () => ({ char: ' ', conf: 0 }));
            currentState.rtAB    = abF;
        }
        if (b3hex && c3 > 0) {
            currentState.rtSlots[addr    ] = { char: rdsChar((g3 >> 8) & 0xFF), conf: c3 };
            currentState.rtSlots[addr + 1] = { char: rdsChar(g3 & 0xFF),        conf: c3 };
        }
        if (b4hex && c4 > 0) {
            currentState.rtSlots[addr + 2] = { char: rdsChar((g4 >> 8) & 0xFF), conf: c4 };
            currentState.rtSlots[addr + 3] = { char: rdsChar(g4 & 0xFF),        conf: c4 };
        }
    }

    // ── Group 2B (RadioText, 2 chars per group) ───────────────
    if (gT === 2 && vB === 1) {
        const abF  = (g2 >> 4) & 0x01;
        const addr = (g2 & 0x0F) * 2;
        if (abF !== currentState.rtAB) {
            currentState.rtSlots = Array.from({length: 64}, () => ({ char: ' ', conf: 0 }));
            currentState.rtAB    = abF;
        }
        if (b4hex && c4 > 0) {
            currentState.rtSlots[addr    ] = { char: rdsChar((g4 >> 8) & 0xFF), conf: c4 };
            currentState.rtSlots[addr + 1] = { char: rdsChar(g4 & 0xFF),        conf: c4 };
        }
    }

    // ── Group 1A (ECC) ─────────���──────────────────────────────
    if (gT === 1 && vB === 0 && b3hex && errB[2] <= 1 && entry) {
        const variant = (g2 >> 1) & 0x07;
        if (variant === 0) {
            const eccByte = g3 & 0xFF;
            if (eccByte > 0) {
                entry.ecc = eccByte.toString(16).toUpperCase().padStart(2, '0');
                dbDirty   = true;
                if (rdsFollowMode && dataHandler && piConfirmed) {
                    dataHandler.dataToSend.ecc = eccByte;
                    const country = lookupCountry(pi, eccByte);
                    if (country) {
                        dataHandler.dataToSend.country_iso  = country.iso;
                        dataHandler.dataToSend.country_name = country.name;
                    }
                }
            }
        }
    }
}

// ── Bigram frequency table ────────────────────────────────────
const BIGRAM = {
    ' ':{'R':25,'S':20,'M':18,'F':15,'D':14,'N':12,'B':11,'K':10,'H':9,'L':8,'C':7,'W':6,'T':5,'A':5,'G':4,'E':4,'P':4,'1':3,'2':3,'3':3},
    'R':{'A':20,'E':18,'O':15,'D':12,'S':10,'I':9,'U':8,'T':7,' ':6,'N':5,'K':4,'C':4,'L':4,'1':3,'2':3},
    'A':{'D':15,'N':14,'S':12,'L':10,'M':9,'T':8,'R':7,'1':6,'2':5,'3':4,'K':4,' ':4,'X':3,'P':3},
    'S':{'T':18,'E':16,'P':12,'O':10,'A':9,' ':8,'U':7,'W':6,'K':6,'N':5,'1':4,'2':3,'H':3,'I':3},
    'I':{'N':20,'O':15,'S':12,'E':10,'R':8,' ':7,'C':6,'T':6,'1':5,'F':4,'L':4,'D':3},
    'O':{'N':18,'S':15,'R':12,'L':10,' ':9,'U':8,'K':7,'T':6,'M':5,'D':5,'1':4,'P':4,'F':3},
    'T':{'E':20,'H':18,'A':15,'S':12,'R':10,'O':8,'I':7,'U':6,' ':5,'1':4,'2':3,'W':3,'N':3},
    'E':{'R':18,'N':15,'S':12,'L':10,'A':9,'T':8,'X':7,'C':6,' ':5,'W':5,'G':4,'1':4,'2':3},
    'N':{'D':15,'E':14,'A':12,'S':10,' ':9,'O':8,'T':7,'I':6,'G':5,'R':4,'1':4,'2':3,'W':3},
    'D':{'R':20,'E':15,'A':12,'I':10,'S':8,'U':7,'1':6,'2':5,'3':4,' ':4},
    'L':{'A':15,'E':14,'I':12,'O':10,'U':8,' ':7,'T':6,'1':5,'2':4,'D':4,'S':3},
    'G':{'E':18,'A':12,'O':10,'S':8,'R':7,' ':6,'U':5,'1':4,'2':3,'N':3,'I':3},
    'K':{'A':15,'I':12,'O':10,'U':8,'E':7,' ':6,'1':5,'2':4,'3':3,'N':3,'L':3},
    'C':{'H':18,'A':15,'O':12,'L':10,'E':9,'K':8,'I':7,'U':6,'1':5,'2':4,'3':3,'R':3},
    'F':{'M':40,'R':12,'L':8,'E':6,'U':5,'I':4,'O':3,'A':3},
    'M':{'D':15,'U':10,'A':9,'X':8,'E':8,'I':7,'S':5,'1':4,'2':3,'3':3},
    'H':{'I':15,'A':12,'E':10,'U':8,'R':7,'O':6,'1':5,'2':4,'N':3},
    'P':{'O':15,'L':12,'R':10,'A':9,'E':8,'I':7,'U':6,'1':5,'2':4,'3':3},
    'U':{'R':15,'N':12,'S':10,'E':8,'1':6,'2':5,'3':4,'K':4,'L':3},
    'W':{'D':20,'A':15,'E':12,'I':10,'S':8,'R':7,'1':6,'2':5,'3':4,' ':4},
    'B':{'B':20,'A':15,'R':12,'E':10,'1':8,'2':7,'C':6,' ':4,'Y':3},
    'X':{'T':15,'1':12,'2':10,'3':8,'4':6,' ':5},
    '1':{'0':20,'1':15,'2':12,'3':10,'4':8,'5':7,'6':6,'7':5,'8':4,'9':3,' ':3},
    '2':{'0':20,'1':15,'2':12,'3':10,'4':8,'5':7,'6':6,'7':5,'8':4,'9':3,' ':3},
    '3':{'0':15,'1':12,'2':10,'3':8,'4':7,'5':6,'6':5,'7':4,'8':3,'9':3,' ':3},
};

function bigramScore(a, b) {   // eslint-disable-line no-unused-vars
    if (!a || !b) return 1;
    return (BIGRAM[a]?.[b] || 1);
}

function buildRTString() {
    let rt = '';
    for (let i = 0; i < 64; i++) {
        const sl = currentState.rtSlots[i];
        if (!sl || sl.char === '\r') break;
        if (sl.conf > 0) rt += sl.char; else if (rt.length > 0) break;
    }
    return rt.trimEnd();
}

// ═══════════════════════════════════════════════════════════════
//  AI PREDICTION ENGINE
// ═══════════════════════════════════════════════════════════════
function buildAIPrediction(pi) {
    const entry = (!isSpecialPI(pi) && pi) ? db[pi] : null;
    const ref   = findRefEntry(pi);
    const psSlots = [];

    if (psLocked && lastBroadcastPS && entry && !entry.psIsDynamic) {
        for (let i = 0; i < 8; i++)
            psSlots.push({ char: lastBroadcastPS[i] || ' ', conf: 1.0, src: 'raw-0' });
    } else if (isSpecialPI(pi)) {
        // Special PI: reflect live raw PS buffer directly
        for (let i = 0; i < 8; i++) {
            const rawChar = currentState.psBuf[i] || ' ';
            const rawErr  = currentState.psErrBuf[i];
            const rawConf = CONF_TABLE[Math.min(rawErr, 3)];
            if (rawChar !== ' ' && rawErr <= 2) {
                psSlots.push({ char: rawChar, conf: rawConf, src: `raw-${rawErr}` });
            } else {
                psSlots.push({ char: rawChar, conf: 0, src: 'empty' });
            }
        }
    } else {
        for (let i = 0; i < 8; i++) {
            const rawChar = currentState.psBuf[i];
            const rawErr  = currentState.psErrBuf[i];
            const rawConf = CONF_TABLE[Math.min(rawErr, 3)];

            if (entry && entry.psIsDynamic && entry.psLastRaw && entry.psLastRaw[i] != null &&
                currentState.psRoundReceivedAfterConfirm) {
                psSlots.push({ char: entry.psLastRaw[i], conf: 0.9, src: 'ai-dynamic' });
                continue;
            }
            if (rawErr <= 1 && rawChar && rawChar !== ' ' &&
                currentState.psRoundReceivedAfterConfirm) {
                psSlots.push({ char: rawChar, conf: rawConf, src: `raw-${rawErr}` });
                continue;
            }
            if (entry && !entry.psIsDynamic && entry.ps[i]) {
                const wv = getWeightedVotes(entry.ps[i]);
                if (Object.keys(wv).length > 0) {
                    let best = ' ', bestW = 0;
                    for (const [ch, w] of Object.entries(wv))
                        { if (w > bestW) { bestW = w; best = ch; } }
                    const total = Object.values(wv).reduce((a, b) => a + b, 0);
                    const conf  = Math.min(0.95, bestW / total);
                    if (conf > 0.3) {
                        let displayChar = best;
                        if (rawChar && rawChar !== ' ' &&
                            rawChar.toUpperCase() === best.toUpperCase()) {
                            displayChar = rawChar;
                        }
                        psSlots.push({ char: displayChar, conf,
                            src: 'ai-voted-' + (conf > 0.7 ? 'high' : conf > 0.5 ? 'mid' : 'low') });
                        continue;
                    }
                }
            }
            if (ref && ref.psVariants && ref.psVariants.length > 0) {
                const refPS      = ref.psVariants[0].padEnd(8, ' ');
                if (refPS[i] && refPS[i] !== ' ') {
                    const matchScore = computeRefMatchScore(pi);
                    const src        = matchScore >= 0.5 ? 'ref-match' : 'ref-seed';
                    let displayChar  = refPS[i];
                    if (rawChar && rawChar !== ' ' &&
                        rawChar.toUpperCase() === displayChar.toUpperCase()) {
                        displayChar = rawChar;
                    }
                    psSlots.push({ char: displayChar, conf: 0.3 + matchScore * 0.4, src });
                    continue;
                }
            }
            if (i > 0 && psSlots[i-1]) {
                const prev = psSlots[i-1].char;
                const bg   = Object.entries(BIGRAM[prev] || {}).sort((a, b) => b[1] - a[1]);
                if (bg.length > 0) {
                    psSlots.push({ char: bg[0][0], conf: 0.1, src: 'ai-bigram' });
                    continue;
                }
            }
            psSlots.push({ char: ' ', conf: 0, src: 'empty' });
        }
    }

    const rtText   = buildRTString();
    const rtResult = rtText.trim().length >= 3
        ? { text: rtText, score: 0.8, src: 'raw-rt' }
        : (entry?.rtLast?.trim().length >= 3
            ? { text: entry.rtLast, score: 0.5, src: 'ai-rt-last' }
            : null);

    const psVoteTotal = entry ? Object.values(entry.ps).reduce((a, posVotes) => {
        const wv = getWeightedVotes(posVotes);
        return a + Object.values(wv).reduce((x, y) => x + y, 0);
    }, 0) : 0;

    const refMatchScore = computeRefMatchScore(pi);

    let psName     = null;
    let psNameSrc  = null;
    let psVariants = [];

    if (!isSpecialPI(pi) && ref && ref.psVariants && ref.psVariants.length > 0) {
        psVariants = ref.psVariants.map(v => v.trim()).filter(v => v.length > 0);
        psName     = ref.station && ref.station.trim().length > 0
            ? ref.station.trim() : null;
        psNameSrc  = 'fmdx';
    }

    const psIsDynamicEffective = (entry?.psIsDynamic || false) ||
                                 (ref?.psVariants && ref.psVariants.length > 1);

    // For special PIs, no altFreqs or fmdx data
    const rawAltFreqs = (!isSpecialPI(pi) && psLocked && lastBroadcastPS)
        ? getAltFreqsForPIAndPS(pi, lastBroadcastPS)
        : (!isSpecialPI(pi) ? getAltFreqsForPI(pi) : []);

    const seenFreqs   = new Set();
    const altFreqs    = [];
    for (const item of rawAltFreqs) {
        const key = parseFloat(item.freq).toFixed(1);
        if (!seenFreqs.has(key)) {
            seenFreqs.add(key);
            altFreqs.push({
                freq:       parseFloat(item.freq).toFixed(1),
                distKm:     item.distKm,
                station:    item.station,
                psVariants: item.psVariants || [],
            });
        }
    }
    altFreqs.sort((a, b) => parseFloat(a.freq) - parseFloat(b.freq));

    const afArray = Array.from(currentState.afSet)
        .map(f => parseFloat(f.toFixed ? f.toFixed(1) : String(f)))
        .sort((a, b) => a - b);

    return {
        pi,
        ps:    psSlots,
        rt:    rtResult,
        af:    afArray,
        psName,
        psNameSrc,
        psVariants: ref?.psVariants || [],
        altFreqs,
        psLocked,
        stats: {
            freq:          entry?.freq    || currentState.freq,
            seenCount:     entry?.seenCount || 0,
            psVoteTotal:   Math.round(psVoteTotal),
            psIsDynamic:   psIsDynamicEffective,
            psLocked,
            refStation:    ref?.station   || null,
            refDistKm:     ref?.distKm    ?? null,
            refMatchScore: Math.round(refMatchScore * 100),
            // pireg: expose regional PI code and primary PI back-reference
            // so the front-end can indicate when the received PI is a
            // regional variant rather than the station's primary PI code.
            pireg:         ref?.pireg  || null,
            piMain:        ref?.piMain || null,
        },
    };
}

// ─────────────────────────────────────────────────────────────
//  onPIConfirmed
// ─────────────────────────────────────────────────────────────
function onPIConfirmed(pi) {
    // Special PIs: minimal handling – no DB seeding, no fmdx lookup
    if (isSpecialPI(pi)) {
        if (DEBUG) logInfo(`[${PLUGIN_NAME}] Special PI confirmed: ${pi} (pass-through mode)`);
        const prediction = buildAIPrediction(pi);
        currentState.lastPrediction = prediction;
        setTimeout(() => {
            broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() });
        }, AI_BROADCAST_DELAY);
        if (dataHandler) {
            dataHandler.dataToSend.pi  = pi;
            dataHandler.initialData.pi = pi;
            dataHandler.dataToSend.rds = true;
        }
        if (rdsFollowMode) applyFollowToDataHandler();
        return;
    }

    const entry = ensurePI(pi);
    const ref   = findRefEntry(pi);

    if (ref && ref.psVariants && ref.psVariants.length > 0) {
        const hasVotes = Object.keys(entry.ps).length > 0;
        if (!hasVotes) {
            const refPS = ref.psVariants[0].padEnd(8, ' ');
            for (let i = 0; i < 8; i++) {
                if (refPS[i] && refPS[i] !== ' ') {
                    if (!entry.ps[i]) entry.ps[i] = {};
                    entry.ps[i][refPS[i]] = {
                        w: 1.0, count: 1,
                        firstSeen: Date.now(), lastSeen: Date.now(),
                    };
                }
            }
            entry.psResolved = resolvePS(pi);
            entry.psConf     = computePSConf(pi);
            dbDirty = true;
        }
    }

    if (entry.psVerifiedRaw && ref?.psVariants?.length > 0) {
        const storedUpper = entry.psVerifiedRaw.trim().toUpperCase();
        const matchesRef  = ref.psVariants.some(v => {
            const vUp = v.trim().toUpperCase();
            return storedUpper === vUp ||
                   storedUpper.startsWith(vUp) ||
                   vUp.startsWith(storedUpper);
        });
        if (!matchesRef) {
            if (DEBUG) logInfo(
                `[${PLUGIN_NAME}] Discarding stale psVerifiedRaw "${entry.psVerifiedRaw.trim()}" ` +
                `for PI=${pi} – not matching fmdx.org variants at ${currentState.freq} MHz`
            );
            entry.psVerifiedRaw   = null;
            entry.psVerifiedRawTs = 0;
            dbDirty = true;
        }
    }

    if (DEBUG) {
        const refMatchPct = Math.round(computeRefMatchScore(pi) * 100);
        let source = 'no fmdx.org ref';
        if (ref) {
            const dist = ref.distKm !== null && ref.distKm !== undefined
                ? `${ref.distKm} km` : '? km';
            // Note if this match was via pireg rather than the primary PI
            const matchType = (ref.pireg && ref.pireg === pi.toUpperCase())
                ? `pireg match (primary PI: ${ref.piMain || '?'})`
                : 'primary PI match';
            source = `fmdx.org, ${dist}, match ${refMatchPct}%, ${matchType}`;
        }
        const psName = (entry.psResolved || '').trim() || ref?.psVariants?.[0]?.trim() || '';
        logInfo(`[${PLUGIN_NAME}] PI confirmed: ${pi}${psName ? ` = "${psName}"` : ''} (${source})`);

        if (ref && ref.psVariants && ref.psVariants.length > 0) {
            const variantStr = ref.psVariants
                .map((v, i) => `[${i}] "${v.trimEnd()}"`)
                .join('  ');
            logInfo(`[${PLUGIN_NAME}] PS variants for ${pi}: ${variantStr}`);
        }

        const altF = getAltFreqsForPI(pi);
        if (altF.length > 0) {
            const sortedFreqs = altF
                .map(a => parseFloat(a.freq))
                .sort((a, b) => a - b)
                .filter((f, idx, arr) => arr.indexOf(f) === idx)
                .map(f => f.toFixed(1));
            logInfo(`[${PLUGIN_NAME}] fmdx.org freqs for PI ${pi}: ` + sortedFreqs.join(', '));
        }
    }

    if (!psLocked) {
        checkAndLockPS(pi);
    }

    const prediction = buildAIPrediction(pi);
    currentState.lastPrediction = prediction;

    setTimeout(() => {
        broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() });
    }, AI_BROADCAST_DELAY);

    if (dataHandler) {
        if (pi && pi !== '?' && pi !== '----') {
            dataHandler.dataToSend.pi  = pi;
            dataHandler.initialData.pi = pi;
        }
        dataHandler.dataToSend.rds = true;
    }
    if (rdsFollowMode) applyFollowToDataHandler();
}

// ─────────────────────────────────────────────────────────────
//  parseAndDispatch
// ─────────────────────────────────────────────────────────────
function parseAndDispatch(raw) {
    let dataHex, errorHex;
    if (raw.length >= 18) {
        dataHex = raw.slice(0, 16); errorHex = raw.slice(16, 18);
    } else if (raw.length === 14) {
        if (!legacyPiCache || legacyPiCache.length < 4) return;
        const pi        = legacyPiCache.slice(0, 4);
        const legacyErr = parseInt(raw.slice(12), 16);
        let errNew      = (legacyPiCache.length - 4) << 6;
        errNew |= (legacyErr & 0x03) << 4;
        errNew |= (legacyErr & 0x0C);
        errNew |= (legacyErr & 0x30) >> 4;
        dataHex = pi + raw.slice(0, 12); errorHex = errNew.toString(16).padStart(2, '0');
    } else return;

    const errByte = parseInt(errorHex, 16);
    const errB    = [
        (errByte >> 6) & 0x03,
        (errByte >> 4) & 0x03,
        (errByte >> 2) & 0x03,
         errByte       & 0x03,
    ];

    const piRaw = dataHex.slice(0, 4).toUpperCase();
    const b2hex = dataHex.slice(4,  8);
    const b3hex = dataHex.slice(8,  12);
    const b4hex = dataHex.slice(12, 16);

    if (errB[0] > 1) return;

    const pi = piRaw;

    if (pi !== currentState.pi) {
        currentState.pi    = pi;
        piConfirmCount     = 1;
        piConfirmed        = false;
        piPendingBroadcast = false;
        psLocked           = false;
        lastBroadcastPS    = null;

        currentState.psBuf.fill(' ');
        currentState.psErrBuf.fill(3);
        currentState.psSegsSeen.clear();
        currentState.rtSlots = Array.from({length: 64}, () => ({ char: ' ', conf: 0 }));
        currentState.rtAB    = -1;
        currentState.afSet   = new Set();
        currentState.psRoundReceivedAfterConfirm = false;

        if (!isSpecialPI(pi)) {
            const entry = db[pi];
            if (entry) {
                if (entry.psDynamicBuf) entry.psDynamicBuf.length = 0;
                else Object.defineProperty(entry, 'psDynamicBuf', {
                    value: [], writable: true, enumerable: false, configurable: true,
                });
                entry.psIsDynamic = false;
                entry.psLastRaw   = new Array(8).fill(null);
                entry.psLastRawTs = 0;
            }
        }

        currentState.freqRefs = isSpecialPI(pi) ? [] : getFreqRefs(currentState.freq);

        if (DEBUG && currentState.freqRefs.length > 0 && !isSpecialPI(pi)) {
            const inFmdx = currentState.freqRefs.some(
                r => r.pi === pi || (r.pireg && r.pireg === pi)
            );
            if (!inFmdx)
                logInfo(
                    `[${PLUGIN_NAME}] PI candidate ${pi} not in fmdx.org ` +
                    `(neither pi nor pireg) for ${currentState.freq} MHz – ` +
                    `ghost threshold (${GHOST_PI_THRESHOLD})`
                );
        }
    } else {
        piConfirmCount++;
    }

    const threshold = getConfirmThreshold(pi);

    if (!piConfirmed && piConfirmCount >= threshold) {
        if (!isPIAllowed(pi)) {
            piConfirmCount = 0;
            return;
        }
        piConfirmed = true;
        broadcast({ type: 'rdsm_raw', pi, freq: currentState.freq, errB });
        onPIConfirmed(pi);
    } else if (piConfirmed) {
        broadcast({
            type: 'rdsm_raw',
            pi,   freq: currentState.freq,
            b2:   b2hex, b3: b3hex, b4: b4hex,
            errB,
        });
    }

    if (!pi || pi === '----') return;
    decodeGroup(pi, b2hex, b3hex, b4hex, errB);
    if (piConfirmed) scheduleAIBroadcast(pi);
}

// ── AI broadcast scheduler ────────────────────────────────────
let _aiTimer = null;
function scheduleAIBroadcast(pi) {
    if (_aiTimer) return;
    _aiTimer = setTimeout(() => {
        _aiTimer = null;
        if (!piConfirmed || currentState.pi !== pi) return;
        const prediction = buildAIPrediction(pi);
        currentState.lastPrediction = prediction;
        broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() });
        if (rdsFollowMode) applyFollowToDataHandler();
    }, AI_BROADCAST_DELAY);
}

// ─────────────────────────────────────────────────────────────
//  BROADCAST HELPERS
// ─────────────────────────────────────────────────────────────
function broadcast(payload) {
    if (!pluginsWss) return;
    const msg = JSON.stringify(payload);
    pluginsWss.clients.forEach(c => {
        if (c.readyState === c.OPEN) try { c.send(msg); } catch(e) {}
    });
}

function broadcastToMainWss(payload) {   // eslint-disable-line no-unused-vars
    if (!pluginsMainWss) return;
    const msg = JSON.stringify(payload);
    pluginsMainWss.clients.forEach(c => {
        if (c.readyState === c.OPEN) try { c.send(msg); } catch(e) {}
    });
}

// ─────────────────────────────────────────────────────────────
//  hookDataHandler
// ─────────────────────────────────────────────────────────────
function stripRDSLines(data) {    // eslint-disable-line no-unused-vars
    return data.split('\n').filter(l => !l.startsWith('R')).join('\n');
}

function interceptLines(data) {
    for (const line of data.split('\n')) {
        const l = line.trim();
        if (l.startsWith('P') && l.length >= 5) {
            legacyPiCache = l.slice(1).trim();
        } else if (l.startsWith('T') && l.length >= 2) {
            const freq = (parseFloat(l.slice(1)) / 1000).toFixed(2);
            if (freq !== currentState.freq) {
                currentState.freq  = freq;
                currentFreq        = freq;
                currentState.pi    = null;
                piConfirmCount     = 0;
                piConfirmed        = false;
                piPendingBroadcast = false;
                psLocked           = false;
                lastBroadcastPS    = null;
                currentState.psBuf.fill(' ');
                currentState.psErrBuf.fill(3);
                currentState.psSegsSeen.clear();
                currentState.rtSlots = Array.from({length: 64}, () => ({ char: ' ', conf: 0 }));
                currentState.rtAB    = -1;
                currentState.afSet   = new Set();
                currentState.psRoundReceivedAfterConfirm = false;
                currentState.freqRefs = getFreqRefs(freq);
                currentState.lastPrediction = null;
                if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
                legacyPiCache = null;
                clearRDSInDataHandler();

                broadcast({
                    type:  'rdsm_freq',
                    freq,
                    reset: true,
                    pi:    null,
                    ps:    null,
                    stats: {
                        freq,
                        seenCount:     0,
                        psVoteTotal:   0,
                        psIsDynamic:   false,
                        psLocked:      false,
                        refStation:    null,
                        refDistKm:     null,
                        refMatchScore: 0,
                        pireg:         null,
                        piMain:        null,
                    },
                });

                const knownPI = findKnownPIForFreq(freq);
                if (knownPI) {
                    currentState.pi             = knownPI;
                    currentState.lastPrediction = buildAIPrediction(knownPI);
                    piPendingBroadcast          = true;
                    const knownEntry = db[knownPI];
                    const psName = (knownEntry?.psResolved || '').trim();
                    if (DEBUG) logInfo(`[${PLUGIN_NAME}] Pre-seeded PI ${knownPI}${psName ? ` = "${psName}"` : ''} from learned DB`);
                }
            }
        } else if (l.startsWith('R') && l.length >= 14) {
            parseAndDispatch(l.slice(1).trim());
        }
    }
}

function hookDataHandler(dh) {
    if (!dh || typeof dh.handleData !== 'function') return;
    const orig = dh.handleData.bind(dh);

    dh.handleData = function(wss, receivedData, rdsWss) {
        if (!pluginsMainWss && wss) pluginsMainWss = wss;

        interceptLines(receivedData);

        if (aiExclusiveMode) return;

        if (rdsFollowMode && piConfirmed) {

            applyFollowToDataHandler();

            const fields = [
                'pi', 'ps', 'ps_errors', 'pty', 'tp', 'ta', 'ms',
                'rt0', 'rt1', 'rt0_errors', 'rt1_errors', 'rt_flag',
                'ecc', 'country_iso', 'country_name', 'af'
            ];

            const lockedData = {};
            const lockedInit = {};

            fields.forEach(f => {
                lockedData[f] = dh.dataToSend[f];
                lockedInit[f] = dh.initialData[f];

                Object.defineProperty(dh.dataToSend, f, {
                    get: () => lockedData[f],
                    set: () => {},
                    configurable: true,
                    enumerable: true
                });

                Object.defineProperty(dh.initialData, f, {
                    get: () => lockedInit[f],
                    set: () => {},
                    configurable: true,
                    enumerable: true
                });
            });

            const result = orig.call(this, wss, receivedData, rdsWss);

            fields.forEach(f => {
                Object.defineProperty(dh.dataToSend, f, {
                    value: lockedData[f],
                    writable: true,
                    configurable: true,
                    enumerable: true
                });
                Object.defineProperty(dh.initialData, f, {
                    value: lockedInit[f],
                    writable: true,
                    configurable: true,
                    enumerable: true
                });
            });

            return result;
        }

        const result = orig.call(this, wss, receivedData, rdsWss);
        return result;
    };
    logInfo(`[${PLUGIN_NAME}] datahandler hooked`);
}

// ─────────────────────────────────────────────────────────────
//  WebSocket message handler
// ─────────────────────────────────────────────────────────────
function handlePluginMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'rdsm_get_rds_follow') {
        try { ws.send(JSON.stringify({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode })); }
        catch(e) {}
        return;
    }
    if (msg.type === 'rdsm_set_rds_follow') {
        const next = !!msg.enabled;
        if (next !== rdsFollowMode) {
            rdsFollowMode     = next;
            nativeRDSDisabled = next;
            dbDirty = true;
            logInfo(`[${PLUGIN_NAME}] RDS Follow ${next ? 'ENABLED' : 'DISABLED'}`);
            if (!next) clearRDSInDataHandler();
            else if (piConfirmed) applyFollowToDataHandler();
        }
        broadcast({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode });
        return;
    }
}

// ─────────────────────────────────────────────────────────────
//  API routes
// ─────────────────────────────────────────────────────────────
function registerAPIRoutes() {
    try {
        const app = pluginsApi.getHttpServer();
        if (!app) return;
        app.on('request', (req, res) => {
            if (req.method === 'GET' && req.url === '/api/rdsm/stats') {
                if (res.headersSent) return;
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    stationCount:  Object.keys(db).filter(k => k !== '_meta').length,
                    fmdxFreqCount: Object.keys(fmdxByFreq).length,
                    fmdxPICount:   Object.keys(fmdxByPI).length,
                    rdsFollowMode, aiExclusiveMode,
                    piConfirmed, psLocked,
                    currentPI:   currentState.pi,
                    currentFreq,
                }));
            }
        });
    } catch(e) {
        logWarn(`[${PLUGIN_NAME}] Could not register API routes: ${e.message}`);
    }
}

// ─────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────
function init() {
    loadOwnLocation();
    startGpsWsListener();
    loadDB();
    if (dataHandler) hookDataHandler(dataHandler);

    pluginsWss     = pluginsApi.getPluginsWss();
    pluginsMainWss = pluginsApi.getWss();

    if (pluginsWss) {
        pluginsWss.on('connection', (ws) => {
            ws.on('message', (raw) => handlePluginMessage(ws, raw));
        });
    }

    try { registerAPIRoutes(); } catch(e) {
        logWarn(`[${PLUGIN_NAME}] Could not register API routes: ${e.message}`);
    }

    loadFmdxBulk().catch(e => logWarn(`[${PLUGIN_NAME}] fmdx.org load error: ${e.message}`));

    logInfo(`[${PLUGIN_NAME}] v${pluginConfig.version} initialised`);
}

setTimeout(init, 500);