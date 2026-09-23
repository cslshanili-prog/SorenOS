
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import { useMusic, musicApi, normalizeCookie, toHttps, Song } from '../context/MusicContext';
import { DB } from '../utils/db';
import { trackEvent } from '../utils/analytics';
import { Gear, User as UserIcon, Crosshair, Play as PlayIcon, Pause as PauseIcon } from '@phosphor-icons/react';
import {
  C, Sparkle, CrossStar, MizuHeader, SearchBar, SongRow, MiniPlayer,
  VinylDisc, GlassProgress, PlayControls, BokehBg,
  MetaChip, SubActions,
} from './music/MusicUI';
import NeteaseProfilePage from './music/NeteaseProfilePage';
import CharVisitPage from './music/CharVisitPage';
import { shareOrDownloadBlob } from '../utils/shareExport';

// ------------------------- 工具 -------------------------
const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

type View = 'search' | 'settings' | 'player' | 'profile' | 'visit_char';

// ========================= 主組件 =========================
const MusicApp: React.FC = () => {
  const { closeApp, addToast, characters, userProfile } = useOS();
  const {
    cfg, setCfg, effectiveWorkerUrl,
    current, playing, progress, duration, loadingSong,
    lyric, tlyric, activeLyricIdx,
    profile, playSong, togglePlay, nextSong, prevSong, seek,
    liked, toggleLike, setToastHandler,
    listeningTogetherWith, removeListeningPartner,
    addLocalSong, removeLocalSong, localAlbumSongs,
    playMode, setPlayMode,
    regeneratingId, regeneratingStatus,
  } = useMusic();
  const isCurrentRegenerating = !!current && current.id === regeneratingId;
  // 把對軸入口和單曲循環按鈕移到 SubActions 裡，避免散亂
  // 下載本地生成的歌曲到本地文件系統
  const downloadCurrentLocal = useCallback(async () => {
    if (!current?.local || !current.localAssetKey) return;
    try {
      const entry = await DB.getAssetRaw(current.localAssetKey).catch(() => null) as
        | { blob?: Blob; mimeType?: string }
        | Blob
        | null;
      const blob: Blob | null = entry instanceof Blob
        ? entry
        : (entry?.blob instanceof Blob ? entry.blob : null);
      if (!blob) { addToast('音頻文件丟失', 'error'); return; }
      const mime = current.localMimeType || (entry && !(entry instanceof Blob) ? entry.mimeType : '') || blob.type || 'audio/mpeg';
      const ext = /wav/i.test(mime) ? 'wav' : /ogg/i.test(mime) ? 'ogg' : /flac/i.test(mime) ? 'flac' : /m4a|aac|mp4/i.test(mime) ? 'm4a' : 'mp3';
      const safe = (current.name || 'song').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
      const result = await shareOrDownloadBlob({ blob, fileName: `${safe}.${ext}`, shareTitle: current.name || '生成的歌曲' });
      if (result === 'cancelled') return;
      addToast(result === 'shared' ? '已打開系統保存/分享' : '已開始下載', 'success');
      trackEvent('下载生成的歌到本地文件');
    } catch {
      addToast('下載失敗', 'error');
    }
  }, [current, addToast]);

  const cyclePlayMode = useCallback(() => {
    const order: ('loop' | 'single' | 'shuffle')[] = ['loop', 'single', 'shuffle'];
    const next = order[(order.indexOf(playMode) + 1) % order.length];
    setPlayMode(next);
    trackEvent('切换播放模式', { mode: next });
    addToast(next === 'loop' ? '列表循環' : next === 'single' ? '單曲循環' : '隨機播放', 'info');
  }, [playMode, setPlayMode, addToast]);

  // 伴聽 char 名單（用於 MiniPlayer / 播放頁徽章）—— 帶頭像，給"小情侶"頭像塊用
  const companions = useMemo(() => {
    return listeningTogetherWith
      .map(id => characters.find(c => c.id === id))
      .filter((c): c is typeof characters[number] => !!c)
      .map(c => ({ id: c.id, name: c.name, avatar: c.avatar }));
  }, [listeningTogetherWith, characters]);

  // 當前歌在哪些 char 的歌單裡（用於 MiniPlayer 的"也收藏"提示）
  const charsWithSong = useMemo(() => {
    if (!current) return [];
    return characters
      .map(c => {
        const pl = c.musicProfile?.playlists.find(p => p.songs.some(s => s.id === current.id));
        return pl ? { id: c.id, name: c.name, playlistTitle: pl.title } : null;
      })
      .filter((x): x is { id: string; name: string; playlistTitle: string } => !!x);
  }, [current, characters]);

  // 把 OS toast 注入到 Music Context（這樣全局播放報錯也能彈 toast）
  useEffect(() => { setToastHandler(addToast); }, [addToast, setToastHandler]);

  const [view, setView] = useState<View>('profile');
  // ── 手動對軸 modal state ──
  const [showLyricSync, setShowLyricSync] = useState(false);
  const [syncDraft, setSyncDraft] = useState<number[]>([]);
  const [visitCharId, setVisitCharId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Song[]>([]);
  const [searching, setSearching] = useState(false);
  const lyricBoxRef = useRef<HTMLDivElement | null>(null);

  // 歌詞自動滾動：把 current line 對齊到滾動容器視覺中心
  // 注意 offsetTop 依賴 offsetParent，容器沒 position:relative 時會跨到祖先節點、值偏大，
  // 導致 current line 被推到中心上方。改用 getBoundingClientRect 對齊，和 DOM 嵌套解耦。
  useEffect(() => {
    if (view !== 'player') return;
    const box = lyricBoxRef.current; if (!box || activeLyricIdx < 0) return;
    const el = box.querySelector<HTMLDivElement>(`[data-lyric-idx="${activeLyricIdx}"]`);
    if (!el) return;
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elTopInBox = elRect.top - boxRect.top + box.scrollTop;
    box.scrollTo({ top: elTopInBox - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
  }, [activeLyricIdx, view]);

  // ── 搜索 ──
  const doSearch = useCallback(async () => {
    const kw = keyword.trim(); if (!kw) return;
    setSearching(true);
    trackEvent('搜索一首歌');
    try {
      const r = await musicApi.search(cfg, kw);
      const songs: Song[] = (r?.result?.songs || []).map((s: any) => ({
        id: s.id, name: s.name,
        artists: (s.ar || s.artists || []).map((a: any) => a.name).join(' / '),
        album: s.al?.name || s.album?.name || '',
        albumPic: toHttps(s.al?.picUrl || s.album?.picUrl || ''),
        duration: (s.dt || s.duration || 0) / 1000,
        fee: s.fee ?? 0,
      }));
      setResults(songs);
      if (!songs.length) {
        const hint = r?.msg || r?.message || (r?.code != null ? `code=${r.code}` : '') || '無數據';
        addToast(`沒找到: ${hint}`, 'info');
      }
    } catch (e: any) {
      addToast(`搜索失敗：${e.message}`, 'error');
    } finally {
      setSearching(false);
    }
  }, [keyword, cfg, addToast]);

  // ════════════════ 搜索頁 ════════════════
  const renderSearch = () => (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader
        title="未來音楽"
        onClose={closeApp}
        right={
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('profile')}
              className="p-1.5 rounded-full transition-all"
              style={{ color: C.primary }}
              title="我的"
            >
              <UserIcon size={16} weight="bold" />
            </button>
            <button
              onClick={() => setView('settings')}
              className="p-1.5 rounded-full transition-all"
              style={{ color: C.primary }}
            >
              <Gear size={16} weight="bold" />
            </button>
          </div>
        }
      />
      <SearchBar value={keyword} onChange={setKeyword} onSearch={doSearch} searching={searching} />

      {/* 用戶狀態 — 玻璃標籤 */}
      {profile && (
        <div className="px-5 -mt-1 mb-1.5 flex items-center gap-1.5 relative z-10">
          <button
            onClick={() => setView('profile')}
            className="inline-flex items-center gap-2 pl-0.5 pr-3 py-0.5 rounded-full text-[10px] shizuku-glass cursor-pointer"
            style={{ color: C.muted }}
          >
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover" />
            ) : <Sparkle size={6} color={C.sakura} delay={0.3} />}
            {profile.nickname} · {cfg.quality}
          </button>
        </div>
      )}
      {!cfg.cookie && (
        <div className="px-5 -mt-1 mb-1.5 relative z-10">
          <button
            onClick={() => setView('profile')}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] cursor-pointer"
            style={{ background: `${C.vip}18`, color: C.vip, border: `1px solid ${C.vip}30` }}
          >
            未登錄 — 點擊登錄網易雲
          </button>
        </div>
      )}

      {/* 歌曲列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-24 relative z-10 shizuku-scrollbar">
        {results.length === 0 && !searching && (
          <div className="text-center mt-16 space-y-4">
            <div className="relative inline-block">
              <Sparkle size={24} className="mx-auto" color={C.glow} delay={0} />
              <Sparkle size={12} className="absolute -top-1 -right-3" color={C.sakura} delay={0.8} />
              <Sparkle size={8} className="absolute -bottom-2 -left-2" color={C.lavender} delay={1.5} />
            </div>
            <div className="text-xs italic" style={{ color: C.faint, fontFamily: `'Georgia', serif` }}>
              搜一首想聽的歌吧
            </div>
          </div>
        )}
        {results.map(s => (
          <SongRow
            key={s.id}
            name={s.name}
            artists={s.artists}
            album={s.album}
            albumPic={s.albumPic}
            duration={fmtTime(s.duration)}
            isVip={s.fee === 1}
            isActive={current?.id === s.id}
            onClick={() => { playSong(s); trackEvent('播放搜索结果里的一首歌'); }}
          />
        ))}
      </div>

      {current && (
        <MiniPlayer
          name={current.name}
          artists={current.artists}
          albumPic={current.albumPic}
          playing={playing}
          onTap={() => { setView('player'); trackEvent('打开播放页'); }}
          onPrev={() => { prevSong(); trackEvent('切歌（上一首/下一首）', { direction: 'prev' }); }}
          onToggle={togglePlay}
          onNext={() => { nextSong(); trackEvent('切歌（上一首/下一首）', { direction: 'next' }); }}
          userAvatar={userProfile?.avatar}
          userName={userProfile?.name}
          companions={companions}
          onKickCompanion={charId => { removeListeningPartner(charId); trackEvent('结束和角色的一起听'); }}
          charsWithSong={charsWithSong}
          regenStatus={isCurrentRegenerating ? regeneratingStatus : undefined}
        />
      )}
    </div>
  );

  // ════════════════ 播放頁 ════════════════
  const bitrateMap: Record<string, string> = {
    standard: '128 kbps',
    higher:   '192 kbps',
    exhigh:   '320 kbps',
    lossless: '1411 kbps',
    hires:    '24bit · Hi-Res',
  };

  const renderPlayer = () => {
    if (!current) return null;
    return (
      <div className="flex flex-col h-full relative"
        style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 60%, ${C.bgDeep} 100%)` }}>
        <BokehBg />
        <MizuHeader title="Now Playing" onBack={() => setView('search')} />

        <div className="flex-1 flex flex-col items-center px-5 pt-4 pb-3 relative z-10 overflow-hidden">
          <div className="shrink-0 mt-1 relative">
            <VinylDisc albumPic={current.albumPic} playing={playing} size={150} bitrate={bitrateMap[cfg.quality]} />
            {/* 重錄中覆蓋層 — 只在本地歌且 regeneratingId 匹配時顯示 */}
            {isCurrentRegenerating && (
              <div className="absolute inset-0 rounded-full flex items-center justify-center pointer-events-none"
                style={{
                  background: `radial-gradient(circle, rgba(0,0,0,0.55) 30%, rgba(0,0,0,0.35) 70%)`,
                  backdropFilter: 'blur(6px)',
                  WebkitBackdropFilter: 'blur(6px)',
                  boxShadow: `0 0 30px ${C.glow}80`,
                  animation: 'shizuku-glow 2s ease-in-out infinite',
                }}
              >
                <div className="text-center space-y-1.5 px-3">
                  <div className="w-7 h-7 mx-auto border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <div className="text-[10px] tracking-[0.2em] text-white font-semibold" style={{ fontFamily: 'Georgia, serif' }}>
                    正在重錄
                  </div>
                  <div className="text-[9px] text-white/80 truncate max-w-[120px]" style={{ fontFamily: 'monospace' }}>
                    {regeneratingStatus || '處理中…'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 橫幅形式的重錄提示 — 進入播放頁第一時間看到狀態 */}
          {isCurrentRegenerating && (
            <div className="mt-3 px-3 py-1.5 rounded-full flex items-center gap-2 text-[10px] tracking-wider"
              style={{
                background: `linear-gradient(135deg, ${C.primary}15, ${C.lavender}25)`,
                border: `1px solid ${C.glow}60`,
                color: C.primary,
              }}
            >
              <Sparkle size={9} color={C.sakura} delay={0} />
              <span>新版本即將到來 · {regeneratingStatus || '處理中'}</span>
              <Sparkle size={9} color={C.lavender} delay={0.5} />
            </div>
          )}

          <section className="mt-5 text-center space-y-1.5 shrink-0 px-2">
            <h2 className="font-light tracking-tight leading-tight"
              style={{ color: C.primary, fontFamily: `'Noto Serif','Georgia',serif`, fontSize: '22px' }}>
              {current.name}
            </h2>
            <p className="text-[10px] uppercase opacity-70"
              style={{ color: C.muted, fontFamily: `'Space Grotesk','SF Mono',monospace`, letterSpacing: '0.2em' }}>
              {current.artists}
            </p>
          </section>

          <div
            ref={lyricBoxRef}
            className="flex-1 w-full my-3 min-h-0 overflow-y-auto text-center scroll-smooth shizuku-scrollbar px-2"
            style={{
              maskImage: 'linear-gradient(to bottom, transparent, black 18%, black 82%, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 18%, black 82%, transparent)',
            }}
          >
            {lyric.length === 0 ? (
              <div className="pt-6 flex flex-col items-center gap-2" style={{ color: C.faint }}>
                <Sparkle size={12} color={C.glow} />
                <span className="text-[11px] italic tracking-wider" style={{ fontFamily: `'Noto Serif','Georgia',serif` }}>
                  {loadingSong ? 'loading...' : 'no lyrics'}
                </span>
              </div>
            ) : (
              <div className="space-y-4 py-8">
                {lyric.map((l, i) => {
                  const tr = tlyric.find(t => Math.abs(t.t - l.t) < 0.2);
                  const active = i === activeLyricIdx;
                  // 關鍵：字號 / 字重不隨 active 變 —— 變了會觸發重排換行。
                  //     只讓外層盒子用 transform:scale 視覺放大，不動內部文字度量。
                  return (
                    <div key={i} data-lyric-idx={i}
                      className="transition-transform duration-300 will-change-transform"
                      style={{
                        transform: active ? 'scale(1.05)' : 'scale(1)',
                        transformOrigin: 'center center',
                        opacity: active ? 1 : 0.45,
                      }}>
                      <div className="flex items-center justify-center gap-2 px-3">
                        <CrossStar
                          size={12}
                          color={C.sakura}
                          delay={0}
                          solid={active}
                          className={active ? '' : 'opacity-0'}
                        />
                        <div
                          className="text-[16px] leading-[1.4]"
                          style={{
                            fontFamily: `'Noto Serif','Georgia',serif`,
                            fontWeight: 400,
                            maxWidth: '100%',
                            wordBreak: 'break-word',
                            color: active ? undefined : C.faint,
                            ...(active
                              ? {
                                  background: `linear-gradient(135deg, ${C.primary} 0%, ${C.accent} 50%, #9a6bc5 100%)`,
                                  WebkitBackgroundClip: 'text',
                                  WebkitTextFillColor: 'transparent',
                                  backgroundClip: 'text',
                                  filter: `drop-shadow(0 0 14px ${C.glow}a0) drop-shadow(0 0 4px ${C.sakura}80)`,
                                }
                              : {}),
                          }}
                        >
                          {l.text}
                        </div>
                        <CrossStar
                          size={12}
                          color={C.lavender}
                          delay={0.9}
                          solid={active}
                          className={active ? '' : 'opacity-0'}
                        />
                      </div>
                      {tr && (
                        <div
                          className="text-[12px] leading-[1.4] mt-1 px-3"
                          style={{
                            fontWeight: 400,
                            maxWidth: '100%',
                            wordBreak: 'break-word',
                            opacity: active ? 0.78 : 0.4,
                            color: active ? C.accent : C.faint,
                          }}
                        >
                          {tr.text}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="w-full shrink-0 max-w-sm">
            <div className="flex justify-between items-center mb-2 px-0.5">
              <MetaChip>{fmtTime(progress)}</MetaChip>
              <MetaChip>{fmtTime(duration)}</MetaChip>
            </div>
            <GlassProgress progress={progress} duration={duration} fmtTime={fmtTime} onSeek={seek} />
          </div>

          <div className="shrink-0 relative">
            <Sparkle size={9} className="absolute top-1 left-[30%]" color={C.sakura} delay={0} />
            <Sparkle size={7} className="absolute top-3 right-[28%]" color={C.lavender} delay={1.2} />
            <PlayControls
              playing={playing}
              loading={loadingSong}
              onPrev={() => { prevSong(); trackEvent('切歌（上一首/下一首）', { direction: 'prev' }); }}
              onToggle={togglePlay}
              onNext={() => { nextSong(); trackEvent('切歌（上一首/下一首）', { direction: 'next' }); }}
            />
          </div>

          <div className="shrink-0 mt-3 w-full">
            <SubActions
              liked={liked}
              onLike={() => { toggleLike(); trackEvent('收藏或取消收藏当前歌', { action: liked ? 'unlike' : 'like' }); }}
              showSync={!!(current.local && current.localLyrics && lyric.length > 0)}
              onSync={() => {
                setSyncDraft(lyric.map(l => l.t));
                setShowLyricSync(true);
                trackEvent('打开歌词对轴面板');
              }}
              showDownload={!!(current.local && current.localAssetKey)}
              onDownload={downloadCurrentLocal}
              playMode={playMode}
              onCyclePlayMode={cyclePlayMode}
            />
          </div>
        </div>
      </div>
    );
  };

  // ════════════════ 設置頁 ════════════════
  const renderSettings = () => {
    const setDraft = (updates: Partial<typeof cfg>) => setCfg({ ...cfg, ...updates });
    const commit = () => {
      addToast('已保存', 'success');
      setView('search');
    };
    const followsCentral = !cfg.workerUrl.trim();
    return (
      <div className="flex flex-col h-full relative"
        style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
        <BokehBg />
        <MizuHeader title="設置" onBack={() => setView('search')} />
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 text-sm relative z-10 shizuku-scrollbar">
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center justify-between" style={{ color: C.muted }}>
              <span className="flex items-center gap-1.5"><Sparkle size={6} color={C.glow} delay={0} /> 服務地址</span>
              {!followsCentral && (
                <button onClick={() => setDraft({ workerUrl: '' })}
                  className="text-[9px] underline" style={{ color: C.muted }}>改回跟隨中心</button>
              )}
            </div>
            <input className="w-full rounded-xl px-3 py-2 outline-none text-xs shizuku-glass" value={cfg.workerUrl}
              onChange={e => setDraft({ workerUrl: e.target.value })} placeholder={effectiveWorkerUrl}
              style={{ color: C.text }} />
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              {followsCentral
                ? <>跟隨「設置 → 網絡代理」：{effectiveWorkerUrl}</>
                : <>只在音樂里用這個地址，「設置 → 網絡代理」改了也不跟</>}
            </div>
          </div>
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.sakura} delay={0.5} /> 會員 Cookie
            </div>
            <textarea className="w-full rounded-xl px-3 py-2 outline-none text-[10px] shizuku-glass" rows={3} value={cfg.cookie}
              onChange={e => setDraft({ cookie: e.target.value })} placeholder="MUSIC_U=xxx 或直接粘貼值..."
              style={{ color: C.text, fontFamily: 'monospace', resize: 'none' }} />
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              也可以在「我的」頁面裡掃碼 / 手機號登錄，自動填入 cookie
            </div>
          </div>
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.lavender} delay={1} /> 音質
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {(['standard', 'higher', 'exhigh', 'lossless', 'hires'] as const).map(q => (
                <button key={q} onClick={() => { setDraft({ quality: q }); trackEvent('切换音质档位', { quality: q }); }}
                  className="py-2 rounded-xl text-[10px] transition-all"
                  style={{
                    background: cfg.quality === q ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : C.glass,
                    color: cfg.quality === q ? 'white' : C.muted,
                    border: cfg.quality === q ? '1px solid transparent' : `1px solid rgba(255,255,255,0.3)`,
                    boxShadow: cfg.quality === q ? `0 2px 12px ${C.glow}30` : 'none',
                    backdropFilter: 'blur(8px)',
                  }}
                >{q}</button>
              ))}
            </div>
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>lossless / hires 需要黑膠 SVIP</div>
          </div>
          <div className="space-y-3 pt-1">
            <button
              onClick={async () => {
                trackEvent('运行音乐服务诊断');
                const lines: string[] = [];
                const ck = normalizeCookie(cfg.cookie);
                lines.push(`Worker: ${effectiveWorkerUrl}${followsCentral ? '（跟隨中心）' : '（音樂單獨設的）'}`);
                lines.push(`Cookie: ${ck ? ck.slice(0, 18) + '...(' + ck.length + 'c)' : '(未填)'}`);
                try {
                  const res = await fetch(`${effectiveWorkerUrl}/netease/search`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', ...(ck ? { 'X-Netease-Cookie': ck } : {}) },
                    body: JSON.stringify({ keyword: '晴天', limit: 3 }),
                  });
                  lines.push(`HTTP ${res.status}`);
                  const txt = await res.text(); lines.push(txt.slice(0, 800));
                  try { const j = JSON.parse(txt); lines.push(`---\ncode=${j.code}  songs=${j?.result?.songs?.length ?? 'N/A'}`); } catch {}
                } catch (e: any) { lines.push(`異常: ${e.message}`); }
                alert(lines.join('\n'));
              }}
              className="w-full py-2.5 rounded-2xl text-[10px] tracking-wider shizuku-glass transition-all"
              style={{ color: C.vip, border: `1px solid ${C.vip}30` }}
            >診斷（搜索晴天）</button>
            <button onClick={commit}
              className="w-full py-3 rounded-2xl text-xs text-white tracking-wider transition-all relative overflow-hidden"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}>
              <span className="relative z-10">保存</span>
              <div className="absolute inset-0 pointer-events-none" style={{
                background: `linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.25) 50%, transparent 70%)`,
                backgroundSize: '200% 100%', animation: 'shizuku-shimmer 3s ease-in-out infinite',
              }} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="absolute inset-0 overflow-hidden">
      {view === 'search' && renderSearch()}
      {view === 'player' && renderPlayer()}
      {view === 'settings' && renderSettings()}
      {view === 'profile' && (
        <NeteaseProfilePage
          onBack={closeApp}
          onOpenPlayer={() => setView('player')}
          onOpenSearch={() => setView('search')}
          onOpenSettings={() => setView('settings')}
          onVisitChar={id => { setVisitCharId(id); setView('visit_char'); trackEvent('进入角色音乐角落'); }}
        />
      )}
      {/* 手動對軸 modal — 全屏覆蓋，不開新 view */}
      {showLyricSync && current && current.local && (() => {
        const fmt = (s: number) => {
          if (!isFinite(s)) return '0:00.0';
          const m = Math.floor(s / 60);
          const sec = (s % 60).toFixed(1).padStart(4, '0');
          return `${m}:${sec}`;
        };
        const setLineTime = (idx: number, t: number) => {
          setSyncDraft(prev => {
            const next = [...prev];
            next[idx] = Math.max(0, t);
            return next;
          });
        };
        const tapCurrent = (idx: number) => setLineTime(idx, progress);
        const resetAuto = () => {
          if (!duration || duration <= 0) return;
          const intro = Math.min(2, duration * 0.05);
          const outro = Math.min(3, duration * 0.05);
          const usable = Math.max(duration - intro - outro, duration * 0.6);
          const step = usable / lyric.length;
          setSyncDraft(lyric.map((_, i) => intro + i * step));
        };
        const saveSync = () => {
          if (!current) return;
          // 把 draft 寫到 song.lyricLineTimings 裡 → addLocalSong 上行覆蓋
          const updated: Song = { ...current, lyricLineTimings: syncDraft };
          addLocalSong(updated);
          // 重新 playSong 讓 LyricLine 立即用新時間
          playSong(updated, { alsoSetQueue: false });
          setShowLyricSync(false);
          addToast('對軸已保存 ✦', 'success');
          trackEvent('保存歌词对轴');
        };

        return (
          <div className="absolute inset-0 z-50 flex flex-col"
            style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 60%, ${C.bgDeep} 100%)` }}>
            <BokehBg />
            {/* Header */}
            <div className="relative z-10 shizuku-glass-strong"
              style={{ borderBottom: `1px solid rgba(255,255,255,0.3)`, paddingTop: 'var(--safe-top)' }}>
              <div className="flex items-center justify-between h-12 px-4">
                <button onClick={() => setShowLyricSync(false)} className="text-[11px] px-2 py-1 rounded-full" style={{ color: C.muted }}>取消</button>
                <div className="flex items-center gap-1.5">
                  <Crosshair size={13} weight="duotone" color={C.primary} />
                  <span className="text-[12px] tracking-[0.25em]" style={{ color: C.primary, fontFamily: 'Georgia, serif' }}>歌詞對軸</span>
                </div>
                <button onClick={saveSync} className="text-[11px] font-bold px-3 py-1 rounded-full"
                  style={{
                    background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`,
                    color: 'white',
                    boxShadow: `0 2px 10px ${C.glow}50`,
                  }}>保存</button>
              </div>
            </div>

            {/* Live progress + transport */}
            <div className="relative z-10 px-4 pt-3 pb-2 shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <button onClick={togglePlay}
                  className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 active:scale-95 transition-transform"
                  style={{
                    background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`,
                    color: 'white',
                    boxShadow: `0 3px 12px ${C.glow}50`,
                  }}
                >
                  {playing ? <PauseIcon size={14} weight="fill" /> : <PlayIcon size={14} weight="fill" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: C.muted, fontFamily: 'monospace' }}>
                    <span style={{ color: C.primary, fontWeight: 600 }}>{fmt(progress)}</span>
                    <span>{fmt(duration)}</span>
                  </div>
                  <div className="h-1 rounded-full shizuku-glass cursor-pointer relative"
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                      seek((e.clientX - rect.left) / rect.width);
                    }}
                  >
                    <div className="absolute top-0 left-0 h-full rounded-full"
                      style={{
                        width: `${duration > 0 ? (progress / duration) * 100 : 0}%`,
                        background: `linear-gradient(90deg, ${C.primary}, ${C.glow})`,
                      }} />
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <button onClick={resetAuto} className="text-[10px] underline" style={{ color: C.muted }}>
                  重置為均勻分佈
                </button>
                <p className="text-[10px] flex-1 text-right" style={{ color: C.muted }}>
                  播放時點 ⊙ 把當前時間設給那一句
                </p>
              </div>
            </div>

            {/* Lyric list with tap-to-set */}
            <div className="flex-1 overflow-y-auto px-3 pb-6 shizuku-scrollbar relative z-10 pt-1">
              {lyric.length === 0 ? (
                <div className="text-center text-[11px] py-12" style={{ color: C.faint }}>沒有歌詞可對軸</div>
              ) : (
                <div className="space-y-1.5">
                  {lyric.map((l, i) => {
                    const t = syncDraft[i] ?? l.t;
                    const isActive = i === activeLyricIdx;
                    return (
                      <div key={i}
                        className="flex items-center gap-2 rounded-xl px-2.5 py-2 transition-all"
                        style={{
                          background: isActive
                            ? `linear-gradient(135deg, ${C.glow}25, ${C.lavender}18)`
                            : 'rgba(255,255,255,0.5)',
                          border: `1px solid ${isActive ? C.glow + '60' : C.faint + '30'}`,
                          boxShadow: isActive ? `0 2px 12px ${C.glow}30` : 'none',
                        }}
                      >
                        <span className="text-[9px] tabular-nums w-5 text-center shrink-0" style={{ color: C.faint }}>{i + 1}</span>
                        <button
                          onClick={() => tapCurrent(i)}
                          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition-all"
                          style={{
                            background: `${C.primary}15`,
                            border: `1px solid ${C.primary}30`,
                            color: C.primary,
                          }}
                          title="把這一句設到當前播放時間"
                        >
                          ⊙
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] truncate" style={{ color: isActive ? C.primary : C.text, fontWeight: isActive ? 600 : 400 }}>
                            {l.text}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[9px] tabular-nums" style={{ color: C.muted, fontFamily: 'monospace' }}>{fmt(t)}</span>
                            <button
                              onClick={() => setLineTime(i, t - 0.2)}
                              className="text-[9px] px-1 rounded"
                              style={{ color: C.faint }}
                            >−.2s</button>
                            <button
                              onClick={() => setLineTime(i, t + 0.2)}
                              className="text-[9px] px-1 rounded"
                              style={{ color: C.faint }}
                            >+.2s</button>
                            <button
                              onClick={() => seek(duration > 0 ? t / duration : 0)}
                              className="text-[9px] px-1 rounded ml-auto"
                              style={{ color: C.accent }}
                            >跳到此處</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {view === 'visit_char' && visitCharId && (
        <CharVisitPage
          charId={visitCharId}
          onBack={() => { setView('profile'); setVisitCharId(null); }}
          onOpenPlayer={() => setView('player')}
        />
      )}
    </div>
  );
};

export default MusicApp;
