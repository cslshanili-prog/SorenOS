import type { MallCategory, MallKind, MallProduct } from '../types';

let idSeq = 0;
export const makeMallId = (prefix: string): string => `${prefix}-${Date.now()}-${(idSeq++).toString(36)}`;

/**
 * 預設分類（2026-10 改版，見 plans/mall-redesign.md）。用戶可以在分類列的 ＋ →「管理分類」
 * 隨時改名、排序、刪除——這些只是第一次打開時的起點。
 */
export const DEFAULT_MALL_CATEGORIES: Record<MallKind, string[]> = {
    food: ['生鮮雜貨', '美食', '冷熱飲', '咖啡', '酒水', '甜點', '醫藥健康', '鮮花綠植'],
    shop: ['服裝配飾', '居家生活', '美妝保養', '文具興趣', '虛擬商品', '電腦電器'],
};

/** 預設分類的範圍說明，AI 補貨的提示詞照這個寫；用戶自己加的分類沒有說明，只給名字。 */
export const MALL_CATEGORY_HINTS: Record<string, string> = {
    生鮮雜貨: '蔬果、肉蛋奶、零食泡麵、日常雜貨',
    美食: '正餐、便當、麵食、速食、沙拉',
    冷熱飲: '手搖飲、果汁、茶飲、熱可可（咖啡另有分類）',
    咖啡: '拿鐵、美式、冷萃、手沖、咖啡廳飲品',
    酒水: '啤酒、葡萄酒、清酒、調酒、氣泡酒',
    甜點: '蛋糕、餅乾、冰淇淋、麵包、甜品',
    醫藥健康: '常備藥、維他命、保健品、喉糖、護理用品',
    鮮花綠植: '花束、盆栽、多肉、乾燥花',
    服裝配飾: '服飾、包袋、鞋履和日常搭配',
    居家生活: '收納、香氛、寢具、餐廚與居家質感',
    美妝保養: '護膚、彩妝、身體護理和儀容工具',
    文具興趣: '紙品、手作、閱讀、運動和旅行小物',
    虛擬商品: '咖啡禮券、健身月卡、會員、禮品卡、線上課、遊戲點數',
    電腦電器: '小設備、桌面裝備、耳機、智能配件',
};

interface SeedProduct { category: string; name: string; shop: string; price: number; emoji: string; summary: string; detail: string }

