/**
 * Tracker 內置模板 + 首次啟動種子
 *
 * 設計:
 * - 系統提供 6 個常用模板,user 可以"啟用"它們(創建一份屬於自己的副本)
 * - 第一次進 Tracker 區會自動種"心情"作為示範,其他模板待 user 主動啟用
 * - 啟用 = 把模板複製成 Tracker 寫進 DB,從此跟系統模板解耦(user 可隨意改字段)
 */

import { Tracker, TrackerField } from '../types';
import { DB } from './db';

// ─── 字段模板輔助 ────────────────────────────────
const f = (
    key: string,
    label: string,
    kind: TrackerField['kind'],
    extra: Partial<TrackerField> = {},
): TrackerField => ({ key, label, kind, ...extra });

// ─── 6 個內置 Tracker 模板 ─────────────────────────
export interface TrackerTemplate {
    /** 用作種子 id 的前綴 */
    templateId: string;
    name: string;
    icon: string;
    color: string;
    schema: TrackerField[];
    cellRenderField: string;
    blurb: string;          // 一句話介紹,創建面板裡展示
}

export const TRACKER_TEMPLATES: TrackerTemplate[] = [
    {
        templateId: 'mood',
        name: '心情',
        icon: '🌸',
        color: '#fbb8c8',
        cellRenderField: 'rating',
        blurb: '今天的心情打幾分,順手記一句',
        schema: [
            f('rating', '心情', 'rating', {
                required: true, min: 1, max: 5,
                choices: [
                    { value: '1', label: '很糟', emoji: '😣' },
                    { value: '2', label: '低落', emoji: '😔' },
                    { value: '3', label: '一般', emoji: '😐' },
                    { value: '4', label: '不錯', emoji: '🙂' },
                    { value: '5', label: '很好', emoji: '😊' },
                ],
            }),
            f('note', '一句話', 'text', { placeholder: '今天的關鍵詞……' }),
        ],
    },
    {
        templateId: 'cycle',
        name: '經期',
        icon: '🌷',
        color: '#f29db0',
        cellRenderField: 'flow',
        blurb: '記錄開始/結束 + 流量,自動算週期',
        schema: [
            f('flow', '流量', 'options', {
                required: true,
                choices: [
                    { value: 'start',  label: '開始',  emoji: '🌷' },
                    { value: 'heavy',  label: '量多',  emoji: '🌹' },
                    { value: 'medium', label: '中等',  emoji: '🌸' },
                    { value: 'light',  label: '量少',  emoji: '🌼' },
                    { value: 'end',    label: '結束',  emoji: '🍃' },
                ],
            }),
            f('cramp', '不舒服?', 'boolean'),
            f('note', '備註', 'text'),
        ],
    },
    {
        templateId: 'food',
        name: '今日飲食',
        icon: '🍰',
        color: '#f5e295',
        cellRenderField: 'meal',
        blurb: '隨手拍 + 一句話,不計算熱量',
        schema: [
            f('photo', '照片', 'photo'),
            f('meal', '吃了啥', 'text', { required: true, placeholder: '一句話就好' }),
        ],
    },
    {
        templateId: 'water',
        name: '喝水',
        icon: '💧',
        color: '#b9d3e0',
        cellRenderField: 'cups',
        blurb: '今天喝了幾杯水',
        schema: [
            f('cups', '杯數', 'number', { required: true, unit: '杯', min: 0, max: 20 }),
        ],
    },
    {
        templateId: 'weight',
        name: '體重',
        icon: '🪶',
        color: '#bfe1cf',
        cellRenderField: 'kg',
        blurb: '記一下今天的數字,後續畫折線',
        schema: [
            f('kg', '體重', 'number', { required: true, unit: 'kg', min: 0, max: 999 }),
            f('note', '備註', 'text', { placeholder: '一句話說說?' }),
        ],
    },
    {
        templateId: 'symptom',
        name: '今天有沒有不舒服',
        icon: '🤒',
        color: '#d6c8e8',
        cellRenderField: 'has',
        blurb: '通用症狀打卡,可改名換字段',
        schema: [
            f('has', '有不舒服?', 'boolean', { required: true }),
            f('what', '哪裡', 'text', { placeholder: '頭痛 / 肚子痛 / ……' }),
            f('severity', '嚴重程度', 'rating', {
                min: 1, max: 5,
                choices: [
                    { value: '1', label: '輕', emoji: '·' },
                    { value: '2', label: '小', emoji: '◦' },
                    { value: '3', label: '中', emoji: '◐' },
                    { value: '4', label: '重', emoji: '●' },
                    { value: '5', label: '劇烈', emoji: '⚡' },
                ],
            }),
        ],
    },
];

// 把模板實例化成一個具體 Tracker(寫進 DB 的形態)
export function instantiateTemplate(tpl: TrackerTemplate, sortOrder: number = 0): Tracker {
    const now = Date.now();
    return {
        id: `tracker-${tpl.templateId}-${now}`,
        name: tpl.name,
        icon: tpl.icon,
        color: tpl.color,
        schema: tpl.schema,
        cellRenderField: tpl.cellRenderField,
        isBuiltin: true,
        sortOrder,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * 首次進 Tracker 區時調用:
 * - 如果 DB 裡完全沒有 tracker → 種一個"心情"作為示範
 * - 已經有任何 tracker → 不動(尊重用戶已有數據,即便 ta 已經把心情刪了)
 */
export async function ensureSeedTrackers(): Promise<void> {
    const all = await DB.getAllTrackers();
    if (all.length > 0) return;
    const moodTpl = TRACKER_TEMPLATES.find(t => t.templateId === 'mood')!;
    await DB.saveTracker(instantiateTemplate(moodTpl, 0));
}
