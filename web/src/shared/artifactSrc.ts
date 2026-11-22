// 制品取字节：带 Authorization 的 fetch → Blob → objectURL（R107）。
//
// 为什么不能是裸 <a href>：制品下载端点只认 Bearer 头（T11 Step 0 端到端实测：
// 经 vite preview 代理不带 header → 401 {"code":"unauthorized"}，带 token → 200），
// 而 <a target="_blank"> 是不带头的导航——1B 报告页那个链接点开就是 401。
// 也不给制品加签名 URL：可见性跟着项目成员关系走，签名 query 等于把凭证写进
// 浏览器历史/可复制分享的位置（R107 裁定）。
//
// objectURL 由**调用方** revoke（谁创建谁释放；组件卸载忘了 revoke 就是内存泄漏，
// 但把它包进 hook 会让纯函数测不了——这里保持纯工具）。
//
// 不走 client.ts 的 api()：那条路对每个响应都 res.json()，而制品接口返的是裸字节。
// 但**认证语义必须与它一致**，所以 401 时同样调 client 的 refreshOnce 静默补一次
// （1C+ 起 access 会过期，不补就表现为「登录着，点截图却被踢回登录页」），
// 刷不动才 onUnauthorized。
import { ApiErr, getToken, onUnauthorized, refreshOnce } from "../api/client";

/**
 * 取一个制品的真字节，换成可塞进 <img src> / <a download> 的 objectURL。
 *
 * 失败抛 ApiErr（与全站同一信封）；401 先静默刷新重试一次，仍 401 才登出。
 * 调用方用完必须 `URL.revokeObjectURL(url)`，否则 Blob 常驻内存。
 */
export async function fetchArtifactBlob(
  runId: string,
  name: string,
  opts: { projectId: string; silent?: boolean } = { projectId: "" },
): Promise<string> {
  const path = "/api/v1/artifacts/" + encodeURIComponent(runId) + "/" + encodeURIComponent(name)
    + "?project_id=" + encodeURIComponent(opts.projectId);
  const go = () => {
    const headers: Record<string, string> = {};
    const tok = getToken();
    if (tok) headers["Authorization"] = "Bearer " + tok;
    return fetch(path, { headers });
  };
  let res = await go();
  if (res.status === 401 && getToken() && (await refreshOnce())) {
    // 只补这一次，与 client.ts 的 api() 同口径（再 401 就是不该看这个制品，不是过期）
    res = await go();
  }
  if (res.status === 401 && !opts.silent) {
    // 与 client.ts 同口径：token 过期要说得清、要登出，不能演成「图挂了」
    onUnauthorized();
    throw new ApiErr("unauthorized", "登录状态无效或已过期", 401);
  }
  if (!res.ok) {
    let code = "http_" + res.status;
    let msg = "制品取不到";
    try {
      const b = (await res.json()) as { code?: string; message?: string };
      if (b.code) code = b.code;
      if (b.message) msg = b.message;
    } catch { /* 裸错误体：保持默认文案 */ }
    throw new ApiErr(code, msg, res.status);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
