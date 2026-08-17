import { useEffect, useState } from "react";

import { api, type Overview } from "../api";

export function OverviewPage() {
  const [period, setPeriod] = useState<"24h" | "7d" | "30d">("24h");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  async function load(next = period, refresh = false) {
    setError("");
    try {
      setData(await api.overview(next, refresh));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }

  useEffect(() => {
    void load(period);
  }, [period]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>概览</h1>
          <p>从 request_logs 聚合，15 秒缓存。Cursor 没有额度 API，这里不展示余额。</p>
        </div>
        <div className="row-actions">
          {(["24h", "7d", "30d"] as const).map((item) => (
            <button key={item} className={item === period ? "btn" : "btn-ghost"} onClick={() => setPeriod(item)}>{item}</button>
          ))}
          <button className="btn-ghost" onClick={() => void load(period, true)}>刷新</button>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {data && (
        <>
          <div className="grid cards">
            <article className="card"><h3>请求</h3><div className="metric">{data.totals.requests}<small>成功 {data.totals.ok} · 失败 {data.totals.errors}</small></div></article>
            <article className="card"><h3>成功率</h3><div className="metric">{data.totals.successRate.toFixed(1)}%<small>按原始流水计算</small></div></article>
            <article className="card"><h3>平均首 token</h3><div className="metric">{fmtMs(data.totals.avgFirstTokenMs)}<small>流式第一块的时间</small></div></article>
            <article className="card"><h3>平均耗时</h3><div className="metric">{fmtMs(data.totals.avgLatencyMs)}<small>含非流式请求</small></div></article>
          </div>
          <div className="grid two" style={{ marginTop: 14 }}>
            <article className="card">
              <h2>请求趋势</h2>
              <TrendChart points={data.trend} />
            </article>
            <article className="card">
              <h2>账号池</h2>
              <p>可用 {data.pool.available} · 冷却 {data.pool.cooling} · 禁用 {data.pool.disabled} · 需重认证 {data.pool.reauthRequired}</p>
              <h3 style={{ marginTop: 18 }}>模型 Top</h3>
              <ul>
                {data.topModels.map((item) => <li key={item.model}>{item.model} · {item.count}</li>)}
                {data.topModels.length === 0 && <li>暂无数据</li>}
              </ul>
            </article>
          </div>
          <article className="card" style={{ marginTop: 14 }}>
            <h2>最近错误</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>时间</th><th>端点</th><th>模型</th><th>错误</th></tr></thead>
                <tbody>
                  {data.recentErrors.map((item) => (
                    <tr key={item.id}>
                      <td>{item.createdAt}</td>
                      <td className="mono">{item.endpoint}</td>
                      <td>{item.model || "—"}</td>
                      <td>{item.error || "—"}</td>
                    </tr>
                  ))}
                  {data.recentErrors.length === 0 && <tr><td colSpan={4}>没有错误记录</td></tr>}
                </tbody>
              </table>
            </div>
          </article>
        </>
      )}
    </section>
  );
}

function fmtMs(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value)} ms`;
}

function TrendChart({ points }: { points: Array<{ bucket: string; ok: number; errors: number }> }) {
  const width = 640;
  const height = 180;
  const pad = 16;
  if (points.length === 0) return <p>这个时间段还没有请求。</p>;
  const max = Math.max(1, ...points.map((point) => point.ok + point.errors));
  const step = points.length === 1 ? width - pad * 2 : (width - pad * 2) / (points.length - 1);
  const line = (key: "ok" | "errors") => points.map((point, index) => {
    const x = pad + index * step;
    const y = height - pad - (point[key] / max) * (height - pad * 2);
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="请求趋势">
      <polyline fill="none" stroke="#7dce8a" strokeWidth="2.5" points={line("ok")} />
      <polyline fill="none" stroke="#e07a6a" strokeWidth="2.5" points={line("errors")} />
    </svg>
  );
}
