/**
 * 私聊 prompt 的「你的錢包」：角色看得到自己的 Real Balance 餘額、銀行卡、最近幾筆流水。
 *
 * 以前提示詞教角色「送禮從你自己的 Real Balance 出，量力而為」，卻從沒告訴它有多少錢——
 * 你剛轉給它的錢它不知道，它是黑金卡大戶還是快見底了它也不知道。這裡只給一小段：
 * 餘額、卡、最近三筆，不塞整本帳。從沒打開過錢包（還沒建帳戶）的角色不給。
 *
 * 不帶時間：主動消息的 fire_pack 也烤這一段，到點渲染時「剛剛」早就不是剛剛了。
 * 餘額一變 updateCharacter 就會把雲端快照打髒重傳，數字本身不會過期太久。
 */
import type { RealBalanceState } from '../types';
import { formatMoney } from './realBalance';

const money = formatMoney;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;

export function buildRealBalanceBlock(state: RealBalanceState | undefined, recentCount = 3): string {
    if (!state) return '';
    const lines = [`錢包（Real Balance）餘額：${money(state.balance)}`];
    if (state.cards.length > 0) {
        lines.push(`銀行卡：${state.cards.map(c => `${c.name} 尾號 ${c.lastFour} ${money(c.balance)}`).join('、')}`);
    }
    const recent = state.transactions.slice(-recentCount).reverse();
    if (recent.length > 0) {
        lines.push(`最近的流水：${recent.map(t => `${t.label} ${signed(t.amount)}`).join('、')}`);
    }
    return `\n### 【你的錢包】\n（這是你自己的錢。知道自己手頭寬不寬、誰剛轉了錢給你就好，不用主動報數字，也別為了提錢而提錢。）\n${lines.join('\n')}\n`;
}
