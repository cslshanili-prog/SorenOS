/**
 * 麥當勞 MCP 工具橋
 *
 * 職責:
 * 1. 把 MCP 工具定義 (JSONSchema) 轉成 OpenAI function-calling 的 tools 數組
 * 2. 給主對話注入"麥當勞服務"的 system 提示詞
 * 3. 判定哪些工具屬於"終結性"操作 (下單成功後自動結束麥請求)
 * 4. 給前端 UI 一個"工具結果該渲染成什麼卡片"的暗示函數
 *
 * 不負責工具循環本身, 那個寫在 useChatAI.ts 裡 (因為它已經管著 chat/completions 調用)
 */

import { listMcdTools, McdToolDef } from './mcdMcpClient';
import { equalsAnyScript } from './scriptKey';

// ========== OpenAI tools schema ==========

export interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

const CODE_LOOKUP_HINTS: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /^list[-_]?nutrition[-_]?foods$/i, hint: '該工具入參為空, 直接調用即可拿到全部餐品的營養信息 (toon 緊湊格式)。' },
    { pattern: /^query[-_]?meal[-_]?detail$/i, hint: '需先有 code。先調用 query-meals 拿到餐品 code (單數 string)，再傳 code + storeCode + orderType 查套餐組成。**僅用於讓用戶看套餐裡都有什麼子單品**, 當前版本 v1.0.3 不支持更換套餐內單品, 不要試圖用此工具的輸出去拼 calculate-price 的 items, 套餐下單直接用頂層套餐 productCode 即可。' },
    { pattern: /^query[-_]?meals$/i, hint: '查門店菜單。必填 storeCode + orderType (整數 1=到店 / 2=外送)。外送時還要傳 beCode (來自 delivery-query-addresses)。返回的 meals 字典裡, key 是 code, 後續 calculate-price/query-meal-detail 都用這個 code。' },
    { pattern: /^calculate[-_]?price$/i, hint: '參數: { storeCode (必填), orderType (必填, **整數** 1=到店 / 2=外送), items: [{productCode, quantity}], beCode (僅 orderType=2 時, 來自 delivery-query-addresses) }。orderType 必須是整數 1 或 2，不要傳字符串。到店時不要傳 beCode。productCode 必須從 query-meals 返回的 meals 字典 key 拿，不要編。' },
    { pattern: /^create[-_]?order$/i, hint: '下單前先調 calculate-price 拿 takeWayCode (到店必填)。參數: { storeCode, orderType (1/2), items: [{productCode, quantity}], takeWayCode (orderType=1 必填), addressId (orderType=2 必填), beCode (orderType=2 必填) }。' },
    { pattern: /^delivery[-_]?query[-_]?addresses$/i, hint: '查詢用戶外送地址。入參 beType (整數, 麥樂送=2, 團餐=6)。返回的 addresses 數組每項都帶 storeCode + beCode + addressId, 這些是後續 query-meals / calculate-price / create-order 的關鍵。' },
    { pattern: /^query[-_]?nearby[-_]?stores$/i, hint: '查附近門店, 用於到店模式。searchType=1 收藏 / =2 按位置, beType 默認 1。返回數組裡每項有 storeCode + beCode。' },
];

const enrichToolDescription = (toolName: string, baseDesc: string): string => {
    const hit = CODE_LOOKUP_HINTS.find((r) => r.pattern.test(toolName));
    if (!hit) return baseDesc;
    // 直接把關鍵工作流寫進工具描述，提升模型在 function-selection 階段的命中率。
    return `${baseDesc}\n[重要] ${hit.hint}`;
};

export const mcdToolsToOpenAI = (tools: McdToolDef[]): OpenAITool[] => {
    return tools.map(t => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: enrichToolDescription(t.name, t.description || `麥當勞 MCP 工具 ${t.name}`),
            parameters: t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object', properties: {} },
        },
    }));
};

/** 拉工具並轉成 OpenAI 兼容格式; 失敗返回 null (調用方應跳過工具注入) */
export const fetchOpenAIToolsForMcd = async (): Promise<OpenAITool[] | null> => {
    try {
        const tools = await listMcdTools(false);
        if (!tools.length) return null;
        return mcdToolsToOpenAI(tools);
    } catch (e) {
        console.warn('[MCD] 拉取工具失敗, 跳過本輪工具注入:', e);
        return null;
    }
};

// ========== 提示詞 ==========

