/**
 * Sore 改預設（plans/ai-assistant.md 第 11 節，第 3 批）。純邏輯：找預設、誰在用、給 Sore 看的概況、
 * 把一串操作套到一份「副本」上（原本那份不動）、算出卡片上的改動清單；真的寫由畫面做。
 *
 * - 通用預設（meeting_presets，ST 格式）：資料佔位條目只能開關、排順序；其他條目能改、加、刪、排；正則照 ST 欄位。
 *   正則現在只在見面生效（Liora 定的），Sore 寫正則時要講清楚。
 * - 劇情專用預設（story_theater_presets）：引擎靠條目 id 跑，只能改既有條目的內容和開關、生成參數、預填。
 * - 「內建」不是存著的一份：要改得用「新建預設」從內建複製。內建劇情預設同理。
 */
import type {
    AssistantPresetBinding, AssistantPresetProposal, CharacterProfile, GroupProfile,
    StoryTheaterEntry, StoryTheaterPreset, StoryTheaterPresetDocument,
} from '../../types';
import type { MeetingPresetDoc, MeetingPresetPrompt, MeetingPresetRecord, MeetingRegexScript } from '../meetingPreset/types';
import { BUILTIN_PRESET, PRESET_SCENE_LABEL, scenesOfPreset, type PresetScene } from '../presetBinding';
import { isPresetFeatureSlot, PRESET_FEATURE_OFF_WARNING, PRESET_SLOT_LABELS } from '../meetingPreset/slotLabels';
import { parseStRegex } from '../meetingPreset/regex';
import { buildBuiltinMeetingPresetDoc } from '../meetingPreset/builtin';
import { buildBuiltinChatPresetDoc } from '../chatPresetSession';
import { buildBuiltinCallPresetDoc } from '../callPresetSession';
import { buildBuiltinGroupPresetDoc } from '../groupPresetSession';
import { BUILTIN_NIGHT_SCREENING_PRESET, createBlankStoryPreset } from '../storyTheater';

export interface PresetData {
    general: MeetingPresetRecord[];
    /** 用戶自己的劇情預設（不含內建） */
    story: StoryTheaterPreset[];
    characters: Pick<CharacterProfile, 'id' | 'name' | 'altOf' | 'chatPresetId' | 'callPresetId' | 'dateMeetingPresetId'>[];
    groups: Pick<GroupProfile, 'id' | 'name' | 'presetId'>[];
    storyTheaters: Pick<StoryTheaterEntry, 'id' | 'title' | 'presetId'>[];
    sceneDefaults: Partial<Record<PresetScene, string>>;
}

export type FoundPreset =
    | { kind: 'general'; record: MeetingPresetRecord }
    | { kind: 'story'; preset: StoryTheaterPreset; builtIn: boolean };

const presetIdOf = (found: FoundPreset) => (found.kind === 'general' ? found.record.id : found.preset.id);
const presetNameOf = (found: FoundPreset) => (found.kind === 'general' ? found.record.name : found.preset.name);

/** id 或名字；名字重複就要用 id */
export const findPreset = (ref: unknown, data: PresetData): FoundPreset | { error: string } => {
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (!raw) return { error: '要指定是哪份預設（preset 填名字或 id）。' };
    const all: FoundPreset[] = [
        ...data.general.map(record => ({ kind: 'general' as const, record })),
        { kind: 'story', preset: BUILTIN_NIGHT_SCREENING_PRESET, builtIn: true },
        ...data.story.map(preset => ({ kind: 'story' as const, preset, builtIn: false })),
    ];
    const byId = all.find(p => presetIdOf(p) === raw);
    if (byId) return byId;
    const byName = all.filter(p => presetNameOf(p).trim() === raw);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return { error: `有 ${byName.length} 份叫「${raw}」，用 id 指定：${byName.map(presetIdOf).join('、')}` };
    if (/^內建|builtin/i.test(raw)) return { error: '內建不是存著的一份，不能直接改；要改用「新建預設」從內建複製一份。' };
    return { error: `找不到「${raw}」這份預設。用「列出預設」看有哪些。` };
};

