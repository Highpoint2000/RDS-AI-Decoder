///////////////////////////////////////////////////////////////
//                                                           //
//  RDS AI DECODER SERVER PLUGIN FOR FM-DX-WEBSERVER (V2.2)  //
//                                                           //
//  by Highpoint                last update: 2026-03-28      //
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
    version:      '2.2',
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
const GHOST_PI_THRESHOLD   = 8; // eslint-disable-line no-unused-vars

// ── Provisional → Locked tuning (DX use-case) ────────────────
const PROVISIONAL_MIN_CONF      = 0.55;
const LOCK_MIN_CONF             = 0.90;
const LOCK_MIN_STABLE_MS        = 700;
const LOCK_STRONG_EVIDENCE_CONF = 0.96;

// ── Rolling block-quality window ─────────────────────────────
const QUAL_WINDOW_SIZE   = 30;   // ~30 groups ≈ 1–2 s of reception
const QUAL_LOCK_MIN_ZERO = 0.55; // ≥55% of recent blocks must be err==0

// ── Special / wildcard PI codes ───────────────────────────────
const SPECIAL_PI_CODES = new Set(['FFFF', '0000']);
function isSpecialPI(pi) {
    return !pi || SPECIAL_PI_CODES.has(pi.toUpperCase());
}

// ── Module-level state ────────────────────────────────────────
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

let psLocked = false;

// Provisional tracking – updated ONLY inside buildAIPrediction()
let lastProvisionalPS      = null;
let provisionalFirstSeenTs = 0;
let lastLockReason         = null;

// Rolling block-quality window
let qualWindow = [];

let ownLat = null;
let ownLon = null;

let gpsWsClient      = null;
let gpsWsReconnTimer = null;
let gpsWsConnected   = false; // eslint-disable-line no-unused-vars

// ── fmdx.org index (declared early – used by helper functions below) ──
let fmdxByFreq   = {};
let fmdxLoadedAt = 0;
let fmdxByPI     = {};

// ── Database (declared early – used by helper functions below) ───────
let db      = {};
let dbDirty = false;
const DB_VERSION = 1;

// ═══════════════════════════════════════════════════════════════
//  CURRENT STATE  ← must be declared before ANY function that reads it
// ═══════════════════════════════════════════════════════════════
let currentState = {
    pi: null, freq: null,
    rtSlots:  Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 })),
    rtAB: -1,
    psSegsSeen: new Set(),
    psBuf:    new Array(8).fill(' '),
    psErrBuf: new Array(8).fill(3),
    psRoundComplete: false,
    psRoundReceivedAfterConfirm: false,
    lastPrediction: null,
    tp: false, ta: false, ms: -1, stereo: false,
    freqRefs: [],
    afSet: new Set(),
};

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
                            ownLat = lat; ownLon = lon;
                            if (fmdxLoadedAt > 0) {
                                try {
                                    const cached = JSON.parse(fs.readFileSync(FMDX_BULK_FILE, 'utf8'));
                                    if (cached && cached.raw) buildFmdxIndex(cached.raw);
                                } catch(e) { /* no cache yet */ }
                            }
                        }
                    }
                }
            } catch(e) { /* ignore */ }
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
                ownLat = lat; ownLon = lon;
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
        const req = mod.get(url, { timeout: 60000 }, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        });
        req.on('error',   reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ── fmdx.org bulk data load ───────────────────────────────────
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
    logInfo(`[${PLUGIN_NAME}] fmdx.org downloading: ${url}`);
    let raw;
    try {
        if (typeof fetch === 'function') {
            const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
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
    logInfo(`[${PLUGIN_NAME}] fmdx.org download complete – ${txCount} tx locations`);
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
            const piRegUp = st.pireg ? st.pireg.toUpperCase() : null;

            const entry = {
                pi: piUp, pireg: piRegUp,
                psVariants: parsePSVariants(st.ps),
                station: st.station || txName,
                lat: txLat, lon: txLon, distKm,
            };

            if (!byFreq[f]) byFreq[f] = [];
            byFreq[f].push(entry);

            if (!byPI[piUp]) byPI[piUp] = [];
            byPI[piUp].push({ freq: f, distKm, station: entry.station,
                psVariants: entry.psVariants, pireg: piRegUp });

            if (piRegUp && piRegUp !== piUp) {
                if (!byPI[piRegUp]) byPI[piRegUp] = [];
                byPI[piRegUp].push({ freq: f, distKm, station: entry.station,
                    psVariants: entry.psVariants, pireg: piRegUp, piMain: piUp });
            }
            totalEntries++;
        }
    }

    for (const f  of Object.keys(byFreq)) byFreq[f].sort((a, b) => a.distKm - b.distKm);
    for (const pi of Object.keys(byPI))   byPI[pi].sort((a, b) => a.distKm - b.distKm);

    fmdxByFreq = byFreq;
    fmdxByPI   = byPI;

    logInfo(
        `[${PLUGIN_NAME}] fmdx.org index built: ${totalEntries} entries on ` +
        `${Object.keys(byFreq).length} frequencies, ` +
        `${Object.keys(byPI).length} unique PI/PIreg codes ` +
        `(${skippedDist} tx outside ${FMDX_RADIUS_KM} km)`
    );
}

function getFreqRefs(freq) {
    const f    = roundFreq(freq);
    const refs = fmdxByFreq[f] || [];
    if (DEBUG) logInfo(`[${PLUGIN_NAME}] getFreqRefs: "${f}" → ${refs.length} entry(s)`);
    return refs;
}

function getAltFreqsForPI(pi) {
    if (!pi || pi === '----' || pi === '?') return [];
    return fmdxByPI[pi.toUpperCase()] || [];
}

function getAltFreqsForPIAndPS(pi, confirmedPS) {
    const all = getAltFreqsForPI(pi);
    if (!confirmedPS || typeof confirmedPS !== 'string' || confirmedPS.trim().length === 0)
        return all;
    const normConfirmed = confirmedPS.trim().toUpperCase();
    const filtered = all.filter(item => {
        if (!item.psVariants || item.psVariants.length === 0) return false;
        return item.psVariants.some(v => {
            const normV = v.trim().toUpperCase();
            if (!normV) return false;
            return normV === normConfirmed ||
                   normConfirmed.startsWith(normV) ||
                   normV.startsWith(normConfirmed);
        });
    });
    return filtered.length > 0 ? filtered : all;
}

// ── datahandler ───────────────────────────────────────────────
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

// ── Check that a PS string contains only printable characters ─
function isPSStringClean(ps) {
    if (!ps || typeof ps !== 'string') return false;
    for (let i = 0; i < ps.length; i++) {
        const code = ps.charCodeAt(i);
        if (code < 0x20) return false;
        if (code >= 0x7F && code < 0xA0) return false;
    }
    return true;
}

// ═══════════════════════════════════════════════════════════════
//  ROLLING BLOCK-QUALITY WINDOW
// ═══════════════════════════════════════════════════════════════

function updateQualWindow(errB) {
    const zeroCount = errB.filter(e => e === 0).length;
    qualWindow.push(zeroCount);
    if (qualWindow.length > QUAL_WINDOW_SIZE) qualWindow.shift();
}

function recentZeroErrFraction() {
    if (qualWindow.length === 0) return 0;
    const totalSlots = qualWindow.length * 4;
    const zeroSlots  = qualWindow.reduce((s, n) => s + n, 0);
    return zeroSlots / totalSlots;
}

