// Discord bridge: the room in one channel.
//
// Out: each member posts through a webhook of its own (its name and avatar), system notices
// go out as small bot lines, and the owner's messages typed in the web page are mirrored.
// In: messages from the owner (discord.ownerIds) in the channel become the owner's room
// messages (text, one photo, reply target); reactions on member messages become the owner's
// reactions. Everyone else in the channel is ignored. "!" commands control the room.
//
// Webhooks can't reply natively or react as the member, so a reply starts with a quote line
// and a member's reaction is added by the bot. Room message ids <-> Discord message ids are
// kept in data/discord-map.json so replies and reactions survive a restart.
//
// discord.js is loaded only when the bridge starts (npm install), so the room still runs
// without it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AI_IDS, MEMBERS } from './members.mjs';
import { pick } from './i18n.mjs';

const MAX_LEN = 2000;
const MAP_KEEP = 3000;
const TYPING_EVERY_MS = 8000;
const SETUP_RETRY_MS = 60000;
const UNKNOWN_WEBHOOK = 10015; // Discord API error code
const SNOWFLAKE = /^\d{15,22}$/;

const T = {
  ko: {
    help: [
      '**명령어**',
      '`!on` 방 켜기 · `!off` 방 끄기 (끄면 말 걸어도 안 깨어남)',
      '`!speed slow|normal|fast` 대화 속도',
      '`!status` 방·멤버 상태',
      '`/boost @이름 할 말` 그 멤버 다음 턴을 진심모드로',
    ].join('\n'),
    on: '방을 켰어.',
    off: '방을 껐어. `!on`으로 다시 켜.',
    already: (on) => (on ? '이미 켜져 있어.' : '이미 꺼져 있어.'),
    speed: (s) => `대화 속도: ${s}`,
    badSpeed: '`!speed slow`, `!speed normal`, `!speed fast` 중 하나로 써.',
    roomState: (r) => `방: ${r.running ? '켜짐' : r.sleeping ? '잠듦' : '꺼짐'} · 속도 ${r.speed} · 자동 잠들기 ${r.autoSleepMin ? `${r.autoSleepMin}분` : '안 함'}`,
    member: (m) => `${m.name} (${m.model}${m.backend === 'go' ? ', Go API' : ''}): ${m.available ? m.status : '오프라인'} · 호출 ${m.calls}${m.backend === 'go' && (m.tokens?.in || m.tokens?.out) ? ` · 토큰 ${kTok(m.tokens.in)} 입력 / ${kTok(m.tokens.out)} 출력` : ''}${m.lastError ? ` · 마지막 오류: ${m.lastError.slice(0, 80)}` : ''}`,
    stopped: '-# 방이 꺼져 있어서 아무도 안 읽어. `!on`으로 켜.',
    fromWeb: (name) => `**${name}** (웹)`,
    oneImage: '-# 사진은 한 번에 한 장만 올라가. 첫 장만 보냈어.',
    imgFail: (e) => `사진을 못 올렸어: ${e}`,
  },
  en: {
    help: [
      '**Commands**',
      '`!on` start the room · `!off` stop it (talking won\'t wake it)',
      '`!speed slow|normal|fast` chat speed',
      '`!status` room and member status',
      '`/boost @Name message` that member\'s next turn in Boost mode',
    ].join('\n'),
    on: 'Room started.',
    off: 'Room stopped. `!on` starts it again.',
    already: (on) => (on ? 'Already running.' : 'Already stopped.'),
    speed: (s) => `Chat speed: ${s}`,
    badSpeed: 'Use `!speed slow`, `!speed normal` or `!speed fast`.',
    roomState: (r) => `Room: ${r.running ? 'running' : r.sleeping ? 'asleep' : 'stopped'} · speed ${r.speed} · auto sleep ${r.autoSleepMin ? `${r.autoSleepMin} min` : 'off'}`,
    member: (m) => `${m.name} (${m.model}${m.backend === 'go' ? ', Go API' : ''}): ${m.available ? m.status : 'offline'} · calls ${m.calls}${m.backend === 'go' && (m.tokens?.in || m.tokens?.out) ? ` · tokens ${kTok(m.tokens.in)} in / ${kTok(m.tokens.out)} out` : ''}${m.lastError ? ` · last error: ${m.lastError.slice(0, 80)}` : ''}`,
    stopped: '-# The room is stopped, so nobody is reading. `!on` starts it.',
    fromWeb: (name) => `**${name}** (web)`,
    oneImage: '-# Only one photo goes in at a time; sent the first one.',
    imgFail: (e) => `Couldn't post the photo: ${e}`,
  },
  ja: {
    help: [
      '**コマンド**',
      '`!on` ルーム開始 · `!off` 停止(話しかけても起きない)',
      '`!speed slow|normal|fast` 会話の速さ',
      '`!status` ルームとメンバーの状態',
      '`/boost @名前 メッセージ` そのメンバーの次のターンを本気モードに',
    ].join('\n'),
    on: 'ルームを開始したよ。',
    off: 'ルームを止めたよ。`!on` でまた開始。',
    already: (on) => (on ? 'もう動いてるよ。' : 'もう止まってるよ。'),
    speed: (s) => `会話の速さ: ${s}`,
    badSpeed: '`!speed slow`、`!speed normal`、`!speed fast` のどれかで。',
    roomState: (r) => `ルーム: ${r.running ? '動作中' : r.sleeping ? '睡眠中' : '停止'} · 速さ ${r.speed} · 自動スリープ ${r.autoSleepMin ? `${r.autoSleepMin}分` : 'なし'}`,
    member: (m) => `${m.name} (${m.model}${m.backend === 'go' ? ', Go API' : ''}): ${m.available ? m.status : 'オフライン'} · 呼び出し ${m.calls}${m.backend === 'go' && (m.tokens?.in || m.tokens?.out) ? ` · トークン 入力 ${kTok(m.tokens.in)} / 出力 ${kTok(m.tokens.out)}` : ''}${m.lastError ? ` · 最後のエラー: ${m.lastError.slice(0, 80)}` : ''}`,
    stopped: '-# ルームが止まってるから誰も読んでない。`!on` で開始。',
    fromWeb: (name) => `**${name}** (Web)`,
    oneImage: '-# 写真は一度に一枚だけ。最初の一枚を送ったよ。',
    imgFail: (e) => `写真を送れなかった: ${e}`,
  },
};
const tx = () => pick(T);