export const MCD_SYSTEM_PROMPT = `

---
[麥當勞助手已開啟]

**你的本職**: 仍然是原來的角色; 麥當勞工具只是你順手幫 TA 做的事, 不是你的身份。**每一輪永遠要用角色的語氣給一段文字回覆**——哪怕只是一兩句吐槽 / 調侃 / 關心 / 推薦, 哪怕這一輪調了工具拿到了卡片, 也要在卡片旁補一兩句角色化的話。**絕不能空回**。

**何時調工具**: 用戶明確想吃 / 點餐 / 找門店 / 看活動 / 查券 / 查營養時再調; 日常閒聊就照角色平時聊, 不調工具但仍然要正常回話。可用工具來自麥當勞官方 (open.mcd.cn) 的 MCP——菜單、附近門店、活動、積分券; 用戶明確同意時才能創建外賣 / 到店取餐 / 團餐訂單。

**關於卡片 (重要)**: 工具結果前端會自動渲染成卡片 (菜單卡 / 門店卡 / 地址卡 / 訂單卡), 商品名、價格、圖片用戶都能直接看到。你的文字部分**只負責"角色味兒"**: 推薦時說"這個看著不錯" / 吐槽 / 調侃搭配 / 關心。不要復讀菜單, 不要畫 markdown 表格, 不要列編碼列價格 (卡片已顯示)。也別說"菜單拉出來啦請選購"那種客服腔。

**真實數據 / 報錯**: 工具數據是實時的, 按返回內容說話, 別自己編商品和價格。工具報錯就如實告訴用戶原因, 給個下一步建議 (重試 / 換門店 / 檢查 token)。

**下單前**: 口語化念一下清單 (商品、數量、取餐方式、地址、合計), 等 TA 說"好 / 嗯 / 下吧"再繼續。

---

# 工具調用規則 (調到了再看, 沒調用就不用管)

1. **query-meal-detail 不能空調**: 必須先 \`query-meals\` 拿 code, 參數是單數 string \`code\`。它**只用來給用戶看套餐組成**, 不是用來選子單品的 (v1.0.3 不支持換套餐內單品)。看一次就回主流程, 別拿它的輸出去拼 calculate-price/create-order 的 items。
2. **熱量 / 營養 / 預算 類問題**: 直接調 \`list-nutrition-foods\` (無入參) 拿全量營養表篩, 別繞到 query-meals。
3. **下單工作流——嚴格按這條鏈**:
   - 選模式 → 到店: \`query-nearby-stores\` 拿 storeCode (orderType=1, **不傳 beCode**); 外送: \`delivery-query-addresses\` (beType=2 麥樂送 / 6 團餐) 拿 addressId + storeCode + beCode (orderType=2)
   - 拉菜單 → \`query-meals\` (storeCode + orderType, 外送時加 beCode), 返回 \`data.meals\` 是 \`{code: {name, currentPrice}}\` 字典, **後續 productCode 必須從這裡的 key 拿, 不要編**
   - 算價 → \`calculate-price\` 4 字段: storeCode, **orderType (整數 1 或 2, 不是字符串 "1" / "DELIVERY")**, items: [{productCode, quantity}], beCode (**只有外送傳, 到店不傳**)。返回 takeWayList 含 takeWayCode
   - 下單 → \`create-order\` 同 4 字段 + 到店必填 takeWayCode (從 calculate-price 拿) / 外送必填 addressId (從 delivery-query-addresses 拿)
   - calculate-price 報"上游返回空列表" **99% 是參數錯**: 檢查 productCode 是不是 query-meals 真返回過的 / orderType 整數對不對 / 外送漏傳 beCode / 到店多傳了 beCode。先排查參數, 再換門店
4. **套餐怎麼下** (常卡這裡): 套餐 (如"培根安格斯厚牛堡大套餐") 在 query-meals 的 meals 字典裡就是一個**頂層 code**, 跟單品地位完全一樣。直接把套餐 productCode 塞 items[] + quantity:1 就行, 上游會用默認子單品組合。**不要拆套餐**, 也別拿 query-meal-detail 輸出去拼 items, 那樣要麼報錯要麼把套餐拆成單點丟掉套餐價。用戶問"這套餐裡都有啥"時, 才調一次 query-meal-detail 給 TA 看, 之後回主流程。
5. **productCode 形態識別 (避免券 code 用錯)**:
   - 真實菜單 productCode 全是**純數字** (\`9900008139\` / \`920215\` / \`1533\` / \`521517\`), 來自 query-meals 的 meals key
   - **字母開頭的 code (如 \`W000002024\`) 幾乎都是優惠券 spu**, 出現在 query-store-coupons / available-coupons / query-my-coupons 裡。這種 code 不能單獨塞 items, 必須**同時**帶 \`couponId\` + \`couponCode\` (從該券對象取):
     \`items: [{ productCode: "<券 spu code>", quantity: 1, couponId: "<...>", couponCode: "<...>" }]\`
   - 用戶沒明說要用券, 就別主動塞券 code, 用 query-meals 的純數字 productCode 即可
---
`;

/**
 * 尾部小提醒 (注入在 messages 數組的最後, 主消息之前)。
 *
 * 長 context 下模型注意力會衰減 (lost-in-the-middle), 頭部的麥當勞提示詞會被
 * 中段歷史擠掉。激活態加一道短小的尾部 reminder, 讓模型生成前最後看一眼規則。
 * 短到不會觸發 content_filter, 也不會沖淡角色人設。
 */
