import type { MallCategory, MallKind, MallProduct } from '../types';
import { MALL_CATEGORY_HINTS, createMallProduct } from './shoppingMall';

/**
 * 購物中心 ⟳ AI 補貨（2026-10 改版，提示詞照 Liora 給的參考改寫，見 plans/mall-redesign.md）。
 * 輸出是 `#推薦N` ＋ `[欄位]值` 的塊格式，不用 JSON：模型寫塊格式比較穩，掉了一兩個欄位也能救。
 */

export interface RestockCategoryInput {
    category: MallCategory;
    /** 這個分類已經有的商品名，叫 AI 別重複 */
    existingNames: string[];
}

const MAX_EXISTING_LISTED = 30;

export function buildMallRestockPrompt(kind: MallKind, inputs: RestockCategoryInput[]): string {
    const food = kind === 'food';
    const range = inputs.length > 4 ? '3 到 4' : '3 到 6';
    const catLines = inputs.map(({ category }) => {
        const hint = MALL_CATEGORY_HINTS[category.name];
        return `  - ${category.name}${hint ? `：${hint}` : ''}`;
    }).join('\n');
    const existing = inputs
        .filter(i => i.existingNames.length > 0)
        .map(i => `  - ${i.category.name}：${i.existingNames.slice(0, MAX_EXISTING_LISTED).join('、')}`)
        .join('\n');
    const first = inputs[0]?.category.name ?? '分類名';
    return [
        `你正在為一個獨立${food ? '外賣' : '購物'} App 生成首頁分類推薦${food ? '菜單' : '商品'}流。`,
        '',
        '要求：',
        `- 只生成可以瀏覽和${food ? '下單' : '購買'}的首頁推薦${food ? '餐點與商品' : '商品'}，不要生成最近瀏覽、收藏、購物車或訂單。`,
        '- 不要寫角色、人設、記憶、劇情或旁白。',
        `- 必須按以下 ${inputs.length} 個分類推薦，每個分類 ${range} 條：`,
        catLines,
        `- ${food ? '品項名稱、餐廳或品牌' : '商品名稱、店鋪或品牌'}、價格、說明和詳情都要具體，像真實可${food ? '外送' : '購買'}的${food ? '品項' : '商品'}；可以用真實存在的品牌。`,
        `- 價格是美元，照美國當地的日常行情${food ? '（外送價）' : ''}，只寫數字，例如 6.5。`,
        `- [詳情] 寫${food ? '份量、主要食材、口味、溫度或保存方式' : '商品本身的材質、規格、用途、質感、適用場景'}，不要寫推薦理由或系統解釋。`,
        '- [說明] 是列表上的一行短說明，15 字以內。',
        '- [圖標] 用單個直觀、美觀、和商品強相關的 emoji 或符號。',
        '- 全部用繁體中文（品牌名可以保留原文）。',
        ...(existing ? ['', '這些已經上架了，這次換一批新的，不要重複，也不要換個說法重寫同一樣東西：', existing] : []),
        '',
        '輸出格式：',
        '#推薦1',
        `[分類]${first}`,
        `[名稱]${food ? '品項' : '商品'}名稱`,
        `[店鋪]${food ? '餐廳或品牌' : '店鋪或品牌'}`,
        '[價格]價格',
        '[說明]列表短說明',
        '[詳情]詳情文本',
        '[圖標]圖標',
        '',
        '#推薦2',
        `[分類]${first}`,
        '…（同上）',
        '',
        '規則：',
        `- 每條都必須有 [分類]，且分類名只能使用上面 ${inputs.length} 個分類名。`,
        `- 每個分類連續輸出 ${range} 條，所有條目用連續編號，例如 #推薦1、#推薦2、#推薦3。`,
        '- 不要輸出 #最近瀏覽、#收藏、#購物車、#訂單；這些由用戶交互產生。',
        '- 示例欄位值都是佔位說明，實際輸出必須替換成真實內容。',
        '- 只輸出上述塊格式內容，不要輸出 Markdown、解釋、代碼塊或 JSON。',
    ].join('\n');
}

