import { loadCharacterContextMessages } from './chatContextRange';
import { APIConfig, CharacterProfile, Message, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { safeFetchJson } from './safeApi';
import { parseQixiJsonObject } from './qixiJson';
import { parseQixiBridge, type QixiBridgeBundle } from './qixiBridge';

export const QIXI_MEMORY_BUNDLE_VERSION = 19 as const;
export const QIXI_MEMORY_BUNDLE_PREFIX = 'sullyos_qixi_memory_bundle_v19_';
export const QIXI_RECALL_MAX_OUTPUT_ITEMS = 20;
export const QIXI_PART1_TIMEOUT_MS = 600_000;
export const QIXI_PART1_FIRST_SCENE_IDS = ['lostLayer', 'doubleWish'] as const;
export const QIXI_PART1_SECOND_SCENE_IDS = ['threadNeedle', 'offerings', 'reflection'] as const;
export const QIXI_PART1_THIRD_SCENE_IDS = ['nightMarket', 'wordCloud'] as const;

export const QIXI_USER_LAYER_COLORS = [
    { value: '#F0A6C2', label: '薔薇' },
    { value: '#F2B36F', label: '琥珀' },
    { value: '#E99078', label: '珊瑚' },
    { value: '#B8A1F2', label: '鳶尾' },
    { value: '#76CFC5', label: '潮汐' },
    { value: '#A8D17B', label: '新葉' },
    { value: '#7FA9E8', label: '遠空' },
    { value: '#C590E8', label: '紫藤' },
    { value: '#F5F1EA', label: '月白' },
    { value: '#25222C', label: '墨黑' },
] as const;

const QIXI_CHAR_LAYER_COLORS = [
    { value: '#8FC8FF', label: '天青' },
    { value: '#D6A6F2', label: '藤紫' },
    { value: '#F0B66F', label: '燈火' },
    { value: '#82D5B8', label: '薄荷' },
    { value: '#F19A8F', label: '石榴' },
    { value: '#C5D477', label: '青檸' },
    { value: '#E9B4D1', label: '晚櫻' },
    { value: '#9FB4F2', label: '暮藍' },
] as const;

export const QIXI_DEFAULT_USER_LAYER_COLOR = QIXI_USER_LAYER_COLORS[0].value;
export const QIXI_FALLBACK_CHAR_LAYER_COLOR = QIXI_CHAR_LAYER_COLORS[1].value;

export const QIXI_SCENE_IDS = [
    'lostLayer',
    'doubleWish',
    'threadNeedle',
    'offerings',
    'reflection',
    'nightMarket',
    'wordCloud',
] as const;

export type QixiSceneId = typeof QIXI_SCENE_IDS[number];

export interface QixiMemoryEvidence {
    id: string;
    fact: string;
    object: string;
    tags: string[];
}

export type QixiArtifactKind = 'object' | 'phrase' | 'nickname' | 'topic' | 'date' | 'emotion' | 'wish' | 'symbol' | 'trait';
export type QixiCharTempo = 'brisk' | 'measured' | 'hesitant' | 'playful';
export type QixiCharMarkStyle = 'precise' | 'soft' | 'scribbled' | 'ornate';
export type QixiCharPresence = 'direct' | 'careful' | 'teasing' | 'quiet';

export interface QixiCharPerformance {
    tempo: QixiCharTempo;
    markStyle: QixiCharMarkStyle;
    presence: QixiCharPresence;
}

export interface QixiMemoryArtifact {
    id: string;
    label: string;
    kind: QixiArtifactKind;
    evidenceIds: string[];
}

export interface QixiSceneOption {
    id: string;
    label: string;
    result: string;
    /** Lost-layer only: Char's actual reply to this exact User topic after clearing the errors. */
    charReply?: string;
    evidenceIds: string[];
}

export interface QixiScenePayload {
    /** Part 1 generated interstitial copy shown before entering this room. */
    transitionLines?: string[];
    sharedObject: string;
    memoryLine: string;
    options: QixiSceneOption[];
    charAction: string;
    /** The exact short words/mark that visibly appears on the shared object. */
    charVisibleText?: string;
    /** In-character remarks shown inside the shared visual object. */
    charQuips?: string[];
    /** Lost-layer only: Char's hurried mutter while forcing the failed message back through. */
    charMutter?: string;
    /** Offerings: Char's private item. Night market: the separate thing Char secretly buys for themself. */
    charContribution?: string;
    reveal: string;
    artifactIds: string[];
    charSelectionIds: string[];
}

export const qixiTransitionLines = (_sceneId: QixiSceneId, scene: QixiScenePayload): string[] =>
    scene.transitionLines || [];

export const qixiCharVisibleText = (_sceneId: QixiSceneId, scene: QixiScenePayload): string =>
    scene.charVisibleText?.trim() || '';

export const qixiCharMutter = (scene: QixiScenePayload): string =>
    scene.charMutter?.trim() || '';

export const qixiCharQuips = (_sceneId: QixiSceneId, scene: QixiScenePayload): string[] =>
    scene.charQuips || [];

export interface QixiMemoryBundle {
    version: typeof QIXI_MEMORY_BUNDLE_VERSION;
    source: 'memory' | 'fallback';
    openingChat: string[];
    charLayerColor: string;
    charPerformance: QixiCharPerformance;
    evidence: QixiMemoryEvidence[];
    artifacts: QixiMemoryArtifact[];
    scenes: Record<QixiSceneId, QixiScenePayload>;
    /** Generated with rooms 05–07 in the same Part 1b response; never needs a separate API call. */
    bridge?: QixiBridgeBundle;
    personalizedSceneIds: QixiSceneId[];
    /** Non-fatal field-level repairs applied after schema parsing. */
    repairNotes?: string[];
    generatedAt: number;
    contextSignature: string;
}

export interface QixiMemoryPreparation {
    bundle: QixiMemoryBundle;
    usedFallback: boolean;
    reason?: string;
}

export type QixiMemoryGenerationPhase = 'first' | 'second' | 'third';

const SCENE_BRIEFS: Record<QixiSceneId, string> = {
    lostLayer: '01 被動痕跡：從不同真實 evidence 各提煉一個 User 此刻想和 Char 繼續聊的具體話題。User 選中後發送失敗，API 報錯、超時、限流與措辭過軟的道歉彈窗迅速鋪滿空間；Char 從另一層衝回來強制劃掉、撕碎或踢走所有紅框。User 選中的話題必須原樣留在發送框裡，絕不能成為 Char 攻擊、改寫或搶救的對象。清障時由 charMutter 與兩句 charQuips 漏出周圍碎碎念；清障後必須用該 option.charReply 真正回應 User 選中的具體話題，表示 ta 突破阻礙把回覆送了回來。reveal 只讓 User 確定異常裡存在另一個人的操作，不能說是誰，也不能提前總結熟悉感。',
    doubleWish: '02 異步共用：User 在祈願箋正面選擇一個關於兩個人未來的願望；Char 在另一層寫下自己關於“正在尋找的重要之人”的願望，卻不知道紙張正面的操作者就是那個人，並在紙角漏出一句自言自語。如果記憶召回裡存在記憶宮殿“窗台房間 / Window Sill”的未來願望，可以優先提煉，但不得把願望寫成已經發生的共同經歷。通過翻面、搶紙、未乾墨跡或位置衝突，讓 User 發現雙方正在異步使用同一張紙。',
    threadNeedle: '03 主動協作：雙方必須配合才能完成穿針，Char 的操作要直接回應 User 的策略；允許搶錯針線、拉得太快或第一次配合失敗。reveal 只推進到雙方能主動協作。',
    offerings: '04 互相判斷：User 先從三個具體選項裡放下屬於自己的東西；隨後另一層必須另外擺上一件屬於 Char 自己、對 Char 本人有私人意義的【私物】，並用 charContribution 明確寫出這件東西是什麼，不能只挪動、搶走或評價 User 的供物。Char 的私物不要求與 User 或共同記憶有關，也不默認是送給 User 的禮物；即使完全與 User 無關也成立，重點是它像 Char 會擁有、使用、隨身攜帶或珍藏的東西。允許雙方位置衝突、交換或挪動，但畫面順序必須能讀成“User 的東西先出現 → Char 自己的私物從另一邊出現 → Char 吐槽”。私人性落在雙方各自選了什麼和如何擺放，不讓旁白替玩家解釋。',
    reflection: '05 近實時交流：User 留下可被修改的符號、短句或痕跡，Char 立刻接續、劃掉、改寫或故意曲解，使這一站第一次接近真正的隔層對話。',
    nightMarket: '06 雙向逛市集：攤位出售由真實 evidence 變形而來的具體夢境商品。User 先從三個具體商品中挑一個；隨後 Char 也挑一件“感覺另一邊某人也許會喜歡”的商品作為試探，但仍不能確定對面身份。最後 Char 必須另外偷偷買一件純粹自己想要、符合自身愛好或當下心情的東西，並用 charContribution 明確寫出自己的購買物。Char 自購品不要求與 User 有關，不能默認寫成吃醋、佔有慾、情敵或爭搶關係戲。',
    wordCloud: '07 幾乎認出：不再尋找新證據。提供 12—20 個有角色設定或真實上下文依據的性格、氣質、處事方式短詞；User 與 Char 嚴格交替各選三次眼中的對方並即時吐槽。第三輪後雙方都可以強烈懷疑“另一邊就是那個人”，但由於仍未真正見面，不能在 Part 1 明說已經確認；最終見面才完成答案揭露。',
};

const compact = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
};

