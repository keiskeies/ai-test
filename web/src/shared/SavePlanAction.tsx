// 「候选方案保存为正式场景」的唯一交互件（D264）：Pilot 候选卡与只读预览页共用。
// 组件不碰 fetch——调用方注入 onSave（cards/ 的「协议组件不直连 API」纪律不外借）；
// 没接宿主 / 没有 scenario:create 时**不渲染写钮**（写钮缺位，不画假门）。
import { useState } from "react";
import { Button, Input, Modal, Space, Tag, Tooltip, Typography, message } from "antd";

export interface SavePlanActionProps {
  planName: string;
  /** 缺省 = 宿主没接落库；此时整个组件不渲染。 */
  onSave?: (name: string) => Promise<{ id: string; name: string }>;
  /** 非空 = 不能落库的原因（如方案没带 graph）→ disabled + Tooltip 说清楚。 */
  disabledReason?: string | null;
  /** 保存成功后的「打开场景」地址；缺省走 hash 路由 #/scene/{id}。 */
  openHref?: (id: string) => string;
  /** 保存成功回执：给宿主同步页面文案（如预览页的「未落库」横幅要翻面）。 */
  onSaved?: (saved: { id: string; name: string }) => void;
  size?: "small" | "middle";
}

export default function SavePlanAction({
  planName, onSave, disabledReason, openHref, onSaved, size = "small",
}: SavePlanActionProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(planName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

  if (!onSave) return null;
  if (saved) {
    return (
      <Space size={8} wrap>
        <Tag color="green" data-testid="plan-saved">已保存</Tag>
        <Typography.Link data-testid="plan-saved-open" target="_blank"
          href={(openHref ?? ((id: string) => "#/scene/" + id))(saved.id)}>
          打开场景
        </Typography.Link>
      </Space>
    );
  }

  const btn = (
    <Button size={size} data-testid="plan-save" disabled={!!disabledReason}
      onClick={() => { setName(planName); setOpen(true); }}>
      保存为场景
    </Button>
  );

  return (
    <>
      {disabledReason ? (
        <Tooltip title={disabledReason}><span style={{ display: "inline-block" }}>{btn}</span></Tooltip>
      ) : btn}
      <Modal open={open} title="保存为场景" okText="保存" cancelText="取消"
        destroyOnHidden data-testid="plan-save-modal"
        okButtonProps={{ loading: saving, "data-testid": "plan-save-ok" }}
        onCancel={() => setOpen(false)} onOk={() => void submit()}>
        <Typography.Paragraph type="secondary" className="tp-text-sm">
          将按该方案的步骤图创建当前项目的正式场景；同名场景已存在时会提示改名。
        </Typography.Paragraph>
        <Input data-testid="plan-save-name" maxLength={200} value={name} autoFocus
          onChange={(e) => setName(e.target.value)} />
      </Modal>
    </>
  );

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) { message.warning("场景名不能为空"); return; }
    if (!onSave) return;
    setSaving(true);
    try {
      const out = await onSave(trimmed);
      setSaved(out);
      setOpen(false);
      message.success("已保存为场景「" + out.name + "」");
      onSaved?.(out);
    } catch {
      // client.ts 已把后端原话弹过一次（409 同名 / 422 图不合法 / 403 无权限）；
      // 弹窗留在原地，用户改名或换项目后可直接重试。
    } finally {
      setSaving(false);
    }
  }
}
