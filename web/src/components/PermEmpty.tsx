// D38 · §11.4.29 权限空页：撞 403 后要有落地页——锁形插画 + 所需权限位原名 + [复制申请文案]。
// 蓝图 design :1175 / 视觉规范 :1551（「权限空页 = 锁形插画 + 所需权限名文案」）。
// 纪律 1（假门禁令）在这里的形态：**位名只认后端原话**。三个来源按优先级——
// ① details.perm（后端补上后的正式通路，主线记账中）；② 现网 insufficient_permission 的
// message 原话「缺少权限：<位名>」（core/service.py require 的既有形状）；③ 都没有 →
// 只说「当前账号缺少访问该项的权限」，绝不前端猜一个位名——猜出来的位就是假门。
import { Button, Card, Empty, Typography, message } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";
import { ApiErr } from "../api/client";

/** 锁形插画：自绘 SVG（视觉规范点名「锁形插画」；emoji 不算插画，且跨平台渲染不可控）。 */
function LockArt() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="无权限" data-testid="perm-empty-lock">
      <circle cx="36" cy="36" r="34" fill="var(--tp-primary-50)" stroke="var(--tp-primary-100)" strokeWidth="2" />
      <path d="M27 34v-6a9 9 0 0 1 18 0v6" fill="none" stroke="var(--tp-primary-400)" strokeWidth="4" strokeLinecap="round" />
      <rect x="22" y="34" width="28" height="20" rx="4" fill="var(--tp-primary-500)" />
      <circle cx="36" cy="43" r="3" fill="#fff" />
      <rect x="34.5" y="44" width="3" height="6" rx="1.5" fill="#fff" />
    </svg>
  );
}

/** 只认后端原话的位名提取；拿不到就返回 null（调用方必须退化成不指名的文案）。 */
export function backendPermOf(err: unknown): string | null {
  if (!(err instanceof ApiErr) || err.status !== 403) return null;
  const d = err.details as { perm?: unknown; perms?: unknown } | null;
  if (typeof d?.perm === "string" && d.perm.trim() !== "") return d.perm.trim();
  if (Array.isArray(d?.perms) && typeof d.perms[0] === "string" && d.perms[0].trim() !== "") {
    return (d.perms[0] as string).trim();
  }
  // 现网 insufficient_permission 已带 details.perm（core/service.py require 与 iam require_perm，
  // 均塞 {"perm": 位名}）；message 原话「缺少权限：<位名>」保留为兜底通路（老响应/未覆盖路径）。
  const m = /^缺少权限：(\S+)$/.exec(err.message);
  return m ? m[1] : null;
}

/** 申请文案：人话一句，含权限位（后端给才有）与当前项目名；无位时不指名道姓。 */
export function permApplyText(perm: string | null, projectName: string, context?: string): string {
  const where = context ? context : "该页面/操作";
  return perm
    ? `【权限申请】我在项目「${projectName}」访问「${where}」被拒绝，需要权限位 ${perm}，请项目管理员帮忙开通。`
    : `【权限申请】我在项目「${projectName}」访问「${where}」被拒绝，当前账号缺少访问该项的权限，请项目管理员帮忙确认所需权限并开通。`;
}

export default function PermEmpty({ error, projectName, context, children }: {
  /** 撞到的 403（ApiErr）；只读它的后端原话，不读它的 code 猜位名 */
  error: ApiErr | null;
  projectName: string;
  /** 被拒的是什么（人话，如「查看该 UI 用例」），进申请文案 */
  context?: string;
  children?: ReactNode;
}) {
  const perm = backendPermOf(error);
  const text = permApplyText(perm, projectName, context);
  // 剪贴板失败才把申请文案摊在屏幕上。「手动选择文案」以前指着一段从没渲染过的文字
  // ——text 只进 clipboard，渲染树里压根没有它，失败时让用户去选一段不存在的东西。
  // 内网 HTTP 部署（CodeEditor.tsx 注释的前提）下 navigator.clipboard 就是 undefined，
  // 这条路不是边角：摊出来才是给得出的出路（选中 → 自行复制，或直接照抄发给管理员）。
  // 成功态不摊：既有契约是成功只弹 toast，页面上多一段常驻文案是另一件事。
  const [shown, setShown] = useState(false);
  const copy = () => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => message.success("申请文案已复制，发给项目管理员即可"),
        () => { setShown(true); message.warning("复制失败，申请文案已显示在下方，可选中后自行复制"); },
      );
    } else {
      setShown(true);
      message.warning("当前浏览器不支持剪贴板，申请文案已显示在下方，可选中后自行复制");
    }
  };
  return (
    <div data-testid="perm-empty">
      <Card style={{ marginTop: 8 }}>
        <Empty
          image={<LockArt />}
          // 全局把插画高度收在 56（styles.css 的 antd Empty 校准），但这里的线稿是 72 的
          // 圆章——被封顶会切掉下缘。自带 art 的场合按 art 的实际高度给。
          imageStyle={{ height: 72 }}
          description={
            <Typography.Text data-testid="perm-empty-desc">
              {perm ? <>当前账号缺少访问权限，需要权限位 <Typography.Text code>{perm}</Typography.Text></>
                : "当前账号缺少访问该项的权限"}
            </Typography.Text>
          }
        >
          <div>
            <Typography.Paragraph className="tp-text-sm" type="secondary">
              权限门禁在后端，这里只如实转述它的答复{perm ? "" : "（后端未说明具体权限位，请管理员确认）"}。
            </Typography.Paragraph>
            <Button type="primary" data-testid="perm-empty-copy" onClick={copy}>复制申请文案</Button>
            {shown && (
              // 失败态才出现的摊出块：正文是可选中的普通段落（不是 button 的 title
              // 之类选不中的地方），剪贴板不可用时它就是那条给得出的出路。
              <Typography.Paragraph
                data-testid="perm-empty-fallback"
                className="tp-text-sm"
                style={{ marginTop: 12, marginBottom: 0, padding: "8px 12px",
                  background: "var(--tp-bg-layout)", borderRadius: "var(--tp-radius-lg)", userSelect: "text" }}
              >
                {text}
              </Typography.Paragraph>
            )}
            {children}
          </div>
        </Empty>
      </Card>
    </div>
  );
}
