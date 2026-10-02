/**
 * 銀行改版第三批：AI ⟳ 生成財務狀況與流水。設計見 plans/finance-wallet-design.md「AI 生成」。
 *
 * - 總覽：照人設生成整份（現金、銀行卡、收入、固定支出、投資、房產、交通工具、負債、其他）。
 *   收入、現金、銀行一定要有，其他沒有就空。套用時**整份換掉**現金、卡和各 block，流水保留。
 * - 流水：照現有帳戶生成近一個月的日常收支，當作「已經算進現在餘額的過去紀錄」，source: 'ai'、
 *   **不動餘額**。再生成一次會換掉上次 AI 生成的那批，手動、聊天、自動記的不碰。
 *
 * 純函數（提示詞、解析、套用）＋一個發請求的小工具，UI 在 components/bank/RealBalancePanel.tsx。
 */
import type {
    BankCard, FinanceBook, FinanceFlowCategory, FinanceRecurring, RealBalanceState, RealBalanceTransaction, UserProfile,
} from '../types';
import { roundMoney } from './format';
import {
    CASH_ACCOUNT, EMPTY_FINANCE_BOOK, FLOW_CATEGORY_LABELS, INCOME_KIND_LABELS, INVESTMENT_KIND_LABELS,
    LIABILITY_KIND_LABELS, PROPERTY_MODE_LABELS, VEHICLE_KIND_LABELS, financeBook, makeFinanceId,
    withRecurringStart,
} from './finance';
import { MONEY_SYMBOL } from './realBalance';
import { extractContent, extractJson, safeResponseJson } from './safeApi';

// ── 小工具 ───────────────────────────────────────────

const toNum = (v: unknown): number => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') { const n = parseFloat(v.replace(/[,，\s$¥＄]/g, '')); return Number.isFinite(n) ? n : 0; }
    return 0;
};
const money = (v: unknown): number => Math.max(0, roundMoney(toNum(v)));
const text = (v: unknown, max = 60): string => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');
const day = (v: unknown): number | undefined => {
    const n = Math.round(toNum(v));
    return n >= 1 && n <= 31 ? n : undefined;
};
function pick<T extends string>(v: unknown, allowed: Record<T, string>, fallback: NoInfer<T>): T {
    return typeof v === 'string' && v in allowed ? v as T : fallback;
}
const keysOf = (o: Record<string, string>) => Object.keys(o).join('|');

/** 用戶那邊沒有角色設定，拿當前身份卡湊一段給模型看。 */
export function buildUserOwnerContext(user: UserProfile): string {
    const lines = [`[System: 這是用戶本人（${user.name}）的資料]`, `- 名字: ${user.name}`];
    if (user.gender) lines.push(`- 性別: ${user.gender}`);
    if (user.bio?.trim()) lines.push(`- 設定/備註: ${user.bio.trim()}`);
    if (user.customSetting?.trim()) lines.push(`- 自定義設定: ${user.customSetting.trim()}`);
    if (user.otherDetails?.trim()) lines.push(`- 其他補充: ${user.otherDetails.trim()}`);
    return lines.join('\n');
}

// ── 總覽 ─────────────────────────────────────────────

