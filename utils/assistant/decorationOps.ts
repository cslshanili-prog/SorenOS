/**
 * Sore 改聊天裝扮（plans/decoration-app.md 第 7 節）：讀模板、出「改裝扮」提案、套用／還原。
 * 寫的路跟裝扮 App 同一套（utils/decorationTemplates.ts 的 patch、templateBindings 寫穿），這裡只多一層：
 * 操作清單 → 草稿 → 卡片上一行一行的改動；套用前留快照，還原寫回去。
 */
import { peopleByAlias } from '../personMatch';
import type { AssistantDecorationProposal, CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import { LAYOUT_DEFAULTS, pickDecorationLayout } from '../chatDecoration';
import {
    CHARACTER_DECORATION_RESET, GROUP_DECORATION_RESET, characterPatchFromDraft, describeDraft, draftOfTemplate,
    groupIgnoredParts, groupPatchFromDraft, makeTemplate, templateBindings, templateFromCharacter, templateFromGroup,
    templateFromTheme, themePatchFromDraft,
    type ChatBackgroundStyle, type DecorationDraft, type DecorationTargetRef, type DecorationTemplate,
} from '../decorationTemplates';
import { BUILTIN_SOUNDS, stripWhiteboxSoundDirective } from '../whiteboxSound';
import { LAYOUT_FIELD_LABELS } from './decorationRead';
import { findCssLocation, validateLocationCss } from './cssLocations';

export interface DecorationData {
    theme: OSTheme;
    characters: CharacterProfile[];
    groups: GroupProfile[];
    customThemes: ChatTheme[];
    templates: DecorationTemplate[];
}

type DraftProposal = Omit<AssistantDecorationProposal, 'id' | 'status'>;

const BG_STYLES: ChatBackgroundStyle[] = ['plain', 'grid', 'paper', 'mesh'];
const BG_LABEL: Record<ChatBackgroundStyle, string> = { plain: '純色', grid: '網格', paper: '紙張', mesh: '柔光' };
const LAYOUT_KEYS = Object.keys(LAYOUT_DEFAULTS);
const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字）` : s);
const lines = (css?: string) => (css?.trim() ? css.trim().split('\n').length : 0);

const allBubbles = (data: DecorationData) => [...Object.values(PRESET_THEMES), ...data.customThemes];
const bubbleName = (data: DecorationData) => (id: string) => allBubbles(data).find(b => b.id === id)?.name || `${id}（找不到）`;
const visibleChars = (data: DecorationData) => data.characters.filter(c => !c.altOf);

const findTemplate = (raw: unknown, data: DecorationData): DecorationTemplate | { error: string } => {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) return { error: '沒說是哪份模板。' };
    const hits = data.templates.filter(t => t.id === key || t.name === key);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { error: `「${key}」有好幾份同名的，改用 id：${hits.map(t => t.id).join('、')}` };
    return { error: `找不到模板「${key}」。現有：${data.templates.map(t => t.name).join('、') || '沒有'}` };
};

const resolveTarget = (raw: unknown, data: DecorationData): { target: DecorationTargetRef; label: string } | { error: string } => {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) return { error: '沒說是哪個聊天。' };
    if (/^(全局|全域|global|全局默認)$/i.test(key)) return { target: { kind: 'global' }, label: '全局默認' };
    const named = visibleChars(data).filter(c => c.id === key || c.name === key);
    const groups = data.groups.filter(g => g.id === key || g.name === key);
    // id、名字都沒有：再照角色的別名找（好幾位撞在一起照樣列出來要對方用 id）
    const chars = named.length || groups.length ? named : peopleByAlias(key, visibleChars(data));
    if (chars.length + groups.length > 1) return { error: `「${key}」有好幾個同名的，改用 id：${[...chars, ...groups].map(x => `${x.name}=${x.id}`).join('、')}` };
    if (chars[0]) return { target: { kind: 'character', id: chars[0].id }, label: chars[0].name };
    if (groups[0]) return { target: { kind: 'group', id: groups[0].id }, label: `群「${groups[0].name}」` };
    return { error: `找不到「${key}」。角色：${visibleChars(data).map(c => c.name).join('、') || '沒有'}；群：${data.groups.map(g => g.name).join('、') || '沒有'}` };
};

const currentDraftOf = (target: DecorationTargetRef, data: DecorationData): DecorationDraft => {
    if (target.kind === 'global') return templateFromTheme(data.theme);
    if (target.kind === 'character') return templateFromCharacter(data.characters.find(c => c.id === target.id)!, data.theme);
    return templateFromGroup(data.groups.find(g => g.id === target.id)!);
};

const currentTemplateIdOf = (target: DecorationTargetRef, data: DecorationData): string | undefined => {
    if (target.kind === 'global') return data.theme.decorationTemplateId;
    if (target.kind === 'character') return data.characters.find(c => c.id === target.id)?.decorationTemplateId;
    return data.groups.find(g => g.id === target.id)?.decorationTemplateId;
};

const targetName = (target: DecorationTargetRef, data: DecorationData) => (target.kind === 'global' ? '全局默認'
    : target.kind === 'character' ? (data.characters.find(c => c.id === target.id)?.name || '角色') : `群「${data.groups.find(g => g.id === target.id)?.name || ''}」`);

// ─── 讀 ───

const describeTemplateFull = (t: DecorationTemplate, data: DecorationData): string => {
    const usage = templateBindings(t.id, data);
    return [
        `# 模板「${t.name}」（id=${t.id}）`,
        `誰在用：${usage.length ? usage.map(u => targetName(u, data)).join('、') : '沒有'}`,
        `氣泡：${t.bubbleThemeId ? bubbleName(data)(t.bubbleThemeId) : '跟著全局'}`,
        `背景：${t.background ? `${t.background.image ? '有一張圖' : '沒有圖'}，底紋 ${t.background.style}` : '跟著全局'}`,
        `提示音：${t.sound ? (t.sound.src === 'none' ? '靜音' : `${BUILTIN_SOUNDS[t.sound.src]?.label || t.sound.src}，音量 ${Math.round((t.sound.volume ?? 0.6) * 100)}%`) : '跟著全局'}`,
        `佈局：${t.layout ? '' : '跟著全局'}`,
        ...(t.layout ? LAYOUT_KEYS.map(k => `- ${k}（${LAYOUT_FIELD_LABELS[k] || k}）= ${JSON.stringify((t.layout as Record<string, unknown>)[k] ?? (LAYOUT_DEFAULTS as Record<string, unknown>)[k])}`) : []),
        `白框 CSS：${t.css === undefined ? '跟著全局' : `${lines(t.css)} 行${t.cssStacksOnGlobal ? '（疊在全局上）' : '（取代全局）'}`}`,
        ...(t.css?.trim() ? ['```css', t.css, '```'] : []),
    ].join('\n');
};

