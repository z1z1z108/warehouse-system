// ============================================================
// 財務會計（僅震浤管理員）— 核心、發票登錄、應收帳款與請款、財務報表
// 銀行帳戶、多帳戶流水帳、核對、匯入、貸款在 finance-bank.js。
//
// 資料放在 db.finance：
//   invoices : 進銷項發票（items: [{ name, qty, price, amount }] 為明細；舊資料可能沒有 items）
//   vendors  : 廠商記憶 [{ name, lastUsed }]，供登錄進項發票時提示
//   ledger   : 多帳戶流水帳（每筆有 accountId；allocations 記錄它核對了哪些發票各多少錢）
//   accounts : 銀行帳戶（現金不設帳戶：現金付款記在發票的付款方式與支出單號）
//   loans    : 貸款（用來核對每月扣款）
// 發票的「已收／已付」完全由流水帳的 allocations 算出來，不另外存。
//
// 使用 app.js 的全域物件：db、view、navigateTo、render、showMsg、todayISO、clientName、HOST_CLIENT_ID、saveDB(data.js)
// 注意：本檔在 app.js 之前載入，頂層不可呼叫 app.js 的函式，一律在函式內使用。
// ============================================================

let financeMenuOpen = false;

const FIN_PAGES = [
  { page: "fin-invoices", icon: "📄", label: "發票登錄" },
  { page: "fin-ledger", icon: "📒", label: "流水帳" },
  { page: "fin-ar", icon: "💳", label: "應收帳款" },
  { page: "fin-accounts", icon: "🏦", label: "銀行帳戶" },
  { page: "fin-loans", icon: "🏛", label: "貸款管理" },
  { page: "fin-reports", icon: "📊", label: "財務報表" },
];
// 子頁面在側邊欄要亮起的父項目
const FIN_PARENT = { "fin-entry-edit": "fin-ledger", "fin-entry-split": "fin-ledger", "fin-reconcile": "fin-ledger", "fin-import": "fin-ledger", "fin-loan-detail": "fin-loans", "fin-ar-detail": "fin-ar" };

// 流水帳類別（順序照公司原本的分類）。「代收轉付」和借款類可收可付，所以收入、支出兩邊都列。
const FIN_LOAN_PARTY_CATEGORIES = ["借款或還款", "發哥外部借款還款", "李媽媽借款或還款", "黃爸借款或還款", "謝叔借款或還款", "其他人借款或還款"];
const FIN_INCOME_CATEGORIES = ["營業收入", "罰金收入", "廢料收入", "業外收入", "貸款收入", "股票交割收入", "代收轉付", ...FIN_LOAN_PARTY_CATEGORIES];
const FIN_EXPENSE_CATEGORIES = [
  "台南辦公室租金", "中部辦公室租金", "影印機租金", "台南中華電信", "中部支出", "加油單", "事務所費用", "薪資支出",
  "購買車輛貸款", "租賃車輛租金", "合作金庫", "台北富邦", "台中商銀", "中租貸款", "中國信託", "第一銀行",
  "健保費", "勞保費", "勞退費用", "保險費用", "ETAG", "停車費", "運費", "非消耗性工具及材料", "消耗性工具及材料", "其他料件",
  "工程費用", "大型設備", "車輛修繕", "辦公室修繕", "設備工具修繕", "出差費用", "餐費", "罰單", "郵資費", "辦公室事務用品",
  "日常消耗品&食品", "手續費", "滯納金", "公共稅務支出", "證照及訓練費", "工讀生", "員工績效及福利",
  "工程-行政事務費", "工程-工程設備費", "工程-五金材料費", "代收轉付",
  "業外支出或還款", "股票交割支出", ...FIN_LOAN_PARTY_CATEGORIES,
];
const FIN_RECEIPT_CATEGORY = "營業收入";     // 登錄客戶收款時，自動寫入流水帳的類別
const FIN_TRANSFER_CATEGORY = "帳戶間轉帳";  // 自己帳戶之間轉帳：不算收入／支出，也不需要核對
const FIN_TAX_RATE = 0.05;

// 進項發票在「發票登錄」、銷項發票（開給客戶）在「應收帳款」；兩頁共用同一套表單和清單，篩選條件各自分開
const finInvFilters = {
  purchase: { kind: "purchase", status: "", month: "", q: "" },
  sales: { kind: "sales", status: "", month: "", q: "" },
};
let finInvFilter = finInvFilters.purchase;
function finInvBlankItem() { return { name: "", qty: "1", price: "" }; }
// 表單內容都留在草稿裡，切換篩選或頁面時才不會把輸入到一半的明細清掉
const FIN_VOUCHER_TYPES = ["電子發票", "統一發票", "三聯式發票", "收據", "其他"];
const FIN_PAY_UNPAID = "未付";
const FIN_PAY_CASH = "現金";
const FIN_PAY_TRANSFER = "轉帳";
const FIN_PAY_NONE = "不支出";
const FIN_PAY_PARTIAL = "部分總額";   // 先付訂金等付不足額的情況；連結流水時由系統自動判定
const FIN_PAY_METHODS = [FIN_PAY_UNPAID, "轉帳", FIN_PAY_CASH, "自動扣款", FIN_PAY_NONE, FIN_PAY_PARTIAL];
function finInvNewDraft(kind) {
  return { kind, date: "", clientId: "", taxType: "taxable", voucherType: FIN_VOUCHER_TYPES[0], number: "", vendor: "", category: "", project: "", payee: "", payMethod: kind === "purchase" ? FIN_PAY_UNPAID : "", payDate: "", expenseNo: "", note: "", tax: 0, taxTouched: false, items: [finInvBlankItem()] };
}
// 兩頁各自的草稿：在發票登錄填到一半，切到應收帳款不會被帶過去
const finInvDrafts = { purchase: finInvNewDraft("purchase"), sales: finInvNewDraft("sales") };
let finInvDraft = finInvDrafts.purchase;
function finInvMode() { return view.page === "fin-ar" ? "sales" : "purchase"; }
function finInvUseMode(mode) {
  finInvDraft = finInvDrafts[mode];
  finInvFilter = finInvFilters[mode];
  finInvDraft.kind = mode;
  finInvFilter.kind = mode;
}
const finInvExpanded = new Set();
// 「登錄發票」區塊可以收起來，只看下方的發票紀錄；收合狀態記在這台電腦的瀏覽器
let finInvFormCollapsed = (() => { try { return localStorage.getItem("wms_inv_form_collapsed") === "1"; } catch (e) { return false; } })();
function finSetInvFormCollapsed(v) {
  finInvFormCollapsed = v;
  try { localStorage.setItem("wms_inv_form_collapsed", v ? "1" : "0"); } catch (e) { /* 無法記住也沒關係 */ }
}
// 編輯發票：把內容載入表單（finInvDraft.editId 不是空的就是編輯模式），原本填到一半的內容先存在草稿的 backup
function finInvStartEdit(id) {
  const inv = db.finance.invoices.find(i => i.id === id);
  if (!inv) return;
  const d = finInvDraft;
  if (!d.editId) d.backup = JSON.parse(JSON.stringify({ ...d, backup: null }));
  const items = (inv.items || []).map(it => ({ name: it.name || "", qty: String(it.qty), price: String(it.price) }));
  Object.assign(d, {
    editId: inv.id, kind: inv.kind, date: inv.date, clientId: inv.clientId || "", taxType: inv.taxType || "taxable",
    voucherType: inv.voucherType || "", number: inv.number || "", vendor: inv.vendor || "", category: inv.category || "",
    project: inv.project || "", payee: inv.payee || "", payMethod: inv.payMethod || "", payDate: inv.payDate || "",
    expenseNo: inv.expenseNo || "", note: inv.note || "", tax: inv.tax, taxTouched: true, taxEdited: false,
    items: items.length ? items : [{ name: "", qty: "1", price: String(inv.amount) }],   // 沒有品項的發票，金額放在一行空白品項
  });
  render();
  // 捲到表單（應收帳款頁的表單不在最上面）
  document.getElementById("inv-form-toggle")?.scrollIntoView({ block: "start" });
  document.getElementById("inv-number")?.focus();
}
function finInvEndEdit() {
  Object.assign(finInvDraft, finInvDraft.backup || {}, { editId: "", taxEdited: false, backup: null });
}
let finReportYear = new Date().getFullYear();
let finReportAccount = "";

// ---------- 共用工具 ----------
function canUseFinance() {
  const u = currentUser();
  return !!u && u.role === "admin" && (!u.clientId || u.clientId === HOST_CLIENT_ID);
}
function finEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function finMoney(n) { return Number(n || 0).toLocaleString("zh-TW", { maximumFractionDigits: 0 }); }
function finId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function finMonthOf(iso) { return (iso || "").slice(0, 7); }
function finDaysSince(iso) {
  if (!iso) return 0;
  const [y, m, d] = iso.split("-").map(Number);
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / 86400000);
}
function finClients() { return db.clients.filter(c => c.id !== HOST_CLIENT_ID); }
function finPartyName(inv) { return inv.kind === "sales" ? clientName(inv.clientId) : (inv.vendor || "-"); }
function finParseAmount(raw, allowZero) {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || (n === 0 && !allowZero)) return null;
  return n;
}
function finSave() { saveDB(db); render(); }
function finDownloadCSV(filename, rows) {
  const csv = "﻿" + rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  link.download = `${filename}_${todayISO()}.csv`;
  link.click();
}
function finStatusBadge(label) {
  // 未付／未收紅色、部分黃色、不支出灰色，其餘（已付、已收、現金、轉帳、自動扣款等付款方式）綠色
  const cls = label === FIN_PAY_NONE ? "bg-slate-100 text-slate-500" : /^部分/.test(label) ? "bg-amber-100 text-amber-700" : !label || /^未/.test(label) ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700";
  return `<span class="px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${cls}">${label}</span>`;
}
function finBindFilter(id, obj, key, afterChange) {
  const el = document.getElementById(id);
  if (el) el.onchange = () => { obj[key] = el.value; if (afterChange) afterChange(); render(); };
}
function finAccountName(id) { return db.finance.accounts.find(a => a.id === id)?.name || "（已刪除帳戶）"; }
function finAccountLabel(id) {
  const a = db.finance.accounts.find(x => x.id === id);
  return a ? [a.name, a.accountNo].filter(Boolean).join(" ") : "（已刪除帳戶）";
}
function finEntryAllocated(e) { return (e.allocations || []).reduce((s, a) => s + a.amount, 0); }
function finEntrySplitTotal(e) { return (e.splits || []).reduce((s, x) => s + x.amount, 0); }
// 一筆支出依類別拆開的金額：有拆分的算到各自類別，還沒拆分的餘額留在原類別
function finEntryCategoryParts(e) {
  const parent = e.category || "未分類";
  const parts = {};
  (e.splits || []).forEach(x => { const c = x.category || parent; parts[c] = (parts[c] || 0) + x.amount; });
  const rest = e.amount - finEntrySplitTotal(e);
  if (rest > 0) parts[parent] = (parts[parent] || 0) + rest;
  return parts;
}
// 每張發票對應到哪些流水（帳戶、編號、日期、金額）
function finInvoicePayments() {
  const out = {};
  db.finance.ledger.forEach(e => (e.allocations || []).forEach(a => {
    (out[a.invoiceId] = out[a.invoiceId] || []).push({ entryId: e.id, no: e.no || "", accountId: e.accountId, date: e.date, amount: a.amount });
  }));
  Object.values(out).forEach(list => list.sort((a, b) => a.date.localeCompare(b.date)));
  return out;
}
function finNextSeq() { return db.finance.ledger.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1; }
function finIsTransfer(e) { return e.category === FIN_TRANSFER_CATEGORY || !!e.transferGroup; }

