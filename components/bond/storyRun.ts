/**
 * 角色之間「讓 AI 寫他們的故事」跑在 App 裡的那一半（plans/bond-batch6.md 第 2 節）：
 * 把兩人的人設、這段關係、前情、時間線、最近的私下聊天組好，叫 AI 寫一章；存下時寫摘要；首頁的讀者視角概覽。
 * 提示詞本體與解析在 utils/bond/story.ts。
 */
import type { APIConfig, BondEntry, CharacterProfile, Message } from '../../types';
import type { ResolvedSpace } from './space';
import type { TimelineItem } from '../../utils/bond/timeline';
import { ContextBuilder } from '../../utils/context';
import { resolveCharacterChatApi } from '../../utils/characterApi';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { routeLabel, stageLabel } from '../../utils/bond/routes';
import { milestoneLabel } from '../../utils/bond/pact';
import { formatEventDate } from '../../utils/bond/eventDate';
import {
    buildOverviewPrompt, buildStoryPrompt, buildStorySummaryPrompt, cleanStorySummary, parseStory, storyChapters, storyRouteLock, storyTail,
} from '../../utils/bond/story';
import { loadCollectLine } from './BondCollectPage';
import { messagePlainText } from '../../utils/bond/collect';
import { pairSpeakerOf } from '../../utils/pairLine';

type Api = { baseUrl: string; apiKey: string; model: string };

const meterApiOf = (apiConfig: APIConfig): Api | null => globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);

async function ask(api: Api, messages: Array<{ role: string; content: string }>, opts: { maxTokens: number; temperature: number; charId: string; charName: string; purpose: string; signal?: AbortSignal }): Promise<string> {
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages, temperature: opts.temperature, max_tokens: opts.maxTokens }),
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, 1, 240_000, { appName: '羈絆', charId: opts.charId, charName: opts.charName, purpose: opts.purpose });
    return extractContent(data);
}

/** 路線與階段的一行（「戀愛線・交往中」）；未指定又是預設就不寫 */
export function relationLineOf(space: ResolvedSpace): string | undefined {
    const b = space.bond;
    if (!b.route && b.stage === 'friend' && !b.stageLabel) return undefined;
    return `${routeLabel(b.route)}・${stageLabel(b)}`;
}

/** 他們怎麼看對方（角色卡上的關係描述） */
export function pairViewLines(space: ResolvedSpace): string[] {
    const a = space.char, b = space.other;
    if (!b) return [];
    const ab = a.relationships?.find(r => r.targetId === b.id)?.description?.trim();
    const ba = b.relationships?.find(r => r.targetId === a.id)?.description?.trim();
    return [ab ? `${a.name}眼中的${b.name}：${ab}` : '', ba ? `${b.name}眼中的${a.name}：${ba}` : ''].filter(Boolean);
}

