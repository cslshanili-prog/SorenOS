import type { CaianExpression } from './sarArt';

export type SARUpdateNotice = 'cabinet' | 'board';
type Line = { expression: CaianExpression; text: string | readonly string[]; emphasis?: string; quoted?: boolean };

/** Authored release messages; kept outside familiarity scenes and their daily/reward state. */
export const SAR_UPDATE_NOTICES: Record<SARUpdateNotice, readonly Line[]> = {
    cabinet: [
        { expression: 'happy', text: '對了！剛剛收到了優化通知。' },
        { expression: 'normal', text: ['異格回覆：點「…」可複製、修改、重新生成、刪除。', '刪除後點生成會重試原來那一幕，不重複扣輪數；生成失敗保留舊回覆'], emphasis: '異格回覆', quoted: true },
        { expression: 'happy', text: '——彼方的作者是這樣留言的。' },
        { expression: 'normal', text: '那麼，我轉達到位了！' },
        { expression: 'normal2', text: '玩得開心哦。' },
    ],
    board: [
        { expression: 'happy', text: '來自2026年9月16日夜晚的更新的優化通知！' },
        { expression: 'normal', text: '我給你讀一下哦！' },
        { expression: 'normal', text: '之前角色不會把魚批量賣艾文，現在他們可以了，當他們在市場板的時候，可以這樣做', quoted: true },
        { expression: 'curious', text: '誒——之前不行的嗎！' },
        { expression: 'embarrassed', text: '怪不得艾文說感覺池子裡的魚越來越少了……' },
        { expression: 'normal', text: '此外，本次更新了市場板玩法，npc發佈的內容可能附帶了一場隱藏事件', quoted: true },
        { expression: 'normal2', text: '就是這些，感覺會很有意思！' },
        { expression: 'happy', text: '那麼，玩得開心！' },
    ],
};

const acknowledged = new Set<SARUpdateNotice>();
export const sarUpdateNoticeKey = (notice: SARUpdateNotice) => notice === 'board'
    ? 'sar-feature-update-2026-09-16-bulk-fish-v1:board'
    : `sar-feature-update-september-v1:${notice}`;

export function hasReadSARUpdateNotice(notice: SARUpdateNotice): boolean {
    if (acknowledged.has(notice)) return true;
    try { return localStorage.getItem(sarUpdateNoticeKey(notice)) === 'done'; }
    catch { return false; }
}

/** Called only after the final line. Interrupted visits leave the notice unread. */
export function acknowledgeSARUpdateNotice(notice: SARUpdateNotice): void {
    acknowledged.add(notice);
    try { localStorage.setItem(sarUpdateNoticeKey(notice), 'done'); }
    catch { /* Storage unavailable: remember completion for this session. */ }
}
