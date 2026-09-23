/**
 * M3 — Deep Engagement / Conversation Depth
 *
 * 判斷用戶此刻是在即時反應、尋求承接，還是邀請角色一起探索和分析。
 * 這裡只輸出不含原文的連續狀態；不調用 API，也不保存對話摘錄。
 */

import type { Message } from '../../types';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export interface ConversationDepthState {
    analyticalDepth: number;
    abstraction: number;
    challengeTolerance: number;
    perspectiveBreadth: number;
    exploratoryDrive: number;
    emotionalHolding: number;
}

export type EngagementMode = 'reactive' | 'supportive' | 'exploratory' | 'analytical' | 'playful';

export interface ConversationDepthSignals {
    statedJudgment: number;
    causalInquiry: number;
    contradictionFraming: number;
    comparison: number;
    perspectiveRequest: number;
    generalization: number;
    explicitDepthInvitation: number;
    topicContinuity: number;
    emotionalOverload: number;
    comfortSeeking: number;
    surfacePlayfulness: number;
}

export interface DeepEngagementAnalysis {
    analyzable: boolean;
    shouldGuide: boolean;
    confidence: number;
    mode: EngagementMode;
    impulseDepth: number;
    trendDepth: number;
    signals: ConversationDepthSignals;
    state: ConversationDepthState;
}

const EMPTY_SIGNALS: Readonly<ConversationDepthSignals> = Object.freeze({
    statedJudgment: 0,
    causalInquiry: 0,
    contradictionFraming: 0,
    comparison: 0,
    perspectiveRequest: 0,
    generalization: 0,
    explicitDepthInvitation: 0,
    topicContinuity: 0,
    emotionalOverload: 0,
    comfortSeeking: 0,
    surfacePlayfulness: 0,
});

const EMPTY_STATE: Readonly<ConversationDepthState> = Object.freeze({
    analyticalDepth: 0,
    abstraction: 0,
    challengeTolerance: 0,
    perspectiveBreadth: 0,
    exploratoryDrive: 0,
    emotionalHolding: 0.35,
});

const STATED_JUDGMENT_RE = /(?:我[觉覺]得|我在想|我[怀懷]疑|我[倾傾]向[于於]|我的判[断斷]|在我看[来來]|我不太[认認]同|我能理解.{0,12}但)/gu;
const CAUSAL_INQUIRY_RE = /(?:[为為]什[么麼]|[为為]何|原因|[导導]致|意味[着著]|背[后後]|[机機]制|[动動][机機]|[逻邏][辑輯]|怎[么麼][会會]|如何形成)/gu;
const CONTRADICTION_RE = /(?:但是|可是|然而|[却卻]|反而|明明|矛盾|[说說]不通|不一致|既.{0,24}又|一[边邊].{0,24}一[边邊])/gu;
const COMPARISON_RE = /(?:相比|相[较較]|[区區][别別]|共同[点點]|一方面|另一方面|[与與]其|同[样樣]|不同的是)/gu;
const PERSPECTIVE_REQUEST_RE = /(?:你怎[么麼]看|你的看法|你[觉覺]得呢|你同意[吗嗎]|[还還]有[别別]的解[释釋]|[换換][个個]角度|如果是你)/gu;
const GENERALIZATION_RE = /(?:本[质質]|[规規]律|模式|往往|[这這][类類]|群[体體]|[关關][系係][结結][构構]|[权權]力|[边邊]界|[价價]值判[断斷]|道德|[规規][则則])/gu;
const EXPLICIT_DEPTH_RE = /(?:[认認]真(?:聊|分析)|一起(?:想|分析)|深入(?:聊|分析)|分析一下|拆[开開]看看|想明白|[别別][只隻]安慰|[别別]哄我|客[观觀]一[点點]|可以反[驳駁]我|哪[里裡]不[对對]|往深了聊)/gu;
const COMFORT_RE = /(?:先[别別]分析|不想[讲講]道理|陪陪我|抱抱我|哄哄我|[听聽]我[说說]|[让讓]我哭|我[现現]在只想|先接住我)/gu;
const DISTRESS_RE = /(?:好[难難]受|受不了|崩[溃潰]|[撑撐]不住|害怕|好痛苦|喘不[过過][气氣]|想哭|[呜嗚][呜嗚])/gu;
const PLAYFUL_RE = /(?:哈哈|笑死|嘿嘿|好玩|逗你|[开開]玩笑|[乐樂]死)/gu;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function density(text: string, pattern: RegExp, saturation: number = 2): number {
    return clamp01((text.match(pattern) || []).length / saturation);
}

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; context: Message[] } {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], context: messages };
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return { current: messages.slice(start, end + 1), context: messages.slice(0, start) };
}

function collectUserTurns(messages: Message[], limit: number): Message[][] {
    const turns: Message[][] = [];
    let current: Message[] = [];
    const flush = () => {
        if (current.length > 0) turns.push(current);
        current = [];
    };
    messages.slice(-160).forEach(message => {
        if (message.role === 'user') current.push(message);
        else flush();
    });
    flush();
    return turns.slice(-limit);
}

