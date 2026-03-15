///////////////////////////////////////////////////////////////
//                                                           //
//  RDS AI DECODER SERVER PLUGIN FOR FM-DX-WEBSERVER (V1.0)  //
//                                                           //
//  by Highpoint                last update: 2026-03-15      //
//                                                           //
//  https://github.com/Highpoint2000/RDS-AI-Decoder          //
//                                                           //
///////////////////////////////////////////////////////////////

'use strict';

const fs         = require('fs');
const path       = require('path');
const pluginsApi = require('../../server/plugins_api');
const { logInfo, logWarn, logError } = require('../../server/console');

const pluginConfig = {
    name:         'RDS AI Decoder',
    version:      '1.0',
    frontEndPath: 'rds-ai-decoder.js',
};
module.exports = { pluginConfig };

const PLUGIN_NAME         = 'RDS AI Decoder';
const DB_FILE             = path.join(__dirname, 'rdsm_memory.json');
const DB_SAVE_INTERVAL    = 60 * 1000;
const MAX_STATIONS        = 2000;
const CONF_TABLE          = [1.00, 0.90, 0.70, 0.00];
const VOTE_HALFLIFE_DAYS  = 7;
const VOTE_EXPIRE_DAYS    = 30;
const STATION_EXPIRE_DAYS = 90;
const QUICK_EXPIRE_DAYS   = 7;
const CONSISTENCY_BOOST   = 1.5;
const AI_BROADCAST_DELAY  = 80; // ms

// ── Validation thresholds ────────────────────────────────────
// PI_CONFIRM_THRESHOLD: number of consecutive raw packets with
// the same PI code and errB[0] ≤ 1 required before the PI is
// considered valid and broadcast to any output.
// 2 is the earliest reliable value – it rules out a single
// corrupt/spurious packet while adding only ~100 ms delay on
// a typical RDS stream (groups arrive ~11.4 groups/sec).
const PI_CONFIRM_THRESHOLD = 2;

let aiExclusiveMode    = false;
let rdsFollowMode      = false;
let nativeRDSDisabled  = false;
let pluginsWss         = null;
let pluginsMainWss     = null;
let currentFreq        = null;
let legacyPiCache      = null;

// ── PI confirmation state ────────────────────────────────────
// piConfirmCount: consecutive qualifying raw packets seen for
//                 currentState.pi in the current reception.
// piConfirmed:    true once piConfirmCount >= PI_CONFIRM_THRESHOLD.
//                 Reset to false on every frequency change or
//                 PI change.
// piPendingBroadcast: when pre-cache loaded a prediction before
//                 confirmation, this flag marks that a full AI
//                 broadcast should fire the moment confirmation
//                 is reached (no extra delay after confirm).
let piConfirmCount       = 0;
let piConfirmed          = false;
let piPendingBroadcast   = false;

let dataHandler = null;
try { dataHandler = require('../../server/datahandler'); }
catch(e) { logWarn(`[${PLUGIN_NAME}] Could not load datahandler: ${e.message}`); }

// ═══════════════════════════════════════════════════════════════
//  FREQUENCY HELPERS
// ═══════════════════���═══════════════════════════════════════════
function roundFreq(freqStr) {
    if (!freqStr) return freqStr;
    const f = parseFloat(freqStr);
    if (isNaN(f)) return freqStr;
    return (Math.round(f * 10) / 10).toFixed(2);
}

// ═══════════════════════════════════════════════════════════════
//  RDS CHARACTER SET  (ETSI EN 50067 / librdsparser string.c)
// ═══════════════════════════════════════════════════════════════
const RDS_CHARSET = [
    ' ','!','"','#','¤','%','&',"'",
    '(',')','+','+',',','-','.','/',
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

// ═══════════════════════════════════════════════════════════════
//  RDS COUNTRY LOOKUP  (ECC + PI nibble → ISO 3166-1)
// ═══════════════════════════════════════════════════════════════
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

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (raw._meta && typeof raw._meta === 'object') {
                if (typeof raw._meta.rdsFollowMode === 'boolean') {
                    rdsFollowMode     = raw._meta.rdsFollowMode;
                    nativeRDSDisabled = rdsFollowMode;
                    logInfo(`[${PLUGIN_NAME}] RDS Follow restored: ${rdsFollowMode ? 'ON' : 'OFF'}`);
                }
            }
            for (const [pi, entry] of Object.entries(raw)) {
                if (pi === '_meta') continue;
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
            }
            db = raw;
            const n = Object.keys(db).filter(k => k !== '_meta').length;
            logInfo(`[${PLUGIN_NAME}] AI memory loaded: ${n} stations`);
        } else {
            db = {};
            logInfo(`[${PLUGIN_NAME}] AI memory: new database created`);
        }
    } catch(e) {
        logWarn(`[${PLUGIN_NAME}] Could not load AI DB: ${e.message} – starting fresh`);
        db = {};
    }
}

