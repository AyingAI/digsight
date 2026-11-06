const state = {
  runs: [],
  currentId: null,
  summary: null,
  events: [],
  decomposition: null,
  analyses: {},
  engines: {},
  preflight: {},
  phases: {},
  conclusion: null,
  eventSource: null,
  selected: { concurrency: 2 },
  knownTitles: new Map(),
  expandedAnalyses: new Set(),
  clock: null,
  reportKey: null,
  loadingRuns: false,
  historyVersion: 0,
  setupError: false,
  savingModelSetup: false,
  loadingRun: false,
  submitting: false,
  setup: null,
  activeRunId: null,
  lastSeq: 0,
  renderFrame: null,
  summaryRequest: 0,
  defaultsApplied: false,
};
const renderKeys = new Map();
function unchanged(name, value) {
  const key = JSON.stringify(value);
  if (renderKeys.get(name) === key) return true;
  renderKeys.set(name, key);
  return false;
}

function connection(message = "") {
  const banner = document.querySelector("#connection-banner");
  banner.textContent = message;
  banner.hidden = !message;
}
function formError(message = "") {
  const error = document.querySelector("#form-error");
  error.textContent = message;
  error.hidden = !message;
}
function saveDraft(value) {
  try { value ? sessionStorage.setItem("digsight-draft", value) : sessionStorage.removeItem("digsight-draft"); } catch { /* storage may be blocked */ }
}

const PHASES = [
  ["preflight", "环境检查"],
  ["decompose", "问题拆解"],
  ["research", "并行调研"],
  ["verify", "引用核查"],
  ["analyze", "交叉推理"],
  ["synthesize", "结论合成"],
];

const ENGINE_LABEL = { deepseek: "DeepSeek", workbuddy: "WorkBuddy" };
const CUSTOM_MODEL_PROVIDER = "digsight-custom";
const ENGINE_DOT = { deepseek: "ds", workbuddy: "wb" };
const VERDICT_LABEL = {
  supported: "支持",
  partially_supported: "部分支持",
  refuted: "不支持",
  inconclusive: "证据不足",
};
const STATUS_LABEL = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const PHASE_LABEL = {
  init: "初始化",
  preflight: "环境检查",
  decompose: "问题拆解",
  research: "并行调研",
  verify: "引用核查",
  analyze: "交叉推理",
  synthesize: "结论合成",
  report: "生成报告",
  done: "完成",
  cleanup: "清理",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return `${min}m${rest ? `${rest}s` : ""}`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

function pct(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function verdictLabel(value) {
  return VERDICT_LABEL[value] || value || "未判定";
}

function engineLabel(value) {
  return ENGINE_LABEL[value] || value;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    signal: options.signal || AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

let toastTimer;
function showToast(message, type = "info", action) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  if (action) {
    const button = el("button", "", action.label);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      clearTimeout(toastTimer);
      try { await action.run(); } catch (error) { showToast(error.message, "error"); }
    });
    toast.append(button);
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, action ? 10000 : 4200);
}

/* -------------------------------------------------------------------------- */
/* Init                                                                       */
/* -------------------------------------------------------------------------- */

async function init() {
  bindComposer();
  bindTabs();
  bindGlobal();
  try { $("#question").value = sessionStorage.getItem("digsight-draft") || ""; } catch { /* optional draft */ }
  $("#question").dispatchEvent(new Event("input"));
  await Promise.all([loadRuns(), loadSetup()]);
  setInterval(() => {
    if (document.hidden) return;
    void loadRuns();
    if (state.currentId && state.summary?.active) refreshSummary(false).catch(() => connection("连接暂时中断，正在重试。已提交的任务仍可能在后台运行。"));
  }, 20000);
  const hash = location.hash.match(/^#run\/(.+)$/);
  if (hash) {
    await openRun(decodeURIComponent(hash[1]), { fallbackToComposer: true });
    return;
  }
  const active = state.runs.find((run) => run.id === state.activeRunId);
  if (active) {
    await openRun(active.id);
    return;
  }
  showComposer(false);
}

function closeHistory() { $("#history-toggle").setAttribute("aria-expanded", "false"); }
function showDialog(id) {
  closeHistory();
  $(id).showModal();
}
function showSetup() {
  if (!state.setup?.model.models.length) $("#credential-editor").open = true;
  showDialog("#setup-dialog");
}
function bindGlobal() {
  $("#history-toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.setAttribute("aria-expanded", String(button.getAttribute("aria-expanded") !== "true"));
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".sidebar")) closeHistory(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#history-toggle").getAttribute("aria-expanded") === "true") {
      closeHistory(); $("#history-toggle").focus();
    }
  });
  $("#brief-toggle").addEventListener("click", () => {
    const open = $("#run-brief").hidden;
    $("#run-brief").hidden = !open;
    $("#brief-toggle").setAttribute("aria-expanded", String(open));
  });
  $("#environment-button").addEventListener("click", showSetup);
  $("#settings-button").addEventListener("click", () => showDialog("#settings-dialog"));
  $("#configure-model").addEventListener("click", () => {
    $("#settings-dialog").close();
    $("#credential-editor").open = true;
    showSetup();
    $("#key-provider").focus();
  });
  $("#resolve-hint").addEventListener("click", (event) => {
    const target = event.currentTarget.dataset.target;
    if (target === "run") void openRun(state.activeRunId);
    else if (target === "#setup-dialog") showSetup();
    else showDialog(target);
  });
  for (const dialog of $$(".sheet")) {
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
    });
  }
  $("#settings-done").addEventListener("click", () => {
    if (!$("#max-citations").reportValidity()) return;
    if (!document.querySelector('input[name="engine"]:checked')) { $('input[name="engine"]').focus(); return; }
    $("#settings-dialog").close();
  });
  window.addEventListener("hashchange", () => {
    const hash = location.hash.match(/^#run\/(.+)$/);
    if (hash) {
      const id = decodeURIComponent(hash[1]);
      if (id !== state.currentId) openRun(id);
    } else if (state.currentId) {
      showComposer(false);
    }
  });
  window.addEventListener("offline", () => connection("网络已断开。请保持本地服务运行，恢复网络后会继续同步。"));
  window.addEventListener("online", () => { void loadRuns(); void loadSetup(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadRuns(); });
  $("#refresh-setup").addEventListener("click", () => { if (!state.savingModelSetup) void loadSetup(true); });
  $("#setup-dialog").addEventListener("close", () => {
    $("#provider-key").value = "";
    syncCredentialForm();
  });
  $("#key-provider").addEventListener("change", () => {
    $("#provider-key").value = "";
    fillCustomModelFields();
    showModelSetupStatus("");
    syncCredentialForm();
  });
  $("#credential-form").addEventListener("input", syncCredentialForm);
  $("#credential-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("#save-provider-key").disabled) return;
    const field = $("#provider-key");
    const provider = $("#key-provider").value;
    const custom = provider === CUSTOM_MODEL_PROVIDER;
    const body = { provider, apiKey: field.value.trim() };
    if (custom) {
      body.baseUrl = $("#custom-base-url").value.trim();
      body.modelId = $("#custom-model-id").value.trim();
    }
    field.value = "";
    const message = custom ? "已保存自定义模型。可以选择它作为默认模型。" : "API Key 已保存。实际授权和额度将在首次请求时确认。";
    void saveModelSetup("/api/setup/credentials", body, message, true);
  });
  $("#remove-provider-key").addEventListener("click", () => {
    const provider = $("#key-provider").value;
    const message = provider === CUSTOM_MODEL_PROVIDER ? "已移除自定义模型。" : "已移除 Digsight 保存的 API Key。";
    void saveModelSetup("/api/setup/credentials", { provider, remove: true }, message);
  });
  $("#setup-default-model").addEventListener("change", (event) => {
    if (event.target.value) void saveModelSetup("/api/setup/model", { model: event.target.value }, "已保存默认综合模型。");
  });
  $(".skip-link").addEventListener("click", (event) => { event.preventDefault(); $("#main").focus(); });
  $("#back-btn").addEventListener("click", () => showComposer(true));
  $("#new-run").addEventListener("click", () => showComposer(true));
}

