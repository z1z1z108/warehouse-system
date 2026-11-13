// ============================================================
// 財務會計（僅震浤管理員）— 銀行帳戶、多帳戶流水帳、發票／貸款核對、對帳單匯入、貸款管理
// 與 finance.js 搭配使用（共用 finEsc、finMoney、finId、finSettlement… 等工具）。
//
// 流水帳 db.finance.ledger 每筆：
//   { id, seq, accountId, date(YYYY-MM-DD), type: "income"|"expense", category, amount, counterparty, note,
//     ref(銀行摘要原文), balance(對帳單餘額), source: "manual"|"import", importBatch,
//     clientId(客戶入帳), allocations: [{ invoiceId, amount }](核對到的發票), loanId(貸款扣款), noMatch(不需核對),
//     transferGroup(帳戶間轉帳的兩筆共用), no(流水編號，如 T10901，由 data.js 自動產生),
//     content(內容), fee(手續費，另外從帳戶扣除，不含在 amount 內),
//     splits: [{ id, name, category, amount, note }](整批支出的拆分明細，僅支出) }
// ============================================================

let finLedgerFilter = { account: "", type: "", category: "", recon: "", month: "", q: "" };
let finLedgerDraft = { accountId: "", type: "expense", date: "" };
let finLedgerPage = 0;
const finLedgerSel = new Set();
const finLedgerExpanded = new Set();
// 流水帳發票號碼欄：按了「＋ 新增發票號碼」而展開輸入框的流水（一筆流水可以連多張發票，都在同一格）
const finLedgerInvAdding = new Set();
let finLedgerEditId = "";   // 正在清單裡展開編輯的流水
let finLedgerInvFocus = "";
let finSplitDraft = null;
const FIN_PAGE_SIZE = 100;
let finReconDraft = null;
let finImportState = null;
let finAccountEditId = "";
let finLoanEditId = "";

// ---------- 共用 ----------
// 重繪但保留捲動位置（批次整理很多筆時，不要每按一下就跳回頁首）
function finRenderKeepScroll() {
  const before = document.querySelector("main");
  const top = before ? before.scrollTop : 0;
  render();
  const after = document.querySelector("main");
  if (after) after.scrollTop = top;
}
function finDayDiff(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number), [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}
function finAddDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
// 新增流水時的自動判定。項目類別選了「第一銀行」這類還款項目，就算收款方是自家銀行名稱，也當成一般支出，
// 因為那是繳貸款，不是內部轉帳。
function finJudgeManual({ accountId, type, party, content, category }) {
  const accounts = db.finance.accounts;
  const account = accounts.find(a => a.id === accountId);
  if (!account) return { kind: "none", fee: 0 };
  const byNumber = judgeBankTransfer(`${party} ${content}`, type, account, accounts);
  if (byNumber.kind === "transfer") return byNumber;
  const named = party && accounts.find(a => a.id !== accountId && a.name && party.includes(a.name));
  if (named && !category) return { kind: "transfer", fee: 0, target: named };
  if (type !== "expense" || !party) return { kind: "none", fee: 0 };
  if (byNumber.kind === "same" || (account.name && party.includes(account.name))) return { kind: "same", fee: 0 };
  return { kind: "cross", fee: Number(account.crossBankFee) || 0 };
}
// ---- 流水與發票的類別同步 ----
// 已連結的流水和進項發票：一方沒有類別就帶入另一方的；兩邊都有但不同，跳出提示讓使用者選。
// source："link" 剛連結（問用哪一邊）、"ledger" 改了流水（問要不要更新發票）、"invoice" 改了發票（問要不要更新流水）
function finSyncCategories(entries, source, onlyInvoiceId) {
  const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
  const conflicts = [];
  let changed = false;
  entries.forEach(e => {
    if (!e || e.type !== "expense" || finIsTransfer(e)) return;
    const invs = (e.allocations || []).map(a => invById[a.invoiceId]).filter(i => i && i.kind === "purchase" && (!onlyInvoiceId || i.id === onlyInvoiceId));
    if (!invs.length) return;
    if (e.category) {
      invs.forEach(i => { if (!i.category) { i.category = e.category; changed = true; } });
    } else {
      const cats = [...new Set(invs.map(i => i.category).filter(Boolean))];
      if (cats.length === 1) { e.category = cats[0]; changed = true; }
    }
    invs.forEach(i => { if (e.category && i.category && i.category !== e.category) conflicts.push({ e, inv: i }); });
  });
  if (changed) saveDB(db);
  if (!conflicts.length) {
    if (changed) finRenderKeepScroll();
    return;
  }
  const lines = conflicts.slice(0, 8).map(({ e, inv }) => `${e.no || "流水"}「${e.category}」 ↔ 發票 ${inv.number || "（未填號碼）"}「${inv.category}」`);
  if (conflicts.length > 8) lines.push(`…等 ${conflicts.length} 筆`);
  const done = () => { saveDB(db); finRenderKeepScroll(); };
  const useLedger = { label: "用流水的類別", onClick: () => { conflicts.forEach(({ e, inv }) => { inv.category = e.category; }); done(); } };
  // 同一筆流水連到多張不同類別的發票時，沒辦法全部用發票的類別
  const invCatsPerEntry = new Map();
  conflicts.forEach(({ e, inv }) => { (invCatsPerEntry.get(e) || invCatsPerEntry.set(e, new Set()).get(e)).add(inv.category); });
  const canUseInvoice = [...invCatsPerEntry.values()].every(s => s.size === 1);
  const useInvoice = { label: "用發票的類別", onClick: () => { conflicts.forEach(({ e, inv }) => { e.category = inv.category; }); done(); } };
  if (changed) finRenderKeepScroll();
  if (source === "ledger") {
    appChoice(`流水和連結的發票類別不同：\n${lines.join("\n")}\n\n要把發票也改成流水的類別嗎？`, [{ ...useLedger, label: "一起更新發票" }], "不更新");
  } else if (source === "invoice") {
    appChoice(`發票和連結的流水類別不同：\n${lines.join("\n")}\n\n要把流水也改成發票的類別嗎？`, canUseInvoice ? [{ ...useInvoice, label: "一起更新流水" }] : [useLedger], "不更新");
  } else {
    appChoice(`流水和發票的類別不同，要以哪一邊為準？\n${lines.join("\n")}`, canUseInvoice ? [useLedger, useInvoice] : [useLedger], "先不改");
  }
}