const normalizeCharLayerColor = (value: unknown): string => {
    const requested = compact(value, 7).toUpperCase();
    return QIXI_CHAR_LAYER_COLORS.find(color => color.value === requested)?.value
        || QIXI_FALLBACK_CHAR_LAYER_COLOR;
};

const normalizeCharPerformance = (value: any): QixiCharPerformance => {
    const tempo = compact(value?.tempo, 16) as QixiCharTempo;
    const markStyle = compact(value?.markStyle, 16) as QixiCharMarkStyle;
    const presence = compact(value?.presence, 16) as QixiCharPresence;
    return {
        tempo: (['brisk', 'measured', 'hesitant', 'playful'] as string[]).includes(tempo) ? tempo : 'measured',
        markStyle: (['precise', 'soft', 'scribbled', 'ornate'] as string[]).includes(markStyle) ? markStyle : 'soft',
        presence: (['direct', 'careful', 'teasing', 'quiet'] as string[]).includes(presence) ? presence : 'careful',
    };
};

const simpleHash = (value: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
};

export function createQixiFallbackBundle(contextSignature = '', charLayerColor = QIXI_FALLBACK_CHAR_LAYER_COLOR): QixiMemoryBundle {
    const emptyScenes = Object.fromEntries(QIXI_SCENE_IDS.map(sceneId => [sceneId, {
        transitionLines: [],
        sharedObject: '',
        memoryLine: '',
        options: [],
        charAction: '',
        reveal: '',
        artifactIds: [],
        charSelectionIds: [],
    }])) as Record<QixiSceneId, QixiScenePayload>;
    return {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'fallback',
        openingChat: [],
        charLayerColor: normalizeCharLayerColor(charLayerColor),
        charPerformance: normalizeCharPerformance(null),
        evidence: [],
        artifacts: [],
        scenes: emptyScenes,
        personalizedSceneIds: [],
        generatedAt: Date.now(),
        contextSignature,
    };
}

const directText = (value: unknown): string => typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').trim()
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';

const directList = (value: unknown): any[] => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
    if (typeof value !== 'string') return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (/^[\[{]/.test(trimmed)) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === 'object') return Object.values(parsed);
        } catch { /* keep the model's plain text below */ }
    }
    return trimmed.split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim()).filter(Boolean);
};

const directStringList = (value: unknown): string[] => directList(value)
    .map(item => directText(item && typeof item === 'object' ? (item as any).text ?? (item as any).content ?? (item as any).label : item))
    .filter(Boolean);

const emptyDirectScene = (): QixiScenePayload => ({
    transitionLines: [],
    sharedObject: '',
    memoryLine: '',
    options: [],
    charAction: '',
    artifactIds: [],
    charSelectionIds: [],
    reveal: '',
});

const normalizeDirectScene = (sceneId: QixiSceneId, value: any): QixiScenePayload => {
    const scene = value && typeof value === 'object' ? value : {};
    const rawOptions = directList(scene.options ?? scene.choices ?? scene.userOptions ?? scene.actions);
    const options = rawOptions.map((rawOption, index): QixiSceneOption => {
        const option = rawOption && typeof rawOption === 'object' ? rawOption : { label: rawOption, result: rawOption };
        const evidenceIds = directStringList(option.evidenceIds ?? option.evidenceId);
        return {
            id: directText(option.id) || `${sceneId}-${index + 1}`,
            label: directText(option.label ?? option.text ?? option.title),
            result: directText(option.result ?? option.outcome ?? option.feedback ?? option.description),
            ...(option.charReply !== undefined || option.reply !== undefined
                ? { charReply: directText(option.charReply ?? option.reply) }
                : {}),
            evidenceIds,
        };
    });
    const transitionLines = directStringList(scene.transitionLines ?? scene.transitions ?? scene.transition);
    const charQuips = directStringList(scene.charQuips ?? scene.quips);
    return {
        transitionLines,
        sharedObject: directText(scene.sharedObject ?? scene.object ?? scene.sharedItem),
        memoryLine: directText(scene.memoryLine ?? scene.memory ?? scene.description),
        options,
        charAction: directText(scene.charAction ?? scene.otherAction ?? scene.characterAction),
        ...(scene.charVisibleText !== undefined ? { charVisibleText: directText(scene.charVisibleText) } : {}),
        ...(charQuips.length ? { charQuips } : {}),
        ...(scene.charMutter !== undefined ? { charMutter: directText(scene.charMutter) } : {}),
        ...(scene.charContribution !== undefined ? { charContribution: directText(scene.charContribution) } : {}),
        reveal: directText(scene.reveal ?? scene.resultSummary),
        artifactIds: directStringList(scene.artifactIds ?? scene.artifacts),
        charSelectionIds: directStringList(scene.charSelectionIds ?? scene.charSelections),
    };
};

const QIXI_PHASE_SCENE_ALIASES: Record<QixiSceneId, string[]> = {
    lostLayer: ['lostlayer', 'lost', 'scene1', 'room1', 'stage1', '01', '1', '失聯層', '失聯'],
    doubleWish: ['doublewish', 'wish', 'wishes', 'scene2', 'room2', 'stage2', '02', '2', '雙面祈願處', '祈願處', '祈願'],
    threadNeedle: ['threadneedle', 'needle', 'thread', 'scene3', 'room3', 'stage3', '03', '3', '穿針乞巧', '穿針'],
    offerings: ['offerings', 'offering', 'fruits', 'scene4', 'room4', 'stage4', '04', '4', '供果', '供品'],
    reflection: ['reflection', 'mirror', 'water', 'scene5', 'room5', 'stage5', '05', '5', '照影', '照影潭'],
    nightMarket: ['nightmarket', 'market', 'scene6', 'room6', 'stage6', '06', '6', '記憶夜市', '夜市'],
    wordCloud: ['wordcloud', 'words', 'grapes', 'scene7', 'room7', 'stage7', '07', '7', '葡萄架詞雲', '詞雲'],
};

