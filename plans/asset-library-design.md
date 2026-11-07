# 資料庫（相簿改版）設計

> 狀態：設計稿，還沒動工。提議來自 Liora（2026-11-07）：相簿改成「資料庫」——除了 Soren 生成的圖，也能自己上傳現成的圖、寫描述、直接在這裡生成照片，分配給角色用；協同工作做出來的文件也能歸檔進來。

## 現況

| | 存在哪 | 限制 |
|---|---|---|
| 相簿 | `gallery_images` 表（`GalleryImage`），圖本身是 blobref 令牌、二進制在 `blob_assets` | 每張綁**一個**角色（`charId`）；只記「誰傳的」（`sender`）和來源（`origin`，見面「拍下這一刻」才有）；沒有描述、不能自己上傳、角色不知道它們存在 |
| 角色發照片 | 私聊 `[[ACTION:SEND_PHOTO\|畫面描述]]` → `utils/pendingPhoto.ts` 現場生成 | 每次都重新生成（要錢、臉會飄），不能傳一張已經有的圖 |
| 協同工作的文件 | 獨立的 IndexedDB `SullyOS_Collaboration`（`features/collaboration/store.ts` 的 `assets`／文件櫃） | 只在那個協同視窗的文件櫃裡看得到 |

## 決定（Liora 已確認）

- 「分配給角色」＝ 角色**知道有這張圖**，而且**可以當成自己的照片傳給你**
- 「拿來當生圖參考」還沒想好，先不做，資料結構留位置
- 協同文件：**你選了才歸檔**，不自動複製

## 資料結構

新表 `library_items`（進完整備份；二進制照舊放 `blob_assets`，這張表只存令牌和描述）：

```ts
interface LibraryItem {
  id: string;
  kind: 'image' | 'file';
  blobRef: string;              // 圖片或文件本體
  title?: string;
  /** 寫給角色看的描述（角色「知道」這張圖，靠的就是這段） */
  description?: string;
  source: 'chat_user' | 'chat_char' | 'date_moment' | 'upload' | 'generated' | 'collab_file';
  /** 從哪來的（聊天訊息、見面故事、協同視窗），回溯用 */
  sourceCharId?: string;
  sourceMessageId?: number;
  /** 誰能用：所有角色共用，或指定幾個角色 */
  access: { mode: 'all' } | { mode: 'chars'; charIds: string[] };
  /** 生成的圖：當時的提示詞、鎖了幾張臉 */
  generation?: { prompt: string; lock?: string };
  /** 文件：檔名、類型、大小 */
  file?: { name: string; mime: string; size: number };
  createdAt: number;
  updatedAt: number;
}
```

**舊相簿搬過來**：第一次打開時把 `gallery_images` 逐張轉成 `LibraryItem`（`source` 照 `sender`／`origin` 換、`access` 是原本那個角色），舊表留著不刪、不再寫；相簿詳情頁的「讓角色點評」照樣能用（點評記在 item 上）。

## 畫面

- **瀏覽**：上面兩個分頁「照片」「文件」，照片再按來源篩（角色傳的／你傳的／見面拍的／上傳的／在這裡生成的），也能按角色篩（看某個角色能用哪些）
- **單張**：大圖、描述（可改）、分配給誰（共用／勾選角色）、來源、刪除
- **上傳**：選圖 → 寫描述 → 分配
- **在這裡生成**：寫提示詞 → 選類型（獨照／合照／物品／風景）→ 選角色（獨照選一個、合照選兩個以上，用各自的參考圖鎖臉，你用身份卡的長相）→ 生成後先預覽，滿意才存
- **協同文件櫃**：每個文件多一顆「歸檔到資料庫」，複製一份進來；資料庫裡可以打開、下載、分配

## 角色怎麼用

1. **知道有這張圖**：私聊提示詞加一段「你手邊的照片」：列出分配給這個角色（含共用）的照片，每張一個短編號＋描述。只列最近的 20 張、描述截到 60 字，避免 token 膨脹；沒有就不帶
2. **當成自己的照片傳**：新動作 `[[ACTION:SEND_SAVED_PHOTO|短編號]]`，直接發出那張圖（不重新生成、不花錢、臉不會飄）；編號對不上就不發、留日誌。跟 `SEND_PHOTO` 並存：想要新的畫面還是現場生成
3. 雲端即時對話（fire_pack）第一批先不帶，等本機跑順再接

## 分批

| 批 | 內容 |
|---|---|
| 1 | `library_items` 表、舊相簿搬遷、資料庫畫面（瀏覽、上傳、描述、分配）；相簿 App 換成資料庫 |
| 2 | 角色知道＋`SEND_SAVED_PHOTO` |
| 3 | 在資料庫裡生成（獨照／合照／物品／風景） |
| 4 | 協同文件歸檔 |

## 還要 Liora 決定的

- App 叫什麼、圖示要不要換（直接把「相簿」改名「資料庫」，還是保留「相簿」這個名字只換內容）
- 「共用」是所有角色都能用，還是要照世界分（同一世界的角色共用；見 `plans/multi-persona-isolation-design.md`，不同世界的角色不該知道彼此的事）
