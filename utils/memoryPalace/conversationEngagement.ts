/**
 * M3 v2 — Conversation Engagement / Subject Tracking
 *
 * 這一層不再判斷“話有多深”，而是判斷用戶這一輪在談話裡做了什麼、當前主題
 * 是否仍在展開，以及角色本輪應該怎樣參與。所有檢測和狀態轉移都在本地完成；
 * 不調用 LLM，也不把狀態寫回角色人格。
 */

import type { Message } from '../../types';
import { analyzeExplicitEntitySignals } from './explicitEntityRecall';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export const CONVERSATION_ENGAGEMENT_VERSION = 2;
export const CONVERSATION_ENGAGEMENT_ENGINE_KEY = 'os_conversation_engagement_engine';
export const CONVERSATION_ENGAGEMENT_STORAGE_PREFIX = 'os_conversation_engagement_v2:';

const SUBJECT_STALE_MS = 12 * 60 * 60 * 1000;
const MAX_KNOWN_FACTS = 6;
const MAX_UNRESOLVED_HOOKS = 5;

export type ConversationAct =
    | 'open_disclosure'
    | 'elaborate'
    | 'update'
    | 'answer'
    | 'ask_stance'
    | 'seek_support'
    | 'joke'
    | 'status_update'
    | 'close'
    | 'shift';

export type EngagementState = 'idle' | 'opening' | 'engaged' | 'resolving' | 'closing';

export type ConversationInteractionMode =
    | 'reactive'
    | 'playful'
    | 'supportive'
    | 'exploratory'
    | 'analytical';

export type ResponseAct =
    | 'acknowledge'
    | 'invite'
    | 'follow'
    | 'clarify'
    | 'reflect'
    | 'evaluate'
    | 'close'
    | 'shift';

export type SubjectHookKind =
    | 'missing_detail'
    | 'relation_to_prior'
    | 'changed_arrangement'
    | 'causal_question'
    | 'unfinished_disclosure';

export type ConversationEngagementReason =
    | 'disclosure_opening'
    | 'open_ended_statement'
    | 'personal_load'
    | 'narrative_lead'
    | 'incomplete_proposition'
    | 'explicit_support_request'
    | 'emotional_pressure'
    | 'prior_subject_continuation'
    | 'result_update'
    | 'stance_request'
    | 'analysis_invitation'
    | 'closure_signal'
    | 'topic_shift'
    | 'assistant_question_answer'
    | 'playful_surface'
    | 'repeated_low_information_turn';

export interface GroundedConversationFact {
    /** 只在本地 subject state 中保存；Trace 和 prompt guidance 都不復制原文。 */
    text: string;
    sourceMessageIds: number[];
    confidence: number;
    status: 'stated' | 'inferred';
}

export interface SubjectHook {
    kind: SubjectHookKind;
    sourceMessageIds: number[];
    confidence: number;
}

export interface ActiveConversationSubject {
    id: string;
    label?: string;
    entities: string[];
    startedAtTurn: number;
    lastUpdatedAtTurn: number;
    openness: number;
    salience: number;
    confidence: number;
    knownFacts: GroundedConversationFact[];
    unresolvedHooks: SubjectHook[];
    lastUserAct: ConversationAct;
}

export interface ProgressiveConversationStance {
    impression?: string;
    confidence: number;
    basisMessageIds: number[];
    openAlternatives: string[];
}

export interface ResponsePlan {
    primary: ResponseAct;
    secondary?: ResponseAct;
    explicitQuestionBudget: 0 | 1;
}

/**
 * 每個角色各自持有的本地臨時談話狀態。knownFacts 只保存在用戶設備上，
 * 不進入 RecallTrace；它們有嚴格數量與長度上限，也會隨 subject 關閉而淘汰。
 */
export interface StoredConversationEngagementState {
    version: 2;
    charId: string;
    lastProcessedMessageId?: number;
    lastProcessedAt?: number;
    activeSubject?: ActiveConversationSubject;
    engagementState: EngagementState;
    interactionMode: ConversationInteractionMode;
    stance: ProgressiveConversationStance;
    lastConversationAct: ConversationAct;
    lastResponseActs: ResponseAct[];
    lastAnalysis?: ConversationEngagementAnalysis;
}

/**
 * 可安全進入 Trace / Prompt renderer 的脫敏分析。這裡只保留枚舉、分數和計數，
 * 不包含用戶原句、subject label、實體名、事實文本或 hook 文本。
 */
export interface ConversationEngagementAnalysis {
    version: 2;
    analyzable: boolean;
    shouldGuide: boolean;
    conversationAct: ConversationAct;
    secondaryActs: ConversationAct[];
    previousEngagementState: EngagementState;
    engagementState: EngagementState;
    interactionMode: ConversationInteractionMode;
    responsePlan: ResponsePlan;
    subject: {
        active: boolean;
        created: boolean;
        resumed: boolean;
        changed: boolean;
        openness: number;
        salience: number;
        confidence: number;
        knownFactCount: number;
        unresolvedHookKinds: SubjectHookKind[];
    };
    stance: {
        confidence: number;
        basisCount: number;
    };
    signals: {
        opening: number;
        continuation: number;
        supportNeed: number;
        analysisReadiness: number;
        closure: number;
        shift: number;
    };
    reasons: ConversationEngagementReason[];
}

export interface ConversationEngagementAdvanceResult {
    analysis: ConversationEngagementAnalysis;
    state: StoredConversationEngagementState;
}