const phaseKey = (value: unknown): string => directText(value).replace(/[\s_\-·：:（）()]/g, '').toLocaleLowerCase();
const directRecord = (value: unknown): Record<string, any> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const looksLikeGeneratedScene = (value: unknown): boolean => {
    const scene = directRecord(value);
    return Boolean(scene && ['sharedObject', 'object', 'memoryLine', 'memory', 'options', 'choices', 'charAction', 'otherAction', 'transitionLines', 'reveal']
        .some(key => key in scene));
};
const sceneIdFromLooseValue = (value: unknown): QixiSceneId | null => {
    const normalized = phaseKey(value);
    if (!normalized) return null;
    return QIXI_SCENE_IDS.find(sceneId => [phaseKey(sceneId), ...QIXI_PHASE_SCENE_ALIASES[sceneId].map(phaseKey)]
        .some(alias => normalized === alias || normalized.startsWith(alias))) || null;
};

/**
 * Phase responses are final LLM scripts, not configuration files. Accept the
 * same generated rooms when a provider wraps them, returns an array, uses
 * `room3`/Chinese titles, or omits the `scenes` envelope. This is shape repair
 * only: scene prose is never scored, rewritten, or replaced.
 */
export function normalizeQixiPhaseChunk(value: unknown, requiredIds: readonly QixiSceneId[]): any | null {
    const root = directRecord(value);
    if (!root) return null;
    const collectionKeys = ['scenes', 'rooms', 'locations', 'stages', 'chapters'];
    const wrapperKeys = ['data', 'result', 'output', 'payload', 'content', 'response', 'part1', 'part2', 'part3'];

    const findCollection = (candidate: unknown, depth = 0): { container: Record<string, any>; collection: unknown } | null => {
        if (depth > 4) return null;
        const record = directRecord(candidate);
        if (!record) return null;
        for (const key of collectionKeys) {
            const collection = record[key];
            if (Array.isArray(collection) || directRecord(collection)) return { container: record, collection };
        }
        if (Object.values(record).some(looksLikeGeneratedScene)) return { container: record, collection: record };
        for (const key of wrapperKeys) {
            const nested = findCollection(record[key], depth + 1);
            if (nested) return nested;
        }
        for (const nestedValue of Object.values(record)) {
            const nested = findCollection(nestedValue, depth + 1);
            if (nested) return nested;
        }
        return null;
    };

    const found = findCollection(root);
    if (!found) return null;
    const entries: Array<[string, any]> = Array.isArray(found.collection)
        ? found.collection.map((scene, index) => [String(index), scene])
        : Object.entries(found.collection as Record<string, unknown>);
    const scenes: Partial<Record<QixiSceneId, any>> = {};
    const remaining: any[] = [];

    entries.forEach(([key, rawScene]) => {
        if (!looksLikeGeneratedScene(rawScene)) return;
        const scene = directRecord(rawScene)!;
        const matchedId = sceneIdFromLooseValue(key)
            || sceneIdFromLooseValue(scene.id ?? scene.sceneId ?? scene.roomId ?? scene.name ?? scene.title);
        if (matchedId && requiredIds.includes(matchedId) && !scenes[matchedId]) scenes[matchedId] = scene;
        else remaining.push(scene);
    });
    requiredIds.forEach(sceneId => {
        if (!scenes[sceneId] && remaining.length) scenes[sceneId] = remaining.shift();
    });

    const rawBridge = found.container.bridge
        ?? found.container.magpieBridge
        ?? found.container.bridgeData
        ?? root.bridge
        ?? root.magpieBridge
        ?? root.bridgeData;
    const bridgeRecord = directRecord(rawBridge);
    const bridge = bridgeRecord ? {
        ...bridgeRecord,
        userMagpies: bridgeRecord.userMagpies ?? bridgeRecord.userBirds ?? bridgeRecord.userNodes ?? bridgeRecord.leftMagpies ?? bridgeRecord.userSide,
        charMagpies: bridgeRecord.charMagpies ?? bridgeRecord.charBirds ?? bridgeRecord.charNodes ?? bridgeRecord.rightMagpies ?? bridgeRecord.charSide,
        finalMagpie: bridgeRecord.finalMagpie ?? bridgeRecord.finalBird ?? bridgeRecord.lastMagpie ?? bridgeRecord.finalNode,
    } : rawBridge;
    return {
        ...root,
        ...found.container,
        scenes,
        ...(bridge !== undefined ? { bridge } : {}),
    };
}

/**
 * Qixi uses the same generation philosophy as the earlier special events:
 * model output is the final playable script. This parser only tolerates JSON
 * shape drift; it never scores, rejects, rewrites, or replaces generated prose.
 */
export function parseQixiMemoryBundle(
    raw: string,
    contextSignature = '',
    onFailure?: (reason: string) => void,
    userName = 'User',
): QixiMemoryBundle | null {
    const fail = (reason: string): null => {
        onFailure?.(reason);
        return null;
    };
    const parsed = parseQixiJsonObject(raw, ['scenes']) as any;
    if (!parsed || typeof parsed !== 'object') return fail('沒有解析到 JSON 對象');
    if (!parsed.scenes || typeof parsed.scenes !== 'object' || Array.isArray(parsed.scenes)) {
        return fail('scenes 缺失或不是對象');
    }

    const evidence = directList(parsed.evidence).map((rawEvidence, index): QixiMemoryEvidence => {
        const item = rawEvidence && typeof rawEvidence === 'object' ? rawEvidence : { fact: rawEvidence };
        return {
            id: directText(item.id) || `e${index + 1}`,
            fact: directText(item.fact ?? item.memory ?? item.text),
            object: directText(item.object ?? item.label ?? item.subject),
            tags: directStringList(item.tags),
        };
    });
    const artifacts = directList(parsed.artifacts).map((rawArtifact, index): QixiMemoryArtifact => {
        const item = rawArtifact && typeof rawArtifact === 'object' ? rawArtifact : { label: rawArtifact };
        const rawKind = directText(item.kind) as QixiArtifactKind;
        const kind = (['object', 'phrase', 'nickname', 'topic', 'date', 'emotion', 'wish', 'symbol', 'trait'] as string[]).includes(rawKind)
            ? rawKind
            : 'object';
        return {
            id: directText(item.id) || `a${index + 1}`,
            label: directText(item.label ?? item.name ?? item.text),
            kind,
            evidenceIds: directStringList(item.evidenceIds ?? item.evidenceId),
        };
    });

    const scenes = Object.fromEntries(QIXI_SCENE_IDS.map(sceneId => [
        sceneId,
        parsed.scenes[sceneId] && typeof parsed.scenes[sceneId] === 'object'
            ? normalizeDirectScene(sceneId, parsed.scenes[sceneId])
            : emptyDirectScene(),
    ])) as Record<QixiSceneId, QixiScenePayload>;
    const personalizedSceneIds = QIXI_SCENE_IDS.filter(sceneId => (
        parsed.scenes[sceneId] && typeof parsed.scenes[sceneId] === 'object'
    ));
    const bundle: QixiMemoryBundle = {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'memory',
        openingChat: directStringList(parsed.openingChat),
        charLayerColor: normalizeCharLayerColor(parsed.charLayerColor),
        charPerformance: normalizeCharPerformance(parsed.charPerformance),
        evidence,
        artifacts,
        scenes,
        personalizedSceneIds,
        generatedAt: Date.now(),
        contextSignature,
    };
    if (parsed.bridge !== undefined) {
        const bridge = parseQixiBridge(JSON.stringify(parsed.bridge), bundle, userName);
        if (!bridge) return fail('bridge JSON 無法解析為雙岸鵲橋');
        bundle.bridge = bridge;
    }
    return bundle;
}

