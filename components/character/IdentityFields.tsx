import React, { useEffect, useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile } from '../../types';
import { ALIAS_MAX_COUNT, ROLE_TITLE_MAX_LENGTH, formatAliasInput, parseAliasInput } from '../../utils/charIdentity';
import { applyIdentityFill, generateIdentityFill, hasIdentityFillSource } from '../../utils/charIdentityFill';

type IdentityPatch = Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle' | 'description'>>;

interface Props {
    char: CharacterProfile;
    /** 「AI 幫我填」用哪組：副 API 有設就用，不然全域 */
    api: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>;
    onChange: (patch: IdentityPatch) => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

const LABEL = 'mb-1 block text-[11px] font-bold text-slate-500';
const INPUT = 'w-full rounded-2xl bg-white px-4 py-2.5 text-sm text-slate-700 shadow-sm outline-none placeholder:text-slate-400 focus:ring-1 focus:ring-primary/20';
const HINT = 'mt-1 text-[11px] leading-relaxed text-slate-400';

/**
 * 神經鏈接 · 角色頁名字下面的三格：別名、身份／職位、簡介（plans/character-identity-fields.md）。
 * 以前只有一格「描述」。「AI 幫我填」讀人設出建議：空的格子直接填，有字的格子不蓋、把建議列在底下讓人自己換。
 */
const IdentityFields: React.FC<Props> = ({ char, api, onChange, addToast }) => {
    // 別名打字時不能每個字都整理（會把剛打的逗號吃掉），失焦才收成陣列
    const [aliasDraft, setAliasDraft] = useState(formatAliasInput(char.aliases));
    const [busy, setBusy] = useState(false);
    const [suggestions, setSuggestions] = useState<{ roleTitle?: string; brief?: string }>({});
    const aliasKey = (char.aliases || []).join('\u0001');
    useEffect(() => { setAliasDraft(formatAliasInput(char.aliases)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [char.id, aliasKey]);
    useEffect(() => { setSuggestions({}); }, [char.id]);

    const commitAliases = () => {
        const next = parseAliasInput(aliasDraft, char.name);
        setAliasDraft(formatAliasInput(next));
        if (next.join('\u0001') !== aliasKey) onChange({ aliases: next.length ? next : undefined });
    };

    const fill = async () => {
        if (busy) return;
        if (!hasIdentityFillSource(char)) { addToast('先填下面的人設，才有東西可以讀', 'info'); return; }
        setBusy(true);
        try {
            const result = await generateIdentityFill(char, api);
            const { patch, suggestions: left, filled } = applyIdentityFill(char, result);
            if (Object.keys(patch).length) onChange(patch);
            setSuggestions(left);
            const hasLeft = !!(left.roleTitle || left.brief);
            addToast(filled.length ? `填好了：${filled.join('、')}${hasLeft ? '；有字的格子沒動，建議列在底下' : ''}` : hasLeft ? '格子裡都有字了，建議列在底下，要換再點' : '讀出來的跟現在一樣', filled.length || hasLeft ? 'success' : 'info');
        } catch (e: any) {
            addToast(e?.message || '沒讀成功，再試一次', 'error');
        } finally {
            setBusy(false);
        }
    };

    const suggestion = (text: string | undefined, field: 'roleTitle' | 'description', key: 'roleTitle' | 'brief') => (text ? (
        <div className="mt-1.5 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
            <span className="min-w-0 flex-1 break-words">AI 建議：{text}</span>
            <button type="button" className="shrink-0 font-bold underline-offset-2 hover:underline"
                onClick={() => { onChange({ [field]: text }); setSuggestions(prev => ({ ...prev, [key]: undefined })); }}>換成這個</button>
        </div>
    ) : null);

    return (
        <div className="space-y-3" data-identity-fields>
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">別名 · 身份 · 簡介</span>
                <button type="button" onClick={() => void fill()} disabled={busy}
                    className="flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1 text-[11px] font-bold text-white active:scale-95 disabled:opacity-50">
                    <Sparkle size={12} weight="fill" /> {busy ? '讀人設中…' : 'AI 幫我填'}
                </button>
            </div>

            <label className="block">
                <span className={LABEL}>別名</span>
                <input value={aliasDraft} onChange={e => setAliasDraft(e.target.value)} onBlur={commitAliases}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    aria-label="別名" placeholder="Vivian、陸姐（用逗號或頓號分開）" className={INPUT} />
                <span className={`${HINT} block`}>TA 本來就有的其他名字：本名、英文名、綽號、圈名，最多 {ALIAS_MAX_COUNT} 個。妳自己對 TA 的叫法不是填這裡，在聊天設定的「暱稱」。</span>
            </label>

            <label className="block">
                <span className={LABEL}>身份／職位</span>
                <input value={char.roleTitle || ''} maxLength={ROLE_TITLE_MAX_LENGTH}
                    onChange={e => onChange({ roleTitle: e.target.value || undefined })}
                    aria-label="身份／職位" placeholder="攝影師、段家長子、大三學生" className={INPUT} />
                {suggestion(suggestions.roleTitle, 'roleTitle', 'roleTitle')}
            </label>

            <label className="block">
                <span className={LABEL}>簡介</span>
                <input value={char.description || ''} onChange={e => onChange({ description: e.target.value })}
                    aria-label="一句話簡介" placeholder="一句話介紹，例如「嘴甜心硬的前輩」" className={INPUT} />
                {suggestion(suggestions.brief, 'description', 'brief')}
                <span className={`${HINT} block`}>身份和簡介會顯示在各種清單上名字的下面，也會讓其他角色知道 TA 是誰。完整的人設寫在下面。</span>
            </label>
        </div>
    );
};

export default IdentityFields;