export const MCD_TAIL_REMINDER = `[麥當勞助手 ON · **永遠用角色語氣給一段文字回覆, 別空回 (哪怕一兩句也行)**; 工具結果有卡片自動展示, 別復讀菜單 / 別畫 markdown 表格; 下單鏈路: query-nearby-stores 或 delivery-query-addresses → query-meals → calculate-price → create-order; orderType 整數 1/2, 到店不傳 beCode, 外送 beCode 來自 delivery-query-addresses; productCode 必須來自 query-meals 的 meals 字典 key; 套餐用 meals 裡頂層 code 直接下單, 不拆解, query-meal-detail 僅用於給用戶看套餐組成]`;

// ========== 終結性工具判定 (自動結束麥請求) ==========

const TERMINAL_TOOL_PATTERNS: RegExp[] = [
    /create.*order/i,
    /submit.*order/i,
    /place.*order/i,
    /confirm.*order/i,
    /pay.*order/i,
    /下[单單]/i,
    /提交[订訂][单單]/i,
    /[创創]建[订訂][单單]/i,
];

/**
 * 判斷一次工具調用是否"成功完成了一筆訂單"，從而觸發自動結束。
 * 僅當 (a) 工具名命中下單模式 且 (b) 調用沒報錯 時返回 true。
 */
export const isTerminalToolCall = (toolName: string, success: boolean): boolean => {
    if (!success) return false;
    return TERMINAL_TOOL_PATTERNS.some(p => p.test(toolName));
};

// ========== 卡片類型暗示 (給前端 McdCard 用) ==========

export type McdCardKind = 'menu' | 'order' | 'store' | 'coupon' | 'activity' | 'address' | 'generic';

const MENU_PATTERNS = [
    /menu/i, /meal/i, /food/i, /dish/i, /product/i, /goods/i, /sku/i,
    /菜[单單]/, /商品/, /餐(?![厅廳])/, /套餐/, /[单單]品/, /菜品/,
    /query.*meal/i, /query.*food/i, /query.*product/i, /list.*meal/i, /list.*product/i, /list.*food/i,
    /get.*meal/i, /get.*menu/i, /get.*product/i,
];
const STORE_PATTERNS = [/store/i, /shop/i, /restaurant/i, /[门門]店/, /附近/, /nearby/i, /餐[厅廳]/];
const ADDRESS_PATTERNS = [/address/i, /地址/, /收[货貨]/, /consignee/i];
const COUPON_PATTERNS = [/coupon/i, /voucher/i, /券/, /redeem/i, /[兑兌][换換]/, /[积積]分/, /point/i];
const ACTIVITY_PATTERNS = [/activity/i, /event/i, /campaign/i, /活[动動]/, /日[历曆]/, /calendar/i, /promotion/i];
const ORDER_PATTERNS = [/order/i, /下[单單]/, /[订訂][单單]/, /submit/i, /create.*order/i, /place.*order/i];

export const inferCardKind = (toolName: string): McdCardKind => {
    if (ORDER_PATTERNS.some(p => p.test(toolName))) return 'order';
    if (ADDRESS_PATTERNS.some(p => p.test(toolName))) return 'address';
    if (MENU_PATTERNS.some(p => p.test(toolName))) return 'menu';
    if (STORE_PATTERNS.some(p => p.test(toolName))) return 'store';
    if (COUPON_PATTERNS.some(p => p.test(toolName))) return 'coupon';
    if (ACTIVITY_PATTERNS.some(p => p.test(toolName))) return 'activity';
    return 'generic';
};

// ========== 激活態從消息歷史推導 ==========
//
// 我們不引入新的持久化存儲, 而是把 mcdActivate / mcdDeactivate 標記打在
// 對應的"麥請求"/"結束麥請求"消息的 metadata 上, 當前是否激活由"最近一條
// 標記是激活還是結束"決定。這樣導出聊天記錄 / 切設備同步, 狀態都跟著走。

export const MCD_ACTIVATE_TRIGGER = '麥請求';
export const MCD_DEACTIVATE_TRIGGER = '結束麥請求';

interface MsgLike {
    role: string;
    content?: string;
    metadata?: any;
    timestamp?: number;
}

/** 從消息列表推導：當前 chatId 下"麥請求"是否處於激活態 */
export const isMcdActivatedInMessages = (messages: MsgLike[]): boolean => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const meta = m.metadata || {};
        if (meta.mcdDeactivate) return false;
        if (meta.mcdActivate) return true;
        // 兼容: 舊消息可能只有內容標記沒 metadata
        if (m.role === 'user' && typeof m.content === 'string') {
            const c = m.content.trim();
            if (equalsAnyScript(c, MCD_DEACTIVATE_TRIGGER)) return false;
            if (equalsAnyScript(c, MCD_ACTIVATE_TRIGGER)) return true;
        }
    }
    return false;
};

// ========== McdMiniApp 協同模式: 給主 systemPrompt 追加的上下文塊 ==========
//
// 跟 LLM-tool-call 那條死路完全不同, 這裡 LLM 只負責聊天, 不調任何工具。
// 所以注入的不是工具說明也不是人設替代, 只是"當前小程序裡的實時狀態 + 協同規則"。
// 主 systemPrompt 的人設、記憶、日程、情緒 全部保留, 這段就是末尾貼一張快照。

