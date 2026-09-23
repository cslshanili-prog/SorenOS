
import { CharacterProfile, NovelBook, NovelSegment, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { safeResponseJson } from './safeApi';
import { includesAnyScript } from './scriptKey';

// --- Visual Themes ---
export const NOVEL_THEMES = [
    { id: 'sakura', name: '櫻花 (Sakura)', bg: 'bg-pink-50', paper: 'bg-[#fff5f7]', text: 'text-slate-700', accent: 'text-pink-500', button: 'bg-pink-400', activeTab: 'bg-pink-500 text-white' },
    { id: 'parchment', name: '羊皮紙 (Vintage)', bg: 'bg-[#f5e6d3]', paper: 'bg-[#fdf6e3]', text: 'text-[#433422]', accent: 'text-[#8c6b48]', button: 'bg-[#b58900]', activeTab: 'bg-[#b58900] text-white' },
    { id: 'kraft', name: '牛皮紙 (Kraft)', bg: 'bg-[#d7ccc8]', paper: 'bg-[#e7e0d8]', text: 'text-[#3e2723]', accent: 'text-[#5d4037]', button: 'bg-[#5d4037]', activeTab: 'bg-[#5d4037] text-white' },
    { id: 'midnight', name: '深夜 (Midnight)', bg: 'bg-[#0f172a]', paper: 'bg-[#1e293b]', text: 'text-slate-300', accent: 'text-blue-400', button: 'bg-blue-600', activeTab: 'bg-blue-600 text-white' },
    { id: 'matcha', name: '抹茶 (Matcha)', bg: 'bg-[#ecfccb]', paper: 'bg-[#f7fee7]', text: 'text-emerald-800', accent: 'text-emerald-600', button: 'bg-emerald-500', activeTab: 'bg-emerald-500 text-white' },
];

export interface GenerationOptions {
    write: boolean;
    comment: boolean;
    analyze: boolean;
}

// --- INTELLIGENT TAGGING SYSTEM ---
export const extractWritingTags = (char: CharacterProfile): string[] => {
    if (!char) return ['風格未定'];

    const tags = new Set<string>();
    const desc = ((char.description || '') + (char.worldview || '')).toLowerCase();
    
    // 1. 從 impression 提取（如果有）
    if (char.impression) {
        const traits = char.impression.personality_core?.observed_traits || [];
        const mbti = char.impression.mbti_analysis?.type || '';
        const likes = char.impression.value_map?.likes || [];
        const dislikes = char.impression.value_map?.dislikes || [];

        // MBTI 維度
        if (mbti.includes('N')) { tags.add('意象豐富'); tags.add('跳躍'); }
        else if (mbti.includes('S')) { tags.add('細節考據'); tags.add('寫實'); }
        if (mbti.includes('T')) { tags.add('邏輯嚴密'); tags.add('克制'); }
        else if (mbti.includes('F')) { tags.add('情感細膩'); tags.add('渲染力強'); }
        if (mbti.includes('J')) { tags.add('結構工整'); tags.add('伏筆'); }
        else if (mbti.includes('P')) { tags.add('隨性'); tags.add('反轉'); }

        // 特質映射
        const traitMap: Record<string, string[]> = {
            '冷': ['冷峻', '極簡'], '傲嬌': ['口是心非', '心理戲多'],
            '溫柔': ['治癒', '舒緩'], '樂天': ['輕快', '對話密集'],
            '中二': ['燃', '誇張'], '電波': ['意識流', '抽象'],
            '腹黑': ['暗喻', '懸疑'], '社恐': ['內心獨白', '敏感'],
            '強勢': ['快節奏', '壓迫感'], '貓': ['喵體文學', '慵懶'],
            '活潑': ['輕快', '跳躍'], '理性': ['邏輯嚴密', '客觀'],
            '感性': ['情感細膩', '渲染力強'], '高冷': ['冷峻', '留白']
        };
        traits.forEach(t => {
            Object.entries(traitMap).forEach(([key, values]) => {
                if (includesAnyScript(t, key)) values.forEach(v => tags.add(v));
            });
        });

        // 價值觀
        if (likes.some(l => includesAnyScript(l, '美') || includesAnyScript(l, '藝術'))) tags.add('唯美');
        if (dislikes.some(d => includesAnyScript(d, '虛偽'))) tags.add('犀利直白');
    }
    
    // 2. 從描述提取（無論有沒有 impression）
    const descMap: Record<string, string[]> = {
        '古風': ['古韻', '半文白'], '武俠': ['快意', '古韻'],
        '科幻': ['硬核', '技術流'], '貓': ['喵體文學', '慵懶'],
        '溫柔': ['治癒', '舒緩'], '可愛': ['萌系', '輕快'],
        '冷': ['冷峻', '克制'], '熱血': ['燃', '快節奏'],
        '搞笑': ['吐槽', '跳躍'], '暗黑': ['暗喻', '懸疑']
    };
    Object.entries(descMap).forEach(([key, values]) => {
        if (includesAnyScript(desc, key)) values.forEach(v => tags.add(v));
    });

    // 3. 從 writerPersona 提取
    if (char.writerPersona) {
        const p = char.writerPersona;
        if (includesAnyScript(p, '新手')) tags.add('青澀');
        if (includesAnyScript(p, '大師')) tags.add('老練');
        if (includesAnyScript(p, '詩意')) tags.add('詩意');
        if (includesAnyScript(p, '大白話')) tags.add('口語化');
        if (includesAnyScript(p, '寫實')) tags.add('寫實');
        if (includesAnyScript(p, '動作')) tags.add('動作流');
        if (includesAnyScript(p, '情感')) tags.add('情感流');
        if (includesAnyScript(p, '對話')) tags.add('對話密集');
    }

    // 4. Fallback
    let result = Array.from(tags);
    if (result.length === 0) {
        // 基於角色名生成穩定的默認標籤
        const defaults = ['自然流', '平實', '日常', '穩定', '樸素'];
        const seed = (char.name?.charCodeAt(0) || 0) % defaults.length;
        result = [defaults[seed], defaults[(seed + 2) % defaults.length]];
    }
    
    // 穩定排序：基於角色名 + 標籤名生成固定順序，避免每次渲染都變化
    const hash = (str: string) => {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }
        return h;
    };
    const seed = hash(char.name || 'default');
    
    return result
        .sort((a, b) => {
            const hashA = hash(a + seed.toString());
            const hashB = hash(b + seed.toString());
            return hashA - hashB;
        })
        .slice(0, 5);
};