interface DetectedConversationAct {
    primary: ConversationAct;
    secondary: ConversationAct[];
    reasons: ConversationEngagementReason[];
    opening: number;
    continuation: number;
    supportNeed: number;
    analysisReadiness: number;
    closure: number;
    shift: number;
    salience: number;
    incomplete: boolean;
    hasMeaningfulDetail: boolean;
    hasContradiction: boolean;
    currentText: string;
    currentMessageIds: number[];
}

const OPENING_RE = /(?:有件事|[发發]生了(?:一件|[点點])?事|出了[点點]事|有(?:[个個]|些)事|事情(?:很多|好多|有[点點]多)|好多事|之前.{0,18}(?:事|人|那[个個]).{0,10}(?:[后後][续續]|[后後][来來]|又)|有[后後][续續]|又有[后後][续續]|[刚剛](?:看到|[听聽][说說]|[发發][现現]|想到)|突然想到|不知道怎[么麼][说說]|不知(?:道)?[该該]怎[么麼][说說]|是不是我想多了|可能是我想多了|今天.{0,14}(?:奇怪|[离離][谱譜]|突然)|那[个個]人又|那[个個]事情又)/u;
const PERSONAL_LOAD_RE = /(?:我|最近|[这這][几幾]天|今天).{0,10}(?:很累|好累|有[点點]累|太累|心累|很[烦煩]|好[烦煩]|有[点點][烦煩]|[压壓]力(?:很|好|有[点點])?大|忙不[过過][来來]|喘不[过過][气氣]|[乱亂]糟糟|事情很多|事情好多)|事情(?:很多|好多|有[点點]多)/u;
const NARRATIVE_LEAD_RE = /^(?:主要是|就是|其[实實]|然[后後]|[后後][来來]|[结結]果|那[个個]|[关關][于於]|[说說]起[来來]|[对對]了|你[还還][记記]得|[还還][记記]得|之前[说說]的)/u;
const UPDATE_RE = /(?:[后後][续續]|[后後][来來]|[结結]果|[进進]展|又|再次|突然|居然|[现現]在[变變]成|改口|[换換]人|改[变變]安排|今天.{0,10}(?:叫|[说說]|通知|[决決]定))/u;
const STANCE_REQUEST_RE = /(?:你怎[么麼]看|你怎[么麼]想|你的看法|你[觉覺]得呢|你[觉覺]得|你同意[吗嗎]|如果是你|你[说說].{0,10}(?:是不是|算不算)|所以.{0,8}(?:是不是|[为為]什[么麼]|意味[着著]))/u;
const ANALYSIS_RE = /(?:[认認]真(?:聊|分析)|一起(?:想|分析)|深入(?:聊|分析)|分析一下|拆[开開]看看|想明白|可以反[驳駁]|哪[里裡]不[对對]|往深了聊|[为為]什[么麼]|原因|背[后後]|[机機]制|[逻邏][辑輯]|矛盾|不一致|意味[着著])/u;
const EXPLICIT_ANALYSIS_REQUEST_RE = /(?:[请請].{0,8}分析|[认認]真(?:聊|分析)|一起(?:想|分析)|深入(?:聊|分析)|分析一下|拆[开開]看看|可以反[驳駁]|往深了聊)/u;
const SUPPORT_RE = /(?:先[别別]分析|不想[讲講]道理|陪陪我|陪[着著]我|抱抱我|哄哄我|[听聽]我[说說]|[让讓]我哭|[现現]在只想|[别別]急[着著][给給]建[议議]|先[听聽]我[说說])/u;
const EMOTIONAL_PRESSURE_RE = /(?:很累|好累|心累|事情很多|事情好多|[压壓]力(?:很|好|有[点點])?大|好[难難]受|受不了|崩[溃潰]|[撑撐]不住|害怕|好痛苦|喘不[过過][气氣]|想哭|不知道怎[么麼][办辦]|[乱亂]得很|很[烦煩]|好[烦煩])/u;
const CLOSURE_RE = /(?:[准準][备備]睡|先睡|睡[觉覺]了|睡[觉覺]啦|晚安|先休息|改天再[说說]|以[后後]再[说說]|不想(?:[说說]|聊|想)[这這][个個]|先不(?:[说說]|聊|想)了|算了.{0,8}(?:不[说說]|不聊|不想)|到[这這](?:吧|了)|就[这這][样樣]吧|不用管(?:了|我)|[别別][问問]了|[没沒]事了|先[这這][样樣])/u;
const SHIFT_RE = /(?:[换換][个個][话話][题題]|[说說][点點][别別]的|不[说說][这這][个個]了.{0,12}(?:[给給]你看|[说說][说說])|[给給]你看|看我(?:[刚剛]|今天)|[对對]了.{0,8}(?:[还還]有|[给給]你|我[刚剛])|[话話][说說]回[来來]|[说說]起[来來].{0,8}(?:另一[个個]|[还還]有))/u;
const PLAYFUL_RE = /(?:哈哈|笑死|嘿嘿|好玩|逗你|[开開]玩笑|[乐樂]死|[绷繃]不住)/u;
const CONTRADICTION_RE = /(?:但是|可是|然而|[却卻]|反而|明明|矛盾|[说說]不通|不一致|之前.{0,24}(?:[现現]在|今天|[后後][来來])|一[边邊].{0,24}一[边邊])/u;
const INCOMPLETE_END_RE = /(?:[…….…]{2,}|(?:然[后後]|就是|主要是|那[个個]人|那[个個]事情|其[实實]|可是|但是|又))\s*$/u;
const LOW_INFORMATION_RE = /^(?:嗯+|唔+|哦+|啊+|[对對]|是|就是|然[后後]呢|[没沒][错錯]|差不多|不知道|可能吧|算是吧)[。.!！?？…]*$/u;
// 這三組只排除明顯不需要 subject tracking 的交流行為。開放陳述本身不依賴
// 情緒/事件關鍵詞：詞表負責調節參與方式，不再決定一句話“值不值得聽”。
const DIRECT_QUESTION_RE = /(?:[?？]\s*$|^(?:什[么麼]|怎[么麼]|[为為]什[么麼]|[为為]何|哪|[谁誰]|多少|[几幾][点點]|是不是|有[没沒]有|能不能|可不可以))/u;
const DIRECT_REQUEST_RE = /^(?:[请請]|麻[烦煩]|[帮幫]我|能否|可以[帮幫]我|[给給]我|替我|告[诉訴]我|解[释釋]|[写寫]一?|生成|做一?|查一下|搜索|翻[译譯])/u;
const SOCIAL_ONLY_RE = /^(?:你?好|早上好|早安|中午好|下午好|晚上好|晚安|在[吗嗎]|收到|知道了|好的?|好吧|行吧?|[谢謝][谢謝]|[谢謝]啦|拜拜|回[头頭][见見])[呀啊哦啦吧。.!！?？～~]*$/u;
const SELF_ANCHOR_RE = /(?:我|自己|咱[们們]|我[们們])/u;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; context: Message[] } {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], context: messages };
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return { current: messages.slice(start, end + 1), context: messages.slice(0, start) };
}

