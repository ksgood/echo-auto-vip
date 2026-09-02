// ============================================================
//  echo-auto-vip — 自动领会员
//  打开 EchoMusic 时自动领取酷狗概念版每日畅听会员，支持连续领取
//  后续日期；每日自动升级概念会员；自动完成每日 8 次"看广告领时长"。
//  升级与广告时长通过插件内置签名直连酷狗网关，无需改动宿主文件。
// ============================================================

const SETTINGS_KEY = "settings";
const STATE_KEY = "state";

const DEFAULTS = {
  enabled: true, // 启动时自动领取
  autoUpgrade: true, // 每日自动升级概念会员
  futureDays: 7, // 连续领取天数：今天 + 未来 N 天
  receiveDay: "auto", // receive_day 参数：auto=按日期序列领取，也可手动指定单个日期
  delaySeconds: 8, // 启动后延迟秒数，等待登录态加载
  notify: true, // 显示 toast 通知
  adHoursCount: 8, // 每日"看广告领时长"次数（0-8，0=关闭，每次 +3 小时概念会员有效期）
};

const GATEWAY = "https://gateway.kugou.com";
const LITE_SALT = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA"; // 概念版(lite)签名盐值
const LITE_APPID = 3116;
const LITE_CLIENTVER = 11440;

let ctxRef = null;
let claimTimer = null;
let claiming = false;

// ---------- 工具 ----------

function todayStr() {
  return formatTime(new Date());
}

/** 本地时间戳字符串（历史记录展示用，避免 UTC 时差） */
function localTimestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${formatTime(d)} ${hh}:${mm}:${ss}`;
}

function formatTime(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function addDays(iso, n) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return formatTime(new Date(y, m - 1, d + n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEndTime(v) {
  if (v === null || v === undefined || v === "") return "";
  let ts;
  if (typeof v === "number") ts = v > 1e12 ? v : v * 1000;
  else if (/^\d{10}$/.test(String(v))) ts = Number(v) * 1000;
  else if (/^\d{13}$/.test(String(v))) ts = Number(v);
  else {
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : v;
  }
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(v);
  return `${formatTime(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 解析酷狗接口 body：成功 status===1 且 error_code===0；
 * 业务错误一般 error_code!==0，error_msg 带可读描述。
 */
function parseBody(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, code: -1, msg: "空响应", data: null };
  }
  const code = Number(body.error_code ?? body.errcode ?? 0);
  const status = Number(body.status ?? 1);
  const ok = code === 0 && status !== 0;
  const rawMsg = body.error_msg || body.errmsg || body.msg || body.message || "";
  const msg = rawMsg || (ok ? "成功" : `错误码 ${code || status}`);
  return { ok, code, status, msg, data: body.data ?? null };
}

/** 从异常对象里提取酷狗业务 body */
function errorToParsed(err) {
  const body = err?.response?.body ?? err?.body ?? err?.data;
  if (body && typeof body === "object") return parseBody(body);
  return { ok: false, code: -1, msg: String(err?.message || err), data: null };
}

