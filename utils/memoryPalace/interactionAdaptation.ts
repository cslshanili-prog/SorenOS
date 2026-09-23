/**
 * M2 — ChatApp Interaction Adaptation
 *
 * 只統計用戶消息的表面節奏，不分析角色回覆，也不更新角色基線：
 * - impulse：當前連續 user 氣泡，下一輪自然消失
 * - trend：此前最近 20 個 user 輪次的加權趨勢；一輪可包含任意數量的連續氣泡
 * - policy：角色獨立的靠近意願，分維度 0..1
 */

import type { CharacterAccommodationPolicy, Message } from '../../types';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export interface InteractionSurfaceState {
    /** 平均消息長度，0=極短，1=很長。 */
    length: number;
    /** 氣泡連續、發送間隔和短句共同形成的節奏速度。 */
    rhythm: number;
    /** 感嘆、重複字符、emoji、連續氣泡共同形成的表面能量。 */
    energy: number;
    punctuation: number;
    emoji: number;
}

export interface ResolvedAccommodationPolicy {
    length: number;
    rhythm: number;
    energy: number;
    punctuation: number;
    emoji: number;
}

export interface UserInteractionAnalysis {
    analyzable: boolean;
    hasTrend: boolean;
    impulse: InteractionSurfaceState;
    trend: InteractionSurfaceState;
    target: InteractionSurfaceState;
    policy: ResolvedAccommodationPolicy;
    /** 各維度最終相對中性步伐的偏移；已經乘過角色 policy。 */
    shifts: InteractionSurfaceState;
}

export const DEFAULT_CHARACTER_ACCOMMODATION: Readonly<ResolvedAccommodationPolicy> = Object.freeze({
    length: 0.25,
    rhythm: 0.28,
    energy: 0.22,
    punctuation: 0.12,
    emoji: 0.08,
});

export const INTERACTION_TREND_TURN_LIMIT = 20;
export const INTERACTION_TREND_MESSAGE_SCAN_LIMIT = 200;

const EMPTY_STATE: Readonly<InteractionSurfaceState> = Object.freeze({
    length: 0.5,
    rhythm: 0.5,
    energy: 0.15,
    punctuation: 0,
    emoji: 0,
});

// “沒有感嘆號/emoji”通常只是普通聊天，不等於低落。各維度使用自己的
// 中性點，避免把每條平靜短句都渲染成需要降溫的情緒信號。
const NEUTRAL_TARGET: Readonly<InteractionSurfaceState> = Object.freeze({
    length: 0.5,
    rhythm: 0.5,
    energy: 0.15,
    punctuation: 0,
    emoji: 0,
});

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function resolveAccommodationPolicy(
    source?: CharacterAccommodationPolicy,
): ResolvedAccommodationPolicy {
    const resolve = (key: keyof ResolvedAccommodationPolicy): number => {
        const value = source?.[key];
        return typeof value === 'number' && Number.isFinite(value)
            ? clamp01(value)
            : DEFAULT_CHARACTER_ACCOMMODATION[key];
    };
    return {
        length: resolve('length'),
        rhythm: resolve('rhythm'),
        energy: resolve('energy'),
        punctuation: resolve('punctuation'),
        emoji: resolve('emoji'),
    };
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; earlier: Message[] } {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], earlier: messages };
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return { current: messages.slice(start, end + 1), earlier: messages.slice(0, start) };
}

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function measure(messages: Message[]): InteractionSurfaceState | null {
    if (messages.length === 0) return null;
    const texts = messages.map(message => message.content.trim()).filter(Boolean);
    if (texts.length === 0) return null;

    const lengths = texts.map(meaningfulLength);
    const totalChars = Math.max(1, lengths.reduce((sum, value) => sum + value, 0));
    const averageLength = totalChars / texts.length;
    const joined = texts.join('\n');
    const punctuationCount = (joined.match(/[，。！？!?；;：:、…]/gu) || []).length;
    const emphaticCount = (joined.match(/[!！?？]/gu) || []).length;
    const emojiCount = (joined.match(/\p{Extended_Pictographic}/gu) || []).length;
    const repeatedCount = (joined.match(/(.)\1{2,}/gu) || []).length;

    const timestamps = messages
        .map(message => message.timestamp)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    let speed = 0.5;
    if (timestamps.length >= 2) {
        const gaps = timestamps.slice(1).map((value, index) => Math.max(0, value - timestamps[index]));
        const averageGapSeconds = gaps.reduce((sum, value) => sum + value, 0) / gaps.length / 1000;
        speed = clamp01(1 - averageGapSeconds / 90);
    }
    const bubbleBurst = clamp01((texts.length - 1) / 3);
    const brevity = 1 - clamp01(averageLength / 72);
    const punctuation = clamp01(punctuationCount / Math.max(2, totalChars * 0.22));
    const emoji = clamp01(emojiCount / Math.max(1, texts.length * 1.5));
    const energy = clamp01(
        emphaticCount * 0.16
        + repeatedCount * 0.24
        + emoji * 0.24
        + bubbleBurst * 0.18,
    );
    const rhythm = clamp01(bubbleBurst * 0.42 + speed * 0.28 + brevity * 0.3);

    return {
        length: clamp01(averageLength / 72),
        rhythm,
        energy,
        punctuation,
        emoji,
    };
}

