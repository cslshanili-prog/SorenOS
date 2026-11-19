/**
 * 身份卡的「補充設定」（2026-11-19）：原本「自定義設定」「其他補充」兩格在提示詞裡只是並排的兩行，
 * 沒有誰比誰重要，合成一格。
 *
 * - 存：編輯頁只寫 `customSetting`，`otherDetails` 清掉。
 * - 讀：舊資料兩格都可能有字，一律經這裡接起來，別直接讀那兩個欄位。
 *
 * 哪些地方讀得到：私聊、群聊、電話、見面（都走 ContextBuilder 的用戶段）、日程生成、銀行流水、回覆草稿。
 * 只看簡介（bio）的：見面底下的劇情（沒戴面具時）、協同工作、記憶整理、小說、好友申請、彼方、音樂人設。
 * 編輯頁那格底下的小字照這份寫，改了讀的地方要跟著改。
 */
export const personaExtraSetting = (
    user: { customSetting?: string; otherDetails?: string } | null | undefined,
): string => [user?.customSetting, user?.otherDetails].map(s => (s || '').trim()).filter(Boolean).join('\n');