function qualityAllowsLock() {
    if (qualWindow.length < 5) return false;
    return recentZeroErrFraction() >= QUAL_LOCK_MIN_ZERO;
}

// ═══════════════════════════════════════════════════════════════
//  ECC COUNTRY PLAUSIBILITY  (soft penalty only – never hard block)
// ═══════════════════════════════════════════════════════════════

// Returns a multiplier (0.0–1.0).
//   1.0 = country matches, no ECC yet, or PI not confirmed (no penalty)
//   0.5 = ECC decoded + confirmed, but country does not match ref
//
// Fix: only apply penalty when piConfirmed is true AND the ECC entry
// exists in a db entry whose PI matches the current confirmed PI, to
// avoid spurious penalties from stale ECC data of a previous station.
function eccCountryMultiplier(refEntry) {
    if (!refEntry) return 1.0;
    // Gate: only penalise when PI is fully confirmed
    if (!piConfirmed) return 1.0;
    const pi      = currentState.pi;
    const dbEntry = (pi && !isSpecialPI(pi)) ? db[pi] : null;
    if (!dbEntry?.ecc) return 1.0; // no ECC for this PI yet → no penalty

    const eccByte    = parseInt(dbEntry.ecc, 16);
    const currentISO = (() => {
        const c = lookupCountry(pi, eccByte);
        return c ? c.iso : null;
    })();
    if (!currentISO) return 1.0; // cannot determine expected country

    // Compare against the country implied by the ref's PI code + same ECC byte
    const refCountry = lookupCountry(refEntry.pi, eccByte);
    if (refCountry && refCountry.iso === currentISO) return 1.0;

    // Soft penalty
    return 0.5;
}

// ═══════════════════════════════════════════════════════════════
//  AF NETWORK COVERAGE
// ═══════════════════════════════════════════════════════════════

// Returns fraction 0..1 of fmdx.org altFreqs actually received.
// Fix: build a single receivedFreqSet (afSet + current freq) to avoid
// double-counting when current freq is already in afSet.
function computeAFCoverage(pi) {
    if (!pi || isSpecialPI(pi)) return 0;
    const altFreqs = getAltFreqsForPI(pi);
    if (altFreqs.length === 0) return 0;

    const dbFreqs = new Set(altFreqs.map(item => parseFloat(item.freq).toFixed(1)));
    if (dbFreqs.size === 0) return 0;

    // Build a unified set of received frequencies (no duplicates)
    const receivedFreqSet = new Set();
    for (const f of currentState.afSet)
        receivedFreqSet.add(parseFloat(f).toFixed(1));
    if (currentState.freq)
        receivedFreqSet.add(parseFloat(currentState.freq).toFixed(1));

    let matched = 0;
    for (const dbFreq of dbFreqs) {
        if (receivedFreqSet.has(dbFreq)) matched++;
    }
    return Math.min(1, matched / dbFreqs.size);
}

// ═══════════════════════════════════════════════════════════════
//  PROVISIONAL HELPERS
// ═══════════════════════════════════════════════════════════════

function countCleanRawPositions() {
    let n = 0;
    for (let i = 0; i < 8; i++) {
        const e = currentState.psErrBuf?.[i] ?? 3;
        const c = currentState.psBuf?.[i] ?? ' ';
        if (e <= 1 && c && c !== ' ') n++;
    }
    return n;
}

// Station-level confidence score (0..1).
function computeStationConfidence(pi) {
    if (!pi || pi === '----' || pi === '?') return 0;
    if (isSpecialPI(pi)) return 0.8;

    const entry = db[pi] || null;
    const ref   = findRefEntry(pi);

    const cleanRawPos = countCleanRawPositions();
    const rawFactor   = Math.min(1, cleanRawPos / 8);

    // ECC-weighted ref match score
    const baseRefScore = computeRefMatchScore(pi);
    const eccMult      = ref ? eccCountryMultiplier(ref) : 1.0;
    const refFactor    = ref ? (baseRefScore * eccMult) : 0;

    const votedAvg = entry?.psConf
        ? entry.psConf.reduce((a, b) => a + b, 0) / 8
        : 0;

    const afterConfirmBonus = currentState.psRoundReceivedAfterConfirm ? 0.10 : 0.0;
    const dynamicPenalty    = (entry?.psIsDynamic || (ref?.psVariants?.length > 1)) ? 0.15 : 0.0;

    // ECC country adjustment: +0.08 on match, -0.15 on mismatch
    // Only applied when piConfirmed (eccCountryMultiplier handles the gate)
    let eccAdjust = 0.0;
    if (entry?.ecc && ref && piConfirmed) {
        eccAdjust = eccMult >= 1.0 ? +0.08 : -0.15;
    }

    // AF network coverage bonus (up to +0.10, only when coverage ≥ 50%)
    const afCoverage      = computeAFCoverage(pi);
    const afCoverageBonus = afCoverage >= 0.5 ? afCoverage * 0.10 : 0.0;

    let conf = (rawFactor * 0.42) +
               (refFactor * 0.33) +
               (votedAvg  * 0.18) +
               afterConfirmBonus +
               afCoverageBonus +
               eccAdjust -
               dynamicPenalty;
    return Math.min(1, Math.max(0, conf));
}

// Best-effort provisional PS string (8 chars), or null.
function computeProvisionalPS(pi) {
    if (!pi || pi === '----' || pi === '?') return null;
    if (psLocked && lastBroadcastPS)
        return lastBroadcastPS.padEnd(8, ' ').slice(0, 8);

    const entry = (!isSpecialPI(pi) && db[pi]) ? db[pi] : null;
    const ref   = findRefEntry(pi);

    if (entry?.psVerifiedRaw && isPSStringClean(entry.psVerifiedRaw) &&
        entry.psVerifiedRaw.trim().length > 0)
        return entry.psVerifiedRaw.padEnd(8, ' ').slice(0, 8);

    if (ref?.psVariants?.length) {
        let bestVariant = ref.psVariants[0];
        let bestScore   = 0;
        const psUpper   = currentState.psBuf.join('').toUpperCase();
        for (const v of ref.psVariants) {
            const rv = v.toUpperCase().padEnd(8, ' ');
            const pb = psUpper.padEnd(8, ' ');
            let m = 0, c = 0;
            for (let i = 0; i < 8; i++) {
                if ((currentState.psErrBuf[i] ?? 3) <= 1 && rv[i] !== ' ') {
                    c++;
                    if (rv[i] === pb[i]) m++;
                }
            }
            const s = c > 0 ? (m / c) : 0;
            if (s > bestScore) { bestScore = s; bestVariant = v; }
        }
        let hybrid = '';
        const refStr = bestVariant.padEnd(8, ' ');
        for (let i = 0; i < 8; i++) {
            const rawChar = currentState.psBuf[i] || ' ';
            const rawErr  = currentState.psErrBuf[i] ?? 3;
            const refChar = refStr[i] || ' ';
            hybrid += (rawErr <= 1 && rawChar !== ' ' &&
                       rawChar.toUpperCase() === refChar.toUpperCase())
                ? rawChar : refChar;
        }
        return hybrid.padEnd(8, ' ').slice(0, 8);
    }

    if (entry?.psResolved && entry.psResolved.trim().length > 0)
        return entry.psResolved.padEnd(8, ' ').slice(0, 8);

    if (countCleanRawPositions() >= 4 && currentState.psRoundReceivedAfterConfirm)
        return currentState.psBuf.join('').padEnd(8, ' ').slice(0, 8);

    return null;
}

