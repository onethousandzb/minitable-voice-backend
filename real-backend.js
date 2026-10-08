/**
 * Minitable Voice AI — 真实后端中间层 (Middle Layer)
 * ============================================================
 * 作用:夹在 ElevenLabs(AI)和 Minitable 真实 SAAS 之间。
 *   - 对 AI 侧:保持和原 mock 完全一样的接口(store_id、"7:00 PM"、party_size),
 *     所以你 ElevenLabs 里的工具【一个都不用改】,URL 指到这个服务即可。
 *   - 对 SAAS 侧:翻译成 Minitable 真实接口要的格式(merchant_id、start_sec 时间戳、
 *     duration_sec……),用 Basic Auth 调用,再把返回翻译回 AI 能用的简单格式。
 *
 * ============================================================
 * 【部署前必须填的 4 个值】—— 见下面 CONFIG。开发填好即可跑。
 * ============================================================
 *
 * 依赖:Node 18+ (用内置 fetch)。零第三方依赖。
 * 运行:node real-backend.js
 */

const http = require('http');

// ────────────────────────────────────────────────────────────
//  CONFIG —— 全部通过环境变量注入(部署平台里配置,不写进代码)
// ────────────────────────────────────────────────────────────
const CONFIG = {
  // 【1】Minitable 真实 API 域名前缀,结尾不带斜杠。正式:https://ai.minitable.net
  API_BASE: process.env.MINITABLE_API_BASE || '',

  // 【2】Basic Auth 账号密码。只从环境变量读,绝不写进代码库。
  API_USER: process.env.MINITABLE_USER || '',
  API_PASS: process.env.MINITABLE_PASS || '',

  // 【3】默认用餐时长(秒)。90 分钟 = 5400。
  DEFAULT_DURATION_SEC: 90 * 60,

  // 【4】来源标记,Minitable 接口 source 字段必填。语音 AI 用 pbx。
  SOURCE: process.env.MINITABLE_SOURCE || 'pbx',

  // 本中间层对 ElevenLabs 暴露的鉴权 token(ElevenLabs 工具 Header 里带)。
  INBOUND_TOKEN: process.env.INBOUND_TOKEN || 'minitable-demo-token-12345',

  PORT: process.env.PORT || 3000,
};

// 启动时检查必需的环境变量,缺了直接报错退出,避免用空值连接导致难查的错误。
(function checkConfig(){
  const missing = [];
  if (!CONFIG.API_BASE) missing.push('MINITABLE_API_BASE');
  if (!CONFIG.API_USER) missing.push('MINITABLE_USER');
  if (!CONFIG.API_PASS) missing.push('MINITABLE_PASS');
  if (missing.length){
    console.error('[启动失败] 缺少环境变量:', missing.join(', '));
    console.error('请在部署平台的环境变量设置里配置它们(参考 .env.example)。');
    process.exit(1);
  }
})();

// 门店时区缓存(每家店查一次 merchant/info 后缓存,之后直接用,避免重复查询拖慢)。
// { merchant_id: 'America/Los_Angeles' } —— 时区来自门店真实数据,不写死,自动适配各时区门店。
const tzCache = {};

// 门店最大预约人数缓存。超过这个数需转人工(大 party 由门店直接安排)。
// 来自 reserve/setting 的 people_num_max。{ merchant_id: 8 }
const maxPartyCache = {};

