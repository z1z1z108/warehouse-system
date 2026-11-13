// ============================================================
// 發票匯入（發票登錄＝進項、應收帳款＝銷項）：從 Excel／CSV 檔案或直接貼上表格
// 流程：讀入表格 → 自動對應欄位（可手動調整）→ 預覽並檢查 → 勾選匯入 → 可復原這次匯入
// 讀檔、日期、金額解析沿用 finance-bank.js 的 finReadImportFile、finParseCSVText、finParseDateCell、finParseAmountCell
// ============================================================

// 欄位順序也是自動對應的順序：先對應比較特定的（例如「付款日期」「憑證類別」），通用的關鍵字（日期、類別）才不會對錯欄
const FIN_INV_IMPORT_FIELDS = {
  purchase: [
    { key: "voucher", label: "憑證類別", kw: ["憑證類別", "憑證"] },
    { key: "payDate", label: "付款日期", kw: ["付款日期", "付款日"] },
    { key: "expenseNo", label: "支出單號", kw: ["支出單號", "單號", "匯款編號"] },
    { key: "date", label: "發票日期", required: true, kw: ["發票日期", "開立日期", "日期", "date"] },
    { key: "number", label: "發票/收據號碼", kw: ["發票/收據號碼", "發票號碼", "收據號碼", "號碼"] },
    { key: "vendor", label: "開立公司（廠商）", kw: ["開立公司", "廠商", "賣方", "公司"] },
    { key: "category", label: "類別", kw: ["支出項目", "支出類別", "類別"] },
    { key: "item", label: "品項", kw: ["品項", "品名", "明細"] },
    { key: "amount", label: "未稅額", kw: ["未稅", "銷售額", "金額"] },
    { key: "tax", label: "稅額", kw: ["稅額", "營業稅"] },
    { key: "total", label: "含稅額", kw: ["含稅", "總計", "總額", "合計"] },
    { key: "payMethod", label: "付款方式", kw: ["付款方式"] },
    { key: "payee", label: "收款方", kw: ["收款方", "收款人"] },
    { key: "project", label: "專案/工程", kw: ["專案", "工程"] },
    { key: "note", label: "備註", kw: ["備註", "說明"] },
  ],
  sales: [
    { key: "voucher", label: "憑證類別", kw: ["憑證類別", "憑證"] },
    { key: "date", label: "發票日期", required: true, kw: ["發票日期", "開立日期", "日期", "date"] },
    { key: "number", label: "發票號碼", required: true, kw: ["發票號碼", "號碼"] },
    { key: "client", label: "客戶", required: true, kw: ["客戶", "買方", "買受人", "公司"] },
    { key: "item", label: "品項", kw: ["品項", "品名", "明細"] },
    { key: "amount", label: "未稅額", kw: ["未稅", "銷售額", "金額"] },
    { key: "tax", label: "稅額", kw: ["稅額", "營業稅"] },
    { key: "total", label: "含稅額", kw: ["含稅", "總計", "總額", "合計"] },
    { key: "note", label: "備註", kw: ["備註", "說明"] },
  ],
};
const FIN_INV_IMPORT_SYNONYMS = {
  voucher: { "三聯式": "三聯式發票", "二聯式": "二聯式發票", "電子": "電子發票", "統一": "統一發票" },
  payMethod: { "匯款": "轉帳", "ATM": "轉帳", "付現": "現金", "扣款": "自動扣款" },
};

function finInvImportNewState() {
  return { open: false, rows: [], headerRow: 0, map: {}, include: {}, fileName: "", error: "", loading: false, paste: "", done: "", lastBatch: null };
}
const finInvImportStates = { purchase: finInvImportNewState(), sales: finInvImportNewState() };

function finInvImportGuessHeader(rows, mode) {
  const words = FIN_INV_IMPORT_FIELDS[mode].flatMap(f => f.kw);
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const hits = rows[i].filter(c => { const t = String(c).trim().toLowerCase(); return t && words.some(w => t.includes(w.toLowerCase())); }).length;
    if (hits >= 2) return i;
  }
  return 0;
}
// 先找標題完全相同的，再找包含關鍵字的；已對應過的欄不再重複使用
function finInvImportGuessMap(headers, mode) {
  const map = {}, used = new Set();
  const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
  const hs = headers.map(norm);
  FIN_INV_IMPORT_FIELDS[mode].forEach(f => {
    const kws = f.kw.map(norm);
    let idx = hs.findIndex((h, i) => !used.has(i) && kws.includes(h));
    if (idx < 0) idx = hs.findIndex((h, i) => !used.has(i) && h && kws.some(k => h.includes(k)));
    if (idx >= 0) { map[f.key] = idx; used.add(idx); }
  });
  return map;
}
function finInvNormNo(s) { return String(s || "").toUpperCase().replace(/[\s-]/g, ""); }