/** 預設商品：每個分類 3 件，美金，價位照美國日常行情。之後讓用戶自己加減或 ⟳ 補貨。 */
const SEED_PRODUCTS: Record<MallKind, SeedProduct[]> = {
    food: [
        { category: '生鮮雜貨', name: '有機草莓 1 磅', shop: 'Whole Foods Market', price: 5.99, emoji: '🍓', summary: '當季加州草莓', detail: '加州產有機草莓，一盒約 450g，冷藏可放三天，洗過直接吃或配優格都好。' },
        { category: '生鮮雜貨', name: '放牧雞蛋 12 入', shop: "Trader Joe's", price: 6.49, emoji: '🥚', summary: '大顆褐殼蛋', detail: '放牧母雞產的大顆褐殼蛋，一盒 12 顆，蛋黃顏色深，煎、煮、做甜點都適合。' },
        { category: '生鮮雜貨', name: '辛拉麵 5 入', shop: 'H Mart', price: 5.49, emoji: '🍜', summary: '韓國經典辣味泡麵', detail: '農心辛拉麵一袋五包，牛骨辣湯底配Q彈粗麵，加顆蛋和起司片就是一餐。' },
        { category: '美食', name: '雙層起司漢堡套餐', shop: 'Shake Shack', price: 13.99, emoji: '🍔', summary: '雙層牛肉＋薯條', detail: '兩片安格斯牛肉餅、美式起司和招牌醬，附一份波浪薯條。' },
        { category: '美食', name: '雞肉凱薩沙拉碗', shop: 'Sweetgreen', price: 15.45, emoji: '🥗', summary: '烤雞、羅馬生菜、帕瑪森', detail: '烤雞腿肉、羅馬生菜、羽衣甘藍、帕瑪森起司和麵包丁，凱薩醬另附。' },
        { category: '美食', name: '豚骨拉麵', shop: 'Ippudo', price: 18.5, emoji: '🍜', summary: '濃厚豚骨湯頭', detail: '熬煮十幾小時的白湯豚骨湯底，細直麵、叉燒、木耳和蔥，可選麵的硬度。' },
        { category: '冷熱飲', name: '黑糖珍珠奶茶 大杯', shop: 'Boba Guys', price: 6.5, emoji: '🧋', summary: '現煮珍珠、鮮奶', detail: '黑糖現煮珍珠配紅茶和全脂鮮奶，大杯 24oz，可調甜度和冰塊。' },
        { category: '冷熱飲', name: '鮮榨柳橙汁', shop: 'Pressed', price: 7.95, emoji: '🍊', summary: '冷壓，不加糖', detail: '冷壓鮮榨柳橙汁 12oz，不加糖、不加水，冷藏飲用最好。' },
        { category: '冷熱飲', name: '蜂蜜柑橘薄荷茶', shop: 'Starbucks', price: 4.45, emoji: '🍵', summary: '熱飲，喉嚨不舒服時喝', detail: '薄荷綠茶和桃子香草茶加蒸檸檬水與蜂蜜，熱飲 16oz。' },
        { category: '咖啡', name: '燕麥拿鐵', shop: 'Blue Bottle Coffee', price: 6.5, emoji: '☕', summary: '雙份濃縮＋燕麥奶', detail: '雙份濃縮配 Oatly 燕麥奶，12oz，可做熱或冰。' },
        { category: '咖啡', name: '冷萃咖啡', shop: 'Starbucks', price: 5.25, emoji: '🧊', summary: '慢萃 20 小時', detail: '冷水慢萃 20 小時，口感順、酸度低，大杯 16oz 加冰。' },
        { category: '咖啡', name: '澳白 Flat White', shop: 'Bluestone Lane', price: 5.75, emoji: '☕', summary: '澳式咖啡館招牌', detail: '雙份濃縮配薄薄一層綿密奶泡，8oz，奶味比拿鐵輕、咖啡味更明顯。' },
        { category: '酒水', name: '精釀 IPA 六入', shop: 'Lagunitas', price: 12.99, emoji: '🍺', summary: '柑橘調啤酒花', detail: '加州精釀印度淡色艾爾，12oz 瓶裝六入，酒精 6.2%，帶柑橘和松木香。' },
        { category: '酒水', name: '紐西蘭白蘇維濃', shop: 'Kim Crawford', price: 15.99, emoji: '🥂', summary: '清爽果香白酒', detail: '馬爾堡產區白蘇維濃 750ml，百香果和青草香，冰鎮後配海鮮或沙拉。' },
        { category: '酒水', name: '獺祭 45 純米大吟釀', shop: 'Dassai', price: 16.99, emoji: '🍶', summary: '300ml 小瓶', detail: '山田錦精米 45%，300ml，果香乾淨、入口柔順，冰著喝最好。' },
        { category: '甜點', name: '紐約起司蛋糕 切片', shop: "Junior's", price: 7.5, emoji: '🍰', summary: '經典原味，濃郁綿密', detail: '奶油乳酪和海綿蛋糕底的經典紐約起司蛋糕，一大片，冷藏保存。' },
        { category: '甜點', name: '巧克力核桃大餅乾', shop: 'Levain Bakery', price: 5.75, emoji: '🍪', summary: '外脆內軟的厚餅乾', detail: '一片約 170g 的厚餅乾，半甜巧克力豆和核桃，微波 10 秒更好吃。' },
        { category: '甜點', name: '抹茶冰淇淋 一品脫', shop: 'Häagen-Dazs', price: 6.49, emoji: '🍨', summary: '日本抹茶，微苦回甘', detail: '473ml 一品脫裝，日本抹茶粉和鮮奶油，冷凍保存。' },
        { category: '醫藥健康', name: '布洛芬止痛錠 100 粒', shop: 'Advil', price: 12.99, emoji: '💊', summary: '頭痛、經痛、退燒', detail: '每粒 200mg 布洛芬膜衣錠，100 粒裝，緩解頭痛、經痛、肌肉痠痛和發燒。' },
        { category: '醫藥健康', name: '綜合維他命軟糖', shop: 'OLLY', price: 13.99, emoji: '🍬', summary: '一天兩顆，莓果口味', detail: '成人綜合維他命軟糖 90 顆，含維生素 A、C、D、E 和 B 群，莓果口味。' },
        { category: '醫藥健康', name: '草本喉糖', shop: 'Ricola', price: 3.49, emoji: '🌿', summary: '瑞士香草配方', detail: '十三種瑞士香草配方的潤喉糖，一袋 24 顆，喉嚨乾癢時含一顆。' },
        { category: '鮮花綠植', name: '粉玫瑰一打', shop: '1-800-Flowers', price: 49.99, emoji: '🌹', summary: '12 枝，附花瓶', detail: '十二枝粉色長莖玫瑰，搭配尤加利葉，附透明玻璃花瓶和小卡片。' },
        { category: '鮮花綠植', name: '向日葵花束', shop: 'The Bouqs Co.', price: 39.99, emoji: '🌻', summary: '明亮的一小束', detail: '六到八枝向日葵配綠葉，牛皮紙包裝，換水剪根可以放一週。' },
        { category: '鮮花綠植', name: '小盆多肉', shop: 'The Sill', price: 14.99, emoji: '🪴', summary: '好養，放桌上', detail: '4 吋陶盆多肉植物，耐旱，每兩週澆一次水，放在有光的窗邊。' },
    ],
    shop: [
        { category: '服裝配飾', name: '美麗諾羊毛圓領毛衣', shop: 'UNIQLO', price: 39.9, emoji: '🧶', summary: '細針織，可機洗', detail: '超細美麗諾羊毛圓領針織衫，薄而保暖、不刺癢，可單穿或疊穿，可機洗。' },
        { category: '服裝配飾', name: '帆布托特包', shop: 'L.L.Bean', price: 44.95, emoji: '👜', summary: '耐用經典款', detail: '24oz 厚帆布手工縫製托特包，中號，可放筆電和水壺，邊條顏色可選。' },
        { category: '服裝配飾', name: '經典高筒帆布鞋', shop: 'Converse', price: 65, emoji: '👟', summary: 'Chuck Taylor 白色', detail: 'Chuck Taylor All Star 高筒帆布鞋，白色，橡膠鞋底，百搭日常。' },
        { category: '居家生活', name: '無花果香氛蠟燭', shop: 'Diptyque', price: 78, emoji: '🕯️', summary: '190g，綠葉與無花果', detail: 'Figuier 無花果香氛蠟燭 190g，燃燒約 50 小時，帶綠葉和木質調。' },
        { category: '居家生活', name: '亞麻枕套 2 入', shop: 'Parachute', price: 69, emoji: '🛏️', summary: '歐洲亞麻，越洗越軟', detail: '100% 歐洲亞麻枕套兩入，標準尺寸，透氣吸濕，洗過之後更柔軟。' },
        { category: '居家生活', name: '不鏽鋼保溫杯 40oz', shop: 'Stanley', price: 45, emoji: '🥤', summary: '附吸管與握把', detail: 'Quencher 雙層真空不鏽鋼保溫杯，40oz，保冰約 11 小時，附吸管和握把。' },
        { category: '美妝保養', name: '睡眠唇膜', shop: 'Laneige', price: 24, emoji: '💋', summary: '莓果香，睡前一抹', detail: '20g 莓果味睡眠唇膜，含維生素 C 和保濕成分，睡前厚敷，隔天唇部柔軟。' },
        { category: '美妝保養', name: '隱形防曬乳 SPF40', shop: 'Supergoop!', price: 38, emoji: '☀️', summary: '透明無色，可當妝前', detail: 'Unseen Sunscreen 50ml，透明凝膠質地，不泛白，可以當妝前乳。' },
        { category: '美妝保養', name: '乳油木護手霜', shop: "L'Occitane", price: 12, emoji: '🧴', summary: '30ml 隨身款', detail: '含 20% 乳油木果油的護手霜，30ml，吸收快不黏手，放包包裡剛好。' },
        { category: '文具興趣', name: '點陣筆記本 A5', shop: 'Leuchtturm1917', price: 24.95, emoji: '📓', summary: '硬殼，249 頁', detail: 'A5 硬殼點陣筆記本，249 頁編號頁面，附目錄頁、雙書籤帶和後口袋。' },
        { category: '文具興趣', name: 'Safari 鋼筆', shop: 'LAMY', price: 34.99, emoji: '🖋️', summary: 'F 尖，附卡式墨水', detail: '德國 LAMY Safari 鋼筆，F 尖，ABS 筆身和三角握位，附一支藍色卡式墨水。' },
        { category: '文具興趣', name: '1000 片拼圖', shop: 'Ravensburger', price: 21.99, emoji: '🧩', summary: '風景插畫，週末消磨', detail: '德國製 1000 片拼圖，完成尺寸 70×50cm，卡紙厚實、片片形狀不同。' },
        { category: '虛擬商品', name: '星巴克電子禮品卡 $25', shop: 'Starbucks', price: 25, emoji: '🎫', summary: '傳過去就能用', detail: '面額 $25 的電子禮品卡，可在美國門市和 App 使用，沒有使用期限。' },
        { category: '虛擬商品', name: 'Netflix 標準方案一個月', shop: 'Netflix', price: 17.99, emoji: '🎬', summary: '1080p，兩台裝置', detail: '標準方案一個月，1080p 畫質，可同時在兩台裝置觀看、下載離線看。' },
        { category: '虛擬商品', name: 'eShop 點數卡 $35', shop: 'Nintendo', price: 35, emoji: '🎮', summary: 'Switch 遊戲點數', detail: '美國 Nintendo eShop 數位點數 $35，可買 Switch 遊戲、DLC 和線上會員。' },
        { category: '電腦電器', name: 'AirPods Pro 2', shop: 'Apple', price: 249, emoji: '🎧', summary: '主動降噪無線耳機', detail: '主動降噪、通透模式和自適應音訊，USB-C 充電盒，單次聆聽約 6 小時。' },
        { category: '電腦電器', name: 'K2 無線機械鍵盤', shop: 'Keychron', price: 99, emoji: '⌨️', summary: '75% 配列，藍牙三台切換', detail: '75% 配列無線機械鍵盤，茶軸，藍牙可在三台裝置間切換，支援 Mac 和 Windows。' },
        { category: '電腦電器', name: '磁吸行動電源 10000mAh', shop: 'Anker', price: 39.99, emoji: '🔋', summary: '吸在手機背後充', detail: '10000mAh 磁吸無線行動電源，附折疊支架，也能用 USB-C 有線快充。' },
    ],
};

