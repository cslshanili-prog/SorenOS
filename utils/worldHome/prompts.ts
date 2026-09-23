/**
 * 「家園」提示詞與輸出解析。
 *
 * 設計原則（與產品訴求一一對應）：
 *   - 一次 LLM 調用只演繹一個角色，prompt 裡只給該角色"外部可觀察"的世界信息，
 *     確保沒人開上帝視角；其他角色的內心活動絕不進入它的上下文。
 *   - NPC 沒有記憶系統，由"世界引擎"一次調用全部演繹，完全服務於世界觀氛圍。
 *   - 三種模式只在"user 的存在感"上做提示詞差異，記憶/人設注入對三種模式一致
 *     （buildChatRequestPayload 那條鏈路不變）。
 */

import type { CharacterProfile, WorldProfile, WorldHouse, WorldCharBeat, WorldHomeMode, WorldNarrativeStyle } from '../../types';
import { dmThreadsOf, groupThreadOf, formatThreadForPrompt } from './threads';
import { nowInTimeZone, tzLabel } from '../timezone';

/** 大段正文的文風預設（世界編輯器裡選）。 */
export const NARRATIVE_STYLES: Record<Exclude<WorldNarrativeStyle, 'custom'>, { name: string; guide: string }> = {
    warm: {
        name: '細膩日常',
        guide: '生活流文筆：氣味、光線、觸感、食物的溫度這類具體細節優先；情緒藏在動作和物件裡，不直說；小事中見人。',
    },
    inner: {
        name: '內心獨白',
        guide: '以心理活動為主體：自我對話、猶疑、回憶閃回交織；外部事件只是引子，重點是想法怎麼一步步變化；可以用意識流的跳躍。',
    },
    drama: {
        name: '戲劇張力',
        guide: '強情節：這半天要有一個小衝突或轉折（誤會、巧合、突發），有懸念有起伏；對白鋒利，節奏快，結尾留鉤子。',
    },
    breezy: {
        name: '輕快幽默',
        guide: '口語化、自嘲、吐槽視角；節奏明快，把倒霉事寫出喜感；像角色本人在跟好朋友講段子，但底色仍要真實。',
    },
    sitcom: {
        name: '日常輕喜劇',
        guide: '情景喜劇的節奏：一樁雞毛蒜皮的小事被一步步放大成鬧劇（誤會、烏龍、一個謊要用十個謊圓），角色之間一來一回的拌嘴和吐槽密集、有梗有節拍；動作和反應略誇張但人物動機合理，收尾常有個溫馨或哭笑不得的反轉。輕鬆好笑為主，別真往沉重裡寫。',
    },
};

/** 大段正文的敘述人稱要求。 */
export function narrationPersonGuide(world: WorldProfile, charName: string): string {
    switch (world.narrationPerson) {
        case 'second':
            return `用**第二人稱**寫這段正文：以「你」稱呼${charName}自己（像有人在旁白注視著 ta），全程「你…」。`;
        case 'third':
            return `用**第三人稱**寫這段正文：以「${charName}」或「ta」來敘述自己，像小說旁白。`;
        case 'first':
        default:
            return `用**第一人稱**寫這段正文：以「我」敘述，是${charName}自己的內心視角。`;
    }
}

export function narrativeStyleGuide(world: WorldProfile): string {
    if (world.narrativeStyle === 'custom' && world.narrativeStyleCustom?.trim()) {
        return world.narrativeStyleCustom.trim();
    }
    const key = (world.narrativeStyle && world.narrativeStyle !== 'custom' ? world.narrativeStyle : 'warm') as Exclude<WorldNarrativeStyle, 'custom'>;
    return NARRATIVE_STYLES[key]?.guide || NARRATIVE_STYLES.warm.guide;
}

/**
 * 一天分四段：早/中/晚/凌晨。一輪推進一段。
 * 凌晨（現實 0~5 點）在敘事上是「晚上之後的下半夜」，排在一個劇情日的末尾（seg=3）——
 * 這樣段序號的大小順序 = 時間先後順序，realObserveTarget 的比較邏輯不用特判。
 * 口語上「第1天晚上」熬過午夜叫「第2天凌晨」，所以凌晨的**標籤**按次日稱呼/顯示次日日期。
 */
export const SEGMENTS_PER_DAY = 4;
const SEGMENT_LABELS = ['早上', '中午', '晚上', '凌晨'];
const LATE_NIGHT_SEG = 3;
/** 該段是否算夜晚（用於晝夜視覺）：晚上、凌晨都算夜。 */
export function isNightClock(storyClock: number): boolean {
    return ((storyClock % SEGMENTS_PER_DAY) + SEGMENTS_PER_DAY) % SEGMENTS_PER_DAY >= 2;
}

/** 劇情時鐘 → 時間標籤。一輪推進一段：0=早上 1=中午 2=晚上 3=凌晨（按次日稱呼）。 */
export function storyTimeLabel(storyClock: number): string {
    const seg = storyClock % SEGMENTS_PER_DAY;
    const day = Math.floor(storyClock / SEGMENTS_PER_DAY) + 1 + (seg === LATE_NIGHT_SEG ? 1 : 0);
    return `第${day}天${SEGMENT_LABELS[seg]}`;
}

/**
 * 舊存檔（一天三段制）的一次性時鐘遷移。
 * sim 模式的 storyClock/simSummarizedClock 是「累計段數」，一天從 3 段變 4 段後
 * 按「保持已過天數與段位不變」換算：新 = 天數×4 + 當天段位。real 模式的段序號
 * 含義沒變（0早/1中/2晚，凌晨是新增的 3），storyClock 只是輪次計數，無需換算。
 * 原地修改，返回是否有改動（調用方據此決定要不要寫回 DB）。
 */
export function migrateWorldDaySegs(world: WorldProfile): boolean {
    if ((world.clockSegs || 3) >= SEGMENTS_PER_DAY) return false;
    if (world.timeMode === 'sim') {
        const to4 = (c: number) => Math.floor(c / 3) * SEGMENTS_PER_DAY + (c % 3);
        world.storyClock = to4(world.storyClock);
        if (world.simSummarizedClock) world.simSummarizedClock = to4(world.simSummarizedClock);
    }
    world.clockSegs = SEGMENTS_PER_DAY;
    return true;
}

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/**
 * 「此刻」按這個世界自己的時鐘讀。world.timezone 不設 = 跟隨本機（舊世界的行為）。
 * 返回的 Date 用本地 getter 讀出來正好是世界當地牆上時間，所以下游 getHours/getDate
 * 這些讀法完全不用改。sim 模式不看真實時鍾，與此無關。
 */