function bindComposer() {
  const question = $("#question");
  const form = $("#run-form");
  const startBtn = $("#start-btn");
  const model = $("#model");
  const maxCitations = $("#max-citations");
  const verify = $("#verify");
  const keepSpace = $("#keep-space");

  question.addEventListener("input", () => {
    $("#char-count").textContent = `${question.value.length} / 4000`;
    $("#char-count").hidden = question.value.length < 3600;
    autoGrow(question);
    saveDraft(question.value);
    formError();
    updateStartState();
  });
  question.addEventListener("keydown", (event) => {
    if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  for (const button of $$(".segmented button")) {
    button.addEventListener("click", () => {
      const option = button.dataset.option;
      const value = Number(button.dataset.value);
      state.selected[option] = value;
      for (const sibling of $$(`.segmented button[data-option="${option}"]`)) {
        const active = sibling === button;
        sibling.classList.toggle("active", active);
        sibling.setAttribute("aria-checked", active ? "true" : "false");
      }
      updateStartState();
      for (const sibling of $$("button", button.parentElement)) sibling.tabIndex = sibling === button ? 0 : -1;
    });
    button.setAttribute("aria-checked", button.classList.contains("active") ? "true" : "false");
    button.tabIndex = button.classList.contains("active") ? 0 : -1;
  }
  for (const group of $$(".segmented")) bindArrowNavigation(group, "button");
  $("#question-count").addEventListener("change", updateStartState);
  model.addEventListener("change", () => {
    syncEnvironment();
    formError();
    updateStartState();
  });
  verify.addEventListener("change", updateStartState);
  maxCitations.addEventListener("input", updateStartState);
  for (const button of $$("[data-step]")) {
    button.addEventListener("click", () => {
      if (button.dataset.step === "1") maxCitations.stepUp(); else maxCitations.stepDown();
      maxCitations.dispatchEvent(new Event("input"));
    });
  }

  for (const checkbox of $$('input[name="engine"]')) {
    checkbox.addEventListener("change", updateStartState);
  }

  for (const sample of $$(".sample")) {
    sample.addEventListener("click", () => {
      question.value = sample.dataset.question || "";
      question.dispatchEvent(new Event("input"));
      question.focus();
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.submitting || startBtn.disabled || !form.reportValidity()) return;
    state.submitting = true;
    formError();
    startBtn.setAttribute("aria-busy", "true");
    const engines = $$('input[name="engine"]:checked').map((input) => input.value);
    const payload = {
      question: question.value.trim(),
      engines,
      subQuestionCount: $("#question-count").value === "auto" ? "auto" : Number($("#question-count").value),
      concurrency: state.selected.concurrency,
      model: model.value.trim() || undefined,
      maxCitations: Number(maxCitations.value) || 0,
      verifyCitations: verify.checked,
      keepSpace: keepSpace.checked,
    };
    startBtn.disabled = true;
    const label = startBtn.querySelector("span");
    const previous = label.textContent;
    label.textContent = "正在开始…";
    try {
      const data = await api("/api/runs", { method: "POST", body: JSON.stringify(payload) });
      showToast("运行已创建，正在打开浏览器…");
      state.activeRunId = data.runId;
      question.value = "";
      question.dispatchEvent(new Event("input"));
      await loadRuns();
      await openRun(data.runId);
    } catch (error) {
      if (error.status === 409 && error.data?.activeRunId) {
        showToast("已有调研正在运行，已为你打开该运行。", "error");
        await openRun(error.data.activeRunId);
      } else {
        formError(error.name === "TimeoutError" ? "请求超时，请先查看历史记录，确认是否已创建任务后再试。" : error.message);
        if (error.status === 422) void loadSetup(true);
      }
    } finally {
      state.submitting = false;
      startBtn.removeAttribute("aria-busy");
      label.textContent = previous;
      updateStartState();
    }
  });

  updateStartState();
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(300, Math.max(112, textarea.scrollHeight))}px`;
}

function updateStartState() {
  const button = $("#start-btn");
  const question = $("#question").value.trim();
  const engines = $$('input[name="engine"]:checked');
  const count = $("#question-count").value;
  const autoLimit = state.setup?.questionLimits?.auto;
  $("#question-budget").textContent = count === "auto" ? (autoLimit ? `由 Agent 按需拆成 1–${autoLimit} 个问题。` : "由 Agent 按问题复杂度决定。")
    : engines.length ? `${count} 个问题 × ${engines.length} 个引擎，最多 ${Number(count) * engines.length} 次网页调研。` : "";
  const citations = $("#max-citations");
  citations.disabled = !$("#verify").checked;
  $("#citation-row").hidden = citations.disabled;
  $('[data-step="-1"]').disabled = citations.disabled || citations.valueAsNumber <= 0;
  $('[data-step="1"]').disabled = citations.disabled || citations.valueAsNumber >= 30;
  $("#engine-error").hidden = Boolean(engines.length);

  let message = "", action = "", target = "";
  if (state.activeRunId) {
    message = "已有调研正在进行。"; action = "查看进度"; target = "run";
  } else if (state.setupError || (state.setup && (!state.setup.browser.ok || !hasModel()))) {
    if (state.setupError) {
      message = "未能连接本地服务。"; action = "查看环境";
    } else if (!hasModel()) {
      const hasChoices = state.setup.model.models.length > 0;
      message = hasChoices ? "请选择综合模型。" : "尚未连接综合模型。";
      action = hasChoices ? "选择模型" : "配置 API Key";
    } else {
      message = "未检测到 Ego Lite。"; action = "查看环境";
    }
    target = "#setup-dialog";
  } else if (state.setup && !state.setup.questionLimits) {
    message = "服务更新后可开始新调研。"; action = "重新检测"; target = "#setup-dialog";
  } else if (!engines.length || !citations.validity.valid) {
    message = !engines.length ? "至少选择一个调研引擎。" : "核查条数需为 0 至 30 的整数。";
    action = "调整设置"; target = "#settings-dialog";
  } else if (question.length && question.length < 6) {
    message = "问题至少需要 6 个字符。";
  } else if (question.length >= 6 && !state.setup) {
    message = "正在检测运行环境…";
  }
  $("#submit-hint").textContent = message;
  $("#feedback").hidden = !message;
  const resolve = $("#resolve-hint");
  resolve.hidden = !action;
  resolve.textContent = action;
  resolve.dataset.target = target;
  button.disabled = state.submitting || !state.setup || Boolean(message) || question.length < 6;
}

function hasModel() {
  const model = state.setup?.model;
  return Boolean(model && ($("#model").value ? model.models.some(m => m.id === $("#model").value) : model.ok));
}

function syncEnvironment() {
  const setup = state.setup;
  const ok = setup && hasModel() && setup.browser.ok;
  const modelId = $("#model").value || setup?.model.label;
  const currentModel = setup?.model.models.find(item => item.id === modelId);
  $("#environment-button").dataset.state = ok ? "ok" : "warn";
  $("#environment-status").textContent = ok ? "配置已检测" : setup ? "配置待完善" : "检测失败";
  $("#setup-model").textContent = currentModel ? modelOptionLabel(currentModel) : modelId || (setup ? "未配置" : "未检测");
  $("#setup-browser").textContent = setup ? setup.browser.ok ? setup.browser.version || "已检测到 Ego Lite" : "未检测到" : "未检测";
  $("#setup-note").textContent = !setup ? "请确认本地服务已启动，再重新检测。" : [
    !hasModel() && setup.model.error, !setup.browser.ok && setup.browser.error
  ].filter(Boolean).join(" ");
  $("#setup-note").hidden = !$("#setup-note").textContent;

}

function syncCredentialForm() {
  const busy = state.savingModelSetup || $("#refresh-setup").disabled;
  const providers = state.setup?.model.providers ?? [];
  const select = $("#key-provider");
  const provider = providers.find(item => item.id === select.value);
  const custom = provider?.id === CUSTOM_MODEL_PROVIDER;
  const base = $("#custom-base-url");
  const model = $("#custom-model-id");
  const field = $("#provider-key");
  const link = $("#provider-key-link");
  const remove = $("#remove-provider-key");
  select.disabled = busy || !providers.length;
  $("#custom-model-fields").hidden = !custom;
  base.disabled = model.disabled = busy || !custom;
  field.disabled = busy || !provider;
  field.required = !custom;
  field.placeholder = (custom ? state.setup.model.custom?.hasKey : provider?.configured)
    ? "已保存，输入新的 Key 可替换" : "粘贴提供商发放的 Key";
  $("#key-storage-note").textContent = custom
    ? "更换地址需填写新 Key。本机接口无需授权时可留空。"
    : "Key 保存在本机，保存后会加载该提供商的模型。";
  link.hidden = !provider?.keyUrl;
  if (provider?.keyUrl) link.href = provider.keyUrl;
  else link.removeAttribute("href");
  remove.hidden = !provider?.configured;
  remove.disabled = busy;
  remove.textContent = custom ? "移除自定义模型" : "移除本地 Key";
  const save = $("#save-provider-key");
  save.textContent = custom ? "保存自定义模型" : "保存 API Key";
  save.disabled = busy || !provider || (custom ? !base.value.trim() || !model.value.trim() : !field.value.trim());
  $("#setup-default-model").disabled = busy;
}

function fillCustomModelFields() {
  const custom = state.setup?.model.custom;
  $("#custom-base-url").value = custom?.baseUrl || "";
  $("#custom-model-id").value = custom?.modelId || "";
}

function modelOptionLabel(item) {
  return item.provider === CUSTOM_MODEL_PROVIDER ? `自定义 · ${item.name}` : item.id;
}

function populateModelSetup() {
  const model = state.setup?.model;
  const providerSelect = $("#key-provider");
  const selected = providerSelect.value;
  clear(providerSelect);
  providerSelect.append(new Option("选择提供商", ""));
  for (const provider of model?.providers ?? []) {
    providerSelect.append(new Option(provider.configured ? `${provider.name}（已保存）` : provider.name, provider.id));
  }
  if (model?.providers?.some(provider => provider.id === selected)) providerSelect.value = selected;
  const defaults = $("#setup-default-model");
  clear(defaults);
  const placeholder = new Option("选择默认模型", "");
  placeholder.disabled = true;
  defaults.append(placeholder);
  for (const item of model?.models ?? []) defaults.append(new Option(modelOptionLabel(item), item.id));
  defaults.value = model?.ok ? model.label : "";
  $("#setup-model-setting").hidden = !model?.models.length;
}

function showModelSetupStatus(message, error = false) {
  const status = $("#model-setup-status");
  status.textContent = message;
  status.hidden = !message;
  status.dataset.state = error ? "error" : "";
}

async function saveModelSetup(endpoint, body, success, focusModel = false) {
  if (state.savingModelSetup || $("#refresh-setup").disabled) return;
  state.savingModelSetup = true;
  syncCredentialForm();
  showModelSetupStatus("正在保存…");
  let saved = false;
  try {
    await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    saved = true;
    if (endpoint === "/api/setup/model") $("#model").value = "";
    await loadSetup(true);
    showModelSetupStatus(state.setupError ? "已保存配置。模型列表刷新失败，请重新检测。" : success, state.setupError);
  } catch (error) {
    populateModelSetup();
    showModelSetupStatus(error.status ? error.message : "连接中断。请重新检测，确认设置是否已保存。", true);
  } finally {
    state.savingModelSetup = false;
    syncCredentialForm();
    if (saved && focusModel && $("#setup-dialog").open && !$("#setup-model-setting").hidden) $("#setup-default-model").focus();
  }
}

function bindArrowNavigation(container, selector) {
  container.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const items = $$(selector, container);
    const index = items.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    items[next].click();
    items[next].focus();
  });
}

async function loadSetup(refresh = false) {
  const button = $("#refresh-setup");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "检测中…";
  syncCredentialForm();
  try {
    state.setup = await api(`/api/setup${refresh ? "?refresh=1" : ""}`);
    state.setupError = false;
    fillCustomModelFields();
    const { model, defaults } = state.setup;
    const select = $("#model");
    const selected = select.value;
    clear(select);
    const defaultModel = model.models.find(item => item.id === model.label);
    select.append(new Option(defaultModel ? `默认 · ${modelOptionLabel(defaultModel)}` : "请选择模型", ""));
    for (const item of model.models) select.append(new Option(modelOptionLabel(item), item.id));
    if (model.models.some((m) => m.id === selected)) select.value = selected;
    if (!state.defaultsApplied && defaults) {
      const countInput = $("#question-count");
      const limits = state.setup.questionLimits;
      if (limits) {
        for (let n = 1; n <= limits.manual; n++) countInput.append(new Option(`${n} 个`, String(n)));
        countInput.value = String(defaults.subQuestionCount);
      }
      for (const key of ["concurrency"]) {
        const group = $(`.segmented button[data-option="${key}"]`).parentElement;
        let button = $(`button[data-value="${defaults[key]}"]`, group);
        if (!button) {
          // Environment defaults outside the compact presets remain selectable.
          button = group.querySelector("button");
          button.dataset.value = String(defaults[key]);
          button.textContent = String(defaults[key]);
        }
        button.click();
      }
      $("#max-citations").value = defaults.maxCitations;
      $("#verify").checked = defaults.verifyCitations;
      $("#max-citations").disabled = !defaults.verifyCitations;
      $("#keep-space").checked = defaults.keepSpace;
      state.defaultsApplied = Boolean(limits);
    }
  } catch {
    state.setup = null;
    state.setupError = true;
  } finally {
    syncEnvironment();
    populateModelSetup();
    button.disabled = false;
    button.textContent = "重新检测";
    syncCredentialForm();
    updateStartState();
  }
}

/* -------------------------------------------------------------------------- */
/* Runs list                                                                  */
/* -------------------------------------------------------------------------- */

async function loadRuns() {
  if (state.loadingRuns) return;
  state.loadingRuns = true;
  const version = state.historyVersion;
  try {
    const data = await api("/api/runs");
    if (version !== state.historyVersion) return;
    state.runs = data.runs || [];
    state.activeRunId = data.activeRunId || null;
    connection();
    if (!state.activeRunId && state.setup && !state.setup.questionLimits) void loadSetup(true);
    renderSidebar();
    updateStartState();
  } catch (error) {
    connection("无法连接本地服务，正在重试。请确认 npm start 正在运行。你的问题草稿仍保留在当前标签页。");
  } finally {
    state.loadingRuns = false;
  }
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS(svg.namespaceURI, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

async function changeHistory(run, visible) {
  await api(`/api/runs/${encodeURIComponent(run.id)}/history`, { method: "POST", body: JSON.stringify({ visible }) });
  state.historyVersion++;
  state.runs = state.runs.filter(item => item.id !== run.id);
  if (visible) {
    state.runs.push(run);
    state.runs.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  if (!visible && state.currentId === run.id) showComposer(true);
  renderSidebar();
  showToast(visible ? "已恢复历史记录" : "已从历史记录移除", "info", visible ? null : {
    label:"撤销", run: () => changeHistory(run, true)
  });
}

function runTitle(run, id = run?.id) {
  return state.knownTitles.get(id) || run?.title ||
    (["queued", "running"].includes(run?.status) ? "正在准备调研" : run ? "未命名调研" : "正在读取调研");
}

function rememberTitle(id, title) {
  if (!title || title === state.knownTitles.get(id)) return;
  state.knownTitles.set(id, title);
  renderKeys.delete("sidebar");
  renderSidebar();
}

function renderSidebar() {
  if (unchanged("sidebar", [state.currentId, state.runs])) return;
  const list = $("#run-list");
  clear(list);
  if (!state.runs.length) {
    list.append(el("div", "side-empty", "暂无历史记录"));
    return;
  }
  for (const run of state.runs) {
    const button = el("button", "run-item");
    button.type = "button";
    if (run.id === state.currentId) { button.classList.add("active"); button.setAttribute("aria-current", "page"); }
    button.append(icon("file"), el("div", "q", runTitle(run)));

    const meta = el("div", "meta");
    const dot = el("span", `dot ${run.status}`);
    meta.append(dot, el("span", "", STATUS_LABEL[run.status] || run.status));
    meta.append(el("span", "history-date", formatDate(run.createdAt)));
    button.append(meta);
    button.addEventListener("click", () => openRun(run.id));
    const row = el("div", "history-row");
    row.append(button);
    if (!["running","queued"].includes(run.status) && run.id !== state.activeRunId) {
      const remove = el("button", "remove-run");
      remove.type = "button";
      remove.title = "从历史记录删除";
      remove.setAttribute("aria-label", `从历史记录删除：${runTitle(run)}`);
      remove.append(icon("bin"));
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try { await changeHistory(run, false); $("#toast button")?.focus({ preventScroll:true }); }
        catch (error) { remove.disabled = false; showToast(error.message, "error"); }
      });
      row.append(remove);
    }
    list.append(row);
  }
}

/* -------------------------------------------------------------------------- */
/* Open a run                                                                 */
/* -------------------------------------------------------------------------- */

async function openRun(runId, options = {}) {
  if (!runId) return;
  closeHistory();
  if (state.loadingRun && state.currentId === runId) return;
  const changed = state.currentId !== runId;
  if (changed) {
    closeEvents();
    state.expandedAnalyses.clear();
    state.currentId = runId;
    $("#run-brief").hidden = true;
    $("#brief-toggle").setAttribute("aria-expanded", "false");
    state.events = [];
    state.decomposition = null;
    state.analyses = {};
    state.engines = {};
    state.preflight = {};
    state.phases = {};
    state.conclusion = null;
    state.summary = null;
    state.reportKey = null;
    state.lastSeq = 0;
    renderKeys.clear();
    $("#report-frame").hidden = true;
    $("#report-frame").removeAttribute("src");
    clear($("#live-log"));
    renderRunHeader();
    renderPhaseRail();
    renderSubquestions();
    renderResult();
  }
  state.loadingRun = true;
  $("#composer").hidden = true;
  $("#run-view").hidden = false;
  window.scrollTo({ top: 0, behavior: "instant" });
  if (location.hash !== `#run/${encodeURIComponent(runId)}`) history.pushState(null, "", `#run/${encodeURIComponent(runId)}`);
  renderSidebar();
  selectTab("process");
  try {
    await refreshSummary(true);
    if (state.currentId !== runId) return;
    if (changed && state.summary?.meta.status === "completed" && state.summary.files?.includes("report.html")) selectTab("report");
    connectEvents(runId);
    if (state.summary?.active) startClock();
    $("#run-question").focus({ preventScroll: true });
  } catch (error) {
    if (state.currentId !== runId) return;
    showToast(error.message, "error");
    if (options.fallbackToComposer || error.status === 404) {
      showComposer(false);
      history.replaceState(null, "", location.pathname);
    }
  } finally {
    if (state.currentId === runId) state.loadingRun = false;
  }
}

async function refreshSummary(fullRender = true) {
  if (!state.currentId) return;
  const requestId = state.currentId;
  const request = ++state.summaryRequest;
  const summary = await api(`/api/runs/${encodeURIComponent(requestId)}`);
  if (state.currentId !== requestId || request !== state.summaryRequest) return;
  state.summary = summary;
  if (summary.decomposition) state.decomposition = summary.decomposition;
  rememberTitle(requestId, summary.decomposition?.title || summary.meta?.title || summary.conclusion?.title);
  if (summary.analyses) {
    for (const analysis of summary.analyses) state.analyses[analysis.subQuestionId] = analysis;
  }
  if (summary.conclusion) state.conclusion = summary.conclusion;
  if (fullRender) {
    renderRunHeader();
    renderPhaseRail();
    renderSubquestions();
    renderResult();
    renderLog();
    renderMaterials();
    renderTabActions();
  } else {
    renderRunHeader();
    renderPhaseRail();
    renderSubquestions();
    renderResult();
    renderLog();
    renderTabActions();
  }
  if (summary.meta?.status !== "running" && summary.meta?.status !== "queued") stopClock();
  else startClock();
  if ($('.tab.active')?.dataset.tab === "report") ensureReport();
  if ($('.tab.active')?.dataset.tab === "materials") renderMaterials();
}

/* -------------------------------------------------------------------------- */
/* Event stream                                                               */
/* -------------------------------------------------------------------------- */

function connectEvents(runId) {
  closeEvents();
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  state.eventSource = source;
  source.onopen = () => { if (state.eventSource === source) connection(); };
  source.onmessage = (message) => {
    if (state.currentId !== runId || state.eventSource !== source) return;
    try {
      const event = JSON.parse(message.data);
      handleEvent(event);
    } catch {
      // ignore malformed event
    }
  };
  source.addEventListener("end", () => {
    if (state.currentId !== runId || state.eventSource !== source) return;
    closeEvents();
    refreshSummary(true).catch(() => {});
  });
  source.onerror = () => {
    if (state.currentId !== runId || state.eventSource !== source || !state.summary) return;
    connection("实时连接中断，正在重连。任务不会因此取消。");
    if (["completed", "failed", "cancelled"].includes(state.summary.meta?.status) || source.readyState === EventSource.CLOSED) {
      closeEvents();
    }
  };
}

function closeEvents() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function handleEvent(event) {
  if (event.runId !== state.currentId || !Number.isInteger(event.seq) || event.seq <= state.lastSeq) return;
  state.lastSeq = event.seq;
  state.events.push(event);
  if (state.events.length > 1200) state.events.splice(0, state.events.length - 1200);

  if (event.type === "phase" && event.phase) {
    state.phases[event.phase] = event.status;
    if (event.status === "start" && state.summary?.active && state.summary.meta.status === "running") state.summary.meta.phase = event.phase;
    if (event.status === "ok" && event.phase === "decompose" && event.data?.subQuestions) {
      // Replayed events from older runs can predate a saved planning title.
      state.decomposition = { ...event.data, title: event.data.title || state.decomposition?.title };
      rememberTitle(event.runId, state.decomposition.title);
    }
  }

  if (event.type === "subquestion" && event.subQuestionId) {
    if (event.status === "info" && typeof event.data?.question === "string") {
      state.decomposition = state.decomposition || { subQuestions: [] };
      if (!state.decomposition.subQuestions.some((q) => q.id === event.subQuestionId)) {
        state.decomposition.subQuestions.push({
          ...event.data,
          id: event.subQuestionId,
          logicRole: event.data.logicRole || "未分类",
        });
      }
    }
  }

  if (event.type === "engine" && event.engine) {
    if (event.subQuestionId) {
      state.engines[`${event.subQuestionId}:${event.engine}`] = {
        status: event.status,
        message: event.message,
        data: event.data,
      };
    } else if (event.phase === "preflight") {
      state.preflight[event.engine] = { status: event.status, message: event.message };
    }
  }

  if (event.type === "agent" && event.phase === "analyze" && (event.status === "ok" || event.status === "failed") && event.data?.subQuestionId) {
    state.analyses[event.data.subQuestionId] = event.data;
  }

  if (event.type === "run" && event.status === "ok" && event.data?.conclusion) {
    state.conclusion = event.data.conclusion;
  }

  if (event.type === "run" && ["ok", "failed", "cancelled"].includes(event.status)) {
    if (state.summary) state.summary.meta.status = event.status === "ok" ? "completed" : event.status;
    closeEvents();
    connection();
    refreshSummary(true).catch(() => {});
    loadRuns();
  }

  // Coalesce SSE history/reconnect bursts into one paint instead of rebuilding per event.
  if (!state.renderFrame) state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    if (!state.currentId) return;
    renderPhaseRail();
    renderSubquestions();
    renderResult();
    renderLog();
    renderRunHeader();
  });
}

