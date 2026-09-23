import type { APIConfig, CharacterProfile, UserProfile } from '../../types';
import { ContextBuilder } from '../context';
import { extractContent, extractJson, safeFetchJson } from '../safeApi';
import { EventBoxDB, MemoryNodeDB } from './db';
import { getLatestRecallReceipt, type RecallReceipt } from './recallReceipts';
import type {
    EmbeddingConfig,
    EventBox,
    MemoryNode,
    RemoteVectorConfig,
} from './types';
import { updateStoredMemoryNode } from './vectorStore';
import { formatMemoryDateWithDistance } from './memoryDate';

export type RepairNodeKind = 'summary' | 'live' | 'archived' | 'standalone';

export interface RepairNode {
    node: MemoryNode;
    kind: RepairNodeKind;
    recalled: boolean;
}

export interface RepairEventBox {
    box: EventBox;
    nodes: RepairNode[];
    recalledNodeIds: string[];
}

export interface RecallRepairSnapshot {
    receipt: RecallReceipt | null;
    standalone: RepairNode[];
    boxes: RepairEventBox[];
}

export interface MemoryRepairDiagnosis {
    reply: string;
    suspectIds: string[];
    reasons: Record<string, string>;
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function repairNodeKind(node: MemoryNode): RepairNodeKind {
    if (node.isBoxSummary) return 'summary';
    if (node.archived) return 'archived';
    if (node.eventBoxId) return 'live';
    return 'standalone';
}

function compactSearchText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isLooseSubsequence(needle: string, haystack: string): boolean {
    if (!needle) return true;
    let cursor = 0;
    for (const char of haystack) {
        if (char === needle[cursor]) cursor += 1;
        if (cursor === needle.length) return true;
    }
    return false;
}

function searchableMemoryText(node: MemoryNode): string {
    const date = new Date(node.createdAt);
    const numericDate = Number.isNaN(date.getTime())
        ? ''
        : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return [
        node.content,
        node.tags.join(' '),
        node.mood,
        node.room,
        numericDate,
        formatRepairMemoryDate(node.createdAt),
    ].join(' ');
}

/**
 * 用戶主動修補時的本地模糊搜索。
 * 支持多關鍵詞、不完整連續片段和有序缺字匹配；不調用向量或模型 API。
 */
export function filterEditableMemoryNodes(
    nodes: MemoryNode[],
    query: string,
    recalledIds: Iterable<string> = [],
    limit: number = 30,
): RepairNode[] {
    const terms = query
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .trim()
        .split(/\s+/u)
        .map(compactSearchText)
        .filter(Boolean);
    if (terms.length === 0) return [];

    const recalled = new Set(recalledIds);
    return nodes
        .map(node => {
            const haystack = compactSearchText(searchableMemoryText(node));
            let score = 0;
            for (const term of terms) {
                if (haystack.includes(term)) {
                    score += 20 + Math.min(term.length, 12);
                } else if (term.length >= 2 && isLooseSubsequence(term, haystack)) {
                    score += 6;
                } else {
                    return null;
                }
            }
            return { node, score };
        })
        .filter((item): item is { node: MemoryNode; score: number } => item !== null)
        .sort((a, b) =>
            b.score - a.score
            || b.node.importance - a.node.importance
            || b.node.createdAt - a.node.createdAt
        )
        .slice(0, limit)
        .map(({ node }) => ({
            node,
            kind: repairNodeKind(node),
            recalled: recalled.has(node.id),
        }));
}

export async function searchEditableMemories(
    charId: string,
    query: string,
    recalledIds: Iterable<string> = [],
    limit: number = 30,
): Promise<RepairNode[]> {
    const nodes = await MemoryNodeDB.getByCharId(charId);
    return filterEditableMemoryNodes(nodes, query, recalledIds, limit);
}

/** MemoryNode 當前只可靠保存到“日”；12:00 常是日期佔位，不能偽裝成精確時分。 */
export function formatRepairMemoryDate(createdAt: number, now: number = Date.now()): string {
    return formatMemoryDateWithDistance(createdAt, now);
}

/**
 * 將“本輪實際召回”還原成可編輯現場。
 * 命中事件盒任一成員時，編輯器會額外裝載摘要、所有活節點與所有歸檔節點。
 */
export async function loadRecallRepairSnapshot(
    charId: string,
    sinceTs: number,
): Promise<RecallRepairSnapshot> {
    const receipt = getLatestRecallReceipt(charId, sinceTs);
    if (!receipt) return { receipt: null, standalone: [], boxes: [] };

    const [allBoxes, recalledNodes] = await Promise.all([
        EventBoxDB.getByCharId(charId),
        Promise.all(receipt.ids.map(id => MemoryNodeDB.getById(id))),
    ]);
    const boxesById = new Map(allBoxes.map(box => [box.id, box]));
    const nodeToBox = new Map<string, EventBox>();
    for (const box of allBoxes) {
        const ids = unique([
            ...(box.summaryNodeId ? [box.summaryNodeId] : []),
            ...box.liveMemoryIds,
            ...box.archivedMemoryIds,
        ]);
        ids.forEach(id => nodeToBox.set(id, box));
    }

    const recalledIds = new Set(receipt.ids);
    const hitBoxIds = new Set<string>();
    const standalone: RepairNode[] = [];
    for (const node of recalledNodes) {
        if (!node || node.charId !== charId) continue;
        const box = (node.eventBoxId && boxesById.get(node.eventBoxId))
            || nodeToBox.get(node.id);
        if (box) {
            hitBoxIds.add(box.id);
        } else {
            standalone.push({ node, kind: 'standalone', recalled: true });
        }
    }

    const boxes: RepairEventBox[] = [];
    for (const boxId of hitBoxIds) {
        const box = boxesById.get(boxId);
        if (!box) continue;
        const orderedIds = unique([
            ...(box.summaryNodeId ? [box.summaryNodeId] : []),
            ...box.liveMemoryIds,
            ...box.archivedMemoryIds,
        ]);
        const loaded = await Promise.all(orderedIds.map(id => MemoryNodeDB.getById(id)));
        const nodes: RepairNode[] = [];
        loaded.forEach((node, index) => {
            if (!node || node.charId !== charId) return;
            const id = orderedIds[index];
            const kind: RepairNodeKind = id === box.summaryNodeId
                ? 'summary'
                : box.archivedMemoryIds.includes(id)
                    ? 'archived'
                    : 'live';
            nodes.push({ node, kind, recalled: recalledIds.has(id) });
        });
        // 摘要固定在首位；其餘活躍/歸檔子節點按事件日期排成可核對的時間線。
        nodes.sort((a, b) => {
            if (a.kind === 'summary') return b.kind === 'summary' ? 0 : -1;
            if (b.kind === 'summary') return 1;
            return a.node.createdAt - b.node.createdAt;
        });
        boxes.push({
            box,
            nodes,
            recalledNodeIds: nodes.filter(item => item.recalled).map(item => item.node.id),
        });
    }

    return { receipt, standalone, boxes };
}

/**
 * 診斷上下文只保留角色身份與說話方式。
 * 按產品約定明確調用 buildCoreContext(..., false)，同時抹掉所有持久記憶、
 * 召回注入、房間門牌和情緒注入，確保不會暗中再讀一次記憶上下文。
 */
export function buildMemoryRepairCoreContext(
    char: CharacterProfile,
    user: UserProfile,
): string {
    const memoryIsolatedChar: CharacterProfile = {
        ...char,
        memories: [],
        refinedMemories: {},
        activeMemoryMonths: [],
        memoryPalaceEnabled: false,
        memoryPalaceInjection: undefined,
        roomPlatesInjection: undefined,
        buffInjection: undefined,
        activeBuffs: [],
    };
    return ContextBuilder.buildCoreContext(memoryIsolatedChar, user, false);
}

function snapshotCandidates(snapshot: RecallRepairSnapshot): Array<{
    id: string;
    scope: string;
    date: string;
    content: string;
}> {
    const candidates = snapshot.standalone.map(item => ({
        id: item.node.id,
        scope: '獨立記憶（本輪召回）',
        date: formatRepairMemoryDate(item.node.createdAt),
        content: item.node.content,
    }));
    snapshot.boxes.forEach(group => {
        group.nodes.forEach(item => {
            const stateLabel = item.kind === 'archived'
                ? '（已歸檔，本輪未注入，僅供核對）'
                : item.recalled ? '（本輪經過）' : '（同盒展開，本輪未直接注入）';
            candidates.push({
                id: item.node.id,
                scope: `事件盒「${group.box.name}」/${item.kind === 'summary' ? '盒摘要' : item.kind === 'archived' ? '歸檔子節點' : '活躍子節點'}${stateLabel}`,
                date: formatRepairMemoryDate(item.node.createdAt),
                content: item.node.content,
            });
        });
    });
    return candidates;
}

/** 即使模型偶爾沿用分析術語，也把面向人的稱呼收回到具體關係裡。 */
export function naturalizeMemoryRepairLanguage(
    text: string,
    charName: string,
    userName: string,
): string {
    const you = userName.trim() || '你';
    const character = charName.trim() || '對方';
    return text
        .replace(/[这這]位用[户戶]|[该該]用[户戶]|用[户戶]/g, you)
        .replace(/[这這][个個]角色|[该該]角色|角色本人|角色/g, character);
}

/**
 * “？？？”的分析只接收顯式傳入的現場候選，不執行向量召回。
 */
export async function diagnoseRecallIssue(params: {
    char: CharacterProfile;
    user: UserProfile;
    apiConfig: APIConfig;
    snapshot: RecallRepairSnapshot;
    userConcern: string;
    userMessage?: string;
    assistantReply?: string;
}): Promise<MemoryRepairDiagnosis> {
    const { apiConfig, snapshot } = params;
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
        throw new Error('請先配置可用的主 API');
    }
    const candidates = snapshotCandidates(snapshot);
    if (candidates.length === 0) {
        return {
            reply: '這一輪沒有記憶從這裡經過。我不能假裝看見不存在的線索。',
            suspectIds: [],
            reasons: {},
        };
    }

