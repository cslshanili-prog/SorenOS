import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_MAKER_MAP,
  buildInstallablePreviewDocument,
  installableToThemePatch,
  installableToWorldbooks,
  parseInstallableArtifactBlocks,
  validateInstallableArtifact,
} from '../features/collaboration/makers';

describe('collaboration installable makers', () => {
  it('parses typed installable blocks without exposing the internal protocol', () => {
    const parsed = parseInstallableArtifactBlocks(`我按你的氣質做了一版。\n\n\`\`\`sully-artifact
kind: journal-css
title: 夜航日記
---
{"css":".sully-journal-root{background:#111827!important;}"}
\`\`\``);
    expect(parsed.visibleText).toBe('我按你的氣質做了一版。');
    expect(parsed.artifacts).toEqual([{
      kind: 'journal-css',
      title: '夜航日記',
      payload: { css: '.sully-journal-root{background:#111827!important;}' },
    }]);
  });

  it('keeps malformed generated blocks visible so content is not silently lost', () => {
    const raw = '```sully-artifact\nkind: bubble-theme\ntitle: 壞掉的作品\n---\n{not-json}\n```';
    expect(parseInstallableArtifactBlocks(raw)).toEqual({ visibleText: raw, artifacts: [] });
  });

  it('rejects CSS that escapes its native product scope', () => {
    const errors = validateInstallableArtifact({
      kind: 'journal-css',
      title: '越界 CSS',
      payload: { css: 'body{display:none}.sully-journal-root{color:red}' },
    });
    expect(errors.join('\n')).toContain('body');
    expect(validateInstallableArtifact({
      kind: 'psyche-css',
      title: '安全 CSS',
      payload: { css: '.sully-psyche-card{border-radius:18px!important;animation:pulse 2s infinite}@keyframes pulse{from{opacity:.8}50%{opacity:1}to{opacity:.8}}' },
    })).toEqual([]);
  });

  it('only installs whitelisted appearance fields and native worldbook data', () => {
    const patch = installableToThemePatch({
      kind: 'appearance-preset',
      title: '清晨',
      payload: { theme: { hue: 32, darkMode: false, chatHeaderStyle: 'minimal', apiKey: 'must-not-pass' } },
    });
    expect(patch).toEqual({ hue: 32, darkMode: false, chatHeaderStyle: 'minimal' });
    expect(JSON.stringify(patch)).not.toContain('apiKey');

    const worldbooks = installableToWorldbooks({
      kind: 'worldbook',
      title: '雨城',
      payload: {
        category: '雨城',
        entries: {
          '0': { uid: 0, comment: '雨城規則', content: '城裡總在下雨。', constant: true, key: [], position: 0 },
          '1': { uid: 1, comment: '舊車站', content: '提到車站時，她會想起離別。', constant: false, key: ['車站'], position: 4, depth: 2, role: 2 },
        },
      },
    });
    expect(worldbooks).toHaveLength(2);
    expect(worldbooks[0]).toMatchObject({ title: '雨城規則', category: '雨城', content: '城裡總在下雨。', constant: true, position: 0, sourceUid: 0 });
    expect(worldbooks[1]).toMatchObject({ title: '舊車站', key: ['車站'], position: 4, depth: 2, role: 2, sourceUid: 1 });
  });

  it('validates a worldbook as one category containing SillyTavern entries', () => {
    expect(validateInstallableArtifact({
      kind: 'worldbook',
      title: '學院設定',
      payload: {
        category: '學院設定',
        entries: {
          '0': { comment: '校規', content: '午夜後禁止離開宿舍。', constant: true, position: 1 },
          '1': { comment: '鐘樓', content: '鐘樓只在雨夜開放。', key: ['鐘樓'], constant: false, position: 4 },
        },
      },
    })).toEqual([]);
    expect(validateInstallableArtifact({ kind: 'worldbook', title: '空書', payload: { category: '空書', entries: {} } })).toContain('世界書裡沒有條目。');
  });

  it('upgrades an older single-entry worldbook artifact into a one-entry group', () => {
    const books = installableToWorldbooks({
      kind: 'worldbook',
      title: '舊作品',
      payload: { category: '舊分類', title: '舊條目', content: '舊格式正文', constant: true, position: 1 },
    });
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ category: '舊分類', title: '舊條目', content: '舊格式正文', constant: true, position: 1 });
  });

  it('covers every user-facing maker in the registry', () => {
    expect(Object.keys(COLLABORATION_MAKER_MAP).sort()).toEqual([
      'appearance-preset', 'bubble-theme', 'character-card', 'journal-css',
      'psyche-css', 'schedule-css', 'whitebox-css', 'worldbook',
    ]);
  });

  it('injects the complete real selector catalog for each CSS maker', () => {
    const bubblePrompt = COLLABORATION_MAKER_MAP['bubble-theme'].prompt;
    const whiteboxPrompt = COLLABORATION_MAKER_MAP['whitebox-css'].prompt;
    const journalPrompt = COLLABORATION_MAKER_MAP['journal-css'].prompt;
    const schedulePrompt = COLLABORATION_MAKER_MAP['schedule-css'].prompt;
    const psychePrompt = COLLABORATION_MAKER_MAP['psyche-css'].prompt;
    expect(bubblePrompt).toContain('.sully-voice-bar-wave-segment');
    expect(whiteboxPrompt).toContain('.sully-chat-turn-avatar-slot');
    expect(whiteboxPrompt).toContain('.sully-collaboration-file-action');
    expect(journalPrompt).toContain('.sully-journal-cursor-spark');
    expect(schedulePrompt).toContain('.sully-schedule-change-shine');
    expect(psychePrompt).toContain('.sully-psyche-body');
    for (const prompt of [bubblePrompt, whiteboxPrompt, journalPrompt, schedulePrompt, psychePrompt]) {
      expect(prompt).toContain('prefers-reduced-motion');
      expect(prompt).toContain('全部可用選擇器');
    }
  });

  it('builds a network-isolated full-screen CSS preview document', () => {
    const doc = buildInstallablePreviewDocument({
      kind: 'whitebox-css',
      title: '星夜白框',
      payload: { css: '.sully-chat-header{background:#111827!important;}' },
    });
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('.sully-chat-header{background:#111827!important;}');
    expect(doc).toContain('sully-chat-inputbar');
  });
});
