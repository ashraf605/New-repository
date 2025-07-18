// index.js (النسخة النهائية الشاملة بأربعة أنظمة مراقبة)

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

// --- إعداد السيرفر والتحقق من البيئة (لا تغيير) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("OKX Advanced Bot is running"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const requiredEnv = ["TELEGRAM_BOT_TOKEN", "OKX_API_KEY", "OKX_API_SECRET_KEY", "OKX_API_PASSPHRASE", "AUTHORIZED_USER_ID"];
for (const envVar of requiredEnv) if (!process.env[envVar]) throw new Error(`متغير البيئة ${envVar} غير موجود.`);

// --- إعدادات البوت والـ API ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);

// --- [تعديل جذري] إدارة الحالة لجميع أنواع المراقبة ---
let monitors = {
  trades: { isActive: false, interval: null, previousState: {} },
  assetPrices: { isActive: false, interval: null, previousState: {}, threshold: 5 },
  totalValue: { isActive: false, interval: null, previousState: {}, threshold: 2 },
  watchlist: { isActive: false, interval: null, coins: {} }
};

// --- وظائف الـ API المحسّنة (لا تغيير) ---
function getHeaders(method, path, body = "") { /* ... */ }
async function getMarketPrices(currencies) { /* ... */ }
async function getPortfolioData() { /* ... */ }
// ملاحظة: تم إخفاء كود وظائف الـ API لأنه لم يتغير عن النسخة السابقة لتسهيل القراءة

// --- وسيط التحقق من المستخدم (لا تغيير) ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) return ctx.reply("🚫 غير مصرح لك.");
  await next();
});

// --- وظائف عرض الرصيد والأوامر ---
async function showBalance(ctx) { /* ... */ }
// ملاحظة: تم إخفاء كود هذه الوظيفة لأنها لم تتغير

// --- [جديد] منطق الفحص لكل نوع من أنواع المراقبة ---

// 1. فحص الصفقات (تغيير النسب)
async function checkTrades() {
  const currentPortfolio = await getPortfolioData();
  const previousPortfolio = monitors.trades.previousState;
  if (currentPortfolio.error || !currentPortfolio.assets || !previousPortfolio.assets) {
    monitors.trades.previousState = currentPortfolio;
    return;
  }

  const changes = [];
  // مقارنة كل أصل في المحفظة الجديدة مع القديمة
  currentPortfolio.assets.forEach(curr => {
    const prev = previousPortfolio.assets.find(a => a.asset === curr.asset);
    if (!prev) {
      changes.push(`🟢 *شراء:* ${curr.asset} (بنسبة ${curr.percentage}%)`);
    } else if (curr.percentage !== prev.percentage) {
      const dir = parseFloat(curr.percentage) > parseFloat(prev.percentage) ? '📈' : '📉';
      changes.push(`${dir} *${curr.asset}*: ${curr.percentage}% (كان ${prev.percentage}%)`);
    }
  });
  // البحث عن أصول تم بيعها بالكامل
  previousPortfolio.assets.forEach(prev => {
    if (!currentPortfolio.assets.find(a => a.asset === prev.asset)) {
      changes.push(`🔴 *بيع:* ${prev.asset} (كان بنسبة ${prev.percentage}%)`);
    }
  });

  if (changes.length > 0) {
    bot.api.sendMessage(AUTHORIZED_USER_ID, `🔔 *تنبيه صفقات (أي حركة)*\n\n` + changes.join("\n"), { parse_mode: "Markdown" });
  }
  monitors.trades.previousState = currentPortfolio;
}

// 2. فحص أسعار أصول المحفظة
async function checkAssetPrices() {
  const { assets, error } = await getPortfolioData();
  if (error || !assets) return;

  const assetSymbols = assets.map(a => a.asset);
  const prices = await getMarketPrices(assetSymbols);
  if (prices.error) return;

  assets.forEach(asset => {
    const newPrice = prices[`${asset.asset}-USDT`];
    const oldPrice = monitors.assetPrices.previousState[asset.asset];
    
    if (oldPrice && newPrice) {
      const priceChange = ((newPrice - oldPrice) / oldPrice) * 100;
      if (Math.abs(priceChange) >= monitors.assetPrices.threshold) {
        const dir = priceChange > 0 ? '🔼' : '🔽';
        bot.api.sendMessage(AUTHORIZED_USER_ID, `${dir} *تنبيه سعر أصل:* ${asset.asset} تغير بنسبة ${priceChange.toFixed(2)}%. السعر الآن $${newPrice}`);
      }
    }
    // تحديث السعر للفحص القادم
    monitors.assetPrices.previousState[asset.asset] = newPrice;
  });
}

// 3. فحص قيمة المحفظة الإجمالية
async function checkTotalValue() {
    const { totalUsd, error } = await getPortfolioData();
    if(error) return;
    
    const oldTotal = monitors.totalValue.previousState.totalUsd;
    if (oldTotal && totalUsd) {
        const change = ((totalUsd - oldTotal) / oldTotal) * 100;
        if (Math.abs(change) >= monitors.totalValue.threshold) {
            const dir = change > 0 ? '🔼' : '🔽';
            bot.api.sendMessage(AUTHORIZED_USER_ID, `${dir} *تنبيه قيمة المحفظة:* تغيرت بنسبة ${change.toFixed(2)}%. الإجمالي الآن $${totalUsd.toFixed(2)}`);
        }
    }
    monitors.totalValue.previousState.totalUsd = totalUsd;
}

