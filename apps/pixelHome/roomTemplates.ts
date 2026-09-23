/**
 * Pixel Home — 7個房間的固定槽位定義
 *
 * 每個房間5個傢俱槽位，映射到記憶宮殿的認知功能。
 * 槽位數量和分類固定，但位置可由用戶/角色調整。
 */

import type { RoomSlotDef } from './types';
import type { MemoryRoom } from '../../utils/memoryPalace/types';

export const ROOM_SLOTS: Record<MemoryRoom, RoomSlotDef[]> = {
  // ─── 客廳 → hippocampus，日常閒聊 ─────────────────
  living_room: [
    { id: 'sofa',         name: '沙發',   category: '近期話題',   required: true,  defaultX: 25, defaultY: 60, defaultScale: 1.4 },
    { id: 'tv',           name: '電視',   category: '共享體驗',   required: false, defaultX: 75, defaultY: 35, defaultScale: 1.2 },
    { id: 'coffee_table', name: '茶几',   category: '碎片記憶',   required: false, defaultX: 40, defaultY: 65, defaultScale: 1.0 },
    { id: 'rug',          name: '地毯',   category: '氛圍基調',   required: false, defaultX: 50, defaultY: 75, defaultScale: 1.6 },
    { id: 'clock',        name: '掛鐘',   category: '時間感知',   required: false, defaultX: 85, defaultY: 25, defaultScale: 0.8 },
  ],

  // ─── 臥室 → neocortex，親密情感 ───────────────────
  bedroom: [
    { id: 'bed',        name: '床',     category: '核心記憶容器', required: true,  defaultX: 60, defaultY: 55, defaultScale: 1.8 },
    { id: 'nightstand', name: '床頭櫃', category: '重要事件',     required: false, defaultX: 85, defaultY: 55, defaultScale: 0.9 },
    { id: 'lamp',       name: '檯燈',   category: '情緒強度',     required: false, defaultX: 88, defaultY: 45, defaultScale: 0.7 },
    { id: 'curtain',    name: '窗簾',   category: '隱私層',       required: false, defaultX: 15, defaultY: 25, defaultScale: 1.5 },
    { id: 'frame',      name: '相框',   category: '關鍵關係片段', required: false, defaultX: 35, defaultY: 25, defaultScale: 0.8 },
  ],

  // ─── 書房 → prefrontal cortex，工作/技能 ──────────
  study: [
    { id: 'desk',       name: '書桌',   category: '當前任務',   required: true,  defaultX: 50, defaultY: 55, defaultScale: 1.4 },
    { id: 'bookshelf',  name: '書架',   category: '知識積累',   required: false, defaultX: 15, defaultY: 35, defaultScale: 1.6 },
    { id: 'whiteboard', name: '白板',   category: '計劃推理',   required: false, defaultX: 80, defaultY: 30, defaultScale: 1.3 },
    { id: 'pen_holder', name: '筆筒',   category: '工具技能',   required: false, defaultX: 55, defaultY: 48, defaultScale: 0.6 },
    { id: 'globe',      name: '地球儀', category: '興趣探索',   required: false, defaultX: 85, defaultY: 60, defaultScale: 0.9 },
  ],

  // ─── 閣樓 → amygdala，未消化創傷 ─────────────────
  attic: [
    { id: 'chest',     name: '舊箱子',   category: '封存記憶',   required: true,  defaultX: 30, defaultY: 60, defaultScale: 1.3 },
    { id: 'cobweb',    name: '蛛網',     category: '遺忘程度',   required: false, defaultX: 15, defaultY: 20, defaultScale: 1.0 },
    { id: 'mirror',    name: '落灰鏡子', category: '自我審視',   required: false, defaultX: 75, defaultY: 35, defaultScale: 1.2 },
    { id: 'window',    name: '天窗',     category: '希望縫隙',   required: false, defaultX: 50, defaultY: 15, defaultScale: 1.4 },
    { id: 'music_box', name: '八音盒',   category: '觸發片段',   required: false, defaultX: 65, defaultY: 65, defaultScale: 0.7 },
  ],

  // ─── 個人房間 → default mode network，身份 ────────
  self_room: [
    { id: 'vanity',   name: '梳妝檯', category: '自我形象',   required: true,  defaultX: 25, defaultY: 50, defaultScale: 1.3 },
    { id: 'diary',    name: '日記本', category: '內心獨白',   required: false, defaultX: 50, defaultY: 60, defaultScale: 0.8 },
    { id: 'trophy',   name: '獎盃架', category: '成就感',     required: false, defaultX: 80, defaultY: 40, defaultScale: 1.1 },
    { id: 'poster',   name: '海報',   category: '價值觀',     required: false, defaultX: 15, defaultY: 25, defaultScale: 1.4 },
    { id: 'pet_bed',  name: '寵物窩', category: '情感寄託',   required: false, defaultX: 70, defaultY: 70, defaultScale: 0.9 },
  ],

  // ─── 用戶房 → TPJ，用戶信息 ───────────────────────
  user_room: [
    { id: 'guest_bed',  name: '客床',   category: '用戶印象',   required: true,  defaultX: 55, defaultY: 55, defaultScale: 1.6 },
    { id: 'photo_wall', name: '照片牆', category: '共同回憶',   required: false, defaultX: 20, defaultY: 25, defaultScale: 1.5 },
    { id: 'gift_shelf', name: '禮物架', category: '互贈物品',   required: false, defaultX: 80, defaultY: 35, defaultScale: 1.2 },
    { id: 'letter_box', name: '信箱',   category: '重要對話',   required: false, defaultX: 85, defaultY: 60, defaultScale: 0.8 },
    { id: 'welcome_mat',name: '門墊',   category: '關係溫度',   required: false, defaultX: 50, defaultY: 85, defaultScale: 1.0 },
  ],

  // ─── 窗台/露台 → dopamine，期盼 ──────────────────
  windowsill: [
    { id: 'flower_pot', name: '花盆',   category: '成長中的期盼', required: true,  defaultX: 30, defaultY: 55, defaultScale: 0.9 },
    { id: 'wind_chime', name: '風鈴',   category: '實現的願望',   required: false, defaultX: 50, defaultY: 20, defaultScale: 0.8 },
    { id: 'telescope',  name: '望遠鏡', category: '遠期目標',     required: false, defaultX: 75, defaultY: 45, defaultScale: 1.2 },
    { id: 'seed_box',   name: '種子盒', category: '新萌芽',       required: false, defaultX: 20, defaultY: 65, defaultScale: 0.7 },
    { id: 'lantern',    name: '燈籠',   category: '錨定心願',     required: false, defaultX: 85, defaultY: 30, defaultScale: 0.9 },
  ],
};