function saveDB() {
    if (!dbDirty) return;
    try {
        const now           = Date.now();
        const expireMs      = STATION_EXPIRE_DAYS * 86400000;
        const quickExpireMs = QUICK_EXPIRE_DAYS   * 86400000;
        const toSave        = {};
        toSave._meta        = { rdsFollowMode, savedAt: now };
        for (const [pi, entry] of Object.entries(db)) {
            if (pi === '_meta') continue;
            if ((now - (entry.seen || 0)) > expireMs) continue;
            const hasPS     = entry.ps && Object.keys(entry.ps).length > 0;
            const hasUseful = hasPS || entry.ecc || (entry.pty > 0);
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
            ecc: null, seen: Date.now(), seenCount: 0,
        };
        Object.defineProperty(db[pi], 'psDynamicBuf', {
            value: [], writable: true, enumerable: false, configurable: true,
        });
    } else if (!db[pi].psDynamicBuf) {
        Object.defineProperty(db[pi], 'psDynamicBuf', {
            value: [], writable: true, enumerable: false, configurable: true,
        });
    }
    return db[pi];
}

// ═══════════════════════════════════════════════════════════════
//  VOTE ENGINE
// ═══════════════════════════════════════════════════════════════
function votePS(pi, pos, char, weight, errLevel) {
    if (!pi || pi === '----' || !char || char < ' ') return;
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
    if (!posVotes[char]) {
        posVotes[char] = { w: 0, count: 0, firstSeen: now, lastSeen: now };
    }
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
        const best      = vals[0], second = vals[1] || 0;
        const share     = best / total;
        const dominance = total > 1 ? (best - second) / total : share;
        const totalCount = Object.values(entry.ps[i] || {})
            .reduce((s, v) => s + (v.count || 0), 0);
        const voteFactor = Math.min(1, totalCount / 30);
        return Math.min(0.97, share * 0.5 + dominance * 0.3 + voteFactor * 0.2);
    });
}

function checkPSDynamic(pi, psString) {
    const entry = ensurePI(pi);
    const buf   = entry.psDynamicBuf;
    buf.push(psString);
    if (buf.length > 8) buf.shift();
    if (buf.length < 3) return;
    const wasDynamic  = entry.psIsDynamic;
    entry.psIsDynamic = detectScrollPS(buf) || detectChangingPS(buf);
    if (entry.psIsDynamic && !wasDynamic) {
        entry.ps = {}; entry.psResolved = null; entry.psConf = new Array(8).fill(0);
        dbDirty = true;
    } else if (!entry.psIsDynamic && wasDynamic && buf.length >= 5) {
        dbDirty = true;
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
    return new Set(buf.map(s => s.trim())).size >= 4;
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
    lastPrediction: null,
    tp: false, ta: false, ms: -1, stereo: false,
};

let _freqSeq = 0;

// ═══════════════════════════════════════════════════════════════
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
    // Always reset confirmation when clearing
    piConfirmCount     = 0;
    piConfirmed        = false;
    piPendingBroadcast = false;
}

