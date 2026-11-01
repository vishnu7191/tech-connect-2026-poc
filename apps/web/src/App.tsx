import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import Dashboard from './pages/Dashboard';
import NewProject from './pages/NewProject';
import ProjectPage from './pages/Project';
import Personas from './pages/Personas';
import TestPlans from './pages/TestPlans';
import ExecutionPage from './pages/Execution';
import Findings from './pages/Findings';
import ModelLab from './pages/ModelLab';

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-4 h-14 border-b border-surface-800">
      <div className="grid place-items-center h-7 w-7 rounded-lg bg-accent-600">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-ink-100">Lenz</div>
        <div className="text-2xs text-ink-500">UX Validation Engine</div>
      </div>
    </div>
  );
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
    isActive ? 'bg-surface-800 text-ink-100 font-medium' : 'text-ink-400 hover:text-ink-200 hover:bg-surface-850'
  }`;

/** Project-scoped navigation only appears once a project is selected. */
function ProjectNav() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return (
    <div className="mt-5">
      <p className="label px-3 mb-1.5">Project</p>
      <nav className="space-y-0.5">
        <NavLink to={`/projects/${id}`} end className={linkClass}>
          Discovery
        </NavLink>
        <NavLink to={`/projects/${id}/personas`} className={linkClass}>
          Personas
        </NavLink>
        <NavLink to={`/projects/${id}/test-plans`} className={linkClass}>
          Test Plans
        </NavLink>
        <NavLink to={`/projects/${id}/findings`} className={linkClass}>
          UX Analysis
        </NavLink>
      </nav>
    </div>
  );
}

function HealthBadge() {
  const { data } = useQuery({
    queryKey: ['health-deps'],
    queryFn: () => api.get<any>('/health/dependencies'),
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const figmaOk = data.figma?.configured;
  const aiOk = (data.ai?.providers ?? []).some((p: any) => p.enabled && p.hasApiKey);
  const allOk = figmaOk && aiOk;
  return (
    <div className="px-4 py-3 border-t border-surface-800 text-2xs space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-ink-500">Figma API</span>
        <span className={figmaOk ? 'text-ok-400' : 'text-warn-400'}>
          {figmaOk ? 'connected' : 'no token'}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-ink-500">AI provider</span>
        <span className={aiOk ? 'text-ok-400' : 'text-bad-400'}>{aiOk ? 'ready' : 'unconfigured'}</span>
      </div>
      {!allOk && (
        <p className="text-ink-500 pt-1 leading-relaxed">
          Some capabilities are limited. See doc/development/setup.md.
        </p>
      )}
    </div>
  );
}

export default function App() {
  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 bg-surface-900 border-r border-surface-800 flex flex-col">
        <Logo />
        <div className="flex-1 overflow-y-auto p-2.5">
          <nav className="space-y-0.5">
            <NavLink to="/" end className={linkClass}>
              Dashboard
            </NavLink>
            <NavLink to="/projects/new" className={linkClass}>
              New Project
            </NavLink>
            <NavLink to="/model-lab" className={linkClass}>
              Model Lab
            </NavLink>
          </nav>
          <Routes>
            <Route path="/projects/:id/*" element={<ProjectNav />} />
          </Routes>
        </div>
        <HealthBadge />
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-7 py-7">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/projects/new" element={<NewProject />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/projects/:id/personas" element={<Personas />} />
            <Route path="/projects/:id/test-plans" element={<TestPlans />} />
            <Route path="/projects/:id/findings" element={<Findings />} />
            <Route path="/executions/:id" element={<ExecutionPage />} />
            <Route path="/model-lab" element={<ModelLab />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
