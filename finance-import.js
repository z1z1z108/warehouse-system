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
