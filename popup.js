const $ = (id) => document.getElementById(id);

// ─── Config Persistence ───────────────────────────────

async function loadConfig() {
  const { config } = await chrome.storage.local.get("config");
  if (!config) return;
  $("token").value = config.token || "";
  $("owner").value = config.owner || "";
  $("repo").value = config.repo || "";
  $("branch").value = config.branch || "main";
  $("pathTemplate").value = config.pathTemplate || "solutions/{slug}";
  $("acceptedOnly").checked = config.acceptedOnly !== false;
  $("commitEmail").value = config.commitEmail || "";
  $("telemetryEnabled").checked = config.telemetryEnabled === true;
  $("telemetryUrl").value = config.telemetryUrl || "";
  $("telemetryKey").value = config.telemetryKey || "";
}

function readConfigFromForm() {
  return {
    token: $("token").value.trim(),
    owner: $("owner").value.trim(),
    repo: $("repo").value.trim(),
    branch: $("branch").value.trim() || "main",
    pathTemplate: $("pathTemplate").value.trim() || "solutions/{slug}",
    acceptedOnly: $("acceptedOnly").checked,
    commitEmail: $("commitEmail").value.trim(),
    telemetryEnabled: $("telemetryEnabled").checked,
    telemetryUrl: $("telemetryUrl").value.trim(),
    telemetryKey: $("telemetryKey").value.trim()
  };
}

async function saveConfig(silent = false) {
  const config = readConfigFromForm();
  if (!silent && config.telemetryEnabled) {
    try {
      const origin = new URL(config.telemetryUrl).origin;
      if (origin !== "http://localhost:3000") {
        if (!origin.startsWith("https://")) throw new Error("Use HTTPS for a hosted dashboard.");
        const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
        if (!granted) throw new Error("Dashboard permission was not granted.");
      }
      if (!config.telemetryKey) throw new Error("Enter the dashboard telemetry key.");
    } catch (err) { showToast(err.message); return; }
  }
  await chrome.storage.local.set({ config });
  if (!silent) showToast("Settings saved ✓");
}

// ─── Toast Notification ───────────────────────────────

let toastTimeout = null;
function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 2200);
}

// ─── Status & Progress ───────────────────────────────

function setStatus(text, type = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status-text" + (type ? ` ${type}` : "");
}

function setProgress(fraction, state = "running") {
  const fill = $("bar");
  fill.classList.remove("indeterminate", "complete");

  if (state === "indeterminate") {
    fill.style.width = "";
    fill.classList.add("indeterminate");
  } else if (state === "complete") {
    fill.style.width = "100%";
    fill.classList.add("complete");
  } else {
    fill.style.width = Math.min(100, Math.max(0, fraction * 100)) + "%";
  }
}

function updateBadge(state) {
  const badge = $("connectionBadge");
  const text = badge.querySelector(".badge-text");
  badge.classList.remove("syncing", "error");
  if (state === "running") {
    badge.classList.add("syncing");
    text.textContent = "Syncing";
  } else if (state === "error") {
    badge.classList.add("error");
    text.textContent = "Error";
  } else if (state === "complete") {
    text.textContent = "Done";
  } else {
    text.textContent = "Ready";
  }
}

function renderProgress(progress) {
  if (!progress) return;
  const total = progress.total || 0;
  const done = progress.done || 0;

  setStatus(progress.message || "", progress.state === "error" ? "error" : progress.state === "complete" ? "complete" : "");
  updateBadge(progress.state);

  if (total > 0) {
    setProgress(done / total, progress.state === "complete" ? "complete" : "running");
  } else if (progress.state === "running") {
    setProgress(0, "indeterminate");
  } else if (progress.state === "complete") {
    setProgress(1, "complete");
  } else {
    setProgress(0);
  }

  const syncBtn = $("syncBtn");
  const btnText = syncBtn.querySelector("span");
  if (progress.state === "running") {
    syncBtn.disabled = true;
    syncBtn.classList.add("syncing");
    btnText.textContent = "Syncing…";
  } else {
    syncBtn.disabled = false;
    syncBtn.classList.remove("syncing");
    btnText.textContent = "Sync All Submissions";
  }
}

// ─── Polling ──────────────────────────────────────────

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const { progress } = await chrome.storage.local.get("progress");
    renderProgress(progress);
    if (progress && (progress.state === "complete" || progress.state === "error")) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 600);
}

// ─── GitHub Validation ────────────────────────────────

let debounceTimer = null;
function debouncedValidate() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(validateGitHub, 600);
}

