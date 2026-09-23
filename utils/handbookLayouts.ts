/**
 * 手帳內頁版式庫 (v2)
 *
 * 6 套預置模板。一份 template = 一組帶位置/容量/可寫者/語義角色的槽 (SlotDef)。
 * orchestrator 按當天 user 活躍度 + 角色數選模板,
 * user 一次填 2~3 個 user 槽, 每個角色一次填 2~5 個槽 (own diary + corner notes
 * + 可選 sticky), 想全填滿需要 3~4 個角色參與才行, 所以每個 template 都設 10~13 個槽。
 *
 * 哲學: "大家共寫的一本手帳", 不是 "user 主寫 + 角色伴奏"。
 *  - user 沒素材就完全跳過 user 步, 不留假貨
 *  - hero-diary / mood-card / corner-note 都 user|char 共寫
 *  - 角色被鼓勵"造謠"自己今天的生活流, 不要把過去的事編進今天
 *  - 只有 timeline-plan / todo / gratitude / photo-caption 是 user 專屬
 *  - sticky-reaction 永遠 char-only, 永遠要 refersTo
 *
 * 設計規則:
 *  - 每頁 10~13 個槽, 讓 1 user + 3~4 char 都能各自留幾條
 *  - 槽總佔比 < 80%, 留 ≥ 20% 真實留白
 *  - 每頁 ≤ 1 個 hero (isHero=true)
 *
 * 座標都是 % of 整頁 (左側 ~6% 留給裝訂環, 頂/底各留 ~6%)。
 */

import { LayoutTemplate } from '../types';