/* -------------------------------------------------------------------------- */
/* Render run header / phases                                                 */
/* -------------------------------------------------------------------------- */

function renderRunHeader() {
  const meta = state.summary?.meta;
  const item = meta || state.runs.find(run => run.id === state.currentId);
  $("#run-question").textContent = runTitle(item, state.currentId);
  $("#original-question").textContent = item?.question || "";
  $("#brief-toggle").hidden = !item?.question;
  renderStatus();
  renderRunMeta();
}

function renderStatus() {
  if (unchanged("status", [state.currentId, state.summary?.meta?.status, state.summary?.meta?.phase])) return;
  const container = $("#run-status");
  clear(container);
  const meta = state.summary?.meta;
  const status = meta?.status || "loading";
  const dot = el("span", `dot ${status}`);
  container.append(dot, el("span", "", status === "loading" ? "正在读取…" : STATUS_LABEL[status] || status));
  if (status === "running" && meta?.phase) {
    container.append(el("span", "", `· ${PHASE_LABEL[meta.phase] || meta.phase}`));
  }
  if (status === "running" || status === "queued") {
    const cancel = el("button", "cancel-btn", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", async () => {
      if (!confirm("确定取消当前运行？已采集的材料会保留。")) return;
      const runId = state.currentId;
      cancel.disabled = true;
      cancel.textContent = "正在取消…";
      try {
        await api(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" });
        showToast("已请求取消，正在停止采集并保留已保存材料…");
      } catch (error) {
        cancel.disabled = false;
        cancel.textContent = "取消";
        showToast(error.message, "error");
      }
    });
    container.append(cancel);
  }
}

