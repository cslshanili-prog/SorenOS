import { CharacterTrajectoryProfile, TrajectoryArchiveDoc, TrajectoryChecklistItem, TrajectoryObjective } from '../types';

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
