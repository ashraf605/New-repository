
#!/bin/bash

echo "🚀 تثبيت Telegram Trading Bot للتشغيل المحلي"
echo "================================================"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js غير مثبت. يرجى تثبيت Node.js أولاً"
    echo "تحميل من: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js الإصدار: $(node --version)"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm غير مثبت"
    exit 1
fi

echo "✅ npm الإصدار: $(npm --version)"

# Install dependencies
echo "📦 تثبيت المكتبات المطلوبة..."
npm install

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 إنشاء ملف .env..."
    cp .env.example .env
    echo "⚠️  يرجى تعديل ملف .env وإضافة بياناتك الحقيقية"
fi

# Install PM2 globally (optional)
read -p "هل تريد تثبيت PM2 لإدارة العمليات؟ (y/n): " install_pm2
if [ "$install_pm2" = "y" ] || [ "$install_pm2" = "Y" ]; then
    echo "📦 تثبيت PM2..."
    sudo npm install -g pm2
    echo "✅ تم تثبيت PM2 بنجاح"
fi

echo ""
echo "🎉 تم الانتهاء من التثبيت!"
echo ""
echo "الخطوات التالية:"
echo "1. قم بتعديل ملف .env وإضافة بياناتك"
echo "2. شغل البوت باستخدام: npm start"
echo "3. أو استخدم PM2: npm run pm2"
echo ""
