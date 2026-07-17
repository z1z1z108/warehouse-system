// ---- 全域狀態 ----
let db = loadDB();
let session = JSON.parse(sessionStorage.getItem("wms_session") || "null");
// 重新整理頁面時，若已登入且不是管理員，直接還原到該客戶的儀表板，而不是預設的總覽頁
let view = (() => {
  const restoredUser = session ? db.users.find(u => u.id === session.userId) : null;
  return restoredUser && restoredUser.role !== "admin"
    ? { page: "dashboard", filterClientId: null, filterWarehouseId: null }
    : { page: "home", filterClientId: null, filterWarehouseId: null };
})();
let moveMenuOpen = false;
let navHistory = [];

// 導頁時記住上一頁的完整狀態，供「上一頁」按鈕還原（若導向的其實是同一頁就不記錄，避免出現多餘的上一頁）
function navigateTo(patch) {
  const merged = { ...view, ...patch };
  const isNoOp = Object.keys(merged).every(key => merged[key] === view[key]);
  if (!isNoOp) navHistory.push({ ...view });
  Object.assign(view, patch);
  render();
}
function goBack() {
  if (!navHistory.length) return;
  view = navHistory.pop();
  render();
}

const ROLE_LABEL = { admin: "管理員", client: "客戶" };
const TYPE_LABEL = { inbound: "入庫", outbound: "出庫", transfer_out: "調撥(出)", transfer_in: "調撥(入)" };
const STANDARD_WAREHOUSE_NAMES = ["新機", "備機", "壞機", "待修", "待退", "其他"];
const HOST_CLIENT_ID = "c5"; // 震浤倉(ZH)，本公司，可使用所有客戶的料號

// 建立客戶標配的六個倉庫
function createStandardWarehouses(clientId) {
  STANDARD_WAREHOUSE_NAMES.forEach((name, i) => {
    db.warehouses.push({ id: "w" + Date.now() + i, clientId, name });
  });
}

function currentUser() { return db.users.find(u => u.id === session?.userId); }

function login(email, password) {
  const u = db.users.find(x => x.email === email && x.password === password);
  if (!u) return false;
  session = { userId: u.id };
  sessionStorage.setItem("wms_session", JSON.stringify(session));
  navHistory = [];
  view = u.role === "admin"
    ? { page: "home", filterClientId: null, filterWarehouseId: null }
    : { page: "dashboard", filterClientId: null, filterWarehouseId: null };
  return true;
}

function logout() {
  session = null;
  sessionStorage.removeItem("wms_session");
  view = { page: "home", filterClientId: null, filterWarehouseId: null };
  render();
}

function productName(id) { return db.products.find(p => p.id === id)?.name || id; }
function productSkuOf(id) { return db.products.find(p => p.id === id)?.sku || ""; }
function productUnit(id) { return db.products.find(p => p.id === id)?.unit || ""; }
function userName(id) { return db.users.find(u => u.id === id)?.name || "-"; }
function clientName(id) { return db.clients.find(c => c.id === id)?.name || "-"; }
function warehouseName(id) { return db.warehouses.find(w => w.id === id)?.name || "-"; }
function warehouseOf(id) { return db.warehouses.find(w => w.id === id); }
function clientOfWarehouse(warehouseId) { return warehouseOf(warehouseId)?.clientId; }
function warehousesOfClient(clientId) { return db.warehouses.filter(w => w.clientId === clientId); }
function warehouseIdsOfClient(clientId) { return warehousesOfClient(clientId).map(w => w.id); }

function stockOf(productId, warehouseId) {
  return db.serialUnits.filter(s => s.productId === productId && s.warehouseId === warehouseId).length;
}
function totalStock(productId, warehouseIds) {
  return db.serialUnits.filter(s => s.productId === productId && (!warehouseIds || warehouseIds.includes(s.warehouseId))).length;
}
// 只回傳有序號的在庫單位（供勾選出庫用）
function activeSerialsOf(productId, warehouseId) {
  return db.serialUnits.filter(s => s.productId === productId && s.warehouseId === warehouseId && s.serialNo);
}
// 無序號的在庫數量
function nonSerialStockOf(productId, warehouseId) {
  return db.serialUnits.filter(s => s.productId === productId && s.warehouseId === warehouseId && !s.serialNo).length;
}
function serialExistsAnywhere(serialNo) {
  return db.serialUnits.some(s => s.serialNo === serialNo);
}

// 有序號：一筆異動對應一台（qty 固定為 1）；無序號：一筆異動對應 qty 台，一起記錄數量
function applyMovement(productId, warehouseId, type, serialNo, qty, note, operatorId) {
  const timestamp = new Date().toLocaleString("zh-TW", { hour12: false });
  const sign = type === "outbound" ? -1 : 1;
  if (serialNo) {
    if (type === "inbound") {
      db.serialUnits.push({ id: "s" + Date.now() + Math.random().toString(36).slice(2, 6), productId, warehouseId, serialNo, inboundAt: timestamp });
    } else {
      const idx = db.serialUnits.findIndex(s => s.productId === productId && s.warehouseId === warehouseId && s.serialNo === serialNo);
      if (idx !== -1) db.serialUnits.splice(idx, 1);
    }
  } else if (type === "inbound") {
    for (let i = 0; i < qty; i++) {
      db.serialUnits.push({ id: "s" + Date.now() + Math.random().toString(36).slice(2, 6) + i, productId, warehouseId, serialNo: null, inboundAt: timestamp });
    }
  } else {
    let remaining = qty;
    for (let i = db.serialUnits.length - 1; i >= 0 && remaining > 0; i--) {
      const s = db.serialUnits[i];
      if (s.productId === productId && s.warehouseId === warehouseId && !s.serialNo) {
        db.serialUnits.splice(i, 1);
        remaining--;
      }
    }
  }
  db.movements.unshift({
    id: "m" + Date.now() + Math.random().toString(36).slice(2, 6),
    productId, warehouseId, delta: sign * qty, type, serialNo: serialNo || null, note, operatorId,
    timestamp,
  });
}

// 調撥：把庫存從一個倉庫移到另一個倉庫（同一台序號單位只是換倉庫，不是先出後入兩台）
function applyTransfer(productId, fromWarehouseId, toWarehouseId, serialNo, qty, note, operatorId) {
  const timestamp = new Date().toLocaleString("zh-TW", { hour12: false });
  if (serialNo) {
    const unit = db.serialUnits.find(s => s.productId === productId && s.warehouseId === fromWarehouseId && s.serialNo === serialNo);
    if (unit) unit.warehouseId = toWarehouseId;
  } else {
    let remaining = qty;
    for (let i = db.serialUnits.length - 1; i >= 0 && remaining > 0; i--) {
      const s = db.serialUnits[i];
      if (s.productId === productId && s.warehouseId === fromWarehouseId && !s.serialNo) {
        s.warehouseId = toWarehouseId;
        remaining--;
      }
    }
  }
  const groupId = "t" + Date.now() + Math.random().toString(36).slice(2, 6);
  const fromNote = `調撥至 ${warehouseName(toWarehouseId)}${note ? "；" + note : ""}`;
  const toNote = `調撥自 ${warehouseName(fromWarehouseId)}${note ? "；" + note : ""}`;
  db.movements.unshift({
    id: "m" + Date.now() + Math.random().toString(36).slice(2, 6) + "a",
    productId, warehouseId: fromWarehouseId, delta: -qty, type: "transfer_out", serialNo: serialNo || null, note: fromNote, operatorId, timestamp, transferGroupId: groupId,
  });
  db.movements.unshift({
    id: "m" + Date.now() + Math.random().toString(36).slice(2, 6) + "b",
    productId, warehouseId: toWarehouseId, delta: qty, type: "transfer_in", serialNo: serialNo || null, note: toNote, operatorId, timestamp, transferGroupId: groupId,
  });
}

function visibleClients() {
  const u = currentUser();
  return u.role === "admin" ? db.clients : db.clients.filter(c => c.id === u.clientId);
}

function visibleMovements() {
  const u = currentUser();
  if (u.role === "admin") return db.movements;
  const whIds = warehouseIdsOfClient(u.clientId);
  return db.movements.filter(m => whIds.includes(m.warehouseId));
}

// ---- 渲染入口 ----
function render() {
  const root = document.getElementById("app");
  if (session && !currentUser()) {
    // 帳號已不存在（例如舊的登入紀錄指向已刪除的帳號），清除失效的登入狀態
    session = null;
    sessionStorage.removeItem("wms_session");
  }
  if (!session) { root.innerHTML = renderLogin(); bindLogin(); return; }
  root.innerHTML = renderLayout();
  bindLayout();
}

// ---- 登入畫面 ----
function renderLogin() {
  return `
  <div class="min-h-screen flex items-center justify-center">
    <div class="bg-white shadow-lg rounded-2xl p-8 w-full max-w-sm">
      <h1 class="text-xl font-bold mb-1 text-slate-800">📦 震浤倉管系統</h1>
      <p class="text-sm text-slate-500 mb-6">請登入以繼續</p>
      <div class="space-y-3">
        <input id="login-email" type="email" placeholder="your@email.com" class="w-full border rounded-lg px-3 py-2 text-sm" />
        <input id="login-pw" type="password" placeholder="密碼" class="w-full border rounded-lg px-3 py-2 text-sm" />
        <button id="login-btn" class="w-full bg-slate-800 text-white rounded-lg py-2 text-sm font-medium hover:bg-slate-700">登入</button>
        <p id="login-error" class="text-red-500 text-xs hidden">帳號或密碼錯誤</p>
      </div>
      <div class="mt-6 border-t pt-4">
        <p class="font-semibold text-slate-600 text-xs mb-2">示範帳號（點擊自動填入）</p>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" data-demo="zh@wms.com|zh123" class="demo-account-btn col-span-2 border rounded-lg py-1.5 text-xs hover:bg-slate-100 bg-slate-50 font-medium">震浤（管理員／本公司）</button>
          <button type="button" data-demo="apd@wms.com|apd123" class="demo-account-btn border rounded-lg py-1.5 text-xs hover:bg-slate-100">亞源科技</button>
          <button type="button" data-demo="fimer@wms.com|fimer123" class="demo-account-btn border rounded-lg py-1.5 text-xs hover:bg-slate-100">菲邁爾</button>
          <button type="button" data-demo="sle@wms.com|sle123" class="demo-account-btn border rounded-lg py-1.5 text-xs hover:bg-slate-100">台灣所樂能源</button>
          <button type="button" data-demo="auo@wms.com|auo123" class="demo-account-btn border rounded-lg py-1.5 text-xs hover:bg-slate-100">友達光電</button>
        </div>
      </div>
      <button id="show-help-btn" class="w-full text-center text-xs text-blue-600 hover:underline mt-4">📖 查看操作說明</button>
    </div>
  </div>`;
}