// ─── A · plan-day · 計劃型一日 ────────────────────────────
const PLAN_DAY: LayoutTemplate = {
    id: 'plan-day',
    name: '計劃型一日',
    suitFor: 'user 早上想理清今天要做什麼',
    paperStyle: 'dot',
    pages: [[
        { id: 'A', slotRole: 'timeline-plan', charBudget: [40, 110], eligibleAuthors: ['user'],
          hint: 'user 今天的時間表, 6~8 行, 每行 時間 + 一句要做的事(≤12 字)',
          xPct: 6, yPct: 8, widthPct: 52, maxHeightPct: 42, isHero: true },
        { id: 'B', slotRole: 'mood-card', charBudget: [12, 40], eligibleAuthors: ['user', 'char'],
          hint: '今日心情速記 (≤30 字) + 1~5 顆星',
          xPct: 62, yPct: 8, widthPct: 32, maxHeightPct: 18,
          rotate: 1.5, skinVariant: 'lavender' },
        { id: 'C', slotRole: 'todo', charBudget: [30, 80], eligibleAuthors: ['user'],
          hint: 'user 今日待辦, 3~5 項, 每項 ≤ 14 字',
          xPct: 62, yPct: 28, widthPct: 32, maxHeightPct: 22 },
        { id: 'D', slotRole: 'sticky-reaction', charBudget: [15, 50], eligibleAuthors: ['char'],
          hint: '看到本頁某條已填的內容 (引用 slotId), 吐槽/捧場/補刀',
          xPct: 62, yPct: 52, widthPct: 32, maxHeightPct: 14,
          rotate: -1.2, skinVariant: 'mint' },
        { id: 'E', slotRole: 'sticky-reaction', charBudget: [15, 50], eligibleAuthors: ['char'],
          hint: '另一條反應, 不要重複 D 引的同一條',
          xPct: 62, yPct: 68, widthPct: 32, maxHeightPct: 14,
          rotate: 1.5, skinVariant: 'rose' },
        { id: 'F', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['char'],
          hint: '某角色今天的心情卡 (寫自己的, 跟 user 無關)',
          xPct: 62, yPct: 84, widthPct: 32, maxHeightPct: 12,
          skinVariant: 'sky' },
        { id: 'G', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '邊角小字, 一句獨白/感嘆', xPct: 8, yPct: 52, widthPct: 26, maxHeightPct: 8,
          rotate: -2 },
        { id: 'H', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 36, yPct: 52, widthPct: 24, maxHeightPct: 8, rotate: 1.6 },
        { id: 'I', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字 (任何人)', xPct: 8, yPct: 64, widthPct: 26, maxHeightPct: 8, rotate: 2 },
        { id: 'J', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 36, yPct: 64, widthPct: 24, maxHeightPct: 8, rotate: -1.4 },
        { id: 'K', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '頁腳一句', xPct: 8, yPct: 88, widthPct: 28, maxHeightPct: 8, rotate: -2 },
    ]],
};

// ─── B · reflective-day · 反思型一日 ──────────────────────
const REFLECTIVE_DAY: LayoutTemplate = {
    id: 'reflective-day',
    name: '反思型一日',
    suitFor: 'user 當天聊天 ≥ 8 句, 想寫一段長日記',
    paperStyle: 'lined',
    pages: [[
        { id: 'A', slotRole: 'hero-diary', charBudget: [80, 180], eligibleAuthors: ['user', 'char'],
          hint: '今日主日記本體, 第一人稱。可以是 user 也可以是某角色寫自己今天的生活流',
          xPct: 6, yPct: 8, widthPct: 56, maxHeightPct: 42, isHero: true },
        { id: 'B', slotRole: 'sticky-reaction', charBudget: [20, 60], eligibleAuthors: ['char'],
          hint: '反應已填某條 (refersTo)',
          xPct: 65, yPct: 8, widthPct: 30, maxHeightPct: 18,
          rotate: 1.8, skinVariant: 'lavender' },
        { id: 'C', slotRole: 'sticky-reaction', charBudget: [20, 60], eligibleAuthors: ['char'],
          hint: '另一個反應 (引不同條)',
          xPct: 65, yPct: 28, widthPct: 30, maxHeightPct: 18,
          rotate: -1.5, skinVariant: 'mint' },
        { id: 'D', slotRole: 'gratitude', charBudget: [30, 80], eligibleAuthors: ['user'],
          hint: 'user 今日感恩 3 條 (≤22 字 / 條), 必須今天的事',
          xPct: 6, yPct: 52, widthPct: 50, maxHeightPct: 20 },
        { id: 'E', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['user', 'char'],
          hint: '今日心情 + 評分 (誰的都行)',
          xPct: 60, yPct: 50, widthPct: 32, maxHeightPct: 16,
          rotate: 1, skinVariant: 'rose' },
        { id: 'F', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['char'],
          hint: '某角色的心情卡 (寫自己, 別用 user 當主語)',
          xPct: 60, yPct: 70, widthPct: 32, maxHeightPct: 14,
          skinVariant: 'sky' },
        { id: 'G', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '邊角小字獨白', xPct: 6, yPct: 76, widthPct: 26, maxHeightPct: 8, rotate: -1.8 },
        { id: 'H', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 34, yPct: 76, widthPct: 24, maxHeightPct: 8, rotate: 1.4 },
        { id: 'I', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 6, yPct: 86, widthPct: 24, maxHeightPct: 8, rotate: 2 },
        { id: 'J', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '頁腳一句', xPct: 32, yPct: 88, widthPct: 28, maxHeightPct: 7, rotate: -1.5 },
        { id: 'K', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['char'],
          hint: '某角色一句小字, 寫自己今天看到/想到的',
          xPct: 64, yPct: 88, widthPct: 28, maxHeightPct: 7, rotate: 1.8 },
    ]],
};

// ─── C · photo-day · 圖記一日 ─────────────────────────────
const PHOTO_DAY: LayoutTemplate = {
    id: 'photo-day',
    name: '圖記一日',
    suitFor: 'user 今天有想配圖的時刻',
    paperStyle: 'plain',
    pages: [[
        { id: 'A', slotRole: 'photo-caption', charBudget: [10, 25], eligibleAuthors: ['user'],
          hint: 'user 今天的一張照片 + 短描述 (≤25 字)',
          xPct: 6, yPct: 8, widthPct: 44, maxHeightPct: 36, isHero: true },
        { id: 'B', slotRole: 'hero-diary', charBudget: [60, 130], eligibleAuthors: ['user', 'char'],
          hint: '圍繞照片 / 當日的日記。可以是 user, 也可以是某角色寫 ta 今天的事',
          xPct: 53, yPct: 8, widthPct: 41, maxHeightPct: 36 },
        { id: 'C', slotRole: 'sticky-reaction', charBudget: [20, 55], eligibleAuthors: ['char'],
          hint: '看了照片 / 日記後的反應 (refersTo)',
          xPct: 6, yPct: 48, widthPct: 36, maxHeightPct: 18,
          rotate: -1.5, skinVariant: 'lavender' },
        { id: 'D', slotRole: 'sticky-reaction', charBudget: [20, 55], eligibleAuthors: ['char'],
          hint: '另一個反應',
          xPct: 48, yPct: 50, widthPct: 36, maxHeightPct: 18,
          rotate: 1.8, skinVariant: 'mint' },
        { id: 'E', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['user', 'char'],
          hint: '今日心情 + 評分',
          xPct: 6, yPct: 70, widthPct: 30, maxHeightPct: 14,
          skinVariant: 'rose' },
        { id: 'F', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['char'],
          hint: '某角色心情卡 (寫自己今天的)',
          xPct: 38, yPct: 70, widthPct: 30, maxHeightPct: 14,
          skinVariant: 'sky' },
        { id: 'G', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '邊角小字', xPct: 70, yPct: 70, widthPct: 24, maxHeightPct: 8, rotate: 2 },
        { id: 'H', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 6, yPct: 84, widthPct: 28, maxHeightPct: 7, rotate: -1.6 },
        { id: 'I', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 36, yPct: 84, widthPct: 28, maxHeightPct: 7, rotate: 1.4 },
        { id: 'J', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['char'],
          hint: '某角色一句小字獨白', xPct: 66, yPct: 84, widthPct: 28, maxHeightPct: 7, rotate: -2 },
    ]],
};

// ─── D · quiet-day · 安靜的一天 ────────────────────────────
const QUIET_DAY: LayoutTemplate = {
    id: 'quiet-day',
    name: '安靜的一天',
    suitFor: 'user 當天聊天少 / 想要角色們路過留筆的本子',
    paperStyle: 'grid',
    pages: [[
        { id: 'A', slotRole: 'hero-diary', charBudget: [40, 110], eligibleAuthors: ['user', 'char'],
          hint: '今天的一段記錄, 誰寫都行 (角色可以寫自己今天的事)',
          xPct: 8, yPct: 22, widthPct: 56, maxHeightPct: 30, isHero: true },
        { id: 'B', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['user', 'char'],
          hint: '今日心情 + 評分',
          xPct: 8, yPct: 6, widthPct: 56, maxHeightPct: 12,
          skinVariant: 'rose' },
        { id: 'C', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['char'],
          hint: '某角色心情卡 (寫自己的)',
          xPct: 68, yPct: 6, widthPct: 26, maxHeightPct: 12,
          skinVariant: 'lavender' },
        { id: 'D', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['char'],
          hint: '另一個角色心情卡', xPct: 68, yPct: 22, widthPct: 26, maxHeightPct: 12,
          skinVariant: 'sky' },
        { id: 'E', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '一句小字, 任何人', xPct: 60, yPct: 56, widthPct: 32, maxHeightPct: 8, rotate: -2 },
        { id: 'F', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 8, yPct: 56, widthPct: 30, maxHeightPct: 8, rotate: 1.6 },
        { id: 'G', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 8, yPct: 68, widthPct: 30, maxHeightPct: 8, rotate: -1.4 },
        { id: 'H', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 40, yPct: 68, widthPct: 28, maxHeightPct: 8, rotate: 2 },
        { id: 'I', slotRole: 'sticky-reaction', charBudget: [12, 40], eligibleAuthors: ['char'],
          hint: '反應別人寫的 (refersTo)',
          xPct: 56, yPct: 78, widthPct: 36, maxHeightPct: 14,
          rotate: 1.2, skinVariant: 'mint' },
        { id: 'J', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['char'],
          hint: '頁腳一句, 角色獨白', xPct: 8, yPct: 86, widthPct: 32, maxHeightPct: 8, rotate: -1.8 },
    ]],
};

// ─── E · ensemble-day · 群像熱鬧日 ─────────────────────────
const ENSEMBLE_DAY: LayoutTemplate = {
    id: 'ensemble-day',
    name: '群像熱鬧日',
    suitFor: '當天有 ≥ 3 個角色, 大家共寫',
    paperStyle: 'dot',
    pages: [[
        { id: 'A', slotRole: 'hero-diary', charBudget: [60, 140], eligibleAuthors: ['user', 'char'],
          hint: '今日主線日記, 第一人稱, 誰寫都行',
          xPct: 6, yPct: 8, widthPct: 54, maxHeightPct: 36, isHero: true },
        { id: 'B', slotRole: 'sticky-reaction', charBudget: [18, 50], eligibleAuthors: ['char'],
          hint: '反應已填某條 (refersTo)',
          xPct: 63, yPct: 8, widthPct: 32, maxHeightPct: 14,
          rotate: 1.8, skinVariant: 'lavender' },
        { id: 'C', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['user', 'char'],
          hint: '心情卡, 誰寫都行',
          xPct: 63, yPct: 24, widthPct: 32, maxHeightPct: 14,
          skinVariant: 'mint' },
        { id: 'D', slotRole: 'sticky-reaction', charBudget: [18, 50], eligibleAuthors: ['char'],
          hint: '另一條反應',
          xPct: 63, yPct: 40, widthPct: 32, maxHeightPct: 14,
          rotate: -1.4, skinVariant: 'rose' },
        { id: 'E', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['char'],
          hint: '某角色心情 (寫自己)', xPct: 63, yPct: 56, widthPct: 32, maxHeightPct: 12,
          skinVariant: 'sky' },
        { id: 'F', slotRole: 'gratitude', charBudget: [25, 70], eligibleAuthors: ['user'],
          hint: 'user 今日感恩 3 條 (≤22 字 / 條)',
          xPct: 6, yPct: 46, widthPct: 54, maxHeightPct: 18 },
        { id: 'G', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '邊角小字', xPct: 6, yPct: 66, widthPct: 26, maxHeightPct: 8, rotate: -1.5 },
        { id: 'H', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '另一句', xPct: 32, yPct: 66, widthPct: 26, maxHeightPct: 8, rotate: 1.6 },
        { id: 'I', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '另一句', xPct: 6, yPct: 76, widthPct: 26, maxHeightPct: 8, rotate: 2 },
        { id: 'J', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '另一句', xPct: 32, yPct: 76, widthPct: 26, maxHeightPct: 8, rotate: -1.8 },
        { id: 'K', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['user', 'char'],
          hint: '頁腳一句', xPct: 6, yPct: 86, widthPct: 28, maxHeightPct: 7, rotate: -2 },
        { id: 'L', slotRole: 'corner-note', charBudget: [6, 22], eligibleAuthors: ['char'],
          hint: '某角色頁腳一句獨白', xPct: 36, yPct: 86, widthPct: 28, maxHeightPct: 7, rotate: 1.6 },
    ]],
};

// ─── F · todo-focus · 待辦主導 ─────────────────────────────
const TODO_FOCUS: LayoutTemplate = {
    id: 'todo-focus',
    name: '待辦主導',
    suitFor: 'user 偏功能型記錄, 今天就是來打勾的',
    paperStyle: 'grid',
    pages: [[
        { id: 'A', slotRole: 'todo', charBudget: [50, 130], eligibleAuthors: ['user'],
          hint: 'user 今日待辦, 5~8 項, 每項 ≤ 16 字',
          xPct: 6, yPct: 8, widthPct: 56, maxHeightPct: 50, isHero: true },
        { id: 'B', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['user', 'char'],
          hint: '今日心情 + 評分',
          xPct: 65, yPct: 8, widthPct: 30, maxHeightPct: 14,
          skinVariant: 'lavender' },
        { id: 'C', slotRole: 'sticky-reaction', charBudget: [15, 45], eligibleAuthors: ['char'],
          hint: '看到 user 的 todo, 吐槽某一項 (refersTo)',
          xPct: 65, yPct: 24, widthPct: 30, maxHeightPct: 14,
          rotate: 1.6, skinVariant: 'mint' },
        { id: 'D', slotRole: 'sticky-reaction', charBudget: [15, 45], eligibleAuthors: ['char'],
          hint: '另一個角色 / 另一項 todo',
          xPct: 65, yPct: 40, widthPct: 30, maxHeightPct: 14,
          rotate: -1.2, skinVariant: 'rose' },
        { id: 'E', slotRole: 'mood-card', charBudget: [10, 30], eligibleAuthors: ['char'],
          hint: '某角色心情卡 (寫自己今天)',
          xPct: 65, yPct: 56, widthPct: 30, maxHeightPct: 12,
          skinVariant: 'sky' },
        { id: 'F', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '邊角一句獨白', xPct: 6, yPct: 60, widthPct: 28, maxHeightPct: 7, rotate: -2 },
        { id: 'G', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 34, yPct: 60, widthPct: 28, maxHeightPct: 7, rotate: 1.4 },
        { id: 'H', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 6, yPct: 70, widthPct: 28, maxHeightPct: 7, rotate: 2 },
        { id: 'I', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['user', 'char'],
          hint: '另一句小字', xPct: 34, yPct: 70, widthPct: 28, maxHeightPct: 7, rotate: -1.6 },
        { id: 'J', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['char'],
          hint: '某角色頁腳獨白 (寫自己)', xPct: 6, yPct: 86, widthPct: 32, maxHeightPct: 7, rotate: -1.8 },
        { id: 'K', slotRole: 'corner-note', charBudget: [6, 20], eligibleAuthors: ['char'],
          hint: '另一個角色一句獨白', xPct: 40, yPct: 86, widthPct: 28, maxHeightPct: 7, rotate: 1.6 },
    ]],
};

// ─── 模板表 ──────────────────────────────────────────────
export const LAYOUT_TEMPLATES: Record<string, LayoutTemplate> = {
    'plan-day': PLAN_DAY,
    'reflective-day': REFLECTIVE_DAY,
    'photo-day': PHOTO_DAY,
    'quiet-day': QUIET_DAY,
    'ensemble-day': ENSEMBLE_DAY,
    'todo-focus': TODO_FOCUS,
};

export const TEMPLATE_IDS = Object.keys(LAYOUT_TEMPLATES);

/**
 * 按當日條件選模板。
 *
 * 規則:
 *  - userMsgCount < 4               → quiet-day
 *  - userHasPhotoIntent === true    → photo-day
 *  - charCount >= 3                 → ensemble-day
 *  - userMsgCount >= 8              → reflective-day
 *  - 其它                            → plan-day
 *
 * todo-focus 不會被自動選 (user 主動挑)。
 */
export function pickTemplate(opts: {
    userMsgCount: number;
    charCount: number;
    userHasPhotoIntent?: boolean;
}): LayoutTemplate {
    if (opts.userHasPhotoIntent) return PHOTO_DAY;
    if (opts.userMsgCount < 4) return QUIET_DAY;
    if (opts.charCount >= 3) return ENSEMBLE_DAY;
    if (opts.userMsgCount >= 8) return REFLECTIVE_DAY;
    return PLAN_DAY;
}

export function getTemplate(id: string): LayoutTemplate | null {
    return LAYOUT_TEMPLATES[id] || null;
}
