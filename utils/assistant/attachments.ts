/**
 * 給 Sore 的文字檔附件（plans/decoration-app.md 第 7 節）：.css／.txt／.json 讀成字串跟著訊息存，
 * 送給模型時接在那則訊息後面；跟圖片一樣只有最近幾則帶檔案的訊息送全文，更早的換成一句「附了什麼」。
 * Key 一律換成 [Key]：檔案裡就算貼了 Key 也不能進 Sore 的上下文。
 */
import { scrubKeys } from './client';

export interface SoreFileAttachment {
    name: string;
    text: string;
    /** 超過上限被截掉了 */
    truncated?: boolean;
}

/** 單檔上限（字）：一般的美化 CSS、預設 JSON 都夠，整份備份那種就截 */
export const SORE_FILE_MAX_CHARS = 60_000;
/** 一則訊息最多附幾個檔 */
export const SORE_MAX_FILES = 3;
/** 檔案也貴：只有最近這麼多則帶檔案的訊息送全文 */
export const SORE_FILE_MESSAGES_SENT = 2;

export const SORE_TEXT_FILE_EXTENSIONS = ['.css', '.txt', '.json'] as const;
/** 附件鈕的 accept */
export const SORE_ATTACH_ACCEPT = ['image/*', ...SORE_TEXT_FILE_EXTENSIONS].join(',');

export const isSoreTextFile = (file: { name: string; type?: string }): boolean => {
    const name = file.name.toLowerCase();
    if (SORE_TEXT_FILE_EXTENSIONS.some(ext => name.endsWith(ext))) return true;
    return /^(text\/(plain|css)|application\/json)$/i.test(file.type || '');
};

export const isSoreImageFile = (file: { type?: string }): boolean => /^image\//i.test(file.type || '');

/** 已經讀成字串的內容 → 附件（換掉 Key、截長度） */
export const toSoreAttachment = (name: string, raw: string, apiKeys: Array<string | undefined> = []): SoreFileAttachment => {
    const text = scrubKeys(raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n'), apiKeys);
    const safeName = (name || '檔案').replace(/[\r\n]/g, ' ').slice(0, 80);
    if (text.length <= SORE_FILE_MAX_CHARS) return { name: safeName, text };
    return { name: safeName, text: text.slice(0, SORE_FILE_MAX_CHARS), truncated: true };
};

/** 讀一個檔；看起來不是文字（有一堆 NUL）就丟錯 */
export const readSoreTextFile = async (file: File, apiKeys: Array<string | undefined> = []): Promise<SoreFileAttachment> => {
    const raw = await file.text();
    if (/\u0000/.test(raw.slice(0, 4096))) throw new Error(`「${file.name}」看起來不是文字檔`);
    if (!raw.trim()) throw new Error(`「${file.name}」是空的`);
    return toSoreAttachment(file.name, raw, apiKeys);
};

export const lineCountOf = (text: string) => (text ? text.split('\n').length : 0);

/** 送全文：接在訊息後面 */
export const formatFilesForModel = (files: SoreFileAttachment[]): string => files.map(f => [
    `【附件：${f.name}（${lineCountOf(f.text)} 行${f.truncated ? `，太長只附了前 ${SORE_FILE_MAX_CHARS} 字` : ''}）】`,
    f.text,
    `【附件結束：${f.name}】`,
].join('\n')).join('\n\n');

/** 太舊不送全文時的一句 */
export const describeOldFiles = (files: SoreFileAttachment[]): string =>
    `（附了 ${files.map(f => `${f.name}（${lineCountOf(f.text)} 行）`).join('、')}，太舊了沒再送；要的話請用戶重新附上）`;
