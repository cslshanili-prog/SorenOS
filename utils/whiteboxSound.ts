// 白框「提示音」聲明式聲音層。
//
// 設計要點（見分支 chatapp-whitebox-js-ympk39）：
// - 白框一直是 CSS-only 的可分享皮膚系統，靠"不執行任何腳本"來保證導入陌生人分享碼時的安全。
//   為了不破壞這個護欄，提示音**不給用戶 JS**，而是把聲音配置聲明成 CSS 裡的一段特殊註釋：
//     /* @sully-sound {"src":"chime","volume":0.6} */
//   播放由本模塊（可信代碼）執行，用戶只是填數據。
// - 這段註釋天然跟著白框的所有分享通道走（單角色 chromeCustomCss / 全局 chatChromeCustomCss /
//   SULLYCSS1 預設導出碼 / TXT 導出），因為這些通道都把 CSS 當不透明字符串搬運，不解析、不清洗註釋。
// - 瀏覽器忽略 CSS 註釋，所以對渲染零影響、對老白框完全向後兼容。
// - 內置音效用 WebAudio 現場合成（無音頻文件、分享碼裡只存一個短 key，體積極小）；也支持自定義音頻 URL。

export interface WhiteboxSound {
    /** 內置音效 key（見 BUILTIN_SOUNDS）、'none'（顯式靜音，用於角色覆蓋全局）、或自定義音頻直鏈 URL。 */
    src: string;
    /** 音量 0~1，默認 0.6。 */
    volume?: number;
}

// 內置音效：每個是一串"音符"，用 WebAudio 現場合成。freq=頻率(Hz)，at=相對起點(秒)，dur=時長(秒)，
// type=波形，gain=該音相對音量。刻意做得短、輕、不刺耳（移動端提示音場景）。
type Note = { freq: number; at: number; dur: number; type?: OscillatorType; gain?: number };

interface BuiltinSound {
    label: string;
    notes: Note[];
}

export const BUILTIN_SOUNDS: Record<string, BuiltinSound> = {
    chime: {
        label: '風鈴',
        notes: [
            { freq: 1046.5, at: 0, dur: 0.5, type: 'sine', gain: 0.6 },
            { freq: 1568.0, at: 0.09, dur: 0.6, type: 'sine', gain: 0.45 },
        ],
    },
    ding: {
        label: '叮',
        notes: [
            { freq: 880, at: 0, dur: 0.45, type: 'sine', gain: 0.7 },
            { freq: 1760, at: 0, dur: 0.28, type: 'sine', gain: 0.18 },
        ],
    },
    pop: {
        label: '氣泡',
        notes: [
            { freq: 420, at: 0, dur: 0.09, type: 'triangle', gain: 0.7 },
            { freq: 780, at: 0.05, dur: 0.12, type: 'sine', gain: 0.6 },
        ],
    },
    crystal: {
        label: '水晶',
        notes: [
            { freq: 1318.5, at: 0, dur: 0.32, type: 'sine', gain: 0.5 },
            { freq: 1760.0, at: 0.08, dur: 0.32, type: 'sine', gain: 0.4 },
            { freq: 2093.0, at: 0.16, dur: 0.4, type: 'sine', gain: 0.32 },
        ],
    },
    heart: {
        label: '心跳',
        notes: [
            { freq: 174, at: 0, dur: 0.18, type: 'sine', gain: 0.9 },
            { freq: 174, at: 0.24, dur: 0.22, type: 'sine', gain: 0.7 },
        ],
    },
    retro: {
        label: '像素',
        notes: [
            { freq: 660, at: 0, dur: 0.07, type: 'square', gain: 0.28 },
            { freq: 990, at: 0.08, dur: 0.1, type: 'square', gain: 0.28 },
        ],
    },
};

export const BUILTIN_SOUND_KEYS = Object.keys(BUILTIN_SOUNDS);

const clampVolume = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return 0.6;
    return Math.min(1, Math.max(0, n));
};

// ---- 註釋指令的解析 / 寫入 ----

// 匹配 /* @sully-sound ... {json} ... */，寬鬆容錯（大小寫、空白、v1 之類版本標記都不挑）。
const DIRECTIVE_RE = /\/\*\s*@sully-sound\b[^{}]*(\{[^{}]*\})\s*\*\//i;

/** 從一段 CSS 字符串裡解析出聲音配置；沒有 / 解析失敗 / src 為空 → 返回 null。 */
export const parseWhiteboxSound = (css?: string | null): WhiteboxSound | null => {
    if (!css) return null;
    const m = css.match(DIRECTIVE_RE);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[1]);
        const src = typeof obj?.src === 'string' ? obj.src.trim() : '';
        if (!src) return null;
        return { src, volume: clampVolume(obj?.volume) };
    } catch {
        return null;
    }
};

