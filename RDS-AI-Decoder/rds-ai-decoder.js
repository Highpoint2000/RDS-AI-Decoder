///////////////////////////////////////////////////////////////
//                                                           //
//  RDS AI DECODER CLIENT PLUGIN FOR FM-DX-WEBSERVER (V3.0)  //
//                                                           //
//  by Highpoint                last update: 2026-06-24      //
//                                                           //
//  https://github.com/Highpoint2000/RDS-AI-Decoder          //
//                                                           //
///////////////////////////////////////////////////////////////

(() => {

    const pluginVersion         = '3.0';
    const pluginName            = 'RDS AI Decoder';
    const pluginManualUrl       = 'https://highpoint.fmdx.org/manuals/RDS-AI-Decoder-Documentation.html';

    if (typeof sendToast !== 'function') {
        window.sendToast = function(cls, src, txt) { console.log(`[TOAST-Fallback] ${src}: ${cls} → ${txt}`); };
    }

    const CU = new URL(window.location.href);
    const WP = CU.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS = `${WP}//${CU.hostname}:${CU.port||(CU.protocol==='https:'?'443':'80')}/data_plugins`;

    const PTY = ['None','News','Current Affairs','Information','Sport','Education','Drama',
                 'Culture','Science','Varied','Pop Music','Rock Music','Easy Listening',
                 'Light Classical','Serious Classical','Other Music','Weather','Finance',
                 "Children's Programmes",'Social Affairs','Religion','Phone-In','Travel',
                 'Leisure','Jazz Music','Country Music','National Music','Oldies Music',
                 'Folk Music','Documentary','Alarm Test','Alarm'];

    const mkRT = n => Array.from({length:n}, ()=>({char:' ',conf:0,src:'empty'}));
    const RDS_CHARSET = [' ','!','"','#','¤','%','&',"'",'(',')','*','+',',','-','.','/','0','1','2','3','4','5','6','7','8','9',':',';','<','=','>','?','@','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','[','\\',']','―','_','‖','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z','{','|','}','¯',' ','á','à','é','è','í','ì','ó','ò','ú','ù','Ñ','Ç','Ş','β','¡','Ĳ','â','ä','ê','ë','î','ï','ô','ö','û','ü','ñ','ç','ş','ǧ','ı','ĳ','ª','α','©','‰','Ǧ','ě','ň','ő','π','€','£','$','←','↑','→','↓','º','¹','²','³','±','İ','ń','ű','µ','¿','÷','°','¼','½','¾','§','Á','À','É','È','Í','Ì','Ó','Ò','Ú','Ù','Ř','Č','Š','Ž','Ð','Ŀ','Â','Ä','Ê','Ë','Î','Ï','Ô','Ö','Û','Ü','ř','č','š','ž','đ','ŀ','Ã','Å','Æ','Œ','ŷ','Ý','Õ','Ø','Þ','Ŋ','Ŕ','Ć','Ś','Ź','Ŧ','ð','ã','å','æ','œ','ŵ','ý','õ','ø','þ','ŋ','ŕ','ć','ś','ź','ŧ',' '];
    
    function rdsChar(b) { return b === 0x0D ? '\r' : (b < 0x20 ? ' ' : (RDS_CHARSET[b - 0x20] || ' ')); }
    function decodeAFCode(code) { return (code >= 1 && code <= 204) ? (code + 875) / 10 : null; }

    let st = {
        pi:'?', piCand:'?', piN:0,
        psBuf:new Array(8).fill(' '), psErrBuf:new Array(8).fill(3),
        aiPs:new Array(8).fill(' '),
        pty:-1, tp:false, ta:false, ms:false, stereo:false,
        rtabFlag:-1, ecc:'', grpTotal:0, ber:[], freq:'-',
        rtLine1:'', rtLine2:'',
        rdsFollow:false, rdsFollowLocked:true,
        psName: null, refItu: null, aiReason: null, aiColor: '#6c757d', aiConf: 0,
        rawGroups: [], mufMode: 'OFF', af: [], altFreqs: [],
        psLocked: false, psLockReason: '',
        refTxName: null, refDistKm: null, refAzimuth: null, refErp: null, refPol: null
    };

    let rtSlots = [mkRT(64), mkRT(64)];
    let rtAB = -1;
    let logPaused = false;

    // --- State for Log Filters ---
    let logFilters = { err: true, ps: true, rt: true, af: true, ecc: true, tp: true, ta: true, ms: true, other: true };
    try {
        const savedFilters = localStorage.getItem('rdsm_log_filters');
        if (savedFilters) logFilters = Object.assign(logFilters, JSON.parse(savedFilters));
    } catch(e) {}

    function saveFilters() {
        try { localStorage.setItem('rdsm_log_filters', JSON.stringify(logFilters)); } catch(e) {}
        renderRealtimeLog();
    }
    // -----------------------------

    function fuseRT(ab, i, char, conf) {
        if (i < 0 || i >= rtSlots[ab].length) return;
        const cur = rtSlots[ab][i];
        if (conf > cur.conf || cur.src === 'empty') rtSlots[ab][i] = {char, conf, src:'raw'};
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

    function renderRT() {
        const ab = rtAB >= 0 ? rtAB : 0;
        const rt1El = document.getElementById('rdsm-rt1');
        const rt2El = document.getElementById('rdsm-rt2');
        if (!rt1El || !rt2El) return;
        let end = 64;
        for (let i = 0; i < 64; i++) { if (rtSlots[ab][i].conf > 0 && rtSlots[ab][i].char === '\r') { end = i; break; } }
        while (end > 0 && rtSlots[ab][end-1].conf === 0) end--;
        let html2 = '';
        if (end > 0) {
            for (let i = 0; i < end; i++) {
                const sl = rtSlots[ab][i];
                const c = sl.char || ' ';
                const esc = c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c;
                const color = sl.conf > 0 ? '#e0e0e0' : '#333';
                html2 += `<span style="color:${color}">${esc}</span>`;
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
    
    let isRecording = false, isAdmin = false;

    function checkAdminMode() {
        const bodyText = document.body.textContent || document.body.innerText;
        isAdmin = bodyText.includes('You are logged in as an administrator.') || bodyText.includes('You are logged in as an adminstrator.');
    }
    checkAdminMode();

    function updateRecordUI(recording, downloadUrl, silentStop) {
        const btn = document.getElementById('rdsm-record-btn');
        if (!btn) return;
        const wasRecording = isRecording;
        isRecording = recording;
        
        if (recording) {
            btn.innerHTML = '⏹'; btn.classList.add('recording-pulse'); btn.title = 'Stop recording & save CSV';
            if (!wasRecording) sendToast('success', pluginName, 'Server-side RDS recording started...');
        } else {
            btn.innerHTML = '⏺'; btn.classList.remove('recording-pulse'); btn.title = 'Record raw RDS data';
            if (wasRecording) {
                if (silentStop) {
                    if (isAdmin) sendToast('info', pluginName, 'Auto-recording stopped by MUF condition. CSV saved to server.');
                } else if (downloadUrl) {
                    if (isAdmin) {
                        sendToast('success', pluginName, 'Recording saved to server.');
                        window.open(downloadUrl, '_blank');
                    } else sendToast('info', pluginName, 'Administrator stopped RDS recording.');
                }
            }
        }
    }

    function updateMufUI(mode) {
        st.mufMode = mode || 'OFF';
        const btn = document.getElementById('rdsm-muf-btn');
        if (!btn) return;
        btn.innerHTML = `MUF ${st.mufMode}`;
        if (st.mufMode === 'OFF') btn.classList.remove('on'); else btn.classList.add('on');
    }

    let ws = null, reconn = null, panelVis = false, logOpen = false;

    function onMessage(data) {
        let d; try { d = JSON.parse(data); } catch(e) { return; }
        switch (d.type) {
            case 'rdsm_raw': onRaw(d); break;
            case 'rdsm_ai': onAI(d); break;
            case 'rdsm_freq': onFreq(d); break;
            case 'rdsm_rds_follow_state': onRdsFollowState(d); break;
        }
    }

    function onRdsFollowState(d) { 
        st.rdsFollow = !!d.enabled; 
        if (d.locked !== undefined) st.rdsFollowLocked = !!d.locked;
        if (d.isRecording !== undefined) updateRecordUI(d.isRecording, d.downloadUrl, d.silentStop);
        if (d.mufMode !== undefined) updateMufUI(d.mufMode);
        syncFollowUI(); 
    }

    function onFreq(d) {
        reset();
        st.freq = d.freq || '-';
        setEl('rdsm-freq', st.freq !== '-' ? st.freq + ' MHz' : '-');
    }

function onRaw(d) {
        if (d.freq && d.freq !== st.freq) { st.freq = d.freq; setEl('rdsm-freq', d.freq + ' MHz'); }

        if (d.pi && d.pi !== '----' && d.pi !== '?') {
            const pi = d.pi.toUpperCase();
            if (pi === st.piCand) { st.piN++; if (st.piN >= 2 && pi !== st.pi) { st.pi = pi; setEl('rdsm-pi', pi); } } 
            else { st.piCand = pi; st.piN = 1; }
        }

        if (!d.b2) { updateBER(d.errB); return; }

        st.grpTotal++;
        const g2 = parseInt(d.b2, 16);
        const gT = (g2 >> 12) & 0xF;
        const vB = (g2 >> 11) & 0x1;
        
        const gc = document.getElementById(`rg-${gT}${vB?'B':'A'}`);
        if (gc) gc.classList.add('on');

        const blkAok = d.errB[0] <= 1;
        const blkBok = d.errB[1] <= 1;

        let actions = { flags: {} };
        let groupType = '-';

        if (blkAok && blkBok) {
            st.tp = !!((g2 >> 10) & 0x1);
            setFlag('rdsm-tp', st.tp);
            st.pty = (g2 >> 5) & 0x1F;
            const ptyEl = document.getElementById('rdsm-pty');
            if (ptyEl) ptyEl.innerHTML = `${PTY[st.pty]||'?'} <span class="pty-badge">${st.pty}</span>`;
            
            // Store flags modularly
            actions.flags.tp = st.tp ? 1 : 0;
            if (gT === 0 || (gT === 15 && vB === 1)) {
                st.ta = !!((g2 >> 4) & 0x1);
                setFlag('rdsm-ta', st.ta);
                actions.flags.ta = st.ta ? 1 : 0;
            }
            if (gT === 0) {
                st.ms = !!((g2 >> 3) & 0x1);
                const msEl = document.getElementById('rdsm-ms');
                if (msEl) { msEl.textContent = st.ms ? 'MUSIC' : 'SPEECH'; msEl.className = 'rf on'; }
                actions.flags.ms = st.ms ? 1 : 0;
                
                if ((g2 & 0x3) === 3) {
                    st.stereo = !!((g2 >> 2) & 0x1);
                    setFlag('rdsm-st', st.stereo);
                }
            }
        }

        if (d.b2 !== '----' && blkBok) {
            groupType = `${gT}${vB ? 'B' : 'A'}`;
            let isOther = true;
            
            if (gT === 0) {
                if (vB === 0 && d.b3 && d.b3 !== '----' && d.errB[2] <= 1) {
                    const b3n = parseInt(d.b3, 16);
                    const a1 = decodeAFCode((b3n >> 8) & 0xFF);
                    const a2 = decodeAFCode(b3n & 0xFF);
                    let afArr = [];
                    if (a1) afArr.push(a1.toFixed(1));
                    if (a2) afArr.push(a2.toFixed(1));
                    if (afArr.length > 0) {
                        actions.af = `<span style="color:var(--color-main-bright, #4a90d9);">AFs: [${afArr.join(', ')}]</span>`;
                        isOther = false;
                    }
                }

                if (d.b4 && d.b4 !== '----' && d.errB[3] <= 1) {
                    const seg = g2 & 0x3;
                    const addr = seg * 2;
                    const b4num = parseInt(d.b4, 16);
                    const c0 = rdsChar((b4num >> 8) & 0xFF);
                    const c1 = rdsChar(b4num & 0xFF);
                    
                    if (c0 !== '\r') { st.psBuf[addr] = c0; st.psErrBuf[addr] = d.errB[3]; }
                    if (c1 !== '\r') { st.psBuf[addr+1] = c1; st.psErrBuf[addr+1] = d.errB[3]; }

                    const displayBuffer = st.psBuf.map((c, i) => {
                        const charStr = c === ' ' ? '_' : c;
                        return (i === addr || i === addr+1) ? `<b>${charStr}</b>` : charStr;
                    }).join('');

                    actions.ps = `PS Seg ${seg}: <b>'${c0===' '?'_':c0}${c1===' '?'_':c1}'</b> &rarr; [ <code style="letter-spacing:2px;">${displayBuffer}</code> ]`;
                    isOther = false;
                }
            } else if (gT === 2) {
                let rtChars = '';
                const abF = (g2 >> 4) & 0x1;
                const addr = vB === 0 ? (g2 & 0xF) * 4 : (g2 & 0xF) * 2;
                
                if (abF !== st.rtabFlag) {
                    const o = extractRTText(st.rtabFlag >= 0 ? st.rtabFlag : 0);
                    if (o.trim().length >= 4) promoteRT(o);
                    st.rtabFlag = abF; rtAB = abF; rtSlots[abF] = mkRT(64);
                }
                
                let rtParsed = false;
                if (vB === 0) { 
                    if (d.b3 && d.b3 !== '----' && d.errB[2] <= 1) { 
                        const b3n = parseInt(d.b3, 16); 
                        rtChars += rdsChar((b3n >> 8) & 0xFF) + rdsChar(b3n & 0xFF); 
                        fuseRT(abF, addr, rdsChar((b3n >> 8) & 0xFF), 1);
                        fuseRT(abF, addr + 1, rdsChar(b3n & 0xFF), 1);
                        rtParsed = true;
                    } else { rtChars += '..'; }
                    if (d.b4 && d.b4 !== '----' && d.errB[3] <= 1) { 
                        const b4n = parseInt(d.b4, 16); 
                        rtChars += rdsChar((b4n >> 8) & 0xFF) + rdsChar(b4n & 0xFF); 
                        fuseRT(abF, addr + 2, rdsChar((b4n >> 8) & 0xFF), 1);
                        fuseRT(abF, addr + 3, rdsChar(b4n & 0xFF), 1);
                        rtParsed = true;
                    } else { rtChars += '..'; }
                } else { 
                    if (d.b4 && d.b4 !== '----' && d.errB[3] <= 1) { 
                        const b4n = parseInt(d.b4, 16); 
                        rtChars += rdsChar((b4n >> 8) & 0xFF) + rdsChar(b4n & 0xFF); 
                        fuseRT(abF, addr, rdsChar((b4n >> 8) & 0xFF), 1);
                        fuseRT(abF, addr + 1, rdsChar(b4n & 0xFF), 1);
                        rtParsed = true;
                    } else { rtChars += '..'; }
                }
                
                if (rtParsed) {
                    renderRT();
                    actions.rt = `Radiotext Seg: <b>'${rtChars.replace(/</g,'&lt;')}'</b>`;
                    isOther = false;
                }
            } else if (gT === 1 && vB === 0 && d.b3 && d.b3 !== '----' && d.errB[2] <= 1) {
                const eccByte = parseInt(d.b3, 16) & 0xFF;
                if (eccByte > 0) {
                    st.ecc = eccByte.toString(16).toUpperCase().padStart(2, '0');
                    const eccEl = document.getElementById('rdsm-ecc-flag');
                    if (eccEl) { eccEl.textContent = 'ECC ' + st.ecc; eccEl.className = 'rf on'; }
                }
                actions.ecc = `<span style="color:#28a745; font-weight:bold;">Extended Country Code: ${st.ecc}</span>`;
                isOther = false;
            } else if (gT === 14) {
                actions.tp = `<span style="color:#888;">Other Network Data (EON)</span>`;
                isOther = false;
            } else if (gT === 15 && vB === 1) {
                actions.tp = `<span style="color:#888;">Fast Basic Tuning (TP/TA)</span>`;
                isOther = false;
            }
            
            if (isOther) {
                if (gT !== 0) actions.other = `<span style="color:#888;">Other Group</span>`;
            }
            
        } else if (d.errB[1] > 1) {
            actions.err = `<span style="color:#888;">Block 2 Error - Group Unknown</span>`;
        }

        st.rawGroups.push({ ...d, ts: d.ts || new Date().toISOString(), actions, groupType });
        if (st.rawGroups.length > 50) st.rawGroups.shift();

        updateBER(d.errB);
        renderPS();
        if (logOpen) renderRealtimeLog();
        setEl('rdsm-gc', `Groups: ${st.grpTotal}`);
    }

    function onAI(d) {
        if (d.psName !== undefined) st.psName = d.psName || null;
        if (d.aiReason !== undefined) st.aiReason = d.aiReason;
        if (d.aiColor !== undefined) st.aiColor = d.aiColor;
        
        if (d.stats) {
            if (d.stats.refItu) st.refItu = d.stats.refItu;
            if (d.stats.refTxName !== undefined) st.refTxName = d.stats.refTxName;
            if (d.stats.refDistKm !== undefined) st.refDistKm = d.stats.refDistKm;
            if (d.stats.refAzimuth !== undefined) st.refAzimuth = d.stats.refAzimuth;
            if (d.stats.refErp !== undefined) st.refErp = d.stats.refErp;
            if (d.stats.refPol !== undefined) st.refPol = d.stats.refPol;
        }
        
        if (d.psLocked !== undefined) st.psLocked = d.psLocked;
        if (d.psLockReason !== undefined) st.psLockReason = d.psLockReason;
        if (d.aiConf !== undefined) st.aiConf = d.aiConf;
        if (d.altFreqs && Array.isArray(d.altFreqs)) st.altFreqs = d.altFreqs;

        if (d.ps && Array.isArray(d.ps)) {
            let confSum = 0;
            for (let i = 0; i < 8; i++) {
                st.aiPs[i] = d.ps[i] && d.ps[i].char !== ' ' ? d.ps[i].char : '_';
                confSum += (d.ps[i] ? d.ps[i].conf : 0);
            }
            if (st.aiConf === 0) st.aiConf = Math.round((confSum / 8) * 100);
        }
        
        if (d.af && Array.isArray(d.af)) st.af = d.af;

        renderStatus();
        renderPS();
        renderHeader();
        renderReasonBox();
        renderAF();
        if (logOpen) renderRealtimeLog();
    }

    function renderStatus() {
        const el = document.getElementById('rdsm-status');
        if (!el) return;

        if (st.psLocked) {
            el.innerHTML = `<span class="rf on" style="background:#1b3b2a;color:#44ff88;border:1px solid #44ff88;padding:3px 7px;">LOCKED</span> <span style="color:#777;font-size:11px;">- ${st.psLockReason || 'DB verified'}</span>`;
        } else if (st.psName && st.aiConf >= 50) {
            el.innerHTML = `<span class="rf on" style="background:#2a2331;color:#c8a020;border:1px solid #c8a020;padding:3px 7px;">PROVISIONAL</span> <span style="color:#888;font-size:11px;">- ${st.aiConf}% match</span>`;
        } else if (st.psName && st.aiConf > 0) {
            el.innerHTML = `<span class="rf" style="border:1px solid #2a2a2a;padding:3px 7px;">WAIT</span> <span style="color:#555;font-size:11px;">- collecting...</span>`;
        } else {
            el.innerHTML = `<span class="rf" style="border:1px solid #2a2a2a;padding:3px 7px;">WAIT</span> <span style="color:#555;font-size:11px;">collecting...</span>`;
        }
    }

    function renderAF() {
        const titleEl = document.getElementById('rdsm-af-title');
        const listEl = document.getElementById('rdsm-af-list');
        const flagEl = document.getElementById('rdsm-af-flag');
        if (!titleEl || !listEl) return;
        
        let uniqueDbFreqs = [];
        if (st.altFreqs && st.altFreqs.length > 0) {
            const seen = new Set();
            uniqueDbFreqs = st.altFreqs.filter(item => {
                const key = parseFloat(item.freq).toFixed(1);
                if (seen.has(key)) return false;
                seen.add(key); return true;
            });
            uniqueDbFreqs.sort((a, b) => parseFloat(a.freq) - parseFloat(b.freq));
        }

        const sortedAf = st.af ? [...st.af].sort((a, b) => parseFloat(a) - parseFloat(b)) : [];
        const receivedFreqSet = new Set(sortedAf.map(f => parseFloat(f).toFixed(1)));
        
        if (uniqueDbFreqs.length > 0) {
            if (flagEl) flagEl.className = 'rf on';
            let matched = 0;
            uniqueDbFreqs.forEach(f => { if (receivedFreqSet.has(parseFloat(f.freq).toFixed(1))) matched++; });
            const pct = Math.round((matched / uniqueDbFreqs.length) * 100);
            titleEl.innerHTML = `AF <span style="font-weight:normal; color:#888;">${matched}/${uniqueDbFreqs.length} (${pct}%)</span>`;
            
            const chipsHtml = uniqueDbFreqs.map(f => {
                const freqLabel = parseFloat(f.freq).toFixed(1);
                const isMatch = receivedFreqSet.has(freqLabel);
                const bg = isMatch ? 'var(--color-main-bright, #4a90d9)' : '#1c1c1c';
                const border = isMatch ? 'var(--color-main-bright, #4a90d9)' : '#2a2a2a';
                const color = isMatch ? '#fff' : '#444';
                return `<span class="af-chip" style="background:${bg}; border:1px solid ${border}; color:${color};" title="${freqLabel} MHz - ${f.station || st.psName || ''}">${freqLabel}</span>`;
            }).join('');
            listEl.innerHTML = chipsHtml;
        } else if (sortedAf.length > 0) {
            if (flagEl) flagEl.className = 'rf on';
            titleEl.innerHTML = `AF <span style="font-weight:normal; color:#888;">(${sortedAf.length} received)</span>`;
            const chipsHtml = sortedAf.map(f => {
                const freqLabel = parseFloat(f).toFixed(1);
                return `<span class="af-chip" style="background:var(--color-main-bright, #4a90d9); border:1px solid var(--color-main-bright, #4a90d9); color:#fff;">${freqLabel}</span>`;
            }).join('');
            listEl.innerHTML = chipsHtml;
        } else {
            if (flagEl) flagEl.className = 'rf';
            titleEl.textContent = 'AF';
            listEl.innerHTML = '<span style="color:#555; font-size:10px;">No AF decoded</span>';
        }
    }

    function renderPS() {
        for (let i = 0; i < 8; i++) {
            const chEl = document.getElementById(`rdsm-c${i}`);
            if (!chEl) continue;

            const isHardDecoded = st.psErrBuf[i] <= 1;
            
            if (isHardDecoded) {
                chEl.textContent = st.psBuf[i] === ' ' ? '_' : st.psBuf[i];
                chEl.style.color = '#e0e0e0'; 
                chEl.style.fontWeight = 'bold';
            } else if (st.aiPs[i] && st.aiPs[i] !== '_') {
                chEl.textContent = st.aiPs[i];
                chEl.style.color = '#6c757d'; 
                chEl.style.fontWeight = 'normal';
            } else {
                chEl.textContent = '_';
                chEl.style.color = '#333';
            }
            chEl.parentElement.title = `Hard Decoded: ${isHardDecoded} | AI Prediction: ${st.aiPs[i]}`;
        }
    }

    function renderHeader() {
        const el = document.getElementById('rdsm-psname');
        if (!el) return;
        
        let line1 = '';
        let line2 = '';
        let flagHtml = '';

        if (!st.pi || st.pi === '----' || st.pi === '?') {
            line1 = `<span style="font-size:14px;font-weight:600;color:#f0f0f0;">-</span>`;
        } else if (st.psName) {
            let l1Parts = [`<span style="font-size:14px;font-weight:600;color:#f0f0f0;">${st.psName}</span>`];
            
            let locPart = '';
            if (st.refTxName) locPart += st.refTxName;
            if (st.refItu) locPart += (locPart ? ` (${st.refItu.toUpperCase()})` : `(${st.refItu.toUpperCase()})`);
            
            if (locPart) {
                l1Parts.push(`<span style="font-size:12px;color:#aaa;">${locPart}</span>`);
            }
            
            line1 = l1Parts.join(' <span style="color:#666;margin:0 4px;">&bull;</span> ');

            let l2Parts = [];
            if (st.refErp !== null) {
                let erpPol = `${st.refErp} kW`;
                if (st.refPol) erpPol += ` [${st.refPol}]`;
                l2Parts.push(erpPol);
            } else if (st.refPol) {
                l2Parts.push(`[${st.refPol}]`);
            }
            if (st.refDistKm !== null) l2Parts.push(`${st.refDistKm} km`);
            if (st.refAzimuth !== null) l2Parts.push(`${st.refAzimuth}&deg;`);
            
            if (l2Parts.length > 0) {
                line2 = `<div style="font-size:10px; color:#888; margin-top:2px;">${l2Parts.join(' <span style="color:#555;margin:0 4px;">&bull;</span> ')}</div>`;
            }

            if (st.refItu) {
                const safeItu = st.refItu.trim().toUpperCase();
                let flagSrc = `https://tef.noobish.eu/logos/images/${safeItu}.png`; 
                if (typeof countryList !== 'undefined' && Array.isArray(countryList)) {
                    const cEntry = countryList.find(c => c && c.itu_code && c.itu_code.trim().toUpperCase() === safeItu);
                    if (cEntry && cEntry.country_code && cEntry.country_code.trim() !== "") {
                        flagSrc = `https://flagcdn.com/w40/${cEntry.country_code.trim().toLowerCase()}.png`;
                    }
                }
                flagHtml = `
                <div title="${safeItu}" style="display: inline-block; width: 24px; height: 18px; border-radius: 2px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); background: url('${flagSrc}') center/cover no-repeat;">
                    <img src="${flagSrc}" style="display: none;" onerror="this.parentNode.style.display='none';">
                </div>`;
            }

        } else {
            line1 = `<span style="font-size:14px;color:#dc3545;font-weight:bold;">No DB Match</span>`;
        }

        el.innerHTML = `
            <span class="rl" style="margin-top:2px;">STATION</span>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex:1; overflow:hidden;">
                <div style="display:flex; flex-direction:column; justify-content:center;">
                    <div style="display:flex; align-items:center;">${line1}</div>
                    ${line2}
                </div>
                ${flagHtml ? `<div style="margin-left: 10px; flex-shrink: 0; margin-top:2px;">${flagHtml}</div>` : ''}
            </div>`;
    }

    function renderReasonBox() {
        const el = document.getElementById('rdsm-ai-reason');
        if (!el) return;
        
        if (st.aiReason) {
            el.innerHTML = `<strong style="color: ${st.aiColor};">AI Prediction Logic:</strong> ${st.aiReason}`;
        } else {
            el.innerHTML = '';
        }
    }

function renderRealtimeLog() {
        if (logPaused) return; 

        const tbody = document.getElementById('rdsm-log-body');
        const container = document.getElementById('rdsm-log-container');
        if (!tbody || !container) return;

        const isAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 30;
        const scrollPos = container.scrollTop;

        let html = '';
        st.rawGroups.forEach(g => {
            const acts = g.actions || { flags: {} };
            const isErr = g.errB.some(e => e === 3) || g.errB[1] > 1 || g.errB[0] > 1;

            let actParts = [];
            
            if (isErr) {
                if (acts.err && logFilters.err) actParts.push(acts.err);
                else if (logFilters.err) actParts.push(`<span style="color:#ff4444;">Block Error</span>`);
            } else {
                // Only push the specific components that the user wants to see
                if (logFilters.ps && acts.ps) actParts.push(acts.ps);
                if (logFilters.rt && acts.rt) actParts.push(acts.rt);
                if (logFilters.af && acts.af) actParts.push(acts.af);
                if (logFilters.ecc && acts.ecc) actParts.push(acts.ecc);
                if (logFilters.tp && acts.tp) actParts.push(acts.tp);
                if (logFilters.other && acts.other) actParts.push(acts.other);
            }

            let flagParts = [];
            if (!isErr && acts.flags) {
                // Only push the specific flags the user wants to see
                if (logFilters.tp && acts.flags.tp !== undefined) flagParts.push(`TP:${acts.flags.tp}`);
                if (logFilters.ta && acts.flags.ta !== undefined) flagParts.push(`TA:${acts.flags.ta}`);
                if (logFilters.ms && acts.flags.ms !== undefined) flagParts.push(`MS:${acts.flags.ms}`);
            }
            
            if (flagParts.length > 0) {
                actParts.push(`<span style="color:#888; font-family:monospace; font-size:10px;">[${flagParts.join(' ')}]</span>`);
            }

            // Determine if the row has any content left to show after filtering
            let showRow = false;
            if (isErr && logFilters.err) showRow = true;
            if (!isErr && actParts.length > 0) showRow = true;

            if (!showRow) return;

            let finalActionStr = actParts.join(' <span style="color:#555; margin: 0 4px;">|</span> ');

            const timeStr = g.ts ? g.ts.split('T')[1].slice(0, -1) : '';
            const errColor = g.errB[0] <= 1 ? '#44ff88' : '#ff4444';
            const displayPi = g.errB[0] <= 1 ? g.pi : `<span style="color:#dc3545; text-decoration:line-through;">${g.pi}</span>`;
            
            const aiPsLog = st.aiPs.join('');
            let aiDisp = '<span style="color:#ccc;">-</span>';
            if (aiPsLog && aiPsLog !== '________') {
                const textCol = st.aiConf >= 70 ? '#28a745' : (st.aiConf >= 40 ? '#fd7e14' : '#dc3545');
                aiDisp = `<span style="color:${textCol}; font-weight:bold;">${aiPsLog} <span style="color:#888; font-weight:normal;">(${st.aiConf}%)</span></span>`;
            }

            html += `
                <tr>
                    <td style="color:#777;">${timeStr}</td>
                    <td style="font-family:monospace; color:#555;">${displayPi}</td>
                    <td style="font-family:monospace; color:#555;">${g.b2 || '----'}</td>
                    <td style="font-family:monospace; color:${g.errB[2] === 2 ? '#fd7e14' : g.errB[2] >= 3 ? '#dc3545' : '#555'};">${g.b3 || '----'}</td>
                    <td style="font-family:monospace; color:${g.errB[3] === 2 ? '#fd7e14' : g.errB[3] >= 3 ? '#dc3545' : '#555'};">${g.b4 || '----'}</td>
                    <td style="color:${errColor}; font-weight:bold; letter-spacing:1px;">${g.errB.join('')}</td>
                    <td style="font-weight:bold;">${g.groupType || '-'}</td>
                    <td>${finalActionStr}</td>
                    <td>${aiDisp}</td>
                </tr>
            `;
        });
        
        tbody.innerHTML = html;
        if (isAtBottom) container.scrollTop = container.scrollHeight; else container.scrollTop = scrollPos;
    }

    function updateBER(errB) {
        if (!errB || !Array.isArray(errB)) return;
        const hasError = errB.some(e => e >= 2);
        if (errB[0] === 3) st.ber.push(1);
        st.ber.push(hasError ? 1 : 0);
        if (st.ber.length > 40) st.ber.shift();
        const errs   = st.ber.filter(v => v).length;
        const berPct = st.ber.length ? Math.round((errs / st.ber.length) * 100) : 0;
        const bar    = document.getElementById('rdsm-bf'), pct = document.getElementById('rdsm-bp');
        if (bar) { bar.style.width = berPct + '%'; bar.style.background = berPct < 20 ? '#44cc88' : berPct < 50 ? '#ffaa44' : '#ff5555'; }
        if (pct) pct.textContent = berPct + '%';
    }

    function syncFollowUI() {
        const panelBtn = document.getElementById('rdsm-follow-btn');
        if (panelBtn) {
            panelBtn.className = '';
            if (st.rdsFollow) { panelBtn.classList.add('on'); panelBtn.classList.add(st.rdsFollowLocked ? 'locked' : 'unlocked'); }
        }
        const navBtn = document.getElementById('rdsm-btn');
        if (navBtn) {
            const icon = navBtn.querySelector('i');
            if (icon) { if (st.rdsFollow) icon.style.color = st.rdsFollowLocked ? '#ff4444' : '#44ff88'; else icon.style.color = ''; }
        }
    }

    function reset() {
        st.pi = '?'; st.piCand = '?'; st.piN = 0;
        st.psBuf.fill(' '); st.psErrBuf.fill(3); st.aiPs.fill('_');
        st.grpTotal = 0; st.ber = []; st.rawGroups = []; st.freq = '-';
        st.psName = null; st.refItu = null; st.aiReason = null; st.aiConf = 0;
        st.af = []; st.altFreqs = []; st.psLocked = false; st.psLockReason = '';
        
        st.refTxName = null; st.refDistKm = null; st.refAzimuth = null; st.refErp = null; st.refPol = null;
        
        rtSlots = [mkRT(64), mkRT(64)]; rtAB = -1;
        st.rtLine1 = ''; st.rtLine2 = ''; st.rtabFlag = -1;
        const rt1 = document.getElementById('rdsm-rt1');
        const rt2 = document.getElementById('rdsm-rt2');
        if (rt1) rt1.innerHTML = '<span style="color:#333">-</span>';
        if (rt2) rt2.innerHTML = '<span style="color:#333">-</span>';
        
        setEl('rdsm-pi', '?');
        for (let i = 0; i < 8; i++) {
            const ch = document.getElementById(`rdsm-c${i}`);
            if (ch) { ch.textContent = '_'; ch.style.color = '#333'; }
        }
        const tbody = document.getElementById('rdsm-log-body');
        if (tbody) tbody.innerHTML = '';
        renderStatus();
        renderHeader();
        renderReasonBox();
        renderAF();
        
        const GA = []; for (let i = 0; i <= 15; i++) GA.push(`${i}A`, `${i}B`);
        GA.forEach(g => { const el = document.getElementById(`rg-${g}`); if (el) el.classList.remove('on'); });
        
        setFlag('rdsm-tp', false); setFlag('rdsm-ta', false); setFlag('rdsm-st', false);
        const msEl = document.getElementById('rdsm-ms'); if (msEl) { msEl.textContent = 'MUSIC'; msEl.className = 'rf'; }
        const ptyEl = document.getElementById('rdsm-pty'); if (ptyEl) ptyEl.innerHTML = '-';
        const eccEl = document.getElementById('rdsm-ecc-flag'); if (eccEl) { eccEl.textContent = 'ECC'; eccEl.className = 'rf'; }
        
        const bar = document.getElementById('rdsm-bf'), pct = document.getElementById('rdsm-bp');
        if (bar) { bar.style.width = '0%'; bar.style.background = '#44cc88'; }
        if (pct) pct.textContent = '0%';
    }

    function injectCSS() {
        if (document.getElementById('rdsm-css')) return;
        const s = document.createElement('style');
        s.id = 'rdsm-css';
        s.textContent = `
        #rdsm-panel-container { display:flex; z-index:999999; pointer-events:none; }
        
        #rdsm-panel { position:fixed; top:70px; right:20px; z-index:999999; pointer-events:auto; width:420px; background:var(--color-bg-1,#13151f); border:1px solid var(--color-main-bright, #4a90d9); border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6); font-family:"Titillium Web",Calibri,sans-serif; color:#e0e0e0;display:none;user-select:none; flex-direction:column;}
        #rdsm-panel-container.vis #rdsm-panel {display:flex;}
        
        #rdsm-log-pan { position:fixed; top:70px; right:460px; z-index:999999; pointer-events:auto; width:750px; height:500px; min-width:450px; min-height:250px; resize:both; overflow:hidden; background:var(--color-bg-1,#13151f); border:1px solid var(--color-main-bright, #4a90d9); border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6); font-family:"Titillium Web",Calibri,sans-serif; color:#e0e0e0;display:none; flex-direction:column; padding:12px; }
        #rdsm-panel-container.vis.log-open #rdsm-log-pan {display:flex;}

        #rdsm-hdr{display:flex;align-items:center;justify-content:space-between; padding:10px 14px 8px;background:#11141e;cursor:move; border-bottom: 1px solid rgba(255,255,255,0.07); border-radius:11px 11px 0 0;}
        .rdsm-ht{font-size:14px;font-weight:700;color:var(--color-main-bright,#4a90d9);text-transform:uppercase; letter-spacing:1px; white-space:nowrap;}
        #rdsm-dot{display:inline-block;width:16px;height:6px;border-radius:50%; background:#ff4444;transition:background .4s;vertical-align:middle;margin-right:10px;}
        #rdsm-dot.ok{background:#44ff88;}
        #rdsm-close{background:none;border:none;color:#fff;font-size:16px;cursor:pointer; opacity:.6; transition:opacity .2s;}
        #rdsm-close:hover{opacity:1;}
        #rdsm-body{padding:11px 14px;}
        .rr{display:flex;align-items:center;margin-bottom:8px;gap:8px;}
        .rl{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase; color:#777;min-width:62px;}
        .rv{font-size:14px;font-weight:600;flex:1;color:#f0f0f0; overflow:hidden;text-overflow:ellipsis;white-space:nowrap; display:flex; align-items:center;}
        #rdsm-ps{display:flex;gap:2px;flex:1;}
        .rpc{display:flex;flex-direction:column;align-items:center;width:20px;}
        .rpc .c{font-size:24px;font-weight:700;line-height:1.2;transition:color .25s;min-height:1.2em;}
        #rdsm-psname{display:flex;align-items:flex-start;min-height:32px;padding:4px 0;gap:8px;box-sizing:border-box;flex-shrink:0;margin-bottom:8px;}
        #rdsm-stats{display:flex; justify-content:space-between;align-items:center; padding:5px 14px 7px;border-top:1px solid rgba(255,255,255,.06); font-size:10px;color:#666;box-sizing:border-box;width:100%;}
        #rdsm-ber-wrap{display:flex;align-items:center;justify-content:flex-end; white-space:nowrap;font-variant-numeric:tabular-nums;}
        #rdsm-bw{width:50px;height:4px;background:#2a2a2a;border-radius:2px; overflow:hidden;display:inline-block;vertical-align:middle;flex-shrink:0;margin:0 4px;}
        #rdsm-bf{height:100%;border-radius:2px;background:#44cc88;transition:width .5s,background .5s;}
        #rdsm-bp{display:inline-block;min-width:3.2ch;text-align:right;}
        .rdiv{border:none;border-top:1px solid rgba(255,255,255,.07);margin:7px 0;}
        
        #rdsm-panel.drag {opacity:.85;}
        #rdsm-log-pan.drag {opacity:.85;}
        .rdsm-log-title { cursor: move; }

        #rdsm-record-btn { background: none; border: none; color: #ff4444; font-size: 16px; cursor: pointer; opacity: 0.8; padding: 0 4px; transition: transform 0.2s, opacity 0.2s; }
        #rdsm-record-btn:hover { opacity: 1; transform: scale(1.1); }
        #rdsm-muf-btn { background: transparent; border: 1px solid rgba(74, 144, 217, 0.3); color: #888; font-size: 10px; font-weight: 700; cursor: pointer; border-radius: 4px; padding: 2px 6px; margin-left: 6px; transition: color 0.3s, border-color 0.3s, background 0.3s, box-shadow 0.3s; }
        #rdsm-muf-btn:hover { color: #fff; border-color: rgba(74, 144, 217, 0.6); }
        #rdsm-muf-btn.on { color: #fff; border-color: var(--color-main-bright,#4a90d9); box-shadow: 0 0 5px rgba(74, 144, 217, 0.4); }
        .recording-pulse { animation: pulse-record 1.5s infinite; color: #ff4444 !important; }
        @keyframes pulse-record { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: 0.5; } 100% { transform: scale(1); opacity: 1; } }
        
        .rfl{display:flex;gap:5px;flex-wrap:wrap; min-height: 20px;}
        .rf{font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px; background:transparent;color:#666;border:1px solid rgba(255,255,255,0.1);letter-spacing:.5px; transition:border-color .25s,box-shadow .25s,color .25s;}
        .rf.on{background:transparent;color:#fff; border-color:var(--color-main-bright,#4a90d9); box-shadow: 0 0 3px rgba(74, 144, 217, 0.4);}
        .pty-badge{font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;background:transparent;color:#fff;border:1px solid var(--color-main-bright,#4a90d9);margin-left:4px;font-family:"Titillium Web",Calibri,sans-serif;min-width:24px;text-align:center;display:inline-block;}
        #rdsm-gg{display:flex;flex-wrap:wrap;gap:3px;flex:1;}
        .rgc{font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px; background:transparent;color:#444;border:1px solid rgba(255,255,255,0.1); min-width:24px;text-align:center;transition:border-color .3s,box-shadow .3s,color .3s;}
        .rgc.on{background:transparent;color:#fff;border-color:var(--color-main-bright,#4a90d9); box-shadow: 0 0 3px rgba(74, 144, 217, 0.4);}
        
        #rdsm-follow-btn{ display:inline-flex;align-items:center;gap:4px; font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase; color:#555;background:#181a24;border:1px solid #2a2d3a;border-radius:5px; padding:2px 8px 2px 6px;white-space:nowrap;user-select:none; transition:color .2s,border-color .2s,background .2s; }
        #rdsm-follow-btn.on.locked {color:#ff4444;border-color:#ff4444;background:#2a1111;}
        #rdsm-follow-btn.on.unlocked {color:#44ff88;border-color:#44ff88;background:#0d1a12;}
        
        #rdsm-log-btn{font-size:10px;font-weight:700;color:#777; text-transform:uppercase;letter-spacing:1px; cursor:pointer; display:flex; align-items:center; gap:4px; margin-left:auto;}
        #rdsm-log-btn:hover{color:#fff;}
        #rdsm-log-arrow{font-size:8px;transition:transform .2s; display:inline-block; transform:rotate(-90deg);}
        .log-open #rdsm-log-arrow{transform:rotate(0deg);}

        #rdsm-log-pause-btn { background:#1c1c1c; border:1px solid #333; color:#888; border-radius:4px; padding:3px 12px; font-size:10px; font-weight:bold; cursor:pointer; transition:all 0.2s; letter-spacing:0.5px; width: max-content; flex-shrink: 0; margin-left: auto; display: inline-block; }
        #rdsm-log-pause-btn.paused { background:#3a1818; border-color:#ff4444; color:#ff4444; }

        .rdsm-log-title{font-size:12px;font-weight:700;color:var(--color-main-bright,#4a90d9); text-transform:uppercase;letter-spacing:1px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,.1); padding-bottom:4px; display:flex; justify-content:space-between; align-items:center;}
        #rdsm-log-container table { width: 100%; border-collapse: collapse; text-align: left; font-size: 11px; }
        #rdsm-log-container table th { padding-bottom: 4px; color: #888; border-bottom: 1px solid #333; text-transform: uppercase; }
        #rdsm-log-container table td { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }

        #rdsm-rt-wrap{flex:1;min-width:0;}
        .rt-line-label{font-size:9px;color:#3a4a5a;display:block;margin-bottom:1px;line-height:1;}
        .rt-line{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.55;display:block;min-height:1.55em;}
        .rt-line + .rt-line-label{margin-top:5px;}
        .af-chip { display:inline-block; font-weight:700; font-size:11px; padding:2px 6px; border-radius:4px; margin:2px 4px 2px 0; }
        
        .af-container { display: flex; flex-wrap: wrap; min-height: 22px; align-content: flex-start;}
        #rdsm-status { display: flex; align-items: center; gap: 6px; min-height: 22px; }
        .af-header { font-size:10px; font-weight:700; color:#666; letter-spacing:.5px; margin-bottom: 4px; display: block;}
        
        .log-filters { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .log-filter-lbl { font-size: 10px; font-weight: 700; color: #aaa; display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; letter-spacing: 0.5px; transition: color 0.2s; }
        .log-filter-lbl input { margin: 0; cursor: pointer; accent-color: var(--color-main-bright, #4a90d9); }
        .log-filter-lbl:hover { color: #fff; }
        `;
        document.head.appendChild(s);
    }

    const GA = []; for (let i = 0; i <= 15; i++) GA.push(`${i}A`, `${i}B`);

    function createPanel() {
        if (document.getElementById('rdsm-panel-container')) return;
        const c = document.createElement('div');
        c.id = 'rdsm-panel-container';
        c.innerHTML = `
        <div id="rdsm-panel">
          <div id="rdsm-hdr">
            <span style="display:flex;align-items:center;gap:6px;white-space:nowrap;">
                <span class="rdsm-ht">${pluginName}</span>
                <button id="rdsm-record-btn" title="Record raw RDS data">⏺</button>
                <button id="rdsm-muf-btn" title="Toggle MUF Auto-Record">MUF OFF</button>
            </span>
            <span style="display:flex;align-items:center;gap:5px">
              <span id="rdsm-dot" title="Connection status"></span>
              <a href="${pluginManualUrl}" target="_blank" title="Manual" style="color:#fff; opacity:0.6; text-decoration:none; padding:0 4px;">?</a>
              <button id="rdsm-close">✕</button>
            </span>
          </div>
          <div id="rdsm-body">
            <div class="rr">
              <span class="rl">Freq</span>
              <span class="rv">
                <span id="rdsm-freq">-</span>
                <span id="rdsm-log-btn"><span id="rdsm-log-arrow">▶</span> REALTIME LOG</span>
              </span>
            </div>
            <div class="rr"><span class="rl">PI Code</span><span class="rv" id="rdsm-pi">?</span></div>
            <div class="rr"><span class="rl">Status</span><span class="rv" id="rdsm-status"></span></div>
            <hr class="rdiv">
            <div class="rr" style="align-items:flex-start">
              <span class="rl" style="margin-top:3px">PS</span>
              <div id="rdsm-ps">
                ${[0,1,2,3,4,5,6,7].map(i => `<div class="rpc"><span class="c" id="rdsm-c${i}" style="color:#333;">_</span></div>`).join('')}
              </div>
            </div>
            <hr class="rdiv">
            <div class="rr" id="rdsm-psname" style="align-items:flex-start; min-height: 32px;">
                <span class="rl" style="margin-top:2px;">STATION</span>
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex:1; overflow:hidden;">
                    <div style="display:flex; flex-direction:column; justify-content:center;">
                        <div style="display:flex; align-items:center;"><span style="font-size:14px;font-weight:600;color:#f0f0f0;">-</span></div>
                    </div>
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
            <div class="rr" style="align-items:flex-start">
              <span class="rl" style="margin-top:2px">Flags</span>
              <div style="display:flex; flex-direction:column; gap:4px; flex:1;">
                  <div class="rfl">
                    <span class="rf" id="rdsm-tp">TP</span>
                    <span class="rf" id="rdsm-ta">TA</span>
                    <span class="rf" id="rdsm-ms">MUSIC</span>
                    <span class="rf" id="rdsm-st">STEREO</span>
                    <span class="rf" id="rdsm-ecc-flag">ECC</span>
                  </div>
              </div>
            </div>
            <hr class="rdiv">
            <div class="rr" style="align-items:flex-start">
              <span class="rl" style="margin-top:2px">AF</span>
              <div style="display:flex; flex-direction:column; gap:2px; flex:1; width:100%;">
                  <span class="af-header" id="rdsm-af-title">AF</span>
                  <div class="af-container" id="rdsm-af-list"><span style="color:#555; font-size:10px;">No AF decoded</span></div>
              </div>
            </div>
            <hr class="rdiv">
            <div class="rr" style="align-items:flex-start">
              <span class="rl" style="margin-top:2px">Groups</span>
              <div id="rdsm-gg">
                ${GA.map(g => `<span class="rgc" id="rg-${g}">${g}</span>`).join('')}
              </div>
            </div>
          </div>
          <div id="rdsm-stats">
            <span id="rdsm-gc">Groups: 0</span>
            <div id="rdsm-follow-btn" title="RDS Follow Indicator">RDS Follow</div>
            <span id="rdsm-ber-wrap">BER <span id="rdsm-bw"><div id="rdsm-bf" style="width:0%"></div></span> <span id="rdsm-bp">0%</span></span>
          </div>
        </div>

        <div id="rdsm-log-pan">
            <div class="rdsm-log-title" id="rdsm-log-hdr">
                <span>REALTIME DECODER LOG (LAST 50 GROUPS)</span>
                <button id="rdsm-log-pause-btn" title="Freeze log updating">PAUSE</button>
            </div>
            <div class="log-filters" id="rdsm-log-filters">
                <label class="log-filter-lbl"><input type="checkbox" id="lf-ps" ${logFilters.ps?'checked':''}> PS</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-rt" ${logFilters.rt?'checked':''}> RT</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-af" ${logFilters.af?'checked':''}> AF</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-ecc" ${logFilters.ecc?'checked':''}> ECC</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-tp" ${logFilters.tp?'checked':''}> TP</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-ta" ${logFilters.ta?'checked':''}> TA</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-ms" ${logFilters.ms?'checked':''}> M/S</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-other" ${logFilters.other?'checked':''}> OTHERS</label>
                <label class="log-filter-lbl"><input type="checkbox" id="lf-err" ${logFilters.err?'checked':''}> ERRORS</label>
            </div>
            <div id="rdsm-ai-reason" style="margin-bottom: 12px; color: #aaa; line-height: 1.3;"></div>
            <div id="rdsm-log-container" style="flex: 1; overflow-y: auto;">
                <table>
                    <thead><tr><th>TIME</th><th>PI</th><th>B2</th><th>B3</th><th>B4</th><th>ERRS</th><th>GROUP</th><th>DECODING ACTION</th><th>AI PREDICTION</th></tr></thead>
                    <tbody id="rdsm-log-body"></tbody>
                </table>
            </div>
        </div>
        `;
        document.body.appendChild(c);
        
        ['ps','rt','af','ecc','tp','ta','ms','other','err'].forEach(f => {
            const cb = document.getElementById(`lf-${f}`);
            if (cb) cb.addEventListener('change', (e) => {
                logFilters[f] = e.target.checked;
                saveFilters();
            });
        });

        document.getElementById('rdsm-close').addEventListener('click', hidePanel);
        document.getElementById('rdsm-record-btn').addEventListener('click', () => {
            if (!isAdmin) return sendToast('warning', pluginName, 'Administrator login required to record RDS data.');
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'rdsm_toggle_record', isAdmin: true }));
        });
        document.getElementById('rdsm-muf-btn').addEventListener('click', () => {
            if (!isAdmin) return sendToast('warning', pluginName, 'Administrator login required to set MUF mode.');
            const modes = ['OFF', 'EU', 'NA', 'AU'];
            const nextMode = modes[(modes.indexOf(st.mufMode) + 1) % modes.length];
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'rdsm_set_muf_mode', mode: nextMode, isAdmin: true }));
        });

        document.getElementById('rdsm-log-btn').addEventListener('click', () => {
            logOpen = !logOpen;
            c.classList.toggle('log-open', logOpen);
            if (logOpen) renderRealtimeLog();
        });

        document.getElementById('rdsm-log-pause-btn').addEventListener('click', function() {
            logPaused = !logPaused;
            this.classList.toggle('paused', logPaused);
            this.textContent = logPaused ? 'RESUME' : 'PAUSE';
            if (!logPaused) renderRealtimeLog(); 
        });
        
        makeDrag(document.getElementById('rdsm-panel'), document.getElementById('rdsm-hdr'), 'rdsm_panel_pos', false);
        makeDrag(document.getElementById('rdsm-log-pan'), document.getElementById('rdsm-log-hdr'), 'rdsm_log_pos', true);
    }

