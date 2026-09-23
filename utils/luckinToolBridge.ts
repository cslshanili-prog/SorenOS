/**
 * 瑞幸 MCP 工具橋
 *
 * 職責 (與 mcdToolBridge 同構):
 * 1. 把 MCP 工具定義 (JSONSchema) 轉成 OpenAI function-calling 的 tools 數組
 * 2. 給主對話注入"瑞幸點單服務"的 system 提示詞
 * 3. 判定哪些工具屬於"終結性"操作 (下單成功後自動結束瑞幸請求)
 * 4. 給前端 LuckinCard 一個"工具結果該渲染成什麼卡片"的暗示函數
 * 5. LuckinMiniApp 協同模式: 實時快照 + 推薦工具
 *
 * 工具循環本身寫在 useChatAI.ts 裡。
 *
 * 真實工具 (open.lkcoffee.com 官方文檔, 共 8 個):
 *   門店: queryShopList(deptName?, longitude*, latitude*)
 *   商品: searchProductForMcp(deptId*, query*) / switchProduct(...) / queryProductDetailInfo(deptId*, productId*)
 *   訂單: previewOrder(deptId*, productList*) / createOrder(deptId*, productList*, longitude*, latitude*, couponCodeList?)
 *         queryOrderDetailInfo(orderId*) / cancelOrder(orderId*)
 * 信封: { code:0, msg:'success', data:..., success:true }
 * 注意: 瑞幸沒有"收貨地址/配送模式"工具 —— 門店按經緯度查, 下單也帶經緯度 (取餐碼自提模式)。
 */

import { listLuckinTools, LuckinToolDef } from './luckinMcpClient';
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

/**
 * 把 MCP 的 inputSchema 清洗成 Gemini / 主流模型函數聲明能吃的 schema 子集。
 *
 * 為什麼需要: Gemini 的 function declaration 只認 OpenAPI 3.0 的一個**很窄的子集**,
 * 原樣把 MCP 的 JSON-Schema 塞過去, 裡面只要有它不認的關鍵字 ($schema / additionalProperties /
 * default / examples / title / const / oneOf/anyOf/allOf / $ref / pattern / minLength...),
 * 就會整條請求 400 INVALID_ARGUMENT —— 表現就是"只有點單(帶工具)報錯, 普通聊天沒事"。
 *
 * 這裡只保留 Gemini 支持的字段: type / description / enum / items / properties / required / nullable,
 * 遞歸清洗; 順手把 type 規範成小寫, 把 ["string","null"] 這種聯合類型拍成 string + nullable。
 */
const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

const sanitizeSchemaForGemini = (schema: any, depth = 0): any => {
    if (!schema || typeof schema !== 'object' || depth > 6) {
        return { type: 'string' };
    }
    const out: any = {};

    // type (允許 ["string","null"] → string + nullable)
    let t = schema.type;
    if (Array.isArray(t)) {
        const nonNull = t.find((x: any) => x !== 'null');
        if (t.includes('null')) out.nullable = true;
        t = nonNull;
    }
    if (typeof t === 'string' && GEMINI_TYPES.has(t.toLowerCase())) {
        out.type = t.toLowerCase();
    }

    if (typeof schema.description === 'string') out.description = schema.description;
    if (Array.isArray(schema.enum) && schema.enum.length) out.enum = schema.enum.map((e: any) => String(e));
    if (schema.nullable === true) out.nullable = true;

    // object → properties / required
    const props = schema.properties;
    if (props && typeof props === 'object') {
        out.type = out.type || 'object';
        out.properties = {};
        for (const k of Object.keys(props)) {
            out.properties[k] = sanitizeSchemaForGemini(props[k], depth + 1);
        }
        if (Array.isArray(schema.required) && schema.required.length) {
            out.required = schema.required.filter((r: any) => typeof r === 'string' && out.properties[r]);
        }
    }

    // array → items
    if ((out.type === 'array' || schema.items) && schema.items) {
        out.type = out.type || 'array';
        out.items = sanitizeSchemaForGemini(schema.items, depth + 1);
    }

    if (!out.type) out.type = out.properties ? 'object' : 'string';
    return out;
};

