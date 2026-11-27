/**
 * 角色之間各區的小按鈕（plans/bond-batch6.md 3.2～3.4、第 4 節）：日記、問答、願望、信。純邏輯，有測試。
 *
 * - 你是讀者：這些都是他們自己寫的，用寫的那個角色自己的主 API、帶自己的人設；用戶不在場、不提用戶。
 * - 只寫最近發生的（最近一章、最近的私下聊天整理、最近的片刻、最近的私聊）；沒有新東西就照實寫平淡的一天。
 * - 問答：兩人各自作答、看不到對方的答案，答完一起揭曉。題目存在 `question` kind，
 *   這一輪的 `user` 欄放 A（bond.charId 那位）的答案、`char` 欄放 B 的（`pairSlot`）。
 */
import type { BondQuestionRound } from '../../types';
import type { QSide } from './question';
import type { StorySide } from './storyExtract';

/** 問答這一輪裡 A／B 的答案放在哪一欄 */
export const pairSlot = (side: StorySide): QSide => (side === 'a' ? 'user' : 'char');
export const pairAnswerOf = (round: BondQuestionRound | undefined, side: StorySide) => round?.[pairSlot(side)];

export interface PairRecent {
    /** 最近一章（章名＋摘要） */
    chapter?: { title: string; summary: string };
    /** 最近的片刻（事實） */
    moments?: string[];
    /** 自己這邊最近的私下聊天整理（第一人稱） */
    topics?: string[];
    /** 最近的私聊原文（「名字：內容」） */
    chat?: string[];
}

function recentLines(r: PairRecent): string[] {
    const out: string[] = [];
    if (r.chapter) out.push('【你們之間最近的一章故事】', `〈${r.chapter.title}〉${r.chapter.summary}`);
    if (r.moments?.length) out.push('', '【最近值得記住的事】', ...r.moments.map(m => `- ${m}`));
    if (r.topics?.length) out.push('', '【你記得最近私下聊的】', ...r.topics.map(t => `- ${t}`));
    if (r.chat?.length) out.push('', '【最近的私聊】', ...r.chat);
    return out;
}

const hasRecent = (r: PairRecent) => !!(r.chapter || r.moments?.length || r.topics?.length || r.chat?.length);
const NO_USER = '用戶（手機的主人）不在場，不要提到用戶。';

/** 日記：第一人稱、主觀，只寫最近發生的 */
export function buildPairDiaryPrompt(args: { selfName: string; otherName: string; date: string; recent: PairRecent; lastDiary?: string }): string {
    return [
        `今天是 ${args.date}。請以你（${args.selfName}）的身分寫一篇日記，寫你和 ${args.otherName} 之間最近的事。`,
        '',
        ...recentLines(args.recent),
        ...(args.lastDiary ? ['', '【你上一篇日記】', args.lastDiary] : []),
        '',
        '【寫法】',
        '- 第一人稱、你自己的口吻和性格；寫你怎麼看這些事、怎麼看對方，不寫成故事複述。',
        `- 只寫上面這些已經發生的事，不要編新的事件；${hasRecent(args.recent) ? '' : '最近沒什麼新鮮事，'}沒有新東西就照實寫平淡的一天。`,
        '- 200～500 字，不加標題、不加日期行。',
        `- ${NO_USER}`,
        '只輸出日記內容。',
    ].join('\n');
}

/** 問答：AI 照他們的關係推薦三題 */
export function buildPairQuestionSuggestPrompt(args: { aName: string; bName: string; relationLine?: string; recent: PairRecent; asked?: string[] }): string {
    return [
        `請替 ${args.aName} 和 ${args.bName} 出三個題目，讓他們各自作答、答完一起揭曉（讀者想看他們的答案對不對得上、有多不一樣）。`,
        args.relationLine ? `他們現在的關係：${args.relationLine}。` : '',
        ...recentLines(args.recent),
        ...(args.asked?.length ? ['', '【問過的題目，不要重複】', ...args.asked.map(q => `- ${q}`)] : []),
        '',
        '題目要短、具體、兩個人都答得出來（關於對方的習慣、一起經歷的事、二選一、對這段關係的看法、日常）。',
        'topic 是 habit、memory、choice、relationship、daily 其中一個。',
        '只輸出 JSON 陣列：[{"question":"","topic":"daily"}]',
    ].filter(l => l !== '').join('\n');
}

/** 問答：一個人作答（看不到對方的答案） */
export function buildPairAnswerPrompt(args: { selfName: string; otherName: string; question: string; recent: PairRecent }): string {
    return [
        `有一題要你（${args.selfName}）和 ${args.otherName} 各自作答，答完才一起揭曉；你看不到對方寫什麼。`,
        `題目：${args.question}`,
        ...(hasRecent(args.recent) ? ['', ...recentLines(args.recent)] : []),
        '',
        '照你自己的性格、你知道的事回答（不知道就照實說不知道或猜一個），30～150 字，第一人稱。',
        NO_USER,
        '只輸出你的答案。',
    ].join('\n');
}

/** 願望：照人設與前情，說一個想跟對方一起做的事（只存成願望，不推劇情） */
export function buildPairWishPrompt(args: { selfName: string; otherName: string; recent: PairRecent; existing?: string[] }): string {
    return [
        `請以你（${args.selfName}）的身分，說一件你想跟 ${args.otherName} 一起做、但還沒做的事。`,
        ...(hasRecent(args.recent) ? ['', ...recentLines(args.recent)] : []),
        ...(args.existing?.length ? ['', '【已經說過的願望，不要重複】', ...args.existing.map(w => `- ${w}`)] : []),
        '',
        '照你的性格和你們現在的關係，具體一點（做什麼、在哪），一句話、40 字以內，第一人稱。',
        NO_USER,
        '只輸出那一句。',
    ].join('\n');
}

/** 信：寫給對方（或回信），就已經發生的事寫；寄出就到 */
export function buildPairLetterPrompt(args: { fromName: string; toName: string; recent: PairRecent; direction?: string; replyTo?: string }): string {
    return [
        args.replyTo ? `${args.toName} 寫了一封信給你（${args.fromName}），請寫一封回信。` : `請以你（${args.fromName}）的身分，寫一封信給 ${args.toName}。`,
        ...(args.replyTo ? ['', `【${args.toName} 的來信】`, args.replyTo] : []),
        ...(hasRecent(args.recent) ? ['', ...recentLines(args.recent)] : []),
        ...(args.direction?.trim() ? ['', `想寫的方向：${args.direction.trim()}`] : []),
        '',
        `- 用你自己的口吻，寫給 ${args.toName}；就已經發生的事寫，不編新的事件。`,
        '- 150～500 字，開頭可以有稱呼、結尾可以署名。',
        `- ${NO_USER}`,
        '只輸出信的內容。',
    ].join('\n');
}

/** 一句話的輸出：去引號、只取第一行 */
export function cleanOneLine(raw: string, max = 80): string {
    const first = String(raw || '').replace(/```[a-z]*/gi, '').trim().split('\n').map(l => l.trim()).find(Boolean) || '';
    return first.replace(/^[-*・\d.、\s]+/, '').replace(/^["「『]|["」』]$/g, '').trim().slice(0, max);
}

/** 長文輸出：去程式碼框 */
export function cleanLong(raw: string, max = 4000): string {
    return String(raw || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim().slice(0, max);
}
