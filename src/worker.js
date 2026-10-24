/**
 * 家計簿 中継役(Cloudflare Worker)
 *
 * アプリ(iPhone/PC)とデータベースの間に立って、取引データの読み書きを代行します。
 * データの置き場所は、2通りから選べます(BACKEND で切り替え):
 *   ・Notion(これまで)        … Notion のデータベース
 *   ・Cloudflare D1(おすすめ)   … Cloudflare の中のデータベース。速い・Notionの回数制限がない
 *
 * 必要な設定(Cloudflare の「Variables and Secrets」「Bindings」):
 *   APP_KEY       (Secret)  アプリ用の合言葉(長いランダムな文字列)
 *   BACKEND       (Text)    "d1" にすると D1 を使う。空なら Notion を使う
 *   DB            (D1 binding)  D1 データベース(変数名は DB)
 *   NOTION_TOKEN  (Secret)  Notion のトークン(Notion を使うとき、または D1 へ引っ越すとき)
 *   DATABASE_ID   (Text)    f2354415a18f425990a2628d13d3e025(同上)
 *
 * API:
 *   GET  /api/transactions   → {records, next, server_time}
 *        ?since=ISO日時   その日時以降に変更された取引だけ(削除されたものは deleted:true 付き)
 *        ?cursor=...      続きのページ(1回で最大4,000件まで返す)
 *   POST /api/apply          → アプリでの編集 {edits, added, deleted} を Notion に反映
 *   GET/POST /api/settings   → 端末間で共有する設定(カテゴリーの学習結果・予算・サブスク除外など)
 *   POST /api/import         → [取引, ...] を追加(CSV取り込み用。同じ tx_id は無視)
 *   POST /api/ingest         → iPhoneの背面タップ・PCのホットキーの、読み取り結果 {raw, ...} を1件追加(D1のとき)
 *   GET  /api/info           → {backend, d1, notion, rows}  いまの状態の確認
 *   POST /api/migrate        → Notion の全データを D1 にコピー(何度やっても同じ結果。?cursor= で続きから)
 * 認証: リクエストヘッダ  X-App-Key: <APP_KEY>
 */

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-Server-Time",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });

/* 定数時間比較(合言葉の文字数や一致箇所を、応答時間から推測されないように) */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

/* ---------- 安全のための部品 ---------- */
// 背面タップ・メール用の「書き込み専用の鍵」。合言葉(APP_KEY)から、一方向に作る(合言葉は、逆算できない)。
// アプリが、同じ式で作って、ショートカットやスクリプトに渡す。この鍵が漏れても、読み出し・編集・削除はできず、/api/ingest と /api/mail への追加だけ。
async function ingestKey(env) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(env.APP_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode("kakeibo-ingest-v1")));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const INGEST_PATHS = ["/api/ingest", "/api/mail"];
const MAX_BODY = 1000000;       // 1回に受け取る大きさ(約1MB)。これを超えるものは断る
async function readJson(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) throw new Error("送られたデータが大きすぎます");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("送られたデータが大きすぎます");
  return JSON.parse(text || "null");
}
// 文字が、極端に長いものを、切り詰める(データベースを、巨大な文字で埋められないように)
const CLAMP = { id: 200, merchant: 300, raw: 6000, default: 500 };
function clampRec(r) {
  const o = {};
  for (const [k, v] of Object.entries(r || {})) {
    if (typeof v === "string") o[k] = v.slice(0, CLAMP[k] || CLAMP.default);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) o[k] = v;
  }
  return o;
}
// 合言葉を間違えた回数を、IPごとに数える。短い時間に何度も間違えたら、一時的に断る(総当たりへの備え)
const RL_MAX = 20, RL_WINDOW = 10 * 60 * 1000;
async function rlKey(request) { return "rl:" + (request.headers.get("CF-Connecting-IP") || "unknown"); }
async function rlBlocked(env, key) {
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(key).first();
    if (!r) return false;
    const o = JSON.parse(r.v);
    return Date.now() - o.t < RL_WINDOW && o.n >= RL_MAX;
  } catch (e) { return false; }
}
async function rlFail(env, key) {
  if (!env.DB) return;
  try {
    await ensureSchema(env);
    const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(key).first();
    let o = { n: 0, t: Date.now() };
    if (r) { try { const p = JSON.parse(r.v); if (Date.now() - p.t < RL_WINDOW) o = p; } catch (e) { /* 壊れていたら、数え直す */ } }
    o.n += 1;
    await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(key, JSON.stringify(o)).run();
  } catch (e) { /* 数えられなくても、断るだけは続ける */ }
}

async function notion(env, method, path, body) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(NOTION + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status !== 429) break;   // 通信が多すぎるときは、指定された秒数だけ待ってやり直す
    const wait = Math.min(Number(res.headers.get("Retry-After")) || 1, 5);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