/** 在任意嵌套结构里找 busi_vip 数组（会员状态） */
function extractBusiVip(body) {
  const stack = [body];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    for (const [k, v] of Object.entries(cur)) {
      if (k === "busi_vip" && Array.isArray(v)) return v;
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function friendlyClaimResult(parsed) {
  const d = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  const addDay = d.add_day ?? d.addDay ?? d.add_num ?? d.recharge_num ?? d.day;
  const endTime = d.vip_end_time ?? d.vipEndTime ?? d.end_time;
  let msg = parsed.msg === "成功" ? "领取成功" : parsed.msg;
  if (parsed.ok && addDay !== undefined && addDay !== null) msg = `领取成功 +${addDay} 天`;
  if (parsed.ok && endTime) msg += `，有效期至 ${formatEndTime(endTime)}`;
  return msg;
}

function isAlreadyClaimedMsg(msg) {
  return /已领|已经领|重复领|领过/.test(String(msg || ""));
}

function isNetworkError(parsed) {
  return parsed.code === -1 || /Request failed|network|timeout|ECONN|fetch/i.test(parsed.msg);
}

// ---------- MD5（用于酷狗 android 签名，与协议要求一致） ----------

// 标准表驱动实现：K[i] = floor(|sin(i+1)| * 2^32)，轮转结构按 MD5 规范
const MD5_S = (() => {
  const base = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const s = new Array(64);
  for (let i = 0; i < 64; i++) s[i] = base[Math.floor(i / 16) * 4 + (i % 4)];
  return s;
})();
const MD5_K = (() => {
  const k = new Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  return k;
})();

function md5cycle(state, m) {
  let [a, b, c, d] = state;
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) {
      f = (b & c) | (~b & d);
      g = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c);
      g = (5 * i + 1) % 16;
    } else if (i < 48) {
      f = b ^ c ^ d;
      g = (3 * i + 5) % 16;
    } else {
      f = c ^ (b | ~d);
      g = (7 * i) % 16;
    }
    const tmp = (f + a + MD5_K[i] + m[g]) | 0;
    a = d;
    d = c;
    c = b;
    b = (b + ((tmp << MD5_S[i]) | (tmp >>> (32 - MD5_S[i])))) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
}

function md5blk(s) {
  const blks = [];
  for (let i = 0; i < 64; i += 4) {
    blks[i >> 2] =
      s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
  }
  return blks;
}

function md5raw(byteStr) {
  const n = byteStr.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(byteStr.substring(i - 64, i)));
  const rest = byteStr.substring(i - 64);
  const tail = new Array(16).fill(0);
  for (i = 0; i < rest.length; i++) tail[i >> 2] |= rest.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}

const HEX_CHR = "0123456789abcdef".split("");
function rhex(n) {
  let s = "";
  for (let j = 0; j < 4; j++) {
    s += HEX_CHR[(n >> (j * 8 + 4)) & 0x0f] + HEX_CHR[(n >> (j * 8)) & 0x0f];
  }
  return s;
}

function md5(str) {
  // UTF-8 → 字节序列的二进制字符串
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const x = md5raw(bin);
  return rhex(x[0]) + rhex(x[1]) + rhex(x[2]) + rhex(x[3]);
}

// ---------- 酷狗网关直连（复刻宿主 request.js + helper.js 的 android 签名） ----------

function signAndroidLite(params, dataStr) {
  const ps = Object.keys(params)
    .sort()
    .map((k) => `${k}=${typeof params[k] === "object" ? JSON.stringify(params[k]) : params[k]}`)
    .join("");
  return md5(`${LITE_SALT}${ps}${dataStr || ""}${LITE_SALT}`);
}

/** 从宿主 Pinia 状态读取登录态与设备态（插件不落盘、不外泄） */
function getAuth() {
  try {
    const st = ctxRef.pinia.state.value;
    const u = st?.user?.info || {};
    const d = st?.device?.info || {};
    if (!u.token || !u.userid || !d.dfid || !d.mid) return null;
    return { token: String(u.token), userid: Number(u.userid), dfid: String(d.dfid), mid: String(d.mid) };
  } catch (e) {
    return null;
  }
}

