import { loadCharacterContextMessages } from '../utils/chatContextRange';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneSimLog, CharacterBuff, UserProfile } from '../types';
import type { SimBeat as Beat, SimBeatKind as BeatKind, SimScript } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { safeResponseJson } from '../utils/safeApi';
import { parsePersonaScriptApiResponse } from '../utils/personaSimParser';
import { trackEvent } from '../utils/analytics';
import { useBlobRefUrl } from '../utils/blobRef';
import {
    CaretLeft, Play, Pause, FastForward, Lock, MagnifyingGlass, MusicNotes,
    BellRinging, ImageSquare, NotePencil, Globe, CloudSun, ArrowClockwise,
    HourglassMedium, Sparkle, ClockCounterClockwise, X, CaretRight, ArrowRight,
    PaperPlaneTilt, Check,
} from '@phosphor-icons/react';

// ============================================================
//  TYPES (runtime script model) — Beat / SimScript 已移到 types.ts 共享，
//  以便「生活記錄」存完整腳本快照用於重播。
// ============================================================
export interface SimApiConfig { apiKey: string; baseUrl: string; model: string; }
export type SimState =
    | { status: 'idle' }
    | { status: 'loading'; mode: 'daily' | 'event'; theme: string }
    | { status: 'ready'; mode: 'daily' | 'event'; theme: string; script: SimScript; replay?: boolean }
    | { status: 'error'; mode: 'daily' | 'event'; theme: string };

interface Props {
    targetChar: CharacterProfile;
    onExit: () => void;
    openLifeLog: () => void;
    sim: SimState;
    onStart: (mode: 'daily' | 'event', theme: string, presence: 'default' | 'light' | 'none', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute') => void;
    onConsumed: () => void;
}

const DAILY = ['平凡的週二', '週末宅家', '深夜失眠', '上班的一天', '放學後的傍晚'];
const EVENTS = ['第一次見到某人', '告白當天', '考試成績公佈', '離職那天', '醫院檢查結果出來的下午', '一場爭吵之後'];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const ACCENT = '#b89bff';

// ============================================================
//  TYPEWRITER — the soul of screenlife (type → delete → retype)
// ============================================================
const Typewriter: React.FC<{ drafts: string[]; sent?: string | null; className?: string; placeholder?: string }> =
    ({ drafts, sent, className, placeholder }) => {
        const [text, setText] = useState('');
        const [blink, setBlink] = useState(true);
        useEffect(() => {
            let cancelled = false;
            const type = async (s: string) => {
                for (let k = 0; k <= s.length; k++) { if (cancelled) return; setText(s.slice(0, k)); await wait(48); }
            };
            const erase = async (s: string) => {
                for (let k = s.length; k >= 0; k--) { if (cancelled) return; setText(s.slice(0, k)); await wait(26); }
            };
            (async () => {
                for (const d of drafts) {
                    await type(d); if (cancelled) return;
                    await wait(750); if (cancelled) return;
                    await erase(d); if (cancelled) return;
                    await wait(280);
                }
                if (sent != null && sent !== '') { await type(sent); setBlink(false); }
                else setBlink(false);
            })();
            return () => { cancelled = true; };
        }, []);
        return (
            <span className={className}>
                {text || <span className="opacity-30">{placeholder}</span>}
                {blink && <span className="inline-block w-[2px] h-[1em] align-middle ml-0.5 bg-current animate-pulse" />}
            </span>
        );
    };

// ============================================================
//  BACKGROUND GENERATOR (runs at CheckPhone level so it survives navigation)
// ============================================================
export async function generatePersonaScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: SimApiConfig;
    mode: 'daily' | 'event'; theme: string; userPresence?: 'default' | 'light' | 'none';
    tone?: 'mix' | 'depressive' | 'darkhumor' | 'cute';
}): Promise<SimScript> {
    const { char, userProfile, apiConfig, mode, theme, userPresence = 'default', tone = 'mix' } = opts;
    await injectMemoryPalace(char, undefined, theme, userProfile.name);
    const context = ContextBuilder.buildCoreContext(char, userProfile, true, char.memoryPalaceInjection);
    const msgs = await loadCharacterContextMessages(char);
    // 跟隨用戶為該角色設置的最大上下文（沒設則默認 500）——避免「吵完架來看 if 線，結果 char 不記得吵什麼」
    const ctxLimit = Math.max(1, msgs.length);
    const recent = msgs.slice(-ctxLimit).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');
    const firstTs = msgs.find(m => typeof m.timestamp === 'number')?.timestamp;
    const acquaintance = describeAcquaintance(firstTs, userProfile.name, char.name);
    const prompt = buildDirectorPrompt(context, recent, mode, theme, char.name, acquaintance, userProfile.name, userPresence, tone);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.98, max_tokens: 24000 }),
    });
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    // 截斷直接報錯，不兜底：模型輸出被 token 上限截斷時 finish_reason 為 'length'
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('演出生成被截斷');
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason === 'content_filter' || finishReason === 'safety') {
        throw new Error('演出生成被模型安全策略中止');
    }
    const { content, script: parsed } = parsePersonaScriptApiResponse(data);
    if (!content) throw new Error('模型沒有返回演出正文');
    if (!parsed) {
        console.warn('[persona] script parse failed', { finishReason, contentLength: content.length });
        throw new Error(`演出格式無法解析（模型返回 ${content.length} 字）`);
    }
    // 不兜底：結尾必須是模型自己收束好的 end，否則視為不完整/被截斷，報錯讓用戶重試
    if (parsed.beats[parsed.beats.length - 1].kind !== 'end') throw new Error('演出結尾不完整');
    return parsed;
}

