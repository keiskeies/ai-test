// 全局快捷查找（§11.4.19/R51；1C T12/R109 扩五路；1D 扩 adb_case；1E T9 扩 schedule/
// notify_channel，R109 四处同改）：GET /search-assets 搜（定义/用例/场景/元素/UI 用例/
// ADB 用例/定时任务/通知渠道）。
// 出参类型直接引生成物（SearchAssetsOut 是标注了 BaseModel 的响应，生成物提得出）——
// 后端字段一变，gen:api 后这里先编译报错，不静默漂移。
import { get } from "./client";
import type { components } from "./schema";
import type { Kind } from "../ui/paletteNav";

export type SearchAssetItem = components["schemas"]["SearchAssetItem"];
export type SearchAssetsOut = components["schemas"]["SearchAssetsOut"];

const enc = encodeURIComponent;

export const searchApi = {
  /** kind 缺省 = 全路搜；传入则收窄到一类（画布资产树等场景用）。
   * Kind 引自 ui/paletteNav——其中 nav_device 是本地导航项、**不是**搜索 kind，
   * 绝不许当 kind 传进来（后端 pattern 会 422）；其余成员（含 adb_case/schedule/
   * notify_channel）都在后端 kind pattern 里，收窄可用。 */
  assets: (projectId: string, q: string, kind?: Exclude<Kind, "nav_device">) =>
    get<SearchAssetsOut>("/search-assets?project_id=" + enc(projectId)
      + "&q=" + enc(q) + (kind ? "&kind=" + kind : ""), { silent: true }),
};
