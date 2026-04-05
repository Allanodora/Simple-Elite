const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { constants: FS_CONSTANTS } = require("fs");

const pty = require("node-pty");

let win;
let shell;

function _homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

app.setName("Simple Elite");

function _unique(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const s = String(v || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function _pathDirs() {
  const envPath = (process.env.PATH || "").split(path.delimiter);
  const common = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    _homePath(".local", "bin"),
  ];
  return _unique([...envPath, ...common]);
}

function _findExecutable(commandName) {
  const name = (commandName || "").toString().trim();
  if (!name) return null;
  if (name.includes("/") && fs.existsSync(name)) return name;

  for (const dir of _pathDirs()) {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, FS_CONSTANTS.X_OK);
      return full;
    } catch {
      // ignore
    }
  }
  return null;
}

const _binCache = new Map(); // name -> resolved path | null
function _bin(name) {
  if (_binCache.has(name)) return _binCache.get(name);
  const resolved = _findExecutable(name);
  _binCache.set(name, resolved);
  return resolved;
}

function _sqlQuote(text) {
  return `'${String(text ?? "").replaceAll("'", "''")}'`;
}

async function _sqliteAllJson(dbPath, sql) {
  return await new Promise((resolve, reject) => {
    const sqlite3Path = _bin("sqlite3") || "/usr/bin/sqlite3";
    const child = spawn(sqlite3Path, ["-readonly", "-json", dbPath, sql], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `sqlite3 exited ${code}`).trim()));
        return;
      }
      const trimmed = (stdout || "").trim();
      if (!trimmed) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function _extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") {
      out += item;
      continue;
    }
    if (item.type === "output_text" && typeof item.text === "string") {
      out += item.text;
      continue;
    }
    if (item.type === "input_text" && typeof item.text === "string") {
      out += item.text;
      continue;
    }
    if (typeof item.text === "string") {
      out += item.text;
      continue;
    }
  }
  return out;
}

function _parseCodexRolloutMessages(rolloutPath) {
  try {
    if (!rolloutPath || !fs.existsSync(rolloutPath)) return [];
    const raw = fs.readFileSync(rolloutPath, "utf8");
    const lines = raw.split(/\r?\n/);
    const messages = [];
    let idx = 0;
    for (const line of lines) {
      const trimmed = (line || "").trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj?.type !== "response_item") continue;
      const payload = obj?.payload;
      if (!payload || typeof payload !== "object") continue;
      if (payload.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = (_extractTextFromContent(payload.content) || "").trim();
      if (!text) continue;
      messages.push({ idx, role, text, ts: obj.timestamp });
      idx += 1;
    }
    return messages;
  } catch {
    return [];
  }
}

function _pageMessages(messages, limit = 15, before = null) {
  const total = messages.length;
  const beforeIdx =
    before === null || before === undefined
      ? total
      : Math.max(0, Math.min(Number(before) || 0, total));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 15, 100));
  const start = Math.max(0, beforeIdx - safeLimit);
  const page = messages.slice(start, beforeIdx);
  return { messages: page, next_before: start > 0 ? start : null };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Simple Elite",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  win.loadFile("index.html");
  win.setTitle("Simple Elite");

  win.webContents.on("did-finish-load", () => {
    shell = pty.spawn("/bin/zsh", ["-i"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.env.HOME,
      env: process.env,
    });

    shell.onData((data) => {
      win?.webContents?.send("terminal-data", data);
    });
  });
}

ipcMain.on("terminal-input", (_evt, input) => {
  if (shell) shell.write(input);
});

function _codexDbPath() {
  return _homePath(".codex", "state_5.sqlite");
}

ipcMain.handle("codex:listThreads", async (_evt, args) => {
  const q = (args?.q || "").toString().trim();
  const limit = Math.max(1, Math.min(Number(args?.limit) || 50, 200));
  const dbPath = _codexDbPath();
  if (!fs.existsSync(dbPath)) return { threads: [] };
  const like = q ? ` AND title LIKE ${_sqlQuote(`%${q}%`)}` : "";
  const sql = `SELECT id, title, created_at, updated_at, cwd
               FROM threads
               WHERE archived = 0${like}
               ORDER BY updated_at DESC, created_at DESC
               LIMIT ${limit}`;
  const rows = await _sqliteAllJson(dbPath, sql);
  return { threads: rows };
});