// ============================================================
//  COMPONENT
// ============================================================
const PersonaSim: React.FC<Props> = ({ targetChar, onExit, openLifeLog, sim, onStart, onConsumed }) => {
    const { updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<'idle' | 'play' | 'end'>('idle');
    const [mode, setMode] = useState<'daily' | 'event'>('daily');
    const [theme, setTheme] = useState('');
    const [presence, setPresence] = useState<'default' | 'light' | 'none'>('default');
    const [tone, setTone] = useState<'mix' | 'depressive' | 'darkhumor' | 'cute'>('mix');
    const [script, setScript] = useState<SimScript | null>(null);
    const [idx, setIdx] = useState(0);
    const [autoplay, setAutoplay] = useState(false);
    const [memorySent, setMemorySent] = useState(false);
    const savedRef = useRef(false);
    const ffTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const beats = script?.beats || [];
    const beat = beats[idx];

    // 圖層化：找出「當前可見的屏幕」(lock/app/flashback)，通知/獨白疊在它上面彈出，
    // 背景屏幕只在真正切屏時才重新進場 —— 這是去掉「PPT 翻頁感」的關鍵。
    const screenIdx = (() => {
        for (let i = idx; i >= 0; i--) {
            const k = beats[i]?.kind;
            if (k === 'lock' || k === 'app' || k === 'flashback') return i;
        }
        return -1;
    })();
    const screenBeat = screenIdx >= 0 ? beats[screenIdx] : undefined;
    const isOverlay = beat?.kind === 'notification' || beat?.kind === 'thought';

    // ----- kick off background generation (runs in CheckPhone) -----
    const requestStart = (m: 'daily' | 'event', t: string) => {
        const trimmed = t.trim();
        if (!trimmed) { addToast('請選擇或輸入體驗內容', 'error'); return; }
        setMode(m); setTheme(trimmed);
        onStart(m, trimmed, presence, tone);
    };

    // ----- consume a ready script (generated in background) and start playing -----
    useEffect(() => {
        if (phase === 'idle' && sim.status === 'ready') {
            setMode(sim.mode); setTheme(sim.theme);
            // 重播：腳本來自生活記錄已存檔的快照，別再 persist 一遍（否則生活記錄裡出現重複）
            setScript(sim.script); setIdx(0); savedRef.current = !!sim.replay; setMemorySent(false); setPhase('play');
            onConsumed();
        }
    }, [sim, phase, onConsumed]);

    // ----- persistence on reaching the end -----
    const persist = useCallback(async () => {
        if (savedRef.current || !script) return;
        savedRef.current = true;

        const log: PhoneSimLog = {
            id: `sim-${Date.now()}`,
            mode,
            theme,
            title: script.title || theme,
            summary: script.summary || '',
            ending: script.ending,
            beatsCount: beats.length,
            memoryText: buildMemoryText(script),
            timestamp: Date.now(),
            script,   // 存完整腳本快照 → 生活記錄可原樣重播
        };

        // emotion buff — only if the schedule feature is on for this character
        const scheduleOn = isScheduleFeatureOn(targetChar);
        const newBuff: CharacterBuff | null = (scheduleOn && script.buff?.label) ? {
            id: `buff_${Date.now()}`,
            name: script.buff.name || `sim_${Date.now()}`,
            label: script.buff.label,
            intensity: (script.buff.intensity && [1, 2, 3].includes(script.buff.intensity) ? script.buff.intensity : 2) as 1 | 2 | 3,
            emoji: script.buff.emoji,
            color: script.buff.color || ACCENT,
            description: script.buff.description,
        } : null;
        if (newBuff) log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };

        // 關鍵：基於「最新」角色狀態合併，絕不用可能過期的 targetChar 快照整體覆蓋 phoneState
        //（否則在異步間隙裡別處的寫入會把剛存的 simLogs / 其它 phoneState 字段抹掉）。
        let dispatchBuffs: CharacterBuff[] | null = null;
        updateCharacter(targetChar.id, (cur) => {
            const phoneState = {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                simLogs: [log, ...(cur.phoneState?.simLogs || [])],
            };
            if (newBuff && script.buff) {
                const existing = (cur.activeBuffs || []).filter(b => b.id !== newBuff.id);
                const nextBuffs = [newBuff, ...existing].slice(0, 4);
                dispatchBuffs = nextBuffs;
                return {
                    activeBuffs: nextBuffs,
                    buffInjection: script.buff.description ? `（${newBuff.emoji || ''}${newBuff.label}）${script.buff.description}` : '',
                    phoneState,
                };
            }
            return { phoneState };
        });
        if (newBuff) {
            // buffs 拿不到就退化成「純刷新」信號——buffSyncHandler 會從 DB 兜底重讀
            window.dispatchEvent(new CustomEvent('emotion-updated',
                dispatchBuffs ? { detail: { charId: targetChar.id, buffs: dispatchBuffs, buffInjection: '' } }
                              : { detail: { charId: targetChar.id } }));
        }
        addToast('已存入生活記錄', 'success');
    }, [script, mode, theme, beats.length, targetChar, updateCharacter, addToast]);

    // ----- advance -----
    const advance = useCallback(() => {
        setIdx(i => {
            if (i >= beats.length - 1) return i;
            return i + 1;
        });
    }, [beats.length]);

    useEffect(() => {
        if (phase === 'play' && beat?.kind === 'end') {
            setPhase('end');
            setAutoplay(false);
            persist();
        }
    }, [idx, phase, beat, persist]);

    // ----- autoplay -----
    useEffect(() => {
        if (phase !== 'play' || !autoplay || !beat) return;
        const base = beat.kind === 'flashback' ? 6500 : beat.kind === 'thought' ? 3600 : 3000;
        const delay = base + (beat.pace === 3 ? 3500 : beat.pace === 2 ? 1600 : 0);
        const t = setTimeout(advance, delay);
        return () => clearTimeout(t);
    }, [phase, autoplay, idx, beat, advance]);

    // ----- long-press fast-forward -----
    const startFF = () => {
        if (ffTimer.current) return;
        ffTimer.current = setInterval(advance, 320);
    };
    const stopFF = () => { if (ffTimer.current) { clearInterval(ffTimer.current); ffTimer.current = null; } };
    useEffect(() => () => stopFF(), []);

    const restart = () => {
        // 重看同一場演出不再重複寫入「生活記錄」(savedRef 保持已保存)
        setIdx(0);
        setPhase('play');
    };

    // 把這場演出作為「真實回憶」發送到聊天 —— 角色會把它當成親身經歷（進入上下文）
    const sendAsMemory = async () => {
        if (!script || memorySent) return;
        const title = script.title || theme;
        const summary = script.summary || '';
        const digest = buildMemoryText(script);
        const content = `【一段親身經歷 · ${title}】\n${digest}${summary ? `\n\n回過頭想：${summary}` : ''}`;
        try {
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'sim_card', content,
                metadata: { simCard: { mode, theme, title, summary, ending: script.ending } },
            } as any);
            setMemorySent(true);
            addToast('已作為回憶發送給 TA', 'success');
        } catch (e) {
            console.error(e);
            addToast('發送失敗，請重試', 'error');
        }
    };

    const wallpaper = targetChar.dateBackground;

    // ========================================================
    //  RENDER: SELECT
    // ========================================================
    if (phase === 'idle' && (sim.status === 'idle' || sim.status === 'error')) {
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} right={
                    <button onClick={() => { openLifeLog(); trackEvent('打开生活记录'); }} className="flex items-center gap-1 text-[11px] text-white/60 active:scale-95 transition">
                        <ClockCounterClockwise size={15} /> 生活記錄
                    </button>
                } />
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pt-2 pb-10">
                    <div className="mb-5">
                        <div className="text-[10px] tracking-[0.35em] uppercase" style={{ color: ACCENT }}>Persona Simulation</div>
                        <h1 className="text-[26px] font-light text-white mt-2 leading-tight" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                            成為 {targetChar.name} 的<br />一段人生
                        </h1>
                    </div>

                    {/* 體驗卡 · 中二疊甲：顯得很牛逼，同時聲明這只是小劇場、不代表角色真實情況 */}
                    <div className="relative rounded-2xl overflow-hidden mb-6 border border-[#b89bff]/25"
                        style={{ background: 'linear-gradient(135deg, rgba(184,155,255,0.16), rgba(184,155,255,0.03))' }}>
                        <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: ACCENT }} />
                        <div className="absolute -top-8 -right-6 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(184,155,255,0.4), transparent 70%)' }} />
                        <div className="relative p-4 pl-5">
                            <div className="flex items-center justify-between mb-2.5">
                                <span className="text-[9px] tracking-[0.28em] uppercase font-bold" style={{ color: ACCENT }}>✦ Experience Ticket · 體驗卡</span>
                                <span className="text-[8px] tracking-[0.2em] uppercase text-white/45 border border-white/15 rounded px-1.5 py-0.5">Fiction Only</span>
                            </div>
                            <p className="text-[11.5px] text-white/75 leading-relaxed" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                這是一張通往 TA 的體驗卡。我們借這部手機，為你點演一段「<span style={{ color: ACCENT }}>可能發生過</span>」的人生切片——畫面、獨白與痕跡，皆由此刻的 AI 即興演繹。
                            </p>
                            <p className="text-[10px] text-white/45 leading-relaxed mt-2.5 pt-2.5 border-t border-dashed border-white/15">
                                ※ 它只是獻給你的一齣小劇場，是一種「如果」。<br />並不等於角色的真實經歷或設定——縱情入戲，散場即忘，無需當真。
                            </p>
                        </div>
                    </div>

                    {/* mode tabs */}
                    <div className="flex gap-2 mb-4 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.06]">
                        {(['daily', 'event'] as const).map(m => (
                            <button key={m} onClick={() => { setMode(m); trackEvent('切换人格模拟类型', { mode: m }); }}
                                className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold transition"
                                style={mode === m ? { background: ACCENT, color: '#1a1530' } : { color: 'rgba(255,255,255,0.5)' }}>
                                {m === 'daily' ? '日常模擬' : '事件模擬'}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-white/35 mb-4 px-1">
                        {mode === 'daily' ? '體驗 TA 某個普通日子的生活 · 生活感與陪伴' : '體驗 TA 人生中的某個特殊事件 · 情緒張力'}
                    </p>

                    {/* 你的存在感（這一天裡"你"佔多少分量） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">你的存在感</div>
                    <div className="grid grid-cols-3 gap-2 mb-5">
                        {([
                            { id: 'default', label: '默認', desc: '自然出現' },
                            { id: 'light', label: '輕度', desc: '淡淡背景' },
                            { id: 'none', label: '無你', desc: '只有 TA' },
                        ] as const).map(o => {
                            const active = presence === o.id;
                            return (
                                <button key={o.id} onClick={() => { setPresence(o.id); trackEvent('选择你的存在感', { presence: o.id }); }}
                                    className="rounded-2xl py-2.5 border transition active:scale-[0.98] text-center"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.8)' }}>
                                    <div className="text-[12.5px] font-semibold">{o.label}</div>
                                    <div className={`text-[9px] mt-0.5 ${active ? 'text-[#1a1530]/70' : 'text-white/35'}`}>{o.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    {/* 演出基調（喪的大前提下偏哪種味道） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">演出基調</div>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                        {([
                            { id: 'mix', label: '隨心', desc: '每場隨機' },
                            { id: 'depressive', label: '致鬱', desc: '一路喪到底' },
                            { id: 'darkhumor', label: '黑色幽默', desc: '荒誕又毒舌' },
                            { id: 'cute', label: '輕盈可愛', desc: '活潑俏皮' },
                        ] as const).map(o => {
                            const active = tone === o.id;
                            return (
                                <button key={o.id} onClick={() => { setTone(o.id); trackEvent('选择演出基调', { tone: o.id }); }}
                                    className="rounded-2xl py-2.5 border transition active:scale-[0.98] text-center"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.8)' }}>
                                    <div className="text-[12.5px] font-semibold">{o.label}</div>
                                    <div className={`text-[9px] mt-0.5 ${active ? 'text-[#1a1530]/70' : 'text-white/35'}`}>{o.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    {/* ① 選方向（點一下填進下方，可繼續編輯） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">① 選個大方向</div>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                        {(mode === 'daily' ? DAILY : EVENTS).map(s => {
                            const active = theme.trim() === s;
                            return (
                                <button key={s} onClick={() => setTheme(s)}
                                    className="text-left rounded-2xl px-3.5 py-3 border transition active:scale-[0.98]"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }}>
                                    <span className="text-[12.5px] font-medium">{s}</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* ② 補細節（與方向合併，二者不再二選一） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">② 補點細節 · 也可直接自己寫</div>
                    <textarea value={theme} onChange={e => setTheme(e.target.value)}
                        placeholder="選個方向後在這裡補充具體情境，或直接寫你想看的。例如：放學後的傍晚 · 下了雨，TA 沒帶傘，在便利店門口等一個不一定會來的人。"
                        className="w-full h-24 bg-white/[0.05] border border-white/[0.08] rounded-2xl px-3.5 py-3 text-[12.5px] text-white placeholder-white/25 outline-none resize-none leading-relaxed mb-4 no-scrollbar" />

                    <button onClick={() => requestStart(mode, theme)} disabled={!theme.trim()}
                        className="w-full py-3.5 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition disabled:opacity-40"
                        style={{ background: ACCENT, color: '#1a1530' }}>
                        開始演出 <ArrowRight size={15} weight="bold" />
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: LOADING (background generation in progress / about to play)
    // ========================================================
    if (phase === 'idle') {
        const t = sim.status === 'loading' ? sim.theme : theme;
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-5 px-10 text-center">
                    <div className="relative">
                        <HourglassMedium size={40} weight="light" style={{ color: ACCENT }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: `${ACCENT}55` }} />
                    </div>
                    <div className="text-[13px] text-white/75">正在編排「{t}」…</div>
                    <div className="text-[11px] text-white/35 leading-relaxed">把記憶、對話與情緒編排成 TA 的一天，<br />可能需要較長時間。</div>
                    <button onClick={onExit} className="mt-3 px-5 py-2.5 rounded-xl text-[12px] text-white/75 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        先去別處逛逛 · 好了通知我
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell wallpaper={wallpaper}>
                <div className="flex-1 flex flex-col items-center justify-center px-8 text-center animate-fade-in">
                    <Lock size={26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">演出結束</div>
                    <h2 className="text-[20px] font-light text-white mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.title}</h2>
                    {script?.ending && <div className="text-[11px] mb-4 px-3 py-1 rounded-full" style={{ color: ACCENT, background: `${ACCENT}1f` }}>{script.ending}</div>}
                    <p className="text-[13.5px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.summary}</p>

                    {script?.buff?.label && isScheduleFeatureOn(targetChar) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || ACCENT}55`, background: `${script.buff.color || ACCENT}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">情緒狀態已寫入 TA</div>
                            </div>
                        </div>
                    )}

                    {/* 把這場演出作為真實回憶送給角色 */}
                    <button onClick={sendAsMemory} disabled={memorySent}
                        className="mt-8 w-full max-w-[300px] py-3 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition disabled:opacity-60"
                        style={memorySent
                            ? { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.1)' }
                            : { background: ACCENT, color: '#1a1530' }}>
                        {memorySent
                            ? <><Check size={15} weight="bold" /> 已成為 TA 的回憶</>
                            : <><PaperPlaneTilt size={15} weight="fill" /> 作為回憶發送給 TA</>}
                    </button>
                    <p className="text-[10px] text-white/30 mt-2 max-w-[280px] leading-relaxed">
                        會以一張卡片發到聊天裡，TA 將把這段經歷當成真實記憶。
                    </p>

                    <div className="flex gap-3 mt-6">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> 再看一次
                        </button>
                        <button onClick={() => { openLifeLog(); }} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold text-[#1a1530] flex items-center gap-1.5 active:scale-95 transition" style={{ background: ACCENT }}>
                            <ClockCounterClockwise size={14} weight="bold" /> 生活記錄
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">退出演出</button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: PLAY
    // ========================================================
    return (
        <Shell wallpaper={wallpaper}>
            {/* phone status time */}
            <div className="h-8 flex justify-between items-center px-6 pt-2 text-white/55 text-[11px] z-30 relative shrink-0">
                <span className="font-semibold tabular-nums">{beat?.time || ''}</span>
                <div className="flex items-center gap-1">
                    <Lock size={11} weight="fill" className="opacity-50" />
                    <span className="opacity-50">{targetChar.name}</span>
                </div>
            </div>

            {/* beat stage + tap to advance */}
            <div
                className="flex-1 relative z-10 overflow-hidden select-none"
                onClick={advance}
                onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); const t = setTimeout(startFF, 420); (e.currentTarget as any)._ff = t; }}
                onPointerUp={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
                onPointerLeave={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
            >
                {/* background screen — re-enters ONLY when the underlying screen changes */}
                {screenBeat && (
                    <div key={`s${screenIdx}`} className={`absolute inset-0 ${screenEntrance(screenBeat.kind)}`}>
                        <ScreenContent beat={screenBeat} char={targetChar} showMono={!isOverlay} dimmed={isOverlay} />
                    </div>
                )}
                {/* overlay — notification drops / thought fades, on top of the live screen */}
                {beat && isOverlay && (
                    <div key={`o${idx}`} className="absolute inset-0">
                        <Overlay beat={beat} />
                    </div>
                )}
            </div>

            {/* progress + controls */}
            <div className="shrink-0 z-30 px-5 pb-6 pt-2">
                <div className="h-[3px] rounded-full bg-white/10 overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${((idx + 1) / beats.length) * 100}%`, background: ACCENT }} />
                </div>
                <div className="flex items-center justify-between">
                    <button onClick={(e) => { e.stopPropagation(); onExit(); }} className="text-[11px] text-white/35">退出</button>
                    <span className="text-[10px] text-white/30">輕觸繼續 · 長按快進</span>
                    <button onClick={(e) => { e.stopPropagation(); setAutoplay(a => !a); trackEvent('切换演出自动播放'); }}
                        className="w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.1] text-white/70 active:scale-90 transition"
                        style={autoplay ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' } : undefined}>
                        {autoplay ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
                    </button>
                </div>
            </div>
        </Shell>
    );
};

// ============================================================
//  ENTRANCE + MONOLOGUE
// ============================================================
// 每種屏幕的進場動作 —— App 從底部彈起(像真的啟動)、鎖屏淡入、閃回淡入
const screenEntrance = (kind: BeatKind): string =>
    kind === 'app' ? 'animate-app-open' : 'animate-fade-in';

type Vibe = NonNullable<Beat['vibe']>;
// 確定性偽隨機（按種子），保證同一 beat 每次渲染散佈一致
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const vibeTint: Record<Vibe, string> = {
    calm: 'rgba(255,255,255,0.9)',
    chaotic: 'rgba(255,255,255,0.85)',
    happy: '#ffb3d9',
    anxious: '#ff9a9a',
    numb: 'rgba(255,255,255,0.45)',
    tender: '#e6c9ff',
};

// 內心獨白氣泡（逐字敲出，按情緒微調色調）
const MonoBubble: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => (
    <span className="inline-block px-3 py-1 rounded-2xl bg-black/70">
        <Typewriter drafts={[]} sent={text} placeholder=""
            className={`text-[15px] leading-relaxed ${vibe === 'anxious' ? 'tracking-tight' : ''}`} />
    </span>
);

// 浮在屏幕底部的內心獨白（用於鎖屏 / 通知等無底部輸入框的場景）
const MonoLine: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => (
    <div className="absolute left-0 right-0 bottom-6 px-8 text-center pointer-events-none z-20">
        <MonoBubble text={text} vibe={vibe} />
    </div>
);

// 情緒化的「內心獨白」全屏演出：混亂鋪滿 / 開心粉色飄飄 / 麻木冷淡 / 焦慮緊繃
const MoodThought: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => {
    if (vibe === 'chaotic') {
        const frags = text.split(/[，。、！？!?,.\s]+/).filter(Boolean);
        const pool = frags.length >= 4 ? frags : [...frags, ...frags, ...frags].slice(0, Math.max(6, frags.length));
        return (
            <div className="absolute inset-0 overflow-hidden">
                {pool.map((f, i) => (
                    <span key={i} className="absolute animate-fade-in"
                        style={{
                            top: `${6 + rnd(i + 1) * 62}%`, left: `${6 + rnd(i + 7) * 44}%`,
                            maxWidth: '46%', wordBreak: 'break-word', textAlign: 'center', lineHeight: 1.3,
                            transform: `rotate(${(rnd(i + 3) - 0.5) * 30}deg)`,
                            fontSize: `${13 + rnd(i + 5) * 14}px`,
                            opacity: 0.35 + rnd(i + 9) * 0.6,
                            color: 'white',
                            animationDelay: `${i * 90}ms`, animationFillMode: 'backwards',
                            textShadow: '0 1px 8px rgba(0,0,0,0.5)',
                        }}>
                        {f}
                    </span>
                ))}
            </div>
        );
    }
    if (vibe === 'happy') {
        const deco = ['✿', '♡', '❀', '✦', '♥', '✧'];
        return (
            <div className="absolute inset-0 overflow-hidden flex items-center justify-center px-10">
                {deco.map((d, i) => (
                    <span key={i} className="absolute animate-float" style={{
                        bottom: `${10 + rnd(i + 2) * 20}%`, left: `${8 + rnd(i + 4) * 80}%`,
                        fontSize: `${14 + rnd(i + 6) * 14}px`, color: '#ffc2e0',
                        animationDelay: `${i * 350}ms`, opacity: 0.8,
                    }}>{d}</span>
                ))}
                <p className="text-[20px] text-center leading-relaxed animate-fade-in"
                    style={{ background: 'linear-gradient(90deg,#ffd6ec,#ffb3d9,#ffc2e0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'anxious') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-10">
                <p className="text-[18px] text-center leading-relaxed tracking-tight animate-pulse"
                    style={{ color: vibeTint.anxious, textShadow: '0 0 12px rgba(255,80,80,0.3)' }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'numb') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-12">
                <p className="text-[14px] text-center leading-loose animate-fade-in" style={{ color: vibeTint.numb, animationDuration: '2s' }}>
                    {text}
                </p>
            </div>
        );
    }
    // calm / tender → typed, soft
    return (
        <div className="absolute inset-0 flex items-center justify-center px-10">
            <Typewriter drafts={[]} sent={text} placeholder=""
                className="text-[19px] text-center leading-relaxed"
                />
            {vibe === 'tender' && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 50% 50%, rgba(230,201,255,0.12), transparent 60%)' }} />}
        </div>
    );
};

// ============================================================
//  SCREEN CONTENT — lock / app / flashback (the persistent layer)
// ============================================================
const ScreenContent: React.FC<{ beat: Beat; char: CharacterProfile; showMono: boolean; dimmed?: boolean }> =
    ({ beat, char, showMono, dimmed }) => {
        const mono = showMono && beat.monologue ? <MonoLine text={beat.monologue} vibe={beat.vibe} /> : null;
        const dim = dimmed ? <div className="absolute inset-0 bg-black/45 z-10 pointer-events-none" /> : null;

        if (beat.kind === 'lock') {
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <div className="text-[64px] font-extralight text-white tracking-tight tabular-nums leading-none animate-fade-in" style={{ textShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>{beat.time || ''}</div>
                    {beat.notif && (
                        <div className="mt-10 w-[78%] rounded-2xl px-4 py-3 bg-black/70 border border-white/[0.15] animate-slide-up">
                            <div className="text-[10px] text-white/50 uppercase tracking-wide mb-0.5">{beat.notif.app}</div>
                            <div className="text-[12.5px] text-white/90 font-medium">{beat.notif.title}</div>
                            <div className="text-[11px] text-white/55 mt-0.5">{beat.notif.body}</div>
                        </div>
                    )}
                    {dim}{mono}
                </div>
            );
        }

        if (beat.kind === 'flashback') {
            const f = beat.flashback;
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center"
                    style={{ background: `radial-gradient(circle at 50% 45%, ${f?.tint || '#3a2a4a'} 0%, #07080c 78%)` }}>
                    <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-2.5 bg-black/75 border border-white/[0.15] flex items-center gap-2 animate-slide-down">
                        <ImageSquare size={16} className="text-pink-300" />
                        <span className="text-[12px] text-white/85 font-medium">{f?.label || f?.date || '過去的某天'}</span>
                    </div>
                    <div className="w-[68%] aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.1] shadow-2xl relative grayscale-[35%] animate-fade-in"
                        style={{ background: `linear-gradient(160deg, ${f?.tint || '#5a4a6a'}, #1a1520)`, animationDuration: '1.4s' }}>
                        <div className="absolute inset-0 flex items-center justify-center opacity-40">
                            <ImageSquare size={48} weight="thin" className="text-white" />
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
                            {f?.date && <div className="text-[9px] text-white/50 tabular-nums">{f.date}</div>}
                            {f?.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                        </div>
                    </div>
                    {beat.monologue
                        ? <div className="mt-6 px-10 text-center"><Typewriter drafts={[]} sent={beat.monologue} placeholder="" className="text-[14px] text-white/80" /></div>
                        : <p className="mt-6 text-[12px] text-white/30 tracking-[0.3em]">· · ·</p>}
                </div>
            );
        }

        // kind === 'app'
        const a = beat.app;
        if (!a) return <>{dim}{mono}</>;
        return (
            <div className="absolute inset-0 flex flex-col">
                <div className="h-11 flex items-center gap-2 px-5 shrink-0 text-white/70 border-b border-white/[0.06]">
                    {appIcon(a.view)}
                    <span className="text-[12.5px] font-medium">{a.name}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden relative">
                    <AppView app={a} char={char} />
                </div>
                {/* app 場景裡獨白走「頁腳」而非浮層，避免蓋住聊天/搜索/輸入框 */}
                {showMono && beat.monologue && (
                    <div className="shrink-0 px-8 pb-6 pt-2 text-center">
                        <MonoBubble text={beat.monologue} vibe={beat.vibe} />
                    </div>
                )}
                {dim}
            </div>
        );
    };

// ============================================================
//  OVERLAY — notification (drops) / thought (fades over the live screen)
// ============================================================
const Overlay: React.FC<{ beat: Beat }> = ({ beat }) => {
    if (beat.kind === 'thought') {
        const scrim = beat.vibe === 'happy' ? 'bg-black/55' : beat.vibe === 'chaotic' ? 'bg-black/75' : 'bg-black/70';
        return (
            <div className={`absolute inset-0 ${scrim}`}>
                <MoodThought text={beat.monologue || '……'} vibe={beat.vibe} />
            </div>
        );
    }
    // notification
    const n = beat.notif;
    const toneColor = n?.tone === 'sms' ? '#4ade80' : n?.tone === 'flashback' ? '#ff5fb0' : ACCENT;
    return (
        <div className="absolute inset-0">
            <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-3 bg-[#16131f]/95 border border-white/[0.16] animate-notif-pop shadow-2xl">
                <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: toneColor, boxShadow: `0 0 8px ${toneColor}` }} />
                    <span className="text-[10px] text-white/55 uppercase tracking-wide">{n?.app}</span>
                </div>
                <div className="text-[13px] text-white font-semibold">{n?.title}</div>
                <div className="text-[11.5px] text-white/65 mt-0.5">{n?.body}</div>
            </div>
            {beat.monologue && <MonoLine text={beat.monologue} vibe={beat.vibe} />}
        </div>
    );
};

const appIcon = (v: string) => {
    const p: any = { size: 15, weight: 'fill' as const, style: { color: ACCENT } };
    switch (v) {
        case 'search': return <MagnifyingGlass {...p} />;
        case 'music': return <MusicNotes {...p} />;
        case 'photo': return <ImageSquare {...p} />;
        case 'notes': return <NotePencil {...p} />;
        case 'browser': return <Globe {...p} />;
        case 'weather': return <CloudSun {...p} />;
        case 'chat': return <BellRinging {...p} />;
        default: return <Sparkle {...p} />;
    }
};

// ============================================================
//  APP VIEWS
// ============================================================
const AppView: React.FC<{ app: NonNullable<Beat['app']>; char: CharacterProfile }> = ({ app, char }) => {
    if (app.view === 'chat' && app.chat) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar px-4 py-4 space-y-2.5">
                <div className="text-center text-[10px] text-white/30 mb-2">{app.chat.name}</div>
                {app.chat.lines.map((l, i) => (
                    <div key={i} className={`flex ${l.me ? 'justify-end' : 'justify-start'} animate-fade-in`}
                        style={{ animationDelay: `${i * 320}ms`, animationFillMode: 'backwards' }}>
                        <div className={`px-3.5 py-2 rounded-2xl max-w-[74%] text-[13px] leading-relaxed ${l.me ? 'text-[#1a1530] rounded-br-md' : 'bg-white/[0.08] text-white/90 border border-white/[0.06] rounded-bl-md'}`}
                            style={l.me ? { background: ACCENT } : undefined}>
                            {l.text}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'compose' && app.compose) {
        const c = app.compose;
        return (
            <div className="h-full flex flex-col justify-end p-4">
                {c.to && <div className="text-[10px] text-white/30 mb-2 px-1">To: {c.to}</div>}
                <div className="rounded-2xl bg-white/[0.05] border border-white/[0.1] px-4 py-3 min-h-[52px] flex items-center">
                    <Typewriter drafts={c.drafts || []} sent={c.sent} placeholder="輸入消息…"
                        className="text-[14px] text-white/90 leading-relaxed" />
                </div>
                <div className="text-[10px] text-white/25 mt-2 px-1">
                    {c.sent ? '已發送' : '草稿已清空'}
                </div>
            </div>
        );
    }

    if (app.view === 'search' && app.search) {
        const qs = app.search.queries || [];
        const last = qs[qs.length - 1];
        const sent = last && !last.deleted ? last.q : null;
        const drafts = qs.slice(0, sent != null ? -1 : qs.length).map(x => x.q);
        return (
            <div className="h-full flex flex-col p-4">
                <div className="rounded-full bg-white/[0.06] border border-white/[0.1] px-4 py-2.5 flex items-center gap-2">
                    <MagnifyingGlass size={15} className="text-white/40" />
                    <Typewriter drafts={drafts} sent={sent} placeholder="搜索" className="text-[13.5px] text-white/85" />
                </div>
                <div className="text-[10px] text-white/25 mt-3 px-1">{app.search.engine || '搜索'}</div>
                <div className="flex-1 flex items-center justify-center">
                    {sent
                        ? <span className="text-[11px] text-white/30">為你找到相關結果…</span>
                        : <span className="text-[11px] text-white/25">— 沒有搜索 —</span>}
                </div>
            </div>
        );
    }

    if (app.view === 'photo' && app.photo) {
        const f = app.photo;
        return (
            <div className="h-full flex items-center justify-center p-6">
                <div className="w-full aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.08] relative"
                    style={{ background: `linear-gradient(155deg, ${f.tint || '#3a4a5a'}, #14161c)` }}>
                    <div className="absolute inset-0 flex items-center justify-center opacity-30"><ImageSquare size={44} weight="thin" className="text-white" /></div>
                    <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/65 to-transparent">
                        {f.date && <div className="text-[9px] text-white/45 tabular-nums">{f.date}</div>}
                        {f.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                    </div>
                </div>
            </div>
        );
    }

    if (app.view === 'music' && app.music) {
        const m = app.music;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-5 px-10">
                <div className="w-36 h-36 rounded-3xl flex items-center justify-center animate-bounce-slow" style={{ background: `linear-gradient(135deg, ${ACCENT}55, ${ACCENT}10)` }}>
                    <MusicNotes size={46} weight="fill" style={{ color: ACCENT }} />
                </div>
                <div className="text-center">
                    <div className="text-[15px] text-white font-medium">{m.song}</div>
                    <div className="text-[12px] text-white/45 mt-1">{m.artist}</div>
                </div>
                <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden"><div className="h-full w-1/3 rounded-full" style={{ background: ACCENT }} /></div>
                {m.state && <div className="text-[10px] text-white/30">{m.state}</div>}
            </div>
        );
    }

    if (app.view === 'notes' && app.notes) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-5">
                {app.notes.title && <div className="text-[15px] text-white font-medium mb-3">{app.notes.title}</div>}
                <div className="space-y-2.5">
                    {app.notes.items.map((it, i) => (
                        <div key={i} className="flex items-start gap-2.5 text-[13px] text-white/75">
                            <span className="w-4 h-4 rounded border border-white/20 mt-0.5 shrink-0" />
                            <span>{it}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (app.view === 'browser' && app.browser) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-4 space-y-2">
                <div className="text-[10px] text-white/30 px-1 mb-1">{app.browser.tabs.length} 個標籤頁</div>
                {app.browser.tabs.map((t, i) => (
                    <div key={i} className="rounded-xl bg-white/[0.04] border border-white/[0.07] px-3.5 py-3 flex items-center gap-2.5">
                        <Globe size={15} className="text-white/35 shrink-0" />
                        <span className="text-[12.5px] text-white/75 truncate">{t}</span>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'weather' && app.weather) {
        const w = app.weather;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3">
                <CloudSun size={56} weight="thin" className="text-white/70" />
                <div className="text-[52px] font-extralight text-white leading-none tabular-nums">{w.temp}°</div>
                <div className="text-[13px] text-white/55">{w.city} · {w.desc}</div>
            </div>
        );
    }

    return (
        <div className="h-full flex items-center justify-center px-8 text-center">
            <p className="text-[13.5px] text-white/70 leading-relaxed">{app.text || '…'}</p>
        </div>
    );
};

// ============================================================
//  SHARED CHROME
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; wallpaper?: string }> = ({ children, wallpaper }) => {
    // 傳進來的是角色見面背景的原始字段值（blobref 令牌 / 舊 data: / 外鏈），
    // 令牌喂不了 CSS url()，在這兒解析一次；非令牌值原樣透傳。
    const wallpaperUrl = useBlobRefUrl(wallpaper);
    return (
    <div className="absolute inset-0 z-[80] flex flex-col overflow-hidden text-white" style={{ background: '#07080c' }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(130% 80% at 50% 0%, #1a1726 0%, #0a0b12 60%, #07080c 100%)' }} />
        {wallpaperUrl && <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: `url("${wallpaperUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to bottom, rgba(7,8,12,0.4), rgba(7,8,12,0.2) 40%, rgba(7,8,12,0.9))' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
    );
};

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode; title?: string }> = ({ onBack, right, title }) => (
    // 頂部安全區：iOS 劉海/狀態欄會蓋住返回鍵和「生活記錄」，給個 safe-area-inset 兜底
    <div className="flex items-center justify-between px-4 shrink-0 pb-2"
        style={{ paddingTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        {title && <span className="text-[14px] font-semibold text-white">{title}</span>}
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// ============================================================
//  LIFE LOG (生活記錄) — sub-app
// ============================================================
export const LifeLog: React.FC<{
    targetChar: CharacterProfile;
    onBack: () => void;
    onReplay?: (log: PhoneSimLog) => void;
    onRequestDelete?: (log: PhoneSimLog) => void;
}> = ({ targetChar, onBack, onReplay, onRequestDelete }) => {
    const { addToast } = useOS();
    const logs = targetChar.phoneState?.simLogs || [];
    const [sent, setSent] = useState<Record<string, boolean>>({});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const cancelLongPress = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };
    const startLongPress = (e: React.PointerEvent, log: PhoneSimLog) => {
        if (!onRequestDelete || (e.target as HTMLElement).closest('button')) return;
        cancelLongPress();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            onRequestDelete(log);
        }, 520);
    };
    useEffect(() => () => cancelLongPress(), []);

    const sendLog = async (log: PhoneSimLog) => {
        if (sent[log.id]) return;
        try {
            const digest = log.memoryText ? `\n${log.memoryText}` : '';
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'sim_card',
                content: `【一段親身經歷 · ${log.title}】${digest}${log.summary ? `\n\n回過頭想：${log.summary}` : ''}`,
                metadata: { simCard: { mode: log.mode, theme: log.theme, title: log.title, summary: log.summary, ending: log.ending } },
            } as any);
            setSent(s => ({ ...s, [log.id]: true }));
            addToast('已作為回憶發送給 TA', 'success');
        } catch (e) { console.error(e); addToast('發送失敗，請重試', 'error'); }
    };
    return (
        <Shell wallpaper={targetChar.dateBackground}>
            <TopBar onBack={onBack} title="生活記錄" />
            <div className="px-6 pb-3 shrink-0">
                <p className="text-[11px] text-white/40 leading-relaxed">那些你以 TA 的身份活過的片段。TA 不會記得，但你會。</p>
                {logs.length > 0 && onRequestDelete && <p className="mt-1.5 text-[10px] text-white/25">長按記錄可刪除</p>}
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-10 space-y-3">
                {logs.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
                        <ClockCounterClockwise size={42} weight="light" />
                        <span className="text-xs">還沒有體驗記錄</span>
                    </div>
                )}
                {logs.map(log => (
                    <div key={log.id}
                        onPointerDown={(e) => startLongPress(e, log)}
                        onPointerUp={cancelLongPress}
                        onPointerLeave={cancelLongPress}
                        onPointerMove={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onContextMenu={(e) => {
                            if (!onRequestDelete || (e.target as HTMLElement).closest('button')) return;
                            e.preventDefault();
                            cancelLongPress();
                            onRequestDelete(log);
                        }}
                        className="rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up select-none">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: ACCENT, background: `${ACCENT}1f` }}>
                                {log.mode === 'daily' ? '日常' : '事件'} · {log.theme}
                            </span>
                            <span className="text-[9px] text-white/30 tabular-nums">{fmt(log.timestamp)}</span>
                        </div>
                        <div className="text-[15px] font-light text-white mb-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.title}</div>
                        {log.ending && <div className="text-[10px] text-white/40 mb-1.5">結局 · {log.ending}</div>}
                        <p className="text-[12.5px] text-white/60 leading-relaxed" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.summary}</p>
                        <div className="flex items-center justify-between mt-3 gap-2">
                            {log.buff?.label ? (
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px]" style={{ borderColor: `${log.buff.color || ACCENT}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || ACCENT}14` }}>
                                    <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                                </div>
                            ) : <span />}
                            <div className="flex items-center gap-2 shrink-0">
                                {onReplay && log.script?.beats?.length ? (
                                    <button onClick={() => onReplay(log)}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-semibold active:scale-95 transition border border-white/[0.12] text-white/80 bg-white/[0.05]">
                                        <ArrowClockwise size={12} weight="bold" /> 重播
                                    </button>
                                ) : null}
                                <button onClick={() => sendLog(log)} disabled={!!sent[log.id]}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-semibold active:scale-95 transition disabled:opacity-60"
                                    style={sent[log.id] ? { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' } : { background: ACCENT, color: '#1a1530' }}>
                                    {sent[log.id] ? <><Check size={12} weight="bold" /> 已發送</> : <><PaperPlaneTilt size={12} weight="fill" /> 發送給 TA</>}
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </Shell>
    );
};

// ============================================================
//  DIRECTOR PROMPT + PARSER
// ============================================================
// 把「最早一條消息距今多久」翻譯成給導演看的認識時長描述（閃回時間口徑護欄）
function describeAcquaintance(firstTs: number | undefined, userName: string, charName: string): string {
    if (!firstTs) {
        return `${charName} 與 ${userName} 還沒有可考的相處記錄（可能是初次接觸）。`;
    }
    const days = Math.floor((Date.now() - firstTs) / 86400000);
    let span: string;
    if (days <= 1) span = '不到一天';
    else if (days < 30) span = `約 ${days} 天`;
    else if (days < 365) span = `約 ${Math.floor(days / 30)} 個月`;
    else span = `約 ${(days / 365).toFixed(1)} 年`;
    return `${charName} 與 ${userName} 自首次接觸至今${span}（${days} 天）。`;
}

// 把演出腳本壓成「可讀梗概」——作為回憶發給角色時用這個（讓角色真的知道發生了什麼，
// 而不是只收到一句留白的收尾）。
function buildMemoryText(s: SimScript): string {
    const lines: string[] = [];
    for (const b of s.beats) {
        if (b.kind === 'end') continue;
        const t = b.time ? b.time + ' ' : '';
        const mono = b.monologue ? `（${b.monologue}）` : '';
        if (b.kind === 'thought') { if (b.monologue) lines.push(`${t}心裡：${b.monologue}`); continue; }
        if (b.kind === 'notification' && b.notif) { lines.push(`${t}${b.notif.app}通知：${b.notif.title}${b.notif.body ? ' ' + b.notif.body : ''}${mono}`); continue; }
        if (b.kind === 'flashback') { lines.push(`${t}相冊突然翻出${b.flashback?.label || '一張舊照片'}${b.flashback?.caption ? '：' + b.flashback.caption : ''}${mono}`); continue; }
        if (b.kind === 'lock') { lines.push(`${t}${b.notif ? `鎖屏，${b.notif.app}：${b.notif.title}` : '看了眼鎖屏'}${mono}`); continue; }
        if (b.kind === 'app' && b.app) {
            const a = b.app; let act = `打開${a.name}`;
            if (a.view === 'search' && a.search) act += `，搜：${a.search.queries.map(q => q.q).join(' → ')}`;
            else if (a.view === 'compose' && a.compose) act += a.compose.sent ? `，給${a.compose.to || '對方'}發了「${a.compose.sent}」` : `，打了字又刪了（${(a.compose.drafts || []).join('；')}）`;
            else if (a.view === 'chat' && a.chat) act += `，和${a.chat.name}：${a.chat.lines.map(l => (l.me ? '我:' : '對方:') + l.text).join(' ')}`;
            else if (a.view === 'photo' && a.photo) act += `，看一張照片${a.photo.caption ? '：' + a.photo.caption : ''}`;
            else if (a.view === 'music' && a.music) act += `，聽《${a.music.song}》${a.music.artist ? ' - ' + a.music.artist : ''}`;
            else if (a.view === 'notes' && a.notes) act += `，備忘錄：${(a.notes.items || []).join('；')}`;
            else if (a.view === 'browser' && a.browser) act += `，標籤頁：${(a.browser.tabs || []).join('；')}`;
            else if (a.view === 'weather' && a.weather) act += `，看天氣（${a.weather.temp}° ${a.weather.desc}）`;
            else if (a.text) act += `：${a.text}`;
            lines.push(`${t}${act}${mono}`);
        }
    }
    let text = lines.join('\n');
    if (text.length > 3200) text = text.slice(0, 3200) + '…';
    return text;
}

// 「本場變奏」——每次隨機抽幾根軸當硬約束，打破固定的起床→刷手機→睡覺流水帳
const vPick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
// 各基調對應的「情緒底色」候選池（喪是公共底子，差異在上層筆觸）
const MOOD_POOLS: Record<'depressive' | 'darkhumor' | 'cute', string[]> = {
    depressive: [
        '平靜鈍感，情緒幾乎貼著地面', '隱隱的煩躁，說不清為什麼',
        '麻木、抽離，像隔著一層玻璃', '懷念某個具體的人或時刻',
        '低度焦慮，反覆確認某件小事', '自我欺騙，嘴上一套、行為一套',
    ],
    darkhumor: [
        '把處境吐槽成段子，越離譜越想損兩句', '一本正經地做一件很荒誕的事，自己都覺得好笑',
        '用調侃和自嘲消解一切，沒什麼是不能拿來開玩笑的', '把糟心事說得稀鬆平常，透著一股冷幽默',
        '神經質的好笑，腦子裡全是怪念頭', '對自己的爛攤子幸災樂禍，黑色玩笑停不下來',
    ],
    cute: [
        '行為裡冒出一股傻氣和俏皮', '小題大做地認真，可愛又好笑',
        '幼稚的小執拗，像個長不大的小孩', '自娛自樂，給自己找些無聊但開心的小樂子',
        '輕飄飄的，對小事莫名上頭', '一驚一乍、活潑跳脫，情緒都寫在臉上',
    ],
};

function buildVariation(tone: 'mix' | 'depressive' | 'darkhumor' | 'cute' = 'mix'): string {
    const entry = vPick([
        '從一個不起眼的中間時刻切入（絕不要從「起床/醒來/關鬧鐘」開始）',
        '從午後犯困、注意力渙散的那一刻切入',
        '從黃昏、天快黑了還沒開燈的那一刻切入',
        '從深夜睡不著、第無數次點亮屏幕切入',
        '從通勤/在路上、單手劃手機切入',
        '從被一條通知突然打斷的瞬間切入',
        '從一件正做到一半的事中途切入',
    ]);
    const span = vPick([
        '整場只覆蓋十幾分鐘的一個片段，密度高、範圍小',
        '只覆蓋某半天裡零散的幾個空隙',
        '在同一個時刻反覆回返（時間幾乎沒走，心思在原地打轉）',
        '跨越深夜到天亮前的一小段',
        '一天裡互不相連的三四個碎片，跳著來',
    ]);
    const structure = vPick([
        '整場幾乎圍繞「一個 App」展開，很少離開它',
        '整場圍繞「一件小物 / 一條未讀 / 一張舊圖」打轉',
        '在兩件不相干的事之間反覆橫跳',
        '大量留白，幾乎什麼都沒發生，靠空氣感和零碎動作撐',
        '被一個突發（來電/通知/沒電）打斷後，再也沒回到原來的事',
        '線性但克制，靠細節而非情節推進',
    ]);
    const medium = vPick([
        '以「搜了又刪、刪了又搜」為主要表達',
        '以「翻看相冊」為主要表達',
        '以「打字→刪除→再打字」的反覆為主要表達',
        '以「一首歌單曲循環 + 走神」為主要表達',
        '以「和某一個聯繫人有一搭沒一搭的聊天」為主要表達',
        '以「一堆與主線無關的環境碎片（通知/待辦/標籤頁/購物車）」為主要表達',
    ]);
    const moodPool = tone === 'mix'
        ? [...MOOD_POOLS.depressive, ...MOOD_POOLS.darkhumor, ...MOOD_POOLS.cute]
        : MOOD_POOLS[tone];
    const mood = vPick(moodPool);
    const anchor = vPick([
        '一杯早就涼掉的咖啡/茶', '一條打好了卻沒發出去的消息', '一張忘了刪的截圖',
        '一個掛了半年的待辦', '一首單曲循環的歌', '一個一直沒人回的群',
        '一條快遞的物流頁', '一個總點開又退出的頁面', '一張存了很久沒再看的照片',
        '一個刪到一半的草稿',
    ]);
    return `### [本場變奏 · 必須嚴格遵守，讓這一場和上一場截然不同]
- 切入：${entry}
- 跨度：${span}
- 結構：${structure}
- 主導表達：${medium}
- 情緒底色：${mood}
- 具體錨點：讓這一場反覆回到「${anchor}」上（可改寫成更貼合人設的同類小物）
※ 嚴禁套路化：不要從「起床/關鬧鐘/看天氣」開場，也不要默認以「睡覺/鎖屏」收尾，更不要走「醒來→刷一圈微信微博→睡覺」的流水帳。下方字段示例只演示 JSON 格式，時間和內容一律按本場變奏來。`;
}

// user 存在感三檔（這一天裡"你"佔多少分量）
function buildPresenceRule(presence: 'default' | 'light' | 'none', userName: string): string {
    const u = userName || '用戶';
    switch (presence) {
        case 'none':
            return `這一天**完全是 TA 自己的人生**：${u} 不出現、不被想起、不被尋找。即使 TA 記憶裡有 ${u}，這一天也絕不浮現。所有消息、念頭、痕跡都由 TA 自己的生活與其他人構成，絕對不要出現、暗示、惦記 ${u}。`;
        case 'light':
            return `${u} 只是**極淡的背景**——整場重心是 TA 自己。最多偶爾掃過一條 ${u} 的舊消息、一閃而過的一個念頭，點到即止，絕不聚焦、不展開、不圍著 ${u} 轉。`;
        default:
            return `${u} 是 TA 生活裡**自然存在的一條線**——可以有 ${u} 的消息、對 ${u} 的惦記、痕跡裡出現 ${u}，關係與平時聊天一致；但此刻 ${u} 不在場，不要替 ${u} 說話或行動。`;
    }
}

// 演出基調：喪始終是底子，差異在上層筆觸
function buildToneRule(tone: 'mix' | 'depressive' | 'darkhumor' | 'cute'): string {
    switch (tone) {
        case 'depressive':
            return `【本場基調：致鬱】純粹的低氣壓——鈍感、麻木、克制、貼著地面。不要插科打諢，不要俏皮，讓情緒安安靜靜地泡著。`;
        case 'darkhumor':
            return `【本場基調：黑色幽默】要有**神經質的好笑**——self-aware 的自嘲、把糟心事講成段子、一本正經地做荒誕的事、越離譜越好笑。參考《安迪和莉莉的棺材》那種味道：可愛的皮、荒誕的裡，冷不丁戳你一下。表達可以毒舌、跳脫、停不下來。`;
        case 'cute':
            return `【本場基調：輕盈可愛】筆觸**俏皮、輕盈、帶點傻氣和萌**——小題大做、幼稚的小執拗、自娛自樂、對無聊小事莫名上頭。像素小可愛那種活潑可愛感，整場輕鬆、不壓抑。`;
        default:
            return `【本場基調：隨心】基調隨「情緒底色」自然流動——可平靜、可黑色幽默、可俏皮輕盈，允許一場之內有起伏，不必固定在某一種情緒上。`;
    }
}

function buildDirectorPrompt(context: string, recent: string, mode: 'daily' | 'event', theme: string, name: string, acquaintance: string, userName: string, presence: 'default' | 'light' | 'none', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute'): string {
    return `${context}

### [最近的聊天上下文]
${recent || '（暫無最近對話）'}

### [導演任務：手機人生演出 Screenlife]
你現在是一位沉浸式敘事導演。請把「${name}」的一段人生，編排成一場**以手機為載體的第一人稱演出**。
體驗類型：${mode === 'daily' ? '日常模擬（普通日子，重生活感與陪伴）' : '事件模擬（特殊事件，重情緒張力）'}
體驗內容：「${theme}」
關係時間線（重要護欄）：${acquaintance}
你的存在感（${userName || '用戶'}在這一天裡的位置 · 必須嚴格遵守）：${buildPresenceRule(presence, userName)}
${buildToneRule(tone)}

觀眾（用戶）將**成為 ${name}**，通過 TA 使用手機的行為，親身經歷這段時間。

${buildVariation(tone)}

【鐵律】
1. 不要把故事講出來，不要解釋人物，不要分析情緒，不要總結意義。一切通過**手機行為 / 數字痕跡 / 內心獨白 / 環境碎片**自然呈現。
2. 內心獨白（monologue）要**大量出現**，但**極其口語、簡短、真實**，像真實人腦活動。例如：「不想起床。」「算了。」「她怎麼還沒回我。」「應該沒事吧。」「其實有點在意。」禁止文學腔、禁止解釋劇情。
3. **非可靠敘事**：TA 說的/想的不一定是真相，允許自我安慰、自我欺騙、逃避、美化記憶、誤解他人。讓行為去拆穿獨白（例如嘴上說「我根本不在意」，卻反覆打開同一個聊天窗口）。
4. **數字行為優先**：多用「打字後刪除(compose)」「搜索後刪除再搜(search)」「翻看舊照片」「反覆打開同一頁面」「消息撤回」來表達，而不是直接說出情緒。
5. **真實手機感**：可穿插與主線無關的真實手機事件——來電、電量不足、驗證碼、快遞通知、垃圾短信、天氣預警、自動續費、各種推送。它們不一定推動劇情，但增強真實。
6. **環境碎片**：可出現與主線無關的痕跡——沒做完的待辦、半年前的截圖、忘記刪的照片、一堆瀏覽器標籤、購物車、舊鬧鐘、收藏夾。這些共同拼出 TA 的人格。
7. **情緒高潮放慢節奏**：關鍵節點用「打開→關閉→重新打開→停頓→鎖屏→再打開→輸入→刪除→輸入→刪除→最終發送(或不發)」這種反覆的 beat 序列製造張力，並把這些 beat 的 pace 設為 3。
8. 【記憶閃回 · 務必先判斷是否合理，寧可不插也不要 OOC】閃回是 ${name} **自己的一段過去突然闖進現在**（相冊自動彈出一張舊照片→沉默→什麼都不說→繼續今天，殺傷力來自“過去闖進現在”）。但是否插入、用什麼時間口徑，必須嚴格符合人設與世界觀：
   - 時間標籤(label)由你決定，必須與上面的「關係時間線」以及角色自身的人生階段/世界觀自洽。例如真的相識一年以上才用「去年今日」；幾個月就用「三個月前的今天」「那天」；剛認識或時間線不支持，**絕不要**用「去年」。
   - 照片不一定與用戶有關，可以是 ${name} 自己更早的人生片段（地方、人、物）。
   - 如果該角色的設定/世界觀里根本沒有「拍照片 / 現代時間感 / 可追溯的過去」，或任何閃回都會顯得突兀 OOC，就**完全不要**加 flashback beat。
   - ${mode === 'event' ? '事件模擬下，若合理，優先安排一次閃回來強化情緒；若不合理則跳過。' : '日常模擬下，僅在某個安靜且合理的時刻擇機插入，可有可無。'}

【下猛料 · 密度 / 強度 / 具體度（這一段優先級最高，別給我收著）】
- **要長、要滿**：這是一場完整演出，不是預告片。beats 給足 **40~64 個**，疏密有致但總量寧多勿少。
- **每一步都有戲**：絕大多數 beat 都帶 monologue；獨白可以接連成串——一個動作配 2~3 個跳躍、互相打架的念頭，讓腦子真的"在轉"。
- **往死裡具體**：用真實的名字、店名、歌名、金額、時間、對話原話、搜索詞。**拒絕**「某人 / 某件事 / 一條消息 / 一首歌」這種含糊佔位，每個細節都要像真有其事，能拼出一個活人。
- **數字行為往狠裡堆**：compose 的「打了又刪」至少 2~3 次且每次草稿不同、search 的「搜了又刪」至少一串 3~4 條層層遞進（越搜越露底）、再穿插消息撤回 / 反覆開同一頁 / 已讀不回 / 對方"正在輸入…"又停了。
- **高潮要夠長夠窒息**：把關鍵節點拉成 **8~12 個連續 beat**（開→關→重開→停頓→鎖屏→再開→輸入→刪→輸入→刪→…→最終發送或最終沒發），全程 pace=3，把"手指懸在發送鍵上"的勁兒磨出來。
- **環境碎片撒厚**：購物車裡躺著什麼、半年前的待辦寫了什麼、瀏覽器開著哪些標籤、相冊某張圖是哪天——具體到刺人。
- **敢於不體面**：真實的人會走神、會反覆確認、會自欺、會因一件小事突然破防。別替 TA 美化、克制成一張白紙——該狼狽就狼狽，該上頭就上頭。
- **結尾要"落地"，不要"斷電"**：高潮之後**必須**有 3~6 個 beat 的收束——情緒慢慢沉下來、做一個最終的小動作（放下手機 / 關燈 / 最後看一眼那條消息 / 輕輕鎖屏），pace 回落到 1~2；倒數第二拍用一句 thought 或一個 lock 給整場一個情緒落點，讓觀眾真切感到"這一段，結束了"。**絕不能停在動作中途或高潮頂點就 end**。end 永遠是收束之後的最後一拍，不是急剎車。

【輸出格式】嚴格輸出**一個 JSON 對象**（不要任何額外文字、不要 markdown 代碼塊），結構如下：
{
  "title": "演出標題（如：普通的週二）",
  "ending": "可選，這次的結局版本標籤（如：最終沒有發送）",
  "summary": "1-2 句收尾，客觀留白，不解釋",
  "buff": { "name": "英文key", "label": "中文情緒標籤(4-8字)", "emoji": "1個emoji", "color": "#hex", "intensity": 1|2|3, "description": "一句給AI看的情緒底色" },
  "beats": [ ... 40~64 個 beat，寧多勿少 ... ]
}

每個 beat 是一個對象，必含 "kind"，按需含 "time"(HH:MM)、"monologue"、"pace"(1普通/2稍慢/3高潮)、"vibe"。
**"vibe" 決定這段文字的視覺演出**，請根據 TA 此刻的情緒狀態給 thought / 關鍵 monologue 標註，取值：
  - "calm" 平靜（默認，文字居中緩緩敲出）
  - "chaotic" 混亂崩潰（文字會鋪天蓋地散落滿屏——情緒越亂越適合）
  - "happy" 開心（粉色字 + 飄飄上浮的小裝飾）
  - "anxious" 焦慮（文字緊繃、發紅、輕微脈動）
  - "numb" 麻木空洞（文字冷淡、縮小、大片留白）
  - "tender" 溫柔/眷戀（柔光）
kind 取值與字段：
- {"kind":"lock","time":"07:12","notif":{"app":"鬧鐘","title":"...","body":"..."},"monologue":"不想起床。"}  // 鎖屏/亮屏
- {"kind":"thought","monologue":"算了。","vibe":"numb"}  // 純內心獨白；情緒強烈時務必給 vibe（如崩潰→"chaotic"、雀躍→"happy"）
- {"kind":"notification","notif":{"app":"微信","title":"...","body":"...","tone":"push|sms|system|flashback"},"monologue":"..."}  // 橫幅通知
- {"kind":"app","app":{"name":"微信","view":"chat","chat":{"name":"媽","lines":[{"me":false,"text":"吃飯了嗎"},{"me":true,"text":"吃了"}]}}}
- {"kind":"app","app":{"name":"微信","view":"compose","compose":{"to":"她","drafts":["在嗎","你最近還好嗎"],"sent":null}}}  // 打字後刪除；sent=null表示最終沒發，sent填字符串表示最終發送
- {"kind":"app","app":{"name":"搜索","view":"search","search":{"engine":"百度","queries":[{"q":"失眠怎麼辦","deleted":true},{"q":"長期睡不好會死嗎","deleted":true},{"q":"貓為什麼半夜叫"}]}}}
- {"kind":"app","app":{"name":"相冊","view":"photo","photo":{"caption":"...","date":"2024-06-19","tint":"#5a6a7a"}}}
- {"kind":"app","app":{"name":"音樂","view":"music","music":{"song":"...","artist":"...","state":"單曲循環"}}}
- {"kind":"app","app":{"name":"備忘錄","view":"notes","notes":{"title":"待辦","items":["...","..."]}}}
- {"kind":"app","app":{"name":"瀏覽器","view":"browser","browser":{"tabs":["...","..."]}}}
- {"kind":"app","app":{"name":"天氣","view":"weather","weather":{"city":"...","temp":22,"desc":"多雲"}}}
- {"kind":"flashback","time":"15:00","flashback":{"label":"三個月前的今天","caption":"...","date":"...","tint":"#4a3a5a"},"monologue":""}  // 記憶閃回(可選)，label=自洽的時間口徑，monologue留空=沉默
- {"kind":"end","time":"23:40"}  // 最後一個 beat 必須是 end

請嚴格貼合上面的【本場變奏】，並把【下猛料】那段吃透：beats 給足 40~64 個、獨白密集、細節具體、數字行為反覆、高潮拉長、結尾收束落地。**務必保證 JSON 完整閉合、結尾收好**——若篇幅吃緊，寧可砍掉幾個中段 beat，也要留足收尾、把括號全部閉合，絕不允許寫到一半被截斷。直接輸出 JSON 對象。`;
}

export default PersonaSim;