/**
 * 改版前（2026-10 之前）種過的預設分類與商品，只拿來搬遷：名稱和分類都對得上的才刪，
 * 用戶自己加的、AI 補的一律不碰。
 */
const LEGACY_DEFAULT_CATEGORIES: Record<MallKind, string[]> = {
    shop: ['可愛小物', '零食飲料', '生活用品', '禮物'],
    food: ['正餐', '甜品飲料', '小吃', '飲品'],
};
const LEGACY_SEED_PRODUCTS: Record<MallKind, { category: string; name: string }[]> = {
    shop: [
        { category: '可愛小物', name: '毛絨手機掛件' },
        { category: '零食飲料', name: '聊天能量補給盒' },
        { category: '生活用品', name: '記憶手帳本' },
        { category: '禮物', name: '迷你花束' },
        { category: '生活用品', name: '雲朵眼罩' },
        { category: '禮物', name: '咖啡兌換券' },
    ],
    food: [
        { category: '正餐', name: '簡餐套餐' },
        { category: '甜品飲料', name: '草莓小蛋糕' },
        { category: '小吃', name: '炸雞拼盤' },
        { category: '飲品', name: '冰美式' },
    ],
};

/** 按 kind 生成一套預設分類（帶 order）。 */
export function buildDefaultCategories(kind: MallKind, startOrder = 0): MallCategory[] {
    return DEFAULT_MALL_CATEGORIES[kind].map((name, index) => ({
        id: makeMallId('mallcat'),
        kind,
        name,
        order: startOrder + index,
    }));
}

