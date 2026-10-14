'use strict';
/**
 * Reviewing a PR inside the app: its changed files, the diff of each file,
 * the comment threads (also on lines), commenting, replying and resolving.
 */
const { diffText, isBinary } = require('./diff');
const logic = require('./logic');
const { HttpError } = require('./util');

const MAX_FILE = 2 * 1024 * 1024;
const MAX_COMMENT = 20000;
// Thread statuses the app can set (Azure DevOps' numbers).
const STATUS = { active: 1, fixed: 2, wontFix: 3, closed: 4, byDesign: 5, pending: 6 };
const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));

const isHuman = (c) => c && !c.isDeleted && c.commentType !== 'system' && c.commentType !== 2 && c.commentType !== 'codeChange';

class Review {
  constructor({ ado, inbox, log }) {
    this.ado = ado;
    this.inbox = inbox;
    this.log = log;
    this.prs = new Map(); // key -> { at, iteration, files }
    this.blobs = new Map(); // objectId -> Buffer (small LRU)
    this.blobBytes = 0;
  }

  item(key) {
    const it = this.inbox.items.get(key);
    if (!it) throw new HttpError(404, 'That PR is no longer active');
    return it;
  }

  myId(it) {
    const meta = this.inbox.orgMeta.get(it.org);
    if (!meta) throw new HttpError(409, 'Still loading, try again in a second');
    return meta.myId;
  }

  /** Iterations and changed files, refreshed when the PR got new pushes. */
  async files(it, { fresh = false } = {}) {
    const hit = this.prs.get(it.key);
    if (hit && !fresh && hit.commit === it.commit && Date.now() - hit.at < 10 * 60e3) return hit;
    const iterations = await this.ado.iterations(it);
    const last = iterations[iterations.length - 1] || null;
    const files = last ? await this.ado.changes(it, last.id) : [];
    files.sort((a, b) => a.path.localeCompare(b.path));
    const entry = { at: Date.now(), commit: it.commit, iteration: last, iterations: iterations.length, files };
    this.prs.set(it.key, entry);
    if (this.prs.size > 30) this.prs.delete(this.prs.keys().next().value);
    return entry;
  }

  /** Everything the review screen opens with. */
  async open(key) {
    const it = this.item(key);
    const myId = this.myId(it);
    const [pr, full] = await Promise.all([
      this.files(it, { fresh: true }),
      this.ado.pullRequest(it).catch(() => null),
    ]);
    // Comment positions are tracked to the latest push.
    const threads = await this.loadThreads(it, pr.iteration && pr.iteration.id, myId);
    return {
      ...this.shape(it, pr, threads),
      commit: it.commit,
      description: full && typeof full.description === 'string' ? full.description : it.description,
    };
  }

  shape(it, pr, threads) {
    const open = (t) => t.status === 'active' || t.status === 'pending';
    return {
      key: it.key,
      iteration: pr.iteration ? pr.iteration.id : null,
      iterations: pr.iterations,
      files: pr.files.map((f) => ({
        path: f.path,
        originalPath: f.originalPath,
        type: f.type,
        version: f.objectId || f.originalObjectId || null,
        comments: threads.filter((t) => t.path === f.path && open(t)).length,
      })),
      threads,
    };
  }

  async loadThreads(it, iterationId, myId) {
    const raw = iterationId ? await this.ado.threadsAt(it, iterationId) : await this.ado.threads(it);
    return raw
      .filter((t) => t && !t.isDeleted && Array.isArray(t.comments) && isHuman(t.comments[0]))
      .map((t) => {
        const ctx = t.threadContext || null;
        const right = ctx && (ctx.rightFileStart || ctx.rightFileEnd);
        const left = ctx && (ctx.leftFileStart || ctx.leftFileEnd);
        const status = typeof t.status === 'number' ? STATUS_NAME[t.status] || 'active' : String(t.status || 'active');
        return {
          id: t.id,
          status: status === 'unknown' ? 'active' : status,
          path: (ctx && ctx.filePath) || null,
          side: right ? 'right' : left ? 'left' : null,
          line: right ? right.line : left ? left.line : null,
          comments: t.comments.filter(isHuman).map((c) => ({
            id: c.id,
            parentId: c.parentCommentId || 0,
            by: (c.author && c.author.displayName) || 'Someone',
            image: logic.imageOf(c.author),
            me: !!(c.author && c.author.id === myId),
            text: String(c.content || ''),
            at: c.publishedDate || c.lastUpdatedDate || null,
          })),
        };
      })
      .sort((a, b) => Date.parse(a.comments[0].at || 0) - Date.parse(b.comments[0].at || 0));
  }