// 把每一列轉成發票資料，並標出錯誤／警告／重複
function finInvImportParse(st, mode) {
  const rows = st.rows.slice(st.headerRow + 1);
  const get = (r, key) => (st.map[key] === undefined || st.map[key] < 0 ? "" : r[st.map[key]] ?? "");
  const txt = (r, key) => String(get(r, key) ?? "").trim();
  const existing = new Set(db.finance.invoices.filter(i => i.kind === mode && i.number).map(i => `${finInvNormNo(i.number)}|${mode === "purchase" ? i.vendor || "" : ""}`));
  const seen = {};
  return rows.map((r, idx) => {
    const errors = [], warns = [];
    const date = finParseDateCell(get(r, "date"));
    if (!date) errors.push("發票日期無法辨識");
    let amount = finParseAmountCell(get(r, "amount")), tax = finParseAmountCell(get(r, "tax")), total = finParseAmountCell(get(r, "total"));
    if (amount === null && total !== null) {
      if (tax !== null) amount = total - tax;
      else { amount = total; tax = 0; warns.push("只有含稅額，視為未稅額、稅額 0"); }
    }
    if (amount !== null && tax === null) {
      if (total !== null) tax = total - amount;
      else { tax = Math.round(amount * FIN_TAX_RATE); warns.push("稅額依 5% 自動計算"); }
    }
    if (amount === null) errors.push("缺少金額");
    else {
      if ([amount, tax].some(n => !Number.isInteger(n))) { amount = Math.round(amount); tax = Math.round(tax); warns.push("金額有小數，已四捨五入"); }
      if (amount <= 0) errors.push("未稅額要大於 0");
      if (tax < 0) errors.push("稅額不能是負數");
      if (total !== null && Math.round(total) !== amount + tax) errors.push(`未稅 ${finMoney(amount)}＋稅額 ${finMoney(tax)} 不等於含稅 ${finMoney(total)}`);
    }
    const number = txt(r, "number");
    let voucher = txt(r, "voucher");
    voucher = FIN_INV_IMPORT_SYNONYMS.voucher[voucher] || voucher || FIN_VOUCHER_TYPES[0];
    const p = { idx, date, number, voucher, amount, tax, total: amount !== null ? amount + tax : null, item: txt(r, "item"), note: txt(r, "note"), errors, warns };
    if (mode === "purchase") {
      p.vendor = finCanonicalVendor(txt(r, "vendor"));
      p.category = txt(r, "category");
      p.project = txt(r, "project");
      p.payee = txt(r, "payee");
      p.expenseNo = txt(r, "expenseNo");
      let pm = txt(r, "payMethod");
      pm = FIN_INV_IMPORT_SYNONYMS.payMethod[pm] || pm || FIN_PAY_UNPAID;
      p.payMethod = pm;
      const payDateRaw = get(r, "payDate");
      p.payDate = String(payDateRaw ?? "").trim() ? finParseDateCell(payDateRaw) || "" : "";
      if (String(payDateRaw ?? "").trim() && !p.payDate) warns.push("付款日期無法辨識，已留空");
      if (!number) warns.push("沒有發票號碼");
      if (!p.vendor) warns.push("沒有開立公司");
      if (p.category && !FIN_EXPENSE_CATEGORIES.includes(p.category)) warns.push(`類別「${p.category}」不在清單裡`);
      if (!FIN_PAY_METHODS.includes(pm)) warns.push(`付款方式「${pm}」不在選項裡`);
    } else {
      const name = txt(r, "client");
      const short = finShortName(name);
      const client = finClients().find(c => c.name === name) || finClients().find(c => short && (finShortName(c.name).includes(short) || short.includes(finShortName(c.name))));
      p.clientName = name;
      p.clientId = client ? client.id : "";
      if (!name) errors.push("沒有客戶");
      else if (!client) errors.push(`找不到客戶「${name}」，請先到總覽建立`);
      if (!number) errors.push("銷項發票需要發票號碼");
    }
    // 重複：系統裡已有同號碼（進項還要同廠商），或檔案裡前面已出現過
    const key = `${finInvNormNo(number)}|${mode === "purchase" ? p.vendor : ""}`;
    p.duplicate = number ? (existing.has(key) ? "系統裡已有這張發票" : seen[key] ? "檔案裡重複出現" : "") : "";
    if (number) seen[key] = true;
    p.status = errors.length ? "error" : p.duplicate ? "dup" : warns.length ? "warn" : "ok";
    return p;
  }).filter(p => st.rows[st.headerRow + 1 + p.idx].some(c => String(c).trim() !== ""));
}
function finInvImportIncluded(st, p) { return p.status !== "error" && (st.include[p.idx] !== undefined ? st.include[p.idx] : p.status !== "dup"); }

