// ---- 假資料庫 (localStorage 模擬後端) ----
const STORAGE_KEY = "warehouse_demo_db_v10";

const DEFAULT_DB = {
  users: [
    { id: "u6", name: "震浤倉管理員", email: "zh@wms.com", password: "zh123", role: "admin", clientId: "c5" },
  ],
  // 客戶公司，一個客戶可以有多個倉庫
  clients: [
    { id: "c5", name: "震浤倉(ZH)", logoUrl: "data:image/webp;base64,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" }, // 本公司
  ],
  // 預設沒有倉庫，由管理員自行建立（或匯入備份）
  warehouses: [],
  // 預設沒有料號
  products: [],
  // 庫存以「逐台序號」追蹤：每一台在庫的實體都是一筆記錄，序號全域唯一
  serialUnits: [],
  // 異動紀錄：每一筆入庫/出庫都是單一序號的異動，並記錄時間
  movements: [],
  // 財務會計（僅震浤管理員可用）：發票、多帳戶流水帳、銀行帳戶、貸款，與庫存各自獨立
  finance: { invoices: [], ledger: [], accounts: [], loans: [], vendors: [] },
  // 人事管理（僅震浤管理員可用）：員工、請假、例假日／補休、工安證照
  hr: { employees: [], leaves: [], compDays: [], certs: [] },
};

// 補齊人事欄位（舊資料沒有 hr）。可重複執行。
function ensureHrData(d) {
  if (!d.hr || typeof d.hr !== "object") d.hr = {};
  ["employees", "leaves", "compDays", "certs"].forEach(k => { if (!Array.isArray(d.hr[k])) d.hr[k] = []; });
  return d;
}

// 補齊財務欄位，並把舊版（收款獨立存放、收支帳沒有帳戶）升級成「多帳戶流水帳」。可重複執行。
function ensureFinanceData(d) {
  ensureHrData(d);
  if (!d.finance || typeof d.finance !== "object") d.finance = {};
  const f = d.finance;
  ["invoices", "ledger", "accounts", "loans"].forEach(k => { if (!Array.isArray(f[k])) f[k] = []; });
  // 廠商記憶：第一次升級時從既有進項發票帶入；之後獨立保存，刪除發票不會忘記廠商
  if (!Array.isArray(f.vendors)) {
    const names = [...new Set(f.invoices.filter(i => i.kind === "purchase" && i.vendor).map(i => i.vendor))];
    f.vendors = names.map(name => ({ name, lastUsed: 0 }));
  }
  // 付款編號已併入支出單號
  f.invoices.forEach(i => {
    if (i.payNo && !i.expenseNo) i.expenseNo = i.payNo;
    delete i.payNo;
  });
  // 舊資料有沒指定帳戶的流水時，才需要一個帳戶來放
  const needsAccount = Array.isArray(f.payments) || f.ledger.some(e => !e.accountId);
  if (!f.accounts.length && needsAccount) f.accounts.push({ id: "acc-bank", name: "銀行帳戶", type: "bank", openingBalance: 0 });
  const defaultAccountId = f.accounts[0]?.id;
  // 舊版的收款（payments）併入流水帳：一筆收款就是一筆「客戶入帳」
  if (Array.isArray(f.payments)) {
    f.payments.forEach(p => {
      const allocations = p.invoiceId ? [{ invoiceId: p.invoiceId, amount: p.amount }] : [];
      const e = f.ledger.find(x => x.paymentId === p.id || (p.ledgerId && x.id === p.ledgerId));
      if (e) { e.clientId = p.clientId; e.allocations = allocations; }
      else f.ledger.push({ id: p.ledgerId || ("led-" + p.id), date: p.date, type: "income", category: "營業收入", amount: p.amount, counterparty: "", note: p.note || "", clientId: p.clientId, allocations });
    });
    delete f.payments;
  }
  f.ledger.forEach(e => {
    delete e.paymentId;
    if (!e.accountId) e.accountId = defaultAccountId;
    if (!Array.isArray(e.allocations)) e.allocations = [];
  });
  // 不再使用現金帳戶：沒有任何紀錄的直接移除；已有流水或貸款的先留著，避免帳目遺失
  f.accounts = f.accounts.filter(a => a.type !== "cash" || f.ledger.some(e => e.accountId === a.id) || f.loans.some(l => l.accountId === a.id));
  assignFinanceNumbers(f);
  return d;
}

// ---- 匯款自動判定 ----
const FIN_TRANSFER_LABEL = "帳戶間轉帳";
const FIN_BANK_CODE_GUESS = [[/第一/, "007"], [/富邦/, "012"], [/合作金庫|合庫/, "006"], [/[台臺]中商銀/, "053"], [/中國信託|中信/, "822"], [/國泰/, "013"]];