// ---------- 發票核對（已收／已付）計算 ----------
// 已核對金額 = 所有流水帳分配到這張發票的金額加總。銷項顯示「已收」，進項顯示「已付」。
function finStateLabel(kind, state) {
  const m = kind === "sales" ? { open: "未收", partial: "部分收款", settled: "已收" } : { open: "未付", partial: "部分付款", settled: "已付" };
  return m[state];
}
function finSettlement() {
  const paid = {};
  db.finance.ledger.forEach(e => (e.allocations || []).forEach(a => { paid[a.invoiceId] = (paid[a.invoiceId] || 0) + a.amount; }));
  const out = {};
  db.finance.invoices.forEach(inv => {
    // 不支出：不需要付款，不算未付也不算已付
    if (inv.payMethod === FIN_PAY_NONE) {
      out[inv.id] = { paid: 0, ledgerPaid: 0, linkRemaining: 0, total: inv.total, outstanding: 0, state: "settled", status: FIN_PAY_NONE };
      return;
    }
    // 進項發票的狀態直接跟付款方式一致：未付→未付、部分總額→部分付款、轉帳／現金／自動扣款→已付。
    // （連結流水時 syncInvoicePayments 會把付款方式改成轉帳或部分總額，狀態也就跟著變）
    // 轉帳、自動扣款仍可再連結流水，所以另外算 linkRemaining（扣掉已連結流水後還能連多少）給流水帳核對用
    const ledgerPaid = paid[inv.id] || 0;
    let p, state;
    if (inv.kind === "purchase") {
      state = !inv.payMethod || inv.payMethod === FIN_PAY_UNPAID ? "open" : inv.payMethod === FIN_PAY_PARTIAL ? "partial" : "settled";
      p = state === "settled" ? inv.total : state === "partial" ? Math.min(ledgerPaid, inv.total) : 0;
    } else {
      p = ledgerPaid;
      state = inv.total - p <= 0 ? "settled" : p > 0 ? "partial" : "open";
    }
    const outstanding = Math.max(0, inv.total - p);
    const linkRemaining = inv.payMethod === FIN_PAY_CASH ? 0 : Math.max(0, inv.total - ledgerPaid);
    // 進項發票的「狀態」直接顯示付款方式（現金、轉帳、自動扣款、未付…）；銷項維持未收／部分收款／已收
    const status = inv.kind === "purchase" ? (inv.payMethod || FIN_PAY_UNPAID) : finStateLabel(inv.kind, state);
    out[inv.id] = { paid: p, ledgerPaid, linkRemaining, total: inv.total, outstanding, state, status };
  });
  return out;
}

// ---------- 應收帳款計算 ----------
// 銷項發票未收 = 發票總額 − 已核對的流水；客戶入帳（流水帳有 clientId 的收入）還沒分配到發票的部分 = 待核對入帳。
function finComputeAR() {
  const invoiceInfo = finSettlement();
  const clients = {};
  const ensure = cid => clients[cid] || (clients[cid] = { clientId: cid, invoices: [], receipts: [], invoiced: 0, received: 0, matched: 0, outstanding: 0, unmatched: 0, oldestUnpaidDate: "" });
  db.finance.invoices.filter(i => i.kind === "sales" && i.clientId).forEach(i => ensure(i.clientId).invoices.push(i));
  db.finance.ledger.filter(e => e.type === "income" && e.clientId).forEach(e => ensure(e.clientId).receipts.push(e));
  Object.values(clients).forEach(c => {
    c.invoices.sort((a, b) => (a.date + a.number).localeCompare(b.date + b.number));
    c.invoices.forEach(inv => {
      const info = invoiceInfo[inv.id];
      c.invoiced += inv.total;
      c.matched += info.paid;
      c.outstanding += info.outstanding;
      if (info.outstanding > 0 && !c.oldestUnpaidDate) c.oldestUnpaidDate = inv.date;
    });
    c.receipts.forEach(e => {
      c.received += e.amount;
      c.unmatched += Math.max(0, e.amount - finEntryAllocated(e));
    });
  });
  return { clients, invoiceInfo };
}

// ---------- 側邊導覽 ----------
function renderFinanceNav() {
  if (!canUseFinance()) return "";
  if (view.page.startsWith("fin-")) financeMenuOpen = true;
  const current = FIN_PARENT[view.page] || view.page;
  return `
  <div>
    <button id="finance-toggle-btn" class="w-full text-left px-3 py-2 rounded hover:bg-slate-700 flex items-center justify-between">
      <span>💰 財務會計</span><span class="text-xs">${financeMenuOpen ? "▾" : "▸"}</span>
    </button>
    ${financeMenuOpen ? FIN_PAGES.map(p => `
      <button data-nav="${p.page}" class="nav-btn w-full text-left pl-8 pr-3 py-2 rounded hover:bg-slate-700 ${current === p.page ? "bg-slate-700" : ""}">${p.icon} ${p.label}</button>`).join("") : ""}
  </div>`;
}
function bindFinanceNav() {
  document.getElementById("finance-toggle-btn")?.addEventListener("click", () => {
    financeMenuOpen = !financeMenuOpen;
    render();
  });
}

function financeTitle() {
  if (!canUseFinance()) return "財務會計";   // 沒權限時標題也不可洩漏貸款、客戶名稱
  switch (view.page) {
    case "fin-invoices": return "發票登錄";
    case "fin-ledger": return "流水帳（多帳戶收支）";
    case "fin-entry-edit": return "編輯流水帳";
    case "fin-entry-split": return "拆分流水明細";
    case "fin-reconcile": return "核對流水帳";
    case "fin-import": return "匯入銀行對帳單";
    case "fin-accounts": return "銀行帳戶";
    case "fin-loans": return "貸款管理";
    case "fin-loan-detail": return `${db.finance.loans.find(l => l.id === view.finLoanId)?.name || "貸款"}－扣款核對`;
    case "fin-ar": return "客戶應收帳款與請款";
    case "fin-ar-detail": return `${clientName(view.finClientId)}－應收帳款`;
    case "fin-reports": return "財務報表";
    default: return "財務會計";
  }
}

function renderFinancePage() {
  if (!canUseFinance()) return `<div class="bg-white rounded-xl shadow-sm p-6 text-sm text-slate-500">財務會計僅限震浤管理員使用。</div>`;
  switch (view.page) {
    case "fin-invoices": return finRenderInvoices();
    case "fin-ledger": return finRenderLedger();
    case "fin-entry-edit": return finRenderEntryEdit();
    case "fin-entry-split": return finRenderEntrySplit();
    case "fin-reconcile": return finRenderReconcile();
    case "fin-import": return finRenderImport();
    case "fin-accounts": return finRenderAccounts();
    case "fin-loans": return finRenderLoans();
    case "fin-loan-detail": return finRenderLoanDetail();
    case "fin-ar": return finRenderAR();
    case "fin-ar-detail": return finRenderARDetail();
    case "fin-reports": return finRenderReports();
    default: return "";
  }
}
function bindFinancePage() {
  if (!canUseFinance()) return;
  switch (view.page) {
    case "fin-invoices": return finBindInvoices();
    case "fin-ledger": return finBindLedger();
    case "fin-entry-edit": return finBindEntryEdit();
    case "fin-entry-split": return finBindEntrySplit();
    case "fin-reconcile": return finBindReconcile();
    case "fin-import": return finBindImport();
    case "fin-accounts": return finBindAccounts();
    case "fin-loans": return finBindLoans();
    case "fin-loan-detail": return finBindLoanDetail();
    case "fin-ar": return finBindAR();
    case "fin-ar-detail": return finBindARDetail();
    case "fin-reports": return finBindReports();
  }
}