/** 剝掉 CSS 裡已有的 @sully-sound 指令（連同其後緊跟的一個換行），返回純 CSS。 */
export const stripWhiteboxSoundDirective = (css?: string | null): string => {
    if (!css) return '';
    return css.replace(/\/\*\s*@sully-sound\b[^{}]*\{[^{}]*\}\s*\*\/\n?/i, '');
};

/**
 * 把聲音配置寫進 CSS：先剝掉舊指令，sound 為 null 則等於刪除；否則把新指令放到 CSS 頂部。
 * 保持聲音配置隨 CSS 字符串一起走（存字段 / 預設 / TXT / 分享碼）。
 */
export const upsertWhiteboxSound = (css: string, sound: WhiteboxSound | null): string => {
    const base = stripWhiteboxSoundDirective(css);
    if (!sound || !sound.src) return base;
    const payload = JSON.stringify({ src: sound.src, volume: clampVolume(sound.volume) });
    const directive = `/* @sully-sound ${payload} */`;
    return base ? `${directive}\n${base}` : directive;
};

/**
 * 求出實際生效的提示音。優先級（從高到低）：
 *   角色白框指令（角色已綁定）→ 角色獨立字段（角色未綁定）→ 全局白框指令 → 全局默認字段。
 * 這樣角色設了就用角色的，沒設就回落到全局默認；兩種存法（綁進註釋 / 獨立字段）都能播。
 */
export const resolveActiveSound = (
    charCss?: string | null,
    charSound?: WhiteboxSound | null,
    globalCss?: string | null,
    globalSound?: WhiteboxSound | null,
): WhiteboxSound | null => {
    const pick = (s?: WhiteboxSound | null) => (s && s.src ? s : null);
    return parseWhiteboxSound(charCss) ?? pick(charSound) ?? parseWhiteboxSound(globalCss) ?? pick(globalSound);
};

// 提示音的「獨立分享碼」：SULLYSND1: + base64(utf8(JSON))。讓用戶不帶白框、單獨把提示音發給別人。
export const encodeSoundShare = (sound: WhiteboxSound): string =>
    'SULLYSND1:' + btoa(unescape(encodeURIComponent(JSON.stringify({ src: sound.src, volume: clampVolume(sound.volume) }))));

export const decodeSoundShare = (code: string): WhiteboxSound | null => {
    try {
        const body = code.trim().replace(/^SULLYSND1:/, '');
        const obj = JSON.parse(decodeURIComponent(escape(atob(body))));
        const src = typeof obj?.src === 'string' ? obj.src.trim() : '';
        if (!src) return null;
        return { src, volume: clampVolume(obj?.volume) };
    } catch {
        return null;
    }
};

// ---- 播放 ----

let audioCtx: AudioContext | null = null;

const getCtx = (): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    try {
        const Ctor = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return null;
        if (!audioCtx) audioCtx = new Ctor();
        return audioCtx;
    } catch {
        return null;
    }
};

/**
 * 在用戶手勢裡調用一次，嘗試解鎖 / 恢復 AudioContext（移動端自動播放策略要求首個音頻需用戶手勢觸發）。
 * 冪等、best-effort，失敗靜默。
 */
export const unlockWhiteboxAudio = (): void => {
    const ctx = getCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
};

const playBuiltin = (sound: BuiltinSound, volume: number): void => {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.01;
    for (const n of sound.notes) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = n.type || 'sine';
        osc.frequency.value = n.freq;
        osc.connect(g);
        g.connect(master);
        const start = t0 + n.at;
        const peak = Math.max(0.0001, n.gain ?? 0.6);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.linearRampToValueAtTime(peak, start + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.start(start);
        osc.stop(start + n.dur + 0.03);
    }
};

/** src 是自定義音頻（http(s) 直鏈或內聯 data URI），而非內置合成音。 */
export const isCustomAudioSrc = (s: string): boolean => /^https?:\/\//i.test(s) || /^data:audio\//i.test(s);

/** 播放一個白框提示音配置。best-effort：被自動播放策略擋住 / 無音頻能力時靜默失敗，絕不拋。 */
export const playWhiteboxSound = (sound: WhiteboxSound | null): void => {
    if (!sound || !sound.src || sound.src === 'none') return;
    const volume = clampVolume(sound.volume);
    try {
        const builtin = BUILTIN_SOUNDS[sound.src];
        if (builtin) {
            playBuiltin(builtin, volume);
            return;
        }
        // 自定義音頻：http(s) 直鏈或上傳後內聯的 data:audio URI，交給 <audio> 播放。
        if (isCustomAudioSrc(sound.src) && typeof Audio !== 'undefined') {
            const el = new Audio(sound.src);
            el.volume = volume;
            el.play().catch(() => {});
        }
    } catch {
        /* 播放失敗靜默，提示音不該影響聊天主流程 */
    }
};
