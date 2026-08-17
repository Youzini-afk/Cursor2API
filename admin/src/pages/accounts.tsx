import { FormEvent, useEffect, useState } from "react";

import { api, ApiError, type Account } from "../api";

export function AccountsPage() {
  const [items, setItems] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [cursorApiKey, setCursorApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setItems(await api.accounts());
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const created = await api.createAccount({ cursorApiKey, label: label || undefined });
      setCursorApiKey("");
      setLabel("");
      setMessage(`已添加 ${created.cursorEmail || created.cursorName || created.hint}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>账号池</h1>
          <p>落库前会调用 Cursor <code>/v1/me</code> 校验。列表只显示 Key 后四位。</p>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {message && <div className="banner ok">{message}</div>}
      <form className="card" onSubmit={onCreate} style={{ marginBottom: 16 }}>
        <h2>添加账号</h2>
        <label>
          <span>Cursor API Key</span>
          <input value={cursorApiKey} onChange={(event) => setCursorApiKey(event.target.value)} placeholder="crsr_…" autoComplete="off" />
        </label>
        <label>
          <span>备注名（可选）</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <button className="btn" type="submit" disabled={busy || !cursorApiKey}>校验并添加</button>
      </form>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>账号</th><th>Hint</th><th>状态</th><th>优先级</th><th>并发</th><th>冷却</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.label || item.cursorName || item.cursorEmail || item.id}</strong>
                  <div className="mono">{item.cursorEmail || item.cursorUserId || "—"}</div>
                </td>
                <td className="mono">…{item.hint}</td>
                <td>
                  <span className={`pill ${item.enabled && item.authStatus === "active" ? "ok" : "bad"}`}>
                    {item.authStatus}{item.enabled ? "" : " / disabled"}
                  </span>
                  {item.lastError && <div>{item.lastError}</div>}
                </td>
                <td>
                  <input
                    type="number"
                    value={item.priority}
                    onChange={(event) => {
                      const priority = Number(event.target.value);
                      void api.patchAccount(item.id, { priority }).then(load);
                    }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={item.maxConcurrent}
                    onChange={(event) => {
                      const maxConcurrent = Number(event.target.value);
                      void api.patchAccount(item.id, { maxConcurrent }).then(load);
                    }}
                  />
                  <div>{item.inFlight} 在途</div>
                </td>
                <td>{item.cooldownUntil || "—"}</td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => void api.patchAccount(item.id, { enabled: !item.enabled }).then(load)}>
                    {item.enabled ? "停用" : "启用"}
                  </button>
                  <button className="btn-ghost" onClick={() => void api.verifyAccount(item.id).then(load)}>复核</button>
                  <button className="btn-ghost" onClick={() => void api.resetCooldown(item.id).then(load)}>清冷却</button>
                  <button className="btn-danger" onClick={() => {
                    if (confirm("删除这个账号？")) void api.deleteAccount(item.id).then(load);
                  }}>删除</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7}>还没有账号。添加后才能用 cmp_ 网关 Key。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