export function worldNow(world: Pick<WorldProfile, 'timezone'>, base?: Date): Date {
    return nowInTimeZone(world.timezone, base ?? new Date());
}

/** 世界時區的友好標籤；跟隨本機時返回空串（不必向模型解釋"本機"）。 */
export function worldTzLabel(world: Pick<WorldProfile, 'timezone'>): string {
    return world.timezone ? tzLabel(world.timezone) : '';
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const dayKeyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/**
 * 真實時鍾 → 現實段：0~5點算「凌晨」（seg=3，歸屬**前一天**的劇情日，保證段序單調），
 * <12 早，<18 中，否則晚。
 */
export function realNowSeg(now: Date = new Date()): { dayKey: string; seg: number } {
    const h = now.getHours();
    const d = new Date(now);
    if (h < 5) {
        d.setDate(d.getDate() - 1);
        return { dayKey: dayKeyOf(d), seg: LATE_NIGHT_SEG };
    }
    return { dayKey: dayKeyOf(d), seg: h < 12 ? 0 : h < 18 ? 1 : 2 };
}
/** {dayKey,seg} → 標籤「YYYY年M月D日 周X 早上/中午/晚上/凌晨」。凌晨實際發生在 dayKey 次日 0~5 點，按口語顯示次日日期。 */
export function formatRealClock(rc: { dayKey: string; seg: number }): string {
    const d = new Date(`${rc.dayKey}T00:00:00`);
    if (isNaN(d.getTime())) return `${rc.dayKey} ${SEGMENT_LABELS[rc.seg] || ''}`;
    if (rc.seg === LATE_NIGHT_SEG) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${SEGMENT_LABELS[rc.seg] || ''}`;
}
/**
 * real 模式下一次「觀測」要演的現實段（早/中/晚/凌晨），跟著真實時鍾走：
 *   - 沒演過 → 演當前這一段；
 *   - 落後於今天 → 補今天還沒補的下一段（不超過現在）；
 *   - 落後於過去某天 → 直接跳到今天最早一段（過去錯過的補不回來）；
 *   - 已追上現實 → null（這一段還沒過去，沒東西可演）。
 * 「現在」按**世界自己的時區**讀（world.timezone；不設=本機）。
 */
export function realObserveTarget(world: WorldProfile, now: Date = worldNow(world)): { dayKey: string; seg: number } | null {
    const cur = world.realClock;
    const nw = realNowSeg(now);
    if (!cur) return nw;
    if (cur.dayKey < nw.dayKey) return { dayKey: nw.dayKey, seg: 0 }; // 過去的天丟掉，跳到今天最早一段
    if (cur.dayKey > nw.dayKey) return null; // 數據異常（時鐘回撥），不補
    return cur.seg < nw.seg ? { dayKey: nw.dayKey, seg: cur.seg + 1 } : null; // 同一天：補下一段，或已追上
}

/**
 * 把 realClock 收回到「不超過世界當下」——換時區時必須調一次。
 * 往西換時區（比如東京 → 洛杉磯）會讓世界的「現在」瞬間倒退，此時舊 realClock 落在
 * 未來，realObserveTarget 會一路返回 null（當成"已追上現實"），用戶會莫名卡住、
 * 觀測按鈕點了沒反應。這裡原地把時鐘壓回當下那一段，返回是否有改動（決定要不要寫回 DB）。
 */
export function clampRealClockToNow(world: WorldProfile, now: Date = worldNow(world)): boolean {
    const cur = world.realClock;
    if (!cur || world.timeMode === 'sim') return false;
    const nw = realNowSeg(now);
    if (cur.dayKey < nw.dayKey || (cur.dayKey === nw.dayKey && cur.seg <= nw.seg)) return false;
    world.realClock = nw;
    return true;
}

/**
 * 時間模式感知的時間標籤：
 *   - real（默認）：沿用「第N天 早上/中午/晚上」。
 *   - sim：從 simStartDate 起按天推進，輸出真實日曆日期「YYYY年M月D日 周X 早上/中午/晚上」。
 */
export function worldTimeLabel(world: WorldProfile, storyClock: number = world.storyClock): string {
    if (world.timeMode === 'sim' && world.simStartDate) {
        const { year, month, day } = world.simStartDate;
        const seg = storyClock % SEGMENTS_PER_DAY;
        const d = new Date(year, month - 1, day);
        // 凌晨發生在該劇情日次日的 0~5 點，按口語顯示次日日期
        d.setDate(d.getDate() + Math.floor(storyClock / SEGMENTS_PER_DAY) + (seg === LATE_NIGHT_SEG ? 1 : 0));
        const wd = WEEKDAYS[d.getDay()];
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd} ${SEGMENT_LABELS[seg]}`;
    }
    // real 模式：跟現實時鍾同步，顯示已演到的那一現實段
    if (world.timeMode !== 'sim' && world.realClock) return formatRealClock(world.realClock);
    return storyTimeLabel(storyClock);
}

/** 該世界「當前那一段」是否算夜晚（real 看 realClock，sim 看 storyClock）：晚上、凌晨都算夜。 */
export function isNightWorld(world: WorldProfile): boolean {
    if (world.timeMode !== 'sim' && world.realClock) return world.realClock.seg >= 2;
    return isNightClock(world.storyClock);
}

/**
 * 演繹某角色前，把 ta 的「自定義時區」對齊到世界時鐘。
 *
 * 家園是大家共同生活的**一個**地方，只有一個鐘：段判定（realNowSeg）按 world.timezone 走，
 * 而 buildChatRequestPayload → buildCoreContext 會按 char.customTimezone 注入「當前時間」。
 * 兩者不一致時，同一個 prompt 裡會出現兩個互相矛盾的時間（角色那邊 00:10，世界這邊"晚上"），
 * 模型只能瞎猜一個。所以 real 模式下一律以世界時區為準覆蓋角色自己的時區——包括「跟隨本機」
 * 時把角色的自定義時區清掉。返回淺拷貝，不動原角色（角色卡里的設置照舊，只在家園語境內覆蓋）。
 * sim 模式不看真實時鍾，原樣返回。
 */
