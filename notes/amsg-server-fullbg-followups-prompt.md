# 交接 prompt：滿血後台消息實測後的四個通用缺口補齊

> 這份是給在 **ReiStandard** 倉庫（`packages/rei-standard-amsg`）裡幹活的實例看的，自包含，
> 不依賴別處上下文。背景：下游用 `client_state` + fire hooks + 服務端 agentic 循環
> （amsg-server 2.6.0-next.3 那批契約）跑完了完整實機驗證，暴露出四個**任何宿主都會撞上**
> 的通用缺口。按價值排序：① client_state 大值透明分塊 + 整批局部失敗語義；② fire 級
> scratch 容器進 hook ctx；③ `GET /capabilities` 特性探測端點；④（可選）scheduled 推送
> 的溢出封套對齊 instant。

## 前置約束（紅線，與上一批 hooks 交接相同）

- **通用抽象，不耦合任何下游**。新增字段/端點/錯誤碼不得出現下游業務概念，文檔舉例用中性示例。
- **純 Web Crypto / 零 node 內置依賴**。主線部署是「bundle 粘貼進 Cloudflare Dashboard」，
  不開 `nodejs_compat`。驗收含打包檢查。
- **向後兼容**。老客戶端打新 worker、新客戶端打老 worker，都不能炸：老行為一字不變，
  新能力探測不到就優雅退化。
- **hook ctx 不暴露憑據**（scratch 容器同樣適用：庫自己不往裡寫任何東西，也不打日誌）。

## 任務 1：client_state 大值透明分塊 + 整批局部失敗（主菜）

**現狀**：單條 value 有 `MAX_STATE_VALUE_BYTES`（200KB）硬上限，超限直接 413；且
`PUT /client-state` 整批 all-or-nothing——批裡一個胖條目會把同批**所有**條目一起拒掉。
實測後果：宿主存的狀態包（完整 prompt 模板這類）輕鬆超限，只能在應用層自己發明
「`<key>.0` / `<key>.1` 子條目 + 根條目 meta」的私有分塊格式，客戶端切、worker 拼，
每個宿主都要重造一遍。

**要做的兩件事：**

1. **透明大值**：`putClientState` 接受大 value（工廠配置可設總上限，默認給個寬鬆值），
   庫內部自行跨行存儲；`readState` 返回**拼好的原值**，hook 作者無感。存儲格式是庫的
   內部實現細節，隨便選，但注意四個坑（下游都踩過）：
   - 多字節字符/emoji 代理對不能從中間劈；
   - 覆蓋寫入時新塊數 < 舊塊數，**舊的尾部塊必須刪掉**，不能留著下次拼接還魂；
   - 缺塊（寫到一半斷了）→ 該 key 視為不存在，讀方拿 null 走自己的兜底，不拋錯；
   - `clearClientState` 要連塊清乾淨。
   - 下游有一份帶 8 條迴歸測試的參考實現可抄思路：SullyOS 倉庫
     `utils/amsgStateChunks.ts`（分支 `claude/amsg2-v2-live-test-fixes`）。庫內做完後
     下游會刪掉自己這層——不需要兼容下游的私有格式。
2. **整批局部失敗**：per-entry 校驗，一個條目超限/非法只拒它自己；響應帶每個 key 的
   accepted / rejected（含原因），全部成功時保持現有響應形狀不變（老客戶端無感）。

## 任務 2：fire 級 scratch 容器進 hook ctx

**現狀**：`onBeforeFire` 裡準備的工具上下文要傳給同一次 fire 的 `executeToolCalls` /
`onLLMOutput`，宿主只能自己維護 `Map<sessionId, state>` 外加容量上限、fire 中途拋錯時的
孤兒清理。每個用 agentic hooks 的宿主都得重造這套樣板。

**要做**：sessionCtx 加一個 `scratch`（普通對象即可）——單次 fire 開始時創建，同一次 fire
的所有 hook 調用拿到**同一個引用**，fire 結束（finish / skip-push / 拋錯 / 輪數超限）後由
庫丟棄。不落庫、不進日誌、不跨 fire 共享。純增量字段，向後兼容免費。

## 任務 3：`GET /capabilities` 特性探測端點

**現狀**：worker 部署版本落後時是**靜默降級**（消息照發但新鏈路不生效），用戶只會覺得
「功能沒反應」，排查全靠猜。

**要做**：加 `GET /capabilities`，返回 `{ serverVersion, features: string[] }`（feature 名用
庫自己的中性命名，如 `client-state` / `agentic-hooks` / `client-state-chunking`，隨版本演進
追加）。鑑權與 `/vapid-public-key` 同待遇。client SDK 配 `getCapabilities()`，打到老 worker
（404）時返回 null 不拋錯——前端拿它在設置裡亮「worker 需要重新部署」的牌子。

## 任務 4（可選，調研後覺得成本合理再做）：scheduled 推送溢出封套

amsg-instant 有 `maxInlineBytes` + `_blob` 封套（超限 payload 落庫、push 只帶引用、客戶端
回取）；amsg-server 的 `sendHookPushPayloads`（scheduled 路徑）沒有，宿主想在 push metadata
裡帶大件（實測案例：結構化卡片會話數據）只能手工裁剪遷就 web push ~4KB。把封套機制抽進
amsg-shared 讓兩條路徑共用。改動面涉及 sw 回取路徑，先評估再動。

## 驗收

- 任務 1：往返測試（含全中文大包、emoji 代理對邊界）、縮塊覆蓋寫不殘留尾塊、缺塊返 null、
  局部失敗響應形狀、老單值路徑字節級不變。
- 任務 2：同一 fire 內三個 hook 拿到同一引用；不同 fire 之間隔離；fire 拋錯後不洩漏。
- 任務 3：老 worker 探測返回 null 不拋錯。
- 通用：打包零 node 內置依賴；紅線 grep 零下游標識；changesets + next tag 發預發佈版
  （動了哪個包發哪個：amsg-server 必發，動 SDK 加 amsg-client，動封套加 amsg-shared/amsg-sw）。

## 發版後下遊會做什麼（供理解使用方，不用你做）

下游升 next 版後：刪自己的應用層分塊、把 sessionId Map 遷到 `ctx.scratch`、設置頁接
`getCapabilities()` 亮版本牌，然後重打 bundle 重新部署 worker。