// ============================================================
// 發票登錄
// ============================================================
function finInvoiceSearchText(i) {
  return `${i.number} ${finPartyName(i)} ${i.note || ""} ${i.category || ""} ${i.project || ""} ${i.payee || ""} ${i.expenseNo || ""} ${(i.items || []).map(it => it.name).join(" ")}`;
}
// ---- 發票清單的欄位篩選（點欄位標題旁的 ▼，和庫存頁同一套） ----
// 日期預設只看今年（1/1～12/31），由 1/1 開始往下排；要看其他年份就在日期欄的 ▼ 改
function finInvThisYear() { const y = new Date().getFullYear(); return { dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` }; }
function finInvNewColFilter() {
  return { noQuery: "", ...finInvThisYear(), numberQuery: "", categories: [], itemQuery: "", statuses: [], parties: [], noteQuery: "" };
}
const finInvColFilters = { purchase: finInvNewColFilter(), sales: finInvNewColFilter() };
// 各欄要拿來篩選的值（清單型的值用 encodeURIComponent 當選項 id，名稱有 & 或引號也不會出錯）
function finInvColValues(i, st, pays) {
  const list = pays[i.id] || [];
  return {
    no: list.length ? list.map(p => p.no).join(" ") : (i.expenseNo || ""),
    category: i.category || "（未填）",
    item: (i.items || []).map(it => it.name).join(" "),
    status: st[i.id].status,
    party: finPartyName(i),
  };
}
function finInvColActive(cf) {
  const year = finInvThisYear();   // 預設的今年不算「有篩選」，清除按鈕只在改過時出現
  return !!(cf.noQuery || cf.dateFrom !== year.dateFrom || cf.dateTo !== year.dateTo || cf.numberQuery || cf.itemQuery || cf.noteQuery || cf.categories.length || cf.statuses.length || cf.parties.length);
}
function finFilteredInvoices(st, skipColumnFilters) {
  const f = finInvFilter;
  // 依日期由早到晚排列（同一天再依發票號碼）
  let rows = db.finance.invoices.slice().sort((a, b) => (a.date + a.number).localeCompare(b.date + b.number));
  if (f.kind) rows = rows.filter(i => i.kind === f.kind);
  if (f.month) rows = rows.filter(i => finMonthOf(i.date) === f.month);
  // 付款狀態篩選和清單「狀態」欄用同一組文字（進項就是付款方式），選什麼就只列出狀態欄顯示那樣的發票
  if (f.status) rows = rows.filter(i => st[i.id]?.status === f.status);
  const pays = finInvoicePayments();
  const q = f.q.trim().toLowerCase();
  if (q) rows = rows.filter(i => `${finInvoiceSearchText(i)} ${(pays[i.id] || []).map(p => p.no).join(" ")}`.toLowerCase().includes(q));
  if (skipColumnFilters) return rows;
  const cf = finInvColFilters[f.kind === "sales" ? "sales" : "purchase"];
  const has = (text, query) => !query.trim() || String(text || "").toLowerCase().includes(query.trim().toLowerCase());
  const inList = (value, selected) => !selected.length || selected.includes(encodeURIComponent(value));
  return rows.filter(i => {
    const v = finInvColValues(i, st, pays);
    return has(v.no, cf.noQuery) && has(i.number, cf.numberQuery) && has(v.item, cf.itemQuery) && has(i.note, cf.noteQuery)
      && (!cf.dateFrom || i.date >= cf.dateFrom) && (!cf.dateTo || i.date <= cf.dateTo)
      && inList(v.category, cf.categories) && inList(v.status, cf.statuses) && inList(v.party, cf.parties);
  });
}

// ---------- 發票明細 ----------
function finQty(n) { return Number(n || 0).toLocaleString("zh-TW", { maximumFractionDigits: 4 }); }
// 每行金額 = 數量 × 單價，四捨五入到整數元（先修掉小數運算誤差）
function finInvLineAmount(item) {
  const v = Number(item.qty) * Number(item.price);
  return Number.isFinite(v) ? Math.round(Number(v.toFixed(6))) : 0;
}
function finInvItemRow(item, idx) {
  return `
  <tr data-idx="${idx}" class="border-t">
    <td class="px-2 py-1 text-xs text-slate-400 text-center">${idx + 1}</td>
    <td class="px-2 py-1"><input data-field="name" value="${finEsc(item.name)}" aria-label="第 ${idx + 1} 行品項" class="w-full border rounded px-2 py-1.5 text-sm" placeholder="品項，例：RFK-7997 (28/36)"/></td>
    <td class="px-2 py-1"><input data-field="qty" type="number" min="0" step="any" value="${finEsc(item.qty)}" aria-label="第 ${idx + 1} 行數量" class="w-full border rounded px-2 py-1.5 text-sm text-right"/></td>
    <td class="px-2 py-1"><input data-field="price" type="number" step="any" value="${finEsc(item.price)}" aria-label="第 ${idx + 1} 行單價" class="w-full border rounded px-2 py-1.5 text-sm text-right" placeholder="未稅"/></td>
    <td class="px-2 py-1 text-right font-medium text-slate-700 inv-item-amount">${finMoney(finInvLineAmount(item))}</td>
    <td class="px-2 py-1 text-center"><button type="button" class="inv-item-del text-slate-400 hover:text-rose-500 px-1" title="移除這行" aria-label="移除第 ${idx + 1} 行">✕</button></td>
  </tr>`;
}
const FIN_NONE_CELL = `<span class="text-slate-300">-</span>`;
// 流水編號欄：已連結流水就列出流水編號（點了開啟核對）；還沒連結時顯示手動填的支出單號（例如 P09030、中部零用金）
function finInvNoCell(list, inv) {
  if ((list || []).length) {
    return list.map(p => `<button type="button" data-entry="${finEsc(p.entryId)}" class="inv-pay-link block text-left text-xs font-mono text-blue-600 hover:underline whitespace-nowrap" title="開啟這筆流水的核對">${finEsc(p.no) || "無編號"}</button>`).join("");
  }
  return inv.expenseNo ? `<span class="text-xs font-mono text-slate-500 whitespace-nowrap" title="手動填的支出單號，還沒連結流水">${finEsc(inv.expenseNo)}</span>` : FIN_NONE_CELL;
}
function finInvDetailHtml(inv, pays) {
  const items = inv.items || [];
  const payRecords = (pays || []).length ? `
    <table class="w-full text-xs bg-white border rounded mt-2">
      <thead class="text-slate-500 text-left"><tr><th class="px-3 py-1.5">${inv.kind === "sales" ? "收款" : "付款"}日期</th><th class="px-3 py-1.5">流水編號</th><th class="px-3 py-1.5">帳戶</th><th class="px-3 py-1.5 text-right">金額</th></tr></thead>
      <tbody>${pays.map(p => `<tr class="border-t"><td class="px-3 py-1.5">${finEsc(p.date)}</td><td class="px-3 py-1.5 font-mono">${finEsc(p.no) || "-"}</td><td class="px-3 py-1.5">${finEsc(finAccountLabel(p.accountId))}</td><td class="px-3 py-1.5 text-right font-medium">${finMoney(p.amount)}</td></tr>`).join("")}</tbody>
    </table>
    ${(() => {
      const paid = pays.reduce((s, p) => s + p.amount, 0);
      return paid < inv.total ? `<p class="text-xs text-amber-700 text-right mt-1">已付 ${finMoney(paid)}，尚欠 ${finMoney(inv.total - paid)}</p>` : "";
    })()}` : "";
  // 付款方式和編輯表單裡選的一致（連結流水時系統自動帶的，或使用者手動改的）
  const meta = [["憑證類別", inv.voucherType], ["類別", inv.category], ["專案/工程", inv.project], ["收款方", inv.payee], ["付款方式", inv.payMethod], ["付款日期", inv.payDate], ["支出單號", inv.expenseNo]].filter(([, v]) => v);
  const metaHtml = meta.length ? `<div class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600 mb-2">${meta.map(([k, v]) => `<span><span class="text-slate-400">${k}</span> ${finEsc(v)}</span>`).join("")}</div>` : "";
  const summary = `
    <div class="flex justify-end gap-6 text-xs text-slate-600 mt-2">
      <span>未稅 <b>${finMoney(inv.amount)}</b></span>
      <span>稅額 <b>${finMoney(inv.tax)}</b></span>
      <span>含稅總額 <b class="text-slate-800">${finMoney(inv.total)}</b></span>
    </div>`;
  if (!items.length) return `${metaHtml}<p class="text-xs text-slate-500">這張發票沒有登錄明細。</p>${summary}${payRecords}`;
  return `${metaHtml}
    <table class="w-full text-xs bg-white border rounded">
      <thead class="text-slate-500 text-left"><tr><th class="px-3 py-1.5 w-10 text-center">#</th><th class="px-3 py-1.5">品項</th><th class="px-3 py-1.5 text-right">數量</th><th class="px-3 py-1.5 text-right">單價</th><th class="px-3 py-1.5 text-right">金額</th></tr></thead>
      <tbody>
        ${items.map((it, n) => `
          <tr class="border-t">
            <td class="px-3 py-1.5 text-center text-slate-400">${n + 1}</td>
            <td class="px-3 py-1.5">${finEsc(it.name)}</td>
            <td class="px-3 py-1.5 text-right">${finQty(it.qty)}</td>
            <td class="px-3 py-1.5 text-right">${finQty(it.price)}</td>
            <td class="px-3 py-1.5 text-right font-medium">${finMoney(it.amount)}</td>
          </tr>`).join("")}
      </tbody>
    </table>${summary}${payRecords}`;
}

// ---------- 廠商記憶 ----------
function finVendorsSorted() { return db.finance.vendors.slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name, "zh-Hant")); }
// 大小寫不同視為同一家，避免記憶裡出現重複廠商
function finCanonicalVendor(name) {
  const key = name.toLowerCase();
  return db.finance.vendors.find(v => v.name.toLowerCase() === key)?.name || name;
}
function finRememberVendor(name) {
  const v = db.finance.vendors.find(x => x.name === name);
  if (v) v.lastUsed = Date.now();
  else db.finance.vendors.push({ name, lastUsed: Date.now() });
}
function finBindVendorCombo(input, menu, onValue) {
  let matches = [];
  let active = -1;
  const close = () => { menu.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); active = -1; };
  const paint = () => {
    const q = input.value.trim();
    const qLower = q.toLowerCase();
    matches = finVendorsSorted().filter(v => v.name.toLowerCase().includes(qLower));
    if (active >= matches.length) active = matches.length - 1;
    const exact = matches.some(v => v.name.toLowerCase() === qLower);
    const hint = !db.finance.vendors.length && !q ? "還沒有記住的廠商，登錄發票後就會記住"
      : q && !exact ? `新廠商「${finEsc(q)}」會在登錄發票後記住` : "";
    menu.innerHTML = matches.map((v, i) => `
      <div role="option" data-i="${i}" aria-selected="${i === active}" class="flex items-center justify-between gap-2 px-3 py-2 text-sm cursor-pointer ${i === active ? "bg-slate-200" : "hover:bg-slate-100"}">
        <span class="truncate">${finEsc(v.name)}</span>
        <button type="button" data-remove="${i}" tabindex="-1" class="text-slate-400 hover:text-rose-500 text-xs px-1" title="從廠商記憶移除（不影響已登錄的發票）" aria-label="從廠商記憶移除 ${finEsc(v.name)}">✕</button>
      </div>`).join("") + (hint ? `<p class="px-3 py-2 text-xs text-slate-400 ${matches.length ? "border-t" : ""}">${hint}</p>` : "");
    menu.classList.toggle("hidden", !menu.innerHTML);
    input.setAttribute("aria-expanded", String(!!menu.innerHTML));
    menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  const choose = name => { input.value = name; onValue(name); close(); };

  input.onfocus = paint;
  input.onclick = paint;
  input.oninput = () => { onValue(input.value); active = -1; paint(); };
  input.onblur = close;
  input.onkeydown = e => {
    if (e.isComposing || e.keyCode === 229) return;   // 注音／倉頡選字中的按鍵不處理
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (menu.classList.contains("hidden")) return paint();
      if (!matches.length) return;
      active = e.key === "ArrowDown" ? (active + 1) % matches.length : (active <= 0 ? matches.length : active) - 1;
      paint();
    } else if (e.key === "Enter") {
      if (active >= 0 && !menu.classList.contains("hidden")) { e.preventDefault(); choose(matches[active].name); }
      else close();
    } else if (e.key === "Escape") {
      close();
    }
  };
  // 用 mousedown 並阻止預設，輸入框才不會先失焦把選單關掉
  menu.onmousedown = e => {
    e.preventDefault();
    const removeBtn = e.target.closest("[data-remove]");
    if (removeBtn) {
      const v = matches[Number(removeBtn.dataset.remove)];
      db.finance.vendors = db.finance.vendors.filter(x => x.name !== v.name);
      saveDB(db);
      paint();
      return;
    }
    const opt = e.target.closest("[data-i]");
    if (opt) choose(matches[Number(opt.dataset.i)].name);
  };
}

