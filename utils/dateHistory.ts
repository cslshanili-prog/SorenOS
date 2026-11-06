import type { DateStory, Message } from '../types';
import { dateStoryLabel, messageBelongsToStory } from './dateStory';

export type DateHistoryView = 'encounter' | 'date' | 'story';
export type DateHistorySortOrder = 'newest' | 'oldest';

export interface DateHistoryGroup {
    id: string;
    dateKey: string;
    startAt: number;
    endAt: number;
    messages: Message[];
    /** 按日期查看時，表示當天能識別到的見面開場數。 */
    encounterCount: number;
    /** 舊記錄可能沒有 isOpening，UI 用它提示這是兼容分組。 */
    hasOpeningAnchor: boolean;
    /** 按故事查看時，這組是哪一場（沒有就是故事功能之前的舊見面） */
    story?: DateStory;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

export const getLocalDateKey = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

export const formatDateHistoryDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${date.toLocaleDateString('zh-CN', { weekday: 'short' })}`;
};

export const formatDateHistoryTime = (timestamp: number, withDate = false): string => {
    const date = new Date(timestamp);
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return withDate ? `${getLocalDateKey(timestamp)} ${time}` : time;
};

const sortMessagesChronologically = (messages: Message[]): Message[] => (
    [...messages].sort((left, right) => left.timestamp - right.timestamp || left.id - right.id)
);

/**
 * 按“真實的一次見面”切分。
 *
 * 新記錄以 isOpening 作為可靠開場錨點：從該開場到下一條開場，無論相隔多久、
 * 是否跨過午夜，都仍屬於同一次見面。舊版沒有錨點的記錄只能按自然日期兼容分組，
 * 但不會再使用 30 分鐘等容易誤拆的間隔閾值。
 */
export function splitDateEncounters(messages: Message[]): DateHistoryGroup[] {
    const ordered = sortMessagesChronologically(messages);
    const groups: DateHistoryGroup[] = [];
    let current: Message[] = [];
    let currentHasOpening = false;

    const flush = () => {
        if (current.length === 0) return;
        const first = current[0];
        const last = current[current.length - 1];
        groups.push({
            id: currentHasOpening ? `encounter-${first.id}` : `legacy-${getLocalDateKey(first.timestamp)}-${first.id}`,
            dateKey: getLocalDateKey(first.timestamp),
            startAt: first.timestamp,
            endAt: last.timestamp,
            messages: current,
            encounterCount: currentHasOpening ? 1 : 0,
            hasOpeningAnchor: currentHasOpening,
        });
        current = [];
        currentHasOpening = false;
    };

    for (const message of ordered) {
        const isOpening = message.metadata?.isOpening === true;
        if (isOpening) {
            flush();
            current = [message];
            currentHasOpening = true;
            continue;
        }

        if (current.length === 0) {
            current = [message];
            continue;
        }

        // 沒有開場錨點的舊記錄按自然日期兜底；已錨定的一次見面不會因跨日被拆開。
        if (!currentHasOpening && getLocalDateKey(message.timestamp) !== getLocalDateKey(current[0].timestamp)) {
            flush();
        }
        current.push(message);
    }

    flush();
    return groups;
}

export function groupDateMessagesByDate(messages: Message[]): DateHistoryGroup[] {
    const ordered = sortMessagesChronologically(messages);
    const byDate = new Map<string, Message[]>();
    for (const message of ordered) {
        const key = getLocalDateKey(message.timestamp);
        const bucket = byDate.get(key) || [];
        bucket.push(message);
        byDate.set(key, bucket);
    }

    return Array.from(byDate.entries()).map(([dateKey, bucket]) => ({
        id: `date-${dateKey}`,
        dateKey,
        startAt: bucket[0].timestamp,
        endAt: bucket[bucket.length - 1].timestamp,
        messages: bucket,
        encounterCount: bucket.filter(message => message.metadata?.isOpening === true).length,
        hasOpeningAnchor: bucket.some(message => message.metadata?.isOpening === true),
    }));
}

/**
 * 按線下故事分組：屬於某場故事的訊息歸到那場；故事功能之前、沒轉成故事的舊見面照「按次」切。
 * 只會出現在已讀進來的訊息裡有的故事（一句都沒讀到的就不顯示）。
 */
export function groupDateMessagesByStory(messages: Message[], stories: DateStory[]): DateHistoryGroup[] {
    const ordered = sortMessagesChronologically(messages);
    const byStory = new Map<string, Message[]>();
    const rest: Message[] = [];
    for (const message of ordered) {
        const story = stories.find(candidate => messageBelongsToStory(message, candidate));
        if (!story) { rest.push(message); continue; }
        const bucket = byStory.get(story.id) || [];
        bucket.push(message);
        byStory.set(story.id, bucket);
    }
    const storyGroups: DateHistoryGroup[] = stories
        .filter(story => byStory.has(story.id))
        .map(story => {
            const bucket = byStory.get(story.id)!;
            return {
                id: `story-${story.id}`,
                dateKey: getLocalDateKey(bucket[0].timestamp),
                startAt: bucket[0].timestamp,
                endAt: bucket[bucket.length - 1].timestamp,
                messages: bucket,
                encounterCount: 1,
                hasOpeningAnchor: bucket.some(message => message.metadata?.isOpening === true),
                story,
            };
        });
    return [...storyGroups, ...splitDateEncounters(rest)].sort((a, b) => a.startAt - b.startAt);
}

export function buildDateHistoryGroups(
    messages: Message[],
    view: DateHistoryView,
    sortOrder: DateHistorySortOrder,
    stories: DateStory[] = [],
): DateHistoryGroup[] {
    const groups = view === 'encounter'
        ? splitDateEncounters(messages)
        : view === 'story'
            ? groupDateMessagesByStory(messages, stories)
            : groupDateMessagesByDate(messages);
    return sortOrder === 'newest' ? groups.reverse() : groups;
}

const exportedContent = (message: Message): string => {
    if (message.type === 'image') {
        const description = typeof message.metadata?.visionDescription === 'string'
            ? message.metadata.visionDescription.trim()
            : '';
        return description ? `[圖片：${description}]` : '[圖片]';
    }
    if (message.type === 'emoji') return message.content?.trim() ? `[表情] ${message.content.trim()}` : '[表情]';
    if (message.type === 'voice') return message.content?.trim() ? `[語音] ${message.content.trim()}` : '[語音]';
    return message.content?.trim() || '(無內容)';
};

export const DATE_HISTORY_VIEW_LABEL: Record<DateHistoryView, '按次' | '按日期' | '按故事'> = { encounter: '按次', date: '按日期', story: '按故事' };

export function formatDateHistoryExport(
    characterName: string,
    groups: DateHistoryGroup[],
    view: DateHistoryView,
): string {
    const lines: string[] = [
        `見面記錄 · ${characterName}`,
        `整理方式：${DATE_HISTORY_VIEW_LABEL[view]}`,
        `導出時間：${formatDateHistoryTime(Date.now(), true)}`,
        '',
    ];

    groups.forEach((group, index) => {
        const heading = view === 'date'
            ? formatDateHistoryDate(group.startAt)
            : group.story
                ? `${dateStoryLabel(group.story)}（${group.story.status === 'completed' ? '已完結' : '進行中'}） · ${formatDateHistoryTime(group.startAt, true)}`
                : `第 ${index + 1} 段 · ${formatDateHistoryTime(group.startAt, true)}`;
        lines.push(`===== ${heading} =====`);
        for (const message of group.messages) {
            const speaker = message.role === 'user'
                ? '我'
                : message.role === 'assistant' ? characterName : '系統';
            lines.push(`[${formatDateHistoryTime(message.timestamp, true)}] ${speaker}：${exportedContent(message)}`);
        }
        if (index < groups.length - 1) lines.push('');
    });

    return `\uFEFF${lines.join('\n')}`;
}

export function makeDateHistoryFileName(characterName: string, scope: string): string {
    const safeName = characterName.replace(/[\\/:*?"<>|]/g, '_').trim() || '角色';
    return `${safeName}_見面記錄_${scope}_${getLocalDateKey(Date.now())}.txt`;
}
