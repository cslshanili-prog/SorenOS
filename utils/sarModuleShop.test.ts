import { describe, expect, it } from 'vitest';
import {
    consumeSARModule,
    createSARModuleShopState,
    getSARModuleOffers,
    normalizeSARModuleConfiguration,
    purchaseSARModule,
    readSARModuleShopState,
    rollSARModuleOffers,
    SAR_MODULE_CATALOG,
    SAR_MODULE_DAILY_OFFER_COUNT,
    SAR_MODULE_DAILY_ROLLS,
    SAR_MODULE_SHOP_STORAGE_KEY,
} from './vrWorld/sarModuleShop';

const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    };
};

describe('SAR 模塊商店', () => {
    it('固定目錄包含 46 個唯一模塊和新增的三種語言模塊', () => {
        expect(SAR_MODULE_CATALOG).toHaveLength(46);
        expect(new Set(SAR_MODULE_CATALOG.map(module => module.id)).size).toBe(46);
        expect(SAR_MODULE_CATALOG.map(module => module.title)).toEqual(expect.arrayContaining([
            '古風譯碼器', '王庭貴族協議', '莎翁戲劇感染', '直球增壓器', '結局名稱生成器',
        ]));
        expect(SAR_MODULE_CATALOG.every(module => module.description && module.caianNote && module.example)).toBe(true);
    });

    it('需配置模塊會把輸入收緊成短字面值，普通模塊不會偽造配置', () => {
        const configurable = SAR_MODULE_CATALOG.find(module => module.title === '關鍵詞消音器')!;
        const plain = SAR_MODULE_CATALOG.find(module => !module.configuration)!;
        expect(normalizeSARModuleConfiguration(configurable, '  想\n你  ')).toEqual({
            keyword: '想 你',
        });
        expect(normalizeSARModuleConfiguration(configurable, ' \n\t ')).toBeUndefined();
        expect(normalizeSARModuleConfiguration(plain, '不該生效')).toBeUndefined();
    });

    it('每天只陳列 5 個不同模塊，並提供三次額外重排', () => {
        const storage = memoryStorage();
        const now = new Date(2026, 8, 3, 8, 0, 0);
        let state = readSARModuleShopState(storage, now, () => 0.42);
        expect(getSARModuleOffers(state)).toHaveLength(SAR_MODULE_DAILY_OFFER_COUNT);
        expect(new Set(state.market.offerIds).size).toBe(SAR_MODULE_DAILY_OFFER_COUNT);
        expect(state.market.rollsRemaining).toBe(SAR_MODULE_DAILY_ROLLS);

        for (let index = 0; index < SAR_MODULE_DAILY_ROLLS; index += 1) {
            state = rollSARModuleOffers(state, () => (index + 1) / 10, storage);
        }
        expect(state.market.rollsRemaining).toBe(0);
        expect(rollSARModuleOffers(state, () => 0.9, storage)).toEqual(state);
    });

    it('跨本地日期自動刷新貨架和重排次數，但保留庫存', () => {
        const storage = memoryStorage();
        const dayOne = new Date(2026, 8, 3, 22, 0, 0);
        let state = readSARModuleShopState(storage, dayOne, () => 0.1);
        const offered = state.market.offerIds[0];
        state = purchaseSARModule(state, offered, { developmentMode: true, now: dayOne.getTime(), storage }).state;
        state = rollSARModuleOffers(state, () => 0.2, storage);
        expect(state.market.rollsRemaining).toBe(2);

        const nextDay = readSARModuleShopState(storage, new Date(2026, 8, 4, 1, 0, 0), () => 0.8);
        expect(nextDay.market.dayKey).toBe('2026-09-04');
        expect(nextDay.market.rollsRemaining).toBe(3);
        expect(nextDay.inventory[offered]).toBe(1);
    });

    it('試運行領取不扣票據，重複領取會疊加庫存', () => {
        const storage = memoryStorage();
        let state = readSARModuleShopState(storage, new Date(2026, 8, 3), () => 0.3);
        const offered = state.market.offerIds[0];
        const first = purchaseSARModule(state, offered, { developmentMode: true, now: 1, storage });
        expect(first.ok).toBe(true);
        state = first.state;
        const second = purchaseSARModule(state, offered, { developmentMode: true, now: 2, storage });
        expect(second.state.inventory[offered]).toBe(2);
        expect(second.state.credits).toBe(0);
        expect(second.state.purchases).toHaveLength(2);
    });

    it('正式計價時會阻止餘額不足，並拒絕購買非今日商品', () => {
        const state = createSARModuleShopState(new Date(2026, 8, 3), () => 0.5);
        const offered = state.market.offerIds[0];
        const notOffered = SAR_MODULE_CATALOG.find(module => !state.market.offerIds.includes(module.id))!;
        expect(purchaseSARModule(state, offered).reason).toBe('insufficient-credits');
        expect(purchaseSARModule(state, notOffered.id, { developmentMode: true }).reason).toBe('not-offered');
    });

    it('只在正式裝載後消耗一枚庫存', () => {
        const storage = memoryStorage();
        let state = readSARModuleShopState(storage, new Date(2026, 8, 3), () => 0.3);
        const offered = state.market.offerIds[0];
        state = purchaseSARModule(state, offered, { developmentMode: true, storage }).state;
        const consumed = consumeSARModule(state, offered, storage);
        expect(consumed.ok).toBe(true);
        expect(consumed.state.inventory[offered]).toBeUndefined();
        expect(consumeSARModule(consumed.state, offered, storage).reason).toBe('not-owned');
    });

    it('損壞或過期的市場存檔會安全重建', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_MODULE_SHOP_STORAGE_KEY, '{broken');
        expect(readSARModuleShopState(storage, new Date(2026, 8, 3), () => 0.4).market.offerIds).toHaveLength(5);

        storage.setItem(SAR_MODULE_SHOP_STORAGE_KEY, JSON.stringify({
            version: 1,
            credits: 12,
            inventory: {},
            purchases: [],
            market: { dayKey: '2026-09-02', offerIds: [], rollsRemaining: 0 },
        }));
        const renewed = readSARModuleShopState(storage, new Date(2026, 8, 3), () => 0.6);
        expect(renewed.market).toMatchObject({ dayKey: '2026-09-03', rollsRemaining: 3 });
        expect(renewed.market.offerIds).toHaveLength(5);
    });
});
