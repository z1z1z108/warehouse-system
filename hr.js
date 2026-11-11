// ============================================================
// 人事管理（僅震浤管理員）— 員工入職資料、請假紀錄與統計、特休自動計算、例假日／補休、工安證照
//
// 資料放在 db.hr：
//   employees : [{ id, no, name, dept, title, hireDate, leaveDate, phone, note }]
//   leaves    : [{ id, employeeId, type, start, end, days, hours, reason }]   天數和時數分開記；特休剩餘以 1 天 = 8 小時換算
//   compDays  : [{ id, employeeId, overtimeDate, offDate, days, note }]   例假日／補休；offDate 空白 = 還沒排休
//   certs     : [{ id, employeeId, name, certNo, issueDate, expiryDate, note }]
//
// 使用 finance.js 的 canUseFinance、finEsc、finId、finSave，和 app.js 的 db、view、navigateTo、render、showMsg、todayISO
// ============================================================

let hrMenuOpen = false;
const HR_PAGES = [
  { page: "hr-employees", icon: "🧑‍💼", label: "員工資料" },
  { page: "hr-leaves", icon: "🗓", label: "請假紀錄" },
  { page: "hr-comp", icon: "🔁", label: "例假日／補休" },
  { page: "hr-certs", icon: "🦺", label: "工安證照" },
];
// 補休另外記在「例假日／補休」，這裡不列
const HR_LEAVE_TYPES = ["特休", "事假", "病假", "婚假", "喪假", "公假", "公傷病假", "產假", "陪產檢及陪產假", "生理假", "家庭照顧假", "其他"];
const HR_CERT_NAMES = [
  "一般安全衛生教育訓練", "營造業甲種職業安全衛生業務主管", "乙種職業安全衛生業務主管", "丙種職業安全衛生業務主管",
  "職業安全衛生管理員", "急救人員", "高空工作車操作人員", "移動式起重機操作人員", "固定式起重機操作人員",
  "堆高機操作人員", "施工架組配作業主管", "屋頂作業主管", "缺氧作業主管", "有機溶劑作業主管",
  "低壓電氣作業人員", "高壓電氣作業人員", "電匠", "甲級電匠",
];
const HR_SOON_DAYS = 30;   // 證照到期前幾天提醒

// 各表單的編輯對象與填到一半的內容（切換篩選重畫時才不會清掉）
const hrEdit = { employee: "", leave: "", comp: "", cert: "" };
const hrDrafts = { employee: {}, leave: {}, comp: {}, cert: {} };
let hrFilter = { showLeft: false, year: new Date().getFullYear(), employeeId: "", leaveType: "", compStatus: "", certStatus: "" };