  async threads(key) {
    const it = this.item(key);
    const pr = await this.files(it);
    const threads = await this.loadThreads(it, pr.iteration && pr.iteration.id, this.myId(it));
    // Your own comments changed here: the inbox takes that in quietly.
    const started = threads.filter((t) => t.comments[0] && t.comments[0].me);
    this.inbox.setMyThreads(key, { total: started.length, open: started.filter((t) => t.status === 'active' || t.status === 'pending').length });
    return this.shape(it, pr, threads);
  }

  async content(it, objectId, path, commit) {
    if (objectId && this.blobs.has(objectId)) return this.blobs.get(objectId);
    let buf = null;
    if (objectId) buf = await this.ado.blob(it, objectId);
    else if (path && commit) buf = await this.ado.fileAt(it, path, commit);
    else return Buffer.alloc(0);
    if (objectId && buf.length < MAX_FILE) {
      this.blobs.set(objectId, buf);
      this.blobBytes += buf.length;
      while (this.blobBytes > 40 * 1024 * 1024 && this.blobs.size) {
        const [k, v] = this.blobs.entries().next().value;
        this.blobs.delete(k);
        this.blobBytes -= v.length;
      }
    }
    return buf;
  }

  /** The diff of one file: every line, marked unchanged/removed/added. */
  async diff(key, path) {
    const it = this.item(key);
    const pr = await this.files(it);
    const f = pr.files.find((x) => x.path === path);
    if (!f) throw new HttpError(404, 'That file is not part of this PR');
    const type = f.type.toLowerCase();
    const added = type.includes('add');
    const deleted = type.includes('delete');
    const it2 = pr.iteration || {};
    const [oldBuf, newBuf] = await Promise.all([
      added ? Buffer.alloc(0) : this.content(it, f.originalObjectId, f.originalPath || f.path, it2.base),
      deleted ? Buffer.alloc(0) : this.content(it, f.objectId, f.path, it2.source),
    ]);
    const base = { path: f.path, originalPath: f.originalPath, type: f.type, version: f.objectId || f.originalObjectId || null };
    if (isBinary(oldBuf) || isBinary(newBuf)) return { ...base, binary: true };
    if (oldBuf.length > MAX_FILE || newBuf.length > MAX_FILE) return { ...base, tooLarge: true };
    const d = diffText(oldBuf.toString('utf8'), newBuf.toString('utf8'));
    return { ...base, ...d };
  }

  /**
   * Comment: a reply (threadId), a comment on a line (path + line + side) or on
   * a whole file (path), or a general comment on the PR.
   */
  async comment(key, { content, threadId, path, line, side, lineText } = {}) {
    const it = this.item(key);
    const text = String(content || '').trim();
    if (!text) throw new HttpError(400, 'Write something first');
    if (text.length > MAX_COMMENT) throw new HttpError(400, 'That comment is too long');
    if (threadId !== undefined && threadId !== null) {
      const id = Number(threadId);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Unknown thread');
      const all = await this.ado.threads(it);
      const t = all.find((x) => x.id === id);
      if (!t) throw new HttpError(404, 'That thread is gone');
      const first = (t.comments || []).find((c) => c && !c.isDeleted);
      await this.ado.reply(it, id, first ? first.id : 0, text);
      return this.threads(key);
    }
    const thread = { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: STATUS.active };
    if (path) {
      const pr = await this.files(it);
      const f = pr.files.find((x) => x.path === path);
      if (!f) throw new HttpError(404, 'That file is not part of this PR');
      thread.threadContext = { filePath: f.path };
      const n = Number(line);
      if (line !== undefined && line !== null) {
        if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Unknown line');
        const end = { line: n, offset: Math.max(1, String(lineText || '').length + 1) };
        if (side === 'left') {
          thread.threadContext.leftFileStart = { line: n, offset: 1 };
          thread.threadContext.leftFileEnd = end;
        } else {
          thread.threadContext.rightFileStart = { line: n, offset: 1 };
          thread.threadContext.rightFileEnd = end;
        }
      }
      if (pr.iteration) {
        thread.pullRequestThreadContext = {
          changeTrackingId: f.changeTrackingId || undefined,
          iterationContext: { firstComparingIteration: 1, secondComparingIteration: pr.iteration.id },
        };
      }
    }
    await this.ado.createThread(it, thread);
    return this.threads(key);
  }

  /** Resolve / reopen / won't fix a thread. */
  async setStatus(key, threadId, status) {
    const it = this.item(key);
    const id = Number(threadId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Unknown thread');
    if (!STATUS[status]) throw new HttpError(400, 'Unknown status');
    await this.ado.setThreadStatus(it, id, STATUS[status]);
    return this.threads(key);
  }
}

module.exports = { Review, STATUS };
