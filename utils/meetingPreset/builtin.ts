/**
 * 「內建規則」寫成一份預設：給用戶複製出來自己調（plans/offline-date-redesign.md「預設」那行）。
 *
 * 內容跟內建模式送的是同一份來源（utils/datePrompts.ts 的常數和拼法），條目照內建模式的順序：
 * 先是角色上下文（ST 和 Soren 的佔位），再是散文框架、格式、語氣標籤、文風、深挖、人稱、
 * 額外要求、「聽得到／看得到什麼」、大綱／前情提要／字數、場景上下文，最後是聊天記錄和每輪的提醒。
 *
 * - 五種文風、三種人稱都放進去，只開角色現在選的那個；想換就開關，不用回設定頁
 * - 名字一律寫成 {{char}}／{{user}}，複製出來的這份所有角色都能用
 * - 每輪提醒的線索用 {{random::…}}，跟內建模式一樣每輪換一條（深挖關掉就關著）
 * - 拉黑中見面的說明、固定台詞、SAR 模塊這些走 Soren 的「其它」佔位，跟匯入的預設一樣
 *
 * 內建模式本身還是走 DatePrompts.buildSessionPayload；這份只是複製出來的起點，不回頭影響內建模式。
 */

import type { DateStyleConfig } from '../../types';
import {
    buildDateTurnNote,
    buildPovBlock,
    DATE_FORMAT_RULES,
    DATE_PROSE_INTRO,
    DATE_SCENE_LINES,
    DATE_STYLE_PRESETS,
    DIG_DEEPER_BLOCK,
    DIG_FOCUS_HINTS,
} from '../datePrompts';
import { buildDateInputPerceptionRule } from '../dateUserInput';
import type { MeetingPresetDoc, MeetingPresetGroup, MeetingPresetPrompt, MeetingPresetSlot } from './types';

export const BUILTIN_PRESET_NAME = '內建規則';

const POV_OPTIONS: Array<{ id: NonNullable<DateStyleConfig['pov']>; label: string }> = [
    { id: 'third-name', label: '第三人稱（都叫名字）' },
    { id: 'third-you', label: '第三人稱＋稱對方「你」' },
    { id: 'first-you', label: '第一人稱（我／你）' },
];

const slot = (id: MeetingPresetSlot, name: string): MeetingPresetPrompt =>
    ({ id, name, enabled: true, role: 'system', content: '', slot: id });

const text = (id: string, name: string, content: string, enabled = true): MeetingPresetPrompt =>
    ({ id, name, enabled, role: 'system', content: content.trim() });

export const buildBuiltinMeetingPresetDoc = (config?: DateStyleConfig): MeetingPresetDoc => {
    const styleId = config?.style || 'cinematic';
    const chosenStyle = DATE_STYLE_PRESETS.some(p => p.id === styleId) ? styleId : DATE_STYLE_PRESETS[0].id;
    const digOn = config?.digDeeper !== false;
    const extra = (config?.extra || '').trim();

    const context = [
        slot('worldInfoBefore', '世界書（角色設定前）'),
        slot('charDescription', '角色描述'),
        slot('charPersonality', '角色設定'),
        slot('worldInfoAfter', '世界書（角色設定後）'),
        slot('dialogueExamples', '對話示例'),
        slot('personaDescription', '用戶描述'),
        slot('memory', '記憶'),
        slot('emotion', '情緒'),
        slot('time', '時間'),
        slot('soren', '其它（印象、拉黑說明、SAR、固定台詞）'),
    ];
    const frame = [
        text('builtin_intro', '面對面 · 散文敘事', DATE_PROSE_INTRO),
        text('builtin_format', '格式', DATE_FORMAT_RULES),
        slot('voice', '語氣標籤'),
    ];
    const styles = DATE_STYLE_PRESETS.map(preset =>
        text(`builtin_style_${preset.id}`, `文風：${preset.label}`, preset.block, preset.id === chosenStyle));
    const craft = [
        text('builtin_dig', '深挖，別填充', DIG_DEEPER_BLOCK, digOn),
    ];
    const povs = POV_OPTIONS.map(option =>
        text(`builtin_pov_${option.id}`, `人稱：${option.label}`, buildPovBlock({ pov: option.id }, '{{char}}', '{{user}}'), config?.pov === option.id));
    const tail = [
        text('builtin_extra', '用戶對文風的額外要求', `### 用戶對文風的額外要求（優先級高於風格預設）\n${extra || '（在這裡寫）'}`, !!extra),
        text('builtin_perception', '你聽得到什麼、看得到什麼', buildDateInputPerceptionRule('{{user}}')),
        slot('scenario', '劇情大綱'),
        slot('recap', '前情提要'),
        slot('length', '回應字數'),
        text('builtin_scene', '場景上下文', `### 場景上下文\n${DATE_SCENE_LINES}`),
        slot('chatHistory', '聊天記錄'),
    ];
    const turnNote: MeetingPresetPrompt = {
        ...text('builtin_turn_note', '每輪提醒', buildDateTurnNote('send', false, `{{random::${DIG_FOCUS_HINTS.join('::')}}}`)),
        inChat: { depth: 0, order: 100 },
    };
    const turnNotePlain: MeetingPresetPrompt = {
        ...text('builtin_turn_note_plain', '每輪提醒（不帶線索）', buildDateTurnNote('send', false, '')),
        enabled: !digOn,
        inChat: { depth: 0, order: 100 },
    };
    turnNote.enabled = digOn;

    const prompts = [...context, ...frame, ...styles, ...craft, ...povs, ...tail, turnNote, turnNotePlain];
    const ids = (list: MeetingPresetPrompt[]) => list.map(p => p.id);
    const groups: MeetingPresetGroup[] = [
        { id: 'builtin_g_context', name: '角色與記憶（Soren 填）', promptIds: ids(context) },
        { id: 'builtin_g_frame', name: '見面框架', promptIds: [...ids(frame), 'builtin_perception', 'builtin_scene'] },
        { id: 'builtin_g_style', name: '文風（開一個）', promptIds: ids(styles) },
        { id: 'builtin_g_pov', name: '敘事人稱（開一個，全關＝不指定）', promptIds: ids(povs) },
        { id: 'builtin_g_craft', name: '寫法與每輪提醒', promptIds: [...ids(craft), 'builtin_extra', 'builtin_turn_note', 'builtin_turn_note_plain'] },
        { id: 'builtin_g_story', name: '這場故事', promptIds: ['scenario', 'recap', 'length', 'chatHistory'] },
    ];

    return {
        schema: 'soren.meeting-preset',
        version: 1,
        name: BUILTIN_PRESET_NAME,
        generation: {},
        prompts,
        regexScripts: [],
        groups,
        globalVars: {},
    };
};