function renderRunMeta() {
  const container = $("#run-meta");
  clear(container);
  const meta = state.summary?.meta;
  if (!meta) return;
  if (meta.startedAt || meta.createdAt) container.append(el("span", "", formatDate(meta.startedAt || meta.createdAt)));
  const engines = (meta.activeEngines || meta.options?.engines || []).map(engineLabel).join("、");
  if (engines) container.append(el("span", "", engines));
  if (meta.startedAt) container.append(el("span", "", `用时 ${formatDuration(currentDuration(meta))}`));
  $("#brief-meta").textContent = meta.modelLabel ? `综合模型：${meta.modelLabel}` : "";
}

function currentDuration(meta) {
  if (meta.durationMs != null) return meta.durationMs;
  if (meta.status === "running" && meta.startedAt) return Date.now() - new Date(meta.startedAt).getTime();
  return 0;
}

function startClock() {
  stopClock();
  state.clock = setInterval(() => {
    if (state.summary?.meta?.status === "running") {
      renderRunMeta();
    } else {
      stopClock();
    }
  }, 1000);
}

function stopClock() {
  if (state.clock) {
    clearInterval(state.clock);
    state.clock = null;
  }
}

function renderPhaseRail() {
  if (unchanged("phases", [state.phases, state.summary?.meta?.status])) return;
  const rail = $("#phase-rail");
  clear(rail);
  for (const [phase, label] of PHASES) {
    const status = phaseStatus(phase);
    const cell = el("li", `phase-cell ${status}`);
    const head = el("div", "phase-head");
    const mark = el("span", "phase-mark");
    mark.setAttribute("aria-hidden", "true");
    if (status === "done") mark.append(icon("check"));
    if (status === "failed") mark.append(icon("x"));
    if (status === "skip" || status === "stopped") mark.append(icon("minus"));
    if (status === "active") cell.setAttribute("aria-current", "step");
    head.append(mark, el("span", "phase-label", label));
    cell.append(head, el("div", "phase-status", phaseStatusLabel(status)));
    rail.append(cell);
  }
}