export const describeDecorationTemplates = (template: unknown, data: DecorationData): { ok: boolean; content: string } => {
    if (template === undefined || template === '') {
        if (!data.templates.length) return { ok: true, content: '還沒有模板。可以用「改裝扮」新建（template 給新名字、create: true）。' };
        return {
            ok: true,
            content: [
                '裝扮模板：',
                ...data.templates.map(t => `- ${t.name}（id=${t.id}）：${describeDraft(t, bubbleName(data))}；${templateBindings(t.id, data).length} 個聊天在用`),
                '要看一份的全部內容（佈局每一項、CSS 全文）：給 template。',
            ].join('\n'),
        };
    }
    const found = findTemplate(template, data);
    if ('error' in found) return { ok: false, content: found.error };
    return { ok: true, content: describeTemplateFull(found, data) };
};

// ─── 操作 → 草稿 ───

type Op = Record<string, unknown> & { op?: string };

export const DECORATION_OPS_USAGE = `ops 每個是一個物件：
- {"op":"layout","set":{"chatAvatarShape":"square","chatBubbleFontSize":15}}：改佈局（欄位和能填的值看「讀取聊天裝扮」）；{"op":"layout_follow"}＝佈局跟著全局
- {"op":"bubble","bubble":"氣泡主題名或 id"}；{"op":"bubble_follow"}
- {"op":"background","style":"plain|grid|paper|mesh"}（底紋；你給不了圖片）；{"op":"background_no_image"}＝拿掉背景圖；{"op":"background_follow"}
- {"op":"sound","src":"chime|ding|pop|crystal|heart|retro|none","volume":0.6}；{"op":"sound_follow"}
- {"op":"css","css":"整段白框 CSS"}（只給模板；某個聊天的 CSS 用「寫CSS」）；{"op":"css_stack","stack":true}＝疊在全局 CSS 上；{"op":"css_follow"}
- {"op":"rename","name":"新名字"}（只給模板）
- 只給聊天：{"op":"use_template","template":"模板名"}＝換上這份；{"op":"follow"}＝跟著全局。這兩個要單獨一張卡片。`;

