import { describe, expect, it } from 'vitest';
import { SAR_CLUB_STORAGE_KEY } from './vrWorld/sarClub';
import { SAR_GACHA_STORAGE_KEY } from './vrWorld/sarGacha';
import { SAR_MODULE_CATALOG, SAR_MODULE_SHOP_STORAGE_KEY } from './vrWorld/sarModuleShop';
import { collectSARLocalBackup, restoreSARLocalBackup } from './vrWorld/sarBackup';
import {
    SAR_SIMULATION_STORAGE_KEY,
    archiveSARSimulationRun,
    buildSARArchiveMarkdown,
    buildSARCharacterShareText,
    buildSARIdentityForgeRequest,
    buildSARLongTermContext,
    buildSARIdentityRuntimePrompt,
    buildSARSimulationTurnPrompt,
    completeSARSimulationTurn,
    getSARSimulationPhase,
    getSARArchiveFilename,
    getSARSimulationThreadId,
    parseSARIdentityProfile,
    parseSARSimulationReply,
    readSARSimulationState,
    resolveSARUserMaskProfile,
    resolveSARWorldlineProfile,
    resolveSARSimulationApi,
    startSARSimulationRun,
    saveSARIdentityCard,
    writeSARSimulationState,
} from './vrWorld/sarSimulation';

const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
};

const worldlineFields = {
    worldName: '沉星王都',
    worldPremise: '會吞噬謊言的魔法王都正在內戰。',
    arrivalPoint: '兩人已經闖過三道封鎖，故事來到王宮失守前夜。',
    activeCrisis: '處刑鐘敲響，追兵正在撞開藏身處的門。',
    sharedObjective: '在鐘聲結束前奪回王印並離開王城。',
    countdown: '第七次鐘聲後城門永久封閉。',
    hiddenTruth: '王印裡封存著角色被改寫的原始記憶。',
    climaxChoice: '救下城中居民，或保住角色僅剩的人格記錄。',
    userMaskTitle: '失印執鑰者',
    userIdentity: '用戶是持有半枚王印的流亡執鑰者，沒有替任何人作決定的特權。',
    userLifePatch: '用戶在這條世界線中從未擁有現實身份，只以王城流亡者的人生活到此刻。',
};