/* ---------- Notion のページ <-> 取引レコード ---------- */
const text = (p) => ((p && (p.rich_text || p.title)) || []).map((t) => t.plain_text || "").join("").trim();
const sel = (p) => (p && p.select ? p.select.name : "");
const amountToInt = (s) => { const d = String(s || "").replace(/[^0-9]/g, ""); return d ? parseInt(d, 10) : null; };

function pageToRecord(page) {
  const p = page.properties;
  const amount = text(p.amount);
  let value = p.amount_value && typeof p.amount_value.number === "number" ? p.amount_value.number : null;
  if (value === null) { const m = amountToInt(amount); value = m === null ? null : -m; } // 値がなければ支出扱い
  const raw = text(p.raw);
  let merchant = text(p.merchant);
  let date = text(p.date);
  const src = sel(p.source);
  // iPhoneのショートカットで取れなかった店名・日時は、OCR全文(raw)から補う
  if (!merchant || isNoise(merchant) || !date) {
    if (/^\s*\{/.test(raw)) {            // CSV取り込みの行: 元の行(JSON)から、取引先を取り出す
      if (!merchant || /^\s*\{/.test(merchant)) { try { const j = JSON.parse(raw); merchant = j["取引先"] || j["摘要内容"] || j["摘要"] || merchant; } catch (e) { /* 読めなければ、そのまま */ } }
    } else if (/^paypay_ocr/.test(src) && (!merchant || isNoise(merchant))) {
      merchant = pickMerchant(raw) || merchant;
    }
    if (!date) { const m = raw.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}時\d{1,2}分/); date = m ? m[0].replace(/\s+/g, "") : ""; }
  }
  // 個人間送金: 「〇〇さんから受け取る」は収入、「〇〇さんに送る」は支出
  let type = text(p.transaction_type) || "支払い";
  if (value !== null) {
    if (/さんから受け取る\s*$/.test(merchant)) { value = Math.abs(value); type = "受け取った金額"; }
    else if (/さんに送る\s*$/.test(merchant)) { value = -Math.abs(value); type = "送った金額"; }
  }
  const rec = {
    id: text(p.tx_id) || "notion_" + page.id.replace(/-/g, ""),
    date,
    captured_at: text(p.captured_at),
    amount,
    amount_value: value,
    merchant,
    transaction_type: type,
    status: sel(p.status) || "confirmed",
    source: sel(p.source) || "paypay_ocr",
    raw,
  };
  const cat = text(p.category);
  if (cat) rec.category = cat;
  return rec;
}

// OCR(スクリーンショットの文字読み取り)の店名の選び方
//  ・画面上部の、時刻・電波(「•ll 4G (」「a1l 5G」など)・電池・数字だけの行は、店名にしない
//  ・「〇〇さんから受け取る/に送る」の行があれば、それを店名にする
//  ・同じ行が続くとき(例: ガスト / ガスト)は、それが店名。「店」で終わる支店名が最後なら、その前の行が店名
const OCR_SIGNAL_TOK = /^[aun]?[l1iI|]{2,3}$/i;        // 電波の棒(「ll」「a1l」「ull」など。「P1」のような店名は含めない)
const OCR_STATUS_TOK = /^(?:[aun]?[l1iI|]{2,3}|\d{1,2}G\+?|LTE|Wi-?Fi|[()（）oO0口■▪])$/i;
function ocrStatusLine(s) {
  const t = String(s || "").replace(/[•·●○◦▪]/g, " ").trim();
  if (!t) return true;
  const toks = t.split(/\s+/);
  return toks.every((k) => OCR_STATUS_TOK.test(k)) && toks.some((k) => /^(?:\d{1,2}G\+?|LTE|Wi-?Fi)$/i.test(k) || OCR_SIGNAL_TOK.test(k));
}
function isNoise(line) {
  const s = (line || "").trim();
  return !s || /^\d{1,2}:\d{2}$/.test(s) || s.length < 2 || !/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(s) || ocrStatusLine(s);
}
function pickMerchant(raw) {
  const lines = String(raw || "").split(/\s*\/\s*/).map((x) => x.trim());
  const p2p = lines.find((l) => /さん(?:から受け取る|に送る)\s*$/.test(l));
  if (p2p) return p2p;
  const di = lines.findIndex((l) => /\d{4}年\d{1,2}月\d{1,2}日/.test(l));
  const pre = (di >= 0 ? lines.slice(0, di) : lines).filter((l) => !isNoise(l));
  if (!pre.length) return "";
  const rep = pre.find((l, i) => i > 0 && l === pre[i - 1]);
  if (rep) return rep;
  const last = pre[pre.length - 1];
  if (pre.length >= 3 && /(?:店|支店|営業所|本店)$/.test(last)) return pre[pre.length - 2];
  return pre[0];
}

