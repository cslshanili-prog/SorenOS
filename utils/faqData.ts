/**
 * 「使用幫助」App 的常見問題。搬出來是因為 AI 助手 Sore 的答疑知識也用同一份（utils/assistant/knowledge.ts）。
 */
export const FAQ_DATA = [
    {
        q: "1. 進不去網頁 / 白屏 / 點了沒反應",
        reason: "網絡有點小脾氣，不夠通暢。",
        solution: "需要一點點“魔法”才能連上外網。\n如果你不知道什麼是“梯子/魔法”，請自行搜索一下~ \n這不是軟件壞啦，是網路不通。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa84.png",
        color: "bg-blue-50 text-blue-700"
    },
    {
        q: "2. 發了消息，角色不回我？",
        reason: "為了幫大家省額度，角色不會自動秒回，他在等你戳他。",
        solution: "發完消息後，請注意觀察頂部標題欄右邊的 **閃電按鈕**。\n點一下它，戳戳他，他就會思考並回復啦！\n也可以在聊天設置裡開啟“發送按鈕代替生成按鈕”或“自動回覆”，所有私聊統一生效。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4a4.png",
        color: "bg-yellow-50 text-yellow-700"
    },
    {
        q: "3. 為什麼拉取不到模型列表？",
        reason: "很多時候是填寫的地址（URL）差了一點點。",
        solution: "請仔細檢查你的鏈接：\n1. 後面是不是漏掉了 `/v1` 這個小尾巴？\n2. 複製時是否多帶了空格？\n3. 地址不對是敲不開門的哦。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f50d.png",
        color: "bg-red-50 text-red-700"
    },
    {
        q: "4. 出現紅色彈窗 (API 報錯)",
        reason: "情況A：如果你最近發了很多高清圖，或者聊得太久了。\n情況B：沒發圖也報錯？可能是提供接口的那邊欠費或波動。",
        solution: "**情況A**：進【設置】，把“上下文條數”調低一點（例如 20-50）。\n**情況B**：請直接聯繫你購買/獲取 API 的那個渠道哦，模擬器本身是無辜噠。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/26a0.png",
        color: "bg-orange-50 text-orange-700"
    },
    {
        q: "5. 氣泡主題 / 導入角色",
        reason: "想要個性化？想換角色？",
        solution: "**換氣泡**：\n點頂部的名字 → 下滑找“氣泡樣式”。\n\n**導角色**：\n支持本模擬器導出的原格式文件與 PNG 分享卡原圖。PNG 請傳原文件，截圖或壓縮圖不能恢復其中的數據；不兼容其他小手機角色卡。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3a8.png",
        color: "bg-purple-50 text-purple-700"
    },
    {
        q: "6. 碎碎念：關於 API（接口）",
        reason: "用公益/白嫖的不穩定？花錢買的報錯？",
        solution: "公益的不穩定是常態。\n花錢買的請找賣家售後。\n作者和群友也是為愛發電，但是大家並不是專業的。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ac.png",
        color: "bg-slate-50 text-slate-700"
    },
    {
        q: "7. 遇到奇怪的 Bug 怎麼辦？",
        reason: "可以在群裡問，但嚴肅報修需要“病歷本”。",
        solution: "請去桌面【設置】→【數據備份】導出 JSON 文件發給我。\n只有復現了問題，才能修好它。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f691.png",
        color: "bg-rose-50 text-rose-700"
    },
    {
        q: "8. 關於提問禮儀",
        reason: "拒絕低氣壓。",
        solution: "遇到問題深呼吸，直接發截圖 + 描述發生了什麼。\n歡迎大家積極討論，但是避免通篇抱怨，散發負面情緒解決不了問題，還會勸退想幫你的人。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2764.png",
        color: "bg-pink-50 text-pink-700"
    },
    {
        q: "9. 小屋裡角色立繪怎麼更換？",
        reason: "想給角色換個造型/衣服。",
        solution: "1. 進入小屋，點擊頂部的「裝修」按鈕進入編輯模式。\n2. **直接點擊**畫面中央的角色小人。\n3. 選擇一張透明背景的圖片上傳即可。\n(注意：這裡更換的是小屋專屬的 Q 版/Chibi 立繪，不是聊天頭像哦)",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3e0.png",
        color: "bg-indigo-50 text-indigo-700"
    },
    {
        q: "10. 導入的表情包不顯示 / 導入沒反應？",
        reason: "通常是格式不對，或者鏈接無效。",
        solution: "1. **嚴格檢查格式**：必須是 `名字--URL`，中間是**兩個減號**！\n   錯誤：`滑稽 http://...`\n   正確：`滑稽--http://...`\n2. **檢查鏈接**：必須是圖片直鏈（.jpg/.png/.gif 結尾）。\n3. **一行一個**：不要把所有內容寫在一行裡。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f5bc.png",
        color: "bg-cyan-50 text-cyan-700"
    },
    {
        q: "11. 點聊天輸入框沒反應 / 鍵盤喚不起來？",
        reason: "多半是隨備份一起導入的美化在搗亂：白框自定義 CSS、氣泡主題或聊天背景把輸入框蓋住/禁用了。這類數據跟著備份走，所以重啟、重新導入備份都沒用，而全新頁面（沒導數據）反而正常。",
        solution: "按順序排查：\n1. 【外觀】→【聊天界面】→ **還原白框美化**（一鍵清掉全局和所有角色的白框 CSS）。\n2. 點頂部角色名 → 把「氣泡樣式」換回默認。\n3. 關掉該角色的聊天背景圖。\n4. 還不行：換個瀏覽器（如 Safari）打開同一鏈接導入備份試試；仍復現請把備份 JSON 按第 7 條發給作者。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2328.png",
        color: "bg-teal-50 text-teal-700"
    }
];
