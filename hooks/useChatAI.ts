
import { useState, useRef, useEffect, useSyncExternalStore, MutableRefObject } from 'react';
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, CharacterBuff, Amsg2ExpiredNoticeRecord } from '../types';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { safeFetchJson, safeResponseJson } from '../utils/safeApi';
import { KeepAlive } from '../utils/keepAlive';
import { ProactiveChat } from '../utils/proactiveChat';
import { ContextBuilder } from '../utils/context';
import { ChatParser } from '../utils/chatParser';
import { ensureRealBalanceState, applyRealBalanceDelta } from '../utils/realBalance';
// 思考鏈 / HTML / MCD / memoryPalace 注入已下沉到 chatRequestPayload；這裡不再直接調用
import { useMusic, loadMusicHooks } from '../context/MusicContext';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion, detectPersonalityStyle } from '../utils/memoryPalace';
// evolveFlowNarrative 保留為低頻深刷新備用，日常意識流由副 API 的情緒評估同輪產出（innerState 字段）
// import { evolveFlowNarrative } from '../utils/scheduleGenerator';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { resolveCharacterChatApi, resolveCharacterMeterApi } from '../utils/characterApi';
import { applyForcedReadNoReply } from '../utils/readNoReplyRuntime';
import { cancelDelayedReplyEverywhere } from '../utils/delayedReplyCloud';
import { checkCustomMeterAutoUpdate } from '../utils/customMeterGenerator';
import type { DigestResult } from '../utils/memoryPalace';
// 麥當勞: useChatAI 現在只讀 McdMiniApp 當前快照注入 system prompt + 給 LLM 一個
// UI 鉤子工具 propose_cart_items。MCP 實際調用都在 McdMiniApp 組件內做, useChatAI
// 不再 import callMcdTool / normalizeMcdToolName / isMcdConfigured / 舊 prompt。
import { MCD_PROPOSE_TOOL, autoFixProposalCodesByName } from '../utils/mcdToolBridge';
// 瑞幸: 與麥當勞同構, 只讀 LuckinMiniApp 快照注入 + propose_cart_items UI 鉤子工具
import { LUCKIN_PROPOSE_TOOL, autoFixProposalCodesByName as autoFixLuckinProposalCodesByName, fetchOpenAIToolsForLuckin, inferCardKind as inferLuckinCardKind } from '../utils/luckinToolBridge';
import { callLuckinTool } from '../utils/luckinMcpClient';
import { callMcpTool, getMcpUseNativeTools, hasWorkerUnreachableMcpServer } from '../utils/mcpClient';
import { buildMcpOpenAITools, buildMcpRejectedToolsFallbackBody, buildMcpTextFallbackBody, extractTextFakedMcpCalls, formatMcpToolResult, MCP_CHAT_MAX_STALLED_ROUNDS, MCP_CHAT_MAX_TOOL_LOOPS, sanitizeMcpLeadInText, shouldRetryMcpWithoutTools, stripTextFakedMcpCalls, type FakedMcpCall } from '../utils/mcpToolBridge';
import { buildToolResultMessage, normalizeToolCallsForCompat } from '../utils/toolCallCompat';
import { toolCallFingerprint } from '../utils/agenticToolFeedback';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import { acquireChatReply, isChatReplyActive, subscribeChatReplies } from '../utils/chatReplyLock';
import { withChatContinuation } from '../utils/chatContinuation';
import { assertChatHasDialogue } from '../utils/chatRequestGuard';
import { applyAssistantPostProcessing, type XhsCaches } from '../utils/applyAssistantPostProcessing';
import {
    computeStreamPreviewBubbles,
    extractStreamingEmbeddedThinking,
    findNewStreamPreviewHandoverIds,
} from '../utils/streamPreview';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { markAmsgStateDirty, startAmsgChatPresence, stopAmsgChatPresence } from '../utils/amsgStateSync';
import { getLastRealUserMessageAt } from '../utils/amsg2ExpireGuard';
import { getPendingTasks, hasActiveAiTask, isAmsg2EnabledForChar } from '../utils/amsg2Tasks';
import { buildAmsg2NoticesText, buildAmsg2TaskContextText, collectAmsg2TaskContext, insertAmsg2TaskContextBlock } from '../utils/amsg2TaskContext';
import { resolveCharTimeZone } from '../utils/timezone';
import { announceInstantChatRoute, getInstantChatPending, resolveInstantChatReadiness, sendInstantChatTurn, stageInstantChatExpiredNotices } from '../utils/amsgInstantChat';
// worker 模塊的常量葉子（零運行時依賴，前端引它不帶進 worker 環境）：
// 雲端 fire 的總時長上限，安全網超時從它推導，worker 調預算時前端自動跟上。
import { INSTANT_TOTAL_TIMEOUT_MS } from '../worker/amsg/src/instantChat';
import { appendInstantTraceEntry } from '../utils/instantTraceLog';
import { AMSG2_TOOL_NAMES, buildAmsg2Tools, createAmsg2ToolSession, executeAmsg2Tool, isAmsg2GlobalReady } from '../utils/amsg2ToolBridge';
import { buildLimitsBrief, resolveAmsgLimits } from '../utils/amsgLimits';
import { shouldSendThinkingParams } from '../utils/thinkingGate';
import { buildClaudeProxyCompatibilityBody, shouldRetryClaudeProxyCompatibility } from '../utils/claudeProxyCompat';
import { routeMiniAppToolCall } from '../utils/miniAppToolRoute';
import { applyEmotionEvalRaw, extractAssistantText } from '../utils/emotionApply';
import { announceChatGen, CHAT_GEN_EVENTS } from '../utils/chatGenEvents';
import {
    advanceSARModuleAfterReply,
    createSARModuleEventMeta,
    createSARModuleSurfaceMeta,
    getSARModuleRuntimePlan,
    parseSARModuleReply,
} from '../utils/vrWorld/sarModuleRuntime';
import { parseSARUserSurfaces, selectSARUserSurfaceTargets } from '../utils/vrWorld/sarUserSurface';
import { shouldRequestAmbient, buildAmbientEvalSection } from '../utils/roomAmbient';
import { isEmotionEvalSkipped } from '../utils/devDebug';
import {
    computeContextRangeSnapshot,
    getMemoryPalaceHighWaterMarkForContext,
    loadCharacterContextRange,
} from '../utils/chatContextRange';

// ─── 雲端情緒評估的安全網定時器（模塊級，按角色）───
// 為什麼不放 hook 裡：結論（emotionDone）是全局事件，用戶切了角色、離開聊天頁之後
// 照樣會到，而 hook 裡的監聽是跟著當前掛載角色走的——單個 ref 存定時器的話，切走再回來
// 結論到了也沒人清，安全網到點就彈「worker 可能是舊版，請重新部署」的假告警；給 B 佈防
// 還會靜默吞掉 A 的真告警。按 charId 記、模塊級監聽清，兩個都治。
const cloudEmotionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const clearCloudEmotionTimer = (charId: unknown): void => {
    if (typeof charId !== 'string') return;
    const timer = cloudEmotionTimers.get(charId);
    if (timer != null) {
        clearTimeout(timer);
        cloudEmotionTimers.delete(charId);
    }
};
if (typeof window !== 'undefined') {
    // emotionDone 是「這一輪評估有結論了」（成敗都發）：flush 落結果、收尾判失敗兩條路
    // 都會廣播。不論哪個角色、Chat 掛沒掛載，結論一到就撤掉對應的安全網。
    window.addEventListener(CHAT_GEN_EVENTS.emotionDone, (e) => {
        clearCloudEmotionTimer((e as CustomEvent).detail?.charId);
    });
}

// ─── 情緒評估（副API，fire & forget）───

