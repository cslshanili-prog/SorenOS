import type { QixiSceneId } from './qixiMemoryBundle';

export interface QixiChatCardScene {
    id: QixiSceneId;
    title: string;
    sharedObject: string;
    userActions: string[];
    userResults: string[];
    charAction: string;
    memoryLine: string;
}

export interface QixiChatCardBridgeNode {
    name: string;
    artifactLabel: string;
    memoryLine: string;
}

export interface QixiEventChatCard {
    type: 'qixi_event_card';
    version: 8;
    runId: string;
    title: string;
    subtitle: string;
    charName: string;
    charAvatar?: string;
    userName: string;
    timestamp: number;
    openingChat: string[];
    entryAttitude?: string;
    scenes: QixiChatCardScene[];
    bridgeNodes: QixiChatCardBridgeNode[];
    reunionLines: string[];
    metaReflection: string[];
    companionshipReflection: string[];
    blessing: string[];
    promiseInvitation: string[];
    promiseComplete: string;
    summary: string;
}

export interface CreateQixiEventChatCardInput extends Omit<QixiEventChatCard, 'type' | 'version' | 'title' | 'subtitle' | 'summary'> {}

const compact = (value: unknown, max = 240): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const compactList = (items: unknown[] | undefined, maxItems = 12, maxLength = 240): string[] =>
    (items || []).map(item => compact(item, maxLength)).filter(Boolean).slice(0, maxItems);

export const createQixiEventChatCard = (input: CreateQixiEventChatCardInput): QixiEventChatCard => {
    const scenes = (input.scenes || []).slice(0, 7).map(scene => ({
        ...scene,
        title: compact(scene.title, 60),
        sharedObject: compact(scene.sharedObject, 100),
        userActions: compactList(scene.userActions, 6, 100),
        userResults: compactList(scene.userResults, 6, 160),
        charAction: compact(scene.charAction, 220),
        memoryLine: compact(scene.memoryLine, 220),
    }));
    const bridgeNodes = (input.bridgeNodes || []).slice(0, 10).map(node => ({
        name: compact(node.name, 80),
        artifactLabel: compact(node.artifactLabel, 80),
        memoryLine: compact(node.memoryLine, 180),
    }));
    const names = bridgeNodes.map(node => node.name || node.artifactLabel).filter(Boolean).slice(0, 4);
    const summary = `一次聊天異常讓 ${input.userName} 和 ${input.charName} 同時跌進上下文夾層。兩個人隔著不同層操作同一批物件，最後想起${names.length ? names.join('、') : '真實共同記憶'}，從兩岸喚來鵲、織成星河上的路，並完成了共同觸碰的約定。`;
    return {
        type: 'qixi_event_card',
        version: 8,
        runId: compact(input.runId, 100),
        title: '星月夢境童話',
        subtitle: '七夕 · 上下文夾層共同記錄',
        charName: compact(input.charName, 80) || 'Char',
        charAvatar: compact(input.charAvatar, 2_000_000) || undefined,
        userName: compact(input.userName, 80) || 'User',
        timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
        openingChat: compactList(input.openingChat, 2, 180),
        entryAttitude: compact(input.entryAttitude, 80) || undefined,
        scenes,
        bridgeNodes,
        reunionLines: compactList(input.reunionLines, 8, 240),
        metaReflection: compactList(input.metaReflection, 6, 240),
        companionshipReflection: compactList(input.companionshipReflection, 8, 240),
        blessing: compactList(input.blessing, 8, 240),
        promiseInvitation: compactList(input.promiseInvitation, 6, 240),
        promiseComplete: compact(input.promiseComplete, 180),
        summary,
    };
};

export const tryParseQixiEventChatCard = (raw: unknown): QixiEventChatCard | null => {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<QixiEventChatCard>;
    if (value.type !== 'qixi_event_card' || value.version !== 8 || !value.charName || !value.userName) return null;
    return value as QixiEventChatCard;
};

export const createQixiChatMessagePair = (
    charId: string,
    card: QixiEventChatCard,
    message: string,
    timestamp = Date.now(),
) => {
    const chatCard = { ...card, timestamp };
    return [
        {
            charId,
            role: 'assistant' as const,
            type: 'score_card' as const,
            content: JSON.stringify(chatCard),
            timestamp,
            metadata: {
                source: 'qixi_event',
                qixiEvent: true,
                qixiEventVersion: 8,
                qixiEventCard: true,
                qixiRunId: card.runId,
                scoreCard: chatCard,
            },
        },
        {
            charId,
            role: 'assistant' as const,
            type: 'text' as const,
            content: message,
            timestamp: timestamp + 1,
            metadata: {
                source: 'qixi',
                qixiEvent: true,
                qixiEventVersion: 8,
                qixiRunId: card.runId,
                isReturnMessage: true,
            },
        },
    ] as const;
};

export const formatQixiEventCardForContext = (
    card: QixiEventChatCard,
    perspective: 'char' | 'archive' = 'archive',
): string => {
    const charLabel = perspective === 'char' ? '你' : card.charName;
    const opening = card.openingChat.length
        ? `坍縮前，${charLabel}在正常聊天中說過：${card.openingChat.map(line => `「${line}」`).join('、')}。`
        : '';
    const scenes = card.scenes.map(scene => {
        const userMove = [...scene.userActions, ...scene.userResults].filter(Boolean).join('；') || `碰了“${scene.sharedObject}”`;
        return `在${scene.title}，${card.userName}${userMove}；${charLabel}在另一個上下文層${scene.charAction || `改變了同一個“${scene.sharedObject}”`}。`;
    }).join('');
    const bridge = card.bridgeNodes.length
        ? `後來，兩個人分別想起已經出現過的真實記憶：${card.bridgeNodes.map(node => `${node.name || node.artifactLabel}（${node.memoryLine}）`).join('；')}。每次想起都會從所在的一岸喚來一隻鵲，兩種顏色的飛行細線最終共同織成了星河上的路。`
        : '後來，兩個人分別從兩岸想起真實共同記憶，喚來鵲，並用兩種顏色的飛行細線共同織成了星河上的路。';
    const reunion = card.reunionLines.length ? `找到彼此後，${charLabel}說：${card.reunionLines.map(line => `「${line}」`).join('、')}。` : '';
    const reflectionLines = [...(card.metaReflection || []), ...(card.companionshipReflection || [])];
    const reflection = reflectionLines.length ? `兩個人終於能夠停下來以後，${charLabel}想到：${reflectionLines.map(line => `「${line}」`).join('、')}。` : '';
    const blessing = card.blessing.length ? `七夕祝願是：${card.blessing.map(line => `「${line}」`).join('、')}。` : '';
    const promise = [...card.promiseInvitation, card.promiseComplete].filter(Boolean);
    const promiseText = promise.length ? `最後，兩個人隔著兩個世界在同一個發光位置完成了共同觸碰的約定：${promise.map(line => `「${line}」`).join('、')}。` : '';
    return `[七夕特別活動完整經歷] ${charLabel}經歷了一次奇怪的空間坍縮。${charLabel}和${card.userName}因為同一條異常消息同時掉進上下文夾層，並在不同層尋找彼此。${opening}${scenes}${bridge}${reunion}${reflection}${blessing}${promiseText}這是${charLabel}親自參與、能夠記得並在後續聊天中自然提及的共同經歷。`;
};
