import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  APIConfig,
  ApiPreset,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential } from '../../utils/apiConfigNormalize';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import { ActiveMsgClient, getDefaultActiveMsgFirstSendTime } from '../../utils/activeMsgClient';
import { ActiveMsgStore } from '../../utils/activeMsgStore';
import { type AmsgLastSkip, DEFAULT_MAX_UNANSWERED_SENDS, describeLastSkip } from '../../utils/amsgFirePack';
import { isInstantChatReady } from '../../utils/amsgInstantChat';
import { syncAmsgLlmCredentials } from '../../utils/amsgStateSync';
import { buildUserCancelledNotices } from '../../utils/amsg2TaskContext';
import { trackEvent } from '../../utils/analytics';
import {
  applyRemoteTaskDelta,
  applyScheduledTask,
  currentOccurrenceMs,
  describeExpirePolicy,
  describeRecurrence,
  describeRemoteLastError,
  describeTaskMode,
  describeTaskProgress,
  formatTaskTime,
  fromDatetimeLocalValue,
  isAmsg2EnabledForChar,
  isPendingTask,
  isRemoteMissingTask,
  keepUncancelledTasks,
  pruneFiredTasks,
  reconcileTasksWithRemote,
  resolveExpirePolicy,
  type RemoteTaskLastError,
  type RemoteTaskProjection,
  shortTaskId,
  toDatetimeLocalValue,
} from '../../utils/amsg2Tasks';

interface ActiveMsg2SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  char: CharacterProfile;
  apiConfig: APIConfig;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  apiPresets: ApiPreset[];
  onAddApiPreset: (name: string, config: APIConfig) => void;
  /**
   * 落盤任務清單與角色級設置。
   *
   * 傳的是 updater 而不是整份 config：面板的每次保存都要先 await 網絡請求，這期間角色
   * 可能在聊天裡用工具排了新任務（寫的是同一個 activeMsg2Config）。拿渲染時的舊快照整份
   * 蓋回去會把它抹掉——遠端照發、面板卻看不見，就是各處都在防的幽靈任務。
   * updater 由 OSContext 的函數式 setState 執行，拿到的 prev 是最新排隊後的狀態。
   */
  onSave: (
    updater: (prev: ActiveMsg2CharacterConfig | undefined) => ActiveMsg2CharacterConfig,
  ) => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const MODE_OPTIONS = [
  { id: 'fixed', label: '固定', desc: '到點直接發你寫好的內容' },
  { id: 'auto', label: '自動', desc: '用當前角色設定和聊天快照自己生成' },
  { id: 'prompted', label: '提示詞', desc: '圍繞你寫的方向生成主動消息' },
] as const;

const RECURRENCE_OPTIONS = [
  { id: 'none', label: '一次' },
  { id: 'daily', label: '每天' },
  { id: 'weekly', label: '每週' },
] as const;

