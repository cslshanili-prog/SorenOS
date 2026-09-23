import { CharacterTrajectoryProfile, TrajectoryArchiveDoc, TrajectoryChecklistItem, TrajectoryJourneyEntry, TrajectoryMomentPost, TrajectoryObjective, TrajectoryOotdPost } from '../types';

function genId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTrajectoryArchiveDoc(input: { title: string; category: string; content: string }): TrajectoryArchiveDoc {
    return { id: genId('traj-arc'), title: input.title, category: input.category, content: input.content, createdAt: Date.now() };
}

export function createTrajectoryObjective(input: { title: string; progress: number; detail: string }): TrajectoryObjective {
    return { id: genId('traj-obj'), title: input.title, progress: Math.max(0, Math.min(100, Math.round(input.progress))), detail: input.detail, createdAt: Date.now() };
}

export function createTrajectoryChecklistItem(input: { title: string; dueLabel: string; done?: boolean }): TrajectoryChecklistItem {
    return { id: genId('traj-chk'), title: input.title, dueLabel: input.dueLabel, done: !!input.done, createdAt: Date.now() };
}

/**
 * Profile 三段（檔案資料/階段目標/待辦日程）一次性生成的提示詞，按角色人設自由發散——
 * roleSettingsBlock 傳 utils/context.ts 的 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })，
 * 不帶記憶，純粹讓 AI 依角色設定編幾份「TA 自己的生活痕跡」。
 */
export function buildTrajectoryProfilePrompt(roleSettingsBlock: string, existing?: CharacterTrajectoryProfile): string {
    let antiRepeat = '';
    if (existing && (existing.archives.length || existing.objectives.length || existing.checklist.length)) {
        const titles = [
            ...existing.archives.map(d => d.title),
            ...existing.objectives.map(o => o.title),
            ...existing.checklist.map(c => c.title),
        ];
        antiRepeat = `\n\n已經有這些條目了，這次生成不要重複：${titles.join('、')}`;
    }
    return `依照上面這份角色設定，自由發揮生成這個角色手機裡「軌跡」App 的 Profile 頁三段內容——這是TA自己視角的私人資料，越貼合TA的人設/世界觀越好，可以是任何畫風（現實/奇幻/科幻/懸疑……跟著角色本身的設定走）。${antiRepeat}\n\n` +
        `生成：\n` +
        `- archives（檔案資料，2-3 份）：TA 個人持有的文件，比如授權書、任命文件、合同書、協議、產權證明、股權/保密協議等，category 是文件類型標籤（英文大寫，如 "PERSONAL DOCUMENT"），content 是文件正文（可以帶一點懸念/角色感，不用寫成正式公文腔）。\n` +
        `- objectives（階段目標，2-3 條）：TA 正在推進的任務/作品/計劃，progress 是 0-100 的整數進度。\n` +
        `- checklist（待辦日程，3-5 條）：TA 的待辦清單，dueLabel 是自由文本時間說明（如"明天 15:00"、"每天 22:00"、"後天"），done 是這條是否已完成（可以有 1-2 條已完成的，營造真實感）。\n\n` +
        `**JSON 字段類型硬約束**：只能返回下面這個形狀的 JSON 對象，所有文本字段必須是字符串，progress 必須是數字，done 必須是布爾值：\n` +
        `{\n` +
        `  "archives": [{ "title": "文件標題", "category": "PERSONAL DOCUMENT", "content": "文件正文" }],\n` +
        `  "objectives": [{ "title": "目標標題", "progress": 65, "detail": "這個目標具體在做什麼" }],\n` +
        `  "checklist": [{ "title": "待辦事項標題", "dueLabel": "明天 15:00", "done": false }]\n` +
        `}`;
}