// ────────────────────────────────────────────────────────────
//  工具:HTTP 返回、鉴权、读 body
// ────────────────────────────────────────────────────────────
// 把各种格式的北美号码规范成 "+1 9172141659"。
// 客人可能说 917-214-1659 / (917) 214-1659 / 9172141659 等,统一处理。
function normalizePhone(raw) {
  if (!raw) return raw;
  let digits = String(raw).replace(/\D/g, ''); // 只留数字
  // 已带国家码 1 且共 11 位 → 去掉再统一加
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) return `+1 ${digits}`;
  // 其它情况(已带 + 或非标准)原样返回,避免搞坏
  if (String(raw).trim().startsWith('+')) return String(raw).trim();
  return `+1 ${digits}`;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function checkInboundAuth(req) {
  return (req.headers['authorization'] || '') === `Bearer ${CONFIG.INBOUND_TOKEN}`;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

// ────────────────────────────────────────────────────────────
//  调用 Minitable 真实接口(带 Basic Auth)
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
//  内存日志缓冲区(供 /logs 页面查看,不依赖服务器命令行)
//  只存最近 N 条,重启后清空。含 SAAS 请求/返回、每次工具调用。
// ────────────────────────────────────────────────────────────
const LOG_BUFFER = [];
const LOG_MAX = 300;                       // 最多存 300 条
const LOG_PASSWORD = process.env.LOG_PASSWORD || 'minitable';  // 日志页密码,可用环境变量覆盖
function pushLog(type, detail) {
  LOG_BUFFER.push({ t: new Date().toISOString(), type, detail });
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
}

// 日志查看页面(登录 + 展示)。纯前端,密码提交到 /logs/data 校验。
const LOGS_PAGE_HTML = `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice AI 后端日志</title>
<style>
  *{box-sizing:border-box;} body{margin:0;background:#0b0e14;color:#e7ebf3;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",monospace;}
  .top{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #1c2333;position:sticky;top:0;background:#0b0e14ee;backdrop-filter:blur(8px);}
  .top h1{font-size:15px;margin:0;font-weight:700;color:#c7d0e3;}
  .top .sp{flex:1;}
  button{background:#151b2b;border:1px solid #2a3550;color:#c7d0e3;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;}
  button:hover{border-color:#6366f1;color:#fff;}
  input{background:#111725;border:1px solid #2a3550;border-radius:8px;color:#e7ebf3;padding:9px 12px;font-size:14px;}
  .login{max-width:340px;margin:80px auto;text-align:center;}
  .login h2{font-size:18px;color:#c7d0e3;}
  .login input{width:100%;margin:14px 0;}
  .login button{width:100%;padding:11px;}
  .err{color:#f87171;font-size:13px;margin-top:8px;min-height:18px;}
  .wrap{padding:16px 20px;max-width:1200px;margin:0 auto;}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
  .filters button{font-size:12px;padding:5px 11px;}
  .filters button.on{background:#232c44;color:#fff;border-color:#6366f1;}
  .log{border:1px solid #1c2333;border-radius:8px;overflow:hidden;}
  .row{display:grid;grid-template-columns:150px 90px 1fr;gap:10px;padding:8px 12px;font-size:12.5px;border-bottom:1px solid #161d2c;align-items:start;}
  .row:hover{background:#141b2b;}
  .ts{color:#6c7891;white-space:nowrap;font-variant-numeric:tabular-nums;}
  .tag{font-weight:700;white-space:nowrap;}
  .tag.REQUEST{color:#818cf8;} .tag.RESULT{color:#4ade80;}
  .tag.SAAScall{color:#38bdf8;} .tag.SAASresp{color:#22c55e;} .tag.ERROR{color:#f87171;}
  .detail{color:#c9d3e8;word-break:break-all;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;}
  .empty{color:#6c7891;text-align:center;padding:40px;font-size:13px;}
</style></head><body>
<div id="login" class="login">
  <h2>Voice AI 后端日志</h2>
  <input id="pw" type="password" placeholder="输入密码" onkeydown="if(event.key==='Enter')doLogin()">
  <button onclick="doLogin()">登录</button>
  <div id="err" class="err"></div>
</div>
<div id="app" style="display:none">
  <div class="top">
    <h1>Voice AI 后端日志</h1>
    <span class="sp"></span>
    <label style="font-size:12px;color:#8b96ad;"><input type="checkbox" id="auto" onchange="toggleAuto()"> 自动刷新</label>
    <button onclick="load()">刷新</button>
    <button onclick="logout()">退出</button>
  </div>
  <div class="wrap">
    <div class="filters">
      <button class="on" data-f="all" onclick="setF(this)">全部</button>
      <button data-f="REQUEST" onclick="setF(this)">工具请求</button>
      <button data-f="RESULT" onclick="setF(this)">工具结果</button>
      <button data-f="SAAS" onclick="setF(this)">SAAS 往返</button>
      <button data-f="ERROR" onclick="setF(this)">错误</button>
    </div>
    <div id="log" class="log"></div>
  </div>
</div>
<script>
  let PW='', DATA=[], FILT='all', timer=null;
  async function doLogin(){
    PW=document.getElementById('pw').value;
    const ok=await load(true);
    if(ok){document.getElementById('login').style.display='none';document.getElementById('app').style.display='block';}
    else{document.getElementById('err').textContent='密码错误';}
  }
  function logout(){PW='';DATA=[];if(timer)clearInterval(timer);document.getElementById('app').style.display='none';document.getElementById('login').style.display='block';document.getElementById('pw').value='';}
  async function load(silent){
    try{
      const r=await fetch('/logs/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PW})});
      if(r.status===401){if(!silent)document.getElementById('err').textContent='密码错误';return false;}
      const d=await r.json();DATA=d.logs||[];render();return true;
    }catch(e){return false;}
  }
  function setF(btn){document.querySelectorAll('.filters button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');FILT=btn.dataset.f;render();}
  function tagClass(t){if(t.includes('SAAS'))return t.includes('→')?'SAAScall':'SAASresp';return t;}
  function render(){
    const box=document.getElementById('log');
    let rows=DATA;
    if(FILT!=='all')rows=DATA.filter(x=>x.type.includes(FILT)|| (FILT==='SAAS'&&x.type.includes('SAAS')));
    if(!rows.length){box.innerHTML='<div class="empty">暂无日志(重启后清空,或还没有请求)</div>';return;}
    box.innerHTML=rows.map(x=>{
      const time=new Date(x.t).toLocaleString('en-CA',{hour12:false});
      const tc=tagClass(x.type);
      return '<div class="row"><span class="ts">'+time+'</span><span class="tag '+tc+'">'+x.type+'</span><span class="detail">'+esc(x.detail)+'</span></div>';
    }).join('');
  }
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function toggleAuto(){if(document.getElementById('auto').checked){timer=setInterval(load,4000);}else if(timer){clearInterval(timer);}}
</script>
</body></html>`;


async function callSAAS(path, payload) {
  const auth = 'Basic ' + Buffer.from(`${CONFIG.API_USER}:${CONFIG.API_PASS}`).toString('base64');
  console.log('[SAAS →]', path, JSON.stringify(payload));
  pushLog('SAAS →', path + ' ' + JSON.stringify(payload));
  const resp = await fetch(CONFIG.API_BASE + path, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  console.log('[SAAS ←]', resp.status, text.slice(0, 500));
  pushLog('SAAS ←', resp.status + ' ' + text.slice(0, 800));
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(`SAAS ${path} returned ${resp.status}`);
    err.status = resp.status; err.data = data;
    throw err;
  }
  return data;
}

// ────────────────────────────────────────────────────────────
//  时间转换:美式时间字符串 <-> Unix 时间戳(秒),按门店时区
//  这是整个中间层最关键的部分。
// ────────────────────────────────────────────────────────────

// 取门店时区(先查缓存,没有就调 merchant/info)。返回 IANA 时区名,如 'Asia/Tokyo'。
async function getMerchantTimezone(merchant_id) {
  if (tzCache[merchant_id]) return tzCache[merchant_id];
  const info = await callSAAS('/weapp/voice-agent/merchant/info', { merchant_id });
  const tz = info?.info?.timezone || 'America/New_York';
  tzCache[merchant_id] = tz;
  return tz;
}

// 取门店可 AI 预约的最大人数(people_num_max)。超过则需转人工。
// 从 reserve/setting 读取;取配置里出现的最大的 people_num_max。查不到返回 null(表示不限制/未知)。
async function getMaxPartySize(merchant_id) {
  if (maxPartyCache[merchant_id] !== undefined) return maxPartyCache[merchant_id];
  let max = null;
  try {
    const setting = await callSAAS('/weapp/voice-agent/reserve/setting', { sid: merchant_id });
    const arr = setting?.reserve_inadvance_hours_data || [];
    for (const row of arr) {
      if (row.people_num_max != null) {
        const v = Number(row.people_num_max);
        if (!Number.isNaN(v) && (max === null || v > max)) max = v;
      }
    }
  } catch (e) { /* 读不到就当不限制 */ }
  maxPartyCache[merchant_id] = max;
  return max;
}

// 把 "今天/给定日期 + 7:00 PM" 在指定时区转成他们要的 "YYYY-MM-DD HH:MM" 字符串。
// 注意:他们的 start_sec 字段其实是这种可读字符串,不是 Unix 时间戳!
// date 形如 MM/DD/YYYY(可空,空则用"今天");time 形如 "7:00 PM"。
function toStartSec(dateStr, timeStr, timezone) {
  // 解析美式时间 -> 24 小时 h:m
  const m = String(timeStr).trim().toUpperCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  let hh, mm = 0;
  if (m) {
    hh = parseInt(m[1], 10);
    mm = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === 'PM' && hh !== 12) hh += 12;
    if (m[3] === 'AM' && hh === 12) hh = 0;
  } else {
    const m24 = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m24) throw new Error(`Cannot parse time: ${timeStr}`);
    hh = parseInt(m24[1], 10); mm = parseInt(m24[2], 10);
  }
  // 解析日期(MM/DD/YYYY),空则用门店时区的今天
  let y, mo, d;
  if (dateStr && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
    const [mm2, dd2, yy2] = dateStr.split('/').map(Number);
    y = yy2; mo = mm2; d = dd2;
  } else {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    y = +parts.find(p => p.type === 'year').value;
    mo = +parts.find(p => p.type === 'month').value;
    d = +parts.find(p => p.type === 'day').value;
  }
  // 生成 "YYYY-MM-DD HH:MM" 字符串(就是墙钟时间,门店本地时间)
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)} ${pad(hh)}:${pad(mm)}`;
}

// 把毫秒时间戳(reserve/info 返回的 reservation_time)按门店时区转成 "YYYY-MM-DD HH:MM"。
// 用于「只改人数不改时间」时,拿原预约的时间作为目标时间。
function msToStartSec(ms, timezone) {
  const d = new Date(Number(ms));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const map = {};
  parts.forEach(p => (map[p.type] = p.value));
  let hh = map.hour === '24' ? '00' : map.hour; // 兼容个别环境 24:00
  return `${map.year}-${map.month}-${map.day} ${hh}:${map.minute}`;
}

// 求某 UTC 时刻在指定时区的偏移量(秒)。
function tzOffsetSec(date, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  parts.forEach(p => (map[p.type] = p.value));
  const asIfLocal = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return Math.round((asIfLocal - date.getTime()) / 1000);
}

// 把他们返回的 "YYYY-MM-DD HH:MM" 字符串转回美式 "6:00 PM",读给客人。
function toUSTime(startStr, timezone) {
  // startStr 形如 "2026-08-06 19:00";也兼容可能的时间戳数字。
  let hh, mm;
  const m = String(startStr).match(/\s(\d{1,2}):(\d{2})/);
  if (m) {
    hh = parseInt(m[1], 10); mm = parseInt(m[2], 10);
  } else if (/^\d+$/.test(String(startStr))) {
    const d = new Date(Number(startStr) * 1000);
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  } else {
    return String(startStr);
  }
  const ap = hh >= 12 ? 'PM' : 'AM';
  let h12 = hh % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

// ────────────────────────────────────────────────────────────
//  接口 1:查空位  POST /check-availability
//  AI 侧入参: { store_id, date, time, party_size }
//  → 调 reserve/availability/check;不可用时再调 suggest 拿备选
// ────────────────────────────────────────────────────────────
async function handleCheckAvailability(body) {
  const { store_id, date, time, party_size } = body;
  if (!store_id || !time || !party_size) {
    return { _status: 400, error: 'Missing store_id, time or party_size' };
  }

  // 大 party 检查:超过门店可 AI 预约的最大人数,需转人工,不去查位。
  const maxParty = await getMaxPartySize(store_id);
  if (maxParty != null && Number(party_size) > maxParty) {
    return {
      available: false,
      too_large: true,
      max_party_size: maxParty,
      alternatives: [],
      message: `A party of ${party_size} is above the maximum of ${maxParty} that can be booked automatically. Parties of ${maxParty + 1} or more are arranged directly with the restaurant — the guest should be transferred to the restaurant.`,
    };
  }

  const tz = await getMerchantTimezone(store_id);
  const startSec = toStartSec(date, time, tz);
  const duration = CONFIG.DEFAULT_DURATION_SEC;

  // 查可用(注意:check 接口的 slot_time 是数组)
  const checkResp = await callSAAS('/weapp/voice-agent/reserve/availability/check', {
    merchant_id: store_id,
    party_size: String(party_size),
    slot_time: [{ start_sec: startSec, duration_sec: duration }],
  });

  const slot = (checkResp.slot_time_availability || [])[0] || {};
  const available = !!slot.available;

  if (available) {
    return { available: true, alternatives: [], message: `A table for ${party_size} is available at ${time}.` };
  }

  // 不可用 → 调 suggest 拿备选
  let alternatives = [];
  try {
    const sug = await callSAAS('/weapp/voice-agent/reserve/availability/suggest', {
      merchant_id: store_id,
      party_size: Number(party_size),
      slot_time: { start_sec: startSec, duration_sec: duration },
    });
    alternatives = (sug.suggest_slot_time || []).map(s => toUSTime(s.start_sec, tz));
  } catch (e) { /* suggest 失败就返回空备选 */ }

  return {
    available: false,
    alternatives,
    message: alternatives.length
      ? `${time} is fully booked, but these times are available: ${alternatives.join(', ')}.`
      : `${time} is fully booked and no nearby times are available.`,
  };
}

// ────────────────────────────────────────────────────────────
//  接口 2:创建预约  POST /create-reservation
// ────────────────────────────────────────────────────────────
async function handleCreateReservation(body) {
  const { store_id, date, time, party_size, guest_name, guest_phone, notes } = body;
  const missing = [];
  ['store_id', 'time', 'party_size', 'guest_name', 'guest_phone'].forEach(k => { if (!body[k]) missing.push(k); });
  if (missing.length) return { _status: 400, error: `Missing: ${missing.join(', ')}` };

  const tz = await getMerchantTimezone(store_id);
  const startSec = toStartSec(date, time, tz);

  const resp = await callSAAS('/weapp/voice-agent/reserve/create', {
    telephone: normalizePhone(guest_phone),
    note: notes || '',
    customer_name: guest_name,
    slot: {
      merchant_id: store_id,
      start_sec: startSec,
      duration_sec: CONFIG.DEFAULT_DURATION_SEC,
      party_size: Number(party_size),
    },
    source: body._source_override || CONFIG.SOURCE, // 测试:可用 _source_override 覆盖
  });

  // 他们的返回:成功 → { booking: { booking_id, status: ... } }
  //             失败 → { booking_failure: { cause } }
  if (resp.booking_failure && resp.booking_failure.cause) {
    const cause = String(resp.booking_failure.cause);
    // 识别「疑似重复预约」这类原因,给 AI 结构化信号 + 友好话术,而不是把技术错误读给客人。
    const looksDuplicate = /duplicat|already|exist|same/i.test(cause);
    if (looksDuplicate) {
      return {
        success: false,
        duplicate_suspected: true,   // AI 据此走「疑似重复」话术,而不是报错
        message: `It looks like there may already be a reservation under this phone number for a similar time. This could be a duplicate.`,
      };
    }
    // 其它失败,也不要把原始技术错误读给客人
    return {
      success: false,
      message: `I wasn't able to complete that reservation just now.`,
      _cause: cause,   // 仅供日志排查,AI 不念给客人
    };
  }
  const booking = resp.booking || {};
  const status = booking.status || '';

  // 根据状态给不同的 message,AI 据此对客人措辞:
  //  CONFIRMED = 已确认;PENDING_MERCHANT_CONFIRMATION = 已提交,待商家确认。
  let message, confirmed;
  if (status === 'PENDING_MERCHANT_CONFIRMATION') {
    confirmed = false;
    message = `Your reservation request for ${party_size} at ${time} has been submitted and is pending confirmation from the restaurant. You'll receive a text once it's confirmed.`;
  } else {
    // CONFIRMED 或其它成功状态,按已确认处理
    confirmed = true;
    message = `Reservation confirmed for ${guest_name}, party of ${party_size} at ${time}.`;
  }

  return {
    success: true,
    status,        // "CONFIRMED" / "PENDING_MERCHANT_CONFIRMATION"
    confirmed,     // true = 已确认;false = 待商家确认。AI 用这个区分话术。
    confirmation_number: booking.booking_id || '',  // AI 不念给客人,给日志/短信用
    message,
  };
}

