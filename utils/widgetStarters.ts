/**
 * 自訂小組件的內建範本（plans/desktop-grid-widgets.md 第 3 批）。
 *
 * 給一打開「＋小組件」還沒想法的人：挑一個「用這個」放上桌面，那一份直接指著範本（見文末）。
 *
 * 每個範本都只用 customWidget.ts 公開的東西：佔位符、widget.getState / setState、data-open，
 * 剛好也是寫小組件的示範。每個範本列出排得好看的尺寸（sizes），用 iframe 裡的 media query 依寬高比換版型；
 * 有卡片底的共用「背景」欄位（淺色毛玻璃／深色毛玻璃／透明／底圖）。最外層蓋滿整格，毛玻璃交給外層代套。
 */

import type { CustomWidgetField, CustomWidgetTemplate } from './customWidget';
import type { WidgetSize } from './launcherLayout';

export type WidgetStarterId = 'countdown' | 'together' | 'charNote' | 'polaroid' | 'todo' | 'water' | 'sticky' | 'typewriter';

export interface WidgetStarter {
    id: WidgetStarterId;
    name: string;
    /** 在「＋小組件」裡那一行說明 */
    description: string;
    /** 放上去之後要先填東西才好看（日子、照片）：放好就打開這一份的設定 */
    needsSetup?: boolean;
    template: Omit<CustomWidgetTemplate, 'id' | 'createdAt' | 'updatedAt'>;
}

// ─── 共用的底：淺色毛玻璃／深色毛玻璃／透明／底圖 ─────────────────────────
// 卡片外層寫 data-bg="{{bg}}"、style="--bg-img:url('{{底圖}}')"，CSS 依 data-bg 換底和字色。
// 字色一律用 var(--ink)，次要的字用 opacity 調淡；卡片裡的小底塊用 var(--surface)。
// 透明的字色跟桌面的字色走（--soren-content-color，customWidget.ts 放進每個小組件）。

const BG_FIELD: CustomWidgetField = { key: 'bg', label: '背景（選「底圖」記得在下面放圖）', type: 'select', options: ['淺色毛玻璃', '深色毛玻璃', '透明', '底圖'], default: '淺色毛玻璃' };
const bgField = (defaultValue = '淺色毛玻璃'): CustomWidgetField => ({ ...BG_FIELD, options: [...BG_FIELD.options!], default: defaultValue });
/** 底圖的圖片鍵（中文鍵：放上桌面後設定裡直接看得懂） */
const BG_IMAGE = '底圖';
const CARD_ATTRS = `data-bg="{{bg}}" style="--bg-img:url('{{${BG_IMAGE}}}')"`;

const CARD = `.card {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: min(22px, 9vmin);
  --ink: #2f2a25;
  --surface: rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.62);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  color: var(--ink);
  font-family: -apple-system, "PingFang TC", "Noto Sans TC", sans-serif;
}
.card[data-bg="深色毛玻璃"] { --ink: #fbf7f2; --surface: rgba(255, 255, 255, 0.12); background: rgba(24, 20, 28, 0.42); }
.card[data-bg="透明"] { --ink: var(--soren-content-color, #fff); --surface: rgba(255, 255, 255, 0.14); background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.22); }
.card[data-bg="底圖"] { --ink: #fff; --surface: rgba(0, 0, 0, 0.28); background: var(--bg-img) center / cover no-repeat rgba(0, 0, 0, 0.18); backdrop-filter: none; -webkit-backdrop-filter: none; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45); }
.card[data-bg="底圖"]::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.3)); pointer-events: none; }
.card > * { position: relative; }`;

const ymd = 'const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");';
const size = (w: number, h: number): WidgetSize => ({ w, h });

// 版型斷點（iframe 裡的 media query 量的是這一格自己）：
//   扁長（4×1，寬高比約 3.8）：(min-aspect-ratio: 5/2)
//   橫的（2×1、4×2，約 1.8）：(min-aspect-ratio: 3/2) and (max-aspect-ratio: 5/2)
//   方的（2×2、4×3、4×4，1.2 以下）：預設
const WIDE = '@media (min-aspect-ratio: 5/2)';
const LANDSCAPE = '@media (min-aspect-ratio: 3/2) and (max-aspect-ratio: 5/2)';
const SQUAREISH = '@media (max-aspect-ratio: 3/2)';

