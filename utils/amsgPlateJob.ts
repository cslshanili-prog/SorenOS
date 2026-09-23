/**
 * 門牌整理上雲的契約（環境無關葉子模塊）
 *
 * 「整理門牌」這件事拆成三段跑在兩個地方：客戶端把材料裝成一份 job 傳上去，用戶自己的
 * CF Worker 到點拼提示詞、調 LLM、把整理結果送回來，客戶端再合併落庫。這份文件是兩邊
 * 共用的那張契約——job 長什麼樣、結果長什麼樣、放在雲端哪個抽屜裡、任務怎麼被認出來。
 *
 * 為什麼值得上雲：整理一次要跑一兩分鐘，而它總是在一輪對話剛結束、用戶正準備切走的時候
 * 開始。放本地的話頁面一關就斷了；交給雲端之後，請求發出去那一刻客戶端就自由了。
 *
 * 往這裡加代碼前先確認：不 import 任何帶瀏覽器依賴的模塊（db / safeApi / context 等）。
 * `pnpm build:workers` 會把這份打進 amsg worker bundle，帶進瀏覽器依賴會在構建期直接暴露。
 */

import type { PlateRoom } from './memoryPalace/types';
import { PLATE_ROOMS } from './memoryPalace/types';
import type { PlateLLMItem, PlateMaterial } from './memoryPalace/roomPlateCore';
import { PLATE_USER_TURN, buildPlateConsolidationPrompt } from './memoryPalace/roomPlateCore';

// ─── 這一種任務的名字 ─────────────────────────────────

/** 任務的業務種類（寫在 metadata 的 amsgKind 上，見 amsgTaskKinds.ts）。 */
export const PLATE_CONSOLIDATE_KIND = 'plate-consolidate';

/** 結果的名字（`emitResult` 的 resultKind），客戶端按它分流。 */
export const PLATE_CONSOLIDATE_RESULT_KIND = 'plate-consolidate';

/** job 輸入在 `amsg:job` 命名空間裡的 key。 */
export const plateJobKey = (jobId: string): string => `plate:${jobId}`;

// ─── job 輸入（客戶端寫、worker 讀） ──────────────────

/** 一個房間的現狀：條目正文按標籤順序排，id 與之一一對應。 */
export interface PlateJobRoom {
  room: PlateRoom;
  /** 現有條目的正文，順序即標籤順序（第 i 條 = 前綴 + i） */
  entries: string[];
  /**
   * 與 entries 一一對應的條目 id。
   *
   * 結果回來時要靠它把 `basedOn` 標籤重新對準：提示詞是拿提交那一刻的快照拼的，
   * LLM 說的 `U0` 是**快照裡的第 0 條**，而結果可能幾分鐘後才回來，這中間門牌
   * 說不定已經被別的路徑動過。帶上 id，回來才認得出「當時那條現在排第幾」。
   */
  entryIds: string[];
}

export interface PlateJobInput {
  v: 1;
  charId: string;
  charName: string;
  userName: string;
  /** ContextBuilder.buildCoreContext 的產出；拿不到就是空串，提示詞裡仍有名字與身份確認段 */
  identityContext: string;
  rooms: PlateJobRoom[];
  materials: PlateMaterial[];
}

/** 組一份 job 輸入（版本號只有這一處寫，別在調用點手抄）。 */
export function buildPlateJobInput(args: Omit<PlateJobInput, 'v'>): PlateJobInput {
  return { v: 1, ...args };
}

const isPlateRoomValue = (v: unknown): v is PlateRoom => (PLATE_ROOMS as readonly string[]).includes(v as string);

const asStringArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

/**
 * 讀回 job 輸入。形狀對不上一律返回 null——worker 那邊據此硬失敗，
 * 而不是拿半份材料整理出一份缺東西的門牌（用戶完全看不出這是壞了還是角色就這樣）。
 */