// 從文字（銀行摘要、收款方）找出對方帳號，判定這筆匯款：
//   transfer：帳號後五碼是公司其他帳戶 → 內部轉帳；same：同行免手續費；cross：跨行，收該帳戶的跨行手續費；none：判定不出來
function judgeBankTransfer(text, type, account, accounts) {
  const m = String(text || "").match(/(?<!\d)\d{10,19}(?!\d)/);
  if (!m || !account) return { kind: "none", fee: 0 };
  const digits = m[0];
  const target = accounts.find(a => a.id !== account.id && a.accountNo && digits.endsWith(a.accountNo));
  if (target) return { kind: "transfer", fee: 0, target };
  // 只有 19 碼（3 碼銀行代碼＋16 碼帳號）才看得出銀行；較短的多半是繳費單號（例如健保），不判定
  if (type !== "expense" || !account.bankCode || digits.length !== 19) return { kind: "none", fee: 0 };
  if (digits.slice(0, 3) === account.bankCode) return { kind: "same", fee: 0 };
  return { kind: "cross", fee: Number(account.crossBankFee) || 0 };
}

// 匯入的對帳單流水只判定一次（autoJudged），之後使用者手動改的內容不會被蓋掉。
// 對帳單的扣款金額已含手續費，所以拆成「金額＋手續費」，兩者相加不變，帳戶餘額也不變。
function autoJudgeImported(f) {
  f.ledger.forEach(e => {
    if (e.source !== "import" || e.autoJudged) return;
    const account = f.accounts.find(a => a.id === e.accountId);
    if (!account) return;
    e.autoJudged = true;
    const linked = (e.allocations || []).reduce((s, a) => s + a.amount, 0) + (e.splits || []).reduce((s, x) => s + x.amount, 0);
    const j = judgeBankTransfer(`${e.ref || ""} ${e.counterparty || ""}`, e.type, account, f.accounts);
    if (j.kind === "transfer" && !linked && !e.loanId) {
      e.category = FIN_TRANSFER_LABEL;
      e.noMatch = true;
      e.transferGroup = "tg-" + e.id;
      e.autoTransfer = true;
      if (!e.counterparty) e.counterparty = `${e.type === "income" ? "轉自" : "轉入"} ${j.target.name}`;
    } else if (j.kind === "cross" && j.fee > 0 && !e.fee && e.amount - j.fee >= Math.max(linked, 1)) {
      e.amount -= j.fee;
      e.fee = j.fee;
    }
  });
}

// 銀行帳戶代碼：第一銀行 T1、台北富邦 T2，其他銀行帳戶從 T3 往下編（可在銀行帳戶頁修改）
function assignAccountCodes(f) {
  // 銀行代碼和跨行手續費：第一銀行、台北富邦每筆 10 元，其他帳戶到銀行帳戶頁設定
  f.accounts.filter(a => a.type === "bank").forEach(a => {
    const label = `${a.name || ""} ${a.bankName || ""}`;
    if (a.bankCode === undefined) a.bankCode = (FIN_BANK_CODE_GUESS.find(([re]) => re.test(label)) || [])[1] || "";
    if (a.crossBankFee === undefined) a.crossBankFee = /第一|富邦/.test(label) ? 10 : 0;
  });
  const used = new Set(f.accounts.map(a => a.code).filter(Boolean));
  f.accounts.filter(a => a.type === "bank" && !a.code).forEach(a => {
    const label = `${a.name || ""} ${a.bankName || ""}`;
    let code = /第一/.test(label) ? "T1" : /富邦/.test(label) ? "T2" : "";
    if (!code || used.has(code)) {
      let n = 3;
      while (used.has("T" + n)) n++;
      code = "T" + n;
    }
    a.code = code;
    used.add(code);
  });
}

