import React, { useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile } from '../../types';
import { BRIEF_PERSONA_MAX, generateBriefPersona, isBriefPersonaStale } from '../../utils/briefPersona';
import { trackEvent } from '../../utils/analytics';

interface Props {
    char: CharacterProfile;
    apiConfig: APIConfig;
    onChange: (patch: Pick<CharacterProfile, 'briefPersona' | 'briefPersonaSource'>) => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

/**
 * 神經鏈接 · 角色編輯頁的「精簡人設」（見 utils/briefPersona.ts）：可以手寫，也可以按「AI 生成」從上面的
 * 人設壓縮。生成的會記下是照哪一版人設生成的，人設改過就提示重新生成；手寫或手改過就不再提示。
 */
const BriefPersonaField: React.FC<Props> = ({ char, apiConfig, onChange, addToast }) => {
    const [busy, setBusy] = useState(false);
    const value = char.briefPersona || '';
    const stale = isBriefPersonaStale(char);

    const handleGenerate = async () => {
        if (busy) return;
        if (!char.systemPrompt?.trim() && !char.description?.trim()) { addToast('先填上面的人設，才有東西可以壓縮', 'info'); return; }
        setBusy(true);
        try {
            const { text, source } = await generateBriefPersona(char, apiConfig);
            onChange({ briefPersona: text, briefPersonaSource: source });
            trackEvent('生成精简人设');
            addToast('已生成精簡人設，看一下合不合適，可以直接改', 'success');
        } catch (e: any) {
            addToast(e?.message || '生成失敗', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">精簡人設 (Brief Persona)</label>
                <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1 text-[11px] font-bold text-white active:scale-95 disabled:opacity-50"
                >
                    <Sparkle size={12} weight="fill" /> {busy ? '生成中…' : value ? '重新生成' : 'AI 生成'}
                </button>
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                給其他角色參考的 100～200 字簡介：朋友圈替 TA 留言、別的角色手機裡提到 TA 時，靠這段抓準 TA 怎麼說話、話多還是話少。TA 自己的私聊照舊用完整人設。
            </p>
            {stale && (
                <div className="mb-2 rounded-2xl bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                    上面的人設改過了，這段可能跟不上，要不要按「重新生成」？
                </div>
            )}
            <textarea
                value={value}
                // 手寫或手改過：不再照舊版人設判斷過期
                onChange={e => onChange({ briefPersona: e.target.value, briefPersonaSource: undefined })}
                maxLength={BRIEF_PERSONA_MAX + 50}
                className="w-full h-28 bg-white rounded-3xl p-5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll"
                placeholder="按「AI 生成」從上面的人設自動壓縮，或自己寫 100～200 字：一句身份、性格、說話方式、話量、對熟人和生人的差別…"
            />
            <div className="mt-1 text-right text-[10px] text-slate-300">{value.length} 字</div>
        </div>
    );
};

export default BriefPersonaField;
