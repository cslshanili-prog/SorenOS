/**
 * 見面自訂預設的存取（meeting_presets 表）。預設在所有角色間共用；
 * 哪個角色用哪份記在角色的 dateMeetingPresetId。改過就發 MEETING_PRESET_UPDATED_EVENT，
 * 開著的見面畫面收到會重讀。
 */

import { DB } from '../db';
import { duplicatePresetDoc } from './edit';
import { parseStPreset } from './stImport';
import type { MeetingPresetDoc, MeetingPresetRecord } from './types';

export const MEETING_PRESET_UPDATED_EVENT = 'soren-meeting-preset-updated';

const notify = () => {
    try { window.dispatchEvent(new Event(MEETING_PRESET_UPDATED_EVENT)); } catch { /* 測試環境沒有 window */ }
};

const makeId = () => `mp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const importStPresetFile = async (rawText: string, fileName: string): Promise<MeetingPresetRecord> => {
    const doc = parseStPreset(rawText, fileName);
    const now = Date.now();
    const record: MeetingPresetRecord = { id: makeId(), name: doc.name, sourceFileName: fileName, doc, createdAt: now, updatedAt: now };
    await DB.saveMeetingPreset(record);
    notify();
    return record;
};

export const saveMeetingPresetDoc = async (record: MeetingPresetRecord, doc: MeetingPresetDoc): Promise<MeetingPresetRecord> => {
    const next: MeetingPresetRecord = { ...record, name: doc.name, doc, updatedAt: Date.now() };
    await DB.saveMeetingPreset(next);
    notify();
    return next;
};

export const deleteMeetingPresetRecord = async (id: string): Promise<void> => {
    await DB.deleteMeetingPreset(id);
    notify();
};

/** 複製一份：新 id、名字加「（副本）」，原本那份不動 */
export const duplicateMeetingPresetRecord = async (record: MeetingPresetRecord): Promise<MeetingPresetRecord> => {
    const doc = duplicatePresetDoc(record.doc);
    const now = Date.now();
    const copy: MeetingPresetRecord = { id: makeId(), name: doc.name, sourceFileName: record.sourceFileName, doc, createdAt: now, updatedAt: now };
    await DB.saveMeetingPreset(copy);
    notify();
    return copy;
};