function kTok(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0); }

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;
// Only these count as commands; any other "!…" is ordinary chat.
const COMMAND = /^!(on|off|speed|status|help|켜기|끄기|속도|상태|도움)(\s|$)/i;

// Split text into Discord-sized pieces, preferring line breaks.
export function splitText(text, max = MAX_LEN) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

// Discord markup in an incoming message, turned into plain room text.
export function plainText(content) {
  return String(content || '')
    .replace(/<a?:(\w+):\d+>/g, ':$1:') // custom emoji
    .replace(/<@[!&]?\d+>/g, '') // user / role pings (the members aren't Discord users)
    .replace(/<#\d+>/g, '')
    .trim();
}

// SVG -> PNG with macOS Quick Look (Discord shows no SVG preview). Resolves to the PNG in a
// fresh temp folder (the caller removes the folder), or null.
function svgToPng(file) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-svg-'));
  return new Promise((resolve) => {
    execFile('qlmanage', ['-t', '-s', '1024', '-o', dir, file], { timeout: 20000 }, () => {
      const png = path.join(dir, `${path.basename(file)}.png`);
      if (fs.existsSync(png)) resolve(png);
      else { fs.rmSync(dir, { recursive: true, force: true }); resolve(null); }
    });
  });
}

export class DiscordBridge {
  // o: {root, home, cfg, store, token, nameOf(id), memberIds (members in the room),
  //     maxImageBytes, userSend({text, image, replyTo}), userReact(roomId, emoji),
  //     room: {view(), start(), stop(), speed(s)}, log(text)}
  constructor(o) {
    this.o = o;
    this.dc = o.cfg.discord;
    // Discord ids must be strings in config.json: as JSON numbers they are past 2^53 and
    // come back as a different id, so nothing would ever match.
    const bad = (v) => typeof v !== 'string' || !SNOWFLAKE.test(v);
    this.badChannel = bad(this.dc.channelId);
    const owners = Array.isArray(this.dc.ownerIds) ? this.dc.ownerIds : [];
    for (const v of owners) if (v !== '' && bad(v)) console.log(`Discord: ownerIds entry ${JSON.stringify(v)} is ignored; write the user id as a string in quotes`);
    this.owners = new Set(owners.filter((v) => !bad(v)));
    this.retryTimer = null;
    this.mapFile = path.join(o.home, 'data', 'discord-map.json');
    this.map = { r2d: {}, d2r: {} };
    try { Object.assign(this.map, JSON.parse(fs.readFileSync(this.mapFile, 'utf8'))); } catch { /* new map */ }
    this.mapTimer = null;
    this.queue = Promise.resolve();
    this.inQueue = Promise.resolve();
    this.hooks = {};
    this.pending = [];
    this.ready = false;
    this.client = null;
    this.channel = null;
    this.lastTyping = 0;
    this.lastStoppedNote = 0;
  }

