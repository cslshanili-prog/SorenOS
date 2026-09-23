/**
 * 角色音樂人格初始化
 *
 * 目標：第一次在音樂 App 裡"拜訪"某個 char 時（或用戶手動點"初始化"），調一次 LLM，
 * 基於 char 的 systemPrompt + worldview + impression 生成一份 CharMusicProfile。
 *
 * 設計原則：
 * 1. 生成的 signatureArtists 名字都是真實存在的網易雲可搜的藝人（LLM 要知道真藝人）。
 * 2. 生成的 playlists 是 3 個概念，不預先填真歌曲 — 歌曲等到用戶打開某個歌單再實時搜。
 * 3. 產出是純本地數據，不打網易雲 upstream —— 零 Worker 成本。
 * 4. 失敗就拋錯，絕不降級 —— 否則會得到一份"告五人/陳綺貞"的通用檔案，
 *    讓用戶誤以為 char 真的喜歡這些藝人。寧可讓用戶重試，也不能汙染人格。
 */

import { APIConfig, CharacterProfile, CharMusicProfile, CharPlaylist, UserProfile } from '../types';
import { ContextBuilder } from './context';

const callLlm = async (api: APIConfig, sys: string, user: string): Promise<string> => {
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: sys },
                { role: 'user', content: user },
            ],
            temperature: 0.8,
            // 之前沒設 max_tokens，有的 provider 默認只給 512，JSON 直接被截斷 →
            // extractJson 失敗 → 舊邏輯 fallback 到"告五人/陳綺貞"。
            // 8000 和項目裡其它 prompt 一檔，給 thinking 模型 / 話多的模型留足空間。
            max_tokens: 8000,
            stream: false,
        }),
        // API 調用記錄標籤：音樂人格生成是後台任務，不標會被兜底成「用戶當時打開的 App」
        __sullyMeta: { appName: '音樂', purpose: '音樂人格生成' },
    } as RequestInit);
    if (!resp.ok) throw new Error(`LLM ${resp.status}`);
    const j = await resp.json();
    return j?.choices?.[0]?.message?.content || '';
};

/**
 * 魯棒的 JSON 提取器：
 * - 依次嘗試：純 parse → 去 fenced → 去 preamble → 最外層花括號 → 寬鬆修復 → 逐字段正則摳
 * - 寬鬆修復包括：中文全角標點 / trailing comma / 單引號 / 未加引號的 key / BOM
 * - 任何一步成功即返回；全部失敗返回 null
 */
const extractJson = <T = any>(text: string): T | null => {
    if (!text || typeof text !== 'string') return null;

    // 1) 原文直接 parse
    const raw = text.trim().replace(/^\uFEFF/, '');
    const tryParse = (s: string): any | null => {
        try { return JSON.parse(s); } catch { return null; }
    };
    let hit = tryParse(raw);
    if (hit) return hit;

    // 2) 去除 ``` 代碼圍欄
    const fencedMatch = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fencedMatch) {
        hit = tryParse(fencedMatch[1].trim());
        if (hit) return hit;
    }

    // 3) 抽取第一段最外層花括號（用棧匹配，正確處理嵌套）
    const braceSlice = (() => {
        const s = fencedMatch ? fencedMatch[1] : raw;
        const start = s.indexOf('{');
        if (start < 0) return null;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return s.slice(start, i + 1);
            }
        }
        return null;
    })();
    if (braceSlice) {
        hit = tryParse(braceSlice);
        if (hit) return hit;

        // 4) 寬鬆修復後再試
        let repaired = braceSlice
            // 中文全角標點 → 半角（只處理 key/value 外圍）
            .replace(/[：]/g, ':')
            .replace(/[，]/g, ',')
            .replace(/[“”„]/g, '"')
            .replace(/[‘’‚]/g, "'")
            // 單引號字符串 → 雙引號（簡版：不處理轉義）
            .replace(/'([^'\n\r]*?)'/g, '"$1"')
            // 未加引號的 key 加引號（{ foo: → { "foo":）
            .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
            // trailing comma
            .replace(/,(\s*[}\]])/g, '$1');
        hit = tryParse(repaired);
        if (hit) return hit;
    }
    return null;
};

