/**
 * 「請 Sore 幫忙」捷徑的交接（plans/ai-assistant.md 第 3 節）：各處編輯頁把「要改哪裡、從哪個 App 來」放進來，
 * Sore 打開時拿走，開一段新對話，並在每輪提示詞裡帶上這個位置；返回鍵回到原本的 App。
 * 只放記憶體：重新整理就沒了，沒關係（那時候也不在那頁了）。
 */
import type { AppID } from '../../types';
import type { CssLocationId } from './cssLocations';

export interface SoreHandoff {
    /** 美化位置，或 'preset'（預設編輯頁，第 3 批）、'worldbook'（世界書某一組）、'widget'（小組件編輯頁，第 4 批） */
    location: CssLocationId | 'preset' | 'worldbook' | 'widget' | 'decoration';
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
/** 不是美化位置的那幾種：畫面上顯示的標題 */
export const nonCssEntryLabel = (handoff: SoreHandoff): string | null => {
    if (handoff.location === 'preset') return `預設 · ${handoff.targetName || handoff.targetId || ''}`;
    if (handoff.location === 'worldbook') return handoff.targetName ? `世界書 · ${handoff.targetName}` : '世界書';
    if (handoff.location === 'widget') return `桌面小組件 · ${handoff.targetName || '新的'}`;
    if (handoff.location === 'decoration') return `裝扮模板 · ${handoff.targetName || '新的'}`;
    return null;
};

export const buildSoreEntryNote = (entry: { location: string; target: string; label: string }) => (entry.location === 'decoration' ? [
    `用戶在裝扮 App 編輯「${entry.label}」時按了「請 Sore 幫忙」（畫面上的改動已經先存好了）。`,
    entry.target.startsWith('target:')
        ? `要改的是這個聊天自己的裝扮：target="${entry.target.slice(7)}"。先用「讀取聊天裝扮」看現在的樣子；改佈局、氣泡、底紋、提示音用「改裝扮」（target 填上面那個），改 CSS 用「寫CSS」（${entry.target.slice(7) === '全局' ? 'location="chat_chrome_global"' : '角色用 chat_chrome_char、群用 chat_chrome_group'}）。`
        : `要改的模板：template="${entry.target.replace(/^template:/, '')}"。先用「讀取裝扮模板」看現在的樣子，再用「改裝扮」出提案（改了用它的聊天都會跟著變；CSS 也用「改裝扮」的 css 操作）。`,
].join('\n') : entry.location === 'worldbook' ? [
    `用戶在「${entry.label}」按了「請 Sore 幫忙」。`,
    entry.target ? `要改的世界書組：group="${entry.target}"。用戶沒特別說改哪組的時候，就是這組。開始前先用「讀取世界書」看這組現在的樣子。` : '用戶在世界書 App，可能要開新的一組；先「列出世界書」看看有哪些。',
    '要幫某個角色寫的話先「讀取角色」。世界書不能刪條目。',
].join('\n') : entry.location === 'widget' ? [
    `用戶在「${entry.label}」的編輯頁按了「請 Sore 幫忙」。`,
    `要改的小組件：widget="${entry.target}"。先用「讀取小組件」看現在的樣子；讀不到就是還沒存的新小組件，用「寫小組件」新建一個（記得 place: false，用戶自己會放）。`,
].join('\n') : entry.location === 'preset' ? [
    `用戶在「${entry.label}」的編輯頁按了「請 Sore 幫忙」。`,
    `要改的預設：preset="${entry.target}"。用戶沒特別說改哪份的時候，就是改這份。`,
    '開始前先用「讀取預設」看這份現在的樣子；要改的條目先「讀取條目」看全文。',
].join('\n') : [
    `用戶在「${entry.label}」的編輯頁按了「請 Sore 幫忙」。`,
    `要改的位置：location="${entry.location}"${entry.target ? `，target="${entry.target}"` : ''}。用戶沒特別說改哪裡的時候，就是改這裡。`,
    '開始前先用「讀取CSS」看這裡現在的內容。',
    ...(entry.location.startsWith('chat_chrome_') ? ['要知道這個聊天整套穿什麼（氣泡、佈局、背景）就用「讀取聊天裝扮」。'] : []),
].join('\n'));
