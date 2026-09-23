/**
 * 歸檔提示詞模板工具（共享）
 *
 * 用戶在 Character.tsx / Chat.tsx 的"記憶歸檔設置"裡選中的提示詞模板 id
 * 存在 localStorage 裡，內容也部分存在 localStorage（用戶自定義的）。
 * 默認模板（preset_*）來自 ChatConstants.DEFAULT_ARCHIVE_PROMPTS。
 *
 * 這裡把"取當前選中模板 content"集中成一個函數，供：
 * - 手動歸檔路徑
 * - palace 自動歸檔路徑（pipeline.ts 調用）
 * 共用。
 */

import { DEFAULT_ARCHIVE_PROMPTS } from '../components/chat/ChatConstants';

const LS_KEY_CUSTOM_PROMPTS = 'chat_archive_prompts';
const LS_KEY_SELECTED_ID = 'chat_active_archive_prompt_id';
const DEFAULT_ID = 'preset_rational';

/**
 * 取當前選中的歸檔提示詞模板內容（已做過字段替換）。
 *
 * 返回 null 表示取不到，調用方應 fallback 到 palace 裸拼 YAML bullets。
 */
export function getActiveArchiveTemplate(opts: {
    dateStr: string;
    charName: string;
    userName: string;
    rawLog: string;
}): string | null {
    try {
        const selectedId = localStorage.getItem(LS_KEY_SELECTED_ID) || DEFAULT_ID;

        // 合併默認模板 + 用戶自定義
        let all: { id: string; name: string; content: string }[] = [...DEFAULT_ARCHIVE_PROMPTS];
        try {
            const raw = localStorage.getItem(LS_KEY_CUSTOM_PROMPTS);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    // 只合並非 preset 的自定義條目
                    all = [...all, ...parsed.filter((p: any) => p?.id && !p.id.startsWith('preset_'))];
                }
            }
        } catch { /* 自定義解析失敗也不影響取默認 */ }

        const found = all.find(p => p.id === selectedId) || all[0];
        if (!found) return null;

        // 字段替換
        return found.content
            .replace(/\$\{dateStr\}/g, opts.dateStr)
            .replace(/\$\{char\.name\}/g, opts.charName)
            .replace(/\$\{userProfile\.name\}/g, opts.userName)
            .replace(/\$\{rawLog.*?\}/g, opts.rawLog);
    } catch {
        return null;
    }
}