// ─────────────────────────────────────────────────────────────
//  applyFollowToDataHandler
//  Only called when piConfirmed = true.
//  PI is always written first, then PS, then remaining fields.
// ─────────────────────────────────────────────────────────────
function applyFollowToDataHandler() {
    if (!dataHandler || !rdsFollowMode || !piConfirmed) return;
    const pi    = currentState.pi;
    const pred  = currentState.lastPrediction;
    const entry = pi ? db[pi] : null;

    // 1. PI first
    dataHandler.dataToSend.pi  = (pi && pi !== '----' && pi !== '?') ? pi : '?';
    dataHandler.initialData.pi = dataHandler.dataToSend.pi;

    // 2. PS
    if (pred && pred.ps && Array.isArray(pred.ps)) {
        const psStr = pred.ps.map(s =>
            (s && s.src !== 'empty' && s.src !== 'ai-bigram' && s.char && s.char !== ' ')
                ? s.char : ' '
        ).join('');
        dataHandler.dataToSend.ps        = psStr;
        dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
    } else {
        dataHandler.dataToSend.ps        = '';
        dataHandler.dataToSend.ps_errors = '';
    }

    // 3. Remaining fields
    dataHandler.dataToSend.pty = (entry && entry.pty >= 0) ? entry.pty : 0;
    dataHandler.dataToSend.tp  = currentState.tp ? 1 : 0;
    dataHandler.dataToSend.ta  = currentState.ta ? 1 : 0;
    dataHandler.dataToSend.ms  = currentState.ms;

    if (pred && pred.rt && pred.rt.text && pred.rt.text.trim().length > 0) {
        const rtFlag = currentState.rtAB >= 0 ? currentState.rtAB : 0;
        if (rtFlag === 0) {
            dataHandler.dataToSend.rt0        = pred.rt.text;
            dataHandler.dataToSend.rt0_errors = '';
        } else {
            dataHandler.dataToSend.rt1        = pred.rt.text;
            dataHandler.dataToSend.rt1_errors = '';
        }
        dataHandler.dataToSend.rt_flag = rtFlag;
    } else {
        dataHandler.dataToSend.rt0 = dataHandler.dataToSend.rt1 = '';
        dataHandler.dataToSend.rt0_errors = dataHandler.dataToSend.rt1_errors = '';
    }

    const eccByte = (entry && entry.ecc) ? parseInt(entry.ecc, 16) : null;
    dataHandler.dataToSend.ecc = eccByte;
    if (pi && eccByte) {
        const country = lookupCountry(pi, eccByte);
        dataHandler.dataToSend.country_iso  = country ? country.iso  : 'UN';
        dataHandler.dataToSend.country_name = country ? country.name : '';
    } else {
        dataHandler.dataToSend.country_iso  = 'UN';
        dataHandler.dataToSend.country_name = '';
    }
    dataHandler.dataToSend.rds = !!(pi && pi !== '?');
}

// ═══════════════════════════════════════════════════════════════
//  TX-SEARCH  (Follow mode off)
// ═══════════════════════════════════════════════════════════════
let txUpdateTimer = null;
function scheduleDataHandlerUpdate(pi) {
    if (!dataHandler || rdsFollowMode || !piConfirmed) return;
    if (txUpdateTimer) clearTimeout(txUpdateTimer);
    txUpdateTimer = setTimeout(() => {
        txUpdateTimer = null;
        if (!piConfirmed) return;  // re-check inside callback
        const entry = db[pi];
        if (!entry) return;
        // PI first
        if (pi && pi !== '?' && pi !== '----') {
            dataHandler.dataToSend.pi  = pi;
            dataHandler.initialData.pi = pi;
        }
        const psStr = buildPSString(pi);
        if (psStr && psStr.trim().length > 0) dataHandler.dataToSend.ps = psStr;
        if (entry.pty >= 0) dataHandler.dataToSend.pty = entry.pty;
        if (currentState.freq) dataHandler.dataToSend.freq = currentState.freq;
    }, 500);
}

function buildPSString(pi) {
    const entry = db[pi];
    if (!entry) return '';
    if (entry.psIsDynamic) return (entry.psLastRaw || []).map(c => c || ' ').join('');
    return entry.psResolved || '';
}

