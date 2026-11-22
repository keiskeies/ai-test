// useAuth：token/user/当前项目；token 与当前项目在 localStorage，内存态经 Zustand。
import { create } from "zustand";
import { callLogout, get, getToken, onUnauthorized, post, setToken } from "../api/client";

export interface UserOut {
  id: string;
  account: string;
  name: string;
  email: string | null;
  is_system_admin: boolean;
  status: string;
}

export interface ProjectOut {
  id: string;
  name: string;
  description: string | null;
  status: string;
  my_role: string;
  /** 服务端下发的生效权限模式串（§10.1 按钮级渲染的事实源） */
  my_perms?: string[];
}

interface AuthState {
  user: UserOut | null;
  project: ProjectOut | null;
  ready: boolean;
  login: (account: string, password: string) => Promise<void>;
  logout: () => void;
  bootstrap: () => Promise<void>;
  setProject: (p: ProjectOut | null) => void;
  refreshProject: () => Promise<void>;
}

const PROJ_KEY = "tp_project";

export const useAuth = create<AuthState>((set, getState) => ({
  user: null,
  project: null,
  ready: false,
  login: async (account, password) => {
    const out = await post<{ token: string; user: UserOut }>("/auth/login", { account, password });
    setToken(out.token);
    set({ user: out.user });
  },
  logout: () => {
    // 后端 refresh 是无状态 Cookie：这一步让服务端清掉 HttpOnly refresh Cookie，
    // 本地清态照旧，请求失败不阻塞登出（client.callLogout 自己吞错）。
    callLogout();
    setToken(null);
    localStorage.removeItem(PROJ_KEY);
    set({ user: null, project: null });
    onUnauthorized();
  },
  bootstrap: async () => {
    if (!getToken()) {
      set({ ready: true });
      return;
    }
    try {
      const u = await get<UserOut>("/auth/me");
      const raw = localStorage.getItem(PROJ_KEY);
      let proj: ProjectOut | null = null;
      if (raw) {
        try {
          proj = JSON.parse(raw) as ProjectOut;
        } catch {
          proj = null;
        }
      }
      set({ user: u, project: proj, ready: true });
      // 旧版本存下的项目快照没有 my_perms：静默补拉一次，避免按钮按兜底表误显示
      if (proj && !proj.my_perms) void get<ProjectOut>("/projects/" + proj.id, { silent: true })
        .then((fresh) => {
          localStorage.setItem(PROJ_KEY, JSON.stringify(fresh));
          set({ project: fresh });
        })
        .catch(() => undefined);
    } catch {
      set({ user: null, project: null, ready: true });
    }
  },
  setProject: (p) => {
    if (p) localStorage.setItem(PROJ_KEY, JSON.stringify(p));
    else localStorage.removeItem(PROJ_KEY);
    set({ project: p });
  },
  refreshProject: async () => {
    const cur = getState().project;
    if (!cur) return;
    try {
      // 角色是可以在设置页被改掉的：重新拉一次项目，按钮显隐才跟服务端一致，
      // 而不是等用户刷新页面（拉不到就沿用旧快照，不打断当前操作）。
      const fresh = await get<ProjectOut>("/projects/" + cur.id, { silent: true });
      localStorage.setItem(PROJ_KEY, JSON.stringify(fresh));
      set({ project: fresh });
    } catch { /* 403/网络抖动：保留当前项目态 */ }
  },
}));