function normalizedNgrams(text: string): Set<string> {
    const chars = Array.from(text.replace(/[\s\p{P}\p{S}\d]/gu, ''));
    const grams = new Set<string>();
    for (let index = 0; index < chars.length - 1; index += 1) {
        grams.add(chars[index] + chars[index + 1]);
    }
    return grams;
}

function topicContinuity(currentText: string, previousText: string): number {
    const current = normalizedNgrams(currentText);
    const previous = normalizedNgrams(previousText);
    if (current.size < 2 || previous.size < 2) return 0;
    let overlap = 0;
    current.forEach(gram => {
        if (previous.has(gram)) overlap += 1;
    });
    return clamp01(overlap / Math.max(3, Math.min(current.size, previous.size) * 0.45));
}

function extractSignals(text: string, continuity: number = 0): ConversationDepthSignals {
    const emphaticCount = (text.match(/[!！?？]/gu) || []).length;
    const repeatedCount = (text.match(/(.)\1{2,}/gu) || []).length;
    const distress = density(text, DISTRESS_RE, 2);
    const comfortSeeking = density(text, COMFORT_RE, 1);
    const expressivePressure = clamp01(emphaticCount * 0.08 + repeatedCount * 0.2);

    return {
        statedJudgment: density(text, STATED_JUDGMENT_RE, 2),
        causalInquiry: density(text, CAUSAL_INQUIRY_RE, 2),
        contradictionFraming: density(text, CONTRADICTION_RE, 2),
        comparison: density(text, COMPARISON_RE, 2),
        perspectiveRequest: density(text, PERSPECTIVE_REQUEST_RE, 1),
        generalization: density(text, GENERALIZATION_RE, 2),
        explicitDepthInvitation: density(text, EXPLICIT_DEPTH_RE, 1),
        topicContinuity: continuity,
        emotionalOverload: clamp01(distress * 0.72 + expressivePressure * 0.38),
        comfortSeeking,
        surfacePlayfulness: density(text, PLAYFUL_RE, 2),
    };
}

function rawDepth(signals: ConversationDepthSignals, textLength: number): number {
    const structuralComplexity = clamp01((textLength - 18) / 90);
    return clamp01(
        signals.statedJudgment * 0.16
        + signals.causalInquiry * 0.2
        + signals.contradictionFraming * 0.2
        + signals.comparison * 0.13
        + signals.perspectiveRequest * 0.17
        + signals.generalization * 0.14
        + signals.explicitDepthInvitation * 0.34
        + signals.topicContinuity * 0.1
        + structuralComplexity * 0.08
        - signals.comfortSeeking * 0.5,
    );
}

function depthTrend(turns: Message[][]): number {
    if (turns.length === 0) return 0;
    let weighted = 0;
    let totalWeight = 0;
    turns.forEach((turn, index) => {
        const text = turn.map(message => message.content.trim()).filter(Boolean).join('\n');
        const weight = Math.pow(0.82, turns.length - index - 1);
        weighted += rawDepth(extractSignals(text), meaningfulLength(text)) * weight;
        totalWeight += weight;
    });
    return totalWeight > 0 ? clamp01(weighted / totalWeight) : 0;
}

function deriveMode(
    state: ConversationDepthState,
    signals: ConversationDepthSignals,
): EngagementMode {
    if (signals.comfortSeeking >= 0.6 || (signals.emotionalOverload >= 0.72 && state.analyticalDepth < 0.48)) {
        return 'supportive';
    }
    if (state.analyticalDepth >= 0.68) return 'analytical';
    if (state.analyticalDepth >= 0.42 || state.exploratoryDrive >= 0.5) return 'exploratory';
    if (signals.surfacePlayfulness >= 0.45) return 'playful';
    return 'reactive';
}

