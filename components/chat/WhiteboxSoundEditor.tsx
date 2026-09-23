import React, { useRef, useState } from 'react';
import { readShareText } from '../../utils/pngShare';
import { shareOrDownloadFile } from '../../utils/shareExport';
import {
    BUILTIN_SOUNDS,
    WhiteboxSound,
    playWhiteboxSound,
    unlockWhiteboxAudio,
    isCustomAudioSrc,
    encodeSoundShare,
    decodeSoundShare,
} from '../../utils/whiteboxSound';

// 白框「提示音」編輯器（獨立於白框 CSS）。
//
// 觸發時機（播放邏輯見 apps/Chat.tsx）：僅當"ta 新發的消息"成為會話最後一條時響一次；
// 你自己發消息 / 翻舊記錄都不會響。
//
// 存儲與分享：
// - 默認「解綁」——提示音獨立存在角色字段裡，樣式分享碼保持輕量、純 CSS。提示音可用下方「分享碼」單獨傳。
// - 打開「綁定到進階樣式」——提示音會寫進白框 CSS 的指令註釋，跟白框一起分享出去（隨時可解綁）。
// 本組件不關心存哪，只吐出 (sound, bound) 的變化，落地位置由 Chat.tsx 決定。

// 上傳音頻轉 data URI 的體積上限：綁定分享時會進分享碼，太大會爆；提示音本就該短，200KB 足夠。
const MAX_UPLOAD_BYTES = 200 * 1024;

const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

const copyText = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
};

interface Props {
    sound: WhiteboxSound | null;
    onChangeSound: (sound: WhiteboxSound | null) => void;
    /** 「綁定到進階樣式」開關；全局默認提示音不涉及綁定，傳 false 隱藏。默認顯示。 */
    showBind?: boolean;
    bound?: boolean;
    onChangeBound?: (bound: boolean) => void;
    /** 頂部提示條文案（區分「角色版」與「全局默認版」）。 */
    hint?: React.ReactNode;
}