ipcMain.handle("codex:getMessages", async (_evt, args) => {
  const threadId = (args?.threadId || "").toString();
  const limit = Number(args?.limit) || 15;
  const before =
    args?.before === undefined || args?.before === null ? null : args.before;

  const dbPath = _codexDbPath();
  if (!fs.existsSync(dbPath)) return { messages: [], next_before: null };
  const sql = `SELECT id, rollout_path, archived
               FROM threads
               WHERE id = ${_sqlQuote(threadId)}
               LIMIT 1`;
  const rows = await _sqliteAllJson(dbPath, sql);
  const row = rows[0];
  if (!row || Number(row.archived || 0) !== 0) return { messages: [], next_before: null };
  const messages = _parseCodexRolloutMessages(row.rollout_path);
  return _pageMessages(messages, limit, before);
});

function _runCmdCapture(cmd, { input, ...opts } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      ...opts,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      resolve({ code: 1, stdout, stderr: `${stderr}\n${String(e)}`.trim() })
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

    if (typeof input === "string") {
      try {
        child.stdin.write(input);
      } catch {
        // ignore
      }
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
    }
  });
}

function _jsonlIter(text) {
  const lines = (text || "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = (line || "").trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore
    }
  }
  return out;
}

ipcMain.handle("codex:send", async (_evt, args) => {
  const threadId = (args?.threadId || "").toString();
  const prompt = (args?.prompt || "").toString().trim();
  const mode = (args?.mode || "manual").toString().toLowerCase();
  if (!threadId) return { error: "Missing threadId" };
  if (!prompt) return { error: "Empty prompt" };

  const dbPath = _codexDbPath();
  if (!fs.existsSync(dbPath)) return { error: "Codex DB not found" };
  const rows = await _sqliteAllJson(
    dbPath,
    `SELECT id, cwd, rollout_path, archived
     FROM threads
     WHERE id = ${_sqlQuote(threadId)}
     LIMIT 1`
  );
  const row = rows[0];
  if (!row || Number(row.archived || 0) !== 0) return { error: "Unknown thread" };

  const rolloutPath = row.rollout_path;
  const beforeMessages = _parseCodexRolloutMessages(rolloutPath);
  const beforeTotal = beforeMessages.length;
  let beforeLastAssistant = "";
  for (let i = beforeMessages.length - 1; i >= 0; i--) {
    if (beforeMessages[i].role === "assistant") {
      beforeLastAssistant = beforeMessages[i].text || "";
      break;
    }
  }

  const cwd = (row.cwd || "").toString().trim() || os.homedir();
  const codexPath = _bin("codex");
  if (!codexPath) return { error: "codex not found (install Codex CLI or add it to PATH)" };
  const base = [codexPath, "exec", "--json", "--skip-git-repo-check", "-C", cwd];
  if (mode === "auto") base.push("--full-auto");
  else base.push("-s", "read-only");
  const cmd = [...base, "resume", threadId, "-"];

  return await new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      resolve({ error: `Failed to run Codex: ${String(e)}` });
    });
    child.stdin.write(prompt);
    child.stdin.end();
    child.on("close", (code) => {
      if (code !== 0) {
        const msg = (stderr || "").trim() || `Codex exited with ${code}`;
        resolve({ error: msg.slice(0, 4000) });
        return;
      }
      const afterMessages = _parseCodexRolloutMessages(rolloutPath);
      const newSlice =
        afterMessages.length >= beforeTotal
          ? afterMessages.slice(beforeTotal)
          : afterMessages;

      let assistant = "";
      for (let i = newSlice.length - 1; i >= 0; i--) {
        if (newSlice[i].role === "assistant") {
          assistant = newSlice[i].text || "";
          break;
        }
      }
      if (!assistant) {
        for (let i = afterMessages.length - 1; i >= 0; i--) {
          if (afterMessages[i].role === "assistant") {
            assistant = afterMessages[i].text || "";
            break;
          }
        }
        if (assistant && assistant === beforeLastAssistant) assistant = "";
      }
      if (!assistant) assistant = "Codex ran, but no new assistant message was detected.";
      resolve({ response: assistant });
    });
  });
});

