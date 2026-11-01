/**
 * TraeWork 的页面客户端：通用 CDP 传输（`GuiCdpClient`）+ 本文档选择器表上的语义操作。
 *
 * 传输层见 `src/agents/cdp/client.ts`（连接 / 命令 / 求值 / 坐标点击 / 按键 / 可见标签诊断）。
 * 本文件只放必须结合 `SELECTORS` 才能成立的部分：exists / text / click / focus / center，
 * 以及 TraeWork 专用的存活信号解读。
 */
import { GuiCdpClient, type CdpClientOptions, type LivenessProbe } from "../../cdp/client.js";
import { type SelectorKey, type SelectorOverrides, candidateArrayExpr, resolveSelectors } from "./selectors.js";

export * from "../../cdp/client.js";

export interface LivenessInterpretation {
  running: boolean;
  evidence: string;
}

/** 只有会可靠消失的停止按钮与 loading tail 才是权威运行信号。 */
export function interpretLiveness(probe: LivenessProbe): LivenessInterpretation {
  const evidence: string[] = [];
  if (probe.stopVisible) evidence.push("stop_button");
  if (probe.tailLoading) evidence.push("task_tail_loading");
  if (probe.thinkingStream) evidence.push("thinking_stream(diagnostic)");
  return { running: probe.stopVisible || probe.tailLoading, evidence: evidence.join(",") || "none" };
}

/** 连接 TraeWork 页面的 CDP 客户端（传输 + 选择器语义操作） */
export class TraeworkCdpClient extends GuiCdpClient {
  constructor(opts: CdpClientOptions) {
    super(opts);
  }

  /* ---------------- DOM 查询（带选择器回退） ---------------- */

  /** 某语义键是否存在可见元素 */
  async exists(key: SelectorKey, overrides?: SelectorOverrides): Promise<boolean> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true}}return false})()`;
    return (await this.evaluate<boolean>(expr)) === true;
  }

  /** 读取某语义键第一个可见元素的文本 */
  async text(key: SelectorKey, overrides?: SelectorOverrides): Promise<string> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return (e.textContent||'').trim()}}return ''})()`;
    return this.evaluateString(expr);
  }

  /** 单次页面求值探测所有活跃信号（候选选择器由本文档的 SELECTORS 表解析）。 */
  async probeLiveness(overrides?: SelectorOverrides): Promise<LivenessProbe> {
    return this.probeSignals({
      stopButton: resolveSelectors("stopButton", overrides),
      tailLoading: resolveSelectors("taskTailLoading", overrides),
      thinkingStream: resolveSelectors("thinkingStream", overrides),
    });
  }

  /** 读取某语义键第一个可见元素的中心坐标（坐标点击用） */
  async center(key: SelectorKey, overrides?: SelectorOverrides): Promise<{ x: number; y: number } | null> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(!e)continue;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}return ''})()`;
    const raw = await this.evaluateString(expr);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { x: number; y: number };
    } catch {
      return null;
    }
  }

  /**
   * 点击某语义键对应的元素。
   *
   * 返回值的真实语义（issue #38）：返回 `true` 只表示「**元素存在、可见，且已派发点击**」，
   * **不代表点击的副作用已生效**——对 DirectUI 按钮（如下拉底部的「选择文件夹」），
   * `element.click()` 会「返回成功却不唤起原生弹窗」（间歇，见 #35 实测）。
   *
   * 因此**需要确认副作用的调用方必须自行复检**（如 `ui/session.ts` 的 `clickDropdownFooter`
   * 以「原生对话框是否出现」为判据并升级执行方式），不得把本返回值直接当作成功。
   *
   * **执行顺序：坐标点击优先，DOM click 兜底**。原因（真机实测）：语义键常命中**图标类元素**
   * （如 `stopButton` = `.chat-input-v2-send-button-stop-icon`），这类元素没有 `click()` 方法，
   * 先走 `e.click()` 会抛 `TypeError: e.click is not a function` 并直接冒泡，
   * 调用方（如取消路径的 stopGuiTurn）拿到的只有异常、点不到按钮。
   * 坐标点击派发真实鼠标事件，对图标/无 click 方法的元素同样有效；
   * 两者都失败才返回 false。
   */
  async click(key: SelectorKey, overrides?: SelectorOverrides): Promise<boolean> {
    // 1) 坐标点击：对图标类元素（无 click 方法）同样有效
    const pos = await this.center(key, overrides).catch(() => null);
    if (pos) {
      try {
        await this.clickAt(pos.x, pos.y);
        return true;
      } catch {
        // 坐标点击失败（如元素在点击瞬间消失）→ 落到 DOM click 兜底
      }
    }
    // 2) DOM click 兜底：需吞掉元素不支持 click() 时抛出的 TypeError，
    //    否则异常会冒泡给调用方，使其误判为「CDP 不可用」。
    try {
      const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0){if(typeof e.click==='function'){e.click();return true}return false}}}return false})()`;
      if ((await this.evaluate<boolean>(expr)) === true) return true;
    } catch {
      // 兜底路径失败不抛错——语义同「未命中」
    }
    return false;
  }

  /** 聚焦某语义键元素 */
  async focus(key: SelectorKey, overrides?: SelectorOverrides): Promise<boolean> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){e.focus();return true}}return false})()`;
    return (await this.evaluate<boolean>(expr)) === true;
  }
}
