import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import {
  buildCollaborationFileCabinetBlock,
  collaborationLibraryGroupOf,
  collaborationFileMessageMetadata,
  extractCollaborationFileDirectives,
  resolveCollaborationFileByTitle,
} from '../features/collaboration/chatLibrary';
import type { CollaborationLibraryFile } from '../features/collaboration/types';

const file = (name: string, assetId: string, extractedText = ''): CollaborationLibraryFile => ({
  id: `attachment-${assetId}`,
  assetId,
  kind: 'artifact',
  name,
  mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 2048,
  createdAt: Number(assetId.replace(/\D/g, '')) || 1,
  extractedText,
  format: name.endsWith('.pdf') ? 'pdf' : 'docx',
  sessionId: 'session-1',
  sessionTitle: '交付窗口',
  messageId: `message-${assetId}`,
});

const message = (patch: Partial<Message>): Message => ({
  id: 1,
  charId: 'char-1',
  role: 'user',
  type: 'text',
  content: '',
  timestamp: 1,
  ...patch,
});

const installable = (
  name: string,
  assetId: string,
  installableKind: CollaborationLibraryFile['installableKind'],
): CollaborationLibraryFile => ({
  ...file(name, assetId),
  kind: 'installable',
  mimeType: 'application/vnd.sullyos.installable+json',
  format: undefined,
  installableKind,
});

describe('current-chat collaboration file cabinet', () => {
  it('parses Chinese and protocol directives while keeping natural text', () => {
    const parsed = extractCollaborationFileDirectives('我做過這個，發你看看。\n[[COLLAB_FILE:項目說明.pdf]]\n[[協同文件：《項目說明.pdf》]]');
    expect(parsed.visibleText).toBe('我做過這個，發你看看。');
    expect(parsed.requestedTitles).toEqual(['項目說明.pdf']);
  });

  it('resolves exact names and only unambiguous exact stems', () => {
    const files = [file('項目說明.pdf', 'asset-1'), file('項目說明.docx', 'asset-2')];
    expect(resolveCollaborationFileByTitle(files, '《項目說明.pdf》')?.assetId).toBe('asset-1');
    expect(resolveCollaborationFileByTitle(files, '項目說明')).toBeNull();
    expect(resolveCollaborationFileByTitle([files[0]], '項目說明')?.assetId).toBe('asset-1');
    expect(resolveCollaborationFileByTitle(files, '項目說名.pdf')).toBeNull();
  });

  it('classifies installable works and exposes their titles to ordinary chat', () => {
    const files = [
      installable('月光氣泡', 'asset-20', 'bubble-theme'),
      installable('Noir 角色卡', 'asset-21', 'character-card'),
      file('項目說明.pdf', 'asset-22'),
    ];
    expect(files.map(collaborationLibraryGroupOf)).toEqual(['beautification', 'character', 'document']);
    const block = buildCollaborationFileCabinetBlock(files, [], '條條');
    expect(block).toContain('【美化作品】\n- 《月光氣泡》');
    expect(block).toContain('【角色與世界觀】\n- 《Noir 角色卡》');
    expect(block).toContain('【文檔與資料】\n- 《項目說明.pdf》');
  });

  it('injects titles only and expands exact content for the current title mention or next turn after delivery', () => {
    const files = [
      file('項目說明.pdf', 'asset-1', '這是項目說明的完整正文。'),
      file('預算.docx', 'asset-2', '這是預算正文。'),
      file('會議紀要.docx', 'asset-3', '這是會議紀要正文。'),
      file('舊方案.pdf', 'asset-4', '這是舊方案正文。'),
    ];
    const byTitle = buildCollaborationFileCabinetBlock(files, [message({ content: '順便看看《項目說明》裡寫了什麼' })], '條條');
    expect(byTitle).toContain('《項目說明.pdf》');
    expect(byTitle).toContain('《預算.docx》');
    expect(byTitle).toContain('這是項目說明的完整正文。');
    expect(byTitle).not.toContain('這是預算正文。');
    expect(byTitle).not.toContain('application/pdf');
    expect(byTitle).not.toContain('2048 bytes');
    expect(byTitle).not.toContain('內容速覽');
    expect(byTitle).not.toContain('#### 《預算.docx》的可讀內容');
    expect(byTitle).not.toContain('#### 《舊方案.pdf》的可讀內容');

    const afterDelivery = buildCollaborationFileCabinetBlock(files, [
      message({ id: 1, role: 'assistant', type: 'collaboration_file', content: '[協同文件：預算.docx]', metadata: { collaborationAssetId: 'asset-2', fileName: '預算.docx' }, timestamp: 1 }),
      message({ id: 2, role: 'user', content: '這個裡面寫了什麼', timestamp: 2 }),
    ], '條條');
    expect(afterDelivery).toContain('#### 《預算.docx》的可讀內容');
    expect(afterDelivery).toContain('這是預算正文。');
    expect(afterDelivery).not.toContain('#### 《項目說明.pdf》的可讀內容');

    const oneTurnLater = buildCollaborationFileCabinetBlock(files, [
      message({ id: 1, role: 'user', content: '把預算發我', timestamp: 1 }),
      message({ id: 2, role: 'assistant', type: 'collaboration_file', content: '[協同文件：預算.docx]', metadata: { collaborationAssetId: 'asset-2', fileName: '預算.docx' }, timestamp: 2 }),
      message({ id: 3, role: 'user', content: '這個裡面寫了什麼', timestamp: 3 }),
      message({ id: 4, role: 'assistant', content: '我看一下。', timestamp: 4 }),
      message({ id: 5, role: 'user', content: '好哦', timestamp: 5 }),
    ], '條條');
    expect(oneTurnLater).not.toContain('#### 《預算.docx》的可讀內容');
    expect(oneTurnLater).not.toContain('這是預算正文。');
  });

  it('uses the actual user profile name in the character-facing prompt', () => {
    const block = buildCollaborationFileCabinetBlock([file('交付.pdf', 'asset-9')], [], '條條');
    expect(block).toContain('引導「條條」從 ChatApp 加號頁進入');
    expect(block).not.toContain('引導「用戶」');
  });

  it('does not truncate or cap explicitly requested readable file bodies', () => {
    const longBody = `開頭-${'正文'.repeat(7_000)}-結尾`;
    const files = [
      file('長文檔.pdf', 'asset-10', longBody),
      file('第二份.pdf', 'asset-11', '第二份全文'),
      file('第三份.pdf', 'asset-12', '第三份全文'),
      file('第四份.pdf', 'asset-13', '第四份全文'),
    ];
    const block = buildCollaborationFileCabinetBlock(files, [message({
      content: '讀取《長文檔》《第二份》《第三份》《第四份》',
    })], '條條');
    expect(block).toContain(longBody);
    expect(block).toContain('第二份全文');
    expect(block).toContain('第三份全文');
    expect(block).toContain('第四份全文');
    expect(block).not.toContain('已截斷');
  });

  it('keeps chat message metadata reference-only', () => {
    const metadata = collaborationFileMessageMetadata(file('交付.pdf', 'asset-9', '很長的正文'));
    expect(metadata.collaborationAssetId).toBe('asset-9');
    expect(metadata.fileName).toBe('交付.pdf');
    expect(JSON.stringify(metadata)).not.toContain('很長的正文');
    expect(metadata).not.toHaveProperty('blob');

    const workMetadata = collaborationFileMessageMetadata(installable('月光氣泡', 'asset-10', 'bubble-theme'));
    expect(workMetadata.collaborationAttachmentKind).toBe('installable');
    expect(workMetadata.collaborationInstallableKind).toBe('bubble-theme');
  });
});
