/**
 * 角色之間的故事存下後「回寫各區」跑在 App 裡的那一半（plans/bond-batch6.md 2.3、2.4）：
 * 先備清單（副 API 抽事件；兩人各用自己的主 API 寫日記與記憶；故事裡有信的，寄信的那位另外寫全文），
 * 你勾完再寫：卡片進 bond_entries、轉折進承認卡、記憶進兩邊的話題盒與記憶宮殿，寫到哪記在這一章的 `story.derived`。
 * 純邏輯在 utils/bond/storyExtract.ts。
 */
import type { APIConfig, BondEntry, CharacterProfile, ConvTopic } from '../../types';
import type { ResolvedSpace } from './space';
import { ContextBuilder } from '../../utils/context';
import { resolveCharacterChatApi } from '../../utils/characterApi';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { milestoneLabel } from '../../utils/bond/pact';
import { relationLineOf } from './storyRun';
import { saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { addProposal } from './eventCardRun';
import { contactOf, sendPairMemoriesToPalace } from '../../utils/pairChatRun';
import { normName, upsertContact } from '../../utils/relationshipChat';
import { trackEvent } from '../../utils/analytics';
import {
    STORY_WRITE_ORDER, buildStoryExtractPrompt, buildStoryLetterPrompt, buildStoryPersonalPrompt, cleanStoryLetter, countBucket,
    parseStoryExtract, parseStoryPersonal, planStoryWriteback, storyCandidates, storyPalaceContent,
    type StorySide, type StoryWriteItem,
} from '../../utils/bond/storyExtract';

type Api = { baseUrl: string; apiKey: string; model: string };
type Updater = (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;

const meterApiOf = (apiConfig: APIConfig): Api | null => globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);

async function ask(api: Api, messages: Array<{ role: string; content: string }>, opts: { maxTokens: number; temperature: number; char: CharacterProfile; purpose: string; signal?: AbortSignal }): Promise<string> {
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages, temperature: opts.temperature, max_tokens: opts.maxTokens }),
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, 1, 180_000, { appName: '羈絆', charId: opts.char.id, charName: opts.char.name, purpose: opts.purpose });
    return extractContent(data);
}

/** 用這個角色自己的主 API、帶他的人設寫 */
export async function askAs(char: CharacterProfile, apiConfig: APIConfig, prompt: string, maxTokens: number, purpose: string, signal?: AbortSignal): Promise<string> {
    const api = resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('還沒設定 API');
    return ask(api, [
        { role: 'system', content: `你就是 ${char.name}。下面是你的設定，照設定的性格、口吻寫。\n\n${ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })}` },
        { role: 'user', content: prompt },
    ], { maxTokens, temperature: 0.85, char, purpose, signal });
}

export interface StoryWritebackDraft {
    items: StoryWriteItem[];
    /** 哪幾步沒成功（清單照樣給，少了那幾種） */
    failed: string[];
}

