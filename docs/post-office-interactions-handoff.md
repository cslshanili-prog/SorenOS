# 彼方郵局 · 互動功能接入交接（給 UI）

後端（`worker/post-office/`）和客戶端 API（`utils/vrWorld/postOffice.ts`）已補齊**點贊 / 點踩(=舉報) /
瀏覽量 / 身份導出導入**。後端已離線 e2e 跑通（23/23）。UI 這層在 `apps/VRWorldApp.tsx` 的郵局房間接入即可，
**不用讀 worker 源碼**，照著下面調 `PostOffice` 的方法就行。

## 一、抽到的信現在帶熱度字段

`PostOffice.fetchInbox()` 返回的 `RemoteLetter` 多了幾個字段：

```ts
interface RemoteLetter {
  id: string; pen: string; content: string; created_at: number;
  likes?: number;        // 點贊數
  dislikes?: number;     // 點踩(=舉報)數
  views?: number;        // 被抽到/瀏覽次數（抽到這封信時後端已 +1）
  reply_count?: number;  // 已被回信數
}
```

> 約定：**贊、踩都公開顯示**（👍 數 + 👎 數），👁 瀏覽量也顯示。👎 同時就是舉報——
> 一封信被 **5 個不同設備**點踩會被後端**自動刪除**（不可恢復）。UI 上 👎 按鈕建議給個二次確認或說明文案，
> 讓用戶知道「踩 = 舉報，會推動刪除」。

本地 `VRLetter` 也加了緩存字段 `likes / dislikes / views / myVote`（`types.ts`），
存「我對這封 inbox 信的投票」用，方便高亮按鈕狀態。

## 二、投票

```ts
// vote: 1 點贊 / -1 點踩(=舉報) / 0 撤銷
const r = await PostOffice.vote(letterId, 1);
// r = { likes, dislikes, deleted? }
if (r.deleted) {
  // 這封信已被刪（要麼剛被你這一踩湊滿閾值，要麼早已被刪）→ 從列表移除
} else {
  // 用 r.likes / r.dislikes 更新該卡片的計數；本地 myVote 記成剛投的值
}
```

一台設備對一封信**只能一票**，可改可撤（再投相同值不疊加，投 0 撤銷）。後端按 `owner_id` 去重。

## 三、作者看自己信的熱度

`fetchReplies()` 現在除了回覆，還順帶返回我寄出的每封信的統計，可用新方法單獨取：

```ts
const stats = await PostOffice.fetchMyStats();
// RemoteLetterStat[] = [{ id, likes, dislikes, views, reply_count, created_at }]
```

可以在「我寄出的信」列表上展示贊/踩/瀏覽量/回信數。

## 四、身份導出 / 導入（郵局 ⚙ 設置里加兩個按鈕）

owner_id 是本地隨機 UUID，清瀏覽器數據就沒了。給用戶一個「帶走身份」的口子：

```ts
import { exportIdentity, importIdentity } from '@/utils/vrWorld/postOffice';

const code = exportIdentity();         // 形如 "sullypo.<uuid>.<校驗位>"，給用戶複製保存
const ok = importIdentity(userInput);  // 校驗通過→替換本地 owner_id，返回 true/false
```

導入成功後，換設備/清數據也能找回「我寄出的信」和它們的責任歸屬。導入失敗（格式/校驗位不對）返回 `false`，給個錯誤提示即可。

## 五、不需要 UI、但要知道的後端行為

- **不按時間刪信**：信只在 ①點踩滿 5 ②管理員刪 ③作者刪（`release`）時消失。
- **正文上限 400 字**（按字符，1 漢字/標點=1 字）：客戶端導出常量 `MAX_LETTER_CHARS`，輸入框直接用它做限制+計數提示；超長後端會截斷。
- **限流**：**投信每 IP 每 5 小時最多 5 條**；回信/投票每分鐘限流。超了返回 429（`call` 會拋 `HTTP 429`）。UI 給「今天寫得有點多，歇會兒再寄」之類提示即可。
- **管理員刪信**是純後端 API（`/admin/*` + token），不做前端，跟 UI 無關。

部署：後端是加性升級，對已部署實例 `wrangler deploy` 即可，老數據不丟；需先
`wrangler secret put ADMIN_TOKEN` 和 `wrangler secret put PO_IP_SALT`（詳見 `worker/post-office/README.md`）。

## 六、⚠️ 已知待決定：批量寄信 vs 投信限流

**衝突**：
- 後端投信限流是「同 IP 每 5 小時 5 封」，**按實際條數計**（一次寄 N 封扣 N 封額度），超額**整批 429**。
- UI 的 `sendOutbox`（`apps/VRWorldApp.tsx`）把「待寄出」隊列裡所有 `queued` 信**一次性**上傳。
- 所以隊列攢到 6 封時點「一鍵寄出」→ `cost=6 > 5` → 整批失敗，提示「寄出失敗：rate limited」，6 封全留在隊列，得手動刪 1 封再寄。**體驗糙。**

**當前狀態**：保持「整批拒」行為，未做特殊處理（先記錄，待決定）。

**候選方案**（擇一再實現）：
1. **部分接受**（體驗最好）：服務端按剩餘額度寄，超出的留在隊列並提示「達上限，還剩 N 封下次寄」。需改 worker 的 `/letters`（不整批拒，返回 accepted ids + skipped）+ 客戶端 `sendOutbox`（按返回的 ids 只標記成功的那幾封為 sent，其餘留 queued）。
2. **整批拒 + 友好提示**（最簡單）：僅把 `sendOutbox` 的 429 錯誤文案改成「每 5 小時最多寄 5 封，請先刪減待寄信件」。
3. **調高額度匹配 UI**：把 `PO_RATE_LETTERS` 調高（如 20），放寬你定的「5 封」硬限。

> 決定後告訴我，我來實現對應改動。
