// background.js — orchestrates the full sync.
//
// Flow:
//  1. Find (or open) a leetcode.com tab so the content script's fetches
//     carry the user's session cookies.
//  2. Page through the user's ENTIRE submission history via the content
//     script (oldest included — this is what makes "old" submissions sync).
//  3. Keep only the newest Accepted submission per problem.
//  4. For each, create a backdated commit in the target GitHub repo using
//     the Git Data API preserving the selected submission date in Git history. GitHub
//     contribution credit depends on its attribution and branch rules.
//
// Progress is written to chrome.storage.local as it goes, so the popup can
// show live status even if it's closed and reopened mid-sync.

const LANG_EXT = {
  python: "py",
  python3: "py",
  c: "c",
  cpp: "cpp",
  java: "java",
  csharp: "cs",
  javascript: "js",
  typescript: "ts",
  ruby: "rb",
  swift: "swift",
  golang: "go",
  scala: "scala",
  kotlin: "kt",
  rust: "rs",
  php: "php",
  mysql: "sql",
  mssql: "sql",
  oraclesql: "sql",
  racket: "rkt",
  erlang: "erl",
  elixir: "ex",
  dart: "dart"
};

function extFor(langSlug) {
  return LANG_EXT[langSlug] || "txt";
}

function sanitizeSlug(slug) {
  if (typeof slug !== "string") return "";
  // Keep only alphanumeric characters, hyphens, and underscores to prevent path traversal
  return slug.replace(/[^a-zA-Z0-9\-_]/g, "");
}

async function sendTelemetry(owner, repo, action, count) {
  try {
    const config = await getConfig();
    if (!config?.telemetryEnabled || !config.telemetryUrl || !config.telemetryKey) return;
    const base = new URL(config.telemetryUrl);
    if (base.protocol !== "https:" && base.origin !== "http://localhost:3000") return;
    const url = new URL("/api/telemetry", base).href;
    const version = chrome.runtime.getManifest().version;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telemetry-Key": config.telemetryKey
      },
      body: JSON.stringify({ owner, repo, action, problemsSynced: count, version }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.error("Telemetry report failed:", err);
  }
}

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  if (!config) return null;
  config.branch ||= "main";
  config.pathTemplate ||= "solutions/{slug}";
  return config;
}

async function setProgress(progress) {
  await chrome.storage.local.set({ progress });
}

function syncScope(config) {
  return "syncedProblems:" + JSON.stringify([
    config.owner.toLowerCase(), config.repo.toLowerCase(), config.branch,
    config.pathTemplate, config.acceptedOnly !== false
  ]);
}

async function getSyncedMap(config) {
  const key = syncScope(config);
  return (await chrome.storage.local.get(key))[key] || {};
}

async function setSyncedMap(config, map) {
  await chrome.storage.local.set({ [syncScope(config)]: map });
}

function solutionFolder(config, slug) {
  if (!slug) throw new Error("Missing problem slug.");
  const folder = config.pathTemplate.replaceAll("{slug}", slug).replace(/\/+$/, "");
  if (!folder || folder.startsWith("/") || folder.includes("\\") ||
      folder.split("/").some(p => !p || p === "." || p === ".." || p === ".git")) {
    throw new Error("Path template must be a relative folder without dot segments.");
  }
  return folder;
}

async function resolveCommitAuthor(config) {
  const user = await githubApi("GET", "https://api.github.com/user", config.token);
  config.authorName = user.name || user.login;
  config.authorEmail = config.commitEmail || user.email || `${user.id}+${user.login}@users.noreply.github.com`;
}

