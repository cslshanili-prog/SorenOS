
import { CharacterProfile, UserProfile, DailySchedule } from '../types';
import { normalizeUserImpression } from './impression';
import { isScheduleFeatureOn } from './scheduleFeature';
import { buildScheduleInjection as buildScheduleInjectionText } from './scheduleInjection';
import { TIME_FRAMING_CONVERSATIONAL } from './timeFramingNote';
import { resolveCharTimeZone, nowInTimeZone, tzAwarenessNote, interactionGapNote } from './timezone';
import {
    formatWorldbookSection,
    resolveWorldbookEntries,
    splitWorldbookSections,
    type WorldbookScanMessage,
} from './worldbook';
import { buildSARModulePrompt } from './vrWorld/sarModuleRuntime';

/**
 * 「互動對象 (User)」塊的唯一拼裝口徑，私聊/群聊共用——名字/設定/備註永遠顯示（備註留空顯示"無"），
 * 性別/自定義設定/其他補充是新加的深度字段，選填，留空就不佔提示詞篇幅。
 */
function formatUserProfileBlock(user: UserProfile): string {
    let block = `### 互動對象 (User)\n`;
    block += `- 名字: ${user.name}\n`;
    if (user.gender) block += `- 性別: ${user.gender}\n`;
    block += `- 設定/備註: ${user.bio || '無'}\n`;
    if (user.customSetting?.trim()) block += `- 自定義設定: ${user.customSetting.trim()}\n`;
    if (user.otherDetails?.trim()) block += `- 其他補充: ${user.otherDetails.trim()}\n`;
    return block + `\n`;
}

/**
 * Memory Central
 * 負責統一構建所有 App 共用的基礎角色上下文 (System Prompt)。
 * 包含：身份設定、用戶畫像、世界觀、核心記憶、詳細記憶、以及角色內心看法。
 */
