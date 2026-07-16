// ---- 全域狀態 ----
let db = loadDB();
let session = JSON.parse(sessionStorage.getItem("wms_session") || "null");
let view = { page: "home" };
let moveMenuOpen = false;

const ROLE_LABEL = { admin: "管理員", client: "客戶" };
const TYPE_LABEL = { inbound: "入庫", outbound: "出庫", transfer_out: "調撥(出)", transfer_in: "調撥(入)" };

function currentUser() { return db.users.find(u => u.id === session?.userId); }

function login(email, password) {
  const u = db.users.find(x => x.email === email && x.password === password);
  if (!u) return false;
  session = { userId: u.id };
  sessionStorage.setItem("wms_session", JSON.stringify(session));
  return true;
}

function logout() {
  session = null;
  sessionStorage.removeItem("wms_session");
  view = { page: "home" };
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
        <button id="help-back-btn" class="text-sm text-blue-600 hover:underline mb-4">← 返回登入</button>
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
  <div class="min-h-screen flex">
    <aside class="w-56 bg-slate-800 text-slate-100 flex flex-col">
      <div class="p-5 border-b border-slate-700">
        <h1 class="font-bold text-lg">📦 震浤倉管系統</h1>
        <p class="text-xs text-slate-400 mt-1">${u.name}（${ROLE_LABEL[u.role]}）</p>
      </div>
      <nav class="flex-1 p-3 space-y-1 text-sm">
        <button data-nav="home" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">🏠 總覽</button>
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
    <main class="flex-1 p-6 overflow-auto">${renderPage()}</main>
  </div>`;
}

function renderPage() {
  switch (view.page) {
    case "home": return renderHome();
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
  const title = isAdmin ? "所有公司與倉庫" : "我的公司與倉庫";

  return `
  <div class="flex items-center justify-between mb-4">
    <h2 class="text-lg font-bold text-slate-800">${title}</h2>
    ${isAdmin ? `<button id="add-client-btn" class="text-xs text-blue-600 hover:underline">＋ 新增客戶</button>` : ""}
  </div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    ${clients.map(c => {
      const whs = warehousesOfClient(c.id);
      return `
      <div class="bg-white rounded-xl shadow-sm p-5">
        <div class="flex items-center justify-between mb-3">
          <p class="font-semibold text-slate-800">🏢 ${c.name}</p>
          ${isAdmin ? `<button data-add-warehouse="${c.id}" class="add-warehouse-btn text-xs text-blue-600 hover:underline">＋ 新增倉庫</button>` : ""}
        </div>
        <div class="space-y-2">
          ${whs.map(w => {
            const itemCount = db.products.filter(p => stockOf(p.id, w.id) > 0).length;
            const lowStock = db.products.filter(p => stockOf(p.id, w.id) > 0 && stockOf(p.id, w.id) < p.safetyStock).length;
            return `
            <div class="border rounded-lg p-3">
              <div class="flex items-center justify-between">
                <p class="text-sm font-medium text-slate-700">📦 ${w.name}</p>
                ${isAdmin ? `<button data-delete-warehouse="${w.id}" class="delete-warehouse-btn text-xs text-rose-500 hover:underline">刪除</button>` : ""}
              </div>
              <p class="text-xs text-slate-400 mt-0.5">${itemCount} 項商品在庫${lowStock ? `　<span class="text-rose-500">${lowStock} 項低於安全庫存</span>` : ""}</p>
            </div>`;
          }).join("") || `<p class="text-xs text-slate-400">尚無倉庫</p>`}
        </div>
      </div>`;
    }).join("") || `<p class="text-slate-400 text-sm">尚無資料</p>`}
  </div>`;
}

function bindHome() {
  const u = currentUser();
  if (u.role !== "admin") return;
  document.getElementById("add-client-btn").onclick = () => {
    const name = prompt("請輸入客戶公司名稱");
    if (!name) return;
    db.clients.push({ id: "c" + Date.now(), name });
    saveDB(db);
    render();
  };
  document.querySelectorAll(".add-warehouse-btn").forEach(btn => {
    btn.onclick = () => {
      const name = prompt("請輸入倉庫名稱");
      if (!name) return;
      db.warehouses.push({ id: "w" + Date.now(), clientId: btn.dataset.addWarehouse, name });
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
}

// ---- 庫存總覽 ----
function renderInventory() {
  const u = currentUser();
  const whIds = u.role === "admin" ? db.warehouses.map(w => w.id) : warehouseIdsOfClient(u.clientId);

  const groups = {};
  db.serialUnits.filter(s => whIds.includes(s.warehouseId)).forEach(s => {
    const key = s.productId + "|" + s.warehouseId;
    if (!groups[key]) groups[key] = { product: db.products.find(p => p.id === s.productId), warehouseId: s.warehouseId, qty: 0 };
    groups[key].qty++;
  });
  const rows = Object.values(groups);

  return `
  <h2 class="text-lg font-bold text-slate-800 mb-4">庫存總覽</h2>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr>${u.role === "admin" ? `<th class="px-4 py-2">客戶</th>` : ""}<th class="px-4 py-2">倉庫</th><th class="px-4 py-2">Material</th><th class="px-4 py-2">說明</th><th class="px-4 py-2">數量</th><th class="px-4 py-2">狀態</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const low = r.qty < r.product.safetyStock;
          return `
          <tr class="border-t hover:bg-slate-50">
            ${u.role === "admin" ? `<td class="px-4 py-2">${clientName(clientOfWarehouse(r.warehouseId))}</td>` : ""}
            <td class="px-4 py-2">${warehouseName(r.warehouseId)}</td>
            <td class="px-4 py-2 font-mono text-xs">${r.product.sku}</td>
            <td class="px-4 py-2">${r.product.name}</td>
            <td class="px-4 py-2 font-semibold">${r.qty} ${r.product.unit}</td>
            <td class="px-4 py-2">${low ? `<span class="px-2 py-0.5 rounded-full text-xs bg-rose-100 text-rose-700">低於安全庫存</span>` : `<span class="px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700">正常</span>`}</td>
          </tr>`;
        }).join("") || `<tr><td colspan="${u.role === "admin" ? 6 : 5}" class="px-4 py-8 text-center text-slate-400">尚無庫存資料</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// ---- 異動紀錄 ----
function renderMovements() {
  const u = currentUser();
  const rows = [...visibleMovements()].sort((a, b) => b.id.localeCompare(a.id));

  return `
  <div class="flex items-center justify-between mb-4">
    <h2 class="text-lg font-bold text-slate-800">異動紀錄</h2>
    ${u.role === "admin" ? `<button id="export-btn" class="border rounded-lg text-sm px-3 py-1.5 hover:bg-slate-100">📊 匯出 CSV</button>` : ""}
  </div>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr>
          <th class="px-4 py-2">時間</th>${u.role === "admin" ? `<th class="px-4 py-2">客戶</th>` : ""}<th class="px-4 py-2">倉庫</th>
          <th class="px-4 py-2">類型</th><th class="px-4 py-2">Material</th><th class="px-4 py-2">序號</th>
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
            <td class="px-4 py-2">${productName(m.productId)}</td>
            <td class="px-4 py-2 font-mono text-xs">${m.serialNo || "-"}</td>
            <td class="px-4 py-2 font-semibold ${m.delta < 0 ? "text-rose-600" : "text-emerald-600"}">${m.delta > 0 ? "+" : ""}${m.delta}</td>
            <td class="px-4 py-2 text-slate-500">${m.note || "-"}</td>
            ${u.role === "admin" ? `<td class="px-4 py-2">${userName(m.operatorId)}</td>` : ""}
          </tr>`).join("") || `<tr><td colspan="${u.role === "admin" ? 9 : 7}" class="px-4 py-8 text-center text-slate-400">尚無異動紀錄</td></tr>`}
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
  return db.products.find(p => p.sku === t && (!clientId || p.clientId === clientId));
}
function productsOfClient(clientId) {
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
  <h2 class="text-lg font-bold text-slate-800 mb-4">${isOutbound ? "出庫" : "入庫"}（即時異動）</h2>
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

// ---- 調撥（管理員：把庫存從一個倉庫移到另一個倉庫） ----
let draftTransferFromClientId = db.clients[0]?.id;
let draftTransferFromWarehouseId = warehousesOfClient(draftTransferFromClientId)[0]?.id;
let draftTransferToClientId = db.clients[0]?.id;
let draftTransferToWarehouseId = warehousesOfClient(draftTransferToClientId)[0]?.id;
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
  const fromWarehouses = warehousesOfClient(draftTransferFromClientId);
  const toWarehouses = warehousesOfClient(draftTransferToClientId);
  const stockedProducts = db.products.filter(p => stockOf(p.id, draftTransferFromWarehouseId) > 0);
  const canAddItems = stockedProducts.length > 0;
  const sameWarehouse = draftTransferFromWarehouseId && draftTransferFromWarehouseId === draftTransferToWarehouseId;

  return `
  <h2 class="text-lg font-bold text-slate-800 mb-4">調撥（倉庫間移轉庫存）</h2>
  <div class="bg-white rounded-xl shadow-sm p-6 max-w-2xl space-y-4">
    <div class="grid grid-cols-2 gap-4">
      <div class="border rounded-lg p-3">
        <p class="text-xs font-semibold text-slate-600 mb-2">調出（From）</p>
        <label class="text-xs text-slate-500">客戶</label>
        <select id="transfer-from-client" class="w-full border rounded-lg px-3 py-2 text-sm mt-1 mb-2">
          ${db.clients.map(c => `<option value="${c.id}" ${c.id === draftTransferFromClientId ? "selected" : ""}>${c.name}</option>`).join("")}
        </select>
        <label class="text-xs text-slate-500">倉庫</label>
        <select id="transfer-from-warehouse" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${fromWarehouses.map(w => `<option value="${w.id}" ${w.id === draftTransferFromWarehouseId ? "selected" : ""}>${w.name}</option>`).join("")}
        </select>
      </div>
      <div class="border rounded-lg p-3">
        <p class="text-xs font-semibold text-slate-600 mb-2">調入（To）</p>
        <label class="text-xs text-slate-500">客戶</label>
        <select id="transfer-to-client" class="w-full border rounded-lg px-3 py-2 text-sm mt-1 mb-2">
          ${db.clients.map(c => `<option value="${c.id}" ${c.id === draftTransferToClientId ? "selected" : ""}>${c.name}</option>`).join("")}
        </select>
        <label class="text-xs text-slate-500">倉庫</label>
        <select id="transfer-to-warehouse" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          ${toWarehouses.map(w => `<option value="${w.id}" ${w.id === draftTransferToWarehouseId ? "selected" : ""}>${w.name}</option>`).join("")}
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
  document.getElementById("transfer-from-client").onchange = (e) => {
    draftTransferFromClientId = e.target.value;
    draftTransferFromWarehouseId = warehousesOfClient(draftTransferFromClientId)[0]?.id;
    resetTransferItems();
    render();
  };
  document.getElementById("transfer-from-warehouse").onchange = (e) => {
    draftTransferFromWarehouseId = e.target.value;
    resetTransferItems();
    render();
  };
  document.getElementById("transfer-to-client").onchange = (e) => {
    draftTransferToClientId = e.target.value;
    draftTransferToWarehouseId = warehousesOfClient(draftTransferToClientId)[0]?.id;
    render();
  };
  document.getElementById("transfer-to-warehouse").onchange = (e) => {
    draftTransferToWarehouseId = e.target.value;
    render();
  };
  document.getElementById("add-transfer-item-btn")?.addEventListener("click", () => {
    draftTransferItems.push(defaultTransferItem());
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
  <h2 class="text-lg font-bold text-slate-800 mb-4">料號管理</h2>
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
        <input id="new-unit" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：個 / 台 / 片" value="個"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">安全庫存</label>
        <input id="new-safety" type="number" min="0" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="0"/>
      </div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">Material description（料號說明）</label>
      <input id="new-desc" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：REV.K;CONTROL PANEL; ACS-AP-I MODULE"/>
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
  <h2 class="text-lg font-bold text-slate-800 mb-4">管理後台</h2>
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
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.onclick = () => { view.page = btn.dataset.nav; render(); };
  });
  document.getElementById("move-toggle-btn")?.addEventListener("click", () => {
    moveMenuOpen = !moveMenuOpen;
    render();
  });

  if (view.page === "home") bindHome();
  if (view.page === "movements") bindMovements();
  if (view.page === "move-in") bindMoveForm("inbound");
  if (view.page === "move-out") bindMoveForm("outbound");
  if (view.page === "move-transfer") bindTransferForm();
  if (view.page === "products") bindProducts();
  if (view.page === "admin") bindAdmin();
}

function bindMovements() {
  document.getElementById("export-btn")?.addEventListener("click", exportCSV);
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
    draftItems.push(defaultDraftItem(type));
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
    const unit = document.getElementById("new-unit").value.trim() || "個";
    const safetyStock = Math.max(0, +document.getElementById("new-safety").value || 0);

    if (!sku || !desc) { showMsg("product-msg", "請填寫料號與說明", true); return; }
    if (db.products.some(p => p.sku === sku)) { showMsg("product-msg", "此料號已存在", true); return; }

    db.products.push({ id: "p" + Date.now(), sku, name: desc, unit, safetyStock, clientId });
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
  const rows = [["時間", "客戶", "倉庫", "類型", "Material", "序號", "數量", "備註", "操作人"]];
  visibleMovements().forEach(m => rows.push([
    m.timestamp, clientName(clientOfWarehouse(m.warehouseId)), warehouseName(m.warehouseId),
    TYPE_LABEL[m.type] || m.type, productName(m.productId), m.serialNo || "",
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
