/**
 * 「請 Sore 幫忙」捷徑的交接（plans/ai-assistant.md 第 3 節）：各處編輯頁把「要改哪裡、從哪個 App 來」放進來，
 * Sore 打開時拿走，開一段新對話，並在每輪提示詞裡帶上這個位置；返回鍵回到原本的 App。
 * 只放記憶體：重新整理就沒了，沒關係（那時候也不在那頁了）。
 */
import type { AppID } from '../../types';
import type { CssLocationId } from './cssLocations';

export interface SoreHandoff {
    /** 美化位置，或 'preset'（預設編輯頁，第 3 批） */
    location: CssLocationId | 'preset';
    /** 角色／群／氣泡主題 id，或預設 id；全域位置留空 */
    targetId?: string;
    /** 氣泡主題還沒存的時候用名字（Sore 會新建）；預設的話是預設名字（顯示用） */
    targetName?: string;
    /** 返回時回到哪個 App */
    from?: AppID;
}

let pending: SoreHandoff | null = null;

export const setSoreHandoff = (handoff: SoreHandoff) => { pending = handoff; };

export const takeSoreHandoff = (): SoreHandoff | null => {
    const handoff = pending;
    pending = null;
    return handoff;
};

/** 每輪送給 Sore 的「用戶從哪裡來」 */
export const buildSoreEntryNote = (entry: { location: string; target: string; label: string }) => (entry.location === 'preset' ? [
    `用戶在「${entry.label}」的編輯頁按了「請 Sore 幫忙」。`,
    `要改的預設：preset="${entry.target}"。用戶沒特別說改哪份的時候，就是改這份。`,
    '開始前先用「讀取預設」看這份現在的樣子；要改的條目先「讀取條目」看全文。',
].join('\n') : [
    `用戶在「${entry.label}」的編輯頁按了「請 Sore 幫忙」。`,
    `要改的位置：location="${entry.location}"${entry.target ? `，target="${entry.target}"` : ''}。用戶沒特別說改哪裡的時候，就是改這裡。`,
    '開始前先用「讀取CSS」看這裡現在的內容。',
].join('\n'));
