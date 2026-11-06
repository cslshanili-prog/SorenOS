/**
 * SillyTavern 巨集（`{{...}}`）的子集，照 ST 的規則展開：由左到右、參數裡的巨集先展開、
 * `::` 分隔參數（也認 `{{roll:1d20}}`、`{{roll 1d20}}` 這種單冒號／空白寫法），參數前後空白去掉。
 *
 * **認不得的一律原樣保留**——預設裡常有 `{{YYYY/MM/DD 星期X}}`、`{{序號，如 01}}` 這種
 * 給模型照著填的輸出模板，ST 也不動它們；拼錯的（`{{radom::…}}`）同理。
 * 清單見 ST 的 public/scripts/macros/definitions。
 */

export interface MacroEnv {
    charName: string;
    userName: string;
    /** `{{setvar}}` 系列的變數，會被改 */
    vars: Record<string, string>;
    /** `{{setglobalvar}}` 系列的變數，會被改 */
    globalVars: Record<string, string>;
    charDescription?: string;
    charPersonality?: string;
    scenario?: string;
    persona?: string;
    mesExamples?: string;
    lastMessage?: string;
    lastUserMessage?: string;
    lastCharMessage?: string;
    input?: string;
    model?: string;
    now?: Date;
    /** IANA 時區；不給就用裝置時區 */
    timeZone?: string;
    rng?: () => number;
}

const findClose = (text: string, from: number): number => {
    let depth = 1;
    let k = from;
    while (k < text.length) {
        if (text.startsWith('{{', k)) { depth++; k += 2; continue; }
        if (text.startsWith('}}', k)) {
            depth--;
            if (depth === 0) return k;
            k += 2;
            continue;
        }
        k++;
    }
    return -1;
};

/** 按頂層的 `::` 切參數（巢狀的 `{{…::…}}` 不切） */
const splitArgs = (text: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let k = 0; k < text.length; k++) {
        if (text.startsWith('{{', k)) { depth++; k++; continue; }
        if (text.startsWith('}}', k)) { depth = Math.max(0, depth - 1); k++; continue; }
        if (depth === 0 && text.startsWith('::', k)) {
            parts.push(text.slice(start, k));
            start = k + 2;
            k++;
        }
    }
    parts.push(text.slice(start));
    return parts;
};

/** ST 的 readSingleArgsRandomList：`{{random:a,b,c}}`（`\,` 是逗號本身） */
const splitLegacyList = (value: string): string[] => {
    if (value.includes('::')) return value.split('::').map(item => item.trim());
    return value
        .replace(/\\,/g, '\u0000')
        .split(',')
        .map(item => item.trim().replace(/\u0000/g, ','));
};

const roll = (formula: string, rng: () => number): string => {
    const f = /^\d+$/.test(formula) ? `1d${formula}` : formula.replace(/\s+/g, '');
    const m = f.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
    if (!m) return '';
    const count = Math.min(Number(m[1] || 1), 1000);
    const sides = Number(m[2]);
    if (!count || !sides) return '';
    let total = Number(m[3] || 0);
    for (let i = 0; i < count; i++) total += 1 + Math.floor(rng() * sides);
    return String(total);
};

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const dateParts = (now: Date, timeZone?: string) => {
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
        }).formatToParts(now);
    } catch {
        parts = new Intl.DateTimeFormat('en-US', {
            hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
        }).formatToParts(now);
    }
    const get = (type: string) => parts.find(p => p.type === type)?.value || '';
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return { YYYY: get('year'), MM: get('month'), DD: get('day'), HH: get('hour'), mm: get('minute'), ss: get('second'), weekday };
};

/** `{{datetimeformat::YYYY-MM-DD HH:mm}}` 用的簡化版 moment 格式 */
const formatDate = (format: string, now: Date, timeZone?: string): string => {
    const p = dateParts(now, timeZone);
    return format.replace(/YYYY|MM|DD|HH|mm|ss/g, token => (p as any)[token]);
};

