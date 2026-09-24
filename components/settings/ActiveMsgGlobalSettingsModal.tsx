import React, { useEffect, useRef, useState } from 'react';
import Modal from '../os/Modal';
import ConfirmDialog from '../os/ConfirmDialog';
import { ActiveMsg2GlobalConfig, RealtimeConfig } from '../../types';
import {
  ActiveMsgClient, ActiveMsg2PushStatus, fetchWorkerDiagnostics, fetchWorkerTickReport, readAmsgFailKind,
  type AmsgCronTriggerState,
} from '../../utils/activeMsgClient';
import {
  AmsgDiagnosticLevel, AmsgDiagnosticsProbe, type AmsgTickReportResult,
  buildAmsgDiagnosticRows, summarizeAmsgDiagnostics,
  INSTANT_CHAT_BLOCKER_HINTS, resolveInstantChatBlocker,
  type InstantChatGateInput,
} from '../../utils/amsgDiagnostics';
import { ActiveMsgStore, maskActiveMsgUserId } from '../../utils/activeMsgStore';
import { formatTaskTime } from '../../utils/amsg2Tasks';
import { isWorkerUrlCleared, wipeAmsgCloudData } from '../../utils/amsgStateSync';
import { rememberDetachedWorker } from '../../utils/amsgDetachedWorkers';
import { buildCloudflareDashboardUrl } from '../../utils/workerDeploy';
import { generateClientToken } from '../../utils/vapidGen';
import { loadPushVapid, savePushVapid } from '../../utils/pushVapid';
import {
  attachUpdateCapability,
  provisionAmsgBackend,
  waitForWorkerReady,
  type CfAccount,
  type ProvisionProgress,
} from '../../utils/cfProvision';
import { isAmsgServerVersionAtLeast } from '../../utils/amsgWorkerVersion';
import { trackEvent } from '../../utils/analytics';

// 滿血鏈路吃滿這些 worker 特性（amsg-server 2.6.0-next.4+）。探測不到端點（老部署
// 404 → null）或缺任何一項，就亮「重新部署」提示——worker 跑在用戶自己的帳號裡，
// 站點這邊發新版不會自動同步過去。
const REQUIRED_WORKER_FEATURES = [
  'client-state',
  'client-state-chunking',
  'agentic-hooks',
  'agentic-scratch',
  // 後台 fire 每輪把 tools 參數帶給 LLM（角色在主動消息裡用得上用戶自配的 MCP 工具）。
  'agentic-fire-tools',
  // hook 載荷自帶 readState / writeState，配置級 hook 不用再自己攢一份寫口。
  'hook-state-accessors',
  // onAfterSend 拿到本次 fire 的 scratch：自述回寫按真正送出去的段數落帳。
  'after-send-scratch',
  // 任務身份直接掛在 ctx 和 push 頂層，兩條排程路徑不用各抄一份 metadata。
  'fire-task-identity',
  'push-task-identity',
  // 庫導出信封餘量常量，push 體積按「庫補完字段之後」的尺寸算。
  'push-envelope-reserved-bytes',
  // 角色自排撞車時回已存在那行的投影，重跑那輪也記得下帳。
  'schedule-task-duplicate-row',
  // 循環任務的過期快進也回調，攢下的那幾次跳過在面板上看得見。
  'recurring-stale-skip-hook',
  // 任務行帶時區，daily / weekly 按角色所在時區的牆鍾推進。
  'task-timezone',
  // 推送訂閱按用戶存一份，排程不再攜帶；換訂閱後已排的任務自動跟上。
  'user-push-subscription',
  // 憑據存成表裡的一行、任務只帶引用（credRefs）。換 Key 只要覆蓋那一行，已排的任務
  // ——包括角色在觸發時給自己排的那些——下次觸發就用新憑據。缺了它就退回「憑據凍結
  // 進每條任務」的老路：換 Key 要逐條補刷，漏一條到點就是 401。
  'llm-credentials',
];
// features 之外還必須比版本：這波依賴的能力大多沒發獨立 flag，光查 features 分不出新舊。
//   next.5 — GET /messages 投影（charId/clientTaskId）、onBeforeFire 的 { skip } 出口
//   next.6 — 任務佔位租約（帶工具的 AI 任務常跑過一分鐘，沒有佔位會被相鄰 cron tick 重複推）
//   next.7 — hook 的 writeState（大內容旁路存 client_state）、Web Push payload 大小護欄
//   next.8 — fire 循環透傳 tools 請求參數（後台調用戶自配 MCP 的前置）
//   next.9 — 這一檔還兼做「bundle 裡有沒有自述回寫」的判據：角色發完把正文記回
//            client_state、下次到點接著說（fire_pack 的 self_log 槽位），是隨本波
//            bundle 一起上去的。舊 bundle 收到帶槽位的 fire_pack 只會把
//            `{{AMSG_SELF_LOG}}` 原樣發給 LLM，而 SERVER_VERSION 是打包時那份
//            amsg-server 的版本號，正好能把這類舊粘貼認出來。
//   next.11 — 推送訂閱改成按用戶存一份：這一檔起排程不再攜帶訂閱，前端走
//            /push-subscription 端點登記，舊 worker 上這個端點不存在。
//   next.12 — 「角色說過什麼」的落盤改掛在 onFireSettled 上（不論這次是發出去了、
//            跳過了還是拋錯了都調一次）。舊 worker 認不得這個 hook，會把它當成
//            無關配置直接忽略——而 bundle 這邊已經不再用 onAfterSend，表現就是
//            self_log 永遠不寫：角色到點不知道自己上次說過什麼，天天重複同一句。
//            同一檔還帶 run-tick 的同角色任務串行（serializeBy）。
//   next.15 — 這一檔能力密集，而且 bundle 裡的 wrapper 已經按新上游行為改寫：
//            即時對話 immediate 落庫即到期 + supersedesUuid 原子頂替；llmExtraBody
//            （思考鏈三件套上雲）；租約心跳續租（wrapper 不再配 claimLeaseMs，舊
//            上游沒有心跳 → 退回 10 分鐘死租約，isolate 死後任務乾等）；fire ctx
//            的 cancelTask / renewTask（角色取消 / 改期自己的排程）；client_state
//            條件寫（舊包不蓋新包）；任務行 last_error（失敗原因可查）。
//   next.16 — 即時對話改由 Durable Object 起跳，靠的就是這一檔的 runTask（按 uuid
//            跑單條）；錯誤響應帶 error.cause（真因不再只進 worker 日誌）；
//            getSchemaVersion（表結構對不對得上，由上游按自己的建表語句比對）。
//   next.17 — 用戶級 LLM 憑據表（PUT/GET/DELETE /llm-credentials）、任務的 credRefs、
//            fire hook 的 resolveLlmCredential。這一檔有獨立 flag（上面那條
//            'llm-credentials'），版本號列在這裡只是備個案。
//   next.20 — 推送被推送服務判死（410 / 404）時當終態，不再空轉重試——投遞是先生成
//            後推送，每重試一跳就白跑一整輪 LLM；同時把狀態碼結構化寫進 last_error
//            的 pushStatus，體檢的「這台設備」靠它拆穿「登記全綠但一條都不來」。
//            另外 client_state 的前綴清理改走字典序範圍：D1 把 LIKE pattern 壓到
//            50 字節（官方文檔沒寫），key 一長就整條語句報 pattern too complex，
//            同批的狀態寫入跟著一起回滾。
//   next.21 — 帶 body 的端點認 `Content-Encoding: gzip`：即時對話那條路上的正文
//            （整輪聊天）在客戶端壓過再發，舊 worker 不認這個頭，會把壓縮字節當
//            明文讀，報出來是一句「請求體不是合法的 JSON」——大消息一條都發不出去。
//            同一檔還有失敗記錄裡的 errorCode（`LLM_CALL_FAILED` 之類）和上游拒絕
//            請求時的原話：卡片上那句「生成失敗」從此說得出到底是模型名寫錯了、
//            餘額不夠，還是訂閱失效該去重新登記。
//   next.23 — 跟著 amsg-shared 0.4.0-next.8 一起升：shared 的通知字段校驗放行了
//            `silent: 'when-visible'`（靜音改由 Service Worker 按窗口可見性算）。
//            server 側沒有行為變化，單升這一檔不解決任何問題；這批真正要用戶去點
//            一次「更新 Worker」的是通知策略本身，見 utils/amsgBundleVersion.ts。
//   next.26 — client_state 的條件寫不再被「來自未來」的時間戳鎖死。設備時鐘只要
//            領先過真實時間，那一刻同步上去的行就帶著一個還沒到的時刻，之後這台
//            設備發什麼都被判成「舊的」，雲端那行要等真實時間追上來才解得開；用戶
//            側的表現是某個角色的即時對話一直發不出去，刪消息、重裝、重填地址全都
//            不管用。這一檔兩件事：庫裡那種行不再有攔人的資格（存量能被覆蓋回來），
//            以及新寫入的護欄值鉗到服務端當前時刻（不再產生新的髒行）。舊部署上前端
//            的水位（utils/amsgStateClock.ts）能兜住發不出去這一半，但云端那行會一直
//            停在未來，只有升上來才會第一次寫入就回到現實。
//   next.27 — 兩件事。一、cron 每跳順手跑的幾條清理 DELETE 有了索引：client_state 和
//            message_outbox 上原先沒有對應的索引，每分鐘整表掃一遍，掃過的行全算進
//            D1 的 rows read，兩張表合計一千七百行就把免費額度（每天 500 萬行）用完，
//            之後整個 worker 報「exceeded daily row read limit」、所有查詢都拒。索引在
//            用戶點「重新連接並驗證」（POST /init-tenant）時補上，「更新 Worker」會自動
//            接一次。二、PUT /client-state 認 value: null 刪行：客戶端取回旁路存的大
//            內容後把那行真的刪掉，不再留空殼（即時對話每輪的鍵都是新的，空殼只漲不
//            跌，worker 每次生成都要把整個角色命名空間讀一遍）。前端接入見
//            utils/activeMsgClient.ts 的 clearClientStateValue 與存量空殼清理。
//   next.28 — 跟著 amsg-shared 0.4.0-next.10 一起升：中轉站回 HTTP 200、響應體裡卻是
//            報錯時，按模型調用失敗處理，原話寫進 last_error、任務照常重試。舊 worker
//            上這類響應被當成模型「這輪沒說話」靜默跳過，面板上只寫「沒寫出要說的話」，
//            看不出是中轉站在報錯。同一批還帶上 0.4.0-next.9 的脫敏補漏：形狀像模型名
//            的自建網關 Key 不再明文進 last_error。
// 不比版本的話，舊粘貼部署會被誤判為最新，問題全在 worker 側靜默發生。
//
const REQUIRED_WORKER_VERSION = '2.6.0-next.28';

