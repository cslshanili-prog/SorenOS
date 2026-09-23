/**
 * Explicit Entity Recall — 明確實體的本地精確召回路徑。
 *
 * “你還記得霧嵐嗎”已經給出了檢索鍵，不應該再讓 embedding 猜。這裡先從當前
 * user burst 提取高置信實體，再對已經加載的 MemoryNode / EventBox 做規範化精確
 * 匹配。舊節點沒有 entities 時仍會檢查 tags/content，所以功能上線即可覆蓋舊數據。
 */

import type { Message } from '../../types';
import type { EventBox, MemoryNode, ScoredMemory } from './types';
import { sanitizeQuerySourceMessages } from './querySanitizer';
import { scriptKey } from '../scriptKey';

export type ExplicitEntitySignalSource =
    | 'remember'
    | 'named'
    | 'quoted'
    | 'domain'
    | 'leading_name';

export interface ExplicitEntitySignal {
    value: string;
    normalized: string;
    source: ExplicitEntitySignalSource;
}

export interface ExplicitEntityAnalysis {
    analyzable: boolean;
    hasSignals: boolean;
    signals: ExplicitEntitySignal[];
}

export type ExplicitEntityMatchSource =
    | 'entity_name'
    | 'entity_alias'
    | 'memory_tag'
    | 'memory_content'
    | 'event_box_name'
    | 'event_box_tag';

export interface ExplicitEntityCandidate {
    node: MemoryNode;
    matchSource: ExplicitEntityMatchSource;
    matchStrength: number;
}

export interface ExplicitEntityLookupResult {
    candidates: ExplicitEntityCandidate[];
    matchedMemoryCount: number;
    matchedEventBoxCount: number;
}

