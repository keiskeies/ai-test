// 乐观锁冲突的差异弹窗（Review Focus 5）：我的 vs 服务器，左右并排 + 三选。
// 不是「刷新重试」一句话打发——两栏都放真实 JSON 全文，用户看得见差在哪。
// 「用我的」= 带服务器新版本号强推（我知情覆盖）；「用服务器」= 丢弃我方未保存改动；
// 「复制我的到剪贴板」= 谁也不动，自己留着手工合并。默认不覆盖他人（红色是「用我的」，
// 不是默认动作）；点 X 只关窗，等于暂时不裁决（dirty 还在，再保存会再弹）。
// 「用我的」被再拒时弹窗必须自己交代「没覆盖成 + 为什么」：client.ts 的全局 toast 确实会响
// （sceneApi.update 不静默），但它一闪就没、说的是服务器原话——红钮原地不动等于说「还没按」，
// 逼用户再按一次破坏性动作。这不是静默问题，是弹窗在失败后继续假装动作未发生。
import { Alert, Button, Modal, Space, Typography } from "antd";
import { useSceneStore } from "./store";
import type { OverrideFailure } from "./store";

// 三因三句（口径同 store 的 ListFailure/why()）：权限句只有真 403 才许出现，
// 未知因只说「请求没成功」——把未知说成没权限是把故障推给用户身份。
const FAILED_COPY: Record<Exclude<OverrideFailure, null>, string> = {
  validation: "「用我的」没有生效：服务器校验拒了这份图（422）。修好再点，或「用服务器」回退。",
  denied: "「用我的」没有生效：这个账号没有写入这个场景的权限（403）。",
  error: "「用我的」没有生效：覆盖请求本身没成功，对方版本原样未动。",
};

export default function ConflictModal() {
  const conflict = useSceneStore((s) => s.conflict);
  const overrideFailed = useSceneStore((s) => s.overrideFailed);
  const takeServer = useSceneStore((s) => s.takeServer);
  const copyMine = useSceneStore((s) => s.copyMine);
  const clearConflict = useSceneStore((s) => s.clearConflict);
  const forceSave = useSceneStore((s) => s.forceSaveWithVersion);
  const saving = useSceneStore((s) => s.saving);

  if (!conflict) return null;
  return (
    <Modal
      open data-testid="scene-conflict-modal" width={960}
      title="保存冲突：场景在你编辑期间被别人改过"
      onCancel={() => clearConflict()}
      closable
      footer={
        <Space>
          <Button data-testid="conflict-copy" onClick={() => { void copyMine(); }}>
            复制我的到剪贴板
          </Button>
          <Button data-testid="conflict-use-server" onClick={() => takeServer()}>
            用服务器（丢弃我的改动）
          </Button>
          <Button danger type="primary" data-testid="conflict-use-mine" loading={saving}
            onClick={() => { void forceSave(conflict.serverVersion); }}>
            用我的（覆盖对方）
          </Button>
        </Space>
      }
    >
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message={"服务器版本 v" + conflict.serverVersion + "（你的编辑基于更早的版本）。默认不覆盖他人。"} />
      {overrideFailed && (
        <Alert type="error" showIcon data-testid="conflict-override-failed"
          style={{ marginBottom: 12 }} message={FAILED_COPY[overrideFailed]} />
      )}
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong>我的（未保存）</Typography.Text>
          <pre data-testid="conflict-mine" style={{
            maxHeight: 360, overflow: "auto", background: "#FBEBEA", padding: 8,
            fontSize: 12, borderRadius: 6, whiteSpace: "pre-wrap",
          }}>{conflict.mine}</pre>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong>服务器（当前）</Typography.Text>
          <pre data-testid="conflict-server" style={{
            maxHeight: 360, overflow: "auto", background: "#EDF3FE", padding: 8,
            fontSize: 12, borderRadius: 6, whiteSpace: "pre-wrap",
          }}>{conflict.server}</pre>
        </div>
      </div>
    </Modal>
  );
}
