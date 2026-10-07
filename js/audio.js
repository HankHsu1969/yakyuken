// 音效引擎：Web Audio 即時合成的昭和綜藝樂團風配樂
// （銅管主旋律、和弦切分、弦樂鋪底、合成貝斯、爵士鼓，加上太鼓與鉦的祭典味）＋角色語音
const VOICE_FILES = [
  'out', 'safe', 'yoyoino', 'yoi', 'aikode', 'sho', 'start',
  'taunt1', 'taunt2', 'ouch1', 'ouch2', 'surrender', 'champion',
];

export const BPM = 144;

// 四七抜き長音階（G 調）旋律：[拍, MIDI, 長度(拍)]
const MELODY_A = [
  [0, 74, 0.5], [0.5, 76, 0.5], [1, 74, 0.5], [1.5, 71, 0.5],
  [2, 69, 0.5], [2.5, 71, 0.5], [3, 67, 1],
  [4, 76, 0.5], [4.5, 79, 0.5], [5, 76, 0.5], [5.5, 74, 0.5],
  [6, 71, 0.5], [6.5, 69, 0.5], [7, 67, 0.5], [7.5, 62, 0.5],
];
const MELODY_B = [
  [0, 79, 0.5], [0.5, 81, 0.5], [1, 79, 0.5], [1.5, 76, 0.5],
  [2, 74, 1], [3, 76, 0.5], [3.5, 74, 0.5],
  [4, 71, 0.5], [4.5, 74, 0.5], [5, 71, 0.5], [5.5, 69, 0.5],
  [6, 67, 1.5], [7.5, 62, 0.5],
];
// 每一拍的和弦
const HARMONY_A = ['G', 'G', 'D', 'G', 'C', 'C', 'G', 'D'];
const HARMONY_B = ['C', 'C', 'G', 'Em', 'G', 'D', 'G', 'D'];

const CHORDS = {
  G: { stab: [59, 62, 67], pad: [55, 59, 62, 67], root: 43, fifth: 50 },
  C: { stab: [60, 64, 67], pad: [52, 55, 60, 64], root: 48, fifth: 43 },
  D: { stab: [57, 62, 66], pad: [54, 57, 62, 66], root: 50, fifth: 45 },
  Em: { stab: [59, 64, 67], pad: [52, 55, 59, 64], root: 40, fifth: 47 },
  Eb: { stab: [58, 63, 67], pad: [55, 58, 63], root: 51, fifth: 46 },
};