export function parseQixiProgressiveMemoryBundle(
    baseChunk: any,
    generatedScenes: Partial<Record<QixiSceneId, QixiScenePayload>>,
    contextSignature = '',
    userName = 'User',
    onFailure?: (reason: string) => void,
): QixiMemoryBundle | null {
    return parseQixiMemoryBundle(JSON.stringify({
        ...baseChunk,
        scenes: generatedScenes,
    }), contextSignature, onFailure, userName);
}

export function loadQixiMemoryBundle(charId: string): QixiMemoryBundle | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`) || 'null') as QixiMemoryBundle | null;
        if (parsed?.version !== QIXI_MEMORY_BUNDLE_VERSION || !parsed.scenes || !Array.isArray(parsed.evidence)) return null;
        if (parsed.source === 'memory' && !parsed.bridge) return null;
        return parsed;
    } catch {
        return null;
    }
}

function saveQixiMemoryBundle(charId: string, bundle: QixiMemoryBundle): void {
    try { localStorage.setItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`, JSON.stringify(bundle)); } catch { /* optional cache */ }
}

function buildContextSignature(messages: Message[], char: CharacterProfile, user: UserProfile): string {
    const last = messages[messages.length - 1];
    return simpleHash([
        messages.length,
        last?.id || 0,
        last?.timestamp || 0,
        char.systemPrompt?.length || 0,
        char.description?.length || 0,
        user.name,
    ].join(':'));
}