// ═══════════════════════════════════════════════════════════════
//  fmdx.org REFERENCE MATCHING
//  (declared before database / vote engine because computeStationConfidence
//   calls computeRefMatchScore which calls findRefEntry)
// ═══════════════════════════════════════════════════════════════

function findBestRefEntry(pi) {
    if (!currentState.freqRefs || !pi || !currentState.freq) return null;
    if (isSpecialPI(pi)) return null;
    const piUp = pi.toUpperCase();
    const exact = currentState.freqRefs.filter(r => r.pi === piUp);
    if (exact.length >= 1)
        return exact.sort((a, b) => (a.distKm ?? 99999) - (b.distKm ?? 99999))[0];
    const pireg = currentState.freqRefs.filter(r => r.pireg && r.pireg === piUp);
    if (pireg.length >= 1)
        return pireg.sort((a, b) => (a.distKm ?? 99999) - (b.distKm ?? 99999))[0];
    return null;
}
function findRefEntry(pi) { return findBestRefEntry(pi); }

function computeRefMatchScore(pi) {
    if (isSpecialPI(pi)) return 0;
    const ref  = findRefEntry(pi);
    if (!ref?.psVariants?.length) return 0;
    const buf  = currentState.psBuf;
    const errB = currentState.psErrBuf || new Array(8).fill(3);
    const cleanPositions = buf.map((_, i) => errB[i] <= 1);
    const cleanCount     = cleanPositions.filter(Boolean).length;

    let best = 0;
    if (cleanCount < 2) {
        const entry = db[pi];
        if (!entry?.psResolved) return 0;
        const resolved = entry.psResolved.toUpperCase().padEnd(8, ' ');
        for (const variant of ref.psVariants) {
            const rv = variant.toUpperCase().padEnd(8, ' ');
            let m = 0, c = 0;
            for (let i = 0; i < 8; i++) { c++; if (rv[i] === resolved[i]) m++; }
            const s = c > 0 ? m / c : 0;
            if (s > best) best = s;
        }
    } else {
        for (const variant of ref.psVariants) {
            const rv = variant.toUpperCase().padEnd(8, ' ');
            let m = 0, c = 0;
            for (let i = 0; i < 8; i++) {
                if (!cleanPositions[i]) continue;
                c++;
                if (rv[i] === (buf[i] || ' ').toUpperCase()) m++;
            }
            const s = c > 0 ? m / c : 0;
            if (s > best) best = s;
        }
    }

    // Apply ECC country multiplier (soft penalty, never hard block)
    return best * eccCountryMultiplier(ref);
}

function isPIAllowed(pi) {
    if (!pi || pi === '----') return false;
    if (isSpecialPI(pi)) return true;
    const refs = currentState.freqRefs;
    if (!refs || refs.length === 0) return true;
    const piUp = pi.toUpperCase();
    if (DEBUG && !refs.some(r => r.pi === piUp || (r.pireg && r.pireg === piUp)))
        logInfo(`[${PLUGIN_NAME}] PI ${piUp} not in fmdx.org for ${currentState.freq} MHz – allowing anyway`);
    return true;
}

// Dynamic PI confirmation threshold
function getConfirmThreshold(pi) {
    if (isSpecialPI(pi)) return PI_CONFIRM_THRESHOLD;
    const refs = currentState.freqRefs;

    let threshold = PI_CONFIRM_THRESHOLD;
    if (refs && refs.length > 0) {
        const piUp   = pi ? pi.toUpperCase() : '';
        const inFmdx = refs.some(r => r.pi === piUp || (r.pireg && r.pireg === piUp));
        if (!inFmdx) return PI_CONFIRM_THRESHOLD;
        const ref = findRefEntry(pi);
        if ((ref?.distKm ?? 9999) < 500) threshold = 1;
    }

    // Evidence bonuses: each lowers threshold (floor 1)
    let evidenceScore = 0;
    const entry = db[pi];
    if (entry?.ecc)                        evidenceScore++;
    if (entry?.af && entry.af.length >= 2) evidenceScore++;
    if (recentZeroErrFraction() >= 0.75)   evidenceScore++;
    if (countCleanRawPositions() >= 5)     evidenceScore++;

    threshold = Math.max(1, threshold - Math.floor(evidenceScore / 2));
    return threshold;
}

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!raw._meta || raw._meta.dbVersion !== DB_VERSION) {
                logInfo(`[${PLUGIN_NAME}] Old DB structure – one-time wipe for schema update`);
                let preservedFollowMode = false;
                if (raw._meta && typeof raw._meta.rdsFollowMode === 'boolean')
                    preservedFollowMode = raw._meta.rdsFollowMode;
                rdsFollowMode     = preservedFollowMode;
                nativeRDSDisabled = preservedFollowMode;
                if (preservedFollowMode)
                    logInfo(`[${PLUGIN_NAME}] RDS Follow state preserved across wipe: ON`);
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
                if (isSpecialPI(pi)) { delete raw[pi]; continue; }
                delete entry.rt; delete entry.rtLast; delete entry.psDynamicBuf;
                if (entry.ps && typeof entry.ps === 'object') {
                    for (const [posKey, posData] of Object.entries(entry.ps)) {
                        if (!posData || typeof posData !== 'object') continue;
                        if (posData.votes && typeof posData.votes === 'object') {
                            const migrated = {};
                            for (const [ch, arr] of Object.entries(posData.votes)) {
                                if (!Array.isArray(arr) || arr.length === 0) continue;
                                const totalW = arr.reduce((s, e) => s + (e.w || 0), 0);
                                const times  = arr.map(e => e.ts || 0).filter(Boolean);
                                migrated[ch] = {
                                    w: totalW, count: arr.length,
                                    firstSeen: times.length ? Math.min(...times) : Date.now(),
                                    lastSeen:  times.length ? Math.max(...times) : Date.now(),
                                };
                            }
                            raw[pi].ps[posKey] = migrated;
                        }
                    }
                }
                if (entry.freq) entry.freq = roundFreq(entry.freq);
                if (!Array.isArray(entry.af)) entry.af = [];
                if (entry.psVerifiedRaw && !isPSStringClean(entry.psVerifiedRaw)) {
                    if (DEBUG) logInfo(`[${PLUGIN_NAME}] Discarding corrupt psVerifiedRaw for PI=${pi} on load`);
                    entry.psVerifiedRaw = null; entry.psVerifiedRawTs = 0;
                }
            }
            db = raw;
            logInfo(`[${PLUGIN_NAME}] AI memory loaded: ${Object.keys(db).filter(k => k !== '_meta').length} stations`);
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
            if (isSpecialPI(pi)) continue;
            if ((now - (entry.seen || 0)) > expireMs) continue;
            const hasPS     = entry.ps && Object.keys(entry.ps).length > 0;
            const hasUseful = hasPS || entry.ecc || (entry.pty > 0) ||
                              (Array.isArray(entry.af) && entry.af.length > 0);
            if (!hasUseful && (entry.seenCount || 0) <= 2 &&
                (now - (entry.seen || 0)) > quickExpireMs) continue;
            if (entry.psVerifiedRaw && !isPSStringClean(entry.psVerifiedRaw)) {
                entry.psVerifiedRaw = null; entry.psVerifiedRawTs = 0;
            }
            const { psDynamicBuf, ...saveable } = entry; // eslint-disable-line no-unused-vars
            toSave[pi] = saveable;
        }
        const stationKeys = Object.keys(toSave).filter(k => k !== '_meta');
        if (stationKeys.length > MAX_STATIONS) {
            stationKeys.sort((a, b) => (toSave[a].seen || 0) - (toSave[b].seen || 0))
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
            ecc: null, af: [], seen: Date.now(), seenCount: 0,
        };
        Object.defineProperty(db[pi], 'psDynamicBuf', {
            value: [], writable: true, enumerable: false, configurable: true,
        });
    } else {
        if (!db[pi].psDynamicBuf)
            Object.defineProperty(db[pi], 'psDynamicBuf', {
                value: [], writable: true, enumerable: false, configurable: true,
            });
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
        const avgConf = entry.psConf ? entry.psConf.reduce((a, b) => a + b, 0) / 8 : 0;
        const score   = Math.log10(Math.max(1, entry.seenCount)) * 0.5 + avgConf * 0.5;
        if (score > bestScore) { bestScore = score; bestPI = pi; }
    }
    return bestPI;
}