/** 備清單：抽事件、兩人各自的日記與記憶、信的全文 */
export async function prepareStoryWriteback(space: ResolvedSpace, story: BondEntry, entries: BondEntry[], apiConfig: APIConfig, signal?: AbortSignal): Promise<StoryWritebackDraft> {
    const a = space.char, b = space.other;
    if (!b) throw new Error('這段關係裡少了一個人');
    const failed: string[] = [];
    const meter = meterApiOf(apiConfig);
    const published = entries.filter(e => e.status === 'published' && e.id !== story.id);
    const known = {
        milestones: published.filter(e => e.kind === 'milestone' && e.milestone).map(e => milestoneLabel(e.milestone!.what, e.title)),
        wishes: published.filter(e => e.kind === 'wish').map(e => e.text.slice(0, 40)),
        promises: published.filter(e => e.kind === 'promise').map(e => e.text.slice(0, 40)),
        habits: published.filter(e => e.kind === 'habit').map(e => e.text.slice(0, 40)),
        gifts: published.filter(e => e.kind === 'gift').map(e => e.title || e.text.slice(0, 20)),
    };
    const nameOf = (s: StorySide) => (s === 'a' ? a.name : b.name);
    const povNote = (self: CharacterProfile) => (story.story?.pov && story.story.pov !== 'narrator'
        ? (story.story.pov === self.id ? '（這章是從你的眼睛寫的。）' : `（這章是從 ${story.story.pov === a.id ? a.name : b.name} 的眼睛寫的，你那時的心思要自己補。）`)
        : '');

    const extractP = (async (): Promise<StoryWriteItem[]> => {
        if (!meter) { failed.push('抽事件（沒有副 API）'); return []; }
        try {
            const raw = await ask(meter, [{ role: 'user', content: buildStoryExtractPrompt({
                aName: a.name, bName: b.name, title: story.title || '', text: story.text, route: space.bond.route, relationLine: relationLineOf(space), known,
            }) }], { maxTokens: 1800, temperature: 0.3, char: a, purpose: '故事回寫', signal });
            const ex = parseStoryExtract(raw, a.name, b.name);
            if (!ex) { failed.push('抽事件'); return []; }
            const knownWhats = published.filter(e => e.kind === 'milestone' && e.milestone).map(e => e.milestone!.what);
            return storyCandidates(ex, { route: space.bond.route, stage: space.bond.stage, knownWhats });
        } catch (e) {
            if (signal?.aborted) throw e;
            failed.push('抽事件');
            return [];
        }
    })();

    const personal = async (side: StorySide): Promise<StoryWriteItem[]> => {
        const self = side === 'a' ? a : b, other = side === 'a' ? b : a;
        try {
            const raw = await askAs(self, apiConfig, buildStoryPersonalPrompt({
                selfName: self.name, otherName: other.name, title: story.title || '', text: story.text, diary: true, povNote: povNote(self),
            }), 2200, '故事回寫', signal);
            const p = parseStoryPersonal(raw);
            if (!p) { failed.push(`${self.name}的日記與記憶`); return []; }
            return [
                ...(p.diary ? [{ key: `diary:${side}`, kind: 'diary' as const, side, text: p.diary }] : []),
                ...(p.memory ? [{ key: `memory:${side}`, kind: 'memory' as const, side, text: p.memory }] : []),
            ];
        } catch (e) {
            if (signal?.aborted) throw e;
            failed.push(`${self.name}的日記與記憶`);
            return [];
        }
    };

    const [extracted, pa, pb] = await Promise.all([extractP, personal('a'), personal('b')]);
    // 信：故事裡有人寫了信，寄信的那位另外寫全文
    const withLetters = await Promise.all(extracted.map(async it => {
        if (it.kind !== 'letter') return it;
        const from = it.from === 'a' ? a : b;
        try {
            const raw = await askAs(from, apiConfig, buildStoryLetterPrompt({
                fromName: from.name, toName: nameOf(it.from === 'a' ? 'b' : 'a'), about: it.about, title: story.title || '', summary: story.story?.summary || story.text.slice(0, 300),
            }), 1600, '故事回寫・信', signal);
            return { ...it, text: cleanStoryLetter(raw) };
        } catch (e) {
            if (signal?.aborted) throw e;
            failed.push(`${from.name}的信`);
            return it;
        }
    }));
    const items = [...withLetters, ...pa, ...pb].sort((x, y) => STORY_WRITE_ORDER.indexOf(x.kind) - STORY_WRITE_ORDER.indexOf(y.kind));
    if (!items.length && failed.length) throw new Error('這次沒整理出東西，再試一次');
    return { items, failed };
}

