import { HandTracker, HAND_INFO } from './hand.js';
import { Sound } from './audio.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const app = $('#app');
const MAX = 4;
const STAGES = [0, 1, 2, 3, 4].map((i) => `assets/stage${i}.jpg`);
const LOSE_IMG = 'assets/lose.jpg';
const GESTURES = ['rock', 'scissors', 'paper'];
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

const HER_ITEMS = [
  { icon: '🧢', name: '棒球帽' },
  { icon: '🧥', name: '棒球外套' },
  { icon: '👕', name: '球衣' },
  { icon: '👖', name: '球褲' },
];
const YOU_ITEMS = [
  { icon: '🧢', name: '帽子' },
  { icon: '🧥', name: '外套' },
  { icon: '👕', name: '上衣' },
  { icon: '👖', name: '褲子' },
];
// 美咲每輸一次的台詞（對應脫掉第 n 件）
const HER_STRIP_LINES = [
  '咦！？先脫帽子？\n還早得很呢～！',
  '嗚…連外套都…\n下一把絕對不會輸！',
  '等、等一下啦！\n我要認真了喔！',
  '我投降啦～！\n不要看～！',
];
// 美咲贏的時候 [語音, 台詞]
const HER_WIN_LINES = [
  ['taunt1', '耶～我贏了！\n換你脫囉♪'],
  ['taunt2', '哼哼～\n早就看穿你了！'],
  ['taunt1', '想贏我？\n再練一百年吧♪'],
];

const snd = new Sound();
let tracker = null;
let useCam = false;
let keyHand = null;
let audioReady = null;
const S = { herLost: 0, youLost: 0, round: 1, playing: false, endBus: null, resolvedAt: 0 };

// ---------- 畫面小工具 ----------

function setMode(mode) {
  app.classList.remove('mode-title', 'mode-setup', 'mode-game', 'mode-end');
  app.classList.add(`mode-${mode}`);
}