const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:com|cn|net|org|io|ai|app|dev|co|me|xyz)\b/giu;
const REMEMBER_RE = /(?:[还還]|仍然|依然|[会會])?(?:[记記]得|[认認][识識]|想得起)\s*(?:那[个個]|[这這][个個]|一[个個]|叫)?\s*([a-z0-9][a-z0-9._@-]{1,63}|[\p{Script=Han}]{2,12}?)(?=(?:[这這][个個]人|那[个個]人|[这這][个個]名字|那件事|[这這]件事)?(?:[吗嗎]|[么麼]|嘛|吧|呢|不|[?？。！!]|$))/giu;
const NAMED_RE = /(?:叫|名叫|名字叫)\s*([a-z0-9][a-z0-9._@-]{1,63}|[\p{Script=Han}]{2,10}?)(?=(?:的|[这這][个個]|那[个個]|人|朋友|同事|呢|[吗嗎]|[么麼]|[，。！？、\s]|$))/giu;
const QUOTED_RE = /[「『“"【]([^」』”"】]{2,40})[」』”"】]/gu;
const BOOK_TITLE_RE = /《([^》]{2,40})》/gu;
const LEADING_NAME_RE = /^([a-z][a-z0-9._-]{1,40}|[\p{Script=Han}]{2,8}?)(?=(?:之前|以前|[后後][来來]|是不是|有[没沒]有|怎[么麼]|又|也|呢))/iu;
const EXPLICIT_LOOKUP_CONTEXT_RE = /(?:[记記]得|[认認][识識]|想得起|叫|名字|那[个個]人|[这這][个個]人|域名|[网網]站|[账賬帳][号號]|[项項]目|作品|之前|以前)/u;

const REJECTED_ENTITY_KEYS = new Set([
    '我們', '你們', '他們', '她們', '它們', '自己', '對方', '別人',
    '這個', '那個', '這些', '那些', '這裡', '那裡', '現在', '之前', '以前',
    '朋友', '同事', '同學', '家人', '老師', '領導', '客戶', '項目', '考試', '成績',
].map(normalizeEntityKey));

/** 比對用的實體 key：簡繁歸一（記憶裡存的是用戶當時打的字，簡繁都有），不拿來顯示。 */
export function normalizeEntityKey(value: string): string {
    return scriptKey(value
        .normalize('NFKC'))
        .trim()
        .toLocaleLowerCase()
        .replace(/^[\s“”‘’「」『』【】《》"']+|[\s“”‘’「」『』【】《》"']+$/gu, '')
        .replace(/\s+/gu, '');
}

function isUsableEntity(value: string): boolean {
    const key = normalizeEntityKey(value);
    if (!key || REJECTED_ENTITY_KEYS.has(key)) return false;
    const chars = Array.from(key);
    if (chars.length < 2 || chars.length > 64) return false;
    if (/^(?:我|你|他|她|它|[这這]|那|好[烦煩])/u.test(key)) return false;
    if (/(?:我[们們]|你[们們]|他[们們]|她[们們]|它[们們]|之前|以前|[这這][个個]|那[个個])/u.test(key)) return false;
    return /[\p{L}\p{N}]/u.test(key);
}

function currentUserBurst(messages: Message[]): Message[] {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return [];
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return messages.slice(start, end + 1);
}

/** 返回值包含實體原文，只在本輪內存中用於檢索；Trace 只記錄數量和 source。 */
export function analyzeExplicitEntitySignals(
    messages: Message[],
    charName?: string,
    userName?: string,
): ExplicitEntityAnalysis {
    const safe = sanitizeQuerySourceMessages(currentUserBurst(messages), charName, userName);
    const text = safe.map(message => message.content.trim()).filter(Boolean).join('\n');
    if (!text) return { analyzable: false, hasSignals: false, signals: [] };

    const signals: ExplicitEntitySignal[] = [];
    const seen = new Set<string>();
    const participantKeys = new Set(
        [charName, userName]
            .filter((value): value is string => Boolean(value?.trim()))
            .map(normalizeEntityKey),
    );
    const add = (raw: string, source: ExplicitEntitySignalSource) => {
        const value = raw.trim();
        const normalized = normalizeEntityKey(value);
        // 角色名 / 用戶自己的名字通常遍佈整座宮殿，不是“稀有實體”檢索鍵。
        if (!isUsableEntity(value) || participantKeys.has(normalized) || seen.has(normalized)) return;
        seen.add(normalized);
        signals.push({ value, normalized, source });
    };

    for (const match of text.matchAll(DOMAIN_RE)) add(match[0], 'domain');
    for (const match of text.matchAll(REMEMBER_RE)) add(match[1], 'remember');
    for (const match of text.matchAll(NAMED_RE)) add(match[1], 'named');

    // 引號/書名號本身不一定是實體；僅在句子同時帶明確回看語境時採用。
    if (EXPLICIT_LOOKUP_CONTEXT_RE.test(text)) {
        for (const match of text.matchAll(QUOTED_RE)) add(match[1], 'quoted');
        for (const match of text.matchAll(BOOK_TITLE_RE)) add(match[1], 'quoted');
    }

    const leading = text.match(LEADING_NAME_RE);
    if (leading) add(leading[1], 'leading_name');

    return { analyzable: true, hasSignals: signals.length > 0, signals: signals.slice(0, 4) };
}

function containsExactEntity(text: string, signal: ExplicitEntitySignal): boolean {
    const raw = scriptKey(text.normalize('NFKC')).toLocaleLowerCase();
    const compact = raw.replace(/\s+/gu, '');
    const key = signal.normalized;
    if (!key) return false;

    // 中文專名和域名按完整規範化串匹配；Latin 短標識需要邊界，避免 csy 命中 abcsyx。
    if (/\p{Script=Han}/u.test(key) || /[.@_-]/u.test(key)) return compact.includes(key);
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'iu').test(raw);
}

function equalsEntity(value: string, signal: ExplicitEntitySignal): boolean {
    return normalizeEntityKey(value) === signal.normalized;
}

function representativeNode(box: EventBox, nodeMap: Map<string, MemoryNode>): MemoryNode | undefined {
    if (box.summaryNodeId) {
        const summary = nodeMap.get(box.summaryNodeId);
        if (summary && !summary.archived) return summary;
    }
    for (const id of box.liveMemoryIds) {
        const node = nodeMap.get(id);
        if (node && !node.archived) return node;
    }
    return undefined;
}

/**
 * 對本輪已經預取的本地節點做精確查找。MAX 很小是刻意的：明確實體命中負責保底，
 * 不是把所有提到過同一個常見人名的記憶一次性塞滿 prompt。
 */
export function lookupExplicitEntityCandidates(
    analysis: ExplicitEntityAnalysis,
    nodes: MemoryNode[],
    eventBoxes: EventBox[],
    maxCandidates: number = 6,
): ExplicitEntityLookupResult {
    if (!analysis.hasSignals) {
        return { candidates: [], matchedMemoryCount: 0, matchedEventBoxCount: 0 };
    }

    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    const boxMap = new Map(eventBoxes.map(box => [box.id, box]));
    const rawNodeMatches = new Map<string, ExplicitEntityCandidate>();
    const matchedBoxIds = new Set<string>();

    const record = (node: MemoryNode, matchSource: ExplicitEntityMatchSource, matchStrength: number) => {
        const existing = rawNodeMatches.get(node.id);
        if (!existing || matchStrength > existing.matchStrength) {
            rawNodeMatches.set(node.id, { node, matchSource, matchStrength });
        }
    };

    for (const node of nodes) {
        for (const signal of analysis.signals) {
            let matched = false;
            for (const entity of node.entities || []) {
                if (equalsEntity(entity.name, signal)) {
                    record(node, 'entity_name', 1);
                    matched = true;
                    break;
                }
                if ((entity.aliases || []).some(alias => equalsEntity(alias, signal))) {
                    record(node, 'entity_alias', 0.96);
                    matched = true;
                    break;
                }
            }
            if (matched) continue;
            if (node.tags.some(tag => equalsEntity(tag, signal))) {
                record(node, 'memory_tag', 0.92);
            } else if (containsExactEntity(node.content, signal)) {
                record(node, 'memory_content', 0.86);
            }
        }
    }

    const eventBoxMatches: ExplicitEntityCandidate[] = [];
    for (const box of eventBoxes) {
        for (const signal of analysis.signals) {
            let source: ExplicitEntityMatchSource | null = null;
            let strength = 0;
            if (equalsEntity(box.name, signal) || containsExactEntity(box.name, signal)) {
                source = 'event_box_name';
                strength = 0.98;
            } else if (box.tags.some(tag => equalsEntity(tag, signal))) {
                source = 'event_box_tag';
                strength = 0.93;
            }
            if (!source) continue;
            const node = representativeNode(box, nodeMap);
            if (node) {
                matchedBoxIds.add(box.id);
                eventBoxMatches.push({ node, matchSource: source, matchStrength: strength });
            }
            break;
        }
    }

    // archived 命中不能直接交給 formatter（會被過濾）；映射到所屬 EventBox 的 summary/live 代表。
    const resolved: ExplicitEntityCandidate[] = [];
    for (const hit of rawNodeMatches.values()) {
        if (!hit.node.archived) {
            resolved.push(hit);
            continue;
        }
        const box = hit.node.eventBoxId ? boxMap.get(hit.node.eventBoxId) : undefined;
        const node = box ? representativeNode(box, nodeMap) : undefined;
        if (box && node) {
            matchedBoxIds.add(box.id);
            resolved.push({ node, matchSource: hit.matchSource, matchStrength: hit.matchStrength });
        }
    }
    resolved.push(...eventBoxMatches);

    const deduped = new Map<string, ExplicitEntityCandidate>();
    for (const candidate of resolved) {
        const existing = deduped.get(candidate.node.id);
        if (!existing || candidate.matchStrength > existing.matchStrength) {
            deduped.set(candidate.node.id, candidate);
        }
    }

    const candidates = [...deduped.values()]
        .sort((a, b) => {
            if (b.matchStrength !== a.matchStrength) return b.matchStrength - a.matchStrength;
            if (b.node.importance !== a.node.importance) return b.node.importance - a.node.importance;
            return b.node.createdAt - a.node.createdAt;
        })
        .slice(0, Math.max(0, maxCandidates));

    return {
        candidates,
        matchedMemoryCount: rawNodeMatches.size,
        matchedEventBoxCount: matchedBoxIds.size,
    };
}

/** 精確命中使用獨立高分保底，剩餘 formatter quota 仍由原 hybrid recall 競爭。 */
export function mergeExplicitEntityCandidates(
    semanticResults: ScoredMemory[],
    explicitCandidates: ExplicitEntityCandidate[],
): ScoredMemory[] {
    const merged = new Map(semanticResults.map(result => [result.node.id, result]));
    explicitCandidates.forEach((candidate, index) => {
        const guaranteedScore = 1.6 - index * 0.01;
        const existing = merged.get(candidate.node.id);
        if (existing) {
            merged.set(candidate.node.id, {
                ...existing,
                finalScore: Math.max(existing.finalScore, guaranteedScore),
                roomScore: Math.max(existing.roomScore, guaranteedScore),
                recallGuarantee: 'explicit_entity',
            });
        } else {
            merged.set(candidate.node.id, {
                node: candidate.node,
                finalScore: guaranteedScore,
                similarity: 0,
                bm25Score: 0,
                roomScore: guaranteedScore,
                recallGuarantee: 'explicit_entity',
            });
        }
    });
    return [...merged.values()].sort((a, b) => b.finalScore - a.finalScore);
}
