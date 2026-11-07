# iOS 27 主螢幕頂部模糊：安全區相容處理

> 2026-11-07 從上游 SullyOS 移植（qegj567-cloud/SullyOS#740，commit 25d7aff7），下面是原文轉繁體。Soren 的差別只有 `utils/iosStandalone.ts` 照 Soren 現在的版本對著改（鍵盤態判斷多了「輸入框有焦點」這條，測試跟著補聚焦），邏輯沒變。Liora 在 iOS 27.2 回報頂端霧玻璃後移植。

## 來源與實機證據

第一輪採用 [OJapp 實機實驗](https://tips.ojapp.app/en/ios-27-pwa-top-blur-workaround-2/) 中的 11px 固定元素 + `background-clip: text` 思路。空元素不實際畫出色塊，但保留 WebKit 頂部取色使用的背景宣告。這不是 Apple 提供的關閉模糊 API。

它與 `origin/codex/ios-browser-top-edge` 分支不同：舊候選是 4px 不透明色條，且明確跳過 standalone；本次來自獨立測試頁 R1 的 C。

使用者提供的 iPhone Safari `Version/27.0.1` 主螢幕截圖：A 對照在狀態列下緣有暗色模糊過渡，C 沒有該過渡，系統欄變成和頁面相接的純色；E 也消除過渡，但額外蓋住 11px 網格。使用者隨後確認 C 在聊天開關、鍵盤開關、淺色和前後臺往返後未復發。

完整應用實機隨後仍復現模糊。Safari 遠端除錯發現兩個環境有差異：R1 的 `navigator.standalone=true`、CSS display-mode 為 browser、高度 812px、頂部 env 為 0；完整應用 CSS display-mode 為 standalone、高度 874px、頂部 env 為 62px。不能把最小實驗成功直接當成完整應用修復成功。

在同一臺手機、同一完整應用裡，動態把 `viewport-fit=cover` 改為 `contain` 後，頁面高度變為 812px，上下 env 都為 0，頂部網格和文字恢復清晰；改回 cover，模糊立刻返回。移動/增高裁色條、改成不透明色條、去掉外殼合成層、強制深色、模擬滑出面板均未消除過渡。當前 manifest standalone 方案來自這次實機對照；並非舊分支，也不能歸因於 OJapp 的 11px 方法。

代價明確：網頁內容止於原生狀態列下方，不能在時間/靈動島區域顯示網頁文字或完整桌布。原生區域使用代表底色，複雜紋理/漸變不保證連續。這不是 Apple 提供的關閉模糊 API，也不代表所有裝置或未來系統都已驗證。

## 實現

入口在 `index.tsx`，處理在 `utils/iosStatusBarEdge.ts`。

- 只啟用可識別的 iPhone/iPad/iPod、主螢幕模式、Safari/OS 27 及以上，排除 Capacitor。主螢幕判斷複用 `isStandaloneDisplayMode`，相容 `navigator.standalone=true` 但 CSS 媒體查詢仍報告 browser 的實機情況。
- Safari UA 的 CPU OS 可能仍是 18_7，優先用 `Version/` 判斷。無 Version 時使用 CPU OS；舊版或無法識別的系統不啟用。iPad 桌面 UA 暫不啟用。
- 在原有高度/安全區測量之前安裝。CSS display-mode 為 standalone 時，將 viewport-fit 改為 contain 並標記 `data-ios-status-bar-contained`；僅 navigator.standalone 為 true 的舊 web-clip 環境保留 R1/C 裁色處理。
- 空元素直接掛 body，固定在頂部，高 11px，不佔佈局，不攔截觸控，不進入無障礙樹。contain 模式同時用頂邊代表色替換 PhoneShell 的備用漸變底色，避免系統欄延伸出粉色備用背景；桌布和應用背景繼續正常繪製。不修改狀態列 meta 或版本號。
- contain 中頂部 env=0 是正常的，不能回退到 44px 再留一遍狀態列空間。viewport-fit 的非同步生效可能使可視高度由 874px 降至 812px，小於鍵盤閾值的縮小會重建高度基線，避免底部被舊高度擠出螢幕。鍵盤彈出/收起仍走同一套高度和鍵盤態判斷。
- 讀取頁面頂邊中點的實際背景層：純色沿用計算樣式，半透明背景和下層合成。聊天自定義 CSS、角色切換、應用切換、鎖屏/開屏都透過實際 DOM 反映。
- 圖片按居中 cover 取頂行的代表色；最多快取 12 個源/尺寸結果，每張最多等待 2.5 秒。跨域圖片沒有 CORS 時回退 CSS 底色，不透過代理獲取，不上傳畫素。漸變使用首個可識別顏色作為近似，不保證任意方向/多層背景精確接色。偽元素、影片和 canvas 內容也不作逐幀畫素取樣。
- 變更事件合併到 80ms 一次；監聽頂部相關結構/樣式、樣式表、載入和過渡結束、頁面恢復、視口變化。忽略正文文字流與下方元素的樣式變化，不做常駐輪詢。舊圖片取樣完成後不能覆蓋新介面顏色。
- 安裝冪等，支援解除安裝和開發熱更新清理，同時恢復原 viewport 和標記。移除入口呼叫可回退。

## 驗證

`pnpm vitest run utils/iosStatusBarEdge.test.ts utils/iosStandalone.keyboard.test.ts utils/databaseStartup.test.ts utils/isStatusBarHidden.test.ts`：門禁、alpha 合成、深淺頂欄更新、contain 安裝/還原、零安全區、非同步高度收縮後的鍵盤恢復、冪等/清理、忽略正文更新、過期取樣不覆蓋新介面，以及原鍵盤/啟動行為。

完整應用還需在手機預覽驗收：預設桌面、深淺自定義聊天頂欄、獨立鎖屏桌布、進入/退出聊天、彈出/收起鍵盤、前後臺往返。跨域圖片或複雜漸變頂欄可能只有近似底色。