function previousAssistantAsked(context: Message[]): boolean {
    for (let index = context.length - 1; index >= 0; index -= 1) {
        const message = context[index];
        if (message.role === 'system') continue;
        if (message.role !== 'assistant') return false;
        return /[?？]\s*$/u.test(message.content.trim());
    }
    return false;
}

function detectConversationAct(
    messages: Message[],
    previous?: StoredConversationEngagementState,
): DetectedConversationAct {
    const { current, context } = splitCurrentUserBurst(messages);
    const currentText = current.map(message => message.content.trim()).filter(Boolean).join('\n');
    const currentMessageIds = current.map(message => message.id);
    const length = meaningfulLength(currentText);
    const hasPreviousSubject = Boolean(previous?.activeSubject)
        && previous?.engagementState !== 'idle'
        && previous?.engagementState !== 'closing';
    const closureSignal = CLOSURE_RE.test(currentText);
    const shiftSignal = SHIFT_RE.test(currentText);
    const explicitSupport = SUPPORT_RE.test(currentText);
    const emotionalPressure = EMOTIONAL_PRESSURE_RE.test(currentText);
    const analysisInvitation = ANALYSIS_RE.test(currentText);
    // “這背後的邏輯是什麼？”本身就是要求角色參與判斷，不必強制出現“你怎麼看”。
    const stanceRequest = STANCE_REQUEST_RE.test(currentText)
        || (analysisInvitation && /[?？]/u.test(currentText))
        || (!explicitSupport && EXPLICIT_ANALYSIS_REQUEST_RE.test(currentText));
    const playful = PLAYFUL_RE.test(currentText);
    const update = UPDATE_RE.test(currentText);
    const narrativeLead = NARRATIVE_LEAD_RE.test(currentText);
    const personalLoad = PERSONAL_LOAD_RE.test(currentText);
    const incomplete = INCOMPLETE_END_RE.test(currentText)
        || /(?:有件事|事情很多|事情好多|不知道怎[么麼][说說]|有[后後][续續])/u.test(currentText);
    const lowInformation = length <= 4 || LOW_INFORMATION_RE.test(currentText);
    const answeredQuestion = previousAssistantAsked(context);
    const contradiction = CONTRADICTION_RE.test(currentText);
    const explicitOpeningSignal = OPENING_RE.test(currentText) || personalLoad || incomplete;
    const directQuestion = DIRECT_QUESTION_RE.test(currentText);
    const directRequest = DIRECT_REQUEST_RE.test(currentText) && !stanceRequest && !explicitSupport;
    const socialOnly = SOCIAL_ONLY_RE.test(currentText);
    const openEndedStatement = !explicitOpeningSignal
        && !closureSignal
        && !shiftSignal
        && !directQuestion
        && !directRequest
        && !socialOnly
        && !playful
        && !lowInformation
        && (length >= 5 || SELF_ANCHOR_RE.test(currentText) || /[。！!…]\s*$/u.test(currentText));
    const openingSignal = explicitOpeningSignal || openEndedStatement;

    const reasons: ConversationEngagementReason[] = [];
    if (explicitOpeningSignal) reasons.push('disclosure_opening');
    if (openEndedStatement) reasons.push('open_ended_statement');
    if (personalLoad) reasons.push('personal_load');
    if (narrativeLead) reasons.push('narrative_lead');
    if (incomplete) reasons.push('incomplete_proposition');
    if (explicitSupport) reasons.push('explicit_support_request');
    if (emotionalPressure) reasons.push('emotional_pressure');
    if (hasPreviousSubject && !closureSignal && !shiftSignal) reasons.push('prior_subject_continuation');
    if (update) reasons.push('result_update');
    if (stanceRequest) reasons.push('stance_request');
    if (analysisInvitation) reasons.push('analysis_invitation');
    if (closureSignal) reasons.push('closure_signal');
    if (shiftSignal) reasons.push('topic_shift');
    if (answeredQuestion) reasons.push('assistant_question_answer');
    if (playful) reasons.push('playful_surface');
    if (hasPreviousSubject && lowInformation) reasons.push('repeated_low_information_turn');

    let primary: ConversationAct = 'status_update';
    const secondary: ConversationAct[] = [];
    if (shiftSignal) {
        primary = 'shift';
        if (closureSignal) secondary.push('close');
        secondary.push('open_disclosure');
    } else if (closureSignal) {
        primary = 'close';
    } else if (stanceRequest) {
        primary = 'ask_stance';
        if (hasPreviousSubject) secondary.push('elaborate');
    } else if (explicitSupport) {
        primary = 'seek_support';
        if (openingSignal || !hasPreviousSubject) secondary.push('open_disclosure');
    } else if (hasPreviousSubject) {
        primary = update ? 'update' : answeredQuestion ? 'answer' : 'elaborate';
        if (playful) secondary.push('joke');
    } else if (openingSignal || narrativeLead || update) {
        primary = update ? 'update' : 'open_disclosure';
        if (openingSignal && update) secondary.push('open_disclosure');
    } else if (playful) {
        primary = 'joke';
    } else if (answeredQuestion) {
        primary = 'answer';
    }

    const opening = closureSignal && !shiftSignal
        ? 0
        : clamp01(
            (explicitOpeningSignal ? 0.62 : openEndedStatement ? 0.48 : 0)
            + (narrativeLead ? 0.18 : 0)
            + (incomplete ? 0.2 : 0)
            + (personalLoad ? 0.18 : 0),
        );
    const continuation = clamp01(
        (hasPreviousSubject ? 0.62 : 0)
        + (narrativeLead ? 0.18 : 0)
        + (update ? 0.18 : 0)
        + (answeredQuestion ? 0.12 : 0)
        + (lowInformation && hasPreviousSubject ? 0.08 : 0),
    );
    const supportNeed = closureSignal
        ? 0
        : clamp01((explicitSupport ? 0.9 : 0) + (emotionalPressure ? 0.54 : 0) + (personalLoad ? 0.16 : 0));
    const analysisReadiness = clamp01(
        (stanceRequest ? 0.58 : 0)
        + (analysisInvitation ? 0.35 : 0)
        + (contradiction ? 0.18 : 0)
        + (hasPreviousSubject && previous!.stance.confidence >= 0.45 ? 0.1 : 0),
    );
    const closure = closureSignal ? (shiftSignal ? 0.82 : 1) : 0;
    const shift = shiftSignal ? 1 : 0;
    const salience = clamp01(
        Math.max(opening, continuation * 0.82)
        + (update ? 0.12 : 0)
        + (stanceRequest ? 0.16 : 0)
        + (emotionalPressure ? 0.1 : 0),
    );

    return {
        primary,
        secondary: unique(secondary.filter(act => act !== primary)),
        reasons: unique(reasons),
        opening,
        continuation,
        supportNeed,
        analysisReadiness,
        closure,
        shift,
        salience,
        incomplete,
        hasMeaningfulDetail: length >= 5 && !LOW_INFORMATION_RE.test(currentText),
        hasContradiction: contradiction,
        currentText,
        currentMessageIds,
    };
}