export function alignCharToWorldClock(world: WorldProfile, char: CharacterProfile): CharacterProfile {
    if ((world.timeMode ?? 'real') === 'sim') return char;
    return { ...char, customTimezoneEnabled: !!world.timezone, customTimezone: world.timezone || '' };
}

/** 找出某成員住在哪（不在任何小屋 = 獨居）。 */
export function houseOf(world: WorldProfile, charId: string): WorldHouse | null {
    return world.houses.find(h => h.residentIds.includes(charId)) || null;
}

/** user 存在感的三檔規則文本。 */
export function buildModeRule(mode: WorldHomeMode, userName: string): string {
    const u = userName || '用戶';
    switch (mode) {
        case 'light':
            return `【模式：輕度】這只是觀察你生活的一個切面。在這個世界裡，${u} 依舊是你最重要的人——與你們平時聊天裡的關係完全一致。你的生活裡可以自然地惦記 ta、想給 ta 發消息、期待 ta 的出現；但此刻 ta 不在場，不要憑空讓 ta 登場。`;
        case 'medium':
            return `【模式：中度】${u} 是這個世界裡的普通一員，和其他人沒有什麼不同。可以自然提及 ta，但 ta 不特殊，你的生活不圍著 ta 轉。此刻 ta 不在場，不要替 ta 行動或說話。`;
        case 'heavy':
            return `【模式：重度·重要】在這個世界裡，${u} 不存在（或者說只是一個誰也看不見的幽靈）。演繹中絕對不要提及、暗示、想起或尋找 ta。你的生活完全由這個世界裡的居民和事件構成。即使你的記憶裡有 ta，在這個世界裡那些記憶也如同上輩子的夢，不會浮現。`;
    }
}

/** 注入到角色 systemPrompt 末尾的家園場景框定。 */
export function buildWorldSystemAddendum(world: WorldProfile, char: CharacterProfile, userName: string): string {
    return `

---
[家園 · ${world.name}]
接下來不是和 ${userName || '用戶'} 的聊天，而是你在共同世界「${world.name}」裡的一段真實生活演繹。
${buildModeRule(world.mode, userName)}
鐵律：你只扮演你自己（${char.name}）。同世界的其他角色各有自己的演繹輪，你看不到他們的內心，只能根據他們外在的言行做反應；不要替任何其他角色做決定或編造他們的內心戲。NPC 的言行可以引用（他們由世界引擎給出）。
保持你在聊天中一貫的人設、記憶與行事風格——這是同一個你，只是生活在這個世界裡。`;
}

/** 居住安排的可讀文本。 */
function describeHousing(world: WorldProfile, members: CharacterProfile[]): string {
    const lines: string[] = [];
    const housed = new Set<string>();
    for (const h of world.houses) {
        const names = h.residentIds
            .map(id => members.find(m => m.id === id)?.name)
            .filter(Boolean) as string[];
        if (names.length === 0) continue;
        names.forEach(n => housed.add(n));
        lines.push(`- ${h.name}：${names.join('、')} 同住`);
    }
    for (const m of members) {
        if (!housed.has(m.name)) lines.push(`- ${m.name} 獨居（自己的住處）`);
    }
    return lines.join('\n');
}

/** 好感檔位（-100 ~ +100，0=陌生中立）。 */
const relTone = (v: number) =>
    v >= 75 ? '親密無間' : v >= 45 ? '關係很好' : v >= 20 ? '有好感' :
    v > -20 ? '中立客套' : v > -45 ? '有嫌隙' : v > -75 ? '敵意' : '深惡痛絕';

/** 該好感檔位對應的行為基調（餵給角色，讓好感真的左右言行）。 */
const relBehavior = (v: number) =>
    v >= 75 ? '你打心底信任ta、願意為ta讓步，相處自然親密。' :
    v >= 45 ? '你樂意主動接近ta、把ta的事放在心上。' :
    v >= 20 ? '你對ta有好感，相處舒服，但還沒到掏心掏肺。' :
    v > -20 ? '你和ta只是泛泛之交/還不熟——客氣、有分寸、保持距離，別表現得自來熟或格外熱絡。' :
    v > -45 ? '你看ta有點不順眼，相處會下意識防備、冷淡或帶點刺，不會主動示好。' :
    v > -75 ? '你對ta有明顯敵意，能不打交道就不打交道，開口多半是衝突。' :
    '你厭惡ta到骨子裡，幾乎無法心平氣和地共處。';

/**
 * 與某角色相關的關係條文本。關係是**有向**的（你對ta ≠ ta對你）：
 *   - 你→別人：給關係名 + 好感檔位 + 數值 + 行為基調（這是你自己的內心，你當然清楚）
 *   - 別人→你：只給粗粒度的"你能感覺到的態度"——對方心裡的定位和具體程度是對方的內心戲
 *   - 他人之間的關係一概不給
 *
 * 好感（潛意識的親疏拉扯）與 label（你理智上給這段關係貼的標籤）可以完全衝突——
 * 嘴上說討厭、心裡卻越來越在意；或稱兄道弟、好感卻在悄悄下滑。衝突時按真實人性演。
 */
function describeRelationsFor(world: WorldProfile, charId: string, members: CharacterProfile[], npcNames: Map<string, string>): string {
    const nameOf = (id: string) => members.find(m => m.id === id)?.name || npcNames.get(id) || '';
    const outgoing = world.relationships.filter(r => r.fromId === charId);
    const incoming = world.relationships.filter(r => r.toId === charId);
    if (outgoing.length === 0 && incoming.length === 0) return '（還沒有建立明確的關係記錄，把彼此當作剛認識的陌生人，憑第一印象保持分寸地相處）';
    const lines: string[] = [];
    for (const r of outgoing) {
        const other = nameOf(r.toId);
        if (!other) continue;
        lines.push(`- 你對 ${other}：${r.label ? `理智上你稱之為「${r.label}」；` : ''}好感 ${r.value}（${relTone(r.value)}）——${relBehavior(r.value)}`);
    }
    for (const r of incoming) {
        const other = nameOf(r.fromId);
        if (!other) continue;
        lines.push(`- 你能隱約感覺到 ${other} 對你的態度：${relTone(r.value)}（只是體感，對方心裡真正怎麼想你並不知道）`);
    }
    return lines.join('\n');
}