const rt = (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 2000) } }] : [] });

/* 取引レコード(の一部)を Notion のプロパティに変換 */
function recordToProps(r) {
  const props = {};
  if ("merchant" in r) props.merchant = { title: [{ text: { content: String(r.merchant || "").slice(0, 2000) } }] };
  if ("date" in r) props.date = rt(r.date);
  if ("captured_at" in r) props.captured_at = rt(r.captured_at);
  if ("amount" in r) props.amount = rt(r.amount);
  if ("amount_value" in r && typeof r.amount_value === "number") props.amount_value = { number: r.amount_value };
  if ("transaction_type" in r) props.transaction_type = rt(r.transaction_type);
  if ("category" in r) props.category = rt(r.category);
  if ("status" in r && r.status) props.status = { select: { name: r.status } };
  if ("source" in r && r.source) props.source = { select: { name: r.source } };
  if ("raw" in r) props.raw = rt(r.raw);
  if ("id" in r && !String(r.id).startsWith("notion_")) props.tx_id = rt(r.id);
  return props;
}

/* ---------- 処理 ---------- */
const SETTINGS_ID = "__settings__";   // 設定を保存する特別な行のID(取引としては返さない)
const MAX_PAGES = 40;                // 1回のリクエストで外部通信は50回まで(無料枠)なので、40ページ(4,000件)で区切る

async function listPageNotion(env, { since, cursor }) {
  const serverTime = new Date().toISOString();   // 取得を始める前の時刻(取りこぼし防止のため先に控える)
  const records = [];
  let next = cursor || null, pages = 0;
  do {
    const body = { page_size: 100 };
    body.filter = since
      ? { timestamp: "last_edited_time", last_edited_time: { after: since } }   // 削除済みも含めて変更分を返す
      : { property: "deleted", checkbox: { equals: false } };
    if (next) body.start_cursor = next;
    const res = await notion(env, "POST", `/databases/${env.DATABASE_ID}/query`, body);
    pages++;
    for (const page of res.results) {
      if (text(page.properties.tx_id) === SETTINGS_ID) continue;
      const rec = pageToRecord(page);
      if (since && page.properties.deleted && page.properties.deleted.checkbox) rec.deleted = true;
      records.push(rec);
    }
    next = res.has_more ? res.next_cursor : null;
  } while (next && pages < MAX_PAGES);
  return { records, next, server_time: serverTime };
}

/* ---------- 端末間で共有する設定 ---------- */
// カテゴリーの学習結果は端末ごとの追加分を合わせる(同じ店名は送ってきた側を優先)。それ以外は送ってきた内容に置き換える。
function mergeSettings(current, incoming) {
  const merged = { ...current, ...incoming, learned: { ...(current.learned || {}), ...(incoming.learned || {}) } };
  for (const k of Object.keys(merged.learned)) if (merged.learned[k] === null) delete merged.learned[k];   // null は「この学習を取り消す」の合図
  return merged;
}
const rtLong = (s) => {
  const out = [];
  for (let i = 0; i < s.length && out.length < 100; i += 2000) out.push({ text: { content: s.slice(i, i + 2000) } });
  return { rich_text: out };
};

async function findSettingsPage(env) {
  const res = await notion(env, "POST", `/databases/${env.DATABASE_ID}/query`, {
    page_size: 1,
    filter: { property: "tx_id", rich_text: { equals: SETTINGS_ID } },
  });
  return res.results[0] || null;
}

async function getSettingsNotion(env) {
  const page = await findSettingsPage(env);
  if (!page) return {};
  try { return JSON.parse(text(page.properties.raw) || "{}"); } catch (e) { return {}; }
}

async function saveSettingsNotion(env, incoming) {
  const page = await findSettingsPage(env);
  let current = {};
  if (page) { try { current = JSON.parse(text(page.properties.raw) || "{}"); } catch (e) {} }
  const merged = mergeSettings(current, incoming);
  const raw = rtLong(JSON.stringify(merged));
  if (page) {
    await notion(env, "PATCH", `/pages/${page.id}`, { properties: { raw } });
  } else {
    await notion(env, "POST", "/pages", {
      parent: { database_id: env.DATABASE_ID },
      properties: {
        merchant: { title: [{ text: { content: "(設定・触らないでください)" } }] },
        tx_id: rt(SETTINGS_ID),
        raw,
        imported: { checkbox: true },
        deleted: { checkbox: true },   // 取引としては数えない
      },
    });
  }
  return merged;
}

