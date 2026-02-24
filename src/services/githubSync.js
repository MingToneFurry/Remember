function toBase64Utf8(input) {
  return btoa(unescape(encodeURIComponent(String(input ?? ""))));
}

function getGitHubConfig(env) {
  const owner = String(env.GITHUB_OWNER || "").trim();
  const repo = String(env.GITHUB_REPO || "").trim();
  const token = String(env.GITHUB_TOKEN || env.GITHUB_PAT || "").trim();
  const branch = String(env.GITHUB_BRANCH || "generated-pages").trim();
  const prefix = String(env.GITHUB_PAGES_PREFIX || "generated").trim();
  return { owner, repo, token, branch, prefix };
}

async function getRemoteSha(fetchImpl, config, path) {
  const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path}?ref=${encodeURIComponent(config.branch)}`;
  const resp = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "remember-worker",
    },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`github get sha failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return String(data?.sha || "");
}

async function putFile(fetchImpl, config, path, content, message) {
  const sha = await getRemoteSha(fetchImpl, config, path);
  const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path}`;
  const body = {
    message,
    content: toBase64Utf8(content),
    branch: config.branch,
  };
  if (sha) body.sha = sha;
  const resp = await fetchImpl(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "remember-worker",
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`github put failed: ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  return String(data?.commit?.sha || "");
}

export async function syncGeneratedPageToGitHub(env, payload, fetchImpl = fetch) {
  const config = getGitHubConfig(env);
  if (!config.owner || !config.repo || !config.token) {
    return {
      status: "skipped",
      branch: config.branch,
      commitSha: "",
      files: [],
      committedAt: Date.now(),
      reason: "GitHub 配置缺失",
    };
  }

  try {
    const uid = String(payload.uid || "").trim();
    const files = [
      {
        path: `${config.prefix}/pages/${encodeURIComponent(uid)}.html`,
        content: String(payload.html || ""),
        message: `chore: 更新 UID ${uid} 纪念页`,
      },
    ];
    if (payload.item) {
      files.push({
        path: `${config.prefix}/meta/${encodeURIComponent(uid)}.json`,
        content: JSON.stringify(payload.item, null, 2),
        message: `chore: 更新 UID ${uid} 元数据`,
      });
    }
    if (Array.isArray(payload.recentList)) {
      files.push({
        path: `${config.prefix}/recent.json`,
        content: JSON.stringify({ updatedAt: Date.now(), items: payload.recentList }, null, 2),
        message: "chore: 更新 recent 索引",
      });
    }
    if (payload.sitemapXml) {
      files.push({
        path: `${config.prefix}/sitemap.xml`,
        content: String(payload.sitemapXml),
        message: "chore: 更新 sitemap 索引",
      });
    }

    let commitSha = "";
    for (const file of files) {
      commitSha = await putFile(fetchImpl, config, file.path, file.content, file.message);
    }
    return {
      status: "succeeded",
      branch: config.branch,
      commitSha,
      files: files.map((f) => f.path),
      committedAt: Date.now(),
      reason: "",
    };
  } catch (err) {
    return {
      status: "failed",
      branch: config.branch,
      commitSha: "",
      files: [],
      committedAt: Date.now(),
      reason: String(err?.message || err),
    };
  }
}