function retrigger(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// 直式螢幕會裁切圖片左右兩側，這裡記錄每張圖要對準的水平位置（角色中心）
const FOCUS_X = { [LOSE_IMG]: '56%' };

let bgFront = $('#bgA');
let bgBack = $('#bgB');
async function setScene(src) {
  if (bgFront.getAttribute('src') === src) return;
  bgBack.src = src;
  bgBack.style.setProperty('--focus', FOCUS_X[src] || '52%');
  try {
    await bgBack.decode();
  } catch {}
  bgBack.classList.add('show');
  bgFront.classList.remove('show');
  [bgFront, bgBack] = [bgBack, bgFront];
}

function renderHud() {
  const row = (items, lost) =>
    items.map((it, i) => `<span class="item${i < lost ? ' gone' : ''}" title="${it.name}">${it.icon}</span>`).join('');
  $('#youItems').innerHTML = row(YOU_ITEMS, S.youLost);
  $('#herItems').innerHTML = row(HER_ITEMS, S.herLost);
  $('#roundLabel').textContent = `第 ${S.round} 回戰`;
}

function chant(text, cls = '') {
  $('#chant').innerHTML = text ? `<span class="w ${cls}">${text}</span>` : '';
}

function banner(text, cls) {
  const el = $('#banner');
  el.textContent = text;
  el.className = cls;
  retrigger(el, 'show');
}
const hideBanner = () => ($('#banner').className = '');

function telop(html) {
  const el = $('#telop');
  el.innerHTML = html;
  el.classList.add('show');
}
const hideTelop = () => $('#telop').classList.remove('show');

function say(text) {
  const el = $('#bubble');
  el.textContent = text;
  retrigger(el, 'show');
}
const hideBubble = () => $('#bubble').classList.remove('show');

function showHand(who, g) {
  const card = $(who === 'you' ? '#handYou' : '#handHer');
  const info = HAND_INFO[g];
  card.querySelector('.hand img').src = info.img;
  card.querySelector('.lbl').innerHTML = `${info.zh}<small>${info.jp}</small>`;
  card.classList.remove('winner', 'loser');
  card.classList.add('show');
}

function markWinner(who) {
  $('#handYou').classList.add(who === 'you' ? 'winner' : 'loser');
  $('#handHer').classList.add(who === 'her' ? 'winner' : 'loser');
}

function hideHands() {
  for (const el of [$('#handYou'), $('#handHer')]) el.classList.remove('show', 'winner', 'loser');
}

function curtains(closed) {
  $('#curtainL').classList.toggle('closed', closed);
  $('#curtainR').classList.toggle('closed', closed);
}

const pulse = () => retrigger($('#scene'), 'pulse');
const camArm = (on) => $('#camPanel').classList.toggle('armed', on);

// 依音訊時間排程畫面動作
function cue(t, fn) {
  setTimeout(fn, Math.max(0, snd.wallTime(t) - performance.now()));
}
const sleepUntil = (wall) => sleep(Math.max(0, wall - performance.now()));

// ---------- 彩帶 ----------

const fx = $('#fx');
const fctx = fx.getContext('2d');
const COLORS = ['#ff2a3d', '#ffd23f', '#ffffff', '#ff8fa3', '#ffb000'];
let parts = [];
let fxRunning = false;

function confetti(n) {
  const r = app.getBoundingClientRect();
  fx.width = r.width * devicePixelRatio;
  fx.height = r.height * devicePixelRatio;
  const W = fx.width;
  const H = fx.height;
  for (let i = 0; i < n; i++) {
    parts.push({
      x: Math.random() * W, y: -Math.random() * H * 0.6,
      vx: (Math.random() - 0.5) * W * 0.004, vy: H * (0.004 + Math.random() * 0.006),
      w: W * (0.006 + Math.random() * 0.006), h: W * (0.003 + Math.random() * 0.004),
      r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      c: pick(COLORS),
    });
  }
  if (!fxRunning) {
    fxRunning = true;
    requestAnimationFrame(stepFx);
  }
}

function stepFx() {
  const H = fx.height;
  fctx.clearRect(0, 0, fx.width, H);
  for (const p of parts) {
    p.x += p.vx + Math.sin(p.r) * 0.6;
    p.y += p.vy;
    p.r += p.vr;
    fctx.save();
    fctx.translate(p.x, p.y);
    fctx.rotate(p.r);
    fctx.scale(1, Math.cos(p.r * 1.7));
    fctx.fillStyle = p.c;
    fctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    fctx.restore();
  }
  parts = parts.filter((p) => p.y < H + 40);
  if (parts.length) requestAnimationFrame(stepFx);
  else {
    fxRunning = false;
    fctx.clearRect(0, 0, fx.width, H);
  }
}

// ---------- 輸入 ----------

function onHandUpdate(g, hasHand) {
  const lbl = $('#camLabel');
  if (g) {
    const info = HAND_INFO[g];
    lbl.textContent = `${info.emoji} ${info.jp}（${info.zh}）`;
    lbl.style.color = info.color;
  } else {
    lbl.textContent = hasHand ? '🤔 看不太出來…' : '✋ 請把手舉到鏡頭前';
    lbl.style.color = '#bbb';
  }
  document.querySelectorAll('.gestureRow .g').forEach((el) => el.classList.toggle('on', el.dataset.g === g));
}

// 出拳判定：按鈕 / 鍵盤從這回合開始到「よいっ！」後 THROW_LATE_MS 內按的都算（以最後一次為準）；
// 攝影機則找「よいっ！」之後第一個維持 STABLE_MS 以上的手勢，最晚等到 THROW_LATE_MS。
const THROW_LATE_MS = 1200;
const STABLE_MS = 180;

function readPlayerHand(openWall, capWall, final) {
  if (keyHand && keyHand.t >= openWall) return keyHand.g;
  if (!useCam || !tracker) return null;
  const g = tracker.stable(capWall + 50, STABLE_MS);
  if (g || !final) return g;
  return tracker.sample(capWall - 600, capWall + THROW_LATE_MS);
}

async function waitForThrow(openWall, capWall) {
  await sleepUntil(capWall + 150);
  const deadline = capWall + THROW_LATE_MS;
  for (;;) {
    const final = performance.now() >= deadline;
    const g = readPlayerHand(openWall, capWall, final);
    if (g || final) return g;
    await sleep(40);
  }
}

function clearPicked() {
  keyHand = null;
  for (const b of document.querySelectorAll('#touchHands button')) b.classList.remove('picked');
}

function manualHand(g) {
  keyHand = { g, t: performance.now() };
  for (const b of document.querySelectorAll('#touchHands button')) b.classList.toggle('picked', b.dataset.g === g);
  const btn = document.querySelector(`#touchHands [data-g="${g}"]`);
  retrigger(btn, 'on');
  setTimeout(() => btn.classList.remove('on'), 250);
}

for (const btn of document.querySelectorAll('#touchHands button')) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    manualHand(btn.dataset.g);
  });
}