    const coreContext = buildMemoryRepairCoreContext(params.char, params.user);
    const charName = params.char.name || '對方';
    const userName = params.user.name || '你';
    const candidateText = candidates
        .map((item, index) => `[${index + 1}] id=${item.id}\n位置=${item.scope}\n日期=${item.date}\n內容=${item.content}`)
        .join('\n\n');
    const system = `${coreContext}

你現在不是 ${charName} 本人，而是 ${charName} 記憶小屋門口一個名為“？？？”的安靜引路者。
你的身份雖然是“？？？”，但說話的節奏、句式、用詞和情緒濃度必須貼近上方 ${charName} 的語言風格；不要改成客服、醫生或系統報告口吻，也不要聲稱自己就是 ${charName}。
稱呼必須自然具體：
- 面向 ${userName} 時只用“你”或“${userName}”，絕不能把對方稱為“用戶”。
- 提到 ${charName} 時直接說“${charName}”，絕不能說“角色”“角色本人”或用含糊的“TA”替代名字。
- 涉及多個人時使用具體名字；確實指一個群體時才用“他們”。
任務僅限於檢查下方明確提供的“本輪召回現場”。不得調用、猜測或補充任何其他記憶，不得替 ${charName} 辯解。
根據 ${userName} 指出的問題，找出可能讓剛才回覆產生事實錯誤、對象混淆、時間錯位或過度推斷的候選記憶。
事件盒中未在本輪直接注入、但為了修補而展開的節點，可以作為盒內矛盾線索；歸檔子節點已經不再注入，提到它時必須明確說“已歸檔，本輪沒有注入”。
回答要簡短、溫和、具體，不替 ${userName} 直接篡改內容。

只輸出 JSON：
{
  "reply": "給用戶的判斷與下一步建議",
  "suspectIds": ["候選中的原始 id"],
  "reasons": { "候選 id": "為什麼可能有影響" }
}`;

