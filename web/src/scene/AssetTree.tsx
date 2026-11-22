// 左资产树（§11.4.9）：API 用例 + UI 用例 + ADB 用例（搜索 + 拖入/点击加入）+ 逻辑控件清单。
// 拖拽载荷走 dataTransfer（Canvas 的 readDrop 消费）；点击 = 追加到选中节点之后（无选中则顶层）。
// R111（1C）：UI 用例解禁 = 可拖入（拖进去插一个 kind:"ui_case"、ref=case_id 的节点）；
// 1D：ADB 用例同法解禁（kind:"adb_case"、ref=case_id），三类用例共用同一套拖拽协议。
import { useMemo, useState } from "react";
import { Button, Input, Tag, Tooltip, Typography } from "antd";
import { SearchOutlined } from "../ui/icons";
import { DND_KIND, DND_NAME, DND_REF } from "./Canvas";
import { labelOf, type Kind } from "./stepTypes";
import { useSceneStore, type AssetsFailureSlot } from "./store";

const LOGIC_KINDS: Kind[] = ["loop", "if", "foreach", "sleep", "script", "extract", "assert", "set_var", "group", "break", "continue", "http_direct"];

export default function AssetTree() {
  const cases = useSceneStore((s) => s.cases);
  const uiCases = useSceneStore((s) => s.uiCases);
  const adbCases = useSceneStore((s) => s.adbCases);
  const failed = useSceneStore((s) => s.assetsFailed);
  // 游标语：true = 这份清单只取到了第一页（store.load 单次 size=200，next_cursor 非空）。
  // 没这个信号，「项目里有 N 条」在 >200 条的项目里就是拿第一页冒充普查（「共 N」同族病灶）。
  const hasMore = useSceneStore((s) => s.assetsHasMore);
  // D152：游标非空才给「加载更多」入口（取全了钮消失）；在途 disabled 防双击追加重复页。
  const loadingMore = useSceneStore((s) => s.assetsLoadingMore);
  const loadMoreAssets = useSceneStore((s) => s.loadMoreAssets);
  const selectedKey = useSceneStore((s) => s.selectedKey);
  const addStep = useSceneStore((s) => s.addStep);
  // D146：只读时清单照列（读资产是正当需求），但「加入画布」的两条路（点击/拖拽）都关。
  const readOnly = useSceneStore((s) => s.readOnly);
  const [q, setQ] = useState("");

  // 一句空文案底下有三种真事：没取到 / 没权限 / 有但这个词没命中。
  // 合成一句「项目里还没有可用的××」，就把后端故障、缺权限、搜索没命中全说成项目没货——
  // 最后那种最坏：用例明明在列表里，只是这个词搜不到，却让人以为得去新建一条。
  // 名词一律用「」包住：拼接时不再纠结中英文之间那个空格该不该补。
  const emptyNote = (slot: AssetsFailureSlot, total: number, noun: string, more: boolean) => {
    const n = "「" + noun + "」";
    if (failed[slot] === "denied") return "没有读取" + n + "清单的权限，这里列不出来";
    if (failed[slot] === "error") return n + "清单没取到，不是项目里没有——重新进入编辑器可再拉一次";
    if (total === 0) return "项目里还没有" + n;
    // 游标非空时 N 只是已取到的第一页——「项目里有 N 条」不许说，改口不承诺普查，
    // 但出路（换个词）原样留着。
    if (more) return n + "已取到的 " + total + " 条里没有名字含「" + q.trim() + "」的，后面还有没取进来的，换个词试试";
    return n + "里没有名字含「" + q.trim() + "」的（项目里有 " + total + " 条，换个词）";
  };

  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return cases.filter((c) => !kw || c.name.toLowerCase().includes(kw));
  }, [cases, q]);

  const visibleUi = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return uiCases.filter((c) => !kw || c.name.toLowerCase().includes(kw));
  }, [uiCases, q]);

  const visibleAdb = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return adbCases.filter((c) => !kw || c.name.toLowerCase().includes(kw));
  }, [adbCases, q]);

  // D152：读资产是正当需求（D146 口径）——只读时「加载更多」照常可用，关的只是写把手。
  const moreBtn = (slot: "cases" | "uiCases" | "adbCases", testid: string) =>
    hasMore[slot] ? (
      <Button size="small" type="link" data-testid={testid} disabled={loadingMore[slot]}
        onClick={() => void loadMoreAssets(slot)}>加载更多</Button>
    ) : null;

  return (
    <div data-testid="scene-asset-tree" style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", overflow: "auto", padding: 8 }}>
      <Input data-testid="asset-search" allowClear prefix={<SearchOutlined />}
        placeholder="搜索用例（API / UI / ADB）" value={q} onChange={(e) => setQ(e.target.value)} />
      <div>
        <Typography.Text className="tp-text-sm" strong>API 用例</Typography.Text>
        {visible.length === 0 && (
          <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ margin: "4px 0" }}>
            {emptyNote("cases", cases.length, "接口用例", hasMore.cases)}
          </Typography.Paragraph>
        )}
        {visible.map((c) => (
          <div key={c.id} className="tp-text-md"
            data-testid="asset-case"
            draggable={!readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_KIND, "api_case");
              e.dataTransfer.setData(DND_REF, c.id);
              e.dataTransfer.setData(DND_NAME, c.name);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => { if (!readOnly) addStep("api_case", selectedKey, { ref: c.id, name: c.name }); }}
            style={{
              padding: "4px 8px", borderRadius: 6, cursor: readOnly ? "default" : "grab",
              border: "1px solid transparent",
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#F2F6F4"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
          >
            {c.name} <Tag className="tp-text-xs">{c.priority}</Tag>
          </div>
        ))}
        {moreBtn("cases", "asset-more-cases")}
      </div>
      {/* D146：逻辑控件是纯写把手（点了就往画布插节点），只读整组隐藏（§11.5.1 隐藏派） */}
      {!readOnly && (
      <div>
        <Typography.Text className="tp-text-sm" strong>逻辑控件</Typography.Text>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
          {LOGIC_KINDS.map((k) => (
            <Tooltip key={k} title="点击加到选中节点之后；或拖到画布节点上">
              <Button size="small" data-testid={"logic-add-" + k}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_KIND, k);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addStep(k, selectedKey)}>
                + {labelOf(k)}
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>
      )}
      <div>
        <Typography.Text className="tp-text-sm" strong>UI 用例</Typography.Text>
        {/* R111（1C 解禁）：与 API 用例同一交互——可拖入 / 点击加入，拖进去 =
            插一个 kind:"ui_case"、ref=case_id 的节点。断言长在用例命令里，不在这拖一步就完事。 */}
        {visibleUi.length === 0 && (
          <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ margin: "4px 0" }}>
            {emptyNote("uiCases", uiCases.length, "UI 用例", hasMore.uiCases)}
          </Typography.Paragraph>
        )}
        {visibleUi.map((c) => (
          <div key={c.id} className="tp-text-md"
            data-testid="asset-ui-case"
            draggable={!readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_KIND, "ui_case");
              e.dataTransfer.setData(DND_REF, c.id);
              e.dataTransfer.setData(DND_NAME, c.name);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => { if (!readOnly) addStep("ui_case", selectedKey, { ref: c.id, name: c.name }); }}
            style={{
              padding: "4px 8px", borderRadius: 6, cursor: readOnly ? "default" : "grab",
              border: "1px solid transparent",
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#F2F6F4"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
          >
            {c.name} <Tag className="tp-text-xs">{c.priority}</Tag>
          </div>
        ))}
        {moreBtn("uiCases", "asset-more-ui")}
      </div>
      <div>
        <Typography.Text className="tp-text-sm" strong>ADB 用例</Typography.Text>
        {/* 1D 解禁：与 API/UI 用例同一交互——可拖入 / 点击加入，拖进去 =
            插一个 kind:"adb_case"、ref=case_id 的节点。断言长在用例命令里。 */}
        {visibleAdb.length === 0 && (
          <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ margin: "4px 0" }}>
            {emptyNote("adbCases", adbCases.length, "ADB 用例", hasMore.adbCases)}
          </Typography.Paragraph>
        )}
        {visibleAdb.map((c) => (
          <div key={c.id} className="tp-text-md"
            data-testid="asset-adb-case"
            draggable={!readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_KIND, "adb_case");
              e.dataTransfer.setData(DND_REF, c.id);
              e.dataTransfer.setData(DND_NAME, c.name);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => { if (!readOnly) addStep("adb_case", selectedKey, { ref: c.id, name: c.name }); }}
            style={{
              padding: "4px 8px", borderRadius: 6, cursor: readOnly ? "default" : "grab",
              border: "1px solid transparent",
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#F2F6F4"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
          >
            {c.name} <Tag className="tp-text-xs">{c.priority}</Tag>
          </div>
        ))}
        {moreBtn("adbCases", "asset-more-adb")}
      </div>
    </div>
  );
}
