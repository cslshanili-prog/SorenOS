/**
 * Sore 套用「新小組件＋放上桌面」時留的字條：桌面（apps/Launcher.tsx）看到這個模板出現在主題裡，
 * 就用自己的找空位規則放上去，然後把字條拿走。只在記憶體：重新整理就沒了，模板還在，用戶可以自己放。
 * 桌面版面牽涉安裝了哪些 App、Dock 裡有誰，只有桌面算得準，所以不在 Sore 那頭算位置。
 */
let pendingTemplateId: string | null = null;

export const requestWidgetPlacement = (templateId: string) => { pendingTemplateId = templateId; };
export const cancelWidgetPlacement = (templateId: string) => { if (pendingTemplateId === templateId) pendingTemplateId = null; };
export const peekWidgetPlacement = () => pendingTemplateId;
export const takeWidgetPlacement = () => { const id = pendingTemplateId; pendingTemplateId = null; return id; };