function cacheAF(pi, freqMHz) {
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
    return Array.from({ length: 8 }, (_, i) => {
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
    if (isSpecialPI(pi)) return;
    const entry = ensurePI(pi);
    const buf   = entry.psDynamicBuf;
    buf.push(psString);
    if (buf.length > 8) buf.shift();
    if (buf.length < 3) return;
    if (!entry.psIsDynamic) {
        entry.psIsDynamic = detectScrollPS(buf) || detectChangingPS(buf);
        if (entry.psIsDynamic) {
            entry.ps = {}; entry.psResolved = null;
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
    if (isSpecialPI(pi)) return;
    if (!piConfirmed) return; // never lock before PI is confirmed
    const entry = pi ? db[pi] : null;
    if (!entry) return;

    const ref         = findRefEntry(pi);
    const stationConf = computeStationConfidence(pi);

    // Read stability duration from module-level vars (written only in buildAIPrediction)
    const stableMs = (lastProvisionalPS && provisionalFirstSeenTs)
        ? (Date.now() - provisionalFirstSeenTs) : 0;

    const allRawVerified = currentState.psErrBuf.every(e => e <= 1) &&
                           currentState.psBuf.every(c => c && c !== ' ') &&
                           currentState.psRoundReceivedAfterConfirm;

    // fmdx.org best variant matching
    let bestVariant = null, bestScore = 0;
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

    // Strong evidence: near-perfect ref + many clean positions
    const strongEvidence = (computeRefMatchScore(pi) >= 0.98 && countCleanRawPositions() >= 6);

    // Lock gate: qualityAllowsLock() uses rolling block-error window
    const allowLock =
        strongEvidence ||
        (stationConf >= LOCK_MIN_CONF &&
         stableMs    >= LOCK_MIN_STABLE_MS &&
         (qualityAllowsLock() || countCleanRawPositions() >= 7)) ||
        (stationConf >= LOCK_STRONG_EVIDENCE_CONF && qualityAllowsLock());

    const buildHybridPS = (referenceStr) => {
        let h = '';
        const cr = referenceStr.padEnd(8, ' ');
        for (let i = 0; i < 8; i++) {
            const rc = currentState.psBuf[i] || ' ';
            const re = currentState.psErrBuf[i];
            h += (re <= 1 && rc.toUpperCase() === cr[i].toUpperCase()) ? rc : cr[i];
        }
        return h;
    };

    if (!psLocked) {
        if (!allowLock) return;

        let newPS = null, lockReason = '';

        if (entry.psVerifiedRaw && isPSStringClean(entry.psVerifiedRaw) &&
            entry.psVerifiedRaw.trim().length > 0) {
            if (ref?.psVariants?.length > 0) {
                if (refMatchIsGood && bestScore >= 0.8) newPS = buildHybridPS(bestVariant);
                else if (!ref?.psVariants?.length)      newPS = entry.psVerifiedRaw;
            } else {
                newPS = entry.psVerifiedRaw;
            }
            if (newPS) lockReason = 'DB verified string';
        }

        if (!newPS && refMatchIsGood) {
            newPS = buildHybridPS(bestVariant);
            lockReason = `FMDX match ${Math.round(bestScore * 100)}%`;
        }

        if (!newPS && allRawVerified) {
            const candidate = currentState.psBuf.join('');
            if (isPSStringClean(candidate)) {
                newPS = candidate;
                if (ref?.psVariants?.length > 0) {
                    const nu = newPS.trim().toUpperCase();
                    if (ref.psVariants.some(v =>
                        v.trim().toUpperCase() === nu ||
                        v.trim().toUpperCase().startsWith(nu) ||
                        nu.startsWith(v.trim().toUpperCase()))) {
                        entry.psVerifiedRaw = newPS; entry.psVerifiedRawTs = Date.now();
                        dbDirty = true;
                    }
                } else {
                    entry.psVerifiedRaw = newPS; entry.psVerifiedRawTs = Date.now();
                    dbDirty = true;
                }
                lockReason = 'Raw RDS fully verified';
            }
        }

        if (newPS) {
            psLocked = true; lastBroadcastPS = newPS; lastLockReason = lockReason;
            if (DEBUG) logInfo(`[${PLUGIN_NAME}] PS locked for PI=${pi}: "${newPS}" (${lockReason})`);
            if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
            const prediction = buildAIPrediction(pi);
            currentState.lastPrediction = prediction;
            setTimeout(() => {
                broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() });
                if (rdsFollowMode) applyFollowToDataHandler();
            }, AI_BROADCAST_DELAY);
        }
    } else {
        // Already locked – handle dynamic FMDX variant jump
        if (ref?.psVariants?.length > 1 && refMatchIsGood) {
            const cu = (lastBroadcastPS || '').toUpperCase().padEnd(8, ' ');
            const bv = bestVariant.toUpperCase().padEnd(8, ' ');
            if (cu !== bv) {
                lastBroadcastPS = buildHybridPS(bestVariant);
                entry.psIsDynamic = true; dbDirty = true;
                if (DEBUG) logInfo(`[${PLUGIN_NAME}] Dynamic FMDX PS jump for PI=${pi}: "${lastBroadcastPS}"`);
                if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
                const prediction = buildAIPrediction(pi);
                currentState.lastPrediction = prediction;
                setTimeout(() => {
                    broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() });
                    if (rdsFollowMode) applyFollowToDataHandler();
                }, AI_BROADCAST_DELAY);
            }
        }
        // Live DB improvement on clean round
        if (allRawVerified) {
            const freshPS = currentState.psBuf.join('');
            if (isPSStringClean(freshPS)) {
                const fu = freshPS.trim().toUpperCase();
                const eu = (entry.psVerifiedRaw || '').trim().toUpperCase();
                if (fu !== eu) {
                    const ok = !ref?.psVariants?.length ||
                        ref.psVariants.some(v =>
                            v.trim().toUpperCase() === fu ||
                            v.trim().toUpperCase().startsWith(fu) ||
                            fu.startsWith(v.trim().toUpperCase()));
                    if (ok) {
                        entry.psVerifiedRaw = freshPS; entry.psVerifiedRawTs = Date.now();
                        dbDirty = true;
                        if (DEBUG) logInfo(`[${PLUGIN_NAME}] DB improved psVerifiedRaw for PI=${pi}: "${freshPS}"`);
                    }
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
            lastBroadcastPS = psStr;
            dataHandler.dataToSend.ps = psStr;
        }
        if (entry.pty >= 0) dataHandler.dataToSend.pty = entry.pty;
        if (currentState.freq) dataHandler.dataToSend.freq = currentState.freq;
    }, 500);
}

function normPS(s) { return (!s || typeof s !== 'string') ? s : s; }

function buildPSString(pi) {
    const entry = db[pi];
    if (!entry) return '';
    if (entry.psIsDynamic) {
        const raw = entry.psLastRaw || [];
        if (raw.every(c => c !== null)) return raw.map(c => c || ' ').join('');
        return '';
    }
    if (entry.psVerifiedRaw && isPSStringClean(entry.psVerifiedRaw))
        return entry.psVerifiedRaw;
    return entry.psResolved || '';
}

// ═══════════════════════════════════════════════════════════════
//  DATAHANDLER HELPERS
// ═══════════════════════════════════════════════════════════════
function clearRDSInDataHandler() {
    if (!dataHandler) return;
    const rdsFields = {
        pi: '?', ps: '', ps_errors: '', pty: 0, tp: 0, ta: 0, ms: -1,
        rt0: '', rt1: '', rt0_errors: '', rt1_errors: '', rt_flag: '',
        rds: false, ecc: null, country_name: '', country_iso: 'UN',
    };
    Object.assign(dataHandler.dataToSend,  rdsFields);
    Object.assign(dataHandler.initialData, rdsFields);
    if (Array.isArray(dataHandler.dataToSend.af))  dataHandler.dataToSend.af.length  = 0;
    if (Array.isArray(dataHandler.initialData.af)) dataHandler.initialData.af.length = 0;
    else dataHandler.initialData.af = dataHandler.dataToSend.af;
    piConfirmCount = 0; piConfirmed = false; piPendingBroadcast = false;
    currentState.lastPrediction = null;
}

function applyAFToDataHandler() {
    if (!dataHandler || !rdsFollowMode) return;
    if (!Array.isArray(dataHandler.dataToSend.af)) dataHandler.dataToSend.af = [];
    dataHandler.dataToSend.af.length = 0;
    for (const f of currentState.afSet)
        dataHandler.dataToSend.af.push(Math.round(parseFloat(f) * 1000));
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
        if (entry?.psVerifiedRaw && isPSStringClean(entry.psVerifiedRaw) &&
            entry.psVerifiedRaw.trim().length > 0) return entry.psVerifiedRaw;
        if (entry?.psResolved && entry.psResolved.trim().length > 0 &&
            !entry.psResolved.includes('?')) return entry.psResolved;
        return null;
    };

    if (isSpecialPI(pi)) {
        const rawPS      = currentState.psBuf.join('');
        const hasContent = rawPS.trim().length > 0 && currentState.psErrBuf.every(e => e <= 1);
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

    if (!lastBroadcastPS) {
        const dbStr = getDbMixedCasePS();
        if (dbStr) lastBroadcastPS = dbStr;
        else if (ref?.psVariants?.length > 0) lastBroadcastPS = ref.psVariants[0].padEnd(8, ' ');
    }

    const isDynamic          = (entry?.psIsDynamic || false) || (ref?.psVariants?.length > 1);
    const isScrollingNonFmdx = entry?.psIsDynamic && (!ref?.psVariants || ref.psVariants.length <= 1);

    if (psLocked && lastBroadcastPS && !isScrollingNonFmdx) {
        dataHandler.dataToSend.ps        = lastBroadcastPS;
        dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
        dataHandler.initialData.ps       = lastBroadcastPS;
    } else if (isScrollingNonFmdx) {
        const raw      = entry?.psLastRaw;
        const rawClean = currentState.psErrBuf.every(e => e <= 1);
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
            dataHandler.dataToSend.ps = '        '; dataHandler.dataToSend.ps_errors = '';
        }
    } else if (isDynamic) {
        if (ref?.psVariants?.length > 0) {
            let bv = null, bs = 0;
            for (const v of ref.psVariants) {
                const rv = v.toUpperCase().padEnd(8, ' ');
                const pb = currentState.psBuf.join('').toUpperCase().padEnd(8, ' ');
                let m = 0, c = 0;
                for (let i = 0; i < 8; i++) {
                    if (rv[i] !== ' ' && currentState.psErrBuf[i] <= 1) { c++; if (rv[i] === pb[i]) m++; }
                }
                const s = c > 0 ? m / c : 0;
                if (s > bs) { bs = s; bv = v; }
            }
            if (bv && bs >= 0.5) {
                const psStr = getDbMixedCasePS() || bv.padEnd(8, ' ');
                lastBroadcastPS = psStr;
                dataHandler.dataToSend.ps        = psStr;
                dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
                dataHandler.initialData.ps       = psStr;
            } else if (lastBroadcastPS) {
                dataHandler.dataToSend.ps        = lastBroadcastPS;
                dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
                dataHandler.initialData.ps       = lastBroadcastPS;
            } else {
                dataHandler.dataToSend.ps = '        '; dataHandler.dataToSend.ps_errors = '';
            }
        }
    } else if (pred?.ps && Array.isArray(pred.ps)) {
        if (computeRefMatchScore(pi) >= 0.8 && ref?.psVariants?.length > 0) {
            const dbStr = getDbMixedCasePS();
            let psStr;
            if (dbStr) {
                psStr = dbStr;
            } else {
                let bv = ref.psVariants[0], bs = 0;
                for (const v of ref.psVariants) {
                    const rv = v.toUpperCase().padEnd(8, ' ');
                    const pb = currentState.psBuf.join('').toUpperCase().padEnd(8, ' ');
                    let m = 0, c = 0;
                    for (let i = 0; i < 8; i++) {
                        if (rv[i] !== ' ' && currentState.psErrBuf[i] <= 1) { c++; if (rv[i] === pb[i]) m++; }
                    }
                    const s = c > 0 ? m / c : 0;
                    if (s > bs) { bs = s; bv = v; }
                }
                let h = '';
                const cv = bv.padEnd(8, ' ');
                for (let i = 0; i < 8; i++) {
                    const rc = currentState.psBuf[i] || ' ';
                    const re = currentState.psErrBuf[i];
                    h += (re <= 1 && rc.toUpperCase() === cv[i].toUpperCase()) ? rc : cv[i];
                }
                psStr = h;
            }
            lastBroadcastPS = psStr;
            dataHandler.dataToSend.ps        = psStr;
            dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
            dataHandler.initialData.ps       = psStr;
        } else {
            const goodSlots = pred.ps.filter(s =>
                s && s.src !== 'empty' && s.src !== 'ai-bigram' && s.conf >= 0.5).length;
            if (goodSlots >= 4 || lastBroadcastPS) {
                const psStr = pred.ps.map(s =>
                    (s && s.src !== 'empty' && s.src !== 'ai-bigram' && s.char) ? s.char : ' ').join('');
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
        dataHandler.dataToSend.ps = '        '; dataHandler.dataToSend.ps_errors = '';
    }

    if (dataHandler.dataToSend.ps)  dataHandler.dataToSend.ps  = normPS(dataHandler.dataToSend.ps);
    if (dataHandler.initialData.ps) dataHandler.initialData.ps = normPS(dataHandler.initialData.ps);
    if (lastBroadcastPS)            lastBroadcastPS             = normPS(lastBroadcastPS);

    dataHandler.dataToSend.pty = (entry?.pty >= 0) ? entry.pty : 0;
    dataHandler.dataToSend.tp  = currentState.tp ? 1 : 0;
    dataHandler.dataToSend.ta  = currentState.ta ? 1 : 0;
    dataHandler.dataToSend.ms  = currentState.ms;

    const rtLive = buildRTString();
    const rtSrc  = rtLive.trim().length >= 3 ? rtLive
                 : (pred?.rt?.text?.trim().length >= 3 ? pred.rt.text : null);
    if (rtSrc) {
        const rtFlag = currentState.rtAB >= 0 ? currentState.rtAB : 0;
        if (rtFlag === 0) { dataHandler.dataToSend.rt0 = rtSrc; dataHandler.dataToSend.rt0_errors = ''; }
        else              { dataHandler.dataToSend.rt1 = rtSrc; dataHandler.dataToSend.rt1_errors = ''; }
        dataHandler.dataToSend.rt_flag  = rtFlag;
        dataHandler.initialData.rt0     = dataHandler.dataToSend.rt0;
        dataHandler.initialData.rt1     = dataHandler.dataToSend.rt1;
        dataHandler.initialData.rt_flag = rtFlag;
    } else {
        dataHandler.dataToSend.rt0 = ''; dataHandler.dataToSend.rt1 = '';
        dataHandler.dataToSend.rt0_errors = ''; dataHandler.dataToSend.rt1_errors = '';
        dataHandler.initialData.rt0 = ''; dataHandler.initialData.rt1 = '';
    }

    const eccByte = entry?.ecc ? parseInt(entry.ecc, 16) : null;
    if (eccByte) {
        dataHandler.dataToSend.ecc = eccByte;
        const country = lookupCountry(pi, eccByte);
        dataHandler.dataToSend.country_iso  = country ? country.iso  : 'UN';
        dataHandler.dataToSend.country_name = country ? country.name : '';
    }

    dataHandler.dataToSend.rds = !!(pi && pi !== '?');
    applyAFToDataHandler();
}

// ═══════════════════════════════════════════════════════════════
//  GROUP DECODING
// ═══════════════════════════════════════════════════════════════
function decodeGroup(pi, b2hex, b3hex, b4hex, errB) {
    if (!b2hex) return;

    // Update rolling block-quality window for every decoded group
    updateQualWindow(errB);

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

    const entry = isSpecialPI(pi) ? null : ensurePI(pi);
    if (entry) {
        entry.seenCount++; entry.seen = Date.now();
        if (currentState.freq) entry.freq = roundFreq(currentState.freq);
        if (blkAok && blkBok) { entry.tp = tp; currentState.tp = tp; if (pty > 0) entry.pty = pty; }
        dbDirty = true;
    } else {
        if (blkAok && blkBok) currentState.tp = tp;
    }

    // ── Group 0A ─────────────────────────────────────────────
    if (gT === 0 && vB === 0) {
        if (blkAok && blkBok) {
            const ta  = !!((g2 >> 4) & 0x01);
            const ms  = !!((g2 >> 3) & 0x01);
            const seg =    g2 & 0x03;
            const di  = !!((g2 >> 2) & 0x01);
            if (entry) { entry.ta = ta; entry.ms = ms ? 1 : 0; }
            currentState.ta = ta; currentState.ms = ms ? 1 : 0;
            if (seg === 3) { if (entry) entry.stereo = di; currentState.stereo = di; }
        }
        if (b3hex && errB[2] <= 1 && blkAok && blkBok) {
            const af1 = (g3 >> 8) & 0xFF, af2 = g3 & 0xFF;
            if (af1 !== 250) { const f1 = decodeAFCode(af1); if (f1 !== null) { const r = Math.round(f1*10)/10; currentState.afSet.add(r); if (!isSpecialPI(pi)) cacheAF(pi, r); } }
            if (af2 !== 250) { const f2 = decodeAFCode(af2); if (f2 !== null) { const r = Math.round(f2*10)/10; currentState.afSet.add(r); if (!isSpecialPI(pi)) cacheAF(pi, r); } }
        }
        if (b4hex && c4 > 0) {
            const seg = g2 & 0x03, addr = seg * 2;
            const c0 = rdsChar((g4 >> 8) & 0xFF), c1 = rdsChar(g4 & 0xFF);
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
                    entry.psLastRaw = [...currentState.psBuf]; entry.psLastRawTs = Date.now(); dbDirty = true;
                }
                if (!currentState.psRoundReceivedAfterConfirm && piConfirmed)
                    currentState.psRoundReceivedAfterConfirm = true;
                currentState.psSegsSeen.clear(); currentState.psRoundComplete = false;
                checkAndLockPS(pi); scheduleDataHandlerUpdate(pi);
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
            currentState.ta = ta; currentState.ms = ms ? 1 : 0;
            if (seg === 3) { if (entry) entry.stereo = di; currentState.stereo = di; }
        }
        if (b4hex && c4 > 0) {
            const seg = g2 & 0x03, addr = seg * 2;
            const c0 = rdsChar((g4 >> 8) & 0xFF), c1 = rdsChar(g4 & 0xFF);
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
                    entry.psLastRaw = [...currentState.psBuf]; entry.psLastRawTs = Date.now(); dbDirty = true;
                }
                if (!currentState.psRoundReceivedAfterConfirm && piConfirmed)
                    currentState.psRoundReceivedAfterConfirm = true;
                currentState.psSegsSeen.clear(); currentState.psRoundComplete = false;
                checkAndLockPS(pi); scheduleDataHandlerUpdate(pi);
            }
        }
    }

    // ── Group 2A (RadioText) ──────────────────────────────────
    if (gT === 2 && vB === 0) {
        const abF = (g2 >> 4) & 0x01, addr = (g2 & 0x0F) * 4;
        if (abF !== currentState.rtAB) {
            currentState.rtSlots = Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 }));
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
        const abF = (g2 >> 4) & 0x01, addr = (g2 & 0x0F) * 2;
        if (abF !== currentState.rtAB) {
            currentState.rtSlots = Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 }));
            currentState.rtAB    = abF;
        }
        if (b4hex && c4 > 0) {
            currentState.rtSlots[addr    ] = { char: rdsChar((g4 >> 8) & 0xFF), conf: c4 };
            currentState.rtSlots[addr + 1] = { char: rdsChar(g4 & 0xFF),        conf: c4 };
        }
    }

    // ── Group 1A (ECC) ────────────────────────────────────────
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