const layoutLabel = (k: string) => LAYOUT_FIELD_LABELS[k] || k;

/** 把操作套到草稿上；回改動說明或錯誤 */
const applyOps = (
    start: DecorationDraft,
    ops: Op[],
    ctx: { data: DecorationData; isTemplate: boolean; isGlobal: boolean; isGroup: boolean },
): { draft: DecorationDraft; name?: string; changes: AssistantDecorationProposal['changes'] } | { errors: string[] } => {
    const draft: DecorationDraft = structuredClone(start);
    const changes: AssistantDecorationProposal['changes'] = [];
    const errors: string[] = [];
    let name: string | undefined;
    const bName = bubbleName(ctx.data);
    const noFollow = (what: string) => ctx.isGlobal && errors.push(`全局沒有「跟著全局」，${what}要給一個值`);
    for (const [i, op] of ops.entries()) {
        const where = `第 ${i + 1} 個`;
        switch (op.op) {
            case 'layout': {
                if (ctx.isGroup) { errors.push(`${where}：群沒有自己的佈局（跟著全局）`); break; }
                const set = op.set && typeof op.set === 'object' ? op.set as Record<string, unknown> : null;
                if (!set || !Object.keys(set).length) { errors.push(`${where}：layout 要給 set`); break; }
                const unknown = Object.keys(set).filter(k => !LAYOUT_KEYS.includes(k));
                if (unknown.length) { errors.push(`${where}：沒有這些佈局欄位：${unknown.join('、')}`); break; }
                const base = draft.layout || pickDecorationLayout({ ...LAYOUT_DEFAULTS, ...Object.fromEntries(LAYOUT_KEYS.map(k => [k, (ctx.data.theme as unknown as Record<string, unknown>)[k]]).filter(([, v]) => v !== undefined)) });
                try {
                    const next = pickDecorationLayout({ ...LAYOUT_DEFAULTS, ...base, ...set });
                    for (const k of Object.keys(set)) {
                        const before = (base as Record<string, unknown>)[k];
                        changes.push({ label: `佈局 · ${layoutLabel(k)}：${JSON.stringify(before)} → ${JSON.stringify((next as Record<string, unknown>)[k])}` });
                    }
                    draft.layout = next;
                } catch (e: any) { errors.push(`${where}：${e?.message || '佈局值不對'}`); }
                break;
            }
            case 'layout_follow':
                if (ctx.isGlobal) { noFollow('佈局'); break; }
                if (draft.layout) changes.push({ label: '佈局：改成跟著全局' });
                delete draft.layout;
                break;
            case 'bubble': {
                const key = typeof op.bubble === 'string' ? op.bubble.trim() : '';
                const hits = allBubbles(ctx.data).filter(b => b.id === key || b.name === key);
                if (hits.length !== 1) { errors.push(`${where}：${hits.length ? `「${key}」有好幾套同名的，改用 id` : `找不到氣泡主題「${key}」，現有：${allBubbles(ctx.data).map(b => b.name).join('、')}`}`); break; }
                changes.push({ label: `氣泡：${draft.bubbleThemeId ? bName(draft.bubbleThemeId) : '跟著全局'} → ${hits[0].name}` });
                draft.bubbleThemeId = hits[0].id;
                break;
            }
            case 'bubble_follow':
                if (ctx.isGlobal) { changes.push({ label: '氣泡：改回預設' }); delete draft.bubbleThemeId; break; }
                if (draft.bubbleThemeId) changes.push({ label: `氣泡：${bName(draft.bubbleThemeId)} → ${ctx.isGroup ? '原本的紫色' : '跟著全局'}` });
                delete draft.bubbleThemeId;
                break;
            case 'background': {
                if (ctx.isGroup) { errors.push(`${where}：群沒有自己的背景（跟著全局）`); break; }
                const style = op.style as ChatBackgroundStyle;
                if (!BG_STYLES.includes(style)) { errors.push(`${where}：style 只能是 ${BG_STYLES.join('／')}`); break; }
                changes.push({ label: `背景底紋：${draft.background ? BG_LABEL[draft.background.style] : '跟著全局'} → ${BG_LABEL[style]}` });
                draft.background = { image: draft.background?.image ?? null, style };
                break;
            }
            case 'background_no_image':
                if (ctx.isGroup) { errors.push(`${where}：群沒有自己的背景`); break; }
                changes.push({ label: '背景：拿掉背景圖（只用底紋）' });
                draft.background = { image: null, style: draft.background?.style || 'plain' };
                break;
            case 'background_follow':
                if (ctx.isGlobal) { noFollow('背景'); break; }
                if (draft.background) changes.push({ label: '背景：改成跟著全局' });
                delete draft.background;
                break;
            case 'sound': {
                const src = typeof op.src === 'string' ? op.src.trim() : '';
                if (src !== 'none' && !BUILTIN_SOUNDS[src]) { errors.push(`${where}：提示音只能用內建的 ${Object.keys(BUILTIN_SOUNDS).join('／')} 或 none（自己的音檔請用戶到裝扮 App 上傳）`); break; }
                const volume = typeof op.volume === 'number' ? Math.min(1, Math.max(0, op.volume)) : draft.sound?.volume ?? 0.6;
                changes.push({ label: `提示音：${draft.sound ? (draft.sound.src === 'none' ? '靜音' : BUILTIN_SOUNDS[draft.sound.src]?.label || '自己的音檔') : '跟著全局'} → ${src === 'none' ? '靜音' : `${BUILTIN_SOUNDS[src].label}（${Math.round(volume * 100)}%）`}` });
                draft.sound = { src, volume };
                break;
            }
            case 'sound_follow':
                if (draft.sound) changes.push({ label: ctx.isGlobal ? '提示音：拿掉' : '提示音：改成跟著全局' });
                delete draft.sound;
                break;
            case 'css': {
                if (!ctx.isTemplate) { errors.push(`${where}：某個聊天的 CSS 請用「寫CSS」`); break; }
                const css = typeof op.css === 'string' ? stripWhiteboxSoundDirective(op.css) : '';
                const problems = validateLocationCss(findCssLocation('chat_chrome_char')!, css);
                if (problems.length) { errors.push(`${where}：CSS 有問題：${problems.slice(0, 4).join('；')}`); break; }
                changes.push({ label: `白框 CSS：${draft.css === undefined ? '跟著全局' : `${lines(draft.css)} 行`} → ${lines(css)} 行`, before: draft.css === undefined ? undefined : clip(draft.css), after: clip(css) });
                draft.css = css;
                break;
            }
            case 'css_stack':
                if (draft.css === undefined) { errors.push(`${where}：這份沒有自己的 CSS，不用設疊不疊`); break; }
                draft.cssStacksOnGlobal = op.stack === true || undefined;
                changes.push({ label: `白框 CSS：${op.stack === true ? '疊在全局 CSS 上' : '取代全局 CSS'}` });
                break;
            case 'css_follow':
                if (!ctx.isTemplate) { errors.push(`${where}：某個聊天的 CSS 請用「清除CSS」`); break; }
                if (draft.css !== undefined) changes.push({ label: '白框 CSS：改成跟著全局', before: clip(draft.css || '') });
                delete draft.css; delete draft.cssStacksOnGlobal;
                break;
            case 'rename': {
                if (!ctx.isTemplate) { errors.push(`${where}：只有模板能改名`); break; }
                const n = typeof op.name === 'string' ? op.name.trim().slice(0, 60) : '';
                if (!n) { errors.push(`${where}：name 是空的`); break; }
                name = n;
                changes.push({ label: `名字 → ${n}` });
                break;
            }
            default:
                errors.push(`${where}：不認識的 op「${String(op.op)}」`);
        }
    }
    if (errors.length) return { errors };
    if (!changes.length) return { errors: ['什麼都沒改到'] };
    return { draft, name, changes };
};

