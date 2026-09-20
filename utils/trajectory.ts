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
 * Profile 三段（档案资料/阶段目标/待办日程）一次性生成的提示词，按角色人设自由发散——
 * roleSettingsBlock 传 utils/context.ts 的 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })，
 * 不带记忆，纯粹让 AI 依角色设定编几份「TA 自己的生活痕迹」。
 */
export function buildTrajectoryProfilePrompt(roleSettingsBlock: string, existing?: CharacterTrajectoryProfile): string {
    let antiRepeat = '';
    if (existing && (existing.archives.length || existing.objectives.length || existing.checklist.length)) {
        const titles = [
            ...existing.archives.map(d => d.title),
            ...existing.objectives.map(o => o.title),
            ...existing.checklist.map(c => c.title),
        ];
        antiRepeat = `\n\n已经有这些条目了，这次生成不要重复：${titles.join('、')}`;
    }
    return `依照上面这份角色设定，自由发挥生成这个角色手机里「軌跡」App 的 Profile 页三段内容——这是TA自己视角的私人资料，越贴合TA的人设/世界观越好，可以是任何画风（现实/奇幻/科幻/悬疑……跟着角色本身的设定走）。${antiRepeat}\n\n` +
        `生成：\n` +
        `- archives（档案资料，2-3 份）：TA 个人持有的文件，比如授权书、任命文件、合同书、协议、产权证明、股权/保密协议等，category 是文件类型标签（英文大写，如 "PERSONAL DOCUMENT"），content 是文件正文（可以带一点悬念/角色感，不用写成正式公文腔）。\n` +
        `- objectives（阶段目标，2-3 条）：TA 正在推进的任务/作品/计划，progress 是 0-100 的整数进度。\n` +
        `- checklist（待办日程，3-5 条）：TA 的待办清单，dueLabel 是自由文本时间说明（如"明天 15:00"、"每天 22:00"、"后天"），done 是这条是否已完成（可以有 1-2 条已完成的，营造真实感）。\n\n` +
        `**JSON 字段类型硬约束**：只能返回下面这个形状的 JSON 对象，所有文本字段必须是字符串，progress 必须是数字，done 必须是布尔值：\n` +
        `{\n` +
        `  "archives": [{ "title": "文件标题", "category": "PERSONAL DOCUMENT", "content": "文件正文" }],\n` +
        `  "objectives": [{ "title": "目标标题", "progress": 65, "detail": "这个目标具体在做什么" }],\n` +
        `  "checklist": [{ "title": "待办事项标题", "dueLabel": "明天 15:00", "done": false }]\n` +
        `}`;
}

/** 把 AI 返回的松散 JSON 对象过滤/纠错成可以直接存进 phoneState.trajectoryProfile 的形状。 */
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

/** 单条 checklist 项目切换勾选状态，其余条目原样保留。 */
export function toggleTrajectoryChecklistItem(profile: CharacterTrajectoryProfile, itemId: string): CharacterTrajectoryProfile {
    return {
        ...profile,
        checklist: profile.checklist.map(c => c.id === itemId ? { ...c, done: !c.done } : c),
    };
}

/**
 * 按「生成批次」分组 checklist：同一次刷新里 AI 一口气生成的几条，createdAt 几乎同一毫秒，
 * 归到同一批（精度按分钟取整，够用且不用额外落一个 batchId 字段）；批次间新到旧排列，
 * 批内保持原始（新到旧）顺序。展示时每批顶上放一条「9月20日 9:00」式的时间标题。
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

/** OOTD 生成结果里还没落成 TrajectoryOotdPost 的部分——多一个 imagePrompt 给生图管线用，不落库。 */
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
 * OOTD 穿搭描述的生成提示词——只管文字部分（风格/配色/上衣/下装/鞋/配饰 + 一段给生图用的
 * 画面描述），图片由调用方另外拿 imagePrompt 去跑生图管线。roleSettingsBlock 同 Profile，
 * 传 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })。
 */
export function buildTrajectoryOotdPrompt(roleSettingsBlock: string, existing?: TrajectoryOotdPost[]): string {
    let antiRepeat = '';
    if (existing && existing.length) {
        const recent = existing.slice(0, 5).map(p => `${p.tops}+${p.bottoms}`);
        antiRepeat = `\n\n最近穿过这些搭配了，这次换一身不一样的：${recent.join('、')}`;
    }
    return `依照上面这份角色设定，自由发挥生成这个角色此刻的一身穿搭（OOTD），越贴合TA的人设/生活场景越好。${antiRepeat}\n\n` +
        `生成：\n` +
        `- style：风格标签（如"休闲"、"通勤"、"运动"，2-4 字）\n` +
        `- colors：这身搭配的主色调，1-3 个颜色词的数组\n` +
        `- tops：上衣的具体描述（如"杏色亚麻衬衫"）\n` +
        `- bottoms：下装的具体描述（如"米白亚麻裤"）\n` +
        `- shoes：鞋子的具体描述\n` +
        `- accessories：配饰，0-3 项的数组（可以是空数组）\n` +
        `- imagePrompt：给 AI 生图用的一段英文画面描述，统一走"站在穿衣镜前用手机自拍"这个路子——地点是全身镜前，手里举着手机在拍这身穿搭，构图半身或全身都行，视线不一定看镜头（可以低头看手机屏幕、侧脸、看别处），偶尔可以让举着的手机或手臂挡住部分脸，营造真实生活感的镜子自拍。但站姿、镜头远近、身体朝向、手机遮脸与否这些细节每次都要不一样，不要写成同一个姿势，不要出现角色的真实姓名\n\n` +
        `**JSON 字段类型硬约束**：只能返回下面这个形状的 JSON 对象，colors/accessories 必须是字符串数组，其余字段必须是字符串：\n` +
        `{ "style": "休闲", "colors": ["米白色", "杏色"], "tops": "杏色亚麻衬衫", "bottoms": "米白亚麻裤", "shoes": "小白鞋", "accessories": ["帆布包"], "imagePrompt": "a young woman in a beige linen shirt..." }`;
}