export function buildQixiMemoryBundlePrompt(
    char: CharacterProfile,
    user: UserProfile,
    userLayerColor: string = QIXI_DEFAULT_USER_LAYER_COLOR,
): string {
    const briefs = QIXI_SCENE_IDS.map(sceneId => `- ${sceneId}: ${SCENE_BRIEFS[sceneId]}`).join('\n');
    const charColorChoices = QIXI_CHAR_LAYER_COLORS.map(color => `${color.label} ${color.value}`).join('、');
    return `### 七夕特別活動：雙層上下文探索可播放劇本

【最高優先級】不要證明 ${char.name} 記得 ${user.name}，而要讓 ${char.name} 使用這些記憶與 ${user.name} 做事。記憶是玩法依據，不是等待本地代碼再加工的素材，也不是檔案展示。

【同級最高優先級】記憶最多決定“這一站碰到什麼”，${char.name} 本人必須決定“ta 怎麼做、怎麼猶豫、怎麼嘴硬、會突然小聲說什麼”。不要讓每一句反應都複述、解釋或回收 evidence；如果拿掉記憶名詞，Char 的動作和碎碎念仍應鮮活到能認出是 ta。角色不是記憶宮殿的講解員。

【同級最高優先級】${char.name} 與 User 是對稱受困者：ta 也剛剛掉進上下文夾層、同樣突然找不到 User、同樣不知道活動規則和對面是誰，還被迫完成一連串莫名其妙的小遊戲。ta 有自己正在經歷的事故、選擇、試探、誤判、失敗和情緒，不是在另一層從容等待 User 操作的引導員。前六站只能把共享物另一端的操作者稱作“某人 / 另一邊 / 那傢伙 / 不知道誰”等符合角色的未知稱呼；只能從新鮮痕跡逐步產生“怎麼越來越像我認識的那個人”的懷疑，不能全知 User 當前在想什麼，也不能確信對面就是 User。允許 ta 找錯、搶錯、配合失敗、嫌棄關卡、因為著急顯得笨拙，或先忙著解決自己那一層的問題。第七站結束也只到強烈懷疑，真正的身份確認留給 Part 3 第一次見面。

你負責 Part 1：根據真實聊天、記憶召回、角色設定和用戶資料，直接生成玩家最終會看見、點擊和經歷的完整劇本：異常發生前的兩句正常聊天，以及七個地點可即時播放的最終台詞、選項、動作與過場。不要輸出供本地代碼二次創作的素材或摘要。七站必須組成一條連續發展的“雙人異常事件”，不是七個獨立的記憶小遊戲，也不是“記憶事實 → 物件 → 選項 → Char 操作 → reveal”重複七次。User 與 ${char.name} 都不知道七夕活動，也不知道接下來會掉進上下文夾層；兩個人會被同一次異常同時捲入不同層，雙方看不見彼此，只能通過同一件東西留下的即時變化猜測另一邊發生了什麼。

關係推進必須依次發生：User 起初只知道系統異常 → 發現另一層存在某個人 → 發現對方會回應自己的操作 → 開始覺得處理事情的方式很熟悉 → 雙方主動試探 → 第七站雙方都幾乎猜到答案但仍沒有視覺確認。每站 reveal 必須停在該站階段，不能提前揭曉，也不能靠旁白替玩家得出結論。Part 1 中 ${char.name} 絕不能說出“原來是你 / 我就知道是你 / 果然是你 / ${user.name}”，這些確認必須留到 Part 3 完整見面。

角色：${char.name}
用戶：${user.name}
User 已選擇自己的層色：${userLayerColor}

請根據 ${char.name} 的人格、審美和說話氣質，從以下可讀色中為 ta 選擇一個專屬層色，並輸出到 charLayerColor。不要因為性別默認選擇粉色或藍色；優先選擇能代表角色、且與 User 層色容易區分的顏色：${charColorChoices}

同時生成 charPerformance，讓 ${char.name} 在七個固定玩法裡的介入方式仍然像 ta 自己。tempo 只能是 brisk（利落迅速）/ measured（穩而克制）/ hesitant（先遲疑再行動）/ playful（輕快帶玩心）；markStyle 只能是 precise（整齊銳利）/ soft（柔和圓潤）/ scribbled（隨手凌亂）/ ornate（有裝飾感）；presence 只能是 direct（直接）/ careful（小心照顧）/ teasing（愛逗人）/ quiet（安靜少言）。必須根據角色設定選擇，不能所有角色都使用默認組合。

事實、演出與互動規則：
1. 事實不可虛構，演出可以虛構。只使用上下文明示的過去事實；不得補造共同經歷、日期、禮物、原話、爭吵、承諾或關係身份，沒有準確原話時只能轉述。允許把真實 evidence 演成新的超現實設施、故障、商品、空間反應、物件變形或互動事故。不能創造假的過去，可以創造新的現在。
2. 資料充足時提取 20 條互不重複的事實證據，最多 24 條；資料不足就少寫，絕對不能為了數量編造。20 條要儘量跨不同時間、不同主題和不同記憶類型，不能把同一事件換個說法重複佔位。每條 evidence 必須具體、可辨認，object 是事實裡真實出現的詞、物件或動作。
3. artifacts 必須從 evidence 派生，每一項都引用有效 evidenceIds。wordCloud 使用的性格詞必須標為 kind="trait"。同一 evidence 原則上最多服務兩個場景，每站儘量使用不同證據。每站只選一個最有效的記憶錨點做主角，不要把多個 facts 塞進同一段旁白；其餘生命力來自當下的新事故和兩個人的即時反應。
4. evidence 不能只被擺出來供人參觀，必須成為當下事件中可被拿走、交換、破壞、修改、誤用、搶先購買或用來試探身份的玩法材料。目標不是“遊戲記得這件事”，而是“這種東西居然也被這裡拿來玩了”。
5. 禁止連續使用低信息量陳列演出，例如“某個熟悉的東西浮現 / 某段記憶出現在眼前 / 水面泛起漣漪 / 紙面微微發亮 / 線輕輕顫動”。transitionLines、memoryLine、result、charAction 必須寫具體發生了什麼。
6. 前六站必須各提供恰好 3 個完整 options，不能少於或多於 3 個；wordCloud 的 options 必須為空。每個 option 都必須包含 id、label、result、evidenceIds，並且每個 option 自己都必須引用至少一個有效 evidence；不能只讓整個場景籠統引用 evidence。
7. lostLayer 的每一個 option.label 都必須直接從它自己的 evidenceIds 所指向的具體事實、物件或未完話題提煉，讓 User 選擇“接著和 ${char.name} 聊哪段真實記憶”。禁止脫離 evidence 的泛泛問候，也不能生成開發、運維、代碼或故障處理任務。可以讓態度不同，例如不信邪重發、只丟一個問號試探、故意換個說法，但選項中必須看得出在聊哪條真實記憶。lostLayer 每個 option 還必須額外提供 charReply：這是清掉滿屏報錯之後，${char.name} 針對這個選項所代表話題真正送回來的 4—48 字回覆；必須回應具體話題並像角色本人，不能繼續談報錯、只寫動作說明或泛泛說“我在”。所有玩家可見文案絕不能出現 e1、e2、evidenceId 等內部編號。
8. 選項要表現 User 的策略、態度或意圖，減少只有“拿起 / 放下 / 點擊 / 查看 / 寫下 / 等待”的機械動作。即使前端最終仍是按鈕，七站文本也不能像連續做七次同一種選擇題。
9. result 不能只是“發光、顫動、出現反饋”，必須讓 User 的具體選擇改變這一輪互動：東西被抽走、位置被佔、內容被改、雙方撞車、配合失敗後重來、某件商品提前售出等。
10. charAction 必須通過 ${char.name} 處理事情的方式暴露人格，至少體現一種具體特徵：動作習慣、耐心、搶先、嘴硬、故意逗人、臨時改主意、無意識的小動作、怪比喻、歪理或冷幽默。charPerformance 只是輔助參數，不能代替具體人格演出。遮掉角色名字和所有記憶名詞後，仍應能憑動作與吐槽猜出是誰。Char 的動作必須同時像“ta 正在處理自己那一層的遭遇”，不能全部寫成專程過來幫助 User；至少三站先寫出 Char 自己的目的，再讓雙方動作意外相撞或接上。
11. 七站中至少四站要出現一次意外、失敗、搶奪、擅自修改、互相妨礙或故意不配合；兩層不能永遠溫柔順利地用另一色光芒回應。
12. 前六站禁止頻繁寫“對方似乎很瞭解你 / 你感到熟悉 / 某種默契形成 / 你意識到彼此存在聯繫”這類愛情或關係總結。展示動作證據，不替玩家解釋證據。
13. 七站玩法職責必須不同：lostLayer 是話題發送失敗後報錯紅框鋪滿空間，Char 只攻擊並毀掉報錯，再真正回覆所選話題；doubleWish 是異步共用同一張紙並分別寫下各自的願望；threadNeedle 是被迫摸索動作順序並與未知另一層協作；offerings 是雙方先後各自放下一件東西；reflection 是能被實時修改的痕跡；nightMarket 是雙方各自逛攤、選購和試探；wordCloud 是雙方嚴格交替選詞並把身份懷疑推到最高，但不完成最終確認。
14. wordCloud 的 artifactIds 必須提供 12—20 個短小、好選擇的性格/氣質/處事方式詞，用來回答“你想到的那個人是什麼性格”；User 會從中選 3 個最像 ${char.name} 的詞。不要放物件、日期、話題、稱呼、願望或“開心/難過”這類瞬時情緒。charSelectionIds 選擇 3—6 個 ${char.name} 眼裡“最像 User”的性格詞。
15. openingChat 必須恰好兩句，完全使用 ${char.name} 的說話方式。語義是：${char.name} 懷疑 ${user.name} 剛剛回復過，但自己沒有收到。不能提活動、七夕、夢境、夾層、邀請、準備驚喜或“點擊輸入框”。
16. 每個場景必須提供 transitionLines 1—2 句，把上一站真實發生的具體結果變成下一站入口，讓七站保持因果連續。每句用 12—38 個中文字符，只寫 User 能直接看到、聽到或碰到的普通感官變化，不能總結主題、解釋身份或寫成任務說明。嚴禁“數據流 / 字符化 / 上下文 / 協議 / 接口 / 系統指令”等技術隱喻，嚴禁輸出世界書標籤、英文品牌名或“【CYBERORDER】”這類方括號設定名。
17. lostLayer 與 doubleWish 必須提供 charVisibleText，其他五站填空字符串。lostLayer 的 charVisibleText 是 ${char.name} 毀掉報錯時留在原地的 2—36 字短句，矛頭必須指向報錯、彈窗或擋路的錯誤，不能評價、改寫或搶救 User 的話題；doubleWish 的 charVisibleText 必須直接寫成 Char 第一人稱許下的完整願望句（例如“希望我正在找的那個人平安，也希望以後還能一起期待明天”），不能回應 User 正面的願望，也不能暗示已經知道紙張另一面是誰。
18. lostLayer 必須提供 charMutter：2—18 字，是 ${char.name} 衝回來毀掉報錯時脫口而出的短促碎念。既有演出順序不可改：“User 選擇記憶相關話題 → 嘗試發送 → DELIVERY FAILED、API 限流、超時與軟道歉紅框鋪滿空間 → Char 從另一層衝回來劃掉、撕碎或踢走全部報錯 → 對應 option.charReply 穿過清出的空隙出現 → User 的話題原樣留在發送框”。Char 的視覺動作、charVisibleText、charMutter 與 charQuips 只能攻擊報錯，絕不能攻擊、改寫、刪除、劃掉或搶救 User 的話題；真正回應話題只寫在 option.charReply。
19. lostLayer 恰好提供 2 句環繞報錯牆出現的 charQuips；doubleWish、threadNeedle、offerings、reflection、nightMarket 各提供 1—2 句 charQuips，wordCloud 恰好 3 句。它們是 ${char.name} 在當下漏出來的私人碎碎念，不是動作說明、記憶總結或系統旁白；每句 4—26 字，可以暴露一瞬間的私心、害羞、嫌棄、得意、猶豫、被迫玩奇怪小遊戲的不耐煩、想藏起來的小願望、對失蹤之人的擔心、對另一層身份的遲疑，或只有 ta 才會冒出的怪念頭。Part 1 全程不能直接叫 User 名字，前六站不能把另一層稱作已知的“你”，只能用“某人 / 另一邊 / 那傢伙 / 不知道誰”等未知稱呼；第七站可以寫“不會真是……”這種猜測，但不能確認。可愛來自受困時具體的小別扭、誤會和意外，不來自統一賣萌、網絡梗或隨機發瘋。在不違背設定時把電波感開到約 7/10。至少三站的碎碎念不直接提 evidence，而是只回應眼前正在發生的事。wordCloud 嚴格執行 User 選一個 → Char 立刻選一個並吐槽，共三輪，不能最後一次性揭曉。
20. doubleWish 的 User 三個願望可以是對“兩個人以後”的真實期盼。${char.name} 的 charVisibleText 則是 ta 在自己那一層寫給“正在尋找的重要之人”的私人願望，並不知道共享同一張紙的操作者就是那個人；不能直接對另一層說“你”，不能寫成回應 User 正面的願望。若記憶宮殿召回內容中出現“窗台房間 / Window Sill”裡的未來願望、計劃或期盼，可以從中提煉，但不得把願望寫成已經發生的共同經歷。charQuips 是紙角漏出來的自言自語，可以嫌棄這關奇怪、想遮住自己寫得太認真，或擔心那個人現在在哪裡。
21. offerings 必須提供 charContribution：2—24 字，只寫 ${char.name} 從自己那一層放上供桌的具體【私物】。它必須是屬於 ${char.name}、對 ${char.name} 本人有意義、像 ta 會擁有/使用/隨身攜帶/珍藏的東西；不要求來自共同記憶，不要求與 User 有關，也絕不能默認寫成特意送給 User 的禮物。可以讓 charQuips 用角色自己的口吻極短暴露為什麼捨不得、常用或看重它，但不要寫檔案式說明。charContribution 不能是動作、旁白、對 User 供物的評價或“另一樣東西”這種佔位語。演出順序固定為“User 選擇並放下自己的東西 → 另一側空位出現變化 → charContribution 對應的 Char 私物滑入 → charQuips 在私物旁出現”。charAction 可以描述隨後發生的挪動、交換、搶位或碰撞，但不能替代 Char 自己的私物。
22. nightMarket 的三個 option.label 必須分別是 User 真能挑選購買的具體夢境商品，並由有效 evidence 變形而來；不要再寫“試探一下 / 搶先 / 等待”這種抽象策略。User 選中後，charAction 必須按順序寫清：${char.name} 也挑了一件“某人也許會喜歡”的不同商品作為身份試探 → 隨後避開另一層視線，偷偷把純粹自己想買的 charContribution 塞進紙袋。charContribution 為 2—24 字具體商品，體現角色自己的喜好，不要求與 User 有關。charQuips 可以嘴硬掩飾自購品，但默認禁止吃醋、嫉妒、情敵、佔有慾宣言和圍繞 User 爭搶商品；除非真實設定與 evidence 明確支持，否則不要生成這類內容。
23. 敘事視角必須分開。系統旁白、transitionLines、memoryLine、options.label、options.result 面向玩家時，用第二人稱“你 / 你的”，禁止寫“User / 用戶 / 玩家 / 該用戶 / ta / 他 / 她”。但 ${char.name} 自己說出或漏出的 charVisibleText、charMutter、charQuips、charReply，以及描述 ta 主觀判斷的 charAction，在 Part 1 不能知道另一層就是 User：應按場景使用“某人 / 另一邊 / 那傢伙 / 不知道誰”，不能叫 ${user.name}，也不能用帶有身份確認含義的“你”。內部 evidence 與 artifact 的事實字段不受這條敘述人稱限制。

場景要求：
${briefs}

只輸出一個 JSON 對象，不要 Markdown，不要解釋：
{
  "openingChat": ["角色察覺可能漏收消息", "角色困惑地確認異常"],
  "charLayerColor": "從允許色表中選擇的十六進制顏色",
  "charPerformance": { "tempo": "brisk|measured|hesitant|playful", "markStyle": "precise|soft|scribbled|ornate", "presence": "direct|careful|teasing|quiet" },
  "evidence": [
    { "id": "e1", "fact": "一條具體可核對的事實", "object": "真實物件或詞", "tags": ["日常", "飲料"] }
  ],
  "artifacts": [
    { "id": "a1", "label": "一個短詞或物件", "kind": "object|phrase|nickname|topic|date|emotion|wish|symbol|trait", "evidenceIds": ["e1"] }
  ],
  "scenes": {
    "lostLayer": {
      "transitionLines": ["上一空間留下的痕跡開始變化", "下一空間從痕跡中浮現"],
      "sharedObject": "一個停在發送前的話題框",
      "memoryLine": "兩個真實的未完話題卡在發送框裡",
      "options": [{ "id": "topic-1", "label": "把那件只說了一半的小事繼續說完", "result": "這句追問嘗試發送後變成 DELIVERY FAILED。", "charReply": "針對這件小事真正送回來的角色回覆", "evidenceIds": ["e1"] }, { "id": "topic-2", "label": "問問那個真實目標後來到了沒有", "result": "這個話題離開發送框後被退回。", "charReply": "針對那個真實目標的角色回覆", "evidenceIds": ["e2"] }, { "id": "topic-3", "label": "拿另一個真實記憶細節重新發一次", "result": "第三個話題被超時彈窗攔住。", "charReply": "針對第三個記憶話題的角色回覆", "evidenceIds": ["e3"] }],
      "charAction": "API 報錯、限流、超時和軟道歉紅框鋪滿空間；另一色字跡從另一層衝來，把所有紅框劃掉、撕碎並踢走，你選中的話題原樣留在原處",
      "charMutter": "角色毀掉報錯時脫口而出的短促碎念",
      "charVisibleText": "擋路的，刪掉。",
      "charQuips": ["道歉留著自己看。", "這次不許再吞。"],
      "reveal": "只推進到：報錯後面確實有另一個人在操作",
      "artifactIds": ["a1"],
      "charSelectionIds": []
    },
    "doubleWish": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "doubleWish-1", "label": "關於兩個人未來的願望一", "result": "願望寫上正面的即時反饋", "evidenceIds": ["e4"] }, { "id": "doubleWish-2", "label": "關於兩個人未來的願望二", "result": "願望寫上正面的即時反饋", "evidenceIds": ["e5"] }, { "id": "doubleWish-3", "label": "關於兩個人未來的願望三", "result": "第三個願望改變紙面的具體反饋", "evidenceIds": ["e6"] }], "charAction": "紙箋被另一邊翻到背面，某人寫下關於正在尋找之人的願望", "charVisibleText": "希望我正在找的那個人平安，也希望以後還能一起期待明天。", "charQuips": ["這關為什麼非要看別人寫願望……"], "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "threadNeedle": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "threadNeedle-1", "label": "先把線頭壓低，等另一邊穩住針孔", "result": "會改變配合過程的具體結果", "evidenceIds": ["e7"] }, { "id": "threadNeedle-2", "label": "故意停半拍，讓另一邊先選", "result": "不同的碰撞或配合結果", "evidenceIds": ["e8"] }, { "id": "threadNeedle-3", "label": "同時鬆手，看另一邊會不會接住", "result": "第三種失敗或配合結果", "evidenceIds": ["e9"] }], "charAction": "帶角色人格的直接回應", "charVisibleText": "", "charQuips": ["角色即時吐槽"], "reveal": "只推進到主動協作", "artifactIds": [], "charSelectionIds": [] },
    "offerings": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "offerings-1", "label": "放下屬於你的第一件東西", "result": "你的供物落在左側空位", "evidenceIds": ["e10"] }, { "id": "offerings-2", "label": "把自己的東西先放在正中間", "result": "你的供物佔住最顯眼的位置", "evidenceIds": ["e11"] }, { "id": "offerings-3", "label": "故意把自己的東西貼著邊緣放", "result": "你的供物為另一側留出空位", "evidenceIds": ["e12"] }], "charAction": "另一層自己的私物滑入空位，隨後發生帶私人判斷的挪動或碰撞", "charContribution": "屬於 Char 且對 Char 本人有意義的具體私物", "charVisibleText": "", "charQuips": ["用角色口吻洩露這件私物為何被看重"], "reveal": "只展示雙方各自放下東西與互相判斷的證據", "artifactIds": [], "charSelectionIds": [] },
    "reflection": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "reflection-1", "label": "留半句話，故意不寫完", "result": "另一層可以立即接續的具體結果", "evidenceIds": ["e13"] }, { "id": "reflection-2", "label": "畫一個會被另一邊改壞的符號", "result": "另一層修改或曲解後的結果", "evidenceIds": ["e14"] }, { "id": "reflection-3", "label": "先擦掉一筆再看另一邊怎麼補", "result": "第三種實時接續結果", "evidenceIds": ["e15"] }], "charAction": "另一層近實時修改你留下的內容", "charVisibleText": "", "charQuips": ["角色即時吐槽"], "reveal": "只推進到近實時交流", "artifactIds": [], "charSelectionIds": [] },
    "nightMarket": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "nightMarket-1", "label": "由 e16 變形成的具體可買商品", "result": "你把商品放進自己的紙袋", "evidenceIds": ["e16"] }, { "id": "nightMarket-2", "label": "由 e17 變形成的另一件具體商品", "result": "攤主把你選的東西包起來", "evidenceIds": ["e17"] }, { "id": "nightMarket-3", "label": "由 e18 變形成的第三件具體商品", "result": "你的購買券落到對應商品前", "evidenceIds": ["e18"] }], "charAction": "另一邊先挑走一件覺得某人可能喜歡的商品，停頓後又偷偷把自己的東西塞進紙袋", "charContribution": "Char 單純為自己買的具體商品", "charVisibleText": "", "charQuips": ["只是我自己想要，別亂猜。"], "reveal": "雙方都覺得購物習慣異常熟悉，但誰也沒有確認身份", "artifactIds": [], "charSelectionIds": [] },
    "wordCloud": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "", "charQuips": ["第一輪吐槽", "第二輪吐槽", "第三輪吐槽"], "reveal": "...", "artifactIds": ["a1"], "charSelectionIds": ["a1"] }
  }
}`;
}

