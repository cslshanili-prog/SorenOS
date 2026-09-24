/**
 * 雲端數據清點與對帳。
 *
 * 要解決的是「用戶對雲端只有全清和不管兩檔」這件事。雲端那台 worker 上按角色堆著三類
 * 東西——定時任務行、client_state 裡的角色上下文（完整角色卡加最近 30 條對話原文，
 * 一個角色 32KB 起步）、以及 `char:<角色id>/<用途>` 那幾行 API 憑據。本地刪掉一個角色、
 * 導入一份別的備份、在另一台設備上清過一輪，雲端都可能留下再也沒人認領的那一份，
 * 而角色命名空間在 worker 側沒有 TTL、憑據行也從不過期。
 *
 * 這份模塊負責「看見」：把雲端能問出來的角色線索彙總，跟本地角色清單對一遍，分成
 * 「還在用的」和「孤兒」。動手清是 amsg2CharCleanup 的事，這邊只出結論。
 *
 * ── 兩條鐵律 ──
 *
 * 1. **只列，不自動清。** 孤兒的判據是「本地沒有這個角色」，而同一台 worker 可能被
 *    兩台設備共用——這台眼裡的孤兒正是另一台正在用的角色。清哪一條必須是用戶親手點的。
 * 2. **只在用戶點開時拉一次。** 命名空間清單那條要在 worker 上按用戶掃一遍 client_state，
 *    塞進體檢、塞進定時刷新就是每分鐘白掃一遍 D1（之前 rows read 被掃穿就是這麼來的）。
 *
 * ── 能問到什麼，取決於用戶那台 worker 多新 ──
 *
 * 角色身份在雲端只在兩個地方是明文：client_state 的命名空間（`amsg:char:<角色id>`）和
 * 憑據行的 cred_id。任務表裡它埋在密文裡，只能把任務全量拉回來逐條解密才看得見。
 * 而「列出所有命名空間」要 worker 更新到 amsg-server 帶 `client-state-namespaces` 的
 * 那一版；沒有它的時候，只配過 API 或只排過任務的角色照樣能被認出來，唯獨「只在雲端
 * 留了上下文、既沒任務也沒憑據」的那種看不到——所以清單會如實標明這一點，而不是假裝
 * 自己是全集。
 */

