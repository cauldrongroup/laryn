const fs = require("node:fs");

function createBufferedLogSink(filePath) {
  let stream = null;
  let closed = false;

  function ensureStream() {
    if (closed) return null;
    if (!stream) {
      stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
      stream.on("error", (error) => {
        console.warn("[laryn] failed to write log file", error);
      });
    }
    return stream;
  }

  return {
    write(line) {
      ensureStream()?.write(line);
    },
    close() {
      closed = true;
      stream?.end();
      stream = null;
    }
  };
}

module.exports = { createBufferedLogSink };