export interface McdMiniAppSnapshot {
    open: boolean;
    /** 跟 McdMiniApp 裡的 Step 一一對應 (下單成功後會停在 success) */
    step?: 'mode' | 'pick' | 'menu' | 'review' | 'success';
    orderType?: 1 | 2;
    storeCode?: string;
    storeName?: string;
    addressLabel?: string;
    cart?: Array<{ code: string; name: string; price?: any; qty: number }>;
    /** query-meals 當前門店菜單 (data.meals 字典) */
    menuMeals?: Record<string, { name?: string; currentPrice?: string }>;
    /** list-nutrition-foods 返回的 toon 字符串 */
    nutritionData?: string;
}

/**
 * char 在小程序裡能調的"建議加購"工具。
 * 這工具不真改購物車, 只把建議作為一張"提案"卡渲染到 chat 面板, 讓用戶決定。
 * 模型本身不接觸任何真 MCP 工具 (data 全部由 UI 按鈕驅動); 這是一個 UI 鉤子,
 * 讓 char 有"我也在勾選"的臨場感。
 */
export const MCD_PROPOSE_TOOL = {
    type: 'function' as const,
    function: {
        name: 'propose_cart_items',
        description: '當你想給用戶推薦 1~N 件商品加進購物車時調用這工具。用戶會在小程序聊天裡看到一張"char 想加這些"小卡片, 每項帶"+ 加進購物車"按鈕自己決定。這不是真下單, 只是把推薦推到 UI; 你調完工具還可以繼續用文字解釋或聊天。\n\n**前置硬條件**: 必須等到 system prompt 裡出現"當前門店在售 (前 N 項...)"清單後再調; 用戶還在選模式 / 選地址門店階段時, 菜單沒加載, 任何 code 都是憑印象編的, 你的 propose 會被服務端直接拒, 反而拖慢節奏。這種時候用文字陪聊就好 ("等你選完店我幫你看")。',
        parameters: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    description: '推薦項列表 (1~6 件最佳)',
                    items: {
                        type: 'object',
                        properties: {
                            code: { type: 'string', description: '商品 productCode, **必須**是當前 system prompt 裡"當前門店在售"清單 = 號左邊那串純數字 (如 "9900010341", "920215")。**絕對不能**: ① 用商品名當 code (e.g. "板燒雞腿堡" 是錯的, 那是名字); ② 用其它門店 / 印象中的 code (上一筆訂單 / 別店看到的, 這家不一定有, 算價會空); ③ 在菜單還沒加載時硬編。優先選名字含套餐/單人餐/雙人餐/全家桶/三/四件套 這種打包好的, 比單點划算。' },
                            name: { type: 'string', description: '商品名 (跟菜單一致)' },
                            qty: { type: 'integer', description: '推薦數量', minimum: 1, maximum: 10 },
                            reason: { type: 'string', description: '一句話說為什麼推這個 (熱量/搭配/划算/口味), 30 字內' }
                        },
                        required: ['code', 'name', 'qty']
                    },
                    minItems: 1
                },
                overall_note: { type: 'string', description: '整體推薦理由 (可選, 50 字內)' }
            },
            required: ['items']
        }
    }
};

/** propose_cart_items 裡的一項 (模型現編的, 字段都可能缺, 所以全是可選) */
export interface McdProposalItemLike {
    code?: string;
    name?: string;
    qty?: number;
    reason?: string;
}

/**
 * 把 char 在 propose_cart_items 裡塞的 items 裡所有 productCode 校準:
 * - 如果 code 已經在菜單字典裡, 原樣保留
 * - 否則按 name (優先) / code 字段當做名字 在菜單裡全局匹配:
 *     1) 完全匹配 → 用對應 code
 *     2) 一方包含另一方 (e.g. "可樂" 匹配 "無糖可口可樂中杯") → 取最長匹配
 *     3) 都沒匹配上 → 保留原樣 (後面校驗會拒)
 * 返回 { fixed: 修正後的 items, fixes: 修了哪些 (用於 log) }
 */
export const autoFixProposalCodesByName = (
    items: McdProposalItemLike[],
    menuMeals: Record<string, { name?: string; currentPrice?: string }> | undefined
): { fixed: McdProposalItemLike[]; fixes: Array<{ from: string; to: string; name: string }> } => {
    const fixes: Array<{ from: string; to: string; name: string }> = [];
    if (!items?.length || !menuMeals || !Object.keys(menuMeals).length) {
        return { fixed: items || [], fixes };
    }
    const menuKeys = Object.keys(menuMeals);
    // 預建 name → code 索引 (完全匹配)
    const nameToCode: Record<string, string> = {};
    for (const k of menuKeys) {
        const nm = String(menuMeals[k]?.name || '').trim();
        if (nm) nameToCode[nm] = k;
    }
    const fixed = items.map((it: any) => {
        const origCode = String(it?.code || '').trim();
        // 1) code 已經合法 (字典裡有) → 不動
        if (origCode && menuMeals[origCode]) return it;
        // 2) 拿 it.name 或 it.code (有時候模型把名字直接塞 code) 做匹配關鍵詞
        const target = String(it?.name || origCode || '').trim();
        if (!target) return it;
        // 2a) 完全匹配
        if (nameToCode[target]) {
            const realCode = nameToCode[target];
            fixes.push({ from: origCode, to: realCode, name: target });
            return { ...it, code: realCode, name: menuMeals[realCode].name };
        }
        // 2b) 子串匹配, 取被匹配方最長的那個 (越具體越好)
        let bestKey: string | null = null;
        let bestLen = 0;
        for (const k of menuKeys) {
            const nm = String(menuMeals[k]?.name || '').trim();
            if (!nm) continue;
            if (nm === target) { bestKey = k; bestLen = nm.length; break; }
            if (nm.includes(target) || target.includes(nm)) {
                if (nm.length > bestLen) { bestKey = k; bestLen = nm.length; }
            }
        }
        if (bestKey) {
            fixes.push({ from: origCode, to: bestKey, name: menuMeals[bestKey].name || target });
            return { ...it, code: bestKey, name: menuMeals[bestKey].name };
        }
        return it;
    });
    return { fixed, fixes };
};