async function directPost(path, auth, extraParams, dataObj, clienttimeSec) {
  const ct = Number.isFinite(clienttimeSec) ? clienttimeSec : Math.floor(Date.now() / 1000);
  const params = {
    dfid: auth.dfid,
    mid: auth.mid,
    uuid: "-",
    appid: LITE_APPID,
    clientver: LITE_CLIENTVER,
    clienttime: ct,
    token: auth.token,
    userid: auth.userid,
    ...(extraParams || {}),
  };
  const dataStr = dataObj ? JSON.stringify(dataObj) : "";
  params.signature = signAndroidLite(params, dataStr);
  const query = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const headers = {
    dfid: auth.dfid,
    mid: auth.mid,
    clienttime: String(ct),
    "kg-rc": "1",
    "kg-thash": "5d816a0",
    "kg-rec": "1",
    "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
    "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
  };
  if (dataObj) headers["Content-Type"] = "application/json; charset=utf-8";
  const resp = await ctxRef.net.request({
    url: `${GATEWAY}${path}?${query}`,
    method: "POST",
    headers,
    ...(dataObj ? { body: dataObj } : {}),
    responseType: "json",
    timeoutMs: 20000,
  });
  return parseBody(resp?.data);
}

// ---------- 状态存取 ----------

async function getState() {
  const saved = await ctxRef.storage.get(STATE_KEY);
  return saved && typeof saved === "object" ? saved : {};
}

async function patchState(patch) {
  const state = { ...(await getState()), ...patch };
  await ctxRef.storage.set(STATE_KEY, state);
  return state;
}

async function pushHistory(entry) {
  const state = await getState();
  const history = Array.isArray(state.history) ? state.history.slice() : [];
  history.unshift(entry);
  await patchState({ history: history.slice(0, 12) });
}

async function getSettings() {
  const saved = await ctxRef.storage.get(SETTINGS_KEY);
  return saved && typeof saved === "object" ? { ...DEFAULTS, ...saved } : { ...DEFAULTS };
}

// ---------- 领取逻辑 ----------

/** 目标日期序列：今天 + futureDays 天，已成功领取的日期跳过 */
async function buildTargetDates(settings, force) {
  const today = todayStr();
  const state = await getState();
  const claimed = state.claimedDates && typeof state.claimedDates === "object" ? state.claimedDates : {};

  const targets = [];
  for (let i = 0; i <= Math.max(0, Number(settings.futureDays) || 0); i++) {
    const date = addDays(today, i);
    if (!force && claimed[date]?.ok) continue;
    targets.push(date);
  }
  return { targets, claimed };
}

/** 每日 8 次"看广告领时长"（每次 +3 小时），服务端计数为准 */
async function ensureAdHours(settings, force) {
  const today = todayStr();
  const st0 = await getState();
  const target = Math.max(0, Math.min(8, Number(settings.adHoursCount) || 0));
  if (target === 0) return "";
  if (!force && st0.adLastDate === today && Number(st0.adDoneToday || 0) >= target) return "";

  const auth = getAuth();
  if (!auth) return "广告时长未成功：未获取到登录信息";

  let done = 0;
  let successes = 0;
  let awardPer = 0;
  let lastMsg = "";
  for (let i = 0; i < target; i++) {
    if (i > 0) await sleep(35000); // 模拟真实广告观看间隔，避免服务端"操作频繁"限频
    let parsed;
    try {
      parsed = await directPost("/youth/v1/ad/play_report", auth, {}, {
        ad_id: 12307537187,
        play_end: Date.now(),
        play_start: Date.now() - 30000,
      });
    } catch (err) {
      parsed = errorToParsed(err);
    }
    if (parsed.ok) {
      successes++;
      const d = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
      done = Number(d.done) || done + 1;
      awardPer = Number(d.award_vip_hour) || awardPer;
      if (Number(d.remain) <= 0) {
        lastMsg = `已达每日上限（${d.done}/${d.total}）`;
        break;
      }
    } else {
      lastMsg = parsed.msg;
      break;
    }
  }
  await patchState({ adLastDate: today, adDoneToday: done });
  if (successes > 0) {
    const hours = successes * (awardPer || 3);
    let text = `概念会员时长 +${hours} 小时（今日累计 ${done} 次）`;
    if (lastMsg) text += `，中断：${lastMsg}`;
    return text;
  }
  if (lastMsg) return `广告时长未成功：${lastMsg}`;
  return "";
}