// ---------- 日期工具 ----------
function hrParse(iso) { const [y, m, d] = String(iso || "").split("-").map(Number); return { y, m, d }; }
function hrDaysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }   // m：1~12
function hrIso(y, m, d) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
function hrAddMonths(iso, n) {
  const { y, m, d } = hrParse(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return hrIso(ny, nm, Math.min(d, hrDaysInMonth(ny, nm)));
}
// 從到職日到 asOf 滿幾個月
function hrMonthsBetween(from, asOf) {
  const a = hrParse(from), b = hrParse(asOf);
  let k = (b.y - a.y) * 12 + (b.m - a.m);
  if (hrAddMonths(from, k) > asOf) k--;
  return Math.max(0, k);
}
function hrDayDiff(a, b) {
  const p = hrParse(a), q = hrParse(b);
  return Math.round((Date.UTC(q.y, q.m - 1, q.d) - Date.UTC(p.y, p.m - 1, p.d)) / 86400000);
}
// 期間內的週一到週五天數（請假天數的預設值，可再手動修改）
function hrWeekdays(start, end) {
  if (!start || !end || end < start) return 0;
  const s = hrParse(start);
  let n = 0;
  for (let i = 0; i <= hrDayDiff(start, end); i++) {
    const day = new Date(Date.UTC(s.y, s.m - 1, s.d + i)).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}
function hrNum(n) { return Number(n || 0).toLocaleString("zh-TW", { maximumFractionDigits: 1 }); }
const HR_HOURS_PER_DAY = 8;
// 「2 天 3 小時」：有時數才顯示小時；都沒有顯示「-」
function hrDH(days, hours) {
  const parts = [];
  if (Number(days)) parts.push(`${hrNum(days)} 天`);
  if (Number(hours)) parts.push(`${hrNum(hours)} 小時`);
  return parts.join(" ") || "-";
}
// 以天為單位的數字（例如 13.625 天）換成「13 天 5 小時」，用在特休剩餘
function hrDaysToDH(x) {
  const sign = x < 0 ? "−" : "";
  const totalHours = Math.round(Math.abs(x) * HR_HOURS_PER_DAY * 2) / 2;
  const d = Math.floor(totalHours / HR_HOURS_PER_DAY), h = totalHours - d * HR_HOURS_PER_DAY;
  return totalHours ? sign + hrDH(d, h) : "0";
}
function hrLeaveDayEquiv(l) { return Number(l.days || 0) + Number(l.hours || 0) / HR_HOURS_PER_DAY; }
// 某人某年各假別的天數、時數（分開加總）
function hrYearLeaveTotals(empId, year) {
  const y = String(year);
  const totals = {};
  db.hr.leaves.filter(l => l.employeeId === empId && (l.start || "").startsWith(y)).forEach(l => {
    const t = totals[l.type] = totals[l.type] || { days: 0, hours: 0 };
    t.days += Number(l.days || 0);
    t.hours += Number(l.hours || 0);
  });
  return totals;
}
// 個人未補休：因加班累積、但還沒排休的天數（不分年度）
function hrCompPending(empId) {
  return db.hr.compDays.filter(c => c.employeeId === empId && !c.offDate).reduce((s, c) => s + Number(c.days || 0), 0);
}
function hrYearCompDays(empId, year) {
  return db.hr.compDays.filter(c => c.employeeId === empId && (c.offDate || "").startsWith(String(year))).reduce((s, c) => s + Number(c.days || 0), 0);
}

// ---------- 特休（勞動基準法第 38 條，週年制） ----------
// 滿 6 個月未滿 1 年：3 日；1 年：7 日；2 年：10 日；3、4 年：14 日；5～9 年：15 日；10 年起每年加 1 日，最多 30 日
function hrAnnualDaysForYears(y) {
  if (y <= 0) return 0;
  if (y === 1) return 7;
  if (y === 2) return 10;
  if (y <= 4) return 14;
  if (y <= 9) return 15;
  return Math.min(30, 15 + (y - 9));
}
// 回傳本期特休：天數、期間（start～end 前一天）、年資
function hrAnnualLeave(emp, asOf = todayISO()) {
  const hire = emp.hireDate;
  if (!hire || hire > asOf) return { days: 0, start: "", end: "", months: 0, note: hire ? "尚未到職" : "未填到職日" };
  const k = hrMonthsBetween(hire, asOf);
  if (k < 6) return { days: 0, start: "", end: hrAddMonths(hire, 6), months: k, note: "未滿 6 個月" };
  if (k < 12) return { days: 3, start: hrAddMonths(hire, 6), end: hrAddMonths(hire, 12), months: k, note: "" };
  const y = Math.floor(k / 12);
  return { days: hrAnnualDaysForYears(y), start: hrAddMonths(hire, 12 * y), end: hrAddMonths(hire, 12 * (y + 1)), months: k, note: "" };
}
function hrSeniority(months) { return `${Math.floor(months / 12)} 年 ${months % 12} 個月`; }
function hrAnnualUsed(empId, start, end) {
  if (!start) return 0;
  return db.hr.leaves.filter(l => l.employeeId === empId && l.type === "特休" && l.start >= start && l.start < end).reduce((s, l) => s + hrLeaveDayEquiv(l), 0);
}
function hrAnnualSummary(emp) {
  const a = hrAnnualLeave(emp);
  const used = hrAnnualUsed(emp.id, a.start, a.end);
  return { ...a, used, remaining: a.days - used };
}
// 特休期間的最後一天（下一期開始日的前一天）
function hrLastDay(end) {
  if (!end) return "";
  const { y, m, d } = hrParse(end);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return hrIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// ---------- 證照狀態 ----------
function hrCertStatus(c) {
  if (!c.expiryDate) return { code: "none", label: "無期限", cls: "bg-slate-100 text-slate-600", days: null };
  const days = hrDayDiff(todayISO(), c.expiryDate);
  if (days < 0) return { code: "expired", label: `已過期 ${-days} 天`, cls: "bg-rose-100 text-rose-700", days };
  if (days <= HR_SOON_DAYS) return { code: "soon", label: `${days} 天後到期`, cls: "bg-amber-100 text-amber-700", days };
  return { code: "valid", label: "有效", cls: "bg-emerald-100 text-emerald-700", days };
}
function hrCertAlerts() {
  const active = new Set(hrActiveEmployees().map(e => e.id));
  const list = db.hr.certs.filter(c => active.has(c.employeeId)).map(hrCertStatus);
  return { expired: list.filter(s => s.code === "expired").length, soon: list.filter(s => s.code === "soon").length };
}

// ---------- 員工 ----------
function hrIsActive(e) { return !e.leaveDate || e.leaveDate > todayISO(); }
function hrActiveEmployees() { return db.hr.employees.filter(hrIsActive).sort((a, b) => (a.no || "").localeCompare(b.no || "") || a.name.localeCompare(b.name, "zh-Hant")); }
function hrEmpName(id) { const e = db.hr.employees.find(x => x.id === id); return e ? e.name : "（已刪除員工）"; }
// 員工下拉：在職員工；編輯舊紀錄時，原本那位員工就算已離職也要列出
function hrEmployeeOptions(selected, blankLabel = "請選擇員工") {
  const list = hrActiveEmployees();
  const extra = selected && !list.some(e => e.id === selected) ? db.hr.employees.filter(e => e.id === selected) : [];
  return `<option value="">${blankLabel}</option>` + [...list, ...extra].map(e => `<option value="${finEsc(e.id)}" ${e.id === selected ? "selected" : ""}>${finEsc([e.no, e.name].filter(Boolean).join(" "))}${hrIsActive(e) ? "" : "（離職）"}</option>`).join("");
}

// ---------- 表單共用 ----------
function hrRecord(form) {
  const list = { employee: db.hr.employees, leave: db.hr.leaves, comp: db.hr.compDays, cert: db.hr.certs }[form];
  return list.find(r => r.id === hrEdit[form]) || null;
}
function hrVal(form, key, fallback = "") {
  const d = hrDrafts[form];
  if (key in d) return d[key];
  const r = hrRecord(form);
  return r && r[key] != null ? r[key] : fallback;
}
function hrResetForm(form) { hrEdit[form] = ""; hrDrafts[form] = {}; }
function hrFormButtons(form, addLabel) {
  const editing = !!hrRecord(form);
  return `
    <button data-hr-save="${form}" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">${editing ? "儲存變更" : addLabel}</button>
    ${editing ? `<button data-hr-cancel="${form}" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 ml-2">取消編輯</button>` : ""}
    <p id="hr-msg-${form}" class="text-xs hidden mt-2"></p>`;
}
// 欄位輸入時記到草稿
function hrBindDrafts() {
  document.querySelectorAll("[data-hr-form]").forEach(el => {
    const handler = () => { hrDrafts[el.dataset.hrForm][el.dataset.hrKey] = el.type === "checkbox" ? el.checked : el.value; };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  });
  document.querySelectorAll("[data-hr-cancel]").forEach(b => { b.onclick = () => { hrResetForm(b.dataset.hrCancel); render(); }; });
}
function hrStartEdit(form, id) {
  hrEdit[form] = id;
  hrDrafts[form] = {};
  render();
  document.querySelector(`[data-hr-save="${form}"]`)?.closest(".bg-white")?.scrollIntoView({ block: "start" });
}
const hrInput = (form, key, attrs = "") => `<input data-hr-form="${form}" data-hr-key="${key}" value="${finEsc(hrVal(form, key))}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" ${attrs}/>`;
const hrCard = (title, body, editing) => `<div class="bg-white rounded-xl shadow-sm p-6 mb-6 ${editing ? "ring-2 ring-amber-300" : ""}"><p class="font-semibold text-sm text-slate-700 mb-3">${title}</p>${body}</div>`;
const hrLabel = t => `<label class="text-xs text-slate-500">${t}</label>`;
const HR_TH = "px-3 py-2 whitespace-nowrap";
const HR_TD = "px-3 py-2";

// ---------- 側邊導覽 ----------
function renderHrNav() {
  if (!canUseFinance()) return "";
  if (view.page.startsWith("hr-")) hrMenuOpen = true;
  const alerts = hrCertAlerts();
  const badge = alerts.expired + alerts.soon;
  return `
  <div>
    <button id="hr-toggle-btn" class="w-full text-left px-3 py-2 rounded hover:bg-slate-700 flex items-center justify-between">
      <span>👥 人事管理${badge ? ` <span class="ml-1 px-1.5 rounded-full text-[10px] bg-rose-500 text-white" title="工安證照過期或即將到期">${badge}</span>` : ""}</span><span class="text-xs">${hrMenuOpen ? "▾" : "▸"}</span>
    </button>
    ${hrMenuOpen ? HR_PAGES.map(p => `
      <button data-nav="${p.page}" class="nav-btn w-full text-left pl-8 pr-3 py-2 rounded hover:bg-slate-700 ${view.page === p.page ? "bg-slate-700" : ""}">${p.icon} ${p.label}</button>`).join("") : ""}
  </div>`;
}
function bindHrNav() {
  document.getElementById("hr-toggle-btn")?.addEventListener("click", () => { hrMenuOpen = !hrMenuOpen; render(); });
}
function hrTitle() {
  if (!canUseFinance()) return "人事管理";
  return { "hr-employees": "員工資料（入職管理）", "hr-leaves": "請假紀錄與統計", "hr-comp": "例假日／補休", "hr-certs": "工安證照" }[view.page] || "人事管理";
}
function renderHrPage() {
  if (!canUseFinance()) return `<div class="bg-white rounded-xl shadow-sm p-6 text-sm text-slate-500">人事管理僅限震浤管理員使用。</div>`;
  switch (view.page) {
    case "hr-employees": return hrRenderEmployees();
    case "hr-leaves": return hrRenderLeaves();
    case "hr-comp": return hrRenderComp();
    case "hr-certs": return hrRenderCerts();
    default: return "";
  }
}
function bindHrPage() {
  if (!canUseFinance()) return;
  hrBindDrafts();
  switch (view.page) {
    case "hr-employees": return hrBindEmployees();
    case "hr-leaves": return hrBindLeaves();
    case "hr-comp": return hrBindComp();
    case "hr-certs": return hrBindCerts();
  }
}

// ============================================================
// 員工資料
// ============================================================
function hrRenderEmployees() {
  const editing = hrRecord("employee");
  const list = db.hr.employees.filter(e => hrFilter.showLeft || hrIsActive(e)).sort((a, b) => (a.no || "").localeCompare(b.no || "") || a.name.localeCompare(b.name, "zh-Hant"));
  const certCount = id => {
    const s = db.hr.certs.filter(c => c.employeeId === id).map(hrCertStatus);
    return { total: s.length, expired: s.filter(x => x.code === "expired").length, soon: s.filter(x => x.code === "soon").length };
  };
  const form = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      <div>${hrLabel("員工編號（選填）")}${hrInput("employee", "no")}</div>
      <div>${hrLabel("姓名")}${hrInput("employee", "name")}</div>
      <div>${hrLabel("部門（選填）")}${hrInput("employee", "dept")}</div>
      <div>${hrLabel("職稱（選填）")}${hrInput("employee", "title")}</div>
      <div>${hrLabel("到職日")}${hrInput("employee", "hireDate", 'type="date"')}</div>
      <div>${hrLabel("離職日（在職留空）")}${hrInput("employee", "leaveDate", 'type="date"')}</div>
      <div>${hrLabel("電話（選填）")}${hrInput("employee", "phone")}</div>
      <div>${hrLabel("備註（選填）")}${hrInput("employee", "note")}</div>
    </div>
    ${hrFormButtons("employee", "新增員工")}`;
  return `
  ${hrCard(editing ? `編輯員工：${finEsc(editing.name)}` : "新增員工（入職）", form, editing)}
  <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
    <p class="text-sm text-slate-500">在職 ${hrActiveEmployees().length} 人。特休依勞動基準法第 38 條，以到職日起算（週年制）；特休剩餘以 1 天 = ${HR_HOURS_PER_DAY} 小時換算。</p>
    <div class="flex items-center gap-3">
      <label class="text-sm text-slate-600">請假統計年度 <select id="hr-emp-year" class="border rounded-lg px-2 py-1 text-sm ml-1">${hrYearOptions()}</select></label>
      <label class="flex items-center gap-1.5 text-sm text-slate-600"><input id="hr-show-left" type="checkbox" ${hrFilter.showLeft ? "checked" : ""}/> 顯示離職員工</label>
    </div>
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="${HR_TH}">員工編號</th><th class="${HR_TH}">姓名</th><th class="${HR_TH}">部門／職稱</th><th class="${HR_TH}">到職日</th><th class="${HR_TH}">年資</th><th class="${HR_TH} text-right">本期特休</th><th class="${HR_TH}">特休期間</th><th class="${HR_TH} text-right">已休</th><th class="${HR_TH} text-right" title="本期特休還沒休的天數">未休</th><th class="${HR_TH} text-right" title="因加班累積、還沒排休的例假日／補休（不分年度）">未補休</th><th class="${HR_TH} text-right" title="本期未休特休 ＋ 未補休">剩餘天數<div class="text-[11px] font-normal text-slate-400">（特休＋補休）</div></th><th class="${HR_TH}" style="min-width: 9rem">${hrFilter.year} 年請假（假別）</th><th class="${HR_TH} text-right">${hrFilter.year} 年合計</th><th class="${HR_TH}">工安證照</th><th class="${HR_TH}">狀態</th><th class="${HR_TH} sticky right-0 bg-slate-100"></th></tr>
      </thead>
      <tbody>
        ${list.map(e => {
          const active = hrIsActive(e);
          const a = hrAnnualSummary(e);
          const cc = certCount(e.id);
          // 該年度各假別天數／時數（依假別清單順序），加上例假日／補休
          const totals = hrYearLeaveTotals(e.id, hrFilter.year);
          const comp = hrYearCompDays(e.id, hrFilter.year);
          const typeLines = HR_LEAVE_TYPES.filter(t => totals[t]).map(t => `<div class="whitespace-nowrap">${t} ${hrDH(totals[t].days, totals[t].hours)}</div>`);
          if (comp) typeLines.push(`<div class="whitespace-nowrap">例假日／補休 ${hrDH(comp, 0)}</div>`);
          const sumDays = Object.values(totals).reduce((s, v) => s + v.days, 0) + comp;
          const sumHours = Object.values(totals).reduce((s, v) => s + v.hours, 0);
          return `
          <tr class="border-t hover:bg-slate-50 ${active ? "" : "text-slate-400"}">
            <td class="${HR_TD} font-mono text-xs">${finEsc(e.no) || "-"}</td>
            <td class="${HR_TD} font-medium whitespace-nowrap">${finEsc(e.name)}</td>
            <td class="${HR_TD} text-xs">${finEsc([e.dept, e.title].filter(Boolean).join("／")) || "-"}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${finEsc(e.hireDate) || "-"}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${e.hireDate ? hrSeniority(a.months) : "-"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap">${active ? (a.days ? `${a.days} 天` : `<span class="text-xs text-slate-400" title="${a.end ? `${finEsc(a.end)} 起有 3 天` : ""}">${finEsc(a.note)}</span>`) : "-"}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${active && a.start ? `${finEsc(a.start)}～${finEsc(hrLastDay(a.end))}` : "-"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap">${active && a.days ? hrDaysToDH(a.used) : "-"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap ${a.remaining < 0 ? "text-rose-600" : ""}">${active && a.days ? hrDaysToDH(a.remaining) : "-"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap">${(() => { const p = hrCompPending(e.id); return p ? `<span class="font-semibold text-amber-600">${hrDH(p, 0)}</span>` : `<span class="text-slate-300">-</span>`; })()}</td>
            ${(() => {
              // 剩餘天數 = 本期未休特休 + 未補休
              const annualLeft = active && a.days ? a.remaining : 0;
              const comp = active ? hrCompPending(e.id) : 0;
              const total = annualLeft + comp;
              if (!active || (!a.days && !comp)) return `<td class="${HR_TD} text-right">-</td>`;
              return `<td class="${HR_TD} text-right font-semibold whitespace-nowrap ${total < 0 ? "text-rose-600" : ""}" title="未休特休 ${hrDaysToDH(annualLeft)} ＋ 未補休 ${hrDH(comp, 0)}">${hrDaysToDH(total)}</td>`;
            })()}
            <td class="${HR_TD} text-xs">${typeLines.join("") || `<span class="text-slate-300">-</span>`}</td>
            <td class="${HR_TD} text-right font-semibold whitespace-nowrap">${sumDays || sumHours ? hrDH(sumDays, sumHours) : `<span class="text-slate-300">-</span>`}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${cc.total ? `${cc.total} 張${cc.expired ? ` <span class="text-rose-600">過期 ${cc.expired}</span>` : ""}${cc.soon ? ` <span class="text-amber-600">將到期 ${cc.soon}</span>` : ""}` : "-"}</td>
            <td class="${HR_TD} whitespace-nowrap">${active ? `<span class="px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700">在職</span>` : `<span class="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-500">離職 ${finEsc(e.leaveDate)}</span>`}</td>
            <td class="${HR_TD} text-right whitespace-nowrap sticky right-0 bg-white border-l"><button data-id="${finEsc(e.id)}" class="hr-emp-edit text-slate-600 hover:underline text-xs mr-2">編輯</button><button data-id="${finEsc(e.id)}" class="hr-emp-del text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="16" class="px-4 py-8 text-center text-slate-400">尚無員工資料</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function hrBindEmployees() {
  const $ = id => document.getElementById(id);
  $("hr-show-left").onchange = () => { hrFilter.showLeft = $("hr-show-left").checked; render(); };
  $("hr-emp-year").onchange = () => { hrFilter.year = Number($("hr-emp-year").value) || new Date().getFullYear(); render(); };
  document.querySelector('[data-hr-save="employee"]').onclick = () => {
    const fail = msg => showMsg("hr-msg-employee", msg, true);
    const v = k => String(hrVal("employee", k)).trim();
    const data = { no: v("no"), name: v("name"), dept: v("dept"), title: v("title"), hireDate: v("hireDate"), leaveDate: v("leaveDate"), phone: v("phone"), note: v("note") };
    if (!data.name) return fail("請輸入姓名");
    if (!data.hireDate) return fail("請選擇到職日（特休要用到職日計算）");
    if (data.leaveDate && data.leaveDate < data.hireDate) return fail("離職日不能早於到職日");
    if (data.no && db.hr.employees.some(e => e.no === data.no && e.id !== hrEdit.employee)) return fail(`員工編號 ${data.no} 已經有人使用了`);
    const rec = hrRecord("employee");
    if (rec) Object.assign(rec, data); else db.hr.employees.push({ id: finId("emp"), ...data });
    hrResetForm("employee");
    finSave();
  };
  document.querySelectorAll(".hr-emp-edit").forEach(b => { b.onclick = () => hrStartEdit("employee", b.dataset.id); });
  document.querySelectorAll(".hr-emp-del").forEach(b => {
    b.onclick = () => {
      const e = db.hr.employees.find(x => x.id === b.dataset.id);
      if (!e) return;
      const used = db.hr.leaves.some(l => l.employeeId === e.id) || db.hr.compDays.some(c => c.employeeId === e.id) || db.hr.certs.some(c => c.employeeId === e.id);
      if (used) { alert(`「${e.name}」已有請假、補休或證照紀錄，不能刪除。員工離職請填「離職日」，紀錄會保留。`); return; }
      appConfirm(`確定要刪除員工「${e.name}」嗎？`, () => {
        db.hr.employees = db.hr.employees.filter(x => x.id !== e.id);
        if (hrEdit.employee === e.id) hrResetForm("employee");
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
}

// ============================================================
// 請假紀錄與統計
// ============================================================
function hrLeaveRows() {
  const y = String(hrFilter.year);
  return db.hr.leaves
    .filter(l => (l.start || "").startsWith(y))
    .filter(l => !hrFilter.employeeId || l.employeeId === hrFilter.employeeId)
    .filter(l => !hrFilter.leaveType || l.type === hrFilter.leaveType)
    .sort((a, b) => b.start.localeCompare(a.start));
}
function hrYearOptions() {
  const thisYear = new Date().getFullYear();
  const years = new Set([thisYear, thisYear - 1, hrFilter.year]);
  db.hr.leaves.forEach(l => l.start && years.add(Number(l.start.slice(0, 4))));
  db.hr.compDays.forEach(c => { if (c.offDate) years.add(Number(c.offDate.slice(0, 4))); if (c.overtimeDate) years.add(Number(c.overtimeDate.slice(0, 4))); });
  return [...years].sort((a, b) => b - a).map(y => `<option value="${y}" ${y === hrFilter.year ? "selected" : ""}>${y} 年</option>`).join("");
}
function hrRenderLeaves() {
  const editing = hrRecord("leave");
  const empId = hrVal("leave", "employeeId");
  const type = hrVal("leave", "type", "特休");
  const emp = db.hr.employees.find(e => e.id === empId);
  const annual = emp ? hrAnnualSummary(emp) : null;
  const rows = hrLeaveRows();
  const form = `
    <div class="grid grid-cols-2 md:grid-cols-7 gap-3 mb-3">
      <div class="col-span-2">${hrLabel("員工")}<select data-hr-form="leave" data-hr-key="employeeId" id="hr-leave-emp" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${hrEmployeeOptions(empId)}</select></div>
      <div>${hrLabel("假別")}<select data-hr-form="leave" data-hr-key="type" id="hr-leave-type" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${HR_LEAVE_TYPES.map(t => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div>${hrLabel("開始日")}<input data-hr-form="leave" data-hr-key="start" id="hr-leave-start" type="date" value="${finEsc(hrVal("leave", "start"))}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div>${hrLabel("結束日")}<input data-hr-form="leave" data-hr-key="end" id="hr-leave-end" type="date" value="${finEsc(hrVal("leave", "end"))}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div>${hrLabel("天數（可填 0.5）")}<input data-hr-form="leave" data-hr-key="days" id="hr-leave-days" type="number" min="0" step="0.5" value="${finEsc(hrVal("leave", "days"))}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1"/></div>
      <div>${hrLabel("時數（選填）")}<input data-hr-form="leave" data-hr-key="hours" id="hr-leave-hours" type="number" min="0" step="0.5" value="${finEsc(hrVal("leave", "hours"))}" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：3"/></div>
      <div class="col-span-2 md:col-span-7">${hrLabel("事由（選填）")}${hrInput("leave", "reason")}</div>
    </div>
    <p id="hr-leave-hint" class="text-xs text-slate-500 mb-3">${type === "特休" && annual ? (annual.days ? `本期特休 ${annual.days} 天（${finEsc(annual.start)}～${finEsc(hrLastDay(annual.end))}），已休 ${hrDaysToDH(annual.used)}，剩 ${hrDaysToDH(annual.remaining)}（1 天以 ${HR_HOURS_PER_DAY} 小時計）` : `目前還沒有特休（${finEsc(annual.note)}）`) : "天數預設為期間內的週一到週五，國定假日請自行修改；請幾小時的假，天數填 0、時數填小時"}</p>
    ${hrFormButtons("leave", "登錄請假")}`;

  // 年度統計：每位員工各假別天數
  const y = String(hrFilter.year);
  const yearLeaves = db.hr.leaves.filter(l => (l.start || "").startsWith(y));
  const yearComp = db.hr.compDays.filter(c => (c.offDate || "").startsWith(y));
  const typesUsed = HR_LEAVE_TYPES.filter(t => ["特休", "事假", "病假"].includes(t) || yearLeaves.some(l => l.type === t));
  const people = db.hr.employees.filter(e => hrIsActive(e) || yearLeaves.some(l => l.employeeId === e.id) || yearComp.some(c => c.employeeId === e.id));
  const compBy = id => yearComp.filter(c => c.employeeId === id).reduce((s, c) => s + Number(c.days || 0), 0);
  const stats = `
  <div class="bg-white rounded-xl shadow-sm overflow-x-auto mb-6">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="${HR_TH}">員工</th>${typesUsed.map(t => `<th class="${HR_TH} text-right">${t}</th>`).join("")}<th class="${HR_TH} text-right">例假日／補休</th><th class="${HR_TH} text-right">合計</th><th class="${HR_TH} text-right">特休剩餘（本期）</th></tr>
      </thead>
      <tbody>
        ${people.map(e => {
          const totals = hrYearLeaveTotals(e.id, hrFilter.year);
          const z = { days: 0, hours: 0 };
          const vals = typesUsed.map(t => totals[t] || z);
          const equiv = t => (totals[t] || z).days + (totals[t] || z).hours / HR_HOURS_PER_DAY;
          const personal = equiv("事假") + equiv("家庭照顧假");
          const sick = equiv("病假");
          const comp = compBy(e.id);
          const allTypes = Object.values(totals);
          const totalDays = allTypes.reduce((s, v) => s + v.days, 0) + comp;
          const totalHours = allTypes.reduce((s, v) => s + v.hours, 0);
          const a = hrAnnualSummary(e);
          return `
          <tr class="border-t">
            <td class="${HR_TD} font-medium whitespace-nowrap">${finEsc(e.name)}${hrIsActive(e) ? "" : ` <span class="text-xs text-slate-400">離職</span>`}</td>
            ${typesUsed.map((t, i) => {
              const warn = (t === "事假" && personal > 14) || (t === "病假" && sick > 30);
              const has = vals[i].days || vals[i].hours;
              return `<td class="${HR_TD} text-right whitespace-nowrap ${warn ? "text-rose-600 font-semibold" : has ? "" : "text-slate-300"}" ${warn ? `title="${t === "事假" ? "事假（含家庭照顧假）一年超過 14 天" : "未住院病假一年超過 30 天"}"` : ""}>${hrDH(vals[i].days, vals[i].hours)}</td>`;
            }).join("")}
            <td class="${HR_TD} text-right ${comp ? "" : "text-slate-300"}">${comp ? hrDH(comp, 0) : "-"}</td>
            <td class="${HR_TD} text-right font-semibold whitespace-nowrap">${totalDays || totalHours ? hrDH(totalDays, totalHours) : "0"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap ${a.remaining < 0 ? "text-rose-600 font-semibold" : ""}">${hrIsActive(e) && a.days ? `${hrDaysToDH(a.remaining)} / ${a.days} 天` : "-"}</td>
          </tr>`;
        }).join("") || `<tr><td colspan="${typesUsed.length + 4}" class="px-4 py-8 text-center text-slate-400">尚無員工</td></tr>`}
      </tbody>
    </table>
  </div>`;

  return `
  ${hrCard(editing ? "編輯請假紀錄" : "登錄請假", form, editing)}
  <div class="bg-white rounded-xl shadow-sm p-4 mb-3">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
      <div>${hrLabel("年度")}<select id="hr-f-year" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">${hrYearOptions()}</select></div>
      <div>${hrLabel("員工")}<select id="hr-f-emp" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">${hrEmployeeOptions(hrFilter.employeeId, "全部員工")}</select></div>
      <div>${hrLabel("假別")}<select id="hr-f-type" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1"><option value="">全部</option>${HR_LEAVE_TYPES.map(t => `<option ${t === hrFilter.leaveType ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    </div>
  </div>
  <p class="font-semibold text-sm text-slate-700 mb-2">${hrFilter.year} 年請假統計</p>
  <p class="text-xs text-slate-500 mb-2">依請假開始日歸年度；例假日／補休依補休日期。紅字為超過勞基法一般上限（事假含家庭照顧假 14 天、未住院病假 30 天）。</p>
  ${stats}
  <p class="font-semibold text-sm text-slate-700 mb-2">請假紀錄（${rows.length} 筆）</p>
  <div class="bg-white rounded-xl shadow-sm overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="${HR_TH}">員工</th><th class="${HR_TH}">假別</th><th class="${HR_TH}">期間</th><th class="${HR_TH} text-right">天數／時數</th><th class="${HR_TH}">事由</th><th class="${HR_TH} sticky right-0 bg-slate-100"></th></tr></thead>
      <tbody>
        ${rows.map(l => `
          <tr class="border-t hover:bg-slate-50">
            <td class="${HR_TD} whitespace-nowrap">${finEsc(hrEmpName(l.employeeId))}</td>
            <td class="${HR_TD} whitespace-nowrap">${finEsc(l.type)}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${finEsc(l.start)}${l.end && l.end !== l.start ? `～${finEsc(l.end)}` : ""}</td>
            <td class="${HR_TD} text-right whitespace-nowrap">${hrDH(l.days, l.hours)}</td>
            <td class="${HR_TD} text-slate-500">${finEsc(l.reason) || "-"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap sticky right-0 bg-white border-l"><button data-id="${finEsc(l.id)}" class="hr-leave-edit text-slate-600 hover:underline text-xs mr-2">編輯</button><button data-id="${finEsc(l.id)}" class="hr-leave-del text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>`).join("") || `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">這個年度沒有請假紀錄</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function hrBindLeaves() {
  const $ = id => document.getElementById(id);
  // 天數：沒手動改過時，跟著日期自動算週一到週五天數
  const autoDays = () => {
    if (hrDrafts.leave.daysTouched) return;
    const start = $("hr-leave-start").value, end = $("hr-leave-end").value || start;
    if (start && !$("hr-leave-end").value) { $("hr-leave-end").value = start; hrDrafts.leave.end = start; }
    const n = hrWeekdays(start, end);
    if (n) { $("hr-leave-days").value = n; hrDrafts.leave.days = String(n); }
  };
  $("hr-leave-start").addEventListener("change", autoDays);
  $("hr-leave-end").addEventListener("change", autoDays);
  $("hr-leave-days").addEventListener("input", () => { hrDrafts.leave.daysTouched = true; });
  // 單日請幾小時：填了時數、天數又是自動帶的 1 天時，把天數改成 0
  $("hr-leave-hours").addEventListener("input", () => {
    const start = $("hr-leave-start").value, end = $("hr-leave-end").value || start;
    if (Number($("hr-leave-hours").value) > 0 && !hrDrafts.leave.daysTouched && start && start === end) {
      $("hr-leave-days").value = 0;
      hrDrafts.leave.days = "0";
    }
  });
  // 換員工或假別時，更新特休剩餘提示
  ["hr-leave-emp", "hr-leave-type"].forEach(id => $(id).addEventListener("change", () => render()));
  $("hr-f-year").onchange = () => { hrFilter.year = Number($("hr-f-year").value) || new Date().getFullYear(); render(); };
  $("hr-f-emp").onchange = () => { hrFilter.employeeId = $("hr-f-emp").value; render(); };
  $("hr-f-type").onchange = () => { hrFilter.leaveType = $("hr-f-type").value; render(); };

  document.querySelector('[data-hr-save="leave"]').onclick = () => {
    const fail = msg => showMsg("hr-msg-leave", msg, true);
    const v = k => String(hrVal("leave", k, k === "type" ? "特休" : "")).trim();
    const data = { employeeId: v("employeeId"), type: v("type"), start: v("start"), end: v("end") || v("start"), days: Number(v("days") || 0), hours: Number(v("hours") || 0), reason: v("reason") };
    if (!data.employeeId) return fail("請選擇員工");
    if (!data.start) return fail("請選擇開始日");
    if (data.end < data.start) return fail("結束日不能早於開始日");
    const half = n => Number.isFinite(n) && n >= 0 && Math.round(n * 2) === n * 2;
    if (!half(data.days)) return fail("天數請輸入 0 或正數，最小單位 0.5 天");
    if (!half(data.hours)) return fail("時數請輸入 0 或正數，最小單位 0.5 小時");
    if (!data.days && !data.hours) return fail("請輸入天數或時數");
    const commit = () => {
      const rec = hrRecord("leave");
      if (rec) Object.assign(rec, data); else db.hr.leaves.push({ id: finId("lv"), ...data });
      hrResetForm("leave");
      hrDrafts.leave = { employeeId: data.employeeId, type: data.type };   // 連續登錄同一人比較快
      finSave();
    };
    // 特休超過本期剩餘時提醒（例如預支或期間算法不同），仍可登錄
    if (data.type === "特休") {
      const emp = db.hr.employees.find(e => e.id === data.employeeId);
      const a = hrAnnualLeave(emp);
      const old = hrRecord("leave");
      const usedOther = hrAnnualUsed(emp.id, a.start, a.end) - (old?.type === "特休" && old.start >= a.start && old.start < a.end ? hrLeaveDayEquiv(old) : 0);
      const inPeriod = a.start && data.start >= a.start && data.start < a.end;
      const thisTime = hrLeaveDayEquiv(data);
      if (inPeriod && usedOther + thisTime > a.days) {
        return appConfirm(`${emp.name} 本期特休 ${a.days} 天，已休 ${hrDaysToDH(usedOther)}，這次 ${hrDH(data.days, data.hours)} 會超過 ${hrDaysToDH(usedOther + thisTime - a.days)}。確定要登錄嗎？`, commit);
      }
    }
    commit();
  };
  document.querySelectorAll(".hr-leave-edit").forEach(b => { b.onclick = () => hrStartEdit("leave", b.dataset.id); });
  document.querySelectorAll(".hr-leave-del").forEach(b => {
    b.onclick = () => {
      const l = db.hr.leaves.find(x => x.id === b.dataset.id);
      if (!l) return;
      appConfirm(`確定要刪除 ${hrEmpName(l.employeeId)} ${l.start} 的${l.type}嗎？`, () => {
        db.hr.leaves = db.hr.leaves.filter(x => x.id !== l.id);
        if (hrEdit.leave === l.id) hrResetForm("leave");
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
}

// ============================================================
// 例假日／補休：因加班衍生的休假日
// ============================================================
function hrRenderComp() {
  const editing = hrRecord("comp");
  const rows = db.hr.compDays
    .filter(c => !hrFilter.employeeId || c.employeeId === hrFilter.employeeId)
    .filter(c => !hrFilter.compStatus || (hrFilter.compStatus === "pending" ? !c.offDate : !!c.offDate))
    .sort((a, b) => (b.offDate || b.overtimeDate).localeCompare(a.offDate || a.overtimeDate));
  const people = db.hr.employees.filter(e => db.hr.compDays.some(c => c.employeeId === e.id));
  const form = `
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
      <div class="col-span-2">${hrLabel("員工")}<select data-hr-form="comp" data-hr-key="employeeId" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${hrEmployeeOptions(hrVal("comp", "employeeId"))}</select></div>
      <div>${hrLabel("因哪天加班衍生（加班日期）")}${hrInput("comp", "overtimeDate", 'type="date"')}</div>
      <div>${hrLabel("例假日／補休日期（還沒排可留空）")}${hrInput("comp", "offDate", 'type="date"')}</div>
      <div>${hrLabel("天數（可填 0.5）")}${hrInput("comp", "days", 'type="number" min="0.5" step="0.5" placeholder="1"')}</div>
      <div class="col-span-2 md:col-span-5">${hrLabel("說明（選填）")}${hrInput("comp", "note", 'placeholder="例：週六支援新竹三陽案場"')}</div>
    </div>
    ${hrFormButtons("comp", "新增例假日／補休")}`;
  return `
  ${hrCard(editing ? "編輯例假日／補休" : "新增例假日／補休", form, editing)}
  ${people.length ? `
  <div class="bg-white rounded-xl shadow-sm overflow-x-auto mb-6">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="${HR_TH}">員工</th><th class="${HR_TH} text-right">因加班累積</th><th class="${HR_TH} text-right">已排休</th><th class="${HR_TH} text-right">尚未排休</th></tr></thead>
      <tbody>${people.map(e => {
        const list = db.hr.compDays.filter(c => c.employeeId === e.id);
        const earned = list.reduce((s, c) => s + Number(c.days || 0), 0);
        const taken = list.filter(c => c.offDate).reduce((s, c) => s + Number(c.days || 0), 0);
        return `<tr class="border-t"><td class="${HR_TD} font-medium">${finEsc(e.name)}</td><td class="${HR_TD} text-right">${hrNum(earned)}</td><td class="${HR_TD} text-right">${hrNum(taken)}</td><td class="${HR_TD} text-right font-semibold ${earned - taken > 0 ? "text-amber-600" : ""}">${hrNum(earned - taken)}</td></tr>`;
      }).join("")}</tbody>
    </table>
  </div>` : ""}
  <div class="bg-white rounded-xl shadow-sm p-4 mb-3">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
      <div>${hrLabel("員工")}<select id="hr-f-emp" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">${hrEmployeeOptions(hrFilter.employeeId, "全部員工")}</select></div>
      <div>${hrLabel("狀態")}<select id="hr-f-comp" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1"><option value="">全部</option><option value="pending" ${hrFilter.compStatus === "pending" ? "selected" : ""}>尚未排休</option><option value="taken" ${hrFilter.compStatus === "taken" ? "selected" : ""}>已排休</option></select></div>
    </div>
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="${HR_TH}">員工</th><th class="${HR_TH}">加班日期（衍生自）</th><th class="${HR_TH}">例假日／補休日期</th><th class="${HR_TH} text-right">天數</th><th class="${HR_TH}">說明</th><th class="${HR_TH} sticky right-0 bg-slate-100"></th></tr></thead>
      <tbody>
        ${rows.map(c => `
          <tr class="border-t hover:bg-slate-50">
            <td class="${HR_TD} whitespace-nowrap">${finEsc(hrEmpName(c.employeeId))}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${finEsc(c.overtimeDate)}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${c.offDate ? finEsc(c.offDate) : `<span class="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700">尚未排休</span>`}</td>
            <td class="${HR_TD} text-right">${hrNum(c.days)}</td>
            <td class="${HR_TD} text-slate-500">${finEsc(c.note) || "-"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap sticky right-0 bg-white border-l"><button data-id="${finEsc(c.id)}" class="hr-comp-edit text-slate-600 hover:underline text-xs mr-2">編輯</button><button data-id="${finEsc(c.id)}" class="hr-comp-del text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>`).join("") || `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">尚無例假日／補休紀錄</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function hrBindComp() {
  const $ = id => document.getElementById(id);
  $("hr-f-emp").onchange = () => { hrFilter.employeeId = $("hr-f-emp").value; render(); };
  $("hr-f-comp").onchange = () => { hrFilter.compStatus = $("hr-f-comp").value; render(); };
  document.querySelector('[data-hr-save="comp"]').onclick = () => {
    const fail = msg => showMsg("hr-msg-comp", msg, true);
    const v = k => String(hrVal("comp", k)).trim();
    const data = { employeeId: v("employeeId"), overtimeDate: v("overtimeDate"), offDate: v("offDate"), days: v("days") === "" ? 1 : Number(v("days")), note: v("note") };
    if (!data.employeeId) return fail("請選擇員工");
    if (!data.overtimeDate) return fail("請填是因為哪天加班而衍生的（加班日期）");
    if (!Number.isFinite(data.days) || data.days <= 0 || Math.round(data.days * 2) !== data.days * 2) return fail("天數請輸入大於 0 的數字，最小單位 0.5 天");
    const rec = hrRecord("comp");
    if (rec) Object.assign(rec, data); else db.hr.compDays.push({ id: finId("cd"), ...data });
    hrResetForm("comp");
    finSave();
  };
  document.querySelectorAll(".hr-comp-edit").forEach(b => { b.onclick = () => hrStartEdit("comp", b.dataset.id); });
  document.querySelectorAll(".hr-comp-del").forEach(b => {
    b.onclick = () => {
      const c = db.hr.compDays.find(x => x.id === b.dataset.id);
      if (!c) return;
      appConfirm(`確定要刪除 ${hrEmpName(c.employeeId)}（加班日 ${c.overtimeDate}）這筆例假日／補休嗎？`, () => {
        db.hr.compDays = db.hr.compDays.filter(x => x.id !== c.id);
        if (hrEdit.comp === c.id) hrResetForm("comp");
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
}

// ============================================================
// 工安證照
// ============================================================
function hrRenderCerts() {
  const editing = hrRecord("cert");
  const all = db.hr.certs.map(c => ({ c, s: hrCertStatus(c) }));
  const count = code => all.filter(x => x.s.code === code && hrIsActive(db.hr.employees.find(e => e.id === x.c.employeeId) || {})).length;
  const rows = all
    .filter(x => !hrFilter.employeeId || x.c.employeeId === hrFilter.employeeId)
    .filter(x => !hrFilter.certStatus || x.s.code === hrFilter.certStatus)
    .sort((a, b) => (a.c.expiryDate || "9999").localeCompare(b.c.expiryDate || "9999"));
  const card = (label, n, cls) => `<div class="bg-white rounded-xl shadow-sm p-4"><p class="text-xs text-slate-500">${label}</p><p class="text-2xl font-bold mt-1 ${cls}">${n}</p></div>`;
  const form = `
    <datalist id="hr-cert-names">${HR_CERT_NAMES.map(n => `<option value="${finEsc(n)}"></option>`).join("")}</datalist>
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
      <div>${hrLabel("員工")}<select data-hr-form="cert" data-hr-key="employeeId" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">${hrEmployeeOptions(hrVal("cert", "employeeId"))}</select></div>
      <div class="col-span-2">${hrLabel("證照名稱（可選擇或自行輸入）")}${hrInput("cert", "name", 'list="hr-cert-names" autocomplete="off"')}</div>
      <div>${hrLabel("證號（選填）")}${hrInput("cert", "certNo")}</div>
      <div>${hrLabel("取得日（選填）")}${hrInput("cert", "issueDate", 'type="date"')}</div>
      <div>${hrLabel("到期日（沒有期限可留空）")}${hrInput("cert", "expiryDate", 'type="date"')}</div>
      <div class="col-span-2 md:col-span-4">${hrLabel("備註（選填）")}${hrInput("cert", "note", 'placeholder="例：每 3 年回訓"')}</div>
    </div>
    ${hrFormButtons("cert", "新增證照")}`;
  return `
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
    ${card("已過期", count("expired"), "text-rose-600")}
    ${card(`${HR_SOON_DAYS} 天內到期`, count("soon"), "text-amber-600")}
    ${card("有效", count("valid"), "text-emerald-600")}
    ${card("無期限", count("none"), "text-slate-700")}
  </div>
  ${hrCard(editing ? "編輯證照" : "新增證照", form, editing)}
  <div class="bg-white rounded-xl shadow-sm p-4 mb-3">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
      <div>${hrLabel("員工")}<select id="hr-f-emp" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">${hrEmployeeOptions(hrFilter.employeeId, "全部員工")}</select></div>
      <div>${hrLabel("狀態")}<select id="hr-f-cert" class="w-full border rounded-lg px-3 py-1.5 text-sm mt-1">${[["", "全部"], ["expired", "已過期"], ["soon", `${HR_SOON_DAYS} 天內到期`], ["valid", "有效"], ["none", "無期限"]].map(([v, t]) => `<option value="${v}" ${hrFilter.certStatus === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    </div>
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left"><tr><th class="${HR_TH}">員工</th><th class="${HR_TH}">證照名稱</th><th class="${HR_TH}">證號</th><th class="${HR_TH}">取得日</th><th class="${HR_TH}">到期日</th><th class="${HR_TH}">狀態</th><th class="${HR_TH}">備註</th><th class="${HR_TH} sticky right-0 bg-slate-100"></th></tr></thead>
      <tbody>
        ${rows.map(({ c, s }) => {
          const emp = db.hr.employees.find(e => e.id === c.employeeId);
          return `
          <tr class="border-t hover:bg-slate-50 ${emp && !hrIsActive(emp) ? "text-slate-400" : ""}">
            <td class="${HR_TD} whitespace-nowrap">${finEsc(hrEmpName(c.employeeId))}${emp && !hrIsActive(emp) ? ` <span class="text-xs">（離職）</span>` : ""}</td>
            <td class="${HR_TD}">${finEsc(c.name)}</td>
            <td class="${HR_TD} font-mono text-xs">${finEsc(c.certNo) || "-"}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${finEsc(c.issueDate) || "-"}</td>
            <td class="${HR_TD} text-xs whitespace-nowrap">${finEsc(c.expiryDate) || "-"}</td>
            <td class="${HR_TD}"><span class="px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${s.cls}">${s.label}</span></td>
            <td class="${HR_TD} text-slate-500">${finEsc(c.note) || "-"}</td>
            <td class="${HR_TD} text-right whitespace-nowrap sticky right-0 bg-white border-l"><button data-id="${finEsc(c.id)}" class="hr-cert-edit text-slate-600 hover:underline text-xs mr-2">編輯</button><button data-id="${finEsc(c.id)}" class="hr-cert-del text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">尚無證照紀錄</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function hrBindCerts() {
  const $ = id => document.getElementById(id);
  $("hr-f-emp").onchange = () => { hrFilter.employeeId = $("hr-f-emp").value; render(); };
  $("hr-f-cert").onchange = () => { hrFilter.certStatus = $("hr-f-cert").value; render(); };
  document.querySelector('[data-hr-save="cert"]').onclick = () => {
    const fail = msg => showMsg("hr-msg-cert", msg, true);
    const v = k => String(hrVal("cert", k)).trim();
    const data = { employeeId: v("employeeId"), name: v("name"), certNo: v("certNo"), issueDate: v("issueDate"), expiryDate: v("expiryDate"), note: v("note") };
    if (!data.employeeId) return fail("請選擇員工");
    if (!data.name) return fail("請輸入證照名稱");
    if (data.issueDate && data.expiryDate && data.expiryDate < data.issueDate) return fail("到期日不能早於取得日");
    const rec = hrRecord("cert");
    if (rec) Object.assign(rec, data); else db.hr.certs.push({ id: finId("crt"), ...data });
    hrResetForm("cert");
    finSave();
  };
  document.querySelectorAll(".hr-cert-edit").forEach(b => { b.onclick = () => hrStartEdit("cert", b.dataset.id); });
  document.querySelectorAll(".hr-cert-del").forEach(b => {
    b.onclick = () => {
      const c = db.hr.certs.find(x => x.id === b.dataset.id);
      if (!c) return;
      appConfirm(`確定要刪除 ${hrEmpName(c.employeeId)} 的「${c.name}」嗎？`, () => {
        db.hr.certs = db.hr.certs.filter(x => x.id !== c.id);
        if (hrEdit.cert === c.id) hrResetForm("cert");
        finSave();
      }, { okLabel: "刪除", danger: true });
    };
  });
}