export function buildOverviewPrompt(ownerName: string): string {
    return `依照上面的設定，替 ${ownerName} 編一份現在的財務狀況，放進 TA 手機銀行 App 的「總覽」。貼合人設、身分、年紀、世界觀與生活水準（窮學生、上班族、富二代、冒險者……都可以），數字要彼此對得上：收入撐得起開銷、存款跟年資相稱、負債有來由。貨幣符號是 ${MONEY_SYMBOL}，金額寫純數字。

必填：cash（身上現金）、cards（1–3 張銀行卡）、incomes（至少一項）。其他沒有就給空陣列，不要硬湊。
固定收支（薪資、生活費、房租、定投、還款）請給每月幾號 dayOfMonth；account 寫 "cash" 或 "card1"、"card2"（cards 的第幾張）。
expenses 放每月固定要付的生活費、電話費、保險、訂閱等，至少一項生活費，免得只進不出。

只回傳這個形狀的 JSON（不要多餘文字）：
{
  "cash": 3200,
  "cards": [{ "name": "某某銀行 薪轉戶", "lastFour": "4821", "balance": 85000 }],
  "incomes": [{ "name": "助教月薪", "kind": "${keysOf(INCOME_KIND_LABELS)}", "amount": 32000, "fixed": true, "dayOfMonth": 25, "account": "card1", "note": "" }],
  "expenses": [{ "name": "生活費", "amount": 12000, "dayOfMonth": 1, "account": "card1" }],
  "investments": [{ "name": "全球指數基金", "kind": "${keysOf(INVESTMENT_KIND_LABELS)}", "cost": 60000, "value": 66000, "monthly": 3000, "dayOfMonth": 5, "account": "card1" }],
  "properties": [{ "name": "學校旁套房", "mode": "${keysOf(PROPERTY_MODE_LABELS)}", "value": 0, "monthlyRent": 9000, "deposit": 18000, "dayOfMonth": 27, "leaseEnd": "2027-06-30", "account": "card1" }],
  "vehicles": [{ "kind": "${keysOf(VEHICLE_KIND_LABELS)}", "model": "Gogoro VIVA", "value": 40000 }],
  "liabilities": [{ "name": "學貸", "kind": "${keysOf(LIABILITY_KIND_LABELS)}", "owed": 180000, "monthlyPayment": 3000, "dayOfMonth": 27, "remainingTerms": 60, "creditLimit": 0, "account": "card1" }],
  "others": [{ "name": "鋼筆", "value": 2100, "note": "手寫筆記用的那支" }]
}
kind / mode 只能用上面列出的英文值。properties 的 mode：own-live 自有自住（給 value）、own-rent 自有出租（給 value 與月租，dayOfMonth 是收租日）、renting 租屋（給月租，dayOfMonth 是交租日）。`;
}

export interface GeneratedOverview {
    balance: number;
    cards: BankCard[];
    finance: FinanceBook;
}

const CARD_COLORS: BankCard['color'][] = ['graphite', 'gold', 'silver'];

