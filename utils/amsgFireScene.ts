/**
 * 主動消息「此刻在做什麼」的到點渲染（AMSG_SLOT_SCENE）。
 *
 * 為什麼要有這一層：fire_pack 是最後一次聊天時打好的模板，到點才渲染。角色的日程
 * 「當前時段」和由日程推出來的「此刻在聽的歌」都是打包那一刻算的，烤進模板的話，
 * 凌晨三點觸發時角色會說「我在健身房呢，今天多跑了兩公里」。這兩塊改成隨包帶原始數據
 * （整天的作息表 + 歌單抽樣池），worker 到點按角色時區現算。
 *
 * 一份表只管一天：隨包還帶打包那天的日期（dateKey），到點先比日期，跨天了整段不用——
 * 拿週五的作息表照著週日念，跟烤死是同一種穿幫。
 *
 * 零瀏覽器依賴：只 import type 和兩個純葉子（scheduleInjection / charMusicSchedule /
 * timezone / localDate）。日程文本與前台聊天共用 buildScheduleInjection，歌與前台聊天
 * 共用 pickSongFromPool —— 不共用的話，角色在聊天裡和到點生成時會說出兩套作息。
 *
 * 前台聊天的音樂塊比這裡豐富（一起聽狀態、歌詞片段、換歌察覺，見
 * ContextBuilder.buildMusicAtmosphere）。那些要麼依賴用戶此刻的播放狀態、要麼要拉網絡，
 * worker 都夠不著，所以 fire 這邊只渲染「你此刻在聽什麼」這一句。
 */

/** 抽歌只用到這三個字段；專輯封面之類不隨包上雲。 */
export interface AmsgFireSong {
  id: number;
  name: string;
  artists: string;
}
import { getLocalDateKey } from './localDate';
import { nowInTimeZone } from './timezone';
import { buildScheduleInjection, resolveScheduleSlots, type RenderableSchedule } from './scheduleInjection';
import { pickSongFromPool, slotIsListening } from './charMusicSchedule';
import type { AmsgTzRef } from './amsgFirePack';

/** 隨 fire_pack 帶給 worker 的原始素材。到點渲染成 AMSG_SLOT_SCENE 那一段。 */
export interface AmsgFireScene {
  /** 角色 id —— 抽歌的種子之一，換個角色同一時段聽的歌不一樣。 */
  charId: string;
  /**
   * 這份日程說的是哪一天（打包時角色當地的 YYYY-MM-DD）。
   *
   * 表裡只有「幾點做什麼」，沒有日期。週五晚上打的包週日上午觸發時，光按牆鍾時分挑
   * 時段一樣挑得出「09:00 晨會」——角色於是在週日說自己正在開週五的會。到點先比日期，
   * 不是同一天就整段不用（見 renderFireSceneBlock）。
   */
  dateKey: string;
  /**
   * 打包時那天的日程；到點由 worker 按角色時區挑出當前時段。
   *
   * 只帶渲染會讀的字段（見 RenderableSchedule）——整份 DailySchedule 裡掛著每個時段
   * 緩存的小劇場台詞和 coverImage（可能是 base64 圖），隨包上雲純屬白佔體積。
   */
  schedule: RenderableSchedule | null;
  /**
   * 意識流獨白。日程自帶的 flowNarrative 按小時分三檔、到點現取，
   * 這個字段是聊天時演化出來的那一份（進化獨白），有的話優先。
   */
  evolvedNarrative?: string;
  /** 歌單抽樣池（charMusicSchedule.buildSongPool 的結果，最多 20 首）。 */
  songPool: AmsgFireSong[];
}

