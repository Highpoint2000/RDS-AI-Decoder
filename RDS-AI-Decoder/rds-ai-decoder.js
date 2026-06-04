///////////////////////////////////////////////////////////////
//                                                           //
//  RDS AI DECODER CLIENT PLUGIN FOR FM-DX-WEBSERVER (V2.5a) //
//                                                           //
//  by Highpoint                last update: 2026-06-02      //
//                                                           //
//  https://github.com/Highpoint2000/RDS-AI-Decoder          //
//                                                           //
///////////////////////////////////////////////////////////////

(() => {

    const pluginVersion         = '2.5a';
    const pluginName            = 'RDS AI Decoder';
    const pluginHomepageUrl     = 'https://github.com/Highpoint2000/RDS-AI-Decoder/releases';
    const pluginUpdateUrl       = 'https://raw.githubusercontent.com/Highpoint2000/RDS-AI-Decoder/refs/heads/main/RDS-AI-Decoder/rds-ai-decoder.js';
    const pluginSetupOnlyNotify = false;
    const CHECK_FOR_UPDATES     = true;
    const pluginManualUrl       = 'https://highpoint.fmdx.org/manuals/RDS-AI-Decoder-Documentation.html';

    if (typeof sendToast !== 'function') {
        window.sendToast = function(cls, src, txt) {
            console.log(`[TOAST-Fallback] ${src}: ${cls} → ${txt}`);
        };
    }

    // ── Update check ──────────────────────────────────────────
    function checkUpdate(setupOnly, name, urlUpdateLink, urlFetchLink) {
        const isSetupPath = (window.location.pathname || '/').indexOf('/setup') >= 0;
        fetch(urlFetchLink + '?t=' + Date.now(), { cache: 'no-store' })
            .then(r => r.ok ? r.text() : null)
            .then(txt => {
                if (!txt) return;
                const match = txt.match(/const\s+pluginVersion\s*=\s*['"]([^'"]+)['"]/);
                if (!match) return;
                const remoteVer = match[1];
                if (remoteVer === pluginVersion) return;
                sendToast('warning', name,
                    `Update available: v${pluginVersion} -> v${remoteVer}. <a href="${urlUpdateLink}" target="_blank">Download</a>`);
                if (!setupOnly || isSetupPath) {
                    const settings = document.getElementById('plugin-settings');
                    if (settings && !settings.innerHTML.includes(urlUpdateLink))
                        settings.innerHTML += `<br><a href="${urlUpdateLink}" target="_blank">[${name}] Update: ${pluginVersion} -> ${remoteVer}</a>`;
                    const navIcon =
                        document.querySelector('.wrapper-outer #navigation .sidenav-content .fa-puzzle-piece') ||
                        document.querySelector('.wrapper-outer .sidenav-content') ||
                        document.querySelector('.sidenav-content');
                    const dotClass = name.replace(/\s+/g, '-') + '-update-dot';
                    if (navIcon && !navIcon.querySelector('.' + dotClass)) {
                        const dot = document.createElement('span');
                        dot.className = dotClass;
                        dot.style.cssText = 'display:block;width:12px;height:12px;border-radius:50%;background-color:#FE0830;margin-left:82px;margin-top:-12px;';
                        navIcon.appendChild(dot);
                    }
                }
            })
            .catch(e => console.warn(`[${name}] Update check failed:`, e));
    }
    if (CHECK_FOR_UPDATES) checkUpdate(pluginSetupOnlyNotify, pluginName, pluginHomepageUrl, pluginUpdateUrl);

    // ── WebSocket URL ─────────────────────────────────────────
    const CU = new URL(window.location.href);
    const WP = CU.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS = `${WP}//${CU.hostname}:${CU.port||(CU.protocol==='https:'?'443':'80')}/data_plugins`;

    // ── PTY table ─────────────────────────────────────────────
    const PTY = ['None','News','Current Affairs','Information','Sport','Education','Drama',
                 'Culture','Science','Varied','Pop Music','Rock Music','Easy Listening',
                 'Light Classical','Serious Classical','Other Music','Weather','Finance',
                 "Children's Programmes",'Social Affairs','Religion','Phone-In','Travel',
                 'Leisure','Jazz Music','Country Music','National Music','Oldies Music',
                 'Folk Music','Documentary','Alarm Test','Alarm'];

    // ── RDS character set (ETSI EN 50067) ────────────────────
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
    function rCh(b) {
        if (b === 0x0D) return '\r';
        if (b < 0x20)   return ' ';
        return RDS_CHARSET[b - 0x20] || ' ';
    }

    const CONF = [1.00, 0.90, 0.70, 0.00];

    // ── Slot factories ────────────────────────────────────────
    const mkPS = () => Array.from({length:8}, ()=>({char:' ',conf:0,src:'empty',rawOk:0,rawChar:null}));
    const mkRT = n   => Array.from({length:n}, ()=>({char:' ',conf:0,src:'empty'}));

    let psSlots = mkPS();
    let rtSlots = [mkRT(64), mkRT(64)];
    let rtAB    = -1;

    // ── PS fusion: incoming raw RDS block ────────────────────
    function fusePS_raw(pos, char, conf, src, errLevel) {
        const cur = psSlots[pos];
        if (errLevel <= 1 && char === cur.rawChar) { cur.rawOk = Math.min(cur.rawOk + 1, 4); }
        else { cur.rawOk = (errLevel <= 1) ? 1 : 0; cur.rawChar = char; }
        const isVerified = cur.rawOk >= 2;
        const isEmpty    = cur.src === 'empty';
        const isBigram   = cur.src === 'ai-bigram';
        const isRefSeed  = cur.src === 'ref-seed';
        const isAI       = cur.src.startsWith('ai') || cur.src.startsWith('ref');
        const isWeakRaw  = cur.src.startsWith('raw') && cur.conf < 0.75;
        if (isEmpty || isBigram || isRefSeed) {
            psSlots[pos] = {char, conf, src, rawOk:cur.rawOk, rawChar:cur.rawChar};
            return;
        }
        if (isAI) {
            if (isVerified) psSlots[pos] = {char, conf, src, rawOk:cur.rawOk, rawChar:cur.rawChar};
            else cur.rawChar = char;
            return;
        }
        if (isWeakRaw || conf >= cur.conf - 0.05)
            psSlots[pos] = {char, conf, src, rawOk:cur.rawOk, rawChar:cur.rawChar};
    }

    // ── PS fusion: incoming AI prediction ───────────────────
    function fusePS_ai(pos, char, conf, src) {
        const cur = psSlots[pos];
        if (cur.rawOk >= 2 && cur.src.startsWith('raw')) return;
        const curIsWeak = cur.src === 'empty' || cur.src === 'ai-bigram' || cur.src === 'ref-seed';
        const newIsBetter = conf > cur.conf;
        if (curIsWeak ||
            (cur.src.startsWith('ai')  && newIsBetter) ||
            (cur.src === 'ref-match'   && src === 'ref-match' && newIsBetter) ||
            (cur.src === 'ref-seed'    && newIsBetter))
            psSlots[pos] = {char, conf, src, rawOk:cur.rawOk, rawChar:cur.rawChar};
    }

    // ── RT fusion ─────────────────────────────────────────────
    function fuseRT(ab, i, char, conf, src) {
        if (i < 0 || i >= rtSlots[ab].length) return;
        const cur     = rtSlots[ab][i];
        const rawWins = src.startsWith('raw') && cur.src.startsWith('ai') && conf >= cur.conf - 0.05;
        if (conf > cur.conf || cur.src === 'empty' || rawWins)
            rtSlots[ab][i] = {char, conf, src};
    }

    // ── Stable flag debouncing ────────────────────────────────
    let _ptyCandidate = -1, _ptyCandCount = 0;
    let _taCandidate  = null, _taCandCount = 0;

    function stableFlag_PTY(pty, a, b) {
        if (!a||!b) return;
        if (pty === _ptyCandidate) {
            _ptyCandCount++;
            if (_ptyCandCount >= 2 && pty !== st.pty) {
                st.pty = pty;
                const el = document.getElementById('rdsm-pty');
                if (el) el.innerHTML = `${PTY[pty]||'?'} <span class="pty-badge">${pty}</span>`;
            }
        } else { _ptyCandidate = pty; _ptyCandCount = 1; }
    }
    function stableFlag_TP(tp, a, b) {
        if (!a||!b) return;
        if (tp !== st.tp) { st.tp = tp; setFlag('rdsm-tp', tp); }
    }
    function stableFlag_TA(ta, a, b) {
        if (!a||!b) return;
        if (ta === _taCandidate) {
            _taCandCount++;
            if (_taCandCount >= 2 && ta !== st.ta) { st.ta = ta; setFlag('rdsm-ta', ta); }
        } else { _taCandidate = ta; _taCandCount = 1; }
    }
    function stableFlag_Stereo(s, a) {
        if (!a) return;
        if (s !== st.stereo) { st.stereo = s; setFlag('rdsm-st', s); }
    }
    function stableFlag_MS(ms, a, b) {
        if (!a||!b) return;
        if (ms !== st.ms) {
            st.ms = ms;
            const el = document.getElementById('rdsm-ms');
            if (el) { el.textContent = ms ? 'MUSIC' : 'SPEECH'; el.className = 'rf on'; }
        }
    }

    // ── Global state ──────────────────────────────────────────
    let st = {
        pi:'----', piCand:'----', piN:0,
        psBuf:new Array(8).fill(' '), psGroups:new Set(),
        pty:-1, tp:false, ta:false, ms:false, stereo:false,
        rtabFlag:-1, ecc:'',
        grpTotal:0, ber:[],
        freq:'-',
        aiStats:null, aiActive:false,
        _freqChangeTs:0,
        rtLine1:'', rtLine2:'',
        rdsFollow:false,
        refStation:null, refDistKm:null, refMatchScore:0,
        refTxName:null, refItu:null, refAzimuth:null, refErp:null, refPol:null,
        af:[],
        psName:     null,
        psNameSrc:  null,
        psVariants: [],
        altFreqs:   [],

        dbFreqEntries: [],

        // Provisional → locked UI support
        psProvisional: null,
        psProvisionalConf: 0,
        psStableMs: 0,
        psLockReason: null,
        psLocked: false,
		nativePI: '-',
        nativePS: '-',
    };

    // ── Change-detection fingerprint for PS slots ─────────────
    let _lastPSFingerprint = '';
    let _lastRTFingerprint = '';

    function psSlotsFingerprint() {
        let s = '';
        for (let i = 0; i < 8; i++) {
            const sl = psSlots[i];
            s += sl.char + sl.conf.toFixed(2) + sl.src + '|';
        }
        return s;
    }
    function rtSlotsFingerprint(ab) {
        let s = '';
        const end = Math.min(64, rtSlots[ab].length);
        for (let i = 0; i < end; i++) {
            const sl = rtSlots[ab][i];
            if (sl.conf <= 0) break;
            s += sl.char + sl.conf.toFixed(2) + '|';
        }
        return s;
    }

    let ws = null, reconn = null;
    let panelVis = false, statsOpen = false;

    // ── Message dispatcher ────────────────────────────────────
    function onMessage(data) {
        let d; try { d = JSON.parse(data); } catch(e) { return; }
        switch (d.type) {
            case 'rdsm_raw':              onRaw(d);            break;
            case 'rdsm_ai':               onAI(d);             break;
            case 'rdsm_freq':             onFreq(d);           break;
            case 'rdsm_rds_follow_state': onRdsFollowState(d); break;
        }
    }

    function onRdsFollowState(d) { st.rdsFollow = !!d.enabled; syncFollowUI(); }

    // ── Frequency change ──────────────────────────────────────
    function onFreq(d) {
        st._freqChangeTs = Date.now();
        reset();
        st.freq = d.freq || '-';
        setEl('rdsm-freq', st.freq !== '-' ? st.freq + ' MHz' : '-');
        if (d.dbFreqEntries) {
            st.dbFreqEntries = d.dbFreqEntries;
            renderDbEntries();
        }
    }

    // ── Raw RDS group handler ─────────────────────────────────
    function onRaw(d) {
        if (d.freq && d.freq !== st.freq) { st.freq = d.freq; setEl('rdsm-freq', d.freq + ' MHz'); }
        if (d.pi) {
            const pi = d.pi.toUpperCase();
            if (pi === st.piCand) {
                st.piN++;
                if (st.piN >= 2 && pi !== st.pi) { st.pi = pi; setEl('rdsm-pi', pi); }
            } else { st.piCand = pi; st.piN = 1; }
        }
        if (!d.b2) { updateBER(d.errB); return; }
        const g2 = parseInt(d.b2,16), g3 = d.b3 ? parseInt(d.b3,16) : NaN, g4 = d.b4 ? parseInt(d.b4,16) : NaN;
        const gT = (g2>>12)&0xF, vB = (g2>>11)&1, tp = !!((g2>>10)&1), pty = (g2>>5)&0x1F;
        const c3 = CONF[d.errB[2]], c4 = CONF[d.errB[3]];
        const s3 = `raw-${Math.min(d.errB[2],2)}`, s4 = `raw-${Math.min(d.errB[3],2)}`;
        const blkAok = d.errB[0] <= 1, blkBok = d.errB[1] <= 1;
        const gc = document.getElementById(`rg-${gT}${vB?'B':'A'}`);
        if (gc) gc.classList.add('on');
        st.grpTotal++;
        stableFlag_TP(tp, blkAok, blkBok);
        stableFlag_PTY(pty, blkAok, blkBok);
        if (gT === 0) {
            const ta = !!((g2>>4)&1), ms = !!((g2>>3)&1), seg = g2&3, di = !!((g2>>2)&1);
            if (seg === 3) stableFlag_Stereo(di, blkAok);
            stableFlag_TA(ta, blkAok, blkBok);
            stableFlag_MS(ms, blkAok, blkBok);
            if (d.b4 && c4 > 0) {
                const addr = seg*2, c0 = rCh((g4>>8)&0xFF), c1 = rCh(g4&0xFF);
                if (c0 >= ' ') { fusePS_raw(addr,   c0, c4, s4, d.errB[3]); st.psBuf[addr]   = c0; st.psGroups.add(seg); }
                if (c1 >= ' ') { fusePS_raw(addr+1, c1, c4, s4, d.errB[3]); st.psBuf[addr+1] = c1; }
            }
        }
        if (gT === 2 && vB === 0) {
            const abF = (g2>>4)&1, addr = (g2&0xF)*4;
            if (abF !== st.rtabFlag) {
                const o = extractRTText(st.rtabFlag >= 0 ? st.rtabFlag : 0);
                if (o.trim().length >= 4) promoteRT(o);
                st.rtabFlag = abF; rtAB = abF; rtSlots[abF] = mkRT(64);
            }
            if (d.b3 && c3 > 0) { fuseRT(abF, addr,   rCh((g3>>8)&0xFF), c3, s3); fuseRT(abF, addr+1, rCh(g3&0xFF), c3, s3); }
            if (d.b4 && c4 > 0) { fuseRT(abF, addr+2, rCh((g4>>8)&0xFF), c4, s4); fuseRT(abF, addr+3, rCh(g4&0xFF), c4, s4); }
        }
        if (gT === 2 && vB === 1) {
            const abF = (g2>>4)&1, addr = (g2&0xF)*2;
            if (abF !== st.rtabFlag) {
                const o = extractRTText(st.rtabFlag >= 0 ? st.rtabFlag : 0);
                if (o.trim().length >= 4) promoteRT(o);
                st.rtabFlag = abF; rtAB = abF; rtSlots[abF] = mkRT(64);
            }
            if (d.b4 && c4 > 0) { fuseRT(abF, addr, rCh((g4>>8)&0xFF), c4, s4); fuseRT(abF, addr+1, rCh(g4&0xFF), c4, s4); }
        }
        if (gT === 1 && vB === 0 && d.b3 && d.errB[2] <= 1 && ((g2>>1)&7) === 0) {
            const eccVal = (g4 !== undefined ? (parseInt(d.b3,16)&0xFF) : NaN);
            const eccStr = !isNaN(eccVal) && eccVal > 0
                ? eccVal.toString(16).toUpperCase().padStart(2,'0') : null;
            if (eccStr && eccStr !== st.ecc) {
                st.ecc = eccStr;
                const el = document.getElementById('rdsm-ecc-flag');
                if (el) { el.textContent = 'ECC ' + eccStr; el.className = 'rf on'; el.title = 'Extended Country Code: 0x' + eccStr; }
            }
        }
        updateBER(d.errB);
        renderAll();
    }

    // ── AI prediction handler ─────────────────────────────────
    function onAI(d) {
        if (d.ts && d.ts < st._freqChangeTs) return;
        st.aiActive = true;
		if (d.nativeWebserverPI !== undefined) st.nativePI = d.nativeWebserverPI;
        if (d.nativeWebserverPS !== undefined) st.nativePS = d.nativeWebserverPS;
        st.aiStats  = d.stats;
        if (d.stats) {
            st.refStation    = d.stats.refStation    || null;
            st.refTxName     = d.stats.refTxName     || null;
            st.refItu        = d.stats.refItu        || null;
            st.refDistKm     = d.stats.refDistKm     ?? null;
            st.refAzimuth    = d.stats.refAzimuth    ?? null;
            st.refErp        = d.stats.refErp        ?? null;
            st.refPol        = d.stats.refPol        || null;
            st.refMatchScore = d.stats.refMatchScore || 0;
        }

        if (d.dbFreqEntries) {
            st.dbFreqEntries = d.dbFreqEntries;
            renderDbEntries();
        }

        let psNameChanged = false;
        if (d.psName !== undefined) {
            const newName     = d.psName    || null;
            const newSrc      = d.psNameSrc || null;
            const newVariants = Array.isArray(d.psVariants) ? d.psVariants : [];
            if (newName !== st.psName ||
                JSON.stringify(newVariants) !== JSON.stringify(st.psVariants)) {
                psNameChanged = true;
            }
            st.psName     = newName;
            st.psNameSrc  = newSrc;
            st.psVariants = newVariants;
        }

        let altFreqsChanged = false;
        if (Array.isArray(d.altFreqs)) {
            const newFp = d.altFreqs.map(x => parseFloat(x.freq).toFixed(1)).join(',');
            const oldFp = st.altFreqs.map(x => parseFloat(x.freq).toFixed(1)).join(',');
            if (newFp !== oldFp) {
                altFreqsChanged = true;
                st.altFreqs = d.altFreqs.slice();
                st.altFreqs.sort((a, b) => parseFloat(a.freq) - parseFloat(b.freq));
            }
        }

        let afChanged = false;
        if (Array.isArray(d.af) && d.af.length > 0) {
            const merged = new Set(st.af.map(f => parseFloat(f).toFixed(1)));
            const before = merged.size;
            for (const f of d.af) merged.add(parseFloat(f).toFixed(1));
            if (merged.size !== before) {
                afChanged = true;
                st.af = Array.from(merged).map(parseFloat).sort((a, b) => a - b);
            }
        }

        if (afChanged) renderAF();
        if (psNameChanged || altFreqsChanged || afChanged) renderPSName();

        // Provisional → locked fields
        if (d.psProvisional !== undefined) st.psProvisional = d.psProvisional || null;
        if (typeof d.psProvisionalConf === 'number') st.psProvisionalConf = d.psProvisionalConf;
        if (typeof d.psStableMs === 'number') st.psStableMs = d.psStableMs;
        if (d.psLockReason !== undefined) st.psLockReason = d.psLockReason || null;
        if (typeof d.psLocked === 'boolean') st.psLocked = d.psLocked;

        let psSlotsChanged = false;
        if (d.ps && Array.isArray(d.ps)) {
            for (let i = 0; i < Math.min(d.ps.length, 8); i++) {
                const p = d.ps[i];
                if (!p || !p.char || p.char === ' ') continue;
                const before = psSlots[i].char + psSlots[i].conf + psSlots[i].src;
                fusePS_ai(i, p.char, p.conf || 0, p.src || 'ai-voted-mid');
                const after = psSlots[i].char + psSlots[i].conf + psSlots[i].src;
                if (before !== after) psSlotsChanged = true;
            }
        }

        let rtChanged = false;
        if (d.rt?.text) {
            const ab = rtAB >= 0 ? rtAB : 0, sc = Math.min(d.rt.score || 0.5, 0.85);
            for (let i = 0; i < Math.min(d.rt.text.length, 64); i++) {
                const c = d.rt.text[i]; if (!c || c === '\r') break;
                if (rtSlots[ab][i].conf < sc) {
                    fuseRT(ab, i, c, sc, 'ai-rt-match');
                    rtChanged = true;
                }
            }
            if (!st.rtLine1 && d.rt.src === 'ai-rt-last') { st.rtLine1 = d.rt.text; rtChanged = true; }
        }

        if (d.pi && d.pi !== st.pi && d.pi !== '----') { st.pi = d.pi; setEl('rdsm-pi', d.pi); }

        if (psSlotsChanged) renderPS();
        if (rtChanged) renderRT();

        refreshStatsPanel();
        renderStatus();
    }

    function extractRTText(ab) {
        let t = '';
        for (let i = 0; i < 64; i++) {
            const sl = rtSlots[ab]?.[i];
            if (!sl || sl.char === '\r') break;
            if (sl.conf > 0) t += sl.char; else if (t.length > 0) break;
        }
        return t.trimEnd();
    }
    function promoteRT(text) { if (text?.trim().length >= 4) st.rtLine1 = text; }

    function renderAll() { renderPS(); renderRT(); refreshStats(); }

    // ── Confidence → colour ───────────────────────────────────
    function confToGray(conf, src) {
        if (src === 'empty') return 'transparent';
        if (src === 'ai-bigram') {
            const v = Math.round(15 + conf * 30);
            return `rgb(${v},${v},${v})`;
        }
        if (src === 'ref-match') {
            const r = Math.round(120 + conf * 135);
            const g = Math.round( 80 + conf * 120);
            const b = Math.round( 10 + conf *  20);
            return `rgb(${r},${g},${b})`;
        }
        if (src === 'ref-seed') {
            const r = Math.round(80 + conf * 80);
            const g = Math.round(55 + conf * 55);
            const b = Math.round(10 + conf * 10);
            return `rgb(${r},${g},${b})`;
        }
        const v = Math.round(20 + conf * 220);
        return `rgb(${v},${v},${v})`;
    }

    // ── Render PS characters ──────────────────────────────────
    function renderPS() {
        const fp = psSlotsFingerprint();
        if (fp === _lastPSFingerprint) return;
        _lastPSFingerprint = fp;

        for (let i = 0; i < 8; i++) {
            const sl   = psSlots[i];
            const chEl = document.getElementById(`rdsm-c${i}`);
            const bEl  = document.getElementById(`rdsm-b${i}`);
            if (!chEl || !bEl) continue;
            const q = Math.round(sl.conf * 100);
            chEl.textContent = (sl.src === 'empty' || sl.char === ' ') ? '' : sl.char;
            chEl.className   = 'c';
            chEl.style.color = confToGray(sl.conf, sl.src);
            chEl.parentElement.title = `[${i}] "${sl.char}" ${q}% ${sl.src} ok=${sl.rawOk}`;
            bEl.style.width      = sl.src === 'empty' ? '0%' : q + '%';
            const isRef          = sl.src === 'ref-match' || sl.src === 'ref-seed';
            bEl.style.background = isRef ? '#c8a020' : 'var(--color-main-bright,#4a90d9)';
            bEl.style.opacity    = sl.src === 'empty' ? '0' : String(0.15 + sl.conf * 0.85);
            bEl.className        = 'cf';
        }
    }

    // ── Render Database Entries for Frequency ─────────────────
    function renderDbEntries() {
        const el = document.getElementById('rdsm-dbentries-content');
        if (!el) return;

        if (!st.dbFreqEntries || st.dbFreqEntries.length === 0) {
            el.innerHTML = '<div style="color:#555;font-size:11px;">No local data for this frequency.</div>';
            return;
        }

        const items = st.dbFreqEntries.map(entry => {
            const pi = entry.pi;
            const ps = entry.ps ? entry.ps.padEnd(8, ' ') : '        ';
            const cnt = entry.seenCount || 0;
            const dyn = entry.isDynamic ? '⚡ dynamic' : '';
            
            const deleteBtn = isAdmin 
                ? `<span class="rdsm-delete-pi" data-pi="${pi}" style="color:#ff4444; cursor:pointer; font-weight:bold; margin-left:8px; font-size:12px;" title="Delete this station from the local AI database">✕</span>` 
                : '';

            return `
                <div style="display:flex; justify-content:space-between; align-items:center; background:#1c1c1c; padding:2px 6px; border-radius:4px; border:1px solid #2a2a2a;">
                    <div style="display:flex; gap:8px; align-items:center;">
                        <span style="font-weight:700; color:#fff; font-size:11px; letter-spacing:1px;">${pi}</span>
                        <span style="color:#aaa; font-size:12px; white-space:pre; font-family:'Titillium Web',Calibri,sans-serif;">${ps} ${dyn}</span>
                    </div>
                    <div style="display:flex; align-items:center;">
                        <span style="color:#666; font-size:10px;">seen: ${cnt}</span>
                        ${deleteBtn}
                    </div>
                </div>
            `;
        });

        el.innerHTML = items.join('');

        // Use event delegation with 'mousedown' to prevent missed events 
        // when the DOM updates rapidly between mousedown and mouseup.
        if (isAdmin && !el._hasDeleteListener) {
            el.addEventListener('mousedown', (e) => {
                const btn = e.target.closest('.rdsm-delete-pi');
                if (!btn) return;
                
                e.preventDefault();
                e.stopPropagation();

                const piToDelete = btn.getAttribute('data-pi');
                if (confirm(`Are you sure you want to delete the database entry for PI ${piToDelete}?`)) {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'rdsm_delete_pi', pi: piToDelete }));
                        // Optimistically remove from UI
                        st.dbFreqEntries = st.dbFreqEntries.filter(en => en.pi !== piToDelete);
                        renderDbEntries();
                    }
                }
            });
            el._hasDeleteListener = true;
        }
    }

    // ── Render FMDX.ORG section ───────────────────────────────
    let _freqScrollTop = 0;

    function renderPSName() {
        const el = document.getElementById('rdsm-psname');
        if (!el) return;

        const existingScroller = document.getElementById('rdsm-freqscroller');
        if (existingScroller) _freqScrollTop = existingScroller.scrollTop;

        const fusedPS   = psSlots.map(s => (s.src !== 'empty' && s.char !== ' ') ? s.char : ' ').join('').trim().toUpperCase();
        const rawPS     = st.psBuf ? st.psBuf.join('').trim().toUpperCase() : '';
        const currentPS = (fusedPS.replace(/ /g,'').length >= rawPS.replace(/ /g,'').length)
            ? fusedPS : rawPS;

        function matchScore(variant) {
            const ref  = variant.trim().toUpperCase().padEnd(8, ' ');
            const cur  = currentPS.padEnd(8, ' ');
            const raw8 = rawPS.padEnd(8, ' ');
            let best = 0;
            for (const cmp of [cur, raw8]) {
                let matches = 0, checked = 0;
                for (let i = 0; i < 8; i++) {
                    if (ref[i] !== ' ') { checked++; if (cmp[i] === ref[i]) matches++; }
                }
                const score = checked > 0 ? Math.round((matches / checked) * 100) : 0;
                if (score > best) best = score;
                const refChars = ref.replace(/ /g, '');
                const cmpChars = cmp.replace(/ /g, '');
                if (refChars.length <= 4 && cmpChars.length > 0) {
                    const posIndep = refChars.split('').filter(c => cmpChars.includes(c)).length;
                    const posScore = Math.round((posIndep / refChars.length) * 100);
                    if (posScore > best) best = posScore;
                }
            }
            return best;
        }

        const headerName = st.psName
            ? `<span style="font-size:14px;font-weight:600;color:#f0f0f0;
                font-family:'Titillium Web',Calibri,sans-serif;
                letter-spacing:normal;white-space:nowrap;">${st.psName}</span>`
            : '';

        function variantChipHTML(variant) {
            const score   = matchScore(variant);
            const isMatch = score === 100;
            const isClose = score >= 50 && !isMatch;
            const bg     = isMatch ? 'var(--color-main-bright,#4a90d9)' : '#1c1c1c';
            const border = isMatch ? 'var(--color-main-bright,#4a90d9)'
                         : isClose ? '#3a3a3a' : '#2a2a2a';
            const color  = isMatch ? '#fff' : isClose ? '#888' : '#444';
            const weight = isMatch ? '700' : '500';
            return `<span style="
                display:inline-block;background:${bg};border:1px solid ${border};
                color:${color};font-weight:${weight};font-size:11px;letter-spacing:.8px;
                font-family:'Titillium Web',Calibri,sans-serif;
                padding:1px 7px;border-radius:4px;white-space:pre;cursor:default;
                transition:color .3s,border-color .3s,background .3s;"
                title="${variant.trim()}">${variant.padEnd(8,' ')}</span>`;
        }

        const hasVariants = st.psVariants && st.psVariants.length > 0;
        let variantChips = '';
        if (hasVariants) {
            variantChips = st.psVariants.map(variantChipHTML).join(' ');
        } else if (st.psName) {
            variantChips = variantChipHTML(st.psName);
        }

        const receivedFreqSet = new Set();
        if (st.af && st.af.length > 0)
            for (const f of st.af) receivedFreqSet.add(parseFloat(f).toFixed(1));
        if (st.freq && st.freq !== '-')
            receivedFreqSet.add(parseFloat(st.freq).toFixed(1));

        let uniqueFreqs = [];
        if (st.altFreqs && st.altFreqs.length > 0) {
            const seen = new Set();
            uniqueFreqs = st.altFreqs.filter(item => {
                const key = parseFloat(item.freq).toFixed(1);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        let afCoverageHTML = '';
        if (uniqueFreqs.length > 0) {
            const dbFreqSet = new Set(uniqueFreqs.map(item => parseFloat(item.freq).toFixed(1)));
            let matched = 0;
            for (const dbFreq of dbFreqSet) {
                if (receivedFreqSet.has(dbFreq)) matched++;
            }
            const total   = dbFreqSet.size;
            const pct     = Math.round((matched / total) * 100);
            afCoverageHTML = `<span style="
                font-size:10px;font-weight:700;letter-spacing:.5px;
                color:#666;font-family:'Titillium Web',Calibri,sans-serif;
                white-space:nowrap;"
                title="AF received: ${matched} of ${total} from FMDX.ORG DB">
                AF ${matched}/${total} (${pct}%)
            </span>`;
        }

        const hasHeader    = !!st.psName;
        const hasChips     = variantChips.length > 0;
        const hasFreqRow   = uniqueFreqs.length > 0;
        const hasCoverage  = afCoverageHTML.length > 0;

        el.innerHTML = `
            <span class="rl" style="flex-shrink:0;padding-top:2px;">FMDX.ORG</span>
            <div style="display:flex;flex-direction:column;gap:4px;width:100%;">
                ${hasHeader ? `<div style="height:18px;display:flex;align-items:center;">${headerName}</div>` : ''}
                ${hasChips  ? `<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">${variantChips}</div>` : ''}
                ${hasCoverage ? `<div style="display:flex;align-items:center;gap:6px;padding-top:2px;">${afCoverageHTML}</div>` : ''}
                ${hasFreqRow ? `<div id="rdsm-freqchips-wrap" style="padding-top:4px;border-top:1px solid rgba(255,255,255,.06);"></div>` : ''}
            </div>`;

        if (hasFreqRow) {
            const wrap = document.getElementById('rdsm-freqchips-wrap');
            if (!wrap) return;

            const freqChipItems = uniqueFreqs.map(item => {
                const freqLabel = parseFloat(item.freq).toFixed(1);
                const isMatch   = receivedFreqSet.has(freqLabel);
                const bg        = isMatch ? 'var(--color-main-bright,#4a90d9)' : '#1c1c1c';
                const border    = isMatch ? 'var(--color-main-bright,#4a90d9)' : '#2a2a2a';
                const color     = isMatch ? '#fff' : '#444';
                const weight    = isMatch ? '700'  : '500';
                const tipV      = (item.psVariants && item.psVariants.length > 0)
                    ? item.psVariants.map(v => v.trim()).filter(v => v).join(' / ') : '';
                const tip = tipV ? `${freqLabel} MHz - ${tipV}` : `${freqLabel} MHz`;
                return `<span style="
                    display:inline-block;background:${bg};border:1px solid ${border};
                    color:${color};font-weight:${weight};font-size:11px;letter-spacing:.5px;
                    font-family:'Titillium Web',Calibri,sans-serif;
                    padding:1px 7px;border-radius:4px;white-space:nowrap;cursor:default;
                    transition:color .3s,border-color .3s,background .3s;"
                    title="${tip}">${freqLabel}</span>`;
            });

            const CHIP_ROW_HEIGHT  = 24;
            const MAX_VISIBLE_ROWS = 5;
            const CHIPS_PER_ROW    = 5;
            const maxH             = MAX_VISIBLE_ROWS * CHIP_ROW_HEIGHT;
            const estimatedRows    = Math.ceil(freqChipItems.length / CHIPS_PER_ROW);
            const needsScroll      = estimatedRows > MAX_VISIBLE_ROWS;

            const scroller = document.createElement('div');
            scroller.id = 'rdsm-freqscroller';
            scroller.style.cssText = [
                'display:flex',
                'flex-wrap:wrap',
                'gap:4px',
                'align-items:flex-start',
                needsScroll ? `max-height:${maxH}px` : '',
                needsScroll ? 'overflow-y:scroll' : 'overflow-y:visible',
                'overflow-x:hidden',
                'scrollbar-width:thin',
                'scrollbar-color:#444 #1a1a1a',
                '-webkit-overflow-scrolling:touch',
                'pointer-events:auto',
            ].filter(Boolean).join(';');

            scroller.innerHTML = freqChipItems.join('');

            if (needsScroll) {
                scroller.addEventListener('wheel', function(e) {
                    e.stopPropagation();
                    const atTop    = this.scrollTop === 0 && e.deltaY < 0;
                    const atBottom = this.scrollTop + this.clientHeight >= this.scrollHeight - 1 && e.deltaY > 0;
                    if (!atTop && !atBottom) e.preventDefault();
                    this.scrollTop += e.deltaY;
                }, { passive: false });
            }

            wrap.appendChild(scroller);

            if (_freqScrollTop > 0) scroller.scrollTop = _freqScrollTop;
        }
    }

    // ── Render RadioText ──────────────────────────────────────
    function renderRT() {
        const ab    = rtAB >= 0 ? rtAB : 0;
        const fp = rtSlotsFingerprint(ab) + '|' + st.rtLine1;
        if (fp === _lastRTFingerprint) return;
        _lastRTFingerprint = fp;

        const rt1El = document.getElementById('rdsm-rt1');
        const rt2El = document.getElementById('rdsm-rt2');
        if (!rt1El || !rt2El) return;
        let end = 64;
        for (let i = 0; i < 64; i++)
            if (rtSlots[ab][i].conf > 0 && rtSlots[ab][i].char === '\r') { end = i; break; }
        while (end > 0 && rtSlots[ab][end-1].conf === 0) end--;
        let html2 = '';
        if (end > 0) {
            for (let i = 0; i < end; i++) {
                const sl = rtSlots[ab][i], c = sl.char || ' ';
                const esc = c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c;
                html2 += `<span style="color:${confToGray(sl.conf,sl.src)}" title="${Math.round(sl.conf*100)}%">${esc}</span>`;
            }
            st.rtLine2 = extractRTText(ab);
        } else {
            html2 = '<span style="color:#333">-</span>';
        }
        rt2El.innerHTML = html2;
        rt1El.innerHTML = st.rtLine1
            ? `<span style="color:#909090">${st.rtLine1.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`
            : '<span style="color:#333">-</span>';
    }

    // ── AF flag rendering ─────────────────────────────────────
    function renderAF() {
        const el = document.getElementById('rdsm-af-flag');
        if (!el) return;
        if (st.af && st.af.length > 0) {
            el.className   = 'rf on';
            el.textContent = 'AF ' + st.af.length;
            el.title       = 'Alternate Frequencies: ' +
                st.af.map(f => parseFloat(f).toFixed(1)).join(', ');
        } else {
            el.className   = 'rf';
            el.textContent = 'AF';
            el.title       = '';
        }
    }

    // ── BER: 0% = perfect, 100% = all blocks lost ─────────────
    function updateBER(errB) {
        if (!errB || !Array.isArray(errB)) return;
        const hasError = errB.some(e => e >= 2);
        if (errB[0] === 3) {
            st.ber.push(1);
            if (st.ber.length > 40) st.ber.shift();
        }
        st.ber.push(hasError ? 1 : 0);
        if (st.ber.length > 40) st.ber.shift();
        const errs   = st.ber.filter(v => v).length;
        const berPct = st.ber.length ? Math.round((errs / st.ber.length) * 100) : 0;
        const bar    = document.getElementById('rdsm-bf');
        const pct    = document.getElementById('rdsm-bp');
        if (bar) {
            bar.style.width      = berPct + '%';
            bar.style.background = berPct < 20 ? '#44cc88' : berPct < 50 ? '#ffaa44' : '#ff5555';
        }
        if (pct) pct.textContent = berPct + '%';
    }

    function refreshStats() { setEl('rdsm-gc', `Groups: ${st.grpTotal}`); }

    // ── Statistics panel ──────────────────────────────────────
    function refreshStatsPanel() {
        if (!statsOpen) return;
        setEl('ai-cur-pi',  st.pi);       
        setEl('ai-native-rds', `${st.nativePI} | "${st.nativePS}"`);
        setEl('ai-active',  st.aiActive ? '✅ active' : '⏳ waiting...');
        if (st.aiStats) {
            setEl('ai-seen',    st.aiStats.seenCount?.toLocaleString() || '-');
            setEl('ai-votes',   st.aiStats.psVoteTotal?.toLocaleString() || '-');
            setEl('ai-freq',    st.aiStats.freq || '-');
            setEl('ai-dynamic', st.aiStats.psIsDynamic ? '⚡ dynamic' : '🔒 static');
        }
        
        const refRow = document.getElementById('ai-ref-row');
        if (st.refStation) {
            setEl('ai-ref-station', st.refStation);
            
            let locText = [];
            if (st.refTxName) locText.push(st.refTxName);
            if (st.refItu) locText.push(`(${st.refItu})`);
            setEl('ai-ref-loc', locText.join(' '));
            
            let distText = [];
            if (st.refErp !== null) {
                let erpStr = `${st.refErp} kW`;
                if (st.refPol) erpStr += ` [${st.refPol}]`;
                distText.push(erpStr);
            } else if (st.refPol) {
                distText.push(`[${st.refPol}]`);
            }
            if (st.refDistKm !== null) distText.push(`${st.refDistKm} km`);
            if (st.refAzimuth !== null) distText.push(`${st.refAzimuth}°`);
            
            setEl('ai-ref-dist', distText.join(' · '));
            setEl('ai-ref-match', st.refMatchScore + '%');
            if (refRow) refRow.style.display = 'flex';
        } else {
            if (refRow) refRow.style.display = 'none';
        }
        
        const rawN  = psSlots.filter(s => s.src.startsWith('raw')).length;
        const dbN   = psSlots.filter(s => s.src === 'ai-cached-db').length;
        const hvote = psSlots.filter(s => s.src === 'ai-voted-high').length;
        const mvote = psSlots.filter(s => s.src === 'ai-voted-mid').length;
        const lvote = psSlots.filter(s => s.src === 'ai-voted-low').length;
        const bigN  = psSlots.filter(s => s.src === 'ai-bigram').length;
        const refM  = psSlots.filter(s => s.src === 'ref-match').length;
        const refS  = psSlots.filter(s => s.src === 'ref-seed').length;
        const vN    = psSlots.filter(s => s.rawOk >= 2).length;
        setEl('ai-ps-breakdown',
            `raw:${rawN}  DB:${dbN}  ↑:${hvote}  ~:${mvote}  ↓:${lvote}  ` +
            `bigram:${bigN}  🌐:${refM}  🔶:${refS}  ✅:${vN}`);
    }

    // ── Render Provisional → Locked status ────────────────────
    function renderStatus() {
        const el = document.getElementById('rdsm-status');
        if (!el) return;

        if (st.psLocked) {
            const reason = st.psLockReason ? ` - ${st.psLockReason}` : '';
            el.innerHTML = `
                <span class="rf on" style="background:#1b3b2a;color:#44ff88;border:1px solid #44ff88;padding:3px 7px;line-height:1.6;">LOCKED</span>
                <span style="color:#777;font-size:11px;">${reason}</span>`;
            return;
        }

        const confPct = Math.round((st.psProvisionalConf || 0) * 100);
        if (st.psProvisional && confPct >= 55) {
            const stableS = (st.psStableMs || 0) / 1000;
            el.innerHTML = `
                <span class="rf on" style="background:#2a2331;color:#c8a020;border:1px solid #c8a020;padding:3px 7px;line-height:1.6;">PROVISIONAL</span>
                <span style="color:#888;font-size:11px;">${confPct}% · stable ${stableS.toFixed(1)}s</span>`;
        } else {
            el.innerHTML = `
                <span class="rf" style="border:1px solid #2a2a2a;">WAIT</span>
                <span style="color:#555;font-size:11px;">collecting…</span>`;
        }
    }

    // ── RDS Follow button sync ───────────────────────────────
    function syncFollowUI() {
        const panelBtn = document.getElementById('rdsm-follow-btn');
        if (panelBtn) {
            panelBtn.classList.toggle('on', st.rdsFollow);
            panelBtn.title = !isAdmin
                ? 'Administrator login required to toggle RDS Follow'
                : st.rdsFollow
                    ? 'RDS Follow active - AI feeds the web server'
                    : 'RDS Follow inactive - native decoder active';
            panelBtn.style.opacity = isAdmin ? '' : '0.5';
            panelBtn.style.cursor  = isAdmin ? 'pointer' : 'not-allowed';
        }
        const navBtn = document.getElementById('rdsm-btn');
        if (navBtn) {
            const icon = navBtn.querySelector('i');
            if (icon) icon.style.color = st.rdsFollow ? '#44ff88' : '';
        }
    }

    function toggleRdsFollow() {
        checkAdminMode();
        if (!isAdmin) {
            sendToast('warning', pluginName, 'Administrator login required to toggle RDS Follow.');
            return;
        }
        const next = !st.rdsFollow;
        if (ws && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type:'rdsm_set_rds_follow', enabled:next }));
        st.rdsFollow = next;
        syncFollowUI();
    }

    // ── Full state reset on frequency change ──────────────────
    function reset() {
        st.pi = '----'; st.piCand = '----'; st.piN = 0;
        st.psBuf.fill(' '); st.psGroups.clear();
        st.pty = -1; st.tp = false; st.ta = false; st.ms = false; st.stereo = false;
        st.rtabFlag = -1; st.ecc = ''; st.grpTotal = 0; st.ber = [];
        st.aiStats = null; st.aiActive = false; st.rtLine1 = ''; st.rtLine2 = '';
        st.refStation = null; st.refDistKm = null; st.refMatchScore = 0;
        st.refTxName = null; st.refItu = null; st.refAzimuth = null; st.refErp = null; st.refPol = null;
        st.af = [];
        st.psName     = null;
        st.psNameSrc  = null;
        st.psVariants = [];
        st.altFreqs   = [];

        st.dbFreqEntries = [];

        st.psProvisional     = null;
        st.psProvisionalConf = 0;
        st.psStableMs        = 0;
        st.psLockReason      = null;
		
        st.nativePI = '-';
        st.nativePS = '-';

        _freqScrollTop = 0;
        _lastPSFingerprint = '';
        _lastRTFingerprint = '';
        _ptyCandidate = -1; _ptyCandCount = 0; _taCandidate = null; _taCandCount = 0;
        psSlots = mkPS(); rtSlots = [mkRT(64), mkRT(64)]; rtAB = -1;
        setEl('rdsm-pi', '----');
        for (let i = 0; i < 8; i++) {
            const ch = document.getElementById(`rdsm-c${i}`);
            const b  = document.getElementById(`rdsm-b${i}`);
            if (ch) { ch.textContent = ''; ch.style.color = 'transparent'; }
            if (b)  { b.style.width = '0%'; b.style.background = 'transparent'; b.style.opacity = '0'; }
        }
        const rt1 = document.getElementById('rdsm-rt1'), rt2 = document.getElementById('rdsm-rt2');
        if (rt1) rt1.innerHTML = '<span style="color:#333">-</span>';
        if (rt2) rt2.innerHTML = '<span style="color:#333">-</span>';
        
        const ptyEl = document.getElementById('rdsm-pty');
        if (ptyEl) { ptyEl.textContent = '-'; ptyEl.title = ''; }
        
        const afEl = document.getElementById('rdsm-af-flag');
        if (afEl) { afEl.textContent = 'AF'; afEl.className = 'rf'; afEl.title = ''; }
        const eccEl = document.getElementById('rdsm-ecc-flag');
        if (eccEl) { eccEl.textContent = 'ECC'; eccEl.className = 'rf'; eccEl.title = ''; }
        const psnEl = document.getElementById('rdsm-psname');
        if (psnEl) {
            psnEl.innerHTML = `
                <span class="rl" style="flex-shrink:0;padding-top:2px;">FMDX.ORG</span>
                <div style="display:flex;flex-direction:column;gap:4px;width:100%;">
                    <div style="min-height:4px;"></div>
                </div>`;
        }
        renderDbEntries();

        GA.forEach(g => { const el = document.getElementById(`rg-${g}`); if (el) el.classList.remove('on'); });
        setFlag('rdsm-tp', false); setFlag('rdsm-ta', false);
        const ms = document.getElementById('rdsm-ms');
        if (ms) { ms.textContent = 'MUSIC'; ms.className = 'rf'; }
        setFlag('rdsm-st', false);
        setEl('rdsm-gc', 'Groups: 0');
        const bar = document.getElementById('rdsm-bf'), pct = document.getElementById('rdsm-bp');
        if (bar) { bar.style.width = '0%'; bar.style.background = '#44cc88'; }
        if (pct) pct.textContent = '0%';

        if (statsOpen) {
            setEl('ai-cur-pi',      '-');
			setEl('ai-native-rds',  '- | "-"');
            setEl('ai-active',      '⏳ waiting...');
            setEl('ai-seen',        '-');
            setEl('ai-votes',       '-');
            setEl('ai-freq',        '-');
            setEl('ai-dynamic',     '-');
            setEl('ai-ps-breakdown','');
            const refRow = document.getElementById('ai-ref-row');
            if (refRow) refRow.style.display = 'none';
        }
        renderStatus();
    }

    // ── CSS injection ─────────────────────────────────────────
    function injectCSS() {
        if (document.getElementById('rdsm-css')) return;
        const s = document.createElement('style');
        s.id = 'rdsm-css';
        s.textContent = `
        #rdsm-panel-container { display:flex; position:fixed; top:70px; right:20px; z-index:9999; pointer-events:none; }
        #rdsm-panel { pointer-events:auto; width:390px;
            background:var(--color-bg-1,#13151f);
            border:1px solid var(--color-main-bright,#4a90d9);
            border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);
            font-family:"Titillium Web",Calibri,sans-serif;
            color:#e0e0e0;display:none;user-select:none;
            flex-direction:column;}
        #rdsm-panel-container.vis #rdsm-panel {display:flex;}
        #rdsm-stats-pan { pointer-events:auto; width:280px; margin-left:10px;
            background:var(--color-bg-1,#13151f);
            border:1px solid var(--color-main-bright,#4a90d9);
            border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);
            font-family:"Titillium Web",Calibri,sans-serif;
            color:#e0e0e0;display:none;user-select:none;
            flex-direction:column; padding:12px; height:fit-content;}
        #rdsm-panel-container.vis.stats-open #rdsm-stats-pan {display:flex;}
        
        #rdsm-hdr{display:flex;align-items:center;justify-content:space-between;
            padding:10px 14px 8px;background:var(--color-main-bright,#4a90d9);cursor:move;
            border-radius:11px 11px 0 0;}
        .rdsm-ht{font-size:14px;font-weight:700;color:#fff;text-transform:uppercase;
            letter-spacing:1px;font-family:"Titillium Web",Calibri,sans-serif;}
        #rdsm-dot{display:inline-block;width:16px;height:6px;border-radius:50%;
            background:#ff4444;transition:background .4s;vertical-align:middle;margin-right:10px;}
        #rdsm-dot.ok{background:#44ff88;}
        #rdsm-close{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;
            opacity:.8;font-family:"Titillium Web",Calibri,sans-serif;}
        #rdsm-close:hover{opacity:1;}
        #rdsm-manual-link{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;
            opacity:.8;font-family:"Titillium Web",Calibri,sans-serif;}
        #rdsm-manual-link:hover{opacity:1;}
        #rdsm-body{padding:11px 14px;}
        .rr{display:flex;align-items:center;margin-bottom:8px;gap:8px;}
        .rl{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;
            color:var(--color-main-bright,#4a90d9);min-width:62px;opacity:.85;
            font-family:"Titillium Web",Calibri,sans-serif;}
        .rv{font-size:14px;font-weight:600;flex:1;color:#f0f0f0;
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            font-family:"Titillium Web",Calibri,sans-serif; display:flex; align-items:center;}
        #rdsm-ps{display:flex;gap:2px;flex:1;}
        .rpc{display:flex;flex-direction:column;align-items:center;width:20px;}
        .rpc .c{font-size:24px;font-weight:700;font-family:"Titillium Web",Calibri,sans-serif;
            line-height:1.2;transition:color .25s;min-height:1.2em;}
        .rpc .cb{height:3px;width:100%;background:#1a1a1a;border-radius:2px;overflow:hidden;margin-top:2px;}
        .rpc .cf{height:100%;border-radius:2px;transition:width .3s,background .3s,opacity .3s;}
        #rdsm-rt-wrap{flex:1;min-width:0;}
        .rt-line-label{font-size:9px;color:#3a4a5a;font-family:"Titillium Web",Calibri,sans-serif;
            display:block;margin-bottom:1px;line-height:1;}
        .rt-line{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;
            text-overflow:ellipsis;line-height:1.55;font-family:"Titillium Web",Calibri,sans-serif;
            display:block;min-height:1.55em;}
        .rt-line + .rt-line-label{margin-top:5px;}
        .rfl{display:flex;gap:5px;flex-wrap:wrap;}
        .rf{font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;
            background:#1c1c1c;color:#444;letter-spacing:.5px;
            font-family:"Titillium Web",Calibri,sans-serif;transition:background .25s,color .25s;}
        .rf.on{background:var(--color-main-bright,#4a90d9);color:#fff;}
        .pty-badge{font-size:10px;background:var(--color-main-bright,#4a90d9);
            color:#fff;padding:1px 6px;border-radius:4px;margin-left:4px;
            font-family:"Titillium Web",Calibri,sans-serif;}
        #rdsm-gg{display:flex;flex-wrap:wrap;gap:3px;flex:1;}
        .rgc{font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;
            background:#1c1c1c;color:#444;font-family:"Titillium Web",Calibri,sans-serif;
            min-width:24px;text-align:center;transition:background .3s,color .3s;}
        .rgc.on{background:var(--color-main-bright,#4a90d9);color:#fff;}
        #rdsm-psname{
            display:flex !important;visibility:visible !important;
            align-items:flex-start;
            min-height:28px;
            padding:4px 0;gap:8px;
            box-sizing:border-box;flex-shrink:0;
            margin-bottom:8px;}
        #rdsm-dbentries{
            display:flex;align-items:flex-start;
            min-height:28px;
            padding:4px 0;gap:8px;
            box-sizing:border-box;flex-shrink:0;
            margin-bottom:8px;}
        #rdsm-stats{
            display:grid;grid-template-columns:96px auto auto;
            justify-content:space-between;align-items:center;
            padding:5px 14px 7px;border-top:1px solid rgba(255,255,255,.06);
            font-family:"Titillium Web",Calibri,sans-serif;
            font-size:10px;color:#666;box-sizing:border-box;width:100%;}
        #rdsm-gc{font-variant-numeric:tabular-nums;white-space:nowrap;}
        #rdsm-follow-wrap{display:flex;justify-content:center;align-items:center;}
        #rdsm-follow-btn{
            display:inline-flex;align-items:center;gap:4px;
            font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
            font-family:"Titillium Web",Calibri,sans-serif;
            color:#555;background:#181a24;border:1px solid #2a2d3a;border-radius:5px;
            padding:2px 8px 2px 6px;white-space:nowrap;cursor:pointer;
            transition:color .2s,border-color .2s,background .2s,opacity .2s;user-select:none;}
        #rdsm-follow-btn:hover{color:#8ab4d8;border-color:#4a90d9;}
        #rdsm-follow-btn.on{color:#44ff88;border-color:#44ff88;background:#0d1a12;}
        #rdsm-follow-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;}
        #rdsm-ber-wrap{display:flex;align-items:center;justify-content:flex-end;
            white-space:nowrap;font-variant-numeric:tabular-nums;}
        #rdsm-bw{width:50px;height:4px;background:#2a2a2a;border-radius:2px;
            overflow:hidden;display:inline-block;vertical-align:middle;flex-shrink:0;margin:0 4px;}
        #rdsm-bf{height:100%;border-radius:2px;background:#44cc88;transition:width .5s,background .5s;}
        #rdsm-bp{display:inline-block;min-width:3.2ch;text-align:right;}
        #rdsm-btn:hover{color:var(--color-5);filter:brightness(120%);}
        #rdsm-btn.active{background-color:var(--color-2)!important;filter:brightness(120%);}
        
        #rdsm-stats-btn{font-size:10px;font-weight:700;color:var(--color-main-bright,#4a90d9);
            text-transform:uppercase;letter-spacing:1px; cursor:pointer;
            font-family:"Titillium Web",Calibri,sans-serif; display:flex; align-items:center; gap:4px;
            margin-left:auto;}
        #rdsm-stats-btn:hover{color:#fff;}
        #rdsm-stats-arrow{font-size:8px;transition:transform .2s; display:inline-block; transform:rotate(-90deg);}
        .stats-open #rdsm-stats-arrow{transform:rotate(0deg);}

        #rdsm-panel #rdsm-psname { pointer-events:all; }
        #rdsm-panel #rdsm-psname * { pointer-events:all; }
        #rdsm-panel #rdsm-dbentries { pointer-events:all; }
        #rdsm-panel #rdsm-dbentries * { pointer-events:all; }
        #rdsm-freqscroller { touch-action:pan-y; }
        
        .ai-stats-title{font-size:12px;font-weight:700;color:var(--color-main-bright,#4a90d9);
            text-transform:uppercase;letter-spacing:1px; margin-bottom:10px;
            font-family:"Titillium Web",Calibri,sans-serif; border-bottom:1px solid rgba(255,255,255,.1); padding-bottom:4px;}
        .ai-stats-r{display:flex;justify-content:space-between;font-size:11px;color:#888;
            margin-bottom:5px;font-family:"Titillium Web",Calibri,sans-serif;}
        .ai-stats-r span{color:#ccc;font-weight:600;font-family:"Titillium Web",Calibri,sans-serif;}
        .ai-stats-ref{display:flex;justify-content:space-between;font-size:11px;
            color:#888;margin-bottom:5px;font-family:"Titillium Web",Calibri,sans-serif;
            background:rgba(200,160,32,.08);border-radius:4px;padding:3px 6px;}
        .ai-stats-ref span{color:#c8a020;font-weight:600;}
        .ai-stats-leg{font-size:9px;color:#555;margin-top:auto;line-height:2;
            font-family:"Titillium Web",Calibri,sans-serif;}
        .rdiv{border:none;border-top:1px solid rgba(255,255,255,.07);margin:7px 0;}
        #rdsm-panel-container.drag{opacity:.85;cursor:move;}
        #rdsm-status{overflow:visible;line-height:1.8;}
        `;
        document.head.appendChild(s);
    }

    // ── RDS group type labels ─────────────────────────────────
    const GA = [];
    for (let i = 0; i <= 15; i++) GA.push(`${i}A`, `${i}B`);

    // ── Panel HTML ────────────────────────────────────────────
    function createPanel() {
        if (document.getElementById('rdsm-panel-container')) return;
        const c = document.createElement('div');
        c.id = 'rdsm-panel-container';
        c.innerHTML = `
        <div id="rdsm-panel">
          <div id="rdsm-hdr">
            <span class="rdsm-ht">${pluginName}</span>
            <span style="display:flex;align-items:center;gap:5px">
              <span id="rdsm-dot" title="Connection status"></span>
              <a id="rdsm-manual-link"
                 href="${pluginManualUrl}"
                 target="_blank"
                 title="Open RDS AI Decoder Manual">?</a>
              <button id="rdsm-close">✕</button>
            </span>
          </div>
          <div id="rdsm-body">
            <div class="rr">
              <span class="rl">Freq</span>
              <span class="rv">
                <span id="rdsm-freq">-</span>
                <span id="rdsm-stats-btn"><span id="rdsm-stats-arrow">▶</span> STATISTICS</span>
              </span>
            </div>
            <div class="rr">
              <span class="rl">PI Code</span>
              <span class="rv" id="rdsm-pi">----</span>
            </div>
            <div class="rr">
              <span class="rl">Status</span>
              <span class="rv" id="rdsm-status">
                <span class="rf" style="border:1px solid #2a2a2a;">WAIT</span>
                <span style="color:#555;font-size:11px;">collecting…</span>
              </span>
            </div>
            <hr class="rdiv">
            <div class="rr" style="align-items:flex-start">
              <span class="rl" style="margin-top:3px">PS</span>
              <div id="rdsm-ps">
                ${[0,1,2,3,4,5,6,7].map(i => `
                  <div class="rpc">
                    <span class="c" id="rdsm-c${i}" style="color:transparent"></span>
                    <div class="cb"><div class="cf" id="rdsm-b${i}"
                      style="width:0%;opacity:0;background:var(--color-main-bright,#4a90d9)">
                    </div></div>
                  </div>`).join('')}
              </div>
            </div>
            <hr class="rdiv">
            <div class="rr">
              <span class="rl">PTY</span>
              <span class="rv" id="rdsm-pty">-</span>
            </div>
            <hr class="rdiv">
            <div class="rr" style="align-items:flex-start">
              <span class="rl" style="margin-top:1px">RT</span>
              <div id="rdsm-rt-wrap">
                <span class="rt-line-label">previous RT</span>
                <span class="rt-line" id="rdsm-rt1"><span style="color:#333">-</span></span>
                <span class="rt-line-label">current</span>
                <span class="rt-line" id="rdsm-rt2"><span style="color:#333">-</span></span>
              </div>
            </div>
            <hr class="rdiv">
            <div class="rr">
              <span class="rl">Flags</span>
              <div class="rfl">
                <span class="rf" id="rdsm-tp">TP</span>
                <span class="rf" id="rdsm-ta">TA</span>
                <span class="rf" id="rdsm-ms">MUSIC</span>
                <span class="rf" id="rdsm-st">STEREO</span>
                <span class="rf" id="rdsm-af-flag" title="">AF</span>
                <span class="rf" id="rdsm-ecc-flag" title="">ECC</span>
              </div>
            </div>
            <hr class="rdiv">
            <div class="rr" style="align-items:flex-start">
              <span class="rl" style="margin-top:2px">Groups</span>
              <div id="rdsm-gg">
                ${GA.map(g => `<span class="rgc" id="rg-${g}">${g}</span>`).join('')}
              </div>
            </div>
            <hr class="rdiv">
            <div id="rdsm-psname">
              <span class="rl" style="flex-shrink:0;padding-top:2px;">FMDX.ORG</span>
              <div style="display:flex;flex-direction:column;gap:4px;width:100%;">
                <div style="min-height:4px;"></div>
              </div>
            </div>
            <hr class="rdiv">
            <div id="rdsm-dbentries">
              <span class="rl" style="flex-shrink:0;padding-top:2px;">LOCAL DB</span>
              <div id="rdsm-dbentries-content" style="display:flex;flex-direction:column;gap:4px;width:100%;">
                <div style="color:#555;font-size:11px;">No local data for this frequency.</div>
              </div>
            </div>
          </div>
          <div id="rdsm-stats">
            <span id="rdsm-gc">Groups: 0</span>
            <span id="rdsm-follow-wrap">
              <button id="rdsm-follow-btn" title="RDS Follow inactive">
                <span id="rdsm-follow-dot"></span>RDS Follow
              </button>
            </span>
            <span id="rdsm-ber-wrap">BER
              <span id="rdsm-bw"><div id="rdsm-bf" style="width:0%"></div></span>
              <span id="rdsm-bp">0%</span>
            </span>
          </div>
        </div>
 <div id="rdsm-stats-pan">
            <div class="ai-stats-title">STATISTICS</div>
            <div class="ai-stats-r">AI connection: <span id="ai-active">⏳</span></div>
            <div class="ai-stats-r">Current PI: <span id="ai-cur-pi">-</span></div>           
            <div class="ai-stats-r" style="color:#555; font-size:10px;">Native data: <span id="ai-native-rds" style="color:#777;">-</span></div>
            <div class="ai-stats-r">PS type: <span id="ai-dynamic">-</span></div>
            <div class="ai-stats-r">Groups received: <span id="ai-seen">-</span></div>
            <div class="ai-stats-r">PS votes total: <span id="ai-votes">-</span></div>
            <div class="ai-stats-r">Last seen on: <span id="ai-freq">-</span></div>
            <div class="ai-stats-ref" id="ai-ref-row" style="display:none; flex-direction:column; gap:3px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div style="display:flex; align-items:center; overflow:hidden;">
                      <span style="color:#888; flex-shrink:0; margin-right:6px;">🌐 fmdx.org</span>
                      <span id="ai-ref-station" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#c8a020; font-weight:600;"></span>
                  </div>
                  <span style="flex-shrink:0; margin-left:6px; color:#888;">match: <span id="ai-ref-match" style="color:#c8a020; font-weight:600;">-</span></span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; font-size:10px;">
                  <span id="ai-ref-loc" style="color:#aaa; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:6px;"></span>
                  <span id="ai-ref-dist" style="color:#888; flex-shrink:0; white-space:nowrap;"></span>
              </div>
            </div>
            <div class="ai-stats-r" style="flex-direction:column;gap:3px; margin-top:8px;">
              PS slots:<br>
              <span id="ai-ps-breakdown"
                style="color:#888;font-size:10px;
                font-family:'Titillium Web',Calibri,sans-serif;"></span>
            </div>
            <div class="ai-stats-leg">
              bright = high confidence · dark = low<br>
              🌐 = fmdx.org confirmed (gold) · 🔶 = fmdx.org seed (amber)<br>
              ✅ = raw-verified (2× err≤1, same char)
            </div>
        </div>
        `;
        document.body.appendChild(c);
        
        document.getElementById('rdsm-close').addEventListener('click', hidePanel);
        document.getElementById('rdsm-follow-btn').addEventListener('click', toggleRdsFollow);
        document.getElementById('rdsm-stats-btn').addEventListener('click', () => {
            statsOpen = !statsOpen;
            c.classList.toggle('stats-open', statsOpen);
            if (statsOpen) refreshStatsPanel();
        });
        
        makeDrag(c, document.getElementById('rdsm-hdr'));
    }

    // ── Drag support ──────────────────────────────────────────
    function makeDrag(el, h) {
        let sx, sy, sl, st2, dr = false;

        // Restore saved position
        try {
            const savedPos = localStorage.getItem('rdsm_panel_pos');
            if (savedPos) {
                const pos = JSON.parse(savedPos);
                if (pos.left && pos.top) {
                    el.style.left = pos.left;
                    el.style.top = pos.top;
                    el.style.right = 'auto';
                }
            }
        } catch(e) {}

        h.addEventListener('mousedown', e => {
            if (e.target.id === 'rdsm-close' || e.target.id === 'rdsm-manual-link') return;
            dr = true; el.classList.add('drag');
            sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect(); sl = r.left; st2 = r.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!dr) return;
            el.style.left  = Math.max(0, sl + e.clientX - sx) + 'px';
            el.style.top   = Math.max(0, st2 + e.clientY - sy) + 'px';
            el.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => { 
            if (!dr) return;
            dr = false; 
            el.classList.remove('drag'); 
            
            // Save position
            try {
                localStorage.setItem('rdsm_panel_pos', JSON.stringify({
                    left: el.style.left,
                    top: el.style.top
                }));
            } catch(e) {}
        });
    }

    // ── Toolbar button ────────────────────────────────────────
    function addBtn() {
        let found = false;
        const obs = new MutationObserver((_, o) => {
            if (typeof addIconToPluginPanel !== 'function') return;
            found = true; o.disconnect();
            addIconToPluginPanel('rdsm-btn', 'RDS Decoder', 'solid', 'radio',
                `${pluginName} v${pluginVersion}`);
            const btnObs = new MutationObserver((_, o2) => {
                const btn = document.getElementById('rdsm-btn');
                if (!btn) return;
                o2.disconnect();
                btn.classList.add('hide-phone', 'bg-color-2');
                btn.addEventListener('click', () => {
                    const c = document.getElementById('rdsm-panel-container');
                    if (!panelVis) {
                        panelVis = true; btn.classList.add('active');
                        $(c).stop(true, true).fadeIn(400, () => {
                            c.classList.add('vis');
                        });
                    } else { hidePanel(); }
                });
                syncFollowUI();
            });
            btnObs.observe(document.body, {childList:true, subtree:true});
        });
        obs.observe(document.body, {childList:true, subtree:true});
        setTimeout(() => { if (!found) obs.disconnect(); }, 10000);
    }

    function hidePanel() {
        panelVis = false;
        const btn = document.getElementById('rdsm-btn');
        if (btn) btn.classList.remove('active');
        const c = document.getElementById('rdsm-panel-container');
        if (c) {
            $(c).stop(true, true).fadeOut(400, () => {
                c.classList.remove('vis'); 
                c.style.display = '';
            });
        }
        syncFollowUI();
    }

    // ── WebSocket connection ──────────────────────────────────
    let _wsFailToast = false;
    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        if (reconn) { clearTimeout(reconn); reconn = null; }
        _wsFailToast = false;
        ws = new WebSocket(WS);
        ws.onopen = () => {
            setDot(true);
            _wsFailToast = false;
            console.log(`[${pluginName}] v${pluginVersion} → ${WS}`);
            ws.send(JSON.stringify({type:'rdsm_get_rds_follow'}));
        };
        ws.onclose = () => {
            setDot(false);
            if (!_wsFailToast) {
                _wsFailToast = true;
                sendToast('error', pluginName, 'Connection to RDS AI Decoder failed.');
            }
            reconn = setTimeout(connect, 5000);
        };
        ws.onerror  = () => setDot(false);
        ws.onmessage = e => onMessage(e.data);
    }

    // ── DOM helpers ───────────────────────────────────────────
    const setEl   = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    const setDot  = ok => {
        const e = document.getElementById('rdsm-dot');
        if (e) { e.style.background = ok ? '#44ff88' : '#ff4444'; e.className = ok ? 'ok' : ''; }
    };
    const setFlag = (id, on) => { const e = document.getElementById(id); if (e) e.className = 'rf' + (on ? ' on' : ''); };

    // ── Admin detection ───────────────────────────────────────
    let isAdmin = false;
    function checkAdminMode() {
        const bodyText = document.body.textContent || document.body.innerText;
        isAdmin = bodyText.includes('You are logged in as an administrator.') ||
                  bodyText.includes('You are logged in as an adminstrator.');
    }
    checkAdminMode();

    // ── Entry point ───────────────────────────────────────────
    function init() {
        if (window.location.pathname === '/setup') return;
        injectCSS();
        createPanel();
        addBtn();
        connect();
        fetch('/api').then(r => r.json())
            .then(d => { if (d.freq) { st.freq = d.freq; setEl('rdsm-freq', d.freq + ' MHz'); } })
            .catch(() => {});
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 900));
    else
        setTimeout(init, 900);

})();