// 發票的資訊帶入流水（只填空白欄位）：收款方 ← 廠商／客戶、類別 ← 發票類別、內容 ← 品項。回傳填了哪些欄位
function finFillEntryFromInvoice(e, inv) {
  const filled = [];
  const party = finPartyName(inv);
  if (!e.counterparty && party && party !== "-") { e.counterparty = party; filled.push("收款方"); }
  if (!e.category && inv.category && (e.type === "income" ? FIN_INCOME_CATEGORIES : FIN_EXPENSE_CATEGORIES).includes(inv.category)) { e.category = inv.category; filled.push("類別"); }
  const items = (inv.items || []).map(it => String(it.name || "").trim()).filter(Boolean);
  if (!e.content && items.length) { e.content = items.join("、"); filled.push("內容"); }
  return filled;
}
// 在流水帳 KEY 發票號碼連結發票：金額相符直接連結；不符先請使用者確認（可能是先付訂金）。
// 連結後，發票的支出單號、付款日期、付款方式由 data.js 的 syncInvoicePayments 更新。
function finLinkInvoiceByNumber(e, raw) {
  const norm = s => String(s || "").toUpperCase().replace(/[\s-]/g, "");
  const key = norm(raw);
  if (!key) return;
  const kind = e.type === "income" ? "sales" : "purchase";
  const pool = db.finance.invoices.filter(i => i.kind === kind && i.number);
  const exact = pool.filter(i => norm(i.number) === key);
  const cands = exact.length ? exact : (key.length >= 3 ? pool.filter(i => norm(i.number).includes(key)) : []);
  if (!cands.length) return alert(`找不到發票「${raw}」。請確認號碼，或先到發票登錄登錄這張發票。`);
  if (cands.length > 1) {
    // 同一個關鍵字有多張，到核對頁讓使用者挑
    finInitReconDraft(e);
    finReconDraft.mode = "invoice";
    finReconDraft.q = String(raw).trim();
    finReconDraft.showSettled = true;
    return navigateTo({ page: "fin-reconcile", finEntryId: e.id });
  }
  const inv = cands[0];
  const st = finSettlement()[inv.id];
  const label = `發票 ${inv.number}（${finPartyName(inv)}）`;
  if ((e.allocations || []).some(a => a.invoiceId === inv.id)) return alert(`${label} 已經連結這筆流水了。`);
  // 不能再分配金額的發票（不支出、現金、已全部核對）：不連結，但可以把發票的資訊帶入這筆流水
  const offerFill = reason => appConfirm(`${label} ${reason}，不能再分配金額。\n\n要把這張發票的資訊（收款方、類別、內容）帶入這筆流水嗎？\n只會填入流水上空白的欄位。`, () => {
    const filled = finFillEntryFromInvoice(e, inv);
    if (!filled.length) return alert("這筆流水的收款方、類別、內容都已經有資料，沒有需要帶入的。");
    saveDB(db);
    finRenderKeepScroll();
  }, { okLabel: "帶入資訊" });
  if (inv.payMethod === FIN_PAY_NONE) return offerFill("的付款方式是「不支出」");
  if (inv.payMethod === FIN_PAY_CASH) return offerFill("是現金付款");
  if (st.linkRemaining <= 0) return offerFill(`已經全部核對（${inv.expenseNo || "已付"}）`);
  const available = e.amount - finEntryAllocated(e) - finEntrySplitTotal(e);
  if (available <= 0) return offerFill("對應的這筆流水金額已經分配完了");
  if (kind === "sales" && (e.allocations || []).some(a => db.finance.invoices.find(i => i.id === a.invoiceId)?.clientId !== inv.clientId)) return alert("一筆入帳只能核對同一個客戶的發票。");
  const apply = () => {
    e.allocations = [...(e.allocations || []), { invoiceId: inv.id, amount: Math.min(available, st.linkRemaining) }];
    delete e.noMatch;
    delete e.loanId;
    if (kind === "sales") e.clientId = inv.clientId;
    // 連完一張後輸入框留著，可以接著 KEY 下一張（還有餘額時）
    finLedgerInvAdding.add(e.id);
    finLedgerInvFocus = e.id;
    saveDB(db);
    finRenderKeepScroll();
    finSyncCategories([e], "link");
  };
  const no = e.no || "這筆流水";
  const left = st.linkRemaining;
  if (available === left) return apply();
  if (available < left) {
    return appConfirm(`金額有出入，請確認：\n${no} 可分配金額 ${finMoney(available)}\n${label} 尚未對到流水 ${finMoney(left)}\n差額 ${finMoney(left - available)}\n\n如果是先付訂金，連結後付款方式會記為「${FIN_PAY_PARTIAL}」，尚欠的金額之後再連其他流水。`, apply, { okLabel: `記為${FIN_PAY_PARTIAL}` });
  }
  appConfirm(`金額有出入，請確認：\n${no} 可分配金額 ${finMoney(available)}\n${label} 尚未對到流水 ${finMoney(left)}\n\n這張發票會算付清，多出的 ${finMoney(available - left)} 元留在這筆流水，可以再連其他發票。`, apply, { okLabel: "連結" });
}
function finShortDate(iso) {
  const [, m, d] = String(iso || "").split("-").map(Number);
  return m && d ? `${m}月${d}日` : (iso || "");
}
// 手續費可留空（0 元）
function finParseFee(raw) { return String(raw ?? "").trim() === "" ? 0 : finParseAmount(raw, true); }
function finShortName(name) { return String(name || "").replace(/\s*[(（].*$/, ""); }
function finDefaultAccountId() {
  const a = db.finance.accounts;
  if (finLedgerDraft.accountId && a.some(x => x.id === finLedgerDraft.accountId)) return finLedgerDraft.accountId;
  return (a.find(x => x.type === "bank") || a[0])?.id || "";
}
function finAccountBalance(acc) {
  let bal = Number(acc.openingBalance) || 0;
  db.finance.ledger.forEach(e => { if (e.accountId === acc.id) bal += (e.type === "income" ? e.amount : -e.amount) - (e.fee || 0); });
  return bal;
}
// 最後一筆流水若帶有對帳單餘額，就拿來和系統算出的餘額比對，用來檢查匯入有沒有漏筆
function finAccountStatementCheck(acc) {
  const es = db.finance.ledger.filter(e => e.accountId === acc.id).sort((a, b) => a.date.localeCompare(b.date) || (a.seq || 0) - (b.seq || 0));
  const last = es[es.length - 1];
  if (!last || last.balance == null || last.balance === "") return null;
  return { stmt: Number(last.balance), diff: Number(last.balance) - finAccountBalance(acc) };
}
function finGuessClient(e) {
  const hay = `${e.counterparty || ""} ${e.ref || ""} ${e.note || ""}`;
  return finClients().find(c => { const s = finShortName(c.name); return s && hay.includes(s); })?.id || "";
}
function finCategoryList(type) { return type === "income" ? FIN_INCOME_CATEGORIES : FIN_EXPENSE_CATEGORIES; }
// 類別下拉選單：支出和發票登錄的支出項目同一份清單；已存的舊類別不在清單時仍保留顯示，不會被洗掉
function finCategoryOptions(type, selected, blankLabel = "未分類") {
  const list = finCategoryList(type);
  const old = selected && !list.includes(selected) ? `<option value="${finEsc(selected)}" selected>${finEsc(selected)}（舊項目）</option>` : "";
  return `<option value="">${blankLabel}</option>${list.map(c => `<option value="${finEsc(c)}" ${c === selected ? "selected" : ""}>${finEsc(c)}</option>`).join("")}${old}`;
}
// 同時列出收入、支出（篩選、批次設定用）；extras 是資料裡用過、但已不在清單的舊類別
function finCategoryGroupOptions(selected, extras = []) {
  const group = (label, list) => list.length ? `<optgroup label="${label}">${list.map(c => `<option value="${finEsc(c)}" ${c === selected ? "selected" : ""}>${finEsc(c)}</option>`).join("")}</optgroup>` : "";
  const incomeOnly = FIN_INCOME_CATEGORIES.filter(c => !FIN_EXPENSE_CATEGORIES.includes(c));
  const known = new Set([...FIN_EXPENSE_CATEGORIES, ...FIN_INCOME_CATEGORIES]);
  return group("支出", FIN_EXPENSE_CATEGORIES) + group("收入", incomeOnly) + group("舊項目", extras.filter(c => !known.has(c)));
}
function finOpenReconcile(entryId) {
  finReconDraft = null;
  navigateTo({ page: "fin-reconcile", finEntryId: entryId });
}

// ---------- 核對狀態 ----------
function finReconContext() {
  const loansByCategory = {}, loanById = {};
  db.finance.loans.forEach(l => {
    loanById[l.id] = l;
    const key = l.category || l.name;
    (loansByCategory[key] = loansByCategory[key] || []).push(l);
  });
  return { loansByCategory, loanById };
}
// 貸款扣款：明確指定的 loanId，或類別剛好等於某筆貸款的類別（且帳戶相符）
function finEntryLoan(e, ctx) {
  if (e.type !== "expense") return null;
  if (e.loanId) return ctx.loanById[e.loanId] || null;
  const cands = ctx.loansByCategory[e.category];
  return cands ? (cands.find(l => !l.accountId || l.accountId === e.accountId) || null) : null;
}
function finReconStatus(e, ctx) {
  if (finIsTransfer(e)) return { code: "nomatch", label: "不需核對", hint: "帳戶間轉帳" };
  if (e.noMatch) return { code: "nomatch", label: "不需核對" };
  const loan = finEntryLoan(e, ctx);
  if (loan) return { code: "loan", label: `貸款：${loan.name}`, loan };
  // 發票核對和拆分明細都算「已交代清楚」的金額
  const allocated = finEntryAllocated(e);
  const a = allocated + finEntrySplitTotal(e);
  if (a >= e.amount) return { code: "settled", label: allocated ? "已核對" : "已拆分" };
  if (a > 0) return { code: "partial", label: "部分核對" };
  return { code: "open", label: "未核對" };
}
function finReconBadge(rs) {
  const cls = { settled: "bg-emerald-100 text-emerald-700", partial: "bg-amber-100 text-amber-700", open: "bg-rose-100 text-rose-700", loan: "bg-sky-100 text-sky-700", nomatch: "bg-slate-100 text-slate-500" }[rs.code];
  return `<span class="px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${cls}" ${rs.hint ? `title="${finEsc(rs.hint)}"` : ""}>${finEsc(rs.label)}</span>`;
}

// 自動配對：金額和某張發票的未核對餘額完全相同、而且只有一張候選（或對象名稱能唯一指向）才配，其餘留給人工
function finAutoMatch() {
  const ctx = finReconContext();
  const st = finSettlement();
  const remaining = {};
  db.finance.invoices.forEach(i => { remaining[i.id] = st[i.id].linkRemaining; });
  const open = db.finance.ledger.filter(e => finReconStatus(e, ctx).code === "open").sort((a, b) => a.date.localeCompare(b.date));
  let matched = 0, ambiguous = 0, none = 0;
  const matchedEntries = [];
  open.forEach(e => {
    const kind = e.type === "income" ? "sales" : "purchase";
    let cands = db.finance.invoices.filter(i => i.kind === kind && remaining[i.id] === e.amount);
    if (e.clientId) cands = cands.filter(i => i.clientId === e.clientId);
    if (cands.length > 1) {
      const hay = `${e.counterparty || ""} ${e.ref || ""} ${e.note || ""}`;
      const byName = cands.filter(i => { const p = finShortName(finPartyName(i)); return p && p !== "-" && hay.includes(p); });
      if (byName.length === 1) cands = byName;
    }
    if (cands.length === 1) {
      const inv = cands[0];
      e.allocations = [{ invoiceId: inv.id, amount: e.amount, auto: true }];
      if (kind === "sales") e.clientId = inv.clientId;
      remaining[inv.id] = 0;
      matched++;
      matchedEntries.push(e);
    } else if (cands.length > 1) ambiguous++;
    else none++;
  });
  return { matched, ambiguous, none, matchedEntries };
}

// ============================================================
// 銀行帳戶
// ============================================================
function finRenderAccounts() {
  const accounts = db.finance.accounts;
  const edit = accounts.find(a => a.id === finAccountEditId);
  const ctx = finReconContext();
  const stat = id => {
    const es = db.finance.ledger.filter(e => e.accountId === id);
    return { n: es.length, open: es.filter(e => ["open", "partial"].includes(finReconStatus(e, ctx).code)).length };
  };
  const totalBal = accounts.reduce((s, a) => s + finAccountBalance(a), 0);

  return `
  <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
    <p class="font-semibold text-sm text-slate-700 mb-3">${edit ? `編輯帳戶：${finEsc(edit.name)}` : "新增帳戶"}</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">帳戶名稱</label>
        <input id="acc-name" value="${finEsc(edit?.name || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：合作金庫 營業帳戶"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">銀行／分行</label>
        <input id="acc-bank" value="${finEsc(edit?.bankName || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">帳號（後幾碼即可）</label>
        <input id="acc-no" value="${finEsc(edit?.accountNo || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
      </div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">期初餘額（可為負數）</label>
        <input id="acc-open" type="number" step="1" value="${edit ? Number(edit.openingBalance) || 0 : 0}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">流水編號代碼</label>
        <input id="acc-code" value="${finEsc(edit?.code || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1 font-mono" placeholder="例：T1（留空自動給）"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">銀行代碼（三碼）</label>
        <input id="acc-bankcode" value="${finEsc(edit?.bankCode || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1 font-mono" placeholder="例：007"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">跨行手續費（每筆）</label>
        <input id="acc-fee" type="number" min="0" step="1" value="${edit ? Number(edit.crossBankFee) || 0 : ""}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div class="col-span-2 md:col-span-4">
        <label class="text-xs text-slate-500">備註（選填）</label>
        <input id="acc-note" value="${finEsc(edit?.note || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
      </div>
    </div>
    <button id="acc-save-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">${edit ? "儲存變更" : "新增帳戶"}</button>
    ${edit ? `<button id="acc-cancel-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消編輯</button>` : ""}
    <p id="acc-msg" class="text-xs hidden mt-2"></p>
  </div>

  <p class="text-sm text-slate-500 mb-2">共 ${accounts.length} 個帳戶，系統餘額合計 <span class="font-semibold text-slate-800">NT$ ${finMoney(totalBal)}</span></p>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">代碼</th><th class="px-4 py-2">帳戶</th><th class="px-4 py-2">銀行／帳號</th><th class="px-4 py-2 text-right whitespace-nowrap">跨行手續費</th><th class="px-4 py-2 text-right">期初餘額</th><th class="px-4 py-2 text-right">系統餘額</th><th class="px-4 py-2 text-right">對帳單餘額差異</th><th class="px-4 py-2 text-right">筆數</th><th class="px-4 py-2 text-right">待核對</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        ${accounts.map(a => { const s = stat(a.id), chk = finAccountStatementCheck(a), bal = finAccountBalance(a); return `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 font-mono text-xs">${finEsc(a.code) || `<span class="text-slate-300">-</span>`}</td>
            <td class="px-4 py-2 font-medium">${finEsc(a.name)}</td>            <td class="px-4 py-2 text-slate-500">${finEsc([a.bankCode, a.bankName, a.accountNo].filter(Boolean).join(" ")) || "-"}</td>
            <td class="px-4 py-2 text-right">${finMoney(a.crossBankFee)}</td>
            <td class="px-4 py-2 text-right">${finMoney(a.openingBalance)}</td>
            <td class="px-4 py-2 text-right font-semibold ${bal < 0 ? "text-rose-600" : ""}">${finMoney(bal)}</td>
            <td class="px-4 py-2 text-right">${chk ? (chk.diff === 0 ? `<span class="text-emerald-600" title="最後一筆對帳單餘額 ${finMoney(chk.stmt)}">相符</span>` : `<span class="text-rose-600 font-semibold" title="最後一筆對帳單餘額 ${finMoney(chk.stmt)}，和系統差 ${finMoney(chk.diff)}（可能漏匯入或期初餘額不對）">差 ${finMoney(chk.diff)}</span>`) : `<span class="text-slate-300">-</span>`}</td>
            <td class="px-4 py-2 text-right">${s.n}</td>
            <td class="px-4 py-2 text-right ${s.open ? "text-amber-600 font-semibold" : "text-slate-400"}">${s.open || "-"}</td>
            <td class="px-4 py-2 text-right whitespace-nowrap">
              <button data-id="${finEsc(a.id)}" class="acc-ledger-btn text-blue-600 hover:underline text-xs mr-2">流水帳</button>
              ${a.type === "bank" ? `<button data-id="${finEsc(a.id)}" class="acc-import-btn text-blue-600 hover:underline text-xs mr-2">匯入對帳單</button>` : ""}
              <button data-id="${finEsc(a.id)}" class="acc-edit-btn text-slate-600 hover:underline text-xs mr-2">編輯</button>
              <button data-id="${finEsc(a.id)}" class="acc-del-btn text-rose-500 hover:underline text-xs">刪除</button>
            </td>
          </tr>`; }).join("")}
      </tbody>
    </table>
  </div>
  <p class="text-xs text-slate-400 mt-2">「對帳單餘額差異」是用最後一筆匯入流水所帶的餘額，和「期初餘額＋流水收支」算出的系統餘額比對；不是 0 通常代表漏匯入某幾筆或期初餘額沒填對。</p>`;
}

function finBindAccounts() {
  const $ = id => document.getElementById(id);
  $("acc-save-btn").onclick = () => {
    const name = $("acc-name").value.trim();
    const opening = Number($("acc-open").value || 0);
    const fail = msg => showMsg("acc-msg", msg, true);
    if (!name) return fail("請輸入帳戶名稱");
    if (!Number.isInteger(opening)) return fail("期初餘額請輸入整數");
    if (db.finance.accounts.some(a => a.name === name && a.id !== finAccountEditId)) return fail("已經有同名的帳戶了");
    const code = $("acc-code").value.trim().toUpperCase();
    if (code && !/^[A-Z0-9]+$/.test(code)) return fail("流水編號代碼只能用英文和數字，例如 T1");
    if (code && db.finance.accounts.some(a => a.code === code && a.id !== finAccountEditId)) return fail(`代碼 ${code} 已經有其他帳戶使用了`);
    const edit = db.finance.accounts.find(a => a.id === finAccountEditId);
    const type = edit?.type || "bank";   // 新帳戶一律是銀行帳戶
    if (edit && !code && type === "bank") return fail("銀行帳戶請填流水編號代碼");
    const bankCode = $("acc-bankcode").value.trim();
    if (bankCode && !/^\d{3}$/.test(bankCode)) return fail("銀行代碼請輸入三位數字，例如 007");
    const feeRaw = $("acc-fee").value;
    const crossBankFee = finParseFee(feeRaw);
    if (crossBankFee === null) return fail("跨行手續費請輸入 0 或正整數");
    const data = { name, type, bankName: $("acc-bank").value.trim(), accountNo: $("acc-no").value.trim(), openingBalance: opening, note: $("acc-note").value.trim(), code };
    // 新帳戶留空時交給系統依銀行名稱帶入
    if (edit || bankCode) data.bankCode = bankCode;
    if (edit || String(feeRaw).trim() !== "") data.crossBankFee = crossBankFee;
    if (edit) {
      // 已編好的流水編號固定不變；新代碼只用在之後新增的流水
      Object.assign(edit, data);
    } else db.finance.accounts.push({ id: finId("acc"), ...data });
    finAccountEditId = "";
    finSave();
  };
  $("acc-cancel-btn")?.addEventListener("click", () => { finAccountEditId = ""; render(); });
  document.querySelectorAll(".acc-edit-btn").forEach(b => { b.onclick = () => { finAccountEditId = b.dataset.id; render(); }; });
  document.querySelectorAll(".acc-ledger-btn").forEach(b => {
    b.onclick = () => { finLedgerFilter = { account: b.dataset.id, type: "", category: "", recon: "", month: "", q: "" }; finLedgerPage = 0; navigateTo({ page: "fin-ledger" }); };
  });
  document.querySelectorAll(".acc-import-btn").forEach(b => { b.onclick = () => finStartImport(b.dataset.id); });
  document.querySelectorAll(".acc-del-btn").forEach(b => {
    b.onclick = () => {
      const a = db.finance.accounts.find(x => x.id === b.dataset.id);
      if (!a) return;
      if (db.finance.ledger.some(e => e.accountId === a.id)) { alert("這個帳戶已經有流水帳，不能刪除。請先把流水帳刪除或改到其他帳戶。"); return; }
      if (db.finance.loans.some(l => l.accountId === a.id)) { alert("有貸款設定使用這個帳戶扣款，請先修改或刪除那筆貸款。"); return; }
      if (db.finance.accounts.length <= 1) { alert("至少要保留一個帳戶。"); return; }
      appConfirm(`確定要刪除帳戶「${a.name}」嗎？`, () => {
        db.finance.accounts = db.finance.accounts.filter(x => x.id !== a.id);
        if (finLedgerFilter.account === a.id) finLedgerFilter.account = "";
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
}

// ============================================================
// 流水帳
// ============================================================
function finFilteredLedger(ctx, skipColumnFilters) {
  const f = finLedgerFilter;
  // 由舊到新，和銀行明細表的順序一樣
  let rows = db.finance.ledger.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.seq || 0) - (b.seq || 0) || a.id.localeCompare(b.id));
  if (f.account) rows = rows.filter(e => e.accountId === f.account);
  if (f.type) rows = rows.filter(e => e.type === f.type);
  if (f.category) rows = rows.filter(e => f.category === "__none__" ? !e.category : e.category === f.category);
  if (f.month) rows = rows.filter(e => finMonthOf(e.date) === f.month);
  const q = f.q.trim().toLowerCase();
  if (q) {
    const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
    rows = rows.filter(e => {
      const invNos = (e.allocations || []).map(a => invById[a.invoiceId]?.number || "").join(" ");
      const splits = (e.splits || []).map(x => [x.name, x.vendor, x.payee, x.item, x.number, x.project, x.category, x.note].filter(Boolean).join(" ")).join(" ");
      return `${e.no || ""} ${e.category || ""} ${e.counterparty || ""} ${e.content || ""} ${e.ref || ""} ${e.note || ""} ${e.amount} ${invNos} ${splits}`.toLowerCase().includes(q);
    });
  }
  if (f.recon) rows = rows.filter(e => finReconStatus(e, ctx).code === f.recon);
  if (skipColumnFilters) return rows;
  // 欄位篩選（點欄位標題旁的 ▼，和發票登錄同一套）
  const cf = finLedColFilter;
  const has = (text, query) => !query.trim() || String(text || "").toLowerCase().includes(query.trim().toLowerCase());
  const inList = (value, selected) => !selected.length || selected.includes(encodeURIComponent(value));
  const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
  return rows.filter(e => {
    const v = finLedColValues(e, ctx, invById);
    return has(v.no, cf.noQuery) && has(v.content, cf.contentQuery) && has(v.inv, cf.invQuery) && has(e.note, cf.noteQuery)
      && (!cf.dateFrom || e.date >= cf.dateFrom) && (!cf.dateTo || e.date <= cf.dateTo)
      && inList(v.category, cf.categories) && inList(v.party, cf.parties) && inList(v.recon, cf.recons);
  });
}
// ---- 流水帳的欄位篩選 ----
function finLedNewColFilter() { return { noQuery: "", dateFrom: "", dateTo: "", categories: [], contentQuery: "", invQuery: "", noteQuery: "", parties: [], recons: [] }; }
let finLedColFilter = finLedNewColFilter();
function finLedColActive(cf) {
  return !!(cf.noQuery || cf.dateFrom || cf.dateTo || cf.contentQuery || cf.invQuery || cf.noteQuery || cf.categories.length || cf.parties.length || cf.recons.length);
}
// 各欄拿來篩選的值（清單型用 encodeURIComponent 當選項 id）
function finLedColValues(e, ctx, invById) {
  return {
    no: `${e.no || ""} ${finAccountName(e.accountId)}`,
    category: e.category || "（未分類）",
    content: `${e.content || ""} ${e.ref || ""}`,
    inv: [...(e.allocations || []).map(a => invById[a.invoiceId]?.number || ""), ...(e.splits || []).map(x => x.number || "")].join(" "),
    party: e.counterparty || "（未填）",
    recon: finReconStatus(e, ctx).label.replace(/：.*$/, ""),
  };
}

// 新增流水時加入的發票（可多張）：列出號碼、對象、待對帳金額和合計
function finNewEntryInvs() {
  const st = finSettlement();
  return (finLedgerDraft.invIds || []).map(id => db.finance.invoices.find(i => i.id === id)).filter(Boolean).map(inv => ({ inv, remaining: st[inv.id].linkRemaining }));
}
function finNewEntryInvListHtml() {
  const rows = finNewEntryInvs();
  if (!rows.length) return "";
  const total = rows.reduce((s, r) => s + r.remaining, 0);
  return `
    <table class="text-sm w-full max-w-3xl border rounded mt-2">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr>
        <th class="px-3 py-1.5">序</th><th class="px-3 py-1.5">發票號碼</th><th class="px-3 py-1.5">發票日期</th><th class="px-3 py-1.5">廠商／客戶</th><th class="px-3 py-1.5 text-right">待對帳金額</th><th class="px-3 py-1.5"></th>
      </tr></thead>
      <tbody>${rows.map(({ inv, remaining }, n) => `
        <tr class="border-t">
          <td class="px-3 py-1.5 text-xs text-slate-400">${n + 1}</td>
          <td class="px-3 py-1.5 font-mono">${finEsc(inv.number)}</td>
          <td class="px-3 py-1.5 text-slate-500 whitespace-nowrap">${finEsc(inv.date) || "-"}</td>
          <td class="px-3 py-1.5">${finEsc(finPartyName(inv))}</td>
          <td class="px-3 py-1.5 text-right">${finMoney(remaining)}</td>
          <td class="px-3 py-1.5 text-center"><button type="button" class="led-new-inv-del text-slate-400 hover:text-rose-500 px-1" data-id="${finEsc(inv.id)}" title="移除這張發票" aria-label="移除發票 ${finEsc(inv.number)}">✕</button></td>
        </tr>`).join("")}
      </tbody>
      <tfoot><tr class="border-t bg-slate-50 font-semibold">
        <td class="px-3 py-1.5" colspan="4">合計 ${rows.length} 張發票</td>
        <td class="px-3 py-1.5 text-right">${finMoney(total)}</td><td></td>
      </tr></tfoot>
    </table>`;
}

function finRenderLedger() {
  const ctx = finReconContext();
  const d = finLedgerDraft, f = finLedgerFilter;
  const accounts = db.finance.accounts;
  const rows = finFilteredLedger(ctx);
  // 欄位篩選：選項從「上方篩選後、欄位篩選前」的流水算出來
  if (typeof COLUMN_FILTERS !== "undefined") COLUMN_FILTERS.fled = () => finLedColFilter;
  const cf = finLedColFilter;
  const ledInvById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
  const baseRows = finFilteredLedger(ctx, true);
  const listOptions = pick => [...new Set(baseRows.map(e => pick(finLedColValues(e, ctx, ledInvById))))].sort((a, b) => a.localeCompare(b, "zh-Hant")).map(v => ({ id: encodeURIComponent(v), name: finEsc(v) }));
  const colTh = (key, label, kind, cfg, style = "") => renderHeaderFilter("fled", key, label, kind, cfg)
    .replace('class="px-4 py-2 relative whitespace-nowrap"', `class="px-3 py-2 relative whitespace-nowrap" ${style ? `style="${style}"` : ""}`)
    .replace("left-0 bottom-full mb-1", "left-0 top-full mt-1");
  const pages = Math.max(1, Math.ceil(rows.length / FIN_PAGE_SIZE));
  if (finLedgerPage >= pages) finLedgerPage = pages - 1;
  const pageRows = rows.slice(finLedgerPage * FIN_PAGE_SIZE, (finLedgerPage + 1) * FIN_PAGE_SIZE);
  const plain = rows.filter(e => !finIsTransfer(e));
  const income = plain.filter(e => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const expense = plain.filter(e => e.type === "expense").reduce((s, e) => s + e.amount, 0);
  const feeTotal = rows.reduce((s, e) => s + (e.fee || 0), 0);
  const transferNet = rows.filter(finIsTransfer).reduce((s, e) => s + (e.type === "income" ? e.amount : -e.amount), 0);
  const hasTransfer = rows.some(finIsTransfer);
  const signed = n => `${n > 0 ? "+" : n < 0 ? "−" : ""}${finMoney(Math.abs(n))}`;
  const codes = rows.map(e => finReconStatus(e, ctx).code);
  const cnt = c => codes.filter(x => x === c).length;
  const categories = [...new Set(db.finance.ledger.map(e => e.category).filter(Boolean))].sort();
  const parties = [...new Set([...accounts.map(a => a.name), ...finClients().map(c => c.name), ...db.finance.invoices.filter(i => i.vendor).map(i => i.vendor)])];
  const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
  const defAcc = finDefaultAccountId();
  const allSelected = pageRows.length > 0 && pageRows.every(e => finLedgerSel.has(e.id));
  const reconOptions = [["", "全部"], ["open", "未核對"], ["partial", "部分核對"], ["settled", "已核對"], ["loan", "貸款扣款"], ["nomatch", "不需核對"]];

  return `
  <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
    <div class="flex items-center justify-between mb-3">
      <p class="font-semibold text-sm text-slate-700">新增流水</p>
      <div class="flex gap-2">
        <button id="led-import-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">⬆ 匯入銀行對帳單</button>
        <button id="led-auto-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100" title="金額和發票未核對餘額完全相同，且只有一張候選時才配對">⚡ 自動配對發票</button>
      </div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">帳戶</label>
        <select id="led-account" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${accounts.map(a => `<option value="${finEsc(a.id)}" ${a.id === defAcc ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">匯款日期</label>
        <input id="led-date" type="date" value="${d.date || todayISO()}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">銷項／進項</label>
        <select id="led-type" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          <option value="expense" ${d.type === "expense" ? "selected" : ""}>銷項（支出）</option>
          <option value="income" ${d.type === "income" ? "selected" : ""}>進項（收入）</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">項目類別</label>
        <select id="led-category" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${finCategoryOptions(d.type, "", "請選擇")}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">收款方（選填）</label>
        <input id="led-party" list="led-party-list" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
        <datalist id="led-party-list">${parties.map(p => `<option value="${finEsc(p)}"></option>`).join("")}</datalist>
      </div>
      <div>
        <label class="text-xs text-slate-500">內容（選填）</label>
        <input id="led-content" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">金額</label>
        <input id="led-amount" type="number" min="0" step="1" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="整數元"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">手續費（選填）</label>
        <input id="led-fee" type="number" min="0" step="1" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500" for="led-new-inv">發票號碼（選填，一筆流水可加入多張發票，金額自動加總）</label>
      <div class="flex gap-2 mt-1 max-w-xl">
        <input id="led-new-inv" list="${d.type === "income" ? "led-inv-sales" : "led-inv-purchase"}" autocomplete="off" class="flex-1 border rounded-lg px-3 py-2 text-sm font-mono" placeholder="KEY 發票號碼後按 Enter"/>
        <button id="led-new-inv-add" type="button" class="border rounded-lg text-sm px-3 py-2 hover:bg-slate-100 whitespace-nowrap">＋ 加入發票</button>
      </div>
      <div id="led-new-inv-list">${finNewEntryInvListHtml()}</div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">備註（選填）</label>
      <input id="led-note" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
    </div>
    <p id="led-judge" class="text-xs text-slate-500 mb-3 hidden" role="status"></p>
    <button id="led-add-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">新增</button>
    <p id="led-msg" class="text-xs hidden mt-2"></p>

    <details class="mt-4 border-t pt-3">
      <summary class="text-sm text-slate-600 cursor-pointer">帳戶間轉帳（自己的帳戶互轉，不算收入／支出）</summary>
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3 items-end">
        <div><label class="text-xs text-slate-500">日期</label><input id="tr-date" type="date" value="${todayISO()}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
        <div><label class="text-xs text-slate-500">轉出帳戶</label><select id="tr-from" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${accounts.map(a => `<option value="${finEsc(a.id)}">${finEsc(a.name)}</option>`).join("")}</select></div>
        <div><label class="text-xs text-slate-500">轉入帳戶</label><select id="tr-to" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${accounts.map((a, i) => `<option value="${finEsc(a.id)}" ${i === 1 ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select></div>
        <div><label class="text-xs text-slate-500">金額</label><input id="tr-amount" type="number" min="0" step="1" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="整數元"/></div>
        <div><button id="tr-add-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 w-full">建立轉帳</button></div>
      </div>
      <p id="tr-msg" class="text-xs hidden mt-2"></p>
    </details>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-4 mb-3">
    <div class="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
      <div>
        <label class="text-xs text-slate-500">帳戶</label>
        <select id="led-f-account" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1"><option value="">全部帳戶</option>${accounts.map(a => `<option value="${finEsc(a.id)}" ${f.account === a.id ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">銷項／進項</label>
        <select id="led-f-type" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">
          <option value="">全部</option><option value="expense" ${f.type === "expense" ? "selected" : ""}>銷項（支出）</option><option value="income" ${f.type === "income" ? "selected" : ""}>進項（收入）</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">類別</label>
        <select id="led-f-category" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">
          <option value="">全部</option><option value="__none__" ${f.category === "__none__" ? "selected" : ""}>（未分類）</option>
          ${finCategoryGroupOptions(f.category, categories)}
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">核對狀態</label>
        <select id="led-f-recon" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">${reconOptions.map(([v, t]) => `<option value="${v}" ${f.recon === v ? "selected" : ""}>${t}</option>`).join("")}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">月份</label>
        <input id="led-f-month" type="month" value="${f.month}" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">搜尋</label>
        <input id="led-f-q" value="${finEsc(f.q)}" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1" placeholder="編號／類別／對象／金額／發票號碼，按 Enter"/>
      </div>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2 mt-3">
      <p class="text-xs text-slate-500">
        共 ${rows.length} 筆　｜　銷項 <span class="text-rose-600 font-semibold">${finMoney(expense)}</span>　｜　進項 <span class="text-emerald-600 font-semibold">${finMoney(income)}</span>　｜　手續費 <span class="font-semibold">${finMoney(feeTotal)}</span>　｜　淨額 <span class="font-semibold ${income - expense - feeTotal < 0 ? "text-rose-600" : "text-slate-800"}">${finMoney(income - expense - feeTotal)}</span>
        　｜　未核對 <span class="${cnt("open") ? "text-rose-600 font-semibold" : ""}">${cnt("open")}</span>　部分 <span class="${cnt("partial") ? "text-amber-600 font-semibold" : ""}">${cnt("partial")}</span>　已核對 ${cnt("settled")}　貸款 ${cnt("loan")}
      </p>
      <div class="flex gap-2">
        <button id="led-f-clear" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">清除篩選</button>
        <button id="led-export-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>
      </div>
    </div>
  </div>

  ${(() => {
    // KEY 發票號碼時的提示：列出全部發票；已全部核對的也列出來（選了可以把資訊帶入流水）
    const st = finSettlement();
    const pays = finInvoicePayments();
    const hint = i => st[i.id].linkRemaining > 0 ? `待對帳 ${finMoney(st[i.id].linkRemaining)}`
      : i.payMethod === FIN_PAY_NONE ? "不支出" : i.payMethod === FIN_PAY_CASH ? "現金付款"
      : `已全部核對${(pays[i.id] || []).length ? `（${pays[i.id].map(p => p.no).filter(Boolean).join("、")}）` : ""}`;
    const list = kind => db.finance.invoices.filter(i => i.kind === kind && i.number).map(i => `<option value="${finEsc(i.number)}">${finEsc(finPartyName(i))} ${finEsc(hint(i))}</option>`).join("");
    return `<datalist id="led-inv-purchase">${list("purchase")}</datalist><datalist id="led-inv-sales">${list("sales")}</datalist>`;
  })()}
  <div class="bg-slate-800 text-white rounded-xl px-4 py-2 mb-3 flex flex-wrap items-center gap-3 text-sm">
    <span>已選 <b id="led-sel-count">${finLedgerSel.size}</b> 筆</span>
    <select id="led-bulk-cat" aria-label="批次設定類別" class="rounded-lg px-2 py-1 text-sm text-slate-800"><option value="">批次設定類別</option>${finCategoryGroupOptions("")}</select>
    <button id="led-bulk-cat-btn" class="led-bulk bg-white text-slate-800 rounded-lg px-3 py-1 text-xs hover:bg-slate-100">套用類別</button>
    <button id="led-bulk-nomatch-btn" class="led-bulk bg-white text-slate-800 rounded-lg px-3 py-1 text-xs hover:bg-slate-100">標記不需核對</button>
    <button id="led-bulk-unmatch-btn" class="led-bulk bg-white text-slate-800 rounded-lg px-3 py-1 text-xs hover:bg-slate-100">取消核對</button>
    <button id="led-bulk-del-btn" class="led-bulk bg-rose-500 text-white rounded-lg px-3 py-1 text-xs hover:bg-rose-600">刪除所選</button>
    <button id="led-bulk-clear-btn" class="led-bulk text-slate-300 hover:text-white text-xs underline">清除選取</button>
  </div>

  <div class="flex items-center justify-between mb-1">
    <p class="text-xs text-slate-500">點欄位標題旁的 ▼ 即可篩選${finLedColActive(cf) ? `，目前顯示 ${rows.length} 筆` : ""}</p>
    ${finLedColActive(cf) ? `<button id="led-col-clear" class="text-xs text-blue-600 hover:underline">清除欄位篩選</button>` : ""}
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-x-auto" style="${String(colMenu.id || "").startsWith("fled:") ? "min-height: 340px;" : ""}">
    <table class="grid-table w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-3 py-2"><input type="checkbox" id="led-sel-all" ${allSelected ? "checked" : ""}/></th>
          ${colTh("noQuery", "匯款編號", "text", { value: cf.noQuery })}
          ${colTh("date", "匯款日期", "date", { from: cf.dateFrom, to: cf.dateTo, fromKey: "dateFrom", toKey: "dateTo", years: [...new Set(db.finance.ledger.map(x => x.date && x.date.slice(0, 4)).filter(Boolean))] })}
          ${colTh("categories", "項目類別", "list", { options: listOptions(v => v.category), selected: cf.categories })}
          ${colTh("contentQuery", "內容", "text", { value: cf.contentQuery }, "min-width: 9rem")}
          ${colTh("invQuery", "發票號碼", "text", { value: cf.invQuery }, "min-width: 10rem")}
          <th class="px-3 py-2 text-right whitespace-nowrap">銷項（支出）</th><th class="px-3 py-2 text-right whitespace-nowrap">進項（收入）</th><th class="px-3 py-2 text-right whitespace-nowrap">互匯未實際扣</th><th class="px-3 py-2 text-right whitespace-nowrap">手續費</th>
          ${colTh("noteQuery", "備註", "text", { value: cf.noteQuery }, "min-width: 5rem")}
          ${colTh("parties", "收款方", "list", { options: listOptions(v => v.party), selected: cf.parties }, "min-width: 7rem")}
          ${colTh("recons", "核對", "list", { options: listOptions(v => v.recon), selected: cf.recons })}
          <th class="px-3 py-2 sticky right-0 bg-slate-100"></th></tr>
      </thead>
      <tbody>
        ${pageRows.map((e, n) => { const isEdit = finLedgerEditId === e.id; const rs = finReconStatus(e, ctx); const nums = (e.allocations || []).map(a => invById[a.invoiceId]?.number).filter(Boolean); const transfer = finIsTransfer(e); const splits = e.splits || []; const splitOpen = finLedgerExpanded.has(e.id); return `
          <tr class="data-row ${n % 2 ? "row-alt" : ""} ${!e.category && !transfer ? "row-warn" : ""} ${isEdit ? "row-editing" : ""}" data-row-id="${finEsc(e.id)}">
            <td class="px-3 py-2"><input type="checkbox" class="led-sel" data-id="${finEsc(e.id)}" ${finLedgerSel.has(e.id) ? "checked" : ""}/></td>
            <td class="px-3 py-2 whitespace-nowrap"><div class="font-mono">${finEsc(e.no) || `<span class="text-slate-300">-</span>`}</div>${f.account ? "" : `<div class="text-[11px] text-slate-400">${finEsc(finAccountName(e.accountId))}</div>`}</td>
            <td class="px-3 py-2 text-slate-500 whitespace-nowrap" title="${finEsc(e.date)}">${finEsc(finShortDate(e.date))}</td>
            <td class="px-3 py-2">${transfer ? `<span class="text-slate-500">${finEsc(e.category)}</span>` : `<select class="led-cat-input border rounded-lg px-2 py-1 text-sm w-40 ${e.category ? "" : "border-amber-300"}" data-id="${finEsc(e.id)}" aria-label="類別">${finCategoryOptions(e.type, e.category)}</select>`}${splits.length ? `<button type="button" data-id="${finEsc(e.id)}" class="led-split-toggle block text-xs text-blue-600 mt-1" aria-expanded="${splitOpen}"><span class="led-split-chevron">${splitOpen ? "▾" : "▸"}</span> 拆分 ${splits.length} 筆</button>` : ""}</td>
            <td class="px-3 py-2">
              ${e.content ? `<div>${finEsc(e.content)}</div>` : ""}
              ${e.ref ? `<div class="text-xs text-slate-400">${finEsc(e.ref)}</div>` : ""}
            </td>
            <td class="px-3 py-2">
              ${(e.allocations || []).filter(a => invById[a.invoiceId]).map(a => `
                <div class="flex items-center gap-1 whitespace-nowrap">
                  <button type="button" data-id="${finEsc(e.id)}" class="led-recon-btn text-left font-mono ${a.auto ? "text-blue-600" : "text-slate-500"} hover:underline" title="${a.auto ? "系統自動核對" : "手動連結"}（${finMoney(a.amount)}），點了開啟核對">${finEsc(invById[a.invoiceId].number) || "（無號碼）"}</button>
                  <button type="button" data-id="${finEsc(e.id)}" data-inv="${finEsc(a.invoiceId)}" class="led-inv-unlink text-slate-300 hover:text-rose-500 px-1" title="取消連結這張發票" aria-label="取消連結發票 ${finEsc(invById[a.invoiceId].number)}">✕</button>
                </div>`).join("")}
              ${!transfer && e.amount - finEntryAllocated(e) - finEntrySplitTotal(e) > 0
                ? (nums.length && !finLedgerInvAdding.has(e.id)
                  ? `<button type="button" data-id="${finEsc(e.id)}" class="led-inv-add text-xs text-blue-600 hover:underline mt-1 whitespace-nowrap">＋ 新增發票號碼</button>`
                  : `<input class="led-inv-input border rounded px-2 py-1 text-sm w-full ${nums.length ? "mt-1" : ""} font-mono" list="${e.type === "income" ? "led-inv-sales" : "led-inv-purchase"}" data-id="${finEsc(e.id)}" autocomplete="off" aria-label="輸入發票號碼" placeholder="KEY 發票號碼後按 Enter"/>`)
                : ""}
            </td>
            ${(() => {
              const balanceTitle = e.balance != null && e.balance !== "" ? `title="對帳單餘額 ${finMoney(e.balance)}"` : "";
              const cell = cls => `<td class="px-3 py-2 text-right font-semibold whitespace-nowrap ${cls}" ${balanceTitle}>${finMoney(e.amount)}</td>`;
              const empty = `<td class="px-3 py-2"></td>`;
              if (transfer) return `${empty}${empty}<td class="px-3 py-2 text-right whitespace-nowrap text-slate-600" ${balanceTitle}>${signed(e.type === "income" ? e.amount : -e.amount)}</td>`;
              return e.type === "expense" ? `${cell("text-rose-600")}${empty}${empty}` : `${empty}${cell("text-emerald-600")}${empty}`;
            })()}
            <td class="px-3 py-2 text-right text-slate-600">${e.fee ? finMoney(e.fee) : ""}</td>
            <td class="px-3 py-2 text-slate-500">${finEsc(e.note) || ""}</td>
            <td class="px-3 py-2">${finEsc(e.counterparty) || ""}</td>
            <td class="px-3 py-2">${finReconBadge(rs)}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap sticky right-0 bg-white border-l">
              ${e.autoTransfer ? `<button data-id="${finEsc(e.id)}" class="led-untransfer-btn text-blue-600 hover:underline text-xs mr-2" title="這筆不是內部轉帳時，改回一般流水">改為一般流水</button>` : ""}
              ${transfer ? "" : `<button data-id="${finEsc(e.id)}" class="led-recon-btn text-blue-600 hover:underline text-xs mr-2" title="連結發票或貸款">核對</button>${e.type === "expense" ? `<button data-id="${finEsc(e.id)}" class="led-split-btn text-blue-600 hover:underline text-xs mr-2">拆分</button>` : ""}<button data-id="${finEsc(e.id)}" class="led-edit-btn text-slate-600 hover:underline text-xs mr-2">編輯</button>`}
              <button data-id="${finEsc(e.id)}" class="led-del-btn text-rose-500 hover:underline text-xs">刪除</button>
            </td>
          </tr>
          ${splits.length ? `<tr class="${splitOpen ? "" : "hidden"} detail-row"><td colspan="14" class="px-3 py-2">${finSplitDetailHtml(e)}</td></tr>` : ""}
          ${isEdit ? `<tr class="edit-row"><td colspan="14" class="px-4 py-4"><div class="inline-edit-box sticky left-0"><p class="font-semibold text-sm text-slate-700 mb-3">編輯流水：${finEsc(e.no) || finEsc(e.date)}</p>${finEntryEditFormHtml(e)}</div></td></tr>` : ""}`; }).join("") || `<tr><td colspan="14" class="px-4 py-8 text-center text-slate-400">沒有符合條件的流水</td></tr>`}
      </tbody>
      ${rows.length ? `
      <tfoot class="bg-slate-50 border-t-2 font-semibold">
        <tr>
          <td colspan="6" class="px-3 py-2 text-slate-600">合計（${rows.length} 筆）</td>
          <td class="px-3 py-2 text-right whitespace-nowrap text-rose-600">${finMoney(expense)}</td>
          <td class="px-3 py-2 text-right whitespace-nowrap text-emerald-600">${finMoney(income)}</td>
          <td class="px-3 py-2 text-right whitespace-nowrap text-slate-600">${hasTransfer ? signed(transferNet) || "0" : ""}</td>
          <td class="px-3 py-2 text-right whitespace-nowrap text-slate-600">${finMoney(feeTotal)}</td>
          <td colspan="4"></td>
        </tr>
      </tfoot>` : ""}
    </table>
  </div>
  ${rows.length > FIN_PAGE_SIZE ? `
  <div class="flex items-center justify-center gap-3 mt-3 text-sm">
    <button id="led-prev" class="border rounded-lg px-3 py-1 hover:bg-slate-100 ${finLedgerPage === 0 ? "opacity-40" : ""}">← 上一頁</button>
    <span class="text-slate-500">第 ${finLedgerPage + 1} / ${pages} 頁（每頁 ${FIN_PAGE_SIZE} 筆）</span>
    <button id="led-next" class="border rounded-lg px-3 py-1 hover:bg-slate-100 ${finLedgerPage >= pages - 1 ? "opacity-40" : ""}">下一頁 →</button>
  </div>` : ""}`;
}

function finBindLedger() {
  const $ = id => document.getElementById(id);
  const resetPage = () => { finLedgerPage = 0; finLedgerSel.clear(); };

  // ---- 新增流水 ----
  $("led-type").onchange = () => {
    finLedgerDraft.type = $("led-type").value;
    $("led-category").innerHTML = finCategoryOptions(finLedgerDraft.type, "", "請選擇");
    // 支出對進項發票、收入對銷項發票：換了就清掉已加入的發票
    finLedgerDraft.invIds = [];
    $("led-new-inv").setAttribute("list", finLedgerDraft.type === "income" ? "led-inv-sales" : "led-inv-purchase");
    refreshNewInvs();
    updateJudge();
  };
  // ---- 新增流水：加入多張發票，金額自動加總（自己改過金額就不再覆蓋） ----
  let amountTouched = false;
  $("led-amount").addEventListener("input", () => { amountTouched = $("led-amount").value !== ""; });
  const refreshNewInvs = () => {
    $("led-new-inv-list").innerHTML = finNewEntryInvListHtml();
    const rows = finNewEntryInvs();
    if (!amountTouched) $("led-amount").value = rows.length ? rows.reduce((s, r) => s + r.remaining, 0) : "";
    const only = pick => { const v = [...new Set(rows.map(r => pick(r.inv)).filter(x => x && x !== "-"))]; return v.length === 1 ? v[0] : ""; };
    // 收款方、類別空白時，所有發票同一個廠商／類別就帶入
    if (rows.length && !$("led-party").value.trim() && only(finPartyName)) { $("led-party").value = only(finPartyName); updateJudge(); }
    const cat = only(i => i.category);
    if (rows.length && !$("led-category").value && cat && [...$("led-category").options].some(o => o.value === cat)) { $("led-category").value = cat; updateJudge(); }
    document.querySelectorAll(".led-new-inv-del").forEach(b => {
      b.onclick = () => { finLedgerDraft.invIds = (finLedgerDraft.invIds || []).filter(id => id !== b.dataset.id); refreshNewInvs(); };
    });
  };
  const addNewInv = () => {
    const fail = msg => showMsg("led-msg", msg, true);
    const raw = $("led-new-inv").value.trim();
    const key = finNormInvNo(raw);
    if (!key) return;
    const kind = $("led-type").value === "income" ? "sales" : "purchase";
    const ids = finLedgerDraft.invIds = finLedgerDraft.invIds || [];
    const st = finSettlement();
    const exact = db.finance.invoices.filter(i => i.kind === kind && finNormInvNo(i.number) === key);
    if (!exact.length) return fail(`找不到${kind === "sales" ? "銷項" : "進項"}發票「${raw}」。請確認號碼，或先到${kind === "sales" ? "應收帳款" : "發票登錄"}登錄這張發票。`);
    const pick = exact.find(i => !ids.includes(i.id) && st[i.id].linkRemaining > 0);
    if (!pick && exact.some(i => ids.includes(i.id))) return fail(`發票「${raw}」已經加入了`);
    if (!pick) {
      // 已全部核對（或現金、不支出）的發票：不加入連結，只把資訊帶入表單空白的欄位
      const inv = exact[0];
      const filled = [];
      const party = finPartyName(inv);
      if (!$("led-party").value.trim() && party && party !== "-") { $("led-party").value = party; filled.push("收款方"); }
      if (!$("led-category").value && inv.category && [...$("led-category").options].some(o => o.value === inv.category)) { $("led-category").value = inv.category; filled.push("類別"); }
      const items = (inv.items || []).map(it => String(it.name || "").trim()).filter(Boolean);
      if (!$("led-content").value.trim() && items.length) { $("led-content").value = items.join("、"); filled.push("內容"); }
      if (!$("led-amount").value) { $("led-amount").value = inv.total; amountTouched = true; filled.push("金額"); }
      updateJudge();
      $("led-new-inv").value = "";
      const why = inv.payMethod === FIN_PAY_NONE ? "付款方式是不支出" : inv.payMethod === FIN_PAY_CASH ? "是現金付款" : `已經全部核對（${inv.expenseNo || "已付"}）`;
      return showMsg("led-msg", `發票「${inv.number}」${why}，不會連結；${filled.length ? `已帶入${filled.join("、")}` : "表單欄位都已經有資料，沒有帶入"}。`, false);
    }
    if (kind === "sales" && ids.some(id => db.finance.invoices.find(i => i.id === id)?.clientId !== pick.clientId)) return fail("一筆入帳只能核對同一個客戶的發票");
    ids.push(pick.id);
    $("led-new-inv").value = "";
    $("led-msg").classList.add("hidden");
    refreshNewInvs();
    $("led-new-inv").focus();
  };
  $("led-new-inv-add").onclick = addNewInv;
  $("led-new-inv").onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); addNewInv(); } };
  // 自動判定：手續費自動帶入，手動改過就不再覆蓋
  let feeTouched = false;
  const formJudge = () => finJudgeManual({ accountId: $("led-account").value, type: $("led-type").value, party: $("led-party").value.trim(), content: $("led-content").value.trim(), category: $("led-category").value });
  const updateJudge = () => {
    const j = formJudge();
    const hint = $("led-judge");
    const isTransfer = j.kind === "transfer";
    $("led-fee").disabled = isTransfer;
    if (isTransfer) $("led-fee").value = "";
    else if (!feeTouched) $("led-fee").value = j.fee || "";
    const text = isTransfer ? `判定為公司內部轉帳（${j.target.name}）：會記到「互匯未實際扣」，不收手續費。如果其實是繳貸款，請選項目類別。`
      : j.kind === "cross" ? `判定為跨行匯款：手續費 ${finMoney(j.fee)} 元，可以修改。`
      : j.kind === "same" ? "判定為同行匯款：沒有手續費。" : "";
    hint.textContent = text;
    hint.classList.toggle("hidden", !text);
  };
  $("led-fee").oninput = () => { feeTouched = true; };
  ["led-party", "led-content"].forEach(id => { $(id).oninput = updateJudge; });
  $("led-category").onchange = updateJudge;
  $("led-date").onchange = () => { finLedgerDraft.date = $("led-date").value; };
  $("led-account").onchange = () => { finLedgerDraft.accountId = $("led-account").value; updateJudge(); };
  if ((finLedgerDraft.invIds || []).length) refreshNewInvs();   // 重繪後把金額帶回來
  $("led-add-btn").onclick = () => {
    const accountId = $("led-account").value, date = $("led-date").value, type = $("led-type").value;
    const category = $("led-category").value.trim();
    const amount = finParseAmount($("led-amount").value, false);
    const fail = msg => showMsg("led-msg", msg, true);
    if (!accountId) return fail("請選擇帳戶");
    if (!date) return fail("請選擇日期");
    const judged = formJudge();
    const invRows = finNewEntryInvs();
    if (judged.kind === "transfer") {
      // 內部轉帳：兩邊帳戶各記一筆，都放在「互匯未實際扣」
      if (invRows.length) return fail("判定為公司內部轉帳，不能連結發票。請移除發票，或選擇項目類別。");
      if (amount === null) return fail("金額請輸入大於 0 的整數");
      const out = type === "expense";
      const from = out ? accountId : judged.target.id, to = out ? judged.target.id : accountId;
      const base = { date, amount, category: FIN_TRANSFER_CATEGORY, content: $("led-content").value.trim(), note: $("led-note").value.trim(), allocations: [], source: "manual", transferGroup: finId("tg"), noMatch: true };
      const seq = finNextSeq();
      db.finance.ledger.push({ ...base, id: finId("led"), seq, accountId: from, type: "expense", counterparty: `轉入 ${finAccountName(to)}` });
      db.finance.ledger.push({ ...base, id: finId("led"), seq: seq + 1, accountId: to, type: "income", counterparty: `轉自 ${finAccountName(from)}` });
      finLedgerDraft = { accountId, type, date };
      return finSave();
    }
    if (!category) return fail("請選擇類別");
    if (amount === null) return fail("金額請輸入大於 0 的整數");
    const fee = finParseFee($("led-fee").value);
    if (fee === null) return fail("手續費請輸入 0 或正整數");
    // 加入的發票依序分配金額（每張最多分到它的待對帳金額）
    const allocations = [];
    let left = amount;
    invRows.forEach(({ inv, remaining }) => { const a = Math.min(left, remaining); if (a > 0) { allocations.push({ invoiceId: inv.id, amount: a }); left -= a; } });
    const entry = { id: finId("led"), seq: finNextSeq(), accountId, date, type, category, amount, fee, counterparty: $("led-party").value.trim(), content: $("led-content").value.trim(), note: $("led-note").value.trim(), allocations, source: "manual" };
    if (type === "income" && invRows.length) entry.clientId = invRows[0].inv.clientId;
    db.finance.ledger.push(entry);
    finLedgerDraft = { accountId, type, date };
    finSave();
    if (allocations.length) finSyncCategories([entry], "link");
  };
  $("tr-add-btn").onclick = () => {
    const date = $("tr-date").value, from = $("tr-from").value, to = $("tr-to").value;
    const amount = finParseAmount($("tr-amount").value, false);
    const fail = msg => showMsg("tr-msg", msg, true);
    if (!date) return fail("請選擇日期");
    if (from === to) return fail("轉出和轉入不能是同一個帳戶");
    if (amount === null) return fail("金額請輸入大於 0 的整數");
    const group = finId("tg");
    const base = { date, amount, category: FIN_TRANSFER_CATEGORY, note: "", allocations: [], source: "manual", transferGroup: group, noMatch: true };
    const seq = finNextSeq();
    db.finance.ledger.push({ ...base, id: finId("led"), seq, accountId: from, type: "expense", counterparty: `轉入 ${finAccountName(to)}` });
    db.finance.ledger.push({ ...base, id: finId("led"), seq: seq + 1, accountId: to, type: "income", counterparty: `轉自 ${finAccountName(from)}` });
    finSave();
  };
  updateJudge();
  $("led-import-btn").onclick = () => finStartImport(finLedgerFilter.account || "");
  $("led-auto-btn").onclick = () => {
    const r = finAutoMatch();
    saveDB(db);
    alert(`自動配對完成：\n成功配對 ${r.matched} 筆\n有多張候選、需人工核對 ${r.ambiguous} 筆\n找不到金額相符的發票 ${r.none} 筆`);
    render();
    finSyncCategories(r.matchedEntries, "link");
  };

  // ---- 篩選 ----
  const bf = (id, key) => finBindFilter(id, finLedgerFilter, key, resetPage);
  bf("led-f-account", "account"); bf("led-f-type", "type"); bf("led-f-category", "category"); bf("led-f-recon", "recon"); bf("led-f-month", "month"); bf("led-f-q", "q");
  $("led-f-clear").onclick = () => { finLedgerFilter = { account: "", type: "", category: "", recon: "", month: "", q: "" }; finLedColFilter = finLedNewColFilter(); resetPage(); render(); };
  $("led-col-clear")?.addEventListener("click", () => { finLedColFilter = finLedNewColFilter(); resetPage(); render(); });
  bindColumnFilters();
  $("led-prev")?.addEventListener("click", () => { if (finLedgerPage > 0) { finLedgerPage--; render(); document.querySelector("main").scrollTop = 0; } });
  $("led-next")?.addEventListener("click", () => { finLedgerPage++; render(); document.querySelector("main").scrollTop = 0; });
  $("led-export-btn").onclick = () => {
    const ctx = finReconContext();
    const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
    const rows = [["匯款編號", "匯款日期", "帳戶", "項目類別", "收款方", "內容", "發票號碼", "銷項（支出）", "進項（收入）", "互匯未實際扣", "手續費", "備註", "銀行摘要", "對帳單餘額", "核對狀態", "拆分明細"]];
    finFilteredLedger(ctx).forEach(e => rows.push([e.no || "", e.date, finAccountName(e.accountId), e.category || "", e.counterparty || "", e.content || "", (e.allocations || []).map(a => `${invById[a.invoiceId]?.number || "?"}(${a.amount})`).join("、"), !finIsTransfer(e) && e.type === "expense" ? e.amount : "", !finIsTransfer(e) && e.type === "income" ? e.amount : "", finIsTransfer(e) ? (e.type === "income" ? e.amount : -e.amount) : "", e.fee || "", e.note || "", e.ref || "", e.balance ?? "", finReconStatus(e, ctx).label, (e.splits || []).map(x => `${x.name} ${x.category || e.category || ""} ${x.amount}`).join("；")]));
    finDownloadCSV("流水帳", rows);
  };

  // ---- 選取／批次 ----
  const refreshSel = () => {
    $("led-sel-count").textContent = finLedgerSel.size;
    document.querySelectorAll(".led-bulk").forEach(b => { b.disabled = finLedgerSel.size === 0; b.classList.toggle("opacity-50", finLedgerSel.size === 0); });
  };
  document.querySelectorAll(".led-sel").forEach(cb => {
    cb.onchange = () => { cb.checked ? finLedgerSel.add(cb.dataset.id) : finLedgerSel.delete(cb.dataset.id); refreshSel(); };
  });
  $("led-sel-all").onchange = () => {
    document.querySelectorAll(".led-sel").forEach(cb => { cb.checked = $("led-sel-all").checked; $("led-sel-all").checked ? finLedgerSel.add(cb.dataset.id) : finLedgerSel.delete(cb.dataset.id); });
    refreshSel();
  };
  const selected = () => db.finance.ledger.filter(e => finLedgerSel.has(e.id));
  $("led-bulk-cat-btn").onclick = () => {
    const cat = $("led-bulk-cat").value.trim();
    if (!cat) { alert("請先選擇要套用的類別"); return; }
    // 收入類別只套到收入流水、支出類別只套到支出流水，避免勾選混在一起時記錯
    const rows = selected().filter(e => !finIsTransfer(e));
    const es = rows.filter(e => finCategoryList(e.type).includes(cat));
    es.forEach(e => { e.category = cat; });
    saveDB(db); finLedgerSel.clear(); finRenderKeepScroll();
    if (es.length < rows.length) alert(`已套用 ${es.length} 筆。另有 ${rows.length - es.length} 筆的收支類型和「${cat}」不符，沒有變更。`);
    finSyncCategories(es, "ledger");
  };
  $("led-bulk-nomatch-btn").onclick = () => {
    selected().filter(e => !finIsTransfer(e)).forEach(e => { e.noMatch = true; e.allocations = []; delete e.loanId; });
    saveDB(db); finLedgerSel.clear(); finRenderKeepScroll();
  };
  $("led-bulk-unmatch-btn").onclick = () => {
    selected().filter(e => !finIsTransfer(e)).forEach(e => { e.allocations = []; delete e.loanId; delete e.noMatch; });
    saveDB(db); finLedgerSel.clear(); finRenderKeepScroll();
  };
  $("led-bulk-del-btn").onclick = () => {
    const ids = new Set(selected().map(e => e.id));
    selected().forEach(e => { if (e.transferGroup) db.finance.ledger.filter(x => x.transferGroup === e.transferGroup).forEach(x => ids.add(x.id)); });
    if (!ids.size) return;
    appConfirm(`確定要刪除這 ${ids.size} 筆流水嗎？（帳戶間轉帳會連同另一邊一起刪除）`, () => {
      db.finance.ledger = db.finance.ledger.filter(e => !ids.has(e.id));
      finLedgerSel.clear(); saveDB(db); finRenderKeepScroll();
    }, { okLabel: "刪除", danger: true });
  };
  $("led-bulk-clear-btn").onclick = () => { finLedgerSel.clear(); document.querySelectorAll(".led-sel, #led-sel-all").forEach(cb => { cb.checked = false; }); refreshSel(); };
  refreshSel();

  // ---- 單筆 ----
  document.querySelectorAll(".led-cat-input").forEach(inp => {
    inp.onchange = () => {
      const e = db.finance.ledger.find(x => x.id === inp.dataset.id);
      if (!e) return;
      e.category = inp.value.trim();
      saveDB(db);
      finRenderKeepScroll();
      finSyncCategories([e], "ledger");
    };
  });
  document.querySelectorAll(".led-recon-btn").forEach(b => { b.onclick = () => finOpenReconcile(b.dataset.id); });
  document.querySelectorAll(".led-inv-input").forEach(inp => {
    const entry = () => db.finance.ledger.find(x => x.id === inp.dataset.id);
    inp.onkeydown = ev => {
      if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      const e = entry();
      if (e) finLinkInvoiceByNumber(e, inp.value);
    };
    // 從提示清單點選時，不用再按 Enter
    inp.oninput = ev => {
      if (ev.inputType && ev.inputType !== "insertReplacementText") return;
      const e = entry();
      if (e && inp.value.trim()) finLinkInvoiceByNumber(e, inp.value);
    };
    // 沒有輸入就離開時收回成「＋ 新增發票號碼」（已有發票時）
    inp.onblur = () => {
      if (inp.value.trim() || !finLedgerInvAdding.has(inp.dataset.id)) return;
      setTimeout(() => { if (document.activeElement !== inp && !inp.value.trim() && !document.querySelector("[role=dialog]")) { finLedgerInvAdding.delete(inp.dataset.id); finRenderKeepScroll(); } }, 200);
    };
    if (finLedgerInvFocus === inp.dataset.id) inp.focus({ preventScroll: true });
  });
  finLedgerInvFocus = "";
  document.querySelectorAll(".led-inv-add").forEach(b => {
    b.onclick = () => { finLedgerInvAdding.add(b.dataset.id); finLedgerInvFocus = b.dataset.id; finRenderKeepScroll(); };
  });
  document.querySelectorAll(".led-inv-unlink").forEach(b => {
    b.onclick = () => {
      const e = db.finance.ledger.find(x => x.id === b.dataset.id);
      const inv = db.finance.invoices.find(x => x.id === b.dataset.inv);
      if (!e || !inv) return;
      appConfirm(`取消 ${e.no || "這筆流水"} 和發票 ${inv.number || ""}（${finPartyName(inv)}）的連結？`, () => {
        e.allocations = (e.allocations || []).filter(a => a.invoiceId !== inv.id);
        saveDB(db);
        finRenderKeepScroll();
      }, { okLabel: "取消連結" });
    };
  });
  document.querySelectorAll(".led-untransfer-btn").forEach(b => {
    b.onclick = () => {
      const e = db.finance.ledger.find(x => x.id === b.dataset.id);
      if (!e) return;
      delete e.transferGroup; delete e.autoTransfer; delete e.noMatch;
      e.category = "";
      saveDB(db); finRenderKeepScroll();
    };
  });
  document.querySelectorAll(".led-split-btn").forEach(b => { b.onclick = () => { finSplitDraft = null; navigateTo({ page: "fin-entry-split", finEntryId: b.dataset.id }); }; });
  // 拆分明細裡對應到的發票：到發票登錄（銷項到應收帳款）只列出那張發票並展開
  document.querySelectorAll(".sp-inv-link").forEach(b => { b.onclick = () => finShowInvoice(b.dataset.inv); });
  document.querySelectorAll(".led-split-toggle").forEach(b => {
    b.onclick = () => {
      const open = !finLedgerExpanded.has(b.dataset.id);
      if (open) finLedgerExpanded.add(b.dataset.id); else finLedgerExpanded.delete(b.dataset.id);
      b.closest("tr").nextElementSibling.classList.toggle("hidden", !open);
      b.querySelector(".led-split-chevron").textContent = open ? "▾" : "▸";
      b.setAttribute("aria-expanded", String(open));
    };
  });
  // 編輯：在清單那一列下方展開表單（再按一次收起）
  document.querySelectorAll(".led-edit-btn").forEach(b => { b.onclick = () => {
    finLedgerEditId = finLedgerEditId === b.dataset.id ? "" : b.dataset.id;
    render();
    if (finLedgerEditId) document.querySelector(`[data-row-id="${CSS.escape(finLedgerEditId)}"]`)?.scrollIntoView({ block: "start" });
  }; });
  const editing = db.finance.ledger.find(x => x.id === finLedgerEditId);
  if (editing && document.getElementById("ee-save-btn")) finBindEntryEdit(editing, () => { finLedgerEditId = ""; scrollToRowId = editing.id; render(); });
  finFitInlineEditBoxes();
  document.querySelectorAll(".led-del-btn").forEach(b => {
    b.onclick = () => {
      const e = db.finance.ledger.find(x => x.id === b.dataset.id);
      if (!e) return;
      const both = e.transferGroup ? "（帳戶間轉帳會連同另一邊一起刪除）" : "";
      appConfirm(`確定要刪除這筆${e.type === "income" ? "收入" : "支出"}（${e.category || "未分類"} ${finMoney(e.amount)}）嗎？${both}`, () => {
        db.finance.ledger = db.finance.ledger.filter(x => x.id !== e.id && !(e.transferGroup && x.transferGroup === e.transferGroup));
        finLedgerSel.delete(e.id);
        saveDB(db); finRenderKeepScroll();
      }, { okLabel: "刪除", danger: true });
    };
  });
}

// ============================================================
// 編輯流水
// ============================================================
function finRenderEntryEdit() {
  const e = db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e) return `<p class="text-slate-400">找不到這筆流水</p>`;
  return `<div class="bg-white rounded-xl shadow-sm p-6 max-w-3xl">${finEntryEditFormHtml(e)}</div>`;
}
// 編輯流水的表單：獨立頁面和流水帳清單裡展開編輯共用
function finEntryEditFormHtml(e) {
  const rs = finReconStatus(e, finReconContext());
  return `
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
      <div><label class="text-xs text-slate-500">日期</label><input id="ee-date" type="date" value="${finEsc(e.date)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div><label class="text-xs text-slate-500">帳戶</label><select id="ee-account" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${db.finance.accounts.map(a => `<option value="${finEsc(a.id)}" ${a.id === e.accountId ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select></div>
      <div><label class="text-xs text-slate-500">銷項／進項</label><select id="ee-type" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"><option value="expense" ${e.type === "expense" ? "selected" : ""}>銷項（支出）</option><option value="income" ${e.type === "income" ? "selected" : ""}>進項（收入）</option></select></div>
      <div><label class="text-xs text-slate-500">類別</label><select id="ee-category" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${finCategoryOptions(e.type, e.category)}</select></div>
      <div><label class="text-xs text-slate-500">金額</label><input id="ee-amount" type="number" min="0" step="1" value="${e.amount}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div><label class="text-xs text-slate-500">收款方</label><input id="ee-party" value="${finEsc(e.counterparty)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div class="md:col-span-2"><label class="text-xs text-slate-500">內容</label><input id="ee-content" value="${finEsc(e.content)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div><label class="text-xs text-slate-500">手續費</label><input id="ee-fee" type="number" min="0" step="1" value="${e.fee || ""}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
    </div>
    <div class="mb-3"><label class="text-xs text-slate-500">備註</label><input id="ee-note" value="${finEsc(e.note)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
    <div class="text-xs text-slate-500 mb-4 space-y-1">
      ${e.ref ? `<p>銀行摘要：${finEsc(e.ref)}</p>` : ""}
      <p>來源：${e.source === "import" ? "匯入對帳單" : "手動輸入"}　｜　核對狀態：${finReconBadge(rs)}${finEntryAllocated(e) ? `　已分配 ${finMoney(finEntryAllocated(e))}` : ""}</p>
    </div>
    <button id="ee-save-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">儲存</button>
    <button id="ee-cancel-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消</button>
    <p id="ee-msg" class="text-xs hidden mt-2"></p>
`;
}
// done：儲存或取消後要做的事（獨立頁面是回上一頁，清單裡展開的是收起來）
function finBindEntryEdit(entry, done) {
  const $ = id => document.getElementById(id);
  const e = entry || db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e) return;
  const finish = done || (() => { scrollToRowId = e.id; goBack(); });
  $("ee-type").onchange = () => { $("ee-category").innerHTML = finCategoryOptions($("ee-type").value, $("ee-category").value); };
  $("ee-cancel-btn").onclick = () => finish();
  $("ee-save-btn").onclick = () => {
    const fail = msg => showMsg("ee-msg", msg, true);
    const date = $("ee-date").value, type = $("ee-type").value, amount = finParseAmount($("ee-amount").value, false);
    if (!date) return fail("請選擇日期");
    if (amount === null) return fail("金額請輸入大於 0 的整數");
    const fee = finParseFee($("ee-fee").value);
    if (fee === null) return fail("手續費請輸入 0 或正整數");
    const hasLinks = (e.allocations || []).length || e.loanId;
    if (type !== e.type && hasLinks) return fail("這筆流水已經核對過發票／貸款，要改類型請先到「核對」取消核對");
    if (amount < finEntryAllocated(e)) return fail("金額小於已核對分配的總額，請先到「核對」調整分配");
    if (type === "income" && (e.splits || []).length) return fail("這筆流水已經拆分，要改成收入請先清除拆分明細");
    if (amount < finEntryAllocated(e) + finEntrySplitTotal(e)) return fail("金額小於已核對加已拆分的總額，請先調整核對或拆分");
    // 流水編號一旦編上就固定，換帳戶或換月份也不重編
    const categoryChanged = (e.category || "") !== $("ee-category").value.trim();
    Object.assign(e, { date, accountId: $("ee-account").value, type, category: $("ee-category").value.trim(), amount, fee, counterparty: $("ee-party").value.trim(), content: $("ee-content").value.trim(), note: $("ee-note").value.trim() });
    saveDB(db);
    finish();
    if (categoryChanged) finSyncCategories([e], "ledger");
  };
}

// ============================================================
// 拆分明細（整批支出，例如薪資：銀行只有一筆，實際是很多人）
// ============================================================
// 每一筆拆分的欄位跟進項發票一樣：一筆整批匯款裡可能包含很多張發票、不同廠商和員工。
// amount 是含稅總額（拆分合計、類別統計都用它）；net、tax 是未稅和稅額。
// name 是給搜尋和匯出用的顯示名稱（收款方 → 廠商 → 品項）。舊版只有 name，載入時當成收款方。
const FIN_SPLIT_TAXED = ["電子發票", "統一發票", "三聯式發票"];
function finSplitIsTaxed(voucherType) { return FIN_SPLIT_TAXED.includes(voucherType); }
function finSplitLabel(x) { return x.payee || x.vendor || x.item || x.name || ""; }
function finSplitToRow(x) {
  const legacy = x.payee === undefined && x.vendor === undefined && x.item === undefined;
  return {
    id: x.id, date: x.date || "", voucherType: x.voucherType || (legacy ? "其他" : FIN_VOUCHER_TYPES[0]), number: x.number || "",
    vendor: x.vendor || "", payee: legacy ? (x.name || "") : (x.payee || ""), category: x.category || "", project: x.project || "",
    item: x.item || "", net: x.net !== undefined ? String(x.net) : (legacy ? String(x.amount) : ""),
    tax: x.tax !== undefined ? String(x.tax) : (legacy ? "0" : ""), amount: String(x.amount ?? ""), note: x.note || "", taxTouched: true,
  };
}
function finSplitBlankRow(e, prev) {
  return { date: prev?.date || e.date || "", voucherType: prev?.voucherType || FIN_VOUCHER_TYPES[0], number: "", vendor: "", payee: "",
    category: prev?.category || e.category || "", project: prev?.project || "", item: "", net: "", tax: "", amount: "", note: "", taxTouched: false };
}
// 拆分明細的發票號碼：對應到發票登錄的用藍字（點了到發票登錄看那張發票），找不到的用灰字
function finSplitInvCell(x, r) {
  if (!r.number) return `<span class="text-slate-300">-</span>`;
  const inv = x.invoiceId && db.finance.invoices.find(i => i.id === x.invoiceId);
  if (inv) return `<button type="button" data-inv="${finEsc(inv.id)}" class="sp-inv-link text-blue-600 hover:underline" title="已自動對應發票登錄，點了查看這張發票">${finEsc(r.number)}</button>`;
  return `<span class="text-slate-500" title="發票登錄找不到這個號碼（或有多張同號碼），登錄後會自動對應">${finEsc(r.number)}</span>`;
}
function finSplitDetailHtml(e) {
  const rest = e.amount - finEntrySplitTotal(e) - finEntryAllocated(e);
  const cell = v => finEsc(v) || `<span class="text-slate-300">-</span>`;
  const money = v => v === undefined || v === "" ? `<span class="text-slate-300">-</span>` : finMoney(v);
  return `
    <div class="overflow-x-auto">
    <table class="w-full text-sm bg-white border rounded" style="min-width: 1100px">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr>
        <th class="px-3 py-2">序</th><th class="px-3 py-2 whitespace-nowrap">明細編號</th><th class="px-3 py-2">日期</th><th class="px-3 py-2 whitespace-nowrap">發票號碼</th>
        <th class="px-3 py-2">類別</th><th class="px-3 py-2">品項</th>
        <th class="px-3 py-2 text-right">未稅</th><th class="px-3 py-2 text-right">稅額</th><th class="px-3 py-2 text-right whitespace-nowrap">含稅總額</th>
        <th class="px-3 py-2 whitespace-nowrap">憑證類別</th><th class="px-3 py-2">廠商</th><th class="px-3 py-2">收款方</th><th class="px-3 py-2 whitespace-nowrap">專案/工程</th><th class="px-3 py-2">備註</th>
      </tr></thead>
      <tbody>${e.splits.map((x, i) => { const r = finSplitToRow(x); return `
        <tr class="border-t">
          <td class="px-3 py-2 text-right text-xs text-slate-400">${i + 1}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${finEsc(x.no) || (e.no ? `${finEsc(e.no)}-${i + 1}` : i + 1)}</td>
          <td class="px-3 py-2 text-slate-500 whitespace-nowrap">${cell(r.date)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${finSplitInvCell(x, r)}</td>
          <td class="px-3 py-2 whitespace-nowrap">${finEsc(r.category || e.category) || "未分類"}</td>
          <td class="px-3 py-2">${cell(r.item)}</td>
          <td class="px-3 py-2 text-right whitespace-nowrap">${money(x.net ?? x.amount)}</td>
          <td class="px-3 py-2 text-right whitespace-nowrap">${money(x.tax ?? 0)}</td>
          <td class="px-3 py-2 text-right font-semibold whitespace-nowrap">${finMoney(x.amount)}</td>
          <td class="px-3 py-2 whitespace-nowrap">${cell(r.voucherType)}</td>
          <td class="px-3 py-2">${cell(r.vendor)}</td>
          <td class="px-3 py-2">${cell(r.payee)}</td>
          <td class="px-3 py-2">${cell(r.project)}</td>
          <td class="px-3 py-2 text-slate-500">${cell(r.note)}</td>
        </tr>`; }).join("")}
      </tbody>
    </table>
    </div>
    ${rest > 0 ? `<p class="text-xs text-amber-600 mt-1 text-right">尚有 ${finMoney(rest)} 未拆分</p>` : ""}`;
}
function finSplitRow(r, idx) {
  const inp = (field, label, extra = "", cls = "") => `<label class="block"><span class="text-xs text-slate-500">${label}</span><input data-field="${field}" value="${finEsc(r[field])}" aria-label="第 ${idx + 1} 筆${label}" class="w-full border rounded px-2 py-1.5 text-sm mt-0.5 ${cls}" ${extra}/></label>`;
  const money = (field, label) => inp(field, label, `type="number" min="0" step="1"`, "text-right");
  const vouchers = FIN_VOUCHER_TYPES.includes(r.voucherType) || !r.voucherType ? FIN_VOUCHER_TYPES : [...FIN_VOUCHER_TYPES, r.voucherType];
  return `
  <div data-idx="${idx}" class="sp-row border rounded-lg p-3 mb-2 bg-white">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-semibold text-slate-500">第 ${idx + 1} 筆</span>
      <button type="button" class="sp-del text-slate-400 hover:text-rose-500 text-xs" aria-label="移除第 ${idx + 1} 筆">✕ 移除</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
      ${inp("date", "發票日期", `type="date"`)}
      ${inp("number", "發票/收據號碼", `list="sp-inv-list" autocomplete="off" placeholder="KEY 號碼帶入發票資料"`, "font-mono")}
      <label class="block"><span class="text-xs text-slate-500">類別</span><select data-field="category" aria-label="第 ${idx + 1} 筆類別" class="w-full border rounded px-2 py-1.5 text-sm mt-0.5">${finCategoryOptions("expense", r.category)}</select></label>
      <div class="col-span-2 md:col-span-1 lg:col-span-3">${inp("item", "品項", `placeholder="例：RFK-7997、差旅費"`)}</div>
      ${money("net", "未稅")}
      ${money("tax", "稅額")}
      ${money("amount", "含稅總額")}
      <label class="block"><span class="text-xs text-slate-500">憑證類別</span><select data-field="voucherType" aria-label="第 ${idx + 1} 筆憑證類別" class="w-full border rounded px-2 py-1.5 text-sm mt-0.5">${vouchers.map(v => `<option value="${finEsc(v)}" ${v === r.voucherType ? "selected" : ""}>${finEsc(v)}</option>`).join("")}</select></label>
      ${inp("vendor", "開立公司（廠商）", `list="sp-vendor-list" autocomplete="off" placeholder="選填"`)}
      ${inp("payee", "收款方（廠商／員工）", `list="sp-payee-list" autocomplete="off" placeholder="例：員工姓名"`)}
      <div class="col-span-2 lg:col-span-2">${inp("project", "專案/工程", `list="sp-project-list" autocomplete="off" placeholder="選填"`)}</div>
      <div class="col-span-2 md:col-span-2 lg:col-span-4">${inp("note", "備註", `placeholder="選填"`)}</div>
    </div>
  </div>`;
}
// Excel 複製出來的文字：Tab 分欄、換行分列；儲存格裡有換行時 Excel 會用雙引號包起來
function finParseTSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const s = String(text || "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (ch === "\t") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}
// 公司原本的帳戶紀錄（每列：匯款編號、日期、類別、收款方、品項、單號、發票號碼、金額）轉成拆分明細列
// 欄位不足 8 欄時，改用內容判斷：金額、類別、發票號碼、日期各自認得出來，其餘文字依序當品項和備註
function finParseSplitPaste(text, e) {
  const money = v => { const m = String(v).replace(/[$,\s元NT]/g, ""); return /^-?\d+(\.\d+)?$/.test(m) ? Math.round(Number(m)) : null; };
  const isInvNo = v => /^[A-Z]{2}-?\d{8}$/i.test(v);
  const isEntryNo = v => /^[A-Z]\d{4,}$/i.test(v);
  const year = e.year || (e.date || todayISO()).slice(0, 4);
  const toDate = v => {
    let m = String(v).match(/^(\d{1,2})月(\d{1,2})日$/);
    if (m) return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    m = String(v).match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
  };
  const cats = new Set([...FIN_EXPENSE_CATEGORIES, ...FIN_INCOME_CATEGORIES]);
  let entryNo = "", curNo = "", prevPayee = "", prevDate = e.date || "";
  const out = [];
  finParseTSV(text).forEach(c => {
    let no = "", date = "", category = "", payee = "", item = "", ref = "", voucher = "", amount = null;
    if (c.length >= 8) {
      [no, date, category, payee, item, ref, voucher] = c;
      amount = money(c[7]);
      date = toDate(date);
    } else {
      const rest = [];
      const amtIdx = c.map(money).reduce((last, x, i) => (x !== null ? i : last), -1);   // 最後一個是數字的欄位當金額
      c.forEach((v, i) => {
        if (!v) return;
        if (i === amtIdx) amount = money(v);
        else if (!no && i === 0 && isEntryNo(v)) no = v;
        else if (!date && toDate(v)) date = toDate(v);
        else if (!category && cats.has(v)) category = v;
        else if (!voucher && (isInvNo(v) || v === "收據")) voucher = v;
        else rest.push(v);
      });
      [item = "", ...ref] = rest;
      ref = ref.join(" ");
    }
    if (amount === null || amount <= 0) return;
    if (no && isEntryNo(no)) { curNo = no.toUpperCase(); if (!entryNo) entryNo = curNo; }   // 編號空白的列屬於上一個編號
    payee = payee || prevPayee; prevPayee = payee;
    date = date || prevDate; prevDate = date;
    const v = String(voucher || "").trim();
    let voucherType = "其他", number = "", vNote = "";
    if (isInvNo(v)) { voucherType = "電子發票"; number = v.toUpperCase(); }
    else if (v === "收據") voucherType = "收據";
    else if (v) vNote = `憑證：${v.split(/\n+/).map(x => x.trim()).filter(Boolean).join("、")}`;
    const taxed = finSplitIsTaxed(voucherType);
    const net = taxed ? Math.round(amount / (1 + FIN_TAX_RATE)) : amount;
    out.push({ date, voucherType, number, vendor: "", payee, category: cats.has(category) ? category : "", project: "",
      item: item + (category && !cats.has(category) ? `（${category}）` : ""), net: String(net), tax: String(amount - net), amount: String(amount),
      note: [ref, vNote].filter(Boolean).join(" "), taxTouched: false, entryNo: curNo, isFee: category === "手續費" });
  });
  return { rows: out, entryNo };
}
function finRenderEntrySplit() {
  const e = db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e) return `<p class="text-slate-400">找不到這筆流水</p>`;
  if (!finSplitDraft || finSplitDraft.entryId !== e.id) {
    const rows = (e.splits || []).map(finSplitToRow);
    finSplitDraft = { entryId: e.id, rows: rows.length ? rows : [finSplitBlankRow(e)] };
  }
  const allocated = finEntryAllocated(e);
  const uniq = list => [...new Set(list.filter(Boolean))];
  const allSplits = db.finance.ledger.flatMap(x => x.splits || []);
  const vendors = uniq(finVendorsSorted().map(v => v.name));
  const employees = db.hr && typeof hrActiveEmployees === "function" ? hrActiveEmployees().map(x => x.name) : [];
  const payees = uniq([...employees, ...allSplits.map(finSplitLabel), ...db.finance.invoices.map(i => i.payee), ...vendors]);
  const projects = uniq([...db.finance.invoices.map(i => i.project), ...allSplits.map(x => x.project)]);
  const opts = list => list.map(v => `<option value="${finEsc(v)}"></option>`).join("");
  return `
  <div class="bg-white rounded-xl shadow-sm p-5 mb-4">
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
      <div><p class="text-xs text-slate-500">編號</p><p class="font-medium font-mono">${finEsc(e.no) || "-"}</p></div>
      <div><p class="text-xs text-slate-500">日期</p><p class="font-medium">${finEsc(e.date)}</p></div>
      <div><p class="text-xs text-slate-500">帳戶</p><p class="font-medium">${finEsc(finAccountName(e.accountId))}</p></div>
      <div><p class="text-xs text-slate-500">類別</p><p class="font-medium">${finEsc(e.category) || "未分類"}</p></div>
      <div><p class="text-xs text-slate-500">支出金額</p><p class="text-lg font-bold text-rose-600">−${finMoney(e.amount)}</p></div>
    </div>
  </div>
  <div class="bg-white rounded-xl shadow-sm p-5">
    <p class="text-xs text-slate-500 mb-3">一筆整批匯款可以拆成多張發票、不同廠商或員工。填未稅會自動算 5% 稅額（收據、其他不算稅）；也可以直接填含稅總額。發票號碼 KEY 發票登錄裡有的號碼，會自動帶入發票日期、開立廠商和金額。</p>
    <datalist id="sp-vendor-list">${opts(vendors)}</datalist>
    <datalist id="sp-payee-list">${opts(payees)}</datalist>
    <datalist id="sp-project-list">${opts(projects)}</datalist>
    <datalist id="sp-inv-list">${db.finance.invoices.filter(i => i.kind === "purchase" && i.number).map(i => `<option value="${finEsc(i.number)}">${finEsc(i.vendor || finPartyName(i))} ${finEsc(i.date)} ${finMoney(i.total)}</option>`).join("")}</datalist>
    <div id="sp-rows" class="bg-slate-50 rounded-lg p-2">${finSplitDraft.rows.map(finSplitRow).join("")}</div>
    <button type="button" id="sp-add" class="text-sm text-blue-600 hover:underline mt-2">＋ 新增一筆</button>
    <details class="mt-3 border rounded-lg px-3 py-2 bg-slate-50">
      <summary class="text-sm text-slate-600 cursor-pointer">📋 從 Excel 貼上（公司原本的帳戶紀錄）</summary>
      <p class="text-xs text-slate-500 mt-2">在 Excel 選取那筆匯款的明細列（編號、日期、類別、收款方、品項、單號、發票號碼、金額）複製後貼在下面。收款方、日期空白的會沿用上一列；發票號碼像 EP-16249898 的會記成電子發票，「收據」記成收據，其他文字放到備註。</p>
      <textarea id="sp-paste" rows="5" class="w-full border rounded-lg px-3 py-2 text-xs font-mono mt-2" placeholder="在這裡貼上（Ctrl+V）"></textarea>
      <div class="flex items-center gap-3 mt-2">
        <button type="button" id="sp-paste-apply" class="border rounded-lg text-sm px-3 py-1.5 bg-white hover:bg-slate-100">轉成拆分明細</button>
        <span id="sp-paste-msg" class="text-xs" role="status"></span>
      </div>
    </details>
    <p class="text-sm mt-3">流水金額 <b>${finMoney(e.amount)}</b>${allocated ? `　｜　已核對發票 <b>${finMoney(allocated)}</b>` : ""}　｜　已拆分 <b id="sp-total">0</b>　｜　未拆分 <b id="sp-rest">0</b></p>
    <div class="mt-4">
      <button id="sp-save-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">儲存拆分</button>
      <button id="sp-cancel-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">返回</button>
      <p id="sp-msg" class="text-xs hidden mt-2"></p>
    </div>
  </div>`;
}
function finBindEntrySplit() {
  const $ = id => document.getElementById(id);
  const e = db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e || !finSplitDraft) return;
  const d = finSplitDraft;
  const box = $("sp-rows");
  const allocated = finEntryAllocated(e);
  const num = v => Number(v) || 0;
  const totals = () => {
    const sum = d.rows.reduce((s, r) => s + num(r.amount), 0);
    const rest = e.amount - allocated - sum;
    $("sp-total").textContent = finMoney(sum);
    $("sp-rest").textContent = finMoney(rest);
    $("sp-rest").className = rest < 0 ? "text-rose-600" : rest > 0 ? "text-amber-600" : "text-emerald-600";
  };
  // 未稅、稅額、含稅總額互相帶：填未稅 → 算稅額和總額；填總額 → 倒推未稅和稅額；改稅額 → 總額 = 未稅 + 稅額
  const recalc = (r, field) => {
    const taxed = finSplitIsTaxed(r.voucherType);
    if (field === "net" || field === "voucherType") {
      if (field === "voucherType") r.taxTouched = false;
      if (String(r.net).trim() === "" && field === "voucherType" && String(r.amount).trim() !== "") field = "amount";
      else {
        if (!r.taxTouched) r.tax = String(taxed ? Math.round(num(r.net) * FIN_TAX_RATE) : 0);
        r.amount = String(r.net).trim() === "" ? "" : String(num(r.net) + num(r.tax));
      }
    }
    if (field === "amount") {
      r.taxTouched = false;
      const total = num(r.amount);
      const net = taxed ? Math.round(total / (1 + FIN_TAX_RATE)) : total;
      r.net = String(r.amount).trim() === "" ? "" : String(net);
      r.tax = String(r.amount).trim() === "" ? "" : String(total - net);
    }
    if (field === "tax") {
      r.taxTouched = true;
      r.amount = String(num(r.net) + num(r.tax));
    }
  };
  const syncInputs = (rowEl, r) => ["net", "tax", "amount"].forEach(f => { const el = rowEl.querySelector(`[data-field="${f}"]`); if (el && el !== document.activeElement) el.value = r[f]; });
  const paint = () => { box.innerHTML = d.rows.map(finSplitRow).join(""); totals(); };
  const onField = ev => {
    const field = ev.target.dataset.field;
    if (!field) return;
    const rowEl = ev.target.closest(".sp-row");
    const r = d.rows[Number(rowEl.dataset.idx)];
    r[field] = ev.target.value;
    if (["net", "tax", "amount", "voucherType"].includes(field)) { recalc(r, field); syncInputs(rowEl, r); }
    totals();
  };
  box.oninput = onField;
  // KEY 發票號碼（打完離開欄位、按 Enter 或從清單選）：發票登錄有這張就帶入發票日期、號碼、開立廠商、金額、憑證類別和類別；
  // 品項空白時也帶入。收款方、專案、備註不動
  const fillFromInvoice = el => {
    const rowEl = el.closest(".sp-row");
    const r = d.rows[Number(rowEl.dataset.idx)];
    const key = finNormInvNo(el.value);
    if (!key) return;
    const inv = db.finance.invoices.find(i => i.kind === "purchase" && finNormInvNo(i.number) === key);
    if (!inv) return showMsg("sp-msg", `發票登錄找不到「${el.value.trim()}」，金額等資料請自己填`, true);
    const items = (inv.items || []).map(it => String(it.name || "").trim()).filter(Boolean).join("、");
    Object.assign(r, {
      number: inv.number, date: inv.date || r.date, vendor: inv.vendor || r.vendor,
      voucherType: inv.voucherType || r.voucherType, net: String(inv.amount), tax: String(inv.tax), amount: String(inv.total), taxTouched: true,
      category: inv.category || r.category || "", item: r.item || items,
    });
    const scrollTop = document.querySelector("main")?.scrollTop;
    paint();
    if (scrollTop != null) document.querySelector("main").scrollTop = scrollTop;
    const others = finInvoicePayments()[inv.id] || [];
    showMsg("sp-msg", `第 ${Number(rowEl.dataset.idx) + 1} 筆已帶入發票 ${inv.number}（${inv.vendor || finPartyName(inv)}，${inv.date}，${finMoney(inv.total)}）${others.length ? `。注意：這張發票已經連結 ${others.map(p => p.no).filter(Boolean).join("、")}` : ""}`, !!others.length);
  };
  box.onchange = ev => {
    if (ev.target.tagName === "SELECT") onField(ev);
    else if (ev.target.dataset.field === "number") fillFromInvoice(ev.target);
  };
  box.addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target.dataset.field === "number") { ev.preventDefault(); ev.target.blur(); } });
  box.onclick = ev => {
    if (!ev.target.closest(".sp-del")) return;
    d.rows.splice(Number(ev.target.closest(".sp-row").dataset.idx), 1);
    if (!d.rows.length) d.rows.push(finSplitBlankRow(e));
    paint();
  };
  $("sp-add").onclick = () => {
    d.rows.push(finSplitBlankRow(e, d.rows[d.rows.length - 1]));
    paint();
    box.querySelector(".sp-row:last-child [data-field='payee']").focus();
  };
  // 從 Excel 貼上：一列變一筆拆分，加在現有明細後面（原本空白的列會被取代），確認後再按「儲存拆分」
  $("sp-paste-apply").onclick = () => {
    const msg = $("sp-paste-msg");
    const { rows, entryNo } = finParseSplitPaste($("sp-paste").value, e);
    if (!rows.length) { msg.className = "text-xs text-rose-600"; msg.textContent = "沒有讀到含金額的明細列，請確認複製的範圍"; return; }
    const blank = r => !["number", "vendor", "payee", "item", "net", "amount", "note"].some(k => String(r[k] ?? "").trim());
    d.rows = [...d.rows.filter(r => !blank(r)), ...rows];
    paint();
    const sum = rows.reduce((s, r) => s + num(r.amount), 0);
    const warn = entryNo && e.no && entryNo !== e.no ? `注意：貼上的編號是 ${entryNo}，這筆流水是 ${e.no}。` : "";
    msg.className = `text-xs ${warn ? "text-amber-600" : "text-emerald-700"}`;
    msg.textContent = `${warn}已加入 ${rows.length} 筆，合計 ${finMoney(sum)}。請檢查後按「儲存拆分」。`;
    $("sp-paste").value = "";
  };
  $("sp-cancel-btn").onclick = () => { finSplitDraft = null; goBack(); };
  $("sp-save-btn").onclick = () => {
    const fail = msg => showMsg("sp-msg", msg, true);
    const splits = [];
    const vendorsToRemember = [];
    for (let n = 0; n < d.rows.length; n++) {
      const r = d.rows[n];
      const t = k => String(r[k] ?? "").trim();
      const hasText = ["number", "vendor", "payee", "item", "net", "amount", "note"].some(k => t(k));
      if (!hasText) continue;   // 整筆空白的略過
      if (!t("vendor") && !t("payee") && !t("item")) return fail(`第 ${n + 1} 筆請至少填廠商、收款方或品項其中一項`);
      const amount = finParseAmount(r.amount, false);
      if (amount === null) return fail(`第 ${n + 1} 筆的含稅總額請輸入大於 0 的整數`);
      const net = t("net") === "" ? amount : finParseAmount(r.net, true);
      const tax = t("tax") === "" ? amount - (net ?? amount) : finParseAmount(r.tax, true);
      if (net === null || tax === null) return fail(`第 ${n + 1} 筆的未稅或稅額請輸入整數`);
      if (net + tax !== amount) return fail(`第 ${n + 1} 筆：未稅 ${finMoney(net)} ＋ 稅額 ${finMoney(tax)} 不等於含稅總額 ${finMoney(amount)}`);
      const vendor = t("vendor") ? finCanonicalVendor(t("vendor")) : "";
      if (vendor) vendorsToRemember.push(vendor);
      const x = { id: r.id || finId("spl"), date: t("date"), voucherType: r.voucherType || FIN_VOUCHER_TYPES[0], number: t("number"), vendor, payee: t("payee"),
        category: t("category"), project: t("project"), item: t("item"), net, tax, amount, note: t("note") };
      // 明細編號和對應的發票沿用原本那筆（發票號碼改了，存檔時 data.js 會重新對應）
      const old = (e.splits || []).find(o => o.id && o.id === r.id);
      if (old?.no) x.no = old.no;
      if (old?.invoiceId) x.invoiceId = old.invoiceId;
      x.name = finSplitLabel(x);
      splits.push(x);
    }
    const sum = splits.reduce((s, x) => s + x.amount, 0);
    if (sum + allocated > e.amount) return fail(`拆分合計 ${finMoney(sum)}${allocated ? ` 加上已核對發票 ${finMoney(allocated)}` : ""} 超過這筆流水的金額 ${finMoney(e.amount)}`);
    if (splits.length) { e.splits = splits; finLedgerExpanded.add(e.id); } else delete e.splits;
    vendorsToRemember.forEach(finRememberVendor);
    saveDB(db);
    finSplitDraft = null;
    scrollToRowId = e.id; goBack();
  };
  totals();
}

// ============================================================
// 核對（流水 ↔ 發票／貸款）
// ============================================================
function finInitReconDraft(e) {
  const auto = finEntryLoan(e, finReconContext());
  finReconDraft = {
    entryId: e.id,
    mode: e.noMatch ? "none" : (e.loanId || (!(e.allocations || []).length && auto)) ? "loan" : "invoice",
    alloc: Object.fromEntries((e.allocations || []).map(a => [a.invoiceId, String(a.amount)])),
    party: e.type === "income" ? (e.clientId || finGuessClient(e)) : "",
    showSettled: false,
    q: "",
    loanId: e.loanId || auto?.id || "",
  };
}
function finReconCandidates(e, d) {
  const isIncome = e.type === "income";
  const st = finSettlement();
  const own = Object.fromEntries((e.allocations || []).map(a => [a.invoiceId, a.amount]));
  let cands = db.finance.invoices.filter(i => i.kind === (isIncome ? "sales" : "purchase") && ((i.payMethod !== FIN_PAY_NONE && i.payMethod !== FIN_PAY_CASH) || own[i.id] !== undefined)).map(inv => {
    // 用「已連結流水」的金額算，手動標成轉帳（已付）但還沒對帳的發票仍可連結
    const otherPaid = st[inv.id].ledgerPaid - (own[inv.id] || 0);
    return { inv, otherPaid, remaining: Math.max(0, inv.total - otherPaid) };
  });
  if (d.party) cands = cands.filter(c => isIncome ? c.inv.clientId === d.party : c.inv.vendor === d.party);
  cands = cands.filter(c => d.showSettled || c.remaining > 0 || d.alloc[c.inv.id] !== undefined);
  cands.sort((a, b) => (b.remaining === e.amount) - (a.remaining === e.amount) || a.inv.date.localeCompare(b.inv.date));
  return cands;
}

function finRenderReconcile() {
  const e = db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e) return `<p class="text-slate-400">找不到這筆流水</p>`;
  if (!finReconDraft || finReconDraft.entryId !== e.id) finInitReconDraft(e);
  const d = finReconDraft;
  const isIncome = e.type === "income";
  const cands = finReconCandidates(e, d);
  const parties = isIncome
    ? finClients().map(c => ({ v: c.id, t: c.name }))
    : [...new Set(db.finance.invoices.filter(i => i.kind === "purchase" && i.vendor).map(i => i.vendor))].map(v => ({ v, t: v }));
  const allocated = Object.values(d.alloc).reduce((s, v) => s + (Number(v) || 0), 0);
  const splitTotal = finEntrySplitTotal(e);
  const unallocated = e.amount - splitTotal - allocated;
  const loans = db.finance.loans.slice().sort((a, b) => (b.accountId === e.accountId) - (a.accountId === e.accountId));
  const loan = db.finance.loans.find(l => l.id === d.loanId);
  const rs = finReconStatus(e, finReconContext());

  return `
  <div class="bg-white rounded-xl shadow-sm p-5 mb-4">
    <div class="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
      <div><p class="text-xs text-slate-500">編號</p><p class="font-medium font-mono">${finEsc(e.no) || "-"}</p></div>
      <div><p class="text-xs text-slate-500">日期</p><p class="font-medium">${finEsc(e.date)}</p></div>
      <div><p class="text-xs text-slate-500">帳戶</p><p class="font-medium">${finEsc(finAccountName(e.accountId))}</p></div>
      <div><p class="text-xs text-slate-500">類別</p><p class="font-medium">${finEsc(e.category) || "未分類"}</p></div>
      <div><p class="text-xs text-slate-500">收款方／內容</p><p class="font-medium">${finEsc(e.counterparty || e.content || e.ref) || "-"}</p></div>
      <div><p class="text-xs text-slate-500">${isIncome ? "入帳金額" : "支出金額"}</p><p class="text-lg font-bold ${isIncome ? "text-emerald-600" : "text-rose-600"}">${isIncome ? "+" : "−"}${finMoney(e.amount)}</p></div>
    </div>
    <p class="text-xs text-slate-500 mt-3">目前狀態：${finReconBadge(rs)}${e.ref && e.ref !== e.counterparty ? `　銀行摘要：${finEsc(e.ref)}` : ""}${e.note ? `　備註：${finEsc(e.note)}` : ""}</p>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-5 mb-4">
    <div class="flex flex-wrap gap-5 text-sm mb-3">
      <label class="flex items-center gap-1.5"><input type="radio" name="recon-mode" value="invoice" ${d.mode === "invoice" ? "checked" : ""}/> 對應${isIncome ? "銷項" : "進項"}發票</label>
      ${isIncome ? "" : `<label class="flex items-center gap-1.5"><input type="radio" name="recon-mode" value="loan" ${d.mode === "loan" ? "checked" : ""}/> 貸款扣款</label>`}
      <label class="flex items-center gap-1.5"><input type="radio" name="recon-mode" value="none" ${d.mode === "none" ? "checked" : ""}/> 不需核對</label>
    </div>

    ${d.mode === "invoice" ? `
      <div class="flex flex-wrap items-end gap-3 mb-3">
        <div class="flex-1" style="min-width: 16rem">
          <label for="rc-q" class="text-xs text-slate-500">搜尋發票</label>
          <input id="rc-q" value="${finEsc(d.q)}" autocomplete="off" class="block w-full border rounded-lg px-3 py-1.5 text-sm mt-1" placeholder="發票號碼、廠商、品項、金額…"/>
        </div>
        <div>
          <label class="text-xs text-slate-500">${isIncome ? "客戶" : "廠商"}</label>
          <select id="rc-party" class="block border rounded-lg px-3 py-1.5 text-sm mt-1"><option value="">全部</option>${parties.map(p => `<option value="${finEsc(p.v)}" ${p.v === d.party ? "selected" : ""}>${finEsc(p.t)}</option>`).join("")}</select>
        </div>
        <label class="flex items-center gap-1.5 text-sm text-slate-600 pb-1.5"><input id="rc-settled" type="checkbox" ${d.showSettled ? "checked" : ""}/> 也顯示已結清的發票</label>
      </div>
      <div class="overflow-x-auto border rounded-lg">
        <table class="w-full text-sm">
          <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="px-3 py-2"></th><th class="px-3 py-2">日期</th><th class="px-3 py-2">發票號碼</th><th class="px-3 py-2">${isIncome ? "客戶" : "廠商"}</th><th class="px-3 py-2 text-right">含稅總額</th><th class="px-3 py-2 text-right">其他流水已核對</th><th class="px-3 py-2 text-right">尚未核對</th><th class="px-3 py-2 text-right">本次分配</th></tr></thead>
          <tbody>
            ${cands.map(c => { const on = d.alloc[c.inv.id] !== undefined; return `
              <tr class="rc-row border-t ${on ? "bg-sky-50" : ""}" data-hay="${finEsc(`${finInvoiceSearchText(c.inv)} ${c.inv.total}`.toLowerCase())}">
                <td class="px-3 py-2"><input type="checkbox" class="rc-check" data-id="${finEsc(c.inv.id)}" ${on ? "checked" : ""}/></td>
                <td class="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">${finEsc(c.inv.date)}</td>
                <td class="px-3 py-2 font-mono text-xs">${finEsc(c.inv.number) || "（未填號碼）"}${c.remaining === e.amount ? ` <span class="ml-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-sans">金額相符</span>` : ""}</td>
                <td class="px-3 py-2">${finEsc(finPartyName(c.inv))}</td>
                <td class="px-3 py-2 text-right">${finMoney(c.inv.total)}</td>
                <td class="px-3 py-2 text-right text-slate-500">${finMoney(c.otherPaid)}</td>
                <td class="px-3 py-2 text-right font-semibold ${c.remaining > 0 ? "text-rose-600" : "text-slate-400"}">${finMoney(c.remaining)}</td>
                <td class="px-3 py-2 text-right"><input class="rc-amount border rounded-lg px-2 py-1 text-sm w-28 text-right" data-id="${finEsc(c.inv.id)}" type="number" min="0" step="1" value="${on ? finEsc(d.alloc[c.inv.id]) : ""}" ${on ? "" : "disabled"}/></td>
              </tr>`; }).join("") || `<tr><td colspan="8" class="px-4 py-6 text-center text-slate-400">沒有可核對的${isIncome ? "銷項" : "進項"}發票${d.party ? "（可把上面的篩選改成「全部」）" : ""}</td></tr>`}
          </tbody>
        </table>
      </div>
      <p id="rc-nomatch" class="hidden text-sm text-slate-400 text-center py-4">沒有符合關鍵字的發票</p>
      <p class="text-sm mt-3">流水金額 <b>${finMoney(e.amount)}</b>${splitTotal ? `　｜　已拆分 <b>${finMoney(splitTotal)}</b>` : ""}　｜　已分配 <b id="rc-allocated">${finMoney(allocated)}</b>　｜　未分配 <b id="rc-diff" class="${unallocated < 0 ? "text-rose-600" : unallocated > 0 ? "text-amber-600" : "text-emerald-600"}">${finMoney(unallocated)}</b></p>
    ` : ""}

    ${d.mode === "loan" ? `
      <div class="max-w-xl">
        <label class="text-xs text-slate-500">這筆是哪一筆貸款的扣款？</label>
        <select id="rc-loan" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          <option value="">請選擇貸款</option>
          ${loans.map(l => `<option value="${finEsc(l.id)}" ${l.id === d.loanId ? "selected" : ""}>${finEsc(l.name)}（每月 ${finMoney(l.monthlyAmount)}，${finEsc(finAccountName(l.accountId))}）</option>`).join("")}
        </select>
        ${loan ? `<p class="text-xs text-slate-500 mt-2">每月應扣 ${finMoney(loan.monthlyAmount)}${Number(loan.monthlyAmount) === e.amount ? `，<span class="text-emerald-600">和這筆金額相符</span>` : `，<span class="text-rose-600">和這筆金額 ${finMoney(e.amount)} 不同</span>`}</p>` : ""}
        ${db.finance.loans.length ? "" : `<p class="text-xs text-amber-600 mt-2">還沒有建立貸款，請先到「貸款管理」新增。</p>`}
      </div>
    ` : ""}

    ${d.mode === "none" ? `<p class="text-sm text-slate-500">這筆不需要對應發票或貸款（例如房租、薪資、手續費…），會從「未核對」清單排除。</p>` : ""}

    <div class="mt-4">
      <button id="rc-save-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">儲存核對</button>
      <button id="rc-clear-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消核對（清除所有連結）</button>
      <button id="rc-cancel-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">返回</button>
      <p id="rc-msg" class="text-xs hidden mt-2"></p>
    </div>
  </div>`;
}

function finBindReconcile() {
  const $ = id => document.getElementById(id);
  const e = db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e || !finReconDraft) return;
  const d = finReconDraft;

  document.querySelectorAll('input[name="recon-mode"]').forEach(r => { r.onchange = () => { d.mode = r.value; finRenderKeepScroll(); }; });
  $("rc-party")?.addEventListener("change", () => { d.party = $("rc-party").value; finRenderKeepScroll(); });
  $("rc-settled")?.addEventListener("change", () => { d.showSettled = $("rc-settled").checked; finRenderKeepScroll(); });
  $("rc-loan")?.addEventListener("change", () => { d.loanId = $("rc-loan").value; finRenderKeepScroll(); });

  // 關鍵字只隱藏列、不重畫，游標才不會跳走；已勾選的發票一律留著
  const applySearch = () => {
    const input = $("rc-q");
    if (!input) return;
    const q = input.value.trim().toLowerCase();
    let visible = 0;
    const rows = document.querySelectorAll(".rc-row");
    rows.forEach(tr => {
      const show = !q || tr.dataset.hay.includes(q) || tr.querySelector(".rc-check").checked;
      tr.classList.toggle("hidden", !show);
      if (show) visible++;
    });
    $("rc-nomatch").classList.toggle("hidden", !(rows.length && !visible));
  };
  if ($("rc-q")) {
    $("rc-q").oninput = () => { d.q = $("rc-q").value; applySearch(); };
    // 按 Enter：只剩一張符合時直接勾選
    $("rc-q").onkeydown = ev => {
      if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      const visible = [...document.querySelectorAll(".rc-row")].filter(tr => !tr.classList.contains("hidden") && !tr.querySelector(".rc-check").checked);
      if (visible.length === 1) visible[0].querySelector(".rc-check").click();
    };
    applySearch();
  }

  const updateTotals = () => {
    const sum = Object.values(d.alloc).reduce((s, v) => s + (Number(v) || 0), 0);
    $("rc-allocated").textContent = finMoney(sum);
    const diff = e.amount - finEntrySplitTotal(e) - sum;
    const el = $("rc-diff");
    el.textContent = finMoney(diff);
    el.className = diff < 0 ? "text-rose-600" : diff > 0 ? "text-amber-600" : "text-emerald-600";
  };
  document.querySelectorAll(".rc-check").forEach(cb => {
    cb.onchange = () => {
      const id = cb.dataset.id;
      if (cb.checked) {
        const cand = finReconCandidates(e, d).find(c => c.inv.id === id);
        const used = Object.values(d.alloc).reduce((s, v) => s + (Number(v) || 0), 0);
        const def = Math.max(0, Math.min(cand ? cand.remaining : 0, e.amount - finEntrySplitTotal(e) - used));
        d.alloc[id] = def > 0 ? String(def) : "";
      } else delete d.alloc[id];
      finRenderKeepScroll();
    };
  });
  document.querySelectorAll(".rc-amount").forEach(inp => {
    inp.oninput = () => { d.alloc[inp.dataset.id] = inp.value; updateTotals(); };
  });

  $("rc-cancel-btn").onclick = goBack;
  $("rc-clear-btn").onclick = () => {
    e.allocations = []; delete e.loanId; delete e.noMatch;
    saveDB(db); finReconDraft = null; scrollToRowId = e.id; goBack();
  };
  $("rc-save-btn").onclick = () => {
    const fail = msg => showMsg("rc-msg", msg, true);
    if (d.mode === "none") {
      e.noMatch = true; e.allocations = []; delete e.loanId;
    } else if (d.mode === "loan") {
      const loan = db.finance.loans.find(l => l.id === d.loanId);
      if (!loan) return fail("請選擇貸款");
      e.loanId = loan.id; e.allocations = []; delete e.noMatch;
      if (!e.category) e.category = loan.category || loan.name;
    } else {
      const cands = finReconCandidates(e, { ...d, party: "", showSettled: true });
      const allocations = [];
      for (const [invoiceId, raw] of Object.entries(d.alloc)) {
        const c = cands.find(x => x.inv.id === invoiceId);
        const amt = finParseAmount(raw, false);
        if (!c) return fail("有發票已不存在，請重新整理後再試");
        if (amt === null) return fail(`發票 ${c.inv.number || "（未填號碼）"} 的分配金額請輸入大於 0 的整數`);
        if (amt > c.remaining) return fail(`發票 ${c.inv.number || "（未填號碼）"} 只剩 ${finMoney(c.remaining)} 未核對，分配金額不能更多`);
        // 系統自動核對上的發票，金額沒改就保留「自動」標記（藍字）
        const prev = (e.allocations || []).find(a => a.invoiceId === invoiceId);
        allocations.push(prev?.auto && prev.amount === amt ? { invoiceId, amount: amt, auto: true } : { invoiceId, amount: amt });
      }
      const sum = allocations.reduce((s, a) => s + a.amount, 0);
      if (sum + finEntrySplitTotal(e) > e.amount) return fail(`分配合計 ${finMoney(sum)}${finEntrySplitTotal(e) ? ` 加上已拆分 ${finMoney(finEntrySplitTotal(e))}` : ""} 超過這筆流水的金額 ${finMoney(e.amount)}`);
      if (e.type === "income") {
        const clients = [...new Set(allocations.map(a => db.finance.invoices.find(i => i.id === a.invoiceId)?.clientId))];
        if (clients.length > 1) return fail("一筆入帳只能核對同一個客戶的發票");
        if (clients[0]) e.clientId = clients[0];
      }
      // 付不足額的發票先確認（可能是先付訂金），確認後付款方式會記為部分總額
      const shortOnes = allocations.map(a => ({ a, c: cands.find(x => x.inv.id === a.invoiceId) })).filter(({ a, c }) => a.amount < c.remaining);
      const apply = () => {
        e.allocations = allocations; delete e.loanId; delete e.noMatch;
        saveDB(db);
        finReconDraft = null;
        scrollToRowId = e.id; goBack();
        finSyncCategories([e], "link");
      };
      if (shortOnes.length) {
        const lines = shortOnes.map(({ a, c }) => `發票 ${c.inv.number || "（未填號碼）"}：本次 ${finMoney(a.amount)}，尚未付 ${finMoney(c.remaining)}，差額 ${finMoney(c.remaining - a.amount)}`).join("\n");
        appConfirm(`金額有出入，請確認：\n${lines}\n\n如果是先付訂金，連結後付款方式會記為「${FIN_PAY_PARTIAL}」。`, apply, { okLabel: `記為${FIN_PAY_PARTIAL}` });
      } else apply();
      return;
    }
    saveDB(db);
    finReconDraft = null;
    scrollToRowId = e.id; goBack();
  };
}

// ============================================================
// 匯入銀行對帳單（CSV／Excel）
// ============================================================
const FIN_IMPORT_FIELDS = [
  { key: "date", label: "交易日期", required: true, kw: ["交易日", "日期", "date", "帳務日", "記帳日"] },
  { key: "desc", label: "摘要／說明", kw: ["摘要", "交易說明", "說明", "description", "用途", "交易內容"] },
  { key: "debit", label: "支出（提款）", kw: ["支出", "提款", "借方", "debit", "withdraw", "扣款", "支付"] },
  { key: "credit", label: "存入", kw: ["存入", "存款", "貸方", "credit", "deposit", "入帳"] },
  { key: "amount", label: "金額（單欄，正入負出）", kw: ["金額", "amount"] },
  { key: "balance", label: "餘額", kw: ["餘額", "balance"] },
  { key: "counterparty", label: "對方戶名／對象", kw: ["對方", "戶名", "往來", "對象", "payee", "counterparty", "交易對象"] },
  { key: "note", label: "附註／備註（併入摘要）", kw: ["備註", "附註", "memo", "remark"] },
];
const FIN_HEADER_WORDS = ["日期", "交易日", "date", "摘要", "說明", "餘額", "balance", "支出", "存入", "提款", "存款", "借方", "貸方", "金額", "amount", "debit", "credit"];

function finStartImport(accountId) {
  finImportState = { accountId: accountId || (db.finance.accounts.find(a => a.type === "bank") || db.finance.accounts[0])?.id || "", fileName: "", rows: [], headerRow: 0, map: {}, invert: false, include: {}, error: "", loading: false };
  navigateTo({ page: "fin-import" });
}

function finDecodeBuffer(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder("big5").decode(buf); }   // 台灣銀行匯出的 CSV 常是 Big5
}
function finParseCSVText(text) {
  text = text.replace(/^﻿/, "");
  const sample = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 10);
  const delim = [",", "\t", ";", "|"].map(dl => [dl, Math.max(0, ...sample.map(l => l.split(dl).length))]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}
let finSheetJSPromise = null;
function finLoadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!finSheetJSPromise) {
    finSheetJSPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => { finSheetJSPromise = null; reject(new Error("無法載入 Excel 解析元件")); };
      document.head.appendChild(s);
    });
  }
  return finSheetJSPromise;
}
async function finReadImportFile(file) {
  const buf = await file.arrayBuffer();
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await finLoadSheetJS();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }).filter(r => r.some(c => String(c).trim() !== ""));
  }
  return finParseCSVText(finDecodeBuffer(buf));
}

function finGuessHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const hits = rows[i].filter(c => { const t = String(c).trim().toLowerCase(); return t && FIN_HEADER_WORDS.some(w => t.includes(w)); }).length;
    if (hits >= 2) return i;
  }
  return 0;
}
// 欄位對應：先用這個帳戶上次存的標題名稱，找不到再用關鍵字猜
function finGuessMapping(headers, saved) {
  const map = {}, used = new Set();
  // 上次存的設定裡每個欄位的標題，這個檔案都找得到，才算同一種格式、照上次的；否則（換了銀行或格式）用關鍵字猜
  const savedFields = saved ? FIN_IMPORT_FIELDS.filter(f => saved[f.key]) : [];
  const sameFormat = savedFields.length >= 2 && savedFields.every(f => headers.includes(saved[f.key]));
  FIN_IMPORT_FIELDS.forEach(f => {
    let idx = -1;
    if (sameFormat) idx = saved[f.key] ? headers.findIndex((h, i) => !used.has(i) && h === saved[f.key]) : -1;
    else idx = headers.findIndex((h, i) => !used.has(i) && f.kw.some(k => h.toLowerCase().includes(k)));
    if (idx >= 0) { map[f.key] = idx; used.add(idx); }
  });
  if (map.debit !== undefined || map.credit !== undefined) delete map.amount;
  return map;
}
function finParseDateCell(v) {
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  let y, m, d, mt;
  if ((mt = s.match(/^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{2,3})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/))) { y = +mt[1] + 1911; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{3})(\d{2})(\d{2})$/))) { y = +mt[1] + 1911; m = +mt[2]; d = +mt[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function finParseAmountCell(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v ?? "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[,，\s$＄]|NT|TWD/gi, "").replace(/[−–—]/g, "-");
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -Math.abs(n) : n;
}
function finNormRef(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

function finImportParse(st) {
  const rows = st.rows.slice(st.headerRow + 1);
  const m = st.map;
  const get = (r, key) => (m[key] === undefined || m[key] < 0 ? "" : r[m[key]] ?? "");
  const parsed = [];
  rows.forEach((r, i) => {
    if (!r.some(c => String(c).trim() !== "")) return;
    const date = finParseDateCell(get(r, "date"));
    let type = null, amount = 0, reason = "";
    if (m.debit !== undefined || m.credit !== undefined) {
      const dv = Math.abs(finParseAmountCell(get(r, "debit")) || 0), cv = Math.abs(finParseAmountCell(get(r, "credit")) || 0);
      if (dv > 0 && cv > 0) reason = "同時有存入與支出";
      else if (cv > 0) { type = "income"; amount = cv; } else if (dv > 0) { type = "expense"; amount = dv; }
    } else if (m.amount !== undefined) {
      let v = finParseAmountCell(get(r, "amount"));
      if (v !== null && st.invert) v = -v;
      if (v > 0) { type = "income"; amount = v; } else if (v < 0) { type = "expense"; amount = -v; }
    }
    if (!date && !type) return;                    // 空白、小計、說明文字等雜列直接略過
    if (!date) reason = reason || "日期無法辨識";
    else if (!type && !reason) reason = "沒有金額";
    const bal = finParseAmountCell(get(r, "balance"));
    // 銀行的「附註」常放對方帳號／戶名，摘要又很籠統（例如都是「行動自轉」），所以併入摘要，
    // 這樣「依過去相同摘要帶入類別」和重複偵測才分得出是跟誰的往來；備註欄留給自己寫
    const ref = finNormRef([get(r, "desc"), get(r, "note")].filter(v => String(v).trim()).join(" "));
    parsed.push({ idx: i, date, type, amount: Math.round(amount), ref, counterparty: finNormRef(get(r, "counterparty")), note: "", balance: bal === null ? null : Math.round(bal), reason });
  });
  // 重複偵測：同帳戶、同日期、同金額、同摘要；允許正當的重複（第 n 筆才算重複，要現有筆數 ≥ n）
  const existing = {};
  // 對帳單金額含手續費，所以用「金額＋手續費」比對，已拆過手續費的流水才認得出來
  db.finance.ledger.filter(e => e.accountId === st.accountId).forEach(e => { const k = `${e.date}|${e.type}|${e.amount + (e.fee || 0)}|${finNormRef(e.ref)}`; existing[k] = (existing[k] || 0) + 1; });
  const seen = {};
  // 依過去相同摘要自動帶入類別
  const catByRef = {};
  db.finance.ledger.forEach(e => { if (e.ref && e.category) { const k = `${e.type}|${finNormRef(e.ref)}`; (catByRef[k] = catByRef[k] || {})[e.category] = (catByRef[k][e.category] || 0) + 1; } });
  parsed.forEach(p => {
    if (p.reason) return;
    const k = `${p.date}|${p.type}|${p.amount}|${p.ref}`;
    seen[k] = (seen[k] || 0) + 1;
    p.duplicate = seen[k] <= (existing[k] || 0);
    const cands = catByRef[`${p.type}|${p.ref}`];
    p.category = cands ? Object.entries(cands).sort((a, b) => b[1] - a[1])[0][0] : "";
    // 預覽時就顯示判定結果；實際拆手續費在存檔時由 autoJudgeImported 處理
    const account = db.finance.accounts.find(a => a.id === st.accountId);
    const j = judgeBankTransfer(`${p.ref} ${p.counterparty}`, p.type, account, db.finance.accounts);
    if (j.kind === "transfer") p.category = `互匯（${j.target.name}）`;
    else if (j.kind === "cross" && j.fee > 0) p.category = [p.category, `含手續費 ${j.fee}`].filter(Boolean).join("，");
  });
  return parsed;
}

function finRenderImport() {
  const st = finImportState;
  if (!st) return `<p class="text-slate-400">請從「流水帳」或「銀行帳戶」重新進入匯入</p>`;
  const accounts = db.finance.accounts.filter(a => a.type === "bank");
  const acc = db.finance.accounts.find(a => a.id === st.accountId);
  const headerCells = st.rows[st.headerRow] || [];
  const headers = headerCells.map(c => String(c).trim());
  const colLabel = i => `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`;
  const parsed = st.rows.length ? finImportParse(st) : [];
  const valid = parsed.filter(p => !p.reason);
  const incl = p => st.include[p.idx] !== undefined ? st.include[p.idx] : (!p.reason && !p.duplicate);
  const selectedCount = valid.filter(incl).length;
  const dupCount = valid.filter(p => p.duplicate).length;
  const invalidCount = parsed.filter(p => p.reason).length;
  const useSplit = st.map.debit !== undefined || st.map.credit !== undefined;

  return `
  <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
      <div>
        <label class="text-xs text-slate-500">匯入到哪個帳戶</label>
        <select id="im-account" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${accounts.map(a => `<option value="${finEsc(a.id)}" ${a.id === st.accountId ? "selected" : ""}>${finEsc(a.name)}</option>`).join("") || `<option value="">請先到「銀行帳戶」建立銀行帳戶</option>`}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">對帳單檔案（.csv／.xlsx／.xls）</label>
        <input id="im-file" type="file" accept=".csv,.txt,.xlsx,.xls" class="w-full text-sm mt-1"/>
      </div>
    </div>
    <p class="text-xs text-slate-400">網路銀行匯出的對帳單都可以。CSV 若是 Big5 編碼會自動辨識；Excel 檔需要連網載入解析元件（第一次使用時），不方便的話請先在 Excel 另存成 CSV。</p>
    ${st.loading ? `<p class="text-sm text-slate-500 mt-3">讀取中…</p>` : ""}
    ${st.error ? `<p class="text-sm text-rose-600 mt-3">${finEsc(st.error)}</p>` : ""}
  </div>

  ${st.rows.length ? `
  <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
    <p class="font-semibold text-sm text-slate-700 mb-1">步驟 2：對應欄位　<span class="font-normal text-slate-400 text-xs">${finEsc(st.fileName)}（共 ${st.rows.length} 列）</span></p>
    <div class="flex items-center gap-3 mb-3 text-sm">
      <label class="text-slate-600">標題列是第</label>
      <select id="im-header" class="border rounded-lg px-2 py-1 text-sm">${st.rows.slice(0, 25).map((_, i) => `<option value="${i}" ${i === st.headerRow ? "selected" : ""}>${i + 1}</option>`).join("")}</select>
      <label class="text-slate-600">列</label>
    </div>
    <div class="overflow-x-auto border rounded-lg mb-4">
      <table class="text-xs">
        <thead class="bg-slate-100 text-slate-500"><tr><th class="px-2 py-1">列</th>${headers.map((h, i) => `<th class="px-2 py-1 text-left whitespace-nowrap">${colLabel(i)}：${finEsc(h)}</th>`).join("")}</tr></thead>
        <tbody>${st.rows.slice(st.headerRow + 1, st.headerRow + 6).map((r, ri) => `<tr class="border-t"><td class="px-2 py-1 text-slate-400">${st.headerRow + 2 + ri}</td>${headers.map((_, i) => `<td class="px-2 py-1 whitespace-nowrap">${finEsc(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      ${FIN_IMPORT_FIELDS.map(f => `
        <div>
          <label class="text-xs text-slate-500">${f.label}${f.required ? " *" : ""}</label>
          <select class="im-map w-full border rounded-lg px-2 py-1.5 text-sm mt-1" data-key="${f.key}">
            <option value="-1">（不使用）</option>
            ${headers.map((h, i) => `<option value="${i}" ${st.map[f.key] === i ? "selected" : ""}>${colLabel(i)}：${finEsc(h)}</option>`).join("")}
          </select>
        </div>`).join("")}
    </div>
    ${!useSplit && st.map.amount !== undefined ? `<label class="flex items-center gap-1.5 text-sm text-slate-600 mb-2"><input id="im-invert" type="checkbox" ${st.invert ? "checked" : ""}/> 金額正負相反（這家銀行是「支出為正、存入為負」時勾選）</label>` : ""}
    <p class="text-xs text-slate-400">只要有「支出」「存入」兩欄，或一欄「金額」其中一種就行。對應設定會記在這個帳戶，下次匯入同一家銀行的檔案會自動套用。</p>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <p class="font-semibold text-sm text-slate-700">步驟 3：確認並匯入</p>
      <p class="text-sm text-slate-500">辨識到 ${valid.length} 筆　｜　疑似重複 <span class="${dupCount ? "text-amber-600 font-semibold" : ""}">${dupCount}</span>（預設不匯入）　｜　無法辨識 <span class="${invalidCount ? "text-rose-600 font-semibold" : ""}">${invalidCount}</span></p>
    </div>
    ${st.map.date === undefined || (st.map.debit === undefined && st.map.credit === undefined && st.map.amount === undefined) ? `<p class="text-sm text-amber-600">請先對應「交易日期」，以及「支出／存入」或「金額」欄位。</p>` : `
    <div class="overflow-x-auto border rounded-lg">
      <table class="w-full text-sm">
        <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="px-3 py-2">匯入</th><th class="px-3 py-2">日期</th><th class="px-3 py-2">類型</th><th class="px-3 py-2">摘要</th><th class="px-3 py-2">對象</th><th class="px-3 py-2 text-right">金額</th><th class="px-3 py-2 text-right">餘額</th><th class="px-3 py-2">狀態</th><th class="px-3 py-2">建議類別</th></tr></thead>
        <tbody>
          ${parsed.slice(0, 200).map(p => `
            <tr class="border-t ${p.reason ? "bg-rose-50" : p.duplicate ? "bg-amber-50" : ""}">
              <td class="px-3 py-1.5"><input type="checkbox" class="im-inc" data-idx="${p.idx}" ${incl(p) ? "checked" : ""} ${p.reason ? "disabled" : ""}/></td>
              <td class="px-3 py-1.5 text-xs whitespace-nowrap">${finEsc(p.date || "?")}</td>
              <td class="px-3 py-1.5">${p.type === "income" ? `<span class="text-emerald-600">收入</span>` : p.type === "expense" ? `<span class="text-rose-600">支出</span>` : "-"}</td>
              <td class="px-3 py-1.5">${finEsc(p.ref) || "-"}</td>
              <td class="px-3 py-1.5">${finEsc(p.counterparty) || ""}</td>
              <td class="px-3 py-1.5 text-right ${p.type === "income" ? "text-emerald-600" : "text-rose-600"}">${p.type ? finMoney(p.amount) : ""}</td>
              <td class="px-3 py-1.5 text-right text-xs text-slate-400">${p.balance != null ? finMoney(p.balance) : ""}</td>
              <td class="px-3 py-1.5 text-xs">${p.reason ? `<span class="text-rose-600">${finEsc(p.reason)}</span>` : p.duplicate ? `<span class="text-amber-600">疑似重複</span>` : `<span class="text-emerald-600">新增</span>`}</td>
              <td class="px-3 py-1.5 text-xs text-slate-500">${finEsc(p.category) || ""}</td>
            </tr>`).join("") || `<tr><td colspan="9" class="px-4 py-6 text-center text-slate-400">沒有辨識到資料，請檢查標題列與欄位對應</td></tr>`}
        </tbody>
      </table>
    </div>
    ${parsed.length > 200 ? `<p class="text-xs text-slate-400 mt-2">畫面只顯示前 200 筆，其餘筆數依同樣規則匯入（疑似重複與無法辨識的不匯入）。</p>` : ""}`}
    <div class="mt-4">
      <button id="im-go-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700 ${selectedCount ? "" : "opacity-50"}">匯入 ${selectedCount} 筆到「${finEsc(acc?.name || "")}」</button>
      <button id="im-cancel-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消</button>
      <p id="im-msg" class="text-xs hidden mt-2"></p>
    </div>
  </div>` : ""}`;
}

function finBindImport() {
  const st = finImportState;
  if (!st) return;
  const $ = id => document.getElementById(id);
  $("im-account").onchange = () => { st.accountId = $("im-account").value; st.include = {}; if (st.rows.length) { st.map = finGuessMapping((st.rows[st.headerRow] || []).map(c => String(c).trim()), db.finance.accounts.find(a => a.id === st.accountId)?.importMapping); } render(); };
  $("im-file").onchange = async () => {
    const file = $("im-file").files[0];
    if (!file) return;
    st.loading = true; st.error = ""; st.fileName = file.name; render();
    try {
      st.rows = await finReadImportFile(file);
      if (!st.rows.length) throw new Error("檔案裡沒有資料");
      st.headerRow = finGuessHeaderRow(st.rows);
      const saved = db.finance.accounts.find(a => a.id === st.accountId)?.importMapping;
      st.map = finGuessMapping(st.rows[st.headerRow].map(c => String(c).trim()), saved);
      st.invert = !!saved?.invert;
      st.include = {};
    } catch (err) {
      st.rows = []; st.error = `讀取失敗：${err.message}`;
    }
    st.loading = false;
    render();
  };
  $("im-header")?.addEventListener("change", () => {
    st.headerRow = Number($("im-header").value);
    st.map = finGuessMapping(st.rows[st.headerRow].map(c => String(c).trim()), db.finance.accounts.find(a => a.id === st.accountId)?.importMapping);
    st.include = {};
    render();
  });
  document.querySelectorAll(".im-map").forEach(sel => {
    sel.onchange = () => {
      const idx = Number(sel.value);
      if (idx < 0) delete st.map[sel.dataset.key]; else st.map[sel.dataset.key] = idx;
      if ((st.map.debit !== undefined || st.map.credit !== undefined) && sel.dataset.key !== "amount") delete st.map.amount;
      st.include = {};
      render();
    };
  });
  $("im-invert")?.addEventListener("change", () => { st.invert = $("im-invert").checked; st.include = {}; render(); });
  document.querySelectorAll(".im-inc").forEach(cb => {
    cb.onchange = () => { st.include[Number(cb.dataset.idx)] = cb.checked; const go = $("im-go-btn"); const n = document.querySelectorAll(".im-inc:checked").length; go.classList.toggle("opacity-50", !n); };
  });
  $("im-cancel-btn")?.addEventListener("click", () => { finImportState = null; goBack(); });
  $("im-go-btn")?.addEventListener("click", () => {
    const fail = msg => showMsg("im-msg", msg, true);
    if (!st.accountId) return fail("請選擇帳戶");
    const parsed = finImportParse(st);
    const incl = p => st.include[p.idx] !== undefined ? st.include[p.idx] : (!p.reason && !p.duplicate);
    let chosen = parsed.filter(p => !p.reason && incl(p));
    if (!chosen.length) return fail("沒有可匯入的資料");
    // 對帳單若是新到舊排列，反過來，讓同一天內的先後順序（和餘額）維持正確
    const dated = chosen.filter(p => p.date);
    if (dated.length > 1 && dated[0].date > dated[dated.length - 1].date) chosen = chosen.slice().reverse();
    const batch = finId("imp");
    let seq = finNextSeq();
    chosen.forEach(p => {
      // 預覽用的「互匯」「含手續費」文字不存進類別，判定結果由 autoJudgeImported 寫入
      const category = /^互匯（|^含手續費/.test(p.category || "") ? "" : (p.category || "").replace(/，含手續費 \d+$/, "");
      db.finance.ledger.push({ id: finId("led"), seq: seq++, accountId: st.accountId, date: p.date, type: p.type, category, amount: p.amount, counterparty: p.counterparty, note: p.note, ref: p.ref, balance: p.balance, source: "import", importBatch: batch, allocations: [] });
    });
    // 記住這個帳戶的欄位對應（用標題文字記，之後換月份的檔案也能自動套用）
    const acc = db.finance.accounts.find(a => a.id === st.accountId);
    const headers = (st.rows[st.headerRow] || []).map(c => String(c).trim());
    acc.importMapping = { invert: st.invert };
    FIN_IMPORT_FIELDS.forEach(f => { if (st.map[f.key] !== undefined) acc.importMapping[f.key] = headers[st.map[f.key]]; });
    saveDB(db);
    finLedgerFilter = { account: st.accountId, type: "", category: "", recon: "", month: "", q: "" };
    finLedgerPage = 0;
    finLedgerSel.clear();
    finImportState = null;
    alert(`已匯入 ${chosen.length} 筆。\n下一步：到流水帳用「批次設定類別」整理類別，再用「自動配對發票」核對。`);
    goBack();
  });
}

// ============================================================
// 貸款管理（每月扣款核對）
// ============================================================
// 依貸款設定產生每一期，再把流水帳裡的貸款扣款歸到最近的一期
function finLoanSchedule(loan) {
  const [sy, sm] = (loan.startMonth || "").split("-").map(Number);
  if (!sy || !sm) return { periods: [], extras: [] };
  const total = Number(loan.totalPeriods) || 0;
  const now = new Date();
  const monthsUntilNow = (now.getFullYear() - sy) * 12 + (now.getMonth() + 1 - sm) + 1;
  const n = total > 0 ? total : Math.max(0, monthsUntilNow);
  const today = todayISO();
  const periods = [];
  for (let i = 0; i < n; i++) {
    const idx = sm - 1 + i, y = sy + Math.floor(idx / 12), m = (idx % 12) + 1;
    const day = Math.min(Number(loan.dayOfMonth) || 1, new Date(y, m, 0).getDate());
    periods.push({ no: i + 1, month: `${y}-${String(m).padStart(2, "0")}`, date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, expected: Number(loan.monthlyAmount) || 0, entries: [], actual: 0 });
  }
  const cat = loan.category || loan.name;
  const cands = db.finance.ledger.filter(e => e.type === "expense" && !finIsTransfer(e) && (e.loanId === loan.id || (!e.loanId && e.category === cat && (!loan.accountId || e.accountId === loan.accountId))));
  const extras = [];
  cands.forEach(e => {
    let best = -1, bestDiff = Infinity;
    periods.forEach((p, i) => { const diff = Math.abs(finDayDiff(e.date, p.date)); if (diff < bestDiff) { bestDiff = diff; best = i; } });
    if (best >= 0 && (e.loanId === loan.id || bestDiff <= 15)) periods[best].entries.push(e); else extras.push(e);
  });
  periods.forEach(p => {
    p.actual = p.entries.reduce((s, e) => s + e.amount, 0);
    const due = finAddDays(p.date, 5) <= today;     // 扣款日後寬限 5 天才算漏扣
    if (!p.entries.length) p.status = due ? "missing" : "upcoming";
    else if (p.actual === p.expected) p.status = p.entries.length > 1 ? "okMulti" : "ok";
    else if (p.entries.length > 1 && p.actual > p.expected) p.status = "duplicate";
    else p.status = p.actual > p.expected ? "over" : "short";
  });
  return { periods, extras };
}
const FIN_LOAN_STATUS = {
  ok: ["已扣款", "bg-emerald-100 text-emerald-700"], okMulti: ["已扣款（多筆）", "bg-emerald-100 text-emerald-700"],
  missing: ["未扣款", "bg-rose-100 text-rose-700"], upcoming: ["尚未到期", "bg-slate-100 text-slate-500"],
  over: ["金額不符（多扣）", "bg-rose-100 text-rose-700"], short: ["金額不符（少扣）", "bg-rose-100 text-rose-700"], duplicate: ["多筆扣款（合計多於應扣）", "bg-rose-100 text-rose-700"],
};
function finLoanSummary(loan) {
  const { periods, extras } = finLoanSchedule(loan);
  const today = todayISO();
  const dueP = periods.filter(p => p.date <= today);
  const problems = periods.filter(p => ["missing", "over", "short", "duplicate"].includes(p.status));
  return { periods, extras, due: dueP.length, ok: periods.filter(p => p.status === "ok" || p.status === "okMulti").length, problems: problems.length, actual: periods.reduce((s, p) => s + p.actual, 0), remaining: Math.max(0, periods.length - dueP.length) };
}

function finRenderLoans() {
  const loans = db.finance.loans;
  const edit = loans.find(l => l.id === finLoanEditId);
  const accounts = db.finance.accounts;
  const thisMonth = todayISO().slice(0, 7);

  return `
  <datalist id="loan-cats">${[...new Set([...FIN_EXPENSE_CATEGORIES])].map(c => `<option value="${finEsc(c)}"></option>`).join("")}</datalist>
  <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
    <p class="font-semibold text-sm text-slate-700 mb-3">${edit ? `編輯貸款：${finEsc(edit.name)}` : "新增貸款"}</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">貸款名稱</label>
        <input id="ln-name" value="${finEsc(edit?.name || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：中信士傑貸(64期)"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">流水帳類別（用來自動歸入）</label>
        <input id="ln-cat" list="loan-cats" value="${finEsc(edit?.category || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="預設同貸款名稱"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">扣款帳戶</label>
        <select id="ln-account" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"><option value="">不限帳戶</option>${accounts.map(a => `<option value="${finEsc(a.id)}" ${edit?.accountId === a.id ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">每月應扣金額</label>
        <input id="ln-amount" type="number" min="0" step="1" value="${edit?.monthlyAmount ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="整數元"/>
      </div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">每月扣款日（1–31）</label>
        <input id="ln-day" type="number" min="1" max="31" step="1" value="${edit?.dayOfMonth ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">第一期扣款月份</label>
        <input id="ln-start" type="month" value="${finEsc(edit?.startMonth || thisMonth)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">總期數（空白＝持續）</label>
        <input id="ln-periods" type="number" min="0" step="1" value="${edit?.totalPeriods ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：64"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">備註（選填）</label>
        <input id="ln-note" value="${finEsc(edit?.note || "")}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
    </div>
    <button id="ln-save-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">${edit ? "儲存變更" : "新增貸款"}</button>
    ${edit ? `<button id="ln-cancel-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消編輯</button>` : ""}
    <p id="ln-msg" class="text-xs hidden mt-2"></p>
    <p class="text-xs text-slate-400 mt-2">只要流水帳裡「支出、類別等於上面的類別、帳戶相符」就會自動算成這筆貸款的扣款；也可以在流水帳按「核對」手動指定。扣款日後 5 天內沒有扣款才會標示未扣款。</p>
  </div>

  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">貸款</th><th class="px-4 py-2">扣款帳戶</th><th class="px-4 py-2 text-right">每月應扣</th><th class="px-4 py-2 text-right">扣款日</th><th class="px-4 py-2">進度</th><th class="px-4 py-2 text-right">累計實扣</th><th class="px-4 py-2">核對</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        ${loans.map(l => { const s = finLoanSummary(l); return `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 font-medium">${finEsc(l.name)}${l.note ? `<div class="text-xs text-slate-400">${finEsc(l.note)}</div>` : ""}</td>
            <td class="px-4 py-2">${l.accountId ? finEsc(finAccountName(l.accountId)) : "不限"}</td>
            <td class="px-4 py-2 text-right">${finMoney(l.monthlyAmount)}</td>
            <td class="px-4 py-2 text-right">${l.dayOfMonth} 日</td>
            <td class="px-4 py-2 text-xs text-slate-600">已到期 ${s.due} 期，正常 ${s.ok} 期${Number(l.totalPeriods) ? `，共 ${l.totalPeriods} 期（剩 ${s.remaining} 期）` : "（持續扣款）"}</td>
            <td class="px-4 py-2 text-right">${finMoney(s.actual)}</td>
            <td class="px-4 py-2">${s.problems ? `<span class="px-2 py-0.5 rounded-full text-xs bg-rose-100 text-rose-700">${s.problems} 期異常</span>` : s.due ? `<span class="px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700">全部正常</span>` : `<span class="text-xs text-slate-400">尚未到期</span>`}${s.extras.length ? `<div class="text-[11px] text-amber-600 mt-0.5">另有 ${s.extras.length} 筆扣款未歸期</div>` : ""}</td>
            <td class="px-4 py-2 text-right whitespace-nowrap">
              <button data-id="${finEsc(l.id)}" class="ln-open-btn text-blue-600 hover:underline text-xs mr-2">逐期核對</button>
              <button data-id="${finEsc(l.id)}" class="ln-edit-btn text-slate-600 hover:underline text-xs mr-2">編輯</button>
              <button data-id="${finEsc(l.id)}" class="ln-del-btn text-rose-500 hover:underline text-xs">刪除</button>
            </td>
          </tr>`; }).join("") || `<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">尚未建立貸款。新增後，系統會逐月檢查銀行流水有沒有按時、按金額扣款。</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function finBindLoans() {
  const $ = id => document.getElementById(id);
  $("ln-save-btn").onclick = () => {
    const fail = msg => showMsg("ln-msg", msg, true);
    const name = $("ln-name").value.trim();
    const monthly = finParseAmount($("ln-amount").value, false);
    const day = Number($("ln-day").value);
    const start = $("ln-start").value;
    const periodsRaw = $("ln-periods").value.trim();
    const periods = periodsRaw === "" ? "" : Number(periodsRaw);
    if (!name) return fail("請輸入貸款名稱");
    if (monthly === null) return fail("每月應扣金額請輸入大於 0 的整數");
    if (!Number.isInteger(day) || day < 1 || day > 31) return fail("每月扣款日請輸入 1 到 31");
    if (!start) return fail("請選擇第一期扣款月份");
    if (periods !== "" && (!Number.isInteger(periods) || periods < 0)) return fail("總期數請輸入正整數，或留空");
    if (db.finance.loans.some(l => l.name === name && l.id !== finLoanEditId)) return fail("已經有同名的貸款了");
    const data = { name, category: $("ln-cat").value.trim() || name, accountId: $("ln-account").value, monthlyAmount: monthly, dayOfMonth: day, startMonth: start, totalPeriods: periods === 0 ? "" : periods, note: $("ln-note").value.trim() };
    const edit = db.finance.loans.find(l => l.id === finLoanEditId);
    if (edit) Object.assign(edit, data); else db.finance.loans.push({ id: finId("loan"), ...data });
    finLoanEditId = "";
    finSave();
  };
  $("ln-cancel-btn")?.addEventListener("click", () => { finLoanEditId = ""; render(); });
  document.querySelectorAll(".ln-edit-btn").forEach(b => { b.onclick = () => { finLoanEditId = b.dataset.id; render(); }; });
  document.querySelectorAll(".ln-open-btn").forEach(b => { b.onclick = () => navigateTo({ page: "fin-loan-detail", finLoanId: b.dataset.id }); });
  document.querySelectorAll(".ln-del-btn").forEach(b => {
    b.onclick = () => {
      const l = db.finance.loans.find(x => x.id === b.dataset.id);
      if (!l) return;
      appConfirm(`確定要刪除貸款「${l.name}」嗎？流水帳裡的紀錄不會被刪除，只是不再核對。`, () => {
        db.finance.loans = db.finance.loans.filter(x => x.id !== l.id);
        db.finance.ledger.forEach(e => { if (e.loanId === l.id) delete e.loanId; });
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
}

function finRenderLoanDetail() {
  const loan = db.finance.loans.find(l => l.id === view.finLoanId);
  if (!loan) return `<p class="text-slate-400">找不到這筆貸款</p>`;
  const s = finLoanSummary(loan);
  const today = todayISO();
  const diffTotal = s.periods.filter(p => p.date <= today).reduce((a, p) => a + p.actual - p.expected, 0);

  return `
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
    <div class="bg-white rounded-xl shadow-sm p-4"><p class="text-xs text-slate-500">每月應扣</p><p class="text-lg font-bold text-slate-800 mt-1">NT$ ${finMoney(loan.monthlyAmount)}</p><p class="text-xs text-slate-400 mt-1">每月 ${loan.dayOfMonth} 日・${loan.accountId ? finEsc(finAccountName(loan.accountId)) : "不限帳戶"}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-4"><p class="text-xs text-slate-500">已到期期數</p><p class="text-lg font-bold text-slate-800 mt-1">${s.due} 期</p><p class="text-xs text-slate-400 mt-1">${Number(loan.totalPeriods) ? `共 ${loan.totalPeriods} 期，剩 ${s.remaining} 期` : "持續扣款"}</p></div>
    <div class="bg-white rounded-xl shadow-sm p-4"><p class="text-xs text-slate-500">異常期數</p><p class="text-lg font-bold ${s.problems ? "text-rose-600" : "text-emerald-600"} mt-1">${s.problems} 期</p><p class="text-xs text-slate-400 mt-1">正常 ${s.ok} 期</p></div>
    <div class="bg-white rounded-xl shadow-sm p-4"><p class="text-xs text-slate-500">到期應扣 vs 實扣差額</p><p class="text-lg font-bold ${diffTotal === 0 ? "text-slate-800" : "text-rose-600"} mt-1">${diffTotal > 0 ? "+" : ""}${finMoney(diffTotal)}</p><p class="text-xs text-slate-400 mt-1">累計實扣 ${finMoney(s.actual)}</p></div>
  </div>

  <div class="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">期</th><th class="px-4 py-2">月份</th><th class="px-4 py-2">預計扣款日</th><th class="px-4 py-2 text-right">應扣</th><th class="px-4 py-2">實際扣款</th><th class="px-4 py-2 text-right">實扣合計</th><th class="px-4 py-2 text-right">差額</th><th class="px-4 py-2">狀態</th></tr>
      </thead>
      <tbody>
        ${s.periods.map(p => `
          <tr class="border-t ${p.date <= today ? "" : "text-slate-400"} ${["missing", "over", "short", "duplicate"].includes(p.status) ? "bg-rose-50/50" : ""}">
            <td class="px-4 py-2">${p.no}</td>
            <td class="px-4 py-2">${p.month}</td>
            <td class="px-4 py-2 text-xs">${p.date}</td>
            <td class="px-4 py-2 text-right">${finMoney(p.expected)}</td>
            <td class="px-4 py-2 text-xs">${p.entries.map(e => `<div>${finEsc(e.date)}　${finMoney(e.amount)}　<span class="text-slate-400">${finEsc(finAccountName(e.accountId))}</span> <button data-id="${finEsc(e.id)}" class="ld-recon-btn text-blue-600 hover:underline">核對</button></div>`).join("") || "-"}</td>
            <td class="px-4 py-2 text-right">${p.entries.length ? finMoney(p.actual) : "-"}</td>
            <td class="px-4 py-2 text-right ${p.entries.length && p.actual !== p.expected ? "text-rose-600 font-semibold" : ""}">${p.entries.length ? (p.actual - p.expected > 0 ? "+" : "") + finMoney(p.actual - p.expected) : "-"}</td>
            <td class="px-4 py-2"><span class="px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${FIN_LOAN_STATUS[p.status][1]}">${FIN_LOAN_STATUS[p.status][0]}</span></td>
          </tr>`).join("") || `<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">還沒有任何一期（請確認「第一期扣款月份」）</td></tr>`}
      </tbody>
    </table>
  </div>

  ${s.extras.length ? `
  <p class="font-semibold text-sm text-slate-700 mb-2">找不到對應期別的扣款（和任何一期都差超過 15 天）</p>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm"><tbody>
      ${s.extras.map(e => `<tr class="border-t"><td class="px-4 py-2 text-xs text-slate-500">${finEsc(e.date)}</td><td class="px-4 py-2">${finEsc(finAccountName(e.accountId))}</td><td class="px-4 py-2 text-right">${finMoney(e.amount)}</td><td class="px-4 py-2 text-slate-500">${finEsc(e.ref || e.note) || "-"}</td><td class="px-4 py-2 text-right"><button data-id="${finEsc(e.id)}" class="ld-recon-btn text-blue-600 hover:underline text-xs">核對</button></td></tr>`).join("")}
    </tbody></table>
  </div>` : ""}
  <p class="text-xs text-slate-400 mt-3">沒對到的期別，請確認流水帳那筆扣款的「類別」是「${finEsc(loan.category || loan.name)}」${loan.accountId ? `、帳戶是「${finEsc(finAccountName(loan.accountId))}」` : ""}，或在流水帳按「核對」手動指定這筆貸款。</p>`;
}
function finBindLoanDetail() {
  document.querySelectorAll(".ld-recon-btn").forEach(b => { b.onclick = () => finOpenReconcile(b.dataset.id); });
}
