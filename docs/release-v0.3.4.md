# tianshu-mcp v0.3.4 发布说明

修复 [#8](https://github.com/lanlan0811/tianshu-mcp/issues/8)、[#9](https://github.com/lanlan0811/tianshu-mcp/issues/9)、[#10](https://github.com/lanlan0811/tianshu-mcp/issues/10) 中 ZCode 项目绑定、模型回读、原生面板超时与环境恢复后会话丢失的问题。

## 修复内容

- 项目触发器按覆盖、主选择器、精确备用逐级查找，当前层歧义时停止；以完整路径确认绑定。
- 模型回读解码稳定属性，兼容拆分的供应商/模型标签，排除隐藏、透明或裁剪的旧值。
- 初始化使用共同截止时间，默认 120 秒；探测与操作分别最多 30/60 秒，安全阶段额外重试最多 2 次。Windows 只查询目标进程的原生对话框；超时后复检副作用，不盲目重复提交。
- 新增可继续的 `needs_user/setup_recovery`。无会话的环境恢复发送完整原任务、上下文和已验证引用，环境确认文字不发给模型，也不消耗返修轮数。
- 发送前收起残留菜单并等待唯一、启用、未遮挡的按钮；发送后在同一个有界窗口内确认消息和会话，优先任务标记、其次唯一会话差集，不猜选最近会话、不自动重发。

配置与恢复方法见 [ZCode 使用说明](zcode-cdp.md) 和 [配置说明](agent-profiles.md)。实施范围与验收门禁见 [修复计划](plans/issue-8-9-10-zcode-fix-plan.md)。

Windows 实际任务、会话和 2/2 验收报告见 [真机验收记录](zcode-issue-8-10-validation.md)。

## 分发与兼容性

本次发布 GitHub Release 与 tarball，**不发布 npm**。仅运行 `npx tianshu-mcp` 不会自动取得本补丁；需下载本 Release 附件并安装。GitHub 为主仓库，Gitee 为代码与标签镜像；镜像发行版是否创建以工作流日志为准。

macOS 有自动化和 CI 覆盖，尚未完成本次真机端到端验证；ZCode profile 继续保持 `research`。
