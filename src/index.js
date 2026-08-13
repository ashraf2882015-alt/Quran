const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('node:child_process');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || '';

if (!TOKEN || !CLIENT_ID) {
  throw new Error('Missing DISCORD_TOKEN or CLIENT_ID secret/environment variable.');
}

const SURAHES = [
  'الفاتحة','البقرة','آل عمران','النساء','المائدة','الأنعام','الأعراف','الأنفال','التوبة','يونس','هود','يوسف','الرعد','إبراهيم','الحجر','النحل','الإسراء','الكهف','مريم','طه','الأنبياء','الحج','المؤمنون','النور','الفرقان','الشعراء','النمل','القصص','العنكبوت','الروم','لقمان','السجدة','الأحزاب','سبأ','فاطر','يس','الصافات','ص','الزمر','غافر','فصلت','الشورى','الزخرف','الدخان','الجاثية','الأحقاف','محمد','الفتح','الحجرات','ق','الذاريات','الطور','النجم','القمر','الرحمن','الواقعة','الحديد','المجادلة','الحشر','الممتحنة','الصف','الجمعة','المنافقون','التغابن','الطلاق','التحريم','الملك','القلم','الحاقة','المعارج','نوح','الجن','المزمل','المدثر','القيامة','الإنسان','المرسلات','النبأ','النازعات','عبس','التكوير','الانفطار','المطففين','الانشقاق','البروج','الطارق','الأعلى','الغاشية','الفجر','البلد','الشمس','الليل','الضحى','الشرح','التين','العلق','القدر','البينة','الزلزلة','العاديات','القارعة','التكاثر','العصر','الهمزة','الفيل','قريش','الماعون','الكوثر','الكافرون','النصر','المسد','الإخلاص','الفلق','الناس'
];

// Reciter IDs are from QuranAPI's public audio-recitation endpoint.
const RECITERS = {
  'مشاري العفاسي': 1,
  'أبو بكر الشاطري': 2,
  'ناصر القطامي': 3,
  'ياسر الدوسري': 4,
  'هاني الرفاعي': 5,
};

const sessions = new Map();
const audioCache = new Map();

function normalizeSurah(input) {
  const raw = String(input || '').trim();
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 114) return n;
  const index = SURAHES.indexOf(raw);
  return index >= 0 ? index + 1 : null;
}

async function getAudioUrl(surah, reciter) {
  const reciterId = RECITERS[reciter];
  if (!reciterId) return null;

  const key = `${surah}:${reciterId}`;
  if (audioCache.has(key)) return audioCache.get(key);

  const response = await fetch(`https://quranapi.pages.dev/api/audio/${surah}.json`);
  if (!response.ok) throw new Error(`QuranAPI returned HTTP ${response.status}`);

  const data = await response.json();
  const entry = data[String(reciterId)];
  if (!entry) return null;

  // Prefer the public mirrored URL. Fall back to the original audio URL.
  const url = entry.url || entry.originalUrl;
  if (!url) return null;

  audioCache.set(key, url);
  return url;
}

async function playAudio(session) {
  const url = await getAudioUrl(session.surah, session.reciter);
  if (!url) throw new Error(`Audio not available for ${session.reciter} / ${session.surah}.`);

  try { session.ffmpeg?.kill('SIGKILL'); } catch {}

  // Stream the remote chapter through ffmpeg instead of storing MP3 files in GitHub.
  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-reconnect', '1',
    '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.stderr.on('data', data => console.error(`[ffmpeg] ${data}`));
  ff.on('error', err => console.error('ffmpeg error:', err));
  ff.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`ffmpeg exited with code ${code}`);
    if (signal) console.log(`ffmpeg stopped with ${signal}`);
  });

  const resource = createAudioResource(ff.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: false,
  });

  session.ffmpeg = ff;
  session.player.play(resource);
}