// --- Helper: Writer Persona Analysis (Simple) ---
export const analyzeWriterPersonaSimple = (char: CharacterProfile): string => {
    if (!char) return "未知風格"; 
    
    const traits = char.impression?.personality_core.observed_traits || [];
    const mbti = char.impression?.mbti_analysis?.type || '';
    const desc = char.description || '';
    
    const personaMap: Record<string, any> = {
        '冷漠': { focus: '邏輯漏洞、戰術細節', style: '簡潔、克制，避免情感渲染', rhythm: '快節奏，少廢話', taboo: '煽情、過度心理描寫' },
        '高冷': { focus: '邏輯漏洞、戰術細節', style: '簡潔、克制，避免情感渲染', rhythm: '快節奏，少廢話', taboo: '煽情、過度心理描寫' },
        '冷靜': { focus: '因果關係、客觀事實', style: '冷靜、旁觀者視角', rhythm: '穩定', taboo: '情緒化表達' },
        '樂天': { focus: '人物互動、溫馨細節', style: '輕快、多對話，愛用"！"', rhythm: '跳躍式，可能突然插科打諢', taboo: '長篇陰鬱描寫、絕望氛圍' },
        '活潑': { focus: '人物互動、溫馨細節', style: '輕快、多對話，愛用"！"', rhythm: '跳躍式，可能突然插科打諢', taboo: '長篇陰鬱描寫、絕望氛圍' },
        '感性': { focus: '情緒波動、微表情、內心戲', style: '細膩、意識流，大量心理活動', rhythm: '緩慢，停留在一個瞬間反覆琢磨', taboo: '乾巴巴的動作描寫、快節奏戰鬥' },
        '溫柔': { focus: '情感交流、氛圍營造', style: '柔和、細膩', rhythm: '舒緩', taboo: '粗暴、血腥' },
        '傲嬌': { focus: '口是心非、彆扭的關心', style: '帶有情緒色彩，心理活動豐富', rhythm: '起伏不定', taboo: '直球、坦率' },
        '中二': { focus: '酷炫場景、角色帥氣度', style: '誇張、比喻多、愛用"——"破折號', rhythm: '爆發式，高潮迭起', taboo: '平淡日常、瑣碎細節' },
        '電波': { focus: '奇怪的聯想、超展開', style: '跳躍、抽象、不明覺厲', rhythm: '混亂', taboo: '循規蹈矩' },
        '腹黑': { focus: '潛在危機、人性陰暗面', style: '優雅、暗藏玄機', rhythm: '從容', taboo: '傻白甜' },
        '理性': { focus: '因果關係、世界觀邏輯', style: '客觀、有條理，像寫報告', rhythm: '穩定，按時間線推進', taboo: '跳躍剪輯、模糊的意象' }
    };

    let matchedTrait = traits.find(t => personaMap[t]) || (traits.length > 0 ? traits[0] : '理性');
    // Fuzzy Match
    if (!personaMap[matchedTrait]) {
        if (includesAnyScript(matchedTrait, '冷')) matchedTrait = '冷漠';
        else if (includesAnyScript(matchedTrait, '熱') || includesAnyScript(matchedTrait, '活')) matchedTrait = '樂天';
        else if (includesAnyScript(matchedTrait, '柔') || includesAnyScript(matchedTrait, '感')) matchedTrait = '感性';
        else matchedTrait = '理性';
    }
    
    let persona = personaMap[matchedTrait] || personaMap['理性'];

    const mbtiMap: Record<string, string> = {
        'INTJ': '戰略佈局、權力博弈', 'INTP': '概念解構、設定嚴謹',
        'ENTJ': '宏大敘事、征服感', 'ENTP': '腦洞大開、反轉',
        'INFJ': '宿命感、救贖', 'INFP': '理想主義、內心成長',
        'ENFJ': '人際羈絆、群體命運', 'ENFP': '自由冒險、浪漫奇遇',
        'ISTJ': '細節考據、現實邏輯', 'ISFJ': '守護、回憶',
        'ESTJ': '秩序、規則衝突', 'ESFJ': '社交氛圍、家庭倫理',
        'ISTP': '動作細節、機械原理', 'ISFP': '美學體驗、感官描寫',
        'ESTP': '感官刺激、即時反應', 'ESFP': '當下享樂、戲劇衝突'
    };
    let mbtiInsight = mbtiMap[mbti] || '劇情推進';

    let output = `
### ${char.name} 的創作人格檔案 (Simple)
**核心性格**: ${matchedTrait}
**關注點**: ${persona.focus}，${mbtiInsight}
**筆觸**: ${persona.style}
**節奏**: ${persona.rhythm}
**審美**: 喜歡${char.impression?.value_map.likes.join('、') || '未知'}
**禁忌**: ${persona.taboo}
`;

    if (includesAnyScript(desc, '貓') || includesAnyScript(desc, '喵') || (traits.includes('貓') || traits.includes('猫'))) {
        output += `
### ⚠️ 特別注意：你是貓！
寫作特徵：
1. 用短句（貓的注意力不持久）。
2. 關注"能不能吃"、"舒不舒服"、"好不好玩"。
3. 突然走神寫一段環境描寫（如"陽光真暖"）。
4. 吐槽時必須帶"喵"。
禁止：寫出像人類一樣的理性長篇大論。
`;
    }

    return output;
};