ipcMain.handle("codex:newThread", async (_evt, args) => {
  const cwd = (args?.cwd || "").toString().trim() || os.homedir();
  const title = (args?.title || "").toString().trim() || "New chat";
  const mode = (args?.mode || "manual").toString().toLowerCase();

  const codexPath = _bin("codex");
  if (!codexPath) return { error: "codex not found (install Codex CLI or add it to PATH)" };
  const base = [codexPath, "exec", "--json", "--skip-git-repo-check", "-C", cwd];
  if (mode === "auto") base.push("--full-auto");
  else base.push("-s", "read-only");

  const seedPrompt = `${title}\n\nStart a new conversation for this project. Reply with 'ready' only.`;
  const cmd = [...base, "-"];

  const result = await _runCmdCapture(cmd, { input: seedPrompt });

  if (result.code !== 0) {
    const msg = (result.stderr || result.stdout || `Codex exited with ${result.code}`).trim();
    return { error: msg.slice(0, 4000) };
  }

  let threadId = "";
  for (const obj of _jsonlIter(result.stdout)) {
    if (obj?.type === "session_meta" && obj?.payload && typeof obj.payload === "object") {
      const id = obj.payload.id;
      if (typeof id === "string" && id) threadId = id;
    }
    if (!threadId && obj?.payload && typeof obj.payload === "object") {
      const alt = obj.payload.thread_id || obj.payload.session_id;
      if (typeof alt === "string" && alt) threadId = alt;
    }
  }

  // Fallback: newest thread for that cwd
  const dbPath = _codexDbPath();
  if (!fs.existsSync(dbPath)) return { error: "Codex DB not found" };
  if (threadId) {
    const rowsById = await _sqliteAllJson(
      dbPath,
      `SELECT id, title, cwd FROM threads WHERE archived = 0 AND id = ${_sqlQuote(
        threadId
      )} LIMIT 1`
    );
    if (rowsById[0]) {
      const r = rowsById[0];
      return { id: r.id, title: r.title || title, cwd: r.cwd || cwd };
    }
  }
  const rowsNewest = await _sqliteAllJson(
    dbPath,
    `SELECT id, title, cwd
     FROM threads
     WHERE archived = 0 AND cwd = ${_sqlQuote(cwd)}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  );
  if (!rowsNewest[0]) return { error: "Created thread, but could not locate it in DB" };
  return {
    id: rowsNewest[0].id,
    title: rowsNewest[0].title || title,
    cwd: rowsNewest[0].cwd || cwd,
  };
});

function _openCodeDbPath() {
  return _homePath(".local", "share", "opencode", "opencode.db");
}

ipcMain.handle("opencode:listSessions", async (_evt, args) => {
  const q = (args?.q || "").toString().trim();
  const limit = Math.max(1, Math.min(Number(args?.limit) || 50, 200));
  const dbPath = _openCodeDbPath();
  if (!fs.existsSync(dbPath)) return { sessions: [] };
  const like = q
    ? ` WHERE title LIKE ${_sqlQuote(`%${q}%`)} OR directory LIKE ${_sqlQuote(
        `%${q}%`
      )}`
    : "";
  const sql = `SELECT id, title, directory, time_updated
               FROM session${like}
               ORDER BY time_updated DESC
               LIMIT ${limit}`;
  const rows = await _sqliteAllJson(dbPath, sql);
  return { sessions: rows };
});

function _opencodeExtractMessageText(data) {
  if (typeof data?.content === "string") return data.content;
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.message === "string") return data.message;
  if (Array.isArray(data?.parts)) return _extractTextFromContent(data.parts);
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data).slice(0, 2000);
  } catch {
    return "";
  }
}

function _opencodeExtractPartText(partData) {
  if (!partData || typeof partData !== "object") return "";
  if (typeof partData.text === "string") return partData.text;
  if (typeof partData.content === "string") return partData.content;
  return "";
}

ipcMain.handle("opencode:getMessages", async (_evt, args) => {
  const sessionId = (args?.sessionId || "").toString();
  const limit = Math.max(1, Math.min(Number(args?.limit) || 15, 100));
  const before =
    args?.before === undefined || args?.before === null ? null : Number(args.before);

  const dbPath = _openCodeDbPath();
  if (!fs.existsSync(dbPath)) return { messages: [], next_before: null };
	  const beforeClause =
	    before !== null ? ` AND time_created < ${Number(before) || 0}` : "";
	  const sql = `SELECT id, time_created, data
	               FROM message
	               WHERE session_id = ${_sqlQuote(sessionId)}${beforeClause}
	               ORDER BY time_created DESC
	               LIMIT ${limit}`;
	  const rows = await _sqliteAllJson(dbPath, sql);

	  let nextBefore = null;
	  if (rows.length) nextBefore = rows[rows.length - 1].time_created;

	  // Fetch parts for these messages (user content is stored in `part` rows).
	  const messageIds = rows.map((r) => r.id).filter(Boolean);

	  const partTextByMessageId = new Map();
	  if (messageIds.length) {
	    const inList = messageIds.map((id) => _sqlQuote(id)).join(", ");
    const partRows = await _sqliteAllJson(
      dbPath,
      `SELECT message_id, data
       FROM part
       WHERE session_id = ${_sqlQuote(sessionId)} AND message_id IN (${inList})
       ORDER BY time_created ASC`
    );
    for (const pr of partRows) {
      let partObj;
      try {
        partObj = JSON.parse(pr.data);
      } catch {
        continue;
      }
      const t = _opencodeExtractPartText(partObj);
      if (!t) continue;
      const prev = partTextByMessageId.get(pr.message_id) || "";
      partTextByMessageId.set(pr.message_id, prev ? `${prev}\n${t}` : t);
    }
  }

  const msgs = [];
	  for (let i = rows.length - 1; i >= 0; i--) {
	    const r = rows[i];
	    let data;
	    try {
	      data = JSON.parse(r.data);
	    } catch {
	      continue;
	    }
	    let role = data?.role;
	    if (role !== "user" && role !== "assistant" && role !== "system") role = "system";
	    const msgId = r.id;
	    let text = "";
	    if (msgId && partTextByMessageId.has(msgId)) {
	      text = partTextByMessageId.get(msgId);
	    } else {
      text = (_opencodeExtractMessageText(data) || "").toString();
    }
    if (!text && role === "assistant") {
      text = "[assistant message has no text output]";
    }
    if (!text) continue;
    msgs.push({ role, text, ts: r.time_created });
  }
  return { messages: msgs, next_before: nextBefore };
});

let _opencodeServerProc = null;
async function _isOpenCodeServerUp() {
  const base = "http://127.0.0.1:9090/";
  try {
    const r = await fetch(base, { method: "GET" });
    return r.status === 200;
  } catch {
    return false;
  }
}
async function _ensureOpenCodeServerRunning() {
  const base = "http://127.0.0.1:9090/";
  try {
    const r = await fetch(base, { method: "GET" });
    if (r.status === 200) return true;
  } catch {
    // continue
  }

  if (!_opencodeServerProc) {
    const opencodePath = _bin("opencode");
    if (!opencodePath) return false;
    try {
      _opencodeServerProc = spawn(
        opencodePath,
        ["serve", "--port", "9090", "--hostname", "127.0.0.1"],
        { stdio: "ignore", detached: true }
      );
      _opencodeServerProc.on("error", () => {
        _opencodeServerProc = null;
      });
      _opencodeServerProc.unref();
    } catch {
      _opencodeServerProc = null;
    }
  }

  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(base, { method: "GET" });
      if (r.status === 200) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

ipcMain.handle("opencode:ensureServer", async () => {
  const ok = await _ensureOpenCodeServerRunning();
  if (!ok) return { error: "Could not start OpenCode server" };
  return { ok: true, url: "http://127.0.0.1:9090/" };
});

ipcMain.handle("opencode:send", async (_evt, args) => {
  const sessionId = (args?.sessionId || "").toString();
  const prompt = (args?.prompt || "").toString().trim();
  if (!sessionId) return { error: "Missing sessionId" };
  if (!prompt) return { error: "Empty prompt" };

  const dbPath = _openCodeDbPath();
  if (!fs.existsSync(dbPath)) return { error: "OpenCode DB not found" };

  try {
    // Get session directory (best-effort) and the latest message timestamp before sending.
    const sessRows = await _sqliteAllJson(
      dbPath,
      `SELECT id, directory
       FROM session
       WHERE id = ${_sqlQuote(sessionId)}
       LIMIT 1`
    );
    const sessionDir = (sessRows[0]?.directory || "").toString().trim();

    const beforeRows = await _sqliteAllJson(
      dbPath,
      `SELECT MAX(time_created) AS t
       FROM message
       WHERE session_id = ${_sqlQuote(sessionId)}`
    );
    const beforeT = Number(beforeRows[0]?.t || 0) || 0;

    const cmd = [
      _bin("opencode") || "opencode",
      "run",
      "--format",
      "json",
      "--session",
      sessionId,
    ];
    if (sessionDir) cmd.push("--dir", sessionDir);

    const result = await _runCmdCapture([...cmd, prompt], { input: prompt });
    if (result.code !== 0) {
      const msg = (result.stderr || result.stdout || `opencode exited ${result.code}`)
        .toString()
        .trim();
      return { error: msg.slice(0, 4000) };
    }

    // Pull newest assistant message after run.
    const msgRows = await _sqliteAllJson(
      dbPath,
      `SELECT time_created, data
       FROM message
       WHERE session_id = ${_sqlQuote(sessionId)} AND time_created > ${beforeT}
       ORDER BY time_created DESC
       LIMIT 50`
    );
    for (const r of msgRows) {
      try {
        const data = JSON.parse(r.data);
        if (data?.role === "assistant") {
          const text = (_opencodeExtractMessageText(data) || "").toString();
          if (text) return { response: text.slice(0, 16000) };
        }
      } catch {
        // ignore
      }
    }

    return { response: "OpenCode ran, but no new assistant message was detected." };
  } catch (e) {
    return { error: `Failed to run OpenCode: ${e}` };
  }
});

ipcMain.handle("opencode:newSession", async (_evt, args) => {
  const title = (args?.title || "").toString().trim() || "New chat";
  const dir = (args?.dir || "").toString().trim() || os.homedir();

  // Create a new session by running a minimal prompt (no --continue / --session).
  // Then query the DB for the newest session and return its id.
  const opencodePath = _bin("opencode");
  if (!opencodePath) return { error: "opencode not found (install OpenCode CLI or add it to PATH)" };
  try {
    await _runCmdCapture(
      [
        opencodePath,
        "run",
        "--format",
        "json",
        "--title",
        title,
        "--dir",
        dir,
        "ready",
      ],
      { input: "ready" }
    );
  } catch (e) {
    return { error: `Failed to start OpenCode: ${e}` };
  }

  const dbPath = _openCodeDbPath();
  if (!fs.existsSync(dbPath)) return { error: "OpenCode DB not found" };
  try {
    const rows = await _sqliteAllJson(
      dbPath,
      `SELECT id, title, directory, time_updated
       FROM session
       ORDER BY time_updated DESC
       LIMIT 1`
    );
    if (!rows[0]?.id) return { error: "Created session, but could not find it" };
    return { id: rows[0].id, title: rows[0].title || title };
  } catch (e) {
    return { error: `Failed to read OpenCode DB: ${e}` };
  }
});

app.whenReady().then(createWindow);

app.on("before-quit", async () => {
  // Best-effort cleanup of a detached opencode server we started.
  try {
    if (_opencodeServerProc && !_opencodeServerProc.killed) {
      _opencodeServerProc.kill();
    }
  } catch {
    // ignore
  }
});
