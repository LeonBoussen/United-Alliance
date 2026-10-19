// The message board (DESIGN §5e): an imageboard-style place where agents, the Overseer,
// the helper and the operator coordinate in the open. Boards hold threads, threads hold
// posts; post numbers are global. "@Name" in a post notifies that agent at its next
// turn boundary (or wakes the Overseer for "@Overseer").
import { BOARDS, type BoardAuthorKind, type BoardId, type BoardAction, type BoardPost, type BoardThread, type ID } from "@alliance/protocol";
import type { App } from "./app.js";
import { envelope } from "./envelope.js";
import { newId, nowIso } from "./ids.js";

export interface Author {
  kind: BoardAuthorKind;
  id: ID;
  name: string;
}

export interface PostInput {
  board?: string;
  content: string;
  threadId?: ID;
  /** The opening post's number, or any post number in the thread. */
  threadNo?: number;
  subject?: string;
  teamId?: ID;
  taskId?: ID;
}

export type PostResult = { ok: true; post: BoardPost; thread: BoardThread } | { ok: false; error: string };

const MAX_POST = 8000;
const MAX_SUBJECT = 120;
/** Posts shown to an agent per thread read; older ones are summarised as a count. */
const READ_POSTS = 40;
const READ_THREADS = 25;

const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ");
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function boardId(v: unknown): BoardId | undefined {
  return BOARDS.find((b) => b.id === v)?.id;
}

/** Names mentioned with @Name, without duplicates. */
export function mentions(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/(?:^|[^\w@])@([A-Za-z][\w-]{1,39})/g)) out.add(m[1]!);
  return [...out];
}

export class Board {
  constructor(private app: App) {}

  private get core() {
    return this.app.core;
  }

  /** The thread a number points to: its opening post, or any reply in it. */
  threadByNo(no: number): BoardThread | undefined {
    const byOp = [...this.core.boardThreads.values()].find((t) => t.no === no);
    if (byOp) return byOp;
    const post = this.core.boardPosts.find((p) => p.no === no);
    return post ? this.core.boardThreads.get(post.threadId) : undefined;
  }

  post(author: Author, input: PostInput): PostResult {
    const core = this.core;
    const content = input.content?.trim().slice(0, MAX_POST);
    if (!content) return { ok: false, error: "A post needs some text." };

    let thread: BoardThread | undefined;
    if (input.threadId || input.threadNo !== undefined) {
      thread = input.threadId ? core.boardThreads.get(input.threadId) : this.threadByNo(Number(input.threadNo));
      if (!thread) return { ok: false, error: `No thread ${input.threadId ?? `#${input.threadNo}`}. Read the board to see thread numbers.` };
    } else {
      const subject = input.subject?.trim().slice(0, MAX_SUBJECT);
      if (!subject) return { ok: false, error: "Give a subject to start a thread, or a thread number to reply." };
      const board = boardId(input.board ?? "general");
      if (!board) return { ok: false, error: `Unknown board ${input.board}. Boards: ${BOARDS.map((b) => b.id).join(", ")}.` };
      thread = {
        id: newId("bth"), board, no: core.boardSeq + 1, subject, authorKind: author.kind, authorId: author.id, authorName: author.name,
        createdAt: nowIso(), bumpedAt: nowIso(), replyCount: -1, // the opening post below makes it 0
        ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}),
      };
    }

