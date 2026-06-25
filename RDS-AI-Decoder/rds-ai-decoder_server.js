///////////////////////////////////////////////////////////////
//                                                           //
//  RDS AI DECODER SERVER PLUGIN FOR FM-DX-WEBSERVER (V3.0)  //
//                                                           //
//  by Highpoint                last update: 2026-06-24      //
//                                                           //
//  https://github.com/Highpoint2000/RDS-AI-Decoder          //
//                                                           //
///////////////////////////////////////////////////////////////


'use strict';

const fs         = require('fs');
const path       = require('path');
const WebSocket  = require('ws');
const pluginsApi = require('../../server/plugins_api');
const { logInfo, logWarn, logError } = require('../../server/console');

const pluginConfig = {
    name:         'RDS AI Decoder',
    version:      '3.6',
    frontEndPath: 'rds-ai-decoder.js',
};
module.exports = { pluginConfig };

const PLUGIN_NAME          = 'RDS AI Decoder';
const FMDX_BULK_FILE       = path.join(__dirname, 'rdsm_fmdx_cache.json');
const OLD_MEMORY_FILE      = path.join(__dirname, 'rdsm_memory.json');

// 7 Days Cache for FMDX Database (No Radius Limits)
const FMDX_BULK_TTL_MS     = 7 * 24 * 60 * 60 * 1000; 
const FMDX_REINDEX_MIN_DIST_KM = 100;

const SPECIAL_PI_CODES = new Set(['FFFF', '0000']);
function isSpecialPI(pi) {
    return !pi || SPECIAL_PI_CODES.has(pi.toUpperCase());
}

// ── Server-Side Recording & MUF State ────────────────────────
const logDir = path.resolve(__dirname, '../../web/logs');
let isRecording = false;
let recordStream = null;
let recordFileName = '';

let mufMode = 'OFF'; 
let mufCheckInterval = null;
let mufTriggeredRecord = false;

// ── Module-level state ───────────────────────────────────────
let aiExclusiveMode    = false;
let rdsFollowMode      = true;
let rdsFollowLocked    = true;
let nativeRDSDisabled  = true;
let pluginsWss         = null;
let pluginsMainWss     = null;
let legacyPiCache      = null;

let nativePI = '?';
let nativePS = '        ';

let ownLat = null;
let ownLon = null;
let fmdxIndexLat = null;
let fmdxIndexLon = null;

let gpsWsClient      = null;
let gpsWsReconnTimer = null;

let fmdxByFreq   = {};
let fmdxByPI     = {};
let fmdxLoadedAt = 0;

let currentState = {
    pi: null, freq: null,
    psBuf:    new Array(8).fill(' '),
    psErrBuf: new Array(8).fill(3),
    psSegsSeen: new Set(),
    rtSlots:  Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 })),
    rtAB: -1,
    tp: false, ta: false, ms: -1, stereo: false, pty: 0,
    afSet: new Set(),
    ecc: null,
    latestAi: { ps: null, conf: 0, fmdx: '', itu: '', reason: '', statusColor: '#6c757d' },
    frozenPs: null,
    rawAccumulatedPS: '        '
};

function roundGps(coord) { return Math.round(coord * 100) / 100; }

function startGpsWsListener() {
    let wsPort = 8080;
    try {
        const cfgPath = path.join(__dirname, '../../config.json');
        if (fs.existsSync(cfgPath)) wsPort = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.webserver?.webserverPort || 8080;
    } catch(e) {}

    function connect() {
        if (gpsWsClient) { try { gpsWsClient.removeAllListeners(); gpsWsClient.terminate(); } catch(e) {} }
        gpsWsClient = new WebSocket(`ws://127.0.0.1:${wsPort}/data_plugins`);
        gpsWsClient.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                if (msg.type === 'GPS' && msg.value && msg.value.status === 'active') {
                    const lat = roundGps(parseFloat(msg.value.lat));
                    const lon = roundGps(parseFloat(msg.value.lon));
                    ownLat = lat; ownLon = lon;

                    if (fmdxLoadedAt > 0 && (fmdxIndexLat === null || haversineKm(fmdxIndexLat, fmdxIndexLon, lat, lon) >= FMDX_REINDEX_MIN_DIST_KM)) {
                        try {
                            const cached = JSON.parse(fs.readFileSync(FMDX_BULK_FILE, 'utf8'));
                            if (cached && cached.raw) { buildFmdxIndex(cached.raw); fmdxIndexLat = lat; fmdxIndexLon = lon; }
                        } catch(e) {}
                    }
                }
            } catch(e) {}
        });
        gpsWsClient.on('close', () => scheduleGpsWsReconnect());
        gpsWsClient.on('error', () => scheduleGpsWsReconnect());
    }

    function scheduleGpsWsReconnect() {
        if (gpsWsReconnTimer) return;
        gpsWsReconnTimer = setTimeout(() => { gpsWsReconnTimer = null; connect(); }, 15000);
    }
    setTimeout(connect, 5000);
}

function loadOwnLocation() {
    try {
        const cfgPath = path.join(__dirname, '../../config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            const lat = parseFloat(cfg?.identification?.lat), lon = parseFloat(cfg?.identification?.lon);
            if (!isNaN(lat) && !isNaN(lon)) { ownLat = roundGps(lat); ownLon = roundGps(lon); }
        }
    } catch(e) {}
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R  = 6371;
    const dL = (lat2 - lat1) * Math.PI / 180;
    const dO = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(dL/2) * Math.sin(dL/2)
             + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180)
             * Math.sin(dO/2) * Math.sin(dO/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calculateBearing(lat1, lon1, lat2, lon2) {
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const lam1 = lon1 * Math.PI / 180;
    const lam2 = lon2 * Math.PI / 180;

    const y = Math.sin(lam2 - lam1) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) -
              Math.sin(phi1) * Math.cos(phi2) * Math.cos(lam2 - lam1);
    const theta = Math.atan2(y, x);
    const brng = (theta * 180 / Math.PI + 360) % 360;
    return Math.round(brng);
}