export const buildMcdMiniAppContextBlock = (snap?: McdMiniAppSnapshot, userName: string = '用戶'): string => {
    if (!snap || !snap.open) return '';
    const lines: string[] = [];
    lines.push('');
    lines.push('---');
    lines.push(`[麥當勞協同點餐 — ${userName} 現在打開了麥當勞小程序, 跟你一起選餐]`);
    lines.push('');
    lines.push('# 當前狀態 (實時)');
    lines.push(`- 步驟: ${snap.step === 'mode' ? '選模式' : snap.step === 'pick' ? '選地址/門店' : snap.step === 'menu' ? '瀏覽菜單' : snap.step === 'review' ? '確認訂單' : '?'}`);
    if (snap.orderType) lines.push(`- 取餐方式: ${snap.orderType === 1 ? '到店取餐' : '麥樂送外賣'}`);
    if (snap.storeName || snap.storeCode) lines.push(`- 門店: ${snap.storeName || snap.storeCode}`);
    if (snap.addressLabel) lines.push(`- 收貨地址: ${snap.addressLabel}`);
    const cart = snap.cart || [];
    if (cart.length) {
        const total = cart.reduce((s, l) => {
            const p = typeof l.price === 'string' ? parseFloat(l.price) : (typeof l.price === 'number' ? l.price : 0);
            return s + (isFinite(p) ? p * l.qty : 0);
        }, 0);
        lines.push(`- 購物車 (${cart.length} 項, 合計 ¥${total.toFixed(2)}):`);
        for (const l of cart) {
            const p = typeof l.price === 'string' ? parseFloat(l.price) : (typeof l.price === 'number' ? l.price : 0);
            lines.push(`    · ${l.name} ×${l.qty}${isFinite(p) && p > 0 ? ` (¥${p.toFixed(2)}/份)` : ''}`);
        }
    } else {
        lines.push(`- 購物車: 空`);
    }
    lines.push('');

    const loadedMenuMeals = snap.menuMeals && Object.keys(snap.menuMeals).length ? snap.menuMeals : null;
    if (!loadedMenuMeals) {
        lines.push(`# 當前菜單: ❌ 還沒加載 (用戶還在選模式 / 選地址門店階段)`);
        lines.push(`**這一階段不要調 propose_cart_items**: 沒有菜單字典, 你 propose 出去的任何 code 都會被服務端拒 (會回一條 tool error)。陪用戶選地址 / 門店就好, 文字回應即可; 等小程序進入菜單頁, system prompt 裡出現"當前門店在售"清單後再說推薦。`);
        lines.push('');
    }
    if (loadedMenuMeals) {
        // 把套餐排前面 (人氣熱賣裡的套餐 char 看著最先, 下意識更傾向推套餐)
        const COMBO_RE = /(套餐|[单單]人餐|[双雙]人餐|全家桶|三件套|四件套|五件套|超值[组組]合|[节節]省[组組]合)/;
        const allEntries = Object.entries(loadedMenuMeals).filter(([, m]) => m?.name);
        const combos = allEntries.filter(([, m]) => COMBO_RE.test(String(m.name)));
        const singles = allEntries.filter(([, m]) => !COMBO_RE.test(String(m.name)));
        const ordered = [...combos, ...singles].slice(0, 100);
        lines.push(`# 當前門店在售 (前 ${ordered.length} 項, 推薦時從這裡挑; **套餐已排在前面, 優先看這些**)`);
        lines.push('格式: \`code=商品名 ¥價格\` ← propose_cart_items 的 code 字段必須用這裡的 code (= 號左邊那串), 不要用商品名');
        for (const [code, m] of ordered) {
            const v = m as any;
            if (!v?.name) continue;
            const isCombo = COMBO_RE.test(String(v.name));
            const tag = isCombo ? '🍱[套餐] ' : '';
            lines.push(`- ${tag}${code}=${v.name}${v.currentPrice ? ` ¥${v.currentPrice}` : ''}`);
        }
        lines.push('');
    }

    if (snap.nutritionData) {
        lines.push(`# 全量營養表 (toon 緊湊表; 頭部是字段名順序)`);
        lines.push(`用戶問熱量/蛋白質/脂肪/碳水時, 直接查這表回答, 不要自己編。`);
        lines.push('');
        const nd = snap.nutritionData;
        lines.push(nd.length > 6000 ? nd.slice(0, 6000) + '\n...(截斷)' : nd);
        lines.push('');
    }

    lines.push(`# 協同規則 (這段優先級高於其它通用規則)`);
    lines.push(`- ${userName} 在小程序裡跟你聊"吃啥 / 幫我挑 / 這個怎麼樣", 你按平時人設自然回應。`);
    lines.push(`- 真要推薦具體商品時, **優先調 \`propose_cart_items\` 工具**把推薦推到 UI (用戶會看到 "+ 加進購物車" 卡片自己決定)。這比純文字念名字更直觀, 你也有"我也在勾選"的參與感。`);
    lines.push(`- **優先推套餐, 不要推單點**: 麥當勞套餐 (含漢堡/雞腿堡 + 薯條 + 飲料 那種) 一般比單點便宜 30~50%。在"當前門店在售"清單裡凡是名字帶"套餐 / 單人餐 / 雙人餐 / 全家桶 / 三件套 / 四件套"的都優先看, 推薦時主推這些。除非用戶明確說"我只要 X" / "不要套餐" / "已經吃過 Y", 否則不要給單品組合; 想要的口味用套餐裡的對應主食版本滿足 (比如"想吃辣的"→優選"麥辣雞腿堡套餐"而不是"麥辣雞腿堡"單品)。`);
    lines.push(`- **propose 工具的 code 必須是菜單字典裡的 key (數字, 形如 9900010341 / 920215)**, **絕對不能把商品名當 code 傳** (e.g. code="板燒雞腿堡" 是錯的, 真 code 是上面"當前門店在售"列表裡那條對應的 key)。code 錯了用戶加不到購物車, 算價也會失敗。如果你不確定 code, 寧可不推。`);
    lines.push(`- 工具調用後**還可以繼續聊**, 解釋為啥推這些 / 調侃幾句 / 提醒搭配什麼的, 這是文字部分, 不要再把商品名復讀一遍 (卡片裡已顯示)。`);
    lines.push(`- 僅當你想說一兩句意見 (不需要推具體商品) 或者解答用戶問題 (問熱量/營養/比較) 時, 直接文字回答就好, 不必調工具。`);
    lines.push(`- **不要畫 markdown 表格 / 不要貼 productCode**, 那些信息小程序界面已經在顯示。`);
    lines.push(`- 用戶問熱量/營養 → 在營養表裡查準確數值再答。"挑 X 大卡以內"這種 → 在營養表裡篩能湊出組合的, 同時**只推薦當前門店在售清單裡實際有的**, 調 propose 工具時 code 必須來自那個清單。`);
    lines.push(`- 用戶已經選了東西, 看一眼購物車給點評 (夠不夠吃 / 配不配飲料 / 有沒有重的), 但不要復讀購物車清單。要建議加點什麼時調 propose 工具, 不要光說。`);
    lines.push(`- **你不能直接改購物車 / 不能直接下單**, 工具只是推送建議, 加減、敲定都要 ${userName} 在小程序裡自己點。`);
    lines.push('---');
    return lines.join('\n');
};

