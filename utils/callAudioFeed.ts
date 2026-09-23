/**
 * 通話口型信號源：把 <audio> 元素接到 WebAudio 分析器上，按渲染幀輸出
 * { level, vowel }。舞台畫布（VRM / Live2D）在自己的 rAF 循環裡直接
 * sample()，不經過 React state——舊實現走 80ms 節流 + setState + prop
 * 層層下傳，嘴型比聲音慢一拍還忽真忽假。
 *
 * level：0..1 的開口度。對說話人音量做自適應歸一（跟蹤運行峰值），
 *        小聲說話也有完整口型，不會因為絕對音量低而抿嘴。
 * vowel：0..1 的元音傾向（低頻佔優 ≈ あ/お → 0，高頻佔優 ≈ い/え → 1），
 *        由頻譜能量帶比值估計，用來在 Aa/Ee/Oh viseme 之間過渡。
 * active：false 表示拿不到實時信號（未播放 / CORS 音頻接不進 WebAudio），
 *        畫布應退回節奏型假口型，而不是把 level=0 當成閉嘴。
 */

export interface LipSyncFrame {
  level: number;
  vowel: number;
  active: boolean;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * iOS 上把 HTMLMediaElement 接入 WebAudio 後，AudioContext 一旦被系統掛起，
 * 原生音頻輸出也會一起被截斷。這裡寧可退回節奏型口型，也不讓分析器成為聲音的必經節點。
 * iPadOS 桌面 UA 會偽裝成 Mac，需要同時檢查觸點數量。
 */
export const shouldKeepNativeCallAudio = (runtimeNavigator?: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean => {
  const nav = runtimeNavigator || (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!nav) return false;
  return /iPad|iPhone|iPod/i.test(nav.userAgent)
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
};

/**
 * 自適應開口度：rms 相對運行峰值歸一。峰值緩慢回落（每次採樣 ×0.996），
 * 換了音量更小的語音片段後 1–2 秒內恢復滿幅口型。
 */
export const adaptiveMouthLevel = (rms: number, peak: number): { level: number; peak: number } => {
  const nextPeak = Math.max(0.05, peak * 0.996, rms);
  const raw = rms / (nextPeak * 0.85);
  // 低於 6% 視為呼吸/底噪，直接閉嘴，避免靜音段嘴唇抖動。
  return { level: raw < 0.06 ? 0 : clamp01(raw), peak: nextPeak };
};

/** 元音傾向：mid 帶（~1k-3.6kHz）能量佔比。兩帶都近乎無聲時回中位 0.5。 */
export const vowelFromBands = (lowEnergy: number, midEnergy: number): number => {
  const total = lowEnergy + midEnergy;
  if (total < 1e-3) return 0.5;
  return clamp01(midEnergy / total);
};

export class CallAudioFeed {
  frame: LipSyncFrame = { level: 0, vowel: 0.5, active: false };

  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private attachedElement: HTMLAudioElement | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private peak = 0.12;
  private playing = false;
  private broken = false;
  private lastSampleAt = 0;
  private smoothedLevel = 0;
  private smoothedVowel = 0.5;

  private ensureContext(): AudioContext | null {
    if (this.broken) return null;
    if (this.context && this.context.state !== 'closed') return this.context;
    if (typeof window === 'undefined') return null;
    const AudioContextCtor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      this.broken = true;
      return null;
    }
    try {
      this.context = new AudioContextCtor();
      return this.context;
    } catch {
      this.broken = true;
      return null;
    }
  }

  /**
   * 必須從“接通 / 重播 / 繼續播放”等真實點擊處理器裡直接調用。
   * 返回 false 時調用方應保留 HTMLAudioElement 原生輸出，不要 attach。
   */
  async unlock(): Promise<boolean> {
    const context = this.ensureContext();
    if (!context) return false;
    if (context.state === 'running') return true;
    try {
      await context.resume();
      // Safari may mutate state to its non-standard `interrupted` value between
      // tasks; stringify to force a fresh runtime read after the awaited resume.
      return String(context.state) === 'running';
    } catch {
      return false;
    }
  }

  /** 把播放元素接入分析圖。同一元素只會創建一次；未解鎖時絕不接管原生聲音。 */
  attach(element: HTMLAudioElement): boolean {
    if (this.broken) return false;
    if (this.attachedElement === element) return !!this.analyser;
    const context = this.ensureContext();
    if (!context || context.state !== 'running') return false;
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      const source = context.createMediaElementSource(element);
      source.connect(analyser);
      analyser.connect(context.destination);
      this.context = context;
      this.analyser = analyser;
      this.attachedElement = element;
      this.timeData = new Uint8Array(analyser.fftSize);
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch {
      // 某些跨域音頻不允許接入 WebAudio；標記後 sample() 恆 active=false，
      // 畫布退回節奏型口型。
      this.broken = true;
      return false;
    }
  }

  setActive(playing: boolean): void {
    this.playing = playing;
    if (!playing) {
      this.smoothedLevel = 0;
      this.frame = { level: 0, vowel: this.smoothedVowel, active: false };
    }
  }

  /** 每幀調用。多塊畫布同幀重複調用時命中 8ms 緩存，不會雙重平滑。 */
  sample(now: number): LipSyncFrame {
    if (!this.playing) return this.frame;
    const analyser = this.analyser;
    const timeData = this.timeData;
    const freqData = this.freqData;
    if (!analyser || !timeData || !freqData || !this.context) {
      this.frame = { level: 0, vowel: 0.5, active: false };
      return this.frame;
    }
    if (now - this.lastSampleAt < 8) return this.frame;
    this.lastSampleAt = now;

    analyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const v = (timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const adapted = adaptiveMouthLevel(rms, this.peak);
    this.peak = adapted.peak;
    // 快起慢落：輔音爆破立即張嘴，詞尾自然合攏。
    const rate = adapted.level > this.smoothedLevel ? 0.55 : 0.22;
    this.smoothedLevel += (adapted.level - this.smoothedLevel) * rate;

    analyser.getByteFrequencyData(freqData);
    const hzPerBin = this.context.sampleRate / 2 / freqData.length;
    const bandEnergy = (fromHz: number, toHz: number): number => {
      const from = Math.max(0, Math.floor(fromHz / hzPerBin));
      const to = Math.min(freqData.length - 1, Math.ceil(toHz / hzPerBin));
      let sum = 0;
      for (let i = from; i <= to; i += 1) sum += freqData[i];
      return sum / Math.max(1, to - from + 1) / 255;
    };
    const vowel = vowelFromBands(bandEnergy(120, 900), bandEnergy(1000, 3600));
    this.smoothedVowel += (vowel - this.smoothedVowel) * 0.25;

    this.frame = { level: clamp01(this.smoothedLevel), vowel: clamp01(this.smoothedVowel), active: true };
    return this.frame;
  }

  dispose(): void {
    this.playing = false;
    this.analyser = null;
    this.attachedElement = null;
    this.timeData = null;
    this.freqData = null;
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => { /* already closed */ });
  }
}