function collectUserTurns(messages: Message[]): Message[][] {
    const turns: Message[][] = [];
    let currentTurn: Message[] = [];
    const flush = () => {
        if (currentTurn.length > 0) turns.push(currentTurn);
        currentTurn = [];
    };

    messages.slice(-INTERACTION_TREND_MESSAGE_SCAN_LIMIT).forEach(message => {
        if (message.role === 'user') {
            currentTurn.push(message);
        } else {
            flush();
        }
    });
    flush();
    return turns.slice(-INTERACTION_TREND_TURN_LIMIT);
}

function weightedTrend(messages: Message[]): InteractionSurfaceState | null {
    const states = collectUserTurns(messages)
        .map(turn => measure(turn))
        .filter((state): state is InteractionSurfaceState => Boolean(state));
    if (states.length === 0) return null;

    const totals: InteractionSurfaceState = { length: 0, rhythm: 0, energy: 0, punctuation: 0, emoji: 0 };
    let totalWeight = 0;
    states.forEach((state, index) => {
        // 20 輪窗口需要比舊版 8 條消息更慢地衰減，否則遠端樣本名義存在、實際沒權重。
        const weight = Math.pow(0.9, states.length - index - 1);
        totalWeight += weight;
        (Object.keys(totals) as Array<keyof InteractionSurfaceState>).forEach(key => {
            totals[key] += state[key] * weight;
        });
    });
    (Object.keys(totals) as Array<keyof InteractionSurfaceState>).forEach(key => {
        totals[key] = clamp01(totals[key] / totalWeight);
    });
    return totals;
}

export function analyzeUserInteraction(
    messages: Message[],
    policySource?: CharacterAccommodationPolicy,
    charName?: string,
    userName?: string,
): UserInteractionAnalysis {
    const safe = sanitizeQuerySourceMessages(messages, charName, userName);
    const { current, earlier } = splitCurrentUserBurst(safe);
    const impulse = measure(current);
    const policy = resolveAccommodationPolicy(policySource);
    if (!impulse) {
        return {
            analyzable: false,
            hasTrend: false,
            impulse: { ...EMPTY_STATE },
            trend: { ...EMPTY_STATE },
            target: { ...EMPTY_STATE },
            policy,
            shifts: { length: 0, rhythm: 0, energy: 0, punctuation: 0, emoji: 0 },
        };
    }

    const measuredTrend = weightedTrend(earlier);
    const trend = measuredTrend || impulse;
    const keys = Object.keys(impulse) as Array<keyof InteractionSurfaceState>;
    const target = { ...impulse };
    const shifts = { ...impulse };
    keys.forEach(key => {
        // impulse 只影響當輪；trend 提供最近 20 輪的慢背景。
        // 當前回應以 impulse 為主；trend 只負責讓長期相處節奏緩慢延續。
        target[key] = clamp01(trend[key] * 0.35 + impulse[key] * 0.65);
        shifts[key] = (target[key] - NEUTRAL_TARGET[key]) * policy[key];
    });

    return {
        analyzable: true,
        hasTrend: Boolean(measuredTrend),
        impulse,
        trend,
        target,
        policy,
        shifts,
    };
}