/** 按 kind ＋ 分類（按名字對）鋪預設商品；分類對不上的跳過。 */
export function buildSeedProducts(kind: MallKind, categories: MallCategory[]): MallProduct[] {
    const byName = new Map(categories.filter(c => c.kind === kind).map(c => [c.name, c] as const));
    const now = Date.now();
    const out: MallProduct[] = [];
    for (const seed of SEED_PRODUCTS[kind]) {
        const cat = byName.get(seed.category);
        if (!cat) continue;
        out.push({
            id: makeMallId('mallprod'), kind, categoryId: cat.id,
            name: seed.name, shop: seed.shop, price: seed.price, emoji: seed.emoji,
            summary: seed.summary, detail: seed.detail, createdAt: now,
        });
    }
    return out;
}

/** localStorage 記搬遷做到第幾版；做過就不再自動補預設（用戶刪掉的分類不會又冒出來）。 */
export const MALL_CATALOG_VERSION_KEY = 'mall_catalog_version';
export const MALL_CATALOG_VERSION = 2;

export interface MallCatalogUpgradePlan {
    deleteProductIds: string[];
    deleteCategoryIds: string[];
    addCategories: MallCategory[];
    addProducts: MallProduct[];
}

/**
 * 改版搬遷（純函數）：
 * 1. 刪名稱、分類都跟舊種子一模一樣的商品；
 * 2. 舊預設分類刪到空了才拿掉（裡面還有用戶自己的東西就留著）；
 * 3. 新預設分類按名字補缺的，新預設商品在同 kind 裡沒有同名的才補。
 * 全新用戶（什麼都沒有）就是直接種一套新的。
 */
