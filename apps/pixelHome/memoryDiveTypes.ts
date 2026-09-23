/**
 * Memory Dive (記憶潛行) — 類型定義
 *
 * 交互式 RPG 探索模式：用戶在像素小屋中與角色一起探索記憶。
 * 退出后角色不記得發生過什麼，但用戶會獲得一個臨時 buff。
 */

import type { MemoryRoom } from '../../utils/memoryPalace/types';

// ─── 探索模式 ────────────────────────────────────────────

/** 角色引領 vs 自由探索 */
export type DiveMode = 'guided' | 'free';

/** 潛行階段 */
export type DivePhase = 'intro' | 'exploring' | 'dialogue' | 'outro';

// ─── 對話系統 ────────────────────────────────────────────

export interface DiveDialogue {
  id: string;
  speaker: 'character' | 'narrator' | 'user_choice';
  text: string;
  /** 用戶選項（僅 speaker === 'user_choice' 時有值） */
  choices?: DiveChoice[];
  /** 關聯的傢俱槽位 ID（觸發來源） */
  triggeredBy?: string;
  timestamp: number;
}

export interface DiveChoice {
  id: string;
  text: string;
  /** 選擇後對 buff 的影響 */
  buffEffect?: Partial<DiveBuffValues>;
  /** 標記特殊行為 */
  action?: 'comfort' | 'question' | 'observe' | 'leave' | 'unlock';
}

// ─── Buff 系統 ───────────────────────────────────────────

export interface DiveBuffValues {
  empathy: number;    // 共情 — 傾聽、安慰時累積
  trust: number;      // 信任 — 尊重角色意願、不強行查看
  insight: number;    // 洞察 — 提問、探索細節
  bond: number;       // 羈絆 — 一起回憶美好時刻
}

export type BuffType = keyof DiveBuffValues;

export interface DiveBuff {
  type: BuffType;
  label: string;
  value: number;
  icon: string;
  description: string;
}

export const BUFF_META: Record<BuffType, { label: string; icon: string; description: string }> = {
  empathy: { label: '共情', icon: '💗', description: '你認真傾聽了ta的記憶' },
  trust:   { label: '信任', icon: '🤝', description: '你尊重了ta的邊界' },
  insight: { label: '洞察', icon: '🔍', description: '你發現了隱藏的細節' },
  bond:    { label: '羈絆', icon: '✨', description: '你們一起重溫了珍貴的回憶' },
};

// ─── 房間探索狀態 ────────────────────────────────────────

export interface RoomExploreState {
  roomId: MemoryRoom;
  /** 該房間中已觸發對話的傢俱 */
  visitedSlots: Set<string>;
  /** 是否有"鎖住"的內容（閣樓等敏感房間） */
  hasLockedContent: boolean;
  /** 是否已解鎖 */
  unlocked: boolean;
}

// ─── 整體潛行會話 ────────────────────────────────────────

export interface DiveSession {
  charId: string;
  charName: string;
  mode: DiveMode;
  phase: DivePhase;
  currentRoom: MemoryRoom;
  /** 玩家在房間中的位置 (%) */
  playerPos: { x: number; y: number };
  /** 角色在房間中的位置 (%) */
  charPos: { x: number; y: number };
  /** 對話歷史 */
  dialogues: DiveDialogue[];
  /** 各房間探索狀態 */
  roomStates: Map<MemoryRoom, RoomExploreState>;
  /** 累積 buff 值 */
  buffValues: DiveBuffValues;
  /** 已訪問的房間列表 */
  visitedRooms: MemoryRoom[];
  /** 是否正在等待 LLM 回覆 */
  isLoading: boolean;
  startedAt: number;
}

// ─── LLM 請求/響應 ───────────────────────────────────────

export interface DiveLLMRequest {
  charId: string;
  charName: string;
  /** 映射的用戶名（用於 user_room 顯示「{用戶名}的房」） */
  userName?: string;
  room: MemoryRoom;
  slotId?: string;
  slotName?: string;
  slotCategory?: string;
  /** 從記憶宮殿檢索到的相關記憶 */
  memories: string[];
  /** 探索模式 */
  mode: DiveMode;
  /** 用戶的選擇（如果是回覆對話） */
  userChoice?: DiveChoice;
  /** 之前的對話上下文（最近5條） */
  recentDialogues: DiveDialogue[];
  /** 當前累積的 buff */
  currentBuffs: DiveBuffValues;
}

export interface DiveLLMResponse {
  /** 角色的對話/旁白 */
  dialogues: Array<{
    speaker: 'character' | 'narrator';
    text: string;
  }>;
  /** 給用戶的選項 */
  choices?: Array<{
    text: string;
    action: DiveChoice['action'];
    buffEffect?: Partial<DiveBuffValues>;
  }>;
  /** 角色是否抗拒（閣樓等） */
  isReluctant?: boolean;
  /** 引導模式下，角色建議去的下一個房間 */
  suggestNextRoom?: MemoryRoom;
}

// ─── 房間劇本（一次 LLM 預生成整房間的探訪） ──────────

/** 單個 beat 中的用戶選項 —— 每個選項都有獨立的角色反應 */
export interface DiveScriptChoice {
  id: string;
  /** 用戶的選項文本 */
  text: string;
  /** 行為類型：用於 buff 計算 */
  action?: DiveChoice['action'];
  /** 顯式 buff 影響 */
  buffEffect?: Partial<DiveBuffValues>;
  /** 選後角色的獨立回應（character 台詞；可多段用 \n\n 分隔） */
  reaction: string;
  /** 可選：這條反應之後額外的環境旁白（比如"燈光輕輕晃了一下"） */
  reactionNarrator?: string;
}

/** 房間劇本中的一段戲 */
export interface DiveBeat {
  /** 角色此刻說的一段話 */
  charLine: string;
  /** 可選：說話前的環境旁白 */
  narratorLine?: string;
  /** 3 個反應選項，每個都帶獨立回應 */
  choices: DiveScriptChoice[];
}

/** 一個房間從進場到離場的完整劇本 */
export interface RoomScript {
  /** 進房間的環境旁白（可選） */
  introNarrator?: string;
  /** 房間裡的幾段戲，默認 3 */
  beats: DiveBeat[];
  /** 離開房間的環境旁白（可選） */
  closingNarrator?: string;
  /** 可選：離開時浮現的一句話，作為記憶的餘味 */
  finalMoodHint?: string;
  /** LLM 建議的下一個房間 */
  nextRoom?: MemoryRoom;
}

// ─── 結算 ────────────────────────────────────────────────

export interface DiveResult {
  charId: string;
  mode: DiveMode;
  visitedRooms: MemoryRoom[];
  totalDialogues: number;
  buffs: DiveBuff[];
  /** 主要獲得的 buff 類型 */
  primaryBuff: BuffType;
  duration: number; // ms
  completedAt: number;
}