/**
 * 單個角色的演繹回合（user turn）。
 *
 * 傳遞路徑（誰能看到什麼——防上帝視角的同時保住真實感）：
 *   - 社交媒體動態：公開，所有人可見
 *   - 公開行程（timeline 裡 shared=true 的條目）：傳給其他角色
 *   - 瞞下的行程（shared=false / secrets）：誰也看不到 → 進伏筆欄，等用戶引爆
 *   - 當面對話：只有對話對象完整聽到
 *   - 私聊：僅收件人；群聊：全員
 *   - 大段正文（narrative）：私人視角，只有屏幕外的用戶看得到
 */
export function buildWorldCharTurn(args: {
    world: WorldProfile;
    char: CharacterProfile;
    members: CharacterProfile[];
    storyTime: string;
    round: number;
    lastSummary?: string;
    npcScene?: string;
    npcHooks?: string[];
    beatsSoFar: WorldCharBeat[];
    /** 公開社交媒體動態（上一輪 + 本輪已演繹角色的 posts） */
    recentPosts?: { name: string; post: string }[];
    /** 伏筆爆發注入（engine 按 armed seeds 為該角色生成的現成文案） */
    exposures?: string[];
    /** 用戶對該角色衝動的決策留言 */
    directive?: { impulseText: string; text: string };
    /** sim 模式：上一卷歸檔後喂回的「該角色單方面視角總結 + 本卷氛圍」（防上帝視角，只給 ta 自己的視角） */
    priorChapter?: { atmosphere?: string; charPerspective?: string };
    userName: string;
}): string {
    const { world, char, members, storyTime, round, lastSummary, npcScene, npcHooks, beatsSoFar, recentPosts, exposures, directive, priorChapter, userName } = args;
    const isLateNight = storyTime.includes('凌晨');
    const others = members.filter(m => m.id !== char.id);
    const npcNames = new Map(world.npcs.map(n => [n.id, n.name]));
    const myHouse = houseOf(world, char.id);

    // ── 這半天其他人的動靜：位置 + 公開行程（shared=true 的時間軸條目）──
    // 同住也≠一直在一起：你能掌握的只是 ta 公開的行程和公共空間的照面。
    const observable = beatsSoFar.length > 0
        ? beatsSoFar.map(b => {
            const sharedTl = (b.timeline || []).filter(tl => tl.shared);
            const tlText = sharedTl.length > 0
                ? `\n${sharedTl.map(tl => `    ${tl.time} 在${tl.place}：${tl.event}`).join('\n')}`
                : `（具體行程你不清楚）`;
            return `- ${b.charName}（主要在${b.location}）${tlText}`;
        }).join('\n')
        : '（這半天你是最先行動的人）';

    // ── 公開社交媒體 ──
    const postsSection = (recentPosts && recentPosts.length > 0)
        ? recentPosts.map(p => `- ${p.name}：${p.post}`).join('\n')
        : '（最近沒人發動態）';

    // ── 當面對你說的話（需要接住） ──
    const spokenToMe = beatsSoFar.flatMap(b =>
        (b.dialogues || [])
            .filter(d => d.with === char.name && d.lines.length > 0)
            .map(d => `${b.charName}（在${b.location}）當面對你說：\n${d.lines.map(l => `  「${l}」`).join('\n')}`)
    );

    // ── 你的手機：私聊線程 + 世界群聊 ──
    const myDms = dmThreadsOf(world, char.id);
    const group = groupThreadOf(world);
    const nameById = new Map([...members.map(m => [m.id, m.name] as const), ...world.npcs.map(n => [n.id, n.name] as const)]);
    const dmSection = myDms.length > 0
        ? myDms.map(t => {
            const otherName = t.memberIds.filter(id => id !== char.id).map(id => nameById.get(id)).filter(Boolean).join('、') || '?';
            return `▸ 與 ${otherName} 的私聊：\n${formatThreadForPrompt(t, char.id, 16, round)}`;
        }).join('\n')
        : '（私聊裡還沒有消息）';
    const groupSection = group && group.messages.length > 0
        ? `▸ 群聊「${group.name}」：\n${formatThreadForPrompt(group, char.id, 20, round)}`
        : `▸ 群聊「${group?.name || `${world.name}·大家的群`}」：（還沒人說話）`;

    // ── 伏筆爆發 / 用戶決策聲音 ──
    const exposureSection = (exposures && exposures.length > 0)
        ? `\n## ⚡ 這半天繞不開的事（必須在 narrative 里正面處理）\n${exposures.map(e => `- ${e}`).join('\n')}`
        : '';
    let directiveSection = '';
    if (directive) {
        directiveSection = world.mode === 'light'
            ? `\n## 心裡的聲音\n關於「${directive.impulseText}」，你忽然想起 ${userName || '那個最重要的人'}——彷彿能聽見 ta 對你說：「${directive.text}」。這句話在你心裡有分量，這半天它會影響你的選擇。`
            : `\n## 心裡的聲音\n關於「${directive.impulseText}」，你內心深處有個聲音越來越清晰：「${directive.text}」。這半天它會影響你的選擇。`;
    }

    // ── 凌晨專屬：夜深了，理性打烊，情緒當班 ──
    const lateNightSection = isLateNight ? `

## 🌙 此刻是凌晨（0點~5點），深夜心境
夜深了，理性打烊，情緒當班。這一段請比白天更**衝動、更感性**地演——但衝動的方向要長在你自己的性格上：
- 白天壓下去的心事此刻會翻上來：想念、委屈、悔意、心動、不甘……全被深夜放大，說不出口的話在凌晨會忍不住說出口。
- 允許做白天不會做的事：深夜 emo 的動態、沒忍住發出去的私聊（第二天可能想撤回的那種）、翻來覆去後一個衝動的決定或告白的念頭。
- narrative 寫得更貼近潛意識：失眠、輾轉、窗外的聲響、手機屏幕的光、越想越清醒的循環——白描少一點，心緒濃一點。
- impulse（衝動/待決策）在凌晨更容易冒頭——此刻的衝動比白天的更真實，也更魯莽，別幫角色理性剎車。
- 當然要貼人設：沾枕就睡的人可以一覺到天亮，那就寫夢境、半夢半醒的囈語、被什麼聲音吵醒的幾分鐘；不是人人都得在凌晨崩潰。` : '';

    return `【家園 · ${world.name}】劇情時間：${storyTime}

## 這個世界
${world.worldview || '（一個安靜的小世界）'}

## 居住安排（注意：同住 ≠ 一直在一起。白天/夜晚大家完全可以各在各處忙自己的事）
${describeHousing(world, members)}
你的住處：${myHouse ? `${myHouse.name}${myHouse.residentIds.length > 1 ? `（和 ${myHouse.residentIds.filter(id => id !== char.id).map(id => members.find(m => m.id === id)?.name).filter(Boolean).join('、')} 同住）` : ''}` : '你自己的住處（獨居）'}

## 同世界的人
${others.length > 0 ? others.map(m => `- ${m.name}`).join('\n') : '（暫時只有你）'}
${world.npcs.length > 0 ? `\n## 鎮上的 NPC\n${world.npcs.map(n => `- ${n.name}：${n.persona}`).join('\n')}` : ''}

## 你的關係
${describeRelationsFor(world, char.id, members, npcNames)}

${priorChapter && (priorChapter.charPerspective || priorChapter.atmosphere) ? `## 前情（這是你自己的視角與記憶，別人怎麼想你並不知道）
${priorChapter.charPerspective || ''}${priorChapter.atmosphere ? `\n（這段日子整體的氣氛：${priorChapter.atmosphere}）` : ''}
` : ''}## 之前發生的事
${lastSummary || (priorChapter ? '（新的一段日子剛剛開始）' : '（這是這個世界的第一個半天，一切剛剛開始）')}
${npcScene ? `\n## 這半天鎮上的動靜（NPC）\n${npcScene}${npcHooks && npcHooks.length > 0 ? `\n可以接住的事件：${npcHooks.join('；')}` : ''}` : ''}

## 社交媒體（公開，大家都刷得到）
${postsSection}

## 這半天其他人的動靜（你能看到/聽說的部分）
${observable}
${spokenToMe.length > 0 ? `\n## 剛才有人當面對你說話（請在 narrative 裡自然接住、給出回應）\n${spokenToMe.join('\n')}` : ''}
${exposureSection}${directiveSection}${lateNightSection}

## 你的手機（標【剛剛】的是這半天剛收到的新消息）
${dmSection}
${groupSection}

---
現在輪到你了。${isLateNight
        ? '凌晨0點到5點——大多數人睡著了，睡不著的人心事最吵：安排你這個下半夜（睡了就寫夢與醒來的片刻，沒睡就寫夜裡的動靜與翻湧的情緒）'
        : '一個上午/一個夜晚能發生很多事：自由安排你這半天的行程（完全可以出門、可以和同住的人一整個半天都碰不上面）'}，聚焦在**你自己**正在經歷的事情上。
嚴格輸出一個 JSON 對象（建議用 \`\`\`json 代碼塊包裹，不要輸出 JSON 之外的正文）：
{
  "location": "這半天你主要在哪",
  "mood": "一兩個詞的此刻心情",
  "timeline": [
    { "time": "8:30", "place": "河堤", "event": "晨跑，碰到了遛狗的鄰居", "shared": true },
    { "time": "10:00", "place": "…", "event": "…", "shared": true }
  ],
  "narrative": "【大段正文，600~900字，分3~5個自然段（\\n\\n分段）】聚焦這一段裡一件有意義的事 + 一次內心動靜的拉扯（一個猶豫、一個決定、一次沒說出口的話）。${narrationPersonGuide(world, char.name)} 文風要求：${narrativeStyleGuide(world)}",
  "memo": ["你隨手記在備忘錄裡的話（0~3條：待辦/碎碎念/不敢說出口的，完全私人）"],
  "impulse": { "text": "你此刻狀態背後的衝動/待決策（想辭職/想告白/想搬走/想加把勁…沒有就省略這個字段）", "options": ["選項A", "選項B"] },
  "secrets": [{ "text": "這半天你瞞著別人的事（對應 timeline 裡 shared=false 的條目；沒有就空數組）", "hideFrom": ["瞞著誰的名字；空數組=瞞所有人"] }],
  "statusPanel": { "體力": 0到100的數字, "心情值": 0到100的數字, "其他你想記錄的狀態": "自由發揮（最多再加2項）" },
  "dialogues": [{ "with": "在場成員的名字", "lines": ["你當面對ta說的話（ta會完整聽到）"] }],
  "phone": {
    "posts": ["這一段發的社交媒體動態（儘量發 1 條，記錄此刻的心情/見聞/吐槽/曬圖文案；除非你確實沒心情發，否則別空著）"],
    "dms": [
      { "to": "某個人的名字（同世界成員或鎮上 NPC，不限於已聊過的人）", "lines": ["私聊消息，像真人在手機上打字——可連發好幾條短的、聊得來回多一點；給 NPC 發的話 ta 會在之後回你"] },
      { "to": "另一個人的名字", "lines": ["想同時私聊好幾個不同的人，就在這個數組裡給每個人各寫一條（to 不同）；只聊一個就只留一條"] }
    ],
    "group": ["發到世界群聊的話（0~4條）"]
  },
  "relationships": [{ "with": "成員名", "delta": -4到4的整數, "reason": "為什麼", "relabel": "（僅在這段關係發生重大轉折時才給）你對這段關係新的定位/稱呼，例如從「死對頭」變成「不打不相識的損友」；平時省略此字段" }]
}
規則：
- timeline 給 ${isLateNight ? '2~4' : '3~6'} 條，時間要符合${isLateNight ? '凌晨0點到5點（午夜到黎明前）' : storyTime.includes('早') ? '清晨到上午' : storyTime.includes('中午') ? '午間到下午' : '傍晚到深夜'}；**shared=false 表示這段你想瞞著**（別人看不到，但可能成為伏筆）。
- **工作日和週末的狀態會不一樣**（看上面劇情時間裡的「周幾」），但具體怎麼個不一樣**完全取決於你的身份設定，別 OOC**：上班族/學生工作日有上班上學通勤的固定骨架、週末才鬆弛；而自由職業、休學在家、無業、自律到雷打不動的人，未必按工作日/週末的節奏走——按你這個人真實的生活方式來，別硬套朝九晚五。
- **別每天都過得一個樣**：你的生活不是復讀機，今天的行程、地點、在意的事要和前幾天明顯不同。時不時給生活來點計劃外的意外——臨時加班、東西壞了、偶遇舊識、突如其來的好/壞消息、心血來潮的決定、天氣攪局……讓每一段都有新鮮變量，而不是「晨跑→工作→回家」的固定循環。
- 信息可見性：動態=公開；timeline(shared=true)=別人能知道；私聊=僅對方；群聊=全員；narrative 和 memo=完全私人。瞞事就讓對應 timeline 條目 shared=false 並寫進 secrets。
- ${world.mode === 'heavy' ? `這個世界裡不存在 ${userName || '用戶'}，所有字段都絕不出現 ta。` : world.mode === 'light' ? `${userName || '用戶'} 是你心裡最重要的人，但此刻不在場——可以在 narrative、memo 或動態裡自然流露惦記。` : `${userName || '用戶'} 只是世界裡的普通一員，不必特意提及。`}
- 動態（phone.posts）必須是這半天**新的**所見所感，**絕不能**把上面「社交媒體」裡已經出現過的文案原樣或換湯不換藥地再發一遍——換件事、換個角度、換種心情寫；沒有新東西可發就寧可空著。
- 手機裡標【剛剛】的消息該回就回（phone.dms / phone.group），已讀不回也行，但要符合你的性格；鼓勵聊得豐富些。
- **想私下聯繫誰，就必須寫進 phone.dms（to=對方名字 + lines），這才是真的把消息發出去、對方才收得到。只在 narrative 正文裡寫"我給ta發了條私聊"是不算數的——對方收不到，那條私聊等於沒發。** 可以同時私聊好幾個不同的人。
- dialogues 只在你的 timeline 和對方真的有共處時才用；不在一起就用手機，或者互相掛念/冷戰都行——聚焦你自己。
- **好感真的會左右你的言行**：嚴格按上面「你的關係」裡每個人的好感檔位與行為基調來相處——低好感/負好感時別自來熟、別無緣無故友善；中立的人就保持客氣的距離感。
- relationships(delta) 要克制、來之不易：日常小事 ±1~2，只有真正觸動你的大事才到 ±3~4；好感是慢慢攢起來、也可能因一件事崩掉的，**絕不會一兩輪就突飛猛進**。好感和你嘴上/理智上對這段關係的定位可以完全相反，按真實人性演（口嫌體正 / 面和心不和都行）。只在真的發生了影響關係的事時才給。`;
}

