// T16：最近使用列表的纯内核单测。钉的是「坏值不许崩」——tp_ui_recent_elements 是
// 客户端可写存储，恶意/损坏 JSON 必须被降级，不许把元素选择器拖下水（计划硬规则）。
import { describe, expect, it } from "vitest";
import {
  MAX_RECENT,
  RECENT_KEY,
  parseRecent,
  pushRecent,
  readRecent,
  writeRecent,
  type KV,
} from "./recentElements";

function memKv(initial: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

describe("parseRecent：任何存储值都不许抛", () => {
  it("null / 空串 / undefined → 空表", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("")).toEqual([]);
    expect(parseRecent(undefined)).toEqual([]);
  });

  it("坏 JSON（截断、单引号、裸文本）→ 空表", () => {
    expect(parseRecent('[{"id":"a"')).toEqual([]);
    expect(parseRecent("[{'id':'a'}]")).toEqual([]);
    expect(parseRecent("not json")).toEqual([]);
  });

  it("非数组（对象/数字/字符串/布尔）→ 空表", () => {
    expect(parseRecent('{"id":"a"}')).toEqual([]);
    expect(parseRecent("42")).toEqual([]);
    expect(parseRecent('"a"')).toEqual([]);
    expect(parseRecent("true")).toEqual([]);
  });

  it("条目形状不对（null/数组/数字/缺 id/缺 name/空串/类型错）→ 跳过坏条留下好条", () => {
    const raw = JSON.stringify([
      null, 7, ["a", "b"], { name: "没id" }, { id: "" , name: "空id" },
      { id: "x", name: "" }, { id: 1, name: "数字id" }, { id: "ok", name: "好元素" },
    ]);
    expect(parseRecent(raw)).toEqual([{ id: "ok", name: "好元素" }]);
  });

  it("重复 id 保留第一条，不重复渲染", () => {
    const raw = JSON.stringify([{ id: "a", name: "甲" }, { id: "a", name: "甲改名" }, { id: "b", name: "乙" }]);
    expect(parseRecent(raw)).toEqual([{ id: "a", name: "甲" }, { id: "b", name: "乙" }]);
  });

  it("超过 8 条只留前 8（键与上限按计划点名值）", () => {
    expect(RECENT_KEY).toBe("tp_ui_recent_elements");
    expect(MAX_RECENT).toBe(8);
    const raw = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: "e" + i, name: "元素" + i })));
    const got = parseRecent(raw);
    expect(got.length).toBe(8);
    expect(got[0].id).toBe("e0");
    expect(got[7].id).toBe("e7");
  });
});

describe("pushRecent：顶到最前 + 去重 + 截断", () => {
  it("空表推一条", () => {
    expect(pushRecent(null, { id: "a", name: "甲" })).toEqual([{ id: "a", name: "甲" }]);
  });

  it("用两次同一元素 → 第三次打开排第一（e2e ④ 的纯层对偶）", () => {
    let raw: string | null = null;
    const use = (e: { id: string; name: string }) => {
      const list = pushRecent(raw, e);
      raw = JSON.stringify(list);
      return list;
    };
    use({ id: "b", name: "乙" });
    use({ id: "a", name: "甲" });
    const third = use({ id: "a", name: "甲" });
    expect(third[0]).toEqual({ id: "a", name: "甲" });
    expect(third.filter((r) => r.id === "a").length).toBe(1);
  });

  it("满 8 追新挤最旧", () => {
    const base = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ id: "e" + i, name: "n" + i })));
    const got = pushRecent(base, { id: "new", name: "新" });
    expect(got.length).toBe(8);
    expect(got[0].id).toBe("new");
    expect(got.some((r) => r.id === "e7")).toBe(false);
  });

  it("entry 非法或底表坏值 → 降级不崩", () => {
    expect(pushRecent("坏值", { id: "a", name: "甲" })).toEqual([{ id: "a", name: "甲" }]);
    expect(pushRecent('[{"id":"a","name":"甲"}]', { id: "", name: "空" })).toEqual([{ id: "a", name: "甲" }]);
  });
});

describe("readRecent / writeRecent：kv 边界", () => {
  it("读写往返", () => {
    const kv = memKv();
    writeRecent(kv, [{ id: "a", name: "甲" }]);
    expect(readRecent(kv)).toEqual([{ id: "a", name: "甲" }]);
  });

  it("getItem / setItem 抛（隐私模式形状）都不外抛", () => {
    const angry: KV = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("QuotaExceededError"); },
    };
    expect(readRecent(angry)).toEqual([]);
    expect(() => writeRecent(angry, [{ id: "a", name: "甲" }])).not.toThrow();
  });

  it("存量坏 JSON 读出空表（读取路径同 parseRecent）", () => {
    const kv = memKv({ tp_ui_recent_elements: "{oops" });
    expect(readRecent(kv)).toEqual([]);
  });
});
