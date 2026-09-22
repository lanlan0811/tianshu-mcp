# tianshu-mcp v0.5.6 发布说明

[English](release-v0.5.6.en.md)

第五次 GUI 调教新增 Qoder CN（`agentId=qoder`），接入现有开发、运行检测、客观验收和返修流程，MCP 工具数量保持 11 个。

- 按可配置安装规则优先发现 D 盘候选，校验 Qoder CN 身份；保留已有实例，无法连接时提供恢复指引。
- 工作区按完整路径绑定，缺少登记时通过新建工作区和原生目录选择器导入。
- `modelSource` 区分默认/自定义模型；名称精确匹配，未指定的设置沿用当前值。思考等级通过模型管理保存并重新读取，不支持的档位明确报错。全局偏好会保留，权限模式沿用。
- 完成判定关联本轮用户消息、回复和运行信号。发送状态不明时保留检查点；审批由用户处理，恢复仅观察原会话；多题答案先完整校验再提交。
- 自动和手动返修均先写修复计划，再将文件名、完整路径和全文发送原会话，随后再次验收。
- 修复模型菜单异步关闭导致的重开竞争；输入正文按真实换行操作填写并严格回读。
- 恢复测试文件隔离，消除安装探测 mock 对 Git 基线测试的污染；CI 和 Release 新增 Qoder 分发文件门禁。

Windows 10 / Qoder CN 0.3.4 的公共 MCP 真机验证已通过：已有工作区默认模型开发、新工作区自定义模型开发、受控回归验收失败、修复计划、审批恢复、原会话返修与再次验收。详见[脱敏状态和验收报告](https://github.com/lanlan0811/tianshu-mcp/blob/v0.5.6/docs/qoder-evidence/windows-smoke.json)及[操作说明](qoder-cdp.md)。截图仅截取模型管理窗口，不含账号与项目路径。

macOS 保持 `research`，有路径与平台分支自动化覆盖，但没有真机 GUI 验证，因此禁止派发。Windows 样例模型名称只是验证配置，不是产品硬编码。

发布已完成：发布提交 `9ee03da` 的双仓 `master` 与 `v0.5.6` tag 一致，CI 22 个作业全绿（[run 35741308742](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35741308742)）；Release 工作流全绿（[run 35742181558](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35742181558)），GitHub 发行附 `tianshu-mcp-0.5.6.tgz`，Gitee 镜像发行版 `v0.5.6` 已建；npm `tianshu-mcp@0.5.6` 已发布为 `latest`（`dist.shasum` = `67d6babc…`），并从 registry 实装消费者复验严格 stdio 检查 6/6 通过。