function finRenderInvImport(mode) {
  const st = finInvImportStates[mode];
  const fields = FIN_INV_IMPORT_FIELDS[mode];
  const isSales = mode === "sales";
  const headers = (st.rows[st.headerRow] || []).map(c => String(c).trim());
  const colLabel = i => `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`;
  const parsed = st.rows.length ? finInvImportParse(st, mode) : [];
  const chosen = parsed.filter(p => finInvImportIncluded(st, p));
  const count = s => parsed.filter(p => p.status === s).length;
  const badge = p => ({ ok: `<span class="text-emerald-600">可匯入</span>`, warn: `<span class="text-amber-600">可匯入（有提醒）</span>`, dup: `<span class="text-slate-500">${finEsc(p.duplicate)}</span>`, error: `<span class="text-rose-600">無法匯入</span>` }[p.status]);
  const missingRequired = fields.filter(f => f.required && (st.map[f.key] === undefined || st.map[f.key] < 0));
  return `
  <div class="bg-white rounded-xl shadow-sm ${st.open ? "p-6" : "px-6 py-3"} mb-6">
    <button type="button" id="ii-toggle" class="w-full flex items-center justify-between text-left font-semibold text-sm text-slate-700 ${st.open ? "mb-3" : ""}" aria-expanded="${st.open}">
      <span>⬆ 匯入${isSales ? "銷項" : ""}發票（Excel／CSV／直接貼上）</span>
      <span class="text-xs font-normal text-slate-500">${st.open ? "▾ 收起" : "▸ 展開"}</span>
    </button>
    ${st.lastBatch ? `<div class="flex flex-wrap items-center gap-3 text-sm bg-emerald-50 text-emerald-800 rounded-lg px-3 py-2 ${st.open ? "mb-3" : "mt-2"}"><span>${finEsc(st.lastBatch.label)}</span><button id="ii-undo" class="text-xs text-rose-600 hover:underline">復原這次匯入</button></div>` : ""}
    ${st.open ? `
    <p class="text-xs text-slate-500 mb-3">第一列放標題，系統會依標題自動對應欄位（可在下方調整）。可以對應的欄位：${fields.map(f => f.required ? `<b>${f.label}</b>` : f.label).join("、")}（粗體為必填）。
      <button id="ii-template" class="text-blue-600 hover:underline ml-1">下載範本 CSV</button></p>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
      <div>
        <label class="text-xs text-slate-500">選擇檔案（.xlsx、.xls、.csv）</label>
        <input id="ii-file" type="file" accept=".csv,.txt,.xlsx,.xls" class="w-full text-sm mt-1"/>
        ${st.fileName ? `<p class="text-xs text-slate-500 mt-1">目前：${finEsc(st.fileName)}</p>` : ""}
      </div>
      <div>
        <label class="text-xs text-slate-500">或從 Excel 複製（含標題列）貼在這裡</label>
        <textarea id="ii-paste" rows="3" class="w-full border rounded-lg px-3 py-2 text-xs mt-1 font-mono" placeholder="在 Excel 選取表格 → 複製 → 貼上">${finEsc(st.paste)}</textarea>
        <button id="ii-paste-btn" class="border rounded-lg px-3 py-1 text-xs hover:bg-slate-100 mt-1">讀取貼上的內容</button>
      </div>
    </div>
    ${st.loading ? `<p class="text-sm text-slate-500">讀取中…</p>` : ""}
    ${st.error ? `<p class="text-sm text-rose-600 mb-2">${finEsc(st.error)}</p>` : ""}
    ${st.done ? `<p class="text-sm text-emerald-700 mb-2">${finEsc(st.done)}</p>` : ""}
    ${st.rows.length ? `
      <div class="border rounded-lg p-3 mb-3">
        <div class="flex flex-wrap items-end gap-3 mb-2">
          <div><label class="text-xs text-slate-500">標題在第幾列</label>
            <select id="ii-header" class="block border rounded-lg px-2 py-1 text-sm mt-1">${st.rows.slice(0, 20).map((r, i) => `<option value="${i}" ${i === st.headerRow ? "selected" : ""}>第 ${i + 1} 列：${finEsc(r.filter(c => String(c).trim()).slice(0, 4).join("、").slice(0, 40))}</option>`).join("")}</select></div>
        </div>
        <p class="text-xs text-slate-500 mb-1">欄位對應</p>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
          ${fields.map(f => `
            <div><label class="text-[11px] ${f.required ? "text-slate-700 font-semibold" : "text-slate-500"}">${f.label}${f.required ? "＊" : ""}</label>
              <select data-ii-field="${f.key}" class="ii-map w-full border rounded px-2 py-1 text-xs mt-0.5"><option value="-1">（不使用）</option>${headers.map((h, i) => `<option value="${i}" ${st.map[f.key] === i ? "selected" : ""}>${colLabel(i)}：${finEsc(h || "（空白）")}</option>`).join("")}</select></div>`).join("")}
        </div>
      </div>
      ${missingRequired.length ? `<p class="text-sm text-rose-600 mb-2">請先對應必填欄位：${missingRequired.map(f => f.label).join("、")}</p>` : `
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p class="text-sm text-slate-600">共 ${parsed.length} 列：可匯入 ${count("ok") + count("warn")}（其中有提醒 ${count("warn")}）、重複 ${count("dup")}、無法匯入 ${count("error")}。已勾選 <b>${chosen.length}</b> 筆，含稅合計 <b>${finMoney(chosen.reduce((s, p) => s + (p.total || 0), 0))}</b></p>
        <div class="flex gap-2">
          <button id="ii-cancel" class="border rounded-lg px-3 py-1.5 text-sm hover:bg-slate-100">清除</button>
          <button id="ii-go" class="bg-slate-800 text-white rounded-lg px-4 py-1.5 text-sm font-medium hover:bg-slate-700 ${chosen.length ? "" : "opacity-50"}" ${chosen.length ? "" : "disabled"}>匯入勾選的 ${chosen.length} 筆</button>
        </div>
      </div>
      <div class="border rounded-lg overflow-auto" style="max-height: 50vh">
        <table class="w-full text-xs">
          <thead class="text-slate-600 text-left"><tr class="whitespace-nowrap">${["", "列", "狀態", "日期", "號碼", isSales ? "客戶" : "廠商", ...(isSales ? [] : ["類別"]), "品項", "未稅", "稅額", "含稅", ...(isSales ? [] : ["付款方式"]), "說明"].map((h, i) => `<th class="px-2 py-1.5 sticky top-0 bg-slate-100 ${[8, 9, 10].includes(i + (isSales ? 1 : 0)) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
          <tbody>
            ${parsed.slice(0, 300).map(p => `
              <tr class="border-t ${p.status === "error" ? "bg-rose-50/60" : p.status === "dup" ? "bg-slate-50 text-slate-500" : ""}">
                <td class="px-2 py-1"><input type="checkbox" class="ii-inc" data-idx="${p.idx}" ${finInvImportIncluded(st, p) ? "checked" : ""} ${p.status === "error" ? "disabled" : ""}/></td>
                <td class="px-2 py-1 text-slate-400">${st.headerRow + 2 + p.idx}</td>
                <td class="px-2 py-1 whitespace-nowrap">${badge(p)}</td>
                <td class="px-2 py-1 whitespace-nowrap">${finEsc(p.date || "")}</td>
                <td class="px-2 py-1 font-mono whitespace-nowrap">${finEsc(p.number) || "-"}</td>
                <td class="px-2 py-1">${finEsc(isSales ? p.clientName : p.vendor) || "-"}</td>
                ${isSales ? "" : `<td class="px-2 py-1 whitespace-nowrap">${finEsc(p.category) || "-"}</td>`}
                <td class="px-2 py-1">${finEsc(p.item) || "-"}</td>
                <td class="px-2 py-1 text-right whitespace-nowrap">${p.amount !== null ? finMoney(p.amount) : "-"}</td>
                <td class="px-2 py-1 text-right whitespace-nowrap">${p.tax !== null ? finMoney(p.tax) : "-"}</td>
                <td class="px-2 py-1 text-right whitespace-nowrap font-semibold">${p.total !== null ? finMoney(p.total) : "-"}</td>
                ${isSales ? "" : `<td class="px-2 py-1 whitespace-nowrap">${finEsc(p.payMethod)}</td>`}
                <td class="px-2 py-1 ${p.errors.length ? "text-rose-600" : "text-amber-700"}">${finEsc([...p.errors, ...p.warns].join("；"))}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      ${parsed.length > 300 ? `<p class="text-xs text-slate-400 mt-1">畫面只顯示前 300 列，其餘依同樣規則處理。</p>` : ""}`}
    ` : ""}` : ""}
  </div>`;
}

function finBindInvImport(mode) {
  const st = finInvImportStates[mode];
  const $ = id => document.getElementById(id);
  const isSales = mode === "sales";
  $("ii-toggle").onclick = () => { st.open = !st.open; finRenderKeepScroll(); };
  const load = rows => {
    st.rows = rows;
    st.error = rows.length ? "" : "沒有讀到任何資料";
    st.headerRow = finInvImportGuessHeader(rows, mode);
    st.map = rows.length ? finInvImportGuessMap(rows[st.headerRow].map(c => String(c).trim()), mode) : {};
    st.include = {};
    st.done = "";
  };
  $("ii-undo")?.addEventListener("click", () => {
    const b = st.lastBatch;
    const linkedIds = new Set(db.finance.ledger.flatMap(e => (e.allocations || []).map(a => a.invoiceId)));
    const mine = db.finance.invoices.filter(i => i.importBatch === b.id);
    const removable = mine.filter(i => !linkedIds.has(i.id));
    appConfirm(`確定要復原這次匯入，刪除 ${removable.length} 張發票嗎？${mine.length > removable.length ? `\n其中 ${mine.length - removable.length} 張已經連結流水，會保留。` : ""}`, () => {
      const ids = new Set(removable.map(i => i.id));
      db.finance.invoices = db.finance.invoices.filter(i => !ids.has(i.id));
      st.lastBatch = null;
      st.done = `已復原，刪除 ${ids.size} 張發票。`;
      finSave();
    }, { okLabel: "復原", danger: true });
  });
  if (!st.open) return;
  $("ii-template").onclick = () => {
    const fields = FIN_INV_IMPORT_FIELDS[mode];
    const sample = isSales
      ? { date: todayISO(), number: "AB12345678", client: finClients()[0]?.name || "客戶名稱", item: "工程款", amount: 100000, tax: 5000, total: 105000, voucher: "電子發票", note: "" }
      : { date: todayISO(), number: "FH65914911", vendor: "和運汽車 80542365", category: "租賃車輛租金", item: "RFK-7997 (28/36)", amount: 22762, tax: 1138, total: 23900, voucher: "電子發票", payMethod: "自動扣款", payDate: "", expenseNo: "", payee: "", project: "", note: "" };
    // 範本照一般登錄的順序排，不照自動對應的順序
    const order = isSales ? ["date", "number", "client", "item", "amount", "tax", "total", "voucher", "note"] : ["project", "date", "category", "item", "amount", "tax", "total", "voucher", "number", "payMethod", "payDate", "expenseNo", "payee", "vendor", "note"];
    const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
    finDownloadCSV(isSales ? "銷項發票匯入範本" : "進項發票匯入範本", [order.map(k => byKey[k].label), order.map(k => sample[k] ?? "")]);
  };
  $("ii-file").onchange = async () => {
    const file = $("ii-file").files[0];
    if (!file) return;
    st.loading = true; st.error = ""; st.fileName = file.name; st.paste = ""; finRenderKeepScroll();
    try { load(await finReadImportFile(file)); }
    catch (err) { st.rows = []; st.error = `讀取失敗：${err.message}`; }
    st.loading = false;
    finRenderKeepScroll();
  };
  $("ii-paste").oninput = () => { st.paste = $("ii-paste").value; };
  $("ii-paste-btn").onclick = () => {
    st.paste = $("ii-paste").value;
    if (!st.paste.trim()) { st.error = "請先貼上表格內容"; return finRenderKeepScroll(); }
    st.fileName = "";
    load(finParseCSVText(st.paste));
    finRenderKeepScroll();
  };
  $("ii-header")?.addEventListener("change", () => {
    st.headerRow = Number($("ii-header").value);
    st.map = finInvImportGuessMap(st.rows[st.headerRow].map(c => String(c).trim()), mode);
    st.include = {};
    finRenderKeepScroll();
  });
  document.querySelectorAll(".ii-map").forEach(sel => {
    sel.onchange = () => {
      const v = Number(sel.value);
      // 同一欄只能對應一個欄位：選了別的欄位已在用的，原本那個改成不使用
      Object.keys(st.map).forEach(k => { if (st.map[k] === v && k !== sel.dataset.iiField) delete st.map[k]; });
      if (v < 0) delete st.map[sel.dataset.iiField]; else st.map[sel.dataset.iiField] = v;
      st.include = {};
      finRenderKeepScroll();
    };
  });
  document.querySelectorAll(".ii-inc").forEach(cb => { cb.onchange = () => { st.include[cb.dataset.idx] = cb.checked; finRenderKeepScroll(); }; });
  $("ii-cancel")?.addEventListener("click", () => { Object.assign(st, { rows: [], map: {}, include: {}, fileName: "", paste: "", error: "", done: "" }); finRenderKeepScroll(); });
  $("ii-go")?.addEventListener("click", () => {
    const chosen = finInvImportParse(st, mode).filter(p => finInvImportIncluded(st, p));
    if (!chosen.length) return;
    const batch = finId("ivb");
    chosen.forEach(p => {
      const base = {
        id: finId("inv"), kind: mode, date: p.date, number: p.number, taxType: p.tax > 0 ? "taxable" : "zero",
        items: p.item ? [{ name: p.item, qty: 1, price: p.amount, amount: p.amount }] : [],
        amount: p.amount, tax: p.tax, total: p.amount + p.tax, note: p.note, voucherType: p.voucher, importBatch: batch,
      };
      if (isSales) Object.assign(base, { clientId: p.clientId, vendor: "", category: "", project: "", payee: "", payMethod: "", payDate: "", expenseNo: "" });
      else {
        Object.assign(base, { clientId: "", vendor: p.vendor, category: p.category, project: p.project, payee: p.payee, payMethod: p.payMethod, payDate: p.payDate, expenseNo: p.expenseNo });
        if (p.vendor) finRememberVendor(p.vendor);
      }
      db.finance.invoices.push(base);
    });
    const total = chosen.reduce((s, p) => s + p.amount + p.tax, 0);
    st.lastBatch = { id: batch, label: `已匯入 ${chosen.length} 張${isSales ? "銷項" : ""}發票，含稅合計 ${finMoney(total)}（${todayISO()}）` };
    Object.assign(st, { rows: [], map: {}, include: {}, fileName: "", paste: "", error: "", done: "" });
    finSave();
  });
}

// ============================================================
// 從公司原本的帳戶紀錄貼上（一筆匯款付很多張發票）
// ============================================================
// 每列：匯款編號、日期、類別、收款方、品項、單號、發票號碼、金額（欄位解析跟拆分頁的貼上共用 finParseSplitPaste）。
// 每一列登錄成一張進項發票，支出單號填匯款編號 → 存檔時自動連到那筆流水（data.js autoLinkByExpenseNo），不用拆分。
// 「手續費」列不登錄成發票，加到流水的手續費欄：
//   - 流水金額 = 這筆匯款全部列的合計（金額含手續費）→ 流水金額扣掉手續費，手續費另外記
//   - 流水金額 = 扣掉手續費後的合計 → 只記手續費
//   - 其他情況（流水還沒建、已經有手續費、金額對不上）→ 手續費也登錄成發票（類別「手續費」），不動流水
let finAcctPaste = { open: false, text: "", year: String(new Date().getFullYear()), rows: null, msg: "", last: null };

function finAcctPastePlan(rows) {
  const norm = s => String(s || "").toUpperCase().replace(/[\s-]/g, "");
  const groups = [];
  rows.forEach(r => {
    let g = groups.find(x => x.no === r.entryNo);
    if (!g) groups.push(g = { no: r.entryNo, rows: [] });
    g.rows.push(r);
  });
  const existingByNo = {};
  db.finance.invoices.filter(i => i.kind === "purchase" && i.number).forEach(i => { existingByNo[norm(i.number)] = i; });
  const linkedIds = new Set(finLedgerLinks(db.finance).map(l => l.invoiceId));
  groups.forEach(g => {
    g.entry = g.no ? db.finance.ledger.find(e => (e.no || "").toUpperCase() === g.no) : null;
    const amt = r => Number(r.amount) || 0;
    g.total = g.rows.reduce((s, r) => s + amt(r), 0);
    g.feeSum = g.rows.filter(r => r.isFee).reduce((s, r) => s + amt(r), 0);
    const e = g.entry;
    g.feeMode = !g.feeSum ? "" : e && !e.fee && e.type === "expense" && e.amount === g.total ? "includes"
      : e && !e.fee && e.type === "expense" && e.amount === g.total - g.feeSum ? "feeOnly" : "invoice";
    g.rows.forEach(r => {
      if (r.isFee && g.feeMode !== "invoice") { r.action = "fee"; return; }
      const same = r.number && existingByNo[norm(r.number)];
      if (same) {
        r.existing = same;
        const sameNo = g.no && String(same.expenseNo || "").toUpperCase().split(/[、,\s]+/).includes(g.no);
        r.action = sameNo ? "sameNo" : !same.expenseNo && !linkedIds.has(same.id) && g.no ? "fillNo" : "skip";
        return;
      }
      // 沒有號碼的（收據、其他）用支出單號＋日期＋品項＋金額判斷是不是已經貼過
      const dup = !r.number && g.no && db.finance.invoices.some(i => i.kind === "purchase" && (i.expenseNo || "").toUpperCase().includes(g.no) && i.total === amt(r) && i.date === r.date && ((i.items || [])[0]?.name || "") === r.item);
      r.action = dup ? "dup" : "new";
    });
  });
  return groups;
}
function finRenderAcctPaste() {
  const st = finAcctPaste;
  const plan = st.rows ? finAcctPastePlan(st.rows) : [];
  const actionLabel = { new: `<span class="text-emerald-700">登錄發票</span>`, fee: `<span class="text-sky-700">記到流水手續費</span>`, fillNo: `<span class="text-emerald-700">已登錄，補上支出單號</span>`, sameNo: `<span class="text-slate-500">已登錄（支出單號相同，一起連結）</span>`, skip: `<span class="text-slate-400">已登錄，略過</span>`, dup: `<span class="text-slate-400">可能重複，略過</span>` };
  const groupNote = g => {
    const e = g.entry;
    const head = g.no ? `<b class="font-mono">${finEsc(g.no)}</b>` : `<b>（沒有匯款編號）</b>`;
    const link = !g.no ? "只登錄發票，不連結流水" : e ? `會自動連到流水 ${finEsc(e.no)}（${finEsc(e.date)}，金額 ${finMoney(e.amount)}）` : `流水帳還沒有 ${finEsc(g.no)}，發票先登錄，之後新增或匯入這筆流水時自動連結`;
    const fee = g.feeMode === "includes" ? `；手續費 ${finMoney(g.feeSum)} 記到流水手續費欄，流水金額改為 ${finMoney(e.amount - g.feeSum)}`
      : g.feeMode === "feeOnly" ? `；手續費 ${finMoney(g.feeSum)} 記到流水手續費欄`
      : g.feeSum ? `；手續費 ${finMoney(g.feeSum)} 登錄成發票（類別「手續費」）${e && e.fee ? "，因為流水已經有手續費" : e ? "，因為流水金額對不上" : ""}` : "";
    const diff = e && g.feeMode !== "includes" ? e.amount - (g.total - (g.feeMode === "feeOnly" ? g.feeSum : 0)) : 0;
    return `<p class="text-sm mt-3 mb-1">${head}：${g.rows.length} 列，合計 ${finMoney(g.total)}。${link}${fee}${diff ? `<span class="text-amber-600">（和流水金額差 ${finMoney(diff)}）</span>` : ""}${e && g.rows[0].date && e.date !== g.rows[0].date ? `<span class="text-amber-600">（流水日期 ${finEsc(e.date)} 和紀錄日期 ${finEsc(g.rows[0].date)} 不同，請確認編號是同一筆）</span>` : ""}</p>`;
  };
  return `
  <div class="bg-white rounded-xl shadow-sm ${st.open ? "p-6" : "px-6 py-3"} mb-6">
    <button type="button" id="ap-toggle" class="w-full flex items-center justify-between text-left font-semibold text-sm text-slate-700" aria-expanded="${st.open}">
      <span>📋 從帳戶紀錄貼上（一筆匯款付很多張發票）</span>
      <span class="text-xs font-normal text-slate-500">${st.open ? "▾ 收起" : "▸ 展開"}</span>
    </button>
    ${st.last ? `<div class="flex flex-wrap items-center gap-3 text-sm bg-slate-50 text-slate-700 border rounded-lg px-3 py-2 mt-3"><span>${finEsc(st.last.label)}</span><button id="ap-undo" class="text-xs text-rose-600 hover:underline">復原這次貼上</button></div>` : ""}
    ${!st.open ? "" : `
    <p class="text-xs text-slate-500 mt-3">在 Excel 選取帳戶紀錄（匯款編號、日期、類別、收款方、品項、單號、發票號碼、金額）複製後貼上，可以一次貼很多筆匯款。
      每一列登錄成一張發票，支出單號填匯款編號，<b>自動連到那筆流水，不用拆分</b>。編號、日期、收款方空白的列沿用上一列。</p>
    <div class="flex flex-wrap items-end gap-3 mt-3">
      <label class="text-xs text-slate-500">日期年份（帳戶紀錄只寫月日時用）
        <input id="ap-year" type="number" min="2000" max="2100" value="${finEsc(st.year)}" class="block border rounded-lg px-3 py-1.5 text-sm mt-1 w-28"/>
      </label>
    </div>
    <textarea id="ap-text" rows="5" class="w-full border rounded-lg px-3 py-2 text-xs font-mono mt-3" placeholder="在這裡貼上（Ctrl+V）">${finEsc(st.text)}</textarea>
    <div class="flex items-center gap-3 mt-2">
      <button type="button" id="ap-preview" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">預覽</button>
      ${st.msg ? `<span class="text-xs text-rose-600">${finEsc(st.msg)}</span>` : ""}
    </div>
    ${plan.length ? `
    ${plan.map(g => `${groupNote(g)}
    <div class="overflow-x-auto border rounded-lg">
      <table class="grid-table w-full text-sm">
        <thead class="bg-slate-100 text-slate-600 text-left"><tr>
          <th class="px-3 py-1.5">日期</th><th class="px-3 py-1.5">類別</th><th class="px-3 py-1.5">收款方</th><th class="px-3 py-1.5">品項</th><th class="px-3 py-1.5">憑證</th><th class="px-3 py-1.5">發票號碼</th><th class="px-3 py-1.5 text-right">含稅總額</th><th class="px-3 py-1.5">備註</th><th class="px-3 py-1.5">處理方式</th>
        </tr></thead>
        <tbody>${g.rows.map((r, n) => `
          <tr class="data-row ${n % 2 ? "row-alt" : ""}">
            <td class="px-3 py-1.5 whitespace-nowrap text-slate-500">${finEsc(r.date)}</td>
            <td class="px-3 py-1.5 whitespace-nowrap">${finEsc(r.category) || `<span class="text-amber-600">未分類</span>`}</td>
            <td class="px-3 py-1.5">${finEsc(r.payee)}</td>
            <td class="px-3 py-1.5">${finEsc(r.item)}</td>
            <td class="px-3 py-1.5 whitespace-nowrap">${finEsc(r.voucherType)}</td>
            <td class="px-3 py-1.5 font-mono whitespace-nowrap">${finEsc(r.number)}</td>
            <td class="px-3 py-1.5 text-right whitespace-nowrap">${finMoney(Number(r.amount))}</td>
            <td class="px-3 py-1.5 text-slate-500">${finEsc(r.note)}</td>
            <td class="px-3 py-1.5 whitespace-nowrap">${actionLabel[r.action]}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`).join("")}
    <div class="flex items-center gap-2 mt-4">
      <button type="button" id="ap-go" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">確認登錄</button>
      <button type="button" id="ap-cancel" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100">取消</button>
    </div>` : ""}`}
  </div>`;
}
function finBindAcctPaste() {
  const st = finAcctPaste;
  const $ = id => document.getElementById(id);
  if (!$("ap-toggle")) return;
  $("ap-toggle").onclick = () => { st.open = !st.open; finRenderKeepScroll(); };
  $("ap-text")?.addEventListener("input", () => { st.text = $("ap-text").value; });
  $("ap-year")?.addEventListener("input", () => { st.year = $("ap-year").value; });
  $("ap-preview")?.addEventListener("click", () => {
    st.text = $("ap-text").value;
    const year = /^\d{4}$/.test(st.year) ? st.year : String(new Date().getFullYear());
    const { rows } = finParseSplitPaste(st.text, { year, date: "" });
    st.rows = rows.length ? rows : null;
    st.msg = rows.length ? "" : "沒有讀到含金額的明細列，請確認複製的範圍";
    finRenderKeepScroll();
  });
  $("ap-cancel")?.addEventListener("click", () => { Object.assign(st, { text: "", rows: null, msg: "" }); finRenderKeepScroll(); });
  $("ap-go")?.addEventListener("click", () => {
    const plan = finAcctPastePlan(st.rows || []);
    const batch = finId("apb");
    const undo = { batch, filled: [], fees: [] };
    let created = 0, filled = 0, feeTotal = 0;
    plan.forEach(g => {
      g.rows.forEach(r => {
        if (r.action === "fillNo") { r.existing.expenseNo = g.no; undo.filled.push(r.existing.id); filled++; return; }
        if (r.action !== "new") return;
        const net = Number(r.net) || 0, tax = Number(r.tax) || 0;
        db.finance.invoices.push({
          id: finId("inv"), kind: "purchase", date: r.date || todayISO(), number: r.number, voucherType: r.voucherType,
          taxType: tax > 0 || finSplitIsTaxed(r.voucherType) ? "taxable" : "zero",
          items: r.item ? [{ name: r.item, qty: 1, price: net, amount: net }] : [],
          amount: net, tax, total: net + tax, note: r.note, clientId: "", vendor: "", category: r.category, project: "",
          payee: r.payee, payMethod: FIN_PAY_UNPAID, payDate: "", expenseNo: g.no, importBatch: batch,
        });
        created++;
      });
      if (g.feeMode === "includes" || g.feeMode === "feeOnly") {
        undo.fees.push({ entryId: g.entry.id, amount: g.entry.amount, fee: g.entry.fee || 0 });
        if (g.feeMode === "includes") g.entry.amount -= g.feeSum;
        g.entry.fee = g.feeSum;
        feeTotal += g.feeSum;
      }
    });
    saveDB(db);   // 存檔時依支出單號自動連到流水
    const ids = new Set(db.finance.invoices.filter(i => i.importBatch === batch).map(i => i.id).concat(undo.filled));
    const linkedNow = new Set(finLedgerLinks(db.finance).filter(l => ids.has(l.invoiceId)).map(l => l.invoiceId)).size;
    st.last = { ...undo, label: `已登錄 ${created} 張發票${filled ? `、補上 ${filled} 張的支出單號` : ""}${feeTotal ? `、手續費 ${finMoney(feeTotal)} 記到流水` : ""}；其中 ${linkedNow} 張已自動連到流水（${todayISO()}）` };
    Object.assign(st, { text: "", rows: null, msg: "" });
    render();
  });
  $("ap-undo")?.addEventListener("click", () => {
    const u = st.last;
    appConfirm("確定要復原這次貼上嗎？這次登錄的發票會刪除（連同和流水的連結），補上的支出單號會清掉，手續費改回原本。", () => {
      const ids = new Set(db.finance.invoices.filter(i => i.importBatch === u.batch).map(i => i.id));
      const touched = new Set([...ids, ...u.filled]);
      db.finance.ledger.forEach(e => { if ((e.allocations || []).some(a => touched.has(a.invoiceId))) e.allocations = e.allocations.filter(a => !touched.has(a.invoiceId)); });
      db.finance.invoices = db.finance.invoices.filter(i => !ids.has(i.id));
      u.filled.forEach(id => {
        const inv = db.finance.invoices.find(i => i.id === id);
        if (!inv) return;
        inv.expenseNo = "";
        delete inv.autoLinkedEntry; delete inv.autoLinkSkip;
        if (inv.prePay) inv.prePay.expenseNo = "";
      });
      u.fees.forEach(f => { const e = db.finance.ledger.find(x => x.id === f.entryId); if (e) { e.amount = f.amount; e.fee = f.fee; } });
      st.last = null;
      finSave();
    }, { okLabel: "復原", danger: true });
  });
}