/**
 * 「改裝扮」：args.template（模板名／id；create 給 true 就是新建，from 可以拿某個聊天現在的樣子當起點）
 * 或 args.target（角色名／群名／全局），二選一。
 */
export const buildDecorationProposal = (args: Record<string, unknown>, data: DecorationData): { draft: DraftProposal } | { errors: string[] } => {
    const ops = Array.isArray(args.ops) ? args.ops as Op[] : [];
    const summary = typeof args.summary === 'string' ? args.summary.slice(0, 120) : undefined;
    const hasTemplate = typeof args.template === 'string' && args.template.trim();
    const hasTarget = typeof args.target === 'string' && args.target.trim();
    if (!!hasTemplate === !!hasTarget) return { errors: ['template 和 target 給一個就好（改模板給 template，改某個聊天給 target）'] };
    if (!ops.length) return { errors: ['ops 是空的'] };

    if (hasTemplate) {
        const create = args.create === true;
        let base: DecorationTemplate;
        let isNew = false;
        if (create) {
            const name = String(args.template).trim().slice(0, 60);
            if (data.templates.some(t => t.name === name)) return { errors: [`已經有一份叫「${name}」的模板，改它就不用 create`] };
            let start: DecorationDraft = {};
            if (typeof args.from === 'string' && args.from.trim()) {
                const from = resolveTarget(args.from, data);
                if ('error' in from) return { errors: [from.error] };
                start = currentDraftOf(from.target, data);
            }
            base = makeTemplate(name, start);
            isNew = true;
        } else {
            const found = findTemplate(args.template, data);
            if ('error' in found) return { errors: [found.error] };
            base = found;
        }
        const res = applyOps(draftOfTemplate(base), ops, { data, isTemplate: true, isGlobal: false, isGroup: false });
        if ('errors' in res) return res;
        const template: DecorationTemplate = { ...res.draft, id: base.id, name: res.name || base.name, createdAt: base.createdAt, updatedAt: base.updatedAt };
        const usage = isNew ? [] : templateBindings(base.id, data).map(t => targetName(t, data));
        return {
            draft: {
                kind: 'decoration', targetLabel: `裝扮模板 · ${template.name}${isNew ? '（新的）' : ''}`, summary,
                subject: { kind: 'template', templateId: base.id, isNew }, template,
                changes: isNew ? [{ label: `新建模板：${describeDraft(template, bubbleName(data))}` }, ...res.changes] : res.changes,
                usage,
            },
        };
    }

    const resolved = resolveTarget(args.target, data);
    if ('error' in resolved) return { errors: [resolved.error] };
    const { target, label } = resolved;
    const isGlobal = target.kind === 'global';
    const isGroup = target.kind === 'group';
    const currentTpl = currentTemplateIdOf(target, data);
    const currentTplName = currentTpl ? data.templates.find(t => t.id === currentTpl)?.name : undefined;
    const special = ops.find(o => o.op === 'use_template' || o.op === 'follow');
    if (special) {
        if (ops.length > 1) return { errors: ['use_template／follow 要單獨一張卡片'] };
        if (special.op === 'follow') {
            if (isGlobal) return { errors: ['全局沒有「跟著全局」'] };
            return {
                draft: {
                    kind: 'decoration', targetLabel: `聊天裝扮 · ${label}`, summary, subject: { kind: 'target', target }, useTemplateId: null,
                    changes: [{ label: `${currentTplName ? `模板「${currentTplName}」` : '自己的設定'} → 跟著全局（這個聊天自己的裝扮會清掉）` }],
                },
            };
        }
        const tpl = findTemplate(special.template, data);
        if ('error' in tpl) return { errors: [tpl.error] };
        const ignored = isGroup ? groupIgnoredParts(tpl) : [];
        return {
            draft: {
                kind: 'decoration', targetLabel: `聊天裝扮 · ${label}`, summary, subject: { kind: 'target', target }, useTemplateId: tpl.id,
                changes: [
                    { label: `${currentTplName ? `模板「${currentTplName}」` : '自己的設定'} → 模板「${tpl.name}」（${describeDraft(tpl, bubbleName(data))}）` },
                    ...(ignored.length ? [{ label: `群用不到：${ignored.join('、')}` }] : []),
                ],
            },
        };
    }
    const res = applyOps(currentDraftOf(target, data), ops, { data, isTemplate: false, isGlobal, isGroup });
    if ('errors' in res) return res;
    return {
        draft: {
            kind: 'decoration', targetLabel: `聊天裝扮 · ${label}`, summary, subject: { kind: 'target', target }, draft: res.draft,
            changes: [
                ...res.changes,
                ...(currentTplName ? [{ label: `這個聊天會從模板「${currentTplName}」變成自訂（之後改模板不會跟著變）` }] : []),
            ],
        },
    };
};