/** 誰在用這份（場景預設、角色、群、劇情） */
export const presetUsage = (id: string, data: PresetData): string[] => {
    const out: string[] = [];
    (Object.keys(PRESET_SCENE_LABEL) as PresetScene[]).forEach(scene => {
        if (data.sceneDefaults[scene] === id) out.push(`${PRESET_SCENE_LABEL[scene]}場景預設`);
    });
    data.characters.filter(c => !c.altOf).forEach(c => {
        if (c.chatPresetId === id) out.push(`${c.name}的私聊`);
        if (c.callPresetId === id) out.push(`${c.name}的電話`);
        if (c.dateMeetingPresetId === id) out.push(`${c.name}的見面`);
    });
    data.groups.forEach(g => { if (g.presetId === id) out.push(`群「${g.name}」`); });
    data.storyTheaters.forEach(t => { if (t.presetId === id) out.push(`劇情「${t.title}」`); });
    return out;
};

// ─── 給 Sore 看的 ───

const len = (text?: string) => (text || '').trim().length;

export const describePresetList = (data: PresetData): string => {
    const lines: string[] = ['通用預設（ST 格式，私聊／群聊／電話／見面用）：'];
    if (!data.general.length) lines.push('（一份都沒有）');
    data.general.forEach(r => {
        const usage = presetUsage(r.id, data);
        lines.push(`- 「${r.name}」id=${r.id}｜適用：${scenesOfPreset(r).map(s => PRESET_SCENE_LABEL[s]).join('、')}｜條目 ${r.doc.prompts.length}、正則 ${r.doc.regexScripts.length}｜${usage.length ? `在用：${usage.join('、')}` : '沒人在用'}`);
    });
    lines.push('', '劇情專用預設（劇情劇場用，只能改既有條目的內容和開關）：');
    lines.push(`- 「${BUILTIN_NIGHT_SCREENING_PRESET.name}」id=${BUILTIN_NIGHT_SCREENING_PRESET.id}（內建，不能直接改，要用「新建預設」from=劇情內建 複製）`);
    data.story.forEach(p => {
        const usage = presetUsage(p.id, data);
        lines.push(`- 「${p.name}」id=${p.id}｜條目 ${p.document.prompts.length}｜${usage.length ? `在用：${usage.join('、')}` : '沒人在用'}`);
    });
    lines.push('', '內建（不是存著的一份，要改得先複製）：私聊內建、群聊內建、電話內建、見面內建、劇情內建。');
    const defaults = (Object.keys(PRESET_SCENE_LABEL) as PresetScene[]).map(scene => {
        const id = data.sceneDefaults[scene];
        const name = !id || id === BUILTIN_PRESET ? '內建' : data.general.find(r => r.id === id)?.name || data.story.find(p => p.id === id)?.name || (id === BUILTIN_NIGHT_SCREENING_PRESET.id ? '內建' : '（找不到）');
        return `${PRESET_SCENE_LABEL[scene]}：${name}`;
    });
    lines.push(`場景預設：${defaults.join('；')}`);
    return lines.join('\n');
};

const PLACEMENT_LABEL: Record<number, string> = { 1: '用戶輸入', 2: 'AI 輸出', 5: '世界書', 6: '思考' };

const describeRegex = (r: MeetingRegexScript, i: number) =>
    `${i + 1}. id=${r.id}「${r.scriptName}」${r.disabled ? '[關]' : '開'} · 改${r.placement.map(p => PLACEMENT_LABEL[p] || p).join('、') || '（沒選）'}${r.promptOnly ? ' · 只改送出' : ''}${r.markdownOnly ? ' · 只改顯示' : ''} · ${r.findRegex}`;

const describeGeneralPrompt = (p: MeetingPresetPrompt, i: number) => {
    const head = `${i + 1}. id=${p.id}「${p.name}」${p.enabled ? '' : '[關]'}`;
    if (p.slot && isPresetFeatureSlot(p.slot)) return `${head} Soren 功能（內容由程式產生，只能開關、排順序；關掉的話：${PRESET_FEATURE_OFF_WARNING[p.slot]}）`;
    if (p.slot) return `${head} 資料佔位 · ${PRESET_SLOT_LABELS[p.slot]}（只能開關、排順序）`;
    return `${head} ${p.role} · ${len(p.content)} 字${p.inChat ? ` · 插在聊天記錄倒數第 ${p.inChat.depth} 則` : ''}`;
};

const describeStoryPrompt = (p: StoryTheaterPresetDocument['prompts'][number], i: number) => {
    const head = `${i + 1}. id=${p.id}「${p.name}」${p.enabled ? '' : '[關]'}`;
    if (p.section) return `${head} 區塊${p.section.edge === 'start' ? '開頭' : '結尾'}：${p.section.name}`;
    if (p.marker) return `${head} 資料佔位 · ${p.marker}（只能開關）`;
    return `${head} ${p.role} · ${len(p.content)} 字`;
};

