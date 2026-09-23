/**
 * Local Context Analyzer + 預留的 Recall Resolver 協議。
 *
 * Analyzer 不調 LLM、不做檢索，只回答：當前話語在這一刻像什麼交流動作。
 * 關鍵詞只是一組加分證據，最終連續信號還會同時看長度、論元是否完整、
 * 近鄰上下文是否已有明確先行詞、整句是否自足，以及表面的互動能量。
 * 主回覆管線只消費本地分析；下方輕量 Resolver 協議暫時保留，但不在回覆前調用。
 */

import type { Message } from '../../types';
import { extractContent, extractJson, safeFetchJson } from '../safeApi';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export type RecallQueryScope = 'memory' | 'event_box';
export type RecallQuerySource = 'reference' | 'event_update' | 'continuation';

export interface RecallQuery {
    text: string;
    scope: RecallQueryScope;
    weight: number;
    /** 只用於 Trace / 調試解釋，不參與檢索排序邏輯。 */
    source?: RecallQuerySource;
}

export interface RecallPlan {
    route: boolean;
    confidence: number;
    queries: RecallQuery[];
}

export interface RecallRouterLLMConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export type RecallRouterExecutionStatus =
    | 'routed'
    | 'model_declined'
    | 'low_confidence'
    | 'invalid_response'
    | 'timeout'
    | 'error';

export interface RecallRouterExecutionResult {
    status: RecallRouterExecutionStatus;
    plan: RecallPlan;
    durationMs: number;
}

export type RecallGateReason =
    | 'no_current_user_text'
    | 'short_message'
    | 'reference_signal'
    | 'result_predicate'
    | 'missing_explicit_arguments'
    | 'recent_context_insufficient'
    | 'recent_context_sufficient'
    | 'self_contained_structure';

export interface RecallGateFeatures {
    meaningfulLength: number;
    shortMessage: boolean;
    hasReferenceSignal: boolean;
    hasResultPredicate: boolean;
    hasExplicitArgumentStructure: boolean;
    explicitAnchorCount: number;
    missingExplicitArguments: boolean;
    recentContextAnchorCount: number;
    recentContextSufficient: boolean;
    selfContained: boolean;
}

/**
 * 0..1 的結構信號快照。它們共同貢獻 Gate 分數；任何單一正則信號都沒有否決權。
 */
export interface RecallGateContributions {
    shortness: number;
    missingArguments: number;
    resultPredicate: number;
    deicticReference: number;
    explicitEntity: number;
    recentAntecedent: number;
    querySelfSufficiency: number;
}

export interface ContextSignals {
    /** 當前話語依賴剛才對話或既有事件才能成立的程度。 */
    continuationNeed: number;
    /** 當前話語存在多個可能承接對象的程度。 */
    ambiguity: number;
    /** 當前話語不借助前情也能獨立理解的程度。 */
    selfSufficiency: number;
    /** 當前話語像一次結果落地或進展更新的程度。 */
    resultUpdate: number;
    /** 當前話語是否已給出明確、可直接查找的實體。 */
    explicitEntity: number;
    /** 純表面統計：短促程度。 */
    brevity: number;
    /** 純表面統計：感嘆、重複字符、emoji 與連續氣泡共同形成的能量。 */
    energy: number;
}

export interface LocalContextAnalysis {
    analyzable: boolean;
    /** 兼容舊 Gate 調試字段；現在只表示“值得給主模型語境提示”，不再觸發副 API。 */
    shouldRoute: boolean;
    shouldGuide: boolean;
    score: number;
    reasons: RecallGateReason[];
    features: RecallGateFeatures;
    gateContributions: RecallGateContributions;
    signals: ContextSignals;
}

/** @deprecated 請使用 LocalContextAnalysis。 */
export type LocalRecallGateResult = LocalContextAnalysis;

export type RecallRouterTraceStatus =
    | 'disabled'
    | 'out_of_scope'
    | 'bypassed_explicit_entity'
    | 'no_current_user_text'
    | 'not_triggered'
    | 'gate_triggered'
    | 'unconfigured'
    | RecallRouterExecutionStatus;