function makeDrag(el, h, storageKey, isResizable = false) {
        let sx, sy, sl, st2, dr = false;
        
        try {
            const savedData = localStorage.getItem(storageKey);
            if (savedData) {
                const data = JSON.parse(savedData);
                if (data.left && data.top) { 
                    el.style.left = data.left; 
                    el.style.top = data.top; 
                    el.style.right = 'auto'; 
                }
                if (isResizable && data.width && data.height) {
                    el.style.width = data.width;
                    el.style.height = data.height;
                }
            }
        } catch(e) {}

        h.addEventListener('mousedown', e => {
            if (['rdsm-close', 'rdsm-record-btn', 'rdsm-muf-btn', 'rdsm-log-btn', 'rdsm-log-pause-btn'].includes(e.target.id)) return;
            dr = true; el.classList.add('drag');
            sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect(); sl = r.left; st2 = r.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!dr) return;
            el.style.left = Math.max(0, sl + e.clientX - sx) + 'px';
            el.style.top = Math.max(0, st2 + e.clientY - sy) + 'px';
            el.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => { 
            if (!dr) return;
            dr = false; el.classList.remove('drag'); 
            saveState();
        });

         if (isResizable) {
            const resizeObserver = new MutationObserver((mutations) => {
                for (let mutation of mutations) {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                        clearTimeout(el.resizeTimer);
                        el.resizeTimer = setTimeout(saveState, 500);
                    }
                }
            });
            resizeObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
        }

        function saveState() {
            try { 
                const state = { left: el.style.left, top: el.style.top };
                if (isResizable) {
                    state.width = el.style.width;
                    state.height = el.style.height;
                }
                localStorage.setItem(storageKey, JSON.stringify(state)); 
            } catch(e) {}
        }
    }

    function addBtn() {
        let found = false;
        const obs = new MutationObserver((_, o) => {
            if (typeof addIconToPluginPanel !== 'function') return;
            found = true; o.disconnect();
            addIconToPluginPanel('rdsm-btn', 'RDS Decoder', 'solid', 'radio', `${pluginName} v${pluginVersion}`);
            
            const btnObs = new MutationObserver((_, o2) => {
                const btn = document.getElementById('rdsm-btn');
                if (!btn) return;
                o2.disconnect();
                
                let pressTimer = null, wasLongPress = false;
                const startPress = (e) => {
                    if (e.type === 'mousedown' && e.button !== 0) return; 
                    wasLongPress = false;
                    pressTimer = setTimeout(() => {
                        pressTimer = null; wasLongPress = true; 
                        checkAdminMode();
                        if (st.rdsFollowLocked && !isAdmin) return sendToast('warning', pluginName, 'RDS Follow is locked. Administrator login required.');
                        const next = !st.rdsFollow;
                        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'rdsm_set_rds_follow', enabled: next }));
                        st.rdsFollow = next; syncFollowUI();
                        sendToast('success', pluginName, `RDS Follow Mode: ${next ? 'ON' : 'OFF'}`);
                    }, 600); 
                };
                const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };

                btn.addEventListener('mousedown', startPress);
                btn.addEventListener('touchstart', startPress, { passive: true });
                btn.addEventListener('mouseup', cancelPress);
                btn.addEventListener('mouseleave', cancelPress);
                btn.addEventListener('touchend', cancelPress);

                btn.addEventListener('click', (e) => {
                    if (wasLongPress) { wasLongPress = false; e.preventDefault(); e.stopPropagation(); return; }
                    const c = document.getElementById('rdsm-panel-container');
                    if (!panelVis) {
                        panelVis = true; btn.classList.add('active');
                        $(c).stop(true, true).fadeIn(400, () => { c.classList.add('vis'); });
                    } else { hidePanel(); }
                });
                syncFollowUI();
            });
            btnObs.observe(document.body, {childList:true, subtree:true});
        });
        obs.observe(document.body, {childList:true, subtree:true});
    }

    function hidePanel() {
        panelVis = false;
        const btn = document.getElementById('rdsm-btn'), c = document.getElementById('rdsm-panel-container');
        if (btn) btn.classList.remove('active');
        if (c) $(c).stop(true, true).fadeOut(400, () => { c.classList.remove('vis'); c.style.display = ''; });
    }

    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        if (reconn) { clearTimeout(reconn); reconn = null; }
        ws = new WebSocket(WS);
        ws.onopen = () => { setDot(true); ws.send(JSON.stringify({type:'rdsm_get_rds_follow'})); };
        ws.onclose = () => { setDot(false); reconn = setTimeout(connect, 5000); };
        ws.onerror  = () => setDot(false);
        ws.onmessage = e => onMessage(e.data);
    }

    const setEl = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    const setDot = ok => { const e = document.getElementById('rdsm-dot'); if (e) { e.style.background = ok ? '#44ff88' : '#ff4444'; e.className = ok ? 'ok' : ''; } };
    const setFlag = (id, on) => { const e = document.getElementById(id); if (e) e.className = 'rf' + (on ? ' on' : ''); };

    function init() {
        if (window.location.pathname === '/setup') return;
        injectCSS(); createPanel(); addBtn(); connect();
        fetch('/api').then(r => r.json()).then(d => { if (d.freq) { st.freq = d.freq; setEl('rdsm-freq', d.freq + ' MHz'); } }).catch(() => {});
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 900));
    else setTimeout(init, 900);

})();