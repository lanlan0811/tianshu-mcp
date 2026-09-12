# tianshu-mcp v0.3.3 发布说明

v0.3.3 修复 issue #4 / #7：ZCode 3.11.2 模型菜单的 provider 分组漂移为 family，项目绑定入口与回读判据也已变化；同时修复验收引擎对零测试用例和零文件变更的假绿。

## ZCode 3.11.2 模型选择

- 供应商分组同时兼容 `chat-model-select-group-provider:` 与 `chat-model-select-group-family:`。
- 打开菜单后优先直接精确点击平铺模型；直选失败才尝试展开 provider/family 分组并重试，兼容新旧布局。
- `model_unavailable` 与权限选择失败会回传可见文本及 `data-testid` 候选，便于通过 CDP 定位后续选择器漂移。

## 项目导入与绑定

- 添加新项目前先收起残留工作区菜单，再以最多三轮闭环打开“打开文件夹”，消除首次 outside-click 被吞。
- 绑定项目优先点击 composer 下拉的 `menuitemcheckbox`，按目录显示名精确唯一匹配；旧版侧栏项仅作回退。
- 绑定回读纳入 composer 触发器文本，过滤中英文“选择项目”占位词；失败时最多两轮幂等重试。

## 发现路径与验收引擎

- ZCode/TraeWork 的 Program Files 占位符统一为全大写；占位符展开大小写不敏感，未知值保留原样。
- 测试检查输出明确报告零用例时，即使进程退出码为 0 也会判失败。
- Git 项目默认要求产生相对动工前基线的变更；纯分析任务可在 `.tianshu-mcp/acceptance.json` 设置 `"requireChanges": false`。

## 兼容性与验证

- ZCode 旧 provider 分组布局和旧项目侧栏入口仍作为回退；完整路径判据仍保留。
- Windows/macOS 代码路径均无用户目录硬编码。
- 自动化回归覆盖新旧模型菜单、项目导入/绑定重试与双重 fail-closed 门禁。