export const ContextBuilder = {

    /**
     * SAR 模塊的唯一上下文出口。調用方按自身輸出格式選擇 chat/date，避免把模塊規則
     * 複製進每個 App，也避免誤改基礎人設、記憶召回或情緒狀態本身。
     */
    buildSARModuleContext: (
        char: CharacterProfile,
        user: UserProfile,
        surface: 'chat' | 'date',
    ): string => buildSARModulePrompt(char, user, surface),

    /**
     * 構建角色設定+記憶上下文（角色名、核心指令、世界觀 + 月度總結 & 當月日度總結）
     * 用於情緒評估，不包含世界書、印象、用戶畫像等重型數據，不截斷
     *
     * @param options.skipMemories 跳過月度總結和日度記錄（開啟記憶宮殿時用向量記憶替代）
     */
    buildRoleSettingsContext: (char: CharacterProfile, options?: { skipMemories?: boolean }): string => {
        let context = `[System: Character Role Settings]\n\n`;

        // 1. 角色名
        context += `### 角色名\n`;
        context += `${char.name}\n\n`;

        // 2. 核心指令（完整，不截斷）
        context += `### 核心指令\n`;
        context += `${char.systemPrompt || '你是一個溫柔、擬人化的AI伴侶。'}\n\n`;

        // 2b. 自我領悟詞條（常駐自我認知，影響情緒評估）
        if (char.selfInsights && char.selfInsights.length > 0) {
            context += `### 內在認知\n`;
            char.selfInsights.forEach(insight => {
                context += `- ${insight}\n`;
            });
            context += `\n`;
        }

        // 3. 世界觀（完整，不截斷，不含世界書）
        if (char.worldview && char.worldview.trim()) {
            context += `### 世界觀與設定\n${char.worldview}\n\n`;
        }

        // 4. 記憶摘要（月度總結 + 當月日度總結）
        //    開啟記憶宮殿時 skipMemories=true，由調用方注入向量檢索結果替代
        if (!options?.skipMemories) {
            let memorySection = '';

            // 4a. 月度總結 (refinedMemories) — 全部輸出
            if (char.refinedMemories && Object.keys(char.refinedMemories).length > 0) {
                memorySection += `**月度總結 (Monthly Summaries)**:\n`;
                Object.entries(char.refinedMemories).sort().forEach(([date, summary]) => {
                    memorySection += `- [${date}]: ${summary}\n`;
                });
                memorySection += `\n`;
            }

            // 4b. 當月日度總結 — 只取當前月份
            const now = new Date();
            const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            if (char.memories && char.memories.length > 0) {
                const currentMonthLogs = char.memories.filter(m => {
                    let normDate = m.date.replace(/[\/年月]/g, '-').replace('日', '');
                    const parts = normDate.split('-');
                    if (parts.length >= 2) {
                        normDate = `${parts[0]}-${parts[1].padStart(2, '0')}`;
                    }
                    return normDate.startsWith(currentMonthKey);
                });
                if (currentMonthLogs.length > 0) {
                    memorySection += `**本月詳細記錄 [${currentMonthKey}]**:\n`;
                    currentMonthLogs.forEach(m => {
                        memorySection += `- ${m.date} (${m.mood || 'rec'}): ${m.summary}\n`;
                    });
                    memorySection += `\n`;
                }
            }

            if (memorySection) {
                context += `### 記憶摘要 (Memory Reference)\n`;
                context += memorySection;
                context += `⚠️ 情緒可以被記憶觸發：如果記憶中存在未解決的矛盾、反覆出現的摩擦模式、或對方曾經傷害過你的事件，你可以在情緒評估中讓角色"翻舊帳"——即某個記憶片段突然浮上心頭，引發新的buff或加劇已有buff的強度。這種情緒湧現應當自然且有跡可循，不要憑空捏造不存在的記憶。\n\n`;
            }
        }

        return context;
    },

    /**
     * 構建核心人設上下文
     * @param char 角色檔案
     * @param user 用戶檔案
     * @param includeDetailedMemories 是否包含激活月份的詳細 Log (默認 true)
     * @param memoryPalaceContext 外部注入的記憶宮殿文本（優先級低於 char.memoryPalaceInjection）
     * @param groupOptions 群聊場景下的去重選項：避免和 buildGroupSharedScene 產出的共享塊重複
     * @returns 標準化的 Markdown 格式 System Prompt
     */
    buildCoreContext: (
        char: CharacterProfile,
        user: UserProfile,
        includeDetailedMemories: boolean = true,
        memoryPalaceContext?: string,
        groupOptions?: {
            skipUserProfile?: boolean;
            skipWorldview?: boolean;
            skipWorldbookIds?: Set<string>;
            headerOverride?: string;
        },
        timeOptions?: {
            /** 傳入「最後一次和用戶互動的時間戳」→ 統一注入「距離上次聯繫多久」（受 timeAwarenessEnabled 控制）。 */
            lastInteractionTs?: number;
            /** 抑制整段時間感知（當前時間/時差/距上次聯繫）。見面純架空（dateTimeAwarenessEnabled=false）時用。 */
            skipTimeAwareness?: boolean;
            /** 正有人在跟角色實時對話（私聊 / 見面）。見 buildTimeAwarenessBlock 同名字段。 */
            conversational?: boolean;
            /** Recent messages used to activate keyword-based worldbook entries. */
            worldbookMessages?: WorldbookScanMessage[];
        },
        layout?: {
            /**
             * 把「每輪/每分鐘都會變」的三塊（當前時間、記憶宮殿召回、情緒 buff）從本函數輸出裡
             * 摘出去，由調用方通過 buildVolatileCoreState 拿到後放到消息數組末尾。
             * 目的：讓 system prompt 前綴穩定，吃到中轉的 prompt 前綴緩存（TTFT 直降）。
             * 只有聊天主路徑（chatPrompts.buildSystemPromptParts）用；其他 App 不傳，行為不變。
             */
            deferVolatile?: boolean;
        },
    ): string => {
        const skipBookIds = groupOptions?.skipWorldbookIds;
        const filteredBooks = (char.mountedWorldbooks || []).filter(wb => !skipBookIds || !skipBookIds.has(wb.id));
        const worldbookSections = splitWorldbookSections(resolveWorldbookEntries(
            filteredBooks,
            timeOptions?.worldbookMessages || [],
            char.name,
            user.name,
        ));

        let context = formatWorldbookSection(worldbookSections.beforeCharacter, '世界書 · 角色設定前');
        context += `${groupOptions?.headerOverride ?? '[System: Roleplay Configuration]'}\n\n`;

        // 1. 核心身份 (Identity)
        context += `### 你的身份 (Character)\n`;
        context += `- 名字: ${char.name}\n`;
        // Change: Explicitly label description as User Note to avoid literal interpretation
        context += `- 用戶備註/愛稱 (User Note/Nickname): ${char.description || '無'}\n`;
        context += `  (注意: 這個備註是用戶對你的稱呼或印象，可能包含比喻。如果備註內容（如“快樂小狗”）與你的核心設定衝突，請以核心設定為準，不要真的扮演成動物，除非核心設定裡寫了你是動物。)\n`;
        context += `- 核心性格/指令:\n${char.systemPrompt || '你是一個溫柔、擬人化的AI伴侶。'}\n\n`;

        // 1a. 真實時間感知 (Time Awareness) — 跟隨 timeAwarenessEnabled 設置，默認開啟。
        // 統一在 buildCoreContext 注入，讓所有調用方（私聊/查手機/人際關係/通話/約會…）都知道"現在"。
        // deferVolatile 時不在這裡輸出（時間精確到分鐘、每輪都變，會打斷 prompt 前綴緩存），
        // 改由調用方經 buildVolatileCoreState 放到消息數組末尾。
        if (!layout?.deferVolatile) {
            context += ContextBuilder.buildTimeAwarenessBlock(char, timeOptions);
        }

        // 1b. 自我領悟詞條 (Self Insights) — 消化過程中反芻產生的常駐自我認知
        // 像情緒底色一樣影響角色的行為和感受，注入在角色設定緊下方
        if (char.selfInsights && char.selfInsights.length > 0) {
            context += `### 內在認知 (Self Insights)\n`;
            context += `以下是你在獨處反思中逐漸想明白的事，它們已經成為你的一部分：\n`;
            char.selfInsights.forEach(insight => {
                context += `- ${insight}\n`;
            });
            context += `\n`;
        }

        // 2. 世界觀 (Worldview) - New Centralized Logic
        if (char.worldview && char.worldview.trim() && !groupOptions?.skipWorldview) {
            context += `### 世界觀與設定 (World Settings)\n${char.worldview}\n\n`;
        }

        context += formatWorldbookSection(worldbookSections.afterCharacter, '擴展設定集 (Worldbooks)');
        context += formatWorldbookSection(worldbookSections.beforeExamples, '世界書 · 示例消息前');
        context += formatWorldbookSection(worldbookSections.afterExamples, '世界書 · 示例消息後');

        // 3. 用戶畫像 (User Profile)
        // 群聊場景下：用戶畫像已在共享場景塊頂部，這裡跳過避免重複
        if (!groupOptions?.skipUserProfile) {
            context += formatUserProfileBlock(user);
        }

        // 4. [NEW] 印象檔案 (Private Impression)
        // 這是角色對用戶的私密看法，只有角色知道
        const imp = normalizeUserImpression(char.impression);
        if (imp) {
            context += `### [私密檔案: 我眼中的${user.name}] (Private Impression)\n`;
            context += `(注意：以下內容是你內心對TA的真實看法，不要直接告訴用戶，但要基於這些看法來決定你的態度。)\n`;
            context += `- 核心評價: ${imp.personality_core.summary}\n`;
            context += `- 互動模式: ${imp.personality_core.interaction_style}\n`;
            context += `- 我觀察到的特質: ${imp.personality_core.observed_traits.join(', ')}\n`;
            context += `- TA的喜好: ${imp.value_map.likes.join(', ')}\n`;
            if (imp.behavior_profile.emotion_summary) context += `- TA的情緒模式: ${imp.behavior_profile.emotion_summary}\n`;
            if (imp.emotion_schema.triggers.positive.length) context += `- 正向觸發點（什麼會讓ta開心）: ${imp.emotion_schema.triggers.positive.join(', ')}\n`;
            context += `- 情緒雷區（負向觸發）: ${imp.emotion_schema.triggers.negative.join(', ')}\n`;
            if (imp.emotion_schema.stress_signals.length) context += `- 壓力信號（ta狀態不對的徵兆）: ${imp.emotion_schema.stress_signals.join(', ')}\n`;
            context += `- 舒適區: ${imp.emotion_schema.comfort_zone}\n`;
            context += `- 最近觀察到的變化: ${imp.observed_changes ? imp.observed_changes.map(c => typeof c === 'string' ? c : (c as any)?.description ? `[${(c as any).period}] ${(c as any).description}` : JSON.stringify(c)).join('; ') : '無'}\n\n`;
        }

        // 4b. 底色認知（記憶宮殿門牌）— 常駐語義層
        // 與召回記憶不同：這是每輪都在的"你早已知道的背景"，不走相似度抽取。
        // 必須用 memoryPalaceEnabled 把關，理由同下方 5b：注入字段會被 saveCharacter
        // 持久化，宮殿關閉後 injectMemoryPalace 不再刷新它，不校驗就會注入殘留。
        if (char.memoryPalaceEnabled && char.roomPlatesInjection && char.roomPlatesInjection.trim()) {
            context += `${char.roomPlatesInjection}\n`;
        }

        // 5. 記憶庫 (Memory Bank)
        context += `### 記憶系統 (Memory Bank)\n`;
        let memoryContent = "";

        // 5a. 長期核心記憶 (Refined Memories)
        if (char.refinedMemories && Object.keys(char.refinedMemories).length > 0) {
            memoryContent += `**長期核心記憶 (Key Memories)**:\n`;
            Object.entries(char.refinedMemories).sort().forEach(([date, summary]) => { 
                memoryContent += `- [${date}]: ${summary}\n`; 
            });
        }

        // 5b. 激活的詳細記憶 (Active Detailed Logs)
        if (includeDetailedMemories && char.activeMemoryMonths && char.activeMemoryMonths.length > 0 && char.memories) {
            let details = "";
            char.activeMemoryMonths.forEach(monthKey => {
                // monthKey format: YYYY-MM
                // Robust Date Matching: Normalize memory date separators to '-' and compare prefix
                // This ensures compatibility with 'YYYY/MM/DD', 'YYYY年MM月DD日', and 'YYYY-MM-DD'
                const logs = char.memories.filter(m => {
                    // 1. Replace separators / or 年 or 月 with -
                    // 2. Remove '日'
                    // 3. Ensure single digit months/days are padded (e.g. 2024-1-1 -> 2024-01-01) for strict matching, 
                    //    but simplest is to just check startsWith after rough normalization.
                    let normDate = m.date.replace(/[\/年月]/g, '-').replace('日', '');
                    
                    // Basic fix for "2024-1-1" vs "2024-01" matching issues
                    const parts = normDate.split('-');
                    if (parts.length >= 2) {
                        const y = parts[0];
                        const mo = parts[1].padStart(2, '0');
                        normDate = `${y}-${mo}`;
                    }
                    
                    return normDate.startsWith(monthKey);
                });
                
                if (logs.length > 0) {
                    details += `\n> 詳細回憶 [${monthKey}]:\n`;
                    logs.forEach(m => {
                        details += `  - ${m.date} (${m.mood || 'rec'}): ${m.summary}\n`;
                    });
                }
            });
            if (details) {
                memoryContent += `\n**當前激活的詳細回憶 (Active Recall)**:${details}`;
            }
        }

        if (!memoryContent) {
            memoryContent = "(暫無特定記憶，請基於當前對話互動)";
        }
        context += `${memoryContent}\n\n`;

        // 5b. 記憶宮殿 (Memory Palace) — 向量檢索結果
        // 僅在 includeDetailedMemories 時注入，與詳細日誌同級
        // buildCoreContext(false) 的調用點（情緒評估、輕量上下文等）靠月度總結即可
        // 必須用 memoryPalaceEnabled 把關：injectMemoryPalace 在關閉時直接 return、
        // 既不刷新也不清空 char.memoryPalaceInjection，而該字段又會被 saveCharacter
        // 持久化。若此處不校驗總開關，關閉後舊的召回結果仍會被注入進 system prompt，
        // 表現為"宮殿已關、後台無召回，角色卻還在精準複述記憶"。與下方 Buff 注入同理。
        // deferVolatile：召回結果每輪都變 → 移交 buildVolatileCoreState。
        if (!layout?.deferVolatile && includeDetailedMemories && char.memoryPalaceEnabled) {
            const mpContext = char.memoryPalaceInjection || memoryPalaceContext;
            if (mpContext && mpContext.trim()) {
                context += `${mpContext}\n\n`;
            }
        }

        // 6. 情緒底色 Buff (Emotion Buff Injection)
        // 放在角色設定之後，使所有調用 ContextBuilder 的 App 都能感知情緒狀態
        // 總開關關閉時完全跳過，防止殘留 buff 繼續汙染 prompt
        // deferVolatile：buff 每輪情緒評估後都可能變 → 移交 buildVolatileCoreState。
        if (!layout?.deferVolatile && isScheduleFeatureOn(char) && char.emotionConfig?.enabled && char.buffInjection) {
            context += `${char.buffInjection}\n\n`;
            console.log(`🎭 [Context] Buff injected for ${char.name}:\n`, char.buffInjection);
            console.log(`🎭 [Context] Active buffs:`, JSON.stringify(char.activeBuffs || [], null, 2));
        }

        context += formatWorldbookSection(worldbookSections.authorsNoteTop, '世界書 · 作者註釋頂部');
        context += formatWorldbookSection(worldbookSections.authorsNoteBottom, '世界書 · 作者註釋底部');

        // 7. 表達底線 (Anti-Filler) —— 全 App 通用的精簡版防套話提示。
        // 模型八股（空泛感慨、萬能句式）是"沒話找話"時的填充物，這裡只做正向引導
        // （去挖具體素材），不列任何禁語——把禁語寫進提示詞反而會激活它（粉色大象）。
        // 完整方法版在 datePrompts 的 DIG_DEEPER_BLOCK（見面模式專用，可按角色開關）。
        // 群聊流（groupOptions）跳過：多成員場景會重複注入 N 份，群聊側暫不接入。
        if (!groupOptions) {
            context += `### 表達底線 (Anti-Filler)\n當你覺得"沒什麼可說"的時候，不要用空泛的感慨、萬能句式或華麗排比去填充——那是沒話找話，對方一眼就能看出來。素材永遠比你以為的多：對方的用詞、ta 怎麼說的、ta 沒說的部分、此刻的情境、你們的過去、你心裡閃過的念頭——挑一兩條往深處走就夠了。寧可一個具體的小細節，不要一句誰都能說的話。\n\n`;
        }

        // Debug: warn about missing context sections
        const missing: string[] = [];
        if (!char.systemPrompt) missing.push('systemPrompt');
        if (!char.impression) missing.push('impression');
        if (!char.refinedMemories || Object.keys(char.refinedMemories).length === 0) missing.push('refinedMemories');
        if (!char.activeMemoryMonths || char.activeMemoryMonths.length === 0) missing.push('activeMemoryMonths');
        if (!char.mountedWorldbooks || char.mountedWorldbooks.length === 0) missing.push('worldbooks');
        if (!char.worldview) missing.push('worldview');
        if (missing.length > 0) {
            console.log(`⚠️ [Context] Missing/empty fields: ${missing.join(', ')} | context_chars=${context.length}`);
        } else {
            console.log(`✅ [Context] All fields present | context_chars=${context.length}`);
        }

        return context;
    },

    /**
     * 真實時間感知塊（原 buildCoreContext 1a 段，逐字一致）。
     * 單獨抽出來是為了讓聊天主路徑能把它挪到消息數組末尾（deferVolatile），
     * 其餘 App 仍由 buildCoreContext 內部調用、位置不變。
     */
    buildTimeAwarenessBlock: (
        char: CharacterProfile,
        timeOptions?: {
            lastInteractionTs?: number;
            skipTimeAwareness?: boolean;
            /**
             * 這次注入是不是「正有人在跟角色說話」（私聊、見面這類實時對話）。
             * 只有這時才補那句語境框定，見下方註釋。默認 false：日程 / 歌單 / 攻略 /
             * 手冊 / 小劇場這些生成器同樣走 buildCoreContext，但那邊並沒有人在對話。
             */
            conversational?: boolean;
        },
    ): string => {
        // skipTimeAwareness：見面純架空時由調用方傳入，徹底抑制時間注入（修「線下時間感知」關掉後仍漏時間）。
        if (char.timeAwarenessEnabled === false || timeOptions?.skipTimeAwareness) return '';
        // 自定義時區（異國戀等）：開啟後這裡的"當前時間"按角色所在時區折算，並附時差提示，
        // 讓查手機/人際關係/通話等所有直連 buildCoreContext 的路徑都拿到正確的本地時間。
        const charTz = resolveCharTimeZone(char);
        const now = nowInTimeZone(charTz);
        const h = now.getHours();
        const dayNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
        const timeOfDay =
            h < 5 ? '凌晨' : h < 9 ? '早晨' : h < 12 ? '上午' : h < 14 ? '中午'
            : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 22 ? '晚上' : '深夜';
        const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
        const timeStr = `${h.toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        let context = `### 當前時間 (Now)\n`;
        context += `現在是 ${dateStr} ${dayNames[now.getDay()]} ${timeOfDay} ${timeStr}。請據此自然地擁有真實的時間觀念（早晚作息、工作日/週末、距離上次互動多久等），不要憑空假設時間。\n`;
        // 報時後面那句語境框定（這句話本身和「為什麼只在對話時給」都在
        // utils/timeFramingNote.ts）。即時對話走的是雲端那條路，時間由 worker 到點補，
        // 那邊引的是同一份常量——同一句話不抄兩遍，免得兩條路上的角色分寸不一樣。
        if (timeOptions?.conversational) {
            context += `${TIME_FRAMING_CONVERSATIONAL}\n`;
        }
        const tzNote = tzAwarenessNote(charTz);
        if (tzNote) context += `${tzNote.trim()}\n`;
        // 距離上次聯繫多久（統一口徑）：傳了 lastInteractionTs 才注入。
        // 讓查手機/人際關係等無內聯消息流的路徑，也像聊天一樣知道「用戶多久沒聯繫我了」。
        const gapNote = interactionGapNote(timeOptions?.lastInteractionTs);
        if (gapNote) context += gapNote;
        context += `\n`;
        return context;
    },

    /**
     * buildCoreContext(deferVolatile) 的另一半：時間 → 記憶宮殿召回 → 情緒 buff。
     * 三塊的開關判定與 buildCoreContext 內聯版完全一致，只是輸出位置交給調用方
     * （聊天主路徑放到消息數組末尾的"當前狀態" system 消息裡）。
     */
    buildVolatileCoreState: (
        char: CharacterProfile,
        options?: {
            includeDetailedMemories?: boolean;
            memoryPalaceContext?: string;
            timeOptions?: { lastInteractionTs?: number; skipTimeAwareness?: boolean; conversational?: boolean };
        },
    ): string => {
        let context = ContextBuilder.buildTimeAwarenessBlock(char, options?.timeOptions);

        const includeDetailedMemories = options?.includeDetailedMemories ?? true;
        if (includeDetailedMemories && char.memoryPalaceEnabled) {
            const mpContext = char.memoryPalaceInjection || options?.memoryPalaceContext;
            if (mpContext && mpContext.trim()) {
                context += `${mpContext}\n\n`;
            }
        }

        if (isScheduleFeatureOn(char) && char.emotionConfig?.enabled && char.buffInjection) {
            context += `${char.buffInjection}\n\n`;
            console.log(`🎭 [Context] Buff injected for ${char.name}:\n`, char.buffInjection);
            console.log(`🎭 [Context] Active buffs:`, JSON.stringify(char.activeBuffs || [], null, 2));
        }

        return context;
    },

    /**
     * 群聊場景共享塊。
     *
     * 單次調用裡如果給每個角色都重複貼一遍"用戶檔案+世界書+世界觀"，
     * 三人群就是 3 倍的佈景重複，把 token 燒光。這裡把"舞台"提前一次性鋪好：
     *
     *   - 用戶檔案：所有角色看到的都是同一個用戶，去重必然安全。
     *   - 世界書：按 id 統計，被 ≥2 個角色掛載的視為"群共有設定"，提到頂部一次。
     *     只有某個角色獨享的世界書仍留在該角色塊裡，避免別人看到本不該知道的設定。
     *   - 世界觀：僅當所有成員的 worldview 字符串完全一致時才視為共享。
     *
     * 返回的 sharedWorldbookIds / worldviewIsShared 用於配合 buildCoreContext
     * 的 skipUserProfile / skipWorldbookIds / skipWorldview 選項，避免重複輸出。
     *
     * 男朋友還是男朋友——這裡砍的只是"我們現在在這家餐廳"這種描述，
     * 沒有任何一段是把誰的人設、印象、記憶壓縮掉。
     */
    buildGroupSharedScene: (
        members: CharacterProfile[],
        user: UserProfile,
        worldbookMessages: WorldbookScanMessage[] = [],
    ): {
        text: string;
        sharedWorldbookIds: Set<string>;
        worldviewIsShared: boolean;
    } => {
        const sharedWorldbookIds = new Set<string>();
        let worldviewIsShared = false;

        if (members.length === 0) {
            return { text: '', sharedWorldbookIds, worldviewIsShared };
        }

        // 1. 找出共享的世界書（被 2+ 角色掛載，按 id 計）
        const wbCount = new Map<string, { count: number; entry: { id: string; title: string; content: string; category?: string } }>();
        for (const m of members) {
            for (const wb of (m.mountedWorldbooks || [])) {
                if (!wb.id) continue;
                const existing = wbCount.get(wb.id);
                if (existing) existing.count += 1;
                else wbCount.set(wb.id, { count: 1, entry: wb });
            }
        }
        const sharedBooks: { id: string; title: string; content: string; category?: string }[] = [];
        wbCount.forEach((v, id) => {
            if (v.count >= 2) {
                sharedWorldbookIds.add(id);
                sharedBooks.push(v.entry);
            }
        });

        // 2. 共享 worldview：所有成員的非空 worldview 字符串完全一致
        if (members.every(m => m.worldview && m.worldview.trim())) {
            const first = members[0].worldview!.trim();
            if (members.every(m => m.worldview!.trim() === first)) {
                worldviewIsShared = true;
            }
        }

        // 3. 拼裝共享場景文本
        let text = `[System: 群聊場景共享設定 (Group Scene)]\n`;
        text += `（以下是群裡所有角色都共同感知到的"舞台"——用戶是誰、共有的世界設定。每位角色的個人卡、印象、記憶等仍在各自的"角色檔案"塊中保持完整。）\n\n`;

        text += formatUserProfileBlock(user);

        if (worldviewIsShared) {
            text += `### 共有世界觀 (Shared World Settings)\n${members[0].worldview!.trim()}\n\n`;
        }

        const resolvedSharedBooks = resolveWorldbookEntries(sharedBooks, worldbookMessages, '', user.name);
        text += formatWorldbookSection(resolvedSharedBooks, '共有擴展設定集 (Shared Worldbooks)');

        return { text, sharedWorldbookIds, worldviewIsShared };
    },

    /**
     * 構建日程注入文本。實現住在 utils/scheduleInjection.ts —— 那是個零依賴的純葉子，
     * 主動消息到點生成時 worker 也要渲染同一段（見 utils/amsgFireScene.ts），
     * 兩邊共用一份才不會出現「聊天裡說在健身房、主動消息裡說在睡覺」。
     */
    buildScheduleInjection: buildScheduleInjectionText,

    /**
     * 音樂氛圍注入：
     * 1) user 此刻真的在播放音樂 + char.canReadUserMusic 開 → 注入"對方正在聽 X + 當前歌詞窗口（前2當前後2）"
     *    + 同曲歌單命中提示（該歌也在 char 某個歌單裡）
     * 2) char 自己此刻在聽（Schedule 聽歌時段） → 注入"你此刻在聽 Y"（不含歌詞，char 知道自己聽什麼）
     *
     * 設計：
     * - 輸出的提示詞簡短克制，不引導 char 做具體動作；動作由 buildMusicActionGuide 單獨注入
     * - 純文本塊，完全可以為空字符串（無 listening 狀態時不汙染 prompt）
     * - char 自己的 currentListening 以 runtime 參數傳入（chatPrompts 層 recompute），
     *   不依賴 char.musicProfile.currentListening 的持久狀態
     */
    buildMusicAtmosphere: (
        char: CharacterProfile,
        userName: string,
        userListening: {
            songName: string;
            artists: string;
            lyricWindow: string[];      // 前2當前後2（共 ≤5 行）；可為空（沒歌詞）
            activeIdx: number;          // 在 lyricWindow 裡的高亮位置，-1 表示沒歌詞
        } | null,
        charListening?: {
            songId?: number;            // 用來回查這首歌是不是從 user 收來的
            songName: string;
            artists: string;
            vibe?: string;
            // schedule 層注入的一段穩定歌詞行（不含時間戳；Slot 內穩定，slot 一過就換）。
            // 作用是單方面豐富 char 的內心世界 —— 歌詞可以影響情緒 / 心境，
            // 但 char 沒有義務主動把這件事告訴 user。
            lyricSnippet?: string[];
        } | null,
        // char 是否已和 user "一起聽"（由 MusicContext.listeningTogetherWith 決定）。
        // 暫停 / 切歌 / 播放出錯 / user 顯式踢出 都會讓 char 從名單裡掉出來，
        // 走到這裡時就會退回 "對方在聽" 的旁觀措辭。
        isListeningTogether?: boolean,
        // 剛才一起聽途中歌被切了（本 char 在名單裡、還沒重新加入）。
        // 只在下一輪正常回復裡讓 char "察覺"到換歌，不觸發主動消息。
        recentTrackSwitch?: { songName: string; artists: string } | null,
    ): string => {
        const lines: string[] = [];

        // —— 塊 1: user 正在聽什麼 ——
        const canRead = char.musicProfile?.canReadUserMusic ?? true;
        if (canRead && userListening && userListening.songName) {
            lines.push(`### 【此刻的對話氛圍】`);
            if (isListeningTogether) {
                lines.push(`你正在和 ${userName || '對方'} 一起聽《${userListening.songName}》— ${userListening.artists}`);
            } else {
                lines.push(`${userName || '對方'} 正在聽《${userListening.songName}》— ${userListening.artists}`);
                if (recentTrackSwitch && recentTrackSwitch.songName !== userListening.songName) {
                    lines.push(`（你們剛才本來在一起聽《${recentTrackSwitch.songName}》— ${recentTrackSwitch.artists}，播放器切歌后那次"一起聽"自然結束了。你能察覺到歌換成了現在這首；想繼續陪 ${userName || '對方'} 聽下去就在回覆裡自然接上並重新加入，不想也不必勉強，順其自然。）`);
                }
            }
            if (userListening.lyricWindow.length > 0) {
                lines.push(`當前播放到（>> 標記正在播放這一行）:`);
                userListening.lyricWindow.forEach((l, i) => {
                    if (i === userListening.activeIdx) lines.push(`  >> ${l}`);
                    else lines.push(`  … ${l}`);
                });
            }

            // 歌單命中提示（按 songName 粗匹，避免在 context.ts 裡引 MusicContext）
            const profile = char.musicProfile;
            if (profile) {
                const hitPl = profile.playlists.find(pl =>
                    pl.songs.some(s => s.name === userListening.songName));
                if (hitPl) {
                    lines.push(`（這首歌也在你的歌單《${hitPl.title}》裡）`);
                }
            }
            lines.push(`（你只是自然地知道 ${userName || '對方'} 此刻在聽這首——像共處一室時隱約聽見的背景音。不用每次都評論歌名、歌詞或風格，多數時候安靜地陪著就好；只有真的被某句打動、或對方主動聊起時，再自然地接上。）`);
            lines.push('');
        }

        // —— 塊 2: char 自己此刻在聽（Schedule 觸發） ——
        // 原來只推歌名 + 藝人；現在順便帶一段穩定的歌詞片段，讓這首歌能真的
        // 影響 char 的心境（單方面豐富精神世界，不用非得對 user 說起）。
        if (charListening?.songName) {
            lines.push(`### 【你此刻的背景音】`);
            lines.push(`你正在聽《${charListening.songName}》— ${charListening.artists}`);
            if (charListening.vibe) lines.push(`（${charListening.vibe}）`);

            // user 來源標記 —— 如果這首歌是當初從 user 收進自己歌單的，
            // 讓 char 自然意識到這層關係（"這是 ta 聽過的歌"）。
            const profile = char.musicProfile;
            if (profile && charListening.songId != null) {
                let userSourcedPlTitle: string | null = null;
                for (const pl of profile.playlists) {
                    const hit = pl.songs.find(s => s.id === charListening.songId && s.source === 'user');
                    if (hit) { userSourcedPlTitle = pl.title; break; }
                }
                if (userSourcedPlTitle) {
                    lines.push(`（這首是當初從 ${userName || '對方'} 那裡聽到、收進《${userSourcedPlTitle}》的 — 此刻播到它，你自然會想到 ta）`);
                }
            }

            if (charListening.lyricSnippet && charListening.lyricSnippet.length > 0) {
                lines.push(`這段歌詞正在你腦子裡繞：`);
                for (const l of charListening.lyricSnippet) lines.push(`  · ${l}`);
                lines.push(`（這段旋律和文字會自然影響你此刻的心境 / 語氣 / 情緒細節。不必特地向 ${userName || '對方'} 提起，除非你本來就想說。）`);
            }
            lines.push('');
        }

        // —— 塊 3: char 自己的歌單清單 ——
        // 只在**有音樂上下文**（user 在聽 OR char 自己在 schedule 裡聽）時注入。
        // 沒音樂上下文時不往 prompt 裡塞這段 — 避免普通聊天被無關信息汙染、
        // 也避免 LLM 在沒提示 add 語法的場合主動聯想去操作歌單。
        const hasMusicContext = !!(userListening && userListening.songName) || !!charListening?.songName;
        const profile = char.musicProfile;
        if (hasMusicContext && profile && profile.playlists.length > 0) {
            lines.push(`### 【你的歌單】`);
            for (const pl of profile.playlists) {
                const desc = pl.description ? ` — ${pl.description}` : '';
                const moodTag = pl.mood ? ` [${pl.mood}]` : '';
                lines.push(`  · 《${pl.title}》(${pl.songs.length} 首)${moodTag}${desc}`);
            }
            // 列出每個歌單裡最近收進的幾首用戶來源歌，讓 LLM 聊起歌單時有料可講
            const userSongsPerPl: string[] = [];
            for (const pl of profile.playlists) {
                const fromUser = pl.songs
                    .filter(s => s.source === 'user')
                    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
                    .slice(0, 3);
                if (fromUser.length > 0) {
                    const titles = fromUser.map(s => `《${s.name}》`).join('、');
                    userSongsPerPl.push(`  · 《${pl.title}》裡從 ${userName || '對方'} 那兒收的：${titles}`);
                }
            }
            if (userSongsPerPl.length > 0) {
                lines.push(`（從 ${userName || '對方'} 那兒收進來的歌 — 聊起這些歌時你會自然想到 ta）:`);
                for (const l of userSongsPerPl) lines.push(l);
            }
            lines.push('');
        }

        return lines.join('\n');
    },

    /**
     * 音樂行動指令（告訴 LLM 怎麼輸出 music_action 指令）
     * 這個塊**只在 user 正在聽歌**的時候注入，避免 char 在沒上下文時亂 call。
     *
     * 如果 char 已經和 user 處於"一起聽"狀態，隱藏 join / join_and_add 選項 —
     * 防止 LLM 重複插"加入"卡片。
     */
    buildMusicActionGuide: (isListeningTogether?: boolean): string => {
        // 把"加入歌單"那段說明抽出來 — 兩種狀態都用同一份
        const addUsage = `**加入歌單的語法**（如果用 \`add\` 系列）：
  - \`[[MUSIC_ACTION:add]]\` — 默認放進你的第一個歌單
  - \`[[MUSIC_ACTION:add|歌單標題]]\` — 放進你已經有的某個歌單（用"【你的歌單】"塊裡列出的標題）
  - \`[[MUSIC_ACTION:add_new|新歌單標題|描述]]\` — 現場新建一個歌單，把這首作為第一首（描述可省）
  請優先選**最貼合這首歌氣質**的現有歌單；如果都不合適、又確實想收，再考慮新建。
  收進來的歌會被打上"從對方那裡聽到"的標籤 —— 以後你單獨聽到這首時，會自然想起 ta。`;
        if (isListeningTogether) {
            return `### 【音樂互動工具】
你此刻已經在和對方一起聽這首，不用再"加入"。如果想把這首也收進自己的歌單，可以在這一輪**最多一次**用下面的指令:
- \`add\` 系列（見下）

${addUsage}

不要頻繁插卡；只有真的被這首歌打動、或和當前對話氣氛契合時才用。
`;
        }
        return `### 【音樂互動工具】
如果你真的想回應對方正在聽的這首歌，可以在這一輪**最多一次**用下面的指令（只插一條，放在文本任意位置，會被自動替換為卡片）:
- \`[[MUSIC_ACTION:join]]\` — 表示"我也一起聽這首"（會亮出"一起聽"狀態，直到歌曲結束 / 暫停 / 對方主動結束才解除）
- \`add\` 系列 — 把這首收進你自己的歌單
- \`[[MUSIC_ACTION:join_and_add(|歌單標題)]]\` 或 \`[[MUSIC_ACTION:join_and_add_new|新歌單標題|描述]]\` — 同時做兩件事

${addUsage}

這些是偶爾才用的工具，不是每首歌都要回應。絕大多數時候什麼都不做、安靜陪著才是最自然的反應；只有當你**真的**被這首歌打動、或它恰好貼合此刻的對話氣氛時，再插一次卡。不要把它當成"對方在聽歌"的默認回禮。
`;
    },
};
