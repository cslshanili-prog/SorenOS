/**
 * 見面（DateApp）正文的逐行解析：台詞開頭的英文方括號語氣標籤（`[lazy]`、`[chuckles]`），
 * 以及送去 TTS 前按服務商處理這些標籤。旁白、動作行不帶標籤。
 *
 * 舊消息的寫法也要認得：每行開頭的立繪表情 `[happy]`、台詞行尾的語音情緒 `[v:calm]`。
 * 顯示時一律藏掉；行尾的 `[v:xxx]` 當成一個語氣標籤。
 */

import type { APIConfig } from '../types';
import { resolveTtsProvider } from './ttsProvider';
import { isElevenLabsV3Model, resolveElevenLabsModel } from './elevenLabsTts';
import { normalizeFishCue } from './fishAudioTts';
import { VALID_EMOTIONS } from './minimaxTts';

export interface DateLine {
    /** 顯示用正文：方括號語氣標籤（含舊的 [v:xxx]）都去掉了 */
    text: string;
    /** 以引號開頭的台詞行 */
    isDialogue: boolean;
    /** 台詞裡引號中的部分（給 TTS）；不是台詞時為空 */
    spoken: string;
    /** 方括號語氣標籤（小寫，按出現順序），舊消息的行尾 [v:xxx] 也收在這裡 */
    tags: string[];
}

// 行首連續的方括號標籤：英文單詞、空格、連字號、底線，舊的 [v:xxx] 也認
const LEADING_TAG_RE = /^\s*\[([A-Za-z][A-Za-z _\-:]{0,40})\]\s*/;
const INLINE_TAG_RE = /\s*\[([A-Za-z][A-Za-z _\-]{0,40})\]/g;
const LEGACY_VOICE_TAG_RE = /\[v:\s*([a-zA-Z]+)\s*\]/gi;
const QUOTE_OPEN_RE = /^["\u201C\u300C\u300E\uFF02]/;
const QUOTED_RE = /["\u201C\uFF02]([^"\u201D\uFF02]*)["\u201D\uFF02]|\u300C([^\u300D]*)\u300D|\u300E([^\u300F]*)\u300F/g;

export const parseDateLine = (raw: string): DateLine => {
    const tags: string[] = [];
    const leading: string[] = [];
    let text = (raw || '').replace(LEGACY_VOICE_TAG_RE, (_m, emotion: string) => {
        tags.push(emotion.toLowerCase());
        return '';
    });
    let match = text.match(LEADING_TAG_RE);
    while (match) {
        const tag = match[1].trim().toLowerCase();
        if (tag && !tag.startsWith('v:')) leading.push(tag);
        text = text.slice(match[0].length);
        match = text.match(LEADING_TAG_RE);
    }
    // 句中也可能夾著標籤（「好。」[sighs]「走吧。」），一樣收進來、顯示時藏掉
    text = text.replace(INLINE_TAG_RE, (_m, tag: string) => {
        tags.push(tag.trim().toLowerCase());
        return '';
    }).replace(/[ \t]{2,}/g, ' ').trim();
    const isDialogue = QUOTE_OPEN_RE.test(text);
    const spoken = isDialogue
        ? Array.from(text.matchAll(QUOTED_RE)).map(m => m[1] ?? m[2] ?? m[3] ?? '').join(' ').trim()
        : '';
    return { text, isDialogue, spoken, tags: Array.from(new Set([...leading, ...tags])) };
};

/** 正文按行解析；空行與純標籤行丟掉。 */
export const parseDateBody = (body: string): DateLine[] =>
    (body || '').split('\n').map(parseDateLine).filter(line => line.text);

/**
 * 台詞送去 TTS 前，按服務商處理語氣標籤：
 * - ElevenLabs v3：原生支援，任意英文標籤放回句首
 * - 魚聲：只認官方那一小撮，認得的才放回句首
 * - MiniMax：方括號會被念出來，不放進文字；標籤剛好是它支援的情緒就當 emotion 參數
 * - ElevenLabs 其它模型：不支援，全部不帶
 */
export const applyDateVoiceTags = (
    text: string,
    tags: string[],
    apiConfig: APIConfig,
): { text: string; emotion?: string } => {
    const provider = resolveTtsProvider(apiConfig);
    if (!tags.length) return { text };
    if (provider === 'elevenlabs') {
        if (!isElevenLabsV3Model(resolveElevenLabsModel(apiConfig))) return { text };
        return { text: `${tags.map(tag => `[${tag}]`).join(' ')} ${text}` };
    }
    if (provider === 'fishaudio') {
        const cues = Array.from(new Set(tags.map(normalizeFishCue).filter(Boolean)));
        return { text: cues.length ? `${cues.map(cue => `[${cue}]`).join(' ')} ${text}` : text };
    }
    const emotion = tags.find(tag => VALID_EMOTIONS.has(tag));
    return emotion ? { text, emotion } : { text };
};
