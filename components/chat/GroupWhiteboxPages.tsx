import React from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft } from '@phosphor-icons/react';
import type { CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import ChromeCssEditor from './ChromeCssEditor';
import WhiteboxSoundEditor from './WhiteboxSoundEditor';
import DecorationPreview from '../decoration/DecorationPreview';
import { CHARACTER_DECORATION_RESET } from '../../utils/decorationTemplates';
import { parseWhiteboxSound, stripWhiteboxSoundDirective, upsertWhiteboxSound, type WhiteboxSound } from '../../utils/whiteboxSound';

/**
 * 群聊裡「直接改這個群的白框 CSS」和「提示音」兩頁。原本是從底下跳出來的半窗、而且留在聊天畫面裡面
 * （白框 CSS 寫 `.sully-chat-root button` 會連這兩頁的按鈕一起染）；現在是全螢幕頁、掛到 body。
 * 改了馬上寫進群（跟原本一樣），返回鍵只是關掉。
 */
const Shell: React.FC<{ title: string; subtitle: string; onClose: () => void; children: React.ReactNode; dataAttr: string }> = ({ title, subtitle, onClose, children, dataAttr }) => createPortal(
    <div className="fixed inset-0 z-[110] flex flex-col bg-slate-50 text-slate-800 animate-fade-in" onClick={e => e.stopPropagation()} {...{ [dataAttr]: '' }}>
        <div className="shrink-0 border-b border-slate-100 bg-white/95 backdrop-blur" style={{ paddingTop: 'var(--safe-top)' }}>
            <div className="flex items-center gap-2 px-3 py-2.5">
                <button type="button" onClick={onClose} aria-label="返回" className="rounded-full p-1.5 hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold">{title}</div>
                    <div className="truncate text-[10px] text-slate-400">{subtitle}</div>
                </div>
            </div>
        </div>
        {children}
    </div>,
    document.body,
);

export const GroupChromeCssPage: React.FC<{
    group: GroupProfile;
    theme: OSTheme;
    customThemes: ChatTheme[];
    userAvatar?: string;
    /** 預覽裡當對方的角色（拿它的頭像；群自己有頭像就用群的） */
    previewChar?: CharacterProfile;
    onChange: (css: string) => void;
    onReset: () => void;
    onClose: () => void;
}> = ({ group, theme, customThemes, userAvatar, previewChar, onChange, onReset, onClose }) => {
    // 預覽跟裝扮 App 編輯群的時候同一個口徑：私聊畫面示意，全局白框在前、這個群的疊在後
    const simChar = {
        ...(previewChar || {}),
        id: 'group-chrome-preview', name: group.name, avatar: group.avatar || previewChar?.avatar || '',
        ...CHARACTER_DECORATION_RESET, decorationTemplateId: undefined, chromeCustomCss: group.chromeCustomCss || undefined,
    } as CharacterProfile;
    return (
        <Shell title={`白框自定義 · ${group.name}`} subtitle="只對這個群生效，疊在全局設定上面；改了馬上套用" onClose={onClose} dataAttr="data-group-chrome-css">
            <div className="shrink-0 border-b border-slate-200 bg-white">
                <DecorationPreview simTheme={theme} simChar={simChar} customThemes={customThemes} userAvatar={userAvatar} className="h-[34vh] min-h-[220px]" />
                <div className="px-3 py-1 text-[10px] text-slate-400">預覽用私聊畫面示意；真正的樣子返回群聊就看得到</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom, 0px))' }}>
                <ChromeCssEditor value={group.chromeCustomCss || ''} onChange={onChange} assist={{ location: 'chat_chrome_group', targetId: group.id }} />
            </div>
            {/* 救援鍵：id 守護，寫壞的 CSS（例如把所有按鈕藏起來）也點得到 */}
            <style>{'#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top) + 6px)!important;right:12px!important;left:auto!important;transform:none!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}'}</style>
            <button
                id="sully-safe-reset" type="button" onClick={onReset}
                style={{
                    position: 'fixed', top: 'calc(var(--safe-top) + 6px)', right: '12px',
                    zIndex: 2147483647, display: 'flex', alignItems: 'center', gap: '4px',
                    padding: '5px 12px', borderRadius: '999px',
                    background: 'rgba(15,23,42,0.62)', color: '#fff', fontSize: '11px', fontWeight: 700,
                    border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                }}
            >⟲ 還原本群白框</button>
        </Shell>
    );
};

export const GroupSoundPage: React.FC<{
    group: GroupProfile;
    onApply: (patch: Partial<GroupProfile>) => void;
    onClose: () => void;
}> = ({ group, onApply, onClose }) => {
    const boundSound = parseWhiteboxSound(group.chromeCustomCss);
    const isBound = !!group.chatSoundBound || !!boundSound;
    const curSound: WhiteboxSound | null = isBound ? boundSound : (group.chatSound || null);
    const changeSound = (s: WhiteboxSound | null) => {
        if (isBound) onApply({ chromeCustomCss: upsertWhiteboxSound(group.chromeCustomCss || '', s), chatSound: undefined });
        else onApply({ chatSound: s || undefined });
    };
    const changeBound = (b: boolean) => {
        if (b) onApply({ chromeCustomCss: upsertWhiteboxSound(group.chromeCustomCss || '', curSound), chatSound: undefined, chatSoundBound: true });
        else onApply({ chromeCustomCss: stripWhiteboxSoundDirective(group.chromeCustomCss || ''), chatSound: curSound || undefined, chatSoundBound: false });
    };
    return (
        <Shell title={`提示音 · ${group.name}`} subtitle="成員新發的訊息成為最新一則時響一次；改了馬上套用" onClose={onClose} dataAttr="data-group-sound">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom, 0px))' }}>
                <WhiteboxSoundEditor
                    sound={curSound}
                    bound={isBound}
                    onChangeSound={changeSound}
                    onChangeBound={changeBound}
                    hint={<>🔔 只在 <b>成員新發的消息成為最新一條</b> 時響一次。這裡是<b>本群專屬</b>；不設則用「外觀 → 聊天界面」裡的全局默認提示音。</>}
                />
            </div>
        </Shell>
    );
};