export interface RecallRouterPlanTrace {
    /** 不記錄 query 原文，只記錄安全的結構信息。 */
    route: boolean;
    confidence: number;
    queryCount: number;
    scopes: RecallQueryScope[];
    sources: RecallQuerySource[];
}

export interface RecallRouterTrace {
    status: RecallRouterTraceStatus;
    gate?: LocalContextAnalysis;
    durationMs?: number;
    plan?: RecallRouterPlanTrace;
}

export const RECALL_ROUTER_TIMEOUT_MS = 1_800;
export const RECALL_ROUTER_MIN_CONFIDENCE = 0.55;
export const RECALL_GATE_ROUTE_THRESHOLD = 0.62;

const REFERENCE_SIGNAL_RE = /(?:那[个個]|[这這][个個]|那些|[这這]些|那件事|[这這]件事|之前那[个個]|之前的|[还還]是那[个個]|[这這][样樣]|那[样樣]|怎[么麼]又|果然|又[来來]|又是|\bta\b|她|他|它)/iu;
const RESULT_PREDICATE_RE = /(?:[过過]了|通[过過]了|成了|[没沒]成|成功了|失[败敗]了|好了|搞定了|[结結]束了|出[来來]了|到了|[来來]了|走了|[没沒]了|[赢贏]了|[输輸]了|批了|拒了|[录錄]取了|[挂掛]了|崩了|修好了|[办辦]好了)(?:[!！?？。…]*)$/u;
// 弱詞根只是一名“證人”：允許口語尾綴降低確定度，但絕不作為 Router 的前置門票。
const RESULT_PREDICATE_ROOT_RE = /(?:通[过過]|成功|失[败敗]|搞定|[结結]束|出[来來]|[录錄]取|修好|[办辦]好|[没沒]成|[过過]|成|[赢贏]|[输輸]|批|拒|[挂掛]|崩)/u;
const CONCRETE_ANCHOR_RE = /(?:考[试試]|成[绩績]|面[试試]|申[请請]|[审審]核|[项項]目|文件|方案|[报報]告|[论論]文|比[赛賽]|[证證][书書]|[驾駕]照|[订訂][单單]|快[递遞]|手[术術]|[检檢]查|作[业業]|任[务務]|[账賬帳][号號]|[数數][据據]|照片|[视視][频頻]|合同|工作|[学學]校|公司|[医醫]院|[课課]程|活[动動]|[会會][议議]|行程|[车車]票|[机機]票|房子|租[约約]|offer)/giu;
const QUOTED_ANCHOR_RE = /[「『《“"【]([^」』》”"】]{2,40})[」』》”"】]/gu;
const ALNUM_ANCHOR_RE = /(?:[A-Za-z][A-Za-z0-9._-]{1,30}|\d{2,}(?:[-/.年月日号號]\d{1,4})*)/gu;
const DETERMINED_NOUN_RE = /(?:[这這][个個]|那[个個]|[这這]份|那份|[这這][场場]|那[场場]|[这這]次|那次)([\p{Script=Han}]{2,6})(?=$|[，。！？、\s]|[给給]|[发發]|交|放|拿|做|改|[删刪]|[传傳]|提|[处處]|完|好|[坏壞]|成)/gu;
const EXPLICIT_ARGUMENT_RE = /(?:我|你|他|她|它|[\p{Script=Han}]{2,8})(?:今天|昨天|[刚剛]才|已[经經]|[终終][于於]|[后後][来來]|又)?把.{2,24}(?:[给給]|[发發][给給]|交[给給]|放到|拿到|提交|[处處]理|改完|[删刪]掉|[传傳][给給])/u;
const EXPLICIT_LOCATION_ACTION_RE = /(?:去|[来來]|到|在)[\p{Script=Han}]{2,10}(?:[开開][会會]|出差|上班|上[课課]|考[试試]|面[试試]|找人|[见見]面|[办辦]事|[学學][习習]|工作)/u;
const COMPETING_ANTECEDENT_RE = /(?:和|[还還]是|或者|或是|以及|、|分[别別]|[两兩][个個]|[几幾][个個])/u;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function collectExplicitAnchors(text: string): string[] {
    const anchors = new Set<string>();
    for (const match of text.matchAll(CONCRETE_ANCHOR_RE)) anchors.add(match[0].toLowerCase());
    for (const match of text.matchAll(QUOTED_ANCHOR_RE)) anchors.add(match[1].trim().toLowerCase());
    for (const match of text.matchAll(ALNUM_ANCHOR_RE)) anchors.add(match[0].toLowerCase());
    for (const match of text.matchAll(DETERMINED_NOUN_RE)) anchors.add(match[1].toLowerCase());
    return [...anchors];
}

function emptyFeatures(): RecallGateFeatures {
    return {
        meaningfulLength: 0,
        shortMessage: false,
        hasReferenceSignal: false,
        hasResultPredicate: false,
        hasExplicitArgumentStructure: false,
        explicitAnchorCount: 0,
        missingExplicitArguments: true,
        recentContextAnchorCount: 0,
        recentContextSufficient: false,
        selfContained: false,
    };
}

function emptyContributions(): RecallGateContributions {
    return {
        shortness: 0,
        missingArguments: 0,
        resultPredicate: 0,
        deicticReference: 0,
        explicitEntity: 0,
        recentAntecedent: 0,
        querySelfSufficiency: 1,
    };
}

function emptySignals(): ContextSignals {
    return {
        continuationNeed: 0,
        ambiguity: 0,
        selfSufficiency: 1,
        resultUpdate: 0,
        explicitEntity: 0,
        brevity: 0,
        energy: 0,
    };
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; context: Message[] } {
    if (messages.length === 0) return { current: [], context: [] };
    let end = messages.length - 1;
    // 允許末尾夾一兩條隱藏 system 標記，但不跨過 assistant 冒充當前 user 輪。
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], context: messages };

    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return {
        current: messages.slice(start, end + 1),
        context: messages.slice(0, start),
    };
}