// ────────────────────────────────────────────────────────────
//  接口 3:按电话查预约  POST /find-reservation
//  → reserve/list(返回 bookings[].booking_id)
// ────────────────────────────────────────────────────────────
// 按 booking_id 查预约详情(list 只给 id,详情要单独查)。
async function getBookingInfo(booking_id) {
  const r = await callSAAS('/weapp/voice-agent/reserve/info', { booking_id });
  return r; // { booking_id, booking_status, info:{customer_name, party_size, reservation_time} }
}

// 从电话查出的多个 booking 里,挑一个"有效的(未取消)"预约,返回其详情。
// 优化:只查前几个、并行查,避免历史预约多时逐个串行查导致超时。
async function findActiveBooking(guest_phone) {
  const list = await callSAAS('/weapp/voice-agent/reserve/list', { telephone: normalizePhone(guest_phone) });
  const bookings = list.bookings || [];
  if (!bookings.length) return null;
  // 只看前 5 个(最近的),并行查详情
  const top = bookings.slice(0, 5);
  const details = await Promise.all(top.map(b => getBookingInfo(b.booking_id).catch(() => null)));
  for (const d of details) {
    if (d && d.booking_status && d.booking_status !== 'CANCELED') return d;
  }
  return null;
}

async function handleFindReservation(body) {
  const { store_id, guest_phone } = body;
  if (!guest_phone) return { _status: 400, error: 'Missing guest_phone' };
  const active = await findActiveBooking(guest_phone);
  if (!active) return { found: false, message: `No active reservation found for ${guest_phone}.` };
  const info = active.info || {};
  // reservation_time 是毫秒时间戳,转成美式时间(按门店时区)读给客人。
  let timeStr = '';
  if (info.reservation_time) {
    const tz = store_id ? await getMerchantTimezone(store_id).catch(() => 'America/New_York') : 'America/New_York';
    const d = new Date(Number(info.reservation_time)); // 毫秒
    timeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d);
  }
  return {
    found: true,
    booking_id: active.booking_id,
    guest_name: info.customer_name || '',
    party_size: info.party_size || null,
    reservation_time: timeStr, // e.g. "Aug 5, 8:00 PM"
    notes: info.note || '', // 特殊备注/嘱咐,复述时读给客人
    message: `Found a reservation under ${guest_phone} for ${info.customer_name || 'the guest'}, party of ${info.party_size || '?'}${timeStr ? ', on ' + timeStr : ''}${info.note ? ', note: ' + info.note : ''}.`,
  };
}