/**
 * 門檻故意落後於依賴時，把當前依賴的版本寫在這裡，表示「知道，是有意的」。
 *
 * next.29 多了按命名空間 / 按前綴清理的四條端點（「雲端數據」清點用的就是它們），但那是
 * **可選增強**：沒有它的 worker 照樣能清點和清理，只是「只在雲端留了上下文、既沒任務也
 * 沒憑據」的角色列不出來——那一頁會自己說明清單不是全集。為這個亮一次「版本過舊」、
 * 逼所有人重貼一遍部署，不值當。
 *
 * next.30 讓投遞重試少花錢：模型明確拒了請求（Key 失效、餘額不足、模型名寫錯……）一跳就
 * 終審，不再白試 4 次；內容已經落進收件箱、只是推送沒成的，重試只補推原文，不再重新生成。
 * 老 worker 上這些照舊是多花錢、不出錯，所以同樣不抬門檻——bundle 版本已經往前推了，
 * 設置頁會提示有更新。
 *
 * 守衛在 utils/amsgWorkerVersion.test.ts：門檻和這裡兩個都沒跟上依賴，測試就會紅，
 * 免得哪天真有「不更新就出錯」的改動被當成可選的漏過去。
 */
const WORKER_VERSION_LAG_ACK = '2.6.0-next.30';

/** 裝著打包好的 worker 代碼的部署倉庫：fork 它 → 在 Cloudflare 連上 → 以後點 Sync fork 更新。 */
const WORKERS_REPO_URL = 'https://github.com/Tosd0/sullyos-workers';
const SETUP_WALKTHROUGH_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/amsg2-setup-walkthrough.md';
/** 一鍵部署要的那枚 API Token 在這裡建。 */
const CF_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';

// 探測結果每次會話只報一次。refresh() 在開面板、連接成功、訂閱成功後都會跑一遍，
// 一個連不上、反覆點「連接」的人否則能一個人刷出十幾條同樣的結果，把分佈帶歪。
let workerCapsReported = false;
// 「即時對話開不了卡在哪」同樣每次會話只報一次，理由同上。
let instantChatGateReported = false;

/** 體檢每一行的配色與那一列小字。unknown 用灰：查不出結論時別拿顏色暗示好壞。 */
const DIAGNOSTIC_STYLES: Record<AmsgDiagnosticLevel, { dot: string; text: string; word: string }> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-600', word: '正常' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600', word: '注意' },
  bad: { dot: 'bg-rose-500', text: 'text-rose-600', word: '有問題' },
  unknown: { dot: 'bg-slate-300', text: 'text-slate-400', word: '查不到' },
};

/** 剛生成的密鑰明文：輸入框是 password 型，只能在這一處讓用戶看見並手動複製。 */
const SecretReveal: React.FC<{ value: string; className?: string }> = ({ value, className = '' }) => (
  <p className={`font-mono text-[10px] leading-relaxed text-slate-500 break-all bg-white border border-slate-200 rounded-xl px-2 py-1.5 ${className}`}>
    {value}
  </p>
);

interface ActiveMsgGlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** 「清空雲端數據」清完要立刻把工具憑據補傳回去，所以這裡需要當前這份配置。 */
  realtimeConfig: RealtimeConfig;
  /** 由 Settings 注入：點「去推送憑據面板」時打開頂層 PushVapidSettingsModal */
  onOpenVapid?: () => void;
  /** 打開「雲端數據」清點頁（跟 onOpenVapid 一樣，由設置頁負責渲染那個面板）。 */
  onOpenCloudData?: () => void;
}