function bindLogin() {
  document.getElementById("login-btn").onclick = () => {
    const email = document.getElementById("login-email").value.trim();
    const pw = document.getElementById("login-pw").value;
    if (login(email, pw)) render();
    else document.getElementById("login-error").classList.remove("hidden");
  };
  document.querySelectorAll(".demo-account-btn").forEach(btn => {
    btn.onclick = () => {
      const [email, pw] = btn.dataset.demo.split("|");
      document.getElementById("login-email").value = email;
      document.getElementById("login-pw").value = pw;
      document.getElementById("login-error").classList.add("hidden");
    };
  });
  document.getElementById("show-help-btn").onclick = () => {
    document.getElementById("app").innerHTML = `
      <div class="min-h-screen bg-slate-50 p-6">
        <button id="help-back-btn" class="border rounded-xl px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 mb-4">← 返回登入</button>
        ${renderHelpContent()}
      </div>`;
    document.getElementById("help-back-btn").onclick = render;
  };
}

// ---- 主版型 ----
function renderLayout() {
  const u = currentUser();
  if (view.page === "move-in" || view.page === "move-out" || view.page === "move-transfer") moveMenuOpen = true;
  return `
  <div class="h-screen flex overflow-hidden">
    <aside class="w-56 bg-slate-800 text-slate-100 flex flex-col shrink-0 h-screen overflow-y-auto">
      <div class="p-5 border-b border-slate-700">
        <h1 class="font-bold text-lg">📦 震浤倉管系統</h1>
        <p class="text-xs text-slate-400 mt-1">${u.name}（${ROLE_LABEL[u.role]}）</p>
      </div>
      <nav class="flex-1 p-3 space-y-1 text-sm">
        <button data-nav="${u.role === "admin" ? "home" : "dashboard"}" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">🏠 總覽</button>
        <button data-nav="inventory" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">📦 庫存總覽</button>
        <button data-nav="movements" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">📜 異動紀錄</button>
        ${u.role === "admin" ? `
        <div>
          <button id="move-toggle-btn" class="w-full text-left px-3 py-2 rounded hover:bg-slate-700 flex items-center justify-between">
            <span>＋ 異動</span><span class="text-xs">${moveMenuOpen ? "▾" : "▸"}</span>
          </button>
          ${moveMenuOpen ? `
            <button data-nav="move-in" class="nav-btn w-full text-left pl-8 pr-3 py-2 rounded hover:bg-slate-700 ${view.page === "move-in" ? "bg-slate-700" : ""}">📥 入庫</button>
            <button data-nav="move-out" class="nav-btn w-full text-left pl-8 pr-3 py-2 rounded hover:bg-slate-700 ${view.page === "move-out" ? "bg-slate-700" : ""}">📤 出庫</button>
            <button data-nav="move-transfer" class="nav-btn w-full text-left pl-8 pr-3 py-2 rounded hover:bg-slate-700 ${view.page === "move-transfer" ? "bg-slate-700" : ""}">🔀 調撥</button>
          ` : ""}
        </div>` : ""}
        ${u.role === "admin" ? `<button data-nav="products" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">🏷 料號管理</button>` : ""}
        ${u.role === "admin" ? `<button data-nav="admin" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">⚙ 管理後台</button>` : ""}
        <button data-nav="help" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">📖 操作說明</button>
      </nav>
      <div class="p-3 border-t border-slate-700">
        <button id="logout-btn" class="w-full text-left px-3 py-2 rounded hover:bg-slate-700 text-sm text-slate-300">🚪 登出</button>
      </div>
    </aside>
    <main class="flex-1 p-6 overflow-auto">
      <div class="flex items-center justify-between mb-4">
        <button id="back-btn" class="border rounded-xl px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 ${navHistory.length ? "" : "invisible"}">← 上一頁</button>
        <h2 class="text-lg font-bold text-slate-800">${getPageTitle()}</h2>
      </div>
      ${renderPage()}
    </main>
  </div>`;
}

function getPageTitle() {
  switch (view.page) {
    case "home": return "";
    case "client-settings": {
      const c = db.clients.find(x => x.id === view.editClientId);
      return c ? `${c.name}　設定` : "客戶設定";
    }
    case "client-new": return "新增客戶";
    case "dashboard": {
      const u = currentUser();
      const clientId = u.role === "admin" ? view.filterClientId : u.clientId;
      return clientId ? `${clientName(clientId)}－庫存狀況` : "客戶儀表板";
    }
    case "inventory": {
      const u = currentUser();
      const isAdmin = u.role === "admin";
      const filterWarehouseId = isAdmin
        ? view.filterWarehouseId
        : (view.filterWarehouseId && clientOfWarehouse(view.filterWarehouseId) === u.clientId ? view.filterWarehouseId : null);
      if (filterWarehouseId) return `${warehouseName(filterWarehouseId)}－庫存狀況`;
      if (!isAdmin) return `${clientName(u.clientId)}－庫存總覽`;
      return "庫存總覽";
    }
    case "movements": return "異動紀錄";
    case "move-in": return "入庫（即時異動）";
    case "move-out": return "出庫（即時異動）";
    case "move-transfer": return "調撥（倉庫間移轉庫存）";
    case "products": return "料號管理";
    case "admin": return "管理後台";
    case "help": return "操作說明";
    default: return "";
  }
}

function renderPage() {
  switch (view.page) {
    case "home": return renderHome();
    case "client-settings": return renderClientSettings();
    case "client-new": return renderClientNew();
    case "dashboard": return renderDashboardPage();
    case "inventory": return renderInventory();
    case "movements": return renderMovements();
    case "move-in": return renderMoveForm("inbound");
    case "move-out": return renderMoveForm("outbound");
    case "move-transfer": return renderTransferForm();
    case "products": return renderProducts();
    case "admin": return renderAdmin();
    case "help": return renderHelpContent();
    default: return "";
  }
}

// ---- 首頁：總覽（管理員可直接在此管理客戶與倉庫） ----
function renderHome() {
  const u = currentUser();
  const clients = visibleClients();
  const isAdmin = u.role === "admin";

  return `
  ${isAdmin ? `<div class="flex justify-end mb-4"><button id="add-client-btn" class="border rounded-xl px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">➕ 新增客戶</button></div>` : ""}
  <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
    ${clients.map(c => {
      const whs = warehousesOfClient(c.id);
      return `
      <div class="bg-white rounded-xl shadow-sm p-4 relative">
        <div class="grid grid-cols-6 gap-2 items-stretch">
          <button data-goto-client="${c.id}" class="goto-client-inventory ${isAdmin ? "col-span-5" : "col-span-6"} flex items-center gap-2 border rounded-lg p-2 hover:border-blue-400 hover:bg-blue-50 text-left">
            ${c.logoUrl
              ? `<img src="${c.logoUrl}" class="w-20 h-12 object-contain rounded shrink-0" alt="${c.name} logo"/>`
              : `<span class="text-3xl shrink-0">🏢</span>`}
            <span class="text-sm font-semibold text-slate-800">${c.name}</span>
          </button>
          ${isAdmin ? `<button data-edit-client="${c.id}" class="edit-client-btn col-span-1 flex items-center justify-center border rounded-lg text-slate-400 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 text-xl">⚙</button>` : ""}
        </div>
        <div class="grid grid-cols-3 gap-2 mt-3">
          ${whs.map(w => {
            const lowStock = db.products.some(p => stockOf(p.id, w.id) > 0 && stockOf(p.id, w.id) < p.safetyStock);
            return `
            <button data-goto-warehouse="${w.id}" class="goto-warehouse-inventory w-full flex flex-col items-center gap-0.5 border rounded-lg p-2 hover:bg-slate-50 hover:text-blue-600">
              <span class="text-xl">📦${lowStock ? "⚠️" : ""}</span>
              <span class="text-[11px] truncate w-full text-center">${w.name}</span>
            </button>`;
          }).join("") || `<p class="text-xs text-slate-400 col-span-3 text-center">尚無倉庫</p>`}
        </div>
      </div>`;
    }).join("") || `<p class="text-slate-400 text-sm">尚無資料</p>`}
  </div>`;
}

function bindHome() {
  const u = currentUser();
  document.querySelectorAll(".goto-client-inventory").forEach(btn => {
    btn.onclick = () => {
      navigateTo({ page: "dashboard", filterClientId: btn.dataset.gotoClient, filterWarehouseId: null });
    };
  });
  bindGotoWarehouseButtons();
  if (u.role !== "admin") return;
  document.getElementById("add-client-btn").onclick = () => {
    draftNewClient = { name: "", contact: "", phone: "", address: "", logoUrl: "", warehouses: [...STANDARD_WAREHOUSE_NAMES] };
    navigateTo({ page: "client-new" });
  };
  document.querySelectorAll(".edit-client-btn").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      navigateTo({ page: "client-settings", editClientId: btn.dataset.editClient });
    };
  });
}

// ---- 客戶設定（管理員：編輯聯絡資料、LOGO、管理倉庫） ----
function renderClientSettings() {
  const c = db.clients.find(x => x.id === view.editClientId);
  if (!c) return `<p class="text-slate-400">找不到客戶</p>`;
  const whs = warehousesOfClient(c.id);

  return `
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl items-stretch">
    <div class="bg-white rounded-xl shadow-sm p-6 flex flex-col">
      <p class="font-semibold text-sm text-slate-700 mb-3">LOGO</p>
      <div class="flex items-center gap-3 mb-4">
        ${c.logoUrl
          ? `<img src="${c.logoUrl}" class="w-40 h-14 object-contain rounded" alt="${c.name} logo"/>`
          : `<span class="text-3xl">🏢</span>`}
      </div>
      <label class="inline-block border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 cursor-pointer self-start">
        ${c.logoUrl ? "更換 LOGO" : "上傳 LOGO"}
        <input type="file" accept="image/*" class="hidden set-logo-input" data-client="${c.id}"/>
      </label>
    </div>

    <div class="bg-white rounded-xl shadow-sm p-6">
      <div class="flex items-center justify-between mb-3">
        <p class="font-semibold text-sm text-slate-700">倉庫管理</p>
        <button id="add-warehouse-btn" class="text-xs text-blue-600 hover:underline">＋ 新增倉庫</button>
      </div>
      <ul class="text-sm text-slate-600 space-y-2">
        ${whs.map(w => `
          <li class="flex items-center justify-between border rounded-lg px-3 py-2">
            <span>📦 ${w.name}</span>
            <span class="flex items-center gap-2">
              <button data-rename-warehouse="${w.id}" class="rename-warehouse-btn text-xs text-blue-600 hover:underline">改名</button>
              <button data-delete-warehouse="${w.id}" class="delete-warehouse-btn text-xs text-rose-500 hover:underline">刪除</button>
            </span>
          </li>`).join("") || `<li class="text-xs text-slate-400">尚無倉庫</li>`}
      </ul>
    </div>

    <div class="bg-white rounded-xl shadow-sm p-6 lg:col-span-2">
      <p class="font-semibold text-sm text-slate-700 mb-3">公司資料</p>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="text-xs text-slate-500">聯絡人</label>
          <input id="client-contact" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="${c.contact || ""}" placeholder="聯絡人姓名"/>
        </div>
        <div>
          <label class="text-xs text-slate-500">電話</label>
          <input id="client-phone" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="${c.phone || ""}" placeholder="聯絡電話"/>
        </div>
      </div>
      <div class="mb-3">
        <label class="text-xs text-slate-500">地址</label>
        <input id="client-address" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="${c.address || ""}" placeholder="公司地址"/>
      </div>
      <button id="save-client-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">儲存</button>
      <p id="client-settings-msg" class="text-xs hidden mt-2"></p>
    </div>

    ${c.id !== HOST_CLIENT_ID ? `
    <div class="bg-white rounded-xl shadow-sm p-6 border border-rose-200 lg:col-span-2">
      <p class="font-semibold text-sm text-rose-700 mb-2">刪除客戶</p>
      <p class="text-xs text-slate-500 mb-3">若客戶旗下任一倉庫尚有庫存，需先清空庫存才能刪除；刪除後會一併移除旗下所有倉庫。</p>
      <button id="delete-client-btn" class="border border-rose-300 text-rose-600 rounded-lg px-4 py-2 text-sm hover:bg-rose-50">刪除此客戶</button>
    </div>` : ""}
  </div>`;
}

function bindClientSettings() {
  const c = db.clients.find(x => x.id === view.editClientId);
  document.querySelector(".set-logo-input").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      c.logoUrl = reader.result;
      saveDB(db);
      render();
    };
    reader.readAsDataURL(file);
  };
  document.getElementById("save-client-btn").onclick = () => {
    c.contact = document.getElementById("client-contact").value.trim();
    c.phone = document.getElementById("client-phone").value.trim();
    c.address = document.getElementById("client-address").value.trim();
    saveDB(db);
    showMsg("client-settings-msg", "已儲存");
  };
  document.getElementById("add-warehouse-btn").onclick = () => {
    const name = prompt("請輸入倉庫名稱");
    if (!name) return;
    db.warehouses.push({ id: "w" + Date.now(), clientId: c.id, name });
    saveDB(db);
    render();
  };
  document.querySelectorAll(".rename-warehouse-btn").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.renameWarehouse;
      const wh = db.warehouses.find(w => w.id === id);
      const name = prompt("請輸入新的倉庫名稱", wh.name);
      if (!name) return;
      wh.name = name;
      saveDB(db);
      render();
    };
  });
  document.querySelectorAll(".delete-warehouse-btn").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.deleteWarehouse;
      const hasStock = db.serialUnits.some(s => s.warehouseId === id);
      if (hasStock) {
        alert("此倉庫尚有庫存（庫存不為 0），無法刪除，請先將庫存異動清空");
        return;
      }
      if (!confirm(`確定要刪除「${warehouseName(id)}」嗎？`)) return;
      db.warehouses = db.warehouses.filter(w => w.id !== id);
      db.serialUnits = db.serialUnits.filter(s => s.warehouseId !== id);
      saveDB(db);
      render();
    };
  });
  document.getElementById("delete-client-btn")?.addEventListener("click", () => {
    const whIds = warehouseIdsOfClient(c.id);
    const hasStock = db.serialUnits.some(s => whIds.includes(s.warehouseId));
    if (hasStock) {
      alert("此客戶旗下倉庫尚有庫存，無法刪除，請先將庫存異動清空");
      return;
    }
    if (!confirm(`確定要刪除客戶「${c.name}」嗎？此動作將一併移除旗下所有倉庫。`)) return;
    db.warehouses = db.warehouses.filter(w => w.clientId !== c.id);
    db.users = db.users.filter(u => u.clientId !== c.id);
    db.clients = db.clients.filter(x => x.id !== c.id);
    saveDB(db);
    view.page = "home";
    render();
  });
}

// ---- 新增客戶（管理員：填寫資料、上傳 LOGO，建立後自動配置六個標準倉庫） ----
let draftNewClient = { name: "", contact: "", phone: "", address: "", logoUrl: "", warehouses: [...STANDARD_WAREHOUSE_NAMES] };

function renderClientNew() {
  const c = draftNewClient;
  return `
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl items-stretch">
    <div class="bg-white rounded-xl shadow-sm p-6 flex flex-col">
      <p class="font-semibold text-sm text-slate-700 mb-3">LOGO</p>
      <div class="flex items-center gap-3 mb-4">
        ${c.logoUrl
          ? `<img src="${c.logoUrl}" class="w-40 h-14 object-contain rounded" alt="logo"/>`
          : `<span class="text-3xl">🏢</span>`}
      </div>
      <label class="inline-block border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 cursor-pointer self-start">
        ${c.logoUrl ? "更換 LOGO" : "上傳 LOGO"}
        <input type="file" accept="image/*" class="hidden set-new-logo-input"/>
      </label>
    </div>

    <div class="bg-white rounded-xl shadow-sm p-6">
      <div class="flex items-center justify-between mb-3">
        <p class="font-semibold text-sm text-slate-700">倉庫管理</p>
        <button id="add-new-client-warehouse-btn" class="text-xs text-blue-600 hover:underline">＋ 新增倉庫</button>
      </div>
      <ul class="text-sm text-slate-600 space-y-2">
        ${c.warehouses.map((name, i) => `
          <li class="flex items-center justify-between border rounded-lg px-3 py-2">
            <span>📦 ${name}</span>
            <span class="flex items-center gap-2">
              <button data-rename-new-warehouse="${i}" class="rename-new-client-warehouse-btn text-xs text-blue-600 hover:underline">改名</button>
              <button data-remove-new-warehouse="${i}" class="remove-new-client-warehouse-btn text-xs text-rose-500 hover:underline">移除</button>
            </span>
          </li>`).join("") || `<li class="text-xs text-slate-400">尚無倉庫</li>`}
      </ul>
    </div>

    <div class="bg-white rounded-xl shadow-sm p-6 lg:col-span-2">
      <p class="font-semibold text-sm text-slate-700 mb-3">公司資料</p>
      <div class="mb-3">
        <label class="text-xs text-slate-500">客戶公司名稱</label>
        <input id="new-client-name" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="${c.name}" placeholder="必填"/>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="text-xs text-slate-500">聯絡人</label>
          <input id="new-client-contact" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="${c.contact}" placeholder="聯絡人姓名"/>
        </div>
        <div>
          <label class="text-xs text-slate-500">電話</label>
          <input id="new-client-phone" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="${c.phone}" placeholder="聯絡電話"/>
        </div>
      </div>
      <div class="mb-3">
        <label class="text-xs text-slate-500">地址</label>
        <input id="new-client-address" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="${c.address}" placeholder="公司地址"/>
      </div>
      <button id="create-client-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">建立客戶</button>
      <p id="new-client-msg" class="text-xs hidden mt-2"></p>
    </div>
  </div>`;
}

function bindClientNew() {
  [["new-client-name", "name"], ["new-client-contact", "contact"], ["new-client-phone", "phone"], ["new-client-address", "address"]].forEach(([id, key]) => {
    document.getElementById(id).oninput = (e) => { draftNewClient[key] = e.target.value; };
  });
  document.querySelector(".set-new-logo-input").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      draftNewClient.logoUrl = reader.result;
      render();
    };
    reader.readAsDataURL(file);
  };
  document.getElementById("create-client-btn").onclick = () => {
    const name = document.getElementById("new-client-name").value.trim();
    if (!name) { showMsg("new-client-msg", "請輸入客戶公司名稱", true); return; }
    const clientId = "c" + Date.now();
    db.clients.push({
      id: clientId,
      name,
      contact: document.getElementById("new-client-contact").value.trim(),
      phone: document.getElementById("new-client-phone").value.trim(),
      address: document.getElementById("new-client-address").value.trim(),
      logoUrl: draftNewClient.logoUrl || undefined,
    });
    draftNewClient.warehouses.forEach(whName => {
      db.warehouses.push({ id: "w" + Date.now() + Math.random().toString(36).slice(2, 6), clientId, name: whName });
    });
    saveDB(db);
    draftNewClient = { name: "", contact: "", phone: "", address: "", logoUrl: "", warehouses: [...STANDARD_WAREHOUSE_NAMES] };
    view.page = "home";
    render();
  };
  document.getElementById("add-new-client-warehouse-btn").onclick = () => {
    const name = prompt("請輸入倉庫名稱");
    if (!name) return;
    draftNewClient.warehouses.push(name);
    render();
  };
  document.querySelectorAll(".remove-new-client-warehouse-btn").forEach(btn => {
    btn.onclick = () => {
      draftNewClient.warehouses.splice(+btn.dataset.removeNewWarehouse, 1);
      render();
    };
  });
  document.querySelectorAll(".rename-new-client-warehouse-btn").forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.renameNewWarehouse;
      const name = prompt("請輸入新的倉庫名稱", draftNewClient.warehouses[idx]);
      if (!name) return;
      draftNewClient.warehouses[idx] = name;
      render();
    };
  });
}

// ---- 客戶儀表板（庫存總覽頁面：某客戶的整體狀況） ----
function isTodayTimestamp(timestamp) {
  const todayPrefix = new Date().toLocaleString("zh-TW", { hour12: false }).split(" ")[0];
  return timestamp.startsWith(todayPrefix);
}

function renderClientDashboard(client, whIds) {
  const todayMovements = db.movements.filter(m => whIds.includes(m.warehouseId) && isTodayTimestamp(m.timestamp));
  const todayIn = todayMovements.filter(m => m.type === "inbound").reduce((s, m) => s + m.delta, 0);
  const todayOut = todayMovements.filter(m => m.type === "outbound").reduce((s, m) => s - m.delta, 0);
  const todayTransfer = todayMovements.filter(m => m.type === "transfer_in" || m.type === "transfer_out").length;

  const whs = warehousesOfClient(client.id);
  const totalItems = db.products.filter(p => totalStock(p.id, whIds) > 0).length;
  const lowStockItems = db.products.filter(p => {
    const qty = totalStock(p.id, whIds);
    return qty > 0 && qty < p.safetyStock;
  }).length;

  return `
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
    <div class="bg-white rounded-xl shadow-sm p-4">
      <p class="text-xs text-slate-400">倉庫數</p>
      <p class="text-2xl font-bold text-slate-800 mt-1">${whs.length}</p>
    </div>
    <div class="bg-white rounded-xl shadow-sm p-4">
      <p class="text-xs text-slate-400">在庫品項數</p>
      <p class="text-2xl font-bold text-slate-800 mt-1">${totalItems}</p>
    </div>
    <div class="bg-white rounded-xl shadow-sm p-4">
      <p class="text-xs text-slate-400">低於安全庫存</p>
      <p class="text-2xl font-bold ${lowStockItems ? "text-rose-600" : "text-slate-800"} mt-1">${lowStockItems}</p>
    </div>
    <div class="bg-white rounded-xl shadow-sm p-4">
      <p class="text-xs text-slate-400">今日異動</p>
      <p class="text-2xl font-bold text-slate-800 mt-1">${todayMovements.length}</p>
      <p class="text-[11px] text-slate-400 mt-0.5">入庫 +${todayIn}　出庫 -${todayOut}　調撥 ${todayTransfer}</p>
    </div>
  </div>

  <p class="font-semibold text-sm text-slate-700 mb-2">各倉庫庫存狀況</p>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
    ${whs.map(w => {
      const itemCount = db.products.filter(p => stockOf(p.id, w.id) > 0).length;
      const lowCount = db.products.filter(p => stockOf(p.id, w.id) > 0 && stockOf(p.id, w.id) < p.safetyStock).length;
      const totalQty = db.products.reduce((s, p) => s + stockOf(p.id, w.id), 0);
      return `
      <button data-goto-warehouse="${w.id}" class="goto-warehouse-inventory bg-white rounded-xl shadow-sm p-3 text-left hover:ring-2 hover:ring-blue-400">
        <p class="text-sm font-medium text-slate-700">📦 ${w.name}</p>
        <p class="text-xs text-slate-400 mt-1">${itemCount} 個品項　共 ${totalQty} 件</p>
        ${lowCount ? `<p class="text-xs text-rose-500 mt-0.5">⚠️ ${lowCount} 項低於安全庫存</p>` : ""}
      </button>`;
    }).join("") || `<p class="text-xs text-slate-400 col-span-4">尚無倉庫</p>`}
  </div>

  <p class="font-semibold text-sm text-slate-700 mb-2">今日異動明細</p>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">時間</th><th class="px-4 py-2">倉庫</th><th class="px-4 py-2">類型</th><th class="px-4 py-2">Material</th><th class="px-4 py-2">序號</th><th class="px-4 py-2">數量</th></tr>
      </thead>
      <tbody>
        ${todayMovements.slice(0, 10).map(m => `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 text-xs text-slate-500">${m.timestamp}</td>
            <td class="px-4 py-2">${warehouseName(m.warehouseId)}</td>
            <td class="px-4 py-2">${TYPE_LABEL[m.type] || m.type}</td>
            <td class="px-4 py-2 font-mono text-xs">${productSkuOf(m.productId)}</td>
            <td class="px-4 py-2 font-mono text-xs">${m.serialNo || "-"}</td>
            <td class="px-4 py-2 font-semibold ${m.delta < 0 ? "text-rose-600" : "text-emerald-600"}">${m.delta > 0 ? "+" : ""}${m.delta}</td>
          </tr>`).join("") || `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">今天還沒有異動</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---- 客戶儀表板頁面 ----
function renderDashboardPage() {
  const u = currentUser();
  const clientId = u.role === "admin" ? view.filterClientId : u.clientId;
  const client = clientId ? db.clients.find(c => c.id === clientId) : null;
  if (!client) return `<p class="text-slate-400">請從總覽點選一間客戶公司</p>`;
  const whIds = warehouseIdsOfClient(client.id);

  return `
  <div class="flex items-center gap-2 mb-4">
    ${client.logoUrl
      ? `<img src="${client.logoUrl}" class="w-20 h-12 object-contain rounded shrink-0" alt="${client.name} logo"/>`
      : `<span class="text-3xl shrink-0">🏢</span>`}
    <p class="font-semibold text-slate-800">${client.name}</p>
  </div>
  ${renderClientDashboard(client, whIds)}`;
}

function bindDashboardPage() {
  bindGotoWarehouseButtons();
}

// ---- 共用：多選篩選核取方塊 ----
// 依目前選擇的客戶（可複選）縮小倉庫選項範圍；倉庫名稱重複時在前面標註客戶名稱以利區分
function buildWarehouseFilterOptions(whIds, selectedClientIds) {
  let ids = whIds;
  if (selectedClientIds && selectedClientIds.length) {
    ids = ids.filter(id => selectedClientIds.includes(clientOfWarehouse(id)));
  }
  const nameCounts = {};
  ids.forEach(id => {
    const n = warehouseName(id);
    nameCounts[n] = (nameCounts[n] || 0) + 1;
  });
  return ids.map(id => {
    const n = warehouseName(id);
    const label = nameCounts[n] > 1 ? `${clientName(clientOfWarehouse(id))}－${n}` : n;
    return { id, name: label };
  });
}

function renderCheckboxFilterGroup(prefixClass, options, selectedIds, emptyLabel) {
  return `
  <div class="border rounded-lg p-2 max-h-[104px] overflow-auto w-48">
    ${options.map(o => `
      <label class="flex items-center gap-1.5 text-xs py-0.5 cursor-pointer">
        <input type="checkbox" class="${prefixClass}" value="${o.id}" ${selectedIds.includes(o.id) ? "checked" : ""}/>
        <span class="truncate">${o.name}</span>
      </label>`).join("") || `<p class="text-xs text-slate-400">${emptyLabel}</p>`}
  </div>`;
}

// ---- 庫存總覽 ----
let inventoryFilter = { query: "", serialQuery: "", warehouseIds: [], clientIds: [], lowOnly: false };

function getFilteredInventoryRows() {
  const u = currentUser();
  const isAdmin = u.role === "admin";
  const filterWarehouseId = isAdmin
    ? view.filterWarehouseId
    : (view.filterWarehouseId && clientOfWarehouse(view.filterWarehouseId) === u.clientId ? view.filterWarehouseId : null);
  const whIds = filterWarehouseId
    ? [filterWarehouseId]
    : (isAdmin ? db.warehouses.map(w => w.id) : warehouseIdsOfClient(u.clientId));

  const groups = {};
  db.serialUnits.filter(s => whIds.includes(s.warehouseId)).forEach(s => {
    const key = s.productId + "|" + s.warehouseId;
    if (!groups[key]) groups[key] = { product: db.products.find(p => p.id === s.productId), warehouseId: s.warehouseId, qty: 0 };
    groups[key].qty++;
  });
  let rows = Object.values(groups);

  inventoryFilter.warehouseIds = inventoryFilter.warehouseIds.filter(id => whIds.includes(id));
  const q = inventoryFilter.query.trim().toLowerCase();
  if (q) rows = rows.filter(r => r.product.sku.toLowerCase().includes(q) || r.product.name.toLowerCase().includes(q));
  const sq = inventoryFilter.serialQuery.trim().toLowerCase();
  if (sq) {
    rows = rows.filter(r =>
      db.serialUnits.some(s => s.productId === r.product.id && s.warehouseId === r.warehouseId && s.serialNo && s.serialNo.toLowerCase().includes(sq))
    );
  }
  if (isAdmin && inventoryFilter.clientIds.length) rows = rows.filter(r => inventoryFilter.clientIds.includes(clientOfWarehouse(r.warehouseId)));
  if (inventoryFilter.warehouseIds.length) rows = rows.filter(r => inventoryFilter.warehouseIds.includes(r.warehouseId));
  if (inventoryFilter.lowOnly) rows = rows.filter(r => r.qty < r.product.safetyStock);

  return { rows, whIds, filterWarehouseId, isAdmin };
}

function renderInventory() {
  const u = currentUser();
  const { rows, whIds, filterWarehouseId, isAdmin } = getFilteredInventoryRows();
  const showClientCol = isAdmin && !filterWarehouseId;
  const headerClientId = filterWarehouseId
    ? clientOfWarehouse(filterWarehouseId)
    : (!isAdmin ? u.clientId : null);
  const headerClient = headerClientId ? db.clients.find(c => c.id === headerClientId) : null;

  const filterWarehouseOptions = buildWarehouseFilterOptions(whIds, isAdmin ? inventoryFilter.clientIds : []);
  const filterClientOptions = db.clients.map(c => ({ id: c.id, name: c.name }));

  return `
  ${headerClient ? `
  <div class="flex items-center gap-2 mb-4">
    ${headerClient.logoUrl
      ? `<img src="${headerClient.logoUrl}" class="w-20 h-12 object-contain rounded shrink-0" alt="${headerClient.name} logo"/>`
      : `<span class="text-3xl shrink-0">🏢</span>`}
    <p class="font-semibold text-slate-800">${headerClient.name}</p>
  </div>` : ""}
  <div class="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap items-start gap-4">
    <div>
      <label class="text-xs text-slate-500">搜尋 Material / 說明</label>
      <input id="inventory-filter-query" class="border rounded-lg px-3 py-2 text-sm mt-1 w-56 block" value="${inventoryFilter.query}" placeholder="輸入關鍵字"/>
      <label class="text-xs text-slate-500 mt-2 block">序號</label>
      <input id="inventory-filter-serial" class="border rounded-lg px-3 py-2 text-sm mt-1 w-56 block" value="${inventoryFilter.serialQuery}" placeholder="輸入序號"/>
    </div>
    ${isAdmin ? `
    <div>
      <label class="text-xs text-slate-500">客戶（可複選）</label>
      <div class="mt-1">${renderCheckboxFilterGroup("inventory-filter-client-checkbox", filterClientOptions, inventoryFilter.clientIds, "尚無客戶")}</div>
    </div>` : ""}
    ${filterWarehouseOptions.length > 1 ? `
    <div>
      <label class="text-xs text-slate-500">倉庫（可複選）</label>
      <div class="mt-1">${renderCheckboxFilterGroup("inventory-filter-warehouse-checkbox", filterWarehouseOptions, inventoryFilter.warehouseIds, "尚無倉庫")}</div>
    </div>` : ""}
    <label class="flex items-center gap-1.5 text-sm text-slate-600 py-2">
      <input type="checkbox" id="inventory-filter-low" ${inventoryFilter.lowOnly ? "checked" : ""}/> 只顯示低於安全庫存
    </label>
    <button id="inventory-filter-clear-btn" class="text-xs text-blue-600 hover:underline py-2.5">清除篩選</button>
    <button id="inventory-export-btn" class="border rounded-lg text-sm px-3 py-2 hover:bg-slate-100 ml-auto">📊 匯出 CSV</button>
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr>${showClientCol ? `<th class="px-4 py-2">客戶</th>` : ""}<th class="px-4 py-2">倉庫</th><th class="px-4 py-2">Material</th><th class="px-4 py-2">說明</th><th class="px-4 py-2">數量</th><th class="px-4 py-2">狀態</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const low = r.qty < r.product.safetyStock;
          return `
          <tr class="border-t hover:bg-slate-50">
            ${showClientCol ? `<td class="px-4 py-2">${clientName(clientOfWarehouse(r.warehouseId))}</td>` : ""}
            <td class="px-4 py-2">${warehouseName(r.warehouseId)}</td>
            <td class="px-4 py-2 font-mono text-xs">${r.product.sku}</td>
            <td class="px-4 py-2">${r.product.name}</td>
            <td class="px-4 py-2 font-semibold">${r.qty} ${r.product.unit}</td>
            <td class="px-4 py-2">${low ? `<span class="px-2 py-0.5 rounded-full text-xs bg-rose-100 text-rose-700">低於安全庫存</span>` : `<span class="px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700">正常</span>`}</td>
          </tr>`;
        }).join("") || `<tr><td colspan="${showClientCol ? 6 : 5}" class="px-4 py-8 text-center text-slate-400">尚無符合篩選條件的庫存資料</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function bindInventory() {
  document.getElementById("inventory-filter-query").oninput = (e) => {
    inventoryFilter.query = e.target.value;
    render();
    const el = document.getElementById("inventory-filter-query");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  document.getElementById("inventory-filter-serial").oninput = (e) => {
    inventoryFilter.serialQuery = e.target.value;
    render();
    const el = document.getElementById("inventory-filter-serial");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  document.querySelectorAll(".inventory-filter-warehouse-checkbox").forEach(cb => {
    cb.onchange = (e) => {
      if (e.target.checked) inventoryFilter.warehouseIds.push(e.target.value);
      else inventoryFilter.warehouseIds = inventoryFilter.warehouseIds.filter(id => id !== e.target.value);
      render();
    };
  });
  document.querySelectorAll(".inventory-filter-client-checkbox").forEach(cb => {
    cb.onchange = (e) => {
      if (e.target.checked) inventoryFilter.clientIds.push(e.target.value);
      else inventoryFilter.clientIds = inventoryFilter.clientIds.filter(id => id !== e.target.value);
      render();
    };
  });
  document.getElementById("inventory-filter-low").onchange = (e) => {
    inventoryFilter.lowOnly = e.target.checked;
    render();
  };
  document.getElementById("inventory-filter-clear-btn").onclick = () => {
    inventoryFilter = { query: "", serialQuery: "", warehouseIds: [], clientIds: [], lowOnly: false };
    render();
  };
  document.getElementById("inventory-export-btn").onclick = exportInventoryCSV;
}

function exportInventoryCSV() {
  const { rows } = getFilteredInventoryRows();
  const rowsOut = [["客戶", "倉庫", "Material", "Material description", "單位", "數量", "安全庫存", "狀態"]];
  rows.forEach(r => {
    const low = r.qty < r.product.safetyStock;
    rowsOut.push([
      clientName(clientOfWarehouse(r.warehouseId)), warehouseName(r.warehouseId),
      r.product.sku, r.product.name, r.product.unit, r.qty, r.product.safetyStock,
      low ? "低於安全庫存" : "正常",
    ]);
  });
  const csv = "﻿" + rowsOut.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `庫存總覽_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
}

