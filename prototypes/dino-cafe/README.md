# 橡皮泥恐龍箱庭試玩

為了保持瀏覽器中的鏈接可用，繼續保留 `dino-cafe` 路徑，內容已換為恐龍箱庭。功能說明與邊界見 [DINOSAUR-GARDEN.md](../../apps/vrWorld/DINOSAUR-GARDEN.md)。

試玩與真實入口共用 `DinosaurGarden`、渲染器和存檔邏輯。首次試玩種下十二隻明確標註的示例藏品，分佈在三張地圖；示例來客不訪問 LLM。原有本地收藏不會被整份重置。早期試玩佈景升級只更新這份明確標記的示例地圖，保留個體配色、名字和用戶添加的擺件。生產入口只送一隻入門贈禮，其餘來自真實收藏。

```sh
pnpm install
pnpm exec vite --config prototypes/dino-cafe/vite.config.ts
```

打開 `http://127.0.0.1:5182/prototypes/dino-cafe/index.html`。

```sh
pnpm exec node prototypes/dino-cafe/generate-models.mjs
pnpm exec vitest run utils/vrWorld/dinosaurPlacement.test.ts utils/vrWorld/dinosaurActivities.test.ts utils/vrWorld/dinosaurGarden.test.ts utils/vrWorld/fishingMarket.test.ts utils/vrWorld/fishingSession.test.ts
pnpm exec vite build --config prototypes/dino-cafe/vite.config.ts
```

模型生成器使用 Three.js 在本機生成並簡化連續體，產物直接放在 `public/dino-models`，不依賴建模 SaaS、生成 API 或外部模型下載。`manifest.json` 記錄每隻的實際三角面數和字節數。

瀏覽器 QA 使用 Playwright：`qa-garden.mjs`、`qa-integration.mjs` 和 `qa-performance.mjs`。本機無直接 Playwright 包時，可複用 `test/fixtures/playwright-loader.mjs`，設置 `FISHING_PLAYWRIGHT_MODULE` 為已安裝運行時的 `playwright/index.mjs`，`FISHING_BROWSER_CHANNEL=chrome`。完整 SAR 測試需要把項目原用的 `https://cdn.tailwindcss.com` 腳本緩存到 `output/fishing-qa/tailwind.cdn.js`。

官方遊戲檢查腳本使用 `actions.json`，並讀取 `window.render_game_to_text()` 和 `window.advanceTime(ms)`；渲染診斷提供當前地圖、格位、居民、環境互動、實際動畫位置、事件和繪製統計。截圖與 JSON 輸出不提交。

當前界面以整座庭院為主，底部「佈置／恐龍／來訪」。首次進入有可收起的三步引導；恐龍面板裡「正在」只寫一句話，位置自動決定與擺件的互動。新版草原示例會展示野餐、帳篷、樹葉與淺水活動，沿用舊試玩存檔時可通過「佈置」自行補充新擺件。

擺放採用可取消的草稿：選擺件或恐龍後出現格子、光圈和朝向箭頭，最後點「確定擺放」才保存。可直接點場景的小爪印選擇互動玩具；恐龍固定在確認位置，只做原地頭部、尾巴、腳部動作與相應物品反饋。原型與正式彼方共用這套邏輯。

面向用戶的 SAR 全設施流程、角色行動與 LLM 調用次數：[SAR 活動室怎麼玩](../../docs/sar-user-guide.md)。

艾文三星專屬「？？？」使用 `aiven-chimera` 模型 ID，與普通恐龍共用材質、換色與箱庭動作。可用 `node prototypes/dino-cafe/generate-models.mjs --only=aiven-chimera` 只重建這一隻，保留其他二進制模型。獨立視覺檢查在 `test/fixtures/aiven-chimera.html`（內存數據，無存檔讀寫），運行 `scripts/test-aiven-chimera-model.mjs` 檢查模型結構、換色、動作及三個屏寬。該模型的 catalog 條目不會自行進入隨機垂釣池。