const ActiveMsgGlobalSettingsModal: React.FC<ActiveMsgGlobalSettingsModalProps> = ({
  isOpen,
  onClose,
  addToast,
  realtimeConfig,
  onOpenVapid,
  onOpenCloudData,
}) => {
  const [config, setConfig] = useState<ActiveMsg2GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  // 手動粘貼部署：給沒有 GitHub 帳號的人留的退路，默認收著不干擾主流程。
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState(false);
  // Deno 門面：workers.dev 在國內連不上時才需要，默認收著。
  const [denoProxyOpen, setDenoProxyOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<ActiveMsg2PushStatus | null>(null);
  // 「生成 Master Key」只在本次打開期間展示，前端不落盤——它是 worker 側密鑰，粘進 CF env 即可。
  const [generatedMasterKey, setGeneratedMasterKey] = useState('');
  const [generatedServerToken, setGeneratedServerToken] = useState('');

  // 一鍵部署：填一枚 CF Token，剩下的（建庫、傳 worker、寫密鑰、加定時）都自動做完。
  // Token 只在這次部署期間留在內存裡，成功與否都不落盤——它是能改整個帳號 Workers 的
  // 權限，真正需要長期留著的那一份已經作為 secret 寫進用戶自己的 worker 了（自更新用）。
  const [cfToken, setCfToken] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionStep, setProvisionStep] = useState('');
  /** token 能用在多個帳號上時讓用戶挑一個。 */
  const [provisionAccounts, setProvisionAccounts] = useState<CfAccount[] | null>(null);
  /** 全新的 CF 帳號還沒有 workers.dev 子域，得先起一個。 */
  const [needsSubdomain, setNeedsSubdomain] = useState(false);
  const [desiredSubdomain, setDesiredSubdomain] = useState('');
  const [provisionError, setProvisionError] = useState('');

  // 補裝更新能力：老辦法裝的後端裡沒有 CF_API_TOKEN，點更新會被頂回來。
  // 粘一枚 token 就能就地補上，不用去 Cloudflare 面板。只在真的缺鑰匙時才露出來。
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachToken, setAttachToken] = useState('');
  const [attachScriptName, setAttachScriptName] = useState('');
  const [attachNeedsScriptName, setAttachNeedsScriptName] = useState(false);
  const [attachAccounts, setAttachAccounts] = useState<CfAccount[] | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState('');

  // 體檢：worker 的 GET /debug 結果。它早就把「缺哪個變量、缺哪張表、缺哪幾列、cron
  // 有沒有停」都算好了，但入口一直只有手拼 URL——而這幾樣恰恰是「界面上一切正常、
  // 就是一條都不發」的全部原因。存原始探測結果，紅綠燈在渲染時算（推送狀態一變就跟著走）。
  const [diagnosticsProbe, setDiagnosticsProbe] = useState<AmsgDiagnosticsProbe | null>(null);
  // 定時任務的逐條細帳（GET /tick-report）。/debug 只知道「幾條到點沒發」，為什麼沒發要看這份。
  const [tickReportResult, setTickReportResult] = useState<AmsgTickReportResult | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  // 體檢擺在最上面，但默認收著：裝好之後它天天是「都正常」，攤開佔掉半屏。
  // 標題那一行已經把結論說了，要看是哪一項才需要點開。
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [workerOutdated, setWorkerOutdated] = useState(false);
  /**
   * 用戶那台 Worker 上的後端代碼是不是最新的（見 ActiveMsgClient.probeWorkerVersion）。
   * null = 還沒探到（沒填地址 / 正在探）。界面拿它決定更新按鈕是高亮催更新還是弱化。
   */
  const [workerVersion, setWorkerVersion] = useState<
    { state: 'current' | 'outdated' | 'unknown'; deployed: string | null; expected: string } | null
  >(null);
  /** 自更新成功後 worker 報回來的代碼指紋，顯示出來好讓人確認這次真換了。 */
  const [selfUpdateHash, setSelfUpdateHash] = useState('');
  /**
   * 後台任務的定時觸發（Worker 的 cron trigger）現在開著沒有，見 ActiveMsgClient.getCronTriggerState。
   * null = 這台 Worker 沒有這個端點（舊版）或沒讀到，按鈕整個不顯示。
   * token-missing = 端點在、但 Worker 沒配 CF_API_TOKEN，點按鈕先引導補鑰匙。
   */
  const [cronState, setCronState] = useState<
    { kind: 'known'; enabled: boolean } | { kind: 'token-missing'; message: string } | null
  >(null);
  /** 「暫停後台任務」的確認框開著沒有。恢復不用確認。 */
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  // 這台 worker 認不認 /instant-chat。即時對話的**唯一**版本門檻就在這兒，
  // 別處不做逐調用預檢——每發一條消息多探一次網絡，探失敗還分不清是舊版還是網抖。
  const [instantChatSupported, setInstantChatSupported] = useState(false);

  // 特性探測：確認「過老」（端點 404 → null，或缺關鍵特性）才亮牌；
  // 探測本身失敗（斷網 / 密鑰不對 / 沒填地址）不亮，避免誤報。
  const probeWorkerCaps = async (workerConfigured: boolean) => {
    // 只有配了地址才報：沒填地址時這次探測必然失敗，那不是版本問題。
    const shouldReport = workerConfigured && !workerCapsReported;
    if (shouldReport) workerCapsReported = true;
    try {
      const caps = await ActiveMsgClient.getCapabilities();
      const missingFeature = !caps || REQUIRED_WORKER_FEATURES.some((f) => !caps.features.includes(f));
      const versionTooOld = !caps || !isAmsgServerVersionAtLeast(caps.serverVersion, REQUIRED_WORKER_VERSION);
      setWorkerOutdated(missingFeature || versionTooOld);
      // 跑著舊 worker 的表現是**靜默錯**（自述回寫不落盤、任務重複推），用戶不會來報，
      // 面板這一句提示是唯一的出口。這裡數的就是「有多少人正跑著一個不該跑的版本」。
      if (shouldReport) {
        trackEvent('探测 2.0 Worker 能力', {
          result: !caps ? '端点不存在' : missingFeature ? '缺特性' : versionTooOld ? '版本过旧' : 'ok',
        });
      }
    } catch {
      setWorkerOutdated(false);
      // 探測本身炸了（斷網 / 地址不通）不亮牌，免得誤報；但它跟「版本舊」是兩回事，
      // 單獨佔一格，看分佈時能一眼把這批人排除掉。
      if (shouldReport) trackEvent('探测 2.0 Worker 能力', { result: '探测失败' });
    }
  };

  // 已經存過盤的那個 Worker 地址。清空確認要用它：確認之前不能換地址，
  // 取消遠端任務的那幾個請求還得發到舊那台上去。
  const savedWorkerUrlRef = useRef('');

  /**
   * 拉一次體檢。沒填地址時不拉——那時候唯一該做的事是把地址填上，
   * 擺一排紅燈只會讓人以為哪兒壞了。
   */
  const runDiagnostics = async () => {
    setDiagnosing(true);
    try {
      // 兩個端點互不依賴，並排拉；細帳那邊失敗不拋，不會拖垮體檢本身。
      const [probe, tickReport] = await Promise.all([fetchWorkerDiagnostics(), fetchWorkerTickReport()]);
      setDiagnosticsProbe(probe);
      setTickReportResult(tickReport);
    } finally {
      setDiagnosing(false);
    }
  };

  /** 把 worker 報回來的定時觸發狀態翻成界面上的三態（見 cronState 的說明）。 */
  const applyCronTriggerState = (state: AmsgCronTriggerState | null) => {
    if (!state) {
      setCronState(null);
      return;
    }
    if (state.supported && typeof state.enabled === 'boolean') {
      setCronState({ kind: 'known', enabled: state.enabled });
      return;
    }
    if (state.code === 'CF_TOKEN_MISSING') {
      setCronState({ kind: 'token-missing', message: state.message || '' });
      return;
    }
    // 別的原因（認不出 Worker 名、CF 那邊讀不到）：按鈕不顯示，原因留在 console 裡備查。
    if (state.message) console.warn('[amsg2] 讀不到後台任務的定時觸發狀態：', state.message);
    setCronState(null);
  };

  /**
   * 報一次「即時對話此刻能不能開、開不了卡在哪」。
   *
   * 這一格只能在這兒收：開關灰著的時候用戶什麼都點不動，也就不會產生任何別的事件——
   * 光看配置快照裡那個開/關，被擋在門外的人和「不想要這功能的人」長得一模一樣。
   * 判定跟界面上那行黃字共用 resolveInstantChatBlocker，兩處不會各說各話。
   */
  const reportInstantChatGate = (gate: InstantChatGateInput, enabled: boolean) => {
    if (instantChatGateReported) return;
    instantChatGateReported = true;
    trackEvent('即时对话能不能开', {
      result: resolveInstantChatBlocker(gate) ?? '可以开',
      // 已经开着的人也报：他们卡住意味着「开的时候好好的，后来 Worker 退回旧版了」，
      // 那是一种发一条挂一条、但设置页还写着「已开启」的坏法。
      state: enabled ? '已开着' : '还没开',
    });
  };

  const refresh = async () => {
    const nextConfig = await ActiveMsgClient.getGlobalConfig();
    const nextPushStatus = await ActiveMsgClient.getPushStatus();
    savedWorkerUrlRef.current = nextConfig.workerUrl || '';
    setConfig(nextConfig);
    setPushStatus(nextPushStatus);
    void probeWorkerCaps(Boolean(nextConfig.workerUrl?.trim()));
    if (nextConfig.workerUrl?.trim()) {
      void ActiveMsgClient.probeWorkerVersion().then(setWorkerVersion);
      void ActiveMsgClient.probeInstantChatSupport().then((supported) => {
        setInstantChatSupported(supported);
        reportInstantChatGate({
          connected: Boolean(nextConfig.initializedAt),
          pushSubscribed: Boolean(nextPushStatus?.hasSubscription),
          workerSupportsInstantChat: supported,
        }, Boolean(nextConfig.instantChatEnabled));
      });
      void runDiagnostics();
      // 已連接才問定時觸發開沒開：沒連上的時候這事還輪不到操心。
      if (nextConfig.initializedAt) void ActiveMsgClient.getCronTriggerState().then(applyCronTriggerState);
      else setCronState(null);
    } else {
      setInstantChatSupported(false);
      setDiagnosticsProbe(null);
      setTickReportResult(null);
      setWorkerVersion(null);
      setCronState(null);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setAdvancedOpen(false);
    setDiagnosticsOpen(false);
    setDeployOpen(false);
    setPasteFallbackOpen(false);
    // 兩個明文密鑰都要清：留到下次打開面板還掛在頁面上，就是白白多攤一次。
    setGeneratedMasterKey('');
    setGeneratedServerToken('');
    // CF Token 更要清：它比上面兩個都重，絕不留到下次打開。
    setCfToken('');
    setProvisionAccounts(null);
    setNeedsSubdomain(false);
    setDesiredSubdomain('');
    setProvisionError('');
    setAttachOpen(false);
    setAttachToken('');
    setAttachScriptName('');
    setAttachNeedsScriptName(false);
    setAttachAccounts(null);
    setAttachError('');
    setPauseConfirmOpen(false);
    void refresh();
  }, [isOpen]);

  /**
   * 地址被清空時的收尾：把「那邊還留著東西」說清楚，把舊地址記一筆，**不動雲端數據**。
   *
   * 早先這裡會順手把遠端任務全取消掉，理由是「地址一清，回覆推回來這邊也接不住」。
   * 但清空地址本身沒有毀滅的意味：用戶可能只是要換個反代端點、換個自定義域名，背後
   * 還是同一台 worker、同一個 D1，照著「地址變了」就去銷燬任務，等於把人家排好的東西
   * 刪了。真想清有專門的入口——「清空雲端數據」是用戶親手點的，那裡才該動手。
   *
   * 代價得說在明處：光存空值的話，前端這邊所有同步立刻停擺，D1 裡的任務卻一條沒少，
   * cron 每分鐘照常消費、照燒 LLM、照推送，只是內容永遠停在最後一次同步的樣子。所以
   * 這句提示必須把「任務不會被取消」寫明白，並且把舊地址記進備忘——地址一清，本地就
   * 再沒有別的地方記得它，用戶想回去清都找不到門。
   */
  const confirmDetachWorker = async (previousUrl: string): Promise<boolean> => {
    const ok = confirm(`清空 Worker 地址之後，那台 Worker 上已經排好的定時任務不會被取消——它們仍會按時觸發、照常推送，只是這邊管不到了。\n\n地址：${previousUrl}\n\n想連任務一起停掉的話，請先用下面「高級信息」裡的「清空雲端數據」清一遍，再回來清空地址。\n\n仍然清空嗎？`);
    if (!ok) return false;
    rememberDetachedWorker(previousUrl);
    addToast('地址已清空，雲端那份沒動。想清的話把地址填回來，用「清空雲端數據」清一遍。', 'info');
    return true;
  };

  const persistGlobalConfig = async () => {
    if (!config) return;
    const previousUrl = savedWorkerUrlRef.current;
    const nextUrl = config.workerUrl || '';
    if (isWorkerUrlCleared(previousUrl, nextUrl)) {
      if (!await confirmDetachWorker(previousUrl)) {
        // 用戶反悔：把地址填回輸入框，別留一個「界面空著、庫裡還存著」的錯位。
        patchConfig({ workerUrl: savedWorkerUrlRef.current });
        return;
      }
    } else if (previousUrl && nextUrl && previousUrl !== nextUrl) {
      // 換地址：多半隻是換了個入口（反代端點、自定義域名），背後還是同一台 worker，
      // 所以一個字節都不動，只把舊地址記一筆——萬一真是換了後端，用戶還有地方找回去。
      rememberDetachedWorker(previousUrl);
    }
    await ActiveMsgStore.saveGlobalConfig({
      workerUrl: config.workerUrl,
      serverToken: config.serverToken,
      instantChatEnabled: config.instantChatEnabled,
      // 一鍵部署生成的 Master Key 也要跟著存：這是本地唯一的一份，Worker 那邊讀不回來。
      masterKey: config.masterKey,
    });
    savedWorkerUrlRef.current = config.workerUrl || '';
  };

  useEffect(() => {
    if (!isOpen || !config) return;
    const timer = setTimeout(() => { void persistGlobalConfig(); }, 1000);
    return () => clearTimeout(timer);
  }, [config?.workerUrl, config?.serverToken, isOpen]);

  const patchConfig = (updates: Partial<ActiveMsg2GlobalConfig>) => {
    setConfig((prev) => ({
      ...(prev || { userId: '', workerUrl: '' }),
      ...updates,
    }));
  };

  const handleCreateSubscription = async () => {
    setLoading(true);
    try {
      // 建完瀏覽器訂閱還要登記到 worker 上那一份用戶級訂閱——worker 到點讀的是它，
      // 只在瀏覽器建訂閱的話雲端仍是空的，到點會拋 PUSH_SUBSCRIPTION_MISSING，
      // 而這句 toast 已經報了「準備完成」。
      await ActiveMsgClient.registerPushSubscription();
      await refresh();
      addToast('通知權限和推送訂閱已準備完成。', 'success');
      trackEvent('开启通知与推送订阅', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || '創建推送訂閱失敗。', 'error');
      // 只報拋錯那一刻掛上的代號（源碼裡寫死的枚舉）。錯誤原文可能帶 push endpoint，
      // 留在 toast 和 console 裡，不進上報。
      trackEvent('开启通知与推送订阅', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 一鍵部署：只要一枚 Cloudflare API Token，把後端從零裝好，裝完順手連上。
   *
   * 密鑰全部在本地生成，用戶不用複製粘貼任何東西。已經有的一律沿用——Master Key 換了
   * 之前排的任務全解不開，VAPID 換了瀏覽器現有的推送訂閱會全部 403。
   *
   * Token 只在這次操作期間留在內存裡，成功與否都不落盤。需要長期留著的那一份已經作為
   * secret 寫進用戶自己的 Worker 了（以後「更新後端」用的就是它）。
   */
  const handleOneClickDeploy = async (accountId?: string) => {
    const token = cfToken.trim();
    if (!token) {
      addToast('先把 Cloudflare API Token 填進來。', 'error');
      return;
    }

    setProvisioning(true);
    setProvisionError('');
    setProvisionStep('');
    try {
      const vapid = loadPushVapid();
      const result = await provisionAmsgBackend({
        token,
        accountId: accountId || undefined,
        desiredSubdomain: desiredSubdomain.trim() || undefined,
        secrets: {
          AMSG_MASTER_KEY: config?.masterKey || undefined,
          VAPID_PUBLIC_KEY: vapid.vapidPublicKey || undefined,
          VAPID_PRIVATE_KEY: vapid.vapidPrivateKey || undefined,
          VAPID_EMAIL: vapid.vapidEmail || undefined,
          AMSG_SERVER_TOKEN: config?.serverToken || undefined,
        },
        onProgress: (p: ProvisionProgress) => setProvisionStep(p.message),
      });

      if (!result.ok) {
        setProvisionStep('');
        // 這兩種不是失敗，是「還差一個信息」，界面上補個輸入再點一次就能接著走。
        if (result.code === 'ACCOUNT_AMBIGUOUS') {
          setProvisionAccounts(result.accounts || []);
          trackEvent('一键部署 2.0 后端', { result: '要选账号' });
          return;
        }
        if (result.code === 'SUBDOMAIN_MISSING') {
          setNeedsSubdomain(true);
          setProvisionError(result.message);
          trackEvent('一键部署 2.0 后端', { result: '要起子域名' });
          return;
        }
        setProvisionError(result.message);
        trackEvent('一键部署 2.0 后端', { result: '失败' });
        return;
      }

      // 先把密鑰落盤再連接：連接要用 serverToken，而 Master Key 一旦丟了就再也讀不回來。
      const { secrets } = result;
      savePushVapid({
        vapidPublicKey: secrets.VAPID_PUBLIC_KEY,
        vapidPrivateKey: secrets.VAPID_PRIVATE_KEY,
        vapidEmail: secrets.VAPID_EMAIL || undefined,
      });
      // instantChatEnabled 跟著一起寫：面板渲染時 config 一定不是 null（文件末尾有空值
      // 早退），讀到的就是界面上當前的值，不顯式帶上會被這次保存沖掉。
      await ActiveMsgStore.saveGlobalConfig({
        workerUrl: result.workerUrl,
        serverToken: secrets.AMSG_SERVER_TOKEN,
        masterKey: secrets.AMSG_MASTER_KEY,
        instantChatEnabled: config?.instantChatEnabled,
      });
      patchConfig({
        workerUrl: result.workerUrl,
        serverToken: secrets.AMSG_SERVER_TOKEN,
        masterKey: secrets.AMSG_MASTER_KEY,
      });
      savedWorkerUrlRef.current = result.workerUrl;

      setProvisionAccounts(null);
      setNeedsSubdomain(false);
      setCfToken('');
      result.warnings.forEach((warning) => addToast(warning, 'info'));
      // 別在這兒說「裝好了」就完事：地址還要幾十秒才在各個邊緣節點上生效，而上面那句
      // patchConfig 一落地，一鍵部署那張卡片就因為「地址已填」收起來了——進度條跟著消失，
      // 看上去像是全部辦妥。用戶於是去點「連接並啟用」，撞上還沒生效的地址。
      addToast(`後端裝好了：${result.workerUrl}。地址還要幾十秒才生效，等它自己連上就行。`, 'success');
      trackEvent('一键部署 2.0 后端', { result: '成功' });

      // 剛建好的 workers.dev 地址要等一會兒才解析得到，等它活過來再建表。
      setProvisionStep('等待 Worker 啟動…');
      const ready = await waitForWorkerReady(result.workerUrl);
      if (!ready) {
        addToast('Worker 裝好了，但地址還沒生效。過一兩分鐘點一下「連接並啟用」即可。', 'info');
        return;
      }
      setProvisionStep('正在建表…');
      const { warnings } = await ActiveMsgClient.connect();
      await refresh();
      warnings.forEach((warning) => addToast(warning.message, 'info'));
      addToast('已連接成功，主動消息 2.0 可以用了。', 'success');
    } catch (error: any) {
      // 報錯原文只進界面，不進上報（可能帶地址、帳號 id）。
      setProvisionError(error?.message || '部署過程中出錯了。');
      trackEvent('一键部署 2.0 后端', { result: '失败' });
    } finally {
      setProvisioning(false);
      setProvisionStep('');
    }
  };

  const handleConnect = async () => {
    if (!config?.workerUrl.trim()) {
      addToast('先把你部署的 Worker 地址填進來。', 'error');
      return;
    }

    setLoading(true);
    try {
      await ActiveMsgStore.saveGlobalConfig({
        workerUrl: config.workerUrl,
        serverToken: config.serverToken,
        instantChatEnabled: config.instantChatEnabled,
      });
      const { warnings } = await ActiveMsgClient.connect();
      await refresh();
      addToast('已連接成功，主動消息 2.0 可以用了。', 'success');
      // 連上了但有一塊是啞的（最典型是 VAPID 沒配齊：任務建得成、到點一條都推不出去，
      // 而界面上沒有任何異常）。這類問題用戶自己發現不了，連接這一刻不說就沒人說了。
      warnings.forEach((warning) => addToast(warning.message, 'info'));
      // 只報「這次連接成沒成 / 卡在哪一類」。連接串 / tenantToken / 錯誤原文一概不帶，
      // 也不報「之前配沒配過 tenant」——那等於把兩項憑據的配置狀態壓成一位發出去。
      // 失敗代號是拋錯時按 HTTP 狀態掛上的字面量（見 activeMsgClient 的 AmsgFailKind），
      // 分開是因為「密鑰對不上」和「D1 沒綁」要用戶去改的地方完全不同。
      trackEvent('连接并启用主动消息 2.0', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || '連接失敗。', 'error');
      trackEvent('连接并启用主动消息 2.0', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 讓後端自己更新到最新版本。
   *
   * 三種裝法（fork 後連 Git / Deploy 按鈕 / 找人代配）此前更新方式各不相同，最麻煩的一種
   * 要在兩個網站之間倒騰一個幾百 KB 的文件。有了這個按鈕都變成點一下。
   *
   * 更新成功後接著跑一次「連接並驗證」（POST /init-tenant，冪等）。
   *
   * 這一步不是可有可無的收尾：新版後端可能帶了新的表結構，而 D1 的建表只在這個端點裡做。
   * 少了它，Worker 代碼是新的、庫還是舊的，cron 每分鐘靜默失敗，主動消息整個停擺——
   * 而界面上一切正常，用戶完全看不出來（這個坑踩過）。讓「更新」自己把它帶上，
   * 就不必指望每個人都記得再手動點一次。
   *
   * 失敗不改判這次更新：代碼確實已經換上了，只是庫沒跟上。分開報，用戶才知道該點哪個。
   */
  const handleSelfUpdateWorker = async () => {
    setLoading(true);
    try {
      const result = await ActiveMsgClient.selfUpdateWorker();
      if (result.ok) {
        setSelfUpdateHash(result.bundleHash || '');
        setAttachOpen(false);
        addToast(result.message, 'success');
        try {
          await ActiveMsgClient.connect();
          await refresh();
        } catch (error: any) {
          addToast(
            `後端已更新，但緊接著的驗證沒過：${error?.message || '未知原因'}。手動點一下「重新連接並驗證」。`,
            'error',
          );
        }
      } else {
        addToast(result.message, result.supported ? 'error' : 'info');
        // 「缺 CF_API_TOKEN」是這裡唯一能就地解決的一種：露出補裝那一塊，
        // 用戶粘一枚 token 就好，不用去 Cloudflare 面板加變量。
        if (result.code === 'CF_TOKEN_MISSING') setAttachOpen(true);
      }
      trackEvent('更新后端 Worker', {
        result: result.ok ? 'ok' : result.supported ? 'failed' : 'unsupported',
      });
    } catch (error: any) {
      addToast(error?.message || '更新失敗。', 'error');
      trackEvent('更新后端 Worker', { result: 'failed' });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 暫停 / 恢復後台任務：讓 Worker 摘掉或加回自己的 cron trigger（見 worker/amsg/src/cronTrigger.ts）。
   *
   * 暫停期間到點的任務在 D1 裡排著，不會丟；恢復後的第一跳一起補發。
   * 走 GitHub 的 Sync fork 重新部署會按 wrangler.toml 把 cron 加回來，所以這不是永久開關。
   */
  const applyCronTrigger = async (enabled: boolean) => {
    setPauseConfirmOpen(false);
    setLoading(true);
    const action = enabled ? 'resume' : 'pause';
    try {
      const result = await ActiveMsgClient.setCronTriggerEnabled(enabled);
      if (result.ok) {
        setCronState({ kind: 'known', enabled });
        addToast(result.message, 'success');
      } else {
        addToast(result.message, 'error');
        // 缺 CF_API_TOKEN 是這裡唯一能就地解決的一種，跟自更新一樣露出補鑰匙那一塊。
        if (result.code === 'CF_TOKEN_MISSING') setAttachOpen(true);
      }
      trackEvent('暂停后台任务', { action, result: result.ok ? 'ok' : 'failed' });
    } catch (error: any) {
      addToast(error?.message || (enabled ? '恢復失敗。' : '暫停失敗。'), 'error');
      trackEvent('暂停后台任务', { action, result: 'failed' });
    } finally {
      setLoading(false);
    }
  };

  /** 暫停要先確認（點錯一下角色就全啞了），恢復直接做。 */
  const handleCronTriggerClick = () => {
    if (!cronState) return;
    if (cronState.kind === 'token-missing') {
      // 鑰匙還沒裝，先把補裝那一塊露出來；裝好之後再點就能真的暫停了。
      addToast(cronState.message || '這台 Worker 還沒配 CF_API_TOKEN，先在下面補一把鑰匙。', 'info');
      setAttachOpen(true);
      return;
    }
    if (cronState.enabled) setPauseConfirmOpen(true);
    else void applyCronTrigger(true);
  };

  /**
   * 給已經裝好的後端補上「自己更新自己」的鑰匙。
   *
   * 只寫 CF_API_TOKEN / CF_SCRIPT_NAME 兩條密鑰，不碰腳本也不碰別的綁定——手動部署的
   * 用戶，前端手裡根本沒有他們的 Master Key，走重傳那條路會把密鑰抹掉。
   */
  const handleAttachUpdateKey = async (accountId?: string) => {
    const token = attachToken.trim();
    if (!token) {
      addToast('先把 Cloudflare API Token 填進來。', 'error');
      return;
    }
    if (!config?.workerUrl.trim()) {
      addToast('先把 Worker 地址填好。', 'error');
      return;
    }

    setAttaching(true);
    setAttachError('');
    try {
      const result = await attachUpdateCapability({
        token,
        workerUrl: config.workerUrl,
        scriptName: attachScriptName.trim() || undefined,
        accountId,
      });

      if (!result.ok) {
        if (result.code === 'SCRIPT_NAME_UNKNOWN') {
          setAttachNeedsScriptName(true);
          setAttachError(result.message);
          trackEvent('补装后端更新能力', { result: '要填Worker名' });
          return;
        }
        if (result.code === 'ACCOUNT_AMBIGUOUS') {
          setAttachAccounts(result.accounts || []);
          trackEvent('补装后端更新能力', { result: '要选账号' });
          return;
        }
        setAttachError(result.message);
        trackEvent('补装后端更新能力', { result: '失败' });
        return;
      }

      setAttachToken('');
      setAttachAccounts(null);
      setAttachNeedsScriptName(false);
      addToast('鑰匙裝好了，現在可以點上面的「更新 Worker」了。', 'success');
      trackEvent('补装后端更新能力', { result: '成功' });
      // 鑰匙一到位，暫停後台任務那個按鈕也能用了，重新問一次它的狀態。
      void ActiveMsgClient.getCronTriggerState().then(applyCronTriggerState);
    } catch (error: any) {
      setAttachError(error?.message || '裝鑰匙時出錯了。');
      trackEvent('补装后端更新能力', { result: '失败' });
    } finally {
      setAttaching(false);
    }
  };

  // 手動粘貼部署用。主流程是 fork sullyos-workers + 在 CF 連 Git，這條是給沒有 GitHub
  // 帳號的人留的退路，所以在面板裡收在摺疊區裡。
  const handleCopyWorkerBundle = async () => {
    try {
      await ActiveMsgClient.copyWorkerBundleToClipboard();
      addToast('Worker 代碼已複製，去 CF 後台的 Edit code 裡粘貼覆蓋。', 'success');
      trackEvent('复制 2.0 Worker 代码', { result: 'ok' });
    } catch (error: any) {
      addToast(`複製失敗（${error?.message || error}）。也可以從倉庫 worker/amsg/worker.bundle.js 獲取。`, 'error');
      // 剪貼板 API 在非 HTTPS / 部分 WebView 裡會直接拋，這條就是那批人的規模。
      trackEvent('复制 2.0 Worker 代码', { result: 'failed' });
    }
  };

  // workers.dev 在國內連不上時的門面腳本。跟上面那份不一樣：這份不打包、原樣發佈，
  // 用戶要照著裡面的註釋改 UPSTREAM 那一行，所以註釋必須留著。
  const handleCopyDenoProxy = async () => {
    try {
      await ActiveMsgClient.copyDenoProxyToClipboard();
      addToast('代理代碼已複製，貼進 Deno Playground 後記得改 UPSTREAM 那一行。', 'success');
      trackEvent('复制 2.0 Deno 代理代码', { result: 'ok' });
    } catch (error: any) {
      addToast(`複製失敗（${error?.message || error}）。也可以從倉庫 worker/amsg/deno-proxy.ts 獲取。`, 'error');
      trackEvent('复制 2.0 Deno 代理代码', { result: 'failed' });
    }
  };

  /**
   * 複製密鑰時帶不帶 `變量名=` 前綴，看 Worker 地址填了沒：
   * 空著 = 還沒裝後端，用戶要去 Cloudflare 的 Variables and secrets 裡新建變量，
   * 給整行最省事（粘一行進去會自動拆成名字和值兩欄，不用對著抄名字）；
   * 填了 = 後端早裝好了，這會兒是回來改某一項的值，光標就停在值那一欄，
   * 整行粘進去會把變量名一起寫成值。
   */
  const copyWholeEnvLine = !config?.workerUrl?.trim();

  /**
   * 把剛生成的密鑰交給用戶：存進 state 供展示 + 儘量複製到剪貼板。
   * 輸入框是 password 型看不見內容，所以生成時必須把值顯示出來，
   * 否則「把同樣的值填進 Worker 環境變量」這一步沒法做。
   * 剪貼板不可用時用戶是從下方手抄的，所以展示的那份要和複製的一模一樣。
   */
  const revealAndCopy = async (value: string, reveal: (v: string) => void, envName: string) => {
    const text = copyWholeEnvLine ? `${envName}=${value}` : value;
    reveal(text);
    try {
      await navigator.clipboard.writeText(text);
      addToast(
        copyWholeEnvLine
          ? `已複製 ${envName} 整行，粘進 Worker 的 Variables 會自動填好名字和值。`
          : `已複製 ${envName} 的值（不含變量名），直接粘進 Cloudflare 的值那一欄。`,
        'success',
      );
    } catch {
      addToast(copyWholeEnvLine ? '已生成，請手動從下方複製整行。' : '已生成，請手動從下方複製。', 'info');
    }
  };

  const handleGenerateMasterKey = () => {
    // 只報「生成了哪一個」。密鑰本體只在這次面板打開期間存在於 state，前端不落盤，
    // 更不會進上報。
    trackEvent('生成 2.0 Worker 密钥', { which: 'master_key' });
    return revealAndCopy(ActiveMsgClient.generateMasterKey(), setGeneratedMasterKey, 'AMSG_MASTER_KEY');
  };

  const handleWipeCloudData = async () => {
    if (!confirm(
      '確定清空雲端數據？Worker D1 裡屬於你的這幾樣會一起刪掉：\n\n'
      + '· 已排程的主動消息任務（含角色自己排的）\n'
      + '· 同步上去的角色上下文與工具憑據\n'
      + '· 登記的 API 憑據\n'
      + '· 推送訂閱登記\n\n'
      + '任務刪了要重新排。角色上下文下次聊天會自動傳回去，API 憑據下次排程/發消息時重新登記，'
      + '工具憑據和推送訂閱當場就補登記。'
    )) return;
    setLoading(true);
    try {
      const result = await wipeAmsgCloudData(realtimeConfig, {
        pushRegistered: Boolean(pushStatus?.hasSubscription),
      });

      // 沒清乾淨的地方逐條說明白：這個按鈕多半是在「雲端數據已經出問題」時點的，
      // 含糊一句「部分失敗」會讓人不知道下一步該幹嘛。
      const problems: string[] = [];
      if (!result.tasks.listed) {
        problems.push('任務清單讀不出來（換過 AMSG_MASTER_KEY 的話舊任務解不開就會這樣），這些任務到點會失敗，Worker 會在 7 天后自動清掉它們');
      } else if (result.tasks.failed > 0) {
        problems.push(`${result.tasks.failed} 個任務沒取消成功，建議到角色的主動消息面板裡逐個處理`);
      }
      if (result.stateDeleted === null) {
        problems.push('角色上下文沒能刪掉');
      } else if (!result.toolConfigRestored) {
        problems.push('工具憑據沒能補傳回去，請到「實時感知」裡重新保存一次配置，否則已排程的 AI 任務會一直失敗');
      }
      if (result.llmCredentialsDeleted === null) {
        // 老 Worker 上壓根沒有這張表，這一句同樣成立：那邊確實沒清成，而下次排程會
        // 走回「憑據凍結進任務」的老路，也就無所謂殘留。
        problems.push('登記的 API 憑據沒能刪掉（Worker 版本較舊的話本來就沒有這一項）');
      }
      if (result.push === 'failed') {
        problems.push('推送訂閱沒能收拾乾淨，建議到上面的推送區域重新訂閱一次');
      }

      if (problems.length > 0) {
        addToast(`雲端數據沒能全部清乾淨：${problems.join('；')}。`, 'error');
      } else {
        const done = [
          `任務 ${result.tasks.total} 個`,
          `狀態 ${result.stateDeleted} 條`,
          `API 憑據 ${result.llmCredentialsDeleted} 行`,
        ];
        if (result.push === 'reregistered') done.push('推送訂閱已重新登記');
        addToast(`已清空雲端數據（${done.join('、')}）。`, 'success');
      }
    } catch (error: any) {
      addToast(error?.message || '清空雲端數據失敗。', 'error');
    } finally {
      setLoading(false);
      void refresh();
    }
  };

  /**
   * 開關即時對話。直接落盤而不是走那條 1 秒去抖的自動保存：開關是一次明確的動作，
   * 點完立刻生效（下一條消息就按新路走），而不是「點完還得等一下」。
   */
  const handleToggleInstantChat = async () => {
    const next = !config?.instantChatEnabled;
    // 開了又關是這條路上最值錢的信號：能開、開過、然後放棄了，跟「壓根沒開」不是一回事。
    trackEvent('切换即时对话', { action: next ? '开' : '关' });
    patchConfig({ instantChatEnabled: next });
    await ActiveMsgStore.saveGlobalConfig({ instantChatEnabled: next });
    addToast(next ? '已開啟即時對話，之後的聊天在你的 Worker 上生成。' : '已關閉即時對話，聊天回到本地生成。', 'success');
  };

  const handleGenerateServerToken = () => {
    const token = generateClientToken();
    patchConfig({ serverToken: token });
    trackEvent('生成 2.0 Worker 密钥', { which: 'server_token' });
    return revealAndCopy(token, setGeneratedServerToken, 'AMSG_SERVER_TOKEN');
  };

  if (!config) return null;

  const isConnected = Boolean(config.initializedAt);

  // 體檢：探測結果 + 「這台設備訂閱了沒」這個只有前端知道的事實，紅綠燈判定全在
  // amsgDiagnostics 那份純函數里（那邊有迴歸測試釘著）。
  const diagnosticRows = diagnosticsProbe
    ? buildAmsgDiagnosticRows({
      probe: diagnosticsProbe,
      localPushSubscribed: Boolean(pushStatus?.hasSubscription),
      // 跟任務卡片同一種寫法：cron 一分鐘一跳，秒位沒有意義。
      formatTime: (atMs) => formatTaskTime(atMs),
      tickReport: tickReportResult,
      // 用戶自己暫停了後台任務的話，任務攢著是意料之中，那一行不能報成觸發器壞了。
      cronPaused: cronState?.kind === 'known' && !cronState.enabled,
    })
    : [];
  const diagnosticLevel = diagnosticRows.length ? summarizeAmsgDiagnostics(diagnosticRows) : 'unknown';

  const instantChatBlocker = resolveInstantChatBlocker({
    connected: isConnected,
    pushSubscribed: Boolean(pushStatus?.hasSubscription),
    workerSupportsInstantChat: instantChatSupported,
  });
  const instantChatBlockedReason = instantChatBlocker ? INSTANT_CHAT_BLOCKER_HINTS[instantChatBlocker] : '';

  return (
    <>
    <Modal
      isOpen={isOpen}
      title="主動消息 2.0"
      onClose={onClose}
      footer={(
        <button
          onClick={onClose}
          className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
        >
          關閉
        </button>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        {/* 後台任務暫停著的時候常駐這一條：下面的按鈕在摺疊區裡，不然一眼看不出角色為什麼都不響。 */}
        {cronState?.kind === 'known' && !cronState.enabled ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
            後台任務已暫停，到點的消息先攢著，恢復後一起補發。
          </div>
        ) : null}

        {/* 體檢。主動消息壞掉的那幾種方式在界面上全是隱形的：D1 沒綁、表結構是舊的、
            VAPID 沒配、雲端沒登記收件設備——任務照建、面板照常，就是一條都不發。
            Worker 的 /debug 一直算得出這些，這裡只是把它擺到看得見的地方。 */}
        {config.workerUrl?.trim() ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
            {/* 收著時那句「都正常 / 有問題」就是全部結論，逐項細節點開再看。 */}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setDiagnosticsOpen((prev) => !prev)}
                className="flex-1 flex items-center justify-between gap-2 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="font-bold text-slate-700">體檢</span>
                  {diagnosticRows.length ? (
                    <span className={`text-xs font-bold ${DIAGNOSTIC_STYLES[diagnosticLevel].text}`}>
                      {diagnosticLevel === 'ok' ? '都正常' : diagnosticLevel === 'bad' ? '有問題' : diagnosticLevel === 'warn' ? '有提醒' : '查不全'}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs font-bold text-slate-400">{diagnosticsOpen ? '收起' : '展開'}</span>
              </button>
              {diagnosticsOpen ? (
                <button
                  type="button"
                  onClick={() => void runDiagnostics()}
                  disabled={diagnosing}
                  className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform disabled:opacity-50"
                >
                  {diagnosing ? '檢查中…' : '重新檢查'}
                </button>
              ) : null}
            </div>

            {!diagnosticsOpen ? null : diagnosticRows.length ? (
              <div className="space-y-2">
                {diagnosticRows.map((row) => {
                  const style = DIAGNOSTIC_STYLES[row.level];
                  return (
                    <div key={row.key}>
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${style.dot}`} />
                        <span className="flex-1 text-xs font-bold text-slate-600">{row.label}</span>
                        <span className={`shrink-0 text-[11px] font-bold ${style.text}`}>{style.word}</span>
                      </div>
                      {/* 正常的行不展開說明：全綠時這一列要短到能一眼掃完。 */}
                      {row.level === 'ok' ? null : (
                        <p className="mt-1 pl-3.5 text-[11px] leading-relaxed text-slate-500 whitespace-pre-line">
                          {row.detail}
                        </p>
                      )}
                      {/* 逐條細目（比如每條到點沒發的任務現在算哪種情況）。報錯原文默認收著：
                          多半很長，攤開會把整塊體檢撐滿，但排查時又必須看得到原話。 */}
                      {row.level === 'ok' || !row.items?.length ? null : (
                        <div className="mt-1.5 pl-3.5 space-y-1.5">
                          {row.items.map((item, index) => (
                            <div key={index} className="border-l-2 border-slate-100 pl-2 text-[11px] leading-relaxed text-slate-500">
                              <p className="whitespace-pre-line">{item.text}</p>
                              {item.raw ? (
                                <details className="mt-0.5">
                                  <summary className="cursor-pointer text-[10px] font-bold text-slate-400">原文</summary>
                                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-slate-500 bg-slate-50 rounded-lg p-2 select-text">
                                    {item.raw}
                                  </pre>
                                </details>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-slate-400">
                {diagnosing ? '正在問 Worker…' : '還沒有結果，點右上角檢查一次。'}
              </p>
            )}
          </div>
        ) : null}

        {/* 已經填了 Worker 地址就說明後端裝好了，這張卡收起來；重裝走「清掉地址再回來」這條路。 */}
        {config.workerUrl?.trim() ? null : (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-slate-700">一鍵部署（推薦）</span>
            <span className="shrink-0 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              只要一枚 Token
            </span>
          </div>

          <p className="text-xs leading-relaxed text-slate-500">
            在 Cloudflare 建一枚 API Token 粘進來，建數據庫、傳後端代碼、寫密鑰、加定時觸發
            全都自動做完。不用 GitHub 帳號，手機上也走得完。
          </p>

          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-1.5">
            <p className="text-[11px] font-bold text-slate-600">建 Token 時這三項權限都要勾上</p>
            <ul className="text-[11px] leading-relaxed text-slate-500 space-y-0.5 list-disc list-outside pl-4">
              <li>Account → <code className="font-mono">Workers Scripts</code> : Edit</li>
              <li>Account → <code className="font-mono">D1</code> : Edit</li>
              <li>Account → <code className="font-mono">Account Settings</code> : Read</li>
            </ul>
            <a
              href={CF_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackEvent('打开 2.0 部署外链', { target: 'CF面板' })}
              className="inline-block mt-1 text-[11px] font-bold text-violet-600"
            >
              ↗ 去 Cloudflare 建 Token
            </a>
          </div>

          <input
            type="password"
            value={cfToken}
            onChange={(e) => setCfToken(e.target.value)}
            placeholder="粘貼 Cloudflare API Token"
            autoComplete="off"
            className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
          />

          {provisionAccounts?.length ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold text-slate-600">這枚 Token 能用在多個帳號上，裝到哪個？</p>
              {provisionAccounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  disabled={provisioning}
                  onClick={() => void handleOneClickDeploy(account.id)}
                  className="w-full px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-left active:scale-95 transition-transform disabled:opacity-50"
                >
                  {account.name}
                </button>
              ))}
            </div>
          ) : null}

          {needsSubdomain ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold text-slate-600">給這個帳號起一個 workers.dev 子域名</p>
              <input
                type="text"
                value={desiredSubdomain}
                onChange={(e) => setDesiredSubdomain(e.target.value)}
                placeholder="例如 my-name（全 Cloudflare 唯一）"
                autoComplete="off"
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
              />
              <p className="text-[11px] leading-relaxed text-slate-400">
                後端地址會長這樣：<code className="font-mono">sullyos-amsg.你填的.workers.dev</code>。
                這個名字定了就是這個帳號所有 Worker 共用的，之後不好改。
              </p>
            </div>
          ) : null}

          <button
            type="button"
            disabled={provisioning || !cfToken.trim()}
            onClick={() => void handleOneClickDeploy()}
            className="w-full py-3 rounded-xl text-sm font-bold bg-violet-500 text-white active:scale-95 transition-transform disabled:opacity-50"
          >
            {provisioning ? provisionStep || '部署中…' : '開始部署'}
          </button>

          {provisionError ? (
            <p className="text-[11px] leading-relaxed text-rose-600 whitespace-pre-line">{provisionError}</p>
          ) : null}

          <p className="text-[10px] leading-relaxed text-slate-400">
            瀏覽器不能直接調 Cloudflare 的接口（它不給跨域），所以這枚 Token 會經過本站的
            網絡代理 Worker 轉發一次。部署完它會作為密鑰存進<strong>你自己的</strong> Worker，
            以後「更新後端」用的就是它；本頁不保存。介意的話可以照下面的手動方式裝。
          </p>
        </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setDeployOpen((prev) => {
              // 只在展開時記一筆：收起也記的話同一個人會被數兩次，漏斗第一格直接虛高一倍。
              if (!prev) trackEvent('展开 2.0 部署指引', { mode: '主流程' });
              return !prev;
            })}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">手動部署 Worker（想自己一步步來）</span>
            <span className="text-xs font-bold text-slate-400">{deployOpen ? '收起' : '展開'}</span>
          </button>

          {deployOpen ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-slate-500">
                全程在網頁上點，不用裝東西也不用敲命令，大約 15 分鐘。第一次做建議直接照著
                <strong>圖文教程</strong>走，下面是簡版。
              </p>
              <p className="text-xs leading-relaxed text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                這條手動路線裝的是上游作者的後端，沒有 Soren 的雲端功能（雲端回覆裡的照片、邀約、來電、改關係、已讀不回）。
                建議用上方的「一鍵部署」，裝的是 Soren 自己的版本；已經手動裝過的，用一鍵部署再裝一次就會覆蓋成 Soren 版。
              </p>

              <ol className="text-xs leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                <li>
                  Fork 後端倉庫 <code className="font-mono">sullyos-workers</code>
                  （頁面右上角 Fork → Create fork）。
                </li>
                <li>
                  CF 後台 Storage &amp; databases → <strong>D1 SQLite Database</strong> 建一個庫，
                  把它的 <strong>Database ID</strong> 複製下來。表不用建，下面點「連接」時會自動建好。
                </li>
                <li>
                  CF 後台 Workers &amp; Pages → <strong>Create application</strong> →
                  <strong> Continue with GitHub</strong>，選中你 fork 的倉庫，然後填：
                  <ul className="mt-1 space-y-0.5 list-disc list-outside pl-4">
                    <li>Build command：<code className="font-mono">sh ./deploy-prepare.sh</code></li>
                    <li>Advanced settings → Path：<code className="font-mono">/amsg</code></li>
                    <li>
                      Advanced settings 里加一個構建變量
                      <code className="font-mono"> D1_DATABASE_ID </code>
                      = 上一步的 Database ID（<strong>別點 Encrypt</strong>，構建時要讀它）
                    </li>
                  </ul>
                </li>
                <li>部署完在 Settings → Variables and secrets 按下面的清單填密鑰，再 Deploy 一次。</li>
              </ol>

              <p className="text-[11px] leading-relaxed text-slate-400">
                D1 綁定和「每分鐘檢查一次」的定時觸發器都寫在倉庫裡，會自動帶上，不用手動加。
                以後想更新，回你 fork 的倉庫點一下 <strong>Sync fork</strong> 就行，CF 會自動重新部署。
              </p>

              <div className="grid grid-cols-3 gap-2">
                {/* 三個出口合成一個事件帶 target 枚舉：它們是部署流程同一步的三條岔路，
                    拆成三個事件名只是多佔清單行數，看漏斗時還得自己加回去。 */}
                <a
                  href={WORKERS_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: 'fork仓库' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white text-center active:scale-95 transition-transform"
                >
                  ↗ Fork 倉庫
                </a>
                <a
                  href={SETUP_WALKTHROUGH_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: '图文教程' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ 圖文教程
                </a>
                <a
                  href={buildCloudflareDashboardUrl(config.workerUrl.trim() || undefined)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: 'CF面板' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ CF 面板
                </a>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5 text-xs">
                <p className="font-bold text-slate-700">環境變量清單</p>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">AMSG_MASTER_KEY</code>
                    <button
                      type="button"
                      onClick={() => void handleGenerateMasterKey()}
                      className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      生成並複製
                    </button>
                  </div>
                  {generatedMasterKey ? (
                    <SecretReveal value={generatedMasterKey} />
                  ) : (
                    <p className="text-[11px] text-slate-400">
                      加密任務內容用的密鑰，只存在 Worker 側。本頁不保存。
                      {copyWholeEnvLine
                        ? <>複製出來是 <code className="font-mono">變量名=值</code> 整行，粘進 CF 的 Variables 會自動分好兩欄。</>
                        : <>複製出來只有值本身，直接粘進 CF 裡那一項的值那一欄。</>}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">VAPID_EMAIL / PUBLIC_KEY / PRIVATE_KEY</code>
                    {onOpenVapid ? (
                      <button
                        type="button"
                        onClick={onOpenVapid}
                        className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                      >
                        去推送憑據面板
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    必須和「推送憑據 (VAPID)」面板裡的是<strong>同一對</strong>——
                    整個站點只有一個瀏覽器推送訂閱，Worker 用別的密鑰對籤推送會 403。
                  </p>
                </div>

                <div className="space-y-1">
                  <code className="font-mono text-[11px] text-slate-600">AMSG_SERVER_TOKEN（可選）</code>
                  <p className="text-[11px] text-slate-400">
                    防止別人濫用你的 Worker。值 = 下面「共享密鑰」填的那串，兩邊一致即可；不配則端點全開。
                  </p>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-2.5">
                <button
                  type="button"
                  onClick={() => setPasteFallbackOpen((prev) => {
                    if (!prev) trackEvent('展开 2.0 部署指引', { mode: '手动粘贴' });
                    return !prev;
                  })}
                  className="w-full flex items-center justify-between text-left text-[11px] font-bold text-slate-400"
                >
                  <span>沒有 GitHub 帳號？手動粘貼部署</span>
                  <span>{pasteFallbackOpen ? '收起' : '展開'}</span>
                </button>

                {pasteFallbackOpen ? (
                  <div className="mt-2 space-y-2">
                    <ol className="text-[11px] leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                      <li>
                        點下面「複製 Worker 代碼」，CF 後台 Create → Worker 建一個空 Worker，
                        進 <strong>Edit code</strong> 全選粘貼覆蓋，Deploy。
                      </li>
                      <li>
                        Settings → Bindings 加一個 <strong>D1 database</strong>，
                        變量名必須是 <code className="font-mono">DB</code>。
                      </li>
                      <li>
                        Settings → Trigger Events 加 <strong>Cron Trigger</strong>：
                        <code className="font-mono"> * * * * * </code>（每分鐘檢查一次到點任務）。
                      </li>
                      <li>Settings → Variables and secrets 按上面的清單填密鑰，然後重新 Deploy 一次。</li>
                    </ol>

                    <button
                      type="button"
                      onClick={() => void handleCopyWorkerBundle()}
                      className="w-full py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      複製 Worker 代碼
                    </button>

                    <p className="text-[11px] leading-relaxed text-slate-400">
                      這條路每次 Worker 更新都要重新粘一遍，D1 綁定和定時觸發器也得自己加，容易漏。
                      能用 GitHub 的話還是走上面的 fork 流程。
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">當前狀態</span>
            <span className={`text-xs font-bold ${isConnected ? 'text-emerald-600' : 'text-amber-600'}`}>
              {isConnected ? '已連接' : '未連接'}
            </span>
          </div>

          {workerOutdated ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
              Worker 上跑的還是舊版代碼，缺少新特性（大上下文雲端存儲、服務端工具循環等）。
              用一鍵部署裝的：按下方「更新 Worker」，或用同一枚 Token 再按一次一鍵部署（金鑰和資料都會保留）。
              手動裝的：回你 fork 的 <code className="font-mono">sullyos-workers</code> 倉庫點一下
              <strong> Sync fork</strong>，CF 會自動重新部署（當初是手動粘貼部署的話，
              去下方「部署 Worker」裡重新複製一次代碼粘貼覆蓋）。已有數據和任務不受影響。
            </div>
          ) : null}

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              Worker 地址
            </label>
            <input
              type="text"
              value={config.workerUrl}
              onChange={(event) => patchConfig({ workerUrl: event.target.value })}
              placeholder="https://amsg.你的帳號.workers.dev"
              className="w-full bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono"
            />

            <div className="mt-2">
              <button
                type="button"
                onClick={() => setDenoProxyOpen((prev) => {
                  if (!prev) trackEvent('展开 2.0 部署指引', { mode: 'Deno 代理' });
                  return !prev;
                })}
                className="w-full flex items-center justify-between text-left text-[11px] font-bold text-slate-400"
              >
                <span>這個地址連不上？在外面套一層 Deno</span>
                <span>{denoProxyOpen ? '收起' : '展開'}</span>
              </button>

              {denoProxyOpen ? (
                <div className="mt-2 space-y-2">
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    <code className="font-mono">workers.dev</code> 這個域名在國內連不上。
                    辦法是給它套一個門面：Worker 和數據全都留在 Cloudflare 不動，
                    只在外面加一層只管轉發的 Deno，然後把地址換成 Deno 那個。
                  </p>

                  <ol className="text-[11px] leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                    <li>
                      去 Deno 控制台點右上角 <strong>New Playground</strong>。
                    </li>
                    <li>
                      點下面「複製 Deno 代理代碼」，在 Playground 裡全選粘貼覆蓋，
                      把開頭 <code className="font-mono">UPSTREAM</code> 那一行改成你上面填的
                      Cloudflare 地址，然後 Deploy。
                    </li>
                    <li>
                      把 Deploy 後拿到的 <code className="font-mono">https://xxx.deno.net</code> 地址
                      填回上面的輸入框，替換掉原來那個。
                    </li>
                  </ol>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopyDenoProxy()}
                      className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      複製 Deno 代理代碼
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        trackEvent('打开 Deno 控制台');
                        window.open('https://console.deno.com', '_blank');
                      }}
                      className="shrink-0 px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      去 Deno
                    </button>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-400">
                    收消息不走這一層——推送是 Cloudflare 直接發給手機的，
                    所以這層就算掛了也只影響你打開這個面板改配置。
                    部署好後打開 <code className="font-mono">/__proxy-health</code> 能看它活著沒。
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              共享密鑰（可選）
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={config.serverToken || ''}
                onChange={(event) => patchConfig({ serverToken: event.target.value })}
                placeholder="worker 配了 AMSG_SERVER_TOKEN 才需要填"
                className="flex-1 bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
              <button
                type="button"
                onClick={() => void handleGenerateServerToken()}
                className="shrink-0 px-3 py-3 text-xs rounded-2xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
              >
                隨機
              </button>
            </div>
            {generatedServerToken ? (
              <SecretReveal value={generatedServerToken} className="mt-1.5" />
            ) : null}
          </div>

          {/*
            部署還沒收尾時這個按鈕必須是點不動的：剛建好的 workers.dev 地址要過幾十秒才在
            各個邊緣節點上都解析得到，這期間點連接必然報「連不上 Worker」。一鍵部署那條路
            自己會等（waitForWorkerReady），等到了還會順手把表建好——用戶搶在前面點，
            收穫的只有一次莫名其妙的失敗。
          */}
          <button
            onClick={handleConnect}
            disabled={loading || provisioning}
            className="w-full py-3 bg-slate-900 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {provisioning
              ? provisionStep || '部署中…'
              : loading ? '處理中...' : isConnected ? '重新連接並驗證' : '連接並啟用'}
          </button>

          <p className="text-xs leading-relaxed text-slate-500">
            「連接」會自動在你的 D1 裡把表建好（冪等，重複點沒關係），不用手動執行 SQL。
          </p>

          {isConnected ? (
            <div className="pt-1 space-y-2 border-t border-slate-200">
              {/*
                按鈕常駐，但有更新時才搶眼：有新版就實心高亮並寫明更新到哪一版，
                沒新版時弱化成一行淺色的「重新檢查並更新」——想手動重跑一次的人照樣點得到，
                不用為了這個去別處找入口。
              */}
              <button
                onClick={handleSelfUpdateWorker}
                disabled={loading}
                className={`w-full py-2.5 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50 ${
                  workerVersion?.state === 'outdated'
                    ? 'bg-emerald-600 text-white border border-emerald-600'
                    : 'bg-white border border-slate-300 text-slate-700'
                }`}
              >
                {loading
                  ? '處理中...'
                  : workerVersion?.state === 'outdated'
                    ? `更新 Worker 到 ${workerVersion.expected}`
                    : '重新檢查並更新 Worker'}
              </button>
              {workerVersion?.state === 'outdated' ? (
                <p className="text-xs leading-relaxed text-emerald-700">
                  你這台 Worker 上跑的是
                  {workerVersion.deployed ? <code className="font-mono"> {workerVersion.deployed} </code> : '更早的版本'}
                  ，更新後即時對話才走得上新的生成通道。
                </p>
              ) : workerVersion?.state === 'current' ? (
                <p className="text-xs leading-relaxed text-slate-500">
                  後端已經是最新版（<code className="font-mono">{workerVersion.expected}</code>）。
                </p>
              ) : null}
              <p className="text-xs leading-relaxed text-slate-500">
                後端自己去取最新代碼覆蓋自己，你排好的任務和填過的密鑰都不動，更新完會自動驗證一次。
                用一鍵部署裝的可以直接點；老辦法裝的第一次點會提示補一把鑰匙，就在下面補。
              </p>
              {selfUpdateHash ? (
                <p className="text-xs leading-relaxed text-emerald-600">
                  當前後端代碼指紋：<code className="font-mono">{selfUpdateHash}</code>
                </p>
              ) : null}

              {/* 暫停 / 恢復後台任務：摘掉或加回 Worker 的 cron trigger。舊版 Worker 沒這個端點時整塊不顯示。 */}
              {cronState ? (
                <>
                  <button
                    onClick={handleCronTriggerClick}
                    disabled={loading}
                    className={`w-full py-2.5 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50 ${
                      cronState.kind === 'known' && !cronState.enabled
                        ? 'bg-amber-500 text-white border border-amber-500'
                        : 'bg-white border border-slate-300 text-slate-700'
                    }`}
                  >
                    {loading
                      ? '處理中...'
                      : cronState.kind === 'known' && !cronState.enabled
                        ? '恢復後台任務'
                        : '暫停後台任務'}
                  </button>
                  <p className="text-xs leading-relaxed text-slate-500">
                    暫停會摘掉 Worker 的定時觸發，到點的主動消息和定時消息先攢在雲端，不會丟；恢復後一起補發。
                  </p>
                </>
              ) : null}

              {attachOpen ? (
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5">
                  <p className="text-[11px] font-bold text-slate-600">給這台後端補一把更新用的鑰匙</p>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    建一枚只勾 <strong>Account → Workers Scripts : Edit</strong> 的 Cloudflare API Token
                    粘進來（<strong>Start Date 留空</strong>），Soren 會把它寫進你這台 Worker。
                    做完一次以後更新就都是點上面那個按鈕了。
                  </p>
                  <a
                    href={CF_TOKEN_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => trackEvent('打开 2.0 部署外链', { target: 'CF面板' })}
                    className="inline-block text-[11px] font-bold text-violet-600"
                  >
                    ↗ 去 Cloudflare 建 Token
                  </a>
                  <input
                    type="password"
                    value={attachToken}
                    onChange={(e) => setAttachToken(e.target.value)}
                    placeholder="粘貼 Cloudflare API Token"
                    autoComplete="off"
                    className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
                  />

                  {attachNeedsScriptName ? (
                    <input
                      type="text"
                      value={attachScriptName}
                      onChange={(e) => setAttachScriptName(e.target.value)}
                      placeholder="這台 Worker 在 Cloudflare 上的名字"
                      autoComplete="off"
                      className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
                    />
                  ) : null}

                  {attachAccounts?.length ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-bold text-slate-600">多個帳號下都有同名 Worker，選一個：</p>
                      {attachAccounts.map((account) => (
                        <button
                          key={account.id}
                          type="button"
                          disabled={attaching}
                          onClick={() => void handleAttachUpdateKey(account.id)}
                          className="w-full px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-left active:scale-95 transition-transform disabled:opacity-50"
                        >
                          {account.name}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    disabled={attaching || !attachToken.trim()}
                    onClick={() => void handleAttachUpdateKey()}
                    className="w-full py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white active:scale-95 transition-transform disabled:opacity-50"
                  >
                    {attaching ? '裝鑰匙中…' : '裝上鑰匙'}
                  </button>

                  {attachError ? (
                    <p className="text-[11px] leading-relaxed text-rose-600 whitespace-pre-line">{attachError}</p>
                  ) : null}

                  <p className="text-[10px] leading-relaxed text-slate-400">
                    這一步只往你的 Worker 里加這一條密鑰，不動代碼、不動數據庫、不動已有的密鑰。
                    Token 寫進去之後就留在你自己的 Worker 裡，本頁不保存。
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">
              {pushStatus?.transport === 'unified-push' ? 'UnifiedPush 通知' : '通知權限'}
            </span>
            <span className={`text-xs font-bold ${pushStatus?.hasSubscription ? 'text-emerald-600' : 'text-amber-600'}`}>
              {pushStatus?.hasSubscription ? '已開啟' : '未開啟'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            這是第二步。只有你真的想讓角色在後台主動推送消息時，才需要點。
          </p>
          {pushStatus?.transport === 'unified-push' ? (
            <p className="text-xs leading-relaxed text-slate-500">
              Android App 通過開放的 UnifiedPush 收消息，不依賴 Firebase 或 Google 服務。
              ntfy 只負責在後台喚醒本 App，AMSG Worker 仍是你自己部署的那一台。
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-slate-500">
              推送跟著「排程時所在的設備」走：每條任務到點後，推給保存這條排程時用的那台設備。
              換了設備（或者換了瀏覽器）之後，在新設備上把排程重新保存一次，之後的推送就發到這台。
            </p>
          )}
          {pushStatus?.needsDistributor ? (
            <a
              href="https://docs.ntfy.sh/subscribe/phone/"
              target="_blank"
              rel="noreferrer"
              className="block text-xs font-bold text-violet-600 underline"
            >
              安裝並打開 ntfy（選擇無 Firebase 版本）
            </a>
          ) : null}
          {pushStatus?.detail ? (
            <p className="text-xs leading-relaxed text-amber-600">{pushStatus.detail}</p>
          ) : null}
          <button
            onClick={handleCreateSubscription}
            disabled={loading}
            className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '處理中...' : pushStatus?.transport === 'unified-push' ? '連接 ntfy 並開啟通知' : '開啟通知與推送'}
          </button>
        </div>

        {/* 即時對話：聊天本身也交給雲端跑。四道門缺一不可，缺哪道就把哪道寫出來——
            置灰而不說原因的話，用戶只會反覆點它。 */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">即時對話</span>
            {/* 開著但有門沒過時不能只寫「已開啟」——那幾道門是真的會讓這一輪走本地生成的，
                標成綠色的「已開啟」就是在騙人：用戶以為聊天在雲端跑，實際一直在本地。 */}
            <span className={`text-xs font-bold ${
              !config.instantChatEnabled ? 'text-slate-400'
                : instantChatBlockedReason ? 'text-amber-600' : 'text-emerald-600'
            }`}>
              {!config.instantChatEnabled ? '未開啟'
                : instantChatBlockedReason ? '已開啟 · 暫不生效' : '已開啟'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            開了以後，你發出的每一條消息都由這台 Worker 去生成回覆，回覆走推送回來。
            發完就能切後台、關掉應用，回來時消息已經在那兒了。關掉則回到本地直連生成。
          </p>
          {instantChatBlockedReason ? (
            <p className="text-xs leading-relaxed text-amber-600">{instantChatBlockedReason}</p>
          ) : (
            <p className="text-[11px] leading-relaxed text-slate-400">
              沒有逐字吐出，生成期間顯示「正在輸入…」；雲端明確報錯才會提示重發，
              只要還在生成或重試就一直等（LLM 慢不算失敗）。
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleToggleInstantChat()}
            disabled={loading || (!config.instantChatEnabled && !!instantChatBlockedReason)}
            className={`w-full py-3 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40 ${
              config.instantChatEnabled ? 'bg-slate-200 text-slate-600' : 'bg-slate-900 text-white'
            }`}
          >
            {config.instantChatEnabled ? '關閉即時對話' : '開啟即時對話'}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 text-xs leading-relaxed text-amber-700 space-y-2">
          <div className="font-bold text-amber-800">風險說明</div>
          <p>開了 2.0 以後，主動消息內容、提示詞、相關配置，都會進入你自己部署的 Worker 及其 D1 數據庫。</p>
          <p>這是你自己的 Worker、你自己的庫，項目不會額外接一個中心服務器。但只要數據進庫，能碰到這台 Worker / 數據庫的人（也就是你自己）就能看到這些內容。</p>
          <p>如果你不接受把私密提示詞、API Key 放進自己部署的服務，就不要開 2.0。</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">高級信息</span>
            <span className="text-xs font-bold text-slate-400">{advancedOpen ? '收起' : '展開'}</span>
          </button>

          {advancedOpen ? (
            <div className="space-y-3 text-xs">
              <div className="bg-violet-50 border border-violet-100 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-700">X-User-Id</span>
                  <span className="font-mono text-violet-600">{maskActiveMsgUserId(config.userId)}</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Worker 側的環境變量清單見上面「部署 Worker」一節。發佈的 Worker 代碼默認 CORS 全開
                （<code className="font-mono">origin: '*'</code>），想收緊就把它改成自己站點的域名再部署。
              </p>
              {onOpenCloudData ? (
                <div className="bg-white border border-slate-200 rounded-2xl p-3 space-y-2">
                  <div className="font-semibold text-slate-700">雲端數據</div>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    看看 Worker 上按角色存著些什麼，把本地已經沒有的角色留下的那份清掉。
                    刪過角色、導入過別的備份之後，雲端多半還留著他們的上下文和 API 憑據。
                  </p>
                  <button
                    onClick={onOpenCloudData}
                    className="w-full py-2.5 bg-slate-100 text-slate-700 font-bold rounded-2xl active:scale-95 transition-transform"
                  >
                    清點雲端數據
                  </button>
                </div>
              ) : null}
              <div className="bg-rose-50 border border-rose-100 rounded-2xl p-3 space-y-2">
                <div className="font-semibold text-rose-700">清空雲端數據</div>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  把 Worker D1 裡屬於你的數據全部刪掉：已排程的主動消息任務（含角色自己排的）、
                  同步上去的角色上下文（角色卡、最近聊天窗口等）與工具憑據、推送訂閱登記。
                </p>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  清完角色上下文下次聊天會自動傳回去，工具憑據和推送訂閱當場補登記，任務要自己重新排。
                  換過 <code className="font-mono">AMSG_MASTER_KEY</code> 之後舊數據解不開，也從這裡清乾淨。
                </p>
                <button
                  onClick={() => void handleWipeCloudData()}
                  disabled={loading}
                  className="w-full py-2.5 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
                >
                  {loading ? '處理中...' : '清空雲端數據'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
    {/* 擺在 Modal 外面：它自己是全屏 fixed 定位，放進面板裡會被面板的動畫容器框住。 */}
    <ConfirmDialog
      isOpen={pauseConfirmOpen}
      title="暫停後台任務"
      message="暫停後，到點的主動消息和定時消息會先攢著，不會丟。點「恢復後台任務」之後，攢下的會一起補發。"
      confirmText="暫停"
      variant="warning"
      onConfirm={() => void applyCronTrigger(false)}
      onCancel={() => setPauseConfirmOpen(false)}
    />
    </>
  );
};

export default React.memo(ActiveMsgGlobalSettingsModal);
