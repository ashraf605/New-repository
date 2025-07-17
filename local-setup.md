# دليل التشغيل المحلي للبوت

## متطلبات النظام
- Node.js (الإصدار 16 أو أحدث)
- npm أو yarn

## خطوات التشغيل

### 1. تحميل المشروع
```bash
git clone [رابط_المشروع] telegram-trading-bot
cd telegram-trading-bot
```

### 2. تثبيت المكتبات
```bash
npm install
```

### 3. إعداد متغيرات البيئة
انسخ ملف `.env.example` إلى `.env`:
```bash
cp .env.example .env
```

ثم قم بتعديل الملف `.env` وإضافة بياناتك الحقيقية:
```
TELEGRAM_BOT_TOKEN=YOUR_ACTUAL_BOT_TOKEN
OKX_PROJECT_ID=YOUR_PROJECT_ID
OKX_API_KEY=YOUR_API_KEY
OKX_API_SECRET_KEY=YOUR_SECRET_KEY
OKX_API_PASSPHRASE=YOUR_PASSPHRASE
ENCRYPTION_KEY=YOUR_32_BYTE_HEX_KEY
```

### 4. تشغيل البوت
```bash
npm start
```

أو

```bash
node index.js
```

### 5. للتشغيل في الخلفية (Linux/Mac)
```bash
nohup node index.js &
```

### 6. للتشغيل مع إعادة التشغيل التلقائي
قم بتثبيت PM2:
```bash
npm install -g pm2
```

ثم قم بتشغيل البوت:
```bash
pm2 start index.js --name "telegram-bot"
pm2 save
pm2 startup
```

## الملاحظات المهمة
- تأكد من أن جهازك متصل بالإنترنت باستمرار
- احتفظ بنسخة احتياطية من مفاتيح API
- راقب سجلات الأخطاء في ملف `logs/` إذا تم إنشاؤه