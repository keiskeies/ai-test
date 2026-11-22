// ownerLabel 的纯测试（列表「负责人」列的兜底口径）。
// 钉的是四种「显示谁」的情形各说各的话，尤其两条：
// ① 成员表里确实没这个人时，不许把 36 位 uuid 摊到界面上（1C 真走查量出来的缺陷）；
// ② 成员表还没到 / 拉挂了下不了结论时，不许把人判成「非项目成员」——那是冤枉人。
import { describe, expect, it } from "vitest";
import { MEMBERS_FAILED, MEMBERS_LOADING, membersReady, ownerLabel } from "./ownerName";

const READY = membersReady({ "u-1": "演示项目管理员", "u-2": "演示只读" });

describe("ownerLabel", () => {
  it("成员返回名字", () => {
    expect(ownerLabel("u-1", READY)).toBe("演示项目管理员");
    expect(ownerLabel("u-2", READY)).toBe("演示只读");
  });

  it("没填负责人是破折号，不是空串也不是 uuid", () => {
    for (const lk of [READY, MEMBERS_LOADING, MEMBERS_FAILED]) {
      expect(ownerLabel(null, lk)).toBe("—");
      expect(ownerLabel(undefined, lk)).toBe("—");
      expect(ownerLabel("", lk)).toBe("—");
    }
  });

  it("成员表到了但没有这个人：说「非项目成员」，只带短 id，绝不整串 uuid", () => {
    const adminId = "7346bec6-2810-4b8b-8d04-36508dff25e0";
    const label = ownerLabel(adminId, READY);
    expect(label).toContain("非项目成员");
    expect(label).toContain("7346bec6");
    // 反向钉：uuid 尾巴一个都不许漏（漏出来就是回退到「把主键摊在脸上」）
    expect(label).not.toContain("4b8b-8d04-36508dff25e0");
  });

  it("空成员表（确实一个成员都没有）算 ready，不是加载中", () => {
    expect(ownerLabel("u-1", membersReady({}))).toContain("非项目成员");
  });

  it("成员表在路上 / 拉挂了：都不许判「非项目成员」", () => {
    // 加载途中就把人判成非成员，是比 uuid 更糟的假话——真成员会一闪而过地被冤枉。
    expect(ownerLabel("u-1", MEMBERS_LOADING)).toBe("…");
    expect(ownerLabel("u-1", MEMBERS_LOADING)).not.toContain("非项目成员");
    const label = ownerLabel("u-1", MEMBERS_FAILED);
    expect(label).not.toContain("非项目成员");
    expect(label).toContain("名字未取到");
  });
});