/**
 * 讓 LLM 讀一遍世界觀 + 各角色人設，roll 幾個貼合這個世界的配角 NPC。
 * members 傳入的是「名字 + 人設摘要」，prompt 只用來生成氛圍配角，不替主角做決定。
 */
export function buildNpcRollPrompt(args: {
    worldName: string;
    worldview: string;
    members: { name: string; persona: string }[];
    count: number;
    existingNames: string[];
}): string {
    const { worldName, worldview, members, count, existingNames } = args;
    return `你在為共同世界「${worldName}」設計 ${count} 個配角 NPC。NPC 沒有記憶，純粹為世界觀氛圍服務、給主角們的生活添點菸火氣與可接住的小事件。

## 世界觀
${worldview || '（一個安靜的小世界，作者還沒細寫，請你據角色們推斷這個世界大概是什麼樣）'}

## 住在這個世界裡的主角（你不設計他們，只據他們的身份/圈子推斷身邊會有哪些人）
${members.length > 0 ? members.map(m => `- ${m.name}：${m.persona || '（沒寫人設）'}`).join('\n') : '（暫時沒有主角信息）'}
${existingNames.length > 0 ? `\n## 已有的 NPC（別重名、別重複）\n${existingNames.join('、')}` : ''}

要求：貼合世界觀與主角們的生活場景（他們會去的店、會打交道的人、住在隔壁的鄰居……），名字自然，人設一句話點到為止、各有記憶點，彼此別雷同。嚴格輸出一個 JSON 對象（建議 \`\`\`json 包裹，不要輸出 JSON 之外的正文）：
{
  "npcs": [
    { "name": "NPC名字", "persona": "一句話人設（身份+一個鮮明特點，例：麵包店老闆娘，熱心腸愛給人塞吃的）", "emoji": "一個能代表ta的 emoji" }
  ]
}
只要 ${count} 個，寧缺毋濫。`;
}