/* 取引ID → Notion のページID */
async function findPageId(env, id) {
  if (String(id).startsWith("notion_")) {
    const h = id.slice(7);
    if (/^[0-9a-f]{32}$/i.test(h)) return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const res = await notion(env, "POST", `/databases/${env.DATABASE_ID}/query`, {
    page_size: 1,
    filter: { property: "tx_id", rich_text: { equals: String(id) } },
  });
  return res.results[0] ? res.results[0].id : null;
}

async function applyOverlayNotion(env, o) {
  let edited = 0, added = 0, deleted = 0;
  for (const [id, fields] of Object.entries(o.edits || {})) {
    const pid = await findPageId(env, id);
    if (!pid) continue;
    const { id: _ignore, ...rest } = fields;
    await notion(env, "PATCH", `/pages/${pid}`, { properties: recordToProps(rest) });
    edited++;
  }
  for (const id of o.deleted || []) {
    const pid = await findPageId(env, id);
    if (!pid) continue;
    await notion(env, "PATCH", `/pages/${pid}`, { properties: { deleted: { checkbox: true } } });
    deleted++;
  }
  for (const r of o.added || []) {
    if (!r.id || (await findPageId(env, r.id))) continue;
    await notion(env, "POST", "/pages", {
      parent: { database_id: env.DATABASE_ID },
      properties: { ...recordToProps(r), imported: { checkbox: true }, deleted: { checkbox: false } },
    });
    added++;
  }
  return { edited, added, deleted };
}

const MAX_IMPORT = 40;   // 確認1回 + 作成40回 = 41回。無料枠の「外部通信は1リクエストあたり50回まで」に収まる

async function importRecordsNotion(env, list) {
  if (!Array.isArray(list) || list.length > MAX_IMPORT) throw new Error(`1回に送れるのは${MAX_IMPORT}件までです`);
  let added = 0, skipped = 0;
  const ids = list.map((r) => r.id).filter(Boolean).map(String);
  const existing = new Set();
  if (ids.length) {
    const res = await notion(env, "POST", `/databases/${env.DATABASE_ID}/query`, {
      page_size: 100,
      filter: { or: ids.map((id) => ({ property: "tx_id", rich_text: { equals: id } })) },
    });
    for (const pg of res.results) existing.add(text(pg.properties.tx_id));
  }
  for (const r of list) {
    if (!r.id || existing.has(String(r.id))) { skipped++; continue; }
    await notion(env, "POST", "/pages", {
      parent: { database_id: env.DATABASE_ID },
      properties: { ...recordToProps(r), imported: { checkbox: true }, deleted: { checkbox: false } },
    });
    added++;
  }
  return { added, skipped };
}

/* =====================================================================
   Cloudflare D1 版(BACKEND = "d1")
   表: tx(id, data=取引のJSON, updated_at, deleted) と kv(k, v=設定のJSON)
   ===================================================================== */
// D1がつながっていて、Notionの設定がなければ、自動でD1を使う(新しく使う人は、BACKENDの設定が要らない)。
// Notionの設定が残っている場合は、BACKEND=d1 にするまで、Notionのまま
const useD1 = (env) => !!env.DB && (String(env.BACKEND || "").toLowerCase() === "d1" || (!env.NOTION_TOKEN && !env.DATABASE_ID));
const VERSION = 4;               // Workerの版。アプリが、最新の版と比べて、更新の案内を出す(機能を足したら、1つ上げる)
const D1_LIMIT = 4000;          // 1回に返す件数
const D1_ROWS_PER_STMT = 20;     // D1は、1つの文に付けられる値が100個まで。1行に4つなので、20行ずつ
const MAX_IMPORT_D1 = 200;       // 1回に送れる件数(20行ずつ × 10文)
const EDIT_FIELDS = ["amount_value", "amount", "merchant", "date", "captured_at", "transaction_type", "category", "status", "raw", "source"];
let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tx (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS tx_updated ON tx (updated_at, id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
  ]);
  schemaReady = true;
}

async function listPageD1(env, { since, cursor }) {
  await ensureSchema(env);
  const serverTime = new Date().toISOString();
  const conds = [], params = [];
  if (since) { conds.push("updated_at > ?"); params.push(since); } else conds.push("deleted = 0");
  if (cursor) {
    const i = cursor.indexOf("|"), cu = cursor.slice(0, i), ci = cursor.slice(i + 1);
    conds.push("(updated_at > ? OR (updated_at = ? AND id > ?))"); params.push(cu, cu, ci);
  }
  const res = await env.DB.prepare(`SELECT id, data, updated_at, deleted FROM tx WHERE ${conds.join(" AND ")} ORDER BY updated_at, id LIMIT ${D1_LIMIT + 1}`).bind(...params).all();
  const rows = res.results || [], more = rows.length > D1_LIMIT, page = more ? rows.slice(0, D1_LIMIT) : rows;
  const records = page.map((r) => {
    let rec = {}; try { rec = JSON.parse(r.data); } catch (e) { /* 壊れた行は、IDだけ返す */ }
    rec.id = r.id;
    if (since && r.deleted) rec.deleted = true;
    return rec;
  });
  const last = page[page.length - 1];
  return { records, next: more && last ? `${last.updated_at}|${last.id}` : null, server_time: serverTime };
}

