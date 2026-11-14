/**
 * 預設條目裡資料佔位／Soren 功能的名字，和關掉功能條目的後果。
 * 預設編輯頁（MeetingPresetManager）和 Sore（utils/assistant/presetOps.ts）共用這一份。
 */
import type { MeetingPresetSlot } from './types';
import { CHAT_FEATURE_OFF_WARNING, CHAT_SLOT_LABELS } from '../chatPresetSession';
import { CALL_FEATURE_OFF_WARNING, CALL_SLOT_LABELS } from '../callPresetSession';
import { GROUP_SLOT_LABELS } from '../groupPresetSession';

export const PRESET_SLOT_LABELS: Record<MeetingPresetSlot, string> = {
    worldInfoBefore: '世界書（前）',
    worldInfoAfter: '世界書（後）',
    charDescription: '角色描述',
    charPersonality: '角色設定',
    scenario: '場景',
    personaDescription: '用戶描述',
    dialogueExamples: '對話示例',
    chatHistory: '聊天記錄',
    memory: 'Soren · 記憶',
    recap: 'Soren · 前情提要',
    time: 'Soren · 時間',
    emotion: 'Soren · 情緒',
    voice: 'Soren · 語氣標籤',
    length: 'Soren · 回應字數',
    soren: 'Soren · 其它',
    ...CHAT_SLOT_LABELS,
    ...CALL_SLOT_LABELS,
    ...GROUP_SLOT_LABELS,
};

/** Soren 功能條目（私聊、電話）：內容由程式產生，關掉要講後果 */
export const PRESET_FEATURE_OFF_WARNING: Partial<Record<MeetingPresetSlot, string>> = { ...CHAT_FEATURE_OFF_WARNING, ...CALL_FEATURE_OFF_WARNING };

export const isPresetFeatureSlot = (slot: MeetingPresetSlot | undefined): slot is MeetingPresetSlot => !!slot && slot in PRESET_FEATURE_OFF_WARNING;