/** 把 AI 返回的鬆散 JSON 對象過濾/糾錯成可以直接存進 phoneState.trajectoryProfile 的形狀。 */
export function parseTrajectoryProfile(json: unknown): CharacterTrajectoryProfile {
    const obj = (json && typeof json === 'object') ? json as any : {};

    const archives: TrajectoryArchiveDoc[] = Array.isArray(obj.archives) ? obj.archives
        .filter((d: any) => d && typeof d === 'object' && String(d.title ?? '').trim())
        .map((d: any) => createTrajectoryArchiveDoc({
            title: String(d.title).trim(),
            category: typeof d.category === 'string' && d.category.trim() ? d.category.trim() : 'PERSONAL DOCUMENT',
            content: typeof d.content === 'string' ? d.content.trim() : '',
        })) : [];

    const objectives: TrajectoryObjective[] = Array.isArray(obj.objectives) ? obj.objectives
        .filter((o: any) => o && typeof o === 'object' && String(o.title ?? '').trim())
        .map((o: any) => createTrajectoryObjective({
            title: String(o.title).trim(),
            progress: typeof o.progress === 'number' ? o.progress : parseFloat(String(o.progress ?? '')) || 0,
            detail: typeof o.detail === 'string' ? o.detail.trim() : '',
        })) : [];

    const checklist: TrajectoryChecklistItem[] = Array.isArray(obj.checklist) ? obj.checklist
        .filter((c: any) => c && typeof c === 'object' && String(c.title ?? '').trim())
        .map((c: any) => createTrajectoryChecklistItem({
            title: String(c.title).trim(),
            dueLabel: typeof c.dueLabel === 'string' && c.dueLabel.trim() ? c.dueLabel.trim() : '待安排',
            done: c.done === true,
        })) : [];

    return { archives, objectives, checklist, updatedAt: Date.now() };
}

/** 單條 checklist 項目切換勾選狀態，其餘條目原樣保留。 */
export function toggleTrajectoryChecklistItem(profile: CharacterTrajectoryProfile, itemId: string): CharacterTrajectoryProfile {
    return {
        ...profile,
        checklist: profile.checklist.map(c => c.id === itemId ? { ...c, done: !c.done } : c),
    };
}

/**
 * 按「生成批次」分組 checklist：同一次刷新裡 AI 一口氣生成的幾條，createdAt 幾乎同一毫秒，
 * 歸到同一批（精度按分鐘取整，夠用且不用額外落一個 batchId 字段）；批次間新到舊排列，
 * 批內保持原始（新到舊）順序。展示時每批頂上放一條「9月20日 9:00」式的時間標題。
 */
export function groupTrajectoryChecklistByBatch(items: TrajectoryChecklistItem[]): { timestamp: number; items: TrajectoryChecklistItem[] }[] {
    const groups = new Map<number, TrajectoryChecklistItem[]>();
    for (const item of [...items].sort((a, b) => b.createdAt - a.createdAt)) {
        const bucketTs = Math.floor(item.createdAt / 60000) * 60000;
        const bucket = groups.get(bucketTs);
        if (bucket) bucket.push(item); else groups.set(bucketTs, [item]);
    }
    return Array.from(groups.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([timestamp, items]) => ({ timestamp, items }));
}

/** OOTD 生成結果裡還沒落成 TrajectoryOotdPost 的部分——多一個 imagePrompt 給生圖管線用，不落庫。 */
export interface TrajectoryOotdDraft {
    style: string;
    colors: string[];
    tops: string;
    bottoms: string;
    shoes: string;
    accessories: string[];
    imagePrompt: string;
}

/**
 * OOTD 穿搭描述的生成提示詞——只管文字部分（風格/配色/上衣/下裝/鞋/配飾 + 一段給生圖用的
 * 畫面描述），圖片由調用方另外拿 imagePrompt 去跑生圖管線。roleSettingsBlock 同 Profile，
 * 傳 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })。
 * timeContext：調用方拼好的「現在幾點/正在做什麼」文本（ContextBuilder.buildTimeAwarenessBlock +
 * 可選的 ContextBuilder.buildScheduleInjection），讓穿搭貼合當下時間和日程，不傳就不提時間。
 */