const insertSql = (n, upsert) => `INSERT ${upsert ? "" : "OR IGNORE "}INTO tx (id, data, updated_at, deleted) VALUES ${Array(n).fill("(?,?,?,?)").join(",")}` +
  (upsert ? " ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted" : "");

/* 取引を、20行ずつの文にして、まとめて書く。戻り値: 新しく入った件数 */
async function insertTx(env, rows, upsert) {
  const stmts = [];
  for (let i = 0; i < rows.length; i += D1_ROWS_PER_STMT) {
    const part = rows.slice(i, i + D1_ROWS_PER_STMT), params = [];
    part.forEach((r) => params.push(r.id, r.data, r.updated_at, r.deleted ? 1 : 0));
    stmts.push(env.DB.prepare(insertSql(part.length, upsert)).bind(...params));
  }
  if (!stmts.length) return 0;
  const res = await env.DB.batch(stmts);
  return res.reduce((a, x) => a + ((x.meta && x.meta.changes) || 0), 0);
}

async function importRecordsD1(env, list) {
  if (!Array.isArray(list) || list.length > MAX_IMPORT_D1) throw new Error(`1回に送れるのは${MAX_IMPORT_D1}件までです`);
  await ensureSchema(env);
  const now = new Date().toISOString(), seen = new Set(), rows = [];
  for (const r of list) {
    if (!r || !r.id || seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    const { id, ...rest } = clampRec(r);
    rows.push({ id: String(id), data: JSON.stringify(rest), updated_at: now, deleted: 0 });
  }
  const added = await insertTx(env, rows, false);
  return { added, skipped: list.length - added };
}

async function applyOverlayD1(env, o) {
  await ensureSchema(env);
  const now = new Date().toISOString(), stmts = [], kinds = [];
  for (const [id, fields] of Object.entries(o.edits || {})) {
    const patch = {};
    const f = clampRec(fields);
    for (const k of EDIT_FIELDS) if (k in f) patch[k] = f[k];
    if (!Object.keys(patch).length) continue;
    stmts.push(env.DB.prepare("UPDATE tx SET data = json_patch(data, ?), updated_at = ? WHERE id = ?").bind(JSON.stringify(patch), now, String(id)));
    kinds.push("edited");
  }
  for (const id of o.deleted || []) {
    stmts.push(env.DB.prepare("UPDATE tx SET deleted = 1, updated_at = ? WHERE id = ?").bind(now, String(id)));
    kinds.push("deleted");
  }
  const out = { edited: 0, added: 0, deleted: 0 };
  if (stmts.length) {
    const res = await env.DB.batch(stmts);
    res.forEach((x, i) => { out[kinds[i]] += (x.meta && x.meta.changes) || 0; });
  }
  const rows = [];
  for (const r of o.added || []) {
    if (!r || !r.id) continue;
    const { id, ...rest } = clampRec(r);
    rows.push({ id: String(id), data: JSON.stringify(rest), updated_at: now, deleted: 0 });
  }
  out.added = await insertTx(env, rows, false);
  return out;
}

async function getSettingsD1(env) {
  await ensureSchema(env);
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = 'settings'").first();
  try { return r ? JSON.parse(r.v) : {}; } catch (e) { return {}; }
}

async function saveSettingsD1(env, incoming) {
  const merged = mergeSettings(await getSettingsD1(env), incoming);
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES ('settings', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(merged)).run();
  return merged;
}

/* iPhoneの背面タップ・PCのホットキーの読み取り結果を、1件の取引にして、書く */
async function sha16(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function ingestD1(env, body) {
  const b = body || {};
  const raw = String(b.raw || "").trim();
  if (!raw) throw new Error("raw(読み取った文字)が空です");
  const norm = raw.replace(/\s*\n\s*/g, " / ");           // 改行は「 / 」でつなぐ(アプリは、この形で読む)
  const src = String(b.source || "paypay_ocr");
  let merchant = String(b.merchant || "").trim();
  if (!merchant || isNoise(merchant)) merchant = pickMerchant(norm) || merchant;
  const dm = norm.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}時\d{1,2}分/);
  const date = String(b.date || "") || (dm ? dm[0].replace(/\s+/g, "") : "");
  const am = norm.match(/[0-9]{1,3}(?:,[0-9]{3})*円/);
  const amount = String(b.amount || "") || (am ? am[0] : "");
  const mag = amountToInt(amount);
  let value = typeof b.amount_value === "number" ? b.amount_value : (mag === null ? null : -mag);
  let type = String(b.transaction_type || "支払い");
  if (value !== null) {
    if (/さんから受け取る\s*$/.test(merchant) || (/受け取り完了/.test(norm) && value < 0)) { value = Math.abs(value); type = "受け取った金額"; }
    else if (/さんに送る\s*$/.test(merchant)) { value = -Math.abs(value); type = "送った金額"; }
  }
  const done = /支払い完了|受け取り完了|送金完了|送りました/.test(norm);
  const capturedAt = String(b.captured_at || new Date().toISOString().slice(0, 19).replace("T", " "));
  const rec = {
    id: String(b.id || "ocr_" + (await sha16(norm + "|" + capturedAt))),
    date, captured_at: capturedAt, amount, amount_value: value, merchant,
    transaction_type: type, status: String(b.status || (done ? "confirmed" : "needs_review")), source: src, raw: norm,
  };
  const res = await importRecordsD1(env, [rec]);
  return { ok: true, id: rec.id, merchant, amount, status: rec.status, added: res.added };
}