export function parsePlateJobInput(raw: unknown): PlateJobInput | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.charId !== 'string' || !o.charId) return null;
  if (typeof o.charName !== 'string' || typeof o.userName !== 'string') return null;
  if (typeof o.identityContext !== 'string') return null;
  if (!Array.isArray(o.rooms) || !Array.isArray(o.materials)) return null;

  const rooms: PlateJobRoom[] = [];
  for (const r of o.rooms) {
    if (!r || typeof r !== 'object') return null;
    const row = r as Record<string, unknown>;
    const entries = asStringArray(row.entries);
    const entryIds = asStringArray(row.entryIds);
    if (!isPlateRoomValue(row.room) || !entries || !entryIds) return null;
    if (entries.length !== entryIds.length) return null;
    rooms.push({ room: row.room, entries, entryIds });
  }

  const materials: PlateMaterial[] = [];
  for (const m of o.materials) {
    if (!m || typeof m !== 'object') return null;
    const row = m as Record<string, unknown>;
    const lines = asStringArray(row.lines);
    if (!isPlateRoomValue(row.room) || !lines) return null;
    materials.push({ room: row.room, lines });
  }

  return {
    v: 1,
    charId: o.charId,
    charName: o.charName,
    userName: o.userName,
    identityContext: o.identityContext,
    rooms,
    materials,
  };
}

/** 把 job 拼成這次 fire 要發給 LLM 的兩條消息。提示詞與瀏覽器那條路一字不差。 */
export function buildPlateJobMessages(job: PlateJobInput): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: buildPlateConsolidationPrompt({
        charName: job.charName,
        userName: job.userName,
        identityContext: job.identityContext,
        plates: job.rooms.map((r) => ({ room: r.room, entries: r.entries })),
        materials: job.materials,
      }),
    },
    { role: 'user', content: PLATE_USER_TURN },
  ];
}

// ─── 結果（worker 寫、客戶端讀） ──────────────────────

export interface PlateConsolidateResult {
  resultKind: typeof PLATE_CONSOLIDATE_RESULT_KIND;
  v: 1;
  jobId: string;
  charId: string;
  /** LLM 給出的完整新條目列表（未合併，合併語義留在客戶端） */
  items: PlateLLMItem[];
  /**
   * 提交時每個房間的條目 id 快照，原樣回傳。
   *
   * 客戶端拿它把 `basedOn` 標籤重新對準當前條目——這份對照表跟著結果走，客戶端就
   * 不用為每個在飛的 job 在本地留一份待辦（頁面關掉再打開也不會丟）。
   */
  rooms: Array<{ room: PlateRoom; entryIds: string[] }>;
}

/** 組一條結果。形狀由宿主定，`resultKind` 是上游唯一的硬要求。 */
export function buildPlateConsolidateResult(args: {
  jobId: string;
  charId: string;
  items: PlateLLMItem[];
  rooms: PlateJobRoom[];
}): PlateConsolidateResult {
  return {
    resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
    v: 1,
    jobId: args.jobId,
    charId: args.charId,
    items: args.items,
    rooms: args.rooms.map((r) => ({ room: r.room, entryIds: r.entryIds })),
  };
}

/** 讀回一條結果；形狀對不上返回 null（客戶端據此銷帳丟棄並留日誌，不上屏）。 */
export function parsePlateConsolidateResult(raw: unknown): PlateConsolidateResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.resultKind !== PLATE_CONSOLIDATE_RESULT_KIND || o.v !== 1) return null;
  if (typeof o.jobId !== 'string' || typeof o.charId !== 'string' || !o.charId) return null;
  if (!Array.isArray(o.items) || !Array.isArray(o.rooms)) return null;

  const rooms: Array<{ room: PlateRoom; entryIds: string[] }> = [];
  for (const r of o.rooms) {
    if (!r || typeof r !== 'object') return null;
    const row = r as Record<string, unknown>;
    const entryIds = asStringArray(row.entryIds);
    if (!isPlateRoomValue(row.room) || !entryIds) return null;
    rooms.push({ room: row.room, entryIds });
  }

  const items = o.items.filter(
    (i): i is PlateLLMItem => !!i && typeof i === 'object' && typeof (i as PlateLLMItem).text === 'string',
  );

  return { resultKind: PLATE_CONSOLIDATE_RESULT_KIND, v: 1, jobId: o.jobId, charId: o.charId, items, rooms };
}