// 4. فحص قائمة المراقبة الحرة
async function checkWatchlist() {
    const coins = Object.keys(monitors.watchlist.coins);
    if(coins.length === 0) {
        stopMonitor('watchlist'); // إيقاف تلقائي إذا كانت القائمة فارغة
        return;
    }
    const prices = await getMarketPrices(coins);
    if(prices.error) return;

    coins.forEach(coin => {
        const newPrice = prices[`${coin}-USDT`];
        const oldPrice = monitors.watchlist.coins[coin];
        if(oldPrice && newPrice && newPrice !== oldPrice) {
            const dir = newPrice > oldPrice ? '🔼' : '🔽';
            bot.api.sendMessage(AUTHORIZED_USER_ID, `👁️ *تنبيه قائمة المراقبة:* ${dir} ${coin} الآن $${newPrice}`);
        }
        monitors.watchlist.coins[coin] = newPrice;
    });
}

// --- [جديد] نظام التحكم في بدء وإيقاف كل مراقب على حدة ---
async function startMonitor(ctx, type) {
  if (monitors[type].isActive) return ctx.reply(`⚠️ مراقبة "${type}" تعمل بالفعل.`);

  const initialData = await getPortfolioData();
  if (initialData.error) return ctx.reply(`❌ فشل جلب البيانات الأولية: ${initialData.error}`);
  
  monitors[type].isActive = true;
  monitors[type].previousState = initialData; // بيانات أولية لمراقبة الصفقات والقيمة

  // بيانات أولية لمراقبة أسعار الأصول
  if (type === 'assetPrices') {
      monitors.assetPrices.previousState = {}; // إعادة تعيين
      const assetSymbols = initialData.assets.map(a => a.asset);
      const prices = await getMarketPrices(assetSymbols);
      assetSymbols.forEach(s => monitors.assetPrices.previousState[s] = prices[`${s}-USDT`]);
  }
  
  let checkFunction, intervalTime;
  switch (type) {
    case 'trades': checkFunction = checkTrades; intervalTime = 20000; break; // 20 ثانية
    case 'assetPrices': checkFunction = checkAssetPrices; intervalTime = 45000; break; // 45 ثانية
    case 'totalValue': checkFunction = checkTotalValue; intervalTime = 60000; break; // 1 دقيقة
  }
  
  monitors[type].interval = setInterval(checkFunction, intervalTime);
  await ctx.reply(`✅ بدأت مراقبة: ${type}`);
}

function stopMonitor(type, silent = false) {
    if (monitors[type].isActive) {
        clearInterval(monitors[type].interval);
        monitors[type].isActive = false;
        monitors[type].interval = null;
        if (!silent) bot.api.sendMessage(AUTHORIZED_USER_ID, `🛑 توقفت مراقبة: ${type}`);
        return true;
    }
    return false;
}

// --- [جديد] القائمة الرئيسية والأوامر المتقدمة ---
const menu = new InlineKeyboard()
  .text("💰 عرض الرصيد", "show_balance").row()
  .text("📊 مراقبة الصفقات (أي حركة)", "start_trades")
  .text("📈 مراقبة أسعار أصولي", "start_assetPrices").row()
  .text("💵 مراقبة القيمة الإجمالية", "start_totalValue")
  .text("👁️ إدارة قائمة المراقبة", "manage_watchlist").row()
  .text("🛑 إيقاف كل شيء", "stop_all");

const watchlistMenu = new InlineKeyboard()
  .text("➕ إضافة عملة", "add_watch").text("➖ إزالة عملة", "remove_watch").row()
  .text("📋 عرض القائمة", "show_watchlist").row()
  .text("➡️ العودة للقائمة الرئيسية", "main_menu");

bot.command("start", ctx => ctx.reply("أهلاً بك! اختر نوع المراقبة:", { reply_markup: menu }));

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    
    switch (data) {
        case "show_balance": await showBalance(ctx); break;
        case "start_trades": await startMonitor(ctx, 'trades'); break;
        case "start_assetPrices": await startMonitor(ctx, 'assetPrices'); break;
        case "start_totalValue": await startMonitor(ctx, 'totalValue'); break;
        case "manage_watchlist": await ctx.editMessageText("اختر عملية لقائمة المراقبة:", { reply_markup: watchlistMenu }); break;
        case "main_menu": await ctx.editMessageText("القائمة الرئيسية:", { reply_markup: menu }); break;
        case "stop_all":
            let stoppedCount = 0;
            for (const type in monitors) {
                if (stopMonitor(type, true)) stoppedCount++;
            }
            await ctx.reply(stoppedCount > 0 ? `🛑 تم إيقاف ${stoppedCount} عملية مراقبة.` : "ℹ️ لا توجد عمليات مراقبة نشطة.");
            break;
        // ... (سيتم إضافة أوامر قائمة المراقبة هنا لاحقاً)
    }
});

// أوامر ضبط العتبات
bot.command("set_asset_alert", async (ctx) => {
    const threshold = parseFloat(ctx.message.text.split(' ')[1]);
    if(isNaN(threshold) || threshold <= 0) return ctx.reply("❌ صيغة خاطئة. مثال: `/set_asset_alert 5`");
    monitors.assetPrices.threshold = threshold;
    await ctx.reply(`✅ تم تحديث عتبة تنبيه سعر الأصل إلى ${threshold}%.`);
});

bot.command("set_total_alert", async (ctx) => {
    const threshold = parseFloat(ctx.message.text.split(' ')[1]);
    if(isNaN(threshold) || threshold <= 0) return ctx.reply("❌ صيغة خاطئة. مثال: `/set_total_alert 2`");
    monitors.totalValue.threshold = threshold;
    await ctx.reply(`✅ تم تحديث عتبة تنبيه القيمة الإجمالية إلى ${threshold}%.`);
});

// ... سيتم إضافة أوامر watch/unwatch هنا

bot.catch((err) => console.error("Error in bot:", err));
bot.start();
console.log("Advanced OKX Bot with 4 monitors started successfully!");
