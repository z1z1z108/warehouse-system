// ---- 全域狀態 ----
let db = loadDB();
let session = JSON.parse(sessionStorage.getItem("wms_session") || "null");
let view = { page: "home" };

const ROLE_LABEL = { admin: "管理員", client: "客戶" };

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
function productUnit(id) { return db.products.find(p => p.id === id)?.unit || ""; }
function userName(id) { return db.users.find(u => u.id === id)?.name || "-"; }
function clientName(id) { return db.clients.find(c => c.id === id)?.name || "-"; }
function warehouseName(id) { return db.warehouses.find(w => w.id === id)?.name || "-"; }
function warehouseOf(id) { return db.warehouses.find(w => w.id === id); }
function clientOfWarehouse(warehouseId) { return warehouseOf(warehouseId)?.clientId; }
function warehousesOfClient(clientId) { return db.warehouses.filter(w => w.clientId === clientId); }
function warehouseIdsOfClient(clientId) { return warehousesOfClient(clientId).map(w => w.id); }

function stockOf(productId, warehouseId) {
  const rec = db.inventory.find(i => i.productId === productId && i.warehouseId === warehouseId);
  return rec ? rec.quantity : 0;
}
function totalStock(productId, warehouseIds) {
  return db.inventory
    .filter(i => i.productId === productId && (!warehouseIds || warehouseIds.includes(i.warehouseId)))
    .reduce((s, i) => s + i.quantity, 0);
}

function applyMovement(productId, warehouseId, delta, type, serialNo, note, operatorId) {
  let rec = db.inventory.find(i => i.productId === productId && i.warehouseId === warehouseId);
  if (!rec) { rec = { productId, warehouseId, quantity: 0 }; db.inventory.push(rec); }
  rec.quantity += delta;
  db.movements.unshift({
    id: "m" + Date.now() + Math.random().toString(36).slice(2, 6),
    productId, warehouseId, delta, type, serialNo, note, operatorId,
    timestamp: new Date().toLocaleString("zh-TW", { hour12: false }),
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
        ${u.role === "admin" ? `<button data-nav="move" class="nav-btn w-full text-left px-3 py-2 rounded hover:bg-slate-700">＋ 異動</button>` : ""}
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
    case "move": return renderMoveForm();
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
      const hasStock = db.inventory.some(i => i.warehouseId === id && i.quantity > 0);
      if (hasStock) {
        alert("此倉庫尚有庫存（庫存不為 0），無法刪除，請先將庫存異動清空");
        return;
      }
      if (!confirm(`確定要刪除「${warehouseName(id)}」嗎？`)) return;
      db.warehouses = db.warehouses.filter(w => w.id !== id);
      db.inventory = db.inventory.filter(i => i.warehouseId !== id);
      saveDB(db);
      render();
    };
  });
}