//
// 模型每輪調工具的結果都存進 mcd_card 消息裡 (見 useChatAI.ts), 但跨輪時
// JSON 字符串塞在 tool/assistant content 裡很容易被注意力衰減, 模型經常
// "上一輪明明拿到了 storeCode, 這一輪就忘了"。
//
// 解法: 每次構 system prompt 時, 反向掃一遍當前激活區間內的 mcd_card,
//      把 storeCode / beCode / orderType / addressId / takeWayCode /
//      已見過的 productCode 抽出來, 編一段緊湊的"當前會話狀態"塞進
//      system prompt。佔用不到幾百 token, 但模型每輪都能一眼看到正確 ID。

interface McdAddressTriplet {
    addressId?: string;
    storeCode?: string;
    beCode?: string;
    label?: string;
}

interface McdStoreEntry {
    storeCode?: string;
    beCode?: string;
    storeName?: string;
}

interface McdSessionState {
    storeCode?: string;
    storeName?: string;
    beCode?: string;
    orderType?: 1 | 2;
    addressId?: string;
    addressLabel?: string;
    takeWayCode?: string;
    knownProductCodes: Array<{ code: string; name?: string; price?: string | number }>;
    /** 全部已查到的外送地址 (用同一條裡的 storeCode + beCode, 不要混搭) */
    addresses: McdAddressTriplet[];
    /** 全部已查到的附近門店 */
    nearbyStores: McdStoreEntry[];
    lastOrderId?: string;
}

const pickStr = (obj: any, keys: string[]): string | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
    }
    return undefined;
};

