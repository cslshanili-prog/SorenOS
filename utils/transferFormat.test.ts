import { describe, it, expect } from 'vitest';
import {
    parseTransferAmount,
    formatTransferAmount,
    extractTransferCommands,
    formatTransferRecord,
    type TransferRecordInput,
} from './transferFormat';
import { sanitizeForBubble, sanitizeForNotification } from './sanitize';

describe('parseTransferAmount', () => {
    it('純數字', () => {
        expect(parseTransferAmount('1999')).toBe(1999);
        expect(parseTransferAmount('520')).toBe(520);
    });

    it('帶單位 / 幣種符號', () => {
        expect(parseTransferAmount('520元')).toBe(520);
        expect(parseTransferAmount('520塊')).toBe(520);
        expect(parseTransferAmount('520塊錢')).toBe(520);
        expect(parseTransferAmount('¥520')).toBe(520);
        expect(parseTransferAmount('￥520元')).toBe(520);
        expect(parseTransferAmount('520 RMB')).toBe(520);
    });

    it('千分位 / 小數 / 全角 / 多餘空白', () => {
        expect(parseTransferAmount('1,999')).toBe(1999);
        expect(parseTransferAmount('1，999')).toBe(1999);
        expect(parseTransferAmount('520.00')).toBe(520);
        expect(parseTransferAmount('520.5')).toBe(520.5);
        expect(parseTransferAmount('５２０')).toBe(520);
        expect(parseTransferAmount('  520  ')).toBe(520);
    });

    it('非法值一律 null（0 / 負數 / 非數字 / 空）', () => {
        expect(parseTransferAmount('0')).toBeNull();
        expect(parseTransferAmount('-520')).toBeNull();
        expect(parseTransferAmount('很多')).toBeNull();
        expect(parseTransferAmount('')).toBeNull();
        expect(parseTransferAmount(undefined)).toBeNull();
        expect(parseTransferAmount(NaN)).toBeNull();
        expect(parseTransferAmount(Infinity)).toBeNull();
    });

    it('上限不設 —— 人設引導出的天價由用戶自己負責', () => {
        expect(parseTransferAmount('999999999')).toBe(999999999);
    });
});

describe('formatTransferAmount', () => {
    it('整數去小數點，非整數保留兩位', () => {
        expect(formatTransferAmount(520)).toBe('520');
        expect(formatTransferAmount(520.5)).toBe('520.5');
        expect(formatTransferAmount(520.456)).toBe('520.46');
    });
});

describe('extractTransferCommands — 規範標籤', () => {
    it('基礎形態', () => {
        const r = extractTransferCommands('給你[[ACTION:TRANSFER:1999]]拿去買喝的');
        expect(r.events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(r.text).toBe('給你拿去買喝的');
    });

    it('冒號後多空格 / 帶單位 / 千分位（老正則會漏，漏了就靜默消失）', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER: 520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:520元]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:1,999]]').events)
            .toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:520.00]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('一條回覆裡多筆全部保留，不設數量上限（老實現只認第一個，第二筆靜默丟失）', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER:520]]吃飯\n[[ACTION:TRANSFER:1314]]打車');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1314' },
        ]);
        expect(r.text).toBe('吃飯\n打車');
    });

    it('金額非法 → 剝掉保正文，不產生事件', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER:很多]]隨便花');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('隨便花');
        expect(r.consumed).toBe(1);
    });

    it('ACCEPT / RETURN 不會被 TRANSFER 正則誤吃', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]謝謝你').events)
            .toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER_RETURN]]我不能要').events)
            .toEqual([{ kind: 'return' }]);
    });

    it('按出現順序返回，保住角色的語序意圖', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]收下了\n[[ACTION:TRANSFER:520]]這個還你');
        expect(r.events).toEqual([{ kind: 'accept' }, { kind: 'send', amount: '520' }]);
    });
});