export function planMallCatalogUpgrade(categories: MallCategory[], products: MallProduct[]): MallCatalogUpgradePlan {
    const plan: MallCatalogUpgradePlan = { deleteProductIds: [], deleteCategoryIds: [], addCategories: [], addProducts: [] };
    for (const kind of ['food', 'shop'] as MallKind[]) {
        const cats = categories.filter(c => c.kind === kind);
        const catName = new Map(cats.map(c => [c.id, c.name] as const));
        const legacy = new Set(LEGACY_SEED_PRODUCTS[kind].map(s => `${s.category}\u0000${s.name}`));
        const deleted = new Set<string>();
        for (const p of products) {
            if (p.kind !== kind) continue;
            if (legacy.has(`${catName.get(p.categoryId) ?? ''}\u0000${p.name}`)) {
                plan.deleteProductIds.push(p.id);
                deleted.add(p.id);
            }
        }
        const remaining = products.filter(p => p.kind === kind && !deleted.has(p.id));
        const legacyCats = new Set(LEGACY_DEFAULT_CATEGORIES[kind]);
        const deletedCats = new Set<string>();
        for (const c of cats) {
            if (legacyCats.has(c.name) && !remaining.some(p => p.categoryId === c.id)) {
                plan.deleteCategoryIds.push(c.id);
                deletedCats.add(c.id);
            }
        }
        const keptCats = cats.filter(c => !deletedCats.has(c.id));
        const keptNames = new Set(keptCats.map(c => c.name));
        let order = keptCats.reduce((m, c) => Math.max(m, c.order + 1), 0);
        const newCats: MallCategory[] = [];
        for (const name of DEFAULT_MALL_CATEGORIES[kind]) {
            if (keptNames.has(name)) continue;
            newCats.push({ id: makeMallId('mallcat'), kind, name, order: order++ });
        }
        plan.addCategories.push(...newCats);
        const existingNames = new Set(remaining.map(p => p.name));
        plan.addProducts.push(...buildSeedProducts(kind, [...keptCats, ...newCats]).filter(p => !existingNames.has(p.name)));
    }
    return plan;
}

export function createMallCategory(kind: MallKind, name: string, order: number): MallCategory {
    return { id: makeMallId('mallcat'), kind, name: name.trim() || '未命名分類', order };
}