/**
 * 純本地閘門。返回值不含原句，所以可以安全寫進 Recall Trace。
 */
export function analyzeLocalContext(
    messages: Message[],
    charName?: string,
    userName?: string,
    explicitEntityPresent: boolean = false,
): LocalContextAnalysis {
    const { current, context } = splitCurrentUserBurst(messages);
    const safeCurrent = sanitizeQuerySourceMessages(current, charName, userName);
    const currentText = safeCurrent.map(message => message.content.trim()).filter(Boolean).join('\n');
    if (!currentText) {
        return {
            analyzable: false,
            shouldRoute: false,
            shouldGuide: false,
            score: 0,
            reasons: ['no_current_user_text'],
            features: emptyFeatures(),
            gateContributions: emptyContributions(),
            signals: emptySignals(),
        };
    }

    const length = meaningfulLength(currentText);
    const shortMessage = length <= 12;
    const hasReferenceSignal = REFERENCE_SIGNAL_RE.test(currentText);
    const hasResultPredicate = RESULT_PREDICATE_RE.test(currentText);
    const explicitAnchors = collectExplicitAnchors(currentText);
    const hasExplicitArgumentStructure = EXPLICIT_ARGUMENT_RE.test(currentText)
        || EXPLICIT_LOCATION_ACTION_RE.test(currentText);
    const selfContained = hasExplicitArgumentStructure
        || (explicitAnchors.length > 0 && length >= 7);
    const missingExplicitArguments = !selfContained;

    const safeContext = sanitizeQuerySourceMessages(context.slice(-6), charName, userName);
    const contextText = safeContext.map(message => message.content.trim()).filter(Boolean).join('\n');
    const contextAnchors = collectExplicitAnchors(contextText);
    // 有明確對象但同時列了多個備選，仍然不足以本地消歧，應交給 Router。
    const hasCompetingAntecedents = contextAnchors.length > 1
        && COMPETING_ANTECEDENT_RE.test(contextText);
    const recentContextSufficient = contextAnchors.length > 0 && !hasCompetingAntecedents;

    const resultPredicate = hasResultPredicate
        ? 1
        : RESULT_PREDICATE_ROOT_RE.test(currentText) ? 0.45 : 0;
    const deicticReference = hasReferenceSignal ? 1 : 0;
    const explicitEntity = explicitEntityPresent ? 1 : clamp01(explicitAnchors.length);
    const recentAntecedent = recentContextSufficient
        ? 1
        : contextAnchors.length > 0 ? 0.35 : 0;

    // 極短的完整寒暄/反應通常無需檢索；一旦有承接證據，就不應用長度把它擋掉。
    const bareShortUtterance = length <= 3 && resultPredicate === 0 && deicticReference === 0;
    const querySelfSufficiency = selfContained
        ? 1
        : explicitAnchors.length > 0 ? 0.55
        : bareShortUtterance ? 0.85
        : length >= 10 ? 0.35
        : 0.15;
    const gateContributions: RecallGateContributions = {
        shortness: clamp01((18 - length) / 16),
        missingArguments: missingExplicitArguments ? 1 : 0,
        resultPredicate,
        deicticReference,
        explicitEntity,
        recentAntecedent,
        querySelfSufficiency,
    };

    // 正則只提供加分。即使沒有命中結果詞，短、缺參、低自足度的結構組合也能進入 Router。
    const score = clamp01(
        gateContributions.shortness * 0.22
        + gateContributions.missingArguments * 0.22
        + gateContributions.resultPredicate * 0.18
        + gateContributions.deicticReference * 0.18
        + (1 - gateContributions.querySelfSufficiency) * 0.16
        + (1 - gateContributions.recentAntecedent) * 0.12
        - gateContributions.explicitEntity * 0.22,
    );
    const hasStructuralNeed = gateContributions.missingArguments >= 0.7
        || gateContributions.deicticReference >= 0.35
        || gateContributions.querySelfSufficiency < 0.45;
    const shouldRoute = score >= RECALL_GATE_ROUTE_THRESHOLD
        && !recentContextSufficient
        && hasStructuralNeed;

    const punctuationCount = (currentText.match(/[!！?？]/gu) || []).length;
    const emojiCount = (currentText.match(/\p{Extended_Pictographic}/gu) || []).length;
    const hasRepeatedCharacter = /(.)\1{2,}/u.test(currentText);
    const energy = clamp01(
        punctuationCount * 0.18
        + emojiCount * 0.2
        + (hasRepeatedCharacter ? 0.28 : 0)
        + Math.max(0, current.length - 1) * 0.12
        + (resultPredicate > 0 ? 0.12 : 0),
    );
    const ambiguity = clamp01(
        gateContributions.missingArguments * 0.42
        + gateContributions.deicticReference * 0.24
        + (1 - gateContributions.querySelfSufficiency) * 0.22
        + (hasCompetingAntecedents ? 0.24 : 0)
        - gateContributions.explicitEntity * 0.35
        - gateContributions.recentAntecedent * 0.28,
    );
    const signals: ContextSignals = {
        continuationNeed: score,
        ambiguity,
        selfSufficiency: gateContributions.querySelfSufficiency,
        resultUpdate: gateContributions.resultPredicate,
        explicitEntity: gateContributions.explicitEntity,
        brevity: gateContributions.shortness,
        energy,
    };

    const reasons: RecallGateReason[] = [];
    if (shortMessage) reasons.push('short_message');
    if (hasReferenceSignal) reasons.push('reference_signal');
    if (hasResultPredicate) reasons.push('result_predicate');
    if (missingExplicitArguments) reasons.push('missing_explicit_arguments');
    if (recentContextSufficient) reasons.push('recent_context_sufficient');
    else reasons.push('recent_context_insufficient');
    if (selfContained) reasons.push('self_contained_structure');

    return {
        analyzable: true,
        shouldRoute,
        shouldGuide: shouldRoute,
        score,
        reasons,
        features: {
            meaningfulLength: length,
            shortMessage,
            hasReferenceSignal,
            hasResultPredicate,
            hasExplicitArgumentStructure,
            explicitAnchorCount: explicitAnchors.length,
            missingExplicitArguments,
            recentContextAnchorCount: contextAnchors.length,
            recentContextSufficient,
            selfContained,
        },
        gateContributions,
        signals,
    };
}

