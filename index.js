// index.js

// --- المكتبات ---
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const express = require("express");
require('dotenv').config();

// --- تحقق من المتغيرات ---
const requiredEnv = [
    "TELEGRAM_BOT_TOKEN",
    "OKX_API_KEY",
    "OKX_API_SECRET_KEY",
    "OKX_API_PASSPHRASE",
    "AUTHORIZED_USER_ID"
];
for (const envVar of requiredEnv) {
    if (!process.env[envVar]) {
        throw new Error(`خطأ: متغير البيئة ${envVar} غير موجود.`);
    }
}

// --- إعداد البوت ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);

// --- المراقبة ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolio = { assets: [], totalUsd: 0 };

// --- دوال مساعدة ---
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
    };
}

async function getMarketPrices() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const data = await res.json();
        const prices = {};
        if (data.code === "0" && data.data) {
            data.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        }
        return prices;
    } catch (e) {
        console.error("Error fetching market prices:", e);
        return {};
    }
}

async function getPortfolioData() {
    try {
        const balancePath = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${balancePath}`, { headers: getHeaders("GET", balancePath) });
        const data = await res.json();

        if (data.code !== "0") return { assets: null, totalUsd: 0 };

        const prices = await getMarketPrices();
        let portfolio = [];
        const details = data.data[0].details;

        if (details) {
            details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) {
                    const price = prices[`${asset.ccy}-USDT`] || (asset.ccy === "USDT" ? 1 : 0);
                    const usdValue = amount * price;
                    if (usdValue >= 1.0) {
                        portfolio.push({
                            asset: asset.ccy,
                            usdValue: usdValue
                        });
                    }
                }
            });
        }

        const totalPortfolioUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
        portfolio.forEach(a => a.percentage = (a.usdValue / totalPortfolioUsd) * 100);
        portfolio.sort((a, b) => b.usdValue - a.usdValue);

        return { assets: portfolio, totalUsd: totalPortfolioUsd };
    } catch (e) {
        console.error("Error fetching portfolio:", e);
        return { assets: null, totalUsd: 0 };
    }
}

// --- نظام الأمان ---
bot.use(async (ctx, next) => {
    if (ctx.from?.id !== AUTHORIZED_USER_ID) {
        if (ctx.message) await ctx.reply("🚫 غير مصرح لك.");
        else if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "🚫 غير مصرح." });
        return;
    }
    await next();
});

// --- عرض الرصيد ---
async function showBalance(ctx) {
    const { assets, totalUsd } = await getPortfolioData();
    if (!assets) return ctx.reply("🔴 خطأ في جلب الرصيد.");

    let message = `📊 *ملخص المحفظة*\n💰 *إجمالي القيمة: $${totalUsd.toFixed(2)}*\n\nالتوزيع الحالي:\n`;
    assets.forEach(a => {
        message += `- ${a.asset}: ${a.percentage.toFixed(2)}%\n`;
    });

    const now = new Date().toLocaleTimeString('en-GB');
    message += `\n_🕐 آخر تحديث: ${now}_`;

    await ctx.reply(message, { parse_mode: "Markdown" });
}

// --- المراقبة ---
async function startMonitoring(ctx) {
    if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");

    isMonitoring = true;
    await ctx.reply("✅ تم بدء المراقبة.");

    previousPortfolio = await getPortfolioData();
    if (!previousPortfolio.assets) return ctx.reply("🔴 خطأ في جلب المحفظة.");

    monitoringInterval = setInterval(async () => {
        const currentPortfolio = await getPortfolioData();
        if (!currentPortfolio.assets) return;

        let changes = [];
        const prevMap = {};
        previousPortfolio.assets.forEach(a => prevMap[a.asset] = a.percentage);

        currentPortfolio.assets.forEach(a => {
            const prevPercent = prevMap[a.asset] || 0;
            const diff = a.percentage - prevPercent;
            if (Math.abs(diff) >= 1) {
                if (diff > 0) changes.push(`📈 اشترى ${a.asset} بنسبة +${diff.toFixed(2)}%`);
                else changes.push(`📉 باع ${a.asset} بنسبة ${diff.toFixed(2)}%`);
            }
        });

        // حساب التغير في الإجمالي
        const totalDiff = currentPortfolio.totalUsd - previousPortfolio.totalUsd;
        const totalDiffPercent = (totalDiff / previousPortfolio.totalUsd) * 100;
        let totalChangeMsg = "";
        if (Math.abs(totalDiffPercent) >= 0.1) {
            if (totalDiff > 0) totalChangeMsg = `\n\n💰 *التغير في الإجمالي: +$${totalDiff.toFixed(2)} (+${totalDiffPercent.toFixed(2)}%)*`;
            else totalChangeMsg = `\n\n💰 *التغير في الإجمالي: -$${Math.abs(totalDiff).toFixed(2)} (${totalDiffPercent.toFixed(2)}%)*`;
        }

        if (changes.length > 0 || totalChangeMsg) {
            let message = `📊 *تحديث جديد للمحفظة*\n\n${changes.join("\n")}${totalChangeMsg}\n\nالاجمالي:\n`;
            currentPortfolio.assets.forEach(a => {
                message += `- ${a.asset}: ${a.percentage.toFixed(2)}%\n`;
            });
            await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
        }

        previousPortfolio = currentPortfolio;
    }, 20000);
}

async function stopMonitoring(ctx) {
    if (!isMonitoring) return ctx.reply("ℹ️ المراقبة لا تعمل.");
    isMonitoring = false;
    clearInterval(monitoringInterval);
    await ctx.reply("🛑 تم إيقاف المراقبة.");
}

// --- الأوامر ---
const mainMenu = new InlineKeyboard()
    .text("💰 عرض الرصيد", "show_balance").row()
    .text("👁️ بدء المراقبة", "start_monitoring").row()
    .text("🛑 إيقاف المراقبة", "stop_monitoring");

bot.command("start", (ctx) =>
    ctx.reply("📊 *بوت مراقبة OKX*\nاختر:", { reply_markup: mainMenu, parse_mode: "Markdown" })
);
bot.command("balance", showBalance);
bot.command("monitor", startMonitoring);
bot.command("stop_monitor", stopMonitoring);

bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.callbackQuery.data === "show_balance") await showBalance(ctx);
    if (ctx.callbackQuery.data === "start_monitoring") await startMonitoring(ctx);
    if (ctx.callbackQuery.data === "stop_monitoring") await stopMonitoring(ctx);
});

// --- Keep-Alive لـ Railway ---
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(process.env.PORT || 3000, () => console.log("Keep-Alive active"));

setInterval(() => {
    fetch("https://YOUR_APP_URL.railway.app")
        .then(() => console.log("Keep-Alive ping"))
        .catch(() => console.log("Ping failed"));
}, 5 * 60 * 1000);

// --- تشغيل البوت ---
bot.catch(err => console.error("Bot error:", err));
bot.start();