/** 把 AI 返回的松散 JSON 对象过滤/纠错成 TrajectoryOotdDraft；字段不完整（缺 imagePrompt 等）时返回 null。 */
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

/** draft + 生图结果的 image token 拼成一条可以直接存进 phoneState.trajectoryOotd 的记录。 */
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

/** 按「日」分组，组内新到旧；组间按日期新到旧——feed 视图直接吃这个结构。 */
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

/** Moments 生成结果里还没落成 TrajectoryMomentPost 的部分——多一个 imagePrompt 给生图管线用，不落库。 */
export interface TrajectoryMomentDraft {
    content: string;
    likes: number;
    comments: { authorName: string; content: string }[];
    imagePrompt: string;
}

/**
 * 「軌跡」Moments 分页的生成提示词——角色专属动态，自己发自己的，不读任何共享动态池。
 * 文字部分（正文 + 点赞数 + 几条点缀用评论）+ 一段给生图用的画面描述，图片由调用方另外
 * 拿 imagePrompt 去跑生图管线。roleSettingsBlock 同 Profile/OOTD，
 * 传 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })。
 */
export function buildTrajectoryMomentsPrompt(roleSettingsBlock: string, existing?: TrajectoryMomentPost[]): string {
    let antiRepeat = '';
    if (existing && existing.length) {
        const recent = existing.slice(0, 5).map(p => p.content.slice(0, 20));
        antiRepeat = `\n\n最近发过这些内容了，这次换个不一样的场景/心情：${recent.join('、')}`;
    }
    return `依照上面这份角色设定，自由发挥生成这个角色此刻发的一条朋友圈动态，越贴合TA的人设/生活场景越好，` +
        `第一人称语气，像真的在发朋友圈。${antiRepeat}\n\n` +
        `生成：\n` +
        `- content：动态正文（1-3 句话，口语化，可以带点情绪/心情）\n` +
        `- likes：这条动态收到的点赞数，10-500 之间的整数，符合这条内容的分量\n` +
        `- comments：0-3 条别人（陌生网友/路人）的评论，每条给 authorName（随意起的网名）和 content（简短评论）\n` +
        `- imagePrompt：给 AI 生图用的一段英文画面描述，描述这条动态配的照片长什么样（呼应正文内容），不要出现角色的真实姓名\n\n` +
        `**JSON 字段类型硬约束**：只能返回下面这个形状的 JSON 对象，comments 必须是对象数组，likes 必须是数字，其余字段必须是字符串：\n` +
        `{ "content": "今天天气正好，出来走走", "likes": 128, "comments": [{ "authorName": "路人甲", "content": "好美的天气！" }], "imagePrompt": "a sunny street scene..." }`;
}

/** 把 AI 返回的松散 JSON 对象过滤/纠错成 TrajectoryMomentDraft；字段不完整（缺 content/imagePrompt 等）时返回 null。 */
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

/** draft + 生图结果的 image token 拼成一条可以直接存进 phoneState.trajectoryMoments 的记录。 */
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
 * Journey 行程叙事的生成提示词——纯第三人称叙事，不含用户/玩家、不写成对话脚本。
 * roleSettingsBlock 同 Profile/OOTD，传 ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true })。
 * 输出直接是叙事正文（不是 JSON），调用方拿 extractContent(data).trim() 就是 story。
 */
export function buildTrajectoryJourneyPrompt(
    roleSettingsBlock: string,
    input: { kind: '日常' | '事件'; time: string; location: string; participants: { name: string; description: string }[]; detail?: string },
): string {
    const participantLines = input.participants.length
        ? input.participants.map(p => `- ${p.name}${p.description ? `：${p.description}` : ''}`).join('\n')
        : '（没有指定见面对象，就写TA独自经历的一段）';
    return `依照上面这份角色设定，写一段第三人称的短篇叙事——这是TA手机「軌跡」App 里的一段私人行程，` +
        `記錄的是TA自己的生活，不是跟用户的互动，正文里绝对不能出现用户/玩家，也不要写成对话脚本或问答，` +
        `就是一段完整流畅的叙事文字。\n\n` +
        `- 类型：${input.kind}\n` +
        `- 时间：${input.time || '（未指定，自行安排）'}\n` +
        `- 地点/场景：${input.location || '（未指定，自行安排）'}\n` +
        `- 见面对象：\n${participantLines}\n` +
        `${input.detail?.trim() ? `- 补充细节：${input.detail.trim()}\n` : ''}\n` +
        `直接输出这段叙事正文本身，300-500 字左右，不要标题、不要 markdown 标记、不要任何额外说明或前后缀。`;
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