function bindGotoWarehouseButtons() {
  document.querySelectorAll(".goto-warehouse-inventory").forEach(btn => {
    btn.onclick = () => {
      navigateTo({ page: "inventory", filterWarehouseId: btn.dataset.gotoWarehouse, filterClientId: null });
    };
  });
}

// ---- 異動紀錄 ----
let movementsFilter = { type: "", warehouseIds: [], clientIds: [], dateFrom: "", dateTo: "", query: "", serialQuery: "" };

function movementDateStr(m) {
  const [datePart] = m.timestamp.split(" ");
  const [y, mo, d] = datePart.split("/");
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function getFilteredMovements() {
  const u = currentUser();
  const isAdmin = u.role === "admin";
  let rows = [...visibleMovements()].sort((a, b) => b.id.localeCompare(a.id));
  if (movementsFilter.type) rows = rows.filter(m => m.type === movementsFilter.type);
  if (isAdmin && movementsFilter.clientIds.length) rows = rows.filter(m => movementsFilter.clientIds.includes(clientOfWarehouse(m.warehouseId)));
  if (movementsFilter.warehouseIds.length) rows = rows.filter(m => movementsFilter.warehouseIds.includes(m.warehouseId));
  if (movementsFilter.dateFrom) rows = rows.filter(m => movementDateStr(m) >= movementsFilter.dateFrom);
  if (movementsFilter.dateTo) rows = rows.filter(m => movementDateStr(m) <= movementsFilter.dateTo);
  const q = movementsFilter.query.trim().toLowerCase();
  if (q) {
    rows = rows.filter(m =>
      productSkuOf(m.productId).toLowerCase().includes(q) ||
      productName(m.productId).toLowerCase().includes(q) ||
      (m.note || "").toLowerCase().includes(q)
    );
  }
  const sq = movementsFilter.serialQuery.trim().toLowerCase();
  if (sq) rows = rows.filter(m => (m.serialNo || "").toLowerCase().includes(sq));
  return rows;
}

function renderMovements() {
  const u = currentUser();
  const isAdmin = u.role === "admin";
  const rows = getFilteredMovements();
  const baseWarehouseIds = (isAdmin ? db.warehouses : warehousesOfClient(u.clientId)).map(w => w.id);
  const warehouseOptions = buildWarehouseFilterOptions(baseWarehouseIds, isAdmin ? movementsFilter.clientIds : []);
  const clientOptions = db.clients.map(c => ({ id: c.id, name: c.name }));
  movementsFilter.warehouseIds = movementsFilter.warehouseIds.filter(id => baseWarehouseIds.includes(id));

  return `
  <div class="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap items-start gap-4">
    <div>
      <label class="text-xs text-slate-500">搜尋 Material / 備註</label>
      <input id="movements-filter-query" class="border rounded-lg px-3 py-2 text-sm mt-1 w-48 block" value="${movementsFilter.query}" placeholder="輸入關鍵字"/>
      <label class="text-xs text-slate-500 mt-2 block">序號</label>
      <input id="movements-filter-serial" class="border rounded-lg px-3 py-2 text-sm mt-1 w-48 block" value="${movementsFilter.serialQuery}" placeholder="輸入序號"/>
    </div>
    <div>
      <label class="text-xs text-slate-500">類型</label>
      <select id="movements-filter-type" class="border rounded-lg px-3 py-2 text-sm mt-1 block">
        <option value="">全部類型</option>
        ${Object.entries(TYPE_LABEL).map(([val, label]) => `<option value="${val}" ${movementsFilter.type === val ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>
    ${isAdmin ? `
    <div>
      <label class="text-xs text-slate-500">客戶（可複選）</label>
      <div class="mt-1">${renderCheckboxFilterGroup("movements-filter-client-checkbox", clientOptions, movementsFilter.clientIds, "尚無客戶")}</div>
    </div>` : ""}
    <div>
      <label class="text-xs text-slate-500">倉庫（可複選）</label>
      <div class="mt-1">${renderCheckboxFilterGroup("movements-filter-warehouse-checkbox", warehouseOptions, movementsFilter.warehouseIds, "尚無倉庫")}</div>
    </div>
    <div>
      <label class="text-xs text-slate-500">日期起</label>
      <input type="date" id="movements-filter-from" class="border rounded-lg px-3 py-2 text-sm mt-1 block" value="${movementsFilter.dateFrom}"/>
      <label class="text-xs text-slate-500 mt-2 block">日期迄</label>
      <input type="date" id="movements-filter-to" class="border rounded-lg px-3 py-2 text-sm mt-1 block" value="${movementsFilter.dateTo}"/>
    </div>
    <button id="movements-filter-clear-btn" class="text-xs text-blue-600 hover:underline py-2.5">清除篩選</button>
    <button id="export-btn" class="border rounded-lg text-sm px-3 py-2 hover:bg-slate-100 ml-auto">📊 匯出 CSV</button>
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr>
          <th class="px-4 py-2">時間</th>${u.role === "admin" ? `<th class="px-4 py-2">客戶</th>` : ""}<th class="px-4 py-2">倉庫</th>
          <th class="px-4 py-2">類型</th><th class="px-4 py-2">Material</th><th class="px-4 py-2">Material description</th><th class="px-4 py-2">序號</th>
          <th class="px-4 py-2">數量</th><th class="px-4 py-2">備註</th>${u.role === "admin" ? `<th class="px-4 py-2">操作人</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${rows.map(m => `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 text-xs text-slate-500">${m.timestamp}</td>
            ${u.role === "admin" ? `<td class="px-4 py-2">${clientName(clientOfWarehouse(m.warehouseId))}</td>` : ""}
            <td class="px-4 py-2">${warehouseName(m.warehouseId)}</td>
            <td class="px-4 py-2">${TYPE_LABEL[m.type] || m.type}</td>
            <td class="px-4 py-2 font-mono text-xs">${productSkuOf(m.productId)}</td>
            <td class="px-4 py-2">${productName(m.productId)}</td>
            <td class="px-4 py-2 font-mono text-xs">${m.serialNo || "-"}</td>
            <td class="px-4 py-2 font-semibold ${m.delta < 0 ? "text-rose-600" : "text-emerald-600"}">${m.delta > 0 ? "+" : ""}${m.delta}</td>
            <td class="px-4 py-2 text-slate-500">${m.note || "-"}</td>
            ${u.role === "admin" ? `<td class="px-4 py-2">${userName(m.operatorId)}</td>` : ""}
          </tr>`).join("") || `<tr><td colspan="${u.role === "admin" ? 10 : 8}" class="px-4 py-8 text-center text-slate-400">尚無符合篩選條件的異動紀錄</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---- 異動（管理員：即時入庫/出庫，需輸入序號） ----
let draftClientId = db.clients[0]?.id;
let draftWarehouseId = warehousesOfClient(draftClientId)[0]?.id;
let draftItems = [];
let draftMoveType = null;

function defaultDraftItem(type) {
  if (type === "outbound") {
    const avail = db.products.find(p => stockOf(p.id, draftWarehouseId) > 0);
    return { productId: avail?.id || "", serials: [], qty: 0 };
  }
  return { productId: "", serials: [], noSerial: false, qty: 1 };
}

function resetDraftForClient(clientId, type) {
  draftClientId = clientId;
  draftWarehouseId = warehousesOfClient(clientId)[0]?.id;
  draftItems = [defaultDraftItem(type)];
}

function findProductBySkuText(text, clientId) {
  const t = text.trim();
  const scoped = !clientId || clientId === HOST_CLIENT_ID;
  return db.products.find(p => p.sku === t && (scoped || p.clientId === clientId));
}
function productsOfClient(clientId) {
  if (clientId === HOST_CLIENT_ID) return db.products;
  return db.products.filter(p => p.clientId === clientId);
}

function renderMoveForm(type) {
  if (draftMoveType !== type) {
    draftMoveType = type;
    draftItems = [defaultDraftItem(type)];
  }
  const isOutbound = type === "outbound";
  const clientWarehouses = warehousesOfClient(draftClientId);
  const stockedProducts = isOutbound ? db.products.filter(p => stockOf(p.id, draftWarehouseId) > 0) : [];
  const canAddItems = !isOutbound || stockedProducts.length > 0;

  return `
  <div class="bg-white rounded-xl shadow-sm p-6 max-w-2xl space-y-4">
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label class="text-xs text-slate-500">客戶</label>
        <select id="move-client" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${db.clients.map(c => `<option value="${c.id}" ${c.id === draftClientId ? "selected" : ""}>${c.name}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">倉庫</label>
        <select id="move-warehouse" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${clientWarehouses.map(w => `<option value="${w.id}" ${w.id === draftWarehouseId ? "selected" : ""}>${w.name}</option>`).join("")}
        </select>
      </div>
    </div>
    <div>
      <label class="text-xs text-slate-500">備註</label>
      <input id="move-note" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
    </div>

    <div>
      <div class="flex items-center justify-between mb-2">
        <label class="text-xs text-slate-500">品項明細（有序號的料號請逐台輸入序號；無序號的料號請勾選「無序號」改用數量）</label>
        ${canAddItems ? `<button id="add-item-btn" class="text-xs text-blue-600 hover:underline">＋ 新增品項</button>` : ""}
      </div>
      ${!canAddItems ? `
        <p class="text-xs text-slate-400 border rounded-lg p-3">此倉庫目前沒有庫存商品可供出庫</p>
      ` : `
      <div id="items-list" class="space-y-3">
        ${draftItems.map((it, idx) => {
          const activeSerials = isOutbound ? activeSerialsOf(it.productId, draftWarehouseId) : [];
          const nonSerialAvail = isOutbound ? nonSerialStockOf(it.productId, draftWarehouseId) : 0;
          return `
          <div class="border rounded-lg p-3 space-y-2 item-row" data-idx="${idx}">
            <div class="flex gap-2 items-center">
              ${isOutbound ? `
                <select class="item-product border rounded-lg px-2 py-1.5 text-sm flex-1">
                  ${stockedProducts.map(p => `<option value="${p.id}" ${p.id === it.productId ? "selected" : ""}>${p.sku}－${p.name}（庫存 ${stockOf(p.id, draftWarehouseId)} ${p.unit}）</option>`).join("")}
                </select>
              ` : `
                <input type="text" list="product-datalist" value="${productSkuOf(it.productId)}" class="item-product-input border rounded-lg px-2 py-1.5 text-sm flex-1" placeholder="輸入或選擇料號"/>
                <label class="flex items-center gap-1 text-xs text-slate-500 whitespace-nowrap">
                  <input type="checkbox" class="no-serial-toggle" ${it.noSerial ? "checked" : ""}/> 無序號
                </label>
              `}
              <button class="remove-item text-rose-500 text-xs px-2 whitespace-nowrap">✕ 移除品項</button>
            </div>
            ${isOutbound ? `
              ${activeSerials.length ? `
                <div>
                  <label class="text-xs text-slate-500">勾選要出庫的序號</label>
                  <div class="grid grid-cols-2 gap-1 mt-1 max-h-32 overflow-auto border rounded-lg p-2">
                    ${activeSerials.map(s => `
                      <label class="flex items-center gap-1 text-xs">
                        <input type="checkbox" class="serial-checkbox" value="${s.serialNo}" ${it.serials.includes(s.serialNo) ? "checked" : ""}/>
                        <span class="truncate">${s.serialNo}</span>
                      </label>`).join("")}
                  </div>
                  <p class="text-xs text-slate-400 mt-1">已選 ${it.serials.length} 台</p>
                </div>
              ` : ""}
              ${nonSerialAvail > 0 ? `
                <div>
                  <label class="text-xs text-slate-500">無序號庫存（現有 ${nonSerialAvail} 個）</label>
                  <input type="number" min="0" max="${nonSerialAvail}" value="${it.qty || 0}" class="item-qty border rounded-lg px-2 py-1.5 text-sm w-32 mt-1" placeholder="出庫數量"/>
                </div>
              ` : ""}
              ${!activeSerials.length && !nonSerialAvail ? `<p class="text-xs text-slate-400">此商品在此倉庫無可用庫存</p>` : ""}
            ` : it.noSerial ? `
              <div>
                <label class="text-xs text-slate-500">數量</label>
                <input type="number" min="1" value="${it.qty}" class="item-qty border rounded-lg px-2 py-1.5 text-sm w-32 mt-1" placeholder="數量"/>
              </div>
            ` : `
              <div>
                <label class="text-xs text-slate-500">序號</label>
                <div class="flex gap-2 mt-1">
                  <input type="text" class="serial-input border rounded-lg px-2 py-1.5 text-sm flex-1" placeholder="輸入序號後按 Enter 或點新增"/>
                  <button class="add-serial-btn border rounded-lg px-3 py-1.5 text-xs hover:bg-slate-100 whitespace-nowrap">＋ 新增序號</button>
                </div>
                <div class="flex flex-wrap gap-1 mt-2">
                  ${it.serials.map((sn, sidx) => `
                    <span class="inline-flex items-center gap-1 bg-slate-100 rounded-full px-2 py-1 text-xs">
                      ${sn}<button class="remove-serial-btn text-rose-500" data-sidx="${sidx}">✕</button>
                    </span>`).join("") || `<span class="text-xs text-slate-400">尚未輸入序號</span>`}
                </div>
                <p class="text-xs text-slate-400 mt-1">共 ${it.serials.length} 台</p>
              </div>
            `}
          </div>`;
        }).join("")}
      </div>
      ${!isOutbound ? `
        <datalist id="product-datalist">
          ${productsOfClient(draftClientId).map(p => `<option value="${p.sku}">${p.name}</option>`).join("")}
        </datalist>
      ` : ""}
      `}
    </div>

    <button id="submit-move-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700" ${canAddItems ? "" : "disabled"}>送出${isOutbound ? "出庫" : "入庫"}（立即生效）</button>
    <p id="move-msg" class="text-xs hidden"></p>
  </div>`;
}

// ---- 調撥（管理員：同一客戶內部倉庫互相移轉庫存，含震浤本身） ----
let draftTransferClientId = db.clients[0]?.id;
let draftTransferFromWarehouseId = warehousesOfClient(draftTransferClientId)[0]?.id;
let draftTransferToWarehouseId = warehousesOfClient(draftTransferClientId)[1]?.id || draftTransferFromWarehouseId;
let draftTransferItems = [];

function defaultTransferItem() {
  const avail = db.products.find(p => stockOf(p.id, draftTransferFromWarehouseId) > 0);
  return { productId: avail?.id || "", serials: [], qty: 0 };
}

function resetTransferItems() {
  draftTransferItems = [defaultTransferItem()];
}

function renderTransferForm() {
  if (draftTransferItems.length === 0) resetTransferItems();
  const clientWarehouses = warehousesOfClient(draftTransferClientId);
  const stockedProducts = db.products.filter(p => stockOf(p.id, draftTransferFromWarehouseId) > 0);
  const canAddItems = stockedProducts.length > 0;
  const sameWarehouse = draftTransferFromWarehouseId && draftTransferFromWarehouseId === draftTransferToWarehouseId;

  return `
  <div class="bg-white rounded-xl shadow-sm p-6 max-w-2xl space-y-4">
    <div>
      <label class="text-xs text-slate-500">客戶（僅能在同一客戶內部倉庫互相調撥）</label>
      <select id="transfer-client" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
        ${db.clients.map(c => `<option value="${c.id}" ${c.id === draftTransferClientId ? "selected" : ""}>${c.name}</option>`).join("")}
      </select>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="border rounded-lg p-3">
        <p class="text-xs font-semibold text-slate-600 mb-2">調出（From）</p>
        <select id="transfer-from-warehouse" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${clientWarehouses.map(w => `<option value="${w.id}" ${w.id === draftTransferFromWarehouseId ? "selected" : ""}>${w.name}</option>`).join("")}
        </select>
      </div>
      <div class="border rounded-lg p-3">
        <p class="text-xs font-semibold text-slate-600 mb-2">調入（To）</p>
        <select id="transfer-to-warehouse" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${clientWarehouses.map(w => `<option value="${w.id}" ${w.id === draftTransferToWarehouseId ? "selected" : ""}>${w.name}</option>`).join("")}
        </select>
      </div>
    </div>
    ${sameWarehouse ? `<p class="text-xs text-rose-500">調出與調入倉庫不能相同</p>` : ""}
    <div>
      <label class="text-xs text-slate-500">備註</label>
      <input id="transfer-note" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
    </div>

    <div>
      <div class="flex items-center justify-between mb-2">
        <label class="text-xs text-slate-500">品項明細</label>
        ${canAddItems ? `<button id="add-transfer-item-btn" class="text-xs text-blue-600 hover:underline">＋ 新增品項</button>` : ""}
      </div>
      ${!canAddItems ? `
        <p class="text-xs text-slate-400 border rounded-lg p-3">「調出」倉庫目前沒有庫存商品可供調撥</p>
      ` : `
      <div id="transfer-items-list" class="space-y-3">
        ${draftTransferItems.map((it, idx) => {
          const activeSerials = activeSerialsOf(it.productId, draftTransferFromWarehouseId);
          const nonSerialAvail = nonSerialStockOf(it.productId, draftTransferFromWarehouseId);
          return `
          <div class="border rounded-lg p-3 space-y-2 transfer-item-row" data-idx="${idx}">
            <div class="flex gap-2 items-center">
              <select class="transfer-item-product border rounded-lg px-2 py-1.5 text-sm flex-1">
                ${stockedProducts.map(p => `<option value="${p.id}" ${p.id === it.productId ? "selected" : ""}>${p.sku}－${p.name}（庫存 ${stockOf(p.id, draftTransferFromWarehouseId)} ${p.unit}）</option>`).join("")}
              </select>
              <button class="remove-transfer-item text-rose-500 text-xs px-2 whitespace-nowrap">✕ 移除品項</button>
            </div>
            ${activeSerials.length ? `
              <div>
                <label class="text-xs text-slate-500">勾選要調撥的序號</label>
                <div class="grid grid-cols-2 gap-1 mt-1 max-h-32 overflow-auto border rounded-lg p-2">
                  ${activeSerials.map(s => `
                    <label class="flex items-center gap-1 text-xs">
                      <input type="checkbox" class="transfer-serial-checkbox" value="${s.serialNo}" ${it.serials.includes(s.serialNo) ? "checked" : ""}/>
                      <span class="truncate">${s.serialNo}</span>
                    </label>`).join("")}
                </div>
                <p class="text-xs text-slate-400 mt-1">已選 ${it.serials.length} 台</p>
              </div>
            ` : ""}
            ${nonSerialAvail > 0 ? `
              <div>
                <label class="text-xs text-slate-500">無序號庫存（現有 ${nonSerialAvail} 個）</label>
                <input type="number" min="0" max="${nonSerialAvail}" value="${it.qty || 0}" class="transfer-item-qty border rounded-lg px-2 py-1.5 text-sm w-32 mt-1" placeholder="調撥數量"/>
              </div>
            ` : ""}
            ${!activeSerials.length && !nonSerialAvail ? `<p class="text-xs text-slate-400">此商品在調出倉庫無可用庫存</p>` : ""}
          </div>`;
        }).join("")}
      </div>
      `}
    </div>

    <button id="submit-transfer-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700" ${canAddItems && !sameWarehouse ? "" : "disabled"}>送出調撥（立即生效）</button>
    <p id="transfer-msg" class="text-xs hidden"></p>
  </div>`;
}

function bindTransferForm() {
  document.getElementById("transfer-client").onchange = (e) => {
    draftTransferClientId = e.target.value;
    const whs = warehousesOfClient(draftTransferClientId);
    draftTransferFromWarehouseId = whs[0]?.id;
    draftTransferToWarehouseId = whs[1]?.id || whs[0]?.id;
    resetTransferItems();
    render();
  };
  document.getElementById("transfer-from-warehouse").onchange = (e) => {
    draftTransferFromWarehouseId = e.target.value;
    resetTransferItems();
    render();
  };
  document.getElementById("transfer-to-warehouse").onchange = (e) => {
    draftTransferToWarehouseId = e.target.value;
    render();
  };
  document.getElementById("add-transfer-item-btn")?.addEventListener("click", () => {
    draftTransferItems.unshift(defaultTransferItem());
    render();
  });
  document.querySelectorAll(".remove-transfer-item").forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.closest(".transfer-item-row").dataset.idx;
      draftTransferItems.splice(idx, 1);
      if (draftTransferItems.length === 0) draftTransferItems.push(defaultTransferItem());
      render();
    };
  });
  document.querySelectorAll(".transfer-item-product").forEach(sel => {
    sel.onchange = (e) => {
      const idx = +e.target.closest(".transfer-item-row").dataset.idx;
      draftTransferItems[idx].productId = e.target.value;
      draftTransferItems[idx].serials = [];
      draftTransferItems[idx].qty = 0;
      render();
    };
  });
  document.querySelectorAll(".transfer-serial-checkbox").forEach(cb => {
    cb.onchange = (e) => {
      const idx = +e.target.closest(".transfer-item-row").dataset.idx;
      const sn = e.target.value;
      if (e.target.checked) {
        if (!draftTransferItems[idx].serials.includes(sn)) draftTransferItems[idx].serials.push(sn);
      } else {
        draftTransferItems[idx].serials = draftTransferItems[idx].serials.filter(s => s !== sn);
      }
      render();
    };
  });

  document.getElementById("submit-transfer-btn")?.addEventListener("click", () => {
    if (draftTransferFromWarehouseId === draftTransferToWarehouseId) {
      showMsg("transfer-msg", "調出與調入倉庫不能相同", true);
      return;
    }
    const note = document.getElementById("transfer-note").value.trim();
    const rows = [...document.querySelectorAll(".transfer-item-row")];
    const items = [];
    for (const row of rows) {
      const idx = +row.dataset.idx;
      const productId = draftTransferItems[idx].productId;
      const serials = draftTransferItems[idx].serials;
      const qtyInput = row.querySelector(".transfer-item-qty");
      const qty = qtyInput ? Math.max(0, +qtyInput.value || 0) : 0;
      if (serials.length === 0 && qty === 0) {
        showMsg("transfer-msg", `請勾選序號或輸入調撥數量：${productName(productId)}`, true);
        return;
      }
      const nonSerialAvail = nonSerialStockOf(productId, draftTransferFromWarehouseId);
      if (qty > nonSerialAvail) {
        showMsg("transfer-msg", `無序號庫存不足：${productName(productId)} 僅剩 ${nonSerialAvail} 個`, true);
        return;
      }
      items.push({ productId, serials, qty });
    }

    const u = currentUser();
    items.forEach(it => {
      it.serials.forEach(sn => {
        applyTransfer(it.productId, draftTransferFromWarehouseId, draftTransferToWarehouseId, sn, 1, note, u.id);
      });
      if (it.qty > 0) {
        applyTransfer(it.productId, draftTransferFromWarehouseId, draftTransferToWarehouseId, null, it.qty, note, u.id);
      }
    });
    saveDB(db);
    resetTransferItems();
    view.page = "movements";
    render();
  });
}

// ---- 料號管理 ----
function renderProducts() {
  return `
  <div class="bg-white rounded-xl shadow-sm p-6 max-w-3xl mb-6">
    <p class="font-semibold text-sm text-slate-700 mb-3">新增料號</p>
    <div class="grid grid-cols-2 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">所屬客戶</label>
        <select id="new-client" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${db.clients.map(c => `<option value="${c.id}">${c.name}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">Material（料號）</label>
        <input id="new-sku" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：3AUA0000064885"/>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">單位</label>
        <input id="new-unit" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：PCS / 台 / 片" value="PCS"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">安全庫存</label>
        <input id="new-safety" type="number" min="0" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="0"/>
      </div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">Material description（料號說明，選填）</label>
      <input id="new-desc" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填，例：REV.K;CONTROL PANEL; ACS-AP-I MODULE"/>
    </div>
    <button id="add-product-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">新增料號</button>
    <p id="product-msg" class="text-xs hidden mt-2"></p>
  </div>

  <div class="flex items-center justify-between mb-2">
    <p class="text-sm text-slate-500">共 ${db.products.length} 個料號</p>
    <button id="export-products-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出料號 CSV</button>
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">所屬客戶</th><th class="px-4 py-2">Material</th><th class="px-4 py-2">Material description</th><th class="px-4 py-2">單位</th><th class="px-4 py-2">安全庫存</th><th class="px-4 py-2">總庫存</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        ${db.products.map(p => `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2">${clientName(p.clientId)}</td>
            <td class="px-4 py-2 font-mono text-xs">${p.sku}</td>
            <td class="px-4 py-2">${p.name}</td>
            <td class="px-4 py-2">${p.unit}</td>
            <td class="px-4 py-2">${p.safetyStock}</td>
            <td class="px-4 py-2 font-semibold">${totalStock(p.id)}</td>
            <td class="px-4 py-2 text-right"><button data-delete-product="${p.id}" class="delete-product-btn text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>`).join("") || `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">尚無料號</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---- 管理後台 ----
function renderAdmin() {
  return `
  <p class="text-xs text-slate-500 mb-4">客戶與倉庫的新增／刪除已整合到「總覽」首頁，這裡管理帳號與資料備份。</p>
  <div class="bg-white rounded-xl shadow-sm p-6 max-w-2xl">
    <p class="font-semibold text-sm text-slate-700 mb-3">帳號管理</p>
    <table class="w-full text-sm">
      <thead class="text-slate-400 text-left"><tr><th class="py-1">姓名</th><th class="py-1">信箱</th><th class="py-1">角色</th><th class="py-1">所屬客戶</th></tr></thead>
      <tbody>${db.users.map(u => `<tr class="border-t"><td class="py-1.5">${u.name}</td><td class="py-1.5">${u.email}</td><td class="py-1.5">${ROLE_LABEL[u.role]}</td><td class="py-1.5">${u.clientId ? clientName(u.clientId) : "-"}</td></tr>`).join("")}</tbody>
    </table>
  </div>

  <div class="bg-white rounded-xl shadow-sm p-6 max-w-2xl mt-6">
    <p class="font-semibold text-sm text-slate-700 mb-2">資料備份與還原</p>
    <p class="text-xs text-slate-500 mb-3">資料目前存在這台電腦瀏覽器裡，換到別台電腦不會自動同步。先「匯出備份」下載 JSON 檔，帶到另一台電腦後用「匯入還原」讀取，就能接著用同一份資料。</p>
    <div class="flex items-center gap-3">
      <button id="export-backup-btn" class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100">⬇ 匯出備份</button>
      <label class="border rounded-lg px-4 py-2 text-sm hover:bg-slate-100 cursor-pointer">
        ⬆ 匯入還原
        <input id="import-backup-input" type="file" accept="application/json" class="hidden"/>
      </label>
    </div>
    <p id="backup-msg" class="text-xs hidden mt-2"></p>
  </div>`;
}

// ---- 操作說明 ----
function renderHelpContent() {
  const rows = [
    ["執行入庫 / 出庫異動", "✓", "✕"],
    ["查看所有公司與倉庫", "✓", "✕"],
    ["查看自己公司倉庫內容", "✓", "✓"],
    ["管理帳號 / 客戶 / 倉庫 / 料號", "✓", "✕"],
    ["匯出 Excel", "✓", "✕"],
  ];
  return `
  <div class="max-w-4xl space-y-8">
    <div>
      <h2 class="text-lg font-bold text-slate-800 mb-4">操作說明</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-white rounded-xl shadow-sm p-5">
          <p class="font-semibold text-slate-800 mb-2">管理員</p>
          <ul class="text-sm text-slate-600 space-y-1 list-disc list-inside">
            <li>查看所有公司與倉庫（首頁總覽）</li>
            <li>執行異動：選擇客戶/倉庫、類型，輸入品項數量與序號後立即生效</li>
            <li>管理料號、帳號、客戶與倉庫</li>
            <li>匯出報表</li>
          </ul>
        </div>
        <div class="bg-white rounded-xl shadow-sm p-5">
          <p class="font-semibold text-slate-800 mb-2">客戶</p>
          <ul class="text-sm text-slate-600 space-y-1 list-disc list-inside">
            <li>查看自己公司與旗下倉庫（首頁總覽）</li>
            <li>查看自己公司倉庫的庫存總覽</li>
            <li>查看自己公司的異動紀錄</li>
            <li>純閱覽，無法新增/編輯</li>
          </ul>
        </div>
      </div>
    </div>

    <div>
      <h3 class="text-base font-bold text-slate-800 mb-3">權限說明</h3>
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-slate-100 text-slate-600 text-left">
            <tr><th class="px-4 py-2">功能</th><th class="px-4 py-2 text-center">管理員</th><th class="px-4 py-2 text-center">客戶</th></tr>
          </thead>
          <tbody>
            ${rows.map(r => `<tr class="border-t"><td class="px-4 py-2">${r[0]}</td><td class="px-4 py-2 text-center">${r[1]}</td><td class="px-4 py-2 text-center">${r[2]}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div>
      <h3 class="text-base font-bold text-slate-800 mb-3">異動流程</h3>
      <div class="flex flex-wrap gap-3 items-stretch">
        ${[
          ["1", "管理員選擇客戶/倉庫", "選擇入庫或出庫"],
          ["2", "輸入品項、數量、序號", "序號為必填"],
          ["3", "送出後立即生效", "庫存即時更新，並留下異動紀錄"],
          ["4", "客戶隨時查看", "登入查看自己公司倉庫的庫存與異動"],
        ].map(([n, title, sub], i, arr) => `
          <div class="flex items-center gap-3">
            <div class="bg-white rounded-xl shadow-sm p-4 w-48">
              <div class="w-6 h-6 rounded-full bg-slate-800 text-white text-xs flex items-center justify-center mb-2">${n}</div>
              <p class="text-sm font-semibold text-slate-800">${title}</p>
              <p class="text-xs text-slate-500 mt-1">${sub}</p>
            </div>
            ${i < arr.length - 1 ? `<span class="text-slate-300 text-xl">›</span>` : ""}
          </div>`).join("")}
      </div>
    </div>

    <div>
      <h3 class="text-base font-bold text-slate-800 mb-3">客戶與倉庫</h3>
      <div class="bg-white rounded-xl shadow-sm p-5 text-sm text-slate-600">
        系統以「客戶公司」為單位管理，一個客戶可以擁有多個倉庫。庫存直接以「商品 + 倉庫」為單位管理，不再細分儲位/架位。管理員可看到所有客戶與倉庫；客戶登入後只會看到自己公司旗下倉庫的內容，且為唯讀。
      </div>
    </div>
  </div>`;
}

// ---- 綁定事件 ----
function bindLayout() {
  document.getElementById("logout-btn").onclick = logout;
  document.getElementById("back-btn").onclick = goBack;
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.onclick = () => navigateTo({ page: btn.dataset.nav, filterClientId: null, filterWarehouseId: null });
  });
  document.getElementById("move-toggle-btn")?.addEventListener("click", () => {
    moveMenuOpen = !moveMenuOpen;
    render();
  });

  if (view.page === "home") bindHome();
  if (view.page === "dashboard") bindDashboardPage();
  if (view.page === "inventory") bindInventory();
  if (view.page === "client-settings") bindClientSettings();
  if (view.page === "client-new") bindClientNew();
  if (view.page === "movements") bindMovements();
  if (view.page === "move-in") bindMoveForm("inbound");
  if (view.page === "move-out") bindMoveForm("outbound");
  if (view.page === "move-transfer") bindTransferForm();
  if (view.page === "products") bindProducts();
  if (view.page === "admin") bindAdmin();
}

function bindMovements() {
  document.getElementById("export-btn")?.addEventListener("click", exportCSV);
  document.getElementById("movements-filter-query").oninput = (e) => {
    movementsFilter.query = e.target.value;
    render();
    const el = document.getElementById("movements-filter-query");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  document.getElementById("movements-filter-serial").oninput = (e) => {
    movementsFilter.serialQuery = e.target.value;
    render();
    const el = document.getElementById("movements-filter-serial");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  document.getElementById("movements-filter-type").onchange = (e) => {
    movementsFilter.type = e.target.value;
    render();
  };
  document.querySelectorAll(".movements-filter-warehouse-checkbox").forEach(cb => {
    cb.onchange = (e) => {
      if (e.target.checked) movementsFilter.warehouseIds.push(e.target.value);
      else movementsFilter.warehouseIds = movementsFilter.warehouseIds.filter(id => id !== e.target.value);
      render();
    };
  });
  document.querySelectorAll(".movements-filter-client-checkbox").forEach(cb => {
    cb.onchange = (e) => {
      if (e.target.checked) movementsFilter.clientIds.push(e.target.value);
      else movementsFilter.clientIds = movementsFilter.clientIds.filter(id => id !== e.target.value);
      render();
    };
  });
  document.getElementById("movements-filter-from").onchange = (e) => {
    movementsFilter.dateFrom = e.target.value;
    render();
  };
  document.getElementById("movements-filter-to").onchange = (e) => {
    movementsFilter.dateTo = e.target.value;
    render();
  };
  document.getElementById("movements-filter-clear-btn").onclick = () => {
    movementsFilter = { type: "", warehouseIds: [], clientIds: [], dateFrom: "", dateTo: "", query: "", serialQuery: "" };
    render();
  };
}

function showMsg(id, text, isError) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `text-xs ${isError ? "text-rose-600" : "text-emerald-600"}`;
}

// 把每個品項列裡「已輸入但還沒按 Enter / 新增序號」的序號文字，先併入 draftItems，
// 避免點擊「新增品項」等會重繪畫面的按鈕時，把使用者剛打好但尚未提交的序號洗掉
function commitPendingSerialInputs() {
  let blocked = null;
  document.querySelectorAll(".item-row").forEach(row => {
    const idx = +row.dataset.idx;
    const input = row.querySelector(".serial-input");
    if (!input) return;
    const val = input.value.trim();
    if (!val || !draftItems[idx] || draftItems[idx].serials.includes(val)) return;
    if (serialExistsAnywhere(val)) { blocked = val; return; }
    draftItems[idx].serials.push(val);
  });
  return blocked;
}

function bindMoveForm(type) {
  const isOutbound = type === "outbound";

  document.getElementById("move-client").onchange = (e) => {
    resetDraftForClient(e.target.value, type);
    render();
  };
  document.getElementById("move-warehouse").onchange = (e) => {
    draftWarehouseId = e.target.value;
    draftItems = [defaultDraftItem(type)];
    render();
  };
  document.getElementById("add-item-btn")?.addEventListener("click", () => {
    commitPendingSerialInputs();
    draftItems.unshift(defaultDraftItem(type));
    render();
  });
  document.querySelectorAll(".remove-item").forEach(btn => {
    btn.onclick = () => {
      commitPendingSerialInputs();
      const idx = +btn.closest(".item-row").dataset.idx;
      draftItems.splice(idx, 1);
      if (draftItems.length === 0) draftItems.push(defaultDraftItem(type));
      render();
    };
  });

  if (isOutbound) {
    document.querySelectorAll(".item-product").forEach(sel => {
      sel.onchange = (e) => {
        const idx = +e.target.closest(".item-row").dataset.idx;
        draftItems[idx].productId = e.target.value;
        draftItems[idx].serials = [];
        render();
      };
    });
    document.querySelectorAll(".serial-checkbox").forEach(cb => {
      cb.onchange = (e) => {
        const idx = +e.target.closest(".item-row").dataset.idx;
        const sn = e.target.value;
        if (e.target.checked) {
          if (!draftItems[idx].serials.includes(sn)) draftItems[idx].serials.push(sn);
        } else {
          draftItems[idx].serials = draftItems[idx].serials.filter(s => s !== sn);
        }
        render();
      };
    });
  } else {
    document.querySelectorAll(".item-product-input").forEach(inp => {
      inp.addEventListener("input", (e) => {
        const idx = +e.target.closest(".item-row").dataset.idx;
        const product = findProductBySkuText(e.target.value, draftClientId);
        draftItems[idx].productId = product?.id || "";
      });
    });
    document.querySelectorAll(".no-serial-toggle").forEach(cb => {
      cb.onchange = (e) => {
        const idx = +e.target.closest(".item-row").dataset.idx;
        draftItems[idx].noSerial = e.target.checked;
        draftItems[idx].serials = [];
        draftItems[idx].qty = 1;
        render();
      };
    });
    document.querySelectorAll(".item-row").forEach(row => {
      const idx = +row.dataset.idx;
      const input = row.querySelector(".serial-input");
      const addSerial = () => {
        const val = input.value.trim();
        if (!val) return;
        if (draftItems[idx].serials.includes(val)) { showMsg("move-msg", `序號重複：${val}`, true); return; }
        if (!isOutbound && serialExistsAnywhere(val)) { showMsg("move-msg", `序號已存在於庫存中，無法重複入庫：${val}`, true); return; }
        draftItems[idx].serials.push(val);
        render();
      };
      row.querySelector(".add-serial-btn")?.addEventListener("click", addSerial);
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addSerial(); }
      });
    });
    document.querySelectorAll(".remove-serial-btn").forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.closest(".item-row").dataset.idx;
        const sidx = +btn.dataset.sidx;
        draftItems[idx].serials.splice(sidx, 1);
        render();
      };
    });
  }

  document.getElementById("submit-move-btn")?.addEventListener("click", () => {
    if (!isOutbound) {
      const blockedSerial = commitPendingSerialInputs();
      if (blockedSerial) { showMsg("move-msg", `序號已存在於庫存中，無法重複入庫：${blockedSerial}`, true); return; }
    }
    const note = document.getElementById("move-note").value.trim();
    const rows = [...document.querySelectorAll(".item-row")];
    const items = [];
    for (const row of rows) {
      const idx = +row.dataset.idx;
      let productId;
      if (isOutbound) {
        productId = draftItems[idx].productId;
      } else {
        const text = row.querySelector(".item-product-input").value;
        const product = findProductBySkuText(text, draftClientId);
        if (!product) { showMsg("move-msg", `找不到屬於「${clientName(draftClientId)}」的料號：${text}`, true); return; }
        productId = product.id;
      }

      if (!isOutbound && draftItems[idx].noSerial) {
        const qty = Math.max(1, +row.querySelector(".item-qty").value || 1);
        items.push({ productId, serials: [], qty });
        continue;
      }

      if (isOutbound) {
        const serials = draftItems[idx].serials;
        const qtyInput = row.querySelector(".item-qty");
        const qty = qtyInput ? Math.max(0, +qtyInput.value || 0) : 0;
        if (serials.length === 0 && qty === 0) {
          showMsg("move-msg", `請勾選序號或輸入無序號出庫數量：${productName(productId)}`, true);
          return;
        }
        const nonSerialAvail = nonSerialStockOf(productId, draftWarehouseId);
        if (qty > nonSerialAvail) {
          showMsg("move-msg", `無序號庫存不足：${productName(productId)} 僅剩 ${nonSerialAvail} 個`, true);
          return;
        }
        items.push({ productId, serials, qty });
        continue;
      }

      const serials = draftItems[idx].serials;
      if (serials.length === 0) {
        showMsg("move-msg", `請輸入至少一個序號：${productName(productId)}`, true);
        return;
      }
      items.push({ productId, serials, qty: 0 });
    }

    if (!isOutbound) {
      for (const it of items) {
        for (const sn of it.serials) {
          if (serialExistsAnywhere(sn)) {
            showMsg("move-msg", `序號已存在於庫存中，無法重複入庫：${sn}`, true);
            return;
          }
        }
      }
      const allSerials = items.flatMap(it => it.serials);
      const dup = allSerials.find((sn, i) => allSerials.indexOf(sn) !== i);
      if (dup) { showMsg("move-msg", `本次輸入的序號重複：${dup}`, true); return; }
    }

    const u = currentUser();
    items.forEach(it => {
      it.serials.forEach(sn => {
        applyMovement(it.productId, draftWarehouseId, type, sn, 1, note, u.id);
      });
      if (it.qty > 0) {
        applyMovement(it.productId, draftWarehouseId, type, null, it.qty, note, u.id);
      }
    });
    saveDB(db);
    resetDraftForClient(draftClientId, type);
    view.page = "movements";
    render();
  });
}

function bindProducts() {
  document.getElementById("add-product-btn").onclick = () => {
    const clientId = document.getElementById("new-client").value;
    const sku = document.getElementById("new-sku").value.trim();
    const desc = document.getElementById("new-desc").value.trim();
    const unit = document.getElementById("new-unit").value.trim() || "PCS";
    const safetyStock = Math.max(0, +document.getElementById("new-safety").value || 0);

    if (!sku) { showMsg("product-msg", "請填寫料號", true); return; }
    if (db.products.some(p => p.sku === sku)) { showMsg("product-msg", "此料號已存在", true); return; }

    db.products.push({ id: "p" + Date.now(), sku, name: desc || sku, unit, safetyStock, clientId });
    saveDB(db);
    render();
  };
  document.querySelectorAll(".delete-product-btn").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.deleteProduct;
      if (db.serialUnits.some(s => s.productId === id)) {
        alert("此料號尚有庫存，無法刪除");
        return;
      }
      db.products = db.products.filter(p => p.id !== id);
      saveDB(db);
      render();
    };
  });
  document.getElementById("export-products-btn").onclick = exportProductsCSV;
}

function exportProductsCSV() {
  const rows = [["所屬客戶", "Material", "Material description", "單位", "安全庫存", "總庫存"]];
  db.products.forEach(p => rows.push([clientName(p.clientId), p.sku, p.name, p.unit, p.safetyStock, totalStock(p.id)]));
  const csv = "﻿" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `料號清單_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
}

function bindAdmin() {
  document.getElementById("export-backup-btn").onclick = () => {
    const json = JSON.stringify(db, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `倉管系統備份_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
  };

  document.getElementById("import-backup-input").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.users || !parsed.clients || !parsed.products) throw new Error("格式不符");
        if (!parsed.serialUnits) parsed.serialUnits = [];
        db = parsed;
        saveDB(db);
        showMsg("backup-msg", "匯入成功，資料已還原");
        setTimeout(() => { logout(); }, 800);
      } catch (err) {
        showMsg("backup-msg", "匯入失敗：檔案格式不正確", true);
      }
    };
    reader.readAsText(file);
  };
}

// ---- CSV 匯出 ----
function exportCSV() {
  const rows = [["時間", "客戶", "倉庫", "類型", "Material", "Material description", "序號", "數量", "備註", "操作人"]];
  getFilteredMovements().forEach(m => rows.push([
    m.timestamp, clientName(clientOfWarehouse(m.warehouseId)), warehouseName(m.warehouseId),
    TYPE_LABEL[m.type] || m.type, productSkuOf(m.productId), productName(m.productId), m.serialNo || "",
    m.delta, m.note || "", userName(m.operatorId),
  ]));
  const csv = "﻿" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `異動紀錄_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
}

render();
