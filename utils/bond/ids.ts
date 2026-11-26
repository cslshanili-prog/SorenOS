/** 羈絆卡片的 id（零依賴，純邏輯模組都能用，不會把資料庫拉進來） */
export const newBondEntryId = (): string => `be-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