const swing = (b) => (b % 1 === 0.5 ? b + 0.06 : b);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Sound {
  constructor() {
    this.voices = {};
    this.pluckCache = {};
    this.B = 60 / BPM;
    this.muted = false;
  }

  // ctx 可傳入 OfflineAudioContext（離線算出整段音樂做檢查）
  async init(ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = ctx || new AC({ latencyHint: 'interactive' }));
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    // 最後一級：限幅器 + 軟削波，避免重拍爆音
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    const clip = c.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
    }
    clip.curve = curve;
    this.master = c.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp).connect(limiter).connect(clip).connect(c.destination);

    this.music = this.bus(0.55, this.master);
    this.sfx = this.bus(0.75, this.master);
    this.vox = this.bus(1.2, this.master);

    // 舞台殘響
    const verb = c.createConvolver();
    verb.buffer = this.impulse(1.6);
    this.verbSend = this.bus(0.16, verb);
    verb.connect(this.master);
    this.music.connect(this.verbSend);
    this.sfx.connect(this.verbSend);
    this.vox.connect(this.verbSend);

    // 主旋律專用通道：附點八分音符回音
    this.lead = this.bus(1, this.music);
    const delay = c.createDelay(1);
    delay.delayTime.value = this.B * 0.75;
    const fb = this.bus(0.3, delay);
    const wet = this.bus(0.22, this.music);
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2800;
    this.lead.connect(delay);
    delay.connect(tone).connect(fb);
    tone.connect(wet);

    const len = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;

    await Promise.all(VOICE_FILES.map((n) => this.loadVoice(n)));
  }

  get now() {
    return this.ctx.currentTime;
  }

  // 從排程時間點到「真正聽到聲音」的延遲（秒）
  get latency() {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  // 把 AudioContext 時間換算成 performance.now() 時間（含輸出延遲）
  wallTime(t) {
    return performance.now() + (t - this.ctx.currentTime + this.latency) * 1000;
  }

  resume() {
    if (this.ctx.state !== 'running') return this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.now, 0.03);
    return this.muted;
  }

  bus(gain, dest) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(dest);
    return g;
  }

  // 可單獨關掉的音樂通道（循環 BGM、每回合樂句）
  phraseBus() {
    return this.bus(1, this.music);
  }

  killBus(bus) {
    if (!bus) return;
    bus.gain.setTargetAtTime(0, this.now, 0.06);
    setTimeout(() => bus.disconnect(), 800);
  }

  impulse(sec) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  async loadVoice(name) {
    try {
      const res = await fetch(`assets/voice/${name}.mp3`);
      if (!res.ok) throw new Error(res.status);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      const d = buf.getChannelData(0);
      let s = 0;
      while (s < d.length && Math.abs(d[s]) < 0.03) s++;
      let e = d.length - 1;
      while (e > s && Math.abs(d[e]) < 0.02) e--;
      this.voices[name] = { buf, off: Math.max(0, s / buf.sampleRate - 0.012), dur: (e - s) / buf.sampleRate };
    } catch (err) {
      console.warn('語音檔載入失敗', name, err);
    }
  }

  // 播放語音；maxDur 有給時會稍微加速讓它塞進拍子裡
  voice(name, t = this.now, maxDur = 0) {
    const v = this.voices[name];
    if (!v) return 0;
    const rate = maxDur ? Math.min(1.25, Math.max(1, v.dur / maxDur)) : 1;
    const src = this.ctx.createBufferSource();
    src.buffer = v.buf;
    src.playbackRate.value = rate;
    src.connect(this.vox);
    src.start(Math.max(t, this.now), v.off);
    return v.dur / rate;
  }

  noise(t, out, filterType, freq, q, vol, decay) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.3);
    src.stop(t + decay + 0.05);
  }

  // ---------- 合成器 ----------

  // 多個微走音振盪器 → 低通濾波（含濾波包絡）→ 音量包絡，可加顫音
  tone(t, midi, dur, o = {}) {
    const {
      type = 'sawtooth', detunes = [0], vol = 0.1, attack = 0.01, release = 0.1,
      cutoff = 3000, envAmt = 0, q = 0.7, vib = 0, out = this.music,
    } = o;
    const c = this.ctx;
    const end = t + dur + release;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = q;
    if (envAmt) {
      f.frequency.setValueAtTime(cutoff + envAmt, t);
      f.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(dur, 0.3) + 0.01);
    } else f.frequency.value = cutoff;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setValueAtTime(vol, t + Math.max(attack, dur));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    f.connect(g).connect(out);

    let lfoGain = null;
    if (vib) {
      const lfo = c.createOscillator();
      lfo.frequency.value = 5.5;
      lfoGain = c.createGain();
      lfoGain.gain.setValueAtTime(0, t);
      lfoGain.gain.linearRampToValueAtTime(vib, t + 0.3);
      lfo.connect(lfoGain);
      lfo.start(t);
      lfo.stop(end + 0.05);
    }
    for (const d of detunes) {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.value = mtof(midi);
      osc.detune.value = d;
      if (lfoGain) lfoGain.connect(osc.detune);
      osc.connect(f);
      osc.start(t);
      osc.stop(end + 0.05);
    }
  }

  // 銅管風主旋律
  leadNote(t, midi, dur, vol = 0.085) {
    this.tone(t, midi, dur, {
      type: 'sawtooth', detunes: [-7, 7], vol, attack: 0.018, release: 0.09,
      cutoff: 1500, envAmt: 2600, q: 1.2, vib: 16, out: this.lead,
    });
    this.tone(t, midi - 12, dur, { type: 'square', vol: vol * 0.35, attack: 0.02, release: 0.08, cutoff: 1200, out: this.lead });
  }

  // 和弦切分（反拍的「恰」）
  stab(t, notes, dur, vol = 0.03, out = this.music) {
    for (const m of notes) {
      this.tone(t, m, dur, { type: 'sawtooth', detunes: [-9, 9], vol, attack: 0.006, release: 0.07, cutoff: 1100, envAmt: 2400, q: 1.5, out });
    }
  }

  // 弦樂鋪底
  pad(t, notes, dur, vol = 0.014, out = this.music) {
    for (const m of notes) {
      this.tone(t, m, dur, { type: 'sawtooth', detunes: [-12, 0, 12], vol, attack: 0.12, release: 0.35, cutoff: 1300, q: 0.5, out });
    }
  }

  bass(t, midi, dur, out = this.music) {
    this.tone(t, midi, dur, { type: 'sawtooth', vol: 0.12, attack: 0.004, release: 0.05, cutoff: 320, envAmt: 1100, q: 5, out });
    this.tone(t, midi, dur, { type: 'sine', vol: 0.16, attack: 0.004, release: 0.05, cutoff: 4000, out });
  }

  kick(t, vol = 0.7, out = this.music) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.4);
    this.noise(t, out, 'highpass', 3000, 0.7, vol * 0.15, 0.015);
  }

  snare(t, vol = 0.32, out = this.music) {
    const c = this.ctx;
    this.noise(t, out, 'bandpass', 1900, 0.8, vol, 0.16);
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.06);
    const g = c.createGain();
    g.gain.setValueAtTime(vol * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.1);
  }

  hat(t, vol = 0.07, open = false, out = this.music) {
    this.noise(t, out, 'highpass', 7800, 0.6, vol, open ? 0.22 : 0.035);
  }

  clap(t, vol = 0.25, out = this.music) {
    [0, 0.011, 0.023].forEach((d) => this.noise(t + d, out, 'bandpass', 1150, 1.2, vol, 0.09));
  }

  // Karplus-Strong 撥弦（三味線點綴用）
  pluckBuffer(midi) {
    if (this.pluckCache[midi]) return this.pluckCache[midi];
    const c = this.ctx;
    const sr = c.sampleRate;
    const N = Math.max(2, Math.round(sr / mtof(midi) - 0.5));
    const len = Math.floor(sr * 1.0);
    const buf = c.createBuffer(1, len, sr);
    const y = buf.getChannelData(0);
    for (let i = 0; i < N; i++) y[i] = Math.random() * 2 - 1;
    const decay = 0.996 - Math.max(0, midi - 55) * 0.0001;
    for (let i = N; i < len; i++) y[i] = decay * 0.5 * (y[i - N] + (i - N - 1 >= 0 ? y[i - N - 1] : 0));
    let peak = 0;
    for (let i = 0; i < len; i++) {
      y[i] = Math.tanh(y[i] * 1.4);
      peak = Math.max(peak, Math.abs(y[i]));
    }
    for (let i = 0; i < len; i++) y[i] /= peak || 1;
    return (this.pluckCache[midi] = buf);
  }

  shamisen(t, midi, vol = 0.2, dur = 0.4, out = this.music) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.pluckBuffer(midi);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 220;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.setTargetAtTime(0, t + dur, 0.05);
    src.connect(hp).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.4);
  }

  taiko(t, vol = 1, out = this.music) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.28);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.65);
    this.noise(t, out, 'lowpass', 700, 0.7, vol * 0.5, 0.09);
  }

  kane(t, vol = 0.15, out = this.music) {
    const c = this.ctx;
    for (const [f, a] of [[1870, 1], [2790, 0.6], [3910, 0.35]]) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(vol * a, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.22);
    }
  }

  kachi(t, vol = 0.3, out = this.music) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1550, t);
    o.frequency.exponentialRampToValueAtTime(1250, t + 0.03);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.06);
    this.noise(t, out, 'bandpass', 2300, 9, vol * 1.6, 0.04);
  }

  crash(t, vol = 0.4, out = this.sfx) {
    this.noise(t, out, 'highpass', 5000, 0.5, vol, 1.6);
    this.noise(t, out, 'bandpass', 3200, 1.5, vol * 0.5, 0.6);
  }

  whistle(t, f0, f1, dur, vol = 0.14, out = this.sfx) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
    g.gain.setTargetAtTime(0, t + dur, 0.05);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.3);
  }

  boing(t = this.now, vol = 0.3, out = this.sfx) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.35);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.45);
  }

  drumroll(t, dur, out = this.sfx) {
    for (let x = 0; x < dur; x += 0.045) {
      const v = 0.12 + 0.5 * (x / dur);
      this.noise(t + x, out, 'bandpass', 1700, 0.9, v * 0.6, 0.06);
    }
    this.kick(t + dur, 0.8, out);
  }

  // ---------- 編曲 ----------

  // 伴奏：貝斯「蹦」、反拍和弦「恰」、弦樂鋪底、鼓組。opts.stopAt：從第幾拍起停（給喊聲留空間）
  backing(t0, harmony, out, opts = {}) {
    const B = this.B;
    const stopAt = opts.stopAt ?? harmony.length;
    for (let i = 0; i < stopAt; i++) {
      const t = t0 + i * B;
      const ch = CHORDS[harmony[i]];
      this.bass(t, i % 2 ? ch.fifth : ch.root, B * 0.42, out);
      this.stab(t0 + swing(i + 0.5) * B, ch.stab, B * 0.22, 0.026, out);
      if (i === 0 || harmony[i] !== harmony[i - 1]) {
        let n = 1;
        while (i + n < stopAt && harmony[i + n] === harmony[i]) n++;
        this.pad(t, ch.pad, n * B - 0.05, 0.012, out);
      }
      this.kick(t, i % 2 ? 0.45 : 0.65, out);
      if (i % 2) this.snare(t, 0.26, out);
      this.hat(t, 0.05, false, out);
      this.hat(t0 + swing(i + 0.5) * B, 0.07, i === stopAt - 1, out);
      if (i % 4 === 3) this.clap(t, 0.16, out);
    }
    // 祭典味：小節頭太鼓、反拍鉦
    for (let i = 0; i < stopAt; i += 2) this.taiko(t0 + i * B, 0.35, out);
    for (let i = 0; i < stopAt; i++) this.kane(t0 + swing(i + 0.5) * B, 0.045, out);
  }

  melody(t0, notes, vol = 0.085) {
    const B = this.B;
    for (const [b, m, l] of notes) {
      this.leadNote(t0 + swing(b) * B, m, l * B * 0.92, vol);
      this.shamisen(t0 + swing(b) * B, m + 12, 0.07, l * B * 0.6, this.lead); // 高八度三味線點綴
    }
  }

  // 8 拍的前奏（每回合「跳舞」的段落）
  phraseIntro(t0, out, variant = 0) {
    this.melody(t0, variant ? MELODY_B : MELODY_A);
    this.backing(t0, variant ? HARMONY_B : HARMONY_A, out);
    if (variant === 0) this.crash(t0, 0.18, out);
  }

  // 重拍大和弦（喊聲的「咚！」）
  hit(t, chord, dur, out, big = false) {
    const ch = CHORDS[chord];
    this.stab(t, ch.stab.concat(ch.stab[0] + 12), dur, big ? 0.04 : 0.032, out);
    this.bass(t, ch.root, dur, out);
    this.kick(t, big ? 0.9 : 0.7, out);
    this.taiko(t, big ? 1.1 : 0.7, out);
    if (big) {
      this.crash(t, 0.4, out);
      this.leadNote(t, ch.stab[2] + 12, dur, 0.07);
    }
  }

  // 「アウト！セーフ！よよいの よいっ！」— 回傳出拳的時間點
  phraseChant(t0, out) {
    const B = this.B;
    const at = (b) => t0 + b * B;
    this.backing(t0, ['G', 'G', 'D', 'D', 'C', 'D'], out);
    this.hit(at(0), 'G', B * 0.5, out);
    this.voice('out', at(0), 2 * B);
    this.hit(at(2), 'D', B * 0.5, out);
    this.voice('safe', at(2), 2 * B);
    this.voice('yoyoino', at(4), 2 * B);
    // 「よよいの」小鼓過門
    for (let k = 0; k < 4; k++) this.snare(at(4 + k * 0.5), 0.18 + k * 0.05, out);
    [74, 76, 78, 79].forEach((m, k) => this.leadNote(at(4 + k * 0.5), m, B * 0.4, 0.06));
    this.hit(at(6), 'G', B * 1.6, out, true);
    this.voice('yoi', at(6), 1.5 * B);
    return at(6);
  }

  // 「あいこで しょっ！」— 回傳出拳的時間點
  phraseAiko(t0, out) {
    const B = this.B;
    this.backing(t0, ['D', 'D'], out);
    this.hit(t0, 'D', B * 0.5, out);
    this.voice('aikode', t0, 2 * B);
    this.snare(t0 + 1.5 * B, 0.3, out);
    const t = t0 + 2 * B;
    this.hit(t, 'G', B * 1.6, out, true);
    this.voice('sho', t, 1.5 * B);
    return t;
  }

  // 標題畫面循環 BGM
  startLoop() {
    if (this.loopState) return;
    const bus = this.phraseBus();
    const state = { bus, next: this.now + 0.1, v: 0 };
    const tick = () => {
      while (state.next < this.now + 1) {
        this.phraseIntro(state.next, bus, state.v++ % 2);
        state.next += 8 * this.B;
      }
    };
    tick();
    state.id = setInterval(tick, 250);
    this.loopState = state;
  }

  stopLoop() {
    if (!this.loopState) return;
    clearInterval(this.loopState.id);
    this.killBus(this.loopState.bus);
    this.loopState = null;
  }

  // ---------- 短音效 ----------

  reveal(t = this.now) {
    this.kachi(t, 0.45, this.sfx);
    this.kachi(t + 0.08, 0.35, this.sfx);
  }

  // 贏一拳：銅管「噠噠噠－噹！」
  jingleWin(t = this.now) {
    const s = 0.11;
    [['G', 0], ['C', 1], ['D', 2]].forEach(([ch, k]) => this.stab(t + k * s, CHORDS[ch].stab, s * 0.8, 0.035, this.sfx));
    this.stab(t + 3 * s, [55, 59, 62, 67, 71], 0.6, 0.035, this.sfx);
    [67, 71, 74, 79].forEach((m, k) => this.leadNote(t + k * s, m, k === 3 ? 0.6 : s * 0.8, 0.07));
    this.kick(t + 3 * s, 0.8, this.sfx);
    this.crash(t + 3 * s, 0.3);
  }

  // 輸一拳：「登～登～」往下滑的嘲笑音
  jingleLose(t = this.now) {
    this.boing(t);
    this.stab(t + 0.3, CHORDS.Eb.stab, 0.18, 0.035, this.sfx);
    this.stab(t + 0.55, CHORDS.D.stab, 0.45, 0.035, this.sfx);
    this.bass(t + 0.3, 39, 0.18, this.sfx);
    this.bass(t + 0.55, 38, 0.45, this.sfx);
  }

  jingleDraw(t = this.now) {
    this.stab(t, CHORDS.D.stab, 0.1, 0.03, this.sfx);
    this.stab(t + 0.14, CHORDS.D.stab, 0.18, 0.03, this.sfx);
    this.hat(t, 0.1, false, this.sfx);
    this.hat(t + 0.14, 0.1, true, this.sfx);
  }

  // 布幕拉開：「鏘～！」＋ 慵懶的爵士薩克斯風小樂句
  stripReveal(t = this.now) {
    this.crash(t, 0.5);
    this.kick(t, 0.9, this.sfx);
    this.stab(t, [55, 59, 62, 66, 69], 0.9, 0.035, this.sfx);
    this.whistle(t + 0.05, 500, 1900, 0.5);
    const lick = [[0.7, 74, 0.22], [0.95, 73, 0.22], [1.2, 72, 0.22], [1.45, 71, 0.9]];
    for (const [d, m, l] of lick) {
      this.tone(t + d, m, l, {
        type: 'sawtooth', detunes: [-5, 5], vol: 0.07, attack: 0.03, release: 0.12,
        cutoff: 1300, envAmt: 900, q: 3, vib: 30, out: this.sfx,
      });
    }
    [[0.7, 'Em'], [1.45, 'Em']].forEach(([d, ch]) => this.bass(t + d, CHORDS[ch].root, 0.2, this.sfx));
    this.snare(t + 0.95, 0.15, this.sfx);
    this.snare(t + 1.2, 0.15, this.sfx);
  }

  fanfare(t = this.now) {
    const notes = [[0, 67, 0.15], [0.15, 67, 0.15], [0.3, 67, 0.15], [0.45, 74, 0.6], [1.1, 72, 0.15], [1.25, 74, 0.15], [1.4, 79, 1.2]];
    for (const [d, m, l] of notes) this.leadNote(t + d, m, l, 0.09);
    [[0, 'G', 0.4], [0.45, 'D', 0.6], [1.1, 'C', 0.3], [1.4, 'G', 1.2]].forEach(([d, ch, l]) => {
      this.stab(t + d, CHORDS[ch].stab, l, 0.035, this.sfx);
      this.bass(t + d, CHORDS[ch].root, l, this.sfx);
      this.kick(t + d, 0.8, this.sfx);
      this.taiko(t + d, 0.8, this.sfx);
    });
    this.crash(t + 1.4, 0.45);
    const bus = this.phraseBus();
    this.phraseIntro(t + 2.8, bus, 0);
    this.phraseIntro(t + 2.8 + 8 * this.B, bus, 1);
    return bus;
  }

  sadTrombone(t = this.now) {
    [[67, 0.45], [66, 0.45], [65, 0.45], [64, 1.6]].reduce((time, [m, l]) => {
      this.tone(time, m - 12, l * 0.92, {
        type: 'sawtooth', detunes: [-6, 6], vol: 0.12, attack: 0.05, release: 0.15,
        cutoff: 500, envAmt: 900, q: 4, vib: l > 1 ? 40 : 0, out: this.sfx,
      });
      return time + l;
    }, t);
  }
}