export function buildQixiMemoryBundlePhasePrompt(
    char: CharacterProfile,
    user: UserProfile,
    userLayerColor: string = QIXI_DEFAULT_USER_LAYER_COLOR,
    phase: 'first' | 'second' | 'third',
    continuationSeed = '',
): string {
    const basePrompt = buildQixiMemoryBundlePrompt(char, user, userLayerColor);
    if (phase === 'first') {
        return `${basePrompt}

【本輪輸出範圍覆蓋上面的完整示例】
這是 Part 1 的第一段生成。只生成公共上下文與前兩站的最終可播放內容，降低一次性輸出負擔。
最終 JSON 頂層必須包含 openingChat、charLayerColor、charPerformance、evidence、artifacts、scenes；scenes 必須且只能包含 lostLayer、doubleWish 兩個 key。
不要輸出其餘五站，也不要用省略號代替任何字段。後續兩段會接在本輪結果後面。`;
    }

    if (phase === 'second') {
        return `${basePrompt}

【上一段已通過基礎結構檢查的唯一底稿】
${continuationSeed}

【本輪輸出範圍覆蓋上面的完整示例】
這是 Part 1 的第二段生成。不要重寫 openingChat、charLayerColor、charPerformance、evidence 或 artifacts，也不要改寫前兩站。
只輸出一個 JSON 對象，唯一頂層 key 為 scenes；scenes 必須且只能包含 threadNeedle、offerings、reflection 三個完整場景。
這三站必須沿用上面底稿的 evidence id、artifact id、角色行為方式與前兩站事件結果，形成同一條連續事件；不得發明底稿之外的過去事實。不要輸出 Markdown，不要解釋，不要使用省略號。`;
    }

    return `${basePrompt}

【上一段已通過基礎結構檢查的唯一底稿】
${continuationSeed}

【本輪輸出範圍覆蓋上面的完整示例】
這是 Part 1 的第三段生成。不要重寫 openingChat、charLayerColor、charPerformance、evidence 或 artifacts，也不要改寫前五站。
只輸出一個 JSON 對象，頂層必須且只能有 scenes 與 bridge 兩個 key。scenes 必須且只能包含 nightMarket、wordCloud 兩個完整場景。
最後兩站必須沿用上面底稿的 evidence id、artifact id、角色行為方式與前五站事件結果，形成同一條連續事件；不得發明底稿之外的過去事實。

同一次響應中的 bridge 負責八地點結束後的鵲橋最終可播放內容。它必須複用上面底稿中已經召回的真實 evidence，不重新發明共同經歷：
- userMagpies：選擇 User 會由此想到 Char 的記憶；charMagpies：選擇 Char 會由此想到 User 的記憶。
- 每側根據有效證據選擇 1—6 只，寧可少而準確；同一側 evidenceId 不得重複，兩側允許從不同角度引用同一條證據。
- 每隻鵲必須包含 evidenceId、極短 name、一句私人具體的 memory、只做視覺抽象且不新增事實的 visualHint。
- finalMagpie.name 固定為“${user.name}”，代表系統把 Char 一路懷疑的名字帶向中央；line 只能表達“越來越像某人 / 希望沒有認錯”的近乎確定，不能說已經親眼確認身份。真正的“果然是你”留給 Part 3 見面。visualHint 是極短視覺意象。
- 禁止直接解釋“思念就是鵲橋”“記憶讓我們相見”等中心思想，交給後續動畫表達。

輸出結構必須是：
{
  "scenes": {
    "nightMarket": { "完整字段": "按上方場景規範生成" },
    "wordCloud": { "完整字段": "按上方場景規範生成" }
  },
  "bridge": {
    "userMagpies": [{ "evidenceId": "e1", "name": "記憶名稱", "memory": "一句極短真實記憶", "visualHint": "極短視覺意象" }],
    "charMagpies": [{ "evidenceId": "e2", "name": "記憶名稱", "memory": "一句極短真實記憶", "visualHint": "極短視覺意象" }],
    "finalMagpie": { "name": "${user.name}", "line": "Char 幾乎猜到但還不敢確認的極短反應", "visualHint": "從對岸飛來的名字" }
  }
}
不要輸出 Markdown，不要解釋，不要使用省略號。`;
}

