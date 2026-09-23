import { trackEvent } from '../../utils/analytics';
import { trackAnniversaryDownload } from '../../utils/sarAnalytics';
import React, { useEffect, useRef, useState } from 'react';
import { NOSTALGIA_APPEARANCE, useOS } from '../../context/OSContext';
import { PRESET_THEMES } from '../chat/ChatConstants';
import {
  ANNIVERSARY_ARTIST, ANNIVERSARY_FRAME_STYLE, ANNIVERSARY_FRAME_URL, ANNIVERSARY_WALLPAPERS,
  avatarDecorationImageStyle, createAnniversaryTheme,
} from '../../utils/anniversaryGifts';
import TokenImg from './TokenImg';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import './anniversary-gift.css';

const CONFETTI = ['🎉', '✨', '💜', '👑', '🌟', '🎊'];

export default function AnniversaryGiftPopup({ onClose }: { onClose: () => void }) {
  const { characters, activeCharacterId, userProfile, theme, addCustomTheme, updateCharacter, updateTheme, addToast } = useOS();
  useEffect(() => { trackEvent('打开周年赠礼'); }, []);
  const [choosing, setChoosing] = useState(false);
  const [characterId, setCharacterId] = useState(characters.find(c => c.id === activeCharacterId)?.id || characters[0]?.id || '');
  const [phone, setPhone] = useState(true);
  const [chat, setChat] = useState(characters.length > 0);
  const [frame, setFrame] = useState(characters.length > 0);
  const [phoneWallpaper, setPhoneWallpaper] = useState<string>(ANNIVERSARY_WALLPAPERS[0].url);
  const [chatWallpaper, setChatWallpaper] = useState<string>(ANNIVERSARY_WALLPAPERS[1].url);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState('');
  const [celebrating, setCelebrating] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const selectedCharacter = characters.find(c => c.id === characterId);
  const canApply = (phone || chat || frame) && (!(chat || frame) || !!selectedCharacter);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)') || []);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    const timer = window.setTimeout(() => setCelebrating(false), 3500);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      window.clearTimeout(timer);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const apply = async () => {
    if (!canApply || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (selectedCharacter && (frame || chat)) {
        const nextTheme = frame ? createAnniversaryTheme(
          PRESET_THEMES.default, selectedCharacter.id,
        ) : undefined;
        if (nextTheme) await addCustomTheme(nextTheme);
        updateCharacter(selectedCharacter.id, {
          ...(chat ? { chatBackground: chatWallpaper } : {}),
          bubbleStyle: nextTheme?.id || PRESET_THEMES.default.id,
        });
      }
      // 贈禮配回最初的默認紫色；淺色畫作配深紫文字，壁紙仍只替換勾選項。
      const { wallpaper: _defaultWallpaper, ...purpleAppearance } = NOSTALGIA_APPEARANCE;
      const hasSkinLeaves = theme.desktopDecorations?.some(d => d.id.startsWith('acnh-leaf-'));
      await updateTheme({
        ...purpleAppearance,
        contentColor: '#514168',
        ...(phone ? { wallpaper: phoneWallpaper } : {}),
        ...(hasSkinLeaves ? { desktopDecorations: theme.desktopDecorations!.filter(d => !d.id.startsWith('acnh-leaf-')) } : {}),
      });
      trackEvent('应用周年赠礼', { 桌面壁纸: phone ? '是' : '否', 聊天壁纸: chat ? '是' : '否', 头像框: frame ? '是' : '否' });
      addToast('週年裝扮已應用，尊貴感拉滿 ✨', 'success');
      onClose();
    } catch {
      setError('部分裝扮未能保存，請重試，或先下載原圖。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const download = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setDownloading(true);
    setError('');
    try {
      const { createAnniversaryGiftArchive, ANNIVERSARY_DOWNLOAD_NAME } = await import('../../utils/anniversaryGiftDownload');
      const blob = await createAnniversaryGiftArchive();
      // Match the other event exports: native / Web Share first, download only as a fallback.
      const result = await shareOrDownloadBlob({
        blob, fileName: ANNIVERSARY_DOWNLOAD_NAME, shareTitle: 'Soren 一週年贈禮',
      });
      trackAnniversaryDownload(result);
      if (result !== 'cancelled') {
        setDownloaded(true);
        addToast(result === 'shared' ? '已打開贈禮保存面板，內含三張原圖與作者署名' : '已下載三張原圖與作者署名，解壓後即可自行上傳', 'success');
      }
      // Keep the gift open: downloading need not prevent applying it as well.
    } catch {
      trackAnniversaryDownload('failed');
      setError('圖片下載未完成，請稍後重試。');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setDownloading(false);
    }
  };

  return (
    <div className="anniversary-overlay">
      <div className="anniversary-backdrop" aria-hidden="true" />
      {celebrating && <div className="anniversary-confetti" aria-hidden="true">
        {Array.from({ length: 30 }, (_, i) => <span key={i} style={{
          '--x': `${4 + (i * 37 % 92)}%`, '--delay': `${i % 8 * 0.07}s`,
          '--drift': `${(i % 2 ? 1 : -1) * (30 + i % 5 * 16)}px`, '--spin': `${(i % 2 ? 1 : -1) * 280}deg`,
        } as React.CSSProperties}>{CONFETTI[i % CONFETTI.length]}</span>)}
      </div>}
      <div className="anniversary-panel" ref={panelRef} role="dialog" aria-modal="true"
        aria-labelledby="anniversary-title" aria-describedby="anniversary-description" tabIndex={-1}>
        <button className="anniversary-close" type="button" aria-label="關閉週年贈禮" disabled={busy} onClick={onClose}>×</button>
        <div className="anniversary-scroll">
          <p className="anniversary-eyebrow">Soren · 一週年紀念</p>
          <h2 id="anniversary-title">{choosing ? '把尊貴，安排上。' : 'Ta-da——週年大戶！'}</h2>
          <p id="anniversary-description" className="anniversary-intro">
            九月，是開始做小手機的一週年。<br />
            一位老玩家送來的週年心意，<br />
            也想分享給一路同行的你。
          </p>
          <p className="anniversary-credit">壁紙與頭像框作者：{ANNIVERSARY_ARTIST}</p>
          {!choosing ? <>
            <div className="anniversary-art" aria-label="兩款週年壁紙和一枚尊貴貓貓頭像框">
              <img className="anniversary-paper anniversary-paper-left" src={ANNIVERSARY_WALLPAPERS[0].url} alt="奶油星星壁紙" />
              <img className="anniversary-paper anniversary-paper-right" src={ANNIVERSARY_WALLPAPERS[1].url} alt="糖霜格紋壁紙" />
              <div className="anniversary-avatar">
                {userProfile.avatar ? <TokenImg value={userProfile.avatar} className="anniversary-avatar-photo" alt="你的頭像預覽" /> : <div className="anniversary-avatar-photo anniversary-avatar-fallback">🐱</div>}
                <img src={ANNIVERSARY_FRAME_URL} alt="尊貴貓貓一週年頭像框" className="anniversary-frame" style={avatarDecorationImageStyle(ANNIVERSARY_FRAME_STYLE, 86)} />
              </div>
            </div>
            <div className="anniversary-receipt">
              <span>尊貴程度</span><strong>滿級大戶 👑</strong>
              <span>累計充值</span><strong>¥ 0.00</strong>
            </div>
            <p className="anniversary-owned">兩張壁紙 + 一枚頭像框，週年免費贈禮。</p>
            <p className="anniversary-hint">現在一鍵換裝，或下載原圖留作紀念。<br />解壓後，可在壁紙和頭像框設置中自行上傳。</p>
          </> : <fieldset className="anniversary-options" disabled={busy}>
            <label className="anniversary-character-label" htmlFor="anniversary-character">給哪位角色的聊天換裝？</label>
            <select id="anniversary-character" value={characterId} onChange={e => setCharacterId(e.target.value)}>
              <option value="">選擇角色</option>
              {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {!characters.length && <p className="anniversary-hint">還沒有角色，也可以先換手機壁紙，或下載原圖留作紀念。</p>}
            <label className="anniversary-option"><input type="checkbox" checked={frame} onChange={e => setFrame(e.target.checked)} /><span>戴上尊貴貓貓頭像框<small>這段聊天裡的你和角色一起戴</small></span></label>
            <div className="anniversary-option-row">
              <label className="anniversary-option"><input type="checkbox" checked={chat} onChange={e => setChat(e.target.checked)} /><span>角色的聊天壁紙</span></label>
              <select aria-label="週年聊天壁紙" disabled={!chat || busy} value={chatWallpaper} onChange={e => setChatWallpaper(e.target.value)}>{ANNIVERSARY_WALLPAPERS.map(w => <option key={w.id} value={w.url}>{w.name}</option>)}</select>
            </div>
            <div className="anniversary-option-row">
              <label className="anniversary-option"><input type="checkbox" checked={phone} onChange={e => setPhone(e.target.checked)} /><span>手機桌面壁紙<small>整部手機共用</small></span></label>
              <select aria-label="週年手機壁紙" disabled={!phone || busy} value={phoneWallpaper} onChange={e => setPhoneWallpaper(e.target.value)}>{ANNIVERSARY_WALLPAPERS.map(w => <option key={w.id} value={w.url}>{w.name}</option>)}</select>
            </div>
            <p className="anniversary-hint">換裝會同步切換為默認紫色主題；聊天裝扮搭配默認紫色氣泡，壁紙與頭像框按勾選項應用。</p>
          </fieldset>}
          {error && <p className="anniversary-error" role="alert">{error}</p>}
        </div>
        <div className="anniversary-actions">
          <div className="anniversary-action-row">
            <button className="anniversary-secondary anniversary-download" type="button" disabled={busy} aria-label="下載全部圖片" aria-busy={downloading} onClick={download}>
              <span className="anniversary-button-label">{downloading ? '打包中…' : downloaded ? '再次下載' : '下載全部'}</span>
              <small>3 張原圖 · ZIP</small>
            </button>
            <button className="anniversary-primary" type="button" disabled={busy || (choosing && !canApply)} aria-busy={busy && !downloading} onClick={choosing ? apply : () => setChoosing(true)}>
              <span className="anniversary-button-label">
                <svg className="anniversary-button-star" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 1 2.6 6.4L19 10l-6.4 2.6L10 19l-2.6-6.4L1 10l6.4-2.6L10 1Z" stroke="currentColor" /><path d="m10 6 1.2 2.8L14 10l-2.8 1.2L10 14l-1.2-2.8L6 10l2.8-1.2L10 6Z" fill="currentColor" /></svg>
                {busy && !downloading ? '換裝中…' : choosing ? '確認換裝' : '立即換裝'}
              </span>
              <svg className="anniversary-button-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.2" /></svg>
            </button>
          </div>
          {choosing && <button className="anniversary-back" type="button" disabled={busy} onClick={() => setChoosing(false)}>返回看看贈禮</button>}
        </div>
      </div>
    </div>
  );
}