export function buildTrajectoryOotdPrompt(roleSettingsBlock: string, existing?: TrajectoryOotdPost[], timeContext?: string): string {
    let antiRepeat = '';
    if (existing && existing.length) {
        const recent = existing.slice(0, 5).map(p => `${p.tops}+${p.bottoms}`);
        antiRepeat = `\n\n最近穿過這些搭配了，這次換一身不一樣的：${recent.join('、')}`;
    }
    const timeBlock = timeContext?.trim() ? `\n\n${timeContext.trim()}` : '';
    return `依照上面這份角色設定，自由發揮生成這個角色此刻的一身穿搭（OOTD），越貼合TA的人設/生活場景越好。${antiRepeat}${timeBlock}\n\n` +
        `這身穿搭必須符合上面給出的當下時間和TA此刻正在做的事——工作/通勤時段該是正裝或職業裝，深夜/睡前該是睡衣或家居服，運動時段該是運動服，純休息/在家該是居家休閒服，不要出現"深夜穿正裝""運動時段穿西裝"這種不合常理的搭配；如果角色人設或專屬人物提示詞裡提到了作息習慣（比如"上班穿正裝、下班換休閒"），也要對上當下到底是哪個時段。\n\n` +
        `生成：\n` +
        `- style：風格標籤（如"休閒"、"通勤"、"運動"，2-4 字）\n` +
        `- colors：這身搭配的主色調，1-3 個顏色詞的數組\n` +
        `- tops：上衣的具體描述（如"杏色亞麻襯衫"）\n` +
        `- bottoms：下裝的具體描述（如"米白亞麻褲"）\n` +
        `- shoes：鞋子的具體描述\n` +
        `- accessories：配飾，0-3 項的數組（可以是空數組）\n` +
        `- imagePrompt：給 AI 生圖用的一段英文畫面描述，統一走"站在穿衣鏡前用手機自拍"這個路子——地點是全身鏡前，手裡舉著手機在拍這身穿搭，構圖半身或全身都行，視線不一定看鏡頭（可以低頭看手機屏幕、側臉、看別處），偶爾可以讓舉著的手機或手臂擋住部分臉，營造真實生活感的鏡子自拍；背景光線/氛圍也要跟當下是白天還是深夜對上，不要寫成跟時間矛盾的場景。但站姿、鏡頭遠近、身體朝向、手機遮臉與否這些細節每次都要不一樣，不要寫成同一個姿勢，不要出現角色的真實姓名\n\n` +
        `**JSON 字段類型硬約束**：只能返回下面這個形狀的 JSON 對象，colors/accessories 必須是字符串數組，其餘字段必須是字符串：\n` +
        `{ "style": "休閒", "colors": ["米白色", "杏色"], "tops": "杏色亞麻襯衫", "bottoms": "米白亞麻褲", "shoes": "小白鞋", "accessories": ["帆布包"], "imagePrompt": "a young woman in a beige linen shirt..." }`;
}

/** 把 AI 返回的鬆散 JSON 對象過濾/糾錯成 TrajectoryOotdDraft；字段不完整（缺 imagePrompt 等）時返回 null。 */
export function parseTrajectoryOotdDraft(json: unknown): TrajectoryOotdDraft | null {
    if (!json || typeof json !== 'object') return null;
    const obj = json as any;
    const imagePrompt = typeof obj.imagePrompt === 'string' ? obj.imagePrompt.trim() : '';
    if (!imagePrompt) return null;
    const toStringArray = (v: unknown): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
    return {
        style: typeof obj.style === 'string' && obj.style.trim() ? obj.style.trim() : '日常',
        colors: toStringArray(obj.colors),
        tops: typeof obj.tops === 'string' ? obj.tops.trim() : '',
        bottoms: typeof obj.bottoms === 'string' ? obj.bottoms.trim() : '',
        shoes: typeof obj.shoes === 'string' ? obj.shoes.trim() : '',
        accessories: toStringArray(obj.accessories),
        imagePrompt,
    };
}

