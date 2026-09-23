import { Message } from '../types';

/**
 * 字幕對齊模式（外語語音）下，中文字幕和 <語音> 塊會被 chunkText 拆成同一回合裡的
 * 不同氣泡：字幕是獨立的文字氣泡，語音消息本身標籤外往往沒有中文。
 *
 * 以前語音條的中文翻譯 (originalText) 只看「標籤外的文字」，看不到就發一次 LLM
 * 請求把外語翻回中文——請求一失敗翻譯就永遠空著（「外語語音沒翻譯」）。
 *
 * 這個 helper 從同一批 assistant 消息裡把字幕直接收回來當翻譯：確定性、零成本、
 * 內容還和用戶看到的字幕逐字一致。收不到（或對不齊）再讓調用方走 LLM 兜底。
 *
 * ⚠️ 前提是模型真的遵守了字幕對齊格式。模型不守格式時（標籤外是獨立閒聊短句、
 * 語音裡是另一段話），把兄弟氣泡當翻譯就會顯示成驢唇不對馬嘴的中文（真實翻車
 * 報告：轉文字面板顯示同回合的「等我一下」而不是語音的翻譯）。所以收之前必須
 * 做結構校驗，對不上一律返回 ''（寧可多花一次 LLM 調用，也不能展示錯誤內容）：
 *  - 中文氣泡數 == 語音內容的分段數（字幕對齊 prompt 要求逐段對應，chunkText
 *    按換行分氣泡、語音內容按換行分段，兩邊應當數目一致）
 *  - 中外文字符量比例合理（4 個字的「等我一下」配 300 字符的英文獨白一眼假）
 *
 * 其餘約束：
 *  - 只收 msg 所在的連續 assistant 批次（前後擴展，遇到非 assistant 停）
 *  - 批次裡除 msg 外還有別的語音消息 → 字幕歸屬含糊，返回 ''
 *  - 只收 type==='text' 且不含語音標籤的氣泡；emoji / 卡片等跳過
 *  - 雙語氣泡只取 %%BILINGUAL%% 之前的「選」語言半邊（那才是字幕面）
 */
type MsgLike = Pick<Message, 'id' | 'role' | 'type' | 'content'>;

/** 收集同批次兄弟氣泡文本 + 語音標籤內文（不做對齊校驗）。ambiguous=同批有第二條語音。 */
function collectParts(messages: MsgLike[], msgId: number): { parts: string[]; inner: string; ambiguous: boolean } {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return { parts: [], inner: '', ambiguous: false };

    // 語音內容（配對提取；未閉合的歷史壞數據取標籤後全部）
    const voiceContent = messages[idx].content || '';
    const inner = (
        voiceContent.match(/<[语語語]音[^>]*>([\s\S]*?)<\/\s*[语語語]音\s*>/)?.[1]
        ?? voiceContent.match(/<[语語語]音[^>]*>([\s\S]*)$/)?.[1]
        ?? ''
    ).trim();

    let start = idx;
    let end = idx;
    while (start > 0 && messages[start - 1].role === 'assistant') start--;
    while (end < messages.length - 1 && messages[end + 1].role === 'assistant') end++;

    const VOICE_OPEN_RE = /<[语語語]音[^>]*>/;
    const parts: string[] = [];
    for (let i = start; i <= end; i++) {
        const m = messages[i];
        if (i === idx) continue;
        if (m.type !== 'text') continue;
        if (VOICE_OPEN_RE.test(m.content || '')) return { parts: [], inner, ambiguous: true };
        const half = (m.content || '').split(/%%BILINGUAL%%/i)[0].trim();
        if (half) parts.push(half);
    }
    return { parts, inner, ambiguous: false };
}

export function collectVoiceBatchSubtitle(messages: MsgLike[], msgId: number): string {
    const { parts, inner, ambiguous } = collectParts(messages, msgId);
    if (ambiguous || !inner || !parts.length) return '';

    // ── 結構對齊校驗：對不上說明標籤外不是字幕，走 LLM 兜底 ──
    const foreignSegs = inner.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (parts.length !== foreignSegs.length) return '';
    const zhLen = parts.join('').replace(/\s/g, '').length;
    const fLen = inner.replace(/\s/g, '').length;
    if (zhLen * 6 < fLen || fLen * 6 < zhLen) return '';

    // 兜個上限，防極端長回合把翻譯面板撐爆
    return parts.join('\n').slice(0, 2000);
}

/**
 * 毒數據自檢：2026-07-02 ~ 07-04 之間的版本收字幕**不做對齊校驗**，模型不守字幕
 * 格式時把同回合的閒聊短句當翻譯持久化了。回灌語音數據時用這個函數認出這種
 * 存量髒翻譯（存的值 == 舊邏輯的產物，且新校驗判定不是字幕），認出來就清掉。
 */
export function isPoisonedVoiceSubtitle(messages: MsgLike[], msgId: number, storedOriginalText: string): boolean {
    if (!storedOriginalText) return false;
    const { parts, ambiguous } = collectParts(messages, msgId);
    if (ambiguous || !parts.length) return false;
    const legacyJoin = parts.join('\n').slice(0, 2000); // 舊邏輯（無校驗）的輸出
    if (storedOriginalText !== legacyJoin) return false; // 不是舊邏輯寫的（LLM 翻譯/標籤外文字），不動
    return collectVoiceBatchSubtitle(messages, msgId) !== legacyJoin; // 新校驗不認可 → 毒數據
}