// ─── 套用、還原 ───

export interface DecorationWriter {
    saveTemplates: (templates: DecorationTemplate[]) => Promise<void> | void;
    /** 寫某個聊天（角色的 line 要照線寫） */
    writeTarget: (target: DecorationTargetRef, patch: Partial<OSTheme> & Partial<CharacterProfile> & Partial<GroupProfile>) => Promise<void> | void;
}

const patchFor = (target: DecorationTargetRef, draft: DecorationDraft, templateId?: string) => (target.kind === 'global'
    ? themePatchFromDraft(draft, templateId)
    : target.kind === 'character' ? characterPatchFromDraft(draft, templateId) : groupPatchFromDraft(draft, templateId));

const followPatch = (target: DecorationTargetRef) => (target.kind === 'group'
    ? { ...GROUP_DECORATION_RESET, decorationTemplateId: undefined }
    : { ...CHARACTER_DECORATION_RESET, decorationTemplateId: undefined });

const targetExists = (target: DecorationTargetRef, data: DecorationData) => target.kind === 'global'
    || (target.kind === 'character' ? data.characters.some(c => c.id === target.id) : data.groups.some(g => g.id === target.id));

const writeThrough = async (template: DecorationTemplate, data: DecorationData, writer: DecorationWriter) => {
    for (const t of templateBindings(template.id, data)) await writer.writeTarget(t, patchFor(t, template, template.id));
};