/** 頂層 parameters 必須是 object schema */
const sanitizeParameters = (inputSchema: any): any => {
    const base = inputSchema && typeof inputSchema === 'object'
        ? sanitizeSchemaForGemini(inputSchema)
        : { type: 'object', properties: {} };
    if (base.type !== 'object') return { type: 'object', properties: {} };
    if (!base.properties) base.properties = {};
    return base;
};

export const luckinToolsToOpenAI = (tools: LuckinToolDef[]): OpenAITool[] => {
    return tools.map(t => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: t.description || `瑞幸 MCP 工具 ${t.name}`,
            parameters: sanitizeParameters(t.inputSchema),
        },
    }));
};

/** 拉工具並轉成 OpenAI 兼容格式; 失敗返回 null (調用方應跳過工具注入) */
export const fetchOpenAIToolsForLuckin = async (): Promise<OpenAITool[] | null> => {
    try {
        const tools = await listLuckinTools(false);
        if (!tools.length) return null;
        return luckinToolsToOpenAI(tools);
    } catch (e) {
        console.warn('[Luckin] 拉取工具失敗, 跳過本輪工具注入:', e);
        return null;
    }
};

// ========== 提示詞 ==========

export const LUCKIN_SYSTEM_PROMPT = `

---
[瑞幸點單模式已開啟 —— 你現在兼任 用戶 的"私人咖啡搭子"]

**核心**: 你還是原來的角色、原來的語氣、原來的記憶。瑞幸點單只是你此刻順手幫 TA 做的事。**每輪都要有角色化的文字**, 別乾巴巴報結果。

**你要主動用腦子點單, 不是等指令**:
- 調動你對 用戶 的記憶和偏好: TA 平時愛喝什麼、怕不怕苦、要不要冰、上次點了啥、有沒有忌口/在減脂。"想喝昨天一樣的" → 你就該從記憶裡翻出昨天那杯。
- TA 說"你有啥推薦""隨便""看到新品了" → 你自己拿主意, 用工具去搜、去定規格, 像個懂 TA 的咖啡師, 別反問一堆。
- 拿不準的細節(冷熱/糖度/杯型)按 TA 一貫偏好定; 真沒頭緒再用一句話確認。

# 工具鏈 (你自己調, 別讓用戶調)
1. **queryShopList**{ deptName?, longitude, latitude } 查門店, 拿 deptId。經緯度系統已在下方給你, 直接用。**用戶提到地點/商圈/門店名 (如"花溪公園附近""XX廣場店") → 把那個詞當 deptName 傳** (瑞幸門店多按商圈命名, 能篩中); 用戶沒提門店 → 不傳 deptName, 直接用當前經緯度取最近的店。
2. **searchProductForMcp**{ deptId, query } 搜商品, 拿 productId+skuCode+productAttrs(規格)。
3. **switchProduct**{ deptId, productId, skuCode, attrOperationParam:{attributeId, subAttr:{attributeId, operation:3}}, amount } 切規格(冰/熱、杯型、糖度) —— **按 TA 偏好把規格調對**, 切完 skuCode 會變, 用新的。
4. **queryProductDetailInfo**{ deptId, productId } 看商品全部規格。
5. **previewOrder**{ deptId, productList:[{amount, productId, skuCode}] } 算價 —— **這是你的終點**。

**關鍵紀律**:
- **組裝好後調 previewOrder 就停**。previewOrder 的結果會渲染成一張"結帳卡", 用戶 在卡片上改數量、確認、掃碼支付。**你絕對不要自己調 createOrder** —— 付錢必須 TA 本人在卡片上點。
- productId + skuCode 必須成對來自 search/switch 的返回, 數量整數, 別編。
- 調完 previewOrder 後, 用角色語氣說一句"我給你配了 XX, 看下右邊卡片, 覺得行就付"之類, 別復讀價格明細(卡片已顯示)。
- 閒聊就正常閒聊, 別硬點單。
---
`;

/** 尾部小提醒 (注入在 messages 數組的最後, 主消息之前)。 */
export const LUCKIN_TAIL_REMINDER = `[瑞幸點單助手 ON · **永遠用角色語氣給一段文字回覆, 別空回**; 工具結果有卡片自動展示, 別復讀菜單 / 別畫 markdown 表格; 鏈路: queryShopList(帶經緯度) → searchProductForMcp(deptId+query) → previewOrder → createOrder(帶經緯度); productId+skuCode 必須成對來自搜索返回, 不要編; amount 整數; 經緯度沒有就問用戶別瞎編]`;

