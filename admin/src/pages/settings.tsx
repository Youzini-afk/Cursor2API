import { FormEvent, useEffect, useState } from "react";

import { api, ApiError, type RuntimeConfig } from "../api";

export function SettingsPage() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    const payload = await api.settings();
    setConfig(payload.config);
    setRevision(payload.revision);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!config) return;
    setError("");
    setMessage("");
    try {
      const saved = await api.saveSettings({ config, revision });
      setConfig(saved.config);
      setRevision(saved.revision);
      setMessage(`已保存，revision = ${saved.revision}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    }
  }

  if (!config) return <section><h1>配置</h1>{error && <div className="banner error">{error}</div>}</section>;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>运行时配置</h1>
          <p>单行 JSON + revision 乐观锁。启动期变量（PORT / ADMIN_PASSWORD / ENCRYPTION_KEY）不在这里。</p>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {message && <div className="banner ok">{message}</div>}
      <form className="card" onSubmit={onSubmit}>
        <p>当前 revision：{revision}</p>
        <label>
          <span>冷却基数 (ms)</span>
          <input type="number" value={config.pool.cooldownBaseMs} onChange={(event) => setConfig({ ...config, pool: { ...config.pool, cooldownBaseMs: Number(event.target.value) } })} />
        </label>
        <label>
          <span>冷却上限 (ms)</span>
          <input type="number" value={config.pool.cooldownMaxMs} onChange={(event) => setConfig({ ...config, pool: { ...config.pool, cooldownMaxMs: Number(event.target.value) } })} />
        </label>
        <label>
          <span>连续失败后禁用</span>
          <input type="number" value={config.pool.maxFailuresBeforeDisable} onChange={(event) => setConfig({ ...config, pool: { ...config.pool, maxFailuresBeforeDisable: Number(event.target.value) } })} />
        </label>
        <label>
          <span>Bridge 超时 (ms)</span>
          <input type="number" value={config.bridge.runTimeoutMs} onChange={(event) => setConfig({ ...config, pool: config.pool, bridge: { runTimeoutMs: Number(event.target.value) } })} />
        </label>
        <label>
          <span>日志保留天数</span>
          <input type="number" value={config.logs.retentionDays} onChange={(event) => setConfig({ ...config, logs: { ...config.logs, retentionDays: Number(event.target.value) } })} />
        </label>
        <label>
          <span>会话有效期 (小时)</span>
          <input type="number" value={config.security.sessionTtlHours} onChange={(event) => setConfig({ ...config, security: { sessionTtlHours: Number(event.target.value) } })} />
        </label>
        <button className="btn" type="submit">保存</button>
      </form>
    </section>
  );
}
