
@echo off
echo 🚀 تثبيت Telegram Trading Bot للتشغيل المحلي
echo ================================================

:: Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js غير مثبت. يرجى تثبيت Node.js أولاً
    echo تحميل من: https://nodejs.org/
    pause
    exit /b 1
)

echo ✅ Node.js مثبت

:: Check if npm is installed
npm --version >nul 2>&1
if errorlevel 1 (
    echo ❌ npm غير مثبت
    pause
    exit /b 1
)

echo ✅ npm مثبت

:: Install dependencies
echo 📦 تثبيت المكتبات المطلوبة...
npm install

:: Create .env file if it doesn't exist
if not exist .env (
    echo 📝 إنشاء ملف .env...
    copy .env.example .env
    echo ⚠️  يرجى تعديل ملف .env وإضافة بياناتك الحقيقية
)

:: Ask about PM2 installation
set /p install_pm2="هل تريد تثبيت PM2 لإدارة العمليات؟ (y/n): "
if /i "%install_pm2%"=="y" (
    echo 📦 تثبيت PM2...
    npm install -g pm2
    echo ✅ تم تثبيت PM2 بنجاح
)

echo.
echo 🎉 تم الانتهاء من التثبيت!
echo.
echo الخطوات التالية:
echo 1. قم بتعديل ملف .env وإضافة بياناتك
echo 2. شغل البوت باستخدام: npm start
echo 3. أو استخدم PM2: npm run pm2
echo.
pause