function setFieldStatus(inputEl, statusEl, errorEl, state, errorMsg = "") {
  inputEl.classList.remove("valid", "invalid");
  statusEl.classList.remove("valid", "invalid", "checking");
  if (errorEl) {
    errorEl.classList.remove("show");
    errorEl.textContent = "";
  }

  if (state === "checking") {
    statusEl.classList.add("checking");
  } else if (state === "valid") {
    inputEl.classList.add("valid");
    statusEl.classList.add("valid");
  } else if (state === "invalid") {
    inputEl.classList.add("invalid");
    statusEl.classList.add("invalid");
    if (errorEl && errorMsg) {
      errorEl.textContent = errorMsg;
      errorEl.classList.add("show");
    }
  }
}

async function validateGitHub() {
  const ownerInput = $("owner");
  const repoInput = $("repo");
  const ownerStatus = $("ownerStatus");
  const repoStatus = $("repoStatus");
  const ownerError = $("ownerError");
  const repoError = $("repoError");
  const token = $("token").value.trim();
  const owner = ownerInput.value.trim();
  const repo = repoInput.value.trim();

  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Validate Owner
  if (owner) {
    setFieldStatus(ownerInput, ownerStatus, ownerError, "checking");
    try {
      const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, { headers });
      if (res.ok) {
        setFieldStatus(ownerInput, ownerStatus, ownerError, "valid");
      } else {
        const errorText = res.status === 404 ? "GitHub owner does not exist" : `HTTP Error ${res.status}`;
        setFieldStatus(ownerInput, ownerStatus, ownerError, "invalid", errorText);
      }
    } catch {
      setFieldStatus(ownerInput, ownerStatus, ownerError, "invalid", "Network connection failed");
    }
  } else {
    setFieldStatus(ownerInput, ownerStatus, ownerError, "");
  }

  // Validate Repo
  if (owner && repo) {
    setFieldStatus(repoInput, repoStatus, repoError, "checking");
    try {
      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers });
      if (res.ok) {
        setFieldStatus(repoInput, repoStatus, repoError, "valid");
      } else {
        const errorText = res.status === 404 ? "Repository not found / private" : `HTTP Error ${res.status}`;
        setFieldStatus(repoInput, repoStatus, repoError, "invalid", errorText);
      }
    } catch {
      setFieldStatus(repoInput, repoStatus, repoError, "invalid", "Network connection failed");
    }
  } else {
    setFieldStatus(repoInput, repoStatus, repoError, "");
  }
}

// ─── Token Visibility Toggle ──────────────────────────

function setupTokenToggle() {
  const btn = $("toggleToken");
  const input = $("token");
  const eyeOpen = btn.querySelector(".eye-open");
  const eyeClosed = btn.querySelector(".eye-closed");

  btn.addEventListener("click", () => {
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    eyeOpen.style.display = isPassword ? "none" : "block";
    eyeClosed.style.display = isPassword ? "block" : "none";
  });
}

// ─── Init ─────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();
  setupTokenToggle();

  const { progress } = await chrome.storage.local.get("progress");
  if (progress) renderProgress(progress);
  if (progress && progress.state === "running") {
    chrome.runtime.sendMessage({ type: "GET_SYNC_STATUS" }, response => {
      if (response?.busy) startPolling();
      else renderProgress({ state: "error", message: "Previous sync was interrupted. Click Sync All Submissions to retry; completed submissions are cached." });
    });
  }

  // Save button
  $("saveBtn").addEventListener("click", () => saveConfig());

  // Sync button
  $("syncBtn").addEventListener("click", async () => {
    await saveConfig(true);
    setStatus("Starting sync…");
    updateBadge("running");
    chrome.runtime.sendMessage({ type: "START_SYNC" }, response => {
      if (!response?.ok) { setStatus(response?.error || "Could not start sync.", "error"); return; }
      startPolling();
    });
  });

  // Reset button
  $("resetBtn").addEventListener("click", async () => {
    if (!confirm("This clears local sync history so every problem will be re-pushed to GitHub next sync. Continue?")) return;
    chrome.runtime.sendMessage({ type: "RESET_SYNC_STATE" }, response => {
      if (!response?.ok) { showToast(response?.error || "Reset failed."); return; }
      showToast("Sync history cleared");
      setProgress(0);
      setStatus("");
      updateBadge("ready");
    });
  });

  // Auto-save on every input change
  const inputs = ["token", "owner", "repo", "branch", "pathTemplate", "acceptedOnly", "commitEmail", "telemetryEnabled", "telemetryUrl", "telemetryKey"];
  inputs.forEach(id => {
    $(id).addEventListener("input", () => {
      saveConfig(true);
      if (id === "owner" || id === "repo" || id === "token") {
        debouncedValidate();
      }
    });
  });

  // Run initial validation
  validateGitHub();
});
