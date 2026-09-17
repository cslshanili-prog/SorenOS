import { CharacterProfile, CharacterTrajectoryProfile, SocialPost, TrajectoryArchiveDoc, TrajectoryChecklistItem, TrajectoryObjective, TrajectoryOotdPost } from '../types';

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
        `- imagePrompt：给 AI 生图用的一段英文画面描述，描述这个人此刻穿着这身搭配的样子（半身或全身、场景可以简单带一句），不要出现角色的真实姓名\n\n` +
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

/**
 * 「軌跡」Moments 分页的可见性判断——这支手机是 char 的，只应该看到 TA 认识的人发的动态：
 * 用户本人的贴文、char 自己发的贴文、陌生人（公开网络路人）贴文，一律可见；
 * 另一个角色的贴文，只有 char 的查手机联系人里存在一条指向那个角色、状态为 friend 的记录才可见。
 * 没有 authorType 的旧数据（迁移前）不管按 user 还是 stranger 解读都可见，直接放行。
 */
export function filterMomentsVisibleToChar(posts: SocialPost[], char: Pick<CharacterProfile, 'id' | 'phoneState'>): SocialPost[] {
    const friendCharIds = new Set(
        (char.phoneState?.contacts || [])
            .filter(c => c.kind === 'real' && c.status === 'friend' && c.linkedCharId)
            .map(c => c.linkedCharId as string),
    );
    return posts.filter(post => {
        // 没有 authorType 的旧数据，不管按 user 还是 stranger 解读都可见，直接放行
        if (!post.authorType || post.authorType === 'user' || post.authorType === 'stranger') return true;
        // character：自己发的必然可见；别的角色要先是这支手机通讯录里的 friend 才可见
        if (post.authorCharId === char.id) return true;
        return !!(post.authorCharId && friendCharIds.has(post.authorCharId));
    });
}