/**
 * 兼容舊調用名。Gate 已不再擁有“是否准許 LLM 工作”的權力；返回值只是本地語境分析。
 */
export function evaluateLocalRecallGate(
    messages: Message[],
    charName?: string,
    userName?: string,
): LocalContextAnalysis {
    return analyzeLocalContext(messages, charName, userName);
}

/**
 * 把本地數字翻譯成主模型能自然使用的當輪理解提示。只描述應如何讀這句話，
 * 不替模型指定具體事件，不改變角色身份、立場或語言人格。
 */
export function renderLocalContextGuidance(analysis: LocalContextAnalysis | undefined): string {
    if (!analysis?.analyzable || !analysis.shouldGuide) return '';

    const lines = [
        '### 此刻這句話怎麼接',
        '對方這輪更像是在承接剛才或既有事件，並省略了部分對象。先把它當作當前話題的後續，結合緊鄰對話和本輪已經召回的記憶理解；不要因為句子短就把它當成無關的新話題。',
    ];
    if (analysis.signals.resultUpdate >= 0.4) {
        lines.push('這也像一次結果落地或進展更新。先接住結果和對方此刻的情緒，再決定是否追問細節；不要先輸出分析報告。');
    }
    if (analysis.signals.ambiguity >= 0.5) {
        lines.push('若現有線索共同指向同一件事，可以自然接住，不必解釋檢索過程；若線索互相衝突，保留不確定或自然確認，不要擅自補成唯一答案。');
    }
    lines.push('這隻影響本輪的理解與反應順序；你的身份、立場、關係距離和慣用表達仍然屬於你自己。');
    return `${lines.join('\n')}\n\n`;
}