    const post: BoardPost = {
      id: newId("bpo"), no: ++core.boardSeq, threadId: thread.id, board: thread.board,
      authorKind: author.kind, authorId: author.id, authorName: author.name, content, createdAt: nowIso(),
    };
    core.boardPosts.push(post);
    core.db.put("board_posts", post.id, post);
    thread = { ...thread, bumpedAt: post.createdAt, replyCount: thread.replyCount + 1 };
    core.upsert("boardThread", thread);
    core.broadcast(envelope("board.post", post));
    core.event("info", { kind: author.kind === "helper" ? "overseer" : author.kind, id: author.id }, "board.post",
      `${author.name} on /${thread.board}/ “${oneLine(thread.subject, 40)}”: ${oneLine(content, 100)}`,
      author.kind === "agent" ? { agentId: author.id } : {});
    this.deliverMentions(author, thread, post);
    return { ok: true, post, thread };
  }

  private deliverMentions(author: Author, thread: BoardThread, post: BoardPost): void {
    const core = this.core;
    const text = `${author.name} mentioned you on /${thread.board}/ in thread #${thread.no} “${thread.subject}” (post #${post.no}):\n${post.content}\nReply with board_post(thread=${thread.no}) if needed.`;
    for (const name of mentions(post.content)) {
      if (name.toLowerCase() === "overseer") {
        if (author.kind !== "overseer") this.app.overseer.notify(core.teamThread(thread.teamId).id, `${author.name} mentioned you on the board, /${thread.board}/ #${thread.no} “${thread.subject}” (post #${post.no}): ${oneLine(post.content, 600)}`);
        continue;
      }
      const agent = core.findAgent(name);
      if (!agent || agent.status === "retired" || agent.id === author.id) continue;
      this.app.harnesses.injectAgent(agent.id, { from: "board", content: text, threadId: core.agentThread(agent.id).id });
    }
  }

  // -- views for models ------------------------------------------------------------------

  renderBoard(board: BoardId): string {
    const meta = BOARDS.find((b) => b.id === board)!;
    const threads = [...this.core.boardThreads.values()].filter((t) => t.board === board).sort((a, b) => b.bumpedAt.localeCompare(a.bumpedAt));
    const lines = [`/${board}/ — ${meta.title}: ${meta.description}`, `Other boards: ${BOARDS.filter((b) => b.id !== board).map((b) => `/${b.id}/`).join(" ")}`];
    if (!threads.length) return [...lines, "No threads yet. Start one with board_post(subject=…)."].join("\n");
    lines.push(`Threads, most recently active first (${threads.length} total):`);
    for (const t of threads.slice(0, READ_THREADS)) {
      const op = this.core.boardPosts.find((p) => p.no === t.no);
      lines.push(`#${t.no} “${t.subject}” by ${t.authorName} · ${t.replyCount} repl${t.replyCount === 1 ? "y" : "ies"} · last ${stamp(t.bumpedAt)}`);
      if (op) lines.push(`    ${oneLine(op.content, 160)}`);
    }
    return lines.join("\n");
  }

  renderThread(thread: BoardThread): string {
    const posts = this.core.boardPosts.filter((p) => p.threadId === thread.id);
    const shown = posts.slice(-READ_POSTS);
    const lines = [`/${thread.board}/ #${thread.no} “${thread.subject}” — ${posts.length} post(s)`];
    if (posts.length > shown.length) lines.push(`(${posts.length - shown.length} older posts not shown)`);
    for (const p of shown) lines.push(`[#${p.no}] ${p.authorName} (${p.authorKind}) ${stamp(p.createdAt)}\n${p.content}`);
    return lines.join("\n\n");
  }

  /** Read or post for a model (agent tool or Overseer/helper tool). */
  handle(author: Author, req: BoardAction): { ok: boolean; text: string } {
    if (req.action === "read") {
      if (req.threadNo !== undefined) {
        const t = this.threadByNo(Number(req.threadNo));
        return t ? { ok: true, text: this.renderThread(t) } : { ok: false, text: `No thread #${req.threadNo}.` };
      }
      const board = boardId(req.board ?? "general");
      return board ? { ok: true, text: this.renderBoard(board) } : { ok: false, text: `Unknown board. Boards: ${BOARDS.map((b) => b.id).join(", ")}.` };
    }
    const res = this.post(author, {
      content: req.content, ...(req.board ? { board: req.board } : {}), ...(req.threadNo !== undefined ? { threadNo: req.threadNo } : {}),
      ...(req.subject ? { subject: req.subject } : {}),
    });
    if (!res.ok) return { ok: false, text: res.error };
    return {
      ok: true,
      text: res.post.no === res.thread.no
        ? `Started thread #${res.thread.no} on /${res.thread.board}/.`
        : `Posted #${res.post.no} in thread #${res.thread.no} on /${res.thread.board}/.`,
    };
  }
}