export interface MallProductInput {
    name: string;
    price: number;
    emoji?: string;
    detail?: string;
    shop?: string;
    summary?: string;
}

const optText = (v: unknown): string | undefined => {
    const t = typeof v === 'string' ? v.trim() : '';
    return t || undefined;
};

export function createMallProduct(kind: MallKind, categoryId: string, input: MallProductInput): MallProduct {
    return {
        id: makeMallId('mallprod'),
        kind,
        categoryId,
        name: input.name.trim() || '未命名商品',
        price: Number.isFinite(input.price) && input.price >= 0 ? Math.round(input.price * 100) / 100 : 0,
        emoji: input.emoji?.trim() || '🛍️',
        detail: optText(input.detail),
        shop: optText(input.shop),
        summary: optText(input.summary),
        createdAt: Date.now(),
    };
}

/** 列表上那行短說明：沒有 summary 就退回 detail。 */
export const productBlurb = (p: Pick<MallProduct, 'summary' | 'detail'>): string => p.summary || p.detail || '';

/** 搜尋：名稱、店鋪、說明、詳情都算，不分大小寫，空白分開的每個詞都要中。 */
export function searchMallProducts(products: MallProduct[], query: string): MallProduct[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return products;
    return products.filter(p => {
        const hay = [p.name, p.shop, p.summary, p.detail].filter(Boolean).join(' ').toLowerCase();
        return terms.every(t => hay.includes(t));
    });
}

const hash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
};

/** 本地日期 key（YYYY-MM-DD），推薦按這個輪換。 */
export const localDateKey = (d: Date = new Date()): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 今日推薦：同一天、同一批商品，結果固定；換一天就換一批。分類輪流挑，盡量不擠在同一類。
 * 第二批會把同一份推薦給角色看（見 plans/mall-redesign.md），所以必須是確定性的。
 */
export function pickDailyRecommendations(products: MallProduct[], dateKey: string, limit = 8): MallProduct[] {
    const byCat = new Map<string, MallProduct[]>();
    for (const p of products) {
        const list = byCat.get(p.categoryId) ?? [];
        list.push(p);
        byCat.set(p.categoryId, list);
    }
    const queues = [...byCat.entries()]
        .map(([catId, list]) => ({
            key: hash(`${dateKey}|cat|${catId}`),
            items: [...list].sort((a, b) => hash(`${dateKey}|${a.id}`) - hash(`${dateKey}|${b.id}`)),
        }))
        .sort((a, b) => a.key - b.key);
    const out: MallProduct[] = [];
    while (out.length < limit && queues.some(q => q.items.length > 0)) {
        for (const q of queues) {
            const next = q.items.shift();
            if (next) out.push(next);
            if (out.length >= limit) break;
        }
    }
    return out;
}

/** 「推薦」一批幾件；角色看到的是同一批的前幾件。 */
export const MALL_PICKS_SIZE = 10;
const PICKS_ROUND_KEY = 'mall_picks_round';
const MAX_PICKS_ROUND = 50;

/**
 * 推薦頁 ↻「換一批」按了幾次（2026-10-05）：只算今天、購物和外賣分開數，換一天自動歸零。
 * 存這台裝置的 localStorage，聊天組提示詞時也讀它，角色看到的跟你看到的還是同一批。
 */
export function getMallPicksRound(kind: MallKind, dateKey: string = localDateKey()): number {
    try {
        const raw = JSON.parse(localStorage.getItem(PICKS_ROUND_KEY) || 'null');
        if (!raw || raw.date !== dateKey) return 0;
        const n = Number(raw[kind]);
        return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_PICKS_ROUND) : 0;
    } catch {
        return 0;
    }
}

export function bumpMallPicksRound(kind: MallKind, dateKey: string = localDateKey()): number {
    const next = Math.min(getMallPicksRound(kind, dateKey) + 1, MAX_PICKS_ROUND);
    try {
        const raw = JSON.parse(localStorage.getItem(PICKS_ROUND_KEY) || 'null');
        const base = raw && raw.date === dateKey ? raw : { date: dateKey };
        localStorage.setItem(PICKS_ROUND_KEY, JSON.stringify({ ...base, [kind]: next }));
    } catch { /* 無痕模式：這次照樣換，只是記不住 */ }
    return next;
}