function phaseStatus(phase) {
  const value = state.phases[phase];
  const runStatus = state.summary?.meta?.status;
  if (value === "ok") return "done";
  if (value === "failed" || value === "timeout") return "failed";
  if (value === "cancelled") return "stopped";
  if (value === "skip") return "skip";
  if (value === "start" || value === "progress") return ["failed", "cancelled"].includes(runStatus) ? "stopped" : runStatus === "completed" ? "unrecorded" : "active";
  if (!runStatus) return "loading";
  return ["completed", "failed", "cancelled"].includes(runStatus) ? "unrecorded" : "pending";
}

function phaseStatusLabel(status) {
  return { done:"已完成", active:"进行中", failed:"失败", stopped:"已停止", skip:"已跳过", pending:"待开始", unrecorded:"无阶段记录", loading:"读取中" }[status];
}

/* -------------------------------------------------------------------------- */
/* Render subquestions                                                        */
/* -------------------------------------------------------------------------- */

function renderSubquestions() {
  if (unchanged("questions", [state.decomposition, state.analyses, state.engines, state.preflight, state.summary?.meta?.status, state.summary?.meta?.activeEngines])) return;
  const container = $("#subquestions");
  const questions = state.decomposition?.subQuestions || [];
  $("#q-count").textContent = questions.length ? `${questions.length} 个` : state.summary?.meta?.status === "running" ? "待拆解" : "—";
  clear(container);

  if (!questions.length) {
    container.append(
      el(
        "div",
        "empty",
        state.summary?.meta?.status === "running"
          ? "正在等待问题拆解…"
          : "还没有子问题。报告中的拆解结果会显示在这里。",
      ),
    );
    return;
  }

  const engines = state.summary?.meta?.activeEngines || state.summary?.meta?.options?.engines || ["deepseek", "workbuddy"];
  for (const question of questions) {
    const card = el("article", "q-card");
    const head = el("div", "q-head");
    head.append(el("span", "q-id", String(question.id || "").toUpperCase()));
    if (question.logicRole) head.append(el("span", "q-role", question.logicRole));
    const title = el("h4", "q-text", question.question);
    card.append(head, title);

    for (const engine of engines) {
      const key = `${question.id}:${engine}`;
      const current = state.engines[key];
      const pre = state.preflight[engine];
      let status = current?.status || "pending";
      let message = current?.message || "待开始";
      if (!current && pre && pre.status === "failed") {
        status = "failed";
        message = "预检不可用";
      }
      if (status === "ok") {
        const data = current?.data || {};
        const parts = [];
        if (data.answerChars) parts.push(`${data.answerChars} 字`);
        if (data.citations) parts.push(`${data.citations} 引用`);
        if (data.searchCount) parts.push(`${data.searchCount} 来源`);
        message = parts.length ? parts.join(" · ") : "完成";
      } else if (status === "start") {
        message = "正在打开会话…";
      } else if (status === "progress") {
        message = current?.message || "调研中";
      } else if (status === "failed" || status === "timeout") {
        message = current?.message || "失败";
      }
      if (["failed", "cancelled"].includes(state.summary?.meta?.status) && ["pending", "start", "progress"].includes(status)) {
        status = "cancelled";
        message = "已停止，材料如已保存可在原始材料中查看";
      }
      const row = el("div", `engine-row ${status}`);
      const name = el("span", "engine-name");
      name.append(el("span", `engine-dot ${ENGINE_DOT[engine] || ""}`), el("span", "", engineLabel(engine)));
      const note = el("span", "engine-note", current?.data?.durationMs ? formatDuration(current.data.durationMs) : "");
      const statusText = el("span", "engine-status", message);
      statusText.title = message;
      row.append(name, statusText, note);
      card.append(row);
    }

    const analysis = state.analyses[question.id] || state.summary?.analyses?.find((item) => item.subQuestionId === question.id);
    if (analysis) {
      const box = el("div", "analysis-box");
      const boxHead = el("div", "analysis-head");
      const incomplete = analysis.analysisUnavailable || analysis.gaps?.some(gap => gap.startsWith("自动分析失败"));
      if (incomplete) {
        box.classList.add("analysis-incomplete");
        boxHead.append(icon("log-warn"), el("span", "", "本次运行未完成该题分析"));
      }
      else boxHead.append(
        el("span", `small-badge ${analysis.verdict}`, verdictLabel(analysis.verdict)),
        el("span", "analysis-conf", `置信度 ${pct(analysis.confidence)} · ${agreementLabel(analysis.engineAgreement)}`),
      );
      box.append(boxHead);
      if (!incomplete) {
        const full = String(analysis.conclusion || "");
        const para = el("p", "analysis-text");
        const text = el("span", "", full);
        para.append(text);
        if (full.length > 170) {
          const toggle = el("button", "analysis-expand");
          toggle.type = "button";
          const show = (open) => {
            text.textContent = open ? full : truncate(full, 170);
            toggle.textContent = open ? "收起" : "展开全文";
            toggle.setAttribute("aria-expanded", String(open));
          };
          show(state.expandedAnalyses.has(question.id));
          toggle.addEventListener("click", () => {
            const open = !state.expandedAnalyses.has(question.id);
            if (open) state.expandedAnalyses.add(question.id);
            else state.expandedAnalyses.delete(question.id);
            show(open);
          });
          para.append(toggle);
        }
        box.append(para);
      }
      title.after(box);
    }

    container.append(card);
  }
}

