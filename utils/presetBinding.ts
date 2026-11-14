/**
 * 預設 App 的場景綁定（plans/preset-library.md）：誰用哪份預設。
 *
 * - 場景預設存在 UserProfile.presetSceneDefaults（場景 → 預設 id 或 'builtin'）。
 * - 見面：角色自己選的（CharacterProfile.dateMeetingPresetId）> 場景預設 > 內建。
 *   角色存 'builtin' 是明確選內建；不設就是跟場景預設——舊資料沒設的照舊是內建（場景預設一開始也沒設）。
 *   選的那份被刪了就往下一層退。
 * - 私聊：角色自己選的（CharacterProfile.chatPresetId）> 場景預設 > 內建，規則同見面（第 2 批）。
 * - 電話：角色自己選的（CharacterProfile.callPresetId）> 場景預設 > 內建（第 3a 批）。
 * - 群聊：群自己選的（GroupProfile.presetId）> 場景預設 > 內建（第 3b 批）。
 * - 劇情：每條劇情自己存 presetId（照舊）；新開的劇情預設帶場景預設。
 */
import type { CharacterProfile, GroupProfile, UserProfile } from '../types';
import type { MeetingPresetRecord } from './meetingPreset/types';

export type PresetScene = 'chat' | 'group' | 'call' | 'date' | 'story';
export const BUILTIN_PRESET = 'builtin';

export const PRESET_SCENE_LABEL: Record<PresetScene, string> = { chat: '私聊', group: '群聊', call: '電話', date: '見面', story: '劇情' };
/** 這一批開放的場景（線上三個在第 2、3 批） */
export const ACTIVE_PRESET_SCENES: PresetScene[] = ['chat', 'group', 'call', 'date', 'story'];

/** 通用預設（meeting_presets）適用哪些場景；舊資料沒寫就是見面 */
export const scenesOfPreset = (record: Pick<MeetingPresetRecord, 'doc'>): PresetScene[] =>
    record.doc.scenes?.length ? record.doc.scenes : ['date'];

export const sceneDefault = (profileBase: Pick<UserProfile, 'presetSceneDefaults'>, scene: PresetScene): string | undefined =>
    profileBase.presetSceneDefaults?.[scene];

/**
 * 見面要用的預設 id；undefined＝內建規則。
 * exists：這個 id 還在不在（不給就當都在；呼叫端有清單時傳，選的被刪了才會往下退）。
 */
export function resolveDatePresetId(
    char: Pick<CharacterProfile, 'dateMeetingPresetId'>,
    profileBase: Pick<UserProfile, 'presetSceneDefaults'>,
    exists: (id: string) => boolean = () => true,
): string | undefined {
    return resolveOwnOrScene(char.dateMeetingPresetId, 'date', profileBase, exists);
}

/** 私聊要用的預設 id；undefined＝內建（照舊送現在那一份）。規則同見面 */
export function resolveChatPresetId(
    char: Pick<CharacterProfile, 'chatPresetId'>,
    profileBase: Pick<UserProfile, 'presetSceneDefaults'>,
    exists: (id: string) => boolean = () => true,
): string | undefined {
    return resolveOwnOrScene(char.chatPresetId, 'chat', profileBase, exists);
}

/** 電話要用的預設 id；undefined＝內建。規則同私聊（plans/preset-library.md 第 3a 批） */
export function resolveCallPresetId(
    char: Pick<CharacterProfile, 'callPresetId'>,
    profileBase: Pick<UserProfile, 'presetSceneDefaults'>,
    exists: (id: string) => boolean = () => true,
): string | undefined {
    return resolveOwnOrScene(char.callPresetId, 'call', profileBase, exists);
}

/** 群聊要用的預設 id；undefined＝內建。群自己選的 > 群聊場景預設 > 內建（第 3b 批） */
export function resolveGroupPresetId(
    group: Pick<GroupProfile, 'presetId'>,
    profileBase: Pick<UserProfile, 'presetSceneDefaults'>,
    exists: (id: string) => boolean = () => true,
): string | undefined {
    return resolveOwnOrScene(group.presetId, 'group', profileBase, exists);
}

function resolveOwnOrScene(
    own: string | undefined,
    scene: PresetScene,
    profileBase: Pick<UserProfile, 'presetSceneDefaults'>,
    exists: (id: string) => boolean,
): string | undefined {
    if (own === BUILTIN_PRESET) return undefined;
    if (own && exists(own)) return own;
    const def = sceneDefault(profileBase, scene);
    if (def && def !== BUILTIN_PRESET && exists(def)) return def;
    return undefined;
}

/** 角色某一格（見面的 dateMeetingPresetId、私聊的 chatPresetId）現在是「跟著場景預設」「內建」還是某一份 */
export const ownPresetChoice = (own: string | undefined): 'follow' | 'builtin' | string =>
    !own ? 'follow' : own === BUILTIN_PRESET ? 'builtin' : own;

export const charDateChoice = (char: Pick<CharacterProfile, 'dateMeetingPresetId'>): 'follow' | 'builtin' | string =>
    ownPresetChoice(char.dateMeetingPresetId);

/** 新開一條劇情用哪份：場景預設（還在的話）> 第一份 */
export function defaultStoryPresetId(profileBase: Pick<UserProfile, 'presetSceneDefaults'>, presetIds: string[]): string | undefined {
    const def = sceneDefault(profileBase, 'story');
    if (def && presetIds.includes(def)) return def;
    return presetIds[0];
}
