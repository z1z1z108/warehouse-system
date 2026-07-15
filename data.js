// ---- 假資料庫 (localStorage 模擬後端) ----
const STORAGE_KEY = "warehouse_demo_db_v9";

const DEFAULT_DB = {
  users: [
    { id: "u2", name: "亞源科技聯絡人", email: "apd@wms.com", password: "apd123", role: "client", clientId: "c1" },
    { id: "u3", name: "菲邁爾聯絡人", email: "fimer@wms.com", password: "fimer123", role: "client", clientId: "c2" },
    { id: "u4", name: "台灣所樂能源聯絡人", email: "sle@wms.com", password: "sle123", role: "client", clientId: "c3" },
    { id: "u5", name: "友達光電聯絡人", email: "auo@wms.com", password: "auo123", role: "client", clientId: "c4" },
    { id: "u6", name: "震浤倉管理員", email: "zh@wms.com", password: "zh123", role: "admin", clientId: "c5" },
  ],
  // 客戶公司，一個客戶可以有多個倉庫
  clients: [
    { id: "c1", name: "亞源科技(APD)" },
    { id: "c2", name: "菲邁爾(FIMER)" },
    { id: "c3", name: "台灣所樂能源(SLE)" },
    { id: "c4", name: "友達光電(AUO)" },
    { id: "c5", name: "震浤倉(ZH)" }, // 本公司
  ],
  warehouses: [
    { id: "w1", clientId: "c1", name: "APD-倉庫1" },

    { id: "w2", clientId: "c2", name: "FIMER-倉庫1" },
    { id: "w3", clientId: "c2", name: "FIMER-倉庫2" },

    { id: "w4", clientId: "c3", name: "SLE-倉庫1" },
    { id: "w5", clientId: "c3", name: "SLE-倉庫2" },
    { id: "w6", clientId: "c3", name: "SLE-倉庫3" },

    { id: "w7", clientId: "c4", name: "AUO-倉庫1" },
    { id: "w8", clientId: "c4", name: "AUO-倉庫2" },
    { id: "w9", clientId: "c4", name: "AUO-倉庫3" },
    { id: "w10", clientId: "c4", name: "AUO-倉庫4" },

    { id: "w11", clientId: "c5", name: "ZH-倉庫1" },
    { id: "w12", clientId: "c5", name: "ZH-倉庫2" },
    { id: "w13", clientId: "c5", name: "ZH-倉庫3" },
    { id: "w14", clientId: "c5", name: "ZH-倉庫4" },
    { id: "w15", clientId: "c5", name: "ZH-倉庫5" },
  ],
  products: [
    { id: "p1", sku: "3AUA0000064885", name: "REV.K;CONTROL PANEL; ACS-AP-I MODULE; UN", unit: "個", safetyStock: 0 },
    { id: "p2", sku: "3AUA0000089109", name: "REV.Q;FENA-21; FENA-21; ETHERNET; ASSEMB", unit: "個", safetyStock: 0 },
    { id: "p3", sku: "3AUA0000110430", name: "REV.K;CONTROL UNIT; BCU-12; 7_CH; ASSEMB", unit: "個", safetyStock: 0 },
    { id: "p4", sku: "3AXD50000006010", name: "REV.A;MEMORY UNIT KIT; ZMU-02; .; ASSEMB", unit: "個", safetyStock: 0 },
    { id: "p5", sku: "3AXD50000022178", name: "REV.A;PLATE,STEEL;AC CABLE LEAD THROUGH;", unit: "個", safetyStock: 0 },
    { id: "p6", sku: "3AXD50000030914", name: "REV.A;PLATE,STAINLESS STEEL;AUX POWER LE", unit: "個", safetyStock: 0 },
    { id: "p7", sku: "3AXD50000030915", name: "REV.A;PLATE,STAINLESS STEEL;SIGNAL LEAD-", unit: "個", safetyStock: 0 },
    { id: "p8", sku: "3AXD50000031182", name: "REV.A;LEAD THROUGH ; SCG 2X3-35 SPLITTIN", unit: "個", safetyStock: 0 },
    { id: "p9", sku: "3AXD50000031183", name: "REV.A;LEAD THROUGH ; SCG 1X3-35 SPLITTIN", unit: "個", safetyStock: 0 },
    { id: "p10", sku: "3AXD50000036531", name: "REV.B;ASSEMBLY KIT ; POWER MODULE LIFTIN", unit: "個", safetyStock: 0 },
    { id: "p11", sku: "3AYN2073000-604", name: "POWER MODULE; IEC; PVS980-104SC-925A-7;6", unit: "個", safetyStock: 0 },
    { id: "p12", sku: "3M44990F001A", name: "TRIO-20.0-TL-OUTD-S2X-400;BRAND FIMER", unit: "個", safetyStock: 0 },
    { id: "p13", sku: "3M44990F201A", name: "TRIO-20.0-TL-OUTD-400;BRAND FIMER", unit: "個", safetyStock: 0 },
  ],
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
  return parsed;
}

function saveDB(db) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function resetDB() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DB));
}
