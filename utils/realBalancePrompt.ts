/**
 * 私聊 prompt 的「你的錢包」：角色看得到自己的 Real Balance 餘額、銀行卡、最近幾筆流水。
 *
 * 以前提示詞教角色「送禮從你自己的 Real Balance 出，量力而為」，卻從沒告訴它有多少錢——
 * 你剛轉給它的錢它不知道，它是黑金卡大戶還是快見底了它也不知道。這裡只給一小段：
 * 餘額、卡、最近三筆，不塞整本帳。從沒打開過錢包（還沒建帳戶）的角色不給。
 *
 * 銀行改版後（plans/finance-wallet-design.md）多兩三行：Net Worth、名下有什麼、每月幾號進出什麼錢。
 * 「今天是不是發薪日」不寫，角色看時間塊自己對得上；寫了會被 fire_pack 烤成過期的「今天」。
 *
 * 不帶時間：主動消息的 fire_pack 也烤這一段，到點渲染時「剛剛」早就不是剛剛了。
 * 餘額一變 updateCharacter 就會把雲端快照打髒重傳，數字本身不會過期太久。
 */
import type { RealBalanceState } from '../types';
import { formatMoney } from './realBalance';
import { accountLabel, computeNetWorth, financeBook, formatMoneyDisplay as fmt, monthlySummary } from './finance';

const money = formatMoney;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;

export function buildRealBalanceBlock(state: RealBalanceState | undefined, recentCount = 3): string {
    if (!state) return '';
    const lines = [`錢包（Real Balance）餘額：${money(state.balance)}`];
    if (state.cards.length > 0) {
        lines.push(`銀行卡：${state.cards.map(c => `${c.name} 尾號 ${c.lastFour} ${money(c.balance)}`).join('、')}`);
    }
    lines.push(...financeLines(state));
    const recent = [...state.transactions].sort((a, b) => a.timestamp - b.timestamp).slice(-recentCount).reverse();
    if (recent.length > 0) {
        lines.push(`最近的流水：${recent.map(t => `${t.label} ${signed(t.amount)}`).join('、')}`);
    }
    return `\n### 【你的錢包】\n（這是你自己的錢。知道自己手頭寬不寬、誰剛轉了錢給你就好，不用主動報數字，也別為了提錢而提錢。）\n${lines.join('\n')}\n`;
}

/** 總覽各 block 濃縮成兩三行；什麼都沒填的舊錢包一行都不加。 */
function financeLines(state: RealBalanceState): string[] {
    const book = financeBook(state);
    const hasBook = Object.values(book).some(list => list.length > 0);
    if (!hasBook) return [];
    const out: string[] = [];
    const nw = computeNetWorth(state);
    const month = monthlySummary(state);
    out.push(`Net Worth：${fmt(nw.netWorth)}（資產 ${fmt(nw.assets)}${nw.liabilities > 0 ? `，負債 ${fmt(nw.liabilities)}` : ''}）；月收入約 ${fmt(month.income)}，每月固定支出 ${fmt(month.fixedOut)}`);

    const owned = [
        ...book.properties.filter(p => p.mode !== 'renting').map(p => p.mode === 'own-rent' ? `${p.name}（出租中）` : p.name),
        ...book.vehicles.map(v => v.model),
        ...book.investments.map(i => i.name),
        ...book.others.map(o => o.name),
    ];
    if (owned.length) out.push(`名下：${owned.slice(0, 6).join('、')}${owned.length > 6 ? ' 等' : ''}`);

    const fixed: string[] = [];
    for (const it of book.incomes) if (it.recurring) fixed.push(`${it.recurring.dayOfMonth} 號${it.kind === 'salary' ? '發薪' : '入帳'}（${it.name} ${fmt(it.amount)}，進${accountLabel(state, it.recurring.accountId)}）`);
    for (const e of book.expenses) if (e.recurring) fixed.push(`${e.recurring.dayOfMonth} 號扣${e.name} ${fmt(e.amount)}`);
    for (const p of book.properties) {
        const rec = p.lease?.recurring;
        if (!rec || p.mode === 'own-live') continue;
        fixed.push(p.mode === 'own-rent' ? `${rec.dayOfMonth} 號收租（${p.name} ${fmt(p.lease!.monthlyRent)}）` : `${rec.dayOfMonth} 號交房租（${p.name} ${fmt(p.lease!.monthlyRent)}）`);
    }
    for (const i of book.investments) if (i.contribution) fixed.push(`${i.contribution.dayOfMonth} 號定投（${i.name} ${fmt(i.contribution.amount)}）`);
    for (const l of book.liabilities) {
        if (l.owed <= 0) continue;
        const pay = l.monthlyPayment ? `，每月${l.recurring ? ` ${l.recurring.dayOfMonth} 號` : ''}還 ${fmt(l.monthlyPayment)}` : '';
        fixed.push(`${l.name}還欠 ${fmt(l.owed)}${pay}${l.remainingTerms ? `，還剩 ${l.remainingTerms} 期` : ''}`);
    }
    if (fixed.length) out.push(`每月固定：${fixed.slice(0, 6).join('；')}`);
    return out;
}