// ─── 房間元信息 ─────────────────────────────────────

export const ROOM_META: Record<MemoryRoom, { name: string; emoji: string; color: string; description: string }> = {
  living_room: { name: '客廳',     emoji: '🛋️', color: '#f59e0b', description: '日常閒聊與近期記憶' },
  bedroom:     { name: '臥室',     emoji: '🛏️', color: '#8b5cf6', description: '親密情感與核心記憶' },
  study:       { name: '書房',     emoji: '📚', color: '#3b82f6', description: '知識積累與技能成長' },
  attic:       { name: '閣樓',     emoji: '🕸️', color: '#6b7280', description: '未消化的困惑與創傷' },
  self_room:   { name: '個人房間', emoji: '🪞', color: '#ec4899', description: '自我認同與身份探索' },
  user_room:   { name: '用戶房',   emoji: '🎁', color: '#10b981', description: '關於你的一切記憶' },
  windowsill:  { name: '露台',     emoji: '🌱', color: '#06b6d4', description: '期盼、願望與未來' },
};

/**
 * 房間顯示名。user_room 在有用戶名時顯示為「{用戶名}的房」，其餘房間返回靜態名。
 * 單一來源，供地圖 / 編輯器 / 潛行模式 / dive prompt 統一調用。
 */
export function roomDisplayName(room: MemoryRoom, userName?: string): string {
  if (room === 'user_room' && userName) return `${userName}的房`;
  return ROOM_META[room].name;
}

// ─── 默認牆壁/地板顏色 ─────────────────────────────

export const DEFAULT_ROOM_COLORS: Record<MemoryRoom, { wall: string; floor: string }> = {
  living_room: { wall: '#fef3c7', floor: '#d6b88a' },
  bedroom:     { wall: '#ede9fe', floor: '#c4b5a0' },
  study:       { wall: '#dbeafe', floor: '#8b7355' },
  attic:       { wall: '#4b5563', floor: '#374151' },
  self_room:   { wall: '#fce7f3', floor: '#d4a8c0' },
  user_room:   { wall: '#d1fae5', floor: '#a8c4b0' },
  windowsill:  { wall: '#cffafe', floor: '#92a89c' },
};

// ─── 所有房間 ID 列表（保持渲染順序）─────────────

export const ALL_ROOMS: MemoryRoom[] = [
  'living_room', 'bedroom', 'study', 'attic', 'self_room', 'user_room', 'windowsill',
];

// ─── 房間尺寸（格子數，俯瞰圖+編輯器共用）─────────

export const ROOM_SIZES: Record<MemoryRoom, { w: number; h: number }> = {
  attic:       { w: 4, h: 4 },
  bedroom:     { w: 5, h: 5 },
  study:       { w: 5, h: 5 },
  living_room: { w: 10, h: 6 },
  self_room:   { w: 5, h: 4 },
  user_room:   { w: 5, h: 4 },
  windowsill:  { w: 10, h: 3 },
};