/* ---------- メール(Apps Script などから送られてきた「ご利用のお知らせ」)を取引にする ---------- */
// 差出人のドメイン → 履歴に出る名前。ここにないカードは、差出人の表示名を使う
const CARD_SENDERS = [
  ["vpass.ne.jp", "三井住友カード"], ["smbc-card.com", "三井住友カード"],
  ["rakuten-card.co.jp", "楽天カード"], ["jcb.co.jp", "JCBカード"], ["paypay-card.co.jp", "PayPayカード"],
  ["aeon.co.jp", "イオンカード"], ["aeonbank.co.jp", "イオンカード"], ["saisoncard.co.jp", "セゾンカード"],
  ["cr.mufg.jp", "三菱UFJニコス"], ["mufg-nicos.co.jp", "三菱UFJニコス"], ["epos.co.jp", "エポスカード"],
  ["viewsnet.jp", "ビューカード"], ["dccard.co.jp", "DCカード"], ["orico.co.jp", "オリコカード"],
  ["amex.co.jp", "アメックス"], ["americanexpress.com", "アメックス"], ["diners.co.jp", "ダイナース"],
  ["sony-bank.co.jp", "ソニー銀行"], ["sbishinseibank.co.jp", "SBI新生銀行"], ["rakuten-bank.co.jp", "楽天銀行"],
  ["paypay-bank.co.jp", "PayPay銀行"], ["gmo-aozora.com", "GMOあおぞらネット銀行"], ["smbc.co.jp", "三井住友銀行"],
  ["netbk.co.jp", "住信SBIネット銀行"], ["sumishinsbi", "住信SBIネット銀行"], ["mizuhobank.co.jp", "みずほ銀行"],
  ["resonabank.co.jp", "りそな銀行"],
];
const MAIL_GENERIC = {
  date: ["ご利用日時", "ご利用日", "利用日時", "利用日", "ご利用年月日", "お取引日時", "お取引日", "取引日時", "取引日", "決済日時", "決済日", "承認日時"],
  merchant: ["ご利用先", "ご利用店名", "利用店名", "利用先", "ご利用店", "店舗名", "加盟店名", "ご利用加盟店", "加盟店", "ご利用場所", "利用場所", "お取引内容", "ご利用内容", "お取引先", "ご利用箇所"],
  amount: ["ご利用金額", "利用金額", "お支払い金額", "お支払金額", "決済金額", "引落金額", "ご請求金額", "お取引金額", "金額"],
};
const labelRe = (labels, tail) => new RegExp("(?:" + labels.join("|") + ")[\\s]*[】\\]:：]?\\s*" + tail);
const pad2 = (n) => ("0" + n).slice(-2);

