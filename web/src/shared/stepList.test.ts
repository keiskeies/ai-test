// 1D T9：步骤列表共用内核的单测。ui/commands.ts 与 adb/commands.ts 的列表操作都委托
// 到这里（§11.4.12「共用一个组件」），两边各自的孪生表钉住的是**委托后的行为**；
// 这份表钉内核本身——委托关系一旦接错线（比如 prefix 传串），这里先红。
import { describe, expect, it } from "vitest";
import {
  duplicateRowAt, insertAfterRow, moveRow, nextRowId, removeRowAt, updateRowAt,
} from "./stepList";

interface Row { id: string; type: string; cfg?: Record<string, unknown> }

const rows = (): Row[] => [
  { id: "u1", type: "a" }, { id: "u2", type: "b" }, { id: "u3", type: "c" },
];

describe("列表内核（两家 commands.ts 的共同地基）", () => {
  it("insertAfterRow 越界裁端点：-5 进头部、超长进尾部", () => {
    const at = (i: number) => insertAfterRow(rows(), i, { id: "x", type: "x" })
      .map((r) => r.id).join(",");
    expect(at(0)).toBe("u1,x,u2,u3");
    expect(at(-5)).toBe("x,u1,u2,u3");
    expect(at(99)).toBe("u1,u2,u3,x");
  });

  it("removeRowAt/moveRow 越界返回等值新数组（同内容、不同引用、原件不动）", () => {
    const src = rows();
    for (const bad of [-1, 3, 99]) {
      expect(removeRowAt(src, bad)).toEqual(src);
      expect(removeRowAt(src, bad)).not.toBe(src);
      expect(moveRow(src, bad, 0)).toEqual(src);
    }
    expect(src.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("moveRow 先删后插语义（graphOps.reorder 同法）", () => {
    // u3(from=2) 挪到 0：先删掉 u3，列表 [u1,u2]，再插到 0
    expect(moveRow(rows(), 2, 0).map((r) => r.id)).toEqual(["u3", "u1", "u2"]);
    // toIndex 超界钳到表尾
    expect(moveRow(rows(), 0, 99).map((r) => r.id)).toEqual(["u2", "u3", "u1"]);
  });

  it("nextRowId 按前缀取 max+1：删过不回填、跨前缀互不串门、按数值不比字典序", () => {
    expect(nextRowId("u", [])).toBe("u1");
    expect(nextRowId("u", ["u2", "u10"])).toBe("u11"); // 字符串序会给 u3
    expect(nextRowId("a", ["a2", "b7"])).toBe("a3");   // b 前缀不参与计数
    // 内核只认 <prefix>N，其它形态的 id（u_1/老数据）一律忽略
    expect(nextRowId("u", ["legacy-1", "u_1"])).toBe("u1");
  });

  it("duplicateRowAt 换新 id 插原位后；clone 钩子决定脱离深度", () => {
    const src: Row[] = [{ id: "u1", type: "a", cfg: { k: 1 } }];
    const [out, copy] = duplicateRowAt(src, 0, "u");
    expect(out.map((r) => r.id)).toEqual(["u1", "u2"]);
    expect(copy!.cfg).toBe(src[0].cfg); // 默认浅拷贝：UI 的字段全是标量，这就是原型行为
    const [deepOut] = duplicateRowAt(src, 0, "u", (s) => ({ ...s, cfg: { ...s.cfg } }));
    (deepOut[1].cfg as Record<string, unknown>).k = 2;
    expect((src[0].cfg as Record<string, unknown>).k).toBe(1); // 深一层后写不穿原件
  });

  it("updateRowAt 默认浅合并；merge 钩子可自定义（ADB 的 config 深一层在这挂）", () => {
    const src: Row[] = [{ id: "u1", type: "a", cfg: { k: 1 } }];
    const out = updateRowAt(src, 0, { type: "b" });
    expect(out[0]).toEqual({ id: "u1", type: "b", cfg: { k: 1 } });
    expect(src[0].type).toBe("a");
    const merged = updateRowAt(src, 0, { cfg: { j: 2 } },
      (prev, p) => ({ ...prev, cfg: { ...prev.cfg, ...p.cfg } }));
    expect(merged[0].cfg).toEqual({ k: 1, j: 2 });
    expect(updateRowAt(src, 9, { type: "z" })).toEqual(src); // 越界=no-op 新数组
  });
});