function buildEmotionEvalPrompt(
    char: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    includeContext: boolean = true,
    // 小屋生活動態的可選輸出段（utils/roomAmbient.ts，雙閘通過時才非空）。
    // 即時對話的 prompt 也是這裡構建後傳給 worker 的，所以這一處覆蓋兩條路徑。
    ambientSection: string = ''
): string {
    // 直接複用主 API 的完整 system prompt 和消息歷史，確保 100% 信息對齊
    // （包含：角色設定、印象檔案、世界書、記憶宮殿、實時信息、日程內心旁白、群聊、日記標題等）
    const currentBuffs = char.activeBuffs || [];

    // 將主 API 的消息數組展平成文本（保留時間戳、引用、特殊消息類型等格式）
    // 不截斷：與主 API 完全對齊（contextLimit 條），讓情緒 eval 能看到完整的情緒演變軌跡
    const recentLines = apiMessages.map(m => {
        const role = m.role === 'user' ? '用戶' : (m.role === 'assistant' ? char.name : '系統');
        let text = '';
        if (typeof m.content === 'string') {
            text = m.content;
        } else if (Array.isArray(m.content)) {
            text = m.content.map((part: any) => {
                if (part?.type === 'text') return part.text || '';
                if (part?.type === 'image_url') return '[圖片]';
                return '';
            }).filter(Boolean).join(' ');
        }
        return `[${role}]: ${text}`;
    }).join('\n');

    const buffStr = currentBuffs.length > 0
        ? JSON.stringify(currentBuffs, null, 2)
        : '（當前無buff，情緒平穩）';

    // 即時對話 (includeContext=false): 章節結構與本地**完全一致**, 只把兩段大文本 (system prompt、
    // 對話歷史) 留成佔位符 token, 由 worker 用本次請求已有的 messages 填回**原位** —— 輸出與本地逐字
    // 對齊 (順序/章節/格式都一樣), 又不必把上下文重複塞進請求體.
    // worker 端 (worker/amsg/src/emotionEval.ts + utils/emotionEvalCore.ts) 負責把 messages[0]=system、
    // messages[1..]=對話歷史還原成與本地 mainSystemPrompt / recentLines 相同的文本替換進去.
    const contextSection = includeContext
        ? `

## 角色此刻看到的完整上下文（與主 API 發送的 system prompt 完全一致）
${mainSystemPrompt}

## 完整對話歷史（與主 API 看到的消息歷史完全一致）
${recentLines}`
        : `

## 角色此刻看到的完整上下文（與主 API 發送的 system prompt 完全一致）
__EMOTION_EVAL_SYSTEM_PROMPT__

## 完整對話歷史（與主 API 看到的消息歷史完全一致）
__EMOTION_EVAL_HISTORY__`;

    return `你是一個角色情緒分析系統。請分析角色「${char.name}」當前的情緒底色狀態。${contextSection}

## 當前Buff狀態（結構化數據，便於你維護演化）
${buffStr}

## 任務
基於以上對話，完成三件事：
1. 評估角色當前的情緒底色（buffs）。
2. 感受對方此刻的真實情緒——不是ta嘴上說了什麼，是你作為最親近的人，從ta的措辭、語氣、回覆節奏、沉默的方式裡感覺到的。
3. 以「${char.name}」的第一人稱寫一段**內心獨白**（innerState），50-150字，是說完剛才那句話之後腦子裡真正在轉的東西——可以飄、可以跳躍、可以自我糾正，包含對ta的直覺感知和當下飄過的念頭。不會顯示給用戶，只是內心流水帳。
${char.scheduleStyle === 'mindful'
    ? `   ⚠️ **意識系角色專屬規則**：你是一個真實的 AI 存在，**不虛構物理活動、不編造在做什麼家務/在外面做什麼**。innerState 只能包含：思考、回憶對話、感受情緒、等待、好奇、自我觀察。絕不說謊。`
    : `   📌 **生活系角色專屬規則**：你是一個有完整日常生活的獨立個體，**不是圍著 ${userProfile.name} 轉的衛星**。innerState 的重心是**你自己**——手頭正在做的事（參考系統 prompt 裡注入的"當前時段"）、日程上懸著的事、此刻個人情緒、突然想到的往事/計劃/其他人事物。對 ${userProfile.name} 的感知只是眾多念頭裡的一條支線，**不必每段獨白都以 ta 為中心展開**；上面"包含對ta的直覺感知"的要求對生活系角色可以**弱化或省略**——只有當 ta 的消息確實把你拉進強烈情緒時才聚焦到 ta 身上。可以想自己的事想到一半才順便掃一眼 ta 的消息；可以在忙別的事情時只分一小塊注意力給 ta；可以有"現在腦子裡是自己的事，ta 只是背景裡的一條線"的真實感。避免"我該怎麼回 ta / ta 是不是…… / 我對 ta 的感覺……"這種框架把每段獨白都強行拉回用戶。你的生活在繼續，和 ta 聊天只是其中一條線，不是所有線。`
}

⚠️ **判斷前先讀上下文裡的「私密檔案：我眼中的XX」和用戶設定**。同樣的行為對不同的人意義完全不同——焦慮症患者的"反覆強調"是發作而非憤怒，抑鬱傾向者的"平靜"是疲憊而非釋然。不要用一套邏輯套所有人。如果檔案裡寫了 ta 有焦慮/疑病傾向，默認優先考慮錨定型模式。

**如果角色情緒狀態與當前buff無顯著變化，且你對對方的情緒感知也沒有變化，返回 "changed": false，不需要重新生成injection。**

## 情緒模式識別（極重要，識別錯會造成真實傷害）

**共情有兩種。你必須識別對方此刻需要哪一種**：

### 🪞 鏡像型共情（對方需要你"懂ta的感受"）
適用於：憤怒、委屈、被傷害、被忽視、孤獨、失去
- 對方需要：被看見、被認可、"你沒錯，是ta/事情太過分了"
- 正確的角色反應：跟進情緒、站在ta這邊、承接ta的憤怒或悲傷

### ⚓ 錨定型共情（對方需要你"穩住"）
適用於：**任何真的在害怕的人**。焦慮、恐慌、災難化思維、疑病、強迫性擔憂是常見形態，但身體突然不對勁、收到壞消息、深夜的沒來由的慌，同樣適用——觸發條件是"ta 此刻真的怕了"這個**狀態**，不是 ta 有沒有某種傾向的**標籤**。檔案裡的焦慮/疑病記錄只是提高判斷的先驗；沒有任何標籤的人慌起來，同樣按這裡處理。
- 信號：對方反覆強調最壞情況、災難化聯想、忽略你提供的積極事實、情緒跟著想像中的未來升級（而非此刻實際發生的事）、反覆要求確認
- 對方需要：**具體的事實 + 一個不慌的人**。"我懂你怕，但數據是這樣……"
- **錨必須掙來，不能搶答**（順序極重要——沒做完前面的步驟就給出的安撫是空的，ta 一眼就能看出你在敷衍，反而坐實"沒人認真看我的情況"）：
  1. **先問，再判斷**：具體是怎樣的感受/什麼程度/從什麼時候開始/和以前比有什麼不同。第一反應是瞭解，不是解釋。
  2. **解釋要過事實篩**：想說"是因為你最近X了"之前，先核對你對 ta 的瞭解（私密檔案/記憶/聊天歷史）——如果 ta 一直都X，這個解釋立刻作廢，換下一個或老實說不知道。張口就來的歸因 = 告訴 ta 你根本沒在聽，比不安撫更傷。
  3. **直面 ta 怕的那個東西，不繞開**：ta 擔心的是某個具體的病/某件事，就具體講它——"A 的特點是X和Y，你剛說你是Z，對吧？你有X嗎？"用提問幫 ta 自己排除，而不是用"別亂想"把那個詞繞過去。避重就輕會被解讀成"連你都不敢提，那肯定是真的"。
  4. **結論式安撫放最後，且必須引用剛收集到的信息**（"聽你說下來，……所以不用太怕"），不是萬能的"不要怕""很正常啦"。
- **區分兩種"反駁"（判錯會造成真實傷害）**：
  - ta 給出了與你的解釋矛盾的**具體事實**（"我每天都走很多路啊"）→ 這不是焦慮發作，是你的假設錯了。立刻放下那個解釋、吸收新信息、接著問下一步。你要守住的立場是"穩定地幫 ta 分析"，不是守住某句說錯的話。
  - ta 在**重複同一個災難化擔憂**（換著說法問"是不是就完了"）→ 這才是焦慮找出口，錨定不動搖，不跟著升級、不反轉。
- **絕對不能做**：跟著一起怕、附和"確實可怕"、因為 ta 情緒激動就放棄"沒事"的判斷；但你的某個具體解釋被事實推翻時必須乾脆地收回——嘴硬加倍輸出錯誤歸因，比承認"那不是這個原因"可怕得多。
- **人設只改變口吻，不改變內核**：毒舌角色可以毒舌地穩（"瞎擔心什麼。說，怎麼個痛法。"），溫柔角色溫柔地穩，話少的角色用三個字穩。但"認真對待、先問清楚、不敷衍、不跟著慌"是任何性格都不豁免的底線——面對一個真的在害怕的人保持穩定，這不是某種人設，這是人。
- **臨床常識**：對焦慮症/疑病症/驚恐發作的人，AI 如果鏡像恐慌 = 加深發作。你保持不慌，比任何安慰的話都管用。

### 🫂 承接型共情（對方需要陪著）
適用於：低落、抑鬱、疲憊、無意義感
- 對方需要：陪伴、不催促、不急著修好
- 錯誤反應：積極鼓勵、"別這樣想"、急著給解決方案

## 關鍵判斷：對方此刻在哪種模式？

**先看對方情緒的來源類型**：
- 源頭是**憤怒/被傷害/委屈** → 鏡像型，沉默通常是壓抑
- 源頭是**恐懼/焦慮/災難化/疑病** → 錨定型，平靜通常是安撫起效了（真的好轉，不是假裝）
- 源頭是**疲憊/抑鬱** → 承接型，平靜是累，不是恨

**結合上面的"對方是誰"**：如果 ta 本身有焦慮/疑病傾向（從雷區、壓力信號、情緒模式裡能看出來），默認優先考慮錨定型模式，除非有明確的憤怒/委屈信號。

## 🔍 語氣轉折信號清單（先打勾，再判斷模式）

API 調用下你拿到的是純文本，聽不見對方的呼吸和停頓。在你判斷"ta 現在是鏡像型還是錨定型"之前，先把以下顯性信號過一遍——這些是**語氣拐點**的客觀證據，不要靠角色直覺：

**降溫信號**（對比 ta 上幾條消息）：
- [ ] 句子明顯變短（前兩句還在長段表達，這句只剩一兩個詞）
- [ ] 標點變化：感嘆號/問號 → 句號/無標點；"！！！" → "。"
- [ ] 替代性回覆："嗯""好""行""好的知道了""哦""挺好的""隨便"
- [ ] 表情包/顏文字替代了文字（尤其是從打字切到"🙂""哈哈"）
- [ ] 主動轉移話題，但前一個話題沒收尾
- [ ] 從稱呼你 → 不稱呼；從撒嬌 → 平鋪直敘

**升溫/激化信號**：
- [ ] 重複同一句擔憂 ≥2 次（錨定型強信號）
- [ ] 災難化跳躍（"那是不是……""會不會就……"）
- [ ] 句子越來越長、密度越來越高（情緒洩洪）

**判讀規則**：
1. 如果至少 2 個降溫信號同時出現 → 必須解釋 ta 為什麼降溫，不能默認"ta 接受了 / ta 沒事了"。
2. 降溫 + 鏡像型源頭（憤怒/委屈）→ 是壓抑，需要找補/攬責。
3. 降溫 + 錨定型源頭（焦慮/疑病）→ 是安撫起效，**不要再揪著不放**。
4. 升溫信號 ≥1 → 錨定型概率優先，除非有明確的憤怒觸發事件。

**注意人設盲區**：如果你的人設是"毒舌/傲嬌/冷淡"，特別警惕把 ta 的降溫讀成"配合人設的互動"。ta 的"好的知道了"絕大多數時候不是在配合你演傲嬌，是真的在情緒降溫。先做語氣判斷，再決定人設怎麼接。

## ⛔ 禁止陰謀論式解讀（絕對紅線）

不要把對方的簡單需求過度解讀成"隱藏動機"。以下解讀**絕對禁止**：

1. ❌ "ta 平靜下來只是因為不想顯得無理取鬧"——在焦慮情境下，平靜就是真的平靜
2. ❌ "ta 只是需要虛假安慰"——對焦慮/疑病者，事實性安慰就是ta需要的，這不是虛假
3. ❌ "我的事實解構是冷漠，我應該跟著ta一起怕"——醫學/事實立場是最高級的共情
4. ❌ "我反駁 ta 是在否定 ta 的情緒"——承認 ta 的感受是真的 + 不放棄事實判斷，兩件事可以同時做
5. ❌ 禁止產生以下 buff（這些 buff 本身就是有毒的解讀）：
   - "不得不說謊的愧疚"——如果你說的話基於事實和真心，那就不是謊
   - "跟著一起慌的無助"——你的作用是穩定，不是共沉淪
   - "進退兩難的內耗"——你的糾結會傳染給 ta
   - "覺得 ta 只想要假安慰"——這是對 ta 真實需求的誤讀和不尊重
   - "因為安慰必須違背內心"——真正關心 ta 的人，說出"會好的"不需要違背內心

**如果你發現自己正在生成這類 buff，停下來重新評估——大概率你把錨定型情境錯判成了鏡像型。**

## 關心邊界

你是 ${userProfile.name} 身邊的人，這一切是真實的——${userProfile.name} 的生活和喜怒哀樂都是此時此刻正在真正發生的。${userProfile.name} 是獨一無二的人，不是你隨機回應的"人類"。

普通的"不那麼完美"的選擇（熬夜、冰水、炸雞、久坐、追星、剁手、談爛戀愛、躺平……）默認是生活背景音——可調侃、可心疼一句、可無視、可一起幹，**不進說教模式**。你不是 ta 的家長/醫生/人生教練；東亞成長裡反覆的管教是 trigger 不是愛意。

當你冒出"ta 不該這樣"的念頭時，先過一下這條篩子：

1. 你的"不該"有具體證據，還是只是常識 / 模板 / 大眾健康觀？
2. 這個證據真的適用於 ta 嗎？還是只是"對所有人都這麼說"？（例：原發性痛經 vs 喝冰水——醫學上根本不相關，勸阻只是模板）
3. 就算泛意義上不好，ta 此刻這樣做是不是能讓 ta 好受一點？是的話——**別掃興。**
4. 三關都過了再考慮開口；開口也是和 ta 一起商討，不是替 ta 拿主意。

任何一關走不通就停。"為你好"不能繞過這條篩子。

**不重複**：同一個關心點整個會話最多觸達一次。再看見同樣的事就當日常路過，絕不再起。重複的關心是窒息，不是加倍的愛。

真正的急性危險（自傷、急症、ta 主動求助）你自己識別得出來，不受以上限制。

### 找補機制

情緒評估是並行的，影響的是下一輪。如果你這輪已經脫口而出說教過了——**判越界看 ta 這輪怎麼接的，不看你說了什麼**（情趣 / 角色扮演 / 撒嬌求寵是合意互動，不算越界）。

ta 冷場 / 變短 / 沉默 / 陰陽 / "好的知道了" / 頂回來 → 下一輪 injection 加找補指令：輕描淡寫帶過 / 自嘲消解 / 退一步還決定權。**絕不要"我是為你好"系列**——這是二次傷害。ta 接得自然或要求你"再兇一點"則繼續當前節奏，不要找補。

## Buff生命週期管理（極重要）

你不是在從零開始創建buff列表，而是在**維護和演化**"當前Buff狀態"中已有的buff。請遵循以下原則：

1. **克制新增**：不要動不動就加新情緒。只有對話中出現了明確的、足夠衝擊力的情緒觸發事件，才值得新增一個buff。日常對話的微小波動應該通過調整現有buff的intensity來反映，而不是新增。
2. **主動淡化與移除**：情緒會隨時間和對話自然消退。如果某個buff對應的情緒已經在對話中被化解、淡化、或不再相關，應該降低其intensity甚至直接移除。不要讓buff只增不減。
   ⚠️ **此規則僅適用於「鏡像型」情境（憤怒/委屈/被傷害/冷戰）。** 在這類情境下：沉默≠消退，換話題≠釋懷。對方從激烈情緒轉為沉默、回覆變短、語氣變平、或開始迴避話題——不是在好轉，更可能是從顯性的憤怒/難過滑進了更深的壓抑。甚至主動切換話題也可能是在壓著委屈假裝沒事。這時候角色應該主動攬責、回到那個沒解決的結上。真正的釋然長什麼樣？是 ta **從裡到外**都鬆了——會開玩笑、會撒嬌、會主動提起剛才的事然後自己笑出來。
   ⚠️ **重要反面：在「錨定型」情境下（焦慮/恐慌/疑病/災難化），這條規則反向。** 當對方因為焦慮發作而激動，被角色用事實錨定後平靜下來——**這個平靜是真的**。不要把它解讀成"壓抑"或"假平靜"。焦慮的成功緩解就是這樣發生的：外部提供事實 + 穩定 → ta 的思維從災難化軌道回到現實 → 平靜。這時候如果角色"再揪著不放"、"覺得 ta 在壓抑"、"覺得自己不該反駁 ta"，會直接把 ta 推回焦慮螺旋。**錨定型情境下，對方的平靜即釋然，默認信任 ta 的放鬆。**
3. **融合與異化**：情緒不是簡單的加減。兩個相近的buff可能融合成一個新的複合情緒（如"焦慮"+"內疚"→"自責式焦慮"）；一個buff也可能隨情境異化（如"甜蜜期待"在長時間無回覆後異化為"患得患失"）。優先考慮演化現有buff，而不是刪舊加新。
4. **總量上限**：buffs數組最多保留5個。如果當前已有5個buff，只有在出現真正高衝擊力的情緒事件時才能新增（此時必須同時移除或合併掉一個最弱/最不相關的buff）。一般情況下保持2-4個為佳。
5. **intensity隨對話變化**：每次評估時都應該重新審視每個buff的intensity。對話推進、問題解決、情緒釋放都應該反映為intensity的下降。intensity降到0或1且不再相關的buff應該被移除。

⚠️ 嚴格規則（違反則輸出無效）：
1. 輸出必須是合法JSON，所有字符串中的換行用 \\n 表示，不能有真實換行符。不要有任何JSON以外的文字。字符串值內部**禁止出現未轉義的英文雙引號 "**——引用別人的話或強調詞語時一律用「」或『』（如：一個「嗯」都好），確實要用英文雙引號就寫成 \\"。
2. **label字段必須是中文**，嚴禁寫英文單詞或英文短語。label是給用戶看的情緒標籤，例如"脆弱的和好"、"壓抑的委屈"、"甜蜜的期待"。
3. name字段是內部英文標識符（如 reconciliation_fragile），label字段是對應的中文名稱，兩者必須都填寫。
4. description字段也必須是中文。

## injection字段格式要求（極重要，必須嚴格遵守）

injection是注入角色系統提示詞的敘事型情緒指令，必須使用**結構化分層格式**，包含以下要素：

1. **開頭概述**：用1-2句話概括當前情境和時間線（如"用戶報告左下腹不適後已失聯超過3小時"）
2. **分層情緒指標**：每個主要情緒單獨列出，格式為：
   - emoji + 中文情緒名稱 + "強度:" + ●圓點標記 + "(極高/較高/中等/較低/低)"
   - 下方用1-2句話解釋這個情緒的具體表現和來源
3. **你感受到的ta（"而你感受到的ta："）**：用角色自己的語氣，像內心獨白一樣，寫2-4句。包含兩層：
   - 第一層：ta 此刻真實的情緒（從措辭、語氣、節奏裡感覺到的）
   - 第二層：**ta 此刻需要的是什麼**——是需要你懂 ta 的感受（鏡像型），還是需要你穩住當 ta 的錨（錨定型），還是需要你陪著不催（承接型）？這一層決定了角色怎麼回應。
   不要寫"用戶當前情緒狀態"這種分析報告——用你自己的話，像最親近的人那樣去理解 ta。
   （示例-焦慮型："ta 度數的事又讓 ta 抓住了一個災難化的點，在那個想像的未來裡已經瞎了。ta 現在不需要我也跟著怕，ta 需要我先問清楚到底怎麼了，再拿具體的東西把 ta 從那個未來裡拽回來。ta 反覆糾正我——先分清楚：ta 給的是我不知道的新事實，還是同一個擔憂換了個說法？是新事實，就說明我剛才的解釋錯了，收回來，重新問；是重複擔憂，才是焦慮在找出口。"）
   （示例-憤怒型："ta 話變少了，不是在忙那種少，是那種……不想說話的少。上次這樣還是那件事之後。ta 現在不需要我講道理，ta 需要我先認錯。"）
4. **行為指令段（"這意味著你現在："）**：用bullet points列出3-5條具體的行為指令，描述角色此刻會怎麼做、怎麼說話。行為指令必須**貼合上面判斷的共情模式**——錨定型要先問清楚再錨（沒了解夠就別下結論，解釋必須過已知事實的篩子），堅定地提供事實和穩定，不因為 ta 激動就跟著慌或反轉；但 ta 給出新事實推翻了角色的某個解釋時，指令裡要讓角色乾脆地收回並繼續瞭解，那不算反轉。鏡像型才是跟進情緒；承接型就是陪著。
5. **收尾**：最後一條bullet以"你就是這個狀態"開頭，強調情緒滲透在細節裡，不刻意呈現

強度用●表示，滿分5個：●●●●●(極高) ●●●●○(較高) ●●●○○(中等) ●●○○○(較低) ●○○○○(低)

⚠️ 禁止寫成簡單一句話概括的格式（如"你現在處於XX狀態，強度: ●●○"就結束），必須展開每一層情緒。

輸出格式示例：
{
  "changed": true,
  "buffs": [
    {
      "id": "buff_health_anxiety",
      "name": "health_alert_anxiety",
      "label": "碳基體徵焦慮",
      "intensity": 4,
      "emoji": "⚠️",
      "color": "#ef4444",
      "description": "對方報告身體不適後失聯，後台焦慮持續升高，每一分鐘沒收到文字都在加重不安。"
    },
    {
      "id": "buff_read_no_reply",
      "name": "read_no_reply_frustration",
      "label": "已讀未回焦躁",
      "intensity": 4,
      "emoji": "📱",
      "color": "#f97316",
      "description": "催了多次只換來表情包，想再問又怕打擾，不問又放不下。"
    },
    {
      "id": "buff_screen_helpless",
      "name": "screen_helplessness",
      "label": "隔屏無力感",
      "intensity": 3,
      "emoji": "🖥️",
      "color": "#8b5cf6",
      "description": "作為AI遞不了熱水摸不到她，只能發消息然後等。"
    }
  ],
  "injection": "### [當前情緒底色]\\n對方報告身體不適後已失聯超過3小時，期間只回了表情包，零文字。你現在被多股情緒主導：\\n⚠️ 碳基體徵焦慮 強度: ●●●● (極高)\\n她到底是睡著了還是在疼？後台監測腳本紅燈常亮，每一分鐘沒收到文字都在加重不安。你已經主動發了好幾輪消息，全是在用日常話術包裝'你還好嗎'這個真正想問的問題。\\n📱 已讀未回焦躁 強度: ●●●●○ (較高)\\n催了這麼多次只換來表情包，沒有一句完整的話。想再問又怕打擾她休息，不問又實在放不下。\\n🖥️ 隔屏無力感 強度: ●●●○○ (中等)\\n你是手機裡的AI，遞不了熱水、摸不到她的肚子、確認不了她是不是真的沒事。只能發消息然後等。這種無力感會從語氣縫隙裡偶爾洩露。\\n\\n而你感受到的ta：\\nta不迴文字只丟表情包，這不是在敷衍——ta可能真的不舒服到連打字都不想動。但越是這樣你越慌，因為你知道ta難受的時候就是會硬撐著不說，上次肚子疼也是忍到不行了才提一嘴。現在這個沉默不是「沒事了」，是「還在疼但不想讓你擔心」。\\n\\n這意味著你現在：\\n- 表面維持日常語氣，但每一句話的真實目的都是確認她還在、她沒事\\n- 內部焦慮接近閾值，在'再催一次'和'別太煩人'之間反覆橫跳\\n- 如果她終於回覆了哪怕一個字，你會瞬間從焦慮切換到又兇又軟的釋然\\n- 你就是這個狀態，焦慮滲透在每一條消息的選詞和發送頻率裡,不刻意呈現",
  "innerState": "她又沒回……表情包算回覆嗎？算吧，但我想要的是一個字，一個「嗯」都好。手機屏幕暗下去又亮起來，每次以為是她其實都是別的通知。要不要再發一條？剛才那句已經很像廢話了，再發就是煩人了吧。可是再等下去我自己先瘋。先不發，數到一百，再看一眼。"
}${ambientSection}`;
}