export const WIDGET_STARTERS: WidgetStarter[] = [
    {
        id: 'countdown',
        name: '倒數日',
        description: '離某一天還有幾天，過了就算已經幾天',
        template: {
            name: '倒數日',
            w: 2, h: 2,
            sizes: [size(2, 2), size(2, 1), size(4, 1), size(4, 2)],
            imageKeys: [BG_IMAGE], images: {},
            fields: [
                { key: 'title', label: '標題', type: 'text', default: '距離聖誕節' },
                { key: 'day', label: '日子', type: 'date', default: '2026-12-25' },
                { key: 'accent', label: '數字顏色', type: 'color', default: '#d9776a' },
                bgField(),
            ],
            html: `<div class="card cd" ${CARD_ATTRS}>
  <div class="text">
    <div class="title">{{title}}</div>
    <div class="sub" id="sub"></div>
  </div>
  <div class="num"><span id="n">–</span><small>天</small></div>
</div>
<script>
(async () => {
  const raw = await widget.getState('day');
  const n = document.getElementById('n');
  const sub = document.getElementById('sub');
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(raw || '');
  if (!m) { n.textContent = '?'; sub.textContent = '整理桌面時點我，填日子'; return; }
  const draw = () => {
    const target = new Date(+m[1], m[2] - 1, +m[3]);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((target - today) / 86400000);
    n.textContent = Math.abs(diff);
    sub.textContent = diff > 0 ? raw : diff === 0 ? '就是今天！' : '已經過了 · ' + raw;
  };
  draw();
  setInterval(draw, 10 * 60 * 1000);
})();
</script>`,
            css: `${CARD}
.cd { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 8vmin; gap: 2vmin; }
.cd .text { display: contents; }
.title { order: 1; font-size: 9vmin; font-weight: 700; opacity: 0.7; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.num { order: 2; color: {{accent}}; font-size: 34vmin; font-weight: 800; line-height: 1; letter-spacing: -1px; }
.num small { margin-left: 1vmin; font-size: 9vmin; font-weight: 700; }
.sub { order: 3; font-size: 7vmin; opacity: 0.55; letter-spacing: 0.5px; }
/* 橫的、扁長：左邊標題和日子，右邊大數字 */
@media (min-aspect-ratio: 3/2) {
  .cd { flex-direction: row; justify-content: space-between; text-align: left; padding: 0 7vw; gap: 4vw; }
  .cd .text { display: flex; flex-direction: column; gap: 4vh; min-width: 0; }
  .title { font-size: 13vh; }
  .sub { font-size: 10vh; white-space: nowrap; }
  .num { font-size: 46vh; flex-shrink: 0; }
  .num small { font-size: 13vh; }
}
${WIDE} {
  .title { font-size: 19vh; }
  .num { font-size: 64vh; }
}`,
        },
    },
    {
        id: 'together',
        name: '在一起的天數',
        description: '跟綁定的角色在一起第幾天，點一下進聊天',
        needsSetup: true,
        template: {
            name: '在一起的天數',
            w: 4, h: 1,
            sizes: [size(4, 1), size(4, 2), size(2, 2)],
            imageKeys: [BG_IMAGE], images: {},
            fields: [
                { key: 'start', label: '從哪天開始', type: 'date' },
                { key: 'words', label: '前面那句', type: 'text', default: '和 {{char}} 在一起的' },
                { key: 'accent', label: '天數顏色', type: 'color', default: '#c9708a' },
                bgField(),
            ],
            html: `<div class="card tg" ${CARD_ATTRS} data-open="chat">
  <img class="avatar" src="{{char.avatar}}" alt="">
  <div class="text">
    <div class="words" id="words"></div>
    <div class="days" id="days">第 ? 天</div>
  </div>
  <div class="heart">♡</div>
</div>
<script>
(async () => {
  // 欄位裡的 {{char}} 換成名字（程式裡的佔位符會先被填掉，所以拆開寫）
  const mark = '{' + '{char}' + '}';
  const name = await widget.getState('char');
  const words = (await widget.getState('words')) || '和 ' + mark + ' 在一起的';
  document.getElementById('words').textContent = words.split(mark).join(name || 'TA');
  const raw = await widget.getState('start');
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(raw || '');
  const days = document.getElementById('days');
  if (!m) { days.textContent = '整理桌面時點我，填日子'; days.className = 'hint'; return; }
  const draw = () => {
    const start = new Date(+m[1], m[2] - 1, +m[3]);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    days.textContent = '第 ' + (Math.floor((today - start) / 86400000) + 1) + ' 天';
  };
  draw();
  setInterval(draw, 10 * 60 * 1000);
})();
</script>`,
            css: `${CARD}
.tg { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 3vmin; padding: 7vmin; }
.avatar { width: 34vmin; height: 34vmin; flex-shrink: 0; border-radius: 50%; object-fit: cover; background: var(--surface); border: 2px solid rgba(255, 255, 255, 0.9); }
.text { min-width: 0; max-width: 100%; }
.words { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 7.5vmin; opacity: 0.7; }
.days { margin-top: 1.5vmin; color: {{accent}}; font-size: 14vmin; font-weight: 800; line-height: 1.1; }
.hint { margin-top: 1.5vmin; font-size: 7vmin; font-weight: 600; opacity: 0.6; }
.heart { position: absolute; right: 6vmin; top: 5vmin; color: {{accent}}; font-size: 10vmin; opacity: 0.5; }
/* 橫的、扁長：頭像在左，字在中間，愛心在右 */
@media (min-aspect-ratio: 3/2) {
  .tg { flex-direction: row; text-align: left; justify-content: flex-start; gap: 4vw; padding: 0 5vw; }
  .text { flex: 1; }
  .heart { position: static; }
}
${LANDSCAPE} {
  .avatar { width: 44vh; height: 44vh; }
  .words { font-size: 9vh; }
  .days { margin-top: 2vh; font-size: 17vh; white-space: nowrap; }
  .hint { font-size: 8vh; }
  .heart { font-size: 16vh; }
}
${WIDE} {
  .avatar { width: 62vh; height: 62vh; }
  .words { font-size: 15vh; }
  .days { margin-top: 2vh; font-size: 30vh; }
  .hint { margin-top: 2vh; font-size: 14vh; }
  .heart { font-size: 30vh; }
}`,
        },
    },
    {
        id: 'charNote',
        name: '角色近況',
        description: '角色頭像、現在的情緒、最後一則訊息，點一下進聊天',
        template: {
            name: '角色近況',
            w: 4, h: 2,
            sizes: [size(4, 2), size(4, 1), size(2, 2)],
            imageKeys: [BG_IMAGE], images: {},
            fields: [
                { key: 'empty', label: '還沒聊過時顯示', type: 'text', default: '今天也來聊聊吧' },
                { key: 'accent', label: '重點色', type: 'color', default: '#8a7bb8' },
                bgField(),
            ],
            html: `<div class="card cn" ${CARD_ATTRS} data-open="chat">
  <div class="top">
    <img class="avatar" src="{{char.avatar}}" alt="">
    <div class="who">
      <div class="name">{{char}}</div>
      <div class="mood" id="mood">{{char.mood}}</div>
    </div>
    <div class="badge" id="badge">{{char.unread}}</div>
  </div>
  <div class="msg" id="msg">{{char.lastMessage}}</div>
</div>
<script>
(async () => {
  if ((await widget.getState('char.unread')) === '0') document.getElementById('badge').remove();
  if (!(await widget.getState('char.mood'))) document.getElementById('mood').remove();
  const msg = document.getElementById('msg');
  if (!msg.textContent.trim()) { msg.textContent = await widget.getState('empty'); msg.classList.add('empty'); }
})();
</script>`,
            css: `${CARD}
.cn { display: flex; flex-direction: column; padding: 5vh 5vw; gap: 4vh; }
.top { display: flex; align-items: center; gap: 3.5vw; }
.avatar { width: 30vh; height: 30vh; border-radius: 50%; object-fit: cover; background: var(--surface); flex-shrink: 0; }
.who { min-width: 0; flex: 1; }
.name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11vh; font-weight: 800; }
.mood { display: inline-block; white-space: nowrap; margin-top: 1.5vh; padding: 0.8vh 3vw; border-radius: 99px; background: {{accent}}; color: #fff; font-size: 7vh; font-weight: 700; text-shadow: none; }
.badge { min-width: 13vh; height: 13vh; padding: 0 2vw; border-radius: 99px; background: #e5534b; color: #fff; font-size: 7.5vh; font-weight: 800; display: grid; place-items: center; text-shadow: none; }
.msg { flex: 1; min-height: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; padding: 3.5vh 4vw; border-radius: 6vh; background: var(--surface); font-size: 8.5vh; line-height: 1.45; }
.msg.empty { opacity: 0.55; }
/* 扁長：一排排完，訊息只留一行 */
${WIDE} {
  .cn { flex-direction: row; align-items: center; padding: 0 4vw; gap: 3vw; }
  .top { display: contents; }
  .avatar { order: 1; width: 62vh; height: 62vh; }
  .who { order: 2; flex: 0 1 auto; max-width: 30%; }
  .name { font-size: 18vh; }
  .mood { margin-top: 2vh; padding: 1vh 2vw; font-size: 11vh; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .msg { order: 3; flex: 1; min-width: 0; display: block; white-space: nowrap; text-overflow: ellipsis; padding: 5vh 3vw; border-radius: 99px; font-size: 14vh; line-height: 1.3; }
  .badge { order: 4; flex-shrink: 0; min-width: 24vh; height: 24vh; font-size: 13vh; }
}
/* 方的：頭像和名字在上，訊息多幾行 */
${SQUAREISH} {
  .cn { padding: 7vmin; gap: 4vmin; }
  .top { gap: 3vmin; }
  .avatar { width: 22vmin; height: 22vmin; }
  .name { font-size: 9vmin; }
  .mood { margin-top: 1vmin; padding: 0.6vmin 2.5vmin; font-size: 6vmin; }
  .badge { min-width: 11vmin; height: 11vmin; padding: 0 2vmin; font-size: 6.5vmin; }
  .msg { -webkit-line-clamp: 5; padding: 4vmin; border-radius: 5vmin; font-size: 7vmin; }
}`,
        },
    },
    {
        id: 'polaroid',
        name: '拍立得',
        description: '放三張照片，點一下換下一張',
        needsSetup: true,
        template: {
            name: '拍立得',
            w: 2, h: 2,
            sizes: [size(2, 2), size(4, 4)],
            imageKeys: ['photo1', 'photo2', 'photo3'], images: {},
            fields: [
                { key: 'caption', label: '底下那行字', type: 'text', default: '那天的天氣很好' },
                { key: 'tilt', label: '歪一點', type: 'select', options: ['往左', '不歪', '往右'], default: '往左' },
            ],
            html: `<div class="stage">
  <div class="polaroid" id="card" data-tilt="{{tilt}}">
    <div class="photo"><img id="img" alt=""><div class="empty" id="empty">整理桌面時點我<br>換成你的照片</div></div>
    <div class="caption">{{caption}}</div>
  </div>
</div>
<script>
(async () => {
  const blank = 'data:image/gif;base64,R0lGOD';
  const photos = [];
  for (const key of ['photo1', 'photo2', 'photo3']) {
    const url = await widget.getState(key);
    if (url && !url.startsWith(blank)) photos.push(url);
  }
  const img = document.getElementById('img');
  if (!photos.length) { img.remove(); return; }
  document.getElementById('empty').remove();
  let i = Number(await widget.getState('index')) || 0;
  const show = () => { img.src = photos[i % photos.length]; };
  show();
  document.getElementById('card').addEventListener('click', () => {
    i = (i + 1) % photos.length;
    show();
    widget.setState('index', String(i));
  });
})();
</script>`,
            css: `.stage { width: 100%; height: 100%; display: grid; place-items: center; }
.polaroid { box-sizing: border-box; width: 82vmin; padding: 5vmin 5vmin 0; background: #fffdf8; border-radius: 2vmin; box-shadow: 0 2vmin 6vmin rgba(0, 0, 0, 0.18); transform: rotate(-4deg); transition: transform 0.2s; font-family: -apple-system, "PingFang TC", sans-serif; }
.polaroid[data-tilt="不歪"] { transform: none; }
.polaroid[data-tilt="往右"] { transform: rotate(4deg); }
.polaroid:active { transform: scale(0.97); }
.photo { position: relative; aspect-ratio: 1; overflow: hidden; background: #ece6dc; }
.photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.empty { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: #9b9083; font-size: 6.5vmin; line-height: 1.5; }
.caption { padding: 3.5vmin 0 4.5vmin; text-align: center; color: #5b5046; font-size: 7vmin; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`,
        },
    },
    {
        id: 'todo',
        name: '今日待辦',
        description: '點一下打勾，可以設成每天重來',
        template: {
            name: '今日待辦',
            w: 2, h: 2,
            sizes: [size(2, 2), size(4, 2), size(4, 3), size(4, 4)],
            imageKeys: [BG_IMAGE], images: {},
            fields: [
                { key: 'title', label: '標題', type: 'text', default: '今天要做的' },
                { key: 'items', label: '要做的事（一行一件）', type: 'textarea', default: '喝水\n回訊息\n早點睡' },
                { key: 'daily', label: '打勾', type: 'select', options: ['每天重來', '一直留著'], default: '每天重來' },
                { key: 'accent', label: '勾勾顏色', type: 'color', default: '#6fa38a' },
                bgField(),
            ],
            html: `<div class="card td" ${CARD_ATTRS}>
  <div class="head"><span>{{title}}</span><span id="count"></span></div>
  <ul id="list"></ul>
</div>
<script>
(async () => {
  ${ymd}
  const items = ((await widget.getState('items')) || '').split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 12);
  const daily = (await widget.getState('daily')) !== '一直留著';
  let saved = {};
  try { saved = JSON.parse((await widget.getState('done')) || '{}'); } catch (e) {}
  const today = ymd(new Date());
  let done = new Set(daily && saved.day !== today ? [] : (saved.items || []));
  const list = document.getElementById('list');
  const count = document.getElementById('count');
  const draw = () => {
    list.innerHTML = '';
    for (const text of items) {
      const li = document.createElement('li');
      li.className = done.has(text) ? 'done' : '';
      li.innerHTML = '<i></i><span></span>';
      li.querySelector('span').textContent = text;
      li.addEventListener('click', () => {
        if (done.has(text)) done.delete(text); else done.add(text);
        widget.setState('done', JSON.stringify({ day: today, items: [...done] }));
        draw();
      });
      list.appendChild(li);
    }
    count.textContent = items.filter(t => done.has(t)).length + '/' + items.length;
  };
  draw();
})();
</script>`,
            css: `${CARD}
.td { display: flex; flex-direction: column; padding: clamp(12px, 7vmin, 22px) clamp(14px, 7vmin, 24px) 8px; }
.head { display: flex; justify-content: space-between; align-items: baseline; font-size: clamp(14px, 8.5vmin, 19px); font-weight: 800; margin-bottom: 4px; }
.head span:last-child { font-size: 0.75em; font-weight: 700; opacity: 0.5; }
ul { flex: 1; min-height: 0; margin: 0; padding: 0; list-style: none; overflow: hidden; }
li { display: flex; align-items: center; gap: 10px; padding: clamp(4px, 2.4vmin, 9px) 0; font-size: clamp(13px, 7.5vmin, 17px); cursor: pointer; }
li i { width: 1.05em; height: 1.05em; flex-shrink: 0; box-sizing: border-box; border: 2px solid {{accent}}; border-radius: 50%; }
li.done i { background: {{accent}}; box-shadow: inset 0 0 0 2.5px rgba(255, 255, 255, 0.85); }
li.done span { opacity: 0.4; text-decoration: line-through; }
li span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* 橫的：兩欄排 */
${LANDSCAPE} { ul { columns: 2; column-gap: 18px; } li { break-inside: avoid; } }`,
        },
    },
    {
        id: 'water',
        name: '喝水計數',
        description: '點一下加一杯，每天自動歸零',
        template: {
            name: '喝水計數',
            w: 2, h: 2,
            sizes: [size(2, 2), size(2, 1), size(4, 1)],
            imageKeys: [BG_IMAGE], images: {},
            fields: [
                { key: 'label', label: '名稱', type: 'text', default: '今天喝水' },
                { key: 'goal', label: '目標', type: 'number', default: '8' },
                { key: 'unit', label: '單位', type: 'text', default: '杯' },
                { key: 'accent', label: '顏色', type: 'color', default: '#5b9bd5' },
                bgField(),
            ],
            html: `<div class="card wt" id="card" ${CARD_ATTRS}>
  <div class="ring" id="ring"><div class="inner"><b id="n">0</b><small id="goal"></small></div></div>
  <div class="label">{{label}}<span class="of" id="of"></span></div>
  <button class="minus" id="minus" aria-label="減一">−</button>
</div>
<script>
(async () => {
  ${ymd}
  const goal = Math.max(1, Number(await widget.getState('goal')) || 8);
  const unit = (await widget.getState('unit')) || '';
  const today = ymd(new Date());
  let saved = {};
  try { saved = JSON.parse((await widget.getState('count')) || '{}'); } catch (e) {}
  let n = saved.day === today ? Number(saved.n) || 0 : 0;
  const draw = () => {
    document.getElementById('n').textContent = n;
    document.getElementById('goal').textContent = '/ ' + goal + ' ' + unit;
    document.getElementById('of').textContent = n + ' / ' + goal + ' ' + unit;
    document.getElementById('ring').style.setProperty('--p', Math.min(1, n / goal) * 360 + 'deg');
  };
  const save = () => widget.setState('count', JSON.stringify({ day: ymd(new Date()), n }));
  document.getElementById('card').addEventListener('click', () => { n += 1; save(); draw(); });
  document.getElementById('minus').addEventListener('click', e => { e.stopPropagation(); n = Math.max(0, n - 1); save(); draw(); });
  draw();
})();
</script>`,
            css: `${CARD}
.wt { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4vmin; cursor: pointer; }
.ring { --p: 0deg; width: 58vmin; height: 58vmin; flex-shrink: 0; border-radius: 50%; background: conic-gradient({{accent}} var(--p), rgba(127, 127, 127, 0.18) 0); display: grid; place-items: center; transition: background 0.3s; }
.inner { width: 46vmin; height: 46vmin; border-radius: 50%; background: var(--surface); display: flex; flex-direction: column; align-items: center; justify-content: center; }
.card[data-bg="淺色毛玻璃"] .inner { background: rgba(255, 255, 255, 0.92); }
.inner b { color: {{accent}}; font-size: 20vmin; line-height: 1; }
.inner small { margin-top: 1vmin; font-size: 6vmin; opacity: 0.55; }
.label { font-size: 7.5vmin; font-weight: 700; opacity: 0.75; }
.of { display: none; }
.minus { position: absolute; right: 5vmin; top: 5vmin; width: 11vmin; height: 11vmin; border: 0; border-radius: 50%; background: var(--surface); color: var(--ink); font-size: 8vmin; line-height: 1; }
/* 橫的、扁長：圈在左，名稱和杯數在右 */
@media (min-aspect-ratio: 3/2) {
  .wt { flex-direction: row; justify-content: flex-start; gap: 5vw; padding: 0 6vw; }
  .ring { width: 74vh; height: 74vh; }
  .inner { width: 58vh; height: 58vh; }
  .inner b { font-size: 30vh; }
  .inner small { display: none; }
  .label { display: flex; flex-direction: column; gap: 3vh; font-size: 17vh; opacity: 0.85; }
  .of { display: block; font-size: 13vh; font-weight: 600; opacity: 0.6; }
  .minus { top: 50%; right: 5vw; transform: translateY(-50%); width: 26vh; height: 26vh; font-size: 18vh; }
}
/* 2×1：窄，「−」縮到右上角，字讓出位置 */
${LANDSCAPE} {
  .wt { padding: 0 16vw 0 5vw; gap: 4vw; }
  .label { font-size: 14vh; }
  .of { font-size: 11vh; }
  .minus { top: 7vh; right: 3vw; transform: none; width: 22vh; height: 22vh; font-size: 15vh; }
}`,
        },
    },
    {
        id: 'sticky',
        name: '便條紙',
        description: '寫一句話貼在桌面上，換紙的顏色',
        template: {
            name: '便條紙',
            w: 2, h: 2,
            sizes: [size(2, 2), size(4, 2)],
            imageKeys: [], images: {},
            fields: [
                { key: 'note', label: '寫什麼', type: 'textarea', default: '記得對自己好一點 ♡' },
                { key: 'paper', label: '紙的顏色', type: 'select', options: ['奶油黃', '櫻花粉', '天空藍', '薄荷綠'], default: '奶油黃' },
            ],
            html: `<div class="stage"><div class="note" data-paper="{{paper}}"><div class="tape"></div><p>{{note}}</p></div></div>`,
            css: `.stage { width: 100%; height: 100%; display: grid; place-items: center; }
.note { position: relative; box-sizing: border-box; width: 86vmin; height: 86vmin; padding: 13vmin 8vmin 8vmin; background: #fbefb5; box-shadow: 0 2.5vmin 6vmin rgba(0, 0, 0, 0.16); transform: rotate(2deg); font-family: "Klee One", "Kaiti TC", "PingFang TC", serif; color: #4a4238; }
.note[data-paper="櫻花粉"] { background: #f8d7dc; }
.note[data-paper="天空藍"] { background: #d4e6f5; }
.note[data-paper="薄荷綠"] { background: #d6eedb; }
.tape { position: absolute; left: 50%; top: -3vmin; width: 32vmin; height: 10vmin; transform: translateX(-50%) rotate(-3deg); background: rgba(255, 255, 255, 0.55); box-shadow: 0 0.5vmin 1.5vmin rgba(0, 0, 0, 0.08); }
.note p { margin: 0; font-size: 9vmin; line-height: 1.55; white-space: pre-line; word-break: break-word; overflow: hidden; max-height: 100%; }
/* 橫的：長條便條 */
${LANDSCAPE} {
  .note { width: 90vw; height: 80vh; padding: 16vh 6vw 8vh; transform: rotate(-1.2deg); }
  .tape { width: 22vw; height: 12vh; top: -4vh; }
  .note p { font-size: 11vh; }
}`,
        },
    },
    {
        id: 'typewriter',
        name: '打字機',
        description: '一個字一個字打出你寫的句子，打完換下一句',
        template: {
            name: '打字機',
            w: 4, h: 1,
            sizes: [size(4, 1), size(2, 1), size(4, 2)],
            imageKeys: [BG_IMAGE], images: {},
            fields: [
                { key: 'lines', label: '句子（一行一句，輪流打）', type: 'textarea', default: '把今天過成想要的樣子\n慢慢來也沒關係\n晚安，明天見' },
                { key: 'speed', label: '打字速度', type: 'select', options: ['慢', '普通', '快'], default: '普通' },
                { key: 'slashColor', label: '斜線顏色（留空跟字一樣）', type: 'color' },
                { key: 'textColor', label: '字的顏色（留空跟桌面一樣）', type: 'color' },
                { key: 'lineColor', label: '底線顏色（留空跟字一樣）', type: 'color' },
                bgField('透明'),
            ],
            html: `<div class="card tw" ${CARD_ATTRS}>
  <div class="line">
    <span class="slash">//</span>
    <span class="text"><span id="t"></span><i class="caret"></i></span>
  </div>
</div>
<script>
(async () => {
  const lines = ((await widget.getState('lines')) || '').split('\\n').map(s => s.trim()).filter(Boolean);
  const t = document.getElementById('t');
  if (!lines.length) { t.textContent = '整理桌面時點我，寫幾句話'; return; }
  const gap = { '慢': 200, '快': 70 }[await widget.getState('speed')] || 120;
  let li = 0;
  const run = () => {
    const chars = Array.from(lines[li % lines.length]);
    let i = 0;
    t.textContent = '';
    const step = () => {
      if (i < chars.length) { t.textContent += chars[i++]; setTimeout(step, gap); }
      else { li += 1; setTimeout(run, 3000); }
    };
    step();
  };
  run();
})();
</script>`,
            css: `${CARD}
.tw { display: flex; align-items: center; padding: 0 6vw; }
/* 顏色欄位留空時那條宣告是空的、瀏覽器會略過，就照上一條（跟字一樣） */
.line { width: 100%; display: flex; align-items: baseline; gap: 2.5vw; padding-bottom: 1.5vh; border-bottom: 1px solid currentColor; }
.line { border-bottom-color: {{lineColor}}; }
.slash { flex-shrink: 0; color: {{slashColor}}; font-size: 22vh; font-weight: 300; }
.text { min-width: 0; flex: 1; color: {{textColor}}; font-size: 15vh; font-style: italic; font-weight: 300; letter-spacing: 1px; white-space: nowrap; overflow: hidden; text-overflow: clip; }
.caret { display: inline-block; width: 1px; height: 1em; margin-left: 2px; vertical-align: -0.12em; background: currentColor; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
/* 2×1：字小一點 */
${LANDSCAPE} {
  .tw { padding: 0 7vw; align-items: center; }
  .slash { font-size: 18vh; }
  .text { font-size: 12vh; white-space: normal; }
}`,
        },
    },
];