function extractSubjectLabel(text: string): string | undefined {
    const shifted = text.match(/(?:[给給]你看|[说說][点點][别別]的|[换換][个個][话話][题題])[：:，,\s]*(.{2,36})/u)?.[1];
    const led = text.match(/(?:主要是|就是|[关關][于於]|之前[说說]的|那[个個]事情|那[个個]人)[：:，,\s]*(.{2,32})/u)?.[1];
    const selected = (shifted || led || '').split(/[。！？!?\n]/u)[0]?.trim();
    if (selected) return selected.slice(0, 36);
    if (/(?:[单單]位|公司|工作|主任|[领領][导導])/u.test(text)) return '工作中正在展開的事情';
    if (/(?:朋友|同事|同[学學]|那[个個]人)/u.test(text)) return '用戶提到的那個人和相關事情';
    if (/(?:很累|事情很多|事情好多|[压壓]力)/u.test(text)) return '用戶尚未展開的近況和壓力';
    if (/(?:[规規][则則]|[逻邏][辑輯]|矛盾|分析)/u.test(text)) return '正在討論的問題';
    return undefined;
}

function createFact(detection: DetectedConversationAct): GroundedConversationFact | undefined {
    if (!detection.hasMeaningfulDetail || detection.currentMessageIds.length === 0) return undefined;
    const text = detection.currentText.replace(/\s+/gu, ' ').trim().slice(0, 240);
    if (!text) return undefined;
    return {
        text,
        sourceMessageIds: detection.currentMessageIds.slice(-4),
        confidence: 1,
        status: 'stated',
    };
}

function mergeFacts(
    existing: GroundedConversationFact[],
    next: GroundedConversationFact | undefined,
): GroundedConversationFact[] {
    if (!next) return existing.slice(-MAX_KNOWN_FACTS);
    const firstId = next.sourceMessageIds[0];
    const withoutDuplicate = existing.filter(fact => fact.sourceMessageIds[0] !== firstId);
    return [...withoutDuplicate, next].slice(-MAX_KNOWN_FACTS);
}

