import { useEffect, useState } from "react";

import { api, type RequestLog } from "../api";

export function LogsPage() {
  const [items, setItems] = useState<RequestLog[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [model, setModel] = useState("");
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const [error, setError] = useState("");

  async function load(nextPage = page) {
    const query = new URLSearchParams();
    query.set("page", String(nextPage));
    if (status) query.set("status", status);
    if (model) query.set("model", model);
    const payload = await api.logs(`?${query.toString()}`);
    setItems(payload.items);
    setPage(payload.page);
    setTotal(payload.total);
  }

  useEffect(() => {
    void load(1).catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, [status, model]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>请求日志</h1>
          <p>透传模式的 account_id 为空；网关 Key 路径会同时记下账号和 Key。</p>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="filters">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="pending">pending</option>
        </select>
        <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="按模型筛选" />
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>时间</th><th>端点</th><th>模型</th><th>状态</th><th>延迟</th><th>首 token</th></tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} onClick={() => setSelected(item)} style={{ cursor: "pointer" }}>
                <td>{item.created_at}</td>
                <td className="mono">{item.endpoint}</td>
                <td>{item.model || "—"}</td>
                <td><span className={`pill ${item.status === "ok" ? "ok" : item.status === "error" ? "bad" : "warn"}`}>{item.status}</span></td>
                <td>{item.latency_ms ?? "—"}</td>
                <td>{item.first_token_ms ?? "—"}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6}>没有日志</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="row-actions" style={{ marginTop: 12 }}>
        <button className="btn-ghost" disabled={page <= 1} onClick={() => void load(page - 1)}>上一页</button>
        <span>第 {page} 页 · 共 {total} 条</span>
        <button className="btn-ghost" disabled={page * 50 >= total} onClick={() => void load(page + 1)}>下一页</button>
      </div>
      {selected && (
        <div className="drawer" onClick={() => setSelected(null)}>
          <article onClick={(event) => event.stopPropagation()}>
            <h2>日志详情</h2>
            <p className="mono">{selected.id}</p>
            <p>账号：{selected.account_id || "透传 / 无"}</p>
            <p>网关 Key：{selected.gateway_key_id || "—"}</p>
            <p>prompt / completion：{selected.prompt_chars} / {selected.completion_chars}</p>
            <p>错误：{selected.error || "—"}</p>
            <button className="btn-ghost" onClick={() => setSelected(null)}>关闭</button>
          </article>
        </div>
      )}
    </section>
  );
}