// ═══════════════════════════════════════════════════════════════
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
    const entry  = ensurePI(pi);
    entry.seenCount++;
    entry.seen = Date.now();
    if (currentState.freq) entry.freq = roundFreq(currentState.freq);
    if (blkAok && blkBok) {
        entry.tp = tp; currentState.tp = tp;
        if (pty > 0) entry.pty = pty;
    }
    dbDirty = true;

    if (gT === 0) {
        if (blkAok && blkBok) {
            const ta = !!((g2 >> 4) & 0x01);
            const ms = !!((g2 >> 3) & 0x01);
            const seg =   g2 & 0x03;
            const di = !!((g2 >> 2) & 0x01);
            entry.ta = ta; currentState.ta = ta;
            entry.ms = ms ? 1 : 0; currentState.ms = ms ? 1 : 0;
            if (seg === 3) { entry.stereo = di; currentState.stereo = di; }
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
                checkPSDynamic(pi, currentState.psBuf.join(''));
                if (currentState.psErrBuf.every(e => e <= 1)) {
                    entry.psLastRaw   = [...currentState.psBuf];
                    entry.psLastRawTs = Date.now();
                    dbDirty = true;
                }
                currentState.psSegsSeen.clear();
                currentState.psRoundComplete = false;
                scheduleDataHandlerUpdate(pi);
            }
        }
    }

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

    if (gT === 1 && vB === 0 && b3hex && errB[2] <= 1) {
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

// ═══════════════════════════════════════════════════════════════
//  AI PREDICTION
// ═══════════════════════════════════════════════════════════════
function buildAIPrediction(pi) {
    const entry = db[pi];
    let psSlots;
    if (entry?.psIsDynamic) {
        const lastRaw    = entry.psLastRaw || new Array(8).fill(null);
        const lastRawAge = Date.now() - (entry.psLastRawTs || 0);
        const ageFactor  = Math.max(0, 1 - (lastRawAge / 120000));
        const conf       = Math.min(0.92, 0.85 * ageFactor);
        psSlots = Array.from({length: 8}, (_, i) => {
            const ch = lastRaw[i];
            return (ch && ch !== ' ' && conf > 0.1)
                ? { char: ch, conf, src: 'ai-voted-high' }
                : { char: ' ', conf: 0, src: 'ai-bigram' };
        });
    } else {
        const psResolved = entry?.psResolved || null;
        const psConf     = entry?.psConf     || new Array(8).fill(0);
        const totalVotes = entry
            ? Object.values(entry.ps).reduce((sum, posVotes) => {
                const wv = getWeightedVotes(posVotes);
                return sum + Object.values(wv).reduce((a, b) => a + b, 0);
              }, 0)
            : 0;
        psSlots = Array.from({length: 8}, (_, i) => {
            if (psResolved && psResolved[i] && psResolved[i] !== ' ' && psConf[i] > 0) {
                if (totalVotes >= 15 && psConf[i] >= 0.70)
                    return { char: psResolved[i], conf: psConf[i], src: 'ai-cached-db' };
                const src = psConf[i] >= 0.9 ? 'ai-voted-high'
                          : psConf[i] >= 0.7 ? 'ai-voted-mid'
                          :                    'ai-voted-low';
                return { char: psResolved[i], conf: Math.min(0.93, psConf[i] * 0.95), src };
            }
            const bg = bigramPredict(i > 0 && psResolved ? psResolved[i-1] : ' ');
            return { char: bg.char, conf: bg.conf, src: 'ai-bigram' };
        });
    }
    let rtPrediction = null;
    let rtText = '';
    for (let i = 0; i < 64; i++) {
        const sl = currentState.rtSlots[i];
        if (!sl || sl.conf === 0) { if (rtText.length > 0) break; continue; }
        if (sl.char === '\r') break;
        rtText += sl.char;
    }
    rtText = rtText.trimEnd();
    if (rtText.length >= 4) {
        const goodChars = currentState.rtSlots.filter(s => s.conf >= 0.90).length;
        const score     = Math.min(0.85, 0.4 + (goodChars / Math.max(1, rtText.length)) * 0.45);
        rtPrediction    = { text: rtText, score, src: 'ai-rt-live' };
    }
    const stats = entry ? {
        seenCount:    entry.seenCount,
        psVoteTotal:  Object.values(entry.ps).reduce((a, posVotes) => {
            const wv = getWeightedVotes(posVotes);
            return a + Object.values(wv).reduce((x, y) => x + y, 0);
        }, 0),
        freq: entry.freq, pty: entry.pty,
        psIsDynamic:  entry.psIsDynamic || false,
        psLastRawAge: entry.psLastRawTs
            ? Math.round((Date.now() - entry.psLastRawTs) / 1000) : null,
    } : null;
    return { type: 'rdsm_ai', pi, ps: psSlots, rt: rtPrediction, stats, ts: Date.now() };
}

const BIGRAMS = {
    ' ':{'R':25,'F':20,'M':15,'D':12,'N':10,'S':8,'K':7,'L':6,'B':5,'E':4,'A':3,'H':3,'W':3},
    'R':{'D':20,'A':15,'I':12,'O':10,'E':8,'S':6,' ':5,'1':3,'N':3},
    'F':{'M':40,'R':12,'L':8,'E':6,'U':5,'I':4,'O':3,'A':3},
    'M':{'D':15,'U':10,'A':9,'X':8,'E':8,'I':7,'S':5,'1':4,'2':3,'3':3},
    'D':{'R':20,'E':15,'A':12,'I':10,'S':8,'U':7,'1':6,'2':5,'3':4,' ':4},
    'N':{'D':20,'R':15,'O':12,'E':10,'A':8,'S':7,'1':6,' ':5,'W':4},
    'B':{'B':20,'A':15,'R':12,'E':10,'1':8,'2':7,'C':6,' ':4,'Y':3},
    'K':{'I':20,'U':15,'A':12,'E':10,'R':8,'1':6,'2':5,' ':4,'L':4},
    'S':{'W':20,'R':15,'A':12,'T':10,'U':8,'E':7,'1':6,'L':5,'H':4,'F':4},
    'L':{'I':20,'A':15,'O':12,'U':10,'E':8,'S':7,'1':6,'T':4},
    'E':{'N':20,'U':15,'A':12,'R':10,'S':8,'W':7,'1':6,'X':4},
    'H':{'I':15,'R':12,'E':12,'1':10,'T':8},
    'W':{'D':20,'R':15,'A':10,'E':8,'I':6},
    '1':{'0':30,'F':20,'1':15,'8':12,'9':10,'2':8,' ':6,'5':5},
    '0':{'0':25,'7':20,'6':15,'5':12,'4':10,' ':8},
};
function bigramPredict(prevChar) {
    const table = BIGRAMS[(prevChar || ' ').toUpperCase()] || BIGRAMS[' '];
    let best = ' ', bestS = 0, total = 0;
    for (const [c, s] of Object.entries(table)) {
        total += s; if (s > bestS) { bestS = s; best = c; }
    }
    return { char: best, conf: total > 0 ? (bestS / total) * 0.25 : 0.05 };
}

// ─────────────────────────────────────────────────────────────
//  Freq → PI pre-cache  (internal seed only, never broadcast)
// ─────────────────────────────────────────────────────────────
function findKnownPIForFreq(freq) {
    if (!freq) return null;
    const rounded = roundFreq(freq);
    let bestPI = null, bestScore = 0;
    for (const [pi, entry] of Object.entries(db)) {
        if (pi === '_meta') continue;
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

// ═══════════════════════════════════════════════════════════════
//  STRIP / INTERCEPT
// ═══════════════════════════════════════════════════════════════
function stripRDSLines(receivedData) {
    return receivedData.split('\n').filter(line => {
        const t = line.trim();
        if (!t.length) return true;
        if (t[0] === 'R' && /^R[0-9A-Fa-f]/.test(t)) return false;
        if (t[0] === 'P' && /^P[0-9A-Fa-f]{4}/.test(t)) return false;
        return true;
    }).join('\n');
}

function interceptLines(receivedData) {
    for (const line of receivedData.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (t[0] === 'T' && /^T[0-9]/.test(t)) {
            const f = parseFloat(t.slice(1).split(',')[0]);
            if (!isNaN(f)) {
                const newFreq = (f / 1000).toFixed(3);
                if (newFreq !== currentFreq) {
                    currentFreq = newFreq; legacyPiCache = null;
                    onFreqChange(newFreq);
                }
            }
            continue;
        }
        if (t[0] === 'P' && /^P[0-9A-Fa-f]{4}/.test(t)) { legacyPiCache = t.slice(1).trim(); continue; }
        if (t[0] === 'R' && /^R[0-9A-Fa-f]/.test(t)) parseAndDispatch(t.slice(1).trim());
    }
}

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
    if (!/^[0-9A-Fa-f]{16}$/.test(dataHex))  return;
    if (!/^[0-9A-Fa-f]{2}$/.test(errorHex)) return;
    const errByte = parseInt(errorHex, 16);
    const errB    = [(errByte>>6)&3,(errByte>>4)&3,(errByte>>2)&3,(errByte>>0)&3];
    const blocks  = [
        errB[0]<3 ? dataHex.slice(0,  4).toUpperCase() : null,
        errB[1]<3 ? dataHex.slice(4,  8).toUpperCase() : null,
        errB[2]<3 ? dataHex.slice(8,  12).toUpperCase() : null,
        errB[3]<3 ? dataHex.slice(12, 16).toUpperCase() : null,
    ];

    // Always broadcast the raw packet to plugin clients so
    // the panel can update BER/group counters in real time.
    broadcast({
        type:'rdsm_raw', pi:blocks[0], b2:blocks[1], b3:blocks[2], b4:blocks[3],
        raw4:[dataHex.slice(0,4).toUpperCase(),dataHex.slice(4,8).toUpperCase(),
              dataHex.slice(8,12).toUpperCase(),dataHex.slice(12,16).toUpperCase()],
        errB, conf:errB.map(e=>CONF_TABLE[e]), err:errByte, freq:currentFreq, ts:Date.now(),
    });

    if (!blocks[0]) return;
    const pi    = blocks[0];
    const blkAok = errB[0] <= 1;

    // ── PI change detection ──────────────────────────────────
    if (pi !== currentState.pi) {
        onPIChange(pi);
    }

    // ── PI confirmation gate ─────────────────────────────────
    // Only count this packet toward confirmation when Block A
    // is error-free (errB[0] ≤ 1), which means the PI itself
    // was received without uncorrectable errors.
    if (blkAok && !piConfirmed) {
        piConfirmCount++;
        if (piConfirmCount >= PI_CONFIRM_THRESHOLD) {
            piConfirmed = true;
            onPIConfirmed(pi);
        }
    }

    decodeGroup(pi, blocks[1], blocks[2], blocks[3], errB);
    scheduleAIBroadcast(pi);
}

// ─────────────────────────────────────────────────────────────
//  onPIChange
//  Called when a new PI code appears in the raw stream.
//  Resets confirmation state. Loads pre-cache as internal
//  prediction seed (not broadcast to any output yet).
// ─────────────────────────────────────────────────────────────
function onPIChange(newPI) {
    currentState.pi = newPI;
    currentState.rtSlots = Array.from({length:64},()=>({char:' ',conf:0}));
    currentState.rtAB = -1;
    currentState.psBuf = new Array(8).fill(' ');
    currentState.psErrBuf = new Array(8).fill(3);
    currentState.psSegsSeen = new Set();
    currentState.psRoundComplete = false;

    // Reset confirmation for the new PI
    piConfirmCount     = 1;   // this first packet already counts
    piConfirmed        = false;
    piPendingBroadcast = false;

    // Load DB prediction as internal seed so buildAIPrediction()
    // already has data when confirmation fires. Do NOT broadcast.
    const prediction = buildAIPrediction(newPI);
    currentState.lastPrediction = prediction;
    // Mark that a broadcast is pending confirmation
    piPendingBroadcast = true;
}

// ─────────────────────────────────────────────────────────────
//  onPIConfirmed
//  Called exactly once per frequency/PI when piConfirmed
//  transitions to true. Fires the first broadcast to both
//  plugin panel and dataHandler simultaneously.
// ───────────────────────────────��─────────────────────────────
function onPIConfirmed(pi) {
    // Rebuild prediction now that we have confirmed PI context
    const prediction = buildAIPrediction(pi);
    currentState.lastPrediction = prediction;
    piPendingBroadcast = false;

    // ── Plugin panel ─────────────────────────────────────────
    broadcast(prediction);

    // ── dataHandler (web UI / autologger) ────────────────────
    if (dataHandler) {
        // PI first
        if (pi && pi !== '?' && pi !== '----') {
            dataHandler.dataToSend.pi  = pi;
            dataHandler.initialData.pi = pi;
        }
        // PS from prediction
        if (prediction.ps && Array.isArray(prediction.ps)) {
            const psStr = prediction.ps.map(s =>
                (s && s.src !== 'empty' && s.src !== 'ai-bigram' && s.char && s.char !== ' ')
                    ? s.char : ' '
            ).join('');
            if (psStr.trim().length > 0) {
                dataHandler.dataToSend.ps        = psStr;
                dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
            }
        }
        dataHandler.dataToSend.rds = true;
    }

    // In Follow mode: full apply
    if (rdsFollowMode) applyFollowToDataHandler();
}

// ─────────────────────────────────────────────────────────────
//  onFreqChange
//  Resets everything. Pre-cache is loaded as internal seed
//  only – nothing is sent to panel or dataHandler until
//  piConfirmed becomes true via live raw data.
// ─────────────────────────────────────────────────────────────
function onFreqChange(newFreq) {
    _freqSeq++;
    if (aiTimer)       { clearTimeout(aiTimer);       aiTimer       = null; }
    if (txUpdateTimer) { clearTimeout(txUpdateTimer); txUpdateTimer = null; }
    aiPendingPI = null;

    currentState.freq = newFreq; currentState.pi = null;
    currentState.lastPrediction = null;
    currentState.rtSlots = Array.from({length:64},()=>({char:' ',conf:0}));
    currentState.rtAB = -1;
    currentState.psBuf = new Array(8).fill(' ');
    currentState.psErrBuf = new Array(8).fill(3);
    currentState.psSegsSeen = new Set();
    currentState.psRoundComplete = false;
    currentState.tp = false; currentState.ta = false;
    currentState.ms = -1;    currentState.stereo = false;

    // Notify plugin clients of frequency change (no PI/PS data yet)
    broadcast({ type:'rdsm_freq', freq:newFreq, ts:Date.now() });

    // Clear all RDS data in web UI and reset confirmation
    clearRDSInDataHandler();

    // Load pre-cache as internal prediction seed.
    // piConfirmed is still false – nothing is shown anywhere yet.
    const knownPI = findKnownPIForFreq(newFreq);
    if (knownPI) {
        // Pre-load into currentState so onPIChange / onPIConfirmed
        // can use the DB data immediately when raw packets arrive.
        currentState.pi = knownPI;
        currentState.lastPrediction = buildAIPrediction(knownPI);
        piPendingBroadcast = true;
        // piConfirmCount stays 0 – first raw packet will set it to 1
        // via onPIChange (which sets it to 1 itself) or the counter
        // in parseAndDispatch when pi === currentState.pi.
    }

    saveDB();
}

let aiTimer = null, aiPendingPI = null;
function scheduleAIBroadcast(pi) {
    // Only schedule if PI is confirmed – no point building a
    // prediction that we cannot broadcast yet.
    if (!piConfirmed) return;
    aiPendingPI = pi;
    if (aiTimer) return;
    const seqAtSchedule = _freqSeq;
    aiTimer = setTimeout(() => {
        aiTimer = null;
        if (_freqSeq !== seqAtSchedule || !aiPendingPI || !piConfirmed) return;
        const prediction = buildAIPrediction(aiPendingPI);
        currentState.lastPrediction = prediction;
        broadcast(prediction);
        if (rdsFollowMode)   applyFollowToDataHandler();
        if (aiExclusiveMode) {
            const entry = db[aiPendingPI];
            broadcastToMainWss(buildNativeRDSPacket(aiPendingPI, prediction.ps, entry));
        }
    }, AI_BROADCAST_DELAY);
}

function broadcast(payload) {
    if (!pluginsWss) return;
    const msg = JSON.stringify(payload);
    pluginsWss.clients.forEach(c => { if (c.readyState===c.OPEN) try{c.send(msg);}catch(e){} });
}
function broadcastToMainWss(payload) {
    if (!pluginsMainWss) return;
    const msg = JSON.stringify(payload);
    pluginsMainWss.clients.forEach(c => { if (c.readyState===c.OPEN) try{c.send(msg);}catch(e){} });
}

function buildNativeRDSPacket(pi, psSlots, entry) {
    const psStr = psSlots.map(s =>
        (s.src!=='empty'&&s.src!=='ai-bigram'&&s.char&&s.char!==' ')?s.char:' '
    ).join('');
    return { type:'rdsm_ai_frontend', ps:psStr, pty:entry?.pty>=0?entry.pty:0,
             freq:currentFreq||'0.000', pi, rt:buildRTString(), ts:Date.now() };
}

function buildRTString() {
    let rt = '';
    for (let i=0;i<64;i++) {
        const sl=currentState.rtSlots[i];
        if (!sl||sl.conf===0){if(rt.length>0)break;continue;}
        if (sl.char==='\r') break;
        rt+=sl.char;
    }
    return rt.trimEnd();
}

// ═══════════════════════════════════════════════════════════════
//  WebSocket / API / patch
// ═══════════════════════════════════════════════════════════════
function getAdminToken() {
    try {
        const cfgPath = path.join(__dirname,'../../config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath,'utf8'));
            return cfg.password?.adminPass||cfg.adminPassword||'admin';
        }
    } catch(e) {}
    return 'admin';
}

function handlePluginMessage(data) {
    let msg; try { msg=JSON.parse(data); } catch(e) { return; }
    if (msg.type==='rdsm_set_rds_follow') {
        const wanted=!!msg.enabled;
        if (wanted!==rdsFollowMode) {
            rdsFollowMode=wanted; nativeRDSDisabled=wanted;
            logInfo(`[${PLUGIN_NAME}] RDS Follow: ${rdsFollowMode?'ON':'OFF'}`);
            if (rdsFollowMode) { clearRDSInDataHandler(); applyFollowToDataHandler(); }
            dbDirty=true; saveDB();
        }
        broadcast({type:'rdsm_rds_follow_state',enabled:rdsFollowMode,ts:Date.now()});
        return;
    }
    if (msg.type==='rdsm_get_rds_follow') {
        broadcast({type:'rdsm_rds_follow_state',enabled:rdsFollowMode,ts:Date.now()});
        return;
    }
    if (msg.type==='rdsm_set_exclusive') {
        if (msg.adminToken!==getAdminToken()) {
            logWarn(`[${PLUGIN_NAME}] Unauthorized exclusive mode attempt`);
            broadcast({type:'rdsm_exclusive_state',enabled:aiExclusiveMode,error:'unauthorized',ts:Date.now()});
            return;
        }
        aiExclusiveMode=!!msg.enabled;
        logInfo(`[${PLUGIN_NAME}] AI Exclusive: ${aiExclusiveMode?'ON':'OFF'}`);
        broadcast({type:'rdsm_exclusive_state',enabled:aiExclusiveMode,ts:Date.now()});
        return;
    }
    if (msg.type==='rdsm_get_exclusive')
        broadcast({type:'rdsm_exclusive_state',enabled:aiExclusiveMode,ts:Date.now()});
}

function registerAPIRoutes() {
    try {
        const app=pluginsApi.getHttpServer();
        if (!app) return;
        app.on('request',(req,res)=>{
            if (req.method==='GET'&&req.url==='/api/rdsm/stats') {
                res.writeHead(200,{'Content-Type':'application/json'});
                res.end(JSON.stringify({
                    stations:Object.keys(db).filter(k=>k!=='_meta').length,
                    current:currentState.pi, piConfirmed,
                    freq:currentFreq, freqRounded:roundFreq(currentFreq),
                    uptime:process.uptime(), aiExclusiveMode, rdsFollowMode,
                }));
                return;
            }
            if (req.method==='GET'&&req.url?.startsWith('/api/rdsm/pi/')) {
                const pi=req.url.split('/').pop().toUpperCase();
                const entry=db[pi];
                if (!entry) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'not found'})); return; }
                const psVoteTotal=Object.values(entry.ps).reduce((a,posVotes)=>{
                    const wv=getWeightedVotes(posVotes);
                    return a+Object.values(wv).reduce((x,y)=>x+y,0);
                },0);
                res.writeHead(200,{'Content-Type':'application/json'});
                res.end(JSON.stringify({
                    freq:entry.freq, psResolved:entry.psResolved, psConf:entry.psConf,
                    psVoteTotal:Math.round(psVoteTotal), psIsDynamic:entry.psIsDynamic,
                    psLastRaw:entry.psLastRaw?.join(''),
                    psLastRawAge:entry.psLastRawTs?Math.round((Date.now()-entry.psLastRawTs)/1000)+'s':null,
                    pty:entry.pty,tp:entry.tp,ta:entry.ta,ecc:entry.ecc,
                    seen:entry.seen,seenCount:entry.seenCount,
                }));
            }
        });
        logInfo(`[${PLUGIN_NAME}] API routes registered`);
    } catch(e) {}
}