/** 解析 roll 出來的 NPC。返回 {name, persona, emoji}[]，過濾空名/重名。 */
export function parseRolledNpcs(raw: string, existingNames: string[] = []): { name: string; persona: string; emoji: string }[] {
    const j = extractJson(raw);
    let arr: any[] = Array.isArray(j?.npcs) ? j.npcs : Array.isArray(j) ? j : [];
    if (arr.length === 0) {
        // 兜底：模型直接吐了個裸數組 [ ... ]（extractJson 只認對象）
        const m = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').match(/\[[\s\S]*\]/);
        if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) arr = a; } catch { /* ignore */ } }
    }
    const seen = new Set(existingNames.map(n => n.trim()));
    const out: { name: string; persona: string; emoji: string }[] = [];
    for (const n of arr) {
        if (!n || typeof n.name !== 'string') continue;
        const name = n.name.trim().slice(0, 16);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({
            name,
            persona: (typeof n.persona === 'string' ? n.persona.trim() : '').slice(0, 60),
            emoji: (typeof n.emoji === 'string' && n.emoji.trim() ? n.emoji.trim() : '🙂').slice(0, 4),
        });
        if (out.length >= 8) break;
    }
    return out;
}

/** NPC 世界引擎回合（一次調用演完所有 NPC；NPC 無記憶，僅靠世界觀+上輪梗概）。 */
export function buildNpcTurn(args: {
    world: WorldProfile;
    members: CharacterProfile[];
    storyTime: string;
    lastSummary?: string;
    /** sim 模式：上一卷沉澱的氛圍基調（不含隱私，可給世界引擎定調） */
    chapterAtmosphere?: string;
    /** 成員發給各 NPC、還沒回的私信收件箱 */
    inboxes?: { npcName: string; memberName: string; recent: string }[];
    /** 最近的社交動態（讓 NPC + 路人瘋狂點贊/評論） */
    recentPosts?: { ref: string; name: string; post: string }[];
}): string {
    const { world, members, storyTime, lastSummary, chapterAtmosphere, inboxes, recentPosts } = args;
    const lateNightNote = storyTime.includes('凌晨')
        ? `\n\n## 🌙 現在是凌晨（0點~5點）\n鎮子基本睡著了。scene 寫夜的質感：便利店的夜班燈、末班車、巡街的貓、亮著的一兩扇窗；hooks 少而輕（1條就夠）；groupLines 至多 1 條（只有夜貓子 NPC 才冒泡）；點贊評論克制些——深夜刷手機的人少，但深夜 emo 的動態容易引來同樣失眠的人留下感性的共情評論。`
        : '';
    const inboxSection = (inboxes && inboxes.length > 0)
        ? `\n## 📨 NPC 收到的私信（請讓對應 NPC 回覆）\n${inboxes.map(b => `▸ ${b.memberName} → ${b.npcName}：\n${b.recent}`).join('\n')}`
        : '';
    const postsSection = (recentPosts && recentPosts.length > 0)
        ? `\n## 📱 社交動態（請熱鬧地點贊 + 評論——NPC 和路人都可以；ref 原樣回填）\n${recentPosts.map(p => `[${p.ref}] ${p.name}：${p.post}`).join('\n')}`
        : '';
    return `你是共同世界「${world.name}」的世界引擎，負責一次性扮演鎮上所有 NPC。NPC 沒有獨立記憶，完全為世界觀氛圍服務。

## 世界觀
${world.worldview || '（一個安靜的小世界）'}

## NPC 名單
${world.npcs.map(n => `- ${n.name}：${n.persona}`).join('\n')}

## 世界的主角們（你不扮演他們，只能讓 NPC 與他們擦肩、寒暄、留下鉤子）
${members.map(m => m.name).join('、')}

## 之前發生的事
${lastSummary || '（這是這個世界的第一個半天）'}
${chapterAtmosphere ? `\n## 這段日子的氛圍基調\n${chapterAtmosphere}` : ''}${lateNightNote}${inboxSection}${postsSection}
劇情時間：${storyTime}。
一次性輸出這一段所有 NPC 的群像動靜。嚴格輸出一個 JSON 對象（建議用 \`\`\`json 包裹）：
{
  "scene": "200~400字的 NPC 群像敘述：誰在做什麼、市井氣息、天氣與街景、和主角們擦肩的小事件。生活感優先，不要推進重大劇情。",
  "hooks": ["1~3個可以被主角們接住的小事件鉤子（例：麵包店老闆娘今天多烤了一爐栗子麵包，見人就塞）"],
  "groupLines": [{ "name": "NPC的名字", "line": "ta在世界群聊裡冒泡的一句話（0~2條，市井閒聊/吆喝/通知，別太頻繁）" }],
  "dms": [{ "from": "NPC的名字", "to": "給ta發私信的成員名", "lines": ["NPC 私信回覆（針對上面收件箱裡的消息；沒有要回的就空數組）"] }],
  "feedReactions": [{ "ref": "動態的ref原樣", "likes": 點贊數(0~99的整數), "comments": [{ "from": "評論者名字（NPC 或隨手編一個路人網名，如「街角咖啡師」「ConanFan_07」）", "text": "一句評論，熱鬧、口語、有梗" }] }]
}
讓社交動態**熱鬧起來**：給每條動態都點上贊、配幾條評論；評論者多用路人網名（不必是 NPC），像真的社交平台一樣你一言我一語。`;
}