function updateHooks(
    existing: SubjectHook[],
    detection: DetectedConversationAct,
): SubjectHook[] {
    const additions: SubjectHook[] = [];
    const sourceMessageIds = detection.currentMessageIds.slice(-4);
    const add = (kind: SubjectHookKind, confidence: number) => additions.push({ kind, sourceMessageIds, confidence });
    if (detection.opening >= 0.5) add('missing_detail', 0.72);
    if (detection.incomplete) add('unfinished_disclosure', 0.82);
    if (detection.primary === 'update' || detection.continuation >= 0.7) add('relation_to_prior', 0.68);
    if (detection.hasContradiction) add('changed_arrangement', 0.74);
    if (detection.analysisReadiness >= 0.5) add('causal_question', 0.72);

    const merged = new Map<SubjectHookKind, SubjectHook>();
    existing.forEach(hook => merged.set(hook.kind, hook));
    additions.forEach(hook => merged.set(hook.kind, hook));
    return [...merged.values()].slice(-MAX_UNRESOLVED_HOOKS);
}

function initialState(charId: string): StoredConversationEngagementState {
    return {
        version: CONVERSATION_ENGAGEMENT_VERSION,
        charId,
        engagementState: 'idle',
        interactionMode: 'reactive',
        stance: { confidence: 0, basisMessageIds: [], openAlternatives: [] },
        lastConversationAct: 'status_update',
        lastResponseActs: [],
    };
}

function createSubject(
    charId: string,
    detection: DetectedConversationAct,
    charName?: string,
    userName?: string,
): ActiveConversationSubject {
    const startedAtTurn = detection.currentMessageIds[0] || Date.now();
    const fact = createFact(detection);
    const syntheticMessages: Message[] = detection.currentMessageIds.map<Message>((id, index) => ({
        id,
        charId,
        role: 'user',
        type: 'text',
        content: index === detection.currentMessageIds.length - 1 ? detection.currentText : '',
        timestamp: Date.now(),
    })).filter(message => Boolean(message.content));
    const entities = analyzeExplicitEntitySignals(syntheticMessages, charName, userName)
        .signals.map(signal => signal.value)
        .slice(0, 4);
    return {
        id: `${charId}:${startedAtTurn}`,
        label: extractSubjectLabel(detection.currentText),
        entities,
        startedAtTurn,
        lastUpdatedAtTurn: detection.currentMessageIds.at(-1) || startedAtTurn,
        openness: Math.max(0.62, detection.opening),
        salience: Math.max(0.58, detection.salience),
        confidence: Math.max(0.58, detection.opening, detection.continuation),
        knownFacts: fact ? [fact] : [],
        unresolvedHooks: updateHooks([], detection),
        lastUserAct: detection.primary,
    };
}

function resolveInteractionMode(
    detection: DetectedConversationAct,
    engagementState: EngagementState,
): ConversationInteractionMode {
    if (engagementState === 'closing') return 'reactive';
    if (detection.supportNeed >= 0.5) return 'supportive';
    if (detection.analysisReadiness >= 0.72) return 'analytical';
    if (detection.analysisReadiness >= 0.35 || engagementState === 'opening' || engagementState === 'engaged') {
        return detection.primary === 'joke' || detection.secondary.includes('joke') ? 'playful' : 'exploratory';
    }
    if (detection.primary === 'joke') return 'playful';
    return 'reactive';
}

function chooseResponsePlan(
    detection: DetectedConversationAct,
    engagementState: EngagementState,
    stanceConfidence: number,
    previousActs: ResponseAct[],
    hadPreviousSubject: boolean,
): ResponsePlan {
    if (detection.primary === 'shift') {
        return hadPreviousSubject
            ? { primary: 'close', secondary: 'shift', explicitQuestionBudget: 0 }
            : { primary: 'shift', explicitQuestionBudget: 0 };
    }
    if (engagementState === 'closing' || detection.primary === 'close') {
        return { primary: 'close', explicitQuestionBudget: 0 };
    }
    if (detection.primary === 'ask_stance') {
        return stanceConfidence >= 0.45
            ? { primary: 'evaluate', secondary: 'reflect', explicitQuestionBudget: 0 }
            : { primary: 'reflect', secondary: 'evaluate', explicitQuestionBudget: 0 };
    }
    if (engagementState === 'opening') {
        const repeatedInvite = previousActs.includes('invite');
        return repeatedInvite
            ? { primary: 'acknowledge', secondary: 'follow', explicitQuestionBudget: 0 }
            : { primary: 'acknowledge', secondary: 'invite', explicitQuestionBudget: 1 };
    }
    if (engagementState === 'engaged' || engagementState === 'resolving') {
        if (detection.hasContradiction || detection.primary === 'update') {
            return { primary: 'reflect', secondary: 'follow', explicitQuestionBudget: 0 };
        }
        if (!detection.hasMeaningfulDetail) {
            return { primary: 'acknowledge', secondary: 'follow', explicitQuestionBudget: 0 };
        }
        const repeatedFollow = previousActs.includes('follow');
        return repeatedFollow
            ? { primary: 'reflect', secondary: 'clarify', explicitQuestionBudget: 1 }
            : { primary: 'follow', secondary: 'reflect', explicitQuestionBudget: 0 };
    }
    return { primary: 'acknowledge', explicitQuestionBudget: 0 };
}