// 流水編號：代碼 + 兩位數月份 + 當月流水號，例如 T1 + 09 + 01 = T10901。
// 流水號依「帳戶代碼＋年月」各自累計（超過 99 筆時會變成三位數）。
// 編號一旦編上就固定不變：改帳戶、改日期、改帳戶代碼、刪除其他筆都不會重編；
// 刪掉的號碼也不會再發給新的流水（noCounters 記住每個代碼＋年月發到第幾號）。
function assignFinanceNumbers(f) {
  assignAccountCodes(f);
  autoJudgeImported(f);
  const codes = Object.fromEntries(f.accounts.filter(a => a.code).map(a => [a.id, a.code]));
  const pending = f.ledger.filter(e => !e.no && codes[e.accountId] && e.date);
  // 每次存檔都先記下目前發到第幾號，之後刪掉最後一筆也不會被新流水拿去用
  const counters = f.noCounters = f.noCounters || {};
  const key = (code, date) => `${code}|${date.slice(0, 7)}`;
  const used = new Set();
  f.ledger.forEach(e => {
    if (!e.no) return;
    used.add(e.no);
    const code = codes[e.accountId];
    if (!code || !e.date || !e.no.startsWith(code + e.date.slice(5, 7))) return;   // 換過帳戶或月份的舊編號不算進累計
    const seq = Number(e.no.slice(code.length + 2)) || 0;
    const k = key(code, e.date);
    counters[k] = Math.max(counters[k] || 0, seq);
  });
  if (!pending.length) return syncInvoicePayments(f);
  pending.sort((a, b) => a.date.localeCompare(b.date) || (a.seq || 0) - (b.seq || 0)).forEach(e => {
    const code = codes[e.accountId], k = key(code, e.date);
    let seq = counters[k] || 0, no;
    do { seq++; no = code + e.date.slice(5, 7) + String(seq).padStart(2, "0"); } while (used.has(no));
    counters[k] = seq;
    used.add(no);
    e.no = no;
  });
  syncInvoicePayments(f);
}

// 發票的支出單號、付款方式跟著連結的流水走（支出單號就是流水編號，以流水所在月份編碼）。
// 第一次連結時先記下原本的內容（prePay），全部取消連結時還原。付不足額（例如先付訂金）時，付款方式顯示「部分總額」。
// 發票日期和付款日期由使用者自己填，不會被流水改掉。
function syncInvoicePayments(f) {
  syncSplitLinks(f);
  const pays = {};
  finLedgerLinks(f).forEach(l => { (pays[l.invoiceId] = pays[l.invoiceId] || []).push(l); });
  syncLinkedVendorsAndCategories(f);
  f.invoices.forEach(inv => {
    const list = pays[inv.id];
    if (!list) {
      // 全部取消連結：還原連結前的內容；但使用者手動改過的付款方式保留
      if (inv.prePay) { Object.assign(inv, inv.prePay, inv.payMethodManual ? { payMethod: inv.payMethod } : {}); delete inv.prePay; }
      delete inv.payMethodManual;
      return;
    }
    if (!inv.prePay) inv.prePay = { expenseNo: inv.expenseNo || "", payMethod: inv.payMethod || "" };
    list.sort((a, b) => a.date.localeCompare(b.date));
    // 舊版會把付款日期改成流水日期；還原成連結前填的（只做一次）
    if ("payDate" in inv.prePay) {
      if (inv.payDate === list[list.length - 1].date) inv.payDate = inv.prePay.payDate;
      delete inv.prePay.payDate;
    }
    inv.expenseNo = [...new Set(list.map(p => p.no).filter(Boolean))].join("、");
    if (inv.kind !== "purchase" || inv.payMethodManual) return;   // 使用者手動改過付款方式，就不自動改
    const paid = list.reduce((s, p) => s + p.amount, 0);
    const before = inv.prePay.payMethod;
    inv.payMethod = paid < inv.total ? "部分總額" : (!before || before === "未付" || before === "部分總額" ? "轉帳" : before);
  });
}

