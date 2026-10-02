/**
 * 銀行改版（Net Worth 總覽＋流水）的純邏輯。設計見 plans/finance-wallet-design.md。
 *
 * 現金（Real Balance）、銀行卡、聊天聯動的那套仍在 utils/realBalance.ts；這裡管總覽的各 block、
 * Net Worth、每月收支摘要，以及流水頁的手動記帳／刪除。用戶和角色共用，不關心「這是誰的錢」。
 */
import type {
    FinanceBook,
    FinanceFlowCategory,
    FinanceRecurring,
    RealBalanceState,
    RealBalanceTransaction,
} from '../types';
import { roundMoney, sumMoney } from './format';
import { getLocalDateKey } from './localDate';
import { MONEY_SYMBOL } from './realBalance';

export const CASH_ACCOUNT = 'cash';

/** 總覽／流水頁的金額：千分位，整數不帶 .00（「$3,000,000」「$12.30」）。聊天卡片那些照舊用 formatMoney。 */
export function formatMoneyDisplay(n: number): string {
    const v = roundMoney(Math.abs(n));
    const whole = Number.isInteger(v);
    const text = v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
    return `${n < 0 ? '−' : ''}${MONEY_SYMBOL}${text}`;
}

export const EMPTY_FINANCE_BOOK: FinanceBook = {
    incomes: [], expenses: [], investments: [], properties: [], vehicles: [], liabilities: [], others: [],
};

/** 舊錢包沒有 finance，或少了某一塊：一律補空陣列，調用方不用到處判空。 */
export function financeBook(state: RealBalanceState): FinanceBook {
    const f = state.finance;
    return {
        incomes: f?.incomes || [],
        expenses: f?.expenses || [],
        investments: f?.investments || [],
        properties: f?.properties || [],
        vehicles: f?.vehicles || [],
        liabilities: f?.liabilities || [],
        others: f?.others || [],
    };
}

export type FinanceBlockKey = keyof FinanceBook;
type BlockItem<K extends FinanceBlockKey> = FinanceBook[K][number];