// ────────────────────────────────────────────────────────────
//  接口 4:修改预约  POST /modify-reservation
//  先 find 拿 booking_id → 查新时间是否有位 → reserve/update 改 slot
// ────────────────────────────────────────────────────────────
async function handleModifyReservation(body) {
  const { store_id, guest_phone, new_time, new_date, new_party_size, new_notes } = body;
  if (!store_id || !guest_phone) return { _status: 400, error: 'Missing store_id or guest_phone' };
  // 至少要改点什么:时间、人数、或备注
  const wantsTimeChange = !!new_time;
  const wantsPartyChange = (new_party_size !== undefined && new_party_size !== null && new_party_size !== '');
  const wantsNoteChange = (new_notes !== undefined && new_notes !== null);
  if (!wantsTimeChange && !wantsPartyChange && !wantsNoteChange) {
    return { _status: 400, error: 'Nothing to change: provide new_time, new_party_size, or new_notes' };
  }

  const active = await findActiveBooking(guest_phone);
  if (!active) return { success: false, message: `No active reservation found for ${guest_phone}.` };
  const booking_id = active.booking_id;
  const origPartySize = (active.info && active.info.party_size) || 2;
  const origNote = (active.info && active.info.note) || '';

  const finalNote = wantsNoteChange ? new_notes : origNote;          // 没传新备注就保留原备注
  const finalParty = wantsPartyChange ? Number(new_party_size) : origPartySize;

  const tz = await getMerchantTimezone(store_id);
  const origStartSec = (active.info && active.info.reservation_time) ? msToStartSec(active.info.reservation_time, tz) : null;

  // 情况 A:只改备注(不改时间、不改人数)→ 跳过查位,用原时间+原人数,只把 note 换成新的。
  // 注意:Minitable 的 update 需要带 slot,不能只传 note,否则 400。
  if (!wantsTimeChange && !wantsPartyChange) {
    if (!origStartSec) {
      // 拿不到原预约时间,无法组一个完整的 update 请求。
      return { success: false, message: `I couldn't read the current reservation time, so I can't update the note right now.` };
    }
    const noteResp = await callSAAS('/weapp/voice-agent/reserve/update', {
      note: finalNote,   // 顶层放一份(与 create 一致)
      booking: {
        booking_id,
        slot: { start_sec: origStartSec, party_size: origPartySize },
        note: finalNote, // booking 内也放一份,双保险
      },
    });
    if (noteResp && noteResp.booking_failure && noteResp.booking_failure.cause) {
      return {
        success: false,
        message: `I wasn't able to update the note just now.`,
        _cause: String(noteResp.booking_failure.cause),
      };
    }
    return {
      success: true, note_only: true, notes: finalNote,
      message: `Note updated${finalNote ? ' to: ' + finalNote : ' (cleared)'}. Time and party size unchanged.`,
    };
  }

  // 情况 B:改时间和/或人数 → 需要一个目标时间。没传新时间就用原预约时间。
  const startSec = wantsTimeChange ? toStartSec(new_date, new_time, tz)
                                   : origStartSec;
  if (!startSec) {
    // 拿不到原时间(极少见),无法在不查位的情况下安全改人数,提示补时间。
    return { success: false, message: `To change the party size, please also confirm the reservation time.` };
  }

  // 注意:不在这里用 availability/check 硬拦截。
  // 原因:PENDING(需门店确认)的时段,查位会返回 available:false,
  //       但这种时段其实是可以预约的(和 create 落单一致)。
  //       所以直接尝试 update,由 SAAS 返回真实结果(成功/PENDING/真失败),
  //       和 create 的处理保持一致。

  // 更新时间/人数,并带上备注(改了用新的,没改保留原的)
  const updResp = await callSAAS('/weapp/voice-agent/reserve/update', {
    note: finalNote,   // 顶层放一份(与 create 一致)
    booking: {
      booking_id,
      slot: { start_sec: startSec, party_size: finalParty },
      note: finalNote, // booking 内也放一份,双保险
    },
  });

  // update 失败的处理:
  if (updResp && updResp.booking_failure && updResp.booking_failure.cause) {
    const cause = String(updResp.booking_failure.cause);
    // 若是「真没位」(SLOT_UNAVAILABLE 且确实约不到),给客人备选时间。
    if (/SLOT_UNAVAILABLE|UNAVAILABLE|NO_SLOT/i.test(cause)) {
      let alternatives = [];
      try {
        const sug = await callSAAS('/weapp/voice-agent/reserve/availability/suggest', {
          merchant_id: store_id, party_size: finalParty,
          slot_time: { start_sec: startSec, duration_sec: CONFIG.DEFAULT_DURATION_SEC },
        });
        alternatives = (sug.suggest_slot_time || []).map(s => toUSTime(s.start_sec, tz));
      } catch {}
      const timeLabel = wantsTimeChange ? new_time : 'that time';
      return {
        success: false, available: false, alternatives,
        message: `${timeLabel} isn't available for ${finalParty}. Alternatives: ${alternatives.join(', ') || 'none'}. The original reservation is unchanged.`,
        _cause: cause,
      };
    }
    // 其它失败
    return {
      success: false,
      message: `I wasn't able to update that reservation just now. The original reservation is unchanged.`,
      _cause: cause,
    };
  }

  // 读改后的状态,区分 CONFIRMED / PENDING,让 AI 说对话术
  const updBooking = updResp.booking || {};
  const status = updBooking.status || '';
  let message, confirmed;
  if (status === 'PENDING_MERCHANT_CONFIRMATION') {
    confirmed = false;
    message = `Your reservation change to ${wantsTimeChange ? new_time : 'the new time'}, party of ${finalParty}, has been submitted and is pending confirmation from the restaurant. You'll receive a text once it's confirmed.`;
  } else {
    confirmed = true;
    message = `Your reservation is updated${wantsTimeChange ? ' to ' + new_time : ''}, party of ${finalParty}${finalNote ? ', note: ' + finalNote : ''}. You'll receive a confirmation text shortly.`;
  }

  return {
    success: true,
    available: true,
    status,        // "CONFIRMED" / "PENDING_MERCHANT_CONFIRMATION"
    confirmed,     // AI 用这个区分话术
    notes: finalNote,
    confirmation_number: updBooking.booking_id || booking_id || '',
    message,
  };
}