describe('SAR 推演與備份狀態', () => {
    const quotaCard = (id: string) => ({
        id, charId: 'c', charName: 'C', charAvatar: 'data:image/png;base64,' + 'A'.repeat(50000),
        variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
        profile: { title: '異格', identity: '身份', steelSeal: '鋼印', openingScene: '開場', openingLine: '台詞' },
    } as any);

    it('壓縮已有內聯頭像，連續保存第九張後仍能重讀並進入故事', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [quotaCard('old')], runs: [] }));
        const limited = {
            getItem: storage.getItem,
            setItem: (key: string, value: string) => {
                if (value.length > 60000) throw new DOMException('Full', 'QuotaExceededError');
                storage.setItem(key, value);
            },
        };
        for (let i = 2; i <= 9; i++) saveSARIdentityCard(quotaCard(String(i)), limited);
        const state = readSARSimulationState(limited);
        expect(state.cards).toHaveLength(9);
        expect(state.cards.every(card => !card.charAvatar)).toBe(true);
        expect(state.cards.find(card => card.id === 'old')?.profile.title).toBe('異格');
        const run = startSARSimulationRun('9', limited);
        expect(readSARSimulationState(limited).runs[0].id).toBe(run.id);
    });

    it('存儲失敗會報錯且不損壞舊卡或虛報啟動成功', () => {
        const storage = memoryStorage();
        saveSARIdentityCard(quotaCard('old'), storage);
        const before = storage.getItem(SAR_SIMULATION_STORAGE_KEY);
        const full = { getItem: storage.getItem, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } };
        expect(() => saveSARIdentityCard(quotaCard('new'), full)).toThrow('保存失敗');
        expect(() => startSARSimulationRun('old', full)).toThrow('保存失敗');
        expect(storage.getItem(SAR_SIMULATION_STORAGE_KEY)).toBe(before);
    });

    it('移除所有舊頭像副本但不修改傳入卡片，角色原始資源不受影響', () => {
        const card = quotaCard('inline');
        const remote = { ...quotaCard('remote'), charAvatar: 'https://example.com/avatar.png' };
        const blob = { ...quotaCard('blob'), charAvatar: 'blobref:avatar' };
        const state = writeSARSimulationState({ version: 2, cards: [card, remote, blob], runs: [] }, memoryStorage());
        expect(card.charAvatar).toMatch(/^data:/);
        expect(state.cards.every(item => !('charAvatar' in item))).toBe(true);
        expect(remote.charAvatar).toBe('https://example.com/avatar.png');
        expect(blob.charAvatar).toBe('blobref:avatar');
    });

    it('SAR 上下文只保留角色本體、User 基礎資料和關係門牌', () => {
        const char = {
            id: 'c',
            name: 'C',
            avatar: '',
            systemPrompt: 'BASE_CHARACTER_MARKER',
            worldview: 'BASE_WORLD_MARKER',
            description: '',
            memoryPalaceEnabled: true,
            memoryPalaceInjection: 'PALACE_RECALL_MARKER',
            roomPlatesInjection: 'ROOM_PLATE_MARKER',
            refinedMemories: { '2026-08': 'LONG_TERM_MARKER' },
            activeMemoryMonths: [],
            memories: [],
            timeAwarenessEnabled: true,
            emotionConfig: { enabled: true },
            activeBuffs: [{ name: 'TEMP_MOOD_MARKER', intensity: 0.9 }],
            buffInjection: 'TEMP_BUFF_MARKER',
        } as any;
        const text = buildSARLongTermContext(
            char,
            { name: 'U', bio: 'USER_PROFILE_MARKER' } as any,
            'PALACE_RECALL_MARKER',
        );

        expect(text).toContain('BASE_CHARACTER_MARKER');
        expect(text).toContain('USER_PROFILE_MARKER');
        expect(text).toContain('ROOM_PLATE_MARKER');
        expect(text).not.toContain('BASE_WORLD_MARKER');
        expect(text).not.toContain('LONG_TERM_MARKER');
        expect(text).not.toContain('PALACE_RECALL_MARKER');
        expect(text).not.toContain('TEMP_MOOD_MARKER');
        expect(text).not.toContain('TEMP_BUFF_MARKER');
        expect(text).not.toContain('### 當前時間 (Now)');
        expect(text).not.toContain('[System: 實時狀態 (Live Context)]');

        const runtimeText = buildSARLongTermContext(
            char,
            { name: 'U', bio: 'USER_PROFILE_MARKER' } as any,
            '',
            '',
            false,
        );
        expect(runtimeText).not.toContain('USER_PROFILE_MARKER');
        expect(runtimeText).toContain('現實 User 設定已被異界面具替代');
        expect(runtimeText).toContain('ROOM_PLATE_MARKER');
    });

    it('可解析圍欄內的完整異格身份卡，並拒絕缺失鋼印的結果', () => {
        const valid = parseSARIdentityProfile('```json\n' + JSON.stringify({
            title: '潮汐以北', logline: '一句概述', identity: '新的身份', lifePatch: '人生補丁',
            relationship: '關係狀態', steelSeal: '不可違背的判斷', patchCost: '補丁代價',
            behaviorShift: '行為偏移', ...worldlineFields, openingScene: '開場場景', openingLine: '第一句', playerPrompt: '回應鉤子',
        }) + '\n```');
        expect(valid?.title).toBe('潮汐以北');
        expect(valid?.steelSeal).toBe('不可違背的判斷');
        expect(valid?.activeCrisis).toContain('追兵');
        expect(valid?.userMaskTitle).toBe('失印執鑰者');
        expect(parseSARIdentityProfile('{"title":"只有標題"}')).toBeNull();
    });

    it('鑄造提示同時生成 Char 異格與 User 面具，並禁止調用現實事件記憶', () => {
        const text = buildSARIdentityForgeRequest(
            { name: 'Sully' },
            { id: 'variant-01', pool: 'variant', title: '未曾被你改變', group: '關係偏移', summary: '摘要', accent: 'blue', sigil: 'compass', memory: '導演層記憶' },
            { id: 'story-01', pool: 'story', title: '敵對陣營', group: '陣營與衝突', summary: '摘要', accent: 'red', sigil: 'chain', memory: '導演層記憶' },
        );
        expect(text).toContain('異世界異格扭蛋');
        expect(text).not.toContain('60%–75%');
        expect(text).toContain('用戶是參與者');
        expect(text).not.toContain('逼出即時回應');
        expect(text).toContain('人格鋼印');
        expect(text).toContain('每個補丁都必須攜帶代價');
        expect(text).toContain('activeCrisis');
        expect(text).toContain('hiddenTruth');
        expect(text).toContain('userMaskTitle');
        expect(text).toContain('完全替代 User 的現實 bio');
        expect(text).toContain('不提供任何可調用的事件記憶');
        expect(text).not.toContain('memoryFuse');
        expect(text).toContain('用戶與角色身處同一現場');
    });

    it('運行提示會把完整身份卡和鋼印固定注入每一輪', () => {
        const text = buildSARIdentityRuntimePrompt({
            id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '異格', logline: '鉤子', identity: '身份', lifePatch: '補丁', relationship: '關係', memoryStance: '記憶', steelSeal: '絕不承認需要任何人', patchCost: '代價', behaviorShift: '偏移', ...worldlineFields, openingScene: '場景', openingLine: '台詞', playerPrompt: '回應' },
        }, { id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 7, maxInteractions: 50 });
        expect(text).toContain('人格鋼印：絕不承認需要任何人');
        expect(text).toContain('當前進度 7/50');
        expect(text).toContain('禁止突然治癒');
        expect(text).toContain('已經說出的開場台詞：台詞');
        expect(text).toContain('當前危機：處刑鐘敲響');
        expect(text).toContain('下一輪所處階段：相處與變化');
        expect(text).toContain('面具名：失印執鑰者');
        expect(text).toContain('現實層沒有可調用的事件記憶');
        expect(text).toContain('第 50 輪通過既定返航機制');
        expect(text).not.toContain('連續兩輪只有情緒確認');
        expect(text).toContain('安靜不是失敗');
        expect(text).not.toContain('真實告別記憶');
    });

    it('五十輪保留篇幅階段，在最後六輪收束實際經歷', () => {
        expect(getSARSimulationPhase(0).id).toBe('hot-drop');
        expect(getSARSimulationPhase(3).id).toBe('cascade');
        expect(getSARSimulationPhase(12).id).toBe('reversal');
        expect(getSARSimulationPhase(24).id).toBe('climax');
        expect(getSARSimulationPhase(38).id).toBe('cost');
        expect(getSARSimulationPhase(44).id).toBe('return');
        expect(getSARSimulationPhase(47).id).toBe('ending');
        expect(getSARSimulationPhase(49).id).toBe('arrival');
        expect(getSARSimulationPhase(49).directive).toContain('回到現實');
    });

    it('舊身份卡無需重抽，自然接續原世界模塊與既有事實', () => {
        const card = {
            id: 'old-card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '舊異格', logline: '鉤子', identity: '身份', lifePatch: '補丁', relationship: '關係', memoryStance: '記憶', steelSeal: '鋼印', patchCost: '代價', behaviorShift: '偏移', openingScene: '舊場景', openingLine: '舊台詞', playerPrompt: '快走' },
        } as any;
        const worldline = resolveSARWorldlineProfile(card);
        expect(worldline.retrofitted).toBe(true);
        expect(worldline.worldName).toBe('王城處刑夜');
        expect(worldline.activeCrisis).toContain('不要求你先理解背景');
        expect(resolveSARUserMaskProfile(card)).toMatchObject({ title: '無名越界者', retrofitted: true });
        expect(buildSARIdentityRuntimePrompt(card)).toContain('舊版卡的補鑄世界線');
    });

    it('正式推演統一為現場行動，保留舊劇情連續性與用戶自主權', () => {
        const card = {
            id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '異格', logline: '鉤子', identity: '身份', lifePatch: '補丁', relationship: '關係', memoryStance: '記憶', steelSeal: '鋼印', patchCost: '代價', behaviorShift: '偏移', openingScene: '場景', openingLine: '台詞', playerPrompt: '回應' },
        } as any;
        const run = { id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 3, maxInteractions: 50 } as any;
        const prompt = buildSARSimulationTurnPrompt(card, run);
        expect(prompt).toContain('現場演出｜線下劇情');
        expect(prompt).toContain('用戶輸入代表此刻在故事現場說的話');
        expect(prompt).toContain('環境變化、動作、停頓');
        expect(prompt).toContain('同一條連續世界線');
        expect(prompt).toContain('歷史記錄若包含遠程通訊');
        expect(prompt).toContain('不憑空傳送');
        expect(prompt).toContain('不替用戶行動');
        expect(prompt).toContain('世界意志｜旁白與航向');
        expect(prompt).toContain('讓玩家不必自己承擔劇本規劃');
        expect(prompt).toContain('{"worldNarration"');
        expect(prompt).not.toContain('保持文字聯繫');
        expect(prompt).not.toContain('切換方式');
    });

    it('正式推演把世界意志旁白和角色演出分開解析，併兼容舊字段與純文本回應', () => {
        expect(parseSARSimulationReply('```json\n{"worldNarration":"城門開始坍塌。","character":"跟緊我。"}\n```')).toEqual({
            worldNarration: '城門開始坍塌。',
            character: '跟緊我。',
        });
        expect(parseSARSimulationReply('{"gm":"舊旁白。","character":"舊角色。"}')).toEqual({ worldNarration: '舊旁白。', character: '舊角色。' });
        expect(parseSARSimulationReply('舊版角色直接回應。')).toEqual({ worldNarration: '', character: '舊版角色直接回應。' });
    });

    it('封存檔案可下載完整世界旁白/角色記錄，並生成克制的角色分享簡報', () => {
        const card = {
            id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '異格', logline: '鉤子', identity: '身份', lifePatch: '補丁', relationship: '關係', steelSeal: '鋼印', patchCost: '代價', behaviorShift: '偏移', ...worldlineFields, openingScene: '開場風暴', openingLine: '抓住我。', playerPrompt: '伸手' },
        } as any;
        const run = { id: 'run-archive', cardId: 'card', createdAt: 1, updatedAt: 2, archivedAt: 2, status: 'archived', archiveReason: 'completed', interactionsUsed: 50, maxInteractions: 50 } as any;
        const messages = [
            { id: 1, role: 'user', type: 'text', content: '我抓住了。', metadata: { sarMode: 'offline', sarTurn: 50 } },
            { id: 2, role: 'assistant', type: 'text', content: '現實見。', metadata: { sarMode: 'offline', sarTurn: 50, sarWorldNarration: '返航門在身後閉合。' } },
        ] as any;
        const markdown = buildSARArchiveMarkdown(card, run, messages, 'U');
        const share = buildSARCharacterShareText(card, run, messages, 'U');
        expect(markdown).toContain('# SAR 異界座標封存檔案');
        expect(markdown).toContain('返航門在身後閉合。');
        expect(markdown).toContain('世界意志');
        expect(markdown).not.toContain('SAR 航標 / GM');
        expect(markdown).toContain('現實見。');
        expect(markdown).toContain('完整推演記錄');
        expect(share).toContain('我從一條封存的異界座標回來');
        expect(share).toContain('不是你在現實中原本擁有的記憶');
        expect(getSARArchiveFilename(card, run)).toBe('異格-C-50of50.md');
    });

    it('只有完成回應才推進一輪，50/50 自動完成並封存', () => {
        const storage = memoryStorage();
        const profile = { title: '異格', logline: '鉤子', identity: '身份', lifePatch: '補丁', relationship: '關係', memoryStance: '記憶', steelSeal: '鋼印', patchCost: '代價', behaviorShift: '偏移', openingScene: '場景', openingLine: '台詞', playerPrompt: '回應' };
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [{ id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1, profile }], runs: [{ id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 48, maxInteractions: 50 }] }));
        const fortyNine = completeSARSimulationTurn('run', 48, storage);
        expect(fortyNine).toMatchObject({ interactionsUsed: 49, status: 'active' });
        expect(() => completeSARSimulationTurn('run', 48, storage)).toThrow('推演進度已變化');
        const fifty = completeSARSimulationTurn('run', 49, storage);
        expect(fifty).toMatchObject({ interactionsUsed: 50, status: 'archived', archiveReason: 'completed' });
        expect(fifty.archivedAt).toBeTypeOf('number');
    });

    it('緊急封存保留當前進度且實例線程與原角色私聊隔離', () => {
        const storage = memoryStorage();
        const profile = { title: '異格', logline: '鉤子', identity: '身份', lifePatch: '補丁', relationship: '關係', memoryStance: '記憶', steelSeal: '鋼印', patchCost: '代價', behaviorShift: '偏移', openingScene: '場景', openingLine: '台詞', playerPrompt: '回應' };
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [{ id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1, profile }], runs: [{ id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 17, maxInteractions: 50 }] }));
        const archived = archiveSARSimulationRun('run', storage);
        expect(archived).toMatchObject({ interactionsUsed: 17, status: 'archived', archiveReason: 'emergency' });
        expect(getSARSimulationThreadId('run')).toBe('sar-simulation:run');
        expect(getSARSimulationThreadId('run')).not.toBe('c');
    });

    it('舊版藍圖自動拆成永久身份卡和原推演實例', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 1, records: [{
            id: 'old-run', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 2,
            status: 'active', interactionsUsed: 3, maxInteractions: 50,
            blueprint: { title: '舊檔', logline: '概述', characterState: '變化', worldTranslation: '世界', memoryPerformance: '記憶', openingScene: '場景', openingLine: '台詞', playerPrompt: '回應' },
        }] }));
        const state = readSARSimulationState(storage);
        expect(state.version).toBe(2);
        expect(state.cards).toHaveLength(1);
        expect(state.cards[0].legacy).toBe(true);
        expect(state.runs[0]).toMatchObject({ id: 'old-run', interactionsUsed: 3, cardId: state.cards[0].id });
    });

    it('身份卡收藏與五十輪實例彼此獨立，啟動不會複製卡片', () => {
        const storage = memoryStorage();
        const profile = { title: '異格', logline: '鉤子', identity: '身份', lifePatch: '補丁', relationship: '關係', memoryStance: '記憶', steelSeal: '鋼印', patchCost: '代價', behaviorShift: '偏移', openingScene: '場景', openingLine: '台詞', playerPrompt: '回應' };
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [{ id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1, profile }], runs: [] }));
        const first = startSARSimulationRun('card', storage);
        const second = startSARSimulationRun('card', storage);
        const state = readSARSimulationState(storage);
        expect(first.id).toBe(second.id);
        expect(state.cards).toHaveLength(1);
        expect(state.runs).toHaveLength(1);
        expect(state.runs[0]).toMatchObject({ interactionsUsed: 0, maxInteractions: 50 });
    });

    it('API 優先級為角色覆蓋、彼方獨立、聊天默認', () => {
        const api = (baseUrl: string) => ({ baseUrl, apiKey: '', model: 'test' });
        const char = { id: 'c', name: 'C', avatar: '' } as any;
        expect(resolveSARSimulationApi(char, api('vr'), api('chat')).baseUrl).toBe('vr');
        char.vrState = { enabled: true, intervalMinutes: 60, api: api('char') };
        expect(resolveSARSimulationApi(char, api('vr'), api('chat')).baseUrl).toBe('char');
        delete char.vrState.api;
        expect(resolveSARSimulationApi(char, null, api('chat')).baseUrl).toBe('chat');
    });

    it('新備份會攜帶 SAR 四類本地狀態', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify({ version: 1, updateSeenVersion: 1, npcPreference: 'show', caianMet: true }));
        storage.setItem(SAR_GACHA_STORAGE_KEY, JSON.stringify({ version: 1, freeDrawDate: {}, collection: { 'variant-01': 1 }, history: [] }));
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [], runs: [] }));
        storage.setItem(SAR_MODULE_SHOP_STORAGE_KEY, JSON.stringify({
            version: 1,
            credits: 0,
            inventory: {},
            purchases: [],
            market: { dayKey: '2026-09-06', offerIds: [], rollsRemaining: 3 },
        }));
        const backup = collectSARLocalBackup(storage);
        expect(backup.club).toBeTruthy();
        expect(backup.gacha).toBeTruthy();
        expect(backup.simulations).toEqual({ version: 2, cards: [], runs: [] });
        expect(backup.moduleShop).toBeTruthy();
    });

    it('導入不含 SAR 字段的舊主歷史會清掉當前設備標記', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, '{}');
        storage.setItem(SAR_GACHA_STORAGE_KEY, '{}');
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, '{}');
        storage.setItem(SAR_MODULE_SHOP_STORAGE_KEY, '{}');
        restoreSARLocalBackup(undefined, { replaceMissing: true }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_GACHA_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_SIMULATION_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_MODULE_SHOP_STORAGE_KEY)).toBeNull();
    });

    it('媒體補丁導入不會清理 SAR，顯式備份則會覆蓋', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify({ npcPreference: 'show' }));
        restoreSARLocalBackup(undefined, { replaceMissing: false }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toContain('show');

        restoreSARLocalBackup({ version: 1, club: { version: 1, updateSeenVersion: 0, npcPreference: null, caianMet: false } }, { replaceMissing: true }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toContain('"npcPreference":null');
        expect(storage.getItem(SAR_MODULE_SHOP_STORAGE_KEY)).toBeNull();
        expect(readSARSimulationState(storage).cards).toHaveLength(0);
        expect(readSARSimulationState(storage).runs).toHaveLength(0);
    });

    it('模塊商店庫存會隨 SAR 備份恢復', () => {
        const storage = memoryStorage();
        const moduleId = SAR_MODULE_CATALOG[0].id;
        restoreSARLocalBackup({
            version: 1,
            moduleShop: {
                version: 1,
                credits: 0,
                inventory: { [moduleId]: 2 },
                purchases: [],
                market: { dayKey: '2026-09-06', offerIds: SAR_MODULE_CATALOG.slice(0, 5).map(item => item.id), rollsRemaining: 2 },
            },
        }, { replaceMissing: true }, storage);

        expect(storage.getItem(SAR_MODULE_SHOP_STORAGE_KEY)).toContain(`"${moduleId}":2`);
    });
});
