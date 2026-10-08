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
};

function loadDB() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DB));
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  const parsed = JSON.parse(raw);
  if (!parsed.serialUnits) parsed.serialUnits = [];
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function resetDB() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DB));
}