/** 每日一次的概念会员升级（服务端每天限 1 次，自动应用到当天） */
async function dailyUpgrade(force) {
  const today = todayStr();
  const st0 = await getState();
  if (!force && st0.lastUpgradeDate === today) return "";

  const auth = getAuth();
  if (!auth) return "升级未成功：未获取到登录信息";

  let parsed;
  try {
    parsed = await directPost("/youth/v1/listen_song/upgrade_vip_reward", auth, {
      kugouid: auth.userid,
      ad_type: 1,
    });
  } catch (err) {
    parsed = errorToParsed(err);
  }

  if (parsed.ok) {
    const st = await getState();
    await patchState({ lastUpgradeDate: today, upgradedCount: (st.upgradedCount || 0) + 1 });
    return "概念会员 +1 天";
  }
  if (parsed.code === 297002 || /已经领取过升级/.test(parsed.msg)) {
    await patchState({ lastUpgradeDate: today });
    return "概念会员今日已升级过";
  }
  return `升级未成功：${parsed.msg}`;
}

async function claimRun(force) {
  if (!ctxRef) return { ok: false, msg: "插件未激活" };
  if (claiming) return { ok: false, msg: "正在领取中，请稍候" };

  const settings = await getSettings();
  if (!force && !settings.enabled) return { ok: false, msg: "自动领取未启用" };

  const { targets, claimed } = await buildTargetDates(settings, force);
  const state0 = await getState();
  const today = todayStr();

  const adSkip =
    settings.adHoursCount <= 0 ||
    (state0.adLastDate === today && Number(state0.adDoneToday || 0) >= Math.min(8, settings.adHoursCount));
  const upSkip = !settings.autoUpgrade || state0.lastUpgradeDate === today;

  if (!targets.length && adSkip && upSkip) {
    return { ok: true, skipped: true, msg: "本次无需处理：领取/时长/升级均已完成" };
  }

  claiming = true;
  const notify = (level, text) => {
    if (!settings.notify) return;
    try {
      ctxRef.toast[level](text);
    } catch (e) {
      /* 忽略通知失败 */
    }
  };

  try {
    // 1) 领取日期（走宿主酷狗通道，自动带登录态）
    const manual = String(settings.receiveDay ?? "auto").trim();
    const dateList = manual && manual.toLowerCase() !== "auto" ? [manual] : targets;

    const claimedNew = [];
    const alreadyKnown = [];
    const failed = [];
    let authExpired = false;
    let networkFailed = false;

    for (const date of dateList) {
      let parsed;
      try {
        parsed = parseBody(await ctxRef.kugou.user.claimDayVip(date));
      } catch (err) {
        parsed = errorToParsed(err);
      }

      if (parsed.ok) {
        claimedNew.push(date);
        claimed[date] = { ok: true, time: new Date().toISOString() };
      } else if (parsed.code === 20018) {
        authExpired = true;
        failed.push(`${date}: 登录已过期`);
        break;
      } else if (parsed.code === 131001 || isAlreadyClaimedMsg(parsed.msg)) {
        alreadyKnown.push(date);
        claimed[date] = { ok: true, already: true, time: new Date().toISOString() };
      } else if (isNetworkError(parsed)) {
        networkFailed = true;
        failed.push(`${date}: ${parsed.msg}`);
        break;
      } else {
        failed.push(`${date}: ${parsed.msg}`);
      }
    }

    if (dateList.length) await patchState({ claimedDates: claimed });

    // 2) 每日广告领时长（直连网关）
    let adText = "";
    if (!networkFailed && !authExpired) {
      try {
        adText = await ensureAdHours(settings, force);
      } catch (e) {
        adText = `广告时长未成功：${String((e && e.message) || e)}`;
      }
    }

    // 3) 每日概念会员升级（直连网关）
    let upgradeText = "";
    if (!networkFailed && !authExpired) {
      try {
        upgradeText = await dailyUpgrade(force);
      } catch (e) {
        upgradeText = `升级未成功：${String((e && e.message) || e)}`;
      }
    }

    // 4) 汇总
    const parts = [];
    if (claimedNew.length) parts.push(`新领取 ${claimedNew.length} 天`);
    if (alreadyKnown.length) parts.push(`${alreadyKnown.length} 天已领过`);
    if (failed.length) parts.push(`失败 ${failed.length} 天`);
    if (!parts.length && (adText || upgradeText)) parts.push("畅听会员无变化");
    let message = parts.length ? parts.join("，") : "今日任务已完成";
    if (claimedNew.length) message += `（${claimedNew[0]} ~ ${claimedNew[claimedNew.length - 1]}）`;
    if (adText) message += `；${adText}`;
    if (upgradeText) message += `；${upgradeText}`;
    if (authExpired) message = "酷狗登录已过期，请重新登录后再试";

    if (claimedNew.length || /概念会员 \+1/.test(upgradeText) || /广告时长 \d+ 次/.test(adText)) {
      notify("success", `自动领会员：${message}`);
    } else if (authExpired || failed.length || /未成功/.test(message)) {
      notify("warning", `自动领会员：${message}`);
    } else {
      notify("info", `自动领会员：${message}`);
    }

    await pushHistory({
      time: localTimestamp(),
      ok: !authExpired && !failed.length && !networkFailed,
      message,
      detail: { claimedNew, alreadyKnown, failed, adText, upgradeText },
    });
    await patchState({ lastAttemptAt: new Date().toISOString(), lastResult: message });
    return { ok: true, message };
  } finally {
    claiming = false;
  }
}