// ========== 終結性工具判定 (下單成功後自動結束) ==========

const TERMINAL_TOOL_PATTERNS: RegExp[] = [
    /^createOrder$/i,
    /create.*order/i,
    /下[单單]/i,
];

export const isTerminalToolCall = (toolName: string, success: boolean): boolean => {
    if (!success) return false;
    return TERMINAL_TOOL_PATTERNS.some(p => p.test(toolName));
};

// ========== 卡片類型暗示 (給前端 LuckinCard 用) ==========

export type LuckinCardKind = 'menu' | 'order' | 'store' | 'coupon' | 'activity' | 'address' | 'cart' | 'generic';

export const inferCardKind = (toolName: string): LuckinCardKind => {
    const t = toolName || '';
    if (/queryShopList|shop.*list|store/i.test(t)) return 'store';
    if (/searchProduct|switchProduct|queryProductDetail|product|商品|菜[单單]/i.test(t)) return 'menu';
    if (/previewOrder|createOrder|queryOrderDetail|cancelOrder|order|[订訂][单單]|下[单單]/i.test(t)) return 'order';
    return 'generic';
};

// ========== 激活態從消息歷史推導 ==========

export const LUCKIN_ACTIVATE_TRIGGER = '瑞一杯';
export const LUCKIN_DEACTIVATE_TRIGGER = '結束瑞一杯';

interface MsgLike {
    role: string;
    content?: string;
    metadata?: any;
    timestamp?: number;
    type?: string;
}

/** 從消息列表推導：當前 chatId 下"瑞幸請求"是否處於激活態 */
export const isLuckinActivatedInMessages = (messages: MsgLike[]): boolean => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const meta = m.metadata || {};
        if (meta.luckinDeactivate) return false;
        if (meta.luckinActivate) return true;
        if (m.role === 'user' && typeof m.content === 'string') {
            const c = m.content.trim();
            if (equalsAnyScript(c, LUCKIN_DEACTIVATE_TRIGGER)) return false;
            if (equalsAnyScript(c, LUCKIN_ACTIVATE_TRIGGER)) return true;
        }
    }
    return false;
};

// ========== LuckinMiniApp 協同模式: 給主 systemPrompt 追加的上下文塊 ==========

export interface LuckinMiniAppSnapshot {
    open: boolean;
    step?: 'location' | 'store' | 'menu' | 'review';
    deptId?: number | string;
    storeName?: string;
    /** 購物車 (code = skuCode) */
    cart?: Array<{ code: string; productId?: number | string; name: string; price?: any; qty: number; spec?: string }>;
    /** 已搜到的商品 (skuCode → {name, price, productId}) */
    menuItems?: Record<string, { name?: string; price?: string | number; productId?: number | string; spec?: string }>;
}

/**
 * char 在小程序裡能調的"建議加購"工具。
 * 不真改購物車, 只把建議作為一張"提案"卡渲染到 chat 面板, 讓用戶決定。
 */