// ────────────────────────────────────────────────────────────
//  接口 5:取消预约  POST /cancel-reservation
//  → find 拿 booking_id → reserve/update 把 status 设为 CANCELED
// ────────────────────────────────────────────────────────────
async function handleCancelReservation(body) {
  const { guest_phone } = body;
  if (!guest_phone) return { _status: 400, error: 'Missing guest_phone' };
  const active = await findActiveBooking(guest_phone);
  if (!active) return { success: false, message: `No active reservation found for ${guest_phone}.` };

  await callSAAS('/weapp/voice-agent/reserve/update', {
    booking: { booking_id: active.booking_id, status: 'CANCELED' },
  });
  return { success: true, message: `Reservation cancelled.` };
}

// ────────────────────────────────────────────────────────────
//  接口 6:现场等位  POST /join-waitlist
//  → waitlist/create
// ────────────────────────────────────────────────────────────
async function handleJoinWaitlist(body) {
  const { store_id, party_size, guest_name, guest_phone, notes } = body;
  const missing = [];
  ['store_id', 'party_size', 'guest_name', 'guest_phone'].forEach(k => { if (!body[k]) missing.push(k); });
  if (missing.length) return { _status: 400, error: `Missing: ${missing.join(', ')}` };

  const resp = await callSAAS('/weapp/voice-agent/waitlist/create', {
    merchant_id: store_id,
    party_size: Number(party_size),
    telephone: normalizePhone(guest_phone),
    customer_name: guest_name,
    note: notes || '',
    source: CONFIG.SOURCE,
  });
  if (resp.waitlist_business_logic_failure && resp.waitlist_business_logic_failure.cause) {
    return { success: false, message: resp.waitlist_business_logic_failure.description || 'Could not join the waitlist.' };
  }
  // 前面几桌:他们返回若含排队数则用之(字段名以实际为准);否则查 today list 数长度。
  let partiesAhead = resp.parties_ahead;
  if (partiesAhead == null) {
    try {
      const today = await callSAAS('/weapp/voice-agent/waitlist/list', { merchant_id: store_id });
      partiesAhead = (today.waitlist || today.list || []).length;
    } catch { partiesAhead = null; }
  }
  return {
    success: true,
    parties_ahead: partiesAhead,
    message: partiesAhead != null
      ? `You're on the waitlist. There ${partiesAhead === 1 ? 'is' : 'are'} ${partiesAhead} ${partiesAhead === 1 ? 'party' : 'parties'} ahead of you.`
      : `You're on the waitlist.`,
  };
}

