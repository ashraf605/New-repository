// index.js

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

// --- إعداد السيرفر (لا تغيير) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("OKX Bot is running"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- التحقق من متغيرات البيئة (لا تغيير) ---
const requiredEnv = [
  "TELEGRAM_BOT_TOKEN",
  "OKX_API_KEY",
  "OKX_API_SECRET_KEY",
  "OKX_API_PASSPHRASE",
  "AUTHORIZED_USER_ID"
];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    throw new Error(`متغير البيئة ${envVar} غير موجود. يرجى إضافته في Railway`);
  }
}

// --- إعدادات البوت والـ API (لا تغيير) ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);

// --- إدارة حالة البوت ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolio = {};
// [تعديل] إضافة متغيرات لتخزين عتبات التنبيه مع قيم افتراضية
let assetChangeThreshold = 5; // النسبة المئوية لتنبيه تغيير الأصل الواحد
let totalChangeThreshold = 10; // النسبة المئوية لتنبيه تغيير إجمالي المحفظة

// --- وظائف الـ API المحسّنة (لا تغيير في منطقها) ---
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const signString = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : "");
  const signature = crypto
    .createHmac("sha256", process.env.OKX_API_SECRET_KEY)
    .update(signString)
    .digest("base64");
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
    "x-simulated-trading": "0" 
  };
}

async function getMarketPrices(currencies) {
  if (currencies.length === 0) return {};
  try {
    const instIds = currencies.map(c => `${c}-USDT`).join(',');
    const tickersPath = `/api/v5/market/tickers?instType=SPOT&instId=${instIds}`;
    const res = await fetch(`${API_BASE_URL}${tickersPath}`);
    const data = await res.json();
    const prices = {};
    if (data.code === "0" && data.data) {
      data.data.forEach(t => prices[t.instId] = parseFloat(t.last));
    }
    return prices;
  } catch (e) {
    console.error("Error fetching market prices:", e);
    return { error: e.message };
  }
}

async function getPortfolioData() {
  try {
    const balancePath = "/api/v5/account/balance";
    const headers = getHeaders("GET", balancePath);
    const res = await fetch(`${API_BASE_URL}${balancePath}`, { headers });
    const data = await res.json();

    if (data.code !== "0") {
        const errorMessage = data.msg || `OKX API Error Code: ${data.code}`;
        return { assets: null, totalUsd: 0, error: errorMessage };
    }
    
    const ownedCurrencies = data.data[0].details
      .filter(asset => parseFloat(asset.eq) > 0 && asset.ccy !== 'USDT')
      .map(asset => asset.ccy);

    const prices = await getMarketPrices(ownedCurrencies);
    if (prices.error) return { assets: null, totalUsd: 0, error: `فشل جلب الأسعار: ${prices.error}` };

    const portfolio = [];
    data.data[0].details.forEach(asset => {
      const amount = parseFloat(asset.eq);
      if (amount > 0.000001) { 
        const price = prices[`${asset.ccy}-USDT`] || (asset.ccy === "USDT" ? 1 : 0);
        const usdValue = amount * price;
        
        if (usdValue >= 1) {
          portfolio.push({ asset: asset.ccy, amount, usdValue, frozen: parseFloat(asset.frozenBal) });
        }
      }
    });

    const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
    if (totalUsd > 0) {
        portfolio.forEach(a => a.percentage = ((a.usdValue / totalUsd) * 100).toFixed(2));
    }
    portfolio.sort((a, b) => b.usdValue - a.usdValue);

    return { assets: portfolio, totalUsd, error: null };
  } catch (e) {
    console.error("Error fetching portfolio:", e);
    return { assets: null, totalUsd: 0, error: e.message };
  }
}

// --- وسيط التحقق من المستخدم (لا تغيير) ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) {
    return ctx.reply("🚫 غير مصرح لك باستخدام هذا البوت.");
  }
  await next();
});

// --- وظائف البوت الأساسية ---
async function showBalance(ctx) {
  // ... (لا تغيير في هذه الوظيفة)
}