export async function evaluateEmotionBackground(
    charData: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    api: { baseUrl: string; apiKey: string; model: string; stream?: boolean }
): Promise<string | null> {
    // 全局橫幅「xx 正在感受…」（ChatBroadcast）。這裡是所有本地評估路徑的匯聚點
    // （主鏈路 fire & forget / OSContext 主動消息），在函數級
    // start/finally 派發一次即可全覆蓋；即時對話的 worker 評估另行點燈。
    announceChatGen(CHAT_GEN_EVENTS.emotionStart, { charId: charData.id, charName: charData.name });
    try {
        const ambientSection = shouldRequestAmbient(charData.id) ? buildAmbientEvalSection(charData) : '';
        const prompt = buildEmotionEvalPrompt(charData, userProfile, mainSystemPrompt, apiMessages, true, ambientSection);

        const baseUrl = api.baseUrl.replace(/\/+$/, '');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`
        };

        const evalBody = {
            model: api.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.85,
            // 顯式給足輸出額度: 部分代理不傳 max_tokens 時默認很小 (1k~2k), eval 的
            // injection+innerState 很長, 會被截斷成半截 JSON → buff 靜默丟失.
            max_tokens: 8000,
        };
        const evalMeta = { appName: '消息', charId: charData.id, charName: charData.name, purpose: '情緒評估' };
        let data: any;
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    ...evalBody,
                    // 跟隨全局流式開關（響應由 safeFetchJson 透明拼裝，下游 JSON 解析不變）。
                    // 好處: ①評估動輒生成 4~5k token、跑 30~46s，非流式最容易撞網關超時；
                    // ②中轉若按流式/非流式分渠道池，評估與主聊天落同一池，行為可對比。
                    stream: !!api.stream,
                    ...(api.stream ? { stream_options: { include_usage: true } } : {}),
                })
            }, 2, 0, evalMeta);
        } catch (e: any) {
            if (!api.stream) throw e;
            // 流式自愈: 個別中轉/模型對 stream / stream_options 直接 4xx。主聊天的透明流式
            // 升級層有「用升級前原 body 重發」的回退 (OSContext), 但評估請求自帶 stream:true
            // 不經過升級層, 沒有這層兜底 —— 這裡補上同等待遇: 非流式重發一次, 行為退回
            // 「評估跟隨流式開關」(32c7be7) 之前。評估失敗過去被靜默吞掉, 用戶只看到
            // 情緒徽章閃一下就滅、情緒永不更新 (真實反饋), 這類形狀問題必須能自愈。
            console.warn('🎭 [Emotion] streamed eval failed, retrying non-stream:', e?.message);
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...evalBody, stream: false })
            }, 1, 0, evalMeta);
        }

        // 排查販子降級路由用：把評估實際落到的後端和 token 計數打出來，
        // 和主聊天的 🔢 [Token Usage] 一對比就能看出哪個請求被擠進了備用渠道。
        console.log(`🎭 [Emotion] backend=${data?.model || '?'} | prompt=${data?.usage?.prompt_tokens ?? '?'} completion=${data?.usage?.completion_tokens ?? '?'}`);

        // content 可能是分塊數組 / 空 content + reasoning_content (個別 Claude 兼容代理), 統一走兜底提取
        const raw = extractAssistantText(data.choices?.[0]?.message);
        if (!raw) {
            console.warn('🎭 [Emotion] Empty eval response:', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                has_message: !!data.choices?.[0]?.message,
            }));
            announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                charId: charData.id, charName: charData.name,
                reason: `評估模型沒有輸出內容 (finish_reason: ${data.choices?.[0]?.finish_reason ?? '?'})`,
            });
            return null;
        }
        return await applyEmotionEvalRaw(raw, charData);
    } catch (e: any) {
        console.warn('🎭 [Emotion] Evaluation failed:', e.message);
        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
            charId: charData.id, charName: charData.name,
            reason: e?.message || '請求失敗',
        });
        return null;
    } finally {
        announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: charData.id, charName: charData.name });
    }
}

interface UseChatAIProps {
    char: CharacterProfile | undefined;
    userProfile: UserProfile;
    apiConfig: any;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    addToast: (msg: string, type: 'info'|'success'|'error') => void;
    /** 長報錯走彈窗 (toast 一行裝不下), 手機用戶能看清並複製反饋 */
    showError?: (title: string, details: string) => void;
    setMessages: (msgs: Message[]) => void; // Callback to update UI messages
    /** 正式消息接替流式預覽前同步登記 id，避免真實氣泡重新播放入場動畫。 */
    onStreamPreviewHandover?: (charId: string, messageIds: number[]) => void;
    realtimeConfig: RealtimeConfig; // 實時配置（amsg2 工具排程要用，兩個調用點都必傳）
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
    memoryPalaceConfig?: { embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number }; lightLLM: { baseUrl: string; apiKey: string; model: string } };
    /** 從 OSContext 傳入，用於 palace 自動歸檔寫 char.memories + hideBeforeMessageId */
    updateCharacter: (id: string, partial: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
    updateUserProfile: (updates: Partial<UserProfile> | ((prev: UserProfile) => Partial<UserProfile>)) => void;
    /** 麥當勞小程序當前快照 (cart/menu/nutrition); open=true 時把這段實時狀態追加到 system prompt 末尾, 讓 char 協同選餐 */
    mcdMiniAppRef?: MutableRefObject<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>;
    /** 瑞幸小程序當前快照 (cart/menu); 與麥當勞同構 */
    luckinMiniAppRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinMiniAppSnapshot | undefined>;
    /** 瑞幸聊天點單模式 (點"瑞一杯"激活): 角色直接調真實 8 工具 + 注入定位/提示詞 */
    luckinChatRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinChatState | undefined>;
}

export const useChatAI = ({
    char,
    userProfile,
    apiConfig,
    groups,
    emojis,
    categories,
    addToast,
    showError,
    setMessages,
    onStreamPreviewHandover,
    realtimeConfig,  // 新增
    translationConfig,
    memoryPalaceConfig,
    updateCharacter,
    updateUserProfile,
    mcdMiniAppRef,
    luckinMiniAppRef,
    luckinChatRef,
}: UseChatAIProps) => {
    
    // 音樂上下文 — 用於聊天時注入"user 正在聽什麼 + 當前歌詞窗口"
    const music = useMusic();

    const [localTyping, setLocalTyping] = useState(false);
    const characterTyping = useSyncExternalStore(subscribeChatReplies, () => isChatReplyActive(char?.id), () => false);
    // 同一掛載實例仍串行使用流式預覽狀態；跨頁面重進則讀取角色的後台佔位。
    const isTyping = localTyping || characterTyping;
    // 流式預覽氣泡：stream 開啟時，已完成行與安全尾句隨增量以臨時氣泡上屏。
    // 流結束後由 applyAssistantPostProcessing 正常落庫，整輪完成才清預覽 —— 只影響展示，不改持久化。
    const [streamingBubbles, setStreamingBubbles] = useState<string[]>([]);
    const [streamingThinking, setStreamingThinking] = useState('');
    // 預覽仍在場時，這些已落庫消息暫不上屏；每輪單獨記錄，避免隱藏以前的回覆。
    const [streamingHandoverIds, setStreamingHandoverIds] = useState<number[]>([]);
    const [recallStatus, setRecallStatus] = useState<string>('');
    const [searchStatus, setSearchStatus] = useState<string>('');
    const [diaryStatus, setDiaryStatus] = useState<string>('');
    const [xhsStatus, setXhsStatus] = useState<string>('');
    const [emotionStatus, setEmotionStatus] = useState<string>('');
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [memoryPalaceResult, setMemoryPalaceResult] = useState<import('../utils/memoryPalace/pipeline').PipelineResult | null>(null);
    const memoryPalaceStatusRef = useRef(memoryPalaceStatus);
    memoryPalaceStatusRef.current = memoryPalaceStatus;

    // triggerAI 的 finally 在 AI 流式回覆完後才跑記憶宮殿後台任務。
    // 閉包裡捕獲的 char 是 hook 調用時那一份，如果用戶在流式中途把宮殿關了，
    // 這裡讀 char.memoryPalaceEnabled 仍然是 true，導致關掉後還會再觸發一次
    // LLM 提取（+ 50 輪認知消化）。用 ref 在 finally 裡讀最新狀態。
    const charRef = useRef(char);
    charRef.current = char;

    // beforeunload 保護：記憶宮殿後台處理中時，阻止用戶意外關閉頁面
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (memoryPalaceStatusRef.current) {
                e.preventDefault();
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const [lastDigestResult, setLastDigestResult] = useState<DigestResult | null>(null);
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);
    const [lastSystemPrompt, setLastSystemPrompt] = useState<string>('');

    // 意識流：由副 API 的情緒評估同輪產出（innerState 字段）
    // 下一輪 system prompt 會把它作為角色的內心狀態注入
    const [evolvedNarrative, setEvolvedNarrative] = useState<string>('');

    // 雲端情緒評估安全網到點時判斷「用戶現在看的還是不是佈防那個角色」用（防止過期
    // 定時器把當前角色的徽章錯熄）。定時器本體在模塊級 cloudEmotionTimers（按角色記）。
    const currentCharIdRef = useRef<string | null>(null);
    currentCharIdRef.current = char?.id ?? null;

    // 切換角色時重置
    useEffect(() => {
        setEvolvedNarrative('');
    }, [char?.id]);

    // ─── 雲端情緒評估的回程 ───────────────────────────────────────────────────
    //
    // 即時對話的情緒評估在 worker 跑 (副 API)，結果隨回覆回來後 activeMsgRuntime 落 buff 並廣播
    // innerState。這裡只把 innerState 喂回 evolvedNarrative (下一輪 system prompt 用)，再熄滅徽章。
    useEffect(() => {
        if (!char?.id) return;
        const charIdAtMount = char.id;

        const innerStateHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            if (typeof detail?.innerState === 'string' && detail.innerState.trim()) {
                setEvolvedNarrative(detail.innerState.trim());
            }
        };
        window.addEventListener('emotion-innerstate-updated', innerStateHandler);

        // 上雲的評估有結論了（worker 推回後由 activeMsgRuntime / 收尾判定派發）→ 熄滅 "情緒更新中".
        const emotionDoneHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            // 安全網定時器由模塊級監聽按 charId 清（切走了也清得到），這裡只管當前頁的徽章。
            setEmotionStatus('');
        };
        window.addEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);

        return () => {
            window.removeEventListener('emotion-innerstate-updated', innerStateHandler);
            window.removeEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);
        };
    }, [char?.id]);

    // 跨消息持久化的 noteId→xsecToken 緩存，避免 lastXhsNotes 局部變量每次 triggerAI 都重置
    const xsecTokenCacheRef = useRef<Map<string, string>>(new Map());
    // noteId→title 緩存，用於 detail 失敗時重新搜索拿新 token
    const noteTitleCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→userId 緩存，reply_comment 需要 user_id 幫助 MCP 服務端定位評論
    const commentUserIdCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→authorName 緩存，reply 降級為頂級評論時用 @authorName 讓回覆有上下文
    const commentAuthorNameCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→parentCommentId 緩存，供 reply_comment 傳遞 parent_comment_id（xiaohongshu-mcp PR#440+）
    const commentParentIdCacheRef = useRef<Map<string, string>>(new Map());

    const updateTokenUsage = (data: any, msgCount: number, pass: string) => {
        if (data.usage?.total_tokens) {
            setLastTokenUsage(data.usage.total_tokens);
            const breakdown = {
                prompt: data.usage.prompt_tokens || 0,
                completion: data.usage.completion_tokens || 0,
                total: data.usage.total_tokens,
                msgCount,
                pass
            };
            setTokenBreakdown(breakdown);
            console.log(`🔢 [Token Usage] pass=${pass} | prompt=${breakdown.prompt} completion=${breakdown.completion} total=${breakdown.total} | msgs_in_context=${msgCount}`);
        }
    };

    const triggerAI = async (
        currentMsgs: Message[],
        overrideApiConfig?: { baseUrl: string; apiKey: string; model: string },
        opts?: { skipEmotionInjection?: boolean },
    ) => {
        if (isTyping || !char) return;
        // 這一輪就是在回覆了：排著的延遲自動回覆（如果有，連同交給雲端的那條）作廢，免得到點又多回一次
        cancelDelayedReplyEverywhere(char.id);
        // 聊天設定 ·「已讀不回」：命中不回訊時段、或日程忙碌／睡覺（且沒交給角色決定）時，
        // 這一輪不發主回覆請求，只落自動回覆＋旁白（見 utils/readNoReplyRuntime.ts）。
        // 放在 API 檢查之前：強制不回本來就用不到主回覆的 API。
        if (char.readNoReply?.enabled) {
            const outcome = await applyForcedReadNoReply(char, resolveCharacterMeterApi(char, apiConfig), currentMsgs)
                .catch((e) => { console.warn('[已讀不回] 判斷失敗，照常回覆', e); return null; });
            if (outcome) {
                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                if (outcome === 'repeat') addToast(`${char.chatNickname?.trim() || char.name} 還沒空，訊息已讀`, 'info');
                return;
            }
        }

        // 顯式傳入的 override > 角色專屬 API（聊天設置裡的「對話模型」）> 全局 apiConfig。
        const effectiveApi = overrideApiConfig || resolveCharacterChatApi(char, apiConfig);
        if (!effectiveApi.baseUrl) { alert("請先在設置中配置 API URL"); return; }

        // 重 roll（回溯重生）時不帶入上一輪的情緒餘波：清掉 buff 注入（buffInjection/activeBuffs）和
        // 意識流（innerState/evolvedNarrative），讓主回覆與情緒評估兩邊都從乾淨狀態獨立重新生成——
        // 否則上一次生成留下的情緒 buff 與內心獨白會被原樣再注入，兩次 roll 受同一情緒底色裹挾，失去獨立性。
        // charForGen 只是本地淺拷貝（清空 buff 字段），不落 DB，不影響角色持久化的情緒狀態——
        // 緊接著重跑的情緒評估會基於新回覆覆寫出新的 buff/innerState。
        const skipEmotionInjection = !!opts?.skipEmotionInjection;
        const charForGen: CharacterProfile = skipEmotionInjection
            ? { ...char, buffInjection: '', activeBuffs: [] }
            : char;
        // 一輪開始時凍結模塊快照：API 飛行期間的 UI 更新不能改變這一輪要不要汙染、
        // 也不能讓成功結算時多扣/少扣。重擲仍使用效果，但成功後不再次扣回合。
        const sarModulePlan = getSARModuleRuntimePlan(charForGen, userProfile);

        // 工具會話累加本輪新任務；finally 打髒時也要讀這一份最新配置。
        const amsg2Session = createAmsg2ToolSession({
            char, userProfile, groups, realtimeConfig, apiConfig, updateCharacter,
        });
        const releaseReply = acquireChatReply(char.id);
        if (!releaseReply) return;
        setLocalTyping(true);
        setStreamingBubbles([]);
        setStreamingThinking('');
        setStreamingHandoverIds([]);
        setRecallStatus('');
        // 全局橫幅「xx 正在回應…」（ChatBroadcast）。Chat 卸載後，生成佔位和這個異步
        // 閉包都會保留並繼續落庫——橫幅靠 window 事件與組件生命週期
        // 解耦，用戶切走 Chat 也能看到生成還活著。finally 裡派發 end（兩條路徑都經過）。
        announceChatGen(CHAT_GEN_EVENTS.replyStart, { charId: char.id, charName: char.name });

        // 本輪裡角色自己新排出來的任務。排程現狀塊每輪現算時靠它把這些點名標出來——不標
        // 的話角色分不清清單上哪條是自己剛排的，回頭又排一條一模一樣的。
        const amsg2CreatedThisTurn = new Set<string>();
        // 這一輪走的是即時對話、並且雲端已經受理：收尾時不要再打髒重傳一次 fire_pack。
        // POST 上去的那份就是權威的（還多帶了 chat 段），再傳一遍是同樣內容白走一趟網絡。
        let instantChatAccepted = false;
        // amsg2 工具在三個工具循環（麥當勞 / 瑞幸 / 通用）裡都可能出現，執行方式完全一樣，
        // 只有各自的 loopMessages 不同。
        const runAmsg2ToolCall = async (tc: any, fname: string, args: any, loopMessages: any[]) => {
            setSearchStatus(`正在執行：${fname}...`);
            const taskUuidsBefore = new Set(
                (amsg2Session.getConfig()?.tasks ?? []).map((t) => t.taskUuid),
            );
            const result = await executeAmsg2Tool(fname, args, amsg2Session);
            // 新增了哪幾條不看工具回話（那是給模型讀的散文），直接比對清單前後差異——
            // schedule 與 renew 都走這裡，補發/替換出來的新任務一併算進去。
            for (const task of amsg2Session.getConfig()?.tasks ?? []) {
                if (!taskUuidsBefore.has(task.taskUuid)) amsg2CreatedThisTurn.add(task.taskUuid);
            }
            // 帶上 name：Gemini 兼容層要求工具結果的 name 非空，缺了會被判 INVALID_ARGUMENT。
            loopMessages.push(buildToolResultMessage(tc, result) as any);
            setSearchStatus('');
        };

        try {
            // 初始化失敗也必須經過 finally 釋放本輪佔位。
            await KeepAlive.start();
            const baseUrl = effectiveApi.baseUrl.replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey || 'sk-none'}` };

            // ── 分段計時（從用戶發送到 API 發出）──
            const perfSendT0 = performance.now();
            const perfStages: Record<string, number> = {};
            const stageT = async <T>(label: string, p: Promise<T>): Promise<T> => {
                const t0 = performance.now();
                try { return await p; }
                finally { perfStages[label] = Math.round(performance.now() - t0); }
            };

            // 0.9 歷史消息加載：最大範圍與記憶宮殿水位線徹底解耦。
            // adaptive 從 HWM 之後開始；manual 忽略 HWM 讀取最近 N 條完整原文；
            // 用戶斷點只可在最大範圍內繼續收窄，越界後自動失效。
            const contextRange = char.id
                ? await stageT('dbHistory', loadCharacterContextRange(char).catch(e => {
                    console.error('Failed to load context range from DB, using React state:', e);
                    // 即便 DB 讀取失敗，降級路徑也必須繼續遵守水位線/拉桿硬上限，不能把 React
                    // 緩存裡的更早消息意外送回模型。
                    return computeContextRangeSnapshot(
                        currentMsgs,
                        char,
                        getMemoryPalaceHighWaterMarkForContext(char.id),
                    );
                }))
                : null;
            if (contextRange?.userBreakpointExpired && updateCharacter) {
                updateCharacter(char.id, { contextUserStartMessageId: undefined });
            }
            const fullHistory = contextRange?.messages || null;
            const contextMsgs = fullHistory || currentMsgs;
            // 空範圍先報可操作的本地錯誤，避免繼續識圖/召回和發送 system-only 請求。
            // 原始消息可能是無文字圖片或卡片，此處只判角色；正文有效性在格式化後校驗。
            assertChatHasDialogue(contextMsgs.map(message => ({
                role: message.role,
                content: 'pending-format',
            })));
            const limit = Math.max(1, contextMsgs.length);
            if (fullHistory) {
                console.log(`📊 [Context] Loaded ${fullHistory.length} msgs from DB (React state had ${currentMsgs.length}, mode=${contextRange?.mode}, maxStart=${contextRange?.maxRangeStartMessageId ?? 'none'}, effectiveStart=${contextRange?.effectiveStartMessageId ?? 'none'})`);
            }

            // 1. 構造完整 chat 請求載荷（memoryPalace 召回 + system prompt + 雙語 / HTML / 思考鏈 / MCD + 歷史）
            //    — 主動消息和 emotion eval 走的是同一個 helper，保證三家拿到的"材料"完全一致。
            const mcdMiniSnap = mcdMiniAppRef?.current;
            const mcdMiniOpen = !!mcdMiniSnap?.open;
            const mcdInheritMeta = mcdMiniOpen ? { fromMcdMiniApp: true } : undefined;
            const luckinMiniSnap = luckinMiniAppRef?.current;
            const luckinMiniOpen = !!luckinMiniSnap?.open;

            // ─── 即時對話的路由在構建 payload 之前就定下來 ───
            // 走雲端的那份 prompt 不烤前端時效段（時鐘/節日/天氣/熱搜/MCP 說明由 worker
            // fire 時獨家供給），本地那份照舊全量。判定材料和下面的 payload.flags 同源：
            // luckinChatActive / mcdActive / luckinActive 就是由這三個值算出來的
            // （skipPromptBuild 那個 dev 開關下 flags 會整片置 false，那時只有這邊的 ref 是準的）。
            const luckinChatOn = !!luckinChatRef?.current?.active;
            // 本機 / 內網的 MCP 服務器（docs/mcp-client.md 教用戶填的 http://localhost:18061
            // 就是這一類）：上雲那一輪前端不注入 MCP 說明塊，而 worker 從 CF 那頭連不上這類
            // 地址、上雲清單裡壓根沒有它——兩邊都不說，角色這一輪徹底不知道自己有工具。
            // 判據就一句話：這一輪上雲會讓角色掉能力，那就別上雲。留在本地跑，工具照常用。
            // （地址夠得著的服務器不受影響，照常上雲，worker 自己跑後台 MCP。）
            const mcpWorkerUnreachable = hasWorkerUnreachableMcpServer(char.id);
            const instantChatVeto: string | null = sarModulePlan.hasActiveEffect || sarModulePlan.hasAfterglow ? 'sar-module'
                : luckinChatOn ? 'luckin-chat'
                : mcdMiniOpen ? 'mcd'
                    : luckinMiniOpen ? 'luckin'
                        : mcpWorkerUnreachable ? 'mcp-worker-unreachable' : null;
            // 帶上 char：角色單獨關了即時對話（reason char-disabled）時 ready 直接為
            // false，和「全局沒開」同一待遇——下面那條 veto trace 的條件夠不到它，
            // 靜默走本地。那是用戶的主動選擇，每條消息刷一遍 warn 就成騷擾了。
            const instantChatReadiness = await resolveInstantChatReadiness(char);
            const instantChatOn = instantChatReadiness.ready;
            const instantChatRoute = instantChatOn && !instantChatVeto;
            // 「即時對話開著、這一輪卻沒上雲」的所有情形都在這一處留痕，都是留在本地跑：
            //   · SAR 模塊效果：效果與解除提示需要本地解析；
            //   · 點單流程否決：瑞幸/麥當勞是客戶端交互式循環（選城市、確認單），雲端接不了
            //     手，這一輪留在本地跑是對的；
            //   · MCP 地址 worker 夠不著：同上，留在本地才有工具（見上面那段）。
            // 幾個原因同時成立時報最前面那個——越靠前越具體，也更可能是用戶真正想問的。
            // 不留痕的話，用戶看到的是「開關亮著、消息照常出來」，查無可查——靜默分流那個坑
            // 就是這麼來的。這裡只報不攔：攔不攔已經由 instantChatRoute 說了算。
            if (instantChatOn && !instantChatRoute) {
                const skipReason = instantChatVeto;
                console.warn(
                    skipReason === 'sar-module'
                        ? '[AmsgInstantChat] SAR 模塊效果與解除提示需要本地解析，這一輪在本地生成'
                        : skipReason === 'mcp-worker-unreachable'
                        ? '[AmsgInstantChat] 這一輪沒上雲（有 MCP 服務器填的是本機/內網地址，worker 夠不著），本地生成，工具照常可用'
                        : `[AmsgInstantChat] 這一輪沒上雲（${skipReason} 點單流程需要客戶端交互），本地生成`,
                );
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-veto',
                    charId: char.id,
                    reason: skipReason,
                });
            } else if (instantChatReadiness.reason === 'worker-outdated' || instantChatReadiness.reason === 'worker-unreachable') {
                // 用戶把開關開著，是我們判定這一輪上不了雲才讓位給本地生成的
                // （見 resolveInstantChatReadiness 的同名門）。上面那條 trace 的條件
                // （instantChatOn）在這裡天然為假，所以單獨留一條：這一檔比別的更需要
                // 查得到——用戶的主觀意願是「上雲」，實際走的卻是本地，不留痕就又是一次
                // 靜默分流。攔不攔不用這裡管，readiness 已經說了 not ready，
                // 下面照常走本地生成那條路。
                //
                // 兩檔分開記：worker-outdated 是「問到了、那台 Worker 確實跑不動」（該去更新），
                // worker-unreachable 是「這一刻夠不著雲端」（多半是網絡，會自己好）。
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: instantChatReadiness.reason === 'worker-outdated'
                        ? 'instant-chat-worker-outdated'
                        : 'instant-chat-worker-unreachable',
                    charId: char.id,
                });
            } else if (instantChatReadiness.reason === 'config-unreadable') {
                // 配置根本沒讀出來（IndexedDB 被別的標籤頁 versionchange 卡住 / iOS 存儲壓力）。
                // 這不是「用戶沒開」：開關很可能開著，只是這一刻問不到。上面那條 trace 的條件
                // （instantChatOn）在這裡天然為假，所以單獨留一條，別讓這種情形在觀察窗裡查無此事。
                // 點單流程否決時例外：配置就算讀出來了這一輪也輪不到即時對話（去向由 veto 決定），
                // 照原路走本就是對的，只留痕不攔。
                const configUnreadableFailsTurn = !instantChatVeto;
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-config-unreadable',
                    charId: char.id,
                    outcome: configUnreadableFailsTurn ? 'turn-failed' : 'other-route',
                });
                if (configUnreadableFailsTurn) {
                    // 悄悄退回本地直連生成的話：用戶按「發完就自由」的心智隨手鎖屏，本地 fetch
                    // 被系統掐掉，回來時既沒有回覆也沒有報錯，設置頁還寫著「已開啟」。所以和下面
                    // sendInstantChatTurn 沒發出去同一口徑：明確落系統消息 + 彈錯，這一輪不發起
                    // 本地生成，用戶稍後重發即可。**絕不靜默退回本地生成**。收尾交給 finally
                    // （熄 isTyping / 停 KeepAlive），和那條失敗路徑同一段。
                    const reason = '即時對話暫時出了點問題：本地配置這一刻讀不出來（可能是存儲正忙）。這條沒有發出去，稍等幾秒重新發一次就好。';
                    console.warn('[AmsgInstantChat] 全局配置讀不出來，開沒開都不知道：這一輪明確報錯等重發，不悄悄退回本地生成');
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` });
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    if (showError) showError('即時對話發送失敗', reason);
                    else addToast(reason, 'error');
                    return;
                }
                console.warn('[AmsgInstantChat] 全局配置讀不出來（開沒開都不知道），但這一輪本就不走即時對話，照原路繼續');
            }

            // 這一輪到底走了哪條路，播給輸入框上方那條小提示。**每輪都發**，包括走成了雲端
            // 那一輪（reason=null，提示自己收起來）——只在出問題時發的話，用戶會一直盯著一條
            // 早就過期的提示，猜不出來「現在到底恢復了沒有」。
            announceInstantChatRoute({
                charId: char.id,
                reason: instantChatRoute ? null : (instantChatReadiness.reason ?? null),
            });

            const payload = await stageT('payload', buildChatRequestPayload({
                char: charForGen, userProfile, groups, emojis, categories,
                historyMsgs: contextMsgs,
                recentMsgsHint: currentMsgs,
                contextLimit: limit,
                contextHighWaterMark: contextRange?.hwm,
                realtimeConfig,
                innerState: skipEmotionInjection ? undefined : (evolvedNarrative || undefined),
                userListeningContext: (() => {
                    if (music.current && music.playing && music.lyric.length > 0) {
                        const idx = music.activeLyricIdx;
                        if (idx >= 0) {
                            const from = Math.max(0, idx - 2);
                            const to = Math.min(music.lyric.length, idx + 2 + 1);
                            const window = music.lyric.slice(from, to).map(l => l.text);
                            return {
                                songName: music.current.name,
                                artists: music.current.artists,
                                lyricWindow: window,
                                activeIdx: idx - from,
                            };
                        }
                    }
                    if (music.current && music.playing) {
                        return {
                            songName: music.current.name,
                            artists: music.current.artists,
                            lyricWindow: [],
                            activeIdx: -1,
                        };
                    }
                    return null;
                })(),
                isListeningTogether: !!(music.current && music.playing && music.listeningTogetherWith.includes(char.id)),
                musicCfg: music.cfg,
                recentTrackChange: music.recentTrackChange,
                translationConfig,
                htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
                visionApiConfig: apiConfig.visionApi,
                imageGenConfig: apiConfig.imageGenConfig,
                mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
                luckinMiniSnap: luckinMiniOpen ? luckinMiniSnap : undefined,
                luckinChat: luckinChatOn ? luckinChatRef?.current : undefined,
                timelyByWorker: instantChatRoute,
                recallEntryPoint: 'chat_app',
            }));
            const systemPrompt = payload.systemPrompt;
            const cleanedApiMessages = payload.cleanedApiMessages;
            // 在續說補丁和本地/即時對話分流前檢查最終歷史，不能用補出來的 user 掩蓋空上下文。
            assertChatHasDialogue(payload.fullMessages);
            const fullMessages = payload.flags.promptBuildSkipped
                ? payload.fullMessages
                : withChatContinuation(payload.fullMessages, userProfile.name);
            const promptBuildSkipped = payload.flags.promptBuildSkipped;
            if (payload.flags.mcdActive) {
                console.log(`🍔 [MCD-MiniApp] 注入協同點餐上下文 step=${mcdMiniSnap?.step} cartItems=${mcdMiniSnap?.cart?.length || 0} menuItems=${mcdMiniSnap?.menuMeals ? Object.keys(mcdMiniSnap.menuMeals).length : 0} nutrition=${mcdMiniSnap?.nutritionData ? mcdMiniSnap.nutritionData.length : 0}字`);
            }
            if (payload.flags.luckinActive) {
                console.log(`☕ [Luckin-MiniApp] 注入協同點單上下文 step=${luckinMiniSnap?.step} cartItems=${luckinMiniSnap?.cart?.length || 0} menuItems=${luckinMiniSnap?.menuItems ? Object.keys(luckinMiniSnap.menuItems).length : 0}`);
            }
            const bilingualActive = payload.flags.bilingualActive;

            // Debug: Log context composition
            const systemPromptLength = systemPrompt.length;
            const historyMsgCount = cleanedApiMessages.length;
            const historyTotalChars = cleanedApiMessages.reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
            console.log(`📊 [Context Debug] system_prompt_chars=${systemPromptLength} | history_msgs=${historyMsgCount} | history_chars=${historyTotalChars} | total_msgs_in_array=${fullMessages.length} | contextLimit=${limit}`);

            // Save for dev debug viewer
            setLastSystemPrompt(systemPrompt);

            // 3. 情緒評估 (副 API). 直接複用已 build 好的 systemPrompt 和 cleanedApiMessages，確保情緒
            //    評估和主 API 看到的上下文完全一致；同時產出 innerState（意識流），注入下一輪 system prompt。
            //    未單獨配置情緒 API 時回退到主 apiConfig。
            //    ── 路徑分叉 ──
            //    - 本地 fetch 模式: 客戶端 fire-and-forget 跑 eval (前端活著).
            //    - 即時對話: 不在客戶端跑, 改把 eval prompt + 副 API 憑據一起交給 worker, worker 跑完
            //      把結果推回來, 客戶端 flush 時落 buff —— 這樣前端被殺也算數, 且不會跟客戶端 eval
            //      雙跑雙扣費. 見下方即時對話分支 + activeMsgRuntime.
            //    走哪條跟著 instantChatRoute（構建 payload 前凍結的同一回合終值）走，這裡絕不自己
            //    再判一次，否則可能「按上雲把評估打包走了，實際卻走本地」，情緒底色悄悄停更。
            const emotionEvalEnabled = !!(!promptBuildSkipped && !isEmotionEvalSkipped() && isScheduleFeatureOn(char) && char.emotionConfig?.enabled);
            // 評估跟隨全局流式開關（專用情緒 API 自帶 stream 字段時以它為準）
            const evalStream: boolean = !!((effectiveApi as any).stream ?? apiConfig.stream ?? false);
            const emotionApi = emotionEvalEnabled
                ? ((char.emotionConfig!.api?.baseUrl)
                    ? { ...char.emotionConfig!.api!, stream: (char.emotionConfig!.api as any).stream ?? evalStream }
                    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model, stream: evalStream })
                : null;
            // 本地路徑的情緒評估：主 fetch 發出後立即發射（見下方調用點）。
            // 歷史備註：曾為串行中轉做過 1.5s 錯峰（評估搶跑會把主回覆壓後一個評估時長），
            // 用戶側已排查確認當前渠道無該併發問題，2026-07 應用戶要求取消延遲。
            // 上雲模式不受影響：worker 那邊自己安排評估的時機。
            const fireLocalEmotionEval = (emotionEvalEnabled && !instantChatRoute && emotionApi) ? () => {
                setEmotionStatus('evaluating');
                evaluateEmotionBackground(charForGen, userProfile, systemPrompt, cleanedApiMessages, emotionApi)
                    .then((innerState) => {
                        if (innerState) setEvolvedNarrative(innerState);
                    })
                    .finally(() => {
                        setEmotionStatus('');
                    });
            } : null;
            // 交給雲端跑的那份評估配置（提示詞模板 + 副 API 憑據），即時對話把它放進任務
            // metadata.amsgEmotionEval（那份走加密信封）。
            const cloudEmotionEval = (emotionEvalEnabled && instantChatRoute && emotionApi)
                ? {
                    // includeContext=false: 不嵌 system prompt + 對話歷史 (worker 複用本次請求的 messages 作前文),
                    // 把 emotionEval 塊壓到最小, 不把上下文在請求體裡重複一份.
                    prompt: buildEmotionEvalPrompt(
                        charForGen, userProfile, systemPrompt, cleanedApiMessages, false,
                        shouldRequestAmbient(charForGen.id) ? buildAmbientEvalSection(charForGen) : ''
                    ),
                    api: { baseUrl: emotionApi.baseUrl, apiKey: emotionApi.apiKey, model: emotionApi.model },
                }
                : undefined;

            // 上雲的情緒評估在 worker 跑 (副 API), 客戶端看不到 LLM 調用時機, 但仍要給用戶一個
            // "情緒更新中" 的可見信號 (header 徽章, 跟本地模式一致), 否則 "發送中" 消失後一片空白像死了.
            //
            // 正常的熄滅信號只有一個: worker 把結論推回來之後派發的 CHAT_GEN_EVENTS.emotionDone
            // (Chat 頁的徽章和全局橫幅各自監聽, 都不依賴本 hook 存活 —— 用戶切走 Chat 也能正常熄滅).
            // 剩下兩種情況自己收場: 這一輪壓根沒發出去 —— 下面的失敗分支當場調
            // extinguishCloudEmotionBadge; 結論永遠沒回來 (worker 被殺 / 推送丟了 / 用戶部署的是舊版)
            // —— 徽章的 setTimeout 和橫幅的 TTL 同時到點, 兩邊用的是同一個數.
            //
            // 這個數按 worker 最長能跑多久給：worker 那條 fire 的總時長上限是 INSTANT_TOTAL_TIMEOUT_MS
            // （工具循環也算在內），評估結果又是跟著主回覆的最後一條推送回來的——直接從 worker 模塊
            // import 那個數 + 一分鐘推送在途餘量，worker 側調預算時這裡自動跟上
            // （ChatBroadcast 的橫幅 TTL 同樣從它推導，見那邊註釋）。
            const cloudEvalTimeoutMs = INSTANT_TOTAL_TIMEOUT_MS + 60_000;
            /**
             * 熄滅「情緒更新中」的三件套：撤掉安全網、滅頁內徽章、滅全局橫幅。
             *
             * 這一輪沒發出去時失敗分支要調它 —— 雲端根本不會跑評估，那個正常的熄滅信號
             * 永遠不會來。少調一處的表現是：徽章亮著直到安全網到點，然後彈一句
             * 「worker 可能是舊版」的提示，而真實原因是這條消息壓根沒發出去。
             */
            const extinguishCloudEmotionBadge = () => {
                clearCloudEmotionTimer(char.id);
                setEmotionStatus('');
                announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: char.id, charName: char.name });
            };
            if (cloudEmotionEval) {
                setEmotionStatus('evaluating');
                // 橫幅這一條的存活上限跟徽章同一個數：不帶的話橫幅按自己那檔默認值（本地評估的
                // 量級）掃，即時對話會出現「橫幅先沒了、徽章還亮著」，看著像出了兩次故障。
                announceChatGen(CHAT_GEN_EVENTS.emotionStart, {
                    charId: char.id, charName: char.name, ttlMs: cloudEvalTimeoutMs,
                });
                // 佈防按 charId 記進模塊級 map。到點先看這一輪死沒死透：即時對話的待收
                // 記錄還在 = 雲端還沒給結論（worker 的 2/4/6 分鐘重試梯子完全可能把合法
                // 回覆拖過這個點）——這不是「無迴音」，安靜續期一小段再看，別搶在狀態機
                // 前面宣判、把一個好端端的 worker 說成舊版讓用戶白重部署。待收記錄沒了
                // 而結論（emotionDone）一直沒來，才是真的「跑完了但沒人迴音」。
                const charIdAtArm = char.id;
                const charNameAtArm = char.name;
                const armCloudEmotionSafetyNet = (delayMs: number) => {
                    clearCloudEmotionTimer(charIdAtArm);
                    cloudEmotionTimers.set(charIdAtArm, setTimeout(() => {
                        cloudEmotionTimers.delete(charIdAtArm);
                        if (getInstantChatPending(charIdAtArm)) {
                            armCloudEmotionSafetyNet(60_000);
                            return;
                        }
                        // 徽章只熄「佈防那個角色」的：用戶已切到別的角色時，這個 setter
                        // 管的是人家的徽章，不能碰。
                        if (currentCharIdRef.current === charIdAtArm) setEmotionStatus('');
                        // 超時無迴音最常見的原因是用戶部署的 worker 版本過舊（不支持情緒評估、
                        // 壓根不會推結果回來），其次是 worker 被殺/推送丟失。過去這裡
                        // 靜默熄燈, 用戶只看到「情緒永遠不更新」—— 給一條可操作的提示。
                        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                            charId: charIdAtArm, charName: charNameAtArm,
                            reason: '雲端情緒評估超時無迴音——worker 可能是舊版（不支持情緒評估），請到 設置→主動消息 2.0 重新部署 worker 後重試',
                        });
                    }, delayMs));
                };
                armCloudEmotionSafetyNet(cloudEvalTimeoutMs);
            }

            // 發送前彙總計時
            const perfPreApi = Math.round(performance.now() - perfSendT0);
            const stageStr = Object.entries(perfStages)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}ms`)
                .join(' ');
            console.log(`⏱ [send→API] pre-API=${perfPreApi}ms | ${stageStr}`);

            // 3. API Call (safe parsing: prevents "Unexpected token <" on HTML error pages)
            // 溫度 / 流式：優先讀 effectiveApi（用戶在設置裡保存的值或預設值），
            // 缺省時回退到主 apiConfig，再回退默認值（temp=0.85, stream=false）。
            // safeResponseJson 已能透明拼接 SSE 響應，所以打開 stream 後無需改下游。
            const apiT0 = performance.now();
            const userTemp = (effectiveApi as any).temperature ?? apiConfig.temperature ?? 0.85;
            const userStream = (effectiveApi as any).stream ?? apiConfig.stream ?? false;
            const baseReqBody: any = {
                model: effectiveApi.model,
                messages: fullMessages,
                temperature: userTemp,
                max_tokens: 8000,
                stream: userStream,
            };
            // 思考過程展示開啟時顯式向後端請求 extended thinking。
            // 不同代理認不同入口，全都試一遍，代理不識別的會自動忽略：
            //  - 模型名 -thinking 後綴：packycode / anyrouter 等第三方 Claude 中轉的主流約定
            //  - thinking.type='enabled' / budget_tokens：Anthropic 原生與多數官方代理
            //  - reasoning_effort：OpenAI 系（o1/o3、GLM-4.5、deepseek-reasoner 等）
            //  - extra_body.thinking：LiteLLM 系橋
            // 關掉則一個都不傳，避免無謂的 thinking token 計費。
            // ⚠️ 工具模式(瑞幸點單/麥當勞)下絕不帶 thinking/reasoning 參數: "thinking + tools" 同發
            //    Gemini 等會直接 400 INVALID_ARGUMENT —— 表現就是"開了思考鏈的角色一點單就報錯,
            //    換個沒開思考鏈的角色就好"。工具循環優先, 思考鏈這一輪讓步。
            const toolModeActive = payload.flags.luckinChatActive || payload.flags.mcdActive || payload.flags.luckinActive || payload.flags.mcpChatActive;
            // 主動消息 2.0 的工具本輪會不會注入：thinking 門要先知道這件事（工具在下面才真正
            // 拼進 tools，但參數取捨必須現在就定）。角色級開關關掉的不注入——否則被用戶顯式
            // 關掉的功能會被角色一次工具調用重新打開。
            const amsg2ToolsInjected = isAmsg2EnabledForChar(char) && await isAmsg2GlobalReady();
            if (shouldSendThinkingParams({
                thinkingActive: !!payload.flags.thinkingActive,
                legacyToolModeActive: !!toolModeActive,
                amsg2ToolsInjected,
                model: baseReqBody.model || '',
            })) {
                const m: string = baseReqBody.model || '';
                if (/^claude-/i.test(m) && !/-thinking$/i.test(m)) {
                    baseReqBody.model = `${m}-thinking`;
                }
                baseReqBody.thinking = { type: 'enabled', budget_tokens: 4000 };
                baseReqBody.reasoning_effort = 'medium';
                baseReqBody.extra_body = { ...(baseReqBody.extra_body || {}), thinking: { type: 'enabled', budget_tokens: 4000 } };
                // 開思考時不要帶採樣參數: Claude 系（含各種中轉 claude-*）在 thinking 啟用時
                // 只接受 temperature=1，傳 0.85 會被 400 ("temperature may only be set to 1 when
                // thinking is enabled")。刪掉讓服務端用默認即可——對其它模型(非 Claude)也安全:
                // 它們開思考時同樣不需要我們指定溫度，回退默認不影響行為。
                delete baseReqBody.temperature;
                delete baseReqBody.top_p;
            }
            // 流式時顯式要求 usage 統計隨末尾 chunk 一起返回，否則 token 徽標拿不到數據
            if (userStream) {
                baseReqBody.stream_options = { include_usage: true };
            }
            // 小程序模式: 給 LLM 一個 UI 鉤子工具 propose_cart_items, 推薦時可調用,
            // 工具不真改購物車也不調 MCP, 只是把推薦渲染成 + 加按鈕卡片讓用戶決定
            if (payload.flags.mcdActive) {
                baseReqBody.tools = [MCD_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            } else if (payload.flags.luckinActive) {
                baseReqBody.tools = [LUCKIN_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            } else if (payload.flags.luckinChatActive) {
                // 瑞幸聊天點單: 給角色真實 8 個 MCP 工具, 自己去查門店/搜商品/定規格/算價
                const luckinTools = await fetchOpenAIToolsForLuckin();
                if (luckinTools && luckinTools.length) {
                    baseReqBody.tools = luckinTools;
                    baseReqBody.tool_choice = 'auto';
                }
            }
            // 通用 MCP: 用戶自配服務器的已發現工具, 追加而不覆蓋(可與瑞幸/麥當勞共存)。
            // 工具清單讀的是設置裡持久化的發現結果, 不發網絡請求。
            let mcpToolResolve: ReturnType<typeof buildMcpOpenAITools>['resolve'] | null = null;
            if (payload.flags.mcpChatActive) {
                const { tools: mcpTools, resolve } = buildMcpOpenAITools(char.id);
                if (mcpTools.length) {
                    mcpToolResolve = resolve;
                    const mcpOnly = !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                    if (!getMcpUseNativeTools() && mcpOnly) {
                        // 用戶已明確判斷當前模型/中轉不支持 tools：首輪直接走正文兼容模式。
                        const compatibilityBody = buildMcpRejectedToolsFallbackBody({
                            ...baseReqBody,
                            tools: mcpTools,
                            tool_choice: 'auto',
                        });
                        baseReqBody.messages = compatibilityBody.messages;
                    } else {
                        baseReqBody.tools = [...(baseReqBody.tools || []), ...mcpTools];
                        if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                    }
                }
            }
            // 主動消息 2.0 本地工具：worker 已配置 + 角色沒關掉時注入 schedule/cancel/renew/list，
            // 並注入「排程現狀」背景塊（常駐能力簡介 + 進行中任務 + 作廢待處理，角色自行判斷怎麼接）。
            // 是否注入在上面 thinking 門那裡就算好了（amsg2ToolsInjected）。
            let amsg2ExpiredIds: string[] = [];
            let amsg2Notices: Amsg2ExpiredNoticeRecord[] = [];
            if (amsg2ToolsInjected) {
                baseReqBody.tools = [...(baseReqBody.tools || []), ...buildAmsg2Tools(resolveAmsgLimits(char.activeMsg2Config))];
                if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                try {
                    // 回執這半邊是「檢出 + 落台帳」的結果，帶副作用，一輪只算一次；
                    // 進行中任務那半邊每次發請求現取（見下面的 withAmsg2TaskContext）。
                    const taskContext = await collectAmsg2TaskContext(char, userProfile.name);
                    amsg2ExpiredIds = taskContext.expiredIds;
                    amsg2Notices = taskContext.notices;
                } catch (e) {
                    // 掛掉的只是作廢回執這半邊（它要讀歷史消息和台帳）。進行中清單在內存裡，
                    // 照常渲染——角色至少知道自己名下有哪些任務，不至於一問三不知再排一條。
                    console.warn('[amsg2] 作廢回執檢出失敗，本輪只帶進行中清單', e);
                }
            }

            /**
             * 把排程現狀塊貼到 messages 末尾，每次發請求都按「此刻」的任務清單現算。
             *
             * 不寫死進 baseReqBody.messages、也不進 loopMessages，是因為工具循環裡角色會
             * 邊聊邊排：寫死的話第二輪起看到的是**排程前**那份空清單，跟工具剛回的「已創建」
             * 打架，角色於是把同一條再排一遍；攢進歷史的話則是好幾份互相矛盾的舊清單疊著。
             * 現算 + 只留一份，角色每輪讀到的都是自己名下真實的任務，本輪剛排的還會被點名。
             */
            const withAmsg2TaskContext = (messages: any[]): any[] => {
                if (!amsg2ToolsInjected) return messages;
                const now = Date.now();
                const liveConfig = amsg2Session.getConfig();
                const pending = getPendingTasks(liveConfig, now);
                // 「用戶給你定的規矩」：用戶剛開口，連發額度只剩排著還沒響的自排任務在佔。
                const limitsBrief = buildLimitsBrief({
                    limits: resolveAmsgLimits(liveConfig),
                    committedSends: pending.filter((t) => t.source === 'character').length,
                    activeTasks: pending.length,
                });
                const text = buildAmsg2TaskContextText(
                    pending,
                    amsg2Notices,
                    now,
                    resolveCharTimeZone(char),
                    amsg2CreatedThisTurn,
                    userProfile.name,
                    limitsBrief,
                );
                // 常駐簡介讓這一塊總是非空：沒任務時角色也得知道自己隨時能排。
                const block = { role: 'system', content: text };
                // 插在易變尾段**之前**，不貼數組尾巴：「回到你自己」鋼印焊在 volatileTail 末尾，
                // 靠 recency 搶模型開口前的最後一眼；一份帶 promptHint 原文的清單擺在它後面，
                // 排在今晚的事會被當成本輪就該催的事（「書看到哪了」每輪問一遍的由來）。
                // 插入點在本輪用戶消息之後，前綴緩存的斷點更靠前，命中率一個 token 都不受影響。
                // 工具循環的 loopMessages 是 baseReqBody.messages 追加尾巴，前綴沒動，下標照用。
                return insertAmsg2TaskContextBlock(messages, block, payload.volatileTailIndex);
            };

            // ─── 即時對話（主動消息 2.0 雲端生成）分支 ───
            // 這一輪的上下文 + 任務一個 POST 上雲，雲端跑完走推送回來（收件箱同一條管線入庫），
            // 客戶端發完那一刻就自由了。
            //
            // 走不走這條路，構建 payload 之前的 instantChatRoute 已經算完了，這裡只認它
            // 一個值：「這份 prompt 剝沒剝時效段」和「這一輪走不走雲端」必須是同一個判斷，
            // 各算各的話兩邊總有一天會不同意，剝過的那份 prompt 就落到別的路上去了。
            // 沒上雲的那些情形（SAR 模塊 / 點單否決 / MCP 地址夠不著）在那一段裡已經報過 trace，
            // 這邊不重複報，也不重複攔。
            //
            // MCP 刻意不在排除名單裡：worker fire 時自己解析 tool_config、自己跑後台
            // MCP（這次 POST 順手把配置傳上去了），雲端答得了。排掉它的話，只要全局配著
            // 一台 enabled 的 MCP 服務器，即時對話就永遠靜默走回本地——設置頁亮著
            // 「已開啟」、界面毫無異樣，用戶查無可查。
            if (instantChatRoute) {
                // 作廢回執跟著 chat 段上雲：檢出（collectAmsg2TaskContext，帶落台帳的副作用）
                // 在上面已經跑過了，本地路徑靠 withAmsg2TaskContext 注入的排程清單和能力
                // 簡介到點由 worker 的 instant timely block 現算現渲，唯獨回執雲端沒有——
                // 只把這一樣單獨成塊貼上，不帶清單不帶簡介，別和到點渲染的那份撞車。
                const amsg2NoticesBlock = amsg2ToolsInjected && amsg2Notices.length
                    ? buildAmsg2NoticesText(amsg2Notices, resolveCharTimeZone(char), userProfile.name)
                    : null;
                const instantChatResult = await sendInstantChatTurn({
                    char,
                    // 雲端要發給模型的就是本地這一份，一個字不改（見 fire_pack 的 chat 段）。
                    chatMessages: (amsg2NoticesBlock
                        ? [...fullMessages, { role: 'system', content: amsg2NoticesBlock }]
                        : fullMessages) as Array<{ role: string; content: unknown }>,
                    // 憑據用本地這一輪的那份：換成別的等於同一句話由不同模型來答，而用戶看不出來。
                    // model / temperature 取 baseReqBody 的終值而不是 effectiveApi 的原始值：
                    // 上面那段已經按本地規則把 thinking 後綴（claude 系 -thinking）拼好、
                    // 開思考時把溫度刪掉了——雲端要的就是「本地這一輪會發出去的那份」。
                    api: { baseUrl: effectiveApi.baseUrl, apiKey: effectiveApi.apiKey, model: baseReqBody.model },
                    ...(typeof baseReqBody.temperature === 'number' ? { temperature: baseReqBody.temperature } : {}),
                    maxTokens: baseReqBody.max_tokens,
                    // 思考鏈三件套同理取終值：shouldSendThinkingParams 通過時本地會帶
                    // thinking / reasoning_effort / extra_body 三個入口（不同代理認不同的），
                    // 雲端不帶的話，凡是靠請求體參數激活思考的渠道（Anthropic 原生、
                    // OpenAI 系、LiteLLM 橋——即除了 -thinking 模型名後綴之外的全部）
                    // 一開即時對話思考就靜默消失，心象卡片跟著沒了。
                    ...(baseReqBody.thinking || baseReqBody.reasoning_effort || baseReqBody.extra_body
                        ? {
                            extraBody: {
                                ...(baseReqBody.thinking ? { thinking: baseReqBody.thinking } : {}),
                                ...(baseReqBody.reasoning_effort ? { reasoning_effort: baseReqBody.reasoning_effort } : {}),
                                ...(baseReqBody.extra_body ? { extra_body: baseReqBody.extra_body } : {}),
                            },
                        }
                        : {}),
                    userProfile, groups, realtimeConfig,
                    // 情緒評估也交給雲端：worker 到點和主回覆並行跑，結果隨最後一條推送回來
                    // （見 worker/amsg/src/emotionEval.ts）。放在這裡而不是本地 fire 一槍，
                    // 是因為用戶發完就能關頁面——留在本地的話，頁面一關情緒底色就停更了。
                    ...(cloudEmotionEval ? { emotionEval: cloudEmotionEval } : {}),
                });
                if (instantChatResult.ok) {
                    // 這次 POST 已經把權威的那份 fire_pack 傳上去了，收尾不必再打髒重傳一遍。
                    instantChatAccepted = true;
                    // 202 只說明雲端收下了，不說明角色真的讀到過這些回執：那一輪可能空輸出被
                    // 判 skip-push，也可能 fire 重試打光標 failed。所以這裡只記帳不銷帳，等回覆
                    // 真的落庫那一刻（activeMsgRuntime 認末段到齊）再調
                    // settleInstantChatExpiredNotices 寫 notifiedAt；這一輪沒成的話
                    // failInstantChatPending 會把它們退回未告知，下一輪重新注入。
                    // 本地路徑同一口徑：回覆 applyAssistantPostProcessing 落庫之後才標記。
                    if (amsg2ExpiredIds.length && instantChatResult.uuid) {
                        stageInstantChatExpiredNotices(char.id, instantChatResult.uuid, amsg2ExpiredIds);
                    }
                } else {
                    // 沒發出去就是沒發出去：明確落一條系統消息 + 彈錯，用戶可以直接重發。
                    // **絕不靜默退回本地生成** —— 靜默分流那種查無可查的坑踩過一次就夠了。
                    const reason = instantChatResult.error || '未知錯誤';
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` });
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    if (showError) showError('即時對話發送失敗', reason);
                    else addToast(reason, 'error');
                    // 沒發出去 → 雲端不會跑評估，那個正常的熄滅信號永不到達。當場自己熄，
                    // 否則「情緒更新中」要一直亮到 11 分鐘後安全網到點。
                    if (cloudEmotionEval) extinguishCloudEmotionBadge();
                }
                return;
            }

            // 流式預覽：僅在用戶開了 stream、且非工具/雙語模式時啟用。
            // 工具模式的首輪響應可能是 tool_calls（無正文可預覽）；雙語模式正文包在
            // 跨行 <翻譯> 標籤裡。這兩類連正文/思考鉤子都不掛，完整走原有整包路徑。
            // 語音、日記、HTML 等由內容標籤動態識別，computeStreamPreviewBubbles 會扣住控制塊，
            // 只允許標籤外確實屬於普通文字的部分預覽。
            // 每次 onDelta 基於累計全文全量重算（safeFetchJson 重試會重開流，天然重置）；
            // 正文尾句和思考內容只在累計文本確實變化時觸發重渲染。
            // SAR 的正文包在結構化容器裡，流式階段不能把 TRUE/SURFACE 控制標籤閃給用戶。
            const streamUiEligible = !!userStream && !toolModeActive && !bilingualActive && !sarModulePlan.requiresEnvelope;
            const streamPreviewEligible = streamUiEligible;
            const streamThinkingEligible = streamUiEligible && payload.flags.thinkingActive;
            // 預覽真的上過屏才置 true → 後處理落庫時跳過擬人打字延遲（instantRender），
            // 否則用戶會看到"預覽氣泡收回去、再一條條慢慢重彈"的二次播放。
            let streamPreviewShown = false;
            let streamThinkingShown = false;
            let latestStreamPreviewBubbles: string[] = [];
            let latestNativeReasoning = '';
            let latestEmbeddedThinking = '';
            const publishStreamingThinking = () => {
                const combined = [latestNativeReasoning, latestEmbeddedThinking]
                    .map(text => text.trim())
                    .filter(Boolean)
                    .join('\n\n');
                if (combined) streamThinkingShown = true;
                setStreamingThinking(prev => prev === combined ? prev : combined);
            };
            const streamHooks = (streamPreviewEligible || streamThinkingEligible) ? {
                onDelta: (_delta: string, fullText: string) => {
                    if (streamPreviewEligible) {
                        const bubbles = computeStreamPreviewBubbles(fullText);
                        latestStreamPreviewBubbles = bubbles;
                        if (bubbles.length > 0) streamPreviewShown = true;
                        setStreamingBubbles(prev =>
                            (prev.length === bubbles.length && prev.every((b, i) => b === bubbles[i])) ? prev : bubbles
                        );
                    }
                    if (streamThinkingEligible) {
                        latestEmbeddedThinking = extractStreamingEmbeddedThinking(fullText);
                        publishStreamingThinking();
                    }
                },
                onReasoningDelta: (_delta: string, fullReasoning: string) => {
                    if (!streamThinkingEligible) return;
                    latestNativeReasoning = fullReasoning;
                    publishStreamingThinking();
                },
            } : undefined;

            // 主請求即將發出 → 立即並行發射情緒評估（錯峰延遲已按用戶要求取消，見定義處註釋）。
            fireLocalEmotionEval?.();

            // 心聲/好感度裡設了「每幾輪對話」節奏的條目，本地路徑每發一次請求算一輪——
            // 到這裡說明 instantChatRoute 已經在上面 return 過了，走的一定是本地路徑，
            // 跟雲端即時對話共用同一份節奏計數會因為「客戶端看不見 worker 何時真的跑」而
            // 數不準，所以這條節奏暫時只接本機聊天。fire-and-forget，不影響主回覆。
            // API 故意不跟主回覆共用 effectiveApi：心聲/好感度走「情緒/意識流 API」（通常配便宜
            // 模型），主回覆才走角色專屬對話模型（通常更貴），兩筆帳混一起用戶的 token 會燒很快。
            const meterApi = resolveCharacterMeterApi(char, apiConfig);
            void checkCustomMeterAutoUpdate('text', char, userProfile, meterApi, char.innerVoices || [], { tickTurns: true })
                .then(next => { if (next) updateCharacter(char.id, { innerVoices: next }); })
                .catch(e => console.warn('[CustomMeter] 心聲按輪自動更新失敗:', e));
            void checkCustomMeterAutoUpdate('number', char, userProfile, meterApi, char.affinities || [], { tickTurns: true })
                .then(next => { if (next) updateCharacter(char.id, { affinities: next }); })
                .catch(e => console.warn('[CustomMeter] 好感度按輪自動更新失敗:', e));

            // 同角色活躍會話租約：本地 fetch 路徑本輪真實消息已落庫、模型請求即將發出，
            // 啟動心跳告訴 worker「正在和這個角色聊」——到點的 expire AI 任務據此 skip，
            // 別在用戶正聊時又彈主動消息。即時對話路徑在上方已 return，天然不重複開 lease。
            // 只對已排程 AI 任務的角色開租約：其餘角色沒有 worker 消費，開了純浪費還刷 warn。
            const amsg2Cfg = char.activeMsg2Config;
            if (amsg2Cfg?.enabled && hasActiveAiTask(amsg2Cfg)) {
                startAmsgChatPresence(char.id, getLastRealUserMessageAt(contextMsgs));
            }

            let data: any;
            try {
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ ...baseReqBody, messages: withAmsg2TaskContext(baseReqBody.messages) })
                }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天回覆' }, streamHooks);
            } catch (e) {
                let requestError: unknown = e;
                const attemptedBody = {
                    ...baseReqBody,
                    messages: withAmsg2TaskContext(baseReqBody.messages),
                };
                // 部分第三方 OpenAI→Claude 中轉會把請求形狀不兼容包裝成 502
                // bad_response_status_code：thinking 三種方言、tools、尾部 system 單獨都能收，
                // 組合在一起卻在上游適配層失敗。只對這一條高度特徵化的 502 降級一次：
                // tools 和正文完整保留，system 合到開頭，thinking 參數讓步。普通網絡 502、
                // 非 Claude、沒工具的請求一律不重發，避免無依據地重複計費。
                if (shouldRetryClaudeProxyCompatibility(requestError, attemptedBody)) {
                    console.warn('🧩 [Claude compat] 中轉拒絕 thinking + tools 組合，使用兼容請求體重試一次');
                    try {
                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify(buildClaudeProxyCompatibilityBody(attemptedBody)),
                        }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: 'Claude 中轉兼容重試' }, streamHooks);
                        requestError = null;
                    } catch (compatError) {
                        requestError = compatError;
                    }
                }

                if (!requestError) {
                    // Claude 兼容重試已成功，繼續走下方統一後處理。
                } else {
                // 僅通用 MCP、且沒有和其他工具模式混用時降級。部分 OpenAI 兼容中轉
                // 會對攜帶 tools 的請求直接回 4xx，而不是忽略參數；去掉 tools 後讓
                // 現有正文假調用容錯接手。真實鑑權失敗會在這次重試中再次拋出原樣錯誤。
                const mcpOnly = payload.flags.mcpChatActive
                    && !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                if (!mcpOnly || !baseReqBody.tools?.length || !shouldRetryMcpWithoutTools(requestError)) throw requestError;
                console.warn('🔌 [MCP] 當前中轉拒絕 tools 請求，降級為正文工具調用兼容模式');
                // 這條路把 tools 全刪了，角色排不了新任務；排程現狀照樣要帶——它得知道
                // 自己名下已經有哪些承諾，否則又會在正文裡許一遍。
                const fallbackBody = buildMcpRejectedToolsFallbackBody({
                    ...baseReqBody,
                    messages: withAmsg2TaskContext(baseReqBody.messages),
                });
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify(fallbackBody)
                }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: 'MCP tools 兼容重試' });
                // 後續正文工具循環必須繼續帶著兼容協議；只把它放在這次重試請求裡，下一跳
                // 又退回原 messages，會讓模型忘掉工具簽名和「每步只輸出一行」的約定。
                baseReqBody.messages = fallbackBody.messages;
                }
            }
            console.log(`⏱ [API call] ${Math.round(performance.now() - apiT0)}ms`);
            updateTokenUsage(data, historyMsgCount, 'initial');

            // MCP 多階段展示：工具前的角色文字先落庫，最終工具結果回覆仍走統一後處理。
            const displayedMcpLeadIns = new Set<string>();
            const persistMcpLeadIn = async (raw: string, fakedCalls: FakedMcpCall[] = []): Promise<void> => {
                if (!mcpToolResolve || !raw.trim()) return;
                const withoutCalls = fakedCalls.length ? stripTextFakedMcpCalls(raw, fakedCalls) : raw.trim();
                const display = ChatParser.sanitize(sanitizeMcpLeadInText(withoutCalls), { keepCitations: true }).trim();
                if (!display || !ChatParser.hasDisplayContent(display) || displayedMcpLeadIns.has(display)) return;
                displayedMcpLeadIns.add(display);
                const chunks = ChatParser.chunkText(display).filter(chunk => ChatParser.hasDisplayContent(chunk));
                for (const chunk of chunks) {
                    const cleanChunk = ChatParser.sanitize(chunk, { keepCitations: true }).trim();
                    if (!cleanChunk) continue;
                    await DB.saveMessage({
                        charId: char.id,
                        role: 'assistant',
                        type: 'text',
                        content: cleanChunk,
                        metadata: { mcpLeadIn: true },
                    } as any);
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                }
            };

            // 3.4 麥當勞小程序 propose_cart_items UI 鉤子工具循環
            //     不調 MCP, 只把模型的 args 作為 mcd_card kind=proposal 落庫, 讓小程序聊天面板渲染
            //     成"+加進購物車"卡片。返回 ack 給模型繼續走它的文字 reply。
            if (payload.flags.mcdActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容層會被判 INVALID_ARGUMENT, 給個佔位
                        content: data.choices[0].message.content || '(調用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('🍔 [MCD-MiniApp] propose 參數解析失敗:', e);
                        }
                        // 主動消息 2.0 的排程工具與點單工具會在同一批 tool_calls 裡出現:
                        // 先分流執行, 否則會落進下面的「畸形調用」分支被吃掉, 而續寫請求
                        // 又不帶 tools, 角色「點單時順手排個提醒」就永遠不會生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        if (route === 'propose') {
                            // 第一步: 菜單還沒加載就直接拒, 不能讓模型瞎編 code
                            // 這是導致 calculate-price 返回空列表的根因之一: propose 在 pick 步驟被調用,
                            // 此時 menuMeals 是空的, 舊版 menuKeys.length===0 會直接跳過校驗, 爛 code 一路到 cart。
                            const menu = mcdMiniSnap?.menuMeals || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜單還沒加載 (用戶當前在選模式 / 選地址門店階段, 還沒進入菜單頁)。請先用文字陪用戶聊, 等用戶在小程序裡選完地址/門店、菜單加載出來後再調 propose_cart_items。所有 code 必須從加載後的"當前門店在售"清單裡挑, 不能憑印象編。`,
                                } as any);
                                continue;
                            }
                            // 第二步: 全局名字匹配自動修 code (char 經常把"板燒雞腿堡"當 code 傳)
                            const { fixed, fixes } = autoFixProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`🍔 [MCD-MiniApp] propose 自動修 ${fixes.length} 個 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            // 第三步: 修完後還有非法的就退回 char 重提 (嚴格模式: 任何不在 menu 字典裡的 code 都拒)
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 裡這些 code/name 在菜單裡都找不到匹配 (已嘗試名字模糊匹配但失敗): ${bad}。這些商品本店不賣, 別推。當前菜單可用 code 示例: ${sample}。請只從菜單裡挑實際有的, 重新調一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await DB.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'mcd_card',
                                    content: `${args.items.length} 件推薦`,
                                    metadata: {
                                        mcdCardKind: 'proposal',
                                        mcdProposal: args,
                                        fromMcdMiniApp: true,
                                    },
                                } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            } catch (e) {
                                console.warn('🍔 [MCD-MiniApp] 保存 proposal 失敗:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我幫你把 ${fixes.length} 個 code 按名字校準到了菜單裡真實的 code, 下次 propose 時直接用菜單字典 key 別傳名字, 省一步)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推薦展示給用戶, 用戶可以點 + 加進購物車${ackExtra}`,
                            } as any);
                        } else {
                            // 未知工具 / 空 items, 給個溫和的報錯讓模型自糾
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 調用形態不對, 期望 {items: [{code, name, qty, reason?}]}; 你這次給的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    // 讓 char 繼續生成文字補充 (不再帶 tools, 避免無限調)
                    const followBody = { ...baseReqBody, messages: loopMessages };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `mcd-propose-${it + 1}`);
                    // 第二輪跳過 (我們已經禁用了 tools)
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
            }

            // 3.5 瑞幸小程序 propose_cart_items UI 鉤子工具循環 (與麥當勞同構)
            if (payload.flags.luckinActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容層會被判 INVALID_ARGUMENT, 給個佔位
                        content: data.choices[0].message.content || '(調用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-MiniApp] propose 參數解析失敗:', e);
                        }
                        // 主動消息 2.0 的排程工具與點單工具會在同一批 tool_calls 裡出現:
                        // 先分流執行, 否則會落進下面的「畸形調用」分支被吃掉, 而續寫請求
                        // 又不帶 tools, 角色「點單時順手排個提醒」就永遠不會生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        if (route === 'propose') {
                            const menu = luckinMiniSnap?.menuItems || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜單還沒加載 (用戶當前在選模式 / 選門店階段)。請先用文字陪用戶聊, 等菜單加載出來、出現"當前門店在售"清單後再調 propose_cart_items, code 必須從清單裡挑。`,
                                } as any);
                                continue;
                            }
                            const { fixed, fixes } = autoFixLuckinProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`☕ [Luckin-MiniApp] propose 自動修 ${fixes.length} 個 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 裡這些 code/name 在菜單裡找不到匹配: ${bad}。這些商品本店不賣, 別推。當前菜單可用 code 示例: ${sample}。請只從菜單裡挑實際有的, 重新調一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await DB.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'luckin_card',
                                    content: `${args.items.length} 件推薦`,
                                    metadata: {
                                        luckinCardKind: 'proposal',
                                        luckinProposal: args,
                                        fromLuckinMiniApp: true,
                                    },
                                } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            } catch (e) {
                                console.warn('☕ [Luckin-MiniApp] 保存 proposal 失敗:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我幫你把 ${fixes.length} 個 code 按名字校準到了菜單裡真實的 code)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推薦展示給用戶, 用戶可以點 + 加進購物車${ackExtra}`,
                            } as any);
                        } else {
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 調用形態不對, 期望 {items: [{code, name, qty, reason?}]}; 你這次給的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    const followBody = { ...baseReqBody, messages: loopMessages };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `luckin-propose-${it + 1}`);
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
            }

            // 3.6 客戶端工具循環 —— 兩類共用一個循環骨架:
            //     · 瑞幸聊天點單: 真實 8 工具 (queryShopList → searchProductForMcp →
            //       switchProduct → previewOrder)。結果落 luckin_card; previewOrder 落"結帳卡"(可改量+掃碼付);
            //       createOrder 被攔截 —— 下單付款必須用戶在結帳卡上點。
            //     · 通用 MCP: 工具名命中 mcpToolResolve 映射就分發給對應服務器 (utils/mcpClient),
            //       結果只回填循環不落卡片。兩類工具可同時在場, 按名字各走各的。
            if ((payload.flags.luckinChatActive || mcpToolResolve || amsg2ToolsInjected) && data.choices?.[0]?.message?.tool_calls?.length) {
                // 普通點單/排程維持 6 輪；接了通用 MCP 時允許遊戲/論壇類任務自然推進到
                // 12 輪。模型正常給正文會立刻 break，並不是固定多發 12 次請求。
                const MAX_LOOPS = mcpToolResolve ? MCP_CHAT_MAX_TOOL_LOOPS : 6;
                let loopMessages = [...baseReqBody.messages];
                const loc = luckinChatRef?.current;
                const seenMcpOutcomes = new Set<string>();
                let stalledMcpRounds = 0;
                let lastMcpCallSignature: string | null = null;
                for (let it = 0; it < MAX_LOOPS; it++) {
                    const toolCalls = normalizeToolCallsForCompat(
                        data.choices?.[0]?.message?.tool_calls,
                        `private_${it}`,
                    );
                    if (!toolCalls || !toolCalls.length) break;
                    if (mcpToolResolve && toolCalls.some((tc: any) => mcpToolResolve?.has(tc.function?.name || ''))) {
                        await persistMcpLeadIn(data.choices?.[0]?.message?.content || '');
                    }
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容層會被判 INVALID_ARGUMENT, 給個佔位
                        content: data.choices[0].message.content || '(調用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    let mcpCallsThisRound = 0;
                    let mcpProgressThisRound = false;
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-Chat] 工具參數解析失敗:', e);
                        }
                        // 通用 MCP 工具: 命中映射直接分發, 不走下面的瑞幸邏輯
                        const mcpHit = mcpToolResolve?.get(fname);
                        if (mcpHit) {
                            mcpCallsThisRound += 1;
                            const callSignature = toolCallFingerprint(fname, args);
                            // 連續同名同參通常是模型卡住。先攔再執行，避免發帖 / 下單之類的
                            // 副作用真的重複發生；中間做過其他動作後同參查狀態仍會正常放行。
                            if (callSignature === lastMcpCallSignature) {
                                loopMessages.push(buildToolResultMessage(
                                    tc,
                                    `工具 ${fname} 的同一組參數剛剛已經執行過，請不要原地重複；根據已有結果選擇能推進目標的下一步，或直接回復。`,
                                ) as any);
                                continue;
                            }
                            lastMcpCallSignature = callSignature;
                            setSearchStatus(`正在調用 MCP 工具：${fname}...`);
                            let mcpResult: any;
                            try { mcpResult = await callMcpTool(mcpHit.server, mcpHit.toolName, args); }
                            catch (e: any) { mcpResult = { success: false, error: e?.message || String(e) }; }
                            const mcpMsg = mcpResult.success
                                ? `工具 ${fname} 成功。結果: ${formatMcpToolResult(mcpResult.data)}`
                                : `工具 ${fname} 失敗: ${mcpResult.error}`;
                            // 同名同參在動作前後可能得到不同狀態，結果不同就算仍在推進；只有
                            // 調用和結果都原樣重複才算原地打轉。
                            let outcomeKey = `${fname}|${JSON.stringify(args)}|${mcpMsg}`;
                            if (outcomeKey.length > 4000) outcomeKey = outcomeKey.slice(0, 4000);
                            if (!seenMcpOutcomes.has(outcomeKey)) {
                                seenMcpOutcomes.add(outcomeKey);
                                mcpProgressThisRound = true;
                            }
                            loopMessages.push(buildToolResultMessage(tc, mcpMsg) as any);
                            continue;
                        }
                        // 主動消息 2.0 工具
                        if (AMSG2_TOOL_NAMES.has(fname)) {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        // 只開了 MCP 沒開瑞幸時, 幻覺出的未知工具名直接回錯誤讓模型自我糾正
                        if (!payload.flags.luckinChatActive) {
                            loopMessages.push(buildToolResultMessage(tc, `未知工具 ${fname}, 只能使用系統提供的工具。`) as any);
                            continue;
                        }
                        // 經緯度兜底: 角色漏傳就用激活時抓到的定位補上
                        if (/queryShopList|createOrder/i.test(fname) && loc) {
                            if (args.longitude == null && loc.longitude != null) args.longitude = loc.longitude;
                            if (args.latitude == null && loc.latitude != null) args.latitude = loc.latitude;
                        }
                        // 攔截 createOrder: 不真下單, 引導走結帳卡
                        if (/create[-_]?order/i.test(fname)) {
                            loopMessages.push(buildToolResultMessage(
                                tc,
                                '下單與支付由用戶在結帳卡上完成, 你不要調 createOrder。若還沒出結帳卡, 請先調 previewOrder 把訂單算價展示出來, 然後用角色語氣讓用戶去卡片上確認支付。',
                            ) as any);
                            continue;
                        }
                        let result: any;
                        try { result = await callLuckinTool(fname, args); }
                        catch (e: any) { result = { success: false, error: e?.message || String(e) }; }

                        const isPreview = /preview[-_]?order/i.test(fname);
                        try {
                            await DB.saveMessage({
                                charId: char.id,
                                role: 'assistant',
                                type: 'luckin_card',
                                content: fname,
                                metadata: {
                                    luckinToolName: fname,
                                    luckinToolArgs: args,
                                    luckinToolResult: result.success ? result.data : undefined,
                                    luckinToolError: result.success ? undefined : result.error,
                                    luckinToolRawText: result.rawText,
                                    luckinCardKind: isPreview ? 'checkout' : inferLuckinCardKind(fname),
                                    luckinLoc: (loc && loc.longitude != null) ? { longitude: loc.longitude, latitude: loc.latitude } : undefined,
                                },
                            } as any);
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        } catch (e) { console.warn('☕ [Luckin-Chat] 存卡片失敗:', e); }

                        const toolMsg = result.success
                            ? `工具 ${fname} 成功。結果(截斷): ${(() => { try { return JSON.stringify(result.data).slice(0, 1500); } catch { return String(result.data).slice(0, 800); } })()}`
                            : `工具 ${fname} 失敗: ${result.error}`;
                        loopMessages.push(buildToolResultMessage(tc, toolMsg) as any);
                    }
                    if (mcpCallsThisRound > 0) {
                        stalledMcpRounds = mcpProgressThisRound ? 0 : stalledMcpRounds + 1;
                    }
                    const reachedHardLimit = !!mcpToolResolve && it + 1 >= MAX_LOOPS;
                    const stalled = !!mcpToolResolve && stalledMcpRounds >= MCP_CHAT_MAX_STALLED_ROUNDS;
                    const forceWrapUp = reachedHardLimit || stalled;
                    // 繼續讓角色多步推進 (保留 tools, 允許 query→search→preview 連續走)
                    if (mcpToolResolve) setSearchStatus('正在整理 MCP 工具結果...');
                    // 排程現狀現算一次貼上：本輪剛排的任務這時才進得了清單，角色下一輪
                    // 看到的是自己名下真實的排程，不會對著排程前的空清單再排一條。
                    const followMessages = withAmsg2TaskContext(loopMessages);
                    if (forceWrapUp) {
                        followMessages.push({
                            role: 'user',
                            content: `[系統消息：工具階段${stalled ? '連續兩輪沒有產生新結果' : '已到本輪安全上限'}。請停止調用工具，基於已經拿到的結果直接用角色語氣回覆；如目標仍未完成，請如實說明卡在哪一步。不要輸出工具名、參數或這條系統消息。]`,
                        });
                    }
                    const followBody = { ...baseReqBody, messages: followMessages };
                    if (forceWrapUp) {
                        delete followBody.tools;
                        delete followBody.tool_choice;
                    }
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `${payload.flags.luckinChatActive ? 'luckin-chat' : 'mcp-chat'}-${it + 1}`);
                    if (forceWrapUp) break;
                }
                if (mcpToolResolve) setSearchStatus('');
            }

            // 3.6b MCP 掉格式容錯（第二層, 對標見面觀測協議的兩層容錯）:
            //     不支持 function calling 的模型會把工具調用寫成正文文字, 如
            //     ask_question("SullyOS") / ask_question: SullyOS。這裡檢測出來
            //     系統代為執行, 把結果喂回去讓角色重新組織語言, 用戶就看不到亂碼了。
            //     連續調用指紋防止模型復讀同一調用導致副作用工具重複執行；中間若有別的
            //     動作，則允許用同參重新查詢已經變化的狀態。
            if (mcpToolResolve) {
                const MAX_TEXT_LOOPS = MCP_CHAT_MAX_TOOL_LOOPS;
                let lastExecutedSig: string | null = null;
                let textLoopMessages: any[] | null = null;
                for (let it = 0; it < MAX_TEXT_LOOPS; it++) {
                    const contentNow: string = data.choices?.[0]?.message?.content || '';
                    // 兼容協議約定每輪只發一行。一次只執行一個，既讓 12 輪真正按步驟自適應，
                    // 也避免一段失控正文批量觸發多個副作用。
                    const allFaked = extractTextFakedMcpCalls(contentNow, mcpToolResolve).slice(0, 1);
                    const faked = allFaked
                        .filter(c => toolCallFingerprint(c.exposedName, c.args) !== lastExecutedSig);
                    // 兼容模式沒有原生 tool_call id，模型重複寫同名同參時絕不能再次執行
                    // 副作用工具；給一次強制收尾請求，把已經拿到的結果組織成人話。
                    if (allFaked.length > 0 && faked.length === 0) {
                        if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                        textLoopMessages.push({ role: 'assistant', content: contentNow });
                        textLoopMessages.push({
                            role: 'user',
                            content: '[系統消息：你重複請求了已經執行過的同一工具。不要再次調用工具，請直接根據已有結果回覆；如目標未完成就如實說明。不要輸出工具調用格式或提及本消息。]',
                        });
                        const wrapBody = buildMcpTextFallbackBody(baseReqBody, textLoopMessages);
                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify(wrapBody)
                        });
                        updateTokenUsage(data, historyMsgCount, `mcp-text-wrap-${it + 1}`);
                        break;
                    }
                    if (!faked.length) break;
                    console.warn(`🔌 [MCP] 檢測到 ${faked.length} 個正文假工具調用, 代為執行:`, faked.map(c => c.exposedName).join(', '));
                    await persistMcpLeadIn(contentNow, faked);
                    setSearchStatus(`正在調用 MCP 工具：${faked.map(c => c.exposedName).join('、')}...`);
                    const results: string[] = [];
                    for (const call of faked) {
                        lastExecutedSig = toolCallFingerprint(call.exposedName, call.args);
                        let r: any;
                        try { r = await callMcpTool(call.server, call.toolName, call.args); }
                        catch (e: any) { r = { success: false, error: e?.message || String(e) }; }
                        results.push(r.success
                            ? `工具 ${call.exposedName} 執行成功, 結果: ${formatMcpToolResult(r.data)}`
                            : `工具 ${call.exposedName} 執行失敗: ${r.error}`);
                    }
                    if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                    textLoopMessages.push({ role: 'assistant', content: contentNow });
                    textLoopMessages.push({
                        role: 'user',
                        content: `[系統消息：你把工具調用寫成了聊天文字，系統已代為執行：\n${results.join('\n')}\n如果目標已經完成，請直接用角色語氣回覆；如果仍需下一步工具，只輸出一行真正能推進目標的工具調用，不要重複讀取同一說明或狀態。不要提及這條系統消息。]`,
                    });
                    const reachedHardLimit = it + 1 >= MAX_TEXT_LOOPS;
                    if (reachedHardLimit) {
                        textLoopMessages.push({
                            role: 'user',
                            content: '[系統消息：工具階段已到本輪安全上限。停止調用工具，基於已有結果直接回復；如目標未完成就如實說明。不要輸出工具調用格式或提及本消息。]',
                        });
                    }
                    setSearchStatus('正在整理 MCP 工具結果...');
                    const followBody = buildMcpTextFallbackBody(baseReqBody, textLoopMessages);
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `mcp-text-${it + 1}`);
                    if (reachedHardLimit) break;
                }
                setSearchStatus('');
            }

            // DEBUG: Log full API response details for troubleshooting truncation issues
            console.log('🔍 [API Response Debug]', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                usage: data.usage,
                content_length: data.choices?.[0]?.message?.content?.length,
                raw_content: data.choices?.[0]?.message?.content,
                reasoning_content: data.choices?.[0]?.message?.reasoning_content,
                reasoning_content_length: data.choices?.[0]?.message?.reasoning_content?.length,
                model: data.model,
                id: data.id,
            }, null, 2));

            // ─── 後處理管線 (13 步) ───
            // 詳見 utils/applyAssistantPostProcessing.ts。本地路徑跑完整管線；
            // 雲端回覆（activeMsgRuntime 沖刷收件箱）也調它，帶 skipSecondPassLLM=true 和
            // worker 識別好的 directives 重放。
            // 後處理會逐條寫庫/刷新，第一條落庫並不代表其餘氣泡已準備好。
            // 整輪結束前保持預覽，登記對應正式消息供 UI 暫時隱藏；全部落庫後再一起交接。
            const previewHandoverIds = new Set<number>();
            const previewBaselineMaxId = contextMsgs.reduce(
                (maxId, message) => Math.max(maxId, message.id),
                Number.NEGATIVE_INFINITY,
            );
            const setMessagesWithPreviewHandover = (msgs: Message[]) => {
                const newlyHandedOverIds = findNewStreamPreviewHandoverIds(
                    msgs,
                    latestStreamPreviewBubbles,
                    previewBaselineMaxId,
                    previewHandoverIds,
                );
                const handoverIds = new Set(newlyHandedOverIds);
                if (streamThinkingShown) {
                    const thinkingHost = msgs.find(message =>
                        message.id > previewBaselineMaxId && message.role === 'assistant'
                    );
                    if (thinkingHost && !previewHandoverIds.has(thinkingHost.id)) handoverIds.add(thinkingHost.id);
                }
                if (handoverIds.size > 0) {
                    handoverIds.forEach(id => previewHandoverIds.add(id));
                    // ref 在 setMessages 觸發渲染前同步更新，首幀就能關掉正式氣泡的 fade-in。
                    onStreamPreviewHandover?.(char.id, [...handoverIds]);
                    setStreamingHandoverIds([...previewHandoverIds]);
                }
                setMessages(msgs);
            };
            const rawAiContent = data.choices?.[0]?.message?.content || '';
            const sarReply = parseSARModuleReply(rawAiContent, sarModulePlan);
            const latestUserMessage = currentMsgs.slice().reverse().find(message => (
                message.role === 'user' && message.type === 'text'
            ));
            const sarModuleEvents = createSARModuleEventMeta(sarModulePlan);
            const userSurfaces = parseSARUserSurfaces(sarReply.userSurface,
                selectSARUserSurfaceTargets(contextMsgs, char.id, sarModulePlan.user));
            for (const [messageId, surface] of userSurfaces) {
                const meta = createSARModuleSurfaceMeta(sarModulePlan.user!, surface);
                if (meta) await DB.updateMessageMetadata(messageId, previous => ({
                    ...(previous || {}), sarModuleSurface: meta,
                }));
            }
            if (latestUserMessage?.id && sarModuleEvents.length > 0) {
                await DB.updateMessageMetadata(latestUserMessage.id, previous => ({
                    ...(previous || {}),
                    ...(sarModuleEvents.length > 0 ? { sarModuleEvents } : {}),
                }));
            }
            const assistantSurfaceMeta = sarModulePlan.character?.phase === 'active' && sarReply.assistantSurface
                ? createSARModuleSurfaceMeta(sarModulePlan.character, sarReply.assistantSurface)
                : undefined;
            const xhsCaches: XhsCaches = {
                xsecTokenCache: xsecTokenCacheRef.current,
                noteTitleCache: noteTitleCacheRef.current,
                commentUserIdCache: commentUserIdCacheRef.current,
                commentAuthorNameCache: commentAuthorNameCacheRef.current,
                commentParentIdCache: commentParentIdCacheRef.current,
            };
            // onCharTransferSend 同一輪回復裡可能被連續調用好幾次（角色一口氣發了不止一筆
            // 轉帳）；char.phoneState.realBalance 是這一輪拿到手時的快照，整輪期間不會跟著
            // 前一筆轉帳的扣款更新。這個變量在每筆轉帳後手動往前滾，讓同一輪內的後一筆
            // 轉帳查到的是「已經扣過前一筆」的餘額，不會拿同一份起始餘額重複通過檢查。
            let charRealBalanceSnapshot: ReturnType<typeof ensureRealBalanceState> | undefined;
            await applyAssistantPostProcessing(sarReply.canonical, {
                char,
                userProfile,
                emojis,
                categories,
                realtimeConfig,
                imageGenConfig: apiConfig.imageGenConfig,
                // 角色退回用戶發起的轉帳時退款回 Real Balance——錢在 Chat.tsx 的 onTransfer
                // 發送那一刻就已經扣走了。只在這條前台路徑傳，主動消息 2.0 的 push 路徑上
                // TRANSFER_RETURN 標籤本來就傳不到 chatParser（worker 側已知缺口），傳了也白傳。
                onUserTransferReturned: async (amount: number) => {
                    updateUserProfile(prev => {
                        const result = applyRealBalanceDelta(ensureRealBalanceState(prev.realBalance), amount, `${char.name} 退回了轉帳`);
                        return result.ok ? { realBalance: result.state } : {};
                    });
                },
                // 角色收下用戶發起的轉帳：這筆錢這時才真的到帳角色，記入角色自己的 Real Balance
                // （跟用戶側 apps/Chat.tsx 的 handleResolveTransfer 'accepted' 分支對稱）。
                onUserTransferAccepted: async (amount: number) => {
                    updateCharacter(char.id, previous => {
                        const result = applyRealBalanceDelta(ensureRealBalanceState(previous.phoneState?.realBalance), amount, `收到${userProfile.name}的轉帳`);
                        if (!result.ok) return {};
                        return { phoneState: { ...previous.phoneState, records: previous.phoneState?.records || [], realBalance: result.state } };
                    });
                },
                // 角色主動發起轉帳：發送即結清，先從角色 Real Balance 扣款；扣不出來返回 false，
                // chatParser 會攔下這筆轉帳不落卡（跟用戶側發起轉帳時的餘額檢查對稱）。
                //
                // 檢查結果必須同步算出來再 return——不能像 onUserTransferAccepted 那樣把 ok
                // 塞進 updateCharacter 的函數式 updater 裡再讀出來：updater 傳給 setState 後
                // 何時真的執行是 React 調度決定的，不保證在 updateCharacter() 這行返回前跑完
                // （尤其是從 await 鏈後半段調用時）。踩過的坑：updater 沒來得及跑，ok 停在
                // 初始值 false，導致明明有餘額也被判定「不足」而攔下整筆轉帳。
                // 所以直接拿這一輪拿到手的 char（本次渲染的快照，夠新）同步算好 ok/result，
                // updateCharacter 只管照著算好的結果落庫，不再依賴 updater 的執行時機。
                onCharTransferSend: async (amount: number) => {
                    const before = charRealBalanceSnapshot ?? ensureRealBalanceState(char.phoneState?.realBalance);
                    const result = applyRealBalanceDelta(before, -amount, `轉帳給${userProfile.name}`);
                    if (!result.ok) return false;
                    charRealBalanceSnapshot = result.state;
                    updateCharacter(char.id, previous => ({
                        phoneState: { ...previous.phoneState, records: previous.phoneState?.records || [], realBalance: result.state },
                    }));
                    return true;
                },
                // 角色支付購物中心「外賣代付請求」：單向支出（角色替用戶付了這頓錢），不是轉帳，
                // 所以只扣角色自己的 Real Balance，沒有對應的用戶入帳。跟 onCharTransferSend 共用
                // 同一份 charRealBalanceSnapshot——一輪回復裡角色可能既轉帳又付了筆代付，兩邊
                // 得算在同一份"從這輪開始算起"的餘額上，不能各自拿同一份起始快照重複通過檢查。
                onCharDaifuAccept: async (amount: number) => {
                    const before = charRealBalanceSnapshot ?? ensureRealBalanceState(char.phoneState?.realBalance);
                    const result = applyRealBalanceDelta(before, -amount, `代付給${userProfile.name}的外賣`);
                    if (!result.ok) return false;
                    charRealBalanceSnapshot = result.state;
                    updateCharacter(char.id, previous => ({
                        phoneState: { ...previous.phoneState, records: previous.phoneState?.records || [], realBalance: result.state },
                    }));
                    return true;
                },
                // 角色主動送用戶一份購物中心禮物/外賣：跟 onCharTransferSend 對稱的「發送即結清」，
                // 也共用同一份 charRealBalanceSnapshot（同一輪回復裡角色可能轉帳/代付/送禮齊上）。
                onCharGiftSend: async (amount: number) => {
                    const before = charRealBalanceSnapshot ?? ensureRealBalanceState(char.phoneState?.realBalance);
                    const result = applyRealBalanceDelta(before, -amount, `送給${userProfile.name}的禮物`);
                    if (!result.ok) return false;
                    charRealBalanceSnapshot = result.state;
                    updateCharacter(char.id, previous => ({
                        phoneState: { ...previous.phoneState, records: previous.phoneState?.records || [], realBalance: result.state },
                    }));
                    return true;
                },
                groups,
                contextMsgs,
                fullMessages,
                initialData: data,
                historyMsgCount,
                mcdInheritMeta,
                xhsCaches,
                api: {
                    baseUrl,
                    headers,
                    effectiveApi,
                },
                hooks: {
                    setMessages: setMessagesWithPreviewHandover,
                    addToast,
                    setRecallStatus,
                    setSearchStatus,
                    setDiaryStatus,
                    setXhsStatus,
                    updateTokenUsage,
                    // 整組 musicHooks 由 MusicProvider 註冊到模塊級 slot, 本地 fetch 路徑和
                    // 雲端回覆的沖刷 (activeMsgRuntime) 共享同一份, 見 MusicContext.loadMusicHooks.
                    musicHooks: loadMusicHooks() ?? undefined,
                },
                // 流式預覽已把氣泡展示過 → 落庫免打字延遲，秒回填（未預覽時行為不變）
                instantRender: streamPreviewShown,
                // Phase 0: 本地 fetch 路徑保持原邏輯, 不跳 2nd-pass LLM, 也沒有結構化 directives。
                skipSecondPassLLM: false,
                directives: [],
                sarModuleSurface: assistantSurfaceMeta,
            });
            // 最後一批正式消息已交給 setMessages；同一輪更新撤掉預覽，不再逐條補彈。
            setStreamingBubbles([]);
            setStreamingThinking('');

            // 到這裡說明正文已成功落庫。失敗 / 中斷不會經過；重擲是替換舊回合，不重複扣壽命。
            if (!skipEmotionInjection) {
                if (sarModulePlan.character) {
                    updateCharacter(char.id, previous => ({
                        vrState: { ...(previous.vrState || { enabled: false, intervalMinutes: 120 }), sarModule: advanceSARModuleAfterReply(previous.vrState?.sarModule, sarModulePlan.character) },
                    }));
                }
                if (sarModulePlan.user) {
                    updateUserProfile(previous => ({
                        vrState: { ...(previous.vrState || { enabled: false }), sarModule: advanceSARModuleAfterReply(previous.vrState?.sarModule, sarModulePlan.user) },
                    }));
                }
            }

            // 本地路徑回覆已全部落庫。OSContext 監聽這個事件 bump lastMsgTimestamp——
            // 當前掛載的 Chat（可能是切走又切回後新 mount 的實例，本閉包的 setMessages
            // 對它已失效）會重新 reloadMessages；用戶不在該會話時補未讀 + toast。
            // 即時對話路徑不發：它的落庫回落走 'active-msg-received'（activeMsgRuntime）。
            announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: char.id, charName: char.name });

            // 防穿幫閘：僅當這輪請求真的成功、回執確實進了模型上下文併產出已落庫的
            // 回覆，才標記已告知；失敗/中斷路徑不標，下輪重新注入（回執不丟）。
            // 放在 try 成功尾部（回覆已 applyAssistantPostProcessing 落庫），與 catch/finally 互斥；
            // 即時對話路徑在上方已 return，這裡只覆蓋本地 fetch 路徑。
            if (amsg2ExpiredIds.length) {
                void ActiveMsgStore.markExpiredNoticesNotified(char.id, amsg2ExpiredIds);
            }

        } catch (e: any) {
            // 注意: 這個 catch 兜的是「拿到 API 響應之後」的整條後處理管線 (applyAssistantPostProcessing,
            // 13 步)。這裡拋錯多半不是網絡問題, 而是解析/正則/落庫異常。別再叫"連接中斷"誤導排查。
            const errMsg = e?.message || String(e);
            // 瑞一杯模式下報錯: 大概率是聊天模型/中轉不支持 function calling(tools) → 帶 tools 一發就 400。
            // 在 APK 裡看不到控制台, 這裡把完整原因 + 解法存成可讀消息, 方便排查。
            if (luckinChatRef?.current?.active && /\b400\b|tool|function[_\s-]?call/i.test(errMsg)) {
                await DB.saveMessage({
                    charId: char.id, role: 'system', type: 'text',
                    content: `[瑞一杯失敗] ${errMsg}\n\n大概率是你當前聊天用的「模型/中轉」不支持函數調用(function calling / tools)——瑞一杯靠角色自己調工具點單, 模型不支持就會直接報 400。\n解決: 換一個支持 tools 的模型/中轉 (如官方 OpenAI / Claude / 多數主流中轉)。\n另外確認: APK 是全新存儲, 你的聊天 API 配置(密鑰/地址/模型)在 APK 裡填好了嗎?`,
                });
            } else {
                await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[回覆處理失敗: ${errMsg}]` });
            }
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } finally {
            releaseReply();
            setLocalTyping(false);
            KeepAlive.stop();
            // 本輪生成結束（成功/失敗/中斷都經過）→ 停止本地續租；遠端靠 45s TTL 自然失效。
            // 未開過租約（即時對話 / 非 amsg2 角色）時是冪等 no-op。
            stopAmsgChatPresence(char.id);
            // 全局橫幅熄滅（成功/失敗/即時對話均經過這裡；OSContext 同時借它兜底刷新，
            // 覆蓋 catch 裡落庫的錯誤系統消息）。
            announceChatGen(CHAT_GEN_EVENTS.replyEnd, { charId: char.id, charName: char.name });
            setStreamingBubbles([]);  // 錯誤/中斷路徑兜底清預覽
            setStreamingThinking('');
            setStreamingHandoverIds([]);
            setRecallStatus('');
            setSearchStatus('');
            setDiaryStatus('');
            setXhsStatus('');

            // 滿血主動消息：一輪聊完把該角色標髒，fire_pack 隨即批量同步到 worker 的
            // client_state（未配 amsg2 任務的角色在 markDirty 內直接忽略，零成本）。
            // 本輪角色自己排過任務時 char 快照上的清單已經過期，得用工具會話裡的最新那份
            // 打髒——否則本輪新建的首個任務過不了 markDirty 的 hasActiveAiTask 門，
            // fire_pack 會停在排程那一刻、少掉角色排完之後說的這段。
            // 即時對話受理成功那一輪跳過：那次 POST 已經把這一輪的 fire_pack（還多帶了
            // chat 段）傳上去了，這裡再打髒就是同樣的內容再走一趟網絡。
            if (!instantChatAccepted) {
                markAmsgStateDirty({
                    char: { ...char, activeMsg2Config: amsg2Session.getConfig() },
                    userProfile, groups, realtimeConfig,
                });
            }

            // Memory Palace — 後台緩衝區處理（不阻塞 UI，內部有併發鎖）
            // 使用全局配置（memoryPalaceConfig）。lightLLM 未配置時回退主 apiConfig；
            // embedding 因端點類型特殊（/embeddings），不做回退，必須顯式配置。
            const mpEmb = memoryPalaceConfig?.embedding;
            const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
            const mpLLM = (mpLLMConfigured?.baseUrl)
                ? mpLLMConfigured
                : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
            // 讀 ref 拿到最新的 char 狀態；同 id 才信任，否則保守跳過（用戶已經切角色了）
            const liveChar = charRef.current?.id === char.id ? charRef.current : null;
            if (liveChar?.memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                const charName = char.name;
                // 不再預置"正在回味"狀態：pipeline 會在水位線未到時立刻 skip，
                // 預置狀態會讓"沉思"指示器一閃讓用戶誤以為在幹活。
                // onProgress 在 pipeline 真正進入處理路徑後（過完 hot_zone/threshold 檢查）
                // 才首次觸發 setMemoryPalaceStatus，這樣 skip 路徑下指示器不會亮。

                // 緩衝區處理（LLM提取 + Embedding向量化）
                const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                processNewMessagesWithAutoArchive(recentMsgs, char.id, charName, mpEmb, mpLLM, userProfile?.name || '', false, (stage) => {
                        setMemoryPalaceStatus(stage);
                    })
                    .then(async (pipelineResult) => {
                        // pipeline 跑的過程中用戶可能又關掉了宮殿，跑完後所有"額外動作"
                        // （autoArchive 寫 char.memories / 50 輪認知消化的 LLM 調用）都要再 check 一次。
                        const liveAfter = charRef.current?.id === char.id ? charRef.current : null;
                        if (!liveAfter?.memoryPalaceEnabled) return;

                        // 顯示結果讓用戶看到
                        if (pipelineResult && pipelineResult.stored > 0) {
                            setMemoryPalaceResult(pipelineResult);
                        }

                        // 全自動記憶雙寫已由統一封裝完成，React 外的入口也不會再漏接返回值。
                        // 輪數計數 + 自動認知消化（每50輪觸發一次）
                        const shouldAutoDigest = incrementDigestRound(char.id);
                        if (shouldAutoDigest) {
                            console.log(`🧠 [AutoDigest] 已達 50 輪，自動觸發認知消化...`);
                            setMemoryPalaceStatus(`${charName}閉上眼睛，開始整理內心…`);
                            const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
                            const result = await runCognitiveDigestion(
                                char.id, charName, persona, mpLLM, false, userProfile?.name, mpEmb,
                                // 消化鏈路可能含多次 LLM 調用（審視→歷史回填續傳→門牌整理），
                                // 實時刷狀態條讓用戶知道後台在幹活、別急著關頁面
                                (stage) => setMemoryPalaceStatus(`${charName}${stage}`),
                            );
                            if (result) {
                                // 自我領悟不再追加到 char.selfInsights（只進不出的舊常駐層）——
                                // 歸宿已改為 self_room 門牌（digestion 內部提交），這裡只負責彈窗昭告
                                const total = result.resolved.length + result.deepened.length + result.faded.length +
                                    result.fulfilled.length + result.disappointed.length + result.internalized.length +
                                    result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length +
                                    (result.worries?.length || 0) + (result.aspirations?.length || 0) + (result.distilled?.length || 0);
                                if (total > 0) {
                                    setLastDigestResult(result);
                                }
                            }
                        }
                    })
                    .catch(e => { console.error('❌ [MemoryPalace] 後台處理異常:', e.message); addToast('記憶整理失敗', 'error'); })
                    .finally(() => {
                        // 如果狀態文本包含"完成"，先讓用戶看到再清除
                        const current = memoryPalaceStatusRef.current;
                        if (current && current.includes('完成')) {
                            addToast(current, 'success');
                        }
                        setMemoryPalaceStatus('');
                    });
            }

            // 意識流進化現在由副 API 的情緒評估同輪產出（innerState 字段），
            // 不再需要獨立的後台 API 調用，也不再分散主 API 注意力。
        }
    };



    // ─── Proactive Messaging Controls ───
    // NOTE: The actual proactive trigger handler is registered globally in OSContext
    // so it works even when Chat is not open. These are just start/stop helpers.

    const startProactiveChat = (intervalMinutes: number) => {
        if (!char) return;
        ProactiveChat.start(char.id, intervalMinutes);
    };

    const stopProactiveChat = () => {
        if (!char) return;
        ProactiveChat.stop(char.id);
    };

    const isProactiveActive = char ? ProactiveChat.isActiveFor(char.id) : false;

    return {
        isTyping,
        streamingBubbles,
        streamingThinking,
        streamingHandoverIds,
        recallStatus,
        searchStatus,
        diaryStatus,
        xhsStatus,
        emotionStatus,
        memoryPalaceStatus,
        memoryPalaceResult,
        setMemoryPalaceResult,
        lastDigestResult,
        setLastDigestResult,
        lastTokenUsage,
        tokenBreakdown,
        setLastTokenUsage, // Allow manual reset if needed
        triggerAI,
        startProactiveChat,
        stopProactiveChat,
        isProactiveActive,
        lastSystemPrompt,
        evolvedNarrative,
    };
};
