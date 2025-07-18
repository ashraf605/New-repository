// index.js

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("OKX Bot is running");
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);

let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolio = {};

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
    "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE
  };
}

async function getMarketPrices() {
  try {
    const tickersPath = "/api/v5/market/tickers?instType=SPOT";
    const res = await fetch(`${API_BASE_URL}${tickersPath}`);
    const data = await res.json();
    const prices = {};
    if (data.code === "0" && data.data) {
      data.data.forEach(t => {
        prices[t.instId] = parseFloat(t.last);
      });
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
    const headers = getHeaders("GET", balancePath);
    const res = await fetch(`${API_BASE_URL}${balancePath}`, { headers });
    const data = await res.json();

    if (data.code !== "0") return { assets: null, totalUsd: 0 };

    const prices = await getMarketPrices();
    const portfolio = [];

    data.data[0].details.forEach(asset => {
      const amount = parseFloat(asset.eq);
      if (amount > 0) {
        const price = prices[`${asset.ccy}-USDT`] || (asset.ccy === "USDT" ? 1 : 0);
        const usdValue = amount * price;

        if (usdValue >= 1) {
          portfolio.push({
            asset: asset.ccy,
            amount,
            usdValue,
            frozen: parseFloat(asset.frozenBal)
          });
        }
      }
    });

    const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
    portfolio.forEach(a => {
      a.percentage = ((a.usdValue / totalUsd) * 100).toFixed(2);
    });
    portfolio.sort((a, b) => b.usdValue - a.usdValue);

    return { assets: portfolio, totalUsd };
  } catch (e) {
    console.error("Error fetching portfolio:", e);
    return { assets: null, totalUsd: 0 };
  }
}

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) {
    return ctx.reply("🚫 غير مصرح لك باستخدام هذا البوت.");
  }
  await next();
});

async function showBalance(ctx) {
  const { assets, totalUsd } = await getPortfolioData();
  if (!assets) return ctx.reply("خطأ في جلب الرصيد.");

  let msg = `📊 *ملخص المحفظة*\n💰 *الإجمالي:* $${totalUsd.toFixed(2)}\n\n`;
  assets.forEach(a => {
    msg += `• *${a.asset}*: $${a.usdValue.toFixed(2)} (${a.percentage}%)\n`;
  });

  const time = new Date().toLocaleTimeString("en-GB");
  msg += `\n_آخر تحديث: ${time}_`;

  ctx.reply(msg, { parse_mode: "Markdown" });
}

async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");

  isMonitoring = true;
  ctx.reply("✅ بدأت المراقبة.");

  previousPortfolio = await getPortfolioData();
  monitoringInterval = setInterval(async () => {
    const currentPortfolio = await getPortfolioData();
    if (!currentPortfolio.assets) return;

    const changes = [];
    const totalChange = Math.abs(((currentPortfolio.totalUsd - previousPortfolio.totalUsd) / previousPortfolio.totalUsd) * 100);

    currentPortfolio.assets.forEach(curr => {
      const prev = previousPortfolio.assets?.find(a => a.asset === curr.asset);
      if (!prev) {
        changes.push(`🟢 *شراء جديد:* ${curr.asset} (${curr.percentage}%)`);
      } else {
        const percentageChange = Math.abs(curr.percentage - prev.percentage);
        if (percentageChange >= 5) {
          changes.push(`📈 *${curr.asset}*: الآن ${curr.percentage}% (قبل ${prev.percentage}%)`);
        }
      }
    });

    previousPortfolio.assets?.forEach(prev => {
      const curr = currentPortfolio.assets.find(a => a.asset === prev.asset);
      if (!curr) {
        changes.push(`🔴 *بيع كامل:* ${prev.asset}`);
      }
    });

    if (changes.length > 0 || totalChange >= 10) {
      let msg = `📊 *تغيرات المحفظة*\n💰 *الإجمالي:* $${currentPortfolio.totalUsd.toFixed(2)}\n\n`;
      msg += changes.join("\n");
      ctx.reply(msg, { parse_mode: "Markdown" });
    }

    previousPortfolio = currentPortfolio;
  }, 15000);
}

async function stopMonitoring(ctx) {
  if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة.");
  clearInterval(monitoringInterval);
  isMonitoring = false;
  ctx.reply("🛑 توقفت المراقبة.");
}

const menu = new InlineKeyboard()
  .text("💰 عرض الرصيد", "show_balance").row()
  .text("👁️ بدء المراقبة", "start_monitoring").row()
  .text("🛑 إيقاف المراقبة", "stop_monitoring");

bot.command("start", ctx =>
  ctx.reply("مرحباً! اختر أحد الأوامر:", { reply_markup: menu })
);
bot.command("balance", showBalance);
bot.command("monitor", startMonitoring);
bot.command("stop_monitor", stopMonitoring);

bot.on("callback_query:data", async ctx => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  if (d === "show_balance") showBalance(ctx);
  if (d === "start_monitoring") startMonitoring(ctx);
  if (d === "stop_monitoring") stopMonitoring(ctx);
});

bot.start();