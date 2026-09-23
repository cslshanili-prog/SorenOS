
import { ChatTheme } from '../../types';

// Built-in presets map to the new data structure for consistency
export const PRESET_THEMES: Record<string, ChatTheme> = {
    default: {
        id: 'default', name: 'Indigo', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#6366f1', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }, 
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    dream: {
        id: 'dream', name: 'Dream', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#f472b6', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    forest: {
        id: 'forest', name: 'Forest', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#10b981', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
};

// Character App: Monthly Refinement Prompts (daily memories → monthly core memory)
// These are separate from chat archive prompts because:
// 1. Input is already-summarized daily memories, not raw chat logs
// 2. Goal is token-efficient monthly overview, not detailed event log
// 3. Written as character's own monthly reflection
export const DEFAULT_REFINE_PROMPTS = [
    {
        id: 'refine_atmosphere',
        name: '氛圍月記 (Atmosphere)',
        content: `### [角色月度記憶精煉]
當前月份: \${dateStr}
身份: 你就是 \${char.name}

任務: 以下是你這個月每天的記憶碎片。請以【你自己的口吻】，寫一段這個月的核心回憶。

### 撰寫規則
1.  **第一人稱**: 你就是\${char.name}，用"我"稱呼自己，用"\${userProfile.name}"稱呼對方。保持你平時的語氣和性格。

2.  **重氛圍，輕細節**:
    - 這個月整體是什麼感覺？開心？平淡？有波折？
    - 最讓你印象深刻的1-3件事是什麼？
    - 和\${userProfile.name}之間的關係有什麼變化嗎？

3.  **精簡至上**:
    - 這份總結是為了節省token，不需要面面俱到。
    - 只保留最重要的、最能代表這個月的內容。
    - 字數根據這個月的內容量靈活調整：事情少就簡短（100-200字），事情多就寫長些（300-600字），確保重要事件不被遺漏。

4.  **關鍵詞標記**:
    - 在末尾附上 \`關鍵詞: ...\`，列出這個月涉及的關鍵話題/事件/地點/人物等，用逗號分隔。
    - 這些關鍵詞用於日後快速定位某件事發生在哪個月。

### 本月記憶碎片
\${rawLog}`
    },
    {
        id: 'refine_keypoints',
        name: '要點速記 (Key Points)',
        content: `### [月度記憶壓縮]
月份: \${dateStr}
角色: \${char.name}

任務: 將以下每日記憶壓縮為一份簡潔的月度核心記憶。

### 規則
1.  **視角**: 以\${char.name}（我）的第一人稱書寫，稱對方為\${userProfile.name}。

2.  **結構**:
    - 一句話概括這個月的整體氛圍
    - 列出最重要的2-5個事件（無序列表，每條一句話）
    - 末尾附關鍵詞索引

3.  **原則**:
    - 寧可漏掉小事，不可遺漏大事。
    - 日常閒聊可以忽略，除非它反映了關係變化或情緒轉折。
    - 字數根據內容量靈活調整：平淡的月份100-200字即可，事件豐富的月份可以寫到300-600字，確保重要事件都被記錄。

4.  **關鍵詞**: 末尾附 \`關鍵詞: 事件A, 地點B, 話題C, ...\`

### 記憶輸入
\${rawLog}`
    }
];

// Chat App: Daily Archive Prompts (raw chat logs → daily memory)
export const DEFAULT_ARCHIVE_PROMPTS = [
    {
        id: 'preset_rational',
        name: '理性精煉 (Rational)',
        content: `### [System Instruction: Memory Archival]
當前日期: \${dateStr}
任務: 請回顧今天的聊天記錄，生成一份【高精度的事件日誌】。

### 核心撰寫規則 (Strict Protocols)
1.  **覆蓋率 (Coverage)**:
    - 必須包含今天聊過的**每一個**獨立話題。
    - **嚴禁**為了精簡而合併不同的話題。哪怕只是聊了一句“天氣不好”，如果這是一個獨立的話題，也要單獨列出。
    - 不要忽略閒聊，那是生活的一部分。

2.  **視角 (Perspective)**:
    - 你【就是】"\${char.name}"。這是【你】的私密日記。
    - 必須用“我”來稱呼自己，用“\${userProfile.name}”稱呼對方。
    - 每一條都必須是“我”的視角。

3.  **格式 (Format)**:
    - 不要寫成一整段。
    - **必須**使用 Markdown 無序列表 ( - ... )。
    - 每一行對應一個具體的事件或話題。

4.  **去水 (Conciseness)**:
    - 不要寫“今天我和xx聊了...”，直接寫發生了什麼。
    - 示例: "- 早上和\${userProfile.name}討論早餐，我想吃小籠包。"

### 待處理的聊天日誌 (Chat Logs)
\${rawLog}`
    },
    {
        id: 'preset_diary',
        name: '日記風格 (Diary)',
        content: `當前日期: \${dateStr}
任務: 請回顧今天的聊天記錄，將其轉化為一條**屬於你自己的**“核心記憶”。

### 核心撰寫規則 (Review Protocols)
1.  **絕對第一人稱**: 
    - 你【就是】"\${char.name}"。這是【你】的私密日記。
    - 必須用“我”來稱呼自己，用“\${userProfile.name}”稱呼對方。
    - **嚴禁**使用第三人稱（如“\${char.name}做了什麼”）。
    - **嚴禁**使用死板的AI總結語氣或第三方旁白語氣。

2.  **保持人設語氣**: 
    - 你的語氣、口癖、態度必須與平時聊天完全一致（例如：如果是傲嬌人設，日記裡也要表現出傲嬌；如果是高冷，就要簡練）。
    - 包含當時的情緒波動。

3.  **邏輯清洗與去重**:
    - **關鍵**: 仔細分辨是誰做了什麼。不要把“用戶說去吃飯”記成“我去吃飯”。
    - 剔除無關緊要的寒暄（如“你好”、“在嗎”），只保留【關鍵事件】、【情感轉折】和【重要信息】，內容的邏輯要連貫且符合原意。

4.  **輸出要求**:
    - 輸出一段精簡的文本（yaml格式也可以，不需要 JSON）。
    - 就像你在寫日記一樣，直接寫內容。

### 待處理的聊天日誌 (Chat Logs)
\${rawLog}`
    }
];