export const applyDecorationProposal = async (proposal: AssistantDecorationProposal, data: DecorationData, writer: DecorationWriter): Promise<AssistantDecorationProposal> => {
    const now = Date.now();
    const subject = proposal.subject;
    if (subject.kind === 'template') {
        const existing = data.templates.find(t => t.id === subject.templateId);
        if (subject.isNew && existing) throw new Error('這份模板已經建過了');
        if (!subject.isNew && !existing) throw new Error('這份模板已經不在了');
        const template = { ...proposal.template!, updatedAt: now };
        await writer.saveTemplates(existing ? data.templates.map(t => (t.id === template.id ? template : t)) : [...data.templates, template]);
        if (existing) await writeThrough(template, data, writer);
        return { ...proposal, status: 'applied', appliedAt: now, snapshot: { template: existing ? structuredClone(existing) : null, at: now } };
    }
    const target = subject.target;
    if (!targetExists(target, data)) throw new Error('這個聊天已經不在了');
    const snapshot = { target: { templateId: currentTemplateIdOf(target, data), draft: currentDraftOf(target, data) }, at: now };
    if (proposal.useTemplateId === null) await writer.writeTarget(target, followPatch(target));
    else if (proposal.useTemplateId) {
        const tpl = data.templates.find(t => t.id === proposal.useTemplateId);
        if (!tpl) throw new Error('要換上的模板已經不在了');
        await writer.writeTarget(target, patchFor(target, tpl, tpl.id));
    } else await writer.writeTarget(target, patchFor(target, proposal.draft!));
    return { ...proposal, status: 'applied', appliedAt: now, snapshot };
};