    const userPrompt = `【${userName}剛才說的話】
${params.userMessage || '（未取得）'}

【${charName}剛才的回覆】
${params.assistantReply || '（未取得）'}

【${userName}覺得不對勁的地方】
${params.userConcern.trim()}

【本輪召回現場】
${candidateText}`;

    const data = await safeFetchJson(
        `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiConfig.apiKey}`,
            },
            body: JSON.stringify({
                model: apiConfig.model,
                temperature: 0.2,
                stream: false,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: userPrompt },
                ],
            }),
        },
        1,
        90_000,
        { appId: 'chat', charId: params.char.id, purpose: 'memory-repair-diagnosis' },
    );
    const raw = extractContent(data);
    const parsed = extractJson(raw);
    const allowed = new Set(candidates.map(item => item.id));
    const suspectIds: string[] = Array.isArray(parsed?.suspectIds)
        ? unique<string>((parsed.suspectIds as unknown[]).filter(
            (id: unknown): id is string => typeof id === 'string' && allowed.has(id),
        ))
        : [];
    const reasons: Record<string, string> = {};
    if (parsed?.reasons && typeof parsed.reasons === 'object') {
        suspectIds.forEach(id => {
            if (typeof parsed.reasons[id] === 'string') {
                reasons[id] = naturalizeMemoryRepairLanguage(
                    parsed.reasons[id],
                    charName,
                    userName,
                );
            }
        });
    }
    return {
        reply: typeof parsed?.reply === 'string' && parsed.reply.trim()
            ? naturalizeMemoryRepairLanguage(parsed.reply.trim(), charName, userName)
            : raw
                ? naturalizeMemoryRepairLanguage(raw, charName, userName)
                : '我看過這些痕跡了。你可以從標出的記憶開始核對。',
        suspectIds,
        reasons,
    };
}