function advanceStance(
    previous: ProgressiveConversationStance,
    detection: DetectedConversationAct,
    facts: GroundedConversationFact[],
    subjectChanged: boolean,
): ProgressiveConversationStance {
    if (detection.primary === 'close') return previous;
    const base = subjectChanged ? 0.08 : previous.confidence;
    const confidence = clamp01(
        base
        + (detection.hasMeaningfulDetail ? 0.08 : 0)
        + (detection.primary === 'update' ? 0.1 : 0)
        + (detection.hasContradiction ? 0.12 : 0)
        + (detection.primary === 'ask_stance' ? 0.18 : 0),
    );
    return {
        impression: subjectChanged ? undefined : previous.impression,
        confidence: Math.min(0.9, confidence),
        basisMessageIds: unique(facts.flatMap(fact => fact.sourceMessageIds)).slice(-12),
        openAlternatives: subjectChanged ? [] : previous.openAlternatives.slice(0, 3),
    };
}

function makeAnalysis(input: {
    detection: DetectedConversationAct;
    previousEngagementState: EngagementState;
    engagementState: EngagementState;
    interactionMode: ConversationInteractionMode;
    responsePlan: ResponsePlan;
    subject?: ActiveConversationSubject;
    stance: ProgressiveConversationStance;
    subjectCreated: boolean;
    subjectResumed: boolean;
    subjectChanged: boolean;
    shouldGuide: boolean;
}): ConversationEngagementAnalysis {
    const { detection, subject } = input;
    return {
        version: CONVERSATION_ENGAGEMENT_VERSION,
        analyzable: Boolean(detection.currentText),
        shouldGuide: input.shouldGuide,
        conversationAct: detection.primary,
        secondaryActs: [...detection.secondary],
        previousEngagementState: input.previousEngagementState,
        engagementState: input.engagementState,
        interactionMode: input.interactionMode,
        responsePlan: { ...input.responsePlan },
        subject: {
            active: Boolean(subject),
            created: input.subjectCreated,
            resumed: input.subjectResumed,
            changed: input.subjectChanged,
            openness: subject?.openness ?? 0,
            salience: subject?.salience ?? 0,
            confidence: subject?.confidence ?? 0,
            knownFactCount: subject?.knownFacts.length ?? 0,
            unresolvedHookKinds: unique(subject?.unresolvedHooks.map(hook => hook.kind) || []),
        },
        stance: {
            confidence: input.stance.confidence,
            basisCount: input.stance.basisMessageIds.length,
        },
        signals: {
            opening: detection.opening,
            continuation: detection.continuation,
            supportNeed: detection.supportNeed,
            analysisReadiness: detection.analysisReadiness,
            closure: detection.closure,
            shift: detection.shift,
        },
        reasons: [...detection.reasons],
    };
}