import type { CharacterProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { AMSG_INSTANT_CHAT_SUBTYPE, AMSG_STATE_NAMESPACE_PREFIX } from './amsgFirePack';
import { parseCharCredId, type LlmCredentialPurpose } from './amsgLlmCredentials';

/** 雲端某個角色名下的佔用。 */
export interface CloudCharEntry {
  charId: string;
  /** 本地還認得這個角色嗎。null = 孤兒（本地已經沒有了）。 */
  local: { name: string; avatar?: string } | null;
  /** 定時任務條數（即時對話那種當場用完的行不算）。 */
  taskCount: number;
  /** 正在進行的即時對話行數，單獨數——它不是殘留，是用戶此刻正等著的一輪迴復。 */
  instantCount: number;
  /** 雲端登記著的憑據用途。 */
  credPurposes: LlmCredentialPurpose[];
  /** 角色上下文的佔用；worker 還給不出命名空間清單時是 null（= 問不到，不是沒有）。 */
  state: CloudNamespaceUsage | null;
}

export interface CloudNamespaceUsage {
  entryCount: number;
  /** 存儲字節數（值是加密後落庫的，比原文大一截）。 */
  byteSize: number;
  updatedAt: number | null;
}

/** 不屬於任何角色的那些。 */
export interface CloudGlobalEntry {
  /** 全局工具配置、實時世界緩存所在的命名空間。 */
  namespace: string;
  usage: CloudNamespaceUsage;
}

export interface CloudInventory {
  /** 本地還在的角色，按佔用從大到小。 */
  live: CloudCharEntry[];
  /** 本地已經沒有的角色。 */
  orphans: CloudCharEntry[];
  /** 全局命名空間（工具配置 / 實時世界緩存 / 後台活兒的一次性輸入）。 */
  globals: CloudGlobalEntry[];
  /** 哪幾條線索沒問到，界面照它說明「這份清單看得見什麼、看不見什麼」。 */
  gaps: CloudInventoryGap[];
}

export type CloudInventoryGap =
  /** 任務清單讀不出來（多半是換過主密鑰，舊密文解不開）。 */
  | { kind: 'tasks'; message: string }
  /** 憑據清單讀不出來（老 worker 上沒有這張表）。 */
  | { kind: 'credentials'; message: string }
  /**
   * worker 給不出命名空間清單。這條最要緊：沒有它，「只在雲端留了上下文、既沒任務
   * 也沒憑據」的角色根本不會出現在清單裡，用戶看到的不是全集。
   */
  | { kind: 'namespaces'; message: string };

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 把雲端問出來的線索彙總成一份清單。
 *
 * 三條線索各問各的，一條斷了不拖累另外兩條——換過主密鑰之後任務清單必然最先炸，而那
 * 正是最需要看見雲端還剩什麼的時候。
 */
export const collectCloudInventory = async (
  localChars: CharacterProfile[],
): Promise<CloudInventory> => {
  const byId = new Map<string, CloudCharEntry>();
  const gaps: CloudInventoryGap[] = [];

  const entryFor = (charId: string): CloudCharEntry => {
    let entry = byId.get(charId);
    if (!entry) {
      entry = { charId, local: null, taskCount: 0, instantCount: 0, credPurposes: [], state: null };
      byId.set(charId, entry);
    }
    return entry;
  };

  // ① 任務表：角色 id 是解密之後投影出來的，老 worker 不給這個字段。
  try {
    const tasks = await ActiveMsgClient.listAllTasks();
    for (const task of tasks) {
      const charId = typeof task?.charId === 'string' ? task.charId : '';
      if (!charId) continue;
      const entry = entryFor(charId);
      if (task?.messageSubtype === AMSG_INSTANT_CHAT_SUBTYPE) entry.instantCount += 1;
      else entry.taskCount += 1;
    }
  } catch (error) {
    gaps.push({ kind: 'tasks', message: describeError(error) });
  }

  // ② 憑據清單：credId 裡編著角色 id，只配過 API、沒排過任務的角色只能從這兒認出來。
  try {
    for (const { credId } of await ActiveMsgClient.listLlmCredentials()) {
      const parsed = parseCharCredId(credId);
      if (!parsed) continue;
      const entry = entryFor(parsed.charId);
      if (!entry.credPurposes.includes(parsed.purpose)) entry.credPurposes.push(parsed.purpose);
    }
  } catch (error) {
    gaps.push({ kind: 'credentials', message: describeError(error) });
  }

  // ③ 命名空間清單：唯一能發現「只留了上下文」那種角色的線索，要新 worker 才有。
  const globals: CloudGlobalEntry[] = [];
  try {
    const namespaces = await ActiveMsgClient.listCloudNamespaces();
    for (const row of namespaces) {
      const charId = parseCharNamespace(row.namespace);
      if (charId) {
        entryFor(charId).state = { entryCount: row.entryCount, byteSize: row.byteSize, updatedAt: row.updatedAt };
      } else {
        globals.push({ namespace: row.namespace, usage: row });
      }
    }
  } catch (error) {
    gaps.push({ kind: 'namespaces', message: describeError(error) });
  }

  const localById = new Map(localChars.map((char) => [char.id, char]));
  for (const entry of byId.values()) {
    const char = localById.get(entry.charId);
    if (char) entry.local = { name: char.name, avatar: char.avatar };
  }

  const all = [...byId.values()].sort(compareByWeight);
  return {
    live: all.filter((entry) => entry.local),
    orphans: all.filter((entry) => !entry.local),
    globals: globals.sort((a, b) => b.usage.byteSize - a.usage.byteSize),
    gaps,
  };
};

/** 佔用大的排前面；問不到大小時退回按任務數，再退回按角色 id 排，保證順序穩定。 */
const compareByWeight = (a: CloudCharEntry, b: CloudCharEntry): number => {
  const size = (b.state?.byteSize ?? 0) - (a.state?.byteSize ?? 0);
  if (size !== 0) return size;
  const tasks = b.taskCount - a.taskCount;
  if (tasks !== 0) return tasks;
  return a.charId.localeCompare(b.charId);
};

/** `amsg:char:<角色id>` → 角色 id；不是角色命名空間就回 null。 */
export const parseCharNamespace = (namespace: string): string | null => {
  if (!namespace?.startsWith(AMSG_STATE_NAMESPACE_PREFIX)) return null;
  return namespace.slice(AMSG_STATE_NAMESPACE_PREFIX.length) || null;
};

/** 這一條在雲端到底佔了多少東西——界面拿它決定「空的」還是「有貨」。 */
export const isEmptyEntry = (entry: CloudCharEntry): boolean =>
  entry.taskCount === 0
  && entry.instantCount === 0
  && entry.credPurposes.length === 0
  && (entry.state?.entryCount ?? 0) === 0;

/** 把字節數說成人話。雲端存的是密文，所以這個數比聊天原文大一截。 */
export const formatCloudSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
