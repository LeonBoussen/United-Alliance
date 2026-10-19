import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, CornerDownRight, X } from "lucide-react";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { useNeedsYou, type NeedsYouItem } from "../lib/needs-you";
import { Countdown } from "./Countdown";

function AnswerBox({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="needs-answer"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
        setText("");
      }}
    >
      <input className="input" placeholder="Your answer…" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn btn-primary" disabled={!text.trim()} aria-label="Send answer">
        <CornerDownRight size={14} />
      </button>
    </form>
  );
}

function Item({ item }: { item: NeedsYouItem }) {
  const agents = useStore((s) => s.agents);

  if (item.kind === "approval") {
    const a = item.approval;
    return (
      <div className="needs-item">
        <div className="needs-head">
          <b>Approval · {agents[a.agentId]?.name ?? a.agentId}</b>
          <span className={`risk risk-${a.risk}`}>{a.risk} risk</span>
        </div>
        <code className="approval-cmd">{JSON.stringify(a.input)}</code>
        <div className="needs-body">{a.reason}</div>
        {a.reviewNotes?.map((n) => <div key={n} className="muted small">{n}</div>)}
        <div className="approval-actions">
          <button className="btn btn-primary" onClick={() => realtime.send("approval.decide", { approvalId: a.id, approved: true })}>
            <Check size={14} /> Approve
          </button>
          <button className="btn" onClick={() => realtime.send("approval.decide", { approvalId: a.id, approved: false })}>
            <X size={14} /> Deny
          </button>
        </div>
      </div>
    );
  }

  const m = item.message;
  if (item.kind === "escalation") {
    return (
      <div className="needs-item">
        <div className="needs-head">
          <b>{m.role === "helper" ? "Helper (for the Overseer)" : "Overseer"}</b>
          <span className="muted small">{item.thread.title}</span>
        </div>
        <div className="needs-body pre">{m.content}</div>
        <AnswerBox onSend={(content) => realtime.send("message.send", { threadId: item.thread.id, content, answersMessageId: m.id })} />
      </div>
    );
  }

  const agentId = item.thread.agentId ?? m.authorId;
  return (
    <div className="needs-item">
      <div className="needs-head">
        <Link to={`/agents/${agentId}`} className="link-plain"><b>{agents[agentId]?.name ?? agentId}</b> asks</Link>
        {m.answerDeadline && (
          <span className="muted small">Overseer answers in <Countdown until={m.answerDeadline} /></span>
        )}
      </div>
      <div className="needs-body">{m.content}</div>
      <AnswerBox onSend={(content) => realtime.send("thought.insert", { agentId, content, answersMessageId: m.id })} />
    </div>
  );
}

export function NeedsYou() {
  const items = useNeedsYou();
  return (
    <section className="card pad">
      <h3 className="section-title">Needs you {items.length > 0 && <span className="chip-count">{items.length}</span>}</h3>
      {items.length === 0 ? (
        <div className="empty small">Nothing waiting on you. The Overseer and its helper are handling it.</div>
      ) : (
        <div className="needs-list">
          {items.map((it) => (
            <Item key={it.kind === "approval" ? it.approval.id : it.message.id} item={it} />
          ))}
        </div>
      )}
    </section>
  );
}