/** 時間線上已經發生的（拾光、約定、禮物、信），一件一行；故事、隨筆、日記這些感想或作品不算 */
export function happenedLines(items: TimelineItem[], entries: BondEntry[], limit = 30): string[] {
    const out: string[] = [];
    for (const it of items) {
        if (it.hidden || it.kind === 'essay') continue;
        const head = it.title?.trim() ? `${it.title.trim()}：${it.text}` : it.text;
        out.push(`${formatEventDate(it.eventDate)}　${head.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    for (const e of entries) {
        if (e.status !== 'published') continue;
        if (e.kind === 'wish' && e.wish) out.push(`願望：${e.text}`);
        else if (e.kind === 'promise' && e.promise && e.promise.state !== 'dropped' && e.promise.state !== 'proposed') out.push(`約定：${e.text}`);
        else if (e.kind === 'habit' && e.habit && e.habit.state === 'active') out.push(`默契：${e.text}`);
        else if (e.kind === 'gift' && e.gift) out.push(`禮物：${e.title || e.text}`);
        else if (e.kind === 'letter' && e.letter) out.push(`信：${e.text.replace(/\s+/g, ' ').slice(0, 40)}…`);
        else if (e.kind === 'milestone' && e.milestone && !items.some(i => i.key === `e:${e.id}`)) out.push(`里程碑：${milestoneLabel(e.milestone.what)}${e.text ? `・${e.text}` : ''}`);
    }
    return out.slice(-limit);
}

/** 最近的私下聊天（角色私聊線最後幾則） */
export async function recentPairChat(space: ResolvedSpace, characters: CharacterProfile[], limit = 40): Promise<string[]> {
    const msgs = await loadCollectLine({ kind: 'pair', lineId: space.id }).catch(() => [] as Message[]);
    return msgs.slice(-limit).map(m => {
        const who = characters.find(c => c.id === pairSpeakerOf(m))?.name || '某人';
        return `${who}：${messagePlainText(m).replace(/\s+/g, ' ').slice(0, 200)}`;
    }).filter(l => !l.endsWith('：'));
}

export interface StoryRunInput {
    space: ResolvedSpace;
    characters: CharacterProfile[];
    items: TimelineItem[];
    entries: BondEntry[];
    apiConfig: APIConfig;
    chapter: number;
    pov: string;
    direction?: string;
    scene?: string;
    words: [number, number];
    style?: string;
    standalone?: boolean;
    signal?: AbortSignal;
}

/** 寫一章：回傳章名與正文（草稿，存下才算數） */
export async function runStory(input: StoryRunInput): Promise<{ title: string; text: string }> {
    const { space, characters } = input;
    const a = space.char, b = space.other;
    if (!b) throw new Error('這段關係裡少了一個人');
    const api = resolveCharacterChatApi(a, input.apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('還沒設定 API');
    const chapters = storyChapters(input.entries).filter(e => e.story!.chapter < input.chapter);
    const last = chapters.at(-1);
    const povName = input.pov === 'narrator' ? undefined : characters.find(c => c.id === input.pov)?.name;
    const prompt = buildStoryPrompt({
        aName: a.name, bName: b.name, povName, direction: input.direction, scene: input.scene, words: input.words, style: input.style,
        relationLine: relationLineOf(space), views: pairViewLines(space),
        prev: chapters.map(e => ({ chapter: e.story!.chapter, title: e.title || '', summary: e.story!.summary })),
        lastTail: last ? storyTail(last.text) : undefined,
        timeline: happenedLines(input.items, input.entries),
        recentChat: await recentPairChat(space, characters),
        chapter: input.chapter, standalone: input.standalone,
        todayText: formatEventDate({ precision: 'day', date: space.todayKey }),
    });
    const system = [
        '你是一位小說作者，替讀者寫兩個角色之間的故事。下面是兩個角色的設定，照設定寫他們的言行。',
        `【${a.name} 的角色設定】\n${ContextBuilder.buildRoleSettingsContext(a, { skipMemories: true })}`,
        `【${b.name} 的角色設定】\n${ContextBuilder.buildRoleSettingsContext(b, { skipMemories: true })}`,
    ].join('\n\n');
    const lock = storyRouteLock(space.bond.route, a.name, b.name);
    const maxTokens = Math.min(16000, Math.max(2000, Math.round(input.words[1] * 2.2) + 600));
    const raw = await ask(api, [
        { role: 'system', content: system },
        { role: 'user', content: lock ? `${prompt}\n\n${lock}` : prompt },
    ], { maxTokens, temperature: 0.9, charId: a.id, charName: a.name, purpose: '他們的故事', signal: input.signal });
    const parsed = parseStory(raw);
    if (!parsed) throw new Error('這次沒寫出東西，再試一次');
    return parsed;
}

/** 存下時寫摘要（副 API；寫不出來就退回正文開頭） */
export async function summarizeStory(space: ResolvedSpace, apiConfig: APIConfig, title: string, text: string): Promise<string> {
    const b = space.other;
    const api = meterApiOf(apiConfig);
    const fallback = text.replace(/\s+/g, ' ').slice(0, 120);
    if (!api || !b) return fallback;
    try {
        const raw = await ask(api, [{ role: 'user', content: buildStorySummaryPrompt({ aName: space.char.name, bName: b.name, title, text }) }],
            { maxTokens: 500, temperature: 0.3, charId: space.char.id, charName: space.char.name, purpose: '故事摘要' });
        return cleanStorySummary(raw) || fallback;
    } catch {
        return fallback;
    }
}

/** 讀者視角的概覽 */
export async function runOverview(space: ResolvedSpace, apiConfig: APIConfig, items: TimelineItem[], entries: BondEntry[]): Promise<string> {
    const b = space.other;
    if (!b) throw new Error('這段關係裡少了一個人');
    const api = meterApiOf(apiConfig);
    if (!api) throw new Error('還沒設定 API');
    const raw = await ask(api, [{ role: 'user', content: buildOverviewPrompt({
        aName: space.char.name, bName: b.name, relationLine: relationLineOf(space),
        chapters: storyChapters(entries).map(e => ({ chapter: e.story!.chapter, title: e.title || '', summary: e.story!.summary })),
        timeline: happenedLines(items, entries, 20),
    }) }], { maxTokens: 900, temperature: 0.6, charId: space.char.id, charName: space.char.name, purpose: '關係概覽' });
    const text = cleanStorySummary(raw);
    if (!text) throw new Error('這次沒寫出來，再試一次');
    return text;
}