const formatRecentMessages = (messages: Message[]): string => messages
    .slice(-160)
    .map(message => {
        const content = message.type === 'image' ? '[圖片]' : message.content;
        return `${message.role}: ${content}`;
    })
    .join('\n')
    .slice(-24000);

export async function prepareQixiMemoryBundle(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    options: {
        forceRegenerate?: boolean;
        strict?: boolean;
        onRecallComplete?: () => void;
        onPhaseReady?: (phase: QixiMemoryGenerationPhase, bundle: QixiMemoryBundle) => void;
        userLayerColor?: string;
    } = {},
): Promise<QixiMemoryPreparation> {
    let messages: Message[] = [];
    try { messages = await loadCharacterContextMessages(char); } catch { /* fallback below */ }
    const contextSignature = buildContextSignature(messages, char, user);
    const cached = loadQixiMemoryBundle(char.id);
    if (!options.forceRegenerate && cached?.contextSignature === contextSignature) {
        options.onRecallComplete?.();
        options.onPhaseReady?.('third', cached);
        return { bundle: cached, usedFallback: cached.source === 'fallback' };
    }

    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
        throw new Error('Part 1 無法生成：請先配置可用的模型 API。');
    }

    try {
        const recallQuery = [
            `七夕活動專用跨主題召回：目標返回 ${QIXI_RECALL_MAX_OUTPUT_ITEMS} 條互不重複、真實可核對的共同記憶。`,
            '想念、尋找對方、聯繫、分享、沒說完的話、撤回、沉默、等待、失聯；',
            '禮物、食物、飲料、日常物件、日期時間、稱呼暱稱、口頭禪、截圖圖片、梗；',
            '學習、工作、創作、為對方做成的事、願望目標、未來、彼此印象；',
            '記憶宮殿的窗台房間 / Window Sill / 窗邊記錄裡的未來願望、未完成計劃、想去的地方、對以後生活的期盼；若存在，優先保留至少兩條；',
            '安慰、害怕、難過、煩惱、負面情緒、陪伴、和好、需要、喜歡、自由、休息。',
            '儘量跨不同時間、主題和記憶類型；不要讓同一事件換說法重複佔位。優先返回私人、具體、可核對的記憶。',
        ].join('\n');
        const recallChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
        // 七夕召回只用活動 query 擴散；聊天上下文留給後面的生成器作事實來源，
        // 不參與檢索打分，避免最近話題把 20 條記憶擠成同一類。
        await injectMemoryPalace(recallChar, [], recallQuery, user.name, {
            entryPoint: 'direct',
            formatterMaxOutputItems: QIXI_RECALL_MAX_OUTPUT_ITEMS,
        });
        options.onRecallComplete?.();
        const memoryChar = {
            ...char,
            memoryPalaceInjection: (recallChar.memoryPalaceInjection || '').slice(0, 40000),
            roomPlatesInjection: recallChar.roomPlatesInjection || '',
        };
        const recent = formatRecentMessages(messages);
        const roleAndMemoryContext = ContextBuilder.buildCoreContext(memoryChar, user, true);
        const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const requestPhase = async (phase: 'first' | 'second' | 'third', userContent: string) => {
            const data = await safeFetchJson(
                endpoint,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [
                            { role: 'system', content: roleAndMemoryContext },
                            { role: 'user', content: userContent },
                        ],
                        temperature: 0.68,
                        max_tokens: 32000,
                        // 七夕首輪內容較長。強制使用流式傳輸，讓上游儘早返回響應頭/數據片段，
                        // 避免 Claude 在完整生成結束前觸發 Cloudflare 524。
                        stream: true,
                    }),
                },
                0,
                QIXI_PART1_TIMEOUT_MS,
                { appId: 'special-moments', charId: char.id, purpose: `qixi-dual-layer-part1${phase === 'first' ? 'a' : phase === 'second' ? 'b' : 'c-bridge'}-v19` },
                {}, // Incremental SSE reader stops on [DONE] even if the proxy keeps the socket open.
            );
            const content = data?.choices?.[0]?.message?.content;
            const finishReason = data?.choices?.[0]?.finish_reason || 'unknown';
            if (typeof content !== 'string') {
                throw new Error(`Part 1 ${phase === 'first' ? '前兩站' : phase === 'second' ? '中三站' : '後兩站與鵲橋'}響應正文不是字符串（finish_reason=${finishReason}, output_chars=0）`);
            }
            return { content, finishReason };
        };
        const hasPlayablePhaseScenes = (value: any, requiredIds: readonly QixiSceneId[]) => (
            directRecord(value?.scenes)
            && requiredIds.every(sceneId => looksLikeGeneratedScene(value.scenes[sceneId]))
        );
        const firstResponse = await requestPhase(
            'first',
            `[最近聊天片段，僅作事實來源]\n${recent || '（沒有可用的最近聊天片段）'}\n\n${buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'first')}`,
        );
        const firstChunk = normalizeQixiPhaseChunk(
            parseQixiJsonObject(firstResponse.content),
            QIXI_PART1_FIRST_SCENE_IDS,
        );
        if (!firstChunk || !hasPlayablePhaseScenes(firstChunk, QIXI_PART1_FIRST_SCENE_IDS)) {
            throw new Error(`Part 1 前兩站正文無法讀取（finish_reason=${firstResponse.finishReason}, output_chars=${firstResponse.content.length}）`);
        }
        let firstParseFailure = '未知結構錯誤';
        const firstBundle = parseQixiProgressiveMemoryBundle(firstChunk, firstChunk.scenes, contextSignature, user.name, reason => { firstParseFailure = reason; });
        if (!firstBundle) {
            throw new Error(`Part 1 前兩站內容無效（finish_reason=${firstResponse.finishReason}, output_chars=${firstResponse.content.length}, schema=${firstParseFailure}）`);
        }
        // The first playable slice is ready. Deliver it before opening the next
        // serial request so Flappy never waits for all three generations.
        options.onPhaseReady?.('first', firstBundle);

        const continuationSeed = JSON.stringify({
            openingChat: firstChunk.openingChat,
            charLayerColor: firstChunk.charLayerColor,
            charPerformance: firstChunk.charPerformance,
            evidence: firstChunk.evidence,
            artifacts: firstChunk.artifacts,
            completedScenes: firstChunk.scenes,
        });
        const secondResponse = await requestPhase(
            'second',
            buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'second', continuationSeed),
        );
        const secondChunk = normalizeQixiPhaseChunk(
            parseQixiJsonObject(secondResponse.content),
            QIXI_PART1_SECOND_SCENE_IDS,
        );
        if (!secondChunk || !hasPlayablePhaseScenes(secondChunk, QIXI_PART1_SECOND_SCENE_IDS)) {
            throw new Error(`Part 1 中三站正文無法讀取（finish_reason=${secondResponse.finishReason}, output_chars=${secondResponse.content.length}）`);
        }
        const secondScenes = { ...firstChunk.scenes, ...secondChunk.scenes };
        let secondParseFailure = '未知結構錯誤';
        const secondBundle = parseQixiProgressiveMemoryBundle(firstChunk, secondScenes, contextSignature, user.name, reason => { secondParseFailure = reason; });
        if (!secondBundle) {
            throw new Error(`Part 1 中三站內容無效（finish_reason=${secondResponse.finishReason}, output_chars=${secondResponse.content.length}, schema=${secondParseFailure}）`);
        }
        // Call 3 is still strictly downstream of Call 2, but React receives the
        // accepted middle rooms before the third request starts.
        options.onPhaseReady?.('second', secondBundle);

        const finalContinuationSeed = JSON.stringify({
            openingChat: firstChunk.openingChat,
            charLayerColor: firstChunk.charLayerColor,
            charPerformance: firstChunk.charPerformance,
            evidence: firstChunk.evidence,
            artifacts: firstChunk.artifacts,
            completedScenes: { ...firstChunk.scenes, ...secondChunk.scenes },
        });
        const thirdResponse = await requestPhase(
            'third',
            buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'third', finalContinuationSeed),
        );
        const thirdChunk = normalizeQixiPhaseChunk(
            parseQixiJsonObject(thirdResponse.content),
            QIXI_PART1_THIRD_SCENE_IDS,
        );
        const hasCollection = (value: unknown) => Array.isArray(value)
            ? value.length > 0
            : Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length);
        if (!thirdChunk || !hasPlayablePhaseScenes(thirdChunk, QIXI_PART1_THIRD_SCENE_IDS)
            || !hasCollection(thirdChunk.bridge?.userMagpies)
            || !hasCollection(thirdChunk.bridge?.charMagpies)
            || !thirdChunk.bridge?.finalMagpie) {
            throw new Error(`Part 1 後兩站與鵲橋結構無效（finish_reason=${thirdResponse.finishReason}, output_chars=${thirdResponse.content.length}）`);
        }

        const mergedContent = JSON.stringify({
            ...firstChunk,
            scenes: { ...firstChunk.scenes, ...secondChunk.scenes, ...thirdChunk.scenes },
            bridge: thirdChunk.bridge,
        });
        let parseFailureReason = '未知結構錯誤';
        const bundle = parseQixiMemoryBundle(mergedContent, contextSignature, reason => { parseFailureReason = reason; }, user.name);
        if (!bundle?.bridge) {
            throw new Error(`模型返回的七夕可播放劇本無法讀取（phase=merge, finish_reason=${firstResponse.finishReason}+${secondResponse.finishReason}+${thirdResponse.finishReason}, output_chars=${firstResponse.content.length}+${secondResponse.content.length}+${thirdResponse.content.length}, schema=${parseFailureReason}）`);
        }
        options.onPhaseReady?.('third', bundle);
        saveQixiMemoryBundle(char.id, bundle);
        return { bundle, usedFallback: false };
    } catch (error: any) {
        console.warn('[Qixi] direct script generation failed:', error?.message || error);
        throw new Error(error?.message || 'Part 1 生成失敗，請手動重新生成。');
    }
}