/** 從自由文本里逐字段提取 persona（JSON 完全不可用時的最後防線） */
const scavengeFields = (text: string): Partial<PersonaDraft> => {
    const out: Partial<PersonaDraft> = {};

    // bio — 找 "bio" 行
    const bioM = text.match(/"?bio"?\s*[:：]\s*["“]([^"\n”]{2,60})["”]/);
    if (bioM) out.bio = bioM[1].trim();

    // genreTags — 找第一個數組 [...]
    const genreM = text.match(/"?genre[tT]ags"?\s*[:：]\s*\[([^\]]+)\]/);
    if (genreM) {
        out.genreTags = genreM[1].split(',')
            .map(s => s.replace(/["'“”‘’\s]/g, ''))
            .filter(Boolean).slice(0, 8);
    }

    // signatureArtists — 形如 [{"name": "..."}] 或純字符串數組
    const artistBlock = text.match(/"?signature[aA]rtists"?\s*[:：]\s*\[([\s\S]*?)\]/);
    if (artistBlock) {
        const inner = artistBlock[1];
        const names: string[] = [];
        const nameRe = /["“]([^"”\n]{1,30})["”]/g;
        let m: RegExpExecArray | null;
        while ((m = nameRe.exec(inner)) !== null) {
            const n = m[1].trim();
            if (n && !['name', 'artistId'].includes(n)) names.push(n);
        }
        if (names.length) out.signatureArtists = names.slice(0, 6).map(n => ({ name: n }));
    }

    // playlists — 最省事：找若干 title 字符串
    const playlistTitles: string[] = [];
    const plTitleRe = /"?title"?\s*[:：]\s*["“]([^"”\n]{1,30})["”]/g;
    let pm: RegExpExecArray | null;
    while ((pm = plTitleRe.exec(text)) !== null) playlistTitles.push(pm[1].trim());
    if (playlistTitles.length > 0) {
        out.playlists = playlistTitles.slice(0, 3).map(t => ({
            title: t,
            description: '',
        }));
    }

    return out;
};

interface PersonaDraft {
    bio: string;
    genreTags: string[];
    signatureArtists: { name: string; artistId?: number }[];
    playlists: { title: string; description: string; mood?: string; coverStyle?: string }[];
}

const buildPersonaPrompt = (char: CharacterProfile, user: UserProfile): { sys: string; usr: string } => {
    const core = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });
    const sys = `你是一個"音樂人格生成器"。根據給定的角色設定，為這個角色設計一份網易雲音樂個人主頁的品味檔案。

要求:
1. 藝人必須是真實存在、可以在網易雲搜到的華語 / 日系 / 英語 / 韓語藝人（不要虛構）
2. 曲風標籤要具體 (shoegaze / city-pop / post-rock / 民謠 / trip-hop / R&B / 後朋克 ...)，避免泛泛 ("流行"/"搖滾")
3. **3 個歌單必須主題徹底不同** —— 不是"3 個差不多但換了名字"，而是 3 個**真正不同的場景 / 心境 / 用途**，
   彼此 mood、曲風、使用場合都要分開。可以參考維度 (任選 3 個不同的)：
   - 時段 / 場合：深夜獨處｜清晨通勤｜失眠｜暴雨天｜長途車裡｜聚會前的換裝｜寫作中｜失戀後
   - 情緒：發洩｜治癒｜懷舊｜亢奮｜慵懶｜思考｜浪漫
   - 表達方式：自我對話｜送給某個特定人｜對世界的反抗｜逃避現實
   嚴禁出現兩個歌單 mood 一致、或描述裡講同一件事的情況。
4. 歌單標題 / 描述 / mood 都要從角色精神內核出發，不要套路化（不要"我的最愛"/"循環單"這種通用名）
5. bio 用角色自己的口吻寫（第一人稱），一句話即可，不超過30字

只輸出 JSON，不要任何解釋:
{
  "bio": "(一句話，角色第一人稱)",
  "genreTags": ["...", "...", "...(3-5個)"],
  "signatureArtists": [{"name":"真實藝人名"}, ... (3-6個)],
  "playlists": [
    {"title":"歌單A(短·獨特場景)", "description":"(角色口吻, 1-2句, 說清楚什麼時候聽 / 為什麼)", "mood":"從下面8個裡選一個: happy|sad|romantic|angry|chill|epic|nostalgic|dreamy"},
    {"title":"歌單B(短·和A完全不同的場景/心境)", "description":"...", "mood":"必須和A不同"},
    {"title":"歌單C(短·和A、B都不同)", "description":"...", "mood":"必須和A、B都不同"}
  ]
}`;

    const usr = `${core}

(可選) 用戶姓名: ${user.name || '用戶'}
(可選) 用戶 bio: ${user.bio || ''}

請為"${char.name}"生成音樂人格檔案。`;
    return { sys, usr };
};

export const CharMusicPersona = {
    /** 檢查是否已初始化 */
    isInitialized(char: CharacterProfile): boolean {
        const p = char.musicProfile;
        return !!(p && p.initializedAt && p.signatureArtists.length > 0);
    },

    /**
     * 調 LLM 生成角色的音樂人格檔案
     *
     * 失敗策略：**直接拋錯**，不走保底。
     * - 沒 LLM 配置 → 拋"未配置 API"
     * - 網絡/HTTP 失敗 → 拋底層錯誤（保留 status code）
     * - JSON 完全不可解析 → 拋"解析失敗"
     * - 解析出來但缺關鍵字段（藝人）→ 拋"字段缺失"
     * 目的：寧可讓用戶重試，也別悄悄給 char 塞一份默認品味。
     *
     * @returns 新的 CharMusicProfile（調用方負責持久化到 CharacterProfile）
     */
    async initialize(
        char: CharacterProfile,
        userProfile: UserProfile,
        apiConfig: APIConfig,
    ): Promise<CharMusicProfile> {
        const now = Date.now();

        if (!apiConfig.baseUrl || !apiConfig.model) {
            throw new Error('未配置 API（baseUrl 或 model 為空）');
        }

        const { sys, usr } = buildPersonaPrompt(char, userProfile);
        const rawText = await callLlm(apiConfig, sys, usr);
        if (!rawText || !rawText.trim()) {
            throw new Error('LLM 返回為空');
        }

        // 解析：結構化 parse 優先；不行就 scavenge（逐字段正則摳）
        // 兩條線結果合併 — 任何字段單項 OK 都先收下
        // LLM 吐的 JSON 缺字段是常態，所以按 Partial 收，字段級兜底在下面
        const structured: Partial<PersonaDraft> = extractJson<Partial<PersonaDraft>>(rawText) || {};
        const scavenged = scavengeFields(rawText);
        const draft: Partial<PersonaDraft> = {
            bio: sanitizeStr(structured.bio) || sanitizeStr(scavenged.bio),
            genreTags: firstArray(structured.genreTags, scavenged.genreTags),
            signatureArtists: firstArray(structured.signatureArtists, scavenged.signatureArtists),
            playlists: firstArray(structured.playlists, scavenged.playlists),
        };

        // 藝人字段：兼容三種形態 — [{name:"..."}] / ["..."] / 混合
        const artistsIn = draft.signatureArtists || [];
        const artists = artistsIn
            .map((a: any) => {
                if (typeof a === 'string') return { name: a.trim() };
                if (a && typeof a === 'object' && typeof a.name === 'string') return { name: a.name.trim() };
                return null;
            })
            .filter((a): a is { name: string } => !!a && !!a.name)
            .slice(0, 8);

        const genres = (draft.genreTags || [])
            .filter((t: any) => typeof t === 'string' && t.trim())
            .map((t: string) => t.trim())
            .slice(0, 8);

        const playlistsIn = (draft.playlists || []).slice(0, 3);
        const playlists: CharPlaylist[] = playlistsIn.map((p, i) => ({
            id: `pl-${now}-${i}`,
            title: sanitizeStr(p?.title) || `歌單 ${i + 1}`,
            description: sanitizeStr(p?.description) || '',
            coverStyle: sanitizeStr(p?.coverStyle) || `gradient-0${(i % 6) + 1}`,
            songs: [],
            mood: (typeof p?.mood === 'string' && ['happy','sad','romantic','angry','chill','epic','nostalgic','dreamy'].includes(p.mood))
                ? (p.mood as any) : undefined,
            createdAt: now,
            updatedAt: now,
        }));

        // 關鍵字段一律不許"找補" —— 沒藝人就等於沒品味，直接報錯讓用戶重試
        if (artists.length === 0) {
            throw new Error('LLM 沒返回可用的藝人字段（大概率是 JSON 格式錯了）');
        }
        if (genres.length === 0) {
            throw new Error('LLM 沒返回曲風標籤');
        }
        if (playlists.length === 0) {
            throw new Error('LLM 沒返回歌單概念');
        }

        return {
            bio: sanitizeStr(draft.bio) || `${char.name} 的音樂角落`,
            genreTags: genres,
            signatureArtists: artists,
            playlists,
            likedSongIds: [],
            recentPlays: [],
            reviews: [],
            canReadUserMusic: true,
            initializedAt: now,
            updatedAt: now,
        };
    },
};

// —— helpers ——
const sanitizeStr = (s: any): string => {
    if (typeof s !== 'string') return '';
    return s
        .replace(/^\s*["“”'‘’]+|["“”'‘’]+\s*$/g, '')  // 去首尾多餘引號
        .replace(/\s+/g, ' ')
        .trim();
};

function firstArray<T>(...candidates: (T[] | undefined)[]): T[] | undefined {
    for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0) return c;
    }
    return undefined;
}
