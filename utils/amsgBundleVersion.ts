// 主動消息 2.0 後端 bundle（worker/amsg）代碼版本的唯一出處。
//
// worker bundle（worker/amsg/src/index.ts → GET /config-check 的 workerVersion）和
// SullyOS 前端（設置頁判斷「有沒有新版可更」）都從這裡 import，所以用戶那台 Worker 報回來的
// 版本和 App 裡認的版本不會各說各話——除非那台 Worker 貼的是舊 bundle，而那正是要認出來的事。
//
// 什麼時候改：worker/amsg/src/* 有了「用戶不更新就用不上 / 會出錯」的改動時。
// 純註釋、純重構不用動。格式 YYYY-MM-DD，同一天發第二版就加 .2/.3 後綴；
// 前端直接按字符串比對，不相等就是「有更新」，不做大小排序。
//
// 跟另外兩個版本號分清楚：
//   - utils/amsgWorkerVersion.ts 比的是**上游庫** @rei-standard/amsg-server 的 semver；
//   - utils/buildInfo.ts 的 APP_VERSION 是整個 SullyOS App 的版本。
//   這裡管的只有一樣：用戶自己那台 Worker 上跑的這份 bundle 是哪天的。
export const AMSG_BUNDLE_VERSION = '2026-09-18';