// ---- 庫存總覽 ----
function renderInventory() {
  const u = currentUser();
  const whIds = u.role === "admin" ? db.warehouses.map(w => w.id) : warehouseIdsOfClient(u.clientId);

  const rows = [];
  db.inventory.filter(i => i.quantity > 0 && whIds.includes(i.warehouseId)).forEach(i => {
    rows.push({ product: db.products.find(p => p.id === i.productId), warehouseId: i.warehouseId, qty: i.quantity });
  });

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
            <td class="px-4 py-2">${m.type === "inbound" ? "入庫" : "出庫"}</td>
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
let draftItems = [{ productId: db.products[0]?.id, qty: 1, serialNo: "" }];

function resetDraftForClient(clientId) {
  draftClientId = clientId;
  draftWarehouseId = warehousesOfClient(clientId)[0]?.id;
  draftItems = [{ productId: db.products[0]?.id, qty: 1, serialNo: "" }];
}

function renderMoveForm() {
  const clientWarehouses = warehousesOfClient(draftClientId);
  return `
  <h2 class="text-lg font-bold text-slate-800 mb-4">異動（即時入庫 / 出庫）</h2>
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
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label class="text-xs text-slate-500">異動類型</label>
        <select id="move-type" class="w-full border rounded-lg px-3 py-2 text-sm mt-1">
          <option value="inbound">入庫</option>
          <option value="outbound">出庫</option>
        </select>
      </div>
      <div>
        <label class="text-xs text-slate-500">備註</label>
        <input id="move-note" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="選填"/>
      </div>
    </div>

    <div>
      <div class="flex items-center justify-between mb-2">
        <label class="text-xs text-slate-500">品項明細（序號為必填）</label>
        <button id="add-item-btn" class="text-xs text-blue-600 hover:underline">＋ 新增品項</button>
      </div>
      <div id="items-list" class="space-y-2">
        ${draftItems.map((it, idx) => `
          <div class="flex gap-2 items-center item-row" data-idx="${idx}">
            <select class="item-product border rounded-lg px-2 py-1.5 text-sm flex-1">
              ${db.products.map(p => `<option value="${p.id}" ${p.id === it.productId ? "selected" : ""}>${p.sku}－${p.name}</option>`).join("")}
            </select>
            <input type="number" min="1" value="${it.qty}" class="item-qty border rounded-lg px-2 py-1.5 text-sm w-20" placeholder="數量"/>
            <input type="text" value="${it.serialNo}" class="item-serial border rounded-lg px-2 py-1.5 text-sm w-36" placeholder="序號（必填）"/>
            <button class="remove-item text-rose-500 text-xs px-2">✕</button>
          </div>`).join("")}
      </div>
    </div>

    <button id="submit-move-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">送出異動（立即生效）</button>
    <p id="move-msg" class="text-xs hidden"></p>
  </div>`;
}

// ---- 料號管理 ----
function renderProducts() {
  return `
  <h2 class="text-lg font-bold text-slate-800 mb-4">料號管理</h2>
  <div class="bg-white rounded-xl shadow-sm p-6 max-w-3xl mb-6">
    <p class="font-semibold text-sm text-slate-700 mb-3">新增料號</p>
    <div class="grid grid-cols-2 gap-3 mb-3">
      <div>
        <label class="text-xs text-slate-500">Material（料號）</label>
        <input id="new-sku" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：3AUA0000064885"/>
      </div>
      <div>
        <label class="text-xs text-slate-500">單位</label>
        <input id="new-unit" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：個 / 台 / 片" value="個"/>
      </div>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">Material description（料號說明）</label>
      <input id="new-desc" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" placeholder="例：REV.K;CONTROL PANEL; ACS-AP-I MODULE"/>
    </div>
    <div class="mb-3">
      <label class="text-xs text-slate-500">安全庫存</label>
      <input id="new-safety" type="number" min="0" class="w-full border rounded-lg px-3 py-2 text-sm mt-1" value="0"/>
    </div>
    <button id="add-product-btn" class="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700">新增料號</button>
    <p id="product-msg" class="text-xs hidden mt-2"></p>
  </div>

  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 text-slate-600 text-left">
        <tr><th class="px-4 py-2">Material</th><th class="px-4 py-2">Material description</th><th class="px-4 py-2">單位</th><th class="px-4 py-2">安全庫存</th><th class="px-4 py-2">總庫存</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        ${db.products.map(p => `
          <tr class="border-t hover:bg-slate-50">
            <td class="px-4 py-2 font-mono text-xs">${p.sku}</td>
            <td class="px-4 py-2">${p.name}</td>
            <td class="px-4 py-2">${p.unit}</td>
            <td class="px-4 py-2">${p.safetyStock}</td>
            <td class="px-4 py-2 font-semibold">${totalStock(p.id)}</td>
            <td class="px-4 py-2 text-right"><button data-delete-product="${p.id}" class="delete-product-btn text-rose-500 hover:underline text-xs">刪除</button></td>
          </tr>`).join("") || `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">尚無料號</td></tr>`}
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

  if (view.page === "home") bindHome();
  if (view.page === "movements") bindMovements();
  if (view.page === "move") bindMoveForm();
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

function bindMoveForm() {
  document.getElementById("move-client").onchange = (e) => {
    resetDraftForClient(e.target.value);
    render();
  };
  document.getElementById("move-warehouse").onchange = (e) => {
    draftWarehouseId = e.target.value;
    render();
  };
  document.getElementById("add-item-btn").onclick = () => {
    draftItems.push({ productId: db.products[0]?.id, qty: 1, serialNo: "" });
    render();
  };
  document.querySelectorAll(".remove-item").forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.closest(".item-row").dataset.idx;
      draftItems.splice(idx, 1);
      if (draftItems.length === 0) draftItems.push({ productId: db.products[0]?.id, qty: 1, serialNo: "" });
      render();
    };
  });

  document.getElementById("submit-move-btn").onclick = () => {
    const type = document.getElementById("move-type").value;
    const note = document.getElementById("move-note").value.trim();
    const items = [...document.querySelectorAll(".item-row")].map(row => ({
      productId: row.querySelector(".item-product").value,
      qty: Math.max(1, +row.querySelector(".item-qty").value || 1),
      serialNo: row.querySelector(".item-serial").value.trim(),
    }));

    if (items.some(it => !it.serialNo)) { showMsg("move-msg", "每個品項都必須填寫序號", true); return; }

    if (type === "outbound") {
      for (const it of items) {
        const avail = stockOf(it.productId, draftWarehouseId);
        if (it.qty > avail) {
          showMsg("move-msg", `庫存不足：${productName(it.productId)} 於 ${warehouseName(draftWarehouseId)} 僅剩 ${avail} ${productUnit(it.productId)}`, true);
          return;
        }
      }
    }

    const u = currentUser();
    const sign = type === "outbound" ? -1 : 1;
    items.forEach(it => {
      applyMovement(it.productId, draftWarehouseId, sign * it.qty, type, it.serialNo, note, u.id);
    });
    saveDB(db);
    resetDraftForClient(draftClientId);
    view.page = "movements";
    render();
  };
}

function bindProducts() {
  document.getElementById("add-product-btn").onclick = () => {
    const sku = document.getElementById("new-sku").value.trim();
    const desc = document.getElementById("new-desc").value.trim();
    const unit = document.getElementById("new-unit").value.trim() || "個";
    const safetyStock = Math.max(0, +document.getElementById("new-safety").value || 0);

    if (!sku || !desc) { showMsg("product-msg", "請填寫料號與說明", true); return; }
    if (db.products.some(p => p.sku === sku)) { showMsg("product-msg", "此料號已存在", true); return; }

    db.products.push({ id: "p" + Date.now(), sku, name: desc, unit, safetyStock });
    saveDB(db);
    render();
  };
  document.querySelectorAll(".delete-product-btn").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.deleteProduct;
      if (db.inventory.some(i => i.productId === id && i.quantity > 0)) {
        alert("此料號尚有庫存，無法刪除");
        return;
      }
      db.products = db.products.filter(p => p.id !== id);
      saveDB(db);
      render();
    };
  });
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
    m.type === "inbound" ? "入庫" : "出庫", productName(m.productId), m.serialNo || "",
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