/** 用一個範本：複製一份成自己的模板（新 id），之後隨便改都不影響範本 */
export const instantiateStarter = (starter: WidgetStarter, id: string, now = Date.now()): CustomWidgetTemplate => ({
    ...starter.template,
    imageKeys: [...starter.template.imageKeys],
    ...(starter.template.sizes ? { sizes: starter.template.sizes.map(z => ({ ...z })) } : {}),
    images: { ...starter.template.images },
    fields: starter.template.fields.map(f => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) })),
    id,
    createdAt: now,
    updatedAt: now,
});

// ─── 放上桌面的範本：直接指著範本，不複製進「我的小組件」 ─────────────────
// 桌面上那一份的 templateId 寫 `starter:<id>`，畫面從這裡現拿；從桌面移除就什麼都不留。
// 要改它的 HTML／CSS（設定裡的「編輯模板」）才複製一份成自己的，那一份改指著新模板。

export const STARTER_TEMPLATE_PREFIX = 'starter:';
export const starterTemplateId = (id: WidgetStarterId) => `${STARTER_TEMPLATE_PREFIX}${id}`;
export const isStarterTemplateId = (templateId: string | undefined) => !!templateId && templateId.startsWith(STARTER_TEMPLATE_PREFIX);

/** 範本 → 模板（固定 id `starter:<id>`），解析桌面上那幾份用 */
export const STARTER_TEMPLATES: CustomWidgetTemplate[] = WIDGET_STARTERS.map(s => instantiateStarter(s, starterTemplateId(s.id), 0));

