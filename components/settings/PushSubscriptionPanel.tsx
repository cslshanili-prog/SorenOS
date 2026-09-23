// 設置頁的「推送訂閱狀態」面板。
//
// 主動消息 2.0 最難自己發現的故障是「靜默失聯」：任務建得成、界面全綠、到點一條
// 消息都不來。原因通常在推送這條鏈路上——權限沒給、訂閱被瀏覽器吊銷、或者 worker
// 上登記的訂閱根本不是這台設備。這個面板把這條鏈路從頭到尾攤開，最後一行「雲端
// 登記」正是拆穿靜默失聯的那一行。
//
// 只讀診斷走 pushSubscribeShared 的 readBrowserPushState（各推送層共用同一份判定），
// 重置走 ActiveMsgClient 的 amsg2 路徑——退訂、按 worker 自己的 VAPID 重訂、再覆蓋
// 登記回 worker。三步缺一不可，少了最後一步就是把這個面板要治的病再犯一遍。

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActiveMsgClient,
  compareRemotePushSubscription,
  fetchWorkerDiagnostics,
  readAmsgFailKind,
  type AmsgPushRegistrationState,
  type AmsgRemotePushSubscription,
} from '../../utils/activeMsgClient';
import {
  judgePushDeliveryFailure,
  type AmsgPushDeliveryProbe,
} from '../../utils/amsgDiagnostics';
import { catchUpMissedPushesManually } from '../../utils/activeMsgRuntime';
import { readBrowserPushState, type BrowserPushState } from '../../utils/pushSubscribeShared';
import {
  describeElapsed,
  describePermission,
  describeServiceWorker,
  describeSubscription,
  describeSupport,
  hasLiveFailure,
  isSupportBad,
  liveFailureKind,
} from '../../utils/pushDiagnosticsView';
import { bucketRetryCount, trackEvent } from '../../utils/analytics';

interface PushSubscriptionPanelProps {
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

/** 連續幾次殭屍失敗之後，「重置訂閱」升級成「深度重置」。 */
const DEEP_RESET_THRESHOLD = 3;

const Row: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
  <div className="flex items-start justify-between gap-3">
    <span className="text-slate-500 shrink-0">{label}</span>
    <span className={`text-right font-medium ${bad ? 'text-rose-600' : 'text-slate-700'}`}>{value}</span>
  </div>
);


const REGISTRATION_TEXT: Record<AmsgPushRegistrationState, { value: string; bad: boolean }> = {
  'worker-unset': { value: '還沒填 Worker 地址', bad: true },
  unreachable: { value: '問不到（Worker 連不上，或版本太舊沒這個接口）', bad: true },
  missing: { value: '沒有登記', bad: true },
  'other-endpoint': { value: '登記的是別的設備', bad: true },
  matched: { value: '已登記（就是這台設備）', bad: false },
};