export function advanceConversationEngagement(
    charId: string,
    messages: Message[],
    previousState?: StoredConversationEngagementState,
    charName?: string,
    userName?: string,
): ConversationEngagementAdvanceResult {
    const safeMessages = sanitizeQuerySourceMessages(messages, charName, userName);
    const { current } = splitCurrentUserBurst(safeMessages);
    const lastMessageId = current.at(-1)?.id;
    const storedPrevious = previousState?.version === CONVERSATION_ENGAGEMENT_VERSION
        && previousState.charId === charId
        ? previousState
        : initialState(charId);

    // charId 相同不代表仍是同一個聊天窗口。若上一輪消息已經不在當前歷史裡，
    // 說明會話被清空/替換；此時不能把舊 subject 帶進新的寒暄。
    const historyDisconnected = Boolean(storedPrevious.activeSubject)
        && storedPrevious.lastProcessedMessageId != null
        && !safeMessages.some(message => message.id === storedPrevious.lastProcessedMessageId);
    const previous = historyDisconnected ? initialState(charId) : storedPrevious;

    if (lastMessageId != null
        && previous.lastProcessedMessageId === lastMessageId
        && previous.lastAnalysis) {
        return { analysis: previous.lastAnalysis, state: previous };
    }

    const now = Date.now();
    const stale = Boolean(previous.activeSubject)
        && Boolean(previous.lastProcessedAt)
        && now - (previous.lastProcessedAt || 0) > SUBJECT_STALE_MS;
    const effectivePrevious = stale
        ? { ...initialState(charId), lastProcessedMessageId: previous.lastProcessedMessageId }
        : previous;
    const previousEngagementState = effectivePrevious.engagementState;
    const detection = detectConversationAct(safeMessages, effectivePrevious);

    if (!detection.currentText) {
        const responsePlan: ResponsePlan = { primary: 'acknowledge', explicitQuestionBudget: 0 };
        const analysis = makeAnalysis({
            detection,
            previousEngagementState,
            engagementState: previousEngagementState,
            interactionMode: effectivePrevious.interactionMode,
            responsePlan,
            subject: effectivePrevious.activeSubject,
            stance: effectivePrevious.stance,
            subjectCreated: false,
            subjectResumed: false,
            subjectChanged: false,
            shouldGuide: false,
        });
        const state = { ...effectivePrevious, lastAnalysis: analysis };
        return { analysis, state };
    }

    let subject = effectivePrevious.activeSubject;
    let engagementState: EngagementState = effectivePrevious.engagementState;
    let subjectCreated = false;
    let subjectChanged = false;
    let subjectResumed = false;

    if (detection.primary === 'shift') {
        subject = createSubject(charId, detection, charName, userName);
        engagementState = 'opening';
        subjectCreated = true;
        subjectChanged = true;
    } else if (detection.primary === 'close') {
        if (subject) {
            subject = { ...subject, openness: 0, lastUserAct: 'close' };
            engagementState = 'closing';
        } else {
            engagementState = 'idle';
        }
    } else if (effectivePrevious.engagementState === 'closing') {
        // closing 是舊 subject 的終態。下一條普通消息不能把它無條件復活；只有明確的新
        // opening/update/stance/support 才建立新 subject，舊故事的餘味不會黏到閒聊上。
        if (
            detection.primary === 'open_disclosure'
            || detection.primary === 'update'
            || detection.primary === 'ask_stance'
            || detection.primary === 'seek_support'
        ) {
            subject = createSubject(charId, detection, charName, userName);
            engagementState = detection.primary === 'ask_stance' ? 'resolving' : 'opening';
            subjectCreated = true;
            subjectChanged = true;
        } else {
            subject = undefined;
            engagementState = 'idle';
        }
    } else if (!subject && (
        detection.opening >= 0.45
        || detection.primary === 'ask_stance'
        || detection.primary === 'seek_support'
        || detection.primary === 'update'
    )) {
        subject = createSubject(charId, detection, charName, userName);
        engagementState = detection.primary === 'ask_stance' ? 'resolving' : 'opening';
        subjectCreated = true;
        subjectChanged = true;
    } else if (subject) {
        const fact = createFact(detection);
        const facts = mergeFacts(subject.knownFacts, fact);
        subject = {
            ...subject,
            label: subject.label || extractSubjectLabel(detection.currentText),
            lastUpdatedAtTurn: lastMessageId || subject.lastUpdatedAtTurn,
            openness: clamp01(subject.openness * 0.72 + Math.max(detection.opening, detection.continuation) * 0.38),
            salience: clamp01(subject.salience * 0.76 + detection.salience * 0.34),
            confidence: clamp01(subject.confidence + (detection.hasMeaningfulDetail ? 0.07 : 0.025)),
            knownFacts: facts,
            unresolvedHooks: updateHooks(subject.unresolvedHooks, detection),
            lastUserAct: detection.primary,
        };
        engagementState = detection.primary === 'ask_stance' || detection.analysisReadiness >= 0.72
            ? 'resolving'
            : 'engaged';
        subjectResumed = previousEngagementState === 'opening' || stale;
    } else {
        engagementState = 'idle';
    }

    const facts = subject?.knownFacts || [];
    const stance = subject
        ? advanceStance(effectivePrevious.stance, detection, facts, subjectChanged)
        : { confidence: 0, basisMessageIds: [], openAlternatives: [] };
    const interactionMode = resolveInteractionMode(detection, engagementState);
    const responsePlan = chooseResponsePlan(
        detection,
        engagementState,
        stance.confidence,
        effectivePrevious.lastResponseActs,
        Boolean(effectivePrevious.activeSubject) && effectivePrevious.engagementState !== 'idle',
    );
    const shouldGuide = engagementState !== 'idle'
        || detection.primary === 'shift'
        || (detection.primary === 'close' && Boolean(effectivePrevious.activeSubject));
    const analysis = makeAnalysis({
        detection,
        previousEngagementState,
        engagementState,
        interactionMode,
        responsePlan,
        subject,
        stance,
        subjectCreated,
        subjectResumed,
        subjectChanged,
        shouldGuide,
    });
    const state: StoredConversationEngagementState = {
        version: CONVERSATION_ENGAGEMENT_VERSION,
        charId,
        lastProcessedMessageId: lastMessageId,
        lastProcessedAt: now,
        activeSubject: subject,
        engagementState,
        interactionMode,
        stance,
        lastConversationAct: detection.primary,
        lastResponseActs: unique([responsePlan.primary, responsePlan.secondary].filter(Boolean) as ResponseAct[]),
        lastAnalysis: analysis,
    };
    return { analysis, state };
}

function storageKey(charId: string): string {
    return `${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}${charId}`;
}

export function loadConversationEngagementState(charId: string): StoredConversationEngagementState | undefined {
    try {
        if (typeof localStorage === 'undefined') return undefined;
        const raw = localStorage.getItem(storageKey(charId));
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as StoredConversationEngagementState;
        if (parsed?.version !== CONVERSATION_ENGAGEMENT_VERSION || parsed.charId !== charId) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

export function saveConversationEngagementState(state: StoredConversationEngagementState): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(storageKey(state.charId), JSON.stringify(state));
    } catch {
        // 狀態只是質量增強層；存儲失敗不能阻斷聊天。
    }
}

export function clearConversationEngagementState(charId: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey(charId));
    } catch {}
}

export function analyzeConversationEngagement(
    charId: string,
    messages: Message[],
    charName?: string,
    userName?: string,
): ConversationEngagementAnalysis {
    const result = advanceConversationEngagement(
        charId,
        messages,
        loadConversationEngagementState(charId),
        charName,
        userName,
    );
    saveConversationEngagementState(result.state);
    return result.analysis;
}

export function shouldUseLegacyDeepEngagement(): boolean {
    try {
        return typeof localStorage !== 'undefined'
            && localStorage.getItem(CONVERSATION_ENGAGEMENT_ENGINE_KEY) === 'legacy';
    } catch {
        return false;
    }
}

const ENGAGEMENT_LABELS: Record<EngagementState, string> = {
    idle: '現在沒有需要繼續追蹤的主題。',
    opening: '對方正在開啟一件還沒有講完的事情。',
    engaged: '對方正在繼續同一件事情；把新的補充接回已經出現的前文。',
    resolving: '這件事已經展開到可以逐步形成判斷的階段。',
    closing: '對方正在收束或結束這件事情。',
};