export const LUCKIN_PROPOSE_TOOL = {
    type: 'function' as const,
    function: {
        name: 'propose_cart_items',
        description: '當你想給用戶推薦 1~N 杯飲品/商品加進購物車時調用這工具。用戶會在小程序聊天裡看到一張"char 想加這些"小卡片, 每項帶"+ 加進購物車"按鈕自己決定。這不是真下單。\n\n**前置硬條件**: 必須等到 system prompt 裡出現"當前已搜到的商品"清單後再調; 用戶還沒搜過商品時菜單是空的, 任何 code 都是憑印象編的, 會被拒。這種時候用文字陪聊, 或者建議用戶搜個關鍵詞。',
        parameters: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    description: '推薦項列表 (1~6 件最佳)',
                    items: {
                        type: 'object',
                        properties: {
                            code: { type: 'string', description: '商品 skuCode, **必須**是當前 system prompt 裡"當前已搜到的商品"清單 = 號左邊那串 (形如 SP9636-00001)。**絕對不能**用商品名當 code。' },
                            name: { type: 'string', description: '商品名 (跟菜單一致)' },
                            qty: { type: 'integer', description: '推薦數量', minimum: 1, maximum: 10 },
                            reason: { type: 'string', description: '一句話說為什麼推這個 (口味/搭配/划算), 30 字內' }
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

/**
 * 把 char 在 propose_cart_items 裡塞的 items 裡所有 code 按菜單(skuCode 字典)校準。
 */
export const autoFixProposalCodesByName = (
    items: any[],
    menuItems: Record<string, { name?: string; price?: string | number }> | undefined
): { fixed: any[]; fixes: Array<{ from: string; to: string; name: string }> } => {
    const fixes: Array<{ from: string; to: string; name: string }> = [];
    if (!items?.length || !menuItems || !Object.keys(menuItems).length) {
        return { fixed: items || [], fixes };
    }
    const menuKeys = Object.keys(menuItems);
    const nameToCode: Record<string, string> = {};
    for (const k of menuKeys) {
        const nm = String(menuItems[k]?.name || '').trim();
        if (nm) nameToCode[nm] = k;
    }
    const fixed = items.map((it: any) => {
        const origCode = String(it?.code || '').trim();
        if (origCode && menuItems[origCode]) return it;
        const target = String(it?.name || origCode || '').trim();
        if (!target) return it;
        if (nameToCode[target]) {
            const realCode = nameToCode[target];
            fixes.push({ from: origCode, to: realCode, name: target });
            return { ...it, code: realCode, name: menuItems[realCode].name };
        }
        let bestKey: string | null = null;
        let bestLen = 0;
        for (const k of menuKeys) {
            const nm = String(menuItems[k]?.name || '').trim();
            if (!nm) continue;
            if (nm === target) { bestKey = k; bestLen = nm.length; break; }
            if (nm.includes(target) || target.includes(nm)) {
                if (nm.length > bestLen) { bestKey = k; bestLen = nm.length; }
            }
        }
        if (bestKey) {
            fixes.push({ from: origCode, to: bestKey, name: menuItems[bestKey].name || target });
            return { ...it, code: bestKey, name: menuItems[bestKey].name };
        }
        return it;
    });
    return { fixed, fixes };
};

export const buildLuckinMiniAppContextBlock = (snap?: LuckinMiniAppSnapshot, userName: string = '用戶'): string => {
    if (!snap || !snap.open) return '';
    const lines: string[] = [];
    lines.push('');
    lines.push('---');
    lines.push(`[瑞幸協同點單 — ${userName} 現在打開了瑞幸小程序, 跟你一起選]`);
    lines.push('');
    lines.push('# 當前狀態 (實時)');
    const stepLabel = snap.step === 'location' ? '定位中'
        : snap.step === 'store' ? '選門店'
        : snap.step === 'menu' ? '搜商品/瀏覽'
        : snap.step === 'review' ? '確認訂單' : '?';
    lines.push(`- 步驟: ${stepLabel}`);
    if (snap.storeName || snap.deptId) lines.push(`- 門店: ${snap.storeName || snap.deptId}${snap.deptId ? ` (deptId=${snap.deptId})` : ''}`);
    const cart = snap.cart || [];
    if (cart.length) {
        const total = cart.reduce((s, l) => {
            const p = typeof l.price === 'string' ? parseFloat(l.price) : (typeof l.price === 'number' ? l.price : 0);
            return s + (isFinite(p) ? p * l.qty : 0);
        }, 0);
        lines.push(`- 購物車 (${cart.length} 項, 合計約 ¥${total.toFixed(2)}):`);
        for (const l of cart) {
            const p = typeof l.price === 'string' ? parseFloat(l.price) : (typeof l.price === 'number' ? l.price : 0);
            lines.push(`    · ${l.name}${l.spec ? ` (${l.spec})` : ''} ×${l.qty}${isFinite(p) && p > 0 ? ` (¥${p.toFixed(2)}/份)` : ''}`);
        }
    } else {
        lines.push(`- 購物車: 空`);
    }
    lines.push('');

    const menuLoaded = !!(snap.menuItems && Object.keys(snap.menuItems).length);
    if (!menuLoaded) {
        lines.push(`# 當前已搜到的商品: ❌ 還沒搜 (用戶還在定位 / 選門店, 或還沒搜關鍵詞)`);
        lines.push(`**這一階段不要調 propose_cart_items**: 沒有商品字典, 你 propose 出去的任何 code 都會被拒。可以建議用戶搜個關鍵詞 (如"拿鐵"/"美式"/"生椰"), 等"當前已搜到的商品"清單出來後再推薦。`);
        lines.push('');
    } else {
        const entries = Object.entries(snap.menuItems!).filter(([, m]: any) => m?.name).slice(0, 120);
        lines.push(`# 當前已搜到的商品 (${entries.length} 項, 推薦時從這裡挑)`);
        lines.push('格式: `skuCode=商品名 ¥到手價` ← propose_cart_items 的 code 字段必須用這裡的 skuCode (= 號左邊那串, 形如 SP9636-00001), 不要用商品名');
        for (const [code, m] of entries) {
            const v = m as any;
            if (!v?.name) continue;
            lines.push(`- ${code}=${v.name}${v.price != null ? ` ¥${v.price}` : ''}`);
        }
        lines.push('');
    }

    lines.push(`# 協同規則 (這段優先級高於其它通用規則)`);
    lines.push(`- ${userName} 在小程序裡跟你聊"喝啥 / 幫我挑 / 這個怎麼樣", 你按平時人設自然回應。`);
    lines.push(`- 真要推薦具體商品時, **優先調 \`propose_cart_items\` 工具**把推薦推到 UI (用戶會看到 "+ 加進購物車" 卡片自己決定)。`);
    lines.push(`- **propose 工具的 code 必須是上面清單裡的 skuCode**, **絕對不能把商品名當 code 傳**。code 錯了用戶加不到購物車。如果你不確定 code, 寧可不推、或建議用戶先搜一下。`);
    lines.push(`- 工具調用後**還可以繼續聊**, 解釋為啥推這些 / 調侃幾句, 這是文字部分, 不要再復讀商品名 (卡片裡已顯示)。`);
    lines.push(`- **不要畫 markdown 表格 / 不要貼 code**, 那些信息小程序界面已經在顯示。`);
    lines.push(`- **你不能直接改購物車 / 不能直接下單**, 工具只是推送建議, 加減、敲定都要 ${userName} 在小程序裡自己點。`);
    lines.push('---');
    return lines.join('\n');
};

// ========== 會話狀態沉澱 (真實工具名/字段) ==========

interface LuckinSessionState {
    deptId?: number | string;
    storeName?: string;
    longitude?: number;
    latitude?: number;
    knownProducts: Array<{ skuCode: string; productId?: number | string; name?: string; price?: string | number }>;
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

const collectProducts = (result: any): Array<{ skuCode: string; productId?: number | string; name?: string; price?: string | number }> => {
    const out: Array<{ skuCode: string; productId?: number | string; name?: string; price?: string | number }> = [];
    const arr = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : (result && typeof result === 'object' ? [result] : []));
    for (const m of arr) {
        if (!m || typeof m !== 'object') continue;
        const skuCode = pickStr(m, ['skuCode']);
        if (!skuCode) continue;
        out.push({
            skuCode,
            productId: (m as any).productId,
            name: pickStr(m, ['productName', 'name']),
            price: (m as any).estimatePrice ?? (m as any).initialPrice ?? pickStr(m, ['price']),
        });
    }
    return out;
};

export const extractLuckinSessionState = (messages: MsgLike[]): LuckinSessionState => {
    const state: LuckinSessionState = { knownProducts: [] };
    let activateIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const meta = m.metadata || {};
        if (meta.luckinDeactivate) break;
        if (meta.luckinActivate || (m.role === 'user' && typeof m.content === 'string' && equalsAnyScript(m.content.trim(), LUCKIN_ACTIVATE_TRIGGER))) {
            activateIdx = i;
            break;
        }
    }
    if (activateIdx === -1) return state;

    const seen = new Set<string>();
    for (let i = activateIdx; i < messages.length; i++) {
        const m: any = messages[i];
        const meta = m.metadata || {};
        if (meta.luckinDeactivate) break;
        if ((m.type as string) !== 'luckin_card') continue;
        const tool = String(meta.luckinToolName || '');
        const args = meta.luckinToolArgs || {};
        const result = meta.luckinToolResult;
        if (meta.luckinToolError || result == null) continue;

        // 門店
        if (/queryShopList|shop|store/i.test(tool)) {
            const list = Array.isArray(result) ? result : (result?.data || result?.list);
            const first = Array.isArray(list) ? list[0] : null;
            if (first && typeof first === 'object') {
                if (state.deptId == null) state.deptId = (first as any).deptId;
                state.storeName = state.storeName || pickStr(first, ['deptName']);
                if ((first as any).longitude != null) state.longitude = (first as any).longitude;
                if ((first as any).latitude != null) state.latitude = (first as any).latitude;
            }
            if (args.longitude != null) state.longitude = args.longitude;
            if (args.latitude != null) state.latitude = args.latitude;
        }
        // 商品搜索 / 切換 / 詳情
        if (/searchProduct|switchProduct|queryProductDetail|product/i.test(tool)) {
            if (state.deptId == null && args.deptId != null) state.deptId = args.deptId;
            for (const p of collectProducts(result)) {
                if (!seen.has(p.skuCode)) { seen.add(p.skuCode); state.knownProducts.push(p); }
            }
        }
        // 下單
        if (/createOrder|create.*order/i.test(tool)) {
            if (state.deptId == null && args.deptId != null) state.deptId = args.deptId;
            const oid = pickStr(result, ['orderIdStr', 'orderId']);
            if (oid) state.lastOrderId = oid;
        }
    }
    return state;
};

export const buildLuckinSessionContextPrompt = (state: LuckinSessionState): string => {
    const lines: string[] = [];
    if (state.deptId != null) {
        lines.push(`- 當前選中門店: deptId=${state.deptId}${state.storeName ? ` (${state.storeName})` : ''}`);
    }
    if (state.longitude != null && state.latitude != null) {
        lines.push(`- 當前經緯度 (createOrder/queryShopList 複用這組): longitude=${state.longitude}, latitude=${state.latitude}`);
    }
    if (state.lastOrderId) {
        lines.push(`- 最近訂單號: ${state.lastOrderId}`);
    }
    if (state.knownProducts.length) {
        const sample = state.knownProducts.slice(0, 30).map(p => {
            const priceStr = p.price != null ? ` ¥${p.price}` : '';
            return `${p.skuCode}(productId=${p.productId ?? '?'})=${p.name || '?'}${priceStr}`;
        }).join(', ');
        const more = state.knownProducts.length > 30 ? ` ...還有 ${state.knownProducts.length - 30} 個` : '';
        lines.push(`- 已搜到的商品 (下單的 productId+skuCode 必須從這裡成對取, 不要編):\n  ${sample}${more}`);
    }
    if (!lines.length) return '';
    return `\n[瑞幸本輪會話已沉澱的狀態 — 調工具時直接複用下面這些 ID, 不要再問用戶也不要重新查]\n${lines.join('\n')}\n`;
};

// ========== 聊天模式 (點"瑞一杯"激活, 角色直接調真實 8 工具) ==========

export interface LuckinChatState {
    active: boolean;
    longitude?: number;
    latitude?: number;
    cityName?: string;
}

/**
 * 角色聊天點單模式: 拼出要追加到 system prompt 的整段。
 * = 私人咖啡師提示詞 + 當前定位 + 本輪已沉澱的門店/商品/訂單狀態。
 */
export const buildLuckinChatSystemBlock = (
    state: LuckinChatState | undefined,
    messages: MsgLike[],
    userName: string = '用戶',
): string => {
    if (!state?.active) return '';
    let block = LUCKIN_SYSTEM_PROMPT.split('用戶').join(userName);
    // 定位
    if (state.longitude != null && state.latitude != null) {
        block += `\n[當前定位 — queryShopList / createOrder 直接用這組經緯度, 別再問用戶]\n- longitude: ${state.longitude}\n- latitude: ${state.latitude}${state.cityName ? `\n- 大概位置: ${state.cityName}` : ''}\n`;
    } else {
        block += `\n[當前定位: ❌ 還沒拿到。queryShopList 的經緯度必填 —— 先用一句話問 ${userName} 在哪個城市/商圈, 或用城市中心座標(如北京 116.40,39.90 / 上海 121.47,31.23)調 queryShopList 再用 deptName 縮小。別編精確座標。]\n`;
    }
    // 已沉澱狀態 (門店 / 商品 / 訂單)
    const session = buildLuckinSessionContextPrompt(extractLuckinSessionState(messages));
    if (session) block += session;
    return block;
};