function cardNameOf(from) {
  const f = String(from || "").toLowerCase();
  for (const [dom, name] of CARD_SENDERS) if (f.includes(dom)) return name;
  const disp = String(from || "").replace(/<[^>]*>/g, "").replace(/["']/g, "").trim();
  if (disp) return disp.slice(0, 20).replace(/[,\n<>"'&`]/g, " ").trim() || "カード";      // 画面に出る名前なので、記号は除く
  const m = f.match(/@([a-z0-9.-]+)/);
  return m ? m[1] : "カード";
}

/* 三菱UFJ-JCBデビット(【ご利用日時】の形式) */
function parseUfjMail(body, id) {
  const text = body.replace(/\s+/g, " ");
  const d = text.match(/【ご利用日時[^】]*】\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  const a = text.match(/【ご利用金額】\s*([\d,]+)\s*円/);
  const s = text.match(/【ご利用先】\s*(.*?)\s*(?:ご利用先名等|$)/);
  if (!d || !a) return null;
  const amount = parseInt(a[1].replace(/,/g, ""), 10);
  const at = text.indexOf("【ご利用日時");
  return {
    id: "ufj_mail_" + id, date: `${d[1]}/${pad2(d[2])}/${pad2(d[3])} ${pad2(d[4])}:${d[5]}:00`, amount: a[1], amount_value: -amount,
    merchant: s ? s[1].trim() : "", transaction_type: "デビット支払い", status: "confirmed", source: "ufj_mail", raw: text.slice(at, at + 300),
  };
}

/* ほかのカード・銀行(見出しの言葉で、日時・金額・利用先を探す) */
function parseCardMail(rawBody, id, name) {
  const body = String(rawBody || "").replace(/\r/g, "").normalize("NFKC");
  const flat = body.replace(/\s+/g, " ");
  const dateRe = labelRe(MAIL_GENERIC.date, "(\\d{4})[\\/\\-年.](\\d{1,2})[\\/\\-月.](\\d{1,2})日?\\s*(?:\\(.\\))?\\s*(?:(\\d{1,2})[:時](\\d{2}))?");
  const amountRe = labelRe(MAIL_GENERIC.amount, "(?:JPY|[¥￥])?\\s*([\\d,]+)\\s*(?:円|JPY|日本円)?");
  const merchantRe = labelRe(MAIL_GENERIC.merchant, "([^\\n]+)");
  const d = flat.match(dateRe), a = flat.match(amountRe);
  if (!d || !a) return null;
  const amount = parseInt(a[1].replace(/,/g, ""), 10);
  if (!amount) return null;
  const mm = body.match(merchantRe);
  const refund = /取消|キャンセル|返金|返品/.test(body.slice(0, 600)) && !/取消しできません/.test(body);
  const time = d[4] ? pad2(d[4]) + ":" + d[5] + ":00" : "00:00:00";
  const merchant = mm ? mm[1].replace(/\s+/g, " ").trim().replace(/(?:ご利用金額|利用金額).*$/, "").trim() : "";
  const at = Math.max(0, flat.search(dateRe));
  return {
    id: "card_mail_" + name + "_" + id, date: `${d[1]}/${pad2(d[2])}/${pad2(d[3])} ${time}`, amount: a[1],
    amount_value: refund ? amount : -amount, merchant, transaction_type: refund ? "返金" : "カード支払い", status: "confirmed",
    source: "card_mail:" + name, raw: flat.slice(at, at + 300),
  };
}

async function mailD1(env, b) {
  const body = String((b && b.body) || ""), from = String((b && b.from) || ""), subject = String((b && b.subject) || "");
  const id = String((b && b.id) || "") || (await sha16(from + "|" + subject + "|" + body.slice(0, 500)));
  if (!body.trim()) return { ok: true, status: "ignored", reason: "本文が空です" };
  let rec = null;
  if (/jcbdebit\.bk\.mufg\.jp/i.test(from) || /【ご利用日時/.test(body)) rec = parseUfjMail(body, id);
  else if (/ご利用|利用のお知らせ|デビット|ｖｉｓａ|visa|カード利用|決済|お取引|承認/i.test(subject + body.slice(0, 200))) rec = parseCardMail(body, id, cardNameOf(from));
  if (!rec) return { ok: true, status: "ignored", reason: "取引のお知らせとして読めませんでした" };
  if (b && b.dry) return { ok: true, status: "dry", record: rec };      // 動作確認用: 読み取り結果だけ返して、保存しない
  const res = await importRecordsD1(env, [rec]);
  return { ok: true, status: res.added ? "added" : "duplicate", id: rec.id, source: rec.source, merchant: rec.merchant, amount: rec.amount };
}

/* Notion の全データを D1 にコピーする。何度やっても同じ結果(同じIDは上書き)。1回に最大 20ページ(2,000件)まで */
async function migrateFromNotion(env, cursor) {
  if (!env.DB) throw new Error("D1(変数名 DB)が、Workerにつながっていません");
  if (!env.NOTION_TOKEN || !env.DATABASE_ID) throw new Error("NOTION_TOKEN と DATABASE_ID が必要です");
  await ensureSchema(env);
  let next = cursor || null, pages = 0, copied = 0, settings = false;
  const now = new Date().toISOString();
  do {
    const res = await notion(env, "POST", `/databases/${env.DATABASE_ID}/query`, { page_size: 100, ...(next ? { start_cursor: next } : {}) });
    pages++;
    const rows = [];
    for (const page of res.results) {
      const id0 = text(page.properties.tx_id);
      if (id0 === SETTINGS_ID) {
        try { const cur = await getSettingsD1(env); const fromNotion = JSON.parse(text(page.properties.raw) || "{}");
          await env.DB.prepare("INSERT INTO kv (k, v) VALUES ('settings', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(mergeSettings(fromNotion, cur))).run(); settings = true; } catch (e) { /* 設定が読めなくても、取引のコピーは続ける */ }
        continue;
      }
      const rec = pageToRecord(page), { id, ...rest } = rec;
      const edited = page.last_edited_time || now;
      rows.push({ id: String(id), data: JSON.stringify(rest), updated_at: new Date(edited).toISOString(), deleted: page.properties.deleted && page.properties.deleted.checkbox ? 1 : 0 });
    }
    copied += rows.length;
    await insertTx(env, rows, true);
    next = res.has_more ? res.next_cursor : null;
  } while (next && pages < 20);
  return { copied, next, done: !next, settings };
}

async function infoD1(env) {
  const out = { weakKey: String(env.APP_KEY || "").length < 16, version: VERSION, backend: useD1(env) ? "d1" : "notion", d1: !!env.DB, notion: !!(env.NOTION_TOKEN && env.DATABASE_ID), rows: null };
  if (env.DB) {
    try { await ensureSchema(env); const r = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(deleted) AS d FROM tx").first(); out.rows = (r && r.n) || 0; out.deleted = (r && r.d) || 0; } catch (e) { out.error = String(e.message || e); }
  }
  return out;
}

/* ---------- 保存先の切り替え ---------- */
const listPage = (env, a) => (useD1(env) ? listPageD1(env, a) : listPageNotion(env, a));
const getSettings = (env) => (useD1(env) ? getSettingsD1(env) : getSettingsNotion(env));
const saveSettings = (env, a) => (useD1(env) ? saveSettingsD1(env, a) : saveSettingsNotion(env, a));
const applyOverlay = (env, a) => (useD1(env) ? applyOverlayD1(env, a) : applyOverlayNotion(env, a));
const importRecords = (env, a) => (useD1(env) ? importRecordsD1(env, a) : importRecordsNotion(env, a));

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");      // ショートカットのアドレスの最後に / が付いていて、// になっても動かす
    if (!env.APP_KEY) return json({ error: "設定が不足しています: 合言葉(APP_KEY)が、まだ入っていません。Variables and secrets で、APP_KEY を追加して、Deployしてください" }, 500);
    if (!useD1(env) && (!env.NOTION_TOKEN || !env.DATABASE_ID)) return json({ error: "設定が不足しています: データベース(D1)が、まだつながっていません。Bindings で、変数名 DB のD1を追加して、Deployしてください" }, 500);
    const presented = request.headers.get("X-App-Key") || "";
    const rl = await rlKey(request);
    if (await rlBlocked(env, rl)) return json({ error: "合言葉の間違いが続いたため、しばらく受け付けません。10分ほど待ってください" }, 429);
    let authed = safeEqual(presented, env.APP_KEY);
    // 背面タップ・メール用の鍵は、取り込み用の2つの入口だけで使える
    if (!authed && request.method === "POST" && INGEST_PATHS.includes(url.pathname)) authed = safeEqual(presented, await ingestKey(env));
    if (!authed) { await rlFail(env, rl); return json({ error: "unauthorized" }, 401); }
    try {
      if (request.method === "GET" && url.pathname === "/api/transactions") {
        const out = await listPage(env, { since: url.searchParams.get("since"), cursor: url.searchParams.get("cursor") });
        const res = json(out);
        res.headers.set("X-Server-Time", out.server_time);
        return res;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") return json(await getSettings(env));
      if (request.method === "POST" && url.pathname === "/api/settings") return json(await saveSettings(env, await readJson(request)));
      if (request.method === "POST" && url.pathname === "/api/apply") return json({ ok: true, ...(await applyOverlay(env, await readJson(request))) });
      if (request.method === "POST" && url.pathname === "/api/import") return json({ ok: true, ...(await importRecords(env, await readJson(request))) });
      if (request.method === "GET" && url.pathname === "/api/info") return json(await infoD1(env));
      if (request.method === "POST" && url.pathname === "/api/migrate") return json({ ok: true, ...(await migrateFromNotion(env, url.searchParams.get("cursor"))) });
      if (request.method === "POST" && url.pathname === "/api/mail") {
        if (!useD1(env)) return json({ error: "/api/mail は、D1(BACKEND=d1)のときに使えます" }, 400);
        return json(await mailD1(env, await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/ingest") {
        if (!useD1(env)) return json({ error: "/api/ingest は、D1(BACKEND=d1)のときに使えます" }, 400);
        return json(await ingestD1(env, await readJson(request)));
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