export const describePreset = (found: FoundPreset, data: PresetData): string => {
    if (found.kind === 'general') {
        const { record } = found;
        const doc = record.doc;
        const g = doc.generation;
        const usage = presetUsage(record.id, data);
        return [
            `# 「${record.name}」（通用預設，id=${record.id}）`,
            `適用場景：${scenesOfPreset(record).map(s => PRESET_SCENE_LABEL[s]).join('、')}；${usage.length ? `在用：${usage.join('、')}` : '沒人在用'}`,
            `生成參數：temperature ${g.temperature ?? '（沒設）'}、top_p ${g.topP ?? '（沒設）'}、top_k ${g.topK ?? '（沒設）'}、frequency ${g.frequencyPenalty ?? '（沒設）'}、presence ${g.presencePenalty ?? '（沒設）'}、max_tokens ${g.maxTokens ?? '（沒設）'}；預填：${doc.assistantPrefill?.trim() ? `${len(doc.assistantPrefill)} 字` : '沒有'}`,
            '條目（照送出順序，[關] 是關著的；要看全文用「讀取條目」）：',
            ...doc.prompts.map(describeGeneralPrompt),
            `正則（只在見面生效；照順序一條接一條跑）：${doc.regexScripts.length ? '' : '沒有'}`,
            ...doc.regexScripts.map(describeRegex),
        ].join('\n');
    }
    const { preset, builtIn } = found;
    const g = preset.document.generation;
    const usage = presetUsage(preset.id, data);
    return [
        `# 「${preset.name}」（劇情專用預設，id=${preset.id}${builtIn ? '，內建：不能直接改，要先複製' : ''}）`,
        usage.length ? `在用：${usage.join('、')}` : '沒人在用',
        `生成參數：temperature ${g.temperature}、top_p ${g.topP}、frequency ${g.frequencyPenalty}、presence ${g.presencePenalty}、max_tokens ${g.maxTokens}；預填：${preset.document.assistantPrefill?.trim() ? `${len(preset.document.assistantPrefill)} 字` : '沒有'}`,
        '條目（只能改內容和開關，不能加刪、不能改 id）：',
        ...preset.document.prompts.map(describeStoryPrompt),
    ].join('\n');
};

/** 一條的全文；regex=true 時 ref 是正則 */
export const describeEntry = (found: FoundPreset, ref: unknown, regex = false): { ok: boolean; content: string } => {
    if (regex) {
        if (found.kind !== 'general') return { ok: false, content: '劇情預設沒有正則。' };
        const script = findRegex(found.record.doc, ref);
        if ('error' in script) return { ok: false, content: script.error };
        return { ok: true, content: JSON.stringify(script.item, null, 2) };
    }
    const prompts = found.kind === 'general' ? found.record.doc.prompts : found.preset.document.prompts;
    const hit = findIn(prompts, ref, '條目');
    if ('error' in hit) return { ok: false, content: hit.error };
    const p = hit.item as MeetingPresetPrompt;
    if (found.kind === 'general' && p.slot) return { ok: true, content: `「${p.name}」是${isPresetFeatureSlot(p.slot) ? ' Soren 功能' : '資料佔位'}（${PRESET_SLOT_LABELS[p.slot]}），內容由 Soren 填，沒有文字可以看。` };
    return { ok: true, content: `「${p.name}」（id=${p.id}，${p.role}，${p.enabled ? '開' : '關'}）\n${p.content || '（空白）'}` };
};

// ─── 找條目、正則 ───

const findIn = <T extends { id: string; name?: string; scriptName?: string }>(items: T[], ref: unknown, what: string): { item: T; index: number } | { error: string } => {
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (!raw) return { error: `要指定是哪個${what}（填 id 或名字）。` };
    let index = items.findIndex(item => item.id === raw);
    if (index < 0) {
        const named = items.map((item, i) => ({ i, name: (item.name ?? item.scriptName ?? '').trim() })).filter(x => x.name === raw);
        if (named.length > 1) return { error: `有 ${named.length} 個${what}叫「${raw}」，用 id：${named.map(x => items[x.i].id).join('、')}` };
        index = named[0]?.i ?? -1;
    }
    if (index < 0) return { error: `找不到${what}「${raw}」。` };
    return { item: items[index], index };
};

const findRegex = (doc: MeetingPresetDoc, ref: unknown) => findIn(doc.regexScripts, ref, '正則');