const contentKey = (t: Pick<CustomWidgetTemplate, 'name' | 'html' | 'css' | 'w' | 'h' | 'imageKeys' | 'fields'>) =>
    JSON.stringify([t.name, t.html, t.css, t.w, t.h, t.imageKeys, t.fields]);

/**
 * 舊版「用這個」會複製一份進「我的小組件」：還沒改過（內容跟範本一模一樣、也沒放自己的圖）的那些，
 * 回傳 模板 id → 範本 id，讓呼叫端把桌面上那幾份改指範本、把複製品拿掉。改過的是用戶自己的東西，不動。
 */
export const findUntouchedStarterCopies = (templates: CustomWidgetTemplate[]): Map<string, string> => {
    const byContent = new Map(STARTER_TEMPLATES.map(t => [contentKey(t), t.id]));
    const out = new Map<string, string>();
    for (const t of templates) {
        if (isStarterTemplateId(t.id) || Object.values(t.images || {}).some(Boolean)) continue;
        const key = contentKey(t);
        const legacy = LEGACY_STARTER_FINGERPRINTS[contentFingerprint(key)];
        const starterId = byContent.get(key) || (legacy ? starterTemplateId(legacy) : undefined);
        if (starterId) out.set(t.id, starterId);
    }
    return out;
};

/** 內容指紋（djb2＋長度）：只拿來認舊版範本的複製品，不是安全用途 */
export const contentFingerprint = (text: string) => {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return `${h.toString(36)}:${text.length.toString(36)}`;
};

/**
 * 舊版範本（2026-11-10 #141 那一版，2026-11-11 改了版型和背景）的內容指紋 → 範本 id。
 * 那時「用這個」複製進「我的小組件」的，內容是舊版的，跟現在的範本對不上；靠這張表照樣認出來改指範本。
 */
const LEGACY_STARTER_FINGERPRINTS: Record<string, WidgetStarterId> = {
    '1tmt8tw:1h0': 'countdown',
    '1a0loq5:1sp': 'together',
    '112egw:1t0': 'charNote',
    '1mn534r:1o6': 'polaroid',
    'vccw6h:2b9': 'todo',
    'u3pa36:28z': 'water',
    '1kv9rcm:x5': 'sticky',
};