function scheduleClaim(seconds) {
  if (claimTimer) clearTimeout(claimTimer);
  const delay = Math.max(0, Number(seconds) || 0) * 1000;
  claimTimer = setTimeout(() => {
    claimTimer = null;
    claimRun(false).catch(() => {});
  }, delay);
}

// ---------- 设置面板 ----------

function buildSettingsPanel(ctx) {
  const { defineComponent, h, reactive } = ctx.vue;
  const defineAsyncComponent = ctx.vue.defineAsyncComponent;
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);
  const Slider = defineAsyncComponent(ctx.ui.components.Slider);
  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const Input = defineAsyncComponent(ctx.ui.components.Input);

  const SettingsPanel = defineComponent({
    setup() {
      const draft = reactive({ ...DEFAULTS });
      const state = reactive({
        lastResult: "",
        claimedDates: {},
        upgradedCount: 0,
        adLastDate: "",
        adDoneToday: 0,
        history: [],
        vipText: "查询中…",
        claiming: false,
      });

      ctx.storage.get(SETTINGS_KEY).then((saved) => {
        if (saved && typeof saved === "object") Object.assign(draft, { ...DEFAULTS, ...saved });
      });
      ctx.storage.get(STATE_KEY).then((saved) => {
        if (saved && typeof saved === "object") {
          state.lastResult = saved.lastResult || "";
          state.claimedDates = saved.claimedDates && typeof saved.claimedDates === "object" ? saved.claimedDates : {};
          state.upgradedCount = Number(saved.upgradedCount) || 0;
          state.adLastDate = saved.adLastDate || "";
          state.adDoneToday = Number(saved.adDoneToday) || 0;
          state.history = Array.isArray(saved.history) ? saved.history : [];
        }
      });

      const save = async (next) => {
        await ctx.storage.set(SETTINGS_KEY, { ...next });
        scheduleClaim(5);
      };

      const refreshVip = async () => {
        state.vipText = "查询中…";
        try {
          const body = await ctx.kugou.user.getUserVipDetail();
          const list = extractBusiVip(body);
          if (!list || !list.length) {
            state.vipText = "未获取到会员信息（未登录或接口无数据）";
            return;
          }
          const lines = [];
          for (const item of list) {
            const type = item?.product_type;
            const active = Number(item?.is_vip) === 1;
            if (type === "tvip") {
              lines.push(`畅听会员：${active ? "生效中" : "未生效"}${active ? `，到期 ${formatEndTime(item?.vip_end_time)}` : ""}`);
            } else if (type === "svip") {
              lines.push(`概念会员：${active ? "生效中" : "未生效"}${active ? `，到期 ${formatEndTime(item?.vip_end_time)}` : ""}`);
            }
          }
          state.vipText = lines.length ? lines.join("；") : "暂无畅听/概念会员记录";
        } catch (err) {
          const parsed = errorToParsed(err);
          state.vipText = parsed.code === 20018 ? "未登录或登录已过期" : `查询失败：${parsed.msg}`;
        }
      };
      refreshVip();

      const claimNow = async () => {
        state.claiming = true;
        try {
          await claimRun(true);
          const stateNow = await getState();
          state.lastResult = stateNow.lastResult || "";
          state.claimedDates = stateNow.claimedDates || {};
          state.upgradedCount = Number(stateNow.upgradedCount) || 0;
          state.adLastDate = stateNow.adLastDate || "";
          state.adDoneToday = Number(stateNow.adDoneToday) || 0;
          state.history = Array.isArray(stateNow.history) ? stateNow.history : [];
          await refreshVip();
        } finally {
          state.claiming = false;
        }
      };

      const claimedCount = () => Object.values(state.claimedDates).filter(Boolean).length;
      const todayClaimed = () => Boolean(state.claimedDates[todayStr()]?.ok);

      const row = (title, desc, control) =>
        h("div", { style: "display: flex; justify-content: space-between; align-items: center; gap: 12px;" }, [
          h("div", { style: "flex: 1; min-width: 0;" }, [
            h("div", { style: "font-weight: 600; font-size: 14px; line-height: 1.4;" }, title),
            desc ? h("div", { style: "font-size: 12px; opacity: 0.6; margin-top: 2px; line-height: 1.5;" }, desc) : null,
          ]),
          control,
        ]);

      return () =>
        h("div", { style: "display: grid; gap: 12px;" }, [
          // 会员状态
          row("会员状态", state.vipText, h(Button, { size: "xs", variant: "outline", onClick: refreshVip }, { default: () => "刷新" })),

          // 本地进度
          h("div", { style: "font-size: 12px; opacity: 0.75; line-height: 1.6;" }, [
            h("div", `今日已领：${todayClaimed() ? "是" : "否"}；累计已领 ${claimedCount()} 天，已升级概念会员 ${state.upgradedCount} 天`),
            h("div", `今日广告时长：${state.adLastDate === todayStr() ? `${state.adDoneToday} 次` : "未进行"}`),
            state.lastResult ? h("div", `最近结果：${state.lastResult}`) : null,
          ]),

          // 启用自动领取
          row(
            "启动时自动领取",
            "打开 EchoMusic 后按下方延迟自动领取",
            h(Switch, {
              modelValue: draft.enabled,
              "onUpdate:modelValue": (v) => {
                draft.enabled = Boolean(v);
                save(draft);
              },
            }),
          ),

          // 连续领取天数
          h("div", { style: "display: flex; flex-direction: column; gap: 4px;" }, [
            h("div", { style: "font-weight: 500; font-size: 13px;" }, "连续领取天数"),
            h("div", { style: "font-size: 12px; opacity: 0.6; line-height: 1.5;" }, "从今天起连续领取未来多天的畅听会员（0=只领今天）"),
            h(Slider, {
              modelValue: draft.futureDays,
              min: 0,
              max: 31,
              step: 1,
              showValue: true,
              valueSuffix: " 天",
              "onUpdate:modelValue": (v) => {
                draft.futureDays = Number(v);
                save(draft);
              },
            }),
          ]),

          // 广告领时长
          h("div", { style: "display: flex; flex-direction: column; gap: 4px;" }, [
            h("div", { style: "font-weight: 500; font-size: 13px;" }, "每日广告领时长"),
            h("div", { style: "font-size: 12px; opacity: 0.6; line-height: 1.5;" }, "自动完成每日看广告任务，领取的时长会自动叠加到概念会员有效期（每次 +3 小时，8 次 = +1 天），每日最多 8 次（0=关闭）；间隔约 35 秒/次，全部完成约 4-5 分钟"),
            h(Slider, {
              modelValue: draft.adHoursCount,
              min: 0,
              max: 8,
              step: 1,
              showValue: true,
              valueSuffix: " 次",
              "onUpdate:modelValue": (v) => {
                draft.adHoursCount = Number(v);
                save(draft);
              },
            }),
          ]),

          // 自动升级概念会员
          row(
            "每日升级概念会员",
            "每天自动升级 1 天概念会员（服务端限制每日一次，已领取的未来日期会逐天升满）",
            h(Switch, {
              modelValue: draft.autoUpgrade,
              "onUpdate:modelValue": (v) => {
                draft.autoUpgrade = Boolean(v);
                save(draft);
              },
            }),
          ),

          // 启动延迟
          h("div", { style: "display: flex; flex-direction: column; gap: 4px;" }, [
            h("div", { style: "font-weight: 500; font-size: 13px;" }, "启动延迟"),
            h(Slider, {
              modelValue: draft.delaySeconds,
              min: 0,
              max: 60,
              step: 1,
              showValue: true,
              valueSuffix: " 秒",
              "onUpdate:modelValue": (v) => {
                draft.delaySeconds = Number(v);
                save(draft);
              },
            }),
          ]),

          // 通知
          row(
            "显示通知",
            "领取结果通过应用内提示展示",
            h(Switch, {
              modelValue: draft.notify,
              "onUpdate:modelValue": (v) => {
                draft.notify = Boolean(v);
                save(draft);
              },
            }),
          ),

          // 手动指定日期
          row(
            "指定领取日期（可选）",
            "留空 auto 按日期序列连续领取；也可手动指定如 2026-09-03",
            h(Input, {
              modelValue: draft.receiveDay,
              style: "width: 150px;",
              placeholder: "auto",
              "onUpdate:modelValue": (v) => {
                draft.receiveDay = String(v ?? "").trim() || "auto";
                save(draft);
              },
            }),
          ),

          // 手动领取
          h("div", { style: "display: flex; gap: 8px; align-items: center;" }, [
            h(Button, { size: "xs", disabled: state.claiming, onClick: claimNow }, { default: () => (state.claiming ? "执行中…" : "立即执行") }),
            h("span", { style: "font-size: 12px; opacity: 0.6;" }, "忽略当日记录，重新执行一轮领取/时长/升级"),
          ]),

          // 领取记录
          state.history.length
            ? h("div", { style: "font-size: 12px; opacity: 0.75; line-height: 1.7;" }, [
                h("div", { style: "font-weight: 600;" }, "最近记录"),
                ...state.history.slice(0, 6).map((e) =>
                  h("div", `${(e?.time || "").replace("T", " ").slice(0, 19)}  ${e?.ok ? "✓" : "✗"} ${e?.message || ""}`),
                ),
              ])
            : null,
        ]);
    },
  });

  return SettingsPanel;
}

// ---------- 插件入口 ----------

export async function activate(ctx) {
  ctxRef = ctx;

  const settings = await getSettings();
  if (settings.enabled) {
    scheduleClaim(settings.delaySeconds);
  }

  ctx.dispose(() => {
    if (claimTimer) clearTimeout(claimTimer);
    claimTimer = null;
    ctxRef = null;
  });

  ctx.ui.settings.define({
    title: "自动领会员 设置",
    component: buildSettingsPanel(ctx),
  });
}

export function deactivate() {
  if (claimTimer) clearTimeout(claimTimer);
  claimTimer = null;
  ctxRef = null;
}