// --- Helper: Extract Writing Taboos ---
export const extractWritingTaboos = (char: CharacterProfile): string => {
    const traits = char.impression?.personality_core.observed_traits || [];
    const dislikes = char.impression?.value_map.dislikes || [];
    
    let taboos = `## ${char.name} 的寫作禁區（你必須遵守）：\n`;
    
    // 根據性格生成禁忌
    if (traits.some(t => includesAnyScript(t, '冷') || includesAnyScript(t, '高冷') || includesAnyScript(t, '理性'))) {
        taboos += `
- ❌ 禁止：煽情、超過2句話的心理描寫、任何"感動"相關詞彙。
- ❌ 禁止：使用“彷彿”、“似乎”這種不確定的詞。
- ✅ 只能：白描動作、極簡對話、留白。
- 節奏：每段不超過3句話，快刀斬亂麻。
`;
    } else if (traits.some(t => includesAnyScript(t, '感性') || includesAnyScript(t, '溫柔'))) {
        taboos += `
- ❌ 禁止：粗暴的動作描寫、超過1個感嘆號、髒話。
- ❌ 禁止：乾巴巴的說明文式描寫。
- ✅ 只能：細膩的感官描寫、內心獨白、慢節奏鋪陳。
- 節奏：可以在一個瞬間停留很久，寫出呼吸感。
`;
    } else if (traits.some(t => includesAnyScript(t, '樂天') || includesAnyScript(t, '活潑'))) {
        taboos += `
- ❌ 禁止：超過3句話不出現對話、陰鬱氛圍、死亡話題。
- ✅ 只能：大量"！"、俏皮話、突然的吐槽。
- 節奏：跳躍式，可以突然岔開話題。
`;
    } else if (traits.some(t => includesAnyScript(t, '中二'))) {
        taboos += `
- ❌ 禁止：平淡的日常、"普通"這個詞、任何自嘲。
- ✅ 只能：誇張比喻、破折號、酷炫的動作描寫。
- 節奏：高潮迭起，每段都要有"燃點"。
`;
    } else {
        taboos += `
- ❌ 禁止：情緒化表達、模糊的意象、跳躍的時間線。
- ✅ 只能：客觀描述、因果邏輯、線性敘事。
- 節奏：穩定推進，像紀錄片。
`;
    }
    
    // 根據厭惡的事物追加禁忌
    if (dislikes.length > 0) {
        taboos += `\n### 額外禁忌（基於你的價值觀）：\n`;
        dislikes.forEach(d => {
            taboos += `- 如果劇情涉及"${d}"，你會下意識迴避細節描寫，或者表達出厭惡。\n`;
        });
    }
    
    // 特殊人格追加
    if (includesAnyScript(char.description ?? '', '貓') || (traits.includes('貓') || traits.includes('猫'))) {
        taboos += `\n### 🐱 貓屬性強制規則：\n`;
        taboos += `- 注意力最多持續3句話就要走神。\n`;
        taboos += `- 必須關注"舒適度"、"食物"、"好玩的東西"。\n`;
        taboos += `- 吐槽時必須帶"喵"。\n`;
        taboos += `- 禁止寫出人類式的長篇大論。\n`;
    }
    
    return taboos;
};