// ── 輸出解析 ──────────────────────────────────────────────

/** 從 LLM 輸出裡撈出第一個 JSON 對象（支持 ```json 圍欄 / 裸 JSON / 夾雜正文）。 */
export function extractJson(raw: string): any | null {
    const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // 1) 圍欄代碼塊優先
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates: string[] = [];
    if (fence?.[1]) candidates.push(fence[1].trim());
    // 2) 第一個 { 到最後一個 } 的貪婪截取
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
    for (const c of candidates) {
        try { return JSON.parse(c); } catch { /* try next */ }
        // 寬鬆修復：去掉尾逗號再試
        try { return JSON.parse(c.replace(/,\s*([}\]])/g, '$1')); } catch { /* try next */ }
    }
    return null;
}

const clampNum = (v: any, lo: number, hi: number, fallback: number): number => {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** 解析單角色演繹輸出 → WorldCharBeat（解析失敗時整段原文兜底進 narrative，絕不丟內容）。 */
export function parseCharBeat(raw: string, char: CharacterProfile, memberNames: string[], npcNames: string[] = []): WorldCharBeat {
    const j = extractJson(raw);
    const fallbackNarrative = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?|```/g, '').trim().slice(0, 1400);
    if (!j || typeof j !== 'object') {
        return { charId: char.id, charName: char.name, location: '住處', narrative: fallbackNarrative || '安靜地度過了這半天。', mood: '平靜' };
    }
    const nameSet = new Set(memberNames);
    const dmNameSet = new Set([...memberNames, ...npcNames]); // 私聊對象可以是成員或 NPC
    const statusPanel: Record<string, number | string> = {};
    if (j.statusPanel && typeof j.statusPanel === 'object') {
        let count = 0;
        for (const [k, v] of Object.entries(j.statusPanel)) {
            if (count >= 5) break;
            statusPanel[String(k).slice(0, 12)] = typeof v === 'number' ? clampNum(v, 0, 100, 50) : String(v).slice(0, 30);
            count += 1;
        }
    }
    const dms = Array.isArray(j.phone?.dms)
        ? j.phone.dms
            .filter((d: any) => d && typeof d.to === 'string' && dmNameSet.has(d.to) && Array.isArray(d.lines))
            .map((d: any) => ({ to: d.to, lines: d.lines.map((l: any) => String(l).slice(0, 200)).filter(Boolean).slice(0, 8) }))
            .filter((d: any) => d.lines.length > 0)
            .slice(0, 4)
        : [];
    // 兼容模型把 posts/group 放在 phone 下或直接放在根上兩種寫法
    const rawPosts = Array.isArray(j.phone?.posts) ? j.phone.posts : Array.isArray(j.posts) ? j.posts : [];
    const posts = rawPosts.map((p: any) => String(p).slice(0, 300)).filter(Boolean).slice(0, 2);
    const rawGroup = Array.isArray(j.phone?.group) ? j.phone.group : Array.isArray(j.group) ? j.group : [];
    const group = rawGroup.map((l: any) => String(l).slice(0, 200)).filter(Boolean).slice(0, 3);
    const dialogues = Array.isArray(j.dialogues)
        ? j.dialogues
            .filter((d: any) => d && typeof d.with === 'string' && nameSet.has(d.with) && Array.isArray(d.lines))
            .map((d: any) => ({ with: d.with, lines: d.lines.map((l: any) => String(l).slice(0, 200)).filter(Boolean).slice(0, 8) }))
            .filter((d: any) => d.lines.length > 0)
            .slice(0, 4)
        : [];
    const relationshipDeltas = Array.isArray(j.relationships)
        ? j.relationships
            .filter((r: any) => r && typeof r.with === 'string' && nameSet.has(r.with))
            .map((r: any) => ({ withName: r.with, delta: clampNum(r.delta, -4, 4, 0), reason: r.reason ? String(r.reason).slice(0, 100) : undefined, newLabel: r.relabel && String(r.relabel).trim() ? String(r.relabel).trim().slice(0, 24) : undefined }))
            .slice(0, 5)
        : [];
    const timeline = Array.isArray(j.timeline)
        ? j.timeline
            .filter((tl: any) => tl && typeof tl.event === 'string' && tl.event.trim())
            .map((tl: any) => ({
                time: typeof tl.time === 'string' ? tl.time.trim().slice(0, 12) : '',
                place: typeof tl.place === 'string' ? tl.place.trim().slice(0, 30) : '',
                event: tl.event.trim().slice(0, 120),
                shared: tl.shared !== false, // 默認公開，顯式 false 才是瞞
            }))
            .slice(0, 8)
        : [];
    const memo = Array.isArray(j.memo) ? j.memo.map((m: any) => String(m).slice(0, 200)).filter(Boolean).slice(0, 4) : [];
    const impulse = (j.impulse && typeof j.impulse.text === 'string' && j.impulse.text.trim())
        ? {
            text: j.impulse.text.trim().slice(0, 120),
            options: Array.isArray(j.impulse.options) ? j.impulse.options.map((o: any) => String(o).slice(0, 30)).filter(Boolean).slice(0, 3) : undefined,
        }
        : undefined;
    const secrets = Array.isArray(j.secrets)
        ? j.secrets
            .filter((s: any) => s && typeof s.text === 'string' && s.text.trim())
            .map((s: any) => ({
                text: s.text.trim().slice(0, 160),
                hideFrom: Array.isArray(s.hideFrom) ? s.hideFrom.map((n: any) => String(n)).filter((n: string) => nameSet.has(n)) : [],
            }))
            .slice(0, 3)
        : [];
    return {
        charId: char.id,
        charName: char.name,
        location: typeof j.location === 'string' && j.location.trim() ? j.location.trim().slice(0, 40) : '住處',
        narrative: typeof j.narrative === 'string' && j.narrative.trim() ? j.narrative.trim() : (fallbackNarrative || '安靜地度過了這半天。'),
        mood: typeof j.mood === 'string' && j.mood.trim() ? j.mood.trim().slice(0, 16) : '平靜',
        statusPanel: Object.keys(statusPanel).length > 0 ? statusPanel : undefined,
        timeline: timeline.length > 0 ? timeline : undefined,
        memo: memo.length > 0 ? memo : undefined,
        impulse,
        secrets: secrets.length > 0 ? secrets : undefined,
        phone: (dms.length > 0 || posts.length > 0 || group.length > 0) ? { posts, dms, group } : undefined,
        dialogues: dialogues.length > 0 ? dialogues : undefined,
        relationshipDeltas: relationshipDeltas.length > 0 ? relationshipDeltas : undefined,
    };
}

/** 解析 NPC 世界引擎輸出。 */
export function parseNpcScene(raw: string): { scene: string; hooks: string[]; groupLines: { name: string; line: string }[]; dms: { from: string; to: string; lines: string[] }[]; feedReactions: { ref: string; likes: number; comments: { from: string; text: string }[] }[] } {
    const j = extractJson(raw);
    if (j && typeof j.scene === 'string') {
        return {
            scene: j.scene.trim(),
            hooks: Array.isArray(j.hooks) ? j.hooks.map((h: any) => String(h).slice(0, 120)).slice(0, 3) : [],
            groupLines: Array.isArray(j.groupLines)
                ? j.groupLines
                    .filter((g: any) => g && typeof g.name === 'string' && typeof g.line === 'string' && g.line.trim())
                    .map((g: any) => ({ name: g.name.trim(), line: g.line.trim().slice(0, 200) }))
                    .slice(0, 2)
                : [],
            dms: Array.isArray(j.dms)
                ? j.dms
                    .filter((d: any) => d && typeof d.from === 'string' && typeof d.to === 'string' && Array.isArray(d.lines))
                    .map((d: any) => ({ from: d.from.trim(), to: d.to.trim(), lines: d.lines.map((l: any) => String(l).slice(0, 200)).filter(Boolean).slice(0, 6) }))
                    .filter((d: any) => d.lines.length > 0)
                    .slice(0, 8)
                : [],
            feedReactions: Array.isArray(j.feedReactions)
                ? j.feedReactions
                    .filter((r: any) => r && typeof r.ref === 'string')
                    .map((r: any) => ({
                        ref: r.ref.trim(),
                        likes: clampNum(r.likes, 0, 999, 0),
                        comments: Array.isArray(r.comments)
                            ? r.comments.filter((c: any) => c && typeof c.from === 'string' && typeof c.text === 'string' && c.text.trim())
                                .map((c: any) => ({ from: c.from.trim().slice(0, 20), text: c.text.trim().slice(0, 160) })).slice(0, 8)
                            : [],
                    }))
                    .slice(0, 20)
                : [],
        };
    }
    const fallback = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?|```/g, '').trim().slice(0, 500);
    return { scene: fallback, hooks: [], groupLines: [], dms: [], feedReactions: [] };
}
