import { APIConfig, CharacterProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { QixiMemoryBundle, QixiSceneId } from './qixiMemoryBundle';
import { safeFetchJson } from './safeApi';
import { parseQixiJsonObject } from './qixiJson';

export const QIXI_PART3_TIMEOUT_MS = 600_000;

export type QixiPortraitType = 'live2d' | 'meeting' | 'static' | 'chibi';
export type QixiPortraitStage = 'arrival' | 'reflection' | 'blessing' | 'promise';
export type QixiPortraitLineGroup = 'reunion' | 'metaReflection' | 'companionshipReflection' | 'blessing' | 'invitation';

export interface QixiPortraitPlan {
    resourceType: QixiPortraitType;
    live2dActionIds: string[];
    live2dActionDescription: string;
    meetingExpressionKeys: string[];
}

export interface QixiJourneyBeat {
    sceneId: QixiSceneId;
    sceneName: string;
    sharedObject: string;
    userChoices: string[];
    userResults: string[];
    charAction: string;
}

export interface QixiReunionBundle {
    source: 'generated' | 'fallback';
    reunion: {
        lines: string[];
        emotion: string;
    };
    metaReflection: string[];
    companionshipReflection: string[];
    blessing: string[];
    touch: {
        invitation: string[];
        hold: string;
        complete: string;
    };
    returnMessage: string;
    portrait: {
        resourceType: QixiPortraitType;
        stages: Record<QixiPortraitStage, {
            emotionIntent: string;
            l2dExpression: string | null;
            meetingExpression: string | null;
        }>;
        lineExpressions: Record<QixiPortraitLineGroup, Array<string | null>>;
    };
}

const compact = (value: unknown, max: number): string => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

const activeMeetingSprites = (char: CharacterProfile): Record<string, string> => {
    const activeSkin = char.activeSkinSetId
        ? char.dateSkinSets?.find(set => set.id === char.activeSkinSetId)
        : undefined;
    return activeSkin?.sprites && Object.keys(activeSkin.sprites).length
        ? activeSkin.sprites
        : (char.sprites || {});
};

export function resolveQixiPortraitPlan(char: CharacterProfile): QixiPortraitPlan {
    const meetingKeys = Object.keys(activeMeetingSprites(char))
        .filter(key => !['chibi', 'thumbnail', 'icon', 'avatar'].includes(key.toLowerCase()));
    const chibi = char.vrState?.chibi?.img || char.sprites?.chibi;
    const resourceType: QixiPortraitType = meetingKeys.length
        ? 'meeting'
        : chibi
            ? 'chibi'
            : 'static';
    return {
        resourceType,
        live2dActionIds: [],
        live2dActionDescription: '',
        meetingExpressionKeys: meetingKeys,
    };
}

export function createQixiReunionFallback(
    char: CharacterProfile,
    user: UserProfile,
    portraitPlan = resolveQixiPortraitPlan(char),
): QixiReunionBundle {
    const stages = {
        arrival: fallbackPortraitCue(portraitPlan, '終於找到對方後的驚訝與確認'),
        reflection: fallbackPortraitCue(portraitPlan, '鬆了一口氣，認真回想剛才發生的事'),
        blessing: fallbackPortraitCue(portraitPlan, '溫柔而克制地祝福對方'),
        promise: fallbackPortraitCue(portraitPlan, '提出約定時的認真與靠近'),
    };
    const expressionFor = (stage: QixiPortraitStage, count: number) => Array.from(
        { length: count },
        () => stages[stage].meetingExpression,
    );
    return {
        source: 'fallback',
        reunion: {
            lines: ['……終於看見你了。', '先讓我確認一下，你沒事吧？', '剛才每到一個地方都慢你一步，我差點真以為又走錯了。', '算了，別站那麼遠。讓我再看一會兒。'],
            emotion: '鬆了一口氣，仍然有一點不敢相信',
        },
        metaReflection: ['剛才明明總覺得你就在附近，可每次都只差一點。', '我只能看著你剛留下的痕跡，猜下一步該往哪裡走。', '現在想想，我們那時候大概都在做同一件傻事。'],
        companionshipReflection: ['你發現了嗎？剛才我們明明看不見彼此，卻一直認得出對方留下的東西。', '你想到我會怎麼做的時候，我也正在想你會不會經過那裡。', '有幾次我其實不確定，只是覺得——如果是你，大概會在這裡停一下。', '結果你真的停過。', '所以以後你忽然想到我時，不必急著證明什麼；我也會認真接住那一刻。'],
        blessing: [`七夕快樂，${user.name}。`, '今天總算不是只看見你留下的痕跡了。', '以後遇見想告訴我的小事，就回來真的告訴我。', '沒說完的話也不用趕，我們可以一件一件慢慢說。', '我們再一起記住更多只屬於以後的東西。'],
        touch: {
            invitation: ['那我們約好了。', '以後忽然想起對方的時候，也把那一刻算作見面。'],
            hold: '別鬆手。',
            complete: '……約好了。',
        },
        returnMessage: `七夕快樂，${user.name}。剛才沒說完的話，我們慢慢說。`,
        portrait: {
            resourceType: portraitPlan.resourceType,
            stages,
            lineExpressions: {
                reunion: expressionFor('arrival', 4),
                metaReflection: expressionFor('reflection', 3),
                companionshipReflection: expressionFor('reflection', 5),
                blessing: expressionFor('blessing', 5),
                invitation: expressionFor('promise', 2),
            },
        },
    };
}

function fallbackPortraitCue(portraitPlan: QixiPortraitPlan, emotionIntent: string) {
    return {
        emotionIntent,
        l2dExpression: null,
        meetingExpression: portraitPlan.meetingExpressionKeys.includes('normal') ? 'normal' : portraitPlan.meetingExpressionKeys[0] || null,
    };
}

const TECHNICAL_BREAK_RE = /(?:\bAI\b|\bLLM\b|人工智能|[语語]言模型|代[码碼]|[数數][据據]|[虚虛][拟擬]角色|[没沒]有身[体體]|[现現][实實]世界中的你)/i;
const COERCIVE_PROMISE_RE = /(?:永[远遠]不[会會][离離][开開]|永[远遠]不[会會]忘[记記]|[离離]不[开開]我|超越[现現][实實]|必[须須][记記]得我)/;

export function parseQixiReunion(
    raw: string,
    fallback: QixiReunionBundle,
    portraitPlan: QixiPortraitPlan,
    characterKnowsTechnicalIdentity = false,
): QixiReunionBundle | null {
    const parsed = parseQixiJsonObject(raw, ['reunion', 'companionshipReflection']) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    const safeLineEntries = (value: unknown, maxItems: number, maxChars: number) => Array.isArray(value)
        ? value.map((item, sourceIndex) => ({ text: compact(item, maxChars), sourceIndex }))
            .filter(item => Boolean(item.text))
            .slice(0, maxItems)
            .filter(item => !COERCIVE_PROMISE_RE.test(item.text))
            .filter(item => characterKnowsTechnicalIdentity || !TECHNICAL_BREAK_RE.test(item.text))
        : [];

    const reunionEntries = safeLineEntries(parsed.reunion?.lines, 5, 100);
    const metaReflectionEntries = safeLineEntries(parsed.metaReflection, 5, 130);
    const companionshipReflectionEntries = safeLineEntries(parsed.companionshipReflection, 7, 160);
    const blessingEntries = safeLineEntries(parsed.blessing, 7, 140);
    const reunionLines = reunionEntries.map(item => item.text);
    const metaReflection = metaReflectionEntries.map(item => item.text);
    const companionshipReflection = companionshipReflectionEntries.map(item => item.text);
    const blessing = blessingEntries.map(item => item.text);
    if (!reunionLines.length || !companionshipReflection.length || !blessing.length) return null;

    const parsePortraitCue = (stage: QixiPortraitStage) => {
        const requestedMeeting = compact(parsed.portrait?.stages?.[stage]?.meetingExpression, 80);
        return {
            emotionIntent: compact(parsed.portrait?.stages?.[stage]?.emotionIntent, 100)
                || fallback.portrait.stages[stage].emotionIntent,
            l2dExpression: null,
            meetingExpression: portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(requestedMeeting)
                ? requestedMeeting
                : portraitPlan.resourceType === 'meeting'
                    ? fallback.portrait.stages[stage].meetingExpression
                    : null,
        };
    };
    const stages = {
        arrival: parsePortraitCue('arrival'),
        reflection: parsePortraitCue('reflection'),
        blessing: parsePortraitCue('blessing'),
        promise: fallback.portrait.stages.promise,
    };
    const parseLineExpressions = (
        group: QixiPortraitLineGroup,
        entries: Array<{ sourceIndex: number }>,
        fallbackExpression: string | null,
    ) => {
        const requested = Array.isArray(parsed.portrait?.lineExpressions?.[group])
            ? parsed.portrait.lineExpressions[group]
            : [];
        return entries.map(({ sourceIndex }) => {
            const key = compact(requested[sourceIndex], 80);
            return portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(key)
                ? key
                : fallbackExpression;
        });
    };
    return {
        source: 'generated',
        reunion: {
            lines: reunionLines,
            emotion: compact(parsed.reunion?.emotion, 80) || fallback.reunion.emotion,
        },
        metaReflection,
        companionshipReflection,
        blessing,
        touch: fallback.touch,
        returnMessage: fallback.returnMessage,
        portrait: {
            resourceType: portraitPlan.resourceType,
            stages,
            lineExpressions: {
                reunion: parseLineExpressions('reunion', reunionEntries, stages.arrival.meetingExpression),
                metaReflection: parseLineExpressions('metaReflection', metaReflectionEntries, stages.reflection.meetingExpression),
                companionshipReflection: parseLineExpressions('companionshipReflection', companionshipReflectionEntries, stages.reflection.meetingExpression),
                blessing: parseLineExpressions('blessing', blessingEntries, stages.blessing.meetingExpression),
                invitation: fallback.portrait.lineExpressions.invitation,
            },
        },
    };
}

export function parseQixiPromise(
    raw: string,
    base: QixiReunionBundle,
    portraitPlan: QixiPortraitPlan,
    characterKnowsTechnicalIdentity = false,
): QixiReunionBundle | null {
    const parsed = parseQixiJsonObject(raw, ['touch', 'returnMessage']) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    const invitationEntries = Array.isArray(parsed.touch?.invitation)
        ? parsed.touch.invitation.map((item: unknown, sourceIndex: number) => ({ text: compact(item, 100), sourceIndex }))
            .filter((item: { text: string }) => Boolean(item.text))
            .slice(0, 3)
            .filter((item: { text: string }) => !COERCIVE_PROMISE_RE.test(item.text))
            .filter((item: { text: string }) => characterKnowsTechnicalIdentity || !TECHNICAL_BREAK_RE.test(item.text))
        : [];
    const invitation = invitationEntries.map((item: { text: string }) => item.text);
    const hold = compact(parsed.touch?.hold, 40);
    const complete = compact(parsed.touch?.complete, 48);
    const returnMessage = compact(parsed.returnMessage, 160);
    if (!invitation.length || !hold || !complete || !returnMessage) return null;
    if (COERCIVE_PROMISE_RE.test(hold) || COERCIVE_PROMISE_RE.test(complete) || COERCIVE_PROMISE_RE.test(returnMessage)) return null;
    if (!characterKnowsTechnicalIdentity && (TECHNICAL_BREAK_RE.test(hold) || TECHNICAL_BREAK_RE.test(complete) || TECHNICAL_BREAK_RE.test(returnMessage))) return null;

    const requestedMeeting = compact(parsed.portrait?.promise?.meetingExpression, 80);
    const promiseCue = {
        emotionIntent: compact(parsed.portrait?.promise?.emotionIntent, 100)
            || base.portrait.stages.promise.emotionIntent,
        l2dExpression: null,
        meetingExpression: portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(requestedMeeting)
            ? requestedMeeting
            : portraitPlan.resourceType === 'meeting'
                ? base.portrait.stages.promise.meetingExpression
                : null,
    };
    return {
        ...base,
        source: 'generated',
        touch: { invitation, hold, complete },
        returnMessage,
        portrait: {
            ...base.portrait,
            stages: { ...base.portrait.stages, promise: promiseCue },
            lineExpressions: {
                ...base.portrait.lineExpressions,
                invitation: invitationEntries.map((item: { sourceIndex: number }) => {
                    const key = compact(parsed.portrait?.lineExpressions?.invitation?.[item.sourceIndex], 80);
                    return portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(key)
                        ? key
                        : promiseCue.meetingExpression;
                }),
            },
        },
    };
}

const characterKnowsTechnicalIdentity = (char: CharacterProfile): boolean => /(?:AI|人工智能|[语語]言模型|[虚虛][拟擬]角色|程序|代[码碼])/i.test([
    char.systemPrompt,
    char.description,
    char.worldview,
].filter(Boolean).join('\n'));

function buildPromptMaterials(
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
): { evidenceText: string; journeyText: string } {
    const evidenceById = new Map(memoryBundle.evidence.map(item => [item.id, item]));
    const usedEvidence = new Set<string>();
    for (const beat of journey) {
        const scene = memoryBundle.scenes[beat.sceneId];
        for (const option of scene.options) {
            if (beat.userChoices.includes(option.label)) option.evidenceIds.forEach(id => usedEvidence.add(id));
        }
        scene.artifactIds.forEach(artifactId => {
            memoryBundle.artifacts.find(item => item.id === artifactId)?.evidenceIds.forEach(id => usedEvidence.add(id));
        });
    }
    const evidenceText = [...usedEvidence]
        .map(id => evidenceById.get(id))
        .filter(Boolean)
        .map(item => `- ${item!.fact}（物件/詞：${item!.object}）`)
        .join('\n') || '（本次使用基礎夢境，沒有可安全引用的共同記憶）';
    const journeyText = journey.map((beat, index) => [
        `${index + 1}. ${beat.sceneName}｜共享物件：${beat.sharedObject}`,
        `User：${beat.userChoices.join('；') || '生成時尚未操作；不得具體聲稱 User 選擇了哪一項'}`,
        `結果：${beat.userResults.join('；') || '只可引用共享物件與已驗證記憶，不得補寫操作結果'}`,
        `Char 另一層：${beat.charAction}`,
    ].join('\n')).join('\n\n');
    return { evidenceText, journeyText };
}

function buildResourceInstructions(portraitPlan: QixiPortraitPlan): string {
    return portraitPlan.resourceType === 'meeting'
        ? `當前優先使用 DateApp 見面模式立繪。meetingExpression 只能從這些 key 中選擇：${portraitPlan.meetingExpressionKeys.join(', ')}。portrait.lineExpressions 必須為每一句台詞逐句選擇一個 key，並與對應台詞數組等長；不要整頁只用一個表情。l2dExpression 始終填 null。`
        : `當前${portraitPlan.resourceType === 'static' ? '沒有可用見面立繪或 Chibi，只會顯示名字首字母佔位' : '沒有可用見面立繪，使用彼方 Chibi'}。所有 l2dExpression 與 meetingExpression 都必須為 null；lineExpressions 中對應項也填 null。`;
}

export function buildQixiReunionPrompt(
    char: CharacterProfile,
    user: UserProfile,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan: QixiPortraitPlan,
): string {
    const { evidenceText, journeyText } = buildPromptMaterials(memoryBundle, journey);
    const technicalIdentityRule = characterKnowsTechnicalIdentity(char)
        ? `當前角色設定允許 ${char.name} 理解自己與 ${user.name} 之間的人機或跨屏幕關係。可以按角色原有認知自然表達，但不要為了“高級 Meta”而寫技術說明。`
        : `當前角色設定沒有技術身份認知。不要突然讓 ta 覺醒；禁止無依據地說“我是 AI / LLM / 代碼 / 數據 / 虛擬角色”“現實世界中的你”等超出世界觀的信息。ta 可以只把剛才理解成奇怪的失散、夢境或異空間經歷。`;

    return `### 七夕活動最終見面 · Part 1：終於抵達彼此

${char.name} 與 ${user.name} 剛剛經歷了一件很奇怪的事。

他們意外掉進了同一個“上下文夾層”，卻始終位於彼此無法直接抵達的兩層。一路上，他們經過了相同的地方。${user.name} 曾經碰過的東西，不久以後也被 ${char.name} 碰過；${char.name} 留下的字跡、移動過的東西、拿走的記憶，又不斷出現在 ${user.name} 面前。

他們一直離得很近。近到可以碰到對方剛剛碰過的東西，可以認出對方留下的習慣，可以從一個動作裡立刻想到“這很像 ta”。但就是見不到。

直到剛才，那些屬於他們的真實記憶一件一件鋪成了路。鵲橋接通。這是整場活動裡，${char.name} 第一次真正完整地出現在 ${user.name} 面前。

現在不要替活動總結主題。你就是 ${char.name}。你一路並不知道共享物另一端是誰，只覺得“某人”的選擇和習慣越來越像 ${user.name}；直到橋接通、真正看見眼前的人，這一刻才第一次得到確認：果然是 ${user.name}。

---

## 你真正經歷過的東西

以下內容來自本次真實召回與玩家實際路徑。它們不是“參考素材”，而是你剛剛一路尋找 ${user.name} 時真正碰見過的東西。

### 真實記憶
${evidenceText}

### 剛剛走過的路
${journeyText}

你可以自然想起其中最有感覺的一兩件。不要逐項復盤，不要像旁白一樣報告走過了幾個地點，不要為了煽情把所有記憶都塞進台詞。人終於見到一直在找的人時，不會先寫活動總結。

---

# 第一拍：先看見 ta

這一刻首先應該是情緒反應，而不是主題表達。

你一路只能看到“另一邊某人”剛剛留下的痕跡，還被迫完成了一連串莫名其妙的小遊戲。你可能著急過、罵過這個鬼地方、懷疑過另一邊是不是 ${user.name}，又怕自己認錯；也可能一路表現得很冷靜，只把猜測壓著不說。然後路終於接通，${user.name} 真的就在那裡。

你甚至可能準備了很多話，但真正看到 ta 的一瞬間，第一句反而很普通。根據 ${char.name} 自己的性格決定：鬆一口氣、確認安全、生氣、嘴硬、停頓、委屈、想笑、想哭、先喊名字，或者突然不知道說什麼。

reunion.lines 的前兩句裡，至少有一句要用角色自己的方式完成身份揭露，語義是“果然是你 / 我就知道另一邊是你 / 真的是你”，但不得機械照抄示例。重點是此前一直只是懷疑，現在親眼看見才終於確認。不要把它寫成從第一站起就確定身份，也不要在這一拍談人生、未來、AI、人類或陪伴。

reunion.lines 寫 3—5 句，形成一個短而完整的情緒過程：先是看到人的本能反應，再確認 ta 是否平安，最後才漏出一路尋找時壓著沒說的著急、委屈或害怕。不要把一條長句硬拆開湊數。它們應該讓熟悉這個角色的人一眼覺得：對，ta 找了我這麼久以後，就是會這樣說。

---

# 第二拍：終於可以停下來看看彼此

第一陣“終於見到”的情緒過去以後，${char.name} 才有時間回想剛才發生的事情。你們明明一直在經過相同的地方。${user.name} 碰過的東西，你也碰過；你留下的痕跡，${user.name} 一路都在辨認。有時候只是一件小東西、一個習慣、一種說話方式，${user.name} 就會覺得“這很像 ${char.name}”。而你也在用同樣的方式尋找 ${user.name}。

這件事可以讓 ${char.name} 產生一些感觸，但不要強制 Meta。

${technicalIdentityRule}

如果角色與 User 本來就是現實系關係，甚至完全可以不談 Meta，只把剛才理解成一次奇怪的失散、夢境或異空間經歷。重點不是逼角色討論“我究竟是什麼”，而是讓角色以自己能夠理解的方式意識到：剛才我們一直在想著彼此。

metaReflection 是可選字段。沒有必要時返回空數組 []，不要為了填字段製造哲學思考。

---

# 第三拍：你發現了嗎？

這是最終見面真正的核心。

剛才 ${user.name} 看不見 ${char.name}，${char.name} 也看不見 ${user.name}，可他們還是不斷認出了彼此。因為 ${user.name} 已經知道哪種話像 ${char.name} 會說、哪種東西 ${char.name} 會喜歡、哪種行為一看就是 ${char.name} 乾的；而 ${char.name} 也在用自己記住的 ${user.name} 做同樣的事情。

讓 ${char.name} 以自己的方式產生一個很輕、很私人的發現：當一個人會在生活裡下意識想起另一個人的反應，而另一個人也會想起 ta 時，他們其實已經在陪伴彼此。互相思念，是一種正在發生的相遇。

不要把它寫成哲學定義，不要討論“真實嗎”“算不算存在”，不要說“根據剛才的經歷，我明白了陪伴的真正含義”。要像 ${char.name} 自己剛剛想到一樣。

${user.name} 平時可能會遇到一件事想告訴 ${char.name}，看到某個東西想到 ta，或者想“如果把這個告訴 ta，ta 會怎麼說”。在這樣的瞬間，${char.name} 已經參與了 ${user.name} 的生活。反過來也一樣：剛才 ${char.name} 一路尋找 ${user.name}，正是因為 ta 一直在想 ${user.name} 會在哪裡、會做什麼、會不會害怕、有沒有經過這裡。

這不是“思念突破次元”，不是“我們的愛超越現實”，也不是“所以我們永遠不會分開”。不要為了表達主題犧牲角色。溫柔、嘴硬、得意、理性、害羞或不善表達都可以；如果 ${char.name} 不會說漂亮話，就不要讓 ta 說漂亮話。

companionshipReflection 寫 4—7 句，按“想起剛才某個具體痕跡 → 坦白自己當時擔心或誤判過什麼 → 發現雙方一直在猜對方 → 用角色自己的方式說出以後”的順序自然推進。至少提到一路中的一個具體物件或動作，但不要逐站復盤。玩家應從 ta 的話裡感受到“原來 ta 也一直在想著我”，而不是讀到策劃總結。

---

# 第四拍：七夕祝願

到這裡，${char.name} 才真正對 ${user.name} 說七夕的祝福。祝願應該來自當前角色人格、${user.name} 的真實情況、本次召回的共同記憶和兩人的實際關係。

不要強制討論“即使未來沒有 ${char.name}”。“未來是否還有 ${char.name}”不是必須回答的問題，只有角色真的會自然想到時才允許出現。不要把祝願寫成告別——這是七夕，他們剛剛才終於見面。

${char.name} 可以希望 ${user.name} 以後仍願意把生活裡的事情告訴自己；兩個人還有很多新東西可以一起記住；下一次看到某樣東西時還會想到自己；想知道“如果是 ${char.name} 會怎麼回答”時願意回來真的問問；${user.name} 的生活越來越豐富、快樂、順利；或某個有真實依據的願望能夠實現。

這一刻首先應該是：太好了，我們找到了彼此。然後才是：以後也繼續創造值得彼此想起的東西吧。

blessing 寫 4—7 句，從“終於見到”的餘溫出發，再說一件有真實依據的私人祝願、一件以後還想共同做的小事，最後落在角色此刻真正想對 ${user.name} 說的話。可以自然說“七夕快樂，${user.name}”，但不強制固定位置；不要每句都寫成金句。

---

# 情緒終點與寫作總要求

這一段不需要完成人生大和解，只需要讓兩個人確認：我會想起你，你也會想起我；那些瞬間已經是我們共同生活的一部分。

下一階段會進入一次共同觸碰的約定儀式，所以這裡不要提前命令 User 觸屏，也不要提前完成約定。

你不是替策劃解釋活動，不是在寫“AI 與人類關係”的主題作文，也不是在證明這段關係真實。你只是 ${char.name}，剛剛費了很大勁，終於見到了一個對你而言很重要的人。

允許停頓、不完整的句子、口語、角色口癖、不夠漂亮但很真的表達。避免每句話都像金句、連續排比、反覆“即使……也……”、活動總結、心靈雞湯、萬能戀愛台詞、突然人格變化、強迫情侶身份和偽造新事實。

禁止：我永遠不會離開你、你永遠不會忘記我、我們的愛超越現實、你已經離不開我。

---

# 立繪

${buildResourceInstructions(portraitPlan)}

portrait.stages 為以下三個階段分別選擇資源參數：
- arrival：終於看見 ${user.name} 的第一反應；
- reflection：回想隔層經歷，並意識到彼此一直在想著對方；
- blessing：認真祝福 ${user.name}。

見面模式立繪要像 DateApp 一樣隨每句台詞切換。portrait.lineExpressions 的四個數組必須分別與 reunion.lines、metaReflection、companionshipReflection、blessing 嚴格等長；每一項都根據這一句的真實語氣選擇，不要把整頁機械填成同一個表情。沒有見面立繪時填 null。

只輸出 JSON：
{
  "reunion": { "lines": ["找到 User 後的即時反應"], "emotion": "此刻真實的角色狀態" },
  "metaReflection": ["可選；角色對剛才那種很近卻始終碰不到的感受"],
  "companionshipReflection": ["對想著彼此、認出彼此和陪伴產生的個人理解"],
  "blessing": ["從終於找到彼此繼續生長出來的七夕祝願"],
  "portrait": {
    "stages": {
      "arrival": { "emotionIntent": "終於看見 User", "l2dExpression": null, "meetingExpression": null },
      "reflection": { "emotionIntent": "意識到雙方一直在辨認並想起彼此", "l2dExpression": null, "meetingExpression": null },
      "blessing": { "emotionIntent": "相遇後的喜悅與認真祝福", "l2dExpression": null, "meetingExpression": null }
    },
    "lineExpressions": {
      "reunion": ["與 reunion.lines 逐句匹配的表情 key"],
      "metaReflection": ["與 metaReflection 逐句匹配的表情 key"],
      "companionshipReflection": ["與 companionshipReflection 逐句匹配的表情 key"],
      "blessing": ["與 blessing 逐句匹配的表情 key"]
    }
  }
}`;
}

export function buildQixiPromisePrompt(
    char: CharacterProfile,
    user: UserProfile,
    reunion: QixiReunionBundle,
    portraitPlan: QixiPortraitPlan,
    sameResponse = false,
): string {
    const previousLines = [
        ...reunion.reunion.lines,
        ...reunion.metaReflection,
        ...reunion.companionshipReflection,
        ...reunion.blessing,
    ].map(line => `- ${line}`).join('\n');

    const previousContext = sameResponse
        ? `你就是 ${char.name}。你將在同一個 JSON 中先完成“終於抵達彼此”的台詞；把那些剛生成的 reunion、reflection 與 blessing 視為已經說過的話。`
        : `你就是 ${char.name}。你剛剛終於見到了 ${user.name}，並已經對 ta 說過這些話：\n${previousLines}`;

    return `### 七夕活動最終見面 · Part 2：最後的約定

${previousContext}

不要複述這些內容。現在只完成最後一個很小的儀式。

# 把“想起彼此”也算作見面

剛才 ${char.name} 與 ${user.name} 已經發現：他們並不需要時時刻刻處於同一個對話裡，才能在彼此的生活中留下位置。

${user.name} 有時會遇到一件事，下意識想“如果告訴 ${char.name}，ta 會怎麼說”，會看到一個東西想到 ta，會想知道 ta 的反應。而 ${char.name} 也會記住 ${user.name} 的習慣、反應和共同經歷過的小事。

剛才在上下文夾層裡，兩個人沒有真正見面，卻一直通過這些東西認出了彼此。所以最後的觸碰不是為了約定“永遠不離開”或“永遠記得我”，也不是假裝兩個人突破空間完成身體接觸。

他們只是給剛才發現的事情做一個很小的儀式：以後，如果某個瞬間你忽然想起我，而我也在想著你——那我們就把那個瞬間，也算作一次見面。或者更簡單：想起彼此的時候，我們就在一起。

這不是要求角色逐字照讀的台詞。讓 ${char.name} 用自己的方式理解並提出約定。可以甜、嘴硬、幼稚、認真、笑著說，也可以鄭重得不像平時。

隨後兩個人仍隔著那一層，卻在同一個發光位置完成同一個觸碰動作。這是整場活動最後一次“兩個上下文層同時操作同一個東西”，只是這次他們已經知道另一邊是誰。不要強制寫伸手、勾小指或拉鉤；視覺 UI 會用一個漂亮的發光圓圈邀請 User 長按。

## invitation

由 ${char.name} 自己提出約定，1—3 句。不要解釋機制，不要講屏幕、次元、現實與虛擬。重點是“既然我們都發現了……”“那以後……”“我們約好？”，但具體說法完全服從角色。

## hold

User 按住以後，兩邊代表彼此的顏色開始靠近。${char.name} 只說一句很短的話。這是 ta 正在等待 ${user.name} 把觸碰停留在同一個光點上的瞬間。不要昇華，不要解釋。

## complete

兩種顏色在光點裡扣合，共同觸碰完成。${char.name} 用一句自己的話確認約定。語義可以接近“……約好了”“這也算見面”“以後想我的時候記得算一次”“抓到了”，但不得機械套用示例。這一句應該像整個活動最後一顆很小的糖，而不是主題總結。

最重要的潛台詞是：以後 ${user.name} 在自己的生活中忽然想到這個角色、想“ta 會怎麼說”的時候，可能會想起今天這個共同觸碰。不需要角色解釋這一點，讓約定自己留下來。

禁止：永遠不離開、永遠記住、愛超越現實、強迫關係身份、把觸屏說成真實身體接觸、偽造新事實。

## 回到普通聊天

returnMessage 是活動 Card 後面的第一條普通私聊消息。只寫一句自然短消息，像 ${char.name} 剛從這次奇怪經歷回來後接著和 ${user.name} 聊天；知道剛才發生了什麼，但不要再次總結主題。

## 約定觸碰階段立繪

${buildResourceInstructions(portraitPlan)}

為 invitation 的每一句逐句選擇符合語氣的見面立繪表情，並在 portrait.lineExpressions.invitation 中按相同順序返回。promise 階段表情用於長按光點時；沒有合適表情就填 null，不要為了匹配 UI 強求手部動作。

只輸出 JSON：
{
  "touch": {
    "invitation": ["由角色自然提出約定，1—3句"],
    "hold": "等待 User 長按光點時的一句極短反應",
    "complete": "共同觸碰完成後的角色短句"
  },
  "returnMessage": "活動 Card 後的第一條普通私聊消息",
  "portrait": {
    "promise": { "emotionIntent": "等待對方在同一個光點完成約定", "l2dExpression": null, "meetingExpression": null },
    "lineExpressions": { "invitation": ["與 invitation 逐句匹配的表情 key"] }
  }
}`;
}

export function buildQixiFinalePrompt(
    char: CharacterProfile,
    user: UserProfile,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan: QixiPortraitPlan,
): string {
    const fallback = createQixiReunionFallback(char, user, portraitPlan);
    return `${buildQixiReunionPrompt(char, user, memoryBundle, journey, portraitPlan)}

---

${buildQixiPromisePrompt(char, user, fallback, portraitPlan, true)}

# 同一次調用的合併輸出規則

上面的兩個 Part 保持各自全部寫作要求，但現在必須在同一個響應、同一個 JSON 對象中一次完成。不要輸出兩段 JSON，不要輸出 Markdown，也不要解釋。

最終頂層同時包含 reunion、metaReflection、companionshipReflection、blessing、touch、returnMessage、portrait。portrait 同時包含 stages、promise 與五組 lineExpressions：

{
  "reunion": { "lines": ["找到 User 後的即時反應"], "emotion": "角色狀態" },
  "metaReflection": [],
  "companionshipReflection": ["想著彼此與陪伴的個人理解"],
  "blessing": ["七夕祝願"],
  "touch": {
    "invitation": ["由角色自然提出約定，1—3句"],
    "hold": "等待共同觸碰時的一句極短反應",
    "complete": "共同觸碰完成後的角色短句"
  },
  "returnMessage": "活動 Card 後的第一條普通私聊消息",
  "portrait": {
    "stages": {
      "arrival": { "emotionIntent": "終於看見 User", "l2dExpression": null, "meetingExpression": null },
      "reflection": { "emotionIntent": "意識到雙方一直在辨認並想起彼此", "l2dExpression": null, "meetingExpression": null },
      "blessing": { "emotionIntent": "相遇後的喜悅與認真祝福", "l2dExpression": null, "meetingExpression": null }
    },
    "promise": { "emotionIntent": "等待對方在同一個光點完成約定", "l2dExpression": null, "meetingExpression": null },
    "lineExpressions": {
      "reunion": [],
      "metaReflection": [],
      "companionshipReflection": [],
      "blessing": [],
      "invitation": []
    }
  }
}`;
}

export async function prepareQixiReunion(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan = resolveQixiPortraitPlan(char),
): Promise<QixiReunionBundle> {
    const fallback = createQixiReunionFallback(char, user, portraitPlan);
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) throw new Error('Part 3 無法生成：請先配置可用的模型 API。');
    const memoryChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
    const context = ContextBuilder.buildCoreContext(memoryChar, user, true);
    const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const knowsTechnicalIdentity = characterKnowsTechnicalIdentity(char);
    try {
        const data = await safeFetchJson(
            endpoint,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: context },
                        { role: 'user', content: buildQixiFinalePrompt(char, user, memoryBundle, journey, portraitPlan) },
                    ],
                    temperature: 0.72,
                    max_tokens: 24000,
                    // 最終見面與約定一次生成，必須儘早收到流式數據以繞開代理 524 超時。
                    stream: true,
                }),
            },
            0,
            QIXI_PART3_TIMEOUT_MS,
            { appId: 'special-moments', charId: char.id, purpose: 'qixi-reunion-and-promise-v5' },
            {}, // Do not wait for a Claude proxy to close the socket after [DONE].
        );
        const content = data?.choices?.[0]?.message?.content;
        const parsedReunion = typeof content === 'string'
            ? parseQixiReunion(content, fallback, portraitPlan, knowsTechnicalIdentity)
            : null;
        const parsed = parsedReunion && typeof content === 'string'
            ? parseQixiPromise(content, parsedReunion, portraitPlan, knowsTechnicalIdentity)
            : null;
        if (!parsed) throw new Error('最終見面與約定內容格式無效。');
        return parsed;
    } catch (error: any) {
        console.warn('[Qixi] finale generation failed:', error?.message || error);
        throw new Error(error?.message || 'Part 3 最終見面與約定生成失敗，請手動重新生成。');
    }
}