/** draft + 生圖結果的 image token 拼成一條可以直接存進 phoneState.trajectoryOotd 的記錄。 */
export function createTrajectoryOotdPost(draft: TrajectoryOotdDraft, image: string): TrajectoryOotdPost {
    return {
        id: genId('traj-ootd'),
        timestamp: Date.now(),
        image,
        imagePrompt: draft.imagePrompt,
        style: draft.style,
        colors: draft.colors,
        tops: draft.tops,
        bottoms: draft.bottoms,
        shoes: draft.shoes,
        accessories: draft.accessories,
    };
}

/** 按「日」分組，組內新到舊；組間按日期新到舊——feed 視圖直接吃這個結構。 */
export function groupTrajectoryOotdByDate(posts: TrajectoryOotdPost[]): { dateKey: string; posts: TrajectoryOotdPost[] }[] {
    const groups = new Map<string, TrajectoryOotdPost[]>();
    for (const p of [...posts].sort((a, b) => b.timestamp - a.timestamp)) {
        const d = new Date(p.timestamp);
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const bucket = groups.get(dateKey);
        if (bucket) bucket.push(p); else groups.set(dateKey, [p]);
    }
    return Array.from(groups.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([dateKey, posts]) => ({ dateKey, posts }));
}

/** Moments 生成結果裡還沒落成 TrajectoryMomentPost 的部分——多一個 imagePrompt 給生圖管線用，不落庫。 */
export interface TrajectoryMomentDraft {
    content: string;
    likes: number;
    comments: { authorName: string; content: string }[];
    imagePrompt: string;
}

/**
 * 「軌跡」Moments 分頁的生成提示詞——角色專屬動態，自己發自己的，不讀任何共享動態池。
 * 文字部分（正文 + 點贊數 + 幾條點綴用評論）+ 一段給生圖用的畫面描述，圖片由調用方另外
 * 拿 imagePrompt 去跑生圖管線。roleSettingsBlock 同 Profile/OOTD，
 * 傳 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })。
 */
export function buildTrajectoryMomentsPrompt(roleSettingsBlock: string, existing?: TrajectoryMomentPost[]): string {
    let antiRepeat = '';
    if (existing && existing.length) {
        const recent = existing.slice(0, 5).map(p => p.content.slice(0, 20));
        antiRepeat = `\n\n最近發過這些內容了，這次換個不一樣的場景/心情：${recent.join('、')}`;
    }
    return `依照上面這份角色設定，自由發揮生成這個角色此刻發的一條朋友圈動態，越貼合TA的人設/生活場景越好，` +
        `第一人稱語氣，像真的在發朋友圈。${antiRepeat}\n\n` +
        `生成：\n` +
        `- content：動態正文（1-3 句話，口語化，可以帶點情緒/心情）\n` +
        `- likes：這條動態收到的點贊數，10-500 之間的整數，符合這條內容的分量\n` +
        `- comments：0-3 條別人（陌生網友/路人）的評論，每條給 authorName（隨意起的網名）和 content（簡短評論）\n` +
        `- imagePrompt：給 AI 生圖用的一段英文畫面描述，描述這條動態配的照片長什麼樣（呼應正文內容），不要出現角色的真實姓名\n\n` +
        `**JSON 字段類型硬約束**：只能返回下面這個形狀的 JSON 對象，comments 必須是對象數組，likes 必須是數字，其餘字段必須是字符串：\n` +
        `{ "content": "今天天氣正好，出來走走", "likes": 128, "comments": [{ "authorName": "路人甲", "content": "好美的天氣！" }], "imagePrompt": "a sunny street scene..." }`;
}