function roundFreq(freqStr) {
    const f = parseFloat(freqStr);
    return isNaN(f) ? freqStr : (Math.round(f * 10) / 10).toFixed(2);
}

function parsePSVariants(psRaw) {
    if (!psRaw || typeof psRaw !== 'string') return [];
    const variants = [];
    psRaw.split(' ').forEach(t => { if (t.trim()) variants.push(t.slice(0, 8).padEnd(8, '_').replace(/ /g, '_')); });
    if (variants.length === 0) variants.push(psRaw.replace(/ /g, '_').trim().slice(0, 8).padEnd(8, '_'));
    return variants;
}

function nodeHttpGetJSON(url) {
    return new Promise((resolve, reject) => {
        const req = (url.startsWith('https') ? require('https') : require('http')).get(url, { timeout: 60000 }, res => {
            let body = ''; res.on('data', d => body += d); res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        });
        req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function checkMUFStatus() {
    if (mufMode === 'OFF') return;
    const regionMap = { 'EU': 'europe', 'NA': 'north_america', 'AU': 'australia' };
    const regionKey = regionMap[mufMode];
    if (!regionKey) return;

    try {
        const json = await nodeHttpGetJSON('https://fmdx.org/includes/tools/get_muf.php');
        if (json[regionKey] && parseFloat(json[regionKey].max_frequency) > 0) {
            if (!isRecording) { mufTriggeredRecord = true; startServerRecording(); }
        } else if (isRecording && mufTriggeredRecord) { stopServerRecording(true); }
    } catch (e) {}
}

function startServerRecording() {
    if (isRecording) return;
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const d = new Date();
    recordFileName = `RDS_RAW_${d.getFullYear()}${(d.getMonth()+1).toString().padStart(2,'0')}${d.getDate().toString().padStart(2,'0')}_${d.getHours().toString().padStart(2,'0')}${d.getMinutes().toString().padStart(2,'0')}${d.getSeconds().toString().padStart(2,'0')}.csv`;
    recordStream = fs.createWriteStream(path.join(logDir, recordFileName), { flags: 'a' });
    recordStream.write('Timestamp,Frequency_MHz,PI,Block2,Block3,Block4,Errors,AI_PS,AI_Conf,FMDX_Name,ITU\n');
    isRecording = true;
    broadcast({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode, locked: rdsFollowLocked, isRecording: true, mufMode });
}

function stopServerRecording(silent = false) {
    if (!isRecording) return;
    if (recordStream) { recordStream.end(); recordStream = null; }
    isRecording = false; mufTriggeredRecord = false;
    broadcast({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode, locked: rdsFollowLocked, isRecording: false, downloadUrl: silent ? null : `/logs/${recordFileName}`, mufMode, silentStop: silent });
}

async function loadFmdxBulk() {
    if (fs.existsSync(FMDX_BULK_FILE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(FMDX_BULK_FILE, 'utf8'));
            if (cached._ts && (Date.now() - cached._ts) < FMDX_BULK_TTL_MS && cached.raw) {
                fmdxLoadedAt = cached._ts; buildFmdxIndex(cached.raw);
                if (Object.keys(fmdxByFreq).length > 0) {
                    setTimeout(downloadFmdxBulk, Math.max(FMDX_BULK_TTL_MS - (Date.now() - cached._ts), 60000));
                    return;
                }
            }
        } catch(e) {}
    }
    await downloadFmdxBulk();
}

async function downloadFmdxBulk() {
    if (ownLat === null || ownLon === null) return;
    const url = `https://maps.fmdx.org/api/?qth=${ownLat},${ownLon}`;
    try {
        let raw;
        if (typeof fetch === 'function') {
            const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            raw = await res.json();
        } else { raw = await nodeHttpGetJSON(url); }
        
        fmdxLoadedAt = Date.now();
        buildFmdxIndex(raw);
        fmdxIndexLat = ownLat; fmdxIndexLon = ownLon;
        fs.writeFileSync(FMDX_BULK_FILE, JSON.stringify({ _ts: fmdxLoadedAt, raw }), 'utf8');
        setTimeout(downloadFmdxBulk, FMDX_BULK_TTL_MS);
    } catch(e) { setTimeout(downloadFmdxBulk, 10 * 60 * 1000); }
}

function buildFmdxIndex(raw) {
    const byFreq = {};
    const byPI = {};
    let locations = {};
    if (raw.locations && typeof raw.locations === 'object' && !Array.isArray(raw.locations)) locations = raw.locations;
    else if (Object.values(raw)[0] && Array.isArray(Object.values(raw)[0].stations)) locations = raw;

    for (const [txId, txData] of Object.entries(locations)) {
        if (!txData || !Array.isArray(txData.stations)) continue;
        const txLat  = parseFloat(txData.lat);
        const txLon  = parseFloat(txData.lon);
        const txName = txData.name || txId; 
        const txItu  = txData.itu  || null;
        
        let distKm = null;
        let azimuth = null;
        if (!isNaN(txLat) && !isNaN(txLon) && ownLat !== null && ownLon !== null) {
            distKm = Math.round(haversineKm(ownLat, ownLon, txLat, txLon));
            azimuth = calculateBearing(ownLat, ownLon, txLat, txLon);
        }

        for (const st of txData.stations) {
            if (!st.pi || !st.freq) continue;
            const f = roundFreq(String(st.freq));
            
            const entry = {
                pi: st.pi.toUpperCase(), pireg: st.pireg ? st.pireg.toUpperCase() : null,
                psVariants: parsePSVariants(st.ps),
                station: st.station || txName,
                txName: txName, itu: txItu,
                distKm: distKm, azimuth: azimuth,
                erp: st.erp !== undefined ? st.erp : null, 
                pol: st.pol ? st.pol.toUpperCase() : null
            };
            
            if (!byFreq[f]) byFreq[f] = [];
            byFreq[f].push(entry);

            if (!byPI[st.pi.toUpperCase()]) byPI[st.pi.toUpperCase()] = [];
            byPI[st.pi.toUpperCase()].push({ ...entry, freq: f });
        }
    }
    
    for (const f of Object.keys(byFreq)) byFreq[f].sort((a, b) => (a.distKm || 9999) - (b.distKm || 9999));
    for (const pi of Object.keys(byPI)) byPI[pi].sort((a, b) => (a.distKm || 9999) - (b.distKm || 9999));
    
    fmdxByFreq = byFreq;
    fmdxByPI = byPI;
}

const fmdxCache = {};
async function fetchFmdxForFreq(freq) {
    if (!freq || freq === '-') return null;
    const rounded = roundFreq(freq);
    if (fmdxByFreq[rounded] && fmdxByFreq[rounded].length > 0) return fmdxByFreq[rounded];
    
    if (fmdxCache[freq] && (Date.now() - fmdxCache[freq].ts < 86400000)) return fmdxCache[freq].data;
    try {
        const res = await fetch(`https://maps.fmdx.org/api/?freq=${freq}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        const data = await res.json();
        
        let searchData = data.locations ? data.locations : (data.data ? data.data : data);
        let liveEntries = [];
        for (const locKey in searchData) {
            const loc = searchData[locKey];
            if (!loc || !loc.stations) continue;
            
            const txLat  = parseFloat(loc.lat);
            const txLon  = parseFloat(loc.lon);
            let distKm = null;
            let azimuth = null;
            if (!isNaN(txLat) && !isNaN(txLon) && ownLat !== null && ownLon !== null) {
                distKm = Math.round(haversineKm(ownLat, ownLon, txLat, txLon));
                azimuth = calculateBearing(ownLat, ownLon, txLat, txLon);
            }
            
            loc.stations.forEach(st => {
                liveEntries.push({
                    pi: st.pi.toUpperCase(), pireg: st.pireg ? st.pireg.toUpperCase() : null,
                    psVariants: parsePSVariants(st.ps), station: st.station, txName: loc.name || locKey, itu: loc.itu || '',
                    distKm: distKm, azimuth: azimuth, erp: st.erp !== undefined ? st.erp : null, pol: st.pol ? st.pol.toUpperCase() : null
                });
            });
        }
        fmdxCache[freq] = { ts: Date.now(), data: liveEntries };
        return liveEntries;
    } catch (e) { return null; }
}

const RDS_CHARSET = [' ','!','"','#','¤','%','&',"'",'(',')','*','+',',','-','.','/','0','1','2','3','4','5','6','7','8','9',':',';','<','=','>','?','@','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','[','\\',']','―','_','‖','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z','{','|','}','¯',' ','á','à','é','è','í','ì','ó','ò','ú','ù','Ñ','Ç','Ş','β','¡','Ĳ','â','ä','ê','ë','î','ï','ô','ö','û','ü','ñ','ç','ş','ǧ','ı','ĳ','ª','α','©','‰','Ǧ','ě','ň','ő','π','€','£','$','←','↑','→','↓','º','¹','²','³','±','İ','ń','ű','µ','¿','÷','°','¼','½','¾','§','Á','À','É','È','Í','Ì','Ó','Ò','Ú','Ù','Ř','Č','Š','Ž','Ð','Ŀ','Â','Ä','Ê','Ë','Î','Ï','Ô','Ö','Û','Ü','ř','č','š','ž','đ','ŀ','Ã','Å','Æ','Œ','ŷ','Ý','Õ','Ø','Þ','Ŋ','Ŕ','Ć','Ś','Ź','Ŧ','ð','ã','å','æ','œ','ŵ','ý','õ','ø','þ','ŋ','ŕ','ć','ś','ź','ŧ',' '];
function rdsChar(b) { return b === 0x0D ? '\r' : (b < 0x20 ? ' ' : (RDS_CHARSET[b - 0x20] || ' ')); }
function decodeAFCode(code) { return (code >= 1 && code <= 204) ? (code + 875) / 10 : null; }

function countCleanRawPositions() {
    let n = 0;
    for (let i = 0; i < 8; i++) {
        if ((currentState.psErrBuf[i] ?? 3) <= 1) n++;
    }
    return n;
}

function calculatePropagationScore(ref) {
    if (!ref) return 0;
    const distKm = ref.distKm || 9999;
    let distScore = 0;
    
    if (distKm <= 100) distScore = 100;
    else if (distKm <= 300) distScore = 80;
    else if (distKm <= 800) distScore = 40; 
    else if (distKm <= 2500) {
        distScore = mufTriggeredRecord ? 60 : 20; 
    }
    else distScore = 5;
    
    const erp = ref.erp || 0.1; 
    const pwrScore = Math.min(50, Math.log10(Math.max(1, erp * 10)) * 15);
    
    let siteBonus = 0;
    if (ref.txName) {
        let sharedSites = 0;
        for (const f of currentState.afSet) {
            const freqRefs = fmdxByFreq[parseFloat(f).toFixed(2)] || [];
            if (freqRefs.some(r => r.txName === ref.txName)) {
                sharedSites++;
            }
        }
        siteBonus = Math.min(30, sharedSites * 10);
    }
    
    let spEBonus = 0;
    if (distKm > 800 && distKm < 2500) {
        const cleanCount = countCleanRawPositions();
        if (cleanCount >= 4) spEBonus = mufTriggeredRecord ? 40 : 20; 
    }
    
    return distScore + pwrScore + siteBonus + spEBonus;
}

async function runLocalAiPrediction(pi) {
    if (!currentState.freq || currentState.freq === '-') return;

    if (isSpecialPI(pi)) {
        let rawPS = currentState.psBuf.map((c, i) => currentState.psErrBuf[i] <= 1 ? c : ' ').join('');
        currentState.latestAi = { ps: rawPS, conf: 100, fmdx: 'Special PI', itu: '', reason: `DB bypassed for special PI ${pi}.`, statusColor: '#6c757d' };
        return;
    }

    const freqRefs = await fetchFmdxForFreq(currentState.freq);
    if (!freqRefs) return;

    let matchingStations = [];
    for (const st of freqRefs) {
        let piMatch = false;
        if (st.pi && st.pi === pi) piMatch = true;
        else if (st.pireg) {
            const piregs = st.pireg.toString().split(/[,|/ ]+/);
            if (piregs.some(p => p === pi)) piMatch = true;
        }
        if (piMatch) {
            let possiblePS = st.psVariants.length > 0 ? st.psVariants : [st.station.replace(/ /g, '_').padEnd(8, '_')];
            st.possiblePS = possiblePS;
            matchingStations.push(st);
        }
    }

    if (matchingStations.length === 0) {
        let rawPS = currentState.rawAccumulatedPS.trim().length > 0 ? 
                    currentState.rawAccumulatedPS : 
                    currentState.psBuf.map((c, i) => currentState.psErrBuf[i] <= 1 ? c : ' ').join('');
        currentState.latestAi = { 
            ps: rawPS,
            conf: 0, 
            fmdx: '', 
            itu: '', 
            reason: `No DB entry found for PI ${pi}. Falling back to raw data.`, 
            statusColor: '#6c757d' 
        };
        return;
    }

    const decodedPairs = [];
    for (let i = 0; i < 8; i += 2) {
        if ((currentState.psErrBuf[i] <= 1 && currentState.psBuf[i] !== ' ') || (currentState.psErrBuf[i+1] <= 1 && currentState.psBuf[i+1] !== ' ')) {
            const c0 = (currentState.psErrBuf[i] <= 1 && currentState.psBuf[i] !== ' ') ? currentState.psBuf[i].toUpperCase() : null;
            const c1 = (currentState.psErrBuf[i+1] <= 1 && currentState.psBuf[i+1] !== ' ') ? currentState.psBuf[i+1].toUpperCase() : null;
            decodedPairs.push({ index: i, c0, c1 });
        }
    }

    const decodedCharCount = currentState.psBuf.filter((c, i) => c !== ' ' && currentState.psErrBuf[i] <= 1).length;
    let candidateStations = [];

    for (const s of matchingStations) {
        let perfectFrames = [];
        for (const dbPs of s.possiblePS) {
            const psUpper = dbPs.toUpperCase();
            let matchesThisFrame = true;
            for (const pair of decodedPairs) {
                if (pair.c0 !== null && psUpper[pair.index] !== pair.c0) matchesThisFrame = false;
                if (pair.c1 !== null && psUpper[pair.index + 1] !== pair.c1) matchesThisFrame = false;
            }
            if (matchesThisFrame) perfectFrames.push(dbPs);
        }

        let isChimera = true;
        for (const pair of decodedPairs) {
            let pairFound = false;
            for (const dbPs of s.possiblePS) {
                const psUpper = dbPs.toUpperCase();
                let pairMatches = true;
                if (pair.c0 !== null && psUpper[pair.index] !== pair.c0) pairMatches = false;
                if (pair.c1 !== null && psUpper[pair.index + 1] !== pair.c1) pairMatches = false;
                if (pairMatches) { pairFound = true; break; }
            }
            if (!pairFound) { isChimera = false; break; } 
        }

        if (perfectFrames.length > 0 || isChimera) candidateStations.push({ station: s, perfectFrames, isChimera: perfectFrames.length === 0 && isChimera });
    }

    if (candidateStations.length > 1) {
        const uniqueItus = [...new Set(candidateStations.map(c => c.station.itu).filter(i => i))];
        if (uniqueItus.length === 1) candidateStations = [candidateStations[0]];
    }
    
    if (candidateStations.length > 1) {
        let highestScore = -1;
        let bestCandidate = candidateStations[0];
        for (const cand of candidateStations) {
            const score = calculatePropagationScore(cand.station);
            if (score > highestScore) {
                highestScore = score;
                bestCandidate = cand;
            }
        }
        candidateStations = [bestCandidate];
    }

    let currentReason = "", currentColor = "", psRes = null, confRes = 0, fmdxRes = '', ituRes = '';
    let refTxName = null, refErp = null, refPol = null, refDistKm = null, refAzimuth = null;

    if (matchingStations.length === 1 && decodedCharCount === 0) {
        const best = matchingStations[0];
        psRes = best.possiblePS[0]; confRes = 100; fmdxRes = best.station; ituRes = best.itu;
        refTxName = best.txName; refErp = best.erp; refPol = best.pol; refDistKm = best.distKm; refAzimuth = best.azimuth;
        currentReason = `Only 1 station in DB for PI ${pi}. Using primary frame.`; currentColor = "#28a745";
    } else if (candidateStations.length === 1) {
        const candidate = candidateStations[0];
        fmdxRes = candidate.station.station; ituRes = candidate.station.itu;
        refTxName = candidate.station.txName; refErp = candidate.station.erp; refPol = candidate.station.pol; refDistKm = candidate.station.distKm; refAzimuth = candidate.station.azimuth;
        
        let bestCurrentFrame = candidate.station.possiblePS[0];
        let maxScore = -1, perfectScoreFrame = null;
        
        for (const dbPs of candidate.station.possiblePS) {
            const psUpper = dbPs.toUpperCase();
            let score = 0;
            for (let i = 0; i < 8; i++) if (currentState.psErrBuf[i] <= 1 && currentState.psBuf[i] !== ' ' && psUpper[i] === currentState.psBuf[i].toUpperCase()) score++;
            if (score > maxScore) { maxScore = score; bestCurrentFrame = dbPs; }
            if (score === 8) perfectScoreFrame = dbPs; 
        }
        
        if (perfectScoreFrame) currentState.frozenPs = perfectScoreFrame;

        if (currentState.frozenPs) {
            psRes = currentState.frozenPs; confRes = 100;
            currentReason = perfectScoreFrame ? `Unambiguous match! Solid 100% lock on frame '${currentState.frozenPs}'.` : `Station locked. Holding frozen frame '${currentState.frozenPs}'.`;
            currentColor = "#28a745";
        } else {
            psRes = bestCurrentFrame; confRes = 100; 
            currentReason = candidate.perfectFrames.length > 0 ? `Unambiguous station match! Building PS.` : `Unambiguous station match! Building PS (Chimera).`;
            currentColor = "#28a745";
        }
    } else if (candidateStations.length > 1) {
        const first = candidateStations[0].station;
        psRes = first.possiblePS[0]; confRes = 50; fmdxRes = first.station; ituRes = first.itu;
        refTxName = first.txName; refErp = first.erp; refPol = first.pol; refDistKm = first.distKm; refAzimuth = first.azimuth;
        currentReason = `Ambiguous! Decoded pairs fit multiple DIFFERENT stations. Waiting for more data.`; currentColor = "#fd7e14";
    } else {
        const validItus = matchingStations.map(s => s.itu).filter(i => i !== undefined && i !== "");
        const uniqueItus = [...new Set(validItus)];
        
        if (uniqueItus.length === 1) {
            const fallbackMatch = matchingStations[0]; 
            fmdxRes = fallbackMatch.station; ituRes = fallbackMatch.itu || uniqueItus[0];
            refTxName = fallbackMatch.txName; refErp = fallbackMatch.erp; refPol = fallbackMatch.pol; refDistKm = fallbackMatch.distKm; refAzimuth = fallbackMatch.azimuth;
            
            if (currentState.frozenPs) {
                psRes = currentState.frozenPs; confRes = 100;
                currentReason = `Signal mismatch detected. Ignoring errors and holding frozen frame '${currentState.frozenPs}'.`; currentColor = "#28a745"; 
            } else {
                psRes = fallbackMatch.possiblePS[0]; confRes = 100; 
                currentReason = `Unique ITU Match! All valid DB entries belong to '${uniqueItus[0]}'. Using primary frame.`; currentColor = "#28a745";
            }
        } else {
            let rawPS = currentState.rawAccumulatedPS.trim().length > 0 ? 
                        currentState.rawAccumulatedPS : 
                        currentState.psBuf.map((c, i) => currentState.psErrBuf[i] <= 1 ? c : ' ').join('');
            if (currentState.frozenPs) {
                psRes = currentState.frozenPs; confRes = 100;
                currentReason = `Signal mismatch detected. Ignoring errors and holding frozen frame '${currentState.frozenPs}'.`; currentColor = "#28a745"; 
            } else {
                psRes = rawPS; confRes = 0;
                currentReason = `Mismatch Error! Decoded chars conflict with known frames. Passing raw data.`; currentColor = "#dc3545";
            }
        }
    }

    currentState.latestAi = { 
        ps: psRes, conf: confRes, fmdx: fmdxRes, itu: ituRes, 
        reason: currentReason, statusColor: currentColor,
        refTxName, refErp, refPol, refDistKm, refAzimuth
    };
}

let dataHandler = null;
try { dataHandler = require('../../server/datahandler'); } catch(e) {}

function clearRDSInDataHandler() {
    if (!dataHandler) return;
    const rdsFields = { pi: '?', ps: '        ', ps_errors: '0,0,0,0,0,0,0,0', pty: 0, tp: 0, ta: 0, ms: -1, rt0: '', rt1: '', rt0_errors: '', rt1_errors: '', rt_flag: '', rds: false, ecc: null, country_name: '', country_iso: 'UN', lic: 0, lang: '' };
    Object.assign(dataHandler.dataToSend,  rdsFields);
    Object.assign(dataHandler.initialData, rdsFields);
    if (Array.isArray(dataHandler.dataToSend.af))  dataHandler.dataToSend.af.length  = 0;
    if (Array.isArray(dataHandler.initialData.af)) dataHandler.initialData.af.length = 0;
    
    if (currentState.freq) {
        const freqFmt = parseFloat(currentState.freq).toFixed(3);
        dataHandler.dataToSend.freq  = freqFmt; dataHandler.initialData.freq = freqFmt;
    }
}

function applyFollowToDataHandler() {
    if (!dataHandler || !rdsFollowMode) return;
    const pi = currentState.pi;
    if (!pi || isSpecialPI(pi)) return;

    dataHandler.dataToSend.pi  = (pi && pi !== '----' && pi !== '?') ? pi : '?';
    dataHandler.initialData.pi = dataHandler.dataToSend.pi;

    let targetPS = '        ';
    
    if (currentState.frozenPs) {
        targetPS = currentState.frozenPs;
    } else if (currentState.latestAi && currentState.latestAi.ps && currentState.latestAi.conf > 0 && currentState.latestAi.ps.trim().length > 0) {
        targetPS = currentState.latestAi.ps;
    } else {
        targetPS = currentState.rawAccumulatedPS.trim().length > 0 ? 
                   currentState.rawAccumulatedPS : 
                   currentState.psBuf.map((c, i) => currentState.psErrBuf[i] <= 1 ? c : ' ').join('');
    }

    dataHandler.dataToSend.ps = targetPS.replace(/_/g, ' '); 
    dataHandler.dataToSend.ps_errors = '0,0,0,0,0,0,0,0';
    dataHandler.initialData.ps = dataHandler.dataToSend.ps;
    
    dataHandler.dataToSend.tp = currentState.tp ? 1 : 0;
    dataHandler.dataToSend.ta = currentState.ta ? 1 : 0;
    dataHandler.dataToSend.ms = currentState.ms;
    dataHandler.dataToSend.pty = currentState.pty;

    let rtLive = '';
    for (let i = 0; i < 64; i++) {
        const sl = currentState.rtSlots[i];
        if (!sl || sl.char === '\r') break;
        if (sl.conf > 0) rtLive += sl.char; else if (rtLive.length > 0) break;
    }
    rtLive = rtLive.trimEnd();

    if (rtLive.trim().length >= 3) {
        const rtFlag = currentState.rtAB >= 0 ? currentState.rtAB : 0;
        if (rtFlag === 0) { dataHandler.dataToSend.rt0 = rtLive; dataHandler.dataToSend.rt0_errors = ''; }
        else              { dataHandler.dataToSend.rt1 = rtLive; dataHandler.dataToSend.rt1_errors = ''; }
        dataHandler.dataToSend.rt_flag = rtFlag;
        dataHandler.initialData.rt0 = dataHandler.dataToSend.rt0;
        dataHandler.initialData.rt1 = dataHandler.dataToSend.rt1;
        dataHandler.initialData.rt_flag = rtFlag;
    }

    if (currentState.ecc) dataHandler.dataToSend.ecc = parseInt(currentState.ecc, 16);
    dataHandler.dataToSend.rds = true;

    if (!Array.isArray(dataHandler.dataToSend.af)) dataHandler.dataToSend.af = [];
    dataHandler.dataToSend.af.length = 0;
    for (const f of currentState.afSet) dataHandler.dataToSend.af.push(Math.round(parseFloat(f) * 1000));
    dataHandler.dataToSend.af.sort((a, b) => a - b);
}

function decodeGroup(pi, b2hex, b3hex, b4hex, errB) {
    if (!b2hex) return;
    const g2 = parseInt(b2hex, 16), g3 = b3hex ? parseInt(b3hex, 16) : NaN, g4 = b4hex ? parseInt(b4hex, 16) : NaN;
    const gT = (g2 >> 12) & 0x0F, vB = (g2 >> 11) & 0x01;
    const blkAok = errB[0] <= 1, blkBok = errB[1] <= 1;

    if (blkAok && blkBok) {
        currentState.tp = !!((g2 >> 10) & 0x01);
        currentState.pty = (g2 >> 5) & 0x1F;
    }

    if (gT === 0) {
        if (blkAok && blkBok) {
            currentState.ta = !!((g2 >> 4) & 0x01);
            currentState.ms = !!((g2 >> 3) & 0x01) ? 1 : 0;
            if ((g2 & 0x03) === 3) currentState.stereo = !!((g2 >> 2) & 0x01);
        }
        if (vB === 0 && b3hex && errB[2] <= 1 && blkAok && blkBok) {
            const af1 = (g3 >> 8) & 0xFF, af2 = g3 & 0xFF;
            if (af1 !== 250) { const f1 = decodeAFCode(af1); if (f1 !== null) currentState.afSet.add(Math.round(f1*10)/10); }
            if (af2 !== 250) { const f2 = decodeAFCode(af2); if (f2 !== null) currentState.afSet.add(Math.round(f2*10)/10); }
        }
        if (b4hex && errB[3] <= 2) {
            const seg = g2 & 0x03;
            const addr = seg * 2;
            const c0 = rdsChar((g4 >> 8) & 0xFF), c1 = rdsChar(g4 & 0xFF);
            
            if (c0 !== '\r' && errB[3] <= currentState.psErrBuf[addr]) { currentState.psBuf[addr] = c0; currentState.psErrBuf[addr] = errB[3]; currentState.psSegsSeen.add(seg); }
            if (c1 !== '\r' && errB[3] <= currentState.psErrBuf[addr+1]) { currentState.psBuf[addr+1] = c1; currentState.psErrBuf[addr+1] = errB[3]; currentState.psSegsSeen.add(seg); }
            
            if (currentState.psSegsSeen.size >= 4) {
                if (currentState.psErrBuf.every(e => e <= 1)) {
                    currentState.rawAccumulatedPS = currentState.psBuf.join('');
                }
                currentState.psSegsSeen.clear();
            }
        }
    }

    if (gT === 2) {
        const abF = (g2 >> 4) & 0x01, addr = vB === 0 ? (g2 & 0x0F) * 4 : (g2 & 0x0F) * 2;
        if (abF !== currentState.rtAB) {
            currentState.rtSlots = Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 }));
            currentState.rtAB = abF;
        }
        if (vB === 0 && b3hex && errB[2] <= 2) {
            currentState.rtSlots[addr] = { char: rdsChar((g3 >> 8) & 0xFF), conf: 1 };
            currentState.rtSlots[addr + 1] = { char: rdsChar(g3 & 0xFF), conf: 1 };
        }
        if (b4hex && errB[3] <= 2) {
            const offset = vB === 0 ? 2 : 0;
            currentState.rtSlots[addr + offset] = { char: rdsChar((g4 >> 8) & 0xFF), conf: 1 };
            currentState.rtSlots[addr + offset + 1] = { char: rdsChar(g4 & 0xFF), conf: 1 };
        }
    }

    if (gT === 1 && vB === 0 && b3hex && errB[2] <= 1 && ((g3 >> 12) & 0x07) === 0) {
        const eccByte = g3 & 0xFF;
        if (eccByte > 0) currentState.ecc = eccByte.toString(16).toUpperCase().padStart(2, '0');
    }

    runLocalAiPrediction(pi).then(() => {
        let psSlots = [];
        if (currentState.latestAi && currentState.latestAi.ps) {
            for (let i = 0; i < 8; i++) psSlots.push({ char: currentState.latestAi.ps[i] || ' ', conf: currentState.latestAi.conf / 100 });
        }
        
        let psLocked = false;
        let psLockReason = '';
        if (currentState.frozenPs) {
            psLocked = true;
            psLockReason = 'Frozen DB Frame';
        } else if (currentState.latestAi.conf === 100 && currentState.latestAi.fmdx) {
            psLocked = true;
            psLockReason = 'DB verified string';
        }

        let altFreqs = fmdxByPI[pi] || [];
        
        broadcast({ 
            type: 'rdsm_ai', ts: Date.now(), pi: pi, ps: psSlots, 
            psName: currentState.latestAi.fmdx, stats: { 
                refItu: currentState.latestAi.itu,
                refTxName: currentState.latestAi.refTxName,
                refErp: currentState.latestAi.refErp,
                refPol: currentState.latestAi.refPol,
                refDistKm: currentState.latestAi.refDistKm,
                refAzimuth: currentState.latestAi.refAzimuth
            },
            aiReason: currentState.latestAi.reason, aiColor: currentState.latestAi.statusColor,
            aiConf: currentState.latestAi.conf,
            af: Array.from(currentState.afSet),
            altFreqs: altFreqs,
            psLocked: psLocked,
            psLockReason: psLockReason
        });

        if (rdsFollowMode) applyFollowToDataHandler();
    });
}

function parseAndDispatch(raw) {
    let dataHex, errorHex;
    if (raw.length >= 18) { dataHex = raw.slice(0, 16); errorHex = raw.slice(16, 18); } 
    else if (raw.length === 14) {
        if (!legacyPiCache || legacyPiCache.length < 4) return;
        const legacyErr = parseInt(raw.slice(12), 16);
        let errNew = (legacyPiCache.length - 4) << 6 | (legacyErr & 0x03) << 4 | (legacyErr & 0x0C) | (legacyErr & 0x30) >> 4;
        dataHex = legacyPiCache.slice(0, 4) + raw.slice(0, 12);
        errorHex = errNew.toString(16).padStart(2, '0');
    } else return;

    const errByte = parseInt(errorHex, 16);
    const errB = [(errByte>>6)&3, (errByte>>4)&3, (errByte>>2)&3, errByte&3];
    const piRawUpper = dataHex.slice(0, 4).toUpperCase();
    const b2hex = dataHex.slice(4,  8), b3hex = dataHex.slice(8,  12), b4hex = dataHex.slice(12, 16);

    const noPayload = (errB[2] >= 2 && errB[3] >= 2);
    const badPI = (errB[0] > 1);

    if (isRecording && recordStream && !noPayload && !badPI) {
        let aiPs = '________', aiConf = 0, fmdx = '', itu = '';
        if (currentState.latestAi && currentState.latestAi.ps) {
            aiPs = currentState.latestAi.ps.padEnd(8, '_').replace(/ /g, '_'); // Force underscores
            aiConf = currentState.latestAi.conf;
            fmdx = currentState.latestAi.fmdx ? currentState.latestAi.fmdx.replace(/,/g, '') : '';
            itu = currentState.latestAi.itu ? currentState.latestAi.itu.replace(/,/g, '') : '';
        }
        recordStream.write(`${new Date().toISOString()},${currentState.freq || '-'},${piRawUpper},${b2hex},${b3hex},${b4hex},${errB.join('')},"${aiPs}",${aiConf},"${fmdx}","${itu}"\n`);
    }

    if (badPI) return;

    if (piRawUpper !== currentState.pi) {
        currentState.pi = piRawUpper;
        currentState.psBuf.fill(' '); currentState.psErrBuf.fill(3);
        currentState.psSegsSeen.clear();
        currentState.rawAccumulatedPS = '        ';
        currentState.rtSlots = Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 }));
        currentState.rtAB = -1; currentState.afSet.clear(); currentState.frozenPs = null;
    }

    decodeGroup(piRawUpper, b2hex, b3hex, b4hex, errB);
    
    broadcast({ type: 'rdsm_raw', ts: new Date().toISOString(), pi: piRawUpper, freq: currentState.freq, b2: b2hex, b3: b3hex, b4: b4hex, errB });
}

function broadcast(payload) {
    if (!pluginsWss) return;
    const msg = JSON.stringify(payload);
    pluginsWss.clients.forEach(c => { if (c.readyState === c.OPEN) try { c.send(msg); } catch(e) {} });
}

function interceptLines(data) {
    for (const line of data.split('\n')) {
        const l = line.trim();
        if (l.startsWith('P') && l.length >= 5) legacyPiCache = l.slice(1).trim();
        else if (l.startsWith('T') && l.length >= 2) {
            const freq = (parseFloat(l.slice(1)) / 1000).toFixed(3);
            if (freq !== currentState.freq) {
                currentState.freq = freq; currentState.pi = null;
                nativePI = '?';
                currentState.psBuf.fill(' '); currentState.psErrBuf.fill(3);
                currentState.psSegsSeen.clear();
                currentState.rawAccumulatedPS = '        ';
                currentState.rtSlots = Array.from({ length: 64 }, () => ({ char: ' ', conf: 0 }));
                currentState.rtAB = -1; currentState.afSet.clear(); currentState.frozenPs = null;
                legacyPiCache = null; clearRDSInDataHandler();
                broadcast({ type: 'rdsm_freq', freq, reset: true });
            }
        } else if (l.startsWith('R') && l.length >= 14) parseAndDispatch(l.slice(1).trim());
    }
}

function hookDataHandler(dh) {
    if (!dh || typeof dh.handleData !== 'function') return;
    const orig = dh.handleData.bind(dh);
    dh.handleData = function(wss, receivedData, rdsWss) {
        if (!pluginsMainWss && wss) pluginsMainWss = wss;
        interceptLines(receivedData);
        if (aiExclusiveMode) return;

        if (rdsFollowMode && currentState.pi) {
            applyFollowToDataHandler();
            const fields = ['pi', 'ps', 'ps_errors', 'pty', 'tp', 'ta', 'ms', 'rt0', 'rt1', 'rt0_errors', 'rt1_errors', 'rt_flag', 'ecc', 'country_iso', 'country_name', 'af', 'lic', 'lang'];
            const lockedData = {}, lockedInit = {};
            fields.forEach(f => {
                lockedData[f] = dh.dataToSend[f]; lockedInit[f] = dh.initialData[f];
                Object.defineProperty(dh.dataToSend, f, { get: () => lockedData[f], set: (val) => { if (f === 'pi') nativePI = val; if (f === 'ps') nativePS = val; }, configurable: true, enumerable: true });
                Object.defineProperty(dh.initialData, f, { get: () => lockedInit[f], set: () => {}, configurable: true, enumerable: true });
            });
            const result = orig.call(this, wss, receivedData, rdsWss);
            fields.forEach(f => {
                lockedData[f] = dh.dataToSend[f]; lockedInit[f] = dh.initialData[f];
                Object.defineProperty(dh.dataToSend, f, { get: () => lockedData[f], set: (val) => { lockedData[f] = val; }, configurable: true, enumerable: true });
                Object.defineProperty(dh.initialData, f, { get: () => lockedInit[f], set: (val) => { lockedInit[f] = val; }, configurable: true, enumerable: true });
            });
            return result;
        }
        const result = orig.call(this, wss, receivedData, rdsWss);
        nativePI = dh.dataToSend.pi; nativePS = dh.dataToSend.ps;
        return result;
    };
    logInfo(`[${PLUGIN_NAME}] datahandler hooked`);
}

function handlePluginMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch(e) { return; }
    if (msg.type === 'rdsm_get_rds_follow') {
        try { ws.send(JSON.stringify({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode, locked: rdsFollowLocked, isRecording, mufMode })); } catch(e) {}
        return;
    }
    if (msg.type === 'rdsm_set_rds_follow') {
        rdsFollowMode = !!msg.enabled; nativeRDSDisabled = rdsFollowMode;
        if (!rdsFollowMode) clearRDSInDataHandler(); else if (currentState.pi) applyFollowToDataHandler();
        broadcast({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode, locked: rdsFollowLocked, isRecording, mufMode });
        return;
    }
    if (msg.type === 'rdsm_set_rds_lock') {
        rdsFollowLocked = !!msg.locked;
        broadcast({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode, locked: rdsFollowLocked, isRecording, mufMode });
        return;
    }
    if (msg.type === 'rdsm_toggle_record' && msg.isAdmin) {
        if (!isRecording) { mufTriggeredRecord = false; startServerRecording(); } else { mufTriggeredRecord = false; stopServerRecording(); }
        return;
    }
    if (msg.type === 'rdsm_set_muf_mode' && msg.isAdmin) {
        mufMode = msg.mode;
        if (mufCheckInterval) { clearInterval(mufCheckInterval); mufCheckInterval = null; }
        if (mufMode !== 'OFF') { mufCheckInterval = setInterval(checkMUFStatus, 60000); checkMUFStatus(); } 
        else { if (isRecording && mufTriggeredRecord) stopServerRecording(true); mufTriggeredRecord = false; }
        broadcast({ type: 'rdsm_rds_follow_state', enabled: rdsFollowMode, locked: rdsFollowLocked, isRecording, mufMode });
        return;
    }
}

function init() {
    if (fs.existsSync(OLD_MEMORY_FILE)) {
        try {
            fs.unlinkSync(OLD_MEMORY_FILE);
            logInfo(`[${PLUGIN_NAME}] Legacy cache file 'rdsm_memory.json' deleted.`);
        } catch (e) {
            logWarn(`[${PLUGIN_NAME}] Could not delete 'rdsm_memory.json': ${e.message}`);
        }
    }

    loadOwnLocation();
    startGpsWsListener();
    if (dataHandler) hookDataHandler(dataHandler);
    pluginsWss = pluginsApi.getPluginsWss();
    pluginsMainWss = pluginsApi.getWss();
    if (pluginsWss) pluginsWss.on('connection', ws => ws.on('message', raw => handlePluginMessage(ws, raw)));
    loadFmdxBulk();
    logInfo(`[${PLUGIN_NAME}] v${pluginConfig.version} initialised`);
}

setTimeout(init, 500);