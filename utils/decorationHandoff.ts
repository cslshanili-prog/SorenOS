/**
 * 從別的 App 打開裝扮 App 時帶過去的「停在哪一行、返回回哪」（plans/decoration-app.md 第 6 節）。
 * 只放記憶體，跟 Sore 的 handoff 一樣：重新整理就沒了，沒關係。
 */
import type { AppID } from '../types';
import type { DecorationTargetRef } from './decorationTemplates';

export interface DecorationHandoff {
    target?: DecorationTargetRef;
    /** 一進去就打開這個聊天的編輯頁（不只停在那一行） */
    edit?: boolean;
    from?: AppID;
    /** 返回時不只是開回那個 App（例如回到同一個群），給了就用它 */
    onReturn?: () => void;
}

let pending: DecorationHandoff | null = null;

export const setDecorationHandoff = (handoff: DecorationHandoff) => { pending = handoff; };

export const takeDecorationHandoff = (): DecorationHandoff | null => {
    const handoff = pending;
    pending = null;
    return handoff;
};
