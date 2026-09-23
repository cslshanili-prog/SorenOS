/**
 * 生活記錄：生理期狀態機 + [[LIFE:...]] 代記指令執行 + 卡片裁決回滾。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真實 DB 層。
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
    buildLifeRecordInjection, computePeriodStatus, executeLifeDirectives, resolveLifeRecordCard,
    getPeriodIntervals, isMedPlanDueToday, lifeToday,
} from './lifeRecords';
import { DB } from './db';
import { CharacterProfile, LifeRecord, MedPlan, Message } from '../types';

const noToast = () => {};

const mkPeriod = (kind: 'start' | 'end', date: string, extra?: Partial<LifeRecord>): LifeRecord => ({
    id: `t-${kind}-${date}-${Math.random()}`,
    module: 'period', kind, date,
    timestamp: new Date(`${date}T08:00:00Z`).getTime(),
    payload: {}, recordedBy: 'user', reviewStatus: 'confirmed', ...extra,
});

const mkChar = (overrides?: Partial<CharacterProfile>): CharacterProfile => ({
    id: `char-${Math.random().toString(36).slice(2, 8)}`,
    name: '江嶼',
    lifeRecordEnabled: true,
    ...overrides,
} as unknown as CharacterProfile);

describe('computePeriodStatus 生理期狀態機', () => {
    it('只有 start：在經期中，天數 1-based', () => {
        const st = computePeriodStatus([mkPeriod('start', '2026-07-01')], null, '2026-07-03');
        expect(st.inPeriod).toBe(true);
        expect(st.dayN).toBe(3);
        expect(st.nextPredicted).toBe('2026-07-29'); // 默認 28 天週期
    });

    it('start + 之後的 end：不在經期', () => {
        const st = computePeriodStatus(
            [mkPeriod('start', '2026-07-01'), mkPeriod('end', '2026-07-05')],
            null, '2026-07-06',
        );
        expect(st.inPeriod).toBe(false);
        expect(st.lastEnd).toBe('2026-07-05');
    });

    it('被否決的 start 不算數', () => {
        const st = computePeriodStatus(
            [mkPeriod('start', '2026-07-01', { reviewStatus: 'rejected' })],
            null, '2026-07-03',
        );
        expect(st.inPeriod).toBe(false);
    });

    it('忘記記結束：超過兜底天數後自動視為已結束', () => {
        const st = computePeriodStatus([mkPeriod('start', '2026-06-01')], null, '2026-07-03');
        expect(st.inPeriod).toBe(false);
    });

    it('自定義週期長度影響預測', () => {
        const st = computePeriodStatus(
            [mkPeriod('start', '2026-07-01')],
            { id: 'main', cycleLength: 30 }, '2026-07-02',
        );
        expect(st.nextPredicted).toBe('2026-07-31');
    });

    it('排卵期預測：排卵日 = 下次經期 − 14 天，排卵期窗口 −5 ~ +1', () => {
        const st = computePeriodStatus([mkPeriod('start', '2026-07-01')], null, '2026-07-08');
        expect(st.nextPredicted).toBe('2026-07-29');
        expect(st.ovulationDate).toBe('2026-07-15');
        expect(st.ovulationStart).toBe('2026-07-10');
        expect(st.ovulationEnd).toBe('2026-07-16');
    });
});

describe('getPeriodIntervals 日曆區間', () => {
    it('start+end 配對成閉區間；未閉合區間截到今天', () => {
        const ivs = getPeriodIntervals([
            mkPeriod('start', '2026-06-01'), mkPeriod('end', '2026-06-05'),
            mkPeriod('start', '2026-06-29'),
        ], '2026-07-02');
        expect(ivs).toHaveLength(2);
        expect(ivs[0]).toMatchObject({ start: '2026-06-01', end: '2026-06-05' });
        expect(ivs[1]).toMatchObject({ start: '2026-06-29', end: '2026-07-02', open: true });
    });

    it('連續兩個 start：上一段在新開始前一天收口', () => {
        const ivs = getPeriodIntervals([
            mkPeriod('start', '2026-06-01'), mkPeriod('start', '2026-06-04'), mkPeriod('end', '2026-06-08'),
        ], '2026-07-02');
        expect(ivs[0]).toMatchObject({ start: '2026-06-01', end: '2026-06-03' });
        expect(ivs[1]).toMatchObject({ start: '2026-06-04', end: '2026-06-08' });
    });
});

describe('isMedPlanDueToday 藥盒頻率', () => {
    const mkPlan = (overrides?: Partial<MedPlan>): MedPlan => ({
        id: 'p1', name: '維D', time: '08:00', enabled: true,
        createdAt: new Date('2026-07-01T00:00:00Z').getTime(), ...overrides,
    });

    it('默認（無頻率字段）= 長期每天，與舊數據兼容', () => {
        expect(isMedPlanDueToday(mkPlan(), '2026-07-06')).toBe(true);
    });

    it('補記日期早於計劃創建日時，不把尚未存在的計劃算作待服', () => {
        expect(isMedPlanDueToday(mkPlan(), '2026-06-30')).toBe(false);
    });

    it('隔天吃：錨點日起偶數天差才到期', () => {
        const p = mkPlan({ intervalDays: 2, startDate: '2026-07-01' });
        expect(isMedPlanDueToday(p, '2026-07-01')).toBe(true);
        expect(isMedPlanDueToday(p, '2026-07-02')).toBe(false);
        expect(isMedPlanDueToday(p, '2026-07-03')).toBe(true);
    });

    it('短期療程：日期段外不生效（含結束當天）', () => {
        const p = mkPlan({ planKind: 'course', startDate: '2026-07-01', endDate: '2026-07-05' });
        expect(isMedPlanDueToday(p, '2026-06-30')).toBe(false);
        expect(isMedPlanDueToday(p, '2026-07-05')).toBe(true);
        expect(isMedPlanDueToday(p, '2026-07-06')).toBe(false);
    });

    it('停用的計劃永遠不到期', () => {
        expect(isMedPlanDueToday(mkPlan({ enabled: false }), '2026-07-06')).toBe(false);
    });
});

describe('executeLifeDirectives 代記指令', () => {
    it('MED 指令：寫記錄 + 落 life_card + 剝 tag', async () => {
        const char = mkChar();
        const out = await executeLifeDirectives('好，我幫你記下了 [[LIFE:MED|布洛芬]]', char, noToast);
        expect(out).toBe('好，我幫你記下了');

        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(1);
        expect(records[0].module).toBe('med');
        expect(records[0].payload.name).toBe('布洛芬');
        expect(records[0].reviewStatus).toBe('active');

        const msgs = await DB.getMessagesByCharId(char.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card');
        expect(card).toBeTruthy();
        expect(card!.metadata.recordId).toBe(records[0].id);
    });

    it('同日同藥重複代記：不重複寫庫，卡片標 duplicate', async () => {
        const char = mkChar();
        await executeLifeDirectives('[[LIFE:MED|維生素C]]', char, noToast);
        const char2 = mkChar({ name: '林深' });
        await executeLifeDirectives('[[LIFE:MED|維生素C]]', char2, noToast);

        const records = (await DB.getAllLifeRecords()).filter(r => r.payload.name === '維生素C');
        expect(records).toHaveLength(1); // 只有第一次寫進去
        const msgs = await DB.getMessagesByCharId(char2.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card');
        expect(card!.metadata.duplicate).toBe(true);
    });

    // 主動消息是提前幾小時打包的：打包時開著、送達前用戶把開關關掉是常態。角色那句
    // 「我幫你記下了」已經說滿，記錄卻靜默蒸發，用戶只會覺得功能壞了 —— 留一條系統提示。
    it('總開關關閉：不寫庫，但落一條系統提示說明沒記成', async () => {
        const char = mkChar({ lifeRecordEnabled: false });
        const out = await executeLifeDirectives('記好了[[LIFE:MED|阿莫西林]]', char, noToast);
        expect(out).toBe('記好了');
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);

        const msgs = await DB.getMessagesByCharId(char.id, true);
        expect(msgs.some((m: Message) => m.role === 'system' && m.content.includes('沒記成')
            && m.content.includes('生活記錄功能已關閉'))).toBe(true);
    });

    it('模塊小開關關閉：不寫庫，同樣留一條系統提示（帶模塊名）', async () => {
        const char = mkChar({ lifeRecordExerciseEnabled: false });
        const out = await executeLifeDirectives('[[LIFE:EXERCISE|跑步|30分鐘]]', char, noToast);
        expect(out).toBe('');
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);

        const msgs = await DB.getMessagesByCharId(char.id, true);
        const note = msgs.find((m: Message) => m.role === 'system');
        expect(note?.content).toContain('鍛鍊');
        expect(note?.content).toContain('沒記成');
    });

    it('格式非法的指令仍然靜默剝掉（模型手滑，沒什麼可交代的）', async () => {
        const char = mkChar();
        const out = await executeLifeDirectives('[[LIFE:MED|]]好', char, noToast);
        expect(out).toBe('好');
        const msgs = await DB.getMessagesByCharId(char.id, true);
        expect(msgs).toHaveLength(0);
    });

    it('傳了 inheritMeta：生活卡和「沒記成」提示都帶上這條推送的標記', async () => {
        const meta = { source: 'active_msg_2', activeMsg2: { messageId: 'push-life' } };

        const charOn = mkChar({ name: '有開關' });
        await executeLifeDirectives('[[LIFE:EXPENSE|66|奶茶]]', charOn, noToast, undefined, meta);
        const card = (await DB.getMessagesByCharId(charOn.id, true))
            .find((m: Message) => m.type === 'life_card');
        expect(card!.metadata.activeMsg2.messageId).toBe('push-life');
        expect(card!.metadata.recordId).toBeTruthy();   // 卡片自己的字段沒被擠掉

        const charOff = mkChar({ name: '沒開關', lifeRecordEnabled: false });
        await executeLifeDirectives('[[LIFE:MED|布洛芬]]', charOff, noToast, undefined, meta);
        const note = (await DB.getMessagesByCharId(charOff.id, true))
            .find((m: Message) => m.role === 'system');
        expect(note!.metadata.activeMsg2.messageId).toBe('push-life');
    });

    it('EXPENSE：同步寫銀行流水，否決時回滾刪除', async () => {
        const char = mkChar();
        await executeLifeDirectives('[[LIFE:EXPENSE|38|打車]]', char, noToast);

        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(1);
        const rec = records[0];
        expect(rec.bankTxId).toBeTruthy();
        let txs = await DB.getAllTransactions();
        expect(txs.some(t => t.id === rec.bankTxId && t.amount === 38)).toBe(true);

        // 否決：記錄 rejected + 欠反饋 + 銀行流水回滾
        const msgs = await DB.getMessagesByCharId(char.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card')!;
        await resolveLifeRecordCard(card, 'rejected');

        const after = await DB.getLifeRecordById(rec.id);
        expect(after!.reviewStatus).toBe('rejected');
        expect(after!.pendingFeedback).toBe(true);
        txs = await DB.getAllTransactions();
        expect(txs.some(t => t.id === rec.bankTxId)).toBe(false);
    });

    it('不在經期時收到 PERIOD_END：按"無需記錄"處理，不寫庫', async () => {
        const char = mkChar();
        await executeLifeDirectives('[[LIFE:PERIOD_END]]', char, noToast);
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);
        const msgs = await DB.getMessagesByCharId(char.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card');
        expect(card!.metadata.duplicate).toBe(true);
    });

    it('PERIOD_START 後再次 START：判重；且狀態機對今日生效', async () => {
        const charA = mkChar({ name: 'A' });
        await executeLifeDirectives('[[LIFE:PERIOD_START]]', charA, noToast);
        const st = computePeriodStatus(await DB.getAllLifeRecords(), null, lifeToday());
        expect(st.inPeriod).toBe(true);

        const charB = mkChar({ name: 'B' });
        await executeLifeDirectives('[[LIFE:PERIOD_START]]', charB, noToast);
        const starts = (await DB.getAllLifeRecords()).filter(r => r.module === 'period' && r.kind === 'start');
        expect(starts).toHaveLength(1);
    });

    it('start → 同日 end → 模型再發 START：同日兜底判重，不再重複入庫（用戶實報）', async () => {
        // 沿用上個用例寫入的今日 start；補一條今日 end，把狀態機推進「已不在經期」的盲區——
        // 舊邏輯此時會放行重複 start，真重複入庫。
        const charC = mkChar({ name: 'C' });
        await executeLifeDirectives('[[LIFE:PERIOD_END]]', charC, noToast);
        const st = computePeriodStatus(await DB.getAllLifeRecords(), null, lifeToday());
        expect(st.inPeriod).toBe(false);

        const charD = mkChar({ name: 'D' });
        await executeLifeDirectives('[[LIFE:PERIOD_START]]', charD, noToast);
        const starts = (await DB.getAllLifeRecords()).filter(r => r.module === 'period' && r.kind === 'start');
        expect(starts).toHaveLength(1);
        const msgs = await DB.getMessagesByCharId(charD.id, true);
        expect(msgs.find((m: Message) => m.type === 'life_card')!.metadata.duplicate).toBe(true);
    });

    it('EXERCISE 同日同活動、時長寫法不同：判重不重複入庫（用戶實報）', async () => {
        const charE = mkChar({ name: 'E' });
        await executeLifeDirectives('[[LIFE:EXERCISE|跑步|30分鐘]]', charE, noToast);
        // 模型下一輪換個時長寫法 / 乾脆省略時長 —— 舊判據要求時長逐字一致，全都漏網
        const charF = mkChar({ name: 'F' });
        await executeLifeDirectives('[[LIFE:EXERCISE|跑步|半小時]]', charF, noToast);
        await executeLifeDirectives('[[LIFE:EXERCISE|跑步]]', charF, noToast);
        const runs = (await DB.getAllLifeRecords()).filter(r => r.module === 'exercise' && r.payload.activity === '跑步');
        expect(runs).toHaveLength(1);
        const msgs = await DB.getMessagesByCharId(charF.id, true);
        expect(msgs.filter((m: Message) => m.type === 'life_card' && m.metadata.duplicate)).toHaveLength(2);

        // 不同活動照常入庫，不受影響
        await executeLifeDirectives('[[LIFE:EXERCISE|瑜伽]]', charF, noToast);
        const yoga = (await DB.getAllLifeRecords()).filter(r => r.module === 'exercise' && r.payload.activity === '瑜伽');
        expect(yoga).toHaveLength(1);
    });

    it('注入的代記說明包含「一件事只記一次」防重複明示', async () => {
        const char = mkChar();
        const s = await buildLifeRecordInjection(char, '洛洛', { forFirePack: false });
        expect(s).toContain('一件事只記一次');
        expect(s).toContain('已經記過了');
    });
});

describe('全局隱藏模塊（長按頁籤隱藏）', () => {
    afterAll(async () => {
        // 復原，避免汙染同文件其他潛在用例
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: [] });
    });

    it('隱藏的模塊：角色開關全開也不執行代記指令，只留一條系統提示', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: ['med'] });
        const char = mkChar();
        const out = await executeLifeDirectives('記下了[[LIFE:MED|感冒靈]]', char, noToast);
        expect(out).toBe('記下了');
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);

        const msgs = await DB.getMessagesByCharId(char.id, true);
        expect(msgs.some((m: Message) => m.role === 'system' && m.content.includes('藥盒'))).toBe(true);
    });

    it('隱藏的模塊：注入裡不出現對應數據與指令說明', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: ['med', 'exercise'] });
        const char = mkChar();
        const text = await buildLifeRecordInjection(char, '小魚', { forFirePack: false });
        expect(text).toContain('生理期');
        expect(text).not.toContain('今日用藥計劃');
        expect(text).not.toContain('LIFE:MED');
        expect(text).not.toContain('鍛鍊');
        expect(text).not.toContain('LIFE:EXERCISE');
    });

    it('全部模塊隱藏：整段注入為空', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: ['period', 'med', 'expense', 'exercise'] });
        const char = mkChar();
        const text = await buildLifeRecordInjection(char, '小魚', { forFirePack: false });
        expect(text).toBe('');
    });
});

describe('EXPENSE 去重窗口（同金額可以是兩筆不同消費）', () => {
    it('15 分鐘內復讀同金額+同備註 → 判重，不重複入帳（防重 roll / 指令回顯）', async () => {
        const char = mkChar();
        await executeLifeDirectives('[[LIFE:EXPENSE|25.5|奶茶測試]]', char, noToast);
        await executeLifeDirectives('[[LIFE:EXPENSE|25.5|奶茶測試]]', char, noToast);
        const txs = (await DB.getAllTransactions()).filter(t => t.amount === 25.5);
        expect(txs).toHaveLength(1);
    });

    it('隔了超過 15 分鐘的同金額+同備註 → 是新的一筆，正常入帳（修"同金額記帳停止"）', async () => {
        const char = mkChar();
        await DB.saveTransaction({
            id: `tx-test-${Math.random().toString(36).slice(2, 8)}`,
            amount: 66.6, category: 'general', note: '奶茶隔久了',
            timestamp: Date.now() - 16 * 60 * 1000, dateStr: lifeToday(),
        } as any);
        await executeLifeDirectives('[[LIFE:EXPENSE|66.6|奶茶隔久了]]', char, noToast);
        const txs = (await DB.getAllTransactions()).filter(t => t.amount === 66.6);
        expect(txs).toHaveLength(2);
    });

    it('缺 timestamp 的老流水 → 保守按重複處理（回到舊行為，防髒數據翻倍）', async () => {
        const char = mkChar();
        await DB.saveTransaction({
            id: `tx-test-old-${Math.random().toString(36).slice(2, 8)}`,
            amount: 77.7, category: 'general', note: '老數據',
            dateStr: lifeToday(),
        } as any);
        await executeLifeDirectives('[[LIFE:EXPENSE|77.7|老數據]]', char, noToast);
        const txs = (await DB.getAllTransactions()).filter(t => t.amount === 77.7);
        expect(txs).toHaveLength(1);
    });
});

// 主動消息的提示詞是提前打包上雲、到點才渲染的，中間可能隔幾小時甚至幾天。相對說法
// （今日待服 / 生理期第 N 天）在打包那一刻就凍住了，角色到點會照著念成過時的事實：
// 用戶早上八點吃過藥、晚上還被問「今天的藥還沒吃吧」。所以 fire_pack 裡一律寫絕對日期。
describe('buildLifeRecordInjection — fire_pack 寫絕對日期', () => {
    afterAll(async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: [] });
    });

    it('經期中：前台寫「第 N 天」，fire_pack 寫起始日期', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: [] });
        // 同文件前面的用例往共享庫裡寫過今天的 PERIOD_END，清乾淨再造一條今天開始的經期，
        // 否則狀態機判成「已結束」，前台也不會出現「第 N 天」，這條就驗不到東西了。
        const existing = await DB.getAllLifeRecords();
        await Promise.all(existing.filter(r => r.module === 'period').map(r => DB.deleteLifeRecord(r.id)));
        await DB.saveLifeRecord(mkPeriod('start', lifeToday()));
        const char = mkChar();

        const live = await buildLifeRecordInjection(char, '小魚', { forFirePack: false });
        const packed = await buildLifeRecordInjection(char, '小魚', { forFirePack: true });

        expect(live).toContain('生理期：**第');
        expect(packed).toContain('本輪於');
        // 注意別用寬泛的 /第 \d+ 天/：開頭那段人設說明裡有「生理期第 2 天」的舉例，
        // 那是固定文案不是數據，兩種模式下都在。
        expect(packed).not.toContain('生理期：**第');
        expect(packed).toContain('以上記錄截至');
    });

    it('fire_pack 裡不出現任何「今日 X」式的斷言', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: [] });
        const packed = await buildLifeRecordInjection(mkChar(), '小魚', { forFirePack: true });

        for (const stale of ['今日待服', '今日支出', '今日已練', '今日還沒練', '今日暫無']) {
            expect(packed, `fire_pack 不該出現會過期的「${stale}」`).not.toContain(stale);
        }
    });
});

// 記帳合計以前是 txs.reduce((s, t) => s + t.amount, 0) 直接拼進文本的，幾筆小數一加
// 就會變成 49.85999999999999，角色照著念出來很出戲。
describe('注入文本里的金額只到分位', () => {
    it('多筆小數相加不會把 49.85999999999999 念給角色聽', async () => {
        const char = mkChar();
        for (const t of await DB.getAllTransactions()) await DB.deleteTransaction(t.id);
        const stamp = Date.now();
        for (const [i, amount] of [7.9, 12.9, 11.36, 11.9, 5.8].entries()) {
            await DB.saveTransaction({
                id: `tx-test-float-${i}-${Math.random().toString(36).slice(2, 8)}`,
                amount, category: 'general', note: `浮點測試${i}`,
                timestamp: stamp + i, dateStr: lifeToday(),
            } as any);
        }
        const text = await buildLifeRecordInjection(char, '小明', { forFirePack: false });
        expect(text).toContain('合計 49.86');
        expect(text).not.toMatch(/\d+\.\d{3,}/);
    });
});