/**
 * 這次觸發角色「此刻在聽」的是哪一首（不在聽歌的時段 / 歌單空 / 跨天作廢 → null）。
 *
 * 單獨 export 是給 worker 用的：prompt 裡那句「你此刻在聽：《X》」是這裡挑的，可角色
 * 寫出來的 `[[MUSIC_ACTION:add|歌單標題]]` 標籤只帶得動歌單名、帶不動歌名。worker 到點
 * 把這一首附進 music_action directive，客戶端重放時才知道角色說的是哪首歌——不然只能取
 * 「用戶此刻在聽的那首」，而定時消息補收時用戶多半什麼都沒在放，卡片和加歌單整個不發生。
 *
 * 判定與種子跟 renderFireSceneBlock 共用這一份：prompt 裡寫的那首和 directive 裡凍的
 * 那首必須嚴格是同一首，各寫一份遲早對不上。
 */
export const resolveFireSceneSong = (
  scene: AmsgFireScene | null,
  nowMs: number,
  tz: AmsgTzRef,
): AmsgFireSong | null => {
  if (!scene?.schedule?.slots?.length) return null;
  const wallNow = nowInTimeZone(tz.tzId, new Date(nowMs));
  // 跨天的包整段作廢，「此刻在聽」跟著走：那首歌是從當前時段推出來的，日程都不算數了，
  // 它就沒有依據了（同 renderFireSceneBlock 的日期門檻）。
  if (getLocalDateKey(wallNow) !== scene.dateKey) return null;
  if (scene.songPool.length === 0) return null;

  const { current } = resolveScheduleSlots(scene.schedule, wallNow);
  if (!current || !slotIsListening(current)) return null;
  return pickSongFromPool(
    scene.songPool,
    current.startTime,
    getLocalDateKey(wallNow),
    scene.charId,
  );
};

/**
 * 渲染 fire 時刻的「此刻在做什麼」。沒有日程、日程是空表、或者這份日程已經不是今天的了，
 * 一律返回空串（槽位被抹平，模板跟沒這回事一樣）。
 *
 * includeClock 跟著角色的「時間感知」開關走（worker 從 tool_pack 讀，同今日節日那條）。
 * 關掉的角色在前台連「現在幾點」都讀不到，這裡要是照舊寫「當前時段：23:00 你正在睡覺」，
 * 鍾就從日程這條縫漏了出去。日程本身照給——它有自己的總開關。
 */
export const renderFireSceneBlock = (
  scene: AmsgFireScene | null,
  nowMs: number,
  tz: AmsgTzRef,
  options?: { includeClock?: boolean },
): string => {
  if (!scene?.schedule?.slots?.length) return '';

  // 角色所在地的牆鍾：日程表裡的 "08:00" 說的是角色那邊的八點。
  const wallNow = nowInTimeZone(tz.tzId, new Date(nowMs));
  // 跨天的包整段不用：這是 scene.dateKey 那天的安排，第二天再照著念就是在說昨天的事。
  // 寧缺勿錯，跟「實時世界拉不到就整段消失」同一條線。
  if (getLocalDateKey(wallNow) !== scene.dateKey) return '';
  const scheduleText = buildScheduleInjection(
    scene.schedule,
    scene.evolvedNarrative,
    wallNow,
    {
      includeClock: options?.includeClock !== false,
      // 到點主動開口的角色最容易撞上「表上寫著睡覺、我卻正在給對方發消息」，
      // 所以這條路也要教。標籤由 worker classifier 摘成 directive 隨 push 回來、
      // 客戶端落庫；落庫按 push 的 sentAt 判時段，隔夜的整批丟棄（見 scheduleChange）。
      includeChangeInstruction: true,
    },
  ).trim();

  const lines: string[] = [];
  if (scheduleText) lines.push(scheduleText);

  const song = resolveFireSceneSong(scene, nowMs, tz);
  if (song) lines.push(`你此刻在聽：《${song.name}》— ${song.artists}`);

  if (lines.length === 0) return '';
  // 前導空行：槽位是緊跟在上一行後面填的，自帶空行才不會跟當前時間粘成一行。
  return `\n\n${lines.join('\n')}`;
};
