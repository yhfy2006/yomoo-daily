const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const { RESEND_API_KEY, WORKER_URL, WORKER_SECRET, RESEND_FROM, EPISODE_DATE } = process.env;

if (!RESEND_API_KEY || !WORKER_URL || !WORKER_SECRET || !EPISODE_DATE) {
  console.log("Missing required env vars, skipping newsletter");
  process.exit(0);
}

const emailPath = path.join("episodes", EPISODE_DATE, "email.html");
if (!fs.existsSync(emailPath)) {
  console.error("Email HTML not found:", emailPath);
  process.exit(1);
}
const emailTemplate = fs.readFileSync(emailPath, "utf-8");

function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const maskedLocal = local.length <= 2 ? "*".repeat(local.length) : local[0] + "*".repeat(local.length - 2) + local[local.length - 1];
  return maskedLocal + "@" + domain;
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function hmacToken(email, secret) {
  return crypto.createHmac("sha256", secret).update(email).digest("hex");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendWithRetry(email, html, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetchJson("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM || "YOMOO 每日AI快送 <daily@yomoo.net>",
        to: email,
        subject: "YOMOO 每日AI快送 — " + EPISODE_DATE,
        html: html,
      }),
    });

    if (resp.status >= 200 && resp.status < 300) {
      return { success: true };
    }

    if (resp.status === 429 && attempt < maxRetries) {
      // Rate limited — back off and retry
      const backoff = attempt * 2000;
      console.log("    Rate limited, retrying in", backoff, "ms...");
      await sleep(backoff);
      continue;
    }

    return { success: false, status: resp.status, data: resp.data };
  }
  return { success: false, status: 429, data: "Max retries exceeded" };
}

async function main() {
  const workerUrl = WORKER_URL.replace(/\/$/, "");
  console.log("Fetching subscribers...");

  const subResp = await fetchJson(workerUrl + "/subscribers", {
    method: "GET",
    headers: { "X-API-Secret": WORKER_SECRET },
  });

  if (subResp.status !== 200) {
    console.error("Failed to fetch subscribers:", subResp.status);
    process.exit(1);
  }

  const subscribers = subResp.data;
  console.log("Found", subscribers.length, "subscriber(s)");

  if (subscribers.length === 0) {
    console.log("No subscribers, done");
    return;
  }

  let sent = 0, failed = 0;

  for (const sub of subscribers) {
    const email = sub.email;
    const masked = maskEmail(email);
    const token = hmacToken(email, WORKER_SECRET);
    const unsubUrl = workerUrl + "/unsubscribe?email=" + encodeURIComponent(email) + "&token=" + token;
    const html = emailTemplate.replace(/{{UNSUBSCRIBE_URL}}/g, unsubUrl);

    const result = await sendWithRetry(email, html);

    if (result.success) {
      sent++;
      console.log("  Sent to", masked);
    } else {
      failed++;
      console.error("  Failed for", masked, ":", result.status);
    }

    // Resend free tier: 2 emails/second — wait 600ms between sends
    await sleep(600);
  }

  console.log("Done:", sent, "sent,", failed, "failed, out of", subscribers.length);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