// ─── 套用操作 ───

export interface PresetChange { label: string; before?: string; after?: string }
export interface OpsResult<D> { doc: D; changes: PresetChange[]; errors: string[] }

const ROLES = ['system', 'user', 'assistant'] as const;
const PLACEMENT_BY_NAME: Record<string, number> = { user: 1, 用戶: 1, 用戶輸入: 1, ai: 2, AI: 2, 'AI 輸出': 2, AI輸出: 2, worldinfo: 5, 世界書: 5, reasoning: 6, 思考: 6 };
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const newEntryId = () => `sore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const newRegexId = () => `sore_rx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const parsePlacement = (v: unknown): number[] | { error: string } | undefined => {
    if (v === undefined) return undefined;
    const list = Array.isArray(v) ? v : [v];
    const out: number[] = [];
    for (const item of list) {
        const n = typeof item === 'number' ? item : PLACEMENT_BY_NAME[String(item).trim()];
        if (![1, 2, 5, 6].includes(n)) return { error: `placement「${String(item)}」不認得，能用：user（用戶輸入）、ai（AI 輸出）、worldinfo、reasoning` };
        if (!out.includes(n)) out.push(n);
    }
    return out;
};

const applyGenerationOp = (generation: Record<string, number | undefined>, op: Record<string, unknown>, keys: string[], changes: PresetChange[], errors: string[]) => {
    const next = { ...generation };
    keys.forEach(key => {
        if (op[key] === undefined) return;
        const value = num(op[key]);
        if (value === undefined) { errors.push(`${key} 要是數字`); return; }
        if (next[key] !== value) changes.push({ label: `生成參數 ${key}：${next[key] ?? '（沒設）'} → ${value}` });
        next[key] = value;
    });
    return next;
};

