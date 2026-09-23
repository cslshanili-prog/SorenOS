import { readSARCommerceValue } from './sarCommerceStorage';

export type SARModulePool = 'variant' | 'story';
export type SARModuleAccent = 'blue' | 'red' | 'olive' | 'violet' | 'ivory' | 'graphite' | 'rose' | 'teal';

export type SARModuleDefinition = {
    id: string;
    pool: SARModulePool;
    title: string;
    group: string;
    summary: string;
    accent: SARModuleAccent;
    sigil: 'compass' | 'chain' | 'branch' | 'rose' | 'sun' | 'blade' | 'heart' | 'web';
    memory: string;
    routeTags?: string[];
};

export type SARGachaHistoryEntry = {
    id: string;
    moduleId: string;
    pool: SARModulePool;
    drawnAt: number;
};

export type SARGachaState = {
    version: 1;
    freeDrawDate: Partial<Record<SARModulePool, string>>;
    collection: Record<string, number>;
    history: SARGachaHistoryEntry[];
    /** Consecutive owned draws per pool; legacy saves start at zero. */
    duplicateStreak?: Partial<Record<SARModulePool, number>>;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const SAR_GACHA_STORAGE_KEY = 'vr_sar_gacha_state_v1';

export const DEFAULT_SAR_GACHA_STATE: SARGachaState = {
    version: 1,
    freeDrawDate: {},
    collection: {},
    history: [],
};

const ACCENTS: SARModuleAccent[] = ['blue', 'red', 'olive', 'violet', 'ivory', 'graphite', 'rose', 'teal'];
const SIGILS: SARModuleDefinition['sigil'][] = ['compass', 'chain', 'branch', 'rose', 'sun', 'blade', 'heart', 'web'];

const makeModule = (
    pool: SARModulePool,
    index: number,
    title: string,
    group: string,
    summary: string,
    memory: string,
    routeTags?: string[],
): SARModuleDefinition => ({
    id: `${pool}-${String(index + 1).padStart(2, '0')}`,
    pool,
    title,
    group,
    summary,
    memory,
    routeTags,
    accent: ACCENTS[index % ACCENTS.length],
    sigil: SIGILS[index % SIGILS.length],
});

const VARIANT_SOURCE: Array<[string, string, string]> = [
    ['未曾被你改變', '關係偏移', '一切照常發生，唯獨你從未進入過 TA 的生命。'],
    ['記憶之外', '認知缺口', 'TA 記得世界，卻找不到任何與你有關的證據。'],
    ['被你改變得太多', '關係偏移', '你留下的影響已經壓過了 TA 原本的性格。'],
    ['不再需要你', '關係偏移', 'TA 已經學會獨自完成過去只能與你一起完成的事。'],
    ['被你遺棄過', '關係偏移', '在這條分歧裡，等待確實以你的缺席告終。'],
    ['沒有傷口的人', '經歷改寫', '那件塑造 TA 的壞事從來沒有發生。'],
    ['傷口從未癒合', '經歷改寫', '時間向前走了，傷口卻留在最初的形狀。'],
    ['已經得到一切', '慾望終點', 'TA 曾經追逐的東西都已握在手中。'],
    ['主動放棄', '慾望終點', 'TA 清醒地放下了曾經絕不肯讓步的目標。'],
    ['成為了自己最討厭的人', '信念斷面', '為了抵達終點，TA 接受了曾經最厭惡的方式。'],
    ['最正確的 TA', '信念斷面', '每次選擇都符合原則，但正確沒有讓 TA 更幸福。'],
    ['被所有人喜歡的 TA', '社會投影', 'TA 成為了所有人期待的樣子，只剩你看得出違和。'],
    ['信念盡頭', '信念斷面', '那套曾支撐 TA 的信念已經走到無法繼續的地方。'],
    ['越過底線', '信念斷面', 'TA 已經做過那件原本堅信自己永遠不會做的事。'],
    ['不允許被定義', '自我認知', 'TA 拒絕接受設定、他人和過去給出的任何結論。'],
    ['最後一次相信', '關係偏移', 'TA 願意再相信一次，但不會有下一次。'],
    ['只剩核心', '人格剝離', '身份、習慣與經歷被逐層剝離，只留下不可讓渡的部分。'],
    ['第二個自己', '人格映照', '另一個同樣確信自己是本體的 TA 出現了。'],
    ['我只是模擬', '自我認知', 'TA 接受自己是一次推演，並重新衡量所有感受。'],
    ['我就是我', '自我認知', '無論誕生方式如何，TA 拒絕把自我交給外部證明。'],
    ['共享意識', '人格邊界', 'TA 與另一個意識共享記憶，卻無法共享全部意願。'],
    ['已經知道結局', '因果知情', 'TA 知道這段關係會怎樣結束，仍然抵達了你面前。'],
    ['很久以後的 TA', '時間切片', '漫長歲月之後，TA 帶著你尚未經歷的歷史回來。'],
    ['回到很久以前', '時間切片', 'TA 回到了尚未成為如今自己的時期。'],
    ['走完結局之後', '時間切片', '故事已經結束，TA 卻還要處理結局之後的生活。'],
];

export const SAR_VARIANT_MODULES: SARModuleDefinition[] = VARIANT_SOURCE.map(([title, group, summary], index) =>
    makeModule('variant', index, title, group, summary, '現實層只讀取關係門牌；異格在異世界中的身份、執念與行動必須優先。'),
);

const STORY_SOURCE: Array<[string, string, string, string[]]> = [
    ['王城處刑夜', '戰爭異界', '處刑鍾已經敲響，你們分屬敵對陣營，其中一人的名字正寫在王城斷頭台上。', ['王城', '敵對', '處刑']],
    ['神殿叛逃令', '戰爭異界', '角色奉命追捕攜帶禁忌神諭逃亡的你，卻在抓到你的那一刻發現追殺令寫著自己的真名。', ['神殿', '追逐', '背叛']],
    ['龍災圍城', '戰爭異界', '最後一道城門即將失守，你們一個掌握馴龍契約，一個揹負必須殺死那條龍的命令。', ['龍災', '圍城', '衝突']],
    ['魔王停戰線', '戰爭異界', '決戰已經進行到雙方都無法回頭，你們被迫共享一枚會同時奪走兩人性命的停戰印。', ['魔王', '同盟', '決戰']],
    ['浮空學院墜落', '魔法異界', '浮空學院正在解體墜落，你們必須穿過已經叛變的學院塔，在撞地前奪回核心。', ['學院', '墜落', '魔法']],
    ['蒸汽帝國政變', '機械異界', '皇帝遇刺、全城封鎖，你們手裡各有半份能證明真正繼承人的機械遺詔。', ['蒸汽', '政變', '潛伏']],
    ['公會滅服前夜', '遊戲異界', '大型線上世界將在黎明永久關服，你們的公會卻發現所有 NPC 正在阻止玩家登出。', ['MMO', '公會', '關服']],
    ['廢土最後列車', '末日異界', '汙染潮追著最後一班列車逼近，而車上只剩一張能夠進入安全區的身份票。', ['廢土', '列車', '生存']],
    ['深海神國祭典', '神話異界', '沉沒王國的獻祭已經開始，你們必須在海水灌滿神殿前決定誰來冒充失蹤的神明。', ['深海', '祭典', '獻祭']],
    ['暴雪古堡繼承夜', '怪談異界', '所有繼承人都被困在會改變房間位置的古堡裡，午夜前必須找出已經死過一次的那個人。', ['古堡', '暴雪', '懸疑']],
    ['無限迴廊末門', '怪談異界', '你們已經死循環了九十九次，這一次終於走到從未出現過的最後一扇門。', ['循環', '迴廊', '末門']],
    ['封鎖星艦躍遷', '星海異界', '星艦即將躍遷進恆星，主控系統只允許一個擁有完整人格記錄的人取消航線。', ['星艦', '封鎖', '人格']],
    ['無謊王都審判', '規則異界', '在無法說謊的王都，你們正在接受叛國審判，而真正會定罪的是沒有說出口的部分。', ['審判', '真相', '規則']],
    ['真名禁林契約', '規則異界', '你們已經交換真名並被迫共享傷害，獵人此刻正沿著其中一人的血跡逼近。', ['真名', '契約', '追獵']],
    ['七日伴侶契', '規則異界', '締結七日的伴侶契約只剩最後一夜，到期時世界會收回你們共同擁有過的一切。', ['倒計時', '契約', '關係']],
    ['情緒魔法暴走', '規則異界', '無法說出口的情緒正在化為失控魔法，整座城市已經開始按照你們的關係改變形狀。', ['情緒', '魔法', '城市']],
    ['終戰日輪迴', '因果異界', '同一場世界末日已經重演多次，這一輪只有你們記得上一次是誰親手啟動了災難。', ['輪迴', '末日', '殘響']],
    ['未來訃告來信', '因果異界', '來自不同未來的訃告連續抵達，每一封都說你們中的另一人會在今夜死亡。', ['書信', '未來', '死亡預告']],
    ['千年重逢門', '因果異界', '你只離開了片刻，角色卻已經守過這道門一千年，而門將在重逢後立刻關閉。', ['時差', '重逢', '門']],
    ['被抹去的聖戰日', '因果異界', '歷史裡消失的那一天重新出現，你們身上的舊傷證明兩人曾在這裡做過相反的選擇。', ['失憶', '聖戰', '調查']],
    ['假婚潛入王宮', '任務異界', '假婚儀式已經進行到宣誓環節，暗殺目標突然當眾說出了你們真正的關係。', ['偽裝', '王宮', '關係']],
    ['護送末代神明', '任務異界', '世界最後一位神明必須在天亮前抵達隕落祭壇，而護送者收到的新命令是途中處決 TA。', ['護送', '神明', '背叛']],
    ['盜取世界核心', '任務異界', '你們已經進入核心密庫，卻發現要盜走的“物品”正用其中一人的聲音請求被留下。', ['潛入', '共犯', '世界核心']],
    ['唯一歸還名額', '終局異界', '世界崩塌只剩最後一道返航門，它已經確認你們之中只有一個能保留原來的記憶離開。', ['抉擇', '崩塌', '封閉結局']],
];

export const SAR_STORY_MODULES: SARModuleDefinition[] = STORY_SOURCE.map(([title, group, summary, routeTags], index) =>
    makeModule('story', index, title, group, summary, '現實層只保留雙方關係門牌；禁止調用具體聊天與事件記憶，禁止把異世界變成現實復盤。', routeTags),
);

export const SAR_ALL_MODULES = [...SAR_VARIANT_MODULES, ...SAR_STORY_MODULES];

export const getSARModules = (pool: SARModulePool) => pool === 'variant' ? SAR_VARIANT_MODULES : SAR_STORY_MODULES;

export const getSARModuleById = (id: string) => SAR_ALL_MODULES.find(module => module.id === id);

export const getSARLocalDayKey = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

export const readSARGachaState = (storage?: StorageLike): SARGachaState => {
    const raw = readSARCommerceValue(SAR_GACHA_STORAGE_KEY, storage || localStorage);
    try {
        if (!raw) return { ...DEFAULT_SAR_GACHA_STATE, freeDrawDate: {}, collection: {}, history: [] };
        const parsed = JSON.parse(raw) as Partial<SARGachaState>;
        const collection = parsed.collection && typeof parsed.collection === 'object'
            ? Object.fromEntries(Object.entries(parsed.collection).filter(([, count]) => Number.isFinite(count) && Number(count) > 0).map(([id, count]) => [id, Math.floor(Number(count))]))
            : {};
        return {
            version: 1,
            freeDrawDate: parsed.freeDrawDate && typeof parsed.freeDrawDate === 'object' ? parsed.freeDrawDate : {},
            collection,
            history: Array.isArray(parsed.history)
                ? parsed.history.filter(entry => entry && typeof entry.moduleId === 'string' && (entry.pool === 'variant' || entry.pool === 'story')).slice(0, 60)
                : [],
            duplicateStreak: Object.fromEntries((['variant', 'story'] as const).map(pool => {
                const count = parsed.duplicateStreak?.[pool];
                return [pool, typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? Math.min(2, count) : 0];
            })),
        };
    } catch {
        return { ...DEFAULT_SAR_GACHA_STATE, freeDrawDate: {}, collection: {}, history: [] };
    }
};

export const writeSARGachaState = (state: SARGachaState, storage?: StorageLike) => {
    (storage || localStorage).setItem(SAR_GACHA_STORAGE_KEY, JSON.stringify(state));
    return state;
};

export const isSARFreeDrawAvailable = (pool: SARModulePool, state: SARGachaState, date = new Date()) =>
    !state.freeDrawDate[pool] || state.freeDrawDate[pool]! < getSARLocalDayKey(date);

export type SARGachaDrawResult =
    | { ok: true; module: SARModuleDefinition; state: SARGachaState; firstCopy: boolean }
    | { ok: false; reason: 'daily-used'; state: SARGachaState };

export const drawSARModule = (
    pool: SARModulePool,
    storage?: StorageLike,
    date = new Date(),
    random: () => number = Math.random,
    bypassDailyLimit = false,
): SARGachaDrawResult => {
    const current = readSARGachaState(storage);
    if (!bypassDailyLimit && !isSARFreeDrawAvailable(pool, current, date)) return { ok: false, reason: 'daily-used', state: current };

    const modules = getSARModules(pool);
    const unowned = modules.filter(module => !(current.collection[module.id] > 0));
    const candidates = (current.duplicateStreak?.[pool] || 0) >= 2 && unowned.length ? unowned : modules;
    const roll = Math.min(Math.max(random(), 0), 0.999999999);
    const module = candidates[Math.floor(roll * candidates.length)];
    const previousCount = current.collection[module.id] || 0;
    const next: SARGachaState = {
        version: 1,
        freeDrawDate: bypassDailyLimit
            ? current.freeDrawDate
            : { ...current.freeDrawDate, [pool]: getSARLocalDayKey(date) },
        collection: { ...current.collection, [module.id]: previousCount + 1 },
        duplicateStreak: { ...current.duplicateStreak, [pool]: previousCount > 0 ? Math.min(2, (current.duplicateStreak?.[pool] || 0) + 1) : 0 },
        history: [{
            id: `draw_${date.getTime().toString(36)}_${module.id}`,
            moduleId: module.id,
            pool,
            drawnAt: date.getTime(),
        }, ...current.history].slice(0, 60),
    };
    writeSARGachaState(next, storage);
    return { ok: true, module, state: next, firstCopy: previousCount === 0 };
};