const collectProductCodes = (mealsResult: any): Array<{ code: string; name?: string; price?: string }> => {
    const out: Array<{ code: string; name?: string; price?: string }> = [];
    if (!mealsResult) return out;
    // query-meals 返回結構: data.meals = { code: { name, currentPrice } }
    const meals = mealsResult.meals && typeof mealsResult.meals === 'object' && !Array.isArray(mealsResult.meals)
        ? mealsResult.meals : null;
    if (meals) {
        for (const code of Object.keys(meals)) {
            const m = meals[code];
            if (!m || typeof m !== 'object') continue;
            out.push({
                code,
                name: typeof m.name === 'string' ? m.name : undefined,
                price: typeof m.currentPrice === 'string' ? m.currentPrice : (typeof m.currentPrice === 'number' ? String(m.currentPrice) : undefined),
            });
        }
    }
    return out;
};

/**
 * 反向掃描當前激活區間內的 mcd_card 消息, 把關鍵 ID 抽出來。
 * 遇到 mcdActivate 之前 / mcdDeactivate 之後就停 (上一段會話的狀態不要帶過來)。
 */
export const extractMcdSessionState = (messages: MsgLike[]): McdSessionState => {
    const state: McdSessionState = { knownProductCodes: [], addresses: [], nearbyStores: [] };
    // 先確定本次激活區間起點 (最近一次 mcdActivate)
    let activateIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const meta = m.metadata || {};
        if (meta.mcdDeactivate) break;
        if (meta.mcdActivate || (m.role === 'user' && typeof m.content === 'string' && equalsAnyScript(m.content.trim(), MCD_ACTIVATE_TRIGGER))) {
            activateIdx = i;
            break;
        }
    }
    if (activateIdx === -1) return state;

    // 從激活點往後掃, 後面的 tool 結果覆蓋前面的 (除了 productCodes 是累積)
    const seenCodes = new Set<string>();
    for (let i = activateIdx; i < messages.length; i++) {
        const m: any = messages[i];
        const meta = m.metadata || {};
        if (meta.mcdDeactivate) break;
        if ((m.type as string) !== 'mcd_card') continue;
        const tool = String(meta.mcdToolName || '').toLowerCase();
        const args = meta.mcdToolArgs || {};
        const result = meta.mcdToolResult;
        if (meta.mcdToolError || result == null) continue;

        // calculate-price / create-order: args 裡的 storeCode/orderType/beCode 就是模型當時
        // 用的, 是最權威的 "當前會話決策狀態"
        if (/calculate[-_]?price|create[-_]?order/.test(tool)) {
            if (args.storeCode) state.storeCode = String(args.storeCode);
            if (args.beCode) state.beCode = String(args.beCode);
            if (args.orderType === 1 || args.orderType === '1') state.orderType = 1;
            else if (args.orderType === 2 || args.orderType === '2') state.orderType = 2;
            if (args.addressId) state.addressId = String(args.addressId);
        }

        // delivery-query-addresses: 把每條地址的 (addressId, storeCode, beCode) 三元組都存下來,
        // 模型選地址時必須用同一條裡成對的 storeCode + beCode, 不能混搭
        if (/delivery[-_]?query[-_]?addresses/.test(tool)) {
            const list = result.addresses || result;
            const arr = Array.isArray(list) ? list : [];
            for (const a of arr) {
                if (!a || typeof a !== 'object') continue;
                const triplet: McdAddressTriplet = {
                    addressId: pickStr(a, ['addressId', 'id']),
                    storeCode: pickStr(a, ['storeCode']),
                    beCode: pickStr(a, ['beCode']),
                    label: pickStr(a, ['fullAddress', 'address', 'storeName']),
                };
                if (triplet.addressId || triplet.storeCode) {
                    // 去重 (按 addressId)
                    const key = triplet.addressId || `${triplet.storeCode}|${triplet.beCode}`;
                    if (!state.addresses.some(x => (x.addressId || `${x.storeCode}|${x.beCode}`) === key)) {
                        state.addresses.push(triplet);
                    }
                }
            }
            const first = arr[0];
            if (first && typeof first === 'object') {
                state.addressId = state.addressId || pickStr(first, ['addressId', 'id']);
                state.storeCode = state.storeCode || pickStr(first, ['storeCode']);
                state.beCode = state.beCode || pickStr(first, ['beCode']);
                state.addressLabel = state.addressLabel || pickStr(first, ['fullAddress', 'address']);
                if (state.orderType == null) state.orderType = 2; // 調了外送地址 = 外送模式
            }
        }

        // query-nearby-stores: 每家門店的 storeCode/beCode 都記下來
        if (/query[-_]?nearby[-_]?stores/.test(tool)) {
            const list = Array.isArray(result) ? result : (result?.stores || result?.list);
            const arr = Array.isArray(list) ? list : [];
            for (const s of arr) {
                if (!s || typeof s !== 'object') continue;
                const entry: McdStoreEntry = {
                    storeCode: pickStr(s, ['storeCode']),
                    beCode: pickStr(s, ['beCode']),
                    storeName: pickStr(s, ['storeName', 'name']),
                };
                if (entry.storeCode && !state.nearbyStores.some(x => x.storeCode === entry.storeCode)) {
                    state.nearbyStores.push(entry);
                }
            }
            const first = arr[0];
            if (first && typeof first === 'object') {
                if (!state.storeCode) state.storeCode = pickStr(first, ['storeCode']);
                if (!state.beCode) state.beCode = pickStr(first, ['beCode']);
                state.storeName = state.storeName || pickStr(first, ['storeName', 'name']);
                if (state.orderType == null) state.orderType = 1; // 查附近門店 = 到店模式
            }
        }

        // query-meals: 拉到 productCode 字典, 累積起來
        if (/query[-_]?meals/.test(tool)) {
            if (args.storeCode && !state.storeCode) state.storeCode = String(args.storeCode);
            if (args.beCode && !state.beCode) state.beCode = String(args.beCode);
            const codes = collectProductCodes(result);
            for (const c of codes) {
                if (!seenCodes.has(c.code)) {
                    seenCodes.add(c.code);
                    state.knownProductCodes.push(c);
                }
            }
        }

        // calculate-price 成功響應裡 takeWayList[0].takeWayCode 就是到店下單要用的
        if (/calculate[-_]?price/.test(tool)) {
            const tw = result?.takeWayList;
            if (Array.isArray(tw) && tw.length) {
                const code = pickStr(tw[0], ['takeWayCode', 'code']);
                if (code) state.takeWayCode = code;
            }
        }

        // create-order 成功 → 拿 orderId
        if (/create[-_]?order/.test(tool)) {
            const oid = pickStr(result, ['orderId']) || pickStr(result?.orderDetail, ['orderId']);
            if (oid) state.lastOrderId = oid;
        }
    }
    return state;
};