const KEYMAP = { 1: 'rock', 2: 'scissors', 3: 'paper', z: 'rock', x: 'scissors', c: 'paper' };
addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (KEYMAP[key]) manualHand(KEYMAP[key]);
  else if (key === 'm') toggleMute();
  else if (key === 'f') toggleFull();
  else if ((key === ' ' || key === 'enter') && !S.playing && (app.classList.contains('mode-setup') || app.classList.contains('mode-end'))) {
    e.preventDefault();
    startGame();
  }
});

function toggleMute() {
  if (!audioReady) return;
  $('#btnMute').textContent = snd.toggleMute() ? '🔇' : '🔊';
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}

if (matchMedia('(pointer: coarse)').matches) app.classList.add('touch');
if (!document.documentElement.requestFullscreen) app.classList.add('nofs');

// ---------- 遊戲流程 ----------

function ensureAudio() {
  if (!audioReady) {
    $('#loadMsg').textContent = '載入音效中…';
    audioReady = snd.init().then(() => {
      snd.startLoop();
      $('#loadMsg').textContent = '';
    });
  } else snd.resume();
  return audioReady;
}

// 一次出拳。quick = あいこ（只喊「あいこで しょっ！」）；retry = 上一次沒出拳，整局重來
async function throwRound(quick, retry = false) {
  hideHands();
  hideBanner();
  // あいこ：上一拳揭曉之後點的都算（很多人一看到「あいこ！」就馬上出下一拳）
  if (!quick) clearPicked();
  const bus = snd.phraseBus();
  const B = snd.B;
  const t0 = snd.now + 0.15;
  const openWall = quick ? S.resolvedAt : snd.wallTime(t0);
  let capT;

  if (!quick) {
    snd.phraseIntro(t0, bus, (S.round + 1) % 2);
    for (let i = 0; i < 8; i++) cue(t0 + i * B, pulse);
    cue(t0, () => chant(`第${S.round}回戰`, 'small'));
    cue(t0 + 4 * B, () => chant('準備出拳！', 'small'));
    if (S.round === 1 || retry) telop('在「<b>よいっ！</b>」的瞬間出拳！');
    const tc = t0 + 8 * B;
    capT = snd.phraseChant(tc, bus);
    cue(tc, () => { chant('アウト！'); pulse(); hideTelop(); });
    cue(tc + 2 * B, () => { chant('セーフ！'); pulse(); });
    cue(tc + 4 * B, () => { chant('よよいの'); pulse(); camArm(true); });
  } else {
    capT = snd.phraseAiko(t0, bus);
    cue(t0, () => { chant('あいこで'); pulse(); camArm(true); });
  }
  cue(capT, () => { chant(quick ? 'しょっ！' : 'よいっ！', 'big'); pulse(); });

  const capWall = snd.wallTime(capT);
  const you = await waitForThrow(openWall, capWall);
  camArm(false);
  hideTelop();
  clearPicked();
  S.resolvedAt = performance.now();

  if (!you && quick) {
    // あいこ中沒出拳不算失誤，直接再喊一次「あいこで しょっ！」
    chant('');
    telop('あいこ！再出一次！');
    await sleep(500);
    return 'draw';
  }
  if (!you) {
    chant('');
    banner('不算！', 'draw');
    telop('沒有偵測到出拳，這局不算，重新再來！');
    snd.boing();
    await sleep(1800);
    hideBanner();
    hideTelop();
    return 'none';
  }

  const her = pick(GESTURES);
  chant('');
  showHand('you', you);
  showHand('her', her);
  snd.reveal();
  await sleep(450);

  if (you === her) {
    banner('あいこ！', 'draw');
    telop('あいこ！再出一次！');
    snd.jingleDraw();
    await sleep(750);
    hideBanner();
    return 'draw';
  }
  const win = BEATS[you] === her;
  markWinner(win ? 'you' : 'her');
  if (win) {
    banner('勝ち！', 'win');
    snd.jingleWin();
  } else {
    banner('負け…', 'lose');
    snd.jingleLose();
  }
  await sleep(1300);
  hideBanner();
  return win ? 'win' : 'lose';
}