let idSeq = 0;
export const makeFinanceId = (prefix: string): string =>
    `${prefix}-${Date.now()}-${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** 新增或覆蓋（同 id）一筆 block 項目。 */
export function upsertFinanceItem<K extends FinanceBlockKey>(state: RealBalanceState, block: K, item: BlockItem<K>): RealBalanceState {
    const book = financeBook(state);
    const list = book[block] as BlockItem<K>[];
    const exists = list.some(x => x.id === item.id);
    const nextList = exists ? list.map(x => x.id === item.id ? item : x) : [...list, item];
    return { ...state, finance: { ...book, [block]: nextList } };
}

export function removeFinanceItem(state: RealBalanceState, block: FinanceBlockKey, id: string): RealBalanceState {
    const book = financeBook(state);
    const list = book[block] as Array<{ id: string }>;
    return { ...state, finance: { ...book, [block]: list.filter(x => x.id !== id) } };
}

// ── 帳戶 ─────────────────────────────────────────────

export function accountLabel(state: RealBalanceState, accountId?: string): string {
    if (!accountId || accountId === CASH_ACCOUNT) return '現金';
    const card = state.cards.find(c => c.id === accountId);
    return card ? `${card.name} ${card.lastFour}` : '已刪除的卡';
}

export function accountBalance(state: RealBalanceState, accountId?: string): number | undefined {
    if (!accountId || accountId === CASH_ACCOUNT) return state.balance;
    return state.cards.find(c => c.id === accountId)?.balance;
}

/** 這筆流水動的是哪個帳戶；舊的互轉流水只有 cardId、金額是現金那一側。 */
export const flowAccountId = (tx: RealBalanceTransaction): string => tx.accountId || CASH_ACCOUNT;

/** 現金 ↔ 銀行卡的互轉：只是錢換個口袋，不算收入支出。 */
export const isInternalTransfer = (tx: RealBalanceTransaction): boolean =>
    tx.category === 'transfer' || (!!tx.cardId && !tx.accountId && (tx.label === '轉入帳戶' || tx.label === '轉出帳戶'));

// ── Net Worth 與每月摘要 ─────────────────────────────

export interface NetWorthBreakdown {
    cash: number;
    cards: number;
    investments: number;
    properties: number;
    vehicles: number;
    others: number;
    liabilities: number;
    assets: number;
    netWorth: number;
}

export function computeNetWorth(state: RealBalanceState): NetWorthBreakdown {
    const book = financeBook(state);
    const cash = roundMoney(state.balance);
    const cards = sumMoney(state.cards.map(c => c.balance));
    const investments = sumMoney(book.investments.map(i => i.value));
    // 只有自有的才是資產；租屋押金不算
    const properties = sumMoney(book.properties.filter(p => p.mode !== 'renting').map(p => p.value || 0));
    const vehicles = sumMoney(book.vehicles.map(v => v.value));
    const others = sumMoney(book.others.map(o => o.value));
    const liabilities = sumMoney(book.liabilities.map(l => Math.max(0, l.owed)));
    const assets = sumMoney([cash, cards, investments, properties, vehicles, others]);
    return { cash, cards, investments, properties, vehicles, others, liabilities, assets, netWorth: roundMoney(assets - liabilities) };
}

/** 收入 block 裡由房產帶出來的那幾列（自有出租的租金），唯讀，改要去房產改。 */
export function rentalIncomes(state: RealBalanceState): Array<{ propertyId: string; name: string; amount: number; dayOfMonth?: number }> {
    return financeBook(state).properties
        .filter(p => p.mode === 'own-rent' && p.lease && p.lease.monthlyRent > 0)
        .map(p => ({ propertyId: p.id, name: `出租：${p.name}`, amount: p.lease!.monthlyRent, dayOfMonth: p.lease!.recurring?.dayOfMonth }));
}

export interface MonthlySummary {
    /** 收入 block 全部（固定＋不固定的大約金額）＋收租 */
    income: number;
    /** 固定支出＋交租＋定投＋每月還款 */
    fixedOut: number;
}

export function monthlySummary(state: RealBalanceState): MonthlySummary {
    const book = financeBook(state);
    const income = sumMoney([
        ...book.incomes.map(i => i.amount),
        ...rentalIncomes(state).map(r => r.amount),
    ]);
    const fixedOut = sumMoney([
        ...book.expenses.map(e => e.amount),
        ...book.properties.filter(p => p.mode === 'renting').map(p => p.lease?.monthlyRent || 0),
        ...book.investments.map(i => i.contribution?.amount || 0),
        ...book.liabilities.map(l => l.monthlyPayment || 0),
    ]);
    return { income, fixedOut };
}

// ── 固定收支的起點 ───────────────────────────────────

const monthKey = (d: Date) => getLocalDateKey(d).slice(0, 7);

/**
 * 新建（或剛打開）固定收支時的 lastPostedMonth：從**下一個**到期日開始，不補建立前的月份。
 * 今天還沒到這個月的那天 → 這個月那天就是下一次，記成「上個月已處理」；已經過了（含當天）→ 記成「這個月已處理」。
 */
export function recurringStartMonth(dayOfMonth: number, now: Date = new Date()): string {
    if (now.getDate() >= dayOfMonth) return monthKey(now);
    return monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

/**
 * 編輯時保留原本的進度；從沒有固定收支變成有、或沒記過進度的，才重新算起點。
 * 調用方在保存前把表單裡的 recurring 丟進來。
 */
export function withRecurringStart<T extends FinanceRecurring>(next: T | undefined, prev: FinanceRecurring | undefined, now: Date = new Date()): (T & { lastPostedMonth: string }) | undefined {
    if (!next) return undefined;
    const day = Math.min(31, Math.max(1, Math.round(next.dayOfMonth) || 1));
    const lastPostedMonth = prev?.lastPostedMonth ?? recurringStartMonth(day, now);
    return { ...next, dayOfMonth: day, lastPostedMonth };
}

// ── 流水：手動新增／刪除 ─────────────────────────────

let txSeq = 0;
const makeTxId = (): string => `rbtx-${Date.now()}-f${(txSeq++).toString(36)}`;

export type FinanceResult = { state: RealBalanceState; ok: true } | { state: RealBalanceState; ok: false; reason: string };

/** 改某個帳戶的餘額，回傳新狀態與結算後餘額；帳戶不存在或會變負就失敗。 */
function moveAccount(state: RealBalanceState, accountId: string, delta: number): { state: RealBalanceState; after: number } | { error: string } {
    if (accountId === CASH_ACCOUNT) {
        const after = roundMoney(state.balance + delta);
        if (after < 0) return { error: '現金不夠' };
        return { state: { ...state, balance: after }, after };
    }
    const card = state.cards.find(c => c.id === accountId);
    if (!card) return { error: '這張卡不存在' };
    const after = roundMoney(card.balance + delta);
    if (after < 0) return { error: `${card.name} 餘額不夠` };
    return { state: { ...state, cards: state.cards.map(c => c.id === accountId ? { ...c, balance: after } : c) }, after };
}

export interface ManualFlowInput {
    direction: 'in' | 'out';
    amount: number;
    accountId: string;
    category: FinanceFlowCategory;
    label: string;
    note?: string;
    /** 記在哪一天（手動可以補記過去的），不給就是現在 */
    timestamp?: number;
}

export function addManualFlow(state: RealBalanceState, input: ManualFlowInput): FinanceResult {
    const amt = roundMoney(input.amount);
    if (!(amt > 0)) return { state, ok: false, reason: '金額必須大於 0' };
    const delta = input.direction === 'in' ? amt : -amt;
    const moved = moveAccount(state, input.accountId, delta);
    if ('error' in moved) return { state, ok: false, reason: moved.error };
    const tx: RealBalanceTransaction = {
        id: makeTxId(),
        label: input.label.trim() || FLOW_CATEGORY_LABELS[input.category],
        amount: delta,
        ...(input.note?.trim() ? { detail: input.note.trim() } : {}),
        timestamp: input.timestamp ?? Date.now(),
        balanceAfter: moved.after,
        accountId: input.accountId,
        category: input.category,
        source: 'manual',
    };
    return { state: { ...moved.state, transactions: [...moved.state.transactions, tx] }, ok: true };
}

/** 哪些流水可以刪：手動的（刪了退回金額）、AI 生成的（本來就沒動餘額）。聊天、自動、互轉是真的發生過的事。 */
export const canDeleteFlow = (tx: RealBalanceTransaction): boolean => tx.source === 'manual' || tx.source === 'ai';

export function deleteFlow(state: RealBalanceState, txId: string): FinanceResult {
    const tx = state.transactions.find(t => t.id === txId);
    if (!tx) return { state, ok: false, reason: '這筆流水不存在' };
    if (!canDeleteFlow(tx)) return { state, ok: false, reason: '聊天和自動記的帳不能刪' };
    let next = state;
    if (tx.source === 'manual') {
        const moved = moveAccount(state, flowAccountId(tx), -tx.amount);
        if ('error' in moved) return { state, ok: false, reason: `${moved.error}，退不回這筆` };
        next = moved.state;
    }
    return { state: { ...next, transactions: next.transactions.filter(t => t.id !== txId) }, ok: true };
}

// ── 流水頁的篩選與月度合計 ─────────────────────────────

export const flowMonth = (tx: RealBalanceTransaction): string => getLocalDateKey(new Date(tx.timestamp)).slice(0, 7);

export function filterFlows(state: RealBalanceState, opts: { month?: string; accountId?: string }): RealBalanceTransaction[] {
    return state.transactions
        .filter(tx => !opts.month || flowMonth(tx) === opts.month)
        .filter(tx => !opts.accountId || flowAccountId(tx) === opts.accountId
            || (opts.accountId !== CASH_ACCOUNT && tx.cardId === opts.accountId))
        .sort((a, b) => b.timestamp - a.timestamp);
}

/** 月度收支（不含互轉）。 */
export function flowTotals(flows: RealBalanceTransaction[]): { income: number; expense: number } {
    const real = flows.filter(tx => !isInternalTransfer(tx));
    return {
        income: sumMoney(real.filter(tx => tx.amount > 0).map(tx => tx.amount)),
        expense: sumMoney(real.filter(tx => tx.amount < 0).map(tx => -tx.amount)),
    };
}

/** 有流水的月份（新到舊），流水頁的月份選單用；本月一定在。 */
export function flowMonths(state: RealBalanceState, now: Date = new Date()): string[] {
    const set = new Set(state.transactions.map(flowMonth));
    set.add(monthKey(now));
    return [...set].sort().reverse();
}

// ── 顯示用的中文標籤 ─────────────────────────────────

export const FLOW_CATEGORY_LABELS: Record<FinanceFlowCategory, string> = {
    salary: '薪資', income: '其他收入', food: '餐飲', shopping: '購物', transport: '交通', housing: '居住',
    bills: '帳單', entertainment: '娛樂', medical: '醫療', education: '學習', social: '人情', investment: '投資',
    loan: '還款', transfer: '轉帳', other: '其他',
};
export const INCOME_CATEGORIES: FinanceFlowCategory[] = ['salary', 'income', 'investment', 'transfer', 'other'];
export const EXPENSE_CATEGORIES: FinanceFlowCategory[] = ['food', 'shopping', 'transport', 'housing', 'bills', 'entertainment', 'medical', 'education', 'social', 'investment', 'loan', 'transfer', 'other'];

export const INCOME_KIND_LABELS = { salary: '薪資', business: '經營', yield: '收益', other: '其他' } as const;
export const INVESTMENT_KIND_LABELS = { stock: '股票', fund: '基金', gold: '黃金', collectible: '收藏品', crypto: '加密貨幣', other: '其他' } as const;
export const PROPERTY_MODE_LABELS = { 'own-live': '自有自住', 'own-rent': '自有出租', renting: '租屋' } as const;
export const VEHICLE_KIND_LABELS = { car: '汽車', motorcycle: '機車', bicycle: '自行車', aircraft: '飛行器', boat: '船', other: '其他' } as const;
export const LIABILITY_KIND_LABELS = { loan: '貸款', mortgage: '房貸', student: '學貸', credit: '信用卡', other: '其他' } as const;