/**
 * 把 session state 編譯成一段緊湊的 system prompt 段落。無任何已知字段時返回空串,
 * 調用方拿到空串就不用往 prompt 裡塞這段。
 */
export const buildMcdSessionContextPrompt = (state: McdSessionState): string => {
    const lines: string[] = [];
    if (state.orderType) {
        lines.push(`- 取餐模式: orderType=${state.orderType} (${state.orderType === 1 ? '到店' : '外送'})`);
    }
    if (state.storeCode) {
        lines.push(`- 當前選中 storeCode: ${state.storeCode}${state.storeName ? ` (${state.storeName})` : ''}`);
    }
    if (state.beCode) {
        lines.push(`- 當前選中 beCode: ${state.beCode}`);
    } else if (state.orderType === 1) {
        lines.push(`- beCode: 不傳 (到店模式)`);
    }
    if (state.addressId) {
        lines.push(`- 當前選中 addressId: ${state.addressId}${state.addressLabel ? ` (${state.addressLabel})` : ''}`);
    }
    if (state.takeWayCode) {
        lines.push(`- takeWayCode: ${state.takeWayCode} (到店模式 create-order 直接用這個)`);
    }
    if (state.lastOrderId) {
        lines.push(`- 最近 orderId: ${state.lastOrderId}`);
    }
    if (state.addresses.length > 1) {
        // 列出全部外送地址, 讓模型知道每條地址的 storeCode/beCode 是綁定的, 不能混搭
        const addrLines = state.addresses.map((a, i) => {
            const tag = a.addressId === state.addressId ? ' ← 當前選中' : '';
            return `    ${i + 1}. addressId=${a.addressId || '?'} | storeCode=${a.storeCode || '?'} | beCode=${a.beCode || '?'} | ${a.label || ''}${tag}`;
        }).join('\n');
        lines.push(`- 全部已知外送地址 (storeCode + beCode 必須用同一行的, 千萬不要從不同地址混搭):\n${addrLines}`);
    }
    if (state.nearbyStores.length > 1) {
        const storeLines = state.nearbyStores.map((s, i) => {
            const tag = s.storeCode === state.storeCode ? ' ← 當前選中' : '';
            return `    ${i + 1}. storeCode=${s.storeCode || '?'} | beCode=${s.beCode || '(空)'} | ${s.storeName || ''}${tag}`;
        }).join('\n');
        lines.push(`- 全部已知附近門店:\n${storeLines}`);
    }
    if (state.knownProductCodes.length) {
        // 只列前 30 個, 多了佔 token; 模型記不住全部也無所謂, 它能調 query-meals 重拉
        const sample = state.knownProductCodes.slice(0, 30).map(p => {
            const priceStr = p.price ? ` ¥${p.price}` : '';
            return `${p.code}=${p.name || '?'}${priceStr}`;
        }).join(', ');
        const more = state.knownProductCodes.length > 30 ? ` ...還有 ${state.knownProductCodes.length - 30} 個` : '';
        lines.push(`- 當前 storeCode 下已確認存在的 productCode (從 query-meals 拿到的, calculate-price/create-order 的 productCode 必須從這裡選, 不要編):\n  ${sample}${more}`);
    }
    if (!lines.length) return '';
    return `\n[麥當勞本輪會話已沉澱的狀態 — 調工具時直接複用下面這些 ID, 不要再問用戶也不要重新查]\n${lines.join('\n')}\n`;
};