function stopSession(guildId) {
  const s = sessions.get(guildId);
  if (!s) return;
  try { s.ffmpeg?.kill('SIGKILL'); } catch {}
  try { s.player.stop(true); } catch {}
  try { s.connection.destroy(); } catch {}
  sessions.delete(guildId);
}

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('تشغيل سورة من القارئ المختار')
    .addStringOption(o => o.setName('surah').setDescription('رقم السورة أو اسمها').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('reciter').setDescription('القارئ').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('loop').setDescription('تفعيل/تعطيل تكرار السورة الحالية'),
  new SlashCommandBuilder().setName('pause').setDescription('إيقاف مؤقت'),
  new SlashCommandBuilder().setName('resume').setDescription('استكمال التشغيل'),
  new SlashCommandBuilder().setName('stop').setDescription('إيقاف السورة'),
  new SlashCommandBuilder().setName('leave').setDescription('إخراج البوت من الروم الصوتي')
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Registered slash commands${GUILD_ID ? ` for guild ${GUILD_ID}` : ''}.`);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'surah') {
        const q = String(focused.value).toLowerCase();
        const choices = SURAHES.map((name, i) => ({ name: `${i + 1}. ${name}`, value: String(i + 1) }))
          .filter(x => x.name.toLowerCase().includes(q) || x.value === q).slice(0, 25);
        return interaction.respond(choices);
      }
      if (focused.name === 'reciter') {
        const q = String(focused.value).toLowerCase();
        return interaction.respond(Object.keys(RECITERS)
          .filter(name => name.toLowerCase().includes(q)).slice(0, 25)
          .map(name => ({ name, value: name })));
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: 'الأمر يعمل داخل السيرفر فقط.', ephemeral: true });

    if (interaction.commandName === 'play') {
      const member = await guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel;
      if (!channel) return interaction.reply({ content: 'ادخل روم صوتي أولًا.', ephemeral: true });

      const surah = normalizeSurah(interaction.options.getString('surah'));
      const reciter = interaction.options.getString('reciter');
      if (!surah || !RECITERS[reciter]) return interaction.reply({ content: 'السورة أو القارئ غير صحيح.', ephemeral: true });

      await interaction.deferReply();
      const url = await getAudioUrl(surah, reciter);
      if (!url) return interaction.editReply('التلاوة غير متاحة لهذا القارئ حاليًا.');

      stopSession(guild.id);
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      const session = { connection, player, surah, reciter, loop: false, ffmpeg: null };
      sessions.set(guild.id, session);
      connection.subscribe(player);

      player.on(AudioPlayerStatus.Idle, async () => {
        if (session.loop && sessions.get(guild.id) === session) {
          try { await playAudio(session); } catch (e) { console.error('Loop playback error:', e); }
        }
      });

      connection.on('error', err => console.error('Voice connection error:', err));
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (sessions.get(guild.id) !== session) return;
        try {
          await entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
          await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        } catch {
          console.error('Voice connection could not recover.');
        }
      });

      await playAudio(session);
      return interaction.editReply(`▶️ شغلت **${SURAHES[surah - 1]}** بصوت **${reciter}**.`);
    }

    const s = sessions.get(guild.id);
    if (interaction.commandName === 'loop') {
      if (!s) return interaction.reply({ content: 'لا يوجد تشغيل حالي.', ephemeral: true });
      s.loop = !s.loop;
      return interaction.reply(s.loop ? '🔁 التكرار **مفعّل**.' : '🔂 التكرار **متوقف**.');
    }
    if (!s) return interaction.reply({ content: 'لا يوجد تشغيل حالي.', ephemeral: true });
    if (interaction.commandName === 'pause') { s.player.pause(); return interaction.reply('⏸️ تم الإيقاف المؤقت.'); }
    if (interaction.commandName === 'resume') { s.player.unpause(); return interaction.reply('▶️ تم الاستكمال.'); }
    if (interaction.commandName === 'stop' || interaction.commandName === 'leave') {
      stopSession(guild.id);
      return interaction.reply('⏹️ تم إيقاف التشغيل.');
    }
  } catch (error) {
    console.error(error);
    if (interaction.deferred) await interaction.editReply('حدث خطأ أثناء تشغيل التلاوة.');
    else if (!interaction.replied) await interaction.reply({ content: 'حدث خطأ أثناء تنفيذ الأمر.', ephemeral: true });
  }
});

process.on('SIGTERM', () => { for (const id of sessions.keys()) stopSession(id); client.destroy(); process.exit(0); });
process.on('SIGINT', () => { for (const id of sessions.keys()) stopSession(id); client.destroy(); process.exit(0); });

client.login(TOKEN);