/** 把 AI 返回的鬆散 JSON 對象過濾/糾錯成 TrajectoryMomentDraft；字段不完整（缺 content/imagePrompt 等）時返回 null。 */
export function parseTrajectoryMomentDraft(json: unknown): TrajectoryMomentDraft | null {
    if (!json || typeof json !== 'object') return null;
    const obj = json as any;
    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    const imagePrompt = typeof obj.imagePrompt === 'string' ? obj.imagePrompt.trim() : '';
    if (!content || !imagePrompt) return null;
    const comments = Array.isArray(obj.comments) ? obj.comments
        .filter((c: any) => c && typeof c === 'object' && String(c.content ?? '').trim())
        .map((c: any) => ({
            authorName: typeof c.authorName === 'string' && c.authorName.trim() ? c.authorName.trim() : '路人',
            content: String(c.content).trim(),
        })) : [];
    return {
        content,
        likes: typeof obj.likes === 'number' ? Math.max(0, Math.round(obj.likes)) : parseInt(String(obj.likes ?? ''), 10) || 0,
        comments,
        imagePrompt,
    };
}

/** draft + 生圖結果的 image token 拼成一條可以直接存進 phoneState.trajectoryMoments 的記錄。 */
export function createTrajectoryMomentPost(draft: TrajectoryMomentDraft, image: string): TrajectoryMomentPost {
    return {
        id: genId('traj-mom'),
        timestamp: Date.now(),
        content: draft.content,
        image,
        imagePrompt: draft.imagePrompt,
        likes: draft.likes,
        comments: draft.comments.map(c => ({ id: genId('traj-mom-cm'), authorName: c.authorName, content: c.content })),
    };
}

/**
 * Journey 行程敘事的生成提示詞——純第三人稱敘事，不含用戶/玩家、不寫成對話腳本。
 * roleSettingsBlock 同 Profile/OOTD，傳 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })。
 * 輸出直接是敘事正文（不是 JSON），調用方拿 extractContent(data).trim() 就是 story。
 */
export function buildTrajectoryJourneyPrompt(
    roleSettingsBlock: string,
    input: { kind: '日常' | '事件'; time: string; location: string; participants: { name: string; description: string }[]; detail?: string },
): string {
    const participantLines = input.participants.length
        ? input.participants.map(p => `- ${p.name}${p.description ? `：${p.description}` : ''}`).join('\n')
        : '（沒有指定見面對象，就寫TA獨自經歷的一段）';
    return `依照上面這份角色設定，寫一段第三人稱的短篇敘事——這是TA手機「軌跡」App 裡的一段私人行程，` +
        `記錄的是TA自己的生活，不是跟用戶的互動，正文裡絕對不能出現用戶/玩家，也不要寫成對話腳本或問答，` +
        `就是一段完整流暢的敘事文字。\n\n` +
        `- 類型：${input.kind}\n` +
        `- 時間：${input.time || '（未指定，自行安排）'}\n` +
        `- 地點/場景：${input.location || '（未指定，自行安排）'}\n` +
        `- 見面對象：\n${participantLines}\n` +
        `${input.detail?.trim() ? `- 補充細節：${input.detail.trim()}\n` : ''}\n` +
        `直接輸出這段敘事正文本身，300-500 字左右，不要標題、不要 markdown 標記、不要任何額外說明或前後綴。`;
}

export function createTrajectoryJourneyEntry(input: {
    kind: '日常' | '事件'; time: string; location: string; participantNames: string[]; participantCharIds?: string[]; detail?: string; story: string;
}): TrajectoryJourneyEntry {
    return {
        id: genId('traj-jn'),
        kind: input.kind,
        time: input.time,
        location: input.location,
        participantNames: input.participantNames,
        participantCharIds: input.participantCharIds?.length ? input.participantCharIds : undefined,
        detail: input.detail?.trim() || undefined,
        story: input.story,
        createdAt: Date.now(),
    };
}