/** 鬆散 JSON → 可套用的總覽；什麼都沒解析出來就回 null。 */
export function parseOverview(json: unknown, now: Date = new Date()): GeneratedOverview | null {
    const o = (json && typeof json === 'object') ? json as any : null;
    if (!o) return null;
    const arr = (v: unknown): any[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);

    const cards: BankCard[] = arr(o.cards).slice(0, 3).map((c, i) => ({
        id: makeFinanceId('card'),
        name: text(c.name, 30) || '儲蓄卡',
        lastFour: (String(c.lastFour ?? '').replace(/\D/g, '') || String(1000 + Math.floor(Math.random() * 9000))).padStart(4, '0').slice(-4),
        balance: money(c.balance),
        color: CARD_COLORS[i % CARD_COLORS.length],
        createdAt: now.getTime(),
    }));
    const accountOf = (v: unknown): string => {
        const m = /card\s*(\d+)/i.exec(String(v ?? ''));
        const card = m ? cards[Number(m[1]) - 1] : undefined;
        return card?.id || CASH_ACCOUNT;
    };
    const rec = (x: any): FinanceRecurring | undefined => {
        const d = day(x.dayOfMonth);
        return d ? withRecurringStart({ dayOfMonth: d, accountId: accountOf(x.account) }, undefined, now) : undefined;
    };
    const note = (x: any) => text(x.note, 80) || undefined;

    const finance: FinanceBook = {
        ...EMPTY_FINANCE_BOOK,
        incomes: arr(o.incomes).filter(x => text(x.name) && money(x.amount) > 0).map(x => ({
            id: makeFinanceId('inc'), name: text(x.name), kind: pick(x.kind, INCOME_KIND_LABELS, 'other'), amount: money(x.amount),
            recurring: x.fixed === false ? undefined : rec(x), note: note(x),
        })),
        expenses: arr(o.expenses).filter(x => text(x.name) && money(x.amount) > 0).map(x => ({
            id: makeFinanceId('exp'), name: text(x.name), amount: money(x.amount), recurring: rec(x), note: note(x),
        })),
        investments: arr(o.investments).filter(x => text(x.name)).map(x => {
            const r = money(x.monthly) > 0 ? rec(x) : undefined;
            return {
                id: makeFinanceId('inv'), name: text(x.name), kind: pick(x.kind, INVESTMENT_KIND_LABELS, 'other'),
                cost: money(x.cost), value: money(x.value) || money(x.cost),
                contribution: r ? { ...r, amount: money(x.monthly) } : undefined, note: note(x),
            };
        }),
        properties: arr(o.properties).filter(x => text(x.name)).map(x => {
            const mode = pick(x.mode, PROPERTY_MODE_LABELS, 'own-live');
            const rent = money(x.monthlyRent);
            return {
                id: makeFinanceId('pro'), name: text(x.name), mode,
                value: mode === 'renting' ? undefined : money(x.value),
                lease: mode !== 'own-live' && rent > 0 ? {
                    monthlyRent: rent,
                    deposit: money(x.deposit) || undefined,
                    leaseEnd: typeof x.leaseEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.leaseEnd) ? x.leaseEnd : undefined,
                    recurring: rec(x),
                } : undefined,
                note: note(x),
            };
        }),
        vehicles: arr(o.vehicles).filter(x => text(x.model)).map(x => ({
            id: makeFinanceId('veh'), kind: pick(x.kind, VEHICLE_KIND_LABELS, 'other'), model: text(x.model), value: money(x.value), note: note(x),
        })),
        liabilities: arr(o.liabilities).filter(x => text(x.name) && money(x.owed) > 0).map(x => {
            const kind = pick(x.kind, LIABILITY_KIND_LABELS, 'other');
            const pay = money(x.monthlyPayment);
            const terms = Math.round(toNum(x.remainingTerms));
            return {
                id: makeFinanceId('lia'), name: text(x.name), kind, owed: money(x.owed),
                monthlyPayment: pay || undefined,
                remainingTerms: terms > 0 ? terms : undefined,
                creditLimit: kind === 'credit' ? (money(x.creditLimit) || undefined) : undefined,
                recurring: pay > 0 ? rec(x) : undefined,
                note: note(x),
            };
        }),
        others: arr(o.others).filter(x => text(x.name)).map(x => ({
            id: makeFinanceId('oth'), name: text(x.name), value: money(x.value), note: note(x),
        })),
    };
    const balance = money(o.cash);
    const hasAnything = balance > 0 || cards.length > 0 || Object.values(finance).some(list => list.length > 0);
    return hasAnything ? { balance, cards, finance } : null;
}

/** 整份換掉現金、銀行卡和各 block；流水保留（舊卡的流水會顯示「已刪除的卡」）。 */
export function applyGeneratedOverview(state: RealBalanceState, gen: GeneratedOverview): RealBalanceState {
    return { ...state, balance: gen.balance, cards: gen.cards, finance: gen.finance };
}

/** 現在有沒有「會被整份換掉」的內容，有才需要先問一聲。 */
export function hasOverviewContent(state: RealBalanceState): boolean {
    return state.balance > 0 || state.cards.length > 0 || Object.values(financeBook(state)).some(list => list.length > 0);
}

// ── 流水 ─────────────────────────────────────────────

const FLOW_KEYS = Object.keys(FLOW_CATEGORY_LABELS).join('|');