function hookDataHandler() {
    try {
        const dh=require('../../server/datahandler');
        if (!dh?.handleData) { logWarn(`[${PLUGIN_NAME}] handleData not found – retrying`); setTimeout(hookDataHandler,2000); return; }
        if (dh._rdsm_patched) return;
        const orig=dh.handleData;
        dh.handleData=function(wss,receivedData,rdsWss) {
            if (!pluginsMainWss&&wss) pluginsMainWss=wss;
            interceptLines(receivedData);
            if (aiExclusiveMode) return;
            const dataForNative=nativeRDSDisabled?stripRDSLines(receivedData):receivedData;
            const result=orig.call(this,wss,dataForNative,rdsWss);
            if (rdsFollowMode&&piConfirmed) applyFollowToDataHandler();
            return result;
        };
        dh._rdsm_patched=true;
        logInfo(`[${PLUGIN_NAME}] v4.4.0 ready – RDS Follow: ${rdsFollowMode?'ON':'OFF'}`);
        if (rdsFollowMode) { clearRDSInDataHandler(); applyFollowToDataHandler(); }
    } catch(e) { logWarn(`[${PLUGIN_NAME}] Patch failed: ${e.message}`); }
}

function start() {
    loadDB();
    const iv=setInterval(()=>{
        pluginsWss=pluginsApi.getPluginsWss();
        if (pluginsWss) {
            clearInterval(iv);
            pluginsWss.on('connection',ws=>{
                ws.send(JSON.stringify({type:'rdsm_exclusive_state', enabled:aiExclusiveMode,ts:Date.now()}));
                ws.send(JSON.stringify({type:'rdsm_rds_follow_state',enabled:rdsFollowMode,  ts:Date.now()}));
                ws.on('message',data=>handlePluginMessage(data));
            });
            hookDataHandler();
            registerAPIRoutes();
        }
    },500);
}
start();