/** 把 Sore 給的一串操作套到通用預設的副本上 */
export const applyGeneralOps = (input: MeetingPresetDoc, ops: unknown[]): OpsResult<MeetingPresetDoc> => {
    let doc: MeetingPresetDoc = JSON.parse(JSON.stringify(input));
    const changes: PresetChange[] = [];
    const errors: string[] = [];
    ops.forEach((raw, i) => {
        const op = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const where = `第 ${i + 1} 個操作（${String(op.op ?? '?')}）`;
        const fail = (msg: string) => errors.push(`${where}：${msg}`);
        switch (op.op) {
            case 'edit': {
                const hit = findIn(doc.prompts, op.entry, '條目');
                if ('error' in hit) return fail(hit.error);
                const p = { ...hit.item };
                if (p.slot && (op.content !== undefined || op.name !== undefined || op.role !== undefined)) {
                    return fail(`「${p.name}」是${isPresetFeatureSlot(p.slot) ? ' Soren 功能' : '資料佔位'}，只能開關、排順序，不能改內容、名字、角色`);
                }
                const content = str(op.content);
                if (content !== undefined && content !== p.content) { changes.push({ label: `改了「${p.name}」的內容（${len(p.content)} → ${len(content)} 字）`, before: p.content, after: content }); p.content = content; }
                const name = str(op.name)?.trim();
                if (name && name !== p.name) { changes.push({ label: `「${p.name}」改名成「${name}」` }); p.name = name; }
                const role = str(op.role);
                if (role !== undefined) {
                    if (!ROLES.includes(role as typeof ROLES[number])) return fail('role 只能是 system、user、assistant');
                    if (role !== p.role) { changes.push({ label: `「${p.name}」的角色 ${p.role} → ${role}` }); p.role = role as MeetingPresetPrompt['role']; }
                }
                const enabled = bool(op.enabled);
                if (enabled !== undefined && enabled !== p.enabled) {
                    changes.push({ label: `${enabled ? '打開' : '關掉'}「${p.name}」${!enabled && p.slot && isPresetFeatureSlot(p.slot) ? `（${PRESET_FEATURE_OFF_WARNING[p.slot]}）` : ''}` });
                    p.enabled = enabled;
                }
                doc = { ...doc, prompts: doc.prompts.map(x => (x.id === p.id ? p : x)) };
                return;
            }
            case 'add': {
                const name = str(op.name)?.trim();
                const content = str(op.content) ?? '';
                if (!name) return fail('新條目要有 name');
                const role = str(op.role) ?? 'system';
                if (!ROLES.includes(role as typeof ROLES[number])) return fail('role 只能是 system、user、assistant');
                const prompt: MeetingPresetPrompt = { id: newEntryId(), name, enabled: bool(op.enabled) ?? true, role: role as MeetingPresetPrompt['role'], content };
                const placed = placePrompt(doc, prompt, op.after, op.before);
                if ('error' in placed) return fail(placed.error);
                doc = placed.doc;
                changes.push({ label: `新增條目「${name}」（${len(content)} 字）`, after: content });
                return;
            }
            case 'remove': {
                const hit = findIn(doc.prompts, op.entry, '條目');
                if ('error' in hit) return fail(hit.error);
                if (hit.item.slot) return fail(`「${hit.item.name}」是資料佔位／Soren 功能，不能刪，只能關`);
                doc = {
                    ...doc,
                    prompts: doc.prompts.filter(p => p.id !== hit.item.id),
                    groups: doc.groups.map(g => ({ ...g, promptIds: g.promptIds.filter(id => id !== hit.item.id) })),
                };
                changes.push({ label: `刪掉條目「${hit.item.name}」`, before: hit.item.content });
                return;
            }
            case 'move': {
                const hit = findIn(doc.prompts, op.entry, '條目');
                if ('error' in hit) return fail(hit.error);
                const without: MeetingPresetDoc = {
                    ...doc,
                    prompts: doc.prompts.filter(p => p.id !== hit.item.id),
                    groups: doc.groups.map(g => ({ ...g, promptIds: g.promptIds.filter(id => id !== hit.item.id) })),
                };
                if (op.after === undefined && op.before === undefined) return fail('要給 after 或 before（移到哪個條目後面／前面）');
                const placed = placePrompt(without, hit.item, op.after, op.before);
                if ('error' in placed) return fail(placed.error);
                doc = placed.doc;
                changes.push({ label: `「${hit.item.name}」移到「${String(op.after ?? op.before)}」${op.after !== undefined ? '後面' : '前面'}` });
                return;
            }
            case 'params':
                doc = { ...doc, generation: applyGenerationOp(doc.generation as Record<string, number | undefined>, op, ['temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty', 'maxTokens'], changes, errors) };
                return;
            case 'rename': {
                const name = str(op.name)?.trim();
                if (!name) return fail('要有 name');
                if (name !== doc.name) { changes.push({ label: `預設改名：「${doc.name}」→「${name}」` }); doc = { ...doc, name }; }
                return;
            }
            case 'prefill': {
                const text = str(op.text) ?? '';
                if (text !== (doc.assistantPrefill || '')) { changes.push({ label: text ? '改了預填' : '拿掉預填', before: doc.assistantPrefill, after: text }); doc = { ...doc, assistantPrefill: text || undefined }; }
                return;
            }
            case 'scenes': {
                const scenes = Array.isArray(op.scenes) ? op.scenes.map(String) : [];
                const valid = scenes.filter(s => ['chat', 'group', 'call', 'date'].includes(s)) as NonNullable<MeetingPresetDoc['scenes']>;
                if (!valid.length || valid.length !== scenes.length) return fail('scenes 要是 chat、group、call、date 裡的幾個');
                changes.push({ label: `適用場景改成：${valid.map(s => PRESET_SCENE_LABEL[s]).join('、')}` });
                doc = { ...doc, scenes: valid };
                return;
            }
            case 'addRegex': {
                const built = buildRegex(op, undefined);
                if ('error' in built) return fail(built.error);
                doc = { ...doc, regexScripts: [...doc.regexScripts, built.script] };
                changes.push({ label: `新增正則「${built.script.scriptName}」：${built.script.findRegex} → ${built.script.replaceString || '（刪掉）'}` });
                return;
            }
            case 'editRegex': {
                const hit = findRegex(doc, op.regex);
                if ('error' in hit) return fail(hit.error);
                const built = buildRegex(op, hit.item);
                if ('error' in built) return fail(built.error);
                doc = { ...doc, regexScripts: doc.regexScripts.map(r => (r.id === hit.item.id ? built.script : r)) };
                changes.push({ label: `改了正則「${hit.item.scriptName}」`, before: JSON.stringify(regexEssence(hit.item), null, 1), after: JSON.stringify(regexEssence(built.script), null, 1) });
                return;
            }
            case 'removeRegex': {
                const hit = findRegex(doc, op.regex);
                if ('error' in hit) return fail(hit.error);
                doc = { ...doc, regexScripts: doc.regexScripts.filter(r => r.id !== hit.item.id) };
                changes.push({ label: `刪掉正則「${hit.item.scriptName}」` });
                return;
            }
            default:
                return fail('不認得這個 op。能用：edit、add、remove、move、params、rename、prefill、scenes、addRegex、editRegex、removeRegex');
        }
    });
    return { doc, changes, errors };
};