const PushSubscriptionPanel: React.FC<PushSubscriptionPanelProps> = ({ addToast }) => {
  const [browser, setBrowser] = useState<BrowserPushState | null>(null);
  const [remote, setRemote] = useState<AmsgRemotePushSubscription | null>(null);
  // 「登記的確實是這台設備，但推送根本送不到」——只有 Worker 那側的投遞結果知道這件事。
  // null = 還沒問到（沒填 Worker / 連不上），那時這一行照實說「沒查到」。
  const [delivery, setDelivery] = useState<AmsgPushDeliveryProbe | null>(null);
  const [workerConfigured, setWorkerConfigured] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  // 連續幾次殭屍失敗。不落盤：刷新頁面就歸零，用戶不會莫名其妙看到一個紅按鈕。
  const [zombieStreak, setZombieStreak] = useState(0);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const browserState = await readBrowserPushState();
      setBrowser(browserState);
      // 沒填 Worker 地址就別去問了——問也是白問，還會在控制台留一串沒用的報錯。
      const config = await ActiveMsgClient.getGlobalConfig().catch(() => null);
      const configured = Boolean(config?.workerUrl?.trim());
      setWorkerConfigured(configured);
      setRemote(configured ? await ActiveMsgClient.getRemotePushSubscription() : null);
      // 「推送有沒有真的送出去」是 Worker 那側算好的（見 /debug 的 pushDelivery）。
      // 這一行和體檢面板讀的是同一份，不會一個說紅一個說綠。
      const probe = configured ? await fetchWorkerDiagnostics() : null;
      setDelivery(probe?.reachable ? probe.report.storage.pushDelivery ?? null : null);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const deepMode = zombieStreak >= DEEP_RESET_THRESHOLD;

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      if (deepMode) {
        await ActiveMsgClient.deepResetPushSubscription();
      } else {
        await ActiveMsgClient.resetPushSubscription();
      }
      setZombieStreak(0);
      addToast('訂閱已重建，並登記到了 Worker 上。', 'success');
      // 只報「成不成 / 是哪一檔 / 之前失敗了幾次」，全是源碼裡寫死的枚舉。
      trackEvent(deepMode ? '深度重置推送订阅' : '重置推送订阅', {
        result: 'success',
        attempt: bucketRetryCount(zombieStreak),
      });
    } catch (error: any) {
      const failKind = readAmsgFailKind(error);
      // 殭屍端點是「重試也沒用」的那一類，攢夠次數把按鈕升級成深度重置。
      // 別的失敗（沒配 VAPID、權限被拒、斷網）換深度重置一點用沒有，不計數。
      if (failKind === '端點殭屍') setZombieStreak((count) => count + 1);
      // 報錯原文可能帶 push endpoint，只留在 toast 和控制台裡，不進上報。
      addToast(error?.message || '重置訂閱失敗。', 'error');
      trackEvent(deepMode ? '深度重置推送订阅' : '重置推送订阅', {
        result: failKind,
        attempt: bucketRetryCount(zombieStreak),
      });
    } finally {
      setResetting(false);
      await refresh();
    }
  };

  /**
   * 手動補收：去雲端帳本上把沒收到的消息撈回來。
   *
   * 結果照實說，不含糊：撈回來幾條、翻過多少條都報出來。「一條都沒補回來」跟「壓根沒讀成」
   * 是兩個結論，用戶拿它決定下一步該幹嘛（前者說明消息不在帳本上、該查別處，後者只是這趟
   * 沒讀成、再點一次就行），混在一起說等於什麼都沒說。
   */
  const handleCatchUp = async () => {
    setCatchingUp(true);
    try {
      const { written, scanned, stale } = await catchUpMissedPushesManually();
      if (written > 0) {
        // 補回來了，但同一趟裡還有超窗的——兩件事都得說，不然用戶以為全找回來了。
        addToast(
          stale > 0
            ? `補回 ${written} 條消息，去聊天裡看看。另有 ${stale} 條超過兩天，拿不回來了。`
            : `補回 ${written} 條消息，去聊天裡看看。`,
          'success',
        );
      } else if (stale > 0) {
        // 有本該收到的消息、但全都過了兩天：說清楚是「丟了」不是「沒有」——這是用戶
        // 唯一一次知道這件事的機會，含糊過去他會以為鏈路是好的。
        addToast(`有 ${stale} 條消息超過兩天沒能收到，已經拿不回來了。`, 'error');
      } else if (scanned > 0) {
        // 帳本上有行，但沒一條是該上屏的聊天內容（思維鏈、工具請求這些不進聊天流）。
        addToast('帳本上剩下的都不是聊天內容，沒有可補的消息。', 'info');
      } else {
        addToast('帳本上沒有漏收的消息——這條鏈路是通的。', 'info');
      }
    } catch (error: any) {
      addToast(error?.message || '讀雲端帳本失敗，待會兒再試。', 'error');
    } finally {
      setCatchingUp(false);
    }
  };

  const registration: AmsgPushRegistrationState = workerConfigured
    ? compareRemotePushSubscription(browser?.endpoint, remote)
    : 'worker-unset';
  const registrationText = REGISTRATION_TEXT[registration];

  // 上一次推送到底送沒送到。判定跟體檢面板共用 judgePushDeliveryFailure——兩處各寫一套的話，
  // 用戶會看到一個紅一個綠，而這正是他判斷該不該重置訂閱的唯一依據。
  const deliveryVerdict = judgePushDeliveryFailure(delivery);
  const deliveryText: { value: string; bad: boolean } = !workerConfigured || !delivery
    ? { value: '沒查到（要先連上 Worker）', bad: false }
    : !delivery.probed
      ? { value: delivery.reason === 'unsupported' ? '這台 Worker 還不查' : '沒查成', bad: false }
      : delivery.gone && deliveryVerdict
        ? { value: `被推送服務退回（${delivery.gone.status}）`, bad: true }
        // 有舊帳但已經不算數了：說清楚「那是上一條訂閱的事」，別讓人以為從來沒壞過。
        : { value: delivery.gone ? '這條訂閱登記之後沒被退回過' : '沒有被退回的記錄', bad: false };

  const resetLabel = resetting
    ? (deepMode ? '深度重置中…' : '重置中…')
    : (deepMode ? '深度重置' : '重置訂閱');

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3 leading-relaxed">
        主動消息到點靠網頁推送送到你手上。這條鏈路上任意一環斷了，表現都是「任務建得成、到點沒消息」，
        界面上不會有任何異常。這裡把每一環攤開給你看。
      </p>

      <div className="bg-slate-50/70 rounded-2xl p-4 border border-slate-100">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-slate-600">鏈路狀態</p>
          <button
            onClick={() => {
              // 全是瀏覽器/設備狀態的固定枚舉，不含端點地址、也不含任何用戶配置值
              trackEvent('刷新 Web Push 诊断', browser ? {
                permission: browser.permission,
                subscription: !browser.endpoint ? 'none' : browser.endpointDead ? 'dead' : 'active',
                swState: browser.swState === 'activated' ? 'activated' : browser.swState === 'none' ? 'none' : 'other',
                platform: browser.capacitorNative ? 'capacitor_native' : browser.iosNeedsPwa ? 'ios_needs_pwa' : 'normal',
                registration,
                // 「接口全在但这台设备就是建不出订阅」的唯一可见出口。取的是共用层那个
                // 固定枚举，不含报错原文。
                lastFailure: liveFailureKind(browser) ?? 'none',
                // 「登记全对但推送被退回」有多普遍。四个取值全是这儿写死的字面量，
                // 不带状态码原文、不带端点、不带失败原因。
                delivery: !delivery || !delivery.probed ? 'unknown'
                  : delivery.gone && deliveryVerdict ? 'gone'
                    : delivery.gone ? 'recovered' : 'clean',
              } : undefined);
              void refresh();
            }}
            disabled={refreshing || resetting}
            className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:text-slate-300"
          >
            {refreshing ? '讀取中…' : '刷新'}
          </button>
        </div>

        {browser ? (
          <div className="space-y-1.5 text-[11px]">
            <Row label="瀏覽器支持" value={describeSupport(browser)} bad={isSupportBad(browser)} />
            <Row label="通知權限" value={describePermission(browser.permission)} bad={browser.permission !== 'granted'} />
            <Row label="Service Worker" value={describeServiceWorker(browser)} bad={browser.swState !== 'activated'} />
            <Row
              label="瀏覽器訂閱"
              value={describeSubscription(browser)}
              bad={!browser.endpoint || browser.endpointDead}
            />
            <Row label="推送通道" value={browser.channel} />
            <Row label="雲端登記" value={registrationText.value} bad={registrationText.bad} />
            {/* 上面每一行答的都是「配好了嗎」，這一行答的是「實際推出去了嗎」。前面全綠
                後面照樣能紅——那正是「任務建得成、到點沒消息」最難自己發現的一種壞法。 */}
            <Row label="上次投遞" value={deliveryText.value} bad={deliveryText.bad} />

            {browser.endpoint && (
              <div className="pt-2 mt-2 border-t border-slate-200">
                <p className="text-[10px] text-slate-400 mb-1">訂閱端點（前 60 字符）</p>
                <p className={`text-[10px] font-mono break-all leading-relaxed ${browser.endpointDead ? 'text-rose-600' : 'text-slate-500'}`}>
                  {browser.endpoint.slice(0, 60)}…
                </p>
              </div>
            )}

            {browser.capabilityGap && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                {browser.capabilityGap}。
              </div>
            )}
            {/* 失敗原文以前只走 toast，一閃而過就沒了——而這類失敗恰恰最需要照著原文
                排查。這裡把它固定顯示出來，直到訂閱真的建起來為止。 */}
            {hasLiveFailure(browser) && browser.lastSubscribeFailure && (() => {
              const failure = browser.lastSubscribeFailure!;
              const elapsed = describeElapsed(failure.at);
              return (
                <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                  <p className="font-semibold mb-1">上次建訂閱失敗{elapsed && `（${elapsed}）`}</p>
                  <p>{failure.text}。</p>
                  {(failure.kind === 'channel-unreachable' || failure.kind === 'no-subscription') && (
                    <p className="mt-1.5 pt-1.5 border-t border-rose-200">
                      這一類<b>重試多少次都是一樣的結果</b>，問題不在這個站點、也不在權限，
                      換個瀏覽器、換個網絡或換台設備才有用。
                    </p>
                  )}
                </div>
              );
            })()}
            {browser.endpointDead && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                訂閱地址變成了 <code className="font-mono">permanently-removed.invalid</code>，
                意思是瀏覽器把這條訂閱吊銷了（常見原因：很久沒打開、通知權限被改過、站點數據被清過）。
                這個域名全球都不會解析，推送發過去必然失敗。點下面的「重置訂閱」重建一條就行。
              </div>
            )}
            {deliveryVerdict?.level === 'bad' && (
              <div className={`mt-2 p-2 border rounded-lg text-[10px] leading-relaxed ${
                deliveryVerdict.level === 'bad'
                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                  : 'bg-amber-50 border-amber-200 text-amber-700'
              }`}>
                <p className="font-semibold mb-1">推送被退回了</p>
                <p>{deliveryVerdict.what}。</p>
                {/* 這段解釋只在坐實了的時候說：warn 那檔是 Worker 問不到，上面幾行本來
                    就紅著，再說一句「上面都沒問題」只會自相矛盾。 */}
                {deliveryVerdict.level === 'bad' && (
                  <p className="mt-1.5 pt-1.5 border-t border-current/20">
                    上面每一行<b>都沒問題</b>，壞的是那條訂閱本身——它在推送服務
                    （Chrome 走 FCM、Firefox 走 Mozilla、iOS 走 Apple）那側已經作廢了，
                    這件事只有推送服務知道，前面幾行誰都查不出來。點下面的「重置訂閱」換一條新的。
                  </p>
                )}
              </div>
            )}
            {registration === 'other-endpoint' && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                Worker 上登記的訂閱不是這台設備——主動消息到點會推到<b>別處</b>，這台收不到。
                換過設備、換過瀏覽器、或者換過 Worker 之後會這樣（一個帳號只存一份訂閱，後登記的頂掉先前的）。
                點「重置訂閱」把它改成這台。
              </div>
            )}
            {/* 通道不通 / 內核不支持的時候不提「點重置訂閱」：那一步必掛在建訂閱上，
                登記根本輪不到，上面那個失敗框才是這台設備真正的結論。 */}
            {registration === 'missing' && !isSupportBad(browser) && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                Worker 上一份訂閱都沒有，到點沒地方推。點「重置訂閱」登記一下這台設備。
              </div>
            )}
            {browser.iosNeedsPwa && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                檢測到 iOS Safari，但現在不是從主屏圖標啟動的。
                iOS 的網頁推送必須先「添加到主屏幕」、再從主屏圖標打開才能用。
              </div>
            )}
            {browser.capacitorNative && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                你現在用的是<b>打包好的 App</b>，不是瀏覽器網頁。網頁推送這條通道在 App 裡不存在，
                這個面板可以直接忽略——不影響正常使用。
              </div>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-slate-400">讀取中…</p>
        )}

        <button
          disabled={resetting || refreshing || browser?.capacitorNative}
          onClick={() => void handleReset()}
          className={`mt-4 w-full py-2 rounded-xl text-xs font-bold border ${
            resetting || refreshing || browser?.capacitorNative
              ? 'bg-slate-100 text-slate-400 border-slate-200'
              : deepMode || browser?.endpointDead || registrationText.bad || deliveryText.bad
                ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
          }`}
        >
          {resetLabel}
        </button>
        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          「重置訂閱」會清掉現在這條、重建一條，再登記到 Worker 上。換了瀏覽器、換了 Worker、
          或者訂閱被吊銷之後點它。
          {deepMode && <><br/>連著幾次都沒成，已經切到「深度重置」——它會把 Service Worker 整個裝一遍，更徹底。</>}
        </p>

        {/* 上面那條鏈路修好了也追不回已經丟掉的消息——那些還在雲端帳本上躺著，得有人去拿。
            平時冷啟動和回到前台會自動撈一次，這個按鈕是給「我確實少收了東西」的時候用的：
            它連頭一趟的帳本存量也當補收處理，而自動那條路會把存量整批銷掉（分不清哪些是
            真丟的、哪些是當時收到了只是老版本不會銷帳，倒出來就是重放）。 */}
        {workerConfigured && !browser?.capacitorNative && (
          <>
            <button
              disabled={catchingUp || resetting || refreshing}
              onClick={() => void handleCatchUp()}
              className={`mt-3 w-full py-2 rounded-xl text-xs font-bold border ${
                catchingUp || resetting || refreshing
                  ? 'bg-slate-100 text-slate-400 border-slate-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {catchingUp ? '正在找…' : '找回沒收到的消息'}
            </button>
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
              每條消息發出去之前，雲端都先記了一行，你這邊收到了才銷帳。所以推送要是在路上丟了
              （網絡不穩、掛著代理、手機壓後台），內容還留在雲端——點它把最近一天裡漏掉的撈回來。
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default PushSubscriptionPanel;