// Keep PATs available only to extension pages and the worker, not content scripts.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(console.error);
let syncQueue = Promise.resolve();
let pendingSyncs = 0;
function enqueueSync(task) {
  pendingSyncs++;
  const next = syncQueue.then(task);
  syncQueue = next.catch(async err => {
    await setProgress({ state: "error", message: err.message || "Sync failed." });
  }).finally(() => { pendingSyncs--; });
  return syncQueue;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findActiveLeetCodeTab() {
  const tabs = await chrome.tabs.query({ url: "https://leetcode.com/*" });
  
  // Sort: active tabs first, then loaded (not discarded) tabs, then others
  tabs.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    if (!a.discarded && b.discarded) return -1;
    if (a.discarded && !b.discarded) return 1;
    return 0;
  });

  // Try to find an existing tab that responds to LC_CHECK_LOGIN
  for (const tab of tabs) {
    try {
      const login = await sendToTab(tab.id, { type: "LC_CHECK_LOGIN" });
      if (login && login.ok) {
        return { tab, login };
      }
    } catch (e) {
      // Content script is not listening on this tab (e.g. extension was reloaded)
      // If it is the LeetCode landing page, reload it once to force-inject the script
      const url = tab.url || "";
      const isSafeToReload = url === "https://leetcode.com" || url === "https://leetcode.com/" || url.startsWith("https://leetcode.com/?");
      if (isSafeToReload) {
        try {
          await chrome.tabs.reload(tab.id);
          await sleep(4000);
          const login = await sendToTab(tab.id, { type: "LC_CHECK_LOGIN" });
          if (login && login.ok) {
            return { tab, login };
          }
        } catch (err) {
          console.error("Failed to reload existing LeetCode tab:", err);
        }
      }
    }
  }

  // If no tab responds, create a new landing page tab in the background
  const tab = await chrome.tabs.create({ url: "https://leetcode.com/", active: false });
  await sleep(4000); // Wait for load and injection

  try {
    const login = await sendToTab(tab.id, { type: "LC_CHECK_LOGIN" });
    if (login && login.ok) {
      return { tab, login };
    }
  } catch (e) {
    // If still fails, reload it once
    try {
      await chrome.tabs.reload(tab.id);
      await sleep(4000);
      const login = await sendToTab(tab.id, { type: "LC_CHECK_LOGIN" });
      if (login && login.ok) {
        return { tab, login };
      }
    } catch (err) {
      console.error("Failed to reload newly created LeetCode tab:", err);
    }
  }

  throw new Error("Could not establish communication with LeetCode. Please open or refresh a leetcode.com tab.");
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// --- Shared GitHub helpers -------------------------------------------------------

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json"
  };
}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

// --- Git Data API helpers (for backdated commits) --------------------------------
//
// The Contents API (PUT /contents) always timestamps commits to NOW.
// To make the contribution graph reflect the original solve date, we use
// the lower-level Git Data API which lets us set author.date / committer.date.
//
// Flow per problem:
//   1. GET  /git/ref/heads/{branch}         → current branch tip SHA
//   2. GET  /git/commits/{sha}              → tip commit's tree SHA
//   3. POST /git/blobs                      → create blobs for code + README
//   4. POST /git/trees                      → new tree with the two files
//   5. POST /git/commits (with custom date) → new commit pointing to new tree
//   6. PATCH /git/refs/heads/{branch}       → fast-forward the branch

async function githubApi(method, url, token, body = null) {
  const opts = { method, headers: githubHeaders(token), signal: AbortSignal.timeout(25000) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`GitHub ${method} ${url} failed (${res.status}): ${text}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function getBranchRef(config) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/ref/heads/${encodeURIComponent(config.branch)}`;
  return githubApi("GET", url, config.token);
}

async function getCommit(config, sha) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/commits/${sha}`;
  return githubApi("GET", url, config.token);
}

async function createBlob(config, content) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/blobs`;
  return githubApi("POST", url, config.token, {
    content: b64EncodeUtf8(content),
    encoding: "base64"
  });
}

