/**
 * 劇情裡一個演員的檔案塊怎麼組（plans/story-multi-persona.md 第 2 批）。
 * 讀資料庫、召回記憶、組核心人設都由呼叫端給進來，這裡只管「照哪條線、放哪幾段、聲明寫什麼」，好單獨測。
 */

import type { CharacterProfile, Message, UserProfile } from '../types';
import { withLineFields } from './chatLine';
import { buildStoryActorPresenceNote, storyActorLineView, storyActorPresence, storyPresentLinkLines } from './storyActorView';
import { buildStoryActorMemoryEnvelope, formatActorRecentMessages } from './storyTheater';
import { personaNameForKey, resolveUserProfileForChar } from './userPersona';

export interface StoryActorBlockInput {
    actor: CharacterProfile;
    profileBase: UserProfile;
    /** 在場的身份卡（身份鍵）；面具、你演的角色不算 */
    presentPersonaKeys: string[];
    /** 用戶側在場每一位的名字（含面具、你演的角色） */
    identityNames: string[];
    /** 只要一個稱呼的地方用的：一位照他的名字，好幾位用頓號接，旁觀是「作者」 */
    identityLabel: string;
    /** 這場戲沒有用戶側的人物 */
    lurking: boolean;
    /** 劇情線程的訊息（找最近執筆的是誰） */
    storyMsgs: Array<Pick<Message, 'role' | 'metadata'>>;
    /** 這條線（角色視圖）最近的聊天 */
    loadRecent: (view: CharacterProfile) => Promise<Message[]>;
    /** 記憶宮殿召回（原文）；沒開、沒設就回空字串。別條線的記憶要照 view 加標籤 */
    recall: (view: CharacterProfile, recent: Message[], userName: string) => Promise<string>;
    /** 核心人設那一大段 */
    buildCore: (view: CharacterProfile, profile: UserProfile, recalled: string) => string;
    /** 某條線的印象與長期記憶（給「你也認識在場的某某」那段） */
    lineSections: (view: CharacterProfile, profile: UserProfile) => { impression: string; bond?: string; memoryBank: string };
}

export async function buildStoryActorBlock(input: StoryActorBlockInput): Promise<string> {
    const actor = withLineFields(input.profileBase, input.actor);
    const seen = storyActorPresence(actor, input.presentPersonaKeys, input.storyMsgs);
    const view = storyActorLineView(actor, seen.focalKey);
    // 這條線上的你：主看的那位；一張在場的卡都不認識時，是它私下認識、這場戲不在的那位
    const knownProfile = resolveUserProfileForChar(input.profileBase, view);
    const othersThan = (name: string) => input.identityNames.filter(item => item !== name);
    const identityOpts = seen.focalKey
        ? { othersPresent: othersThan(knownProfile.name) }
        // 有身份卡在場、但都不是它認識的人，或這場戲沒有用戶側的人物：它認識的那位不在場。
        // 只有面具／你演的角色在場時照舊（當前身份另有其人）。
        : { absent: input.lurking || seen.strangers.length > 0 };
    const currentName = seen.focalKey ? knownProfile.name : input.identityLabel;

    const recent = await input.loadRecent(view);
    const rawRecall = await input.recall(view, recent, knownProfile.name);
    const recalled = rawRecall ? buildStoryActorMemoryEnvelope(actor.name, rawRecall, knownProfile.name, currentName, identityOpts) : '';
    const core = input.buildCore(view, knownProfile, recalled);
    const parts = [`${core}\n${formatActorRecentMessages(view, recent, knownProfile.name, currentName, identityOpts)}`.trim()];

    // 它也認識、也在場的其他卡：那條線的印象、長期記憶，和那條線的最近聊天
    const extras: Array<{ name: string; about: string }> = [];
    for (const key of seen.extraKeys) {
        const lineActor = storyActorLineView(actor, key);
        const lineProfile = resolveUserProfileForChar(input.profileBase, lineActor);
        const sections = input.lineSections(lineActor, lineProfile);
        // 這條線沒有記憶時那段只是一句佔位，不放
        const about = [sections.impression, sections.bond || '', sections.memoryBank.includes('暫無特定記憶') ? '' : sections.memoryBank]
            .join('').trim().split('\n').filter(Boolean).map(line => `  ${line}`).join('\n');
        extras.push({ name: lineProfile.name, about });
        const lineRecent = await input.loadRecent(lineActor).catch(() => [] as Message[]);
        const lineBlock = formatActorRecentMessages(lineActor, lineRecent, lineProfile.name, lineProfile.name, { othersPresent: othersThan(lineProfile.name) });
        if (lineBlock) parts.push(lineBlock);
    }

    const note = buildStoryActorPresenceNote({
        actorName: actor.name,
        focalName: seen.focalKey ? knownProfile.name : undefined,
        multi: input.identityNames.length >= 2,
        extras,
        strangerNames: seen.strangers.map(key => personaNameForKey(input.profileBase, key)),
        absentKnownName: seen.focalKey ? undefined : knownProfile.name,
        linkLines: storyPresentLinkLines(actor, input.profileBase, input.presentPersonaKeys),
    });
    if (note) parts.push(note);
    return parts.join('\n\n');
}
