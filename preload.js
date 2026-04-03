const { contextBridge, ipcRenderer } = require("electron");

function on(channel, handler) {
  const listener = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("terminal", {
  sendInput: (data) => ipcRenderer.send("terminal-input", data),
  onData: (handler) => on("terminal-data", handler),
});

contextBridge.exposeInMainWorld("aiAssistant", {
  codex: {
    listThreads: (args) => ipcRenderer.invoke("codex:listThreads", args),
    getMessages: (args) => ipcRenderer.invoke("codex:getMessages", args),
    send: (args) => ipcRenderer.invoke("codex:send", args),
    newThread: (args) => ipcRenderer.invoke("codex:newThread", args),
  },
  opencode: {
    listSessions: (args) => ipcRenderer.invoke("opencode:listSessions", args),
    getMessages: (args) => ipcRenderer.invoke("opencode:getMessages", args),
    send: (args) => ipcRenderer.invoke("opencode:send", args),
  },
});