function agreementLabel(value) {
  return value === "high" ? "一致性高" : value === "medium" ? "一致性中" : value === "low" ? "一致性低" : "一致性未知";
}

/* -------------------------------------------------------------------------- */
/* Render log                                                                 */
/* -------------------------------------------------------------------------- */

const LOG_MARKS = {
  detail: ["log-dot", "过程信息"],
  stage: ["log-flag", "阶段开始"],
  done: ["check", "步骤完成"],
  milestone: ["check", "关键步骤完成"],
  attention: ["log-warn", "需要留意"],
  error: ["log-error", "执行异常"],
  stopped: ["minus", "已停止或跳过"],
};

function logTone({ type, status, phase, data, message }) {
  if (status === "cancelled") return "stopped";
  if (type === "error" || status === "failed" || status === "timeout") return "error";
  if (status === "skip") return "stopped";
  if (type === "agent" && status === "progress" && message?.includes("正在重试")) return "attention";
  if (status === "ok") {
    // Some archived runs wrote a fallback analysis as OK after the actual failure.
    if (type === "agent" && phase === "analyze" && (data?.analysisUnavailable || data?.gaps?.some(gap => gap.startsWith("自动分析失败")))) return "attention";
    if (type === "phase" && (data?.failed > 0 || data?.ok < data?.checked)) return "attention";
    if (type === "subquestion" && data?.materials?.some(m => m.status !== "ok")) return "attention";
    return ["phase", "run", "report"].includes(type) ? "milestone" : "done";
  }
  if (status === "start" && (type === "phase" || type === "run")) return "stage";
  return "detail";
}