function bigramScore(a, b) { // eslint-disable-line no-unused-vars
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
    const entry   = (!isSpecialPI(pi) && pi) ? db[pi] : null;
    const ref     = findRefEntry(pi);
    const psSlots = [];

    if (psLocked && lastBroadcastPS && entry && !entry.psIsDynamic) {
        for (let i = 0; i < 8; i++)
            psSlots.push({ char: lastBroadcastPS[i] || ' ', conf: 1.0, src: 'raw-0' });
    } else if (isSpecialPI(pi)) {
        for (let i = 0; i < 8; i++) {
            const rawChar = currentState.psBuf[i] || ' ';
            const rawErr  = currentState.psErrBuf[i];
            const rawConf = CONF_TABLE[Math.min(rawErr, 3)];
            psSlots.push(rawChar !== ' ' && rawErr <= 1
                ? { char: rawChar, conf: rawConf, src: `raw-${rawErr}` }
                : { char: rawChar, conf: 0, src: 'empty' });
        }
    } else {
        for (let i = 0; i < 8; i++) {
            const rawChar = currentState.psBuf[i];
            const rawErr  = currentState.psErrBuf[i];
            const rawConf = CONF_TABLE[Math.min(rawErr, 3)];

            if (entry?.psIsDynamic && entry.psLastRaw?.[i] != null &&
                currentState.psRoundReceivedAfterConfirm) {
                psSlots.push({ char: entry.psLastRaw[i], conf: 0.9, src: 'ai-dynamic' }); continue;
            }
            if (rawErr <= 1 && rawChar && rawChar !== ' ' && currentState.psRoundReceivedAfterConfirm) {
                psSlots.push({ char: rawChar, conf: rawConf, src: `raw-${rawErr}` }); continue;
            }
            if (entry && !entry.psIsDynamic && entry.ps[i]) {
                const wv = getWeightedVotes(entry.ps[i]);
                if (Object.keys(wv).length > 0) {
                    let best = ' ', bestW = 0;
                    for (const [ch, w] of Object.entries(wv)) { if (w > bestW) { bestW = w; best = ch; } }
                    const total = Object.values(wv).reduce((a, b) => a + b, 0);
                    const conf  = Math.min(0.95, bestW / total);
                    if (conf > 0.3) {
                        const dc = (rawChar && rawChar !== ' ' && rawErr <= 1 &&
                            rawChar.toUpperCase() === best.toUpperCase()) ? rawChar : best;
                        psSlots.push({ char: dc, conf,
                            src: 'ai-voted-' + (conf > 0.7 ? 'high' : conf > 0.5 ? 'mid' : 'low') });
                        continue;
                    }
                }
            }
            if (ref?.psVariants?.length > 0) {
                const refPS = ref.psVariants[0].padEnd(8, ' ');
                if (refPS[i] && refPS[i] !== ' ') {
                    const ms  = computeRefMatchScore(pi);
                    const src = ms >= 0.5 ? 'ref-match' : 'ref-seed';
                    const dc  = (rawChar && rawChar !== ' ' && rawErr <= 1 &&
                        rawChar.toUpperCase() === refPS[i].toUpperCase()) ? rawChar : refPS[i];
                    psSlots.push({ char: dc, conf: 0.3 + ms * 0.4, src }); continue;
                }
            }
            if (i > 0 && psSlots[i-1]) {
                const bg = Object.entries(BIGRAM[psSlots[i-1].char] || {}).sort((a, b) => b[1] - a[1]);
                if (bg.length > 0) { psSlots.push({ char: bg[0][0], conf: 0.1, src: 'ai-bigram' }); continue; }
            }
            psSlots.push({ char: ' ', conf: 0, src: 'empty' });
        }
    }

    const rtText   = buildRTString();
    const rtResult = rtText.trim().length >= 3
        ? { text: rtText, score: 0.8, src: 'raw-rt' }
        : (entry?.rtLast?.trim().length >= 3
            ? { text: entry.rtLast, score: 0.5, src: 'ai-rt-last' } : null);

    const psVoteTotal = entry ? Object.values(entry.ps).reduce((a, posVotes) => {
        const wv = getWeightedVotes(posVotes);
        return a + Object.values(wv).reduce((x, y) => x + y, 0);
    }, 0) : 0;

    const refMatchScore = computeRefMatchScore(pi);
    const stationConf   = computeStationConfidence(pi);
    const provisionalPS = computeProvisionalPS(pi);
    const afCoverage    = computeAFCoverage(pi);

    // Stability clock – ONLY written here, read-only everywhere else
    const now = Date.now();
    if (provisionalPS && provisionalPS !== lastProvisionalPS) {
        lastProvisionalPS      = provisionalPS;
        provisionalFirstSeenTs = now;
    } else if (!provisionalPS) {
        lastProvisionalPS      = null;
        provisionalFirstSeenTs = 0;
    }
    const stableMs      = (provisionalPS && provisionalFirstSeenTs) ? (now - provisionalFirstSeenTs) : 0;
    const psProvisional = (provisionalPS && stationConf >= PROVISIONAL_MIN_CONF) ? provisionalPS : null;

    let psName = null, psNameSrc = null, psVariants = [];
    if (!isSpecialPI(pi) && ref?.psVariants?.length > 0) {
        psVariants = ref.psVariants.map(v => v.trim()).filter(v => v.length > 0);
        psName     = ref.station?.trim().length > 0 ? ref.station.trim() : null;
        psNameSrc  = 'fmdx';
    }

    const psIsDynamicEffective = (entry?.psIsDynamic || false) || (ref?.psVariants?.length > 1);

    const rawAltFreqs = (!isSpecialPI(pi) && psLocked && lastBroadcastPS)
        ? getAltFreqsForPIAndPS(pi, lastBroadcastPS)
        : (!isSpecialPI(pi) ? getAltFreqsForPI(pi) : []);

    const seenFreqs = new Set();
    const altFreqs  = [];
    for (const item of rawAltFreqs) {
        const key = parseFloat(item.freq).toFixed(1);
        if (!seenFreqs.has(key)) {
            seenFreqs.add(key);
            altFreqs.push({ freq: parseFloat(item.freq).toFixed(1),
                distKm: item.distKm, station: item.station, psVariants: item.psVariants || [] });
        }
    }
    altFreqs.sort((a, b) => parseFloat(a.freq) - parseFloat(b.freq));

    const afArray = Array.from(currentState.afSet)
        .map(f => parseFloat(f.toFixed ? f.toFixed(1) : String(f)))
        .sort((a, b) => a - b);

    return {
        pi, ps: psSlots, rt: rtResult, af: afArray,
        psName, psNameSrc, psVariants: ref?.psVariants || [], altFreqs, psLocked,
        psProvisional,
        psProvisionalConf: stationConf,
        psStableMs:        stableMs,
        psLockReason:      lastLockReason,
        stats: {
            freq:          entry?.freq    || currentState.freq,
            seenCount:     entry?.seenCount || 0,
            psVoteTotal:   Math.round(psVoteTotal),
            psIsDynamic:   psIsDynamicEffective,
            psLocked,
            refStation:    ref?.station   || null,
            refDistKm:     ref?.distKm    ?? null,
            refMatchScore: Math.round(refMatchScore * 100),
            pireg:         ref?.pireg  || null,
            piMain:        ref?.piMain || null,
            stationConf:   Math.round(stationConf * 100),
            afCoverage:    Math.round(afCoverage * 100),
            qualZeroErr:   Math.round(recentZeroErrFraction() * 100),
        },
    };
}