/**
 * 今天第 round 批推薦（round 0 就是 pickDailyRecommendations 那一批）。每換一批都先從上一批沒出現過的
 * 商品裡挑，不夠才回頭補，所以按 ↻ 盡量是一整批新的。整條鏈一律按 MALL_PICKS_SIZE 算再截，
 * 角色那邊取前 6 件也是你畫面上那一批的前 6 件。
 */
export function pickMallRecommendations(products: MallProduct[], dateKey: string, round = 0, limit = MALL_PICKS_SIZE): MallProduct[] {
    let batch = pickDailyRecommendations(products, dateKey, MALL_PICKS_SIZE);
    for (let r = 1; r <= Math.min(round, MAX_PICKS_ROUND); r++) {
        const key = `${dateKey}#${r}`;
        const shown = new Set(batch.map(p => p.id));
        const fresh = pickDailyRecommendations(products.filter(p => !shown.has(p.id)), key, MALL_PICKS_SIZE);
        batch = fresh.length >= MALL_PICKS_SIZE
            ? fresh
            : [...fresh, ...pickDailyRecommendations(products.filter(p => shown.has(p.id)), key, MALL_PICKS_SIZE - fresh.length)];
    }
    return batch.slice(0, limit);
}

/** 釘了很多件時，輪換的那一段至少還留幾件（不然「換一批」就沒東西可換）。 */
export const MALL_MIN_ROTATING = 4;

/**
 * 「推薦」頁要顯示的：📌 釘選的（用戶自己放進來的，照加入順序、不輪換）＋ 今天輪換的那一批。
 * 釘了幾件，輪換那段就少幾件，但至少留 MALL_MIN_ROTATING 件。輪換只從沒釘的商品裡挑。
 */
export function buildMallPicks(
    products: MallProduct[],
    dateKey: string,
    round = 0,
    total = MALL_PICKS_SIZE,
): { pinned: MallProduct[]; rotating: MallProduct[] } {
    const pinned = products.filter(p => p.pinned).sort((a, b) => a.createdAt - b.createdAt);
    const rest = products.filter(p => !p.pinned);
    const rotating = pickMallRecommendations(rest, dateKey, round, Math.max(MALL_MIN_ROTATING, total - pinned.length));
    return { pinned, rotating };
}

// ─── 購物車（購物、外賣各一車，狀態是頁面上的臨時 state，不落庫）───

export interface MallCartLine {
    productId: string;
    qty: number;
}

/** 購物車行 + 商品詳情拼在一起，UI 直接渲染用；商品被刪掉後這行自動被過濾掉。 */
export function resolveCartLines(cart: MallCartLine[], products: MallProduct[]): (MallCartLine & { product: MallProduct })[] {
    const byId = new Map(products.map(p => [p.id, p] as const));
    return cart
        .map(line => {
            const product = byId.get(line.productId);
            return product ? { ...line, product } : null;
        })
        .filter((l): l is MallCartLine & { product: MallProduct } => l !== null);
}

export function cartTotal(cart: MallCartLine[], products: MallProduct[]): number {
    const sum = resolveCartLines(cart, products).reduce((s, l) => s + l.product.price * l.qty, 0);
    return Math.round(sum * 100) / 100;
}

export function cartCount(cart: MallCartLine[]): number {
    return cart.reduce((s, l) => s + l.qty, 0);
}

export function addToCart(cart: MallCartLine[], productId: string, qty = 1): MallCartLine[] {
    const existing = cart.find(l => l.productId === productId);
    if (existing) return cart.map(l => l.productId === productId ? { ...l, qty: l.qty + qty } : l);
    return [...cart, { productId, qty }];
}

export function removeFromCart(cart: MallCartLine[], productId: string): MallCartLine[] {
    return cart
        .map(l => l.productId === productId ? { ...l, qty: l.qty - 1 } : l)
        .filter(l => l.qty > 0);
}

export function clearCartLine(cart: MallCartLine[], productId: string): MallCartLine[] {
    return cart.filter(l => l.productId !== productId);
}
