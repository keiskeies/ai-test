// CSV 粘贴解析：纯逻辑，不起服务也要钉住（ ragged 行的处理决定后端会不会 422）。
import { expect, test } from "@playwright/test";
import { parseTabular, toTabular } from "../src/api/csv";

test("首行=列头，逗号/制表符自动判别", () => {
  const t = parseTabular("order_id,status\n1,PAID\n2,NEW");
  expect(t.columns).toEqual(["order_id", "status"]);
  expect(t.rows).toEqual([["1", "PAID"], ["2", "NEW"]]);
  expect(t.delimiter).toBe(",");
  expect(t.padded).toEqual([]);
  expect(t.overflow).toEqual([]);

  const h = parseTabular("a\tb\n1\t2");
  expect(h.delimiter).toBe("\t");
  expect(h.rows).toEqual([["1", "2"]]);
});

test("行宽不齐要归一并如实报告，不能把 ragged 行交给后端", () => {
  const t = parseTabular("a,b,c\n1,2,3\n1,2\n1,2,3,4");
  expect(t.rows.every((r) => r.length === 3)).toBeTruthy();
  expect(t.rows[1]).toEqual(["1", "2", ""]);
  expect(t.rows[2]).toEqual(["1", "2", "3"]);
  expect(t.padded).toEqual([2]);
  expect(t.overflow).toEqual([3]);
});

test("空行丢弃但不谎报：单列粘贴不会被当成空表", () => {
  const t = parseTabular("sku\n\nA-1\n\nA-2\n");
  expect(t.columns).toEqual(["sku"]);
  expect(t.rows).toEqual([["A-1"], ["A-2"]]);
  expect(t.droppedBlank).toBe(3);
  expect(parseTabular("").columns).toEqual([]);
});

test("列头空位补名 + 重复列名提示（同名变量后者覆盖前者）", () => {
  const t = parseTabular("a,,c\n1,2,3");
  expect(t.columns).toEqual(["a", "列2", "c"]);
  const d = parseTabular("a,a,b\n1,2,3");
  expect(d.duplicates).toEqual(["a"]);
});

test("往返：编辑框回填再解析结果不变", () => {
  const t = toTabular(["a", "b"], [["1", "2"], ["3", ""]]);
  expect(t).toBe("a\tb\n1\t2\n3\t");
  const back = parseTabular(t);
  expect(back.columns).toEqual(["a", "b"]);
  expect(back.rows).toEqual([["1", "2"], ["3", ""]]);
});
