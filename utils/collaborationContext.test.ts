import { describe, expect, it } from 'vitest';
import { buildCollaborationModelMessages, selectCollaborationMemories, selectRecentCollaborationChatMessages, stripFrozenCollaborationMemoryContext } from '../features/collaboration/context';
import type { Message } from '../types';
import type { MemoryNode } from './memoryPalace/types';

const memory = (id: string, content: string, patch: Partial<MemoryNode> = {}): MemoryNode => ({
  id,
  charId: 'char-1',
  content,
  room: 'study',
  tags: [],
  importance: 5,
  mood: 'neutral',
  embedded: false,
  createdAt: 1,
  lastAccessedAt: 1,
  accessCount: 0,
  ...patch,
});

describe('collaboration context isolation', () => {
  it('selects only the configured latest ChatApp rows without freezing or mutating them', () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      charId: 'char-1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      type: 'text',
      content: `chat-${index + 1}`,
      timestamp: index + 1,
    })) as Message[];

    expect(selectRecentCollaborationChatMessages(rows, 0)).toEqual([]);
    expect(selectRecentCollaborationChatMessages(rows, 10).map(row => row.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `chat-${index + 16}`),
    );
    expect(selectRecentCollaborationChatMessages(rows, 20)[0]?.content).toBe('chat-6');
    expect(selectRecentCollaborationChatMessages(rows, rows.length)).toEqual(rows);
    expect(rows).toHaveLength(25);
  });

  it('selects task-relevant memories and excludes archived or group memories', () => {
    const selected = selectCollaborationMemories([
      memory('project', '用戶正在製作 AIRP 項目的協同工作模式', { importance: 8 }),
      memory('meal', '用戶昨天吃了拉麵', { importance: 9 }),
      memory('archived', 'AIRP 協同舊方案', { archived: true, importance: 10 }),
      memory('group', '群聊裡討論 AIRP', { groupId: 'group-1', importance: 10 }),
    ], '繼續設計 AIRP 協同工作', 5, 10);
    expect(selected.map(item => item.id)).toContain('project');
    expect(selected.map(item => item.id)).not.toContain('archived');
    expect(selected.map(item => item.id)).not.toContain('group');
    expect(selected[0].id).toBe('project');
  });

  it('builds model history only from the explicitly supplied session', () => {
    const modelMessages = buildCollaborationModelMessages('角色快照', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '這個窗口的任務', createdAt: 1 },
      { id: 'm2', sessionId: 'session-a', role: 'assistant', content: '這個窗口的回答', createdAt: 2 },
    ]);
    expect(modelMessages).toEqual([
      { role: 'system', content: '角色快照' },
      { role: 'user', content: '這個窗口的任務' },
      { role: 'assistant', content: '這個窗口的回答' },
    ]);
    expect(JSON.stringify(modelMessages)).not.toContain('其它窗口');
  });

  it('keeps live ChatApp roles before the collaboration overlay and isolated task history', () => {
    const modelMessages = buildCollaborationModelMessages('協同任務協議', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '現在做報告', createdAt: 3 },
    ], undefined, [
      { role: 'system', content: 'ChatApp 完整 ContextBuilder' },
      { role: 'user', content: '日常聊天裡的上一句' },
      { role: 'assistant', content: '日常聊天裡的上一條回覆' },
    ]);

    expect(modelMessages).toEqual([
      { role: 'system', content: 'ChatApp 完整 ContextBuilder' },
      { role: 'user', content: '日常聊天裡的上一句' },
      { role: 'assistant', content: '日常聊天裡的上一條回覆' },
      { role: 'system', content: '協同任務協議' },
      { role: 'user', content: '現在做報告' },
    ]);
  });

  it('injects only the selected maker protocol into that collaboration window', () => {
    const messages = buildCollaborationModelMessages('角色快照', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '想要夜航風格', createdAt: 1 },
    ], 'journal-css');
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('kind: journal-css');
    expect(messages[1].content).toContain('.sully-journal');
    expect(JSON.stringify(messages)).not.toContain('kind: bubble-theme');
  });

  it('places a fresh per-turn memory block next to this session history', () => {
    const messages = buildCollaborationModelMessages('凍結角色身份', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '繼續昨天那份報告', createdAt: 1 },
    ], undefined, [], '### 本輪動態記憶（僅本次請求）\n- 昨天一起確定了目錄');
    expect(messages).toEqual([
      { role: 'system', content: '凍結角色身份' },
      { role: 'system', content: '### 本輪動態記憶（僅本次請求）\n- 昨天一起確定了目錄' },
      { role: 'user', content: '繼續昨天那份報告' },
    ]);
  });

  it('keeps a full-length uploaded paper available on the next follow-up turn', () => {
    const paper = `摘要之後的論文全文：${'正文段落。'.repeat(55_000)}`;
    const messages = buildCollaborationModelMessages('角色快照', [
      {
        id: 'upload', sessionId: 'session-a', role: 'user', content: '請閱讀這篇論文', createdAt: 1,
        attachments: [{ id: 'att', assetId: 'asset', kind: 'source', name: '論文.pdf', mimeType: 'application/pdf', size: 1, createdAt: 1, pageCount: 18, extractedText: paper }],
      },
      { id: 'summary', sessionId: 'session-a', role: 'assistant', content: '先說摘要。', createdAt: 2 },
      { id: 'follow-up', sessionId: 'session-a', role: 'user', content: '請繼續分析正文第三節。', createdAt: 3 },
    ]);
    expect(messages.some(message => typeof message.content === 'string' && message.content.includes('摘要之後的論文全文'))).toBe(true);
    expect(messages.some(message => typeof message.content === 'string' && message.content.includes('PDF 共 18 頁'))).toBe(true);
  });

  it('passes an explicitly selected Word format as an invisible delivery requirement', () => {
    const messages = buildCollaborationModelMessages('角色快照', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '整理成報告', requestedFormat: 'docx', createdAt: 1 },
    ]);
    expect(messages[1].content).toContain('[本輪文件交付格式：docx');
    expect(messages[1].content).toContain('artifact 真文件');
  });

  it('removes stale one-time recall blocks from pre-upgrade session snapshots', () => {
    const cleaned = stripFrozenCollaborationMemoryContext(`### 角色設定
保留我是誰

### 記憶宮殿 (Memory Palace)
這裡是首輪已經過期的召回
#### 用戶的房間
- 老內容

### 當前模式
繼續保留協同規則`);
    expect(cleaned).toContain('### 角色設定');
    expect(cleaned).toContain('### 當前模式');
    expect(cleaned).not.toContain('首輪已經過期的召回');
    expect(cleaned).not.toContain('老內容');
  });
});
