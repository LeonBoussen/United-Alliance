import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Overview } from "./pages/Overview";
import { Overseer } from "./pages/Overseer";
import { Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { Tasks } from "./pages/Tasks";
import { Monitoring } from "./pages/Monitoring";
import { Settings } from "./pages/Settings";
import { Teams } from "./pages/Teams";
import { Hosts } from "./pages/Hosts";
import { Board } from "./pages/Board";
import { Helper } from "./pages/Helper";
import { useStore } from "./lib/store";

function useTitle(): string {
  const { pathname } = useLocation();
  const agents = useStore((s) => s.agents);
  if (pathname === "/") return "Overview";
  if (pathname.startsWith("/agents/")) return agents[pathname.split("/")[2] ?? ""]?.name ?? "Agent";
  const seg = pathname.split("/")[1] ?? "";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export function App() {
  const title = useTitle();
  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar title={title} />
        <main className="content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/overseer" element={<Overseer />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/new" element={<Navigate to="/hosts" replace />} />
            <Route path="/hosts" element={<Hosts />} />
            <Route path="/board" element={<Board />} />
            <Route path="/helper" element={<Helper />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/monitoring" element={<Monitoring />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <div className="page">
                  <div className="empty">
                    Page not found. <Link to="/" className="link">Go to overview</Link>
                  </div>
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