// ────────────────────────────────────────────────────────────
//  接口 7:call-ahead 等位  POST /join-call-ahead
//  注意:他们字段名不同 —— sid / phone_num / people_num,时间用 join_time
// ────────────────────────────────────────────────────────────
async function handleJoinCallAhead(body) {
  const { store_id, party_size, guest_name, guest_phone, expected_arrival_time, notes } = body;
  const missing = [];
  ['store_id', 'party_size', 'guest_name', 'guest_phone', 'expected_arrival_time'].forEach(k => { if (!body[k]) missing.push(k); });
  if (missing.length) return { _status: 400, error: `Missing: ${missing.join(', ')}` };

  const tz = await getMerchantTimezone(store_id);
  // toStartSec 现在直接返回 "YYYY-MM-DD HH:MM",正是 join_time 要的格式。
  const joinTime = toStartSec(null, expected_arrival_time, tz);

  await callSAAS('/weapp/voice-agent/call-ahead/join', {
    sid: store_id,
    customer_name: guest_name,
    phone_num: normalizePhone(guest_phone),
    people_num: Number(party_size),
    note: notes || '',
    // ahead_minutes 和 join_time 二选一;我们用具体时间 join_time。
    join_time: joinTime,
    source: CONFIG.SOURCE,
  });
  return {
    success: true,
    expected_arrival_time,
    guest_name,
    party_size: Number(party_size),
    message: `Added to the call-ahead list: ${guest_name}, party of ${party_size}, arriving around ${expected_arrival_time}. Near the arrival time the name is automatically added to the waitlist, and a text is sent.`,
  };
}