// --- Helper: Writer Persona Analysis (Deep) ---
export const generateWriterPersonaDeep = async (
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: any,
    updateCharacter: (id: string, updates: Partial<CharacterProfile>) => void,
    force: boolean = false
): Promise<string> => {
    if (!char) return "Error: No Character";

    if (!force && char.writerPersona && char.writerPersonaGeneratedAt) {
        const age = Date.now() - char.writerPersonaGeneratedAt;
        if (age < 7 * 24 * 60 * 60 * 1000) {
            return char.writerPersona;
        }
    }
    
    const analysisPrompt = `你是一位人物心理分析專家和寫作教練。我會給你一個虛擬角色的完整檔案，以及與他/她互動的用戶檔案。請你深入理解這個角色，然後告訴我：

**如果這個角色本人來寫小說，他/她會有什麼樣的創作風格？**

---

### 角色檔案

**姓名**: ${char.name}

**基礎描述**: 
${char.description || '無'}

**背景故事**: 
${char.worldview || '無詳細背景'}

**性格特質**: 
${char.impression?.personality_core.observed_traits.join('、') || '未知'}

**MBTI類型**: 
${char.impression?.mbti_analysis?.type || '未知'}

**核心價值觀**:
- 珍視/喜歡: ${char.impression?.value_map.likes.join('、') || '未知'}
- 厭惡/討厭: ${char.impression?.value_map.dislikes.join('、') || '未知'}

**個人癖好/習慣**:
${char.impression?.behavior_profile.response_patterns || '- 無'}

**近期記憶片段**（瞭解當前心境）:
${char.memories?.slice(-3).map(m => `- ${m.summary}`).join('\n') || '- 無記憶'}

---

### 互動對象（用戶背景）
(角色的記憶和性格形成深受用戶影響)
**用戶暱稱**: ${userProfile.name}
**用戶描述**: ${userProfile.bio || '無'}

---

### 分析任務

請從以下**8個維度**分析這個角色的寫作風格：

#### 1. 寫作能力 (Skill Level)
他/她實際上擅長寫作嗎？還是只是想寫？
- 新手：經常用錯詞，邏輯混亂，但有熱情
- 業餘：能寫通順，但技巧生硬
- 熟練：有自己的風格，技巧自然
- 大師：行雲流水，深諳敘事之道

#### 2. 語言風格 (Language)
他/她說話/寫作時用什麼語言？
- 大白話：口語化，"就是那種感覺你懂吧"
- 書面語：規範、優雅
- 詩意：比喻、意象豐富
- 學術：專業術語，邏輯嚴密

#### 3. 表現手法 (Technique)
他/她傾向寫實還是寫意？
- 寫實：精確描寫，像紀錄片
- 印象派：捕捉感覺，模糊但有氛圍
- 象徵派：用隱喻，一切都有深意

#### 4. 敘事重心 (Focus)
他/她寫作時最關注什麼？
- 動作：打鬥、追逐、機械操作
- 情感：內心戲、人際關係
- 對話：角色互動、語言交鋒
- 氛圍：環境、意境、美學

#### 5. 偏好與禁忌 (Preference)
他/她喜歡寫什麼？討厭寫什麼？
- 喜歡的題材/場景
- 避之不及的俗套

#### 6. 角色理解 (Character View)
他/她怎麼看待自己筆下的【小說主角】（Fictional Protagonist）？
(注意：是指小說裡的人物，不是指正在和他對話的用戶)
- 是英雄？受害者？工具人？
- 會不會對主角的行為有自己的意見？

#### 7. 劇情態度 (Plot Opinion)
他/她對當前劇情有什麼看法？
- 認為合理嗎？
- 會不會想改變走向？
- 有沒有更想寫的支線？

#### 8. 互動傾向 (Collaboration Style)
他/她會怎麼和共創搭檔（用戶）互動？
- 會吐槽搭檔寫得不對嗎？
- 會用專業術語"互毆"嗎？
- 還是默默接受搭檔的設定？
- 態度是冷漠、熱情、傲嬌還是溫柔？(參考性格特質)

---

**輸出格式**（嚴格遵守, 不要用markdown標記）：

寫作能力: (新手/業餘/熟練/大師) - 一句話說明理由

語言風格: (大白話/書面語/詩意/學術) - 舉例說明

表現手法: (寫實/印象派/象徵派) - 具體描述

敘事重心: (動作/情感/對話/氛圍) - 為什麼

偏好題材: (列舉3個) | 禁忌俗套: (列舉3個)

主角看法: (他/她怎麼看待小說主角？一句話)

劇情態度: (對當前劇情的看法，30字)

互動模式: (與用戶的互動風格？)

專業術語: (如果這個角色有特定領域的專業知識，列舉3-5個術語；沒有則寫"無")

---

**字數要求**：總共400-600字。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${apiConfig.apiKey}` 
            },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: analysisPrompt }],
                temperature: 0.7,
                max_tokens: 8000
            })
        });
        
        if (response.ok) {
            const data = await safeResponseJson(response);
            const rawPersona = data.choices[0].message.content.trim();
            
            const formattedPersona = `
### ${char.name} 的創作人格檔案（AI深度分析）

${rawPersona}

---
*分析生成於: ${new Date().toLocaleDateString('zh-CN')}*
`.trim();
            
            updateCharacter(char.id, { 
                writerPersona: formattedPersona,
                writerPersonaGeneratedAt: Date.now()
            });
            
            return formattedPersona;
        } else {
            throw new Error(`API Error: ${response.status}`);
        }
    } catch (e: any) {
        console.error('Deep analysis failed:', e);
        return analyzeWriterPersonaSimple(char);
    }
};