const VALID_SCOPES = new Set<RecallQueryScope>(['memory', 'event_box']);
const VALID_SOURCES = new Set<RecallQuerySource>(['reference', 'event_update', 'continuation']);

/**
 * 輕量模型輸出進入系統前的唯一歸一化入口。V1 明確拒絕 month scope；無有效 query
 * 時 route 會自動降為 false，避免模型只喊“要搜”卻不給可執行計劃。
 */
export function normalizeRecallPlan(value: unknown): RecallPlan {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const rawQueries = Array.isArray(source.queries) ? source.queries : [];
    const queries: RecallQuery[] = [];

    for (const item of rawQueries) {
        if (!item || typeof item !== 'object') continue;
        const query = item as Record<string, unknown>;
        const text = typeof query.text === 'string' ? query.text.trim().slice(0, 240) : '';
        const scope = query.scope as RecallQueryScope;
        if (text.length < 2 || !VALID_SCOPES.has(scope)) continue;
        const rawWeight = typeof query.weight === 'number' && Number.isFinite(query.weight)
            ? query.weight
            : 1;
        const recallQuery: RecallQuery = {
            text,
            scope,
            weight: clamp01(rawWeight),
        };
        if (VALID_SOURCES.has(query.source as RecallQuerySource)) {
            recallQuery.source = query.source as RecallQuerySource;
        }
        queries.push(recallQuery);
        if (queries.length >= 3) break;
    }

    const rawConfidence = typeof source.confidence === 'number' && Number.isFinite(source.confidence)
        ? source.confidence
        : 0;
    const route = source.route === true && queries.length > 0;
    return {
        route,
        confidence: clamp01(rawConfidence),
        queries: route ? queries : [],
    };
}

