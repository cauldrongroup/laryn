import { contextBridge as d, ipcRenderer as r } from "electron";
d.exposeInMainWorld("laryn", {
  ready: () => r.invoke("renderer:ready"),
  checkWorker: () => r.invoke("worker:check"),
  recordingStarted: () => r.send("recording:started"),
  recordingStopped: () => r.send("recording:stopped"),
  transcribeAudio: (e, n, o, t) => r.invoke("transcription:submit", e, n, o, t),
  onStartRecording: (e) => {
    r.on("recording:start", e);
  },
  onStopRecording: (e) => {
    r.on("recording:stop", e);
  },
  onStatus: (e) => {
    r.on("desktop:status", (n, o) => e(o));
  }
});