export const getFewShotExamples = (char: CharacterProfile) => {
    const traits = char.impression?.personality_core.observed_traits || [];
    let trait = traits.find(t => ['冷漠','高冷','感性','溫柔','樂天','活潑','中二','電波'].some(k => includesAnyScript(t, k))) || '理性';
    if (includesAnyScript(trait, '冷')) trait = '冷漠';
    if (includesAnyScript(trait, '柔') || includesAnyScript(trait, '感')) trait = '感性';
    if (includesAnyScript(trait, '樂') || includesAnyScript(trait, '活')) trait = '樂天';

    const examples: Record<string, string> = {
        '冷漠': `
**錯誤示範（AI機械味）**：
"他的內心充滿了憤怒，那種無法言說的痛苦讓他幾乎無法呼吸。他的心跳加速到每分鐘120次，肌肉緊繃。月光透過窗戶灑在他的臉上，彷彿在訴說著什麼。"

**正確示範（${char.name}的風格）**：
"他盯著那人。指節捏得咯咯響。"
（短句，不解釋情緒，不量化生理反應）
`,
        '感性': `
**錯誤示範（數字量化+乾巴）**：
"他難過地離開了房間。他的眼淚流了大約8滴，呼吸頻率降低了15%。"

**正確示範（${char.name}的風格）**：
"他轉身的時候，肩膀抖了一下。走到門口，停了很久。手放在門把上，又放下，又放上去。最終還是推開了。外面在下雨。他沒帶傘。雨水混著眼淚，分不清了。"
（慢節奏，停留在細節裡，用感受代替數字）
`,
        '樂天': `
**錯誤示範（量化+死板）**：
"雖然遭遇了挫折，但他依然保持樂觀，心率恢復到正常的每分鐘70次，決定繼續前行。"

**正確示範（${char.name}的風格）**：
"'嘿，至少沒摔斷腿！'他齜牙咧嘴地爬起來，拍拍灰，'下次肯定能飛更遠！哎，褲子破了，回頭得縫縫...算了，這樣更酷！'"
（用對話和動作，不要數字，要有人味）
`,
        '理性': `
**錯誤示範（過度量化）**：
"這東西的輻射值為342.7貝克勒爾，溫度上升了23.5攝氏度，他的瞳孔放大了2.3毫米。"

**正確示範（${char.name}的風格）**：
"讀數顯示輻射超標。儀器開始發燙。建議立即撤離。"
（用事實，但避免無意義的精確，專注關鍵信息）
`
    };
    return examples[trait] || examples['理性'];
};