const regexEssence = (r: MeetingRegexScript) => ({ find: r.findRegex, replace: r.replaceString, placement: r.placement, disabled: r.disabled, promptOnly: r.promptOnly, markdownOnly: r.markdownOnly });

/** 從 op 組一條正則；base 有的話是改 */
const buildRegex = (op: Record<string, unknown>, base: MeetingRegexScript | undefined): { script: MeetingRegexScript } | { error: string } => {
    const find = str(op.find) ?? base?.findRegex;
    if (!find?.trim()) return { error: '正則要有 find（ST 寫法，例如 /\\*\\*(.+?)\\*\\*/g）' };
    if (!parseStRegex(find)) return { error: `find「${find}」不是能用的正則` };
    const placement = parsePlacement(op.placement);
    if (placement && 'error' in placement) return placement;
    const trim = op.trim === undefined ? base?.trimStrings ?? [] : (Array.isArray(op.trim) ? op.trim.map(String) : [String(op.trim)]);
    const name = str(op.name)?.trim() || base?.scriptName;
    if (!name) return { error: '新正則要有 name' };
    return {
        script: {
            id: base?.id ?? newRegexId(),
            scriptName: name,
            findRegex: find,
            replaceString: str(op.replace) ?? base?.replaceString ?? '',
            trimStrings: trim,
            placement: placement ?? base?.placement ?? [2],
            disabled: bool(op.disabled) ?? base?.disabled ?? false,
            markdownOnly: bool(op.displayOnly) ?? base?.markdownOnly ?? false,
            promptOnly: bool(op.promptOnly) ?? base?.promptOnly ?? false,
            runOnEdit: base?.runOnEdit ?? true,
            substituteRegex: base?.substituteRegex ?? 0,
            minDepth: op.minDepth === undefined ? base?.minDepth ?? null : num(op.minDepth) ?? null,
            maxDepth: op.maxDepth === undefined ? base?.maxDepth ?? null : num(op.maxDepth) ?? null,
        },
    };
};

/** 放條目：after／before 指定位置（跟著那條進同一個分組）；都沒給就放在聊天記錄前面 */
const placePrompt = (doc: MeetingPresetDoc, prompt: MeetingPresetPrompt, after: unknown, before: unknown): { doc: MeetingPresetDoc } | { error: string } => {
    let insertAt: number;
    let anchorId: string | undefined;
    if (after !== undefined || before !== undefined) {
        const hit = findIn(doc.prompts, after ?? before, '條目');
        if ('error' in hit) return hit;
        anchorId = hit.item.id;
        insertAt = after !== undefined ? hit.index + 1 : hit.index;
    } else {
        const chatIndex = doc.prompts.findIndex(p => p.slot === 'chatHistory');
        insertAt = chatIndex >= 0 ? chatIndex : doc.prompts.length;
    }
    const prompts = [...doc.prompts.slice(0, insertAt), prompt, ...doc.prompts.slice(insertAt)];
    const groups = anchorId
        ? doc.groups.map(g => {
            const at = g.promptIds.indexOf(anchorId!);
            if (at < 0) return g;
            const ids = [...g.promptIds];
            ids.splice(after !== undefined ? at + 1 : at, 0, prompt.id);
            return { ...g, promptIds: ids };
        })
        : doc.groups;
    return { doc: { ...doc, prompts, groups } };
};