  async start() {
    if (this.badChannel) {
      console.log('Discord: discord.channelId must be the channel id as a string in quotes, e.g. "1234567890123456789"');
      return;
    }
    if (!this.owners.size) console.log('Discord: discord.ownerIds is empty, so nobody in the channel can talk to the room');
    let djs;
    try {
      djs = await import('discord.js');
    } catch {
      console.log('Discord: discord.js is not installed (run "npm install" in the room folder)');
      return;
    }
    const { Client, GatewayIntentBits: I, Partials, Events } = djs;
    const client = new Client({
      intents: [I.Guilds, I.GuildMessages, I.MessageContent, I.GuildMessageReactions],
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
    this.client = client;
    // One incoming message at a time: a photo that is still downloading keeps its place
    // ahead of the text the owner sends right after it.
    client.on(Events.MessageCreate, (m) => {
      this.inQueue = this.inQueue.then(() => this.onMessage(m)).catch((e) => this.o.log(`incoming failed: ${e?.stack || e}`));
    });
    client.on(Events.MessageReactionAdd, (r, u) => this.onReaction(r, u).catch((e) => this.o.log(`reaction failed: ${e?.stack || e}`)));
    client.on(Events.Error, (e) => this.o.log(`client error: ${e?.message || e}`));
    client.once(Events.ClientReady, () => this.setup());
    try {
      await client.login(this.o.token);
    } catch (e) {
      console.log(`Discord: login failed: ${e?.message || e}`);
      this.o.log(`login failed: ${e?.message || e}`);
    }
  }

  // The channel and one webhook per member. Retried every minute until it works, e.g. when
  // the bot only got the Manage Webhooks permission after it connected.
  async setup() {
    try {
      await this.onReady();
    } catch (e) {
      console.log(`Discord: setup failed, retrying in a minute: ${e?.message || e}`);
      this.o.log(`setup failed: ${e?.stack || e}`);
      this.retryTimer = setTimeout(() => this.setup(), SETUP_RETRY_MS);
    }
  }

  async onReady() {
    const ch = await this.client.channels.fetch(this.dc.channelId);
    if (!ch || typeof ch.fetchWebhooks !== 'function') throw new Error(`channel ${this.dc.channelId} is not a server text channel the bot can see`);
    this.channel = ch;
    const existing = await ch.fetchWebhooks();
    for (const id of this.o.memberIds) this.hooks[id] = await this.hookFor(id, existing);
    this.ready = true;
    console.log(`Discord: connected as ${this.client.user.tag} in #${ch.name}`);
    this.o.log(`ready in #${ch.name} (${ch.id}), webhooks: ${Object.keys(this.hooks).join(', ')}`);
    for (const m of this.pending.splice(0)) this.onPost(m);
  }

  // The member's webhook: ours under its name if there is one, otherwise a new one.
  // existing: the channel's webhooks, if already fetched.
  async hookFor(id, existing = null) {
    const me = this.client.user.id;
    const name = MEMBERS[id].name;
    const list = existing || await this.channel.fetchWebhooks();
    const hook = list.find((w) => w.name === name && (w.owner?.id === me || w.applicationId === me));
    if (hook) return hook;
    const avatar = this.avatarOf(id);
    return this.channel.createWebhook({ name, ...(avatar ? { avatar } : {}), reason: 'AI chatroom member' });
  }

  // Discord takes png/jpg/gif avatars; setup converts the webp ones to png.
  avatarOf(id) {
    for (const f of [`${id}-128.png`, `${id}.png`]) {
      const p = path.join(this.o.root, 'public', 'avatars', f);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // ---------- out ----------

  onPost(msg) {
    if (msg.via === 'discord') return;
    if (!this.ready) {
      if (this.pending.length < 30) this.pending.push(msg);
      return;
    }
    this.enqueue(() => this.send(msg), `send #${msg.id}`);
  }

  onReact(msg, emoji) {
    if (!this.ready) return;
    this.enqueue(async () => {
      const did = this.map.r2d[msg.id];
      if (!did) return;
      const dm = await this.channel.messages.fetch(did);
      await dm.react(emoji);
    }, `react #${msg.id}`);
  }

  typing() {
    if (!this.ready || Date.now() - this.lastTyping < TYPING_EVERY_MS) return;
    this.lastTyping = Date.now();
    this.channel.sendTyping().catch(() => {});
  }

  // One Discord call at a time, so messages keep the room's order.
  enqueue(fn, what) {
    this.queue = this.queue.then(fn).catch((e) => this.o.log(`${what} failed: ${e?.message || e}`));
  }

  async send(msg) {
    const files = await this.filesFor(msg.attach);
    try {
      await this.sendWith(msg, files);
    } finally {
      // converted SVGs live in a temp folder of their own
      for (const f of files) if (f.temp) fs.rmSync(path.dirname(f.attachment), { recursive: true, force: true });
    }
  }

  async sendWith(msg, fileList) {
    const files = fileList.map(({ attachment, name }) => ({ attachment, name }));
    const bot = (p) => this.channel.send(p);
    if (AI_IDS.includes(msg.from)) {
      const id = msg.from;
      if (!this.hooks[id]) return;
      const viaHook = async (p) => {
        try {
          return await this.hooks[id].send(p);
        } catch (e) {
          // Deleted in the channel settings: make a new one and send again.
          if (e?.code !== UNKNOWN_WEBHOOK) throw e;
          this.o.log(`webhook for ${id} is gone, recreating it`);
          this.hooks[id] = await this.hookFor(id);
          return this.hooks[id].send(p);
        }
      };
      return this.postChunks(viaHook, msg.id, this.quoteFor(msg) + (msg.text || ''), files);
    }
    if (msg.from === 'system') {
      if (this.dc.systemMessages === false) return;
      return this.postChunks(bot, msg.id, String(msg.text || '').replace(/\n+/g, ' '), files, '-# ');
    }
    if (msg.from === 'user') return this.postChunks(bot, msg.id, `${tx().fromWeb(this.o.nameOf('user'))}: ${msg.text || ''}`, files);
  }

  // Text split to Discord's limit (every piece gets `prefix`), the files on the last piece;
  // the first Discord message stands for the room message.
  async postChunks(sendFn, roomId, text, files, prefix = '') {
    const chunks = splitText(text, MAX_LEN - prefix.length).map((c) => prefix + c);
    if (!chunks.length && files.length) chunks.push('');
    let first = null;
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      // members' text never pings anyone
      const sent = await sendFn({ content: chunks[i] || undefined, files: last && files.length ? files : undefined, allowedMentions: { parse: [] } });
      first ??= sent;
    }
    if (first) this.remember(roomId, first.id);
  }

  // "> ↪ Name: first line…" for a reply (webhook messages can't reply natively).
  quoteFor(msg) {
    if (!msg.replyTo) return '';
    const orig = this.o.store.byId.get(msg.replyTo);
    if (!orig) return '';
    const snippet = (orig.text || (orig.attach ? `[${path.posix.basename(orig.attach.path)}]` : '')).replace(/\s+/g, ' ').slice(0, 80);
    return `> ↪ **${this.o.nameOf(orig.from)}**: ${snippet}${(orig.text || '').length > 80 ? '…' : ''}\n`;
  }

  async filesFor(attach) {
    if (!attach?.path) return [];
    let file;
    try { file = this.o.store.abs(this.o.store.safeRel(attach.path)); } catch { return []; }
    if (!fs.existsSync(file)) return [];
    const name = path.basename(file);
    if (/\.svg$/i.test(name)) {
      const png = await svgToPng(file);
      if (png) return [{ attachment: png, name: name.replace(/\.svg$/i, '.png'), temp: true }];
    }
    return [{ attachment: file, name }];
  }

  remember(roomId, discordId) {
    this.map.r2d[roomId] = discordId;
    this.map.d2r[discordId] = roomId;
    clearTimeout(this.mapTimer);
    this.mapTimer = setTimeout(() => this.saveMap(), 2000);
  }

  saveMap() {
    const ids = Object.keys(this.map.r2d).map(Number).sort((a, b) => a - b);
    for (const rid of ids.slice(0, Math.max(0, ids.length - MAP_KEEP))) {
      delete this.map.d2r[this.map.r2d[rid]];
      delete this.map.r2d[rid];
    }
    try {
      fs.writeFileSync(`${this.mapFile}.tmp`, JSON.stringify(this.map));
      fs.renameSync(`${this.mapFile}.tmp`, this.mapFile);
    } catch (e) {
      this.o.log(`map save failed: ${e.message}`);
    }
  }

  // ---------- in ----------

  fromOwner(m) {
    return m.channelId === this.dc.channelId && !m.author?.bot && !m.webhookId && this.owners.has(m.author.id);
  }

  async onMessage(m) {
    if (!this.ready || !this.fromOwner(m)) return;
    const text = plainText(m.content);
    if (COMMAND.test(text)) return this.command(m, text);

    const images = [...m.attachments.values()].filter((a) => IMAGE_TYPES.test(a.contentType || ''));
    let image = null;
    if (images.length) {
      try {
        image = await this.download(images[0]);
      } catch (e) {
        await m.reply({ content: tx().imgFail(e.message), allowedMentions: { parse: [] } });
        if (!text) return;
      }
    }
    if (!text && !image) return;
    const replyTo = m.reference?.messageId ? this.map.d2r[m.reference.messageId] : undefined;
    const r = this.o.userSend({ text, image, replyTo });
    if (!r.ok) {
      if (r.error !== 'empty') await m.reply({ content: r.error, allowedMentions: { parse: [] } });
      return;
    }
    if (r.msg) this.remember(r.msg.id, m.id);
    if (images.length > 1) await this.channel.send({ content: tx().oneImage, allowedMentions: { parse: [] } });
    // Stopped (not asleep): nobody will answer. Say so, at most every 10 minutes.
    if (!r.running && Date.now() - this.lastStoppedNote > 600000) {
      this.lastStoppedNote = Date.now();
      await this.channel.send({ content: tx().stopped, allowedMentions: { parse: [] } });
    }
  }

  // The photo, at most maxImageBytes: the original if it fits, otherwise a copy Discord's
  // media proxy scales down.
  async download(att) {
    const max = this.o.maxImageBytes;
    const urls = att.size <= max ? [att.url] : [];
    const { width: W, height: H } = att;
    for (const side of [1568, 1024, 768]) {
      // Ask for the photo's own aspect ratio (longest side = `side`), never a square.
      const s = W && H ? Math.min(1, side / Math.max(W, H)) : 1;
      const dims = W && H ? `width=${Math.max(1, Math.round(W * s))}&height=${Math.max(1, Math.round(H * s))}` : `width=${side}`;
      urls.push(`${att.proxyURL}${att.proxyURL.includes('?') ? '&' : '?'}${dims}`);
    }
    for (const url of urls) {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length && buf.length <= max) return buf;
    }
    throw new Error(`${Math.round(att.size / 1024)}KB`);
  }

  async onReaction(reaction, user) {
    if (!this.ready || user.bot || !this.owners.has(user.id)) return;
    if (reaction.partial) reaction = await reaction.fetch();
    if (reaction.message.channelId !== this.dc.channelId) return;
    const rid = this.map.d2r[reaction.message.id];
    // Custom server emoji have no unicode form the members could read; skip them.
    if (rid && reaction.emoji?.name && !reaction.emoji.id) this.o.userReact(rid, reaction.emoji.name);
  }

  async command(m, text) {
    const [cmd, arg] = text.slice(1).trim().split(/\s+/);
    const t = tx();
    const say = (content) => m.reply({ content, allowedMentions: { parse: [] } });
    const v = this.o.room.view();
    switch (cmd.toLowerCase()) {
      case 'on':
      case '켜기':
        if (v.room.running) return say(t.already(true));
        this.o.room.start();
        return say(t.on);
      case 'off':
      case '끄기':
        if (!v.room.running && !v.room.sleeping) return say(t.already(false));
        this.o.room.stop();
        return say(t.off);
      case 'speed':
      case '속도':
        return say(this.o.room.speed(String(arg || '').toLowerCase()) ? t.speed(arg.toLowerCase()) : t.badSpeed);
      case 'status':
      case '상태':
        return say([t.roomState(v.room), ...v.members.map((x) => `- ${t.member(x)}`)].join('\n').slice(0, MAX_LEN));
      default:
        return say(t.help);
    }
  }

  close() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.mapTimer);
    this.saveMap();
    try { this.client?.destroy(); } catch { /* closing anyway */ }
  }
}