export function renderInteractionAdaptationGuidance(
    analysis: UserInteractionAnalysis | undefined,
): string {
    if (!analysis?.analyzable) return '';
    if (!Object.values(analysis.policy).some(value => value > 0.001)) return '';

    const lines: string[] = [];
    const { impulse, trend, shifts, policy } = analysis;
    const impulseLengthDelta = impulse.length - trend.length;
    const impulseEnergyDelta = impulse.energy - trend.energy;
    const impulseRhythmDelta = impulse.rhythm - trend.rhythm;
    const noticeableLengthImpulse = analysis.hasTrend
        && Math.abs(impulseLengthDelta) * policy.length >= 0.08;
    const noticeableEnergyImpulse = analysis.hasTrend
        && Math.abs(impulseEnergyDelta) * policy.energy >= 0.07;
    const noticeableRhythmImpulse = analysis.hasTrend
        && Math.abs(impulseRhythmDelta) * policy.rhythm >= 0.07;

    if (Math.abs(shifts.length) >= 0.045 || noticeableLengthImpulse) {
        const direction = noticeableLengthImpulse ? impulseLengthDelta : shifts.length;
        lines.push(direction < 0
            ? '回應可以比你平時稍短一些，少鋪墊，保留自然停頓。'
            : '對方此刻願意展開；如果你確實有內容，可以比平時多說一點，但不要為了匹配長度硬湊。');
    }
    if (Math.abs(shifts.rhythm) >= 0.045 || noticeableRhythmImpulse) {
        const direction = noticeableRhythmImpulse ? impulseRhythmDelta : shifts.rhythm;
        lines.push(direction > 0
            ? '跟上現在較快的來回節奏，反應可以更直接。'
            : '現在的交流節奏偏慢，允許回應從容一些，不必催著推進。');
    }
    if (Math.abs(shifts.energy) >= 0.04 || noticeableEnergyImpulse) {
        const direction = noticeableEnergyImpulse ? impulseEnergyDelta : shifts.energy;
        lines.push(direction > 0
            ? '可以接住對方此刻更高的興致或情緒能量，但強度仍以你的性格為上限。'
            : '對方此刻能量偏低，適當收住聲量，不必強行熱場。');
    }
    if (policy.punctuation >= 0.2 && shifts.punctuation > 0.06) {
        lines.push('標點力度可以輕微跟上，但不要機械複製。');
    }
    if (policy.emoji >= 0.2 && shifts.emoji > 0.06) {
        lines.push('若你本來就會使用 emoji，可以略微增加；沒有這個習慣就不要突然使用。');
    }

    const hasImpulse = analysis.hasTrend && (
        Math.abs(impulseLengthDelta) >= 0.25
        || Math.abs(impulseEnergyDelta) >= 0.25
        || Math.abs(impulseRhythmDelta) >= 0.25
    );
    // 只有產生了實際行為建議才注入。單純檢測到波動不應占用 prompt，
    // 更不能繞過角色把某個維度設為 0 的明確選擇。
    if (lines.length === 0) return '';

    const intro = hasImpulse
        ? '對方這一輪的步伐和最近幾輪有明顯變化；只在當前回應裡輕微跟上即可。'
        : '跟隨對方這一陣的交流步伐即可，不需要刻意表演。';
    return [
        '### 此刻的交流節奏',
        intro,
        ...lines,
        '這只是相處節奏的輕微調整。你的立場、關係距離、語言氣質和判斷方式仍然屬於你自己；不要復刻對方措辭，也不要把這次適應學回角色基線。',
        '',
    ].join('\n');
}