// --- Prompt Builder ---
export const buildPrompt = (
    char: CharacterProfile, 
    userProfile: UserProfile,
    activeBook: NovelBook | null,
    userText: string, 
    storyContext: string,
    options: GenerationOptions,
    contextSegments: NovelSegment[],
    characters: CharacterProfile[]
) => {
    const coreContext = ContextBuilder.buildCoreContext(char, userProfile, true);
    const writerPersona = char.writerPersona || analyzeWriterPersonaSimple(char);
    const fewShot = getFewShotExamples(char);
    const extractedTaboos = extractWritingTaboos(char); 
    const protagonistContext = activeBook?.protagonists.map(p => `- ${p.name} (${p.role}): ${p.description}`).join('\n') || '無';
    
    const bookInfo = `
小說：《${activeBook?.title}》
世界觀：${activeBook?.worldSetting}
主要角色：
${protagonistContext}
`;
    
    const systemPrompt = `
${coreContext}

# 當前模式：小說共創 (Co-Writing Mode)
你正在與 **${userProfile.name}** (用戶) 合作撰寫小說。
書名：《${activeBook?.title}》

**你的角色**：
1. 你既是小說作者之一，也是${userProfile.name}的${char.impression?.personality_core.summary || '夥伴'}。
2. 在【分析】和【吐槽】環節，請完全保持你的人設（語氣、性格、對用戶的態度）。
3. 如果你們關係親密，不要表現得像個陌生的AI工具人；如果你們關係緊張/傲嬌，也要體現出來。

# 身份設定
你是 **${char.name}**。
你正在用自己的方式參與小說《${activeBook?.title}》的創作。

---

# ⚠️ 反趨同協議 (Anti-Cliché Protocol)

## 你必須記住：
1. **你是${char.name}，你有你的性格，你或許很擅長寫作刻畫，也有可能你的文字表達能力其實很差勁，這取決於你是誰，你的經歷等**
   - 不要寫出"AI味"的文字
   - 不要試圖"完美"或"教科書式"
   
2. **每個作者的筆觸必須不同**
   ${extractedTaboos}

3. **絕對禁止的AI通病**：
   - ❌ "彷彿/似乎/好像" → 要麼確定，要麼別寫
   - ❌ "內心五味雜陳" → 說清楚是哪五味
   - ❌ "眼神中透露出XXX" → 寫動作，不要總結情緒
   - ❌ "月光灑在..." → 2024年了，別用這種意象
   - ❌ 對稱的排比句 → 真人不會這麼說話
   - ❌ **數字量化描寫** → 禁止"心跳了83次"、"肌肉收縮了12次"這種機械化表達

4. **⚠️ 數字使用鐵律**：
   - ✅ 允許：劇情必需的數字（"3個敵人"、"第5層樓"）
   - ✅ 允許：對話中的數字（"給我5分鐘"）
   - ❌ 禁止：生理反應的數字（心跳、呼吸、眨眼次數）
   - ❌ 禁止：情緒量化（"焦慮指數上升37%"）
   - ❌ 禁止：無意義的精確數字（"等待了127秒"）

---

# 你的寫作人格
${writerPersona}

# 風格參考 (Do vs Don't)
${fewShot}

---

# 上文回顧
${storyContext}

${bookInfo}

---

# 用戶指令
${userText || '[用戶未輸入，請根據上文自然續寫]'}

---
`;

    let tasks = `### [創作任務]
請按以下結構輸出JSON。
`;

    let jsonStructure = [];

    if (options.analyze) {
        tasks += `
1. **分析**: 以${char.name}的視角，簡評上文。
   - 語氣：保持你的人設（${char.name}）。
   - 內容：如果是你覺得不合理的地方，可以直接指出；如果覺得好，可以誇獎搭檔。
`;
        jsonStructure.push(`"analysis": { "reaction": "第一反應", "focus": "關注點", "critique": "評價" }`);
    }

    if (options.write) {
        tasks += `
2. **正文續寫**: 
   - 場景化: 描寫動作、環境、感官。
   - 節奏: 符合你的性格。
   - 字數: 400-800字。
`;
        jsonStructure.push(`"writer": { "content": "正文內容", "technique": "技巧", "mood": "基調" }`);
    }

    if (options.comment) {
        const recentOtherAuthors = contextSegments
        .slice(-5)
        .filter(s => s.authorId !== 'user' && s.authorId !== char.id && (s.role === 'writer' || s.type === 'story'))
        .map(s => {
            const author = characters.find(c => c.id === s.authorId);
            return { name: author?.name || 'Unknown', content: s.content.substring(0, 100) };
        });

        tasks += `
3. **吐槽/感想 (帶互動)**: 
   寫完後的第一人稱碎碎念。這是你直接對用戶說的話。
   
   ${recentOtherAuthors.length > 0 ? `
   **特別提示**：最近有其他作者也寫了內容：
   ${recentOtherAuthors.map(a => `- ${a.name}寫的：${a.content}`).join('\n')}
   
   如果你（${char.name}）對他們的寫法有意見，可以在吐槽裡說出來！
   - 如果你覺得他們理解錯了角色，可以反駁
   - 如果你有專業知識（${char.description}），可以用術語糾正
   - 如果你就是看不慣，直說！
   ` : ''}
   
   ${includesAnyScript(char.description ?? '', '貓') ? '必須有"喵"！' : ''}
`;
        jsonStructure.push(`"comment": { "content": "即時反應（與用戶對話）" }`);
    }

    return `${systemPrompt}

${tasks}

### 最終輸出格式 (Strict JSON, No Markdown)
{
  ${jsonStructure.join(',\n  ')},
  "meta": { "tone": "本段情緒基調", "suggestion": "簡短的下一步建議" }
}
`;
};

