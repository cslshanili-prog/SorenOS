import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEmbeddings } from './embedding';
import type { EmbeddingConfig } from './types';

// 這組測試守護「分批 / 並行不破壞結果」這條契約：
//   1. 無論多少條文本，返回的向量條數 = 輸入條數，且順序嚴格對應下標
//   2. 任何單次請求塞的條數都 ≤ 10（DashScope/Qwen 的硬上限）
//   3. 多批走並行 + 併發上限，不改變上面兩條
//
// 調用方（pipeline 的 queryVectors[i]、vectorStore 的 vectors[i]）全靠
// 「第 i 個向量對應第 i 條輸入」這個保序契約，所以這是召回正確性的地基。

const config: EmbeddingConfig = {
    baseUrl: 'https://api.test/v1',
    apiKey: 'test-key',
    model: 'BAAI/bge-m3',
    dimensions: 1024,
};

// 記錄每次 fetch 實際塞了幾條 input / 每條多長，用於斷言 batch 上限與截斷
let batchSizes: number[] = [];
let batchInputs: string[][] = [];

beforeEach(() => {
    batchSizes = [];
    batchInputs = [];
    // mock fetch：把每條輸入文本「原樣編碼」進它的向量第一位。
    // 文本約定是 String(i)（長文本場景是 `${i}xxx...`，parseFloat 取前綴數字），
    // 所以正確情況下 results[i][0] === i。
    // 用文本身份編碼（而非請求內的局部下標）→ 一旦順序錯亂，斷言立刻失敗。
    global.fetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body as string);
        const input: string[] = body.input;
        batchSizes.push(input.length);
        batchInputs.push(input);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: input.map((text, localIdx) => ({
                    index: localIdx,
                    embedding: [parseFloat(text)],
                })),
            }),
        } as any;
    }) as any;
});

describe('getEmbeddings 分批 / 並行保序', () => {
    it('空輸入返回空數組，不發請求', async () => {
        const out = await getEmbeddings([], config);
        expect(out).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('單條輸入返回單條向量', async () => {
        const out = await getEmbeddings(['0'], config);
        expect(out).toHaveLength(1);
        expect(out[0][0]).toBe(0);
        expect(batchSizes).toEqual([1]);
    });

    it('恰好 10 條 → 一次請求，順序正確', async () => {
        const texts = Array.from({ length: 10 }, (_, i) => String(i));
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(10);
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(Math.max(...batchSizes)).toBeLessThanOrEqual(10);
    });

    it('12 條（檢索典型場景）→ 拆成 ≤10 的多批，順序仍嚴格對應', async () => {
        const texts = Array.from({ length: 12 }, (_, i) => String(i));
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(12);
        // 關鍵：第 i 個向量必須仍是第 i 條輸入算出來的
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(fetch).toHaveBeenCalledTimes(2);
        // 沒有任何一批超過 10（否則 Qwen 會 400）
        batchSizes.forEach(n => expect(n).toBeLessThanOrEqual(10));
    });

    it('100 條（重建場景）→ 全部保序，且每批都 ≤10', async () => {
        const texts = Array.from({ length: 100 }, (_, i) => String(i));
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(100);
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(100); // 不多不少
        batchSizes.forEach(n => expect(n).toBeLessThanOrEqual(10));
    });
});

describe('getEmbeddings 長文本防線（防 400 code 20015）', () => {
    it('單條超長輸入被截到 4000 字符（防單條超 8192 token），且日誌面板有提示', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const long = '0' + 'x'.repeat(10000);
            const out = await getEmbeddings([long], config);
            expect(out).toHaveLength(1);
            expect(out[0][0]).toBe(0);
            expect(batchInputs[0][0].length).toBe(4000);
            // 截斷不能靜默：日誌面板（只抓 console.error）必須能看到截了哪條
            const logged = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(logged).toContain('已截斷');
            expect(logged).toContain('第1條');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('多條長文本按批內字符預算(6000)切批，仍嚴格保序', async () => {
        // 4 條各 2000 字：前 3 條 6000 字裝滿一批，第 4 條另起一批
        const texts = Array.from({ length: 4 }, (_, i) => `${i}${'x'.repeat(1999)}`);
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(4);
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(batchSizes).toEqual([3, 1]);
        // 任何一批的字符總量都不超預算
        batchInputs.forEach(batch => {
            expect(batch.reduce((a, t) => a + t.length, 0)).toBeLessThanOrEqual(6000);
        });
    });

    it('短文本行為不變：12 條短 query 仍只拆成 2 批', async () => {
        const texts = Array.from({ length: 12 }, (_, i) => String(i));
        await getEmbeddings(texts, config);
        expect(batchSizes).toEqual([10, 2]);
    });
});

describe('getEmbeddings 批量 400 自動降級為逐條', () => {
    it('批量被 400 拒 → 逐條重發，結果完整且保序，4xx 不做無謂重試', async () => {
        global.fetch = vi.fn(async (_url: any, init: any) => {
            const body = JSON.parse(init.body as string);
            const input: string[] = body.input;
            batchSizes.push(input.length);
            if (input.length > 1) {
                return {
                    ok: false,
                    status: 400,
                    text: async () => '{"code":20015,"message":"The parameter is invalid. Please check again."}',
                } as any;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    data: [{ index: 0, embedding: [parseFloat(input[0])] }],
                }),
            } as any;
        }) as any;

        const errorSpy = vi.spyOn(console, 'error');
        try {
            const out = await getEmbeddings(['0', '1', '2'], config);
            expect(out).toHaveLength(3);
            out.forEach((v, i) => expect(v[0]).toBe(i));
            // 1 次批量(400) + 3 次單條——批量 400 沒有被重試第二遍
            expect(batchSizes).toEqual([3, 1, 1, 1]);
            // 降級成功必須在日誌面板昭告"已恢復、結果完整"，否則用戶只看到 400 會以為記憶丟了
            const logged = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(logged).toContain('全部成功');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('降級後單條仍 400 → 報錯裡帶上第幾條、多長、內容開頭（可定位壞輸入）', async () => {
        global.fetch = vi.fn(async () => ({
            ok: false,
            status: 400,
            text: async () => '{"code":20015,"message":"The parameter is invalid."}',
        })) as any;

        await expect(getEmbeddings(['正常文本', 'data:image/png;base64,AAAA'], config))
            .rejects.toThrow(/第 1\/2 [条條].*正常文本/s);
    });

    it('5xx 仍然重試一次後成功', async () => {
        let calls = 0;
        global.fetch = vi.fn(async (_url: any, init: any) => {
            calls++;
            if (calls === 1) {
                return { ok: false, status: 500, text: async () => 'oops' } as any;
            }
            const input: string[] = JSON.parse(init.body as string).input;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    data: input.map((text, localIdx) => ({ index: localIdx, embedding: [parseFloat(text)] })),
                }),
            } as any;
        }) as any;

        const out = await getEmbeddings(['7'], config);
        expect(out[0][0]).toBe(7);
        expect(calls).toBe(2);
    });
});