const WhiteboxSoundEditor: React.FC<Props> = ({ sound, onChangeSound, showBind = true, bound = false, onChangeBound, hint }) => {
    const volume = sound?.volume ?? 0.6;
    const src = sound?.src || '';
    const isBuiltin = !!BUILTIN_SOUNDS[src];
    const isCustom = !!src && isCustomAudioSrc(src);
    const isUpload = isCustom && !/^https?:/i.test(src);

    const [urlDraft, setUrlDraft] = useState(isCustom && /^https?:/i.test(src) ? src : '');
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const pickBuiltin = (key: string) => {
        unlockWhiteboxAudio();
        const next = { src: key, volume };
        onChangeSound(next);
        playWhiteboxSound(next); // 點一下即試聽
    };

    const setVolume = (v: number) => {
        if (!src) return;
        onChangeSound({ src, volume: v });
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (!file.type.startsWith('audio/')) { window.alert('請選擇音頻文件（mp3 / wav / ogg 等）。'); return; }
        if (file.size > MAX_UPLOAD_BYTES) {
            window.alert(`音頻太大（${Math.round(file.size / 1024)}KB）。綁定到進階樣式分享時會進分享碼，請用 ≤ ${MAX_UPLOAD_BYTES / 1024}KB 的短提示音，或改用「音頻 URL」。`);
            return;
        }
        setBusy(true);
        try {
            const dataUrl = await readFileAsDataUrl(file);
            unlockWhiteboxAudio();
            const next = { src: dataUrl, volume };
            onChangeSound(next);
            playWhiteboxSound(next);
        } catch {
            window.alert('讀取音頻失敗，請換個文件重試。');
        } finally {
            setBusy(false);
        }
    };

    const applyUrl = () => {
        const u = urlDraft.trim();
        if (!u) return;
        if (!/^https?:\/\//i.test(u)) { window.alert('請填寫 http(s):// 開頭的音頻直鏈。'); return; }
        unlockWhiteboxAudio();
        const next = { src: u, volume };
        onChangeSound(next);
        playWhiteboxSound(next);
    };

    const clearSound = () => { onChangeSound(null); setUrlDraft(''); };

    const handleShareExport = async () => {
        if (!sound) return;
        const ok = await copyText(encodeSoundShare(sound));
        window.alert(ok ? '已複製提示音分享碼，發給別人粘貼導入即可（不含界面樣式）。' : '複製失敗，請重試。');
    };
    const handleShareImport = () => {
        const code = window.prompt('粘貼提示音分享碼（SULLYSND1:...）：', '')?.trim();
        if (!code) return;
        importSoundCode(code);
    };
    const importSoundCode = (code: string) => {
        const incoming = decodeSoundShare(code);
        if (!incoming) { window.alert('分享碼無法識別，請確認完整粘貼。'); return; }
        unlockWhiteboxAudio();
        onChangeSound(incoming);
        playWhiteboxSound(incoming);
    };

    const chipCls = (active: boolean) =>
        `rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all active:scale-95 ${
            active ? 'bg-indigo-500 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
        }`;

    return (
        <div className="space-y-4">
            <div className="rounded-2xl border border-amber-100 bg-amber-50/70 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-700">
                {hint ?? <>🔔 提示音只在 <b>ta 新發的消息成為最新一條</b> 時響一次；你自己發消息、翻舊記錄都不會響。</>}
            </div>

            {/* 內置音效 */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">內置音效 <span className="font-normal text-slate-400">· 點一下試聽並選用</span></div>
                <div className="flex flex-wrap gap-1.5">
                    {Object.entries(BUILTIN_SOUNDS).map(([key, s]) => (
                        <button key={key} onClick={() => pickBuiltin(key)} className={chipCls(isBuiltin && src === key)}>
                            {isBuiltin && src === key ? '✓ ' : ''}{s.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 上傳 / URL */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">自定義 <span className="font-normal text-slate-400">· 上傳音頻（≤200KB）或填直鏈</span></div>
                <div className="flex flex-wrap items-center gap-2">
                    <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleUpload} />
                    <button
                        onClick={() => fileRef.current?.click()}
                        disabled={busy}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-100 disabled:opacity-50"
                    >{busy ? '讀取中…' : '⬆ 上傳音頻文件'}</button>
                    {isUpload && (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-600">已內嵌上傳音頻 ✓</span>
                    )}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                    <input
                        value={urlDraft}
                        onChange={(e) => setUrlDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
                        placeholder="https://…/ding.mp3"
                        className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] text-slate-600 outline-none focus:border-indigo-300"
                    />
                    <button onClick={applyUrl} className="shrink-0 rounded-xl bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-200">用此鏈接</button>
                </div>
            </div>

            {/* 音量 + 試聽 + 關閉 */}
            <div>
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500">音量</span>
                    <span className="text-[10px] text-slate-400">{Math.round(volume * 100)}%</span>
                </div>
                <input
                    type="range" min={0} max={1} step={0.05} value={volume}
                    disabled={!src}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    className="w-full accent-indigo-500 disabled:opacity-40"
                />
                <div className="mt-3 flex items-center gap-2">
                    <button
                        onClick={() => { unlockWhiteboxAudio(); playWhiteboxSound(sound); }}
                        disabled={!src}
                        className="rounded-xl bg-indigo-500 px-4 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-600 disabled:opacity-40"
                    >▶ 試聽</button>
                    {src && (
                        <button onClick={clearSound} className="rounded-xl px-3 py-1.5 text-[11px] font-semibold text-rose-400 hover:bg-rose-50 hover:text-rose-500">關閉提示音</button>
                    )}
                    <span className="ml-auto text-[10px] text-slate-400">
                        {src ? (isBuiltin ? '當前：內置音效' : '當前：自定義音頻') : '當前：無'}
                    </span>
                </div>
            </div>

            {/* 綁定到進階樣式 開關（全局默認版不顯示） */}
            {showBind && (
                <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-3.5 py-3">
                    <label className="flex cursor-pointer items-start gap-3">
                        <input
                            type="checkbox"
                            checked={bound}
                            onChange={(e) => onChangeBound?.(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500"
                        />
                        <span className="min-w-0">
                            <span className="block text-[12px] font-bold text-slate-700">綁定到進階樣式一起分享</span>
                            <span className="block text-[10px] leading-snug text-slate-400">
                                {bound
                                    ? '已綁定：分享這套樣式時會帶上提示音（上傳的音頻會進分享碼，可能變大）。'
                                    : '未綁定：樣式分享碼保持輕量、只含皮膚；提示音用下方分享碼單獨傳。'}
                            </span>
                        </span>
                    </label>
                </div>
            )}

            {/* 提示音獨立分享碼 */}
            <div className="flex flex-wrap gap-2">
                <label className="cursor-pointer rounded-lg px-2.5 py-1 text-[10px] font-semibold text-indigo-500">圖片導入
                    <input type="file" accept=".png,.txt,image/png,text/plain" className="sr-only" onChange={async event => {
                        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
                        try { importSoundCode(await readShareText(file, 'whitebox-sound')); }
                        catch (error: any) { window.alert(error?.message || '提示音導入失敗'); }
                    }} />
                </label>
                <button disabled={!sound} className="rounded-lg px-2.5 py-1 text-[10px] font-semibold text-indigo-500 disabled:opacity-30" onClick={async () => {
                    if (!sound) return;
                    try { await shareOrDownloadFile({ content: encodeSoundShare(sound), fileName: '白框提示音.txt', mimeType: 'text/plain', card: { kind: 'whitebox-sound', title: '白框提示音' } }); }
                    catch (error: any) { window.alert(error?.message || '提示音導出失敗'); }
                }}>圖片分享</button>
            </div>
            <div className="flex items-center gap-2">
                <button onClick={handleShareImport} className="rounded-lg px-2.5 py-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600">導入分享碼</button>
                <button onClick={handleShareExport} disabled={!sound} className={`rounded-lg px-2.5 py-1 text-[10px] font-semibold ${sound ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-slate-300'}`}>導出分享碼</button>
                <span className="ml-auto text-[10px] text-slate-300">SULLYSND1 · 單獨分享提示音</span>
            </div>
        </div>
    );
};

export default WhiteboxSoundEditor;
