import { FormEvent, useState } from "react";

import { api, ApiError } from "../api";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={onSubmit}>
        <h1>管理员登录</h1>
        <p>使用环境变量 <code>ADMIN_PASSWORD</code> 对应的密码。会话 cookie 仅发给管理 API。</p>
        {error && <div className="banner error">{error}</div>}
        <label>
          <span>密码</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        </label>
        <button className="btn" type="submit" disabled={busy || !password}>{busy ? "登录中…" : "登录"}</button>
      </form>
    </div>
  );
}
