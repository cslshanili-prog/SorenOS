# 音樂 App — 網易雲音樂接入說明

## 架構

```
用戶瀏覽器 (GitHub Pages 靜態前端)
   │  POST /netease/{search,song/url,lyric,...}
   │  Header: X-Netease-Cookie: MUSIC_U=xxx
   ▼
sully-n Worker (Cloudflare Workers, 國內可訪問, 免費)
   │  轉成 api-enhanced 標準 GET 請求, 加 realIP
   ▼
api-enhanced (部署在 Vercel, 免費 Hobby 計劃)
   │  處理加密/協議適配, 轉發到網易雲
   ▼
music.163.com
```

**重點**: 用戶只接觸 GitHub Pages + CF Worker, **根本不會直連 Vercel**。Vercel 是 Worker 自己去調的,所以國內用戶沒有牆的問題。

## 一次性部署 (作者/管理員做)

### 第一步:把 api-enhanced 部署到 Vercel

1. 打開 <https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced>
2. 右上角 Fork 一份到你自己帳號下
3. 打開 <https://vercel.com/new> → 選 "Import Git Repository"
4. 選你剛 Fork 的那個 `api-enhanced`
5. 直接 Deploy (不用改任何設置)
6. 部署完成後得到一個形如 `https://api-enhanced-xxxx.vercel.app` 的地址 → 複製它

### 第二步:改 Worker

打開 `worker/index.js`,找到開頭附近這一行:

```js
const NETEASE_API_BASE = "https://請把這行改成你的vercel地址.vercel.app";
```

替換成你剛才 Vercel 給你的地址,保存,重新部署 Worker。

### 第三步:驗證

打開音樂 App → 右上齒輪 → "一鍵診斷(搜索晴天)",應該看到:
- `HTTP 200`
- `code=200`
- `songs=3`

## 用戶側使用

1. 打開音樂 App → 右上齒輪
2. 粘貼 `MUSIC_U=xxx` (從 music.163.com 的 Cookie 裡複製)
3. 保存 → 搜歌 → 播放

## 為什麼這樣架構

### 為什麼不直接在 Worker 裡實現網易雲加密

試過了,自己寫 weapi 加密算法能跑通,但網易雲 2024 年後對部分接口改了響應,會返回一個 `{"result":"<hex>"}` 的加密響應,得解密才能用。`api-enhanced` 一直在跟進這些協議變化, 自己造輪子追不上。用它省心。

### 為什麼 Vercel 不會亂扣錢

Vercel 的 Hobby 免費計劃:
- 100 GB 流量/月
- 100 萬 Edge 請求/月
- 超了**會停服但不會自動收費**(需要用戶主動升級到付費計劃才能收費)

和 Netlify 的付費帶信用卡綁定模式**不一樣**。

### 為什麼不讓用戶自己部署 api-enhanced

5000 用戶大部分不會部署。由管理員統一部署一份,用戶共享,才是可行路徑。如果有能力的用戶想自建,只需要 fork api-enhanced 到自己 Vercel,把得到的 URL 填進 App 設置裡的 "後端 Worker 地址"... 等等,這裡要說明:目前 App 設置裡填的是 Worker URL,不是 Vercel URL。想換也可以,但正常用戶不需要折騰。

## API 接口(前端 → Worker)

所有都是 `POST application/json`,Header `X-Netease-Cookie: MUSIC_U=xxx`(可選)。Worker 會自動轉成 GET 轉發給 Vercel 上的 api-enhanced。

| 路徑 | Body | 說明 |
|------|------|------|
| `/netease/search` | `{ keyword, limit?, offset? }` | 搜索單曲 |
| `/netease/song/url` | `{ ids:[id], level? }` | 播放鏈接 |
| `/netease/lyric` | `{ id }` | 歌詞 |
| `/netease/song/detail` | `{ ids:[id] }` | 歌曲詳情 |
| `/netease/login/status` | `{}` | 當前 cookie 登錄狀態 |
| `/netease/user/playlist` | `{ uid }` | 用戶歌單 |
| `/netease/playlist/detail` | `{ id }` | 歌單詳情 |