/** 照你勾的寫進去；回傳寫了幾張卡、幾張承認卡 */
export async function applyStoryWriteback(args: {
    space: ResolvedSpace; story: BondEntry; items: StoryWriteItem[]; apiConfig: APIConfig; updateCharacter: Updater;
}): Promise<{ entries: number; proposals: number; memories: number }> {
    const { space, story, items, apiConfig, updateCharacter } = args;
    const a = space.char, b = space.other;
    if (!b) throw new Error('這段關係裡少了一個人');
    const now = Date.now();
    const plan = planStoryWriteback(items, { bondId: space.id, storyId: story.id, aId: a.id, bId: b.id, eventDate: story.eventDate, now });
    if (plan.entries.length) await saveBondEntries(plan.entries);
    for (const p of plan.proposals) await addProposal(space.id, p);

    // 記憶：兩邊各自聯繫人的話題盒（第一人稱；沒有聯繫人就補一個）
    const happenedAt = story.eventDate.precision === 'day' ? new Date(`${story.eventDate.date}T21:00:00`).getTime() || now : now;
    const topics: Array<{ charId: string; topicId: string }> = [];
    const byChar: Array<{ owner: CharacterProfile; partner: CharacterProfile; topic: ConvTopic }> = [];
    for (const m of plan.memories) {
        const owner = m.side === 'a' ? a : b, partner = m.side === 'a' ? b : a;
        const topic: ConvTopic = { id: `tp-${now}-${Math.random().toString(36).slice(2, 7)}`, text: m.text, createdAt: happenedAt, storyId: story.id };
        byChar.push({ owner, partner, topic });
        topics.push({ charId: owner.id, topicId: topic.id });
        updateCharacter(owner.id, cur => {
            const contacts = cur.phoneState?.contacts || [];
            const has = contactOf(cur, partner);
            const base = has ? contacts : upsertContact(contacts, { name: partner.name, kind: 'real', linkedCharId: partner.id, avatar: partner.avatar });
            return {
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    contacts: base.map(c => (c.linkedCharId === partner.id || normName(c.name) === normName(partner.name)) ? { ...c, topicBox: [...(c.topicBox || []), topic] } : c),
                },
            };
        });
    }
    const latest = bondEntryById(story.id) || story;
    await saveBondEntry({
        ...latest, updatedAt: now,
        story: { ...latest.story!, extractedAt: now, derived: { ...latest.story!.derived, topics: [...(latest.story!.derived?.topics || []), ...topics] } },
    });

    // 記憶宮殿（開了才送；慢，背景跑完再把節點 id 記回這一章）
    if (byChar.length) {
        const meter = meterApiOf(apiConfig) || { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
        void (async () => {
            const palace: Array<{ charId: string; nodeId: string }> = [];
            for (const x of byChar) {
                const ids = await sendPairMemoriesToPalace(x.owner, x.partner, [{ content: storyPalaceContent(x.partner.name, x.topic.text), happenedAt: x.topic.createdAt }], meter as any, '角色故事');
                ids.forEach(nodeId => palace.push({ charId: x.owner.id, nodeId }));
            }
            if (!palace.length) return;
            const cur = bondEntryById(story.id);
            if (!cur?.story) return;
            await saveBondEntry({ ...cur, story: { ...cur.story, derived: { ...cur.story.derived, palace: [...(cur.story.derived?.palace || []), ...palace] } } });
        })().catch(e => console.warn('[他們的故事] 記憶宮殿沒寫成', e));
    }

    const count = (k: StoryWriteItem['kind'] | StoryWriteItem['kind'][]) => items.filter(i => (Array.isArray(k) ? k : [k]).includes(i.kind)).length;
    trackEvent('故事回写', {
        片刻: countBucket(count('moment')), 里程碑: countBucket(count('milestone')), 约定类: countBucket(count(['wish', 'promise', 'habit'])),
        礼物: countBucket(count('gift')), 信: countBucket(count('letter')), 日记: countBucket(count('diary')), 记忆: countBucket(count('memory')),
    });
    return { entries: plan.entries.length, proposals: plan.proposals.length, memories: plan.memories.length };
}
