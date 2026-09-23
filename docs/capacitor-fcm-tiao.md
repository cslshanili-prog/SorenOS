# TIAO-Capacitor：AMSG2 Android 原生推送

本分支只用於條條自己的 Capacitor Android 構建。`master` 的普通瀏覽器/PWA 構建默認
沒有原生橋：只有 `vite build --mode capacitor` 讀取 `.env.capacitor` 後，才動態加載
`utils/nativeAmsgPush.ts`。

實際的原生殼保留在 `D:\CHICK\CHICK2`。不要再把整份 SullyOS 源碼複製覆蓋過去；這樣
容易覆蓋 CHICK2 中的圖標、原生配置和其他本地改動。專用腳本只替換可再生成的 `dist`，
再同步 Capacitor 插件並構建 APK。

## Firebase

1. 在 Firebase 項目中添加 Android App，包名必須是 `com.aetheros.simulator`。
2. 下載 `google-services.json`，放到
   `D:\CHICK\CHICK2\android\app\google-services.json`。
   該文件已被 Android `.gitignore` 排除，不提交。
3. 在項目設置 → 服務帳號創建一個服務帳號密鑰 JSON。不要提交這份 JSON。

## Cloudflare AMSG Worker

在現有 AMSG Worker 的 Variables and Secrets 增加：

- `FCM_PROJECT_ID`：服務帳號 JSON 的 `project_id`。
- `FCM_SERVICE_ACCOUNT_EMAIL`：服務帳號 JSON 的 `client_email`。
- `FCM_SERVICE_ACCOUNT_PRIVATE_KEY`：服務帳號 JSON 的完整 `private_key`，包含 PEM 頭尾。

後三項只有同時存在才啟用 FCM。原來的 VAPID 可以繼續保留；瀏覽器訂閱仍走 Web Push，
`fcm:<registration-token>` 訂閱才走 FCM HTTP v1。

## 構建

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-tiao-capacitor.ps1
```

只想同步、不生成 APK 時加 `-SkipAndroidBuild`。生成的 APK 位於：

`D:\CHICK\CHICK2\android\app\build\outputs\apk\debug\app-debug.apk`

本分支的 `.env.capacitor` 會為私有 App 預設
`https://amsg.noir2.cc.cd`。首次啟動會申請通知權限，隨後把 FCM token 登記到該 AMSG
Worker。普通生產構建不會包含這個地址。

## 隔離保證

- `VITE_AMSG_NATIVE_PUSH` 默認不存在時，不加載 `@capacitor/push-notifications` 動態模塊。
- Worker 默認地址也只在 `VITE_AMSG_NATIVE_PUSH=true` 的 Capacitor 構建中讀取。
- 沒有本地 FCM token 時，`ActiveMsgClient` 完整沿用原 Web Push 登記路徑。
- Worker 對普通 `https://...` PushSubscription 完整委託原 Web Push 發送器。
- 只有 endpoint 以 `fcm:` 開頭才讀取 FCM Secrets 並請求 Google FCM。

## 應用顯示名稱

應用統一顯示為 `Soren`。根目錄 `capacitor.config.json` 的 `appName` 是原生打包名稱；同步腳本會調用 `scripts/sync-native-app-name.mjs`，將外部 CHICK2 包裝工程的 Capacitor `appName`、Android `app_name` 與 `title_activity_main` 一起更新。包名、appId 和 URL scheme 保持不變。此操作隨下次 APK 構建生效，不會靠網頁更新改寫已安裝 APK 的系統標籤。

網頁標題與 Apple 主屏名稱在 `index.html`；兩套靜態 PWA manifest 的 name / short_name 與 `metadata.json` 一致。自定義圖標生成的動態 manifest 從 metadata 讀取名稱，避免舊清單緩存帶回舊名字。start_url、scope 與 manifest 地址保持不變。
