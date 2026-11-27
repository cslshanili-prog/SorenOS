/**
 * TA 偷偷準備送你的禮物（plans/bond-batch5.md 2.4）：`[[ACTION:BOND_GIFT_PLAN|東西|什麼時候]]`（不寫 `ACTION:` 也認）。
 *
 * - 標籤一律剝掉、你看不到；這條線有羈絆空間、不是小號、沒在拉黑中才收，一輪一個。
 * - 收下就存一張 `dir: 'in'`、`secret` 的禮物卡（utils/bond/gift.ts 的 newSecretPlan：同時最多 3 件、同一件不重複）。
 * - 之後只進角色自己的提示詞；角色用 GIFT 送出、品名對得上就揭曉（components/bond/giftRun.ts 的 syncGiftPlans），
 *   60 天沒送就作廢。
 * - 雲端兩條路由 worker 原樣直通（SOREN_PASSTHROUGH_TAG_RE），客戶端照這裡解析。
 * 純邏輯，有測試。
 */
import type { CharacterProfile } from '../../types';
import { canProposePact } from './pactTags';

const TAG_RE = /\[\[\s*(?:ACTION\s*[:：]\s*)?(?:BOND_GIFT_PLAN|GIFT_PLAN|偷偷準備禮物|偷偷准备礼物|準備禮物|准备礼物)\s*(?:[|｜]([^\]\n]*))?\]\]/g;

export interface GiftPlanTag {
    what: string;
    when?: string;
}

/** 剝掉標籤；收第一個寫了東西的 */
export function extractGiftPlanTag(text: string): { cleanedText: string; plan: GiftPlanTag | null } {
    let plan: GiftPlanTag | null = null;
    let hit = false;
    const cleanedText = text.replace(TAG_RE, (_m, body: string | undefined) => {
        hit = true;
        const parts = String(body || '').split(/[|｜]/).map(s => s.trim());
        const what = (parts[0] || '').slice(0, 40);
        if (what && !plan) plan = { what, ...(parts[1] ? { when: parts[1].slice(0, 30) } : {}) };
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { cleanedText: hit ? cleanedText : text, plan };
}

/** 私聊系統提示詞那段（沒空間、小號、拉黑中不教） */
export function buildGiftPlanPrompt(char: Pick<CharacterProfile, 'altOf' | 'chatBlock'>, bond: Parameters<typeof canProposePact>[1], userName: string): string {
    if (!canProposePact(char, bond)) return '';
    return [
        '',
        `### 想偷偷準備一份禮物給${userName}時`,
        `聊著聊著想到要送${userName}什麼、又想給驚喜，可以在回覆最後另起一行寫 [[ACTION:BOND_GIFT_PLAN|要送的東西|打算什麼時候送]]（時候可以寫「生日」「下次見面」「月底」，不確定就留空）。`,
        `${userName}看不到這個標籤，也不會知道；之後你會記得自己在準備。想好時機就照平常用購物送出去，東西的名字寫同一個；改變主意不送也可以。`,
        '別在對話裡說破、也別暗示得太明顯。真的想送時才用，一次最多一個，同時準備的不要超過三件。',
        '',
    ].join('\n');
}