function emptyRecallPlan(): RecallPlan {
    return { route: false, confidence: 0, queries: [] };
}

function formatRouterConversation(messages: Message[], charName?: string, userName?: string): string {
    return sanitizeQuerySourceMessages(messages.slice(-8), charName, userName)
        .map(message => {
            const role = message.role === 'assistant'
                ? (charName || '角色')
                : message.role === 'user' ? (userName || '用戶') : '系統';
            return `${role}: ${message.content.trim().slice(0, 500)}`;
        })
        .filter(line => line.length > 3)
        .join('\n');
}

/**
 * 預留的輕量 Recall Resolver。它只產出額外檢索支路，不回答用戶，也不替換原始 query。
 * context-m1.4 暫不從 ChatApp 回覆管線調用；等真實失敗樣本證明舊召回不足時再啟用。
 * Chat completion 不自動重試，並由 safeFetchJson 的硬超時中止；任何失敗都由上層 fail-open。
 */
export async function runLightRecallRouter(
    messages: Message[],
    config: RecallRouterLLMConfig,
    charName?: string,
    userName?: string,
    timeoutMs: number = RECALL_ROUTER_TIMEOUT_MS,
): Promise<RecallRouterExecutionResult> {
    const startedAt = performance.now();
    const conversation = formatRouterConversation(messages, charName, userName);
    if (!conversation) {
        return { status: 'invalid_response', plan: emptyRecallPlan(), durationMs: 0 };
    }

    const systemPrompt = `你是聊天應用的記憶檢索路由器，不回答用戶，只生成額外檢索計劃。
本地閘門已認為最後一句可能缺少指代對象。請結合給出的最近對話，判斷是否能生成比原句更明確的檢索詞。

規則：
1. 不得虛構對話裡沒有依據的人名、事件名或事實。無法可靠補全時 route=false。
2. 原始用戶消息會由系統繼續檢索；這裡只補充 1-3 條更明確的 query，不要複述原句。
3. scope 只能是 memory 或 event_box。memory 查人物、事實、經歷；event_box 查持續事件或進度變化。不要輸出 month。
4. source 只能是 reference、event_update、continuation。
5. weight 與 confidence 都是 0..1。
6. 只輸出一個 JSON 對象，不要 Markdown 或解釋。

格式：
{"route":true,"confidence":0.82,"queries":[{"text":"霧港觀測員成績","scope":"event_box","weight":0.9,"source":"event_update"}]}`;

    try {
        const data = await safeFetchJson(
            `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `最近對話：\n${conversation}` },
                    ],
                    temperature: 0.1,
                    max_tokens: 320,
                    stream: false,
                }),
            },
            0,
            timeoutMs,
            { appName: 'ChatApp', purpose: '記憶召回路由' },
        );
        const parsed = extractJson(extractContent(data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                status: 'invalid_response',
                plan: emptyRecallPlan(),
                durationMs: Math.round(performance.now() - startedAt),
            };
        }
        const plan = normalizeRecallPlan(parsed);
        const status: RecallRouterExecutionStatus = !plan.route
            ? 'model_declined'
            : plan.confidence < RECALL_ROUTER_MIN_CONFIDENCE
                ? 'low_confidence'
                : 'routed';
        return {
            status,
            plan,
            durationMs: Math.round(performance.now() - startedAt),
        };
    } catch (error: any) {
        const timeout = error?.name === 'AbortError' || /abort|timeout/i.test(String(error?.message || ''));
        return {
            status: timeout ? 'timeout' : 'error',
            plan: emptyRecallPlan(),
            durationMs: Math.round(performance.now() - startedAt),
        };
    }
}

export function summarizeRecallPlan(plan: RecallPlan): RecallRouterPlanTrace {
    return {
        route: plan.route,
        confidence: plan.confidence,
        queryCount: plan.queries.length,
        scopes: [...new Set(plan.queries.map(query => query.scope))],
        sources: [...new Set(plan.queries.flatMap(query => query.source ? [query.source] : []))],
    };
}