function finRenderInvoices() {
  const mode = finInvMode();
  finInvUseMode(mode);
  const isSales = mode === "sales";
  const st = finSettlement();
  const d = finInvDraft;
  const clients = finClients();
  const f = finInvFilter;
  const rows = finFilteredInvoices(st);
  const sum = kind => rows.filter(i => i.kind === kind).reduce((s, i) => ({ n: s.n + 1, amount: s.amount + i.amount, tax: s.tax + i.tax, total: s.total + i.total, open: s.open + st[i.id].outstanding }), { n: 0, amount: 0, tax: 0, total: 0, open: 0 });
  const sales = sum("sales"), purchase = sum("purchase");
  const pays = finInvoicePayments();
  const distinct = key => [...new Set(db.finance.invoices.map(i => i[key]).filter(Boolean))];
  // 舊資料的選項（例如付款方式「匯款」）已不在清單時仍要列出，編輯時才不會被洗掉
  const withCurrent = (list, value) => value && !list.includes(value) ? [...list, value] : list;
  const fixedOptions = (list, value) => (value ? "" : `<option value="" selected>（未填）</option>`) + withCurrent(list, value).map(v => `<option value="${finEsc(v)}" ${v === value ? "selected" : ""}>${finEsc(v)}</option>`).join("");
  const editing = db.finance.invoices.find(i => i.id === d.editId);
  const optionsHtml = (list, selected, blankLabel) => `<option value="">${blankLabel}</option>` + withCurrent(list, selected).map(v => `<option value="${finEsc(v)}" ${v === selected ? "selected" : ""}>${finEsc(v)}</option>`).join("");
  const purchaseOnly = `inv-purchase-only ${d.kind === "purchase" ? "" : "hidden"}`;
  // 欄位篩選：表頭固定在上方（sticky），選單往下展開，才不會被表格上緣切掉
  if (typeof COLUMN_FILTERS !== "undefined") COLUMN_FILTERS.finv = () => finInvColFilters[finInvMode()];
  const colF = finInvColFilters[mode];
  const stickyTh = "px-3 py-2 sticky top-0 z-20 bg-slate-100";
  const colTh = (key, label, kind, cfg) => renderHeaderFilter("finv", key, label, kind, cfg)
    .replace('class="px-4 py-2 relative whitespace-nowrap"', `class="${stickyTh} whitespace-nowrap"`)
    .replace("left-0 bottom-full mb-1", "left-0 top-full mt-1");
  const baseRows = finFilteredInvoices(st, true);
  const listOptions = pick => [...new Set(baseRows.map(i => pick(finInvColValues(i, st, pays))))].sort((a, b) => a.localeCompare(b, "zh-Hant")).map(v => ({ id: encodeURIComponent(v), name: finEsc(v) }));

  return `
  <div class="bg-white rounded-xl shadow-sm ${finInvFormCollapsed && !editing ? "px-6 py-3" : "p-6"} mb-6 ${editing ? "ring-2 ring-amber-300" : ""}">
    <button type="button" id="inv-form-toggle" class="w-full flex items-center justify-between text-left font-semibold text-sm text-slate-700 ${finInvFormCollapsed && !editing ? "" : "mb-3"}" aria-expanded="${!(finInvFormCollapsed && !editing)}" aria-controls="inv-form-body">
      <span>${editing ? `編輯發票：${finEsc(editing.number) || "未填號碼"}` : isSales ? "登錄銷項發票（開給客戶）" : "登錄發票"}</span>
      <span class="text-xs font-normal text-slate-500">${finInvFormCollapsed && !editing ? "▸ 展開" : "▾ 收起"}</span>
    </button>
    <div id="inv-form-body" class="${finInvFormCollapsed && !editing ? "hidden" : ""}">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">類型</label>
        <p class="mt-1 px-3 py-2 text-sm text-slate-700 bg-slate-50 border rounded-lg">${isSales ? "銷項（開給客戶）" : "進項（廠商開給我們）"}</p>
      </div>
      <div>
        <label class="text-xs text-slate-500">發票日期</label>
        <input id="inv-date" type="date" value="${d.date || todayISO()}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">憑證類別</label>
        <select id="inv-voucher" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${fixedOptions(FIN_VOUCHER_TYPES, d.voucherType)}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">${isSales ? "發票號碼" : "發票/收據號碼（選填）"}</label>
        <input id="inv-number" value="${finEsc(d.number)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：FH65914911"/>
      </div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div id="inv-client-wrap" class="${d.kind === "sales" ? "" : "hidden"}">
        <label class="text-xs text-slate-500">客戶</label>
        <select id="inv-client" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${clients.length ? clients.map(c => `<option value="${finEsc(c.id)}" ${c.id === d.clientId ? "selected" : ""}>${finEsc(c.name)}</option>`).join("") : `<option value="">尚無客戶</option>`}
        </select>
      </div>
      <div id="inv-vendor-wrap" class="relative ${d.kind === "purchase" ? "" : "hidden"}">
        <label for="inv-vendor" class="text-xs text-slate-500">開立公司（廠商，選填）</label>
        <input id="inv-vendor" value="${finEsc(d.vendor)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="inv-vendor-menu" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="打關鍵字或從清單選擇"/>
        <div id="inv-vendor-menu" role="listbox" class="hidden absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border rounded-lg shadow-lg"></div>
      </div>
      <div class="${purchaseOnly}">
        <label class="text-xs text-slate-500">類別</label>
        <select id="inv-category" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${optionsHtml(FIN_EXPENSE_CATEGORIES, d.category, "請選擇（選填）")}</select>
      </div>
      <div class="${purchaseOnly}">
        <label class="text-xs text-slate-500">專案/工程（選填）</label>
        <input id="inv-project" list="inv-project-list" value="${finEsc(d.project)}" autocomplete="off" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
        <datalist id="inv-project-list">${distinct("project").map(v => `<option value="${finEsc(v)}"></option>`).join("")}</datalist>
      </div>
      <div class="${purchaseOnly}">
        <label class="text-xs text-slate-500">收款方（選填）</label>
        <input id="inv-payee" list="inv-payee-list" value="${finEsc(d.payee)}" autocomplete="off" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
        <datalist id="inv-payee-list">${distinct("payee").map(v => `<option value="${finEsc(v)}"></option>`).join("")}</datalist>
      </div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">發票明細</label>
      <div class="border rounded-lg mt-1 overflow-x-auto">
        <table class="w-full text-sm" style="min-width: 560px">
          <thead class="bg-slate-50 text-xs text-slate-500 text-left">
            <tr><th class="px-2 py-1.5 w-8 text-center">#</th><th class="px-2 py-1.5">品項</th><th class="px-2 py-1.5 w-24 text-right">數量</th><th class="px-2 py-1.5 w-32 text-right">單價（未稅）</th><th class="px-2 py-1.5 w-28 text-right">金額</th><th class="px-2 py-1.5 w-8"></th></tr>
          </thead>
          <tbody id="inv-items">${d.items.map(finInvItemRow).join("")}</tbody>
        </table>
      </div>
      <button type="button" id="inv-item-add" class="text-sm text-blue-600 hover:underline mt-2">＋ 新增項目</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">未稅金額（明細加總）</label>
        <p class="mt-1 px-3 py-2 text-sm font-semibold text-slate-800">NT$ <span id="inv-amount">0</span></p>
      </div>
      <div>
        <label class="text-xs text-slate-500">稅別</label>
        <select id="inv-taxtype" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          <option value="taxable" ${d.taxType === "taxable" ? "selected" : ""}>應稅 5%</option>
          <option value="zero" ${d.taxType === "zero" ? "selected" : ""}>零稅率／免稅 0%</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">稅額（可手動修正）</label>
        <input id="inv-tax" type="number" min="0" step="1" value="${finEsc(d.tax)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">含稅總額</label>
        <p class="mt-1 px-3 py-2 text-sm font-semibold text-slate-800">NT$ <span id="inv-total">0</span></p>
      </div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 ${purchaseOnly}">
      <div>
        <label class="text-xs text-slate-500">付款方式</label>
        <select id="inv-paymethod" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${fixedOptions(FIN_PAY_METHODS, d.payMethod)}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">付款日期（選填）</label>
        <input id="inv-paydate" type="date" value="${finEsc(d.payDate)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">支出單號（選填）</label>
        <input id="inv-expenseno" value="${finEsc(d.expenseNo)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1 font-mono" placeholder="例：T11015、P09030、中部零用金"/>
      </div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">備註（選填）</label>
      <input id="inv-note" value="${finEsc(d.note)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
    </div>
    <button id="inv-add-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">${editing ? "儲存變更" : "登錄發票"}</button>
    ${editing ? `<button id="inv-cancel-edit" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消編輯</button>` : ""}
    <p id="inv-msg" class="text-xs hidden mt-2"></p>
    </div>
  </div>

  ${finRenderInvImport(mode)}

  <div class="bg-white rounded-xl shadow-sm p-4 mb-3">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
      <div>
        <label class="text-xs text-slate-500">${isSales ? "收款狀態" : "付款狀態"}</label>
        <select id="inv-f-status" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">
          <option value="">全部</option>
          ${(isSales ? ["未收", "部分收款", "已收"] : [...new Set([...FIN_PAY_METHODS, ...db.finance.invoices.filter(i => i.kind === "purchase" && i.payMethod).map(i => i.payMethod)])]).map(s => `<option value="${s}" ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">月份</label>
        <input id="inv-f-month" type="month" value="${f.month}" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">搜尋（號碼／對象／品名／備註）</label>
        <input id="inv-f-q" value="${finEsc(f.q)}" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1" placeholder="輸入後按 Enter"/>
      </div>
      <div class="flex gap-2">
        <button id="inv-f-clear" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">清除</button>
        <button id="inv-export-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>
      </div>
    </div>
    <p class="text-xs text-slate-500 mt-3">
      ${isSales
        ? `共 ${sales.n} 張：未稅 ${finMoney(sales.amount)}／稅額 ${finMoney(sales.tax)}／含稅 ${finMoney(sales.total)}／<span class="${sales.open > 0 ? "text-rose-600" : ""}">未收 ${finMoney(sales.open)}</span>`
        : `共 ${purchase.n} 張：未稅 ${finMoney(purchase.amount)}／稅額 ${finMoney(purchase.tax)}／含稅 ${finMoney(purchase.total)}／<span class="${purchase.open > 0 ? "text-amber-600" : ""}">未付 ${finMoney(purchase.open)}</span>`}
    </p>
  </div>

  <div class="flex items-center justify-between mb-1">
    <p class="text-xs text-slate-500">點欄位標題旁的 ▼ 即可篩選${finInvColActive(colF) ? `，目前顯示 ${rows.length} 張` : `，預設顯示今年（${finInvThisYear().dateFrom.slice(0, 4)} 年）共 ${rows.length} 張`}</p>
    ${finInvColActive(colF) ? `<button id="inv-col-clear" class="text-xs text-blue-600 hover:underline">清除欄位篩選（回到今年）</button>` : ""}
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-auto" style="max-height: 75vh; ${String(colMenu.id || "").startsWith("finv:") ? "min-height: 340px;" : ""}">
    <table class="w-full text-sm">
      <thead class="text-slate-600 text-left">
        <tr class="whitespace-nowrap">
          <th class="${stickyTh} text-right">序</th>
          ${colTh("noQuery", "流水編號", "text", { value: colF.noQuery })}
          ${colTh("date", "日期", "date", { from: colF.dateFrom, to: colF.dateTo, fromKey: "dateFrom", toKey: "dateTo", years: [...new Set(db.finance.invoices.map(x => x.date && x.date.slice(0, 4)).filter(Boolean))] })}
          ${colTh("numberQuery", "發票號碼", "text", { value: colF.numberQuery })}
          ${colTh("categories", "類別", "list", { options: listOptions(v => v.category), selected: colF.categories })}
          ${colTh("itemQuery", "品項", "text", { value: colF.itemQuery })}
          <th class="${stickyTh} text-right">未稅</th><th class="${stickyTh} text-right">稅額</th><th class="${stickyTh} text-right">含稅總額</th><th class="${stickyTh} text-right">已核對</th>
          ${colTh("statuses", "狀態", "list", { options: listOptions(v => v.status), selected: colF.statuses })}
          ${colTh("parties", isSales ? "客戶" : "廠商", "list", { options: listOptions(v => v.party), selected: colF.parties })}
          ${colTh("noteQuery", "備註", "text", { value: colF.noteQuery })}
          <th class="${stickyTh} right-0 z-30 border-l"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((i, n) => { const open = finInvExpanded.has(i.id); return `
          <tr class="inv-row border-t hover:bg-slate-50 cursor-pointer" data-id="${finEsc(i.id)}">
            <td class="px-3 py-2 text-right text-xs text-slate-400">${n + 1}</td>
            <td class="px-3 py-2">${finInvNoCell(pays[i.id], i)}</td>
            <td class="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">${finEsc(i.date)}</td>
            <td class="px-3 py-2 font-mono text-xs whitespace-nowrap">${finEsc(i.number) || "-"}</td>
            <td class="px-3 py-2 text-xs whitespace-nowrap">${finEsc(i.category) || "-"}</td>
            <td class="px-3 py-2 text-xs">${(i.items || []).length ? `${finEsc(i.items[0].name)}${i.items.length > 1 ? ` 等 ${i.items.length} 項` : ""}` : "-"}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap">${finMoney(i.amount)}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap">${finMoney(i.tax)}</td>
            <td class="px-3 py-2 text-right font-semibold whitespace-nowrap">${finMoney(i.total)}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap">${finMoney(st[i.id].paid)}</td>
            <td class="px-3 py-2">${finStatusBadge(st[i.id].status)}</td>
            <td class="px-3 py-2">${finEsc(finPartyName(i))}</td>
            <td class="px-3 py-2 text-slate-500">${finEsc(i.note) || "-"}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap sticky right-0 bg-white border-l"><button type="button" class="inv-toggle text-xs text-blue-600 hover:underline mr-2" aria-expanded="${open}"><span class="inv-chevron">${open ? "▾" : "▸"}</span> 明細${(i.items || []).length ? `（${i.items.length}）` : ""}</button><button data-id="${finEsc(i.id)}" class="inv-edit-btn text-slate-600 hover:underline text-xs mr-2">編輯</button><button data-id="${finEsc(i.id)}" class="inv-del-btn text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>
          <tr class="${open ? "" : "hidden"} bg-slate-50">
            <td colspan="14" class="px-4 py-3">${finInvDetailHtml(i, pays[i.id])}</td>
          </tr>`; }).join("") || `<tr><td colspan="14" class="px-4 py-8 text-center text-slate-400">${isSales ? "尚無銷項發票" : "尚無發票"}</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function finBindInvoices() {
  const $ = id => document.getElementById(id);
  const mode = finInvMode();
  finInvUseMode(mode);
  const d = finInvDraft;
  const amountEl = $("inv-amount"), taxTypeEl = $("inv-taxtype"), taxEl = $("inv-tax"), totalEl = $("inv-total"), itemsEl = $("inv-items");

  const recalc = () => {
    const amt = d.items.reduce((s, it) => s + finInvLineAmount(it), 0);
    if (!d.taxTouched) {
      d.tax = taxTypeEl.value === "taxable" ? Math.round(amt * FIN_TAX_RATE) : 0;
      taxEl.value = d.tax;
    }
    amountEl.textContent = finMoney(amt);
    totalEl.textContent = finMoney(amt + (Number(taxEl.value) || 0));
  };
  taxTypeEl.onchange = () => { d.taxType = taxTypeEl.value; d.taxTouched = false; d.taxEdited = false; recalc(); };
  taxEl.oninput = () => { d.taxTouched = true; d.taxEdited = true; d.tax = taxEl.value; recalc(); };
  // 編輯時先保留發票上的稅額；金額改了才重算（你自己改過稅額就不動）
  const itemsChanged = () => { if (d.editId && !d.taxEdited) d.taxTouched = false; };

  // 明細列：只更新表格本身，不重畫整頁，游標才不會跳走
  const paintItems = () => { itemsEl.innerHTML = d.items.map(finInvItemRow).join(""); recalc(); };
  itemsEl.oninput = e => {
    const field = e.target.dataset.field;
    if (!field) return;
    const row = e.target.closest("tr");
    const item = d.items[Number(row.dataset.idx)];
    item[field] = e.target.value;
    row.querySelector(".inv-item-amount").textContent = finMoney(finInvLineAmount(item));
    if (field !== "name") itemsChanged();
    recalc();
  };
  itemsEl.onclick = e => {
    if (!e.target.closest(".inv-item-del")) return;
    d.items.splice(Number(e.target.closest("tr").dataset.idx), 1);
    if (!d.items.length) d.items.push(finInvBlankItem());
    itemsChanged();
    paintItems();
  };
  $("inv-item-add").onclick = () => {
    d.items.push(finInvBlankItem());
    paintItems();
    itemsEl.querySelector("tr:last-child [data-field='name']").focus();
  };

  Object.entries({ "inv-number": "number", "inv-note": "note", "inv-voucher": "voucherType", "inv-category": "category", "inv-project": "project", "inv-payee": "payee", "inv-paymethod": "payMethod", "inv-paydate": "payDate", "inv-expenseno": "expenseNo" }).forEach(([id, key]) => {
    $(id).oninput = () => { d[key] = $(id).value; };
  });
  finBindVendorCombo($("inv-vendor"), $("inv-vendor-menu"), v => { d.vendor = v; });

  $("inv-client").onchange = () => { finInvDraft.clientId = $("inv-client").value; };
  $("inv-date").onchange = () => { finInvDraft.date = $("inv-date").value; };
  $("inv-cancel-edit")?.addEventListener("click", () => { finInvEndEdit(); render(); });
  $("inv-form-toggle").onclick = () => {
    if (d.editId) return;   // 編輯中不收起，避免看不到正在改的內容
    finSetInvFormCollapsed(!finInvFormCollapsed);
    finRenderKeepScroll();
  };

  $("inv-add-btn").onclick = () => {
    const kind = d.kind;
    const date = $("inv-date").value;
    const number = $("inv-number").value.trim();
    const tax = finParseAmount(taxEl.value, true);
    const note = $("inv-note").value.trim();
    const fail = msg => showMsg("inv-msg", msg, true);
    if (!date) return fail("請選擇發票日期");
    let clientId = "", vendor = "";
    if (kind === "sales") {
      if (!number) return fail("銷項發票請輸入發票號碼");
      clientId = $("inv-client").value;
      if (!clientId) return fail("請選擇客戶（尚無客戶請先到「總覽」建立）");
    } else {
      vendor = finCanonicalVendor($("inv-vendor").value.trim());
    }
    // 明細：整行空白的略過；品項可不填（例如加油單）；單價可為負數，用來登錄折扣
    const items = [];
    for (let n = 0; n < d.items.length; n++) {
      const it = d.items[n];
      const name = it.name.trim();
      if (!name && String(it.price).trim() === "") continue;
      const qty = Number(it.qty), price = Number(it.price);
      if (String(it.qty).trim() === "" || !Number.isFinite(qty) || qty <= 0) return fail(`明細第 ${n + 1} 行的數量要大於 0`);
      if (String(it.price).trim() === "" || !Number.isFinite(price)) return fail(`明細第 ${n + 1} 行請輸入單價`);
      items.push({ name, qty, price, amount: finInvLineAmount(it) });
    }
    if (!items.length) return fail("請至少輸入一筆明細金額");
    const amount = items.reduce((s, it) => s + it.amount, 0);
    if (amount <= 0) return fail("未稅金額合計必須大於 0");
    if (tax === null) return fail("稅額請輸入 0 或正整數");
    // 編輯時的保護：已連結流水的發票，不能改到和流水對不上
    const editing = db.finance.invoices.find(i => i.id === d.editId);
    if (d.editId && !editing) { finInvEndEdit(); render(); return; }
    if (editing) {
      const linked = (finInvoicePayments()[editing.id] || []).reduce((s, p) => s + p.amount, 0);
      if (linked > 0) {
        const hint = "請先到流水帳取消核對";
        if (kind !== editing.kind) return fail(`這張發票已連結流水，不能改類型。${hint}`);
        if (amount + tax < linked) return fail(`這張發票已連結流水 ${finMoney(linked)} 元，含稅總額不能比它少。${hint}`);
        if (kind === "sales" && clientId !== editing.clientId) return fail(`這張發票已連結流水，不能改客戶。${hint}`);
      }
    }
    // 號碼重複時讓使用者決定：實務上可能是打錯，也可能真的共用同一個號碼
    const dup = number && db.finance.invoices.some(i => i.id !== d.editId && i.kind === kind && i.number.toLowerCase() === number.toLowerCase() && (kind === "sales" || i.vendor === vendor));
    const commit = () => {
      const isPurchase = kind === "purchase";
      const fields = {
        kind, date, number, clientId, vendor, taxType: taxTypeEl.value,
        items: items.length === 1 && !items[0].name ? [] : items,   // 只有金額沒有品項，就不算明細
        amount, tax, total: amount + tax, note,
        voucherType: d.voucherType,
        category: isPurchase ? d.category : "",
        project: isPurchase ? d.project.trim() : "",
        payee: isPurchase ? d.payee.trim() : "",
        payMethod: isPurchase ? d.payMethod : "",
        payDate: isPurchase ? d.payDate : "",
        expenseNo: isPurchase ? d.expenseNo.trim() : "",
      };
      if (vendor) finRememberVendor(vendor);
      if (editing) {
        const categoryChanged = (editing.category || "") !== fields.category;
        // 已連結流水的發票，使用者手動改了付款方式就以使用者選的為準，連結流水時不再自動改成轉帳／部分總額
        if (isPurchase && fields.payMethod !== (editing.payMethod || "") && (finInvoicePayments()[editing.id] || []).length) fields.payMethodManual = true;
        Object.assign(editing, fields);
        finInvEndEdit();
        finSave();
        // 改了類別，連結的流水類別也要對齊（空的直接帶入，不同就問）
        if (categoryChanged && fields.category) {
          const linked = db.finance.ledger.filter(e => (e.allocations || []).some(a => a.invoiceId === editing.id));
          finSyncCategories(linked, "invoice", editing.id);
        }
        return;
      }
      db.finance.invoices.push({ id: finId("inv"), ...fields });
      // 清空這張發票的內容；日期、客戶、稅別、憑證類別、支出項目留著，連續登錄比較快。
      // 類型回到進項；現金和不支出會直接改變狀態，不沿用到下一張，避免沒注意就標成已付
      const keepMethod = [FIN_PAY_CASH, FIN_PAY_NONE, FIN_PAY_PARTIAL].includes(d.payMethod) ? FIN_PAY_UNPAID : d.payMethod;
      Object.assign(d, { kind, payMethod: keepMethod, date, number: "", vendor: "", project: "", payee: "", payDate: "", expenseNo: "", note: "", tax: 0, taxTouched: false, items: [finInvBlankItem()] });
      finSave();
    };
    if (dup) appConfirm(`號碼「${number}」已經登錄過了，確定還要再登錄一筆嗎？`, commit);
    else commit();
  };

  finBindFilter("inv-f-status", finInvFilter, "status");
  finBindFilter("inv-f-month", finInvFilter, "month");
  finBindFilter("inv-f-q", finInvFilter, "q");
  $("inv-f-clear").onclick = () => { Object.assign(finInvFilter, { status: "", month: "", q: "" }); finInvColFilters[mode] = finInvNewColFilter(); render(); };
  $("inv-col-clear")?.addEventListener("click", () => { finInvColFilters[mode] = finInvNewColFilter(); render(); });
  bindColumnFilters();
  finBindInvImport(mode);
  $("inv-export-btn").onclick = () => {
    const st = finSettlement();
    const pays = finInvoicePayments();
    const rows = [["日期", "類型", "發票號碼", "客戶／廠商", "未稅金額", "稅額", "含稅總額", "已核對金額", "狀態", "備註", "明細", "憑證類別", "類別", "專案/工程", "收款方", "付款方式", "付款日期", "支出單號", "收付款帳戶／編號"]];
    finFilteredInvoices(st).forEach(i => rows.push([i.date, i.kind === "sales" ? "銷項" : "進項", i.number, finPartyName(i), i.amount, i.tax, i.total, st[i.id].paid, st[i.id].status, i.note || "", (i.items || []).map(it => `${it.name} ${it.qty}×${it.price}=${it.amount}`).join("；"), i.voucherType || "", i.category || "", i.project || "", i.payee || "", i.payMethod || "", i.payDate || "", i.expenseNo || "", (pays[i.id] || []).map(p => `${p.no} ${finAccountLabel(p.accountId)} ${p.amount}`).join("；")]));
    finDownloadCSV(mode === "sales" ? "銷項發票清單" : "進項發票清單", rows);
  };
  // 點發票列展開／收合明細（點「刪除」除外）
  document.querySelectorAll(".inv-row").forEach(row => {
    row.onclick = e => {
      const link = e.target.closest(".inv-pay-link");
      if (link) return finOpenReconcile(link.dataset.entry);
      if (e.target.closest(".inv-del-btn, .inv-edit-btn")) return;
      const id = row.dataset.id;
      const open = !finInvExpanded.has(id);
      if (open) finInvExpanded.add(id); else finInvExpanded.delete(id);
      row.nextElementSibling.classList.toggle("hidden", !open);
      row.querySelector(".inv-chevron").textContent = open ? "▾" : "▸";
      row.querySelector(".inv-toggle").setAttribute("aria-expanded", String(open));
    };
  });
  document.querySelectorAll(".inv-edit-btn").forEach(btn => { btn.onclick = () => finInvStartEdit(btn.dataset.id); });
  document.querySelectorAll(".inv-del-btn").forEach(btn => {
    btn.onclick = () => {
      const inv = db.finance.invoices.find(i => i.id === btn.dataset.id);
      if (!inv) return;
      if (db.finance.ledger.some(e => (e.allocations || []).some(a => a.invoiceId === inv.id))) {
        alert("這張發票已有核對的流水帳，請先到「流水帳」取消那些流水的核對後再刪除發票。");
        return;
      }
      appConfirm(`確定要刪除發票「${inv.number || "未填號碼"}」嗎？`, () => {
        db.finance.invoices = db.finance.invoices.filter(i => i.id !== inv.id);
        finInvExpanded.delete(inv.id);
        if (finInvDraft.editId === inv.id) finInvEndEdit();
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
  recalc();
}

// ============================================================
// 客戶應收帳款與請款
// ============================================================
function finRenderAR() {
  const ar = finComputeAR();
  const clients = finClients();
  const known = new Set(clients.map(c => c.id));
  // 客戶已被刪除但仍有帳款紀錄時，也要列出來，避免帳對不起來
  const ids = [...clients.map(c => c.id), ...Object.keys(ar.clients).filter(id => !known.has(id))];
  const blank = { invoiced: 0, received: 0, matched: 0, outstanding: 0, unmatched: 0, oldestUnpaidDate: "", invoices: [] };
  const rows = ids.map(id => ({ id, name: clientName(id), c: ar.clients[id] || blank }));
  rows.sort((a, b) => b.c.outstanding - a.c.outstanding);
  const total = rows.reduce((s, r) => ({ invoiced: s.invoiced + r.c.invoiced, matched: s.matched + r.c.matched, outstanding: s.outstanding + r.c.outstanding, unmatched: s.unmatched + r.c.unmatched }), { invoiced: 0, matched: 0, outstanding: 0, unmatched: 0 });

  return `
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">已開銷項發票（含稅）</p><p class="text-2xl font-bold text-slate-800 mt-1">NT$ ${finMoney(total.invoiced)}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">已核對收款</p><p class="text-2xl font-bold text-emerald-600 mt-1">NT$ ${finMoney(total.matched)}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">未收餘額</p><p class="text-2xl font-bold ${total.outstanding > 0 ? "text-rose-600" : "text-slate-800"} mt-1">NT$ ${finMoney(total.outstanding)}</p>${total.unmatched > 0 ? `<p class="text-xs text-amber-600 mt-1">另有 ${finMoney(total.unmatched)} 的客戶入帳還沒核對到發票</p>` : ""}</div>
  </div>

  <div class="flex items-center justify-between mb-2">
    <p class="text-sm text-slate-500">未收餘額只計算「已在流水帳核對到發票」的收款；點客戶可查看明細、登錄收款與列印請款單</p>
    <button id="ar-export-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">客戶</th><th class="px-4 py-2 text-right">已開發票（含稅）</th><th class="px-4 py-2 text-right">客戶入帳合計</th><th class="px-4 py-2 text-right">未收餘額</th><th class="px-4 py-2 text-right">待核對入帳</th><th class="px-4 py-2 text-right">最久未收（天）</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 font-medium">${finEsc(r.name)}</td>
            <td class="px-4 py-2 text-right">${finMoney(r.c.invoiced)}</td>
            <td class="px-4 py-2 text-right text-emerald-600">${finMoney(r.c.received)}</td>
            <td class="px-4 py-2 text-right font-semibold ${r.c.outstanding > 0 ? "text-rose-600" : ""}">${finMoney(r.c.outstanding)}</td>
            <td class="px-4 py-2 text-right ${r.c.unmatched > 0 ? "text-amber-600 font-semibold" : "text-slate-400"}">${r.c.unmatched > 0 ? finMoney(r.c.unmatched) : "-"}</td>
            <td class="px-4 py-2 text-right">${r.c.oldestUnpaidDate ? finDaysSince(r.c.oldestUnpaidDate) : "-"}</td>
            <td class="px-4 py-2 text-right"><button data-client="${finEsc(r.id)}" class="ar-open-btn text-blue-600 hover:underline text-xs">明細／收款</button></td>
          </tr>`).join("") || `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">尚無客戶</td></tr>`}
      </tbody>
    </table>
  </div>

  <p class="font-semibold text-slate-700 mt-8 mb-3">銷項發票（開給客戶）</p>
  ${finRenderInvoices()}`;
}

function finBindAR() {
  finBindInvoices();
  document.querySelectorAll(".ar-open-btn").forEach(btn => {
    btn.onclick = () => navigateTo({ page: "fin-ar-detail", finClientId: btn.dataset.client });
  });
  document.getElementById("ar-export-btn").onclick = () => {
    const ar = finComputeAR();
    const rows = [["客戶", "已開發票（含稅）", "客戶入帳合計", "已核對收款", "未收餘額", "待核對入帳", "最久未收（天）"]];
    Object.values(ar.clients).forEach(c => rows.push([clientName(c.clientId), c.invoiced, c.received, c.matched, c.outstanding, c.unmatched, c.oldestUnpaidDate ? finDaysSince(c.oldestUnpaidDate) : ""]));
    finDownloadCSV("應收帳款彙總", rows);
  };
}

function finRenderARDetail() {
  const clientId = view.finClientId;
  const client = db.clients.find(c => c.id === clientId);
  const ar = finComputeAR();
  const c = ar.clients[clientId] || { invoices: [], receipts: [], invoiced: 0, received: 0, matched: 0, outstanding: 0, unmatched: 0 };
  const unpaid = c.invoices.filter(i => ar.invoiceInfo[i.id].outstanding > 0);
  const receipts = c.receipts.slice().sort((a, b) => (b.date + (b.seq || 0)).localeCompare(a.date + (a.seq || 0)));
  const accounts = db.finance.accounts;
  const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
  const lastAccount = finLedgerDraft?.accountId && accounts.some(a => a.id === finLedgerDraft.accountId) ? finLedgerDraft.accountId : (accounts.find(a => a.type === "bank") || accounts[0])?.id;

  return `
  <div class="flex items-center gap-3 mb-4">
    ${client?.logoUrl ? `<img src="${finEsc(client.logoUrl)}" class="w-24 h-14 object-contain rounded" alt=""/>` : `<span class="text-3xl">🏢</span>`}
    <div>
      <p class="font-semibold text-slate-800">${finEsc(clientName(clientId))}</p>
      <p class="text-xs text-slate-500">${[client?.contact, client?.phone, client?.address].filter(Boolean).map(finEsc).join("　") || "尚未填寫聯絡資料"}</p>
    </div>
    <button id="ard-print-btn" class="ml-auto border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100 ${unpaid.length ? "" : "opacity-50"}">🖨 列印請款單</button>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">已開發票（含稅）</p><p class="text-xl font-bold text-slate-800 mt-1">NT$ ${finMoney(c.invoiced)}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">已核對收款</p><p class="text-xl font-bold text-emerald-600 mt-1">NT$ ${finMoney(c.matched)}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">未收餘額</p><p class="text-xl font-bold ${c.outstanding > 0 ? "text-rose-600" : "text-slate-800"} mt-1">NT$ ${finMoney(c.outstanding)}</p>${c.unmatched > 0 ? `<p class="text-xs text-amber-600 mt-1">另有 ${finMoney(c.unmatched)} 入帳待核對到發票</p>` : ""}</div>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
    <p class="font-semibold text-sm text-slate-700 mb-3">登錄收款</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">收款日期</label>
        <input id="pay-date" type="date" value="${todayISO()}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">入帳帳戶</label>
        <select id="pay-account" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${accounts.map(a => `<option value="${finEsc(a.id)}" ${a.id === lastAccount ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">金額</label>
        <input id="pay-amount" type="number" min="0" step="1" value="${c.outstanding > 0 ? c.outstanding : ""}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="整數元"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">對應發票</label>
        <select id="pay-invoice" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          <option value="">先不指定（登錄後再到核對頁分配）</option>
          ${unpaid.map(i => `<option value="${finEsc(i.id)}">${finEsc(i.date)} ${finEsc(i.number)}（未收 ${finMoney(ar.invoiceInfo[i.id].outstanding)}）</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">備註（選填）</label>
      <input id="pay-note" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填，例：匯款後五碼"/>
    </div>
    <button id="pay-add-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">登錄收款</button>
    <span class="text-xs text-slate-400 ml-2">登錄後會成為該帳戶流水帳的一筆入帳（${FIN_RECEIPT_CATEGORY}）；沒指定發票會直接帶你去核對</span>
    <p id="pay-msg" class="text-xs hidden mt-2"></p>
  </div>

  <p class="font-semibold text-sm text-slate-700 mb-2">銷項發票</p>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">日期</th><th class="px-4 py-2">發票號碼</th><th class="px-4 py-2 text-right">含稅總額</th><th class="px-4 py-2 text-right">已核對</th><th class="px-4 py-2 text-right">未收</th><th class="px-4 py-2">狀態</th></tr>
      </thead>
      <tbody>
        ${c.invoices.slice().reverse().map(i => { const x = ar.invoiceInfo[i.id]; return `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 text-xs text-slate-500">${finEsc(i.date)}</td>
            <td class="px-4 py-2 font-mono text-xs">${finEsc(i.number)}</td>
            <td class="px-4 py-2 text-right">${finMoney(i.total)}</td>
            <td class="px-4 py-2 text-right text-emerald-600">${finMoney(x.paid)}</td>
            <td class="px-4 py-2 text-right font-semibold ${x.outstanding > 0 ? "text-rose-600" : ""}">${finMoney(x.outstanding)}</td>
            <td class="px-4 py-2">${finStatusBadge(x.status)}</td>
          </tr>`; }).join("") || `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400">尚無銷項發票（請先到「發票登錄」登錄）</td></tr>`}
      </tbody>
    </table>
  </div>

  <p class="font-semibold text-sm text-slate-700 mb-2">客戶入帳（來自流水帳）</p>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">日期</th><th class="px-4 py-2">帳戶</th><th class="px-4 py-2 text-right">金額</th><th class="px-4 py-2 text-right">已核對</th><th class="px-4 py-2">對應發票</th><th class="px-4 py-2">備註</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        ${receipts.map(e => { const matched = finEntryAllocated(e); return `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 text-xs text-slate-500">${finEsc(e.date)}</td>
            <td class="px-4 py-2">${finEsc(finAccountName(e.accountId))}</td>
            <td class="px-4 py-2 text-right font-semibold text-emerald-600">${finMoney(e.amount)}</td>
            <td class="px-4 py-2 text-right ${matched < e.amount ? "text-amber-600 font-semibold" : ""}">${finMoney(matched)}</td>
            <td class="px-4 py-2 font-mono text-xs">${(e.allocations || []).map(a => finEsc(invById[a.invoiceId]?.number || "?")).join("、") || "-"}</td>
            <td class="px-4 py-2 text-slate-500">${finEsc(e.note || e.ref) || "-"}</td>
            <td class="px-4 py-2 text-right whitespace-nowrap"><button data-id="${finEsc(e.id)}" class="pay-recon-btn text-blue-600 hover:underline text-xs mr-2">核對</button><button data-id="${finEsc(e.id)}" class="pay-del-btn text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>`; }).join("") || `<tr><td colspan="7" class="px-4 py-6 text-center text-slate-400">尚無客戶入帳</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function finBindARDetail() {
  const clientId = view.finClientId;
  const $ = id => document.getElementById(id);
  $("pay-add-btn").onclick = () => {
    const date = $("pay-date").value;
    const accountId = $("pay-account").value;
    const amount = finParseAmount($("pay-amount").value, false);
    const invoiceId = $("pay-invoice").value;
    const fail = msg => showMsg("pay-msg", msg, true);
    if (!date) return fail("請選擇收款日期");
    if (!accountId) return fail("請選擇入帳帳戶（請先到「銀行帳戶」建立）");
    if (amount === null) return fail("金額請輸入大於 0 的整數");
    const entry = { id: finId("led"), seq: finNextSeq(), accountId, date, type: "income", category: FIN_RECEIPT_CATEGORY, amount, counterparty: clientName(clientId), note: $("pay-note").value.trim(), clientId, allocations: [], source: "manual" };
    if (invoiceId) {
      const outstanding = finSettlement()[invoiceId]?.outstanding || 0;
      const a = Math.min(amount, outstanding);
      if (a > 0) entry.allocations = [{ invoiceId, amount: a }];
    }
    db.finance.ledger.push(entry);
    finLedgerDraft = { ...finLedgerDraft, accountId };
    saveDB(db);
    if (invoiceId) render(); else finOpenReconcile(entry.id);
  };
  document.querySelectorAll(".pay-recon-btn").forEach(btn => { btn.onclick = () => finOpenReconcile(btn.dataset.id); });
  document.querySelectorAll(".pay-del-btn").forEach(btn => {
    btn.onclick = () => {
      const e = db.finance.ledger.find(x => x.id === btn.dataset.id);
      if (!e) return;
      appConfirm(`確定要刪除這筆 ${finMoney(e.amount)} 元的入帳嗎？它在流水帳裡的紀錄也會一併刪除。`, () => {
        db.finance.ledger = db.finance.ledger.filter(x => x.id !== e.id);
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
  $("ard-print-btn").onclick = () => finPrintStatement(clientId);
}

// 請款單：另開視窗產生可列印的對帳／請款明細
function finPrintStatement(clientId) {
  const ar = finComputeAR();
  const c = ar.clients[clientId];
  const unpaid = c ? c.invoices.filter(i => ar.invoiceInfo[i.id].outstanding > 0) : [];
  if (!unpaid.length) { alert("這個客戶目前沒有未收款的發票，不需要請款單。"); return; }
  const client = db.clients.find(x => x.id === clientId);
  const host = db.clients.find(x => x.id === HOST_CLIENT_ID);
  const due = unpaid.reduce((s, i) => s + ar.invoiceInfo[i.id].outstanding, 0);
  const logo = host?.logoUrl && host.logoUrl.startsWith("data:image/") ? `<img src="${finEsc(host.logoUrl)}" style="height:48px;max-width:160px;object-fit:contain"/>` : "";
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>請款單－${finEsc(clientName(clientId))}</title>
<style>
  body{font-family:-apple-system,"Microsoft JhengHei",sans-serif;color:#1e293b;margin:32px;font-size:14px}
  h1{font-size:22px;margin:0}
  .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
  .meta{margin-bottom:16px;line-height:1.8}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left}
  th{background:#f1f5f9}
  .r{text-align:right}
  .total{margin-top:16px;text-align:right;font-size:18px;font-weight:bold}
  .note{margin-top:32px;font-size:12px;color:#64748b}
  @media print{body{margin:16px}}
</style></head><body>
  <div class="head"><div>${logo}<div style="font-weight:bold;margin-top:4px">${finEsc(host?.name || "")}</div></div><h1>請款單</h1></div>
  <div class="meta">
    <div><b>客戶：</b>${finEsc(clientName(clientId))}</div>
    ${client?.contact ? `<div><b>聯絡人：</b>${finEsc(client.contact)}${client.phone ? "　" + finEsc(client.phone) : ""}</div>` : ""}
    ${client?.address ? `<div><b>地址：</b>${finEsc(client.address)}</div>` : ""}
    <div><b>製單日期：</b>${finEsc(todayISO())}</div>
  </div>
  <table>
    <thead><tr><th>發票日期</th><th>發票號碼</th><th class="r">含稅金額</th><th class="r">已收</th><th class="r">應收餘額</th></tr></thead>
    <tbody>${unpaid.map(i => { const x = ar.invoiceInfo[i.id]; return `<tr><td>${finEsc(i.date)}</td><td>${finEsc(i.number)}</td><td class="r">${finMoney(i.total)}</td><td class="r">${finMoney(x.paid)}</td><td class="r">${finMoney(x.outstanding)}</td></tr>`; }).join("")}</tbody>
  </table>
  <div class="total">應收總額：NT$ ${finMoney(due)}</div>
  <div class="note">如已付款，請忽略此單並來信告知匯款資料，謝謝。</div>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) { alert("瀏覽器擋住了彈出視窗，請允許此網站的彈出視窗後再試一次。"); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

// ============================================================
// 財務報表
// ============================================================
function finReportData(year, accountId) {
  const y = String(year);
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, expense: 0 }));
  const incomeCat = {}, expenseCat = {};
  db.finance.ledger.filter(e => (e.date || "").startsWith(y) && !finIsTransfer(e) && (!accountId || e.accountId === accountId)).forEach(e => {
    const m = months[Number(e.date.slice(5, 7)) - 1];
    if (!m) return;
    const cat = e.category || "未分類";
    if (e.type === "income") { m.income += e.amount; incomeCat[cat] = (incomeCat[cat] || 0) + e.amount; }
    else {
      m.expense += e.amount;
      Object.entries(finEntryCategoryParts(e)).forEach(([c, amt]) => { expenseCat[c] = (expenseCat[c] || 0) + amt; });
    }
    // 手續費另外算進支出的「手續費」類別
    if (e.fee) { m.expense += e.fee; expenseCat["手續費"] = (expenseCat["手續費"] || 0) + e.fee; }
  });
  // 營業稅：每兩個月為一期（1-2月、3-4月…）
  const periods = Array.from({ length: 6 }, (_, i) => ({ label: `${i * 2 + 1}-${i * 2 + 2} 月`, salesAmount: 0, salesTax: 0, purchaseAmount: 0, purchaseTax: 0 }));
  db.finance.invoices.filter(i => (i.date || "").startsWith(y)).forEach(i => {
    const p = periods[Math.floor((Number(i.date.slice(5, 7)) - 1) / 2)];
    if (!p) return;
    if (i.kind === "sales") { p.salesAmount += i.amount; p.salesTax += i.tax; } else { p.purchaseAmount += i.amount; p.purchaseTax += i.tax; }
  });
  return { months, incomeCat, expenseCat, periods };
}

function finAgingData() {
  const ar = finComputeAR();
  const rows = [];
  Object.values(ar.clients).forEach(c => {
    const b = { clientId: c.clientId, d0: 0, d30: 0, d60: 0, d90: 0, total: 0 };
    c.invoices.forEach(i => {
      const out = ar.invoiceInfo[i.id].outstanding;
      if (out <= 0) return;
      const age = finDaysSince(i.date);
      if (age <= 30) b.d0 += out; else if (age <= 60) b.d30 += out; else if (age <= 90) b.d60 += out; else b.d90 += out;
      b.total += out;
    });
    if (b.total > 0) rows.push(b);
  });
  return rows.sort((a, b) => b.total - a.total);
}

function finRenderReports() {
  const year = finReportYear;
  const data = finReportData(year, finReportAccount);
  const aging = finAgingData();
  const dataYears = new Set([new Date().getFullYear(), year]);
  [...db.finance.ledger, ...db.finance.invoices].forEach(r => { const y = Number((r.date || "").slice(0, 4)); if (y) dataYears.add(y); });
  const years = [...dataYears].sort((a, b) => b - a);
  const totalIncome = data.months.reduce((s, m) => s + m.income, 0);
  const totalExpense = data.months.reduce((s, m) => s + m.expense, 0);
  const maxVal = Math.max(1, ...data.months.map(m => Math.max(m.income, m.expense)));
  const bar = v => v > 0 ? Math.max(2, Math.round(v / maxVal * 100)) : 0;
  const sumPeriods = data.periods.reduce((s, p) => ({ salesAmount: s.salesAmount + p.salesAmount, salesTax: s.salesTax + p.salesTax, purchaseAmount: s.purchaseAmount + p.purchaseAmount, purchaseTax: s.purchaseTax + p.purchaseTax }), { salesAmount: 0, salesTax: 0, purchaseAmount: 0, purchaseTax: 0 });
  const agingTotal = aging.reduce((s, r) => ({ d0: s.d0 + r.d0, d30: s.d30 + r.d30, d60: s.d60 + r.d60, d90: s.d90 + r.d90, total: s.total + r.total }), { d0: 0, d30: 0, d60: 0, d90: 0, total: 0 });
  const catRows = (obj, cls) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr class="border-t"><td class="px-4 py-2">${finEsc(k)}</td><td class="px-4 py-2 text-right font-semibold ${cls}">${finMoney(v)}</td></tr>`).join("") || `<tr><td colspan="2" class="px-4 py-4 text-center text-slate-400">無資料</td></tr>`;

  return `
  <div class="flex flex-wrap items-center gap-3 mb-4">
    <label class="text-sm text-slate-600">年度</label>
    <select id="rep-year" class="border rounded-lg px-3 py-1.5 text-sm">${years.map(y => `<option value="${y}" ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select>
    <label class="text-sm text-slate-600 ml-2">帳戶</label>
    <select id="rep-account" class="border rounded-lg px-3 py-1.5 text-sm">
      <option value="">全部帳戶</option>
      ${db.finance.accounts.map(a => `<option value="${finEsc(a.id)}" ${a.id === finReportAccount ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}
    </select>
    <span class="text-xs text-slate-400">收支報表以銀行「流水帳」為準（不含帳戶間轉帳，也不含現金付款的發票）；營業稅試算以「發票」為準。</span>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">${year} 年收入</p><p class="text-2xl font-bold text-emerald-600 mt-1">NT$ ${finMoney(totalIncome)}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">${year} 年支出</p><p class="text-2xl font-bold text-rose-600 mt-1">NT$ ${finMoney(totalExpense)}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-5"><p class="text-xs text-slate-500">${year} 年淨額</p><p class="text-2xl font-bold ${totalIncome - totalExpense < 0 ? "text-rose-600" : "text-slate-800"} mt-1">NT$ ${finMoney(totalIncome - totalExpense)}</p></div>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
    <div class="flex items-center justify-between mb-3">
      <p class="font-semibold text-sm text-slate-700">月度收支（<span class="text-emerald-600">■ 收入</span>　<span class="text-rose-500">■ 支出</span>）</p>
      <button id="rep-export-monthly" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>
    </div>
    <div class="flex items-end gap-2 h-40 mb-4">
      ${data.months.map(m => `
        <div class="flex-1 flex flex-col items-center justify-end h-full" title="${m.month} 月　收入 ${finMoney(m.income)}／支出 ${finMoney(m.expense)}">
          <div class="flex items-end gap-0.5 h-full w-full justify-center">
            <div class="w-3 bg-emerald-400 rounded-t" style="height:${bar(m.income)}%"></div>
            <div class="w-3 bg-rose-400 rounded-t" style="height:${bar(m.expense)}%"></div>
          </div>
          <span class="text-[10px] text-slate-400 mt-1">${m.month}月</span>
        </div>`).join("")}
    </div>
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="px-4 py-2">月份</th><th class="px-4 py-2 text-right">收入</th><th class="px-4 py-2 text-right">支出</th><th class="px-4 py-2 text-right">淨額</th></tr></thead>
      <tbody>
        ${data.months.map(m => `<tr class="border-t"><td class="px-4 py-2">${m.month} 月</td><td class="px-4 py-2 text-right text-emerald-600">${finMoney(m.income)}</td><td class="px-4 py-2 text-right text-rose-600">${finMoney(m.expense)}</td><td class="px-4 py-2 text-right font-semibold ${m.income - m.expense < 0 ? "text-rose-600" : ""}">${finMoney(m.income - m.expense)}</td></tr>`).join("")}
        <tr class="border-t bg-slate-50 font-semibold"><td class="px-4 py-2">合計</td><td class="px-4 py-2 text-right text-emerald-600">${finMoney(totalIncome)}</td><td class="px-4 py-2 text-right text-rose-600">${finMoney(totalExpense)}</td><td class="px-4 py-2 text-right">${finMoney(totalIncome - totalExpense)}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <p class="font-semibold text-sm text-slate-700 px-4 pt-4 pb-2">收入類別（${year}）</p>
      <table class="w-full text-sm"><tbody>${catRows(data.incomeCat, "text-emerald-600")}</tbody></table>
    </div>
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <p class="font-semibold text-sm text-slate-700 px-4 pt-4 pb-2">支出類別（${year}）</p>
      <table class="w-full text-sm"><tbody>${catRows(data.expenseCat, "text-rose-600")}</tbody></table>
    </div>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
    <div class="flex items-center justify-between mb-3">
      <p class="font-semibold text-sm text-slate-700">營業稅試算（${year}，每兩個月一期）</p>
      <button id="rep-export-vat" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>
    </div>
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="px-4 py-2">期別</th><th class="px-4 py-2 text-right">銷售額</th><th class="px-4 py-2 text-right">銷項稅額</th><th class="px-4 py-2 text-right">進貨額</th><th class="px-4 py-2 text-right">進項稅額</th><th class="px-4 py-2 text-right">應納（退）稅額</th></tr></thead>
      <tbody>
        ${data.periods.map(p => `<tr class="border-t"><td class="px-4 py-2">${p.label}</td><td class="px-4 py-2 text-right">${finMoney(p.salesAmount)}</td><td class="px-4 py-2 text-right">${finMoney(p.salesTax)}</td><td class="px-4 py-2 text-right">${finMoney(p.purchaseAmount)}</td><td class="px-4 py-2 text-right">${finMoney(p.purchaseTax)}</td><td class="px-4 py-2 text-right font-semibold ${p.salesTax - p.purchaseTax < 0 ? "text-emerald-600" : ""}">${finMoney(p.salesTax - p.purchaseTax)}</td></tr>`).join("")}
        <tr class="border-t bg-slate-50 font-semibold"><td class="px-4 py-2">合計</td><td class="px-4 py-2 text-right">${finMoney(sumPeriods.salesAmount)}</td><td class="px-4 py-2 text-right">${finMoney(sumPeriods.salesTax)}</td><td class="px-4 py-2 text-right">${finMoney(sumPeriods.purchaseAmount)}</td><td class="px-4 py-2 text-right">${finMoney(sumPeriods.purchaseTax)}</td><td class="px-4 py-2 text-right">${finMoney(sumPeriods.salesTax - sumPeriods.purchaseTax)}</td></tr>
      </tbody>
    </table>
    <p class="text-xs text-slate-400 mt-2">試算僅供參考，實際申報請依稅務規定與會計師確認；負數代表留抵稅額。</p>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-6">
    <div class="flex items-center justify-between mb-3">
      <p class="font-semibold text-sm text-slate-700">應收帳款帳齡（截至今天，依發票日期；只計已核對的收款）</p>
      <button id="rep-export-aging" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>
    </div>
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="px-4 py-2">客戶</th><th class="px-4 py-2 text-right">0–30 天</th><th class="px-4 py-2 text-right">31–60 天</th><th class="px-4 py-2 text-right">61–90 天</th><th class="px-4 py-2 text-right">90 天以上</th><th class="px-4 py-2 text-right">未收合計</th></tr></thead>
      <tbody>
        ${aging.map(r => `<tr class="border-t"><td class="px-4 py-2">${finEsc(clientName(r.clientId))}</td><td class="px-4 py-2 text-right">${finMoney(r.d0)}</td><td class="px-4 py-2 text-right">${finMoney(r.d30)}</td><td class="px-4 py-2 text-right">${finMoney(r.d60)}</td><td class="px-4 py-2 text-right ${r.d90 > 0 ? "text-rose-600 font-semibold" : ""}">${finMoney(r.d90)}</td><td class="px-4 py-2 text-right font-semibold">${finMoney(r.total)}</td></tr>`).join("") || `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400">目前沒有未收款</td></tr>`}
        ${aging.length ? `<tr class="border-t bg-slate-50 font-semibold"><td class="px-4 py-2">合計</td><td class="px-4 py-2 text-right">${finMoney(agingTotal.d0)}</td><td class="px-4 py-2 text-right">${finMoney(agingTotal.d30)}</td><td class="px-4 py-2 text-right">${finMoney(agingTotal.d60)}</td><td class="px-4 py-2 text-right">${finMoney(agingTotal.d90)}</td><td class="px-4 py-2 text-right">${finMoney(agingTotal.total)}</td></tr>` : ""}
      </tbody>
    </table>
  </div>`;
}

function finBindReports() {
  const $ = id => document.getElementById(id);
  $("rep-year").onchange = () => { finReportYear = Number($("rep-year").value); render(); };
  $("rep-account").onchange = () => { finReportAccount = $("rep-account").value; render(); };
  $("rep-export-monthly").onclick = () => {
    const d = finReportData(finReportYear, finReportAccount);
    const rows = [["月份", "收入", "支出", "淨額"]];
    d.months.forEach(m => rows.push([`${finReportYear}/${m.month}`, m.income, m.expense, m.income - m.expense]));
    rows.push(["合計", d.months.reduce((s, m) => s + m.income, 0), d.months.reduce((s, m) => s + m.expense, 0), d.months.reduce((s, m) => s + m.income - m.expense, 0)]);
    finDownloadCSV(`月度收支_${finReportYear}`, rows);
  };
  $("rep-export-vat").onclick = () => {
    const d = finReportData(finReportYear, "");
    const rows = [["期別", "銷售額", "銷項稅額", "進貨額", "進項稅額", "應納（退）稅額"]];
    d.periods.forEach(p => rows.push([`${finReportYear} ${p.label}`, p.salesAmount, p.salesTax, p.purchaseAmount, p.purchaseTax, p.salesTax - p.purchaseTax]));
    finDownloadCSV(`營業稅試算_${finReportYear}`, rows);
  };
  $("rep-export-aging").onclick = () => {
    const rows = [["客戶", "0–30 天", "31–60 天", "61–90 天", "90 天以上", "未收合計"]];
    finAgingData().forEach(r => rows.push([clientName(r.clientId), r.d0, r.d30, r.d60, r.d90, r.total]));
    finDownloadCSV("應收帳款帳齡", rows);
  };
}