// 拆分明細：
// 1. 明細編號 = 流水編號-序號（例如 T10932-1），編上就固定，刪掉中間一筆也不會重編、不會再發出去（splitSeq 記到第幾號）
// 2. 明細有填發票號碼，而且發票登錄剛好有一張同號碼的（支出對進項、收入對銷項）就自動對應；
//    號碼改了或發票刪了就解除，之後登錄了同號碼的發票也會自動對上
function finNormInvNo(s) { return String(s || "").toUpperCase().replace(/[\s-]/g, ""); }
function syncSplitLinks(f) {
  const invById = Object.fromEntries(f.invoices.map(i => [i.id, i]));
  const byNo = {};
  f.invoices.forEach(i => { const k = finNormInvNo(i.number); if (k) (byNo[`${i.kind}|${k}`] = byNo[`${i.kind}|${k}`] || []).push(i); });
  f.ledger.forEach(e => {
    const splits = e.splits || [];
    if (!splits.length) return;
    if (e.no) {
      const seqOf = x => x.no && x.no.startsWith(e.no + "-") ? Number(x.no.slice(e.no.length + 1)) || 0 : 0;
      let max = splits.reduce((m, x) => Math.max(m, seqOf(x)), e.splitSeq || 0);
      splits.forEach(x => { if (!seqOf(x)) x.no = `${e.no}-${++max}`; });
      e.splitSeq = max;
    }
    const kind = e.type === "income" ? "sales" : "purchase";
    splits.forEach(x => {
      const k = finNormInvNo(x.number);
      const cur = x.invoiceId && invById[x.invoiceId];
      if (cur && k && cur.kind === kind && finNormInvNo(cur.number) === k) return;
      delete x.invoiceId;
      const cands = k && !e.transferGroup ? byNo[`${kind}|${k}`] || [] : [];
      if (cands.length === 1) x.invoiceId = cands[0].id;
    });
  });
}
// 流水連到發票的每一筆：整筆核對（allocations）和拆分明細對應的發票（拆分的用明細編號）
function finLedgerLinks(f) {
  const out = [];
  f.ledger.forEach(e => {
    (e.allocations || []).forEach(a => out.push({ invoiceId: a.invoiceId, entryId: e.id, no: e.no || "", accountId: e.accountId, date: e.date, amount: a.amount, auto: !!a.auto }));
    (e.splits || []).forEach(x => { if (x.invoiceId) out.push({ invoiceId: x.invoiceId, entryId: e.id, splitId: x.id || "", no: x.no || e.no || "", accountId: e.accountId, date: e.date, amount: x.amount, auto: true }); });
  });
  return out;
}

// 已對到帳的支出流水和進項發票：廠商（流水的收款方 ↔ 發票的開立公司）和類別，一方空白就帶入另一方。
// 兩邊都有但不同時不在這裡改：廠商維持原樣，類別由畫面跳出提示讓使用者選。
function syncLinkedVendorsAndCategories(f) {
  const invById = Object.fromEntries(f.invoices.map(i => [i.id, i]));
  f.ledger.forEach(e => {
    if (e.type !== "expense" || e.category === FIN_TRANSFER_LABEL || e.transferGroup) return;
    const invs = (e.allocations || []).map(a => invById[a.invoiceId]).filter(i => i && i.kind === "purchase");
    if (!invs.length) return;
    const only = (key) => { const v = [...new Set(invs.map(i => i[key]).filter(Boolean))]; return v.length === 1 ? v[0] : ""; };
    // 一筆流水付多張不同廠商的發票（例如員工代墊一次報帳）時，流水的收款方不一定是廠商，所以只在單一廠商時帶入
    if (!e.counterparty && only("vendor")) e.counterparty = only("vendor");
    if (invs.length === 1 && !invs[0].vendor && e.counterparty) invs[0].vendor = e.counterparty;
    if (!e.category && only("category")) e.category = only("category");
    if (e.category) invs.forEach(i => { if (!i.category) i.category = e.category; });
  });
  // 拆分明細對應的發票：發票空白的廠商、類別、專案由明細帶入
  f.ledger.forEach(e => (e.splits || []).forEach(x => {
    const inv = x.invoiceId && invById[x.invoiceId];
    if (!inv) return;
    const category = x.category || (e.transferGroup ? "" : e.category);
    if (!inv.vendor && x.vendor) inv.vendor = x.vendor;
    if (!inv.category && category && category !== FIN_TRANSFER_LABEL) inv.category = category;
    if (!inv.project && x.project) inv.project = x.project;
  }));
}

function loadDB() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const fresh = ensureFinanceData(JSON.parse(JSON.stringify(DEFAULT_DB)));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }
  const parsed = JSON.parse(raw);
  if (!parsed.serialUnits) parsed.serialUnits = [];
  ensureFinanceData(parsed);
  // 補上新增的預設料號（依 Material 料號比對，不覆蓋既有資料），並補上舊料號缺少的所屬客戶
  DEFAULT_DB.products.forEach(defaultProduct => {
    const existing = parsed.products.find(p => p.sku === defaultProduct.sku);
    if (!existing) {
      parsed.products.push({ ...defaultProduct });
    } else if (!existing.clientId && defaultProduct.clientId) {
      existing.clientId = defaultProduct.clientId;
    }
  });
  // 補上預設的客戶 LOGO（只在客戶尚未自行設定 LOGO 時才補，不會覆蓋使用者已上傳的 LOGO）
  DEFAULT_DB.clients.forEach(defaultClient => {
    const existing = parsed.clients.find(c => c.id === defaultClient.id);
    if (existing && !existing.logoUrl && defaultClient.logoUrl) {
      existing.logoUrl = defaultClient.logoUrl;
    }
  });
  return parsed;
}

function saveDB(db) {
  if (db.finance) assignFinanceNumbers(db.finance);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function resetDB() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DB));
}