// ────────────────────────────────────────────────────────────
//  接口 8:在线点餐链接短信  POST /send-order-link
//  客人在电话里说"想点餐/外卖/takeout"→ AI 调这个 → 给客人发一条
//  带在线点餐链接的短信。
// ────────────────────────────────────────────────────────────

// 在线点餐链接短信:全部交给 SAAS。
// SAAS 的 order/send/sms 只收 merchant_id + phone_num:它自己查这家店的
// online_order_url / order_sms_template、替换 ${link}、判断是否开通并发短信。
// 返回 { success: {message} } 或 { failure: {cause} }(cause 如 ONLINE_ORDER_NOT_ENABLED)。
async function handleSendOrderLink(body) {
  const { store_id, guest_phone } = body;
  if (!store_id)     return { _status: 400, error: 'Missing store_id' };
  if (!guest_phone)  return { _status: 400, error: 'Missing guest_phone' };

  const resp = await callSAAS('/weapp/voice-agent/order/send/sms', {
    merchant_id: store_id,
    phone_num: normalizePhone(guest_phone),
  });

  // 没开在线点餐 → 让 AI 说暂不支持(不报错)。
  const cause = resp?.failure?.cause;
  if (cause) {
    const notEnabled = /ONLINE_ORDER_NOT_ENABLED/i.test(cause);
    return {
      success: false,
      enabled: !notEnabled,
      message: notEnabled
        ? 'Online ordering is not available for this store.'
        : 'Could not send the ordering link right now.',
    };
  }

  return {
    success: true,
    enabled: true,
    message: `A text with the online ordering link has been sent to ${guest_phone}.`,
  };
}

