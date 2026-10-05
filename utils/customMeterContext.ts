import type { CharacterCustomMeter } from '../types';
import { formatRelativeAge } from './groupChat/relativeTime';

/**
 * 「日程/情緒」裡的心聲／好感度跟聊天之間的兩條線（2026-10-05，用戶反映「裡外不連續」）：
 * 1. 重新生成時帶上一次的結果，讓新的接著舊的寫，好感度不再每次從零打分。
 * 2. 條目勾了「帶進聊天」（shareWithChar）就放進私聊易變段，角色自己知道心裡在想什麼。
 *    好感度只帶那句狀態心聲，不帶數字——給數字角色很容易出戲說「我對你好感 85」。
 */

type MeterSnapshot = Pick<CharacterCustomMeter, 'content' | 'value' | 'statusNote' | 'updatedAt'>;

const ageOf = (ts: number | undefined, now: number) => (ts ? `（${formatRelativeAge(ts, now)}）` : '');

/** 生成提示詞裡「上一次」那段；還沒生成過就是空字串。 */
export function buildPreviousMeterNote(kind: 'text' | 'number', entry: MeterSnapshot, now: number = Date.now()): string {
    if (kind === 'text') {
        const prev = entry.content?.trim();
        if (!prev) return '';
        return [
            `上一次的心聲${ageOf(entry.updatedAt, now)}：`,
            prev,
            '',
            '這次是接著寫，不是重新開始：心情可以變、可以推翻上一次，但要接得上這之後發生的事；不要重複上一次的句子。',
        ].join('\n');
    }
    if (typeof entry.value !== 'number') return '';
    const note = entry.statusNote?.trim();
    return [
        `上一次的評估${ageOf(entry.updatedAt, now)}：${entry.value} 分${note ? `，那時的心聲是「${note}」` : ''}。`,
        '這次是延續，不是重新打分：以上一次為基礎，按這之後的對話調整。沒發生什麼特別的事就只小幅變動（幾分以內），有明確的大事才大幅升降。',
    ].join('\n');
}

/**
 * 私聊易變段「你此刻的心裡話」：只收勾了 shareWithChar、而且已經生成過內容的條目。
 * withAge=false 給主動消息模板（fire_pack）用：到點才渲染，「約 2 小時前」會過期，乾脆不寫。
 */
export function buildInnerStateBlock(
    innerVoices: CharacterCustomMeter[] | undefined,
    affinities: CharacterCustomMeter[] | undefined,
    options: { now?: number; withAge?: boolean } = {},
): string {
    const now = options.now ?? Date.now();
    const withAge = options.withAge ?? true;
    const lines: string[] = [];
    for (const e of innerVoices || []) {
        const text = e.shareWithChar ? e.content?.trim() : '';
        if (text) lines.push(`- ${e.title}${withAge ? ageOf(e.updatedAt, now) : ''}：${text.replace(/\s*\n+\s*/g, ' ')}`);
    }
    for (const e of affinities || []) {
        const note = e.shareWithChar ? e.statusNote?.trim() : '';
        if (note) lines.push(`- ${e.title}${withAge ? ageOf(e.updatedAt, now) : ''}：${note}`);
    }
    if (lines.length === 0) return '';
    return [
        '',
        '### 你此刻的心裡話（只有你自己知道）',
        ...lines,
        '這些是你自己心裡的狀態，會影響你說話的語氣和態度；不要原封不動說出來，也不要提到任何分數或數值。',
        '',
    ].join('\n');
}