const ActiveMsg2SettingsModal: React.FC<ActiveMsg2SettingsModalProps> = ({
  isOpen,
  onClose,
  char,
  apiConfig,
  userProfile,
  groups,
  realtimeConfig,
  apiPresets,
  onAddApiPreset,
  onSave,
  addToast,
}) => {
  const saved = char.activeMsg2Config;
  const tasks = saved?.tasks ?? [];
  // 任務列表的判定基準時刻：一次 render 只取一次，同屏卡片不會踩在不同的時刻上。
  const now = Date.now();

  // 開關初值走和工具注入門同一個判定：面板顯示「關」而角色其實還能排程，界面就在騙人。
  const [enabled, setEnabled] = useState(() => isAmsg2EnabledForChar(char));
  // 即時對話按角色單獨關：undefined = 跟隨全局默認開，所以只有顯式 false 才顯示成關。
  const [instantChatOn, setInstantChatOn] = useState(saved?.instantChatEnabled !== false);
  // 全局那道門開沒開（isInstantChatReady 讀回來的）。沒開時下面那行開關置灰。
  const [globalInstantChatOn, setGlobalInstantChatOn] = useState(false);
  const [mode, setMode] = useState<ActiveMsg2Mode>('auto');
  const [firstSendTime, setFirstSendTime] = useState(getDefaultActiveMsgFirstSendTime());
  const [recurrenceType, setRecurrenceType] = useState<ActiveMsg2Recurrence>('none');
  const [userMessage, setUserMessage] = useState('');
  const [promptHint, setPromptHint] = useState('');
  const [maxTokens, setMaxTokens] = useState(String(saved?.maxTokens ?? ''));
  // '' = 沒設（用默認值）；'0' = 不限；其餘 1-10。
  const [maxUnanswered, setMaxUnanswered] = useState(
    saved?.maxUnansweredSends === undefined ? '' : String(saved.maxUnansweredSends),
  );
  const [useSecondaryApi, setUseSecondaryApi] = useState(saved?.useSecondaryApi ?? false);
  const [secUrl, setSecUrl] = useState(saved?.secondaryApi?.baseUrl ?? '');
  const [secKey, setSecKey] = useState(saved?.secondaryApi?.apiKey ?? '');
  const [secModel, setSecModel] = useState(saved?.secondaryApi?.model ?? '');
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [showModelModal, setShowModelModal] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [modelStatusMsg, setModelStatusMsg] = useState('');
  const [testingConnection, setTestingConnection] = useState(false);
  const [testConnectionResult, setTestConnectionResult] = useState<string | null>(null);
  const [globalReady, setGlobalReady] = useState(false);
  const [pushSummary, setPushSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // editingTaskUuid=null → 新建；非 null → 編輯該任務（保存時 replaceTaskUuid）。
  const [editingTaskUuid, setEditingTaskUuid] = useState<string | null>(null);
  const [expirePolicy, setExpirePolicy] = useState<ActiveMsg2ExpirePolicy>('expire');
  // 遠端對帳底帳：打開面板時拉一次全量任務，只留歸屬本角色的 uuid。null = 沒對上帳
  // （讀失敗/未拉完），此時不顯示「遠端不存在」徽標，免得半個清單誤傷。
  // 之後不重拉，靠 applyRemoteTaskDelta 把每次遠端操作的結果記進來（見 amsg2Tasks 註釋）。
  const [knownRemoteUuids, setKnownRemoteUuids] = useState<Set<string> | null>(null);
  // 遠端任務的 status / lastError 投影（對帳那次一起拉的）。null = 沒拉到，卡片上
  // 不顯示失敗說明。這份只在打開面板時取一次，不隨 delta 維護——取消/重建後任務
  // 換了 uuid，舊條目自然失配，不會串行。
  const [remoteTaskInfo, setRemoteTaskInfo] = useState<Map<string, {
    status?: string;
    lastError: RemoteTaskLastError | null;
  }> | null>(null);
  // 防穿幫閘最近一次跳過的記錄（worker 寫的）。null = 沒有記錄 / 沒讀到。
  const [lastSkip, setLastSkip] = useState<AmsgLastSkip | null>(null);

  // 表單值重置：面板打開或切換編輯對象時，用被編輯任務的字段填表單（新建則填默認值）。
  // 角色級共享設置（maxTokens / 單獨 API）始終跟隨保存值。
  useEffect(() => {
    if (!isOpen) return;

    const config = char.activeMsg2Config;
    const list = config?.tasks ?? [];
    // 跟 useState 初值同一個判定：這裡自己寫三元的話，面板顯示的開關狀態就會跟
    // 工具注入門分家（見 isAmsg2EnabledForChar 的註釋）。
    setEnabled(isAmsg2EnabledForChar(char));
    setInstantChatOn(config?.instantChatEnabled !== false);
    setMaxTokens(config?.maxTokens ? String(config.maxTokens) : '');
    setMaxUnanswered(config?.maxUnansweredSends === undefined ? '' : String(config.maxUnansweredSends));
    setUseSecondaryApi(config?.useSecondaryApi ?? false);
    setSecUrl(config?.secondaryApi?.baseUrl ?? '');
    setSecKey(config?.secondaryApi?.apiKey ?? '');
    setSecModel(config?.secondaryApi?.model ?? '');
    setShowSavePreset(false);
    setNewPresetName('');
    setTestConnectionResult(null);

    const editing = editingTaskUuid ? list.find((t) => t.taskUuid === editingTaskUuid) : undefined;
    if (editing) {
      setMode(editing.mode);
      setFirstSendTime(toDatetimeLocalValue(editing.firstSendTime));
      setRecurrenceType(editing.recurrenceType);
      setUserMessage(editing.userMessage ?? '');
      setPromptHint(editing.promptHint ?? '');
      setExpirePolicy(resolveExpirePolicy(editing.mode, editing.expirePolicy));
    } else {
      setMode('auto');
      setFirstSendTime(getDefaultActiveMsgFirstSendTime());
      setRecurrenceType('none');
      setUserMessage('');
      setPromptHint('');
      setExpirePolicy('expire');
    }
  }, [isOpen, char.id, char.activeMsg2Config, editingTaskUuid]);

  // 打開面板時的 push 狀態檢查 + 遠端對帳（只隨 isOpen / 角色變化跑，不隨編輯對象重複請求）。
  useEffect(() => {
    if (!isOpen) return;
    setKnownRemoteUuids(null);
    setRemoteTaskInfo(null);

    // 全局即時對話開沒開（現成的讀取函數，別自己另讀存儲）。讀失敗按沒開置灰。
    void isInstantChatReady().then(setGlobalInstantChatOn).catch(() => setGlobalInstantChatOn(false));

    void (async () => {
      const globalConfig = await ActiveMsgClient.getGlobalConfig();
      const pushStatus = await ActiveMsgClient.getPushStatus();
      setGlobalReady(Boolean(globalConfig.workerUrl));
      setPushSummary(pushStatus.supported
        ? `權限：${pushStatus.permission} / 訂閱：${pushStatus.hasSubscription ? '已就緒' : '未創建'}`
        : '當前環境不支持 Web Push');
    })();

    // 防穿幫閘最近攔下了哪次觸發。閘是靜默的，不說一聲的話「讓路了」在用戶看來
    // 跟「沒發出去」一模一樣。
    void (async () => setLastSkip(await ActiveMsgClient.readLastSkip(char.id)))();

    void (async () => {
      let remote: Set<string>;
      let remoteTasks: RemoteTaskProjection[];
      try {
        // 全量投影一次拉齊：uuid 當對帳底帳，status / lastError 給任務卡片說明
        // 「上次到點為什麼沒發出去」，nextSendAt 給循環任務顯示真正會響的時刻。
        remoteTasks = await ActiveMsgClient.listRemoteTasksForChar(char.id);
        remote = new Set(remoteTasks.map((t) => t.uuid));
        setRemoteTaskInfo(new Map(remoteTasks.map((t) => [
          t.uuid, { status: t.status, lastError: t.lastError },
        ])));
      } catch {
        // 對帳失敗不打擾：null 讓「遠端不存在」徽標整體不顯示，也不清任何任務。
        setKnownRemoteUuids(null);
        return;
      }
      setKnownRemoteUuids(remote);

      // 對帳兩個方向都走：把已經走完的一次性任務清出列表（不然發過的任務會一直堆在
      // 這兒，得手動一條條取消），同時把遠端有、本地沒有的接回來——角色自排的任務是
      // 隨 push 認領的，那條 push 推失敗或被防穿幫閘吞掉，本地就永遠不知道它存在，
      // 而它照常到點觸發。先拿渲染時這份探一下有沒有變化，避免每次開面板都寫一次庫。
      // 真正落盤時在 updater 裡用最新的 prev 重算——面板保存要 await 網絡請求，
      // 這期間角色可能在聊天裡用工具排了新任務。
      const settle = (tasks: ActiveMsg2TaskRecord[]) =>
        pruneFiredTasks(reconcileTasksWithRemote(tasks, remoteTasks), remote, Date.now());
      const current = char.activeMsg2Config?.tasks ?? [];
      const settled = settle(current);
      const changed = settled.length !== current.length
        || settled.some((t, i) => t !== current[i]);
      if (changed) {
        onSave((prev) => ({
          ...(prev ?? { enabled: true, tasks: [] }),
          tasks: settle(prev?.tasks ?? []),
        }));
      }
    })();
    // char.activeMsg2Config 只在函數體裡讀當前值當探針，不進依賴——清理落盤會改它，
    // 進了依賴就是「清理 → 重跑 → 再清理」的自激循環。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, char.id]);

  /**
   * 拼一份要落盤的 config：
   *   - 角色級共享設置（enabled / maxTokens / 單獨 API）以面板表單為準——只有面板編輯它們；
   *   - 任務清單以「落盤那一刻的最新清單」為準，面板只通過 tasksOf 聲明自己動了哪一條。
   * 別把渲染時的 tasks 整份傳下去，原因見 onSave 的註釋。
   */
  const buildConfig = (
    prev: ActiveMsg2CharacterConfig | undefined,
    tasksOf: (prevTasks: ActiveMsg2TaskRecord[]) => ActiveMsg2TaskRecord[],
    extra?: Partial<ActiveMsg2CharacterConfig>,
  ): ActiveMsg2CharacterConfig => ({
    enabled: true,
    tasks: tasksOf(prev?.tasks ?? []),
    // 開著就存 undefined（= 跟隨全局默認開），只有顯式關掉才落 false。
    instantChatEnabled: instantChatOn ? undefined : false,
    maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
    maxUnansweredSends: maxUnanswered === '' ? undefined : Number(maxUnanswered),
    useSecondaryApi: useSecondaryApi && !!secUrl,
    secondaryApi: useSecondaryApi && secUrl
      ? { baseUrl: secUrl.trim(), apiKey: secKey.trim(), model: secModel.trim() }
      : undefined,
    lastSyncedAt: prev?.lastSyncedAt,
    ...extra,
  });

  const loadPreset = (preset: ApiPreset) => {
    setSecUrl(preset.config.baseUrl);
    setSecKey(preset.config.apiKey);
    setSecModel(preset.config.model);
    setTestConnectionResult(null);
  };

  const handleSavePreset = () => {
    if (!newPresetName.trim()) return;
    onAddApiPreset(newPresetName.trim(), { baseUrl: secUrl, apiKey: secKey, model: secModel });
    setNewPresetName('');
    setShowSavePreset(false);
  };

  const fetchModels = async () => {
    const baseUrl = normalizeApiBaseUrl(secUrl);
    const key = normalizeApiCredential(secKey);
    if (!baseUrl) { setModelStatusMsg('請先填寫 URL'); return; }
    setIsLoadingModels(true);
    setModelStatusMsg('正在連接...');
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await safeResponseJson(response);
      const models = extractModelIds(data);
      if (models.length > 0) {
        setAvailableModels(models);
        setModelSearchQuery('');
        setModelStatusMsg(`獲取到 ${models.length} 個模型`);
        setShowModelModal(true);
      } else {
        setModelStatusMsg('模型列表為空或格式不兼容');
      }
    } catch (error: any) {
      setModelStatusMsg(`連接失敗${error?.message ? `：${error.message}` : ''}`);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleTestConnection = async () => {
    const baseUrl = normalizeApiBaseUrl(secUrl);
    if (!baseUrl) return;
    setTestingConnection(true);
    setTestConnectionResult(null);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${normalizeApiCredential(secKey)}`, 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        setTestConnectionResult('✅ 連接成功');
      } else {
        const text = await response.text().catch(() => '');
        setTestConnectionResult(`❌ HTTP ${response.status}${text ? `：${text.slice(0, 100)}` : ''}`);
      }
    } catch (error: any) {
      setTestConnectionResult(`❌ 連接失敗${error?.message ? `：${error.message}` : ''}`);
    } finally {
      setTestingConnection(false);
    }
  };

  /**
   * 撥開關本身就算一次保存。
   *
   * 這是設置彈窗，用戶撥完開關就認為已經生效了。只改 React state 不寫庫的話，角色的
   * activeMsg2Config 還是空的（= 關）：聊天裡不注入排程工具、fire_pack 的
   * selfScheduleEnabled 上傳 false、重開面板開關又顯示成「關」，全程一句提示都沒有。
   *
   * 只有「開」這一側就地落盤。「關」要走底部那顆「關閉 2.0」按鈕：關掉的同時得把該
   * 角色在遠端的任務全部取消，這裡就地寫一個 enabled:false，遠端任務沒人管，會變成
   * 面板看不見卻照樣到點觸發的幽靈任務。
   */
  const handleToggleEnabled = () => {
    const turningOn = !enabled;
    setEnabled(!enabled);
    // 順手把面板上其它角色級設置（maxTokens / 連發上限 / 單獨 API）一起帶上，與
    // buildConfig 的口徑一致：這幾項本來就只有面板會寫。
    if (turningOn) onSave((prev) => buildConfig(prev, (list) => list));
  };

  /**
   * 即時對話開關也是撥了就落盤（跟上面同一習慣）。它沒有遠端任務要清，關掉只影響
   * 之後每一輪的路由，所以開關兩個方向都能就地保存。注意不能走 buildConfig：那份會
   * 把 enabled 釘成 true，而即時對話和排程是互相獨立的兩個開關，不能順手把排程也打開。
   */
  const handleToggleInstantChat = () => {
    const next = !instantChatOn;
    // 全局那個開關有自己的事件，這裡單獨記：想知道「按角色區分」這件事有沒有人真的用。
    trackEvent('切换角色的即时对话', { action: next ? '开' : '关' });
    setInstantChatOn(next);
    onSave((prev) => ({
      ...(prev ?? { enabled: false }),
      // 開著存 undefined（= 跟隨全局默認開），只有顯式關掉才落 false。
      instantChatEnabled: next ? undefined : false,
    }));
  };

  /**
   * 給角色留一句「這幾條被人工取消了」。
   *
   * 聊天歷史裡那句「明早八點叫你～」是角色自己許的承諾，任務在面板裡被刪掉之後它並不
   * 知道——下次聊天照舊說「放心我叫你」。所以取消也寫進作廢回執台帳（按 id 冪等），
   * 下一輪的排程現狀塊會把它讀出來告訴角色。寫失敗不打斷取消本身：任務確實已經沒了。
   */
  const writeCancelledNotices = async (cancelled: ActiveMsg2TaskRecord[]) => {
    const notices = buildUserCancelledNotices(char.id, cancelled, Date.now());
    if (!notices.length) return;
    try {
      await ActiveMsgStore.upsertExpiredNotices(char.id, notices);
    } catch (e) {
      console.warn('[ActiveMsg2Modal] 取消回執寫入失敗（角色可能還以為約定有效）', e);
    }
  };

  const handleCancelTask = async (t: ActiveMsg2TaskRecord) => {
    // alreadyGone = 遠端本來就沒有這一條（一次性任務發完就刪行）。這也是取消成功，
    // 只是文案上說清楚，免得用戶以為自己剛剛攔下了一條還沒發的消息。
    let alreadyGone = false;
    try {
      ({ alreadyGone } = await ActiveMsgClient.cancelTask(t.taskUuid));
    } catch (e) {
      // 遠端取消失敗不移除本地記錄（Codex #4）——否則遠端照發、面板卻看不見了。
      console.warn('[ActiveMsg2Modal] 遠端取消失敗（保留記錄待重試）', e);
      onSave((prev) => buildConfig(prev, (list) =>
        list.map((x) => x.taskUuid === t.taskUuid ? { ...x, lastError: '遠端取消失敗，可重試' } : x)));
      addToast(`任務 [${shortTaskId(t.taskUuid)}] 取消失敗（遠端未確認），稍後重試。`, 'error');
      // 排程有埋點、取消沒有的話，任務生命週期只記了一半。三個結果各有各的含義：
      // failed = 遠端照發但面板以為攔下了，是對帳不平裡最難受的一種。
      trackEvent('取消定时消息', { result: 'failed' });
      return;
    }
    if (editingTaskUuid === t.taskUuid) setEditingTaskUuid(null);
    await writeCancelledNotices([t]);
    setKnownRemoteUuids((prev) => applyRemoteTaskDelta(prev, { gone: [t.taskUuid] }));
    // 落盤走 onSave → OSContext.updateCharacter，那裡在落庫成功後會給 amsg2 雲端快照
    // 打髒（markAmsgStateDirty）——fire_pack 裡角色能看到的排程清單因此不會還留著這條
    // 已取消的任務。別在這裡用渲染時的 char 快照自己打髒：它的清單還是舊的。
    onSave((prev) => buildConfig(
      prev,
      (list) => list.filter((x) => x.taskUuid !== t.taskUuid),
      { lastSyncedAt: Date.now() },
    ));
    addToast(alreadyGone
      ? `任務 [${shortTaskId(t.taskUuid)}] 在遠端已不存在（多半已經發過了），已從列表移除。`
      : `任務 [${shortTaskId(t.taskUuid)}] 已取消。`, 'info');
    trackEvent('取消定时消息', { result: alreadyGone ? '远端已不存在' : 'ok' });
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      if (!enabled) {
        // 關閉 2.0 = 取消該角色全部遠端任務（遠端清單優先的口徑見 cancelAllTasksForChar，
        // 與刪角色共用一份）。取消失敗的保留在本地清單裡，下次重開面板可重試。
        const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(
          char.id,
          tasks.map((t) => t.taskUuid),
        );
        const attempted = new Set(targets);
        // 真被取消掉的那些（試過且沒失敗）要給角色一句交代，否則關掉 2.0 之後它還掛著
        // 一堆沒人會兌現的承諾。留在清單裡的（取消失敗 / 期間新出現的）不寫——它們還會響。
        await writeCancelledNotices(tasks.filter((t) =>
          attempted.has(t.taskUuid) && !failed.has(t.taskUuid)));
        onSave((prev) => buildConfig(
          prev,
          (list) => keepUncancelledTasks(list, attempted, failed, {
            failed: '關閉時遠端取消失敗，可重試',
            appeared: '關閉主動消息時新出現，未被取消，請單獨處理',
          }),
          { enabled: false, lastSyncedAt: Date.now() },
        ));
        addToast(failed.size
          ? `主動消息 2.0 已關閉，但有 ${failed.size} 個任務遠端取消失敗，請稍後重開面板重試。`
          : '主動消息 2.0 已關閉，全部任務已取消。', failed.size ? 'error' : 'info');
        onClose();
        return;
      }

      if (!globalReady) throw new Error('請先去系統設置裡完成“主動消息 2.0”的全局配置。');

      // 時間框裡的是用戶桌上的鐘，先折成絕對時刻再往下傳。裸牆鍾交出去的話，排程接口
      // 會按角色時區解釋它（那條規則是給角色自己排程用的），角色一開自定義時區就差一個
      // 時差。落盤也存這一份，面板顯示與遠端對帳因此認的是同一個時刻。
      const firstSendAt = fromDatetimeLocalValue(firstSendTime);

      // 傳給排程接口的這份只用來讀角色級設置（封頂校驗 / 副 API），不參與落盤。
      const config = buildConfig(saved, () => tasks);
      const result = await ActiveMsgClient.scheduleCharacterTask({
        char, config,
        task: {
          mode, firstSendTime: firstSendAt, recurrenceType,
          promptHint: promptHint.trim() || undefined,
          userMessage: userMessage.trim() || undefined,
          expirePolicy,
        },
        replaceTaskUuid: editingTaskUuid ?? undefined,
        userProfile, groups, realtimeConfig, apiConfig,
      });

      const record: ActiveMsg2TaskRecord = {
        taskUuid: result.uuid,
        clientTaskId: result.clientTaskId,
        mode, firstSendTime: result.firstSendAt, recurrenceType,
        promptHint: promptHint.trim() || undefined,
        userMessage: userMessage.trim() || undefined,
        expirePolicy: resolveExpirePolicy(mode, expirePolicy),
        source: 'user',
        status: 'scheduled',
        createdAt: Date.now(),
      };
      onSave((prev) => buildConfig(
        prev,
        // 並清單的規則（含替換失敗時保留舊記錄）與角色工具路徑共用 applyScheduledTask。
        (list) => applyScheduledTask(list, record, {
          replaceTaskUuid: editingTaskUuid ?? undefined,
          replacedCancelFailed: result.replacedCancelFailed,
        }, Date.now()),
        { lastSyncedAt: Date.now() },
      ));
      // 排程接口回了 success = 這條在遠端確實存在，記進底帳，別讓它被當成「遠端不存在」。
      // 編輯時舊任務已被取消才出帳；取消失敗的話遠端新舊並存，舊 uuid 要留著。
      setKnownRemoteUuids((prev) => applyRemoteTaskDelta(prev, {
        present: [result.uuid],
        gone: editingTaskUuid && !result.replacedCancelFailed ? [editingTaskUuid] : [],
      }));
      // 只報枚舉構成，內容、時間、編號一概不帶。mode/recurrence 雖有 TS 類型，但編輯路徑
      // 是從持久化任務記錄讀回來的（導入的備份可攜帶任意字符串），上報前運行時收斂一遍。
      trackEvent('排程定时消息', {
        mode: mode === 'fixed' || mode === 'prompted' ? mode : 'auto',
        recurrence: recurrenceType === 'daily' || recurrenceType === 'weekly' ? recurrenceType : 'none',
        source: 'user',
        isEdit: editingTaskUuid ? 'yes' : 'no',
      });
      setEditingTaskUuid(null);
      // 編輯走的是「先建新的再取消舊的」，編號必然換一個——只說「已更新」的話，
      // 用戶會以為列表裡那條陌生編號是多出來的。
      addToast(result.replacedCancelFailed
        ? '新任務已創建，但舊任務取消失敗，請稍後重試。'
        : (editingTaskUuid
          ? `任務已更新，編號換成 [${shortTaskId(result.uuid)}]。`
          : `任務已創建 [${shortTaskId(result.uuid)}]。`),
      result.replacedCancelFailed ? 'error' : 'success');

      // 角色級 API（單獨 API 開關 / 三件套）這次可能剛改過：支持憑據表的 Worker 上
      // 只要把這個角色那幾行覆蓋掉，已排的任務（含角色自排的）下次觸發就跟上了。
      // 老 Worker 上是 no-op，憑據靠下面逐條補刷。
      syncAmsgLlmCredentials(apiConfig);
      // 角色級 API（單獨 API 開關 / 三件套）也可能這次剛改過：剛排的這條已帶新憑據
      // （排程時現算），但同角色**其它** pending AI 任務裡凍結的還是舊的，就地刷一遍。
      // 用渲染時清單近似「其它任務」——保存期間角色剛用工具排的新任務會漏，下次保存
      // 或全局 API 保存時會補上。失敗只提示，不能掉進外層 catch 把整次保存標成失敗。
      const otherAiTasks = tasks.filter((t) =>
        t.taskUuid !== result.uuid
        && t.taskUuid !== editingTaskUuid
        && isPendingTask(t, Date.now()));
      if (otherAiTasks.length > 0) {
        try {
          const refresh = await ActiveMsgClient.refreshCharPendingAiTaskCredentials({
            char, config, apiConfig, tasks: otherAiTasks,
          });
          if (refresh.status === 'partial') {
            addToast(`該角色已有 ${refresh.failed} 條任務的 API 憑據沒刷新成功，稍後重新保存可重試。`, 'error');
          }
        } catch (refreshError) {
          console.warn('[ActiveMsg2Modal] 刷新其餘任務的 API 憑據失敗', refreshError);
        }
      }
    } catch (error: any) {
      const message = error?.message || '主動消息 2.0 保存失敗。';
      onSave((prev) => buildConfig(prev, (list) => list, { lastError: message }));
      addToast(message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="主動消息 2.0"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
            取消
          </button>
          <button onClick={handleSubmit} disabled={isSubmitting} className="flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50">
            {isSubmitting ? '保存中...' : !enabled ? '關閉 2.0' : (editingTaskUuid ? '保存修改' : '新建任務')}
          </button>
        </>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p className="text-xs leading-relaxed text-slate-500">
          這是新的雲端主動消息入口。它會把當前角色設定、最近聊天快照和推送訂閱一起提交到主動消息標準服務裡。長週期循環任務建議在劇情變化後重新保存一次，避免使用過舊的上下文。
        </p>

        <div className="flex items-center justify-between bg-fuchsia-50 border border-fuchsia-100 rounded-2xl p-4">
          <div>
            <div className="font-bold text-slate-700">啟用主動消息 2.0</div>
            <div className="text-xs text-fuchsia-600 mt-1">{pushSummary || '正在檢查 Push 狀態...'}</div>
          </div>
          <button
            onClick={handleToggleEnabled}
            className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        {/* 關著的時候面板下面整塊都是空的，不說一句的話，用戶看不出這個開關是按角色算的，
            也不知道打開它能換來什麼。 */}
        {!enabled ? (
          <p className="text-xs leading-relaxed text-slate-400 pl-1">
            主動消息 2.0 按角色單獨開啟。打開這個開關，TA 才能在聊天裡給你排定時消息，到點由雲端發出；你也可以在這裡手動建任務。
          </p>
        ) : null}

        {/* 即時對話按角色單獨關，和上面的排程開關互相獨立（只排程不即時、只即時不排程
            都行），所以不裹在 enabled 裡。全局那道門沒開時這裡只置灰說明，不代替它。 */}
        <div className={`flex items-center justify-between rounded-2xl p-4 border ${globalInstantChatOn ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-100'}`}>
          <div className="min-w-0 pr-3">
            <div className={`font-bold ${globalInstantChatOn ? 'text-slate-700' : 'text-slate-400'}`}>即時對話</div>
            <div className="text-xs text-slate-400 mt-1 leading-relaxed">
              {globalInstantChatOn
                ? '開著時 TA 的回覆在雲端生成、走推送送回，發完就能鎖屏。關掉的話這個角色回到本地生成。'
                : '需要先在全局設置裡開啟即時對話，才能按角色單獨調。'}
            </div>
          </div>
          <button
            onClick={handleToggleInstantChat}
            disabled={!globalInstantChatOn}
            className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${globalInstantChatOn && instantChatOn ? 'bg-fuchsia-500' : 'bg-slate-200'} ${!globalInstantChatOn ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${globalInstantChatOn && instantChatOn ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        {/* 閘攔下一次觸發時不發任何推送，遠端那行任務卻照樣被消費掉——不說一聲的話，
            「讓路了」在用戶看來跟「沒發出去 / 功能壞了」完全一樣。 */}
        {enabled && lastSkip ? (
          <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-slate-600">
            {describeLastSkip(lastSkip, (ms) => formatTaskTime(new Date(ms).toISOString()))}
          </div>
        ) : null}

        {enabled && tasks.length > 0 ? (
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
              任務列表（{tasks.length}）
            </label>
            {/* 一次 render 內所有任務用同一個 now，免得同屏卡片踩在不同的時刻上判定。 */}
            <div className="space-y-2">
              {tasks.map((t) => {
                // 循環任務顯示的是「下一次」，不是創建時那個錨點（見 currentOccurrenceMs）。
                const occurrenceMs = currentOccurrenceMs(t, now);
                const missingRemote = isRemoteMissingTask(t, knownRemoteUuids, now);
                const remoteInfo = remoteTaskInfo?.get(t.taskUuid);
                // 遠端記錄的「上一次沒發出去」——worker 只在失敗時寫、成功不清，
                // 文案裡帶時間就不會把老記錄讀成「現在還壞著」。
                const remoteErrorText = describeRemoteLastError(remoteInfo?.lastError, formatTaskTime);
                return (
                  <div key={t.taskUuid} className={`rounded-2xl border px-4 py-3 text-xs ${editingTaskUuid === t.taskUuid ? 'border-fuchsia-400 bg-fuchsia-50' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-700 truncate">
                          [{shortTaskId(t.taskUuid)}] {formatTaskTime(occurrenceMs ?? t.firstSendTime)} · {describeRecurrence(t.recurrenceType)}
                        </div>
                        {/* 進度排最前：這一行會被截斷，而「發沒發」是用戶最想先看到的一條，
                            排在末尾的話（模式描述可能很長）它永遠看不見。 */}
                        <div className="text-slate-400 mt-0.5 truncate">
                          {describeTaskProgress(t, knownRemoteUuids, now, remoteInfo?.status)} · {describeTaskMode(t)}
                          · {describeExpirePolicy(t.expirePolicy)}
                          · {t.source === 'character' ? '角色創建' : '手動創建'}
                        </div>
                        {missingRemote ? (
                          <div className="text-slate-400 mt-1 text-[11px]">⚠ 遠端不存在（可能已發送或在別處取消）</div>
                        ) : null}
                        {remoteErrorText ? (
                          <div className="text-amber-600 mt-1 text-[11px]">⚠ {remoteErrorText}</div>
                        ) : null}
                        {/* 上面那行只留得下原因的關鍵半句，狀態碼和上游原話的其餘部分都截掉了。
                            原文收在這裡，排查或者截圖問人時點開就能看到全文。stale 是個機器詞，沒有原文可看。 */}
                        {remoteErrorText && remoteInfo?.lastError?.reason && remoteInfo.lastError.reason !== 'stale' ? (
                          <details className="mt-0.5">
                            <summary className="cursor-pointer text-[10px] font-bold text-slate-400">原文</summary>
                            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-slate-500 bg-slate-50 rounded-lg p-2 select-text">
                              {remoteInfo.lastError.reason}
                            </pre>
                          </details>
                        ) : null}
                        {t.lastError ? (
                          <div className="text-red-500 mt-1 text-[11px]">{t.lastError}</div>
                        ) : null}
                      </div>
                      <div className="flex gap-2 shrink-0 ml-2">
                        <button onClick={() => setEditingTaskUuid(t.taskUuid)} className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-bold">編輯</button>
                        <button onClick={() => void handleCancelTask(t)} className="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-500 font-bold">取消</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {editingTaskUuid ? (
              <button onClick={() => setEditingTaskUuid(null)} className="mt-2 text-xs text-fuchsia-500 font-bold pl-1">
                ＋ 放棄編輯，改為新建任務
              </button>
            ) : null}
          </div>
        ) : null}

        {enabled ? (
          <>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
                {editingTaskUuid ? '編輯任務' : '新建任務'}
              </label>
              <div className="space-y-2">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => {
                      setMode(option.id);
                      // fixed 進不了 worker 閘（taskNeedsLlm=false），策略統一釘成 force。
                      if (option.id === 'fixed') setExpirePolicy('force');
                    }}
                    className={`w-full text-left rounded-2xl border px-4 py-3 transition-all ${mode === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    <div className="font-bold">{option.label}</div>
                    <div className={`text-xs mt-1 ${mode === option.id ? 'text-fuchsia-50' : 'text-slate-400'}`}>{option.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">首次發送時間</label>
              <input
                type="datetime-local"
                value={firstSendTime}
                onChange={(event) => setFirstSendTime(event.target.value)}
                className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">重複方式</label>
              <div className="grid grid-cols-3 gap-2">
                {RECURRENCE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setRecurrenceType(option.id)}
                    className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${recurrenceType === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-slate-400 mt-2 pl-1">
                2.0 標準版目前只支持：一次 / 每天 / 每週。30 分鐘、1 小時、2 小時這類間隔暫時不支持。
              </div>
            </div>

            {mode !== 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">到點時用戶正在聊天</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'expire', label: '自動作廢', desc: '轉為對話裡自然帶出' },
                    { id: 'force', label: '強制發送', desc: '鬧鐘型，照發' },
                  ] as const).map((option) => (
                    <button
                      key={option.id}
                      onClick={() => setExpirePolicy(option.id)}
                      className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${expirePolicy === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                    >
                      {option.label}
                      <div className={`font-normal mt-0.5 ${expirePolicy === option.id ? 'text-fuchsia-100' : 'text-slate-400'}`}>{option.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {mode === 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">固定消息內容</label>
                <textarea
                  value={userMessage}
                  onChange={(event) => setUserMessage(event.target.value)}
                  placeholder="到點後直接推送這段消息"
                  className="w-full h-28 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
                    {mode === 'prompted' ? '額外提示詞' : '補充靈感 (可選)'}
                  </label>
                  <textarea
                    value={promptHint}
                    onChange={(event) => setPromptHint(event.target.value)}
                    placeholder={mode === 'prompted' ? '例如：晚安前撒嬌一下，但別太油' : '例如：今天下雨、想找我聊一點輕鬆的'}
                    className="w-full h-24 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">maxTokens (可選)</label>
                  <input
                    type="number"
                    min={1}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="例如 120"
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
                  />
                </div>
              </>
            )}

            <div className="pt-1 border-t border-slate-100">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">連發上限</label>
              <select
                value={maxUnanswered}
                onChange={(event) => setMaxUnanswered(event.target.value)}
                className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              >
                <option value="">默認（{DEFAULT_MAX_UNANSWERED_SENDS} 條）</option>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>{n} 條</option>
                ))}
                <option value="0">不限</option>
              </select>
              <p className="text-xs text-slate-400 mt-1.5 pl-1 leading-relaxed">
                你沒回消息的時候，TA 最多連續主動發幾條——這就是 TA 能連續主動發言的次數上限（包括
                TA 給自己排的後續）。到上限後 TA 自己排的會暫停，你回一句就重新計數；你在這個面板裡
                親手排的任務不受它限制。比如你倆有時差、想讓 TA 在你睡覺時每隔一陣報備一句，就把這裡調大些。
              </p>
            </div>

            <div className="pt-1 border-t border-slate-100">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-bold text-slate-700">使用單獨 API</div>
                  <div className="text-xs text-slate-400 mt-1">不開啟則依次退回：角色自己的對話模型 API → 全局主 API。</div>
                </div>
                <button
                  onClick={() => setUseSecondaryApi(!useSecondaryApi)}
                  className={`w-12 h-7 rounded-full transition-colors relative ${useSecondaryApi ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${useSecondaryApi ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {useSecondaryApi ? (
                <div className="space-y-2 bg-slate-50 rounded-2xl p-3">
                  {apiPresets.length > 0 && (
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">我的預設</label>
                      <div className="flex gap-2 flex-wrap">
                        {apiPresets.map((preset) => (
                          <button
                            key={preset.id}
                            onClick={() => loadPreset(preset)}
                            className="flex items-center bg-white border border-slate-200 rounded-lg px-3 py-1 shadow-sm text-xs font-medium text-slate-600 hover:text-fuchsia-500 hover:border-fuchsia-200 active:scale-95 transition-all"
                          >
                            {preset.name}
                            <span className="ml-1.5 text-slate-300">{preset.config.model}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <input value={secUrl} onChange={(event) => { setSecUrl(event.target.value); setTestConnectionResult(null); }} placeholder="API URL" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                  <input type="password" value={secKey} onChange={(event) => { setSecKey(event.target.value); setTestConnectionResult(null); }} placeholder="API Key" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</span>
                      <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-fuchsia-500 font-bold">
                        {isLoadingModels ? '拉取中...' : '刷新模型列表'}
                      </button>
                    </div>
                    <input value={secModel} onChange={(event) => setSecModel(event.target.value)} placeholder="Model，或點右上角刷新拉取" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                    {modelStatusMsg && <p className="text-[10px] text-slate-400 mt-1">{modelStatusMsg}</p>}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={handleTestConnection}
                      disabled={testingConnection || !secUrl.trim()}
                      className="flex-1 py-2 bg-white text-slate-600 text-xs font-bold rounded-xl border border-slate-200 disabled:opacity-50 active:scale-95 transition-transform"
                    >
                      {testingConnection ? '測試中...' : '🧪 測試連接'}
                    </button>
                    <button
                      onClick={() => setShowSavePreset((v) => !v)}
                      className="flex-1 py-2 bg-white text-slate-600 text-xs font-bold rounded-xl border border-slate-200 active:scale-95 transition-transform"
                    >
                      保存為預設
                    </button>
                  </div>
                  {testConnectionResult && <p className="text-[10px] text-slate-500">{testConnectionResult}</p>}
                  {showSavePreset && (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newPresetName}
                        onChange={(event) => setNewPresetName(event.target.value)}
                        onKeyDown={(event) => event.key === 'Enter' && handleSavePreset()}
                        placeholder="預設名稱..."
                        className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs"
                        autoFocus
                      />
                      <button onClick={handleSavePreset} className="px-4 py-2 bg-fuchsia-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform">
                        保存
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            {showModelModal && (() => {
              const query = modelSearchQuery.trim().toLowerCase();
              const filteredList = query ? availableModels.filter((m) => m.toLowerCase().includes(query)) : availableModels;
              return (
                <Modal isOpen title="選擇模型" onClose={() => setShowModelModal(false)}>
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={modelSearchQuery}
                      onChange={(event) => setModelSearchQuery(event.target.value)}
                      placeholder="搜索模型..."
                      className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-mono"
                      autoFocus
                    />
                    <div className="max-h-72 overflow-y-auto space-y-1 no-scrollbar">
                      {filteredList.length === 0 && (
                        <p className="text-[11px] text-slate-400 text-center py-4">沒有匹配的模型</p>
                      )}
                      {filteredList.map((m) => (
                        <button
                          key={m}
                          onClick={() => { setSecModel(m); setShowModelModal(false); }}
                          className="w-full text-left px-3 py-2 rounded-xl text-xs font-mono bg-slate-50 hover:bg-fuchsia-50 hover:text-fuchsia-600 transition-colors"
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                </Modal>
              );
            })()}
          </>
        ) : null}
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsg2SettingsModal);
