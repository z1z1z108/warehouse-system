// ============================================================
// 財務會計（僅震浤管理員）— 銀行帳戶、多帳戶流水帳、發票／貸款核對、對帳單匯入、貸款管理
// 與 finance.js 搭配使用（共用 finEsc、finMoney、finId、finSettlement… 等工具）。
//
// 流水帳 db.finance.ledger 每筆：
//   { id, seq, accountId, date(YYYY-MM-DD), type: "income"|"expense", category, amount, counterparty, note,
//     ref(銀行摘要原文), balance(對帳單餘額), source: "manual"|"import", importBatch,
//     clientId(客戶入帳), allocations: [{ invoiceId, amount }](核對到的發票), loanId(貸款扣款), noMatch(不需核對),
//     transferGroup(帳戶間轉帳的兩筆共用) }
// ============================================================

let finLedgerFilter = { account: "", type: "", category: "", recon: "", month: "", q: "" };
let finLedgerDraft = { accountId: "", type: "expense", date: "" };
let finLedgerPage = 0;
const finLedgerSel = new Set();
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
function finShortName(name) { return String(name || "").replace(/\s*[(（].*$/, ""); }
function finDefaultAccountId() {
  const a = db.finance.accounts;
  if (finLedgerDraft.accountId && a.some(x => x.id === finLedgerDraft.accountId)) return finLedgerDraft.accountId;
  return (a.find(x => x.type === "bank") || a[0])?.id || "";
}
function finAccountBalance(acc) {
  let bal = Number(acc.openingBalance) || 0;
  db.finance.ledger.forEach(e => { if (e.accountId === acc.id) bal += e.type === "income" ? e.amount : -e.amount; });
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
function finCategoryDatalists() {
  return `<datalist id="fin-income-cats">${FIN_INCOME_CATEGORIES.map(c => `<option value="${finEsc(c)}"></option>`).join("")}</datalist>
          <datalist id="fin-expense-cats">${FIN_EXPENSE_CATEGORIES.map(c => `<option value="${finEsc(c)}"></option>`).join("")}</datalist>`;
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
  const a = finEntryAllocated(e);
  if (a >= e.amount) return { code: "settled", label: "已核對" };
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
  db.finance.invoices.forEach(i => { remaining[i.id] = st[i.id].outstanding; });
  const open = db.finance.ledger.filter(e => finReconStatus(e, ctx).code === "open").sort((a, b) => a.date.localeCompare(b.date));
  let matched = 0, ambiguous = 0, none = 0;
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
      e.allocations = [{ invoiceId: inv.id, amount: e.amount }];
      if (kind === "sales") e.clientId = inv.clientId;
      remaining[inv.id] = 0;
      matched++;
    } else if (cands.length > 1) ambiguous++;
    else none++;
  });
  return { matched, ambiguous, none };
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
        <label class="text-xs text-slate-500">類型</label>
        <select id="acc-type" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          <option value="bank" ${(edit?.type || "bank") === "bank" ? "selected" : ""}>銀行帳戶</option>
          <option value="cash" ${edit?.type === "cash" ? "selected" : ""}>現金</option>
        </select>
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
      <div class="md:col-span-3">
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
        <tr><th class="px-4 py-2">帳戶</th><th class="px-4 py-2">類型</th><th class="px-4 py-2">銀行／帳號</th><th class="px-4 py-2 text-right">期初餘額</th><th class="px-4 py-2 text-right">系統餘額</th><th class="px-4 py-2 text-right">對帳單餘額差異</th><th class="px-4 py-2 text-right">筆數</th><th class="px-4 py-2 text-right">待核對</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        ${accounts.map(a => { const s = stat(a.id), chk = finAccountStatementCheck(a), bal = finAccountBalance(a); return `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 font-medium">${finEsc(a.name)}</td>
            <td class="px-4 py-2">${a.type === "cash" ? "現金" : "銀行"}</td>
            <td class="px-4 py-2 text-slate-500">${finEsc([a.bankName, a.accountNo].filter(Boolean).join(" ")) || "-"}</td>
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
    const data = { name, type: $("acc-type").value, bankName: $("acc-bank").value.trim(), accountNo: $("acc-no").value.trim(), openingBalance: opening, note: $("acc-note").value.trim() };
    const edit = db.finance.accounts.find(a => a.id === finAccountEditId);
    if (edit) Object.assign(edit, data); else db.finance.accounts.push({ id: finId("acc"), ...data });
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
      if (!confirm(`確定要刪除帳戶「${a.name}」嗎？`)) return;
      db.finance.accounts = db.finance.accounts.filter(x => x.id !== a.id);
      if (finLedgerFilter.account === a.id) finLedgerFilter.account = "";
      finSave();
    };
  });
}

// ============================================================
// 流水帳
// ============================================================
function finFilteredLedger(ctx) {
  const f = finLedgerFilter;
  let rows = db.finance.ledger.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.seq || 0) - (a.seq || 0) || b.id.localeCompare(a.id));
  if (f.account) rows = rows.filter(e => e.accountId === f.account);
  if (f.type) rows = rows.filter(e => e.type === f.type);
  if (f.category) rows = rows.filter(e => f.category === "__none__" ? !e.category : e.category === f.category);
  if (f.month) rows = rows.filter(e => finMonthOf(e.date) === f.month);
  const q = f.q.trim().toLowerCase();
  if (q) rows = rows.filter(e => `${e.category || ""} ${e.counterparty || ""} ${e.ref || ""} ${e.note || ""} ${e.amount}`.toLowerCase().includes(q));
  if (f.recon) rows = rows.filter(e => finReconStatus(e, ctx).code === f.recon);
  return rows;
}

function finRenderLedger() {
  const ctx = finReconContext();
  const d = finLedgerDraft, f = finLedgerFilter;
  const accounts = db.finance.accounts;
  const rows = finFilteredLedger(ctx);
  const pages = Math.max(1, Math.ceil(rows.length / FIN_PAGE_SIZE));
  if (finLedgerPage >= pages) finLedgerPage = pages - 1;
  const pageRows = rows.slice(finLedgerPage * FIN_PAGE_SIZE, (finLedgerPage + 1) * FIN_PAGE_SIZE);
  const plain = rows.filter(e => !finIsTransfer(e));
  const income = plain.filter(e => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const expense = plain.filter(e => e.type === "expense").reduce((s, e) => s + e.amount, 0);
  const codes = rows.map(e => finReconStatus(e, ctx).code);
  const cnt = c => codes.filter(x => x === c).length;
  const categories = [...new Set(db.finance.ledger.map(e => e.category).filter(Boolean))].sort();
  const parties = [...new Set([...finClients().map(c => c.name), ...db.finance.invoices.filter(i => i.vendor).map(i => i.vendor)])];
  const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
  const defAcc = finDefaultAccountId();
  const allSelected = pageRows.length > 0 && pageRows.every(e => finLedgerSel.has(e.id));
  const reconOptions = [["", "全部"], ["open", "未核對"], ["partial", "部分核對"], ["settled", "已核對"], ["loan", "貸款扣款"], ["nomatch", "不需核對"]];

  return `
  ${finCategoryDatalists()}
  <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
    <div class="flex items-center justify-between mb-3">
      <p class="font-semibold text-sm text-slate-700">新增流水</p>
      <div class="flex gap-2">
        <button id="led-import-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">⬆ 匯入銀行對帳單</button>
        <button id="led-auto-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100" title="金額和發票未核對餘額完全相同，且只有一張候選時才配對">⚡ 自動配對發票</button>
      </div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">帳戶</label>
        <select id="led-account" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${accounts.map(a => `<option value="${finEsc(a.id)}" ${a.id === defAcc ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select>
      </div>
      <div>
        <label class="text-xs text-slate-500">日期</label>
        <input id="led-date" type="date" value="${d.date || todayISO()}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">類型</label>
        <select id="led-type" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          <option value="income" ${d.type === "income" ? "selected" : ""}>收入（入帳）</option>
          <option value="expense" ${d.type === "expense" ? "selected" : ""}>支出（扣款／匯出）</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">類別</label>
        <input id="led-category" list="${d.type === "income" ? "fin-income-cats" : "fin-expense-cats"}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="可選擇或自行輸入"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">金額</label>
        <input id="led-amount" type="number" min="0" step="1" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="整數元"/>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">對象（客戶／廠商，選填）</label>
        <input id="led-party" list="led-party-list" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
        <datalist id="led-party-list">${parties.map(p => `<option value="${finEsc(p)}"></option>`).join("")}</datalist>
      </div>
      <div>
        <label class="text-xs text-slate-500">備註（選填）</label>
        <input id="led-note" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
      </div>
    </div>
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
        <label class="text-xs text-slate-500">類型</label>
        <select id="led-f-type" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">
          <option value="">全部</option><option value="income" ${f.type === "income" ? "selected" : ""}>收入</option><option value="expense" ${f.type === "expense" ? "selected" : ""}>支出</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">類別</label>
        <select id="led-f-category" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">
          <option value="">全部</option><option value="__none__" ${f.category === "__none__" ? "selected" : ""}>（未分類）</option>
          ${categories.map(c => `<option value="${finEsc(c)}" ${f.category === c ? "selected" : ""}>${finEsc(c)}</option>`).join("")}
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
        <input id="led-f-q" value="${finEsc(f.q)}" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1" placeholder="類別／對象／摘要／金額，按 Enter"/>
      </div>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2 mt-3">
      <p class="text-xs text-slate-500">
        共 ${rows.length} 筆　｜　收入 <span class="text-emerald-600 font-semibold">${finMoney(income)}</span>　｜　支出 <span class="text-rose-600 font-semibold">${finMoney(expense)}</span>　｜　淨額 <span class="font-semibold ${income - expense < 0 ? "text-rose-600" : "text-slate-800"}">${finMoney(income - expense)}</span>
        　｜　未核對 <span class="${cnt("open") ? "text-rose-600 font-semibold" : ""}">${cnt("open")}</span>　部分 <span class="${cnt("partial") ? "text-amber-600 font-semibold" : ""}">${cnt("partial")}</span>　已核對 ${cnt("settled")}　貸款 ${cnt("loan")}
      </p>
      <div class="flex gap-2">
        <button id="led-f-clear" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">清除篩選</button>
        <button id="led-export-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>
      </div>
    </div>
  </div>

  <div class="bg-slate-800 text-white rounded-xl px-4 py-2 mb-3 flex flex-wrap items-center gap-3 text-sm">
    <span>已選 <b id="led-sel-count">${finLedgerSel.size}</b> 筆</span>
    <input id="led-bulk-cat" list="fin-expense-cats" class="rounded-lg px-2 py-1 text-sm text-slate-800" placeholder="批次設定類別"/>
    <button id="led-bulk-cat-btn" class="led-bulk bg-white text-slate-800 rounded-lg px-3 py-1 text-xs hover:bg-slate-100">套用類別</button>
    <button id="led-bulk-nomatch-btn" class="led-bulk bg-white text-slate-800 rounded-lg px-3 py-1 text-xs hover:bg-slate-100">標記不需核對</button>
    <button id="led-bulk-unmatch-btn" class="led-bulk bg-white text-slate-800 rounded-lg px-3 py-1 text-xs hover:bg-slate-100">取消核對</button>
    <button id="led-bulk-del-btn" class="led-bulk bg-rose-500 text-white rounded-lg px-3 py-1 text-xs hover:bg-rose-600">刪除所選</button>
    <button id="led-bulk-clear-btn" class="led-bulk text-slate-300 hover:text-white text-xs underline">清除選取</button>
  </div>

  <div class="bg-white rounded-xl shadow-sm overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-3 py-2"><input type="checkbox" id="led-sel-all" ${allSelected ? "checked" : ""}/></th><th class="px-3 py-2">日期</th><th class="px-3 py-2">帳戶</th><th class="px-3 py-2">類別</th><th class="px-3 py-2">對象／摘要</th><th class="px-3 py-2 text-right">金額</th><th class="px-3 py-2 text-right">餘額</th><th class="px-3 py-2">核對</th><th class="px-3 py-2">備註</th><th class="px-3 py-2"></th></tr>
      </thead>
      <tbody>
        ${pageRows.map(e => { const rs = finReconStatus(e, ctx); const nums = (e.allocations || []).map(a => invById[a.invoiceId]?.number).filter(Boolean); const transfer = finIsTransfer(e); return `
          <tr class="border-t hover:bg-slate-50 ${!e.category && !transfer ? "bg-amber-50/40" : ""}">
            <td class="px-3 py-2"><input type="checkbox" class="led-sel" data-id="${finEsc(e.id)}" ${finLedgerSel.has(e.id) ? "checked" : ""}/></td>
            <td class="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">${finEsc(e.date)}</td>
            <td class="px-3 py-2 whitespace-nowrap">${finEsc(finAccountName(e.accountId))}</td>
            <td class="px-3 py-2">${transfer ? `<span class="text-slate-500">${finEsc(e.category)}</span>` : `<input class="led-cat-input border rounded-lg px-2 py-1 text-sm w-40 ${e.category ? "" : "border-amber-300"}" list="${e.type === "income" ? "fin-income-cats" : "fin-expense-cats"}" data-id="${finEsc(e.id)}" value="${finEsc(e.category)}" placeholder="未分類"/>`}</td>
            <td class="px-3 py-2"><div>${finEsc(e.counterparty) || ""}</div>${e.ref ? `<div class="text-xs text-slate-400">${finEsc(e.ref)}</div>` : ""}</td>
            <td class="px-3 py-2 text-right font-semibold whitespace-nowrap ${e.type === "income" ? "text-emerald-600" : "text-rose-600"}">${e.type === "income" ? "+" : "−"}${finMoney(e.amount)}</td>
            <td class="px-3 py-2 text-right text-xs text-slate-400">${e.balance != null && e.balance !== "" ? finMoney(e.balance) : ""}</td>
            <td class="px-3 py-2">${finReconBadge(rs)}${nums.length ? `<div class="text-[11px] text-slate-400 font-mono mt-0.5">${finEsc(nums.slice(0, 2).join("、"))}${nums.length > 2 ? "…" : ""}</div>` : ""}</td>
            <td class="px-3 py-2 text-slate-500">${finEsc(e.note) || "-"}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap">
              ${transfer ? "" : `<button data-id="${finEsc(e.id)}" class="led-recon-btn text-blue-600 hover:underline text-xs mr-2">核對</button><button data-id="${finEsc(e.id)}" class="led-edit-btn text-slate-600 hover:underline text-xs mr-2">編輯</button>`}
              <button data-id="${finEsc(e.id)}" class="led-del-btn text-rose-500 hover:underline text-xs">刪除</button>
            </td>
          </tr>`; }).join("") || `<tr><td colspan="10" class="px-4 py-8 text-center text-slate-400">沒有符合條件的流水</td></tr>`}
      </tbody>
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
    $("led-category").setAttribute("list", finLedgerDraft.type === "income" ? "fin-income-cats" : "fin-expense-cats");
  };
  $("led-date").onchange = () => { finLedgerDraft.date = $("led-date").value; };
  $("led-account").onchange = () => { finLedgerDraft.accountId = $("led-account").value; };
  $("led-add-btn").onclick = () => {
    const accountId = $("led-account").value, date = $("led-date").value, type = $("led-type").value;
    const category = $("led-category").value.trim();
    const amount = finParseAmount($("led-amount").value, false);
    const fail = msg => showMsg("led-msg", msg, true);
    if (!accountId) return fail("請選擇帳戶");
    if (!date) return fail("請選擇日期");
    if (!category) return fail("請輸入類別");
    if (amount === null) return fail("金額請輸入大於 0 的整數");
    db.finance.ledger.push({ id: finId("led"), seq: finNextSeq(), accountId, date, type, category, amount, counterparty: $("led-party").value.trim(), note: $("led-note").value.trim(), allocations: [], source: "manual" });
    finLedgerDraft = { accountId, type, date };
    finSave();
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
  $("led-import-btn").onclick = () => finStartImport(finLedgerFilter.account || "");
  $("led-auto-btn").onclick = () => {
    const r = finAutoMatch();
    saveDB(db);
    alert(`自動配對完成：\n成功配對 ${r.matched} 筆\n有多張候選、需人工核對 ${r.ambiguous} 筆\n找不到金額相符的發票 ${r.none} 筆`);
    render();
  };

  // ---- 篩選 ----
  const bf = (id, key) => finBindFilter(id, finLedgerFilter, key, resetPage);
  bf("led-f-account", "account"); bf("led-f-type", "type"); bf("led-f-category", "category"); bf("led-f-recon", "recon"); bf("led-f-month", "month"); bf("led-f-q", "q");
  $("led-f-clear").onclick = () => { finLedgerFilter = { account: "", type: "", category: "", recon: "", month: "", q: "" }; resetPage(); render(); };
  $("led-prev")?.addEventListener("click", () => { if (finLedgerPage > 0) { finLedgerPage--; render(); } });
  $("led-next")?.addEventListener("click", () => { finLedgerPage++; render(); });
  $("led-export-btn").onclick = () => {
    const ctx = finReconContext();
    const invById = Object.fromEntries(db.finance.invoices.map(i => [i.id, i]));
    const rows = [["日期", "帳戶", "類型", "類別", "對象", "銀行摘要", "金額", "對帳單餘額", "核對狀態", "對應發票", "備註"]];
    finFilteredLedger(ctx).forEach(e => rows.push([e.date, finAccountName(e.accountId), e.type === "income" ? "收入" : "支出", e.category || "", e.counterparty || "", e.ref || "", e.amount, e.balance ?? "", finReconStatus(e, ctx).label, (e.allocations || []).map(a => `${invById[a.invoiceId]?.number || "?"}(${a.amount})`).join("、"), e.note || ""]));
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
    if (!cat) { alert("請先輸入要套用的類別"); return; }
    const es = selected().filter(e => !finIsTransfer(e));
    es.forEach(e => { e.category = cat; });
    saveDB(db); finLedgerSel.clear(); finRenderKeepScroll();
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
    if (!ids.size || !confirm(`確定要刪除這 ${ids.size} 筆流水嗎？（帳戶間轉帳會連同另一邊一起刪除）`)) return;
    db.finance.ledger = db.finance.ledger.filter(e => !ids.has(e.id));
    finLedgerSel.clear(); saveDB(db); finRenderKeepScroll();
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
    };
  });
  document.querySelectorAll(".led-recon-btn").forEach(b => { b.onclick = () => finOpenReconcile(b.dataset.id); });
  document.querySelectorAll(".led-edit-btn").forEach(b => { b.onclick = () => navigateTo({ page: "fin-entry-edit", finEntryId: b.dataset.id }); });
  document.querySelectorAll(".led-del-btn").forEach(b => {
    b.onclick = () => {
      const e = db.finance.ledger.find(x => x.id === b.dataset.id);
      if (!e) return;
      const both = e.transferGroup ? "（帳戶間轉帳會連同另一邊一起刪除）" : "";
      if (!confirm(`確定要刪除這筆${e.type === "income" ? "收入" : "支出"}（${e.category || "未分類"} ${finMoney(e.amount)}）嗎？${both}`)) return;
      db.finance.ledger = db.finance.ledger.filter(x => x.id !== e.id && !(e.transferGroup && x.transferGroup === e.transferGroup));
      finLedgerSel.delete(e.id);
      saveDB(db); finRenderKeepScroll();
    };
  });
}

// ============================================================
// 編輯流水
// ============================================================
function finRenderEntryEdit() {
  const e = db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e) return `<p class="text-slate-400">找不到這筆流水</p>`;
  const ctx = finReconContext();
  const rs = finReconStatus(e, ctx);
  return `
  ${finCategoryDatalists()}
  <div class="bg-white rounded-xl shadow-sm p-6 max-w-3xl">
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
      <div><label class="text-xs text-slate-500">日期</label><input id="ee-date" type="date" value="${finEsc(e.date)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div><label class="text-xs text-slate-500">帳戶</label><select id="ee-account" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${db.finance.accounts.map(a => `<option value="${finEsc(a.id)}" ${a.id === e.accountId ? "selected" : ""}>${finEsc(a.name)}</option>`).join("")}</select></div>
      <div><label class="text-xs text-slate-500">類型</label><select id="ee-type" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"><option value="income" ${e.type === "income" ? "selected" : ""}>收入（入帳）</option><option value="expense" ${e.type === "expense" ? "selected" : ""}>支出（扣款／匯出）</option></select></div>
      <div><label class="text-xs text-slate-500">類別</label><input id="ee-category" list="${e.type === "income" ? "fin-income-cats" : "fin-expense-cats"}" value="${finEsc(e.category)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="未分類"/></div>
      <div><label class="text-xs text-slate-500">金額</label><input id="ee-amount" type="number" min="0" step="1" value="${e.amount}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div><label class="text-xs text-slate-500">對象</label><input id="ee-party" value="${finEsc(e.counterparty)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
    </div>
    <div class="mb-3"><label class="text-xs text-slate-500">備註</label><input id="ee-note" value="${finEsc(e.note)}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
    <div class="text-xs text-slate-500 mb-4 space-y-1">
      ${e.ref ? `<p>銀行摘要：${finEsc(e.ref)}</p>` : ""}
      <p>來源：${e.source === "import" ? "匯入對帳單" : "手動輸入"}　｜　核對狀態：${finReconBadge(rs)}${finEntryAllocated(e) ? `　已分配 ${finMoney(finEntryAllocated(e))}` : ""}</p>
    </div>
    <button id="ee-save-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">儲存</button>
    <button id="ee-cancel-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消</button>
    <p id="ee-msg" class="text-xs hidden mt-2"></p>
  </div>`;
}
function finBindEntryEdit() {
  const $ = id => document.getElementById(id);
  const e = db.finance.ledger.find(x => x.id === view.finEntryId);
  if (!e) return;
  $("ee-type").onchange = () => $("ee-category").setAttribute("list", $("ee-type").value === "income" ? "fin-income-cats" : "fin-expense-cats");
  $("ee-cancel-btn").onclick = goBack;
  $("ee-save-btn").onclick = () => {
    const fail = msg => showMsg("ee-msg", msg, true);
    const date = $("ee-date").value, type = $("ee-type").value, amount = finParseAmount($("ee-amount").value, false);
    if (!date) return fail("請選擇日期");
    if (amount === null) return fail("金額請輸入大於 0 的整數");
    const hasLinks = (e.allocations || []).length || e.loanId;
    if (type !== e.type && hasLinks) return fail("這筆流水已經核對過發票／貸款，要改類型請先到「核對」取消核對");
    if (amount < finEntryAllocated(e)) return fail("金額小於已核對分配的總額，請先到「核對」調整分配");
    Object.assign(e, { date, accountId: $("ee-account").value, type, category: $("ee-category").value.trim(), amount, counterparty: $("ee-party").value.trim(), note: $("ee-note").value.trim() });
    saveDB(db);
    goBack();
  };
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
    loanId: e.loanId || auto?.id || "",
  };
}
function finReconCandidates(e, d) {
  const isIncome = e.type === "income";
  const st = finSettlement();
  const own = Object.fromEntries((e.allocations || []).map(a => [a.invoiceId, a.amount]));
  let cands = db.finance.invoices.filter(i => i.kind === (isIncome ? "sales" : "purchase")).map(inv => {
    const otherPaid = st[inv.id].paid - (own[inv.id] || 0);
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
  const loans = db.finance.loans.slice().sort((a, b) => (b.accountId === e.accountId) - (a.accountId === e.accountId));
  const loan = db.finance.loans.find(l => l.id === d.loanId);
  const rs = finReconStatus(e, finReconContext());

  return `
  <div class="bg-white rounded-xl shadow-sm p-5 mb-4">
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
      <div><p class="text-xs text-slate-500">日期</p><p class="font-medium">${finEsc(e.date)}</p></div>
      <div><p class="text-xs text-slate-500">帳戶</p><p class="font-medium">${finEsc(finAccountName(e.accountId))}</p></div>
      <div><p class="text-xs text-slate-500">類別</p><p class="font-medium">${finEsc(e.category) || "未分類"}</p></div>
      <div><p class="text-xs text-slate-500">對象／摘要</p><p class="font-medium">${finEsc(e.counterparty || e.ref) || "-"}</p></div>
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
              <tr class="border-t ${on ? "bg-sky-50" : ""}">
                <td class="px-3 py-2"><input type="checkbox" class="rc-check" data-id="${finEsc(c.inv.id)}" ${on ? "checked" : ""}/></td>
                <td class="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">${finEsc(c.inv.date)}</td>
                <td class="px-3 py-2 font-mono text-xs">${finEsc(c.inv.number)}${c.remaining === e.amount ? ` <span class="ml-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-sans">金額相符</span>` : ""}</td>
                <td class="px-3 py-2">${finEsc(finPartyName(c.inv))}</td>
                <td class="px-3 py-2 text-right">${finMoney(c.inv.total)}</td>
                <td class="px-3 py-2 text-right text-slate-500">${finMoney(c.otherPaid)}</td>
                <td class="px-3 py-2 text-right font-semibold ${c.remaining > 0 ? "text-rose-600" : "text-slate-400"}">${finMoney(c.remaining)}</td>
                <td class="px-3 py-2 text-right"><input class="rc-amount border rounded-lg px-2 py-1 text-sm w-28 text-right" data-id="${finEsc(c.inv.id)}" type="number" min="0" step="1" value="${on ? finEsc(d.alloc[c.inv.id]) : ""}" ${on ? "" : "disabled"}/></td>
              </tr>`; }).join("") || `<tr><td colspan="8" class="px-4 py-6 text-center text-slate-400">沒有可核對的${isIncome ? "銷項" : "進項"}發票${d.party ? "（可把上面的篩選改成「全部」）" : ""}</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="text-sm mt-3">流水金額 <b>${finMoney(e.amount)}</b>　｜　已分配 <b id="rc-allocated">${finMoney(allocated)}</b>　｜　未分配 <b id="rc-diff" class="${e.amount - allocated < 0 ? "text-rose-600" : e.amount - allocated > 0 ? "text-amber-600" : "text-emerald-600"}">${finMoney(e.amount - allocated)}</b></p>
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

  const updateTotals = () => {
    const sum = Object.values(d.alloc).reduce((s, v) => s + (Number(v) || 0), 0);
    $("rc-allocated").textContent = finMoney(sum);
    const diff = e.amount - sum;
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
        const def = Math.max(0, Math.min(cand ? cand.remaining : 0, e.amount - used));
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
    saveDB(db); finReconDraft = null; goBack();
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
        if (amt === null) return fail(`發票 ${c.inv.number} 的分配金額請輸入大於 0 的整數`);
        if (amt > c.remaining) return fail(`發票 ${c.inv.number} 只剩 ${finMoney(c.remaining)} 未核對，分配金額不能更多`);
        allocations.push({ invoiceId, amount: amt });
      }
      const sum = allocations.reduce((s, a) => s + a.amount, 0);
      if (sum > e.amount) return fail(`分配合計 ${finMoney(sum)} 超過這筆流水的金額 ${finMoney(e.amount)}`);
      if (e.type === "income") {
        const clients = [...new Set(allocations.map(a => db.finance.invoices.find(i => i.id === a.invoiceId)?.clientId))];
        if (clients.length > 1) return fail("一筆入帳只能核對同一個客戶的發票");
        if (clients[0]) e.clientId = clients[0];
      }
      e.allocations = allocations; delete e.loanId; delete e.noMatch;
    }
    saveDB(db);
    finReconDraft = null;
    goBack();
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
  db.finance.ledger.filter(e => e.accountId === st.accountId).forEach(e => { const k = `${e.date}|${e.type}|${e.amount}|${finNormRef(e.ref)}`; existing[k] = (existing[k] || 0) + 1; });
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
      db.finance.ledger.push({ id: finId("led"), seq: seq++, accountId: st.accountId, date: p.date, type: p.type, category: p.category || "", amount: p.amount, counterparty: p.counterparty, note: p.note, ref: p.ref, balance: p.balance, source: "import", importBatch: batch, allocations: [] });
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
      if (!l || !confirm(`確定要刪除貸款「${l.name}」嗎？流水帳裡的紀錄不會被刪除，只是不再核對。`)) return;
      db.finance.loans = db.finance.loans.filter(x => x.id !== l.id);
      db.finance.ledger.forEach(e => { if (e.loanId === l.id) delete e.loanId; });
      finSave();
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