// ─────────────────────────────────────────────────────────────
//  onPIConfirmed
// ─────────────────────────────────────────────────────────────
function onPIConfirmed(pi) {
    if (isSpecialPI(pi)) {
        if (DEBUG) logInfo(`[${PLUGIN_NAME}] Special PI confirmed: ${pi} (pass-through mode)`);
        const prediction = buildAIPrediction(pi);
        currentState.lastPrediction = prediction;
        setTimeout(() => broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() }), AI_BROADCAST_DELAY);
        if (dataHandler) { dataHandler.dataToSend.pi = pi; dataHandler.initialData.pi = pi; dataHandler.dataToSend.rds = true; }
        if (rdsFollowMode) applyFollowToDataHandler();
        return;
    }

    const entry = ensurePI(pi);
    const ref   = findRefEntry(pi);

    if (ref?.psVariants?.length > 0 && Object.keys(entry.ps).length === 0) {
        const refPS = ref.psVariants[0].padEnd(8, ' ');
        for (let i = 0; i < 8; i++) {
            if (refPS[i] && refPS[i] !== ' ') {
                if (!entry.ps[i]) entry.ps[i] = {};
                entry.ps[i][refPS[i]] = { w: 1.0, count: 1, firstSeen: Date.now(), lastSeen: Date.now() };
            }
        }
        entry.psResolved = resolvePS(pi);
        entry.psConf     = computePSConf(pi);
        dbDirty = true;
    }

    if (entry.psVerifiedRaw) {
        if (!isPSStringClean(entry.psVerifiedRaw)) {
            if (DEBUG) logInfo(`[${PLUGIN_NAME}] Discarding corrupt psVerifiedRaw for PI=${pi}`);
            entry.psVerifiedRaw = null; entry.psVerifiedRawTs = 0; dbDirty = true;
        } else if (ref?.psVariants?.length > 0) {
            const su = entry.psVerifiedRaw.trim().toUpperCase();
            const ok = ref.psVariants.some(v => {
                const vu = v.trim().toUpperCase();
                return su === vu || su.startsWith(vu) || vu.startsWith(su);
            });
            if (!ok) {
                if (DEBUG) logInfo(`[${PLUGIN_NAME}] Discarding stale psVerifiedRaw "${entry.psVerifiedRaw.trim()}" for PI=${pi}`);
                entry.psVerifiedRaw = null; entry.psVerifiedRawTs = 0; dbDirty = true;
            }
        }
    }

    if (DEBUG) {
        const rmp = Math.round(computeRefMatchScore(pi) * 100);
        let src = 'no fmdx.org ref';
        if (ref) {
            const dist = ref.distKm != null ? `${ref.distKm} km` : '? km';
            const mt   = (ref.pireg && ref.pireg === pi.toUpperCase())
                ? `pireg match (primary PI: ${ref.piMain || '?'})` : 'primary PI match';
            src = `fmdx.org, ${dist}, match ${rmp}%, ${mt}`;
        }
        logInfo(`[${PLUGIN_NAME}] PI confirmed: ${pi}${(entry.psResolved||'').trim() ? ` = "${(entry.psResolved||'').trim()}"` : ''} (${src})`);
        if (ref?.psVariants?.length > 0)
            logInfo(`[${PLUGIN_NAME}] PS variants for ${pi}: ${ref.psVariants.map((v,i) => `[${i}] "${v.trimEnd()}"`).join('  ')}`);
        const altF = getAltFreqsForPI(pi);
        if (altF.length > 0)
            logInfo(`[${PLUGIN_NAME}] fmdx.org freqs for PI ${pi}: ` +
                [...new Set(altF.map(a => parseFloat(a.freq).toFixed(1)))].sort().join(', '));
    }

    if (!psLocked) checkAndLockPS(pi);

    const prediction = buildAIPrediction(pi);
    currentState.lastPrediction = prediction;
    setTimeout(() => broadcast({ type: 'rdsm_ai', ...prediction, ts: Date.now() }), AI_BROADCAST_DELAY);

    if (dataHandler) {
        if (pi && pi !== '?' && pi !== '----') { dataHandler.dataToSend.pi = pi; dataHandler.initialData.pi = pi; }
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
        const legacyErr = parseInt(raw.slice(12), 16);
        let errNew      = (legacyPiCache.length - 4) << 6;
        errNew |= (legacyErr & 0x03) << 4;
        errNew |= (legacyErr & 0x0C);
        errNew |= (legacyErr & 0x30) >> 4;
        dataHex  = legacyPiCache.slice(0, 4) + raw.slice(0, 12);
        errorHex = errNew.toString(16).padStart(2, '0');
    } else return;

    const errByte = parseInt(errorHex, 16);
    const errB    = [(errByte>>6)&3, (errByte>>4)&3, (errByte>>2)&3, errByte&3];

    const piRaw = dataHex.slice(0, 4).toUpperCase();
    const b2hex = dataHex.slice(4,  8);
    const b3hex = dataHex.slice(8,  12);
    const b4hex = dataHex.slice(12, 16);

    if (errB[0] > 1) return;
    const pi = piRaw;

    if (pi !== currentState.pi) {
        currentState.pi        = pi;
        piConfirmCount         = 1;
        piConfirmed            = false;
        piPendingBroadcast     = false;
        psLocked               = false;
        lastBroadcastPS        = null;
        lastProvisionalPS      = null;
        provisionalFirstSeenTs = 0;
        lastLockReason         = null;
        qualWindow             = []; // reset quality window on PI change

        currentState.psBuf.fill(' '); currentState.psErrBuf.fill(3);
        currentState.psSegsSeen.clear();
        currentState.rtSlots = Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 }));
        currentState.rtAB    = -1;
        currentState.afSet   = new Set();
        currentState.psRoundReceivedAfterConfirm = false;

        if (!isSpecialPI(pi)) {
            const e = db[pi];
            if (e) {
                if (e.psDynamicBuf) e.psDynamicBuf.length = 0;
                else Object.defineProperty(e, 'psDynamicBuf', { value: [], writable: true, enumerable: false, configurable: true });
                e.psIsDynamic = false;
                e.psLastRaw   = new Array(8).fill(null);
                e.psLastRawTs = 0;
            }
        }
        currentState.freqRefs = isSpecialPI(pi) ? [] : getFreqRefs(currentState.freq);

        if (DEBUG && currentState.freqRefs.length > 0 && !isSpecialPI(pi)) {
            if (!currentState.freqRefs.some(r => r.pi === pi || (r.pireg && r.pireg === pi)))
                logInfo(`[${PLUGIN_NAME}] PI candidate ${pi} not in fmdx.org for ${currentState.freq} MHz`);
        }
    } else {
        piConfirmCount++;
    }

    const threshold = getConfirmThreshold(pi);

    if (!piConfirmed && piConfirmCount >= threshold) {
        if (!isPIAllowed(pi)) { piConfirmCount = 0; return; }
        piConfirmed = true;
        broadcast({ type: 'rdsm_raw', pi, freq: currentState.freq, errB });
        onPIConfirmed(pi);
    } else if (piConfirmed) {
        broadcast({ type: 'rdsm_raw', pi, freq: currentState.freq, b2: b2hex, b3: b3hex, b4: b4hex, errB });
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

function broadcastToMainWss(payload) { // eslint-disable-line no-unused-vars
    if (!pluginsMainWss) return;
    const msg = JSON.stringify(payload);
    pluginsMainWss.clients.forEach(c => {
        if (c.readyState === c.OPEN) try { c.send(msg); } catch(e) {}
    });
}

// ─────────────────────────────────────────────────────────────
//  hookDataHandler
// ─────────────────────────────────────────────────────────────
function stripRDSLines(data) { // eslint-disable-line no-unused-vars
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
                lastProvisionalPS      = null;
                provisionalFirstSeenTs = 0;
                lastLockReason         = null;
                qualWindow             = []; // reset quality window on freq change
                currentState.psBuf.fill(' ');
                currentState.psErrBuf.fill(3);
                currentState.psSegsSeen.clear();
                currentState.rtSlots = Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 }));
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
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