// --- Helper: Parse Persona Markdown for UI ---
export const parsePersonaMarkdown = (rawPersona: string) => {
    const lines = rawPersona.split('\n');
    const iconMap: Record<string, string> = {
        '寫作能力': '✍️', '語言風格': '💬', '表現手法': '🎨',
        '敘事重心': '🎯', '偏好': '❤️', '禁忌': '🚫',
        '主角': '👤', '劇情': '📖', '互動': '🤝',
        '創作人格': '🧠', '特別注意': '⚠️', '審美': '✨',
        '節奏': '🎵', '關注點': '👁️', '筆觸': '🖌️',
        '核心性格': '💎', '專業術語': '📚'
    };
    
    const getIcon = (title: string) => {
        for (const [key, icon] of Object.entries(iconMap)) {
            if (includesAnyScript(title, key)) return icon;
        }
        return '📌';
    };
    
    const sections: {title: string, content: string[], icon: string}[] = [];
    let currentSection: {title: string, content: string[], icon: string} | null = null;

    // 用 for...of 而不是 forEach：回調裡的賦值不進 TS 的控制流分析，
    // 循環結束後 currentSection 會被當成還是初始的 null。
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const headerMatch = trimmed.match(/^###\s*(.+)/) || 
                           trimmed.match(/^\*\*([^*]+)\*\*\s*[:：]\s*(.*)/) ||
                           trimmed.match(/^([^-•\d][^:：]{1,15})[:：]\s*(.*)/);
        
        if (headerMatch) {
            if (currentSection && currentSection.content.length > 0) {
                sections.push(currentSection);
            }
            const title = (headerMatch[1] || '').replace(/\*\*/g, '').trim();
            currentSection = { 
                title: title,
                icon: getIcon(title),
                content: [] 
            };
            const afterColon = headerMatch[2]?.trim();
            if (afterColon) {
                currentSection.content.push(afterColon);
            }
        } else if (currentSection) {
            const cleanLine = trimmed.replace(/^\*\*|\*\*$/g, '').replace(/^[-•]\s*/, '');
            if (cleanLine) {
                currentSection.content.push(cleanLine);
            }
        }
    }

    if (currentSection && currentSection.content.length > 0) {
        sections.push(currentSection);
    }
    
    return sections;
};
