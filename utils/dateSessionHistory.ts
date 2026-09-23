/**
 * 見面（DateApp）會話歷史的窗口計算。
 * 純函數，不碰 DB / React —— 調用方負責真正取數與設狀態。
 */

/**
 * 把歷史裁到目標消息為止（含它）。
 *
 * 重擲用的歷史是「全來源」的最近窗口（見面 + 聊天混在一起），而被重擲的那一輪 user 消息
 * 是從見面子集裡挑的。兩者之間要是夾了更新的普通聊天消息，尾巴就不是目標那條了——而
 * 提示詞構建固定砍掉最後一條（本意是砍掉待重發的 user），會連鍋端錯。裁到目標為止即可
 * 讓兩邊對齊。目標不在列表裡時原樣返回，不把歷史裁沒。
 */
export const trimHistoryThrough = <T extends { id: number }>(msgs: T[], targetId: number): T[] => {
  const index = msgs.findIndex((m) => m.id === targetId);
  return index === -1 ? msgs : msgs.slice(0, index + 1);
};

export interface NovelLoadMorePlan {
  /** 閱讀模式下一步顯示多少條。 */
  nextVisibleCount: number;
  /** 需要回庫裡重取時的新 limit；只需開窗則為 null。 */
  nextLoadLimit: number | null;
}

/**
 * 閱讀模式點「加載更早」時該做什麼。
 *
 * 會話只加載最近一窗見面消息，閱讀模式在這一窗上開顯示窗口。窗口鋪滿已加載的部分後
 * 必須回庫裡取更早的行，否則更早的見面記錄在閱讀模式裡永遠夠不著。
 */
export const planNovelLoadMore = (input: {
  /** 當前已從庫里加載的見面消息條數。 */
  loadedCount: number;
  /** 閱讀模式當前顯示條數。 */
  visibleCount: number;
  /** 每次多顯示多少條。 */
  windowStep: number;
  /** 當前查詢用的 limit。 */
  loadLimit: number;
  /** 回庫重取時 limit 加多少。 */
  loadStep: number;
  /** 上次取數是否已經把庫裡的見面記錄取完了。 */
  reachedDbEnd: boolean;
}): NovelLoadMorePlan => {
  const { loadedCount, visibleCount, windowStep, loadLimit, loadStep, reachedDbEnd } = input;

  // 本地還有沒顯示出來的，先開窗，不查庫。
  if (visibleCount < loadedCount) {
    return {
      nextVisibleCount: Math.min(visibleCount + windowStep, loadedCount),
      nextLoadLimit: null,
    };
  }

  // 已加載的全顯示完了：庫裡還有就再取一批，取完了就停在原地。
  if (reachedDbEnd) {
    return { nextVisibleCount: visibleCount, nextLoadLimit: null };
  }
  return {
    nextVisibleCount: visibleCount + windowStep,
    nextLoadLimit: loadLimit + loadStep,
  };
};