/** 劇情預設：只能改既有條目的內容和開關、生成參數、預填、名字 */
export const applyStoryOps = (input: StoryTheaterPresetDocument, ops: unknown[]): OpsResult<StoryTheaterPresetDocument> => {
    let doc: StoryTheaterPresetDocument = JSON.parse(JSON.stringify(input));
    const changes: PresetChange[] = [];
    const errors: string[] = [];
    ops.forEach((raw, i) => {
        const op = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const fail = (msg: string) => errors.push(`第 ${i + 1} 個操作（${String(op.op ?? '?')}）：${msg}`);
        switch (op.op) {
            case 'edit': {
                const hit = findIn(doc.prompts, op.entry, '條目');
                if ('error' in hit) return fail(hit.error);
                const p = { ...hit.item };
                if (op.name !== undefined || op.role !== undefined) return fail('劇情預設只能改內容和開關');
                const content = str(op.content);
                if (content !== undefined) {
                    if (p.marker || p.section) return fail(`「${p.name}」是資料佔位或區塊邊界，只能開關`);
                    if (content !== p.content) { changes.push({ label: `改了「${p.name}」的內容（${len(p.content)} → ${len(content)} 字）`, before: p.content, after: content }); p.content = content; }
                }
                const enabled = bool(op.enabled);
                if (enabled !== undefined && enabled !== p.enabled) { changes.push({ label: `${enabled ? '打開' : '關掉'}「${p.name}」` }); p.enabled = enabled; }
                doc = { ...doc, prompts: doc.prompts.map(x => (x.id === p.id ? p : x)) };
                return;
            }
            case 'params':
                doc = { ...doc, generation: applyGenerationOp(doc.generation as unknown as Record<string, number | undefined>, op, ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxTokens'], changes, errors) as unknown as StoryTheaterPresetDocument['generation'] };
                return;
            case 'rename': {
                const name = str(op.name)?.trim();
                if (!name) return fail('要有 name');
                if (name !== doc.name) { changes.push({ label: `預設改名：「${doc.name}」→「${name}」` }); doc = { ...doc, name }; }
                return;
            }
            case 'prefill': {
                const text = str(op.text) ?? '';
                if (text !== (doc.assistantPrefill || '')) { changes.push({ label: text ? '改了預填' : '拿掉預填', before: doc.assistantPrefill, after: text }); doc = { ...doc, assistantPrefill: text || undefined }; }
                return;
            }
            default:
                return fail('劇情預設只能用 edit（內容、開關）、params、rename、prefill；條目不能加刪、不能排順序，也沒有正則');
        }
    });
    return { doc, changes, errors };
};

// ─── 新建：從哪裡複製 ───

export const NEW_PRESET_SOURCES = ['私聊內建', '群聊內建', '電話內建', '見面內建', '劇情內建', '空白劇情'] as const;

/** from 是內建名字或一份既有預設（照它複製）；回傳新的一份（還沒存） */
export const buildNewPreset = (from: unknown, name: unknown, data: PresetData):
    { kind: 'general'; doc: MeetingPresetDoc } | { kind: 'story'; doc: StoryTheaterPresetDocument } | { error: string } => {
    const source = typeof from === 'string' ? from.trim() : '';
    const wanted = typeof name === 'string' ? name.trim() : '';
    const rename = <D extends { name: string }>(doc: D, fallback: string): D => ({ ...doc, name: wanted || fallback });
    const general = (doc: MeetingPresetDoc, fallback: string) => ({ kind: 'general' as const, doc: rename(JSON.parse(JSON.stringify(doc)) as MeetingPresetDoc, fallback) });
    switch (source) {
        case '私聊內建': return general(buildBuiltinChatPresetDoc(), '私聊 · 我的版本');
        case '群聊內建': return general(buildBuiltinGroupPresetDoc(), '群聊 · 我的版本');
        case '電話內建': return general(buildBuiltinCallPresetDoc(), '電話 · 我的版本');
        case '見面內建': return general({ ...buildBuiltinMeetingPresetDoc(), scenes: ['date'] }, '見面 · 我的版本');
        case '劇情內建': return { kind: 'story', doc: rename(JSON.parse(JSON.stringify(BUILTIN_NIGHT_SCREENING_PRESET.document)) as StoryTheaterPresetDocument, `${BUILTIN_NIGHT_SCREENING_PRESET.name} · 我的版本`) };
        case '空白劇情': return { kind: 'story', doc: rename(createBlankStoryPreset(wanted || '新劇情預設').document, '新劇情預設') };
        default: {
            const found = findPreset(source, data);
            if ('error' in found) return { error: `from 要是 ${NEW_PRESET_SOURCES.join('、')}，或一份既有預設的名字／id。${found.error}` };
            if (found.kind === 'general') return general(found.record.doc, `${found.record.name}（副本）`);
            return { kind: 'story', doc: rename(JSON.parse(JSON.stringify(found.preset.document)) as StoryTheaterPresetDocument, `${found.preset.name} · 副本`) };
        }
    }
};

export const newGeneralPresetId = () => `mp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const newStoryPresetId = () => `story_preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ─── 誰用這份（綁定） ───

const SCENE_BY_NAME: Record<string, PresetScene> = { chat: 'chat', 私聊: 'chat', group: 'group', 群聊: 'group', call: 'call', 電話: 'call', date: 'date', 見面: 'date', story: 'story', 劇情: 'story' };
const FIELD_BY_NAME: Record<string, 'chat' | 'call' | 'date'> = { chat: 'chat', 私聊: 'chat', call: 'call', 電話: 'call', date: 'date', 見面: 'date' };

/**
 * use：{"scenes": ["chat"], "chars": [{"name": "阿澈", "for": "chat"}], "groups": ["週末群"]}
 * kind 是預設種類：劇情預設只能設成劇情場景預設；通用預設不能設劇情場景。
 */
export const parseBindings = (use: unknown, kind: 'general' | 'story', data: PresetData): { bindings: AssistantPresetBinding[] } | { error: string } => {
    if (use === undefined || use === null) return { bindings: [] };
    if (typeof use !== 'object') return { error: 'use 的格式：{"scenes": [...], "chars": [{"name": "...", "for": "chat|call|date"}], "groups": [...]}' };
    const u = use as Record<string, unknown>;
    const out: AssistantPresetBinding[] = [];
    for (const raw of Array.isArray(u.scenes) ? u.scenes : []) {
        const scene = SCENE_BY_NAME[String(raw).trim()];
        if (!scene) return { error: `場景「${String(raw)}」不認得（chat、group、call、date、story）` };
        if ((scene === 'story') !== (kind === 'story')) return { error: kind === 'story' ? '劇情預設只能設成劇情的場景預設' : '通用預設不能設成劇情的場景預設' };
        out.push({ kind: 'scene', scene, label: `${PRESET_SCENE_LABEL[scene]}場景預設` });
    }
    const chars = Array.isArray(u.chars) ? u.chars : [];
    const groups = Array.isArray(u.groups) ? u.groups : [];
    if (kind === 'story' && (chars.length || groups.length)) return { error: '劇情預設不能設給角色或群（劇情在劇情劇場裡自己選）' };
    for (const raw of chars) {
        const c = (raw && typeof raw === 'object' ? raw : { name: raw }) as Record<string, unknown>;
        const field = FIELD_BY_NAME[String(c.for ?? 'chat').trim()];
        if (!field) return { error: `角色的 for「${String(c.for)}」要是 chat、call、date` };
        const ref = String(c.name ?? c.id ?? '').trim();
        const pool = data.characters.filter(x => !x.altOf);
        const hit = pool.find(x => x.id === ref) || (pool.filter(x => x.name === ref).length === 1 ? pool.find(x => x.name === ref) : undefined);
        if (!hit) return { error: `找不到角色「${ref}」（同名的話用 id）` };
        out.push({ kind: 'char', charId: hit.id, field, label: `${hit.name}的${PRESET_SCENE_LABEL[field]}` });
    }
    for (const raw of groups) {
        const ref = String(raw).trim();
        const hit = data.groups.find(g => g.id === ref) || (data.groups.filter(g => g.name === ref).length === 1 ? data.groups.find(g => g.name === ref) : undefined);
        if (!hit) return { error: `找不到群「${ref}」（同名的話用 id）` };
        out.push({ kind: 'group', groupId: hit.id, label: `群「${hit.name}」` });
    }
    return { bindings: out };
};

/** 綁定需要的場景：通用預設的「適用場景」沒勾的話，選單裡看不到，要順便勾上 */
export const scenesNeededFor = (bindings: AssistantPresetBinding[]): Array<'chat' | 'group' | 'call' | 'date'> => {
    const out = new Set<'chat' | 'group' | 'call' | 'date'>();
    bindings.forEach(b => {
        if (b.kind === 'scene' && b.scene !== 'story') out.add(b.scene);
        if (b.kind === 'char') out.add(b.field);
        if (b.kind === 'group') out.add('group');
    });
    return [...out];
};

/** 現在這個綁定設的是什麼（還原用） */
export const readBinding = (b: AssistantPresetBinding, data: PresetData): string | undefined => {
    if (b.kind === 'scene') return data.sceneDefaults[b.scene];
    if (b.kind === 'group') return data.groups.find(g => g.id === b.groupId)?.presetId;
    const c = data.characters.find(x => x.id === b.charId);
    if (!c) return undefined;
    return b.field === 'chat' ? c.chatPresetId : b.field === 'call' ? c.callPresetId : c.dateMeetingPresetId;
};

export type PresetDraft = Omit<AssistantPresetProposal, 'id' | 'status'>;