export function buildFlowPrompt(state: RealBalanceState, ownerName: string): string {
    const book = financeBook(state);
    const accounts = [`"cash"（現金 ${MONEY_SYMBOL}${state.balance}）`, ...state.cards.map((c, i) => `"card${i + 1}"（${c.name} ${MONEY_SYMBOL}${c.balance}）`)];
    const fixed = [
        ...book.incomes.map(i => `收入：${i.name} ${MONEY_SYMBOL}${i.amount}`),
        ...book.expenses.map(e => `固定支出：${e.name} ${MONEY_SYMBOL}${e.amount}`),
        ...book.properties.filter(p => p.lease).map(p => `${p.mode === 'renting' ? '房租' : '收租'}：${p.name} ${MONEY_SYMBOL}${p.lease!.monthlyRent}`),
        ...book.liabilities.filter(l => l.monthlyPayment).map(l => `還款：${l.name} ${MONEY_SYMBOL}${l.monthlyPayment}`),
    ];
    return `依照上面的設定，替 ${ownerName} 編最近 30 天的日常收支流水，放進 TA 手機銀行 App 的「流水」。這些是已經發生過、已經算進現在餘額的紀錄。

帳戶：${accounts.join('、')}
${fixed.length ? `每月固定收支（系統會自己記，**流水裡不要再寫**）：${fixed.join('；')}\n` : ''}
寫 15–25 筆：吃飯、交通、購物、娛樂、人情、偶爾的小收入……貼合 TA 的生活習慣與消費水準，名稱寫具體（「便利商店飯糰」比「餐飲」好），note 可以留一句 TA 自己會記的話或留空。花錢的帳戶要合理（小額多用現金或卡都行）。

只回傳這個形狀的 JSON（不要多餘文字）：
{ "flows": [{ "daysAgo": 2, "time": "12:40", "label": "便利商店飯糰", "amount": -45, "account": "cash", "category": "${FLOW_KEYS}", "note": "" }] }
amount 帶正負號：支出負、收入正。daysAgo 是 0–29。category 只能用上面列出的英文值。`;
}

let txSeq = 0;
const makeTxId = () => `rbtx-${Date.now()}-g${(txSeq++).toString(36)}`;

export function parseFlows(json: unknown, state: RealBalanceState, now: Date = new Date()): RealBalanceTransaction[] {
    const o = (json && typeof json === 'object') ? json as any : null;
    const list = Array.isArray(o?.flows) ? o.flows : Array.isArray(json) ? json as any[] : [];
    const out: RealBalanceTransaction[] = [];
    for (const x of list) {
        if (!x || typeof x !== 'object') continue;
        const label = text(x.label, 40);
        const amount = roundMoney(toNum(x.amount));
        if (!label || !amount) continue;
        const m = /card\s*(\d+)/i.exec(String(x.account ?? ''));
        const accountId = m && state.cards[Number(m[1]) - 1] ? state.cards[Number(m[1]) - 1].id : CASH_ACCOUNT;
        const daysAgo = Math.min(29, Math.max(0, Math.round(toNum(x.daysAgo))));
        const tm = /^(\d{1,2}):(\d{2})$/.exec(String(x.time ?? '').trim());
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, tm ? Math.min(23, Number(tm[1])) : 12, tm ? Math.min(59, Number(tm[2])) : 0);
        // 「今天」但時間還沒到：拉回現在之前
        const ts = Math.min(d.getTime(), now.getTime() - (out.length + 1) * 60000);
        const noteText = text(x.note, 80);
        out.push({
            id: makeTxId(), label, amount, timestamp: ts,
            ...(noteText ? { detail: noteText } : {}),
            // AI 生成的不動餘額，流水頁也不顯示「餘」；填當下餘額只是讓欄位有值
            balanceAfter: accountId === CASH_ACCOUNT ? state.balance : (state.cards.find(c => c.id === accountId)?.balance ?? 0),
            accountId,
            category: pick(x.category, FLOW_CATEGORY_LABELS, amount > 0 ? 'income' : 'other') as FinanceFlowCategory,
            source: 'ai',
        });
        if (out.length >= 40) break;
    }
    return out;
}

/** 換掉上次 AI 生成的那批流水，其他的不碰；餘額不動。 */
export function applyGeneratedFlows(state: RealBalanceState, flows: RealBalanceTransaction[]): RealBalanceState {
    return { ...state, transactions: [...state.transactions.filter(t => t.source !== 'ai'), ...flows] };
}

export const hasAiFlows = (state: RealBalanceState): boolean => state.transactions.some(t => t.source === 'ai');

// ── 發請求 ───────────────────────────────────────────

export interface FinanceApi { baseUrl: string; apiKey: string; model: string }

export async function requestFinanceJson(api: FinanceApi, system: string, prompt: string): Promise<unknown> {
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            temperature: 0.9,
            max_tokens: 8000,
        }),
    });
    if (!response.ok) throw new Error(`API Error ${response.status}`);
    const content = extractContent(await safeResponseJson(response));
    return extractJson(content);
}
