async function fetchData() {
  try {
    document.querySelector('.live-indicator span:last-child').textContent = 'Dashboard Online';
    // Fetch stats
    const statsRes = await fetch('/api/stats');
    if (!statsRes.ok) throw new Error('Dashboard unavailable: HTTP ' + statsRes.status);
    const stats = await statsRes.json();
    document.getElementById('totalUsers').textContent = stats.totalUsers;
    document.getElementById('totalSyncs').textContent = stats.totalSyncs;
    document.getElementById('totalProblems').textContent = stats.totalProblemsSynced;

    // Fetch logs
    const logsRes = await fetch('/api/logs');
    if (!logsRes.ok) throw new Error('Logs unavailable: HTTP ' + logsRes.status);
    const logs = await logsRes.json();
    renderLogs(logs.length === 0 ? null : logs);

    // Bind Search Input
    const searchInput = document.getElementById('searchInput');
    searchInput.oninput = () => {
      const query = searchInput.value.toLowerCase().trim();
      const filtered = logs.filter((log) => {
        const owner = typeof log.owner === "string" ? log.owner : "";
        const repo = typeof log.repo === "string" ? log.repo : "";
        const action = typeof log.action === "string" ? log.action : "";
        return owner.toLowerCase().includes(query) ||
          repo.toLowerCase().includes(query) ||
          action.toLowerCase().includes(query);
      });
      renderLogs(filtered);
    };

  } catch (err) {
    console.error('Error fetching data:', err);
    document.querySelector('.live-indicator span:last-child').textContent = 'Connection unavailable';
  }
}

function renderLogs(logsList) {
  const logBody = document.getElementById("logBody");
  logBody.replaceChildren();

  if (!Array.isArray(logsList) || logsList.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "placeholder-row";
    cell.textContent = Array.isArray(logsList)
      ? "No matching records found."
      : "No sync history recorded yet. Open your extension and run a sync!";
    row.appendChild(cell);
    logBody.appendChild(row);
    return;
  }

  for (const log of logsList) {
    const owner = typeof log.owner === "string" ? log.owner : "";
    const repo = typeof log.repo === "string" ? log.repo : "";
    const action = typeof log.action === "string" ? log.action : "Unknown";

    const row = document.createElement("tr");

    const ownerCell = document.createElement("td");
    const userCell = document.createElement("div");
    userCell.className = "user-cell";
    const avatar = document.createElement("span");
    avatar.className = "user-avatar";
    avatar.textContent = owner.slice(0, 2).toUpperCase();
    const ownerLink = document.createElement("a");
    ownerLink.href = `https://github.com/${encodeURIComponent(owner)}`;
    ownerLink.target = "_blank";
    ownerLink.rel = "noopener noreferrer";
    ownerLink.className = "owner-link";
    ownerLink.textContent = `@${owner}`;
    userCell.append(avatar, ownerLink);
    ownerCell.appendChild(userCell);

    const repoCell = document.createElement("td");
    const repoLink = document.createElement("a");
    repoLink.href = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    repoLink.target = "_blank";
    repoLink.rel = "noopener noreferrer";
    repoLink.className = "repo-link";
    repoLink.textContent = repo;
    repoCell.appendChild(repoLink);

    const actionCell = document.createElement("td");
    const badge = document.createElement("span");
    const isBulk = action === "bulk_sync_complete";
    badge.className = `badge ${isBulk ? "bulk" : "auto"}`;
    badge.textContent = isBulk ? "Bulk Sync" : action === "auto_sync_complete" ? "Auto Sync" : action;
    actionCell.appendChild(badge);

    const countCell = document.createElement("td");
    countCell.className = "count-cell";
    countCell.textContent = String(log.problemsSynced ?? "");

    const versionCell = document.createElement("td");
    const version = document.createElement("code");
    version.className = "version-code";
    version.textContent = `v${String(log.version ?? "")}`;
    versionCell.appendChild(version);

    const dateCell = document.createElement("td");
    dateCell.className = "date-cell";
    const timestamp = typeof log.timestamp === "string" ? log.timestamp : "";
    const date = new Date(timestamp.replace(" ", "T") + "Z");
    dateCell.textContent = Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();

    row.append(ownerCell, repoCell, actionCell, countCell, versionCell, dateCell);
    logBody.appendChild(row);
  }
}

// Initial load and auto refresh
fetchData();
setInterval(fetchData, 10000);