async function createTree(config, baseTreeSha, files) {
  // files = [{ path: "solutions/two-sum/two-sum.py", sha: "abc123" }, ...]
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/trees`;
  const body = {
    tree: files.map((f) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: f.sha
    }))
  };
  // Only include base_tree if we have one (empty repos don't)
  if (baseTreeSha) body.base_tree = baseTreeSha;
  return githubApi("POST", url, config.token, body);
}

async function createCommit(config, message, treeSha, parentSha, dateISO) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/commits`;
  const authorInfo = {
    name: config.authorName,
    email: config.authorEmail,
    date: dateISO
  };
  const body = {
    message,
    tree: treeSha,
    parents: parentSha ? [parentSha] : [], // empty array for initial commit
    author: authorInfo,
    committer: authorInfo
  };
  return githubApi("POST", url, config.token, body);
}

async function updateRef(config, sha) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/refs/heads/${encodeURIComponent(config.branch)}`;
  return githubApi("PATCH", url, config.token, { sha, force: false });
}

async function createRef(config, sha) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/refs`;
  return githubApi("POST", url, config.token, {
    ref: `refs/heads/${config.branch}`,
    sha
  });
}

/**
 * Try to get the branch ref. Returns null if the repo is empty or branch
 * doesn't exist (409 = empty repo, 404 = branch not found).
 */