// ────────────────────────────────────────────────────────────
//  路由
// ────────────────────────────────────────────────────────────
const routes = {
  '/check-availability': handleCheckAvailability,
  '/create-reservation': handleCreateReservation,
  '/find-reservation': handleFindReservation,
  '/modify-reservation': handleModifyReservation,
  '/cancel-reservation': handleCancelReservation,
  '/join-waitlist': handleJoinWaitlist,
  '/join-call-ahead': handleJoinCallAhead,
  '/send-order-link': handleSendOrderLink,
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { status: 'ok', service: 'minitable-real-backend', api_base: CONFIG.API_BASE });
  }

  // ── 日志查看页(带密码登录) ──
  // GET /logs        → 返回登录+日志页面(HTML)
  // POST /logs/data  → 传密码,对了返回最近日志的 JSON
  const urlPath = (req.url || '').split('?')[0];
  if (req.method === 'GET' && urlPath === '/logs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGS_PAGE_HTML);
  }
  if (req.method === 'POST' && urlPath === '/logs/data') {
    let body;
    try { body = await readBody(req); } catch { body = {}; }
    if (!body || body.password !== LOG_PASSWORD) {
      return sendJSON(res, 401, { error: 'Wrong password' });
    }
    // 最新的在前
    return sendJSON(res, 200, { logs: LOG_BUFFER.slice().reverse() });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { status: 'ok' });
  }
  const handler = routes[req.url];
  if (req.method !== 'POST' || !handler) return sendJSON(res, 404, { error: 'Not found' });
  if (!checkInboundAuth(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  console.log('[REQUEST]', req.url, JSON.stringify(body));
  pushLog('REQUEST', req.url + ' ' + JSON.stringify(body));

  try {
    const result = await handler(body);
    const status = result._status || 200;
    delete result._status;
    pushLog('RESULT', req.url + ' ' + JSON.stringify(result));
    sendJSON(res, status, result);
  } catch (e) {
    console.error('[ERROR]', req.url, e.message, e.data || '');
    pushLog('ERROR', req.url + ' ' + e.message + ' ' + JSON.stringify(e.data || ''));
    // 调 SAAS 出错 → 返回明确错误,AI 侧据此转人工
    sendJSON(res, 502, { error: 'Upstream SAAS error', detail: e.message });
  }
});

server.listen(CONFIG.PORT, () => {
  console.log(`Minitable REAL backend on http://localhost:${CONFIG.PORT}`);
  console.log(`API_BASE: ${CONFIG.API_BASE}`);
  if (CONFIG.API_BASE.includes('REPLACE') || CONFIG.API_USER.includes('REPLACE')) {
    console.log('⚠️  还没配置真实 API_BASE / 账号密码,当前无法调通 SAAS。见文件顶部 CONFIG。');
  }
  console.log('Endpoints:', Object.keys(routes).join(' '));
});