const toNumber = (value: string): number | null => (value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

type Handler = (args: string[], env: MacroEnv) => string;

const add = (store: Record<string, string>, name: string, value: string): string => {
    const current = store[name] ?? '';
    const a = current === '' ? 0 : toNumber(current);
    const b = toNumber(value);
    store[name] = a !== null && b !== null ? String(a + b) : current + value;
    return '';
};

const step = (store: Record<string, string>, name: string, delta: number): string => {
    const next = (toNumber(store[name] ?? '0') ?? 0) + delta;
    store[name] = String(next);
    return String(next);
};

const HANDLERS: Record<string, Handler> = {
    char: (_a, env) => env.charName,
    user: (_a, env) => env.userName,
    group: (_a, env) => env.charName,
    notchar: (_a, env) => env.userName,
    description: (_a, env) => env.charDescription ?? '',
    chardescription: (_a, env) => env.charDescription ?? '',
    personality: (_a, env) => env.charPersonality ?? '',
    charpersonality: (_a, env) => env.charPersonality ?? '',
    scenario: (_a, env) => env.scenario ?? '',
    charscenario: (_a, env) => env.scenario ?? '',
    persona: (_a, env) => env.persona ?? '',
    mesexamples: (_a, env) => env.mesExamples ?? '',
    mesexamplesraw: (_a, env) => env.mesExamples ?? '',
    lastmessage: (_a, env) => env.lastMessage ?? '',
    lastusermessage: (_a, env) => env.lastUserMessage ?? '',
    lastcharmessage: (_a, env) => env.lastCharMessage ?? '',
    input: (_a, env) => env.input ?? '',
    model: (_a, env) => env.model ?? '',
    ismobile: () => 'false',
    newline: () => '\n',
    space: () => ' ',
    noop: () => '',
    trim: () => '',
    banned: () => '',
    outlet: () => '',
    time: (_a, env) => { const p = dateParts(env.now ?? new Date(), env.timeZone); return `${p.HH}:${p.mm}`; },
    isotime: (_a, env) => { const p = dateParts(env.now ?? new Date(), env.timeZone); return `${p.HH}:${p.mm}`; },
    date: (_a, env) => { const p = dateParts(env.now ?? new Date(), env.timeZone); return `${Number(p.YYYY)}年${Number(p.MM)}月${Number(p.DD)}日`; },
    isodate: (_a, env) => { const p = dateParts(env.now ?? new Date(), env.timeZone); return `${p.YYYY}-${p.MM}-${p.DD}`; },
    weekday: (_a, env) => WEEKDAYS[dateParts(env.now ?? new Date(), env.timeZone).weekday] ?? '',
    datetimeformat: ([format = ''], env) => formatDate(format, env.now ?? new Date(), env.timeZone),
    random: (args, env) => {
        const list = args.length === 1 ? splitLegacyList(args[0]) : args;
        return list.length ? list[Math.floor((env.rng ?? Math.random)() * list.length)] ?? '' : '';
    },
    roll: ([formula = ''], env) => roll(formula, env.rng ?? Math.random),
    setvar: ([name = '', value = ''], env) => { if (name) env.vars[name] = value; return ''; },
    getvar: ([name = ''], env) => env.vars[name] ?? '',
    addvar: ([name = '', value = ''], env) => (name ? add(env.vars, name, value) : ''),
    incvar: ([name = ''], env) => (name ? step(env.vars, name, 1) : ''),
    decvar: ([name = ''], env) => (name ? step(env.vars, name, -1) : ''),
    hasvar: ([name = ''], env) => String(Object.prototype.hasOwnProperty.call(env.vars, name)),
    deletevar: ([name = ''], env) => { delete env.vars[name]; return ''; },
    setglobalvar: ([name = '', value = ''], env) => { if (name) env.globalVars[name] = value; return ''; },
    getglobalvar: ([name = ''], env) => env.globalVars[name] ?? '',
    addglobalvar: ([name = '', value = ''], env) => (name ? add(env.globalVars, name, value) : ''),
    incglobalvar: ([name = ''], env) => (name ? step(env.globalVars, name, 1) : ''),
    decglobalvar: ([name = ''], env) => (name ? step(env.globalVars, name, -1) : ''),
    hasglobalvar: ([name = ''], env) => String(Object.prototype.hasOwnProperty.call(env.globalVars, name)),
    deleteglobalvar: ([name = ''], env) => { delete env.globalVars[name]; return ''; },
};
HANDLERS.pick = HANDLERS.random;
HANDLERS.idle_duration = () => '';
HANDLERS.idleduration = () => '';

/** 一個 `{{…}}` 的內文；回傳 null 表示不認得，原樣保留 */
const evaluate = (body: string, env: MacroEnv): string | null => {
    const trimmed = body.trim();
    if (trimmed.startsWith('//')) return '';
    const m = trimmed.match(/^([A-Za-z_][\w-]*)([\s\S]*)$/);
    if (!m) return null;
    const handler = HANDLERS[m[1].toLowerCase()];
    if (!handler) return null;
    const rest = m[2];
    let args: string[];
    if (rest === '') args = [];
    else if (rest.startsWith('::')) args = splitArgs(rest.slice(2));
    else if (rest.startsWith(':')) args = [rest.slice(1)];
    else if (/^\s/.test(rest)) args = [rest];
    else return null;
    return handler(args.map(arg => expand(arg, env).trim()), env);
};

const expand = (text: string, env: MacroEnv): string => {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const open = text.indexOf('{{', i);
        if (open === -1) { out += text.slice(i); break; }
        out += text.slice(i, open);
        const close = findClose(text, open + 2);
        if (close === -1) { out += text.slice(open); break; }
        const result = evaluate(text.slice(open + 2, close), env);
        out += result === null ? text.slice(open, close + 2) : result;
        i = close + 2;
    }
    return out;
};

export const expandMacros = (text: string, env: MacroEnv): string => {
    if (!text || !text.includes('{{')) return text || '';
    // {{trim}}（非範圍寫法）：連同前後的換行一起拿掉
    return expand(text.replace(/(?:\r?\n)*\{\{\s*trim\s*\}\}(?:\r?\n)*/gi, ''), env);
};