function renderLog() {
  const container = $("#live-log");
  if (unchanged("log", [state.currentId, state.lastSeq, state.summary?.meta?.status])) return;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  const wasEmpty = !container.querySelector(".log-line");
  const events = state.events.slice(-90);
  const previousSeq = Number(container.lastElementChild?.dataset.seq || 0);
  if (wasEmpty) clear(container);
  if (!events.length) {
    container.append(el("div", "log-empty", "等待事件…"));
    return;
  }
  for (const event of events) {
    if (event.seq <= previousSeq) continue;
    const tone = logTone(event);
    const [symbol, label] = LOG_MARKS[tone];
    const line = el("div", `log-line log-${tone}`);
    line.dataset.seq = event.seq;
    const mark = el("span", "log-mark");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", label);
    mark.title = label;
    mark.append(icon(symbol));
    line.append(el("span", "log-time", formatTime(event.ts)), mark, el("span", "log-msg", event.message));
    container.append(line);
  }
  while (container.children.length > 90) {
    const removedHeight = container.firstElementChild.getBoundingClientRect().height;
    container.firstElementChild.remove();
    if (!nearBottom) container.scrollTop = Math.max(0, container.scrollTop - removedHeight);
  }
  $("#log-state").textContent = state.summary?.meta?.status === "running" ? "实时" : "已归档";
  if (nearBottom || wasEmpty) container.scrollTop = container.scrollHeight;
}

/* -------------------------------------------------------------------------- */
/* Render result                                                              */
/* -------------------------------------------------------------------------- */

function renderResult() {
  const hasReview = hasReport() && state.summary?.files?.includes("editorial-review.json");
  if (unchanged("result", [state.currentId, state.conclusion, state.summary?.meta?.status, state.summary?.meta?.error, hasReport(), hasReview])) return;
  const container = $("#result");
  const meta = state.summary?.meta;
  const conclusion = state.conclusion || state.summary?.conclusion;
  const status = meta?.status;

  if (hasReview) {
    clear(container);
    container.hidden = true;
    return;
  }
  if (!conclusion) {
    if (status === "failed" || status === "cancelled") {
      container.hidden = false;
      clear(container);
      const box = el("div", "result-failed");
      box.append(el("strong", "result-title", status === "cancelled" ? "调研已取消" : "调研未完成"));
      box.append(el("p", "", meta?.error || "运行未能完成，请查看执行日志。"));
      const links = el("div", "result-links");
      if (state.currentId) {
        const materials = el("a", "", "查看已保存材料");
        materials.href = "#";
        materials.addEventListener("click", (event) => {
          event.preventDefault();
          selectTab("materials");
        });
        links.append(materials);
      }
      const retry = el("button", "retry-button", "使用原问题重新调研");
      retry.type = "button";
      retry.addEventListener("click", () => {
        const options = state.summary.meta.options;
        showComposer(true);
        $("#question").value = options.question;
        $("#question").dispatchEvent(new Event("input"));
        $("#question-count").value = String(options.subQuestionCount ?? "auto");
        for (const key of ["concurrency"]) {
          const buttons = $$(`.segmented button[data-option="${key}"]`);
          let button = buttons.find((b) => Number(b.dataset.value) === options[key]);
          if (!button) {
            button = buttons[0];
            button.dataset.value = options[key];
            button.textContent = options[key];
          }
          button.click();
        }
        for (const input of $$('input[name="engine"]')) input.checked = options.engines.includes(input.value);
        $("#max-citations").value = options.maxCitations;
        $("#verify").checked = options.verifyCitations;
        $("#max-citations").disabled = !options.verifyCitations;
        $("#keep-space").checked = options.keepSpace;
        if (state.setup?.model.models.some((m) => m.id === options.model)) $("#model").value = options.model;
        $("#model").dispatchEvent(new Event("change"));
        updateStartState();
        showToast("问题与设置已填入。确认后开始一次新的调研，旧材料不会删除。");
      });
      links.append(retry);
      box.append(links);
      container.append(box);
      return;
    }
    container.hidden = true;
    return;
  }

  container.hidden = false;
  clear(container);
  const left = el("div", "result-left");
  left.append(el("div", `verdict-large ${conclusion.verdict}`, verdictLabel(conclusion.verdict)));
  const confidenceHead = el("div", "confidence-label");
  confidenceHead.append(el("span", "", "置信度"), el("strong", "confidence-num", pct(conclusion.confidence)));
  left.append(confidenceHead);
  const track = el("div", "confidence-track");
  const fill = el("span", conclusion.verdict);
  fill.style.width = pct(conclusion.confidence);
  track.append(fill);
  left.append(track, el("div", "confidence-note", confidenceNote(conclusion.confidence)));

  const right = el("div", "result-right");
  right.append(el("p", "final-conclusion", conclusion.finalConclusion));
  if (Array.isArray(conclusion.executiveSummary) && conclusion.executiveSummary.length) {
    const list = el("ol", "summary-list");
    for (const item of conclusion.executiveSummary.slice(0, 5)) list.append(el("li", "", item));
    right.append(list);
  }
  const links = el("div", "result-links");
  if (hasReport()) {
    const report = el("a", "", "打开完整报告 ↗");
    report.href = `/runs/${encodeURIComponent(state.currentId)}/report`;
    report.target = "_blank";
    report.rel = "noopener";
    links.append(report);
  }
  const md = el("a", "", "下载 Markdown");
  md.href = `${fileUrl("report.md")}&download=1`;
  md.download = "report.md";
  md.target = "_blank";
  md.rel = "noopener";
  links.append(md);
  const materials = el("a", "", "原始材料");
  materials.href = "#";
  materials.addEventListener("click", (event) => {
    event.preventDefault();
    selectTab("materials");
  });
  links.append(materials);
  right.append(links);

  container.append(left, right);
}