async function tryGetBranchRef(config) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/ref/heads/${encodeURIComponent(config.branch)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: githubHeaders(config.token),
    signal: AbortSignal.timeout(25000)
  });
  if (res.status === 404 || res.status === 409) return null;
  if (!res.ok) throw new Error(`GitHub GET ref failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Bootstrap an empty GitHub repo by creating a README via the Contents API.
 * This is the ONLY API that works on a completely empty repo (the Git Data
 * API returns 409 for everything — blobs, trees, commits — until at least
 * one commit exists).
 */
async function initializeEmptyRepo(config) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/README.md`;
  const body = {
    message: "Initial commit — LeetSync",
    content: b64EncodeUtf8("# My LeetCode Solutions\n\nSynced with [LeetSync](https://github.com).\n"),
    branch: config.branch
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(config.token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to initialize empty repo (${res.status}): ${text}`);
  }
  // Give GitHub a moment to finalize the ref
  await sleep(1500);
}

async function ensureBranch(config) {
  let ref = await tryGetBranchRef(config);
  if (ref) return ref;
  // A missing branch is different from an empty repository. Preserve the
  // repository's existing history when creating a new target branch.
  const repo = await githubApi("GET", `https://api.github.com/repos/${config.owner}/${config.repo}`, config.token);
  const base = repo.default_branch && await tryGetBranchRef({ ...config, branch: repo.default_branch });
  if (base) await createRef(config, base.object.sha);
  else await initializeEmptyRepo(config);
  ref = await tryGetBranchRef(config);
  if (!ref) throw new Error("Target branch could not be initialized. Check permissions and branch rules.");
  return ref;
}

/**
 * Push one or two files as a single commit with a custom date.
 *
 * @param {object} config       - GitHub config (owner, repo, branch, token)
 * @param {Array}  files        - [{ path, content }] file objects to commit
 * @param {string} message      - commit message
 * @param {number} unixTs       - original LeetCode submission timestamp (seconds)
 * @param {string} parentSha    - SHA of the parent commit to build on
 * @param {string} baseTreeSha  - SHA of the base tree to layer changes on
 */
async function pushBackdatedCommit(config, files, message, unixTs, parentSha, baseTreeSha) {
  const dateISO = new Date(unixTs * 1000).toISOString();

  // 1. Create blobs for each file
  const blobPromises = files.map(async (f) => {
    const blob = await createBlob(config, f.content);
    return { path: f.path, sha: blob.sha };
  });
  const blobs = await Promise.all(blobPromises);

  // 2. Create a new tree layered on top of the existing one
  const newTree = await createTree(config, baseTreeSha, blobs);

  // 3. Create a commit with the original solve date
  const newCommit = await createCommit(config, message, newTree.sha, parentSha, dateISO);

  // 4. Fast-forward the branch
  await updateRef(config, newCommit.sha);

  return newCommit;
}

// --- Core sync --------------------------------------------------------------------

async function runSync() {
  const config = await getConfig();
  if (!config || !config.token || !config.owner || !config.repo) {
    await setProgress({ state: "error", message: "Missing GitHub configuration.", done: 0, total: 0 });
    return;
  }

  solutionFolder(config, "validation");
  await resolveCommitAuthor(config);
  let tabInfo;
  try {
    tabInfo = await findActiveLeetCodeTab();
  } catch (err) {
    await setProgress({ state: "error", message: err.message || "Failed to connect to LeetCode tab." });
    return;
  }

  const { tab, login } = tabInfo;

  if (!login.loggedIn) {
    await setProgress({
      state: "error",
      message: "Not logged in to LeetCode. Please make sure you are logged in to LeetCode in your open tab and try again."
    });
    return;
  }

  await setProgress({ state: "running", message: "Fetching submission history…", done: 0, total: 0 });

  // 1. Page through ALL submissions, oldest and newest alike.
  let offset = 0;
  let hasNext = true;
  const bestByProblem = new Map(); // titleSlug -> latest accepted submission summary

  while (hasNext) {
    const page = await sendToTab(tab.id, {
      type: "LC_FETCH_SUBMISSIONS_PAGE",
      offset,
      limit: 20
    });
    if (!page || !page.ok) {
      await setProgress({ state: "error", message: `Failed listing submissions: ${page && page.error}` });
      return;
    }

    for (const s of page.submissions) {
      if (config.acceptedOnly === false || s.status_display === "Accepted") {
        const slug = sanitizeSlug(s.title_slug || "");
        if (!slug) continue;
        const existing = bestByProblem.get(slug);
        // submissions_dump is newest-first, so the first one we see per
        // problem is already the most recent — keep it.
        if (!existing) {
          bestByProblem.set(slug, s);
        }
      }
    }

    hasNext = page.hasNext;
    offset += 20;
    await setProgress({
      state: "running",
      message: `Scanned ${offset} submissions, found ${bestByProblem.size} unique solved problems so far…`,
      done: 0,
      total: 0
    });
    await sleep(250); // be gentle with LeetCode's endpoint
  }

  const problems = Array.from(bestByProblem.values());
  const syncedMap = await getSyncedMap(config);

  // Filter out problems whose latest accepted submission we've already pushed.
  const toSync = problems.filter((s) => {
    const slug = sanitizeSlug(s.title_slug || "");
    const rec = syncedMap[slug];
    return !rec || String(rec.submissionId) !== String(s.id);
  });

  if (toSync.length === 0) {
    await setProgress({ state: "complete", message: "Already up to date. No changes needed.", done: 0, total: 0 });
    return;
  }

  // Sort oldest-first so commits are in chronological order on the branch.
  // Contribution visibility is separately governed by GitHub profile rules.
  toSync.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // 2. Fetch the current tip and tree once to build the chain sequentially in memory.
  // This avoids a race condition where eventual consistency on GitHub's ref endpoints
  // causes subsequent updates to overwrite previous ones.
  let currentTipSha = null;
  let currentTreeSha = null;

  try {
    const ref = await ensureBranch(config);
    currentTipSha = ref.object.sha;
    const tipCommit = await getCommit(config, currentTipSha);
    currentTreeSha = tipCommit.tree.sha;
  } catch (err) {
    await setProgress({ state: "error", message: `Failed to resolve repository state: ${err.message}` });
    return;
  }

  await setProgress({
    state: "running",
    message: `${problems.length} solved problems found. ${toSync.length} need syncing (new or updated).`,
    done: 0,
    total: toSync.length
  });

  let done = 0;
  let errors = 0;

  for (const s of toSync) {
    try {
      const detailResp = await sendToTab(tab.id, {
        type: "LC_FETCH_SUBMISSION_DETAIL",
        submissionId: s.id
      });
      if (!detailResp || !detailResp.ok || !detailResp.detail) {
        throw new Error((detailResp && detailResp.error) || "no detail returned");
      }
      const detail = detailResp.detail;
      const langSlug = s.lang || (detail.lang && detail.lang.name) || "txt";
      const ext = extFor(langSlug);
      const slug = sanitizeSlug(s.title_slug || "");
      const folder = solutionFolder(config, slug);
      const codePath = `${folder}/${slug}.${ext}`;
      const readmePath = `${folder}/README.md`;

      const difficulty = detail.question ? detail.question.difficulty : "";
      const title = detail.question ? detail.question.title : s.title;

      // Use the original LeetCode submission timestamp (Unix seconds)
      const solveTimestamp = s.timestamp || Math.floor(Date.now() / 1000);
      const solveDate = new Date(solveTimestamp * 1000);
      const solveDateStr = solveDate.toISOString().split("T")[0]; // YYYY-MM-DD

      const readmeContent = `# ${title}\n\n- Difficulty: ${difficulty}\n- LeetCode problem: https://leetcode.com/problems/${slug}/\n- Language: ${langSlug}\n- Runtime: ${detail.runtime || "n/a"}\n- Memory: ${detail.memory || "n/a"}\n- Solved: ${solveDateStr}\n`;

      // Create a single backdated commit with both files building on the in-memory chain
      const newCommit = await pushBackdatedCommit(
        config,
        [
          { path: codePath, content: detail.code || "" },
          { path: readmePath, content: readmeContent }
        ],
        `Solve: ${title} (${langSlug}) [${solveDateStr}]`,
        solveTimestamp,
        currentTipSha,
        currentTreeSha
      );

      // Move the pointers forward for the next commit in the chain
      currentTipSha = newCommit.sha;
      currentTreeSha = newCommit.tree.sha;

      await sleep(400); // rate-limit: significantly reduced sleep since we do fewer API calls now!

      syncedMap[slug] = { submissionId: s.id, submissionTimestamp: Number(s.timestamp), timestamp: Date.now() };
      await setSyncedMap(config, syncedMap);

      done += 1;
      await setProgress({
        state: "running",
        message: `Synced "${title}" — solved ${solveDateStr} (${done}/${toSync.length})`,
        done,
        total: toSync.length
      });
    } catch (err) {
      errors += 1;
      if ([401, 403, 409, 422, 429].includes(err.status)) {
        await setProgress({ state: "error", message: `${err.message} Sync stopped safely. Resolve access/rate limits or concurrent branch changes, then retry.`, done, total: toSync.length });
        return;
      }
      await setProgress({
        state: "running",
        message: `Error syncing "${s.title}": ${err.message}`,
        done,
        total: toSync.length
      });
      await sleep(500);
    }
  }

  await setProgress({
    state: errors ? "error" : "complete",
    message: `Done. ${done} problem(s) synced${errors ? `, ${errors} error(s)` : ""}. ${
      problems.length - toSync.length
    } already up to date.`,
    done,
    total: toSync.length
  });

  if (done > 0) {
    sendTelemetry(config.owner, config.repo, "bulk_sync_complete", done);
  }
}

async function syncSingleSubmission(s, senderTabId) {
  try {
    const config = await getConfig();
    if (!config || !config.token || !config.owner || !config.repo) {
      return;
    }

    if (!s || (config.acceptedOnly !== false && s.status_display !== "Accepted")) return;
    const slugKey = sanitizeSlug(s.title_slug || "");
    solutionFolder(config, slugKey);
    const previous = (await getSyncedMap(config))[slugKey];
    if (previous && (String(previous.submissionId) === String(s.id) ||
        previous.submissionTimestamp > Number(s.timestamp))) return;
    await resolveCommitAuthor(config);
    let tabId = senderTabId;
    if (!tabId) {
      const tabInfo = await findActiveLeetCodeTab().catch(() => null);
      if (tabInfo) tabId = tabInfo.tab.id;
    }
    if (!tabId) {
      throw new Error("No active LeetCode tab found for sync.");
    }

    // 1. Get current branch tip (null if repo is empty)
    const ref = await ensureBranch(config);

    const tipSha = ref.object.sha;
    const tipCommit = await getCommit(config, tipSha);
    const baseTreeSha = tipCommit.tree.sha;

    // 2. Fetch submission detail
    const detailResp = await sendToTab(tabId, {
      type: "LC_FETCH_SUBMISSION_DETAIL",
      submissionId: s.id
    });
    if (!detailResp || !detailResp.ok || !detailResp.detail) {
      throw new Error((detailResp && detailResp.error) || "no detail returned");
    }

    const detail = detailResp.detail;
    const langSlug = s.lang || (detail.lang && detail.lang.name) || "txt";
    const ext = extFor(langSlug);
    const slug = sanitizeSlug(s.title_slug || "");
    const folder = solutionFolder(config, slug);
    const codePath = `${folder}/${slug}.${ext}`;
    const readmePath = `${folder}/README.md`;

    const difficulty = detail.question ? detail.question.difficulty : "";
    const title = detail.question ? detail.question.title : s.title;

    const solveTimestamp = s.timestamp || Math.floor(Date.now() / 1000);
    const solveDate = new Date(solveTimestamp * 1000);
    const solveDateStr = solveDate.toISOString().split("T")[0];

    const readmeContent = `# ${title}\n\n- Difficulty: ${difficulty}\n- LeetCode problem: https://leetcode.com/problems/${slug}/\n- Language: ${langSlug}\n- Runtime: ${detail.runtime || "n/a"}\n- Memory: ${detail.memory || "n/a"}\n- Solved: ${solveDateStr}\n`;

    await setProgress({
      state: "running",
      message: `Auto-syncing: "${title}"…`,
      done: 0,
      total: 1
    });

    await pushBackdatedCommit(
      config,
      [
        { path: codePath, content: detail.code || "" },
        { path: readmePath, content: readmeContent }
      ],
      `Solve: ${title} (${langSlug}) [${solveDateStr}] (auto)`,
      solveTimestamp,
      tipSha,
      baseTreeSha
    );

    // Save to sync history
    const syncedMap = await getSyncedMap(config);
    syncedMap[slug] = { submissionId: s.id, submissionTimestamp: Number(s.timestamp), timestamp: Date.now() };
    await setSyncedMap(config, syncedMap);

    await setProgress({
      state: "complete",
      message: `Auto-synced: "${title}" ✓`,
      done: 1,
      total: 1
    });

    sendTelemetry(config.owner, config.repo, "auto_sync_complete", 1);
  } catch (err) {
    console.error("Auto-sync error:", err);
    await setProgress({
      state: "error",
      message: `Auto-sync failed: ${err.message}`
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_SYNC_STATUS") {
    sendResponse({ busy: pendingSyncs > 0 });
  } else if (message.type === "START_SYNC") {
    if (pendingSyncs) { sendResponse({ ok: false, error: "A sync is already running." }); return; }
    enqueueSync(runSync);
    sendResponse({ ok: true, started: true });
  } else if (message.type === "RESET_SYNC_STATE") {
    if (pendingSyncs) { sendResponse({ ok: false, error: "Wait for the current sync before resetting." }); return; }
    (async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter(key => key === "progress" || key === "syncedProblems" || key.startsWith("syncedProblems:")));
      sendResponse({ ok: true });
    })().catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  } else if (message.type === "SYNC_SUBMISSION") {
    enqueueSync(() => syncSingleSubmission(message.submission, sender.tab?.id));
    sendResponse({ ok: true });
  }
});
