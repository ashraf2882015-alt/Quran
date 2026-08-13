# Quran Discord Bot

بوت Discord لتشغيل القرآن في الروم الصوتي، مع اختيار السورة والقارئ والتكرار.

## الأوامر

- `/play` — اختر رقم السورة أو اسمها والقارئ.
- `/loop` — تشغيل/إيقاف التكرار.
- `/pause` — إيقاف مؤقت.
- `/resume` — استكمال.
- `/stop` — إيقاف التشغيل.
- `/leave` — إيقاف وإخراج البوت.

## ملفات الصوت

ضع الملفات محليًا بهذا الشكل، ولا ترفعها إلى GitHub إذا لم تكن لديك حقوق إعادة توزيعها:

```text
audio/
├── yasser-al-dosari/
│   ├── 001.mp3
│   ├── 002.mp3
│   └── 023.mp3
├── mishary-alafasy/
└── maher-al-mueaqly/
```

يمكنك تغيير أسماء القرّاء أو إضافة قراء في `src/index.js`.

## GitHub Secrets

في **Settings → Secrets and variables → Actions** أضف:

- `DISCORD_TOKEN` — توكن البوت.
- `CLIENT_ID` — Application ID.
- `GUILD_ID` — اختياري؛ وضعه يجعل تسجيل أوامر Slash أسرع داخل سيرفر محدد.

## تشغيل محلي

```bash
npm install
DISCORD_TOKEN="..." CLIENT_ID="..." GUILD_ID="..." npm start
```

## التشغيل المستمر على GitHub Actions

الـworkflow الموجود في `.github/workflows/quran-bot.yml` يستخدم نفس فكرة `Survival-Economy`: مراقبة عملية البوت، إعادة تشغيلها عند توقفها، وجدولة جلسة جديدة قبل انتهاء عمر GitHub-hosted runner. هذا **ليس ضمانًا رسميًا لتشغيل 24/7**؛ GitHub-hosted runners لها حدود تشغيل وقد تتغير سياساتها.
