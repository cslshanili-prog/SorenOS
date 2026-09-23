/**
 * Unified speech-to-text (STT) — used by the Call app for voice input.
 *
 * Hybrid strategy (A+B):
 *   - Web platform  → native `webkitSpeechRecognition` / `SpeechRecognition`
 *                     (zero dependency, streams interim results).
 *   - Capacitor app → `@capacitor-community/speech-recognition` (on-device capable),
 *                     loaded via dynamic import so it never enters the web bundle.
 *
 * The user speaks Chinese to the character by default, so the default recognition
 * language is zh-CN regardless of the character's TTS output language.
 */
import { Capacitor } from '@capacitor/core';

export interface SttCallbacks {
  /** Fired repeatedly with the best-so-far transcript (interim + final). */
  onPartial?: (text: string) => void;
  /** Fired once with the final transcript when recognition settles. */
  onFinal?: (text: string) => void;
  /** Fired on any recognition error (already turned into a friendly message). */
  onError?: (message: string) => void;
  /** Fired when the session ends for any reason (success, error, or stop). */
  onEnd?: () => void;
}

export interface SttSession {
  /** Stop listening. Safe to call multiple times. */
  stop: () => void;
}

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

const getWebCtor = (): any =>
  (typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;

/** Whether voice input is usable in the current environment. */
export const isSttSupported = (): boolean => {
  if (isNative()) return true; // plugin present; actual availability resolved at start()
  return !!getWebCtor();
};

const friendlyError = (raw: string): string => {
  if (/not-allowed|denied|permission/i.test(raw)) return '麥克風權限被拒絕，去系統設置裡允許一下';
  if (/no-speech/i.test(raw)) return '沒聽清，再說一次？';
  if (/network/i.test(raw)) return '語音識別服務連不上，檢查下網絡';
  if (/aborted/i.test(raw)) return '';
  return raw || '語音識別出錯了';
};

// 看門狗時長：開麥後這麼久還沒有任何音頻/語音/結果信號，就判定這個瀏覽器的
// 在線識別後端不可用（國內套殼瀏覽器常見：有 webkitSpeechRecognition 對象、
// 麥克風也亮，但永遠不返回結果、也不報錯）。
const STT_WATCHDOG_MS = 7000;

const startWeb = (lang: string, cb: SttCallbacks): SttSession => {
  const Ctor = getWebCtor();
  if (!Ctor) throw new Error('當前瀏覽器不支持語音識別');
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  // 持續聆聽到用戶手動停（貼合 UI 的「點麥克風結束」），別一遇停頓就自己斷。
  rec.continuous = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  let ended = false;
  // 是否收到過識別器「活著」的信號（音頻開始 / 檢測到說話 / 出結果）。
  let gotSignal = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
  const markAlive = () => { gotSignal = true; clearWatchdog(); };

  rec.onaudiostart = markAlive;
  rec.onspeechstart = markAlive;
  rec.onresult = (e: any) => {
    markAlive();
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    cb.onPartial?.((finalText + interim).trim());
  };
  rec.onerror = (e: any) => {
    const msg = friendlyError(String(e?.error || ''));
    if (msg) cb.onError?.(msg);
  };
  rec.onend = () => {
    if (ended) return;
    ended = true;
    clearWatchdog();
    const f = finalText.trim();
    if (f) cb.onFinal?.(f);
    cb.onEnd?.();
  };
  rec.start();
  // 若在看門狗時限內識別器毫無生命跡象，多半是這個瀏覽器沒有可用的在線識別
  // 服務（套殼瀏覽器/缺 Google 服務的 WebView）。明確告訴用戶，別讓麥克風空亮。
  watchdog = setTimeout(() => {
    if (gotSignal || ended) return;
    cb.onError?.('這個瀏覽器識別不到語音，多半不支持在線語音識別（國內套殼瀏覽器常見）。換 Chrome / Edge，或者直接打字吧。');
    try { rec.stop(); } catch { /* ignore */ }
  }, STT_WATCHDOG_MS);
  return { stop: () => { clearWatchdog(); try { rec.stop(); } catch { /* ignore */ } } };
};

const startNative = async (lang: string, cb: SttCallbacks): Promise<SttSession> => {
  const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');

  const perm = await SpeechRecognition.checkPermissions().catch(() => ({ speechRecognition: 'prompt' as const }));
  if (perm.speechRecognition !== 'granted') {
    const req = await SpeechRecognition.requestPermissions();
    if (req.speechRecognition !== 'granted') throw new Error('麥克風權限被拒絕');
  }

  let lastPartial = '';
  let ended = false;
  const handle = await SpeechRecognition.addListener('partialResults', (data: any) => {
    const m = data?.matches?.[0];
    if (m) { lastPartial = m; cb.onPartial?.(m); }
  });

  const finish = (finalText: string, errMsg?: string) => {
    if (ended) return;
    ended = true;
    handle.remove();
    if (errMsg) cb.onError?.(friendlyError(errMsg));
    else if (finalText) cb.onFinal?.(finalText);
    cb.onEnd?.();
  };

  // With partialResults: true, start() resolves once recognition settles.
  SpeechRecognition.start({ language: lang, partialResults: true, popup: false, maxResults: 1 })
    .then((res: any) => finish((res?.matches?.[0] || lastPartial || '').trim()))
    .catch((e: any) => finish('', e?.message || 'native-error'));

  return { stop: () => { SpeechRecognition.stop().catch(() => { /* ignore */ }); } };
};

/**
 * Start a speech-to-text session. Resolves to a handle you can `stop()`.
 * All transcripts arrive via the callbacks.
 */
export const startStt = async (lang: string, cb: SttCallbacks): Promise<SttSession> => {
  const language = lang || 'zh-CN';
  if (isNative()) return startNative(language, cb);
  return startWeb(language, cb);
};
