export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/**
 * 金額按「分」收斂：浮點相加會攢出 49.85999999999999 這樣的尾巴，
 * 展示或寫進文本前都先過這裡，保證只到分位。
 */
export const roundMoney = (value: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

/** 一串金額求和，結果已收斂到分位 */
export const sumMoney = (values: number[]): number =>
  roundMoney(values.reduce((sum, v) => sum + (Number(v) || 0), 0));

/** 金額顯示：整數不帶小數點，小數最多兩位（49.859999… → 49.86，100 → 100） */
export const formatMoney = (value: number): string => String(roundMoney(value));

/**
 * 分鐘按小時顯示：界面上給的是整檔，但持久化裡的值可能是導入的備份、
 * 老版本寫進去的任意整數，除以 60 會拖出 1.6666666666666667。
 */
export const formatHours = (minutes: number): string => {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round((n / 60) * 10) / 10);
};
