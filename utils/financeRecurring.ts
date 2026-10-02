/**
 * 固定收支自動補記（銀行改版第二批）。設計見 plans/finance-wallet-design.md「固定收支自動補記」。
 *
 * App 沒開就沒有程式在跑，所以不是到點觸發，而是**打開 App 時把過了的發薪日／扣款日補上**：
 * 每個固定項目記 lastPostedMonth（YYYY-MM），從那之後到今天、日子已過的每個月各記一筆。
 * 純函數，同一份狀態跑兩次結果一樣（記過的月份不會再記），OSContext 開機／切回前台／每小時跑一次。
 */
import type { FinanceBook, FinanceRecurring, RealBalanceState, RealBalanceTransaction, FinanceFlowCategory } from '../types';
import { roundMoney } from './format';
import { CASH_ACCOUNT, financeBook } from './finance';

/** 很久沒開的錢包，一次最多補這麼多個月，免得一口氣灌進幾十筆。 */
export const MAX_CATCH_UP_MONTHS = 12;

const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (y: number, m0: number) => `${y}-${pad(m0 + 1)}`;
const parseMonth = (key: string): { y: number; m0: number } | null => {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    return m ? { y: Number(m[1]), m0: Number(m[2]) - 1 } : null;
};

/** 那個月的到期時刻：當月沒有那天就算月底；早上 9 點，排序時落在當天前段。 */
export function dueDate(y: number, m0: number, dayOfMonth: number): Date {
    const last = new Date(y, m0 + 1, 0).getDate();
    return new Date(y, m0, Math.min(Math.max(1, dayOfMonth), last), 9, 0, 0, 0);
}

/** lastPostedMonth 之後、到今天為止日子已經到了的月份（舊到新），最多 MAX_CATCH_UP_MONTHS 個。 */
export function dueMonths(rec: FinanceRecurring, now: Date): Array<{ month: string; at: Date }> {
    const start = rec.lastPostedMonth ? parseMonth(rec.lastPostedMonth) : null;
    if (!start) return [];
    const out: Array<{ month: string; at: Date }> = [];
    let y = start.y, m0 = start.m0 + 1;
    if (m0 > 11) { y++; m0 = 0; }
    // 防呆：lastPostedMonth 寫成很久以前，迴圈不能跑幾百圈
    for (let guard = 0; guard < 600; guard++) {
        const at = dueDate(y, m0, rec.dayOfMonth);
        if (at.getTime() > now.getTime()) break;
        out.push({ month: monthOf(y, m0), at });
        m0++; if (m0 > 11) { y++; m0 = 0; }
    }
    return out.slice(-MAX_CATCH_UP_MONTHS);
}

type Kind = 'income' | 'expense' | 'rentIn' | 'rentOut' | 'invest' | 'repay';

interface DueEvent {
    kind: Kind;
    itemId: string;
    name: string;
    month: string;
    at: Date;
    accountId: string;
    /** 帶符號：進帳正、扣款負 */
    amount: number;
    category: FinanceFlowCategory;
}

