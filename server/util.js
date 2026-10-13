'use strict';
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic-ish JSON write (tmp file + rename), private to the current user. */
function writeJson(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the rename while a virus scanner holds the file.
    fs.writeFileSync(file, text, { mode });
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Keeps result order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function createLogger({ file, quiet = false } = {}) {
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (!quiet) (level === 'error' ? console.error : console.log)(line);
    if (!file) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, `${line}\n`);
    } catch { /* logging must never crash the app */ }
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

module.exports = { readJson, writeJson, mapLimit, createLogger, HttpError };