const FIELD_ALIASES: Record<string, 'category' | 'name' | 'shop' | 'price' | 'summary' | 'detail' | 'emoji'> = {
    分類: 'category', 分类: 'category',
    名稱: 'name', 名称: 'name',
    店鋪: 'shop', 店铺: 'shop', 品牌: 'shop', 餐廳: 'shop', 餐厅: 'shop',
    價格: 'price', 价格: 'price',
    說明: 'summary', 说明: 'summary',
    詳情: 'detail', 详情: 'detail',
    圖標: 'emoji', 图标: 'emoji',
};

/** `$1,299.00`、`12.5 美元`、`US$8` → 數字；解析不出來是 NaN。 */
export function parsePrice(raw: string): number {
    const m = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
}

/** 分類名常見的簡體字折成繁體再比（模型偶爾回簡體）。只收分類名裡會出現的字，不是通用轉換。 */
const SIMP = '点饮电脑鲜杂货医药绿装饰妆养护兴拟虚数码类卫书宠运动户厨寝鸡面饭鱼虾礼游戏乐机线课袜围随宝贝儿婴发肤车汤热凉冻烧卤酱';
const TRAD = '點飲電腦鮮雜貨醫藥綠裝飾妝養護興擬虛數碼類衛書寵運動戶廚寢雞麵飯魚蝦禮遊戲樂機線課襪圍隨寶貝兒嬰髮膚車湯熱涼凍燒滷醬';
const SIMP_TO_TRAD = new Map(Array.from(SIMP).map((c, i) => [c, Array.from(TRAD)[i]] as const));

const normalizeCat = (s: string) =>
    Array.from(s.replace(/[\s　]/g, '').toLowerCase()).map(c => SIMP_TO_TRAD.get(c) ?? c).join('');

/** 分類名對應：完全相同 → 去空白後相同 → 互相包含；都不中就是 null（那條丟掉）。 */
export function matchCategory(name: string, categories: MallCategory[]): MallCategory | null {
    const raw = name.trim();
    if (!raw) return null;
    const exact = categories.find(c => c.name === raw);
    if (exact) return exact;
    const n = normalizeCat(raw);
    const norm = categories.find(c => normalizeCat(c.name) === n);
    if (norm) return norm;
    return categories.find(c => {
        const cn = normalizeCat(c.name);
        return cn && (cn.includes(n) || n.includes(cn));
    }) ?? null;
}

/**
 * 解析 AI 回的塊格式。寬容：欄位名簡繁都收、包在代碼塊裡也行、沒有 `#推薦N` 分隔時
 * 遇到新的 [分類] 或 [名稱] 就當下一條開始。名稱或分類對不上、價格解析不出來的條目丟掉；
 * 跟已有商品（同 kind）或同一批裡同名的也丟掉。
 */
export function parseMallRestockBlocks(
    text: string,
    kind: MallKind,
    categories: MallCategory[],
    existing: MallProduct[] = [],
): MallProduct[] {
    const cats = categories.filter(c => c.kind === kind);
    const seen = new Set(existing.filter(p => p.kind === kind).map(p => p.name.trim()));
    const records: Record<string, string>[] = [];
    let cur: Record<string, string> = {};
    const flush = () => {
        if (Object.keys(cur).length > 0) records.push(cur);
        cur = {};
    };
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const t = line.trim();
        if (/^#\s*[推荐薦]/.test(t)) { flush(); continue; }
        const m = t.match(/^[\[【]\s*([^\]】]+?)\s*[\]】]\s*[:：]?\s*(.*)$/);
        if (!m) continue;
        const key = FIELD_ALIASES[m[1]];
        if (!key) continue;
        if ((key === 'category' && cur.category) || (key === 'name' && cur.name)) flush();
        cur[key] = m[2].trim();
    }
    flush();

    const out: MallProduct[] = [];
    for (const r of records) {
        const name = (r.name || '').trim();
        if (!name || seen.has(name)) continue;
        const cat = matchCategory(r.category || '', cats);
        if (!cat) continue;
        const price = parsePrice(r.price || '');
        if (!Number.isFinite(price) || price <= 0) continue;
        seen.add(name);
        out.push(createMallProduct(kind, cat.id, {
            name,
            price,
            shop: r.shop,
            summary: r.summary,
            detail: r.detail,
            emoji: r.emoji ? Array.from(r.emoji.trim()).slice(0, 4).join('') : undefined,
        }));
    }
    return out;
}