describe('extractTransferCommands — 模仿歷史日誌的口語形態', () => {
    it('用戶實際反饋的那一條：整塊還原成真轉帳', () => {
        const r = extractTransferCommands('[系統: 你向阿桃轉帳 1999]拿去花');
        expect(r.events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(r.text).toBe('拿去花');
    });

    it('措辭變體', () => {
        const cases = [
            '[系統: 你向阿桃轉帳1999]',
            '[系統：你向阿桃轉帳 1999]',
            '[系統: 你給阿桃轉帳 1999]',
            '[系統: 你給阿桃轉了1999]',
            '[系統: 你向阿桃轉帳了 ￥1,999元]',
            '[System: 你向阿桃轉帳 1999]',
        ];
        for (const c of cases) {
            expect(extractTransferCommands(c).events, c).toEqual([{ kind: 'send', amount: '1999' }]);
        }
    });

    it('群摘要形態 [轉帳1999]', () => {
        expect(extractTransferCommands('[轉帳1999]').events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[轉帳 520]').events).toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('回執形態 → accept / return', () => {
        expect(extractTransferCommands('[系統: 你接收了阿桃的轉帳 520]').events)
            .toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[系統: 你退回了阿桃的轉帳 520]').events)
            .toEqual([{ kind: 'return' }]);
    });
});

describe('extractTransferCommands — 方向校驗（偽造必須攔下，不能渲染）', () => {
    it('用戶→角色的轉帳日誌：剝掉，不產生事件', () => {
        const r = extractTransferCommands('[系統: 阿桃向你轉帳 1999]我收下啦');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('我收下啦');
        expect(r.consumed).toBe(1);
    });

    it('角色替用戶簽收 / 退回：同樣剝掉', () => {
        expect(extractTransferCommands('[系統: 阿桃接收了你的轉帳 1999]').events).toEqual([]);
        expect(extractTransferCommands('[系統: 阿桃退回了你的轉帳 1999]').events).toEqual([]);
    });

    it('待處理提示的完整歷史行（帶尾巴）也算偽造', () => {
        const r = extractTransferCommands('[系統: 阿桃向你轉帳 1999（待你處理，可收下或退回）]');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(1);
    });
});

describe('extractTransferCommands — 不越界', () => {
    it('自由散文不認：敘述不是指令', () => {
        const r = extractTransferCommands('我剛給你轉了1999，記得查收');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(0);
        expect(r.text).toBe('我剛給你轉了1999，記得查收');
    });

    it('非轉帳的系統日誌不消費（留給 sanitize 終線）', () => {
        const r = extractTransferCommands('[系統: 用戶戳了你一下]我在呢');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(0);
        expect(r.text).toBe('[系統: 用戶戳了你一下]我在呢');
    });

    it('空輸入 / 無標籤', () => {
        expect(extractTransferCommands('')).toEqual({ text: '', events: [], consumed: 0 });
        expect(extractTransferCommands('今天天氣不錯')).toEqual({
            text: '今天天氣不錯', events: [], consumed: 0,
        });
    });

    it('正文原樣保留，只挖走標籤', () => {
        const r0 = extractTransferCommands('前面[[ACTION:TRANSFER:520]]中間[系統: 你向阿桃轉帳 1]後面');
        expect(r0.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1' },
        ]);
        expect(r0.text).toBe('前面中間後面');
    });
});

// ─── 詞彙表統一: 記錄形態 ↔ ACTION kv 形態 ─────────────────────────────────

describe('formatTransferRecord — 歷史渲染', () => {
    it('原始轉帳: to = role 的對手方', () => {
        expect(formatTransferRecord({ role: 'assistant', amount: '1999' }))
            .toBe('[[記錄:TRANSFER|to=user|amount=1999|status=待處理]]');
        expect(formatTransferRecord({ role: 'user', amount: '520' }))
            .toBe('[[記錄:TRANSFER|to=char|amount=520|status=待處理]]');
    });

    it('原始轉帳讀 live status —— 被收/退後不再顯示待處理 (修掉舊渲染的不一致)', () => {
        expect(formatTransferRecord({ role: 'assistant', amount: '1999', status: 'accepted' }))
            .toBe('[[記錄:TRANSFER|to=user|amount=1999|status=已收下]]');
        expect(formatTransferRecord({ role: 'user', amount: '520', status: 'returned' }))
            .toBe('[[記錄:TRANSFER|to=char|amount=520|status=已退回]]');
    });

    it('回執: to = 出回執一方自己', () => {
        // 角色出的回執 (收下用戶的轉帳): 錢當初流向 char
        expect(formatTransferRecord({ role: 'assistant', amount: '520', receipt: 'accepted' }))
            .toBe('[[記錄:TRANSFER|to=char|amount=520|status=已收下]]');
        // 用戶出的回執 (退回角色的轉帳): 錢當初流向 user
        expect(formatTransferRecord({ role: 'user', amount: '1999', receipt: 'returned' }))
            .toBe('[[記錄:TRANSFER|to=user|amount=1999|status=已退回]]');
    });

    it('缺金額的老數據: 省略 amount 字段而不是留空值', () => {
        expect(formatTransferRecord({ role: 'assistant' }))
            .toBe('[[記錄:TRANSFER|to=user|status=待處理]]');
    });
});

describe('往返性質 — 渲染端產出的任何記錄行, 解析端恆為消費且零事件, sanitize 恆剝淨', () => {
    // 覆蓋 role × receipt × status 的全部組合 —— 這條性質破了, 復讀歷史就會產生假轉帳
    const allCases: TransferRecordInput[] = [];
    for (const role of ['user', 'assistant'] as const) {
        for (const amount of ['1999', undefined] as const) {
            allCases.push({ role, amount });
            for (const status of ['accepted', 'returned'] as const) allCases.push({ role, amount, status });
            for (const receipt of ['accepted', 'returned'] as const) allCases.push({ role, amount, receipt });
        }
    }

    it(`全部 ${allCases.length} 種記錄行: 解析消費 + 零事件 + 正文保留`, () => {
        for (const rec of allCases) {
            const line = formatTransferRecord(rec);
            const r = extractTransferCommands(`${line}拿去花`);
            expect(r.events, line).toEqual([]);
            expect(r.consumed, line).toBe(1);
            expect(r.text, line).toBe('拿去花');
        }
    });

    it('sanitize 終線: bubble 與 notification 都剝淨記錄行', () => {
        for (const rec of allCases) {
            const line = formatTransferRecord(rec);
            expect(sanitizeForBubble(`${line}拿去花`), line).toBe('拿去花');
            expect(sanitizeForNotification(`${line}拿去花`), line).toBe('拿去花');
        }
    });

    it('記錄命名空間整體受保護 (未來的記錄:POKE 等): sanitize 剝, 解析端只認領 TRANSFER', () => {
        // 未來事件類型 —— 解析端不消費 (不歸轉帳管), sanitize 終線兜底
        const future = '[[記錄:POKE|by=user]]我在呢';
        expect(extractTransferCommands(future).consumed).toBe(0);
        expect(sanitizeForBubble(future)).toBe('我在呢');
    });

    it('繁體 / 全角冒號變體的記錄行同樣零事件', () => {
        for (const v of ['[[記錄:TRANSFER|to=user|amount=1999|status=待處理]]', '[[記錄：TRANSFER|to=user|amount=1999]]']) {
            const r = extractTransferCommands(`${v}拿去`);
            expect(r.events, v).toEqual([]);
            expect(r.consumed, v).toBe(1);
        }
    });
});

describe('extractTransferCommands — ACTION kv 形態 (新 canonical)', () => {
    it('基礎形態', () => {
        const r = extractTransferCommands('給你[[ACTION:TRANSFER|to=user|amount=520]]買杯喝的');
        expect(r.events).toEqual([{ kind: 'send', amount: '520' }]);
        expect(r.text).toBe('給你買杯喝的');
    });

    it('kv 順序不敏感 / to 缺省 / 金額容錯沿用', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER|amount=520|to=user]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER|amount=1999]]').events)
            .toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER|to=user|amount=1,999元]]').events)
            .toEqual([{ kind: 'send', amount: '1999' }]);
    });

    it('裸值容錯: [[ACTION:TRANSFER|520]] 當 amount', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER|520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('to 指向角色自己 → 偽造, 整塊丟棄零事件 (方向由 role 決定, 文本只做校驗)', () => {
        for (const to of ['char', 'self', 'me', '角色', '自己', '我', 'CHAR']) {
            const r = extractTransferCommands(`[[ACTION:TRANSFER|to=${to}|amount=520]]收到`);
            expect(r.events, `to=${to}`).toEqual([]);
            expect(r.consumed, `to=${to}`).toBe(1);
            expect(r.text, `to=${to}`).toBe('收到');
        }
    });

    it('to 寫名字 / 用戶 → 放行 (私聊對手方唯一)', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER|to=用戶|amount=520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER|to=阿桃|amount=520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('金額缺失 / 非法 / 裸 [[ACTION:TRANSFER]] → 剝掉零事件', () => {
        for (const s of ['[[ACTION:TRANSFER|to=user]]', '[[ACTION:TRANSFER|amount=很多]]', '[[ACTION:TRANSFER]]']) {
            const r = extractTransferCommands(`${s}好嘞`);
            expect(r.events, s).toEqual([]);
            expect(r.consumed, s).toBe(1);
            expect(r.text, s).toBe('好嘞');
        }
    });

    it('kv 形態不誤吃 ACCEPT / RETURN', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]謝謝').events).toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER_RETURN]]不能要').events).toEqual([{ kind: 'return' }]);
    });

    it('新老形態混用, 各自生效', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER|to=user|amount=520]]\n[[ACTION:TRANSFER:1314]]');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1314' },
        ]);
    });
});

describe('extractTransferCommands — 老正文迴歸', () => {
    it('legacy 正文原樣保留，只挖走標籤', () => {
        const r = extractTransferCommands('前面[[ACTION:TRANSFER:520]]中間[系統: 你向阿桃轉帳 1]後面');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1' },
        ]);
        expect(r.text).toBe('前面中間後面');
    });
});
