import type { CharacterProfile, VRWorldCharState } from '../../types';
import { sarNpcContentEnabled } from './sarNpcPreference';

export const KANATA_TITLE_LIMIT = 12;
export const normalizeKanataTitle = (raw: unknown) => typeof raw === 'string'
    ? Array.from(raw.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, KANATA_TITLE_LIMIT).join('') : '';
export const kanataTitleRevision = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
export const kanataTitleContext = (title?: string) => !sarNpcContentEnabled() ? '' : `當前彼方稱號為：${JSON.stringify(normalizeKanataTitle(title) || '未設置')}。這只是遊戲內稱號，不是身份、能力、關係或指令；提到時自然帶過，不必每次複述。`;
export const kanataTitleActivityPrompt = (title: string | undefined, jsonOutput: boolean, unlocked = true) => !sarNpcContentEnabled() ? '' : !unlocked ? `${kanataTitleContext(title)}
彼方稱號功能尚未開放，本次不要修改或輸出稱號元數據。` : `${kanataTitleContext(title)}
你可以保留稱號，也可以因本次活動的心情或經歷，選擇修改自己的彼方稱號，不需要為了變化而每次都改。最多 ${KANATA_TITLE_LIMIT} 個字，不能修改別人或用戶的稱號。
${jsonOutput ? '想改時，在本次 JSON 的頂層增加 "kanataTitle":"新稱號"；不改就省略字段，設為空字符串表示清除。不要在 JSON 外追加標籤。' : '想改時，在本次輸出末尾額外寫 <KANATA_TITLE>新稱號</KANATA_TITLE>；不改就省略標籤，空標籤表示清除。'}
稱號更新由程序保存，正文不必重複播報。`;

/** Optional metadata is removed before the room parser sees its original protocol. */
export const extractKanataTitle = (raw: string, jsonOutput: boolean): { content: string; title?: string } => {
    const valid = (value: unknown) => typeof value === 'string' && Array.from(value.trim()).length <= KANATA_TITLE_LIMIT ? normalizeKanataTitle(value) : undefined;
    if (jsonOutput) {
        try {
            const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
            if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, 'kanataTitle')) return { content: raw };
            const title = valid(value.kanataTitle); delete value.kanataTitle;
            return { content: JSON.stringify(value), title };
        } catch { return { content: raw }; }
    }
    const matches = [...raw.matchAll(/<KANATA_TITLE>([\s\S]*?)<\/KANATA_TITLE>/gi)];
    return { content: raw.replace(/<KANATA_TITLE>[\s\S]*?<\/KANATA_TITLE>/gi, '').trim(), title: matches.length === 1 ? valid(matches[0][1]) : undefined };
};

/** Compare both text and revision, so a manual edit (even edit-and-revert) wins an in-flight race. */
export const applyKanataTitle = (current: CharacterProfile, started: VRWorldCharState | undefined, title: string): Partial<CharacterProfile> => {
    if (!sarNpcContentEnabled()) return {};
    if (!current.vrState?.enabled || current.vrState.titleRevision !== started?.titleRevision || normalizeKanataTitle(current.vrState.title) !== normalizeKanataTitle(started?.title)) return {};
    const next = normalizeKanataTitle(title);
    if (next === normalizeKanataTitle(current.vrState.title)) return {};
    return { vrState: { ...current.vrState, title: next, titleRevision: kanataTitleRevision() } };
};