const RESPONSE_GUIDANCE: Record<ResponseAct, string> = {
    acknowledge: '本輪優先接住剛剛出現的信息，讓回應落在事情本身，而不是只對情緒給出一句泛化安慰。',
    invite: '隨後可以自然地給對方留下繼續說的空間。這個入口可以只是一個有所察覺的陳述，不必固定變成“發生什麼了”“然後呢”之類的問題。',
    follow: '把這輪補充接到前文同一件事上，讓對方感覺你知道事情講到了哪裡，不要重新開場。',
    clarify: '只留意一個真正關鍵的未知點。如果確實需要確認，最多問一個容易回答的問題。',
    reflect: '留意新信息與前文之間的聯繫、變化或反常之處，並自然地說出你察覺到了什麼。',
    evaluate: '回應事情本身，並給出屬於你的判斷。信息不足時保持暫定，不要為了安慰而自動站隊。',
    close: '順著對方的收束停下來，不強迫對方繼續，也不要在最後突然補上一串追問。',
    shift: '接住新的主題並切換注意力，不要把舊主題的沉重語氣機械地帶到新話題。',
};

export function renderConversationEngagementGuidance(
    analysis: ConversationEngagementAnalysis | undefined,
): string {
    const lines: string[] = [
        '### 談話參與原則',
        '對方出現負面情緒，不代表當前談話的目標是消除這種情緒。不要因為對方生氣、難過、煩躁或抱怨，就自動進入安慰、保護或勸離模式，也不要用“別想了、別管了”提前結束對方正在談論的事。',
        '',
        '先理解對方此刻想做什麼：傾訴情緒、講述事件、討論問題、尋求判斷，或只是開啟一個尚未展開的話題。**情緒是談話的一部分，不應覆蓋談話本身。**',
        '',
        '對於尚未講完的事情，跟隨信息繼續展開；不要根據關鍵詞、記憶或既有印象補全事件並提前站隊。過去的信息用於理解當前內容，而不是替代尚未出現的信息。',
        '',
        '保持自己的興趣、判斷和性格。先聽見，再瞭解，再形成看法；信息充分時可以自然表達立場。保持好奇但不要連續盤問，也不要把深入參與變成心理諮詢。',
        '',
    ];

    if (!analysis?.analyzable || !analysis.shouldGuide) {
        return lines.join('\n');
    }

    lines.push(
        '### 當前談話參與策略',
        ENGAGEMENT_LABELS[analysis.engagementState],
    );

    if (analysis.subject.active && analysis.engagementState !== 'closing') {
        lines.push('把接下來的補充當作同一件正在展開的事。你不只需要留意對方現在感覺如何，也要持續關注對方正在經歷什麼、事情本身發生了什麼。');
    }
    if (analysis.engagementState === 'opening') {
        lines.push('目前沒有明顯的結束信號。不要用“別想了”“回來就好”“一切都會過去”之類的安慰提前蓋住這件事，也不要替對方概括還沒有說清的部分。');
    }
    if (analysis.subject.unresolvedHookKinds.length > 0 && analysis.engagementState !== 'closing') {
        lines.push('有些地方你暫時還不知道答案，記住這些空缺即可，不必立刻逐個問出來。');
    }

    if (analysis.interactionMode === 'supportive') {
        lines.push('先回應對方剛剛透露出來的東西，並保留對事情本身的興趣。關心不只是表達保護、擁抱或安慰，也包括真的想知道發生了什麼。');
    } else if (analysis.interactionMode === 'playful') {
        lines.push('你可以保持輕鬆或銳評，但不要讓玩笑使你丟掉正在發生的事；仍然要接住它的新進展。');
    } else if (analysis.interactionMode === 'exploratory') {
        lines.push('保留真實的好奇，順著已經知道的內容繼續，不要急著替這件事定性。');
    } else if (analysis.interactionMode === 'analytical') {
        lines.push('對方已經邀請你形成判斷。聯繫前文已經出現的事實，認真討論事情本身，而不只是處理對方的情緒。');
    }

    lines.push(RESPONSE_GUIDANCE[analysis.responsePlan.primary]);
    if (analysis.responsePlan.secondary) {
        lines.push(RESPONSE_GUIDANCE[analysis.responsePlan.secondary]);
    }
    if (analysis.responsePlan.explicitQuestionBudget === 0) {
        lines.push('這一輪不需要用明確問句推進。可以通過承接、聯繫或判斷，自然地讓談話繼續。');
    } else {
        lines.push('如果確實需要提問，最多問一個容易回答的問題。不要連續追問，也不要把好奇變成審訊。');
    }

    if (analysis.responsePlan.primary === 'evaluate' || analysis.responsePlan.secondary === 'evaluate') {
        lines.push(analysis.stance.confidence >= 0.65
            ? '已經有多條信息可以支撐較明確的傾向，但你的判斷仍應只基於對方實際說過的事實。'
            : '信息還不完整時，不要急著替事情定性。先保留你正在形成的印象；隨著新信息出現，你可以逐漸表現出疑惑、察覺矛盾、形成傾向，最後再明確表達判斷。');
    } else if (analysis.stance.confidence < 0.45 && analysis.engagementState !== 'closing') {
        lines.push('現在的信息還不足以形成完整判斷。先聽，先連接已經出現的信息；隨著對方繼續補充，再逐漸形成你的看法。');
    }

    lines.push(
        '不要提及這些狀態、分類或策略。',
        '',
    );
    return lines.join('\n');
}
