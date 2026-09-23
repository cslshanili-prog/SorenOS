/**
 * Memory Dive (記憶潛行) — 像素 RPG 探索（劇本版）
 *
 * 3DS 風格上下雙屏：
 *   上屏：像素房間 + 角色 + 用戶跟隨小人（傢俱純裝飾，不交互）
 *   下屏：固定高度的復古對話框 + 打字機 + 選項
 *
 * 流程：一次 LLM 生成整房間的劇本（beats + per-choice reactions），
 *   角色站在房間裡說 N 段戲，每段 3 個選項對應 3 種獨立反應；
 *   所有 beats 走完進入下一個房間；所有房間走完結算。
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { MemoryRoom, RemoteVectorConfig } from '../../utils/memoryPalace/types';
import type { APIConfig, CharacterProfile, UserProfile } from '../../types';
import type { PixelHomeState, PixelAsset } from './types';
import type {
  DiveSession, DiveDialogue, DiveChoice, DiveBuffValues,
  DiveResult, RoomExploreState, RoomScript, DiveScriptChoice,
} from './memoryDiveTypes';
import { BUFF_META } from './memoryDiveTypes';
import { ROOM_META, roomDisplayName } from './roomTemplates';
import { ContextBuilder } from '../../utils/context';
import {
  planRoomVisit,
  generateIntroDialogues, generateOutroDialogues,
  createInitialBuffs, applyChoiceBuff, computeDiveResult,
  emitDiveEmotion,
} from './memoryDiveEngine';
import MemoryDiveRoom from './MemoryDiveRoom';
import MemoryDiveDialogue from './MemoryDiveDialogue';
import MemoryDiveChoices from './MemoryDiveChoices';
import MemoryDiveAmbient from './MemoryDiveAmbient';
import {
  pickNextRoom, roomCharPos, userPos, jitterPos,
} from './memoryDiveNav';

interface Props {
  charId: string;
  charName: string;
  charProfile: CharacterProfile;
  userProfile: UserProfile;
  charSprite?: string;
  playerSprite?: string;
  userName: string;
  homeState: PixelHomeState;
  assets: PixelAsset[];
  apiConfig: APIConfig;
  remoteVectorConfig?: RemoteVectorConfig;
  onExit: (result: DiveResult | null) => void;
}

const BEAT_MOVE_DURATION_MS = 700;
const WALK_STEP_MS = 180;
const TRANSITION_HALF_MS = 400;
const BEATS_PER_ROOM = 3;

type PlaybackStep =
  | 'intro'
  | 'beat-talk'
  | 'beat-reaction'
  | 'room-close'
  | 'room-transition'
  | 'done';

const MemoryDiveMode: React.FC<Props> = ({
  charId, charName, charProfile, userProfile, charSprite, playerSprite,
  userName, homeState, assets, apiConfig, remoteVectorConfig, onExit,
}) => {
  const fullCharContext = useMemo(() =>
    ContextBuilder.buildCoreContext(charProfile, userProfile, true),
    [charProfile, userProfile],
  );

  // ─── Session ─────────────────────────────────────────
  const [session, setSession] = useState<DiveSession | null>(null);
  const [showResult, setShowResult] = useState<DiveResult | null>(null);

  // ─── 對話顯示 ─────────────────────────────────────────
  const [dialogueQueue, setDialogueQueue] = useState<DiveDialogue[]>([]);
  const [currentDialogue, setCurrentDialogue] = useState<DiveDialogue | null>(null);
  const [pendingChoices, setPendingChoices] = useState<DiveChoice[] | null>(null);

  // ─── 角色視覺 ─────────────────────────────────────────
  const [charWalking, setCharWalking] = useState(false);
  const [charFlip, setCharFlip] = useState(false);
  const [walkStep, setWalkStep] = useState<0 | 1>(0);
  const [transitionState, setTransitionState] = useState<'idle' | 'out' | 'in'>('idle');
  const [isLoadingScript, setIsLoadingScript] = useState(false);
  // API 失敗時展示的錯誤——非空就在下屏面板渲染"重新召回"按鈕
  const [loadError, setLoadError] = useState<string | null>(null);

  // ─── Refs（callback 從這裡讀最新值） ───────────────────
  const sessionRef = useRef<DiveSession | null>(null);
  const scriptRef = useRef<RoomScript | null>(null);
  const beatIdxRef = useRef(0);
  const playbackStepRef = useRef<PlaybackStep>('intro');
  const initializedRef = useRef(false);
  const stepTimerRef = useRef<number | null>(null);
  const moveTimerRef = useRef<number | null>(null);
  // 上一房間的情緒餘溫（傳給下一房間的 LLM 做銜接）
  const prevMoodHintRef = useRef<string | undefined>(undefined);
  const prevRoomRef = useRef<MemoryRoom | undefined>(undefined);
  // 上一場景的"最後一句"——新房間第一句必須承接它
  const prevEndingLineRef = useRef<string | undefined>(undefined);
  const prevEndingSpeakerRef = useRef<'character' | 'narrator' | undefined>(undefined);
  // 後台預載下一個房間：播到一半時偷偷 generate，切換時能秒進
  const preloadedRef = useRef<{
    roomId: MemoryRoom;
    script: RoomScript;
    memoryTexts: string[];
  } | null>(null);
  const preloadingRef = useRef(false);

  // 加載文案：隨轉場上下文變化
  const [loadingText, setLoadingText] = useState<string>('薄霧正在聚攏');
  // 本次房間召回的記憶碎片（給下屏氛圍面板展示用，不調 LLM）
  const [roomMemoryTexts, setRoomMemoryTexts] = useState<string[]>([]);

  // ─── 初始化 ───────────────────────────────────────────
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const initialRoom: MemoryRoom = 'living_room';
    const roomStates = new Map<MemoryRoom, RoomExploreState>();
    for (const room of Object.keys(ROOM_META) as MemoryRoom[]) {
      roomStates.set(room, {
        roomId: room,
        visitedSlots: new Set(),
        hasLockedContent: room === 'attic',
        unlocked: false,
      });
    }
    const charPos = roomCharPos(initialRoom);
    const uPos = userPos(charPos.x, charPos.y);

    setSession({
      charId, charName, mode: 'guided',
      phase: 'intro',
      currentRoom: initialRoom,
      playerPos: uPos,
      charPos,
      dialogues: [],
      roomStates,
      buffValues: createInitialBuffs(),
      visitedRooms: [initialRoom],
      isLoading: false,
      startedAt: Date.now(),
    });

    // 開場只保留敘事 / 角色台詞，不要開場選項（改成自動銜接劇本加載）
    const intro = generateIntroDialogues(charName, 'guided')
      .filter(d => d.speaker !== 'user_choice' || !d.choices);
    playbackStepRef.current = 'intro';
    enqueueDialogues(intro);
  }, [charId, charName]);

  // session ref 同步
  useEffect(() => { sessionRef.current = session; }, [session]);

  // ─── 清理 ─────────────────────────────────────────────
  useEffect(() => () => {
    if (stepTimerRef.current) window.clearInterval(stepTimerRef.current);
    if (moveTimerRef.current) window.clearTimeout(moveTimerRef.current);
  }, []);

  // 走路腳步循環
  useEffect(() => {
    if (!charWalking) {
      if (stepTimerRef.current) window.clearInterval(stepTimerRef.current);
      stepTimerRef.current = null;
      return;
    }
    stepTimerRef.current = window.setInterval(() => {
      setWalkStep(s => (s === 0 ? 1 : 0));
    }, WALK_STEP_MS);
    return () => {
      if (stepTimerRef.current) window.clearInterval(stepTimerRef.current);
      stepTimerRef.current = null;
    };
  }, [charWalking]);

  // ─── 對話隊列 ─────────────────────────────────────────
  const enqueueDialogues = useCallback((items: DiveDialogue[]) => {
    const narratives: DiveDialogue[] = [];
    let choicesMsg: DiveDialogue | null = null;
    for (const d of items) {
      if (d.speaker === 'user_choice' && d.choices && d.choices.length > 0) {
        choicesMsg = d;
      } else if (d.speaker !== 'user_choice') {
        narratives.push(d);
      }
    }
    setSession(prev => prev ? { ...prev, dialogues: [...prev.dialogues, ...items] } : prev);
    if (narratives.length > 0) {
      setDialogueQueue(prev => [...prev, ...narratives]);
    }
    if (choicesMsg?.choices) {
      setPendingChoices(choicesMsg.choices);
    }
  }, []);

  // current 空 + 隊列非空 → 自動彈下一條
  useEffect(() => {
    if (currentDialogue) return;
    if (dialogueQueue.length === 0) return;
    const [next, ...rest] = dialogueQueue;
    setCurrentDialogue(next);
    setDialogueQueue(rest);
  }, [currentDialogue, dialogueQueue]);

  const advanceDialogue = useCallback(() => {
    setCurrentDialogue(null);
  }, []);

  // ─── 當前房間佈局 ─────────────────────────────────────
  const currentRoomLayout = useMemo(() =>
    session ? homeState.rooms.find(r => r.roomId === session.currentRoom) : undefined,
    [homeState, session?.currentRoom],
  );

  // ─── 角色移動（beat 間微漂，增加生命感） ───────────────
  const shiftChar = useCallback((to: { x: number; y: number }) => {
    setSession(prev => {
      if (!prev) return prev;
      const dx = to.x - prev.charPos.x;
      setCharFlip(dx < 0);
      return {
        ...prev,
        charPos: to,
        playerPos: userPos(to.x, to.y),
      };
    });
    setCharWalking(true);
    if (moveTimerRef.current) window.clearTimeout(moveTimerRef.current);
    moveTimerRef.current = window.setTimeout(() => {
      setCharWalking(false);
      moveTimerRef.current = null;
    }, BEAT_MOVE_DURATION_MS);
  }, []);

  // ═════════════════════════════════════════════════════
  // 劇本播放——drainHandlerRef 在 queue 清空後觸發下一步
  // ═════════════════════════════════════════════════════
  const drainHandlerRef = useRef<() => void>(() => {});
  // 前向聲明，讓各 callback 之間可以互相調用
  const playBeatRef = useRef<(idx: number) => void>(() => {});
  const playCloseRef = useRef<() => void>(() => {});
  const enterNewRoomRef = useRef<(roomId: MemoryRoom) => Promise<void>>(async () => {});
  const handleExitRef = useRef<() => void>(() => {});
  // 在當前劇本加載完成後，延遲觸發對下一個房間的預載
  const schedulePreloadRef = useRef<() => void>(() => {});

  // 裝入當前房間的劇本：優先用預載結果；否則調 LLM。
  // 失敗時不用兜底佔位，直接 setLoadError，讓下屏渲染"重新召回"按鈕。
  const loadScriptForCurrentRoom = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;

    // 1) 預載命中？直接秒進，省掉 loading
    if (preloadedRef.current?.roomId === s.currentRoom) {
      const { script, memoryTexts } = preloadedRef.current;
      preloadedRef.current = null;
      scriptRef.current = script;
      beatIdxRef.current = 0;
      setRoomMemoryTexts(memoryTexts);
      setIsLoadingScript(false);
      setLoadError(null);
      if (script.introNarrator) {
        const now = Date.now();
        enqueueDialogues([{
          id: `intro_room_${now}`,
          speaker: 'narrator',
          text: script.introNarrator,
          timestamp: now,
        }]);
        drainHandlerRef.current = () => playBeatRef.current(0);
      } else {
        playBeatRef.current(0);
      }
      // 還沒走完的房間，繼續預載下一個
      schedulePreloadRef.current();
      return;
    }

    // 2) 正常調用
    setIsLoadingScript(true);
    setLoadError(null);
    try {
      const res = await planRoomVisit(
        {
          charId, charName, userName, room: s.currentRoom,
          beatCount: BEATS_PER_ROOM,
          visitedRooms: s.visitedRooms,
          recentDialogues: s.dialogues.slice(-10),
          currentBuffs: s.buffValues,
          previousMoodHint: prevMoodHintRef.current,
          previousRoom: prevRoomRef.current,
          previousEndingLine: prevEndingLineRef.current,
          previousEndingSpeaker: prevEndingSpeakerRef.current,
        },
        apiConfig, fullCharContext, remoteVectorConfig,
      );
      scriptRef.current = res.script;
      beatIdxRef.current = 0;
      setRoomMemoryTexts(res.memoryTexts);
      setIsLoadingScript(false);
      if (res.script.introNarrator) {
        const now = Date.now();
        enqueueDialogues([{
          id: `intro_room_${now}`,
          speaker: 'narrator',
          text: res.script.introNarrator,
          timestamp: now,
        }]);
        drainHandlerRef.current = () => playBeatRef.current(0);
      } else {
        playBeatRef.current(0);
      }
      schedulePreloadRef.current();
    } catch (err: any) {
      console.error('[MemoryDive] planRoomVisit failed:', err);
      setIsLoadingScript(false);
      setLoadError(err?.message || '生成失敗');
    }
  }, [charId, charName, apiConfig, fullCharContext, remoteVectorConfig, enqueueDialogues]);

  // 後台靜默預載"下一個房間"的劇本。播到 beat 1 左右觸發——
  // 用戶讀對話時偷偷 generate，真正切換房間時能秒進。
  // 失敗就算了（主流程上真正切換時會走正常調用 / 錯誤 UI）。
  const preloadNextRoom = useCallback(async () => {
    const s = sessionRef.current;
    const curScript = scriptRef.current;
    if (!s || !curScript) return;
    if (preloadingRef.current) return;

    const next = pickNextRoom(s.currentRoom, s.visitedRooms, curScript.nextRoom);
    if (!next || next === s.currentRoom) return;
    if (preloadedRef.current?.roomId === next) return;

    // 用當前房間的 closingNarrator / finalMoodHint 作為"上個場景餘溫"的近似值。
    // 用戶真正選擇造成的最後一句差異是捕捉不到的（還沒選呢），但 90% 的銜接已覆蓋。
    const prevMoodGuess = curScript.finalMoodHint || curScript.closingNarrator;
    const prevEndingGuess = curScript.closingNarrator || curScript.finalMoodHint;

    preloadingRef.current = true;
    try {
      const res = await planRoomVisit(
        {
          charId, charName, userName, room: next,
          beatCount: BEATS_PER_ROOM,
          visitedRooms: s.visitedRooms,
          recentDialogues: s.dialogues.slice(-10),
          currentBuffs: s.buffValues,
          previousMoodHint: prevMoodGuess,
          previousRoom: s.currentRoom,
          previousEndingLine: prevEndingGuess,
          previousEndingSpeaker: 'narrator',
        },
        apiConfig, fullCharContext, remoteVectorConfig,
      );
      // 真正切過去時 currentRoom 才是 next，本地已改過的話要放棄
      if (sessionRef.current?.currentRoom !== s.currentRoom) return;
      preloadedRef.current = { roomId: next, script: res.script, memoryTexts: res.memoryTexts };
      console.log('[MemoryDive] preloaded', next);
    } catch (e) {
      console.warn('[MemoryDive] preload 失敗（靜默）:', e);
    } finally {
      preloadingRef.current = false;
    }
  }, [charId, charName, apiConfig, fullCharContext, remoteVectorConfig]);

  // 在當前房間播到一會之後觸發預載（不要剛 load 完就調，讓 beat 0 先展開）
  useEffect(() => {
    schedulePreloadRef.current = () => {
      window.setTimeout(() => preloadNextRoom(), 1800);
    };
  }, [preloadNextRoom]);

  // 手動重試：用戶按"重新召回"按鈕
  const handleRetryLoad = useCallback(() => {
    setLoadError(null);
    loadScriptForCurrentRoom();
  }, [loadScriptForCurrentRoom]);

  // 播放一段戲：narrator + charLine + 設置 3 個選項
  const playBeat = useCallback((idx: number) => {
    const script = scriptRef.current;
    const s = sessionRef.current;
    if (!script || !s) return;
    const beat = script.beats[idx];
    if (!beat) {
      playCloseRef.current();
      return;
    }
    beatIdxRef.current = idx;

    // 角色微漂位置，讓畫面活一點（第 0 段不漂，剛進場）
    if (idx > 0) {
      shiftChar(jitterPos(roomCharPos(s.currentRoom)));
    }

    const now = Date.now();
    const items: DiveDialogue[] = [];
    if (beat.narratorLine) {
      items.push({
        id: `beat_${idx}_n_${now}`,
        speaker: 'narrator',
        text: beat.narratorLine,
        timestamp: now,
      });
    }
    items.push({
      id: `beat_${idx}_c_${now}`,
      speaker: 'character',
      text: beat.charLine,
      timestamp: now + 1,
    });
    // 選項作為 user_choice dialogue，enqueueDialogues 會把它拆出來變成 pendingChoices
    items.push({
      id: `beat_${idx}_choices_${now}`,
      speaker: 'user_choice',
      text: '',
      choices: beat.choices.map(c => ({
        id: c.id,
        text: c.text,
        action: c.action,
        buffEffect: c.buffEffect,
      })),
      timestamp: now + 2,
    });
    enqueueDialogues(items);
    // 選項會阻塞 advance effect，這裡不設 drainHandler
    drainHandlerRef.current = () => {};
  }, [enqueueDialogues, shiftChar]);

  // 播放房間收尾
  const playClose = useCallback(() => {
    const script = scriptRef.current;
    const s = sessionRef.current;
    if (!script || !s) return;

    const now = Date.now();
    const items: DiveDialogue[] = [];
    if (script.closingNarrator) {
      items.push({
        id: `close_n_${now}`,
        speaker: 'narrator',
        text: script.closingNarrator,
        timestamp: now,
      });
    }
    if (script.finalMoodHint) {
      items.push({
        id: `close_mood_${now}`,
        speaker: 'narrator',
        text: script.finalMoodHint,
        timestamp: now + 1,
      });
    }
    // 沒有收尾文案時給一個默認兜底，至少讓流程繼續
    if (items.length === 0) {
      items.push({
        id: `close_fallback_${now}`,
        speaker: 'narrator',
        text: '薄霧在身後合攏，你們準備離開這裡。',
        timestamp: now,
      });
    }
    enqueueDialogues(items);

    // 收尾播完 → 去下一個房間或結算
    drainHandlerRef.current = () => {
      const sess = sessionRef.current;
      if (!sess) return;
      const next = pickNextRoom(sess.currentRoom, sess.visitedRooms, scriptRef.current?.nextRoom);
      if (next) {
        enterNewRoomRef.current(next);
      } else {
        handleExitRef.current();
      }
    };
  }, [enqueueDialogues]);

  // 選項被選中：應用 buff，播放對應 reaction，reaction 播完推進 beat
  const handleChoice = useCallback((choice: DiveChoice) => {
    const s = sessionRef.current;
    const script = scriptRef.current;
    if (!s || !script) return;

    // 找到對應的 scriptChoice（帶 reaction 文本）
    const beat = script.beats[beatIdxRef.current];
    const scriptChoice: DiveScriptChoice | undefined =
      beat?.choices.find(c => c.id === choice.id);

    const now = Date.now();
    const echo: DiveDialogue = {
      id: `echo_${now}`,
      speaker: 'user_choice',
      text: choice.text,
      timestamp: now,
    };

    setSession(prev => prev ? {
      ...prev,
      dialogues: [...prev.dialogues, echo],
      buffValues: applyChoiceBuff(prev.buffValues, choice),
    } : prev);
    setPendingChoices(null);

    // 入隊反應
    const reactionItems: DiveDialogue[] = [];
    if (scriptChoice?.reaction) {
      reactionItems.push({
        id: `react_${now}`,
        speaker: 'character',
        text: scriptChoice.reaction,
        timestamp: now + 1,
      });
    }
    if (scriptChoice?.reactionNarrator) {
      reactionItems.push({
        id: `react_n_${now}`,
        speaker: 'narrator',
        text: scriptChoice.reactionNarrator,
        timestamp: now + 2,
      });
    }
    if (reactionItems.length > 0) {
      enqueueDialogues(reactionItems);
    }

    // reaction 播完 → 進下一段或收尾
    drainHandlerRef.current = () => {
      const nextIdx = beatIdxRef.current + 1;
      const s2 = scriptRef.current;
      if (!s2) return;
      if (nextIdx < s2.beats.length) {
        playBeatRef.current(nextIdx);
      } else {
        playCloseRef.current();
      }
    };
  }, [enqueueDialogues]);

  // 進入新房間：淡出 → 換 room → 淡入 → 裝載劇本
  const enterNewRoom = useCallback(async (roomId: MemoryRoom) => {
    // 把當前房間的情緒餘溫/房間名/最後一句存入 ref，供下一輪 planRoomVisit 銜接用
    const cur = sessionRef.current;
    const curScript = scriptRef.current;
    if (cur) prevRoomRef.current = cur.currentRoom;
    prevMoodHintRef.current = curScript?.finalMoodHint || curScript?.closingNarrator;
    // 找到對話歷史中最後一句 character/narrator 台詞，作為嚴格銜接錨點
    if (cur) {
      const lastLine = [...cur.dialogues].reverse()
        .find(d => d.speaker === 'character' || d.speaker === 'narrator');
      prevEndingLineRef.current = lastLine?.text;
      prevEndingSpeakerRef.current = lastLine?.speaker as 'character' | 'narrator' | undefined;
    }

    // 設置轉場加載文案
    setLoadingText(`走向${roomDisplayName(roomId, userName)}`);

    setTransitionState('out');
    await new Promise(res => window.setTimeout(res, TRANSITION_HALF_MS));

    const entry = roomCharPos(roomId);
    setSession(prev => {
      if (!prev) return prev;
      const visited = prev.visitedRooms.includes(roomId)
        ? prev.visitedRooms
        : [...prev.visitedRooms, roomId];
      return {
        ...prev,
        currentRoom: roomId,
        visitedRooms: visited,
        charPos: entry,
        playerPos: userPos(entry.x, entry.y),
        phase: 'exploring',
      };
    });

    setTransitionState('in');
    await new Promise(res => window.setTimeout(res, TRANSITION_HALF_MS));
    setTransitionState('idle');

    // 轉場完畢後裝載劇本
    await loadScriptForCurrentRoom();
  }, [loadScriptForCurrentRoom]);

  // 結算
  const handleExit = useCallback(() => {
    const s = sessionRef.current;
    if (!s) { onExit(null); return; }
    // 置為 outro，阻止 advance effect 繼續觸發
    setSession(prev => prev ? { ...prev, phase: 'outro' } : prev);
    const outro = generateOutroDialogues(charName, s.buffValues);
    enqueueDialogues(outro);
    drainHandlerRef.current = () => {};
    const result = computeDiveResult({ ...s, phase: 'outro' });

    // 後台向角色發射情緒（若啟用了 emotionConfig）——角色不記得發生了什麼，
    // 但潛意識裡會留一層情緒底色，與 chat app 的 buff 系統共用同一套機制
    // 情緒 API 未單獨配置時回退到主 apiConfig（與記憶宮殿副 API 完全獨立）
    if (charProfile.emotionConfig?.enabled) {
      const emotionApi = (charProfile.emotionConfig.api?.baseUrl)
        ? charProfile.emotionConfig.api
        : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
      // fire-and-forget
      emitDiveEmotion({
        charProfile,
        userName,
        diveDialogues: s.dialogues,
        diveBuffs: s.buffValues,
        visitedRooms: s.visitedRooms,
        api: emotionApi,
      }).catch(err => console.warn('[MemoryDive] emitDiveEmotion failed:', err));
    }

    window.setTimeout(() => setShowResult(result), 1400);
  }, [charName, charProfile, enqueueDialogues, onExit]);

  const handleFinalExit = useCallback(() => onExit(showResult), [showResult, onExit]);

  // 用戶主動點「結束」
  const handleUserExit = useCallback(() => {
    setDialogueQueue([]);
    setCurrentDialogue(null);
    setPendingChoices(null);
    drainHandlerRef.current = () => {};
    handleExit();
  }, [handleExit]);

  // 把最新函數綁定到 ref，供其它 callback 互相調用
  useEffect(() => { playBeatRef.current = playBeat; }, [playBeat]);
  useEffect(() => { playCloseRef.current = playClose; }, [playClose]);
  useEffect(() => { enterNewRoomRef.current = enterNewRoom; }, [enterNewRoom]);
  useEffect(() => { handleExitRef.current = handleExit; }, [handleExit]);

  // loadScriptForCurrentRoom 也用 ref 暴露，讓 init effect 能設置初始
  // drainHandler 又不會被後續重渲反覆覆蓋
  const loadScriptRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => { loadScriptRef.current = loadScriptForCurrentRoom; }, [loadScriptForCurrentRoom]);

  // 首次：開場旁白播完後裝載 living_room 劇本（只設一次，不做轉場）
  useEffect(() => {
    drainHandlerRef.current = () => { loadScriptRef.current(); };
    // 之後的 drainHandler 由各 playback 函數自行覆蓋
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自動前進：隊列空 + 無選項 + 不在讀取/行走/轉場/錯誤 → 觸發 drainHandler
  useEffect(() => {
    if (!session || showResult) return;
    if (currentDialogue || dialogueQueue.length > 0) return;
    if (pendingChoices && pendingChoices.length > 0) return;
    if (isLoadingScript) return;
    if (loadError) return; // 失敗態下用戶按鈕重試，不自動重觸發
    if (charWalking) return;
    if (transitionState !== 'idle') return;
    if (session.phase === 'outro') return;

    const t = window.setTimeout(() => {
      drainHandlerRef.current();
    }, 350);
    return () => window.clearTimeout(t);
  }, [currentDialogue, dialogueQueue.length, pendingChoices, isLoadingScript, loadError,
      charWalking, transitionState, showResult, session?.phase, session]);

  // ═══════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════

  if (showResult) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-slate-950 p-6">
        <div className="max-w-sm w-full space-y-6 text-center">
          <div className="text-3xl">✨</div>
          <h2 className="text-lg font-bold text-slate-100">記憶潛行結束</h2>
          <div className="text-xs text-slate-400">
            探索了 {showResult.visitedRooms.length} 個房間 · {showResult.totalDialogues} 段對話
          </div>
          {showResult.buffs.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] text-slate-500 uppercase tracking-widest">獲得的印記</div>
              {showResult.buffs.map(buff => (
                <div key={buff.type}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-800/60 border border-slate-700/50">
                  <span className="text-xl">{buff.icon}</span>
                  <div className="text-left flex-1">
                    <div className="text-sm font-bold text-slate-200">{buff.label} +{buff.value}</div>
                    <div className="text-[10px] text-slate-400">{buff.description}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-slate-500 italic">
            {charName}眨了眨眼，看起來什麼都不記得了。<br/>
            但你知道，你們之間多了一些微妙的東西。
          </p>
          <button onClick={handleFinalExit}
            className="px-6 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold transition-all active:scale-95">
            回到像素家園
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-slate-950">
        <span className="text-xs text-slate-500">正在下沉……</span>
      </div>
    );
  }

  const meta = ROOM_META[session.currentRoom];
  // 選項是否應當顯示——嚴格門控，避免在對話切換間隙閃爍
  const choicesVisible = !!pendingChoices &&
    !currentDialogue &&
    dialogueQueue.length === 0 &&
    !isLoadingScript &&
    !charWalking &&
    transitionState === 'idle';

  // 對話框是否應當顯示——選項 / 加載 / 轉場時隱藏；有當前對話或隊列非空時顯示
  const isLoadingDialogueState = session.isLoading || isLoadingScript;
  const dialogueVisible = !choicesVisible && !isLoadingDialogueState &&
    (!!currentDialogue || dialogueQueue.length > 0);

  return (
    <div
      className="h-full w-full flex flex-col bg-slate-950 overflow-hidden select-none"
      style={{ paddingBottom: 'var(--safe-bottom, 0px)', boxSizing: 'border-box' }}
    >
      {/* 頂欄（薄） */}
      <div
        className="shrink-0 flex items-center justify-between px-3 pb-1.5 bg-black/70 backdrop-blur-sm border-b border-slate-800 z-20"
        style={{ paddingTop: 'max(2.75rem, var(--safe-top, 0px))' }}
      >
        <div className="flex items-center gap-1">
          <button onClick={handleUserExit}
            className="p-1.5 -ml-1 rounded-sm hover:bg-slate-700/60 active:scale-90 transition-all"
            aria-label="結束潛行"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-slate-300">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </button>
          <span className="text-[10px] font-bold text-violet-300 ml-0.5">
            🌀 {meta.emoji} {roomDisplayName(session.currentRoom, userName)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {(Object.entries(session.buffValues) as [keyof DiveBuffValues, number][]).map(([key, val]) =>
            val > 0 ? (
              <span key={key} className="text-[9px] text-slate-400" title={BUFF_META[key].label}>
                {BUFF_META[key].icon}{Math.round(val * 10) / 10}
              </span>
            ) : null
          )}
        </div>
      </div>

      {/* 上屏：像素房間 + 對話框浮層 + 選項浮層 */}
      <div className="flex-1 min-h-0 relative border-b-2 border-slate-800">
        <MemoryDiveRoom
          roomId={session.currentRoom}
          layout={currentRoomLayout}
          assets={assets}
          charSprite={charSprite}
          playerSprite={playerSprite}
          charName={charName}
          userName={userName}
          charPos={session.charPos}
          playerPos={session.playerPos}
          charWalking={charWalking}
          charFlip={charFlip}
          walkStep={walkStep}
          transitionState={transitionState}
        />

        {/* 對話框：懸浮在房間下沿 */}
        {dialogueVisible && (
          <div className="absolute left-2 right-2 bottom-2 z-20 pointer-events-auto">
            <MemoryDiveDialogue
              current={currentDialogue}
              queueRemaining={dialogueQueue.length}
              choicesPending={!!pendingChoices && pendingChoices.length > 0}
              charName={charName}
              charAvatar={charProfile.avatar}
              disabled={charWalking || transitionState !== 'idle'}
              onAdvance={advanceDialogue}
            />
          </div>
        )}

        {/* 選項浮層：覆蓋房間下半部，優先級高於對話框 */}
        <MemoryDiveChoices
          choices={pendingChoices}
          visible={choicesVisible}
          disabled={charWalking || transitionState !== 'idle'}
          onPick={handleChoice}
        />
      </div>

      {/* 下屏：夢核氛圍面板——房間名 + 本次召回的記憶碎片 / 加載引導 / 錯誤重試 */}
      <MemoryDiveAmbient
        roomName={roomDisplayName(session.currentRoom, userName)}
        memoryFragments={roomMemoryTexts}
        isLoading={isLoadingDialogueState}
        loadingText={loadingText}
        loadError={loadError}
        onRetry={handleRetryLoad}
      />
    </div>
  );
};

export default MemoryDiveMode;