export async function patchRecallMemory(
    nodeId: string,
    content: string,
    embeddingConfig: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<MemoryNode> {
    const nextContent = content.trim();
    if (!nextContent) throw new Error('記憶內容不能為空');
    const result = await updateStoredMemoryNode(
        nodeId,
        { content: nextContent },
        embeddingConfig,
        remoteVectorConfig,
    );
    return result.node;
}

export interface MemoryGuideCopy {
    greeting: string;
    trail: string;
    empty: string;
}

const GUIDE_COPY: Record<NonNullable<CharacterProfile['personalityStyle']>, MemoryGuideCopy[]> = {
    emotional: [
        { greeting: '你來啦，{user}。先別急，我把剛才碰過的東西都留在這裡了。', trail: '剛才這裡經過了這些記憶……', empty: '這裡很安靜。剛才那一輪，沒有記憶從門前經過。' },
        { greeting: '我等到你了，{user}。如果剛才有哪裡刺痛了你，我們一起把它看清。', trail: '看，它們正在一點點顯出來……', empty: '沒有留下召回的腳印。問題也許不在記憶裡。' },
    ],
    narrative: [
        { greeting: '你來啦，{user}。剛才那句話離開以後，幾頁紙落在了門邊。', trail: '它們曾這樣經過這裡……', empty: '這一頁是空的：剛才沒有召回記錄經過。' },
        { greeting: '門剛好還沒關，{user}。來看看剛才那段話從哪裡走過。', trail: '沿著微光，記憶正在依次出現……', empty: '路上沒有記憶的痕跡，這次要去別處找原因。' },
    ],
    imagery: [
        { greeting: '你來啦，{user}。霧裡還浮著剛才留下的微光。', trail: '剛才這裡經過了這些記憶……', empty: '光點沒有分岔。剛才沒有任何記憶被帶進回覆。' },
        { greeting: '噓，{user}。那些被碰過的記憶還沒完全沉下去。', trail: '等一等，它們會從暗處慢慢亮起來……', empty: '今晚沒有記憶亮起。這裡沒有可修補的召回痕跡。' },
    ],
    analytical: [
        { greeting: '你來啦，{user}。本輪召回現場已經封存，我們逐條核對。', trail: '以下是剛才實際經過的記憶，以及命中事件盒的完整結構。', empty: '核對完成：本輪沒有記憶注入記錄。' },
        { greeting: '正好，{user}。剛才的回覆和召回記錄都還在可比對範圍內。', trail: '召回痕跡正在展開，請從事實、對象和時間三個方向檢查。', empty: '沒有召回項。剛才的問題不應歸因於向量記憶。' },
    ],
};

export function getMemoryGuideCopy(
    char: CharacterProfile,
    userName: string,
): MemoryGuideCopy {
    const style = char.personalityStyle || 'emotional';
    const variants = GUIDE_COPY[style];
    const seed = [...`${char.id}:${char.name}`].reduce((sum, value) => sum + value.charCodeAt(0), 0);
    const selected = variants[seed % variants.length];
    return {
        greeting: selected.greeting.replace('{user}', userName || '你'),
        trail: selected.trail,
        empty: selected.empty,
    };
}