/** 把整本帳所有到期的固定收支攤平成事件，按時間排好（餘額照時間順序變）。 */
function collectEvents(book: FinanceBook, now: Date): DueEvent[] {
    const events: DueEvent[] = [];
    const push = (rec: FinanceRecurring | undefined, base: Omit<DueEvent, 'month' | 'at' | 'accountId'>) => {
        if (!rec || !(Math.abs(base.amount) > 0)) return;
        for (const d of dueMonths(rec, now)) events.push({ ...base, month: d.month, at: d.at, accountId: rec.accountId || CASH_ACCOUNT });
    };
    for (const it of book.incomes) {
        push(it.recurring, { kind: 'income', itemId: it.id, name: it.name, amount: it.amount, category: it.kind === 'salary' ? 'salary' : 'income' });
    }
    for (const it of book.expenses) {
        push(it.recurring, { kind: 'expense', itemId: it.id, name: it.name, amount: -it.amount, category: 'bills' });
    }
    for (const it of book.investments) {
        if (it.contribution) push(it.contribution, { kind: 'invest', itemId: it.id, name: it.name, amount: -it.contribution.amount, category: 'investment' });
    }
    for (const it of book.properties) {
        const lease = it.lease;
        if (!lease?.recurring || it.mode === 'own-live') continue;
        const leaseEnd = lease.leaseEnd ? new Date(`${lease.leaseEnd}T23:59:59`) : null;
        const before = events.length;
        push(lease.recurring, it.mode === 'own-rent'
            ? { kind: 'rentIn', itemId: it.id, name: it.name, amount: lease.monthlyRent, category: 'income' }
            : { kind: 'rentOut', itemId: it.id, name: it.name, amount: -lease.monthlyRent, category: 'housing' });
        // 租約到期之後的月份不收不交（月份照樣算處理過，免得續約時一口氣補）
        if (leaseEnd && Number.isFinite(leaseEnd.getTime())) {
            for (let i = before; i < events.length; i++) if (events[i].at > leaseEnd) events[i].amount = 0;
        }
    }
    for (const it of book.liabilities) {
        if (!it.recurring || !it.monthlyPayment) continue;
        push(it.recurring, { kind: 'repay', itemId: it.id, name: it.name, amount: -it.monthlyPayment, category: 'loan' });
    }
    return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const LABEL: Record<Kind, (name: string) => string> = {
    income: n => n,
    expense: n => n,
    rentIn: n => `收租：${n}`,
    rentOut: n => `房租：${n}`,
    invest: n => `定投：${n}`,
    repay: n => `還款：${n}`,
};

let txSeq = 0;
const makeTxId = () => `rbtx-${Date.now()}-a${(txSeq++).toString(36)}`;

export interface SettleResult {
    state: RealBalanceState;
    /** 這次記了幾筆（含扣款失敗那種 0 元紀錄） */
    posted: number;
    /** 狀態有沒有變（記了帳，或只是把進度往前推，例如租約到期後的月份）；false 就不用落庫 */
    changed: boolean;
}

/**
 * 補記所有到期的固定收支。帳戶不夠扣：那一期跳過，記一筆 0 元的「扣款失敗」，不讓餘額變負；
 * 還款扣成功才把尚欠和期數往下減，欠款還清或期數歸零就不再扣。
 */
export function settleRecurring(state: RealBalanceState, now: Date = new Date()): SettleResult {
    if (!state.finance) return { state, posted: 0, changed: false };
    let book = financeBook(state);
    const events = collectEvents(book, now);
    if (events.length === 0) return { state, posted: 0, changed: false };

    let balance = state.balance;
    let cards = state.cards;
    const txs: RealBalanceTransaction[] = [];
    const liabilities = new Map(book.liabilities.map(l => [l.id, { ...l }]));
    const investments = new Map(book.investments.map(i => [i.id, { ...i }]));
    const lastMonth = new Map<string, string>(); // `${kind}:${id}` → 最後處理的月份

    for (const ev of events) {
        lastMonth.set(`${ev.kind}:${ev.itemId}`, ev.month);
        if (ev.amount === 0) continue; // 租約到期後的月份
        let amount = ev.amount;
        const debt = ev.kind === 'repay' ? liabilities.get(ev.itemId) : undefined;
        if (debt) {
            if (debt.owed <= 0 || debt.remainingTerms === 0) continue;
            amount = -Math.min(-amount, debt.owed); // 最後一期只扣剩下的
        }
        const isCash = ev.accountId === CASH_ACCOUNT;
        const card = isCash ? undefined : cards.find(c => c.id === ev.accountId);
        const before = isCash ? balance : card?.balance;
        const after = before === undefined ? undefined : roundMoney(before + amount);
        const base = { timestamp: ev.at.getTime(), accountId: ev.accountId, category: ev.category, source: 'auto' as const };
        if (after === undefined || after < 0) {
            txs.push({ id: makeTxId(), label: `扣款失敗：${ev.name}`, amount: 0, detail: before === undefined ? '那張卡已經刪了' : `餘額不夠扣 ${Math.abs(amount)}`, balanceAfter: before ?? 0, ...base });
            continue;
        }
        if (isCash) balance = after;
        else cards = cards.map(c => c.id === ev.accountId ? { ...c, balance: after } : c);
        txs.push({ id: makeTxId(), label: LABEL[ev.kind](ev.name), amount, balanceAfter: after, ...base });
        if (debt) {
            debt.owed = roundMoney(debt.owed + amount);
            if (debt.remainingTerms !== undefined) debt.remainingTerms = Math.max(0, debt.remainingTerms - 1);
        }
        const inv = ev.kind === 'invest' ? investments.get(ev.itemId) : undefined;
        if (inv) { inv.cost = roundMoney(inv.cost - amount); inv.value = roundMoney(inv.value - amount); }
    }

    const bump = <T extends FinanceRecurring>(rec: T | undefined, key: string): T | undefined =>
        rec && lastMonth.has(key) ? { ...rec, lastPostedMonth: lastMonth.get(key)! } : rec;
    book = {
        ...book,
        incomes: book.incomes.map(it => ({ ...it, recurring: bump(it.recurring, `income:${it.id}`) })),
        expenses: book.expenses.map(it => ({ ...it, recurring: bump(it.recurring, `expense:${it.id}`) })),
        investments: book.investments.map(it => {
            const inv = investments.get(it.id)!;
            return { ...inv, contribution: bump(it.contribution, `invest:${it.id}`) };
        }),
        properties: book.properties.map(it => it.lease?.recurring
            ? { ...it, lease: { ...it.lease, recurring: bump(it.lease.recurring, `${it.mode === 'own-rent' ? 'rentIn' : 'rentOut'}:${it.id}`) } }
            : it),
        liabilities: book.liabilities.map(it => ({ ...liabilities.get(it.id)!, recurring: bump(it.recurring, `repay:${it.id}`) })),
    };
    return {
        state: { ...state, balance, cards, transactions: [...state.transactions, ...txs], finance: book },
        posted: txs.length,
        changed: true,
    };
}

/** 有沒有任何東西到期（只看不改，調用方用來決定要不要落庫）。進度要往前推也算。 */
export function hasDueRecurring(state: RealBalanceState | undefined, now: Date = new Date()): boolean {
    if (!state?.finance) return false;
    return collectEvents(financeBook(state), now).length > 0;
}
