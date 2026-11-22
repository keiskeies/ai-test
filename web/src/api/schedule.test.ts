// 定时任务 API 壳（schedule.ts）的单测。node 环境跑（vitest.config.ts 的默认环境）：
// 不碰 DOM、不碰 React，网络边界收在 ./client 的 get/patch 上（vi.mock 整模块换桩，
// 真 client 不加载 → antd 静态 message 不碰 document，机制同 ChangePasswordModal.test.tsx:39-40
// 的 vi.hoisted + vi.mock）。钉三件事：
//   ① 私有 qs()（经 listTasks 的查询串钉）：丢 undefined/null/空串，但 0 和 false 必须留
//      ——`if (v)` 式重写会静默把 enabled=0（禁用态）整键吞掉，后端把缺省当「不过滤」，
//      过滤条件就反了，这条区分是整个 helper 的全部难点；
//   ② listTasks：path 以 /schedule-tasks? 开头、project_id 与额外的键都进查询串、
//      需要百分号编码的值真被编码；
//   ③ rebindTask：taskId 过 encodeURIComponent（用带 / 和空格的 id 钉——少 enc() 时
//      `/schedule-tasks/t 1/2` 会拆成两段路由或 404），body 按引用递给 patch、
//      不许提前 JSON.stringify（client 的 patch 自己序列化，双重编码后端读不到）。
// 【不证明什么】真 fetch / PATCH 语义 / Page 外壳的真后端形状不在本文件；
// 只钉到 get/patch 的调用参数与返回值透传为止。
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
  patch: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
}));
vi.mock("./client", () => ({ get: api.get, patch: api.patch }));

import { listTasks, rebindTask } from "./schedule";
import type { components } from "./schema";

type TaskUpdateBody = components["schemas"]["schedule_task_update_body"];
type ListArg = Parameters<typeof listTasks>[0];

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  api.get.mockImplementation(async () => ({}));
  api.patch.mockImplementation(async () => ({}));
});

function getPath(): string {
  return api.get.mock.calls[0][0] as string;
}

describe("listTasks：查询串（私有 qs 的可观察面）", () => {
  it("只传 project_id：? 后恰好一个键", () => {
    listTasks({ project_id: "p1" });
    const path = getPath();
    expect(path.startsWith("/schedule-tasks?")).toBe(true);
    expect(path).toBe("/schedule-tasks?project_id=p1");
  });

  it("额外的键全进查询串", () => {
    listTasks({ project_id: "p1", enabled: 1, cursor: "c1", size: 20 });
    const q = new URLSearchParams(getPath().split("?")[1]);
    expect(q.get("project_id")).toBe("p1");
    expect(q.get("enabled")).toBe("1");
    expect(q.get("cursor")).toBe("c1");
    expect(q.get("size")).toBe("20");
  });

  it("undefined / null / 空串被丢掉，键根本不出现在串里", () => {
    listTasks({ project_id: "p1", enabled: undefined, cursor: null, size: "" as unknown as number });
    const q = new URLSearchParams(getPath().split("?")[1]);
    expect(q.has("enabled")).toBe(false);
    expect(q.has("cursor")).toBe(false);
    expect(q.has("size")).toBe(false);
    // 全丢光后也不该剩野 &
    expect(getPath()).toBe("/schedule-tasks?project_id=p1");
  });

  it("0 与 false 保留：qs 的黑名单是 undefined/null/'' ，不是真值", () => {
    // enabled:0 类型合法（禁用态）；flag 越界塞进来只为经 listTasks 摸到私有的 qs——
    // 运行时它对 String(false)="false" 一视同仁。`if (v)` 的写法会双双丢键。
    listTasks({ project_id: "p1", enabled: 0, flag: false } as unknown as ListArg);
    const q = new URLSearchParams(getPath().split("?")[1]);
    expect(q.get("enabled")).toBe("0");
    expect(q.get("flag")).toBe("false");
  });

  it("需要百分号编码的值真被编码", () => {
    listTasks({ project_id: "p 1/2&x" });
    // URLSearchParams 的编码约定：空格→+，/→%2F，&→%26（不是 %20，钉实际产物）
    expect(getPath()).toBe("/schedule-tasks?project_id=p+1%2F2%26x");
    const q = new URLSearchParams(getPath().split("?")[1]);
    expect(q.get("project_id")).toBe("p 1/2&x"); // 编码可逆，语义没变形
  });

  it("get 的返回值原样透传（Page 外壳不经任何加工）", async () => {
    const page = { items: [], next_cursor: "c2" };
    api.get.mockResolvedValueOnce(page);
    await expect(listTasks({ project_id: "p1" })).resolves.toBe(page);
  });
});

describe("rebindTask", () => {
  it("taskId 过 encodeURIComponent：/ 和空格都不会漏进 path 拆坏路由", () => {
    const body = { project_id: "p1", subject_id: "s2" } satisfies TaskUpdateBody;
    rebindTask("t 1/2", body);
    // encodeURIComponent: 空格→%20（区别于查询串的 +）、/→%2F；少了 enc() 这里会
    // 发出 "/schedule-tasks/t 1/2"——拆段或 404，正是本函数唯一的存在理由。
    expect(api.patch.mock.calls[0][0]).toBe("/schedule-tasks/t%201%2F2");
  });

  it("body 按引用递给 patch，不提前序列化", () => {
    const body = { project_id: "p1", cron: "0 9 * * *", enabled: 0 } satisfies TaskUpdateBody;
    rebindTask("t1", body);
    expect(api.patch.mock.calls[0][1]).toBe(body);
  });

  it("patch 的返回值原样透传", async () => {
    const task = { id: "t1" };
    api.patch.mockResolvedValueOnce(task);
    const body = { project_id: "p1" } satisfies TaskUpdateBody;
    await expect(rebindTask("t1", body)).resolves.toBe(task);
  });
});
