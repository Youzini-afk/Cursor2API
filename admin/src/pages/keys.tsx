import { FormEvent, useEffect, useState } from "react";

import { api, ApiError, type Account, type GatewayKey } from "../api";

export function KeysPage() {
  const [items, setItems] = useState<GatewayKey[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [name, setName] = useState("default");
  const [accountId, setAccountId] = useState("");
  const [rpmLimit, setRpmLimit] = useState("");
  const [plaintext, setPlaintext] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const [keys, pool] = await Promise.all([api.keys(), api.accounts()]);
    setItems(keys);
    setAccounts(pool);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const created = await api.createKey({
        name,
        accountId: accountId || undefined,
        rpmLimit: rpmLimit ? Number(rpmLimit) : undefined
      });
      setPlaintext(created.key);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "签发失败");
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>网关 Key</h1>
          <p>前缀 <code>cmp_</code>。明文只在创建时出现一次，库里只存 sha256。</p>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {plaintext && (
        <div className="banner ok">
          请立即复制：<code className="mono">{plaintext}</code>
        </div>
      )}
      <form className="card" onSubmit={onCreate} style={{ marginBottom: 16 }}>
        <h2>签发</h2>
        <label>
          <span>名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>绑定账号（可选，空则走整池）</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">整池调度</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label || account.cursorEmail || account.id}</option>
            ))}
          </select>
        </label>
        <label>
          <span>RPM 上限（可选）</span>
          <input value={rpmLimit} onChange={(event) => setRpmLimit(event.target.value)} placeholder="例如 60" />
        </label>
        <button className="btn" type="submit">签发网关 Key</button>
      </form>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>名称</th><th>前缀</th><th>绑定</th><th>RPM</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td className="mono">{item.prefix}</td>
                <td className="mono">{item.accountId || "整池"}</td>
                <td>{item.rpmLimit ?? "—"}</td>
                <td><span className={`pill ${item.enabled ? "ok" : "bad"}`}>{item.enabled ? "启用" : "停用"}</span></td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => void api.patchKey(item.id, { enabled: !item.enabled }).then(load)}>
                    {item.enabled ? "停用" : "启用"}
                  </button>
                  <button className="btn-danger" onClick={() => {
                    if (confirm("删除这个网关 Key？")) void api.deleteKey(item.id).then(load);
                  }}>删除</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6}>还没有网关 Key。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
