/**
 * 情緒褪色（plans/offline-date-redesign.md「情緒」，私聊和見面共用）。
 *
 * 每個 buff 的強度 1／2／3＝淺／中／深，從 since 起照半衰期衰減：
 * 淺 6 小時、中 1 天、深 3.5 天。剩下不到 FADE_FLOOR 就當已經淡掉，不顯示、不帶進提示詞，
 * 下次情緒評估落庫時清掉。舊資料沒有 since 的不褪（評估跑過一次就會補上）。
 *
 * 提示詞裡帶的還是評估模型寫的「當下情緒總結」（buffInjection），後面補一行此刻還剩什麼、多強：
 * 總結是幾小時前寫的，模型才知道哪些已經淡了。全部淡掉就不帶。
 */

import type { CharacterBuff, CharacterProfile } from '../types';

const HOUR = 3_600_000;
export const BUFF_HALF_LIFE_MS: Record<1 | 2 | 3, number> = { 1: 6 * HOUR, 2: 24 * HOUR, 3: 84 * HOUR };
/** 剩下的強度（以「淺」＝1 為單位）低於這個就當淡掉了 */
export const BUFF_FADE_FLOOR = 0.3;
/** 最多存幾條；帶進提示詞的最多幾條 */
export const BUFF_STORE_MAX = 12;
export const BUFF_INJECT_MAX = 6;

const level = (buff: CharacterBuff): 1 | 2 | 3 => {
    const n = Math.round(Number(buff.intensity));
    return n <= 1 ? 1 : n >= 3 ? 3 : 2;
};

/** 此刻還剩多強（0–3）；沒有 since 的不褪 */
export const buffStrength = (buff: CharacterBuff, now = Date.now()): number => {
    const base = level(buff);
    if (!buff.since || !Number.isFinite(buff.since)) return base;
    const elapsed = Math.max(0, now - buff.since);
    return base * Math.pow(0.5, elapsed / BUFF_HALF_LIFE_MS[base]);
};

/** 還沒淡掉的，照此刻的強度排（強的在前） */
export const liveBuffs = (buffs: CharacterBuff[] | undefined, now = Date.now()): CharacterBuff[] =>
    (buffs || [])
        .map((buff, index) => ({ buff, index, strength: buffStrength(buff, now) }))
        .filter(item => item.strength >= BUFF_FADE_FLOOR)
        .sort((a, b) => b.strength - a.strength || a.index - b.index)
        .map(item => item.buff);

/** 此刻強度換成 5 格（●●●○○）跟剩幾成，給畫面和提示詞用 */
export const buffStrengthDots = (buff: CharacterBuff, now = Date.now()): string => {
    const filled = Math.max(1, Math.min(5, Math.round((buffStrength(buff, now) / 3) * 5)));
    return '●'.repeat(filled) + '○'.repeat(5 - filled);
};
/** 跟它剛定下來時比，還剩幾成（0–1），給強度條用 */
export const buffRemaining = (buff: CharacterBuff, now = Date.now()): number => Math.max(0, Math.min(1, buffStrength(buff, now) / level(buff)));

/**
 * 評估模型給的新 buff 補上 since：同一個情緒（id 或 name 對得上）強度沒變就沿用原本的時間、繼續褪；
 * 強度變了或是新的，就從現在算。然後去掉已經淡掉的，留最強的 BUFF_STORE_MAX 條。
 */
export const settleBuffs = (previous: CharacterBuff[] | undefined, next: CharacterBuff[], now = Date.now()): CharacterBuff[] => {
    const prev = previous || [];
    const stamped = next.map(buff => {
        const match = prev.find(old => old.id === buff.id) || prev.find(old => old.name === buff.name);
        const since = match && match.since && level(match) === level(buff) ? match.since : now;
        return { ...buff, since };
    });
    return liveBuffs(stamped, now).slice(0, BUFF_STORE_MAX);
};

const describeAge = (ms: number): string => {
    // 刻度粗一點：提示詞裡這行每分鐘都變的話，每輪送出的系統提示詞都不一樣，提示詞快取就沒用了
    if (ms < HOUR) return '不到 1 小時';
    if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} 小時`;
    return `${Math.round(ms / (24 * HOUR))} 天`;
};

/** 帶進提示詞的情緒段；沒開情緒、沒有東西、或全部淡掉都回空字串 */
export const buildEmotionInjection = (char: Pick<CharacterProfile, 'activeBuffs' | 'buffInjection' | 'buffInjectionAt'>, now = Date.now()): string => {
    const summary = (char.buffInjection || '').trim();
    const stored = char.activeBuffs || [];
    // 舊資料：沒有任何時間戳就照原樣帶（評估跑過一次才開始褪）
    const timed = stored.some(buff => buff.since);
    if (!timed) return summary;
    const live = liveBuffs(stored, now).slice(0, BUFF_INJECT_MAX);
    if (!live.length) return '';
    const list = live.map(buff => `${buff.emoji ? `${buff.emoji} ` : ''}${buff.label} ${buffStrengthDots(buff, now)}`).join('、');
    const age = char.buffInjectionAt ? `這段情緒總結寫於 ${describeAge(now - char.buffInjectionAt)}前。` : '';
    const line = `（${age}此刻還在的情緒：${list}；沒列出來的都已經淡掉了，別再照著演。）`;
    return summary ? `${summary}\n${line}` : `### 當下情緒\n${line}`;
};

/** 給情緒評估模型看的「當前 buff」：強度換成此刻的、附上持續多久，已淡掉的不給 */
export const buffsForEvaluation = (buffs: CharacterBuff[] | undefined, now = Date.now()) =>
    liveBuffs(buffs, now).map(buff => {
        const { since, ...rest } = buff;
        const strength = buffStrength(buff, now);
        return {
            ...rest,
            intensity: (strength >= 2.5 ? 3 : strength >= 1.5 ? 2 : 1) as 1 | 2 | 3,
            ...(since ? { 已持續: describeAge(now - since) } : {}),
        };
    });
