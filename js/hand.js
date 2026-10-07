// 手勢辨識：MediaPipe Hand Landmarker + 自訂石頭 / 剪刀 / 布分類
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export const HAND_INFO = {
  rock:     { emoji: '✊', jp: 'グー',   zh: '石頭', color: '#ff5a5a' },
  scissors: { emoji: '✌️', jp: 'チョキ', zh: '剪刀', color: '#ffd23f' },
  paper:    { emoji: '✋', jp: 'パー',   zh: '布',   color: '#5cf2a0' },
};

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

// 依 21 個關鍵點判斷手勢。只用 2D 距離比例，手心或手背對鏡頭都可以。
export function classify(lm, aspect = 4 / 3) {
  const px = (i) => lm[i].x * aspect;
  const d = (a, b) => Math.hypot(px(a) - px(b), lm[a].y - lm[b].y);
  const palm = d(0, 9) || 1e-6;
  const extended = (tip, pip, mcp) => d(tip, 0) > d(pip, 0) * 1.08 && d(tip, mcp) > palm * 0.45;
  const [index, middle, ring, pinky] = [
    extended(8, 6, 5), extended(12, 10, 9), extended(16, 14, 13), extended(20, 18, 17),
  ];
  const n = [index, middle, ring, pinky].filter(Boolean).length;
  const thumbOut = d(4, 5) > palm * 0.65 && d(4, 0) > d(3, 0);

  if (n === 0) return 'rock';
  if (index && middle && !ring && !pinky) return 'scissors';
  if (index && !middle && !ring && !pinky && thumbOut) return 'scissors'; // 拇指＋食指的剪刀
  if (n >= 3) return 'paper';
  return null;
}

function mode(list) {
  const count = {};
  let best = null;
  for (const g of list) {
    if (!g) continue;
    count[g] = (count[g] || 0) + 1;
    if (!best || count[g] > count[best]) best = g;
  }
  return best;
}

export class HandTracker {
  constructor(video, overlay) {
    this.video = video;
    this.overlay = overlay;
    this.g2d = overlay.getContext('2d');
    this.history = [];
    this.current = null;
    this.hasHand = false;
    this.running = false;
    this.onUpdate = null;
  }

  async start(progress = () => {}) {
    progress('正在開啟攝影機…');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('這個網址不能使用攝影機。手機請用 start_phone.bat 顯示的 https 網址開啟');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    if (this.video.readyState < 1) await new Promise((r) => (this.video.onloadedmetadata = r));
    await this.video.play();
    this.overlay.width = this.video.videoWidth;
    this.overlay.height = this.video.videoHeight;

    progress('正在載入手勢辨識模型…（第一次會比較久）');
    const { FilesetResolver, HandLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('GPU delegate failed, falling back to CPU', err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
    }
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  loop = () => {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const now = performance.now();
      const result = this.landmarker.detectForVideo(v, now);
      const lms = result.landmarks && result.landmarks[0];
      const g = lms ? classify(lms, v.videoWidth / v.videoHeight) : null;
      this.history.push({ t: now, g });
      while (this.history.length && now - this.history[0].t > 4000) this.history.shift();
      this.hasHand = !!lms;
      this.current = mode(this.history.slice(-5).map((h) => h.g));
      this.draw(lms, this.current);
      if (this.onUpdate) this.onUpdate(this.current, this.hasHand);
    }
    requestAnimationFrame(this.loop);
  };

  // 取某段時間內最常出現的手勢（以最後 10 個有效影格為主）
  sample(from, to) {
    const frames = this.history.filter((h) => h.t >= from && h.t <= to && h.g).slice(-10);
    return mode(frames.map((h) => h.g));
  }

  draw(lms, g) {
    const c = this.g2d;
    const { width: w, height: h } = this.overlay;
    c.clearRect(0, 0, w, h);
    if (!lms) return;
    const color = g ? HAND_INFO[g].color : '#ffffff';
    c.lineWidth = Math.max(3, w / 160);
    c.strokeStyle = color;
    c.shadowColor = 'rgba(0,0,0,.6)';
    c.shadowBlur = 6;
    c.beginPath();
    for (const [a, b] of CONNECTIONS) {
      c.moveTo(lms[a].x * w, lms[a].y * h);
      c.lineTo(lms[b].x * w, lms[b].y * h);
    }
    c.stroke();
    c.fillStyle = '#fff';
    for (const p of lms) {
      c.beginPath();
      c.arc(p.x * w, p.y * h, Math.max(3, w / 140), 0, Math.PI * 2);
      c.fill();
    }
  }
}