export const decorationChangedSinceApply = (proposal: AssistantDecorationProposal, data: DecorationData): boolean => {
    if (proposal.status !== 'applied' || !proposal.appliedAt) return false;
    if (proposal.subject.kind === 'template') {
        const t = data.templates.find(x => x.id === (proposal.subject as { templateId: string }).templateId);
        return !t || t.updatedAt > proposal.appliedAt + 2000;
    }
    return false;
};

export const restoreDecorationProposal = async (proposal: AssistantDecorationProposal, data: DecorationData, writer: DecorationWriter): Promise<AssistantDecorationProposal> => {
    const snapshot = proposal.snapshot;
    if (!snapshot) throw new Error('這張卡片沒有快照，沒辦法還原');
    const subject = proposal.subject;
    if (subject.kind === 'template') {
        if (snapshot.template === null) {
            // 新建的：拿掉，誰後來用了它就留著樣子變自訂
            for (const t of templateBindings(subject.templateId, data)) await writer.writeTarget(t, { decorationTemplateId: undefined });
            await writer.saveTemplates(data.templates.filter(t => t.id !== subject.templateId));
        } else if (snapshot.template) {
            const before = { ...snapshot.template, updatedAt: Date.now() };
            await writer.saveTemplates(data.templates.some(t => t.id === before.id) ? data.templates.map(t => (t.id === before.id ? before : t)) : [...data.templates, before]);
            await writeThrough(before, data, writer);
        }
        return { ...proposal, status: 'restored' };
    }
    const target = subject.target;
    if (!targetExists(target, data)) throw new Error('這個聊天已經不在了');
    const prev = snapshot.target!;
    const tpl = prev.templateId ? data.templates.find(t => t.id === prev.templateId) : undefined;
    await writer.writeTarget(target, tpl ? patchFor(target, tpl, tpl.id) : patchFor(target, prev.draft));
    return { ...proposal, status: 'restored' };
};

// ─── 預覽：套用之後的樣子 ───

export const decorationPreviewSim = (proposal: AssistantDecorationProposal, data: DecorationData, which: 'after' | 'before'): { simTheme: OSTheme; simChar: CharacterProfile } | null => {
    const dummy = { ...(visibleChars(data)[0] || ({ id: 'decoration-preview', name: '角色', avatar: '' } as CharacterProfile)), ...CHARACTER_DECORATION_RESET, decorationTemplateId: undefined } as CharacterProfile;
    const subject = proposal.subject;
    if (subject.kind === 'template') {
        const t = which === 'after' ? proposal.template! : data.templates.find(x => x.id === subject.templateId);
        if (!t) return null;
        return { simTheme: data.theme, simChar: { ...dummy, ...characterPatchFromDraft(t, t.id) } };
    }
    const target = subject.target;
    let draft: DecorationDraft;
    if (which === 'before') draft = currentDraftOf(target, data);
    else if (proposal.useTemplateId === null) draft = {};
    else if (proposal.useTemplateId) draft = data.templates.find(t => t.id === proposal.useTemplateId) || {};
    else draft = proposal.draft!;
    if (target.kind === 'global') return { simTheme: { ...data.theme, ...themePatchFromDraft(draft) }, simChar: dummy };
    if (target.kind === 'group') return { simTheme: data.theme, simChar: { ...dummy, ...characterPatchFromDraft({ css: draft.css, cssStacksOnGlobal: true, bubbleThemeId: draft.bubbleThemeId, sound: draft.sound }) } };
    const real = data.characters.find(c => c.id === target.id);
    return { simTheme: data.theme, simChar: { ...(real || dummy), ...characterPatchFromDraft(draft) } };
};