// --- [تعديل] منطق المراقبة الآن يستخدم المتغيرات المخصصة ---
async function checkPortfolioAndNotify(ctx) {
    const currentPortfolio = await getPortfolioData();
    if (currentPortfolio.error) {
        return ctx.reply(`⚠️ فشلت دورة المراقبة: ${currentPortfolio.error}`);
    }
    if (!currentPortfolio.assets || !previousPortfolio.assets) {
        previousPortfolio = currentPortfolio;
        return;
    }

    const changes = [];
    const totalChangePercentage = previousPortfolio.totalUsd > 0
        ? Math.abs(((currentPortfolio.totalUsd - previousPortfolio.totalUsd) / previousPortfolio.totalUsd) * 100)
        : 0;

    currentPortfolio.assets.forEach(curr => {
        const prev = previousPortfolio.assets.find(a => a.asset === curr.asset);
        if (!prev) {
            changes.push(`🟢 *شراء جديد:* ${curr.asset} (يشكل الآن ${curr.percentage}%)`);
        } else {
            const percentageChange = Math.abs(parseFloat(curr.percentage) - parseFloat(prev.percentage));
            // استخدام المتغير المخصص بدلاً من القيمة الثابتة
            if (percentageChange >= assetChangeThreshold) { 
                const direction = curr.percentage > prev.percentage ? '📈' : '📉';
                changes.push(`${direction} *${curr.asset}*: الآن ${curr.percentage}% (كان ${prev.percentage}%)`);
            }
        }
    });

    previousPortfolio.assets.forEach(prev => {
        if (!currentPortfolio.assets.find(a => a.asset === prev.asset)) {
            changes.push(`🔴 *بيع كامل:* ${prev.asset} (كان يشكل ${prev.percentage}%)`);
        }
    });
    
    // استخدام المتغير المخصص بدلاً من القيمة الثابتة
    if (changes.length > 0 || totalChangePercentage >= totalChangeThreshold) {
        let msg = `🔔 *تنبيه بتغيرات المحفظة*\n💰 *الإجمالي الحالي:* $${currentPortfolio.totalUsd.toFixed(2)}\n`;
        msg += `💰 *الإجمالي السابق:* $${previousPortfolio.totalUsd.toFixed(2)}\n\n`;
        msg += changes.join("\n");
        ctx.reply(msg, { parse_mode: "Markdown" });
    }
    previousPortfolio = currentPortfolio;
}

async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");
  isMonitoring = true;
  // [تعديل] إعلام المستخدم بالعتبات الحالية عند بدء المراقبة
  await ctx.reply(`✅ بدأت المراقبة.\n- تنبيه تغيير الأصل: *${assetChangeThreshold}%*\n- تنبيه تغيير الإجمالي: *${totalChangeThreshold}%*`, { parse_mode: "Markdown" });
  
  previousPortfolio = await getPortfolioData();
  if (previousPortfolio.error) {
      isMonitoring = false;
      return ctx.reply(`❌ فشل بدء المراقبة: ${previousPortfolio.error}`);
  }

  monitoringInterval = setInterval(() => checkPortfolioAndNotify(ctx), 15000);
}

async function stopMonitoring(ctx) {
  // ... (لا تغيير في هذه الوظيفة)
}

// --- إعداد أوامر البوت والقائمة ---
const menu = new InlineKeyboard()
  .text("💰 عرض الرصيد", "show_balance").row()
  .text("👁️ بدء المراقبة", "start_monitoring").row()
  .text("🛑 إيقاف المراقبة", "stop_monitoring");

bot.command("start", ctx =>
  ctx.reply("أهلاً بك! اختر أمراً من القائمة أو استخدم `/set_thresholds` لتغيير عتبات التنبيه.", { reply_markup: menu })
);

// [تعديل] إضافة الأمر الجديد لتخصيص عتبات التنبيه
bot.command("set_thresholds", async (ctx) => {
    // استخراج الأرقام من الرسالة
    const args = ctx.message.text.split(' ').slice(1);
    const newAssetThreshold = parseFloat(args[0]);
    const newTotalThreshold = parseFloat(args[1]);

    // التحقق من صحة المدخلات
    if (isNaN(newAssetThreshold) || isNaN(newTotalThreshold) || newAssetThreshold <= 0 || newTotalThreshold <= 0) {
        return ctx.reply("❌ صيغة خاطئة. يرجى استخدام:\n`/set_thresholds <asset_%> <total_%>`\n\n*مثال:* `/set_thresholds 2 5`");
    }

    assetChangeThreshold = newAssetThreshold;
    totalChangeThreshold = newTotalThreshold;

    await ctx.reply(`✅ تم تحديث عتبات التنبيه بنجاح:\n- تنبيه تغيير الأصل: *${assetChangeThreshold}%*\n- تنبيه تغيير الإجمالي: *${totalChangeThreshold}%*`, { parse_mode: "Markdown" });
});


bot.on("callback_query:data", async (ctx) => {
  // ... (لا تغيير في هذه الوظيفة)
});

bot.catch((err) => console.error("Error in bot:", err));
bot.start();

console.log("Bot started successfully with customizable thresholds!");

