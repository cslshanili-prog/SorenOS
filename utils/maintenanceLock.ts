// 存儲維護操作的進程內互斥鎖。
//
// 孤兒圖片 GC 和「優化資源存儲」都會大面積讀寫 blob_assets 與各引用面，且 GC 的 mark
// 不是一致性快照——遷移把字段值從 data: 換成令牌屬於「引用搬家」，撞上進行中的 GC
// 有誤刪風險（@rei-standard/blob-store README 的宿主義務）。兩個入口共用這把鎖，
// 拿不到就把佔用方名字告訴用戶，絕不排隊靜默等待（用戶看不到的等待=按鈕卡死觀感）。
//
// 只防同頁面內併發。多標籤頁場景由「兩個操作都僅手動觸發」兜底——同一個人同時在
// 兩個標籤頁裡分別點兩個維護按鈕的概率可以忽略，真撞上了 GC 的 72h 新鮮豁免
// 也兜得住新遷移的 Blob。

let holder: string | null = null;

/** 嘗試拿鎖。成功返回 true；已被佔用返回 false（用 currentMaintenanceHolder 查佔用方）。 */
export function tryAcquireMaintenanceLock(name: string): boolean {
    if (holder !== null) return false;
    holder = name;
    return true;
}

/** 釋放鎖。調用方必須在 finally 裡保證釋放，否則兩個維護入口一起報廢。 */
export function releaseMaintenanceLock(): void {
    holder = null;
}

/** 當前佔用方名字；空閒時 null。 */
export function currentMaintenanceHolder(): string | null {
    return holder;
}