function confidenceNote(value) {
  if (value >= 0.75) return "高置信度：关键环节有强证据，且引擎间一致性较高。仍需复核一手来源。";
  if (value >= 0.55) return "中置信度：方向明确，但存在口径、时间或关键环节的缺口。";
  if (value >= 0.35) return "低置信度：证据有限或相互冲突，结论应作为待验证假设。";
  return "很低置信度：材料不足以判断，建议补充一手数据或重新调研。";
}

/* -------------------------------------------------------------------------- */
/* Tabs / report / materials                                                  */
/* -------------------------------------------------------------------------- */

function bindTabs() {
  bindArrowNavigation($(".tabs"), ".tab");
  for (const tab of $$(".tab")) {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  }
  $("#report-frame").addEventListener("load", () => {
    if (state.reportKey && hasReport()) $("#report-frame").hidden = false;
  });
}

function selectTab(name) {
  for (const tab of $$(".tab")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of $$(".tab-panel")) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  $("#tab-actions").hidden = name !== "report";
  if (name === "report") ensureReport();
  if (name === "materials") renderMaterials();
}

function hasReport() {
  const files = state.summary?.files || [];
  return files.includes("report.html") && Boolean(state.currentId);
}

function ensureReport() {
  const frame = $("#report-frame");
  const empty = $("#report-empty");
  const meta = state.summary?.meta;
  if (!hasReport()) {
    frame.hidden = true;
    empty.hidden = false;
    empty.textContent =
      meta?.status === "running"
        ? "报告将在综合完成后生成。你可以在「执行过程」里查看实时进度。"
        : "报告尚未生成。请查看执行日志或原始材料。";
    return;
  }
  empty.hidden = true;
  const key = `${state.currentId}:${meta?.finishedAt || meta?.createdAt}`;
  if (state.reportKey !== key) {
    state.reportKey = key;
    frame.src = `/runs/${encodeURIComponent(state.currentId)}/report?v=${encodeURIComponent(key)}#reading-start`;
  }
  frame.hidden = false;
}

function renderTabActions() {
  if (unchanged("actions", [state.currentId, hasReport()])) return;
  const container = $("#tab-actions");
  clear(container);
  if (!state.currentId) return;
  if (hasReport()) {
    const open = el("a");
    open.title = "在新窗口独立阅读";
    open.append(icon("external"), el("span", "", "独立阅读"));
    open.href = `/runs/${encodeURIComponent(state.currentId)}/report`;
    open.target = "_blank";
    open.rel = "noopener";
    container.append(open);
    const md = el("a");
    md.title = "下载 Markdown";
    md.append(icon("download"), el("span", "", md.title));
    md.href = `${fileUrl("report.md")}&download=1`;
    md.download = "report.md";
    md.target = "_blank";
    md.rel = "noopener";
    container.append(md);
  }

}

function fileUrl(file) {
  return `/api/runs/${encodeURIComponent(state.currentId)}/file?path=${encodeURIComponent(file)}`;
}

function renderMaterials() {
  if (unchanged("materials", [state.currentId, state.summary?.files])) return;
  const container = $("#materials-list");
  clear(container);
  const files = state.summary?.files || [];
  if (!files.length) {
    container.append(el("div", "empty", "运行开始后，原始材料、引用核查与分析文件会出现在这里。"));
    return;
  }
  const groups = new Map();
  for (const file of files) {
    const slash = file.indexOf("/");
    const group = slash >= 0 ? file.slice(0, slash) : ".";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(file);
  }
  const order = [".", "materials", "analysis", "citations", "preflight"];
  const keys = [...groups.keys()].sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  for (const group of keys) {
    const groupFiles = groups.get(group);
    const details = el("details", "materials-group");
    if (group === "." || group === "materials") details.open = true;
    const summary = el("summary");
    const names = { ".": "运行文件", materials: "采集材料", analysis: "子问题分析", citations: "引用核查", preflight: "环境检查" };
    summary.append(icon("chevron"), el("span", "", names[group] || group), el("span", "file-count", `${groupFiles.length} 个文件`));
    details.append(summary);
    const list = el("div", "file-list");
    for (const file of groupFiles) {
      const row = el("div", "file-row");
      const link = el("a", "", file);
      link.href = file === "report.html" ? `/runs/${encodeURIComponent(state.currentId)}/report` : fileUrl(file);
      link.target = "_blank";
      link.rel = "noopener";
      row.append(icon("file"), link);
      list.append(row);
    }
    details.append(list);
    container.append(details);
  }
}

/* -------------------------------------------------------------------------- */
/* Composer switching                                                         */
/* -------------------------------------------------------------------------- */

function showComposer(updateHash = true) {
  closeHistory();
  closeEvents();
  stopClock();
  state.currentId = null;
  state.summary = null;
  state.events = [];
  state.decomposition = null;
  state.analyses = {};
  state.engines = {};
  state.preflight = {};
  state.phases = {};
  state.conclusion = null;
  state.reportKey = null;
  state.lastSeq = 0;
  state.loadingRun = false;
  renderKeys.clear();
  if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
  state.renderFrame = null;
  $("#report-frame").removeAttribute("src");
  $("#run-view").hidden = true;
  $("#composer").hidden = false;
  if (updateHash && location.hash) history.pushState(null, "", location.pathname);
  renderSidebar();
  updateStartState();
  const question = $("#question");
  if (updateHash) {
    question.focus({ preventScroll: true });
    question.scrollIntoView({ block: "center", behavior: "instant" });
  }
}

await init().catch((error) => {
  connection(`初始化失败：${error.message}。请刷新页面重试。`);
});
