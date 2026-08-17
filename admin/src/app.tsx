import { useEffect, useState } from "react";

import { api, ApiError } from "./api";
import { AccountsPage } from "./pages/accounts";
import { KeysPage } from "./pages/keys";
import { LoginPage } from "./pages/login";
import { LogsPage } from "./pages/logs";
import { OverviewPage } from "./pages/overview";
import { SettingsPage } from "./pages/settings";

const ROUTES = [
  { id: "overview", path: "/admin/", label: "概览" },
  { id: "accounts", path: "/admin/accounts", label: "账号池" },
  { id: "keys", path: "/admin/keys", label: "网关 Key" },
  { id: "logs", path: "/admin/logs", label: "请求日志" },
  { id: "settings", path: "/admin/settings", label: "配置" }
] as const;

type RouteId = (typeof ROUTES)[number]["id"] | "login";

function routeFromPath(pathname: string): RouteId {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/admin/login") return "login";
  if (clean === "/admin/accounts") return "accounts";
  if (clean === "/admin/keys") return "keys";
  if (clean === "/admin/logs") return "logs";
  if (clean === "/admin/settings") return "settings";
  return "overview";
}

export function App() {
  const [route, setRoute] = useState<RouteId>(() => routeFromPath(window.location.pathname));
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [bootError, setBootError] = useState("");

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.me()
      .then(() => {
        if (!cancelled) setAuthed(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAuthed(false);
        if (error instanceof ApiError && error.status === 503) {
          setBootError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function go(path: string) {
    window.history.pushState({}, "", path);
    setRoute(routeFromPath(path));
  }

  if (!ready) {
    return <div className="login"><div className="card login-card">正在检查登录状态…</div></div>;
  }

  if (bootError) {
    return (
      <div className="login">
        <div className="card login-card">
          <h1>管理后台未启用</h1>
          <p className="banner error">{bootError}</p>
          <p>在环境变量中设置 <code>ADMIN_PASSWORD</code> 后重启 sidecar。</p>
        </div>
      </div>
    );
  }

  if (!authed || route === "login") {
    return (
      <LoginPage
        onLoggedIn={() => {
          setAuthed(true);
          go("/admin/");
        }}
      />
    );
  }

  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">
          <strong>cursor2api</strong>
          <span>自建网关控制台</span>
        </div>
        <nav>
          {ROUTES.map((item) => (
            <a
              key={item.id}
              href={item.path}
              className={route === item.id ? "active" : ""}
              onClick={(event) => {
                event.preventDefault();
                go(item.path);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="nav-foot">
          <button
            className="btn-ghost"
            onClick={async () => {
              await api.logout();
              setAuthed(false);
              go("/admin/login");
            }}
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="main">
        {route === "overview" && <OverviewPage />}
        {route === "accounts" && <AccountsPage />}
        {route === "keys" && <KeysPage />}
        {route === "logs" && <LogsPage />}
        {route === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