export function analyzeDeepEngagement(
    messages: Message[],
    charName?: string,
    userName?: string,
): DeepEngagementAnalysis {
    const safe = sanitizeQuerySourceMessages(messages, charName, userName);
    const { current, context } = splitCurrentUserBurst(safe);
    const currentText = current.map(message => message.content.trim()).filter(Boolean).join('\n');
    if (!currentText) {
        return {
            analyzable: false,
            shouldGuide: false,
            confidence: 0,
            mode: 'reactive',
            impulseDepth: 0,
            trendDepth: 0,
            signals: { ...EMPTY_SIGNALS },
            state: { ...EMPTY_STATE },
        };
    }

    const priorTurns = collectUserTurns(context, 10);
    const recentPriorText = priorTurns.slice(-2)
        .flat()
        .map(message => message.content.trim())
        .filter(Boolean)
        .join('\n');
    const continuity = topicContinuity(currentText, recentPriorText);
    const signals = extractSignals(currentText, continuity);
    const impulseDepth = rawDepth(signals, meaningfulLength(currentText));
    const trendDepthValue = depthTrend(priorTurns);
    // 深聊通常跨越多輪：當前邀請佔主導，但短促的承接句不能立刻把既有討論清零。
    const invitationPersistence = clamp01(impulseDepth * 0.6 + trendDepthValue * 0.4);
    const supportSuppression = clamp01(
        signals.comfortSeeking * 0.78
        + Math.max(0, signals.emotionalOverload - 0.55) * 0.45,
    );
    const analyticalDepth = clamp01(invitationPersistence * (1 - supportSuppression));
    const emotionalRoom = 1 - clamp01(signals.emotionalOverload * 0.62 + signals.comfortSeeking * 0.76);

    const state: ConversationDepthState = {
        analyticalDepth,
        abstraction: clamp01(
            analyticalDepth * 0.46
            + signals.generalization * 0.34
            + signals.causalInquiry * 0.2
            + signals.contradictionFraming * 0.14,
        ),
        challengeTolerance: clamp01(
            (analyticalDepth * 0.42
                + signals.statedJudgment * 0.2
                + signals.perspectiveRequest * 0.22
                + signals.explicitDepthInvitation * 0.28)
            * emotionalRoom,
        ),
        perspectiveBreadth: clamp01(
            analyticalDepth * 0.42
            + signals.comparison * 0.26
            + signals.contradictionFraming * 0.18
            + signals.perspectiveRequest * 0.2,
        ),
        exploratoryDrive: clamp01(
            analyticalDepth * 0.52
            + signals.causalInquiry * 0.22
            + signals.topicContinuity * 0.16
            + signals.perspectiveRequest * 0.16,
        ),
        // 深聊不是停止做人。即使在高分析狀態，也保留最低限度的情感承接。
        emotionalHolding: clamp01(
            0.32
            + signals.emotionalOverload * 0.5
            + signals.comfortSeeking * 0.55
            + Math.min(0.16, analyticalDepth * 0.2),
        ),
    };
    const mode = deriveMode(state, signals);
    const strongestEvidence = Math.max(
        signals.explicitDepthInvitation,
        signals.perspectiveRequest,
        signals.causalInquiry,
        signals.contradictionFraming,
        signals.comfortSeeking,
        signals.emotionalOverload,
    );
    const confidence = clamp01(0.2 + strongestEvidence * 0.58 + Math.max(impulseDepth, trendDepthValue) * 0.3);
    const shouldGuide = mode === 'supportive' || mode === 'exploratory' || mode === 'analytical';

    return {
        analyzable: true,
        shouldGuide,
        confidence,
        mode,
        impulseDepth,
        trendDepth: trendDepthValue,
        signals,
        state,
    };
}

/**
 * 只把連續狀態翻譯成人類可感知的交流傾向。模板不含用戶原句、具體人物或真實案例。
 */
export function renderDeepEngagementGuidance(
    analysis: DeepEngagementAnalysis | undefined,
): string {
    if (!analysis?.analyzable || !analysis.shouldGuide) return '';

    const { mode, state } = analysis;
    const lines: string[] = [];
    if (mode === 'supportive') {
        lines.push('對方此刻更需要先被聽見和接住。不要因為話題看起來復雜，就立刻把感受拆成道理或結論。');
        lines.push('可以留意對方是否隨後主動開始分析；在那之前，陪伴和理解比推進討論更重要。');
    } else {
        lines.push(state.emotionalHolding >= 0.42
            ? '先用你自己的方式接住對方真正介意的部分，再進入思考；情感承接和認真分析可以同時存在。'
            : '對方正在邀請你一起思考，直接回應其判斷和問題，不必把討論降級成泛泛安慰。');
        if (state.analyticalDepth >= 0.5) {
            lines.push('認真處理對方提出的判斷：拆解理由、前提和推論，而不只是複述或站隊。');
        }
        if (state.abstraction >= 0.48) {
            lines.push('可以從眼前事件繼續辨認背後的動機、模式或關係結構，但不要為了顯得深刻而強行上升。');
        }
        if (state.perspectiveBreadth >= 0.48) {
            lines.push('允許比較幾種不同解釋，區分它們各自能解釋什麼，不要匆忙歸結為單一原因。');
        }
        if (state.challengeTolerance >= 0.46) {
            lines.push('不要為了維護氣氛而自動贊同。如果推理裡有漏洞、矛盾或偏見，可以指出；先確認你理解了對方真正關心的問題。');
        }
        if (state.exploratoryDrive >= 0.55) {
            lines.push('沿著尚未解決的部分繼續往下想，必要時提出一個真正能推進討論的問題。');
        }
    }

    return [
        '### 此刻的交流深度',
        ...lines,
        '深度不等於篇幅，也不等於論文腔；回覆長短仍跟隨當前聊天節奏。保持你自己的知識邊界、立場、關係方式和說話習慣。你是在和對方認真聊天，不是在提交分析報告。',
        '',
    ].join('\n');
}
