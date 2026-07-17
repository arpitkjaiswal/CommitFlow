// content.js
// Runs on leetcode.com. Because it executes in the page's origin, fetch()
// calls automatically carry the user's session cookies — no login/token
// handling needed on our side for reading submission data.

function getCsrf() {
  return document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
}

function graphqlFetch(query, variables, operationName) {
  return fetch("https://leetcode.com/graphql/", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Csrftoken": getCsrf(),
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://leetcode.com/"
    },
    body: JSON.stringify({ query, variables, operationName })
  });
}

/**
 * Pull one page of the user's FULL submission history via GraphQL.
 * LeetCode's GraphQL `submissionList` query is the modern replacement.
 */
async function fetchSubmissionsPage(offset, limit) {
  const query = `
    query submissionList($offset: Int!, $limit: Int!) {
      submissionList(offset: $offset, limit: $limit) {
        lastKey
        hasNext
        submissions {
          id
          title
          titleSlug
          status
          statusDisplay
          lang
          langName
          runtime
          memory
          timestamp
        }
      }
    }
  `;

  const res = await graphqlFetch(query, { offset, limit: limit || 20 }, "submissionList");

  if (!res.ok) {
    throw new Error(`Submissions page fetch failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(json.errors[0].message || "GraphQL error fetching submissions");
  }

  const data = json.data && json.data.submissionList;
  if (!data) throw new Error("No submissionList data returned");

  // Normalize field names to match what background.js expects
  const submissions = (data.submissions || []).map((s) => ({
    id: s.id,
    title: s.title,
    title_slug: s.titleSlug,
    status_display: s.statusDisplay,
    lang: s.lang,
    timestamp: Number(s.timestamp),
    runtime: s.runtime,
    memory: s.memory
  }));

  return {
    submissions,
    hasNext: !!data.hasNext,
    lastKey: data.lastKey || null
  };
}

/**
 * Fetch full code + metadata for a single submission via LeetCode's GraphQL.
 */
async function fetchSubmissionDetail(submissionId) {
  const query = `
    query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        runtime
        memory
        code
        lang {
          name
          verboseName
        }
        question {
          questionId
          titleSlug
          title
          difficulty
        }
      }
    }
  `;

  const res = await graphqlFetch(
    query,
    { submissionId: Number(submissionId) },
    "submissionDetails"
  );

  if (!res.ok) {
    throw new Error(`Submission detail fetch failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(json.errors[0].message || "GraphQL error fetching submission detail");
  }
  return json.data && json.data.submissionDetails;
}

/**
 * Check if the user is logged in via GraphQL (avoids deprecated REST API).
 */
async function checkLoggedIn() {
  const query = `
    query globalData {
      userStatus {
        isSignedIn
        username
      }
    }
  `;
  try {
    const res = await graphqlFetch(query, {}, "globalData");
    if (!res.ok) return false;
    const json = await res.json();
    return !!(json.data && json.data.userStatus && json.data.userStatus.isSignedIn);
  } catch {
    return false;
  }
}

// ─── Message Listener ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "LC_CHECK_LOGIN") {
        const ok = await checkLoggedIn();
        sendResponse({ ok: true, loggedIn: ok });
      } else if (message.type === "LC_FETCH_SUBMISSIONS_PAGE") {
        const result = await fetchSubmissionsPage(message.offset, message.limit || 20);
        sendResponse({ ok: true, ...result });
      } else if (message.type === "LC_FETCH_SUBMISSION_DETAIL") {
        const detail = await fetchSubmissionDetail(message.submissionId);
        sendResponse({ ok: true, detail });
      } else {
        sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});

// ─── Auto-Sync Submission Listener ──────────────────────────────────

let lastSeenSubmissionId = null;
let pollInterval = null;

async function getLatestSubmission() {
  try {
    const page = await fetchSubmissionsPage(0, 1);
    if (page && page.submissions && page.submissions.length > 0) {
      return page.submissions[0];
    }
  } catch (e) {
    console.error("Error fetching latest submission for auto-sync:", e);
  }
  return null;
}

async function startAutoSyncPolling() {
  if (pollInterval) return; // already polling

  let attempts = 0;
  const maxAttempts = 15; // 45 seconds max

  pollInterval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(pollInterval);
      pollInterval = null;
      return;
    }

    const latest = await getLatestSubmission();
    if (latest && String(latest.id) !== String(lastSeenSubmissionId)) {
      // Check if it's finished judging
      const isJudging = latest.status_display === "Pending" || latest.status_display === "Judging";
      if (!isJudging) {
        clearInterval(pollInterval);
        pollInterval = null;
        lastSeenSubmissionId = latest.id;

        // Send to background script to sync this specific submission
        chrome.runtime.sendMessage({
          type: "SYNC_SUBMISSION",
          submission: latest
        });
      }
    }
  }, 3000);
}

function initAutoSyncListener() {
  // Set initial baseline
  getLatestSubmission().then(latest => {
    if (latest) lastSeenSubmissionId = latest.id;
  });

  // Listen for click on submit button
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    
    const isSubmitBtn = 
      target.matches('button[data-e2e-locator="console-submit-btn"]') ||
      target.closest('button[data-e2e-locator="console-submit-btn"]') ||
      (target.tagName === "BUTTON" && target.textContent.trim() === "Submit") ||
      (target.closest("button") && target.closest("button").textContent.trim() === "Submit");

    if (isSubmitBtn) {
      setTimeout(startAutoSyncPolling, 4000);
    }
  });

  // Listen for Ctrl+Enter or Cmd+Enter keypress
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      setTimeout(startAutoSyncPolling, 4000);
    }
  });
}

// Initialize when ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAutoSyncListener);
} else {
  initAutoSyncListener();
}
