/**
 * Char 背景音 · 歌詞片段緩存
 *
 * 給 schedule 層那個"此刻 char 在聽 X"注入一段穩定的歌詞窗口，影響 char 的心境 / 情緒。
 * 不做"當前播放到哪一行"這種進度模擬 —— char 沒有物理播放，拿一段代表性歌詞即可。
 *
 * - 同一首歌的全量歌詞按 songId 長久緩存（歌詞不會變；命中率爆高）
 * - 窗口按 (charId + today + slot.startTime + songId) 種子哈希挑起點，
 *   保證同一個 slot 內每次聊天看到的歌詞片段是一樣的，slot 一過就換或消失
 * - 拉失敗就返回空 string[]，prompt 層會無損降級成"只有歌名 + 藝人"
 */

import { MusicCfg, musicApi, parseLyric } from '../context/MusicContext';

const MEM_CACHE = new Map<number, string[] | null>();  // null = 已知沒有歌詞
const INFLIGHT = new Map<number, Promise<string[] | null>>();

const LS_KEY = (id: number) => `sully_char_lyric_v1_${id}`;
const LS_META_KEY = 'sully_char_lyric_meta_v1';
const LS_CAP = 200;  // 本地存的歌最多 200 首，超了按 LRU 淘汰

type LyricEntry = { text: string[] | null; at: number };

const loadFromLS = (id: number): LyricEntry | null => {
    try {
        const raw = localStorage.getItem(LS_KEY(id));
        if (!raw) return null;
        const j = JSON.parse(raw);
        if (!j || !Array.isArray(j.text) && j.text !== null) return null;
        return j as LyricEntry;
    } catch { return null; }
};

const saveToLS = (id: number, text: string[] | null) => {
    try {
        localStorage.setItem(LS_KEY(id), JSON.stringify({ text, at: Date.now() }));
        // 維護 meta 索引做 LRU 淘汰
        const metaRaw = localStorage.getItem(LS_META_KEY);
        const meta: number[] = metaRaw ? JSON.parse(metaRaw) : [];
        const next = [id, ...meta.filter(x => x !== id)].slice(0, LS_CAP);
        localStorage.setItem(LS_META_KEY, JSON.stringify(next));
        // 淘汰多出來的
        if (meta.length >= LS_CAP) {
            for (const gone of meta.slice(LS_CAP - 1)) {
                if (gone !== id) localStorage.removeItem(LS_KEY(gone));
            }
        }
    } catch {}
};

/** 拉一首歌的全量歌詞行文本，帶雙層緩存（mem + localStorage） */
const getFullLyric = async (cfg: MusicCfg, songId: number): Promise<string[] | null> => {
    if (MEM_CACHE.has(songId)) return MEM_CACHE.get(songId)!;

    const fromLS = loadFromLS(songId);
    if (fromLS) {
        MEM_CACHE.set(songId, fromLS.text);
        return fromLS.text;
    }

    // 去重 in-flight（同一首歌併發多次調用只打一次網）
    const existing = INFLIGHT.get(songId);
    if (existing) return existing;

    const p = (async () => {
        try {
            const r = await musicApi.lyric(cfg, songId);
            const raw = r?.lrc?.lyric || '';
            const lines = parseLyric(raw).map(l => l.text).filter(Boolean);
            const result = lines.length > 0 ? lines : null;
            MEM_CACHE.set(songId, result);
            saveToLS(songId, result);
            return result;
        } catch {
            // 拉失敗不 poisons 緩存（下一個 slot 有機會重試）
            return null;
        } finally {
            INFLIGHT.delete(songId);
        }
    })();
    INFLIGHT.set(songId, p);
    return p;
};

/** 用給定種子串穩定地取一段 lineCount 行的窗口 */
const pickWindow = (lines: string[], seed: string, lineCount: number): string[] => {
    if (lines.length === 0) return [];
    if (lines.length <= lineCount) return lines.slice();
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const maxStart = lines.length - lineCount;
    const start = h % (maxStart + 1);
    return lines.slice(start, start + lineCount);
};

/**
 * 拿 char 此刻應該"聽到"的那段歌詞（穩定、有限行、純只讀）。
 * @param cfg MusicContext 裡那份 MusicCfg（workerUrl + cookie + quality）
 * @param songId 歌的 id
 * @param seed 一般傳 `${charId}-${today}-${slot.startTime}-${songId}`
 * @param lineCount 默認 6 行，足夠讓 LLM 品味到情緒但不會撐爆 prompt
 * @returns 一段連續的歌詞行（可能為 []，如歌詞拉不到或是純音樂）
 */
export const getCharLyricSnippet = async (
    cfg: MusicCfg,
    songId: number,
    seed: string,
    lineCount: number = 6,
): Promise<string[]> => {
    if (!songId || !cfg) return [];
    const full = await getFullLyric(cfg, songId);
    if (!full || full.length === 0) return [];
    return pickWindow(full, seed, lineCount);
};
