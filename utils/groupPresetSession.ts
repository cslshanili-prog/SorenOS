/**
 * 群聊的自訂預設（plans/preset-library.md 第 3b 批）。Liora 定的：整份照套、導演格式鎖最後、每個群在群設定裡選。
 *
 * 群聊的內建是一則 user 訊息：群的場景＋每位成員的檔案＋本輪任務（聊天記錄寫在任務裡、要模型回 JSON 或只回自己的台詞）。
 * 用了自訂預設時：
 * - 預設的條目照順序送；群的場景、成員檔案是 Soren 佔位，沒放就補在聊天記錄前面。
 * - 「聊天記錄」那格放本輪任務（記錄＋規則，圖片照帶）；導演模式的兩段文風（群聊氛圍、對話質量）拿掉，聽預設的。
 *   預設沒有聊天記錄佔位、或把它關了，也照樣補上——群聊沒有這則就沒東西可回。
 * - 最後永遠接一則「輸出格式」：預設裡要小說、要標籤、要思考過程，群聊都以 JSON（導演）或只寫台詞（輪流）為準。
 *   預設的 assistant 預填不送（會頂掉 JSON 的開頭）。
 * - 巨集的 {{char}} 換成成員名字（用「、」接起來），{{user}} 是群裡的你。
 * 沒選預設＝內建，GroupChat 照舊送那一則，一字不差。
 */

import type { GroupProfile, UserProfile } from '../types';
import { GROUP_STYLE_ATMOSPHERE, GROUP_STYLE_QUALITY } from './groupChat/prompts';
import { assembleMeetingPreset, type PresetMessage } from './meetingPreset/assemble';
import type { GroupSorenSlot, MeetingPresetDoc, MeetingPresetGroup, MeetingPresetPrompt, MeetingPresetSlot } from './meetingPreset/types';
import { DB } from './db';
import { resolveGroupPresetId } from './presetBinding';

export const GROUP_BUILTIN_PRESET_NAME = '群聊 · 內建';

export const GROUP_SLOT_LABELS: Record<GroupSorenSlot, string> = {
    groupScene: '群的場景（群名、時間、共享場景、話題）',
    groupMembers: '成員檔案（每位成員的設定、記憶、私聊時間線）',
};

/** 群聊永遠接在最後的格式說明：導演要 JSON、輪流只寫自己的台詞 */
export const groupFormatLock = (mode: 'director' | 'roundRobin', memberName?: string): string => mode === 'director'
    ? '【輸出格式（最後確認）】只輸出上面「輸出格式 (JSON Array)」要求的 JSON 陣列，每個元素是 {"charId": …, "content": …}，陣列之外不寫任何字。前面的設定如果要求別的格式（小說體、旁白、標籤、思考過程、字數），群聊一律以這個 JSON 為準；文風照前面的設定寫進每位成員的 content 裡。'
    : `【輸出格式（最後確認）】只輸出「${memberName || '你'}」自己要在群裡發的話，一行一個氣泡，不加名字前綴、不寫旁白和思考過程。前面的設定如果要求別的格式（小說體、標籤、字數），群聊一律以這條為準；文風照前面的設定。`;

const slot = (id: MeetingPresetSlot, name: string): MeetingPresetPrompt =>
    ({ id, name, enabled: true, role: 'system', content: '', slot: id });
const text = (id: string, name: string, content: string): MeetingPresetPrompt =>
    ({ id, name, enabled: true, role: 'system', content: content.trim() });

/** 群聊內建寫成一份預設：給用戶複製出來自己調（導演模式那兩段文風是文字條目） */
export const buildBuiltinGroupPresetDoc = (): MeetingPresetDoc => {
    const context = [
        slot('groupScene', GROUP_SLOT_LABELS.groupScene),
        slot('groupMembers', GROUP_SLOT_LABELS.groupMembers),
    ];
    const style = [
        text('group_style_atmosphere', '文風 · 群聊的樂子是多元的、修羅場硬規則', GROUP_STYLE_ATMOSPHERE),
        text('group_style_quality', '文風 · 對話質量', GROUP_STYLE_QUALITY),
    ];
    const tail = [slot('chatHistory', '群聊記錄與本輪任務')];
    const ids = (list: MeetingPresetPrompt[]) => list.map(p => p.id);
    const groups: MeetingPresetGroup[] = [
        { id: 'group_g_context', name: '群與成員（Soren 填）', promptIds: ids(context) },
        { id: 'group_g_style', name: '群聊文風', promptIds: ids(style) },
        { id: 'group_g_tail', name: '群聊記錄與本輪任務', promptIds: ids(tail) },
    ];
    return {
        schema: 'soren.meeting-preset',
        version: 1,
        name: GROUP_BUILTIN_PRESET_NAME,
        generation: {},
        prompts: [...context, ...style, ...tail],
        regexScripts: [],
        groups,
        globalVars: {},
        scenes: ['group'],
    };
};

/** 預設一定要有開著的聊天記錄格（本輪任務放那）：沒有就補在最後，關了就打開 */
const withTaskSlot = (doc: MeetingPresetDoc): MeetingPresetDoc => {
    const has = doc.prompts.some(p => p.slot === 'chatHistory');
    return {
        ...doc,
        assistantPrefill: undefined,
        prompts: has
            ? doc.prompts.map(p => (p.slot === 'chatHistory' ? { ...p, enabled: true } : p))
            : [...doc.prompts, slot('chatHistory', '群聊記錄與本輪任務')],
    };
};

/** 照預設拼出這一輪群聊要送的 messages */
export const assembleGroupPreset = (input: {
    doc: MeetingPresetDoc;
    mode: 'director' | 'roundRobin';
    /** 群的場景（buildGroupSystemHeader 的 header） */
    scene: string;
    /** 成員檔案塊（導演：所有成員；輪流：輪到的那位） */
    members: string;
    /** 本輪任務：記錄＋規則（導演模式已拿掉兩段文風）；有圖片時是多段內容 */
    task: string | unknown[];
    /** 輪流模式輪到誰（{{char}} 就是 ta）；導演模式是全部成員的名字 */
    memberNames: string[];
    userName: string;
}): PresetMessage[] => {
    const content = Array.isArray(input.task) ? input.task : [{ type: 'text', text: input.task }];
    const { messages } = assembleMeetingPreset({
        doc: withTaskSlot(input.doc),
        slots: { groupScene: input.scene, groupMembers: input.members },
        // 用多段內容送：任務整則不跑預設的正則（那是給單人對話的記錄用的）
        history: [{ role: 'user', content }],
        autoSlots: { beforeHistory: ['groupScene', 'groupMembers'] },
        squashSystem: true,
        env: {
            charName: input.memberNames.join('、'),
            userName: input.userName,
        },
    });
    return [...messages, { role: 'system', content: groupFormatLock(input.mode, input.memberNames[0]) }];
};

/** 這個群用哪份自訂預設；null＝內建。沒選、場景也沒設就不碰 DB */
export const loadGroupPresetDoc = async (
    group: Pick<GroupProfile, 'presetId'>,
    profileBase: Pick<UserProfile, 'presetSceneDefaults'> | null | undefined,
): Promise<MeetingPresetDoc | null> => {
    const id = resolveGroupPresetId(group, { presetSceneDefaults: profileBase?.presetSceneDefaults });
    if (!id) return null;
    const record = await DB.getMeetingPreset(id).catch(() => undefined);
    return record?.doc ?? null;
};
