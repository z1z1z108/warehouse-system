// ---- 網頁內建對話框 ----
// 不用瀏覽器原生的 confirm／prompt／alert：有些瀏覽器環境（例如內嵌瀏覽器）會直接擋掉，
// 使用者按了按鈕卻什麼都沒發生。對話框掛在 body 上，不受 render() 重畫影響。

function openAppDialog({ message, input, defaultValue = "", okLabel = "確定", cancelLabel = "取消", danger = false, onOk, choices }) {
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "app-dialog fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40";

  const box = document.createElement("div");
  box.className = "bg-white rounded-xl shadow-xl w-full max-w-md p-5";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");

  const text = document.createElement("p");
  text.className = "text-sm text-slate-700 whitespace-pre-line";
  text.id = "app-dialog-text-" + Date.now();
  text.textContent = message;     // 用 textContent，訊息裡的客戶名稱等資料不會被當成 HTML
  box.setAttribute("aria-labelledby", text.id);
  box.appendChild(text);

  let field = null;
  if (input) {
    field = document.createElement("input");
    field.className = "w-full border rounded-lg px-3 py-2 text-sm mt-3";
    field.value = defaultValue;
    field.setAttribute("aria-labelledby", text.id);
    box.appendChild(field);
  }

  const actions = document.createElement("div");
  actions.className = "flex justify-end gap-2 mt-4";
  const close = () => {
    overlay.remove();
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };
  const cancel = () => close();
  const ok = () => { const value = field ? field.value : undefined; close(); if (onOk) onOk(value); };
  if (cancelLabel) {
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "border rounded-lg px-4 py-2 text-sm hover:bg-slate-100";
    cancelBtn.textContent = cancelLabel;
    cancelBtn.onclick = cancel;
    actions.appendChild(cancelBtn);
  }
  // choices：多個選項時，每個選項一顆按鈕，第一個是主要按鈕
  const optionList = choices && choices.length ? choices : [{ label: okLabel, onClick: () => { if (onOk) onOk(field ? field.value : undefined); } }];
  let okBtn = null;
  optionList.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = i === 0
      ? `rounded-lg px-4 py-2 text-sm font-medium text-white ${danger ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-800 hover:bg-slate-700"}`
      : "border rounded-lg px-4 py-2 text-sm hover:bg-slate-100";
    b.textContent = c.label;
    b.onclick = choices && choices.length ? () => { close(); c.onClick(); } : ok;
    actions.appendChild(b);
    if (i === 0) okBtn = b;
  });
  actions.classList.add("flex-wrap");
  box.appendChild(actions);
  overlay.appendChild(box);

  overlay.addEventListener("keydown", e => {
    if (e.isComposing || e.keyCode === 229) return;   // 注音／倉頡選字中的按鍵不處理
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter" && e.target === field) { e.preventDefault(); ok(); }
    else if (e.key === "Tab") {
      // Tab 只在對話框內循環
      const items = [...box.querySelectorAll("input, button")];
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
      e.preventDefault();
      items[next].focus();
    }
  });
  document.body.appendChild(overlay);
  if (field) { field.focus(); field.select(); }
  else okBtn.focus();
}

// 確認：按確定才執行 onOk。按 Enter 會按到確定鈕，所以刪除類動作請傳 danger: true 讓按鈕顯示紅色
function appConfirm(message, onOk, options = {}) {
  openAppDialog({ message, onOk, ...options });
}
// 多選一：choices = [{ label, onClick }]，按取消（cancelLabel）什麼都不做
function appChoice(message, choices, cancelLabel = "取消") {
  openAppDialog({ message, choices, cancelLabel });
}
// 輸入：按確定才會呼叫 onOk(輸入內容)，取消則不呼叫
function appPrompt(message, defaultValue, onOk) {
  openAppDialog({ message, input: true, defaultValue: defaultValue ?? "", onOk });
}
// 所有 alert() 都改成內建對話框
window.alert = message => openAppDialog({ message: String(message), cancelLabel: "" });