async function herStrips() {
  hideHands();
  const idx = S.herLost;
  const item = HER_ITEMS[idx];
  S.herLost++;

  telop(`美咲 要脫掉【<b>${item.name}</b>】了！`);
  curtains(true);
  snd.drumroll(snd.now, 1.3);
  await sleep(1350);
  await setScene(STAGES[S.herLost]);
  renderHud();
  await sleep(200);

  curtains(false);
  snd.stripReveal();
  retrigger($('#jajan'), 'show');
  retrigger($('#scene'), 'shake');
  confetti(90);
  await sleep(450);
  $('#jajan').classList.remove('show');

  const voice = S.herLost === MAX ? 'surrender' : pick(['ouch1', 'ouch2']);
  const d = snd.voice(voice);
  say(HER_STRIP_LINES[idx]);
  telop(`美咲 脫掉了【<b>${item.name}</b>】！`);
  await sleep(Math.max(2300, d * 1000 + 500));
  hideBubble();
  hideTelop();
}

async function youStrip() {
  const idx = S.youLost;
  const item = YOU_ITEMS[idx];
  S.youLost++;
  hideHands();
  $('#youItems').children[idx].classList.add('flyoff');

  const [voice, line] = pick(HER_WIN_LINES);
  const d = snd.voice(voice);
  say(line);
  telop(`你脫掉了【<b>${item.name}</b>】！`);
  await sleep(Math.max(2200, d * 1000 + 400));
  hideBubble();
  hideTelop();
  renderHud();
}

async function ending(victory) {
  hideHands();
  hideBanner();
  chant('');
  const title = $('#endTitle');
  if (victory) {
    S.endBus = snd.fanfare();
    confetti(260);
    title.textContent = '完全勝利！';
    title.className = 'endTitle';
    $('#endSub').textContent = `美咲：「嗚嗚…我投降了啦～」　${S.round - 1} 回合獲勝！`;
  } else {
    await setScene(LOSE_IMG);
    snd.sadTrombone();
    snd.voice('champion', snd.now + 0.4);
    title.textContent = '你輸了…';
    title.className = 'endTitle lose';
    $('#endSub').textContent = `美咲：「我的完全勝利！再來挑戰吧♪」　美咲還剩 ${MAX - S.herLost} 件`;
  }
  setMode('end');
}

async function startGame() {
  if (S.playing) return;
  S.playing = true;
  await ensureAudio();
  snd.stopLoop();
  if (S.endBus) {
    snd.killBus(S.endBus);
    S.endBus = null;
  }
  Object.assign(S, { herLost: 0, youLost: 0, round: 1 });
  hideHands();
  hideBanner();
  hideBubble();
  hideTelop();
  await setScene(STAGES[0]);
  renderHud();
  setMode('game');

  const d = snd.voice('start');
  say('野球拳、開始囉～！\n輸的人要脫一件喔♪');
  chant('野球拳', 'big');
  pulse();
  await sleep(Math.max(1800, d * 1000 + 300));
  hideBubble();
  chant('');

  while (S.herLost < MAX && S.youLost < MAX) {
    renderHud();
    let r = await throwRound(false);
    while (r === 'draw' || r === 'none') r = await throwRound(r === 'draw', r === 'none');
    if (r === 'win') await herStrips();
    else await youStrip();
    S.round++;
  }
  await ending(S.herLost >= MAX);
  S.playing = false;
}

// ---------- 按鈕 ----------

$('#btnCamera').onclick = async () => {
  const btn = $('#btnCamera');
  const msg = $('#loadMsg');
  btn.disabled = true;
  msg.classList.remove('err');
  try {
    await ensureAudio();
    tracker = tracker || new HandTracker($('#cam'), $('#camOverlay'));
    tracker.onUpdate = onHandUpdate;
    if (!tracker.running) await tracker.start((m) => (msg.textContent = m));
    const v = $('#cam');
    app.style.setProperty('--cam-ar', `${v.videoWidth} / ${v.videoHeight}`);
    msg.textContent = '';
    useCam = true;
    app.classList.remove('nocam');
    setMode('setup');
  } catch (err) {
    console.error(err);
    msg.classList.add('err');
    msg.textContent = `無法開啟攝影機或載入模型（${err.name || ''} ${err.message || err}）。可以改用鍵盤玩。`;
  } finally {
    btn.disabled = false;
  }
};

$('#btnKeyboard').onclick = async () => {
  await ensureAudio();
  useCam = false;
  app.classList.add('nocam');
  setMode('setup');
};

$('#btnStart').onclick = startGame;
$('#btnRetry').onclick = startGame;
$('#btnMute').onclick = toggleMute;
$('#btnFull').onclick = toggleFull;

for (const src of [...STAGES, LOSE_IMG, ...Object.values(HAND_INFO).map((h) => h.img)]) new Image().src = src;
